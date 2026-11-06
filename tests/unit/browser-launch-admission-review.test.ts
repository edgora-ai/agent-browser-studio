import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";

// Safety closure: read only fixed checked-in source files. Execute COMPLETE
// production functions (not rewritten imitations) with no require/import,
// filesystem, process, browser, socket, or real fetch capability in the VM.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sources = Object.fromEntries(["browser-manager.ts", "browser-engine.ts", "browser/launch-admission.ts"]
  .map(name => [name, fs.readFileSync(path.join(root, "src/main/services", name), "utf8")]));
function declarations(file: string, names: string[]): string {
  const source = ts.createSourceFile(file, sources[file], ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production function ${name}`);
    return node.getText(source);
  }).join("\n");
}
function evaluate(context: any, text: string) {
  const result = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  expect(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
  runInContext(result.outputText, context, { timeout: 1000 });
}
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function reached(condition: () => boolean) {
  for (let n = 0; n < 150 && !condition(); n++) await Promise.resolve();
  expect(condition(), "synthetic asynchronous boundary was not reached").toBe(true);
}
const ID = "synthetic-launch-review";
function fixture(engine: "firefox" | "chromium" = "firefox") {
  const children: any[] = [], sessions = new Map<number, any>();
  const cfg = { browserProfiles: { [ID]: { engine, name: "Synthetic", fingerprintMode: "off", proxyMode: "none" } } };
  const noProxy = { mode: "none", name: null, config: null };
  const noop = vi.fn();
  const context: any = createContext({
    exports: {}, path, URL, Buffer, Error, Date, AbortController, structuredClone,
    setTimeout, clearTimeout,
    console: { log: noop, info: noop, warn: noop, error: noop },
    process: { platform: "linux", env: {}, kill: vi.fn(() => { throw new Error("Unmocked process probe is forbidden"); }) },
    fs: { openSync: vi.fn(() => 701), closeSync: vi.fn(), writeSync: vi.fn(), readFileSync: vi.fn(() => Buffer.from("synthetic prefs")), existsSync: vi.fn(() => true) },
    getConfig: () => cfg, getProfilesDir: () => "/synthetic/profiles", getAppDataDir: () => "/synthetic/state",
    getLaunchLogPath: () => "/synthetic/launch.log", validateDirId: noop, isManagedProfileId: () => true,
    acquireRestoreLock: vi.fn(() => context.release), release: vi.fn(), assertHostPlatformCompatible: noop,
    sanitizeBrowserEngine: (value: string) => value, normalizeFingerprintMode: () => "off",
    getChromiumBinaryOverride: () => null, assertChromiumReuseDnsCompatible: noop,
    chromiumLaunchRequestHash: () => "request", firefoxLaunchRequestHash: () => "request",
    getFirefoxBinaryOverride: () => null, getManagedFirefoxRoot: () => "/synthetic/firefox",
    firefoxNativeModeRequested: () => false, runningProcesses: new Map(), ownedFirefoxLaunches: new WeakMap(),
    inspectBrowserLaunchesSync: () => ({ available: true, candidates: [], tracked: null }), findBrowserByProfile: () => null,
    findFirefoxBinaryAsync: vi.fn(async () => "/synthetic/firefox"), getFirefoxNativeSelectionIdentityAsync: vi.fn(async () => "binary"),
    detectFirefoxVersionAsync: async () => "154.0", normalizeFirefoxVersion: (v: string) => v,
    readFirefoxNativeCapabilityReportAsync: async () => ({ capabilities: [] }),
    FIREFOX_NATIVE_CONFIG_CAPABILITIES: ["config"], FIREFOX_NATIVE_PARITY_CAPABILITIES: ["parity"],
    normalizeBrowserProcessPath: (value: string) => value, resolveFirefoxProxy: () => noProxy,
    assertFirefoxProxyCurrent: noop, assertProxyLaunchable: vi.fn(async () => {}),
    resolveFirefoxLaunchIdentity: async (meta: any) => ({ meta, observation: null, observedAt: null, target: null }),
    firefoxEffectiveLaunchHash: () => "effective", normalizeWebRtcMode: () => "real", runConsistencyGate: noop,
    resolveFirefoxWebRtcRoutingPolicy: () => ({}), normalizeBoolean: (value: any) => Boolean(value),
    writeFirefoxUserJs: vi.fn(), firefoxWebRtcCheckpointHash: () => "checkpoint", firefoxLaunchDigest: () => "digest",
    findFreePortWithRetry: vi.fn(async () => 9001), buildFirefoxLaunchArgs: () => ["-profile", "/synthetic/profiles/" + ID, "--remote-debugging-port", "9001"],
    maskSensitiveLaunchArgs: (args: string[]) => args, captureLaunchProxySnapshot: () => ({ mode: "none", source: "fresh-launch" }),
    getRegisteredFirefoxSession: (port: number) => sessions.get(port), registerFirefoxSession: (port: number, conn: any) => sessions.set(port, conn),
    dropFirefoxSession: vi.fn((port: number) => sessions.delete(port)),
    connectBidi: vi.fn(async () => ({ closed: false, close: vi.fn(), wsUrl: "ws://127.0.0.1:9001/session" })),
    readQueuedCookieImports: () => [], runFingerprintDriftGuard: vi.fn(async () => ({ checked: false })),
    fingerprintComparisonRecorder: () => noop, recordAudit: vi.fn(), emitEvent: vi.fn(),
    restartRequired: (message: string) => Object.assign(new Error(message), { code: "PROFILE_RESTART_REQUIRED" }),
    findManagedChromiumBinaryAsync: vi.fn(async () => ({ binaryPath: "/synthetic/chromium" })),
    normalizeManagedChromiumVersion: () => null, normalizeFingerprintSeed: (v: any) => v, normalizePlatform: (v: any) => v,
    resolveProfileProxySecret: () => noProxy, assertProxyResolvable: noop, resolveChromiumDnsPolicy: () => ({ route: "direct" }),
    normalizeOptionalIp: () => null, buildBrowserLaunchArgs: () => ["--user-data-dir=/synthetic/profiles/" + ID],
    dedupeChromeArgs: (args: string[]) => args, detectBinaryVersionAsync: async () => "154.0",
    stripManagedFingerprintArgs: (args: string[]) => args, supportsGoogleApiKeyInfoBarSuppression: () => false,
    resolveChromiumWebRtcLaunchPolicy: () => ({}), resolveWindowTitlePrefix: () => null,
    addExtensionArgs: noop, addDrmArgs: noop, sanitizeAppUrl: () => null, validateChromiumWebRtcPreferences: noop,
    patchThirdPartyCookieCompatibility: noop, applyChromiumWebRtcPreferences: () => ({ directorySynced: true }),
    prepareChromiumDiagnosticNetLogArgs: () => [], chromiumWebRtcRoutingArgs: () => [], assertChromiumWebRtcLaunchPolicy: noop,
    stampChromiumLaunch: () => ({}), chromiumLaunchStampArg: () => "--synthetic-stamp",
    waitForCdpReady: vi.fn(async () => {}), runEnvironmentRiskGuard: () => ({ checked: false }),
    BrowserWindow: { getAllWindows: () => [] }, LaunchBlockedError: class extends Error {},
    extractBidiWebSocketUrl: (text: string) => /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(text)?.[1] || null,
    extractMarionettePort: () => null,
    spawn: vi.fn((bin: string, args: string[]) => {
      const child: any = new EventEmitter();
      Object.assign(child, { pid: 8000 + children.length, spawnargs: [bin, ...args], exitCode: null, signalCode: null, killed: false,
        stdout: new EventEmitter(), stderr: new EventEmitter(), unref: vi.fn(),
        kill: vi.fn((signal = "SIGTERM") => { child.killed = true; child.signalCode = signal; child.emit("exit", null, signal); return true; }),
      });
      children.push(child); return child;
    }),
  });
  evaluate(context, sources["browser/launch-admission.ts"]);
  evaluate(context, declarations("browser-engine.ts", ["spawnFirefoxWithDebugInfo"]));
  evaluate(context, declarations("browser-manager.ts", ["launchBrowser", "launchFirefoxProfile", "ownedChromiumLaunchEvidence", "assertOwnedBrowserLaunch", "cleanupFailedBrowserLaunch", "sleep"]));
  const announce = (port = 9001) => children[0].stderr.emit("data", Buffer.from(`WebDriver BiDi listening on ws://127.0.0.1:${port}/session`));
  return { c: context, children, sessions, cfg, announce };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("sticky shutdown admission on actual launch functions", () => {
  it.each(["firefox", "chromium"] as const)("rejects fresh %s entry before any resource acquisition", async engine => {
    const { c } = fixture(engine);
    c.closeBrowserLaunchAdmission(); c.closeBrowserLaunchAdmission();
    await expect(c.launchBrowser(ID)).rejects.toMatchObject({ code: "APP_SHUTTING_DOWN" });
    expect(c.acquireRestoreLock).not.toHaveBeenCalled(); expect(c.spawn).not.toHaveBeenCalled();
    expect(() => c.assertBrowserLaunchAllowed()).toThrow("shutting down");
  });
  it.each(["firefox", "chromium"] as const)("rechecks %s after asynchronous binary preparation", async engine => {
    const { c } = fixture(engine), pending = deferred();
    const binary = engine === "firefox" ? c.findFirefoxBinaryAsync : c.findManagedChromiumBinaryAsync;
    binary.mockReturnValueOnce(pending.promise);
    const result = c.launchBrowser(ID); const checked = expect(result).rejects.toMatchObject({ code: "APP_SHUTTING_DOWN" });
    await reached(() => binary.mock.calls.length === 1);
    c.closeBrowserLaunchAdmission(); pending.resolve(engine === "firefox" ? "/synthetic/firefox" : { binaryPath: "/synthetic/chromium" });
    await checked; expect(c.spawn).not.toHaveBeenCalled(); expect(c.release).toHaveBeenCalledTimes(1);
  });
  it.each(["firefox", "chromium"] as const)("rechecks %s after the late free-port await", async engine => {
    const { c } = fixture(engine), pending = deferred<number>(); c.findFreePortWithRetry.mockReturnValueOnce(pending.promise);
    const result = c.launchBrowser(ID); const checked = expect(result).rejects.toMatchObject({ code: "APP_SHUTTING_DOWN" });
    await reached(() => c.findFreePortWithRetry.mock.calls.length === 1);
    c.closeBrowserLaunchAdmission(); pending.resolve(9001); await checked;
    expect(c.spawn).not.toHaveBeenCalled(); expect(c.release).toHaveBeenCalledTimes(1);
  });
  it("includes an actually spawned Firefox in the snapshot BEFORE readiness returns", async () => {
    const f = fixture(), result = f.c.launchBrowser(ID);
    const checked = expect(result).rejects.toMatchObject({ code: "APP_SHUTTING_DOWN" });
    await reached(() => f.children.length === 1);
    const owner = f.c.runningProcesses.get(ID);
    expect(owner.process).toBe(f.children[0]); expect(owner.port).toBe(9001);
    expect(f.c.emitEvent).not.toHaveBeenCalled();
    f.c.closeBrowserLaunchAdmission();
    const snapshot = [...f.c.runningProcesses.values()]; expect(snapshot).toEqual([owner]);
    owner.stopping = true; f.announce(9002); await checked;
    expect(f.c.runningProcesses.get(ID)).toBe(owner); expect(owner.port).toBe(9001);
    expect(f.children[0].kill).not.toHaveBeenCalled(); // shutdown driver retains ownership
    expect(f.c.connectBidi).not.toHaveBeenCalled(); expect(f.c.emitEvent).not.toHaveBeenCalled();
    f.children[0].kill(); expect(f.c.runningProcesses.size).toBe(0);
    expect(f.c.fs.closeSync).toHaveBeenCalledTimes(1);
  });
  it("keeps an owned Chromium in the snapshot across CDP verification", async () => {
    const { c, children } = fixture("chromium"), ready = deferred<void>(); c.waitForCdpReady.mockReturnValue(ready.promise);
    const result = c.launchBrowser(ID), checked = expect(result).rejects.toMatchObject({ code: "APP_SHUTTING_DOWN" });
    await reached(() => c.waitForCdpReady.mock.calls.length === 1);
    const owner = c.runningProcesses.get(ID); expect(owner.process).toBe(children[0]);
    c.closeBrowserLaunchAdmission(); owner.stopping = true; ready.resolve(); await checked;
    expect(c.runningProcesses.get(ID)).toBe(owner); expect(c.emitEvent).not.toHaveBeenCalled();
    expect(children[0].kill).not.toHaveBeenCalled(); children[0].kill();
    expect(c.runningProcesses.size).toBe(0); expect(c.fs.closeSync).toHaveBeenCalledTimes(1);
  });
  it("does not delete a replacement owner when old Firefox readiness fails", async () => {
    const f = fixture(), result = f.c.launchBrowser(ID), checked = expect(result).rejects.toThrow("owned browser session changed");
    await reached(() => f.children.length === 1);
    const replacement = { pid: f.children[0].pid, process: {}, port: 9001, bidiConn: { close: vi.fn() } };
    f.c.runningProcesses.set(ID, replacement); f.sessions.set(9001, replacement.bidiConn);
    f.announce(); await checked;
    expect(f.c.runningProcesses.get(ID)).toBe(replacement); expect(replacement.bidiConn.close).not.toHaveBeenCalled();
    expect(f.sessions.get(9001)).toBe(replacement.bidiConn); expect(f.children[0].kill).toHaveBeenCalledOnce();
    expect(f.c.emitEvent).not.toHaveBeenCalled();
  });
  it("closes only a late owned BiDi connection, not a replacement session", async () => {
    const f = fixture(), pending = deferred(); f.c.connectBidi.mockReturnValue(pending.promise);
    const result = f.c.launchBrowser(ID), checked = expect(result).rejects.toThrow("owned browser session changed");
    await reached(() => f.children.length === 1); f.announce(); await reached(() => f.c.connectBidi.mock.calls.length === 1);
    const replacement = { pid: 90000, process: {}, port: 9001, bidiConn: { close: vi.fn() } };
    f.c.runningProcesses.set(ID, replacement); f.sessions.set(9001, replacement.bidiConn);
    const late = { closed: false, close: vi.fn() }; pending.resolve(late); await checked;
    expect(late.close).toHaveBeenCalledOnce(); expect(replacement.bidiConn.close).not.toHaveBeenCalled();
    expect(f.sessions.get(9001)).toBe(replacement.bidiConn); expect(f.c.runningProcesses.get(ID)).toBe(replacement);
  });
  it.each(["firefox", "chromium"] as const)("emits one successful %s launch event and no duplicate", async engine => {
    const f = fixture(engine), result = f.c.launchBrowser(ID);
    if (engine === "firefox") { await reached(() => f.children.length === 1); f.announce(); }
    const success = await result;
    expect(f.c.emitEvent.mock.calls).toEqual([["profile:launched", { dirId: ID, pid: success.pid, cdpPort: success.cdpPort }]]);
    if (engine === "firefox") { f.announce(); await Promise.resolve(); expect(f.c.emitEvent).toHaveBeenCalledTimes(1); }
    f.children[0].kill();
  });
  it.each(["firefox", "chromium"] as const)("never emits %s success when a final launch audit fails", async engine => {
    const f = fixture(engine); f.c.recordAudit.mockImplementation((record: any) => { if (record.action === "launch") throw new Error("synthetic audit failure"); });
    const result = f.c.launchBrowser(ID), checked = expect(result).rejects.toThrow("synthetic audit failure");
    if (engine === "firefox") { await reached(() => f.children.length === 1); f.announce(); }
    await checked;
    expect(f.c.emitEvent).not.toHaveBeenCalled(); expect(f.children[0].kill).toHaveBeenCalledOnce();
  });
  it.each(["firefox", "chromium"] as const)("does not publish %s success when shutdown begins during drift verification", async engine => {
    const f = fixture(engine), drift = deferred(); f.c.runFingerprintDriftGuard.mockReturnValue(drift.promise);
    const result = f.c.launchBrowser(ID), checked = expect(result).rejects.toMatchObject({ code: "APP_SHUTTING_DOWN" });
    if (engine === "firefox") { await reached(() => f.children.length === 1); f.announce(); }
    await reached(() => f.c.runFingerprintDriftGuard.mock.calls.length === 1);
    const owner = f.c.runningProcesses.get(ID); f.c.closeBrowserLaunchAdmission(); owner.stopping = true;
    drift.resolve({ checked: false }); await checked;
    expect(f.c.runningProcesses.get(ID)).toBe(owner); expect(f.c.emitEvent).not.toHaveBeenCalled();
    expect(f.children[0].kill).not.toHaveBeenCalled();
    if (engine === "firefox") expect(owner.bidiConn.close).not.toHaveBeenCalled();
    f.children[0].kill(); expect(f.c.runningProcesses.size).toBe(0);
  });
  it("does not delete or notify a replacement owner after old Chromium verification fails", async () => {
    const f = fixture("chromium"), ready = deferred<void>(); f.c.waitForCdpReady.mockReturnValue(ready.promise);
    const result = f.c.launchBrowser(ID), checked = expect(result).rejects.toThrow("owned browser session changed");
    await reached(() => f.c.waitForCdpReady.mock.calls.length === 1);
    const replacement = { pid: f.children[0].pid, process: {}, port: 9001, proxyBridge: { close: vi.fn() } };
    f.c.runningProcesses.set(ID, replacement); ready.resolve(); await checked;
    expect(f.c.runningProcesses.get(ID)).toBe(replacement); expect(replacement.proxyBridge.close).not.toHaveBeenCalled();
    expect(f.c.emitEvent).not.toHaveBeenCalled(); expect(f.children[0].kill).toHaveBeenCalledOnce();
  });
  it("does not interpret a live Chromium child signal error as stopped", async () => {
    const f = fixture("chromium"), ready = deferred<void>(); f.c.waitForCdpReady.mockReturnValue(ready.promise);
    const result = f.c.launchBrowser(ID), checked = expect(result).rejects.toMatchObject({ code: "APP_SHUTTING_DOWN" });
    await reached(() => f.c.waitForCdpReady.mock.calls.length === 1);
    const owner = f.c.runningProcesses.get(ID); owner.proxyBridge = { close: vi.fn(async () => {}) };
    f.children[0].emit("error", Object.assign(new Error("synthetic signal refusal"), { code: "EPERM" }));
    expect(f.c.runningProcesses.get(ID)).toBe(owner); expect(owner.proxyBridge.close).not.toHaveBeenCalled();
    f.c.closeBrowserLaunchAdmission(); owner.stopping = true; ready.resolve(); await checked;
    expect(f.c.runningProcesses.get(ID)).toBe(owner); f.children[0].kill();
    expect(owner.proxyBridge.close).toHaveBeenCalledOnce();
  });
  it("cleans the actually spawned Firefox after endpoint timeout without a success event", async () => {
    const f = fixture(), result = f.c.launchBrowser(ID), checked = expect(result).rejects.toThrow("timed out waiting");
    await reached(() => f.children.length === 1); expect(f.c.runningProcesses.has(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); await checked;
    expect(f.children[0].kill).toHaveBeenCalledOnce(); expect(f.c.runningProcesses.has(ID)).toBe(false);
    expect(f.c.emitEvent).not.toHaveBeenCalled(); expect(f.c.fs.closeSync).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps uncertain owned process state if both termination signals are refused", async () => {
    const f = fixture(), child = f.c.spawn("/synthetic/firefox", []);
    child.kill.mockImplementation(() => false);
    const connection = { close: vi.fn() }, bridge = { close: vi.fn(async () => {}) };
    const owner = { pid: child.pid, process: child, port: 9001, bidiConn: connection, proxyBridge: bridge };
    f.c.runningProcesses.set(ID, owner); f.sessions.set(9001, connection);
    const result = f.c.cleanupFailedBrowserLaunch(ID, child, 9001);
    await vi.advanceTimersByTimeAsync(4000); await result;
    expect(f.c.runningProcesses.get(ID)).toBe(owner); expect(owner).toMatchObject({ stopping: true });
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(connection.close).toHaveBeenCalledOnce(); expect(bridge.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the actual Firefox helper timer and kills only its child if the synchronous hook throws", async () => {
    const f = fixture(), failure = new Error("hook rejected");
    const result = f.c.spawnFirefoxWithDebugInfo("/synthetic/firefox", [], { onSpawn: (child: any) => {
      expect(child.listenerCount("error")).toBe(1); expect(child.listenerCount("exit")).toBe(1); throw failure;
    } });
    await expect(result).rejects.toBe(failure);
    expect(f.children[0].kill).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
