// J84: Agent MCP tools (Slice 62). The MCP server now exposes conversation
// management, one-shot chat, tool-calling chat, run traces and the LLM
// config over MCP, so external AI can drive the local agent without the
// REST/UI surface. Connects to the running app's loopback MCP server with
// the revealed token.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j84");

function mcpCall(port: number, token: string, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request({
      hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + token,
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function toolResult(res: any): any {
  const text = res?.result?.content?.[0]?.text || "";
  try { return JSON.parse(text); } catch { return {}; }
}

describe("J84 — Agent tools over MCP", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let token = "";
  let port = 0;

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20, chunks: ["MCP reply."] });
    h = await setupTestApp({ userDataDir: USERDATA });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.mcp.status());
      if (st.running) { port = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(port, "MCP server must be running").toBeGreaterThan(0);
    const tok = await h.page.evaluate(() => (window as any).agentBrowser.api.mcp.revealToken());
    token = tok.token;
    expect(token, "MCP token must be available").toBeTruthy();
  }, 60000);
  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  }, 90000);

  it("tools/list includes the agent chat/conversation/run/config tools", async () => {
    const res = await mcpCall(port, token, "tools/list", {});
    const names = (res.result?.tools || []).map((t: any) => t.name);
    for (const n of [
      "agent_browser_agent_chat",
      "agent_browser_agent_chat_simple",
      "agent_browser_conversations_list",
      "agent_browser_conversation_create",
      "agent_browser_conversation_get",
      "agent_browser_agent_run_get",
      "agent_browser_llm_config",
    ]) {
      expect(names).toContain(n);
    }
  }, 20000);

  it("reads LLM config and manages conversations over MCP", async () => {
    const cfg = await mcpCall(port, token, "tools/call", { name: "agent_browser_llm_config", arguments: {} });
    expect(cfg.result?.isError).toBeFalsy();
    expect(toolResult(cfg).config).toBeNull();

    const created = await mcpCall(port, token, "tools/call", {
      name: "agent_browser_conversation_create", arguments: { title: "J84 mcp" },
    });
    expect(created.result?.isError).toBeFalsy();
    const conv = toolResult(created).conversation;
    expect(conv.id).toMatch(/^conv_/);
    expect(conv.title).toBe("J84 mcp");
    const convId = conv.id;

    const list = await mcpCall(port, token, "tools/call", { name: "agent_browser_conversations_list", arguments: {} });
    const conversations = toolResult(list).conversations || [];
    expect(conversations.some((c: any) => c.id === convId)).toBe(true);

    const got = await mcpCall(port, token, "tools/call", {
      name: "agent_browser_conversation_get", arguments: { conversationId: convId },
    });
    expect(got.result?.isError).toBeFalsy();
    expect(toolResult(got).conversation.id).toBe(convId);
    expect(Array.isArray(toolResult(got).conversation.messages)).toBe(true);

    const missing = await mcpCall(port, token, "tools/call", {
      name: "agent_browser_conversation_get", arguments: { conversationId: "conv_missing" },
    });
    expect(missing.result?.isError).toBe(true);
  }, 30000);

  it("saves LLM config and runs one-shot chat over MCP", async () => {
    await h.page.evaluate((apiUrl: string) => (window as any).agentBrowser.api.agent.saveLlmConfig({
      provider: "openai",
      apiKey: "sk-j84",
      model: "e2e-mock-model",
      apiUrl,
    }), mock.url);

    const cfg = await mcpCall(port, token, "tools/call", { name: "agent_browser_llm_config", arguments: {} });
    const config = toolResult(cfg).config;
    expect(config.hasApiKey).toBe(true);
    expect(config.apiKey).toBeUndefined();

    const chat = await mcpCall(port, token, "tools/call", {
      name: "agent_browser_agent_chat_simple",
      arguments: { messages: [{ role: "user", content: "hello from mcp" }] },
    });
    expect(chat.result?.isError).toBeFalsy();
    expect(toolResult(chat).reply).toBe("MCP reply.");
  }, 30000);

  it("runs conversation-scoped tool-calling chat and reads the run trace", async () => {
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "m1", name: "set_var", arguments: { key: "mcp_probe", value: "ok" } }] },
      { chunks: ["MCP ", "tool ", "answer."] },
    ]);
    const created = await mcpCall(port, token, "tools/call", {
      name: "agent_browser_conversation_create", arguments: { title: "J84 tool chat" },
    });
    const convId = toolResult(created).conversation.id;

    const chat = await mcpCall(port, token, "tools/call", {
      name: "agent_browser_agent_chat",
      arguments: { conversationId: convId, message: "run a tool then answer" },
    });
    expect(chat.result?.isError).toBeFalsy();
    const r = toolResult(chat);
    expect(r.reply).toBe("MCP tool answer.");
    expect(r.toolCalls.length).toBeGreaterThan(0);
    expect(r.toolCalls[0].name).toBe("set_var");
    expect(r.toolCalls[0].redacted).toBe(true);
    expect(r.runId).toMatch(/^run_/);

    const run = await mcpCall(port, token, "tools/call", {
      name: "agent_browser_agent_run_get", arguments: { runId: r.runId },
    });
    expect(run.result?.isError).toBeFalsy();
    const runData = toolResult(run).run;
    expect(runData.status).toBe("done");
    expect(runData.steps.some((s: any) => s.tool === "set_var")).toBe(true);

    const got = await mcpCall(port, token, "tools/call", {
      name: "agent_browser_conversation_get", arguments: { conversationId: convId },
    });
    const msgs = toolResult(got).conversation.messages || [];
    expect(msgs.some((m: any) => m.role === "assistant" && m.content.includes("MCP tool answer."))).toBe(true);
  }, 40000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});

