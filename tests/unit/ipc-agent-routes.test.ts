import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const h = vi.hoisted(() => {
  const fs = require("node:fs"); const path = require("node:path");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "ipc-agent-"));
  const forbidden = vi.fn((...args: unknown[]) => { throw new Error(`Undeclared native capability: ${String(args[0])}`); });
  return { root, handlers: new Map<string, (...args: any[]) => any>(), forbidden, clipboard: vi.fn(), saveDialog: vi.fn(), trusted: true };
});
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: any) => { if (h.handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`); h.handlers.set(channel, handler); } },
  app: { getPath: (name: string) => { if (["userData", "home", "downloads"].includes(name)) return h.root; throw new Error(`Unexpected Electron path: ${name}`); } },
  clipboard: { writeText: h.clipboard }, dialog: { showSaveDialog: h.saveDialog },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => h.trusted ? { isDestroyed: () => false } : null },
}));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(),
  exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden, execFileSync: h.forbidden, spawn: h.forbidden, spawnSync: h.forbidden,
}));
// LLM auto-discovery uses os.homedir(), not Electron's mocked home path. Keep
// the real discovery flow, but never let this store fixture read host settings.
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), homedir: () => h.root }));

import { registerAgentHandlers } from "../../src/main/ipc/agent.js";
import { getConfig, getConfigPath, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { closeAgentDb } from "../../src/main/services/agent-db.js";
import { saveConversations, loadConversations } from "../../src/main/services/agent/conversation-store.js";
import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { requestApproval, clearApprovalMemory } from "../../src/main/services/approval-gate.js";
import { initializeSecretStorage, resetSecretStorageForTests } from "../../src/main/services/secrets.js";
registerAgentHandlers();
const sender = { id: 47, isDestroyed: () => false, send: vi.fn() };
const invoke = (channel: string, ...args: any[]) => h.handlers.get(channel)!({ sender }, ...args);
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
function role(value: "owner" | "viewer") {
  const cfg = structuredClone(getConfig()); cfg.team = { name: "IPC workspace", ownerDeviceId: cfg.deviceId!, enabled: true, updatedAt: 1,
    members: [{ deviceId: cfg.deviceId!, name: "IPC device", role: value, addedAt: 1 }] }; saveConfig(cfg);
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("ANTHROPIC_API_KEY", "");
  closeAgentDb(); resetSecretStorageForTests(); clearApprovalMemory(); fs.rmSync(h.root, { recursive: true, force: true }); fs.mkdirSync(h.root); reloadConfig(); getConfig();
  initializeSecretStorage({ backend: "file", userDataDir: h.root, keyPath: path.join(h.root, ".secret-vault-key"), reason: "isolated IPC fixture" });
  h.trusted = true; h.forbidden.mockClear(); h.clipboard.mockReset(); h.saveDialog.mockReset(); sender.send.mockClear();
  vi.stubGlobal("fetch", h.forbidden);
});
afterEach(() => { closeAgentDb(); resetSecretStorageForTests(); clearApprovalMemory(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(() => fs.rmSync(h.root, { recursive: true, force: true }));

describe("actual agent IPC routes with real isolated stores", () => {
  it("saved configuration is encrypted on disk and redacted on both query routes", async () => {
    expect(await invoke("agent:llm-config")).toBeNull(); expect(await invoke("agent:detect-llm-config")).toBeNull();
    expect(await invoke("agent:save-llm-config", { provider: "openai", apiKey: "" })).toMatchObject({ success: false });
    expect(await invoke("agent:save-llm-config", { provider: "openai", apiKey: "fixture-api-secret", model: "offline-fixture" })).toEqual({ success: true });
    expect(fs.readFileSync(getConfigPath(), "utf8")).not.toContain("fixture-api-secret"); expect(disk().llm.apiKey).toMatch(/^v2:/);
    reloadConfig();
    for (const channel of ["agent:llm-config", "agent:detect-llm-config"]) {
      const config = await invoke(channel); expect(config).toMatchObject({ provider: "openai", hasApiKey: true, model: "offline-fixture" }); expect(config).not.toHaveProperty("apiKey");
    }
    expect(await invoke("agent:chat-simple", { messages: null })).toHaveProperty("error");
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("auto-discovery reads only the isolated home settings and redacts its synthetic credential", async () => {
    const file = path.join(h.root, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: "https://llm.fixture.test", ANTHROPIC_AUTH_TOKEN: "fixture-discovery-secret", ANTHROPIC_MODEL: "offline-fixture",
    } }));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).env.ANTHROPIC_MODEL).toBe("offline-fixture");
    const detected = await invoke("agent:detect-llm-config");
    expect(detected).toMatchObject({ provider: "claude", model: "offline-fixture", hasApiKey: true });
    expect(detected).not.toHaveProperty("apiKey");
    expect(JSON.stringify(detected)).not.toContain("fixture-discovery-secret");
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("skill repository operations persist, reload and search actual entries", async () => {
    expect((await invoke("agent:skills")).length).toBeGreaterThan(0);
    expect((await invoke("agent:skills:marketplace", "browser")).length).toBeGreaterThan(0);
    expect((await invoke("agent:task-templates")).length).toBeGreaterThan(0);
    expect(await invoke("agent:skills:add", { id: "ipc-skill", title: "IPC skill", prompt: "Do not execute this fixture", tools: [], tags: ["ipc-proof"], shared: true })).toMatchObject({ success: true });
    expect(disk().skillRepository["ipc-skill"].title).toBe("IPC skill"); reloadConfig();
    expect((await invoke("agent:skills:list", "ipc-proof"))[0].id).toBe("ipc-skill");
    expect(await invoke("agent:skills:install", "ipc-skill")).toMatchObject({ success: true });
    expect(await invoke("agent:skills:set-meta", { id: "ipc-skill", shared: true, enabled: false, tags: ["changed"] })).toMatchObject({ success: true });
    expect(disk().skillRepository["ipc-skill"]).toMatchObject({ enabled: false, tags: ["changed"] }); reloadConfig();
    const exported = await invoke("agent:skills:export-shared"); expect(exported.some((entry: any) => entry.id === "ipc-skill")).toBe(true);
    expect(await invoke("agent:skills:import-shared", exported)).toMatchObject({ success: true });
    expect(await invoke("agent:skills:remove", "ipc-skill")).toEqual({ success: true }); expect(disk().skillRepository["ipc-skill"]).toBeUndefined(); reloadConfig();
    expect(await invoke("agent:skills:list", "ipc-proof")).toEqual([]);
    for (const [channel, input] of [["agent:skills:add", { id: "../invalid" }], ["agent:skills:install", "missing"], ["agent:skills:set-meta", { id: "missing" }], ["agent:skills:import-shared", null]] as Array<[string, any]>) expect(await invoke(channel, input)).toMatchObject({ success: false });
  });

  it("platform catalog routes return real matching adapters without browser execution", async () => {
    const all = await invoke("platform:adapters:list"); expect(all.length).toBeGreaterThan(0);
    expect(await invoke("platform:adapter:get", all[0].id)).toMatchObject({ id: all[0].id });
    expect(await invoke("platform:adapter:get", "missing")).toBeNull();
    expect(await invoke("platform:adapter:detect", "https://example.test")).toBeDefined();
  });

  it("conversation create/rename/read/delete round-trips on disk and authoritative run metadata wins", async () => {
    const first = await invoke("agent:conversations:create"); expect(first).toMatchObject({ title: "New Chat", titleKind: "default", messageCount: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(h.root, "agent-conversations.json"), "utf8"))[0].id).toBe(first.id);
    reloadConfig(); expect((await invoke("agent:conversations:list"))[0].id).toBe(first.id);
    expect(await invoke("agent:conversations:rename", { id: first.id, title: "IPC conversation" })).toMatchObject({ title: "IPC conversation", titleKind: "literal" });
    expect(loadConversations()[0].title).toBe("IPC conversation");
    const run = agentRunRecorder.startRun({ name: "IPC conversation trace", source: "chat", webContents: sender as any });
    agentRunRecorder.finishRun(run.id, "done", undefined, { endReason: "completed" });
    const conversations = loadConversations(); conversations[0].messages = [{ role: "assistant", content: "fixture", runId: run.id, endReason: "execution_error" }]; saveConversations(conversations);
    expect((await invoke("agent:conversations:get", first.id)).messages[0]).toMatchObject({ endReason: "completed", verification: { status: "unverified" } });
    const second = await invoke("agent:conversations:create", "Literal title"); expect(second).toMatchObject({ titleKind: "literal" });
    expect(await invoke("agent:conversations:get", "missing")).toBeNull();
    expect(await invoke("agent:conversations:delete", first.id)).toBe(true); expect(loadConversations().some((entry) => entry.id === first.id)).toBe(false);
    expect((await invoke("agent:conversations:list")).map((entry: any) => entry.id)).toEqual([second.id]);
    expect(await invoke("agent:conversations:delete", "missing")).toBe(false);
  });

  it("untrusted chat invocations are rejected before any LLM/native capability", async () => {
    h.trusted = false;
    for (const channel of ["agent:chat", "agent:chat-stream", "agent:chat-active", "agent:chat-cancel"]) await expect(invoke(channel, {})).rejects.toThrow("Untrusted");
    h.trusted = true;
    expect(await invoke("agent:chat-cancel", null)).toMatchObject({ accepted: false, state: "not_found" });
    expect(await invoke("agent:chat-cancel", { conversationId: "missing", runId: 3 })).toMatchObject({ accepted: false });
    expect(await invoke("agent:chat-cancel", { conversationId: "missing", runId: "missing" })).toMatchObject({ accepted: false });
    expect(await invoke("agent:chat-active", "missing")).toBeNull(); expect(await invoke("agent:chat-active", null)).toBeNull();
    expect(await invoke("agent:chat-simple", { messages: [] })).toEqual({ error: "No LLM config." });
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("account CRUD, binding and clipboard secrets use current reference and real encryption", async () => {
    const account = { platformUrl: "https://example.test", platformUserName: "alice", platformPassword: "account-fixture-secret", tags: ["ipc"] };
    const added = await invoke("agent:accounts:add", account); expect(added).toMatchObject({ platformUserName: "alice", hasPassword: true });
    expect(fs.readFileSync(getConfigPath(), "utf8")).not.toContain("account-fixture-secret"); expect(disk().accounts[0].platformPassword).toMatch(/^v2:/); reloadConfig();
    let current = (await invoke("agent:accounts:list"))[0]; expect(await invoke("agent:accounts:get", 0, current.ref)).toMatchObject({ platformUserName: "alice", hasPassword: true });
    expect(await invoke("agent:accounts:copy-username", 0, current.ref)).toEqual({ ok: true }); expect(h.clipboard).toHaveBeenLastCalledWith("alice");
    expect(await invoke("agent:accounts:copy-password", 0, current.ref)).toEqual({ ok: true }); expect(h.clipboard).toHaveBeenLastCalledWith("account-fixture-secret");
    const cfg = structuredClone(getConfig()); cfg.browserProfiles.ab_bound = { name: "Bound profile", fingerprintSeed: 12345 } as any; saveConfig(cfg); current = (await invoke("agent:accounts:list"))[0];
    const bound = await invoke("agent:accounts:bind", { index: 0, profileIds: ["ab_bound"], ref: current.ref }); expect(bound.profileIds).toEqual(["ab_bound"]);
    expect(disk().accounts[0].profileIds).toEqual(["ab_bound"]); reloadConfig(); expect(await invoke("agent:accounts:profile", "ab_bound")).toContainEqual(expect.objectContaining({ platformUserName: "alice", hasPassword: true }));
    current = (await invoke("agent:accounts:list"))[0]; await invoke("agent:accounts:update", { index: 0, account: { platformUserName: "bob" }, ref: current.ref });
    expect(disk().accounts[0].platformUserName).toBe("bob"); reloadConfig(); current = (await invoke("agent:accounts:list"))[0]; expect(current.platformUserName).toBe("bob");
    expect(await invoke("agent:accounts:delete", 0, current.ref)).toBe(true); expect(disk().accounts).toEqual([]); reloadConfig(); expect(await invoke("agent:accounts:list")).toEqual([]);
  });

  it("viewer account writes and reveal are denied before disk or clipboard changes", async () => {
    role("viewer"); const before = fs.readFileSync(getConfigPath(), "utf8");
    for (const [channel, args] of [["agent:accounts:add", [{}]], ["agent:accounts:update", [{}]], ["agent:accounts:delete", [0]], ["agent:accounts:bind", [{}]], ["agent:accounts:copy-password", [0]], ["agent:accounts:bulk-add", ["https://example.test,user,pw"]], ["agent:accounts:bulk-create", [{ text: "https://example.test,user,pw" }]]] as Array<[string, any[]]>) await expect(invoke(channel, ...args)).rejects.toThrow("requires member role");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(h.clipboard).not.toHaveBeenCalled(); expect(await invoke("agent:accounts:list")).toEqual([]);
  });

  it("bulk account parse failures and valid imports have truthful persisted counts", async () => {
    expect(await invoke("agent:accounts:bulk-add", "https://bulk.example.test,bulk-user,fixture-password,ipc-bulk")).toMatchObject({ added: 1 });
    expect(disk().accounts[0].platformUserName).toBe("bulk-user"); reloadConfig(); expect((await invoke("agent:accounts:list"))[0].platformUserName).toBe("bulk-user");
    expect(await invoke("agent:accounts:bulk-create", { text: "" })).toMatchObject({ added: 0, created: 0 });
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("agent DB write is independently verified, closed, queried and searchable", async () => {
    expect(await invoke("agent-db:exec", "CREATE TABLE ipc_probe (id INTEGER, value TEXT); INSERT INTO ipc_probe VALUES (1, 'needle');")).toEqual({ ok: true });
    closeAgentDb(); const db = new DatabaseSync(path.join(h.root, "agent-store.sqlite"), { readOnly: true });
    try { expect(db.prepare("SELECT value FROM ipc_probe").get()).toMatchObject({ value: "needle" }); } finally { db.close(); }
    expect(await invoke("agent-db:query", "SELECT value FROM ipc_probe WHERE value='needle'")).toMatchObject({ ok: true, rows: [{ value: "needle" }] });
    expect(await invoke("agent-db:tables")).toContainEqual(expect.objectContaining({ name: "ipc_probe" }));
    expect(await invoke("agent-db:table-data", "ipc_probe", 10, 0)).toMatchObject({ total: 1, rows: [{ value: "needle" }] });
    expect(await invoke("agent-db:query", "not valid SQL")).toMatchObject({ ok: false }); expect(await invoke("agent-db:exec", "not valid SQL")).toMatchObject({ ok: false });
    role("viewer"); expect(await invoke("agent-db:exec", "DROP TABLE ipc_probe")).toMatchObject({ ok: false, error: "requires member role (current: viewer)" });
    expect(await invoke("agent-db:query", "SELECT value FROM ipc_probe")).toMatchObject({ ok: true, rows: [{ value: "needle" }] });
  });

  it("run traces/list/summary export/delete use the actual recorder and file integrity", async () => {
    const run = agentRunRecorder.startRun({ name: "IPC export fixture", source: "chat", webContents: sender as any });
    agentRunRecorder.recordStep(run.id, { tool: "fixture", args: {}, result: "stored", ok: true }); agentRunRecorder.finishRun(run.id, "done", undefined, { endReason: "completed" });
    expect(disk().agentRuns[0].id).toBe(run.id); reloadConfig(); expect(await invoke("agent-run:list")).toContainEqual(expect.objectContaining({ id: run.id, stepCount: 1 }));
    expect(await invoke("agent-run:get", run.id)).toMatchObject({ id: run.id, status: "done" });
    expect(await invoke("agent-run:results-preview", {})).toMatchObject({ ok: false });
    expect(await invoke("agent-run:results-preview", { runId: run.id })).toMatchObject({ ok: false });
    expect(await invoke("agent-run:export-plan", { runId: run.id, kind: "unknown" })).toMatchObject({ ok: false });
    expect(await invoke("agent-run:export-write", { runId: run.id, kind: "unknown" })).toMatchObject({ ok: false });
    expect(await invoke("agent-run:export-plan", { runId: run.id, kind: "summary-json" })).toMatchObject({ ok: true });
    const destPath = path.join(h.root, "ipc-run-summary.json");
    expect(await invoke("agent-run:export-write", { runId: run.id, kind: "summary-json", destPath })).toMatchObject({ ok: true, filePath: destPath });
    expect(fs.readFileSync(destPath, "utf8")).toContain(run.id);
    h.saveDialog.mockResolvedValue({ canceled: true }); expect(await invoke("agent-run:export-write", { runId: run.id, kind: "summary-json" })).toMatchObject({ ok: false, reasonCode: "cancelled" });
    role("viewer"); expect(await invoke("agent-run:delete", run.id)).toMatchObject({ success: false }); expect(await invoke("agent-run:clear")).toMatchObject({ success: false, deleted: 0 });
    role("owner"); expect(await invoke("agent-run:delete", run.id)).toEqual({ success: true }); expect(disk().agentRuns).toEqual([]); reloadConfig(); expect(await invoke("agent-run:get", run.id)).toBeNull();
    expect(await invoke("agent-run:delete", run.id)).toMatchObject({ success: false, reasonCode: "missing" }); expect(await invoke("agent-run:clear")).toMatchObject({ success: true, deleted: 0 });
  });

  it("approvals need confirmation, trusted sender and exact decisions before resolving", async () => {
    const controller = new AbortController();
    const pending = requestApproval({ category: "db-write", tool: "fixture", description: "Fixture approval", detail: "INSERT fixture" }, undefined, controller.signal);
    try {
      const request = (await invoke("approval:list"))[0]; expect(request).toMatchObject({ description: "Fixture approval" });
      expect(await invoke("approval:resolve", request.id, "once")).toMatchObject({ success: false });
      h.trusted = false; expect(await invoke("approval:resolve", request.id, "once", { confirmed: true })).toMatchObject({ success: false });
      h.trusted = true; expect(await invoke("approval:resolve", request.id, "allow-anything", { confirmed: true })).toMatchObject({ success: false });
      expect(await invoke("approval:resolve", request.id, "deny", { confirmed: true })).toEqual({ success: true });
      expect(await pending).toEqual({ allowed: false, decision: "deny" }); expect(await invoke("approval:list")).toEqual([]);
    } finally { controller.abort(); }
  });
});
