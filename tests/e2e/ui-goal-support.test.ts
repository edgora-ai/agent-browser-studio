// SERIAL opt-in native renderer acceptance. Controlled provider/config fixtures,
// not production IPC proof. Never launch the real app/browser or read user data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(__dirname, '../..');
const enabled = process.env.AGENT_BROWSER_UI_SUPPORT_ACCEPTANCE === '1';
const native = enabled ? describe : describe.skip;

native('UI goal support — isolated native renderer, controlled fixtures', () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let scratch: string;
  let configFile: string;
  const errors: string[] = [];
  const read = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  beforeAll(async () => {
    const parent = process.env.AGENT_BROWSER_UI_SUPPORT_SCRATCH;
    if (!parent || !path.isAbsolute(parent)) throw new Error('Set an owned absolute AGENT_BROWSER_UI_SUPPORT_SCRATCH for SERIAL acceptance');
    const real = fs.realpathSync(parent);
    const temp = fs.realpathSync(os.tmpdir());
    if (!real.startsWith(temp + path.sep)) throw new Error('Acceptance scratch must be beneath the temporary directory');
    scratch = fs.mkdtempSync(path.join(real, 'support-native-'));
    for (const name of ['home', 'tmp', 'config', 'data', 'cache', 'm1', 'user-data']) fs.mkdirSync(path.join(scratch, name));
    configFile = path.join(scratch, 'fixture-config.json');
    fs.writeFileSync(configFile, JSON.stringify({ extensionEnabled: true, profiles: { A: { 'A-ext': true }, B: { 'B-ext': true } }, skills: [{ id: 'current-skill', title: 'Current skill', name: 'Current skill', shared: true, enabled: true, source: 'local', tags: ['KEEP', 'tag two'], tools: [], prompt: 'synthetic', version: '1' }], gates: { blockOnConsistencyConflict: false } }));
    const renderer = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('<head>', '<head><base href="' + pathToFileURL(path.join(ROOT, 'src/renderer/')).href + '">');
    const file = path.join(scratch, 'fixture.html'); fs.writeFileSync(file, renderer);
    const main = path.join(scratch, 'main.cjs');
    fs.writeFileSync(main, `const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(scratch, 'user-data'))});
app.disableHardwareAcceleration();
app.whenReady().then(() => {
 session.defaultSession.webRequest.onBeforeRequest((details, cb) => cb({cancel: /^https?:/.test(details.url)}));
 const win = new BrowserWindow({width:1100,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true}});
 win.loadFile(${JSON.stringify(file)});
});
app.on('window-all-closed', () => app.quit());\n`);
    const env: Record<string, string> = {
      PATH: process.env.PATH || '', HOME: path.join(scratch, 'home'), TMPDIR: path.join(scratch, 'tmp'),
      XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CACHE_HOME: path.join(scratch, 'cache'),
      M1_AGENT_TEST_DATA: path.join(scratch, 'm1'), LANG: 'en_US.UTF-8',
    };
    fs.writeFileSync(path.join(scratch, 'status.json'), JSON.stringify({ status: 'native fixture starting', fixture: 'synthetic', sourceRoot: ROOT }));
    app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron') as string, args: [main], env, timeout: 30000 });
    page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    await page.exposeFunction('__supportRead', read);
    await page.exposeFunction('__supportWrite', (value: unknown) => { fs.writeFileSync(configFile, JSON.stringify(value)); });
    await page.evaluate(() => {
      const w = window as any;
      w.__support = { mode: 'success', toasts: [] as unknown[], profiles: [{ dirId: 'fixture-profile', name: 'Fixture profile', lastModified: 1 }], proxies: [{ name: 'fixture-proxy' }] };
      const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const fixture = w.__support;
      fixture.queued = {}; fixture.requests = {}; fixture.calls = [];
      const reply = (kind: string, args: unknown[], fallback: () => unknown) => {
        fixture.calls.push({ kind, args });
        if (!fixture.queued[kind]) return Promise.resolve().then(fallback);
        return new Promise((resolve, reject) => { (fixture.requests[kind] ||= []).push({ args, resolve, reject }); });
      };
      const api = {
        profile: { get: async () => ({ name: 'Fixture profile' }) },
        proxy: { list: () => reply('proxy', [], () => fixture.proxies) },
        browser: { binary: async () => ({ installed: true, installedVersions: [] }), list: () => reply('profiles', [], () => fixture.profiles), presets: async () => [], create: async (params: unknown) => { fixture.calls.push({ kind: 'create', args: [params] }); return { success: false, error: 'fixture create refused' }; } },
        drm: { status: async () => ({ success: true, status: {} }) },
        updates: { status: async () => ({ success: true, state: {} }) },
        settings: {
          extensions: (id: string) => reply('extensions', [id], async () => { const c = await w.__supportRead(); return id === 'fixture-profile' ? [{ id: 'fixture-ext', name: 'Fixture extension', enabled: c.extensionEnabled }] : Object.entries(c.profiles[id]).map(([id, enabled]) => ({ id, name: id + ' name', enabled })); }),
          toggleExtension: async (id: string, ext: string, enabled: boolean) => { fixture.calls.push({ kind: 'toggle', args: [id, ext, enabled] }); const c = await w.__supportRead(); if (id === 'fixture-profile') c.extensionEnabled = enabled; else c.profiles[id][ext] = enabled; await w.__supportWrite(c); return { success: true }; },
          extensionRepository: (filter: string) => reply('repository', [filter], () => []),
          setRepositoryExtensionMeta: async (id: string, meta: unknown) => { fixture.calls.push({ kind: 'repo-meta', args: [id, meta] }); return { success: true }; },
          launchGates: async () => (await w.__supportRead()).gates,
          setLaunchGates: async (g: unknown) => { if (fixture.mode === 'rejected') throw new Error('fixture gate rejected'); if (fixture.mode === 'denied') return { success: false, error: 'fixture gate denied' }; const c = await w.__supportRead(); c.gates = g; await w.__supportWrite(c); return { success: true }; },
        },
        storage: { clearCache: async () => { throw new Error('fixture cache rejected'); }, info: async () => ({ profiles: [] }) },
        agent: {
          platformAdapters: { list: async () => [{ id: 'fixture-adapter', name: 'Fixture adapter', category: 'generic', domains: [], notes: '', selectorVersion: 1, lastVerifiedAt: '' }], get: () => new Promise((resolve, reject) => { fixture.full = { resolve, reject }; }) },
          skills: { marketplace: (filter: string) => reply('skills', [filter], async () => (await w.__supportRead()).skills), list: async () => (await w.__supportRead()).skills, setMeta: async (id: string, meta: unknown) => { fixture.calls.push({ kind: 'skill-meta', args: [id, meta] }); const c = await w.__supportRead(); Object.assign(c.skills.find((s: any) => s.id === id), meta); await w.__supportWrite(c); return { success: true }; } },
        },
      };
      const helpers = {
        esc, escAttr: esc, icon: (n: string) => '<svg data-icon="' + esc(n) + '"></svg>', toast: (text: string, level: string) => fixture.toasts.push({ text, level }),
        fmt: String, shortPath: String, renderBrowserBinaryCard: () => 'Fixture binary', updateBrowserStatus() {}, readHardwareFields: () => ({}), writeHardwareFields() {}, validateHardwareFields: () => [], bindHardwareFieldValidation() {},
        renderProxyOptions: () => '<option value="default">Default</option>', profileProxySelectionValue: () => 'default', proxyDisplayLabel: () => 'Default', parseProxySelection: (s: string) => ({ mode: s || 'default', name: null }),
        hardwareSummary: () => 'Fixture hardware', fingerprintCompleteness: () => 100, platformIcon: () => '', getSyncStatus: () => 'never',
      };
      w.i18n = { t: (_k: string, fallback: string) => fallback };
      w.agentBrowserAPI = api;
      w.agentBrowser = { api, R: api, state: { currentTab: 'profiles' }, helpers, ipc: { call: (_k: string, f: () => unknown) => f() }, interceptLicenseGate: () => false };
    });
    await page.addScriptTag({ path: path.join(ROOT, 'src/renderer/js/app/core.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/renderer/js/app/ipc.js') });
    await page.evaluate(() => { const w = window as any; w.agentBrowser.helpers.toast = (text: string, level: string) => w.__support.toasts.push({ text, level }); });
    for (const module of ['tabs', 'browser', 'extensions', 'agent-adapters', 'agent-skills', 'profiles', 'delegation']) await page.addScriptTag({ path: path.join(ROOT, 'src/renderer/js/app', module + '.js') });
  }, 45000);
  afterAll(async () => {
    if (app) await app.close();
    if (scratch) fs.writeFileSync(path.join(scratch, 'status.json'), JSON.stringify({ status: 'native fixture finished', pageErrors: errors, fixture: 'synthetic' }));
  });

  it('full recipe pending, missing, rejected and success states are visible using actual command buttons', async () => {
    // Show only this controlled subview; entering real Agent would create Chat.
    await page.evaluate(() => {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.getElementById('tab-agent')!.classList.add('active');
      document.getElementById('agent-view-chat')!.style.display = 'none';
      document.getElementById('agent-view-adapters')!.style.display = 'block';
    });
    await page.evaluate(() => (window as any).agentBrowser.agentLoadAdapters());
    const card = page.locator('.adapter-card[data-adapter-id="fixture-adapter"]');
    await card.locator('[data-cmd="adapterToggle"]').click();
    for (const outcome of ['missing', 'rejected', 'success']) {
      await card.locator('[data-cmd="adapterShowDetail"]').click();
      await page.waitForFunction(() => document.querySelector('.adapter-full-detail')?.textContent?.includes('Loading full recipe'));
      expect(await card.locator('.adapter-full-detail').isVisible()).toBe(true);
      await page.evaluate(mode => { const f = (window as any).__support.full; if (mode === 'rejected') f.reject(new Error('fixture recipe rejected')); else f.resolve(mode === 'missing' ? null : { loginCheck: 'fixture()', selectors: {} }); }, outcome);
      const text = outcome === 'missing' ? 'Adapter not found.' : outcome === 'rejected' ? 'fixture recipe rejected' : 'fixture()';
      await page.waitForFunction(value => document.querySelector('.adapter-full-detail')?.textContent?.includes(value), text);
      expect(await card.locator('.adapter-full-detail').isVisible()).toBe(true);
    }
  });
  it('extension title/Disable reflect synthetic config bytes after reopen', async () => {
    await page.evaluate(() => (window as any).agentBrowser.showExtensions('fixture-profile'));
    await page.waitForFunction(() => document.getElementById('ext-dlg-title')?.textContent?.includes('Fixture profile'));
    const checkbox = page.locator('#ext-list input'); await page.waitForFunction(() => (document.querySelector('#ext-list input') as HTMLInputElement)?.checked);
    await page.locator('#ext-list [data-ext-action="disable"]').click();
    await page.waitForFunction(() => (document.querySelector('#ext-list input') as HTMLInputElement)?.checked === false);
    expect(read().extensionEnabled).toBe(false); expect(await checkbox.isChecked()).toBe(false);
    await page.evaluate(() => { document.querySelector<HTMLDialogElement>('#dlg-extensions')!.close(); (window as any).agentBrowser.showExtensions('fixture-profile'); });
    await page.waitForFunction(() => (document.querySelector('#ext-list input') as HTMLInputElement)?.checked === false);
    expect(await page.locator('#ext-list').textContent()).toContain('Fixture extension');
    await page.evaluate(() => document.querySelector<HTMLDialogElement>('#dlg-extensions')!.close());
  });
  it('gate denial/rejection reverts real native checkbox; success reloads synthetic bytes', async () => {
    await page.evaluate(() => (window as any).agentBrowser.switchTab('browser'));
    await page.waitForFunction(() => !(document.getElementById('gate-consistency') as HTMLInputElement).disabled);
    for (const mode of ['denied', 'rejected', 'success']) {
      await page.evaluate(value => { (window as any).__support.mode = value; }, mode);
      await page.locator('#gate-consistency').check();
      await page.waitForFunction(() => !(document.getElementById('gate-consistency') as HTMLInputElement).disabled);
      expect(await page.locator('#gate-consistency').isChecked()).toBe(mode === 'success');
      expect(read().gates.blockOnConsistencyConflict).toBe(mode === 'success');
      expect(await page.locator('#gate-status').textContent()).toContain(mode === 'success' ? 'saved' : 'fixture gate');
    }
    await page.evaluate(() => (window as any).agentBrowser.loadBrowserTab());
    await page.waitForFunction(() => (document.getElementById('gate-consistency') as HTMLInputElement).checked);
  });
  it('failed profile create keeps native dialog/draft; New restores actual HTML defaults', async () => {
    await page.evaluate(() => (window as any).agentBrowser.newProfile());
    await page.locator('#new-profile-name').fill('Fixture failed draft');
    await page.locator('#dlg-profile button[type="submit"]').click();
    await page.waitForFunction(() => (window as any).__support.toasts.some((t: any) => t.text === 'fixture create refused'));
    expect(await page.locator('#dlg-profile').isVisible()).toBe(true); expect(await page.locator('#new-profile-name').inputValue()).toBe('Fixture failed draft');
    await page.evaluate(() => { (document.getElementById('new-agent-browser-webrtc-mode') as HTMLSelectElement).value = 'disable'; (document.getElementById('new-agent-browser-window-title-enabled') as HTMLInputElement).checked = false; document.querySelector<HTMLDialogElement>('#dlg-profile')!.close(); (window as any).agentBrowser.newProfile(); });
    expect(await page.locator('#new-agent-browser-webrtc-mode').inputValue()).toBe('auto'); expect(await page.locator('#new-agent-browser-window-title-enabled').isChecked()).toBe(true);
    await page.evaluate(() => document.querySelector<HTMLDialogElement>('#dlg-profile')!.close());
  });
  it('profile soft refresh retains native checkbox focus; last proxy disappears from batch', async () => {
    await page.evaluate(() => (window as any).agentBrowser.switchTab('profiles'));
    await page.locator('.profile-select-checkbox').waitFor(); await page.locator('.profile-select-checkbox').focus();
    await page.evaluate(() => { const w = window as any; w.__support.profiles[0].name = 'Changed fixture'; w.__support.proxies = []; w.agentBrowser.refreshProfilesSoft(); });
    await page.waitForFunction(() => document.querySelector('#profile-list .name')?.textContent === 'Changed fixture');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('profile-select-checkbox'))).toBe(true);
    expect(await page.locator('#batch-assign-proxy option[value="fixture-proxy"]').count()).toBe(0);
    await page.evaluate(() => (window as any).agentBrowser.clearAllCaches());
    await page.waitForFunction(() => (window as any).__support.toasts.some((t: any) => t.level === 'error' && t.text.includes('fixture cache rejected')));
    expect(errors).toEqual([]);
  });

  // PREPARED, NOT-RUN here. Actual pointer/keyboard controls below must be run
  // SERIAL in a separately authorized owned native snapshot after source freeze.
  const waitRequests = async (kind: string, count: number) => {
    await page.waitForFunction(({ kind, count }) => (window as any).__support.requests[kind]?.length === count, { kind, count });
  };
  const settle = async (kind: string, index: number, value: unknown, error = false) => {
    await page.evaluate(async ({ kind, index, value, error }) => {
      const request = (window as any).__support.requests[kind][index];
      if (error) request.reject(new Error(String(value))); else request.resolve(value);
      for (let i = 0; i < 40; i++) await Promise.resolve();
    }, { kind, index, value, error });
  };
  it('A rows vanish synchronously before pending B read; pointer/keyboard mutations use only B IDs and exact bytes', async () => {
    const before = read();
    await page.evaluate(() => (window as any).agentBrowser.showExtensions('A'));
    await page.locator('#ext-list [data-ext-action="disable"]').waitFor();
    await page.locator('#dlg-extensions [data-cmd="close-dialog"]').click();
    const pending = await page.evaluate(() => {
      const w = window as any; w.__support.queued.extensions = true; w.__support.requests.extensions = [];
      w.agentBrowser.showExtensions('B');
      return { actions: document.querySelectorAll('#ext-list [data-ext-action]').length, text: document.getElementById('ext-list')!.textContent };
    });
    expect(pending).toEqual({ actions: 0, text: '' });
    await waitRequests('extensions', 1);
    expect(await page.evaluate(() => (window as any).__support.calls.filter((c: any) => c.kind === 'toggle' && c.args[0] === 'B'))).toEqual([]);
    await page.evaluate(() => { (window as any).__support.queued.extensions = false; });
    await settle('extensions', 0, [{ id: 'B-ext', name: 'B-ext name', enabled: true }]);
    const disable = page.locator('#ext-list [data-ext-action="disable"]'); await disable.focus(); await disable.press('Enter');
    await page.waitForFunction(() => (document.querySelector('#ext-list input') as HTMLInputElement)?.checked === false);
    await page.locator('#ext-list input').check();
    await page.waitForFunction(() => (window as any).__support.calls.filter((c: any) => c.kind === 'toggle' && c.args[0] === 'B').length === 2);
    await page.waitForFunction(async () => (await (window as any).__supportRead()).profiles.B['B-ext'] === true);
    expect(await page.evaluate(() => (window as any).__support.calls.filter((c: any) => c.kind === 'toggle' && c.args[0] === 'B').map((c: any) => c.args))).toEqual([['B', 'B-ext', false], ['B', 'B-ext', true]]);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(JSON.stringify(before));
    await page.locator('#dlg-extensions [data-cmd="close-dialog"]').click();
    await page.evaluate(() => (window as any).agentBrowser.showExtensions('B')); await page.locator('#ext-list input').waitFor();
    expect(await page.locator('#ext-list input').isChecked()).toBe(true); expect(await page.locator('#ext-list').textContent()).toContain('B-ext name');
    expect(await page.evaluate(async () => { const rows = await (window as any).agentBrowser.api.settings.extensions('B'); return rows.filter((e: any) => e.id === 'B-ext' && e.name.includes('B-ext')); })).toHaveLength(1);
    await page.locator('#dlg-extensions [data-cmd="close-dialog"]').click();
  });
  it.each(['old-first', 'new-first', 'old-error', 'current-error', 'current-empty'])('native repository search retains latest reply/actions: %s', async mode => {
    await page.evaluate(() => {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active')); document.getElementById('tab-extensions')!.classList.add('active');
      const w = window as any; w.__support.queued.repository = true; w.__support.requests.repository = []; w.__support.calls = [];
    });
    await page.locator('#extension-repo-search').fill('older'); await waitRequests('repository', 1);
    await page.locator('#extension-repo-search').fill('current'); await waitRequests('repository', 2);
    const current = [{ id: 'current-ext', name: 'Current repository', source: 'store', shared: true, tags: ['KEEP'] }];
    const old = [{ id: 'old-ext', name: 'Old repository', source: 'store' }];
    if (mode === 'old-first') await settle('repository', 0, old);
    await settle('repository', 1, mode === 'current-error' ? 'CURRENT REPOSITORY ERROR <bad>' : mode === 'current-empty' ? [] : current, mode === 'current-error');
    if (mode !== 'old-first') await settle('repository', 0, mode === 'old-error' ? 'OLD REPOSITORY ERROR' : old, mode === 'old-error');
    const text = await page.locator('#extension-repo-list').textContent();
    expect(text).toContain(mode === 'current-error' ? 'CURRENT REPOSITORY ERROR <bad>' : mode === 'current-empty' ? 'No extensions' : 'Current repository'); expect(text).not.toContain('Old repository'); expect(text).not.toContain('OLD REPOSITORY ERROR');
    if (mode === 'current-error' || mode === 'current-empty') expect(await page.locator('#extension-repo-list [data-action]').count()).toBe(0);
    else {
      await page.evaluate(() => { (window as any).__support.queued.repository = false; });
      const share = page.locator('#extension-repo-list [data-action="repo-share"]'); await share.focus(); await share.press('Enter');
      await page.waitForFunction(() => (window as any).__support.calls.some((c: any) => c.kind === 'repo-meta'));
      expect(await page.evaluate(() => (window as any).__support.calls.filter((c: any) => c.kind === 'repo-meta').map((c: any) => c.args))).toEqual([['current-ext', { shared: false, tags: ['KEEP'] }]]);
    }
    await page.evaluate(() => { (window as any).__support.queued.repository = false; });
  });
  it.each(['old-first', 'new-first', 'old-error', 'current-error', 'old-proxy-error', 'current-proxy-error'])('native profile/proxy reversed replies preserve current cards/options: %s', async mode => {
    await page.evaluate(() => {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active')); document.getElementById('tab-profiles')!.classList.add('active');
      const w = window as any; w.__support.queued.profiles = true; w.__support.queued.proxy = true; w.__support.requests.profiles = []; w.__support.requests.proxy = [];
      w.agentBrowser.loadProfiles();
    });
    await waitRequests('profiles', 1); await page.evaluate(() => (window as any).agentBrowser.refreshProfilesSoft()); await waitRequests('profiles', 2); await waitRequests('proxy', 2);
    if (mode === 'old-first') { await settle('profiles', 0, []); await settle('proxy', 0, [{ name: 'removed' }]); }
    await settle('profiles', 1, mode === 'current-error' ? 'CURRENT LIST ERROR' : [{ dirId: 'current-id', name: 'Current profile', lastModified: 2 }], mode === 'current-error');
    await settle('proxy', 1, mode === 'current-proxy-error' ? 'CURRENT PROXY ERROR' : [], mode === 'current-proxy-error');
    if (mode !== 'old-first') { await settle('profiles', 0, mode === 'old-error' ? 'OLD LIST ERROR' : [], mode === 'old-error'); await settle('proxy', 0, mode === 'old-proxy-error' ? 'OLD PROXY ERROR' : [{ name: 'removed' }], mode === 'old-proxy-error'); }
    expect(await page.locator('#profile-list').textContent()).toContain(mode === 'current-error' ? 'CURRENT LIST ERROR' : mode === 'current-proxy-error' ? 'CURRENT PROXY ERROR' : 'Current profile');
    expect(await page.locator('#batch-assign-proxy option[value="removed"]').count()).toBe(0);
    await page.evaluate(() => { const f = (window as any).__support; f.queued.profiles = false; f.queued.proxy = false; });
  });
  it.each(['old-first', 'new-first', 'old-error', 'current-error'])('native create proxy loads retain real user input and exact submitted selection: %s', async mode => {
    await page.evaluate(() => { const w = window as any; w.__support.proxies = [{ name: 'chosen' }]; w.__support.calls = []; w.agentBrowser.newProfile(); });
    await page.waitForFunction(() => !!document.querySelector('#new-profile-proxy option[value="named:chosen"]'));
    expect(await page.evaluate(() => (window as any).__support.calls.filter((c: any) => c.kind === 'proxy').length)).toBe(1);
    await page.locator('#new-profile-proxy').selectOption('named:chosen'); await page.locator('#new-profile-name').fill('KEEP DRAFT');
    await page.evaluate(() => { const w = window as any; w.__support.queued.proxy = true; w.__support.requests.proxy = []; w.agentBrowser.loadNewProfileProxies(); w.agentBrowser.loadNewProfileProxies(); });
    await waitRequests('proxy', 2);
    if (mode === 'old-first') await settle('proxy', 0, [{ name: 'removed' }]);
    await settle('proxy', 1, mode === 'current-error' ? 'CURRENT CREATE PROXY ERROR' : [{ name: 'chosen' }, { name: 'added' }], mode === 'current-error');
    if (mode !== 'old-first') await settle('proxy', 0, mode === 'old-error' ? 'OLD CREATE PROXY ERROR' : [{ name: 'removed' }], mode === 'old-error');
    expect(await page.locator('#new-profile-proxy').inputValue()).toBe('named:chosen'); expect(await page.locator('#new-profile-name').inputValue()).toBe('KEEP DRAFT'); expect(await page.locator('#new-profile-proxy option[value="named:removed"]').count()).toBe(0);
    await page.locator('#dlg-profile button[type="submit"]').click();
    await page.waitForFunction(() => (window as any).__support.calls.some((c: any) => c.kind === 'create'));
    expect(await page.evaluate(() => (window as any).__support.calls.find((c: any) => c.kind === 'create').args[0])).toMatchObject({ name: 'KEEP DRAFT', proxyMode: 'named', proxyName: 'chosen' });
    expect(await page.locator('#dlg-profile').isVisible()).toBe(true);
    await page.evaluate(() => { (window as any).__support.queued.proxy = false; }); await page.locator('#dlg-profile [data-cmd="close-dialog"]').click();
  });
  it.each(['resolve', 'reject'])('native create close/reopen drops previous session proxy %s', async mode => {
    await page.evaluate(() => { const w = window as any; w.__support.queued.proxy = true; w.__support.requests.proxy = []; w.__support.toasts = []; w.agentBrowser.newProfile(); }); await waitRequests('proxy', 1);
    await page.locator('#dlg-profile [data-cmd="close-dialog"]').click();
    await page.evaluate(() => { const w = window as any; w.__support.queued.proxy = false; w.__support.proxies = [{ name: 'current' }]; w.agentBrowser.newProfile(); });
    await page.waitForFunction(() => !!document.querySelector('#new-profile-proxy option[value="named:current"]'));
    await page.locator('#new-profile-proxy').selectOption('named:current');
    await settle('proxy', 0, mode === 'reject' ? 'CLOSED PROXY ERROR' : [{ name: 'closed' }], mode === 'reject');
    expect(await page.locator('#new-profile-proxy').inputValue()).toBe('named:current'); expect(await page.locator('#new-profile-proxy option[value="named:closed"]').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__support.toasts)).toEqual([]); await page.locator('#dlg-profile [data-cmd="close-dialog"]').click();
  });
  it('full-core marketplace delegated keyboard action unshares exact ID/tags, then reopens/list/searches persisted bytes', async () => {
    const before = read();
    await page.evaluate(() => { const w = window as any; w.__support.calls = []; w.agentBrowser.skillMarket(); });
    await page.locator('#skill-market-list [data-action="skill-share"]').waitFor();
    await page.locator('#skill-market-search').fill('Current');
    await page.waitForFunction(() => document.querySelector('#skill-market-list [data-action="skill-share"]')?.textContent?.includes('Unshare'));
    const action = page.locator('#skill-market-list [data-action="skill-share"]'); await action.focus(); await action.press('Enter');
    await page.waitForFunction(async () => (await (window as any).__supportRead()).skills[0].shared === false);
    expect(await page.evaluate(() => (window as any).__support.calls.filter((c: any) => c.kind === 'skill-meta').map((c: any) => c.args))).toEqual([['current-skill', { shared: false, tags: ['KEEP', 'tag two'] }]]);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(JSON.stringify({ ...before, skills: [{ ...before.skills[0], shared: false }] }));
    await page.locator('#dlg-skill-market [data-cmd="close-dialog"]').click(); await page.evaluate(() => (window as any).agentBrowser.skillMarket());
    await page.waitForFunction(() => document.querySelector('#skill-market-list [data-action="skill-share"]')?.textContent?.includes('Share'));
    expect(await page.evaluate(async () => { const rows = await (window as any).agentBrowser.api.agent.skills.list(); return rows.filter((s: any) => s.id === 'current-skill' && s.title.includes('Current')); })).toHaveLength(1);
    await page.locator('#dlg-skill-market [data-cmd="close-dialog"]').click(); expect(errors).toEqual([]);
  });
});
