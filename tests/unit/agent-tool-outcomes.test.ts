import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";

const fixture = vi.hoisted(() => ({
  dataDir: `${process.env.TMPDIR}/agent-tool-outcomes`,
  profiles: [] as any[],
  forbidden: vi.fn((capability: string): never => { throw new Error(`Undeclared capability: ${capability}`); }),
}));
vi.mock("electron", () => ({
  app: { getPath: () => fixture.dataDir, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => fixture.forbidden("Keychain"),
    encryptString: () => fixture.forbidden("Keychain"),
    decryptString: () => fixture.forbidden("Keychain"),
  },
}));
vi.mock("node:child_process", () => Object.fromEntries(
  ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]
    .map((name) => [name, () => fixture.forbidden(`child_process.${name}`)]),
));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  listBrowserProfiles: () => fixture.profiles,
  launchBrowser: () => fixture.forbidden("browser launch"),
  createBrowserProfile: () => fixture.forbidden("profile creation"),
  touchProfileActivityByPort: () => undefined,
  getEngineByPort: () => "chromium",
  getFirefoxBidiSessionByPort: () => null,
  statusBrowser: (dirId: string) => ({ running: fixture.profiles.some((profile) => profile.dirId === dirId && profile.running) }),
  touchProfileActivity: () => undefined,
  stopBrowser: () => fixture.forbidden("browser stop"),
}));
vi.mock("../../src/main/services/sync-service.js", () => ({ syncService: new Proxy({}, { get: (_target, key) => () => fixture.forbidden(`sync.${String(key)}`) }) }));
vi.mock("../../src/main/services/script-sandbox.js", () => ({ runSandboxedWithHandle: () => fixture.forbidden("script sandbox") }));
vi.mock("../../src/main/services/automation-notify.js", () => ({ notifyTerminal: () => fixture.forbidden("OS notifications") }));
vi.mock("../../src/main/services/profile-manager.js", () => ({ listProfiles: async () => fixture.profiles }));
vi.mock("node:http", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:http")>(),
  request: () => fixture.forbidden("external HTTP"),
}));
vi.mock("node:https", () => ({ request: () => fixture.forbidden("external HTTPS") }));
vi.mock("node:dns/promises", () => ({ lookup: () => fixture.forbidden("external DNS") }));

import { addMessage, agentChat, createConversation, executeToolCall, getConversation, loadConversations, saveLlmConfig, type LlmMessage } from "../../src/main/services/local-agent.js";
import { classifyAgentToolOutcome } from "../../src/main/services/agent/tool-outcome.js";
import { runDesktopChat } from "../../src/main/services/agent/desktop-chat.js";
import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { getConfig, getConfigPath, reloadConfig } from "../../src/main/services/config-manager.js";
import { clearApprovalMemory, resolveApproval } from "../../src/main/services/approval-gate.js";
import { closeAgentDb } from "../../src/main/services/agent-db.js";
import { transact } from "../../src/main/services/config/store.js";

const nativeFetch = globalThis.fetch;
const servers: http.Server[] = [];
const modelOrigins = new Set<string>();

async function modelFixture(replies: LlmMessage[]) {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const reply = replies.shift();
    res.writeHead(reply ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply ? { choices: [{ message: reply }] } : { error: "fixture exhausted" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  modelOrigins.add(origin);
  return { config: { provider: "openai" as const, apiUrl: `${origin}/v1`, apiKey: "synthetic-task49-key", model: "task49-fixture" }, requests };
}

beforeEach(() => {
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
  fixture.profiles.length = 0;
  fixture.forbidden.mockClear();
  reloadConfig();
  getConfig();
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!modelOrigins.has(url.origin)) return fixture.forbidden(`fetch ${url.origin}`);
    return nativeFetch(input, init);
  });
});

afterEach(async () => {
  clearApprovalMemory();
  closeAgentDb();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  modelOrigins.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(fixture.forbidden).not.toHaveBeenCalled();
});

describe("real agent tool result facts", () => {
  it("records an approval-denied HTTP write as failed even after a natural final model answer", async () => {
    const { config, requests } = await modelFixture([
      { role: "assistant", content: "", tool_calls: [{ id: "write-1", type: "function", function: {
        name: "http_request", arguments: JSON.stringify({ method: "POST", url: "https://task49.example.test/write", body: { order: "synthetic" } }),
      } }] },
      { role: "assistant", content: "The requested write was declined, so nothing was sent." },
    ]);
    const events: any[] = [];
    const owner = { id: 49, isDestroyed: () => false, send(channel: string, payload: any) {
      events.push({ channel, payload });
      if (channel === "agent:approval-request") queueMicrotask(() => resolveApproval(payload.id, "deny"));
    } };
    const run = agentRunRecorder.startRun({ source: { type: "chat", conversationId: "task49" }, name: "Denied write", webContents: owner as any });
    const result = await agentChat(config, [{ role: "user", content: "Write the synthetic order" }], { runId: run.id, webContents: owner, browserScope: null });
    expect(result.endReason).toBe("completed");
    const tool = JSON.parse(result.messages.find((message) => message.role === "tool")!.content);
    expect(tool).toMatchObject({ skipped: true, decision: "deny" });
    expect(JSON.parse(requests[1].messages.find((message: any) => message.role === "tool").content)).toEqual(tool);
    const saved = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).agentRuns.find((entry: any) => entry.id === run.id);
    expect(saved.steps[0]).toMatchObject({ tool: "http_request", ok: false, error: tool.reason, result: tool });
    const event = events.find((entry) => entry.channel === "agent:run-step");
    expect(event.payload.step).toMatchObject({ ok: false, error: tool.reason });
    agentRunRecorder.finishRun(run.id, "done", undefined, { endReason: "completed", verification: { status: "unverified" } });
    reloadConfig();
    expect(agentRunRecorder.listRuns().find((entry) => entry.id === run.id)).toMatchObject({
      endReason: "completed", verification: { status: "unverified" }, steps: [{ ok: false, error: tool.reason }],
    });
  });

  it("records cancellation during approval and never dispatches the next model-requested write", async () => {
    const { config, requests } = await modelFixture([{ role: "assistant", content: "", tool_calls: [
      { id: "cancel-http", type: "function", function: { name: "http_request", arguments: '{"method":"POST","url":"https://task49.example.test/cancel"}' } },
      { id: "never-write", type: "function", function: { name: "write_file", arguments: '{"path":"never-written.txt","content":"not dispatched"}' } },
    ] }]);
    const controller = new AbortController();
    const owner = { id: 4902, isDestroyed: () => false, send(channel: string) { if (channel === "agent:approval-request") queueMicrotask(() => controller.abort(new Error("task49 user cancelled"))); } };
    const run = agentRunRecorder.startRun({ source: { type: "chat", conversationId: "task49-cancel" }, name: "Cancel before second action" });
    await expect(agentChat(config, [{ role: "user", content: "Cancel during approval" }], { runId: run.id, browserScope: null, signal: controller.signal, webContents: owner })).rejects.toThrow("task49 user cancelled");
    expect(requests).toHaveLength(1); expect(fs.existsSync(path.join(fixture.dataDir, "agent-files/never-written.txt"))).toBe(false);
    const disk = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(disk.agentRuns.find((entry: any) => entry.id === run.id).steps).toMatchObject([{ tool: "http_request", ok: false, result: { skipped: true, cancelled: true, reason: "HTTP 写入操作已取消" } }]);
    agentRunRecorder.finishRun(run.id, "error", "task49 user cancelled", { endReason: "user_cancelled" }); reloadConfig();
    expect(agentRunRecorder.getRun(run.id)).toMatchObject({ endReason: "user_cancelled", steps: [{ ok: false }] });
  });

  it("does not dispatch a disabled tool", async () => {
    await expect(executeToolCall("launch_profile", { dirId: "ab_forbidden" }, new Set(["read_file"]))).rejects.toThrow("not enabled");
  });

  it("persists redacted tool metadata, directly checks history bytes and reloads searchable messages", () => {
    const conversation = createConversation("Task49 redaction");
    addMessage(conversation.id, "assistant", "needle-49 result", [
      { tool: "browser_type", text: "synthetic-sensitive-typed", password: "synthetic-sensitive-password", nested: [{ apiKey: "synthetic-sensitive-key" }], url: "https://user:pass@task49.example.test/path?token=synthetic-sensitive-query#synthetic-sensitive-fragment" },
      { url: "not-a-url", cookie: "synthetic-sensitive-cookie", count: 49 },
    ]);
    const bytes = fs.readFileSync(path.join(fixture.dataDir, "agent-conversations.json"), "utf8");
    expect(bytes).not.toContain("synthetic-sensitive-"); expect(bytes).toContain("[redacted-url]");
    const history = loadConversations();
    expect(history.find((entry) => entry.id === conversation.id)?.messages[0].toolResults?.[0]).toMatchObject({ text: "[redacted]", password: "[redacted]" });
    expect(getConversation(conversation.id)?.messages.filter((message) => message.content.includes("needle-49"))).toHaveLength(1);
  });

  it("keeps desktop denial and successful SQL business error data consistent on disk and events", async () => {
    const { config } = await modelFixture([
      { role: "assistant", content: "", tool_calls: [
        { id: "desktop-deny", type: "function", function: { name: "http_request", arguments: JSON.stringify({ method: "DELETE", url: "https://task49.example.test/order" }) } },
        { id: "desktop-read", type: "function", function: { name: "db_query", arguments: JSON.stringify({ sql: "SELECT 'legitimate business column' AS error, 0 AS success" }) } },
      ] },
      { role: "assistant", content: "The write was declined; the business query completed." },
    ]);
    saveLlmConfig(config);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).llm.apiUrl).toBe(config.apiUrl);
    reloadConfig();
    expect(getConfig().llm?.model).toBe("task49-fixture");
    const conversation = createConversation("Task 49 desktop");
    const events: any[] = [];
    const owner = Object.assign(new EventEmitter(), { id: 4901, isDestroyed: () => false, send(channel: string, payload: any) {
      events.push({ channel, payload });
      if (channel === "agent:approval-request") queueMicrotask(() => resolveApproval(payload.id, "deny"));
    } });
    const terminal = await runDesktopChat(owner as any, { conversationId: conversation.id, streamId: "task49-desktop", message: "Try a denied write and read the report" }, false);
    expect(terminal).toMatchObject({ status: "done", endReason: "completed", persisted: true, verification: { status: "unverified" } });
    const disk = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    const run = disk.agentRuns.find((entry: any) => entry.id === terminal.runId);
    expect(run.steps.map((step: any) => ({ tool: step.tool, ok: step.ok }))).toEqual([
      { tool: "http_request", ok: false }, { tool: "db_query", ok: true },
    ]);
    expect(run.steps[0].error).toMatch(/拒绝/);
    expect(run.steps[1].result.rows).toEqual([{ error: "legitimate business column", success: 0 }]);
    expect(events.filter((entry) => entry.channel === "agent:run-step").map((entry) => entry.payload.step.ok)).toEqual([false, true]);
    const diskConversation = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "agent-conversations.json"), "utf8")).find((entry: any) => entry.id === conversation.id);
    expect(diskConversation.messages.map((message: any) => message.role)).toEqual(["user", "assistant"]);
    expect(loadConversations().find((entry) => entry.id === conversation.id)?.messages[1].runId).toBe(terminal.runId);
    reloadConfig();
    expect(agentRunRecorder.getRun(terminal.runId!)?.steps.map((step) => step.ok)).toEqual([false, true]);
    expect(getConversation(conversation.id)?.messages.find((message) => message.runId === terminal.runId && message.role === "assistant")?.verification).toEqual({ status: "unverified" });
  });
});

describe("actual automation manual retry with a configured local model fixture", () => {
  it("creates new run lineage, never borrows old variables, and queries the committed retry", async () => {
    const { config, requests } = await modelFixture([
      { role: "assistant", content: "", tool_calls: [{ id: "retry-read-var", type: "function", function: { name: "get_var", arguments: '{"key":"order"}' } }, { id: "retry-write", type: "function", function: { name: "write_file", arguments: '{"path":"retry/task49.txt","content":"retry needle-49"}' } }] },
      { role: "assistant", content: "Retry produced the synthetic local artifact." },
    ]);
    saveLlmConfig(config);
    const rule = { id: "rule_task49_retry", name: "Task49 retry", enabled: true, trigger: { type: "event", event: "task49-explicit" }, action: { type: "agent-task", profileDirId: "ab_retry49", agentPrompt: "Only use synthetic local file and variable tools" } };
    transact((draft) => { draft.automation = [rule]; });
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).automation[0].id).toBe(rule.id); reloadConfig();
    const source = agentRunRecorder.startRun({ source: { type: "automation", ruleId: rule.id, ruleName: rule.name }, name: "Source failed run", dirId: "ab_retry49" });
    await executeToolCall("set_var", { key: "order", value: "synthetic-old-run-only" }, undefined, { runId: source.id });
    agentRunRecorder.finishRun(source.id, "error", "synthetic source failure", { endReason: "execution_error" });
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).agentRuns.find((entry: any) => entry.id === source.id).status).toBe("error"); reloadConfig();
    fixture.profiles.push({ dirId: "ab_retry49", name: "Task49 fake runtime", running: true, cdpPort: 49049 });
    const { retryAgentRun } = await import("../../src/main/services/automation.js");
    const retry = await retryAgentRun(source.id); expect(retry).toMatchObject({ ok: true, runId: expect.any(String) }); expect(retry.runId).not.toBe(source.id);
    const modelToolResults = requests[1].messages.filter((message: any) => message.role === "tool");
    expect(JSON.parse(modelToolResults[0].content)).toEqual({ key: "order", value: null });
    expect(fs.readFileSync(path.join(fixture.dataDir, "agent-files/retry/task49.txt"), "utf8")).toBe("retry needle-49");
    const disk = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(disk.agentRuns.find((entry: any) => entry.id === retry.runId)).toMatchObject({ source: { retryOf: source.id, ruleId: rule.id }, status: "done", verification: { status: "unverified" }, steps: [{ tool: "get_var", ok: true }, { tool: "write_file", ok: true }] });
    reloadConfig();
    expect(agentRunRecorder.listRuns({ dirId: "ab_retry49" }).find((entry) => entry.id === retry.runId)?.source).toMatchObject({ retryOf: source.id });
    expect((await executeToolCall("read_file", { path: "retry/task49.txt" })).content).toContain("needle-49");
  });
});

describe("contract-scoped tool outcomes", () => {
  it.each([
    ["http_request", { skipped: true, reason: "declined", decision: "deny" }, "declined"],
    ["db_exec", { decision: "deny" }, "denied"],
    ["browser_wait_for", { found: false, selector: "#missing" }, "not found"],
    ["browser_wait_for_load", { loaded: false }, "did not finish"],
    ["browser_navigate", { errorText: "net::ERR_FAILED" }, "net::ERR_FAILED"],
    ["browser_click", { error: "element covered" }, "element covered"],
    ["browser_click", { ok: false, message: "not clicked" }, "not clicked"],
    ["browser_type", { success: false }, "unsuccessful"],
    ["http_request", { cancelled: true, reason: "task cancelled" }, "task cancelled"],
    ["agent_browser_stop_profile", { success: false }, "unsuccessful"],
    ["agent_browser_skill_install", { error: "requires member role" }, "requires member"],
    ["unknown_tool", { error: "Unknown tool", code: "UNKNOWN" }, "Unknown tool"],
    ["browser_hover", { error: { message: "failed" } }, "Tool returned an error"],
    ["write_file", { skipped: true }, "skipped"],
    ["write_file", { cancelled: true }, "cancelled"],
  ])("classifies %s operational failure %j without a throw", (name, result, error) => {
    expect(classifyAgentToolOutcome(name as string, result)).toMatchObject({ ok: false, error: expect.stringContaining(error as string) });
  });

  it.each([
    ["browser_evaluate", { value: { error: "business value", ok: false, cancelled: true } }],
    ["http_request", { status: 200, body: '{"error":"business value","success":false}' }],
    ["db_query", { rows: [{ error: "row", skipped: true }], count: 1, truncated: false }],
    ["get_var", { key: "error", value: "cancelled" }],
    ["list_profiles", { profiles: [{ syncStatus: "unknown", error: "diagnostic" }] }],
    ["agent_browser_profile_info", { name: "profile", error: "business diagnostic", status: "unknown" }],
    ["custom_business_record", { id: "record-49", error: "legitimate column", success: false }],
    ["custom_business_record", { skipped: 2, error: "validation tally", value: 49 }],
    ["browser_click", { ok: true, error: "" }],
    ["browser_snapshot", "Error appears as ordinary page text"],
    ["get_var", null],
    ["db_query", [{ error: "not an execution envelope" }]],
  ])("does not mistake %s business data for an execution failure", (name, result) => {
    expect(classifyAgentToolOutcome(name as string, result)).toEqual({ ok: true });
  });

  it("does not accept inherited failure markers", () => {
    expect(classifyAgentToolOutcome("http_request", Object.create({ error: "prototype", skipped: true, cancelled: true, ok: false }))).toEqual({ ok: true });
  });
});
