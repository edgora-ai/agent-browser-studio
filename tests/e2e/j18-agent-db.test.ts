// J18: Agent SQLite tools — db_exec (create+insert) → db_query (read), then a
// destructive DROP that triggers the approval gate. Verifies trace + DB tab.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j18");

describe("J18 — Agent DB tools + approval", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    mock = await startMockLlm({
      delayMs: 30,
      responses: [
        { chunks: [], toolCalls: [{ id: "c1", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT)" } }] },
        { chunks: [], toolCalls: [{ id: "c2", name: "db_exec", arguments: { sql: "INSERT INTO customers (name, email) VALUES (?, ?)", params: ["Alice", "alice@example.com"] } }] },
        { chunks: [], toolCalls: [{ id: "c3", name: "db_query", arguments: { sql: "SELECT * FROM customers" } }] },
        { chunks: ["已 ", "创建 ", "并 ", "查询 ", "customers。"] },
      ],
    });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  });

  it("configures mock LLM + conversation", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
    await h.page.waitForTimeout(200);
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("config"));
    await h.page.waitForTimeout(200);
    await h.page.locator("#agent-llm-provider").selectOption("openai");
    await h.page.locator("#agent-llm-apikey").fill("sk-mock");
    await h.page.locator("#agent-llm-model").fill("mock");
    await h.page.locator("#agent-llm-url").fill(mock.url);
    await h.page.locator('[data-cmd="agentSaveConfig"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#agent-config-saved", { state: "visible", timeout: 5000 });
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(200);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.agentActiveConvId, { timeout: 5000 });
  });

  it("runs db_exec(create) → db_exec(insert) → db_query(select)", async () => {
    await h.page.evaluate(() => {
      (window as any).__done = false;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
    });
    await h.page.locator("#agent-chat-input").fill("建 customers 表插一条并查");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 30000) {
      if (await h.page.evaluate(() => (window as any).__done)) break;
      await h.page.waitForTimeout(200);
    }
    // The table should now exist with one row.
    const data = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const tables = await api.agentDb.tables();
      const cust = tables.find((t: any) => t.name === "customers");
      if (!cust) return { exists: false };
      const rows = await api.agentDb.tableData("customers");
      return { exists: true, rowCount: cust.rowCount, rows: rows.rows };
    });
    expect(data.exists, "customers table must exist").toBe(true);
    expect(data.rowCount).toBe(1);
    expect(JSON.stringify(data.rows)).toContain("Alice");
  }, 40000);

  it("the run trace recorded the db tools", async () => {
    const result = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const list = await api.agentRuns.list();
      const run = await api.agentRuns.get(list[0].id);
      return run;
    });
    const tools = result.steps.map((s: any) => s.tool);
    expect(tools).toContain("db_exec");
    expect(tools).toContain("db_query");
    // The query step result should contain Alice.
    const qStep = result.steps.find((s: any) => s.tool === "db_query");
    expect(JSON.stringify(qStep.result)).toContain("Alice");
  });

  it("DB tab lists the customers table", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("db"));
    await h.page.waitForTimeout(400);
    await h.page.evaluate(() => (window as any).agentBrowser.loadDbTab());
    await h.page.waitForTimeout(500);
    const hasTable = await h.page.evaluate(() => {
      const rows = document.querySelectorAll("#db-tables [data-table]");
      return [...rows].some((r) => (r as HTMLElement).dataset.table === "customers");
    });
    expect(hasTable).toBe(true);
  });

  it("destructive db_exec (DROP) triggers the approval dialog", async () => {
    // Start a new agent run that tries DROP TABLE.
    const mock2 = mock;
    mock2.setResponses([
      { chunks: [], toolCalls: [{ id: "d1", name: "db_exec", arguments: { sql: "DROP TABLE customers" } }] },
      { chunks: ["done"] },
    ]);
    // Listen for the approval request.
    await h.page.evaluate(() => {
      (window as any).__approval = null;
      (window as any).__done2 = false;
      const api = (window as any).agentBrowser.api;
      api.on("agent:approval-request", (req: any) => { (window as any).__approval = req; });
      api.on("agent:stream-done", () => { (window as any).__done2 = true; });
    });
    // Switch back to the agent chat tab (we left it on db).
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
    await h.page.waitForTimeout(300);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(300);
    await h.page.locator("#agent-chat-input").fill("删掉 customers 表");
    await h.page.locator("#agent-chat-input").press("Enter");
    // Wait for the approval prompt to appear.
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const appr = await h.page.evaluate(() => (window as any).__approval);
      if (appr) break;
      await h.page.waitForTimeout(200);
    }
    const approval = await h.page.evaluate(() => (window as any).__approval);
    expect(approval, "DROP must trigger an approval request").toBeTruthy();
    expect(approval.category).toBe("db-destroy");
    expect(JSON.stringify(approval.description)).toContain("DROP");

    // Reject it — the table should survive.
    await h.page.evaluate(() => (window as any).agentBrowser.approvalDeny("deny"));
    await h.page.waitForTimeout(500);
    const exists = await h.page.evaluate(async () => {
      const tables = await (window as any).agentBrowser.api.agentDb.tables();
      return tables.some((t: any) => t.name === "customers");
    });
    expect(exists, "customers table must survive a rejected DROP").toBe(true);
  }, 40000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
