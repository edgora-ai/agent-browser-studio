// Original IPC + preload in an isolated VM. Synthetic promises stand in for
// transport/rollback settlement; no app, sockets, user data, or service IO.
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";

const MAIN = path.resolve(__dirname, "../../src/main");
const IPC = ts.transpileModule(fs.readFileSync(path.join(MAIN, "ipc/sync.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const PRELOAD = fs.readFileSync(path.join(MAIN, "preload.cjs"), "utf8");
const A = "synthetic-request-a-0001", B = "synthetic-request-b-0002";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
const receipt = (overrides: Record<string, unknown> = {}) => ({ success: false, operationId: "synthetic-operation", outcome: "cancelled",
  localCommit: "none", remoteCommit: "none", message: "Synthetic service settled", items: [], warnings: [], recovery: [], ...overrides });
function fixture() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const subscribers = new Map<string, (payload: any) => void>(), windows: any[] = [];
  const emit = (channel: string, payload: any) => subscribers.get(channel)?.(payload);
  const service = { push: vi.fn(async (..._args: any[]): Promise<any> => receipt()), pull: vi.fn(async (..._args: any[]): Promise<any> => receipt()),
    getStatus: vi.fn(() => ({})), preview: vi.fn(), previewDiff: vi.fn(), historyState: vi.fn() };
  const fail = (name: string): never => { throw new Error("Unselected fixture import: " + name); };
  const module = { exports: {} as any };
  vm.runInNewContext(`(function(require, module, exports) { ${IPC}\n})`, { AbortController, console })(
    (name: string) => name === "electron" ? { ipcMain: { handle: (channel: string, callback: any) => handlers.set(channel, callback) }, BrowserWindow: { getAllWindows: () => windows } }
      : name === "../services/sync-service.js" ? { syncService: service }
        : name === "../services/config-manager.js" ? { setSyncConfig: () => fail("settings write") }
          : name === "../services/team.js" ? { requireSettingsMutation: () => ({ ok: true }) }
            : name === "../services/event-bus.js" ? { onEvent: (channel: string, callback: (payload: any) => void) => { subscribers.set(channel, callback); return () => subscribers.delete(channel); } } : fail(name), module, module.exports);
  module.exports.registerSyncHandlers();
  function renderer(sender: any = { id: 1 }, senderFrame: any = { routingId: 1 }) {
    let api: any;
    sender.mainFrame ??= senderFrame; sender.isDestroyed ??= () => false; sender.send ??= vi.fn();
    if (!windows.some(w => w.webContents === sender)) windows.push({ isDestroyed: () => false, webContents: sender });
    const invoke = vi.fn(async (channel: string, ...args: any[]) => structuredClone(await handlers.get(channel)!({ sender, senderFrame }, ...structuredClone(args))));
    vm.runInNewContext(PRELOAD, { require: (name: string) => name === "electron" ? {
      contextBridge: { exposeInMainWorld: (_name: string, value: any) => { api = value; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    } : fail(name) });
    return { api: api.sync, invoke, sender, senderFrame };
  }
  return { service, renderer, emit };
}

describe("sender-owned user synchronization cancellation", () => {
  it.each(["push", "pull"] as const)("%s passes a fresh abort signal and retains ownership until real service settlement", async kind => {
    const h = fixture(), owner = h.renderer(), settle = deferred<any>();
    h.service[kind].mockReturnValueOnce(settle.promise);
    let finished = false;
    const pending = owner.api[kind]({ requestId: A, history: true }).then((value: any) => { finished = true; return value; });
    const signal = h.service[kind].mock.calls[0][0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(await owner.api.cancel({ requestId: A })).toEqual({ success: true, requestId: A, state: "cancelling" });
    expect(signal.aborted).toBe(true); expect(finished).toBe(false);
    // Idempotent while rollback/PUT settlement is pending, not a final result.
    expect((await owner.api.cancel({ requestId: A })).success).toBe(true); expect(finished).toBe(false);
    settle.reject(Object.assign(new Error("Synthetic abort"), { syncResult: receipt() }));
    expect(await pending).toEqual(receipt()); expect(finished).toBe(true);
    expect(await owner.api.cancel({ requestId: A })).toMatchObject({ success: false, code: "SYNC_CANCEL_NOT_OWNED" });
  });
  it("rejects foreign senders even when their numeric ID and request ID match, and rejects other frames", async () => {
    const h = fixture(), owner = h.renderer(), foreign = h.renderer({ id: owner.sender.id }, owner.senderFrame), frame = h.renderer(owner.sender, { routingId: 2 });
    const settle = deferred<any>(); h.service.push.mockReturnValueOnce(settle.promise);
    const pending = owner.api.push({ requestId: A }); const signal = h.service.push.mock.calls[0][0] as AbortSignal;
    for (const r of [foreign, frame]) expect(await r.api.cancel({ requestId: A })).toMatchObject({ success: false, code: "SYNC_CANCEL_NOT_OWNED" });
    for (const requestId of [undefined, null, 0, "", "short", "x".repeat(129), "with/slash-not-valid"]) {
      expect(await owner.api.cancel({ requestId })).toMatchObject({ success: false, code: "INVALID_SYNC_REQUEST" });
    }
    expect(signal.aborted).toBe(false); settle.resolve(receipt()); await pending;
  });
  it("refuses detached sender frames without acquiring a capability or cancelling an attached owner", async () => {
    const h = fixture(), owner = h.renderer(), detached = h.renderer(owner.sender, null);
    expect(await detached.api.push({ requestId: A })).toMatchObject({ success: false, code: "INVALID_SYNC_REQUEST" });
    expect(h.service.push).not.toHaveBeenCalled();
    const settle = deferred<any>(); h.service.push.mockReturnValueOnce(settle.promise);
    const pending = owner.api.push({ requestId: A });
    const signal = h.service.push.mock.calls[0][0] as AbortSignal;
    expect(await detached.api.cancel({ requestId: A })).toMatchObject({ success: false, code: "SYNC_CANCEL_NOT_OWNED" });
    expect(signal.aborted).toBe(false); settle.resolve(receipt()); await pending;
  });
  it.each(["detached", "destroyed", "inaccessible-frame", "inaccessible-sender"])("revokes %s document capabilities without aborting or adopting its operation", async reason => {
    const h = fixture(), owner = h.renderer(), settle = deferred<any>();
    const started = { operationId: "owned-service", generation: 1, kind: "push", phase: "started" };
    h.service.push.mockImplementationOnce(() => { h.emit("sync:state-changed", started); return settle.promise; });
    const pending = owner.api.push({ requestId: A });
    const signal = h.service.push.mock.calls[0][0] as AbortSignal;
    h.service.getStatus.mockReturnValue({ operation: { generation: 1, active: started } });
    expect((await owner.api.status()).operation.active.requestId).toBe(A);
    const replacement = h.renderer(owner.sender, { routingId: 2, detached: false });
    owner.sender.mainFrame = replacement.senderFrame;
    if (reason === "detached") owner.senderFrame.detached = true;
    if (reason === "destroyed") owner.sender.isDestroyed = () => true;
    if (reason === "inaccessible-frame") Object.defineProperty(owner.senderFrame, "detached", { get() { throw new Error("Frame disposed"); } });
    if (reason === "inaccessible-sender") owner.sender.isDestroyed = () => { throw new Error("Sender disposed"); };
    try {
      for (const renderer of [owner, replacement]) {
        expect(await renderer.api.cancel({ requestId: A })).toMatchObject({ success: false, code: "SYNC_CANCEL_NOT_OWNED" });
        expect((await renderer.api.status()).operation.active).not.toHaveProperty("requestId");
      }
      for (const kind of ["push", "pull"]) expect(await owner.api[kind]({ requestId: B })).toMatchObject({ success: false, code: "INVALID_SYNC_REQUEST" });
      expect(h.service.push).toHaveBeenCalledTimes(1); expect(h.service.pull).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(false);
      if (reason === "detached" || reason === "inaccessible-frame") {
        // Even if a stale mainFrame reference survives briefly, don't decorate it.
        owner.sender.mainFrame = owner.senderFrame;
        h.emit("sync:progress", { operationId: "owned-service", generation: 1 });
        expect(owner.sender.send.mock.lastCall[1]).not.toHaveProperty("requestId");
      }
    } finally { settle.resolve(receipt()); await pending; }
    if (reason === "detached") {
      // Revocation did not consume the new token or deny the replacement document.
      await replacement.api.pull({ requestId: B }); expect(h.service.pull).toHaveBeenCalledTimes(1);
    }
  });
  it("a stale cancellation and replayed request cannot abort or replace a subsequent operation", async () => {
    const h = fixture(), owner = h.renderer(); await owner.api.push({ requestId: A });
    const settle = deferred<any>(); h.service.pull.mockReturnValueOnce(settle.promise);
    const pending = owner.api.pull({ requestId: B }); const signal = h.service.pull.mock.calls[0][0] as AbortSignal;
    expect(await owner.api.cancel({ requestId: A })).toMatchObject({ success: false, code: "SYNC_CANCEL_NOT_OWNED" });
    expect(await owner.api.push({ requestId: A })).toMatchObject({ success: false, code: "SYNC_REQUEST_REUSED" });
    expect(await owner.api.pull({ requestId: B })).toMatchObject({ success: false, code: "SYNC_REQUEST_REUSED" });
    expect(h.service.push).toHaveBeenCalledTimes(1); expect(h.service.pull).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(false);
    settle.resolve(receipt()); await pending;
  });
  it.each([
    { outcome: "partial", localCommit: "partial", remoteCommit: "unknown" },
    { outcome: "recovery-required", localCommit: "unknown", remoteCommit: "committed", recovery: [{ resource: "profile", id: "fixture", paths: ["/synthetic/retained"] }] },
    { outcome: "complete", success: true, localCommit: "committed", remoteCommit: "committed" },
  ])("preserves the authoritative receipt even when cancel races with $outcome settlement", async facts => {
    const h = fixture(), owner = h.renderer(), settle = deferred<any>(); h.service.pull.mockReturnValueOnce(settle.promise);
    const pending = owner.api.pull({ requestId: A }); await owner.api.cancel({ requestId: A });
    const final = receipt(facts); settle.reject(Object.assign(new Error("Synthetic service result"), { syncResult: final }));
    expect(await pending).toEqual(final);
  });
  it("does not fabricate a cancelled/no-commit receipt for an untyped failure", async () => {
    const h = fixture(), owner = h.renderer(), settle = deferred<any>(); h.service.push.mockReturnValueOnce(settle.promise);
    const pending = owner.api.push({ requestId: A }); await owner.api.cancel({ requestId: A });
    settle.reject(new Error("Synthetic result unavailable")); await expect(pending).rejects.toThrow("Synthetic result unavailable");
    expect((await owner.api.cancel({ requestId: A })).success).toBe(false);
  });
  it("keeps legacy invocations and scope validation compatible, without a cancellation capability", async () => {
    const h = fixture(), owner = h.renderer(); await owner.api.push({ history: false }); await owner.api.pull({ strategy: "remote" });
    expect(h.service.push).toHaveBeenCalledWith(undefined, false, undefined, { history: false });
    expect(h.service.pull).toHaveBeenCalledWith(undefined, { strategy: "remote", resolutions: {}, comparisonToken: undefined });
    expect((await owner.api.cancel({ requestId: A })).success).toBe(false);
    expect(await owner.api.push({ requestId: A, history: "true" })).toMatchObject({ code: "INVALID_HISTORY_SCOPE" });
    expect(await owner.api.pull({ requestId: A, allowRunningPartial: "true" })).toMatchObject({ code: "INVALID_RUNNING_SCOPE" });
    expect(await owner.api.push({ requestId: "bad" })).toMatchObject({ code: "INVALID_SYNC_REQUEST" });
    expect(h.service.push).toHaveBeenCalledTimes(1); expect(h.service.pull).toHaveBeenCalledTimes(1);
  });
  it("identical request tokens in different senders remain independent invocation capabilities", async () => {
    const h = fixture(), first = h.renderer(), second = h.renderer({ id: 2 }), a = deferred<any>(), b = deferred<any>();
    h.service.push.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pendingA = first.api.push({ requestId: A }), pendingB = second.api.push({ requestId: A });
    const signalA = h.service.push.mock.calls[0][0] as AbortSignal, signalB = h.service.push.mock.calls[1][0] as AbortSignal;
    await first.api.cancel({ requestId: A }); expect(signalA.aborted).toBe(true); expect(signalB.aborted).toBe(false);
    a.resolve(receipt()); b.resolve(receipt()); await Promise.all([pendingA, pendingB]);
  });

  it("correlates actual invocation starts and reveals request IDs only to the owning sender/frame", async () => {
    const h = fixture(), owner = h.renderer(), foreign = h.renderer({ id: 2 }), frame = h.renderer(owner.sender, { routingId: 2 }), settle = deferred<any>();
    const started = { operationId: "owned-service", generation: 1, kind: "push", phase: "started" };
    h.service.push.mockImplementationOnce(() => { h.emit("sync:state-changed", started); return settle.promise; });
    const pending = owner.api.push({ requestId: A });
    expect(owner.sender.send).toHaveBeenCalledWith("sync:state-changed", { ...started, requestId: A });
    expect(foreign.sender.send).toHaveBeenCalledWith("sync:state-changed", started); expect(started).not.toHaveProperty("requestId");
    h.service.getStatus.mockReturnValue({ operation: { generation: 1, active: { operationId: "owned-service", kind: "push" } } });
    expect((await owner.api.status()).operation.active.requestId).toBe(A);
    expect((await foreign.api.status()).operation.active).not.toHaveProperty("requestId");
    expect((await frame.api.status()).operation.active).not.toHaveProperty("requestId");
    const progress = { operationId: "owned-service", generation: 1, kind: "push", stage: "preparing" }; h.emit("sync:progress", progress);
    expect(owner.sender.send).toHaveBeenLastCalledWith("sync:progress", { ...progress, requestId: A });
    h.emit("sync:state-changed", { operationId: "foreign-service", generation: 2, kind: "push", phase: "started" });
    expect(owner.sender.send.mock.lastCall[1]).not.toHaveProperty("requestId");
    settle.resolve(receipt({ operationId: "owned-service" })); await pending;
    expect((await owner.api.status()).operation.active).not.toHaveProperty("requestId");
  });
  it("does not guess ownership of an asynchronous start outside the invocation stack", async () => {
    const h = fixture(), owner = h.renderer(), settle = deferred<any>();
    h.service.push.mockImplementationOnce(async () => { await Promise.resolve(); h.emit("sync:state-changed", { operationId: "unknown-start", kind: "push", phase: "started" }); return settle.promise; });
    const pending = owner.api.push({ requestId: A }); await Promise.resolve();
    expect(owner.sender.send.mock.lastCall[1]).not.toHaveProperty("requestId");
    expect((await owner.api.cancel({ requestId: A })).success).toBe(true); expect(h.service.push.mock.calls[0][0].aborted).toBe(true);
    settle.resolve(receipt()); await pending;
  });

  it("a foreign start before a busy invocation cannot acquire its request ID or cancellation capability", async () => {
    const h = fixture(), owner = h.renderer(), busy = deferred<any>();
    const started = { operationId: "foreign-service", generation: 1, kind: "push", phase: "started" };
    h.emit("sync:state-changed", started); h.service.push.mockReturnValueOnce(busy.promise);
    const pending = owner.api.push({ requestId: A });
    h.service.getStatus.mockReturnValue({ operation: { generation: 1, active: started } });
    expect((await owner.api.status()).operation.active).not.toHaveProperty("requestId");
    busy.resolve({ success: false, code: "SYNC_BUSY" }); expect(await pending).toMatchObject({ code: "SYNC_BUSY" });
    expect((await owner.api.cancel({ requestId: A })).code).toBe("SYNC_CANCEL_NOT_OWNED");
    const next = deferred<any>(); h.service.push.mockReturnValueOnce(next.promise); const second = owner.api.push({ requestId: B });
    h.emit("sync:state-changed", started); expect(owner.sender.send.mock.lastCall[1]).not.toHaveProperty("requestId");
    expect((await owner.api.status()).operation.active).not.toHaveProperty("requestId");
    expect((await owner.api.cancel({ requestId: A })).success).toBe(false); expect(h.service.push.mock.calls[1][0].aborted).toBe(false);
    next.resolve(receipt()); await second;
  });

});
