// J99: Firefox parity — managed identity + runtime tools over a FAKE Firefox
// process (Slice 79). A fake Firefox binary stands in for the real engine and
// answers the WebDriver BiDi WebSocket protocol with canned results, so the
// full launch pipeline is exercised end-to-end without a real Firefox:
//   - prefs (user.js) + BiDi preload script injection (managed identity);
//   - the shared queued-cookie pipeline applied over BiDi storage commands;
//   - the fingerprint drift baseline + gate using live BiDi captures;
//   - the host environment-risk runtime checks over a running BiDi session.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';
import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
import { filterKnownConsoleErrors } from './helpers/diag.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j99');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'j99-fx-'));
const FAKE_FX = path.join(TMP, 'fake-firefox.js');
const RECORD = path.join(TMP, 'bidi-record.jsonl');
const STATE = path.join(TMP, 'fx-state.json');

// ── Fake Firefox binary ──────────────────────────────────────────────────────
// A node script the launcher can find via AGENT_BROWSER_FIREFOX_BINARY_PATH.
// It prints its version on `--version`, then serves `--remote-debugging-port`
// as a WebDriver BiDi WebSocket (exactly what the real engine prints), records
// every protocol exchange to AB_FAKE_FX_RECORD, and returns canned results so
// the app's BiDi pipeline (preload, evaluate, storage) runs for real.
function writeFakeFirefox(): void {
  const script = `#!/usr/bin/env node
// Fake Firefox for J99 (Slice 79): prints the BiDi endpoint and answers the
// protocol so the managed-launch pipeline can be tested without a real engine.
const fs = require('node:fs');
const WS_PATH = process.env.AB_FAKE_FX_WS || '';
const { WebSocketServer } = WS_PATH ? require(WS_PATH) : require('ws');
const RECORD = process.env.AB_FAKE_FX_RECORD || '';
const STATE = process.env.AB_FAKE_FX_STATE || '';
let n = 0;
function record(m) { if (RECORD) { try { fs.appendFileSync(RECORD, JSON.stringify(Object.assign({ pid: process.pid }, m)) + '\\n'); } catch (e) {} } }
function cannedFingerprint() {
  const fp = {
    seed: 4242, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
    platform: 'Win32', uaPlatform: 'Windows', tz: 'America/New_York', tzOffset: 300,
    hardwareConcurrency: 8, deviceMemory: 8, screenW: 1920, screenH: 1080,
    availLeft: 0, availTop: 0, screenX: 0, screenY: 0, outerWidth: 1920, outerHeight: 1040,
    innerWidth: 1920, innerHeight: 1040, devicePixelRatio: 1, canvasHash: 'j99-canvas-512',
    clientRect: '0,0,1,1', workerIdentity: '{}', plugins: '', mimeTypes: '', speechVoices: '',
    fontAvailability: '', fontCapabilityHash: null, audioHash: 'j99-audio-1', mediaDevices: '',
    storageQuota: 1073741824, doNotTrack: 1, systemColors: '', preferredColorScheme: 'light',
    webglCapabilityHash: 'j99-webgl', webgpuCapabilityHash: null,
    glVendor: 'Google Inc.', glUnmaskedVendor: 'Google Inc.',
    glRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE))), Intel Inc.)',
  };
  let shift = {};
  if (STATE) { try { shift = JSON.parse(fs.readFileSync(STATE, 'utf-8')).shift || {}; } catch (e) {} }
  return Object.assign({}, fp, shift);
}
function answer(method, params) {
  n += 1;
  switch (method) {
    case 'session.new':
      return { sessionId: 'j99-session-' + n, capabilities: {} };
    case 'browsingContext.getTree':
      return { contexts: [{ context: 'ctx-1', url: 'about:blank', children: [], parent: null }] };
    case 'script.addPreloadScript': {
      record({ t: 'preload', script: String((params && params.functionDeclaration) || '').slice(0, 20000) });
      return { script: 'pre-' + n };
    }
    case 'script.evaluate': {
      const expr = String((params && params.expression) || '');
      record({ t: 'eval', expr: expr.slice(0, 140) });
      let value = '{}';
      if (expr.indexOf('Agent Browser Studio-FP') !== -1) value = JSON.stringify(cannedFingerprint());
      else if (expr.indexOf('samples.push') !== -1) value = JSON.stringify({ samples: 60, median: 16.7, mean: 16.9 });
      else if (expr.indexOf('__agentBrowserFontProbeList') !== -1) value = JSON.stringify({});
      return { result: { type: 'string', value } };
    }
    case 'storage.getCookies':
      return { cookies: [] };
    case 'storage.setCookie':
      record({ t: 'set-cookie', params });
      return { success: true };
    case 'storage.deleteCookies':
      record({ t: 'delete-cookies', params });
      return {};
  }
  return undefined;
}
if (process.argv.indexOf('--version') !== -1) { process.stdout.write('Mozilla Firefox 138.0.2\\n'); process.exit(0); }
const pIdx = process.argv.indexOf('--remote-debugging-port');
const port = pIdx !== -1 ? Number(process.argv[pIdx + 1]) : 19222;
const wss = new WebSocketServer({ port: port, host: '127.0.0.1', path: '/session' });
wss.on('connection', (ws) => {
  record({ t: 'ws-open' });
  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    if (!msg || typeof msg.id !== 'number') return;
    const result = answer(msg.method, msg.params || {});
    if (result === undefined) {
      ws.send(JSON.stringify({ id: msg.id, error: { error: 'unknown command', message: 'Unsupported BiDi method: ' + msg.method } }));
      return;
    }
    record({ t: 'cmd', method: msg.method });
    ws.send(JSON.stringify({ id: msg.id, result }));
  });
  ws.on('close', () => record({ t: 'ws-close' }));
});
wss.on('listening', () => {
  process.stderr.write('WebDriver BiDi listening on ws://127.0.0.1:' + port + '/session\\n');
  process.stdout.write('Marionette  INFO  Listening on port ' + port + '\\n');
});
process.on('SIGTERM', () => { try { wss.close(); } catch (e) {} process.exit(0); });
process.on('uncaughtException', (e) => { record({ t: 'uncaught', error: String(e && e.stack || e) }); process.exit(1); });
process.on('unhandledRejection', (e) => record({ t: 'unhandledRejection', error: String(e && e.stack || e) }));
process.on('exit', (code, signal) => record({ t: 'exit', code: code, signal: signal }));
record({ t: 'boot', port: port });
`;
  fs.writeFileSync(FAKE_FX, script, { mode: 0o755 });
}

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

function readRecord(): any[] {
  if (!fs.existsSync(RECORD)) return [];
  return fs.readFileSync(RECORD, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function recordHas(pred: (m: any) => boolean): boolean {
  return readRecord().some(pred);
}

function setState(shift: Record<string, unknown> | null): void {
  fs.writeFileSync(STATE, JSON.stringify({ shift: shift || {} }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('J99 — Firefox parity over fake Firefox + BiDi', () => {
  let h: TestAppHandle;
  let restPort = 0;
  let restToken = '';
  let dirId = '';

  beforeAll(async () => {
    writeFakeFirefox();
    setState(null);
    try { fs.rmSync(RECORD, { force: true }); } catch { /* ignore */ }
    h = await setupTestApp({
      userDataDir: USERDATA,
      env: {
        AGENT_BROWSER_API_PORT: '0',
        AGENT_BROWSER_FIREFOX_BINARY_PATH: FAKE_FX,
        AB_FAKE_FX_RECORD: RECORD,
        AB_FAKE_FX_STATE: STATE,
        AB_FAKE_FX_WS: path.join(REPO, 'node_modules', 'ws'),
      },
    });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      if (st && st.running && st.port > 0) { restPort = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(restPort).toBeGreaterThan(0);
    const rt = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken());
    restToken = rt.token;
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it('engine-status reports the fake Firefox installed with BiDi managed injection', async () => {
    const st = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.engineStatus());
    expect(st.firefox.installed).toBe(true);
    expect(st.firefox.version).toBe('138.0.2');
    expect(st.firefox.managedInjection).toBe('prefs+bidi-preload');
    expect(st.firefox.fingerprintParity).toBe(false);
  }, 15000);

  it('launches a Firefox profile: prefs user.js, BiDi preload, queued cookies via BiDi', async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: 'J99-Firefox', engine: 'firefox', locale: 'en-US', timezone: 'America/New_York',
    }));
    dirId = r.dirId;
    expect(dirId).toMatch(/^ab_/);

    // Queue one cookie like the product would (shared pending-import pipeline).
    const queuePath = path.join(USERDATA, 'pending-cookie-imports', `${dirId}.json`);
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, JSON.stringify([
      { domain: 'example.com', name: 'j99_cookie', value: 'v1', path: '/', secure: false, httpOnly: true, sameSite: 0, expires: 0 },
    ]));

    const out: any = await h.page.evaluate(async (d: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.launch(d);
      return { success: res.success, error: res.error || '', pid: res.pid, port: res.port ?? res.cdpPort };
    }, dirId);
    expect(out.success, out.error).toBe(true);
    expect(out.pid).toBeGreaterThan(0);
    expect(out.port).toBeGreaterThan(0);

    // user.js prefs carry the managed identity (UA override family).
    const userJs = fs.readFileSync(path.join(USERDATA, 'profiles', dirId, 'user.js'), 'utf-8');
    expect(userJs).toContain('general.useragent.override');
    expect(userJs).toContain('Mozilla/5.0');

    // BiDi observed a preload registration with the fingerprint script.
    let deadline = Date.now() + 12000;
    while (Date.now() < deadline && !recordHas((m) => m.t === 'preload')) await sleep(200);
    const preloads = readRecord().filter((m) => m.t === 'preload');
    expect(preloads.length).toBeGreaterThan(0);
    expect(preloads[0].script).toContain('seedFromHex(cfg.canvas.seed)');
    expect(preloads[0].script).toContain('OffscreenCanvasRenderingContext2D.prototype');
    expect(preloads[0].script).toContain('navigator.gpu.requestAdapter');
    expect(preloads[0].script).toContain('Navigator.prototype, "platform"');

    // Queued cookies were applied over BiDi storage.setCookie and the queue cleared.
    deadline = Date.now() + 12000;
    while (Date.now() < deadline && !recordHas((m) => m.t === 'set-cookie')) await sleep(200);
    const sets = readRecord().filter((m) => m.t === 'set-cookie');
    expect(sets.length).toBeGreaterThan(0);
    expect(sets[0].params.cookie.name).toBe('j99_cookie');
    expect(sets[0].params.cookie.value).toEqual({ type: 'string', value: 'v1' });
    expect(sets[0].params.cookie.httpOnly).toBe(true);
    expect(fs.existsSync(queuePath)).toBe(false);

    // Environment-risk runtime probes ran over BiDi (rAF measurement happened).
    expect(recordHas((m) => m.t === 'cmd' && m.method === 'script.evaluate')).toBe(true);

    const st = await apiRequest(restPort, restToken, 'GET', '/api/profiles/' + dirId);
    expect(st.status).toBe(200);
    expect(recordHas((m) => m.t === 'cmd' && m.method === 'script.addPreloadScript')).toBe(true);
  }, 45000);

  it('fingerprint baseline captures over BiDi, then a shifted canvas blocks relaunch', async () => {
    // No baseline yet → read-only drift says unchecked, not an error.
    let d = await apiRequest(restPort, restToken, 'GET', `/api/profiles/${dirId}/drift`);
    expect(d.status).toBe(200);
    expect(d.body.ok).toBe(true);
    expect(d.body.hasBaseline).toBe(false);

    // Capture the baseline live (BiDi evaluate → canned fingerprint).
    const cap: any = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.captureBaseline(id);
      return { ok: res.ok, error: res.error || '', risky: res.risky, fields: res.fields };
    }, dirId);
    expect(cap.ok, cap.error + '\n--record--\n' + readRecord().slice(-8).map((m) => JSON.stringify(m)).join('\n')).toBe(true);
    expect(cap.risky).toBe(false);
    expect(cap.fields).toBeGreaterThan(10);

    d = await apiRequest(restPort, restToken, 'GET', `/api/profiles/${dirId}/drift`);
    expect(d.body.checked, 'drift#1: ' + JSON.stringify(d.body)).toBe(true);
    expect(d.body.risky, 'drift#1: ' + JSON.stringify(d.body)).toBe(false);

    // Shift a high-risk field while the browser is running: the read-only drift
    // check must report it, and the next launch must hit the drift gate.
    setState({ canvasHash: 'j99-canvas-SHIFTED' });
    d = await apiRequest(restPort, restToken, 'GET', `/api/profiles/${dirId}/drift`);
    expect(d.status, 'drift#2 status: ' + JSON.stringify(d.body)).toBe(200);
    expect(d.body.ok, 'drift#2: ' + JSON.stringify(d.body)).toBe(true);
    expect(d.body.risky, 'drift#2: ' + JSON.stringify(d.body)).toBe(true);
    const driftFields = (d.body.drift || []).map((x: any) => x.field);
    expect(driftFields).toContain('canvasHash');

    const stopped = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.stop(id);
      return { success: res.success ?? res.ok, error: res.error || '' };
    }, dirId);
    expect(stopped.success).toBe(true);

    // SIGTERM-exit is async in the app: launchBrowser short-circuits on a
    // "still alive" entry, so wait until the process is truly gone.
    let deadline = Date.now() + 15000;
    for (;;) {
      const st = await h.page.evaluate(async (id: string) => {
        const res: any = await (window as any).agentBrowser.api.browser.status(id);
        return { running: res.running };
      }, dirId);
      if (!st.running) break;
      if (Date.now() > deadline) throw new Error('firefox process did not stop within 15s');
      await sleep(300);
    }

    const rel: any = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.launch(id);
      return { success: res.success, error: res.error || '' };
    }, dirId);
    expect(rel.success, 'relaunch should have been drift-blocked: ' + JSON.stringify(rel) + '\n--record--\n' + readRecord().slice(-10).map((m) => JSON.stringify(m)).join('\n')).toBe(false);
    expect(rel.error).toMatch(/Fingerprint drift blocked/);

    // Clearing the shift restores a clean launch.
    setState(null);
    const rel2: any = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.launch(id);
      return { success: res.success, error: res.error || '', pid: res.pid };
    }, dirId);
    expect(rel2.success, rel2.error).toBe(true);
    expect(rel2.pid).toBeGreaterThan(0);
  }, 60000);

  it('REST runtime env-risk measures rAF over the running BiDi profile', async () => {
    const st = await apiRequest(restPort, restToken, 'GET', `/api/profiles/${dirId}/env-risk`);
    expect(st.status).toBe(200);
    expect(Array.isArray(st.body.findings)).toBe(true);
    expect(st.body.raf).toBeTruthy();
    expect(st.body.raf.samples).toBe(60);
    expect([true, false]).toContain(st.body.ok);
  }, 20000);

  it('stop closes the BiDi session and the process is gone', async () => {
    const stopped = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.stop(id);
      return { success: res.success ?? res.ok, error: res.error || '' };
    }, dirId);
    expect(stopped.success).toBe(true);
    await sleep(2500);
    const st = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.status(id);
      return { running: res.running, port: res.port ?? res.cdpPort };
    }, dirId);
    expect(st.running).toBe(false);
    expect(recordHas((m) => m.t === 'ws-close')).toBe(true);
  }, 30000);

  it('no unexpected console errors', () => {
    const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(errs.length, errs.join('\n')).toBe(0);
  });
});