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

const h = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-sqlite-owned-")));
  const owner = fs.lstatSync(root);
  return { root, ownerDev: owner.dev, ownerIno: owner.ino, appData: path.join(root, "device"),
    objects: new Map<string, Buffer>(), requests: [] as Array<{ method: string; url: string }>,
    running: new Set<string>(), fault: null as null | ((op: string, from: string, to?: string) => void),
    reads: [] as string[], fds: new Map<number, string>(), snapshot: vi.fn(),
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
  return { ...actual,
    openSync: (file: any, flags: any, mode?: any) => {
      h.fault?.("open", String(file));
      const fd = actual.openSync(file, flags, mode); h.fds.set(fd, String(file)); return fd;
    },
    closeSync: (fd: number) => { h.fds.delete(fd); return actual.closeSync(fd); },
    readSync: (fd: number, ...args: any[]) => {
      const file = h.fds.get(fd) || ""; h.reads.push(file);
      const n = (actual.readSync as any)(fd, ...args); h.fault?.("read", file); return n;
    },
    renameSync: (from: any, to: any) => { h.fault?.("rename", String(from), String(to)); return actual.renameSync(from, to); },
    linkSync: (from: any, to: any) => { h.fault?.("link", String(from), String(to)); return actual.linkSync(from, to); },
    unlinkSync: (file: any) => { h.fault?.("unlink", String(file)); return actual.unlinkSync(file); },
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

beforeEach(() => {
  h.fault = null; h.reads = []; h.running.clear(); h.objects.clear(); h.requests = [];
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
afterEach(() => { h.fault = null; expect(isRestoreLocked(ID)).toBe(false); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => { assertOwner(); fs.rmSync(h.root, { recursive: true }); });

describe("SQLite LocalStorage actual sync data flow", () => {
  it("captures/publishes main+WAL (not SHM), pulls fresh, directly reads the WAL-only row, integrity checks and reloads", async () => {
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
    resetDevice("sqlite-fresh-receiver"); const pulled = await syncService.pull(undefined, { strategy: "remote" });
    expect(pulled.success, pulled.message).toBe(true); expect(pulled.items).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "localStorage", id: ID, state: "applied" })]));
    expect(fs.existsSync(path.join(defaultDir(), "Local Storage", "leveldb"))).toBe(false);
    assertBusiness(dbPath()); reloadConfig(); expect(getProfileMeta(ID)?.name).toBe("SQLite source"); assertBusiness(dbPath());
    expect(h.objects.get(MAIN)).toEqual(Buffer.from(JSON.stringify(document)));
  });

  it("prepares and publishes a main+WAL archive at Default, not the legacy directory", async () => {
    remoteArchive(sqliteArchive()); const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success, result.message).toBe(true); assertBusiness(dbPath());
    expect(fs.existsSync(path.join(defaultDir(), "Local Storage", "leveldb"))).toBe(false);
  });

  it("retains the accepted legacy LevelDB TAR contract", async () => {
    remoteArchive(legacyArchive()); const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success, result.message).toBe(true);
    expect(fs.readFileSync(path.join(defaultDir(), "Local Storage", "leveldb", "CURRENT"), "utf8")).toBe("MANIFEST-000001\n");
  });

  it("treats the observed Chromium maps/map_entries/meta schema as opaque data without requiring test-table names", async () => {
    seedProfile(); const generator = fs.mkdtempSync(path.join(h.root, "observed-schema-")), file = path.join(generator, "LocalStorage");
    const db = new DatabaseSync(file); let bytes: ReturnType<typeof sqliteBytes>;
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE map_entries(map_id INTEGER NOT NULL,value_compression_type INTEGER NOT NULL,key BLOB NOT NULL,value BLOB NOT NULL,PRIMARY KEY(map_id,key)); CREATE TABLE maps(row_id INTEGER PRIMARY KEY,storage_key BLOB NOT NULL,last_accessed INTEGER,last_modified INTEGER,total_size INTEGER); CREATE TABLE meta(key LONGVARCHAR PRIMARY KEY NOT NULL,value LONGVARCHAR);");
      db.prepare("INSERT INTO maps VALUES(?,?,?,?,?)").run(1, Buffer.from(ORIGIN), 1, 1, VALUE.length);
      db.prepare("INSERT INTO map_entries VALUES(?,?,?,?)").run(1, 0, Buffer.from("acceptance_order"), Buffer.from(VALUE));
      bytes = { main: fs.readFileSync(file), wal: fs.readFileSync(file + "-wal") };
    } finally { db.close(); fs.rmSync(generator, { recursive: true }); }
    installSqlite(bytes!); const push = await syncService.push(undefined, true); expect(push.success, push.message).toBe(true);
    resetDevice("observed-schema-receiver"); const pull = await syncService.pull(undefined, { strategy: "remote" }); expect(pull.success, pull.message).toBe(true);
    const reader = new DatabaseSync(dbPath(), { readOnly: true });
    try {
      const row = reader.prepare("SELECT key,value FROM map_entries WHERE map_id=1").get() as any;
      expect(Buffer.from(row.key).toString("utf8")).toBe("acceptance_order"); expect(Buffer.from(row.value).toString("utf8")).toBe(VALUE);
      expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { reader.close(); }
    // Blob encoding/compression here is synthetic, not a claim that Chromium
    // has interpreted it. That semantic claim belongs to the real browser gate.
  });

  it("replaces old main/WAL/SHM with an empty valid main-only database without reviving old WAL rows", async () => {
    seedProfile("old target"); const old = installSqlite(sqliteBytes("old-WAL-business-row"), true);
    const shmHash = sha(fs.readFileSync(dbPath() + "-shm"));
    remoteArchive(archive([["LocalStorage", mainOnlyBytes()]]));
    const result = await syncService.pull(undefined, { strategy: "remote" }); expect(result.success, result.message).toBe(true);
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

  it("replaces existing SQLite with a committed WAL-only row and retains a directly readable previous copy", async () => {
    seedProfile(); installSqlite(sqliteBytes("previous-business")); remoteArchive(sqliteArchive());
    const result = await syncService.pull(undefined, { strategy: "remote" }); expect(result.success, result.message).toBe(true);
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

  it("preserves an explicit reset zero-byte WAL and ignores only a proven empty source journal", async () => {
    seedProfile(); const main = mainOnlyBytes(); fs.writeFileSync(dbPath(), main); fs.writeFileSync(dbPath() + "-wal", Buffer.alloc(0)); fs.writeFileSync(dbPath() + "-journal", Buffer.alloc(0));
    const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
    const extracted = fs.mkdtempSync(path.join(h.root, "empty-wal-")); __syncTestHooks.extractSafeLocalStorageArchive(Buffer.from(payload().localStorage[ID], "base64"), extracted);
    expect(fs.readdirSync(extracted).sort()).toEqual(["LocalStorage", "LocalStorage-wal"]); expect(fs.statSync(path.join(extracted, "LocalStorage-wal")).size).toBe(0);
    resetDevice("empty-wal-receiver"); const pulled = await syncService.pull(undefined, { strategy: "remote" }); expect(pulled.success, pulled.message).toBe(true);
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS n FROM business_storage").get()).toEqual({ n: 0 }); } finally { db.close(); }
  });

  it("moves an old empty rollback journal into backup rather than leaving it beside a replacement main", async () => {
    seedProfile(); installSqlite(sqliteBytes("old with empty journal")); fs.writeFileSync(dbPath() + "-journal", Buffer.alloc(0)); remoteArchive(sqliteArchive());
    const result = await syncService.pull(undefined, { strategy: "remote" }); expect(result.success, result.message).toBe(true);
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
  it.each(["first backup", "second backup", "second publication"])("compensates an injected %s failure without losing old values", async (point) => {
    seedProfile(); installSqlite(sqliteBytes("original transaction value"), true); const before = liveSnapshot(); remoteArchive(sqliteArchive()); let hits = 0;
    h.fault = (op, from, to) => {
      const hit = point === "first backup" ? op === "rename" && from === dbPath() && to?.includes("/old/")
        : point === "second backup" ? op === "rename" && from === dbPath() + "-wal" && to?.includes("/old/")
        : op === "link" && from.includes("/new/") && to === dbPath() + "-wal";
      if (hit) { hits++; throw Object.assign(new Error("injected SQLite publication failure"), { code: "EIO" }); }
    };
    const result = await syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
    expect(hits).toBe(1); expect(result).toMatchObject({ success: false, localCommit: "none", outcome: "failed" });
    assertLiveUnchanged(before); expect(backupRoots()).toEqual([]); assertBusiness(dbPath(), "original transaction value");
  });

  it("preserves a concurrent target WAL edit between the first guard and backup moves", async () => {
    seedProfile(); installSqlite(sqliteBytes("original before edit")); const config = fs.readFileSync(getConfigPath()), edited = sqliteBytes("late target owner value"); remoteArchive(sqliteArchive()); let injected = false;
    h.fault = (op, from, to) => {
      if (!injected && op === "rename" && from === dbPath() && to?.includes("/old/")) {
        injected = true; fs.writeFileSync(dbPath() + "-wal", edited.wal);
      }
    };
    const result = await syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
    expect(injected).toBe(true); expect(result).toMatchObject({ success: false, localCommit: "none", outcome: "failed" });
    expect(fs.readFileSync(dbPath() + "-wal")).toEqual(edited.wal); expect(fs.readFileSync(getConfigPath())).toEqual(config);
    assertBusiness(dbPath(), "late target owner value"); expect(backupRoots()).toEqual([]);
  });

  it("retains unique old/new bytes and durable per-file recovery mapping when publication and compensation fail", async () => {
    seedProfile(); const old = installSqlite(sqliteBytes("unique old business"), true), incoming = sqliteBytes(); remoteArchive(sqliteArchive(incoming));
    let publishHits = 0, restoreHits = 0;
    h.fault = (op, from, to) => {
      if (op === "link" && to === dbPath() + "-wal" && from.includes("/new/")) { publishHits++; throw new Error("injected WAL publish fault"); }
      if (op === "link" && to === dbPath() && from.includes("/old/")) { restoreHits++; throw new Error("injected main restore fault"); }
    };
    const result = await syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
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

  it("never overwrites a target created between backup and new publication", async () => {
    seedProfile(); installSqlite(sqliteBytes("rescued old")); remoteArchive(sqliteArchive()); let planted = false;
    h.fault = (op, from, to) => {
      if (!planted && op === "link" && from.includes("/new/") && to === dbPath()) { planted = true; fs.writeFileSync(dbPath(), "new unrelated owner"); }
    };
    const result = await syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
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
