// J23: Error display. When chat-stream fails, the chat bubble must show the
// real error message — not the "[object Object]" that the old renderer
// produced by string-concatenating the {error:"..."} payload. Also verifies
// a failed run persists an assistant error reply so history stays valid.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j23");
const CONV_FILE = path.join(USERDATA, "agent-conversations.json");

describe("J23 — error is shown as text, not [object Object]", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let convId = "";

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20, chunks: ["unused"] });
    h = await setupTestApp({ userDataDir: USERDATA });
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
    await h.page.waitForTimeout(200);
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("config"));
    await h.page.waitForTimeout(200);
    await h.page.locator("#agent-llm-provider").selectOption("openai");
    await h.page.locator("#agent-llm-apikey").fill("sk-mock");
    await h.page.locator("#agent-llm-model").fill("e2e-mock-model");
    await h.page.locator("#agent-llm-url").fill(mock.url);
    await h.page.locator('[data-cmd="agentSaveConfig"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#agent-config-saved", { state: "visible", timeout: 5000 });
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(200);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.agentActiveConvId, { timeout: 5000 });
    convId = await h.page.evaluate(() => (window as any).agentBrowser.state.agentActiveConvId);
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  });

  it("shows the real error text when the LLM returns a 500", async () => {
    // Next request returns 500 with a recognizable body.
    mock.setNextResponse({
      statusCode: 500,
      body: JSON.stringify({ error: { message: "boom-500-sentinel" } }),
    });
    await h.page.evaluate(() => {
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
    });
    await h.page.locator("#agent-chat-input").fill("hi");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
      if (st.d || st.e) break;
      await h.page.waitForTimeout(200);
    }
    // The stream-error payload must carry the real string.
    const errPayload = await h.page.evaluate(() => (window as any).__err);
    expect(errPayload, "stream-error must fire").toBeTruthy();
    expect(JSON.stringify(errPayload)).toContain("boom-500-sentinel");
    expect(JSON.stringify(errPayload)).not.toContain("[object Object]");

    // The rendered assistant bubble shows the real error, not [object Object].
    const bubble = await h.page.evaluate(() => {
      const nodes = document.querySelectorAll(".chat-bubble-agent");
      return nodes.length ? nodes[nodes.length - 1].textContent : "";
    });
    expect(bubble).toContain("boom-500-sentinel");
    expect(bubble).not.toContain("[object Object]");
  }, 40000);

  it("persists an assistant error reply so the next turn's history is valid", async () => {
    const convs = JSON.parse(fs.readFileSync(CONV_FILE, "utf8"));
    const conv = convs.find((c: any) => c.id === convId);
    const msgs = conv.messages;
    // user, then assistant(error) — strictly alternating, no orphaned user.
    const roles = msgs.map((m: any) => m.role);
    expect(roles[0]).toBe("user");
    expect(roles[roles.length - 1]).toBe("assistant");
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i], `history must alternate: ${roles.join(",")}`).not.toBe(roles[i - 1]);
    }
    const last = msgs[msgs.length - 1];
    expect(last.content).toContain("boom-500-sentinel");
  });

  it("a follow-up message still works (history was not poisoned by the error)", async () => {
    mock.setResponses([{ chunks: ["恢复", "正常。"] }]);
    await h.page.evaluate(() => {
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
    });
    await h.page.locator("#agent-chat-input").fill("再试一次");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
      if (st.d || st.e) break;
      await h.page.waitForTimeout(200);
    }
    const done = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
    expect(done.e, `follow-up errored: ${JSON.stringify(done.e)}`).toBeNull();
    expect(done.d).toBe(true);
  }, 40000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|boom-500-sentinel/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
