// Real SQLite main+WAL bytes, production sync capture/publication/pull, no browser
// or cloud. The launcher gives this suite an exclusive HOME/TMPDIR task child.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";

type FsObservation = { op: "open" | "close" | "fsync" | "rename" | "link" | "unlink"; file: string; to?: string;
  fd?: number; flags?: string | number; kind?: "directory" | "file" | "other"; ok: boolean; error?: unknown };

const h = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-sqlite-owned-")));
  const owner = fs.lstatSync(root);
  return { root, ownerDev: owner.dev, ownerIno: owner.ino, appData: path.join(root, "device"),
    objects: new Map<string, Buffer>(), requests: [] as Array<{ method: string; url: string }>,
    running: new Set<string>(), fault: null as null | ((op: string, from: string, to?: string) => void),
    reads: [] as string[], fds: new Map<number, string>(), io: null as FsObservation[] | null, snapshot: vi.fn(),
    checkerFactory: null as null | ((source: string, options: any) => any), checkerHook: null as null | ((worker: any, options: any) => void), checkerStarts: 0 };
});
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return { ...actual, Worker: function (source: string, options: any) {
    h.checkerStarts++;
    const worker = h.checkerFactory ? h.checkerFactory(source, options) : new actual.Worker(source, options);
    h.checkerHook?.(worker, options); return worker;
  } };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const observe = <T>(event: FsObservation, action: () => T): T => {
    h.io?.push(event);
    try { const value = action(); event.ok = true; return value; }
    catch (error) { event.error = error; throw error; }
  };
  return { ...actual,
    openSync: (file: any, flags: any, mode?: any) => {
      const event: FsObservation = { op: "open", file: String(file), flags, ok: false };
      return observe(event, () => {
        h.fault?.("open", String(file));
        const fd = actual.openSync(file, flags, mode); event.fd = fd; h.fds.set(fd, String(file)); return fd;
      });
    },
    closeSync: (fd: number) => observe({ op: "close", file: h.fds.get(fd) || "", fd, ok: false }, () => {
      actual.closeSync(fd); h.fds.delete(fd);
    }),
    fsyncSync: (fd: number) => {
      const stat = actual.fstatSync(fd);
      // Observe the real descriptor and real syscall; never manufacture either
      // successful durability or a platform-specific refusal.
      return observe({ op: "fsync", file: h.fds.get(fd) || "", fd,
        kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", ok: false }, () => actual.fsyncSync(fd));
    },
    readSync: (fd: number, ...args: any[]) => {
      const file = h.fds.get(fd) || ""; h.reads.push(file);
      const n = (actual.readSync as any)(fd, ...args); h.fault?.("read", file); return n;
    },
    renameSync: (from: any, to: any) => observe({ op: "rename", file: String(from), to: String(to), ok: false }, () => {
      h.fault?.("rename", String(from), String(to)); return actual.renameSync(from, to);
    }),
    linkSync: (from: any, to: any) => observe({ op: "link", file: String(from), to: String(to), ok: false }, () => {
      h.fault?.("link", String(from), String(to)); return actual.linkSync(from, to);
    }),
    unlinkSync: (file: any) => observe({ op: "unlink", file: String(file), ok: false }, () => {
      h.fault?.("unlink", String(file)); return actual.unlinkSync(file);
    }),
  };
});
vi.mock("electron", () => ({ app: { getPath: (name: string) => name === "home" ? path.join(h.root, "home") : h.appData },
  safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), hostname: () => "owned-sqlite-fixture" }));
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: (id: string) => ({ running: h.running.has(id), pid: null, cdpPort: null }) }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ runtimeCookieOps: {
  hasRunningBrowser: (id: string) => h.running.has(id), exportCookiesSnapshot: h.snapshot,
  importCookies: async (_id: string, cookies: unknown[]) => cookies.length,
} }));

import { __syncTestHooks, syncService } from "../../src/main/services/sync-service.js";
import { getConfig, getConfigPath, getProfileMeta, getProfilesDir, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";
import { getSyncOperationState } from "../../src/main/services/sync/operation-state.js";
import { validateSqliteLocalStorageGroup, MAX_SQLITE_LOCAL_STORAGE_BYTES } from "../../src/main/services/sync/sqlite-local-storage.js";

const ID = "ab_sqlite_localstorage";
const ENDPOINT = "https://sync.example.test";
const MAIN = `${ENDPOINT}/sqlite-fixture/agent-browser-studio-config.json`;
const ORIGIN = "https://business.example.test";
const VALUE = "actual-WAL-only-business-value-中文";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const defaultDir = () => path.join(getProfilesDir(), ID, "Default");
const dbPath = () => path.join(defaultDir(), "LocalStorage");
const payload = () => JSON.parse(h.objects.get(MAIN)!.toString("utf8"));
function assertOwner(): void {
  const s = fs.lstatSync(h.root);
  if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== h.ownerDev || s.ino !== h.ownerIno) throw new Error("Unowned SQLite fixture");
}
function resetDevice(name: string): void {
  assertOwner();
  if (fs.existsSync(h.appData)) fs.rmSync(h.appData, { recursive: true });
  fs.mkdirSync(h.appData, { mode: 0o700 }); reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.deviceId = name; cfg.deviceName = name; cfg.browserProfiles = {}; cfg.proxies = {}; cfg.accounts = []; cfg.extensionRepository = {};
  cfg.sync = { enabled: true, endpoint: ENDPOINT, bucket: "sqlite-fixture", accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: 1 };
  saveConfig(cfg);
  expect(getConfigPath()).toBe(path.join(h.appData, "config.json"));
}
function seedProfile(name = "SQLite source"): void {
  const cfg = structuredClone(getConfig());
  cfg.browserProfiles[ID] = { name, engine: "chromium", fingerprintMode: "managed", fingerprintSeed: 42, proxyMode: "none", updatedAt: 100 };
  saveConfig(cfg); fs.mkdirSync(defaultDir(), { recursive: true, mode: 0o700 });
}
function sqliteBytes(value = VALUE): { main: Buffer; wal: Buffer } {
  const dir = fs.mkdtempSync(path.join(h.root, "sqlite-generator-"));
  const file = path.join(dir, "LocalStorage");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE business_storage(origin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(origin,key)) WITHOUT ROWID;");
    db.prepare("INSERT INTO business_storage VALUES(?,?,?)").run(ORIGIN, "sync-key", value);
    const bytes = { main: fs.readFileSync(file), wal: fs.readFileSync(file + "-wal") };
    expect(bytes.main.length).toBe(4096); expect(bytes.wal.length).toBeGreaterThan(4096);
    return bytes;
  } finally { db.close(); fs.rmSync(dir, { recursive: true }); }
}
function installSqlite(bytes = sqliteBytes(), shm = false): typeof bytes {
  fs.mkdirSync(defaultDir(), { recursive: true });
  fs.writeFileSync(dbPath(), bytes.main); fs.writeFileSync(dbPath() + "-wal", bytes.wal);
  if (shm) fs.writeFileSync(dbPath() + "-shm", Buffer.from("synthetic SHM must never be archived"));
  return bytes;
}
function assertBusiness(file: string, value = VALUE): void {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    expect(db.prepare("SELECT origin,key,value FROM business_storage WHERE origin=? AND key=?").get(ORIGIN, "sync-key")).toEqual({ origin: ORIGIN, key: "sync-key", value });
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally { db.close(); }
}
function tarEntry(name: string, data: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512); header.write(name, 0, 100, "utf8"); header.write("0000600\0", 100, 8, "ascii");
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii"); header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0); header.write("ustar\0", 257, 6, "ascii");
  const sum = header.reduce((n, b) => n + b, 0); header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)]);
}
function archive(entries: Array<[string, Buffer, string?]>): Buffer {
  return zlib.gzipSync(Buffer.concat([...entries.map(([name, bytes, type]) => tarEntry(name, bytes, type)), Buffer.alloc(1024)]));
}
function sqliteArchive(bytes = sqliteBytes()): Buffer { return archive([["LocalStorage", bytes.main], ["LocalStorage-wal", bytes.wal]]); }
function legacyArchive(): Buffer { return archive([["CURRENT", Buffer.from("MANIFEST-000001\n")], ["MANIFEST-000001", Buffer.from("legacy manifest")]]); }
function remoteArchive(tgz: Buffer): void {
  h.objects.set(MAIN, Buffer.from(JSON.stringify({ timestamp: 1000,
    data: zlib.gzipSync(JSON.stringify({ version: 4, browserProfiles: { [ID]: { name: "SQLite remote", engine: "chromium", fingerprintSeed: 42 } }, proxies: {}, accounts: [] })).toString("base64"),
    localStorage: { [ID]: tgz.toString("base64") } })));
}

function mainOnlyBytes(extraSql = ""): Buffer {
  const dir = fs.mkdtempSync(path.join(h.root, "sqlite-main-only-"));
  const file = path.join(dir, "LocalStorage");
  const db = new DatabaseSync(file);
  try { db.exec("CREATE TABLE business_storage(origin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(origin,key)) WITHOUT ROWID;" + extraSql); }
  finally { db.close(); }
  const bytes = fs.readFileSync(file); fs.rmSync(dir, { recursive: true }); return bytes;
}
function liveSnapshot(): Record<string, string | null> {
  return Object.fromEntries([getConfigPath(), ...["LocalStorage", "LocalStorage-wal", "LocalStorage-shm", "LocalStorage-journal"].map((name) => path.join(defaultDir(), name))]
    .map((file) => [file, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null]));
}
function assertLiveUnchanged(before: ReturnType<typeof liveSnapshot>): void {
  expect(liveSnapshot()).toEqual(before); reloadConfig(); expect(liveSnapshot()).toEqual(before);
}
function backupRoots(): string[] { return fs.readdirSync(defaultDir()).filter((name) => name.startsWith(".sqlite-localstorage-backup-")).map((name) => path.join(defaultDir(), name)); }
function assertBackupBusiness(root: string, value: string): void {
  const copy = fs.mkdtempSync(path.join(h.root, "backup-readback-"));
  for (const name of ["LocalStorage", "LocalStorage-wal"]) if (fs.existsSync(path.join(root, "old", name))) fs.copyFileSync(path.join(root, "old", name), path.join(copy, name));
  try { assertBusiness(path.join(copy, "LocalStorage"), value); } finally { fs.rmSync(copy, { recursive: true }); }
}

// A real owned-directory probe labels the cases, not an OS-based skip. Each
// pull below must independently prove its actual mandatory transaction gate.
const directoryCapability = (() => {
  assertOwner();
  const fd = fs.openSync(h.root, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || stat.dev !== h.ownerDev || stat.ino !== h.ownerIno) throw new Error("Directory probe owner changed");
    fs.fsyncSync(fd); return "confirmed";
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (process.platform !== "win32" || failure.code !== "EPERM" || failure.syscall !== "fsync") throw error;
    return "refused";
  } finally { fs.closeSync(fd); }
})();
const directoryCase = directoryCapability === "confirmed" ? " [native directory fsync confirmed: restore/rollback assertions required]"
  : " [native directory fsync EPERM: conservation-only; downstream rollback NOT exercised]";
const sqliteNames = ["LocalStorage", "LocalStorage-wal", "LocalStorage-shm", "LocalStorage-journal"];
type IncomingSqlite = { main: Buffer; wal?: Buffer };
function liveBytes(): Map<string, Buffer | null> {
  return new Map([getConfigPath(), ...sqliteNames.map((name) => path.join(defaultDir(), name))].map((file) => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat) expect(stat.isFile() && !stat.isSymbolicLink(), file).toBe(true);
    return [file, stat ? fs.readFileSync(file) : null];
  }));
}
async function observeSqlitePull(incoming: IncomingSqlite) {
  const before = { live: liveBytes(), config: structuredClone(getConfig()),
    remote: new Map([...h.objects].map(([key, bytes]) => [key, Buffer.from(bytes)])),
    puts: h.requests.filter((request) => request.method === "PUT"), checkerStarts: h.checkerStarts };
  const io: FsObservation[] = []; expect(h.fds.size).toBe(0); h.io = io;
  try { return { result: await syncService.pull(undefined, { strategy: "remote" }), before, io, incoming }; }
  finally { h.io = null; }
}
type SqlitePullAttempt = Awaited<ReturnType<typeof observeSqlitePull>>;
function assertObservedIo(io: FsObservation[]): void {
  const opened = new Map<number, FsObservation>();
  for (const event of io) {
    expect(event.file.startsWith(h.root + path.sep), "I/O must remain in the owned fixture").toBe(true);
    if (event.to) expect(event.to.startsWith(h.root + path.sep)).toBe(true);
    if (event.op === "open") {
      expect(event.ok, `open ${event.file}`).toBe(true); expect(event.fd).toBeTypeOf("number");
      expect(opened.has(event.fd!)).toBe(false); opened.set(event.fd!, event);
    } else if (event.op === "close" || event.op === "fsync") {
      expect(opened.get(event.fd!)?.file, `${event.op} must have a real successful open`).toBe(event.file);
      if (event.op === "close") { expect(event.ok, `close ${event.file}`).toBe(true); opened.delete(event.fd!); }
      else {
        expect(event.kind).not.toBe("other");
        if (event.kind === "directory" && !event.ok) expect(opened.get(event.fd!)!.flags).toBe(fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      }
    }
  }
  expect(opened.size).toBe(0); expect(h.fds.size).toBe(0);
  expect(io.filter((event) => event.op === "close")).toHaveLength(io.filter((event) => event.op === "open").length);
  expect(io.filter((event) => event.op === "fsync" && event.kind !== "directory" && !event.ok), "regular-file fsync is mandatory").toEqual([]);
}
function assertNoLiveMoves(io: FsObservation[]): void {
  const live = new Set(sqliteNames.map((name) => path.join(defaultDir(), name)));
  expect(io.filter((event) => ["rename", "link", "unlink"].includes(event.op) && (live.has(event.file) || live.has(event.to || ""))),
    "not even an attempted live SQLite move is permitted before the directory gate").toEqual([]);
}
function assertConserved(before: SqlitePullAttempt["before"]): void {
  expect(liveBytes()).toEqual(before.live); expect(getConfig()).toEqual(before.config);
  expect(getConfig().browserProfiles[ID]?.syncBaseline).toEqual(before.config.browserProfiles[ID]?.syncBaseline);
  reloadConfig(); expect(liveBytes()).toEqual(before.live); expect(getConfig()).toEqual(before.config);
  expect(h.objects).toEqual(before.remote); expect(h.requests.filter((request) => request.method === "PUT")).toEqual(before.puts);
}
async function assertConservationIfDirectoryRefused(attempt: SqlitePullAttempt, oldValue?: string, downstreamHits: Record<string, number> = {}): Promise<boolean> {
  const { result, before, io, incoming } = attempt;
  assertObservedIo(io);
  const gates = io.filter((event) => event.op === "fsync" && event.kind === "directory" &&
    path.dirname(event.file) === defaultDir() && path.basename(event.file).startsWith(".sqlite-localstorage-backup-"));
  expect(gates.length, "actual owned transaction-directory fsync must have been attempted").toBeGreaterThan(0);
  const gate = gates[0], transaction = gate.file;
  const pendingFile = path.join(transaction, "pending.json");
  const pendingFlush = io.find((event) => event.op === "fsync" && event.file === pendingFile);
  expect(pendingFlush).toMatchObject({ kind: "file", ok: true }); expect(io.indexOf(pendingFlush!)).toBeLessThan(io.indexOf(gate));
  expect(h.checkerStarts - before.checkerStarts, "incoming SQLite must have passed the real native checker before publication").toBe(1);
  if (gate.ok) {
    expect(directoryCapability).toBe("confirmed");
    expect(io.filter((event) => event.op === "fsync" && !event.ok)).toEqual([]);
    expect(io.some((event) => event.op === "fsync" && event.file === defaultDir() && event.kind === "directory" && event.ok)).toBe(true);
    expect(io.some((event) => event.op === "rename" && event.to === path.join(transaction, "new") && event.ok)).toBe(true);
    return false; // The caller must still exercise every original positive/fault assertion.
  }

  // No arbitrary failure qualifies. This is the exact native refusal recognized
  // by syncArchiveDirectory, with successful opens and no regular-file failures.
  expect(directoryCapability).toBe("refused"); expect(process.platform).toBe("win32");
  const failures = io.filter((event) => !event.ok);
  expect(failures.map((event) => [event.op, event.kind, event.file])).toEqual([
    ["fsync", "directory", h.appData], ["fsync", "directory", path.join(h.appData, "profile-data-revisions")],
    ["fsync", "directory", transaction], ["fsync", "directory", defaultDir()],
    ["fsync", "directory", transaction], ["fsync", "directory", path.join(h.appData, "sync-recovery")],
  ]);
  for (const event of failures) expect(event.error).toMatchObject({ code: "EPERM", syscall: "fsync" });
  expect(failures[2]).toBe(gate); assertNoLiveMoves(io);
  expect(io.filter((event) => event.op === "rename" && event.to === path.join(transaction, "new"))).toEqual([]);
  for (const [name, hits] of Object.entries(downstreamHits)) expect(hits, `${name} was not reached: native directory gate refused first`).toBe(0);
  const message = "SQLite localStorage publication/compensation is incomplete; old/new material retained for recovery";
  expect(result).toMatchObject({ success: false, outcome: "recovery-required", localCommit: "partial", remoteCommit: "none",
    code: "LOCAL_STORAGE_RECOVERY_REQUIRED", message });
  expect(result.items?.filter((item) => ["applied", "queued"].includes(item.state))).toEqual([]);
  expect(result.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ scope: "profiles", id: ID, state: "preserved", code: "PROFILE_RESTORE_INCOMPLETE" }),
    expect.objectContaining({ scope: "localStorage", id: ID, state: "failed", message }),
  ]));
  expect(result.recovery).toEqual([{ resource: "localStorage", id: ID, paths: [transaction, defaultDir()], receiptPath: undefined }]);
  expect(backupRoots()).toEqual([transaction]);
  expect(fs.readdirSync(transaction).sort()).toEqual(["old", "pending.json", "recovery-required.json"]);
  expect(fs.readdirSync(path.join(transaction, "old"))).toEqual([]);
  expect(fs.existsSync(path.join(transaction, "new"))).toBe(false); expect(fs.existsSync(path.join(transaction, "published.json"))).toBe(false);
  const old = sqliteNames.flatMap((name) => {
    const bytes = before.live.get(path.join(defaultDir(), name)); return bytes == null ? [] : [{ name, hash: sha(bytes) }];
  });
  const inventory = [{ name: "LocalStorage", hash: sha(incoming.main) }, ...(incoming.wal === undefined ? [] : [{ name: "LocalStorage-wal", hash: sha(incoming.wal) }])];
  const pending = { version: 1, format: "sqlite", operationId: result.operationId, dirId: ID, target: defaultDir(), old, incoming: inventory };
  expect(JSON.parse(fs.readFileSync(pendingFile, "utf8"))).toEqual(pending);
  const recovery = { operationId: result.operationId, dirId: ID, state: "recovery-required", format: "sqlite", transaction, target: defaultDir(),
    old: old.map((entry) => ({ ...entry, backupPath: path.join(transaction, "old", entry.name), livePath: path.join(defaultDir(), entry.name) })),
    incoming: inventory.map((entry) => ({ ...entry, retainedPath: path.join(transaction, "new", entry.name), livePath: path.join(defaultDir(), entry.name) })) };
  const externalReceipt = path.join(h.appData, "sync-recovery", `${ID}.localStorage.json`);
  const receipts = new Map([pendingFile, path.join(transaction, "recovery-required.json"), externalReceipt].map((file) => {
    expect(io.filter((event) => event.op === "open" && event.file === file && event.flags === "wx" && event.ok)).toHaveLength(1);
    expect(io.filter((event) => event.op === "fsync" && event.file === file && event.kind === "file" && event.ok)).toHaveLength(1);
    const stat = fs.lstatSync(file); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true);
    const bytes = fs.readFileSync(file); expect(JSON.parse(bytes.toString("utf8"))).toEqual(file === pendingFile ? pending : recovery);
    return [file, bytes] as const;
  }));
  assertConserved(before);
  if (oldValue !== undefined) {
    const copy = fs.mkdtempSync(path.join(h.root, "conserved-readback-"));
    try {
      for (const name of ["LocalStorage", "LocalStorage-wal"]) if (before.live.get(path.join(defaultDir(), name)) !== null) fs.copyFileSync(path.join(defaultDir(), name), path.join(copy, name));
      assertBusiness(path.join(copy, "LocalStorage"), oldValue);
    } finally { fs.rmSync(copy, { recursive: true }); }
  } else expect(before.live.get(dbPath()), "fresh target must remain absent, not adopt incoming metadata").toBeNull();

  const assertBlocked = async (retryMessage: string, paths: string[], receiptPath?: string) => {
    const retry = await observeSqlitePull(incoming); assertObservedIo(retry.io); assertNoLiveMoves(retry.io);
    expect(retry.io.filter((event) => event.op === "fsync")).toEqual([]);
    expect(retry.result).toMatchObject({ success: false, outcome: "recovery-required", localCommit: "none", remoteCommit: "none",
      code: "LOCAL_STORAGE_RECOVERY_REQUIRED", message: retryMessage });
    expect(retry.result.recovery).toEqual([{ resource: "localStorage", id: ID, paths, receiptPath }]);
    expect(retry.result.items?.filter((item) => ["applied", "queued"].includes(item.state))).toEqual([]);
    expect(h.checkerStarts - before.checkerStarts).toBe(1); expect(backupRoots()).toEqual([transaction]); assertConserved(before);
    for (const [file, bytes] of receipts) expect(fs.readFileSync(file)).toEqual(bytes);
  };
  await assertBlocked("LocalStorage recovery is unresolved; refusing to overwrite its rescue copies", [], externalReceipt);
  fs.unlinkSync(externalReceipt); receipts.delete(externalReceipt); // Owned fault simulation: pending must independently block publication.
  await assertBlocked("SQLite LocalStorage recovery is unresolved; refusing to overwrite its rescue copies", [transaction]);
  console.info(`[SQLite directory contract] conservation-only: native EPERM/syscall=fsync at pending transaction; ${failures.length} directory refusals, no file/open failures, no live moves, ${io.filter((event) => event.op === "open").length} opens/closes, no tracked fd leaks; downstream rollback NOT exercised.`);
  return true;
}

beforeEach(() => {
  h.fault = null; h.io = null; h.reads = []; h.running.clear(); h.objects.clear(); h.requests = [];
  h.checkerFactory = null; h.checkerHook = null; h.checkerStarts = 0;
  h.snapshot.mockReset().mockResolvedValue({ state: "available", cookies: [] }); resetDevice("sqlite-sender");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method || "GET";
    expect(url.startsWith(ENDPOINT + "/")).toBe(true); h.requests.push({ method, url });
    if (method === "PUT") { h.objects.set(url, Buffer.from(init?.body as any)); return new Response("", { status: 200 }); }
    expect(method).toBe("GET"); const bytes = h.objects.get(url);
    return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response("owned missing object", { status: 404 });
  }));
});
afterEach(() => { h.fault = null; h.io = null; expect(h.fds.size, "owned fixture descriptors must all close").toBe(0); expect(isRestoreLocked(ID)).toBe(false); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => { assertOwner(); fs.rmSync(h.root, { recursive: true }); });

describe("SQLite LocalStorage actual sync data flow", () => {
  it("captures/publishes main+WAL (not SHM), pulls fresh, directly reads the WAL-only row, integrity checks and reloads" + directoryCase, async () => {
    seedProfile(); const source = installSqlite(undefined, true);
    const noWal = fs.mkdtempSync(path.join(h.root, "main-only-control-")); fs.writeFileSync(path.join(noWal, "LocalStorage"), source.main);
    const control = new DatabaseSync(path.join(noWal, "LocalStorage"), { readOnly: true });
    try { expect(() => control.prepare("SELECT value FROM business_storage").all()).toThrow(/no such table/); } finally { control.close(); }
    const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
    const document = payload(); expect(document.artifactSources.localStorage[ID]).toBe("captured");
    expect(document.localStorage[ID]).toBeTypeOf("string");
    const extracted = fs.mkdtempSync(path.join(h.root, "published-archive-"));
    const summary = __syncTestHooks.extractSafeLocalStorageArchive(Buffer.from(document.localStorage[ID], "base64"), extracted);
    expect(summary.files).toBe(2); expect(fs.readdirSync(extracted).sort()).toEqual(["LocalStorage", "LocalStorage-wal"]);
    expect(fs.readFileSync(path.join(extracted, "LocalStorage"))).toEqual(source.main);
    expect(fs.readFileSync(path.join(extracted, "LocalStorage-wal"))).toEqual(source.wal); assertBusiness(path.join(extracted, "LocalStorage"));
    resetDevice("sqlite-fresh-receiver"); const attempt = await observeSqlitePull(source), pulled = attempt.result;
    if (await assertConservationIfDirectoryRefused(attempt)) return;
    expect(pulled.success, pulled.message).toBe(true); expect(pulled.items).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "localStorage", id: ID, state: "applied" })]));
    expect(fs.existsSync(path.join(defaultDir(), "Local Storage", "leveldb"))).toBe(false);
    assertBusiness(dbPath()); reloadConfig(); expect(getProfileMeta(ID)?.name).toBe("SQLite source"); assertBusiness(dbPath());
    expect(h.objects.get(MAIN)).toEqual(Buffer.from(JSON.stringify(document)));
  });

  it("prepares and publishes a main+WAL archive at Default, not the legacy directory" + directoryCase, async () => {
    const incoming = sqliteBytes(); remoteArchive(sqliteArchive(incoming)); const attempt = await observeSqlitePull(incoming), result = attempt.result;
    if (await assertConservationIfDirectoryRefused(attempt)) return;
    expect(result.success, result.message).toBe(true); assertBusiness(dbPath());
    expect(fs.existsSync(path.join(defaultDir(), "Local Storage", "leveldb"))).toBe(false);
  });

  it("retains the accepted legacy LevelDB TAR contract", async () => {
    remoteArchive(legacyArchive()); const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success, result.message).toBe(true);
    expect(fs.readFileSync(path.join(defaultDir(), "Local Storage", "leveldb", "CURRENT"), "utf8")).toBe("MANIFEST-000001\n");
  });

  it("treats the observed Chromium maps/map_entries/meta schema as opaque data without requiring test-table names" + directoryCase, async () => {
    seedProfile(); const generator = fs.mkdtempSync(path.join(h.root, "observed-schema-")), file = path.join(generator, "LocalStorage");
    const db = new DatabaseSync(file); let bytes: ReturnType<typeof sqliteBytes>;
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE map_entries(map_id INTEGER NOT NULL,value_compression_type INTEGER NOT NULL,key BLOB NOT NULL,value BLOB NOT NULL,PRIMARY KEY(map_id,key)); CREATE TABLE maps(row_id INTEGER PRIMARY KEY,storage_key BLOB NOT NULL,last_accessed INTEGER,last_modified INTEGER,total_size INTEGER); CREATE TABLE meta(key LONGVARCHAR PRIMARY KEY NOT NULL,value LONGVARCHAR);");
      db.prepare("INSERT INTO maps VALUES(?,?,?,?,?)").run(1, Buffer.from(ORIGIN), 1, 1, VALUE.length);
      db.prepare("INSERT INTO map_entries VALUES(?,?,?,?)").run(1, 0, Buffer.from("acceptance_order"), Buffer.from(VALUE));
      bytes = { main: fs.readFileSync(file), wal: fs.readFileSync(file + "-wal") };
    } finally { db.close(); fs.rmSync(generator, { recursive: true }); }
    installSqlite(bytes!); const push = await syncService.push(undefined, true); expect(push.success, push.message).toBe(true);
    resetDevice("observed-schema-receiver"); const attempt = await observeSqlitePull(bytes!), pull = attempt.result;
    if (await assertConservationIfDirectoryRefused(attempt)) return;
    expect(pull.success, pull.message).toBe(true);
    const reader = new DatabaseSync(dbPath(), { readOnly: true });
    try {
      const row = reader.prepare("SELECT key,value FROM map_entries WHERE map_id=1").get() as any;
      expect(Buffer.from(row.key).toString("utf8")).toBe("acceptance_order"); expect(Buffer.from(row.value).toString("utf8")).toBe(VALUE);
      expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { reader.close(); }
    // Blob encoding/compression here is synthetic, not a claim that Chromium
    // has interpreted it. That semantic claim belongs to the real browser gate.
  });

  it("replaces old main/WAL/SHM with an empty valid main-only database without reviving old WAL rows" + directoryCase, async () => {
    seedProfile("old target"); const old = installSqlite(sqliteBytes("old-WAL-business-row"), true);
    const shmHash = sha(fs.readFileSync(dbPath() + "-shm")), incoming = { main: mainOnlyBytes() };
    remoteArchive(archive([["LocalStorage", incoming.main]]));
    const attempt = await observeSqlitePull(incoming), result = attempt.result;
    if (await assertConservationIfDirectoryRefused(attempt, "old-WAL-business-row")) return;
    expect(result.success, result.message).toBe(true);
    expect(fs.existsSync(dbPath() + "-wal")).toBe(false); expect(fs.existsSync(dbPath() + "-shm")).toBe(false);
    for (let i = 0; i < 2; i++) {
      const db = new DatabaseSync(dbPath(), { readOnly: true });
      try {
        expect(db.prepare("SELECT origin,key,value FROM business_storage").all()).toEqual([]);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally { db.close(); }
      reloadConfig();
    }
    const roots = backupRoots(); expect(roots).toHaveLength(1);
    expect(fs.readFileSync(path.join(roots[0], "old", "LocalStorage"))).toEqual(old.main);
    expect(fs.readFileSync(path.join(roots[0], "old", "LocalStorage-wal"))).toEqual(old.wal);
    expect(sha(fs.readFileSync(path.join(roots[0], "old", "LocalStorage-shm")))).toBe(shmHash);
    assertBackupBusiness(roots[0], "old-WAL-business-row");
    expect(result.warnings?.some((warning) => warning.includes(path.join(roots[0], "old")))).toBe(true);
  });

  it("replaces existing SQLite with a committed WAL-only row and retains a directly readable previous copy" + directoryCase, async () => {
    seedProfile(); installSqlite(sqliteBytes("previous-business")); const incoming = sqliteBytes(); remoteArchive(sqliteArchive(incoming));
    const attempt = await observeSqlitePull(incoming), result = attempt.result;
    if (await assertConservationIfDirectoryRefused(attempt, "previous-business")) return;
    expect(result.success, result.message).toBe(true);
    assertBusiness(dbPath()); assertBackupBusiness(backupRoots()[0], "previous-business");
    reloadConfig(); assertBusiness(dbPath());
  });

  it("preserves a previously verified SQLite snapshot for a running profile without reading its live database", async () => {
    seedProfile(); installSqlite(); const first = await syncService.push(undefined, true); expect(first.success, first.message).toBe(true);
    const encoded = payload().localStorage[ID]; h.running.add(ID); h.reads = [];
    h.fault = (op, file) => { if (op === "open" && [dbPath(), dbPath() + "-wal"].includes(file)) throw new Error("live SQLite source was read"); };
    const result = await syncService.push(undefined, true);
    expect(result).toMatchObject({ success: false, outcome: "partial", remoteCommit: "committed", browserBackupIncomplete: true });
    expect(payload().localStorage[ID]).toBe(encoded); expect(payload().artifactSources.localStorage[ID]).toBe("preserved");
    expect(result.items?.filter((item) => item.scope === "localStorage" && item.state === "preserved")).toHaveLength(1);
    expect(h.reads.filter((file) => [dbPath(), dbPath() + "-wal"].includes(file))).toEqual([]);
  });

  it("preserves an explicit reset zero-byte WAL and ignores only a proven empty source journal" + directoryCase, async () => {
    seedProfile(); const main = mainOnlyBytes(); fs.writeFileSync(dbPath(), main); fs.writeFileSync(dbPath() + "-wal", Buffer.alloc(0)); fs.writeFileSync(dbPath() + "-journal", Buffer.alloc(0));
    const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
    const extracted = fs.mkdtempSync(path.join(h.root, "empty-wal-")); __syncTestHooks.extractSafeLocalStorageArchive(Buffer.from(payload().localStorage[ID], "base64"), extracted);
    expect(fs.readdirSync(extracted).sort()).toEqual(["LocalStorage", "LocalStorage-wal"]); expect(fs.statSync(path.join(extracted, "LocalStorage-wal")).size).toBe(0);
    resetDevice("empty-wal-receiver"); const attempt = await observeSqlitePull({ main, wal: Buffer.alloc(0) }), pulled = attempt.result;
    if (await assertConservationIfDirectoryRefused(attempt)) return;
    expect(pulled.success, pulled.message).toBe(true);
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS n FROM business_storage").get()).toEqual({ n: 0 }); } finally { db.close(); }
  });

  it("moves an old empty rollback journal into backup rather than leaving it beside a replacement main" + directoryCase, async () => {
    seedProfile(); installSqlite(sqliteBytes("old with empty journal")); fs.writeFileSync(dbPath() + "-journal", Buffer.alloc(0));
    const incoming = sqliteBytes(); remoteArchive(sqliteArchive(incoming)); const attempt = await observeSqlitePull(incoming), result = attempt.result;
    if (await assertConservationIfDirectoryRefused(attempt, "old with empty journal")) return;
    expect(result.success, result.message).toBe(true);
    expect(fs.existsSync(dbPath() + "-journal")).toBe(false); expect(fs.statSync(path.join(backupRoots()[0], "old", "LocalStorage-journal")).size).toBe(0);
    assertBusiness(dbPath()); assertBackupBusiness(backupRoots()[0], "old with empty journal");
  });

  it("skips the entire running target profile instead of partially adopting metadata around its SQLite data", async () => {
    seedProfile(); installSqlite(sqliteBytes("running-original")); const before = liveSnapshot();
    const local = structuredClone(getConfig().browserProfiles[ID]);
    remoteArchive(sqliteArchive()); h.running.add(ID);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, outcome: "partial" });
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "profiles", id: ID, state: "skipped", code: "PROFILE_STOP_REQUIRED",
      runtimeEffect: expect.objectContaining({ action: "skipped-stop-required", stopRequired: true, queuedCookies: 0, liveCookiesApplied: 0 }) })]));
    expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).browserProfiles[ID]).toEqual(local);
    for (const [file, hash] of Object.entries(before)) if (file !== getConfigPath()) {
      if (hash === null) expect(fs.existsSync(file)).toBe(false); else expect(sha(fs.readFileSync(file))).toBe(hash);
    }
    expect(backupRoots()).toEqual([]);
  });
});

describe("SQLite archive/source prepare fails closed before live mutation", () => {
  it.each([
    { name: "orphan WAL", entries: (b: ReturnType<typeof sqliteBytes>) => [["LocalStorage-wal", b.wal]] },
    { name: "mixed LevelDB", entries: (b: ReturnType<typeof sqliteBytes>) => [["LocalStorage", b.main], ["LocalStorage-wal", b.wal], ["CURRENT", Buffer.from("MANIFEST-000001\n")], ["MANIFEST-000001", Buffer.from("legacy")]] },
    { name: "SHM persistence", entries: (b: ReturnType<typeof sqliteBytes>) => [["LocalStorage", b.main], ["LocalStorage-shm", Buffer.from("bad")]] },
    { name: "duplicate main", entries: (b: ReturnType<typeof sqliteBytes>) => [["LocalStorage", b.main], ["LocalStorage", b.main]] },
    { name: "duplicate normalized main", entries: (b: ReturnType<typeof sqliteBytes>) => [["LocalStorage", b.main], ["./LocalStorage", b.main]] },
    { name: "noncanonical dot path", entries: (b: ReturnType<typeof sqliteBytes>) => [["./LocalStorage", b.main]] },
    { name: "normalized traversal", entries: (b: ReturnType<typeof sqliteBytes>) => [["inside/../LocalStorage", b.main]] },
    { name: "absolute path", entries: (b: ReturnType<typeof sqliteBytes>) => [["/LocalStorage", b.main]] },
    { name: "parent escape", entries: (b: ReturnType<typeof sqliteBytes>) => [["../LocalStorage", b.main]] },
    { name: "SQLite directory", entries: () => [["LocalStorage", Buffer.alloc(0), "5"]] },
    { name: "root directory in SQLite TAR", entries: (b: ReturnType<typeof sqliteBytes>) => [[".", Buffer.alloc(0), "5"], ["LocalStorage", b.main]] },
    { name: "SQLite symlink", entries: () => [["LocalStorage", Buffer.from("elsewhere"), "2"]] },
  ])("rejects $name without changing live/config or extracting partial archive files", async ({ entries }) => {
    seedProfile("original"); installSqlite(); const before = liveSnapshot();
    const tgz = archive(entries(sqliteBytes()) as Array<[string, Buffer, string?]>);
    const extracted = fs.mkdtempSync(path.join(h.root, "rejected-tar-"));
    expect(() => __syncTestHooks.extractSafeLocalStorageArchive(tgz, extracted)).toThrow(); expect(fs.readdirSync(extracted)).toEqual([]);
    remoteArchive(tgz); const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" }); assertLiveUnchanged(before);
  });

  it.each(["header", "header checksum", "frame checksum", "salt", "truncated frame", "page size", "page number", "commit size"])("rejects bad WAL %s before live mutation", async (kind) => {
    seedProfile(); installSqlite(sqliteBytes("old")); const before = liveSnapshot(), bytes = sqliteBytes();
    if (kind === "header") bytes.wal[0] ^= 1;
    if (kind === "header checksum") bytes.wal[24] ^= 1;
    if (kind === "frame checksum") bytes.wal[bytes.wal.length - 10] ^= 1;
    if (kind === "salt") bytes.wal[40] ^= 1;
    if (kind === "truncated frame") bytes.wal = bytes.wal.subarray(0, bytes.wal.length - 1);
    if (kind === "page size") bytes.wal.writeUInt32BE(8192, 8);
    if (kind === "page number") bytes.wal.writeUInt32BE(0, 32);
    if (kind === "commit size") bytes.wal.writeUInt32BE(16385, 36);
    remoteArchive(sqliteArchive(bytes)); const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" }); expect(result.message).toMatch(/SQLite.*WAL/);
    expect(h.checkerStarts).toBe(0); assertLiveUnchanged(before);
  });

  it.each(["magic", "page size", "read version", "reserved header", "truncated main"])("rejects bad main %s before native validation", async (kind) => {
    seedProfile(); installSqlite(); const before = liveSnapshot(), bytes = sqliteBytes();
    if (kind === "magic") bytes.main[0] ^= 1;
    if (kind === "page size") bytes.main.writeUInt16BE(1000, 16);
    if (kind === "read version") bytes.main[19] = 0;
    if (kind === "reserved header") bytes.main[72] = 1;
    if (kind === "truncated main") bytes.main = bytes.main.subarray(0, bytes.main.length - 1);
    remoteArchive(sqliteArchive(bytes)); const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" }); expect(h.checkerStarts).toBe(0); assertLiveUnchanged(before);
  });

  it("native quick_check rejects a corrupt btree even when the physical main header passes", async () => {
    seedProfile(); installSqlite(); const before = liveSnapshot(), main = mainOnlyBytes(); main[4096] = 0xff;
    expect(() => validateSqliteLocalStorageGroup(main)).not.toThrow(); remoteArchive(archive([["LocalStorage", main]]));
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" }); expect(result.message).toMatch(/integrity\/schema/); expect(h.checkerStarts).toBe(1); assertLiveUnchanged(before);
  });

  it.each(["CREATE VIEW foreign_view AS SELECT load_extension('never-run-this');", "CREATE TRIGGER foreign_trigger AFTER INSERT ON business_storage BEGIN DELETE FROM business_storage; END;"])("observes but never executes unsupported schema %s", async (sql) => {
    seedProfile(); installSqlite(); const before = liveSnapshot(); remoteArchive(archive([["LocalStorage", mainOnlyBytes(sql)]]));
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" }); expect(result.message).toMatch(/integrity\/schema/); assertLiveUnchanged(before);
  });

  it.each([
    "CREATE TABLE constrained(value TEXT CHECK(length(value)<100));",
    "CREATE TABLE derived(input TEXT, generated TEXT AS (lower(input)));",
    "CREATE INDEX expression_index ON business_storage(lower(value));",
  ])("refuses schema expressions rather than evaluating external CHECK/generated/index SQL: %s", async (sql) => {
    seedProfile(); installSqlite(); const before = liveSnapshot(); remoteArchive(archive([["LocalStorage", mainOnlyBytes(sql)]]));
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" }); expect(result.message).toMatch(/integrity\/schema/); assertLiveUnchanged(before);
  });

  it.each(["sqlite-to-leveldb", "leveldb-to-sqlite"])("rejects unsupported cross-format %s before any live mutation", async (direction) => {
    seedProfile();
    if (direction === "sqlite-to-leveldb") installSqlite();
    else {
      const legacy = path.join(defaultDir(), "Local Storage", "leveldb"); fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, "CURRENT"), "MANIFEST-000001\n"); fs.writeFileSync(path.join(legacy, "MANIFEST-000001"), "original legacy bytes");
    }
    const before = liveSnapshot(); remoteArchive(direction === "sqlite-to-leveldb" ? legacyArchive() : sqliteArchive());
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" }); expect(result.message).toMatch(/Cross-format/); assertLiveUnchanged(before);
    if (direction === "leveldb-to-sqlite") expect(fs.readFileSync(path.join(defaultDir(), "Local Storage", "leveldb", "MANIFEST-000001"), "utf8")).toBe("original legacy bytes");
  });

  it.each(["push source", "pull target"])("refuses nonempty rollback journal at %s and preserves every old byte", async (role) => {
    seedProfile(); installSqlite(sqliteBytes("journal protected old value"));
    const journal = Buffer.alloc(512); Buffer.from("d9d505f920a163d7", "hex").copy(journal); journal.writeUInt32BE(1, 8);
    fs.writeFileSync(dbPath() + "-journal", journal); const before = liveSnapshot();
    remoteArchive(sqliteArchive()); const oldRemote = Buffer.from(h.objects.get(MAIN)!);
    const result = role === "push source" ? await syncService.push(undefined, true) : await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none", remoteCommit: "none" }); expect(result.message).toMatch(/rollback journal/);
    assertLiveUnchanged(before); expect(h.objects.get(MAIN)).toEqual(oldRemote); expect(h.requests.filter((request) => request.method === "PUT")).toEqual([]);
    expect(backupRoots()).toEqual([]);
  });

  it("source orphan WAL is failed, never absent/published", async () => {
    seedProfile(); const bytes = sqliteBytes(); fs.writeFileSync(dbPath() + "-wal", bytes.wal); const before = liveSnapshot();
    const result = await syncService.push(undefined, true);
    expect(result).toMatchObject({ success: false, remoteCommit: "none", localCommit: "none" }); expect(result.message).toMatch(/Orphan/);
    expect(h.requests.filter((request) => request.method === "PUT")).toEqual([]); assertLiveUnchanged(before);
  });

  it("source mixed SQLite/LevelDB is refused instead of selecting one and losing the other", async () => {
    seedProfile(); installSqlite(); fs.mkdirSync(path.join(defaultDir(), "Local Storage", "leveldb"), { recursive: true }); const before = liveSnapshot();
    const result = await syncService.push(undefined, true); expect(result.success).toBe(false); expect(result.message).toMatch(/Mixed/); assertLiveUnchanged(before);
  });

  it.each(["LocalStorage", "LocalStorage-wal", "Default"])("refuses source %s symlink without reading its target", async (name) => {
    seedProfile(); const bytes = installSqlite();
    const outsideDirectory = fs.mkdtempSync(path.join(h.root, "owned-symlink-target-"));
    const outside = name === "Default" ? outsideDirectory : path.join(outsideDirectory, "file");
    if (name === "Default") {
      fs.writeFileSync(path.join(outside, "LocalStorage"), bytes.main); fs.writeFileSync(path.join(outside, "LocalStorage-wal"), bytes.wal);
      fs.rmSync(defaultDir(), { recursive: true }); fs.symlinkSync(outside, defaultDir());
    } else {
      fs.writeFileSync(outside, name.endsWith("-wal") ? bytes.wal : bytes.main); fs.unlinkSync(path.join(defaultDir(), name)); fs.symlinkSync(outside, path.join(defaultDir(), name));
    }
    h.reads = []; const result = await syncService.push(undefined, true); expect(result.success).toBe(false);
    expect(h.reads.some((file) => file === outside || file.startsWith(outside + path.sep))).toBe(false); expect(h.checkerStarts).toBe(0);
  });

  it("detects complete source group mutation while main is read, without publishing a mixed snapshot", async () => {
    seedProfile(); installSqlite(); let injected = false;
    h.fault = (op, file) => {
      if (!injected && op === "read" && file === dbPath()) {
        injected = true; const wal = fs.readFileSync(dbPath() + "-wal"); wal[wal.length - 1] ^= 1; fs.writeFileSync(dbPath() + "-wal", wal);
      }
    };
    const result = await syncService.push(undefined, true); expect(injected).toBe(true); expect(result.success).toBe(false);
    expect(result.message).toMatch(/changed/); expect(h.requests.filter((request) => request.method === "PUT")).toEqual([]);
  });

  it("rechecks source WAL presence after native validation before publishing", async () => {
    seedProfile(); installSqlite(); let injected = false;
    h.checkerHook = (worker) => worker.once("message", () => { if (!injected) { injected = true; fs.unlinkSync(dbPath() + "-wal"); } });
    const result = await syncService.push(undefined, true); expect(injected).toBe(true); expect(result.success).toBe(false);
    expect(result.message).toMatch(/changed/); expect(h.requests.filter((request) => request.method === "PUT")).toEqual([]);
  });

  it("rechecks prepared bytes after native validation before any live write", async () => {
    seedProfile(); installSqlite(sqliteBytes("old")); const before = liveSnapshot(); remoteArchive(sqliteArchive());
    h.checkerHook = (worker, options) => worker.once("message", () => {
      const main = path.join(path.dirname(path.dirname(options.workerData.file)), "LocalStorage");
      const bytes = fs.readFileSync(main); bytes[100] ^= 1; fs.writeFileSync(main, bytes);
    });
    const result = await syncService.pull(undefined, { strategy: "remote" }); expect(result).toMatchObject({ success: false, localCommit: "none" }); assertLiveUnchanged(before);
  });

  it("enforces remaining aggregate TAR bytes and SQLite page/byte limits before native work", () => {
    const bytes = sqliteBytes(); const output = fs.mkdtempSync(path.join(h.root, "budget-"));
    expect(() => __syncTestHooks.extractSafeLocalStorageArchive(sqliteArchive(bytes), output, bytes.main.length + bytes.wal.length - 1)).toThrow(/budget/);
    expect(fs.readdirSync(output)).toEqual([]); const main = Buffer.from(bytes.main); main.writeUInt32BE(16385, 28);
    expect(() => validateSqliteLocalStorageGroup(main, bytes.wal)).toThrow(/limit/);
    expect(MAX_SQLITE_LOCAL_STORAGE_BYTES).toBe(64 * 1024 * 1024);
    expect(() => validateSqliteLocalStorageGroup(bytes.main, Buffer.alloc(MAX_SQLITE_LOCAL_STORAGE_BYTES))).toThrow(/byte limit/);
    expect(h.checkerStarts).toBe(0);
  });
});

describe("SQLite multi-file publication compensation and durable recovery", () => {
  it.each(["first backup", "second backup", "second publication"])("compensates an injected %s failure without losing old values" + directoryCase, async (point) => {
    seedProfile(); installSqlite(sqliteBytes("original transaction value"), true); const before = liveSnapshot(), incoming = sqliteBytes(); remoteArchive(sqliteArchive(incoming)); let hits = 0;
    h.fault = (op, from, to) => {
      const hit = point === "first backup" ? op === "rename" && from === dbPath() && to?.includes(`${path.sep}old${path.sep}`)
        : point === "second backup" ? op === "rename" && from === dbPath() + "-wal" && to?.includes(`${path.sep}old${path.sep}`)
        : op === "link" && from.includes(`${path.sep}new${path.sep}`) && to === dbPath() + "-wal";
      if (hit) { hits++; throw Object.assign(new Error("injected SQLite publication failure"), { code: "EIO" }); }
    };
    const attempt = await observeSqlitePull(incoming), result = attempt.result; h.fault = null;
    if (await assertConservationIfDirectoryRefused(attempt, "original transaction value", { [point]: hits })) return;
    expect(hits).toBe(1); expect(result).toMatchObject({ success: false, localCommit: "none", outcome: "failed" });
    assertLiveUnchanged(before); expect(backupRoots()).toEqual([]); assertBusiness(dbPath(), "original transaction value");
  });

  it("preserves a concurrent target WAL edit between the first guard and backup moves" + directoryCase, async () => {
    seedProfile(); installSqlite(sqliteBytes("original before edit")); const config = fs.readFileSync(getConfigPath()), edited = sqliteBytes("late target owner value"), incoming = sqliteBytes(); remoteArchive(sqliteArchive(incoming)); let injected = false;
    h.fault = (op, from, to) => {
      if (!injected && op === "rename" && from === dbPath() && to?.includes(`${path.sep}old${path.sep}`)) {
        injected = true; fs.writeFileSync(dbPath() + "-wal", edited.wal);
      }
    };
    const attempt = await observeSqlitePull(incoming), result = attempt.result; h.fault = null;
    if (await assertConservationIfDirectoryRefused(attempt, "original before edit", { "concurrent WAL edit": Number(injected) })) return;
    expect(injected).toBe(true); expect(result).toMatchObject({ success: false, localCommit: "none", outcome: "failed" });
    expect(fs.readFileSync(dbPath() + "-wal")).toEqual(edited.wal); expect(fs.readFileSync(getConfigPath())).toEqual(config);
    assertBusiness(dbPath(), "late target owner value"); expect(backupRoots()).toEqual([]);
  });

  it("retains unique old/new bytes and durable per-file recovery mapping when publication and compensation fail" + directoryCase, async () => {
    seedProfile(); const old = installSqlite(sqliteBytes("unique old business"), true), incoming = sqliteBytes(); remoteArchive(sqliteArchive(incoming));
    let publishHits = 0, restoreHits = 0;
    h.fault = (op, from, to) => {
      if (op === "link" && to === dbPath() + "-wal" && from.includes(`${path.sep}new${path.sep}`)) { publishHits++; throw new Error("injected WAL publish fault"); }
      if (op === "link" && to === dbPath() && from.includes(`${path.sep}old${path.sep}`)) { restoreHits++; throw new Error("injected main restore fault"); }
    };
    const attempt = await observeSqlitePull(incoming), result = attempt.result; h.fault = null;
    if (await assertConservationIfDirectoryRefused(attempt, "unique old business", { "WAL publication": publishHits, "main compensation": restoreHits })) return;
    expect(publishHits).toBe(1); expect(restoreHits).toBe(1); expect(result).toMatchObject({ success: false, outcome: "recovery-required", localCommit: "partial", code: "LOCAL_STORAGE_RECOVERY_REQUIRED" });
    const roots = backupRoots(); expect(roots).toHaveLength(1); const root = roots[0];
    expect(fs.readFileSync(path.join(root, "old", "LocalStorage"))).toEqual(old.main);
    expect(fs.readFileSync(dbPath() + "-wal")).toEqual(old.wal);
    expect(fs.readFileSync(path.join(root, "new", "LocalStorage"))).toEqual(incoming.main);
    expect(fs.readFileSync(path.join(root, "new", "LocalStorage-wal"))).toEqual(incoming.wal);
    const receipt = result.recovery?.find((entry) => entry.resource === "localStorage")?.receiptPath;
    expect(receipt).toBeTypeOf("string"); const disk = JSON.parse(fs.readFileSync(receipt!, "utf8"));
    expect(disk).toMatchObject({ state: "recovery-required", format: "sqlite", transaction: root });
    expect(disk.old.find((entry: any) => entry.name === "LocalStorage").hash).toBe(sha(old.main));
    expect(disk.incoming.find((entry: any) => entry.name === "LocalStorage-wal").hash).toBe(sha(incoming.wal));
    expect(fs.existsSync(path.join(root, "pending.json"))).toBe(true); expect(fs.existsSync(path.join(root, "recovery-required.json"))).toBe(true);
    const protectedBytes = [path.join(root, "old", "LocalStorage"), path.join(root, "new", "LocalStorage"), path.join(root, "new", "LocalStorage-wal"), dbPath() + "-wal"].map((file) => [file, sha(fs.readFileSync(file))]);
    const retry = await syncService.pull(undefined, { strategy: "remote" }); expect(retry.outcome).toBe("recovery-required");
    fs.unlinkSync(receipt!); // owned fault simulation: pending transaction must independently block overwrite
    const noReceiptRetry = await syncService.pull(undefined, { strategy: "remote" }); expect(noReceiptRetry.outcome).toBe("recovery-required");
    for (const [file, hash] of protectedBytes) expect(sha(fs.readFileSync(file))).toBe(hash);
    const rescued = fs.mkdtempSync(path.join(h.root, "reconstruct-old-"));
    fs.copyFileSync(path.join(root, "old", "LocalStorage"), path.join(rescued, "LocalStorage")); fs.copyFileSync(dbPath() + "-wal", path.join(rescued, "LocalStorage-wal"));
    assertBusiness(path.join(rescued, "LocalStorage"), "unique old business");
  });

  it("never overwrites a target created between backup and new publication" + directoryCase, async () => {
    seedProfile(); installSqlite(sqliteBytes("rescued old")); const incoming = sqliteBytes(); remoteArchive(sqliteArchive(incoming)); let planted = false;
    h.fault = (op, from, to) => {
      if (!planted && op === "link" && from.includes(`${path.sep}new${path.sep}`) && to === dbPath()) { planted = true; fs.writeFileSync(dbPath(), "new unrelated owner"); }
    };
    const attempt = await observeSqlitePull(incoming), result = attempt.result; h.fault = null;
    if (await assertConservationIfDirectoryRefused(attempt, "rescued old", { "concurrent target creation": Number(planted) })) return;
    expect(planted).toBe(true); expect(result.outcome).toBe("recovery-required"); expect(fs.readFileSync(dbPath(), "utf8")).toBe("new unrelated owner");
    // WAL compensation succeeded while main compensation was correctly refused
    // by the new owner's file: reconstruct the preserved split old group.
    const root = backupRoots()[0], rescued = fs.mkdtempSync(path.join(h.root, "split-rescue-"));
    fs.copyFileSync(path.join(root, "old", "LocalStorage"), path.join(rescued, "LocalStorage"));
    fs.copyFileSync(dbPath() + "-wal", path.join(rescued, "LocalStorage-wal"));
    assertBusiness(path.join(rescued, "LocalStorage"), "rescued old");
  });
});

describe("SQLite checker abort/deadline retain owner until actual worker exit", () => {
  it.each(["abort", "deadline"])("does not release capture lock/stage early on %s", async (mode) => {
    seedProfile(); installSqlite(); const controller = new AbortController(); let worker: any, options: any;
    let exit!: () => void; let terminate!: ReturnType<typeof vi.fn>;
    h.checkerFactory = (_source, opts) => {
      options = opts; worker = new EventEmitter();
      terminate = vi.fn(() => new Promise<number>((resolve) => { exit = () => { worker.emit("exit", 1); resolve(1); }; }));
      worker.terminate = terminate; return worker;
    };
    vi.useFakeTimers(); let settled = false;
    const pending = syncService.push(controller.signal, true).then((value) => { settled = true; return value; }, (error) => { settled = true; throw error; });
    const observed = pending.catch((error) => error);
    try {
      for (let i = 0; i < 50 && !worker; i++) await vi.advanceTimersByTimeAsync(0);
      expect(worker).toBeDefined(); expect(isRestoreLocked(ID)).toBe(true); expect(fs.existsSync(options.workerData.file)).toBe(true);
      expect(options.resourceLimits).toMatchObject({ maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 });
      if (mode === "abort") controller.abort(); else await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0); expect(terminate).toHaveBeenCalledOnce(); expect(settled).toBe(false);
      expect(isRestoreLocked(ID)).toBe(true); expect(getSyncOperationState().active).not.toBeNull(); expect(fs.existsSync(options.workerData.file)).toBe(true);
      exit(); const result = await observed; expect(settled).toBe(true); expect(isRestoreLocked(ID)).toBe(false);
      expect(fs.existsSync(options.workerData.file)).toBe(false); expect(h.requests.filter((request) => request.method === "PUT")).toEqual([]);
      if (mode === "deadline") expect(result).toMatchObject({ success: false, localCommit: "none", remoteCommit: "none" });
    } finally { if (exit && !settled) exit(); await observed; vi.useRealTimers(); }
  });
});
