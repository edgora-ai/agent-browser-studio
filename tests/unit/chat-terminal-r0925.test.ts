// R0925-02 regression: REST /api/agent/chat and MCP agent_browser_agent_chat
// must persist a terminal state that matches the outcome they report.
//   normal reply   -> done/completed
//   provider throw -> error
//   empty reply    -> error/execution_error (previously persisted as done)
//   round limit    -> error/round_limit     (previously persisted as done)
//
// Runs both REAL HTTP servers on ephemeral loopback ports with the REAL run
// recorder + config on a temp userData dir; only the LLM boundary is stubbed.
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(
  os.tmpdir(),
  `agent-browser-chat-terminal-${process.pid}-${Date.now()}`,
);
const REST_TOKEN = "r0925-rest-token-" + process.pid;
const MCP_TOKEN = "r0925-mcp-token-" + process.pid;

const h = vi.hoisted(() => ({
  chat: vi.fn(),
  conversations: new Map<string, any>(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (p: string) => Buffer.from(p, "utf8"),
    decryptString: (e: Buffer) => Buffer.from(e).toString("utf8"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../src/main/services/local-agent.js", () => ({
  getLlmConfig: () => ({ provider: "openai", apiKey: "fixture", model: "fixture" }),
  getOrDetectLlmConfig: () => ({ provider: "openai", apiKey: "fixture", model: "fixture" }),
  redactLlmConfig: (c: any) => c,
  saveLlmConfig: vi.fn(),
  listConversations: () => [...h.conversations.values()],
  createConversation: (title: string) => {
    const conv = { id: "conv_" + (h.conversations.size + 1), title, messages: [] };
    h.conversations.set(conv.id, conv);
    return conv;
  },
  getConversation: (id: string) => h.conversations.get(id) || null,
  deleteConversation: (id: string) => h.conversations.delete(id),
  renameConversation: vi.fn(),
  addMessage: (id: string, role: string, content: string) => {
    const conv = h.conversations.get(id);
    if (conv) conv.messages.push({ role, content });
    return conv;
  },
  repairMessageSequence: (msgs: any[]) => msgs,
  agentChat: (...args: any[]) => h.chat(...args),
  llmChat: vi.fn(),
  executeToolCall: vi.fn(),
  AGENT_TOOLS: [],
  getAccounts: () => [],
  getAccountPassword: () => null,
  addAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  parseAccountsBulkText: () => [],
  bulkAddAccounts: () => [],
  bulkCreateProfilesWithAccounts: () => [],
}));

let rest: typeof import("../../src/main/services/rest-api-server.js");
let mcp: typeof import("../../src/main/services/mcp-server.js");
let recorder: typeof import("../../src/main/services/agent-run-trace.js").agentRunRecorder;
let configManager: typeof import("../../src/main/services/config-manager.js");
let restPort = 0;
let mcpPort = 0;

beforeAll(async () => {
  process.env.AGENT_BROWSER_API_PORT = "0";
  process.env.AGENT_BROWSER_API_TOKEN = REST_TOKEN;
  process.env.AGENT_BROWSER_MCP_PORT = "0";
  process.env.AGENT_BROWSER_MCP_TOKEN = MCP_TOKEN;
  configManager = await import("../../src/main/services/config-manager.js");
  recorder = (await import("../../src/main/services/agent-run-trace.js")).agentRunRecorder;
  rest = await import("../../src/main/services/rest-api-server.js");
  mcp = await import("../../src/main/services/mcp-server.js");
  const restStart = rest.startRestApiServer();
  await restStart.ready;
  restPort = rest.getRestApiPort();
  const mcpStart = mcp.startMcpServer();
  await mcpStart.ready;
  mcpPort = mcp.getMcpPort();
  expect(restPort).toBeGreaterThan(0);
  expect(mcpPort).toBeGreaterThan(0);
}, 30000);

afterAll(async () => {
  await rest.stopRestApiServer();
  await mcp.stopMcpServer();
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
});

beforeEach(() => {
  h.chat.mockReset();
  h.conversations.clear();
});

async function restChat(conversationId: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${restPort}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Browser-Token": REST_TOKEN },
    body: JSON.stringify({ conversationId, message: "probe message" }),
  });
  return { status: res.status, body: await res.json() };
}

async function mcpChat(conversationId: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Browser-Token": MCP_TOKEN },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "agent_browser_agent_chat", arguments: { conversationId, message: "probe message" } },
    }),
  });
  const rpc = await res.json();
  const payload = JSON.parse(rpc.result.content[0].text);
  return { http: res.status, isError: Boolean(rpc.result.isError), payload };
}

function lastRun() {
  const runs = recorder.listRuns();
  expect(runs.length).toBeGreaterThan(0);
  return runs[runs.length - 1];
}

describe("chat terminal state (R0925-02)", () => {
  it("auth: /health public, protected endpoint 401 without token, 200 with token", async () => {
    const pub = await fetch(`http://127.0.0.1:${restPort}/health`);
    expect(pub.status).toBe(200);
    const denied = await fetch(`http://127.0.0.1:${restPort}/api/agent/conversations`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${restPort}/api/agent/conversations`, {
      headers: { "X-Agent-Browser-Token": REST_TOKEN },
    });
    expect(ok.status).toBe(200);
  });

  it("REST: normal reply -> 200 and run done/completed", async () => {
    h.chat.mockResolvedValue({ messages: [{ role: "assistant", content: "hello" }], endReason: "completed" });
    const conv = { id: "c1", title: "t", messages: [] };
    h.conversations.set(conv.id, conv);
    const r = await restChat("c1");
    expect(r.status).toBe(200);
    expect(r.body.reply).toBe("hello");
    const run = recorder.getRun(r.body.runId)!;
    expect(run.status).toBe("done");
    expect(run.endReason).toBe("completed");
  });

  it("REST: provider throw -> 400 and run error (control case)", async () => {
    h.chat.mockRejectedValue(new Error("LLM API error 500"));
    h.conversations.set("c2", { id: "c2", title: "t", messages: [] });
    const r = await restChat("c2");
    expect(r.status).toBe(400);
    const run = recorder.getRun(r.body.runId)!;
    expect(run.status).toBe("error");
  });

  it("REST: empty final reply -> 400 and run error/execution_error, never done", async () => {
    h.chat.mockResolvedValue({ messages: [{ role: "assistant", content: "" }] });
    h.conversations.set("c3", { id: "c3", title: "t", messages: [] });
    const r = await restChat("c3");
    expect(r.status).toBe(400);
    const run = recorder.getRun(r.body.runId)!;
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("execution_error");
    expect(run.error).toContain("final response");
  });

  it("REST: round limit -> 400 and run error/round_limit, never done", async () => {
    h.chat.mockResolvedValue({ messages: [], error: "Max tool-calling rounds reached", endReason: "round_limit" });
    h.conversations.set("c4", { id: "c4", title: "t", messages: [] });
    const r = await restChat("c4");
    expect(r.status).toBe(400);
    const run = recorder.getRun(r.body.runId)!;
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("round_limit");
  });

  it("MCP: normal reply -> success and run done/completed", async () => {
    h.chat.mockResolvedValue({ messages: [{ role: "assistant", content: "mcp hello" }], endReason: "completed" });
    h.conversations.set("c5", { id: "c5", title: "t", messages: [] });
    const r = await mcpChat("c5");
    expect(r.http).toBe(200);
    expect(r.isError).toBe(false);
    const run = recorder.getRun(r.payload.runId)!;
    expect(run.status).toBe("done");
    expect(run.endReason).toBe("completed");
  });

  it("MCP: empty final reply -> isError and run error/execution_error", async () => {
    h.chat.mockResolvedValue({ messages: [{ role: "assistant", content: "" }] });
    h.conversations.set("c6", { id: "c6", title: "t", messages: [] });
    const r = await mcpChat("c6");
    expect(r.isError).toBe(true);
    const run = recorder.getRun(r.payload.runId)!;
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("execution_error");
  });

  it("MCP: round limit -> isError and run error/round_limit", async () => {
    h.chat.mockResolvedValue({ messages: [], error: "Max tool-calling rounds reached", endReason: "round_limit" });
    h.conversations.set("c7", { id: "c7", title: "t", messages: [] });
    const r = await mcpChat("c7");
    expect(r.isError).toBe(true);
    const run = recorder.getRun(r.payload.runId)!;
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("round_limit");
  });

  it("terminal states persist across config reload and stay searchable by runId", async () => {
    h.chat.mockResolvedValue({ messages: [], error: "Max tool-calling rounds reached", endReason: "round_limit" });
    h.conversations.set("c8", { id: "c8", title: "t", messages: [] });
    const r = await restChat("c8");
    configManager.reloadConfig();
    const run = recorder.getRun(r.body.runId)!;
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("round_limit");
    expect(run.verification.status).toBe("unverified");
  });
});
