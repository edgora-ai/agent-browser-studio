// SERIAL COORDINATOR ONLY. Prepared, NOT-RUN by the Jobs/data worker.
// No browsers, clipboard, keychain, notification settings or external provider.
// Real-store cases inspect synthetic SQLite/config bytes and restart the app.
// The final native-DOM case explicitly labels its controlled API data fixture.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setupTestApp, closeApp, type TestAppHandle } from './helpers/app.js';

const ROOT = path.resolve(__dirname, '../..');
const RUNS_SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/js/app/runs.js'), 'utf8');
const DATA_SOURCES = ['automation', 'db', 'activity'].map(name => fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${name}.js`), 'utf8'));
const DELEGATION_SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/js/app/delegation.js'), 'utf8');
// A guard, not authorization: the coordinator must also enforce GUI serialization.
const serial = process.env.UI_GOAL_JOBS_NATIVE_SERIAL === '1';

describe.skipIf(!serial)('UI goal Jobs/data — serial native acceptance', () => {
  let h: TestAppHandle;
  let data: string;
  let emptyBrowserCache: string;
  async function launch(resetUserData: boolean) {
    h = await setupTestApp({
      userDataDir: data, resetUserData,
      env: { AGENT_BROWSER_API_PORT: '0', AGENT_BROWSER_CHROMIUM_CACHE_DIR: emptyBrowserCache },
    });
    const isolation = await h.app.evaluate(({ app }) => ({
      home: process.getBuiltinModule('os').homedir(), userData: app.getPath('userData'),
      providerKeys: Object.keys(process.env).filter(k => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(k)),
    }));
    expect(fs.realpathSync(isolation.home)).toBe(fs.realpathSync(path.join(data, 'test-home')));
    expect(fs.realpathSync(isolation.userData)).toBe(fs.realpathSync(data)); expect(isolation.providerKeys).toEqual([]);
  }
  beforeAll(async () => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-goal-jobs-native-'));
    emptyBrowserCache = path.join(data, 'empty-browser-cache'); fs.mkdirSync(emptyBrowserCache);
    // reset=false because setupTestApp must not remove the explicit empty cache.
    await launch(false);
  }, 120_000);
  afterAll(async () => { if (h) await closeApp(h); }, 120_000);

  // Actual browser dialogs, physical controls and whole production modules,
  // with explicitly controlled transport. Not backend retry/persistence proof.
  async function prepareBoundedFixture() {
    await h.page.evaluate(async (sources: string[]) => {
      document.getElementById('jobs-bounded-native')?.remove();
      const frame = document.createElement('iframe'); frame.id = 'jobs-bounded-native';
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:10000;background:white'; document.body.appendChild(frame);
      const w = frame.contentWindow! as any; const d = w.document;
      d.body.innerHTML = ['tab-runs', 'dlg-agent-run', 'dlg-auto-job'].map(id => document.getElementById(id)!.outerHTML).join('');
      d.querySelector('.run-filters')!.removeAttribute('data-bound');
      const fixture: any = { pending: [], gets: [], toasts: [], retryJobs: [], retryRuns: [], confirmed: null };
      w.jobsBoundedFixture = fixture;
      const run = (id: string, status: string, verification: string) => ({ id, name: id, status, verification: { status: verification }, dirId: 'fixture_profile', stepCount: 0, steps: [], variables: {}, artifacts: [], source: { type: 'automation', jobId: 'fixture_job', ruleId: 'fixture_rule' } });
      const textEsc = (v: any) => { const el = d.createElement('span'); el.textContent = String(v ?? ''); return el.innerHTML; };
      w.agentBrowser = {
        state: { currentTab: 'runs' }, ipc: { call: (_key: string, fn: any) => fn() },
        helpers: { toast: (...args: any[]) => fixture.toasts.push(args), esc: textEsc, escAttr: (v: any) => textEsc(v).replace(/"/g, '&quot;'), icon: () => '', fmtDuration: String },
        confirm: (_message: string, accept: any) => { fixture.confirmed = accept; },
        api: { on: () => {},
          agentRuns: { list: async () => [run('passed', 'done', 'passed'), run('visible_error', 'error', 'passed'), run('hidden_error', 'error', 'failed')] },
          automation: {
            jobGet: (id: string) => { fixture.gets.push(id); return new Promise((resolve, reject) => fixture.pending.push({ id, resolve, reject })); },
            retryJob: async (id: string) => { fixture.retryJobs.push(id); return { attempted: 2, succeeded: 2, failed: [] }; },
            retryRun: async (id: string) => { fixture.retryRuns.push(id); return { ok: true, runId: 'fixture_rerun' }; },
          },
        },
      };
      sources.forEach(source => w.eval(source));
      for (let i = 0; i < 40; i++) await Promise.resolve();
    }, [RUNS_SOURCE, DATA_SOURCES[0], DELEGATION_SOURCE]);
    return h.page.frameLocator('#jobs-bounded-native');
  }
  async function finishJob(index: number, id: string, outcome = 'success', name = id) {
    await h.page.locator('#jobs-bounded-native').evaluate(async (frame, args) => {
      const w = (frame as HTMLIFrameElement).contentWindow! as any;
      const pending = w.jobsBoundedFixture.pending[args.index];
      if (args.outcome === 'error') pending.reject(new Error('controlled ' + args.name));
      else pending.resolve({ id: args.id, ruleName: args.name, status: 'running', runId: 'run_' + args.id });
      for (let i = 0; i < 40; i++) await Promise.resolve();
    }, { index, id, outcome, name });
  }
  async function requestJob(id: string) {
    await h.page.locator('#jobs-bounded-native').evaluate((frame, jobId) => ((frame as HTMLIFrameElement).contentWindow as any).agentBrowser.automationShowJob(jobId), id);
  }
  async function cleanupBoundedFixture() { await h.page.evaluate(() => document.getElementById('jobs-bounded-native')?.remove()); }

  it.each(['header-close', 'close', 'requestClose', 'Escape'].flatMap(method => ['success', 'error'].map(outcome => [method, outcome])))('prepared NOT-RUN: actual %s dismisses pending Job %s without late reopening or toast', async (method, outcome) => {
    const frame = await prepareBoundedFixture();
    try {
      await requestJob('job_A'); await finishJob(0, 'job_A'); await requestJob('job_B');
      if (method === 'header-close') await frame.locator('[data-cmd="close-dialog"][data-cmd-target="dlg-auto-job"]').click();
      else if (method === 'Escape') await frame.locator('#dlg-auto-job').press('Escape');
      else await frame.locator('#dlg-auto-job').evaluate((dialog, action) => { const dlg = dialog as HTMLDialogElement; if (action === 'close') dlg.close(); else dlg.requestClose(); }, method);
      await finishJob(1, 'job_B', outcome, 'dismissed B');
      expect(await frame.locator('#dlg-auto-job').evaluate(d => (d as HTMLDialogElement).open)).toBe(false);
      expect(await frame.locator('#auto-job-detail').textContent()).toContain('job_A');
      expect(await frame.locator('#auto-job-detail').textContent()).not.toContain('job_B');
      expect(await frame.locator('#auto-job-actions [data-cmd-arg="run_job_A"]').count()).toBe(1);
      const toasts = await h.page.locator('#jobs-bounded-native').evaluate(f => ((f as HTMLIFrameElement).contentWindow as any).jobsBoundedFixture.toasts);
      expect(toasts).toEqual([]);
    } finally { await cleanupBoundedFixture(); }
  }, 60_000);

  it.each(['old-first', 'new-first'])('prepared NOT-RUN: real close/reopen retains new same/different Job identity with %s replies', async order => {
    for (const reopenedId of ['job_B', 'job_C']) for (const outcome of ['success', 'error']) {
      const frame = await prepareBoundedFixture();
      try {
        await requestJob('job_A'); await finishJob(0, 'job_A');
        // Within one browser task: queue the native close event, mint a new
        // request, and only then allow delivery of the previous close task.
        await frame.locator('#dlg-auto-job').evaluate((dialog, id) => {
          const w = dialog.ownerDocument.defaultView as any;
          w.agentBrowser.automationShowJob('job_B'); (dialog as HTMLDialogElement).close(); w.agentBrowser.automationShowJob(id);
        }, reopenedId);
        if (order === 'old-first') { await finishJob(1, 'job_B', outcome, 'OLD'); await finishJob(2, reopenedId, 'success', 'NEW'); }
        else { await finishJob(2, reopenedId, 'success', 'NEW'); await finishJob(1, 'job_B', outcome, 'OLD'); }
        expect(await frame.locator('#dlg-auto-job').evaluate(d => (d as HTMLDialogElement).open)).toBe(true);
        expect(await frame.locator('#auto-job-title').textContent()).toContain('NEW');
        expect(await frame.locator('#auto-job-detail').textContent()).toContain(reopenedId);
        expect(await frame.locator(`#auto-job-actions [data-cmd-arg="run_${reopenedId}"]`).count()).toBe(1);
        expect(await frame.locator(`#auto-job-actions [data-cmd-arg="${reopenedId}"]`).count()).toBe(1);
        expect(await h.page.locator('#jobs-bounded-native').evaluate(f => ((f as HTMLIFrameElement).contentWindow as any).jobsBoundedFixture.toasts)).toEqual([]);
      } finally { await cleanupBoundedFixture(); }
    }
  }, 60_000);

  it.each(['old-first', 'new-first'])('prepared NOT-RUN: reopened current rejection wins over dismissed success with %s settlement', async order => {
    const frame = await prepareBoundedFixture();
    try {
      await requestJob('job_A'); await finishJob(0, 'job_A');
      await frame.locator('#dlg-auto-job').evaluate(dialog => {
        const w = dialog.ownerDocument.defaultView as any;
        w.agentBrowser.automationShowJob('job_B'); (dialog as HTMLDialogElement).close(); w.agentBrowser.automationShowJob('job_B');
      });
      if (order === 'old-first') { await finishJob(1, 'job_B', 'success', 'STALE'); await finishJob(2, 'job_B', 'error', 'CURRENT'); }
      else { await finishJob(2, 'job_B', 'error', 'CURRENT'); await finishJob(1, 'job_B', 'success', 'STALE'); }
      expect(await frame.locator('#dlg-auto-job').evaluate(d => (d as HTMLDialogElement).open)).toBe(false);
      expect(await frame.locator('#auto-job-detail').textContent()).toContain('job_A');
      const toasts = await h.page.locator('#jobs-bounded-native').evaluate(f => ((f as HTMLIFrameElement).contentWindow as any).jobsBoundedFixture.toasts);
      expect(toasts).toHaveLength(1); expect(toasts[0][0]).toContain('controlled CURRENT'); expect(toasts[0][1]).toBe('error');
    } finally { await cleanupBoundedFixture(); }
  }, 60_000);

  it('prepared NOT-RUN: physical Passed/name filters keep no-count full-job retry distinct from successful single rerun', async () => {
    const frame = await prepareBoundedFixture();
    try {
      await h.page.locator('#jobs-bounded-native').evaluate(f => ((f as HTMLIFrameElement).contentWindow as any).agentBrowser.loadRunsTab());
      await frame.locator('[data-run-id="passed"]').waitFor();
      await frame.locator('#run-filter-verification').selectOption('passed');
      await frame.locator('#run-filter-name').fill('no-match');
      expect(await frame.locator('[data-group-action]').count()).toBe(0);
      await frame.locator('#run-filter-name').fill(''); // Positive recovery through actual user input.
      expect(await frame.locator('[data-run-id="hidden_error"]').count()).toBe(0);
      const retryAll = frame.locator('[data-group-action="retry-failed"]'); expect(await retryAll.textContent()).toBe('重试全部失败');
      await frame.locator('[data-run-id="passed"] [data-run-action="retry"]').click();
      await h.page.locator('#jobs-bounded-native').evaluate(f => ((f as HTMLIFrameElement).contentWindow as any).jobsBoundedFixture.confirmed());
      await retryAll.click();
      await h.page.locator('#jobs-bounded-native').evaluate(f => ((f as HTMLIFrameElement).contentWindow as any).jobsBoundedFixture.confirmed());
      const calls = await h.page.locator('#jobs-bounded-native').evaluate(f => {
        const fixture = ((f as HTMLIFrameElement).contentWindow as any).jobsBoundedFixture;
        return { jobs: fixture.retryJobs, runs: fixture.retryRuns, toasts: fixture.toasts };
      });
      expect(calls.jobs).toEqual(['fixture_job']); expect(calls.runs).toEqual(['passed']);
      expect(calls.toasts.some((args: any[]) => String(args[0]).includes('(2/2)') && args[1] === 'success')).toBe(true);
      await frame.locator('#run-filter-verification').selectOption('all');
      expect(await frame.locator('[data-run-id="hidden_error"]').count()).toBe(1);
    } finally { await cleanupBoundedFixture(); }
  }, 60_000);

  it('empty first DB honors the real keyboard shortcut and persists synthetic SQL across restart', async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab('db'));
    await h.page.waitForFunction(() => (document.getElementById('db-tables')?.textContent || '').length > 0);
    const initial = await h.page.evaluate(() => (window as any).agentBrowser.api.agentDb.tables()); expect(initial).toEqual([]);
    await h.page.locator('#db-sql').fill('SELECT 7 AS shortcut_fixture');
    await h.page.locator('#db-sql').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await h.page.waitForFunction(() => document.getElementById('db-result')?.textContent?.includes('shortcut_fixture'));
    await h.page.locator('#db-sql').fill("CREATE TABLE goal_native_fixture (id TEXT PRIMARY KEY, value TEXT); INSERT INTO goal_native_fixture VALUES ('native_ID','retained')");
    await h.page.evaluate(() => (window as any).agentBrowser.dbRunSql('exec'));
    await h.page.waitForFunction(() => !!document.querySelector('[data-table="goal_native_fixture"]'));
    const file = path.join(data, 'agent-store.sqlite'); expect(fs.statSync(file).size).toBeGreaterThan(0);
    const db = new DatabaseSync(file, { readOnly: true });
    try { expect(db.prepare('SELECT id,value FROM goal_native_fixture').all().map(r => ({ ...r }))).toEqual([{ id: 'native_ID', value: 'retained' }]); } finally { db.close(); }
    await closeApp(h); await launch(false);
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab('db'));
    await h.page.locator('[data-table="goal_native_fixture"]').click();
    await h.page.waitForFunction(() => document.getElementById('db-result')?.textContent?.includes('native_ID'));
    await h.page.locator('#db-sql').fill("SELECT id,value FROM goal_native_fixture WHERE id='native_ID'");
    await h.page.locator('#db-sql').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await h.page.waitForFunction(() => document.getElementById('db-result')?.textContent?.includes('retained'));
  }, 120_000);

  it('real missed-once rule has exactly one Disable and reschedule writes a new plan that reloads', async () => {
    const created = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.create({
      name: 'goal native inert once', enabled: true,
      trigger: { type: 'once', at: Date.now() - 86_400_000 },
      action: { type: 'custom-js', jsCode: 'throw new Error("fixture must never auto-run")' },
    }));
    expect(created.success).toBe(true); const id = created.rule.id;
    const configFile = path.join(data, 'config.json');
    const storedBefore = JSON.parse(fs.readFileSync(configFile, 'utf8')).automation.find((r: any) => r.id === id);
    expect(storedBefore.name).toBe('goal native inert once'); expect(storedBefore.trigger.type).toBe('once');
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab('automation'));
    const card = h.page.locator(`[data-rule-id="${id}"]`);
    await card.locator('[data-rule-action="reschedule"]').waitFor(); expect(await card.locator('[data-rule-action="toggle"]').count()).toBe(1);
    await card.locator('[data-rule-action="reschedule"]').click();
    const at = Date.now() + 3_600_000;
    const local = (ms: number) => { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
    await h.page.locator('#auto-reschedule-at').fill(local(at));
    await h.page.locator('#dlg-auto-reschedule button[type="submit"]').click();
    await h.page.waitForFunction(() => !(document.getElementById('dlg-auto-reschedule') as HTMLDialogElement).open);
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')).automation.find((r: any) => r.id === id);
    expect(stored.planId).not.toBe(storedBefore.planId); expect(stored.trigger.at).toBeGreaterThan(Date.now());
    await closeApp(h); await launch(false);
    const list = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.list());
    expect(list.find((r: any) => r.id === id)).toMatchObject({ name: stored.name, planId: stored.planId, trigger: stored.trigger });
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab('automation'));
    await h.page.locator(`[data-rule-id="${id}"]`).waitFor();
    const state = await h.page.evaluate(async (ruleId: string) => (await (window as any).agentBrowser.api.automation.scheduleState()).states.find((s: any) => s.ruleId === ruleId), id);
    expect(state.phase).toBe('scheduled-once');
  }, 120_000);

  it('controlled native-DOM fixtures retain latest Jobs/Activity/DB replies and hide machine inputs', async () => {
    const result = await h.page.evaluate(async (sources: string[]) => {
      const frame = document.createElement('iframe'); document.body.appendChild(frame);
      try {
        const w = frame.contentWindow! as any; const d = w.document;
        const ids = ['tab-automation', 'tab-db', 'tab-activity', 'dlg-automation', 'dlg-auto-job', 'dlg-auto-log', 'dlg-auto-reschedule'];
        d.body.innerHTML = ids.map(id => document.getElementById(id)!.outerHTML).join('');
        const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
        const deferred = () => { let resolve!: (x: any) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
        const oldJobs = deferred(), oldAudit = deferred(), oldTable = deferred(), lateState = deferred();
        let jobsCalls = 0, auditCalls = 0, tableCalls = 0;
        const textEsc = (v: any) => { const el = d.createElement('span'); el.textContent = String(v ?? ''); return el.innerHTML; };
        const rule = { id: 'rule_fixture', name: 'controlled rule', enabled: true, trigger: { type: 'once', at: 1 }, action: { type: 'agent-task', templateId: 'machine_fixture' } };
        w.agentBrowser = {
          state: { currentTab: 'automation' }, ipc: { call: (_key: string, fn: any) => fn() },
          helpers: { toast: () => {}, esc: textEsc, escAttr: (v: any) => textEsc(v).replace(/"/g, '&quot;'), icon: () => '' },
          api: {
            on: () => {}, browser: { list: async () => [] },
            agent: { taskTemplates: async () => [{ id: 'machine_fixture', title: 'controlled template', machine: {}, requiredInputs: [{ key: 'url', required: true }] }] },
            automation: {
              list: async () => [rule], scheduleState: () => lateState.promise, logs: async () => [],
              jobs: () => ++jobsCalls === 1 ? oldJobs.promise : Promise.resolve([{ id: 'job_latest', ruleName: 'latest job', status: 'done' }]),
            },
            audit: { list: () => ++auditCalls === 1 ? oldAudit.promise : Promise.resolve([{ category: 'profile', action: 'latest audit', at: 1 }]) },
            agentDb: { tableData: () => ++tableCalls === 1 ? oldTable.promise : Promise.resolve({ rows: [{ v: 'latest table' }], total: 1 }) },
          },
        };
        sources.forEach(s => w.eval(s));
        w.agentBrowser.loadAutomationTab(); await flush(); lateState.resolve({ success: true, states: [{ ruleId: 'rule_fixture', phase: 'missed-once' }] }); await flush();
        const reschedule = !!d.querySelector('[data-rule-action="reschedule"]');
        w.agentBrowser.automationRefreshJobs(); await flush(); oldJobs.resolve([{ id: 'job_stale', ruleName: 'stale job', status: 'done' }]); await flush();
        w.agentBrowser.loadActivity(); w.agentBrowser.loadActivity(); await flush(); oldAudit.resolve([{ category: 'profile', action: 'stale audit', at: 1 }]); await flush();
        w.agentBrowser.dbViewTable('old'); w.agentBrowser.dbViewTable('latest'); await flush(); oldTable.resolve({ rows: [{ v: 'stale table' }], total: 1 }); await flush();
        w.agentBrowser.automationEdit(rule); await flush();
        const action = d.getElementById('auto-action-type') as HTMLSelectElement; action.value = 'custom-js'; action.dispatchEvent(new w.Event('change'));
        return { reschedule, jobs: d.getElementById('automation-jobs')!.textContent, audit: d.getElementById('activity-list')!.textContent, table: d.getElementById('db-result')!.textContent, hidden: d.getElementById('auto-template-inputs-row')!.style.display === 'none' };
      } finally { frame.remove(); }
    }, DATA_SOURCES);
    expect(result.reschedule).toBe(true); expect(result.hidden).toBe(true);
    expect(result.jobs).toContain('latest job'); expect(result.jobs).not.toContain('stale job');
    expect(result.audit).toContain('latest audit'); expect(result.audit).not.toContain('stale audit');
    expect(result.table).toContain('latest table'); expect(result.table).not.toContain('stale table');
  }, 60_000);

  it('controlled API fixture in native DOM recovers first no-match actions and rejects late A preview', async () => {
    // An inert iframe uses the actual product markup and whole Runs module.
    // This is native-DOM proof, not real Run storage or backend execution proof.
    const result = await h.page.evaluate(async (source: string) => {
      const frame = document.createElement('iframe'); document.body.appendChild(frame);
      try {
        const w = frame.contentWindow! as any; const d = w.document;
        d.body.innerHTML = document.getElementById('tab-runs')!.outerHTML + document.getElementById('dlg-agent-run')!.outerHTML;
        // Cloned markup must not inherit the host module's already-bound flag.
        d.querySelector('.run-filters')!.removeAttribute('data-bound');
        const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
        let release!: (v: any) => void; const late = new Promise(r => { release = r; }); const gets: string[] = [];
        const run = (id: string) => ({ id, name: id, status: 'done', stepCount: 0, steps: [], variables: {}, artifacts: id === 'run_fixture_A' ? [{ id: 'artifact_fixture_A', name: 'controlled fixture', kind: 'dataset' }] : [] });
        const textEsc = (v: any) => { const el = d.createElement('span'); el.textContent = String(v ?? ''); return el.innerHTML; };
        w.agentBrowser = {
          api: { agentRuns: { list: async () => [run('run_fixture_A')], get: async (id: string) => { gets.push(id); return run(id); }, resultsPreview: () => late }, on: () => {} },
          state: { currentTab: 'runs' }, ipc: { call: (_key: string, fn: any) => fn() },
          helpers: { toast: () => {}, esc: textEsc, escAttr: (v: any) => textEsc(v).replace(/"/g, '&quot;'), icon: () => '', fmtDuration: String },
        };
        w.eval(source);
        const name = d.getElementById('run-filter-name') as HTMLInputElement; name.value = 'no-match';
        w.agentBrowser.loadRunsTab(); await flush(); name.value = ''; name.dispatchEvent(new w.Event('input', { bubbles: true }));
        (d.querySelector('[data-run-action="open"]') as HTMLButtonElement).click(); await flush();
        (d.querySelector('[data-artifact-action="preview"]') as HTMLButtonElement).click(); await flush();
        await w.agentBrowser.runsOpen('run_fixture_B');
        release({ ok: true, columns: ['fixture'], rows: [['stale A']], total: 101 }); await flush();
        return { gets, title: d.getElementById('agent-run-title')!.textContent, preview: d.getElementById('agent-run-preview')!.textContent };
      } finally { frame.remove(); }
    }, RUNS_SOURCE);
    expect(result.gets).toEqual(['run_fixture_A', 'run_fixture_B']); expect(result.title).toBe('run_fixture_B'); expect(result.preview).toBe('');
  }, 60_000);
});
