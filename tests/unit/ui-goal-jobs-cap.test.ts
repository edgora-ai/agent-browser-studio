// Node-only acceptance: entire renderer modules, shipped preload/IPC expressions,
// production stores in fresh processes, and a parsed DOM. No native paint claims.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const source = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LOCALES = ['en-US', 'zh-CN'] as const;
type Locale = typeof LOCALES[number];
const COPY = {
  'en-US': 'Showing {shown} jobs; this list loads up to {limit} newest jobs matching the selected status. Older jobs may not appear.',
  'zh-CN': '显示 {shown} 个任务；此列表最多加载符合所选状态的最新 {limit} 个任务。较早的任务可能不会显示。',
};
const CONFLICT = { 'en-US': 'Account changed — reselect it from the refreshed list and confirm again', 'zh-CN': '账号已变更，请从刷新后的列表重新选择并再次确认' };
const caption = (locale: Locale, shown: number, limit = 50) => COPY[locale].replace('{shown}', String(shown)).replace('{limit}', String(limit));
const hash = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let fixture: string;
let oldestId: string;
let newestId: string;
let storedHashes: Record<string, string>;
const STORE_FILES = ['jobs.sqlite', 'agent-store.sqlite', 'audit.log.jsonl'];

// Services are transpiled unchanged. The only substituted dependency is the
// private userData path; real SQLite/JSONL operations and redaction remain intact.
const workerSource = `
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const data=path.join(__dirname,'data');
const jobs=require('./job-store.cjs'),db=require('./agent-db.cjs'),audit=require('./audit-log.cjs');
const handlers={};
const ipcMain={handle(ch,fn){assert.ok(!handlers[ch]);handlers[ch]=fn}};
const {listJobs,getJob}=jobs;const {agentDbTables,agentDbTableData,agentDbQuery}=db;const {listAudit}=audit;
eval(fs.readFileSync(path.join(__dirname,'handlers.cjs'),'utf8'));
(async()=>{
 const request=JSON.parse(process.argv[2]);let out;
 if(request.seed){
  console.error("jobs-cap-seed:ready");
  const ids=[];for(let i=0;i<201;i++){
   // A deterministic clock gives an observable newest/oldest ordering.
   Date.now=()=>1700000000000+i;
   const job=jobs.enqueueJob({ruleId:'fixture_rule',ruleName:'Cancelled fixture '+i,source:'test'});
   assert.equal(jobs.markCancelled(job.id),true);ids.push(job.id);
   audit.recordAudit({category:i===0?'profile':'automation',action:'create',target:'fixture_target_'+i,detail:'fixture detail '+i,actor:'user'});
   if((i+1)%25===0||i===200)console.error('jobs-cap-seed:'+(i+1));
  }
  assert.deepEqual(db.agentDbExecScript('CREATE TABLE fixture_rows (id INTEGER PRIMARY KEY, title TEXT);'+Array.from({length:101},(_,i)=>'INSERT INTO fixture_rows VALUES ('+(i+1)+',\\'fixture title '+(i+1)+'\\');').join('')),{ok:true});
  out={oldestId:ids[0],newestId:ids[200]};
 }else {assert.ok(handlers[request.channel],request.channel);out=await handlers[request.channel]({},...request.args);}
 jobs.closeJobDb();db.closeAgentDb();console.log(JSON.stringify(out));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
`;
function worker(request: unknown): any {
  const result = spawnSync(process.execPath, [path.join(fixture, 'worker.cjs'), JSON.stringify(request)], {
    cwd: fixture, encoding: 'utf8', timeout: 3_000,
    env: workerEnvironment(),
  });
  assert.ifError(result.error); assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function workerEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: path.join(fixture, 'home'), TMPDIR: path.join(fixture, 'tmp'), TMP: path.join(fixture, 'tmp'), TEMP: path.join(fixture, 'tmp'),
      XDG_CONFIG_HOME: path.join(fixture, 'xdg'), XDG_DATA_HOME: path.join(fixture, 'xdg'), XDG_STATE_HOME: path.join(fixture, 'xdg'), XDG_CACHE_HOME: path.join(fixture, 'cache'),
      M1_DATA_DIR: path.join(fixture, 'm1'), M1_HOME: path.join(fixture, 'm1'), npm_config_cache: path.join(fixture, 'cache'), CI: '1', TZ: 'UTC' };
}

const compiledSources = new Map<string, string>();
function transpileOnce(code: string, compilerOptions: ts.CompilerOptions): string {
  const key = createHash('sha256').update(code).update(JSON.stringify(compilerOptions)).digest('hex');
  let output = compiledSources.get(key);
  if (output === undefined) {
    output = ts.transpileModule(code, { compilerOptions }).outputText;
    compiledSources.set(key, output);
  }
  return output;
}
const SEED_DEADLINE_MS = 20_000;
const SEED_IDLE_MS = 8_000;
function seedWorker(): Promise<{ oldestId: string; newestId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixture, 'worker.cjs'), JSON.stringify({ seed: true })], {
      cwd: fixture, env: workerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', lastProgress = 'starting', pending = '', settled = false;
    let idle: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => fail('20s total deadline'), SEED_DEADLINE_MS);
    function clearTimers() { clearTimeout(deadline); clearTimeout(idle); }
    function fail(reason: string) {
      if (settled) return;
      settled = true; clearTimers(); child.kill();
      reject(new Error('Jobs cap seed failed (' + reason + '), progress=' + lastProgress + '\n' + stderr));
    }
    function resetIdle() { clearTimeout(idle); idle = setTimeout(() => fail('8s without seed progress'), SEED_IDLE_MS); }
    resetIdle();
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16_384) fail('unexpected stdout size'); });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-16_384); pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop()!;
      for (const line of lines) if (/^jobs-cap-seed:(ready|[0-9]+)$/.test(line)) {
        lastProgress = line; resetIdle(); console.info('[jobs-cap setup] ' + line);
      }
    });
    child.on('error', error => fail(error.message));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimers();
      if (code !== 0 || signal) { reject(new Error('Jobs cap seed exit=' + code + ', signal=' + signal + ', progress=' + lastProgress + '\n' + stderr)); return; }
      try { assert.equal(lastProgress, 'jobs-cap-seed:201'); resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
  });
}
let fixtureSetup: Promise<void> | undefined;
function setupFixture(): Promise<void> {
  // All callers share the same compile/seed; no test case reseeds the stores.
  return fixtureSetup ??= (async () => {
  const parent = process.env.UI_GOAL_JOBS_STORAGE || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true }); fixture = fs.mkdtempSync(path.join(parent, 'jobs-cap-'));
  for (const dir of ['data', 'home', 'tmp', 'xdg', 'cache', 'm1']) fs.mkdirSync(path.join(fixture, dir));
  const compileStarted = Date.now();
  for (const name of ['job-store', 'agent-db', 'audit-log', 'observability']) {
    const code = transpileOnce(source(`src/main/services/${name}.ts`), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
    fs.writeFileSync(path.join(fixture, name + '.cjs'), code.replace(/require\("\.\/([\w-]+)\.js"\)/g, 'require("./$1.cjs")'));
  }
  fs.writeFileSync(path.join(fixture, 'config-manager.cjs'), 'exports.getAppDataDir=()=>require("node:path").join(__dirname,"data");');
  const wanted = new Set(['automation:jobs', 'automation:job-get', 'agent-db:tables', 'agent-db:table-data', 'agent-db:query', 'audit:list']);
  const registrations: string[] = [];
  for (const name of ['automation', 'agent', 'audit']) {
    const file = ts.createSourceFile(name + '.ts', source(`src/main/ipc/${name}.ts`), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'ipcMain.handle' && ts.isStringLiteral(node.arguments[0]) && wanted.has(node.arguments[0].text)) registrations.push(node.getText(file));
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  assert.equal(registrations.length, wanted.size);
  fs.writeFileSync(path.join(fixture, 'handlers.cjs'), transpileOnce(registrations.join(';\n'), { target: ts.ScriptTarget.ES2022 }));
  fs.writeFileSync(path.join(fixture, 'worker.cjs'), workerSource);
  assert.ok(Date.now() - compileStarted < 5_000, 'owned fixture compile exceeded 5s');
  console.info('[jobs-cap compile] cached outputs=' + compiledSources.size + ', elapsedMs=' + (Date.now() - compileStarted));
  ({ oldestId, newestId } = await seedWorker());
  storedHashes = Object.fromEntries(STORE_FILES.map(file => [file, hash(path.join(fixture, 'data', file))]));
  })();
}
// Only this real persistence fixture has a budget: <=5s compile + <=20s seed.
// The runner's global hook/test timeouts and every assertion stay unchanged.
beforeAll(() => setupFixture(), 30_000);
afterAll(() => {
  if (!process.env.UI_GOAL_JOBS_STORAGE && fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

// This DOM parses production markup, supports parent/sibling insertion and real
// event bubbling. It intentionally has no layout, native menus or browser input.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
class Element {
  attributes: Record<string, string> = {}; children: Element[] = []; parentNode: Element | null = null;
  style: Record<string, string> = {}; listeners: Record<string, Array<(e: any) => void>> = {};
  value = ''; checked = false; open = false; hidden = false; text = ''; readyState = 'complete';
  onclick?: (e: any) => void;
  dataset = new Proxy({} as Record<string, string>, {
    get: (_t, k) => this.getAttribute('data-' + String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase())) ?? undefined,
    set: (_t, k, v) => { this.setAttribute('data-' + String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase()), v); return true; },
  });
  classList = {
    contains: (k: string) => this.className.split(/\s+/).includes(k),
    toggle: (k: string, on?: boolean) => { const next = on ?? !this.classList.contains(k); this.className = this.className.split(/\s+/).filter(x => x && x !== k).concat(next ? [k] : []).join(' '); return next; },
    add: (k: string) => { this.classList.toggle(k, true); }, remove: (k: string) => { this.classList.toggle(k, false); },
  };
  constructor(public tagName: string) { this.tagName = tagName.toUpperCase(); }
  get nodeType() { return this.tagName === '#TEXT' ? 3 : 1; }
  get parentElement() { return this.parentNode; }
  get isConnected(): boolean { return this.tagName === 'DOCUMENT' || !!this.parentNode?.isConnected; }
  get id() { return this.attributes.id || ''; } set id(v: string) { this.attributes.id = v; }
  get className() { return this.attributes.class || ''; } set className(v: string) { this.attributes.class = v; }
  get childNodes() { return this.children; } get firstChild() { return this.children[0] || null; }
  get nextSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
  get textContent(): string { return this.nodeType === 3 ? this.text : this.children.map(c => c.textContent).join(''); }
  set textContent(s: string) { this.children = []; if (s) { const n = new Element('#text'); n.text = String(s); this.appendChild(n); } }
  get innerHTML(): string { return this.children.map(c => c.nodeType === 3 ? esc(c.text) : c.outerHTML).join(''); }
  set innerHTML(s: string) { this.children = []; parse(s, this); }
  insertAdjacentHTML(position: string, html: string) {
    const temp = new Element('div'); parse(html, temp);
    for (const node of [...temp.children]) {
      if (position === 'afterbegin') this.insertBefore(node, this.firstChild);
      else if (position === 'beforeend') this.appendChild(node);
      else throw new Error('unadmitted HTML insertion ' + position);
    }
  }
  get outerHTML(): string { return '<' + this.tagName.toLowerCase() + Object.entries(this.attributes).map(([k, v]) => ' ' + k + '="' + esc(v) + '"').join('') + '>' + this.innerHTML + '</' + this.tagName.toLowerCase() + '>'; }
  setAttribute(k: string, v: unknown) { this.attributes[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  hasAttribute(k: string) { return Object.hasOwn(this.attributes, k); }
  removeAttribute(k: string) { delete this.attributes[k]; }
  appendChild(n: Element) { n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n); return n; }
  insertBefore(n: Element, before: Element | null) { n.parentNode?.removeChild(n); n.parentNode = this; const i = before ? this.children.indexOf(before) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n; }
  removeChild(n: Element) { this.children = this.children.filter(c => c !== n); n.parentNode = null; return n; }
  remove() { this.parentNode?.removeChild(this); }
  contains(n: Element): boolean { return n === this || this.children.some(c => c.contains(n)); }
  matches(selector: string): boolean {
    return selector.split(',').some(raw => {
      const s = raw.trim(); if (/[ >:]/.test(s.replace(/\[[^\]]*\]/g, ''))) return false;
      const tag = s.match(/^[\w-]+/); if (tag && this.tagName !== tag[0].toUpperCase()) return false;
      const id = s.match(/#([\w-]+)/); if (id && this.id !== id[1]) return false;
      for (const m of s.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(m[1])) return false;
      for (const m of s.matchAll(/\[([^\]=]+)(?:=["']?([^"'\]]*)["']?)?\]/g)) if (!this.hasAttribute(m[1]) || (m[2] !== undefined && this.getAttribute(m[1]) !== m[2])) return false;
      return !!(tag || id || s.includes('.') || s.includes('['));
    });
  }
  querySelectorAll(s: string): Element[] { return this.children.flatMap(c => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]); }
  querySelector(s: string) { return this.querySelectorAll(s)[0] || null; }
  closest(s: string): Element | null { return this.matches(s) ? this : this.parentNode?.closest(s) || null; }
  captureListeners: Record<string, Array<(e: any) => void>> = {};
  addEventListener(type: string, fn: (e: any) => void, capture = false) { const handlers = capture ? this.captureListeners : this.listeners; (handlers[type] ||= []).push(fn); }
  removeEventListener(type: string, fn: (e: any) => void, capture = false) { const handlers = capture ? this.captureListeners : this.listeners; handlers[type] = (handlers[type] || []).filter(f => f !== fn); }
  dispatchEvent(e: any) {
    e.target ||= this; e.preventDefault ||= () => {}; e.stopPropagation ||= () => {};
    const chain: Element[] = []; for (let n: Element | null = this; n; n = n.parentNode) chain.push(n);
    for (const n of [...chain].reverse()) for (const fn of n.captureListeners[e.type] || []) fn(e);
    for (const n of chain) { for (const fn of n.listeners[e.type] || []) fn(e); const fn = (n as any)['on' + e.type]; if (fn) fn(e); }
    return true;
  }
  click() { this.dispatchEvent({ type: 'click' }); }
  focus() {} getClientRects() { return []; }
  showModal() { this.open = true; } close() { this.open = false; }
}
function parse(html: string, parent: Element) {
  const stack = [parent]; const voids = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'area', 'base', 'source', 'wbr']);
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
    if (token.startsWith('</')) { const tag = token.slice(2, -1).trim().toUpperCase(); while (stack.length > 1) if (stack.pop()!.tagName === tag) break; }
    else if (/^<[a-z]/i.test(token)) {
      const tag = token.match(/^<([\w-]+)/)![1]; const n = new Element(tag);
      for (const m of token.slice(tag.length + 1, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) n.setAttribute(m[1], decode(m[2] ?? m[3] ?? m[4] ?? ''));
      stack.at(-1)!.appendChild(n); if (!voids.has(tag.toLowerCase()) && !token.endsWith('/>')) stack.push(n);
    } else if (!token.startsWith('<!')) { const n = new Element('#text'); n.text = decode(token); stack.at(-1)!.appendChild(n); }
  }
}
function deferred() { let resolve!: (v: any) => void, reject!: (e: Error) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function harness(locale: Locale, jobsReplies: Array<Promise<unknown>> = [], automationSource = source('src/renderer/js/app/automation.js'), withGlobalLocaleRouter = false) {
  const document = new Element('document') as Element & { documentElement: Element; body: Element; getElementById: (id: string) => Element | null; createElement: (tag: string) => Element; createTextNode: (s: string) => Element };
  document.innerHTML = source('src/renderer/index.html');
  document.documentElement = document.querySelector('html')!; document.body = document.querySelector('body')!;
  document.getElementById = id => document.querySelector('#' + id);
  document.createElement = tag => new Element(tag);
  document.createTextNode = s => { const n = new Element('#text'); n.text = s; return n; };
  const requests: Array<{ channel: string; args: any[] }> = [];
  const window: any = { document, addEventListener() {}, removeEventListener() {}, performance: { now: () => 0 } };
  const context = vm.createContext({ window, document, console, performance: window.performance, navigator: { language: locale },
    localStorage: { getItem: () => locale, setItem() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    HTMLElement: Element, HTMLDialogElement: Element, MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { detail: unknown; constructor(public type: string, opts: { detail: unknown }) { this.detail = opts.detail; } },
    require(id: string) {
      assert.equal(id, 'electron'); return { contextBridge: { exposeInMainWorld(k: string, v: unknown) { window[k] = v; } },
        ipcRenderer: { async invoke(channel: string, ...args: any[]) {
          requests.push({ channel, args });
          if (channel === 'browser:batch-max-concurrency') return { max: 4 };
          if (channel === 'app:set-language') return undefined; // preference boundary, no stored write
          // Unrelated read-only boundaries exercised by the real global locale
          // router; these values make no rule/scheduler/browser acceptance claim.
          if (withGlobalLocaleRouter) {
            if (channel === 'browser:binary') return { installed: false };
            if (['automation:list', 'automation:logs'].includes(channel)) return [];
            if (channel === 'automation:schedule-state') return { success: true, states: [] };
            if (channel === 'settings:automation-notify') return { system: false, sound: false };
          }
          if (channel === 'automation:jobs' && jobsReplies.length) return jobsReplies.shift();
          assert.ok(['automation:jobs', 'automation:job-get', 'agent-db:tables', 'agent-db:table-data', 'agent-db:query', 'audit:list'].includes(channel), 'unadmitted IPC ' + channel);
          return worker({ channel, args });
        }, on() {}, removeListener() {} },
      };
    },
  });
  const load = (p: string) => vm.runInContext(source(p), context, { filename: path.join(ROOT, p) });
  load('src/main/preload.cjs'); load('src/renderer/js/i18n.js');
  for (const module of ['icons', 'core', 'ipc', 'tabs', 'batch-ui']) load(`src/renderer/js/app/${module}.js`);
  if (withGlobalLocaleRouter) {
    load('src/renderer/js/app/agent-config.js'); // actual earlier locale listener, as in index.html
    window.agentBrowser.state.currentTab = 'automation';
  }
  vm.runInContext(automationSource, context, { filename: 'automation.js' });
  for (const module of ['db', 'activity', 'delegation']) load(`src/renderer/js/app/${module}.js`);
  window.i18n.apply();
  const get = (id: string) => { const n = document.getElementById(id); assert.ok(n, id); return n; };
  return { window, app: window.agentBrowser, document, requests, get, grid: get('automation-jobs'), notice: () => document.getElementById('automation-jobs-limit') };
}
function expectCaption(h: ReturnType<typeof harness>, locale: Locale, shown: number, limit = 50) {
  const notice = h.notice(); expect(notice, 'plain limit notice outside the card grid').not.toBeNull();
  expect(notice!.textContent).toBe(caption(locale, shown, limit));
  expect(h.grid.contains(notice!)).toBe(false); expect(notice!.parentNode).toBe(h.grid.parentNode);
  expect(notice!.style.color).toBe('var(--text-muted)'); expect(notice!.querySelector('svg')).toBeNull();
  expect(notice!.getAttribute('data-i18n')).toBeNull(); // applyDom must not replace interpolated copy.
  expect(h.document.querySelectorAll('#automation-jobs-limit')).toHaveLength(1);
}

describe('Jobs cap — actual persisted rows and whole renderer', () => {
  it('retains 201 cancelled rows on disk and searches the oldest after a fresh process reload', () => {
    const direct = new DatabaseSync(path.join(fixture, 'data/jobs.sqlite'), { readOnly: true });
    try {
      expect(direct.prepare('SELECT COUNT(*) AS n FROM jobs WHERE status=?').get('cancelled')!.n).toBe(201);
      expect(direct.prepare('SELECT id FROM jobs ORDER BY created_at LIMIT 1').get()!.id).toBe(oldestId);
      expect(direct.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    } finally { direct.close(); }
    expect(worker({ channel: 'automation:job-get', args: [oldestId] })).toMatchObject({ id: oldestId, status: 'cancelled', ruleName: 'Cancelled fixture 0' });
    const all = worker({ channel: 'automation:jobs', args: [{ status: 'cancelled', limit: 1000 }] });
    const fifty = worker({ channel: 'automation:jobs', args: [{ status: 'cancelled', limit: 50 }] });
    expect(all).toHaveLength(201); expect(fifty).toEqual(all.slice(0, 50)); expect(all[0].id).toBe(newestId); expect(all.at(-1).id).toBe(oldestId);
  });
  it.each(LOCALES)('discloses the requested 50 newest matching jobs in %s without inventing a total', async locale => {
    const h = harness(locale); h.get('automation-job-status').value = 'cancelled';
    h.get('automation-job-status').dispatchEvent({ type: 'change' }); await flush();
    expect(h.requests.filter(r => r.channel === 'automation:jobs').map(r => r.args)).toEqual([[{ status: 'cancelled', limit: 50 }]]);
    expect(h.grid.querySelectorAll('[data-job-id]')).toHaveLength(50); expect(h.grid.querySelector('[data-job-id]')!.dataset.jobId).toBe(newestId);
    expect(h.grid.textContent).not.toContain(oldestId); expectCaption(h, locale, 50);
    expect(h.notice()!.textContent).not.toContain('201');
    h.get('automation-job-status').value = 'failed'; h.get('automation-job-status').dispatchEvent({ type: 'change' }); await flush();
    expectCaption(h, locale, 0); expect(h.grid.querySelectorAll('[data-job-id]')).toHaveLength(0);
    expect(h.grid.querySelector('.empty-state')).not.toBeNull();
  });
  it.each(LOCALES)('real earlier global locale reload keeps the loaded Jobs caption/cards without a Jobs refetch in %s', async locale => {
    const rows = worker({ channel: 'automation:jobs', args: [{ limit: 3 }] });
    const h = harness(locale, [Promise.resolve(rows)], undefined, true); h.app.automationRefreshJobs(); await flush();
    expectCaption(h, locale, 3); const cards = h.grid.querySelectorAll('[data-job-id]');
    h.window.i18n.set(locale === 'en-US' ? 'zh-CN' : 'en-US'); await flush();
    expectCaption(h, locale === 'en-US' ? 'zh-CN' : 'en-US', 3);
    expect(h.grid.querySelectorAll('[data-job-id]')).toEqual(cards);
    expect(h.requests.filter(r => r.channel === 'automation:jobs')).toHaveLength(1);
    // Do not suppress the other locale listeners or alter their unrelated reads.
    expect(h.requests.some(r => r.channel === 'browser:binary')).toBe(true);
    expect(h.requests.some(r => r.channel === 'automation:list')).toBe(true);
    h.app.automationRefreshJobs(); await flush(); expect(h.requests.filter(r => r.channel === 'automation:jobs')).toHaveLength(2);
  });
  it.each(LOCALES)('real global locale reload does not supersede a pending current Jobs read/error in %s', async locale => {
    const pending = deferred(); const h = harness(locale, [pending.promise], undefined, true);
    h.get('automation-job-status').value = 'failed'; h.app.automationRefreshJobs();
    h.window.i18n.set(locale === 'en-US' ? 'zh-CN' : 'en-US'); await flush();
    expect(h.requests.filter(r => r.channel === 'automation:jobs')).toHaveLength(1);
    expect(h.grid.querySelector('.skeleton-list')).not.toBeNull(); expect(h.notice()?.textContent || '').toBe('');
    pending.reject(new Error('current pending Jobs error')); await flush();
    expect(h.grid.textContent).toContain('current pending Jobs error'); expect(h.notice()?.textContent || '').toBe('');
    h.window.i18n.set(locale); await flush(); expect(h.requests.filter(r => r.channel === 'automation:jobs')).toHaveLength(1);
    expect(h.grid.textContent).toContain('current pending Jobs error'); expect(h.notice()?.textContent || '').toBe('');
    expect(Object.fromEntries(STORE_FILES.map(file => [file, hash(path.join(fixture, 'data', file))]))).toEqual(storedHashes);
  });
  it.each(LOCALES)('one configured request limit also drives the caption in %s (in-memory variant only)', async locale => {
    const code = source('src/renderer/js/app/automation.js');
    const anchor = 'var jobsListLimit = 50;'; assert.equal(code.split(anchor).length, 2);
    const h = harness(locale, [], code.replace(anchor, 'var jobsListLimit = 7;'));
    h.get('automation-job-status').value = 'cancelled'; h.app.automationRefreshJobs(); await flush();
    expect(h.requests.filter(r => r.channel === 'automation:jobs').map(r => r.args)).toEqual([[{ status: 'cancelled', limit: 7 }]]);
    expect(h.grid.querySelectorAll('[data-job-id]')).toHaveLength(7); expectCaption(h, locale, 7, 7);
  });
  it.each(['old-first', 'new-first'])('a current status error owns the empty caption despite a stale successful %s reply', async order => {
    const old = deferred(), current = deferred();
    const rows = worker({ channel: 'automation:jobs', args: [{ limit: 3 }] });
    const h = harness('en-US', [old.promise, current.promise]);
    h.get('automation-job-status').value = 'cancelled'; h.app.automationRefreshJobs();
    h.get('automation-job-status').value = 'failed'; h.app.automationRefreshJobs();
    if (order === 'old-first') { old.resolve(rows); await flush(); current.reject(new Error('current failed-status error')); }
    else { current.reject(new Error('current failed-status error')); await flush(); old.resolve(rows); }
    await flush(); expect(h.grid.textContent).toContain('current failed-status error');
    expect(h.grid.querySelector('[data-job-id]')).toBeNull(); expect(h.notice()?.textContent || '').toBe('');
    h.window.i18n.set('zh-CN'); expect(h.notice()?.textContent || '').toBe('');
  });
  it.each(LOCALES)('uses actual returned counts and repaints the cached caption in %s without job refetch or storage write', async locale => {
    const rows = worker({ channel: 'automation:jobs', args: [{ limit: 3 }] });
    const h = harness(locale, [Promise.resolve(rows)]); h.app.automationRefreshJobs(); await flush(); expectCaption(h, locale, 3);
    const count = h.requests.filter(r => r.channel === 'automation:jobs').length;
    const other = locale === 'en-US' ? 'zh-CN' : 'en-US'; h.window.i18n.set(other); await flush();
    expectCaption(h, other, 3); expect(h.grid.querySelectorAll('[data-job-id]')).toHaveLength(3);
    h.window.i18n.set(locale); h.window.i18n.apply(); expectCaption(h, locale, 3);
    expect(h.requests.filter(r => r.channel === 'automation:jobs')).toHaveLength(count);
    expect(Object.fromEntries(STORE_FILES.map(file => [file, hash(path.join(fixture, 'data', file))]))).toEqual(storedHashes);
  });
  it.each(LOCALES)('pending/error states never advertise the previous count as current in %s; Retry recovers', async locale => {
    const pending = deferred(), retry = deferred(); const rows = worker({ channel: 'automation:jobs', args: [{ limit: 2 }] });
    const h = harness(locale, [Promise.resolve(rows), pending.promise, retry.promise]);
    h.app.automationRefreshJobs(); await flush(); expectCaption(h, locale, 2);
    h.get('automation-job-status').value = 'failed'; h.app.automationRefreshJobs();
    expect(h.notice()?.textContent || '').toBe(''); expect(h.grid.querySelector('.skeleton-list')).not.toBeNull(); expect(h.grid.querySelector('[data-job-id]')).toBeNull();
    h.window.i18n.set(locale === 'en-US' ? 'zh-CN' : 'en-US'); expect(h.notice()?.textContent || '').toBe('');
    pending.reject(new Error('current Jobs read failed')); await flush();
    expect(h.notice()?.textContent || '').toBe(''); expect(h.grid.textContent).toContain('current Jobs read failed');
    h.window.i18n.set(locale); expect(h.notice()?.textContent || '').toBe('');
    h.grid.querySelector('[data-cmd="automationRefreshJobs"]')!.click(); await flush();
    expect(h.grid.querySelector('.skeleton-list')).not.toBeNull(); retry.resolve([]); await flush(); expectCaption(h, locale, 0);
  });
  it.each(['old-first', 'new-first'])('existing reply guard keeps current status/count/cards with %s resolution and rejection', async order => {
    for (const staleError of [false, true]) {
      const a = deferred(), b = deferred(); const oldRows = worker({ channel: 'automation:jobs', args: [{ limit: 3 }] });
      const h = harness('en-US', [a.promise, b.promise]);
      h.get('automation-job-status').value = 'cancelled'; h.app.automationRefreshJobs();
      h.get('automation-job-status').value = 'failed'; h.app.automationRefreshJobs();
      const old = () => staleError ? a.reject(new Error('stale cancelled read')) : a.resolve(oldRows);
      if (order === 'old-first') { old(); await flush(); expect(h.grid.querySelector('.skeleton-list')).not.toBeNull(); expect(h.notice()?.textContent || '').toBe(''); b.resolve([]); }
      else { b.resolve([]); await flush(); old(); }
      await flush(); expectCaption(h, 'en-US', 0); expect(h.grid.querySelector('[data-job-id]')).toBeNull();
      expect(h.document.body.textContent).not.toContain('stale cancelled read');
    }
  });
  it.each(LOCALES)('new keys resolve from own effective final-merge dictionaries in %s and preserve 15 actual icon cohosts', locale => {
    const h = harness(locale); const dict = source('src/renderer/js/i18n.js');
    const ctx = vm.createContext({ window: {}, document: { addEventListener() {} }, navigator: { language: locale }, localStorage: { getItem: () => locale } });
    const expose = /^  \/\/ Expose\r?$/gm;
    assert.equal([...dict.matchAll(expose)].length, 1);
    vm.runInContext(dict.replace(expose, '  window.bundles = dict;\n  // Expose'), ctx);
    const bundles = (ctx as any).window.bundles;
    for (const key of ['auto.jobs-list-limit', 'toast.account.reference-conflict']) {
      expect(Object.hasOwn(bundles[locale], key)).toBe(true);
      const expected = key === 'auto.jobs-list-limit' ? COPY[locale] : CONFLICT[locale];
      expect(bundles[locale][key]).toBe(expected); expect(h.window.i18n.t(key, 'WRONG FALLBACK')).toBe(expected);
      expect(expected).toBe(expected.trim());
      expect([...dict.matchAll(new RegExp('"' + key.replace(/\./g, '\\.') + '"\\s*:', 'g'))]).toHaveLength(2);
    }
    expect(h.window.i18n.t('toast.account.stale')).toBe(locale === 'en-US' ? 'Account no longer exists — the list was refreshed' : '账号已不存在——列表已刷新');
    const hosts = h.document.querySelectorAll('[data-i18n][data-icon]'); expect(hosts).toHaveLength(15);
    const icons = hosts.map(n => n.querySelector('svg')); expect(icons.every(Boolean)).toBe(true);
    h.window.i18n.set(locale === 'en-US' ? 'zh-CN' : 'en-US'); h.window.i18n.set(locale);
    hosts.forEach((n, i) => { expect(n.querySelector('svg')).toBe(icons[i]); expect(n.textContent).toBe(h.window.i18n.t(n.getAttribute('data-i18n'))); });
    expect(fs.readFileSync(path.join(ROOT, 'i18n.js')).equals(fs.readFileSync(path.join(ROOT, 'src/renderer/js/i18n.js')))).toBe(true);
  });
});

describe('Prior bounded DB/Activity audit completion — no production changes', () => {
  it.each(LOCALES)('delegated SQL reveals stored row 101 and Activity exposes all 201 wrapped rows / oldest-category filter in %s', async locale => {
    const h = harness(locale); h.app.loadDbTab(); await flush();
    h.get('db-tables').querySelector('[data-table="fixture_rows"]')!.click(); await flush();
    expect(h.get('db-result').querySelector('tbody')!.querySelectorAll('tr')).toHaveLength(100);
    expect(h.get('db-result').textContent).toContain('101');
    h.get('db-sql').value = 'SELECT * FROM fixture_rows WHERE id=101';
    h.document.querySelector('[data-cmd="dbRunSql"]')!.click(); await flush();
    expect(h.requests.filter(r => r.channel === 'agent-db:query').at(-1)!.args).toEqual(['SELECT * FROM fixture_rows WHERE id=101']);
    expect(h.get('db-result').querySelector('tbody')!.querySelectorAll('tr')).toHaveLength(1);
    expect(h.get('db-result').textContent).toContain('fixture title 101');
    h.get('db-sql').value = 'SELECT * FROM fixture_rows ORDER BY id'; h.document.querySelector('[data-cmd="dbRunSql"]')!.click(); await flush();
    expect(h.get('db-result').querySelector('tbody')!.querySelectorAll('tr')).toHaveLength(101);
    h.app.loadActivity(); await flush();
    expect(h.get('activity-list').querySelectorAll('.timeline-card')).toHaveLength(1);
    expect(h.get('activity-list').querySelectorAll('.tl-row')).toHaveLength(201);
    expect(h.get('activity-list').textContent).toContain('fixture_target_0');
    h.get('activity-filter').value = 'profile'; h.get('activity-filter').dispatchEvent({ type: 'change' }); await flush();
    expect(h.requests.filter(r => r.channel === 'audit:list').at(-1)!.args).toEqual([{ category: 'profile', limit: 300 }]);
    expect(h.get('activity-list').querySelectorAll('.tl-row')).toHaveLength(1); expect(h.get('activity-list').textContent).toContain('fixture_target_0');
    expect(h.app.helpers.fmtDuration(41200)).toBe('41.2s'); // real batch-ui dependency, not a shim
    const direct = new DatabaseSync(path.join(fixture, 'data/agent-store.sqlite'), { readOnly: true });
    try { expect(direct.prepare('SELECT COUNT(*) AS n FROM fixture_rows').get()!.n).toBe(101); expect(direct.prepare('SELECT title FROM fixture_rows WHERE id=101').get()!.title).toBe('fixture title 101'); } finally { direct.close(); }
    expect(fs.readFileSync(path.join(fixture, 'data/audit.log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(201);
    expect(Object.fromEntries(STORE_FILES.map(file => [file, hash(path.join(fixture, 'data', file))]))).toEqual(storedHashes);
  });
});
