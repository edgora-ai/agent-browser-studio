// Closed renderer VM regression fixture: reads ONLY automation.js. No application
// entrypoint, Electron, native IPC, browser, network, real timers or config files.
// This is a deterministic facade, NOT a VM security-boundary / native-UI claim.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/js/app/automation.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 40; ++i) await Promise.resolve(); };
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const escape = (value: any) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const prefs = (system = false, sound = false) => ({ system, sound });
const rule = (id: string) => ({ id, name: 'rule-' + id, enabled: true,
  trigger: { type: 'cron', cron: '0 9 * * *' }, action: { type: 'custom-js', jsCode: id } });
const catalog = (id: string) => [{ id, title: id, category: 'review', riskLevel: 'low' }];

class Element {
  value = ''; open = false; disabled = false; checked = false; hidden = false;
  dataset: any = {}; style: any = {}; attrs: Record<string, string> = {};
  children: Element[] = []; selectedOptions: Element[] = [];
  listeners: Record<string, Function[]> = {}; showCount = 0; closeCount = 0;
  onchange: null | Function = null;
  private html = ''; private text = '';
  constructor(public id: string, private queueClose: (fn: () => void) => void = () => {}) {}
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; this.text = value.replace(/<[^>]*>/g, ''); this.children = []; }
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = value; this.html = escape(value); this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; if (k === 'disabled') this.disabled = true; }
  removeAttribute(k: string) { delete this.attrs[k]; if (k === 'disabled') this.disabled = false; }
  addEventListener(type: string, fn: Function) { (this.listeners[type] ||= []).push(fn); }
  appendChild(el: Element) { this.children.push(el); return el; }
  showModal() { this.open = true; ++this.showCount; }
  close() {
    if (!this.open) return;
    this.open = false; ++this.closeCount;
    this.queueClose(() => { for (const fn of this.listeners.close || []) fn({ target: this }); });
  }
}
function harness(withTemplates = true) {
  const elements = new Map<string, Element>(), closeEvents: Array<() => void> = [];
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element(id, fn => closeEvents.push(fn)));
    return elements.get(id)!;
  };
  const button = el('submit');
  const api = {
    agent: withTemplates ? { taskTemplates: vi.fn(async () => [] as any[]) } : {} as { taskTemplates?: any },
    browser: { list: vi.fn(async () => []) },
    automation: { create: vi.fn(async (_p: any) => ({ success: true } as any)),
      update: vi.fn(async (_p: any) => ({ success: true } as any)),
      list: vi.fn(async () => []), scheduleState: vi.fn(async () => ({ success: true, states: [] })) },
    settings: { automationNotify: vi.fn(async () => prefs()),
      setAutomationNotify: vi.fn(async (p: any) => ({ success: true, automationNotify: p } as any)) },
  };
  const toast = vi.fn();
  const document = {
    readyState: 'complete', hidden: false, documentElement: { lang: 'en' },
    getElementById: el,
    querySelector: (s: string) => {
      if (s === '#dlg-automation button[type="submit"]') return button;
      throw new Error('Unqualified querySelector: ' + s);
    },
    querySelectorAll: (s: string) => {
      if (s === '#auto-template-inputs [data-template-input-key]') return [];
      throw new Error('Unqualified querySelectorAll: ' + s);
    },
    createElement: () => new Element('created'),
    addEventListener: vi.fn(),
  };
  const agent: any = { api, state: { currentTab: 'automation' },
    helpers: { toast, esc: escape, escAttr: escape, icon: () => '' },
    ipc: { call: vi.fn((_key: string, fn: Function) => fn()) } };
  const timers = new Map<number, { fn: () => void; delay: number; cleared: boolean }>();
  let nextTimer = 0;
  const setTimer = vi.fn((fn: () => void, delay: number) => {
    const id = ++nextTimer; timers.set(id, { fn, delay, cleared: false }); return id;
  });
  const clearTimer = vi.fn((id: number) => { const timer = timers.get(id); if (timer) timer.cleared = true; });
  const context = vm.createContext({ window: { agentBrowser: agent }, document,
    setTimeout: setTimer, clearTimeout: clearTimer }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(SOURCE, context, { filename: 'automation.js', timeout: 1000 });
  // Those unrelated list renderers are outside this fixture. The real wrapper,
  // settings reader, checkbox wiring, opener and saveAutomation remain intact.
  agent.automationRefreshLogs = vi.fn(); agent.automationRefreshJobs = vi.fn();
  const toggle = (key: 'system' | 'sound', checked: boolean) => {
    const box = el('auto-notify-' + key); box.checked = checked;
    if (!box.onchange) throw new Error('Checkbox must be wired through real loadAutomationTab');
    return box.onchange({ target: box });
  };
  return { agent, api, el, button, toast, dialog: el('dlg-automation'), timers, toggle, setTimer, clearTimer,
    fireCloseEvents: () => { for (const fn of closeEvents.splice(0)) fn(); },
    forceTimer: (id: number) => { const timer = timers.get(id); if (!timer) throw new Error('Unknown timer'); timer.fn(); },
    status: el('auto-notify-status'), system: el('auto-notify-system'), sound: el('auto-notify-sound') };
}
async function readyNotify(h: ReturnType<typeof harness>, p = prefs()) {
  h.api.settings.automationNotify.mockResolvedValue(p);
  h.agent.loadAutomationTab(); await flush();
  expect(h.system.disabled).toBe(false); expect(h.sound.disabled).toBe(false);
}
function flags(h: ReturnType<typeof harness>) { return prefs(h.system.checked, h.sound.checked); }

describe('template opener generation and save handoff (actual automation.js)', () => {
  it('latest edit wins reverse completion, preserves draft and owns the cached catalog', async () => {
    const h = harness(), a = deferred(), b = deferred();
    h.api.agent.taskTemplates.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    h.agent.automationNew(); h.agent.automationEdit(rule('B'));
    b.resolve(catalog('catalog-B')); await flush(); h.el('auto-name').value = 'typed-B';
    a.resolve(catalog('catalog-A')); await flush();
    expect(h.dialog.showCount).toBe(1); expect(h.el('auto-id').value).toBe('B');
    expect(h.el('auto-name').value).toBe('typed-B');
    expect(h.el('auto-action-template').innerHTML).toContain('catalog-B');
    expect(h.el('auto-action-template').innerHTML).not.toContain('catalog-A');
    h.agent.automationEdit(rule('C')); await flush();
    expect(h.api.agent.taskTemplates).toHaveBeenCalledTimes(2);
    expect(h.el('auto-action-template').innerHTML).toContain('catalog-B');
  });
  it('an older first completion cannot open while the newer request is still pending', async () => {
    const h = harness(), a = deferred(), b = deferred();
    h.api.agent.taskTemplates.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    h.agent.automationEdit(rule('A')); h.agent.automationEdit(rule('B'));
    a.resolve(catalog('A')); await flush();
    expect(h.dialog.open).toBe(false); expect(h.button.disabled).toBe(true);
    h.agent.saveAutomation(); expect(h.api.automation.update).not.toHaveBeenCalled();
    b.resolve(catalog('B')); await flush();
    expect(h.dialog.showCount).toBe(1); expect(h.el('auto-id').value).toBe('B'); expect(h.button.disabled).toBe(false);
  });
  it('latest new wins over edit and ignores an old error without resetting typed inputs', async () => {
    const h = harness(), a = deferred(), b = deferred();
    h.api.agent.taskTemplates.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    h.agent.automationEdit(rule('A')); h.agent.automationNew(); b.resolve(catalog('B')); await flush();
    h.el('auto-name').value = 'new draft'; a.reject(new Error('old catalog error')); await flush();
    expect(h.el('auto-id').value).toBe(''); expect(h.el('auto-name').value).toBe('new draft');
    expect(h.dialog.showCount).toBe(1); expect(h.toast).not.toHaveBeenCalled();
  });
  it.each(['reject', 'throw'] as const)('current catalog %s retains the existing fallback opener', async kind => {
    const h = harness();
    h.api.agent.taskTemplates.mockImplementationOnce(() => {
      if (kind === 'throw') throw new Error('catalog');
      return Promise.reject(new Error('catalog'));
    });
    h.agent.automationEdit(rule('fallback')); await flush();
    expect(h.dialog.open).toBe(true); expect(h.el('auto-id').value).toBe('fallback');
    expect(h.button.disabled).toBe(false); expect(h.dialog.showCount).toBe(1);
  });
  it('missing optional catalog API still opens synchronously', () => {
    const h = harness(false); h.agent.automationNew();
    expect(h.dialog.open).toBe(true); expect(h.button.disabled).toBe(false);
    h.agent.automationEdit(rule('sync')); expect(h.el('auto-id').value).toBe('sync');
  });
  it('closing the visible editor invalidates a pending opener before the queued close event', async () => {
    const h = harness(), waiting = deferred();
    h.api.agent.taskTemplates.mockResolvedValueOnce([]).mockReturnValueOnce(waiting.promise);
    h.agent.automationEdit(rule('visible')); await flush(); h.agent.automationEdit(rule('waiting'));
    h.dialog.close(); waiting.resolve(catalog('late')); await flush();
    expect(h.dialog.open).toBe(false); expect(h.dialog.showCount).toBe(1); h.fireCloseEvents();
    h.api.agent.taskTemplates.mockResolvedValueOnce(catalog('fresh')); h.agent.automationNew(); await flush();
    expect(h.api.agent.taskTemplates).toHaveBeenCalledTimes(3);
    expect(h.el('auto-action-template').innerHTML).not.toContain('late');
  });
  it('a queued old close cannot cancel a newer request that began with the dialog closed', async () => {
    const h = harness(), b = deferred(), c = deferred();
    h.api.agent.taskTemplates.mockResolvedValueOnce([]).mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise);
    h.agent.automationEdit(rule('A')); await flush(); h.agent.automationEdit(rule('B')); h.dialog.close();
    h.agent.automationEdit(rule('C')); h.fireCloseEvents();
    c.resolve(catalog('catalog-C')); await flush(); b.resolve(catalog('catalog-B')); await flush();
    expect(h.dialog.open).toBe(true); expect(h.dialog.showCount).toBe(2); expect(h.el('auto-id').value).toBe('C');
    expect(h.el('auto-action-template').innerHTML).toContain('catalog-C');
    expect(h.el('auto-action-template').innerHTML).not.toContain('catalog-B');
  });
  it('cached close/reopen survives an old close event and an old catalog error', async () => {
    const h = harness(), a = deferred(), b = deferred();
    h.api.agent.taskTemplates.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    h.agent.automationEdit(rule('A')); h.agent.automationEdit(rule('B')); b.resolve(catalog('B')); await flush();
    h.dialog.close(); h.agent.automationEdit(rule('C')); h.fireCloseEvents(); a.reject(new Error('old')); await flush();
    expect(h.dialog.open).toBe(true); expect(h.dialog.showCount).toBe(2); expect(h.el('auto-id').value).toBe('C');
    expect(h.button.disabled).toBe(false); expect(h.toast).not.toHaveBeenCalled();
  });
  it('a new opener invalidates the prior save immediately, before its catalog is ready', async () => {
    const h = harness(), catalogB = deferred(), oldSave = deferred(), newSave = deferred();
    h.agent.loadAutomationTab = vi.fn();
    h.api.agent.taskTemplates.mockResolvedValueOnce([]).mockReturnValueOnce(catalogB.promise);
    h.api.automation.update.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise);
    h.agent.automationEdit(rule('A')); await flush(); h.agent.saveAutomation(); h.agent.automationEdit(rule('B'));
    oldSave.resolve({ success: true }); await flush();
    expect(h.dialog.open).toBe(true); expect(h.dialog.closeCount).toBe(0); expect(h.button.disabled).toBe(true);
    expect(h.toast).not.toHaveBeenCalled(); h.button.disabled = false; h.agent.saveAutomation();
    expect(h.api.automation.update).toHaveBeenCalledTimes(1);
    catalogB.resolve([]); await flush(); expect(h.el('auto-id').value).toBe('B'); expect(h.button.disabled).toBe(false);
    h.agent.saveAutomation(); expect(h.api.automation.update.mock.calls[1][0].id).toBe('B');
    newSave.resolve({ success: true }); await flush();
    expect(h.dialog.closeCount).toBe(1); expect(h.agent.loadAutomationTab).toHaveBeenCalledTimes(1);
  });
  it.each(['resolve', 'reject'] as const)('old catalog %s cannot replace or unlock a newer pending save', async kind => {
    const h = harness(), a = deferred(), b = deferred(), save = deferred();
    h.api.agent.taskTemplates.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    h.api.automation.update.mockReturnValueOnce(save.promise);
    h.agent.automationEdit(rule('A')); h.agent.automationEdit(rule('B')); b.resolve(catalog('B')); await flush();
    h.agent.saveAutomation();
    if (kind === 'resolve') a.resolve(catalog('A')); else a.reject(new Error('A'));
    await flush(); expect(h.el('auto-id').value).toBe('B'); expect(h.button.disabled).toBe(true);
    expect(h.dialog.showCount).toBe(1); expect(h.toast).not.toHaveBeenCalled();
    h.agent.saveAutomation(); expect(h.api.automation.update).toHaveBeenCalledTimes(1);
    save.resolve({ success: false, error: 'retry B' }); await flush();
    expect(h.dialog.open).toBe(true); expect(h.button.disabled).toBe(false);
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('retry B'), 'error');
  });
});

describe('notify settings read/write/feedback ownership (actual automation.js)', () => {
  it('loads a verified prefs snapshot and wires the real save-on-change handlers', async () => {
    const h = harness(); await readyNotify(h, prefs(true, false));
    expect(flags(h)).toEqual(prefs(true, false)); expect(h.status.textContent).toBe('');
    expect(h.api.settings.setAutomationNotify).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'] as const)('late read %s and its finally cannot overwrite/unlock a newer write', async kind => {
    const h = harness(), a = deferred(), b = deferred(), write = deferred();
    h.api.settings.automationNotify.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    h.agent.loadAutomationTab(); h.agent.loadAutomationNotifySettings();
    b.resolve(prefs(true, false)); await flush(); h.api.settings.setAutomationNotify.mockReturnValueOnce(write.promise);
    h.toggle('sound', true);
    if (kind === 'resolve') a.resolve(prefs(false, false)); else a.reject(new Error('stale read'));
    await flush(); expect(flags(h)).toEqual(prefs(true, true));
    expect(h.system.disabled).toBe(true); expect(h.sound.disabled).toBe(true); expect(h.status.textContent).toBe('');
    write.resolve({ success: true }); await flush();
    expect(flags(h)).toEqual(prefs(true, true)); expect(h.status.textContent).toContain('已保存');
    expect(h.system.disabled).toBe(false); expect(h.api.settings.setAutomationNotify).toHaveBeenCalledTimes(1);
  });
  it('initial read owns controls even when disabled is bypassed; no unverified full-prefs write', async () => {
    const h = harness(), read = deferred(); h.api.settings.automationNotify.mockReturnValueOnce(read.promise);
    h.agent.loadAutomationTab(); h.system.disabled = false; h.toggle('system', true);
    expect(h.api.settings.setAutomationNotify).not.toHaveBeenCalled(); expect(flags(h)).toEqual(prefs());
    read.resolve(prefs(false, true)); await flush(); expect(flags(h)).toEqual(prefs(false, true)); expect(h.system.disabled).toBe(false);
  });
  it.each(['reject', 'throw', 'malformed'] as const)('initial read %s stays visibly failed and write-locked until a verified read', async kind => {
    const h = harness(); h.api.settings.automationNotify.mockImplementationOnce(() => {
      if (kind === 'throw') throw new Error('read error');
      if (kind === 'reject') return Promise.reject(new Error('read error'));
      return Promise.resolve({} as any);
    });
    h.agent.loadAutomationTab(); await flush();
    expect(h.status.innerHTML).toContain('danger-text'); expect(h.system.disabled).toBe(true);
    h.system.disabled = false; h.toggle('system', true); expect(h.api.settings.setAutomationNotify).not.toHaveBeenCalled();
    h.api.settings.automationNotify.mockResolvedValueOnce(prefs(true, false)); h.agent.loadAutomationNotifySettings(); await flush();
    expect(flags(h)).toEqual(prefs(true, false)); expect(h.system.disabled).toBe(false);
  });
  it('pending writes serialize both controls, reject programmatic repeat and skip refresh reads', async () => {
    const h = harness(), write = deferred(); await readyNotify(h);
    h.api.settings.setAutomationNotify.mockReturnValueOnce(write.promise); h.toggle('system', true);
    h.system.disabled = false; h.sound.disabled = false; h.toggle('sound', true); h.toggle('system', false);
    h.agent.loadAutomationTab(); await flush();
    expect(h.api.settings.setAutomationNotify).toHaveBeenCalledTimes(1);
    expect(h.api.settings.setAutomationNotify).toHaveBeenCalledWith(prefs(true, false));
    expect(h.api.settings.automationNotify).toHaveBeenCalledTimes(1); expect(flags(h)).toEqual(prefs(true, false));
    expect(h.system.disabled).toBe(true); expect(h.sound.disabled).toBe(true);
    write.resolve({ success: true, automationNotify: prefs(false, true) }); await flush();
    expect(flags(h)).toEqual(prefs(false, true)); expect(h.system.disabled).toBe(false); expect(h.sound.disabled).toBe(false);
  });
  it.each([
    ['false', { success: false, error: '<nope>' }], ['undefined', undefined], ['null', null], ['empty', {}],
    ['numeric', { success: 1 }], ['string-true', { success: 'true' }], ['string-false', { success: 'false' }],
  ] as Array<[string, any]>)('save %s clears old Saved, restores prefs, retains failure after reconciliation and permits retry', async (_name, response) => {
    const h = harness(), readback = deferred(); await readyNotify(h, prefs(false, true));
    h.toggle('system', true); await flush(); expect(h.status.textContent).toContain('已保存');
    const oldTimer = [...h.timers.keys()][0]; expect(h.timers.get(oldTimer)!.delay).toBe(2500);
    h.api.settings.setAutomationNotify.mockResolvedValueOnce(response);
    h.api.settings.automationNotify.mockReturnValueOnce(readback.promise);
    h.toggle('sound', false); expect(h.status.textContent).toBe(''); await flush();
    expect(flags(h)).toEqual(prefs(true, true)); expect(h.status.innerHTML).toContain('danger-text');
    expect(h.status.textContent).not.toContain('已保存');
    if (_name === 'false') { expect(h.status.innerHTML).toContain('&lt;nope&gt;'); expect(h.status.innerHTML).not.toContain('<nope>'); }
    const failure = h.status.innerHTML; h.forceTimer(oldTimer); expect(h.status.innerHTML).toBe(failure);
    expect(h.system.disabled).toBe(true); h.toggle('sound', false); expect(flags(h)).toEqual(prefs(true, true));
    expect(h.api.settings.setAutomationNotify).toHaveBeenCalledTimes(2);
    readback.resolve(prefs(true, true)); await flush();
    expect(flags(h)).toEqual(prefs(true, true)); expect(h.status.innerHTML).toBe(failure); expect(h.system.disabled).toBe(false);
    h.toggle('sound', false); await flush(); expect(h.api.settings.setAutomationNotify).toHaveBeenCalledTimes(3);
    expect(h.status.textContent).toContain('已保存'); h.forceTimer(oldTimer); expect(h.status.textContent).toContain('已保存');
    h.forceTimer([...h.timers.keys()].at(-1)!); expect(h.status.textContent).toBe('');
  });
  it.each(['reject', 'throw'] as const)('save %s reconciles a possible committed value without hiding the error or replaying write', async kind => {
    const h = harness(), write = deferred(), readback = deferred(); await readyNotify(h);
    h.api.settings.setAutomationNotify.mockImplementationOnce(() => {
      if (kind === 'throw') throw new Error('transport lost');
      return write.promise;
    });
    h.api.settings.automationNotify.mockReturnValueOnce(readback.promise); h.toggle('system', true);
    if (kind === 'reject') write.reject(new Error('transport lost'));
    await flush(); expect(flags(h)).toEqual(prefs()); expect(h.status.textContent).toContain('transport lost');
    expect(h.system.disabled).toBe(true); readback.resolve(prefs(true, true)); await flush();
    expect(flags(h)).toEqual(prefs(true, true)); expect(h.status.textContent).toContain('transport lost');
    expect(h.status.textContent).not.toContain('已保存'); expect(h.system.disabled).toBe(false);
    expect(h.api.settings.setAutomationNotify).toHaveBeenCalledTimes(1); expect(h.api.settings.automationNotify).toHaveBeenCalledTimes(2);
    h.toggle('sound', false); await flush(); expect(h.api.settings.setAutomationNotify).toHaveBeenLastCalledWith(prefs(true, false));
  });
  it('failed reconciliation keeps the error and disables writes until a later successful read', async () => {
    const h = harness(); await readyNotify(h, prefs(false, true));
    h.api.settings.setAutomationNotify.mockRejectedValueOnce(new Error('write uncertain'));
    h.api.settings.automationNotify.mockRejectedValueOnce(new Error('readback failed'));
    h.toggle('system', true); await flush();
    expect(flags(h)).toEqual(prefs(false, true)); expect(h.status.textContent).toContain('write uncertain');
    expect(h.status.textContent).not.toContain('已保存'); expect(h.system.disabled).toBe(true);
    h.system.disabled = false; h.toggle('system', true); expect(h.api.settings.setAutomationNotify).toHaveBeenCalledTimes(1);
    h.api.settings.automationNotify.mockResolvedValueOnce(prefs(true, true)); h.agent.loadAutomationNotifySettings(); await flush();
    expect(flags(h)).toEqual(prefs(true, true)); expect(h.system.disabled).toBe(false);
  });
  it('old Saved timer cannot falsely complete a still-pending write; no timeout or automatic write retry', async () => {
    const h = harness(), write = deferred(); await readyNotify(h);
    h.toggle('system', true); await flush(); const oldTimer = [...h.timers.keys()][0];
    h.api.settings.setAutomationNotify.mockReturnValueOnce(write.promise); h.toggle('sound', true);
    h.forceTimer(oldTimer); await flush();
    expect(h.status.textContent).toBe(''); expect(h.system.disabled).toBe(true); expect(h.sound.disabled).toBe(true);
    expect(h.api.settings.setAutomationNotify).toHaveBeenCalledTimes(2);
    expect([...h.timers.values()].filter(timer => !timer.cleared)).toHaveLength(0);
    h.toggle('system', false); expect(h.api.settings.setAutomationNotify).toHaveBeenCalledTimes(2);
    write.resolve({ success: true }); await flush(); expect(flags(h)).toEqual(prefs(true, true)); expect(h.system.disabled).toBe(false);
  });
});
