// Protocol-level R2 verification: real exclusive config/profile files and an
// exact-byte in-memory S3 boundary. Never launch/read a real browser or cloud.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-protocol-roundtrip-r2-"));
  const identity = fs.lstatSync(root);
  return {
    root, realRoot: fs.realpathSync(root), ownerDev: identity.dev, ownerIno: identity.ino,
    appData: path.join(root, "device"), realAppData: "",
    objects: new Map<string, Buffer>(), requests: [] as Array<{ method: string; url: string }>,
    effects: null as null | Array<{ op: string; file: string; to?: string }>,
    ownedStages: new Set<string>(),
    fdPaths: new Map<number, string>(), snapshot: vi.fn(), importCookies: vi.fn(),
  };
});

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  hostname: () => "owned-protocol-fixture-host",
  homedir: () => path.join(h.root, "owned-home"),
}));
vi.mock("electron", () => ({
  app: { getPath: (name: string) => name === "home" ? path.join(h.root, "owned-home") : h.appData },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  findBrowserByProfileSync: () => null,
  getRunningProcessesAsync: async () => [],
}));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({
  runtimeCookieOps: { hasRunningBrowser: () => false, exportCookiesSnapshot: h.snapshot,
    exportCookies: async () => [], importCookies: h.importCookies },
  firefoxCookieService: { applyQueuedImports: async () => 0 },
}));
// Only record actual mutations under this fixture; production file bytes and
// publication/cleanup code are not replaced by an in-memory filesystem.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const owned = (file: unknown) => typeof file === "string" &&
    [h.root, h.realRoot].some((root) => file.startsWith(root + path.sep));
  const observe = (op: string, file: unknown, to?: unknown) => {
    if (h.effects && (owned(file) || owned(to))) h.effects.push({ op, file: String(file), ...(to === undefined ? {} : { to: String(to) }) });
  };
  return {
    ...actual,
    openSync: (file: any, flags: any, mode?: any) => {
      const fd = actual.openSync(file, flags, mode);
      if (owned(file)) h.fdPaths.set(fd, String(file));
      const writing = typeof flags === "string" ? /[wa+]/.test(flags)
        : Boolean(flags & (actual.constants.O_WRONLY | actual.constants.O_RDWR | actual.constants.O_CREAT | actual.constants.O_TRUNC | actual.constants.O_APPEND));
      if (writing) observe("open-write", file);
      return fd;
    },
    closeSync: (fd: number) => { h.fdPaths.delete(fd); return actual.closeSync(fd); },
    writeFileSync: (file: any, ...args: any[]) => {
      const result = (actual.writeFileSync as any)(file, ...args);
      observe("write", typeof file === "number" ? h.fdPaths.get(file) : file);
      return result;
    },
    mkdtempSync: (prefix: any, ...args: any[]) => {
      const created = (actual.mkdtempSync as any)(prefix, ...args);
      // This service deliberately stages on the profiles filesystem. Exempt
      // only these exact exclusively-created operation paths, never a broad
      // hidden-directory prefix or an unregistered existing recovery copy.
      if (h.effects && path.dirname(created) === path.join(h.appData, "profiles") && path.basename(created).startsWith(".sync-pull-stage-")) {
        h.ownedStages.add(created);
        h.ownedStages.add(actual.realpathSync(created));
      }
      return created;
    },
    mkdirSync: (file: any, ...args: any[]) => {
      const existed = actual.existsSync(file);
      const result = (actual.mkdirSync as any)(file, ...args);
      if (!existed) observe("mkdir", file);
      return result;
    },
    renameSync: (from: any, to: any) => { const result = actual.renameSync(from, to); observe("rename", from, to); return result; },
    copyFileSync: (from: any, to: any, ...args: any[]) => {
      const result = (actual.copyFileSync as any)(from, to, ...args); observe("copy", to); return result;
    },
    unlinkSync: (file: any) => { const result = actual.unlinkSync(file); observe("unlink", file); return result; },
    rmSync: (file: any, ...args: any[]) => {
      const existed = actual.existsSync(file);
      const result = (actual.rmSync as any)(file, ...args);
      if (existed) observe("rm", file);
      return result;
    },
  };
});

import { syncService } from "../../src/main/services/sync-service.js";
import { getConfig, getConfigPath, getProfileMeta, getProfilesDir, reloadConfig, saveConfig, portableProfileContent } from "../../src/main/services/config-manager.js";
import { PORTABLE_PROFILE_FIELDS } from "../../src/main/services/profile-portability.js";
import { listBrowserProfiles } from "../../src/main/services/browser-manager.js";
import { getProfileInfo } from "../../src/main/services/profile-manager.js";
import { isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";

const ID = "ab_protocol_roundtrip";
const OTHER = "ab_protocol_unrelated";
const NOW = 1792280000000;
const ENDPOINT = "https://sync.example.test";
const MAIN = `${ENDPOINT}/protocol-fixture/agent-browser-studio-config.json`;
const SOURCE_PREFS = Buffer.from('{"protocol":"source","browser":{"check_default_browser":false}}\n');
const RECEIVER_PREFS = Buffer.from('{"protocol":"receiver-original"}\n');
const SENTINEL = Buffer.from([0, 255, 1, 13, 10, 128, 42]);
const REMOTE_COOKIE = { domain: "example.test", name: "protocol", value: "synthetic-remote-cookie", path: "/", expires: null, secure: false, httpOnly: true, sameSite: 0 };
const LOCAL_COOKIE = { ...REMOTE_COOKIE, value: "synthetic-local-cookie" };
const OMITTABLE = ["tags", "preset", "appUrl", "drm", "fingerprintBaseline"] as const;
const runtime = { chromiumPath: null, chromiumVersion: null, firefoxVersion: null, chromiumInstalled: null, pending: true };
const gzipJson = (value: unknown) => zlib.gzipSync(Buffer.from(JSON.stringify(value))).toString("base64");
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const prefsPath = (id = ID) => path.join(getProfilesDir(), id, "Default", "Preferences");
const queuePath = () => path.join(h.appData, "pending-cookie-imports", `${ID}.json`);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function assertOwner(): void {
  const current = fs.lstatSync(h.root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== h.ownerDev || current.ino !== h.ownerIno || fs.realpathSync(h.root) !== h.realRoot) {
    throw new Error("Refusing unowned protocol fixture mutation");
  }
}
function resetDevice(identity: string): void {
  assertOwner();
  if (fs.existsSync(h.appData)) {
    if (!fs.lstatSync(h.appData).isDirectory() || fs.lstatSync(h.appData).isSymbolicLink()) throw new Error("Unexpected protocol fixture device path");
    fs.rmSync(h.appData, { recursive: true });
  }
  fs.mkdirSync(h.appData, { mode: 0o700 });
  h.realAppData = fs.realpathSync(h.appData);
  reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.deviceId = identity;
  cfg.deviceName = identity;
  cfg.browserProfiles = {};
  cfg.proxies = {};
  cfg.extensionRepository = {};
  cfg.accounts = [];
  cfg.automationNotify = { system: true, sound: false };
  cfg.sync = { enabled: true, endpoint: ENDPOINT, bucket: "protocol-fixture", accessKey: "synthetic-protocol-access", secretKey: "synthetic-protocol-secret", custodyConsentAt: 1 };
  saveConfig(cfg);
  expect(getConfigPath()).toBe(path.join(h.appData, "config.json"));
  expect(getProfilesDir()).toBe(path.join(h.appData, "profiles"));
}
function makeFontDir(role: string): string {
  const directory = path.join(h.appData, "fonts", role);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "owned-font-sentinel.txt"), `synthetic-font:${role}`);
  return fs.realpathSync(directory);
}
function completePortable(engine: "chromium" | "firefox" = "chromium"): Record<string, any> {
  // Portable intent only, not a claim that any browser/kernel is installed or
  // these hardware overrides are supported on the machine running this test.
  return {
    name: "Protocol sender", fingerprintMode: "managed", engine,
    browserVersion: engine === "firefox" ? "154.0" : "149.0.0.1", allowThirdPartyCookies: true,
    fingerprintSeed: 13579, platform: "windows", timezone: "Asia/Tokyo", locale: "fr-FR",
    webrtcMode: "altered", webrtcIp: "198.51.100.10", geolocationMode: "custom",
    geolocationLatitude: 35, geolocationLongitude: 139, geolocationAccuracy: 100,
    gpuVendor: "Synthetic protocol vendor", gpuRenderer: "Synthetic protocol renderer",
    hardwareConcurrency: 6, deviceMemory: 16, screenWidth: 1600, screenHeight: 900,
    storageQuota: 8192, taskbarHeight: 50, renderScaleMode: "strict", windowTitlePrefix: "protocol-owner",
    appUrl: "https://app.example.test/workbench", drm: true, proxyMode: "named", proxyName: "fixture",
    note: "Protocol portable note\nsecond line", tags: ["roundtrip", "portable"], preset: "qa-protocol",
    extensions: { local_protocol01: false },
    fingerprintBaseline: { userAgent: "Synthetic/1.0", platform: "Win32", canvasHash: "protocol-canvas", hardwareConcurrency: 6 },
  };
}
function seedProfile(profile: Record<string, any>, fontsDir: string | null, preferences: Buffer | null): void {
  const cfg = structuredClone(getConfig());
  cfg.proxies.fixture = { type: "socks5h", host: "proxy.example.test", port: 1080 };
  cfg.browserProfiles[ID] = { ...profile, fontsDir, updatedAt: profile.updatedAt ?? 100 } as any;
  cfg.browserProfiles[OTHER] = { name: "Unrelated receiver sentinel", fingerprintSeed: 24680, proxyMode: "none" };
  saveConfig(cfg);
  fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
  if (preferences !== null) fs.writeFileSync(prefsPath(), preferences);
  fs.writeFileSync(path.join(getProfilesDir(), ID, "Default", "owned-browser-sentinel.bin"), SENTINEL);
}
function payload(): any { return JSON.parse(h.objects.get(MAIN)!.toString("utf8")); }
function remoteConfig(document = payload()): any {
  return JSON.parse(zlib.gunzipSync(Buffer.from(document.data, "base64")).toString("utf8"));
}
function storePayload(document: any, config?: any): void {
  if (config) document.data = gzipJson(config);
  h.objects.set(MAIN, Buffer.from(JSON.stringify(document)));
}
async function publish(engine: "chromium" | "firefox" = "chromium", preferences: Buffer | null = SOURCE_PREFS) {
  const fontsDir = makeFontDir("sender");
  seedProfile(completePortable(engine), fontsDir, preferences);
  const expected = portableProfileContent(disk().browserProfiles[ID]);
  expect(Object.keys(completePortable(engine)).sort()).toEqual([...PORTABLE_PROFILE_FIELDS].sort());
  const result = await syncService.push(undefined, true);
  expect(result.success, result.message).toBe(true);
  expect(result).toMatchObject({ localCommit: "committed", remoteCommit: "committed" });
  const document = payload();
  const uploaded = remoteConfig(document).browserProfiles[ID];
  expect(document.artifactVersion).toBe(2);
  expect(uploaded.syncBaseline).toMatchObject({ version: 1, snapshotId: document.snapshotId });
  expect(uploaded.syncBaseline).toEqual(disk().browserProfiles[ID].syncBaseline);
  for (const field of PORTABLE_PROFILE_FIELDS) expect(uploaded[field], `uploaded portable field ${field}`).toEqual(expected[field]);
  expect(uploaded.fontsDir).toBeNull();
  expect(JSON.stringify(remoteConfig(document))).not.toContain(fontsDir);
  expect(h.requests.some((request) => request.method === "PUT" && request.url === MAIN)).toBe(true);
  expect(h.requests.filter((request) => request.method === "GET" && request.url === MAIN).length).toBeGreaterThan(0);
  return { expected, document, uploaded, preferences };
}
async function assertBothEntrances(expectedStatus: string, expectedBaseline?: any): Promise<void> {
  const before = fs.readFileSync(getConfigPath());
  const listed = listBrowserProfiles(runtime).find((entry) => entry.dirId === ID)!;
  const detail = await getProfileInfo(ID, []);
  expect(listed).toBeDefined();
  for (const key of ["syncStatus", "syncScope", "syncReason", "syncedAt"] as const) expect(listed[key]).toEqual(detail[key]);
  expect(detail.syncStatus).toBe(expectedStatus);
  expect(detail.syncScope).toBe("portable-profile+preferences");
  if (expectedBaseline) {
    expect(disk().browserProfiles[ID].syncBaseline).toEqual(expectedBaseline);
    expect(getProfileMeta(ID)?.syncBaseline).toEqual(expectedBaseline);
    expect(detail.syncedAt).toBe(expectedBaseline.timestamp);
  }
  expect(fs.readFileSync(getConfigPath())).toEqual(before);
}
function critical(file: string): boolean {
  for (const stage of h.ownedStages) {
    const relative = path.relative(stage, file);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return false;
  }
  for (const root of [h.appData, h.realAppData]) {
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (relative === "config.json" || relative.startsWith("config.json.")) return true;
    if (["profiles", "fonts", "pending-cookie-imports", "extension-repository"].some((name) => relative === name || relative.startsWith(name + path.sep))) return true;
  }
  return false;
}
function protectedSnapshot(): any[] {
  const rows: any[] = [];
  function walk(file: string): void {
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("Protocol snapshot refuses symlinks");
    const relative = path.relative(h.appData, file);
    if (stat.isDirectory()) {
      rows.push({ path: relative, kind: "directory" });
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name));
    } else rows.push({ path: relative, kind: "file", bytes: stat.size, sha256: sha256(fs.readFileSync(file)) });
  }
  for (const name of ["config.json", "profiles", "fonts", "pending-cookie-imports", "extension-repository"]) walk(path.join(h.appData, name));
  return rows;
}
function seedReceiver(): void {
  const fonts = makeFontDir("receiver");
  const profile = { ...completePortable(), name: "Receiver unchanged", note: "Receiver original note" };
  seedProfile(profile, fonts, RECEIVER_PREFS);
  fs.mkdirSync(path.dirname(queuePath()), { recursive: true });
  fs.writeFileSync(queuePath(), JSON.stringify([LOCAL_COOKIE]));
  const leveldb = path.join(getProfilesDir(), ID, "Default", "Local Storage", "leveldb");
  fs.mkdirSync(leveldb, { recursive: true });
  fs.writeFileSync(path.join(leveldb, "CURRENT"), "MANIFEST-000001\n");
  fs.writeFileSync(path.join(leveldb, "MANIFEST-000001"), "owned-original-manifest");
}

beforeEach(() => {
  h.effects = null; h.ownedStages.clear(); h.objects.clear(); h.requests = [];
  h.snapshot.mockReset().mockResolvedValue({ state: "available", cookies: [] });
  h.importCookies.mockReset().mockResolvedValue(0);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  resetDevice("synthetic-sender");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(ENDPOINT + "/")).toBe(true);
    const method = init?.method || "GET";
    h.requests.push({ method, url });
    if (method === "PUT") { h.objects.set(url, Buffer.from(init?.body as any)); return new Response("", { status: 200 }); }
    expect(method).toBe("GET");
    const value = h.objects.get(url);
    return value ? new Response(new Uint8Array(value), { status: 200, headers: { "content-length": String(value.length) } })
      : new Response("synthetic object not found", { status: 404 });
  }));
});
afterEach(() => {
  h.effects = null;
  expect(isRestoreLocked(ID)).toBe(false);
  expect(isRestoreLocked(OTHER)).toBe(false);
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
afterAll(() => { assertOwner(); fs.rmSync(h.root, { recursive: true }); });

describe("new sync protocol actual push to fresh receiver roundtrip", () => {
  it.each(["chromium", "firefox"] as const)("preserves every portable field and V1 baseline through %s push/fresh pull/reload/both getters", async (engine) => {
    const published = await publish(engine);
    await assertBothEntrances("synced", published.uploaded.syncBaseline);
    resetDevice("synthetic-fresh-receiver");
    expect(getProfileMeta(ID)).toBeNull();
    expect(fs.existsSync(path.join(getProfilesDir(), ID))).toBe(false);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success, result.message).toBe(true);
    expect(result.localCommit).toBe("committed");
    expect(fs.readFileSync(prefsPath())).toEqual(SOURCE_PREFS);
    const received = disk().browserProfiles[ID];
    for (const field of PORTABLE_PROFILE_FIELDS) expect(received[field], `received portable field ${field}`).toEqual(published.expected[field]);
    expect(received.fontsDir).toBeNull();
    await assertBothEntrances("synced", published.uploaded.syncBaseline);
    reloadConfig();
    await assertBothEntrances("synced", published.uploaded.syncBaseline);
    expect(h.objects.get(MAIN)).toEqual(Buffer.from(JSON.stringify(published.document)));
  });

  it("roundtrips a confirmed-absent Preferences baseline without confusing it with a missing required artifact", async () => {
    const published = await publish("chromium", null);
    expect(published.uploaded.syncBaseline.preferences).toEqual({ state: "absent" });
    expect(published.document.preferences).not.toHaveProperty(ID);
    resetDevice("synthetic-absent-preferences-receiver");
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success, result.message).toBe(true);
    expect(fs.existsSync(prefsPath())).toBe(false);
    reloadConfig();
    await assertBothEntrances("synced", published.uploaded.syncBaseline);
  });

  it.each(["remote", "newest"] as const)("preserves same-ID receiver fonts when %s selects the remote portable content", async (strategy) => {
    const published = await publish();
    resetDevice("synthetic-same-id-receiver");
    const localFonts = makeFontDir("receiver");
    seedProfile({ ...completePortable(), name: "Local name to replace", updatedAt: 1 }, localFonts, RECEIVER_PREFS);
    const fontSentinel = path.join(localFonts, "owned-font-sentinel.txt");
    const originalFont = fs.readFileSync(fontSentinel);
    const result = await syncService.pull(undefined, { strategy });
    expect(result.success, result.message).toBe(true);
    expect(disk().browserProfiles[ID].name).toBe("Protocol sender");
    expect(disk().browserProfiles[ID].fontsDir).toBe(localFonts);
    expect(fs.readFileSync(fontSentinel)).toEqual(originalFont);
    for (const field of PORTABLE_PROFILE_FIELDS) expect(disk().browserProfiles[ID][field], field).toEqual(published.expected[field]);
    reloadConfig();
    expect(getProfileMeta(ID)?.fontsDir).toBe(localFonts);
    await assertBothEntrances("synced", published.uploaded.syncBaseline);
  });
});

describe("legacy sync optional-field absence", () => {
  it.each([...OMITTABLE.map((field) => ({ label: field, omitted: [field] })), { label: "all five optional fields", omitted: [...OMITTABLE] }])("does not clear receiver values when legacy payload omits $label", async ({ omitted }) => {
    await publish();
    const document = payload();
    const remote = remoteConfig(document);
    delete document.artifactVersion; delete document.snapshotId; delete document.artifactSources;
    delete remote.browserProfiles[ID].syncBaseline; delete remote.browserProfiles[ID].syncedAt; delete remote.browserProfiles[ID].syncedHash;
    for (const field of omitted) delete remote.browserProfiles[ID][field];
    remote.browserProfiles[ID].name = "Adopted legacy remote name";
    storePayload(document, remote);
    resetDevice("synthetic-legacy-receiver");
    const local = { ...completePortable(), tags: ["receiver-tag"], preset: "receiver-preset", appUrl: "https://receiver.example.test/local-app",
      drm: true, fingerprintBaseline: { userAgent: "ReceiverOnly", canvasHash: "receiver-baseline" } };
    const localFonts = makeFontDir("receiver");
    seedProfile(local, localFonts, RECEIVER_PREFS);
    const original = structuredClone(disk().browserProfiles[ID]);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success, result.message).toBe(true);
    expect(disk().browserProfiles[ID].name).toBe("Adopted legacy remote name");
    for (const field of omitted) expect(disk().browserProfiles[ID][field], `legacy omission ${field}`).toEqual(original[field]);
    expect(disk().browserProfiles[ID].fontsDir).toBe(localFonts);
    reloadConfig();
    for (const field of omitted) expect((getProfileMeta(ID) as any)[field], `reloaded legacy omission ${field}`).toEqual(original[field]);
    expect(listBrowserProfiles(runtime).find((entry) => entry.dirId === ID)?.syncStatus).not.toBe("synced");
    expect((await getProfileInfo(ID, [])).syncStatus).not.toBe("synced");
  });
});

const invalidArtifacts: Array<{ label: string; mutate: (document: any, remote: any) => void; reason: RegExp }> = [
  { label: "missing required Preferences", mutate: (p) => { delete p.preferences[ID]; }, reason: /preferences|baseline|content/i },
  { label: "corrupt Preferences gzip", mutate: (p) => { p.preferences[ID] = Buffer.from("not a gzip stream").toString("base64"); }, reason: /gzip|header|preferences|decompress|compressed/i },
  { label: "corrupt Preferences JSON", mutate: (p) => { p.preferences[ID] = zlib.gzipSync(Buffer.from('{"broken":')).toString("base64"); }, reason: /json|preferences/i },
  { label: "non-object Preferences", mutate: (p) => { p.preferences[ID] = gzipJson([]); }, reason: /object|preferences/i },
  { label: "changed Preferences bytes under the published baseline", mutate: (p) => { p.preferences[ID] = gzipJson({ protocol: "tampered" }); }, reason: /preferences|baseline|content/i },
  { label: "contradictory absent Preferences descriptor", mutate: (_p, r) => { r.browserProfiles[ID].syncBaseline.preferences = { state: "absent" }; }, reason: /preferences|baseline|descriptor/i },
  { label: "contradictory Preferences byte count", mutate: (_p, r) => { r.browserProfiles[ID].syncBaseline.preferences.bytes++; }, reason: /preferences|baseline|descriptor/i },
  { label: "contradictory Preferences hash", mutate: (_p, r) => { r.browserProfiles[ID].syncBaseline.preferences.sha256 = "0".repeat(64); }, reason: /preferences|baseline|descriptor/i },
  { label: "missing V1 baseline in a v2 payload", mutate: (_p, r) => { delete r.browserProfiles[ID].syncBaseline; }, reason: /baseline|snapshot/i },
  { label: "baseline from another snapshot", mutate: (_p, r) => { r.browserProfiles[ID].syncBaseline.snapshotId = "other-synthetic-snapshot"; }, reason: /baseline|snapshot/i },
  { label: "portable content contradicting the published baseline", mutate: (_p, r) => { r.browserProfiles[ID].drm = false; }, reason: /baseline|content/i },
];

describe("new V1 baseline preflight rejects before receiver side effects", () => {
  it.each(invalidArtifacts)("rejects $label without touching config/profile/queue/repository bytes", async ({ mutate, reason }) => {
    h.snapshot.mockResolvedValue({ state: "available", cookies: [REMOTE_COOKIE] });
    await publish();
    const document = payload();
    const remote = remoteConfig(document);
    mutate(document, remote);
    storePayload(document, remote);
    resetDevice("synthetic-rejection-receiver");
    seedReceiver();
    const before = protectedSnapshot();
    const configBefore = fs.readFileSync(getConfigPath());
    const queueBefore = fs.readFileSync(queuePath());
    h.requests = []; h.effects = [];
    const result = await syncService.pull(undefined, { strategy: "remote" });
    const effects = h.effects;
    h.effects = null;
    expect(result.success, result.message).toBe(false);
    expect(result.localCommit).toBe("none");
    expect(result.message).toMatch(reason);
    expect(effects.filter((effect) => critical(effect.file) || (effect.to && critical(effect.to)))).toEqual([]);
    expect(h.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(h.importCookies).not.toHaveBeenCalled();
    expect(protectedSnapshot()).toEqual(before);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.readFileSync(queuePath())).toEqual(queueBefore);
    expect(fs.readFileSync(prefsPath())).toEqual(RECEIVER_PREFS);
    reloadConfig();
    expect(getProfileMeta(ID)?.name).toBe("Receiver unchanged");
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(listBrowserProfiles(runtime).find((entry) => entry.dirId === ID)?.name).toBe("Receiver unchanged");
  });
});
