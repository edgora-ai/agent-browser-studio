import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  captureFullProfile, FULL_PROFILE_FORMAT, MAX_FULL_PROFILE_BODY_BYTES, MAX_FULL_PROFILE_DEPTH,
  MAX_FULL_PROFILE_ENTRIES, parseFullProfileArtifact, prepareFullProfile, resealPreparedFullProfile,
  restorePreparedFullProfile, type CaptureFullProfileOptions, type FullProfileArtifact,
  type PreparedFullProfile,
} from "../../src/main/services/sync/full-profile-artifact.js";
import { extractZipEntry, readZipEntries, writeZipArchive, type ZipDirEntry, type ZipFileEntry } from "../../src/main/services/zip-writer.js";

// All data is invented and cold. No app configuration, real profile, credentials,
// Keychain, browser/SDK/device, network, or license module is imported here.
const ID = "synthetic-profile-0001";
const PASSPHRASE = "fixture migration passphrase only";
const guard = () => { /* Caller owns a stopped synthetic profile. */ };
const roots: string[] = [];
function tmp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "full-profile-artifact-test-"));
  fs.chmodSync(root, 0o700); roots.push(root); return root;
}
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function mkdir(directory: string): string { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory; }
function put(root: string, relative: string, bytes: string | Buffer): string {
  const file = path.join(root, relative); mkdir(path.dirname(file)); fs.writeFileSync(file, bytes, { mode: 0o600 }); return file;
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function database(root: string, relative: string, sql: string): string {
  const file = path.join(root, relative); mkdir(path.dirname(file));
  const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); }
  fs.chmodSync(file, 0o600); return file;
}
function query(file: string, sql: string): any[] {
  const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); }
}
function chromium(root: string): void {
  put(root, "Local State", JSON.stringify({ os_crypt: { encrypted_key: "SYNTHETIC_WRAPPED_KEY_NOT_USABLE" }, fixture: "origin-host" }));
  database(root, "Default/Login Data", "CREATE TABLE logins(origin_url TEXT PRIMARY KEY,username_value TEXT,password_value BLOB); INSERT INTO logins VALUES('https://fixture.example.test','fake-user',X'76313066616B652D636970686572');");
  database(root, "Default/Cookies", "CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT); INSERT INTO cookies VALUES('fixture.example.test','fixture_session','SYNTHETIC_COOKIE');");
  database(root, "Default/Network/Cookies", "CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT); INSERT INTO cookies VALUES('network.example.test','fixture_network','SYNTHETIC_NETWORK_COOKIE');");
  database(root, "Default/History", "CREATE TABLE urls(url TEXT,title TEXT); INSERT INTO urls VALUES('https://fixture.example.test/saved','Synthetic saved page');");
  put(root, "Default/Preferences", JSON.stringify({ fixture_preference: "remember-me" }));
  put(root, "Default/Local Storage/leveldb/000001.log", "cart-key=synthetic-cart");
  put(root, "Default/Local Storage/leveldb/LOCK", "process lock, deliberately excluded");
  put(root, "Default/IndexedDB/https_fixture.example.test_0.indexeddb.leveldb/000002.ldb", "indexed-key=synthetic-indexed-value");
  put(root, "Default/Service Worker/CacheStorage/fixture-hash/response", "offline-cache-key=synthetic-offline-response");
  put(root, "Default/Service Worker/ScriptCache/installed-script", "synthetic-installed-service-worker-script");
  put(root, "Default/blob_storage/fixture-blob/blob", "blob-key=synthetic-blob");
  put(root, "Default/Session Storage/000003.log", "session-key=synthetic-session");
  put(root, "Default/Sessions/Session_123", "tab-key=synthetic-open-tab");
  mkdir(path.join(root, "Default/empty-persistent-directory"));
  for (const relative of ["Default/Cache/HTTP", "Default/Code Cache/js/code", "Default/GPUCache/gpu", "ShaderCache/shader", "SingletonLock", "DevToolsActivePort"]) put(root, relative, "temporary-only");
}
function firefox(root: string): void {
  put(root, "logins.json", JSON.stringify({ logins: [{ hostname: "https://fixture.example.test", encryptedUsername: "FAKE_ENCRYPTED_USER", encryptedPassword: "FAKE_ENCRYPTED_PASSWORD" }], nextId: 2 }));
  database(root, "key4.db", "CREATE TABLE metadata(id TEXT PRIMARY KEY,item1 BLOB,item2 BLOB); INSERT INTO metadata VALUES('password',X'66616B65',X'66697874757265');");
  database(root, "cookies.sqlite", "CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT); INSERT INTO moz_cookies VALUES('fixture.example.test','fixture_ff_session','FAKE_FF_COOKIE');");
  database(root, "places.sqlite", "CREATE TABLE moz_places(url TEXT,title TEXT); INSERT INTO moz_places VALUES('https://fixture.example.test/saved','Firefox fixture page');");
  database(root, "storage/default/https+++fixture.example.test/idb/store.sqlite", "CREATE TABLE object_data(key TEXT PRIMARY KEY,value TEXT); INSERT INTO object_data VALUES('offline-key','synthetic-ff-offline-value');");
  database(root, "storage/default/https+++fixture.example.test/cache/caches.sqlite", "CREATE TABLE cache_entries(key TEXT,value TEXT); INSERT INTO cache_entries VALUES('response-key','persistent-response');");
  put(root, "prefs.js", 'user_pref("fixture.persisted", "synthetic-preference");');
  put(root, "sessionstore.jsonlz4", Buffer.from("mozLz40\0synthetic-sessionstore"));
  put(root, "sessionstore-backups/recovery.jsonlz4", "synthetic-session-backup");
  put(root, "storage/default/https+++fixture.example.test/idb/blob/1", "synthetic-ff-blob");
  put(root, "cache2/entries/http", "temporary-http-cache");
  put(root, "startupCache/startup", "temporary-code-cache");
  put(root, "parent.lock", "stopped-process-lock");
}
function captureOptions(root: string, overrides: Partial<CaptureFullProfileOptions> = {}): CaptureFullProfileOptions {
  return { profileDir: mkdir(path.join(root, "source", ID)), stagingDir: mkdir(path.join(root, "staging")),
    dirId: ID, engine: "chromium", snapshotId: "synthetic-snapshot-1", passphrase: PASSPHRASE, sourcePlatform: "darwin", browserVersion: "150.0.fixture", guard, ...overrides };
}
async function simpleBundle(root = tmp()) {
  const options = captureOptions(root);
  put(options.profileDir, "safe.txt", "SYNTHETIC_PRIVATE_STATE"); put(options.profileDir, "next.txt", "second-value");
  mkdir(path.join(options.profileDir, "empty"));
  return { root, options, ...await captureFullProfile(options) };
}
type Bundle = Awaited<ReturnType<typeof simpleBundle>>;
function prepare(bundle: Pick<Bundle, "body" | "descriptor" | "options">, overrides: Partial<Parameters<typeof prepareFullProfile>[0]> = {}) {
  return prepareFullProfile({ body: bundle.body, descriptor: bundle.descriptor, stagingDir: bundle.options.stagingDir, passphrase: PASSPHRASE, dirId: ID, engine: bundle.options.engine, guard, ...overrides });
}
function descriptorFor(body: Buffer, previous: FullProfileArtifact): FullProfileArtifact {
  const sha256 = digest(body); return { ...previous, sha256, key: `full-profile-v1-${sha256}.bin`, size: body.length };
}
function unpack(bundle: Pick<Bundle, "body">): { zip: Buffer; header: any } {
  const length = bundle.body.readUInt32BE(8), start = 12 + length, header = JSON.parse(bundle.body.subarray(12, start).toString());
  const key = scryptSync(PASSPHRASE, Buffer.from(header.salt, "hex"), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "hex"));
    decipher.setAAD(bundle.body.subarray(0, start)); decipher.setAuthTag(bundle.body.subarray(-16));
    return { header, zip: Buffer.concat([decipher.update(bundle.body.subarray(start, -16)), decipher.final()]) };
  } finally { key.fill(0); }
}
function seal(bundle: Pick<Bundle, "body" | "descriptor">, zip: Buffer, patch: Record<string, unknown> = {}) {
  const { header } = unpack(bundle); Object.assign(header, { iv: randomBytes(12).toString("hex") }, patch);
  const metadata = Buffer.from(canonical(header)), prefix = Buffer.alloc(12); prefix.write("RXYFP001", "ascii"); prefix.writeUInt32BE(metadata.length, 8);
  const key = scryptSync(PASSPHRASE, Buffer.from(header.salt, "hex"), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(header.iv, "hex")); cipher.setAAD(Buffer.concat([prefix, metadata]));
    const body = Buffer.concat([prefix, metadata, cipher.update(zip), cipher.final(), cipher.getAuthTag()]);
    return { body, descriptor: descriptorFor(body, bundle.descriptor) };
  } finally { key.fill(0); }
}
async function repack(bundle: Bundle, change: (entries: Array<ZipFileEntry | ZipDirEntry>) => Array<ZipFileEntry | ZipDirEntry>) {
  const { zip } = unpack(bundle);
  const entries = readZipEntries(zip).map((entry): ZipFileEntry | ZipDirEntry => entry.isDirectory ? { name: entry.name, isDirectory: true } : { name: entry.name, data: extractZipEntry(zip, entry) });
  const output = path.join(bundle.root, `hostile-${randomBytes(4).toString("hex")}.zip`);
  await writeZipArchive(output, change(entries)); return seal(bundle, fs.readFileSync(output));
}
function replaceBytes(bytes: Buffer, oldName: string, newName: string): Buffer {
  expect(Buffer.byteLength(oldName)).toBe(Buffer.byteLength(newName));
  const result = Buffer.from(bytes), needle = Buffer.from(oldName);
  for (let at = result.indexOf(needle); at >= 0; at = result.indexOf(needle, at + needle.length)) result.write(newName, at, "utf8");
  return result;
}
function readAll(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = prefix + name, stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file, relative + "/"); else if (stat.isFile()) result[relative] = digest(fs.readFileSync(file));
      else throw new Error("Unexpected non-regular fixture");
    }
  };
  walk(root, ""); return result;
}
function expectPrivate(root: string): void {
  if (process.platform === "win32") return;
  const walk = (file: string) => {
    const stat = fs.lstatSync(file); expect(stat.mode & 0o077).toBe(0);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(file, name));
    else expect(stat.mode & 0o777).toBe(0o600);
  };
  walk(root);
}
function liveTarget(root: string, label = "destination"): string { return path.join(mkdir(path.join(root, label)), ID); }

describe("full-profile encrypted artifact: actual cold disk round trips", () => {
  it("writes, directly queries, encrypts, decrypts and restores Chromium login/state/history databases and persistent SW/blob state into two independent directories", async () => {
    const root = tmp(), options = captureOptions(root); chromium(options.profileDir);
    const original = readAll(options.profileDir);
    expect(query(path.join(options.profileDir, "Default/Login Data"), "SELECT username_value FROM logins WHERE origin_url='https://fixture.example.test'")[0].username_value).toBe("fake-user");
    expect(query(path.join(options.profileDir, "Default/Cookies"), "SELECT value FROM cookies WHERE name='fixture_session'")[0].value).toBe("SYNTHETIC_COOKIE");
    const artifact = { options, ...await captureFullProfile({ ...options, extraEntries: [{ path: "credentials/wrapped-capsule.bin", data: Buffer.from("already-encrypted-synthetic-capsule") }] }) };
    const stored = put(root, "remote-object.bin", artifact.body);
    expect(digest(fs.readFileSync(stored))).toBe(artifact.descriptor.sha256);
    expect(fs.statSync(stored).size).toBe(artifact.descriptor.size);
    expect(artifact.body.includes(Buffer.from("SYNTHETIC_COOKIE"))).toBe(false);
    expect(artifact.body.includes(Buffer.from("fake-user"))).toBe(false);
    expect(JSON.stringify(artifact.descriptor)).not.toMatch(/passphrase|Login Data|SYNTHETIC|wrapped-capsule/);
    const incoming = await prepare({ ...artifact, body: fs.readFileSync(stored) });
    expect(incoming.locallyDerived).toBe(false); expect(incoming.sourceManifest).toBe(incoming.manifest);
    expectPrivate(path.dirname(incoming.directory));
    expect(fs.readFileSync(path.join(incoming.extraDirectory!, "credentials/wrapped-capsule.bin"), "utf8")).toBe("already-encrypted-synthetic-capsule");
    const selected = Object.fromEntries(incoming.manifest.files.map((file) => [file.path, file.sha256]));
    for (const relative of ["Default/Login Data", "Default/Cookies", "Default/Network/Cookies", "Local State", "Default/History", "Default/Local Storage/leveldb/000001.log", "Default/IndexedDB/https_fixture.example.test_0.indexeddb.leveldb/000002.ldb", "Default/Service Worker/CacheStorage/fixture-hash/response", "Default/Service Worker/ScriptCache/installed-script", "Default/blob_storage/fixture-blob/blob", "Default/Session Storage/000003.log", "Default/Sessions/Session_123"]) expect(selected[relative]).toBe(original[relative]);
    for (const relative of ["Default/Cache/HTTP", "Default/Code Cache/js/code", "Default/GPUCache/gpu", "ShaderCache/shader", "SingletonLock", "DevToolsActivePort", "Default/Local Storage/leveldb/LOCK"]) expect(selected[relative]).toBeUndefined();
    expect(fs.readdirSync(options.stagingDir).some((name) => name.startsWith("full-profile-capture-"))).toBe(false);
    const first = liveTarget(root, "machine-A"), second = liveTarget(root, "machine-B");
    const a = restorePreparedFullProfile({ prepared: incoming, profileDir: first, backupSuffix: ".previous", guard });
    const b = restorePreparedFullProfile({ prepared: incoming, profileDir: second, backupSuffix: ".previous", guard });
    expect(a.files).toBe(incoming.files); expect(b.bytes).toBe(incoming.bytes);
    for (const directory of [first, second]) {
      expect(readAll(directory)).toEqual(selected);
      expect(query(path.join(directory, "Default/Login Data"), "SELECT username_value,hex(password_value) AS cipher FROM logins WHERE origin_url='https://fixture.example.test'")[0]).toMatchObject({ username_value: "fake-user", cipher: "76313066616B652D636970686572" });
      expect(query(path.join(directory, "Default/History"), "SELECT title FROM urls WHERE url LIKE '%/saved'")[0].title).toBe("Synthetic saved page");
      expect(fs.readFileSync(path.join(directory, "Default/Service Worker/CacheStorage/fixture-hash/response"), "utf8")).toContain("offline-cache-key=");
      expect(fs.readFileSync(path.join(directory, "Default/blob_storage/fixture-blob/blob"), "utf8")).toContain("blob-key=");
      expect(fs.existsSync(path.join(directory, "Default/empty-persistent-directory"))).toBe(true);
      expect(fs.existsSync(path.join(directory, "manifest.json"))).toBe(false); expect(fs.existsSync(path.join(directory, "extras"))).toBe(false);
      expectPrivate(directory);
    }
    put(first, "local-only", "machine-A-only"); expect(fs.existsSync(path.join(second, "local-only"))).toBe(false);
    expect(readAll(options.profileDir)).toEqual(original);
  });

  it("moves Firefox logins with its paired key4 DB, site storage/CacheStorage/blob, preferences and sessionstore intact and searchable", async () => {
    const root = tmp(), options = captureOptions(root, { engine: "firefox", sourcePlatform: "win32", browserVersion: "154.0.fixture" }); firefox(options.profileDir);
    const original = readAll(options.profileDir), artifact = { options, ...await captureFullProfile(options) };
    expect(query(path.join(options.profileDir, "key4.db"), "SELECT id FROM metadata WHERE id='password'")[0].id).toBe("password");
    const incoming = await prepare(artifact), destination = liveTarget(root);
    restorePreparedFullProfile({ prepared: incoming, profileDir: destination, backupSuffix: ".previous", guard });
    expect(artifact.descriptor.sourcePlatform).toBe("win32");
    expect(incoming.manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining(["logins.json", "key4.db", "cookies.sqlite", "places.sqlite", "prefs.js", "sessionstore.jsonlz4", "sessionstore-backups/recovery.jsonlz4", "storage/default/https+++fixture.example.test/cache/caches.sqlite", "storage/default/https+++fixture.example.test/idb/blob/1"]));
    const login = JSON.parse(fs.readFileSync(path.join(destination, "logins.json"), "utf8")).logins[0]; expect(login.encryptedPassword).toBe("FAKE_ENCRYPTED_PASSWORD");
    expect(query(path.join(destination, "key4.db"), "SELECT hex(item1) AS key_fixture FROM metadata WHERE id='password'")[0].key_fixture).toBe("66616B65");
    expect(query(path.join(destination, "storage/default/https+++fixture.example.test/idb/store.sqlite"), "SELECT value FROM object_data WHERE key='offline-key'")[0].value).toBe("synthetic-ff-offline-value");
    expect(query(path.join(destination, "storage/default/https+++fixture.example.test/cache/caches.sqlite"), "SELECT value FROM cache_entries WHERE key='response-key'")[0].value).toBe("persistent-response");
    expect(fs.readFileSync(path.join(destination, "prefs.js"), "utf8")).toContain("fixture.persisted");
    for (const relative of ["cache2", "startupCache", "parent.lock"]) expect(fs.existsSync(path.join(destination, relative))).toBe(false);
    expect(readAll(options.profileDir)).toEqual(original);
  });

  it("preserves a synthetic committed SQLite WAL together with its main/SHM/journal group and can query the restored transaction", async () => {
    const root = tmp(), options = captureOptions(root), writer = path.join(root, "synthetic-writer.sqlite"), db = new DatabaseSync(writer);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE logins(origin_url TEXT,username_value TEXT); INSERT INTO logins VALUES('https://wal.example.test','wal-user');");
      for (const suffix of ["", "-wal", "-shm"]) put(options.profileDir, "Default/Login Data" + suffix, fs.readFileSync(writer + suffix));
    } finally { db.close(); }
    put(options.profileDir, "Default/Login Data-journal", Buffer.alloc(0));
    put(options.profileDir, "Local State", '{"fixture":"synthetic-wal-group"}');
    const original = readAll(options.profileDir), artifact = { options, ...await captureFullProfile(options) }, incoming = await prepare(artifact), target = liveTarget(root);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) expect(incoming.manifest.files.find((file) => file.path === "Default/Login Data" + suffix)!.sha256).toBe(original["Default/Login Data" + suffix]);
    restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard });
    expect(readAll(target)).toEqual(original);
    expect(query(path.join(target, "Default/Login Data"), "SELECT username_value FROM logins WHERE origin_url='https://wal.example.test'")[0].username_value).toBe("wal-user");
    expect(readAll(options.profileDir)).toEqual(original);
  });

  it("uses independent random salt/IV and content-addressed encrypted objects, not deterministic plaintext ZIP keys", async () => {
    const first = await simpleBundle(), second = await captureFullProfile(first.options);
    expect(second.body).not.toEqual(first.body); expect(second.descriptor.key).not.toBe(first.descriptor.key);
    expect(parseFullProfileArtifact(first.descriptor)).toEqual(first.descriptor);
    expect(unpack(first).header.salt).not.toBe(unpack(second).header.salt); expect(unpack(first).header.iv).not.toBe(unpack(second).header.iv);
    expect(first.descriptor.format).toBe(FULL_PROFILE_FORMAT); expect(first.descriptor.key).toBe(`full-profile-v1-${digest(first.body)}.bin`);
  });
});

describe("full-profile authentication, identity and archive rejection", () => {
  it("rejects a wrong password without creating a plaintext workspace", async () => {
    const bundle = await simpleBundle(), before = fs.readdirSync(bundle.options.stagingDir);
    await expect(prepare(bundle, { passphrase: "wrong migration password" })).rejects.toMatchObject({ code: "FULL_PROFILE_DECRYPTION_FAILED" });
    expect(fs.readdirSync(bundle.options.stagingDir)).toEqual(before);
  });
  it("rejects tampering by both outer digest and GCM even if the untrusted descriptor digest is recomputed", async () => {
    const bundle = await simpleBundle(), body = Buffer.from(bundle.body); body[body.length - 20] ^= 1;
    await expect(prepare(bundle, { body })).rejects.toThrow(/digest\/size/);
    await expect(prepare(bundle, { body, descriptor: descriptorFor(body, bundle.descriptor) })).rejects.toMatchObject({ code: "FULL_PROFILE_DECRYPTION_FAILED" });
    expect(fs.readdirSync(bundle.options.stagingDir)).toEqual([]);
  });
  it.each(["dirId", "engine", "snapshotId", "sourcePlatform", "createdAt"])("binds %s across the descriptor, AAD header and manifest", async (field) => {
    const bundle = await simpleBundle();
    const patches: Record<string, unknown> = { dirId: "another-profile", engine: "firefox", snapshotId: "another-snapshot", sourcePlatform: "linux", createdAt: bundle.descriptor.createdAt + 1 };
    const descriptor = { ...bundle.descriptor, [field]: patches[field] };
    await expect(prepare(bundle, { descriptor: descriptor as FullProfileArtifact })).rejects.toThrow(/identity|engine|snapshot/);
    if (field === "snapshotId") await expect(prepare(bundle, { snapshotId: "expected-other-snapshot" })).rejects.toThrow(/snapshot/);
  });
  it("rejects caller id/engine confusion and malformed/content-unaddressed descriptors", async () => {
    const bundle = await simpleBundle();
    await expect(prepare(bundle, { dirId: "another-profile" })).rejects.toThrow(/identity/);
    await expect(prepare(bundle, { engine: "firefox" })).rejects.toThrow(/engine/);
    for (const patch of [{ key: "../escape.bin" }, { dirId: "../profile" }, { snapshotId: "bad/snapshot" }, { size: MAX_FULL_PROFILE_BODY_BYTES + 1 }, { sha256: "A".repeat(64) }, { passphrase: "must-not-be-in-descriptor" }]) expect(parseFullProfileArtifact({ ...bundle.descriptor, ...patch })).toBeNull();
  });
  it("rejects overlong headers and attacker-selected KDF cost before derivation", async () => {
    const bundle = await simpleBundle(), bad = Buffer.from(bundle.body); bad.writeUInt32BE(4097, 8);
    await expect(prepare(bundle, { body: bad, descriptor: descriptorFor(bad, bundle.descriptor) })).rejects.toThrow(/header bounds/);
    const poisoned = seal(bundle, unpack(bundle).zip, { kdf: "scrypt-1073741824-8-1" });
    await expect(prepare(bundle, poisoned)).rejects.toThrow(/algorithm/);
  });
  it.each(["short", "x".repeat(1025)])("bounds the independent passphrase in UTF-8 bytes (%s)", async (passphrase) => {
    const root = tmp(), options = captureOptions(root, { passphrase }); put(options.profileDir, "safe", "data");
    await expect(captureFullProfile(options)).rejects.toThrow(/12 to 1024 UTF-8 bytes/);
    expect(fs.readdirSync(options.stagingDir)).toEqual([]);
  });
  it("accepts a 12-byte UTF-8 passphrase without silently changing it", async () => {
    const root = tmp(), options = captureOptions(root, { passphrase: "迁移口令" }); put(options.profileDir, "数据", "synthetic-unicode-data");
    const bundle = { options, ...await captureFullProfile(options) }, incoming = await prepare(bundle, { passphrase: options.passphrase });
    expect(fs.readFileSync(path.join(incoming.directory, "数据"), "utf8")).toBe("synthetic-unicode-data");
  });
  it.each(["traversal", "duplicate", "special"])("rejects authenticated malicious ZIP %s before profile application", async (kind) => {
    const bundle = await simpleBundle(); let { zip } = unpack(bundle);
    if (kind === "traversal") zip = replaceBytes(zip, "profile/safe.txt", "../evil/safe.txt");
    if (kind === "duplicate") zip = replaceBytes(zip, "profile/next.txt", "profile/safe.txt");
    if (kind === "special") {
      zip = Buffer.from(zip); const end = zip.length - 22; let offset = zip.readUInt32LE(end + 16);
      while (zip.readUInt32LE(offset) === 0x02014b50) {
        const length = zip.readUInt16LE(offset + 28), name = zip.subarray(offset + 46, offset + 46 + length).toString();
        if (name === "profile/safe.txt") { zip.writeUInt32LE(0x10000000, offset + 38); break; }
        offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
      }
    }
    await expect(prepare(bundle, seal(bundle, zip))).rejects.toThrow(/unsafe|duplicate|special|conflict/i);
    expect(fs.readdirSync(bundle.options.stagingDir)).toEqual([]); expect(fs.existsSync(path.join(bundle.root, "evil"))).toBe(false);
  });
  it.each(["extra", "missing", "mismatched-bytes", "manifest-snapshot", "manifest-duplicate-key"])("rejects a validly encrypted archive with %s", async (kind) => {
    const bundle = await simpleBundle();
    const hostile = await repack(bundle, (entries) => {
      if (kind === "extra") return [...entries, { name: "profile/extra.txt", data: Buffer.from("unexpected") }];
      if (kind === "missing") return entries.filter((entry) => entry.name !== "profile/safe.txt");
      return entries.map((entry) => {
        if (kind === "mismatched-bytes" && entry.name === "profile/safe.txt") return { name: entry.name, data: Buffer.from("X".repeat("SYNTHETIC_PRIVATE_STATE".length)) };
        if (entry.name !== "manifest.json" || !("data" in entry)) return entry;
        const manifest = JSON.parse(entry.data!.toString());
        if (kind === "manifest-snapshot") return { name: entry.name, data: Buffer.from(canonical({ ...manifest, snapshotId: "other-snapshot" })) };
        if (kind === "manifest-duplicate-key") return { name: entry.name, data: Buffer.from(canonical(manifest).replace(/^\{/, '{"format":"shadowed",')) };
        return entry;
      });
    });
    await expect(prepare(bundle, hostile)).rejects.toThrow(/extra|missing|mismatch|identity|snapshot|noncanonical|duplicate/i);
    expect(fs.readdirSync(bundle.options.stagingDir)).toEqual([]);
  });
  it("enforces the 1GiB expansion budget from headers without allocating a bomb", async () => {
    const bundle = await simpleBundle(), archive = path.join(bundle.root, "bomb-headers.zip");
    await writeZipArchive(archive, ["a", "b", "c"].map((name) => ({ name, data: Buffer.from("x") })));
    const zip = fs.readFileSync(archive), end = zip.length - 22; let central = zip.readUInt32LE(end + 16);
    for (let i = 0; i < 3; i++) {
      const local = zip.readUInt32LE(central + 42); zip.writeUInt16LE(8, local + 8); zip.writeUInt32LE(512 * 1024 * 1024, local + 22);
      zip.writeUInt16LE(8, central + 10); zip.writeUInt32LE(512 * 1024 * 1024, central + 24);
      central += 46 + zip.readUInt16LE(central + 28);
    }
    await expect(prepare(bundle, seal(bundle, zip))).rejects.toThrow(/expansion limit/);
    expect(fs.readdirSync(bundle.options.stagingDir)).toEqual([]);
  });
  it("bounds archive entry count, path depth/length and duplicate/aliased extra namespaces", async () => {
    const bundle = await simpleBundle(), zip = Buffer.from(unpack(bundle).zip); zip.writeUInt16LE(MAX_FULL_PROFILE_ENTRIES + 1, zip.length - 22 + 10);
    await expect(prepare(bundle, seal(bundle, zip))).rejects.toThrow(/entry count/);
    for (const extras of [
      [{ path: "../escape", data: Buffer.from("x") }],
      [{ path: Array(MAX_FULL_PROFILE_DEPTH + 1).fill("nested").join("/"), data: Buffer.from("x") }],
      [{ path: "x".repeat(256), data: Buffer.from("x") }],
      [{ path: "capsule", data: Buffer.from("a") }, { path: "CAPSULE", data: Buffer.from("b") }],
      [{ path: "a/left", data: Buffer.from("a") }, { path: "A/right", data: Buffer.from("b") }],
    ]) await expect(captureFullProfile({ ...bundle.options, extraEntries: extras })).rejects.toThrow();
  });
});

describe("full-profile cold-source and owned-path safety", () => {
  it.each(["normal", "cache", "lock"])("fails closed on source symlinks, including excluded %s names, without following them", async (kind) => {
    const root = tmp(), options = captureOptions(root), sentinel = put(root, "outside-synthetic-sentinel", "DO_NOT_READ_OR_CHANGE");
    const relative = kind === "cache" ? "Default/Cache" : kind === "lock" ? "SingletonLock" : "linked";
    mkdir(path.dirname(path.join(options.profileDir, relative))); fs.symlinkSync(sentinel, path.join(options.profileDir, relative));
    await expect(captureFullProfile(options)).rejects.toThrow(/symlink|special/i);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("DO_NOT_READ_OR_CHANGE"); expect(fs.readdirSync(options.stagingDir)).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("fails closed on special files instead of omitting them", async () => {
    const root = tmp(), options = captureOptions(root), fifo = path.join(options.profileDir, "fifo");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" }); expect(made.status, made.stderr).toBe(0);
    await expect(captureFullProfile(options)).rejects.toThrow(/special/);
  });
  it("rejects symlink staging paths and staging nested in the source", async () => {
    const root = tmp(), options = captureOptions(root), actual = mkdir(path.join(root, "actual-stage")), linked = path.join(root, "linked-stage");
    put(options.profileDir, "safe", "data"); fs.symlinkSync(actual, linked);
    await expect(captureFullProfile({ ...options, stagingDir: linked })).rejects.toThrow(/symlink/);
    await expect(captureFullProfile({ ...options, stagingDir: mkdir(path.join(options.profileDir, "nested-stage")) })).rejects.toThrow(/outside the source/);
    expect(fs.readdirSync(actual)).toEqual([]);
  });
  it.each([".queued-cookie-imports.json", ".sqlite-localstorage-backup-unknown", ".history-backup-unknown", ".leveldb-backup-unknown", ".profile-archive-recovery", ".restore-unknown"])("never hides unresolved queue/recovery material %s", async (name) => {
    const root = tmp(), options = captureOptions(root);
    if (name.includes("cookie")) put(options.profileDir, name, "{invalid queued Cookie"); else put(options.profileDir, `${name}/old`, "must-retain");
    await expect(captureFullProfile(options)).rejects.toThrow(/queue|recovery/i);
    expect(fs.existsSync(path.join(options.profileDir, name))).toBe(true); expect(fs.readdirSync(options.stagingDir)).toEqual([]);
  });
  it("rejects Firefox login files without a key database and obvious wrong-engine layouts", async () => {
    const root = tmp(), options = captureOptions(root, { engine: "firefox" }); put(options.profileDir, "logins.json", '{"logins":[]}');
    await expect(captureFullProfile(options)).rejects.toThrow(/paired key/);
    await expect(captureFullProfile({ ...options, engine: "chromium" })).rejects.toThrow(/engine\/layout/);
  });
  it.each(["changed-file", "added-file"])("detects %s while ZIP writing yields, rather than returning an incomplete snapshot", async (kind) => {
    const root = tmp(), options = captureOptions(root); put(options.profileDir, "safe", Buffer.alloc(128 * 1024, 7));
    setImmediate(() => put(options.profileDir, kind === "changed-file" ? "safe" : "added", "new-source-state"));
    await expect(captureFullProfile(options)).rejects.toThrow(/changed|unstable/i);
    expect(fs.readFileSync(path.join(options.profileDir, kind === "changed-file" ? "safe" : "added"), "utf8")).toBe("new-source-state");
    expect(fs.readdirSync(options.stagingDir)).toEqual([]);
  });
  it("checks a mandatory synchronous running/config guard before scan and after awaits", async () => {
    const root = tmp(), options = captureOptions(root); put(options.profileDir, "safe", Buffer.alloc(128 * 1024, 9));
    await expect(captureFullProfile({ ...options, guard: () => { throw new Error("PROFILE_RUNNING"); } })).rejects.toThrow("PROFILE_RUNNING");
    await expect(captureFullProfile({ ...options, guard: (async () => undefined) as () => void })).rejects.toThrow(/synchronous/);
    let running = false; setImmediate(() => { running = true; });
    await expect(captureFullProfile({ ...options, guard: () => { if (running) throw new Error("PROFILE_RUNNING_AFTER_AWAIT"); } })).rejects.toThrow("PROFILE_RUNNING_AFTER_AWAIT");
    expect(fs.readdirSync(options.stagingDir)).toEqual([]);
  });
  it("aborts before and during derivation without publishing prepared plaintext", async () => {
    const bundle = await simpleBundle(), controller = new AbortController(); controller.abort();
    await expect(prepare(bundle, { signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" });
    const during = new AbortController(); setImmediate(() => during.abort());
    await expect(prepare(bundle, { signal: during.signal })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(fs.readdirSync(bundle.options.stagingDir)).toEqual([]);
  });
  it("retains the original failure and a real cleanup failure, rather than claiming success", async () => {
    const root = tmp(), options = captureOptions(root); put(options.profileDir, "safe", "data");
    let running = false; setImmediate(() => { running = true; });
    const original = fs.rmSync;
    vi.spyOn(fsMutable, "rmSync").mockImplementation((file, opts) => {
      if (String(file).includes("full-profile-capture-")) throw Object.assign(new Error("SYNTHETIC_CLEANUP_EIO"), { code: "EIO" });
      return original(file, opts);
    });
    syncBuiltinESMExports();
    await expect(captureFullProfile({ ...options, guard: () => { if (running) throw new Error("ORIGINAL_RUNTIME_FAILURE"); } })).rejects.toThrow(/ORIGINAL_RUNTIME_FAILURE.*cleanup failed.*SYNTHETIC_CLEANUP_EIO/);
    expect(fs.readdirSync(options.stagingDir).some((name) => name.startsWith("full-profile-capture-"))).toBe(true);
    expect(fs.readFileSync(path.join(options.profileDir, "safe"), "utf8")).toBe("data");
  });
});

describe("full-profile staged replacement, rollback and local conversion", () => {
  it("keeps both source and original target, swaps from the same parent, and rolls back without erasing the incoming copy", async () => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root);
    put(target, "old.txt", "original-target-data"); const old = readAll(target), source = readAll(bundle.options.profileDir);
    const result = restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard });
    expect(readAll(result.backupDir!)).toEqual(old); expect(fs.readFileSync(path.join(target, "safe.txt"), "utf8")).toBe("SYNTHETIC_PRIVATE_STATE");
    result.rollback(); expect(readAll(target)).toEqual(old); expect(fs.existsSync(result.backupDir!)).toBe(false);
    expect(path.dirname(result.rollbackDir!)).toBe(path.dirname(target)); expect(fs.readFileSync(path.join(result.rollbackDir!, "safe.txt"), "utf8")).toBe("SYNTHETIC_PRIVATE_STATE");
    result.rollback(); expect(readAll(target)).toEqual(old); expect(readAll(bundle.options.profileDir)).toEqual(source);
  });
  it("rolls back a newly created profile by retaining it and restoring original absence", async () => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root);
    const result = restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard });
    expect(result.backupDir).toBeUndefined(); result.rollback(); expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(result.rollbackDir!, "next.txt"), "utf8")).toBe("second-value");
  });
  it.each(["EIO", "EXDEV"])("rolls back a failed install rename (%s), preserves the original error and never fakes a cross-device atomic fallback", async (code) => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root); put(target, "old.txt", "original-target");
    const original = fs.renameSync;
    vi.spyOn(fsMutable, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".full-profile-stage-") && to === target) throw Object.assign(new Error(`SYNTHETIC_INSTALL_${code}`), { code });
      return original(from, to);
    });
    syncBuiltinESMExports();
    expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard })).toThrow(`SYNTHETIC_INSTALL_${code}`);
    expect(fs.readFileSync(path.join(target, "old.txt"), "utf8")).toBe("original-target"); expect(fs.existsSync(target + ".previous")).toBe(false);
    expect(fs.readdirSync(path.dirname(target))).toEqual([ID]);
  });
  it("does not delete or overwrite an existing unknown backup, symlink target, or earlier transaction directory", async () => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root); put(target, "old.txt", "original-target");
    put(target + ".previous", "unknown.txt", "unknown-backup");
    expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard })).toThrow(/already exists/);
    expect(fs.readFileSync(path.join(target + ".previous", "unknown.txt"), "utf8")).toBe("unknown-backup");
    const other = liveTarget(bundle.root, "symlink-target"); fs.symlinkSync(target, other);
    expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: other, backupSuffix: ".previous", guard })).toThrow(/unsafe|symlink/i);
    const final = liveTarget(bundle.root, "earlier-transaction"), transaction = mkdir(path.join(path.dirname(final), `.${ID}.full-profile-stage-unknown`)); put(transaction, "retained.txt", "unknown-transaction");
    expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: final, backupSuffix: ".previous", guard })).toThrow(/earlier.*staging/);
    expect(fs.readFileSync(path.join(transaction, "retained.txt"), "utf8")).toBe("unknown-transaction");
    expect(fs.readFileSync(path.join(target, "old.txt"), "utf8")).toBe("original-target");
  });
  it("leaves all copies for recovery and never automatically mutates live again when a running guard changes after the old rename", async () => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root); put(target, "old.txt", "original-target");
    let failure: any;
    try { restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard: () => { if (fs.existsSync(target + ".previous")) throw new Error("PROFILE_STARTED"); } }); }
    catch (cause) { failure = cause; }
    expect(failure).toMatchObject({ code: "FULL_PROFILE_RECOVERY_REQUIRED" }); expect(failure.message).toMatch(/guard changed/);
    expect(fs.readFileSync(path.join(target + ".previous", "old.txt"), "utf8")).toBe("original-target"); expect(fs.existsSync(target)).toBe(false);
    const retained = fs.readdirSync(path.dirname(target)).find((name) => name.startsWith(`.${ID}.full-profile-stage-`));
    expect(fs.readFileSync(path.join(path.dirname(target), retained!, "safe.txt"), "utf8")).toBe("SYNTHETIC_PRIVATE_STATE");
  });
  it("retains both copies even if an after-install guard fails only once", async () => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root); put(target, "old", "original"); let failedOnce = false;
    expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard: () => {
      if (!failedOnce && fs.existsSync(target + ".previous") && fs.existsSync(path.join(target, "safe.txt"))) { failedOnce = true; throw new Error("TRANSIENT_GENERATION_CHANGE"); }
    } })).toThrow(/guard changed/);
    expect(failedOnce).toBe(true); expect(fs.readFileSync(path.join(target + ".previous", "old"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(target, "safe.txt"), "utf8")).toBe("SYNTHETIC_PRIVATE_STATE");
  });
  it("refuses a planted staging parent symlink before any payload can be written through it", async () => {
    const root = tmp(), options = captureOptions(root); put(options.profileDir, "nested/payload", "synthetic-payload");
    const bundle = { options, ...await captureFullProfile(options) }, incoming = await prepare(bundle), target = liveTarget(root), outside = mkdir(path.join(root, "outside-owned-sentinel"));
    put(target, "old", "original"); let planted = false;
    expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard: () => {
      const name = fs.readdirSync(path.dirname(target)).find((child) => child.startsWith(`.${ID}.full-profile-stage-`));
      const nested = name && path.join(path.dirname(target), name, "nested");
      if (!planted && nested && fs.existsSync(nested)) { planted = true; fs.renameSync(nested, nested + "-retained"); fs.symlinkSync(outside, nested); }
    } })).toThrow(/symlink|unsafe/i);
    expect(planted).toBe(true); expect(fs.readdirSync(outside)).toEqual([]); expect(fs.readFileSync(path.join(target, "old"), "utf8")).toBe("original");
  });
  it("retains an unknown target that appears mid-restore and reports recovery instead of clobbering it during rollback", async () => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root); put(target, "old.txt", "original-target"); let planted = false;
    expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard: () => {
      if (!planted && fs.existsSync(target + ".previous") && !fs.existsSync(target)) { planted = true; put(target, "foreign.txt", "foreign-new-data"); }
    } })).toThrow(/rollback failed.*retained for recovery/);
    expect(fs.readFileSync(path.join(target, "foreign.txt"), "utf8")).toBe("foreign-new-data"); expect(fs.readFileSync(path.join(target + ".previous", "old.txt"), "utf8")).toBe("original-target");
  });
  it("refuses rollback after guard or directory ownership changes, preserving the old and new copies", async () => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root); put(target, "old", "original"); let running = false;
    const result = restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard: () => { if (running) throw new Error("RUNNING"); } });
    running = true; expect(() => result.rollback()).toThrow(/manual resolution/);
    expect(fs.readFileSync(path.join(target + ".previous", "old"), "utf8")).toBe("original"); expect(fs.readFileSync(path.join(target, "safe.txt"), "utf8")).toBe("SYNTHETIC_PRIVATE_STATE");
    running = false; fs.renameSync(target, target + ".moved-by-other-writer"); put(target, "foreign", "must-not-delete");
    expect(() => result.rollback()).toThrow(/manual resolution/); expect(fs.readFileSync(path.join(target, "foreign"), "utf8")).toBe("must-not-delete");
  });
  it("rejects forged preparations, unsealed file changes, and extra files before touching the old target", async () => {
    const bundle = await simpleBundle(), incoming = await prepare(bundle), target = liveTarget(bundle.root); put(target, "old", "original");
    expect(() => restorePreparedFullProfile({ prepared: { ...incoming } as PreparedFullProfile, profileDir: target, backupSuffix: ".previous", guard })).toThrow(/unknown\/consumed/i);
    put(incoming.directory, "safe.txt", "modified");
    expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard })).toThrow(/manifest/);
    put(incoming.directory, "extra.txt", "not-in-manifest");
    expect(() => resealPreparedFullProfile({ prepared: incoming, changedPaths: ["safe.txt", "extra.txt"], guard })).toThrow(/unowned/);
    expect(fs.readFileSync(path.join(target, "old"), "utf8")).toBe("original"); expect(fs.existsSync(target + ".previous")).toBe(false);
  });
  it("explicitly reseals only declared existing password/state files and sidecar removals, keeping the source manifest immutable and the old token invalid", async () => {
    const root = tmp(), options = captureOptions(root); chromium(options.profileDir); put(options.profileDir, "Default/Login Data-journal", Buffer.alloc(0));
    const bundle = { options, ...await captureFullProfile(options) }, incoming = await prepare(bundle), sourceManifest = incoming.manifest;
    const converted = new DatabaseSync(path.join(incoming.directory, "Default/Login Data"));
    try { converted.exec("UPDATE logins SET password_value=X'6C6F63616C2D636970686572' WHERE username_value='fake-user'"); } finally { converted.close(); }
    put(incoming.directory, "Local State", '{"os_crypt":{"fixture":"local-wrapped-only"}}');
    if (fs.existsSync(path.join(incoming.directory, "Default/Login Data-journal"))) fs.unlinkSync(path.join(incoming.directory, "Default/Login Data-journal"));
    expect(() => resealPreparedFullProfile({ prepared: incoming, changedPaths: ["Local State"], guard })).toThrow(/unapproved/i);
    const sealed = resealPreparedFullProfile({ prepared: incoming, changedPaths: ["Local State", "Default/Login Data", "Default/Login Data-journal"], guard });
    expect(sealed.locallyDerived).toBe(true); expect(sealed.sourceManifest).toBe(sourceManifest); expect(incoming.manifest).toBe(sourceManifest);
    expect(sealed.manifest.files.find((file) => file.path === "Default/Login Data")!.sha256).not.toBe(sourceManifest.files.find((file) => file.path === "Default/Login Data")!.sha256);
    const target = liveTarget(root); expect(() => restorePreparedFullProfile({ prepared: incoming, profileDir: target, backupSuffix: ".previous", guard })).toThrow(/consumed/);
    restorePreparedFullProfile({ prepared: sealed, profileDir: target, backupSuffix: ".previous", guard });
    expect(query(path.join(target, "Default/Login Data"), "SELECT hex(password_value) AS cipher FROM logins WHERE username_value='fake-user'")[0].cipher).toBe("6C6F63616C2D636970686572");
    expect(query(path.join(options.profileDir, "Default/Login Data"), "SELECT hex(password_value) AS cipher FROM logins WHERE username_value='fake-user'")[0].cipher).toBe("76313066616B652D636970686572");
    expect(fs.readFileSync(path.join(target, "Local State"), "utf8")).toContain("local-wrapped-only");
  });
  it("does not let local resealing change capsule bytes or profile directories", async () => {
    const bundle = await simpleBundle(), artifact = { ...bundle, ...await captureFullProfile({ ...bundle.options, extraEntries: [{ path: "capsule.bin", data: Buffer.from("synthetic-encrypted-capsule") }] }) };
    const incoming = await prepare(artifact); put(incoming.extraDirectory!, "capsule.bin", "tampered");
    expect(() => resealPreparedFullProfile({ prepared: incoming, changedPaths: [], guard })).toThrow(/manifest/);
    const plain = await prepare(bundle); mkdir(path.join(plain.directory, "new-directory"));
    expect(() => resealPreparedFullProfile({ prepared: plain, changedPaths: [], guard })).toThrow(/directories/);
  });
});
