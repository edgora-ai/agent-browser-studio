// J4: Agent LLM config → chat → stream → persistence
// Start mock OpenAI SSE server → configure via UI → create conv → send →
// assert >=3 chunk events + full text rendered → reload app → conversation persists.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import {
  setupTestApp,
  closeApp,
  TestAppHandle,
  userDataConfigPath,
} from "./helpers/app.js";
import { startMockLlm, MockLlmServer } from "./helpers/mock-llm.js";
import { shot, closeAllDialogs, filterKnownConsoleErrors } from "./helpers/diag.js";
import { dataTab, clickCmd } from "./helpers/find.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j4");

const CHUNKS = ["Hello", " from", " mock", " LLM."];
const EXPECTED_FULL = "Hello from mock LLM.";

describe("J4 — Agent config + chat stream + persistence", () => {
  let mock: MockLlmServer;
  let h: TestAppHandle;
  let conversationId = "";

  beforeAll(async () => {
    mock = await startMockLlm({ chunks: CHUNKS, delayMs: 80 });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch (_) { /* ignore */ }
    if (h) await closeApp(h);
  });

  it("configures the mock LLM endpoint via the Agent config UI", async () => {
    await dataTab(h.page, "agent").click({ timeout: 5000 });
    await h.page.waitForTimeout(300);
    await closeAllDialogs(h.page);
    // Open config sub-view via the app router (avoids ambiguous button matches)
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("config"));
    await h.page.waitForTimeout(200);

    await h.page.locator("#agent-llm-provider").selectOption("openai");
    await h.page.locator("#agent-llm-apikey").fill("test-llm-key-j4-not-real");
    await h.page.locator("#agent-llm-model").fill("e2e-mock-model");
    await h.page.locator("#agent-llm-url").fill(mock.url);
    await h.page.locator('[data-cmd="agentSaveConfig"]').click({ timeout: 5000 });

    // Wait for saved indicator
    await h.page.waitForSelector("#agent-config-saved", { state: "visible", timeout: 5000 });
    await shot(h.page, "j4-01-configured");

    // Verify config persisted to config.json on disk
    const cfgRaw = require("node:fs").readFileSync(userDataConfigPath(USERDATA), "utf8");
    const cfg = JSON.parse(cfgRaw);
    const agent = cfg.agent || cfg.llm || {};
    expect(agent.provider === "openai" || cfg.agent?.provider === "openai").toBe(true);
  });

  it("creates a new conversation", async () => {
    // Switch to chat via the app's own router (avoids ambiguous "Back" buttons)
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(300);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    // Wait for the async create() to populate agentActiveConvId
    await h.page.waitForFunction(
      () => !!(window as any).agentBrowser.state.agentActiveConvId,
      { timeout: 5000 },
    );
    conversationId = await h.page.evaluate(
      () => (window as any).agentBrowser.state.agentActiveConvId,
    );
    expect(conversationId, "no active conversation id").toBeTruthy();
    await shot(h.page, "j4-02-new-conv");
  });

  it("sends a message and receives >=3 streamed chunk events", async () => {
    // Install page-side chunk counter before sending
    await h.page.evaluate(() => {
      const api = (window as any).agentBrowser.api;
      (window as any).__e2eChunks = [];
      (window as any).__e2eDone = false;
      (window as any).__e2eErr = null;
      (window as any).__chunkCb = (payload: any) => {
        (window as any).__e2eChunks.push(typeof payload === "string" ? payload : payload?.text);
      };
      (window as any).__doneCb = () => { (window as any).__e2eDone = true; };
      (window as any).__errCb = (e: any) => { (window as any).__e2eErr = String(e); };
      api.on("agent:stream-chunk", (window as any).__chunkCb);
      api.on("agent:stream-done", (window as any).__doneCb);
      api.on("agent:stream-error", (window as any).__errCb);
    });

    await h.page.locator("#agent-chat-input").fill("hi");
    await h.page.locator("#agent-chat-input").press("Enter");

    // Poll until done (or error)
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const done = await h.page.evaluate(() => (window as any).__e2eDone);
      const err = await h.page.evaluate(() => (window as any).__e2eErr);
      if (done || err) break;
      await h.page.waitForTimeout(150);
    }

    const state = await h.page.evaluate(() => ({
      chunks: (window as any).__e2eChunks,
      done: (window as any).__e2eDone,
      err: (window as any).__e2eErr,
    }));
    expect(state.err, `stream error: ${state.err}`).toBeNull();
    expect(state.done).toBe(true);
    expect(state.chunks.length, `got chunks: ${JSON.stringify(state.chunks)}`).toBeGreaterThanOrEqual(3);
    await shot(h.page, "j4-03-streamed");
  });

  it("second send does not pollute the first assistant bubble (streamId correlation)", async () => {
    // Send a second message; the first assistant bubble must stay intact.
    await h.page.evaluate(() => {
      const api = (window as any).agentBrowser.api;
      (window as any).__e2eChunks2 = [];
      (window as any).__e2eDone2 = false;
      (window as any).__e2eErr2 = null;
      api.on("agent:stream-chunk", (payload: any) => {
        if (payload && (window as any).__e2eChunks2) (window as any).__e2eChunks2.push(payload?.text);
      });
      api.on("agent:stream-done", () => { (window as any).__e2eDone2 = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__e2eErr2 = String(e?.error ?? e); });
    });

    // Snapshot bubble count before the second send.
    const beforeCount = await h.page.evaluate(() => document.querySelectorAll("#agent-chat-messages .chat-msg-agent").length);

    await h.page.locator("#agent-chat-input").fill("second message");
    await h.page.locator("#agent-chat-input").press("Enter");

    const start = Date.now();
    while (Date.now() - start < 15000) {
      const done = await h.page.evaluate(() => (window as any).__e2eDone2);
      const err = await h.page.evaluate(() => (window as any).__e2eErr2);
      if (done || err) break;
      await h.page.waitForTimeout(150);
    }
    const st = await h.page.evaluate(() => ({
      done: (window as any).__e2eDone2,
      err: (window as any).__e2eErr2,
      chunks: (window as any).__e2eChunks2,
    }));
    expect(st.err, `second stream error: ${st.err}`).toBeNull();
    expect(st.done).toBe(true);
    expect(st.chunks.length).toBeGreaterThanOrEqual(3);

    // The first message's text must still be present (not overwritten), and
    // the agent bubble count must have grown by exactly one more reply.
    const text = (await h.page.locator("#agent-chat-messages").innerText()).replace(/\s+/g, " ").trim();
    expect(text).toContain(EXPECTED_FULL);
    const afterCount = await h.page.evaluate(() => document.querySelectorAll("#agent-chat-messages .chat-msg-agent").length);
    // At least the first reply + this reply; the previous test's reply is still there.
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount + 1);
  });

  it("full assistant text is rendered in the chat view", async () => {
    await h.page.waitForTimeout(300);
    const text = (await h.page.locator("#agent-chat-messages").innerText()).replace(/\s+/g, " ").trim();
    expect(text).toContain(EXPECTED_FULL);
  });

  it("the mock LLM received a request containing 'hi'", () => {
    expect(mock.requests.length).toBeGreaterThanOrEqual(1);
    const hiReq = mock.requests.find((r: any) => {
      const messages = r?.body?.messages || r?.body?.input?.messages || [];
      return messages.some((m: any) => m.role === "user" && String(m.content || "").includes("hi"));
    });
    expect(hiReq, "no mock request contained 'hi'").toBeTruthy();
  });

  it("conversation + full assistant reply persists after app restart", async () => {
    // Remember the conversation id and verify it was persisted to disk BEFORE restart
    const persistedId = conversationId;
    const conversationsFile = require("node:fs")
      .readFileSync(require("node:path").join(USERDATA, "agent-conversations.json"), "utf8");
    const persistedBefore = JSON.parse(conversationsFile) as Array<any>;
    const before = persistedBefore.find((c) => c.id === persistedId);
    expect(before, `conv ${persistedId} not on disk before restart; file had ${persistedBefore.map((c) => c.id).join(",")}`).toBeTruthy();
    expect(
      (before?.messages || []).some((m: any) => m.role === "assistant" && String(m.content).includes(EXPECTED_FULL)),
      `assistant message not persisted; messages: ${JSON.stringify(before?.messages)}`,
    ).toBe(true);

    // Close + relaunch with the SAME userData (do NOT wipe it)
    await closeApp(h);
    h = await setupTestApp({ userDataDir: USERDATA, resetUserData: false });
    await dataTab(h.page, "agent").click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    await closeAllDialogs(h.page);

    const conv = await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.agent.conversations.get(id),
      persistedId,
    );
    expect(conv, "conversation not found after restart").toBeTruthy();
    expect(conv.id).toBe(persistedId);
    const messages = conv.messages || [];
    const assistantTurn = [...messages].reverse().find((m: any) => m.role === "assistant");
    expect(
      String(assistantTurn?.content || ""),
      `assistant content: ${JSON.stringify(assistantTurn)}`,
    ).toContain(EXPECTED_FULL);
    await shot(h.page, "j4-04-persisted");
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
