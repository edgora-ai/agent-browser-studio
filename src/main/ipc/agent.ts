import { ipcMain, clipboard, dialog, BrowserWindow, type WebContents } from "electron";
import { runDesktopChat, type DesktopChatRequest } from "../services/agent/desktop-chat.js";
import { desktopChatRuns, type ChatCancelRequest } from "../services/agent/chat-runs.js";
import {
  getAccounts, getRedactedAccounts, addAccount, updateAccount, deleteAccount, getProfileAccounts,
  getAccountPassword, setAccountProfileIds, parseAccountsBulkText, bulkAddAccounts,
  bulkCreateProfilesWithAccounts,
  llmChat,
  createConversation, getConversation, listConversations,
  deleteConversation, renameConversation,
  getOrDetectLlmConfig,
  getLlmConfig, redactLlmConfig, saveLlmConfig,
  repairMessageSequence,
} from "../services/local-agent.js";
import { agentRunRecorder } from "../services/agent-run-trace.js";
import { runResultStore } from "../services/run-result-store.js";
import { planExport, writeExport, type ExportPlanArgs } from "../services/agent-run-export.js";
import { assertSafeRunExportPath } from "../services/local-export-path-guard.js";
import { agentDbTables, agentDbTableData, agentDbQuery, agentDbExecScript } from "../services/agent-db.js";
import { listPendingApprovals, resolveApproval } from "../services/approval-gate.js";
import type { LlmConfig, LlmMessage } from "../services/local-agent.js";
import type { PlatformAccount } from "../services/local-agent.js";
import {
  addOrUpdateSkill,
  exportSharedSkillRepository,
  importSharedSkillRepository,
  installSkill,
  listMarketplaceSkills,
  listSkillRepository,
  removeSkill,
  setSkillMeta,
} from "../services/skill-repository.js";
import { recordAudit } from "../services/audit-log.js";
import { TASK_TEMPLATES } from "../services/task-templates.js";
import { requireAccountMutation, requireAccountSecret, requireSettingsMutation, type RoleCheck } from "../services/team.js";
import { listPlatformAdapters, getPlatformAdapter, detectAdapter } from "../services/platform-adapters.js";

function gateAccount(r: RoleCheck): void {
  if (!r.ok) throw new Error(r.error);
}

function requireChatOwner(sender: WebContents): void {
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || window.isDestroyed() || sender.isDestroyed()) throw new Error("Untrusted desktop chat sender.");
}

export { repairMessageSequence };

export function registerAgentHandlers(): void {

  // ════════════════════════════════════════════════════════
  // LLM Config
  // ════════════════════════════════════════════════════════

  ipcMain.handle("agent:llm-config", async () => {
    return redactLlmConfig(getLlmConfig());
  });

  ipcMain.handle("agent:detect-llm-config", async () => {
    return redactLlmConfig(getOrDetectLlmConfig());
  });

  ipcMain.handle("agent:save-llm-config", async (_event, config: LlmConfig) => {
    try {
      saveLlmConfig(config);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("agent:skills", async () => {
    return listSkillRepository();
  });

  ipcMain.handle("agent:task-templates", async () => {
    return TASK_TEMPLATES.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      description: t.description,
      riskLevel: t.riskLevel,
      requiredInputs: t.requiredInputs,
      tools: t.tools,
      successCriteria: t.successCriteria,
      examplePrompt: t.examplePrompt,
      prompt: t.prompt,
      steps: t.steps,
      outputTable: t.outputTable,
      machine: t.machine,
    }));
  });

  ipcMain.handle("agent:skills:list", async (_event, filter?: string) => {
    return listSkillRepository(filter);
  });

  ipcMain.handle("agent:skills:marketplace", async (_event, filter?: string) => {
    return listMarketplaceSkills(filter);
  });

  ipcMain.handle("agent:skills:add", async (_event, skill: any) => {
    try {
      return { success: true, skill: addOrUpdateSkill(skill) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("agent:skills:install", async (_event, id: string) => {
    try {
      return { success: true, skill: installSkill(id) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("agent:skills:remove", async (_event, id: string) => {
    try {
      return { success: removeSkill(id) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("agent:skills:set-meta", async (_event, params: { id: string; shared?: boolean; enabled?: boolean; tags?: string[] }) => {
    try {
      return { success: true, skill: setSkillMeta(params.id, { shared: params.shared, enabled: params.enabled, tags: params.tags }) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("agent:skills:export-shared", async () => {
    return exportSharedSkillRepository();
  });

  ipcMain.handle("agent:skills:import-shared", async (_event, entries: any[]) => {
    try {
      return { success: true, result: importSharedSkillRepository(entries) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // ════════════════════════════════════════════════════════
  // Platform Adapters (AI Skills Hub catalog)
  // ════════════════════════════════════════════════════════

  ipcMain.handle("platform:adapters:list", async (_event, filter?: string) => {
    return listPlatformAdapters(filter);
  });

  ipcMain.handle("platform:adapter:get", async (_event, id: string) => {
    return getPlatformAdapter(id) || null;
  });

  ipcMain.handle("platform:adapter:detect", async (_event, url: string) => {
    return getPlatformAdapter(detectAdapter(url).id) || null;
  });

  // ════════════════════════════════════════════════════════
  // Conversations
  // ════════════════════════════════════════════════════════

  ipcMain.handle("agent:conversations:list", async () => {
    return listConversations().map(c => ({
      id: c.id,
      title: c.title,
      messageCount: c.messages.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  });

  ipcMain.handle("agent:conversations:get", async (_event, id: string) => {
    const conversation = getConversation(id);
    if (!conversation) return null;
    // Message association survives trace cleanup, but a duplicated message
    // field must not contradict the authoritative run after crash recovery or
    // a partial two-file save. Unknown/cleared runs have no claimed end reason.
    return { ...conversation, messages: conversation.messages.map((message) => {
      if (!message.runId) return message;
      const run = agentRunRecorder.getRun(message.runId);
      const { endReason: _storedReason, ...rest } = message;
      // M2: the authoritative run carries the real verification. Chat runs are
      // never template-graded, so this stays unverified for them — but the
      // value must come from the run, not be hardcoded, or a graded run shown
      // in a conversation would contradict the Runs page.
      return { ...rest, endReason: run?.endReason, verification: run?.verification ?? { status: "unverified" as const } };
    }) };
  });

  ipcMain.handle("agent:conversations:create", async (_event, title?: string) => {
    const c = createConversation(title);
    return { id: c.id, title: c.title, messageCount: 0, createdAt: c.createdAt, updatedAt: c.updatedAt };
  });

  ipcMain.handle("agent:conversations:delete", async (_event, id: string) => {
    if (desktopChatRuns.hasActive(id)) throw new Error("Stop this conversation's active task before deleting it.");
    return deleteConversation(id);
  });

  ipcMain.handle("agent:conversations:rename", async (_event, params: { id: string; title: string }) => {
    return renameConversation(params.id, params.title);
  });

  // ════════════════════════════════════════════════════════
  // Chat — tool-calling agent loop
  // ════════════════════════════════════════════════════════

  ipcMain.handle("agent:chat", async (event, params: DesktopChatRequest) => {
    requireChatOwner(event.sender);
    return runDesktopChat(event.sender, params, false);
  });

  ipcMain.handle("agent:chat-cancel", async (event, params: ChatCancelRequest) => {
    requireChatOwner(event.sender);
    if (!params || typeof params.conversationId !== "string"
      || (params.runId !== undefined && typeof params.runId !== "string")
      || (params.streamId !== undefined && typeof params.streamId !== "string")) {
      return { accepted: false, state: "not_found", error: "Invalid task identity." };
    }
    return desktopChatRuns.cancel(event.sender, params);
  });

  ipcMain.handle("agent:chat-active", async (event, conversationId: string) => {
    requireChatOwner(event.sender);
    return typeof conversationId === "string" ? desktopChatRuns.snapshot(event.sender, conversationId) : null;
  });

  // Simple chat (no tools) for quick conversations
  ipcMain.handle("agent:chat-simple", async (_event, params: {
    messages: Array<{ role: string; content: string }>;
  }) => {
    const config = getLlmConfig() || getOrDetectLlmConfig();
    if (!config) {
      return { error: "No LLM config." };
    }
    try {
      const llmMsgs: LlmMessage[] = params.messages.map(m => ({
        role: m.role,
        content: m.content,
      }));
      const reply = await llmChat(config, llmMsgs);
      return { reply: reply.content };
    } catch (e: any) {
      return { error: e.message || String(e) };
    }
  });

  // ════════════════════════════════════════════════════════
  // Streaming Chat (SSE-style) — pushes chunks via webContents.send
  // ════════════════════════════════════════════════════════

  ipcMain.handle("agent:chat-stream", async (event, params: DesktopChatRequest) => {
    requireChatOwner(event.sender);
    return runDesktopChat(event.sender, params, true);
  });

  // ════════════════════════════════════════════════════════
  // Account Management
  // ════════════════════════════════════════════════════════

  ipcMain.handle("agent:accounts:list", async () => {
    return getRedactedAccounts();
  });

  ipcMain.handle("agent:accounts:add", async (_event, account: PlatformAccount) => {
    gateAccount(requireAccountMutation());
    const added = addAccount(account);
    const { platformPassword: _platformPassword, ...safe } = added;
    return { ...safe, hasPassword: Boolean(_platformPassword) };
  });

  ipcMain.handle("agent:accounts:update", async (_event, params: {
    index: number; account: Partial<PlatformAccount>;
  }) => {
    gateAccount(requireAccountMutation());
    const updated = updateAccount(params.index, params.account);
    if (!updated) return null;
    const { platformPassword: _platformPassword, ...safe } = updated;
    return { ...safe, hasPassword: Boolean(_platformPassword) };
  });

  ipcMain.handle("agent:accounts:delete", async (_event, index: number) => {
    gateAccount(requireAccountMutation());
    return deleteAccount(index);
  });

  ipcMain.handle("agent:accounts:profile", async (_event, dirId: string) => {
    return getProfileAccounts(dirId).map(({ platformPassword: _platformPassword, ...account }) => ({
      ...account,
      hasPassword: Boolean(_platformPassword),
    }));
  });

  // Copy username to the system clipboard (no secret involved).
  ipcMain.handle("agent:accounts:copy-username", async (_event, index: number) => {
    const accounts = getAccounts();
    if (index < 0 || index >= accounts.length) return { ok: false, error: "account not found" };
    const username = accounts[index].platformUserName || "";
    if (!username) return { ok: false, error: "account has no username" };
    clipboard.writeText(username);
    recordAudit({ category: "account", action: "copy-username", target: accounts[index].platformUrl.slice(0, 200), actor: "user" });
    return { ok: true };
  });
  // Reveal + copy password — member+ only. The plaintext never crosses into
  // the renderer; the main process writes the clipboard directly.
  ipcMain.handle("agent:accounts:copy-password", async (_event, index: number) => {
    gateAccount(requireAccountSecret());
    const accounts = getAccounts();
    if (index < 0 || index >= accounts.length) return { ok: false, error: "account not found" };
    const password = getAccountPassword(index);
    if (!password) return { ok: false, error: "account has no password" };
    clipboard.writeText(password);
    recordAudit({ category: "account", action: "copy-password", target: accounts[index].platformUrl.slice(0, 200), actor: "user" });
    return { ok: true };
  });

  // Bind an account to a set of profiles (replaces the profileIds list).
  ipcMain.handle("agent:accounts:bind", async (_event, params: {
    index: number; profileIds: string[];
  }) => {
    gateAccount(requireAccountMutation());
    const updated = setAccountProfileIds(params.index, params.profileIds);
    if (!updated) return null;
    const { platformPassword: _platformPassword, ...safe } = updated;
    recordAudit({ category: "account", action: "bind", target: safe.platformUrl.slice(0, 200), actor: "user", detail: "profiles=" + (safe.profileIds || []).length });
    return { ...safe, hasPassword: Boolean(_platformPassword) };
  });

  // Bulk import pasted account lines (url, username, password, tags).
  ipcMain.handle("agent:accounts:bulk-add", async (_event, text: string) => {
    gateAccount(requireAccountMutation());
    const items = parseAccountsBulkText(String(text || ""));
    const result = bulkAddAccounts(items);
    recordAudit({ category: "account", action: "bulk-add", target: "", actor: "user", detail: "added=" + result.added + " skipped=" + result.skipped });
    return result;
  });

  // Bulk import accounts AND create a bound profile per account.
  ipcMain.handle("agent:accounts:bulk-create", async (_event, params: {
    text: string;
    options?: { platform?: "windows" | "macos" | "android" };
  }) => {
    gateAccount(requireAccountMutation());
    const items = parseAccountsBulkText(String(params?.text || ""));
    const result = bulkCreateProfilesWithAccounts(items, params?.options || {});
    recordAudit({ category: "account", action: "bulk-create-profiles", target: "", actor: "user", detail: "added=" + result.added + " created=" + result.created + " skipped=" + result.skipped });
    return result;
  });

  // ════════════════════════════════════════════════════════
  // Agent Run trace management
  // ════════════════════════════════════════════════════════

  ipcMain.handle("agent-run:list", async () => {
    // Return summaries (omit full steps to keep payloads small).
    return agentRunRecorder.listRuns().map((run: any) => {
      const { steps, ...summary } = run;
      return { ...summary, stepCount: steps.length };
    });
  });

  // ── M2: run results ──

  /** Paged preview of a run's stored dataset. Integrity failures return an
   *  error and NO rows — a payload whose hash no longer matches must never be
   *  rendered as if it were the committed result. */
  ipcMain.handle("agent-run:results-preview", async (_event, params?: { runId?: string; artifactId?: string; offset?: number; limit?: number }) => {
    const runId = String(params?.runId || "");
    if (!runId) return { ok: false, error: "runId is required" };
    const artifactId = params?.artifactId ? String(params.artifactId) : undefined;
    const res = runResultStore.readDatasetPreview(
      runId,
      artifactId || "dataset",
      Number(params?.offset) || 0,
      Number(params?.limit) || 100,
    );
    if (!res.ok) return { ok: false, error: res.detail, reasonCode: res.reasonCode };
    return { ok: true, ...res.value };
  });

  ipcMain.handle("agent-run:export-plan", async (_event, params?: { runId?: string; artifactId?: string; kind?: string }) => {
    const kind = params?.kind;
    if (kind !== "summary-json" && kind !== "dataset-csv" && kind !== "file") {
      return { ok: false, error: `unknown export kind: ${JSON.stringify(kind)}` };
    }
    const plan = planExport({ runId: String(params?.runId || ""), artifactId: params?.artifactId ? String(params.artifactId) : undefined, kind });
    if (!plan.ok) return { ok: false, error: plan.detail, reasonCode: plan.reasonCode };
    return { ok: true, plan };
  });

  ipcMain.handle("agent-run:export-write", async (event, params?: { runId?: string; artifactId?: string; kind?: string; destPath?: string }) => {
    const kind = params?.kind;
    if (kind !== "summary-json" && kind !== "dataset-csv" && kind !== "file") {
      return { ok: false, error: `unknown export kind: ${JSON.stringify(kind)}` };
    }
    const runId = String(params?.runId || "");
    const artifactId = params?.artifactId ? String(params.artifactId) : undefined;
    // Annotated: an object literal widens the narrowed literal back to string.
    const args: ExportPlanArgs = { runId, artifactId, kind };

    // The plan is what the user approved — show it, then write.
    const plan = planExport(args);
    if (!plan.ok) return { ok: false, error: plan.detail, reasonCode: plan.reasonCode };

    let destPath = typeof params?.destPath === "string" ? params.destPath.trim() : "";
    let fromDialog = false;
    if (!destPath) {
      const dlgOpts = {
        title: "Export Run Result",
        defaultPath: plan.suggestedName,
        filters: [{ name: plan.format.toUpperCase(), extensions: [plan.extension].filter(Boolean) }],
      };
      // Electron's overloads are (window, options) or (options) — passing an
      // explicit undefined as the window is not a documented form.
      const parent = BrowserWindow.fromWebContents(event.sender);
      const r = parent ? await dialog.showSaveDialog(parent, dlgOpts) : await dialog.showSaveDialog(dlgOpts);
      if (r.canceled || !r.filePath) return { ok: false, error: "cancelled", reasonCode: "cancelled" };
      destPath = r.filePath;
      fromDialog = true;
    }
    try {
      // Dialog paths are user-chosen but still guarded: the guard's job is to
      // stop escapes and wrong extensions, not to second-guess the user.
      destPath = assertSafeRunExportPath(destPath, kind === "summary-json" ? "json" : kind === "dataset-csv" ? "csv" : "original");
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e), reasonCode: "invalid_path" };
    }

    const res = writeExport({ ...args, destPath });
    if (!res.ok) return { ok: false, error: res.detail, reasonCode: res.reasonCode };
    recordAudit({
      category: "run",
      action: kind === "summary-json" ? "export-run-summary" : kind === "dataset-csv" ? "export-run-dataset" : "export-run-file",
      target: runId,
      actor: "user",
      // Never the full path or any payload content.
      detail: JSON.stringify({ format: plan.format, rows: res.rows ?? null, bytes: res.bytes, verification: plan.verification?.status ?? "unverified", viaDialog: fromDialog }),
    });
    return { ok: true, filePath: res.filePath, bytes: res.bytes, rows: res.rows };
  });

  ipcMain.handle("agent-run:get", async (_event, runId: string) => {
    return agentRunRecorder.getRun(runId);
  });

  ipcMain.handle("agent-run:delete", async (_event, runId: string) => {
    return { success: agentRunRecorder.deleteRun(runId) };
  });

  ipcMain.handle("agent-run:clear", async () => {
    return { deleted: agentRunRecorder.clearRuns() };
  });

  // ════════════════════════════════════════════════════════
  // Agent SQLite DB viewer
  // ════════════════════════════════════════════════════════

  ipcMain.handle("agent-db:tables", async () => agentDbTables());
  ipcMain.handle("agent-db:table-data", async (_e, table: string, limit?: number, offset?: number) => {
    return agentDbTableData(table, limit, offset);
  });
  ipcMain.handle("agent-db:query", async (_e, sql: string) => {
    try { return { ok: true, ...agentDbQuery(sql) }; }
    catch (e: any) { return { ok: false, error: e.message || String(e) }; }
  });
  // Same member+ gate as REST /api/agent/db/exec (R0925-01): the UI SQL box
  // writes the real SQLite store, so a viewer must not reach agentDbExecScript.
  ipcMain.handle("agent-db:exec", async (_e, sql: string) => {
    const gate = requireSettingsMutation();
    if (!gate.ok) return { ok: false, error: gate.error };
    return agentDbExecScript(sql);
  });

  // ════════════════════════════════════════════════════════
  // Approval gate (risky-operation authorization)
  // ════════════════════════════════════════════════════════

  ipcMain.handle("approval:list", async () => listPendingApprovals());
  // Destructive-adjacent (self-approval bypass = prompt bypass): require the
  // same confirmed+sender gate as audit:clear (R2 #49). A bare invoke from
  // injected renderer JS is rejected without touching the pending map.
  ipcMain.handle("approval:resolve", async (event, id: string, decision: string, opts?: { confirmed?: boolean }) => {
    try {
      if (!opts || opts.confirmed !== true) {
        return { success: false, error: "approval:resolve requires explicit user confirmation (pass { confirmed: true })" };
      }
      const { BrowserWindow } = await import("electron");
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: "approval:resolve rejected: untrusted sender" };
      }
      // Allowlist the decision (R4): arbitrary strings resolve as allow
      // (approval-gate treats anything !== "deny" as allowed).
      if (decision !== "once" && decision !== "always" && decision !== "deny") {
        return { success: false, error: "decision must be once, always or deny" };
      }
      return { success: resolveApproval(id, decision) };
    } catch {
      return { success: false, error: "approval:resolve rejected: sender check failed" };
    }
  });
}
