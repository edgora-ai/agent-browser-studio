// J24: Approval gate semantics — "always" caches by signature (a second
// identical DROP skips the prompt), "once" re-prompts every time. J18 already
// covers "deny". Distinct table names keep the module-level alwaysAllowed set
// from bleeding between sub-tests.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j24");

async function configureMock(h: TestAppHandle, mock: { url: string }) {
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
}

async function newConversation(h: TestAppHandle) {
  await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
  await h.page.waitForTimeout(200);
  await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
  await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.agentActiveConvId, { timeout: 5000 });
}

// Watch for approvals and resolve each that appears with `mode`, until the
// stream finishes. Returns the total number of prompts that fired.
async function runApproving(h: TestAppHandle, message: string, mode: "once" | "always", expectedPrompts: number) {
  await h.page.evaluate((m) => {
    (window as any).__approvals = [];
    (window as any).__done = false;
    (window as any).__err = null;
    const api = (window as any).agentBrowser.api;
    api.on("agent:approval-request", (req: any) => (window as any).__approvals.push(req));
    api.on("agent:stream-done", () => { (window as any).__done = true; });
    api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
  }, mode);
  await h.page.locator("#agent-chat-input").fill(message);
  await h.page.locator("#agent-chat-input").press("Enter");
  const start = Date.now();
  while (Date.now() - start < 40000) {
    const st = await h.page.evaluate((m) => {
      // Resolve any pending approval with the chosen mode.
      if ((window as any).__approvals && (window as any).agentBrowser.state) {
        // The renderer's own listener already set currentRequest; use its helper.
      }
      return { d: (window as any).__done, e: (window as any).__err, n: (window as any).__approvals.length };
    }, mode);
    // Resolve pending approvals via the dialog helper (resolves + closes modal).
    await h.page.evaluate((m) => {
      if ((window as any).agentBrowser.approvalAllow && document.getElementById("dlg-approval").open) {
        (window as any).agentBrowser.approvalAllow(m);
      }
    }, mode);
    if (st.d || st.e) break;
    await h.page.waitForTimeout(150);
  }
  return h.page.evaluate(() => ({
    done: (window as any).__done,
    err: (window as any).__err,
    count: (window as any).__approvals.length,
    approvals: (window as any).__approvals,
  }));
}

describe("J24 — approval always/once semantics", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20 });
    h = await setupTestApp({ userDataDir: USERDATA });
    await configureMock(h, mock);
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  });

  it("always: a second identical DROP is auto-allowed without prompting", async () => {
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "a1", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS t_always (id INTEGER)" } }] },
      { chunks: [], toolCalls: [{ id: "a2", name: "db_exec", arguments: { sql: "DROP TABLE t_always" } }] },
      { chunks: [], toolCalls: [{ id: "a3", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS t_always (id INTEGER)" } }] },
      { chunks: [], toolCalls: [{ id: "a4", name: "db_exec", arguments: { sql: "DROP TABLE t_always" } }] },
      { chunks: ["完成"] },
    ]);
    await newConversation(h);
    const result = await runApproving(h, "建表后两次删除", "always", 1);
    expect(result.err, `error: ${JSON.stringify(result.err)}`).toBeNull();
    expect(result.done).toBe(true);
    // Only the FIRST DROP prompted; the second was auto-allowed by signature.
    // Dedupe by approval id — each api.on() call adds a listener that pushes
    // to __approvals, so across sub-tests the same prompt may be counted twice.
    const alwaysIds = new Set(result.approvals.map((a: any) => a.id));
    expect(alwaysIds.size, `expected 1 prompt, got ${alwaysIds.size}`).toBe(1);
    expect(result.approvals[0].category).toBe("db-destroy");
    // Table is gone after both DROPs.
    const exists = await h.page.evaluate(async () => {
      const tables = await (window as any).agentBrowser.api.agentDb.tables();
      return tables.some((t: any) => t.name === "t_always");
    });
    expect(exists).toBe(false);
  }, 60000);

  it("once: every DROP re-prompts (the decision is not cached)", async () => {
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "b1", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS t_once (id INTEGER)" } }] },
      { chunks: [], toolCalls: [{ id: "b2", name: "db_exec", arguments: { sql: "DROP TABLE t_once" } }] },
      { chunks: [], toolCalls: [{ id: "b3", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS t_once (id INTEGER)" } }] },
      { chunks: [], toolCalls: [{ id: "b4", name: "db_exec", arguments: { sql: "DROP TABLE t_once" } }] },
      { chunks: ["完成"] },
    ]);
    await newConversation(h);
    const result = await runApproving(h, "建表后两次删除", "once", 2);
    expect(result.err, `error: ${JSON.stringify(result.err)}`).toBeNull();
    expect(result.done).toBe(true);
    // "once" does NOT cache → both DROPs prompted.
    const onceIds = new Set(result.approvals.map((a: any) => a.id));
    expect(onceIds.size, `expected 2 prompts, got ${onceIds.size}`).toBe(2);
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|no such table/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
