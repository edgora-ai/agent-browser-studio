// Whole sync renderer + optional real i18n runtime in a control DOM. No app,
// browser, credentials, S3, timers that own writes, or global temp changes.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(__dirname, "../..");
const SOURCE = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/sync.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");
const TOKEN_A = { targetId: "target-a", localHash: "local-a", remoteHash: "remote-a" };
const TOKEN_B = { targetId: "target-a", localHash: "local-b", remoteHash: "remote-b" };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 160; i++) await Promise.resolve(); }
const escape = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
class Control {
  nodeType = 1; tagName = "DIV"; attrs: Record<string, string> = {}; style: Record<string, string> = {};
  value = ""; checked = false; disabled = false; placeholder = ""; open = false; parentNode: Control | null = null;
  childNodes: any[] = []; html = ""; text = "";
  handlers = new Map<string, Array<(event: any) => void>>();
  onchange: ((event: any) => void) | null = null; onclick: ((event: any) => void) | null = null;
  focus = vi.fn(); register: ((node: Control) => void) | null = null;
  get id() { return this.attrs.id || ""; }
  set id(value: string) { this.attrs.id = value; this.register?.(this); }
  get className() { return this.attrs.class || ""; }
  set className(value: string) { this.attrs.class = value; }
  get children(): Control[] { return this.childNodes.filter((node) => node.nodeType === 1); }
  get innerHTML(): string { return this.html || this.childNodes.map((node) => node.nodeType === 3 ? escape(node.textContent) : node.innerHTML || node.textContent || "").join("") || escape(this.text); }
  set innerHTML(value: string) {
    this.html = value; this.text = ""; this.childNodes = [];
    for (const match of value.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const select = new Control(); select.tagName = "SELECT"; select.register = this.register;
      for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) select.attrs[attr[1]] = attr[2];
      const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      select.value = (options.find((option) => /\bselected\b/.test(option[2])) || options[0])?.[1] || "";
      select.disabled = /\bdisabled\b/.test(match[1]); this.appendChild(select);
    }
  }
  get textContent(): string { return this.text || this.html.replace(/<[^>]*>/g, "") || this.childNodes.map((node) => node.textContent || "").join(""); }
  set textContent(value: string) { this.text = String(value); this.html = ""; this.childNodes = []; }
  setAttribute(key: string, value: string) { this.attrs[key] = String(value); if (key === "id") this.register?.(this); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  appendChild(node: any) { this.childNodes.push(node); node.parentNode = this; if (node.nodeType === 1) { node.register = this.register; this.register?.(node); } return node; }
  removeChild(node: any) { this.childNodes = this.childNodes.filter((candidate) => candidate !== node); node.parentNode = null; }
  addEventListener(type: string, listener: (event: any) => void) { this.handlers.set(type, [...this.handlers.get(type) || [], listener]); }
  removeEventListener(type: string, listener: (event: any) => void) { this.handlers.set(type, (this.handlers.get(type) || []).filter((candidate) => candidate !== listener)); }
  emit(type: string) { const event = { type, target: this }; for (const handler of this.handlers.get(type) || []) handler(event); if (type === "change") this.onchange?.(event); }
  querySelector(selector: string): Control | null { return this.children.find((child) => selector === "svg" ? child.tagName === "SVG" : child.id === selector.slice(1)) || null; }
  querySelectorAll(_selector: string): Control[] { return []; }
  contains(node: Control) { return this.children.includes(node); }
  closest(selector: string) { return selector.startsWith(".") && this.className.split(" ").includes(selector.slice(1)) ? this : null; }
  get dataset() { return Object.fromEntries(Object.entries(this.attrs).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])); }
}
function section(id: string) { return { localOnly: [], remoteOnly: [], changed: [{ id, fields: ["name"] }] }; }
function comparison(token: any = TOKEN_A, profileId = "profile-a") {
  return { ok: true, comparisonToken: token, profiles: section(profileId), proxies: section("proxy-a"), accounts: section("account-a"), extensions: section("ext-a"), pushWarnings: [], pullNotes: [], artifacts: {},
    coverage: { compared: ["portable-profile", "preferences"], notCompared: ["live-cookies", "localStorage-database", "full-profile-files"], unverified: [] as Array<{ id: string; reason: string }> } };
}
function result(overrides: Record<string, any> = {}): any {
  return { success: true, operationId: "manual-pull", outcome: "complete", localCommit: "committed", remoteCommit: "none", message: "owned fixture result", items: [], warnings: [], recovery: [], ...overrides };
}
function harness(locale?: "en-US" | "zh-CN") {
  const elements: Record<string, Control> = {};
  const register = (node: Control) => { if (node.id) elements[node.id] = node; };
  for (const id of [...HTML.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])) { const node = new Control(); node.register = register; node.id = id; }
  const documentListeners = new Map<string, Array<(event: any) => void>>();
  const buttons = Object.fromEntries(["syncPush", "syncPull", "syncSave", "loadSyncDiff", "loadSyncPreview"].map((name) => {
    const button = new Control(); button.tagName = "BUTTON"; button.attrs["data-cmd"] = name;
    button.textContent = name === "syncPush" ? "Push" : name === "syncPull" ? "Pull" : name === "syncSave" ? "Save" : name;
    const svg = new Control(); svg.tagName = "SVG"; button.appendChild(svg);
    return [name, button];
  }));
  elements["sync-merge-strategy"].value = "local";
  const entries = () => elements["sync-diff"].children.filter((node) => node.className === "sync-entry-strategy");
  const document = {
    documentElement: { lang: "" },
    getElementById: (id: string) => elements[id] || null,
    createElement: (tag: string) => { const node = new Control(); node.tagName = tag.toUpperCase(); node.register = register; return node; },
    createTextNode: (textContent: string) => ({ nodeType: 3, textContent }),
    querySelector: (selector: string) => Object.entries(buttons).find(([name]) => selector.includes(`"${name}"`))?.[1] || elements[selector.slice(1)] || null,
    querySelectorAll: (selector: string) => selector.includes("sync-entry-strategy") ? entries() : selector.startsWith("[data-") ? Object.values(elements).filter((element) => element.getAttribute(selector.slice(1, -1)) !== null) : [],
    addEventListener: (type: string, listener: (event: any) => void) => documentListeners.set(type, [...documentListeners.get(type) || [], listener]),
    dispatchEvent: (event: any) => { for (const listener of documentListeners.get(event.type) || []) listener(event); return true; },
  };
  let currentStatus: any = { enabled: true, configured: true, endpoint: "https://saved.example.test", bucket: "saved-bucket", accessKeyMasked: "fixture-mask", custodyConsentAt: 1,
    operation: { generation: 0, active: null, last: null } };
  let currentPreview: any = { configured: true, profiles: 1, proxies: 1, accounts: 1, extensions: 1, runningProfiles: [], message: "fresh fixture preview" };
  const listeners = new Map<string, (event: any) => void>();
  const api = {
    on: vi.fn((channel: string, listener: (event: any) => void) => { listeners.set(channel, listener); }),
    removeListener: vi.fn((channel: string) => listeners.delete(channel)),
    sync: {
      status: vi.fn(async (): Promise<any> => JSON.parse(JSON.stringify(currentStatus))),
      preview: vi.fn(async (): Promise<any> => JSON.parse(JSON.stringify(currentPreview))),
      previewDiff: vi.fn(async (): Promise<any> => comparison()),
      push: vi.fn(async (_opts?: any): Promise<any> => result({ operationId: "manual-push", remoteCommit: "committed" })),
      pull: vi.fn(async (_opts?: any): Promise<any> => result()),
      configure: vi.fn(async (_config: any): Promise<any> => result({ operationId: "manual-configure" })),
      cancel: vi.fn(async (opts: any): Promise<any> => ({ success: true, requestId: opts.requestId, state: "cancelling" })),
      historyState: vi.fn(async (_dirId: string): Promise<any> => ({ scope: "history-and-firefox-bookmarks", status: "unknown", coverage: "legacy", freshness: "not-covered", capturedAt: null })),
    },
    app: { reloadConfig: vi.fn(async () => { throw new Error("renderer must not reload the live config store"); }), setLanguage: vi.fn(async () => {}) },
    team: { status: vi.fn(async () => ({ team: null, local: { role: "owner" } })) },
  };
  const order: string[] = [];
  const makeLoader = (name: string) => vi.fn(async (..._args: any[]) => { order.push(name); });
  const ab: any = {
    api, state: { currentTab: "extensions" }, helpers: { toast: vi.fn(), esc: escape, escAttr: escape, icon: () => "" }, confirmAsync: vi.fn(async () => true),
    ipc: { call: vi.fn((_key: string, fn: () => any) => Promise.resolve().then(fn)) },
    renderViewState: vi.fn((node: Control, view: any) => { node.innerHTML = escape(view.error || view.empty || view.loading || ""); }),
    invalidateProfilesForSync: vi.fn(() => order.push("invalidateProfiles")),
    invalidateAccountsForSync: vi.fn(() => order.push("invalidateAccounts")),
    loadProfiles: makeLoader("profiles"), loadAccountsTab: makeLoader("accounts"), loadProxies: makeLoader("proxies"), loadExtensionsTab: makeLoader("extensions"),
  };
  const window: any = { agentBrowser: ab, agentBrowserAPI: api };
  const context: any = { window, document, console, setTimeout, clearTimeout, Promise, Date,
    navigator: { language: locale || "en-US" }, localStorage: { getItem: () => null, setItem: () => undefined },
    CustomEvent: class { constructor(readonly type: string, readonly options: any) {} get detail() { return this.options?.detail; } },
  };
  if (locale) vm.runInNewContext(I18N, context, { filename: "i18n.js" });
  vm.runInNewContext(SOURCE, context, { filename: "sync.js" });
  const emit = (event: any, fullResult?: any) => {
    const previousActive = currentStatus.operation.active;
    currentStatus.operation = { generation: event.generation, active: event.phase === "started" ? { operationId: event.operationId, kind: event.kind, stage: "running", startedAt: 1 } : event.kind === "configure" && previousActive?.operationId !== event.operationId ? previousActive : null,
      last: event.phase === "completed" && event.result ? fullResult || { ...event.result, operationId: event.operationId } : currentStatus.operation.last };
    listeners.get("sync:state-changed")?.(event);
  };
  return { ab, api, elements, buttons, entries, order, document, window, emit,
    emitProgress: (progress: any) => listeners.get("sync:progress")?.(progress),
    renderedProgress: () => elements["sync-operation-state"]?.innerHTML || "",
    loadModule: (name: "proxies" | "extensions") => vm.runInNewContext(fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${name}.js`), "utf8"), context, { filename: `${name}.js` }),
    status: () => currentStatus, setStatus: (value: any) => { currentStatus = value; },
    setPreview: (value: any) => { currentPreview = value; },
    banner: () => elements["sync-operation-state"]?.textContent || "",
    renderedResult: () => elements["sync-operation-result"]?.innerHTML || "",
  };
}
function event(phase: "started" | "completed", generation: number, kind = "pull", operationId = "service-operation") {
  return { phase, generation, kind, operationId, scopes: ["config", "profiles", "accounts", "proxies", "extensions"], ...(phase === "completed" ? { result: { success: true, outcome: "complete", localCommit: "committed", remoteCommit: "none" } } : {}) };
}
function progressEvent(sequence = 1, overrides: Record<string, any> = {}) {
  return { generation: 1, operationId: "service-progress", kind: "push", stage: "publishing", startedAt: 1000,
    progress: { sequence, updatedAt: 5000, scope: "profiles", itemId: "profile-a", completedItems: 1, totalItems: 4,
      transfer: { direction: "upload", bytes: 524288, totalBytes: 1048576, startedAt: 1000, state: "transferring" } }, ...overrides };
}
afterEach(() => vi.useRealTimers());

describe("owned sync progress rendering and races", () => {
  const labels = {
    "en-US": { stages: ["Preparing…", "Publishing…", "Downloading…", "Verifying…", "Applying…", "Finalizing…"],
      count: "Profiles / objects: 1 / 4", item: "Current item: Profiles · profile-a", upload: "Current object upload", download: "Current object download",
      rate: "Average rate: 128 KiB/s", elapsed: "Elapsed: 00:10", waiting: "Waiting for server confirmation", incomplete: "sync is not complete", objectComplete: "Current object transferred" },
    "zh-CN": { stages: ["正在准备…", "正在发布…", "正在下载…", "正在校验…", "正在应用…", "正在收尾…"],
      count: "配置／对象：1 / 4", item: "当前项目：浏览器配置 · profile-a", upload: "当前对象上传", download: "当前对象下载",
      rate: "平均速率：128 KiB/s", elapsed: "已用时：00:10", waiting: "正在等待服务器确认", incomplete: "同步尚未完成", objectComplete: "当前对象传输完毕" },
  } as const;
  async function active(locale: "en-US" | "zh-CN" = "en-US", kind = "push") {
    const h = harness(locale); h.emit(event("started", 1, kind, "service-progress")); await flush(); return h;
  }
  for (const locale of ["en-US", "zh-CN"] as const) {
    it.each(["push", "pull"])(`${locale} %s shows current-object byte progress, item counts, rate, elapsed and ARIA without a global percentage`, async kind => {
      vi.useFakeTimers(); vi.setSystemTime(11000);
      const h = await active(locale, kind), svg = h.buttons.syncPush.querySelector("svg"), fixture = progressEvent();
      fixture.kind = kind; fixture.stage = kind === "push" ? "publishing" : "downloading";
      fixture.progress.transfer.direction = kind === "push" ? "upload" : "download";
      h.emitProgress(fixture);
      const body = h.renderedProgress(), text = labels[locale];
      for (const label of [text.count, text.item, text.rate, text.elapsed, kind === "push" ? text.upload : text.download]) expect(body).toContain(label);
      expect(body).toContain("512 KiB / 1 MiB"); expect(body).toContain('style="width:50%"');
      expect(h.banner()).not.toContain("50%"); expect(h.banner()).not.toContain("25%");
      expect(body).toContain('role="progressbar"'); expect(body).toContain('aria-valuenow="524288"'); expect(body).toContain('aria-valuemax="1048576"');
      expect(body).toContain('aria-label="' + (kind === "push" ? text.upload : text.download) + '"');
      expect(h.elements["sync-operation-state"].getAttribute("role")).toBe("status");
      expect(h.elements["sync-operation-state"].getAttribute("aria-live")).toBe("polite");
      expect(h.elements["tab-sync"].getAttribute("aria-busy")).toBe("true");
      expect(h.buttons.syncPush.querySelector("svg")).toBe(svg);
    });
    it(`${locale} localizes all stages and clears stale transfer and item information at stage boundaries`, async () => {
      const h = await active(locale); h.emitProgress(progressEvent());
      const stages = ["preparing", "publishing", "downloading", "verifying", "applying", "finalizing"];
      for (let i = 0; i < stages.length; i++) {
        h.emitProgress(progressEvent(i + 2, { stage: stages[i], progress: { sequence: i + 2, updatedAt: 6000 + i } }));
        const body = h.renderedProgress(); expect(body).toContain(labels[locale].stages[i]);
        expect(body).toContain("is-indeterminate"); expect(body).not.toContain("aria-valuenow"); expect(body).not.toContain("aria-valuemax");
        expect(body).not.toContain("profile-a"); expect(body).not.toContain("512 KiB"); expect(body).not.toContain(labels[locale].upload);
      }
    });
    it(`${locale} distinguishes uploaded bytes and server confirmation from actual sync completion`, async () => {
      const h = await active(locale), fixture = progressEvent();
      fixture.progress.transfer.bytes = fixture.progress.transfer.totalBytes; fixture.progress.transfer.state = "waiting-response";
      h.emitProgress(fixture);
      expect(h.banner()).toContain(labels[locale].waiting); expect(h.banner()).toContain(labels[locale].incomplete);
      expect(h.renderedProgress()).toContain('style="width:100%"'); expect(h.renderedResult()).toBe("");
      for (const button of [h.buttons.syncPush, h.buttons.syncPull, h.buttons.syncSave]) expect(button.disabled).toBe(true);
      fixture.progress.sequence++; fixture.progress.transfer.state = "complete"; h.emitProgress(fixture);
      expect(h.banner()).toContain(labels[locale].objectComplete); expect(h.banner()).toContain(labels[locale].incomplete);
      expect(h.renderedResult()).toBe(""); expect(h.buttons.syncPush.disabled).toBe(true);
      h.emit(event("completed", 2, "push", "service-progress")); await flush();
      expect(h.banner()).toBe(""); expect(h.buttons.syncPush.disabled).toBe(false); expect(h.renderedResult()).not.toBe("");
      h.emitProgress(progressEvent(99, { generation: 2 })); expect(h.banner()).toBe("");
    });
  }
  it("uses indeterminate progress for unknown byte totals, keeps known counts, and escapes item identifiers", async () => {
    const h = await active(), fixture = progressEvent();
    delete (fixture.progress.transfer as any).totalBytes;
    fixture.progress.itemId = '<img src=x onerror="fixture">'; h.emitProgress(fixture);
    expect(h.renderedProgress()).toContain("is-indeterminate"); expect(h.renderedProgress()).not.toContain("aria-valuenow");
    expect(h.renderedProgress()).toContain("512 KiB"); expect(h.renderedProgress()).toContain(labels["en-US"].count);
    expect(h.renderedProgress()).toContain("&lt;img"); expect(h.renderedProgress()).not.toContain("<img");
    fixture.progress.sequence++; fixture.progress.updatedAt = fixture.progress.transfer.startedAt;
    h.emitProgress(fixture); expect(h.banner()).toContain("Rate not yet available");
    expect(h.banner()).not.toMatch(/Infinity|NaN/);
  });
  it("progress chunks do not invalidate comparisons or pending reads, rebuild buttons, refresh surfaces, or request status/previews", async () => {
    const h = await active(); await h.ab.loadSyncDiff(); h.entries()[0].value = "remote";
    h.ab.invalidateProxiesForSync = vi.fn(); h.ab.invalidateExtensionsForSync = vi.fn();
    const pending = deferred<any>(); h.api.sync.preview.mockReturnValueOnce(pending.promise);
    const preview = h.ab.loadSyncPreview(); await flush();
    const requests = [h.api.sync.status, h.api.sync.preview, h.api.sync.previewDiff, h.api.team.status, h.api.app.reloadConfig,
      h.ab.loadProfiles, h.ab.loadAccountsTab, h.ab.loadProxies, h.ab.loadExtensionsTab, h.ab.invalidateProfilesForSync, h.ab.invalidateAccountsForSync,
      h.ab.invalidateProxiesForSync, h.ab.invalidateExtensionsForSync];
    const counts = requests.map(request => request.mock.calls.length), entries = h.entries().slice(), nodes = h.buttons.syncPush.childNodes.slice();
    for (let sequence = 1; sequence <= 40; sequence++) h.emitProgress(progressEvent(sequence));
    await flush(); expect(requests.map(request => request.mock.calls.length)).toEqual(counts);
    expect(h.entries()).toEqual(entries); expect(h.entries()[0].value).toBe("remote"); expect(h.buttons.syncPush.childNodes).toEqual(nodes);
    pending.resolve({ configured: true, profiles: 1, runningProfiles: [], message: "owned pending preview survived progress" });
    await preview; await flush(); expect(h.elements["sync-preview-message"].textContent).toContain("owned pending preview survived progress");
  });
  it("ignores duplicate, older, foreign, future-generation, and malformed progress without losing the valid owner's sequence", async () => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    const h = await active(); h.emitProgress(progressEvent(8)); const body = h.renderedProgress();
    const stale = [progressEvent(7), progressEvent(8), progressEvent(99, { generation: 0 }), progressEvent(99, { generation: 2 }),
      progressEvent(99, { operationId: "foreign" }), progressEvent(99, { kind: "pull" }), progressEvent(99, { stage: "unknown" }),
      progressEvent(99, { startedAt: NaN }), progressEvent(99, { progress: { sequence: -1, updatedAt: 7000 } }),
      progressEvent(99, { progress: { sequence: 99, updatedAt: Infinity } })];
    for (const fixture of stale) { h.emitProgress(fixture); expect(h.renderedProgress()).toBe(body); }
    h.emitProgress(progressEvent(9, { stage: "verifying", progress: { sequence: 9, updatedAt: 8000 } }));
    expect(h.banner()).toContain("Verifying…"); expect(h.renderedProgress()).not.toContain("512 KiB");
  });
  it.each(["absent", "older", "equal"])("does not regress a newer event when pending same-generation status has %s progress", async snapshot => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    const h = await active(), response = deferred<any>(), stale = progressEvent(snapshot === "equal" ? 8 : 2);
    const status = JSON.parse(JSON.stringify(h.status()));
    status.operation.active = { operationId: "service-progress", kind: "push", stage: "preparing", startedAt: 1000,
      ...(snapshot !== "absent" ? { progress: stale.progress } : {}) };
    h.api.sync.status.mockReturnValueOnce(response.promise); const read = h.ab.loadSyncConfig();
    const latest = progressEvent(8); latest.progress.transfer.bytes = 786432; h.emitProgress(latest);
    response.resolve(status); await read; await flush();
    expect(h.banner()).toContain("Publishing…"); expect(h.banner()).toContain("768 KiB / 1 MiB");
    expect(h.renderedProgress()).toContain('aria-valuenow="786432"');
  });
  it("keeps the owner through stale idle/foreign status, but accepts a newer sequence and status completion evidence", async () => {
    const h = await active(); h.emitProgress(progressEvent(8));
    h.status().operation.active = null; await h.ab.loadSyncConfig(); expect(h.banner()).toContain("Publishing…"); expect(h.buttons.syncPush.disabled).toBe(true);
    h.status().operation.active = { operationId: "foreign", kind: "push", stage: "preparing" }; await h.ab.loadSyncConfig();
    expect(h.banner()).toContain("Publishing…"); expect(h.banner()).not.toContain("foreign");
    const newer = progressEvent(9, { stage: "applying", progress: { sequence: 9, updatedAt: 9000, completedItems: 3, totalItems: 4 } });
    h.status().operation.active = { operationId: newer.operationId, kind: newer.kind, stage: newer.stage, startedAt: newer.startedAt, progress: newer.progress };
    await h.ab.loadSyncConfig(); expect(h.banner()).toContain("Applying…"); expect(h.banner()).toContain("3 / 4"); expect(h.renderedProgress()).not.toContain("512 KiB");
    h.status().operation.active = null; h.status().operation.last = result({ operationId: "service-progress" });
    await h.ab.loadSyncConfig(); await flush(); expect(h.banner()).toBe(""); expect(h.buttons.syncPush.disabled).toBe(false);
    h.emitProgress(progressEvent(10)); expect(h.banner()).toBe("");
  });
  it("hydrates active progress on reopening and cannot resurrect it after same-generation completion", async () => {
    const h = harness("zh-CN"), initial = progressEvent(8);
    h.status().operation = { generation: 1, active: { operationId: initial.operationId, kind: initial.kind, stage: initial.stage, startedAt: initial.startedAt, progress: initial.progress }, last: null };
    await h.ab.loadSyncConfig(); expect(h.banner()).toContain(labels["zh-CN"].upload); expect(h.banner()).toContain("512 KiB / 1 MiB");
    const obsolete = JSON.parse(JSON.stringify(h.status()));
    h.emit(event("completed", 1, "push", "service-progress")); await flush();
    h.setStatus(obsolete); await h.ab.loadSyncConfig(); h.emitProgress(progressEvent(99));
    expect(h.banner()).toBe(""); expect(h.buttons.syncPush.disabled).toBe(false);
  });
  it("retains a manual write through byte completion, a late completion event, and its pending reply beyond 15 seconds", async () => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    const h = harness(), write = deferred<any>(); await h.ab.loadSyncDiff(); h.api.sync.pull.mockReturnValueOnce(write.promise);
    const pending = h.ab.syncPull(); await flush(); h.emit({ ...event("started", 1, "pull", "manual-pull"), requestId: h.api.sync.pull.mock.calls[0][0].requestId }); await flush();
    const fixture = progressEvent(1, { operationId: "manual-pull", kind: "pull", stage: "downloading" });
    fixture.progress.transfer.direction = "download"; fixture.progress.transfer.state = "complete";
    fixture.progress.transfer.bytes = fixture.progress.transfer.totalBytes; h.emitProgress(fixture);
    await vi.advanceTimersByTimeAsync(20000); expect(h.buttons.syncPull.disabled).toBe(true); expect(h.banner()).toContain("sync is not complete");
    h.emit(event("completed", 2, "pull", "manual-pull")); await flush(); expect(h.banner()).toContain("Waiting for the operation result");
    h.emitProgress(progressEvent(99, { generation: 2, operationId: "manual-pull", kind: "pull" }));
    await h.ab.syncPush(); expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.buttons.syncPull.disabled).toBe(true);
    write.resolve(result()); await pending; await flush(); expect(h.buttons.syncPull.disabled).toBe(false); expect(h.banner()).toBe("");
  });
  it("keeps an active transfer across a newer unrelated idle status until matching completion", async () => {
    const h = await active(); h.emitProgress(progressEvent());
    h.status().operation = { generation: 2, active: null, last: result({ operationId: "unrelated-configure" }) };
    await h.ab.loadSyncConfig(); expect(h.buttons.syncPush.disabled).toBe(true); expect(h.banner()).toContain("Publishing…");
    h.emitProgress(progressEvent(2, { generation: 2, stage: "verifying", progress: { sequence: 2, updatedAt: 6000 } }));
    expect(h.banner()).toContain("Verifying…");
    h.emit(event("completed", 3, "push", "service-progress")); await flush(); expect(h.banner()).toBe(""); expect(h.buttons.syncPush.disabled).toBe(false);
  });
  it("an older manual write settling cannot hide a newer service owner's progress", async () => {
    const h = harness("en-US"), write = deferred<any>(); await h.ab.loadSyncDiff(); h.api.sync.pull.mockReturnValueOnce(write.promise);
    const pending = h.ab.syncPull(); await flush(); h.emit(event("started", 1, "pull", "manual-pull"));
    h.emit(event("completed", 2, "pull", "manual-pull")); await flush();
    h.emit(event("started", 3, "push", "service-progress")); await flush(); h.emitProgress(progressEvent(1, { generation: 3 }));
    write.resolve(result()); await pending; await flush();
    expect(h.banner()).toContain("Publishing…"); expect(h.banner()).toContain("512 KiB / 1 MiB"); expect(h.buttons.syncPull.disabled).toBe(true);
    h.emit(event("completed", 4, "push", "service-progress")); await flush(); expect(h.banner()).toBe(""); expect(h.buttons.syncPush.disabled).toBe(false);
  });
  it("does not invent percentages for empty objects or partial item counts", async () => {
    const h = await active(), fixture = progressEvent();
    fixture.progress.transfer.bytes = 0; fixture.progress.transfer.totalBytes = 0;
    delete (fixture.progress as any).completedItems; h.emitProgress(fixture);
    expect(h.banner()).toContain("Profiles / objects total: 4"); expect(h.banner()).toContain("0 B / 0 B");
    expect(h.renderedProgress()).toContain("is-indeterminate"); expect(h.renderedProgress()).not.toContain("aria-valuenow");
    fixture.progress.sequence++; fixture.progress.completedItems = 2; delete (fixture.progress as any).totalItems;
    h.emitProgress(fixture); expect(h.banner()).toContain("Profiles / objects completed: 2"); expect(h.banner()).not.toMatch(/NaN|Infinity/);
  });
  it("relocalizes the current progress in place without requests and preserves hydrated SVG controls", async () => {
    const h = await active(), svg = h.buttons.syncPull.querySelector("svg"); h.emitProgress(progressEvent());
    const calls = h.api.sync.status.mock.calls.length; h.window.i18n.set("zh-CN");
    expect(h.banner()).toContain(labels["zh-CN"].upload); expect(h.banner()).toContain(labels["zh-CN"].stages[1]);
    expect(h.api.sync.status).toHaveBeenCalledTimes(calls); expect(h.buttons.syncPull.querySelector("svg")).toBe(svg);
    h.window.i18n.set("en-US"); expect(h.banner()).toContain(labels["en-US"].upload); expect(h.buttons.syncPull.querySelector("svg")).toBe(svg);
  });
});

describe("actionable bilingual full-profile size-limit results", () => {
  for (const locale of ["en-US", "zh-CN"] as const) {
    it.each(["structured", "legacy", "item"])(`${locale} %s appends a safe explanatory hint without replacing backend limits or profile/path`, async variant => {
      const h = harness(locale), diagnostic = 'Full-profile expanded size limit exceeded (actualBytes=1234567890, limitBytes=1073741824, dirId=profile-size, memberPath=Default/<website>&data)';
      const failure = result({ operationId: "size-limit", success: false, outcome: "failed", localCommit: "none", remoteCommit: "none",
        ...(variant === "item" ? { code: "FULL_PROFILE_INVALID", message: "A browser backup failed", items: [{ scope: "fullProfile", id: "profile-size", state: "failed", code: "FULL_PROFILE_SIZE_LIMIT", message: diagnostic }] }
          : { code: variant === "structured" ? "FULL_PROFILE_SIZE_LIMIT" : "FULL_PROFILE_INVALID", message: diagnostic }) });
      h.emit(event("completed", 1, "push", "size-limit"), failure); await flush(); const body = h.renderedResult();
      for (const value of ["1234567890", "1073741824", "profile-size", "Default/&lt;website&gt;&amp;data"]) expect(body).toContain(value);
      expect(body).not.toContain("<website>"); expect(body).toContain(variant === "legacy" ? "FULL_PROFILE_INVALID" : "FULL_PROFILE_SIZE_LIMIT");
      for (const value of locale === "zh-CN" ? ["完整浏览器备份超出体积上限", "持久网站数据不会被静默丢弃", "不等同于完整迁移"] : ["full browser backup exceeds the size limit", "persistent website data is never silently discarded", "not a full migration"]) expect(body).toContain(value);
    });
  }
});

describe("separate history scope and truthful bilingual coverage", () => {
  it("requires explicit separate consent before saving the selected automatic scope", async () => {
    const h = harness(); await h.ab.loadSyncConfig();
    expect(h.elements["sync-history-consent"].checked).toBe(false); expect(h.elements["sync-include-history"].checked).toBe(false);
    h.elements["sync-include-history"].checked = true;
    await h.ab.syncSave(); expect(h.api.sync.configure).not.toHaveBeenCalled();
    h.elements["sync-history-consent"].checked = true;
    await h.ab.syncSave(); expect(h.api.sync.configure).toHaveBeenCalledWith(expect.objectContaining({ historyConsent: true, includeHistory: true }));
  });
  it("passes only saved history scope, not an unsaved checkbox draft, to push/pull", async () => {
    const h = harness(); h.status().includeHistory = true; h.status().historyConsentAt = 1;
    await h.ab.loadSyncConfig(); h.elements["sync-include-history"].checked = false;
    await h.ab.syncPush(); expect(h.api.sync.push).toHaveBeenCalledWith(expect.objectContaining({ history: true }));
    await h.ab.loadSyncDiff(); await h.ab.syncPull(); expect(h.api.sync.pull).toHaveBeenCalledWith(expect.objectContaining({ history: true }));
  });
  it.each(["zh-CN", "en-US"] as const)("renders %s distinct complete/empty/absent/legacy/preserved/failed/unselected coverage without claiming full restore", async (locale) => {
    const h = harness(locale); h.status().includeHistory = true; h.status().historyConsentAt = 1;
    const states = ["complete", "empty", "absent", "legacy", "preserved", "failed", "unselected"];
    h.status().history = Object.fromEntries(states.map((coverage) => ["synthetic-" + coverage, { coverage, status: "unknown", freshness: coverage === "preserved" ? "preserved" : coverage === "complete" || coverage === "empty" || coverage === "absent" ? "captured" : "not-covered", capturedAt: null }]));
    await h.ab.loadSyncConfig();
    const panel = h.elements["sync-history-coverage"].textContent;
    if (locale === "zh-CN") { expect(panel).toContain("完整的空数据库快照"); expect(panel).toContain("源不存在"); expect(panel).toContain("保留之前"); expect(panel).toContain("未覆盖历史"); expect(panel).not.toContain("Complete database snapshot"); expect(panel).toContain("不证明完整"); }
    else { expect(panel).toContain("Complete empty database snapshot"); expect(panel).toContain("Source confirmed absent"); expect(panel).toContain("Previous snapshot preserved"); expect(panel).toContain("Legacy backup"); expect(panel).toContain("not full browser restore"); }
    h.api.sync.historyState.mockResolvedValue({ scope: "history-and-firefox-bookmarks", coverage: "complete", status: "dirty", freshness: "captured", capturedAt: null });
    await h.ab.syncRecheckHistory(); expect(h.elements["sync-history-coverage"].textContent).toContain(locale === "zh-CN" ? "历史有本地改动" : "History has local changes");
  });
});

describe("separate full environment migration consent and write-only passphrase", () => {
  it("keeps legacy status limited, never infers full consent from ordinary/history consent, and never fills secrets from status", async () => {
    const h = harness(); Object.assign(h.status(), { historyConsentAt: 1, includeHistory: true, fullProfilePassphrase: "v2:c3ludGhldGlj", fullProfilePassphraseSet: true });
    await h.ab.loadSyncConfig();
    expect(h.elements["sync-full-profile-consent"].checked).toBe(false); expect(h.elements["sync-full-profile-state"].textContent).toMatch(/limited sync/);
    expect(h.elements["sync-full-profile-passphrase"].value).toBe(""); expect(h.elements["sync-full-profile-passphrase"].placeholder).toMatch(/Saved/);
    await h.ab.syncSave(); expect(h.api.sync.configure).toHaveBeenCalledWith(expect.objectContaining({ includeFullProfile: false, fullProfileConsent: false }));
    expect(h.api.sync.configure.mock.calls[0][0]).not.toHaveProperty("fullProfilePassphrase");
  });

  it("requires a new passphrase and explicit custody, preserves whitespace, and erases the submitted secret after save", async () => {
    const h = harness(); await h.ab.loadSyncConfig();
    const full = h.elements["sync-full-profile-consent"], input = h.elements["sync-full-profile-passphrase"];
    full.checked = true; full.emit("change");
    expect(h.elements["sync-history-consent"].checked).toBe(true); expect(h.elements["sync-include-history"].checked).toBe(true);
    await h.ab.syncSave(); expect(h.api.sync.configure).not.toHaveBeenCalled();
    input.value = "  synthetic migration phrase  "; h.elements["sync-custody-consent"].checked = false;
    await h.ab.syncSave(); expect(h.api.sync.configure).not.toHaveBeenCalled();
    h.elements["sync-custody-consent"].checked = true;
    let sent: any;
    h.api.sync.configure.mockImplementation(async config => {
      sent = structuredClone(config);
      Object.assign(h.status(), { includeFullProfile: true, fullProfileConsentAt: 2, fullProfilePassphraseSet: true, includeHistory: true, historyConsentAt: 2 });
      return result({ operationId: "manual-configure" });
    });
    await h.ab.syncSave();
    expect(sent).toMatchObject({ includeFullProfile: true, fullProfileConsent: true, historyConsent: true, includeHistory: true });
    expect(sent.fullProfilePassphrase === "  synthetic migration phrase  ").toBe(true);
    expect(input.value).toBe(""); expect(h.api.sync.configure.mock.calls[0][0]).not.toHaveProperty("fullProfilePassphrase");
    await h.ab.loadSyncConfig(); expect(input.value).toBe("");
    await h.ab.syncPush(); expect(h.api.sync.push).toHaveBeenCalledWith(expect.objectContaining({ history: true }));
    expect(JSON.stringify(h.api.sync.push.mock.calls)).not.toContain("fullProfilePassphrase");
    await h.ab.syncSave(); expect(sent).not.toHaveProperty("fullProfilePassphrase");
  });

  it("retains a newer typed input across a pending save/status refresh but never resurrects the submitted value", async () => {
    const h = harness(); Object.assign(h.status(), { includeFullProfile: true, fullProfileConsentAt: 1, fullProfilePassphraseSet: true, includeHistory: true, historyConsentAt: 1 });
    await h.ab.loadSyncConfig(); const reply = deferred<any>(); h.api.sync.configure.mockReturnValueOnce(reply.promise);
    const input = h.elements["sync-full-profile-passphrase"]; input.value = "synthetic submitted phrase";
    const pending = h.ab.syncSave(); await flush(); input.value = "synthetic newer phrase";
    await h.ab.loadSyncConfig(); expect(input.value).toBe("synthetic newer phrase");
    reply.resolve(result()); await pending; expect(input.value).toBe("synthetic newer phrase");
    input.value = ""; await h.ab.loadSyncConfig(); expect(input.value).toBe("");
  });

  it("clears the submitted passphrase after an unsuccessful configure and disables full selection on History revocation", async () => {
    const h = harness(); await h.ab.loadSyncConfig();
    h.elements["sync-full-profile-consent"].checked = true; h.elements["sync-full-profile-consent"].emit("change");
    h.elements["sync-full-profile-passphrase"].value = "synthetic migration phrase";
    h.api.sync.configure.mockResolvedValueOnce({ success: false, code: "FULL_PROFILE_ENCRYPTION_REQUIRED", error: "Synthetic encrypted storage refusal" });
    await h.ab.syncSave(); expect(h.elements["sync-full-profile-passphrase"].value).toBe("");
    expect(h.api.sync.configure.mock.calls[0][0]).not.toHaveProperty("fullProfilePassphrase");
    h.elements["sync-history-consent"].checked = false; h.elements["sync-history-consent"].emit("change");
    expect(h.elements["sync-full-profile-consent"].checked).toBe(false); expect(h.elements["sync-include-history"].checked).toBe(false);
    await h.ab.syncSave(); expect(h.api.sync.configure).toHaveBeenLastCalledWith(expect.objectContaining({ historyConsent: false, includeHistory: false, fullProfileConsent: false, includeFullProfile: false }));
  });

  it.each(["en-US", "zh-CN"] as const)("states full scope, passphrase recovery limits and no hardware-passkey portability in %s", locale => {
    const h = harness(locale), tr = (key: string) => h.window.i18n.t(key);
    expect(tr("sync.full-profile.notice")).toMatch(locale === "zh-CN" ? /保存密码.*代理凭据/ : /saved browser passwords.*proxy credentials/);
    expect(tr("sync.full-profile.notice")).toMatch(locale === "zh-CN" ? /不保证免登录.*Passkey 不可迁移/ : /not guaranteed.*passkeys cannot be migrated/);
    expect(tr("sync.full-profile.passphrase-help")).toMatch(locale === "zh-CN" ? /同一口令.*不可恢复.*S3 Secret Key/ : /same passphrase.*cannot be recovered.*S3 Secret Key/);
    expect(HTML).toMatch(/id="sync-full-profile-passphrase" type="password" autocomplete="new-password"/);
  });
});

describe("unsaved full migration scope and passphrase dispatch guards", () => {
  const PHRASE = "  synthetic unsaved migration phrase  ";
  const scenarios = ["enable-full", "disable-full", "new-passphrase"] as const;
  function savedScope(h: ReturnType<typeof harness>, full: boolean) {
    Object.assign(h.status(), { includeFullProfile: full, fullProfileConsentAt: full ? 1 : null,
      fullProfilePassphraseSet: full, includeHistory: full, historyConsentAt: full ? 1 : null });
  }
  async function ready(h: ReturnType<typeof harness>, full: boolean) {
    savedScope(h, full); await h.ab.loadSyncConfig(); await flush(); await h.ab.loadSyncDiff();
  }
  function run(h: ReturnType<typeof harness>, kind: "push" | "pull") { return h.ab[kind === "push" ? "syncPush" : "syncPull"](); }
  function expectSaveFirst(h: ReturnType<typeof harness>, locale: "en-US" | "zh-CN" = "en-US") {
    expect(h.ab.helpers.toast.mock.calls.some((call: any[]) =>
      (locale === "zh-CN" ? /先.*保存|保存.*后/ : /save.*(?:first|before)|(?:first|before).*save/i).test(String(call[0])) &&
      (call[1] === "warning" || call[1] === "error"))).toBe(true);
    expect(JSON.stringify(h.ab.helpers.toast.mock.calls)).not.toContain(PHRASE);
  }
  function expectNoWrites(h: ReturnType<typeof harness>) {
    expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.api.sync.pull).not.toHaveBeenCalled();
    expect(h.api.sync.configure).not.toHaveBeenCalled(); expect(h.api.app.reloadConfig).not.toHaveBeenCalled();
  }
  for (const locale of ["en-US", "zh-CN"] as const) for (const kind of ["push", "pull"] as const) {
    it.each(scenarios)(`${locale} ${kind} keeps the %s draft and requires Save instead of dispatching the old scope or passphrase`, async scenario => {
      const h = harness(locale); await ready(h, scenario !== "enable-full");
      const full = h.elements["sync-full-profile-consent"], input = h.elements["sync-full-profile-passphrase"];
      if (scenario === "new-passphrase") { input.value = PHRASE; input.emit("input"); }
      else { full.checked = scenario === "enable-full"; full.emit("change"); }
      h.entries()[0].value = "remote";
      const entries = h.entries().slice(), draft = { full: full.checked, phrase: input.value,
        history: h.elements["sync-include-history"].checked, historyConsent: h.elements["sync-history-consent"].checked };
      const reads = { preview: h.api.sync.preview.mock.calls.length, diff: h.api.sync.previewDiff.mock.calls.length };
      await run(h, kind); await flush();
      expectNoWrites(h); expectSaveFirst(h, locale);
      expect({ full: full.checked, phrase: input.value, history: h.elements["sync-include-history"].checked,
        historyConsent: h.elements["sync-history-consent"].checked }).toEqual(draft);
      expect(h.entries()).toEqual(entries); expect(h.entries()[0].value).toBe("remote");
      expect(h.api.sync.preview).toHaveBeenCalledTimes(reads.preview); expect(h.api.sync.previewDiff).toHaveBeenCalledTimes(reads.diff);
      expect(h.ab.confirmAsync).not.toHaveBeenCalled();
      expect(h.buttons.syncPush.disabled).toBe(false); expect(h.buttons.syncPull.disabled).toBe(false); expect(h.buttons.syncSave.disabled).toBe(false);
    });
  }
  for (const kind of ["push", "pull"] as const) {
    it.each([false, true])(`${kind} keeps the ordinary unchanged saved full=%s flow without auto-save or scope expansion`, async full => {
      const h = harness(); await ready(h, full); await run(h, kind); await flush();
      expect(h.api.sync[kind]).toHaveBeenCalledTimes(1); expect(h.api.sync.configure).not.toHaveBeenCalled();
      const opts = h.api.sync[kind].mock.calls[0][0]; expect(opts.comparisonToken).toEqual(TOKEN_A); expect(opts.history).toBe(full);
      expect(opts).not.toHaveProperty("fullProfileConsent"); expect(opts).not.toHaveProperty("fullProfilePassphrase");
      expect(h.elements["sync-full-profile-consent"].checked).toBe(full);
      if (kind === "pull") expect(opts.strategy).toBe(full ? "remote" : "local");
    });
    it.each([false, true])(`${kind} resumes only after successful Save and a fresh comparison using the actually saved full=%s scope`, async full => {
      const h = harness(); await ready(h, !full);
      h.elements["sync-full-profile-consent"].checked = full; h.elements["sync-full-profile-consent"].emit("change");
      if (full) h.elements["sync-full-profile-passphrase"].value = PHRASE;
      await run(h, kind); await flush(); expectNoWrites(h);
      let submitted: any;
      h.api.sync.configure.mockImplementationOnce(async config => {
        submitted = structuredClone(config);
        Object.assign(h.status(), { includeFullProfile: config.includeFullProfile, fullProfileConsentAt: config.fullProfileConsent ? 2 : null,
          fullProfilePassphraseSet: full, includeHistory: config.includeHistory, historyConsentAt: config.historyConsent ? 2 : null });
        return result({ operationId: "manual-configure" });
      });
      await h.ab.syncSave(); await flush();
      expect(h.api.sync.configure).toHaveBeenCalledTimes(1); expect(submitted.includeFullProfile).toBe(full);
      expect(submitted.fullProfileConsent).toBe(full);
      if (full) expect(submitted.fullProfilePassphrase).toBe(PHRASE);
      expect(h.elements["sync-full-profile-passphrase"].value).toBe("");
      expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.api.sync.pull).not.toHaveBeenCalled();
      h.api.sync.previewDiff.mockResolvedValue(comparison(TOKEN_B)); await h.ab.loadSyncDiff();
      await run(h, kind); await flush();
      expect(h.api.sync[kind]).toHaveBeenCalledTimes(1);
      expect(h.api.sync[kind].mock.calls[0][0]).toMatchObject({ comparisonToken: TOKEN_B, history: submitted.includeHistory });
      if (kind === "pull") expect(h.api.sync.pull.mock.calls[0][0].strategy).toBe(full ? "remote" : "local");
      expect(JSON.stringify([h.api.sync.push.mock.calls, h.api.sync.pull.mock.calls])).not.toContain(PHRASE);
      expect(h.api.sync.configure).toHaveBeenCalledTimes(1);
    });
    it(`${kind} accepts a replacement passphrase only via explicit successful Save, never through Push/Pull options`, async () => {
      const h = harness(); await ready(h, true);
      const input = h.elements["sync-full-profile-passphrase"]; input.value = PHRASE; input.emit("input");
      await run(h, kind); await flush(); expectNoWrites(h); expect(input.value).toBe(PHRASE);
      let submitted: any;
      h.api.sync.configure.mockImplementationOnce(async config => {
        submitted = structuredClone(config); h.status().fullProfilePassphraseSet = true;
        return result({ operationId: "manual-configure" });
      });
      await h.ab.syncSave(); await flush(); expect(submitted.fullProfilePassphrase).toBe(PHRASE); expect(input.value).toBe("");
      expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.api.sync.pull).not.toHaveBeenCalled();
      h.api.sync.previewDiff.mockResolvedValue(comparison(TOKEN_B)); await h.ab.loadSyncDiff(); await run(h, kind); await flush();
      expect(h.api.sync[kind]).toHaveBeenCalledTimes(1); expect(h.api.sync[kind].mock.calls[0][0].comparisonToken).toEqual(TOKEN_B);
      expect(JSON.stringify([h.api.sync.push.mock.calls, h.api.sync.pull.mock.calls])).not.toContain(PHRASE);
    });
    it(`${kind} still blocks a newer typed passphrase after an older Save succeeds without erasing the new draft`, async () => {
      const h = harness(); await ready(h, true);
      const input = h.elements["sync-full-profile-passphrase"], reply = deferred<any>();
      input.value = "synthetic submitted migration phrase"; h.api.sync.configure.mockReturnValueOnce(reply.promise);
      const save = h.ab.syncSave(); await flush(); input.value = PHRASE; input.emit("input");
      reply.resolve(result({ operationId: "manual-configure" })); await save; await flush();
      expect(input.value).toBe(PHRASE); expect(h.api.sync.configure).toHaveBeenCalledTimes(1);
      await h.ab.loadSyncDiff(); await run(h, kind); await flush();
      expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.api.sync.pull).not.toHaveBeenCalled();
      expect(h.api.sync.configure).toHaveBeenCalledTimes(1); expect(input.value).toBe(PHRASE); expectSaveFirst(h);
    });
    it(`${kind} rechecks unsaved full scope and passphrase changes after awaited preview before dispatch`, async () => {
      const h = harness(); await ready(h, true);
      const reply = deferred<any>(); h.api.sync.preview.mockReturnValueOnce(reply.promise);
      const pending = run(h, kind); await flush();
      h.elements["sync-full-profile-consent"].checked = false; h.elements["sync-full-profile-consent"].emit("change");
      h.elements["sync-full-profile-passphrase"].value = PHRASE; h.elements["sync-full-profile-passphrase"].emit("input");
      reply.resolve({ configured: true, profiles: 1, runningProfiles: [] }); await pending; await flush();
      expectNoWrites(h); expectSaveFirst(h);
      expect(h.elements["sync-full-profile-consent"].checked).toBe(false); expect(h.elements["sync-full-profile-passphrase"].value).toBe(PHRASE);
    });
    it(`${kind} does not treat a pending confirmation as Save consent for a newly changed full scope`, async () => {
      const h = harness(); await ready(h, true);
      if (kind === "push") h.api.sync.previewDiff.mockResolvedValue({ ...comparison(), pushWarnings: ["Synthetic remote removal warning"] });
      else h.setPreview({ configured: true, profiles: 1, runningProfiles: ["profile-a"] });
      const confirmation = deferred<boolean>(); h.ab.confirmAsync.mockReturnValueOnce(confirmation.promise);
      const pending = run(h, kind); await flush(); expect(h.ab.confirmAsync).toHaveBeenCalledTimes(1);
      h.elements["sync-full-profile-consent"].checked = false; h.elements["sync-full-profile-consent"].emit("change");
      confirmation.resolve(true); await pending; await flush();
      expectNoWrites(h); expectSaveFirst(h); expect(h.elements["sync-full-profile-consent"].checked).toBe(false);
    });
  }
});

describe("full migration download defaults and zero-selection receipts", () => {
  it("keeps limited legacy Pull local but defaults configured full migration to remote with inherited per-item choices", async () => {
    const limited = harness(); await limited.ab.loadSyncConfig(); expect(limited.elements["sync-merge-strategy"].value).toBe("local");
    const h = harness(); Object.assign(h.status(), { includeFullProfile: true, fullProfileConsentAt: 1, fullProfilePassphraseSet: true, includeHistory: true, historyConsentAt: 1 });
    await h.ab.loadSyncConfig(); expect(h.elements["sync-merge-strategy"].value).toBe("remote");
    expect(h.elements["sync-full-profile-pull-note"].style.display).toBe(""); expect(h.elements["sync-full-profile-pull-note"].textContent).toMatch(/remote restore.*backup/);
    await h.ab.loadSyncDiff(); expect(h.entries().every(entry => entry.value === "")).toBe(true);
    await h.ab.syncPull(); expect(h.api.sync.pull).toHaveBeenCalledWith(expect.objectContaining({ strategy: "remote", resolutions: {} }));
  });
  it("defaults a newly selected full scope to remote while retaining an explicit local global and explicit remote per-item choice", async () => {
    const h = harness(); await h.ab.loadSyncConfig(); const strategy = h.elements["sync-merge-strategy"], full = h.elements["sync-full-profile-consent"];
    full.checked = true; full.emit("change"); expect(strategy.value).toBe("remote"); expect(h.api.sync.configure).not.toHaveBeenCalled();
    strategy.value = "local"; strategy.emit("change");
    Object.assign(h.status(), { includeFullProfile: true, fullProfileConsentAt: 1, fullProfilePassphraseSet: true });
    await h.ab.loadSyncConfig(); expect(strategy.value).toBe("local");
    full.checked = false; full.emit("change"); full.checked = true; full.emit("change"); expect(strategy.value).toBe("local");
    await h.ab.loadSyncDiff(); const profile = h.entries().find(entry => entry.getAttribute("data-section") === "profiles")!; profile.value = "remote"; profile.emit("change");
    await h.ab.syncPull(); expect(h.api.sync.pull).toHaveBeenCalledWith(expect.objectContaining({ strategy: "local", resolutions: { "profiles:profile-a": "remote" } }));
  });
  it("does not overwrite an explicit local decision made before the first full status response", async () => {
    const h = harness(), reply = deferred<any>(); h.api.sync.status.mockReturnValueOnce(reply.promise);
    const pending = h.ab.loadSyncConfig(); h.elements["sync-merge-strategy"].value = "local"; h.elements["sync-merge-strategy"].emit("change");
    reply.resolve({ ...h.status(), includeFullProfile: true, fullProfileConsentAt: 1, fullProfilePassphraseSet: true }); await pending;
    expect(h.elements["sync-merge-strategy"].value).toBe("local");
  });
  it.each(["en-US", "zh-CN"] as const)("never labels FULL_PROFILE_SELECTION_REQUIRED as complete or success in %s, even with contradictory legacy success flags", async locale => {
    const h = harness(locale); Object.assign(h.status(), { includeFullProfile: true, fullProfileConsentAt: 1, fullProfilePassphraseSet: true });
    await h.ab.loadSyncConfig(); await h.ab.loadSyncDiff();
    h.api.sync.pull.mockResolvedValueOnce(result({ code: "FULL_PROFILE_SELECTION_REQUIRED", success: true, outcome: "complete", localCommit: "none", remoteCommit: "none", items: [] }));
    await h.ab.syncPull(); const html = h.renderedResult();
    expect(html).toContain("health-text-poor"); expect(html).not.toContain("health-text-good");
    expect(html).toContain(h.window.i18n.t("sync.result.outcome.failed")); expect(html).not.toContain(h.window.i18n.t("sync.result.outcome.complete"));
    expect(html).toContain(h.window.i18n.t("sync.full-profile.selection-required"));
    expect(h.ab.helpers.toast.mock.calls.some((call: any[]) => call[1] === "success")).toBe(false);
    expect(h.ab.helpers.toast).toHaveBeenLastCalledWith(h.window.i18n.t("sync.full-profile.selection-required"), "error");
  });
});

describe("Cookie queue guard static bilingual UI receipts", () => {
  const guards = [
    { code: "FULL_PROFILE_COOKIE_QUEUE_PENDING", key: "cookie-queue-pending", en: "Start the profile normally and confirm", zh: "正常启动配置并确认既有 Cookie 已导入" },
    { code: "FULL_PROFILE_COOKIE_QUEUE_UNAVAILABLE", key: "cookie-queue-unavailable", en: "Check and repair the existing queue", zh: "检查并修复既有队列" },
  ];
  for (const locale of ["en-US", "zh-CN"] as const) for (const kind of ["push", "pull"] as const) for (const guard of guards) {
    it(`${locale} ${kind} ${guard.code} renders static instructions in the result DOM and error toast without Cookie values`, async () => {
      const h = harness(locale); Object.assign(h.status(), { includeFullProfile: true, fullProfileConsentAt: 1, fullProfilePassphraseSet: true, includeHistory: true, historyConsentAt: 1 });
      await h.ab.loadSyncConfig();
      const rawCookie = "synthetic-cookie-value-not-for-renderer";
      h.api.sync[kind].mockResolvedValueOnce(result({ success: false, outcome: "failed", code: guard.code, localCommit: "none", remoteCommit: "none", message: rawCookie,
        items: [{ scope: "fullProfile", id: "profile-a", state: "failed", code: guard.code, message: rawCookie }], warnings: [rawCookie] }));
      if (kind === "pull") await h.ab.loadSyncDiff();
      await h.ab[kind === "push" ? "syncPush" : "syncPull"]();
      const panel = h.elements["sync-operation-result"], expected = h.window.i18n.t("sync.full-profile." + guard.key);
      expect(panel.innerHTML.includes(rawCookie)).toBe(false); expect(JSON.stringify(h.ab.helpers.toast.mock.calls).includes(rawCookie)).toBe(false);
      expect(panel.textContent.includes(locale === "zh-CN" ? guard.zh : guard.en)).toBe(true); expect(panel.textContent.includes(expected)).toBe(true);
      expect(panel.innerHTML).toContain("health-text-poor"); expect(panel.innerHTML).not.toContain("health-text-good");
      expect(panel.textContent).toContain(guard.code); expect(h.ab.helpers.toast).toHaveBeenLastCalledWith(expected, "error");
      expect(h.api.sync[kind]).toHaveBeenCalledTimes(1); expect(h.api.sync.configure).not.toHaveBeenCalled();
      if (guard.code === "FULL_PROFILE_COOKIE_QUEUE_PENDING") expect(panel.textContent).toMatch(locale === "zh-CN" ? /再正常停止.*确认浏览器退出.*完整推送／拉取/ : /then stop.*confirmed browser exit.*full push\/pull/);
      else expect(panel.textContent).toMatch(locale === "zh-CN" ? /原数据和队列均保留.*不是空队列.*成功/ : /data and queue are retained.*not an empty queue.*successful/);
    });
  }
});

describe("sync mutation events, cache invalidation and request epochs", () => {
  it.each(["push", "pull", "configure"])("refreshes %s completed outside the renderer without reloadConfig or another write", async (kind) => {
    const h = harness();
    expect(h.api.on).toHaveBeenCalledWith("sync:state-changed", expect.any(Function));
    await h.ab.loadSyncDiff(); h.entries()[0].value = "remote";
    h.emit(event("started", 1, kind));
    expect(h.entries()).toHaveLength(0);
    expect(h.buttons.syncPush.disabled).toBe(true); expect(h.buttons.syncPull.disabled).toBe(true); expect(h.buttons.syncSave.disabled).toBe(true);
    expect(h.banner()).toMatch(/progress|running|sync|pull|push|saving/i);
    h.emit(event("completed", 2, kind)); await flush();
    expect(h.ab.invalidateProfilesForSync).toHaveBeenCalled(); expect(h.ab.invalidateAccountsForSync).toHaveBeenCalled();
    for (const loader of [h.ab.loadProfiles, h.ab.loadAccountsTab, h.ab.loadProxies, h.ab.loadExtensionsTab]) expect(loader).toHaveBeenCalled();
    expect(h.order.indexOf("invalidateProfiles")).toBeLessThan(h.order.indexOf("profiles"));
    expect(h.order.indexOf("invalidateAccounts")).toBeLessThan(h.order.indexOf("accounts"));
    expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.api.sync.pull).not.toHaveBeenCalled(); expect(h.api.sync.configure).not.toHaveBeenCalled();
    expect(h.api.app.reloadConfig).not.toHaveBeenCalled(); expect(h.buttons.syncPush.disabled).toBe(false);
  });

  it("drops pre-mutation status, preview and Compare replies instead of resurrecting stale state", async () => {
    const h = harness(), status = deferred<any>(), preview = deferred<any>(), diff = deferred<any>();
    h.api.sync.status.mockReturnValueOnce(status.promise); h.api.sync.preview.mockReturnValueOnce(preview.promise); h.api.sync.previewDiff.mockReturnValueOnce(diff.promise);
    const a = h.ab.loadSyncConfig(), b = h.ab.loadSyncPreview(), c = h.ab.loadSyncDiff();
    h.emit(event("started", 3)); h.emit(event("completed", 4)); await flush();
    status.resolve({ ...h.status(), endpoint: "https://obsolete.example.test", operation: { generation: 0, active: null, last: null } });
    preview.resolve({ configured: true, message: "obsolete preview", runningProfiles: [] }); diff.resolve(comparison(TOKEN_A, "obsolete-profile"));
    await Promise.all([a, b, c]); await flush();
    expect(h.elements["sync-endpoint"].textContent).toBe("https://saved.example.test");
    expect(h.elements["sync-preview-message"].innerHTML).not.toContain("obsolete preview");
    expect(h.elements["sync-diff"].innerHTML).not.toContain("obsolete-profile");
    expect(h.entries()).toHaveLength(0);
  });

  it("ignores stale failures after a mutation instead of toasting an obsolete status error", async () => {
    const h = harness(), old = deferred<any>(); h.api.sync.status.mockReturnValueOnce(old.promise);
    const pending = h.ab.loadSyncConfig(); h.emit(event("started", 1)); h.emit(event("completed", 2)); await flush();
    old.reject(new Error("obsolete status failure")); await pending; await flush();
    expect(h.ab.helpers.toast.mock.calls.some((call: any[]) => String(call[0]).includes("obsolete status failure"))).toBe(false);
  });

  it("uses latest-request ownership for status and preview even without mutation events", async () => {
    const h = harness(), status = deferred<any>(), preview = deferred<any>();
    h.api.sync.status.mockReturnValueOnce(status.promise);
    const olderStatus = h.ab.loadSyncConfig(); await h.ab.loadSyncConfig(); await flush();
    status.resolve({ ...h.status(), endpoint: "https://old.example.test" }); await olderStatus; await flush();
    expect(h.elements["sync-endpoint"].textContent).toBe("https://saved.example.test");
    h.api.sync.preview.mockReturnValueOnce(preview.promise);
    const olderPreview = h.ab.loadSyncPreview(); await h.ab.loadSyncPreview();
    preview.resolve({ configured: true, message: "older preview", runningProfiles: [] }); await olderPreview;
    expect(h.elements["sync-preview-message"].innerHTML).not.toContain("older preview");
  });

  it("hydrates service-owned busy state from status when the started event was missed", async () => {
    const h = harness();
    h.status().operation = { generation: 7, active: { operationId: "rest-owned", kind: "pull", stage: "restoring", startedAt: 1 }, last: null };
    await h.ab.loadSyncConfig(); await flush();
    expect(h.buttons.syncPush.disabled).toBe(true); expect(h.buttons.syncPull.disabled).toBe(true); expect(h.buttons.syncSave.disabled).toBe(true);
    expect(h.banner()).toMatch(/rest-owned|progress|running|pull/i);
    expect(h.buttons.syncPush.querySelector("svg")).not.toBeNull();
  });

  it("does not release a push owner when a result-less configure-completed event invalidates the view", async () => {
    const h = harness(); h.emit(event("started", 1, "push", "owned-push")); await flush();
    const configure = event("completed", 2, "configure", "configuration-change"); delete (configure as any).result;
    h.emit(configure);
    // No enabled-control gap before authoritative status resolves.
    expect(h.buttons.syncPush.disabled).toBe(true); expect(h.buttons.syncPull.disabled).toBe(true);
    await flush(); expect(h.buttons.syncPush.disabled).toBe(true); expect(h.banner()).toMatch(/push|progress/i);
    h.emit(event("completed", 3, "push", "owned-push")); await flush(); expect(h.buttons.syncPush.disabled).toBe(false);
  });

  it("does not resurrect an older operation from late status or reordered duplicate events", async () => {
    const h = harness(), old = deferred<any>(); h.api.sync.status.mockReturnValueOnce(old.promise);
    const pending = h.ab.loadSyncConfig();
    h.emit(event("started", 5, "pull", "old-operation")); h.emit(event("completed", 5, "pull", "old-operation"));
    h.emit(event("started", 6, "push", "new-operation")); await flush();
    old.resolve({ ...h.status(), operation: { generation: 5, active: { operationId: "old-operation", kind: "pull", stage: "running", startedAt: 1 }, last: null } }); await pending; await flush();
    h.emit(event("completed", 5, "pull", "old-operation")); await flush();
    expect(h.buttons.syncPush.disabled).toBe(true); expect(h.banner()).not.toContain("old-operation");
    h.emit(event("completed", 7, "push", "new-operation")); await flush();
    h.emit(event("started", 6, "push", "new-operation")); await flush();
    expect(h.buttons.syncPush.disabled).toBe(false);
  });
});

describe("draft preservation and exact viewed comparison token", () => {
  it("does not overwrite unsaved form fields even when the first status request is still in flight", async () => {
    const h = harness(), pendingStatus = deferred<any>(); h.api.sync.status.mockReturnValueOnce(pendingStatus.promise);
    const pending = h.ab.loadSyncConfig();
    const drafts = { "sync-endpoint-input": "https://draft.example.test", "sync-bucket-input": "draft-bucket", "sync-ak-input": "synthetic draft access", "sync-sk-input": "synthetic draft secret" };
    for (const [id, value] of Object.entries(drafts)) { h.elements[id].value = value; h.elements[id].emit("input"); }
    h.elements["sync-enabled"].checked = false; h.elements["sync-enabled"].emit("change");
    h.elements["sync-custody-consent"].checked = false; h.elements["sync-custody-consent"].emit("change");
    pendingStatus.resolve(h.status()); await pending; await flush();
    for (const [id, value] of Object.entries(drafts)) expect(h.elements[id].value).toBe(value);
    expect(h.elements["sync-enabled"].checked).toBe(false); expect(h.elements["sync-custody-consent"].checked).toBe(false);
    expect(h.elements["sync-endpoint"].textContent).toBe("https://saved.example.test");
  });

  it("keeps a newer unsaved draft while an earlier configuration save completes", async () => {
    const h = harness(), saved = deferred<any>(); await h.ab.loadSyncConfig(); await flush();
    h.elements["sync-endpoint-input"].value = "https://submitted.example.test"; h.elements["sync-endpoint-input"].emit("input");
    h.elements["sync-sk-input"].value = "synthetic submitted secret"; h.elements["sync-sk-input"].emit("input");
    h.api.sync.configure.mockReturnValueOnce(saved.promise);
    const pending = h.ab.syncSave(); await flush();
    h.elements["sync-endpoint-input"].value = "https://later-draft.example.test"; h.elements["sync-endpoint-input"].emit("input");
    h.elements["sync-sk-input"].value = "synthetic later secret"; h.elements["sync-sk-input"].emit("input");
    h.status().endpoint = "https://submitted.example.test";
    h.emit(event("completed", 2, "configure", "manual-configure")); saved.resolve(result({ operationId: "manual-configure" }));
    await pending; await flush();
    expect(h.api.sync.configure).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://submitted.example.test", secretKey: "synthetic submitted secret" }));
    expect(h.elements["sync-endpoint-input"].value).toBe("https://later-draft.example.test"); expect(h.elements["sync-sk-input"].value).toBe("synthetic later secret");
  });

  it("requires a displayed content token instead of silently comparing and applying inherited old choices", async () => {
    const h = harness(); await h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).not.toHaveBeenCalled(); expect(h.api.sync.previewDiff).not.toHaveBeenCalled();
    expect(h.ab.helpers.toast.mock.calls.some((call: any[]) => /compare/i.test(String(call[0])))).toBe(true);
  });

  it("sends the actually viewed token and explicit resolutions once, then invalidates the old choices", async () => {
    const h = harness(), pendingPull = deferred<any>(); await h.ab.loadSyncDiff();
    h.entries()[0].value = "remote"; h.elements["sync-merge-strategy"].value = "newest";
    h.api.sync.previewDiff.mockResolvedValue(comparison(TOKEN_B, "never-viewed-profile")); h.api.sync.pull.mockReturnValueOnce(pendingPull.promise);
    const pending = h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).toHaveBeenCalledWith({ requestId: expect.any(String), strategy: "newest", resolutions: { "profiles:profile-a": "remote" }, comparisonToken: TOKEN_A });
    expect(h.api.sync.previewDiff).toHaveBeenCalledTimes(1); expect(h.entries()).toHaveLength(0);
    pendingPull.resolve(result()); await pending; await flush();
    expect(h.api.app.reloadConfig).not.toHaveBeenCalled();
  });

  it("invalidates selections on configure events and asks for a new Compare rather than borrowing a fresh token", async () => {
    const h = harness(); await h.ab.loadSyncDiff(); h.entries()[0].value = "remote";
    h.emit(event("started", 1, "configure")); h.emit(event("completed", 2, "configure")); await flush();
    await h.ab.syncPull(); await flush();
    expect(h.entries()).toHaveLength(0); expect(h.api.sync.pull).not.toHaveBeenCalled(); expect(h.api.sync.previewDiff).toHaveBeenCalledTimes(1);
  });

  it("does not allow a tokenless legacy diff to authorize a mutation", async () => {
    const h = harness(); h.api.sync.previewDiff.mockResolvedValue(comparison(undefined));
    // An actual missing property, not the fixture's default argument.
    h.api.sync.previewDiff.mockResolvedValue({ ...comparison(), comparisonToken: undefined });
    await h.ab.loadSyncDiff(); await h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).not.toHaveBeenCalled();
    expect(h.ab.helpers.toast.mock.calls.some((call: any[]) => /compare|token/i.test(String(call[0])))).toBe(true);
  });

  it.each(["push", "pull"])("treats SYNC_PREVIEW_STALE from %s as recompare-required, never automatic retry/force", async (kind) => {
    const h = harness(); await h.ab.loadSyncDiff(); h.entries()[0].value = "remote";
    const stale = result({ success: false, code: "SYNC_PREVIEW_STALE", outcome: "failed", localCommit: "none", remoteCommit: "none", message: "content changed" });
    h.api.sync[kind as "push" | "pull"].mockResolvedValueOnce(stale);
    await h.ab[kind === "push" ? "syncPush" : "syncPull"](); await flush();
    expect(h.api.sync[kind as "push" | "pull"]).toHaveBeenCalledTimes(1); expect(h.entries()).toHaveLength(0);
    expect(h.ab.helpers.toast.mock.calls.some((call: any[]) => /compare again|new comparison/i.test(String(call[0])))).toBe(true);
    if (kind === "pull") { await h.ab.syncPull(); await flush(); expect(h.api.sync.pull).toHaveBeenCalledTimes(1); }
  });
});

describe("limited browser-data source and capture-time receipts", () => {
  const CAPTURE = Date.UTC(2020, 0, 2, 3, 4, 5), OLD_CAPTURE = Date.UTC(2019, 1, 3, 4, 5, 6);
  const PUBLICATION = Date.UTC(2024, 2, 4, 5, 6, 7), NOW = Date.UTC(2032, 3, 5, 6, 7, 8);
  const sources = [
    { source: "captured", capturedAt: CAPTURE }, { source: "preserved", capturedAt: OLD_CAPTURE },
    { source: "absent", capturedAt: null }, { source: "unavailable", capturedAt: null }, { source: "unknown", capturedAt: null },
  ] as const;
  const labels = {
    "en-US": { captured: "Freshly captured", preserved: "Previous snapshot preserved", absent: "Source confirmed absent", unavailable: "Source unavailable", unknown: "Source unknown" },
    "zh-CN": { captured: "本次已采集", preserved: "保留之前的快照", absent: "已确认源不存在", unavailable: "源不可用", unknown: "来源未知" },
  };
  function timeTexts(at: number) { const date = new Date(at); return [escape(date.toLocaleString()), date.toISOString()]; }
  function expectNoInventedCapture(body: string) {
    for (const at of [PUBLICATION, NOW]) for (const text of timeTexts(at)) expect(body).not.toContain(text);
  }
  function expectLimitedScope(body: string, locale: "en-US" | "zh-CN") {
    expect(body).toMatch(locale === "zh-CN" ? /有限.*Cookie.*LocalStorage/ : /limited.*Cookie.*LocalStorage/i);
    expect(body).toContain("IndexedDB"); expect(body).toContain("Service Worker");
    expect(body).toMatch(locale === "zh-CN" ? /会话/ : /session/i);
    expect(body).toMatch(locale === "zh-CN" ? /保存密码|保存的密码/ : /saved browser passwords/i);
    expect(body).toMatch(locale === "zh-CN" ? /未覆盖|不包含/ : /not covered|does not cover|excludes/i);
  }
  for (const locale of ["en-US", "zh-CN"] as const) for (const scope of ["cookies", "localStorage"] as const) {
    it.each(sources)(`${locale} ${scope} renders $source provenance and the actual capture time without expanding limited scope`, async ({ source, capturedAt }) => {
      vi.useFakeTimers(); vi.setSystemTime(NOW);
      const h = harness(locale); await h.ab.loadSyncConfig(); await flush(); await h.ab.loadSyncDiff();
      const incomplete = source === "preserved" || source === "unavailable";
      h.api.sync.pull.mockResolvedValueOnce(result({ success: !incomplete, outcome: incomplete ? "partial" : "complete", browserBackupIncomplete: incomplete,
        message: "owned browser-data receipt", items: [{ scope, id: "profile-a",
          state: source === "unavailable" ? "skipped" : source === "absent" ? "preserved" : scope === "cookies" ? "queued" : "applied",
          required: source !== "absent", count: source === "absent" || source === "unavailable" ? 0 : 1,
          ...(source === "preserved" ? { code: scope === "cookies" ? "COOKIE_SOURCE_PRESERVED" : "LOCAL_STORAGE_SOURCE_PRESERVED" } : {}),
          browserData: { version: 1, source, capturedAt, snapshotId: "owned-browser-snapshot", snapshotAt: PUBLICATION } }] }));
      await h.ab.syncPull(); await flush(); const body = h.renderedResult();
      expect(body).toContain(labels[locale][source]); expectLimitedScope(body, locale); expectNoInventedCapture(body);
      if (capturedAt === null) expect(body).toContain(locale === "zh-CN" ? "采集时间未知" : "Capture time unknown");
      else expect(timeTexts(capturedAt).some(text => body.includes(text))).toBe(true);
      if (source === "preserved" || source === "unavailable" || source === "unknown") expect(body).not.toContain("health-text-good");
      expect(h.elements["sync-full-profile-consent"].checked).toBe(false);
      expect(h.api.sync.configure).not.toHaveBeenCalled(); expect(h.api.sync.push).not.toHaveBeenCalled();
      expect(h.api.sync.pull).toHaveBeenCalledTimes(1);
    });
    it(`${locale} legacy ${scope} without provenance remains unknown and never invents capture time from publication or now`, async () => {
      vi.useFakeTimers(); vi.setSystemTime(NOW);
      const h = harness(locale); await h.ab.loadSyncConfig(); await flush(); await h.ab.loadSyncDiff();
      h.api.sync.pull.mockResolvedValueOnce(result({ timestamp: PUBLICATION, message: "owned legacy receipt",
        items: [{ scope, id: "profile-a", state: "applied", count: 1 }] }));
      await h.ab.syncPull(); await flush(); const body = h.renderedResult();
      expect(body).toContain(labels[locale].unknown); expect(body).toContain(locale === "zh-CN" ? "采集时间未知" : "Capture time unknown");
      expectLimitedScope(body, locale); expectNoInventedCapture(body); expect(body).not.toContain("health-text-good");
      expect(h.elements["sync-full-profile-consent"].checked).toBe(false); expect(h.api.sync.configure).not.toHaveBeenCalled();
    });
  }
});

describe("typed result facts and long operation ownership", () => {
  it("labels published configuration with incomplete browser data instead of a completed backup", async () => {
    const h = harness();
    h.api.sync.push.mockResolvedValueOnce(result({ success: false, outcome: "partial", remoteCommit: "committed", browserBackupIncomplete: true }));
    await h.ab.syncPush(); await flush();
    expect(h.renderedResult()).toContain("Configuration published; browser backup incomplete");
    expect(h.renderedResult()).not.toContain("Complete in reported scope");
  });

  it("explains whole-profile stop-required skips and never silently opts into live partial merge", async () => {
    const h = harness();
    h.setPreview({ configured: true, profiles: 1, runningProfiles: ["profile-a"] });
    await h.ab.loadSyncDiff();
    h.api.sync.pull.mockResolvedValueOnce(result({ success: false, outcome: "partial", items: [{ scope: "profiles", id: "profile-a", state: "skipped", code: "PROFILE_STOP_REQUIRED",
      runtimeEffect: { state: "running-or-unconfirmed", action: "skipped-stop-required", stopRequired: true, restartRequired: false, queuedCookies: 0, liveCookiesApplied: 0 } }] }));
    await h.ab.syncPull(); await flush();
    expect(h.ab.confirmAsync.mock.calls.some((call: any[]) => /skip their entire profile data and settings/.test(String(call[0])))).toBe(true);
    expect(h.api.sync.pull.mock.calls[0][0]).not.toHaveProperty("allowRunningPartial");
    expect(h.renderedResult()).toMatch(/wait for browser exit.*pull again/);
    expect(h.renderedResult()).toContain("No profile data or settings were applied");
  });

  it("shows stopped restore next steps and queued Cookies without claiming they were applied", async () => {
    const h = harness(); await h.ab.loadSyncDiff();
    h.api.sync.pull.mockResolvedValueOnce(result({ items: [{ scope: "profiles", id: "profile-a", state: "applied",
      runtimeEffect: { state: "stopped", action: "restored-stopped", stopRequired: false, restartRequired: false, queuedCookies: 2, liveCookiesApplied: 0 } }] }));
    await h.ab.syncPull(); await flush();
    expect(h.renderedResult()).toContain("Start the profile and verify restored data");
    expect(h.renderedResult()).toContain("2 Cookie(s) queued, not yet applied");
    expect(h.renderedResult()).toContain("not a runtime fingerprint pass");
  });

  it("retains explicit live-partial, restart and unknown Cookie-write facts on failure", async () => {
    const h = harness(); await h.ab.loadSyncDiff();
    h.api.sync.pull.mockResolvedValueOnce(result({ success: false, outcome: "partial", localCommit: "unknown", items: [{ scope: "profiles", id: "profile-a", state: "preserved",
      runtimeEffect: { state: "running-or-unconfirmed", action: "running-partial", stopRequired: true, restartRequired: true, queuedCookies: 0, liveCookiesApplied: 0, liveCookiesUnconfirmed: true } }] }));
    await h.ab.syncPull(); await flush();
    expect(h.renderedResult()).toContain("partial live merge was explicitly requested");
    expect(h.renderedResult()).toContain("start a fresh browser");
    expect(h.renderedResult()).toContain("Live Cookie changes are unconfirmed; do not retry automatically");
    expect(h.api.sync.pull).toHaveBeenCalledTimes(1);
  });

  it.each(["partial", "recovery-required", "cancelled"])("renders %s and committed/queued/skipped/unknown facts even when success is false", async (outcome) => {
    const h = harness(); await h.ab.loadSyncDiff();
    const actual = result({ success: false, outcome, localCommit: "partial", remoteCommit: "committed", message: "owned partial fixture",
      items: [{ scope: "cookies", id: "profile-a", state: "queued", count: 2 }, { scope: "preferences", id: "profile-a", state: "skipped" }, { scope: "extensions", id: "ext-a", state: "unknown" }],
      warnings: ["<img src=x onerror=fixture>"], recovery: outcome === "recovery-required" ? [{ resource: "localStorage", id: "profile-a", paths: ["owned/recovery/path"] }] : [] });
    h.api.sync.pull.mockResolvedValueOnce(actual);
    await h.ab.syncPull(); await flush();
    const rendered = h.renderedResult();
    expect(rendered).toMatch(/partial|recovery|cancelled/i); expect(rendered).toMatch(/committed/i);
    expect(rendered).toMatch(/queued/i); expect(rendered).toMatch(/skipped/i); expect(rendered).toMatch(/unknown/i);
    expect(rendered).toContain("&lt;img"); expect(rendered).not.toContain("<img src=x");
    for (const loader of [h.ab.loadProfiles, h.ab.loadAccountsTab, h.ab.loadProxies, h.ab.loadExtensionsTab]) expect(loader).toHaveBeenCalled();
    expect(h.api.app.reloadConfig).not.toHaveBeenCalled();
  });

  it("does not paint queued/skipped/unknown coverage as complete green even for success:true", async () => {
    const h = harness(); await h.ab.loadSyncDiff();
    h.api.sync.pull.mockResolvedValueOnce(result({ items: [{ scope: "cookies", id: "profile-a", state: "queued", count: 1 }] }));
    await h.ab.syncPull(); await flush();
    expect(h.renderedResult()).toMatch(/queued/i);
    expect(h.ab.helpers.toast.mock.calls.some((call: any[]) => call[1] === "warn" || call[1] === "warning")).toBe(true);
  });

  it("keeps local ownership beyond 15 seconds and a completed service event until its write promise settles", async () => {
    vi.useFakeTimers();
    const h = harness(), write = deferred<any>(); await h.ab.loadSyncDiff(); h.api.sync.pull.mockReturnValueOnce(write.promise);
    const pending = h.ab.syncPull(); await flush();
    h.emit(event("started", 1, "pull", "manual-pull")); h.emit(event("completed", 2, "pull", "manual-pull")); await flush();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(h.buttons.syncPush.disabled).toBe(true); expect(h.buttons.syncPull.disabled).toBe(true); expect(h.buttons.syncSave.disabled).toBe(true);
    expect(h.banner()).toMatch(/waiting|progress|running|result/i);
    await h.ab.syncPush(); await flush(); expect(h.api.sync.push).not.toHaveBeenCalled();
    write.resolve(result()); await pending; await flush();
    expect(h.buttons.syncPush.disabled).toBe(false); expect(h.buttons.syncPull.disabled).toBe(false); expect(h.buttons.syncSave.disabled).toBe(false);
    expect(h.api.app.reloadConfig).not.toHaveBeenCalled();
  });

  it("does not hide a newer service operation when an older manual promise finally resolves", async () => {
    const h = harness(), write = deferred<any>(); await h.ab.loadSyncDiff(); h.api.sync.pull.mockReturnValueOnce(write.promise);
    const pending = h.ab.syncPull(); await flush();
    h.emit(event("started", 1, "pull", "manual-pull")); h.emit(event("completed", 2, "pull", "manual-pull"));
    h.emit(event("started", 3, "configure", "new-service-operation")); await flush();
    write.resolve(result()); await pending; await flush();
    expect(h.buttons.syncPush.disabled).toBe(true); expect(h.buttons.syncSave.disabled).toBe(true);
    expect(h.banner()).not.toContain("manual-pull");
  });

  it("shows status.last full facts after a privacy-minimal completion event", async () => {
    const h = harness();
    const full = result({ operationId: "external-pull", success: false, outcome: "partial", items: [{ scope: "cookies", state: "queued", count: 3 }], warnings: ["owned retained snapshot warning"] });
    h.emit(event("completed", 5, "pull", "external-pull"), full); await flush();
    expect(h.renderedResult()).toContain("owned retained snapshot warning"); expect(h.renderedResult()).toMatch(/queued/i);
    expect(h.api.sync.status).toHaveBeenCalled();
  });
});

describe("whole-module proxy and extension read invalidation", () => {
  function proxyModule() {
    const h = harness();
    const proxy = { healthGet: vi.fn(async (): Promise<any> => ({ entries: [], summary: null })), list: vi.fn(async (): Promise<any> => [{ name: "fresh-proxy", config: { type: "http", host: "fixture.example.test", port: 1234 } }]), rotationInfo: vi.fn(async () => null) };
    (h.api as any).proxy = proxy; h.loadModule("proxies");
    return { ...h, proxy };
  }
  function extensionModule() {
    const h = harness();
    const settings = { extensionRepository: vi.fn(async (_filter: string): Promise<any> => [{ id: "fresh-extension", name: "fresh-extension", version: "1", tags: [], source: "local" }]) };
    (h.api as any).settings = settings; h.loadModule("extensions");
    return { ...h, settings };
  }
  it("does not let an older proxy-list reply overwrite a newer list", async () => {
    const h = proxyModule(), old = deferred<any>(); h.proxy.list.mockReturnValueOnce(old.promise);
    h.ab.loadProxies(); await flush(); h.ab.loadProxies(); await flush();
    old.resolve([{ name: "obsolete-proxy", config: { type: "http", host: "old.example.test", port: 4321 } }]); await flush();
    expect(h.elements["proxy-list"].innerHTML).toContain("fresh-proxy"); expect(h.elements["proxy-list"].innerHTML).not.toContain("obsolete-proxy");
  });
  it("invalidates pre-sync proxy health before a late reply can overwrite the shared cache or issue a list read", async () => {
    const h = proxyModule(), old = deferred<any>(); h.proxy.healthGet.mockReturnValueOnce(old.promise);
    h.ab.loadProxies(); await flush();
    if (typeof h.ab.invalidateProxiesForSync === "function") h.ab.invalidateProxiesForSync();
    h.ab.loadProxies(); await flush();
    old.resolve({ entries: [{ proxyName: "obsolete-health" }], summary: { total: 999 } }); await flush();
    expect(JSON.stringify(h.window.__proxyHealth)).not.toContain("obsolete-health"); expect(h.proxy.list).toHaveBeenCalledTimes(1);
    expect(typeof h.ab.invalidateProxiesForSync).toBe("function");
  });
  it("ignores pre-sync proxy errors and leaves open proxy editor drafts untouched", async () => {
    const h = proxyModule(), old = deferred<any>(); h.proxy.list.mockReturnValueOnce(old.promise);
    h.elements["dlg-proxy-host"].value = "unsaved.proxy.test"; h.elements["dlg-proxy-password"].value = "synthetic unsaved password";
    h.ab.loadProxies(); await flush();
    if (typeof h.ab.invalidateProxiesForSync === "function") h.ab.invalidateProxiesForSync();
    h.ab.loadProxies(); await flush(); old.reject(new Error("obsolete proxy-list failure")); await flush();
    expect(h.elements["proxy-list"].innerHTML).toContain("fresh-proxy"); expect(h.elements["proxy-list"].innerHTML).not.toContain("obsolete proxy-list failure");
    expect(h.elements["dlg-proxy-host"].value).toBe("unsaved.proxy.test"); expect(h.elements["dlg-proxy-password"].value).toBe("synthetic unsaved password");
  });
  it("invalidates a pending extension response immediately, before the completion refresh has started", async () => {
    const h = extensionModule(), old = deferred<any>(); h.settings.extensionRepository.mockReturnValueOnce(old.promise);
    h.elements["extension-repo-search"].value = " keep-filter "; h.elements["repo-ext-input"].value = "synthetic unsaved extension";
    h.elements["repo-ext-tags"].value = "unsaved tag"; h.elements["repo-ext-shared"].checked = true;
    h.ab.loadExtensionsTab(); await flush();
    if (typeof h.ab.invalidateExtensionsForSync === "function") h.ab.invalidateExtensionsForSync();
    old.resolve([{ id: "obsolete-extension", name: "obsolete-extension", tags: [], source: "local" }]); await flush();
    expect(h.elements["extension-repo-list"].innerHTML).not.toContain("obsolete-extension");
    expect(h.elements["extension-repo-search"].value).toBe(" keep-filter "); expect(h.elements["repo-ext-input"].value).toBe("synthetic unsaved extension");
    expect(h.elements["repo-ext-tags"].value).toBe("unsaved tag"); expect(h.elements["repo-ext-shared"].checked).toBe(true);
    expect(typeof h.ab.invalidateExtensionsForSync).toBe("function");
  });
  it("does not paint an extension error from before sync, then reloads using the current search", async () => {
    const h = extensionModule(), old = deferred<any>(); h.settings.extensionRepository.mockReturnValueOnce(old.promise);
    h.elements["extension-repo-search"].value = " keep-filter "; h.ab.loadExtensionsTab(); await flush();
    if (typeof h.ab.invalidateExtensionsForSync === "function") h.ab.invalidateExtensionsForSync();
    old.reject(new Error("obsolete extension failure")); await flush();
    expect(h.elements["extension-repo-list"].innerHTML).not.toContain("obsolete extension failure");
    await h.ab.loadExtensionsTab(); await flush();
    expect(h.settings.extensionRepository).toHaveBeenLastCalledWith("keep-filter"); expect(h.elements["extension-repo-list"].innerHTML).toContain("fresh-extension");
  });
});

describe("truthful Compare scope and effective mirrored translations", () => {
  it("shows unverified and not-compared scope instead of a blanket green comparison", async () => {
    const h = harness();
    const diff = comparison(); diff.coverage.unverified = [{ id: "profile-a", reason: "remote-preferences-not-covered" }];
    h.api.sync.previewDiff.mockResolvedValueOnce(diff); await h.ab.loadSyncDiff();
    expect(h.elements["sync-diff-message"].innerHTML).toContain("health-text-watch");
    const body = h.elements["sync-diff"].innerHTML;
    expect(body).toMatch(/unverified|not verified/i); expect(body).toMatch(/live.{0,10}cookies/i);
    expect(body).toMatch(/localStorage|local storage/i); expect(body).toMatch(/full.profile/i);
    expect(h.elements["sync-diff-message"].textContent).not.toBe("Comparison complete");
  });

  it("does not assert complete coverage when a legacy Compare omits evidence", async () => {
    const h = harness(); h.api.sync.previewDiff.mockResolvedValueOnce({ ...comparison(), coverage: undefined });
    await h.ab.loadSyncDiff();
    expect(h.elements["sync-diff-message"].innerHTML).not.toContain("health-text-good");
    expect(h.elements["sync-diff"].innerHTML).toMatch(/unverified|not verified/i);
  });

  it.each(["en-US", "zh-CN"] as const)("describes supported data without claiming an unperformed sync in %s", (locale) => {
    const h = harness(locale);
    for (const key of ["sync.synced-scope", "sync.scope"]) {
      const label = h.window.i18n.t(key, "__MISSING_SCOPE__");
      expect(label, key).toMatch(locale === "zh-CN" ? /^支持同步[：:]/ : /^Supported sync data:/);
      expect(label, key).not.toMatch(/^(已同步[：:]|Synced:)/);
      expect(label, key).toContain("Preferences");
      expect(label, key).toContain("LocalStorage");
      expect(label, key).toMatch(locale === "zh-CN" ? /以操作结果为准/ : /Check the operation result/);
    }
  });

  it("keeps the static supported-scope fallback honest before i18n loads", () => {
    const label = HTML.match(/<p\b[^>]*data-i18n="sync\.synced-scope"[^>]*>([^<]*)<\/p>/)?.[1];
    expect(label).toMatch(/^Supported sync data:/);
    expect(label).not.toMatch(/^Synced:/);
    expect(label).toBe(harness("en-US").window.i18n.t("sync.synced-scope"));
  });

  it.each(["en-US", "zh-CN"] as const)("describes custody of supported data without promising bookmark or full-session backup in %s", (locale) => {
    const label = harness(locale).window.i18n.t("sync.custody", "__MISSING_CUSTODY__");
    expect(label).toContain("Preferences");
    expect(label).toContain("LocalStorage");
    expect(label).not.toMatch(/bookmarks|书签/);
    expect(label).toMatch(locale === "zh-CN" ? /本次采集可用/ : /available for this capture/);
    expect(label).toMatch(locale === "zh-CN" ? /登录会话 Cookie/ : /login-session Cookies/);
  });

  it("keeps the static custody fallback equal to the effective supported-data consent", () => {
    const label = HTML.match(/<span\b[^>]*data-i18n="sync\.custody"[^>]*>([^<]*)<\/span>/)?.[1];
    expect(label).toBe(harness("en-US").window.i18n.t("sync.custody"));
    expect(label).not.toMatch(/bookmarks/);
  });

  it.each(["en-US", "zh-CN"] as const)("keeps the backup reminder advisory instead of asserting backup presence or absence in %s", (locale) => {
    const label = harness(locale).window.i18n.t("backup.hint.title");
    expect(label).toMatch(locale === "zh-CN" ? /独立备份/ : /independent backup/);
    expect(label).not.toMatch(/lives only|only on this machine|仅存于|只在本机|已经备份|Backup completed/i);
  });

  it("keeps the static backup reminder equal to its advisory translation", () => {
    const label = HTML.match(/<span\b[^>]*data-i18n="backup\.hint\.title"[^>]*>([^<]*)<\/span>/)?.[1];
    expect(label).toMatch(/independent backup/);
    expect(label).toBe(harness("en-US").window.i18n.t("backup.hint.title"));
  });

  const keys = [
    ...["checking", "in-progress", "waiting-result", "refreshing", "push", "pull", "configure"].map((suffix) => `sync.operation.${suffix}`),
    ...["preparing", "publishing", "downloading", "verifying", "applying", "finalizing"].map((suffix) => `sync.progress.stage.${suffix}`),
    ...["items", "items-completed", "items-total", "current-item", "current-upload", "current-download", "indeterminate", "rate", "rate-unknown", "transferring", "waiting-response", "object-complete", "elapsed"].map((suffix) => `sync.progress.${suffix}`),
    "sync.full-profile.size-limit",
    ...["scope", "unverified", "coverage-unavailable", "required", "stale"].map((suffix) => `sync.compare.${suffix}`),
    "sync.refresh.failed", "sync.credentials.saved", "sync.result.title", "sync.result.limited", "sync.result.local-commit", "sync.result.remote-commit", "sync.result.unavailable", "sync.result.warnings", "sync.result.recovery",
    ...["complete", "partial", "failed", "cancelled", "recovery-required"].map((suffix) => `sync.result.outcome.${suffix}`),
    ...["none", "committed", "partial", "unknown"].map((suffix) => `sync.result.commit.${suffix}`),
    ...["applied", "uploaded", "queued", "preserved", "skipped", "failed", "unknown"].map((suffix) => `sync.result.item.${suffix}`),
    ...["config", "profiles", "cookies", "localStorage", "preferences", "extensions", "history", "fullProfile", "credentials", "sidecar", "baseline"].map((suffix) => `sync.result.scope.${suffix}`),
    ...["consent", "notice", "passphrase", "passphrase-help", "required", "selected", "limited", "pull-strategy", "selection-required", "cookie-queue-pending", "cookie-queue-unavailable", "unsaved"].map((suffix) => `sync.full-profile.${suffix}`),
    ...["captured", "preserved", "absent", "unavailable", "unknown"].map((suffix) => `sync.browser-data.source.${suffix}`),
    "sync.browser-data.limited", "sync.browser-data.captured-at", "sync.browser-data.capture-unknown",
    "profile.sync.local-changes", "profile.sync.unknown", "profile.sync.baseline-at", "profile.sync.proof-scope", "profile.edit.baseline-changed",
    ...["match", "changed", "none", "legacy", "invalid", "target-changed", "target-unavailable", "preferences-unavailable", "content-unavailable", "unknown"].map((suffix) => `profile.sync.reason.${suffix}`),
    ...["export.title", "export.batch-title", "import.title", "import.batch-title", "filter.backup", "replace.title", "replace.message", "replace.detail", "replace.confirm", "cancel", "pending", "export.warning-count", "batch.warning-count"].map((suffix) => `archive.${suffix}`),
  ];
  it("keeps both full dictionary mirrors byte-identical", () => {
    expect(fs.readFileSync(path.join(ROOT, "i18n.js")).equals(fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js")))).toBe(true);
  });
  it.each(["en-US", "zh-CN"] as const)("resolves new sync state/scope translations after every merge in %s", (locale) => {
    const h = harness(locale), other = harness(locale === "zh-CN" ? "en-US" : "zh-CN");
    const properNames = new Set(["sync.result.scope.cookies", "sync.result.scope.localStorage", "sync.result.scope.preferences"]);
    for (const key of keys) {
      const value = h.window.i18n.t(key, "__MISSING_SYNC_TRANSLATION__"), translated = other.window.i18n.t(key, "__MISSING_SYNC_TRANSLATION__");
      expect(value, key).not.toBe("__MISSING_SYNC_TRANSLATION__");
      if (!properNames.has(key)) expect(value, `${key} must not fall back to the other locale`).not.toBe(translated);
      expect([...value.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort(), `${key} interpolation contract`).toEqual([...translated.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort());
      const occurrences = [...I18N.matchAll(new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\s*:', "g"))];
      expect(occurrences, `${key} must occur once per locale, not shadow itself in another layer`).toHaveLength(2);
    }
  });
});


describe("safe user-owned renderer sync cancellation", () => {
  const cancel = (h: ReturnType<typeof harness>) => h.elements["sync-operation-actions"]?.children.find(node => node.id === "sync-cancel-button");
  async function started(kind: "push" | "pull", locale?: "en-US" | "zh-CN") {
    const h = harness(locale), settle = deferred<any>();
    if (kind === "pull") await h.ab.loadSyncDiff();
    h.api.sync[kind].mockReturnValueOnce(settle.promise);
    const pending = h.ab[kind === "push" ? "syncPush" : "syncPull"](); await flush();
    const requestId = h.api.sync[kind].mock.calls[0][0].requestId;
    return { h, settle, pending, requestId };
  }
  it.each(["push", "pull"] as const)("%s cancel is available during preflight, abandons hung reads and never dispatches their later replies", async kind => {
    const h = harness(), preview = deferred<any>(); if (kind === "pull") await h.ab.loadSyncDiff();
    h.api.sync.preview.mockReturnValueOnce(preview.promise);
    const pending = h.ab[kind === "push" ? "syncPush" : "syncPull"](); await flush();
    expect(cancel(h)?.disabled).toBe(false); cancel(h)!.emit("click");
    await pending; await flush(); expect(h.api.sync[kind]).not.toHaveBeenCalled(); expect(h.api.sync.cancel).not.toHaveBeenCalled();
    expect(h.buttons.syncPush.disabled).toBe(false); expect(cancel(h)).toBeUndefined();
    preview.resolve({ configured: true, runningProfiles: [], message: "obsolete cancelled preflight" }); await flush();
    expect(h.api.sync[kind]).not.toHaveBeenCalled(); expect(h.elements["sync-preview-message"].textContent).not.toContain("obsolete cancelled preflight");
  });
  it("cancel during a confirmation prevents a later accepted dialog from dispatching", async () => {
    const h = harness(), decision = deferred<boolean>();
    h.api.sync.previewDiff.mockResolvedValue({ ...comparison(), pushWarnings: ["Synthetic removal"] }); h.ab.confirmAsync.mockReturnValueOnce(decision.promise);
    const pending = h.ab.syncPush(); await flush(); expect(h.ab.confirmAsync).toHaveBeenCalledTimes(1);
    cancel(h)!.emit("click"); await pending; decision.resolve(true); await flush();
    expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.buttons.syncPull.disabled).toBe(false);
  });
  for (const locale of ["en-US", "zh-CN"] as const) for (const kind of ["push", "pull"] as const) {
    it(`${locale} ${kind} keeps cancel available through every phase and remains cancelling after acknowledgement until service settles`, async () => {
      const { h, settle, pending, requestId } = await started(kind, locale);
      h.emit({ ...event("started", 1, kind, "service-progress"), requestId }); await flush();
      const button = cancel(h)!;
      for (const [i, stage] of ["preparing", "publishing", "downloading", "verifying", "applying", "finalizing"].entries()) {
        h.emitProgress(progressEvent(i + 1, { kind, stage, progress: { sequence: i + 1, updatedAt: 6000 + i } }));
        expect(cancel(h)).toBe(button); expect(button.disabled).toBe(false);
      }
      button.emit("click"); button.emit("click"); await flush();
      expect(h.api.sync.cancel).toHaveBeenCalledExactlyOnceWith({ requestId }); expect(button.disabled).toBe(true);
      expect(h.banner()).toContain(h.window.i18n.t("sync.cancel.cancelling")); expect(h.renderedResult()).toBe("");
      for (const control of [h.buttons.syncPush, h.buttons.syncPull, h.buttons.syncSave]) expect(control.disabled).toBe(true);
      const final = result({ operationId: "service-progress", success: false, outcome: "partial", localCommit: "partial", remoteCommit: "unknown", code: "SYNC_CANCELLED" });
      // Completion can reach the renderer before the invoke reply. Keep the
      // original operation pending even after its service completion event.
      h.emit({ ...event("completed", 2, kind, "service-progress"), result: final }, final); await flush();
      expect(h.buttons.syncPush.disabled).toBe(true); expect(h.banner()).toContain(h.window.i18n.t("sync.cancel.cancelling"));
      settle.resolve(final); await pending; await flush();
      expect(h.buttons.syncPush.disabled).toBe(false); expect(cancel(h)).toBeUndefined();
      expect(h.renderedResult()).toContain(h.window.i18n.t("sync.result.commit.partial"));
      expect(h.renderedResult()).toContain(h.window.i18n.t("sync.result.commit.unknown"));
      expect(h.ab.helpers.toast.mock.calls.some((call: any[]) => call[1] === "success")).toBe(false);
    });
  }
  it("an old button and a late cancel reply cannot cancel or mutate a subsequent operation", async () => {
    const first = await started("push"), oldButton = cancel(first.h)!, ack = deferred<any>();
    first.h.api.sync.cancel.mockReturnValueOnce(ack.promise); oldButton.emit("click"); await flush();
    first.settle.resolve(result({ operationId: "first", success: false, outcome: "cancelled", localCommit: "none", remoteCommit: "none" })); await first.pending;
    const next = deferred<any>(); first.h.api.sync.push.mockReturnValueOnce(next.promise);
    const pending = first.h.ab.syncPush(); await flush(); const newButton = cancel(first.h)!;
    expect(newButton).not.toBe(oldButton); oldButton.emit("click"); await flush(); expect(first.h.api.sync.cancel).toHaveBeenCalledTimes(1);
    ack.reject(new Error("obsolete cancel failure")); await flush(); expect(newButton.disabled).toBe(false);
    expect(first.h.banner()).not.toContain("Cancelling"); expect(first.h.ab.helpers.toast.mock.calls.some((call: any[]) => String(call[0]).includes("Cancellation could not"))).toBe(false);
    newButton.emit("click"); await flush();
    const secondId = first.h.api.sync.push.mock.calls[1][0].requestId;
    expect(secondId).not.toBe(first.requestId); expect(first.h.api.sync.cancel).toHaveBeenLastCalledWith({ requestId: secondId });
    next.resolve(result({ operationId: "second", success: false, outcome: "cancelled" })); await pending;
  });
  it("failed cancellation acknowledgement permits retry but never unlocks the outstanding write", async () => {
    const { h, pending, settle, requestId } = await started("pull");
    h.api.sync.cancel.mockRejectedValueOnce(new Error("synthetic cancel IPC error")); cancel(h)!.emit("click"); await flush();
    expect(h.buttons.syncPush.disabled).toBe(true); expect(cancel(h)?.disabled).toBe(false); expect(h.renderedResult()).toBe("");
    expect(h.ab.helpers.toast).toHaveBeenLastCalledWith(expect.stringContaining("Cancellation could not be confirmed"), "warning");
    cancel(h)!.emit("click"); await flush(); expect(h.api.sync.cancel).toHaveBeenLastCalledWith({ requestId });
    settle.resolve(result({ success: false, outcome: "cancelled", localCommit: "none", remoteCommit: "none" })); await pending;
  });
  it("does not expose cancellation for foreign status-only operations or configuration writes", async () => {
    const h = harness(); h.emit(event("started", 1, "push", "foreign-service")); await flush(); expect(cancel(h)).toBeUndefined();
    expect(h.api.sync.cancel).not.toHaveBeenCalled(); h.emit(event("completed", 2, "push", "foreign-service")); await flush();
    const settle = deferred<any>(); h.api.sync.configure.mockReturnValueOnce(settle.promise);
    const pending = h.ab.syncSave(); await flush(); expect(cancel(h)).toBeUndefined(); settle.resolve(result()); await pending;
  });
  it("a force retry gets a new capability and ignores clicks on the prior invocation's button", async () => {
    const h = harness(), first = deferred<any>(), second = deferred<any>(), confirmation = deferred<boolean>();
    h.api.sync.push.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.ab.confirmAsync.mockReturnValueOnce(confirmation.promise);
    const pending = h.ab.syncPush(); await flush(); const oldButton = cancel(h)!;
    first.resolve({ success: false, message: "locked by another device" }); await flush();
    expect(h.ab.confirmAsync).toHaveBeenCalledTimes(1); confirmation.resolve(true); await flush();
    expect(h.api.sync.push).toHaveBeenCalledTimes(2);
    const [firstId, secondId] = h.api.sync.push.mock.calls.map((call: any[]) => call[0].requestId);
    expect(secondId).not.toBe(firstId); expect(cancel(h)).not.toBe(oldButton);
    oldButton.emit("click"); await flush(); expect(h.api.sync.cancel).not.toHaveBeenCalled();
    cancel(h)!.emit("click"); await flush(); expect(h.api.sync.cancel).toHaveBeenCalledExactlyOnceWith({ requestId: secondId });
    second.resolve(result({ success: false, outcome: "cancelled" })); await pending;
  });
  it("uncertain cancellation acknowledgement never opens a force retry or claims a cancelled result", async () => {
    const { h, pending, settle } = await started("push");
    h.api.sync.cancel.mockResolvedValueOnce({ success: false, code: "SYNC_CANCEL_NOT_OWNED" });
    cancel(h)!.emit("click"); await flush();
    settle.resolve({ success: false, message: "locked by another device" }); await pending;
    expect(h.ab.confirmAsync).not.toHaveBeenCalled(); expect(h.api.sync.push).toHaveBeenCalledTimes(1);
    expect(h.renderedResult()).not.toContain("Cancelled");
  });
  it("a rejected operation after cancellation reports unknown commits rather than fabricated safe rollback", async () => {
    const { h, pending, settle } = await started("push"); cancel(h)!.emit("click"); await flush();
    settle.reject(new Error("Synthetic lost result")); await pending;
    expect(h.renderedResult()).toContain("SYNC_RESULT_UNAVAILABLE"); expect(h.renderedResult()).toContain("Unknown");
    expect(h.renderedResult()).not.toContain("Cancelled");
    expect(h.ab.helpers.toast.mock.calls.some((call: any[]) => call[1] === "success")).toBe(false);
  });

  it("does not infer same-kind event ownership while a request awaits its reply", async () => {
    const { h, pending, settle, requestId } = await started("push");
    h.emit(event("started", 1, "push", "foreign-operation")); h.emit(event("completed", 2, "push", "foreign-operation")); await flush();
    expect(h.banner()).not.toContain("Waiting for the operation result"); expect(h.buttons.syncPush.disabled).toBe(true);
    cancel(h)!.emit("click"); await flush(); expect(h.api.sync.cancel).toHaveBeenCalledWith({ requestId });
    settle.resolve(result()); await pending;
  });
  it("recovers exact request ownership from status when the start event was missed", async () => {
    const { h, pending, settle, requestId } = await started("push");
    h.status().operation = { generation: 1, active: { operationId: "owned-status", requestId, kind: "push", stage: "preparing" }, last: null };
    await h.ab.loadSyncConfig(); h.emit(event("completed", 2, "push", "owned-status")); await flush();
    expect(h.banner()).toContain("Waiting for the operation result"); expect(h.buttons.syncPush.disabled).toBe(true);
    h.status().operation = { generation: 2, active: null, last: null }; settle.resolve(result()); await pending;
  });
  it.each(["en-US", "zh-CN"] as const)("renders local phases separately from network/commit progress (%s)", async locale => {
    const { h, pending, settle, requestId } = await started("push", locale);
    h.emit({ ...event("started", 1, "push", "owned-operation"), requestId });
    const phases = ["scanning", "reading-archive", "verifying-source", "verifying-profile", "verifying-extras", "packing", "encrypting", "decrypting", "extracting"];
    for (let i = 0; i < phases.length; i++) {
      const fixture = progressEvent(i + 1, { operationId: "owned-operation" }) as any;
      fixture.progress.local = { phase: phases[i], bytes: 524288, items: 2, totalBytes: 1048576, totalItems: 4 };
      h.emitProgress(fixture); await flush();
      expect(h.banner()).toContain(locale === "en-US" ? "Local work" : "本地处理"); expect(h.banner()).toContain("512 KiB / 1 MiB");
      expect(h.banner()).toContain("2 / 4"); expect(h.banner()).not.toContain("/s");
      expect(h.banner()).toContain(locale === "en-US" ? "Bytes processed:" : "已处理数据量：");
      if (phases[i] === "packing") expect(h.banner()).toContain(locale === "en-US" ? "this is not archive size" : "不是归档大小");
      expect(h.banner()).toContain(locale === "en-US" ? "not upload progress or publication confirmation" : "不代表上传进度或发布确认");
      expect(h.banner()).not.toContain("sync.progress."); expect(cancel(h)?.disabled).toBe(false);
    }
    cancel(h)!.emit("click"); await flush(); expect(h.banner()).toContain(locale === "en-US" ? "Cancelling" : "正在取消");
    h.emit(event("completed", 2, "push", "owned-operation")); settle.resolve(result({ success: false, outcome: "cancelled" })); await pending;
  });
  it("ignores malformed local counters and stale phase events without inventing totals", async () => {
    const { h, pending, settle, requestId } = await started("push"); h.emit({ ...event("started", 1, "push", "owned-operation"), requestId });
    const phase = (sequence: number, local: any) => ({ ...progressEvent(sequence, { operationId: "owned-operation" }), progress: { sequence, updatedAt: 11000, local } });
    h.emitProgress(phase(1, { phase: "packing", bytes: 2048, items: 2, totalBytes: 1, totalItems: 1 }));
    expect(h.banner()).toContain("Packing profile"); expect(h.banner()).toContain("2 KiB"); expect(h.banner()).not.toContain("2 / 1");
    const valid = h.banner(); h.emitProgress(phase(0, { phase: "scanning", bytes: 0, items: 0 })); expect(h.banner()).toBe(valid);
    h.emitProgress(phase(2, { phase: "packing", bytes: -1, items: 2 })); expect(h.banner()).not.toContain("Local work"); expect(h.banner()).not.toContain("NaN");
    h.emit(event("completed", 2, "push", "owned-operation")); settle.resolve(result()); await pending;
  });

  it("a foreign start during preflight invalidates dispatch without exposing foreign cancellation", async () => {
    const h = harness(), preview = deferred<any>(); h.api.sync.preview.mockReturnValueOnce(preview.promise);
    const pending = h.ab.syncPush(); await flush(); h.emit(event("started", 1, "push", "foreign-preflight")); await flush();
    preview.resolve({ configured: true, runningProfiles: [] }); await pending;
    expect(h.api.sync.push).not.toHaveBeenCalled(); expect(cancel(h)).toBeUndefined(); expect(h.buttons.syncPush.disabled).toBe(true);
    expect(h.api.sync.cancel).not.toHaveBeenCalled(); h.emit(event("completed", 2, "push", "foreign-preflight")); await flush();
  });

});
