// Stage 3 AUTHOR-ONLY preparation. UNRUN feature tests for the intended bridge.
// Missing methods are assumptions, not an existing-product RED. Execution of
// the actual preload is reserved for main's explicit source-stable handoff.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import type { NetworkObservationSummary } from "../../src/main/services/network-diagnostics-contract.js";

// Follow preload-subscriptions' actual CJS loader fixture, not a copied bridge,
// source-extracted function or an imported test suite with setup side effects.
const require = createRequire(import.meta.url);
const events = new EventEmitter();
const invoke = vi.fn<(...args: any[]) => Promise<any>>();
const ipcRenderer = {
  invoke,
  on: vi.fn((channel: string, listener: (...args: any[]) => void) => { events.on(channel, listener); return ipcRenderer; }),
  removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => { events.removeListener(channel, listener); return ipcRenderer; }),
};
let api: any;
let filename: string;
let priorCache: NodeJS.Module | undefined;
const ID = "ab_network_preload";
const HANDLE = "676b8993-f27c-43f0-b456-bb60dd226120";
const REQUEST = "network-preload-owned";
const AT = 1_792_387_200_000;
function quietSummary(): NetworkObservationSummary {
  return { version: 1, completion: "completed", stopReason: "window-ended", armedAt: AT, endedAt: AT + 10_000, durationMs: 10_000,
    counts: { requests: 0, hops: 0, responses: 0, finished: 0, failed: 0, blocked: 0, requestCancelled: 0, redirects: 0, http4xx: 0, http5xx: 0, pending: 0, cache: 0, serviceWorker: 0, unattributed: 0, cspIssues: 0 },
    coverage: { network: "observed", csp: "unavailable", worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeAll(() => {
  const Module = require("node:module");
  const original = Module._load;
  filename = require.resolve("../../src/main/preload.cjs"); priorCache = require.cache[filename];
  delete require.cache[filename];
  Module._load = function (request: string, ...rest: any[]) {
    if (request === filename) return original.call(this, request, ...rest);
    if (request !== "electron") throw new Error(`Unexpected production preload import: ${request}`);
    return { ipcRenderer, contextBridge: { exposeInMainWorld: (name: string, value: unknown) => {
      expect(name).toBe("agentBrowserAPI"); expect(api).toBeUndefined(); api = value;
    } } };
  };
  try { require(filename); }
  finally { Module._load = original; }
});
beforeEach(() => {
  events.removeAllListeners(); vi.clearAllMocks();
  invoke.mockImplementation(async (...args: any[]) => ({ args }));
});
afterAll(() => {
  events.removeAllListeners(); delete require.cache[filename];
  if (priorCache) require.cache[filename] = priorCache;
});

describe("actual production preload positional network bridge", () => {
  it("exposes only page listing, one awaited observation, and the armed subscription, not port/jobs authority", () => {
    expect(api.browser.networkPages).toEqual(expect.any(Function));
    expect(api.browser.networkObserve).toEqual(expect.any(Function));
    expect(api.browser.onNetworkArmed).toEqual(expect.any(Function));
    expect(api.browser.healthClear).toEqual(expect.any(Function));
    expect(Object.keys(api.browser).filter(key => /^network/i.test(key)).sort()).toEqual(["networkObserve", "networkPages"]);
    for (const key of ["networkStart", "networkPoll", "networkJob", "networkByPort", "networkNavigate", "networkDebugTarget"]) expect(api.browser).not.toHaveProperty(key);
    expect(api).not.toHaveProperty("ipcRenderer"); expect(api).not.toHaveProperty("invoke");
  });

  it("networkPages forwards only the positional profile and returns the main reply unchanged", async () => {
    const reply = { ok: true, pages: [{ handle: HANDLE, origin: "https://preload-network.fixture.test", ordinal: 1 }] };
    invoke.mockResolvedValueOnce(reply);
    expect(await api.browser.networkPages(ID)).toBe(reply);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("browser:network-pages", ID);
  });

  it("networkObserve uses the exact (dirId,{selection,requestId}) handler contract, not envRisk's object envelope", async () => {
    const reply = { ok: false, outcome: "inconclusive", requestId: REQUEST, observation: quietSummary(), hops: [], httpStatusEvidence: [] };
    invoke.mockResolvedValueOnce(reply);
    expect(await api.browser.networkObserve(ID, { selection: HANDLE, requestId: REQUEST })).toBe(reply);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("browser:network-observe", ID, { selection: HANDLE, requestId: REQUEST });
    expect(ipcRenderer.on).not.toHaveBeenCalled();
  });

  it("awaits exactly one main result without synthesizing completion, starting a job, or polling", async () => {
    const held = deferred<unknown>(); invoke.mockReturnValueOnce(held.promise);
    let settled = false;
    const pending = api.browser.networkObserve(ID, { selection: HANDLE, requestId: REQUEST }).then((reply: unknown) => { settled = true; return reply; });
    await Promise.resolve(); expect(settled).toBe(false); expect(invoke).toHaveBeenCalledTimes(1);
    const observation = quietSummary(); observation.completion = "cancelled"; observation.stopReason = "cancelled";
    observation.coverage.network = "partial"; observation.endedAt = AT; observation.durationMs = 0;
    const reply = { ok: false, outcome: "cancelled", requestId: REQUEST, code: "HEALTH_CANCELLED", observation, hops: [], httpStatusEvidence: [] };
    held.resolve(reply); expect(await pending).toBe(reply); expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not convert a rejected main invocation into a successful or empty observation", async () => {
    const failure = new Error("synthetic IPC transport refusal"); invoke.mockRejectedValueOnce(failure);
    await expect(api.browser.networkObserve(ID, { selection: HANDLE, requestId: REQUEST })).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("browser:network-observe", ID, { selection: HANDLE, requestId: REQUEST });
  });

  it("healthClear preserves its optional positional kind and leaves existing history/cancel signatures unchanged", async () => {
    invoke.mockResolvedValue({ ok: true });
    expect(await api.browser.healthClear(ID, "network")).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("browser:health-clear", ID, "network");
    await api.browser.healthClear(ID);
    expect(invoke).toHaveBeenLastCalledWith("browser:health-clear", ID, undefined);
    await api.browser.healthHistory(ID);
    expect(invoke).toHaveBeenLastCalledWith("browser:health-history", ID);
    await api.browser.healthCancel(ID, { kind: "network", requestId: REQUEST });
    expect(invoke).toHaveBeenLastCalledWith("browser:health-cancel", ID, { kind: "network", requestId: REQUEST });
  });

  it("extra frontend arguments cannot select an arbitrary IPC channel, debugger port or URL", async () => {
    await api.browser.networkPages(ID, 45683, "https://unowned.invalid", "private:invoke");
    expect(invoke).toHaveBeenLastCalledWith("browser:network-pages", ID);
    await api.browser.networkObserve(ID, { selection: HANDLE, requestId: REQUEST }, 45683, "private:invoke");
    expect(invoke).toHaveBeenLastCalledWith("browser:network-observe", ID, { selection: HANDLE, requestId: REQUEST });
  });
});

describe("owned armed subscriptions expose data, never Electron capabilities", () => {
  it("listens only on browser:network-armed and returns a one-listener unsubscribe", () => {
    const callback = vi.fn(); const unsubscribe = api.browser.onNetworkArmed(callback);
    expect(unsubscribe).toEqual(expect.any(Function));
    expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.on.mock.calls[0][0]).toBe("browser:network-armed");
    const installed = ipcRenderer.on.mock.calls[0][1];
    expect(installed).not.toBe(callback); expect(events.listenerCount("browser:network-armed")).toBe(1);
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith("browser:network-armed", installed);
    expect(events.listenerCount("browser:network-armed")).toBe(0);
  });

  it("preserves dirId/requestId/armedAt/fixed duration while stripping the privileged Electron event", () => {
    const callback = vi.fn(); const unsubscribe = api.browser.onNetworkArmed(callback);
    const privilegedEvent = { sender: { send: vi.fn() }, ports: ["not exposed"], reply: vi.fn() };
    const payload = { dirId: ID, requestId: REQUEST, armedAt: AT, observeForMs: 10_000 };
    events.emit("browser:network-armed", privilegedEvent, payload);
    expect(callback).toHaveBeenCalledExactlyOnceWith(payload);
    expect(callback.mock.calls[0]).not.toContain(privilegedEvent);
    expect(invoke).not.toHaveBeenCalled(); unsubscribe();
  });

  it("two subscriptions can unsubscribe independently without removing another window flow's listener", () => {
    const first = vi.fn(); const second = vi.fn();
    const removeFirst = api.browser.onNetworkArmed(first); const removeSecond = api.browser.onNetworkArmed(second);
    const firstPayload = { dirId: ID, requestId: "first-flow", armedAt: AT, observeForMs: 10_000 };
    events.emit("browser:network-armed", {}, firstPayload);
    expect(first).toHaveBeenCalledExactlyOnceWith(firstPayload); expect(second).toHaveBeenCalledExactlyOnceWith(firstPayload);
    removeFirst(); expect(events.listenerCount("browser:network-armed")).toBe(1);
    const secondPayload = { dirId: ID, requestId: "second-flow", armedAt: AT + 1, observeForMs: 10_000 };
    events.emit("browser:network-armed", {}, secondPayload);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenLastCalledWith(secondPayload);
    removeSecond(); expect(events.listenerCount("browser:network-armed")).toBe(0);
  });

  it("unsubscribe is idempotent and prevents any queued later armed callback", () => {
    const callback = vi.fn(); const unsubscribe = api.browser.onNetworkArmed(callback);
    unsubscribe(); unsubscribe();
    events.emit("browser:network-armed", { sender: "unexposed" }, { dirId: ID, requestId: REQUEST, armedAt: AT, observeForMs: 10_000 });
    expect(callback).not.toHaveBeenCalled(); expect(events.listenerCount("browser:network-armed")).toBe(0);
    expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
  });

  it("removing armed cannot orphan or remove the same callback's existing browser-exit subscription", () => {
    const callback = vi.fn(); api.on("browser:exited", callback);
    const unsubscribe = api.browser.onNetworkArmed(callback); unsubscribe();
    events.emit("browser:network-armed", {}, { dirId: ID, requestId: REQUEST, armedAt: AT, observeForMs: 10_000 });
    expect(callback).not.toHaveBeenCalled();
    events.emit("browser:exited", { sender: "unexposed" }, { dirId: ID });
    expect(callback).toHaveBeenCalledExactlyOnceWith({ dirId: ID });
    api.removeListener("browser:exited", callback); expect(events.listenerCount("browser:exited")).toBe(0);
  });
});
