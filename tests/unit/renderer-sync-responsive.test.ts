// Actual sync renderer, preload and IPC in exclusively owned VM fixtures.
// Synthetic promises model abort/cleanup/commit boundaries. No real app, browser,
// profiles, configuration writes, sockets, cloud, credentials, or global fixtures.
// The control DOM verifies state/events, not CSS hit-testing or native focus.
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const RENDERER = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/sync.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const PRELOAD = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf8");
const IPC = ts.transpileModule(fs.readFileSync(path.join(ROOT, "src/main/ipc/sync.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const A = "synthetic-owned-read-a-0001", B = "synthetic-owned-read-b-0002", C = "synthetic-owned-write-c-0003";
const TOKEN = { targetId: "synthetic-target", localHash: "synthetic-local", remoteHash: "synthetic-remote" };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 180; i++) await Promise.resolve(); }
const preview = (overrides: any = {}) => ({ configured: true, profiles: 2, runningProfiles: [], proxies: 0, accounts: 0, extensions: 0, message: "Synthetic preview", ...overrides });
const section = (name = "Synthetic saved profile") => ({ localCount: 1, remoteCount: 1, same: [], changed: [{ id: name, fields: ["name"] }], localOnly: [], remoteOnly: [] });
const comparison = (overrides: any = {}) => ({ ok: true, firstPush: true, comparisonToken: TOKEN, profiles: section(), proxies: section(), accounts: section(), extensions: section(),
  artifacts: {}, pushWarnings: [], pullNotes: [], coverage: { compared: [], notCompared: [], unverified: [] }, ...overrides });
const receipt = (overrides: any = {}) => ({ success: false, message: "Synthetic settled operation", operationId: "synthetic-write", outcome: "partial", localCommit: "partial", remoteCommit: "unknown", items: [], warnings: [], recovery: [], ...overrides });
const state = (phase: string, generation: number, operationId = "synthetic-write") => ({ phase, generation, operationId, kind: "push" });

function ipcFixture() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const subscribers = new Map<string, (payload: any) => void>(), windows: any[] = [];
  const emit = (channel: string, payload: any) => subscribers.get(channel)?.(payload);
  const status: any = { enabled: true, configured: true, endpoint: "https://synthetic.invalid", bucket: "synthetic-bucket", custodyConsentAt: 1,
    includeFullProfile: false, fullProfileConsentAt: 0, fullProfilePassphraseSet: false, includeHistory: false, historyConsentAt: 0,
    operation: { generation: 0, active: null, last: null } };
  const service = { preview: vi.fn((_signal?: AbortSignal): any => preview()), previewAsync: vi.fn(async (_signal?: AbortSignal): Promise<any> => preview()),
    previewDiff: vi.fn(async (_signal?: AbortSignal): Promise<any> => comparison()), historyState: vi.fn(async (_id: string, _signal?: AbortSignal): Promise<any> => ({ status: "synced", reason: "synthetic-match" })),
    push: vi.fn(async (..._args: any[]): Promise<any> => receipt()), pull: vi.fn(async (..._args: any[]): Promise<any> => receipt()), getStatus: vi.fn(() => structuredClone(status)) };
  const forbidden = (name: string): never => { throw new Error("Forbidden fixture import or write: " + name); };
  const module = { exports: {} as any };
  vm.runInNewContext(`(function(require, module, exports) { ${IPC}\n})`, { AbortController, console })(
    (name: string) => name === "electron" ? { ipcMain: { handle: (channel: string, callback: any) => handlers.set(channel, callback) }, BrowserWindow: { getAllWindows: () => windows } }
      : name === "../services/sync-service.js" ? { syncService: service }
        : name === "../services/config-manager.js" ? { setSyncConfig: () => forbidden("configuration mutation") }
          : name === "../services/team.js" ? { requireSettingsMutation: () => ({ ok: true }) }
            : name === "../services/event-bus.js" ? { onEvent: (channel: string, callback: (payload: any) => void) => { subscribers.set(channel, callback); return () => subscribers.delete(channel); } } : forbidden(name), module, module.exports);
  module.exports.registerSyncHandlers();
  function renderer(sender: any = {}, frame: any = { routingId: 1, detached: false }) {
    const listeners = new Map<string, (...args: any[]) => void>();
    sender.mainFrame ??= frame; sender.isDestroyed ??= () => false;
    sender.send ??= vi.fn((channel: string, payload: any) => listeners.get(channel)?.(undefined, structuredClone(payload)));
    if (!windows.some(w => w.webContents === sender)) windows.push({ isDestroyed: () => false, webContents: sender });
    let api: any;
    const invoke = vi.fn(async (channel: string, ...args: any[]) => {
      const handler = handlers.get(channel);
      if (!handler) return forbidden(channel);
      return structuredClone(await handler({ sender, senderFrame: frame }, ...structuredClone(args)));
    });
    vm.runInNewContext(PRELOAD, { require: (name: string) => name === "electron" ? {
      contextBridge: { exposeInMainWorld: (_name: string, value: any) => { api = value; } },
      ipcRenderer: { invoke, on: (channel: string, listener: any) => listeners.set(channel, listener), removeListener: (channel: string) => listeners.delete(channel) },
    } : forbidden(name) });
    return { api, invoke, sender, frame };
  }
  return { service, renderer, emit, handlers, status };
}
const readKinds = ["preview", "previewDiff", "historyState"] as const;
type ReadKind = typeof readKinds[number];
function read(api: any, kind: ReadKind, requestId?: string) {
  const opts = requestId === undefined ? undefined : { requestId };
  return kind === "historyState" ? api.sync.historyState("synthetic-profile", opts) : api.sync[kind](opts);
}
function mockRead(h: ReturnType<typeof ipcFixture>, kind: ReadKind, promise: Promise<any>) {
  const selected = kind === "preview" ? h.service.previewAsync : h.service[kind];
  const index = selected.mock.calls.length;
  selected.mockReturnValueOnce(promise);
  return () => selected.mock.calls[index][kind === "historyState" ? 1 : 0] as AbortSignal;
}

describe("owned read IPC cancellation and actual cleanup settlement", () => {
  it.each(readKinds)("%s keeps its capability until the ORIGINAL read settles, without claiming a write receipt", async kind => {
    const h = ipcFixture(), owner = h.renderer(), cleanup = deferred<any>();
    const signal = mockRead(h, kind, cleanup.promise);
    let settled = false;
    const pending = read(owner.api, kind, A).then(value => { settled = true; return value; });
    expect(signal()).toBeInstanceOf(AbortSignal); expect(signal().aborted).toBe(false);
    expect(await owner.api.sync.cancel({ requestId: A })).toMatchObject({ success: true, state: "cancelling" });
    await flush(); expect(signal().aborted).toBe(true); expect(settled).toBe(false);
    expect(await owner.api.sync.cancel({ requestId: A })).toMatchObject({ success: true });
    expect(await read(owner.api, kind, A)).toMatchObject({ code: "SYNC_REQUEST_REUSED", ok: false });
    expect(h.service.push).not.toHaveBeenCalled(); expect(h.service.pull).not.toHaveBeenCalled();
    cleanup.resolve({ ok: true, status: "synced", message: "Stale read after cancellation" });
    const final = await pending;
    expect(final).toMatchObject({ success: false, ok: false, cancelled: true, code: "SYNC_READ_CANCELLED" });
    for (const key of ["outcome", "localCommit", "remoteCommit", "operationId", "items"]) expect(final).not.toHaveProperty(key);
    expect(await owner.api.sync.cancel({ requestId: A })).toMatchObject({ success: false, code: "SYNC_CANCEL_NOT_OWNED" });
    expect(await owner.api.sync.push({ requestId: A })).toMatchObject({ code: "SYNC_REQUEST_REUSED" });
  });

  it.each(readKinds)("%s cannot be cancelled by another sender, another frame, a detached document or guessed operation ID", async kind => {
    const h = ipcFixture(), owner = h.renderer(), foreign = h.renderer(), otherFrame = h.renderer(owner.sender, { routingId: 2 });
    const cleanup = deferred<any>(), signal = mockRead(h, kind, cleanup.promise), pending = read(owner.api, kind, A);
    for (const renderer of [foreign, otherFrame]) expect(await renderer.api.sync.cancel({ requestId: A })).toMatchObject({ code: "SYNC_CANCEL_NOT_OWNED" });
    expect(await owner.api.sync.cancel({ requestId: B, operationId: "synthetic-write" })).toMatchObject({ code: "SYNC_CANCEL_NOT_OWNED" });
    owner.frame.detached = true;
    expect(await owner.api.sync.cancel({ requestId: A })).toMatchObject({ code: "SYNC_CANCEL_NOT_OWNED" });
    owner.frame.detached = false; owner.sender.isDestroyed = () => true;
    expect(await owner.api.sync.cancel({ requestId: A })).toMatchObject({ code: "SYNC_CANCEL_NOT_OWNED" });
    expect(signal().aborted).toBe(false); // Navigation/destruction is not automatic cancellation.
    owner.sender.isDestroyed = () => false;
    cleanup.resolve({ marker: "uncancelled-owned-result" }); expect(await pending).toEqual({ marker: "uncancelled-owned-result" });
  });

  it("keeps read cancellation separate from a same-sender write lease and exact operation ownership", async () => {
    const h = ipcFixture(), owner = h.renderer(), writeCleanup = deferred<any>(), readCleanup = deferred<any>();
    h.service.push.mockImplementationOnce((signal: AbortSignal) => {
      h.status.operation = { generation: 1, active: { operationId: "synthetic-write", kind: "push" }, last: null };
      h.emit("sync:state-changed", state("started", 1)); return writeCleanup.promise;
    });
    const write = owner.api.sync.push({ requestId: C }), writeSignal = h.service.push.mock.calls[0][0];
    const readSignal = mockRead(h, "historyState", readCleanup.promise), pending = read(owner.api, "historyState", A);
    expect((await owner.api.sync.status()).operation.active.requestId).toBe(C);
    expect(await owner.api.sync.cancel({ requestId: A })).toMatchObject({ success: true });
    expect(readSignal().aborted).toBe(true); expect(writeSignal.aborted).toBe(false);
    expect((await owner.api.sync.status()).operation.active.requestId).toBe(C);
    readCleanup.resolve({ status: "synced" }); expect((await pending).code).toBe("SYNC_READ_CANCELLED");
    expect((await owner.api.sync.cancel({ requestId: C })).success).toBe(true); expect(writeSignal.aborted).toBe(true);
    writeCleanup.resolve(receipt()); expect(await write).toMatchObject({ localCommit: "partial", remoteCommit: "unknown" });
  });

  it("never correlates a foreign write start/status with a read's request ID", async () => {
    const h = ipcFixture(), owner = h.renderer(), cleanup = deferred<any>();
    h.service.previewAsync.mockImplementationOnce(() => {
      h.emit("sync:state-changed", state("started", 1, "foreign-write")); return cleanup.promise;
    });
    const pending = read(owner.api, "preview", A);
    expect(owner.sender.send.mock.lastCall[1]).not.toHaveProperty("requestId");
    h.status.operation = { generation: 1, active: { operationId: "foreign-write", kind: "push" }, last: null };
    expect((await owner.api.sync.status()).operation.active).not.toHaveProperty("requestId");
    cleanup.resolve(preview()); await pending;
  });

  it("preserves legacy read results, passes no signal without a request ID, and rejects invalid IDs before invoking", async () => {
    const h = ipcFixture(), owner = h.renderer();
    expect(await read(owner.api, "preview")).toEqual(preview()); expect(h.service.previewAsync).toHaveBeenLastCalledWith(undefined);
    expect(await read(owner.api, "previewDiff")).toEqual(comparison()); expect(h.service.previewDiff).toHaveBeenLastCalledWith(undefined);
    await read(owner.api, "historyState"); expect(h.service.historyState).toHaveBeenLastCalledWith("synthetic-profile", undefined);
    for (const kind of readKinds) expect(await read(owner.api, kind, "bad")).toMatchObject({ code: "INVALID_SYNC_REQUEST", ok: false });
    expect(h.service.previewAsync).toHaveBeenCalledTimes(1); expect(h.service.previewDiff).toHaveBeenCalledTimes(1); expect(h.service.historyState).toHaveBeenCalledTimes(1);
    expect(h.service.preview).not.toHaveBeenCalled();
  });

  it("cleans up both thrown and rejected reads, but converts an aborted read only AFTER its rejection/cleanup", async () => {
    const h = ipcFixture(), owner = h.renderer(), cleanup = deferred<any>();
    h.service.previewAsync.mockImplementationOnce(() => { throw new Error("Synthetic synchronous read failure"); });
    await expect(read(owner.api, "preview", A)).rejects.toThrow("Synthetic synchronous read failure");
    expect((await owner.api.sync.cancel({ requestId: A })).code).toBe("SYNC_CANCEL_NOT_OWNED");
    mockRead(h, "historyState", cleanup.promise); let settled = false;
    const pending = read(owner.api, "historyState", B).then(value => { settled = true; return value; });
    await owner.api.sync.cancel({ requestId: B }); await flush(); expect(settled).toBe(false);
    cleanup.reject(new Error("Synthetic abort after resource cleanup"));
    expect(await pending).toMatchObject({ code: "SYNC_READ_CANCELLED" });
    expect((await owner.api.sync.cancel({ requestId: B })).code).toBe("SYNC_CANCEL_NOT_OWNED");
  });

  it("keeps replay protection sender-wide across frames/kinds, without conflating two senders' equal IDs", async () => {
    const h = ipcFixture(), owner = h.renderer(), second = h.renderer(), frame = h.renderer(owner.sender, { routingId: 2 });
    const a = deferred<any>(), b = deferred<any>(); h.service.previewAsync.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = read(owner.api, "preview", A), other = read(second.api, "preview", A);
    expect(await read(frame.api, "historyState", A)).toMatchObject({ code: "SYNC_REQUEST_REUSED" });
    await owner.api.sync.cancel({ requestId: A });
    expect(h.service.previewAsync.mock.calls[0][0]!.aborted).toBe(true); expect(h.service.previewAsync.mock.calls[1][0]!.aborted).toBe(false);
    a.resolve(preview()); b.resolve(preview()); expect((await first).code).toBe("SYNC_READ_CANCELLED"); expect(await other).toEqual(preview());
  });
});

const escape = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
class Control {
  nodeType = 1; tagName = "DIV"; attrs: Record<string, string> = {}; style: Record<string, string> = {};
  value = ""; checked = false; disabled = false; placeholder = ""; open = false; parentNode: Control | null = null;
  childNodes: any[] = []; html = ""; text = ""; handlers = new Map<string, Array<(event: any) => void>>();
  register: ((node: Control) => void) | null = null;
  get id() { return this.attrs.id || ""; } set id(value: string) { this.attrs.id = value; this.register?.(this); }
  get className() { return this.attrs.class || ""; } set className(value: string) { this.attrs.class = value; }
  get children(): Control[] { return this.childNodes.filter(node => node.nodeType === 1); }
  get innerHTML(): string { return this.html || this.childNodes.map(node => node.nodeType === 3 ? escape(node.textContent) : node.innerHTML || node.textContent || "").join("") || escape(this.text); }
  set innerHTML(value: string) {
    this.html = value; this.text = ""; this.childNodes = [];
    for (const match of value.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const select = new Control(); select.tagName = "SELECT"; select.register = this.register;
      for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) select.attrs[attr[1]] = attr[2];
      const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      select.value = (options.find(option => /\bselected\b/.test(option[2])) || options[0])?.[1] || "";
      this.appendChild(select);
    }
  }
  get textContent(): string { return this.text || this.html.replace(/<[^>]*>/g, "") || this.childNodes.map(node => node.textContent || "").join(""); }
  set textContent(value: string) { this.text = String(value); this.html = ""; this.childNodes = []; }
  setAttribute(key: string, value: string) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  appendChild(node: any) { this.childNodes.push(node); node.parentNode = this; if (node.nodeType === 1) { node.register = this.register; this.register?.(node); } return node; }
  removeChild(node: any) { this.childNodes = this.childNodes.filter(candidate => candidate !== node); node.parentNode = null; }
  addEventListener(type: string, handler: (event: any) => void) { this.handlers.set(type, [...this.handlers.get(type) || [], handler]); }
  emit(type: string) { for (const handler of this.handlers.get(type) || []) handler({ target: this, preventDefault() {}, stopPropagation() {} }); }
}
function uiFixture() {
  const h = ipcFixture(), bridge = h.renderer(), elements: Record<string, Control> = {};
  const register = (node: Control) => { if (node.id) elements[node.id] = node; };
  for (const match of HTML.matchAll(/\bid="([^"]+)"/g)) { const node = new Control(); node.register = register; node.id = match[1]; }
  const buttons = Object.fromEntries(["syncPush", "syncPull", "syncSave", "loadSyncDiff", "loadSyncPreview", "syncRecheckHistory"].map(name => {
    const node = new Control(); node.tagName = "BUTTON"; node.attrs["data-cmd"] = name; node.textContent = name; return [name, node];
  }));
  elements["sync-merge-strategy"].value = "local";
  const document = {
    addEventListener: vi.fn(),
    getElementById: (id: string) => elements[id] || null,
    createElement: (tag: string) => { const node = new Control(); node.tagName = tag.toUpperCase(); node.register = register; return node; },
    createTextNode: (textContent: string) => ({ nodeType: 3, textContent }),
    querySelector: (selector: string) => Object.entries(buttons).find(([name]) => selector.includes(`"${name}"`))?.[1] || null,
    querySelectorAll: (selector: string) => selector.includes("sync-entry-strategy") ? elements["sync-diff"].children.filter(node => node.className === "sync-entry-strategy") : [],
  };
  const api = { ...bridge.api, team: { status: vi.fn(async () => ({ local: { role: "owner" }, members: [] })) } };
  const app: any = { api, helpers: { toast: vi.fn(), esc: escape, escAttr: escape }, confirmAsync: vi.fn(async () => true) };
  const window = { agentBrowser: app, crypto: { randomUUID: () => "synthetic-ui-session-0001" }, addEventListener: vi.fn() };
  vm.runInNewContext(RENDERER, { window, document, console, setTimeout, clearTimeout, Date, Math, Promise }, { filename: "synthetic-sync-renderer.js" });
  const cancel = () => elements["sync-operation-actions"]?.children.find(node => node.id === "sync-cancel-button");
  return { ...h, app, bridge, elements, buttons, cancel, banner: () => elements["sync-operation-state"]?.textContent || "", result: () => elements["sync-operation-result"]?.innerHTML || "" };
}

describe("responsive renderer cancellation uses actual owned read IPC", () => {
  it.each(["push", "pull"] as const)("%s Checking keeps Cancel enabled, sends owned read cancellation, and waits for cleanup without dispatching a write", async kind => {
    const h = uiFixture(); Object.assign(h.status, { includeFullProfile: true, fullProfileConsentAt: 1, fullProfilePassphraseSet: true, includeHistory: true, historyConsentAt: 1 });
    await h.app.loadSyncConfig(); await flush(); if (kind === "pull") await h.app.loadSyncDiff();
    const cleanup = deferred<any>(); const signal = mockRead(h, "preview", cleanup.promise);
    let settled = false; const pending = h.app[kind === "push" ? "syncPush" : "syncPull"]().then(() => { settled = true; }); await flush();
    const button = h.cancel()!; expect(button.disabled).toBe(false); expect(h.buttons.syncPush.disabled).toBe(true);
    expect(h.elements["tab-sync"].getAttribute("aria-busy")).toBe("true");
    button.emit("click"); button.emit("click"); await flush();
    expect(signal().aborted).toBe(true); expect(settled).toBe(false); expect(button.disabled).toBe(true);
    expect(h.banner()).toContain("waiting for the active check to stop and release its resources");
    const cancels = h.bridge.invoke.mock.calls.filter(call => call[0] === "sync:cancel"); expect(cancels).toHaveLength(1);
    expect(h.result()).toBe(""); expect(h.service[kind]).not.toHaveBeenCalled();
    cleanup.resolve(preview({ message: "Obsolete cancelled preflight preview" })); await pending; await flush();
    expect(h.service.push).not.toHaveBeenCalled(); expect(h.service.pull).not.toHaveBeenCalled(); expect(h.cancel()).toBeUndefined();
    expect(h.buttons.syncPush.disabled).toBe(false); expect(h.banner()).toContain(`${kind === "push" ? "Push" : "Pull"} was not started by this request`);
    expect(h.elements["sync-preview-message"].textContent).not.toContain("Obsolete cancelled");
    expect(h.status.includeFullProfile).toBe(true); expect(h.status.includeHistory).toBe(true);
    expect(h.bridge.invoke.mock.calls.some(call => call[0] === "sync:configure")).toBe(false);
    expect(h.elements["sync-merge-strategy"].value).toBe("remote");
  });

  it("cancels a Push's remote comparison rather than racing or dispatching its late warning/token", async () => {
    const h = uiFixture(); await h.app.loadSyncConfig(); await flush(); const cleanup = deferred<any>(), signal = mockRead(h, "previewDiff", cleanup.promise);
    const pending = h.app.syncPush(); await flush(); const button = h.cancel()!; button.emit("click"); await flush();
    expect(signal().aborted).toBe(true); expect(h.buttons.syncSave.disabled).toBe(true); expect(h.service.push).not.toHaveBeenCalled();
    cleanup.resolve(comparison({ pushWarnings: ["Obsolete synthetic removal"], comparisonToken: { ...TOKEN, localHash: "obsolete" } }));
    await pending; expect(h.app.confirmAsync).not.toHaveBeenCalled(); expect(h.service.push).not.toHaveBeenCalled();
    expect(h.elements["sync-diff"].innerHTML).not.toContain("Obsolete synthetic removal");
    const ids = h.bridge.invoke.mock.calls.filter(call => ["sync:preview", "sync:preview-diff"].includes(call[0])).map(call => call[1].requestId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("allows a purely local confirmation to be abandoned, but never dispatches a later accepted dialog", async () => {
    const h = uiFixture(), decision = deferred<boolean>(); await h.app.loadSyncConfig(); await flush();
    h.service.previewDiff.mockResolvedValueOnce(comparison({ pushWarnings: ["Synthetic removal requiring confirmation"] })); h.app.confirmAsync.mockReturnValueOnce(decision.promise);
    const pending = h.app.syncPush(); await flush(); expect(h.app.confirmAsync).toHaveBeenCalledTimes(1);
    h.cancel()!.emit("click"); await pending; decision.resolve(true); await flush();
    expect(h.service.push).not.toHaveBeenCalled(); expect(h.buttons.syncPull.disabled).toBe(false);
    expect(h.bridge.invoke.mock.calls.filter(call => call[0] === "sync:cancel")).toHaveLength(0);
  });

  it("preserves latest comparison sequence while the read group waits for every original request to settle", async () => {
    const h = uiFixture(); await h.app.loadSyncConfig(); await flush(); const old = deferred<any>(), latest = deferred<any>();
    h.service.previewDiff.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const first = h.app.loadSyncDiff(), second = h.app.loadSyncDiff(); await flush();
    const oldSignal = h.service.previewDiff.mock.calls[0][0]!;
    latest.resolve(comparison({ profiles: section("Newest synthetic comparison"), comparisonToken: { ...TOKEN, localHash: "latest-local" } })); await second;
    expect(h.elements["sync-diff"].innerHTML).toContain("Newest synthetic comparison");
    expect(h.buttons.syncPush.disabled).toBe(true); expect(h.cancel()?.disabled).toBe(false);
    h.cancel()!.emit("click"); await flush(); expect(oldSignal.aborted).toBe(true); expect(h.buttons.syncPush.disabled).toBe(true);
    old.resolve(comparison({ profiles: section("Obsolete synthetic comparison") })); await first;
    expect(h.elements["sync-diff"].innerHTML).toContain("Newest synthetic comparison"); expect(h.elements["sync-diff"].innerHTML).not.toContain("Obsolete synthetic comparison");
    expect(h.buttons.syncPush.disabled).toBe(false); await h.app.syncPull();
    expect(h.service.pull).toHaveBeenCalledWith(expect.any(AbortSignal), expect.objectContaining({ comparisonToken: { ...TOKEN, localHash: "latest-local" } }));
  });

  it("cancels a sequential History recheck, retains old observations, and never starts the remaining profiles", async () => {
    const h = uiFixture(); h.status.history = { "synthetic-profile-a": { status: "unknown", coverage: "complete" }, "synthetic-profile-b": { status: "unknown", coverage: "preserved" } };
    await h.app.loadSyncConfig(); await flush(); const cleanup = deferred<any>(), signal = mockRead(h, "historyState", cleanup.promise);
    let settled = false; const pending = h.app.syncRecheckHistory().then(() => { settled = true; }); await flush();
    expect(h.service.historyState).toHaveBeenCalledTimes(1); expect(h.cancel()?.textContent).toBe("Cancel check");
    h.cancel()!.emit("click"); await flush(); expect(signal().aborted).toBe(true); expect(settled).toBe(false);
    expect(h.buttons.syncPull.disabled).toBe(true); cleanup.resolve({ status: "synced", reason: "obsolete-match" }); await pending;
    expect(h.service.historyState).toHaveBeenCalledTimes(1); expect(h.elements["sync-history-coverage"].innerHTML).not.toContain("Semantic baseline matches");
    expect(h.buttons.syncPull.disabled).toBe(false); expect(h.service.push).not.toHaveBeenCalled(); expect(h.service.pull).not.toHaveBeenCalled();
  });

  it("a foreign mutation cancels only the old preflight capability; late read replies cannot replace a newer generation receipt", async () => {
    const h = uiFixture(); await h.app.loadSyncConfig(); await flush(); const cleanup = deferred<any>(), signal = mockRead(h, "preview", cleanup.promise);
    const pending = h.app.syncPush(); await flush(); const oldButton = h.cancel()!;
    h.status.operation = { generation: 1, active: { operationId: "foreign-write", kind: "push" }, last: null };
    h.emit("sync:state-changed", state("started", 1, "foreign-write")); await flush();
    expect(signal().aborted).toBe(true); expect(h.cancel()).toBeUndefined();
    const foreign = receipt({ operationId: "foreign-write", message: "Newer synthetic generation receipt" });
    h.status.operation = { generation: 2, active: null, last: foreign }; h.emit("sync:state-changed", { ...state("completed", 2, "foreign-write"), result: foreign }); await flush();
    cleanup.resolve(preview({ message: "Obsolete old-generation preview" })); await pending;
    expect(h.service.push).not.toHaveBeenCalled(); expect(h.result()).toContain("Newer synthetic generation receipt"); expect(h.result()).not.toContain("Nothing changed");
    oldButton.emit("click"); await flush();
    expect(h.bridge.invoke.mock.calls.filter(call => call[0] === "sync:cancel")).toHaveLength(1);
  });

  it("a late cancellation failure from a revoked preflight cannot warn about or expose a foreign operation", async () => {
    const h = uiFixture(); await h.app.loadSyncConfig(); await flush();
    const cleanup = deferred<any>(), ack = deferred<any>(); mockRead(h, "preview", cleanup.promise);
    const actual = h.handlers.get("sync:cancel")!;
    h.handlers.set("sync:cancel", (...args) => { actual(...args); return ack.promise; });
    const pending = h.app.syncPush(); await flush(); h.cancel()!.emit("click"); await flush();
    h.status.operation = { generation: 1, active: { operationId: "foreign-write", kind: "push" }, last: null };
    h.emit("sync:state-changed", state("started", 1, "foreign-write")); await flush();
    ack.reject(new Error("Synthetic revoked read cancellation failure")); await flush();
    expect(h.cancel()).toBeUndefined(); expect(h.buttons.syncPush.disabled).toBe(true);
    expect(h.app.helpers.toast.mock.calls.some((call: any[]) => String(call[0]).includes("Cancellation could not be confirmed"))).toBe(false);
    cleanup.resolve(preview()); await pending;
    expect(h.service.push).not.toHaveBeenCalled();
    expect(h.bridge.invoke.mock.calls.filter(call => call[0] === "sync:cancel")).toHaveLength(1);
  });

  it("a failed read cancellation ACK permits retry without unlocking the read or dispatching a write", async () => {
    const h = uiFixture(); await h.app.loadSyncConfig(); await flush(); const cleanup = deferred<any>(), signal = mockRead(h, "preview", cleanup.promise);
    const actual = h.handlers.get("sync:cancel")!; let attempts = 0;
    h.handlers.set("sync:cancel", (...args) => ++attempts === 1 ? { success: false, code: "SYNTHETIC_ACK_FAILURE" } : actual(...args));
    const pending = h.app.syncPush(); await flush(); h.cancel()!.emit("click"); await flush();
    expect(signal().aborted).toBe(false); expect(h.cancel()?.disabled).toBe(false); expect(h.buttons.syncPush.disabled).toBe(true);
    expect(h.app.helpers.toast).toHaveBeenLastCalledWith(expect.stringContaining("Cancellation could not be confirmed"), "warning");
    h.cancel()!.emit("click"); await flush(); expect(signal().aborted).toBe(true); expect(h.cancel()?.disabled).toBe(true);
    cleanup.resolve(preview()); await pending; expect(h.service.push).not.toHaveBeenCalled(); expect(attempts).toBe(2);
  });

  it("stale Cancel buttons and late cancellation failures cannot affect the next operation", async () => {
    const h = uiFixture(); await h.app.loadSyncConfig(); await flush(); const first = deferred<any>(), ack = deferred<any>(); mockRead(h, "preview", first.promise);
    const actual = h.handlers.get("sync:cancel")!; let attempts = 0;
    h.handlers.set("sync:cancel", (...args) => { attempts++; actual(...args); return ack.promise; });
    const pending = h.app.syncPush(); await flush(); const oldButton = h.cancel()!; oldButton.emit("click"); await flush();
    first.resolve(preview()); await pending; await flush();
    const next = deferred<any>(), nextSignal = mockRead(h, "preview", next.promise), newer = h.app.syncPush(); await flush(); const newButton = h.cancel()!;
    expect(newButton).not.toBe(oldButton); oldButton.emit("click"); ack.reject(new Error("Synthetic obsolete cancellation error")); await flush();
    expect(attempts).toBe(1); expect(nextSignal().aborted).toBe(false); expect(newButton.disabled).toBe(false);
    expect(h.app.helpers.toast.mock.calls.some((call: any[]) => String(call[0]).includes("Cancellation could not be confirmed"))).toBe(false);
    h.handlers.set("sync:cancel", actual); newButton.emit("click"); await flush(); next.resolve(preview()); await newer;
    expect(h.service.push).not.toHaveBeenCalled();
  });

  it("shows cancellation pending at a safe commit boundary and preserves the final partial/unknown receipt", async () => {
    const h = uiFixture(); await h.app.loadSyncConfig(); await flush(); const cleanup = deferred<any>();
    h.service.push.mockImplementationOnce(() => {
      h.status.operation = { generation: 1, active: { operationId: "synthetic-write", kind: "push", stage: "applying" }, last: null };
      h.emit("sync:state-changed", state("started", 1)); return cleanup.promise;
    });
    let settled = false; const pending = h.app.syncPush().then(() => { settled = true; }); await flush();
    const writeSignal = h.service.push.mock.calls[0][0]; const button = h.cancel()!; expect(button.disabled).toBe(false);
    button.emit("click"); await flush(); expect(writeSignal.aborted).toBe(true); expect(settled).toBe(false);
    expect(h.banner()).toContain("Published or applied items may remain"); expect(h.result()).toBe("");
    const final = receipt(); h.status.operation = { generation: 2, active: null, last: final };
    h.emit("sync:state-changed", { ...state("completed", 2), result: final }); await flush();
    expect(h.buttons.syncSave.disabled).toBe(true); expect(h.cancel()?.disabled).toBe(true);
    const banner = h.banner();
    for (const operationId of ["synthetic-write", "obsolete-operation"]) h.emit("sync:progress", { generation: 1, operationId, kind: "push", stage: "publishing", startedAt: 1, progress: { sequence: 100, updatedAt: 200 } });
    expect(h.banner()).toBe(banner); cleanup.resolve(final); await pending;
    expect(h.result()).toContain("Partial"); expect(h.result()).toContain("Unknown"); expect(h.result()).not.toContain("Nothing changed");
    expect(h.cancel()).toBeUndefined(); expect(h.buttons.syncPush.disabled).toBe(false);
    expect(h.app.helpers.toast.mock.calls.some((call: any[]) => call[1] === "success")).toBe(false);
  });
});
