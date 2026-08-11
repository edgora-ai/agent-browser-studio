// J21: Parallel tool calls — the model emitting several tool_calls in ONE
// assistant turn used to break the loop on Claude-format proxy backends
// ("tool_use ids found without tool_result" 400). This test proves:
//   (1) the loop executes every tool_call and feeds a tool_result back for each;
//   (2) the request body now carries parallel_tool_calls:false (the fix);
//   (3) the run finishes "done" with no error.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j21");

describe("J21 — parallel tool calls in one assistant turn", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    mock = await startMockLlm({
      delayMs: 20,
      responses: [
        // Request 0: model emits THREE tool calls in a single assistant turn.
        {
          chunks: [],
          toolCalls: [
            { id: "p1", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS par (id INTEGER PRIMARY KEY, v TEXT)" } },
            { id: "p2", name: "db_exec", arguments: { sql: "INSERT INTO par (v) VALUES (?)", params: ["a"] } },
            { id: "p3", name: "set_var", arguments: { key: "who", value: "parallel" } },
          ],
        },
        // Request 1: final answer text.
        { chunks: ["已", "完成", "并行任务。"] },
      ],
    });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  });

  it("configures mock LLM + creates conversation", async () => {
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
  });

  it("executes all 3 parallel tool calls and finishes the run", async () => {
    await h.page.evaluate(() => {
      (window as any).__steps = [];
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:run-step", (p: any) => (window as any).__steps.push(p));
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
    });
    await h.page.locator("#agent-chat-input").fill("做三件事");
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

    // All 3 tool calls ran.
    const tools = (await h.page.evaluate(() => (window as any).__steps))
      .filter((s: any) => s.step).map((s: any) => s.step.tool);
    expect(tools).toEqual(["db_exec", "db_exec", "set_var"]);
  }, 40000);

  it("the request disabled parallel tool calls and fed back 3 tool results", async () => {
    // Inspect the captured request bodies.
    const req0 = mock.requests[0]?.body;
    const req1 = mock.requests[1]?.body;
    expect(req0, "first request must have been captured").toBeTruthy();
    expect(req0.parallel_tool_calls).toBe(false);
    // Round 2's messages must include the 3 tool_result messages for p1/p2/p3.
    expect(req1, "second request must have been captured").toBeTruthy();
    const toolMsgs = (req1.messages as any[]).filter((m) => m.role === "tool");
    const ids = toolMsgs.map((m) => m.tool_call_id).sort();
    expect(ids).toEqual(["p1", "p2", "p3"]);
  });

  it("the run is persisted as done with 3 steps + the variable", async () => {
    const run = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const list = await api.agentRuns.list();
      return api.agentRuns.get(list[0].id);
    });
    expect(run.status).toBe("done");
    expect(run.steps.map((s: any) => s.tool)).toEqual(["db_exec", "db_exec", "set_var"]);
    // Variable values are redacted in public run views; the key presence proves set_var ran.
    expect(Object.keys(run.variables || {})).toContain("who");
    expect(run.variables.who).toBe("[REDACTED:8B]");
  });

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
