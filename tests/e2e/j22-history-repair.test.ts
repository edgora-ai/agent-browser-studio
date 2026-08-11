// J22: Poisoned history repair. A prior failed run leaves consecutive user
// messages in a conversation (no assistant reply between them). The next
// message used to build a request with back-to-back user turns, which
// Claude-format proxy backends reject. repairMessageSequence must collapse
// them before send. This test seeds that corruption on disk and proves the
// real chat-stream path repairs it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j22");
const CONV_FILE = path.join(USERDATA, "agent-conversations.json");

describe("J22 — poisoned history (consecutive user turns) is repaired", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let convId = "";

  beforeAll(async () => {
    // Mock gives a plain text answer (no tools) for the repaired request.
    mock = await startMockLlm({ delayMs: 20, responses: [{ chunks: ["好的", "，已收到。"] }] });
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

  it("seeds the conversation with consecutive user turns (failed-run state)", async () => {
    const convs = JSON.parse(fs.readFileSync(CONV_FILE, "utf8"));
    const conv = convs.find((c: any) => c.id === convId);
    expect(conv, "conversation must exist on disk").toBeTruthy();
    // Simulate 3 failed retries that each wrote only a user message.
    conv.messages = [
      { role: "user", content: "第一次提问", timestamp: Date.now() - 3000 },
      { role: "user", content: "第二次提问", timestamp: Date.now() - 2000 },
      { role: "user", content: "第三次提问", timestamp: Date.now() - 1000 },
    ];
    fs.writeFileSync(CONV_FILE, JSON.stringify(convs, null, 2));
  });

  it("sends a new message and the run completes despite the poisoned history", async () => {
    await h.page.evaluate(() => {
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
    });
    await h.page.locator("#agent-chat-input").fill("继续");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
      if (st.d || st.e) break;
      await h.page.waitForTimeout(200);
    }
    const done = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
    expect(done.e, `stream error: ${JSON.stringify(done.e)}`).toBeNull();
    expect(done.d).toBe(true);
  }, 40000);

  it("the request body sent to the LLM has no consecutive same-role messages", async () => {
    const msgs = mock.requests[0]?.body?.messages as any[];
    expect(msgs, "a request must have been captured").toBeTruthy();
    const roles = msgs.filter((m) => m.role !== "system").map((m) => m.role);
    // No two adjacent roles equal.
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i], `consecutive same-role at ${i}: ${roles.join(",")}`).not.toBe(roles[i - 1]);
    }
    // The 3 seeded user turns were collapsed into one merged user message.
    const userMsg = msgs.find((m) => m.role === "user");
    expect(userMsg.content).toContain("第一次提问");
    expect(userMsg.content).toContain("第三次提问");
  });

  it("the run is persisted as done", async () => {
    const run = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const list = await api.agentRuns.list();
      return api.agentRuns.get(list[0].id);
    });
    expect(run.status).toBe("done");
  });

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
