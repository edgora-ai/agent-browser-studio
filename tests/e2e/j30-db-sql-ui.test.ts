// J30: DB tab — SQL execution via the UI textarea. J17/J18/J19 prove the agent
// can write the DB; this proves the USER can too: type a CREATE TABLE + INSERT
// in #db-sql, run it, see the table materialize, then SELECT and see rows.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j30");

describe("J30 — DB tab SQL execution UI", () => {
  let h: TestAppHandle;

  beforeAll(async () => { h = await setupTestApp({ userDataDir: USERDATA }); }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("creates a table + inserts a row via the SQL textarea", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("db"));
    await h.page.waitForTimeout(300);
    await h.page.evaluate(() => (window as any).agentBrowser.loadDbTab());
    await h.page.waitForTimeout(300);

    const execBtn = '[data-cmd="dbRunSql"][data-cmd-arg="exec"]';
    await h.page.locator("#db-sql").fill("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
    await h.page.locator(execBtn).click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    await h.page.locator("#db-sql").fill("INSERT INTO notes (body) VALUES ('hello from UI')");
    await h.page.locator(execBtn).click({ timeout: 5000 });
    await h.page.waitForTimeout(400);

    // The table now appears in the left list.
    await h.page.evaluate(() => (window as any).agentBrowser.loadDbTab());
    await h.page.waitForTimeout(400);
    const hasTable = await h.page.evaluate(() =>
      [...document.querySelectorAll("#db-tables [data-table]")].some((r) => (r as HTMLElement).dataset.table === "notes"));
    expect(hasTable).toBe(true);
  }, 30000);

  it("SELECT via the textarea renders rows in the result pane", async () => {
    // The plain 运行 button (no data-cmd-arg) runs the query path.
    await h.page.locator("#db-sql").fill("SELECT body FROM notes");
    await h.page.locator('[data-cmd="dbRunSql"]:not([data-cmd-arg])').click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    const resultText = await h.page.evaluate(() => document.getElementById("db-result").textContent);
    expect(resultText).toContain("hello from UI");
  }, 20000);

  it("a malformed statement shows an error, not a crash", async () => {
    await h.page.locator("#db-sql").fill("SELECT FROM notasdjf");
    await h.page.locator('[data-cmd="dbRunSql"]:not([data-cmd-arg])').click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    const resultText = await h.page.evaluate(() => document.getElementById("db-result").textContent);
    expect(resultText.toLowerCase()).toMatch(/error|失败|syntax|near/);
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|notasdjf|syntax|near/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
