 // J91: Web App (PWA / Sub-apps) app-mode launch (RoxyBrowser 3.9.2 parity).
 // A profile with an appUrl launches as a standalone app window (--app=<url>)
 // directly at that URL, carrying the full managed fingerprint identity.
 import { describe, it, expect, beforeAll, afterAll } from 'vitest';
 import * as path from 'node:path';
 import { execFile } from 'node:child_process';
 import { promisify } from 'node:util';
 import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
 import { filterKnownConsoleErrors } from './helpers/diag.js';
import { waitForCdpPort, waitForPortClosed, connectPageCdp, waitForPageUrl } from './helpers/cdp.js';

 const execFileAsync = promisify(execFile);
 const REPO = path.resolve(__dirname, '..', '..');
 const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j91');

 const APP_URL = 'data:text/html,' + encodeURIComponent('<html><head><title>AppModePage</title></head><body>webapp-marker</body></html>');

 function splitCommandLine(raw: string): string[] {
   const trimmed = raw.trim();
   if (!trimmed) return [];
   const tokens = trimmed.split(/ --/);
   const result: string[] = [];
   for (let index = 0; index < tokens.length; index += 1) {
     result.push(index === 0 ? tokens[index] : '--' + tokens[index]);
   }
   return result;
 }

 async function readProcessArgs(pid: number): Promise<string[]> {
   const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']);
   return splitCommandLine(stdout);
 }

 describe('J91 — Web App (PWA / Sub-apps) app-mode launch', () => {
   let h: TestAppHandle;
   let dirId: string;
   let cdpPort = 0;
   let pid = 0;

   beforeAll(async () => {
     h = await setupTestApp({ userDataDir: USERDATA });
   }, 60000);

   afterAll(async () => { if (h) await closeApp(h); }, 90000);

   it('creates a profile with a Web App URL', async () => {
     const created: any = await h.page.evaluate(
       (opts: any) => (window as any).agentBrowser.api.browser.create(opts),
       { name: 'J91-WebApp', platform: 'windows', locale: 'en-US', timezone: 'America/New_York', fingerprintSeed: 91001, appUrl: APP_URL },
     );
     expect(created.dirId).toBeTruthy();
     dirId = created.dirId;
     const listed: any = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
     const p = (listed || []).find((x: any) => x.dirId === dirId);
     expect(p.appUrl).toBe(APP_URL);
   }, 20000);

   it('launches as a standalone app window at the app URL', async () => {
     const lr: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), dirId);
     expect(lr.success, lr.error || 'launch failed').toBe(true);
     pid = lr.pid;
     cdpPort = lr.cdpPort;
     expect(cdpPort).toBeGreaterThan(0);
     h.cdpPids.push(pid);
     await waitForCdpPort(cdpPort, 15000);
     const args = await readProcessArgs(pid);
     const appArg = args.find((a) => a.startsWith('--app='));
     expect(appArg).toBeTruthy();
     expect(decodeURIComponent(appArg!.slice(6))).toContain('webapp-marker');
   }, 60000);

   it('the app window is at the app URL with the managed identity', async () => {
    await waitForPageUrl(cdpPort, 'data:text/html', 15000);
    const c = await connectPageCdp(cdpPort, (t) => (t.url || '').includes('data:text/html'));
     try {
       const r = await c.send<{ result: { value: any } }>('Runtime.evaluate', {
         expression: '({ href: location.href, ua: navigator.userAgent, webdriver: navigator.webdriver === true, body: document.body.textContent })',
         returnByValue: true,
       });
       const v = r.result.value;
       expect(String(v.href)).toContain('webapp-marker');
       expect(String(v.body)).toContain('webapp-marker');
       expect(v.webdriver).toBe(false);
       expect(String(v.ua)).toContain('Windows');
       expect(String(v.ua)).not.toContain('HeadlessChrome');
     } finally {
       c.close();
     }
   }, 30000);

   it('open-app re-opens/navigates the profile to its Web App URL', async () => {
     const r: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.openApp(id), dirId);
     expect(r.success, r.error || 'open-app failed').toBe(true);
     expect(String(r.appUrl)).toContain('webapp-marker');
   }, 30000);

   it('clearing appUrl returns the profile to a normal browser launch', async () => {
     const cleared: any = await h.page.evaluate(
       (id: string) => (window as any).agentBrowser.api.browser.setMeta(id, { appUrl: null }),
       dirId,
     );
    expect(cleared.success).toBe(true);
    const stop: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.stop(id), dirId);
    expect(stop.success).toBe(true);
    await waitForPortClosed(cdpPort, 10000);
    const lr2: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), dirId);
     expect(lr2.success, lr2.error || 'relaunch failed').toBe(true);
     h.cdpPids.push(lr2.pid);
     await waitForCdpPort(lr2.cdpPort, 15000);
     const args = await readProcessArgs(lr2.pid);
     expect(args.some((a) => a.startsWith('--app='))).toBe(false);
     const listed: any = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
     const p = (listed || []).find((x: any) => x.dirId === dirId);
     expect(p.appUrl).toBeFalsy();
     const stop2: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.stop(id), dirId);
     expect(stop2.success).toBe(true);
   }, 60000);

   it('no unexpected console errors', () => {
     const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
       !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
     expect(errs.length, errs.join('\n')).toBe(0);
   });
 });
