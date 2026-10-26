// Opt-in, same-host native Cookie migration, NOT an installed Electron app,
// OS-vault, real S3 provider, real HTTPS login, or two-physical-Mac acceptance.
// The outer controller must create a fresh, empty owned child BEFORE invoking:
// ABS_S3_COOKIE_LOGIN_ACCEPTANCE=1
// ABS_S3_COOKIE_LOGIN_BUDGET_ROOT=<original owned aggregate evidence root>
// ABS_S3_COOKIE_LOGIN_ROOT=<fresh empty canonical child of that root>
// AGENT_BROWSER_CHROMIUM_BINARY_PATH=<explicit existing managed executable>
// ABS_S3_COOKIE_LOGIN_MODE=cookies (default) | full-storage (one selected test)
// No build/download/global-secret-backend/sandbox/TLS overrides are performed here.
import { describe, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { CookieInfo, SyncResult } from "../../src/main/types.js";
import { STORAGE_PATH, seedNativeStorage, readNativeStorage, inspectNativeStorageFiles, type StorageValues } from "./helpers/native-s3-storage.js";

// Explicit driver boundaries: Node Electron paths and an owned-child discovery
// adapter. Production discovery otherwise scans global ps output even for these
// fresh profiles; this lane must NOT observe unrelated processes/debug ports.
// Cookie services, ws, HTTP/fetch, SQLite and SyncService remain production code.
const shell = vi.hoisted(() => ({ root: "", device: "", home: "", temp: "",
  profiles: new Map<string, { dirId: string; owner: NativeOwner | null }>(), discoveryCalls: 0, discoveryDenied: 0 }));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath(name: string) {
      if (!shell.root || !shell.device) throw new Error("OWNED_NODE_PATHS_NOT_READY");
      if (name === "userData" || name === "appData") return shell.device;
      if (name === "home") return shell.home;
      if (name === "temp") return shell.temp;
      if (name === "logs" || name === "cache") return shell.device;
      throw new Error("OWNED_NODE_PATH_UNSUPPORTED");
    },
    getAppPath: () => shell.root,
    getVersion: () => "0.0.0-native-cookie-test",
    getName: () => "Agent Browser Studio",
    getLocale: () => "en-US",
    isReady: () => true,
  },
  BrowserWindow: { getAllWindows: () => [] },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1, workAreaSize: { width: 1280, height: 800 } }) },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../../src/main/services/process-discovery.js", async original => {
  const pure = await original<typeof import("../../src/main/services/process-discovery.js")>();
  const paths = await import("node:path");
  function lookup(dirId: string, profileDir: string) {
    shell.discoveryCalls++;
    const binding = shell.profiles.get(profileDir);
    if (!shell.root || typeof dirId !== "string" || typeof profileDir !== "string" || paths.resolve(profileDir) !== profileDir || !binding || binding.dirId !== dirId) {
      shell.discoveryDenied++; throw new Error("OWNED_DISCOVERY_UNKNOWN_PROFILE");
    }
    const native = binding.owner;
    // null means this driver has not launched a child for this fresh profile.
    // It is NOT an assertion about the real host's process table.
    if (!native) return null;
    if (native.exited) {
      if (native.closeRequested && native.exited.code === 0 && native.exited.signal === null) return null;
      shell.discoveryDenied++; throw new Error("OWNED_DISCOVERY_EXIT_UNCONFIRMED");
    }
    if (!native.verified || native.profile !== profileDir || native.child.pid !== native.pid ||
        native.child.exitCode !== null || native.child.signalCode !== null || native.child.killed || native.port < 1 || native.port > 65535) {
      shell.discoveryDenied++; throw new Error("OWNED_DISCOVERY_CHILD_UNVERIFIED");
    }
    return { pid: native.pid, cdpPort: native.port };
  }
  const unsupported = () => { shell.discoveryDenied++; throw new Error("OWNED_DISCOVERY_OPERATION_UNSUPPORTED"); };
  // Only named pure parsers are retained. No original collector is reachable as
  // a fallback, including future unexpected lifecycle/discovery operations.
  return {
    parseBrowserProcessLine: pure.parseBrowserProcessLine,
    normalizeBrowserProcessPath: pure.normalizeBrowserProcessPath,
    browserLaunchProcessFromArgv: pure.browserLaunchProcessFromArgv,
    parseBrowserLaunchProcessLine: pure.parseBrowserLaunchProcessLine,
    inspectBrowserLaunchLines: pure.inspectBrowserLaunchLines,
    findBrowserByProfileSync: lookup,
    findCdpPortSync: (dirId: string, profileDir: string) => lookup(dirId, profileDir)?.cdpPort ?? null,
    inspectBrowserLaunchesSync: unsupported,
    getRunningProcessesAsync: async () => unsupported(),
  };
});

const OPTED_IN = process.env.ABS_S3_COOKIE_LOGIN_ACCEPTANCE === "1";
const MODE = process.env.ABS_S3_COOKIE_LOGIN_MODE ?? "cookies";
const FULL_STORAGE = MODE === "full-storage";
const GIB = 1024 ** 3, MIB = 1024 ** 2;
const AGGREGATE_CAP = 2 * GIB, PHASE_CAP = 256 * MIB, MIN_FREE = 10 * GIB;
const OBJECT_CAP = MIB, FULL_OBJECT_CAP = 16 * MIB, ENTRY_CAP = 50_000, REQUEST_CAP = 256;
const HOST = "owned-login.invalid", ID = "ab_s3_cookie_login";
const BUCKET = "owned-cookie-login", CONFIG_KEY = "agent-browser-studio-config.json";
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
type Dict = Record<string, any>;
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_FILES = ["src/main/services/sync-service.ts", "src/main/services/cdp-cookie-service.ts", "src/main/services/bidi-cookie-service.ts",
  "src/main/services/cookie-partition.ts", "src/main/services/bidi-client.ts", "src/main/services/process-discovery.ts", "src/main/types.ts",
  "tests/e2e/s3-cookie-login-acceptance.test.ts", "tests/e2e/helpers/native-s3-storage.ts"];
function sourcePins(): Record<string, string> { return Object.fromEntries(SOURCE_FILES.map(file => [file, sha(fs.readFileSync(path.join(REPO, file)))])); }

function childPath(root: string, ...parts: string[]): string {
  const file = path.resolve(root, ...parts), relative = path.relative(root, file);
  ensure(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "OWNED_PATH_ESCAPE");
  return file;
}
function directory(input: string | undefined): string {
  ensure(input && path.isAbsolute(input), "OWNED_EXPLICIT_ROOT_REQUIRED");
  const stat = fs.lstatSync(input);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(input) === input && stat.uid === process.getuid?.(), "OWNED_ROOT_UNSAFE");
  return input;
}
function regularBytes(root: string, file: string, maximum = OBJECT_CAP): Buffer {
  childPath(root, path.relative(root, file));
  let parent = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    const stat = fs.lstatSync(parent);
    ensure(stat.isDirectory() && !stat.isSymbolicLink(), "OWNED_FILE_PARENT_UNSAFE");
  }
  const before = fs.lstatSync(file);
  ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum, "OWNED_FILE_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    ensure(opened.dev === before.dev && opened.ino === before.ino && after.ino === current.ino && after.dev === current.dev &&
      bytes.length === before.size && before.size === after.size && after.size === current.size &&
      before.mtimeMs === after.mtimeMs && after.mtimeMs === current.mtimeMs && before.ctimeMs === after.ctimeMs && after.ctimeMs === current.ctimeMs,
    "OWNED_FILE_CHANGED");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function writeFact(root: string, name: string, fact: unknown): void {
  const file = childPath(root, name), text = JSON.stringify(fact);
  ensure(Buffer.byteLength(text) <= 64 * 1024, "OWNED_FACT_BUDGET");
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ensure(regularBytes(root, file).equals(Buffer.from(text)), "OWNED_FACT_READBACK_FAILED");
}
function inventoryBytes(root: string): number {
  let bytes = 0, entries = 0;
  const visit = (at: string) => {
    for (const name of fs.readdirSync(at)) {
      ensure(++entries <= ENTRY_CAP, "OWNED_ENTRY_BUDGET");
      const file = path.join(at, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      bytes += stat.size; // Account for links themselves; never follow them.
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        try { visit(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  };
  visit(root); return bytes;
}
async function until(condition: () => boolean | Promise<boolean>, code: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  throw new Error(code);
}
async function bind(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  ensure(address && typeof address !== "string", "OWNED_LISTENER_UNAVAILABLE");
  return address.port;
}
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (result: Dict) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private socket: WebSocket, private current: () => boolean) {
    socket.on("error", () => this.rejectAll());
    socket.on("close", () => this.rejectAll());
    socket.on("message", data => {
      let response: Dict;
      try { response = JSON.parse(data.toString()); }
      catch { this.rejectAll(); return; }
      const request = this.pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(response.id);
      if (response.error || !response.result || typeof response.result !== "object") request.reject(new Error("OWNED_CDP_COMMAND_FAILED"));
      else request.resolve(response.result);
    });
  }
  private rejectAll(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("OWNED_CDP_DISCONNECTED")); }
    this.pending.clear();
  }
  static async connect(raw: string, port: number, current: () => boolean): Promise<Cdp> {
    const url = new URL(raw);
    ensure(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && Number(url.port) === port &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith("/devtools/") && current(), "OWNED_CDP_ENDPOINT_UNSAFE");
    const socket = new WebSocket(raw, { followRedirects: false, perMessageDeflate: false, maxPayload: OBJECT_CAP });
    const client = new Cdp(socket, current);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("OWNED_CDP_CONNECT_TIMEOUT")), 10_000);
        socket.once("open", () => { clearTimeout(timer); resolve(); });
        socket.once("error", () => { clearTimeout(timer); reject(new Error("OWNED_CDP_CONNECT_FAILED")); });
        socket.once("close", () => { clearTimeout(timer); reject(new Error("OWNED_CDP_CONNECT_CLOSED")); });
      });
      return client;
    } catch (error) { client.disconnect(); throw error; }
  }
  send(method: string, params: Dict = {}): Promise<Dict> {
    ensure(this.current() && this.socket.readyState === WebSocket.OPEN, "OWNED_CDP_OWNER_CHANGED");
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("OWNED_CDP_COMMAND_TIMEOUT")); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("OWNED_CDP_SEND_FAILED")); }
    });
  }
  disconnect(): void { this.rejectAll(); this.socket.terminate(); } // Own client socket only, NEVER a native kill.
}

interface CloseRpcFact {
  outcome: "not-requested" | "pending" | "acknowledged" | "disconnected" | "timeout" | "failed";
  requestedAt?: string; completedAt?: string; code?: string;
}
interface NativeOwner {
  child: ChildProcess; pid: number; port: number; profile: string; verified: boolean; closeRequested: boolean;
  browser?: Cdp; page?: Cdp; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited: { code: number | null; signal: NodeJS.Signals | null } | null;
  closeRpc: CloseRpcFact; closePromise?: Promise<void>; activePortWitness?: Buffer; activePortIdentity?: { dev: number; ino: number };
}
const alive = (owner: NativeOwner) => owner.child.pid === owner.pid && owner.child.exitCode === null && owner.child.signalCode === null && !owner.child.killed;
function requestNativeClose(owner: NativeOwner): Promise<void> {
  if (owner.closePromise) return owner.closePromise;
  const fact: CloseRpcFact = { outcome: "pending", requestedAt: new Date().toISOString() };
  owner.closeRpc = fact;
  owner.closePromise = (async () => {
    try {
      ensure(owner.verified && owner.browser && alive(owner), "OWNED_NATIVE_CLOSE_UNVERIFIED");
      owner.closeRequested = true;
      await owner.browser.send("Browser.close");
      fact.outcome = "acknowledged";
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      fact.outcome = code === "OWNED_CDP_DISCONNECTED" ? "disconnected" : code === "OWNED_CDP_COMMAND_TIMEOUT" ? "timeout" : "failed";
      fact.code = /^OWNED_(?:CDP|NATIVE_CLOSE)_[A-Z_]+$/.test(code) ? code : "OWNED_NATIVE_CLOSE_RPC_FAILED";
    } finally { fact.completedAt = new Date().toISOString(); }
  })();
  return owner.closePromise;
}
async function nativeJson(port: number, route: string): Promise<Dict> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000), redirect: "error" });
  ensure(response.ok, "OWNED_NATIVE_DISCOVERY_FAILED");
  const text = await response.text(); ensure(Buffer.byteLength(text) <= OBJECT_CAP, "OWNED_NATIVE_DISCOVERY_BUDGET");
  return JSON.parse(text);
}
async function navigate(owner: NativeOwner, url: string): Promise<void> {
  ensure(owner.verified && owner.page, "OWNED_NATIVE_NOT_VERIFIED");
  await owner.page.send("Page.navigate", { url });
  await until(async () => {
    const response = await owner.page!.send("Runtime.evaluate", { expression: "({url:location.href,ready:document.readyState})", returnByValue: true });
    return response.result?.value?.url === url && response.result?.value?.ready === "complete";
  }, "OWNED_NAVIGATION_TIMEOUT");
}
async function closeNative(owner: NativeOwner): Promise<void> {
  try {
    if (alive(owner)) {
      // A reply/disconnect/failure is recorded, never substituted for the HELD
      // CHILD's normal actual exit below. There is no signal fallback.
      await requestNativeClose(owner);
      ensure(owner.closeRequested, "OWNED_NATIVE_CLOSE_UNVERIFIED");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([owner.exit, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OWNED_NATIVE_EXIT_UNCONFIRMED")), 15_000);
      })]);
      ensure(owner.closeRequested && exit.code === 0 && exit.signal === null, "OWNED_NATIVE_EXIT_NOT_NORMAL");
    } finally { if (timer) clearTimeout(timer); }
  } finally {
    owner.page?.disconnect(); owner.browser?.disconnect();
    if (owner.closePromise) await owner.closePromise; // Retire/record an in-flight failure-triggered RPC too.
    if (alive(owner)) owner.child.unref(); // Retain failed native/profile; never force termination.
  }
}

function cookieIdentity(cookie: CookieInfo): string {
  return JSON.stringify([cookie.domain, cookie.name, cookie.path,
    cookie.partitionKey ? [cookie.partitionKey.topLevelSite, cookie.partitionKey.hasCrossSiteAncestor] : null]);
}
function sameCookies(actual: CookieInfo[], expected: CookieInfo[]): boolean {
  if (actual.length !== expected.length) return false;
  const rows = new Map(actual.map(cookie => [cookieIdentity(cookie), cookie]));
  return rows.size === expected.length && expected.every(cookie => {
    const row = rows.get(cookieIdentity(cookie));
    return row !== undefined && row.value === cookie.value && row.expires === cookie.expires && row.secure === cookie.secure &&
      row.httpOnly === cookie.httpOnly && row.sameSite === cookie.sameSite;
  });
}
function syncFact(result: SyncResult) {
  const code = (result as { code?: unknown }).code;
  return { success: result.success, outcome: result.outcome, localCommit: result.localCommit, remoteCommit: result.remoteCommit,
    ...(FULL_STORAGE ? { code: typeof code === "string" && /^[A-Z_]{1,128}$/.test(code) ? code : null,
      items: result.items?.map(item => ({ scope: item.scope, state: item.state,
        code: typeof item.code === "string" && /^[A-Z_]{1,128}$/.test(item.code) ? item.code : null, count: item.count, bytes: item.bytes })) } : {}) };
}

// Query only this test's cold databases, then reopen and search again. Native
// writes the ciphertext; the production public mock-keychain codec independently
// reads it. No fixture generates, replaces or repairs SQLite credential rows.
async function inspectCold(root: string, owner: NativeOwner, expected: CookieInfo[]) {
  ensure(owner.exited?.code === 0 && owner.exited.signal === null && !alive(owner), "OWNED_SQL_REQUIRES_ACTUAL_EXIT");
  const paths = ["Network/Cookies", "Cookies"].map(name => childPath(owner.profile, "Default", name));
  const file = paths.find(candidate => fs.existsSync(candidate)); ensure(file, "OWNED_NATIVE_COOKIE_DB_MISSING");
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(file + suffix)) regularBytes(root, file + suffix, 64 * MIB);
  const codec = await import("../../src/main/services/sync/profile-credentials.js");
  const adapter = codec.createBasicChromiumAdapter(codec.identityForManagedProfile("chromium", "darwin", ID));
  const persistent = expected.filter(cookie => cookie.expires !== null), known = new Map(persistent.map(cookie => [cookieIdentity(cookie), cookie]));
  const sourceHash = sha(regularBytes(root, file, 64 * MIB));
  try {
    for (let reload = 0; reload < 2; reload++) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        ensure(db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check === "ok", "OWNED_NATIVE_SQL_INTEGRITY");
        const version = Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value);
        ensure(Number.isInteger(version) && version >= 23, "OWNED_NATIVE_SQL_VERSION");
        const rows = db.prepare("SELECT rowid AS rid,host_key,name,path,value,encrypted_value,top_frame_site_key,has_cross_site_ancestor,is_persistent,has_expires FROM cookies WHERE host_key IN (?,?) AND is_persistent=1 LIMIT 32").all(HOST, "." + HOST);
        ensure(rows.length === persistent.length, "OWNED_NATIVE_SQL_PERSISTENT_COUNT");
        for (const row of rows) {
          const partitionKey = row.top_frame_site_key ? { topLevelSite: String(row.top_frame_site_key), hasCrossSiteAncestor: row.has_cross_site_ancestor === 1 } : undefined;
          const key = cookieIdentity({ domain: String(row.host_key), name: String(row.name), path: String(row.path), partitionKey } as CookieInfo);
          const wanted = known.get(key);
          ensure(wanted && row.value === "" && row.is_persistent === 1 && row.has_expires === 1 && row.encrypted_value instanceof Uint8Array, "OWNED_NATIVE_SQL_COOKIE_FIELDS");
          const encrypted = Buffer.from(row.encrypted_value);
          ensure(encrypted.subarray(0, 3).toString("ascii") === "v10", "OWNED_NATIVE_SQL_BACKEND_MISMATCH");
          const clear = await adapter.decrypt(encrypted, { identity: adapter.identity, relativePath: "Default/Network/Cookies", table: "cookies", column: "encrypted_value", rowId: String(row.rid), databaseVersion: version, cookieHost: String(row.host_key) });
          try {
            const hostBytes = version >= 24 ? 32 : 0;
            ensure(!hostBytes || clear.subarray(0, 32).equals(createHash("sha256").update(String(row.host_key)).digest()), "OWNED_NATIVE_SQL_HOST_BINDING");
            ensure(clear.subarray(hostBytes).equals(Buffer.from(wanted.value)), "OWNED_NATIVE_SQL_VALUE_MISMATCH");
          } finally { clear.fill(0); }
        }
      } finally { db.close(); }
    }
    ensure(sha(regularBytes(root, file, 64 * MIB)) === sourceHash, "OWNED_NATIVE_SQL_READ_CHANGED_DB");
    return { persistentRows: persistent.length, reopenAndSearch: true, hostBindingAndValuesMatch: true, backend: "normal-managed-mac-v10" };
  } finally { adapter.dispose?.(); }
}

function cookieCoverage(observed: Array<{ identity: string; session: boolean }>, expected: CookieInfo[]) {
  const ids = new Set(observed.map(cookie => cookie.identity)), missing = expected.filter(cookie => !ids.has(cookieIdentity(cookie)));
  return { expected: expected.length, observed: observed.length, expectedSession: expected.filter(cookie => cookie.expires === null).length,
    observedSession: observed.filter(cookie => cookie.session).length, observedPersistent: observed.filter(cookie => !cookie.session).length,
    missing: missing.length, missingSession: missing.filter(cookie => cookie.expires === null).length,
    missingPersistent: missing.filter(cookie => cookie.expires !== null).length, missingPartitioned: missing.filter(cookie => cookie.partitionKey).length };
}
function coldCookieCoverage(root: string, profile: string, expected: CookieInfo[], quiescent: () => boolean) {
  ensure(quiescent(), "OWNED_COOKIE_COVERAGE_REQUIRES_QUIESCENT_PROFILE");
  const file = ["Network/Cookies", "Cookies"].map(name => childPath(profile, "Default", name)).find(candidate => fs.existsSync(candidate));
  ensure(file, "OWNED_NATIVE_COOKIE_DB_MISSING"); const before = sha(regularBytes(root, file, 64 * MIB));
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT host_key,name,path,top_frame_site_key,has_cross_site_ancestor,is_persistent FROM cookies WHERE host_key IN (?,?) LIMIT 32").all(HOST, "." + HOST);
    return cookieCoverage(rows.map(row => ({ identity: JSON.stringify([String(row.host_key), String(row.name), String(row.path),
      row.top_frame_site_key ? [String(row.top_frame_site_key), row.has_cross_site_ancestor === 1] : null]), session: row.is_persistent !== 1 })), expected);
  } finally { db.close(); ensure(quiescent() && sha(regularBytes(root, file, 64 * MIB)) === before, "OWNED_COOKIE_COVERAGE_READ_CHANGED_DB"); }
}

async function fixtures(root: string, httpValues: Map<string, string>, guard: () => void) {
  const failures: string[] = [], journal: Array<{ method: string; key: string; bytes: number; sha256: string }> = [];
  const sockets = new Set<net.Socket>(), denied = new WeakSet<net.Socket>(), servers: http.Server[] = [];
  const objects = childPath(root, "s3-objects"); fs.mkdirSync(objects, { mode: 0o700 });
  const objectSizes = new Map<string, number>(); let storedObjectBytes = 0;
  let requests = 0, seedEnabled = true, seedResponses = 0, deniedRequests = 0, deniedResetErrors = 0;
  let receiver = false, receiverSeedAttempts = 0;
  let firstReceiverProbe: null | { allHttpCookiesMatch: boolean; secureCookieAbsent: boolean; httpStatus: number } = null;
  let lastReceiverProbe: null | { allHttpCookiesMatch: boolean; secureCookieAbsent: boolean; httpStatus: number } = null, receiverProbeCount = 0;
  let lastSourceProbe: null | { allHttpCookiesMatch: boolean; secureCookieAbsent: boolean; httpStatus: number } = null;
  const fail = (code: string) => { if (failures.length < 32) failures.push(code); };
  async function closeServers(): Promise<void> {
    for (const server of servers) server.closeAllConnections();
    for (const socket of sockets) socket.destroy(); // Own fixture transports, never processes.
    await Promise.all(servers.map(server => !server.listening ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { server.unref(); reject(new Error("OWNED_FIXTURE_CLOSE_TIMEOUT")); }, 5000);
      server.close(error => { clearTimeout(timer); if (error) reject(new Error("OWNED_FIXTURE_CLOSE_FAILED")); else resolve(); });
    })));
  }
  const observe = (server: http.Server) => {
    servers.push(server);
    server.on("connection", socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (denied.has(socket) && ["ECONNRESET", "EPIPE"].includes(error.code || "")) deniedResetErrors++;
        else fail("OWNED_FIXTURE_SOCKET_FAILED");
      });
    });
    server.on("error", () => fail("OWNED_FIXTURE_SERVER_FAILED"));
  };
  try {
  const site = http.createServer((req, res) => {
    try {
      guard(); ensure(++requests <= REQUEST_CAP, "OWNED_REQUEST_BUDGET");
      const target = new URL(req.url || "/", "http://" + HOST);
      const cookieOrigin = req.headers.host === `${HOST}:${sitePort}`;
      const storageOrigin = FULL_STORAGE && req.headers.host === `localhost:${sitePort}`;
      ensure(req.method === "GET" && (cookieOrigin || storageOrigin), "OWNED_SITE_REQUEST_INVALID");
      if (storageOrigin) {
        ensure(!target.search, "OWNED_STORAGE_URL_INVALID");
        if (target.pathname === STORAGE_PATH + "page") {
          res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
          res.end("<!doctype html><title>Owned read-only storage page</title><h1>Owned storage fixture</h1>"); return;
        }
        if (target.pathname === STORAGE_PATH + "sw.js") {
          res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store", "service-worker-allowed": STORAGE_PATH });
          res.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"); return;
        }
        res.writeHead(404); res.end(); return;
      }
      let status = 200;
      if (target.pathname === "/seed") {
        if (!seedEnabled) { if (receiver) receiverSeedAttempts++; res.writeHead(403); res.end("Seed disabled"); return; }
        seedResponses++;
        ensure(seedResponses === 1, "OWNED_SEED_REPEATED");
        res.setHeader("set-cookie", [...httpValues].map(([name, value]) => `${name}=${value}; Path=/; HttpOnly${name === "owned_domain" ? "; Domain=" + HOST : ""}${name === "owned_session" ? "" : "; Max-Age=86400"}${name === "owned_unspecified" ? "" : "; SameSite=Lax"}`));
      } else if (target.pathname === "/probe") {
        const header = typeof req.headers.cookie === "string" ? req.headers.cookie.split(";").map(part => part.trim()) : [];
        const matched = [...httpValues].every(([name, value]) => header.includes(`${name}=${value}`));
        status = matched ? 200 : 401;
        const fact = { allHttpCookiesMatch: matched, httpStatus: status,
          secureCookieAbsent: !header.some(part => part.startsWith("__Host-owned_secure=")) };
        if (receiver) { firstReceiverProbe ??= fact; lastReceiverProbe = fact; receiverProbeCount++; } else lastSourceProbe = fact;
      } else if (target.pathname !== "/favicon.ico") { res.writeHead(404); res.end(); return; }
      // probe and every non-seed response NEVER set or repair a Cookie.
      res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" }); res.end(status === 200 ? "Owned authenticated Cookie fixture" : "Owned authentication required");
    } catch { fail("OWNED_SITE_FAILED"); if (!res.headersSent) res.writeHead(500); res.end("Owned fixture failed"); }
  });
  observe(site);
  const sitePort = await bind(site), siteOrigin = `http://${HOST}:${sitePort}`;
  const proxy = http.createServer((req, res) => {
    let target: URL;
    try { guard(); ensure(++requests <= REQUEST_CAP, "OWNED_REQUEST_BUDGET"); target = new URL(req.url || ""); }
    catch { fail("OWNED_PROXY_REQUEST_INVALID"); res.writeHead(403); res.end(); return; }
    const ownedStorage = FULL_STORAGE && target.hostname === "localhost" && !target.search && !target.hash &&
      [STORAGE_PATH + "page", STORAGE_PATH + "sw.js", "/favicon.ico"].includes(target.pathname);
    if (target.protocol !== "http:" || (target.hostname !== HOST && !ownedStorage) || target.port !== String(sitePort) || target.username || target.password || req.method !== "GET") {
      denied.add(req.socket); deniedRequests++; res.writeHead(403); res.end("External requests denied"); return;
    }
    const forwarded = http.request({ host: "127.0.0.1", port: sitePort, method: "GET", path: target.pathname + target.search,
      headers: { ...req.headers, host: `${target.hostname}:${sitePort}` } }, reply => { res.writeHead(reply.statusCode || 500, reply.headers); reply.pipe(res); });
    forwarded.on("error", () => { fail("OWNED_PROXY_FORWARD_FAILED"); if (!res.headersSent) res.writeHead(502); res.end(); });
    forwarded.end();
  });
  observe(proxy);
  proxy.on("connect", (_req, socket) => { denied.add(socket as net.Socket); deniedRequests++; socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  const proxyPort = await bind(proxy);
  const s3 = http.createServer((req, res) => { void (async () => {
    guard(); ensure(++requests <= REQUEST_CAP, "OWNED_REQUEST_BUDGET");
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const prefix = `/${BUCKET}/`, key = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : "";
    const fullObject = /^full-profile-v1-[a-f0-9]{64}\.bin$/.test(key);
    ensure((FULL_STORAGE ? key === CONFIG_KEY || key === "cloak-lite-config.json" && req.method === "GET" || fullObject : /^[A-Za-z0-9_.-]{1,180}$/.test(key)) &&
      url.pathname === prefix + key && !url.search, "OWNED_S3_KEY_INVALID");
    const maximum = FULL_STORAGE && fullObject ? FULL_OBJECT_CAP : OBJECT_CAP, file = childPath(objects, key);
    if (req.method === "PUT") {
      const temporary = file + "." + randomUUID() + ".tmp", fd = fs.openSync(temporary, "wx", 0o600);
      let count = 0; const hash = createHash("sha256");
      try { for await (const chunk of req) { guard(); count += chunk.length;
        ensure(count <= maximum && storedObjectBytes + count <= PHASE_CAP - OBJECT_CAP, "OWNED_S3_OBJECT_BUDGET");
        hash.update(chunk); fs.writeFileSync(fd, chunk); } fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      const digest = hash.digest("hex"); ensure(sha(regularBytes(root, temporary, maximum)) === digest, "OWNED_S3_DIRECT_WRITE_READBACK");
      if (fullObject && FULL_STORAGE) ensure(key === "full-profile-v1-" + digest + ".bin", "OWNED_S3_CONTENT_KEY_MISMATCH");
      guard(); fs.renameSync(temporary, file);
      ensure(sha(regularBytes(root, file, maximum)) === digest, "OWNED_S3_PUBLISHED_READBACK");
      storedObjectBytes += count - (objectSizes.get(key) ?? 0); objectSizes.set(key, count);
      journal.push({ method: "PUT", key, bytes: count, sha256: digest }); res.writeHead(200, { etag: `"${digest}"` }); res.end(); return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (!fs.existsSync(file)) { res.writeHead(404); res.end("NoSuchKey"); return; }
      const bytes = regularBytes(root, file, maximum); journal.push({ method: req.method, key, bytes: bytes.length, sha256: sha(bytes) });
      res.writeHead(200, { "content-length": String(bytes.length), etag: `"${sha(bytes)}"` }); res.end(req.method === "HEAD" ? undefined : bytes); return;
    }
    res.writeHead(405); res.end();
  })().catch(() => { fail("OWNED_S3_REQUEST_FAILED"); if (!res.headersSent) res.writeHead(500); res.end("Owned S3 fixture failed"); }); });
  observe(s3);
  const s3Port = await bind(s3), endpoint = `http://127.0.0.1:${s3Port}`;
  return {
    siteOrigin, storageOrigin: `http://localhost:${sitePort}`, proxyPort, endpoint, objects, journal, failures,
    sourceProbe: () => lastSourceProbe,
    disableSeed() { seedEnabled = false; },
    beginReceiver() { ensure(!seedEnabled, "OWNED_RECEIVER_SEED_STILL_ENABLED"); receiver = true; },
    receiverProbe: () => firstReceiverProbe,
    latestReceiverProbe: () => lastReceiverProbe,
    receiverProbeCount: () => receiverProbeCount,
    fact: () => ({ seedResponses, receiverSeedAttempts, deniedRequests, deniedResetErrors, requestCount: requests, failures: failures.slice() }),
    close: closeServers,
  };
  } catch {
    try { await closeServers(); }
    catch { throw new Error("OWNED_FIXTURE_STARTUP_CLEANUP_FAILED"); }
    throw new Error("OWNED_FIXTURE_STARTUP_FAILED");
  }
}

describe.skipIf(!OPTED_IN).sequential("same-host native S3 Cookie login acceptance", () => {
  it(FULL_STORAGE ? "migrates browser-created Cookie and persistent storage through full sync and two cold receiver launches" :
    "migrates browser-created Cookie identity through production finite sync and a first read-only receiver request", async () => {
    ensure(MODE === "cookies" || MODE === "full-storage", "OWNED_ACCEPTANCE_MODE_INVALID");
    ensure(process.platform === "darwin", "OWNED_ACCEPTANCE_REQUIRES_MACOS");
    ensure(!process.env.AGENT_BROWSER_SECRET_BACKEND && process.env.AGENT_BROWSER_E2E_UNSANDBOXED !== "1", "OWNED_POLICY_OVERRIDE_PRESENT");
    const aggregate = directory(process.env.ABS_S3_COOKIE_LOGIN_BUDGET_ROOT), root = directory(process.env.ABS_S3_COOKIE_LOGIN_ROOT);
    childPath(aggregate, path.relative(aggregate, root));
    ensure(fs.readdirSync(root).length === 0, "OWNED_ROOT_MUST_BE_FRESH");
    const owner = fs.lstatSync(root), aggregateOwner = fs.lstatSync(aggregate);
    ensure(owner.dev === aggregateOwner.dev, "OWNED_ROOT_VOLUME_MISMATCH");
    const binaryInput = process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH;
    ensure(binaryInput && path.isAbsolute(binaryInput), "OWNED_EXPLICIT_NATIVE_REQUIRED");
    const binary = fs.realpathSync(binaryInput); ensure(fs.statSync(binary).isFile(), "OWNED_NATIVE_NOT_A_FILE"); fs.accessSync(binary, fs.constants.X_OK);
    let budgetFailure = false, timeFailure = false, administrativeReceiptAllowed = false;
    const GLOBAL_SCAN_MS = 10_000, PHASE_SCAN_MS = 250, ADMIN_CAP = 64 * 1024;
    type GlobalMeasurement = { startedAtMs: number; completedAtMs: number; aggregateBytes: number; phaseBeforeBytes: number; phaseAfterBytes: number;
      reason: "initial" | "checkpoint" | "cadence" };
    const measurements = { global: [] as GlobalMeasurement[], phaseScans: 0, identityChecks: 0, freeChecks: 0 };
    let globalSample: GlobalMeasurement | null = null, phaseSample: { bytes: number; atMs: number } | null = null;
    let positivePhaseGrowth = 0, phaseRootMtime = -1;
    const identities = () => {
      measurements.identityChecks++;
      const current = fs.lstatSync(root), currentAggregate = fs.lstatSync(aggregate);
      ensure(current.isDirectory() && currentAggregate.isDirectory() && current.dev === owner.dev && current.ino === owner.ino && current.uid === owner.uid &&
        currentAggregate.dev === aggregateOwner.dev && currentAggregate.ino === aggregateOwner.ino && currentAggregate.uid === aggregateOwner.uid &&
        !current.isSymbolicLink() && !currentAggregate.isSymbolicLink(), "OWNED_BUDGET_ROOT_CHANGED");
      return current;
    };
    type BudgetRequest = { forceGlobal?: boolean; forcePhase?: boolean; administrativeBytes?: number };
    const guard = (request: BudgetRequest = {}) => {
      const administrative = request.administrativeBytes !== undefined;
      if (administrative) {
        // Only finally may spend part of the pre-existing 1MiB reserve on a
        // FAILED <=64KiB administrative receipt, never on work/profile repair.
        ensure(administrativeReceiptAllowed && Number.isInteger(request.administrativeBytes) &&
          request.administrativeBytes! >= 0 && request.administrativeBytes! <= ADMIN_CAP, "OWNED_ADMINISTRATIVE_RECEIPT_NOT_ALLOWED");
      } else {
        ensure(!budgetFailure, "OWNED_STORAGE_GUARD_PREVIOUSLY_FAILED");
        ensure(!timeFailure, "OWNED_STAGE_TIME_BUDGET_EXCEEDED");
        // The outer aggregate supervisor can request normal cleanup without
        // signalling a native process or reading any unrelated application.
        identities();
        ensure(!fs.lstatSync(childPath(root, "outer-abort.json"), { throwIfNoEntry: false }), "OWNED_OUTER_ABORT_REQUESTED");
      }
      const current = identities(), now = Date.now();
      if (!globalSample || request.forceGlobal || now - globalSample.completedAtMs >= GLOBAL_SCAN_MS) {
        const reason = !globalSample ? "initial" : request.forceGlobal ? "checkpoint" : "cadence";
        const startedAtMs = Date.now(), before = inventoryBytes(root);
        const aggregateBytes = inventoryBytes(aggregate), after = inventoryBytes(root), completedAtMs = Date.now();
        measurements.phaseScans += 2;
        globalSample = { startedAtMs, completedAtMs, aggregateBytes, phaseBeforeBytes: before, phaseAfterBytes: after, reason };
        measurements.global.push(globalSample);
        // Do not lose phase growth while the non-atomic global walk was busy.
        positivePhaseGrowth = Math.max(0, after - before);
        phaseSample = { bytes: after, atMs: completedAtMs }; phaseRootMtime = identities().mtimeMs;
      } else if (!phaseSample || request.forcePhase || administrative || now - phaseSample.atMs >= PHASE_SCAN_MS || current.mtimeMs !== phaseRootMtime) {
        const bytes = inventoryBytes(root); measurements.phaseScans++;
        positivePhaseGrowth += Math.max(0, bytes - (phaseSample?.bytes ?? bytes)); // Never credit deletions.
        phaseSample = { bytes, atMs: Date.now() }; phaseRootMtime = identities().mtimeMs;
      }
      ensure(globalSample && phaseSample, "OWNED_BUDGET_MEASUREMENT_MISSING");
      const aggregateUpperBoundBytes = globalSample.aggregateBytes + positivePhaseGrowth, phaseBytes = phaseSample.bytes;
      const space = fs.statfsSync(root, { bigint: true }), free = space.bavail * space.bsize;
      measurements.freeChecks++; identities();
      // Data plus 64KiB metadata headroom still fits INSIDE the old 1MiB reserve.
      // Hard caps and the 10GiB free-space floor never change in failure mode.
      const reserveBytes = administrative ? request.administrativeBytes! + ADMIN_CAP : OBJECT_CAP;
      ensure(aggregateUpperBoundBytes + reserveBytes <= AGGREGATE_CAP && phaseBytes + reserveBytes <= PHASE_CAP &&
        free >= BigInt(MIN_FREE + reserveBytes), "OWNED_STORAGE_BUDGET_EXCEEDED");
      return { aggregateBytes: globalSample.aggregateBytes, aggregateUpperBoundBytes, observedPositivePhaseGrowthBytes: positivePhaseGrowth,
        globalStartedAtMs: globalSample.startedAtMs, globalCompletedAtMs: globalSample.completedAtMs, phaseBytes, phaseObservedAtMs: phaseSample.atMs,
        freeBytes: free.toString(), freeObservedAtMs: Date.now(), aggregateCap: AGGREGATE_CAP, phaseCap: PHASE_CAP, minimumFree: MIN_FREE,
        reserveBytes, administrativeOnly: administrative, globalScanCadenceMs: GLOBAL_SCAN_MS, phaseScanCadenceMs: PHASE_SCAN_MS,
        measurement: "last global + observed cumulative positive phase growth; other-writer growth needs outer supervision; not an atomic quota" };
    };
    const initialBudget = guard({ forceGlobal: true }), pinsBefore = sourcePins();
    ensure(BigInt(initialBudget.freeBytes) >= BigInt(MIN_FREE + PHASE_CAP), "OWNED_PHASE_RESERVE_UNAVAILABLE");
    const httpValues = new Map(["owned_session", "owned_persistent", "owned_unspecified", "owned_domain"].map(name => [name, randomBytes(18).toString("base64url")]));
    const extraValues = Array.from({ length: 6 }, () => randomBytes(18).toString("base64url"));
    const storageValues: StorageValues = { local: randomBytes(18).toString("base64url"), indexed: randomBytes(18).toString("base64url"), cached: randomBytes(18).toString("base64url") };
    const migrationPhrase = "owned-full-" + randomBytes(24).toString("base64url");
    const allValues = [...httpValues.values(), ...extraValues, ...Object.values(storageValues), migrationPhrase];
    const receipt: Dict = { schema: FULL_STORAGE ? "same-host-native-s3-full-storage/v1" : "same-host-native-s3-cookie-login/v1", mode: MODE,
      status: "running", phase: "paths", startedAt: new Date().toISOString(),
      limitations: [FULL_STORAGE ? "Node Electron path shim and separate toy file vaults, not actual Electron app or OS-vault verification" :
        "Node Electron path shim with existing test passthrough secret storage, not actual Electron app or OS-vault verification", "two fresh native profiles on one host, not two physical Macs",
        "explicit held-child discovery adapter: no global ps/lsof or unknown debugging endpoints; not product discovery/launch/stop acceptance",
        FULL_STORAGE ? "SessionStorage original-tab restoration is NOT covered; no empty fresh-tab value is classified as lost state" : "finite v3 logical Cookie migration, not v4 cold-profile/session restart acceptance",
        "HTTPS __Host/partition cases use real CDP Cookie storage only, not HTTPS website acceptance"],
      sourcePins: { before: pinsBefore }, budget: { initial: initialBudget }, native: [], cleanup: [] };
    let fixture: Awaited<ReturnType<typeof fixtures>> | undefined;
    const natives: NativeOwner[] = [], operationAbort = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined, failure = false;
    const requestFailureClose = (reason: "budget" | "deadline") => {
      operationAbort.abort();
      for (const native of natives) if (native.verified && native.browser && alive(native) && !native.closeRequested) {
        receipt.cleanup.push({ pid: native.pid, failureCloseRequested: reason });
        void requestNativeClose(native); // All static RPC outcomes are retained; exit remains separate.
      }
    };
    try {
      shell.root = root; shell.home = childPath(root, "controller-home"); shell.temp = childPath(root, "controller-temp");
      fs.mkdirSync(shell.home, { mode: 0o700 }); fs.mkdirSync(shell.temp, { mode: 0o700 });
      for (const [key, value] of Object.entries({ HOME: shell.home, TMPDIR: shell.temp, TMP: shell.temp, TEMP: shell.temp,
        XDG_CONFIG_HOME: shell.home, XDG_CACHE_HOME: shell.home })) vi.stubEnv(key, value);
      // Reserve cleanup time before the 240s test watchdog. These
      // latches only abort work/request normal close; they never kill a child.
      deadline = setTimeout(() => { timeFailure = true; requestFailureClose("deadline"); }, 120_000);
      timer = setInterval(() => {
        if (budgetFailure || timeFailure) return;
        try { guard(); }
        catch { budgetFailure = true; requestFailureClose("budget"); }
      }, 1000);
      fixture = await fixtures(root, httpValues, guard);
      let previousSecrets: typeof import("../../src/main/services/secrets.js") | undefined;
      async function device(label: "source" | "receiver") {
        guard(); shell.device = childPath(root, label, "user-data"); fs.mkdirSync(shell.device, { recursive: true, mode: 0o700 });
        shell.profiles.set(childPath(shell.device, "profiles", ID), { dirId: ID, owner: null });
        if (FULL_STORAGE) previousSecrets?.resetSecretStorageForTests();
        vi.resetModules();
        const config = await import("../../src/main/services/config-manager.js");
        const sync = await import("../../src/main/services/sync-service.js");
        const cookies = await import("../../src/main/services/cdp-cookie-service.js");
        const table = await import("../../src/main/services/browser/runtime-table.js");
        const secrets = await import("../../src/main/services/secrets.js");
        if (FULL_STORAGE) {
          const plan = secrets.planSecretStorage({ userDataDir: shell.device, platform: "darwin", trustedMacSignature: false, environment: {} });
          secrets.initializeSecretStorage(plan); previousSecrets = secrets;
          ensure(secrets.getSecretStorageBackend() === "file", "OWNED_TOY_FILE_VAULT_REQUIRED");
        } else ensure(secrets.getSecretStorageBackend() === "passthrough", "OWNED_NODE_SHELL_NOT_VAULT_PROOF");
        config.reloadConfig();
        const cfg = structuredClone(config.getConfig()); cfg.deviceId = "owned-cookie-" + label; cfg.deviceName = "Synthetic native Cookie " + label; cfg.browserProfiles = {}; cfg.proxies = {}; cfg.accounts = []; cfg.extensionRepository = {}; cfg.team = undefined;
        config.saveConfig(cfg);
        config.setSyncConfig({ enabled: true, endpoint: fixture!.endpoint, bucket: BUCKET, accessKey: randomBytes(12).toString("hex"), secretKey: randomBytes(20).toString("hex"), custodyConsent: true,
          ...(FULL_STORAGE ? { fullProfileConsent: true, fullProfilePassphrase: migrationPhrase, includeFullProfile: true } : { includeHistory: false, includeFullProfile: false }) });
        ensure(config.getConfigPath() === childPath(shell.device, "config.json"), "OWNED_CONFIG_PATH_MISMATCH");
        return { config, sync: sync.syncService, cookies, table, device: shell.device };
      }
      async function launch(current: Awaited<ReturnType<typeof device>>, label: string): Promise<NativeOwner> {
        guard();
        const profile = childPath(current.config.getProfilesDir(), ID); fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
        const nativeHome = childPath(root, label, "native-home"), nativeTemp = childPath(root, label, "native-temp");
        fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 }); fs.mkdirSync(nativeTemp, { recursive: true, mode: 0o700 });
        const { buildBaseChromiumArgs } = await import("../../src/main/services/browser/chromium-args-factory.js");
        const activePort = childPath(profile, "DevToolsActivePort"), binding = shell.profiles.get(profile);
        let previousPortWitness: Buffer | undefined;
        if (FULL_STORAGE && binding?.owner) {
          const previous = binding.owner;
          ensure(previous.verified && previous.closeRequested && previous.exited?.code === 0 && previous.exited.signal === null && !alive(previous), "OWNED_RESTART_PREVIOUS_EXIT_UNCONFIRMED");
          const stale = fs.lstatSync(activePort, { throwIfNoEntry: false });
          if (stale) {
            ensure(previous.activePortWitness && previous.activePortIdentity && stale.dev === previous.activePortIdentity.dev && stale.ino === previous.activePortIdentity.ino &&
              regularBytes(root, activePort, 4096).equals(previous.activePortWitness), "OWNED_RESTART_DEVTOOLS_REPLACED");
            previousPortWitness = previous.activePortWitness; // Retain it; wait for this new child to publish different bytes.
          }
          binding.owner = null;
        }
        ensure(!fs.existsSync(activePort) || previousPortWitness, "OWNED_STALE_DEVTOOLS_FILE");
        const args = [...buildBaseChromiumArgs({ profileDir: profile, seed: 730147, platform: "macos", cdpPort: 0, fingerprintMode: "managed", headless: true,
          nativeChromiumVersion: null, supportsFingerprintConfig: false, supportsGoogleApiKeyInfoBar: false }),
          "--profile-directory=Default", "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability",
          `--proxy-server=http://127.0.0.1:${fixture!.proxyPort}`, "--proxy-bypass-list=<-loopback>", "about:blank"];
        ensure(args.includes("--use-mock-keychain") && args.includes("--password-store=basic") &&
          !args.some(arg => /^--(?:no-sandbox|disable-gpu-sandbox|ignore-certificate-errors|disable-web-security)(?:=|$)/.test(arg)), "OWNED_NATIVE_POLICY_CHANGED");
        const child = spawn(binary, args, { cwd: root, stdio: "ignore", env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: nativeHome,
          TMPDIR: nativeTemp, TMP: nativeTemp, TEMP: nativeTemp, XDG_CONFIG_HOME: nativeHome, XDG_CACHE_HOME: nativeHome, LANG: "en_US.UTF-8" } });
        let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { resolveExit = resolve; });
        const native: NativeOwner = { child, pid: child.pid || 0, port: 0, profile, verified: false, closeRequested: false, exit, exited: null,
          closeRpc: { outcome: "not-requested" } };
        natives.push(native);
        ensure(binding && binding.owner === null, "OWNED_NATIVE_PROFILE_NOT_FRESH"); binding.owner = native;
        child.once("exit", (code, signal) => { native.exited = { code, signal }; resolveExit(native.exited); });
        child.once("error", () => { native.exited = { code: -1, signal: null }; resolveExit(native.exited); });
        ensure(native.pid > 0, "OWNED_NATIVE_SPAWN_FAILED");
        // Persist only this driver's real spawn witness immediately, so a failed
        // cleanup never requires discovering an unrecorded process globally.
        writeFact(root, label + "-native-owner.json", { schema: "owned-native-child/v1", pid: native.pid, profile,
          verifiedCdpBinding: false, cleanup: "normal Browser.close only; otherwise retain and fail" });
        let version: Dict | undefined;
        await until(async () => {
          guard(); ensure(alive(native), "OWNED_NATIVE_EXITED_BEFORE_READY");
          if (!fs.existsSync(activePort)) return false;
          const activeBytes = regularBytes(root, activePort, 4096);
          if (previousPortWitness?.equals(activeBytes)) return false; // Never probe the exited child's old port.
          const lines = activeBytes.toString("utf8").trimEnd().split("\n");
          if (lines.length < 2) return false; // A not-yet-complete owned native write.
          ensure(/^[1-9][0-9]{0,4}$/.test(lines[0]) && Number(lines[0]) <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1]), "OWNED_DEVTOOLS_FILE_INVALID");
          native.port = Number(lines[0]);
          try { version = await nativeJson(native.port, "/json/version"); } catch { return false; }
          ensure(new URL(version.webSocketDebuggerUrl).pathname === lines[1], "OWNED_DEVTOOLS_BROWSER_PATH_MISMATCH");
          return true;
        }, "OWNED_NATIVE_READY_TIMEOUT");
        const port = native.port;
        native.browser = await Cdp.connect(version!.webSocketDebuggerUrl, port, () => alive(native));
        const info = await native.browser.send("SystemInfo.getProcessInfo");
        ensure(Array.isArray(info.processInfo) && info.processInfo.filter((entry: Dict) => entry.type === "browser").length === 1 &&
          info.processInfo.find((entry: Dict) => entry.type === "browser")?.id === native.pid, "OWNED_NATIVE_CDP_PID_MISMATCH");
        native.verified = true;
        native.activePortWitness = regularBytes(root, activePort, 4096);
        const activeIdentity = fs.lstatSync(activePort); native.activePortIdentity = { dev: activeIdentity.dev, ino: activeIdentity.ino };
        writeFact(root, label + "-native-bound.json", { schema: "owned-native-binding/v1", pid: native.pid, port,
          ownedDevToolsActivePort: true, heldChildMatchesSystemInfo: true, productionDiscoveryLaunchStopAttested: false });
        const pages = await nativeJson(port, "/json/list") as unknown as Dict[];
        const page = pages.find(entry => entry.type === "page" && entry.webSocketDebuggerUrl);
        ensure(page, "OWNED_NATIVE_PAGE_MISSING");
        native.page = await Cdp.connect(page.webSocketDebuggerUrl, port, () => alive(native) && native.verified);
        await native.page.send("Page.enable"); await native.page.send("Network.enable");
        current.table.runningProcesses.set(ID, { pid: native.pid, process: child, port, lastActivityAt: Date.now(), engine: "chromium" });
        const browserSoftware = version!.Browser, protocolSoftware = version!["Protocol-Version"];
        ensure(typeof browserSoftware === "string" && browserSoftware.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._+()\/-]*$/.test(browserSoftware) &&
          typeof protocolSoftware === "string" && protocolSoftware.length <= 16 && /^[0-9]+(?:\.[0-9]+){1,3}$/.test(protocolSoftware), "OWNED_NATIVE_SOFTWARE_METADATA_INVALID");
        receipt.native.push({ label, pid: native.pid, port, heldChildMatchesCdp: true, ownedDevToolsActivePort: true,
          softwareObservation: { source: "owned-/json/version", Browser: browserSoftware, "Protocol-Version": protocolSoftware, nativeSourceBuildAttested: false },
          normalMacLaunchSwitches: true, productionDiscoveryLaunchStopAttested: false });
        return native;
      }
      receipt.phase = "source-native-seed";
      const source = await device("source");
      const cfg = structuredClone(source.config.getConfig()); cfg.browserProfiles[ID] = { name: "Owned native Cookie login", engine: "chromium", platform: "macos", fingerprintMode: "managed", fingerprintSeed: 730147, locale: "en-US", timezone: "UTC", proxyMode: "none" }; source.config.saveConfig(cfg);
      const nativeSource = await launch(source, "source");
      await navigate(nativeSource, fixture.siteOrigin + "/probe");
      ensure(fixture.sourceProbe()?.allHttpCookiesMatch === false && fixture.sourceProbe()?.httpStatus === 401, "OWNED_SOURCE_NEGATIVE_CONTROL_FAILED");
      await navigate(nativeSource, fixture.siteOrigin + "/seed");
      await navigate(nativeSource, fixture.siteOrigin + "/probe");
      ensure(fixture.sourceProbe()?.allHttpCookiesMatch && fixture.sourceProbe()?.httpStatus === 200 && fixture.sourceProbe()?.secureCookieAbsent, "OWNED_SOURCE_HTTP_COOKIES_NOT_USABLE");
      receipt.sourceHttpControl = { withoutCookies: 401, afterHttpSeed: 200 };
      const expires = Math.floor(Date.now() / 1000) + 86400;
      // Empty-name wire syntax is not part of the site's authentication gate.
      // Create that legal native-store case explicitly, then verify it survives
      // transport and cold SQL without assuming a Cookie header serialization.
      const cdpCookies: Dict[] = [
        { name: "", value: extraValues[0], url: fixture.siteOrigin + "/", path: "/", secure: false, httpOnly: true, sameSite: "Lax", expires },
        { name: "__Host-owned_secure", value: extraValues[1], url: `https://${HOST}/`, path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires },
      ];
      for (const [site, topLevelSite] of ["https://owned-a.invalid", "https://owned-b.invalid"].entries()) for (const hasCrossSiteAncestor of [false, true]) {
        cdpCookies.push({ name: "owned_partition", value: extraValues[2 + site * 2 + Number(hasCrossSiteAncestor)], url: `https://${HOST}/`, path: "/", secure: true, httpOnly: true, sameSite: "None", expires, partitionKey: { topLevelSite, hasCrossSiteAncestor } });
      }
      for (const cookie of cdpCookies) ensure((await nativeSource.page!.send("Network.setCookie", cookie)).success === true, "OWNED_SOURCE_HTTPS_CDP_COOKIE_REJECTED");
      const sourceSnapshot = await source.cookies.cdpCookieService.exportCookiesSnapshot(ID);
      ensure(sourceSnapshot.state === "available", "OWNED_SOURCE_COOKIE_EXPORT_UNAVAILABLE");
      const expected = sourceSnapshot.cookies;
      ensure(expected.length === httpValues.size + cdpCookies.length && expected.every(cookie => cookie.domain === HOST || cookie.domain === "." + HOST), "OWNED_SOURCE_COOKIE_SCOPE");
      ensure(expected.find(cookie => cookie.name === "owned_unspecified")?.sameSite === -1 && expected.some(cookie => cookie.name === ""), "OWNED_SOURCE_MISSING_LEGAL_COOKIE_CASE");
      ensure(expected.find(cookie => cookie.name === "owned_persistent")?.domain === HOST && expected.find(cookie => cookie.name === "owned_domain")?.domain === "." + HOST, "OWNED_SOURCE_HOST_ONLY_OR_DOMAIN_SCOPE");
      ensure(expected.filter(cookie => cookie.partitionKey).length === 4 && expected.filter(cookie => cookie.partitionKey).every(cookie => cdpCookies.some(item => item.value === cookie.value && JSON.stringify(item.partitionKey) === JSON.stringify(cookie.partitionKey))), "OWNED_SOURCE_PARTITION_DIMENSIONS");
      fixture.disableSeed();
      if (FULL_STORAGE) {
        receipt.phase = "source-native-storage-write";
        receipt.storage = { sessionStorage: { covered: false, reason: "Original top-level tab/session restoration is not exercised; fresh-tab emptiness is not a data-loss verdict" } };
        await navigate(nativeSource, fixture.storageOrigin + STORAGE_PATH + "page");
        receipt.storage.sourceWrite = await seedNativeStorage(nativeSource.page!, fixture.storageOrigin, storageValues);
        // No settle, checkpoint, flush, storage read or disk inspection between
        // the completed browser write program and its normal Browser.close.
        await closeNative(nativeSource); source.table.runningProcesses.delete(ID);
        receipt.phase = "source-cold-storage-and-cookie-query";
        const exitedNormally = (native: NativeOwner) => native.verified && native.closeRequested && native.exited?.code === 0 && native.exited.signal === null && !alive(native);
        receipt.sourceCookieCoverage = coldCookieCoverage(root, nativeSource.profile, expected, () => exitedNormally(nativeSource));
        receipt.sourceColdSql = await inspectCold(root, nativeSource, expected);
        const storageFiles = (profile: string, label: string, quiescent: () => boolean) => {
          ensure(quiescent(), "OWNED_STORAGE_QUERY_REQUIRES_QUIESCENT_PROFILE");
          const result = inspectNativeStorageFiles({ root, profile, label, origin: fixture!.storageOrigin, values: storageValues,
            read: (file, maximum) => regularBytes(root, file, maximum) });
          ensure(quiescent(), "OWNED_STORAGE_QUERY_PROFILE_CHANGED"); return result;
        };
        receipt.storage.sourceFiles = storageFiles(nativeSource.profile, "source", () => exitedNormally(nativeSource)); guard({ forceGlobal: true });
        receipt.phase = "production-full-push-and-file-backed-s3";
        const pushed = await source.sync.push(operationAbort.signal); receipt.push = syncFact(pushed);
        ensure(pushed.success && pushed.outcome === "complete" && pushed.remoteCommit === "committed", "OWNED_FULL_PUSH_NOT_COMPLETE");
        const published = regularBytes(root, childPath(fixture.objects, CONFIG_KEY)), document = JSON.parse(published.toString("utf8"));
        ensure(document.artifactVersion === 4 && document.fullProfiles?.[ID] && !document.cookies && !document.localStorage, "OWNED_FULL_ENVELOPE_INVALID");
        const descriptor = document.fullProfiles[ID];
        ensure(typeof descriptor.key === "string" && /^full-profile-v1-[a-f0-9]{64}\.bin$/.test(descriptor.key) && descriptor.dirId === ID &&
          descriptor.snapshotId === document.snapshotId, "OWNED_FULL_DESCRIPTOR_INVALID");
        const fullBytes = regularBytes(root, childPath(fixture.objects, descriptor.key), FULL_OBJECT_CAP);
        ensure(fullBytes.length === descriptor.size && sha(fullBytes) === descriptor.sha256, "OWNED_FULL_OBJECT_DIGEST_MISMATCH");
        const objectFacts = [];
        for (const [key, bytes] of [[CONFIG_KEY, published], [descriptor.key, fullBytes]] as const) {
          const get = await fetch(`${fixture.endpoint}/${BUCKET}/${key}`, { signal: AbortSignal.timeout(5000) });
          ensure(get.ok && Buffer.from(await get.arrayBuffer()).equals(bytes), "OWNED_FULL_S3_REAL_GET_MISMATCH");
          ensure(fixture.journal.some(entry => entry.method === "PUT" && entry.key === key && entry.sha256 === sha(bytes)) &&
            fixture.journal.some(entry => entry.method === "GET" && entry.key === key && entry.sha256 === sha(bytes)), "OWNED_FULL_S3_JOURNAL_INCOMPLETE");
          objectFacts.push({ key, bytes: bytes.length, sha256: sha(bytes) });
        }
        receipt.s3 = { artifactVersion: 4, objects: objectFacts, actualFileQueryAndGet: true, fullObjectCap: FULL_OBJECT_CAP, sharedPhaseCap: PHASE_CAP };
        receipt.phase = "fresh-receiver-full-pull";
        const receiver = await device("receiver");
        ensure(Object.keys(receiver.config.getConfig().browserProfiles).length === 0, "OWNED_RECEIVER_NOT_FRESH");
        const pulled = await receiver.sync.pull(operationAbort.signal); receipt.pull = syncFact(pulled);
        ensure(pulled.success && pulled.outcome === "complete" && pulled.localCommit === "committed" &&
          pulled.items?.some(item => item.scope === "fullProfile" && item.id === ID && item.state === "applied"), "OWNED_FULL_PULL_NOT_COMPLETE");
        receiver.config.reloadConfig(); ensure(receiver.config.getProfileMeta(ID)?.engine === "chromium", "OWNED_RECEIVER_METADATA_RELOAD");
        ensure(receiver.cookies.readQueuedCookieImports(ID, { strict: true }).length === 0, "OWNED_FULL_RESTORE_UNEXPECTED_COOKIE_QUEUE");
        const receiverProfile = childPath(receiver.config.getProfilesDir(), ID);
        const neverLaunched = () => shell.profiles.get(receiverProfile)?.owner === null && !receiver.table.runningProcesses.has(ID);
        receipt.receiverBeforeLaunchCookieCoverage = coldCookieCoverage(root, receiverProfile, expected, neverLaunched);
        receipt.receiverBeforeLaunchCookieCoverage.quiescence = "restored-fresh-profile-never-launched";
        receipt.storage.restoredBeforeLaunch = storageFiles(receiverProfile, "receiver-before-launch", neverLaunched);
        ensure(JSON.stringify(receipt.storage.sourceFiles) === JSON.stringify(receipt.storage.restoredBeforeLaunch), "OWNED_FULL_STORAGE_RESTORED_FILES_DIFFER");
        guard({ forceGlobal: true }); fixture.beginReceiver();
        for (let cycle = 0; cycle < 2; cycle++) {
          receipt.phase = cycle === 0 ? "receiver-first-cold-storage-and-cookie-read" : "receiver-second-cold-storage-and-cookie-read";
          const beforeProbe = fixture.receiverProbeCount();
          const nativeReceiver = await launch(receiver, cycle === 0 ? "receiver" : "receiver-restart");
          await navigate(nativeReceiver, fixture.siteOrigin + "/probe");
          const first = cycle === 0 ? fixture.receiverProbe() : fixture.latestReceiverProbe();
          const received = await receiver.cookies.cdpCookieService.exportCookiesSnapshot(ID);
          const cookieFact = received.state === "available" ? { state: "available", ...cookieCoverage(received.cookies.map(cookie => ({
            identity: cookieIdentity(cookie), session: cookie.expires === null })), expected), allValuesAndScopesMatch: sameCookies(received.cookies, expected) } :
            { state: "unavailable", allValuesAndScopesMatch: false };
          const observation: Dict = { cycle: cycle + 1, httpStatus: first?.httpStatus ?? null, firstReadOnlyHttpRequestMatched: first?.allHttpCookiesMatch === true,
            newReadOnlyProbeObserved: fixture.receiverProbeCount() > beforeProbe, seedAttempts: fixture.fact().receiverSeedAttempts, cookies: cookieFact };
          (receipt.storage.receiverReads ??= []).push(observation);
          await navigate(nativeReceiver, fixture.storageOrigin + STORAGE_PATH + "page");
          try { observation.storage = await readNativeStorage(nativeReceiver.page!, fixture.storageOrigin, storageValues, false); }
          catch (error) { observation.storage = { state: "unavailable", code: (error as Error)?.message === "OWNED_STORAGE_PROGRAM_FAILED" ? "OWNED_STORAGE_PROGRAM_FAILED" : "OWNED_STORAGE_READBACK_UNAVAILABLE" }; }
          // Capture every category and session-vs-persistent diagnostic before a
          // strict assertion. Missing session Cookies are never filtered out.
          ensure(observation.newReadOnlyProbeObserved && first?.allHttpCookiesMatch && first.httpStatus === 200 && first.secureCookieAbsent && observation.seedAttempts === 0, "OWNED_FULL_FIRST_REQUEST_NOT_AUTHENTICATED");
          ensure(cookieFact.allValuesAndScopesMatch, "OWNED_FULL_NATIVE_COOKIE_IDENTITY_OR_VALUE_LOSS");
          ensure(observation.storage.checks && Object.keys(observation.storage.checks).length === 9 && observation.storage.errors.length === 0 &&
            Object.values(observation.storage.checks).every(value => value === true), "OWNED_FULL_STORAGE_NATIVE_READBACK_MISMATCH");
          receipt.receiver = { firstReadOnlyHttpRequestMatched: true, httpStatus: first.httpStatus, seedAttempts: 0, allNativeJarValuesAndScopesMatch: true,
            cookieCount: expected.length, partitionedCookieCount: 4, coldLaunchesVerified: cycle + 1, httpsCases: "CDP storage only; HTTPS website acceptance not tested" };
          await closeNative(nativeReceiver); receiver.table.runningProcesses.delete(ID);
          observation.coldCookieCoverage = coldCookieCoverage(root, nativeReceiver.profile, expected, () => exitedNormally(nativeReceiver));
          observation.coldSql = await inspectCold(root, nativeReceiver, expected);
          observation.coldStorageFiles = storageFiles(nativeReceiver.profile, "receiver-" + cycle, () => exitedNormally(nativeReceiver));
          guard({ forceGlobal: true });
        }
        receipt.receiverColdSql = receipt.storage.receiverReads.at(-1).coldSql;
      } else {
      receipt.phase = "production-push-and-file-backed-s3";
      guard({ forceGlobal: true }); // Accurate checkpoint outside the native export deadline.
      const pushed = await source.sync.push(operationAbort.signal);
      ensure(pushed.remoteCommit === "committed" && ["complete", "partial"].includes(pushed.outcome || "") &&
        (pushed.success || pushed.browserBackupIncomplete === true), "OWNED_PRODUCTION_PUSH_FAILED");
      const object = childPath(fixture.objects, CONFIG_KEY), publishedBytes = regularBytes(root, object), document = JSON.parse(publishedBytes.toString("utf8"));
      ensure(document.artifactVersion === 3 && document.artifactSources?.cookies?.[ID] === "captured", "OWNED_COOKIE_NOT_FRESHLY_CAPTURED");
      const { gunzipSync } = await import("node:zlib");
      const uploadedCookies = JSON.parse(gunzipSync(Buffer.from(document.cookies[ID], "base64")).toString("utf8")) as CookieInfo[];
      ensure(sameCookies(uploadedCookies, expected), "OWNED_S3_COOKIE_IDENTITY_OR_VALUE_LOSS");
      const get = await fetch(`${fixture.endpoint}/${BUCKET}/${CONFIG_KEY}`, { signal: AbortSignal.timeout(5000) });
      ensure(get.ok && Buffer.from(await get.arrayBuffer()).equals(publishedBytes), "OWNED_S3_REAL_GET_MISMATCH");
      ensure(fixture.journal.some(entry => entry.method === "PUT" && entry.key === CONFIG_KEY && entry.sha256 === sha(publishedBytes)) && fixture.journal.some(entry => entry.method === "GET" && entry.key === CONFIG_KEY && entry.sha256 === sha(publishedBytes)), "OWNED_S3_FILE_JOURNAL_INCOMPLETE");
      receipt.push = syncFact(pushed); receipt.s3 = { objectBytes: publishedBytes.length, sha256: sha(publishedBytes), actualFileQueryAndGet: true };
      receipt.phase = "source-normal-close-and-cold-sql";
      await closeNative(nativeSource); source.table.runningProcesses.delete(ID);
      receipt.sourceColdSql = await inspectCold(root, nativeSource, expected); guard({ forceGlobal: true });
      receipt.phase = "fresh-receiver-production-pull";
      const receiver = await device("receiver");
      ensure(Object.keys(receiver.config.getConfig().browserProfiles).length === 0, "OWNED_RECEIVER_NOT_FRESH");
      const pulled = await receiver.sync.pull(operationAbort.signal, { strategy: "remote" });
      ensure(pulled.localCommit === "committed" && ["complete", "partial"].includes(pulled.outcome || "") &&
        pulled.items?.some(item => item.scope === "cookies" && item.id === ID && item.state === "queued" && item.count === expected.length), "OWNED_PRODUCTION_PULL_DID_NOT_QUEUE");
      const queue = childPath(receiver.device, "pending-cookie-imports", ID + ".json"), queuedBytes = regularBytes(root, queue);
      ensure(sameCookies(JSON.parse(queuedBytes.toString("utf8")), expected) && sameCookies(receiver.cookies.readQueuedCookieImports(ID, { strict: true }), expected), "OWNED_RECEIVER_QUEUE_IDENTITY_OR_VALUE_LOSS");
      receiver.config.reloadConfig(); ensure(receiver.config.getProfileMeta(ID)?.engine === "chromium", "OWNED_RECEIVER_METADATA_RELOAD");
      receipt.pull = syncFact(pulled); receipt.queue = { count: expected.length, bytes: queuedBytes.length, directJsonAndReadback: true };
      receipt.phase = "receiver-first-read-only-request";
      guard({ forceGlobal: true });
      fixture.beginReceiver(); // Before native startup; automatic restored tabs cannot reseed a passing result.
      const nativeReceiver = await launch(receiver, "receiver");
      const imported = await receiver.cookies.cdpCookieService.applyQueuedImports(ID, { port: nativeReceiver.port, isCurrent: () => alive(nativeReceiver) && nativeReceiver.verified && receiver.table.runningProcesses.get(ID)?.process === nativeReceiver.child });
      ensure(imported === expected.length && !fs.existsSync(queue), "OWNED_NATIVE_IMPORT_INCOMPLETE");
      await navigate(nativeReceiver, fixture.siteOrigin + "/probe");
      const first = fixture.receiverProbe();
      ensure(first?.allHttpCookiesMatch && first.httpStatus === 200 && first.secureCookieAbsent && fixture.fact().receiverSeedAttempts === 0, "OWNED_FIRST_RECEIVER_REQUEST_NOT_AUTHENTICATED");
      const received = await receiver.cookies.cdpCookieService.exportCookiesSnapshot(ID);
      ensure(received.state === "available" && sameCookies(received.cookies, expected), "OWNED_RECEIVER_NATIVE_JAR_IDENTITY_OR_VALUE_LOSS");
      receipt.receiver = { firstReadOnlyHttpRequestMatched: true, httpStatus: first.httpStatus, seedAttempts: 0, allNativeJarValuesAndScopesMatch: true,
        cookieCount: expected.length, partitionedCookieCount: 4, httpsCases: "CDP storage only; HTTPS website acceptance not tested" };
      receipt.phase = "receiver-normal-close-and-cold-sql";
      await closeNative(nativeReceiver); receiver.table.runningProcesses.delete(ID);
      receipt.receiverColdSql = await inspectCold(root, nativeReceiver, expected);
      }
      ensure(fixture.failures.length === 0 && !budgetFailure && !timeFailure && shell.discoveryDenied === 0, "OWNED_FIXTURE_OR_BUDGET_FAILED");
      receipt.budget.beforeCleanup = guard({ forceGlobal: true }); receipt.status = "passed"; receipt.phase = "complete";
    } catch (error) {
      failure = true; receipt.status = "failed";
      const message = (error as Error)?.message, code = (error as { code?: unknown })?.code;
      receipt.error = typeof message === "string" && /^OWNED_[A-Z0-9_]+$/.test(message) ? message : "OWNED_ACCEPTANCE_FAILED_AT_" + receipt.phase;
      if (typeof code === "string" && /^[A-Z_]{1,64}$/.test(code)) receipt.failureCode = code;
    } finally {
      if (deadline) clearTimeout(deadline);
      for (const native of natives.slice().reverse()) {
        try {
          await closeNative(native); // Also retires a pending RPC when exit was observed first.
          ensure(native.exited?.code === 0 && native.exited.signal === null, "OWNED_NATIVE_CLEANUP_UNCONFIRMED");
          receipt.cleanup.push({ pid: native.pid, normalActualExit: true, closeRpc: { ...native.closeRpc } });
        } catch {
          failure = true; receipt.status = "failed";
          receipt.cleanup.push({ pid: native.pid, retained: true, normalActualExit: false, closeRpc: { ...native.closeRpc } });
        }
      }
      if (timer) clearInterval(timer);
      try { await fixture?.close(); }
      catch { failure = true; receipt.status = "failed"; receipt.cleanup.push({ fixtureClosed: false }); }
      receipt.fixture = fixture?.fact(); receipt.finishedAt = new Date().toISOString();
      if (fixture?.failures.length || budgetFailure || timeFailure || shell.discoveryDenied) { failure = true; receipt.status = "failed"; }
      receipt.discovery = { mode: "explicit-held-child-boundary", calls: shell.discoveryCalls, denied: shell.discoveryDenied, globalProcessScan: false };
      try {
        receipt.closeRpc = natives.map(native => ({ pid: native.pid, rpc: { ...native.closeRpc }, actualExit: native.exited }));
        receipt.sourcePins.after = sourcePins();
        if (JSON.stringify(receipt.sourcePins.after) !== JSON.stringify(pinsBefore)) {
          failure = true; receipt.status = "failed"; receipt.error = "OWNED_SOURCE_CHANGED_DURING_ACCEPTANCE";
        }
        let failedAdministrative = failure || receipt.status !== "passed";
        if (!failedAdministrative) {
          try { receipt.budget.final = guard({ forceGlobal: true }); }
          catch {
            budgetFailure = true; failure = true; failedAdministrative = true; receipt.status = "failed";
            receipt.error = "OWNED_FINAL_OPERATIONAL_BUDGET_FAILED";
          }
        }
        if (failedAdministrative) {
          failure = true; receipt.status = "failed"; administrativeReceiptAllowed = true;
          // This does not reopen work or clear any failure latch. If the original
          // root identity, hard caps or 10GiB floor cannot fit this small receipt,
          // the throw preserves the existing owner/binding witnesses instead.
          receipt.budget.final = guard({ forceGlobal: true, administrativeBytes: ADMIN_CAP });
        }
        receipt.budget.observation = { globalScanCadenceMs: GLOBAL_SCAN_MS, phaseScanCadenceMs: PHASE_SCAN_MS,
          ...measurements, beforeReceiptWrite: true,
          outerAggregateSupervisionRequired: true, atomicQuota: false };
        const text = JSON.stringify(receipt, null, 2);
        ensure(Buffer.byteLength(text) <= ADMIN_CAP, "OWNED_ADMINISTRATIVE_RECEIPT_TOO_LARGE");
        ensure(!allValues.some(value => text.includes(value)), "OWNED_RECEIPT_CONTAINS_COOKIE_VALUE");
        ensure(!failedAdministrative || receipt.status === "failed", "OWNED_FAILED_RECEIPT_CANNOT_PASS");
        identities();
        const file = childPath(root, "receipt.json"), pending = childPath(root, "receipt.pending.json");
        ensure(!fs.lstatSync(file, { throwIfNoEntry: false }), "OWNED_RECEIPT_ALREADY_EXISTS");
        const fd = fs.openSync(pending, "wx", 0o600);
        try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        ensure(regularBytes(root, pending).equals(Buffer.from(text)), "OWNED_RECEIPT_READBACK_FAILED");
        // A pending file is NOT a committed receipt. Recheck actual phase growth,
        // identity and the unchanged hard caps before publishing receipt.json.
        guard(failedAdministrative ? { forcePhase: true, administrativeBytes: 0 } : { forcePhase: true });
        identities(); fs.renameSync(pending, file);
        ensure(regularBytes(root, file).equals(Buffer.from(text)), "OWNED_RECEIPT_READBACK_FAILED");
      } catch { failure = true; receipt.status = "failed"; }
      vi.unstubAllEnvs();
    }
    ensure(!failure && receipt.status === "passed", "OWNED_S3_COOKIE_LOGIN_ACCEPTANCE_FAILED");
  }, 240_000);
});
