// J32: Profile card UI actions — launch / stop / edit / delete via the real
// card buttons (data-action). J1/J2 exercise creation + batch; this covers the
// per-card controls a user actually clicks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j32");

describe("J32 — profile card UI: launch / stop / edit / delete", () => {
  let h: TestAppHandle;
  let dirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, allowProfileVersionSelection: true });
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J32card", platform: "windows", fingerprintSeed: 32323 }));
    dirId = r.dirId;
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  const card = () => `[data-dir-id="${dirId}"]`;

  it("launches the profile via the card Launch button", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    await h.page.waitForTimeout(400);
    await h.page.locator(`${card()} [data-action="launch"]`).click({ timeout: 5000 });
    // Poll until running.
    const start = Date.now();
    let running = false;
    while (Date.now() - start < 20000) {
      running = (await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId)).running;
      if (running) break;
      await h.page.waitForTimeout(300);
    }
    expect(running, "profile must be running after Launch click").toBe(true);
  }, 30000);

  it("stops the profile via the card Stop button", async () => {
    await h.page.locator(`${card()} [data-action="stop"]`).click({ timeout: 5000 });
    const start = Date.now();
    let running = true;
    while (Date.now() - start < 15000) {
      running = (await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId)).running;
      if (!running) break;
      await h.page.waitForTimeout(300);
    }
    expect(running, "profile must be stopped after Stop click").toBe(false);
  }, 25000);

  it("edits + saves the profile via the Edit dialog", async () => {
    await h.page.locator(`${card()} [data-action="edit"]`).click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-agent-browser-seed[open]", { timeout: 5000 });
    await h.page.locator("#agent-browser-meta-name").fill("J32-renamed");
    await h.page.locator("#agent-browser-meta-seed").fill("55555");
    await h.page.locator("#agent-browser-meta-fingerprint-mode").selectOption("off");
    await h.page.locator("#agent-browser-meta-allow-third-party-cookies").check();
    await h.page.waitForFunction(() => (document.getElementById("agent-browser-meta-browser-version") as HTMLSelectElement).options.length > 1);
    const pinnedVersion = await h.page.locator("#agent-browser-meta-browser-version option").nth(1).getAttribute("value");
    expect(pinnedVersion).toBeTruthy();
    await h.page.locator("#agent-browser-meta-browser-version").selectOption(pinnedVersion!);
    await h.page.evaluate(() => (window as any).agentBrowser.saveBrowserMeta());
    await h.page.waitForTimeout(500);
    const profiles = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const p = profiles.find((x: any) => x.dirId === dirId);
    expect(p.name).toBe("J32-renamed");
    expect(p.fingerprintSeed).toBe(55555);
    expect(p.fingerprintMode).toBe("off");
    expect(p.browserVersion).toBe(pinnedVersion);
    expect(p.allowThirdPartyCookies).toBe(true);
  }, 20000);

  it("deletes the profile via the card Delete button + the confirm dialog", async () => {
    await h.page.locator(`${card()} [data-action="delete"]`).click({ timeout: 5000 });
    // Custom #dlg-confirm opens; click its Confirm submit button.
    await h.page.waitForSelector("#dlg-confirm[open]", { timeout: 5000 });
    await h.page.locator('#dlg-confirm button[type="submit"]').click({ timeout: 5000 });
    // Poll — the card disappears after the async refresh.
    const start = Date.now();
    let cardGone = false;
    while (Date.now() - start < 8000) {
      cardGone = await h.page.evaluate((id: string) => document.querySelector(`[data-dir-id="${id}"]`) === null, dirId);
      if (cardGone) break;
      await h.page.waitForTimeout(200);
    }
    expect(cardGone, "profile card must be gone after delete").toBe(true);
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
