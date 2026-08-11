// J39: Copilot task templates (Slice 7). The agent system prompt advertises the
// built-in templates, and a template-driven run writes structured rows into the
// template's output table (here: prices). No browser needed — this proves the
// template→structured-write wiring + prompt advertising.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j39");

describe("J39 — Copilot task templates drive structured writes", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20 });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  }, 90000);

  it("advertises the templates in the system prompt + writes to the template table", async () => {
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "1", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS prices (id INTEGER PRIMARY KEY, product TEXT, url TEXT, price REAL, currency TEXT, captured_at TEXT)" } }] },
      { chunks: [], toolCalls: [{ id: "2", name: "db_exec", arguments: { sql: "INSERT INTO prices (product, url, price, currency, captured_at) VALUES (?, ?, ?, ?, ?)", params: ["Widget", "https://shop.example/w", 9.99, "USD", "2026-06-24"] } }] },
      { chunks: ["已", "采集", "1 条价格。"] },
    ]);
    await h.page.evaluate((murl: string) => {
      (window as any).agentBrowser.api.agent.saveLlmConfig({ provider: "openai", apiKey: "sk", model: "mock", apiUrl: murl });
    }, mock.url);
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
    await h.page.waitForTimeout(150);
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(150);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.agentActiveConvId, { timeout: 5000 });

    await h.page.evaluate(() => { (window as any).__done = false; (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
    });
    await h.page.locator("#agent-chat-input").fill("用 price-scrape 模板采集价格");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 25000) {
      const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
      if (st.d || st.e) break;
      await h.page.waitForTimeout(200);
    }
    const done = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
    expect(done.e, `error: ${done.e}`).toBeNull();
    expect(done.d).toBe(true);

    // The system prompt advertised the template catalog.
    const sys = (mock.requests[0]?.body?.messages || []).find((m: any) => m.role === "system");
    expect(String(sys?.content || "")).toContain("price-scrape");
    expect(String(sys?.content || "")).toContain("prices");
    expect(String(sys?.content || "")).toContain("risk:medium");
    expect(String(sys?.content || "")).toContain("successCriteria");

    // The template's output table got a structured row.
    const rows = await h.page.evaluate(async () => {
      const r = await (window as any).agentBrowser.api.agentDb.query("SELECT product, price, currency FROM prices");
      return r.rows;
    });
    expect(JSON.stringify(rows)).toContain("Widget");
    expect(JSON.stringify(rows)).toContain("9.99");
  }, 40000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
