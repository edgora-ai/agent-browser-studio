// Stage 3 AUTHOR-ONLY preparation. UNRUN feature tests for the intended new
// coordinator; missing modules/APIs are assumptions, not existing-product RED.
// Do not execute until main grants the source-stable validation handoff.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChildProcess } from "node:child_process";
import type { ProfileHealthEntry } from "../../src/main/types.js";
import type {
  NetworkCounts, NetworkCoverage, NetworkObservationPayload, NetworkObservationSummary,
  ObservedNetworkHop, NetworkHttpStatusEvidence,
} from "../../src/main/services/network-diagnostics-contract.js";
import { normalizeNetworkObservationSummary } from "../../src/main/services/network-diagnostics-contract.js";

const h = vi.hoisted(() => {
  const actual = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const tmp = process.env.TMPDIR;
  if (!tmp || !path.isAbsolute(tmp) || actual.lstatSync(tmp).isSymbolicLink() || !actual.lstatSync(tmp).isDirectory()) {
    throw new Error("A real runner-owned TMPDIR is required for network diagnostics unit fixtures");
  }
  const root = actual.mkdtempSync(path.join(tmp, "profile-network-unit-"));
  actual.chmodSync(root, 0o700);
  const identity = actual.lstatSync(root);
  const forbidden = vi.fn((capability: unknown) => { throw new Error(`Undeclared network-unit capability: ${String(capability)}`); });
  const fds = new Set<number>();
  const importRealpaths: { input: string; resolved: string; stack: string }[] = [];
  const assertPath = (input: unknown) => {
    if (typeof input === "number") {
      if (!fds.has(input)) forbidden("unowned file descriptor");
      return;
    }
    if (typeof input !== "string" && !Buffer.isBuffer(input)) forbidden("nonlocal filesystem path");
    const raw = String(input);
    if (!path.isAbsolute(raw) || raw.split(path.sep).some(part => part === "." || part === "..")) forbidden("noncanonical filesystem path");
    const resolved = path.resolve(raw);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) forbidden("filesystem path outside owned fixture");
    const current = actual.lstatSync(root);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) forbidden("replaced fixture root");
    let currentPath = root;
    for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
      currentPath = path.join(currentPath, part);
      try {
        if (actual.lstatSync(currentPath).isSymbolicLink()) forbidden("filesystem symlink");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        break;
      }
    }
  };
  // Only synchronous owned config IO is admitted. Unknown functions, async IO,
  // links, streams, watchers and descriptors cannot escape through a catch.
  const pathOps = new Set(["accessSync", "appendFileSync", "chmodSync", "existsSync", "lstatSync", "mkdirSync", "readdirSync", "readFileSync", "rmSync", "rmdirSync", "statSync", "unlinkSync", "writeFileSync"]);
  const fdOps = new Set(["fstatSync", "fsyncSync", "fdatasyncSync", "fchmodSync", "readSync", "writeSync"]);
  const guarded: Record<string, any> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (name === "promises") { guarded[name] = { readFile: forbidden, writeFile: forbidden, mkdir: forbidden, readdir: forbidden, stat: forbidden, lstat: forbidden, open: forbidden, rename: forbidden, rm: forbidden }; continue; }
    if (typeof value !== "function") { guarded[name] = value; continue; }
    // profile-data-revision imports zip-writer, whose TEMP_ROOTS initializer
    // resolves os.tmpdir() once. That mock is this exact owned root: no other
    // realpath input, options, repeat call or generic path capability is allowed.
    if (name === "realpathSync") guarded[name] = (...args: unknown[]) => {
      if (args.length !== 1 || args[0] !== root || importRealpaths.length !== 0) return forbidden("fs.realpathSync outside one owned temporary-root import");
      assertPath(root);
      const stack = new Error("owned temporary-root realpath import").stack || "";
      const resolved = actual.realpathSync(root);
      if (resolved !== root) return forbidden("fs.realpathSync resolved outside the exact owned root");
      assertPath(resolved);
      importRealpaths.push({ input: root, resolved, stack });
      return resolved;
    };
    else if (name === "openSync") guarded[name] = (...args: any[]) => { assertPath(args[0]); const fd = (value as Function)(...args); fds.add(fd); return fd; };
    else if (name === "closeSync") guarded[name] = (fd: number) => { assertPath(fd); const result = actual.closeSync(fd); fds.delete(fd); return result; };
    else if (name === "renameSync") guarded[name] = (from: fs.PathLike, to: fs.PathLike) => {
      assertPath(from); assertPath(to);
      if (state.failRename && String(to) === path.join(root, "config.json")) throw Object.assign(new Error("owned config rename refused"), { code: "EIO" });
      return actual.renameSync(from, to);
    };
    else if (pathOps.has(name) || fdOps.has(name)) guarded[name] = (...args: any[]) => { assertPath(args[0]); return (value as Function)(...args); };
    else if (["Dirent", "Stats", "ReadStream", "WriteStream"].includes(name)) guarded[name] = name.endsWith("Stream") ? forbidden : value;
    else guarded[name] = (..._args: unknown[]) => forbidden(`fs.${name}`);
  }
  const state = { failRename: false };
  return {
    root, identity, fds, importRealpaths, forbidden, state, fs: { ...guarded, default: guarded },
    list: vi.fn(), create: vi.fn(), status: vi.fn(),
    declaredPids: new Set<number>(), deadPids: new Set<number>(),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(`synthetic:${text}`), decryptString: (bytes: Buffer) => {
      const text = bytes.toString("utf8");
      if (!text.startsWith("synthetic:")) throw new Error("Nonfixture safeStorage envelope");
      return text.slice("synthetic:".length);
    } },
  };
});
vi.mock("node:fs", () => h.fs);
vi.mock("node:fs/promises", () => ({ readFile: h.forbidden, writeFile: h.forbidden, mkdir: h.forbidden, readdir: h.forbidden, stat: h.forbidden, lstat: h.forbidden, open: h.forbidden, rename: h.forbidden, rm: h.forbidden }));
vi.mock("electron", () => ({
  app: { getPath: (name: string) => {
    if (name === "userData" || name === "home") return h.root;
    return h.forbidden(`Electron path ${name}`);
  } },
  BrowserWindow: { getAllWindows: () => [] }, safeStorage: h.safeStorage,
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden, execFileSync: h.forbidden,
  spawn: h.forbidden, spawnSync: h.forbidden, fork: h.forbidden,
}));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(),
  homedir: () => h.root, tmpdir: () => h.root, hostname: () => "synthetic-network-unit", networkInterfaces: h.forbidden, userInfo: h.forbidden,
}));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), connect: h.forbidden, createConnection: h.forbidden, createServer: h.forbidden, Socket: h.forbidden }));
vi.mock("node:tls", () => ({ connect: h.forbidden, createServer: h.forbidden, TLSSocket: h.forbidden }));
vi.mock("node:http", () => ({ get: h.forbidden, request: h.forbidden, createServer: h.forbidden }));
vi.mock("node:https", () => ({ get: h.forbidden, request: h.forbidden, createServer: h.forbidden }));
vi.mock("node:dns", () => ({ lookup: h.forbidden, resolve: h.forbidden, resolve4: h.forbidden, resolve6: h.forbidden, getServers: h.forbidden, Resolver: h.forbidden }));
vi.mock("node:dns/promises", () => ({ lookup: h.forbidden, resolve: h.forbidden, resolve4: h.forbidden, resolve6: h.forbidden, Resolver: h.forbidden }));
vi.mock("node:dgram", () => ({ createSocket: h.forbidden }));
vi.mock("ws", () => ({ default: h.forbidden, WebSocket: h.forbidden, WebSocketServer: h.forbidden }));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  statusBrowser: h.status, launchBrowser: h.forbidden, stopBrowser: h.forbidden,
  getRuntime: h.forbidden, getRuntimeChromiumStatusAsync: h.forbidden, getEngineStatusAsync: h.forbidden,
  getProfileRuntimeSnapshot: h.forbidden, listBrowserProfiles: h.forbidden,
}));
vi.mock("../../src/main/services/page-eval.js", () => ({ evaluateInPage: h.forbidden, navigateInPage: h.forbidden, getProfileEngineByDirId: h.forbidden }));
vi.mock("../../src/main/services/bidi-client.js", () => ({ connectBidi: h.forbidden, getFirefoxSession: h.forbidden, registerFirefoxSession: h.forbidden, dropFirefoxSession: h.forbidden }));
vi.mock("../../src/main/services/browser/cdp-network-observer.js", () => ({ listNetworkPageTargets: h.list, createNetworkPageObserver: h.create }));

import {
  getConfig, getConfigPath, getProfileHealthHistory, reloadConfig, saveConfig,
  setProfileMeta, mergeConfigForStore,
} from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import {
  beginProfileHealthRun, cancelProfileHealthRun, clearProfileHealthHistory,
  listProfileHealthHistory, recordProfileHealthResult,
} from "../../src/main/services/profile-health.js";
import { runningProcesses, captureLaunchProxySnapshot, type RunningEntry } from "../../src/main/services/browser/runtime-table.js";
import { initializeSecretStorage, resetSecretStorageForTests } from "../../src/main/services/secrets.js";
import { listProfileNetworkPages, runProfileNetworkObservation } from "../../src/main/services/profile-network-diagnostics.js";

const ID = "ab_network_application";
const OWNER = "ipc:501";
const AT = 1_792_387_200_000;
const PORT = 45681;
const PRIVATE = "__NETWORK_APPLICATION_PRIVATE_SENTINEL__";
const SELECTED_ORIGIN = "https://selected-network.fixture.test";
const REQUEST_ORIGIN = "https://cross-origin-network.fixture.test";
const SUMMARY_CODE = "NETWORK_OBSERVATION_V1";
const COUNT_KEYS = ["requests", "hops", "responses", "finished", "failed", "blocked", "requestCancelled", "redirects", "http4xx", "http5xx", "pending", "cache", "serviceWorker", "unattributed", "cspIssues"].sort();
const COVERAGE_KEYS = ["network", "csp", "worker", "oopif", "console", "storage", "frames", "bridgeHop", "upstreamHop"].sort();
const SUMMARY_KEYS = ["version", "completion", "stopReason", "armedAt", "endedAt", "durationMs", "counts", "coverage"].sort();
const ENTRY_KEYS = ["kind", "at", "outcome", "summary", "source", "requestId", "networkSummary"].sort();
type Target = { id: string; origin: string; webSocketDebuggerUrl: string };
type Armed = { armedAt: number; observeForMs: 10000 };
type ListOptions = { signal?: AbortSignal; assertCurrent: () => void; deadline: number };
type ObserverOptions = { signal?: AbortSignal; assertCurrent: () => void; deadline: number; onArmed?: (event: Armed) => void };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function coverage(): NetworkCoverage {
  return { network: "observed", csp: "unavailable", worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" };
}
function counts(): NetworkCounts {
  return { requests: 1, hops: 1, responses: 1, finished: 1, failed: 0, blocked: 0, requestCancelled: 0, redirects: 0, http4xx: 0, http5xx: 0, pending: 0, cache: 0, serviceWorker: 0, unattributed: 0, cspIssues: 0 };
}
function summary(armedAt = AT): NetworkObservationSummary {
  return { version: 1, completion: "completed", stopReason: "window-ended", armedAt, endedAt: armedAt + 10_000, durationMs: 10_000, counts: counts(), coverage: coverage() };
}
function hop(overrides: Partial<ObservedNetworkHop> = {}): ObservedNetworkHop {
  return { id: "hop-local-1", chainId: "chain-local-1", redirectedFrom: null, origin: REQUEST_ORIGIN, method: "GET", resourceType: "Fetch", status: 200, networkStatus: null, terminal: "finished", errorCode: null, blockedReason: null, corsReason: null, fromDiskCache: false, fromServiceWorker: false, fromPrefetchCache: null, servedFromCache: false, ...overrides };
}
function payload(armedAt = AT): NetworkObservationPayload { return { observation: summary(armedAt), hops: [hop()], httpStatusEvidence: [] }; }
function stoppedPayload(armedAt: number, endedAt: number, reason: "cancelled" | "target-changed" | "cleanup-unverified"): NetworkObservationPayload {
  const value = payload(armedAt);
  value.observation = { ...value.observation, completion: reason === "cancelled" ? "cancelled" : "partial", stopReason: reason,
    endedAt, durationMs: endedAt - armedAt, coverage: { ...value.observation.coverage, network: "partial" } };
  return value;
}
function targets(size = 1): Target[] {
  return Array.from({ length: size }, (_, index) => ({ id: `target-${index}-${PRIVATE}`, origin: SELECTED_ORIGIN, webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/target-${index}-${PRIVATE}` }));
}
let pageTargets: Target[];
const controls: ReturnType<typeof observer>[] = [];
const operations = new Set<Promise<unknown>>();
function observer(port: number, target: Target, options: ObserverOptions) {
  const result = deferred<NetworkObservationPayload>();
  const closed = deferred<void>();
  let cleanupVerified = false;
  let armedAt: number | undefined;
  let resultResolved = false;
  let closedResolved = false;
  const handle = { result: result.promise, closed: closed.promise, get cleanupVerified() { return cleanupVerified; } };
  return {
    port, target, options, handle,
    arm() { options.assertCurrent(); armedAt = Date.now(); options.onArmed?.({ armedAt, observeForMs: 10_000 }); return armedAt; },
    close() { if (!closedResolved) { cleanupVerified = true; closedResolved = true; closed.resolve(); } },
    complete(value = payload(armedAt ?? Date.now()), close = true) {
      if (close && !closedResolved) { cleanupVerified = true; closedResolved = true; closed.resolve(); }
      if (!resultResolved) { resultResolved = true; vi.setSystemTime(Math.max(Date.now(), value.observation.endedAt)); result.resolve(value); }
    },
  };
}
function track<T>(promise: Promise<T>): Promise<T> {
  operations.add(promise);
  promise.then(() => operations.delete(promise), () => operations.delete(promise));
  return promise;
}
async function flush() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
async function entered(count = controls.length + 1) { await flush(); expect(controls).toHaveLength(count); return controls[count - 1]; }
function owned(dirId = ID, port = PORT, pid = 980_501): RunningEntry {
  const child = new ChildProcess(); // Deliberately inert: no spawn, fork or OS child.
  Object.defineProperty(child, "pid", { value: pid, writable: true, configurable: true });
  child.exitCode = null; child.signalCode = null; child.killed = false;
  child.kill = h.forbidden as typeof child.kill;
  child.disconnect = h.forbidden;
  h.declaredPids.add(pid);
  const entry: RunningEntry = { pid, process: child, port, engine: "chromium", lastActivityAt: 1,
    launchProxy: captureLaunchProxySnapshot({ mode: "none", name: null, config: null }), proxyBridge: { close: h.forbidden } };
  runningProcesses.set(dirId, entry);
  return entry;
}
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const history = () => listProfileHealthHistory(ID).filter(entry => entry.kind === "network");
async function selection(dirId = ID, owner = OWNER) {
  const listed = await listProfileNetworkPages(dirId, { owner });
  expect(listed.ok).toBe(true); expect(listed.pages.length).toBeGreaterThan(0);
  return listed.pages[0].handle;
}
async function start(requestId: string, options: Record<string, unknown> = {}, dirId = ID) {
  const selected = await selection(dirId);
  const offset = controls.length;
  const operation = track(runProfileNetworkObservation(dirId, { selection: selected, requestId, owner: OWNER, ...options }));
  const control = await entered(offset + 1);
  return { operation, control, selected };
}
async function observe(requestId: string, value?: NetworkObservationPayload) {
  const current = await start(requestId);
  const armedAt = current.control.arm();
  current.control.complete(value ?? payload(armedAt));
  return current.operation;
}
function networkEntry(requestId: string, at = AT, observation = summary()): ProfileHealthEntry {
  return { kind: "network", at, outcome: "inconclusive", source: "runtime", summary: SUMMARY_CODE, requestId, networkSummary: observation };
}
function expectSafeSummary(value: NetworkObservationSummary) {
  expect(Object.keys(value).sort()).toEqual(SUMMARY_KEYS);
  expect(Object.keys(value.counts).sort()).toEqual(COUNT_KEYS);
  expect(Object.keys(value.coverage).sort()).toEqual(COVERAGE_KEYS);
  for (const item of Object.values(value.coverage)) expect(typeof item).toBe("string");
  expect(value.coverage).toMatchObject({ worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(AT);
  h.state.failRename = false;
  h.forbidden.mockClear(); h.list.mockReset(); h.create.mockReset(); h.status.mockReset();
  h.status.mockImplementation(() => h.forbidden("statusBrowser/discovery"));
  h.declaredPids.clear(); h.deadPids.clear(); runningProcesses.clear(); controls.length = 0;
  for (const name of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, name), { recursive: true, force: true });
  initializeSecretStorage({ backend: "os", reason: "synthetic unit fixture only", userDataDir: h.root, keyPath: path.join(h.root, "unused-key") }, { osStorage: h.safeStorage });
  reloadConfig(); getConfig();
  transact(draft => { draft.browserProfiles[ID] = { name: "Owned network fixture", engine: "chromium", fingerprintMode: "off", proxyMode: "none", note: "preserve unrelated profile data", updatedAt: 1 }; });
  owned(); pageTargets = targets();
  h.list.mockImplementation(async (port: number, options: ListOptions) => {
    expect(port).toBeGreaterThan(0); expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.deadline).toBeLessThanOrEqual(Date.now() + 5_000);
    options.assertCurrent();
    return structuredClone(pageTargets).map(target => {
      const address = new URL(target.webSocketDebuggerUrl); address.port = String(port);
      return { ...target, webSocketDebuggerUrl: address.href };
    });
  });
  h.create.mockImplementation(async (port: number, target: Target, options: ObserverOptions) => {
    options.assertCurrent();
    const control = observer(port, target, options); controls.push(control); return control.handle;
  });
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: unknown) => {
    if (signal !== 0 || !h.declaredPids.has(pid)) return h.forbidden("nonfixture process signal");
    if (h.deadPids.has(pid)) throw Object.assign(new Error("Declared fake PID is absent"), { code: "ESRCH" });
    return true;
  }) as typeof process.kill);
  vi.stubGlobal("fetch", h.forbidden); vi.stubGlobal("WebSocket", h.forbidden);
});
afterEach(async () => {
  h.state.failRename = false;
  for (const control of controls) control.complete(payload(), true);
  await flush(); await Promise.allSettled([...operations]); await flush();
  const openFds = [...h.fds];
  runningProcesses.clear(); resetSecretStorageForTests();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  expect(openFds).toEqual([]); expect(h.forbidden).not.toHaveBeenCalled();
});
afterAll(() => {
  const current = fs.lstatSync(h.root);
  if (current.isSymbolicLink() || current.dev !== h.identity.dev || current.ino !== h.identity.ino || !path.basename(h.root).startsWith("profile-network-unit-")) throw new Error("Unsafe network fixture cleanup");
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("owned-runtime-only page selection, without discovery or observation", () => {
  it("the real revision dependency resolves only the owned temporary root once at zip-writer import", () => {
    expect(h.importRealpaths).toHaveLength(1);
    expect(h.importRealpaths[0]).toMatchObject({ input: h.root, resolved: h.root });
    const caller = h.importRealpaths[0].stack.split("\n").find(line => line.includes("/src/main/services/zip-writer.ts:"));
    expect(caller).toEqual(expect.any(String));
    console.info("[network-unit owned import] " + caller!.trim());
  });

  it("lists opaque one-use UUIDs and safe origins, never target/debugger data, and does not write or observe", async () => {
    const before = fs.readFileSync(getConfigPath());
    const reply = await listProfileNetworkPages(ID, { owner: OWNER });
    expect(reply).toMatchObject({ ok: true, pages: [{ origin: SELECTED_ORIGIN, ordinal: 1, handle: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) }] });
    expect(Object.keys(reply.pages[0]).sort()).toEqual(["handle", "ordinal", "origin"]);
    expect(JSON.stringify(reply)).not.toContain(PRIVATE);
    expect(JSON.stringify(reply)).not.toContain("webSocketDebuggerUrl");
    expect(h.create).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled();
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(history()).toEqual([]);
    const lease = beginProfileHealthRun(ID, "network", { owner: OWNER });
    try { lease.assertCurrent(); expect(h.status).not.toHaveBeenCalled(); } finally { lease.finish(); }
  });

  const rejectedRuntimes: [string, (entry: RunningEntry) => void][] = [
    ["adopted/process-null", entry => { entry.process = null; }],
    ["process-shaped object, not ChildProcess", entry => { entry.process = { pid: entry.pid, exitCode: null, signalCode: null, killed: false, kill: h.forbidden }; }],
    ["mismatched child PID", entry => { Object.defineProperty(entry.process, "pid", { value: entry.pid + 1, configurable: true }); }],
    ["absent fresh-launch receipt", entry => { delete entry.launchProxy; }],
    ["unverified receipt", entry => { entry.launchProxy = { mode: "none", source: "unknown" } as any; }],
    ["stopping", entry => { entry.stopping = true; }],
    ["already exited", entry => { entry.process.exitCode = 0; }],
    ["signal terminated", entry => { entry.process.signalCode = "SIGTERM"; }],
    ["killed child", entry => { entry.process.killed = true; }],
    ["no live PID", entry => { h.deadPids.add(entry.pid); }],
    ["duplicate debugging port", entry => { owned("ab_duplicate_network_runtime", entry.port, entry.pid + 2); }],
    ["missing actual engine", entry => { delete entry.engine; }],
    ["unknown actual engine", entry => { entry.engine = "unverified" as any; }],
    ["invalid debugging port", entry => { entry.port = 0; }],
  ];
  it.each(rejectedRuntimes)("rejects %s before protocol work and never repairs ownership", async (_name, mutate) => {
    mutate(runningProcesses.get(ID)!);
    const before = fs.readFileSync(getConfigPath());
    expect(await listProfileNetworkPages(ID, { owner: OWNER })).toMatchObject({ ok: false, pages: [], code: "NETWORK_RUNTIME_UNAVAILABLE" });
    expect(await runProfileNetworkObservation(ID, { owner: OWNER, requestId: "unowned-observation", selection: "00000000-0000-4000-8000-000000000001" })).toMatchObject({ ok: false, code: "NETWORK_RUNTIME_UNAVAILABLE" });
    expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled();
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
  });

  it("does not adopt or auto-launch a stopped or unknown profile", async () => {
    runningProcesses.delete(ID);
    expect(await listProfileNetworkPages(ID, { owner: OWNER })).toMatchObject({ ok: false, pages: [], code: "NETWORK_RUNTIME_UNAVAILABLE" });
    expect(await runProfileNetworkObservation(ID, { owner: OWNER, requestId: "stopped-observation", selection: "00000000-0000-4000-8000-000000000001" })).toMatchObject({ ok: false, code: "NETWORK_RUNTIME_UNAVAILABLE" });
    expect(await listProfileNetworkPages("ab_missing_network_profile", { owner: OWNER })).toMatchObject({ ok: false, pages: [], code: "PROFILE_NOT_FOUND" });
    expect(h.list).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled();
  });

  it("uses the actual Chromium runtime even when saved intent says Firefox", async () => {
    setProfileMeta(ID, { engine: "firefox" });
    expect(await listProfileNetworkPages(ID, { owner: OWNER })).toMatchObject({ ok: true });
    expect(h.list).toHaveBeenCalledWith(PORT, expect.objectContaining({ assertCurrent: expect.any(Function) }));
    expect((await observe("runtime-chromium")).observation.completion).toBe("completed");
    expect(disk().browserProfiles[ID].engine).toBe("firefox"); expect(h.status).not.toHaveBeenCalled();
  });

  it("keeps actual Firefox unsupported despite saved Chromium intent and never touches its borrowed session", async () => {
    const entry = runningProcesses.get(ID)!; entry.engine = "firefox";
    const close = vi.fn(() => h.forbidden("borrowed BiDi close"));
    entry.bidiConn = { close, send: h.forbidden } as any;
    expect(await listProfileNetworkPages(ID, { owner: OWNER })).toMatchObject({ ok: false, pages: [], outcome: "unavailable", code: "NETWORK_ENGINE_UNSUPPORTED" });
    expect(await runProfileNetworkObservation(ID, { owner: OWNER, requestId: "actual-firefox", selection: "00000000-0000-4000-8000-000000000001" })).toMatchObject({ ok: false, code: "NETWORK_ENGINE_UNSUPPORTED" });
    expect(h.list).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });

  it("classifies adopted Firefox as unowned runtime, not as verified Firefox engine support", async () => {
    const entry = runningProcesses.get(ID)!; entry.engine = "firefox"; entry.process = null;
    expect(await listProfileNetworkPages(ID, { owner: OWNER })).toMatchObject({ ok: false, pages: [], code: "NETWORK_RUNTIME_UNAVAILABLE" });
    expect(await runProfileNetworkObservation(ID, { owner: OWNER, requestId: "adopted-firefox", selection: "00000000-0000-4000-8000-000000000001" })).toMatchObject({ ok: false, code: "NETWORK_RUNTIME_UNAVAILABLE" });
    expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });

  it("cannot use saved proxy credentials/configuration to backfill missing running-route evidence", async () => {
    transact(draft => {
      draft.proxies["saved-only"] = { type: "http", host: "saved-proxy.fixture.invalid", port: 18080, username: "synthetic-user", password: "synthetic-password" };
      draft.browserProfiles[ID].proxyMode = "named"; draft.browserProfiles[ID].proxyName = "saved-only";
    });
    delete runningProcesses.get(ID)!.launchProxy;
    expect(await listProfileNetworkPages(ID, { owner: OWNER })).toMatchObject({ ok: false, pages: [] });
    expect(h.list).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled();
  });

  it("caps every listing at 32, bounds 128 unconsumed handles globally, and sweeps expired handles", async () => {
    pageTargets = targets(40);
    const batches = [];
    for (let index = 0; index < 4; index++) {
      const reply = await listProfileNetworkPages(ID, { owner: OWNER });
      expect(reply.ok).toBe(true); expect(reply.pages).toHaveLength(32);
      expect(reply.pages.map(page => page.ordinal)).toEqual(Array.from({ length: 32 }, (_, ordinal) => ordinal + 1));
      batches.push(reply);
    }
    expect(new Set(batches.flatMap(batch => batch.pages.map(page => page.handle))).size).toBe(128);
    expect(await listProfileNetworkPages(ID, { owner: OWNER })).toMatchObject({ ok: false, pages: [] });
    vi.setSystemTime(AT + 30_001);
    expect(await listProfileNetworkPages(ID, { owner: OWNER })).toMatchObject({ ok: true, pages: expect.any(Array) });
    expect(await runProfileNetworkObservation(ID, { selection: batches[0].pages[0].handle, owner: OWNER, requestId: "expired-cap" })).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("expires a selection at the 30-second boundary, not only on a later cleanup tick", async () => {
    const selected = await selection(); vi.setSystemTime(AT + 30_000);
    expect(await runProfileNetworkObservation(ID, { selection: selected, owner: OWNER, requestId: "expired-exact" })).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("does not allow another sender or profile to reuse a page handle", async () => {
    const selected = await selection();
    expect(await runProfileNetworkObservation(ID, { selection: selected, owner: "ipc:502", requestId: "foreign-selection" })).toMatchObject({ ok: false });
    transact(draft => { draft.browserProfiles.ab_network_other = { ...draft.browserProfiles[ID] }; }); owned("ab_network_other", PORT + 1, 980_502);
    expect(await runProfileNetworkObservation("ab_network_other", { selection: await selection(), owner: OWNER, requestId: "wrong-profile" })).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("binds the selected target and its current document origin, not an arbitrary URL or target identifier", async () => {
    const selected = await selection(); pageTargets[0] = { ...pageTargets[0], origin: "https://navigated-network.fixture.test" };
    expect(await runProfileNetworkObservation(ID, { selection: selected, owner: OWNER, requestId: "document-changed" })).toMatchObject({ ok: false });
    for (const forged of [String(PORT), SELECTED_ORIGIN, pageTargets[0].id, pageTargets[0].webSocketDebuggerUrl]) {
      expect(await runProfileNetworkObservation(ID, { selection: forged, owner: OWNER, requestId: "forged-selection" })).toMatchObject({ ok: false });
    }
    expect(h.create).not.toHaveBeenCalled();
  });

  it("invalidates a removed selected target even when another target has the same origin", async () => {
    const selected = await selection(); pageTargets = [{ ...pageTargets[0], id: "different-target", webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/different-target` }];
    expect(await runProfileNetworkObservation(ID, { selection: selected, owner: OWNER, requestId: "target-removed" })).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("consumes a selection exactly once, including after a finished observation", async () => {
    const current = await start("single-use"); current.control.arm(); current.control.complete(); await current.operation;
    expect(await runProfileNetworkObservation(ID, { selection: current.selected, owner: OWNER, requestId: "selection-replay" })).toMatchObject({ ok: false });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});

describe("network-only discovery-free leases and pinned runtime guards", () => {
  it("keeps the cached identity branch network-only rather than changing existing diagnostic discovery semantics", () => {
    const network = beginProfileHealthRun(ID, "network", { owner: OWNER });
    try { network.assertCurrent(); expect(h.status).not.toHaveBeenCalled(); } finally { network.finish(); }
    h.status.mockReturnValue({ running: true, cdpPort: PORT, pid: 980_501 });
    const existing = beginProfileHealthRun(ID, "env");
    try { existing.assertCurrent(); expect(h.status).toHaveBeenCalledWith(ID); } finally { existing.finish(); }
  });

  const changes: [string, (entry: RunningEntry) => void][] = [
    ["entry reference", entry => { runningProcesses.set(ID, { ...entry }); }],
    ["child reference with identical PID", entry => { const replacement = new ChildProcess(); Object.defineProperty(replacement, "pid", { value: entry.pid }); replacement.kill = h.forbidden as any; entry.process = replacement; }],
    ["PID scalar", entry => { entry.pid++; h.declaredPids.add(entry.pid); }],
    ["port scalar", entry => { entry.port++; }],
    ["actual engine", entry => { entry.engine = "firefox"; }],
    ["bridge reference", entry => { entry.proxyBridge = { close: h.forbidden }; }],
    ["removed bridge", entry => { delete entry.proxyBridge; }],
    ["stopping state", entry => { entry.stopping = true; }],
    ["child exit state", entry => { entry.process.exitCode = 0; }],
    ["child signal state", entry => { entry.process.signalCode = "SIGTERM"; }],
    ["child killed state", entry => { entry.process.killed = true; }],
    ["duplicate port introduced", entry => { owned("ab_network_port_collision", entry.port, 980_599); }],
    ["removed launch evidence", entry => { delete entry.launchProxy; }],
  ];
  it.each(changes)("pins %s before the first awaited target listing and rechecks its final-wire guard", async (_name, change) => {
    const gate = deferred<Target[]>();
    h.list.mockImplementationOnce((_port: number, _options: ListOptions) => gate.promise);
    const entry = runningProcesses.get(ID)!;
    const pending = track(listProfileNetworkPages(ID, { owner: OWNER }));
    expect(h.list).toHaveBeenCalledTimes(1);
    const guarded = h.list.mock.calls[0][1] as ListOptions;
    try {
      change(entry);
      expect(() => guarded.assertCurrent()).toThrow();
    } finally { gate.resolve(targets()); }
    expect(await pending).toMatchObject({ ok: false, pages: [] });
    expect(h.create).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled();
  });

  it.each(changes)("rejects %s after observation awaits and never late-appends", async (_name, change) => {
    const current = await start(`runtime-final-${changes.findIndex(item => item[0] === _name)}`);
    current.control.arm(); const before = fs.readFileSync(getConfigPath());
    change(runningProcesses.get(ID)!);
    expect(() => current.control.options.assertCurrent()).toThrow();
    current.control.complete();
    expect(await current.operation).toMatchObject({ ok: false });
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(history()).toEqual([]);
    expect(h.status).not.toHaveBeenCalled();
  });

  it("pins absence of a bridge as carefully as an existing bridge reference", async () => {
    delete runningProcesses.get(ID)!.proxyBridge;
    const selected = await selection(); runningProcesses.get(ID)!.proxyBridge = { close: h.forbidden };
    expect(await runProfileNetworkObservation(ID, { selection: selected, owner: OWNER, requestId: "added-bridge" })).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("rechecks after selected-target revalidation rather than sending against a mutable entry", async () => {
    const selected = await selection();
    h.list.mockImplementationOnce(async (_port: number, options: ListOptions) => {
      options.assertCurrent(); runningProcesses.get(ID)!.proxyBridge = { close: h.forbidden }; return targets();
    });
    expect(await runProfileNetworkObservation(ID, { selection: selected, owner: OWNER, requestId: "between-awaits" })).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled(); expect(history()).toEqual([]);
  });

  it("shares one absolute five-second setup deadline across target revalidation and observer construction", async () => {
    const selected = await selection(); const setupDeadline = Date.now() + 5_000;
    h.list.mockImplementationOnce(async (_port: number, options: ListOptions) => {
      expect(options.deadline).toBe(setupDeadline); options.assertCurrent();
      vi.setSystemTime(AT + 4_000); return targets();
    });
    const operation = track(runProfileNetworkObservation(ID, { selection: selected, requestId: "shared-setup-deadline", owner: OWNER }));
    const control = await entered(1);
    expect(control.options.deadline).toBe(setupDeadline);
    expect(control.options.deadline - Date.now()).toBe(1_000);
    const armedAt = control.arm(); control.complete(payload(armedAt));
    expect((await operation).observation.durationMs).toBe(10_000);
  });

  it("does not give a late target list a fresh five-second connection budget", async () => {
    const selected = await selection(); const gate = deferred<Target[]>();
    h.list.mockImplementationOnce((_port: number, _options: ListOptions) => gate.promise);
    const operation = track(runProfileNetworkObservation(ID, { selection: selected, requestId: "setup-list-late", owner: OWNER }));
    await flush();
    try { await vi.advanceTimersByTimeAsync(5_001); }
    finally { gate.resolve(targets()); }
    expect(await operation).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled(); expect(history()).toEqual([]);
  });

  it("rechecks a constructor await before accepting its owned handle or any late result", async () => {
    const gate = deferred<void>();
    h.create.mockImplementationOnce(async (port: number, target: Target, options: ObserverOptions) => {
      options.assertCurrent(); const control = observer(port, target, options); controls.push(control);
      await gate.promise; return control.handle;
    });
    const current = await start("constructor-replaced");
    runningProcesses.get(ID)!.proxyBridge = { close: h.forbidden };
    gate.resolve(); current.control.complete();
    expect(await current.operation).toMatchObject({ ok: false }); expect(history()).toEqual([]);
  });

  it("one running network observation excludes every other health kind for that profile without cancelling its owner", async () => {
    const current = await start("profile-lease");
    const second = await selection();
    expect(await runProfileNetworkObservation(ID, { selection: second, owner: OWNER, requestId: "overlap" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    h.status.mockReturnValue({ running: true, cdpPort: PORT, pid: 980_501 });
    expect(() => beginProfileHealthRun(ID, "env", { owner: "ipc:502" })).toThrow("HEALTH_BUSY");
    expect(current.control.options.signal!.aborted).toBe(false);
    current.control.arm(); current.control.complete(); await current.operation;
  });

  it("shares the four-profile global lease limit with existing health work", async () => {
    const ids = [ID, "ab_network_two", "ab_network_three", "ab_network_four", "ab_network_five"];
    transact(draft => { for (const id of ids.slice(1)) draft.browserProfiles[id] = { ...draft.browserProfiles[ID] }; });
    ids.slice(1).forEach((id, index) => owned(id, PORT + index + 1, 980_510 + index));
    const runs = [];
    for (let index = 0; index < 4; index++) runs.push(await start(`global-${index}`, {}, ids[index]));
    expect(runs).toHaveLength(4);
    // Every original observer arms before any window is completed. Completing
    // one fixture advances Date; leaving the others in setup would correctly
    // consume their absolute five-second deadline, rather than test lease caps.
    const stops = runs.map(run => {
      expect(run.control.options.signal!.aborted).toBe(false);
      expect(() => run.control.options.assertCurrent()).not.toThrow();
      return payload(run.control.arm());
    });
    expect(await runProfileNetworkObservation(ids[4], { selection: await selection(ids[4]), owner: OWNER, requestId: "global-refused" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    expect(controls).toHaveLength(4);
    runs[0].control.complete(stops[0]); expect(await runs[0].operation).toMatchObject({ ok: true, requestId: "global-0" });
    const replacement = await start("global-freed", {}, ids[4]);
    expect(controls).toHaveLength(5);
    const replacementStop = payload(replacement.control.arm());
    for (let index = 1; index < runs.length; index++) {
      expect(Date.now()).toBe(stops[index].observation.endedAt);
      runs[index].control.complete(stops[index]);
      expect(await runs[index].operation).toMatchObject({ ok: true, requestId: `global-${index}` });
    }
    replacement.control.complete(replacementStop); expect(await replacement.operation).toMatchObject({ ok: true, requestId: "global-freed" });
  });

  it("matches cancellation by owner, request and kind and retains the lease until the actual result/close", async () => {
    const current = await start("owned-cancel");
    for (const options of [
      { kind: "network" as const, requestId: "owned-cancel", owner: "ipc:502" },
      { kind: "network" as const, requestId: "different-request", owner: OWNER },
      { kind: "env" as const, requestId: "owned-cancel", owner: OWNER },
    ]) expect(cancelProfileHealthRun(ID, options)).toMatchObject({ success: false, cancelled: false,
      code: options.kind === "network" ? "HEALTH_INVALID_REQUEST" : "HEALTH_NOT_OWNED" });
    expect(current.control.options.signal!.aborted).toBe(false);
    expect(cancelProfileHealthRun(ID, { kind: "network", requestId: "owned-cancel", owner: OWNER })).toMatchObject({ success: true, cancelled: true });
    expect(current.control.options.signal!.aborted).toBe(true);
    expect(await runProfileNetworkObservation(ID, { selection: await selection(), owner: OWNER, requestId: "while-closing" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    current.control.complete(); expect(await current.operation).toMatchObject({ ok: false, outcome: "cancelled", requestId: "owned-cancel" });
    expect(history()).toEqual([]);
  });

  it.each(["env", "webrtc", "drift", "consistency"] as const)("preserves legacy %s ownership refusals while mapping only network refusals", kind => {
    h.status.mockReturnValue({ running: true, cdpPort: PORT, pid: 980_501 });
    const lease = beginProfileHealthRun(ID, kind, { owner: OWNER, requestId: `legacy-cancel-${kind}` });
    try {
      expect(cancelProfileHealthRun(ID, { kind, requestId: lease.requestId, owner: "ipc:502" })).toEqual({ success: false, cancelled: false, code: "HEALTH_NOT_OWNED" });
      expect(cancelProfileHealthRun(ID, { kind: "network", requestId: lease.requestId, owner: OWNER })).toEqual({ success: false, cancelled: false, code: "HEALTH_INVALID_REQUEST" });
      expect(lease.signal.aborted).toBe(false); lease.assertCurrent();
    } finally { lease.finish(); }
    expect(cancelProfileHealthRun(ID, { kind: "network", requestId: "no-active-network", owner: OWNER })).toEqual({ success: false, cancelled: false, code: "HEALTH_INVALID_REQUEST" });
  });

  it.each(["owner-cancel", "caller-abort", "clear", "runtime-replaced"] as const)("%s preserves the validated one-second stop, never the three-second cleanup clock", async reason => {
    const controller = new AbortController();
    const requestId = `stop-time-${reason}`;
    const current = await start(requestId, { signal: controller.signal }); const armedAt = current.control.arm();
    const genuine = stoppedPayload(armedAt, armedAt + 1_000, reason === "runtime-replaced" ? "target-changed" : "cancelled");
    vi.setSystemTime(genuine.observation.endedAt);
    if (reason === "owner-cancel") expect(cancelProfileHealthRun(ID, { kind: "network", requestId, owner: OWNER }).cancelled).toBe(true);
    else if (reason === "caller-abort") controller.abort();
    else if (reason === "clear") clearProfileHealthHistory(ID, "network");
    else runningProcesses.set(ID, { ...runningProcesses.get(ID)! });
    const afterInvalidation = fs.readFileSync(getConfigPath());
    vi.setSystemTime(armedAt + 3_000); // Two additional seconds are cleanup only.
    current.control.complete(genuine);
    const reply = await current.operation;
    expect(reply).toMatchObject({ ok: false, outcome: "cancelled", requestId,
      code: reason === "runtime-replaced" ? "HEALTH_PROFILE_CHANGED" : "HEALTH_CANCELLED" });
    expect(reply.observation).toEqual(genuine.observation);
    expect(reply.hops).toEqual(genuine.hops); expect(reply.httpStatusEvidence).toEqual(genuine.httpStatusEvidence);
    expect(normalizeNetworkObservationSummary(reply.observation)).toEqual(genuine.observation);
    expect(reply.observation).toMatchObject({ endedAt: armedAt + 1_000, durationMs: 1_000, counts: { requests: 1, responses: 1, finished: 1 } });
    expect(Date.now()).toBe(armedAt + 3_000);
    expect(fs.readFileSync(getConfigPath())).toEqual(afterInvalidation); expect(history()).toEqual([]);
    reloadConfig(); expect(history().find(entry => entry.requestId === requestId)).toBeUndefined();
  });

  it("cancelled cleanup-unverified preserves the genuine stop payload and holds the lease until actual closure", async () => {
    const current = await start("cancelled-cleanup-unverified"); const armedAt = current.control.arm();
    vi.setSystemTime(armedAt + 1_000);
    expect(cancelProfileHealthRun(ID, { kind: "network", requestId: "cancelled-cleanup-unverified", owner: OWNER }).cancelled).toBe(true);
    const genuine = stoppedPayload(armedAt, Date.now(), "cleanup-unverified");
    vi.setSystemTime(armedAt + 3_000); current.control.complete(genuine, false);
    const reply = await current.operation;
    expect(reply).toMatchObject({ ok: false, outcome: "cancelled", code: "HEALTH_CANCELLED" });
    expect(reply.observation).toEqual(genuine.observation); expect(reply.hops).toEqual(genuine.hops);
    expect(normalizeNetworkObservationSummary(reply.observation)).toEqual(genuine.observation);
    expect(await runProfileNetworkObservation(ID, { selection: await selection(), owner: OWNER, requestId: "cancelled-cleanup-overlap" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    expect(history()).toEqual([]);
    current.control.close(); await flush(); reloadConfig(); expect(history()).toEqual([]);
    await observe("after-cancelled-cleanup");
    expect(history().map(entry => entry.requestId)).toEqual(["after-cancelled-cleanup"]);
  });

  it("an invalid cancellation payload stays unavailable instead of estimating an armed window from reply time", async () => {
    const current = await start("cancelled-invalid-payload"); const armedAt = current.control.arm();
    vi.setSystemTime(armedAt + 1_000);
    cancelProfileHealthRun(ID, { kind: "network", requestId: "cancelled-invalid-payload", owner: OWNER });
    const malformed = stoppedPayload(armedAt, Date.now(), "cancelled");
    (malformed.observation.coverage as any).network = { raw: PRIVATE };
    vi.setSystemTime(armedAt + 3_000); current.control.complete(malformed);
    const reply = await current.operation;
    expect(reply).toMatchObject({ ok: false, outcome: "cancelled", code: "HEALTH_CANCELLED", hops: [], httpStatusEvidence: [],
      observation: { armedAt: null, durationMs: 0, coverage: { network: "unavailable" } } });
    expect(normalizeNetworkObservationSummary(reply.observation)).toEqual(reply.observation);
    expect(JSON.stringify(reply)).not.toContain(PRIVATE); expect(history()).toEqual([]);
  });

  it("holds a cleanup-unverified lease after the returned result and only frees it when closed really resolves", async () => {
    const current = await start("cleanup-unverified"); const armedAt = current.control.arm();
    const value = payload(armedAt); value.observation.completion = "partial"; value.observation.stopReason = "cleanup-unverified"; value.observation.coverage.network = "partial";
    current.control.complete(value, false);
    expect(await current.operation).toMatchObject({ observation: { completion: "partial", stopReason: "cleanup-unverified" } });
    expect(history()).toEqual([]);
    expect(await runProfileNetworkObservation(ID, { selection: await selection(), owner: OWNER, requestId: "too-early" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await runProfileNetworkObservation(ID, { selection: await selection(), owner: OWNER, requestId: "still-not-closed" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    current.control.close(); await flush(); expect(history()).toEqual([]);
    const next = await start("after-real-close"); next.control.arm(); next.control.complete(); await next.operation;
  });

  it("20 seconds aborts the protocol but does not release or persist a still-pending operation", async () => {
    const current = await start("lease-deadline"); let settled = false;
    current.operation.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(current.control.options.signal!.aborted).toBe(true); expect(settled).toBe(false);
    expect(await runProfileNetworkObservation(ID, { selection: await selection(), owner: OWNER, requestId: "deadline-overlap" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    current.control.complete();
    expect(await current.operation).toMatchObject({ ok: false, outcome: "cancelled", code: "HEALTH_TIMEOUT" });
    expect(history()).toEqual([]);
  });

  it("honors caller abort before protocol work and during the awaited observation", async () => {
    const selected = await selection(); const controller = new AbortController(); controller.abort();
    expect(await runProfileNetworkObservation(ID, { selection: selected, owner: OWNER, requestId: "pre-aborted", signal: controller.signal })).toMatchObject({ ok: false, outcome: "cancelled" });
    expect(h.create).not.toHaveBeenCalled();
    const live = new AbortController(); const current = await start("caller-abort", { signal: live.signal });
    live.abort(); expect(current.control.options.signal!.aborted).toBe(true);
    current.control.complete(); expect(await current.operation).toMatchObject({ ok: false, outcome: "cancelled" });
    expect(history()).toEqual([]);
  });

  it.each(["network", undefined] as const)("clear(%s) invalidates active work before deletion and forbids late reappearance", async kind => {
    recordProfileHealthResult(ID, networkEntry("before-clear"));
    recordProfileHealthResult(ID, { kind: "env", at: AT + 1, source: "host", outcome: "inconclusive", summary: "unrelated environment evidence" });
    const current = await start("clear-active"); current.control.arm();
    clearProfileHealthHistory(ID, kind);
    expect(current.control.options.signal!.aborted).toBe(true); expect(history()).toEqual([]);
    current.control.complete(); expect(await current.operation).toMatchObject({ ok: false, outcome: "cancelled" });
    reloadConfig(); expect(history()).toEqual([]);
    expect(listProfileHealthHistory(ID).filter(entry => entry.kind === "env")).toHaveLength(kind === "network" ? 1 : 0);
  });

  it("clearing an unrelated kind does not abort network observation", async () => {
    const current = await start("clear-other-kind"); clearProfileHealthHistory(ID, "env");
    expect(current.control.options.signal!.aborted).toBe(false);
    current.control.arm(); current.control.complete(); await current.operation;
    expect(history().map(entry => entry.requestId)).toEqual(["clear-other-kind"]);
  });

  it("a concurrent profile edit survives and prevents the old observation's writeback", async () => {
    const current = await start("profile-edited"); current.control.arm();
    setProfileMeta(ID, { note: "concurrent note must survive" }); current.control.complete();
    expect(await current.operation).toMatchObject({ ok: false });
    reloadConfig(); expect(getConfig().browserProfiles[ID].note).toBe("concurrent note must survive"); expect(history()).toEqual([]);
  });
});

describe("finite observations are evidence, never website/proxy availability", () => {
  it("reports armed exactly once with the owning request and preserves selected-page cross-origin requests", async () => {
    const onArmed = vi.fn(); const current = await start("armed-correlation", { onArmed });
    expect(onArmed).not.toHaveBeenCalled();
    const armedAt = current.control.arm();
    expect(onArmed).toHaveBeenCalledExactlyOnceWith({ dirId: ID, requestId: "armed-correlation", armedAt, observeForMs: 10_000 });
    current.control.complete(payload(armedAt)); const reply = await current.operation;
    expect(reply.requestId).toBe("armed-correlation"); expect(reply.outcome).toBe("inconclusive");
    expect(reply.observation.completion).toBe("completed"); expect(reply.hops).toEqual([hop()]);
    expect(reply.hops[0].origin).not.toBe(SELECTED_ORIGIN);
    expect(reply.httpStatusEvidence).toEqual([]); expectSafeSummary(reply.observation);
    expect(h.create.mock.calls[0][1]).toEqual(pageTargets[0]);
  });

  it("does not notify armed after cancellation or runtime replacement", async () => {
    const onArmed = vi.fn(); const current = await start("late-armed", { onArmed });
    cancelProfileHealthRun(ID, { kind: "network", requestId: "late-armed", owner: OWNER });
    // Model a late callback from a protocol promise that ignored cancellation.
    current.control.options.onArmed?.({ armedAt: Date.now(), observeForMs: 10_000 });
    current.control.complete(); await current.operation; expect(onArmed).not.toHaveBeenCalled();
  });

  it("a quiet complete window is inconclusive and does not imply the site or proxy was checked", async () => {
    const value = payload(); value.observation.counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0])) as NetworkCounts; value.hops = [];
    const reply = await observe("quiet-window", value);
    expect(reply.outcome).toBe("inconclusive"); expect(reply.observation).toEqual(value.observation);
    expect(reply.hops).toEqual([]); expect(reply.httpStatusEvidence).toEqual([]);
    expect(history()[0].outcome).toBe("inconclusive");
  });

  it("pending/partial evidence cannot be promoted by a clean-looking response", async () => {
    const value = payload(); value.observation.completion = "partial"; value.observation.stopReason = "evidence-incomplete";
    value.observation.coverage.network = "partial"; value.observation.counts.finished = 0; value.observation.counts.pending = 1;
    value.hops[0].terminal = "pending";
    const reply = await observe("pending-window", value);
    expect(reply.outcome).not.toBe("pass"); expect(reply.observation.counts.pending).toBe(1);
    expect(history().some(entry => entry.outcome === "pass")).toBe(false);
  });

  it("keeps browser 200, wire 304, and unknown-hop CORS 403 evidence distinct", async () => {
    const value = payload(); value.observation.counts.cache = 1; value.observation.counts.unattributed = 1;
    value.observation.completion = "partial"; value.observation.stopReason = "evidence-incomplete"; value.observation.coverage.network = "partial";
    value.hops = [hop({ status: 200, networkStatus: 304, fromDiskCache: true, servedFromCache: true })];
    const evidence: NetworkHttpStatusEvidence[] = [
      { id: "wire-local-1", chainId: "chain-local-1", hopId: "hop-local-1", status: 304, source: "extra-info", association: "unique" },
      { id: "wire-local-2", chainId: "chain-local-2", hopId: null, status: 403, source: "extra-info", association: "unknown" },
    ];
    value.httpStatusEvidence = evidence;
    const reply = await observe("wire-status", value);
    expect(reply.hops).toEqual(value.hops); expect(reply.httpStatusEvidence).toEqual(evidence);
    expect(reply.observation.counts).toMatchObject({ responses: 1, http4xx: 0, cache: 1, unattributed: 1 });
    expect(reply.outcome).not.toBe("pass");
  });

  it.each([403, 429, 502])("retains HTTP %s without inventing fingerprint detection or an upstream-hop diagnosis", async status => {
    const value = payload(); value.hops[0].status = status;
    value.observation.counts.http4xx = status < 500 ? 1 : 0; value.observation.counts.http5xx = status >= 500 ? 1 : 0;
    const reply = await observe(`http-${status}`, value);
    expect(reply.outcome).not.toBe("pass"); expect(reply.hops[0].status).toBe(status);
    expect(reply.observation.coverage).toMatchObject({ bridgeHop: "unknown", upstreamHop: "unknown" });
    expect(history()[0].summary).toBe(SUMMARY_CODE);
  });

  it("does not erase a real response when a later native failure is observed or infer proxy authentication", async () => {
    const value = payload(); value.hops = [hop({ status: 403, terminal: "failed", errorCode: "ERR_PROXY_CONNECTION_FAILED" })];
    value.observation.counts = { ...counts(), finished: 0, failed: 1, http4xx: 1 };
    const reply = await observe("response-then-failure", value);
    expect(reply.hops[0]).toMatchObject({ status: 403, terminal: "failed", errorCode: "ERR_PROXY_CONNECTION_FAILED" });
    expect(reply.observation.counts).toMatchObject({ responses: 1, failed: 1, http4xx: 1 });
    expect(reply.observation.coverage).toMatchObject({ bridgeHop: "unknown", upstreamHop: "unknown" });
    expect(history()[0].summary).toBe(SUMMARY_CODE); expect(history()[0].outcome).not.toBe("pass");
  });

  it("never reflects raw setup/transport exception text in a reply or canonical history", async () => {
    h.list.mockRejectedValueOnce(new Error(`${PRIVATE} https://user:password@private.invalid/path?token=secret#fragment`));
    const reply = await listProfileNetworkPages(ID, { owner: OWNER });
    expect(reply).toMatchObject({ ok: false, pages: [] }); expect(JSON.stringify(reply)).not.toContain(PRIVATE);
    const selected = await selection(); h.create.mockRejectedValueOnce(new Error(`${PRIVATE} raw stack/header/body`));
    const failure = await runProfileNetworkObservation(ID, { selection: selected, owner: OWNER, requestId: "private-exception" });
    expect(failure.ok).toBe(false); expect(failure.outcome).not.toBe("pass");
    expect(JSON.stringify(failure)).not.toContain(PRIVATE); expect(JSON.stringify(disk().profileHealthHistory)).not.toContain(PRIVATE);
  });
});

describe("canonical LOCAL history whitelist and real disk/reload/search data flow", () => {
  it("writes only the typed summary, reads actual owned bytes, reloads, and searches by kind/requestId", async () => {
    const profileBefore = structuredClone(disk().browserProfiles[ID]);
    const reply = await observe("disk-read-reload-search");
    expect(reply.hops[0].origin).toBe(REQUEST_ORIGIN);
    const saved = disk().profileHealthHistory[ID]; expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]).sort()).toEqual(ENTRY_KEYS);
    expect(saved[0]).toMatchObject({ kind: "network", requestId: "disk-read-reload-search", source: "runtime", summary: SUMMARY_CODE, outcome: "inconclusive", networkSummary: reply.observation });
    expectSafeSummary(saved[0].networkSummary);
    const bytes = fs.readFileSync(getConfigPath(), "utf8");
    for (const text of [PRIVATE, SELECTED_ORIGIN, REQUEST_ORIGIN, "webSocketDebuggerUrl", "httpStatusEvidence", "hop-local-1", "chain-local-1"]) expect(bytes).not.toContain(text);
    expect(disk().browserProfiles[ID]).toEqual(profileBefore);
    reloadConfig();
    const found = listProfileHealthHistory(ID).find(entry => entry.kind === "network" && entry.requestId === "disk-read-reload-search");
    expect(found).toEqual(saved[0]);
    found!.networkSummary!.counts.requests = 77;
    expect(getProfileHealthHistory(ID)[0].networkSummary!.counts.requests).toBe(1);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });

  it("a failed canonical commit leaves live state and actual disk unchanged and releases only its lease", async () => {
    const before = fs.readFileSync(getConfigPath());
    const current = await start("commit-refused"); const genuine = payload(current.control.arm());
    h.state.failRename = true; current.control.complete(genuine);
    const reply = await current.operation;
    expect(reply).toMatchObject({ ok: false, outcome: "error", code: "HEALTH_HISTORY_WRITE_FAILED" });
    expect(reply.observation).toEqual(genuine.observation);
    expect(reply.hops).toEqual(genuine.hops); expect(reply.httpStatusEvidence).toEqual(genuine.httpStatusEvidence);
    expect(normalizeNetworkObservationSummary(reply.observation)).toEqual(genuine.observation);
    expect(reply.outcome).not.toBe("pass");
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(history()).toEqual([]);
    h.state.failRename = false; reloadConfig(); expect(history()).toEqual([]);
    await observe("commit-after-failure"); expect(history().map(entry => entry.requestId)).toEqual(["commit-after-failure"]);
  });

  it("caps the shared per-profile canonical history at 20 without mutating other configuration", () => {
    const meta = structuredClone(disk().browserProfiles[ID]);
    for (let index = 0; index < 25; index++) recordProfileHealthResult(ID, networkEntry(`history-cap-${index}`, AT + index));
    const stored = disk().profileHealthHistory[ID]; expect(stored).toHaveLength(20);
    expect(stored.map((entry: ProfileHealthEntry) => entry.requestId)).toEqual(Array.from({ length: 20 }, (_, index) => `history-cap-${index + 5}`));
    expect(disk().browserProfiles[ID]).toEqual(meta); reloadConfig();
    expect(listProfileHealthHistory(ID).find(entry => entry.kind === "network" && entry.requestId === "history-cap-24")).toEqual(stored.at(-1));
  });

  it("pure normalization sorts/caps safe network history without writing storage", () => {
    const before = fs.readFileSync(getConfigPath()); const raw = structuredClone(getConfig());
    raw.profileHealthHistory = { [ID]: Array.from({ length: 25 }, (_, index) => networkEntry(`pure-cap-${index}`, AT + index)).reverse() };
    const normalized = mergeConfigForStore(raw, "save");
    expect(normalized.profileHealthHistory[ID]).toHaveLength(20);
    expect(normalized.profileHealthHistory[ID].map((entry: ProfileHealthEntry) => entry.requestId)).toEqual(Array.from({ length: 20 }, (_, index) => `pure-cap-${index + 5}`));
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(history()).toEqual([]);
  });

  it("rejects or downgrades even a native-looking persisted network PASS, never trusting a raw summary string", () => {
    const cfg = structuredClone(getConfig());
    cfg.profileHealthHistory = { [ID]: [{ ...networkEntry("forged-pass"), outcome: "pass", summary: `${PRIVATE} site and proxy healthy` }] };
    saveConfig(cfg);
    expect(disk().profileHealthHistory[ID].some((entry: ProfileHealthEntry) => entry.outcome === "pass")).toBe(false);
    expect(fs.readFileSync(getConfigPath(), "utf8")).not.toContain(PRIVATE);
    reloadConfig(); expect(history().some(entry => entry.outcome === "pass")).toBe(false);
    for (const entry of history()) expect(entry.summary).toBe(SUMMARY_CODE);
  });

  it.each(["missing-summary", "unsafe-coverage", "negative-count", "impossible-time"])("cannot load or persist a malformed typed summary: %s", mode => {
    const entry: any = networkEntry(`invalid-${mode}`);
    if (mode === "missing-summary") delete entry.networkSummary;
    if (mode === "unsafe-coverage") entry.networkSummary.coverage.network = { status: "observed", raw: PRIVATE };
    if (mode === "negative-count") entry.networkSummary.counts.failed = -1;
    if (mode === "impossible-time") entry.networkSummary.durationMs = 1;
    const cfg = structuredClone(getConfig()); cfg.profileHealthHistory = { [ID]: [entry] }; saveConfig(cfg);
    expect(disk().profileHealthHistory[ID]).toEqual([]); reloadConfig(); expect(history()).toEqual([]);
  });

  it("strips/rejects unknown unsafe fields at every summary/coverage/count level and never flattens nested claims", () => {
    const cfg = structuredClone(getConfig());
    const root: any = networkEntry("unsafe-entry");
    Object.assign(root, { origin: PRIVATE, hops: [{ headers: { Cookie: PRIVATE }, body: PRIVATE }], httpStatusEvidence: [{ raw: PRIVATE }], error: PRIVATE, title: PRIVATE, stack: PRIVATE });
    const nested: any = networkEntry("unsafe-summary");
    Object.assign(nested.networkSummary, { origin: PRIVATE, raw: PRIVATE, headers: { Authorization: PRIVATE } });
    nested.networkSummary.counts.raw = PRIVATE;
    nested.networkSummary.coverage.raw = { secret: PRIVATE };
    const nestedClaim: any = networkEntry("nested-coverage"); nestedClaim.networkSummary.coverage.bridgeHop = { state: "unknown", error: PRIVATE };
    cfg.profileHealthHistory = { [ID]: [root, nested, nestedClaim] }; saveConfig(cfg);
    const bytes = fs.readFileSync(getConfigPath(), "utf8"); expect(bytes).not.toContain(PRIVATE);
    reloadConfig();
    for (const entry of history()) {
      expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS); expect(entry.summary).toBe(SUMMARY_CODE);
      expectSafeSummary(entry.networkSummary!); expect(entry.outcome).not.toBe("pass");
    }
    expect(history().some(entry => entry.requestId === "nested-coverage")).toBe(false);
    expect(JSON.stringify(history())).not.toContain(PRIVATE);
  });

  it("load normalizes a malicious owned input without rewriting it, and the next actual commit removes unsafe fields", () => {
    const raw = structuredClone(disk()); const bad: any = networkEntry("malicious-load");
    bad.summary = PRIVATE; bad.networkSummary.coverage.console = { status: "not-observed", text: PRIVATE }; bad.hops = [{ body: PRIVATE }];
    raw.profileHealthHistory = { [ID]: [networkEntry("safe-load"), bad] };
    const injected = JSON.stringify(raw); fs.writeFileSync(getConfigPath(), injected, "utf8");
    reloadConfig(); expect(history().find(entry => entry.requestId === "safe-load")).toEqual(networkEntry("safe-load"));
    expect(JSON.stringify(history())).not.toContain(PRIVATE);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(injected);
    saveConfig(getConfig()); expect(fs.readFileSync(getConfigPath(), "utf8")).not.toContain(PRIVATE);
    reloadConfig(); expect(history().find(entry => entry.kind === "network" && entry.requestId === "safe-load")).toEqual(networkEntry("safe-load"));
  });
});
