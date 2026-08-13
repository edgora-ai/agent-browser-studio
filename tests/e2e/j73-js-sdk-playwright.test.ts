// J73: JS SDK — Playwright/Puppeteer CDP drop-in (Slice 48).
// Drives the real headless controller through the JavaScript SDK and proves
// the "swap the import" story: a managed profile launched over REST, connected
// over CDP, keeps the C++-level fingerprint intact (webdriver=false, managed
// UA / screen / languages) while standard Playwright calls keep working.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { launchHeadlessApp, HeadlessAppHandle } from './helpers/app.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j73');

describe('J73 — JS SDK: Playwright/Puppeteer CDP drop-in', () => {
  let h: HeadlessAppHandle;
  let sdk: any;

  beforeAll(async () => {
    h = await launchHeadlessApp({ userDataDir: USERDATA, token: 'j73-sdk-token' });
    sdk = await import('../../sdk/js/agent-browser.mjs');
  }, 60000);

  afterAll(async () => {
    if (h) await h.close();
  }, 90000);

  it('AgentBrowserClient mirrors the REST surface', async () => {
    const client = new sdk.AgentBrowserClient('http://127.0.0.1:' + h.port, { token: h.token });
    const health = await client.health();
    expect(health.mode).toBe('headless');
    const ver = await client.version();
    expect(ver.version).toBeTruthy();
    const spec = await client.openapi();
    expect(spec.paths['/api/profiles']).toBeTruthy();
    expect(Array.isArray(await client.listProxies())).toBe(true);
    expect(Array.isArray(await client.listProfiles())).toBe(true);
  }, 20000);

  it('connectPlaywright keeps the managed fingerprint intact and drives real pages', async () => {
    const handle = await sdk.connectPlaywright({
      baseUrl: 'http://127.0.0.1:' + h.port,
      token: h.token,
      name: 'j73-pw',
      platform: 'windows',
      locale: 'en-US',
      timezone: 'America/New_York',
      fingerprintSeed: 73011,
    });
    expect(handle.cdpPort).toBeGreaterThan(0);
    expect(handle.dirId).toBeTruthy();
    try {
      const page = await handle.browser.newPage();
      await page.goto('about:blank');
      const values = await page.evaluate(() => {
        const s = (window as any).screen;
        return {
          webdriver: (navigator as any).webdriver,
          ua: navigator.userAgent,
          screenW: s.width,
          screenH: s.height,
          languages: navigator.languages,
        };
      });
      expect(values.webdriver).toBe(false);
      expect(values.ua).toContain('Windows');
      expect(values.screenW).toBe(1920);
      expect(values.screenH).toBe(1080);
      expect(values.languages).toEqual(['en-US']);
      // Standard Playwright interactions still work end-to-end.
      await page.setContent('<input id="q" value=""><button id="go">Go</button>');
      await page.fill('#q', 'hello agent');
      await page.click('#go');
      expect(await page.inputValue('#q')).toBe('hello agent');
    } finally {
      await handle.stop();
    }
  }, 60000);

  it('connectPuppeteer fails fast with a helpful message when no driver is installed', async () => {
    let error: any = null;
    try {
      await sdk.connectPuppeteer({
        baseUrl: 'http://127.0.0.1:' + h.port,
        token: h.token,
        name: 'j73-pptr',
        platform: 'windows',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeTruthy();
    expect(String(error.message)).toContain('puppeteer-core');
    // No profile should be left behind by the failed puppeteer attach.
    const client = new sdk.AgentBrowserClient('http://127.0.0.1:' + h.port, { token: h.token });
    const profiles = await client.listProfiles();
    expect(profiles.some((p: any) => p.name === 'j73-pptr')).toBe(false);
  }, 30000);

  it('attach mode reconnects to an already-running profile by dirId', async () => {
    const created = await sdk.connectPlaywright({
      baseUrl: 'http://127.0.0.1:' + h.port,
      token: h.token,
      name: 'j73-attach',
      platform: 'windows',
      fingerprintSeed: 73012,
    });
    const dirId = created.dirId;
    try {
      // Closing the Playwright connection does not stop the Chromium process.
      await created.browser.close();
      const attached = await sdk.connectPlaywright({
        baseUrl: 'http://127.0.0.1:' + h.port,
        token: h.token,
        dirId: dirId,
      });
      try {
        expect(attached.cdpPort).toBe(created.cdpPort);
        const page = await attached.browser.newPage();
        await page.goto('about:blank');
        expect(await page.evaluate(() => (navigator as any).webdriver)).toBe(false);
      } finally {
        await attached.stop();
      }
    } finally {
      try { await created.stop(); } catch { /* already stopped */ }
    }
  }, 60000);
});

