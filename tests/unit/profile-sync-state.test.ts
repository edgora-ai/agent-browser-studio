// R2: current public push/list/get behavior first, then V1 canonical baseline
// coverage. Config, Preferences and reload are real exclusive filesystem data.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "profile-sync-state-r2-")),
    readFaults: new Set<string>(),
    fdPaths: new Map<number, string>(),
    reads: [] as string[],
    discover: vi.fn(async () => []),
    findBrowser: vi.fn(() => null),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (file: any, ...args: any[]) => {
      const fd = (actual.openSync as any)(file, ...args);
      if (typeof file === "string" && file.startsWith(h.root + path.sep)) h.fdPaths.set(fd, file);
      return fd;
    },
    closeSync: (fd: number) => { h.fdPaths.delete(fd); return actual.closeSync(fd); },
    readFileSync: (file: any, ...args: any[]) => {
      const name = typeof file === "number" ? h.fdPaths.get(file) : file;
      if (typeof name === "string" && name.startsWith(h.root + path.sep)) {
        h.reads.push(name);
        if (h.readFaults.has(name)) throw Object.assign(new Error("EACCES: owned Preferences read failure"), { code: "EACCES" });
      }
      return (actual.readFileSync as any)(file, ...args);
    },
  };
});
vi.mock("electron", () => ({
  app: { getPath: (_name: string) => h.root },
  BrowserWindow: { getAllWindows: () => [] },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  getRunningProcessesAsync: h.discover,
  findBrowserByProfileSync: h.findBrowser,
}));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({
  runtimeCookieOps: { hasRunningBrowser: () => false, exportCookies: async () => [],
    exportCookiesSnapshot: async () => ({ state: "available", cookies: [] }), importCookies: async () => 0 },
  firefoxCookieService: {},
}));

import { getConfig, getConfigPath, getProfileMeta, getProfilesDir, reloadConfig, setProfileMeta, portableProfileContent, normalizePortableProfileMeta } from "../../src/main/services/config-manager.js";
import { PORTABLE_PROFILE_FIELDS, parseProfileSyncBaseline } from "../../src/main/services/profile-portability.js";
import { profilePreferencesSnapshot, getProfileSyncTarget, profileContentHash, createProfileSyncBaseline, readProfileSyncState } from "../../src/main/services/sync/profile-state.js";
import type { ProfilePreferencesSnapshot, ProfileSyncBaseline } from "../../src/main/types.js";
import { transact } from "../../src/main/services/config/store.js";
import { listBrowserProfiles } from "../../src/main/services/browser-manager.js";
import { getProfileInfo } from "../../src/main/services/profile-manager.js";
import { syncService } from "../../src/main/services/sync-service.js";

const ID = "ab_sync_state_r2";
const PREFS = path.join(h.root, "profiles", ID, "Default", "Preferences");
const PREF_BYTES = Buffer.from('{"browser":{"check_default_browser":false},"owned":"r2"}\n');
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const runtime = { chromiumPath: null, chromiumVersion: null, firefoxVersion: null, chromiumInstalled: null, pending: true };
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const hash = (value: any) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
function seed(): void {
  fs.mkdirSync(path.dirname(PREFS), { recursive: true });
  fs.writeFileSync(PREFS, PREF_BYTES);
  transact((draft) => {
    draft.sync = { enabled: true, endpoint: "https://sync.example.test", bucket: "synthetic-r2", accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: 1 };
    draft.browserProfiles[ID] = { name: "R2 profile", engine: "chromium", fingerprintMode: "managed", fingerprintSeed: 12345,
      platform: "windows", proxyMode: "none", updatedAt: 100, tags: ["r2"], note: "owned synthetic note" };
  });
}
async function statuses() {
  return { list: listBrowserProfiles(runtime).find((entry) => entry.dirId === ID)!, info: await getProfileInfo(ID, []) };
}
beforeEach(() => {
  h.readFaults.clear(); h.reads = [];
  for (const name of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, name), { recursive: true, force: true });
  reloadConfig(); getConfig(); seed();
});
afterEach(() => { h.readFaults.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => {
  if (path.dirname(h.root) !== os.tmpdir() || !path.basename(h.root).startsWith("profile-sync-state-r2-")) throw new Error("Unsafe R2 fixture cleanup");
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("current API behavioral sync regressions", () => {
  it("a successful actual push remains clean after bookkeeping-only updatedAt changes in both getters", async () => {
    // No real cloud: retain exact PUT bytes and serve actual GET readback, so
    // the producer must verify the snapshot it committed rather than a 200 flag.
    const objects = new Map<string, Buffer>();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const key = url instanceof Request ? url.url : String(url);
      expect(key).toContain("sync.example.test");
      const method = options?.method || (url instanceof Request ? url.method : "GET");
      if (method === "PUT") {
        objects.set(key, Buffer.from(options?.body as any));
        return new Response("", { status: 200 });
      }
      expect(method).toBe("GET");
      const body = objects.get(key);
      return body ? new Response(Buffer.from(body), { status: 200 }) : new Response("", { status: 404 });
    }));
    const pushed = await syncService.push(undefined, true);
    expect(pushed.success, JSON.stringify(pushed)).toBe(true);
    const stored = disk().browserProfiles[ID];
    expect(stored.syncedHash).toMatch(/^[0-9a-f]{64}$/);
    const oldHashInput = { ...stored, __artifactHash: PREF_BYTES.toString("base64") };
    delete oldHashInput.syncedAt; delete oldHashInput.syncedHash;
    const before = await statuses();
    console.info("R2_CURRENT_PUSH_STATE", JSON.stringify({ updatedAt: stored.updatedAt,
      storedHash: stored.syncedHash, rawIncludingUpdatedAtHash: hash(oldHashInput), list: before.list.syncStatus, info: before.info.syncStatus }));
    expect.soft(before.list.syncStatus).toBe("synced");
    expect.soft(before.info.syncStatus).toBe("synced");
    transact((draft) => { draft.browserProfiles[ID].updatedAt = 999999; });
    reloadConfig();
    const after = await statuses();
    expect(after.list.syncStatus).toBe("synced");
    expect(after.info.syncStatus).toBe("synced");
    expect(fs.readFileSync(PREFS)).toEqual(PREF_BYTES);
  });

  it("legacy-only markers are consistently unknown instead of list/get disagreement or timestamp-guessed clean", async () => {
    const projected = structuredClone(getProfileMeta(ID)) as any;
    delete projected.syncedAt; delete projected.syncedHash;
    transact((draft) => {
      draft.browserProfiles[ID].syncedAt = 4102444800000;
      draft.browserProfiles[ID].syncedHash = hash(projected);
    });
    const configBefore = fs.readFileSync(getConfigPath());
    const state = await statuses();
    console.info("R2_CURRENT_ENTRANCE_DISAGREEMENT", JSON.stringify({ list: state.list.syncStatus, info: state.info.syncStatus }));
    expect.soft(state.list.syncStatus).toBe(state.info.syncStatus);
    expect.soft(state.list.syncStatus).toBe("unknown");
    expect(state.info.syncStatus).toBe("unknown");
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
  });
});

const FULL_PROFILE = {
  name: "Complete R2 profile", fingerprintMode: "managed", engine: "chromium", browserVersion: null,
  allowThirdPartyCookies: false, fingerprintSeed: 12345, platform: "windows", timezone: "UTC", locale: "en-US",
  webrtcMode: "altered", webrtcIp: "203.0.113.10", geolocationMode: "custom", geolocationLatitude: 1,
  geolocationLongitude: 2, geolocationAccuracy: 50, gpuVendor: "Synthetic vendor", gpuRenderer: "Synthetic renderer",
  hardwareConcurrency: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, storageQuota: 4096,
  taskbarHeight: 40, renderScaleMode: "native", windowTitlePrefix: "R2", appUrl: "https://app.example.test/start",
  drm: false, proxyMode: "named", proxyName: "fixture", note: "Portable note\nwith a second line", tags: ["r2"],
  preset: "shop", extensions: { local_r2fixture: true }, fingerprintBaseline: { platform: "Win32", canvasHash: "abc123" },
};
const PORTABLE_CHANGES: Record<(typeof PORTABLE_PROFILE_FIELDS)[number], unknown> = {
  name: "Changed profile", fingerprintMode: "off", engine: "firefox", browserVersion: "149.0.0.1",
  allowThirdPartyCookies: true, fingerprintSeed: 23456, platform: "android", timezone: "Asia/Tokyo", locale: "fr-FR",
  webrtcMode: "auto", webrtcIp: "203.0.113.11", geolocationMode: "real", geolocationLatitude: 3,
  geolocationLongitude: 4, geolocationAccuracy: 100, gpuVendor: "Changed vendor", gpuRenderer: "Changed renderer",
  hardwareConcurrency: 16, deviceMemory: 16, screenWidth: 2560, screenHeight: 1440, storageQuota: 8192,
  taskbarHeight: 50, renderScaleMode: "strict", windowTitlePrefix: null, appUrl: "https://app.example.test/changed",
  drm: true, proxyMode: "none", proxyName: "fixture2", note: "Changed note", tags: ["r2", "changed"],
  preset: "changed-shop", extensions: { local_r2fixture: false }, fingerprintBaseline: { platform: "Win32", canvasHash: "changed" },
};
function seedComplete(): void {
  transact((draft) => {
    draft.proxies.fixture = { type: "http", host: "proxy.example.test", port: 3128 };
    draft.proxies.fixture2 = { type: "http", host: "proxy2.example.test", port: 3128 };
    draft.browserProfiles[ID] = { ...structuredClone(FULL_PROFILE), updatedAt: 100 };
  });
}
function manualBaseline(preferences = profilePreferencesSnapshot(PREF_BYTES), timestamp = 1234): ProfileSyncBaseline {
  const profile = getConfig().browserProfiles![ID];
  // Deliberately construct V1 directly, independently of the baseline factory.
  const baseline: ProfileSyncBaseline = { version: 1, targetId: getProfileSyncTarget(getConfig().sync),
    snapshotId: "manual-r2-snapshot", contentHash: profileContentHash(profile, preferences), preferences, timestamp };
  transact((draft) => {
    draft.browserProfiles[ID].syncBaseline = baseline;
    draft.browserProfiles[ID].syncedAt = baseline.timestamp;
    draft.browserProfiles[ID].syncedHash = baseline.contentHash;
  });
  expect(disk().browserProfiles[ID].syncBaseline).toEqual(baseline);
  return baseline;
}
async function assertBoth(expected: string, reason?: string): Promise<void> {
  const before = fs.readFileSync(getConfigPath());
  const { list, info } = await statuses();
  expect(list.syncStatus).toBe(expected);
  expect(info.syncStatus).toBe(expected);
  expect(list.syncScope).toBe("portable-profile+preferences");
  expect(info.syncScope).toBe(list.syncScope);
  expect(info.syncReason).toBe(list.syncReason);
  expect(info.syncedAt).toBe(list.syncedAt);
  if (reason) expect(info.syncReason).toBe(reason);
  expect(fs.readFileSync(getConfigPath())).toEqual(before);
}

describe("V1 portable profile state in both actual getters", () => {
  it("accepts a manually constructed V1 baseline across direct storage, reload and re-query", async () => {
    seedComplete();
    const baseline = manualBaseline();
    await assertBoth("synced", "baseline-match");
    reloadConfig();
    expect(getProfileMeta(ID)?.syncBaseline).toEqual(baseline);
    await assertBoth("synced", "baseline-match");
    expect(fs.readFileSync(PREFS)).toEqual(PREF_BYTES);
  });

  it("enumerates exactly the complete shared F08 portable field boundary", () => {
    expect(Object.keys(PORTABLE_CHANGES).sort()).toEqual([...PORTABLE_PROFILE_FIELDS].sort());
    expect(Object.keys(FULL_PROFILE).sort()).toEqual([...PORTABLE_PROFILE_FIELDS].sort());
  });

  it.each(Object.entries(PORTABLE_CHANGES))("changing portable field %s makes both getters dirty and retains the committed baseline", async (field, value) => {
    seedComplete();
    const baseline = manualBaseline();
    transact((draft) => { draft.browserProfiles[ID][field] = structuredClone(value); });
    expect(disk().browserProfiles[ID].syncBaseline).toEqual(baseline);
    expect(profileContentHash(getConfig().browserProfiles![ID], profilePreferencesSnapshot(PREF_BYTES))).not.toBe(baseline.contentHash);
    await assertBoth("dirty", "content-changed");
    reloadConfig();
    await assertBoth("dirty", "content-changed");
  });

  it("ignores local fonts/locks/times/legacy markers without hiding portable edits", async () => {
    seedComplete();
    const baseline = manualBaseline();
    const fontDir = path.join(h.root, "fonts", "local-fixture");
    fs.mkdirSync(fontDir, { recursive: true });
    transact((draft) => {
      Object.assign(draft.browserProfiles[ID], { fontsDir: fontDir, updatedAt: 99999, createdAt: 777,
        syncedAt: 999999, syncedHash: "changed-legacy-marker", lock: { owner: "other-fixture", ownerName: "Other fixture", at: 444 },
        __artifactHash: "ignored-legacy-artifact" });
    });
    expect(profileContentHash(getConfig().browserProfiles![ID], profilePreferencesSnapshot(PREF_BYTES))).toBe(baseline.contentHash);
    reloadConfig();
    await assertBoth("synced", "baseline-match");
    expect((await statuses()).info.syncedAt).toBe(baseline.timestamp);
  });

  it("tracks Preferences byte changes while explicitly not claiming cookie/localStorage verification", async () => {
    seedComplete(); manualBaseline();
    const untracked = path.join(getProfilesDir(), ID, "Default", "Local Storage", "leveldb");
    fs.mkdirSync(untracked, { recursive: true });
    fs.writeFileSync(path.join(untracked, "owned-sentinel.log"), "not part of this metadata proof");
    await assertBoth("synced", "baseline-match");
    fs.writeFileSync(PREFS, Buffer.concat([PREF_BYTES, Buffer.from(" ")]));
    await assertBoth("dirty", "content-changed");
  });

  it("distinguishes confirmed absent Preferences from empty or unreadable content, including epoch-zero baselines", async () => {
    seedComplete(); fs.unlinkSync(PREFS);
    const baseline = manualBaseline(profilePreferencesSnapshot(null), 0);
    await assertBoth("synced", "baseline-match");
    expect((await statuses()).info.syncedAt).toBe(0);
    fs.writeFileSync(PREFS, Buffer.alloc(0));
    await assertBoth("dirty", "content-changed");
    fs.unlinkSync(PREFS);
    reloadConfig();
    expect(disk().browserProfiles[ID].syncBaseline).toEqual(baseline);
    await assertBoth("synced", "baseline-match");
  });

  it("returns unknown on scoped Preferences I/O failure rather than treating it as absent or changing markers", async () => {
    seedComplete(); const baseline = manualBaseline();
    h.readFaults.add(PREFS);
    await assertBoth("unknown", "preferences-unavailable");
    expect(disk().browserProfiles[ID].syncBaseline).toEqual(baseline);
    h.readFaults.clear();
    await assertBoth("synced", "baseline-match");
  });

  it.each(["file", "ancestor"])("rejects a Preferences %s symlink before reading the owned target", async (kind) => {
    seedComplete(); manualBaseline();
    const outside = path.join(h.root, "other-owned-fixture");
    fs.mkdirSync(outside);
    const outsidePrefs = path.join(outside, "Preferences");
    fs.writeFileSync(outsidePrefs, PREF_BYTES);
    if (kind === "file") { fs.unlinkSync(PREFS); fs.symlinkSync(outsidePrefs, PREFS); }
    else { fs.rmSync(path.dirname(PREFS), { recursive: true }); fs.symlinkSync(outside, path.dirname(PREFS)); }
    h.reads = [];
    await assertBoth("unknown", "preferences-unavailable");
    expect(h.reads).not.toContain(PREFS);
    expect(h.reads).not.toContain(outsidePrefs);
  });

  it("keeps legacy-only timestamps/hashes unknown and never upgrades markers during reads", async () => {
    transact((draft) => { draft.browserProfiles[ID].syncedAt = 4102444800000; });
    await assertBoth("unknown", "legacy-marker");
    expect(disk().browserProfiles[ID]).not.toHaveProperty("syncBaseline");
    transact((draft) => { delete draft.browserProfiles[ID].syncedAt; });
    await assertBoth("never", "no-baseline");
  });

  it("preserves evidence across settings edits but cannot call a different storage target clean", async () => {
    seedComplete(); const baseline = manualBaseline();
    transact((draft) => { draft.sync.accessKey = "changed-synthetic-access"; draft.sync.secretKey = "changed-synthetic-secret"; draft.sync.enabled = false; });
    await assertBoth("synced", "baseline-match");
    transact((draft) => { draft.sync.bucket = "other-synthetic-r2"; });
    await assertBoth("unknown", "target-mismatch");
    expect(disk().browserProfiles[ID].syncBaseline).toEqual(baseline);
    reloadConfig();
    await assertBoth("unknown", "target-mismatch");
  });

  it("does not trust a matching hash when the baseline Preferences descriptor contradicts the observed bytes", async () => {
    const baseline = manualBaseline();
    transact((draft) => { draft.browserProfiles[ID].syncBaseline = { ...baseline, preferences: { state: "absent" } }; });
    await assertBoth("unknown", "invalid-baseline");
  });

  it("public metadata patches preserve evidence but cannot forge a new V1 baseline", async () => {
    const baseline = manualBaseline();
    const supplied = { ...baseline, snapshotId: "forged", contentHash: "0".repeat(64) };
    setProfileMeta(ID, { note: "A real portable edit", syncBaseline: supplied });
    expect(disk().browserProfiles[ID].syncBaseline).toEqual(baseline);
    await assertBoth("dirty", "content-changed");
    transact((draft) => { delete draft.browserProfiles[ID].syncBaseline; delete draft.browserProfiles[ID].syncedAt; delete draft.browserProfiles[ID].syncedHash; });
    setProfileMeta(ID, { syncBaseline: supplied });
    expect(disk().browserProfiles[ID]).not.toHaveProperty("syncBaseline");
    await assertBoth("never", "no-baseline");
  });
});

describe("pure portable projection and proof schema", () => {
  it.each([{ name: "Minimal" }, { ...FULL_PROFILE, geolocationAccuracy: undefined }, FULL_PROFILE])("closes canonical defaults across JSON/store/reload and actual getProfileMeta ($name)", (raw) => {
    const prefs = profilePreferencesSnapshot(PREF_BYTES);
    const expected = profileContentHash(raw, prefs);
    const projected = portableProfileContent(raw);
    expect(projected).toEqual(JSON.parse(JSON.stringify(projected)));
    transact((draft) => { draft.browserProfiles[ID] = structuredClone(raw); });
    expect(profileContentHash(disk().browserProfiles[ID], prefs)).toBe(expected);
    expect(profileContentHash(getProfileMeta(ID), prefs)).toBe(expected);
    reloadConfig();
    expect(profileContentHash(getConfig().browserProfiles![ID], prefs)).toBe(expected);
    expect(profileContentHash(getProfileMeta(ID), prefs)).toBe(expected);
  });

  it("never generates random/time values or resolves local paths when hashing or creating evidence", () => {
    const prefs = profilePreferencesSnapshot(PREF_BYTES);
    const raw = { ...FULL_PROFILE, fontsDir: "not-a-path-to-read", lock: { owner: "local" }, syncedAt: 1, updatedAt: 2, password: "synthetic-excluded" };
    const target = getProfileSyncTarget(getConfig().sync);
    const expected = profileContentHash(FULL_PROFILE, prefs);
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("random is forbidden in canonical content"); });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("clock is forbidden in canonical content"); });
    const localPath = vi.spyOn(fs, "realpathSync").mockImplementation(() => { throw new Error("local path resolution is forbidden in canonical content"); });
    try {
      const baseline = createProfileSyncBaseline(raw, prefs, target, "fixed-snapshot", 1234);
      expect(baseline.contentHash).toBe(expected);
      expect(profileContentHash(JSON.parse(JSON.stringify(raw)), prefs)).toBe(expected);
      expect(profileContentHash(portableProfileContent(raw), prefs)).toBe(expected);
      expect(random).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); expect(localPath).not.toHaveBeenCalled();
    } finally { localPath.mockRestore(); clock.mockRestore(); random.mockRestore(); }
  });

  it("normalizes only endpoint/bucket target identity, excluding credentials and other settings", () => {
    const target = getProfileSyncTarget(getConfig().sync);
    expect(getProfileSyncTarget({ endpoint: "HTTPS://SYNC.EXAMPLE.TEST:443/", bucket: " synthetic-r2 " })).toBe(target);
    expect(getProfileSyncTarget({ ...getConfig().sync, accessKey: "different", secretKey: "different" } as any)).toBe(target);
    expect(getProfileSyncTarget({ endpoint: "https://other.example.test", bucket: "synthetic-r2" })).not.toBe(target);
    expect(() => getProfileSyncTarget({ endpoint: "https://user:synthetic@sync.example.test", bucket: "synthetic-r2" })).toThrow(/endpoint/);
  });

  it("rejects malformed/unversioned/path-injecting descriptors, while returning detached normalized V1 records", () => {
    const baseline = createProfileSyncBaseline(FULL_PROFILE, profilePreferencesSnapshot(PREF_BYTES), getProfileSyncTarget(getConfig().sync), "fixed-snapshot", 1234);
    expect(parseProfileSyncBaseline(JSON.parse(JSON.stringify(baseline)))).toEqual(baseline);
    const invalid = [null, {}, { ...baseline, version: 2 }, { ...baseline, timestamp: NaN }, { ...baseline, timestamp: -1 },
      { ...baseline, snapshotId: "../outside" }, { ...baseline, targetId: "bad" }, { ...baseline, contentHash: "g".repeat(64) },
      { ...baseline, preferences: { state: "present", sha256: "0".repeat(64), bytes: -1 } },
      { ...baseline, preferences: { state: "absent", path: "not-a-path-to-read" } }, { ...baseline, localPath: "not-a-path-to-read" }];
    for (const value of invalid) expect(parseProfileSyncBaseline(value)).toBeNull();
    const parsed = parseProfileSyncBaseline(baseline)!;
    expect(parsed).not.toBe(baseline); expect(parsed.preferences).not.toBe(baseline.preferences);
    expect(profilePreferencesSnapshot(Buffer.alloc(0))).toEqual({ state: "present", sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"), bytes: 0 });
    expect(profilePreferencesSnapshot(null)).toEqual({ state: "absent" });
    expect(() => profileContentHash(FULL_PROFILE, { state: "unknown" } as any)).toThrow(/Preferences snapshot/);
  });

  it("load/store carry only validated baseline evidence and archive metadata cannot inject markers or local paths", () => {
    const baseline = manualBaseline();
    transact((draft) => { draft.browserProfiles[ID].syncBaseline = { ...baseline, preferences: { state: "absent", path: "not-a-path-to-read" } }; });
    expect(disk().browserProfiles[ID]).not.toHaveProperty("syncBaseline");
    expect(getProfileMeta(ID)).not.toHaveProperty("syncBaseline");
    const portable = normalizePortableProfileMeta({ name: "Imported", fingerprintMode: "off", fingerprintSeed: 12345,
      syncBaseline: baseline, syncedAt: 1234, syncedHash: baseline.contentHash, fontsDir: "not-a-path-to-read", lock: { owner: "synthetic" } });
    for (const field of ["syncBaseline", "syncedAt", "syncedHash", "fontsDir", "lock"]) expect(portable).not.toHaveProperty(field);
  });

  it("raw invalid baseline and invalid target remain unknown rather than throwing or claiming clean", () => {
    expect(readProfileSyncState(ID, { ...getConfig().browserProfiles![ID], syncBaseline: {} })).toMatchObject({ syncStatus: "unknown", syncReason: "invalid-baseline" });
    manualBaseline();
    transact((draft) => { draft.sync.endpoint = ""; });
    expect(readProfileSyncState(ID, getConfig().browserProfiles![ID])).toMatchObject({ syncStatus: "unknown", syncReason: "target-unavailable" });
  });
});
