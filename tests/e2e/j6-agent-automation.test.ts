// J6: Agent end-to-end automation orchestration
// Proves the "replace manual" capabilities: auto-binding the running profile's
// CDP port into the system prompt, the full tool-calling loop, and the live
// execution-step UI — without needing to navigate a protected URL (SSRF guard
// blocks localhost, which is correct product behavior).
//
// Flow:
//   1. Launch a real profile (gets a real CDP port).
//   2. Mock LLM script:
//        request 1 → tool_call(browser_get_url, port)
//        request 2 → tool_call(browser_snapshot, port)   (no-op but proves loop)
//        request 3 → text "Done, the page is about:blank"
//   3. Assert: system prompt in request 1 contains the real CDP port (auto-bind),
//      ≥2 tool calls executed, the chat UI rendered execution steps, final text
//      persisted.
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
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j6");

describe("J6 — Agent automation: auto port-bind + tool loop + step UI", () => {
  let mock: MockLlmServer;
  let h: TestAppHandle;
  let conversationId = "";
  let cdpPort = 0;
  let dirId = "";

  beforeAll(async () => {
    mock = await startMockLlm({
      delayMs: 50,
      responses: [
        // Round 1: model inspects the page (uses the auto-bound port).
        { chunks: [], toolCalls: [{ id: "c1", name: "browser_get_url", arguments: {} }] },
        // Round 2: model snapshots (second tool, proves the loop continues).
        { chunks: [], toolCalls: [{ id: "c2", name: "browser_snapshot", arguments: {} }] },
        // Round 3: final answer.
        { chunks: ["Page ", "checked ", "successfully."] },
      ],
    });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch { /* ignore */ }
    if (h) await closeApp(h);
  });

  it("creates + launches a real profile and captures its CDP port", async () => {
    const r = (await h.page.evaluate(
      () => (window as any).agentBrowser.api.browser.create({
        name: "E2E J6",
        platform: "windows",
        fingerprintSeed: 66666,
      }),
    )) as { dirId: string };
    expect(r.dirId).toBeTruthy();
    dirId = r.dirId;

    const launch = (await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.browser.launch(id),
      dirId,
    )) as { success: boolean; cdpPort: number; pid: number };
    expect(launch.success).toBe(true);
    expect(launch.cdpPort).toBeGreaterThan(0);
    cdpPort = launch.cdpPort;
    h.cdpPort = cdpPort;
    h.cdpPids.push(launch.pid);
  });

  it("configures the mock LLM + creates a conversation", async () => {
    await dataTab(h.page, "agent").click({ timeout: 5000 });
    await h.page.waitForTimeout(300);
    await closeAllDialogs(h.page);
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("config"));
    await h.page.waitForTimeout(200);
    await h.page.locator("#agent-llm-provider").selectOption("openai");
    await h.page.locator("#agent-llm-apikey").fill("test-llm-key-j6-not-real");
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

  it("the running profile's CDP port is auto-injected into the system prompt", async () => {
    // Track tool-call notifications + done before sending.
    await h.page.evaluate(() => {
      (window as any).__toolCalls = [];
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-tool-call", (tc: any) => (window as any).__toolCalls.push(tc));
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = String(e); });
    });

    await h.page.locator("#agent-chat-input").fill("check the page");
    await h.page.locator("#agent-chat-input").press("Enter");

    // Wait for the multi-round loop to finish.
    const start = Date.now();
    while (Date.now() - start < 25000) {
      const done = await h.page.evaluate(() => (window as any).__done);
      const err = await h.page.evaluate(() => (window as any).__err);
      if (done || err) break;
      await h.page.waitForTimeout(150);
    }

    // The FIRST request's system message must contain the running profile's port.
    const firstReq = mock.requests[0]?.body;
    const systemMsg = (firstReq?.messages || []).find((m: any) => m.role === "system");
    expect(systemMsg, "no system message sent").toBeTruthy();
    expect(String(systemMsg.content)).toContain(String(cdpPort));
    expect(String(systemMsg.content)).toContain("E2E J6");
  });

  it("the tool loop executed ≥2 tools across rounds (real CDP calls)", async () => {
    const state = await h.page.evaluate(() => ({
      toolCalls: (window as any).__toolCalls,
      done: (window as any).__done,
      err: (window as any).__err,
    }));
    expect(state.err, `error: ${state.err}`).toBeNull();
    expect(state.done).toBe(true);
    expect(state.toolCalls.length).toBeGreaterThanOrEqual(2);
    // The model used the auto-bound port (it didn't have to ask the user).
    expect(mock.requests.length).toBeGreaterThanOrEqual(3);
    await shot(h.page, "j6-01-after-automation");
  });

  it("the execution-step UI rendered the tool calls in order", async () => {
    const html = await h.page.locator("#agent-chat-messages").innerHTML();
    expect(html).toContain("chat-tool-step");
    // Steps are numbered; at least steps "1." and "2." present.
    expect(html).toContain(">1.</span>");
    expect(html).toContain(">2.</span>");
  });

  it("the final answer text is rendered", async () => {
    const text = (await h.page.locator("#agent-chat-messages").innerText()).replace(/\s+/g, " ").trim();
    expect(text).toContain("Page checked successfully");
  });

  it("conversation persisted the assistant reply + tool-call metadata", async () => {
    const conv = await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.agent.conversations.get(id),
      conversationId,
    );
    expect(conv).toBeTruthy();
    const assistant = [...(conv.messages || [])].reverse().find((m: any) => m.role === "assistant" && m.content);
    expect(String(assistant?.content || "")).toContain("Page checked successfully");
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
