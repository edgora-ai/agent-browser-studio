import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";

// Real credential code, real owned SQLite files/Workers and real synthetic-key
// crypto. Instrument only crypto call counts/time and the caller's guard; never
// start a browser, scan host processes, query a keychain or contact a service.
const h = vi.hoisted(() => ({
  active: false, sourceDecrypts: 0, receiverDecrypts: 0, encrypts: 0,
  clock: undefined as number | undefined,
  onCrypto: undefined as undefined | ((method: "decrypt" | "encrypt", algorithm: string) => void),
}));
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual,
    createDecipheriv: ((...args: Parameters<typeof actual.createDecipheriv>) => {
      const value = actual.createDecipheriv(...args);
      if (h.active) {
        if (args[0] === "aes-128-cbc") h.sourceDecrypts++; else h.receiverDecrypts++;
        h.onCrypto?.("decrypt", args[0]);
      }
      return value;
    }) as typeof actual.createDecipheriv,
    createCipheriv: ((...args: Parameters<typeof actual.createCipheriv>) => {
      const value = actual.createCipheriv(...args);
      if (h.active) { h.encrypts++; h.onCrypto?.("encrypt", args[0]); }
      return value;
    }) as typeof actual.createCipheriv,
  };
});
vi.mock("node:perf_hooks", async importOriginal => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return { ...actual, performance: { now: () => h.clock ?? actual.performance.now() } };
});
import {
  convertProfileCredentials, createBasicChromiumAdapter, createChromiumKeyCredentialAdapter,
  disposeConvertedProfileCredentials, identityForManagedProfile, inspectProfileCredentials,
  type CredentialCryptoAdapter, type ProfileCredentialOptions,
} from "../../src/main/services/sync/profile-credentials.js";

const owned: Array<{ root: string; owner: fs.Stats }> = [], adapters: CredentialCryptoAdapter[] = [];
const immediates = new Set<ReturnType<typeof setImmediate>>();
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function later(action: () => void): void {
  const handle = setImmediate(() => { immediates.delete(handle); action(); }); immediates.add(handle);
}
function ownedRoot(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "credential-responsive-")); fs.chmodSync(root, 0o700);
  owned.push({ root, owner: fs.lstatSync(root) }); return root;
}
function keep<T extends CredentialCryptoAdapter>(adapter: T): T { adapters.push(adapter); return adapter; }
function instrumentGuard(file: string) {
  const before = fs.lstatSync(file);
  let calls = 0, snapshots = 0, depth = 0, cached = false;
  const slices: Array<{ source: number; receiver: number; encrypts: number; guards: number }> = [];
  let onSlice: (() => void) | undefined;
  const guard = Object.assign(() => {
    calls++;
    // Model only lexical process discovery reuse; owner/DB witnesses are still
    // independently checked on every guard invocation, including post-await.
    if (!depth || !cached) { snapshots++; if (depth) cached = true; }
    const now = fs.lstatSync(file);
    if (now.dev !== before.dev || now.ino !== before.ino || now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs) {
      throw new Error("Synthetic credential DB witness changed");
    }
  }, {
    runSynchronous<T>(action: () => T): T {
      expect(depth, "credential process observation must not be nested or retained").toBe(0);
      const start = { source: h.sourceDecrypts, receiver: h.receiverDecrypts, encrypts: h.encrypts, guards: calls };
      depth++; onSlice?.();
      try {
        const value = action();
        expect(value != null && typeof (value as { then?: unknown }).then === "function", "a lexical process snapshot cannot span an await").toBe(false);
        return value;
      } finally {
        depth--; cached = false;
        slices.push({ source: h.sourceDecrypts - start.source, receiver: h.receiverDecrypts - start.receiver, encrypts: h.encrypts - start.encrypts, guards: calls - start.guards });
      }
    },
  });
  return { guard, slices, get calls() { return calls; }, get snapshots() { return snapshots; }, get inSlice() { return depth !== 0; },
    onSlice(action: () => void) { onSlice = action; } };
}
function fixture(rows = 4096, clearBytes = 64) {
  const stagingRoot = ownedRoot(); fs.mkdirSync(path.join(stagingRoot, "Default"), { mode: 0o700 });
  const source = keep(createBasicChromiumAdapter(identityForManagedProfile("chromium", "linux", "synthetic-batch-source")));
  const key = Buffer.alloc(32, 0x45), receiver = keep(createChromiumKeyCredentialAdapter({
    identity: { engine: "chromium", platform: "win32", identityId: "synthetic-batch-receiver", backend: "chromium-provided-key", algorithm: "aes-256-gcm", keyId: "synthetic-batch-key" }, key,
  })); key.fill(0);
  const file = path.join(stagingRoot, "Default", "Login Data"), db = new DatabaseSync(file);
  const clear = Buffer.alloc(clearBytes, 0x73); Buffer.from("synthetic-not-a-real-password").copy(clear);
  const encrypted = source.encrypt(clear, { identity: source.identity, relativePath: "Default/Login Data", table: "logins", column: "password_value", rowId: "1", databaseVersion: 43 }); clear.fill(0);
  if (!Buffer.isBuffer(encrypted)) throw new Error("Built-in seed codec unexpectedly asynchronous");
  try {
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('version','43'),('last_compatible_version','43'); CREATE TABLE logins(id INTEGER PRIMARY KEY,password_value BLOB); BEGIN;");
    const insert = db.prepare("INSERT INTO logins VALUES(?,?)"); for (let n = 1; n <= rows; n++) insert.run(n, encrypted);
    db.exec("COMMIT;");
  } finally { db.close(); }
  const probe = instrumentGuard(file), original = sha(file);
  const options: ProfileCredentialOptions = { stagingRoot, stagingOwner: fs.lstatSync(stagingRoot), profileRelativePath: "Default", source: source.identity, sourceAdapter: source, guard: probe.guard };
  return { options, source, receiver, file, probe, rows, original,
    convert(signal?: AbortSignal, sourceAdapter = source, receiverAdapter = receiver) {
      return convertProfileCredentials({ ...options, sourceAdapter, receiver: receiver.identity, receiverAdapter, signal });
    },
    unchanged() { expect(sha(file)).toBe(original); expect(fs.readdirSync(stagingRoot)).toEqual(["Default"]); },
  };
}
function activate(): void { h.sourceDecrypts = h.receiverDecrypts = h.encrypts = 0; h.active = true; }
function heartbeat(count: () => number, total: number): number[] {
  const samples: number[] = [];
  const tick = () => { const value = count(); samples.push(value); if (value < total) later(tick); };
  later(tick); return samples;
}
function expectBatched(probe: ReturnType<typeof instrumentGuard>, rows: number): void {
  expect(probe.slices.length).toBeGreaterThan(1);
  expect(probe.calls).toBeLessThan(rows / 4);
  expect(probe.snapshots).toBeLessThan(rows / 8);
  expect(probe.snapshots).toBeLessThan(probe.calls);
  for (const slice of probe.slices) {
    expect(slice.source + slice.receiver).toBeLessThanOrEqual(128);
    expect(slice.encrypts).toBeLessThanOrEqual(128);
    expect(slice.guards).toBeGreaterThanOrEqual(2);
  }
  expect(probe.inSlice).toBe(false);
}
afterEach(() => {
  for (const handle of immediates) clearImmediate(handle); immediates.clear();
  h.active = false; h.onCrypto = undefined; h.clock = undefined;
  for (const adapter of adapters.splice(0)) adapter.dispose?.();
  for (const { root, owner } of owned.splice(0)) {
    const now = fs.lstatSync(root);
    if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("credential-responsive-") || !now.isDirectory() || now.isSymbolicLink() || now.dev !== owner.dev || now.ino !== owner.ino) throw new Error("Owned credential fixture changed before cleanup");
    fs.rmSync(root, { recursive: true });
  }
});

describe("bounded main-thread credential work with real SQLite workers", () => {
  it("inspects thousands of built-in fields with heartbeats inside crypto, not only during SQL", async () => {
    const f = fixture(); let samples: number[] = [];
    activate(); h.onCrypto = () => { if (h.sourceDecrypts === 1) samples = heartbeat(() => h.sourceDecrypts, f.rows); };
    const report = await inspectProfileCredentials(f.options);
    expect(report).toMatchObject({ status: "source-verified", verification: "source-decrypt", databases: [{ fields: f.rows, encryptedFields: f.rows }] });
    expect(h.sourceDecrypts).toBe(f.rows); expect(samples.some(value => value > 0 && value < f.rows)).toBe(true);
    expectBatched(f.probe, f.rows); f.unchanged();
  });

  it("converts and SQL-verifies thousands of fields in separately bounded source/readback slices", async () => {
    const f = fixture(3072); let sourceSamples: number[] = [], receiverSamples: number[] = [];
    activate(); h.onCrypto = (method, algorithm) => {
      if (method !== "decrypt") return;
      if (algorithm === "aes-128-cbc" && h.sourceDecrypts === 1) sourceSamples = heartbeat(() => h.sourceDecrypts, f.rows);
      if (algorithm === "aes-256-gcm" && h.receiverDecrypts === 1) receiverSamples = heartbeat(() => h.receiverDecrypts, f.rows);
    };
    const converted = await f.convert();
    try {
      expect(converted.report).toMatchObject({ status: "receiver-verified", verification: "receiver-sql-decrypt", passwordUsability: "verified-with-codec", databases: [{ fields: f.rows }] });
      expect([h.sourceDecrypts, h.encrypts, h.receiverDecrypts]).toEqual([f.rows, f.rows, f.rows]);
      for (const samples of [sourceSamples, receiverSamples]) expect(samples.some(value => value > 0 && value < f.rows)).toBe(true);
      expect(converted.replacements).toHaveLength(1);
      const db = new DatabaseSync(converted.replacements[0].outputPath, { readOnly: true });
      try { expect(Number(db.prepare("SELECT count(*) AS n FROM logins WHERE length(password_value)>0").get()!.n)).toBe(f.rows); } finally { db.close(); }
      expectBatched(f.probe, f.rows);
    } finally { disposeConvertedProfileCredentials(converted); }
    f.unchanged();
  });

  it.each(["inspect", "source-conversion", "receiver-readback"] as const)("delivers macrotask cancellation during %s and removes only owned scratch", async phase => {
    const f = fixture(), controller = new AbortController(); let scheduled = false, whenCancelled = 0;
    const count = () => phase === "receiver-readback" ? h.receiverDecrypts : h.sourceDecrypts;
    activate(); h.onCrypto = (method, algorithm) => {
      const wanted = phase === "receiver-readback" ? "aes-256-gcm" : "aes-128-cbc";
      if (!scheduled && method === "decrypt" && algorithm === wanted) {
        scheduled = true; later(() => { whenCancelled = count(); controller.abort(); });
      }
    };
    const operation = phase === "inspect" ? inspectProfileCredentials({ ...f.options, signal: controller.signal }) : f.convert(controller.signal);
    await expect(operation).rejects.toMatchObject({ code: "CANCELLED" });
    expect(controller.signal.aborted).toBe(true); expect(whenCancelled).toBeGreaterThan(0); expect(whenCancelled).toBeLessThanOrEqual(128);
    expect(count()).toBe(whenCancelled); expect(f.probe.inSlice).toBe(false); f.unchanged();
  });

  it.each([48 * 1024, 300 * 1024])("bounds %i-byte fields independently of item/time budgets", async size => {
    const f = fixture(24, size); activate(); h.clock = 0; // Isolate byte, not elapsed-time, admission.
    const report = await inspectProfileCredentials(f.options);
    expect(report.databases[0].fields).toBe(f.rows); expect(h.sourceDecrypts).toBe(f.rows);
    expect(f.probe.slices.length).toBeGreaterThan(4);
    expect(Math.max(...f.probe.slices.map(slice => slice.source))).toBeLessThanOrEqual(size > 256 * 1024 ? 1 : 3);
    f.unchanged();
  });

  it("does not let slow process discovery collapse a built-in batch back to one field", async () => {
    const f = fixture(1024); activate(); h.clock = 0;
    f.probe.onSlice(() => { h.clock = (h.clock ?? 0) + 100; });
    await inspectProfileCredentials(f.options);
    expect(f.probe.slices).toHaveLength(f.rows / 128);
    expect(f.probe.slices.every(slice => slice.source === 128)).toBe(true);
    expectBatched(f.probe, f.rows); f.unchanged();
  });

  it("honors the soft-time limit before reaching the item/byte limits", async () => {
    const f = fixture(16); activate(); h.clock = 0;
    h.onCrypto = () => { h.clock = (h.clock ?? 0) + 100; }; // Deterministic monotonic CPU-time surrogate, no sleeps.
    await inspectProfileCredentials(f.options);
    expect(f.probe.slices).toHaveLength(f.rows); expect(f.probe.slices.every(slice => slice.source === 1)).toBe(true); f.unchanged();
  });

  it("also yields while classifying thousands of fields without a codec", async () => {
    const f = fixture(); let samples: number[] = [], started = false;
    f.probe.onSlice(() => { if (!started) { started = true; samples = heartbeat(() => f.probe.slices.length, f.rows / 128); } });
    activate(); const report = await inspectProfileCredentials({ ...f.options, sourceAdapter: undefined });
    expect(report).toMatchObject({ status: "source-codec-required", verification: "not-verified", passwordUsability: "not-verified" });
    expect(h.sourceDecrypts).toBe(0); expect(samples.some(value => value > 0 && value < f.probe.slices.length)).toBe(true);
    expectBatched(f.probe, f.rows); f.unchanged();
  });

  it.each([false, true])("bounds Firefox SDR envelope checks without attempting NSS unlock (cancel=%s)", async cancel => {
    const stagingRoot = ownedRoot(), keyFile = path.join(stagingRoot, "key4.db"), loginFile = path.join(stagingRoot, "logins.json");
    const keyId = Buffer.alloc(16, 0x35), db = new DatabaseSync(keyFile);
    try {
      db.exec("CREATE TABLE nssPrivate(id INTEGER PRIMARY KEY,a102 BLOB,a11 BLOB); CREATE TABLE metaData(id PRIMARY KEY UNIQUE ON CONFLICT REPLACE,item1,item2);");
      db.prepare("INSERT INTO nssPrivate VALUES(1,?,?)").run(keyId, Buffer.alloc(64, 0x42));
      db.prepare("INSERT INTO metaData VALUES('password',?,?)").run(Buffer.alloc(20, 0x43), Buffer.alloc(64, 0x44));
    } finally { db.close(); }
    const der = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag, body.length]), body]);
    const algorithm = der(0x30, Buffer.concat([der(6, Buffer.from("2a864886f70d0307", "hex")), der(4, Buffer.alloc(8, 0x45))]));
    const encoded = der(0x30, Buffer.concat([der(4, keyId), algorithm, der(4, Buffer.alloc(16, 0x46))])).toString("base64");
    const logins = Array.from({ length: 4096 }, (_, id) => ({ id, encType: 1, encryptedUsername: encoded, encryptedPassword: encoded }));
    fs.writeFileSync(loginFile, JSON.stringify({ version: 3, logins }), { mode: 0o600, flag: "wx" });
    const probe = instrumentGuard(keyFile), original = [sha(keyFile), sha(loginFile)], controller = new AbortController();
    let started = false, samples: number[] = [];
    probe.onSlice(() => {
      if (!started) { started = true; if (cancel) later(() => controller.abort()); else samples = heartbeat(() => probe.slices.length, logins.length / 128); }
    });
    const options: ProfileCredentialOptions = { stagingRoot, stagingOwner: fs.lstatSync(stagingRoot), profileRelativePath: ".", source: identityForManagedProfile("firefox", "linux", "synthetic-firefox-batch"), guard: probe.guard, signal: controller.signal };
    activate(); const operation = inspectProfileCredentials(options);
    if (cancel) {
      await expect(operation).rejects.toMatchObject({ code: "CANCELLED" }); expect(probe.slices).toHaveLength(1);
    } else {
      expect(await operation).toMatchObject({ verification: "paired-files-only", passwordUsability: "requires-firefox-nss-unlock", databases: [{ fields: logins.length * 2 }] });
      expect(samples.some(value => value > 0 && value < probe.slices.length)).toBe(true); expectBatched(probe, logins.length);
    }
    expect(h.sourceDecrypts + h.receiverDecrypts).toBe(0);
    expect([sha(keyFile), sha(loginFile)]).toEqual(original); expect(fs.readdirSync(stagingRoot).sort()).toEqual(["key4.db", "logins.json"]);
  });

  it("does not mistake copied built-in methods or resolved custom Promises for synchronous authority", async () => {
    const f = fixture(2048); let samples: number[] = [], calls = 0;
    const custom: CredentialCryptoAdapter = { ...f.source, decrypt(cipher, context) {
      expect(f.probe.inSlice).toBe(false); calls++;
      return Promise.resolve(f.source.decrypt(cipher, context));
    } };
    activate(); h.onCrypto = () => { if (h.sourceDecrypts === 1) samples = heartbeat(() => h.sourceDecrypts, f.rows); };
    expect((await inspectProfileCredentials({ ...f.options, sourceAdapter: custom })).status).toBe("source-verified");
    expect(calls).toBe(f.rows); expect(f.probe.slices).toHaveLength(0);
    expect(f.probe.snapshots).toBe(f.probe.calls); expect(f.probe.calls).toBeGreaterThan(f.rows * 2);
    expect(samples.some(value => value > 0 && value < f.rows)).toBe(true); f.unchanged();
  });

  it.each(["decrypt", "encrypt"] as const)("checks a changed DB witness immediately after custom async %s and clears borrowed plaintext", async method => {
    const f = fixture(2048); let decrypts = 0, encrypts = 0, retained: Buffer | undefined;
    const changeWitness = async () => {
      expect(f.probe.inSlice).toBe(false); await nextTurn(); expect(f.probe.inSlice).toBe(false);
      fs.appendFileSync(f.file, Buffer.from("synthetic-owned-witness-change"));
    };
    const source: CredentialCryptoAdapter = { ...f.source, async decrypt(cipher, context) {
      decrypts++; const clear = await f.source.decrypt(cipher, context);
      if (method === "decrypt") { retained = clear; await changeWitness(); }
      return clear;
    } };
    const receiver: CredentialCryptoAdapter = { ...f.receiver, async encrypt(clear, context) {
      encrypts++; expect(f.probe.inSlice).toBe(false); retained = clear;
      const encrypted = await f.receiver.encrypt(clear, context); await changeWitness(); return encrypted;
    } };
    activate(); await expect(f.convert(undefined, source, receiver)).rejects.toThrow("Synthetic credential DB witness changed");
    expect(decrypts).toBe(1); expect(encrypts).toBe(method === "decrypt" ? 0 : 1);
    expect(retained).toBeDefined(); expect(retained!.every(byte => byte === 0)).toBe(true);
    expect(f.probe.slices).toHaveLength(0); expect(f.probe.snapshots).toBe(f.probe.calls);
    expect(fs.readdirSync(f.options.stagingRoot)).toEqual(["Default"]); // The intentionally modified source is retained, never rolled back.
  });
});
