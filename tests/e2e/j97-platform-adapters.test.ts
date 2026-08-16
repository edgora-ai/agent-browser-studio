// J97: AI Skills Hub platform adapter catalog (Slice 76). Proves the hub is a
// real, reachable catalog everywhere the product has a surface:
//   - the renderer "Adapter Hub" sub-view lists and expands adapters;
//   - IPC (platform:adapters:list / get / detect) is bridged to the renderer;
//   - the loopback REST API exposes /api/platform-adapters;
//   - MCP exposes agent_browser_platform_adapters_list / _get / _detect.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as http from 'node:http';
import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
import { filterKnownConsoleErrors } from './helpers/diag.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j97');

function apiRequest(port: number, token: string, method: string, p: string, auth = true): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${token}`;
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

describe('J97 — AI Skills Hub platform adapter catalog', () => {
  let h: TestAppHandle;
  let restPort = 0;
  let restToken = '';
  let mcpPort = 0;
  let mcpToken = '';

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, env: { AGENT_BROWSER_API_PORT: '0' } });
    // REST
    const restStart = Date.now();
    while (Date.now() - restStart < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      if (st && st.running && st.port > 0) { restPort = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(restPort, 'REST API server must be running').toBeGreaterThan(0);
    const rt = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken());
    restToken = rt.token;
    // MCP
    const mcpStart = Date.now();
    while (Date.now() - mcpStart < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.mcp.status());
      if (st.running) { mcpPort = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(mcpPort, 'MCP server must be running').toBeGreaterThan(0);
    const mt = await h.page.evaluate(() => (window as any).agentBrowser.api.mcp.revealToken());
    mcpToken = mt.token;
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it('renderer Adapter Hub sub-view lists the catalog', async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab('agent'));
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub('adapters'));
    await h.page.waitForSelector('#agent-view-adapters', { state: 'visible', timeout: 5000 });
    await h.page.waitForFunction(() => {
      const el = document.getElementById('agent-adapters-list');
      return el && el.querySelectorAll('.adapter-card').length >= 6;
    }, { timeout: 8000 });
    const cards = await h.page.locator('#agent-adapters-list .adapter-card').evaluateAll((els: any[]) => els.map((e) => e.getAttribute('data-adapter-id')));
    expect(cards).toContain('amazon-seller');
    expect(cards).toContain('instagram');
    expect(cards).toContain('crypto-exchange');
    const body = await h.page.locator('#agent-adapters-list').textContent();
    expect(body).toContain('Amazon Seller');
  }, 20000);

  it('renderer can expand an adapter and load the full recipe', async () => {
    // expand the overview detail
    await h.page.evaluate(() => (window as any).agentBrowser.adapterToggle('crypto-exchange'));
    await h.page.waitForFunction(() => {
      const detail = document.querySelector('.adapter-card[data-adapter-id="crypto-exchange"] .adapter-detail');
      return detail && detail.style.display === 'block';
    }, { timeout: 8000 });
    const overview = await h.page.locator('.adapter-card[data-adapter-id="crypto-exchange"] .adapter-detail').textContent();
    expect(overview).toContain('Login URL hints');
    expect(overview).toContain('binance.com');
    // load the full recipe (loginCheck + selectors) from the main process
    await h.page.evaluate(() => (window as any).agentBrowser.adapterShowDetail('crypto-exchange'));
    await h.page.waitForFunction(() => {
      const holder = document.querySelector('.adapter-card[data-adapter-id="crypto-exchange"] .adapter-full-detail');
      return holder && holder.style.display === 'block' && holder.textContent.includes('loginCheck');
    }, { timeout: 8000 });
    const detail = await h.page.locator('.adapter-card[data-adapter-id="crypto-exchange"] .adapter-full-detail').textContent();
    expect(detail).toContain('loginCheck');
    expect(detail).toContain('browser_evaluate');
    expect(detail).toContain('otp');
  }, 20000);

  it('IPC list/get/detect work through the renderer bridge', async () => {
    const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.platformAdapters.list());
    expect(list.length).toBeGreaterThanOrEqual(14);
    expect(list.some((a) => a.id === 'ebay' && a.category === 'ecommerce')).toBe(true);

    const full = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.platformAdapters.get('google-ads'));
    expect(full).toBeTruthy();
    expect(typeof full.loginCheck).toBe('string');
    expect(full.loginCheck.length).toBeGreaterThan(20);
    expect(Object.keys(full.selectors)).toContain('loginForm');

    const none = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.platformAdapters.get('nope'));
    expect(none).toBeNull();

    const detected = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.platformAdapters.detect('https://www.ebay.co.uk/'));
    expect(detected.id).toBe('ebay');
  }, 15000);

  it('REST exposes /api/platform-adapters list + detail + detect', async () => {
    const list = await apiRequest(restPort, restToken, 'GET', '/api/platform-adapters?filter=SG');
    expect(list.status).toBe(200);
    expect(list.body.adapters.some((a: any) => a.id === 'crypto-exchange')).toBe(true);

    const full = await apiRequest(restPort, restToken, 'GET', '/api/platform-adapters/crypto-exchange');
    expect(full.status).toBe(200);
    expect(full.body.adapter.loginCheck).toBeTruthy();
    expect(full.body.adapter.selectors.challenge).toBeDefined();

    const missing = await apiRequest(restPort, restToken, 'GET', '/api/platform-adapters/does-not-exist');
    expect(missing.status).toBe(404);

    const detected = await apiRequest(restPort, restToken, 'GET', '/api/platform-adapter/detect?url=' + encodeURIComponent('https://www.facebook.com/'));
    expect(detected.status).toBe(200);
    expect(detected.body.adapter.id).toBe('facebook');

    const noAuth = await apiRequest(restPort, restToken, 'GET', '/api/platform-adapters', false);
    expect(noAuth.status).toBe(401);
  }, 20000);

  it('MCP exposes the platform adapter catalog tools', async () => {
    const tools = await mcpCall(mcpPort, mcpToken, 'tools/list', {});
    const names = (tools.result?.tools || []).map((t: any) => t.name);
    expect(names).toContain('agent_browser_platform_adapters_list');
    expect(names).toContain('agent_browser_platform_adapter_get');
    expect(names).toContain('agent_browser_platform_adapter_detect');

    const list = await mcpCall(mcpPort, mcpToken, 'tools/call', { name: 'agent_browser_platform_adapters_list', arguments: { filter: 'ecommerce' } });
    expect(list.result?.isError).toBeFalsy();
    const adapters = toolResult(list).adapters || [];
    expect(adapters.every((a: any) => a.category === 'ecommerce')).toBe(true);
    expect(adapters.some((a: any) => a.id === 'amazon-seller')).toBe(true);

    const got = await mcpCall(mcpPort, mcpToken, 'tools/call', { name: 'agent_browser_platform_adapter_get', arguments: { adapterId: 'instagram' } });
    expect(got.result?.isError).toBeFalsy();
    const adapter = toolResult(got).adapter;
    expect(adapter.id).toBe('instagram');
    expect(typeof adapter.loginCheck).toBe('string');

    const detect = await mcpCall(mcpPort, mcpToken, 'tools/call', { name: 'agent_browser_platform_adapter_detect', arguments: { url: 'https://ads.google.com/aw/overview' } });
    expect(toolResult(detect).adapter.id).toBe('google-ads');
  }, 20000);

  it('no unexpected console errors', () => {
    const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(errs.length, errs.join('\n')).toBe(0);
  });
});