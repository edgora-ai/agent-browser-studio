// Owned on-disk SQLite/LevelDB + real ZIP and sync entry points. No browser,
// user profile or cloud; the bounded test runner provides a private HOME/TMPDIR.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const h = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archive-sync-recovery-owned-")));
  const owner = fs.lstatSync(root);
  return { root, ownerDev: owner.dev, ownerIno: owner.ino, appData: path.join(root, "device"),
    objects: new Map<string, Buffer>(), requests: [] as Array<{ method: string; url: string }>,
    opened: [] as string[], fault: null as null | ((op: string, from: string, to?: string) => void) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    openSync: (file: any, flags: any, mode?: any) => { h.opened.push(String(file)); h.fault?.("open", String(file)); return actual.openSync(file, flags, mode); },
    renameSync: (from: any, to: any) => { h.fault?.("rename", String(from), String(to)); return actual.renameSync(from, to); },
    linkSync: (from: any, to: any) => { h.fault?.("link", String(from), String(to)); return actual.linkSync(from, to); },
  };
});
vi.mock("electron", () => ({
  app: { getPath: (name: string) => name === "home" ? path.join(h.root, "home") : h.appData },
  safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  statusBrowser: () => ({ running: false, pid: null, cdpPort: null }),
}));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ runtimeCookieOps: {
  hasRunningBrowser: () => false,
  exportCookiesSnapshot: async () => ({ state: "available", cookies: [] }),
  importCookies: async (_id: string, cookies: unknown[]) => cookies.length,
} }));

import { syncService } from "../../src/main/services/sync-service.js";
import { exportProfileArchive, importProfileArchive } from "../../src/main/services/profile-archive.js";
import { getConfig, getConfigPath, getProfileMeta, getProfilesDir, reloadConfig, saveConfig, setSyncConfig } from "../../src/main/services/config-manager.js";
import { writeZipArchive, readZipEntries, extractZipEntry, type ZipFileEntry, type ZipDirEntry } from "../../src/main/services/zip-writer.js";
import { isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";

const ID = "ab_archive_sync_recovery";
const HISTORY = ".profile-archive-recovery";
const SQLITE_PREFIX = ".sqlite-localstorage-backup-";
const ENDPOINT = "https://archive-sync.example.test";
const MAIN = `${ENDPOINT}/archive-fixture/agent-browser-studio-config.json`;
const ORIGIN = "https://business.example.test";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const profileDir = (id = ID) => path.join(getProfilesDir(), id);
const defaultDir = (id = ID) => path.join(profileDir(id), "Default");
const backupRoots = (id = ID) => fs.readdirSync(defaultDir(id)).filter((name) => name.startsWith(".sqlite-localstorage-backup-"));

function assertOwner(): void {
  const stat = fs.lstatSync(h.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== h.ownerDev || stat.ino !== h.ownerIno) throw new Error("Unowned archive/sync fixture");
}
function sqliteBytes(value: string): { main: Buffer; wal: Buffer } {
  const dir = fs.mkdtempSync(path.join(h.root, "sqlite-generator-")), file = path.join(dir, "LocalStorage");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE business_storage(origin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(origin,key)) WITHOUT ROWID;");
    db.prepare("INSERT INTO business_storage VALUES(?,?,?)").run(ORIGIN, "archive-key", value);
    return { main: fs.readFileSync(file), wal: fs.readFileSync(file + "-wal") };
  } finally { db.close(); fs.rmSync(dir, { recursive: true }); }
}
function installSqlite(bytes: ReturnType<typeof sqliteBytes>): void {
  fs.mkdirSync(defaultDir(), { recursive: true });
  fs.writeFileSync(path.join(defaultDir(), "LocalStorage"), bytes.main);
  fs.writeFileSync(path.join(defaultDir(), "LocalStorage-wal"), bytes.wal);
}
function assertBusiness(directory: string, value: string): void {
  // Read a private copy: even SQLite's read-only WAL reader can create SHM.
  const copy = fs.mkdtempSync(path.join(h.root, "sqlite-readback-"));
  for (const name of ["LocalStorage", "LocalStorage-wal"]) {
    if (fs.existsSync(path.join(directory, name))) fs.copyFileSync(path.join(directory, name), path.join(copy, name));
  }
  const db = new DatabaseSync(path.join(copy, "LocalStorage"), { readOnly: true, allowExtension: false });
  try {
    expect(db.prepare("SELECT origin,key,value FROM business_storage WHERE origin=? AND key=?").get(ORIGIN, "archive-key"))
      .toEqual({ origin: ORIGIN, key: "archive-key", value });
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally { db.close(); fs.rmSync(copy, { recursive: true }); }
}
function tree(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const rel = relative ? relative + "/" + name : name, abs = path.join(directory, rel), stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) entries[rel] = "symlink:" + fs.readlinkSync(abs);
      else if (stat.isDirectory()) { entries[rel + "/"] = "directory"; walk(rel); }
      else if (stat.isFile()) entries[rel] = sha(fs.readFileSync(abs));
      else throw new Error("Unexpected fixture object");
    }
  };
  walk(""); return entries;
}

type TestZipEntry = ZipFileEntry | ZipDirEntry;
function zipEntries(zipPath: string): TestZipEntry[] {
  const bytes = fs.readFileSync(zipPath);
  return readZipEntries(bytes).map((entry) => entry.isDirectory ? { name: entry.name, isDirectory: true } : { name: entry.name, data: extractZipEntry(bytes, entry) });
}
async function rawProfileZip(zipPath: string, engine: "chromium" | "firefox" = "chromium"): Promise<void> {
  // Simulate an older exporter faithfully, without the new preflight. This is
  // only ZIP construction, not a duplicate/fake recovery classifier.
  const entries: TestZipEntry[] = [{ name: "meta.json", data: Buffer.from(JSON.stringify({
    formatVersion: 1, sourceDirId: ID, profile: { name: "Recovery archive", engine, fingerprintSeed: 42 },
  })) }];
  for (const relative of Object.keys(tree(profileDir()))) entries.push(relative.endsWith("/")
    ? { name: relative, isDirectory: true } : { name: relative, filePath: path.join(profileDir(), relative) });
  await writeZipArchive(zipPath, entries);
}
type HistoryEngine = "chromium" | "firefox";
const HISTORY_PREFIX = ".history-backup-";
const HISTORY_URL = "https://business.example.test/restored-history";
const HISTORY_ID = 9007199254741009n, HISTORY_TIME = 132987654321012345n;
const historyMain = (engine: HistoryEngine) => engine === "firefox" ? "places.sqlite" : "History";
const historyDirectory = (engine: HistoryEngine, id = ID) => engine === "firefox" ? profileDir(id) : defaultDir(id);
const historyBackups = (engine: HistoryEngine, id = ID) => fs.readdirSync(historyDirectory(engine, id)).filter((name) => name.startsWith(HISTORY_PREFIX));
function historyBytes(engine: HistoryEngine, title: string): { main: Buffer; wal: Buffer } {
  const dir = fs.mkdtempSync(path.join(h.root, "history-generator-")), file = path.join(dir, historyMain(engine));
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    if (engine === "chromium") {
      db.exec("CREATE TABLE meta(key LONGVARCHAR PRIMARY KEY NOT NULL,value LONGVARCHAR); INSERT INTO meta VALUES('version','70'),('last_compatible_version','16'); CREATE TABLE urls(id INTEGER PRIMARY KEY,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER,typed_count INTEGER,last_visit_time INTEGER,hidden INTEGER); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER,from_visit INTEGER,transition INTEGER,visit_duration INTEGER);");
    } else {
      db.exec("PRAGMA user_version=86; CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER,last_visit_date INTEGER,frecency INTEGER); CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY,from_visit INTEGER,place_id INTEGER,visit_date INTEGER,visit_type INTEGER); CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,type INTEGER,fk INTEGER,parent INTEGER,position INTEGER,title LONGVARCHAR,dateAdded INTEGER,lastModified INTEGER,guid TEXT);");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const insert = (sql: string, ...values: Array<string | bigint>) => { const statement = db.prepare(sql); statement.setReadBigInts(true); statement.run(...values); };
    if (engine === "chromium") {
      insert("INSERT INTO urls VALUES(?,?,?,?,?,?,?)", HISTORY_ID, HISTORY_URL, title, 1n, 0n, HISTORY_TIME, 0n);
      insert("INSERT INTO visits VALUES(?,?,?,?,?,?)", HISTORY_ID + 1n, HISTORY_ID, HISTORY_TIME, 0n, 805306368n, 0n);
    } else {
      insert("INSERT INTO moz_places VALUES(?,?,?,?,?,?)", HISTORY_ID, HISTORY_URL, title, 1n, HISTORY_TIME, 0n);
      insert("INSERT INTO moz_historyvisits VALUES(?,?,?,?,?)", HISTORY_ID + 1n, 0n, HISTORY_ID, HISTORY_TIME, 1n);
      insert("INSERT INTO moz_bookmarks VALUES(?,?,?,?,?,?,?,?,?)", HISTORY_ID + 2n, 1n, HISTORY_ID, 0n, 0n, title, HISTORY_TIME, HISTORY_TIME, "synthetic___");
    }
    return { main: fs.readFileSync(file), wal: fs.readFileSync(file + "-wal") };
  } finally { db.close(); fs.rmSync(dir, { recursive: true }); }
}
function installHistory(engine: HistoryEngine, title: string): ReturnType<typeof historyBytes> {
  const bytes = historyBytes(engine, title), directory = historyDirectory(engine), main = path.join(directory, historyMain(engine));
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(main, bytes.main); fs.writeFileSync(main + "-wal", bytes.wal);
  return bytes;
}
function assertHistoryRows(engine: HistoryEngine, directory: string, title: string): void {
  const copy = fs.mkdtempSync(path.join(h.root, "history-readback-")), main = historyMain(engine);
  for (const name of [main, main + "-wal"]) if (fs.existsSync(path.join(directory, name))) fs.copyFileSync(path.join(directory, name), path.join(copy, name));
  const db = new DatabaseSync(path.join(copy, main), { readOnly: true, allowExtension: false });
  try {
    const query = db.prepare(engine === "chromium" ? "SELECT u.id,u.title,v.visit_time AS time FROM urls u JOIN visits v ON v.url=u.id WHERE u.url=?"
      : "SELECT u.id,u.title,v.visit_date AS time FROM moz_places u JOIN moz_historyvisits v ON v.place_id=u.id WHERE u.url=?");
    query.setReadBigInts(true); expect(query.get(HISTORY_URL)).toEqual({ id: HISTORY_ID, title, time: HISTORY_TIME });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    if (engine === "firefox") {
      const bookmarks = db.prepare("SELECT fk,title FROM moz_bookmarks WHERE fk=?"); bookmarks.setReadBigInts(true);
      expect(bookmarks.get(HISTORY_ID)).toEqual({ fk: HISTORY_ID, title });
    }
  } finally { db.close(); fs.rmSync(copy, { recursive: true }); }
}
async function completedHistory(engine: HistoryEngine) {
  const cfg = structuredClone(getConfig()); cfg.browserProfiles[ID].engine = engine; saveConfig(cfg);
  setSyncConfig({ includeHistory: true, historyConsent: true });
  installHistory(engine, "published history 中文");
  const pushed = await syncService.push(undefined, true, undefined, { history: true }); expect(pushed.success, JSON.stringify(pushed)).toBe(true);
  const old = installHistory(engine, "unique original history 中文");
  const pulled = await syncService.pull(undefined, { strategy: "remote", history: true }); expect(pulled.success, JSON.stringify(pulled)).toBe(true);
  const [backup] = historyBackups(engine); expect(historyBackups(engine)).toHaveLength(1);
  const relative = (engine === "chromium" ? "Default/" : "") + backup, transaction = path.join(profileDir(), relative);
  const zipPath = path.join(h.appData, `${engine}-history-recovery.zip`); await exportProfileArchive(ID, zipPath);
  return { transaction, relative, backup, old, zipPath };
}
async function completedSqlite(): Promise<{ transaction: string; backup: string; old: ReturnType<typeof sqliteBytes>; zipPath: string }> {
  installSqlite(sqliteBytes("published-new-business-row"));
  const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
  const old = sqliteBytes("unique-old-rescue-row-中文"); installSqlite(old);
  const pulled = await syncService.pull(undefined, { strategy: "remote" }); expect(pulled.success, pulled.message).toBe(true);
  const [backup] = backupRoots(); expect(backupRoots()).toHaveLength(1);
  const transaction = path.join(defaultDir(), backup), zipPath = path.join(h.appData, "completed-recovery.zip");
  await exportProfileArchive(ID, zipPath);
  return { transaction, backup, old, zipPath };
}
function expectRejectedImport(zipPath: string, label = "unresolved recovery"): void {
  const before = tree(h.appData), config = fs.readFileSync(getConfigPath()), zip = fs.readFileSync(zipPath);
  expect(() => importProfileArchive(zipPath), label).toThrow(expect.objectContaining({ code: "ARCHIVE_RECOVERY_REQUIRED" }));
  expect(tree(h.appData), label).toEqual(before); expect(fs.readFileSync(zipPath)).toEqual(zip);
  expect(fs.readFileSync(getConfigPath())).toEqual(config);
  reloadConfig(); expect(getProfileMeta(ID)?.name).toBe("Recovery archive");
  expect(Object.keys(getConfig().browserProfiles)).toEqual([ID]); expect(isRestoreLocked(ID)).toBe(false);
}
async function expectRejectedExport(label: string): Promise<void> {
  const destination = path.join(h.appData, "previous-good.zip");
  if (!fs.existsSync(destination)) await writeZipArchive(destination, [{ name: "last-valid-copy", data: Buffer.from("unique previous ZIP bytes") }]);
  const before = tree(h.appData);
  await expect(exportProfileArchive(ID, destination, { overwrite: true }), label).rejects.toThrow(expect.objectContaining({ code: "ARCHIVE_RECOVERY_REQUIRED" }));
  expect(tree(h.appData), label).toEqual(before);
}
function setPending(entries: TestZipEntry[], backup: string, edit: (pending: any) => void, relative = `Default/${backup}`): void {
  const pendingEntry = entries.find((entry) => entry.name === `${relative}/pending.json`) as ZipFileEntry;
  const publishedEntry = entries.find((entry) => entry.name === `${relative}/published.json`) as ZipFileEntry;
  const pending = JSON.parse(pendingEntry.data!.toString("utf8")); edit(pending);
  pendingEntry.data = Buffer.from(JSON.stringify(pending));
  publishedEntry.data = Buffer.from(JSON.stringify({ state: "published", pendingHash: sha(pendingEntry.data) }));
}

beforeEach(() => {
  assertOwner(); h.fault = null; h.opened = []; h.objects.clear(); h.requests = [];
  fs.rmSync(h.appData, { recursive: true, force: true }); fs.mkdirSync(h.appData, { mode: 0o700 });
  reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.deviceId = "archive-sync-owned-device"; cfg.deviceName = "archive-sync-owned-device";
  cfg.browserProfiles = { [ID]: { name: "Recovery archive", engine: "chromium", fingerprintMode: "managed", fingerprintSeed: 42, proxyMode: "none", updatedAt: 100 } };
  cfg.proxies = {}; cfg.accounts = []; cfg.extensionRepository = {};
  cfg.sync = { enabled: true, endpoint: ENDPOINT, bucket: "archive-fixture", accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: 1 };
  saveConfig(cfg); fs.mkdirSync(defaultDir(), { recursive: true, mode: 0o700 });
  expect(getConfigPath()).toBe(path.join(h.appData, "config.json"));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method || "GET";
    expect(url.startsWith(ENDPOINT + "/")).toBe(true); h.requests.push({ method, url });
    if (method === "PUT") { h.objects.set(url, Buffer.from(init?.body as any)); return new Response("", { status: 200 }); }
    expect(method).toBe("GET"); const bytes = h.objects.get(url);
    return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response("owned missing object", { status: 404 });
  }));
});
afterEach(() => {
  h.fault = null;
  for (const id of Object.keys(getConfig().browserProfiles)) expect(isRestoreLocked(id)).toBe(false);
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
afterAll(() => { assertOwner(); fs.rmSync(h.root, { recursive: true }); });

describe("profile archive sync recovery boundary", { timeout: 30_000 }, () => {
  it("imports a real completed SQLite replacement under a new ID without blocking the next real sync push", async () => {
    installSqlite(sqliteBytes("published-new-business-row"));
    const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
    const old = sqliteBytes("unique-old-rescue-row-中文"); installSqlite(old);
    const pulled = await syncService.pull(undefined, { strategy: "remote" }); expect(pulled.success, pulled.message).toBe(true);
    const [backup] = backupRoots(); expect(backupRoots()).toHaveLength(1);
    const transaction = path.join(defaultDir(), backup);
    expect(fs.readdirSync(transaction).sort()).toEqual(["new", "old", "pending.json", "published.json"]);
    const pending = JSON.parse(fs.readFileSync(path.join(transaction, "pending.json"), "utf8"));
    expect(pending).toMatchObject({ dirId: ID, target: defaultDir(), format: "sqlite", version: 1 });
    assertBusiness(defaultDir(), "published-new-business-row"); assertBusiness(path.join(transaction, "old"), "unique-old-rescue-row-中文");
    const before = tree(profileDir());
    const zipPath = path.join(h.appData, "completed-recovery.zip");
    await exportProfileArchive(ID, zipPath);
    const zip = fs.readFileSync(zipPath), entries = readZipEntries(zip);
    expect(extractZipEntry(zip, entries.find((entry) => entry.name === `Default/${backup}/old/LocalStorage-wal`) !)).toEqual(old.wal);
    const imported = importProfileArchive(zipPath);
    expect(imported.dirId).not.toBe(ID); expect(tree(profileDir())).toEqual(before);
    expect(fs.readFileSync(zipPath)).toEqual(zip);
    const historyRelative = `${HISTORY}/${ID}/Default/${backup}`;
    const retained = path.join(profileDir(imported.dirId), historyRelative);
    expect(imported.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/inert history.*not a recovery\/commit proof/i)]));
    expect(backupRoots(imported.dirId)).toEqual([]);
    expect(tree(retained)).toEqual(tree(transaction));
    expect(fs.readFileSync(path.join(retained, "pending.json"))).toEqual(fs.readFileSync(path.join(transaction, "pending.json")));
    assertBusiness(path.join(retained, "old"), "unique-old-rescue-row-中文");
    assertBusiness(defaultDir(imported.dirId), "published-new-business-row");
    reloadConfig(); expect(getProfileMeta(imported.dirId)?.name).toBe(imported.name);
    expect(Object.keys(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).browserProfiles)).toContain(imported.dirId);
    const retry = await syncService.push(undefined, true);
    expect(retry.success, JSON.stringify(retry)).toBe(true);
    expect(JSON.parse(h.objects.get(MAIN)!.toString("utf8")).artifactSources.localStorage[imported.dirId]).toBe("captured");

    const historyBefore = tree(path.join(profileDir(imported.dirId), HISTORY));
    const secondZip = path.join(h.appData, "history-roundtrip.zip");
    await exportProfileArchive(imported.dirId, secondZip);
    const secondZipBytes = fs.readFileSync(secondZip), second = importProfileArchive(secondZip);
    expect(second.dirId).not.toBe(imported.dirId); expect(backupRoots(second.dirId)).toEqual([]);
    expect(second.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/inert history/i)]));
    expect(tree(path.join(profileDir(second.dirId), HISTORY))).toEqual(historyBefore);
    expect(tree(path.join(profileDir(imported.dirId), HISTORY))).toEqual(historyBefore);
    expect(fs.readFileSync(secondZip)).toEqual(secondZipBytes);
    assertBusiness(path.join(profileDir(second.dirId), historyRelative, "old"), "unique-old-rescue-row-中文");
    assertBusiness(defaultDir(second.dirId), "published-new-business-row");
    const pushedAgain = await syncService.push(undefined, true); expect(pushedAgain.success, JSON.stringify(pushedAgain)).toBe(true);
    const pulledAgain = await syncService.pull(undefined, { strategy: "remote" }); expect(pulledAgain.success, JSON.stringify(pulledAgain)).toBe(true);
    for (const id of [imported.dirId, second.dirId]) {
      assertBusiness(defaultDir(id), "published-new-business-row");
      expect(tree(path.join(profileDir(id), HISTORY))).toEqual(historyBefore);
    }
  });

  it("refuses a real failed SQLite publication/compensation on export and old-ZIP import without touching any rescue or prior ZIP", async () => {
    const incoming = sqliteBytes("unfinished-incoming-row"), old = sqliteBytes("unfinished-unique-old-row");
    installSqlite(incoming); const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
    installSqlite(old); assertBusiness(defaultDir(), "unfinished-unique-old-row");
    let publication = 0, rollback = 0;
    h.fault = (op, from, to) => {
      if (op !== "link" || to !== path.join(defaultDir(), "LocalStorage")) return;
      if (from.includes(`${path.sep}new${path.sep}`)) { publication++; throw new Error("owned SQLite publish fault"); }
      if (from.includes(`${path.sep}old${path.sep}`)) { rollback++; throw new Error("owned SQLite compensation fault"); }
    };
    const pulled = await syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
    expect(pulled).toMatchObject({ success: false, outcome: "recovery-required", code: "LOCAL_STORAGE_RECOVERY_REQUIRED" });
    expect(publication).toBe(1); expect(rollback).toBe(1);
    const [backup] = backupRoots(), transaction = path.join(defaultDir(), backup);
    expect(fs.readFileSync(path.join(transaction, "old", "LocalStorage"))).toEqual(old.main);
    expect(fs.readFileSync(path.join(defaultDir(), "LocalStorage-wal"))).toEqual(old.wal);
    expect(fs.readFileSync(path.join(transaction, "new", "LocalStorage-wal"))).toEqual(incoming.wal);
    expect(fs.existsSync(path.join(transaction, "recovery-required.json"))).toBe(true);
    expect(fs.existsSync(path.join(h.appData, "sync-recovery", ID + ".localStorage.json"))).toBe(true);
    await expectRejectedExport("unfinished SQLite");
    const raw = path.join(h.appData, "unfinished-old-export.zip"); await rawProfileZip(raw);
    expectRejectedImport(raw, "unfinished SQLite ZIP");
    const replay = zipEntries(raw).map((entry) => entry.name.startsWith(`Default/${backup}/`)
      ? { ...entry, name: `${HISTORY}/${ID}/` + entry.name } : entry);
    const inertZip = path.join(h.appData, "unfinished-inert-replay.zip"); await writeZipArchive(inertZip, replay);
    expectRejectedImport(inertZip, "renaming unfinished material into inert history is not completion");
  });

  it("retains real completed legacy backups including LOCK/cache bytes and passes the next real sync push", async () => {
    const live = path.join(defaultDir(), "Local Storage", "leveldb");
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "CURRENT"), "MANIFEST-000001\n"); fs.writeFileSync(path.join(live, "MANIFEST-000001"), "published legacy manifest");
    const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
    fs.writeFileSync(path.join(live, "MANIFEST-000001"), "unique original legacy manifest");
    fs.writeFileSync(path.join(live, "LOCK"), "unique rescue LOCK bytes");
    fs.mkdirSync(path.join(live, "Cache")); fs.writeFileSync(path.join(live, "Cache", "unique.bin"), "unique rescue cache bytes");
    const pulled = await syncService.pull(undefined, { strategy: "remote" }); expect(pulled.success, pulled.message).toBe(true);
    const [backup] = fs.readdirSync(path.dirname(live)).filter((name) => name.startsWith(".leveldb-backup-"));
    const relative = `Default/Local Storage/${backup}`, backupBefore = tree(path.join(profileDir(), relative));
    const before = tree(profileDir()), zipPath = path.join(h.appData, "legacy-completed.zip");
    await exportProfileArchive(ID, zipPath); expect(tree(profileDir())).toEqual(before);
    const imported = importProfileArchive(zipPath);
    expect(imported.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Legacy LevelDB rescue copies.*not a recovery\/commit proof/)]));
    expect(tree(path.join(profileDir(imported.dirId), relative))).toEqual(backupBefore);
    expect(fs.readFileSync(path.join(profileDir(imported.dirId), relative, "LOCK"), "utf8")).toBe("unique rescue LOCK bytes");
    expect(fs.readFileSync(path.join(profileDir(imported.dirId), relative, "Cache", "unique.bin"), "utf8")).toBe("unique rescue cache bytes");
    const retry = await syncService.push(undefined, true); expect(retry.success, JSON.stringify(retry)).toBe(true);
    const roundtrip = path.join(h.appData, "legacy-history-roundtrip.zip"); await exportProfileArchive(imported.dirId, roundtrip);
    const second = importProfileArchive(roundtrip); expect(tree(path.join(profileDir(second.dirId), relative))).toEqual(backupBefore);
    reloadConfig(); expect(getProfileMeta(second.dirId)?.name).toBe(second.name);
  });

  it("refuses real unresolved legacy backups, including an outstanding external receipt after a live directory reappears", async () => {
    const live = path.join(defaultDir(), "Local Storage", "leveldb"); fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "CURRENT"), "MANIFEST-000001\n"); fs.writeFileSync(path.join(live, "MANIFEST-000001"), "remote legacy");
    const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
    fs.writeFileSync(path.join(live, "MANIFEST-000001"), "unique old legacy rescue");
    let publication = 0, rollback = 0;
    h.fault = (op, from, to) => {
      if (op !== "rename" || to !== live) return;
      if (path.basename(from).startsWith("ls-stage-")) { publication++; throw new Error("owned legacy publish fault"); }
      if (path.basename(from).startsWith(".leveldb-backup-")) { rollback++; throw new Error("owned legacy compensation fault"); }
    };
    const pulled = await syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
    expect(pulled).toMatchObject({ success: false, outcome: "recovery-required" }); expect(publication).toBe(1); expect(rollback).toBe(1);
    expect(fs.existsSync(live)).toBe(false);
    await expectRejectedExport("unfinished legacy");
    const zipPath = path.join(h.appData, "legacy-unfinished.zip"); await rawProfileZip(zipPath); expectRejectedImport(zipPath, "legacy missing live");
    fs.mkdirSync(live); fs.writeFileSync(path.join(live, "CURRENT"), "MANIFEST-000099\n"); fs.writeFileSync(path.join(live, "MANIFEST-000099"), "unrelated replacement owner");
    await expectRejectedExport("legacy external recovery receipt must not be cleared by a new live directory");
  });
});

describe("History rescue groups across real ZIP new-ID imports", { timeout: 30_000 }, () => {
  it.each(["chromium", "firefox"] as const)("namespaces completed %s history rescue bytes and keeps the next production push searchable", async (engine) => {
    const fixture = await completedHistory(engine), before = tree(profileDir()), zip = fs.readFileSync(fixture.zipPath);
    const pending = JSON.parse(fs.readFileSync(path.join(fixture.transaction, "pending.json"), "utf8"));
    expect(pending).toMatchObject({ version: 1, format: "sqlite", scope: "history", dirId: ID, target: historyDirectory(engine) });
    assertHistoryRows(engine, historyDirectory(engine), "published history 中文");
    assertHistoryRows(engine, path.join(fixture.transaction, "old"), "unique original history 中文");
    const imported = importProfileArchive(fixture.zipPath), retained = path.join(profileDir(imported.dirId), HISTORY, ID, fixture.relative);
    expect(historyBackups(engine, imported.dirId)).toEqual([]);
    expect(imported.warnings).toContainEqual(expect.stringMatching(/History\/Places rescue.*inert history.*not a recovery\/commit proof/i));
    expect(tree(retained)).toEqual(tree(fixture.transaction)); expect(tree(profileDir())).toEqual(before);
    expect(fs.readFileSync(fixture.zipPath)).toEqual(zip);
    assertHistoryRows(engine, path.join(retained, "old"), "unique original history 中文");
    assertHistoryRows(engine, historyDirectory(engine, imported.dirId), "published history 中文");
    reloadConfig(); expect(getProfileMeta(imported.dirId)?.engine).toBe(engine);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).browserProfiles[imported.dirId].name).toBe(imported.name);
    const pushed = await syncService.push(undefined, true, undefined, { history: true }); expect(pushed.success, JSON.stringify(pushed)).toBe(true);
    expect(JSON.parse(h.objects.get(MAIN)!.toString("utf8")).history[imported.dirId]).toMatchObject({ state: "complete", dirId: imported.dirId, engine });
    const historyBefore = tree(path.join(profileDir(imported.dirId), HISTORY)), secondZip = path.join(h.appData, "history-second-generation.zip");
    await exportProfileArchive(imported.dirId, secondZip);
    const second = importProfileArchive(secondZip);
    expect(historyBackups(engine, second.dirId)).toEqual([]); expect(tree(path.join(profileDir(second.dirId), HISTORY))).toEqual(historyBefore);
    assertHistoryRows(engine, historyDirectory(engine, second.dirId), "published history 中文");
    const pushedAgain = await syncService.push(undefined, true, undefined, { history: true }); expect(pushedAgain.success, JSON.stringify(pushedAgain)).toBe(true);
  });

  it.each(["chromium", "firefox"] as const)("refuses unresolved %s History transactions and external alarms without overwriting prior archives", async (engine) => {
    const fixture = await completedHistory(engine), published = fs.readFileSync(path.join(fixture.transaction, "published.json"));
    fs.unlinkSync(path.join(fixture.transaction, "published.json"));
    await expectRejectedExport("unconfirmed History publication");
    const raw = path.join(h.appData, "old-unconfirmed-history.zip"); await rawProfileZip(raw, engine); expectRejectedImport(raw);
    const entries = zipEntries(raw).map((entry) => entry.name.startsWith(fixture.relative + "/")
      ? { ...entry, name: `${HISTORY}/${ID}/` + entry.name } : entry);
    const inertZip = path.join(h.appData, "unconfirmed-history-replay.zip"); await writeZipArchive(inertZip, entries); expectRejectedImport(inertZip);
    fs.writeFileSync(path.join(fixture.transaction, "published.json"), published);
    const receipts = path.join(h.appData, "sync-recovery"); fs.mkdirSync(receipts, { recursive: true });
    fs.writeFileSync(path.join(receipts, `${ID}.history.json`), '{"state":"recovery-required"}');
    await expectRejectedExport("outstanding History recovery alarm despite a live main database");
    assertHistoryRows(engine, path.join(fixture.transaction, "old"), "unique original history 中文");
  });

  it.each(["chromium", "firefox"] as const)("accepts %s foreign target text without reading it or claiming new-ID transaction ownership", async (engine) => {
    const fixture = await completedHistory(engine), leaf = engine === "chromium" ? "/Default" : "";
    const targets = [path.join(h.root, "absent-source-device", ID) + leaf,
      `C:\\OwnedSourceDevice\\profiles\\${ID}` + leaf.replaceAll("/", "\\"),
      `\\\\owned-source-device\\share\\profiles\\${ID}` + leaf.replaceAll("/", "\\")];
    for (const [index, target] of targets.entries()) {
      const entries = zipEntries(fixture.zipPath); setPending(entries, fixture.backup, (pending) => { pending.target = target; }, fixture.relative);
      const zipPath = path.join(h.appData, `foreign-history-${index}.zip`); await writeZipArchive(zipPath, entries);
      h.opened = []; h.fault = (op, file) => { if (op === "open" && file.startsWith(target)) throw new Error("Foreign History target must never be read"); };
      const imported = importProfileArchive(zipPath); h.fault = null;
      expect(h.opened.some((file) => file.startsWith(target))).toBe(false); expect(historyBackups(engine, imported.dirId)).toEqual([]);
      const retained = path.join(profileDir(imported.dirId), HISTORY, ID, fixture.relative);
      expect(JSON.parse(fs.readFileSync(path.join(retained, "pending.json"), "utf8"))).toMatchObject({ target, dirId: ID, scope: "history" });
      assertHistoryRows(engine, path.join(retained, "old"), "unique original history 中文");
      const pushed = await syncService.push(undefined, true, undefined, { history: true }); expect(pushed.success, JSON.stringify(pushed)).toBe(true);
    }
  });

  it.each(["chromium", "firefox"] as const)("rejects forged %s History completion, foreign paths, case aliases and inert destination collisions", async (engine) => {
    const fixture = await completedHistory(engine);
    const mutations: Array<[string, (pending: any) => void]> = [
      ["wrong scope", (p) => { p.scope = "localStorage"; }], ["wrong source ID", (p) => { p.dirId = "ab_other"; }],
      ["wrong target", (p) => { p.target = "/owned/ab_other/Default"; }], ["path traversal", (p) => { p.old[0].name = "../History"; }],
      ["wrong main", (p) => { p.old[0].name = engine === "firefox" ? "History" : "places.sqlite"; }],
      ["lying hash", (p) => { p.old[0].hash = "0".repeat(64); }], ["unknown scope field", (p) => { p.engine = engine; }],
    ];
    for (const [index, [label, edit]] of mutations.entries()) {
      for (const inert of [false, true]) {
        let entries = zipEntries(fixture.zipPath); setPending(entries, fixture.backup, edit, fixture.relative);
        if (inert) entries = entries.map((entry) => entry.name.startsWith(fixture.relative + "/") ? { ...entry, name: `${HISTORY}/${ID}/` + entry.name } : entry);
        const zipPath = path.join(h.appData, `bad-history-${index}-${inert}.zip`); await writeZipArchive(zipPath, entries);
        expectRejectedImport(zipPath, `${label}, inert=${inert}`); fs.unlinkSync(zipPath);
      }
    }
    const entries = zipEntries(fixture.zipPath), aliases = entries.map((entry) => entry.name.includes(HISTORY_PREFIX) ? { ...entry, name: entry.name.replace(HISTORY_PREFIX, HISTORY_PREFIX.toUpperCase()) } : entry);
    const aliased = path.join(h.appData, "history-case-alias.zip"); await writeZipArchive(aliased, aliases); expectRejectedImport(aliased);
    const duplicate = entries.filter((entry) => entry.name.startsWith(fixture.relative + "/")).map((entry) => ({ ...entry, name: `${HISTORY}/${ID}/` + entry.name }));
    const collision = path.join(h.appData, "history-inert-collision.zip"); await writeZipArchive(collision, [...entries, ...duplicate]); expectRejectedImport(collision);
  });
});

describe("untrusted recovery JSON/path boundaries use the real archive importer", { timeout: 30_000 }, () => {
  it("rejects hostile pending fields and paths even with a matching recomputed publication hash", async () => {
    const fixture = await completedSqlite();
    const mutations: Array<[string, (pending: any) => void]> = [
      ["wrong version", (p) => { p.version = 2; }], ["wrong format", (p) => { p.format = "leveldb"; }],
      ["wrong source ID", (p) => { p.dirId = "ab_another_source"; }], ["object source ID", (p) => { p.dirId = { value: ID }; }],
      ["traversal operation", (p) => { p.operationId = "../elsewhere"; }], ["object operation", (p) => { p.operationId = {}; }],
      ["relative target", (p) => { p.target = `${ID}/Default`; }],
      ["parent target", (p) => { p.target = `/owned/${ID}/../${ID}/Default`; }],
      ["alias target", (p) => { p.target = `/owned//${ID}/Default`; }],
      ["wrong profile target", (p) => { p.target = "/owned/ab_other/Default"; }],
      ["wrong leaf", (p) => { p.target = `/owned/${ID}/Other`; }],
      ["trailing separator", (p) => { p.target = `/owned/${ID}/Default/`; }],
      ["URL target", (p) => { p.target = `file:///owned/${ID}/Default`; }],
      ["NUL target", (p) => { p.target = `/owned/\u0000/${ID}/Default`; }],
      ["Windows relative drive", (p) => { p.target = `C:${ID}\\Default`; }],
      ["Windows root-relative", (p) => { p.target = `\\owned\\${ID}\\Default`; }],
      ["Windows traversal", (p) => { p.target = `C:\\owned\\..\\${ID}\\Default`; }],
      ["mixed separators", (p) => { p.target = `C:\\owned/${ID}\\Default`; }],
      ["Windows ADS ancestor", (p) => { p.target = `C:\\owned:ads\\${ID}\\Default`; }],
      ["Windows trailing-dot alias", (p) => { p.target = `C:\\owned.\\${ID}\\Default`; }],
      ["Windows device alias", (p) => { p.target = `C:\\NUL\\${ID}\\Default`; }],
      ["Windows namespace target", (p) => { p.target = `\\\\?\\C:\\owned\\${ID}\\Default`; }],
      ["object target", (p) => { p.target = { path: fixture.transaction }; }],
      ["inventory traversal", (p) => { p.old[0].name = "../LocalStorage"; }],
      ["inventory absolute", (p) => { p.old[0].name = "/LocalStorage"; }],
      ["inventory backslash", (p) => { p.old[0].name = "..\\LocalStorage"; }],
      ["inventory prototype", (p) => { p.old[0].name = "__proto__"; }],
      ["inventory object name", (p) => { p.old[0].name = {}; }],
      ["inventory duplicate", (p) => { p.old.push({ ...p.old[0] }); }],
      ["inventory bad hash", (p) => { p.old[0].hash = "not-a-hash"; }],
      ["inventory lying hash", (p) => { p.old[0].hash = "0".repeat(64); }],
      ["inventory missing main", (p) => { p.old = p.old.filter((item: any) => item.name !== "LocalStorage"); }],
      ["inventory absent", (p) => { delete p.old; }], ["inventory null", (p) => { p.old = null; }],
      ["incoming missing main", (p) => { p.incoming = []; }],
      ["incoming unsafe sidecar", (p) => { p.incoming.push({ name: "LocalStorage-shm", hash: "a".repeat(64) }); }],
      ["inventory unknown field", (p) => { p.old[0].backupPath = "/not-a-readable-source"; }],
      ["prototype field", (p) => { Object.defineProperty(p, "__proto__", { value: {}, enumerable: true }); }],
      ["constructor field", (p) => { p.constructor = {}; }], ["oversized receipt", (p) => { p.padding = "x".repeat(16384); }],
    ];
    for (const [index, [label, edit]] of mutations.entries()) {
      const entries = zipEntries(fixture.zipPath); setPending(entries, fixture.backup, edit);
      const zipPath = path.join(h.appData, `hostile-pending-${index}.zip`); await writeZipArchive(zipPath, entries);
      expectRejectedImport(zipPath, label); fs.unlinkSync(zipPath);
    }
  });

  it("rejects duplicate, malformed, non-object and noncanonical JSON receipts without accepting last-key-wins", async () => {
    const fixture = await completedSqlite();
    const bad = ["null", "[]", "1", '"string"', "{", "{}", "\n", '{"__proto__":{}}'];
    for (const receipt of ["pending.json", "published.json"]) {
      const original = (zipEntries(fixture.zipPath).find((entry) => entry.name === `Default/${fixture.backup}/${receipt}`) as ZipFileEntry).data!;
      const parsed = JSON.parse(original.toString("utf8"));
      const key = receipt === "pending.json" ? "dirId" : "state";
      const texts = [...bad, " " + original.toString("utf8"), JSON.stringify(parsed, null, 2),
        `{"${key}":"unresolved",${original.toString("utf8").slice(1)}`];
      for (const [index, text] of texts.entries()) {
        const entries = zipEntries(fixture.zipPath), entry = entries.find((entry) => entry.name === `Default/${fixture.backup}/${receipt}`) as ZipFileEntry;
        entry.data = Buffer.from(text);
        const zipPath = path.join(h.appData, `hostile-json-${receipt}-${index}.zip`); await writeZipArchive(zipPath, entries);
        expectRejectedImport(zipPath, receipt + ":" + text.slice(0, 80)); fs.unlinkSync(zipPath);
      }
    }
    const entries = zipEntries(fixture.zipPath), receipt = entries.find((entry) => entry.name.endsWith("/published.json")) as ZipFileEntry;
    receipt.data = Buffer.from(JSON.stringify({ state: "pending", pendingHash: sha((entries.find((entry) => entry.name.endsWith("/pending.json")) as ZipFileEntry).data!) }));
    const zipPath = path.join(h.appData, "not-published.zip"); await writeZipArchive(zipPath, entries); expectRejectedImport(zipPath, "publication state");
  });

  it("rejects incomplete rescue inventories, forged completion, explicit alarms and inert replays while preserving every input byte", async () => {
    const fixture = await completedSqlite(), prefix = `Default/${fixture.backup}/`;
    const variants: Array<[string, (entries: TestZipEntry[]) => TestZipEntry[]]> = [
      ["missing pending", (entries) => entries.filter((entry) => entry.name !== prefix + "pending.json")],
      ["missing published", (entries) => entries.filter((entry) => entry.name !== prefix + "published.json")],
      ["explicit recovery alarm", (entries) => [...entries, { name: prefix + "recovery-required.json", data: Buffer.from('{"state":"recovery-required"}') }]],
      ["new still has unique bytes", (entries) => [...entries, { name: prefix + "new/LocalStorage", data: Buffer.from("unique unfinished bytes") }]],
      ["unknown old unique bytes", (entries) => [...entries, { name: prefix + "old/LOCK", data: Buffer.from("unique unknown rescue") }]],
      ["old WAL missing", (entries) => entries.filter((entry) => entry.name !== prefix + "old/LocalStorage-wal")],
      ["old WAL corrupt", (entries) => entries.map((entry) => entry.name === prefix + "old/LocalStorage-wal" ? { name: entry.name, data: Buffer.from("unique damaged rescue bytes") } : entry)],
      ["live main missing", (entries) => entries.filter((entry) => entry.name !== "Default/LocalStorage")],
      ["published hash mismatch", (entries) => entries.map((entry) => entry.name === prefix + "published.json" ? { name: entry.name, data: Buffer.from(JSON.stringify({ state: "published", pendingHash: "0".repeat(64) })) } : entry)],
    ];
    for (const [index, [label, change]] of variants.entries()) {
      for (const inert of [false, true]) {
        // Missing live is not an unresolved *historical* transaction; all the
        // other failures must remain failures even after an inert-path replay.
        if (inert && label === "live main missing") continue;
        let entries = change(zipEntries(fixture.zipPath));
        if (inert) entries = entries.map((entry) => entry.name.startsWith(prefix) ? { ...entry, name: `${HISTORY}/${ID}/` + entry.name } : entry);
        const zipPath = path.join(h.appData, `hostile-inventory-${index}-${inert}.zip`); await writeZipArchive(zipPath, entries);
        expectRejectedImport(zipPath, `${label}, inert=${inert}`); fs.unlinkSync(zipPath);
      }
    }
  });

  it("refuses source identity/path attacks and fixed-history destination collisions without overwriting either copy", async () => {
    const fixture = await completedSqlite();
    for (const [index, sourceDirId] of [undefined, null, {}, [], "../escape", "/escape", "C:\\escape", "ab_other", "__proto__", "constructor"].entries()) {
      const entries = zipEntries(fixture.zipPath), meta = entries.find((entry) => entry.name === "meta.json") as ZipFileEntry;
      const document = JSON.parse(meta.data!.toString("utf8")); document.sourceDirId = sourceDirId; meta.data = Buffer.from(JSON.stringify(document));
      const zipPath = path.join(h.appData, `hostile-source-${index}.zip`); await writeZipArchive(zipPath, entries);
      expectRejectedImport(zipPath, String(sourceDirId)); fs.unlinkSync(zipPath);
    }
    const entries = zipEntries(fixture.zipPath), otherOld = sqliteBytes("unique colliding rescue history");
    const duplicateBase = zipEntries(fixture.zipPath).filter((entry) => entry.name.startsWith(`Default/${fixture.backup}/`));
    for (const entry of duplicateBase) {
      if (entry.name.endsWith("/old/LocalStorage")) (entry as ZipFileEntry).data = otherOld.main;
      if (entry.name.endsWith("/old/LocalStorage-wal")) (entry as ZipFileEntry).data = otherOld.wal;
    }
    setPending(duplicateBase, fixture.backup, (pending) => { pending.old = [
      { name: "LocalStorage", hash: sha(otherOld.main) }, { name: "LocalStorage-wal", hash: sha(otherOld.wal) },
    ]; });
    const duplicate = duplicateBase.map((entry) => ({ ...entry, name: `${HISTORY}/${ID}/` + entry.name }));
    const zipPath = path.join(h.appData, "history-collision.zip"); await writeZipArchive(zipPath, [...entries, ...duplicate]);
    expect(otherOld.wal).not.toEqual(fixture.old.wal);
    expectRejectedImport(zipPath, "fixed history destination collision must retain both distinct old histories");
  });

  it.each(["POSIX", "Windows drive", "Windows UNC"])("accepts a completed %s foreign target as identity text only, never a filesystem read or a new-ID commit proof", async (style) => {
    const fixture = await completedSqlite(), entries = zipEntries(fixture.zipPath);
    const target = style === "POSIX" ? path.join(h.root, "absent-source-device", ID, "Default")
      : style === "Windows drive" ? `C:\\OwnedSourceDevice\\profiles\\${ID}\\Default` : `\\\\owned-source-device\\share\\profiles\\${ID}\\Default`;
    setPending(entries, fixture.backup, (pending) => { pending.target = target; });
    const zipPath = path.join(h.appData, "foreign-source.zip"); await writeZipArchive(zipPath, entries);
    h.opened = []; h.fault = (op, file) => { if (op === "open" && file.startsWith(target)) throw new Error("Foreign target must never be opened"); };
    const imported = importProfileArchive(zipPath); h.fault = null;
    expect(h.opened.some((file) => file.startsWith(target))).toBe(false);
    const retained = path.join(profileDir(imported.dirId), HISTORY, ID, "Default", fixture.backup);
    expect(JSON.parse(fs.readFileSync(path.join(retained, "pending.json"), "utf8"))).toMatchObject({ dirId: ID, target });
    assertBusiness(path.join(retained, "old"), "unique-old-rescue-row-中文");
    const retry = await syncService.push(undefined, true); expect(retry.success, JSON.stringify(retry)).toBe(true);
    const roundtrip = path.join(h.appData, "foreign-history-roundtrip.zip"); await exportProfileArchive(imported.dirId, roundtrip);
    const second = importProfileArchive(roundtrip); expect(tree(path.join(profileDir(second.dirId), HISTORY))).toEqual(tree(path.join(profileDir(imported.dirId), HISTORY)));
  });

  it("does not follow receipt/rescue symlinks or omit them as ordinary cache/lock material", async () => {
    const fixture = await completedSqlite();
    const target = path.join(h.root, "owned-unrelated-receipt"); fs.writeFileSync(target, "must not be read through a link");
    fs.unlinkSync(path.join(fixture.transaction, "pending.json")); fs.symlinkSync(target, path.join(fixture.transaction, "pending.json"));
    h.opened = []; await expectRejectedExport("receipt symlink");
    expect(h.opened).not.toContain(path.join(fixture.transaction, "pending.json"));
    expect(fs.readFileSync(target, "utf8")).toBe("must not be read through a link");
  });

  it("refuses an active source transaction bound to another absolute path and embedded legacy recovery alarms", async () => {
    const fixture = await completedSqlite(), entries = zipEntries(fixture.zipPath);
    setPending(entries, fixture.backup, (pending) => { pending.target = path.join(h.root, "absent-other-owner", ID, "Default"); });
    for (const receipt of ["pending.json", "published.json"]) {
      const entry = entries.find((entry) => entry.name === `Default/${fixture.backup}/${receipt}`) as ZipFileEntry;
      fs.writeFileSync(path.join(fixture.transaction, receipt), entry.data!);
    }
    await expectRejectedExport("same ID but wrong active source path");
    // A separate owned legacy fixture has no SQLite transaction at all.
    fs.rmSync(fixture.transaction, { recursive: true });
    for (const name of ["LocalStorage", "LocalStorage-wal"]) fs.unlinkSync(path.join(defaultDir(), name));
    const parent = path.join(defaultDir(), "Local Storage"), backup = path.join(parent, ".leveldb-backup-legacy-alarm");
    fs.mkdirSync(path.join(parent, "leveldb"), { recursive: true }); fs.mkdirSync(backup);
    fs.writeFileSync(path.join(backup, "CURRENT"), "unique legacy bytes");
    fs.writeFileSync(path.join(backup, "recovery-required.json"), '{"state":"recovery-required"}');
    await expectRejectedExport("legacy embedded unresolved marker despite live directory");
    const zipPath = path.join(h.appData, "legacy-inline-alarm.zip"); await rawProfileZip(zipPath); expectRejectedImport(zipPath, "legacy embedded marker");
  });

  it("rejects malformed history ancestry/case aliases instead of guessing an inert path", async () => {
    const fixture = await completedSqlite(), prefix = `Default/${fixture.backup}/`;
    const variants = [
      ["prototype history ID", (name: string) => `${HISTORY}/__proto__/` + name],
      ["unrecognized history layout", (name: string) => `${HISTORY}/${ID}/Other/` + name.slice("Default/".length)],
      ["history ID mismatch", (name: string) => `${HISTORY}/ab_other/` + name],
      ["case alias Default", (name: string) => "default/" + name.slice("Default/".length)],
      ["case alias backup", (name: string) => name.replace(SQLITE_PREFIX, SQLITE_PREFIX.toUpperCase())],
    ] as const;
    for (const [index, [label, rename]] of variants.entries()) {
      const entries = zipEntries(fixture.zipPath).map((entry) => {
        if (label === "case alias Default" && entry.name.startsWith("Default/")) return { ...entry, name: rename(entry.name) };
        return entry.name.startsWith(prefix) ? { ...entry, name: rename(entry.name) } : entry;
      });
      const zipPath = path.join(h.appData, `hostile-layout-${index}.zip`); await writeZipArchive(zipPath, entries);
      expectRejectedImport(zipPath, label); fs.unlinkSync(zipPath);
    }
  });
});
