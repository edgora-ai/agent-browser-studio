import { ipcMain, clipboard } from "electron";
import { randomUUID } from "node:crypto";
import {
  getAccounts, getRedactedAccounts, addAccount, updateAccount, deleteAccount, getProfileAccounts,
  getAccountPassword, setAccountProfileIds, parseAccountsBulkText, bulkAddAccounts,
  bulkCreateProfilesWithAccounts,
  llmChat, llmStreamChat, agentChat,
  loadConversations, createConversation, getConversation, listConversations,
  deleteConversation, renameConversation, addMessage,
  getOrDetectLlmConfig,
  getLlmConfig, redactLlmConfig, saveLlmConfig,
  getAllowedAgentTools,
  executeToolCall,
  buildAgentSystemPrompt,
} from "../services/local-agent.js";
import { agentRunRecorder } from "../services/agent-run-trace.js";
import { agentDbTables, agentDbTableData, agentDbQuery, agentDbExecScript } from "../services/agent-db.js";
import { listPendingApprovals, resolveApproval } from "../services/approval-gate.js";
import { listBrowserProfiles } from "../services/browser-manager.js";
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
import { requireAccountMutation, requireAccountSecret, type RoleCheck } from "../services/team.js";

function gateAccount(r: RoleCheck): void {
  if (!r.ok) throw new Error(r.error);
}

// Repair a chat history before sending to the LLM:
// (1) collapse consecutive same-role turns (Claude/Anthropic rejects them — and
//     a history poisoned by prior failed runs can legitimately contain
//     back-to-back user messages, since we used to write only the user side).
// (2) drop trailing tool messages whose tool_call_id no longer has a matching
//     assistant tool_call earlier in the window. This produced the
//     "tool_use ids were found without tool_result" 400s.
export function repairMessageSequence(msgs: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  const seenCallIds = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc.id) seenCallIds.add(tc.id);
    }
    if (m.role === "tool") {
      const cid = (m as any).tool_call_id || (m as any).call_id;
      // Skip orphaned tool results — no corresponding tool_use upstream.
      if (!cid || !seenCallIds.has(cid)) continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && (m.role === "user" || m.role === "assistant")) {
      // Merge into the previous turn so we don't violate strict alternation.
      const a = (prev.content || "").trim();
      const b = (m.content || "").trim();
      prev.content = a && b ? `${a}\n\n${b}` : a || b;
      if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
        (prev as any).tool_calls = [
          ...((prev as any).tool_calls || []),
          ...(m as any).tool_calls,
        ];
      }
      continue;
    }
    out.push({ ...m });
  }
  // Drop a trailing assistant that has tool_calls without any tool results
  // (truncated by an earlier crash) — the next user turn won't be able to
  // satisfy it without re-running the tools.
  while (out.length) {
    const last = out[out.length - 1];
    if (last.role === "assistant" && Array.isArray((last as any).tool_calls) && (last as any).tool_calls.length > 0) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

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
    return getConversation(id);
  });

  ipcMain.handle("agent:conversations:create", async (_event, title?: string) => {
    const c = createConversation(title);
    return { id: c.id, title: c.title, messageCount: 0, createdAt: c.createdAt, updatedAt: c.updatedAt };
  });

  ipcMain.handle("agent:conversations:delete", async (_event, id: string) => {
    return deleteConversation(id);
  });

  ipcMain.handle("agent:conversations:rename", async (_event, params: { id: string; title: string }) => {
    return renameConversation(params.id, params.title);
  });

  // ════════════════════════════════════════════════════════
  // Chat — tool-calling agent loop
  // ════════════════════════════════════════════════════════

  ipcMain.handle("agent:chat", async (event, params: {
    conversationId: string;
    message: string;
  }) => {
    const config = getLlmConfig() || getOrDetectLlmConfig();
    if (!config) {
      return { error: "No LLM config. Please configure your API key in the Agent → API Config tab." };
    }

    // Load conversation
    const conv = getConversation(params.conversationId);
    if (!conv) {
      return { error: "Conversation not found." };
    }

    addMessage(params.conversationId, "user", params.message);

    // Build history from the snapshot (captured BEFORE addMessage above), then
    // push the current message explicitly. repairMessageSequence collapses any
    // resulting consecutive same-role turns.
    const recentMsgs = conv.messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .slice(-40);
    let llmMsgs: LlmMessage[] = recentMsgs.map(m => ({
      role: m.role,
      content: m.content,
    }));
    llmMsgs.push({ role: "user", content: params.message });
    llmMsgs = repairMessageSequence(llmMsgs);

    try {
      const result = await agentChat(config, llmMsgs, { webContents: event.sender });
      if (result.error) {
        // Persist an assistant error reply so the next turn's history stays a
        // valid [user, assistant] pair instead of leaving an orphaned user.
        addMessage(params.conversationId, "assistant", `❌ ${result.error}`, []);
        return { error: result.error };
      }

      // Select LAST assistant response (not intermediate tool-call message)
      const finalMsg = [...result.messages].reverse().find(m => m.role === "assistant" && m.content);
      const reply = finalMsg?.content || "(no response)";

      if (!finalMsg?.content) {
        addMessage(params.conversationId, "assistant", "❌ Agent did not return a final response.", []);
        return { error: "Agent did not return a final response." };
      }

      const redactedToolCalls = result.messages.flatMap(m =>
        m.tool_calls?.map(tc => ({
          name: tc.function.name,
          redacted: true,
        })) || []
      );

      // Save assistant reply without raw tool arguments; they may contain typed secrets.
      addMessage(params.conversationId, "assistant", reply, redactedToolCalls);

      return {
        reply,
        toolCalls: redactedToolCalls,
      };
    } catch (e: any) {
      addMessage(params.conversationId, "assistant", `❌ ${e.message || String(e)}`, []);
      return { error: e.message || String(e) };
    }
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

  ipcMain.handle("agent:chat-stream", async (event, params: {
    conversationId: string;
    message: string;
    streamId?: string;
  }) => {
    const streamId = params.streamId || randomUUID();
    const config = getLlmConfig() || getOrDetectLlmConfig();
    if (!config) {
      event.sender.send("agent:stream-error", { error: "No LLM config", streamId });
      return { error: "No LLM config", streamId };
    }

    const conv = getConversation(params.conversationId);
    if (!conv) {
      event.sender.send("agent:stream-error", { error: "Conversation not found", streamId });
      return { error: "Conversation not found", streamId };
    }

    addMessage(params.conversationId, "user", params.message);

    // Build history from the conversation snapshot. NOTE: `conv` was captured
    // BEFORE addMessage() above, so the snapshot does NOT include the current
    // message — we push it explicitly. repairMessageSequence then collapses any
    // consecutive same-role turns (e.g. orphaned users from prior failed runs
    // merging with this one) so Claude-format backends don't 400.
    const recentMsgs = conv.messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .slice(-40);
    let llmMsgs: LlmMessage[] = recentMsgs.map(m => ({
      role: m.role,
      content: m.content,
    }));
    llmMsgs.push({ role: "user", content: params.message });
    llmMsgs = repairMessageSequence(llmMsgs);
    // Inject the system prompt (with currently-running profile ports) at the
    // front so the model knows which CDP port to use without asking the user.
    llmMsgs.unshift({
      role: "system",
      content: buildAgentSystemPrompt(
        listBrowserProfiles()
          .filter((p) => p.running && p.cdpPort)
          .map((p) => ({ name: p.name, dirId: p.dirId, cdpPort: p.cdpPort })),
      ),
    });

    const sendChunk = (text: string) => {
      event.sender.send("agent:stream-chunk", { text, streamId });
    };
    const sendToolCall = (tc: { id: string; name: string; arguments: string }) => {
      event.sender.send("agent:stream-tool-call", { id: tc.id, name: tc.name, arguments: "{}", redacted: true, streamId });
    };
    const sendDone = () => {
      event.sender.send("agent:stream-done", { streamId });
    };
    const sendError = (error: string) => {
      event.sender.send("agent:stream-error", { error, streamId });
    };

    const allowedTools = getAllowedAgentTools();
    const allowedToolNames = new Set(allowedTools.map((t: any) => t.function.name));

    // Multi-round tool-calling loop (max 6 rounds). Each round streams text to
    // the UI; if the model emits tool_calls we execute them, feed the results
    // back, and stream again. onDone is only emitted after the final round.
    const MAX_TOOL_ROUNDS = 25;
    let reply = "";
    const allToolCalls: any[] = [];
    const allRedactedToolCalls: any[] = [];

    // Start a traceable run for this chat invocation.
    const run = agentRunRecorder.startRun({
      source: { type: "chat", conversationId: params.conversationId },
      name: (params.message || "Agent chat").slice(0, 120),
      webContents: event.sender,
    });

    const streamController = new AbortController();
    const streamTimer = setTimeout(() => streamController.abort(), 120000);
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const isFinalRound = round === MAX_TOOL_ROUNDS - 1;
        const result = await llmStreamChat(config, llmMsgs, allowedTools, {
          onText: sendChunk,
          onToolCall: sendToolCall,
          // Suppress the per-round done signal — we emit a single sendDone
          // after the loop completes.
          onDone: isFinalRound ? sendDone : undefined,
          signal: streamController.signal,
        });

        if (result.content) reply += result.content;

        // No tool calls → this round is the answer.
        if (!result.tool_calls || result.tool_calls.length === 0) {
          if (!isFinalRound) sendDone();
          break;
        }

        // Record the assistant turn (with its tool_calls) and execute each.
        llmMsgs.push({
          role: "assistant",
          content: result.content || "",
          tool_calls: result.tool_calls,
        });
        allToolCalls.push(...result.tool_calls);

        for (const tc of result.tool_calls) {
          allRedactedToolCalls.push({ name: tc.function.name, redacted: true });
          let args: any = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); }
          catch { args = {}; }
          const stepStart = Date.now();
          let toolResult: any;
          let stepOk = true;
          let stepError: string | undefined;
          try {
            toolResult = await executeToolCall(tc.function.name, args, allowedToolNames, { runId: run.id, webContents: event.sender, signal: streamController.signal });
          } catch (e: any) {
            stepOk = false;
            stepError = e.message || String(e);
            toolResult = { error: stepError };
          }
          // Record the step in the run trace (recorder redacts args/result).
          agentRunRecorder.recordStep(run.id, {
            tool: tc.function.name,
            args,
            result: toolResult,
            ok: stepOk,
            error: stepError,
            durationMs: Date.now() - stepStart,
          });
          // Feed the tool result back for the next round (both OpenAI + Claude
          // field names for compatibility).
          llmMsgs.push({
            role: "tool",
            tool_call_id: tc.id,
            call_id: tc.id,
            name: tc.function.name,
            content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
          } as any);
        }
        // Continue to next round: the model will stream its follow-up answer.
      }
      agentRunRecorder.finishRun(run.id, "done");
    } catch (e: any) {
      const errMsg = e?.name === "AbortError" ? "LLM stream timed out" : (e.message || String(e));
      agentRunRecorder.finishRun(run.id, "error", errMsg);
      sendError(errMsg);
      // Persist an assistant error reply so the next turn's history is a valid
      // [user, assistant] pair. Without this, a failed run leaves an orphaned
      // user message — and retries accumulate consecutive user turns that
      // Claude-format backends reject ("tool_use without tool_result").
      const partial = reply ? `${reply}\n\n❌ ${errMsg}` : `❌ ${errMsg}`;
      addMessage(params.conversationId, "assistant", partial, allRedactedToolCalls);
      return { error: errMsg };
    } finally {
      clearTimeout(streamTimer);
    }

    addMessage(params.conversationId, "assistant", reply, allRedactedToolCalls);

    return { reply, toolCalls: allRedactedToolCalls, runId: run.id };
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
    options?: { platform?: "windows" | "macos" };
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
  ipcMain.handle("agent-db:exec", async (_e, sql: string) => agentDbExecScript(sql));

  // ════════════════════════════════════════════════════════
  // Approval gate (risky-operation authorization)
  // ════════════════════════════════════════════════════════

  ipcMain.handle("approval:list", async () => listPendingApprovals());
  ipcMain.handle("approval:resolve", async (_e, id: string, decision: string) => {
    return { success: resolveApproval(id, decision as any) };
  });
}
