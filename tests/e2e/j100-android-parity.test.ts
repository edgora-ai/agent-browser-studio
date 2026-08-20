// J100: Android/mobile parity over a FAKE Firefox process. A fake Firefox
// binary stands in for the real engine and answers the WebDriver BiDi protocol
// with canned results, so the launch pipeline is exercised end-to-end without a
// real browser. This journey verifies the mobile identity end-to-end:
//   - a mobile Android persona (touch, phone screen, mobile UA) is generated
//     from the seed and carried through the fingerprint config;
//   - the Firefox user.js prefs carry the mobile UA override;
//   - the BiDi preload injects the mobile platform/oscpu/appVersion surface,
//     the touch-event slots and maxTouchPoints;
//   - the managed-injection self-check answers with the Android identity and
//     the launch gate accepts it;
//   - the drift baseline captures over BiDi and the read-only gate stays green.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';
import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
import { filterKnownConsoleErrors } from './helpers/diag.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j100');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'j100-fx-'));
const FAKE_FX = path.join(TMP, 'fake-firefox.js');
const RECORD = path.join(TMP, 'bidi-record.jsonl');
const STATE = path.join(TMP, 'fx-state.json');

function writeFakeFirefox(): void {
  const script = `#!/usr/bin/env node
// Fake Firefox for J100: answers BiDi so the managed-launch pipeline can be
// tested end-to-end without a real engine. The probe echoes the platform the
// preload actually carries, so an Android identity is provable.
const fs = require('node:fs');
const WS_PATH = process.env.AB_FAKE_FX_WS || '';
const { WebSocketServer } = WS_PATH ? require(WS_PATH) : require('ws');
const RECORD = process.env.AB_FAKE_FX_RECORD || '';
const STATE = process.env.AB_FAKE_FX_STATE || '';
let n = 0;
function record(m) { if (RECORD) { try { fs.appendFileSync(RECORD, JSON.stringify(Object.assign({ pid: process.pid }, m)) + '\\n'); } catch (e) {} } }
function cannedFingerprint() {
  const fp = {
    seed: 4242,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv81', uaPlatform: 'Android', tz: 'Asia/Shanghai', tzOffset: -480,
    hardwareConcurrency: 8, deviceMemory: 12, screenW: 412, screenH: 915,
    availLeft: 0, availTop: 0, screenX: 0, screenY: 0, outerWidth: 412, outerHeight: 915,
    innerWidth: 412, innerHeight: 915, devicePixelRatio: 2.625, canvasHash: 'j100-canvas-512',
    clientRect: '0,0,1,1', workerIdentity: '{}', plugins: '', mimeTypes: '', speechVoices: '',
    fontAvailability: '', fontCapabilityHash: null, audioHash: 'j100-audio-1', mediaDevices: '',
    storageQuota: 1073741824, doNotTrack: 1, systemColors: '', preferredColorScheme: 'light',
    webglCapabilityHash: 'j100-webgl', webgpuCapabilityHash: null,
    glVendor: 'Google Inc. (Google)', glUnmaskedVendor: 'Google Inc. (Google)',
    glRenderer: 'ANGLE (Google, Vulkan 1.3.0 (Google, Mali-G710))',
  };
  let shift = {};
  if (STATE) { try { shift = JSON.parse(fs.readFileSync(STATE, 'utf-8')).shift || {}; } catch (e) {} }
  return Object.assign({}, fp, shift);
}
function managedCfgFromRecord() {
  if (!RECORD) return null;
  try {
    const lines = String(fs.readFileSync(RECORD, 'utf-8')).split('\\n').filter(Boolean);
    let cfg = null;
    for (const line of lines) {
      let m = null;
      try { m = JSON.parse(line); } catch (e) {}
      if (m && m.t === 'preload' && typeof m.script === 'string') {
        const mm = m.script.match(/var cfg = (\{.*?\});/);
        if (mm) { try { cfg = JSON.parse(mm[1]); } catch (e) {} }
      }
    }
    return cfg;
  } catch (e) { return null; }
}
function answer(method, params) {
  n += 1;
  switch (method) {
    case 'session.new':
      return { sessionId: 'j100-session-' + n, capabilities: {} };
    case 'browsingContext.getTree':
      return { contexts: [{ context: 'ctx-1', url: 'about:blank', children: [], parent: null }] };
    case 'browsingContext.create':
      return { context: 'ctx-probe-' + n };
    case 'browsingContext.close':
      return {};
    case 'script.addPreloadScript':
      record({ t: 'preload', script: String((params && params.functionDeclaration) || '').slice(0, 70000) });
      return { script: 'pre-' + n };
    case 'script.evaluate': {
      const expr = String((params && params.expression) || '');
      record({ t: 'eval', expr: expr.slice(0, 140) });
      let value = '{}';
      if (expr.indexOf('roxy-managed-probe') !== -1) {
        let dead = false;
        if (STATE) { try { dead = (JSON.parse(fs.readFileSync(STATE, 'utf-8')).probe || '') === 'dead'; } catch (e) {} }
        if (dead) {
          value = JSON.stringify({ webdriver: true, doubleDrawEqual: true, platform: 'Win32', language: 'en-US', screenWidth: 1920, hardwareConcurrency: 8 });
        } else {
          const cfg = managedCfgFromRecord() || {};
          value = JSON.stringify({
            webdriver: false, doubleDrawEqual: false,
            platform: cfg.platform || 'Win32',
            language: (cfg.languages && cfg.languages[0]) || 'en-US',
            screenWidth: cfg.screen ? cfg.screen.width : 1920,
            hardwareConcurrency: cfg.hardwareConcurrency != null ? cfg.hardwareConcurrency : 8,
          });
        }
      }
      else if (expr.indexOf('Agent Browser Studio-FP') !== -1) value = JSON.stringify(cannedFingerprint());
      else if (expr.indexOf('samples.push') !== -1) value = JSON.stringify({ samples: 60, median: 16.7, mean: 16.9 });
      else if (expr.indexOf('__agentBrowserFontProbeList') !== -1) value = JSON.stringify({});
      return { result: { type: 'string', value } };
    }
    case 'storage.getCookies':
      return { cookies: [] };
    case 'storage.setCookie':
      return { success: true };
    case 'storage.deleteCookies':
      return {};
  }
  return undefined;
}
if (process.argv.indexOf('--version') !== -1) { process.stdout.write('Mozilla Firefox 138.0.2\\n'); process.exit(0); }
const pIdx = process.argv.indexOf('--remote-debugging-port');
const port = pIdx !== -1 ? Number(process.argv[pIdx + 1]) : 19223;
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('J100 — Android mobile parity over fake Firefox + BiDi', () => {
  let h: TestAppHandle;
  let restPort = 0;
  let restToken = '';
  let dirId = '';

  beforeAll(async () => {
    writeFakeFirefox();
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

  it('launches an Android profile and injects the full mobile identity', async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: 'J100-Android', engine: 'firefox', platform: 'android', locale: 'zh-CN', timezone: 'Asia/Shanghai',
    }));
    dirId = r.dirId;
    expect(dirId).toMatch(/^ab_/);

    const out: any = await h.page.evaluate(async (d: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.launch(d);
      return { success: res.success, error: res.error || '', pid: res.pid };
    }, dirId);
    expect(out.success, out.error).toBe(true);
    expect(out.pid).toBeGreaterThan(0);

    // user.js carries the mobile UA family for the Android persona.
    const userJs = fs.readFileSync(path.join(USERDATA, 'profiles', dirId, 'user.js'), 'utf-8');
    expect(userJs).toContain('general.useragent.override');
    expect(userJs).toContain('Mozilla/5.0 (Android 14; Mobile;');

    // The BiDi preload embeds the mobile identity: Android platform surface,
    // touch points, phone screen geometry and the CJK mobile font pool.
    let deadline = Date.now() + 12000;
    while (Date.now() < deadline && !recordHas((m) => m.t === 'preload')) await sleep(200);
    const preloads = readRecord().filter((m) => m.t === 'preload');
    expect(preloads.length).toBeGreaterThan(0);
    const script = preloads[0].script;
    const cfg = JSON.parse(script.match(/var cfg = (\{.*?\});/)![1]);
    expect(cfg.platform).toBe('Linux armv81');
    expect(cfg.maxTouchPoints).toBe(5);
    expect(cfg.screen.mobile).toBe(true);
    expect(cfg.screen.outerWidth).toBe(cfg.screen.width);
    expect(cfg.userAgent).toContain('Android');
    expect(cfg.userAgent).toContain('Mobile');
    expect(cfg.hardwareProfile.fontProfile).toBe('android-system');
    expect(cfg.languages).toEqual(['zh-CN', 'zh']);
    expect(cfg.speechSynthesis.voices[0].name).toBe('Google 普通话（中国大陆）');
    expect(script).toContain('"5.0 (Android)"');
    expect(script).toContain('Linux armv8l');
    expect(script).toContain('ontouchstart');
    expect(script).toContain('def(Navigator.prototype, "maxTouchPoints"');
    // Mobile persona carries the plugin handshake G2 added: the preload builds
    // an empty Android plugin roster and only re-applies it on Navigator.
    expect(cfg.pluginProfile).toEqual({ pdfViewerEnabled: true, plugins: [], mimeTypes: [] });
    expect(script).toContain('def(Navigator.prototype, "plugins"');
    expect(script).toContain('def(Navigator.prototype, "pdfViewerEnabled"');
    expect(script).toContain('wcfg');

    // The managed-injection self-check ran in a probe tab and the launch gate
    // accepted the Android identity (platform echoed back as Linux armv81).
    deadline = Date.now() + 12000;
    while (Date.now() < deadline && !recordHas((m) => m.t === 'eval' && m.expr.indexOf('roxy-managed-probe') !== -1)) await sleep(200);
    const st = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.status(id);
      return { running: res.running, probe: res.injectionProbe };
    }, dirId);
    expect(st.probe && st.probe.checked, 'probe not reported: ' + JSON.stringify(st)).toBe(true);
    expect(st.probe.confirmed, 'probe verdict: ' + JSON.stringify(st.probe)).toBe(true);
    expect(st.probe.mismatches || []).toHaveLength(0);
  }, 45000);

  it('baseline captures the Android identity and the drift gate stays green', async () => {
    const cap: any = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.captureBaseline(id);
      return { ok: res.ok, error: res.error || '', risky: res.risky, fields: res.fields };
    }, dirId);
    expect(cap.ok, cap.error).toBe(true);
    expect(cap.risky).toBe(false);
    expect(cap.fields).toBeGreaterThan(10);

    const d = await apiRequest(restPort, restToken, 'GET', `/api/profiles/${dirId}/drift`);
    expect(d.status).toBe(200);
    expect(d.body.checked).toBe(true);
    expect(d.body.risky).toBe(false);
  }, 30000);

  it('a dead injection probe blocks the Android launch and recovers', async () => {
    const stopRes = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.stop(id);
      return { success: res.success ?? res.ok, error: res.error || '' };
    }, dirId);
    expect(stopRes.success).toBe(true);
    let deadline = Date.now() + 15000;
    for (;;) {
      const st = await h.page.evaluate(async (id: string) => {
        const res: any = await (window as any).agentBrowser.api.browser.status(id);
        return { running: res.running };
      }, dirId);
      if (!st.running) break;
      if (Date.now() > deadline) throw new Error('firefox did not stop');
      await sleep(300);
    }

    // Dead preload → the Android identity is not provable → launch must block.
    fs.writeFileSync(STATE, JSON.stringify({ shift: {}, probe: 'dead' }));
    const blocked: any = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.launch(id);
      return { success: res.success, error: res.error || '' };
    }, dirId);
    expect(blocked.success, 'launch should have been probe-blocked: ' + JSON.stringify(blocked)).toBe(false);
    expect(blocked.error).toMatch(/injection probe blocked/i);

    fs.writeFileSync(STATE, JSON.stringify({ shift: {} }));
    const rel: any = await h.page.evaluate(async (id: string) => {
      const res: any = await (window as any).agentBrowser.api.browser.launch(id);
      return { success: res.success, error: res.error || '', pid: res.pid };
    }, dirId);
    expect(rel.success, rel.error).toBe(true);
    expect(rel.pid).toBeGreaterThan(0);
  }, 60000);

  it('no unexpected console errors', () => {
    const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(errs.length, errs.join('\n')).toBe(0);
  });
});