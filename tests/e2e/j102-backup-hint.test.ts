// J102: data-safety reminder (A5). Once real profiles exist, the profiles page
// shows a one-time backup hint; dismissing it persists across reloads.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j102");

describe("J102 — backup hint banner (A5)", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("appears once a profile exists, and dismissal persists", async () => {
    await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      await api.browser.create({ name: "J102-backup", platform: "windows", fingerprintSeed: 5150 });
      (window as any).agentBrowser.switchTab("profiles");
      await (window as any).agentBrowser.loadProfiles();
    });

    const banner = h.page.locator("#backup-hint");
    await banner.waitFor({ state: "visible", timeout: 10000 });
    expect(await banner.textContent()).toContain("本机");

    await h.page.locator('#backup-hint [data-cmd="dismissBackupHint"]').click({ timeout: 5000 });
    expect(await banner.isHidden()).toBe(true);
    const dismissed = await h.page.evaluate(() => localStorage.getItem("abs-backup-hint-dismissed"));
    expect(dismissed).toBe("1");

    // Reload the list: stays hidden because dismissal persisted.
    await h.page.evaluate(() => (window as any).agentBrowser.loadProfiles());
    expect(await banner.isHidden()).toBe(true);
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
