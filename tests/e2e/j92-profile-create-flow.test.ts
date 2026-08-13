 // J92: Revamped Profile Creation Flow (RoxyBrowser 4.0.3 parity).
 // The create dialog now leads with basic fields (Name / Platform / Proxy) and
 // collapses the full identity/fingerprint options behind an "Advanced" details
 // section. Basic-only creation works; expanding Advanced reveals the rest.
 import { describe, it, expect, beforeAll, afterAll } from 'vitest';
 import * as path from 'node:path';
 import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
 import { filterKnownConsoleErrors } from './helpers/diag.js';

 const REPO = path.resolve(__dirname, '..', '..');
 const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j92');

 describe('J92 — Revamped Profile Creation Flow (basic / advanced)', () => {
   let h: TestAppHandle;

   beforeAll(async () => {
     h = await setupTestApp({ userDataDir: USERDATA });
   }, 60000);

   afterAll(async () => { if (h) await closeApp(h); }, 90000);

   it('opens the create dialog with basic fields visible and advanced collapsed', async () => {
     await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
     await h.page.waitForTimeout(400);
     await h.page.evaluate(() => (window as any).agentBrowser.newProfile());
     await h.page.waitForSelector("#dlg-profile", { state: "visible", timeout: 5000 });
     const adv = await h.page.locator("#new-profile-advanced").evaluate((el: any) => el.open);
     expect(adv).toBe(false);
     // Basic fields visible: Name, Platform, Proxy
     expect(await h.page.locator("#new-profile-name").isVisible()).toBe(true);
     expect(await h.page.locator("#new-agent-browser-platform").isVisible()).toBe(true);
     expect(await h.page.locator("#new-profile-proxy").isVisible()).toBe(true);
     // Advanced-only field (seed) hidden while collapsed
     expect(await h.page.locator("#new-agent-browser-seed").isVisible()).toBe(false);
   }, 20000);

   it('expanding Advanced reveals the identity/fingerprint fields', async () => {
    await h.page.locator("#new-profile-advanced > summary").click({ timeout: 5000 });
     await h.page.waitForSelector("#new-profile-advanced[open]", { timeout: 5000 });
     expect(await h.page.locator("#new-agent-browser-seed").isVisible()).toBe(true);
     expect(await h.page.locator("#new-agent-browser-timezone").isVisible()).toBe(true);
     expect(await h.page.locator("#new-agent-browser-locale").isVisible()).toBe(true);
     expect(await h.page.locator("#new-agent-browser-webrtc-mode").isVisible()).toBe(true);
   }, 20000);

   it('creates a profile with basic fields only (name + platform + proxy default)', async () => {
     await h.page.locator("#new-profile-name").fill("J92-BasicFlow", { timeout: 5000 });
     await h.page.locator("#new-agent-browser-platform").selectOption("windows");
     await h.page.locator('#dlg-profile button[type="submit"]').click({ timeout: 5000 });
     await h.page.waitForSelector("#dlg-profile", { state: "hidden", timeout: 8000 });
     await h.page.waitForTimeout(1200);
     const profiles: any = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
     const p = (profiles || []).find((x: any) => x.name === "J92-BasicFlow");
     expect(p).toBeTruthy();
     expect(p.platform).toBe("windows");
     expect(p.fingerprintMode).toBe("managed");
     expect(p.fingerprintSeed).toBeGreaterThanOrEqual(1);
   }, 30000);

   it('reopening the dialog collapses Advanced again (fresh basic-first flow)', async () => {
     await h.page.evaluate(() => (window as any).agentBrowser.newProfile());
     await h.page.waitForSelector("#dlg-profile", { state: "visible", timeout: 5000 });
     const adv = await h.page.locator("#new-profile-advanced").evaluate((el: any) => el.open);
     expect(adv).toBe(false);
     await h.page.evaluate(() => { (document.getElementById("dlg-profile") as HTMLDialogElement).close(); });
   }, 20000);

   it('no unexpected console errors', () => {
     const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
       !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
     expect(errs.length, errs.join('\n')).toBe(0);
   });
 });
