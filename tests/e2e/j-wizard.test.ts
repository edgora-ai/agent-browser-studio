// Wizard behavior: "Skip for now" is session-only (not persisted);
// "Don't show again" persists dismissal. The optional 4th step advances
// from step 3. Uses a fresh userdata so first-run conditions hold.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { closeAllDialogs } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j-wizard");

describe("Wizard — skip vs never-show semantics", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
  });

  it("skip-for-now does not persist dismissal to localStorage", async () => {
    // Ensure a clean localStorage state for this isolated assertion.
    await h.page.evaluate(() => { try { localStorage.removeItem("agent-browser-studio-wizard-dismissed"); } catch (e) {} });

    // The wizard auto-shows after 500ms on first run (no binary / no profiles).
    await h.page.waitForTimeout(900);
    await closeAllDialogs(h.page);

    // Manually trigger the wizard and press Skip.
    await h.page.evaluate(() => { (window as any).wizardDismissed = false; (window as any).agentBrowser.showWizard(); });
    await h.page.waitForTimeout(200);
    const openBefore = await h.page.evaluate(() => (document.getElementById("dlg-wizard") as any)?.open);
    expect(openBefore).toBe(true);

    // Target the footer Skip button specifically (step 4's Finish also reuses
    // the wizardSkip command). Scope to the footer .btn-row.
    await h.page.locator('#dlg-wizard > .btn-row [data-cmd="wizardSkip"]').click({ timeout: 3000 });
    await h.page.waitForTimeout(200);

    const dismissed = await h.page.evaluate(() => localStorage.getItem("agent-browser-studio-wizard-dismissed"));
    // Skip must NOT persist dismissal.
    expect(dismissed, "skip should not persist agent-browser-studio-wizard-dismissed").toBeNull();

    // And the in-memory session flag should be set so it does not reappear now.
    const sessionFlag = await h.page.evaluate(() => (window as any).wizardDismissed);
    expect(sessionFlag).toBe(true);
  });

  it("never-show persists dismissal to localStorage", async () => {
    // Clear the in-memory flag so we can re-open the wizard.
    await h.page.evaluate(() => { (window as any).wizardDismissed = false; (window as any).agentBrowser.showWizard(); });
    await h.page.waitForTimeout(200);
    await h.page.locator('[data-cmd="wizardNeverShow"]').click({ timeout: 3000 });
    await h.page.waitForTimeout(200);

    const dismissed = await h.page.evaluate(() => localStorage.getItem("agent-browser-studio-wizard-dismissed"));
    expect(dismissed).toBe("1");
  });

  it("wizard exposes the optional agent configuration command", async () => {
    const hasFn = await h.page.evaluate(() => typeof (window as any).agentBrowser.wizardConfigureAgent === "function");
    expect(hasFn, "wizardConfigureAgent should be defined").toBe(true);
    const hasStep4 = await h.page.evaluate(() => !!document.querySelector('.wizard-step[data-step="4"]'));
    expect(hasStep4, "wizard step 4 should exist in the DOM").toBe(true);
  });

  it("config.json was created for the fresh userData", async () => {
    // Sanity: the fresh run produced a config, proving the wizard did not block init.
    const fs = require("node:fs");
    expect(fs.existsSync(userDataConfigPath(USERDATA))).toBe(true);
  });
});
