// J31: Approval gate via the REAL dialog buttons (data-cmd approvalAllow /
// approvalDeny), not the agentBrowser.approvalAllow() helper. J18/J24 resolve via the
// helper; this clicks the actual ✗ 拒绝 / ✓ 始终允许 buttons the user sees.
// deny preserves the table; always auto-allows a second identical DROP.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j31");

describe("J31 — approval via real dialog buttons", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20 });
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
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  }, 90000);

  async function newConv() {
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(200);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(200);
  }
  async function waitForDialog(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const open = await h.page.evaluate(() => document.getElementById("dlg-approval").open);
      if (open) return true;
      await h.page.waitForTimeout(150);
    }
    return false;
  }

  it("deny button rejects the DROP — table survives", async () => {
    // Seed a table first (non-destructive, no approval).
    await h.page.evaluate(async () => { await (window as any).agentBrowser.api.agentDb.exec("CREATE TABLE IF NOT EXISTS keep_me (id INTEGER)"); });
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "d1", name: "db_exec", arguments: { sql: "DROP TABLE keep_me" } }] },
      { chunks: ["done"] },
    ]);
    await newConv();
    await h.page.locator("#agent-chat-input").fill("删掉 keep_me 表");
    await h.page.locator("#agent-chat-input").press("Enter");
    expect(await waitForDialog(), "approval dialog must open").toBe(true);
    // Click the real ✗ 拒绝 button.
    await h.page.locator('#dlg-approval [data-cmd="approvalDeny"][data-cmd-arg="deny"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(500);
    const exists = await h.page.evaluate(async () =>
      (await (window as any).agentBrowser.api.agentDb.tables()).some((t: any) => t.name === "keep_me"));
    expect(exists, "table must survive a denied DROP").toBe(true);
  }, 40000);

  it("always button auto-allows a second identical DROP (no re-prompt)", async () => {
    // Recreate the table so there's something to drop twice.
    await h.page.evaluate(async () => { await (window as any).agentBrowser.api.agentDb.exec("CREATE TABLE IF NOT EXISTS keep_me (id INTEGER)"); });
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "a1", name: "db_exec", arguments: { sql: "DROP TABLE keep_me" } }] },
      { chunks: [], toolCalls: [{ id: "a2", name: "db_exec", arguments: { sql: "CREATE TABLE keep_me (id INTEGER)" } }] },
      { chunks: [], toolCalls: [{ id: "a3", name: "db_exec", arguments: { sql: "DROP TABLE keep_me" } }] },
      { chunks: ["done"] },
    ]);
    await newConv();
    await h.page.locator("#agent-chat-input").fill("两次删除 keep_me");
    await h.page.locator("#agent-chat-input").press("Enter");
    expect(await waitForDialog(), "first DROP must prompt").toBe(true);
    // Click the real ✓ 始终允许 button.
    await h.page.locator('#dlg-approval [data-cmd="approvalAllow"][data-cmd-arg="always"]').click({ timeout: 5000 });
    // The second DROP should NOT re-open the dialog.
    await h.page.waitForTimeout(3000);
    const reopened = await h.page.evaluate(() => document.getElementById("dlg-approval").open);
    expect(reopened, "second identical DROP must not re-prompt").toBe(false);
    // Table is gone after both DROPs.
    const exists = await h.page.evaluate(async () =>
      (await (window as any).agentBrowser.api.agentDb.tables()).some((t: any) => t.name === "keep_me"));
    expect(exists).toBe(false);
  }, 50000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|no such table/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
