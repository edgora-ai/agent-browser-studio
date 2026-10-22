import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  convertProfileCredentials, createBasicChromiumAdapter, createChromiumKeyCredentialAdapter, disposeConvertedProfileCredentials,
  identityForManagedProfile, inspectProfileCredentials, openCredentialKeyCapsule, sealCredentialKeyCapsule,
  type CredentialCryptoAdapter, type CredentialCryptoContext, type CredentialIdentity, type ProfileCredentialOptions,
} from "../../src/main/services/sync/profile-credentials.js";

// All fixtures are newly generated fake logins and random keys. No Electron,
// real browser/profile, keychain, DPAPI, licence, network or source app is run.
const roots: string[] = [], adapters: CredentialCryptoAdapter[] = [];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytes = (file: string) => fs.readFileSync(file);
const fakePassword = Buffer.from("synthetic-only-password-λ-𝄞");
const fakeNote = Buffer.from("synthetic-only-password-note");
const fakeCookie = Buffer.from("synthetic-only-cookie-value");
const fakeMetadata = Buffer.from([8, 1, 18, 3, 0, 127, 255]);
const fakeHost = ".synthetic.invalid";
function own(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "profile-credentials-")); fs.chmodSync(root, 0o700); roots.push(root); return root;
}
function staging(): { root: string; options: ProfileCredentialOptions } {
  const root = own(), full = path.join(root, "full-profile"); fs.mkdirSync(path.join(full, "Default"), { recursive: true, mode: 0o700 });
  return { root, options: { stagingRoot: full, stagingOwner: fs.lstatSync(full), profileRelativePath: "Default", source: identityForManagedProfile("chromium", "linux", "synthetic-source") } };
}
function context(identity: CredentialIdentity, relativePath = "Default/Login Data", column = "password_value", table = "logins"): CredentialCryptoContext {
  return { identity, relativePath, table, column, rowId: "1", databaseVersion: table === "cookies" ? 24 : 43, ...(table === "cookies" ? { cookieHost: fakeHost } : {}) };
}
function basic(platform: "darwin" | "linux", id = "synthetic-source"): CredentialCryptoAdapter {
  const adapter = createBasicChromiumAdapter(identityForManagedProfile("chromium", platform, id)); adapters.push(adapter); return adapter;
}
function randomAdapter(platform: "win32" | "linux" | "darwin", algorithm: "aes-128-cbc" | "aes-256-gcm", id: string) {
  const key = randomBytes(algorithm === "aes-128-cbc" ? 16 : 32), identity: CredentialIdentity = { engine: "chromium", platform, identityId: id, backend: "chromium-provided-key", algorithm, keyId: "random-" + id };
  const adapter = createChromiumKeyCredentialAdapter({ identity, key }); adapters.push(adapter); return { adapter, identity, key };
}
function meta(db: DatabaseSync, version: number): void {
  db.exec("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY,value LONGVARCHAR); ");
  const s = db.prepare("INSERT INTO meta VALUES(?,?)"); s.run("version", String(version)); s.run("last_compatible_version", String(version));
}
async function seedLogin(file: string, adapter: CredentialCryptoAdapter, options: { wal?: boolean; empty?: boolean; appBound?: boolean; osReference?: boolean; auxiliary?: boolean } = {}): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const seed = options.wal ? path.join(own(), "wal-source.sqlite") : file, db = new DatabaseSync(seed);
  try {
    if (options.wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    meta(db, 43);
    db.exec("CREATE TABLE logins(id INTEGER PRIMARY KEY AUTOINCREMENT,origin_url VARCHAR NOT NULL,username_value VARCHAR,password_value BLOB,keychain_identifier BLOB);");
    const encrypted = options.empty ? Buffer.alloc(0) : options.appBound ? Buffer.concat([Buffer.from("v20"), randomBytes(48)]) : await adapter.encrypt(fakePassword, context(adapter.identity));
    db.prepare("INSERT INTO logins(origin_url,username_value,password_value,keychain_identifier) VALUES(?,?,?,?)").run("https://synthetic.invalid/login", "synthetic-user", encrypted, options.osReference ? randomBytes(16) : Buffer.alloc(0));
    if (options.auxiliary) {
      db.exec("CREATE TABLE password_notes(id INTEGER PRIMARY KEY,parent_id INTEGER,key VARCHAR,value BLOB,date_created INTEGER,confidential INTEGER); CREATE TABLE sync_entities_metadata(storage_key INTEGER PRIMARY KEY,metadata VARCHAR NOT NULL); CREATE TABLE sync_model_metadata(id INTEGER PRIMARY KEY,model_metadata VARCHAR NOT NULL);");
      const note = await adapter.encrypt(fakeNote, context(adapter.identity, "Default/Login Data", "value", "password_notes"));
      const metadata = await adapter.encrypt(fakeMetadata, context(adapter.identity, "Default/Login Data", "metadata", "sync_entities_metadata"));
      // Real Chromium inserts encrypted note/sync metadata as SQLite TEXT. CAST
      // preserves arbitrary ciphertext bytes; tests must not UTF-8 roundtrip it.
      db.prepare("INSERT INTO password_notes VALUES(1,1,'note',CAST(? AS TEXT),1,1)").run(note);
      db.prepare("INSERT INTO sync_entities_metadata VALUES(1,CAST(? AS TEXT))").run(metadata);
      db.prepare("INSERT INTO sync_model_metadata VALUES(1,?)").run("synthetic-unencrypted-model-state");
    }
    if (options.wal) {
      for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(seed + suffix)) fs.copyFileSync(seed + suffix, file + suffix, fs.constants.COPYFILE_EXCL);
    }
  } finally { db.close(); }
}
async function seedCookies(file: string, adapter: CredentialCryptoAdapter, options: { version?: number; plaintext?: boolean; wrongHost?: boolean; conflict?: boolean; empty?: boolean } = {}): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const db = new DatabaseSync(file), version = options.version ?? 24;
  try {
    meta(db, version); db.exec("CREATE TABLE cookies(host_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL);");
    const clear = options.empty ? Buffer.alloc(0) : fakeCookie, payload = version >= 24 ? Buffer.concat([createHash("sha256").update(options.wrongHost ? ".wrong.invalid" : fakeHost).digest(), clear]) : clear;
    const encrypted = options.plaintext ? Buffer.alloc(0) : await adapter.encrypt(payload, context(adapter.identity, "Default/Network/Cookies", "encrypted_value", "cookies"));
    db.prepare("INSERT INTO cookies VALUES(?,?,?,?,?)").run(fakeHost, "synthetic-session", options.plaintext || options.conflict ? clear.toString() : "", encrypted, "/");
  } finally { db.close(); }
}
function fileOf(options: ProfileCredentialOptions, name = "Login Data"): string { return path.join(options.stagingRoot, options.profileRelativePath, name); }
function unchangedInventory(options: ProfileCredentialOptions): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of ["Login Data", "Login Data For Account", "Cookies", "Network/Cookies", "key4.db", "logins.json"]) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) { const file = fileOf(options, name + suffix); if (fs.existsSync(file)) map.set(name + suffix, digest(bytes(file))); }
  }
  return map;
}
function assertUnchanged(options: ProfileCredentialOptions, before: Map<string, string>): void {
  const after = unchangedInventory(options); expect(after.size).toBe(before.size); for (const [name, hash] of before) expect(after.get(name) === hash).toBe(true);
}
async function expectCode(operation: Promise<unknown> | (() => unknown), code: string | RegExp): Promise<void> {
  let caught: unknown;
  try { if (typeof operation === "function") await operation(); else await operation; } catch (error) { caught = error; }
  // Deliberately do not print errors/adapters/plaintexts/keys in failed tests.
  expect(Boolean(caught)).toBe(true); const actual = (caught as { code?: unknown })?.code;
  expect(typeof actual === "string" && (typeof code === "string" ? actual === code : code.test(actual))).toBe(true);
}
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose?.(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }); });

describe("native Chromium credential codecs and separate encrypted key capsules", () => {
  it.each(["linux", "darwin"] as const)("matches independent public Chromium %s basic encryption parameters", async platform => {
    const adapter = basic(platform), key = pbkdf2Sync(platform === "darwin" ? "mock_password" : "peanuts", "saltysalt", platform === "darwin" ? 1003 : 1, 16, "sha1");
    try {
      const expectedKey = platform === "darwin" ? "af0f762aaf6d7d11581b7aa8ce7218de" : "fd621fe5a2b402539dfa147ca9272778";
      expect(key.toString("hex") === expectedKey).toBe(true);
      const native = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20)), expected = Buffer.concat([Buffer.from("v10"), native.update(fakePassword), native.final()]);
      const encrypted = await adapter.encrypt(fakePassword, context(adapter.identity)); expect(encrypted.equals(expected)).toBe(true);
      const clear = await adapter.decrypt(expected, context(adapter.identity)); expect(clear.equals(fakePassword)).toBe(true); clear.fill(0);
      const independent = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20)), readback = Buffer.concat([independent.update(encrypted.subarray(3)), independent.final()]);
      expect(readback.equals(fakePassword)).toBe(true); readback.fill(0);
    } finally { key.fill(0); }
  });
  it("requires explicit source identity/platform and never substitutes the host or Linux key for Mac", async () => {
    await expectCode(() => identityForManagedProfile("chromium", undefined as never, "source"), "IDENTITY_INVALID");
    await expectCode(() => identityForManagedProfile("chromium", "darwin", undefined as never), "IDENTITY_INVALID");
    await expectCode(() => createBasicChromiumAdapter(identityForManagedProfile("chromium", "win32", "source")), "UNSUPPORTED_BACKEND");
    const source = basic("darwin"), target = basic("linux", "receiver"), encrypted = await source.encrypt(fakePassword, context(source.identity));
    await expectCode(() => target.decrypt(encrypted, context(source.identity)), "ADAPTER_IDENTITY_MISMATCH");
    await expectCode(() => target.decrypt(encrypted, context(target.identity)), "DECRYPT_FAILED");
  });
  it("authenticates random-key native GCM and rejects corrupt/unknown/AppBound ciphertext without empty fallback", async () => {
    const { adapter, key } = randomAdapter("win32", "aes-256-gcm", "random-source");
    try {
      const encrypted = await adapter.encrypt(fakePassword, context(adapter.identity)), clear = await adapter.decrypt(encrypted, context(adapter.identity)); expect(clear.equals(fakePassword)).toBe(true); clear.fill(0);
      const corrupt = Buffer.from(encrypted); corrupt[corrupt.length - 1] ^= 1;
      await expectCode(() => adapter.decrypt(corrupt, context(adapter.identity)), "DECRYPT_FAILED");
      await expectCode(() => adapter.decrypt(Buffer.alloc(0), context(adapter.identity)), "CRYPTO_FORMAT_UNSUPPORTED");
      await expectCode(() => adapter.decrypt(Buffer.concat([Buffer.from("v20"), randomBytes(40)]), context(adapter.identity)), "APP_BOUND_UNSUPPORTED");
      adapter.dispose?.(); await expectCode(() => adapter.encrypt(fakePassword, context(adapter.identity)), "ADAPTER_DISPOSED");
    } finally { key.fill(0); }
  });
  it("seals native keys only in an independently password-encrypted, identity/snapshot-bound capsule", async () => {
    const { adapter, identity, key } = randomAdapter("win32", "aes-256-gcm", "capsule-source"), password = randomBytes(32), wrong = randomBytes(32), binding = { snapshotId: "synthetic-snapshot", profileId: "synthetic-profile" };
    try {
      const capsule = sealCredentialKeyCapsule({ identity, key, binding, migrationPassword: password }); expect(capsule.includes(key)).toBe(false);
      const reopened = openCredentialKeyCapsule({ capsule, expectedSource: identity, binding, migrationPassword: password }); adapters.push(reopened);
      const cipher = await adapter.encrypt(fakePassword, context(identity)), clear = await reopened.decrypt(cipher, context(identity)); expect(clear.equals(fakePassword)).toBe(true); clear.fill(0);
      await expectCode(() => openCredentialKeyCapsule({ capsule, expectedSource: identity, binding, migrationPassword: wrong }), "CAPSULE_AUTHENTICATION_FAILED");
      await expectCode(() => openCredentialKeyCapsule({ capsule, expectedSource: identity, binding: { ...binding, snapshotId: "wrong-snapshot" }, migrationPassword: password }), "CAPSULE_BINDING_MISMATCH");
      await expectCode(() => openCredentialKeyCapsule({ capsule, expectedSource: { ...identity, platform: "darwin" }, binding, migrationPassword: password }), "IDENTITY_INVALID");
      const wrongPlatform = Buffer.from(capsule), platformOffset = wrongPlatform.indexOf(Buffer.from("win32")); expect(platformOffset >= 0).toBe(true); wrongPlatform.write("linux", platformOffset);
      await expectCode(() => openCredentialKeyCapsule({ capsule: wrongPlatform, expectedSource: identity, binding, migrationPassword: password }), "CAPSULE_BINDING_MISMATCH");
      const corrupt = Buffer.from(capsule); corrupt[corrupt.length - 1] ^= 128;
      await expectCode(() => openCredentialKeyCapsule({ capsule: corrupt, expectedSource: identity, binding, migrationPassword: password }), "CAPSULE_AUTHENTICATION_FAILED");
      await expectCode(() => sealCredentialKeyCapsule({ identity, key, binding, migrationPassword: Buffer.alloc(0) }), "MIGRATION_PASSWORD_INVALID");
    } finally { key.fill(0); password.fill(0); wrong.fill(0); }
  });
});

describe("owned staging source-to-receiver SQLite credential conversion", () => {
  it.each([["darwin", "linux"], ["linux", "darwin"]] as const)("restores %s -> %s native Login Data/account DBs, notes, sync ciphertext and both Cookie paths", async (sourcePlatform, targetPlatform) => {
    const { options, root } = staging(), source = basic(sourcePlatform), receiver = basic(targetPlatform, "synthetic-receiver"); options.source = source.identity; options.sourceAdapter = source;
    await seedLogin(fileOf(options), source, { auxiliary: true }); await seedLogin(fileOf(options, "Login Data For Account"), source);
    await seedCookies(fileOf(options, "Cookies"), source); await seedCookies(fileOf(options, "Network/Cookies"), source);
    const original = unchangedInventory(options), inspected = await inspectProfileCredentials(options); expect(inspected.status).toBe("source-verified");
    const converted = await convertProfileCredentials({ ...options, receiver: receiver.identity, receiverAdapter: receiver });
    expect(converted.report.verification).toBe("receiver-sql-decrypt"); expect(converted.replacements.length).toBe(4); assertUnchanged(options, original);
    const restored = path.join(root, "receiver-full-profile"); fs.mkdirSync(restored, { mode: 0o700 });
    for (const member of converted.replacements) {
      expect(digest(bytes(member.outputPath)) === member.sha256).toBe(true);
      const target = path.join(restored, member.relativePath); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(member.outputPath, target, fs.constants.COPYFILE_EXCL);
    }
    for (const name of ["Login Data", "Login Data For Account"]) {
      const db = new DatabaseSync(path.join(restored, "Default", name), { readOnly: true });
      try {
        const row = db.prepare("SELECT id,password_value FROM logins WHERE origin_url=? AND username_value=?").get("https://synthetic.invalid/login", "synthetic-user")!;
        expect(Number(row.id)).toBe(1); const clear = await receiver.decrypt(Buffer.from(row.password_value as Uint8Array), context(receiver.identity)); expect(clear.equals(fakePassword)).toBe(true); clear.fill(0);
        const oldCipher = new DatabaseSync(fileOf(options, name), { readOnly: true }); try { const old = oldCipher.prepare("SELECT password_value FROM logins").get()!; expect(Buffer.from(old.password_value as Uint8Array).equals(Buffer.from(row.password_value as Uint8Array))).toBe(false); } finally { oldCipher.close(); }
        if (name === "Login Data") {
          for (const [table, column, expected] of [["password_notes", "value", fakeNote], ["sync_entities_metadata", "metadata", fakeMetadata]] as const) {
            const encrypted = db.prepare(`SELECT CAST(${column} AS BLOB) AS cipher,typeof(${column}) AS storage FROM ${table}`).get()!;
            expect(encrypted.storage).toBe("text"); const clear = await receiver.decrypt(Buffer.from(encrypted.cipher as Uint8Array), context(receiver.identity, "Default/Login Data", column, table)); expect(clear.equals(expected)).toBe(true); clear.fill(0);
          }
          expect(db.prepare("SELECT model_metadata FROM sync_model_metadata WHERE id=1").get()!.model_metadata === "synthetic-unencrypted-model-state").toBe(true);
        }
      } finally { db.close(); }
    }
    for (const name of ["Cookies", "Network/Cookies"]) {
      const db = new DatabaseSync(path.join(restored, "Default", name), { readOnly: true });
      try {
        const row = db.prepare("SELECT host_key,value,encrypted_value FROM cookies WHERE name=?").get("synthetic-session")!; expect(row.value === "").toBe(true);
        const clear = await receiver.decrypt(Buffer.from(row.encrypted_value as Uint8Array), context(receiver.identity, "Default/" + name, "encrypted_value", "cookies"));
        expect(clear.subarray(0, 32).equals(createHash("sha256").update(fakeHost).digest())).toBe(true); expect(clear.subarray(32).equals(fakeCookie)).toBe(true); clear.fill(0);
      } finally { db.close(); }
    }
    expect(converted.report.hardwarePasskeys).toBe("not-portable");
    expect(JSON.stringify(converted.report).includes(fakePassword.toString())).toBe(false);
  });
  it("converts committed WAL rows with distinct random source/receiver keys, preserves old main/WAL/SHM, and explicitly removes stale receiver sidecars", async () => {
    const { options, root } = staging(), a = randomAdapter("win32", "aes-256-gcm", "wal-source"), b = randomAdapter("win32", "aes-256-gcm", "wal-receiver");
    options.source = a.identity; options.sourceAdapter = a.adapter;
    try {
      await seedLogin(fileOf(options), a.adapter, { wal: true }); const before = unchangedInventory(options);
      expect(before.has("Login Data-wal")).toBe(true); expect(before.has("Login Data-shm")).toBe(true);
      const result = await convertProfileCredentials({ ...options, receiver: b.identity, receiverAdapter: b.adapter }); assertUnchanged(options, before);
      expect(result.removeRelativePaths.sort()).toEqual(["Default/Login Data-shm", "Default/Login Data-wal"]);
      const restored = path.join(root, "restored"); fs.mkdirSync(path.join(restored, "Default"), { recursive: true, mode: 0o700 });
      for (const suffix of ["", "-wal", "-shm"]) fs.copyFileSync(fileOf(options) + suffix, path.join(restored, "Default/Login Data") + suffix, fs.constants.COPYFILE_EXCL);
      for (const member of result.replacements) fs.copyFileSync(member.outputPath, path.join(restored, member.relativePath));
      for (const relative of result.removeRelativePaths) fs.unlinkSync(path.join(restored, relative));
      const db = new DatabaseSync(path.join(restored, "Default/Login Data"), { readOnly: true });
      try {
        const row = db.prepare("SELECT password_value FROM logins WHERE username_value=?").get("synthetic-user")!; expect(Boolean(row)).toBe(true);
        const cipher = Buffer.from(row.password_value as Uint8Array), clear = await b.adapter.decrypt(cipher, context(b.identity)); expect(clear.equals(fakePassword)).toBe(true); clear.fill(0);
        await expectCode(() => a.adapter.decrypt(cipher, context(a.identity)), "DECRYPT_FAILED");
      } finally { db.close(); }
    } finally { a.key.fill(0); b.key.fill(0); }
  });
  it("uses an encrypted source capsule with a different receiver random key and verifies restored SQL", async () => {
    const { options } = staging(), a = randomAdapter("win32", "aes-256-gcm", "capsule-a"), b = randomAdapter("linux", "aes-128-cbc", "capsule-b"), password = randomBytes(32), binding = { snapshotId: "test-snapshot", profileId: "test-profile" };
    try {
      await seedLogin(fileOf(options), a.adapter); options.source = a.identity;
      const capsule = sealCredentialKeyCapsule({ identity: a.identity, key: a.key, migrationPassword: password, binding });
      const portableSource = openCredentialKeyCapsule({ capsule, expectedSource: a.identity, migrationPassword: password, binding }); adapters.push(portableSource);
      const converted = await convertProfileCredentials({ ...options, sourceAdapter: portableSource, receiver: b.identity, receiverAdapter: b.adapter });
      const db = new DatabaseSync(converted.replacements[0].outputPath, { readOnly: true });
      try { const row = db.prepare("SELECT password_value FROM logins WHERE id=1").get()!; const clear = await b.adapter.decrypt(Buffer.from(row.password_value as Uint8Array), context(b.identity)); expect(clear.equals(fakePassword)).toBe(true); clear.fill(0); } finally { db.close(); }
    } finally { a.key.fill(0); b.key.fill(0); password.fill(0); }
  });
  it.each([23, 24])("encrypts existing plaintext/empty Cookie values without writing a plaintext export, schema v%s", async version => {
    const { options } = staging(), source = basic("linux"), receiver = basic("darwin", "receiver"); options.sourceAdapter = source;
    await seedCookies(fileOf(options, "Cookies"), source, { version, plaintext: true }); await seedCookies(fileOf(options, "Network/Cookies"), source, { version, plaintext: true, empty: true });
    const result = await convertProfileCredentials({ ...options, receiver: receiver.identity, receiverAdapter: receiver });
    for (const member of result.replacements) {
      const db = new DatabaseSync(member.outputPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT value,encrypted_value FROM cookies WHERE name='synthetic-session'").get()!; expect(row.value === "").toBe(true);
        const clear = await receiver.decrypt(Buffer.from(row.encrypted_value as Uint8Array), context(receiver.identity, member.relativePath, "encrypted_value", "cookies"));
        expect(clear.subarray(version >= 24 ? 32 : 0).equals(member.relativePath.includes("Network") ? Buffer.alloc(0) : fakeCookie)).toBe(true); clear.fill(0);
      } finally { db.close(); }
    }
    expect(result.report.databases.reduce((n, d) => n + d.plaintextCookies, 0)).toBe(1);
  });
  it("does not call an absent or unsupported codec successful/empty, but preserves genuinely empty stored fields", async () => {
    const { options } = staging(), source = basic("linux"), receiver = basic("darwin", "receiver"); await seedLogin(fileOf(options), source);
    expect((await inspectProfileCredentials(options)).status).toBe("source-codec-required");
    await expectCode(convertProfileCredentials({ ...options, receiver: receiver.identity, receiverAdapter: receiver }), "CRYPTO_ADAPTER_REQUIRED");
    const empty = staging(); empty.options.sourceAdapter = source; await seedLogin(fileOf(empty.options), source, { empty: true });
    const result = await convertProfileCredentials({ ...empty.options, receiver: receiver.identity, receiverAdapter: receiver }); expect(result.report.passwordUsability).toBe("no-stored-secrets");
    const db = new DatabaseSync(result.replacements[0].outputPath, { readOnly: true }); try { expect(db.prepare("SELECT length(password_value) AS n FROM logins").get()!.n).toBe(0); } finally { db.close(); }
  });
  it("reports actual absence without inventing a working Windows OS backend", async () => {
    const { options } = staging(); expect((await inspectProfileCredentials(options)).status).toBe("absent");
    await expectCode(convertProfileCredentials({ ...options, receiver: identityForManagedProfile("chromium", "win32", "receiver") }), "CRYPTO_ADAPTER_REQUIRED");
  });
  it.each(["app-bound", "os-reference", "wrong-host", "cookie-conflict", "bad-tag", "unknown-prefix"])("fails closed on %s, never substituting an empty password or modifying source", async fault => {
    const { options } = staging(), a = randomAdapter("win32", "aes-256-gcm", "reject-source"), b = randomAdapter("win32", "aes-256-gcm", "reject-target"); options.source = a.identity; options.sourceAdapter = a.adapter;
    try {
      if (fault === "wrong-host" || fault === "cookie-conflict") await seedCookies(fileOf(options, "Cookies"), a.adapter, { wrongHost: fault === "wrong-host", conflict: fault === "cookie-conflict" });
      else {
        await seedLogin(fileOf(options), a.adapter, { appBound: fault === "app-bound", osReference: fault === "os-reference" });
        if (fault === "bad-tag" || fault === "unknown-prefix") {
          const db = new DatabaseSync(fileOf(options)); try { const raw = Buffer.from(db.prepare("SELECT password_value FROM logins").get()!.password_value as Uint8Array); if (fault === "bad-tag") raw[raw.length - 1] ^= 1; else raw.write("v99"); db.prepare("UPDATE logins SET password_value=?").run(raw); } finally { db.close(); }
        }
      }
      const before = unchangedInventory(options), code = { "app-bound": "APP_BOUND_UNSUPPORTED", "os-reference": "OS_CREDENTIAL_REFERENCE_UNSUPPORTED", "wrong-host": "COOKIE_HOST_BINDING_MISMATCH", "cookie-conflict": "COOKIE_VALUES_CONFLICT", "bad-tag": "DECRYPT_FAILED", "unknown-prefix": "CRYPTO_FORMAT_UNSUPPORTED" }[fault]!;
      await expectCode(convertProfileCredentials({ ...options, receiver: b.identity, receiverAdapter: b.adapter }), code); assertUnchanged(options, before);
      expect(fs.readdirSync(options.stagingRoot).some(n => n.startsWith(".credentials-converted-"))).toBe(false);
    } finally { a.key.fill(0); b.key.fill(0); }
  });
  it("reopens SQL and rejects a receiver codec that encrypts under the wrong key", async () => {
    const { options } = staging(), source = basic("linux"), target = randomAdapter("win32", "aes-256-gcm", "intended-target"), wrong = randomAdapter("win32", "aes-256-gcm", "wrong-target"); options.sourceAdapter = source;
    try {
      await seedLogin(fileOf(options), source); const before = unchangedInventory(options);
      const broken: CredentialCryptoAdapter = { identity: target.identity, encryptedPrefixes: ["v10"], decrypt: target.adapter.decrypt.bind(target.adapter), encrypt: (clear, ctx) => wrong.adapter.encrypt(clear, { ...ctx, identity: wrong.identity }) };
      await expectCode(convertProfileCredentials({ ...options, receiver: target.identity, receiverAdapter: broken }), "DECRYPT_FAILED"); assertUnchanged(options, before);
    } finally { target.key.fill(0); wrong.key.fill(0); }
  });
  it("rejects caller adapters returning plaintext or secret-bearing errors without leaking their messages", async () => {
    const { options } = staging(), source = basic("linux"), receiver = basic("darwin", "receiver"); options.sourceAdapter = source; await seedLogin(fileOf(options), source);
    const broken: CredentialCryptoAdapter = { ...receiver, encrypt: () => { throw new Error("synthetic-secret-must-not-escape"); } };
    await expectCode(convertProfileCredentials({ ...options, receiver: receiver.identity, receiverAdapter: broken }), "ENCRYPT_FAILED");
    const plaintext: CredentialCryptoAdapter = { ...receiver, encrypt: clear => Buffer.from(clear) };
    await expectCode(convertProfileCredentials({ ...options, receiver: receiver.identity, receiverAdapter: plaintext }), "CRYPTO_FORMAT_UNSUPPORTED");
  });
  it("rejects mismatched adapter identity before decrypting", async () => {
    const { options } = staging(), source = basic("linux"), wrong = basic("linux", "wrong-source"); await seedLogin(fileOf(options), source);
    await expectCode(inspectProfileCredentials({ ...options, sourceAdapter: wrong }), "ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["truncated-main", "truncated-wal", "wal-checksum", "orphan-wal", "rollback-journal", "symlink", "hardlink", "owner", "path"])("refuses %s without treating corruption/unsafe paths as absence", async fault => {
    const { options, root } = staging(), source = basic("linux"); options.sourceAdapter = source;
    if (fault === "orphan-wal") fs.writeFileSync(fileOf(options) + "-wal", randomBytes(32), { mode: 0o600 });
    else await seedLogin(fileOf(options), source, { wal: fault.includes("wal") });
    if (fault === "truncated-main") fs.truncateSync(fileOf(options), 100);
    if (fault === "truncated-wal") fs.truncateSync(fileOf(options) + "-wal", 31);
    if (fault === "wal-checksum") { const raw = bytes(fileOf(options) + "-wal"); raw[raw.length - 1] ^= 1; fs.writeFileSync(fileOf(options) + "-wal", raw); }
    if (fault === "rollback-journal") fs.writeFileSync(fileOf(options) + "-journal", randomBytes(512));
    if (fault === "symlink") { fs.renameSync(fileOf(options), path.join(root, "not-a-profile.sqlite")); fs.symlinkSync(path.join(root, "not-a-profile.sqlite"), fileOf(options)); }
    if (fault === "hardlink") fs.linkSync(fileOf(options), path.join(root, "aliased.sqlite"));
    if (fault === "owner") options.stagingOwner = { dev: options.stagingOwner.dev, ino: options.stagingOwner.ino + 1 };
    if (fault === "path") options.profileRelativePath = "../outside";
    await expectCode(inspectProfileCredentials(options), /^(DATABASE_OR_WAL_INVALID|ORPHAN_DATABASE_SIDECAR|ROLLBACK_JOURNAL_UNSUPPORTED|STAGING_FILE_UNSAFE|STAGING_OWNER_MISMATCH|STAGING_PATH_INVALID)$/);
  });
  it.each(["trigger", "view", "virtual", "generated", "check", "expression-index", "partial-index", "unknown-table", "unknown-column", "future-version", "oversized-field"])("does not execute/admit source %s", async fault => {
    const { options } = staging(), source = basic("linux"); options.sourceAdapter = source; await seedLogin(fileOf(options), source);
    const db = new DatabaseSync(fileOf(options));
    try {
      if (fault === "trigger") db.exec("CREATE TRIGGER leak AFTER UPDATE ON logins BEGIN DELETE FROM logins; END;");
      if (fault === "view") db.exec("CREATE VIEW malicious AS SELECT * FROM logins;");
      if (fault === "virtual") db.exec("CREATE VIRTUAL TABLE malicious USING fts5(value);");
      if (fault === "generated") db.exec("ALTER TABLE logins ADD COLUMN sender_name TEXT GENERATED ALWAYS AS (username_value) VIRTUAL;");
      if (fault === "check") db.exec("CREATE TABLE stats(origin_domain TEXT CHECK(length(origin_domain)<100),username_value TEXT,dismissal_count INTEGER,update_time INTEGER);");
      if (fault === "expression-index") db.exec("CREATE INDEX expression_idx ON logins(lower(username_value));");
      if (fault === "partial-index") db.exec("CREATE INDEX partial_idx ON logins(username_value) WHERE id>0;");
      if (fault === "unknown-table") db.exec("CREATE TABLE unknown_passwords(value BLOB);");
      if (fault === "unknown-column") db.exec("ALTER TABLE logins ADD COLUMN encrypted_future_secret BLOB;");
      if (fault === "future-version") db.exec("UPDATE meta SET value='999' WHERE key='version';");
      if (fault === "oversized-field") db.prepare("UPDATE logins SET password_value=?").run(Buffer.alloc(1024 * 1024 + 1));
    } finally { db.close(); }
    const before = unchangedInventory(options); await expectCode(inspectProfileCredentials(options), /^(SCHEMA_UNSUPPORTED|DATABASE_VERSION_UNSUPPORTED|FIELD_INVALID)$/); assertUnchanged(options, before);
  });
  it("rechecks source absences and rejects a late account database instead of publishing an incomplete set", async () => {
    const { options } = staging(), source = basic("linux"), receiver = basic("darwin", "receiver"); await seedLogin(fileOf(options), source); let injected = false;
    options.sourceAdapter = { ...source, decrypt: async (cipher, ctx) => { const clear = await source.decrypt(cipher, ctx); if (!injected) { injected = true; fs.copyFileSync(fileOf(options), fileOf(options, "Login Data For Account"), fs.constants.COPYFILE_EXCL); } return clear; } };
    await expectCode(convertProfileCredentials({ ...options, receiver: receiver.identity, receiverAdapter: receiver }), "STAGING_CHANGED");
  });
  it("safely disposes the minted scratch handle before full-profile publication, ignoring edited path fields", async () => {
    const { options, root } = staging(), source = basic("linux"), receiver = basic("darwin", "receiver"); options.sourceAdapter = source; await seedLogin(fileOf(options), source);
    const original = unchangedInventory(options), result = await convertProfileCredentials({ ...options, receiver: receiver.identity, receiverAdapter: receiver }), output = result.outputDirectory;
    await expectCode(() => disposeConvertedProfileCredentials({ ...result }), "OUTPUT_HANDLE_INVALID");
    result.outputDirectory = root; disposeConvertedProfileCredentials(result);
    expect(fs.existsSync(output)).toBe(false); expect(fs.existsSync(root)).toBe(true); assertUnchanged(options, original);
    await expectCode(() => disposeConvertedProfileCredentials(result), "OUTPUT_HANDLE_INVALID");
  });
  it("recognizes a confirmed missing Default directory as absence without creating it", async () => {
    const { options } = staging(); fs.rmdirSync(path.join(options.stagingRoot, "Default"));
    expect((await inspectProfileCredentials(options)).status).toBe("absent"); expect(fs.existsSync(path.join(options.stagingRoot, "Default"))).toBe(false);
  });
  it("rejects native DPAPI-only blobs explicitly without attempting OS decryption", async () => {
    const { options } = staging(), source = basic("linux"); options.sourceAdapter = source; await seedLogin(fileOf(options), source);
    const db = new DatabaseSync(fileOf(options)); try { db.prepare("UPDATE logins SET password_value=?").run(Buffer.concat([Buffer.from("01000000d08c9ddf0115d1118c7a00c04fc297eb", "hex"), randomBytes(64)])); } finally { db.close(); }
    await expectCode(inspectProfileCredentials(options), "WINDOWS_DPAPI_UNSUPPORTED");
  });
  it("rejects invalid UTF-8 even when CBC padding succeeds", async () => {
    const { options } = staging(), source = basic("linux"); options.sourceAdapter = source; await seedLogin(fileOf(options), source);
    const invalid = await source.encrypt(Buffer.from([0xff]), context(source.identity)), db = new DatabaseSync(fileOf(options)); try { db.prepare("UPDATE logins SET password_value=?").run(invalid); } finally { db.close(); }
    await expectCode(inspectProfileCredentials(options), "PASSWORD_ENCODING_INVALID");
  });
  it("enforces a bounded row count before interpreting a large credential set", async () => {
    const { options } = staging(), source = basic("linux"); options.sourceAdapter = source; await seedLogin(fileOf(options), source, { empty: true });
    const db = new DatabaseSync(fileOf(options));
    try { db.exec("BEGIN;"); const insert = db.prepare("INSERT INTO logins(origin_url,username_value,password_value,keychain_identifier) VALUES('https://synthetic.invalid','synthetic-user',X'',X'')"); for (let i = 0; i < 50000; i++) insert.run(); db.exec("COMMIT;"); } finally { db.close(); }
    await expectCode(inspectProfileCredentials(options), "ROW_LIMIT");
  });
  it("honors caller guard/cancellation and leaves no half-converted output", async () => {
    const { options } = staging(), source = basic("linux"), receiver = basic("darwin", "receiver"); options.sourceAdapter = source; await seedLogin(fileOf(options), source);
    const abort = new AbortController(); abort.abort(); await expectCode(convertProfileCredentials({ ...options, signal: abort.signal, receiver: receiver.identity, receiverAdapter: receiver }), "CANCELLED");
    let rejected = false; try { await inspectProfileCredentials({ ...options, guard: () => { throw new Error("controlled-guard-stop"); } }); } catch { rejected = true; } expect(rejected).toBe(true);
    expect(fs.readdirSync(options.stagingRoot).some(n => n.startsWith(".credentials-"))).toBe(false);
  });
});

function der(tag: number, body: Buffer): Buffer {
  const length = body.length < 128 ? Buffer.from([body.length]) : body.length < 256 ? Buffer.from([129, body.length]) : Buffer.from([130, body.length >> 8, body.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
function fakeSdr(keyId: Buffer): string {
  const algorithm = der(0x30, Buffer.concat([der(6, Buffer.from("2a864886f70d0307", "hex")), der(4, randomBytes(8))]));
  return der(0x30, Buffer.concat([der(4, keyId), algorithm, der(4, randomBytes(16))])).toString("base64");
}
function seedFirefox(options: ProfileCredentialOptions, keyId: Buffer, loginId = keyId): void {
  const db = new DatabaseSync(fileOf(options, "key4.db"));
  try {
    db.exec("CREATE TABLE nssPrivate(id INTEGER PRIMARY KEY,a102 BLOB,a11 BLOB); CREATE TABLE metaData(id PRIMARY KEY UNIQUE ON CONFLICT REPLACE,item1,item2);");
    db.prepare("INSERT INTO nssPrivate VALUES(1,?,?)").run(keyId, randomBytes(64)); db.prepare("INSERT INTO metaData VALUES('password',?,?)").run(randomBytes(20), randomBytes(64));
  } finally { db.close(); }
  fs.writeFileSync(fileOf(options, "logins.json"), JSON.stringify({ version: 3, nextId: 2, logins: [{ id: 1, hostname: "https://synthetic.invalid", encType: 1, encryptedUsername: fakeSdr(loginId), encryptedPassword: fakeSdr(loginId) }] }), { mode: 0o600, flag: "wx" });
}
function firefoxStage() { const s = staging(); s.options.profileRelativePath = "."; s.options.source = identityForManagedProfile("firefox", "darwin", "synthetic-firefox"); return s; }
describe("Firefox NSS pair transport, explicitly not Primary Password or hardware unlock", () => {
  it("validates paired encrypted SDR key IDs and preserves authenticated logins/key4 bytes without claiming unlock", async () => {
    const { options } = firefoxStage(); seedFirefox(options, randomBytes(16)); const before = unchangedInventory(options), inspected = await inspectProfileCredentials(options);
    expect(inspected.verification).toBe("paired-files-only"); expect(inspected.passwordUsability).toBe("requires-firefox-nss-unlock"); expect(Boolean(inspected.firefoxPair)).toBe(true);
    const converted = await convertProfileCredentials({ ...options, expectedFirefoxPair: inspected.firefoxPair, receiver: identityForManagedProfile("firefox", "linux", "receiver-firefox") });
    expect(converted.report.status).toBe("paired-files-preserved"); expect(converted.report.passwordUsability).toBe("requires-firefox-nss-unlock"); expect(converted.replacements.length).toBe(2); assertUnchanged(options, before);
    for (const replacement of converted.replacements) expect(digest(bytes(replacement.outputPath)) === replacement.sha256).toBe(true);
    expect(converted.removeRelativePaths.length).toBe(0);
  });
  it("does not mistake shared NSS key IDs for proof of matching encrypted keys", async () => {
    const { options } = firefoxStage(), id = randomBytes(16); seedFirefox(options, id); const original = await inspectProfileCredentials(options);
    const db = new DatabaseSync(fileOf(options, "key4.db")); try { db.prepare("UPDATE nssPrivate SET a11=?").run(randomBytes(64)); } finally { db.close(); }
    await expectCode(convertProfileCredentials({ ...options, expectedFirefoxPair: original.firefoxPair, receiver: identityForManagedProfile("firefox", "linux", "receiver") }), "FIREFOX_PAIR_BINDING_MISMATCH");
  });
  it("matches pair manifests semantically even after canonical serialization reorders properties/members", async () => {
    const { options } = firefoxStage(); seedFirefox(options, randomBytes(16)); const inspected = await inspectProfileCredentials(options), pair = inspected.firefoxPair!;
    const reordered = { members: pair.members.slice().reverse().map(m => ({ bytes: m.bytes, sha256: m.sha256, relativePath: m.relativePath })), profileRelativePath: pair.profileRelativePath, source: { keyId: pair.source.keyId, algorithm: pair.source.algorithm, backend: pair.source.backend, identityId: pair.source.identityId, platform: pair.source.platform, engine: pair.source.engine }, version: 1 as const };
    const result = await convertProfileCredentials({ ...options, expectedFirefoxPair: reordered, receiver: identityForManagedProfile("firefox", "linux", "receiver") }); expect(result.report.verification).toBe("paired-files-only");
    disposeConvertedProfileCredentials(result);
  });
  it("requires authenticated source pair provenance at restore", async () => {
    const { options } = firefoxStage(); seedFirefox(options, randomBytes(16));
    await expectCode(convertProfileCredentials({ ...options, receiver: identityForManagedProfile("firefox", "linux", "receiver") }), "FIREFOX_SOURCE_PAIR_BINDING_REQUIRED");
  });
  it.each(["missing-key4", "missing-logins", "key-id-mismatch", "invalid-base64", "plaintext-login", "bad-nss-metadata"])("fails closed on Firefox %s", async fault => {
    const { options } = firefoxStage(); seedFirefox(options, randomBytes(16), fault === "key-id-mismatch" ? randomBytes(16) : undefined);
    if (fault === "missing-key4") fs.unlinkSync(fileOf(options, "key4.db"));
    if (fault === "missing-logins") fs.unlinkSync(fileOf(options, "logins.json"));
    if (fault === "invalid-base64" || fault === "plaintext-login") { const json = JSON.parse(bytes(fileOf(options, "logins.json")).toString()); if (fault === "invalid-base64") json.logins[0].encryptedPassword = "not base64"; else json.logins[0].encType = 0; fs.writeFileSync(fileOf(options, "logins.json"), JSON.stringify(json)); }
    if (fault === "bad-nss-metadata") { const db = new DatabaseSync(fileOf(options, "key4.db")); try { db.exec("DELETE FROM metaData;"); } finally { db.close(); } }
    await expectCode(inspectProfileCredentials(options), /^(FIREFOX_PAIR_INCOMPLETE|FIREFOX_NSS_KEY_MISMATCH|FIREFOX_LOGIN_INVALID|NSS_DATABASE_INVALID)$/);
  });
});
