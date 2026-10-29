import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// No app graph imports: fixed source reads plus complete production-function
// extraction. VM transport/process/filesystem bindings below are synthetic.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function source(name: string) { return fs.readFileSync(path.join(root, "src/main/services", name), "utf8"); }
function functions(text: string, names: string[]) {
  const parsed = ts.createSourceFile("production.ts", text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production function ${name}`); return node.getText(parsed);
  }).join("\n");
}
function evaluate(context: any, text: string) {
  const result = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  expect(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
  runInContext(result.outputText, context, { timeout: 1000 });
}
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }
function transport() {
  const timers: Array<{ ms: number; unref: ReturnType<typeof vi.fn> }> = [];
  const c: any = createContext({ exports: {}, Error, Date, AbortController, fetch: vi.fn(), clearTimeout,
    setTimeout: (callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms), original = timer.unref.bind(timer);
      const unref = vi.fn(() => { original(); return timer; }); timer.unref = unref;
      timers.push({ ms, unref }); return timer;
    },
  });
  evaluate(c, functions(source("browser-manager.ts"), ["waitForCdpReady"]));
  return { c, timers };
}
function response(ok = true, status = ok ? 200 : 503) { return { ok, status, body: { cancel: vi.fn(async () => {}) } }; }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("CDP readiness has a single total deadline", () => {
  it("aborts a hung first fetch even when the fetch implementation ignores abort", async () => {
    const { c, timers } = transport(), late = deferred(); c.fetch.mockReturnValue(late.promise);
    const result = c.waitForCdpReady(7777, 1000), checked = expect(result).rejects.toThrow("deadline exceeded");
    await vi.advanceTimersByTimeAsync(1000); await checked;
    expect(c.fetch).toHaveBeenCalledTimes(1); expect(c.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(timers[0].unref).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    // The losing promise already has rejection observation; Vitest would report
    // any detached unhandled rejection after this deliberately late failure.
    late.reject(new Error("late fetch failure")); await flush();
  });
  it("shares the remaining budget with a hung second endpoint, not a new deadline", async () => {
    const { c } = transport(), first = deferred(), second = deferred();
    c.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const result = c.waitForCdpReady(7777, 1000), checked = expect(result).rejects.toThrow("deadline exceeded");
    await vi.advanceTimersByTimeAsync(700); const version = response(); first.resolve(version); await flush();
    expect(c.fetch).toHaveBeenCalledTimes(2); expect(version.body.cancel).toHaveBeenCalledOnce();
    expect(c.fetch.mock.calls[0][1].signal).toBe(c.fetch.mock.calls[1][1].signal);
    await vi.advanceTimersByTimeAsync(300); await checked; expect(vi.getTimerCount()).toBe(0);
    second.reject(new Error("late second failure")); await flush();
  });
  it("cancels bodies promptly on both success and HTTP failure/retry", async () => {
    const { c, timers } = transport(), bodies = [response(false), response(), response(), response()];
    for (const item of bodies) c.fetch.mockResolvedValueOnce(item);
    const result = c.waitForCdpReady(7777, 1000); await flush();
    expect(bodies[0].body.cancel).toHaveBeenCalledOnce(); expect(bodies[1].body.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250); await result;
    for (const item of bodies) expect(item.body.cancel).toHaveBeenCalledOnce();
    expect(c.fetch.mock.calls.map((call: any[]) => call[0])).toEqual([
      "http://127.0.0.1:7777/json/version", "http://127.0.0.1:7777/json",
      "http://127.0.0.1:7777/json/version", "http://127.0.0.1:7777/json",
    ]);
    expect(timers.every(timer => timer.unref.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0); expect(c.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("bounds a hung body cancellation and observes its later rejection", async () => {
    const { c } = transport(), cancel = deferred<void>(), headers = response();
    headers.body.cancel.mockReturnValue(cancel.promise); c.fetch.mockResolvedValue(headers);
    const result = c.waitForCdpReady(7777, 1000), checked = expect(result).rejects.toThrow("deadline exceeded");
    await flush(); expect(headers.body.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); await checked;
    expect(c.fetch).toHaveBeenCalledTimes(1); cancel.reject(new Error("late cancellation failure")); await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("owns and cancels a response body arriving after the deadline", async () => {
    const { c } = transport(), late = deferred(), headers = response(); c.fetch.mockReturnValue(late.promise);
    const result = c.waitForCdpReady(7777, 1000), checked = expect(result).rejects.toThrow("deadline exceeded");
    await vi.advanceTimersByTimeAsync(1000); await checked;
    late.resolve(headers); await flush(); expect(headers.body.cancel).toHaveBeenCalledOnce();
    expect(c.fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not fetch or retain a timer when the total budget is already exhausted", async () => {
    const { c } = transport(); await expect(c.waitForCdpReady(7777, 0)).rejects.toThrow("did not become ready");
    expect(c.fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

function listing() {
  const cfg: any = { browserProfiles: Object.fromEntries(["p0", "p1", "p2", "p3"].map(id => [id, { name: id }])) };
  const no = vi.fn();
  const c: any = createContext({ exports: {}, path, Date, Error, AggregateError,
    execFileSync: vi.fn(() => ""), exec: vi.fn(() => { throw new Error("Async process calls forbidden"); }),
    process: { platform: "linux", kill: vi.fn() }, runningProcesses: new Map(), validateDirId: no,
    getConfig: () => cfg, getProfilesDir: () => "/synthetic/profiles", getProfileRuntimeSnapshot: () => ({}),
    fs: { existsSync: () => false }, readProfileSyncState: () => ({}), resolveProfileProxy: () => ({ mode: "none", name: null }),
    sanitizeBrowserEngine: () => "chromium", normalizeManagedChromiumVersion: () => null,
    normalizeFingerprintMode: () => "off", normalizeBoolean: (value: any) => Boolean(value), normalizeWebRtcMode: () => "real",
    normalizeGeolocationMode: () => "real", normalizeOptionalNumber: () => null, normalizeTags: () => [],
  });
  const processSource = ts.createSourceFile("process-discovery.ts", source("process-discovery.ts"), ts.ScriptTarget.Latest, true);
  // The entire real observation/cache/parser module, replacing ONLY imports
  // with the explicit pure path and synthetic exec bindings above.
  evaluate(c, processSource.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(processSource)).join("\n"));
  c.collectLinesSync = vi.fn(c.collectLinesSync);
  evaluate(c, functions(source("browser/lifecycle.ts"), ["statusBrowser"]));
  evaluate(c, functions(source("browser-manager.ts"), ["listBrowserProfiles"]));
  return { c, cfg };
}
describe("one strict process observation per profile listing", () => {
  it("shares one observation across every cold profile and refreshes the next list", () => {
    const { c } = listing(); expect(c.listBrowserProfiles()).toHaveLength(4); expect(c.execFileSync).toHaveBeenCalledTimes(1);
    c.listBrowserProfiles(); expect(c.execFileSync).toHaveBeenCalledTimes(2);
  });
  it("shares failure without downgrading unknown to positively stopped", () => {
    const { c } = listing(); c.execFileSync.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    const profiles = c.listBrowserProfiles();
    // One strict observation exhausts both existing ps providers, not 2x per profile.
    expect(c.collectLinesSync).toHaveBeenCalledTimes(1); expect(c.execFileSync).toHaveBeenCalledTimes(2);
    expect(profiles.every((profile: any) => profile.unknown === true && profile.running === false)).toBe(true);
    c.execFileSync.mockReturnValue("");
    const refreshed = c.listBrowserProfiles(); expect(c.collectLinesSync).toHaveBeenCalledTimes(2);
    expect(c.execFileSync).toHaveBeenCalledTimes(3);
    expect(refreshed.every((profile: any) => profile.unknown === undefined && profile.running === false)).toBe(true);
  });
  it("preserves an observed live owner with unknown automation endpoint", () => {
    const { c } = listing(); c.execFileSync.mockReturnValue("9000 /synthetic/chromium --user-data-dir=/synthetic/profiles/p0 --remote-debugging-port=0\n");
    const profiles = c.listBrowserProfiles(); expect(c.execFileSync).toHaveBeenCalledTimes(1);
    expect(profiles[0]).toMatchObject({ running: true, unknown: true, pid: 9000, cdpPort: null });
    expect(c.runningProcesses.has("p0")).toBe(false);
  });
  it("keeps an EPERM cached owner and does not close its bridge", () => {
    const { c, cfg } = listing(); cfg.browserProfiles = { p0: {} };
    const owner = { pid: 9001, port: 9002, process: {}, proxyBridge: { close: vi.fn() } }; c.runningProcesses.set("p0", owner);
    c.process.kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(c.listBrowserProfiles()[0]).toMatchObject({ running: true, unknown: true, pid: 9001, cdpPort: 9002 });
    expect(c.runningProcesses.get("p0")).toBe(owner); expect(owner.proxyBridge.close).not.toHaveBeenCalled();
    expect(c.execFileSync).not.toHaveBeenCalled();
  });
});
