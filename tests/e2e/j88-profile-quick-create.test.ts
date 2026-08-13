// J88: One-click Quick Create profile (RoxyBrowser 4.0.3 parity). The
// Profiles toolbar has a "Quick Create" button that creates a profile
// with managed defaults in one click — no form — then refreshes the list.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
import { filterKnownConsoleErrors } from './helpers/diag.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j88');

describe('J88 — one-click Quick Create profile', () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, allowProfileVersionSelection: true });
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it('creates a profile with one click and refreshes the list', async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab('profiles'));
    await h.page.waitForTimeout(400);
    const before = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());

   await h.page.locator('[data-cmd="quickCreateProfile"]').click({ timeout: 5000 });
   const start = Date.now();
   let created = false;
   while (Date.now() - start < 15000) {
     const after = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
     if (after.length > before.length) { created = true; break; }
     await h.page.waitForTimeout(300);
   }
   expect(created, 'Quick Create must add a profile').toBe(true);

  // The default name is localized via i18n; read it from the app itself so
   // the assertion holds under any UI language.
   const expectedName = await h.page.evaluate(() =>
     (window as any).i18n ? (window as any).i18n.t('profiles.quick-name', 'Quick Profile') : 'Quick Profile');
   expect(expectedName).toBeTruthy();
   const profiles = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
   expect(profiles.some((p: any) => p.name === expectedName)).toBe(true);
   const quick = profiles.find((p: any) => p.name === expectedName);
   expect(quick.dirId).toMatch(/^(ab_|cb_)/);

   // The list is rendered as a card for the new profile.
    const cardSel = `[data-dir-id="${quick.dirId}"]`;
    const cardStart = Date.now();
    let cardCount = 0;
    while (Date.now() - cardStart < 10000) {
      cardCount = await h.page.locator(cardSel).count();
      if (cardCount > 0) break;
      await h.page.waitForTimeout(250);
    }
    expect(cardCount, 'Quick Created profile must render as a card').toBeGreaterThan(0);
 }, 30000);

  it('no unexpected console errors', () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join('\n')).toBe(0);
  });
});
