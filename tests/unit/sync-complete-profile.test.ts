// Production SyncService + actual loopback PUT/GET + two independent owned
// local file-vault devices. No real browser/app, cloud, OS secret or user data.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { writeNativeProxyAuthFile } from "../../src/main/services/native-proxy-auth.js";

const h = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-complete-profile-owned-"))); fs.chmodSync(root, 0o700);
  return { root, owner: fs.lstatSync(root), caseRoot: "", device: path.join(root, "not-used"), running: new Set<string>(), leaseFds: new Set<number>(), fdPaths: new Map<number, string>(), unknownRunning: false, cookieExports: 0,
    fault: null as null | ((op: string, from: string, to?: string) => void) };
});
vi.mock("electron", () => ({ app: { getPath: (name: string) => name === "home" ? path.join(h.root, "owned-home") : h.device }, safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: (id: string) => { if (h.unknownRunning) throw new Error("Synthetic runtime ownership unknown"); return { running: h.running.has(id), pid: null, cdpPort: null }; } }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ runtimeCookieOps: { hasRunningBrowser: (id: string) => h.running.has(id), exportCookiesSnapshot: async () => { h.cookieExports++; return { state: "available", cookies: [] }; }, importCookies: async () => 0 } }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    openSync: (file: any, flags: any, mode?: any) => {
      h.fault?.("open", String(file)); const fd = actual.openSync(file, flags, mode); h.fdPaths.set(fd, String(file));
      if (typeof flags === "number" && (flags & actual.constants.O_CREAT) !== 0 && String(file).endsWith(".restore.lock")) h.leaseFds.add(fd);
      return fd;
    },
    closeSync: (fd: number) => { actual.closeSync(fd); h.leaseFds.delete(fd); h.fdPaths.delete(fd); },
    fsyncSync: (fd: number) => { h.fault?.("fsync", h.fdPaths.get(fd) ?? "<untracked-owned-fd>"); return actual.fsyncSync(fd); },
    renameSync: (from: any, to: any) => { h.fault?.("rename", String(from), String(to)); return actual.renameSync(from, to); },
  };
});

let service: typeof import("../../src/main/services/sync-service.js");
let config: typeof import("../../src/main/services/config-manager.js");
let secrets: typeof import("../../src/main/services/secrets.js");
let locks: typeof import("../../src/main/services/profile-restore-lock.js");
import { createBasicChromiumAdapter, identityForManagedProfile, type CredentialCryptoContext } from "../../src/main/services/sync/profile-credentials.js";

const ID = "ab_complete_profile", CONFIG_KEY = "agent-browser-studio-config.json", BUCKET = "owned-complete-fixture", PROXY = "owned-complete-proxy";
const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const PASSWORD = Buffer.from("owned-complete-native-login-λ"), OLD_PASSWORD = Buffer.from("owned-old-receiver-password"), COOKIE = Buffer.from("owned-complete-native-cookie"), HOST = ".complete.synthetic.invalid";
const PROXY_SECRET = "owned-complete-proxy-password", PROXY_USER = "owned-complete-proxy-user", HISTORY_URL = "https://complete.synthetic.invalid/wal-history";
const proxyUsernames = [
  { label: "ordinary", username: PROXY_USER, localUsername: "owned-local-proxy-user" },
  { label: "Unicode", username: "owned-代理-δοκιμή-λ", localUsername: "owned-本地-代理-λ" },
  { label: "colon", username: "owned:user:session", localUsername: "owned:local:user:session" },
  { label: "v2 literal", username: "v2:owned-literal-proxy-user", localUsername: "v2:owned-local-proxy-user" },
  { label: "os1 literal", username: "os1:owned-literal-proxy-user", localUsername: "os1:owned-local-proxy-user" },
];
const QUEUED_COOKIE_VALUE = "owned-external-queued-cookie-would-override-remote";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Hook = null | ((key: string, body?: Buffer) => Buffer | number | void);
async function loopbackFixture() {
  const objects = new Map<string, Buffer>(), journal: Array<{ method: string; key: string; sha256: string }> = []; let onPut: Hook = null, onGet: Hook = null;
  const server = http.createServer((req, res) => { void (async () => {
    const key = decodeURIComponent((req.url || "").replace(`/${BUCKET}/`, ""));
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) { res.writeHead(404); res.end(); return; }
    if (req.method === "PUT") {
      const chunks: Buffer[] = []; let total = 0;
      for await (const part of req) { total += part.length; if (total > 2 * 1024 * 1024) throw new Error("Owned loopback object limit"); chunks.push(Buffer.from(part)); }
      const body = Buffer.concat(chunks); journal.push({ method: "PUT", key, sha256: sha(body) }); const result = onPut?.(key, body);
      if (typeof result === "number") { res.writeHead(result); res.end("Synthetic put refusal"); return; }
      objects.set(key, body); res.writeHead(200); res.end(); return;
    }
    const stored = objects.get(key), result = onGet?.(key, stored); if (typeof result === "number") { res.writeHead(result); res.end(); return; }
    const body = Buffer.isBuffer(result) ? result : stored; if (!body) { res.writeHead(404); res.end("NoSuchKey"); return; }
    journal.push({ method: "GET", key, sha256: sha(body) }); res.writeHead(200, { "content-length": String(body.length) }); res.end(body);
  })().catch(() => { res.writeHead(500); res.end("Synthetic loopback failure"); }); });
  // The endpoint is this test's own dynamically allocated listener, not a
  // production localhost/port override or an external network destination.
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Owned loopback did not bind");
  return { objects, journal, endpoint: `http://127.0.0.1:${address.port}`, putHook: (hook: Hook) => { onPut = hook; }, getHook: (hook: Hook) => { onGet = hook; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
let fixture: Awaited<ReturnType<typeof loopbackFixture>>, phrase: string;
function assertRoot(): void { const stat = fs.lstatSync(h.root); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== h.owner.dev || stat.ino !== h.owner.ino) throw new Error("Synthetic test root changed"); }
async function resetDevice(name: string, options: { selected?: boolean; phrase?: string } = {}): Promise<void> {
  assertRoot(); h.device = path.join(h.caseRoot, name); fs.mkdirSync(h.device, { mode: 0o700 });
  // A fresh module graph is a separate device process: both config-manager and
  // config/paths deliberately cache their user-data paths. Merely reloadConfig
  // after changing app.getPath would silently keep the previous device's file.
  if (secrets) secrets.resetSecretStorageForTests();
  vi.resetModules();
  [service, config, secrets, locks] = await Promise.all([
    import("../../src/main/services/sync-service.js"), import("../../src/main/services/config-manager.js"),
    import("../../src/main/services/secrets.js"), import("../../src/main/services/profile-restore-lock.js"),
  ]);
  // Explicit per-instance plan: no process env/global backend override, no OS
  // adapter, no legacy keychain lookup. The real file backend creates its key.
  const plan = secrets.planSecretStorage({ userDataDir: h.device, platform: "darwin", trustedMacSignature: false, environment: {} }); secrets.initializeSecretStorage(plan);
  expect(secrets.getSecretStorageBackend()).toBe("file");
  if (process.platform !== "win32") expect(fs.statSync(plan.keyPath).mode & 0o777).toBe(0o600);
  config.reloadConfig();
  const cfg = structuredClone(config.getConfig()); cfg.deviceId = name; cfg.browserProfiles = {}; cfg.proxies = {}; cfg.accounts = []; cfg.extensionRepository = {}; cfg.team = undefined;
  cfg.sync = { enabled: true, endpoint: fixture.endpoint, bucket: BUCKET, accessKey: "owned-s3-access", secretKey: secrets.encryptSecret("owned-s3-secret") }; config.saveConfig(cfg);
  config.setSyncConfig({ custodyConsent: true, fullProfileConsent: true, fullProfilePassphrase: options.phrase ?? phrase, includeFullProfile: options.selected !== false });
  expect(config.getConfigPath()).toBe(path.join(h.device, "config.json")); expect(fs.readFileSync(config.getConfigPath()).includes(Buffer.from(options.phrase ?? phrase))).toBe(false);
}
function profileRoot(): string { return path.join(config.getProfilesDir(), ID); }
function put(root: string, relative: string, body: Buffer): void { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, body, { mode: 0o600 }); }
function context(relativePath = "Default/Login Data", cookies = false): CredentialCryptoContext { return { identity: identityForManagedProfile("chromium", PLATFORM, ID), relativePath, table: cookies ? "cookies" : "logins", column: cookies ? "encrypted_value" : "password_value", rowId: "1", databaseVersion: cookies ? 24 : 43, ...(cookies ? { cookieHost: HOST } : {}) }; }
const persistent = ["Default/IndexedDB/https_complete.synthetic.invalid_0.indexeddb.leveldb/000003.log", "Default/Service Worker/CacheStorage/owned/body", "Default/Service Worker/ScriptCache/script", "Default/Session Storage/000003.log", "Default/Sessions/Session_123", "Default/Local Storage/leveldb/000003.log", "Default/blob_storage/owned/blob"];
async function seedProfile(old = false, proxyUsername = old ? "old-proxy-user" : PROXY_USER): Promise<void> {
  const cfg = structuredClone(config.getConfig()); cfg.browserProfiles[ID] = { name: old ? "Old receiver" : "Owned complete source", engine: "chromium", fingerprintSeed: old ? 9 : 42, updatedAt: old ? 1 : 100, proxyMode: "named", proxyName: PROXY }; config.saveConfig(cfg);
  // Use the ordinary proxy entry point: usernames are literal, and production
  // normalization encrypts the supplied password under this owned device key.
  const proxy = { type: "http" as const, host: "proxy.complete.synthetic.invalid", port: 8080, username: proxyUsername, password: old ? "old-proxy-secret" : PROXY_SECRET };
  if (config.getProxy(PROXY)) config.updateProxy(PROXY, proxy); else config.addProxy(PROXY, proxy);
  expect(config.getProxySecret(PROXY)?.username === proxyUsername).toBe(true);
  const storedProxy = JSON.parse(fs.readFileSync(config.getConfigPath(), "utf8")).proxies[PROXY];
  expect(storedProxy.username === proxyUsername && secrets.isEncrypted(storedProxy.password)).toBe(true);
  const root = profileRoot(); fs.mkdirSync(path.join(root, "Default/Network"), { recursive: true, mode: 0o700 });
  const adapter = createBasicChromiumAdapter(identityForManagedProfile("chromium", PLATFORM, ID));
  try {
    const login = new DatabaseSync(path.join(root, "Default/Login Data"));
    try { login.exec("CREATE TABLE meta(key TEXT NOT NULL UNIQUE PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('version','43'),('last_compatible_version','43'); CREATE TABLE logins(id INTEGER PRIMARY KEY,origin_url TEXT,username_value TEXT,password_value BLOB,keychain_identifier BLOB);"); login.prepare("INSERT INTO logins VALUES(1,?,?,?,X'')").run("https://complete.synthetic.invalid/login", old ? "old-user" : "owned-complete-user", await adapter.encrypt(old ? OLD_PASSWORD : PASSWORD, context())); } finally { login.close(); }
    const cookies = new DatabaseSync(path.join(root, "Default/Network/Cookies")), clear = Buffer.concat([createHash("sha256").update(HOST).digest(), old ? Buffer.from("old-receiver-cookie") : COOKIE]);
    try { cookies.exec("CREATE TABLE meta(key TEXT NOT NULL UNIQUE PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('version','24'),('last_compatible_version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT);"); cookies.prepare("INSERT INTO cookies VALUES(?,?,'',?,'/')").run(HOST, "owned-complete-session", await adapter.encrypt(clear, context("Default/Network/Cookies", true))); } finally { clear.fill(0); cookies.close(); }
  } finally { adapter.dispose?.(); }
  const history = new DatabaseSync(path.join(root, "Default/History"));
  try { history.exec("CREATE TABLE meta(key TEXT PRIMARY KEY NOT NULL,value TEXT); INSERT INTO meta VALUES('version','67'),('last_compatible_version','16'); CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER); "); history.prepare("INSERT INTO urls VALUES(1,?,'owned history')").run(old ? "https://old.synthetic.invalid/history" : HISTORY_URL); history.exec("INSERT INTO visits VALUES(2,1,13300000000000000);"); } finally { history.close(); }
  const local = new DatabaseSync(path.join(root, "Default/LocalStorage"));
  try { local.exec("CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB NOT NULL);"); local.prepare("INSERT INTO ItemTable VALUES(?,?)").run("owned-complete-key", Buffer.from(old ? "old-local-value" : "owned-complete-local-value", "utf16le")); } finally { local.close(); }
  for (const relative of persistent) put(root, relative, Buffer.from((old ? "old-receiver:" : "source-record:") + relative));
  put(root, "Default/Preferences", Buffer.from(JSON.stringify({ owned_complete: true, profile: { name: old ? "Old" : "Complete" } })));
  put(root, "Default/Cache/transient", Buffer.from("not-required-browser-cache"));
  if (old) put(root, "receiver-only.bin", Buffer.from("old-receiver-data-must-remain-in-backup"));
}
function inventory(root: string): Map<string, string> {
  const out = new Map<string, string>(); const visit = (directory: string, prefix = "") => { for (const name of fs.readdirSync(directory).sort()) { const file = path.join(directory, name), relative = prefix + name, stat = fs.lstatSync(file); if (stat.isSymbolicLink()) throw new Error("Synthetic tree contained a link"); if (stat.isDirectory()) visit(file, relative + "/"); else out.set(relative, sha(fs.readFileSync(file))); } }; visit(root); return out;
}
function sameTree(root: string, expected: Map<string, string>): void { const actual = inventory(root); expect(actual.size).toBe(expected.size); for (const [name, hash] of expected) expect(actual.get(name) === hash).toBe(true); }
function payload(): any { const body = fixture.objects.get(CONFIG_KEY); if (!body) throw new Error("Production config was not published"); return JSON.parse(body.toString()); }
function fullArtifact(document = payload()): any { const entry = document.fullProfiles?.[ID]; expect(Boolean(entry)).toBe(true); return entry.artifact ?? entry; }
function safeFailure(result: { code?: string; message?: string }): string {
  let text = String(result.message ?? result.code ?? "unconfirmed");
  for (const secret of [phrase, PROXY_SECRET, PROXY_USER, PASSWORD.toString(), OLD_PASSWORD.toString(), COOKIE.toString(), QUEUED_COOKIE_VALUE, h.root]) if (secret) text = text.replaceAll(secret, "[redacted]");
  return String(result.code ?? "UNCONFIRMED") + ": " + text.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[opaque]").slice(0, 400);
}
async function publish(proxyUsername = PROXY_USER): Promise<any> {
  await seedProfile(false, proxyUsername); const result = await service.syncService.push(undefined, true); expect(result.success, safeFailure(result)).toBe(true);
  const document = payload(); expect(document.artifactVersion).toBe(4); const artifact = fullArtifact(document); expect(artifact.dirId).toBe(ID); expect(artifact.engine).toBe("chromium"); expect(artifact.snapshotId).toBe(document.snapshotId); return document;
}
async function assertNative(root = profileRoot()): Promise<void> {
  const adapter = createBasicChromiumAdapter(identityForManagedProfile("chromium", PLATFORM, ID));
  try {
    const login = new DatabaseSync(path.join(root, "Default/Login Data"), { readOnly: true });
    try { const row = login.prepare("SELECT password_value FROM logins WHERE origin_url=? AND username_value=?").get("https://complete.synthetic.invalid/login", "owned-complete-user"); expect(Boolean(row)).toBe(true); const clear = await adapter.decrypt(Buffer.from(row!.password_value as Uint8Array), context()); expect(clear.equals(PASSWORD)).toBe(true); clear.fill(0); } finally { login.close(); }
    const cookies = new DatabaseSync(path.join(root, "Default/Network/Cookies"), { readOnly: true });
    try { const row = cookies.prepare("SELECT value,encrypted_value FROM cookies WHERE host_key=? AND name=?").get(HOST, "owned-complete-session"); expect(Boolean(row)).toBe(true); expect(row!.value === "").toBe(true); const clear = await adapter.decrypt(Buffer.from(row!.encrypted_value as Uint8Array), context("Default/Network/Cookies", true)); expect(clear.subarray(0, 32).equals(createHash("sha256").update(HOST).digest())).toBe(true); expect(clear.subarray(32).equals(COOKIE)).toBe(true); clear.fill(0); } finally { cookies.close(); }
    const history = new DatabaseSync(path.join(root, "Default/History"), { readOnly: true }); try { expect(Boolean(history.prepare("SELECT u.url FROM urls u JOIN visits v ON v.url=u.id WHERE u.url=?").get(HISTORY_URL))).toBe(true); } finally { history.close(); }
    const local = new DatabaseSync(path.join(root, "Default/LocalStorage"), { readOnly: true }); try { const row = local.prepare("SELECT value FROM ItemTable WHERE key=?").get("owned-complete-key"); expect(Boolean(row)).toBe(true); expect(Buffer.from(row!.value as Uint8Array).toString("utf16le") === "owned-complete-local-value").toBe(true); } finally { local.close(); }
  } finally { adapter.dispose?.(); }
}
/** Read the actual config file, reload through production normalization, look up
 * the linked proxy by both name and profile, then read the real auth handoff.
 * This stops at the owned credential file: no browser or proxy is contacted. */
async function assertProxyHandoff(username: string, password: string): Promise<string> {
  const bytes = fs.readFileSync(config.getConfigPath()), disk = JSON.parse(bytes.toString("utf8"));
  config.reloadConfig();
  const named = config.getProxySecret(PROXY), resolved = config.resolveProfileProxySecret(ID);
  expect(Boolean(named)).toBe(true); expect(resolved.mode).toBe("named"); expect(resolved.name).toBe(PROXY); expect(Boolean(resolved.config)).toBe(true);
  const proxy = resolved.config!;
  const auth = writeNativeProxyAuthFile({ host: proxy.host, port: proxy.port, username: proxy.username || "", password: proxy.password || "" }, h.caseRoot);
  try {
    const file = fs.lstatSync(auth.filePath), handedOff = JSON.parse(fs.readFileSync(auth.filePath, "utf8"));
    expect(file.isFile() && !file.isSymbolicLink() && file.nlink === 1).toBe(true);
    expect(path.relative(h.caseRoot, auth.filePath).startsWith("..")).toBe(false);
    if (process.platform !== "win32") {
      expect(file.mode & 0o777).toBe(0o600); expect(fs.statSync(path.dirname(auth.filePath)).mode & 0o777).toBe(0o700);
    }
    // Check the real downstream output first, not a manually decrypted username.
    expect(handedOff.username === username, "native proxy-auth handoff must preserve the literal username").toBe(true);
    expect(handedOff.password === password).toBe(true); expect(handedOff.host === proxy.host && handedOff.port === proxy.port).toBe(true);
  } finally { auth.cleanup(); }
  expect(fs.existsSync(auth.filePath)).toBe(false);
  expect(disk.proxies[PROXY].username === username).toBe(true);
  expect(typeof disk.proxies[PROXY].password === "string" && secrets.isEncrypted(disk.proxies[PROXY].password)).toBe(true);
  expect(bytes.includes(Buffer.from(password))).toBe(false);
  expect(secrets.decryptSecretOr(disk.proxies[PROXY].password) === password).toBe(true);
  expect(config.getConfig().proxies[PROXY].password === disk.proxies[PROXY].password).toBe(true);
  expect(named!.username === username && named!.password === password).toBe(true);
  expect(config.getProxy(PROXY)?.username === username).toBe(true);
  expect(config.getProxyList().some(entry => entry.name === PROXY && entry.config.username === username)).toBe(true);
  return disk.proxies[PROXY].password;
}
function oldReceiver() { return { profile: inventory(profileRoot()), configHash: sha(fs.readFileSync(config.getConfigPath())), remote: sha(fixture.objects.get(CONFIG_KEY)!) }; }
function assertOld(before: ReturnType<typeof oldReceiver>, compareConfig = true): void { sameTree(profileRoot(), before.profile); if (compareConfig) expect(sha(fs.readFileSync(config.getConfigPath())) === before.configHash).toBe(true); expect(sha(fixture.objects.get(CONFIG_KEY)!) === before.remote).toBe(true); }
function recoveryReceiptPath(): string { return path.join(h.device, "locks", ID + ".full-profile-recovery.json"); }
function ordinaryLeasePath(): string { return path.join(h.device, "locks", ID + ".restore.lock"); }
function assertOrdinaryLeaseReleased(): void { expect(fs.existsSync(ordinaryLeasePath())).toBe(false); expect(h.leaseFds.size).toBe(0); }
function assertFreshAcquireReady(): void {
  assertOrdinaryLeaseReleased(); expect(fs.existsSync(recoveryReceiptPath())).toBe(false); locks.assertNoFullProfileRecovery(ID);
  const release = locks.acquireRestoreLock(ID); try { expect(fs.existsSync(ordinaryLeasePath())).toBe(true); expect(h.leaseFds.size).toBe(1); } finally { release(); }
  assertOrdinaryLeaseReleased(); expect(locks.isRestoreLocked(ID)).toBe(false);
}
function assertRecoveryBlocksFreshAcquire(api: typeof locks): void {
  let error: unknown, release: (() => void) | undefined;
  try { release = api.acquireRestoreLock(ID); } catch (caught) { error = caught; } finally { release?.(); }
  expect((error as { code?: string })?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect((error as { receiptPath?: string })?.receiptPath === recoveryReceiptPath()).toBe(true);
  expect(api.isRestoreLocked(ID)).toBe(true); assertOrdinaryLeaseReleased();
}
function profileStageDirectories(): string[] {
  return fs.readdirSync(config.getProfilesDir()).filter(name => name.startsWith("." + ID + ".full-profile-stage-") || name.includes(".full-profile-rollback-"))
    .map(name => path.join(config.getProfilesDir(), name)).filter(file => { const stat = fs.lstatSync(file); return stat.isDirectory() && !stat.isSymbolicLink(); });
}
function queuePath(): string { return path.join(h.device, "pending-cookie-imports", ID + ".json"); }
function queueWitness() {
  const file = queuePath(), stat = fs.lstatSync(file);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256: sha(fs.readFileSync(file)) };
}
function assertQueueUnchanged(before: ReturnType<typeof queueWitness>): void {
  const after = queueWitness(); for (const field of Object.keys(before) as Array<keyof typeof before>) expect(after[field] === before[field]).toBe(true);
}
async function queueApi() { return import("../../src/main/services/cdp-cookie-service.js"); }
function putPendingQueue(queue: Awaited<ReturnType<typeof queueApi>>): void {
  queue.writeQueuedCookieImports(ID, [{ domain: HOST, name: "owned-complete-session", value: QUEUED_COOKIE_VALUE, path: "/", expires: 2051222400, secure: true, httpOnly: true, sameSite: 1 }]);
  const readback = queue.readQueuedCookieImports(ID, { strict: true });
  expect(readback.length).toBe(1); expect(readback[0].domain === HOST && readback[0].name === "owned-complete-session" && readback[0].value === QUEUED_COOKIE_VALUE).toBe(true);
  // This queue is outside the full-profile source/receiver tree. Matching the
  // restored Cookie's host/name/path makes a later normal replay destructive.
  expect(path.relative(profileRoot(), queuePath()).startsWith("..")).toBe(true);
}
function backupFor(expected: Map<string, string>): string | undefined {
  const parent = config.getProfilesDir();
  return fs.readdirSync(parent).filter(name => name !== ID).map(name => path.join(parent, name)).find(dir => { const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink() || !fs.existsSync(path.join(dir, "receiver-only.bin"))) return false; const actual = inventory(dir); return actual.size === expected.size && [...expected].every(([name, hash]) => actual.get(name) === hash); });
}

beforeEach(async () => { assertRoot(); h.caseRoot = fs.mkdtempSync(path.join(h.root, "case-")); h.running.clear(); h.unknownRunning = false; h.fault = null; h.cookieExports = 0; phrase = randomBytes(24).toString("base64url"); fixture = await loopbackFixture(); await resetDevice("source-device"); });
afterEach(async () => {
  h.fault = null; h.running.clear(); h.unknownRunning = false;
  const held = locks ? locks.isRestoreLocked(ID) : false, persistent = fs.existsSync(recoveryReceiptPath()), ordinary = fs.existsSync(ordinaryLeasePath()), openLeaseFds = h.leaseFds.size;
  try { await fixture?.close(); } finally { secrets?.resetSecretStorageForTests(); vi.restoreAllMocks(); fs.rmSync(h.caseRoot, { recursive: true }); }
  // isRestoreLocked deliberately remains true for a persistent recovery gate;
  // ordinary lease file + tracked FD closure independently prove finally ran.
  expect(ordinary).toBe(false); expect(openLeaseFds).toBe(0); expect(held).toBe(persistent);
});
afterAll(() => { assertRoot(); fs.rmSync(h.root, { recursive: true }); });

describe.skipIf(!["darwin", "linux"].includes(process.platform))("complete profile production transport with independent device vaults", () => {
  describe("local progress and cancellation settlement", () => {
    it.each(["scanning", "packing", "reading-archive", "verifying-source", "encrypting", "decrypting", "extracting", "verifying-profile", "verifying-extras"])("cancels push during %s with lease held until cleanup and no remote publication", async phase => {
      await seedProfile();
      const before = inventory(profileRoot()), configHash = sha(fs.readFileSync(config.getConfigPath())), controller = new AbortController();
      const { onEvent } = await import("../../src/main/services/event-bus.js");
      let witnessed = false, competing: ReturnType<typeof service.syncService.pull> | undefined;
      const off = onEvent("sync:progress", (event: any) => {
        if (witnessed || event.progress?.local?.phase !== phase) return;
        witnessed = true;
        expect(event.progress).toMatchObject({ scope: "fullProfile", itemId: ID });
        expect(event.progress).not.toHaveProperty("transfer");
        expect(locks.isRestoreLocked(ID)).toBe(true);
        expect(fs.existsSync(ordinaryLeasePath())).toBe(true);
        controller.abort();
        expect(service.syncService.getStatus().operation.active?.operationId).toBe(event.operationId);
        competing = service.syncService.pull();
      });
      let result: any;
      try { await service.syncService.push(controller.signal, true); }
      catch (error: any) { result = error.syncResult; }
      finally { off(); }
      expect(witnessed).toBe(true);
      expect(result).toMatchObject({ success: false, outcome: "cancelled", localCommit: "none", remoteCommit: "none" });
      expect(await competing).toMatchObject({ code: "SYNC_BUSY" });
      expect(fixture.journal.filter(entry => entry.method === "PUT")).toEqual([]);
      expect(sha(fs.readFileSync(config.getConfigPath()))).toBe(configHash); sameTree(profileRoot(), before);
      expect(fs.readdirSync(config.getProfilesDir()).some(name => name.startsWith(".sync-pull-stage-"))).toBe(false);
      expect(service.syncService.getStatus().operation.active).toBeNull();
      expect(service.syncService.getStatus().operation.last).toEqual(result);
      assertFreshAcquireReady();
    });

    it.each(["decrypting", "extracting", "verifying-profile", "verifying-extras"])("cancels pull during %s before changing the receiver", async phase => {
      await publish(); await resetDevice("cancel-receiver"); await seedProfile(true);
      const before = oldReceiver(), controller = new AbortController();
      const { onEvent } = await import("../../src/main/services/event-bus.js");
      let witnessed = false;
      const off = onEvent("sync:progress", (event: any) => {
        if (witnessed || event.progress?.local?.phase !== phase) return;
        witnessed = true;
        expect(event).toMatchObject({ stage: "verifying", progress: { scope: "fullProfile", itemId: ID } });
        expect(event.progress).not.toHaveProperty("transfer");
        expect(locks.isRestoreLocked(ID)).toBe(true);
        controller.abort();
        expect(service.syncService.getStatus().operation.active?.operationId).toBe(event.operationId);
      });
      let result: any;
      try { await service.syncService.pull(controller.signal); }
      catch (error: any) { result = error.syncResult; }
      finally { off(); }
      expect(witnessed).toBe(true);
      expect(result).toMatchObject({ success: false, outcome: "cancelled", localCommit: "none", remoteCommit: "none" });
      assertOld(before); assertFreshAcquireReady();
      expect(service.syncService.getStatus().operation.active).toBeNull();
      expect(fs.readdirSync(config.getProfilesDir()).some(name => name.startsWith(".sync-pull-stage-"))).toBe(false);
    });

    it("retains uncertain remote publication facts when cancellation arrives after config PUT dispatch", async () => {
      await seedProfile(); const controller = new AbortController();
      const before = sha(fs.readFileSync(config.getConfigPath()));
      fixture.putHook(key => { if (key === CONFIG_KEY) controller.abort(); });
      let result: any;
      try { await service.syncService.push(controller.signal, true); }
      catch (error: any) { result = error.syncResult; }
      expect(result).toMatchObject({ success: false, outcome: "partial", localCommit: "none", remoteCommit: "unknown" });
      expect(fixture.objects.has(CONFIG_KEY)).toBe(true);
      expect(sha(fs.readFileSync(config.getConfigPath()))).toBe(before);
      expect(service.syncService.getStatus().operation.active).toBeNull(); assertFreshAcquireReady();
    });
  });

  describe("linked proxy credential contract", () => {
    const cases = proxyUsernames.flatMap(entry => (["new-proxy", "remote-wins", "local-wins"] as const).map(decision => ({ ...entry, decision })));
    it.each(cases)("$decision preserves the $label username through persisted restore and native auth", async ({ username, localUsername, decision }) => {
      const sourceKey = fs.readFileSync(path.join(h.device, ".secret-vault-key"));
      try {
        await publish(username);
        const sourceCipher = JSON.parse(fs.readFileSync(config.getConfigPath(), "utf8")).proxies[PROXY].password;
        await resetDevice("proxy-contract-receiver");
        const receiverKey = fs.readFileSync(path.join(h.device, ".secret-vault-key"));
        try { expect(sourceKey.equals(receiverKey)).toBe(false); } finally { receiverKey.fill(0); }
        let previousCipher: string | undefined;
        if (decision !== "new-proxy") {
          await seedProfile(true, localUsername);
          previousCipher = JSON.parse(fs.readFileSync(config.getConfigPath(), "utf8")).proxies[PROXY].password;
        } else expect(config.getProxy(PROXY)).toBeNull();
        let sourceCipherRefused = false;
        try { secrets.decryptSecretOr(sourceCipher); } catch { sourceCipherRefused = true; }
        expect(sourceCipherRefused).toBe(true);
        // Restore the remote profile in every case, but respect a per-proxy
        // local decision rather than silently replacing its existing identity.
        const resolutions = decision === "local-wins" ? { ["proxies:" + PROXY]: "local" as const } : undefined;
        const result = await service.syncService.pull(undefined, { strategy: "remote", resolutions });
        expect(result.success, safeFailure(result)).toBe(true);
        const keptLocal = decision === "local-wins";
        const stored = await assertProxyHandoff(keptLocal ? localUsername : username, keptLocal ? "old-proxy-secret" : PROXY_SECRET);
        if (keptLocal) expect(stored === previousCipher).toBe(true);
        else expect(stored === sourceCipher).toBe(false);
        await assertNative(); assertFreshAcquireReady();
      } finally { sourceKey.fill(0); }
    });
    it("does not decrypt a valid vault-shaped literal username as guessed legacy storage", async () => {
      const username = secrets.encryptLiteralSecret("owned-value-that-is-not-the-proxy-username");
      await publish(username); await resetDevice("vault-shaped-username-receiver");
      const result = await service.syncService.pull(undefined, { strategy: "remote" });
      expect(result.success, safeFailure(result)).toBe(true);
      await assertProxyHandoff(username, PROXY_SECRET);
    });
  });
  it("pushes encrypted v4 artifacts through independent PUT+GET and restores passwords/Cookies/IDB/SW/sessions/history plus old receiver backup", async () => {
    const sourceDevice = h.device, sourceKey = fs.readFileSync(path.join(sourceDevice, ".secret-vault-key"));
    try {
      const document = await publish(), artifact = fullArtifact(document), body = fixture.objects.get(artifact.key)!;
      expect(Buffer.isBuffer(body)).toBe(true); expect(sha(body) === artifact.sha256).toBe(true); expect(body.length).toBe(artifact.size);
      for (const secret of [PASSWORD, COOKIE, Buffer.from(PROXY_SECRET), Buffer.from(PROXY_USER), Buffer.from(phrase), sourceKey]) expect(body.includes(secret)).toBe(false);
      const publicConfig = JSON.parse(zlib.gunzipSync(Buffer.from(document.data, "base64")).toString());
      expect(Object.hasOwn(publicConfig.sync ?? {}, "fullProfilePassphrase")).toBe(false); expect(Object.hasOwn(publicConfig.proxies[PROXY], "password")).toBe(false); expect(Object.hasOwn(publicConfig.proxies[PROXY], "username")).toBe(false);
      expect(Object.keys(document.cookies ?? {})).toHaveLength(0); expect(Object.keys(document.localStorage ?? {})).toHaveLength(0); expect(h.cookieExports).toBe(0);
      expect(fixture.journal.filter(r => r.method === "PUT").map(r => r.key).sort()).toEqual([artifact.key, CONFIG_KEY].sort());
      const put = fixture.journal.findIndex(r => r.method === "PUT" && r.key === artifact.key), readback = fixture.journal.findIndex(r => r.method === "GET" && r.key === artifact.key), manifest = fixture.journal.findIndex(r => r.method === "PUT" && r.key === CONFIG_KEY);
      expect(put).toBeGreaterThan(-1); expect(readback).toBeGreaterThan(put); expect(manifest).toBeGreaterThan(readback);
      const sourceTree = inventory(profileRoot()); await resetDevice("receiver-device"); const targetKey = fs.readFileSync(path.join(h.device, ".secret-vault-key"));
      try { expect(sourceKey.equals(targetKey)).toBe(false); } finally { targetKey.fill(0); }
      await seedProfile(true); const old = inventory(profileRoot()), originalSourceRoot = path.join(sourceDevice, "profiles", ID), live = profileRoot(), configFile = config.getConfigPath(); let markerBeforeMove = 0, markerAtConfigCommit = 0;
      h.fault = (op, from, to) => {
        if (op === "rename" && from === live && to?.startsWith(live + ".full-profile-backup-") && fs.existsSync(recoveryReceiptPath())) markerBeforeMove++;
        if (op === "rename" && to === configFile && from.startsWith(configFile + ".tmp-") && fs.existsSync(recoveryReceiptPath())) markerAtConfigCommit++;
      };
      const pulled = await service.syncService.pull(); h.fault = null; expect(pulled.success, safeFailure(pulled)).toBe(true);
      expect(pulled.items?.some(item => item.scope === "fullProfile" && item.id === ID && item.state === "applied")).toBe(true);
      await assertNative(); for (const relative of persistent) expect(fs.readFileSync(path.join(profileRoot(), relative)).equals(Buffer.from("source-record:" + relative))).toBe(true);
      expect(fs.existsSync(path.join(profileRoot(), "receiver-only.bin"))).toBe(false); expect(Boolean(backupFor(old))).toBe(true); sameTree(backupFor(old)!, old);
      expect([...inventory(profileRoot()).keys()].some(name => /environment\.bin|\.credentials-|\.credential-publish-|\.full-profile-manifest/.test(name))).toBe(false);
      expect(secrets.decryptSecretOr(config.getConfig().proxies[PROXY].password ?? "") === PROXY_SECRET).toBe(true); expect(config.getConfig().proxies[PROXY].username === PROXY_USER).toBe(true);
      expect(secrets.decryptSecretOr(config.getConfig().sync.fullProfilePassphrase ?? "") === phrase).toBe(true); expect(fs.readFileSync(config.getConfigPath()).includes(Buffer.from(PROXY_SECRET))).toBe(false); expect(fs.readFileSync(config.getConfigPath()).includes(Buffer.from(phrase))).toBe(false);
      sameTree(originalSourceRoot, sourceTree); config.reloadConfig(); await assertNative(); expect(sha(fixture.objects.get(CONFIG_KEY)!) === sha(Buffer.from(JSON.stringify(document)))).toBe(true);
      expect(markerBeforeMove).toBe(1); expect(markerAtConfigCommit).toBe(1); assertFreshAcquireReady();
    } finally { sourceKey.fill(0); }
  });
  it("does not export full-profile data or claim complete coverage when explicitly unselected", async () => {
    config.setSyncConfig({ includeFullProfile: false, includeHistory: false }); await seedProfile();
    // Limited legacy LS mode intentionally refuses mixed backends. This scope
    // test uses one legal source layout; complete-mode tests retain both.
    fs.rmSync(path.join(profileRoot(), "Default/Local Storage"), { recursive: true });
    const result = await service.syncService.push(undefined, true); expect(result.success, safeFailure(result)).toBe(true);
    expect(fixture.journal.some(r => r.method === "PUT" && r.key.startsWith("full-profile-v1-"))).toBe(false);
    expect(result.items?.some(item => item.scope === "fullProfile" && ["uploaded", "applied"].includes(item.state))).toBe(false);
    expect(Boolean(payload().fullProfiles?.[ID])).toBe(false);
  });
  it("does not downgrade an existing full snapshot when full-profile mode becomes unselected", async () => {
    await publish(); const before = sha(fixture.objects.get(CONFIG_KEY)!), source = inventory(profileRoot()), start = fixture.journal.length;
    config.setSyncConfig({ includeFullProfile: false, includeHistory: false });
    const result = await service.syncService.push(undefined, true);
    expect(result.success).toBe(false); expect(result.code).toBe("FULL_PROFILE_DOWNGRADE_BLOCKED"); expect(sha(fixture.objects.get(CONFIG_KEY)!) === before).toBe(true); sameTree(profileRoot(), source);
    expect(fixture.journal.slice(start).some(r => r.method === "PUT")).toBe(false);
  });
  it("stores migration phrase and proxy credentials under two distinct real test vaults, never importing source vault ciphertext as a usable target secret", async () => {
    const document = await publish(), sourcePhraseCipher = config.getConfig().sync.fullProfilePassphrase!, sourceProxyCipher = config.getConfig().proxies[PROXY].password!; await resetDevice("separate-secret-device");
    let refused = false; try { secrets.decryptSecretOr(sourcePhraseCipher); } catch { refused = true; } expect(refused).toBe(true);
    const pulled = await service.syncService.pull(undefined, { strategy: "remote" }); expect(pulled.success, safeFailure(pulled)).toBe(true);
    expect(config.getConfig().sync.fullProfilePassphrase === sourcePhraseCipher).toBe(false); expect(config.getConfig().proxies[PROXY].password === sourceProxyCipher).toBe(false); expect(secrets.decryptSecretOr(config.getConfig().proxies[PROXY].password ?? "") === PROXY_SECRET).toBe(true);
    expect(fullArtifact(document).snapshotId).toBe(document.snapshotId); await assertNative();
  });
  it.each(["phrase", "object", "crypto-identity", "config-hash"])("refuses receiver %s errors without changing old profile/config or remote snapshot", async fault => {
    const document = await publish(), artifact = fullArtifact(document); await resetDevice("failed-receiver", { phrase: fault === "phrase" ? randomBytes(24).toString("base64url") : phrase }); await seedProfile(true);
    if (fault === "object") fixture.getHook((key, body) => { if (key === artifact.key && body) { const corrupt = Buffer.from(body); corrupt[corrupt.length - 1] ^= 1; return corrupt; } });
    if (fault === "crypto-identity") { const entry = document.fullProfiles[ID]; (entry.artifact ?? entry).sourcePlatform = PLATFORM === "darwin" ? "linux" : "darwin"; fixture.objects.set(CONFIG_KEY, Buffer.from(JSON.stringify(document))); }
    if (fault === "config-hash") { const config = JSON.parse(zlib.gunzipSync(Buffer.from(document.data, "base64")).toString()); config.browserProfiles[ID].fingerprintSeed = 777; document.data = zlib.gzipSync(JSON.stringify(config)).toString("base64"); fixture.objects.set(CONFIG_KEY, Buffer.from(JSON.stringify(document))); }
    const before = oldReceiver(), result = await service.syncService.pull(undefined, { strategy: "remote" }); expect(result.success).toBe(false); assertOld(before); expect(result.items?.some(item => item.scope === "fullProfile" && item.state === "applied")).toBe(false);
  });
  it.each(["running", "unknown"])("preserves the old remote full snapshot when source runtime is %s", async state => {
    await publish(); const before = sha(fixture.objects.get(CONFIG_KEY)!); if (state === "running") h.running.add(ID); else h.unknownRunning = true;
    const result = await service.syncService.push(undefined, true); expect(result.success).toBe(false); expect(sha(fixture.objects.get(CONFIG_KEY)!) === before).toBe(true);
  });
  it("does not change an active receiver or adopt remote metadata", async () => {
    await publish(); await resetDevice("running-receiver"); await seedProfile(true); const before = oldReceiver(); h.running.add(ID);
    const result = await service.syncService.pull(undefined, { strategy: "remote" }); expect(result.success).toBe(false); assertOld(before);
  });
  it.each(["metadata", "proxy", "consent"])("stops after awaited full-object PUT if %s changes and preserves the old remote envelope", async change => {
    await publish(); const old = sha(fixture.objects.get(CONFIG_KEY)!); let fired = 0;
    fixture.putHook(key => { if (!fired && key.startsWith("full-profile-v1-")) { fired++; if (change === "consent") config.setSyncConfig({ fullProfileConsent: false }); else { const cfg = structuredClone(config.getConfig()); if (change === "proxy") cfg.proxies[PROXY].password = secrets.encryptSecret("owned-changed-proxy-password"); else cfg.browserProfiles[ID].name = "changed-across-await"; config.saveConfig(cfg); } } });
    const result = await service.syncService.push(undefined, true); expect(fired).toBe(1); expect(result.success).toBe(false); expect(sha(fixture.objects.get(CONFIG_KEY)!) === old).toBe(true);
  });
  it("rolls back a planted directory-install failure and preserves old receiver bytes and remote full snapshot", async () => {
    await publish(); await resetDevice("restore-failure-receiver"); await seedProfile(true); const before = oldReceiver(), live = profileRoot(); let fired = 0, markerAtFault = false;
    h.fault = (op, from, to) => { if (!fired && op === "rename" && from.includes(".full-profile-stage-") && to === live) { fired++; markerAtFault = fs.existsSync(recoveryReceiptPath()); throw Object.assign(new Error("Synthetic receiver install failure"), { code: "EIO" }); } };
    const result = await service.syncService.pull(undefined, { strategy: "remote" }); h.fault = null; expect(fired, safeFailure(result)).toBe(1); expect(result.success).toBe(false); assertOld(before);
    expect(markerAtFault).toBe(true); assertFreshAcquireReady();
  });
  describe("durable full-profile recovery main-flow", () => {
    it.each(["old-to-backup", "stage-to-live"] as const)("persists an operator-required receipt when runtime changes during real %s rename", async phase => {
      await publish(); await resetDevice("runtime-change-" + phase); await seedProfile(true);
      const before = oldReceiver(), live = profileRoot(); let fired = 0, oldMoves = 0, stageMoves = 0, backup = "", originalStage = "";
      h.fault = (op, from, to) => {
        if (op !== "rename") return;
        if (from === live && to?.startsWith(live + ".full-profile-backup-")) {
          oldMoves++; backup = to;
          if (phase === "old-to-backup" && !fired) { fired++; h.running.add(ID); }
        }
        if (from.includes(".full-profile-stage-") && to === live) {
          stageMoves++; originalStage = from;
          if (phase === "stage-to-live" && !fired) { fired++; h.running.add(ID); }
        }
        // Deliberately no throw/skip: the fs mock now performs the REAL rename.
        // The following production guard, not the test fault, must stop apply.
      };
      const result = await service.syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
      expect(fired, safeFailure(result)).toBe(1); expect(oldMoves).toBe(1); expect(stageMoves).toBe(phase === "old-to-backup" ? 0 : 1);
      expect(result.success).toBe(false); expect(result.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(result.outcome).toBe("recovery-required");
      assertOrdinaryLeaseReleased(); expect(fs.existsSync(recoveryReceiptPath())).toBe(true);
      const receiptStat = fs.lstatSync(recoveryReceiptPath()); expect(receiptStat.isFile() && !receiptStat.isSymbolicLink() && receiptStat.nlink === 1).toBe(true); expect(receiptStat.mode & 0o777).toBe(0o600);
      const receiptBytes = fs.readFileSync(recoveryReceiptPath()), receiptHash = sha(receiptBytes), receipt = JSON.parse(receiptBytes.toString());
      expect(receipt.dirId === ID && receipt.operationId === result.operationId && receipt.receiptPath === recoveryReceiptPath()).toBe(true); expect(receipt.profileDir === live && receipt.backupDir === backup).toBe(true);
      expect(typeof receipt.stagingDir === "string" && !path.relative(h.caseRoot, receipt.stagingDir).startsWith("..")).toBe(true); expect(fs.lstatSync(receipt.stagingDir).isDirectory()).toBe(true);
      const recovery = result.recovery?.find(entry => entry.resource === "profiles" && entry.id === ID); expect(Boolean(recovery)).toBe(true); expect(recovery!.receiptPath === recoveryReceiptPath()).toBe(true);
      expect(sha(fs.readFileSync(config.getConfigPath())) === before.configHash).toBe(true); expect(sha(fixture.objects.get(CONFIG_KEY)!) === before.remote).toBe(true); sameTree(backup, before.profile);
      let incoming: string;
      if (phase === "old-to-backup") { expect(fs.existsSync(live)).toBe(false); const stages = profileStageDirectories().filter(directory => path.basename(directory).startsWith("." + ID + ".full-profile-stage-")); expect(stages.length).toBe(1); incoming = stages[0]; }
      else { expect(fs.existsSync(originalStage)).toBe(false); incoming = live; }
      await assertNative(incoming); const incomingBefore = inventory(incoming);
      for (const relative of persistent) expect(fs.readFileSync(path.join(incoming, relative)).equals(Buffer.from("source-record:" + relative))).toBe(true);
      expect(recovery!.paths.includes(backup) && recovery!.paths.includes(incoming)).toBe(true);
      h.running.clear(); assertRecoveryBlocksFreshAcquire(locks);
      // Same user-data root, fresh module state: this models a Studio restart,
      // not a different test device and not an in-memory lock-only refusal.
      vi.resetModules(); locks = await import("../../src/main/services/profile-restore-lock.js"); assertRecoveryBlocksFreshAcquire(locks);
      expect(sha(fs.readFileSync(recoveryReceiptPath())) === receiptHash).toBe(true); sameTree(backup, before.profile); sameTree(incoming, incomingBefore);
    });
    it("keeps the recovery gate and new data when config.tmp and committed config.json fsync both return EIO", async () => {
      await publish(); await resetDevice("config-durability-failure-receiver"); await seedProfile(true);
      const before = oldReceiver(), live = profileRoot(), configFile = config.getConfigPath(); let temporarySyncs = 0, committedSyncs = 0, configRenames = 0, installed = 0, rollbackMoves = 0;
      h.fault = (op, from, to) => {
        if (op === "rename" && from.includes(".full-profile-stage-") && to === live) installed++;
        if (op === "rename" && installed && from === live && to?.includes(".full-profile-")) rollbackMoves++;
        if (op === "rename" && installed && to === configFile && from.startsWith(configFile + ".tmp-")) configRenames++;
        if (op === "fsync" && installed && !configRenames && from.startsWith(configFile + ".tmp-")) { temporarySyncs++; throw Object.assign(new Error("Synthetic config temporary fsync failure"), { code: "EIO" }); }
        if (op === "fsync" && temporarySyncs && configRenames && from === configFile) { committedSyncs++; throw Object.assign(new Error("Synthetic committed config fsync failure"), { code: "EIO" }); }
      };
      const result = await service.syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
      expect(temporarySyncs, safeFailure(result)).toBeGreaterThan(0); expect(committedSyncs, safeFailure(result)).toBeGreaterThan(0); expect(configRenames).toBe(1); expect(installed).toBe(1); expect(rollbackMoves).toBe(0);
      expect(result.success).toBe(false); expect(result.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(result.outcome).toBe("recovery-required"); assertOrdinaryLeaseReleased();
      // The shared store swallowed the temp-file flush error and published its
      // CAS. A failed strict post-commit flush must NOT restore old data under
      // that physically new config, nor certify the receipt removable.
      const disk = JSON.parse(fs.readFileSync(configFile, "utf8")); expect(disk.browserProfiles[ID].fingerprintSeed).toBe(42); expect(sha(fs.readFileSync(configFile)) === before.configHash).toBe(false);
      await assertNative(); expect(fs.existsSync(path.join(live, "receiver-only.bin"))).toBe(false);
      for (const relative of persistent) expect(fs.readFileSync(path.join(live, relative)).equals(Buffer.from("source-record:" + relative))).toBe(true);
      expect(Boolean(backupFor(before.profile))).toBe(true); sameTree(backupFor(before.profile)!, before.profile); expect(sha(fixture.objects.get(CONFIG_KEY)!) === before.remote).toBe(true);
      const stat = fs.lstatSync(recoveryReceiptPath()); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true); expect(stat.mode & 0o777).toBe(0o600);
      const receiptHash = sha(fs.readFileSync(recoveryReceiptPath())), recovery = result.recovery?.find(entry => entry.resource === "profiles" && entry.id === ID);
      expect(Boolean(recovery)).toBe(true); expect(recovery!.receiptPath === recoveryReceiptPath()).toBe(true); assertRecoveryBlocksFreshAcquire(locks); expect(sha(fs.readFileSync(recoveryReceiptPath())) === receiptHash).toBe(true);
    });
    it("allows configuration commit failure and retry after verified rollback, preserving incoming material outside the unresolved-stage prefix", async () => {
      await publish(); await resetDevice("config-commit-failure-receiver"); await seedProfile(true);
      const before = oldReceiver(), live = profileRoot(), configFile = config.getConfigPath(); let installed = 0, failed = 0;
      h.fault = (op, from, to) => {
        if (op === "rename" && from.includes(".full-profile-stage-") && to === live) installed++;
        if (!failed && installed && op === "rename" && to === configFile && from.startsWith(configFile + ".tmp-")) {
          failed++; throw Object.assign(new Error("Synthetic complete-profile config commit failure"), { code: "EIO" });
        }
      };
      const first = await service.syncService.pull(undefined, { strategy: "remote" }); h.fault = null;
      expect(installed, safeFailure(first)).toBe(1); expect(failed, safeFailure(first)).toBe(1); expect(first.success).toBe(false); expect(first.outcome).toBe("failed"); expect(first.localCommit).toBe("none");
      assertOld(before); assertFreshAcquireReady();
      const retainedBeforeRetry = profileStageDirectories(); expect(retainedBeforeRetry.length).toBeGreaterThan(0);
      for (const directory of retainedBeforeRetry) await assertNative(directory);
      // Execute the retry BEFORE checking the new retention prefix: this plants
      // the historical deadlock at the actual second restore, not a regex-only
      // assertion that could hide failure to retry the main service.
      const second = await service.syncService.pull(undefined, { strategy: "remote" });
      expect(second.success, safeFailure(second)).toBe(true); await assertNative(); assertFreshAcquireReady();
      const retained = profileStageDirectories(); expect(retained.length).toBeGreaterThan(0);
      expect(retained.every(directory => path.basename(directory).includes(".full-profile-rollback-"))).toBe(true);
      for (const directory of retained) {
        await assertNative(directory);
        expect((first.warnings ?? []).some(warning => warning.includes(directory)) || (first.recovery ?? []).some(entry => entry.paths.includes(directory))).toBe(true);
      }
      expect(Boolean(backupFor(before.profile))).toBe(true); sameTree(backupFor(before.profile)!, before.profile);
    });
  });
  describe("external pending Cookie queue full-profile gates", () => {
    it.each(["pending", "corrupt"] as const)("rejects a source %s queue, keeps its exact generation and the previous remote snapshot", async state => {
      await publish(); const queue = await queueApi();
      if (state === "pending") putPendingQueue(queue);
      else {
        fs.mkdirSync(path.dirname(queuePath()), { recursive: true, mode: 0o700 }); fs.writeFileSync(queuePath(), "{synthetic-corrupt-cookie-queue", { flag: "wx", mode: 0o600 });
        let unavailable = false; try { queue.readQueuedCookieImports(ID, { strict: true }); } catch { unavailable = true; } expect(unavailable).toBe(true);
      }
      const before = oldReceiver(), queued = queueWitness(), start = fixture.journal.length;
      const result = await service.syncService.push(undefined, true);
      expect(result.success, safeFailure(result)).toBe(false); expect(result.code).toBe(state === "pending" ? "FULL_PROFILE_COOKIE_QUEUE_PENDING" : "FULL_PROFILE_COOKIE_QUEUE_UNAVAILABLE");
      assertOld(before); assertQueueUnchanged(queued); expect(fixture.journal.slice(start).some(row => row.method === "PUT")).toBe(false);
    });
    it("rejects an old receiver queue without writing its profile/config or clearing the future replay", async () => {
      await publish(); await resetDevice("queued-receiver"); await seedProfile(true); const queue = await queueApi(); putPendingQueue(queue);
      const before = oldReceiver(), queued = queueWitness(), start = fixture.journal.length;
      const result = await service.syncService.pull(undefined, { strategy: "remote" });
      expect(result.success, safeFailure(result)).toBe(false); expect(result.code).toBe("FULL_PROFILE_COOKIE_QUEUE_PENDING"); assertOld(before); assertQueueUnchanged(queued);
      expect(fixture.journal.slice(start).some(row => row.method === "GET" && row.key.startsWith("full-profile-v1-"))).toBe(false);
    });
    it.each(["PUT", "GET"] as const)("stops a source queue appearing during full-object %s before replacing the old remote manifest", async phase => {
      await publish(); const queue = await queueApi(), before = oldReceiver(); let fired = 0, queued: ReturnType<typeof queueWitness> | undefined;
      const inject: Hook = key => { if (!fired && key.startsWith("full-profile-v1-")) { fired++; putPendingQueue(queue); queued = queueWitness(); } };
      if (phase === "PUT") fixture.putHook(inject); else fixture.getHook(inject);
      const result = await service.syncService.push(undefined, true);
      expect(fired).toBe(1); expect(result.success, safeFailure(result)).toBe(false); expect(result.code).toBe("FULL_PROFILE_COOKIE_QUEUE_PENDING"); assertOld(before); expect(Boolean(queued)).toBe(true); assertQueueUnchanged(queued!);
    });
    it("stops a receiver queue appearing during full-object GET before applying any remote data", async () => {
      await publish(); await resetDevice("late-queued-receiver"); await seedProfile(true); const queue = await queueApi(), before = oldReceiver(); let fired = 0, queued: ReturnType<typeof queueWitness> | undefined;
      fixture.getHook(key => { if (!fired && key.startsWith("full-profile-v1-")) { fired++; putPendingQueue(queue); queued = queueWitness(); } });
      const result = await service.syncService.pull(undefined, { strategy: "remote" });
      expect(fired).toBe(1); expect(result.success, safeFailure(result)).toBe(false); expect(result.code).toBe("FULL_PROFILE_COOKIE_QUEUE_PENDING"); assertOld(before); expect(Boolean(queued)).toBe(true); assertQueueUnchanged(queued!);
    });
  });
  it("refuses a legacy v3 remote as FULL_PROFILE_SNAPSHOT_REQUIRED instead of pretending a complete import", async () => {
    const document = await publish(); document.artifactVersion = 3; delete document.fullProfiles; fixture.objects.set(CONFIG_KEY, Buffer.from(JSON.stringify(document)));
    await resetDevice("legacy-v3-receiver"); await seedProfile(true); const before = oldReceiver(), result = await service.syncService.pull(undefined, { strategy: "remote" });
    expect(result.success).toBe(false); expect(result.code).toBe("FULL_PROFILE_SNAPSHOT_REQUIRED"); assertOld(before);
  });
});

// Portable local configuration boundary only. This does not turn an unsupported
// Windows full-profile backend/directory durability result into a restore pass.
describe("local proxy configuration contract without native browser restoration", () => {
  it.each(proxyUsernames)("stores, reloads and hands off the $label username literally", async ({ username }) => {
    config.addProxy(PROXY, { type: "http", host: "proxy.complete.synthetic.invalid", port: 8080, username, password: secrets.encryptLiteralSecret(PROXY_SECRET) });
    config.setProfileMeta(ID, { name: "Owned local proxy contract", engine: "chromium", proxyMode: "named", proxyName: PROXY });
    await assertProxyHandoff(username, PROXY_SECRET);
  });
});
