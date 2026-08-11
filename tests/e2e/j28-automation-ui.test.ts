// J28: Automation tab — MANUAL UI CRUD (complements J27 which creates the rule
// via the agent tool). Clicks the real buttons: 新建任务 → fill the form →
// save → card appears; toggle enable↔disable; delete + confirm. Proves the
// UI↔automation-engine wiring end to end without the agent.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j28");

async function reload(h: TestAppHandle) {
  await h.page.evaluate(() => (window as any).agentBrowser.loadAutomationTab());
  await h.page.waitForTimeout(300);
}
async function cardCount(h: TestAppHandle) {
  return h.page.evaluate(() => document.querySelectorAll("#automation-list [data-rule-id]").length);
}

describe("J28 — automation tab UI CRUD", () => {
  let h: TestAppHandle;
  let dirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    // A profile is needed for the agent-task action's profile select.
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J28demo", platform: "windows", fingerprintSeed: 28282 }));
    dirId = r.dirId;
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("creates a rule through the 新建任务 form", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("automation"));
    await h.page.waitForTimeout(300);
    await reload(h);
    expect(await cardCount(h)).toBe(0);

    await h.page.locator('[data-cmd="automationNew"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-automation[open]", { timeout: 5000 });
    await h.page.locator("#auto-name").fill("UI采集任务");
    await h.page.locator("#auto-trigger-type").selectOption("cron");
    await h.page.locator("#auto-cron").fill("0 9 * * *");
    await h.page.locator("#auto-action-type").selectOption("agent-task");
    // Wait for the profile select to populate, then pick our profile.
    await h.page.waitForFunction((id: string) => {
      const sel = document.getElementById("auto-action-profile") as HTMLSelectElement;
      return sel && [...sel.options].some((o) => o.value === id);
    }, dirId, { timeout: 5000 });
    await h.page.locator("#auto-action-profile").selectOption(dirId);
    await h.page.locator("#auto-action-prompt").fill("打开百度采集科技新闻");
    await h.page.locator('#dlg-automation button[type="submit"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(400);

    expect(await cardCount(h)).toBe(1);
    const rules = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.list());
    const rule = rules[0];
    expect(rule.trigger.cron).toBe("0 9 * * *");
    expect(rule.action.type).toBe("agent-task");
    expect(rule.action.profileDirId).toBe(dirId);
    expect(rule.enabled).toBe(true);
  }, 30000);

  it("toggles the rule off then on via the card button", async () => {
    await h.page.locator('#automation-list [data-rule-action="toggle"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    let rules = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.list());
    expect(rules[0].enabled).toBe(false);
    // Card badge reflects 停用.
    let badge = await h.page.locator("#automation-list .status-badge").textContent();
    expect(badge).toContain("停用");

    await h.page.locator('#automation-list [data-rule-action="toggle"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    rules = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.list());
    expect(rules[0].enabled).toBe(true);
  }, 20000);

  it("deletes the rule via the card button + confirm", async () => {
    await h.page.evaluate(() => { (window as any).confirm = () => true; });
    await h.page.locator('#automation-list [data-rule-action="delete"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    expect(await cardCount(h)).toBe(0);
    const rules = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.list());
    expect(rules.length).toBe(0);
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
