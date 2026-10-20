// Stage 3 AUTHOR-ONLY preparation. UNRUN; intended network modules/handlers are
// feature assumptions, not an existing-product RED. No source edits are implied.
// Actual IPC registration, coordinator, health lease and config IO are exercised
// only after main explicitly grants execution; protocol/native effects are inert.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { NetworkObservationPayload, NetworkObservationSummary } from "../../src/main/services/network-diagnostics-contract.js";

const h = vi.hoisted(() => {
  const actual = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const tmp = process.env.TMPDIR;
  if (!tmp || !path.isAbsolute(tmp) || actual.lstatSync(tmp).isSymbolicLink() || !actual.lstatSync(tmp).isDirectory()) throw new Error("A real runner-owned TMPDIR is required for network IPC fixtures");
  const root = actual.mkdtempSync(path.join(tmp, "ipc-network-unit-")); actual.chmodSync(root, 0o700);
  const identity = actual.lstatSync(root);
  const forbidden = vi.fn((capability: unknown) => { throw new Error(`Undeclared network IPC capability: ${String(capability)}`); });
  const fds = new Set<number>();
  const importRealpaths: { input: string; resolved: string; stack: string }[] = [];
  const state = { failRename: false };
  const assertPath = (input: unknown) => {
    if (typeof input === "number") { if (!fds.has(input)) forbidden("unowned file descriptor"); return; }
    if (typeof input !== "string" && !Buffer.isBuffer(input)) forbidden("nonlocal filesystem path");
    const raw = String(input);
    if (!path.isAbsolute(raw) || raw.split(path.sep).some(part => part === "." || part === "..")) forbidden("noncanonical filesystem path");
    const resolved = path.resolve(raw);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) forbidden("filesystem path outside owned IPC fixture");
    const current = actual.lstatSync(root);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) forbidden("replaced IPC fixture root");
    let currentPath = root;
    for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
      currentPath = path.join(currentPath, part);
      try { if (actual.lstatSync(currentPath).isSymbolicLink()) forbidden("filesystem symlink"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
    }
  };
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
      if (state.failRename && String(to) === path.join(root, "config.json")) throw Object.assign(new Error("owned IPC history rename refused"), { code: "EIO" });
      return actual.renameSync(from, to);
    };
    else if (pathOps.has(name) || fdOps.has(name)) guarded[name] = (...args: any[]) => { assertPath(args[0]); return (value as Function)(...args); };
    else if (["Dirent", "Stats"].includes(name)) guarded[name] = value;
    else guarded[name] = (..._args: unknown[]) => forbidden(`fs.${name}`);
  }
  return {
    root, identity, fds, importRealpaths, state, forbidden, fs: { ...guarded, default: guarded },
    handlers: new Map<string, (...args: any[]) => any>(),
    list: vi.fn(), create: vi.fn(), launchGate: vi.fn(), safeUrl: vi.fn(), audit: vi.fn(), declaredPids: new Set<number>(),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(`ipc-synthetic:${text}`), decryptString: (bytes: Buffer) => {
      const text = bytes.toString("utf8"); if (!text.startsWith("ipc-synthetic:")) throw new Error("Nonfixture IPC safeStorage envelope"); return text.slice("ipc-synthetic:".length);
    } },
  };
});
vi.mock("node:fs", () => h.fs);
vi.mock("node:fs/promises", () => ({ readFile: h.forbidden, writeFile: h.forbidden, mkdir: h.forbidden, readdir: h.forbidden, stat: h.forbidden, lstat: h.forbidden, open: h.forbidden, rename: h.forbidden, rm: h.forbidden }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => {
    if (h.handlers.has(channel)) throw new Error(`Duplicate network fixture IPC channel ${channel}`);
    h.handlers.set(channel, handler);
  } },
  app: { getPath: (name: string) => {
    if (name === "userData" || name === "home") return h.root;
    return h.forbidden(`Electron path ${name}`);
  } },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  screen: { getPrimaryDisplay: h.forbidden }, dialog: { showOpenDialog: h.forbidden }, safeStorage: h.safeStorage,
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden, execFileSync: h.forbidden, spawn: h.forbidden, spawnSync: h.forbidden, fork: h.forbidden,
}));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => h.root, tmpdir: () => h.root, hostname: () => "synthetic-ipc-network-unit", networkInterfaces: h.forbidden, userInfo: h.forbidden }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), connect: h.forbidden, createConnection: h.forbidden, createServer: h.forbidden, Socket: h.forbidden }));
vi.mock("node:tls", () => ({ connect: h.forbidden, createServer: h.forbidden, TLSSocket: h.forbidden }));
vi.mock("node:http", () => ({ get: h.forbidden, request: h.forbidden, createServer: h.forbidden }));
vi.mock("node:https", () => ({ get: h.forbidden, request: h.forbidden, createServer: h.forbidden }));
vi.mock("node:dns", () => ({ lookup: h.forbidden, resolve: h.forbidden, resolve4: h.forbidden, resolve6: h.forbidden, getServers: h.forbidden, Resolver: h.forbidden }));
vi.mock("node:dns/promises", () => ({ lookup: h.forbidden, resolve: h.forbidden, resolve4: h.forbidden, resolve6: h.forbidden, Resolver: h.forbidden }));
vi.mock("node:dgram", () => ({ createSocket: h.forbidden }));
vi.mock("ws", () => ({ default: h.forbidden, WebSocket: h.forbidden, WebSocketServer: h.forbidden }));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  launchBrowser: h.forbidden, stopBrowser: h.forbidden, statusBrowser: h.forbidden,
  listBrowserProfiles: h.forbidden, checkFingerprintDrift: h.forbidden,
  getRuntime: h.forbidden, getRuntimeChromiumStatusAsync: h.forbidden, verifyRuntimeChromiumAsync: h.forbidden,
  getEngineStatusAsync: h.forbidden, getProfileRuntimeSnapshot: h.forbidden,
  createBrowserProfile: h.forbidden, deleteBrowserProfile: h.forbidden, getLaunchLogPath: h.forbidden,
}));
vi.mock("../../src/main/services/local-agent.js", () => ({ assertSafeNavigationUrl: h.safeUrl, cdpConnect: h.forbidden, cdpNavigate: h.forbidden, cdpWaitForLoad: h.forbidden, cdpDisconnect: h.forbidden }));
vi.mock("../../src/main/services/page-eval.js", () => ({ evaluateInPage: h.forbidden, navigateInPage: h.forbidden, getProfileEngineByDirId: h.forbidden }));
vi.mock("../../src/main/services/bidi-client.js", () => ({ connectBidi: h.forbidden, getFirefoxSession: h.forbidden, registerFirefoxSession: h.forbidden, dropFirefoxSession: h.forbidden }));
vi.mock("../../src/main/services/license.js", () => ({ checkLaunchAllowed: h.launchGate, checkCreateAllowed: h.forbidden }));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: h.audit, listAudit: h.forbidden }));
vi.mock("../../src/main/services/browser/cdp-network-observer.js", () => ({ listNetworkPageTargets: h.list, createNetworkPageObserver: h.create }));

import { registerBrowserHandlers } from "../../src/main/ipc/browser.js";
import { getConfig, getConfigPath, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { runningProcesses, captureLaunchProxySnapshot } from "../../src/main/services/browser/runtime-table.js";
import { recordProfileHealthResult } from "../../src/main/services/profile-health.js";
import { initializeSecretStorage, resetSecretStorageForTests } from "../../src/main/services/secrets.js";
registerBrowserHandlers();

const ID = "ab_network_ipc";
const PORT = 45682;
const PID = 981_601;
const AT = 1_792_387_200_000;
const PRIVATE = "__NETWORK_IPC_PRIVATE_SENTINEL__";
const ORIGIN = "https://selected-ipc-network.fixture.test";
const REQUEST_ORIGIN = "https://cdn-ipc-network.fixture.test";
const BASELINE = { platform: "MacIntel", userAgent: "Synthetic IPC browser", tz: "Europe/London" };
type Target = { id: string; origin: string; webSocketDebuggerUrl: string };
type Armed = { armedAt: number; observeForMs: 10000 };
type LowOptions = { signal: AbortSignal; assertCurrent: () => void; deadline: number; onArmed?: (event: Armed) => void };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function summary(armedAt = AT): NetworkObservationSummary {
  return { version: 1, completion: "completed", stopReason: "window-ended", armedAt, endedAt: armedAt + 10_000, durationMs: 10_000,
    counts: { requests: 1, hops: 1, responses: 1, finished: 1, failed: 0, blocked: 0, requestCancelled: 0, redirects: 0, http4xx: 0, http5xx: 0, pending: 0, cache: 0, serviceWorker: 0, unattributed: 0, cspIssues: 0 },
    coverage: { network: "observed", csp: "unavailable", worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" } };
}
function payload(armedAt = AT): NetworkObservationPayload {
  return { observation: summary(armedAt), hops: [{ id: "ipc-local-hop", chainId: "ipc-local-chain", redirectedFrom: null, origin: REQUEST_ORIGIN, method: "GET", resourceType: "Fetch", status: 200, networkStatus: null, terminal: "finished", errorCode: null, blockedReason: null, corsReason: null, fromDiskCache: false, fromServiceWorker: false, fromPrefetchCache: null, servedFromCache: false }], httpStatusEvidence: [] };
}
const controls: ReturnType<typeof observer>[] = [];
const senders = new Set<ReturnType<typeof sender>>();
const operations = new Set<Promise<any>>();
function sender(id = 601) {
  const owner = Object.assign(new EventEmitter(), { id, send: vi.fn(), isDestroyed: vi.fn(() => false) });
  senders.add(owner); return owner;
}
function destroy(owner: ReturnType<typeof sender>) { owner.isDestroyed.mockReturnValue(true); owner.emit("destroyed"); }
function observer(port: number, target: Target, options: LowOptions) {
  const result = deferred<NetworkObservationPayload>(); const closed = deferred<void>();
  let cleanupVerified = false; let resultResolved = false; let closedResolved = false; let armedAt = AT;
  const handle = { result: result.promise, closed: closed.promise, get cleanupVerified() { return cleanupVerified; } };
  return { port, target, options, handle,
    arm() { options.assertCurrent(); armedAt = Date.now(); options.onArmed?.({ armedAt, observeForMs: 10_000 }); return armedAt; },
    close() { if (!closedResolved) { cleanupVerified = true; closedResolved = true; closed.resolve(); } },
    complete(value = payload(armedAt), close = true) {
      if (close && !closedResolved) { cleanupVerified = true; closedResolved = true; closed.resolve(); }
      if (!resultResolved) { resultResolved = true; vi.setSystemTime(Math.max(Date.now(), value.observation.endedAt)); result.resolve(value); }
    },
  };
}
async function flush() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
function invoke(channel: string, owner: ReturnType<typeof sender>, ...args: any[]) {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`Intended production handler is not registered: ${channel}`);
  const promise = Promise.resolve(handler({ sender: owner }, ...args));
  operations.add(promise); promise.then(() => operations.delete(promise), () => operations.delete(promise)); return promise;
}
async function choose(owner: ReturnType<typeof sender>, channel = "browser:network-pages") {
  const reply = await invoke(channel, owner, ID);
  expect(reply).toMatchObject({ ok: true, pages: [{ origin: ORIGIN, ordinal: 1, handle: expect.any(String) }] });
  return reply.pages[0].handle as string;
}
async function start(owner: ReturnType<typeof sender>, requestId: string, channel = "browser:network-observe") {
  const selection = await choose(owner); const offset = controls.length;
  const operation = invoke(channel, owner, ID, { selection, requestId }); await flush();
  expect(controls).toHaveLength(offset + 1); return { operation, control: controls[offset], selection };
}
function owned() {
  const child = new ChildProcess(); Object.defineProperty(child, "pid", { value: PID, writable: true, configurable: true });
  child.exitCode = null; child.signalCode = null; child.killed = false; child.kill = h.forbidden as typeof child.kill; child.disconnect = h.forbidden;
  h.declaredPids.add(PID);
  const entry = { pid: PID, process: child, port: PORT, engine: "chromium" as const, lastActivityAt: 1,
    launchProxy: captureLaunchProxySnapshot({ mode: "none", name: null, config: null }), proxyBridge: { close: h.forbidden } };
  runningProcesses.set(ID, entry); return entry;
}
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
function role(value: "owner" | "viewer") {
  const cfg = structuredClone(getConfig());
  cfg.team = { name: "Network read-permission workspace", enabled: true, ownerDeviceId: cfg.deviceId!, updatedAt: 1,
    members: [{ deviceId: cfg.deviceId!, name: "Synthetic IPC device", role: value, addedAt: 1 }] };
  saveConfig(cfg);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(AT);
  h.state.failRename = false; vi.clearAllMocks(); h.list.mockReset(); h.create.mockReset(); h.safeUrl.mockReset(); h.launchGate.mockReset();
  controls.length = 0; senders.clear(); h.declaredPids.clear(); runningProcesses.clear();
  for (const name of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, name), { recursive: true, force: true });
  initializeSecretStorage({ backend: "os", reason: "synthetic IPC unit only", userDataDir: h.root, keyPath: path.join(h.root, "unused-key") }, { osStorage: h.safeStorage });
  reloadConfig(); const cfg = structuredClone(getConfig());
  cfg.browserProfiles[ID] = { name: "Network IPC fixture", engine: "chromium", fingerprintMode: "off", proxyMode: "none", note: "unchanged IPC profile", fingerprintBaseline: BASELINE };
  saveConfig(cfg); owned();
  h.list.mockImplementation(async (port: number, options: LowOptions) => {
    expect(port).toBe(PORT); options.assertCurrent();
    expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.deadline).toBeLessThanOrEqual(Date.now() + 5_000);
    return [{ id: `ipc-target-${PRIVATE}`, origin: ORIGIN, webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/ipc-target-${PRIVATE}` }];
  });
  h.create.mockImplementation(async (port: number, target: Target, options: LowOptions) => {
    options.assertCurrent(); const control = observer(port, target, options); controls.push(control); return control.handle;
  });
  h.launchGate.mockReturnValue({ allowed: false, code: "LICENSE_EXPIRED", error: "synthetic expired launch permission" });
  h.safeUrl.mockImplementation(async (url: string) => url);
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: unknown) => {
    if (signal === 0 && h.declaredPids.has(pid)) return true;
    return h.forbidden("nonfixture process signal");
  }) as typeof process.kill);
  vi.stubGlobal("fetch", h.forbidden); vi.stubGlobal("WebSocket", h.forbidden);
});
afterEach(async () => {
  h.state.failRename = false;
  for (const owner of senders) if (!owner.isDestroyed()) destroy(owner);
  for (const control of controls) control.complete();
  await flush(); await Promise.allSettled([...operations]); await flush();
  for (const owner of senders) expect(owner.listenerCount("destroyed")).toBe(0);
  expect(h.fds.size).toBe(0); expect(h.forbidden).not.toHaveBeenCalled();
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain(PRIVATE);
  runningProcesses.clear(); resetSecretStorageForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
afterAll(() => {
  const current = fs.lstatSync(h.root);
  if (current.isSymbolicLink() || current.dev !== h.identity.dev || current.ino !== h.identity.ino || !path.basename(h.root).startsWith("ipc-network-unit-")) throw new Error("Unsafe IPC network fixture cleanup");
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("actual positional network IPC handlers and cloak aliases", () => {
  it("the real revision dependency resolves only the owned temporary root once at zip-writer import", () => {
    expect(h.importRealpaths).toHaveLength(1);
    expect(h.importRealpaths[0]).toMatchObject({ input: h.root, resolved: h.root });
    const caller = h.importRealpaths[0].stack.split("\n").find(line => line.includes("/src/main/services/zip-writer.ts:"));
    expect(caller).toEqual(expect.any(String));
    console.info("[network IPC owned import] " + caller!.trim());
  });

  it("registers every new route through the same browser/cloak handler without new jobs or polling", () => {
    for (const action of ["network-pages", "network-observe", "health-clear"]) {
      expect(h.handlers.get(`browser:${action}`)).toEqual(expect.any(Function));
      expect(h.handlers.get(`cloak:${action}`)).toBe(h.handlers.get(`browser:${action}`));
    }
    for (const channel of ["browser:network-start", "browser:network-poll", "browser:network-job", "cloak:network-start"]) expect(h.handlers.has(channel)).toBe(false);
  });

  it.each(["browser", "cloak"])("%s pages/observe await one owned result and persist only a canonical queryable summary", async namespace => {
    const owner = sender(); const profile = structuredClone(disk().browserProfiles[ID]);
    const before = fs.readFileSync(getConfigPath()); const selection = await choose(owner, `${namespace}:network-pages`);
    expect(h.create).not.toHaveBeenCalled(); expect(fs.readFileSync(getConfigPath())).toEqual(before);
    const pending = invoke(`${namespace}:network-observe`, owner, ID, { selection, requestId: `${namespace}-awaited` });
    let settled = false; pending.then(() => { settled = true; }); await flush();
    expect(controls).toHaveLength(1); expect(settled).toBe(false);
    controls[0].arm(); controls[0].complete(); const reply = await pending;
    expect(reply).toMatchObject({ outcome: "inconclusive", requestId: `${namespace}-awaited`, observation: { completion: "completed" }, hops: [{ origin: REQUEST_ORIGIN }], httpStatusEvidence: [] });
    expect(JSON.stringify(reply)).not.toContain(PRIVATE);
    const stored = disk().profileHealthHistory[ID]; expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "network", requestId: `${namespace}-awaited`, summary: "NETWORK_OBSERVATION_V1", networkSummary: reply.observation });
    expect(disk().browserProfiles[ID]).toEqual(profile);
    const bytes = fs.readFileSync(getConfigPath(), "utf8");
    for (const sentinel of [PRIVATE, ORIGIN, REQUEST_ORIGIN, "httpStatusEvidence", "ipc-local-hop", "webSocketDebuggerUrl"]) expect(bytes).not.toContain(sentinel);
    reloadConfig();
    const history = await invoke(`${namespace}:health-history`, owner, ID);
    expect(history.entries.find((entry: any) => entry.kind === "network" && entry.requestId === `${namespace}-awaited`)).toEqual(stored[0]);
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it.each([
    { port: PORT }, { cdpPort: PORT }, { url: `${ORIGIN}/private?token=${PRIVATE}` },
    { origin: ORIGIN }, { targetId: "ipc-target" }, { debuggerTarget: "ipc-target" },
    { webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/ipc-target` },
    { owner: "ipc:602" }, { signal: {} }, { onArmed: () => undefined }, { allowLaunch: true },
    { credentials: PRIVATE }, { source: "runtime" }, { armedAt: AT }, { observedAt: AT }, { observeForMs: 1 },
  ])("rejects unknown observer authority/input keys %# before protocol work", async extra => {
    const owner = sender(); const selection = await choose(owner); const listed = h.list.mock.calls.length;
    const before = fs.readFileSync(getConfigPath());
    expect(await invoke("browser:network-observe", owner, ID, { selection, requestId: "strict-options", ...extra })).toMatchObject({ ok: false, code: "HEALTH_INVALID_REQUEST" });
    expect(h.create).not.toHaveBeenCalled(); expect(h.list).toHaveBeenCalledTimes(listed); expect(fs.readFileSync(getConfigPath())).toEqual(before);
  });

  it.each([null, [], "selection-only", {}, { selection: "not-a-UUID", requestId: "bad request" }, { selection: 45682, requestId: "typed-request" }])("rejects malformed observation options %#", async options => {
    expect(await invoke("browser:network-observe", sender(), ID, options)).toMatchObject({ ok: false });
    expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });

  it.each([null, PORT, "../unowned-profile", { dirId: ID }, { dirId: ID, port: PORT }, { dirId: ID, url: ORIGIN }])("page listing accepts only the positional profile identity %#", async input => {
    const before = fs.readFileSync(getConfigPath());
    expect(await invoke("browser:network-pages", sender(), input)).toMatchObject({ ok: false, pages: [] });
    expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled(); expect(fs.readFileSync(getConfigPath())).toEqual(before);
  });

  it("does not accept a frontend port as an additional listing or observation authority", async () => {
    const owner = sender();
    expect(await invoke("browser:network-pages", owner, ID, { port: PORT })).toMatchObject({ ok: false, pages: [] });
    const selection = await choose(owner);
    expect(await invoke("browser:network-observe", owner, ID, { selection, requestId: "extra-position" }, PORT)).toMatchObject({ ok: false });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("derives sender ownership in main and cannot transfer a listed selection to another window", async () => {
    const owner = sender(); const foreign = sender(602); const selection = await choose(owner);
    const reply = await invoke("browser:network-observe", foreign, ID, { selection, requestId: "foreign-window" });
    expect(reply.ok).toBe(false); expect(h.create).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalled(); expect(foreign.send).not.toHaveBeenCalled();
  });

  it.each(["browser", "cloak"])("%s reused history/cancel routes sanitize a private malformed profile identity", async namespace => {
    const owner = sender(); const before = fs.readFileSync(getConfigPath());
    const unsafeId = `https://${PRIVATE}:password@private.invalid/path?token=${PRIVATE}#fragment`;
    const history = await invoke(`${namespace}:health-history`, owner, unsafeId);
    expect(history).toEqual({ ok: false, entries: [], outcome: "error", code: "HEALTH_INVALID_REQUEST" });
    const cancel = await invoke(`${namespace}:health-cancel`, owner, unsafeId, { kind: "network", requestId: "malformed-profile-cancel" });
    expect(cancel).toEqual({ success: false, cancelled: false, code: "HEALTH_INVALID_REQUEST" });
    const bytes = JSON.stringify({ history, cancel });
    for (const text of [PRIVATE, "private.invalid", "password", "token=", "fragment"]) expect(bytes).not.toContain(text);
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });

  it("an unexpected canonical history read exception returns only static allowlisted failure fields", async () => {
    const cfg = getConfig(); const descriptor = Object.getOwnPropertyDescriptor(cfg, "profileHealthHistory");
    if (!descriptor) throw new Error("Owned canonical history descriptor is required");
    const before = fs.readFileSync(getConfigPath());
    Object.defineProperty(cfg, "profileHealthHistory", { configurable: true, enumerable: true, get: () => { throw new Error(`${PRIVATE} private storage/native exception`); } });
    try {
      const reply = await invoke("browser:health-history", sender(), ID);
      expect(reply).toEqual({ ok: false, entries: [], outcome: "error", code: "NETWORK_OBSERVATION_FAILED" });
      expect(JSON.stringify(reply)).not.toContain(PRIVATE);
    } finally { Object.defineProperty(cfg, "profileHealthHistory", descriptor); }
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });

  it("does not discover/adopt an apparent process, use BiDi, or auto-launch missing runtime", async () => {
    for (const mode of ["stopped", "adopted", "firefox"] as const) {
      const entry = owned();
      if (mode === "stopped") runningProcesses.delete(ID);
      if (mode === "adopted") (entry as any).process = null;
      if (mode === "firefox") { (entry as any).engine = "firefox"; (entry as any).bidiConn = { close: h.forbidden, send: h.forbidden }; }
      expect(await invoke("browser:network-pages", sender(), ID)).toMatchObject({ ok: false, pages: [] });
    }
    expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled(); expect(h.launchGate).not.toHaveBeenCalled();
  });
});

describe("armed notification ownership, cancellation, cleanup and clear", () => {
  it("sends only the exact correlated notification to the invoking sender, after actual arming", async () => {
    const owner = sender(); const foreign = sender(602); const current = await start(owner, "armed-owner");
    expect(owner.send).not.toHaveBeenCalled(); expect(foreign.send).not.toHaveBeenCalled();
    const armedAt = current.control.arm();
    expect(owner.send).toHaveBeenCalledExactlyOnceWith("browser:network-armed", { dirId: ID, requestId: "armed-owner", armedAt, observeForMs: 10_000 });
    expect(foreign.send).not.toHaveBeenCalled();
    // Repeated/overwide protocol callbacks cannot gain notification authority.
    current.control.options.onArmed?.({ armedAt, observeForMs: 10_000, raw: PRIVATE } as Armed);
    expect(owner.send).toHaveBeenCalledTimes(1);
    current.control.complete(); await current.operation;
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it("rejects cross-sender, wrong-kind and wrong-request cancellations without touching the real lease", async () => {
    const owner = sender(); const foreign = sender(602); const current = await start(owner, "cancel-owned");
    for (const [who, options] of [
      [foreign, { kind: "network", requestId: "cancel-owned" }],
      [owner, { kind: "env", requestId: "cancel-owned" }],
      [owner, { kind: "network", requestId: "other-request" }],
    ] as const) expect(await invoke("browser:health-cancel", who, ID, options)).toMatchObject({ success: false, cancelled: false,
      code: options.kind === "network" ? "HEALTH_INVALID_REQUEST" : "HEALTH_NOT_OWNED" });
    expect(current.control.options.signal.aborted).toBe(false);
    expect(await invoke("cloak:health-cancel", owner, ID, { kind: "network", requestId: "cancel-owned" })).toMatchObject({ success: true, cancelled: true });
    expect(current.control.options.signal.aborted).toBe(true);
    current.control.options.onArmed?.({ armedAt: Date.now(), observeForMs: 10_000 }); expect(owner.send).not.toHaveBeenCalled();
    const selection = await choose(owner);
    expect(await invoke("browser:network-observe", owner, ID, { selection, requestId: "cancel-still-open" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    current.control.complete(); expect(await current.operation).toMatchObject({ ok: false, outcome: "cancelled" });
    expect(disk().profileHealthHistory[ID] ?? []).toEqual([]);
  });

  it("owned IPC cancellation preserves the observer stop time and known responses across later cleanup", async () => {
    const owner = sender(); const entry = runningProcesses.get(ID)!;
    const current = await start(owner, "ipc-stop-before-cleanup"); const armedAt = current.control.arm();
    const genuine = payload(armedAt);
    genuine.observation = { ...genuine.observation, completion: "cancelled", stopReason: "cancelled", endedAt: armedAt + 1_000, durationMs: 1_000,
      coverage: { ...genuine.observation.coverage, network: "partial" } };
    vi.setSystemTime(genuine.observation.endedAt);
    expect(await invoke("browser:health-cancel", owner, ID, { kind: "network", requestId: "ipc-stop-before-cleanup" })).toEqual({ success: true, cancelled: true });
    expect(current.control.options.signal.aborted).toBe(true);
    vi.setSystemTime(armedAt + 3_000); current.control.complete(genuine);
    const reply = await current.operation;
    expect(reply).toMatchObject({ ok: false, outcome: "cancelled", requestId: "ipc-stop-before-cleanup", code: "HEALTH_CANCELLED" });
    expect(reply.observation).toEqual(genuine.observation); expect(reply.hops).toEqual(genuine.hops); expect(reply.httpStatusEvidence).toEqual(genuine.httpStatusEvidence);
    expect(reply.observation).toMatchObject({ endedAt: armedAt + 1_000, durationMs: 1_000, counts: { responses: 1, finished: 1 } });
    expect(Date.now()).toBe(armedAt + 3_000); expect(runningProcesses.get(ID)).toBe(entry);
    reloadConfig(); expect((await invoke("browser:health-history", owner, ID)).entries).toEqual([]);
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it("sender destruction aborts work, suppresses late armed/results, removes its listener and never closes the browser", async () => {
    const owner = sender(); const entry = runningProcesses.get(ID)!; const current = await start(owner, "sender-destroyed");
    expect(owner.listenerCount("destroyed")).toBe(1); destroy(owner);
    expect(current.control.options.signal.aborted).toBe(true);
    current.control.options.onArmed?.({ armedAt: Date.now(), observeForMs: 10_000 });
    current.control.complete(); expect(await current.operation).toMatchObject({ ok: false, outcome: "cancelled" });
    expect(owner.send).not.toHaveBeenCalled(); expect(owner.listenerCount("destroyed")).toBe(0);
    expect(runningProcesses.get(ID)).toBe(entry); expect(disk().profileHealthHistory[ID] ?? []).toEqual([]);
  });

  it("an already destroyed sender cannot list pages or create an observation", async () => {
    const owner = sender(); destroy(owner);
    expect(await invoke("browser:network-pages", owner, ID)).toMatchObject({ ok: false, pages: [] });
    expect(await invoke("browser:network-observe", owner, ID, { selection: "00000000-0000-4000-8000-000000000001", requestId: "dead-owner" })).toMatchObject({ ok: false });
    expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled(); expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it.each(["browser:health-clear", "cloak:health-clear"])("%s invalidates active network work before deletion and never allows late writeback", async channel => {
    const owner = sender(); recordProfileHealthResult(ID, { kind: "env", at: AT - 1, outcome: "inconclusive", source: "host", summary: "keep other diagnostic kind" });
    const first = await start(owner, "before-ipc-clear"); first.control.arm(); first.control.complete(); await first.operation;
    const current = await start(owner, "during-ipc-clear");
    expect(await invoke(channel, owner, ID, "network")).toEqual({ ok: true });
    expect(current.control.options.signal.aborted).toBe(true);
    expect(disk().profileHealthHistory[ID].map((entry: any) => entry.kind)).toEqual(["env"]);
    current.control.complete(); expect(await current.operation).toMatchObject({ ok: false, outcome: "cancelled" });
    reloadConfig(); const history = await invoke("browser:health-history", owner, ID);
    expect(history.entries.map((entry: any) => entry.kind)).toEqual(["env"]);
  });

  it("healthClear with no kind removes all canonical kinds without changing profile metadata", async () => {
    const owner = sender(); const profile = structuredClone(disk().browserProfiles[ID]);
    const current = await start(owner, "clear-all"); current.control.arm(); current.control.complete(); await current.operation;
    recordProfileHealthResult(ID, { kind: "env", at: AT - 1, outcome: "inconclusive", source: "host", summary: "clear environment too" });
    expect(await invoke("browser:health-clear", owner, ID)).toEqual({ ok: true });
    reloadConfig(); expect((await invoke("browser:health-history", owner, ID)).entries).toEqual([]); expect(disk().browserProfiles[ID]).toEqual(profile);
  });

  it.each(["unknown", { kind: "network" }, { kind: "network", port: PORT }, null, ["network"]])("strict healthClear kind rejects %# without deletion", async kind => {
    const before = fs.readFileSync(getConfigPath());
    expect(await invoke("browser:health-clear", sender(), ID, kind)).toMatchObject({ ok: false });
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
  });

  it("clear commit failure is explicit, preserves actual disk, and still prevents the invalidated run from restoring history", async () => {
    const owner = sender(); const current = await start(owner, "clear-write-failed"); const before = fs.readFileSync(getConfigPath());
    h.state.failRename = true;
    expect(await invoke("browser:health-clear", owner, ID, "network")).toMatchObject({ ok: false });
    expect(current.control.options.signal.aborted).toBe(true); expect(fs.readFileSync(getConfigPath())).toEqual(before);
    h.state.failRename = false; current.control.complete(); expect(await current.operation).toMatchObject({ ok: false, outcome: "cancelled" });
    reloadConfig(); expect((await invoke("browser:health-history", owner, ID)).entries).toEqual([]);
  });

  it("returning cleanup-unverified does not free the IPC-owned lease before the actual closed promise", async () => {
    const owner = sender(); const current = await start(owner, "ipc-cleanup-unverified"); const armedAt = current.control.arm();
    const value = payload(armedAt); value.observation.completion = "partial"; value.observation.stopReason = "cleanup-unverified"; value.observation.coverage.network = "partial";
    current.control.complete(value, false);
    expect(await current.operation).toMatchObject({ observation: { stopReason: "cleanup-unverified" } });
    expect(await invoke("browser:network-observe", owner, ID, { selection: await choose(owner), requestId: "ipc-cleanup-overlap" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    expect((await invoke("browser:health-history", owner, ID)).entries).toEqual([]);
    current.control.close(); await flush();
    const next = await start(owner, "ipc-after-close"); next.control.arm(); next.control.complete(); await next.operation;
    expect((await invoke("browser:health-history", owner, ID)).entries.map((entry: any) => entry.requestId)).toEqual(["ipc-after-close"]);
  });

  it.each(["restart", "bridge-replaced"])("%s between awaits revokes the selection/result and sends no late armed notification", async mode => {
    const owner = sender(); const current = await start(owner, `ipc-${mode}`);
    const entry = runningProcesses.get(ID)!;
    if (mode === "restart") runningProcesses.set(ID, { ...entry });
    else entry.proxyBridge = { close: h.forbidden };
    current.control.options.onArmed?.({ armedAt: Date.now(), observeForMs: 10_000 });
    current.control.complete(); expect(await current.operation).toMatchObject({ ok: false });
    expect(owner.send).not.toHaveBeenCalled(); expect((await invoke("browser:health-history", owner, ID)).entries).toEqual([]);
  });
});

describe("diagnostic read permission remains separate from baseline/launch/navigation mutation gates", () => {
  it("viewer can list/observe/read/clear diagnostic history without baseline permission or a launch license", async () => {
    role("viewer"); const owner = sender(); const before = structuredClone(disk().browserProfiles[ID]);
    const current = await start(owner, "viewer-read"); current.control.arm(); current.control.complete();
    expect(await current.operation).toMatchObject({ outcome: "inconclusive", observation: { completion: "completed" } });
    expect((await invoke("browser:health-history", owner, ID)).entries).toHaveLength(1);
    expect(await invoke("browser:health-clear", owner, ID, "network")).toEqual({ ok: true });
    expect(disk().browserProfiles[ID]).toEqual(before); expect(h.launchGate).not.toHaveBeenCalled(); expect(h.safeUrl).not.toHaveBeenCalled();
    expect(await invoke("browser:capture-baseline", owner, ID)).toMatchObject({ ok: false, code: "TEAM_ROLE_DENIED" });
    expect(disk().browserProfiles[ID].fingerprintBaseline).toEqual(BASELINE);
  });

  it("another device's checkout lock does not turn read-only network diagnostics into baseline mutation", async () => {
    // Lock is not a public metadata patch field. Seed the owned real store,
    // rather than silently omitting it through setProfileMeta's whitelist.
    const cfg = structuredClone(getConfig());
    const lock = { owner: "other-network-device", ownerName: "Other", at: 1 };
    cfg.browserProfiles[ID].lock = lock; saveConfig(cfg);
    expect(disk().browserProfiles[ID].lock).toEqual(lock);
    reloadConfig(); expect(getConfig().browserProfiles[ID].lock).toEqual(lock);
    const owner = sender(); const before = structuredClone(disk().browserProfiles[ID]);
    const current = await start(owner, "locked-read"); current.control.arm(); current.control.complete();
    const reply = await current.operation;
    expect(reply).toMatchObject({ ok: true, outcome: "inconclusive", requestId: "locked-read", observation: { completion: "completed" } });
    const completed = disk().profileHealthHistory[ID].find((entry: any) => entry.kind === "network" && entry.requestId === "locked-read");
    expect(completed).toMatchObject({ kind: "network", requestId: "locked-read", source: "runtime", outcome: "inconclusive", summary: "NETWORK_OBSERVATION_V1", networkSummary: { completion: "completed" } });
    expect(completed.networkSummary).toEqual(reply.observation);
    reloadConfig(); expect(getConfig().browserProfiles[ID].lock).toEqual(lock);
    expect((await invoke("browser:health-history", owner, ID)).entries).toContainEqual(completed);
    expect(disk().browserProfiles[ID]).toEqual(before);
    expect(await invoke("browser:capture-baseline", owner, ID)).toMatchObject({ ok: false, error: expect.stringContaining("locked") });
    expect(disk().browserProfiles[ID].fingerprintBaseline).toEqual(BASELINE);
  });

  it("existing launch license and navigation URL gates still reject before any runtime/native capability", async () => {
    role("owner"); const owner = sender();
    expect(await invoke("browser:launch", owner, { dirId: ID })).toMatchObject({ success: false, code: "LICENSE_EXPIRED" });
    expect(h.launchGate).toHaveBeenCalledTimes(1);
    h.safeUrl.mockRejectedValueOnce(new Error("synthetic unsafe navigation URL refused"));
    expect(await invoke("browser:open-risk-check", owner, { dirId: ID, url: "file:///synthetic-unowned", allowLaunch: true })).toMatchObject({ success: false, error: expect.stringContaining("unsafe navigation") });
    expect(h.list).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });
});
