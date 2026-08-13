 // J93: Per-profile operation logs + rolling browser log tail
 // (RoxyBrowser 4.0.3 "Trackable Profile Activity" / 4.0.2 "rolling logs" parity).
 // The profile card 📋 button opens a dialog showing recent audit entries for
 // that profile plus the tail of its managed Chromium launch log.
 import { describe, it, expect, beforeAll, afterAll } from 'vitest';
 import * as path from 'node:path';
 import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
 import { filterKnownConsoleErrors } from './helpers/diag.js';

 const REPO = path.resolve(__dirname, '..', '..');
 const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j93');

 describe('J93 — Profile operation logs + browser log tail', () => {
   let h: TestAppHandle;
   let dirId = "";

   beforeAll(async () => {
     h = await setupTestApp({ userDataDir: USERDATA });
   }, 60000);

   afterAll(async () => { if (h) await closeApp(h); }, 90000);

   it('creates and launches a profile (produces audit + browser log)', async () => {
     const created: any = await h.page.evaluate(
       (opts: any) => (window as any).agentBrowser.api.browser.create(opts),
       { name: "J93-Logs", platform: "windows", locale: "en-US", fingerprintSeed: 93001 },
     );
     expect(created.dirId).toBeTruthy();
     dirId = created.dirId;
     const lr: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), dirId);
     expect(lr.success, lr.error || 'launch failed').toBe(true);
     h.cdpPids.push(lr.pid);
     await new Promise((r) => setTimeout(r, 1500)); // let the log + audit settle
   }, 60000);

   it('browser:logs returns activity and a non-empty launch log tail', async () => {
     const r: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.logs(id), dirId);
     expect(r.success, JSON.stringify(r)).toBe(true);
     expect(r.logExists).toBe(true);
     expect(String(r.logTail)).toContain("Launching");
     const actions = (r.activity || []).map((e: any) => e.action);
     expect(actions).toContain("launch");
   }, 20000);

   it('opens the 📋 logs dialog from the profile card', async () => {
     await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
     await h.page.waitForTimeout(400);
     const cardSel = `[data-dir-id="${dirId}"]`;
     await h.page.waitForSelector(cardSel + ' [data-action="logs"]', { timeout: 8000 });
     await h.page.locator(cardSel + ' [data-action="logs"]').click({ timeout: 5000 });
     await h.page.waitForSelector("#dlg-profile-logs[open]", { timeout: 5000 });
     await h.page.waitForFunction(() => {
       const el = document.getElementById("profile-logs-activity");
       return !!el && /launch/.test(el.textContent || "");
     }, { timeout: 10000 });
     const tailText = await h.page.evaluate(() => (document.getElementById("profile-logs-tail") as HTMLElement).textContent || "");
     expect(tailText).toContain("Launching");
   }, 30000);

   it('stopping the profile is recorded as activity and survives refresh', async () => {
     const stop: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.stop(id), dirId);
     expect(stop.success).toBe(true);
     await new Promise((r) => setTimeout(r, 800));
     await h.page.locator('#dlg-profile-logs [data-cmd="refreshProfileLogs"]').click({ timeout: 5000 });
     await h.page.waitForFunction(() => {
       const el = document.getElementById("profile-logs-activity");
       return !!el && /stop/.test(el.textContent || "");
     }, { timeout: 10000 });
     await h.page.evaluate(() => { (document.getElementById("dlg-profile-logs") as HTMLDialogElement).close(); });
   }, 30000);

   it('no unexpected console errors', () => {
     const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
       !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
     expect(errs.length, errs.join('\n')).toBe(0);
   });
 });

