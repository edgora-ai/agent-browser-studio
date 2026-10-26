// Regression for #112: real sync/config/restore lease + HTTP/WS, with an owned synthetic Node cookie writer.
// This child is NOT Firefox; these lifecycle models are not native-browser acceptance evidence.
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { setTimeout as safetyTimer, clearTimeout as clearSafetyTimer } from "node:timers";
import { gzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import type { CookieInfo, SyncResult } from "../../src/main/types.js";

const h = await vi.hoisted(async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const parent = fs.realpathSync(os.tmpdir()), root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "abs-sync-bidi-boundary-")));
  const owner = fs.lstatSync(root);
  if (!owner.isDirectory() || owner.isSymbolicLink() || (typeof process.getuid === "function" && owner.uid !== process.getuid()) || owner.dev !== fs.statSync(parent).dev) throw new Error("Unsafe owned runtime root");
  const env = { HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp") };
  const script = `
    const fs = require('node:fs'), assert = require('node:assert/strict'), file = require('node:path').join(process.cwd(), 'cookie-jar.json');
    const values = { first_synthetic: 'synthetic-late-value', must_not_dispatch: 'synthetic-second-value' };
    let fd, owner, rows = [];
    process.on('message', m => {
      if (m?.op === 'exit') { assert.deepEqual(m, {op: 'exit'}); if (fd !== undefined) fs.closeSync(fd); process.exit(0); }
      assert.ok(Number.isSafeInteger(m?.id) && m.id > 0);
      if (m.op === 'init') { assert.deepEqual(m, {op: 'init', id: m.id}); assert.equal(fd, undefined); fd = fs.openSync(file, 'wx+', 0o600); owner = fs.fstatSync(fd); }
      else {
        assert.deepEqual(Object.keys(m).sort(), ['cookie', 'id', 'op']); assert.equal(m.op, 'write'); const c = m.cookie;
        assert.ok(Object.hasOwn(values, c.name)); assert.deepEqual(c, {name: c.name, value: {type: 'string', value: values[c.name]}, domain: 'sync-boundary.example.test', path: '/', size: values[c.name].length, httpOnly: true, secure: true, sameSite: 'lax'});
        const current = fs.lstatSync(file); assert.ok(!current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino); rows.push(c);
      }
      fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(rows), 0, 'utf8'); fs.fsyncSync(fd); process.send({id: m.id});
    });
    process.send({ready: true});`;
  return { root, owner, env, script, port: 0, pid: 0, blocked: [] as string[],
    leases: [] as Array<{ fd: number; dev: number; ino: number; closed: boolean }> };
});
vi.mock("electron", () => ({ app: { getPath: (name: string) => {
  if (name === "userData") return h.root;
  if (name === "home") return h.env.HOME;
  throw new Error("Unexpected Electron path request");
} } }));
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: () => ({ running: true, pid: h.pid, cdpPort: h.port }) }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const deny = (name: string): never => { h.blocked.push(`native:${name}`); throw new Error("Unowned child command forbidden"); };
  const blocked = { ...actual, ...Object.fromEntries(["spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map(name => [name, () => deny(name)])),
    spawn: (file: string, args: string[], options: any) => {
      if (file !== process.execPath || JSON.stringify(args) !== JSON.stringify(["-e", h.script]) ||
          JSON.stringify(options) !== JSON.stringify({ cwd: h.root, env: h.env, stdio: ["ignore", "ignore", "ignore", "ipc"] })) return deny("spawn");
      return actual.spawn(file, args, options);
    } };
  return { ...blocked, default: blocked };
});
// Transparent OS-backed FD observations only; config/store/lock implementations remain real.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args);
    if (String(args[0]).endsWith(".restore.lock") && typeof args[1] === "number" && (args[1] & actual.constants.O_EXCL)) {
      const { dev, ino } = actual.fstatSync(fd); h.leases.push({ fd, dev, ino, closed: false });
    }
    return fd;
  }, closeSync: (fd: number) => {
    actual.closeSync(fd);
    for (const lease of h.leases) if (lease.fd === fd && !lease.closed) lease.closed = true;
  } };
});

import { syncService } from "../../src/main/services/sync-service.js";
import { getConfig, getConfigPath, getProfilesDir, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { writeQueuedCookieImports, readQueuedCookieImports } from "../../src/main/services/cdp-cookie-service.js";
import { hasRunningFirefox, runtimeCookieOps } from "../../src/main/services/bidi-cookie-service.js";
import { connectBidi, registerFirefoxSession, dropFirefoxSession, getRegisteredFirefoxSession, type BidiConnection } from "../../src/main/services/bidi-client.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";
import { acquireRestoreLock, isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";
import { runWithProtocolDispatchGuard } from "../../src/main/services/agent/dispatch-guard.js";
import { createProfileSyncBaseline, getProfileSyncTarget, profilePreferencesSnapshot } from "../../src/main/services/sync/profile-state.js";

const ID = "ff_sync_bidi_boundary", HOST = "127.0.0.1", OBJECT = "/synthetic/agent-browser-studio-config.json";
const COOKIE: CookieInfo = { domain: "sync-boundary.example.test", name: "first_synthetic", value: "synthetic-late-value", path: "/", expires: null, secure: true, httpOnly: true, sameSite: 1 };
const SECOND = { ...COOKIE, name: "must_not_dispatch", value: "synthetic-second-value" };
const QUEUED = { ...COOKIE, name: "queued_original", value: "synthetic-original-queue" };
const remoteFile = path.join(h.root, "remote.json"), jarFile = path.join(h.root, "cookie-jar.json"), queueFile = path.join(h.root, "pending-cookie-imports", `${ID}.json`);
type Request = { id: number; method: string; params: any };
let server: ReturnType<typeof createServer> | undefined, ws: WebSocketServer | undefined, conn: BidiConnection | undefined, writer: ChildProcess;
let pending: Promise<{ result?: SyncResult; error?: Error }> | undefined, controller: AbortController | undefined;
let releaseHeld: ((terminal?: "success" | "error" | "none") => Promise<void>) | undefined, heldSocket: WebSocket;
let calls: Request[], requests: string[], events: string[], closedSockets: Promise<unknown>[], children: ChildProcess[], closes: Map<ChildProcess, Promise<unknown>>;
let wire: EventEmitter, cookieReplies: number, peerClosed: boolean, ipcId: number, guardAllowed: boolean, guardChecks: number, guardFaults: number;
let guardFailureStack: string | undefined, guardRecovered: boolean;
let launchedChildren = 0, actualChildCloses = 0;
const jar = (): any[] => JSON.parse(fs.readFileSync(jarFile, "utf8"));
const writes = () => calls.filter(request => request.method === "storage.setCookie");
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const same = (stat: fs.Stats | undefined, owner: { dev: number; ino: number }) => !!stat && !stat.isSymbolicLink() && stat.dev === owner.dev && stat.ino === owner.ino;
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof safetyTimer> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = safetyTimer(() => reject(new Error("Owned fixture did not settle promptly")), 3000); })]); }
  finally { clearSafetyTimer(timer); }
}
function originalFd(lease: (typeof h.leases)[number]): string {
  try { return !lease.closed && same(fs.fstatSync(lease.fd), lease) ? "open-original" : "closed-or-reused"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EBADF") return "closed:EBADF"; throw error; }
}
function reply(socket: WebSocket, id: number, result: unknown): void { socket.send(JSON.stringify({ type: "success", id, result })); }
async function childCall(child: ChildProcess, op: "init" | "write", cookie?: unknown): Promise<void> {
  const id = ++ipcId, ack = once(wire, `writer:${child.pid}:${id}`);
  child.send({ op, id, ...(cookie === undefined ? {} : { cookie }) }); await bounded(ack);
}
async function ownedChild(initialize: boolean): Promise<ChildProcess> {
  expect(same(fs.lstatSync(h.root), h.owner)).toBe(true);
  const child = spawn(process.execPath, ["-e", h.script], { cwd: h.root, env: h.env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child); launchedChildren++;
  closes.set(child, once(child, "close").then(args => { actualChildCloses++; return args; }));
  child.once("exit", (code, signal) => { events.push(`child-exit:${child.pid}:${code}:${signal}`); });
  expect((await bounded(once(child, "message")))[0]).toEqual({ ready: true });
  child.on("message", (message: any) => wire.emit(`writer:${child.pid}:${message.id}`, message));
  if (initialize) await childCall(child, "init");
  return child;
}
async function exitChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ op: "exit" });
  await bounded(closes.get(child)!);
  expect(child.exitCode).toBe(0); expect(child.signalCode).toBeNull();
}
async function persistAndReply(socket: WebSocket, request: Request, terminal: "success" | "none" = "success"): Promise<void> {
  await childCall(writer, "write", request.params.cookie); events.push(`file-write:${request.params.cookie.name}`);
  if (terminal === "success") { reply(socket, request.id, { partitionKey: { userContext: "default" } }); cookieReplies++; events.push(`reply:${request.id}`); }
}
async function shutdown(): Promise<void> {
  controller?.abort();
  await Promise.all(children.map(exitChild)); // Only the exact owned processes, normal IPC exit + actual close.
  if (pending) await bounded(pending);
  dropFirefoxSession(h.port); runningProcesses.delete(ID); conn?.close(); conn = undefined;
  if (ws) {
    for (const socket of ws.clients) socket.close(); await bounded(Promise.all(closedSockets));
    const closing = ws; ws = undefined;
    await new Promise<void>((resolve, reject) => closing.close(error => error ? reject(error) : resolve()));
  }
  if (server) {
    const closing = server; server = undefined; closing.closeAllConnections();
    await new Promise<void>((resolve, reject) => closing.close(error => error ? reject(error) : resolve()));
  }
}
beforeEach(async () => {
  calls = []; requests = []; events = []; closedSockets = []; children = []; closes = new Map(); wire = new EventEmitter();
  cookieReplies = 0; peerClosed = false; ipcId = 0; guardAllowed = true; guardChecks = 0; guardFaults = 0; guardFailureStack = undefined; guardRecovered = false;
  releaseHeld = undefined; pending = undefined; controller = undefined; h.leases.length = 0; h.blocked.length = 0;
  for (const folder of [h.env.HOME, h.env.TMPDIR]) fs.mkdirSync(folder, { mode: 0o700 });
  writer = await ownedChild(true); h.pid = writer.pid!;
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: unknown) => {
    if (signal === 0 && (pid === process.pid || children.some(child => child.pid === pid && child.exitCode === null && child.signalCode === null))) return true;
    h.blocked.push("process-signal"); throw new Error("Unowned process access forbidden");
  }) as any);
  const connect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0], options = typeof first === "object" ? first : { port: first, host: args[1] };
    if (options.path || options.host !== HOST || Number(options.port) !== h.port || !h.port) { h.blocked.push("unowned-network"); throw new Error("Only the owned loopback endpoint is allowed"); }
    return Reflect.apply(connect, this, args);
  } as any);
  const fetchOwned = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    if (url !== `http://${HOST}:${h.port}${OBJECT}` || (init?.method || "GET") !== "GET") { h.blocked.push("unowned-fetch-or-mutation"); return Promise.reject(new Error("Unexpected fixture HTTP request")); }
    return fetchOwned(input, { ...init, redirect: "error" });
  });
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method !== "GET" || request.url !== OBJECT) { h.blocked.push("unexpected-http"); response.writeHead(403).end(); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(fs.readFileSync(remoteFile));
  });
  ws = new WebSocketServer({ server, path: "/session" });
  ws.on("connection", socket => {
    closedSockets.push(once(socket, "close")); socket.on("close", () => { peerClosed = true; });
    socket.on("message", bytes => {
      const request = JSON.parse(bytes.toString()) as Request; calls.push(request);
      if (request.method === "session.new") reply(socket, request.id, { sessionId: "synthetic-session", capabilities: {} });
      else if (request.method === "storage.setCookie") {
        events.push(`wire:${request.params.cookie.name}`);
        if (writes().length === 1) {
          heldSocket = socket; let released = false;
          releaseHeld = async (terminal = "success") => {
            if (released) return; released = true;
            if (terminal === "error") { socket.send(JSON.stringify({ type: "error", id: request.id, error: "unable to set cookie", message: "synthetic rejection" })); cookieReplies++; }
            else await persistAndReply(socket, request, terminal);
          };
          wire.emit("held", request);
        } else void persistAndReply(socket, request).catch(error => wire.emit("error", error));
      } else if (request.method === "storage.getCookies") reply(socket, request.id, { cookies: jar().filter(cookie => !request.params?.filter?.name || cookie.name === request.params.filter.name), partitionKey: { userContext: "default" } });
      else { h.blocked.push("unexpected-protocol-command"); socket.send(JSON.stringify({ type: "error", id: request.id, error: "unknown command", message: "fixture command forbidden" })); }
    });
  });
  server.listen(0, HOST); await once(server, "listening"); h.port = (server.address() as net.AddressInfo).port;
});
afterEach(async () => {
  try { await shutdown(); }
  finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); expect(same(fs.lstatSync(h.root), h.owner)).toBe(true);
    for (const child of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, child), { recursive: true });
  }
});
afterAll(() => {
  const rootSame = same(fs.lstatSync(h.root), h.owner); expect(rootSame).toBe(true);
  expect(launchedChildren).toBeGreaterThan(0); expect(actualChildCloses).toBe(launchedChildren); fs.rmdirSync(h.root);
  const rootRemoved = fs.lstatSync(h.root, { throwIfNoEntry: false }) === undefined; expect(rootRemoved).toBe(true);
  console.info("[sync-bidi owned-cleanup]", JSON.stringify({ launchedChildren, actualChildCloses, rootSame, rootRemoved }));
});

async function prepare(artifactVersion = 2) {
  const endpoint = `http://${HOST}:${h.port}`, snapshotId = `synthetic-bidi-v${artifactVersion}`;
  saveConfig({ version: 4, chromiumBin: "auto", defaultProxy: "", proxies: {}, accounts: [], extensionRepository: {},
    deviceId: "synthetic-boundary-device", deviceName: "Synthetic device",
    browserProfiles: { [ID]: { name: "local-before", engine: "firefox", fingerprintMode: "managed", fingerprintSeed: 12345, platform: "macos" } },
    sync: { enabled: true, endpoint, bucket: "synthetic", accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: 1 },
  });
  const configBytes = fs.readFileSync(getConfigPath()); reloadConfig(); expect(getConfig()).toEqual(JSON.parse(configBytes.toString()));
  writeQueuedCookieImports(ID, [QUEUED]); const queueBytes = fs.readFileSync(queueFile);
  expect(JSON.parse(queueBytes.toString())).toEqual([QUEUED]); expect(readQueuedCookieImports(ID, { strict: true })).toEqual([QUEUED]);
  const remote = structuredClone(getConfig()), incoming = { ...remote.browserProfiles[ID], name: "remote-not-adopted" };
  incoming.syncBaseline = createProfileSyncBaseline(incoming, profilePreferencesSnapshot(null), getProfileSyncTarget(remote.sync), snapshotId, 1); remote.browserProfiles[ID] = incoming;
  const encode = (value: unknown) => gzipSync(JSON.stringify(value)).toString("base64");
  fs.writeFileSync(remoteFile, JSON.stringify({ artifactVersion, snapshotId, timestamp: 1, data: encode(remote), cookies: { [ID]: encode([COOKIE, SECOND]) },
    ...(artifactVersion === 3 ? { history: { [ID]: { version: 1, snapshotId, dirId: ID, engine: "firefox", state: "unselected", freshness: "not-covered", code: "HISTORY_NOT_SELECTED" } } } : {}),
  }), { flag: "wx", mode: 0o600 });
  const dispatchGuard = (port: number) => {
    expect(port).toBe(h.port); guardChecks++; if (!guardAllowed) throw new Error("Synthetic dispatch authority revoked");
    if (guardFaults > 0) {
      guardFaults--; events.push("delivery-guard-rejected"); const error = new Error("Synthetic one-shot delivery guard failure"); guardFailureStack = error.stack; throw error;
    }
    if (guardFailureStack && !guardRecovered) { guardRecovered = true; events.push("delivery-guard-recovered"); }
  };
  conn = await runWithProtocolDispatchGuard(dispatchGuard, () => connectBidi(`ws://${HOST}:${h.port}/session`)); registerFirefoxSession(h.port, conn);
  runningProcesses.set(ID, { pid: h.pid, process: writer, port: h.port, lastActivityAt: 0, engine: "firefox", bidiConn: conn }); expect(hasRunningFirefox(ID)).toBe(true);
  return { endpoint, configBytes, queueBytes, remoteBytes: fs.readFileSync(remoteFile), dispatchGuard };
}
async function begin(artifactVersion = 2, modelDeadlines: boolean | "delivery" = false) {
  const f = await prepare(artifactVersion), clock = modelDeadlines ? captureDeadlines(modelDeadlines === "delivery") : undefined;
  const initialGuards = guardChecks, arrived = once(wire, "held"); controller = new AbortController();
  pending = runWithProtocolDispatchGuard(f.dispatchGuard, () => syncService.pull(controller!.signal, { strategy: "remote", allowRunningPartial: true })).then(
    result => { events.push("caller-fulfilled"); return { result }; }, error => { events.push("caller-rejected"); return { result: error.syncResult, error }; },
  );
  await bounded(Promise.race([arrived, pending.then(() => { throw new Error("Pull settled before the first real storage.setCookie reached the peer"); })]));
  expect(guardChecks).toBeGreaterThan(initialGuards); expect(writes().map(request => request.params.cookie.name)).toEqual([COOKIE.name]);
  const owner = syncService.getStatus().operation.active!; expect(owner).toMatchObject({ kind: "pull", stage: "applying" });
  const lockFile = path.join(h.root, "locks", `${ID}.restore.lock`), lockOwner = fs.lstatSync(lockFile), lockBytes = fs.readFileSync(lockFile);
  expect(JSON.parse(lockBytes.toString())).toMatchObject({ pid: process.pid, dirId: ID, token: expect.any(String) });
  expect(h.leases).toHaveLength(1); const lease = h.leases[0]; expect(originalFd(lease)).toBe("open-original");
  expect(same(lockOwner, lease)).toBe(true); expect(isRestoreLocked(ID)).toBe(true);
  const stages = fs.readdirSync(getProfilesDir()).filter(name => name.startsWith(".sync-pull-stage-")); expect(stages).toHaveLength(1);
  const stage = path.join(getProfilesDir(), stages[0]); return { ...f, clock, owner, lockFile, lockOwner, lockBytes, lease, stage, stageOwner: fs.lstatSync(stage) };
}
type Fixture = Awaited<ReturnType<typeof begin>>;
function observe(f: Fixture) {
  return { ownerSame: syncService.getStatus().operation.active?.operationId === f.owner.operationId,
    lockSame: same(fs.lstatSync(f.lockFile, { throwIfNoEntry: false }), f.lockOwner) && fs.readFileSync(f.lockFile).equals(f.lockBytes), fd: originalFd(f.lease),
    stageSame: same(fs.lstatSync(f.stage, { throwIfNoEntry: false }), f.stageOwner) };
}
async function retained(f: Fixture) {
  await turn(); expect(observe(f)).toEqual({ ownerSame: true, lockSame: true, fd: "open-original", stageSame: true });
  expect(events.some(event => event.startsWith("caller-"))).toBe(false); expect(writes().map(request => request.params.cookie.name)).toEqual([COOKIE.name]);
}
function released(f: Fixture) {
  expect(syncService.getStatus().operation.active).toBeNull(); expect(isRestoreLocked(ID)).toBe(false);
  expect(fs.lstatSync(f.stage, { throwIfNoEntry: false })).toBeUndefined(); expect(f.lease.closed).toBe(true);
  const release = acquireRestoreLock(ID); release(); expect(h.blocked).toEqual([]);
}
function unchanged(f: Awaited<ReturnType<typeof prepare>>) {
  expect(fs.readFileSync(getConfigPath())).toEqual(f.configBytes); reloadConfig();
  expect(Object.entries(getConfig().browserProfiles).find(([id]) => id === ID)?.[1].name).toBe("local-before");
  expect(fs.readFileSync(queueFile)).toEqual(f.queueBytes); expect(readQueuedCookieImports(ID, { strict: true })).toEqual([QUEUED]); expect(fs.readFileSync(remoteFile)).toEqual(f.remoteBytes);
}
function captureDeadlines(pauseGuardPolling = false) {
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval, abortTimeout = AbortSignal.timeout;
  const clock = { command: undefined as (() => void) | undefined, outer: undefined as (() => void) | undefined, guard: undefined as (() => void) | undefined,
    abort: new AbortController(), guardPollCalls: 0, suppressedPolls: 0 };
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const timer = timeout(callback, ms, ...args), fire = () => { clearTimeout(timer); callback(...args); };
    if (ms === 10000) clock.command = fire; if (ms === 30000) clock.outer = fire; return timer;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (ms === 25) clock.guard = () => { clock.guardPollCalls++; callback(...args); };
    // Only the delivery-fault model pauses polling, so the real reply consumes its one-shot fault.
    return interval(ms === 25 ? pauseGuardPolling ? () => { clock.suppressedPolls++; } : clock.guard! : callback, ms, ...args);
  }) as typeof setInterval);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 30000 ? clock.abort.signal : abortTimeout(ms));
  return clock;
}

it.each([2, 3])("v%i retains sync ownership and the original restore lease until an in-wire BiDi mutation settles", async artifactVersion => {
  const f = await begin(artifactVersion), { endpoint, configBytes, remoteBytes, lease } = f;
  try {
    expect(jar()).toEqual([]); expect(cookieReplies).toBe(0);
    events.push("abort"); controller!.abort(new Error("synthetic pull cancellation")); await turn();
    const observed = observe(f); events.push("boundary-observed");
    console.info(`[sync-bidi v${artifactVersion}] before-late-write`, JSON.stringify({ ...observed, fdNumber: lease.fd,
      callerSettled: events.some(event => event.startsWith("caller-")), cookieRows: jar().length, cookieReplies, peerClosed,
      child: { pid: writer.pid, exitCode: writer.exitCode, signalCode: writer.signalCode, killed: writer.killed } }));
    // Abort contenders AFTER synchronous admission; an admitted contender may not publish.
    const contention: string[] = [];
    for (const kind of ["push", "pull"] as const) {
      const abort = new AbortController(), attempt = kind === "push" ? syncService.push(abort.signal) : syncService.pull(abort.signal, { strategy: "remote", allowRunningPartial: true });
      abort.abort(); const result = await attempt.catch(error => error.syncResult); contention.push(result?.code || "NO_RESULT");
    }
    console.info(`[sync-bidi v${artifactVersion}] contention`, JSON.stringify({ push: contention[0], pull: contention[1] }));
    expect(jar()).toEqual([]); expect(cookieReplies).toBe(0); expect(peerClosed).toBe(false);
    await releaseHeld!(); const completed = await bounded(pending!);
    const rows = jar(), found = rows.find(cookie => cookie.domain === COOKIE.domain && cookie.name === COOKIE.name);
    expect(rows).toEqual([writes()[0].params.cookie]); expect(found).toMatchObject({ name: COOKIE.name, value: { type: "string", value: COOKIE.value } });
    expect(conn!.closed).toBe(false); expect(getRegisteredFirefoxSession(h.port)).toBe(conn);
    expect((await conn!.send("storage.getCookies", { filter: { name: COOKIE.name } })).cookies).toEqual(rows); await turn();
    expect(writes().map(request => request.params.cookie.name)).toEqual([COOKIE.name]); expect(cookieReplies).toBe(1);
    expect(calls.filter(request => request.method === "session.new")).toHaveLength(1); expect(peerClosed).toBe(false);
    expect(completed.error).toBeInstanceOf(Error);
    expect(completed.result).toMatchObject({ success: false, code: "SYNC_CANCELLED", outcome: "partial", localCommit: "unknown", remoteCommit: "none" });
    expect(completed.result?.items?.some(item => item.scope === "cookies" && item.state === "applied")).toBe(false); unchanged(f);
    expect(Buffer.from(await (await fetch(endpoint + OBJECT)).arrayBuffer())).toEqual(remoteBytes);
    expect(requests.every(request => request === `GET ${OBJECT}`)).toBe(true); released(f);
    console.info(`[sync-bidi v${artifactVersion}] late-write-readback`, JSON.stringify({ events, jarRows: rows.length,
      found: found.name, writes: writes().length, cookieReplies, result: completed.result?.code, localCommit: completed.result?.localCommit,
      configUnchanged: fs.readFileSync(getConfigPath()).equals(configBytes), remoteUnchanged: fs.readFileSync(remoteFile).equals(remoteBytes), borrowedSessionOpen: !conn!.closed }));
    expect({ ...observed, push: contention[0], pull: contention[1] },
      `PREMATURE_RELEASE v${artifactVersion}: unanswered in-wire storage.setCookie; no reply or runtime exit preceded this observation`).toEqual({
      ownerSame: true, lockSame: true, fd: "open-original", stageSame: true, push: "SYNC_BUSY", pull: "SYNC_BUSY",
    });
  } finally { await shutdown(); }
});

it("cancelled sync releases only after a well-formed error reply, without claiming an applied cookie", async () => {
  const f = await begin(); controller!.abort(); await retained(f); await releaseHeld!("error");
  const completed = await bounded(pending!);
  expect(completed.result).toMatchObject({ success: false, code: "SYNC_CANCELLED", localCommit: "unknown", remoteCommit: "none" });
  expect(completed.result?.items?.some(item => item.scope === "cookies" && item.state === "applied")).toBe(false);
  expect(jar()).toEqual([]); expect(cookieReplies).toBe(1); unchanged(f); released(f);
  expect((await conn!.send("storage.getCookies")).cookies).toEqual([]); expect(getRegisteredFirefoxSession(h.port)).toBe(conn);
});

it("bad same-ID envelopes, wrong IDs and unrelated events cannot settle the original mutation ticket", async () => {
  const f = await begin(), id = writes()[0].id; controller!.abort();
  for (const frame of [{ type: "success", id, result: null }, { type: "error", id, error: "unknown error" },
    { type: "success", id, result: {} }, { type: "success", id, result: { partitionKey: { userContext: "default" }, success: false } },
    { type: "error", id, error: 17, message: "bad error type" }, { type: "event", id, result: {} },
    { type: "success", id: id + 1000, result: {} }, { type: "event", method: "log.entryAdded", params: {} }]) {
    heldSocket.send(JSON.stringify(frame));
    expect((await conn!.send("storage.getCookies")).cookies).toEqual([]); // Ordered wire fence, not a sleep.
    if (frame.type === "success" && frame.id === id && frame.result !== null) console.info("[sync-bidi malformed-held]", JSON.stringify({
      frame, observed: observe(f), writerExitCode: writer.exitCode, writerSignalCode: writer.signalCode, jarRows: jar().length, cookieReplies, peerClosed }));
    await retained(f); expect(cookieReplies).toBe(0);
  }
  await releaseHeld!(); expect((await bounded(pending!)).result?.code).toBe("SYNC_CANCELLED");
  expect(jar()).toEqual([writes()[0].params.cookie]); unchanged(f); released(f);
});

it.each(["outer", "command", "guard"] as const)("%s deadline/revocation retains ownership and never dispatches a second cookie", async mode => {
  const f = await begin(2, true), clock = f.clock!;
  if (mode === "outer") { expect(clock.outer).toBeTypeOf("function"); clock.abort.abort(new DOMException("Synthetic deadline", "TimeoutError")); clock.outer!(); }
  else if (mode === "command") { expect(clock.command).toBeTypeOf("function"); clock.command!(); }
  else { guardAllowed = false; expect(clock.guard).toBeTypeOf("function"); clock.guard!(); }
  await retained(f); expect(jar()).toEqual([]); expect(writer.exitCode).toBeNull();
  await releaseHeld!(); const completed = await bounded(pending!);
  expect(completed.result).toMatchObject({ success: false, localCommit: "unknown", remoteCommit: "none" });
  expect(completed.result?.items?.some(item => item.scope === "cookies" && item.state === "applied")).toBe(false);
  expect(writes().map(request => request.params.cookie.name)).toEqual([COOKIE.name]); expect(jar()).toEqual([writes()[0].params.cookie]); unchanged(f); released(f);
});

it("a one-shot guard failure at legal reply delivery remains sticky after the ticket itself settles", async () => {
  const f = await begin(2, "delivery"), clock = f.clock!;
  try {
    expect(clock.guard).toBeTypeOf("function"); expect(clock.guardPollCalls).toBe(0); guardFaults = 1;
    await releaseHeld!(); const completed = await bounded(pending!);
    const replyIndex = events.indexOf(`reply:${writes()[0].id}`), faultIndex = events.indexOf("delivery-guard-rejected");
    const diagnostic = { guardPollCalls: clock.guardPollCalls, faults: events.filter(event => event === "delivery-guard-rejected").length,
      guardRecovered, replyBeforeFault: replyIndex >= 0 && faultIndex > replyIndex, recoveredAfterFault: events.indexOf("delivery-guard-recovered") > faultIndex,
      deliveryFinishObserved: guardFailureStack?.split("\n").some(line => line.includes("bidi-client") && /\bfinish\b/.test(line)) === true };
    console.info("[sync-bidi delivery-only]", JSON.stringify({ ...diagnostic, suppressedPolls: clock.suppressedPolls,
      wireWrites: writes().length, secondAtWire: writes().some(request => request.params.cookie.name === SECOND.name), jarRows: jar().length }));
    expect(diagnostic).toEqual({ guardPollCalls: 0, faults: 1, guardRecovered: true, replyBeforeFault: true, recoveredAfterFault: true, deliveryFinishObserved: true });
    expect(guardFaults).toBe(0);
    expect(writes().map(request => request.params.cookie.name), "DELIVERY_GUARD_REVIVED: reply settled the ticket, not the revoked importer").toEqual([COOKIE.name]);
    expect(completed.result).toMatchObject({ success: false, localCommit: "unknown", remoteCommit: "none" });
    expect(completed.result?.items?.some(item => item.scope === "cookies" && item.state === "applied")).toBe(false);
    expect(jar()).toEqual([writes()[0].params.cookie]); expect(cookieReplies).toBe(1); unchanged(f); released(f);
    expect((await conn!.send("storage.getCookies", { filter: { name: COOKIE.name } })).cookies).toEqual(jar());
    expect(conn!.closed).toBe(false); expect(getRegisteredFirefoxSession(h.port)).toBe(conn);
  } finally { await shutdown(); }
});

it("WS close, replaced/deleted/stopping runtime, killed bit and replacement exit are not the original writer's exit", async () => {
  const f = await begin(), original = runningProcesses.get(ID)!; controller!.abort();
  const closed = once(heldSocket, "close"); heldSocket.close(); await bounded(closed); await retained(f);
  const replacement = await ownedChild(false);
  runningProcesses.set(ID, { ...original, pid: replacement.pid!, process: replacement }); await retained(f);
  await exitChild(replacement); await retained(f);
  runningProcesses.delete(ID); await retained(f);
  original.stopping = true; runningProcesses.set(ID, original); await retained(f);
  Object.defineProperty(writer, "killed", { value: true }); // Model the request bit only; never send an OS signal.
  expect(writer.exitCode).toBeNull(); expect(writer.signalCode).toBeNull(); await retained(f);
  await releaseHeld!("none"); // The exact original child really writes AFTER its WS is gone.
  expect(jar()).toEqual([writes()[0].params.cookie]); expect(jar().find(cookie => cookie.name === COOKIE.name)?.value.value).toBe(COOKIE.value);
  expect(peerClosed).toBe(true); expect(cookieReplies).toBe(0); await retained(f);
  await exitChild(writer); const completed = await bounded(pending!);
  expect(completed.result).toMatchObject({ success: false, code: "SYNC_CANCELLED", localCommit: "unknown", remoteCommit: "none" }); unchanged(f); released(f);
});

it("uncancelled sync imports both cookies successfully and leaves the borrowed session usable", async () => {
  const f = await begin(); await releaseHeld!(); const completed = await bounded(pending!);
  expect(completed.error).toBeUndefined(); expect(completed.result).toMatchObject({ success: true, localCommit: "committed", remoteCommit: "none" });
  expect(completed.result?.items).toContainEqual(expect.objectContaining({ scope: "cookies", state: "applied", count: 2 }));
  expect(writes().map(request => request.params.cookie.name)).toEqual([COOKIE.name, SECOND.name]); expect(jar()).toEqual(writes().map(request => request.params.cookie));
  expect((await conn!.send("storage.getCookies", { filter: { name: SECOND.name } })).cookies).toEqual([jar()[1]]);
  expect(getRegisteredFirefoxSession(h.port)).toBe(conn); expect(conn!.closed).toBe(false); expect(calls.filter(request => request.method === "session.new")).toHaveLength(1);
  const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")); reloadConfig(); expect(getConfig()).toEqual(config); expect(config.browserProfiles[ID].name).toBe("remote-not-adopted");
  expect(fs.readFileSync(queueFile)).toEqual(f.queueBytes); expect(fs.readFileSync(remoteFile)).toEqual(f.remoteBytes); released(f);
});

it("direct non-sync import still rejects promptly on cancellation without closing its borrowed session", async () => {
  await prepare(); controller = new AbortController(); const arrived = once(wire, "held");
  const direct = runtimeCookieOps.importCookies(ID, [COOKIE, SECOND], controller.signal).then(() => undefined, error => error);
  await bounded(arrived); controller.abort(); expect(await bounded(direct)).toBeInstanceOf(Error);
  expect(jar()).toEqual([]); expect(syncService.getStatus().operation.active).toBeNull(); expect(isRestoreLocked(ID)).toBe(false);
  await releaseHeld!(); expect((await conn!.send("storage.getCookies", { filter: { name: COOKIE.name } })).cookies).toEqual(jar());
  expect(writes().map(request => request.params.cookie.name)).toEqual([COOKIE.name]); expect(conn!.closed).toBe(false); expect(getRegisteredFirefoxSession(h.port)).toBe(conn); expect(h.blocked).toEqual([]);
});
