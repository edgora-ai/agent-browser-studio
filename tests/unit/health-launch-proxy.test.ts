import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import type { ProxyConfig, ResolvedProfileProxy } from "../../src/main/types.js";
import * as runtime from "../../src/main/services/browser/runtime-table.js";

// Match exported-launch-provenance: filesystem paths follow the host OS,
// independently of the modeled browser platform. No real directory is used.
const fixturePaths = await vi.hoisted(async () => {
  const path = await import("node:path");
  const root = path.resolve(path.sep, "virtual");
  return {
    root, profiles: path.join(root, "profiles"), state: path.join(root, "state"),
    chromiumBin: path.join(root, "chromium-bin"), firefoxBin: path.join(root, "firefox-bin"),
    chromium: path.join(root, "chromium"), firefox: path.join(root, "firefox"), bundled: path.join(root, "bundled"),
  };
});

// Reuse the existing exported-launch-provenance test boundary pattern: import
// the REAL launcher, replace only process/OS/network/storage effects. No real
// process or browser is started and no real userData path is queried.
const f = vi.hoisted(() => ({
  cfg: {} as any, lines: [] as string[], proxyResult: {} as ResolvedProfileProxy,
  proxy: vi.fn(), spawn: vi.fn(), firefoxSpawn: vi.fn(), firefoxPrefs: vi.fn(), inspect: vi.fn(), capture: vi.fn(), status: vi.fn(),
  kill: vi.fn(), netCreate: vi.fn(), fetch: vi.fn(), forbidden: vi.fn((name: string): never => { throw new Error(`Undeclared capability: ${name}`); }),
  webRtcPreferencesValidate: vi.fn(), webRtcPreferencesApply: vi.fn(),
  sessions: new Map<number, any>(),
  fs: Object.fromEntries(["existsSync", "mkdirSync", "readFileSync", "writeFileSync", "openSync", "writeSync", "closeSync", "renameSync", "unlinkSync", "rmSync", "realpathSync", "lstatSync", "statSync"].map((name) => [name, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...f.fs,
  // Import-time SQLite/ZIP guards need platform flags, not real file effects.
  // Keep every callable mocked; undeclared fs capabilities still fail closed.
  constants: (await importOriginal<typeof import("node:fs")>()).constants,
}));
vi.mock("node:net", () => ({ createServer: f.netCreate }));
vi.mock("node:dns", () => ({ lookup: () => f.forbidden("DNS") }));
vi.mock("node:dns/promises", () => ({ lookup: () => f.forbidden("DNS"), resolve: () => f.forbidden("DNS") }));
vi.mock("node:os", () => ({ tmpdir: () => process.env.TMPDIR, homedir: () => process.env.HOME, hostname: () => "synthetic-health-launch-host", platform: () => process.platform, arch: () => process.arch }));
vi.mock("node:child_process", () => ({ spawn: f.spawn, ...Object.fromEntries(["exec", "execSync", "execFile", "execFileSync", "spawnSync", "fork"].map((name) => [name, () => f.forbidden(name)])) }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] }, screen: { getPrimaryDisplay: () => ({ scaleFactor: 2 }) } }));
vi.mock("../../src/main/services/browser-platform-policy.js", () => ({ getHostBrowserPlatform: () => "macos" }));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => f.cfg, getProfilesDir: () => fixturePaths.profiles, getAppDataDir: () => fixturePaths.state,
  saveConfig: () => f.forbidden("config save"), resolveProfileProxy: () => f.forbidden("current config proxy lookup"), resolveProfileProxySecret: f.proxy,
  getProxyDetection: () => null, setProxyDetectionIfCurrent: () => f.forbidden("proxy detection persistence"),
  sanitizeAppUrl: (value: unknown) => value || null, getProxyHealthEntry: () => null, assertProfileWritable: () => undefined,
}));
vi.mock("../../src/main/services/process-discovery.js", async (original) => ({
  ...await original<typeof import("../../src/main/services/process-discovery.js")>(),
  inspectBrowserLaunchesSync: f.inspect, findBrowserByProfileSync: () => null,
}));
vi.mock("../../src/main/services/browser/lifecycle.js", () => ({ findBrowserByProfile: () => null, statusBrowser: f.status, ...Object.fromEntries(["stopBrowser", "stopAllBrowserProfiles", "shutdownAllBrowserProfiles", "getCdpWebSocketUrl"].map((name) => [name, () => f.forbidden(`lifecycle.${name}`)])) }));
vi.mock("../../src/main/services/browser/idle-tracker.js", () => Object.fromEntries(["setIdlePolicyTimeoutMs", "getIdlePolicyTimeoutMs", "touchProfileActivity", "touchProfileActivityByPort", "getEngineByPort", "getFirefoxBidiSessionByPort", "getProfileIdleMs", "listRunningProfileIdle", "sweepIdleProfiles"].map((name) => [name, () => f.forbidden(`idle.${name}`)])));
vi.mock("../../src/main/services/browser/launch-pipeline.js", () => ({ launchBrowserPipeline: () => f.forbidden("launcher replacement") }));
vi.mock("../../src/main/services/profile-restore-lock.js", () => ({ acquireRestoreLock: () => () => undefined }));
vi.mock("../../src/main/services/secrets.js", () => ({ decryptSecretOr: () => f.forbidden("secret access") }));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: () => undefined }));
vi.mock("../../src/main/services/consistency-check.js", () => ({ checkProfileConsistency: () => ({ ok: true, warnings: [], blockers: [] }) }));
vi.mock("../../src/main/services/drm.js", () => ({ drmLaunchArgs: () => [] }));
vi.mock("../../src/main/services/extension-repository.js", () => ({ getEnabledRepositoryExtensionPaths: () => [] }));
vi.mock("../../src/main/services/team.js", () => ({ requireProfileMutation: () => ({ ok: true }) }));
vi.mock("../../src/main/services/config/store.js", () => ({ transact: () => f.forbidden("config transaction") }));
vi.mock("../../src/main/services/event-bus.js", () => ({ emitEvent: () => undefined }));
vi.mock("../../src/main/services/cdp-cookie-service.js", () => ({ cdpCookieService: { applyQueuedImports: async () => 0 }, readQueuedCookieImports: () => [] }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ firefoxCookieService: { applyQueuedImports: async () => 0 } }));
vi.mock("../../src/main/services/fingerprint-baseline.js", async (original) => ({
  ...await original<typeof import("../../src/main/services/fingerprint-baseline.js")>(),
  captureFingerprint: f.capture, diffFingerprints: () => [], hasRiskyDrift: () => false,
  summarizeDrift: () => "", checkPersonaConsistency: () => ({ ok: true, mismatches: [] }), mismatchesAsDrift: () => [],
}));
// This dispatch/proxy receipt fixture explicitly fences diagnostic persistence;
// real report/revision publication and consent have independent filesystem/IPC tests.
vi.mock("../../src/main/services/fingerprint-drift-reports.js", () => ({
  beginFingerprintObservation: () => Object.freeze({}),
  saveFingerprintComparison: (_handle: unknown, input: any) => ({
    schemaVersion: 1, policyVersion: 2, id: "22222222-2222-4222-8222-222222222222", dirId: input.dirId,
    observedAt: input.observedAt, source: input.source, hasBaseline: Boolean(input.meta.fingerprintBaseline),
    engine: input.engine || (input.meta.engine === "firefox" ? "firefox" : "chromium"), engineVersion: input.engineVersion || null,
    fields: input.analysis.fields, baselineFields: input.analysis.baselineFields, availableFields: input.analysis.availableFields,
    comparedFields: input.analysis.comparedFields, changes: input.analysis.changes, counts: input.analysis.counts,
    risky: input.analysis.risky, partial: input.analysis.partial, saved: false, baselineCandidate: false,
    warning: "SYNTHETIC_STORAGE_BOUNDARY",
  }),
}));
vi.mock("../../src/main/services/environment-risk.js", () => ({ checkEnvironmentRisk: () => ({ ok: true, findings: [] }), checkEnvironmentRiskRuntime: () => f.forbidden("environment wire"), shouldBlockEnvironmentRisk: () => false, summarizeEnvFindings: () => "" }));
vi.mock("../../src/main/services/authenticated-socks-bridge.js", () => ({ startAuthenticatedSocksBridge: () => f.forbidden("SOCKS bridge") }));
vi.mock("../../src/main/services/masque-socks-bridge.js", () => ({ startMasqueSocksBridge: () => f.forbidden("MASQUE bridge") }));
vi.mock("../../src/main/services/proxy-detector.js", () => ({
  buildChromiumProxyUrl: (proxy: ProxyConfig) => `${proxy.type}://${proxy.host}:${proxy.port}`,
  probeProxyPort: async () => true, proxyDetectionObservedAt: () => null, proxyDetector: { detect: () => f.forbidden("proxy Geo network") },
}));
vi.mock("../../src/main/services/proxy-detection.js", () => ({
  captureProxyDetectionTarget: () => f.forbidden("proxy target capture"), detectProxyTarget: () => f.forbidden("proxy target network"),
  commitProxyDetectionIfCurrent: () => f.forbidden("proxy observation commit"),
}));
vi.mock("../../src/main/services/proxy-health.js", () => ({ recordProxyRotation: () => undefined }));
vi.mock("../../src/main/services/native-chromium-manager.js", () => ({
  findManagedChromiumBinary: () => f.forbidden("sync engine discovery"), findManagedChromiumBinaryAsync: async () => ({ binaryPath: fixturePaths.chromiumBin, version: "150.0.7800.1" }),
  getManagedChromiumRoot: () => fixturePaths.chromium, listManagedChromiumBinaries: () => [], listManagedChromiumBinariesAsync: async () => [], normalizeManagedChromiumVersion: (value: unknown) => value || null,
}));
vi.mock("../../src/main/services/native-proxy-auth.js", () => ({
  LEGACY_NATIVE_PROXY_AUTH_SWITCH: "--roxy-proxy-auth", NATIVE_PROXY_AUTH_SWITCH: "--agent-browser-proxy-auth", NATIVE_SUPPRESS_GOOGLE_API_KEY_INFOBAR_SWITCH: "--agent-browser-suppress-google-api-key-infobar",
  nativeProxyAuthSwitch: () => f.forbidden("native auth"), supportsAgentBrowserFingerprintConfig: () => true,
  supportsGoogleApiKeyInfoBarSuppression: () => false, supportsNativeProxyAuth: () => false, supportsNativeQuicProxy: () => false, supportsNativeLocalDnsPolicy: () => false,
  writeNativeProxyAuthFile: () => f.forbidden("native auth file"),
}));
vi.mock("../../src/main/services/browser-command.js", () => ({ runBrowserCommand: async () => ({ stdout: "Chromium 150.0.7800.1", stderr: "" }) }));
vi.mock("../../src/main/services/browser/launch-diagnostics.js", () => ({ prepareChromiumDiagnosticNetLogArgs: () => [] }));
// This virtual-filesystem suite verifies launch receipts, not preference durability.
// The actual writer has independent owned-filesystem and native-browser tests.
vi.mock("../../src/main/services/browser/webrtc-preferences.js", () => ({
  validateChromiumWebRtcPreferences: f.webRtcPreferencesValidate,
  applyChromiumWebRtcPreferences: f.webRtcPreferencesApply,
}));
vi.mock("../../src/main/services/browser/chromium-gpu-context.js", () => ({ readChromiumGpuContext: () => f.forbidden("GPU file inspection") }));
vi.mock("../../src/main/services/bundled-native-browsers.js", () => ({ bundledBrowsersRoot: () => fixturePaths.bundled }));
vi.mock("../../src/main/services/native-firefox-manager.js", () => ({ getManagedFirefoxRoot: () => fixturePaths.firefox }));
vi.mock("../../src/main/services/browser-engine.js", async (original) => ({
  sanitizeBrowserEngine: (value: unknown) => value === "firefox" ? "firefox" : "chromium", normalizeManagedFirefoxVersion: (value: unknown) => value || null,
  findFirefoxBinaryAsync: async () => fixturePaths.firefoxBin, detectFirefoxVersionAsync: async () => "154.0", getFirefoxBinaryOverride: () => null,
  getFirefoxStatus: () => f.forbidden("Firefox status"), getFirefoxStatusAsync: () => f.forbidden("Firefox status"), defaultFirefoxBinaryPaths: () => [],
  buildFirefoxLaunchArgs: (await original<typeof import("../../src/main/services/browser-engine.js")>()).buildFirefoxLaunchArgs,
  spawnFirefoxWithDebugInfo: f.firefoxSpawn, writeFirefoxUserJs: f.firefoxPrefs,
}));
vi.mock("../../src/main/services/firefox-fingerprint.js", () => ({
  buildFirefoxManagedIdentity: () => f.forbidden("managed Firefox identity"), buildInjectionProbeExpression: () => "synthetic-probe", buildInjectionProbeExpectation: () => ({}),
  judgeInjectionProbe: () => ({ checked: true, confirmed: true, ambiguous: false, mismatches: [] }), normalizeFirefoxVersion: (value: unknown) => value, shouldBlockInjectionProbe: () => false,
}));
vi.mock("../../src/main/services/firefox-native-capabilities.js", () => ({
  firefoxNativeModeRequested: () => false, readFirefoxNativeCapabilityReportAsync: async () => null,
  FIREFOX_NATIVE_CONFIG_PREF: "agent.browser.fingerprint.config", FIREFOX_NATIVE_REQUIRED_SWITCH: "--agent-browser-native-required", getFirefoxNativeSelectionIdentityAsync: async () => "synthetic-file-identity",
  FIREFOX_NATIVE_CONFIG_CAPABILITIES: ["config-v1"], FIREFOX_NATIVE_PARITY_CAPABILITIES: ["parity-v1"],
}));
vi.mock("../../src/main/services/bidi-client.js", () => ({
  connectBidi: async () => ({ wsUrl: "ws://127.0.0.1:49049/session", closed: false, send: async () => ({ contexts: [{ context: "synthetic-context" }] }), close: () => undefined }),
  bidiAddPreloadScript: () => f.forbidden("preload mutation"), bidiCreateContext: async () => "synthetic-context", bidiCloseContext: () => undefined, bidiEvaluateInContext: async () => ({}),
  registerFirefoxSession: (port: number, connection: unknown) => f.sessions.set(port, connection), dropFirefoxSession: (port: number) => f.sessions.delete(port), getRegisteredFirefoxSession: (port: number) => f.sessions.get(port),
}));

import { checkFingerprintDrift, launchBrowser } from "../../src/main/services/browser-manager.js";
import { inspectBrowserLaunchLines } from "../../src/main/services/process-discovery.js";

const ID = "ab_health_launch_proxy";
const profileDir = path.join(fixturePaths.profiles, ID);
const isVirtualPath = (file: unknown): file is string => {
  if (typeof file !== "string" || !path.isAbsolute(file)) return false;
  const relative = path.relative(fixturePaths.root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const entry = (): runtime.RunningEntry => ({ pid: 4901, process: null, port: 49049, lastActivityAt: 0, engine: "chromium" });
const resolved = (type: ProxyConfig["type"] = "http"): ResolvedProfileProxy => ({
  mode: "named", name: "actual-fallback", rotatedFrom: "requested-primary", rotationReason: "synthetic health selection",
  config: { type, host: "synthetic-private-host.invalid", port: 8080, username: "synthetic-user", password: "synthetic-password", bypassList: ["synthetic-bypass.invalid"] },
});
beforeEach(() => {
  vi.clearAllMocks(); runtime.runningProcesses.clear(); f.sessions.clear(); f.lines = [];
  f.capture.mockImplementation(() => f.forbidden("fingerprint wire"));
  f.status.mockImplementation(() => f.forbidden("lifecycle.statusBrowser"));
  f.cfg = { chromiumBin: fixturePaths.chromiumBin, proxies: {}, proxyHealth: {}, blockOnFingerprintDrift: false, blockOnEnvironmentRisk: false,
    browserProfiles: { [ID]: { name: "Health launch fixture", engine: "chromium", fingerprintMode: "off", platform: "macos", fingerprintSeed: 49, locale: "en-US", timezone: "UTC", proxyMode: "none" } } };
  f.proxyResult = { mode: "none", name: null, config: null }; f.proxy.mockImplementation(() => f.proxyResult);
  f.inspect.mockImplementation((_directory, trackedPid) => inspectBrowserLaunchLines([`9 ${path.join(fixturePaths.root, "unrelated-process")}`, ...f.lines], profileDir, trackedPid));
  f.kill.mockImplementation((_pid, signal) => signal === 0 ? true : f.forbidden(`process signal ${signal}`));
  vi.spyOn(process, "kill").mockImplementation(f.kill as any);
  f.netCreate.mockImplementation(() => ({ once: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => ready(), address: () => ({ port: 49049 }), close: (done: () => void) => done() }));
  f.fetch.mockImplementation(async (url) => {
    if (url !== "http://127.0.0.1:49049/json/version" && url !== "http://127.0.0.1:49049/json") return f.forbidden(`network ${url}`);
    return { ok: true, json: async () => ({ Browser: "Chrome/150.0.7800.1", webSocketDebuggerUrl: "ws://127.0.0.1:49049/devtools/browser/synthetic" }) };
  });
  vi.stubGlobal("fetch", f.fetch);
  for (const key of ["AGENT_BROWSER_CHROMIUM_BINARY_PATH", "CLOAKLITE_CHROMIUM_BINARY_PATH", "AGENT_BROWSER_FIREFOX_BINARY_PATH", "FIREFOX_BINARY_PATH", "MOZ_DISABLE_CONTENT_SANDBOX", "AGENT_BROWSER_DIAGNOSTIC_APP_DATA_DIR", "AGENT_BROWSER_DIAGNOSTIC_NETLOG_FILE", "AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE"]) vi.stubEnv(key, undefined);
  const virtual = (file: unknown) => isVirtualPath(file) ? undefined : f.forbidden(`filesystem ${String(file)}`);
  for (const name of ["mkdirSync", "writeFileSync", "renameSync", "unlinkSync", "rmSync"]) f.fs[name].mockImplementation(virtual);
  f.fs.existsSync.mockImplementation((file) => { virtual(file); return file === fixturePaths.chromiumBin || file === fixturePaths.firefoxBin; });
  f.fs.readFileSync.mockImplementation((file) => { virtual(file); return "{}"; });
  f.fs.openSync.mockImplementation((file) => { virtual(file); return 49; });
  f.fs.writeSync.mockImplementation((fd) => fd === 49 ? 0 : f.forbidden("file descriptor write"));
  f.fs.closeSync.mockImplementation((fd) => { if (fd !== 49) f.forbidden("file descriptor close"); });
  f.fs.realpathSync.mockImplementation((file) => { virtual(file); return file; });
  for (const name of ["statSync", "lstatSync"]) f.fs[name].mockImplementation((file) => { virtual(file); return { isFile: () => true, isDirectory: () => false, size: 49, mtimeMs: 1 }; });
  const child = (file: string, args: string[]) => ({ pid: 4901, spawnargs: [file, ...args], exitCode: null, signalCode: null, killed: false, unref: vi.fn(), on: vi.fn() });
  f.spawn.mockImplementation(child);
  f.firefoxSpawn.mockImplementation(async (file, args) => ({ child: child(file, args), info: { actualPort: 49049, bidiWebSocketUrl: "ws://127.0.0.1:49049/session" } }));
  f.firefoxPrefs.mockImplementation(() => undefined);
  f.webRtcPreferencesValidate.mockImplementation(directory => { if (directory !== profileDir) f.forbidden("unexpected WebRTC preferences directory"); });
  f.webRtcPreferencesApply.mockImplementation((directory, policy) => {
    if (directory !== profileDir) f.forbidden("unexpected WebRTC preferences directory");
    return { policy: policy.restrictNonProxiedUdp || policy.effectiveMode === "disable" ? "disable_non_proxied_udp" : "default", changed: true, readbackVerified: true, directorySynced: true };
  });
});
afterEach(() => { runtime.runningProcesses.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); expect(f.forbidden).not.toHaveBeenCalled(); });

describe("read-only drift capture dispatch (not a fingerprint correctness oracle)", () => {
  it.each(["chromium", "firefox", undefined] as const)("uses the actual %s runtime even after saved engine intent changes", async (engine) => {
    Object.assign(f.cfg.browserProfiles[ID], { engine: engine === "firefox" ? "chromium" : "firefox", fingerprintBaseline: { userAgent: "synthetic baseline" } });
    runtime.setEntry(ID, { ...entry(), engine });
    f.status.mockReturnValue({ running: true, pid: 4901, cdpPort: 49049 });
    f.capture.mockResolvedValue({ userAgent: "synthetic runtime boundary" });
    const before = structuredClone(f.cfg);
    const result = await checkFingerprintDrift(ID);
    expect(result.checked).toBe(true);
    expect(result.currentConfigMatches).toBe(false);
    expect(result.report?.engine).toBe(engine ?? "chromium");
    expect(f.capture).toHaveBeenCalledWith(49049, engine ?? "chromium");
    expect(f.cfg).toEqual(before);
  });
});

describe("minimal fresh-launch proxy evidence", () => {
  it("retains only the actual resolved mode/type/source, never routing identity or credentials", () => {
    const input = resolved("socks5h"); const before = structuredClone(input);
    const snapshot = runtime.captureLaunchProxySnapshot(input);
    expect(snapshot).toEqual({ mode: "named", type: "socks5h", source: "fresh-launch" });
    expect(Object.keys(snapshot).sort()).toEqual(["mode", "source", "type"]);
    expect(JSON.stringify(snapshot)).not.toMatch(/"(?:host|port|name|username|password|bypassList|rotatedFrom|rotationReason)"/);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-");
    expect(input).toEqual(before);
    input.config!.type = "http"; input.name = "edited-after-capture";
    expect(snapshot.type).toBe("socks5h");
  });

  it("returns a detached projection on every get without changing the owning entry", () => {
    const owning = { ...entry(), launchProxy: runtime.captureLaunchProxySnapshot(resolved()) };
    runtime.setEntry(ID, owning);
    const first = runtime.getLaunchProxySnapshot(ID)!;
    first.mode = "none"; first.type = "socks5";
    expect(runtime.getLaunchProxySnapshot(ID)).toEqual({ mode: "named", type: "http", source: "fresh-launch" });
    expect(runtime.getLaunchProxySnapshot(ID)).not.toBe(runtime.getLaunchProxySnapshot(ID));
    expect(runtime.getEntry(ID)).toBe(owning);
    expect(owning.launchProxy).toEqual({ mode: "named", type: "http", source: "fresh-launch" });
  });

  it("leaves old/adopted/hash-only entries unknown rather than inferring a configured fallback", () => {
    expect(runtime.getLaunchProxySnapshot(ID)).toBeNull();
    const legacy = { ...entry(), launchProvenance: { version: 1 as const, requestHash: "a".repeat(64), payloadHash: "b".repeat(64) } };
    // Deliberately exercise a persisted v1 entry outside the current v2 type.
    const before = structuredClone(legacy); runtime.setEntry(ID, legacy as unknown as runtime.RunningEntry);
    expect(runtime.getLaunchProxySnapshot(ID)).toBeNull();
    expect(runtime.getEntry(ID)).toBe(legacy); expect(legacy).toEqual(before); expect(legacy).not.toHaveProperty("launchProxy");
    runtime.clearEntry(ID); expect(runtime.getLaunchProxySnapshot(ID)).toBeNull();
  });

  it("does not invent a proxy type for a direct launch or an unresolved non-direct receipt", () => {
    expect(runtime.captureLaunchProxySnapshot({ mode: "none", name: null, config: null })).toEqual({ mode: "none", source: "fresh-launch" });
    expect(runtime.captureLaunchProxySnapshot({ mode: "default", name: null, config: null })).toEqual({ mode: "default", source: "fresh-launch" });
  });
});

describe("actual fresh launch entry producers with declared synthetic effect boundaries", () => {
  it.each(["chromium", "firefox"] as const)("captures %s's selected fallback rather than the requested primary or later live config", async (engine) => {
    Object.assign(f.cfg.browserProfiles[ID], { engine, proxyMode: "named", proxyName: "primary" });
    f.cfg.proxies = {
      primary: { type: "socks5", host: "198.51.100.49", port: 1080, fallbacks: ["backup"] },
      backup: { type: "http", host: "198.51.100.50", port: 8080 },
    };
    f.cfg.proxyHealth = { primary: { risk: "poor", consecutiveFailures: 1 } };
    f.proxyResult = { mode: "named", name: "backup", config: f.cfg.proxies.backup, rotatedFrom: "primary", rotationReason: "synthetic-health-selected" };
    const launched = await launchBrowser(ID);
    expect(launched).toMatchObject({ pid: 4901, cdpPort: 49049 });
    expect(engine === "chromium" ? f.spawn : f.firefoxSpawn).toHaveBeenCalledOnce();
    if (engine === "chromium") {
      expect(f.webRtcPreferencesValidate).toHaveBeenCalledExactlyOnceWith(profileDir);
      expect(f.webRtcPreferencesApply).toHaveBeenCalledWith(profileDir, expect.objectContaining({ fingerprintMode: "off", effectiveMode: "proxy-only", restrictNonProxiedUdp: true }));
    } else { expect(f.webRtcPreferencesValidate).not.toHaveBeenCalled(); expect(f.webRtcPreferencesApply).not.toHaveBeenCalled(); }
    const stored = runtime.getEntry(ID)!;
    expect(stored.launchProxy).toEqual({ mode: "named", type: "http", source: "fresh-launch" });
    expect(runtime.getLaunchProxySnapshot(ID)).toEqual(stored.launchProxy);
    const retained = structuredClone(stored.launchProxy);
    f.cfg.proxies.backup.type = "socks5h"; f.cfg.browserProfiles[ID].proxyMode = "none";
    f.proxyResult = { mode: "none", name: null, config: null };
    expect(runtime.getLaunchProxySnapshot(ID)).toEqual(retained);
    expect(runtime.getLaunchProxySnapshot(ID)).not.toHaveProperty("name");
    expect(runtime.getEntry(ID)).toBe(stored);
    expect(f.fs.writeFileSync.mock.calls.every(([file]) => isVirtualPath(file))).toBe(true);
  });

  it.each(["chromium", "firefox"] as const)("retains an explicit direct receipt only for %s fresh launch", async (engine) => {
    f.cfg.browserProfiles[ID].engine = engine;
    await launchBrowser(ID);
    expect(runtime.getEntry(ID)?.launchProxy).toEqual({ mode: "none", source: "fresh-launch" });
    expect(runtime.getLaunchProxySnapshot(ID)).toEqual({ mode: "none", source: "fresh-launch" });
  });

  it("does not mint launch proxy evidence when the actual launcher adopts a recovered Chromium", async () => {
    await launchBrowser(ID);
    expect(runtime.getLaunchProxySnapshot(ID)).toEqual({ mode: "none", source: "fresh-launch" });
    const child = f.spawn.mock.results[0].value;
    f.lines = [`4901 ${child.spawnargs.join(" ")}`];
    runtime.clearEntry(ID); f.spawn.mockClear(); f.proxy.mockClear(); f.webRtcPreferencesValidate.mockClear(); f.webRtcPreferencesApply.mockClear();
    await launchBrowser(ID);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.proxy).not.toHaveBeenCalled();
    expect(f.webRtcPreferencesValidate).not.toHaveBeenCalled(); expect(f.webRtcPreferencesApply).not.toHaveBeenCalled();
    expect(runtime.getEntry(ID)).toMatchObject({ pid: 4901, process: null, engine: "chromium" });
    expect(runtime.getEntry(ID)).not.toHaveProperty("launchProxy");
    expect(runtime.getLaunchProxySnapshot(ID)).toBeNull();
  });
});
