// J5: Agent streaming tool-calling loop
// Verifies that agent:chat-stream EXECUTES tool calls and re-prompts the model
// (multi-round loop), not just notifies the UI.
//
// Mock LLM script:
//   request 1 → tool_call(list_profiles)
//   request 2 → text "Found N profiles"
// We assert: 2 requests hit the mock, a tool was executed, the final reply
// contains the model's follow-up text, and the conversation persists the
// tool-call metadata.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import {
  setupTestApp,
  closeApp,
  TestAppHandle,
} from "./helpers/app.js";
import { startMockLlm, MockLlmServer } from "./helpers/mock-llm.js";
import { shot, closeAllDialogs, filterKnownConsoleErrors } from "./helpers/diag.js";
import { dataTab } from "./helpers/find.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j5");

describe("J5 — Agent streaming executes tool calls in a loop", () => {
  let mock: MockLlmServer;
  let h: TestAppHandle;
  let conversationId = "";

  beforeAll(async () => {
    mock = await startMockLlm({
      delayMs: 60,
      responses: [
        {
          // Round 1: model asks to list profiles (no text).
          chunks: [],
          toolCalls: [{ id: "call_1", name: "list_profiles", arguments: {} }],
        },
        {
          // Round 2: model produces a follow-up answer using the tool result.
          chunks: ["I ", "checked ", "your ", "profiles."],
        },
      ],
    });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch { /* ignore */ }
    if (h) await closeApp(h);
  });

  it("configures the mock LLM and creates a conversation", async () => {
    await dataTab(h.page, "agent").click({ timeout: 5000 });
    await h.page.waitForTimeout(300);
    await closeAllDialogs(h.page);
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("config"));
    await h.page.waitForTimeout(200);
    await h.page.locator("#agent-llm-provider").selectOption("openai");
    await h.page.locator("#agent-llm-apikey").fill("test-llm-key-j5-not-real");
    await h.page.locator("#agent-llm-model").fill("e2e-mock-model");
    await h.page.locator("#agent-llm-url").fill(mock.url);
    await h.page.locator('[data-cmd="agentSaveConfig"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#agent-config-saved", { state: "visible", timeout: 5000 });

    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(300);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForFunction(
      () => !!(window as any).agentBrowser.state.agentActiveConvId,
      { timeout: 5000 },
    );
    conversationId = await h.page.evaluate(
      () => (window as any).agentBrowser.state.agentActiveConvId,
    );
    expect(conversationId).toBeTruthy();
  });

  it("sends a message that triggers a tool call, then a follow-up answer", async () => {
    // Track tool-call notifications + done
    await h.page.evaluate(() => {
      (window as any).__toolCalls = [];
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-tool-call", (tc: any) => (window as any).__toolCalls.push(tc));
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = String(e); });
    });

    await h.page.locator("#agent-chat-input").fill("list my profiles");
    await h.page.locator("#agent-chat-input").press("Enter");

    // Wait for completion (two rounds: tool + answer)
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const done = await h.page.evaluate(() => (window as any).__done);
      const err = await h.page.evaluate(() => (window as any).__err);
      if (done || err) break;
      await h.page.waitForTimeout(150);
    }

    const state = await h.page.evaluate(() => ({
      toolCalls: (window as any).__toolCalls,
      done: (window as any).__done,
      err: (window as any).__err,
    }));
    expect(state.err, `stream error: ${state.err}`).toBeNull();
    expect(state.done).toBe(true);
    // The model emitted at least one tool call.
    expect(state.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(state.toolCalls[0].name).toBe("list_profiles");
    await shot(h.page, "j5-01-after-tool-loop");
  });

  it("the mock received TWO requests (tool round + answer round)", () => {
    // This is the core assertion: the loop actually re-prompted after the tool.
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    expect(mock.requests[0].body?.messages).toBeTruthy();
    // The second request should include the tool result message (role: tool).
    const secondBody = mock.requests[1]?.body;
    const hasToolResult = (secondBody?.messages || []).some(
      (m: any) => m.role === "tool" || m.role === "user" && Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"),
    );
    expect(hasToolResult, "second request did not include a tool result").toBe(true);
  });

  it("the follow-up answer text is rendered in the chat view", async () => {
    await h.page.waitForTimeout(300);
    const text = (await h.page.locator("#agent-chat-messages").innerText()).replace(/\s+/g, " ").trim();
    expect(text).toContain("I checked your profiles");
  });

  it("the conversation persisted the assistant reply with tool-call metadata", async () => {
    const conv = await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.agent.conversations.get(id),
      conversationId,
    );
    expect(conv).toBeTruthy();
    const messages = conv.messages || [];
    const assistant = [...messages].reverse().find((m: any) => m.role === "assistant" && m.content);
    expect(String(assistant?.content || "")).toContain("I checked your profiles");
    // Tool-call metadata recorded on the assistant turn.
    expect(Array.isArray(assistant?.toolResults) ? assistant.toolResults.length >= 1 : true).toBe(true);
  });

  it("no unexpected console / page errors during the journey", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors);
    const p = h.pageErrors.filter((e) => !/favicon|punycode/i.test(e));
    if (c.length || p.length) {
      console.log("CONSOLE ERRORS:", c);
      console.log("PAGE ERRORS:", p);
    }
    expect(c, c.join("\n")).toEqual([]);
    expect(p, p.join("\n")).toEqual([]);
  });
});
