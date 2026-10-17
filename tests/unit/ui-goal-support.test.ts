import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escape = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Controlled DOM fixture, not native layout evidence. Parse real markup and all
// generated cards; detaching a focused node resets focus as a browser does.
class El {
  attrs: Record<string, string> = {};
  children: El[] = [];
  parentNode: El | null = null;
  style: Record<string, string> = {};
  checked = false;
  disabled = false;
  open = false;
  private inputValue = '';
  get value() { return this.inputValue; }
  set value(value: string | number) { this.inputValue = String(value); } // Native form controls coerce numeric writes.
  scrollTop = 0;
  onclick: ((e: any) => void) | null = null;
  onchange: ((e: any) => void) | null = null;
  private text = '';
  dataset: Record<string, string>;
  constructor(public doc: Doc, public tagName: string) {
    this.dataset = new Proxy({}, {
      get: (_, k: string | symbol) => typeof k === 'string' ? this.attrs['data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())] : undefined,
      set: (_, k: string, v: string) => { this.attrs['data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())] = String(v); return true; },
    });
  }
  get id() { return this.attrs.id || ''; }
  set id(v: string) { this.attrs.id = v; }
  get className() { return this.attrs.class || ''; }
  set className(v: string) { this.attrs.class = v; }
  classList = {
    contains: (s: string) => this.className.split(/\s+/).includes(s),
    add: (...s: string[]) => { this.className = [...new Set([...this.className.split(/\s+/), ...s])].join(' '); },
    remove: (...s: string[]) => { this.className = this.className.split(/\s+/).filter(c => !s.includes(c)).join(' '); },
    toggle: (s: string, b: boolean) => { this.classList[b ? 'add' : 'remove'](s); },
  };
  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { this.clear(); this.text = String(v); }
  set innerHTML(v: string) { this.clear(); parse(String(v), this); if (this.tagName === 'SELECT') this.value = this.children.find(c => 'selected' in c.attrs)?.value ?? this.children[0]?.value ?? ''; }
  get innerHTML(): string { return this.textContent; }
  clear() { for (const c of [...this.children]) this.removeChild(c); this.text = ''; }
  appendChild(c: El): El { if (c.tagName === '#FRAGMENT') { for (const n of [...c.children]) this.appendChild(n); return c; } c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c: El) { if (c.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; this.children = this.children.filter(n => n !== c); c.parentNode = null; }
  contains(c: El | null): boolean { return this === c || this.children.some(n => n.contains(c)); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  listeners: Record<string, Array<(e: any) => void>> = {};
  addEventListener(name: string, fn: (e: any) => void) { (this.listeners[name] ||= []).push(fn); }
  dispatch(name: string) { for (const fn of this.listeners[name] || []) fn({ target: this }); }
  focus() { if (!this.disabled) this.doc.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  matches(sel: string): boolean { return match(this, sel); }
  closest(sel: string): El | null { for (let n: El | null = this; n; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel: string): El[] {
    if (sel.startsWith(':scope > ')) return this.children.filter(c => c.matches(sel.slice(9)));
    return this.children.flatMap(c => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]);
  }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] || null; }
  click() { if (this.disabled) return; for (let n: El | null = this; n; n = n.parentNode) n.onclick?.({ target: this }); }
}
function match(n: El, sel: string): boolean {
  const parts = sel.trim().split(/\s+(?![^\[]*\])/);
  const simple = (el: El, s: string) => {
    let ok = true;
    s = s.replace(/\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g, (_, k, v) => { ok &&= v === undefined ? k in el.attrs : el.attrs[k] === v; return ''; });
    s = s.replace(/#([\w-]+)/g, (_, id) => { ok &&= el.id === id; return ''; });
    s = s.replace(/\.([\w-]+)/g, (_, c) => { ok &&= el.classList.contains(c); return ''; });
    return ok && (!s || s === '*' || el.tagName === s.toUpperCase());
  };
  const walk = (el: El | null, i: number): boolean => {
    if (!el || !simple(el, parts[i])) return false;
    if (!i) return true;
    if (parts[i - 1] === '>') return walk(el.parentNode, i - 2);
    for (let p = el.parentNode; p; p = p.parentNode) if (walk(p, i - 1)) return true;
    return false;
  };
  return walk(n, parts.length - 1);
}
function parse(input: string, root: El) {
  input = input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const stack = [root];
  for (const token of input.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []) {
    if (/^<!/.test(token)) continue;
    if (/^<\//.test(token)) { const tag = token.slice(2, -1).trim().toUpperCase(); const i = stack.findLastIndex(e => e.tagName === tag); if (i > 0) stack.length = i; continue; }
    if (token.startsWith('<')) {
      const m = token.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/); if (!m) continue;
      const el = new El(root.doc, m[1].toUpperCase());
      for (const a of m[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.attrs[a[1]] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      el.value = el.attrs.value || ''; el.checked = 'checked' in el.attrs; el.disabled = 'disabled' in el.attrs;
      for (const p of (el.attrs.style || '').split(';')) { const i = p.indexOf(':'); if (i >= 0) el.style[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
      stack[stack.length - 1].appendChild(el);
      if (!['INPUT', 'BR', 'HR', 'IMG', 'META', 'LINK', 'SOURCE'].includes(el.tagName)) stack.push(el);
    } else { const text = new El(root.doc, '#TEXT'); text.textContent = decode(token); stack[stack.length - 1].appendChild(text); }
  }
  for (const sel of root.querySelectorAll('select')) sel.value = sel.children.find(c => 'selected' in c.attrs)?.value ?? sel.children.find(c => c.tagName === 'OPTION')?.value ?? '';
}
class Doc {
  root = new El(this, '#DOCUMENT');
  body = this.root;
  activeElement: El = this.body;
  documentElement = this.root;
  scrollingElement = this.root;
  constructor() { this.root.innerHTML = html; this.body = this.querySelector('body')!; this.activeElement = this.body; }
  getElementById(id: string) { return this.querySelector('#' + id); }
  querySelector(sel: string) { return this.root.querySelector(sel); }
  querySelectorAll(sel: string) { return this.root.querySelectorAll(sel); }
  createElement(tag: string) { return new El(this, tag.toUpperCase()); }
  createDocumentFragment() { return new El(this, '#FRAGMENT'); }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(modules: string[], fullCore = false) {
  const doc = new Doc();
  const api: any = {
    app: { paths: vi.fn(async () => ({ platform: 'win32' })) },
    browser: { binary: vi.fn(async () => ({ installed: true, installedVersions: [] })), list: vi.fn(async () => [{ dirId: 'fixture-profile', name: 'Fixture profile', lastModified: 1 }]), presets: vi.fn(async () => []), create: vi.fn(async () => ({ dirId: 'fixture-created' })) },
    profile: { get: vi.fn(async (id: string) => ({ name: 'Fixture ' + id })) },
    proxy: { list: vi.fn(async () => []) },
    settings: { launchGates: vi.fn(async () => ({ blockOnConsistencyConflict: false })), setLaunchGates: vi.fn(async () => ({ success: true })), extensions: vi.fn(async () => [{ id: 'fixture-ext', name: 'Fixture extension', enabled: true }]), toggleExtension: vi.fn(async () => ({ success: true })) },
    drm: { status: vi.fn(async () => ({ success: true, status: {} })) },
    updates: { status: vi.fn(async () => ({ success: true, state: { previousVersion: '0.1', installed: [{ version: '0.2', status: 'staged' }] } })), check: vi.fn(async () => ({ success: true, available: [] })), rollback: vi.fn(async () => ({ success: true })), activate: vi.fn(async () => ({ success: true })) },
    storage: { info: vi.fn(async () => ({ profiles: [] })), clearCache: vi.fn(async () => ({ freed: 0 })) },
    agent: { platformAdapters: { list: vi.fn(async () => [adapter('fixture-adapter')]), get: vi.fn(async () => ({ loginCheck: 'fixture()', selectors: { input: '#fixture' } })) }, skills: { marketplace: vi.fn(async () => []) } },
  };
  const helpers: any = {
    toast: vi.fn(), esc: escape, escAttr: escape, icon: (n: string) => '<svg data-icon="' + n + '"></svg>', fmt: (n: number) => n + ' bytes', shortPath: (s: string) => s,
    renderBrowserBinaryCard: () => '<div>Fixture binary</div>', updateBrowserStatus: vi.fn(),
    readHardwareFields: () => ({}), writeHardwareFields: vi.fn(), validateHardwareFields: () => [], bindHardwareFieldValidation: vi.fn(),
    parseProxySelection: (s: string) => ({ mode: s || 'default', name: null }), renderProxyOptions: () => '<option value="default">Default</option>', profileProxySelectionValue: () => 'default', proxyDisplayLabel: () => 'Default',
    hardwareSummary: () => 'Fixture hardware', fingerprintCompleteness: () => 100, platformIcon: () => '', getSyncStatus: () => 'never',
    renderSkillCard: (s: any) => '<div data-skill-id="' + escape(s.id) + '">' + escape(s.title) + '</div>', bindSkillCardActions: vi.fn(),
  };
  const agent: any = { api, R: api, helpers, state: { currentTab: 'profiles' }, ipc: { call: (_k: string, f: () => unknown) => f() }, switchTab: vi.fn(), interceptLicenseGate: vi.fn(() => false), closeCardMenus: vi.fn() };
  const timers: Array<() => void> = [];
  const window: any = { agentBrowser: agent, agentBrowserAPI: api, i18n: { t: (_k: string, f: string) => f }, localStorage: { getItem: () => null } };
  const context = vm.createContext({ window, document: doc, console, navigator: {}, setTimeout: (f: () => void) => { timers.push(f); return timers.length; }, clearTimeout() {}, Option: function(text: string, value: string) { const el = doc.createElement('option'); el.textContent = text; el.value = value; return el; } });
  if (fullCore) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/js/app/core.js'), 'utf8'), context, { filename: 'core.js' });
    // Only observe notifications; rendering, proxy parsing and action binding
    // below are the actual full-core helpers, not replacements.
    window.agentBrowser.helpers.toast = helpers.toast;
  }
  for (const m of modules) vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/js/app', m + '.js'), 'utf8'), context, { filename: m + '.js' });
  return { doc, api, window, context, agent: window.agentBrowser, helpers: window.agentBrowser.helpers, timers, el: (id: string) => doc.getElementById(id)! };
}
function adapter(id: string) { return { id, name: id, category: 'generic', selectorVersion: 1, lastVerifiedAt: '', domains: [], notes: '' }; }

function fixtureBusinessPreset(id: string) {
  return { id, icon: '', name: id, nameZh: id, nameSuffix: id, description: 'Synthetic regional preset', descriptionZh: '测试地区预设', region: 'United Kingdom', regionZh: '英国', proxyHint: 'UK exit', proxyHintZh: '英国出口', recommendedGates: {},
    profile: { platform: 'macos', timezone: 'Europe/London', locale: 'en-GB', webrtcMode: 'auto', geolocationMode: 'custom', geolocationLatitude: 51.5074, geolocationLongitude: -0.1278, geolocationAccuracy: 100, tags: ['uk'] } };
}

// All provider data in this suite is synthetic, not real IPC/native proof.
describe('host-aware profile defaults — whole renderer entrypoints', () => {
  it.each([['darwin', 'macos'], ['win32', 'windows']])('newProfile/createProfile use trusted %s host metadata, not navigator', async (host, platform) => {
    const h = harness(['profiles']);
    Object.defineProperty(h.context.navigator, 'platform', { get() { throw new Error('untrusted navigator platform read'); } });
    h.api.app.paths.mockResolvedValue({ platform: host });
    h.agent.newProfile(); await flush();
    expect(h.api.app.paths).toHaveBeenCalledTimes(1);
    expect(h.el('new-agent-browser-platform').value).toBe(platform);
    h.el('new-profile-name').value = 'Host default'; h.agent.createProfile(); await flush();
    expect(h.api.browser.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Host default', platform }));
  });

  it.each(['windows', ''])('late host metadata never overwrites an explicit user OS choice %j', async choice => {
    const h = harness(['profiles']); const pending = deferred<any>(); h.api.app.paths.mockReturnValue(pending.promise);
    h.agent.newProfile(); h.el('new-profile-name').value = 'KEEP DRAFT';
    const select = h.el('new-agent-browser-platform'); select.value = 'windows'; select.dispatch('change');
    select.value = choice; select.dispatch('change'); pending.resolve({ platform: 'darwin' }); await flush();
    expect(select.value).toBe(choice); expect(h.el('new-profile-name').value).toBe('KEEP DRAFT');
    expect(h.api.browser.create).not.toHaveBeenCalled();
  });

  it('a closed form host reply cannot populate the next form while its own reply is pending', async () => {
    const h = harness(['profiles']); const old = deferred<any>(); const current = deferred<any>();
    h.api.app.paths.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    h.agent.newProfile(); h.el('dlg-profile').close(); h.agent.newProfile();
    old.resolve({ platform: 'darwin' }); await flush();
    expect(h.el('new-agent-browser-platform').value).toBe('');
    current.resolve({ platform: 'win32' }); await flush();
    expect(h.el('new-agent-browser-platform').value).toBe('windows');
  });

  it.each(['resolve', 'reject'])('a closed form ignores its late host %s without changing its fields or guidance', async mode => {
    const h = harness(['profiles']); const pending = deferred<any>(); h.api.app.paths.mockReturnValue(pending.promise);
    h.agent.newProfile(); h.el('dlg-profile').close();
    const note = h.el('new-profile-platform-note').textContent;
    if (mode === 'resolve') pending.resolve({ platform: 'linux' }); else pending.reject(new Error('old host read failure'));
    await flush(); expect(h.el('new-agent-browser-platform').value).toBe('');
    expect(h.el('new-profile-platform-note').textContent).toBe(note); expect(h.helpers.toast).not.toHaveBeenCalled();
  });

  it.each(['linux', 'freebsd'])('unsupported %s is not inferred as Windows or presented as native eligibility', async platform => {
    const h = harness(['profiles']); h.api.app.paths.mockResolvedValue({ platform });
    h.agent.newProfile(); await flush(); expect(h.el('new-agent-browser-platform').value).toBe('');
    expect(h.el('new-profile-platform-note').attrs['data-i18n']).toBe('profile.platform.unsupported-host');
    expect(h.el('new-profile-platform-note').textContent).toContain('does not support native managed Chromium');
    h.el('new-profile-name').value = 'Portable only'; h.agent.createProfile(); await flush();
    expect(h.api.browser.create.mock.calls[0][0].platform).toBeUndefined();
  });

  it('a failed host read retains automatic creation and reports that the host is unavailable', async () => {
    const h = harness(['profiles']); h.api.app.paths.mockRejectedValue(new Error('synthetic unavailable'));
    h.agent.newProfile(); await flush(); expect(h.el('new-agent-browser-platform').value).toBe('');
    expect(h.el('new-profile-platform-note').attrs['data-i18n']).toBe('profile.platform.host-unavailable');
  });

  it('create while host metadata is pending omits platform and late metadata cannot change the closed form', async () => {
    const h = harness(['profiles']); const pending = deferred<any>(); h.api.app.paths.mockReturnValue(pending.promise);
    h.agent.newProfile(); h.el('new-profile-name').value = 'Fast submit'; h.agent.createProfile(); await flush();
    expect(h.api.browser.create.mock.calls[0][0].platform).toBeUndefined(); expect(h.el('dlg-profile').open).toBe(false);
    pending.resolve({ platform: 'darwin' }); await flush(); expect(h.el('new-agent-browser-platform').value).toBe('');
  });

  it('preset selection and catalog refresh preserve an explicit foreign OS while applying regional fields', async () => {
    const h = harness(['profiles']); h.api.app.paths.mockResolvedValue({ platform: 'darwin' });
    h.api.browser.presets.mockResolvedValue([fixtureBusinessPreset('regional')]); h.agent.newProfile(); await flush();
    h.el('new-agent-browser-platform').value = 'windows'; h.el('new-agent-browser-platform').dispatch('change');
    h.el('new-profile-preset').value = 'regional'; h.agent.presetChanged();
    expect(h.el('new-agent-browser-platform').value).toBe('windows');
    expect(h.el('new-agent-browser-timezone').value).toBe('Europe/London'); expect(h.el('new-agent-browser-locale').value).toBe('en-GB');
    expect(h.el('new-agent-browser-geolocation-accuracy').value).toBe('100');
    await h.agent.loadBusinessPresets(); expect(h.el('new-profile-preset').value).toBe('regional');
    h.agent.createProfile(); await flush();
    expect(h.api.browser.create).toHaveBeenCalledWith(expect.objectContaining({ platform: 'windows', businessPresetId: 'regional', timezone: 'Europe/London', locale: 'en-GB', geolocationMode: 'custom', geolocationLatitude: 51.5074, geolocationLongitude: -0.1278, geolocationAccuracy: 100 }));
  });

  it('an obsolete preset catalog cannot replace the next form catalog or its selected preset', async () => {
    const h = harness(['profiles']); const old = deferred<any>(); const current = deferred<any>();
    h.api.browser.presets.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    h.agent.newProfile(); h.el('dlg-profile').close(); h.agent.newProfile();
    current.resolve([fixtureBusinessPreset('current')]); await flush(); h.el('new-profile-preset').value = 'current';
    old.resolve([fixtureBusinessPreset('obsolete')]); await flush();
    expect(h.el('new-profile-preset').value).toBe('current');
    expect(h.el('new-profile-preset').querySelector('option[value="obsolete"]')).toBeNull();
    h.agent.presetChanged(); expect(h.el('new-profile-name').value).toBe('current');
  });

  it('renderer CSV creation forwards omitted and explicit OS values unchanged', async () => {
    const h = harness(['profiles']);
    h.api.browser.parseBulkCsv = vi.fn(async () => ({ ok: true, specs: [{ name: 'Automatic' }, ...['windows', 'macos', 'android'].map(platform => ({ name: platform, platform }))] }));
    h.el('bulk-import-text').value = 'synthetic CSV'; h.el('bulk-import-proxy').value = 'default';
    h.agent.doBulkImport(); await flush(); expect(h.api.browser.create).toHaveBeenCalledTimes(4);
    expect(h.api.browser.create.mock.calls.map((call: any[]) => call[0].platform)).toEqual([undefined, 'windows', 'macos', 'android']);
  });

  it.each([['firefox', 'managed', 'firefox'], ['chromium', 'off', undefined]])('host defaults preserve %s / %s contracts and explicit OS', async (browser, fingerprintMode, engine) => {
    const h = harness(['profiles']); h.api.app.paths.mockResolvedValue({ platform: 'darwin' }); h.agent.newProfile(); await flush();
    h.el('new-profile-browser').value = browser!; h.el('new-agent-browser-fingerprint-mode').value = fingerprintMode!;
    h.el('new-agent-browser-platform').value = 'windows'; h.el('new-agent-browser-platform').dispatch('change'); h.el('new-profile-name').value = 'Unchanged contract';
    h.agent.createProfile(); await flush(); expect(h.api.browser.create).toHaveBeenCalledWith(expect.objectContaining({ platform: 'windows', fingerprintMode, engine }));
  });

  it.each(['host-platform-mismatch', 'restart-required'])('launch refusal %s explains the browser restart boundary without changing metadata', async code => {
    const h = harness(['profiles']); h.api.browser.launch = vi.fn(async () => ({ success: false, code, error: 'low-level English refusal' }));
    h.api.browser.setMeta = vi.fn(async () => ({ success: true }));
    h.agent.launch('fixture-profile'); await flush();
    const [message, level] = h.helpers.toast.mock.calls.at(-1)!;
    expect(level).toBe('error'); expect(message).toContain('stop'); expect(message).toContain('browser'); expect(message).toContain('Studio');
    expect(message).not.toContain('low-level English refusal');
    if (code === 'host-platform-mismatch') expect(message).toContain('Edit the profile OS');
    expect(h.api.browser.create).not.toHaveBeenCalled(); expect(h.api.browser.setMeta).not.toHaveBeenCalled();
  });
});

describe('WebGL profile editing — metadata transport, not native GPU acceptance', () => {
  it.each([
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'darwin' },
    { platform: 'win32', arch: 'x64' },
  ])('keeps macOS GPU fields editable without claiming capability from $platform / $arch', async paths => {
    const h = harness(['ipc', 'profiles'], true);
    h.api.app.paths.mockResolvedValue(paths);
    h.api.browser.create.mockResolvedValue({ success: false, error: 'Synthetic storage refusal' });
    h.agent.newProfile(); await flush();
    h.el('new-agent-browser-platform').value = 'macos';
    h.el('new-profile-name').value = 'GPU metadata draft';
    for (const suffix of ['gpu-vendor', 'gpu-renderer']) {
      const field = h.el('new-agent-browser-' + suffix);
      expect(field.disabled).toBe(false); expect(field.attrs.readonly).toBeUndefined();
      expect((field as any).readOnly).not.toBe(true);
      expect(field.attrs['aria-describedby']).toBe('new-profile-gpu-help new-profile-gpu-scope');
    }
    expect(h.el('new-profile-gpu-help').textContent).toContain('native ARM64 macOS main process and selected ARM64 Chromium');
    expect(h.el('new-profile-gpu-scope').textContent).toContain('Editing is not proof of support');
    h.el('new-agent-browser-gpu-vendor').value = 'Google Inc. (Apple)';
    // A single explicit field remains a partial tuple constraint, not an invented renderer.
    h.agent.createProfile(); await flush();
    expect(h.api.browser.create).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'macos', gpuVendor: 'Google Inc. (Apple)', gpuRenderer: null,
    }));
    expect(h.el('dlg-profile').open).toBe(true);
    expect(h.el('new-agent-browser-gpu-vendor').value).toBe('Google Inc. (Apple)');
    expect(h.el('new-agent-browser-gpu-renderer').value).toBe('');
  });

  it.each(['Apple M2', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'])('edits and forwards %s unchanged to authoritative main validation', async renderer => {
    const h = harness(['ipc', 'profiles'], true);
    h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', name: 'Saved GPU draft', platform: 'macos', gpuVendor: 'Google Inc. (Apple)', gpuRenderer: renderer }]);
    h.api.browser.setMeta = vi.fn(async () => ({ success: false, error: 'Synthetic storage refusal' }));
    h.agent.editProfile('fixture-profile'); await flush();
    expect(h.el('agent-browser-meta-gpu-renderer').value).toBe(renderer);
    expect(h.el('agent-browser-meta-gpu-vendor').disabled).toBe(false);
    expect(h.el('agent-browser-meta-gpu-renderer').disabled).toBe(false);
    expect(h.el('agent-browser-meta-gpu-renderer').attrs['aria-describedby']).toBe('edit-profile-gpu-help edit-profile-gpu-scope');
    h.agent.saveBrowserMeta(); await flush();
    expect(h.api.browser.setMeta).toHaveBeenCalledWith('fixture-profile', expect.objectContaining({ platform: 'macos', gpuVendor: 'Google Inc. (Apple)', gpuRenderer: renderer }));
    expect(h.el('agent-browser-meta-gpu-renderer').value).toBe(renderer);
    // Clearing is explicit and sent as null, not a renderer-side auto-migration.
    h.el('agent-browser-meta-gpu-vendor').value = ''; h.el('agent-browser-meta-gpu-renderer').value = '';
    h.agent.saveBrowserMeta(); await flush();
    expect(h.api.browser.setMeta).toHaveBeenLastCalledWith('fixture-profile', expect.objectContaining({ gpuVendor: null, gpuRenderer: null }));
  });

  for (const locale of ['en-US', 'zh-CN']) {
    for (const entrypoint of ['launch', 'create', 'save']) {
      it.each(['response', 'throw'])(`${locale} localizes only the stable GPU backend refusal in ${entrypoint} (%s)`, async delivery => {
        const h = harness(['ipc', 'profiles'], true);
        // Load the shipped dictionary, all three merge layers included. The DOM
        // fixture is not a browser/native-capability or persistence proof.
        (h.doc as any).addEventListener = vi.fn();
        h.context.localStorage = { getItem: () => null, setItem: vi.fn() };
        h.context.navigator.language = locale;
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/js/i18n.js'), 'utf8'), h.context, { filename: 'i18n.js' });
        expect(h.window.i18n.get()).toBe(locale);
        const raw = "Error invoking remote method 'browser:launch': Error: Unsupported GPU overrides for Chromium: synthetic unsupported tuple";
        const refuse = vi.fn(async () => {
          if (delivery === 'throw') throw new Error(raw);
          return { success: false, error: raw };
        });
        if (entrypoint === 'launch') {
          h.api.browser.launch = refuse; h.agent.launch('fixture-profile');
        } else if (entrypoint === 'create') {
          h.api.browser.create = refuse; h.agent.newProfile(); await flush();
          h.el('new-profile-name').value = 'GPU draft'; h.agent.createProfile();
        } else {
          h.api.browser.setMeta = refuse; h.agent.editProfile('fixture-profile'); await flush();
          h.agent.saveBrowserMeta();
        }
        await flush();
        expect(refuse).toHaveBeenCalledTimes(1);
        const [message, level] = h.helpers.toast.mock.calls.at(-1)!;
        expect(level).toBe('error');
        expect(message).toBe(h.window.i18n.t('launch.gpu-unsupported'));
        expect(message).toContain(locale === 'zh-CN' ? '主进程' : 'main process');
        expect(message).not.toContain('synthetic unsupported tuple');
        if (entrypoint === 'launch') expect(h.api.browser.create).not.toHaveBeenCalled();
      });
    }
  }

  it('does not replace an unrelated backend error with GPU guidance', async () => {
    const h = harness(['profiles']);
    h.api.browser.launch = vi.fn(async () => ({ success: false, error: 'Synthetic unrelated launch refusal' }));
    h.agent.launch('fixture-profile'); await flush();
    expect(h.helpers.toast.mock.calls.at(-1)).toEqual(['Synthetic unrelated launch refusal', 'error']);
  });
});

describe('UI goal support — whole modules and production ID contracts', () => {
  it.each(['pending', 'missing', 'rejected', 'success'])('first full adapter detail is visible: %s', async mode => {
    const h = harness(['agent-adapters']); h.agent.agentLoadAdapters(); await flush(); h.agent.adapterToggle('fixture-adapter');
    const d = deferred<any>(); h.api.agent.platformAdapters.get.mockReturnValue(d.promise); h.agent.adapterShowDetail('fixture-adapter');
    const holder = h.doc.querySelector('.adapter-full-detail')!;
    expect(holder.style.display).toBe('block'); expect(holder.textContent).toContain('Loading');
    if (mode === 'pending') return;
    if (mode === 'rejected') d.reject(new Error('fixture denied <script>'));
    else d.resolve(mode === 'missing' ? null : { loginCheck: 'fixture()', selectors: { input: '#fixture' } });
    await flush(); expect(holder.style.display).toBe('block');
    expect(holder.textContent).toContain(mode === 'missing' ? 'not found' : mode === 'rejected' ? 'fixture denied <script>' : 'fixture()');
    expect(holder.querySelector('script')).toBeNull();
  });
  it.each(['resolve', 'reject'])('late adapter search %s cannot replace current results', async mode => {
    const h = harness(['agent-adapters']); const old = deferred<any>(); h.api.agent.platformAdapters.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([adapter('fixture-new')]);
    h.agent.agentLoadAdapters(); h.el('adapter-hub-search').value = 'new'; h.agent.agentLoadAdapters(); await flush();
    if (mode === 'reject') old.reject(new Error('fixture old failure')); else old.resolve([adapter('fixture-old')]);
    await flush(); expect(h.el('agent-adapters-list').textContent).toContain('fixture-new'); expect(h.el('agent-adapters-list').textContent).not.toContain('fixture-old');
  });
  it.each(['resolve', 'reject'])('late skill search %s cannot replace current results/actions', async mode => {
    const h = harness(['agent-skills']); const old = deferred<any>(); h.api.agent.skills.marketplace.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ id: 'fixture-new', title: 'Current fixture skill' }]);
    h.agent.refreshSkillMarket(); h.el('skill-market-search').value = 'new'; h.agent.refreshSkillMarket(); await flush();
    if (mode === 'reject') old.reject(new Error('fixture old failure')); else old.resolve([{ id: 'fixture-old', title: 'Old fixture skill' }]);
    await flush(); expect(h.el('skill-market-list').textContent).toContain('Current fixture skill'); expect(h.helpers.bindSkillCardActions).toHaveBeenCalledTimes(1);
    expect(h.helpers.bindSkillCardActions).toHaveBeenCalledWith(h.el('skill-market-list'), [{ id: 'fixture-new', title: 'Current fixture skill' }], true);
  });
  it('repeated full-detail requests keep the newest detail/error', async () => {
    const h = harness(['agent-adapters']); h.agent.agentLoadAdapters(); await flush(); const old = deferred<any>();
    h.api.agent.platformAdapters.get.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ loginCheck: 'new_fixture()', selectors: {} });
    h.agent.adapterShowDetail('fixture-adapter'); h.agent.adapterShowDetail('fixture-adapter'); await flush(); old.resolve({ loginCheck: 'old_fixture()', selectors: {} }); await flush();
    expect(h.doc.querySelector('.adapter-full-detail')!.textContent).toContain('new_fixture()');
  });
  it('late extension profile metadata and list cannot relabel current profile', async () => {
    const h = harness(['extensions']); const metadata = deferred<any>(); const list = deferred<any>();
    h.api.profile.get.mockReturnValueOnce(metadata.promise).mockResolvedValueOnce({ name: 'Current fixture profile' });
    h.api.settings.extensions.mockReturnValueOnce(list.promise).mockResolvedValueOnce([{ id: 'fixture-new', name: 'Current fixture extension', enabled: false }]);
    h.agent.showExtensions('fixture-old'); h.agent.showExtensions('fixture-new'); await flush(); metadata.resolve({ name: 'Old fixture profile' }); list.resolve([{ id: 'fixture-old', name: 'Old fixture extension' }]); await flush();
    expect.soft(h.el('ext-dlg-title').textContent).toContain('Current fixture profile'); expect.soft(h.el('ext-list').textContent).toContain('Current fixture extension');
  });
  it('extension title addresses the labelled span itself', async () => {
    const h = harness(['extensions']); expect(h.el('ext-dlg-title').attrs['data-i18n']).toBe('ext.dlg.title'); expect(h.el('ext-dlg-title').querySelector('[data-i18n]')).toBeNull();
    h.agent.showExtensions('fixture-profile'); await flush(); expect(h.el('ext-dlg-title').textContent).toBe('Extensions — Fixture fixture-profile');
  });
  it('Disable reads synthetic persisted config back, unchecks, reloads and lists/searches same ID', async () => {
    const h = harness(['extensions']); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-support-config-')); const file = path.join(dir, 'config.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ profiles: { 'fixture-profile': { extensions: { 'fixture-ext': true } } } }));
      const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = () => [{ id: 'fixture-ext', name: 'Fixture extension', enabled: read().profiles['fixture-profile'].extensions['fixture-ext'] }];
      h.api.settings.extensions.mockImplementation(async () => list());
      h.api.settings.toggleExtension.mockImplementation(async (id: string, ext: string, enabled: boolean) => { const c = read(); c.profiles[id].extensions[ext] = enabled; fs.writeFileSync(file, JSON.stringify(c)); return { success: true }; });
      h.agent.showExtensions('fixture-profile'); await flush(); const checkbox = () => h.el('ext-list').querySelector('input[data-ext-action="toggle"]')!;
      expect(checkbox().checked).toBe(true); h.el('ext-list').querySelector('[data-ext-action="disable"]')!.click(); await flush();
      expect(read().profiles['fixture-profile'].extensions['fixture-ext']).toBe(false); expect(checkbox().checked).toBe(false);
      h.agent.showExtensions('fixture-profile'); await flush(); expect(checkbox().checked).toBe(false); expect(list().find(e => e.id === 'fixture-ext')).toMatchObject({ enabled: false }); expect(list().filter(e => e.name.includes('Fixture'))).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['denied', 'rejected'])('extension toggle %s reads actual state back', async mode => {
    const h = harness(['extensions']); h.agent.showExtensions('fixture-profile'); await flush();
    const c = h.el('ext-list').querySelector('input')!; c.checked = false;
    if (mode === 'denied') h.api.settings.toggleExtension.mockResolvedValue({ success: false, error: 'fixture denied' }); else h.api.settings.toggleExtension.mockRejectedValue(new Error('fixture rejected'));
    h.el('ext-list').onchange!({ target: c }); await flush(); expect(h.el('ext-list').querySelector('input')!.checked).toBe(true); expect(h.helpers.toast.mock.calls.at(-1)?.[1]).toBe('error');
  });
  it.each(['denied', 'rejected'])('gate save %s reports failure and restores persisted selection', async mode => {
    const h = harness(['browser']); h.agent.loadBrowserTab(); await flush(); const c = h.el('gate-consistency'); c.checked = true;
    if (mode === 'denied') h.api.settings.setLaunchGates.mockResolvedValue({ success: false, error: 'fixture gate denied' }); else h.api.settings.setLaunchGates.mockRejectedValue(new Error('fixture gate rejected'));
    c.onchange!({ target: c }); await flush(); expect(c.checked).toBe(false); expect(h.el('gate-status').textContent).toContain('fixture gate');
  });
  it('gate successful save reads config bytes back; pending gates reject duplicate submissions', async () => {
    const h = harness(['browser']); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-support-gates-')); const file = path.join(dir, 'config.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ launchGates: { blockOnConsistencyConflict: false } })); const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).launchGates;
      h.api.settings.launchGates.mockImplementation(async () => read()); const wait = deferred<any>();
      h.api.settings.setLaunchGates.mockImplementation(async (g: any) => { await wait.promise; fs.writeFileSync(file, JSON.stringify({ launchGates: g })); return { success: true }; });
      h.agent.loadBrowserTab(); await flush(); const c = h.el('gate-consistency'); c.checked = true; c.onchange!({}); expect(c.disabled).toBe(true); c.onchange!({}); expect(h.api.settings.setLaunchGates).toHaveBeenCalledTimes(1);
      wait.resolve(null); await flush(); expect(read().blockOnConsistencyConflict).toBe(true); expect(c.disabled).toBe(false); expect(h.el('gate-status').textContent).toBe('saved');
      h.agent.loadBrowserTab(); await flush(); expect(c.checked).toBe(true); expect(Object.keys(read())).toContain('blockOnConsistencyConflict');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('gate read failure is visible and old read cannot overwrite a newer save/readback', async () => {
    const h = harness(['browser']); h.api.settings.launchGates.mockRejectedValueOnce(new Error('fixture policy unreadable')); h.agent.loadBrowserTab(); await flush(); expect(h.el('gate-status').textContent).toContain('fixture policy unreadable');
    const old = deferred<any>(); h.api.settings.launchGates.mockReturnValueOnce(old.promise).mockResolvedValue({ blockOnConsistencyConflict: true }); h.agent.loadBrowserTab();
    const c = h.el('gate-consistency'); c.checked = true; c.onchange!({}); await flush(); old.resolve({ blockOnConsistencyConflict: false }); await flush(); expect(c.checked).toBe(true);
  });
  it('update errors are literal text, not escaped entities or HTML', async () => {
    const h = harness(['browser']); h.api.updates.check.mockResolvedValue({ success: false, error: 'A&B <bad>' }); h.agent.refreshUpdatesStatus(); await flush(); expect(h.el('updates-status').textContent).toBe('Check failed: A&B <bad>');
    h.api.updates.rollback.mockResolvedValue({ success: false, error: 'C&D <bad>' }); h.el('app-updates-card').querySelector('[data-upd-action="rollback"]')!.click(); await flush(); expect(h.el('updates-status').textContent).toBe('Failed: C&D <bad>'); expect(h.el('updates-status').querySelector('bad')).toBeNull();
  });
  it.each(['clearCache', 'clearAllCaches'])('storage %s rejection has actionable error, no success', async method => {
    const h = harness(['tabs']); h.api.storage.clearCache.mockRejectedValue(new Error('fixture cache denied')); const result = h.agent[method]('fixture-profile'); await Promise.resolve(result); await flush(); expect(h.helpers.toast).toHaveBeenCalledWith(expect.stringContaining('fixture cache denied'), 'error'); expect(h.api.storage.info).not.toHaveBeenCalled();
  });
  it('storage clear verifies actual synthetic bytes, reloaded ID/list totals', async () => {
    const h = harness(['tabs']); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-support-bytes-')); const cache = path.join(dir, 'cache.bin'); const kept = path.join(dir, 'profile.bin');
    try {
      fs.writeFileSync(cache, Buffer.alloc(128)); fs.writeFileSync(kept, Buffer.alloc(64));
      h.api.storage.clearCache.mockImplementation(async () => { const freed = fs.statSync(cache).size; fs.unlinkSync(cache); return { freed }; });
      h.api.storage.info.mockImplementation(async () => ({ totalProfileBytes: fs.statSync(kept).size + (fs.existsSync(cache) ? fs.statSync(cache).size : 0), profiles: [{ dirId: 'fixture-profile', name: 'Fixture profile', sizeBytes: fs.statSync(kept).size }] }));
      await h.agent.clearCache('fixture-profile'); await flush(); expect(fs.existsSync(cache)).toBe(false); expect(fs.readFileSync(kept)).toHaveLength(64); expect(h.el('stat-profile-total').textContent).toBe('64 bytes');
      h.agent.loadStorage(); await flush(); expect(h.el('storage-profile-list').querySelector('[data-dir-id="fixture-profile"]')).not.toBeNull(); expect(h.el('storage-profile-list').textContent).toContain('Fixture profile');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([{ success: false, error: 'fixture create denied' }, null, {}])('non-license create failure retains dialog/draft: %j', async response => {
    const h = harness(['tabs', 'profiles']); h.agent.newProfile(); await flush(); h.el('new-profile-name').value = 'Fixture draft'; h.api.browser.create.mockResolvedValue(response); h.agent.createProfile(); await flush();
    expect(h.el('dlg-profile').open).toBe(true); expect(h.el('new-profile-name').value).toBe('Fixture draft'); expect(h.helpers.toast.mock.calls.some((c: unknown[]) => c[1] === 'success')).toBe(false); expect(h.helpers.toast.mock.calls.at(-1)?.[1]).toBe('error');
  });
  it('successful create reloads synthetic config and finds the created ID; rejected create preserves draft', async () => {
    const h = harness(['tabs', 'profiles']); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-support-create-')); const file = path.join(dir, 'config.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ profiles: [] })); const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).profiles;
      h.api.browser.list.mockImplementation(async () => read()); h.api.browser.create.mockImplementation(async (p: any) => { const profiles = read(); profiles.push({ ...p, dirId: 'fixture-created', lastModified: 1 }); fs.writeFileSync(file, JSON.stringify({ profiles })); return { dirId: 'fixture-created' }; });
      h.agent.newProfile(); await flush(); h.el('new-profile-name').value = 'Fixture new profile'; h.agent.createProfile(); await flush(); expect(h.el('dlg-profile').open).toBe(false); expect(read().find((p: any) => p.dirId === 'fixture-created').name).toBe('Fixture new profile');
      h.agent.loadProfiles(); await flush(); expect(h.el('profile-list').querySelector('[data-dir-id="fixture-created"]') !== null).toBe(true); expect(read().filter((p: any) => p.name.includes('Fixture new'))).toHaveLength(1);
      h.agent.newProfile(); await flush(); h.el('new-profile-name').value = 'Fixture failed draft'; h.api.browser.create.mockRejectedValue(new Error('fixture disk error')); h.agent.createProfile(); await flush(); expect(h.el('dlg-profile').open).toBe(true); expect(h.el('new-profile-name').value).toBe('Fixture failed draft'); expect(read()).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('license refusal remains delegated without closing form', async () => {
    const h = harness(['tabs', 'profiles']); h.agent.newProfile(); await flush(); h.el('new-profile-name').value = 'Fixture draft'; h.agent.interceptLicenseGate.mockReturnValue(true); h.api.browser.create.mockResolvedValue({ success: false, error: 'fixture license refusal' }); h.agent.createProfile(); await flush(); expect(h.el('dlg-profile').open).toBe(true); expect(h.helpers.toast).not.toHaveBeenCalled();
  });
  it('new-form reset restores WebRTC and window-title HTML defaults', async () => {
    const h = harness(['profiles']); expect(h.el('new-agent-browser-webrtc-mode').value).toBe('auto'); expect(h.el('new-agent-browser-window-title-enabled').checked).toBe(true);
    h.el('new-agent-browser-webrtc-mode').value = 'disable'; h.el('new-agent-browser-window-title-enabled').checked = false; h.agent.resetNewProfileForm('chromium'); await flush(); expect(h.el('new-agent-browser-webrtc-mode').value).toBe('auto'); expect(h.el('new-agent-browser-window-title-enabled').checked).toBe(true);
  });
  it('last proxy removal resets batch options, including when profile list becomes empty', async () => {
    const h = harness(['tabs', 'profiles']); h.api.proxy.list.mockResolvedValue([{ name: 'fixture-proxy' }]); h.agent.loadProfiles(); await flush(); expect(h.el('batch-assign-proxy').querySelector('option[value="fixture-proxy"]')).not.toBeNull(); h.el('batch-assign-proxy').value = 'fixture-proxy';
    h.api.proxy.list.mockResolvedValue([]); h.agent.refreshProfilesSoft(); await flush(); expect(h.el('batch-assign-proxy').querySelector('option[value="fixture-proxy"]')).toBeNull(); expect(h.el('batch-assign-proxy').value).toBe('');
    h.api.browser.list.mockResolvedValue([]); h.agent.refreshProfilesSoft(); await flush(); expect(h.el('profile-batch-actions').style.display).toBe('none');
  });
  it.each(['chromium', 'firefox'])('cold launch gate: %s unknown/available metadata overrides a cached missing status', async engine => {
    for (const runtime of [{ installed: null, runtimePending: true }, { installed: true, runtimePending: false }, { installed: false, runtimePending: true }]) {
      for (const mode of ['single', 'bulk']) {
        const h = harness(['tabs', 'profiles']); h.agent.confirmHtml = vi.fn(); h.agent.refresh = vi.fn();
        h.agent.batch = { run: vi.fn(async () => []) }; h.api.browser.launch = vi.fn(async () => ({ success: false, error: 'fixture authoritative refusal' }));
        h.api.browser.binary.mockResolvedValue({ installed: false });
        h.api.browser.engineStatus = vi.fn(async () => ({ firefox: { installed: false } }));
        h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', name: 'Fixture profile', engine, running: false }]);
        h.agent.loadProfiles(); await flush();
        h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', engine, running: false, ...runtime }]);
        if (mode === 'single') h.agent.launch('fixture-profile'); else h.agent.bulkStart();
        await flush();
        expect(h.agent.confirmHtml).not.toHaveBeenCalled();
        if (mode === 'single') expect(h.api.browser.launch).toHaveBeenCalledWith('fixture-profile', undefined);
        else expect(h.agent.batch.run).toHaveBeenCalledWith({ kind: 'launch', dirIds: ['fixture-profile'] });
      }
    }
  });
  it.each(['chromium', 'firefox'])('cold launch gate: %s homogeneous bulk with mixed availability reaches the bounded runner', async engine => {
    const h = harness(['tabs', 'profiles']); h.agent.confirmHtml = vi.fn(); h.agent.refresh = vi.fn();
    h.agent.batch = { run: vi.fn(async () => []) };
    h.api.browser.binary.mockResolvedValue({ installed: false });
    h.api.browser.engineStatus = vi.fn(async () => ({ firefox: { installed: false } }));
    h.agent.loadProfiles(); await flush();
    h.api.browser.list.mockResolvedValue([
      { dirId: 'fixture-profile', engine, running: false, installed: false, runtimePending: false },
      { dirId: 'fixture-other', engine, running: false, installed: true, runtimePending: false },
    ]);
    h.agent.bulkStart(); await flush();
    expect(h.agent.confirmHtml).not.toHaveBeenCalled();
    expect(h.agent.batch.run).toHaveBeenCalledWith({ kind: 'launch', dirIds: ['fixture-profile', 'fixture-other'] });
  });
  it.each(['binary', 'engines', 'both'])('cold discovery: metadata renders while %s status is pending', async mode => {
    const h = harness(['tabs', 'profiles']); const binary = deferred<any>(); const engines = deferred<any>();
    h.api.browser.engineStatus = vi.fn(async () => ({ firefox: { installed: true } }));
    if (mode !== 'engines') h.api.browser.binary.mockReturnValue(binary.promise);
    if (mode !== 'binary') h.api.browser.engineStatus.mockReturnValue(engines.promise);
    h.agent.loadProfiles(); await flush();
    const card = h.el('profile-list').querySelector('[data-dir-id="fixture-profile"]')!;
    expect(card).not.toBeNull(); expect(h.el('profile-list').textContent).toContain('Fixture profile');
    expect(h.el('engine-banner').textContent).not.toContain('No managed Chromium installed');
    const checkbox = card.querySelector('.profile-select-checkbox')!; checkbox.focus(); h.agent.closeCardMenus.mockClear();
    binary.resolve({ installed: true, version: '152.0.1.2' }); engines.resolve({ firefox: { installed: true } }); await flush();
    expect(h.el('profile-list').querySelector('.profile-card')).toBe(card); expect(h.doc.activeElement).toBe(checkbox);
    expect(h.agent.closeCardMenus).not.toHaveBeenCalled();
  });
  it('cold discovery: failed status reports unknown without removing persisted metadata', async () => {
    const h = harness(['tabs', 'profiles']); const status = deferred<any>(); h.api.browser.binary.mockReturnValue(status.promise);
    h.agent.loadProfiles(); await flush(); const card = h.el('profile-list').querySelector('.profile-card'); expect(card).not.toBeNull();
    status.reject(new Error('fixture status failed')); await flush();
    expect(h.el('profile-list').querySelector('.profile-card')).toBe(card);
    expect(h.el('engine-banner').textContent).toContain('Could not determine');
    expect(h.el('engine-banner').textContent).not.toContain('No managed Chromium installed');
  });
  it.each(['refresh', 'navigation'])('cold discovery: late status cannot overwrite %s ownership', async mode => {
    const h = harness(['tabs', 'profiles']); const status = deferred<any>(); h.api.browser.binary.mockReturnValueOnce(status.promise);
    h.agent.loadProfiles(); await flush();
    if (mode === 'refresh') { h.api.browser.binary.mockResolvedValue({ installed: true, version: '152.0.1.2' }); h.agent.refreshProfilesSoft(); await flush(); }
    else { h.agent.state.currentTab = 'proxies'; }
    const before = h.el('engine-banner').textContent;
    status.resolve({ installed: false }); await flush(); expect(h.el('engine-banner').textContent).toBe(before);
  });
  it.each(['installed', 'missing', 'unknown'])('soft status recheck keeps the %s banner stable while metadata and focus remain usable', async mode => {
    const h = harness(['tabs', 'profiles']);
    const info = mode === 'installed' ? { installed: true, version: '152.0.1.2' } : { installed: false };
    if (mode === 'unknown') h.api.browser.binary.mockRejectedValue(new Error('fixture probe failure'));
    else h.api.browser.binary.mockResolvedValue(info);
    h.agent.loadProfiles(); await flush();
    const banner = h.el('engine-banner'); const before = banner.textContent;
    const card = h.el('profile-list').querySelector('.profile-card')!;
    const focus = banner.querySelector('button') || card.querySelector('.profile-select-checkbox')!;
    focus.focus(); h.agent.closeCardMenus.mockClear();
    const write = vi.spyOn(banner, 'innerHTML', 'set'); const pending = deferred<any>();
    h.api.browser.binary.mockReturnValueOnce(pending.promise);
    h.agent.refreshProfilesSoft(); await flush();
    expect(banner.textContent).toBe(before); expect(banner.getAttribute('aria-busy')).toBe('true');
    expect(write).not.toHaveBeenCalled(); expect(h.doc.activeElement).toBe(focus);
    expect(h.el('profile-list').querySelector('.profile-card')).toBe(card);
    if (mode === 'unknown') pending.reject(new Error('fixture repeated probe failure'));
    else pending.resolve(info);
    await flush();
    expect(banner.textContent).toBe(before); expect(banner.getAttribute('aria-busy')).toBe('false');
    expect(write).not.toHaveBeenCalled(); expect(h.doc.activeElement).toBe(focus);
    expect(h.agent.closeCardMenus).not.toHaveBeenCalled();
  });
  it('a genuinely changed engine status replaces the banner only after its probe resolves', async () => {
    const h = harness(['tabs', 'profiles']); h.agent.loadProfiles(); await flush();
    const banner = h.el('engine-banner'); const before = banner.textContent; const pending = deferred<any>();
    h.api.browser.binary.mockReturnValueOnce(pending.promise); h.agent.refreshProfilesSoft(); await flush();
    expect(banner.textContent).toBe(before);
    pending.resolve({ installed: false }); await flush();
    expect(banner.textContent).toContain('No managed Chromium installed');
    expect(banner.getAttribute('aria-busy')).toBe('false');
  });
  it.each(['single', 'bulk'].flatMap(mode => ['missing', 'rejected'].map(outcome => [mode, outcome])))('soft recheck %s launch uses current authority after %s settlement, not unchanged presentation', async (mode, outcome) => {
    const h = harness(['tabs', 'profiles']); h.agent.confirmHtml = vi.fn(); h.agent.refresh = vi.fn();
    h.agent.batch = { run: vi.fn(async () => []) };
    h.api.browser.launch = vi.fn(async () => ({ success: false, error: 'fixture authoritative refusal' }));
    h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', engine: 'chromium', running: false, installed: false, runtimePending: false }]);
    h.api.browser.binary.mockResolvedValue({ installed: false }); h.agent.loadProfiles(); await flush();
    const launch = () => mode === 'single' ? h.agent.launch('fixture-profile') : h.agent.bulkStart();
    const runner = mode === 'single' ? h.api.browser.launch : h.agent.batch.run;
    launch(); await flush(); expect(h.agent.confirmHtml).toHaveBeenCalledTimes(1); expect(runner).not.toHaveBeenCalled();
    h.agent.confirmHtml.mockClear(); const banner = h.el('engine-banner'); const write = vi.spyOn(banner, 'innerHTML', 'set');
    const pending = deferred<any>(); h.api.browser.binary.mockReturnValueOnce(pending.promise);
    h.agent.refreshProfilesSoft(); await flush(); launch(); await flush();
    expect(h.agent.confirmHtml).not.toHaveBeenCalled(); expect(runner).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    if (outcome === 'missing') pending.resolve({ installed: false }); else pending.reject(new Error('fixture current probe failure'));
    await flush(); launch(); await flush();
    if (outcome === 'missing') {
      expect(h.agent.confirmHtml).toHaveBeenCalledTimes(1); expect(runner).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
    } else {
      expect(h.agent.confirmHtml).not.toHaveBeenCalled(); expect(runner).toHaveBeenCalledTimes(2);
      expect(banner.textContent).toContain('Could not determine');
    }
    expect(banner.getAttribute('aria-busy')).toBe('false');
  });
  it.each(['installed', 'missing', 'unknown'])('same %s status still repaints translated banner text and actions after locale change', async mode => {
    const h = harness(['tabs', 'profiles']);
    if (mode === 'unknown') h.api.browser.binary.mockRejectedValue(new Error('fixture probe failure'));
    else h.api.browser.binary.mockResolvedValue({ installed: mode === 'installed', version: '152.0.1.2' });
    h.agent.loadProfiles(); await flush(); const banner = h.el('engine-banner'); const before = banner.textContent;
    const action = banner.querySelector('button'); const beforeAction = action?.textContent;
    h.window.i18n.t = (_key: string, fallback: string) => '已翻译：' + fallback;
    h.agent.refreshProfilesSoft(); await flush();
    expect(banner.textContent).not.toBe(before); expect(banner.textContent).toContain('已翻译：');
    if (action) {
      expect(banner.querySelector('button')!.textContent).not.toBe(beforeAction);
      expect(banner.querySelector('button')!.textContent).toContain('已翻译：');
    }
    expect(banner.getAttribute('aria-busy')).toBe('false');
  });
  it.each(['success', 'missing', 'rejection'])('obsolete soft probe %s cannot clear a newer pending banner or its launch authority', async outcome => {
    const h = harness(['tabs', 'profiles']); h.agent.confirmHtml = vi.fn(); h.agent.refresh = vi.fn();
    h.api.browser.launch = vi.fn(async () => ({ success: false, error: 'fixture authoritative refusal' }));
    h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', engine: 'chromium', running: false, installed: false, runtimePending: false }]);
    h.api.browser.binary.mockResolvedValue({ installed: false }); h.agent.loadProfiles(); await flush();
    const banner = h.el('engine-banner'); const before = banner.textContent;
    const a = deferred<any>(); const b = deferred<any>();
    h.api.browser.binary.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    h.agent.refreshProfilesSoft(); await flush(); h.agent.refreshProfilesSoft(); await flush();
    if (outcome === 'success') a.resolve({ installed: true, version: '151.0.1.2' });
    else if (outcome === 'missing') a.resolve({ installed: false });
    else a.reject(new Error('fixture obsolete probe failure'));
    await flush(); expect(banner.textContent).toBe(before); expect(banner.getAttribute('aria-busy')).toBe('true');
    h.agent.launch('fixture-profile'); await flush();
    expect(h.agent.confirmHtml).not.toHaveBeenCalled(); expect(h.api.browser.launch).toHaveBeenCalledTimes(1);
    b.resolve({ installed: false }); await flush(); h.agent.launch('fixture-profile'); await flush();
    expect(banner.textContent).toBe(before); expect(banner.getAttribute('aria-busy')).toBe('false');
    expect(h.agent.confirmHtml).toHaveBeenCalledTimes(1); expect(h.api.browser.launch).toHaveBeenCalledTimes(1);
  });
  it('relative-time-only soft refresh updates the label without replacing its card or focus', async () => {
    const h = harness(['tabs', 'profiles']); h.helpers.relTime = vi.fn(() => '1 min ago');
    h.agent.loadProfiles(); await flush();
    const card = h.el('profile-list').querySelector('.profile-card')!;
    const time = card.querySelector('.num')!; const checkbox = card.querySelector('.profile-select-checkbox')!;
    expect(time.textContent).toBe('1 min ago'); checkbox.focus(); h.agent.closeCardMenus.mockClear();
    for (const label of ['2 min ago', '1 h ago', 'A&B <literal>']) {
      h.helpers.relTime.mockReturnValue(label); h.agent.refreshProfilesSoft(); await flush();
      expect(h.el('profile-list').querySelector('.profile-card')).toBe(card);
      expect(card.querySelector('.num')).toBe(time); expect(time.textContent).toBe(label);
      expect(time.querySelector('literal')).toBeNull(); expect(h.doc.activeElement).toBe(checkbox);
      expect(h.agent.closeCardMenus).not.toHaveBeenCalled();
    }
  });
  it('a real lastModified change rebuilds even when its relative label and absolute tooltip match', async () => {
    const h = harness(['tabs', 'profiles']); h.helpers.relTime = vi.fn(() => '1 min ago');
    h.agent.loadProfiles(); await flush(); const card = h.el('profile-list').querySelector('.profile-card')!;
    const title = card.querySelector('.num')!.getAttribute('title'); h.agent.closeCardMenus.mockClear();
    h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', name: 'Fixture profile', lastModified: 2 }]);
    h.agent.refreshProfilesSoft(); await flush(); const next = h.el('profile-list').querySelector('.profile-card')!;
    expect(next).not.toBe(card); expect(next.querySelector('.num')!.textContent).toBe('1 min ago');
    expect(next.querySelector('.num')!.getAttribute('title')).toBe(title);
    expect(h.agent.closeCardMenus).toHaveBeenCalled();
  });
  it('an identical modified label is not rewritten, and missing timestamps do not call relTime', async () => {
    const h = harness(['tabs', 'profiles']); h.helpers.relTime = vi.fn(() => '1 min ago');
    h.agent.loadProfiles(); await flush(); const card = h.el('profile-list').querySelector('.profile-card')!;
    const time = card.querySelector('.num')!; const write = vi.spyOn(time, 'textContent', 'set');
    h.agent.closeCardMenus.mockClear(); h.agent.refreshProfilesSoft(); await flush();
    expect(h.el('profile-list').querySelector('.profile-card')).toBe(card);
    expect(write).not.toHaveBeenCalled(); expect(h.agent.closeCardMenus).not.toHaveBeenCalled();
    h.helpers.relTime.mockClear(); h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', name: 'Fixture profile' }]);
    h.agent.refreshProfilesSoft(); await flush(); expect(h.el('profile-list').querySelector('.num')!.textContent).toBe('?');
    expect(h.helpers.relTime).not.toHaveBeenCalled();
  });
  it.each(['single', 'all'])('%s selection changes do not replace an unchanged card on soft refresh', async mode => {
    const h = harness(['tabs', 'profiles']); h.agent.loadProfiles(); await flush();
    const list = h.el('profile-list'); const card = list.querySelector('.profile-card')!;
    const checkbox = card.querySelector('.profile-select-checkbox')!; const sig = card.getAttribute('data-card-sig');
    for (const checked of [true, false, true]) {
      if (mode === 'single') { checkbox.checked = checked; list.onchange!({ target: checkbox }); }
      else { h.el('profile-select-all').checked = checked; h.agent.onProfileSelectAllChange(); }
      expect(checkbox.checked).toBe(checked); checkbox.focus(); h.agent.closeCardMenus.mockClear();
      h.agent.refreshProfilesSoft(); await flush();
      expect(list.querySelector('.profile-card')).toBe(card); expect(card.getAttribute('data-card-sig')).toBe(sig);
      expect(card.querySelector('.profile-select-checkbox')).toBe(checkbox); expect(checkbox.checked).toBe(checked);
      expect(h.doc.activeElement).toBe(checkbox); expect(h.agent.closeCardMenus).not.toHaveBeenCalled();
    }
  });
  it('real metadata still rebuilds a selected card and preserves its selection', async () => {
    const h = harness(['tabs', 'profiles']); h.agent.loadProfiles(); await flush();
    const list = h.el('profile-list'); const card = list.querySelector('.profile-card')!;
    const checkbox = card.querySelector('.profile-select-checkbox')!; checkbox.checked = true;
    list.onchange!({ target: checkbox }); checkbox.focus(); h.agent.closeCardMenus.mockClear();
    h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', name: 'Changed selected fixture', lastModified: 2 }]);
    h.agent.refreshProfilesSoft(); await flush(); const next = list.querySelector('.profile-card')!;
    expect(next).not.toBe(card); expect(next.querySelector('.profile-select-checkbox')!.checked).toBe(true);
    expect(h.doc.activeElement).toBe(next.querySelector('.profile-select-checkbox'));
    expect(h.agent.closeCardMenus).toHaveBeenCalled();
  });
  it('soft refresh preserves checkbox focus when card changes, and identical refresh preserves node', async () => {
    const h = harness(['tabs', 'profiles']); h.agent.loadProfiles(); await flush(); const c = h.el('profile-list').querySelector('.profile-select-checkbox')!; c.focus();
    h.agent.refreshProfilesSoft(); await flush(); expect(h.doc.activeElement).toBe(c); expect(h.el('profile-list').querySelector('.profile-select-checkbox')).toBe(c);
    h.api.browser.list.mockResolvedValue([{ dirId: 'fixture-profile', name: 'Changed fixture', lastModified: 2 }]); h.agent.refreshProfilesSoft(); await flush(); const next = h.el('profile-list').querySelector('.profile-select-checkbox')!; expect(next).not.toBe(c); expect(h.doc.activeElement).toBe(next);
  });
});

// Ownership regressions added after the independent support audit. All modules
// execute whole; real core/ipc are used where argument identity is load-bearing.
describe('UI support request ownership — adversarial schedules', () => {
  it.each(['disable', 'toggle', 'update'])('A controls are synchronously invalidated while B loads: %s', async action => {
    const h = harness(['ipc', 'extensions'], true);
    h.api.settings.updateRepositoryExtension = vi.fn(async () => ({ success: true }));
    h.agent.showExtensions('profile-A'); await flush();
    const oldButton = h.el('ext-list').querySelector('[data-ext-action="' + action + '"]')!;
    const oldClick = h.el('ext-list').onclick!; const oldChange = h.el('ext-list').onchange!;
    const pending = deferred<any>(); h.api.settings.extensions.mockReturnValueOnce(pending.promise);
    h.el('dlg-extensions').close(); h.agent.showExtensions('profile-B');
    expect.soft(h.el('ext-list').querySelector('[data-ext-action]')).toBeNull();
    expect.soft(h.el('ext-list').textContent).not.toContain('Fixture extension');
    oldButton.checked = false;
    // Even a saved old delegated closure is not authorized for the new view.
    if (action === 'toggle') oldChange({ target: oldButton }); else oldClick({ target: oldButton });
    await flush(); expect.soft(h.api.settings.toggleExtension).not.toHaveBeenCalled();
    expect.soft(h.api.settings.updateRepositoryExtension).not.toHaveBeenCalled();
    pending.resolve([{ id: 'B-ext', name: 'B extension', enabled: true }]); await flush();
    h.el('ext-list').querySelector('[data-ext-action="disable"]')!.click(); await flush();
    expect(h.api.settings.toggleExtension).toHaveBeenCalledExactlyOnceWith('profile-B', 'B-ext', false);
  });
  it.each(['resolve', 'reject'])('closed extension dialog ignores late %s and reopening has current actions', async mode => {
    const h = harness(['extensions']); const pending = deferred<any>(); const meta = deferred<any>();
    h.api.settings.extensions.mockReturnValueOnce(pending.promise); h.api.profile.get.mockReturnValueOnce(meta.promise);
    h.agent.showExtensions('A'); h.el('dlg-extensions').close();
    if (mode === 'reject') { pending.reject(new Error('old list error')); meta.reject(new Error('old metadata error')); }
    else { pending.resolve([{ id: 'old-ext', name: 'Old extension' }]); meta.resolve({ name: 'Old profile' }); }
    await flush(); expect.soft(h.el('ext-list').querySelector('[data-ext-action]')).toBeNull();
    expect.soft(h.el('ext-dlg-title').textContent).not.toContain('Old profile'); expect.soft(h.helpers.toast).not.toHaveBeenCalled();
    h.agent.showExtensions('B'); await flush(); h.el('ext-list').querySelector('[data-ext-action="disable"]')!.click(); await flush();
    expect(h.api.settings.toggleExtension).toHaveBeenCalledExactlyOnceWith('B', 'fixture-ext', false);
  });
  it('accepted A mutation retains exact target bytes while B is opened; fresh hosts list/search both IDs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-owned-target-')); const file = path.join(dir, 'config.json');
    try {
      const initial = { profiles: { A: { extensions: { 'A-ext': true } }, B: { extensions: { 'B-ext': true } } }, kept: 'KEEP' };
      fs.writeFileSync(file, JSON.stringify(initial)); const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
      const make = () => {
        const h = harness(['ipc', 'extensions'], true);
        h.api.settings.extensions.mockImplementation(async (id: string) => Object.entries(read().profiles[id].extensions).map(([id, enabled]) => ({ id, name: id + ' name', enabled })));
        return h;
      };
      const h = make(); const write = deferred<any>();
      h.api.settings.toggleExtension.mockImplementation(async (id: string, ext: string, enabled: boolean) => { await write.promise; const c = read(); c.profiles[id].extensions[ext] = enabled; fs.writeFileSync(file, JSON.stringify(c)); return { success: true }; });
      h.agent.showExtensions('A'); await flush(); h.el('ext-list').querySelector('[data-ext-action="disable"]')!.click();
      h.el('dlg-extensions').close(); h.agent.showExtensions('B'); await flush(); const calls = h.api.settings.extensions.mock.calls.length;
      write.resolve(null); await flush();
      expect(h.api.settings.toggleExtension).toHaveBeenCalledExactlyOnceWith('A', 'A-ext', false);
      expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ ...initial, profiles: { A: { extensions: { 'A-ext': false } }, B: initial.profiles.B } }));
      expect(h.api.settings.extensions).toHaveBeenCalledTimes(calls); expect(h.el('ext-list').textContent).toContain('B-ext name');
      for (const [id, ext, enabled] of [['A', 'A-ext', false], ['B', 'B-ext', true]] as const) {
        const fresh = make(); fresh.agent.showExtensions(id); await flush();
        expect(fresh.el('ext-list').querySelector('input')!.checked).toBe(enabled);
        const listed = await fresh.api.settings.extensions(id); expect(listed.find((e: any) => e.id === ext)).toMatchObject({ enabled });
        expect(listed.filter((e: any) => e.name.includes(ext))).toHaveLength(1);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['old-first', 'new-first'])('repository preserves newest search/action arguments: %s', async order => {
    const h = harness(['ipc', 'tabs', 'extensions'], true); const old = deferred<any>(); const fresh = deferred<any>();
    h.api.settings.extensionRepository = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise).mockResolvedValue([]);
    h.api.settings.setRepositoryExtensionMeta = vi.fn(async () => ({ success: true }));
    h.el('extension-repo-search').value = 'old'; h.agent.loadExtensionsTab(); await flush();
    h.el('extension-repo-search').value = 'current'; h.agent.loadExtensionsTab(); await flush();
    const entry = { id: 'current-ext', name: 'Current repository', shared: true, tags: ['KEEP'], source: 'store' };
    if (order === 'old-first') { old.resolve([{ id: 'old-ext', name: 'Old repository' }]); await flush(); fresh.resolve([entry]); }
    else { fresh.resolve([entry]); await flush(); old.resolve([{ id: 'old-ext', name: 'Old repository' }]); }
    await flush(); expect(h.el('extension-repo-list').textContent).toContain('Current repository'); expect(h.el('extension-repo-status').textContent).toContain('1');
    h.el('extension-repo-list').querySelector('[data-action="repo-share"]')!.click(); await flush();
    expect(h.api.settings.setRepositoryExtensionMeta).toHaveBeenCalledExactlyOnceWith('current-ext', { shared: false, tags: ['KEEP'] });
    expect(h.api.settings.extensionRepository.mock.calls.map((c: any[]) => c[0])).toEqual(['old', 'current', 'current']);
  });
  it.each(['old-error', 'current-error', 'current-empty'])('repository success/error ownership: %s', async mode => {
    const h = harness(['ipc', 'tabs', 'extensions']); const old = deferred<any>(); const fresh = deferred<any>();
    h.api.settings.extensionRepository = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    h.agent.loadExtensionsTab(); await flush(); h.el('extension-repo-search').value = 'new'; h.agent.loadExtensionsTab(); await flush();
    if (mode === 'current-error') fresh.reject(new Error('CURRENT FAILURE <bad>')); else fresh.resolve(mode === 'current-empty' ? [] : [{ id: 'new-ext', name: 'Current extension' }]);
    await flush(); if (mode === 'old-error') old.reject(new Error('OLD FAILURE')); else old.resolve([{ id: 'old-ext', name: 'Old extension' }]); await flush();
    const text = h.el('extension-repo-list').textContent;
    expect(text).toContain(mode === 'current-error' ? 'CURRENT FAILURE <bad>' : mode === 'current-empty' ? 'No extensions' : 'Current extension');
    expect(text).not.toContain('OLD FAILURE'); expect(text).not.toContain('Old extension'); expect(h.el('extension-repo-list').querySelector('bad')).toBeNull();
    if (mode !== 'old-error') expect(h.el('extension-repo-list').querySelector('[data-action]')).toBeNull();
  });
  it.each(['old-first', 'new-first', 'old-error', 'old-proxy-error', 'current-error', 'current-proxy-error'])('profile loads/errors and proxy options keep newest request: %s', async mode => {
    const h = harness(['ipc', 'tabs', 'profiles']); const old = deferred<any>(); const oldProxy = deferred<any>(); const fresh = deferred<any>(); const freshProxy = deferred<any>();
    h.api.browser.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    h.api.proxy.list.mockReturnValueOnce(oldProxy.promise).mockReturnValueOnce(freshProxy.promise);
    h.agent.loadProfiles(); await flush(); h.agent.refreshProfilesSoft(); await flush();
    const current = () => { if (mode === 'current-error') fresh.reject(new Error('CURRENT LIST ERROR')); else fresh.resolve([{ dirId: 'current-id', name: 'Current profile', lastModified: 2 }]); if (mode === 'current-proxy-error') freshProxy.reject(new Error('CURRENT PROXY ERROR')); else freshProxy.resolve([]); };
    const older = () => { if (mode === 'old-error') old.reject(new Error('OLD LIST ERROR')); else old.resolve([]); if (mode === 'old-proxy-error') oldProxy.reject(new Error('OLD PROXY ERROR')); else oldProxy.resolve([{ name: 'removed-proxy' }]); };
    if (mode === 'old-first') { older(); await flush(); current(); } else { current(); await flush(); older(); } await flush();
    expect(h.el('profile-list').textContent).toContain(mode === 'current-error' ? 'CURRENT LIST ERROR' : mode === 'current-proxy-error' ? 'CURRENT PROXY ERROR' : 'Current profile');
    expect(h.el('profile-list').textContent).not.toContain('OLD'); expect(h.el('batch-assign-proxy').querySelector('option[value="removed-proxy"]')).toBeNull();
    if (!mode.startsWith('current-')) expect(h.el('profile-list').querySelector('[data-dir-id="current-id"]')).not.toBeNull();
  });
  it('newProfile makes exactly one proxy read, and a valid user choice survives a later catalog refresh', async () => {
    const h = harness(['ipc', 'tabs', 'profiles'], true); h.api.proxy.list.mockResolvedValue([{ name: 'chosen' }]);
    h.agent.newProfile(); await flush(); expect(h.api.proxy.list).toHaveBeenCalledTimes(1);
    h.el('new-profile-proxy').value = 'named:chosen'; h.el('new-profile-proxy').dispatch('change');
    const load = deferred<any>(); h.api.proxy.list.mockReturnValueOnce(load.promise); h.agent.loadNewProfileProxies();
    h.el('new-profile-name').value = 'User draft'; load.resolve([{ name: 'chosen' }, { name: 'added' }]); await flush();
    expect(h.el('new-profile-proxy').value).toBe('named:chosen'); expect(h.el('new-profile-name').value).toBe('User draft');
    expect(h.el('new-profile-proxy').querySelector('option[value="named:added"]')).not.toBeNull();
    h.agent.createProfile(); await flush(); expect(h.api.browser.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'User draft', proxyMode: 'named', proxyName: 'chosen' }));
  });
  it.each(['old-first', 'new-first', 'old-error', 'current-error'])('new-form reversed proxy responses preserve current options and user input: %s', async mode => {
    const h = harness(['ipc', 'tabs', 'profiles'], true); const old = deferred<any>(); const fresh = deferred<any>();
    h.agent.newProfile(); await flush(); h.api.proxy.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    h.agent.loadNewProfileProxies(); h.agent.loadNewProfileProxies();
    const newer = () => { if (mode === 'current-error') fresh.reject(new Error('CURRENT PROXY FAILURE')); else fresh.resolve([{ name: 'chosen' }]); };
    const older = () => { if (mode === 'old-error') old.reject(new Error('OLD PROXY FAILURE')); else old.resolve([{ name: 'removed' }]); };
    if (mode === 'old-first') { older(); await flush(); newer(); await flush(); } else { newer(); await flush(); }
    h.el('new-profile-proxy').value = mode === 'current-error' ? 'none' : 'named:chosen'; h.el('new-profile-proxy').dispatch('change'); h.el('new-profile-name').value = 'KEEP DRAFT';
    if (mode !== 'old-first') { older(); await flush(); }
    expect(h.el('new-profile-proxy').value).toBe(mode === 'current-error' ? 'none' : 'named:chosen');
    expect(h.el('new-profile-proxy').querySelector('option[value="named:removed"]')).toBeNull(); expect(h.el('new-profile-name').value).toBe('KEEP DRAFT');
    expect(h.helpers.toast.mock.calls.some((c: any[]) => String(c[0]).includes('OLD PROXY FAILURE'))).toBe(false);
    expect(h.helpers.toast.mock.calls.some((c: any[]) => String(c[0]).includes('CURRENT PROXY FAILURE'))).toBe(mode === 'current-error');
  });
  it.each(['resolve', 'reject'])('new-form close/reopen invalidates previous session proxy %s', async mode => {
    const h = harness(['ipc', 'tabs', 'profiles'], true); const pending = deferred<any>();
    h.api.proxy.list.mockReturnValueOnce(pending.promise).mockResolvedValue([{ name: 'current' }]);
    h.agent.newProfile(); await flush(); h.el('dlg-profile').close();
    if (mode === 'reject') pending.reject(new Error('CLOSED PROXY ERROR')); else pending.resolve([{ name: 'closed' }]); await flush();
    expect.soft(h.helpers.toast).not.toHaveBeenCalled(); expect.soft(h.el('new-profile-proxy').querySelector('option[value="named:closed"]')).toBeNull();
    h.agent.newProfile(); await flush(); h.el('new-profile-proxy').value = 'named:current';
    expect(h.el('new-profile-proxy').querySelector('option[value="named:current"]')).not.toBeNull(); expect(h.el('new-profile-proxy').value).toBe('named:current');
  });
  it.each(['resolve', 'reject'])('full-core marketplace action unshares exact current ID and preserves tags after old %s', async mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-owned-skill-')); const file = path.join(dir, 'skills.json');
    try {
      const skill = { id: 'current-skill', title: 'Current skill', name: 'Current skill', shared: true, enabled: true, source: 'local', tags: ['KEEP', 'tag two'], tools: [], version: '1', prompt: 'synthetic' };
      fs.writeFileSync(file, JSON.stringify([skill])); const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
      const h = harness(['ipc', 'agent-skills'], true); const old = deferred<any>();
      h.api.agent.skills.marketplace.mockReturnValueOnce(old.promise).mockImplementation(async () => read());
      h.api.agent.skills.list = vi.fn(async () => read()); h.api.agent.skills.setMeta = vi.fn(async (id: string, meta: any) => { const rows = read(); Object.assign(rows.find((s: any) => s.id === id), meta); fs.writeFileSync(file, JSON.stringify(rows)); return { success: true }; });
      h.agent.refreshSkillMarket(); h.el('skill-market-search').value = 'Current'; h.agent.refreshSkillMarket(); await flush();
      if (mode === 'reject') old.reject(new Error('OLD SKILL ERROR')); else old.resolve([{ ...skill, id: 'old-skill', tags: ['DROP'] }]); await flush();
      const button = h.el('skill-market-list').querySelector('[data-action="skill-share"]')!; expect(button.textContent).toContain('Unshare'); button.click(); await flush();
      expect(h.api.agent.skills.setMeta).toHaveBeenCalledExactlyOnceWith('current-skill', { shared: false, tags: ['KEEP', 'tag two'] });
      expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify([{ ...skill, shared: false }]));
      h.agent.refreshSkillMarket(); await flush(); expect(h.el('skill-market-list').querySelector('[data-action="skill-share"]')!.textContent).toContain('Share');
      expect(read().find((s: any) => s.id === skill.id).tags).toEqual(skill.tags); expect(read().filter((s: any) => s.title.includes('Current'))).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('UI support current-error and persistence controls', () => {
  it.each(['old-first', 'new-first', 'old-error', 'current-error'])('extension lists/metadata keep current request in both orderings: %s', async mode => {
    const h = harness(['ipc', 'extensions'], true); const old = deferred<any>(); const fresh = deferred<any>(); const oldMeta = deferred<any>(); const freshMeta = deferred<any>();
    h.api.settings.extensions.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise); h.api.profile.get.mockReturnValueOnce(oldMeta.promise).mockReturnValueOnce(freshMeta.promise);
    h.agent.showExtensions('A'); h.el('dlg-extensions').close(); h.agent.showExtensions('B');
    const older = () => { if (mode === 'old-error') { old.reject(new Error('OLD LIST')); oldMeta.reject(new Error('OLD METADATA')); } else { old.resolve([{ id: 'A-ext', name: 'A extension' }]); oldMeta.resolve({ name: 'A profile' }); } };
    if (mode === 'old-first') { older(); await flush(); }
    freshMeta.resolve({ name: 'B profile' });
    if (mode === 'current-error') fresh.reject(new Error('CURRENT LIST')); else fresh.resolve([{ id: 'B-ext', name: 'B extension', enabled: true }]); await flush();
    if (mode !== 'old-first') { older(); await flush(); }
    expect(h.el('ext-dlg-title').textContent).toContain('B profile'); expect(h.el('ext-list').textContent).not.toContain('A extension');
    expect(h.helpers.toast.mock.calls.some((c: any[]) => String(c[0]).includes('OLD'))).toBe(false);
    if (mode === 'current-error') { expect(h.el('ext-list').querySelector('[data-ext-action]')).toBeNull(); expect(h.helpers.toast).toHaveBeenCalledWith(expect.stringContaining('CURRENT LIST'), 'error'); }
    else { h.el('ext-list').querySelector('[data-ext-action="disable"]')!.click(); await flush(); expect(h.api.settings.toggleExtension).toHaveBeenCalledExactlyOnceWith('B', 'B-ext', false); }
  });
  it('same current cards cannot resurrect deleted batch/card proxy options from an older proxy list', async () => {
    const h = harness(['ipc', 'tabs', 'profiles'], true); const older = deferred<any>(); const current = [{ dirId: 'current-id', name: 'Current', proxyMode: 'none', lastModified: 2 }];
    h.api.browser.list.mockResolvedValue(current); h.api.proxy.list.mockReturnValueOnce(older.promise).mockResolvedValue([]);
    h.agent.loadProfiles(); await flush(); h.agent.refreshProfilesSoft(); await flush(); older.resolve([{ name: 'removed' }]); await flush();
    expect(h.el('batch-assign-proxy').querySelector('option[value="removed"]')).toBeNull(); expect(h.el('profile-list').querySelector('option[value="named:removed"]')).toBeNull();
    expect(h.el('profile-list').querySelector('[data-dir-id="current-id"]')).not.toBeNull();
  });
  it('real user none selection during pending browser change is preserved; successful named create persists exact bytes/readback/list/search', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-owned-create-proxy-')); const file = path.join(dir, 'config.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ profiles: [], kept: 'EXACT' })); const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
      const h = harness(['ipc', 'tabs', 'profiles'], true); h.api.proxy.list.mockResolvedValue([{ name: 'chosen' }]); h.agent.newProfile(); await flush();
      const pending = deferred<any>(); h.api.proxy.list.mockReturnValueOnce(pending.promise); h.agent.profileBrowserChanged(); h.el('new-profile-proxy').value = 'none'; h.el('new-profile-proxy').dispatch('change');
      pending.resolve([{ name: 'chosen' }]); await flush(); expect(h.el('new-profile-proxy').value).toBe('none');
      h.el('new-profile-proxy').value = 'named:chosen'; h.el('new-profile-name').value = 'Unique chosen draft';
      h.api.browser.create.mockImplementation(async (params: any) => { const c = read(); c.profiles.push({ ...params, dirId: 'created-chosen' }); fs.writeFileSync(file, JSON.stringify(c)); return { dirId: 'created-chosen' }; });
      h.api.browser.list.mockImplementation(async () => read().profiles); h.agent.createProfile(); await flush();
      const params = h.api.browser.create.mock.calls[0][0]; expect(params).toMatchObject({ proxyMode: 'named', proxyName: 'chosen', name: 'Unique chosen draft' });
      expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ profiles: [{ ...params, dirId: 'created-chosen' }], kept: 'EXACT' }));
      const fresh = harness(['ipc', 'tabs', 'profiles'], true); fresh.api.browser.list.mockImplementation(async () => read().profiles); fresh.api.proxy.list.mockResolvedValue([{ name: 'chosen' }]); fresh.agent.loadProfiles(); await flush();
      expect(fresh.el('profile-list').querySelector('[data-dir-id="created-chosen"]')?.querySelector('select.proxy-select')?.value).toBe('named:chosen');
      expect(read().profiles.find((p: any) => p.dirId === 'created-chosen').proxyName).toBe('chosen'); expect(read().profiles.filter((p: any) => p.name.includes('Unique chosen'))).toHaveLength(1);
      const bytes = fs.readFileSync(file, 'utf8'); h.agent.newProfile(); await flush(); h.el('new-profile-name').value = 'Refused draft'; h.el('new-profile-proxy').value = 'named:chosen'; h.api.browser.create.mockRejectedValue(new Error('WRITE REFUSED')); h.agent.createProfile(); await flush();
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes); expect(h.el('dlg-profile').open).toBe(true); expect(h.el('new-profile-proxy').value).toBe('named:chosen');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// Reconciliation gates use production core and IPC with complete renderers;
// only provider responses/storage and the DOM host are controlled fixtures.
describe('UI support reconciliation — query, dismissal, selection and viewer controls', () => {
  it.each(['query', 'dismiss'].flatMap(intent => ['resolve', 'reject'].map(outcome => [intent, outcome])))('repository %s intent invalidates pending %s without another request', async (intent, outcome) => {
    const h = harness(['ipc', 'tabs', 'profiles', 'extensions'], true); const pending = deferred<any>();
    h.api.settings.extensionRepository = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([{ id: 'current-ext', name: 'Current repository', shared: true, tags: ['KEEP'] }]);
    h.api.settings.setRepositoryExtensionMeta = vi.fn(async () => ({ success: true }));
    h.el('extension-repo-search').value = 'older'; h.agent.switchTab('extensions'); await flush();
    const before = h.el('extension-repo-list').textContent;
    if (intent === 'query') h.el('extension-repo-search').value = 'current'; else h.agent.switchTab('profiles');
    if (outcome === 'reject') pending.reject(new Error('OBSOLETE REPOSITORY ERROR')); else pending.resolve([{ id: 'obsolete-ext', name: 'Obsolete repository' }]);
    await flush(); expect(h.el('extension-repo-list').textContent).toBe(before);
    expect(h.el('extension-repo-list').querySelector('[data-action]')).toBeNull();
    h.el('extension-repo-search').value = 'current'; h.agent.switchTab('extensions'); await flush();
    h.el('extension-repo-list').querySelector('[data-action="repo-share"]')!.click(); await flush();
    expect(h.api.settings.setRepositoryExtensionMeta).toHaveBeenCalledExactlyOnceWith('current-ext', { shared: false, tags: ['KEEP'] });
  });
  it.each(['query', 'dismiss'])('repository saved action closure cannot act after %s intent', async intent => {
    const h = harness(['ipc', 'tabs', 'profiles', 'extensions'], true);
    h.api.settings.extensionRepository = vi.fn(async () => [{ id: 'older-ext', name: 'Older repository', shared: true, tags: ['KEEP'] }]);
    h.api.settings.setRepositoryExtensionMeta = vi.fn(async () => ({ success: true }));
    h.agent.switchTab('extensions'); await flush();
    const action = h.el('extension-repo-list').querySelector('[data-action="repo-share"]')!; const saved = h.el('extension-repo-list').onclick!;
    if (intent === 'query') h.el('extension-repo-search').value = 'current'; else h.agent.switchTab('profiles');
    saved({ target: action }); await flush(); expect(h.api.settings.setRepositoryExtensionMeta).not.toHaveBeenCalled();
  });
  it.each(['old-first', 'new-first', 'old-error', 'old-proxy-error', 'current-error', 'current-proxy-error'])('real-core profile and proxy reversed replies preserve newest state: %s', async mode => {
    const h = harness(['ipc', 'tabs', 'profiles'], true); const old = deferred<any>(); const oldProxy = deferred<any>(); const current = deferred<any>(); const currentProxy = deferred<any>();
    h.api.browser.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    h.api.proxy.list.mockReturnValueOnce(oldProxy.promise).mockReturnValueOnce(currentProxy.promise);
    h.agent.loadProfiles(); await flush(); h.agent.refreshProfilesSoft(); await flush();
    const older = () => { if (mode === 'old-error') old.reject(new Error('OLD PROFILE ERROR')); else old.resolve([{ dirId: 'old-id', name: 'Old profile' }]); if (mode === 'old-proxy-error') oldProxy.reject(new Error('OLD PROXY ERROR')); else oldProxy.resolve([{ name: 'removed' }]); };
    const newer = () => { if (mode === 'current-error') current.reject(new Error('CURRENT PROFILE ERROR')); else current.resolve([{ dirId: 'current-id', name: 'Current profile', proxyMode: 'named', proxyName: 'chosen' }]); if (mode === 'current-proxy-error') currentProxy.reject(new Error('CURRENT PROXY ERROR')); else currentProxy.resolve([{ name: 'chosen' }]); };
    if (mode === 'old-first') { older(); await flush(); newer(); } else { newer(); await flush(); older(); } await flush();
    expect(h.el('profile-list').textContent).toContain(mode === 'current-error' ? 'CURRENT PROFILE ERROR' : mode === 'current-proxy-error' ? 'CURRENT PROXY ERROR' : 'Current profile');
    expect(h.el('profile-list').textContent).not.toContain('Old profile'); expect(h.el('profile-list').textContent).not.toContain('OLD ');
    expect(h.el('batch-assign-proxy').querySelector('option[value="removed"]')).toBeNull();
    if (!mode.startsWith('current-')) expect(h.el('profile-list').querySelector('select.proxy-select')!.value).toBe('named:chosen');
  });
  it.each(['resolve', 'reject'])('real-core closed extension replies cannot paint or act on reopened profile: %s', async outcome => {
    const h = harness(['ipc', 'extensions'], true); const list = deferred<any>(); const meta = deferred<any>();
    h.api.settings.extensions.mockReturnValueOnce(list.promise); h.api.profile.get.mockReturnValueOnce(meta.promise);
    h.agent.showExtensions('A'); h.el('dlg-extensions').close();
    if (outcome === 'reject') { list.reject(new Error('CLOSED LIST ERROR')); meta.reject(new Error('CLOSED META ERROR')); }
    else { list.resolve([{ id: 'A-ext', name: 'Closed extension', enabled: true }]); meta.resolve({ name: 'Closed profile' }); }
    await flush(); expect(h.el('ext-list').querySelector('[data-ext-action]')).toBeNull(); expect(h.helpers.toast).not.toHaveBeenCalled();
    h.api.settings.extensions.mockResolvedValue([{ id: 'B-ext', name: 'Current extension', enabled: true }]);
    h.agent.showExtensions('B'); await flush(); h.el('ext-list').querySelector('[data-ext-action="disable"]')!.click(); await flush();
    expect(h.api.settings.toggleExtension).toHaveBeenCalledExactlyOnceWith('B', 'B-ext', false); expect(h.el('ext-dlg-title').textContent).toContain('Fixture B');
  });
  it('real-core initial newProfile proxy reply preserves an explicit available none choice', async () => {
    const h = harness(['ipc', 'tabs', 'profiles'], true); const pending = deferred<any>(); h.api.proxy.list.mockReturnValueOnce(pending.promise);
    h.agent.newProfile(); await flush(); expect(h.api.proxy.list).toHaveBeenCalledTimes(1);
    expect(h.el('new-profile-proxy').querySelector('option[value="none"]')).not.toBeNull(); h.el('new-profile-proxy').value = 'none'; h.el('new-profile-proxy').dispatch('change');
    h.el('new-profile-name').value = 'Pending explicit choice'; pending.resolve([{ name: 'available' }]); await flush();
    expect(h.el('new-profile-proxy').value).toBe('none'); expect(h.el('new-profile-name').value).toBe('Pending explicit choice');
    h.agent.createProfile(); await flush(); expect(h.api.browser.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pending explicit choice', proxyMode: 'none', proxyName: null }));
  });
  it.each(['viewer', 'reject'])('real-core skill %s refusal retains exact ID shareflag tags and synthetic bytes', async mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-reconcile-skill-refused-')); const file = path.join(dir, 'skills.json');
    try {
      const skill = { id: 'current-skill', title: 'Current skill', name: 'Current skill', shared: true, enabled: true, source: 'local', tags: ['KEEP', 'tag two'], tools: [], version: '1', prompt: 'synthetic' }; const bytes = JSON.stringify([skill]);
      fs.writeFileSync(file, bytes); const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
      const h = harness(['ipc', 'agent-skills'], true); h.api.agent.skills.marketplace.mockImplementation(async () => read());
      h.api.agent.skills.setMeta = mode === 'viewer' ? vi.fn(async () => ({ success: false, error: 'VIEWER SKILL DENIED' })) : vi.fn(async () => { throw new Error('SKILL WRITE REJECTED'); });
      h.agent.skillMarket(); await flush(); h.el('skill-market-list').querySelector('[data-action="skill-share"]')!.click(); await flush();
      expect(h.api.agent.skills.setMeta).toHaveBeenCalledExactlyOnceWith('current-skill', { shared: false, tags: ['KEEP', 'tag two'] }); expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
      expect(h.helpers.toast.mock.calls.at(-1)?.[1]).toBe('error'); h.el('dlg-skill-market').close(); h.agent.skillMarket(); await flush();
      expect(h.el('skill-market-list').querySelector('[data-action="skill-share"]')!.textContent).toContain('Unshare');
      expect((await h.api.agent.skills.marketplace('Current')).find((s: any) => s.id === 'current-skill')).toMatchObject({ shared: true, tags: skill.tags }); expect(read().filter((s: any) => s.title.includes('Current'))).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('real-core option reconciliation preserves a chosen batch proxy and removes vanished options', async () => {
    const h = harness(['ipc', 'tabs', 'profiles'], true); h.api.proxy.list.mockResolvedValue([{ name: 'chosen' }]);
    h.agent.loadProfiles(); await flush(); h.el('batch-assign-proxy').value = 'chosen';
    h.api.proxy.list.mockResolvedValue([{ name: 'added' }, { name: 'chosen' }]); h.agent.refreshProfilesSoft(); await flush();
    expect(h.el('batch-assign-proxy').value).toBe('chosen');
    h.api.proxy.list.mockResolvedValue([{ name: 'added' }]); h.agent.refreshProfilesSoft(); await flush();
    expect(h.el('batch-assign-proxy').value).toBe(''); expect(h.el('batch-assign-proxy').querySelector('option[value="chosen"]')).toBeNull();
  });
  it('real-core new form preserves explicit pending choices and uses default only when selected named option was removed', async () => {
    const h = harness(['ipc', 'tabs', 'profiles'], true); h.api.proxy.list.mockResolvedValue([{ name: 'chosen' }]);
    h.agent.newProfile(); await flush(); const pending = deferred<any>(); h.api.proxy.list.mockReturnValueOnce(pending.promise); h.agent.loadNewProfileProxies();
    h.el('new-profile-proxy').value = 'named:chosen'; h.el('new-profile-proxy').dispatch('change');
    pending.resolve([{ name: 'added' }, { name: 'chosen' }]); await flush(); expect(h.el('new-profile-proxy').value).toBe('named:chosen');
    h.api.proxy.list.mockResolvedValue([{ name: 'added' }]); h.agent.loadNewProfileProxies(); await flush();
    expect(h.el('new-profile-proxy').querySelector('option[value="named:chosen"]')).toBeNull(); expect(h.el('new-profile-proxy').value).toBe('default');
    h.el('new-profile-proxy').value = 'none'; h.agent.loadNewProfileProxies(); await flush(); expect(h.el('new-profile-proxy').value).toBe('none');
  });
  it.each(['viewer', 'reject'])('real-core extension %s write preserves exact by-profile bytes and readback after reopen', async mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-reconcile-viewer-')); const file = path.join(dir, 'config.json');
    try {
      const initial = { profiles: { A: { 'A-ext': true }, B: { 'B-ext': true } }, kept: 'EXACT' }; const bytes = JSON.stringify(initial);
      fs.writeFileSync(file, bytes); const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
      const h = harness(['ipc', 'extensions'], true); h.api.settings.extensions.mockImplementation(async (id: string) => Object.entries(read().profiles[id]).map(([id, enabled]) => ({ id, name: id + ' fixture', enabled })));
      if (mode === 'viewer') h.api.settings.toggleExtension.mockResolvedValue({ success: false, error: 'VIEWER WRITE DENIED' }); else h.api.settings.toggleExtension.mockRejectedValue(new Error('WRITE REJECTED'));
      h.agent.showExtensions('A'); await flush(); h.el('ext-list').querySelector('[data-ext-action="disable"]')!.click(); await flush();
      expect(h.api.settings.toggleExtension).toHaveBeenCalledExactlyOnceWith('A', 'A-ext', false); expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
      expect(h.helpers.toast.mock.calls.at(-1)?.[1]).toBe('error'); expect(h.el('ext-list').querySelector('input')!.checked).toBe(true);
      h.el('dlg-extensions').close(); h.agent.showExtensions('B'); await flush(); expect(h.el('ext-list').querySelector('input')!.checked).toBe(true);
      expect((await h.api.settings.extensions('A')).find((e: any) => e.id === 'A-ext')).toMatchObject({ enabled: true });
      expect((await h.api.settings.extensions('B')).filter((e: any) => e.name.includes('B-ext'))).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('UI support accepted write completion control', () => {
  it('a newer read in the same open profile does not suppress accepted toggle readback', async () => {
    const h = harness(['ipc', 'extensions'], true); let enabled = true; const write = deferred<any>();
    h.api.settings.extensions.mockImplementation(async () => [{ id: 'current-ext', name: 'Current extension', enabled }]);
    h.api.settings.toggleExtension.mockImplementation(async () => { await write.promise; enabled = false; return { success: true }; });
    h.agent.showExtensions('A'); await flush(); h.el('ext-list').querySelector('[data-ext-action="disable"]')!.click();
    h.agent._extRefreshList(); await flush(); expect(h.el('ext-list').querySelector('input')!.checked).toBe(true);
    write.resolve(null); await flush(); expect(h.api.settings.toggleExtension).toHaveBeenCalledExactlyOnceWith('A', 'current-ext', false);
    expect(h.el('ext-list').querySelector('input')!.checked).toBe(false);
  });
});
