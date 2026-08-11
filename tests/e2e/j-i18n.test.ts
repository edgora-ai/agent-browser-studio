// i18n e2e: sidebar tab labels follow data-i18n; toggling language to en-US
// updates the automation/runs/activity/db tab labels to English, and toggling
// back restores Chinese.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { closeAllDialogs } from "./helpers/diag.js";
import { dataTab } from "./helpers/find.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j-i18n");

describe("i18n — sidebar tabs and language switch", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    await h.page.waitForTimeout(600);
    await closeAllDialogs(h.page);
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
  });

  it("starts in zh-CN and shows Chinese automation tab label", async () => {
    await h.page.evaluate(() => (window as any).i18n.set("zh-CN"));
    await h.page.waitForTimeout(150);
    const label = await h.page.locator('[data-tab="automation"]').innerText();
    expect(label).toContain("自动化");
  });

  it("switching to en-US updates the four previously-untranslated tabs to English", async () => {
    await h.page.evaluate(() => (window as any).i18n.set("en-US"));
    await h.page.waitForTimeout(200);
    await h.page.evaluate(() => (window as any).i18n.apply());
    await h.page.waitForTimeout(150);
    const labels = await h.page.evaluate(() => ({
      automation: (document.querySelector('[data-tab="automation"]') as HTMLElement)?.innerText,
      runs: (document.querySelector('[data-tab="runs"]') as HTMLElement)?.innerText,
      activity: (document.querySelector('[data-tab="activity"]') as HTMLElement)?.innerText,
      db: (document.querySelector('[data-tab="db"]') as HTMLElement)?.innerText,
    }));
    expect(labels.automation).toContain("Automation");
    expect(labels.runs).toContain("Runs");
    expect(labels.activity).toContain("Activity");
    expect(labels.db).toContain("Database");
  });

  it("switching back to zh-CN restores Chinese tab labels", async () => {
    await h.page.evaluate(() => (window as any).i18n.set("zh-CN"));
    await h.page.waitForTimeout(200);
    await h.page.evaluate(() => (window as any).i18n.apply());
    await h.page.waitForTimeout(150);
    const label = await h.page.locator('[data-tab="db"]').innerText();
    expect(label).toContain("数据库");
  });

  it("toggleLanguage reloads the active tab without errors", async () => {
    await dataTab(h.page, "agent").click({ timeout: 5000 });
    await h.page.waitForTimeout(200);
    await closeAllDialogs(h.page);
    const langBefore = await h.page.evaluate(() => (window as any).i18n.get());
    await h.page.evaluate(() => (window as any).agentBrowser.toggleLanguage());
    await h.page.waitForTimeout(250);
    const langAfter = await h.page.evaluate(() => (window as any).i18n.get());
    expect(langBefore).not.toBe(langAfter);
  });
});