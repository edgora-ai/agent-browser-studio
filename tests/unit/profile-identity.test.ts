import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as zlib from "node:zlib";
import type { BrowserProfileMeta, MgmtConfig } from "../../src/main/types.js";

const h = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const root: string = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-identity-")));
  const owner = fs.lstatSync(root);
  return { root, dev: owner.dev, ino: owner.ino, data: path.join(root, "device"), cookieSnapshot: vi.fn(),
    cookieImport: vi.fn(), native: vi.fn(() => { throw new Error("Identity unit tests must not launch native programs"); }) };
});
vi.mock("electron", () => ({
  app: { getPath: () => h.data }, BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }, screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: h.native, spawnSync: h.native, execFileSync: h.native, execFile: h.native, exec: h.native,
}));
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  findBrowserByProfileSync: () => null, getRunningProcessesAsync: async () => [],
}));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({
  runtimeCookieOps: { hasRunningBrowser: () => false, exportCookiesSnapshot: h.cookieSnapshot,
    exportCookies: async () => [], importCookies: h.cookieImport },
  firefoxCookieService: { applyQueuedImports: async () => 0 },
}));
import { compareProfileIdentity, describeProfileIdentity, PROFILE_IDENTITY_FIELDS } from "../../src/main/services/profile-identity.js";
import { getConfig, getConfigPath, getProfileMeta, getProfilesDir, reloadConfig, saveConfig, portableProfileContent } from "../../src/main/services/config-manager.js";
import { exportProfileArchive, importProfileArchive } from "../../src/main/services/profile-archive.js";
import { extractZipEntry, readZipEntries, writeZipArchive } from "../../src/main/services/zip-writer.js";
import { syncService } from "../../src/main/services/sync-service.js";
import { compareCapturedProfileIdentity, type ProfileIdentityRuntimeReceipt } from "../../src/tools/profile-identity-comparison.js";
import { HOST_IDENTITY_HINTS, IDENTITY_CAPTURE_WARNINGS, startHostIdentityFixture, type FullHostIdentityCapture,
  type IdentitySurfaceCapture, type IdentityWireReceipt, type HostIdentityFixture } from "../../src/tools/host-identity-capture.js";
import { IDENTITY_CONTEXTS, type IdentityRunBinding, type IdentityContext, type FullHostNavigatorIdentity,
  type FullHostIdentityRequestHeaders, type IdentityRequestEvidence, type IdentityNavigatorCapture } from "../../src/tools/host-identity-validation.js";

const ID = "ab_identity_fixture", EXTENSION = "local_identity01";
function assertOwnedRoot(): void {
  const current = fs.lstatSync(h.root);
  if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== h.dev || current.ino !== h.ino) throw new Error("Unowned identity fixture directory");
}
function resetDevice(): void {
  assertOwnedRoot();
  fs.rmSync(h.data, { recursive: true, force: true });
  fs.mkdirSync(h.data, { mode: 0o700 }); fs.mkdirSync(path.join(h.data, "backups"), { mode: 0o700 }); reloadConfig();
  expect(getConfigPath()).toBe(path.join(h.data, "config.json"));
  expect(getProfilesDir()).toBe(path.join(h.data, "profiles"));
}
function diskConfig(): MgmtConfig { return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as MgmtConfig; }
function profile(engine: "chromium" | "firefox" = "chromium"): BrowserProfileMeta {
  return { name: "Identity synthetic sender", fingerprintMode: "managed", engine,
    browserVersion: engine === "chromium" ? "152.0.7977.72" : "154.0", fingerprintSeed: 45678,
    platform: "macos", timezone: "Asia/Tokyo", locale: "ja-JP", webrtcMode: "altered", webrtcIp: "198.51.100.8",
    geolocationMode: "custom", geolocationLatitude: 35, geolocationLongitude: 139, geolocationAccuracy: 50,
    gpuVendor: null, gpuRenderer: null, hardwareConcurrency: 8, deviceMemory: 16,
    screenWidth: 1512, screenHeight: 982, taskbarHeight: 25, storageQuota: 8192, renderScaleMode: "strict",
    allowThirdPartyCookies: true, drm: true, extensions: { [EXTENSION]: false },
    fingerprintBaseline: { userAgent: "Synthetic retained baseline, not runtime proof", canvasHash: "old-synthetic" },
    proxyMode: "none", note: "Not identity", tags: ["fixture"] };
}
function seedProfile(meta: BrowserProfileMeta): BrowserProfileMeta {
  const cfg = structuredClone(getConfig()); cfg.browserProfiles = { [ID]: meta }; saveConfig(cfg);
  const folder = path.join(getProfilesDir(), ID, "Default"); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "Preferences"), '{"identity":"owned-sentinel"}\n');
  return diskConfig().browserProfiles[ID];
}
beforeEach(() => { h.native.mockClear(); h.cookieSnapshot.mockReset().mockResolvedValue({ state: "available", cookies: [] }); h.cookieImport.mockReset().mockResolvedValue(0); });
afterEach(() => { expect(h.native).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { assertOwnedRoot(); fs.rmSync(h.root, { recursive: true }); });

describe("canonical saved identity, not copied-baseline proof", () => {
  it("hashes only explicit identity fields with a versioned scope", () => {
    const source = profile(), saved = JSON.stringify(source);
    const description = describeProfileIdentity(source);
    expect(description).toMatchObject({ version: 1, state: "available", seedState: "present", retainedBaseline: true });
    expect(description.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(description.configuration!).sort()).toEqual([...PROFILE_IDENTITY_FIELDS].sort());
    expect(compareProfileIdentity(source, structuredClone(source))).toMatchObject({
      configuration: { state: "retained", changes: [] }, runtime: { state: "not-verified", reason: "retained-baseline-is-not-runtime-proof" },
    });
    expect(JSON.stringify(source)).toBe(saved);
    expect(description.limitations.join(" ")).toMatch(/actual engine.*launch policy/);
    expect(description.limitations.join(" ")).toMatch(/font.*device-local/i);
  });
  it("is independent of object/extension key order and non-identity metadata", () => {
    const before = { ...profile(), extensions: { local_identity01: true, local_identity02: false } };
    const after = Object.fromEntries(Object.entries({ ...before, name: "renamed", note: "changed", tags: ["changed"],
      syncedAt: 123, lock: { owner: "elsewhere" }, appUrl: "https://app.example.test/?token=excluded",
      proxyName: "excluded", fontsDir: "/not-read", fingerprintBaseline: { userAgent: "different old baseline" },
      extensions: { local_identity02: false, local_identity01: true } }).reverse());
    expect(compareProfileIdentity(before, after).configuration).toMatchObject({ state: "retained", changes: [] });
  });
  const changes: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["fingerprintSeed", {}, { fingerprintSeed: 12346 }], ["fingerprintMode", {}, { fingerprintMode: "off" }],
    ["engine", {}, { engine: "firefox" }], ["browserVersion", {}, { browserVersion: "152.0.7977.72" }],
    ["platform", {}, { platform: "macos" }], ["timezone", {}, { timezone: "Asia/Tokyo" }],
    ["locale", {}, { locale: "fr-FR" }], ["webrtcMode", {}, { webrtcMode: "disable" }],
    ["webrtcIp", { webrtcMode: "altered", webrtcIp: "198.51.100.1" }, { webrtcMode: "altered", webrtcIp: "198.51.100.2" }],
    ["geolocationMode", {}, { geolocationMode: "disable" }],
    ...(["geolocationLatitude", "geolocationLongitude", "geolocationAccuracy"] as const).map((field): [string, Record<string, unknown>, Record<string, unknown>] =>
      [field, { geolocationMode: "custom", geolocationLatitude: 0, geolocationLongitude: 0, geolocationAccuracy: 50 },
        { geolocationMode: "custom", geolocationLatitude: 0, geolocationLongitude: 0, geolocationAccuracy: 50, [field]: 1 }]),
    ...(["gpuVendor", "gpuRenderer"] as const).map((field): [string, Record<string, unknown>, Record<string, unknown>] => [field, {}, { [field]: "Synthetic override" }]),
    ...(["hardwareConcurrency", "deviceMemory", "screenWidth", "screenHeight", "storageQuota", "taskbarHeight"] as const)
      .map((field): [string, Record<string, unknown>, Record<string, unknown>] => [field, {}, { [field]: field.startsWith("screen") ? 800 : 8 }]),
    ["renderScaleMode", {}, { renderScaleMode: "strict" }], ["allowThirdPartyCookies", {}, { allowThirdPartyCookies: true }],
    ["drm", {}, { drm: true }], ["extensions", {}, { extensions: { [EXTENSION]: true } }],
  ];
  it.each(changes)("reports exactly the saved %s change", (field, before, after) => {
    const result = compareProfileIdentity({ fingerprintSeed: 12345, ...before }, { fingerprintSeed: 12345, ...after });
    expect(result.configuration.state).toBe("changed");
    expect(result.configuration.changes.map((entry) => entry.field)).toEqual([field]);
    expect(result.configuration.beforeHash).not.toBe(result.configuration.afterHash);
    expect(result.runtime.state).toBe("not-verified");
  });
  it("uses production undefined/null/default semantics without generating seeds", () => {
    const random = vi.spyOn(Math, "random");
    const source = { fingerprintSeed: 12345, fingerprintMode: undefined, extensions: undefined, locale: "en-us", timezone: "" };
    const normalized = portableProfileContent(source);
    expect(compareProfileIdentity(source, normalized).configuration.state).toBe("retained");
    expect(compareProfileIdentity({ fingerprintSeed: 12345 }, { fingerprintSeed: 12345, fingerprintMode: "managed", engine: "chromium",
      browserVersion: "auto", platform: "windows", timezone: null, locale: null, webrtcMode: "auto", webrtcIp: null,
      geolocationMode: "real", geolocationLatitude: null, geolocationLongitude: null, geolocationAccuracy: null,
      gpuVendor: null, gpuRenderer: null, hardwareConcurrency: null, deviceMemory: null, screenWidth: null,
      screenHeight: null, storageQuota: null, taskbarHeight: null, renderScaleMode: "native", allowThirdPartyCookies: false, drm: false, extensions: {} }).configuration.state).toBe("retained");
    expect(random).not.toHaveBeenCalled();
  });
  it("preserves effective legacy WebRTC and custom accuracy defaults but reports retained inactive settings too", () => {
    expect(compareProfileIdentity({ fingerprintSeed: 12345, webrtcIp: "198.51.100.1" },
      { fingerprintSeed: 12345, webrtcMode: "altered", webrtcIp: "198.51.100.1" }).configuration.state).toBe("retained");
    expect(compareProfileIdentity({ fingerprintSeed: 12345, webrtcMode: "real", webrtcIp: "198.51.100.1" },
      { fingerprintSeed: 12345, webrtcMode: "real", webrtcIp: null }).configuration.state).toBe("retained");
    const geo = { fingerprintSeed: 12345, geolocationMode: "custom", geolocationLatitude: 0, geolocationLongitude: 0 };
    expect(compareProfileIdentity(geo, { ...geo, geolocationAccuracy: 50 }).configuration.state).toBe("retained");
    expect(compareProfileIdentity({ fingerprintSeed: 1, fingerprintMode: "off" }, { fingerprintSeed: 2, fingerprintMode: "off" }).configuration.state).toBe("changed");
    expect(compareProfileIdentity({ fingerprintSeed: 1, timezone: "UTC" }, { fingerprintSeed: 1, timezone: "Etc/UTC" }).configuration.state).toBe("changed");
  });
  it.each([{}, { fingerprintSeed: undefined }])("does not hash or invent a legacy missing seed (%j)", (legacy) => {
    const random = vi.spyOn(Math, "random");
    expect(describeProfileIdentity(legacy)).toMatchObject({ state: "missing-seed", seedState: "missing", hash: null });
    expect(compareProfileIdentity(legacy, { fingerprintSeed: 12345 }).configuration).toMatchObject({ state: "missing-seed", beforeHash: null, reasons: ["before:missing-seed"] });
    expect(compareProfileIdentity(legacy, legacy).configuration.state).toBe("missing-seed");
    expect(random).not.toHaveBeenCalled(); expect(legacy).not.toHaveProperty("fingerprintSeed", 12345);
  });
  it.each([null, [], new Date(), { fingerprintSeed: 0 }, { fingerprintSeed: NaN }, { fingerprintSeed: null },
    { fingerprintSeed: "12345" }, { fingerprintSeed: 1, engine: "safari" }, { fingerprintSeed: 1, platform: "linux" },
    { fingerprintSeed: 1, screenWidth: 1 }, { fingerprintSeed: 1, locale: "bad_locale" }, { fingerprintSeed: 1, timezone: "bad-zone" },
    { fingerprintSeed: 1, hardwareConcurrency: Infinity }, { fingerprintSeed: 1, drm: "true" },
    { fingerprintSeed: 1, extensions: { [EXTENSION]: "yes" } }, { fingerprintSeed: 1, geolocationMode: "custom" },
  ])("fails closed on invalid identity input (%j)", (input) => {
    expect(describeProfileIdentity(input)).toMatchObject({ state: "not-verifiable", hash: null });
    expect(compareProfileIdentity(input, input).configuration.state).toBe("not-verifiable");
  });
  it("never evaluates excluded getters or hashes secrets, paths, URLs, or baseline bodies", () => {
    const raw: Record<string, unknown> = { fingerprintSeed: 12345 };
    for (const key of ["proxy", "proxies", "proxyName", "proxyMode", "appUrl", "fontsDir", "fingerprintBaseline", "password", "token"]) {
      Object.defineProperty(raw, key, { enumerable: true, get() { throw new Error("Excluded synthetic secret must not be read"); } });
    }
    expect(describeProfileIdentity(raw).hash).toBe(describeProfileIdentity({ fingerprintSeed: 12345 }).hash);
    expect(compareProfileIdentity(raw, raw).runtime).toEqual({ state: "not-verified", reason: "retained-baseline-is-not-runtime-proof" });
    const accessor = Object.defineProperty({}, "fingerprintSeed", { enumerable: true, get() { throw new Error("Invalid accessor"); } });
    expect(describeProfileIdentity(accessor).state).toBe("not-verifiable");
  });
});

describe("real config/ZIP/cloud metadata round trips (no browser or cookie lane)", () => {
  beforeEach(resetDevice);
  it.each(["chromium", "firefox"] as const)("keeps %s seed and every identity field through actual ZIP bytes/new ID/store/reload/search", async (engine) => {
    const before = seedProfile(profile(engine)), archive = path.join(h.data, "backups", `identity-${engine}.zip`);
    await exportProfileArchive(ID, archive);
    const bytes = fs.readFileSync(archive), meta = readZipEntries(bytes).find((entry) => entry.name === "meta.json")!;
    const document = JSON.parse(extractZipEntry(bytes, meta).toString("utf8")) as { profile: BrowserProfileMeta };
    expect(document.profile.fingerprintSeed).toBe(before.fingerprintSeed);
    expect(compareProfileIdentity(before, document.profile).configuration.state).toBe("retained");
    const imported = importProfileArchive(archive);
    expect(imported.dirId).not.toBe(ID);
    expect(imported).toMatchObject({ identity: {
      configuration: { state: "retained", changes: [] }, runtime: { state: "not-verified" },
    } });
    const stored = diskConfig().browserProfiles[imported.dirId];
    for (const field of PROFILE_IDENTITY_FIELDS) expect(stored[field], `stored ${field}`).toEqual(before[field]);
    expect(compareProfileIdentity(before, stored)).toMatchObject({ configuration: { state: "retained" }, runtime: { state: "not-verified" } });
    reloadConfig();
    expect(compareProfileIdentity(before, getProfileMeta(imported.dirId)).configuration.state).toBe("retained");
    expect(Object.entries(getConfig().browserProfiles).filter(([, value]) => value.name === imported.name).map(([id]) => id)).toEqual([imported.dirId]);
    expect(fs.readFileSync(path.join(getProfilesDir(), imported.dirId, "Default", "Preferences"), "utf8")).toBe('{"identity":"owned-sentinel"}\n');
  });
  it("detects missing seed on the original legacy ZIP instead of blessing its generated replacement", async () => {
    const raw = { name: "Legacy synthetic identity", platform: "macos" };
    const archive = path.join(h.root, "identity-legacy.zip");
    await writeZipArchive(archive, [{ name: "meta.json", data: Buffer.from(JSON.stringify({ formatVersion: 1, profile: raw })) }]);
    const imported = importProfileArchive(archive), stored = diskConfig().browserProfiles[imported.dirId];
    expect(stored.fingerprintSeed).toBeGreaterThan(0);
    expect(imported.warnings.join(" ")).toMatch(/(?:missing|absent|without).*seed|seed.*(?:missing|absent|generat|migrat)/i);
    expect(imported).toMatchObject({ identity: {
      configuration: { state: "missing-seed", beforeHash: null }, runtime: { state: "not-verified" },
    } });
    expect(compareProfileIdentity(raw, stored)).toMatchObject({ configuration: { state: "missing-seed", beforeHash: null }, runtime: { state: "not-verified" } });
    // The source document, not the generated replacement seed, determines the
    // migration report. A retained historical baseline is never a live test.
  });
  it.each(["chromium", "firefox"] as const)("keeps %s identity through production push bytes/GET readback/fresh pull/merge/reload", async (engine) => {
    const endpoint = "https://identity.example.test", objects = new Map<string, Buffer>(), calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input); expect(url.startsWith(`${endpoint}/identity-fixture/`)).toBe(true);
      const method = init?.method ?? "GET"; calls.push(method);
      if (method === "PUT") {
        expect(Buffer.isBuffer(init?.body)).toBe(true); objects.set(url, Buffer.from(init!.body as Uint8Array)); return new Response("", { status: 200 });
      }
      expect(method).toBe("GET"); const bytes = objects.get(url);
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response("not found", { status: 404 });
    }));
    function configure(): void {
      const cfg = structuredClone(getConfig());
      cfg.deviceId = "synthetic-identity-device"; cfg.browserProfiles = {};
      cfg.sync = { enabled: true, endpoint, bucket: "identity-fixture", accessKey: "synthetic-only", secretKey: "synthetic-only", custodyConsentAt: 1 };
      saveConfig(cfg);
    }
    configure(); const before = seedProfile(profile(engine));
    const pushed = await syncService.push(undefined, true); expect(pushed.success, pushed.message).toBe(true);
    const body = objects.get(`${endpoint}/identity-fixture/agent-browser-studio-config.json`)!;
    expect(body).toBeDefined();
    const envelope = JSON.parse(body.toString("utf8")) as { data: string };
    const uploaded = (JSON.parse(zlib.gunzipSync(Buffer.from(envelope.data, "base64")).toString("utf8")) as MgmtConfig).browserProfiles[ID];
    for (const field of PROFILE_IDENTITY_FIELDS) expect(uploaded[field], `uploaded ${field}`).toEqual(before[field]);
    expect(calls.slice(calls.indexOf("PUT") + 1)).toContain("GET");
    expect(compareProfileIdentity(before, uploaded).configuration.state).toBe("retained");
    resetDevice(); configure(); expect(getProfileMeta(ID)).toBeNull();
    const pulled = await syncService.pull(undefined, { strategy: "remote" }); expect(pulled.success, pulled.message).toBe(true);
    const stored = diskConfig().browserProfiles[ID];
    for (const field of PROFILE_IDENTITY_FIELDS) expect(stored[field], `received ${field}`).toEqual(before[field]);
    expect(compareProfileIdentity(before, stored)).toMatchObject({ configuration: { state: "retained" }, runtime: { state: "not-verified", reason: "retained-baseline-is-not-runtime-proof" } });
    reloadConfig(); expect(compareProfileIdentity(before, getProfileMeta(ID)).configuration.state).toBe("retained");
    expect(Object.entries(getConfig().browserProfiles).filter(([, value]) => value.name === before.name).map(([id]) => id)).toEqual([ID]);
    expect(fs.readFileSync(path.join(getProfilesDir(), ID, "Default", "Preferences"), "utf8")).toBe('{"identity":"owned-sentinel"}\n');
    expect(objects.get(`${endpoint}/identity-fixture/agent-browser-studio-config.json`)).toEqual(body);
  });
});

// Deliberately synthetic navigator/process observations. These unit fixtures
// exercise comparison only; they never count as actual browser verification.
const VERSION = "152.0.7977.72";
const HEADER_MAP = { userAgent: "user-agent", acceptLanguage: "accept-language", doNotTrack: "dnt", uaBrands: "sec-ch-ua", uaMobile: "sec-ch-ua-mobile",
  uaPlatform: "sec-ch-ua-platform", uaArchitecture: "sec-ch-ua-arch", uaBitness: "sec-ch-ua-bitness", uaPlatformVersion: "sec-ch-ua-platform-version",
  uaFullVersionList: "sec-ch-ua-full-version-list", uaFullVersion: "sec-ch-ua-full-version", uaModel: "sec-ch-ua-model", uaWow64: "sec-ch-ua-wow64", uaFormFactors: "sec-ch-ua-form-factors" } as const;
function navigatorIdentity(firefox = false): FullHostNavigatorIdentity {
  return { userAgent: firefox ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:154.0) Gecko/20100101 Firefox/154.0" : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/${VERSION} Safari/537.36`,
    platform: "MacIntel", uaPlatform: firefox ? null : "macOS", mobile: firefox ? null : false,
    brands: firefox ? null : [{ brand: "Not_A Brand", version: "99" }, { brand: "Chromium", version: "152" }],
    highEntropy: firefox ? null : { architecture: "x86", bitness: "64", platform: "macOS", platformVersion: "15.7.0",
      fullVersionList: [{ brand: "Chromium", version: VERSION }], uaFullVersion: VERSION, model: "", wow64: false, mobile: false, formFactors: ["Desktop"] } };
}
function requestHeaders(firefox = false): Record<string, string> {
  return { "user-agent": navigatorIdentity(firefox).userAgent, "accept-language": "en-US,en;q=0.9", dnt: "1", ...firefox ? {} : {
    "sec-ch-ua": '"Not_A Brand";v="99", "Chromium";v="152"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"macOS"',
    "sec-ch-ua-arch": '"x86"', "sec-ch-ua-bitness": '"64"', "sec-ch-ua-platform-version": '"15.7.0"',
    "sec-ch-ua-full-version-list": `"Chromium";v="${VERSION}"`, "sec-ch-ua-full-version": `"${VERSION}"`,
    "sec-ch-ua-model": '""', "sec-ch-ua-wow64": "?0", "sec-ch-ua-form-factors": '"Desktop"',
  } };
}
type Sample = { capture: FullHostIdentityCapture & { binding: IdentityRunBinding;
  navigators: Record<IdentityContext, IdentityNavigatorCapture>; requestEvidence: Record<IdentityContext, IdentityRequestEvidence> };
  runtime: ProfileIdentityRuntimeReceipt };
function sample(role: "before" | "after", firefox = false,
  fixture?: { origin: string; crossOrigin: string; prefix: string; wire: readonly IdentityWireReceipt[] }): Sample {
  const origin = fixture?.origin ?? "http://127.0.0.1:42000", crossOrigin = fixture?.crossOrigin ?? "http://127.0.0.1:42001";
  const prefix = fixture?.prefix ?? `/__host_identity_aaaa/${role === "before" ? "1111" : "2222"}/`;
  const binding: IdentityRunBinding = { runId: role, hostId: "synthetic-same-host", profileId: `synthetic-${role}`, pid: role === "before" ? 123 : 124,
    executablePath: "/owned/synthetic/executable", executableSha256: "a".repeat(64), mode: "headed", identityMode: "managed" };
  const navigators = {} as Record<IdentityContext, IdentityNavigatorCapture>, requests = {} as Record<IdentityContext, IdentityRequestEvidence>;
  const headers = {} as FullHostIdentityCapture["requestHeaders"], contexts: Partial<Record<IdentityContext, IdentitySurfaceCapture>> = {};
  const wire: IdentityWireReceipt[] = [];
  const hints = HOST_IDENTITY_HINTS.map(([hint]) => hint), policy = HOST_IDENTITY_HINTS.map(([, feature]) => `${feature}=(self "${origin}" "${crossOrigin}")`).join(", ");
  for (const context of IDENTITY_CONTEXTS) {
    const contextOrigin = context === "cross-origin-frame" ? crossOrigin : origin;
    const observations = fixture ? fixture.wire.filter((entry) => entry.context === context) : (["opt-in", "echo"] as const).map((phase) => {
      const selected = { host: new URL(contextOrigin).host, ...requestHeaders(firefox) };
      return { context, phase, sequence: wire.length + (phase === "echo" ? 1 : 0), requestUrl: `${contextOrigin}${prefix}${phase}?context=${context}`,
        headers: selected, rawHeaders: Object.entries(selected).flat(), responseStatus: 200,
        responseHeaders: { "accept-ch": hints.join(", "), "permissions-policy": policy } };
    });
    wire.push(...observations); const warm = observations.find((entry) => entry.phase === "opt-in")!, echo = observations.find((entry) => entry.phase === "echo")!;
    const nav: IdentityNavigatorCapture = { status: "captured", identity: navigatorIdentity(firefox) };
    const request: IdentityRequestEvidence = { status: "captured", responseStatus: 200, requestUrl: echo.requestUrl,
      negotiation: { origin: contextOrigin, topLevelOrigin: origin, secureContext: true, optInResponseReceived: true,
        postOptInRequest: true, permissionsPolicyDelegated: !firefox, acceptCH: hints, delegatedHints: firefox ? [] : hints } };
    contexts[context] = { context, observation: { origin: contextOrigin, secureContext: true, api: firefox ? "unavailable" : "permissionsPolicy",
      allowedHints: firefox ? [] : hints, crossOriginAllowedHints: firefox ? [] : hints }, navigator: nav, request,
      optIn: { url: warm.requestUrl, status: 200, headers: warm.responseHeaders }, echo: { url: echo.requestUrl, status: 200, headers: echo.responseHeaders },
      echoed: { requestUrl: echo.requestUrl, headers: echo.headers, rawHeaders: echo.rawHeaders } };
    navigators[context] = nav; requests[context] = request;
    headers[context] = Object.fromEntries(Object.entries(HEADER_MAP).map(([field, name]) => [field, echo.headers[name] ?? null])) as unknown as FullHostIdentityRequestHeaders;
  }
  return { capture: { binding: { ...binding }, navigators, requestEvidence: requests, requestHeaders: headers,
    window: navigators.window.identity!, worker: navigators.dedicated.identity!,
    captureEvidence: { contexts, wire, warnings: IDENTITY_CAPTURE_WARNINGS, timeoutMs: 90000, cleanupErrors: [] } },
  runtime: { engine: firefox ? "firefox" : "chromium", binding: { ...binding }, verifiedBinding: { ...binding },
    executableVersion: firefox ? "154.0" : VERSION, browserVersion: firefox ? "154.0" : VERSION,
    browserVersionSource: firefox ? "bidi" : "cdp", launchPolicyHash: "b".repeat(64) } };
}
function setHeader(value: Sample, context: IdentityContext, name: string, content: string): void {
  for (const receipt of value.capture.captureEvidence.wire.filter((entry) => entry.context === context)) {
    receipt.headers[name] = content;
    const index = receipt.rawHeaders.findIndex((key, index) => index % 2 === 0 && key.toLowerCase() === name);
    if (index < 0) receipt.rawHeaders.push(name, content); else receipt.rawHeaders[index + 1] = content;
  }
  const field = Object.entries(HEADER_MAP).find(([, header]) => header === name)?.[0];
  if (field) Object.assign(value.capture.requestHeaders[context]!, { [field]: content });
}
function updateBinding(value: Sample, patch: Partial<IdentityRunBinding>): void {
  Object.assign(value.capture.binding, patch); Object.assign(value.runtime.binding, patch); Object.assign(value.runtime.verifiedBinding, patch);
}

describe("narrow runtime comparison (synthetic observations, never browser acceptance)", () => {
  it.each([false, true])("compares all six contexts and real-header mirrors; Firefox no forced UA-CH=%s", (firefox) => {
    const before = sample("before", firefox), after = sample("after", firefox), original = JSON.stringify([before, after]);
    expect(compareCapturedProfileIdentity(before, after)).toMatchObject({ state: "reverified", differences: [], issues: [],
      scope: "six-context-navigator-and-identity-headers", fullFingerprintVerified: false });
    expect(JSON.stringify([before, after])).toBe(original);
    expect(compareCapturedProfileIdentity(before, after).unobservedSurfaces.join(" ")).toMatch(/OS coherence alone is not full identity/);
  });
  it.each(IDENTITY_CONTEXTS)("detects a stable %s navigator change with unchanged OS coherence", (context) => {
    const before = sample("before"), after = sample("after");
    after.capture.navigators[context].identity!.highEntropy!.architecture = "arm";
    expect(compareCapturedProfileIdentity(before, after)).toMatchObject({ state: "different", differences: [
      { path: `${context}.navigator.highEntropy.architecture`, before: "x86", after: "arm" },
    ] });
  });
  it("detects wire-only drift rather than declaring equal from Window/Worker host OS", () => {
    const before = sample("before"), after = sample("after"); setHeader(after, "cross-origin-frame", "dnt", "0");
    const result = compareCapturedProfileIdentity(before, after); expect(result.state).toBe("different");
    expect(result.differences.map((entry) => entry.path)).toEqual(["cross-origin-frame.wire.echo.doNotTrack", "cross-origin-frame.wire.opt-in.doNotTrack"]);
  });
  it("excludes only enumerated GREASE/order/routing bookkeeping without rewriting captures", () => {
    const before = sample("before"), after = sample("after");
    for (const context of IDENTITY_CONTEXTS) {
      after.capture.navigators[context].identity!.brands = [{ brand: "Chromium", version: "152" }, { brand: "Not_A Brand", version: "24" }];
      setHeader(after, context, "sec-ch-ua", '"Chromium";v="152", "Not_A Brand";v="24"');
    }
    const original = JSON.stringify(after), result = compareCapturedProfileIdentity(before, after);
    expect(result.state).toBe("reverified"); expect(JSON.stringify(after)).toBe(original);
    expect(result.excludedObservations.some((entry) => /GREASE/.test(entry.path))).toBe(true);
    setHeader(after, "window", "sec-ch-ua", '"Chromium";v="151", "Not_A Brand";v="24"');
    expect(compareCapturedProfileIdentity(before, after).state).toBe("different");
  });
  it.each([
    { hostId: "other-host" }, { executablePath: "/other/executable" }, { executableSha256: "c".repeat(64) },
    { mode: "headless" as const }, { identityMode: "off" as const }, { runId: "before" },
  ])("requires exact host/executable/mode and distinct runs (%j)", (patch) => {
    const after = sample("after"); updateBinding(after, patch);
    expect(compareCapturedProfileIdentity(sample("before"), after).state).toBe("not-verifiable");
  });
  it("requires exact actual version and policy and independently matching process evidence", () => {
    const before = sample("before"), after = sample("after"); after.runtime.launchPolicyHash = "c".repeat(64);
    expect(compareCapturedProfileIdentity(before, after).issues).toContain("precondition:launchPolicyHash");
    after.runtime.launchPolicyHash = before.runtime.launchPolicyHash; after.runtime.browserVersion = after.runtime.executableVersion = "153.0.0.1";
    expect(compareCapturedProfileIdentity(before, after).issues).toContain("precondition:executableVersion");
    after.runtime.browserVersion = VERSION;
    expect(compareCapturedProfileIdentity(before, after).issues).toContain("after:unverified-actual-version");
    const mismatch = sample("after"); mismatch.runtime.verifiedBinding.pid++;
    expect(compareCapturedProfileIdentity(before, mismatch).issues).toContain("after:unverified-process-binding");
  });
  it.each([null, {}, { capture: profile() }, { runtime: { retainedBaseline: true } }])("does not promote missing/live-looking baseline input (%j)", (input) => {
    expect(compareCapturedProfileIdentity(input, input).state).toBe("not-verifiable");
  });
  it("rejects absent frames, timeout/cleanup failures, duplicate receipts and detached headers", () => {
    const before = sample("before"), missing = sample("after"); delete missing.capture.navigators["cross-origin-frame"];
    expect(compareCapturedProfileIdentity(before, missing).state).toBe("not-verifiable");
    const timeout = sample("after"); timeout.capture.navigators.shared.status = "timeout";
    expect(compareCapturedProfileIdentity(before, timeout).state).toBe("not-verifiable");
    const cleanup = sample("after"); cleanup.capture.captureEvidence.cleanupErrors.push("synthetic failure");
    expect(compareCapturedProfileIdentity(before, cleanup).state).toBe("not-verifiable");
    const duplicate = sample("after"); duplicate.capture.captureEvidence.wire[1].sequence = duplicate.capture.captureEvidence.wire[0].sequence;
    expect(compareCapturedProfileIdentity(before, duplicate).state).toBe("not-verifiable");
    const detached = sample("after"); detached.capture.requestHeaders.window.userAgent = "not-the-wire";
    expect(compareCapturedProfileIdentity(before, detached).state).toBe("not-verifiable");
  });
  it("canonicalizes policy hint casing/order and preserves explicit null changes", () => {
    const before = sample("before"), after = sample("after");
    for (const context of IDENTITY_CONTEXTS) {
      const surface = after.capture.captureEvidence.contexts[context]!;
      surface.observation.allowedHints = [...surface.observation.allowedHints].reverse().map((name, index) => index % 2 ? name.toUpperCase() : name.toLowerCase());
      surface.request.negotiation!.delegatedHints = [...surface.request.negotiation!.delegatedHints].reverse().map((name) => name.toLowerCase());
    }
    expect(compareCapturedProfileIdentity(before, after).state).toBe("reverified");
    after.capture.navigators.window.identity!.uaPlatform = null;
    expect(compareCapturedProfileIdentity(before, after).differences).toContainEqual({ path: "window.navigator.uaPlatform", before: "macOS", after: null });
  });
  it("rejects mixed-run fixture contexts and unknown high-entropy fields rather than omitting them", () => {
    const before = sample("before"), after = sample("after"), mixed = sample("before");
    const context = "cross-origin-frame";
    after.capture.navigators[context] = mixed.capture.navigators[context];
    after.capture.requestEvidence[context] = mixed.capture.requestEvidence[context];
    after.capture.captureEvidence.contexts[context] = mixed.capture.captureEvidence.contexts[context];
    for (const receipt of after.capture.captureEvidence.wire.filter((entry) => entry.context === context)) {
      receipt.requestUrl = receipt.requestUrl.replace("/2222/", "/1111/");
    }
    expect(compareCapturedProfileIdentity(before, after).state).toBe("not-verifiable");
    const unknown = sample("after"); unknown.capture.navigators.window.identity!.highEntropy!.unreviewed = "unknown-field";
    expect(compareCapturedProfileIdentity(before, unknown).issues).toContain("after:unknown-high-entropy-field");
  });
  it("rejects credentials in untouched wire evidence and never returns their value", () => {
    const after = sample("after"); setHeader(after, "window", "cookie", "synthetic-private-value");
    const result = compareCapturedProfileIdentity(sample("before"), after);
    expect(result).toMatchObject({ state: "not-verifiable", issues: ["after:credentials-forbidden"] });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
  });
});

async function getOwnedFixture(url: string, headers: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = http.get(url, { headers, agent: false }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Owned fixture HTTP ${response.statusCode}`)); return; }
      response.resume(); response.on("end", resolve); response.on("error", reject);
    });
    request.setTimeout(3000, () => request.destroy(new Error("Owned fixture timeout"))); request.on("error", reject);
  });
}
it("reuses the real owned fixture and exact raw Node HTTP receipts without launching a browser", async () => {
  const fixture: HostIdentityFixture = await startHostIdentityFixture();
  try {
    async function captureSyntheticNavigatorWithRealWire(role: "before" | "after"): Promise<Sample> {
      const run = fixture.beginCapture();
      try {
        for (const context of IDENTITY_CONTEXTS) for (const phase of ["opt-in", "echo"] as const) {
          await getOwnedFixture(`${context === "cross-origin-frame" ? fixture.crossOrigin : fixture.origin}${run.prefix}${phase}?context=${context}`, requestHeaders());
        }
        run.assertHealthy();
        return sample(role, false, { origin: fixture.origin, crossOrigin: fixture.crossOrigin, prefix: run.prefix, wire: run.receipts() });
      } finally { run.release(); }
    }
    const before = await captureSyntheticNavigatorWithRealWire("before"), after = await captureSyntheticNavigatorWithRealWire("after");
    expect(before.capture.captureEvidence.wire).toHaveLength(12);
    expect(compareCapturedProfileIdentity(before, after)).toMatchObject({ state: "reverified", fullFingerprintVerified: false });
  } finally { await fixture.close(); }
});
