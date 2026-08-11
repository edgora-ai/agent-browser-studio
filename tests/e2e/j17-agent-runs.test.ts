// J17: Agent Run trace — http_request → set_var → write_file → read_file produces
// an inspectable, persistent run with steps + variables. Verifies the whole
// Phase 1-6 backend + IPC + preload.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import { _electron as electron } from "playwright";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j17");

// Mock external API server returning JSON.
let apiServer: http.Server;
let apiUrl = "";

describe("J17 — Agent Run trace (http + vars + files)", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let conversationId = "";

  beforeAll(async () => {
    apiServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, orderId: "ORD-98765", items: 3 }));
    });
    await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", r));
    apiUrl = `http://127.0.0.1:${(apiServer.address() as any).port}/order`;

    mock = await startMockLlm({
      delayMs: 40,
      responses: [
        { chunks: [], toolCalls: [{ id: "c1", name: "http_request", arguments: { method: "GET", url: apiUrl } }] },
        { chunks: [], toolCalls: [{ id: "c2", name: "set_var", arguments: { key: "order_id", value: "ORD-98765" } }] },
        { chunks: [], toolCalls: [{ id: "c3", name: "write_file", arguments: { path: "j17/out.json", content: "saved" } }] },
        { chunks: [], toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "j17/out.json" } }] },
        { chunks: ["Done ", "processing ", "order."] },
      ],
    });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    try { if (apiServer) await new Promise<void>((r) => apiServer.close(() => r())); } catch {}
    if (h) await closeApp(h);
  });

  it("configures mock LLM + creates conversation", async () => {
    // Navigate to agent config and set the mock.
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
    conversationId = await h.page.evaluate(() => (window as any).agentBrowser.state.agentActiveConvId);
    expect(conversationId).toBeTruthy();
  });

  it("runs an agent task that calls http/set_var/write/read", async () => {
    // Track run-step live events.
    await h.page.evaluate(() => {
      (window as any).__steps = [];
      (window as any).__done = false;
      const api = (window as any).agentBrowser.api;
      api.on("agent:run-step", (p: any) => (window as any).__steps.push(p));
      api.on("agent:stream-done", () => { (window as any).__done = true; });
    });

    await h.page.locator("#agent-chat-input").fill("process the order");
    await h.page.locator("#agent-chat-input").press("Enter");

    const start = Date.now();
    while (Date.now() - start < 30000) {
      const done = await h.page.evaluate(() => (window as any).__done);
      if (done) break;
      await h.page.waitForTimeout(200);
    }
    const liveSteps = await h.page.evaluate(() => (window as any).__steps);
    // We should have received run-step events for each tool.
    const toolNames = liveSteps.filter((s: any) => s.step).map((s: any) => s.step.tool);
    console.log(`[j17] live step tools: ${JSON.stringify(toolNames)}`);
    expect(toolNames).toContain("http_request");
    expect(toolNames).toContain("set_var");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("read_file");
  }, 40000);

  it("the run is persisted with steps + variables + source=chat", async () => {
    const result = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const list = await api.agentRuns.list();
      // Find the run from this conversation.
      const summary = list.find((r: any) => r.source?.type === "chat" && r.source?.conversationId);
      if (!summary) return { found: false, listLen: list.length };
      const run = await api.agentRuns.get(summary.id);
      return { found: true, run };
    });
    expect(result.found, `run not found (list len ${result.listLen})`).toBe(true);
    const run = result.run;
    console.log(`[j17] run ${run.id} status=${run.status} steps=${run.steps.length} vars=${JSON.stringify(run.variables)}`);
    expect(run.status).toBe("done");
    expect(run.source.type).toBe("chat");
    const tools = run.steps.map((s: any) => s.tool);
    expect(tools).toContain("http_request");
    expect(tools).toContain("set_var");
    expect(tools).toContain("write_file");
    expect(tools).toContain("read_file");
    // Variable presence is visible, but values are redacted in public run views.
    expect(run.variables.order_id).toBe("[REDACTED:9B]");
    // Local/private HTTP targets are blocked before connection and do not expose response bodies.
    const httpStep = run.steps.find((s: any) => s.tool === "http_request");
    const body = typeof httpStep.result === "string" ? httpStep.result : JSON.stringify(httpStep.result);
    expect(body).toContain("local/private IP addresses is not allowed");
    expect(body).not.toContain("ORD-98765");
  });

  it("Runs tab renders the run in the list", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("runs"));
    await h.page.waitForTimeout(500);
    await h.page.evaluate(() => (window as any).agentBrowser.loadRunsTab());
    await h.page.waitForTimeout(500);
    const count = await h.page.evaluate(() => {
      return document.querySelectorAll("#agent-run-list [data-run-id]").length;
    });
    expect(count, "Runs tab should list at least one run").toBeGreaterThanOrEqual(1);
  });

  it("run detail dialog renders steps + variables", async () => {
    const firstRunId = await h.page.evaluate(() => {
      const card = document.querySelector("#agent-run-list [data-run-id]");
      return card ? card.getAttribute("data-run-id") : null;
    });
    expect(firstRunId).toBeTruthy();
    await h.page.evaluate((id: string) => (window as any).agentBrowser.runsOpen(id), firstRunId);
    await h.page.waitForTimeout(500);
    const stepCount = await h.page.evaluate(() => document.querySelectorAll("#agent-run-steps .run-step").length);
    expect(stepCount).toBeGreaterThanOrEqual(4);
    const hasVar = await h.page.evaluate(() => document.getElementById("agent-run-vars").textContent);
    expect(hasVar).toContain("order_id");
  });

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
