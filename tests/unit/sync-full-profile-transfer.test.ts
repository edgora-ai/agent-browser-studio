import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import cryptoMutable from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { captureFullProfileTransfer, prepareFullProfileTransfer } from "../../src/main/services/sync/full-profile-transfer.js";
import { captureFullProfile, prepareFullProfile, restorePreparedFullProfile } from "../../src/main/services/sync/full-profile-artifact.js";
import { createBasicChromiumAdapter, identityForManagedProfile, type CredentialCryptoContext } from "../../src/main/services/sync/profile-credentials.js";

// Native DBs are generated here, not copied from a real app/profile. Opaque
// LevelDB/SW/session members prove exact whole-tree transport, not browser use.
const roots: string[] = [], sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ID = "owned_full_transfer", SNAPSHOT = "owned_transfer_snapshot", HOST = ".full-transfer.synthetic.invalid";
const PASSWORD = Buffer.from("synthetic-transfer-password-λ"), COOKIE = Buffer.from("synthetic-transfer-cookie"), PROXY_SECRET = "synthetic-proxy-secret-inside-ciphertext-only";
const PROFILE_HASH = sha(Buffer.from("synthetic-profile-configuration-v1"));
const retained = new Map([
  ["Default/IndexedDB/https_full-transfer.synthetic.invalid_0.indexeddb.leveldb/000003.log", Buffer.from("owned-indexeddb-record")],
  ["Default/Service Worker/CacheStorage/owned-cache/response", Buffer.from("owned-persistent-sw-cache-response")],
  ["Default/Service Worker/ScriptCache/script", Buffer.from("owned-sw-script")],
  ["Default/Session Storage/000003.log", Buffer.from("owned-session-storage-record")],
  ["Default/Sessions/Session_111", Buffer.from("owned-browser-session-tabs")],
  ["Default/Preferences", Buffer.from(JSON.stringify({ synthetic: true, homepage: "https://full-transfer.synthetic.invalid" }))],
]);
function put(root: string, relative: string, bytes: Buffer): void {
  const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
}
function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string, prefix = "") => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name), relative = prefix + name, stat = fs.lstatSync(file); if (stat.isDirectory()) visit(file, relative + "/"); else { if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe synthetic fixture"); out.set(relative, sha(fs.readFileSync(file))); } } };
  visit(root); return out;
}
function assertTree(root: string, expected: Map<string, string>): void { const actual = tree(root); expect(actual.size).toBe(expected.size); for (const [name, digest] of expected) expect(actual.get(name) === digest).toBe(true); }
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "full-profile-transfer-owned-")); fs.chmodSync(root, 0o700); roots.push(root);
  const source = path.join(root, "source"), stage = path.join(root, "staging"), target = path.join(root, "receiver", ID);
  for (const dir of [source, stage, path.dirname(target)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const passphrase = randomBytes(24).toString("base64url");
  const options = { dirId: ID, engine: "chromium" as const, snapshotId: SNAPSHOT, passphrase, stagingDir: stage, guard: () => undefined };
  return { root, source, stage, target, options };
}
function ctx(platform: "darwin" | "linux", relativePath = "Default/Login Data", cookies = false): CredentialCryptoContext {
  return { identity: identityForManagedProfile("chromium", platform, ID), relativePath, table: cookies ? "cookies" : "logins", column: cookies ? "encrypted_value" : "password_value", rowId: "1", databaseVersion: cookies ? 24 : 43, ...(cookies ? { cookieHost: HOST } : {}) };
}
async function seed(root: string, wal = false): Promise<void> {
  const adapter = createBasicChromiumAdapter(identityForManagedProfile("chromium", "darwin", ID));
  try {
    const encrypted = await adapter.encrypt(PASSWORD, ctx("darwin"));
    for (const name of ["Login Data", "Login Data For Account"]) {
      const relative = "Default/" + name, main = path.join(root, relative), generator = wal ? path.join(root, "generator-" + name.replaceAll(" ", "-") + ".db") : main;
      fs.mkdirSync(path.dirname(main), { recursive: true, mode: 0o700 }); const db = new DatabaseSync(generator);
      try {
        if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
        db.exec("CREATE TABLE meta(key TEXT NOT NULL UNIQUE PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('version','43'),('last_compatible_version','43'); CREATE TABLE logins(id INTEGER PRIMARY KEY,origin_url TEXT,username_value TEXT,password_value BLOB,keychain_identifier BLOB);");
        db.prepare("INSERT INTO logins VALUES(1,?,?,?,X'')").run("https://full-transfer.synthetic.invalid/login", "owned-transfer-user", encrypted);
        if (wal) for (const suffix of ["", "-wal", "-shm"]) fs.copyFileSync(generator + suffix, main + suffix, fs.constants.COPYFILE_EXCL);
      } finally { db.close(); }
      if (wal) fs.unlinkSync(generator);
    }
    const cookieFile = path.join(root, "Default/Network/Cookies"); fs.mkdirSync(path.dirname(cookieFile), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(cookieFile), payload = Buffer.concat([createHash("sha256").update(HOST).digest(), COOKIE]);
    try {
      const encrypted = await adapter.encrypt(payload, ctx("darwin", "Default/Network/Cookies", true));
      db.exec("CREATE TABLE meta(key TEXT NOT NULL UNIQUE PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('version','24'),('last_compatible_version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT);");
      db.prepare("INSERT INTO cookies VALUES(?,?,'',?,'/')").run(HOST, "owned-transfer-session", encrypted);
    } finally { payload.fill(0); db.close(); }
    for (const [relative, bytes] of retained) put(root, relative, bytes);
    const history = new DatabaseSync(path.join(root, "Default/History"));
    try { history.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER); INSERT INTO urls VALUES(1,'https://full-transfer.synthetic.invalid/history','owned history'); INSERT INTO visits VALUES(2,1,13300000000000000);"); } finally { history.close(); }
    put(root, "Default/Cache/transient", Buffer.from("temporary-browser-cache-not-required"));
    put(root, "Default/IndexedDB/https_full-transfer.synthetic.invalid_0.indexeddb.leveldb/LOCK", Buffer.alloc(0));
  } finally { adapter.dispose?.(); }
}
async function capture(f: ReturnType<typeof fixture>) {
  return captureFullProfileTransfer({ ...f.options, profileDir: f.source, sourcePlatform: "darwin", browserVersion: "152.synthetic", environment: { profileHash: PROFILE_HASH, proxy: { name: "synthetic-proxy", publicHash: sha(Buffer.from("synthetic-proxy-public")), username: "synthetic-proxy-user", password: PROXY_SECRET } } });
}
async function assertSql(root: string): Promise<void> {
  const adapter = createBasicChromiumAdapter(identityForManagedProfile("chromium", "linux", ID));
  try {
    for (const name of ["Login Data", "Login Data For Account"]) {
      const db = new DatabaseSync(path.join(root, "Default", name), { readOnly: true });
      try { const row = db.prepare("SELECT password_value FROM logins WHERE origin_url=? AND username_value=?").get("https://full-transfer.synthetic.invalid/login", "owned-transfer-user"); expect(Boolean(row)).toBe(true); const clear = await adapter.decrypt(Buffer.from(row!.password_value as Uint8Array), ctx("linux", "Default/" + name)); expect(clear.equals(PASSWORD)).toBe(true); clear.fill(0); } finally { db.close(); }
    }
    const cookies = new DatabaseSync(path.join(root, "Default/Network/Cookies"), { readOnly: true });
    try { const row = cookies.prepare("SELECT value,encrypted_value FROM cookies WHERE host_key=? AND name=?").get(HOST, "owned-transfer-session"); expect(Boolean(row)).toBe(true); expect(row!.value === "").toBe(true); const clear = await adapter.decrypt(Buffer.from(row!.encrypted_value as Uint8Array), ctx("linux", "Default/Network/Cookies", true)); expect(clear.subarray(0, 32).equals(createHash("sha256").update(HOST).digest())).toBe(true); expect(clear.subarray(32).equals(COOKIE)).toBe(true); clear.fill(0); } finally { cookies.close(); }
    const history = new DatabaseSync(path.join(root, "Default/History"), { readOnly: true });
    try { expect(Boolean(history.prepare("SELECT u.url FROM urls u JOIN visits v ON u.id=v.url WHERE u.url=?").get("https://full-transfer.synthetic.invalid/history"))).toBe(true); } finally { history.close(); }
  } finally { adapter.dispose?.(); }
}
async function rejects(operation: Promise<unknown>, code: string | RegExp): Promise<void> {
  let error: unknown; try { await operation; } catch (caught) { error = caught; }
  expect(Boolean(error)).toBe(true); const actual = (error as { code?: unknown })?.code; expect(typeof actual === "string" && (typeof code === "string" ? actual === code : code.test(actual))).toBe(true);
}
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }); });

describe("full-profile transfer coordinator with real native credential conversion", () => {
  it.each([
    { phase: "sealing", metadataCall: 3, fault: "cancel" }, { phase: "sealing", metadataCall: 3, fault: "guard" },
    { phase: "opening", metadataCall: 6, fault: "cancel" }, { phase: "opening", metadataCall: 6, fault: "guard" },
  ])("uses asynchronous metadata KDF and rejects $fault after $phase without masking guards or retaining key bytes", async ({ metadataCall, fault }) => {
    const f = fixture(); put(f.source, "Default/Preferences", Buffer.from("synthetic-source-preferences"));
    const before = tree(f.source), controller = new AbortController();
    let calls = 0, changed = false, timerRan = false, input: Buffer | undefined, derived: Buffer | undefined;
    const realScrypt = cryptoMutable.scrypt;
    const syncKdf = vi.spyOn(cryptoMutable, "scryptSync").mockImplementation(() => { throw new Error("Unexpected synchronous metadata KDF"); });
    vi.spyOn(cryptoMutable, "scrypt").mockImplementation(((password, salt, length, options, callback) => {
      const call = ++calls;
      return realScrypt(password, salt, length, options, (error, key) => {
        if (call !== metadataCall) { callback(error, key); return; }
        input = password as Buffer; derived = key;
        expect(options).toEqual({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        setImmediate(() => {
          timerRan = true;
          if (fault === "cancel") controller.abort(); else changed = true;
          callback(error, key);
        });
      });
    }) as typeof cryptoMutable.scrypt);
    syncBuiltinESMExports();
    const guard = () => { if (changed) throw Object.assign(new Error("Synthetic metadata scope changed"), { code: "SYNTHETIC_METADATA_SCOPE_CHANGED" }); };
    await expect(captureFullProfileTransfer({ ...f.options, guard, signal: controller.signal, profileDir: f.source,
      sourcePlatform: "darwin", environment: { profileHash: PROFILE_HASH } })).rejects.toMatchObject({
      code: fault === "cancel" ? "SYNC_CANCELLED" : "SYNTHETIC_METADATA_SCOPE_CHANGED",
    });
    expect(timerRan).toBe(true); expect(calls).toBe(metadataCall); expect(syncKdf).not.toHaveBeenCalled();
    expect(Buffer.isBuffer(input)).toBe(true); expect(input!.every(byte => byte === 0)).toBe(true);
    expect(Buffer.isBuffer(derived)).toBe(true); expect(derived!.every(byte => byte === 0)).toBe(true);
    assertTree(f.source, before);
  });

  it.each([false, true])("captures encrypted Mac profile and restores searchable Linux native DBs, original WAL=%s", async wal => {
    const f = fixture(); await seed(f.source, wal); const original = tree(f.source), captured = await capture(f), originalBody = sha(captured.body);
    expect(captured.body.includes(PASSWORD)).toBe(false); expect(captured.body.includes(Buffer.from(PROXY_SECRET))).toBe(false); expect(captured.body.includes(COOKIE)).toBe(false); assertTree(f.source, original);
    const result = await prepareFullProfileTransfer({ ...f.options, ...captured, receiverPlatform: "linux", profileHash: PROFILE_HASH });
    expect(result.credentials.verification).toBe("receiver-sql-decrypt"); expect(result.environment.proxy?.password === PROXY_SECRET).toBe(true); expect(sha(captured.body) === originalBody).toBe(true); assertTree(f.source, original);
    expect(result.prepared.locallyDerived).toBe(true);
    expect(result.prepared.manifest.files.some(m => m.path.includes(".credentials-") || m.path.includes(".credential-publish-") || m.path === "environment.bin")).toBe(false);
    expect(result.prepared.manifest.extraEntries.map(m => m.path)).toEqual(["environment.bin"]);
    expect(result.prepared.manifest.files.some(m => m.path === "Default/Cache/transient" || m.path.endsWith("/LOCK"))).toBe(false);
    if (wal) { expect(result.prepared.sourceManifest.files.some(m => m.path === "Default/Login Data-wal")).toBe(true); expect(result.prepared.manifest.files.some(m => /Login Data(?: For Account)?-(?:wal|shm)$/.test(m.path))).toBe(false); }
    fs.mkdirSync(f.target, { mode: 0o700 }); put(f.target, "receiver-only", Buffer.from("old-receiver-content")); const old = tree(f.target);
    const restored = restorePreparedFullProfile({ prepared: result.prepared, profileDir: f.target, backupSuffix: ".owned-backup", guard: f.options.guard });
    expect(Boolean(restored.backupDir)).toBe(true); assertTree(restored.backupDir!, old); await assertSql(f.target);
    for (const [relative, bytes] of retained) expect(fs.readFileSync(path.join(f.target, relative)).equals(bytes)).toBe(true);
    const installed = tree(f.target); expect([...installed.keys()].some(p => /environment\.bin|\.credentials-|\.credential-publish-/.test(p))).toBe(false);
    expect(fs.existsSync(path.join(f.target, "receiver-only"))).toBe(false); assertTree(f.source, original);
  });
  it.each(["phrase", "config-hash", "body", "descriptor"])("rejects wrong %s before changing the receiver or immutable input", async fault => {
    const f = fixture(); await seed(f.source); const captured = await capture(f), before = tree(f.source), bodyHash = sha(captured.body); fs.mkdirSync(f.target, { mode: 0o700 }); put(f.target, "old", Buffer.from("old-profile")); const old = tree(f.target);
    const body = Buffer.from(captured.body); if (fault === "body") body[body.length - 1] ^= 1;
    await rejects(prepareFullProfileTransfer({ ...f.options, ...captured, body, receiverPlatform: "linux", profileHash: fault === "config-hash" ? sha(Buffer.from("wrong-config")) : PROFILE_HASH,
      ...(fault === "phrase" ? { passphrase: randomBytes(24).toString("base64url") } : {}), ...(fault === "descriptor" ? { descriptor: { ...captured.descriptor, sourcePlatform: "linux" } } : {}) }),
      fault === "phrase" ? "FULL_PROFILE_DECRYPTION_FAILED" : fault === "config-hash" ? "FULL_PROFILE_CONFIG_MISMATCH" : "FULL_PROFILE_INVALID");
    expect(sha(captured.body) === bodyHash).toBe(true); assertTree(f.source, before); assertTree(f.target, old);
  });
  it("rejects a correctly authenticated outer artifact whose crypto identity disagrees with encrypted metadata", async () => {
    const f = fixture(); await seed(f.source); const captured = await capture(f), original = tree(f.source);
    const raw = await prepareFullProfile({ ...f.options, ...captured });
    const metadata = fs.readFileSync(path.join(raw.extraDirectory!, "environment.bin"));
    const rebound = await captureFullProfile({ ...f.options, profileDir: raw.directory, sourcePlatform: "linux", extraEntries: [{ path: "environment.bin", data: metadata }] });
    await rejects(prepareFullProfileTransfer({ ...f.options, ...rebound, receiverPlatform: "linux", profileHash: PROFILE_HASH }), "FULL_PROFILE_CREDENTIAL_IDENTITY_MISMATCH"); assertTree(f.source, original);
  });
  it.each(["source", "receiver"] as const)("refuses an unsupported Windows managed %s even when credentials are absent, instead of publishing an unusable transfer", async side => {
    const f = fixture(); fs.mkdirSync(path.join(f.source, "Default"), { mode: 0o700 }); const before = tree(f.source);
    if (side === "source") {
      await rejects(captureFullProfileTransfer({ ...f.options, profileDir: f.source, sourcePlatform: "win32", environment: { profileHash: PROFILE_HASH } }), /^(FULL_PROFILE_(?:PLATFORM|CREDENTIALS)_UNSUPPORTED|UNSUPPORTED_BACKEND|CRYPTO_ADAPTER_REQUIRED)$/);
    } else {
      const captured = await capture(f); await rejects(prepareFullProfileTransfer({ ...f.options, ...captured, receiverPlatform: "win32", profileHash: PROFILE_HASH }), /^(FULL_PROFILE_(?:PLATFORM|CREDENTIALS)_UNSUPPORTED|UNSUPPORTED_BACKEND|CRYPTO_ADAPTER_REQUIRED)$/);
    }
    assertTree(f.source, before);
  });
  it("does not turn v20/AppBound into an empty or allegedly portable password", async () => {
    const f = fixture(); await seed(f.source); const db = new DatabaseSync(path.join(f.source, "Default/Login Data"));
    try { db.prepare("UPDATE logins SET password_value=?").run(Buffer.concat([Buffer.from("v20"), randomBytes(48)])); } finally { db.close(); }
    const before = tree(f.source); await rejects(capture(f), "APP_BOUND_UNSUPPORTED"); assertTree(f.source, before);
  });
  it("rechecks caller guards across native preparation and leaves an existing receiver unchanged", async () => {
    const f = fixture(); await seed(f.source); const captured = await capture(f); fs.mkdirSync(f.target, { mode: 0o700 }); put(f.target, "old", Buffer.from("unchanged receiver")); const before = tree(f.target);
    const controller = new AbortController(); controller.abort(); await rejects(prepareFullProfileTransfer({ ...f.options, ...captured, signal: controller.signal, receiverPlatform: "linux", profileHash: PROFILE_HASH }), /^(ABORT_ERR|SYNC_CANCELLED)$/); assertTree(f.target, before);
  });
});

function tlv(tag: number, data: Buffer): Buffer { if (data.length >= 128) throw new Error("Synthetic DER length"); return Buffer.concat([Buffer.from([tag, data.length]), data]); }
function sdr(id: Buffer): string { return tlv(48, Buffer.concat([tlv(4, id), tlv(48, Buffer.concat([tlv(6, Buffer.from("2a864886f70d0307", "hex")), tlv(4, randomBytes(8))])), tlv(4, randomBytes(16))])).toString("base64"); }
describe("full-profile Firefox paired-file custody", () => {
  it("transports the authenticated original NSS pair without claiming Primary Password/hardware unlock", async () => {
    const f = fixture(), id = randomBytes(16), db = new DatabaseSync(path.join(f.source, "key4.db"));
    try { db.exec("CREATE TABLE nssPrivate(id INTEGER PRIMARY KEY,a102 BLOB,a11 BLOB); CREATE TABLE metaData(id PRIMARY KEY UNIQUE ON CONFLICT REPLACE,item1,item2);"); db.prepare("INSERT INTO nssPrivate VALUES(1,?,?)").run(id, randomBytes(64)); db.prepare("INSERT INTO metaData VALUES('password',?,?)").run(randomBytes(20), randomBytes(64)); } finally { db.close(); }
    put(f.source, "logins.json", Buffer.from(JSON.stringify({ version: 3, logins: [{ id: 1, encType: 1, encryptedUsername: sdr(id), encryptedPassword: sdr(id) }] })));
    const before = tree(f.source), options = { ...f.options, engine: "firefox" as const };
    const captured = await captureFullProfileTransfer({ ...options, profileDir: f.source, sourcePlatform: "darwin", environment: { profileHash: PROFILE_HASH } });
    const result = await prepareFullProfileTransfer({ ...options, ...captured, receiverPlatform: "linux", profileHash: PROFILE_HASH });
    expect(result.credentials.verification).toBe("paired-files-only"); expect(result.credentials.passwordUsability).toBe("requires-firefox-nss-unlock"); assertTree(result.prepared.directory, before); assertTree(f.source, before);
    expect(result.prepared.manifest.files.some(m => m.path === "environment.bin")).toBe(false);
  });
});
