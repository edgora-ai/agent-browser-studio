// Production SyncService, real loopback PUT+GET, isolated synthetic SQLite only.
// No browser, real user profile, cloud, Cookie/vault or credential reads.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as zlib from "node:zlib";
import * as vm from "node:vm";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const h = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-history-owned-")));
  const owner = fs.lstatSync(root);
  return { root, owner, device: path.join(root, "device"), running: new Set<string>(), unknownRunning: false,
    oversizedPath: "", cookieHook: null as null | (() => void | Promise<void>), checkerFactory: null as null | ((source: string, options: any) => any),
    fault: null as null | ((op: string, from: string, to?: string) => void) };
});
vi.mock("electron", () => ({ app: { getPath: (name: string) => name === "home" ? path.join(h.root, "home") : h.device },
  safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: (id: string) => {
  if (h.unknownRunning) throw new Error("Synthetic runtime ownership unavailable");
  return { running: h.running.has(id), pid: null, cdpPort: null };
} }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ runtimeCookieOps: {
  hasRunningBrowser: (id: string) => h.running.has(id), exportCookiesSnapshot: async () => { await h.cookieHook?.(); return { state: "available", cookies: [] }; },
  importCookies: async () => 0,
} }));
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return { ...actual, Worker: function(source: string, options: any) { return h.checkerFactory ? h.checkerFactory(source, options) : new actual.Worker(source, options); } };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    lstatSync: (file: any, ...args: any[]) => {
      const stat = (actual.lstatSync as any)(file, ...args);
      if (stat && String(file) === h.oversizedPath) return Object.defineProperty(Object.create(stat), "size", { value: 64 * 1024 * 1024 + 1 });
      return stat;
    },
    openSync: (file: any, flags: any, mode?: any) => { h.fault?.("open", String(file)); return actual.openSync(file, flags, mode); },
    renameSync: (from: any, to: any) => { h.fault?.("rename", String(from), String(to)); return actual.renameSync(from, to); },
    linkSync: (from: any, to: any) => { h.fault?.("link", String(from), String(to)); return actual.linkSync(from, to); },
  };
});

import { syncService } from "../../src/main/services/sync-service.js";
import { getConfig, getConfigPath, getProfilesDir, reloadConfig, saveConfig, setSyncConfig } from "../../src/main/services/config-manager.js";
import { readZipEntries, extractZipEntry } from "../../src/main/services/zip-writer.js";
import { isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";
import { MAX_HISTORY_BYTES } from "../../src/main/services/sync/sqlite-history.js";
import { syncMayRetryAutomatically } from "../../src/main/services/sync/operation-result.js";

const ID = "ab_history_transport", CONFIG_KEY = "agent-browser-studio-config.json", BUCKET = "history-fixture";
const URL_SENTINEL = "https://wal-only.synthetic.invalid/unique-history";
const TITLE = "WAL-only historical title 中文";
const EXACT_ID = 9007199254741009n, EXACT_TIME = 132987654321012345n;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Engine = "chromium" | "firefox";
const relative = (engine: Engine) => engine === "firefox" ? "places.sqlite" : "Default/History";
const livePath = (engine: Engine) => path.join(getProfilesDir(), ID, relative(engine));

// Same finite S3 fixture contract as the existing acceptance loopbackFixture:
// dynamic loopback only, exact retained PUT bytes, actual GET readback and limits.
async function loopbackFixture() {
  const objects = new Map<string, Buffer>(), journal: Array<{ method: string; key: string; sha256: string }> = [];
  let onPut: null | ((key: string, bytes: Buffer) => number | void) = null;
  let onGet: null | ((key: string, bytes?: Buffer) => Buffer | number | void) = null;
  const server = http.createServer((req, res) => { void (async () => {
    const key = decodeURIComponent((req.url || "").replace(`/${BUCKET}/`, ""));
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) { res.writeHead(404); res.end(); return; }
    if (req.method === "PUT") {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("Owned fixture byte budget"); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks), status = onPut?.(key, bytes);
      journal.push({ method: "PUT", key, sha256: sha(bytes) });
      if (status) { res.writeHead(status); res.end("Synthetic rejection"); return; }
      objects.set(key, bytes); res.writeHead(200); res.end(); return;
    }
    const stored = objects.get(key), result = onGet?.(key, stored);
    if (typeof result === "number") { res.writeHead(result); res.end(); return; }
    const bytes = Buffer.isBuffer(result) ? result : stored;
    if (!bytes) { res.writeHead(404); res.end("NoSuchKey"); return; }
    journal.push({ method: "GET", key, sha256: sha(bytes) });
    res.writeHead(200, { "content-length": String(bytes.length) }); res.end(bytes);
  })().catch((error) => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return { objects, journal, endpoint: `http://127.0.0.1:${address.port}`,
    putHook: (fn: typeof onPut) => { onPut = fn; }, getHook: (fn: typeof onGet) => { onGet = fn; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
let fixture: Awaited<ReturnType<typeof loopbackFixture>>;
function owner(): void {
  const stat = fs.lstatSync(h.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== h.owner.dev || stat.ino !== h.owner.ino) throw new Error("History fixture owner changed");
}
function resetDevice(name: string): void {
  owner(); if (fs.existsSync(h.device)) fs.rmSync(h.device, { recursive: true });
  fs.mkdirSync(h.device); reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.deviceId = name; cfg.browserProfiles = {}; cfg.proxies = {}; cfg.accounts = []; cfg.extensionRepository = {};
  cfg.sync = { enabled: true, endpoint: fixture.endpoint, bucket: BUCKET, accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: 1 };
  saveConfig(cfg);
  // Separate, explicit consent; never use a forged public consent timestamp.
  setSyncConfig({ historyConsent: true, includeHistory: true } as any);
  expect(getConfigPath()).toBe(path.join(h.device, "config.json"));
}
function seedProfile(engine: Engine): void {
  const cfg = structuredClone(getConfig());
  cfg.browserProfiles[ID] = { name: "Synthetic history", engine, fingerprintSeed: 42, updatedAt: 100 };
  saveConfig(cfg); fs.mkdirSync(path.dirname(livePath(engine)), { recursive: true });
}
function sqliteBytes(engine: Engine, empty = false): { main: Buffer; wal: Buffer } {
  const directory = fs.mkdtempSync(path.join(h.root, "generator-")), file = path.join(directory, "db");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    if (engine === "chromium") {
      db.exec("CREATE TABLE meta(key LONGVARCHAR PRIMARY KEY NOT NULL,value LONGVARCHAR); INSERT INTO meta VALUES('version','67'),('last_compatible_version','16'); CREATE TABLE urls(id INTEGER PRIMARY KEY,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER,typed_count INTEGER,last_visit_time INTEGER,hidden INTEGER); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER,from_visit INTEGER,transition INTEGER,visit_duration INTEGER);");
    } else {
      db.exec("PRAGMA user_version=86; CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER,last_visit_date INTEGER,frecency INTEGER); CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY,from_visit INTEGER,place_id INTEGER,visit_date INTEGER,visit_type INTEGER); CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,type INTEGER,fk INTEGER,parent INTEGER,position INTEGER,title LONGVARCHAR,dateAdded INTEGER,lastModified INTEGER,guid TEXT); CREATE INDEX moz_places_urlindex ON moz_places(url);");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const insert = (sql: string, ...values: Array<string | bigint>) => { const query = db.prepare(sql); query.setReadBigInts(true); query.run(...values); };
    if (!empty && engine === "chromium") {
      insert("INSERT INTO urls VALUES(?,?,?,?,?,?,?)", EXACT_ID, URL_SENTINEL, TITLE, 1n, 0n, EXACT_TIME, 0n);
      insert("INSERT INTO visits VALUES(?,?,?,?,?,?)", EXACT_ID + 1n, EXACT_ID, EXACT_TIME, 0n, 805306368n, 0n);
    } else if (!empty) {
      insert("INSERT INTO moz_places VALUES(?,?,?,?,?,?)", EXACT_ID, URL_SENTINEL, TITLE, 1n, EXACT_TIME, 0n);
      insert("INSERT INTO moz_historyvisits VALUES(?,?,?,?,?)", EXACT_ID + 1n, 0n, EXACT_ID, EXACT_TIME, 1n);
      insert("INSERT INTO moz_bookmarks VALUES(?,?,?,?,?,?,?,?,?)", EXACT_ID + 2n, 1n, EXACT_ID, 0n, 0n, "Explicitly consented bookmark", EXACT_TIME, EXACT_TIME, "synthetic___");
    }
    return { main: fs.readFileSync(file), wal: fs.readFileSync(file + "-wal") };
  } finally { db.close(); fs.rmSync(directory, { recursive: true }); }
}
function install(engine: Engine, bytes = sqliteBytes(engine)): typeof bytes {
  fs.mkdirSync(path.dirname(livePath(engine)), { recursive: true });
  fs.writeFileSync(livePath(engine), bytes.main); fs.writeFileSync(livePath(engine) + "-wal", bytes.wal);
  fs.writeFileSync(livePath(engine) + "-shm", "synthetic SHM must not travel"); return bytes;
}
function assertRows(file: string, engine: Engine): void {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    const sql = engine === "chromium" ? "SELECT u.id,u.url,u.title,v.visit_time AS time FROM urls u JOIN visits v ON v.url=u.id WHERE u.url=?"
      : "SELECT u.id,u.url,u.title,v.visit_date AS time FROM moz_places u JOIN moz_historyvisits v ON v.place_id=u.id WHERE u.url=?";
    const query = db.prepare(sql); query.setReadBigInts(true);
    expect(query.get(URL_SENTINEL)).toEqual({ id: EXACT_ID, url: URL_SENTINEL, title: TITLE, time: EXACT_TIME });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all().length).toBe(engine === "chromium" ? 3 : 3);
    if (engine === "firefox") { const bookmarks = db.prepare("SELECT fk,title FROM moz_bookmarks WHERE fk=?"); bookmarks.setReadBigInts(true); expect(bookmarks.get(EXACT_ID)).toEqual({ fk: EXACT_ID, title: "Explicitly consented bookmark" }); }
  } finally { db.close(); }
}
const payload = () => JSON.parse(fixture.objects.get(CONFIG_KEY)!.toString("utf8"));

beforeEach(async () => { h.running.clear(); h.unknownRunning = false; h.fault = null; h.oversizedPath = ""; h.cookieHook = null; h.checkerFactory = null; fixture = await loopbackFixture(); resetDevice("sender"); });
afterEach(async () => { h.fault = null; expect(isRestoreLocked(ID)).toBe(false); await fixture.close(); vi.restoreAllMocks(); });
afterAll(() => { owner(); fs.rmSync(h.root, { recursive: true }); });

describe("production history/Places main+WAL transport", () => {
  it.each(["chromium", "firefox"] as const)("publishes %s History/Places WAL bytes before the envelope and restores exact searchable relations", async (engine) => {
    seedProfile(engine); const source = install(engine);
    const controlDirectory = fs.mkdtempSync(path.join(h.root, "main-only-control-")), controlFile = path.join(controlDirectory, "db"); fs.writeFileSync(controlFile, source.main);
    const control = new DatabaseSync(controlFile, { readOnly: true });
    try { expect(control.prepare(`SELECT count(*) AS n FROM ${engine === "chromium" ? "urls" : "moz_places"} WHERE url=?`).get(URL_SENTINEL)).toEqual({ n: 0 }); } finally { control.close(); }
    const pushed = await syncService.push(undefined, true, undefined, { history: true } as any);
    expect(pushed.success, pushed.message).toBe(true);
    expect(pushed.items?.find((item) => item.scope === "profiles" && item.id === ID)?.identity).toMatchObject({ configuration: { state: "retained" }, runtime: { state: "not-verified" } });
    const document = payload();
    expect(document.history?.[ID], "production envelope must cover History/Places, not config-only success").toBeDefined();
    expect(document.artifactVersion).toBe(3);
    const entry = document.history[ID]; expect(entry).toMatchObject({ state: "complete", freshness: "captured", snapshotId: document.snapshotId, dirId: ID, engine });
    const artifact = entry.artifact, bytes = fixture.objects.get(artifact.object.key)!;
    expect(sha(bytes)).toBe(artifact.object.sha256); expect(bytes.length).toBe(artifact.object.bytes);
    const members = readZipEntries(bytes);
    expect(members.map((item) => item.name).sort()).toEqual([relative(engine), relative(engine) + "-wal"].sort());
    const published = fs.mkdtempSync(path.join(h.root, "published-readback-"));
    for (const member of members) {
      const data = extractZipEntry(bytes, member), expected = artifact.members.find((item: any) => item.path === member.name);
      expect(sha(data)).toBe(expected.sha256); expect(data.length).toBe(expected.bytes);
      expect(data).toEqual(member.name.endsWith("-wal") ? source.wal : source.main);
      fs.writeFileSync(path.join(published, path.basename(member.name)), data);
    }
    assertRows(path.join(published, path.basename(relative(engine))), engine);
    const put = fixture.journal.findIndex((item) => item.method === "PUT" && item.key === artifact.object.key);
    const get = fixture.journal.findIndex((item) => item.method === "GET" && item.key === artifact.object.key);
    const envelope = fixture.journal.findIndex((item) => item.method === "PUT" && item.key === CONFIG_KEY);
    expect(put).toBeGreaterThan(-1); expect(get).toBeGreaterThan(put); expect(envelope).toBeGreaterThan(get);
    resetDevice("receiver");
    const pulled = await syncService.pull(undefined, { strategy: "remote", history: true } as any);
    expect(pulled.success, pulled.message).toBe(true); expect(pulled.items).toContainEqual(expect.objectContaining({ scope: "history", id: ID, state: "applied" }));
    expect(pulled.items?.find((item) => item.scope === "profiles" && item.id === ID)?.identity).toMatchObject({ configuration: { state: "retained" }, runtime: { state: "not-verified" } });
    expect(getConfig().browserProfiles[ID].fingerprintSeed).toBe(42);
    // SQLite's independent reader may rebuild SHM; it was never transported.
    expect(fs.existsSync(livePath(engine) + "-shm")).toBe(false);
    assertRows(livePath(engine), engine); reloadConfig(); assertRows(livePath(engine), engine);
    expect(fs.existsSync(path.join(getProfilesDir(), ID, engine === "firefox" ? "Default/places.sqlite" : "History"))).toBe(false);
  });
});

function liveSnapshot(engine: Engine): Record<string, string | null> {
  return Object.fromEntries([getConfigPath(), ...["", "-wal", "-shm", "-journal"].map((suffix) => livePath(engine) + suffix)]
    .map((file) => [file, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null]));
}
async function publish(engine: Engine = "chromium", empty = false) {
  seedProfile(engine); install(engine, sqliteBytes(engine, empty));
  const result = await syncService.push(undefined, true, undefined, { history: true });
  expect(result.success, result.message).toBe(true); return payload();
}
const historyPuts = () => fixture.journal.filter((item) => item.method === "PUT" && item.key.startsWith("history-v1-"));

describe("history scope, coverage and exact publication failures", () => {
  it("does not silently expand existing auto-upload scope or accept forged consent timestamps", async () => {
    setSyncConfig({ includeHistory: false, historyConsent: false }); seedProfile("chromium"); install("chromium");
    expect(() => setSyncConfig({ includeHistory: true, historyConsentAt: 1 })).toThrow(/consent/i);
    const refused = await syncService.push(undefined, false, undefined, { history: true });
    expect(refused).toMatchObject({ success: false, code: "HISTORY_CONSENT_REQUIRED" }); expect(fixture.journal.filter((item) => item.method === "PUT")).toEqual([]);
    h.fault = (op, file) => { if (op === "open" && /^History(?:-wal)?$/.test(path.basename(file))) throw new Error("Unselected history was read"); };
    const result = await syncService.push(); expect(result.success, result.message).toBe(true);
    expect(payload().history[ID]).toMatchObject({ state: "unselected", freshness: "not-covered", code: "HISTORY_NOT_SELECTED" });
    expect(historyPuts()).toEqual([]); expect(getConfig().sync.includeHistory).toBe(false); expect(getConfig().sync.historyConsentAt).toBeNull();
  });

  it("distinguishes confirmed source absence from a complete empty SQLite snapshot", async () => {
    seedProfile("chromium"); const missing = await syncService.push(); expect(missing.success, missing.message).toBe(true);
    expect(payload().history[ID]).toMatchObject({ state: "absent", freshness: "captured" }); expect(historyPuts()).toEqual([]);
    install("chromium", sqliteBytes("chromium", true)); const empty = await syncService.push(); expect(empty.success, empty.message).toBe(true);
    expect(payload().history[ID]).toMatchObject({ state: "empty", freshness: "captured", artifact: { counts: { urls: "0", visits: "0", bookmarks: "0" } } });
    expect(historyPuts()).toHaveLength(1);
  });

  it.each([undefined, 2] as const)("keeps legacy/v2 (%s) un-covered history distinct and never invents a restore", async (version) => {
    const document = await publish(); delete document.history;
    if (version === undefined) { delete document.artifactVersion; delete document.snapshotId; } else document.artifactVersion = version;
    fixture.objects.set(CONFIG_KEY, Buffer.from(JSON.stringify(document))); resetDevice("legacy-receiver");
    const result = await syncService.pull(undefined, { strategy: "remote", history: true });
    expect(result.success, result.message).toBe(true); expect(result.items).toContainEqual(expect.objectContaining({ scope: "history", code: "HISTORY_LEGACY_UNCOVERED", state: "skipped", required: false }));
    expect(fs.existsSync(livePath("chromium"))).toBe(false);
  });

  it.each(["reject", "tamper", "missing"] as const)("does not publish the envelope when actual history object %s prevents GET verification", async (fault) => {
    seedProfile("chromium"); install("chromium");
    fixture.putHook((key) => key.startsWith("history-v1-") && fault === "reject" ? 500 : undefined);
    fixture.getHook((key) => key.startsWith("history-v1-") ? fault === "tamper" ? Buffer.from("tampered actual GET body") : fault === "missing" ? 404 : undefined : undefined);
    const before = fs.readFileSync(getConfigPath()), result = await syncService.push(undefined, true, undefined, { history: true });
    expect(result.success).toBe(false); expect(result.remoteCommit).toBe(fault === "reject" ? "unknown" : "partial");
    expect(syncMayRetryAutomatically(result)).toBe(false);
    expect(fixture.journal.some((item) => item.method === "PUT" && item.key === CONFIG_KEY)).toBe(false);
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
  });

  it.each(["running", "unknown-running", "rollback-journal"] as const)("preserves prior verified object with explicit stale coverage for %s, without claiming a fresh backup", async (fault) => {
    const document = await publish(), original = document.history[ID].artifact.object.key, before = historyPuts().length;
    if (fault === "running") h.running.add(ID);
    if (fault === "unknown-running") h.unknownRunning = true;
    if (fault === "rollback-journal") fs.writeFileSync(livePath("chromium") + "-journal", Buffer.from("nonempty protected journal"));
    h.fault = (op, file) => { if (fault !== "rollback-journal" && op === "open" && [livePath("chromium"), livePath("chromium") + "-wal"].includes(file)) throw new Error("Running/unknown source was read"); };
    const result = await syncService.push(undefined, true, undefined, { history: true });
    expect(result).toMatchObject({ success: false, outcome: "partial", remoteCommit: "committed" });
    expect(payload().history[ID]).toMatchObject({ state: "preserved", freshness: "preserved", code: "HISTORY_CAPTURE_FAILED", artifact: { object: { key: original } } });
    expect(historyPuts()).toHaveLength(before); expect(result.warnings?.join(" ")).toMatch(/not freshly captured/);
  });

  it.each(["symlink", "journal", "unstable", "permission"] as const)("fails %s capture explicitly without publishing fake absent/empty history", async (fault) => {
    seedProfile("chromium"); install("chromium");
    if (fault === "journal") fs.writeFileSync(livePath("chromium") + "-journal", "protected rollback pages");
    if (fault === "symlink") {
      const outside = path.join(h.root, "owned-symlink-sentinel"); fs.writeFileSync(outside, "do not read through link");
      fs.unlinkSync(livePath("chromium")); fs.symlinkSync(outside, livePath("chromium"));
      h.fault = (op, file) => { if (op === "open" && file === outside) throw new Error("Symlink target was read"); };
    }
    if (fault === "permission") h.fault = (op, file) => { if (op === "open" && file === livePath("chromium")) throw Object.assign(new Error("Synthetic history read denied"), { code: "EACCES" }); };
    if (fault === "unstable") {
      let injected = false;
      h.fault = (op, file) => { if (!injected && op === "open" && file === livePath("chromium")) { injected = true; fs.appendFileSync(livePath("chromium") + "-wal", "mutation"); } };
    }
    const result = await syncService.push(undefined, true, undefined, { history: true });
    expect(result).toMatchObject({ success: false, outcome: "partial" }); expect(payload().history[ID]).toMatchObject({ state: "failed", freshness: "not-covered" }); expect(historyPuts()).toEqual([]);
  });
});

function changeHistoryPermission(kind: "consent" | "target" | "role"): void {
  if (kind === "consent") { setSyncConfig({ historyConsent: false }); return; }
  if (kind === "target") { setSyncConfig({ bucket: "changed-history-fixture" }); return; }
  const cfg = structuredClone(getConfig());
  cfg.team = { workspaceId: "synthetic-history-team", name: "Synthetic team", ownerDeviceId: "synthetic-other-owner", createdAt: 1, updatedAt: 1, enabled: true,
    members: [{ deviceId: cfg.deviceId!, name: "Synthetic local", role: "viewer", addedAt: 1 }] };
  saveConfig(cfg);
}
const permissionCode = (kind: string) => kind === "role" ? "TEAM_ROLE_DENIED" : "HISTORY_SCOPE_CHANGED";

describe("in-flight history permission/freshness checkpoints", () => {
  it.each(["present", "absent"] as const)("records actual %s history capture time, not the earlier push-start timestamp", async (presence) => {
    seedProfile("chromium"); if (presence === "present") install("chromium"); let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    h.cookieHook = () => { now = 2500; };
    const result = await syncService.push(undefined, false, undefined, { history: true }); expect(result.success, result.message).toBe(true);
    const coverage = payload().history[ID];
    expect(payload().timestamp).toBe(1000); expect(coverage.artifact?.capturedAt ?? coverage.capturedAt).toBe(2500);
    expect(getConfig().browserProfiles[ID].historySyncBaseline?.timestamp).toBe(2500);
  });
  it.each(["once", "always"] as const)("reports a checker close failure (%s) explicitly and never publishes it as a fresh history snapshot", async (failureMode) => {
    seedProfile("chromium"); install("chromium");
    class CloseFails extends DatabaseSync {
      closed = false;
      close(): void {
        if (!this.closed) { super.close(); this.closed = true; throw new Error("Synthetic close failure"); }
        if (failureMode === "always") throw new Error("Synthetic repeat close failure");
      }
    }
    h.checkerFactory = (source, options) => {
      const worker = new EventEmitter() as EventEmitter & { terminate: () => Promise<number> };
      worker.terminate = async () => { worker.emit("exit", 1); return 1; };
      queueMicrotask(() => {
        try {
          vm.runInNewContext(source, { Buffer, Uint8Array, require: (name: string) => {
            if (name === "node:worker_threads") return { workerData: options.workerData, parentPort: { postMessage: (message: unknown) => worker.emit("message", message), close: () => undefined } };
            if (name === "node:sqlite") return { DatabaseSync: CloseFails };
            if (name === "node:crypto") return { createHash };
            throw new Error("Unexpected trusted checker dependency");
          } });
        } catch (error) { worker.emit("error", error); }
        worker.emit("exit", 0);
      });
      return worker;
    };
    const result = await syncService.push(undefined, false, undefined, { history: true });
    expect(result.success).toBe(false); expect(result.warnings?.join(" ")).toMatch(/SQLite close failed/); expect(payload().history[ID].state).toBe("failed"); expect(historyPuts()).toEqual([]);
  });
  it.each(["consent", "target", "role"] as const)("stops push before any history read/PUT when %s changes across Cookie export await", async (kind) => {
    seedProfile("chromium"); install("chromium"); let reads = 0;
    h.cookieHook = () => changeHistoryPermission(kind);
    h.fault = (op, file) => { if (op === "open" && [livePath("chromium"), livePath("chromium") + "-wal"].includes(file)) reads++; };
    const result = await syncService.push(undefined, false, undefined, { history: true });
    expect(result).toMatchObject({ success: false, code: permissionCode(kind), localCommit: "none", remoteCommit: "none" }); expect(reads).toBe(0); expect(fixture.journal.filter((item) => item.method === "PUT")).toEqual([]);
  });
  describe.each(["consent", "target", "role"] as const)("%s changes across awaited transport/publication", (kind) => {
    it.each(["PUT", "readback"] as const)("stops envelope publication and auto-retry after actual history %s", async (phase) => {
      seedProfile("chromium"); install("chromium");
      fixture.putHook((key) => { if (phase === "PUT" && key.startsWith("history-v1-")) changeHistoryPermission(kind); });
      fixture.getHook((key) => { if (phase === "readback" && key.startsWith("history-v1-")) changeHistoryPermission(kind); });
      const result = await syncService.push(undefined, false, undefined, { history: true });
      expect(result).toMatchObject({ success: false, code: permissionCode(kind), remoteCommit: "partial", localCommit: "none", outcome: "partial" }); expect(syncMayRetryAutomatically(result)).toBe(false);
      expect(historyPuts()).toHaveLength(1); expect(fixture.journal.some((item) => item.method === "PUT" && item.key === CONFIG_KEY)).toBe(false);
      expect(result.items).toContainEqual(expect.objectContaining({ scope: "history", state: phase === "PUT" ? "unknown" : "uploaded", code: phase === "PUT" ? "HISTORY_OBJECT_UNCONFIRMED" : "HISTORY_OBJECT_ONLY" }));
      expect(getConfig().browserProfiles[ID].historySyncBaseline).toBeUndefined();
    });
    it("reports an already-verified remote envelope truthfully but refuses local baseline adoption", async () => {
      seedProfile("chromium"); install("chromium");
      fixture.getHook((key, bytes) => { if (key === CONFIG_KEY && bytes) changeHistoryPermission(kind); });
      const result = await syncService.push(undefined, false, undefined, { history: true });
      expect(result).toMatchObject({ success: false, code: permissionCode(kind), remoteCommit: "committed", localCommit: "none", outcome: "partial" });
      expect(syncMayRetryAutomatically(result)).toBe(false); expect(payload().history[ID].state).toBe("complete");
      expect(getConfig().browserProfiles[ID].historySyncBaseline).toBeUndefined(); expect(getConfig().browserProfiles[ID].syncBaseline).toBeUndefined();
    });
    it.each(["before history GET", "during history GET"] as const)("stops pull %s, before any receiver history write", async (phase) => {
      await publish(); resetDevice("permission-receiver"); seedProfile("chromium"); install("chromium"); const before = liveSnapshot("chromium"), start = fixture.journal.length;
      fixture.getHook((key) => { if (phase === "before history GET" ? key === CONFIG_KEY : key.startsWith("history-v1-")) changeHistoryPermission(kind); });
      const result = await syncService.pull(undefined, { strategy: "remote", history: true });
      expect(result).toMatchObject({ success: false, code: permissionCode(kind), localCommit: "none" });
      expect(fixture.journal.slice(start).filter((item) => item.key.startsWith("history-v1-")).length).toBe(phase === "before history GET" ? 0 : 1);
      for (const [file, hash] of Object.entries(before)) if (file !== getConfigPath()) expect(fs.existsSync(file) ? sha(fs.readFileSync(file)) : null).toBe(hash);
      expect(getConfig().browserProfiles[ID].historySyncBaseline).toBeUndefined();
    });
    it.each(["between main/WAL", "after published receipt"] as const)("compensates exact receiver group when authorization changes %s, before config commit", async (phase) => {
      await publish(); resetDevice("late-permission-receiver"); seedProfile("chromium"); install("chromium", sqliteBytes("chromium", true));
      fs.writeFileSync(livePath("chromium") + "-journal", Buffer.alloc(0)); const before = liveSnapshot("chromium"); let changes = 0;
      h.fault = (op, from, to) => {
        const hit = phase === "between main/WAL" ? op === "link" && from.includes(path.sep + "new" + path.sep) && to === livePath("chromium")
          : op === "open" && from.includes(path.sep + ".history-backup-") && path.basename(from) === "published.json";
        if (!changes && hit) { changes++; changeHistoryPermission(kind); }
      };
      const result = await syncService.pull(undefined, { strategy: "remote", history: true }); h.fault = null;
      expect(changes).toBe(1); expect(result).toMatchObject({ success: false, code: permissionCode(kind), localCommit: "none" });
      for (const [file, hash] of Object.entries(before)) if (file !== getConfigPath()) expect(fs.existsSync(file) ? sha(fs.readFileSync(file)) : null).toBe(hash);
      expect(getConfig().browserProfiles[ID].historySyncBaseline).toBeUndefined();
    });
  });
  it("unselected scope retains only the prior reference, without downloading excluded history or adopting a baseline", async () => {
    const prior = await publish(), key = prior.history[ID].artifact.object.key; resetDevice("excluded-push-device"); seedProfile("chromium");
    setSyncConfig({ historyConsent: false, includeHistory: false }); const start = fixture.journal.length;
    fixture.getHook((key) => { if (key.startsWith("history-v1-")) throw new Error("Excluded private history was fetched"); });
    const result = await syncService.push(); expect(result.success, result.message).toBe(true);
    expect(payload().history[ID]).toMatchObject({ state: "preserved", freshness: "preserved", code: "HISTORY_NOT_SELECTED", artifact: { object: { key } } });
    expect(fixture.journal.slice(start).some((item) => item.key.startsWith("history-v1-"))).toBe(false); expect(getConfig().browserProfiles[ID].historySyncBaseline).toBeUndefined();
  });
});

describe("raw legacy identity receipt", () => {
  it("reports the missing remote seed before portable normalization rather than proving default12345 retained", async () => {
    const document = await publish(), config = JSON.parse(zlib.gunzipSync(Buffer.from(document.data, "base64")).toString("utf8"));
    delete config.browserProfiles[ID].fingerprintSeed; delete config.browserProfiles[ID].syncBaseline; delete config.browserProfiles[ID].syncedHash;
    delete document.history; delete document.snapshotId; delete document.artifactVersion;
    document.data = zlib.gzipSync(JSON.stringify(config)).toString("base64"); fixture.objects.set(CONFIG_KEY, Buffer.from(JSON.stringify(document))); resetDevice("legacy-identity-receiver");
    const result = await syncService.pull(undefined, { strategy: "remote", history: false }); expect(result.success, result.message).toBe(true);
    expect(result.items?.find((item) => item.scope === "profiles")?.identity).toMatchObject({ configuration: { state: "missing-seed" }, runtime: { state: "not-verified" } });
    expect(result.warnings?.join(" ")).toMatch(/without a seed/);
  });
});

describe("history schema/relations/resource gates", () => {
  it.each([
    ["chromium", "UPDATE meta SET value='71' WHERE key='version';"],
    ["chromium", "UPDATE meta SET value='14' WHERE key='version'; UPDATE meta SET value='14' WHERE key='last_compatible_version';"],
    ["chromium", "UPDATE meta SET value='17' WHERE key='last_compatible_version';"],
    ["firefox", "PRAGMA user_version=87;"], ["firefox", "PRAGMA user_version=51;"],
    ["chromium", "CREATE TABLE unsafe_check(value TEXT CHECK(length(value)>0));"],
    ["chromium", "CREATE VIEW unsafe_view AS SELECT load_extension('never-execute');"],
    ["chromium", "CREATE INDEX unsafe_expression ON urls(lower(title));"],
  ] as const)("rejects source-bound unsupported %s schema %s with an explicit code", async (engine, sql) => {
    seedProfile(engine); install(engine); const writer = new DatabaseSync(livePath(engine));
    try { writer.exec(sql); } finally { writer.close(); }
    const before = liveSnapshot(engine), result = await syncService.push(undefined, true, undefined, { history: true });
    expect(result.success).toBe(false); expect(payload().history[ID]).toMatchObject({ state: "failed", code: "HISTORY_SCHEMA_UNSUPPORTED", freshness: "not-covered" });
    expect(historyPuts()).toEqual([]);
    for (const [file, digest] of Object.entries(before)) if (file !== getConfigPath()) expect(fs.existsSync(file) ? sha(fs.readFileSync(file)) : null).toBe(digest);
  });
  it.each(["chromium", "firefox"] as const)("refuses orphan %s visit relations rather than recording a valid snapshot", async (engine) => {
    seedProfile(engine); install(engine); const writer = new DatabaseSync(livePath(engine));
    try { writer.exec(`DELETE FROM ${engine === "chromium" ? "urls" : "moz_places"};`); } finally { writer.close(); }
    const result = await syncService.push(undefined, true, undefined, { history: true });
    expect(result.success).toBe(false); expect(payload().history[ID].state).toBe("failed"); expect(historyPuts()).toEqual([]); expect(result.warnings?.join(" ")).toMatch(/relation/);
  });
  it("rejects an oversized source stat before allocating or reading a large database", async () => {
    seedProfile("chromium"); install("chromium"); h.oversizedPath = livePath("chromium"); let sourceReads = 0;
    h.fault = (op, file) => { if (op === "open" && file === livePath("chromium")) sourceReads++; };
    const result = await syncService.push(undefined, true, undefined, { history: true });
    h.oversizedPath = ""; expect(result.success).toBe(false); expect(sourceReads).toBe(0); expect(payload().history[ID].state).toBe("failed"); expect(historyPuts()).toEqual([]);
  });
});

describe("independent history semantic state", () => {
  it.each(["chromium", "firefox"] as const)("keeps %s just-pushed state clean through checkpoint/bookkeeping and detects a real history edit", async (engine) => {
    await publish(engine);
    const baseline = getConfig().browserProfiles[ID].historySyncBaseline;
    expect(baseline?.semanticHash).toMatch(/^[0-9a-f]{64}$/);
    const configBytes = fs.readFileSync(getConfigPath());
    expect(await syncService.historyState(ID)).toMatchObject({ status: "synced", coverage: "complete", reason: "history-baseline-match" });
    const db = new DatabaseSync(livePath(engine));
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); ANALYZE;");
      if (engine === "chromium") db.exec("INSERT INTO meta VALUES('last_optimization','bookkeeping-only');");
      else db.exec("UPDATE moz_places SET frecency=200;");
    } finally { db.close(); }
    expect(await syncService.historyState(ID)).toMatchObject({ status: "synced", reason: "history-baseline-match" });
    expect(fs.readFileSync(getConfigPath())).toEqual(configBytes); reloadConfig(); expect(getConfig().browserProfiles[ID].historySyncBaseline).toEqual(baseline);
    const changed = new DatabaseSync(livePath(engine));
    try { changed.exec(`UPDATE ${engine === "chromium" ? "urls" : "moz_places"} SET title='real semantic change';`); } finally { changed.close(); }
    expect(await syncService.historyState(ID)).toMatchObject({ status: "dirty", reason: "history-content-changed" });
  });
  it("does not infer a live history restore from a configuration-only baseline", async () => {
    await publish(); resetDevice("config-only-receiver");
    const result = await syncService.pull(undefined, { strategy: "remote", history: false }); expect(result.success, result.message).toBe(true);
    expect(getConfig().browserProfiles[ID].syncBaseline).toBeDefined(); expect(getConfig().browserProfiles[ID].historySyncBaseline).toBeUndefined();
    expect(await syncService.historyState(ID)).toMatchObject({ status: "unselected", coverage: "unselected" });
    expect(fs.existsSync(livePath("chromium"))).toBe(false);
  });
});

describe("history pull prepares all bytes and compensates complete groups", () => {
  it("skips a running receiver's entire profile without metadata adoption or live History reads/writes", async () => {
    await publish(); resetDevice("running-receiver"); seedProfile("chromium"); install("chromium"); const before = liveSnapshot("chromium"); h.running.add(ID);
    const local = structuredClone(getConfig().browserProfiles[ID]);
    h.fault = (op, file) => { if (op === "open" && [livePath("chromium"), livePath("chromium") + "-wal"].includes(file)) throw new Error("Running target history was read"); };
    const result = await syncService.pull(undefined, { strategy: "remote", history: true }); h.fault = null;
    expect(result).toMatchObject({ success: false, outcome: "partial" }); expect(result.items).toContainEqual(expect.objectContaining({ scope: "profiles", state: "skipped", code: "PROFILE_STOP_REQUIRED",
      runtimeEffect: expect.objectContaining({ stopRequired: true, action: "skipped-stop-required" }) }));
    expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).browserProfiles[ID]).toEqual(local);
    for (const [file, hash] of Object.entries(before)) if (file !== getConfigPath()) expect(fs.existsSync(file) ? sha(fs.readFileSync(file)) : null).toBe(hash);
  });
  it("refuses a different existing target schema/version without migrating or touching it", async () => {
    await publish(); resetDevice("incompatible-receiver"); seedProfile("chromium"); install("chromium");
    const writer = new DatabaseSync(livePath("chromium")); try { writer.exec("UPDATE meta SET value='68' WHERE key='version';"); } finally { writer.close(); }
    const before = liveSnapshot("chromium"), result = await syncService.pull(undefined, { strategy: "remote", history: true });
    expect(result).toMatchObject({ success: false, localCommit: "none" }); expect(result.message).toMatch(/Incompatible target history schema/); expect(liveSnapshot("chromium")).toEqual(before);
  });
  it("retains durable old/new groups and typed history recovery receipts after failed compensation", async () => {
    await publish(); resetDevice("recovery-receiver"); seedProfile("chromium"); const old = install("chromium"); const config = fs.readFileSync(getConfigPath());
    let publishFailure = 0, compensationFailure = 0;
    h.fault = (op, from, to) => {
      if (op === "link" && from.includes(path.sep + "new" + path.sep) && to === livePath("chromium") + "-wal") { publishFailure++; throw new Error("Synthetic incoming WAL publication failure"); }
      if (op === "link" && from.includes(path.sep + "old" + path.sep) && to === livePath("chromium")) { compensationFailure++; throw new Error("Synthetic old main compensation failure"); }
    };
    const result = await syncService.pull(undefined, { strategy: "remote", history: true }); h.fault = null;
    expect(publishFailure).toBe(1); expect(compensationFailure).toBe(1); expect(result).toMatchObject({ success: false, outcome: "recovery-required", code: "HISTORY_RECOVERY_REQUIRED" });
    const recovery = result.recovery?.find((entry) => entry.resource === "history"); expect(recovery?.receiptPath).toBeTruthy();
    const receipt = JSON.parse(fs.readFileSync(recovery!.receiptPath!, "utf8")); expect(receipt.state).toBe("recovery-required");
    const rescue = fs.mkdtempSync(path.join(h.root, "reconstruct-protected-old-")), transaction = receipt.transaction;
    fs.copyFileSync(path.join(transaction, "old", "History"), path.join(rescue, "History")); fs.copyFileSync(livePath("chromium") + "-wal", path.join(rescue, "History-wal"));
    expect(fs.readFileSync(path.join(rescue, "History"))).toEqual(old.main); assertRows(path.join(rescue, "History"), "chromium");
    expect(fs.existsSync(path.join(transaction, "new", "History"))).toBe(true); expect(fs.existsSync(path.join(transaction, "new", "History-wal"))).toBe(true);
    expect(fs.readFileSync(getConfigPath())).toEqual(config);
    const retry = await syncService.pull(undefined, { strategy: "remote", history: true }); expect(retry.outcome).toBe("recovery-required"); expect(fs.readFileSync(getConfigPath())).toEqual(config);
  });
  it.each(["chromium", "firefox"] as const)("restores a complete empty %s database, replacing old WAL/SHM without reviving visits", async (engine) => {
    await publish(engine, true); resetDevice("empty-receiver"); seedProfile(engine); const previous = install(engine);
    const oldShm = fs.readFileSync(livePath(engine) + "-shm");
    const result = await syncService.pull(undefined, { strategy: "remote", history: true }); expect(result.success, result.message).toBe(true);
    expect(fs.existsSync(livePath(engine) + "-shm")).toBe(false);
    const db = new DatabaseSync(livePath(engine), { readOnly: true });
    try { expect(db.prepare(`SELECT count(*) AS n FROM ${engine === "firefox" ? "moz_historyvisits" : "visits"}`).get()).toEqual({ n: 0 }); expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); } finally { db.close(); }
    const directory = path.dirname(livePath(engine)), root = fs.readdirSync(directory).find((name) => name.startsWith(".history-backup-"))!;
    expect(root).toBeTruthy(); const backup = path.join(directory, root, "old"), name = path.basename(livePath(engine));
    expect(fs.readFileSync(path.join(backup, name))).toEqual(previous.main); expect(fs.readFileSync(path.join(backup, name + "-wal"))).toEqual(previous.wal);
    expect(fs.readFileSync(path.join(backup, name + "-shm"))).toEqual(oldShm); assertRows(path.join(backup, name), engine);
  });

  it.each(["object-digest", "engine", "schema", "snapshot", "path", "member-sha", "member-size", "over-limit"] as const)("rejects %s before live/config mutation", async (fault) => {
    const document = await publish(), entry = document.history[ID]; resetDevice("corrupt-receiver"); seedProfile("chromium"); install("chromium"); const before = liveSnapshot("chromium");
    if (fault === "object-digest") fixture.objects.set(entry.artifact.object.key, Buffer.from("broken actual object bytes"));
    if (fault === "engine") entry.engine = entry.artifact.engine = "firefox";
    if (fault === "schema") entry.artifact.schema.metaVersion = "68";
    if (fault === "snapshot") entry.artifact.snapshotId = "unbound-source-snapshot";
    if (fault === "path") entry.artifact.members[0].path = "../History";
    if (fault === "member-sha") entry.artifact.members[0].sha256 = "a".repeat(64);
    if (fault === "member-size") entry.artifact.members[0].bytes++;
    if (fault === "over-limit") entry.artifact.members[0].bytes = MAX_HISTORY_BYTES + 1;
    fixture.objects.set(CONFIG_KEY, Buffer.from(JSON.stringify(document)));
    const result = await syncService.pull(undefined, { strategy: "remote", history: true }); expect(result).toMatchObject({ success: false, localCommit: "none" });
    expect(liveSnapshot("chromium")).toEqual(before); reloadConfig(); expect(liveSnapshot("chromium")).toEqual(before);
  });

  it.each(["backup-WAL", "publish-WAL", "config-commit", "cancel"] as const)("rolls back the exact old DB/WAL/SHM/journal group after %s", async (point) => {
    await publish(); resetDevice("compensation-receiver"); seedProfile("chromium"); install("chromium"); fs.writeFileSync(livePath("chromium") + "-journal", Buffer.alloc(0)); const before = liveSnapshot("chromium");
    const controller = new AbortController(); let hits = 0;
    h.fault = (op, from, to) => {
      const hit = point === "backup-WAL" ? op === "rename" && from === livePath("chromium") + "-wal" && Boolean(to?.includes(path.sep + "old" + path.sep))
        : point === "publish-WAL" || point === "cancel" ? op === "link" && to === livePath("chromium") + "-wal" && from.includes(path.sep + "new" + path.sep)
        : op === "rename" && to === getConfigPath();
      if (hit && !hits++) { if (point === "cancel") controller.abort(); else throw Object.assign(new Error("Synthetic history publication fault"), { code: "EIO" }); }
    };
    const result = await syncService.pull(controller.signal, { strategy: "remote", history: true }).catch((error) => error.syncResult);
    h.fault = null; expect(hits).toBeGreaterThan(0); expect(result.success).toBe(false); expect(result.localCommit).toBe("none");
    // Cookie queue publication (empty snapshot does not write) and Preferences
    // remain absent; after successful history compensation no history changes.
    expect(liveSnapshot("chromium")).toEqual(before);
  });
});
