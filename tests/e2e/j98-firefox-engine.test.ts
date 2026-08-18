// J98: Firefox engine capability (Slice 77). Proves the Firefox option is a
// real, first-class surface everywhere:
//   - profiles can be created with engine = "firefox" (IPC + UI + REST);
//   - the engine persists through list/get and displays a Firefox badge;
//   - engine status (Chromium + Firefox availability) is exposed via IPC, REST
//     and MCP;
//   - launching a Firefox profile fails gracefully when no Firefox is
//     installed (clear message, no hang, no partial state), and succeeds —
//     through the same gate — when one is (Slice 79.4).
// The two "availability" tests branch on the machine actually having Firefox,
// so the same file passes with and without a local installation. The fake
// binary launch paths live in j99 where the gates are exercised deterministically.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as http from 'node:http';
import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
import { filterKnownConsoleErrors } from './helpers/diag.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j98');

function apiRequest(port: number, token: string, method: string, p: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    headers.authorization = `Bearer ${token}`;
    if (payload) headers['content-length'] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: '127.0.0.1', port, path: p, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function mcpCall(port: number, token: string, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + token,
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function toolResult(res: any): any {
  const text = res?.result?.content?.[0]?.text || '';
  try { return JSON.parse(text); } catch { return {}; }
}

describe('J98 — Firefox engine capability', () => {
  let h: TestAppHandle;
  let restPort = 0;
  let restToken = '';
  let mcpPort = 0;
  let mcpToken = '';
  let firefoxInstalled = false;
  let engineStatus: any = null;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, env: { AGENT_BROWSER_API_PORT: '0' } });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      if (st && st.running && st.port > 0) { restPort = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(restPort).toBeGreaterThan(0);
    const rt = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken());
    restToken = rt.token;
    const mcpStart = Date.now();
    while (Date.now() - mcpStart < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.mcp.status());
      if (st.running) { mcpPort = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(mcpPort).toBeGreaterThan(0);
    const mt = await h.page.evaluate(() => (window as any).agentBrowser.api.mcp.revealToken());
    mcpToken = mt.token;
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it('engine-status IPC reports Chromium installed + a coherent Firefox status', async () => {
    const st = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.engineStatus());
    expect(st.chromium.installed).toBe(true);
    expect(st.firefox.engine).toBe('firefox');
    expect(typeof st.firefox.installed).toBe('boolean');
    expect(st.firefox.fingerprintParity).toBe(false);
    // Slice 79.4: this machine may or may not have Firefox; the status must
    // reflect reality and stay coherent in both cases.
    engineStatus = st;
    firefoxInstalled = st.firefox.installed === true;
    if (firefoxInstalled) {
      expect(st.firefox.managedInjection).toBe('prefs+bidi-preload');
      expect(st.firefox.hint).not.toContain('Firefox binary not found');
    } else {
      expect(st.firefox.managedInjection).toBe('none');
      expect(st.firefox.hint).toContain('Firefox binary not found');
    }
  }, 15000);

  it('creates a Firefox profile over IPC and it persists through list', async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: 'J98-Firefox-IPC', engine: 'firefox', locale: 'en-US',
    }));
    expect(r.dirId).toMatch(/^ab_/);
    const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const p = (list || []).find((x: any) => x.name === 'J98-Firefox-IPC');
    expect(p).toBeTruthy();
    expect(p.engine).toBe('firefox');
    // Slice 79: Firefox carries the same managed identity as Chromium (prefs +
    // BiDi preload injection); "off" is an explicit opt-out on both engines.
    expect(p.fingerprintMode).toBe('managed');
    expect(p.locale).toBe('en-US');
  }, 20000);

  it('the profile create dialog exposes a Firefox engine option (with note)', async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab('profiles'));
    await h.page.evaluate(() => (window as any).agentBrowser.newProfile());
    await h.page.waitForSelector('#dlg-profile', { state: 'visible', timeout: 5000 });
    await h.page.locator('#new-profile-browser').selectOption('firefox', { timeout: 5000 });
    await h.page.waitForFunction(() => {
      const note = document.getElementById('new-profile-firefox-opts');
      return note && note.style.display === 'block' && note.textContent!.includes('Firefox');
    }, { timeout: 5000 });
    await h.page.locator('#new-profile-name').fill('J98-Firefox-UI');
    await h.page.locator('#dlg-profile button[type="submit"]').click({ timeout: 5000 });
    await h.page.waitForSelector('#dlg-profile', { state: 'hidden', timeout: 8000 });
    await h.page.waitForTimeout(1000);
    const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const p = (list || []).find((x: any) => x.name === 'J98-Firefox-UI');
    expect(p).toBeTruthy();
    expect(p.engine).toBe('firefox');
    const cards = await h.page.locator('.profile-card').evaluateAll((els: any[]) => els.map((e) => e.textContent));
    expect(cards.some((t: string) => t.includes('J98-Firefox-UI') && t.includes('🦊'))).toBe(true);
  }, 30000);

  it('REST exposes /api/engine-status and engine in profile create/list/get', async () => {
    const st = await apiRequest(restPort, restToken, 'GET', '/api/engine-status');
    expect(st.status).toBe(200);
    expect(st.body.firefox.engine).toBe('firefox');
    expect(st.body.chromium.installed).toBe(true);

    const created = await apiRequest(restPort, restToken, 'POST', '/api/profiles', {
      name: 'J98-Firefox-REST', engine: 'firefox', locale: 'en-GB', tags: ['firefox'],
    });
    expect(created.status).toBe(201);
    const dirId = created.body.dirId;
    const detail = await apiRequest(restPort, restToken, 'GET', '/api/profiles/' + dirId);
    expect(detail.status).toBe(200);
    expect(detail.body.engine).toBe('firefox');
    expect(detail.body.tags).toContain('firefox');

    const list = await apiRequest(restPort, restToken, 'GET', '/api/profiles');
    expect(list.body.profiles.some((p: any) => p.dirId === dirId && p.engine === 'firefox')).toBe(true);
  }, 20000);

  it('launching a Firefox profile: graceful failure without Firefox, real launch with it', async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: 'J98-Launch-Fx', engine: 'firefox',
    }));
    const out: any = await h.page.evaluate(async (dirId: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.launch(dirId);
      return { success: res.success, error: res.error || '' };
    }, r.dirId);
    if (!firefoxInstalled) {
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/Firefox is required|Firefox binary not found/i);
      return;
    }
    // Real Firefox present: the same gate must let the managed profile come up.
    expect(out.success, out.error).toBe(true);
    try {
      const st: any = await h.page.evaluate((dirId: string) =>
        (window as any).agentBrowser.api.browser.status(dirId), r.dirId);
      expect(st.running).toBe(true);
      expect(st.cdpPort).toBeGreaterThan(0);
      expect(st.injectionProbe?.confirmed).toBe(true);
      expect(st.injectionProbe?.noiseActive).toBe(true);
      const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
      expect((list || []).find((p: any) => p.dirId === r.dirId)?.engine).toBe('firefox');
    } finally {
      const stop: any = await h.page.evaluate(async (dirId: string) => {
        const s: any = await (window as any).agentBrowser.api.browser.stop(dirId);
        return { success: s.success, error: s.error || '' };
      }, r.dirId);
      expect(stop.success, stop.error).toBe(true);
    }
  }, 120000);

  it('MCP exposes agent_browser_engine_status', async () => {
    const tools = await mcpCall(mcpPort, mcpToken, 'tools/list', {});
    const names = (tools.result?.tools || []).map((t: any) => t.name);
    expect(names).toContain('agent_browser_engine_status');

    const call = await mcpCall(mcpPort, mcpToken, 'tools/call', { name: 'agent_browser_engine_status', arguments: {} });
    expect(call.result?.isError).toBeFalsy();
    const r = toolResult(call);
    expect(r.firefox.engine).toBe('firefox');
    expect(r.chromium.installed).toBe(true);
  }, 20000);

  it('no unexpected console errors', () => {
    const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(errs.length, errs.join('\n')).toBe(0);
  });
});