// Deterministic renderer-only ownership proof. No Electron, browser, native IPC,
// network or application entrypoint. All backend APIs and timers are synthetic.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
const ROOT = path.resolve(__dirname, '../..');
const scripts = Object.fromEntries(['automation', 'profiles', 'ipc'].map(name => [name,
  fs.readFileSync(path.join(ROOT, 'src/renderer/js/app', name + '.js'), 'utf8')]));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
class Element {
  value = ''; open = false; disabled = false; checked = false; textContent = ''; innerHTML = '';
  dataset: any = {}; style: any = {}; attrs: any = {}; children: any[] = []; selectedOptions: any[] = [];
  listeners: Record<string, Function[]> = {}; closeCount = 0;
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  constructor(public id: string) {}
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === 'disabled') this.disabled = true; }
  removeAttribute(key: string) { delete this.attrs[key]; if (key === 'disabled') this.disabled = false; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  addEventListener(type: string, fn: Function) { (this.listeners[type] ||= []).push(fn); }
  querySelectorAll() { return []; } querySelector() { return null; }
  appendChild(el: Element) { this.children.push(el); return el; }
  showModal() { this.open = true; }
  close() { this.open = false; ++this.closeCount; for (const fn of this.listeners.close || []) fn({ target: this }); }
  focus() {}
}
type Kind = 'automation-new' | 'automation-edit' | 'chromium-managed' | 'chromium-off' | 'firefox';
function harness(kind: Kind, realIpc = false) {
  const isAuto = kind.startsWith('automation');
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id)!; };
  const button = el('submit'); const cancel = el('cancel');
  const document: any = {
    readyState: 'complete', hidden: false, documentElement: { lang: 'en' },
    getElementById: el, querySelector: (selector: string) => selector.includes('button[type="submit"]') ? button : null,
    querySelectorAll: () => [], addEventListener() {}, createElement: () => new Element('generated'),
  };
  const api: any = {
    automation: { create: vi.fn(async () => ({ success: true })), update: vi.fn(async () => ({ success: true })) },
    browser: { create: vi.fn(async () => ({ success: true, dirId: 'new-id' })), list: vi.fn(async () => []),
      binary: vi.fn(async () => ({ installed: true, installedVersions: [] })), presets: vi.fn(async () => []) },
    proxy: { list: vi.fn(async () => []) }, app: { paths: vi.fn(async () => ({ platform: 'darwin' })) }, agent: {},
  };
  const toast = vi.fn(); const ipcCall = vi.fn((_key: string, fn: Function, _opts?: any) => fn());
  const helpers: any = { toast, esc: String, escAttr: String, icon: () => '', parseProxySelection: () => ({ mode: 'default', name: null }),
    renderProxyOptions: () => '', readHardwareFields: () => ({}), writeHardwareFields() {}, bindHardwareFieldValidation() {},
    validateHardwareFields: () => [], clearFieldErrors() {}, showFieldErrors() {}, renderBrowserBinaryCard: () => '',
    updateBrowserStatus() {}, getSyncStatus: () => 'never' };
  const agent: any = { api, R: api, helpers, state: { currentTab: isAuto ? 'automation' : 'profiles' },
    ipc: { call: ipcCall }, switchTab: vi.fn(), interceptLicenseGate: vi.fn(() => false), renderViewState: vi.fn(),
    batch: { locateCard: vi.fn() }, closeCardMenus: vi.fn() };
  let now = 0, timerId = 0;
  const timers = new Map<number, { at: number, fn: Function }>();
  const setTimer = (fn: Function, ms = 0) => { timers.set(++timerId, { at: now + ms, fn }); return timerId; };
  const window: any = { agentBrowser: agent, agentBrowserAPI: api, i18n: { t: (_key: string, fallback: string) => fallback } };
  const context = vm.createContext({ window, document, console, setTimeout: setTimer,
    clearTimeout: (id: number) => timers.delete(id), setInterval: () => 0, clearInterval() {},
    Option: function(text: string, value: string) { const option = new Element('option'); option.textContent = text; option.value = value; return option; } });
  if (realIpc) vm.runInContext(scripts.ipc, context, { filename: 'ipc.js' });
  vm.runInContext(isAuto ? scripts.automation : scripts.profiles, context, { filename: isAuto ? 'automation.js' : 'profiles.js' });
  // Observe the existing automation list refresh; do not load any other module.
  if (isAuto) agent.loadAutomationTab = vi.fn();
  const dialog = el(isAuto ? 'dlg-automation' : 'dlg-profile');
  const name = el(isAuto ? 'auto-name' : 'new-profile-name');
  const operation = isAuto ? (kind === 'automation-edit' ? api.automation.update : api.automation.create) : api.browser.create;
  const open = async (draft = 'draft') => {
    if (kind === 'automation-edit') agent.automationEdit({ id: 'rule-id', name: draft, enabled: true, trigger: { type: 'cron', cron: '0 9 * * *' }, action: { type: 'custom-js', jsCode: '1' } });
    else if (isAuto) agent.automationNew();
    else agent.newProfile();
    await flush(); name.value = draft;
    if (isAuto) { el('auto-action-type').value = 'custom-js'; el('auto-action-js').value = '1'; }
    else { el('new-profile-browser').value = kind === 'firefox' ? 'firefox' : 'chromium';
      el('new-agent-browser-fingerprint-mode').value = kind === 'chromium-off' ? 'off' : 'managed'; }
  };
  const submit = () => isAuto ? agent.saveAutomation() : agent.createProfile();
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush(); }
    now = end; await flush();
  };
  const success = isAuto ? { success: true } : { success: true, dirId: 'new-id' };
  return { kind, el, button, cancel, dialog, name, api, agent, toast, ipcCall, operation, open, submit, advance, success };
}
const kinds: Kind[] = ['automation-new', 'automation-edit', 'chromium-managed', 'chromium-off', 'firefox'];
for (const kind of kinds) describe(kind + ' per-dialog ownership', () => {
  it('blocks programmatic/Enter-style reentry independently of button.disabled; does not lock Cancel', async () => {
    const h = harness(kind); const pending = deferred(); h.operation.mockReturnValue(pending.promise);
    await h.open('first'); h.submit(); expect(h.button.disabled).toBe(true); expect(h.cancel.disabled).toBe(false);
    h.button.disabled = false; h.name.value = 'edited while pending'; h.submit(); h.submit();
    expect(h.operation).toHaveBeenCalledTimes(1);
    const payload = h.operation.mock.calls[0][0];
    expect(payload.name).toBe('first');
    if (!kind.startsWith('automation')) {
      expect(payload.engine).toBe(kind === 'firefox' ? 'firefox' : undefined);
      expect(payload.fingerprintMode).toBe(kind === 'chromium-off' ? 'off' : 'managed');
    }
    pending.resolve(h.success); await flush(); expect(h.dialog.open).toBe(false); expect(h.button.disabled).toBe(false);
  });
  for (const failure of ['flag', 'reject', 'throw'] as const) it(failure + ' releases only its own owner, preserves the draft, and allows retry', async () => {
    const h = harness(kind); await h.open('keep input');
    if (failure === 'flag') h.operation.mockResolvedValueOnce({ success: false, error: 'denied' });
    if (failure === 'reject') h.operation.mockRejectedValueOnce(new Error('rejected'));
    if (failure === 'throw') h.operation.mockImplementationOnce(() => { throw new Error('synchronous'); });
    expect(() => h.submit()).not.toThrow(); await flush();
    expect(h.dialog.open).toBe(true); expect(h.name.value).toBe('keep input'); expect(h.button.disabled).toBe(false);
    expect(h.toast).toHaveBeenCalledWith(expect.any(String), 'error');
    h.submit(); await flush(); expect(h.operation).toHaveBeenCalledTimes(2); expect(h.dialog.open).toBe(false);
  });
  for (const late of ['success', 'flag', 'reject'] as const) it('late ' + late + ' cannot close/unlock/navigate or overwrite a reopened pending owner', async () => {
    const h = harness(kind); const old = deferred(), next = deferred();
    h.operation.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await h.open('old draft'); h.submit(); h.dialog.close(); await h.open('new draft'); h.submit();
    expect(h.operation).toHaveBeenCalledTimes(2); h.toast.mockClear(); h.agent.switchTab.mockClear();
    if (late === 'reject') old.reject(new Error('old reject'));
    else old.resolve(late === 'success' ? h.success : { success: false, error: 'old error' });
    await flush(); expect(h.dialog.open).toBe(true); expect(h.dialog.closeCount).toBe(1);
    expect(h.name.value).toBe('new draft'); expect(h.button.disabled).toBe(true); expect(h.toast).not.toHaveBeenCalled();
    expect(h.agent.switchTab).not.toHaveBeenCalled(); h.submit(); expect(h.operation).toHaveBeenCalledTimes(2);
    next.resolve(h.success); await flush(); expect(h.dialog.open).toBe(false); expect(h.button.disabled).toBe(false);
  });
  it('closing the dialog does not cancel/repeat backend work or apply a late result to closed UI', async () => {
    const h = harness(kind); const pending = deferred(); h.operation.mockReturnValue(pending.promise);
    await h.open(); h.submit(); h.dialog.close(); h.submit(); pending.resolve(h.success); await flush();
    expect(h.operation).toHaveBeenCalledTimes(1); expect(h.dialog.closeCount).toBe(1); expect(h.toast).not.toHaveBeenCalled();
    expect(h.agent.switchTab).not.toHaveBeenCalled(); await h.open('retry in new session'); expect(h.button.disabled).toBe(false);
  });
});
describe('profile pending contract using the real renderer IPC wrapper, synthetic APIs/timers only', () => {
  it('15s is a warning, not failure/unlock; the real backend settlement still closes the owner', async () => {
    const h = harness('chromium-managed', true); const pending = deferred(); h.operation.mockReturnValue(pending.promise);
    await h.open(); h.submit(); await flush(); await h.advance(15001);
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('still pending'), 'warning');
    expect(h.button.disabled).toBe(true); expect(h.dialog.open).toBe(true); h.submit(); await flush();
    expect(h.operation).toHaveBeenCalledTimes(1); await h.advance(60000);
    expect(h.button.disabled).toBe(true); pending.resolve(h.success); await flush();
    expect(h.dialog.open).toBe(false); expect(h.button.disabled).toBe(false);
  });
  it('an old slow notice is silent after close/reopen; old settlement leaves the new owner locked', async () => {
    const h = harness('firefox', true); const old = deferred(), next = deferred();
    h.operation.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await h.open('old'); h.submit(); await flush(); await h.advance(10000);
    h.dialog.close(); await h.open('new'); h.submit(); await flush(); h.toast.mockClear();
    await h.advance(5001); expect(h.toast).not.toHaveBeenCalled(); expect(h.button.disabled).toBe(true);
    old.resolve(h.success); await flush(); expect(h.dialog.open).toBe(true); expect(h.button.disabled).toBe(true);
    await h.advance(10000); expect(h.toast).toHaveBeenCalledTimes(1);
    next.resolve({ success: false, error: 'new denied' }); await flush(); expect(h.button.disabled).toBe(false);
    expect(h.dialog.open).toBe(true); expect(h.name.value).toBe('new');
  });
  it('a completed owner does not locate its card over a freshly reopened form', async () => {
    const h = harness('chromium-managed'); await h.open('completed'); h.submit(); await flush();
    expect(h.dialog.open).toBe(false); await h.open('next draft'); await h.advance(401);
    expect(h.agent.batch.locateCard).not.toHaveBeenCalled(); expect(h.name.value).toBe('next draft');
    expect(h.dialog.open).toBe(true);
  });
  it('the completed owner may locate its card only while its profile view remains current', async () => {
    const h = harness('chromium-managed'); await h.open(); h.submit(); await flush(); await h.advance(401);
    expect(h.agent.batch.locateCard).toHaveBeenCalledWith('new-id');
    const moved = harness('chromium-managed'); await moved.open(); moved.submit(); await flush();
    moved.agent.state.currentTab = 'settings'; await moved.advance(401);
    expect(moved.agent.batch.locateCard).not.toHaveBeenCalled();
  });
  it('a synchronous wrapper throw releases the form owner before returning', async () => {
    const h = harness('firefox'); await h.open();
    h.ipcCall.mockImplementationOnce(() => { throw new Error('wrapper synchronous'); });
    expect(() => h.submit()).not.toThrow(); expect(h.button.disabled).toBe(false);
    expect(h.dialog.open).toBe(true); h.submit(); await flush(); expect(h.dialog.open).toBe(false);
  });
  it('license refusal keeps the form open but releases the settled owner for retry', async () => {
    const h = harness('chromium-managed'); await h.open(); h.agent.interceptLicenseGate.mockReturnValueOnce(true);
    h.operation.mockResolvedValueOnce({ success: false, code: 'LICENSE_REQUIRED' }); h.submit(); await flush();
    expect(h.dialog.open).toBe(true); expect(h.button.disabled).toBe(false); expect(h.toast).not.toHaveBeenCalled();
    h.submit(); await flush(); expect(h.operation).toHaveBeenCalledTimes(2); expect(h.dialog.open).toBe(false);
  });
});
