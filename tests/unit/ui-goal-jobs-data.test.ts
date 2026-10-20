// Whole-module renderer acceptance with a deliberately small DOM and controlled
// API replies. These fixtures prove UI behavior, NOT IPC/auth or persistence.
// The final SQLite case explicitly uses the production store and inspects disk.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

const storeDir = vi.hoisted(() => {
  const fs = process.getBuiltinModule('fs');
  const path = process.getBuiltinModule('path');
  const parent = process.env.UI_GOAL_JOBS_STORAGE || process.getBuiltinModule('os').tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, 'goal-jobs-sqlite-'));
});
vi.mock('../../src/main/services/config-manager.js', () => ({ getAppDataDir: () => storeDir, getConfig: () => ({ automation: [] }) }));
const retryFixture = vi.hoisted(() => ({ runs: [] as any[], active: new Set<string>() }));
vi.mock('../../src/main/services/agent-run-trace.js', () => ({ agentRunRecorder: {
  listRuns: () => retryFixture.runs,
  isActive: (id: string) => retryFixture.active.has(id),
} }));
import { listJobRetryCandidates } from '../../src/main/services/automation-retry.js';
import { agentDbTables, agentDbQuery, agentDbExecScript, agentDbTableData, closeAgentDb } from '../../src/main/services/agent-db.js';
const ROOT = path.resolve(__dirname, '../..');
const INDEX = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const key = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

// Parses rendered markup so tests click only buttons the real module emitted.
// No layout/focus/native-dropdown claims are made by this Node-only DOM.
class Element {
  value = ''; checked = false; open = false; disabled = false;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  style: Record<string, string> = {}; children: Element[] = []; parent: Element | null = null;
  listeners: Record<string, Array<(e: any) => void>> = {};
  onclick?: (e: any) => void; onchange?: (e: any) => void; oninput?: (e: any) => void;
  private markup = ''; private text = '';
  classList = { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() };
  constructor(public tag = 'div', public id = '') {}
  set innerHTML(html: string) {
    this.markup = html; this.text = ''; this.children = [];
    const stack: Element[] = [this];
    const tokens = /<\/?[\w-]+\b[^>]*>|[^<]+/g;
    for (const token of html.match(tokens) || []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith('<')) { stack[stack.length - 1].text += decode(token); continue; }
      const tag = token.match(/^<([\w-]+)/)![1];
      const node = new Element(tag);
      for (const attr of token.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], decode(attr[2]));
      if (/\sdisabled(?:\s|>)/.test(token)) node.disabled = true;
      stack[stack.length - 1].appendChild(node);
      if (!['input', 'br', 'hr', 'img', 'meta', 'link'].includes(tag)) stack.push(node);
    }
  }
  get innerHTML() { return this.markup; }
  set textContent(s: string) { this.text = s; this.children = []; this.markup = ''; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  appendChild(n: Element) { n.parent = this; this.children.push(n); return n; }
  contains(n: Element): boolean { return n === this || this.children.some(c => c.contains(n)); }
  setAttribute(k: string, v: unknown) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k.startsWith('data-')) this.dataset[key(k.slice(5))] = String(v);
    if (k === 'disabled') this.disabled = true;
  }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  removeAttribute(k: string) { delete this.attributes[k]; if (k === 'disabled') this.disabled = false; }
  matches(selector: string): boolean {
    return selector.split(',').some(s => {
      s = s.trim();
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s.startsWith('.')) return (this.attributes.class || '').split(' ').includes(s.slice(1));
      const attr = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (attr) {
        const value = attr[1].startsWith('data-') ? this.dataset[key(attr[1].slice(5))] : this.attributes[attr[1]];
        return value !== undefined && (attr[2] === undefined || value === attr[2]);
      }
      return this.tag === s;
    });
  }
  closest(s: string): Element | null { return this.matches(s) ? this : this.parent?.closest(s) || null; }
  querySelectorAll(s: string): Element[] { return this.children.flatMap(c => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]); }
  querySelector(s: string) { return this.querySelectorAll(s)[0] || null; }
  addEventListener(k: string, fn: (e: any) => void) { (this.listeners[k] ||= []).push(fn); }
  fire(k: string, e: any = {}) {
    e.target ||= this;
    for (let node: Element | null = this; node; node = node.parent) {
      for (const fn of node.listeners[k] || []) fn(e);
      const fn = (node as any)['on' + k]; if (fn) fn(e);
    }
  }
  showModal() { this.open = true; }
  // Native close queues its event; the open flag changes synchronously. Keeping
  // delivery explicit lets tests put a Promise reply before the old close event.
  deferCloseEvent = false;
  close() { this.open = false; if (!this.deferCloseEvent) this.deliverClose(); }
  deliverClose() { this.fire('close'); }
  cancel() { this.fire('cancel'); this.open = false; if (!this.deferCloseEvent) this.deliverClose(); }
  escape() { this.fire('keydown', { key: 'Escape' }); this.cancel(); }
}
function deferred<T = any>() {
  let resolve!: (x: T) => void, reject!: (x: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function harness(modules: string[] = ['runs', 'automation', 'db', 'activity']) {
  const elements: Record<string, Element> = {};
  for (const m of INDEX.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) elements[m[2]] = new Element(m[1], m[2]);
  ['agent-run-artifacts', 'agent-run-preview', 'agent-run-detail-actions'].forEach(id => elements['dlg-agent-run'].appendChild(elements[id]));
  const filters = new Element(); filters.setAttribute('class', 'run-filters');
  Object.keys(elements).filter(id => id.startsWith('run-filter-')).forEach(id => filters.appendChild(elements[id]));
  const events: Record<string, (p: any) => void> = {};
  const api: any = {
    agentRuns: { list: vi.fn(async () => []), get: vi.fn(async () => null), resultsPreview: vi.fn(async () => ({ ok: false, error: 'fixture unavailable' })) },
    automation: { list: vi.fn(async () => []), scheduleState: vi.fn(async () => ({ success: true, states: [] })), jobs: vi.fn(async () => []), logs: vi.fn(async () => []), jobGet: vi.fn(async () => null), retryRun: vi.fn(async () => ({ ok: false, error: 'fixture only' })), retryJob: vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: [] })), validateCron: vi.fn(async () => ({ valid: true })) },
    agentDb: { tables: vi.fn(async () => []), tableData: vi.fn(async () => ({ rows: [], total: 0 })), query: vi.fn(async () => ({ ok: true, rows: [], count: 0 })), exec: vi.fn(async () => ({ ok: false, error: 'fixture only' })) },
    audit: { list: vi.fn(async () => []) }, browser: { list: vi.fn(async () => []) },
    agent: { taskTemplates: vi.fn(async () => []) }, on: (s: string, fn: (p: any) => void) => { events[s] = fn; },
  };
  const esc = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const agentBrowser: any = {
    api, state: { currentTab: 'runs' }, helpers: { esc, escAttr: esc, icon: () => '<svg></svg>', fmtDuration: (n: number) => String(n), toast: vi.fn() },
    ipc: { call: (_s: string, fn: () => Promise<any>) => Promise.resolve().then(fn) },
    confirm: vi.fn(), // Never auto-accept a persistent action in a UI-only fixture.
    renderViewState: (el: Element, opts: any) => { el.textContent = opts.error || opts.empty || opts.loading || ''; },
  };
  const document = {
    readyState: 'complete', hidden: false,
    getElementById: (id: string) => elements[id] || Object.values(elements).flatMap(e => e.querySelectorAll('#' + id))[0] || null,
    querySelector: (s: string) => s === '.run-filters' ? filters : null,
    querySelectorAll: (s: string) => s === '#auto-template-inputs [data-template-input-key]' ? elements['auto-template-inputs'].querySelectorAll('[data-template-input-key]') : [],
    createElement: (s: string) => new Element(s), addEventListener: vi.fn(),
  };
  const context = vm.createContext({ window: { agentBrowser }, document, console, setInterval: () => 1, setTimeout: () => 1 });
  for (const m of modules) vm.runInContext(fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${m}.js`), 'utf8'), context, { filename: m + '.js' });
  return { elements, filters, api, agentBrowser, events, document };
}
const run = (id: string, extra: any = {}) => ({ id, name: id, status: 'done', startedAt: 1, finishedAt: 2, stepCount: 0, steps: [], variables: {}, artifacts: [], dirId: 'profile_fixture', source: { type: 'automation', ruleId: 'rule_fixture', jobId: 'job_fixture' }, ...extra });
const rule = (id = 'rule_fixture') => ({ id, name: id, enabled: true, trigger: { type: 'once', at: 1 }, action: { type: 'custom-js', jsCode: 'throw new Error("inert fixture")' } });
function click(el: Element, selector: string) {
  const btn = el.querySelector(selector); expect(btn, `emitted control ${selector}`).not.toBeNull(); btn!.fire('click');
}
const preview = (value: string) => ({ ok: true, columns: ['fixture'], rows: [[value]], total: 101, rejectedRowCount: 0 });

describe('UI goal Jobs/data — whole-module controlled replies', () => {
  it('first no-match render recovers delegated Run actions when the filter is cleared', async () => {
    const h = harness(['runs']); h.elements['run-filter-name'].value = 'no-match';
    h.api.agentRuns.list.mockResolvedValue([run('run_A')]); h.api.agentRuns.get.mockResolvedValue(run('run_A'));
    h.agentBrowser.loadRunsTab(); await flush();
    expect(h.elements['agent-run-list'].querySelector('[data-run-action]')).toBeNull();
    h.elements['run-filter-name'].value = ''; h.elements['run-filter-name'].fire('input');
    click(h.elements['agent-run-list'], '[data-run-action="open"]'); await flush();
    expect(h.api.agentRuns.get).toHaveBeenCalledWith('run_A'); expect(h.elements['dlg-agent-run'].open).toBe(true);
  });
  it.each(['resolve', 'reject'])('a late A preview %s cannot paint or change B pager identity', async kind => {
    const h = harness(['runs']); const late = deferred();
    h.api.agentRuns.get.mockImplementation(async (id: string) => run(id, { artifacts: id === 'run_A' ? [{ id: 'artifact_A', name: 'A', kind: 'dataset' }] : [] }));
    h.api.agentRuns.resultsPreview.mockReturnValue(late.promise);
    await h.agentBrowser.runsOpen('run_A'); click(h.elements['agent-run-artifacts'], '[data-artifact-action="preview"]');
    await flush(); await h.agentBrowser.runsOpen('run_B');
    if (kind === 'resolve') late.resolve(preview('A stale')); else late.reject(new Error('A stale'));
    await flush(); expect(h.elements['agent-run-preview'].textContent).toBe('');
    expect(h.elements['agent-run-title'].textContent).toBe('run_B');
  });
  it('current preview paginates by the current run/artifact and renders integrity errors without old rows', async () => {
    const h = harness(['runs']);
    h.api.agentRuns.get.mockResolvedValue(run('run_B', { artifacts: [{ id: 'artifact_B', name: 'B', kind: 'dataset' }] }));
    h.api.agentRuns.resultsPreview.mockResolvedValue(preview('<unsafe>'));
    await h.agentBrowser.runsOpen('run_B');
    click(h.elements['agent-run-artifacts'], '[data-artifact-action="preview"]'); await flush();
    expect(h.elements['agent-run-preview'].textContent).toContain('<unsafe>');
    h.api.agentRuns.resultsPreview.mockResolvedValue({ ok: false, error: 'hash mismatch' });
    click(h.elements['agent-run-preview'], '[data-preview-page="next"]'); await flush();
    expect(h.api.agentRuns.resultsPreview).toHaveBeenLastCalledWith({ runId: 'run_B', artifactId: 'artifact_B', offset: 100, limit: 100 });
    expect(h.elements['agent-run-preview'].textContent).toContain('hash mismatch'); expect(h.elements['agent-run-preview'].querySelector('table')).toBeNull();
  });
  it.each(['agent:run-step', 'agent:run-finish'])('%s refreshes open detail by ID, including off-tab and same-name runs', async event => {
    const h = harness(['runs']); h.api.agentRuns.get.mockResolvedValue(run('run_A', { name: 'duplicate', status: 'running', finishedAt: undefined }));
    await h.agentBrowser.runsOpen('run_A'); h.agentBrowser.state.currentTab = 'activity';
    h.api.agentRuns.get.mockResolvedValue(run('run_A', { name: 'duplicate', verification: { status: 'passed' }, steps: [{ tool: 'fixture-step', ok: true, durationMs: 2 }] }));
    h.events[event]({ runId: 'run_other', run: { id: 'run_other', name: 'duplicate' } }); await flush();
    expect(h.api.agentRuns.get).toHaveBeenCalledTimes(1);
    h.events[event]({ runId: 'run_A', run: { id: 'run_A', name: 'duplicate' } }); await flush();
    expect(h.api.agentRuns.get).toHaveBeenCalledTimes(2); expect(h.elements['agent-run-steps'].textContent).toContain('fixture-step');
    expect(h.elements['agent-run-meta'].querySelector('[data-live-since]')).toBeNull();
    h.elements['dlg-agent-run'].close(); h.events[event]({ run: { id: 'run_A' } }); await flush(); expect(h.api.agentRuns.get).toHaveBeenCalledTimes(2);
  });
  it('retry-all counts only execution errors; ordinary successful single rerun remains available', async () => {
    const h = harness(['runs']); h.api.agentRuns.list.mockResolvedValue([run('run_passed'), run('run_business_failed', { verification: { status: 'failed' } }), run('run_error', { status: 'error' }), run('run_live', { status: 'running' })]);
    h.agentBrowser.loadRunsTab(); await flush();
    // The summary list is capped, so even an unfiltered count is not authoritative.
    const list = h.elements['agent-run-list']; expect(list.querySelector('[data-group-action="retry-failed"]')!.textContent).toBe('重试全部失败');
    expect(list.querySelector('[data-run-id="run_passed"]')!.querySelector('[data-run-action="retry"]')).not.toBeNull();
    expect(list.querySelector('[data-run-id="run_live"]')!.querySelector('[data-run-action="retry"]')).toBeNull();
    click(list, '[data-group-action="retry-failed"]'); expect(h.agentBrowser.confirm).toHaveBeenCalledTimes(1); expect(h.api.automation.retryJob).not.toHaveBeenCalled();
  });
  it.each(['verification', 'name', 'profile', 'endReason', 'source', 'range'])('user %s filter never narrows retry-all payload or invents a target count', async filter => {
    const h = harness(['runs']); const now = Date.now();
    const rows = [
      run('passed', { name: 'shown passed', startedAt: now, endReason: 'completed', verification: { status: 'passed' } }),
      run('visible_error', { name: 'shown error', startedAt: now, status: 'error', endReason: 'completed', verification: { status: 'passed' } }),
      run('hidden_error', { name: 'hidden', startedAt: 1, status: 'error', dirId: 'hidden_profile', endReason: 'execution_error', verification: { status: 'failed' } }),
      run('active_error', { status: 'error' }),
      run('business_failed', { verification: { status: 'failed' } }),
      run('foreign_error', { status: 'error', source: { type: 'automation', jobId: 'other_job', ruleId: 'rule_fixture' } }),
      run('missing_profile', { status: 'error', dirId: '' }),
      run('missing_rule', { status: 'error', source: { type: 'automation', jobId: 'job_fixture' } }),
      run('chat_error', { status: 'error', source: { type: 'chat', jobId: 'job_fixture', ruleId: 'rule_fixture' } }),
    ];
    retryFixture.runs = rows; retryFixture.active = new Set(['active_error']);
    expect(listJobRetryCandidates('job_fixture').map(r => r.id)).toEqual(['visible_error', 'hidden_error']);
    h.api.agentRuns.list.mockResolvedValue(rows.slice(0, 3));
    h.api.automation.retryJob.mockImplementation(async (jobId: string) => {
      const targets = listJobRetryCandidates(jobId);
      return { attempted: targets.length, succeeded: targets.length, failed: [] };
    });
    h.agentBrowser.loadRunsTab(); await flush();
    const values: Record<string, string> = { verification: 'passed', name: 'shown', profile: 'profile_fixture', endReason: 'completed', source: 'automation', range: '1h' };
    const field = h.elements['run-filter-' + filter]; field.value = values[filter]; field.fire(filter === 'name' ? 'input' : 'change');
    const list = h.elements['agent-run-list']; const button = list.querySelector('[data-group-action="retry-failed"]')!;
    expect(button).not.toBeNull(); expect(button.textContent).toBe('重试全部失败');
    if (filter !== 'source') expect(list.querySelector('[data-run-id="hidden_error"]')).toBeNull();
    click(list.querySelector('[data-run-id="passed"]')!, '[data-run-action="retry"]');
    expect(h.api.automation.retryRun).not.toHaveBeenCalled();
    h.agentBrowser.confirm.mock.calls[0][1](); await flush(); expect(h.api.automation.retryRun).toHaveBeenCalledWith('passed');
    h.agentBrowser.helpers.toast.mockClear();
    click(list, '[data-group-action="retry-failed"]');
    expect(h.api.automation.retryJob).not.toHaveBeenCalled();
    expect(h.agentBrowser.confirm.mock.calls[1][0]).toContain('所有失败');
    h.agentBrowser.confirm.mock.calls[1][1](); await flush();
    expect(h.api.automation.retryJob.mock.calls).toEqual([['job_fixture']]);
    expect(h.agentBrowser.helpers.toast).toHaveBeenCalledWith(expect.stringContaining('(2/2)'), 'success');
    expect(listJobRetryCandidates('job_fixture').map(r => r.id)).toEqual(['visible_error', 'hidden_error']);
    field.value = filter === 'name' ? '' : 'all'; field.fire(filter === 'name' ? 'input' : 'change');
    expect(list.querySelector('[data-run-id="hidden_error"]')).not.toBeNull();
  });
  it('displayed successful rows still offer full-job retry when a known execution error is hidden', async () => {
    const h = harness(['runs']); h.api.agentRuns.list.mockResolvedValue([
      run('passed_A', { verification: { status: 'passed' } }), run('passed_B', { verification: { status: 'passed' } }),
      run('hidden_error', { status: 'error', verification: { status: 'failed' } }),
    ]);
    h.agentBrowser.loadRunsTab(); await flush();
    h.elements['run-filter-verification'].value = 'passed'; h.elements['run-filter-verification'].fire('change');
    const list = h.elements['agent-run-list']; expect(list.querySelector('[data-run-id="hidden_error"]')).toBeNull();
    expect(list.querySelector('[data-group-action="retry-failed"]')!.textContent).toBe('重试全部失败');
    expect(list.querySelectorAll('[data-run-action="retry"]')).toHaveLength(2);
  });
  it('even a capped unfiltered summary cannot promise the full backend retry count', async () => {
    const h = harness(['runs']); const visible = [run('passed'), run('visible_error', { status: 'error' })];
    retryFixture.runs = [...visible, run('beyond_summary_limit', { status: 'error' })]; retryFixture.active = new Set();
    h.api.agentRuns.list.mockResolvedValue(visible); h.agentBrowser.loadRunsTab(); await flush();
    expect(listJobRetryCandidates('job_fixture').map(r => r.id)).toEqual(['visible_error', 'beyond_summary_limit']);
    expect(h.elements['agent-run-list'].querySelector('[data-group-action="retry-failed"]')!.textContent).toBe('重试全部失败');
  });
  it('all-success batches have no misleading retry-failed control', async () => {
    const h = harness(['runs']); h.api.agentRuns.list.mockResolvedValue([run('A'), run('B')]); h.agentBrowser.loadRunsTab(); await flush();
    expect(h.elements['agent-run-list'].querySelector('[data-group-action]')).toBeNull();
  });
  it('rules arriving before schedule state eventually show reschedule and exactly one Disable', async () => {
    const h = harness(['automation']); const state = deferred(); h.api.automation.list.mockResolvedValue([rule()]); h.api.automation.scheduleState.mockReturnValue(state.promise);
    h.agentBrowser.loadAutomationTab(); await flush(); state.resolve({ success: true, states: [{ ruleId: 'rule_fixture', phase: 'missed-once', onceAt: 1 }] }); await flush();
    const list = h.elements['automation-list']; expect(list.querySelector('[data-rule-action="reschedule"]')).not.toBeNull();
    expect(list.querySelectorAll('[data-rule-action="toggle"]')).toHaveLength(1);
    click(list, '[data-rule-action="reschedule"]'); await flush(); expect(h.elements['auto-reschedule-id'].value).toBe('rule_fixture');
  });
  it('schedule failure preserves rule actions and reports the read failure', async () => {
    const h = harness(['automation']); h.api.automation.list.mockResolvedValue([rule()]); h.api.automation.scheduleState.mockRejectedValue(new Error('schedule unavailable'));
    h.agentBrowser.loadAutomationTab(); await flush(); expect(h.elements['automation-list'].querySelector('[data-rule-action="edit"]')).not.toBeNull();
    expect(h.elements['automation-list'].textContent).not.toMatch(/加载中|Loading/);
    expect(h.elements['automation-list'].textContent).toContain('Schedule unavailable');
    expect(h.elements['automation-list'].querySelector('[data-rule-action="reschedule"]')).toBeNull();
    expect(h.agentBrowser.helpers.toast).toHaveBeenCalledWith(expect.stringContaining('schedule unavailable'), 'error');
  });
  it.each([false, true])('fulfilled unavailable schedule response (success=%s) never remains Loading or unlocks reschedule', async success => {
    const h = harness(['automation']); const original = rule(); h.api.automation.list.mockResolvedValue([original]);
    h.api.automation.scheduleState.mockResolvedValue(success ? { success: true, states: [] } : { success: false, error: 'state response failed' });
    const before = JSON.stringify(original); h.agentBrowser.loadAutomationTab(); await flush();
    expect(h.elements['automation-list'].textContent).toContain('Schedule unavailable');
    expect(h.elements['automation-list'].textContent).not.toMatch(/加载中|Loading/);
    expect(h.elements['automation-list'].querySelector('[data-rule-action="reschedule"]')).toBeNull(); expect(JSON.stringify(original)).toBe(before);
    if (!success) expect(h.agentBrowser.helpers.toast).toHaveBeenCalledWith(expect.stringContaining('state response failed'), 'error');
  });
  it.each(['custom-js', 'sync-push', 'launch-profile'])('machine inputs hide on %s and restore without losing typed values', async action => {
    const h = harness(['automation']); h.api.agent.taskTemplates.mockResolvedValue([{ id: 'machine_fixture', title: 'fixture', machine: {}, requiredInputs: [{ key: 'url', required: true }] }]);
    h.agentBrowser.automationEdit({ ...rule(), action: { type: 'agent-task', templateId: 'machine_fixture', templateInputs: { url: 'initial' } } }); await flush();
    const field = h.document.getElementById('auto-ti-url')!; field.value = 'edited';
    h.elements['auto-action-type'].value = action; h.elements['auto-action-type'].fire('change'); expect(h.elements['auto-template-inputs-row'].style.display).toBe('none');
    h.elements['auto-action-type'].value = 'agent-task'; h.elements['auto-action-type'].fire('change'); expect(h.elements['auto-template-inputs-row'].style.display).toBe(''); expect(field.value).toBe('edited');
  });
  it('an empty first database still binds Cmd/Ctrl+Enter once; plain Enter does not execute', async () => {
    const h = harness(['db']); h.agentBrowser.loadDbTab(); await flush(); const sql = h.elements['db-sql']; sql.value = 'SELECT 7 AS fixture';
    sql.fire('keydown', { key: 'Enter', preventDefault: vi.fn() }); await flush(); expect(h.api.agentDb.query).not.toHaveBeenCalled();
    for (const modifier of ['ctrlKey', 'metaKey']) { const preventDefault = vi.fn(); sql.fire('keydown', { key: 'Enter', [modifier]: true, preventDefault }); await flush(); expect(preventDefault).toHaveBeenCalledTimes(1); }
    h.agentBrowser.loadDbTab(); await flush(); expect(sql.listeners.keydown).toHaveLength(1); expect(h.api.agentDb.query).toHaveBeenCalledTimes(2);
  });
  it.each(['jobs', 'activity', 'tables', 'runs'])('%s list ignores reversed replies and stale errors', async kind => {
    const h = harness(); const a = deferred(), b = deferred(), oldError = deferred(), newest = deferred();
    const api = kind === 'jobs' ? h.api.automation.jobs : kind === 'activity' ? h.api.audit.list : kind === 'tables' ? h.api.agentDb.tables : h.api.agentRuns.list;
    const load = kind === 'jobs' ? h.agentBrowser.automationRefreshJobs : kind === 'activity' ? h.agentBrowser.loadActivity : kind === 'tables' ? h.agentBrowser.loadDbTab : h.agentBrowser.loadRunsTab;
    const el = h.elements[kind === 'jobs' ? 'automation-jobs' : kind === 'activity' ? 'activity-list' : kind === 'tables' ? 'db-tables' : 'agent-run-list'];
    const data = (name: string) => kind === 'jobs' ? [{ id: name, ruleName: name, status: 'done' }] : kind === 'activity' ? [{ category: 'profile', action: name, at: 1 }] : kind === 'tables' ? [{ name, rowCount: 0 }] : [run(name)];
    api.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(oldError.promise).mockReturnValueOnce(newest.promise);
    load(); load(); await flush(); b.resolve(data('new')); await flush(); a.resolve(data('old')); await flush(); expect(el.textContent).toContain('new'); expect(el.textContent).not.toContain('old');
    load(); load(); await flush(); newest.resolve(data('newest')); await flush(); oldError.reject(new Error('stale error')); await flush(); expect(el.textContent).toContain('newest'); expect(h.agentBrowser.helpers.toast).not.toHaveBeenCalled();
  });
  it.each(['table', 'query'])('latest %s result cannot be overwritten by an earlier table read', async kind => {
    const h = harness(['db']); const old = deferred(); h.api.agentDb.tableData.mockReturnValueOnce(old.promise).mockResolvedValue({ columns: ['v'], rows: [{ v: 'new table' }], total: 1 });
    h.agentBrowser.dbViewTable('old');
    if (kind === 'table') h.agentBrowser.dbViewTable('new'); else { h.elements['db-sql'].value = 'SELECT fixture'; h.api.agentDb.query.mockResolvedValue({ ok: true, rows: [{ v: 'new query' }] }); h.agentBrowser.dbRunSql(); }
    await flush(); old.resolve({ columns: ['v'], rows: [{ v: 'stale value' }], total: 1 }); await flush();
    expect(h.elements['db-result'].textContent).toContain('new'); expect(h.elements['db-result'].textContent).not.toContain('stale value');
  });
  it('current table read failure replaces the old result and reports the error', async () => {
    const h = harness(['db']); h.elements['db-result'].textContent = 'old authoritative rows'; h.api.agentDb.tableData.mockRejectedValue(new Error('current read failure'));
    h.agentBrowser.dbViewTable('missing'); await flush(); expect(h.elements['db-result'].textContent).not.toContain('old authoritative'); expect(h.elements['db-result'].textContent).toContain('current read failure'); expect(h.agentBrowser.helpers.toast).toHaveBeenCalled();
  });
  it('a state-first missed-once card has one Disable, not two identical actions', async () => {
    const h = harness(['automation']); h.api.automation.list.mockResolvedValue([rule()]);
    h.api.automation.scheduleState.mockResolvedValue({ success: true, states: [{ ruleId: 'rule_fixture', phase: 'missed-once' }] });
    h.agentBrowser.loadAutomationTab(); await flush();
    expect(h.elements['automation-list'].querySelectorAll('[data-rule-action="toggle"]')).toHaveLength(1);
  });
  it('reversed rule/state pairs retain the latest matching rule and phase', async () => {
    const h = harness(['automation']); const oldRules = deferred(), oldStates = deferred();
    h.api.automation.list.mockReturnValueOnce(oldRules.promise).mockResolvedValue([rule('rule_new')]);
    h.api.automation.scheduleState.mockReturnValueOnce(oldStates.promise).mockResolvedValue({ success: true, states: [{ ruleId: 'rule_new', phase: 'missed-once' }] });
    h.agentBrowser.loadAutomationTab(); await flush(); h.agentBrowser.loadAutomationTab(); await flush();
    oldRules.resolve([rule('rule_old')]); oldStates.resolve({ success: true, states: [{ ruleId: 'rule_old', phase: 'user-disabled' }] }); await flush();
    const list = h.elements['automation-list']; expect(list.querySelector('[data-rule-id="rule_new"]')).not.toBeNull(); expect(list.querySelector('[data-rule-id="rule_old"]')).toBeNull();
    click(list, '[data-rule-action="reschedule"]'); await flush(); expect(h.elements['auto-reschedule-id'].value).toBe('rule_new');
  });
  it.each(['query', 'exec'])('old SQL %s cannot overwrite a newer table result', async mode => {
    const h = harness(['db']); const old = deferred(); h.api.agentDb[mode].mockReturnValueOnce(old.promise);
    h.elements['db-sql'].value = mode === 'query' ? 'SELECT old' : 'CREATE TABLE fixture (id TEXT)'; h.agentBrowser.dbRunSql(mode === 'exec' ? 'exec' : undefined);
    h.api.agentDb.tableData.mockResolvedValue({ rows: [{ v: 'current table' }], total: 1 }); h.agentBrowser.dbViewTable('current'); await flush();
    old.resolve(mode === 'query' ? { ok: true, rows: [{ v: 'stale SQL' }] } : { ok: true }); await flush();
    expect(h.elements['db-result'].textContent).toContain('current table');
    if (mode === 'exec') expect(h.api.agentDb.tables).toHaveBeenCalledTimes(1);
  });
  it.each(['reply', 'reject'])('late failed SQL write %s reports failure without replacing newer rows', async kind => {
    const h = harness(['db']); const old = deferred(); h.api.agentDb.exec.mockReturnValue(old.promise);
    h.elements['db-sql'].value = 'CREATE TABLE invalid fixture'; h.agentBrowser.dbRunSql('exec');
    h.api.agentDb.tableData.mockResolvedValue({ rows: [{ v: 'current table' }], total: 1 }); h.agentBrowser.dbViewTable('current'); await flush();
    if (kind === 'reply') old.resolve({ ok: false, error: 'write failed' }); else old.reject(new Error('write failed'));
    await flush(); expect(h.elements['db-result'].textContent).toContain('current table'); expect(h.agentBrowser.helpers.toast).toHaveBeenCalledWith('write failed', 'error');
  });
  it('two SQL reads ignore stale rejection but render the current rejection', async () => {
    const h = harness(['db']); const old = deferred(), current = deferred(); h.api.agentDb.query.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    h.elements['db-sql'].value = 'SELECT fixture'; h.agentBrowser.dbRunSql(); h.agentBrowser.dbRunSql();
    old.reject(new Error('old SQL error')); await flush(); expect(h.elements['db-result'].textContent).not.toContain('old SQL error');
    current.reject(new Error('current SQL error')); await flush(); expect(h.elements['db-result'].textContent).toContain('current SQL error');
  });
  it('a failed current Activity filter does not present prior-category rows as its result', async () => {
    const h = harness(['activity']); h.api.audit.list.mockResolvedValueOnce([{ category: 'profile', action: 'prior-category', at: 1 }]).mockRejectedValueOnce(new Error('current audit failure'));
    h.agentBrowser.loadActivity(); await flush(); h.elements['activity-filter'].value = 'automation'; h.agentBrowser.activityFilter(); await flush();
    expect(h.api.audit.list).toHaveBeenLastCalledWith({ category: 'automation', limit: 300 });
    expect(h.elements['activity-list'].textContent).not.toContain('prior-category'); expect(h.elements['activity-list'].textContent).toContain('current audit failure');
  });
  it('closing Run detail while a preview is pending invalidates it', async () => {
    const h = harness(['runs']); const old = deferred(); h.api.agentRuns.get.mockResolvedValue(run('run_A', { artifacts: [{ id: 'artifact_A', name: 'A', kind: 'dataset' }] })); h.api.agentRuns.resultsPreview.mockReturnValue(old.promise);
    await h.agentBrowser.runsOpen('run_A'); click(h.elements['agent-run-artifacts'], '[data-artifact-action="preview"]'); await flush();
    h.elements['dlg-agent-run'].close(); old.resolve(preview('closed stale rows')); await flush(); expect(h.elements['agent-run-preview'].textContent).not.toContain('closed stale rows');
  });
  it('overlapping live detail refreshes retain the latest verdict and never reopen a closed dialog', async () => {
    const h = harness(['runs']); h.api.agentRuns.get.mockResolvedValueOnce(run('run_A', { status: 'running' })); await h.agentBrowser.runsOpen('run_A');
    const old = deferred(), latest = deferred(); h.api.agentRuns.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    h.events['agent:run-step']({ runId: 'run_A' }); h.events['agent:run-finish']({ run: { id: 'run_A' } }); await flush();
    expect(h.api.agentRuns.get).toHaveBeenCalledTimes(3);
    latest.resolve(run('run_A', { verification: { status: 'passed' } })); await flush(); old.resolve(run('run_A', { status: 'running', verification: { status: 'unverified' } })); await flush();
    expect(h.elements['agent-run-verification-block'].querySelector('[data-verification="passed"]')).not.toBeNull();
    const closing = deferred(); h.api.agentRuns.get.mockReturnValueOnce(closing.promise); h.events['agent:run-step']({ runId: 'run_A' }); await flush(); h.elements['dlg-agent-run'].close(); closing.resolve(run('run_A')); await flush(); expect(h.elements['dlg-agent-run'].open).toBe(false);
  });
  it.each(['old-first', 'new-first'])('Job detail %s settlement keeps latest success/error ownership', async order => {
    for (const outcome of ['success', 'error', 'missing']) {
      const h = harness(['automation']); const a = deferred(), b = deferred();
      h.api.automation.jobGet.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
      h.agentBrowser.automationShowJob('job_A'); h.agentBrowser.automationShowJob('job_B');
      const finishOld = () => a.reject(new Error('stale A error'));
      const finishNew = () => outcome === 'error' ? b.reject(new Error('current B error')) : b.resolve(outcome === 'missing' ? null : { id: 'job_B', ruleName: 'same name', status: 'running', runId: 'run_B' });
      if (order === 'old-first') { finishOld(); await flush(); finishNew(); } else { finishNew(); await flush(); finishOld(); }
      await flush(); expect(h.agentBrowser.helpers.toast.mock.calls.flat().join(' ')).not.toContain('stale A error');
      if (outcome === 'success') {
        expect(h.elements['dlg-auto-job'].open).toBe(true); expect(h.elements['auto-job-detail'].textContent).toContain('job_B');
        expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="run_B"]')).not.toBeNull();
        expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="job_B"]')).not.toBeNull();
        expect(h.agentBrowser.helpers.toast).not.toHaveBeenCalled();
      } else {
        expect(h.elements['dlg-auto-job'].open).toBe(false);
        expect(h.agentBrowser.helpers.toast).toHaveBeenCalledTimes(1);
        if (outcome === 'error') expect(h.agentBrowser.helpers.toast).toHaveBeenCalledWith(expect.stringContaining('current B error'), 'error');
      }
    }
  });
  it.each(['close', 'cancel', 'Escape'].flatMap(method => ['success', 'error', 'missing'].map(outcome => [method, outcome])))('pending Job %s invalidates %s synchronously before queued close', async (method, outcome) => {
      const h = harness(['automation']); const pending = deferred(); const dlg = h.elements['dlg-auto-job']; dlg.deferCloseEvent = true;
      h.api.automation.jobGet.mockResolvedValueOnce({ id: 'job_A', ruleName: 'A', status: 'done', runId: 'run_A' }).mockReturnValueOnce(pending.promise);
      h.agentBrowser.automationShowJob('job_A'); await flush(); h.agentBrowser.automationShowJob('job_B');
      if (method === 'close') dlg.close(); else if (method === 'cancel') dlg.cancel(); else dlg.escape();
      if (outcome === 'error') pending.reject(new Error('dismissed B error')); else pending.resolve(outcome === 'missing' ? null : { id: 'job_B', ruleName: 'B', status: 'running', runId: 'run_B' });
      await flush(); // Critically, no close event has been delivered yet.
      expect(dlg.open).toBe(false); expect(h.elements['auto-job-title'].textContent).toContain('A');
      expect(h.elements['auto-job-detail'].textContent).not.toContain('job_B');
      expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="run_A"]')).not.toBeNull();
      expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="run_B"]')).toBeNull();
      expect(h.agentBrowser.helpers.toast).not.toHaveBeenCalled();
      dlg.deliverClose(); await flush(); expect(dlg.open).toBe(false);
  });
  it.each(['close', 'cancel', 'Escape'])('a %s then explicit reopen owns its reply despite old close/success/error in either order', async method => {
    for (const reopenedId of ['job_B', 'job_C']) for (const order of ['old-first', 'new-first']) for (const outcome of ['success', 'error']) {
      const h = harness(['automation']); const old = deferred(), current = deferred(); const dlg = h.elements['dlg-auto-job']; dlg.deferCloseEvent = true;
      h.api.automation.jobGet.mockResolvedValueOnce({ id: 'job_A', ruleName: 'same name', status: 'done' }).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      h.agentBrowser.automationShowJob('job_A'); await flush(); h.agentBrowser.automationShowJob('job_B');
      if (method === 'close') dlg.close(); else if (method === 'cancel') dlg.cancel(); else dlg.escape();
      h.agentBrowser.automationShowJob(reopenedId);
      // A delayed close from the prior session must not cancel this new intent,
      // even when its response is still pending (same-ID reopening included).
      dlg.deliverClose();
      const finishOld = () => outcome === 'error' ? old.reject(new Error('stale closed error')) : old.resolve({ id: 'job_B', ruleName: 'OLD', status: 'running', runId: 'old_run' });
      const finishNew = () => current.resolve({ id: reopenedId, ruleName: 'NEW', status: 'running', runId: 'new_run' });
      if (order === 'old-first') { finishOld(); await flush(); expect(dlg.open).toBe(false); finishNew(); }
      else { finishNew(); await flush(); finishOld(); }
      await flush(); expect(dlg.open).toBe(true); expect(h.elements['auto-job-title'].textContent).toContain('NEW');
      expect(h.elements['auto-job-detail'].textContent).toContain(reopenedId);
      expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="new_run"]')).not.toBeNull();
      expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="old_run"]')).toBeNull();
      expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="' + reopenedId + '"]')).not.toBeNull();
      expect(h.api.automation.jobGet.mock.calls).toEqual([['job_A'], ['job_B'], [reopenedId]]); expect(h.agentBrowser.helpers.toast).not.toHaveBeenCalled();
      dlg.deliverClose(); // Also harmless after the current dialog opened.
      expect(dlg.open).toBe(true);
    }
  });
  it.each(['old-first', 'new-first'])('a failed reopened Job request owns its error with %s settlement, never revived by dismissed success', async order => {
    for (const reopenedId of ['job_B', 'job_C']) {
      const h = harness(['automation']); const old = deferred(), current = deferred(); const dlg = h.elements['dlg-auto-job']; dlg.deferCloseEvent = true;
      h.api.automation.jobGet.mockResolvedValueOnce({ id: 'job_A', ruleName: 'A', status: 'done', runId: 'run_A' }).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      h.agentBrowser.automationShowJob('job_A'); await flush(); h.agentBrowser.automationShowJob('job_B'); dlg.close(); h.agentBrowser.automationShowJob(reopenedId); dlg.deliverClose();
      const finishOld = () => old.resolve({ id: 'job_B', ruleName: 'STALE', status: 'running', runId: 'stale_run' });
      const finishNew = () => current.reject(new Error('reopened current error'));
      if (order === 'old-first') { finishOld(); await flush(); finishNew(); } else { finishNew(); await flush(); finishOld(); }
      await flush(); expect(dlg.open).toBe(false); expect(h.elements['auto-job-title'].textContent).toContain('A');
      expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="stale_run"]')).toBeNull();
      expect(h.agentBrowser.helpers.toast.mock.calls).toEqual([[expect.stringContaining('reopened current error'), 'error']]);
    }
  });
  it('Escape invalidates pending intent at keydown, without waiting for native cancel', async () => {
    const h = harness(['automation']); const pending = deferred(); const dlg = h.elements['dlg-auto-job']; dlg.deferCloseEvent = true;
    h.api.automation.jobGet.mockResolvedValueOnce({ id: 'job_A', ruleName: 'A', status: 'done' }).mockReturnValueOnce(pending.promise);
    h.agentBrowser.automationShowJob('job_A'); await flush(); h.agentBrowser.automationShowJob('job_B');
    dlg.fire('keydown', { key: 'Escape' }); pending.resolve({ id: 'job_B', ruleName: 'B', status: 'done' }); await flush();
    expect(h.elements['auto-job-title'].textContent).toContain('A'); expect(h.agentBrowser.helpers.toast).not.toHaveBeenCalled();
  });
  it('ordinary keyboard input does not cancel a pending Job detail request', async () => {
    const h = harness(['automation']); const pending = deferred(); h.api.automation.jobGet.mockReturnValue(pending.promise);
    h.agentBrowser.automationShowJob('job_A'); h.elements['dlg-auto-job'].fire('keydown', { key: 'Enter' });
    pending.resolve({ id: 'job_A', ruleName: 'positive input', status: 'done', runId: 'run_A' }); await flush();
    expect(h.elements['dlg-auto-job'].open).toBe(true); expect(h.elements['auto-job-title'].textContent).toContain('positive input');
    expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="run_A"]')).not.toBeNull();
  });
  it('Job A arriving after Job B cannot replace B details or action IDs', async () => {
    const h = harness(['automation']); const old = deferred(); h.api.automation.jobGet.mockReturnValueOnce(old.promise).mockResolvedValue({ id: 'job_B', ruleName: 'B', status: 'done', runId: 'run_B' });
    h.agentBrowser.automationShowJob('job_A'); h.agentBrowser.automationShowJob('job_B'); await flush(); old.resolve({ id: 'job_A', ruleName: 'A', status: 'running', runId: 'run_A' }); await flush();
    expect(h.elements['auto-job-title'].textContent).toContain('B'); expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="run_B"]')).not.toBeNull(); expect(h.elements['auto-job-actions'].querySelector('[data-cmd-arg="run_A"]')).toBeNull();
  });
});

describe('UI goal DB — real synthetic SQLite, not a mock persistence claim', () => {
  afterAll(() => {
    closeAgentDb();
    if (!process.env.UI_GOAL_JOBS_STORAGE) fs.rmSync(storeDir, { recursive: true, force: true });
  });
  it('renderer exec writes bytes, direct SQL validates rows, reopening lists and searches by ID', async () => {
    fs.mkdirSync(storeDir, { recursive: true }); closeAgentDb();
    const file = path.join(storeDir, 'agent-store.sqlite'); expect(fs.existsSync(file)).toBe(false);
    const h = harness(['db']);
    h.api.agentDb.exec.mockImplementation(async (sql: string) => agentDbExecScript(sql));
    h.api.agentDb.tables.mockImplementation(async () => agentDbTables());
    h.api.agentDb.query.mockImplementation(async (sql: string) => ({ ok: true, ...agentDbQuery(sql) }));
    h.api.agentDb.tableData.mockImplementation(async (table: string) => agentDbTableData(table));
    h.agentBrowser.loadDbTab(); await flush();
    h.elements['db-sql'].value = "CREATE TABLE goal_fixture (id TEXT PRIMARY KEY, value TEXT); INSERT INTO goal_fixture VALUES ('fixture_ID', 'retained value')";
    h.agentBrowser.dbRunSql('exec'); await flush(); closeAgentDb();
    expect(fs.statSync(file).size).toBeGreaterThan(0);
    const direct = new DatabaseSync(file, { readOnly: true });
    try { expect(direct.prepare('SELECT id,value FROM goal_fixture').all().map(r => ({ ...r }))).toEqual([{ id: 'fixture_ID', value: 'retained value' }]); } finally { direct.close(); }
    h.agentBrowser.loadDbTab(); await flush(); expect(h.elements['db-tables'].querySelector('[data-table="goal_fixture"]')).not.toBeNull();
    h.elements['db-sql'].value = "SELECT id,value FROM goal_fixture WHERE id = 'fixture_ID'";
    h.elements['db-sql'].fire('keydown', { key: 'Enter', ctrlKey: true, preventDefault: vi.fn() }); await flush();
    expect(h.elements['db-result'].textContent).toContain('fixture_ID'); expect(h.elements['db-result'].textContent).toContain('retained value');
    click(h.elements['db-tables'], '[data-table="goal_fixture"]'); await flush(); expect(h.elements['db-result'].textContent).toContain('fixture_ID');
  });
});
