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
afterEach(() => vi.useRealTimers());

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
    expect(h.api.sync.pull).toHaveBeenCalledWith({ strategy: "newest", resolutions: { "profiles:profile-a": "remote" }, comparisonToken: TOKEN_A });
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
    ...["scope", "unverified", "coverage-unavailable", "required", "stale"].map((suffix) => `sync.compare.${suffix}`),
    "sync.refresh.failed", "sync.credentials.saved", "sync.result.title", "sync.result.limited", "sync.result.local-commit", "sync.result.remote-commit", "sync.result.unavailable", "sync.result.warnings", "sync.result.recovery",
    ...["complete", "partial", "failed", "cancelled", "recovery-required"].map((suffix) => `sync.result.outcome.${suffix}`),
    ...["none", "committed", "partial", "unknown"].map((suffix) => `sync.result.commit.${suffix}`),
    ...["applied", "uploaded", "queued", "preserved", "skipped", "failed", "unknown"].map((suffix) => `sync.result.item.${suffix}`),
    ...["config", "profiles", "cookies", "localStorage", "preferences", "extensions", "sidecar", "baseline"].map((suffix) => `sync.result.scope.${suffix}`),
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
