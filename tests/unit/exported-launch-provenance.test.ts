import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserProfileMeta, ProxyConfig } from "../../src/main/types.js";

// Every external effect is replaced before importing the ACTUAL exported
// launcher. Synthetic PIDs are only ever passed to a mocked process.kill.
const f = vi.hoisted(() => ({
  cfg: {} as any, host: "macos" as "macos" | "windows" | null, lines: [] as string[],
  inspect: vi.fn(), legacy: vi.fn(), proxy: vi.fn(), audit: vi.fn(), release: vi.fn(), lock: vi.fn(),
  spawn: vi.fn(), version: vi.fn(), managedBinary: vi.fn(), fetch: vi.fn(), netCreate: vi.fn(), kill: vi.fn(),
  proxyProbe: vi.fn(), proxyUrl: vi.fn(), geoDetect: vi.fn(), geoObservedAt: vi.fn(), persistDetection: vi.fn(), diagnostics: vi.fn(), gpuContext: vi.fn(),
  webRtcPreferencesValidate: vi.fn(), webRtcPreferencesApply: vi.fn(),
  captureDetectionTarget: vi.fn(), commitObservation: vi.fn(), targets: new WeakMap<object, { name: string; config: ProxyConfig }>(), policies: [] as string[],
  secrets: vi.fn(() => { throw new Error("No secret access allowed"); }), saveConfig: vi.fn(), transact: vi.fn(),
  fs: {
    existsSync: vi.fn(), mkdirSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(),
    openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn(), renameSync: vi.fn(), unlinkSync: vi.fn(),
    rmSync: vi.fn(), realpathSync: vi.fn(), lstatSync: vi.fn(), statSync: vi.fn(),
  },
  firefoxBinary: vi.fn(), firefoxSpawn: vi.fn(), firefoxPrefs: vi.fn(),
  firefoxIdentity: vi.fn(), firefoxManaged: vi.fn(), bidiConnect: vi.fn(), bidiPreload: vi.fn(), bidiSessions: new Map<number, any>(),
  nativeRequested: false, firefoxCapabilities: vi.fn(), consistency: vi.fn(), persona: vi.fn(), captureFingerprint: vi.fn(), cachedDetection: vi.fn(),
  fingerprintDiff: vi.fn(), riskyDrift: vi.fn(),
  deadPids: new Set<number>(), envRisk: vi.fn(), windows: [] as any[],
  queuedCookies: [] as any[], cookieApply: vi.fn(), firefoxCookieApply: vi.fn(), cookieReadError: false,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...f.fs,
  // Import-time SQLite/ZIP guards need platform flags, not real file effects.
  // Keep every callable mocked; undeclared fs capabilities still fail closed.
  constants: (await importOriginal<typeof import("node:fs")>()).constants,
}));
vi.mock("node:net", () => ({ createServer: f.netCreate }));
vi.mock("node:dns", () => ({ lookup: () => { throw new Error("No DNS lookup allowed"); } }));
vi.mock("node:dns/promises", () => ({ lookup: () => { throw new Error("No DNS lookup allowed"); }, resolve: () => { throw new Error("No DNS lookup allowed"); } }));
vi.mock("node:os", () => ({ tmpdir: () => process.env.TMPDIR, homedir: () => process.env.HOME, hostname: () => "synthetic-launch-host", platform: () => process.platform, arch: () => process.arch }));
vi.mock("node:child_process", () => ({
  spawn: f.spawn,
  execSync: vi.fn(() => { throw new Error("No real process commands"); }),
  execFileSync: vi.fn(() => { throw new Error("No real process enumeration"); }),
  exec: vi.fn(() => { throw new Error("No real process enumeration"); }),
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => f.windows }, screen: { getPrimaryDisplay: () => ({ scaleFactor: 2 }) } }));
vi.mock("../../src/main/services/browser-platform-policy.js", () => ({ getHostBrowserPlatform: () => f.host }));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => f.cfg, getProfilesDir: () => "/virtual/profiles", getAppDataDir: () => "/virtual/state",
  saveConfig: f.saveConfig,
  resolveProfileProxy: vi.fn(), resolveProfileProxySecret: f.proxy, getProxyDetection: f.cachedDetection,
  setProxyDetectionIfCurrent: f.persistDetection,
  sanitizeAppUrl: (value: unknown) => value || null, getProxyHealthEntry: vi.fn(() => null), assertProfileWritable: vi.fn(),
}));
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  inspectBrowserLaunchesSync: f.inspect, findBrowserByProfileSync: f.legacy,
}));
vi.mock("../../src/main/services/browser/lifecycle.js", () => ({
  findBrowserByProfile: f.legacy, stopBrowser: vi.fn(), statusBrowser: vi.fn(), stopAllBrowserProfiles: vi.fn(),
  shutdownAllBrowserProfiles: vi.fn(), getCdpWebSocketUrl: vi.fn(),
}));
vi.mock("../../src/main/services/browser/idle-tracker.js", () => ({
  setIdlePolicyTimeoutMs: vi.fn(), getIdlePolicyTimeoutMs: vi.fn(), touchProfileActivity: vi.fn(),
  touchProfileActivityByPort: vi.fn(), getEngineByPort: vi.fn(), getFirefoxBidiSessionByPort: vi.fn(),
  getProfileIdleMs: vi.fn(), listRunningProfileIdle: vi.fn(), sweepIdleProfiles: vi.fn(),
}));
vi.mock("../../src/main/services/browser/launch-pipeline.js", () => ({ launchBrowserPipeline: vi.fn(() => { throw new Error("Test the exported launcher, not a wrapper"); }) }));
vi.mock("../../src/main/services/profile-restore-lock.js", () => ({ acquireRestoreLock: f.lock }));
// This suite owns process/launch ordering, not filesystem report publication.
// Keep the production guard and classifier; the IPC/report suites exercise the
// real diagnostic store with direct disk readback and session-bound authority.
vi.mock("../../src/main/services/fingerprint-drift-reports.js", () => ({
  beginFingerprintObservation: vi.fn(() => Object.freeze({})),
  saveFingerprintComparison: vi.fn((_handle, input) => ({
    schemaVersion: 1, policyVersion: 2, id: "11111111-1111-4111-8111-111111111111", dirId: input.dirId,
    observedAt: input.observedAt, source: input.source, hasBaseline: Boolean(input.meta.fingerprintBaseline),
    engine: input.meta.engine === "firefox" ? "firefox" : "chromium", engineVersion: input.engineVersion || null,
    fields: input.analysis.fields, baselineFields: input.analysis.baselineFields, availableFields: input.analysis.availableFields,
    comparedFields: input.analysis.comparedFields, changes: input.analysis.changes, counts: input.analysis.counts,
    risky: input.analysis.risky, partial: input.analysis.partial, saved: false, baselineCandidate: false,
    warning: "SYNTHETIC_REPORT_TRANSPORT",
  })),
}));
vi.mock("../../src/main/services/secrets.js", () => ({ decryptSecretOr: f.secrets }));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: f.audit }));
vi.mock("../../src/main/services/consistency-check.js", () => ({ checkProfileConsistency: f.consistency }));
vi.mock("../../src/main/services/drm.js", () => ({ drmLaunchArgs: () => [] }));
vi.mock("../../src/main/services/extension-repository.js", () => ({ getEnabledRepositoryExtensionPaths: () => [] }));
vi.mock("../../src/main/services/team.js", () => ({ requireProfileMutation: () => ({ ok: true }) }));
vi.mock("../../src/main/services/config/store.js", () => ({ transact: f.transact }));
vi.mock("../../src/main/services/event-bus.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../../src/main/services/cdp-cookie-service.js", () => ({
  cdpCookieService: { applyQueuedImports: f.cookieApply },
  readQueuedCookieImports: () => {
    if (f.cookieReadError) throw new Error("synthetic-cookie-read-canary");
    return f.queuedCookies.map((cookie) => ({ ...cookie }));
  },
}));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ firefoxCookieService: { applyQueuedImports: f.firefoxCookieApply } }));
vi.mock("../../src/main/services/fingerprint-baseline.js", () => ({
  captureFingerprint: f.captureFingerprint, diffFingerprints: f.fingerprintDiff, hasRiskyDrift: f.riskyDrift,
  summarizeDrift: () => "", checkPersonaConsistency: f.persona, mismatchesAsDrift: () => [],
}));
vi.mock("../../src/main/services/environment-risk.js", () => ({
  checkEnvironmentRisk: () => ({ ok: true, findings: [] }), checkEnvironmentRiskRuntime: f.envRisk,
  shouldBlockEnvironmentRisk: () => false, summarizeEnvFindings: () => "",
}));
vi.mock("../../src/main/services/authenticated-socks-bridge.js", () => ({ startAuthenticatedSocksBridge: vi.fn(() => { throw new Error("No bridge allowed"); }) }));
vi.mock("../../src/main/services/masque-socks-bridge.js", () => ({ startMasqueSocksBridge: vi.fn(() => { throw new Error("No bridge allowed"); }) }));
vi.mock("../../src/main/services/proxy-detector.js", () => ({
  buildChromiumProxyUrl: f.proxyUrl, probeProxyPort: f.proxyProbe, proxyDetectionObservedAt: f.geoObservedAt,
  proxyDetector: { detect: f.geoDetect },
}));
// Explicit new main-only observation boundary. The launch fixture models no
// config/store authority; actual target+stamp+disk commits have a separate suite.
vi.mock("../../src/main/services/proxy-detection.js", () => ({
  captureProxyDetectionTarget: f.captureDetectionTarget,
  detectProxyTarget: (target: object, policy: string) => {
    const captured = f.targets.get(target);
    if (!captured) throw new Error("Uncaptured launch detection target");
    f.policies.push(policy);
    return f.geoDetect(captured.config);
  },
  commitProxyDetectionIfCurrent: f.commitObservation,
}));
vi.mock("../../src/main/services/proxy-health.js", () => ({ recordProxyRotation: vi.fn() }));
vi.mock("../../src/main/services/native-chromium-manager.js", () => ({
  findManagedChromiumBinary: vi.fn(), findManagedChromiumBinaryAsync: f.managedBinary,
  getManagedChromiumRoot: () => "/virtual/chromium", listManagedChromiumBinaries: () => [], listManagedChromiumBinariesAsync: async () => [],
  normalizeManagedChromiumVersion: (value: unknown) => value || null,
}));
vi.mock("../../src/main/services/native-proxy-auth.js", () => ({
  LEGACY_NATIVE_PROXY_AUTH_SWITCH: "--roxy-proxy-auth", NATIVE_PROXY_AUTH_SWITCH: "--agent-browser-proxy-auth",
  NATIVE_SUPPRESS_GOOGLE_API_KEY_INFOBAR_SWITCH: "--agent-browser-suppress-google-api-key-infobar",
  NATIVE_LOCAL_DNS_POLICY_SWITCH: "--agent-browser-local-dns-policy",
  NATIVE_PROXY_BOOTSTRAP_HOST_SWITCH: "--agent-browser-proxy-bootstrap-host",
  supportsNativeLocalDnsPolicy: () => false,
  nativeProxyAuthSwitch: () => "--agent-browser-proxy-auth", supportsAgentBrowserFingerprintConfig: () => true,
  supportsGoogleApiKeyInfoBarSuppression: () => false, supportsNativeProxyAuth: () => false, supportsNativeQuicProxy: () => false,
  writeNativeProxyAuthFile: vi.fn(() => { throw new Error("No secret file allowed"); }),
}));
vi.mock("../../src/main/services/browser-command.js", () => ({ runBrowserCommand: f.version }));
vi.mock("../../src/main/services/browser/launch-diagnostics.js", () => ({ prepareChromiumDiagnosticNetLogArgs: f.diagnostics }));
vi.mock("../../src/main/services/browser/chromium-gpu-context.js", () => ({ readChromiumGpuContext: f.gpuContext }));
vi.mock("../../src/main/services/browser/webrtc-preferences.js", () => ({
  validateChromiumWebRtcPreferences: f.webRtcPreferencesValidate,
  applyChromiumWebRtcPreferences: f.webRtcPreferencesApply,
}));
vi.mock("../../src/main/services/bundled-native-browsers.js", () => ({ bundledBrowsersRoot: () => "/virtual/bundled" }));
vi.mock("../../src/main/services/native-firefox-manager.js", () => ({ getManagedFirefoxRoot: () => "/virtual/firefox" }));
vi.mock("../../src/main/services/browser-engine.js", async (importOriginal) => ({
  sanitizeBrowserEngine: (value: unknown) => value === "firefox" ? "firefox" : "chromium",
  normalizeManagedFirefoxVersion: (value: unknown) => value || null,
  findFirefoxBinaryAsync: f.firefoxBinary, detectFirefoxVersionAsync: async () => "154.0",
  getFirefoxBinaryOverride: () => process.env.AGENT_BROWSER_FIREFOX_BINARY_PATH || process.env.FIREFOX_BINARY_PATH || null,
  getFirefoxStatus: vi.fn(), getFirefoxStatusAsync: vi.fn(), defaultFirefoxBinaryPaths: () => [],
  buildFirefoxLaunchArgs: (await importOriginal<typeof import("../../src/main/services/browser-engine.js")>()).buildFirefoxLaunchArgs,
  spawnFirefoxWithDebugInfo: f.firefoxSpawn, writeFirefoxUserJs: f.firefoxPrefs,
}));
vi.mock("../../src/main/services/firefox-fingerprint.js", () => ({
  buildFirefoxManagedIdentity: f.firefoxManaged, buildInjectionProbeExpression: () => "owned-unit-probe", buildInjectionProbeExpectation: () => ({}),
  judgeInjectionProbe: () => ({ checked: true, confirmed: true, ambiguous: false, mismatches: [] }), normalizeFirefoxVersion: (value: unknown) => value, shouldBlockInjectionProbe: () => false,
}));
vi.mock("../../src/main/services/firefox-native-capabilities.js", () => ({
  firefoxNativeModeRequested: () => f.nativeRequested, readFirefoxNativeCapabilityReportAsync: f.firefoxCapabilities,
  FIREFOX_NATIVE_CONFIG_PREF: "agent.browser.fingerprint.config", FIREFOX_NATIVE_REQUIRED_SWITCH: "--agent-browser-native-required",
  getFirefoxNativeSelectionIdentityAsync: f.firefoxIdentity,
  FIREFOX_NATIVE_CONFIG_CAPABILITIES: ["config-v1"], FIREFOX_NATIVE_PARITY_CAPABILITIES: ["parity-v1"],
}));
vi.mock("../../src/main/services/bidi-client.js", () => ({
  connectBidi: f.bidiConnect,
  bidiAddPreloadScript: f.bidiPreload, bidiCreateContext: async () => "unit-context", bidiCloseContext: vi.fn(), bidiEvaluateInContext: async () => ({}),
  registerFirefoxSession: (port: number, conn: any) => f.bidiSessions.set(port, conn),
  dropFirefoxSession: (port: number) => f.bidiSessions.delete(port),
  getRegisteredFirefoxSession: (port: number) => f.bidiSessions.get(port),
}));

import { createBrowserProfile, launchBrowser } from "../../src/main/services/browser-manager.js";
import { LaunchBlockedError } from "../../src/main/services/browser/launch-guards.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";
import { emitEvent } from "../../src/main/services/event-bus.js";
import {
  assertChromiumLaunchProvenance, chromiumLaunchRequestHash, chromiumLaunchStampArg, stampChromiumLaunch,
  CHROMIUM_LAUNCH_STAMP_SWITCH, cachedChromiumProxy,
} from "../../src/main/services/browser/launch-provenance.js";
import { buildBrowserFingerprintArg, buildBrowserFingerprintConfig, type ChromiumGpuContext } from "../../src/main/services/browser-fingerprint-config.js";
import { resolveChromiumWebRtcRoutingPolicy, chromiumWebRtcRoutingArgs } from "../../src/main/services/browser/webrtc-policy.js";
import { inspectBrowserLaunchLines } from "../../src/main/services/process-discovery.js";

const dirId = "ab_task525";
const profileDir = `/virtual/profiles/${dirId}`;
const bin = "/virtual/Chromium.app/Contents/MacOS/Chromium";
const pid = 4101;
const port = 9222;
const currentMeta = (): BrowserProfileMeta => f.cfg.browserProfiles[dirId];

function launchedFixture(profile: BrowserProfileMeta = currentMeta(), gpuContext?: ChromiumGpuContext) {
  const mode = profile.fingerprintMode === "off" ? "off" : "managed";
  const requestHash = chromiumLaunchRequestHash(profile, f.cfg, { gpuContext });
  const proxy = cachedChromiumProxy(profile, f.cfg);
  const routing = resolveChromiumWebRtcRoutingPolicy({ requestedMode: profile.webrtcMode || (profile.webrtcIp ? "altered" : "auto"),
    fingerprintMode: mode, hasProxy: Boolean(proxy), webrtcIp: profile.webrtcIp });
  const nativeMeta = { ...profile, webrtcMode: routing.nativeMode, webrtcIp: routing.nativeIp };
  const native = buildBrowserFingerprintConfig(nativeMeta, "150.0.7800.1", null, "chromium", gpuContext);
  const args = [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`,
    ...(proxy ? [`--proxy-server=${proxy.type === "http" ? "http" : "socks5"}://${proxy.host}:${proxy.port}`] : []),
    ...chromiumWebRtcRoutingArgs(routing), ...(mode === "managed" ? [
    `--fingerprint=${profile.fingerprintSeed}`, `--fingerprint-platform=${profile.platform}`,
    buildBrowserFingerprintArg(nativeMeta, "150.0.7800.1", undefined, null, "chromium", gpuContext), `--user-agent=${native.userAgent}`,
  ] : [])];
  const provenance = stampChromiumLaunch(args, requestHash, mode);
  args.push(chromiumLaunchStampArg(provenance));
  const entry = { pid, process: null, port, lastActivityAt: 123, engine: "chromium" as const, launchProvenance: provenance };
  return { args, provenance, entry, line: `${pid} ${bin} ${args.join(" ")}` };
}

function noLaunchEffects() {
  expect(f.proxy).not.toHaveBeenCalled();
  expect(f.geoDetect).not.toHaveBeenCalled();
  expect(f.secrets).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.firefoxSpawn).not.toHaveBeenCalled();
  expect(f.netCreate).not.toHaveBeenCalled();
  expect(f.diagnostics).not.toHaveBeenCalled();
  expect(f.webRtcPreferencesValidate).not.toHaveBeenCalled();
  expect(f.webRtcPreferencesApply).not.toHaveBeenCalled();
  for (const write of [f.fs.mkdirSync, f.fs.writeFileSync, f.fs.openSync, f.fs.writeSync, f.fs.renameSync, f.fs.rmSync, f.fs.unlinkSync]) expect(write).not.toHaveBeenCalled();
  expect(f.kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
}

async function blocked(code: "host-platform-mismatch" | "restart-required") {
  const error = await launchBrowser(dirId, { forceDeadProxy: true }).then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(LaunchBlockedError);
  expect(error).toMatchObject({ code });
  noLaunchEffects();
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  f.host = "macos";
  f.lines = [];
  f.webRtcPreferencesValidate.mockImplementation(() => undefined);
  f.webRtcPreferencesApply.mockImplementation((_dir, policy) => ({ policy: policy.restrictNonProxiedUdp || policy.effectiveMode === "disable" ? "disable_non_proxied_udp" : "default", changed: true, readbackVerified: true, directorySynced: true }));
  f.cfg = {
    chromiumBin: bin, proxies: {}, blockOnFingerprintDrift: false, blockOnEnvironmentRisk: false,
    browserProfiles: { [dirId]: {
      name: "Portable", engine: "chromium", fingerprintMode: "managed", platform: "macos",
      fingerprintSeed: 12345, locale: "en-US", timezone: "UTC", proxyMode: "none",
    } },
  };
  runningProcesses.clear();
  f.saveConfig.mockImplementation(() => { throw new Error("No config persistence allowed"); });
  f.transact.mockImplementation(() => { throw new Error("No profile persistence allowed"); });
  f.lock.mockImplementation(() => f.release);
  f.inspect.mockImplementation((_dir, trackedPid) => inspectBrowserLaunchLines(["9 /virtual/unrelated-process", ...f.lines], profileDir, trackedPid));
  f.legacy.mockReturnValue(null);
  f.deadPids.clear(); f.bidiSessions.clear(); f.windows = [];
  f.queuedCookies = []; f.cookieReadError = false;
  f.cookieApply.mockReset().mockResolvedValue(0); f.firefoxCookieApply.mockReset().mockResolvedValue(0);
  f.kill.mockImplementation((target) => {
    if (f.deadPids.has(target)) throw Object.assign(new Error("fixture: exited"), { code: "ESRCH" });
    return true;
  });
  vi.spyOn(process, "kill").mockImplementation(f.kill as any);
  vi.stubEnv("AGENT_BROWSER_CHROMIUM_BINARY_PATH", "");
  vi.stubEnv("CLOAKLITE_CHROMIUM_BINARY_PATH", "");
  vi.stubEnv("AGENT_BROWSER_FIREFOX_BINARY_PATH", "");
  vi.stubEnv("FIREFOX_BINARY_PATH", "");
  vi.stubEnv("MOZ_DISABLE_CONTENT_SANDBOX", undefined);
  f.envRisk.mockReset().mockResolvedValue({ ok: true, findings: [] });
  f.consistency.mockReset().mockReturnValue({ ok: true, warnings: [], blockers: [] });
  f.persona.mockReset().mockReturnValue({ ok: true, mismatches: [] });
  f.captureFingerprint.mockReset().mockResolvedValue({ timezone: "UTC" });
  f.fingerprintDiff.mockReset().mockReturnValue([]);
  f.riskyDrift.mockReset().mockReturnValue(false);
  f.nativeRequested = false;
  f.firefoxCapabilities.mockReset().mockResolvedValue(null);
  f.bidiPreload.mockReset().mockResolvedValue("unit-preload");
  vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_APP_DATA_DIR", undefined);
  vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_FILE", undefined);
  vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE", undefined);
  f.diagnostics.mockReset().mockReturnValue([]);
  f.gpuContext.mockReset().mockReturnValue({ hostPlatform: "darwin", hostArchitecture: "arm64", kernelArchitecture: null });
  f.proxy.mockReturnValue({ mode: "none", name: null, config: null });
  f.proxyProbe.mockImplementation(() => { throw new Error("No proxy/network probe allowed"); });
  f.geoDetect.mockReset().mockImplementation(() => { throw new Error("No proxy/network probe allowed"); });
  f.geoObservedAt.mockReset().mockReturnValue(null);
  f.persistDetection.mockReset().mockImplementation(() => { throw new Error("No proxy cache writes allowed"); });
  f.targets = new WeakMap(); f.policies.length = 0;
  f.captureDetectionTarget.mockReset().mockImplementation((name: string, config: ProxyConfig) => {
    const target = Object.freeze({});
    f.targets.set(target, { name, config: structuredClone(config) });
    return target;
  });
  f.commitObservation.mockReset().mockImplementation((target: object, detection: any) => {
    const captured = f.targets.get(target);
    if (!captured) throw new Error("Uncaptured launch persistence target");
    let timezone: string | null = null;
    try { if (detection.timezone && !/^[+-]/.test(detection.timezone)) timezone = new Intl.DateTimeFormat('en-US', { timeZone: detection.timezone }).resolvedOptions().timeZone; } catch { /* explicit invalid provider field */ }
    f.persistDetection(captured.name, captured.config, { ...detection, timezone, detectedAt: detection.observedAt });
    return 'committed';
  });
  f.cachedDetection.mockReset().mockReturnValue(null);
  f.proxyUrl.mockImplementation((proxy: ProxyConfig) => `${proxy.type}://${proxy.host}:${proxy.port}`);
  f.fs.existsSync.mockImplementation((file) => file === bin || file === "/virtual/firefox-bin");
  f.fs.readFileSync.mockReturnValue("{}");
  f.fs.openSync.mockReturnValue(21);
  f.spawn.mockImplementation((file: string, args: string[]) => ({
    pid, spawnargs: [file, ...args], exitCode: null, signalCode: null, killed: false, unref: vi.fn(), on: vi.fn(),
  }));
  f.version.mockResolvedValue({ stdout: "Chromium 150.0.7800.1", stderr: "" });
  f.managedBinary.mockResolvedValue({ binaryPath: bin, version: "150.0.7800.1" });
  f.netCreate.mockImplementation(() => ({
    once: vi.fn(), listen: vi.fn((_port: number, _host: string, ready: () => void) => ready()),
    address: () => ({ port }), close: vi.fn((closed: () => void) => closed()),
  }));
  f.fetch.mockResolvedValue({ ok: true, json: async () => ({ Browser: "Chrome/150.0.7800.1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/task525` }) });
  vi.stubGlobal("fetch", f.fetch);
  f.firefoxBinary.mockResolvedValue(null);
  f.firefoxIdentity.mockReset().mockResolvedValue("unit-launcher-and-XUL-identity");
  f.firefoxManaged.mockReset().mockImplementation((meta) => ({
    config: buildBrowserFingerprintConfig(meta, "154.0", null, "firefox"), prefs: {}, nativePrefs: {}, preloadScript: "unit-preload-only",
  }));
  f.bidiConnect.mockReset().mockImplementation(async () => {
    const connection = { wsUrl: `ws://127.0.0.1:${port}/session`, closed: false,
      send: vi.fn(async () => ({ contexts: [{ context: "unit-context" }] })),
      close: vi.fn(() => { connection.closed = true; }),
    };
    return connection;
  });
  f.firefoxSpawn.mockReset().mockImplementation(async (file, args) => {
    const child = { pid: 5101, on: vi.fn(), unref: vi.fn(), spawnargs: [file, ...args],
      exitCode: null as number | null, signalCode: null, killed: false,
      kill: vi.fn(() => { child.killed = true; child.exitCode = 1; f.deadPids.add(child.pid); return true; }),
    };
    return { child, info: { actualPort: port, bidiWebSocketUrl: `ws://127.0.0.1:${port}/session` } };
  });
});

afterEach(() => {
  runningProcesses.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("actual common-create entry with fake storage", () => {
  function enableFakeWriter() {
    // Verify the actual factory's writer inputs, not filesystem persistence.
    // The parent harness separately owns real write/read/reload/list checks.
    f.saveConfig.mockImplementation((next) => { f.cfg = structuredClone(next); });
    f.transact.mockImplementation((mutate) => { mutate(f.cfg); });
  }

  it.each([
    ["Darwin", "macos", "macos"], ["win32", "windows", "windows"], ["unsupported", null, "windows"],
  ] as const)("uses the supported-host default for %s while preserving the unsupported portable fallback", async (_host, hostPlatform, expected) => {
    f.host = hostPlatform;
    enableFakeWriter();
    const created = createBrowserProfile({ name: "Factory default", fingerprintSeed: 12345 });
    const stored = f.cfg.browserProfiles[created.dirId];
    expect(stored).toMatchObject({ name: "Factory default", platform: expected, fingerprintMode: "managed" });
    expect(f.fs.mkdirSync).toHaveBeenCalledWith(`/virtual/profiles/${created.dirId}/Default`, { recursive: true });
    if (hostPlatform === null) {
      await expect(launchBrowser(created.dirId)).rejects.toMatchObject({ code: "host-platform-mismatch" });
      expect(f.inspect).not.toHaveBeenCalled();
      expect(f.spawn).not.toHaveBeenCalled();
    }
  });

  it("stores an explicit foreign platform with the forwarded preset unchanged, and rejects only at launch", async () => {
    enableFakeWriter();
    const created = createBrowserProfile({ name: "Portable preset", platform: "windows", preset: "portable-business-preset", fingerprintSeed: 12345 });
    const stored = f.cfg.browserProfiles[created.dirId];
    expect(stored).toMatchObject({ platform: "windows", preset: "portable-business-preset" });
    const beforeLaunch = structuredClone(stored);
    await expect(launchBrowser(created.dirId)).rejects.toMatchObject({ code: "host-platform-mismatch" });
    expect(f.cfg.browserProfiles[created.dirId]).toEqual(beforeLaunch);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.proxy).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

describe("actual exported launch ordering", () => {
  it.each(["validate", "apply"] as const)("refuses a %s routing preference failure without spawning", boundary => {
    const target = boundary === "validate" ? f.webRtcPreferencesValidate : f.webRtcPreferencesApply;
    target.mockImplementation(() => { throw Object.assign(new Error("Owned preference refusal"), { code: "webrtc-preferences-unavailable" }); });
    return expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "webrtc-preferences-unavailable" }).then(() => {
      expect(f.spawn).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.diagnostics).not.toHaveBeenCalled();
      // The earlier ephemeral loopback port reservation is already released; no browser/CDP endpoint exists.
      expect(f.netCreate).toHaveBeenCalledOnce();
      const reservation = f.netCreate.mock.results[0].value;
      expect(reservation.listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
      expect(reservation.close).toHaveBeenCalledOnce();
      expect(runningProcesses.has(dirId)).toBe(false); expect(f.release).toHaveBeenCalledOnce();
      if (boundary === "validate") {
        expect(f.webRtcPreferencesApply).not.toHaveBeenCalled(); expect(f.fs.writeFileSync).not.toHaveBeenCalled();
      }
    });
  });

  it("validates before locale writes, applies before spawning and pins Default", async () => {
    await launchBrowser(dirId);
    expect(f.webRtcPreferencesValidate).toHaveBeenCalledExactlyOnceWith(profileDir);
    expect(f.webRtcPreferencesApply).toHaveBeenCalledOnce();
    const validated = f.webRtcPreferencesValidate.mock.invocationCallOrder[0], applied = f.webRtcPreferencesApply.mock.invocationCallOrder[0];
    expect(validated).toBeLessThan(f.fs.writeFileSync.mock.invocationCallOrder[0]);
    expect(applied).toBeGreaterThan(f.fs.writeFileSync.mock.invocationCallOrder.at(-1)!);
    expect(applied).toBeLessThan(f.spawn.mock.invocationCallOrder[0]);
    expect(f.spawn.mock.calls[0][1].filter((arg: string) => arg.startsWith("--profile-directory"))).toEqual(["--profile-directory=Default"]);
  });

  it("reports the checked empty Cookie queue without claiming any applied Cookie", async () => {
    const result = await launchBrowser(dirId);
    expect(result).toMatchObject({ pid, cdpPort: port, cookieCheck: { checked: true, applied: 0, pending: 0 } });
    expect((result as any).cookieCheck.error).toBeUndefined();
  });

  it.each([0, 1])("reports incomplete queued Cookie application after a successful launch: %i of 2", async (applied) => {
    f.queuedCookies = ["first", "second"].map((name) => ({ domain: "example.test", name, value: "synthetic-unit-cookie", path: "/", secure: false, httpOnly: false, expires: null, sameSite: 1 }));
    f.cookieApply.mockResolvedValue(applied);
    const result = await launchBrowser(dirId);
    expect(result).toMatchObject({ pid, cdpPort: port, cookieCheck: { checked: true, applied, pending: 2, error: "COOKIE_IMPORT_INCOMPLETE" } });
    expect(runningProcesses.get(dirId)?.process).toBe(f.spawn.mock.results[0].value);
    expect(f.kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
    expect(f.cookieApply).toHaveBeenCalledExactlyOnceWith(dirId, expect.objectContaining({ port, isCurrent: expect.any(Function) }));
    const target = f.cookieApply.mock.calls[0][1];
    expect(target.isCurrent()).toBe(true);
    const original = runningProcesses.get(dirId)!;
    runningProcesses.set(dirId, { ...original });
    expect(target.isCurrent()).toBe(true); // Verified warm reuse can retain this same native child.
    runningProcesses.set(dirId, { ...original, process: {} });
    expect(target.isCurrent()).toBe(false);
    runningProcesses.set(dirId, { ...original, port: port + 1 });
    expect(target.isCurrent()).toBe(false);
  });

  it.each(["exitCode", "signalCode", "killed", "pid"] as const)("invalidates queued Cookie native-owner liveness when the child changes %s without replacing its entry", async (field) => {
    f.queuedCookies = [{ domain: "example.test", name: "session", value: "synthetic-unit-cookie", path: "/" }];
    const observed: boolean[] = [];
    f.cookieApply.mockImplementation(async (_id, target) => {
      const entry = runningProcesses.get(dirId)!;
      const child = f.spawn.mock.results[0].value;
      observed.push(target.isCurrent());
      child[field] = field === "exitCode" ? 0 : field === "signalCode" ? "SIGTERM" : field === "killed" ? true : pid + 1;
      expect(runningProcesses.get(dirId)).toBe(entry);
      observed.push(target.isCurrent());
      return 0;
    });
    await launchBrowser(dirId);
    expect(observed).toEqual([true, false]);
  });

  it("reports full queued Cookie application only after observing the consumed queue", async () => {
    f.queuedCookies = [{ domain: "example.test", name: "session", value: "synthetic-unit-cookie", path: "/" }];
    f.cookieApply.mockImplementation(async () => { f.queuedCookies = []; return 1; });
    const result = await launchBrowser(dirId);
    expect(result).toMatchObject({ cookieCheck: { checked: true, applied: 1, pending: 0 } });
    expect((result as any).cookieCheck.error).toBeUndefined();
  });

  it("keeps the launched browser and reports a redacted queued Cookie failure instead of pretending it was unchecked", async () => {
    f.queuedCookies = [{ domain: "example.test", name: "session", value: "synthetic-unit-cookie", path: "/" }];
    f.cookieApply.mockRejectedValue(new Error("synthetic-cookie-canary-must-not-be-logged"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await launchBrowser(dirId);
    expect(result).toMatchObject({ pid, cdpPort: port, cookieCheck: { checked: true, applied: 0, pending: 1, error: "COOKIE_IMPORT_UNAVAILABLE" } });
    expect(runningProcesses.get(dirId)?.process).toBe(f.spawn.mock.results[0].value);
    expect(f.kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("synthetic-cookie-canary-must-not-be-logged");
  });

  it.each([0, 1, 2])("notifies actual Chromium exit after %i verified warm reuses of the same child", async (reuses) => {
    const launched = await launchBrowser(dirId);
    const original = runningProcesses.get(dirId)!;
    const child = f.spawn.mock.results[0].value;
    const [actualBin, args] = f.spawn.mock.calls[0] as [string, string[]];
    const exited = child.on.mock.calls.find(([event]: [string]) => event === "exit")?.[1];
    expect(exited).toBeTypeOf("function");
    f.lines = [`${pid} ${actualBin} ${args.join(" ")}`];
    for (let reuse = 0; reuse < reuses; reuse++) {
      const previous = runningProcesses.get(dirId)!;
      expect(await launchBrowser(dirId)).toMatchObject({ pid: launched.pid, cdpPort: launched.cdpPort });
      expect(runningProcesses.get(dirId)).not.toBe(previous);
      expect(runningProcesses.get(dirId)?.process).toBe(child);
    }
    expect(f.spawn).toHaveBeenCalledOnce();
    const current = runningProcesses.get(dirId)!;
    expect(current === original).toBe(reuses === 0);
    const timer = setTimeout(() => { throw new Error("Owned stop timer was not cleared on real child exit"); }, 60_000);
    const close = vi.fn(async () => undefined);
    current.killTimer = timer;
    current.stopping = true;
    current.proxyBridge = { close } as any;
    const send = vi.fn();
    f.windows = [{ isDestroyed: () => false, webContents: { send } }];
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    vi.mocked(emitEvent).mockClear(); f.fs.closeSync.mockClear();
    child.exitCode = 0; f.deadPids.add(pid);
    try {
      exited(0, null);
      expect(runningProcesses.has(dirId)).toBe(false);
      expect(cleared).toHaveBeenCalledWith(timer);
      expect(close).toHaveBeenCalledOnce();
      expect(f.fs.closeSync).toHaveBeenCalledWith(21);
      expect(send.mock.calls).toEqual([
        ["browser:exited", { dirId, pid, timestamp: expect.any(Number) }],
        ["cloak:exited", { dirId, pid, timestamp: expect.any(Number) }],
      ]);
      expect(emitEvent).toHaveBeenCalledExactlyOnceWith("profile:exited", { dirId, pid });
    } finally { clearTimeout(timer); }
  });

  it.each(["pid", "port", "child", "in-place-child"] as const)("does not adopt an old exit when the runtime changed its %s identity", async (changed) => {
    await launchBrowser(dirId);
    const original = runningProcesses.get(dirId)!;
    const child = f.spawn.mock.results[0].value;
    const exited = child.on.mock.calls.find(([event]: [string]) => event === "exit")?.[1];
    expect(exited).toBeTypeOf("function");
    const current = changed === "in-place-child" ? original : { ...original };
    if (changed === "pid") current.pid++;
    else if (changed === "port") current.port++;
    else current.process = { ...child };
    const timer = setTimeout(() => { throw new Error("Replacement timer must be cleaned by its own test owner"); }, 60_000);
    const close = vi.fn(async () => undefined);
    current.killTimer = timer; current.proxyBridge = { close } as any;
    runningProcesses.set(dirId, current);
    const send = vi.fn();
    f.windows = [{ isDestroyed: () => false, webContents: { send } }];
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    vi.mocked(emitEvent).mockClear(); f.fs.closeSync.mockClear();
    try {
      exited(0, null);
      expect(runningProcesses.get(dirId)).toBe(current);
      expect(cleared).not.toHaveBeenCalledWith(timer);
      expect(close).not.toHaveBeenCalled();
      expect(f.fs.closeSync).toHaveBeenCalledWith(21);
      expect(send).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalled();
    } finally { clearTimeout(timer); }
  });

  it.each(["same PID and port", "different PID and port"] as const)("does not let an old Chromium exit clear a replacement runtime: %s", async (kind) => {
    await launchBrowser(dirId);
    const original = runningProcesses.get(dirId)!;
    const child = f.spawn.mock.results[0].value;
    const exited = child.on.mock.calls.find(([event]: [string]) => event === "exit")?.[1];
    expect(exited).toBeTypeOf("function");
    const timer = setTimeout(() => { throw new Error("Replacement timer must be cleaned by its own test owner"); }, 60_000);
    const close = vi.fn(async () => undefined);
    const replacement = { ...original, process: {}, proxyBridge: { close }, killTimer: timer,
      ...(kind === "different PID and port" ? { pid: pid + 1, port: port + 1 } : {}) };
    runningProcesses.set(dirId, replacement);
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    vi.mocked(emitEvent).mockClear();
    try {
      exited(0, null);
      expect(runningProcesses.get(dirId)).toBe(replacement);
      expect(cleared).not.toHaveBeenCalledWith(timer);
      expect(close).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalled();
    } finally { clearTimeout(timer); }
  });

  it.each(["cached", "discovered", "fresh"])("blocks the Win32 persona/native Apple-host mismatch before %s reuse or spawn", async (route) => {
    currentMeta().platform = "windows";
    const fixture = launchedFixture();
    if (route === "cached") runningProcesses.set(dirId, fixture.entry);
    if (route === "discovered") f.lines = [fixture.line];
    await blocked("host-platform-mismatch");
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.legacy).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.managedBinary).not.toHaveBeenCalled();
    expect(f.version).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(currentMeta().platform).toBe("windows");
    if (route === "cached") expect(runningProcesses.get(dirId)).toBe(fixture.entry);
  });

  it("fails closed for an unsupported host rather than classifying it as Windows", async () => {
    f.host = null;
    currentMeta().platform = "windows";
    await blocked("host-platform-mismatch");
    expect(f.inspect).not.toHaveBeenCalled();
  });
});

describe("late Chromium startup failures preserve a replacement owner", () => {
  it.each(["fingerprint-drift", "fingerprint-check-unavailable"] as const)(
    "preserves %s and its evidence after terminating the owned child", async (code) => {
      const actual = await vi.importActual<typeof import("../../src/main/services/fingerprint-baseline.js")>("../../src/main/services/fingerprint-baseline.js");
      f.fingerprintDiff.mockImplementation(actual.diffFingerprints);
      f.riskyDrift.mockImplementation(actual.hasRiskyDrift);
      currentMeta().fingerprintBaseline = { tz: "UTC" };
      const before = structuredClone(currentMeta());
      f.cfg.blockOnFingerprintDrift = true;
      if (code === "fingerprint-drift") f.captureFingerprint.mockResolvedValue({ tz: "Asia/Tokyo" });
      else f.captureFingerprint.mockRejectedValue(new Error("No debuggable page found"));
      f.kill.mockImplementation((target, signal) => {
        if (signal === "SIGTERM") { f.deadPids.add(target); return true; }
        if (f.deadPids.has(target)) throw Object.assign(new Error("fixture: exited"), { code: "ESRCH" });
        return true;
      });
      const error = await launchBrowser(dirId).then(() => null, (caught) => caught);
      expect(error).toBeInstanceOf(LaunchBlockedError);
      expect(error).toMatchObject({ code, driftBlocked: true, driftCheck: code === "fingerprint-drift"
        ? { checked: true, risky: true, drift: [{ field: "tz", baseline: "UTC", current: "Asia/Tokyo" }] }
        : { checked: false, error: "No debuggable page found" } });
      expect(f.spawn).toHaveBeenCalledOnce();
      expect(f.kill).toHaveBeenCalledWith(pid, "SIGTERM");
      expect(f.deadPids.has(pid)).toBe(true);
      expect(runningProcesses.has(dirId)).toBe(false);
      expect(vi.mocked(emitEvent).mock.calls.some(([event]) => event === "profile:launched")).toBe(false);
      expect(currentMeta()).toEqual(before);
      expect(f.saveConfig).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalled();
    },
  );

  it.each(["fingerprint-drift", "fingerprint-check-unavailable"] as const)(
    "uses the same %s gate and evidence when cleaning a Firefox launch", async (code) => {
      const actual = await vi.importActual<typeof import("../../src/main/services/fingerprint-baseline.js")>("../../src/main/services/fingerprint-baseline.js");
      f.fingerprintDiff.mockImplementation(actual.diffFingerprints);
      f.riskyDrift.mockImplementation(actual.hasRiskyDrift);
      currentMeta().engine = "firefox";
      currentMeta().fingerprintBaseline = { tz: "UTC" };
      f.cfg.blockOnFingerprintDrift = true;
      f.firefoxBinary.mockResolvedValue("/virtual/firefox-bin");
      if (code === "fingerprint-drift") f.captureFingerprint.mockResolvedValue({ tz: "Asia/Tokyo" });
      else f.captureFingerprint.mockRejectedValue(new Error("BiDi capture unavailable"));
      const error = await launchBrowser(dirId).then(() => null, (caught) => caught);
      expect(error).toBeInstanceOf(LaunchBlockedError);
      expect(error).toMatchObject({ code, driftBlocked: true, driftCheck: code === "fingerprint-drift"
        ? { checked: true, risky: true, drift: [{ field: "tz", baseline: "UTC", current: "Asia/Tokyo" }] }
        : { checked: false, error: "BiDi capture unavailable" } });
      expect(f.captureFingerprint).toHaveBeenCalledWith(port, "firefox");
      expect(f.firefoxSpawn).toHaveBeenCalledOnce();
      expect(f.deadPids.has(5101)).toBe(true);
      expect(f.bidiSessions.has(port)).toBe(false);
      expect(runningProcesses.has(dirId)).toBe(false);
      expect(currentMeta().fingerprintBaseline).toEqual({ tz: "UTC" });
      expect(f.saveConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["readiness-rejection", "fingerprint-drift-block"] as const)(
    "does not clean replacement B when stopped launch A resumes at %s", async (boundary) => {
      if (boundary === "fingerprint-drift-block") {
        // Keep the real guard, comparison and risk classification. Only its
        // external fingerprint capture is delayed; do not manufacture a block
        // by throwing from an audit mock or replacing the launcher/guard.
        const actual = await vi.importActual<typeof import("../../src/main/services/fingerprint-baseline.js")>("../../src/main/services/fingerprint-baseline.js");
        f.fingerprintDiff.mockImplementation(actual.diffFingerprints);
        f.riskyDrift.mockImplementation(actual.hasRiskyDrift);
        currentMeta().fingerprintBaseline = { tz: "UTC" };
        f.cfg.blockOnFingerprintDrift = true;
        f.captureFingerprint.mockResolvedValue({ tz: "UTC" });
      }

      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      let nextPid = pid, nextPort = port, nextLogFd = 21;
      f.spawn.mockImplementation((file: string, args: string[]) => Object.assign(new EventEmitter(), {
        pid: nextPid++, spawnargs: [file, ...args], exitCode: null as number | null,
        signalCode: null as string | null, killed: false, unref: vi.fn(),
      }));
      f.fs.openSync.mockImplementation(() => nextLogFd++);
      f.netCreate.mockImplementation(() => {
        const assignedPort = nextPort++;
        return { once: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => ready(),
          address: () => ({ port: assignedPort }), close: (closed: () => void) => closed() };
      });
      f.fetch.mockImplementation(async (url) => {
        const endpoint = new URL(String(url));
        return { ok: true, status: 200, json: async () => ({ Browser: "Chrome/150.0.7800.1",
          webSocketDebuggerUrl: `ws://${endpoint.host}/devtools/browser/task525` }) };
      });
      let entered!: () => void, resume!: (value: any) => void, reject!: (error: Error) => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<any>((resolve, fail) => { resume = resolve; reject = fail; });
      const wait = () => { entered(); return held; };
      if (boundary === "readiness-rejection") f.fetch.mockImplementationOnce(wait);
      else f.captureFingerprint.mockImplementationOnce(wait);
      const launchingA = launchBrowser(dirId).then(result => ({ result, error: null }), error => ({ result: null, error }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([reached, launchingA.then(() => { throw new Error("Launch A did not reach the selected external boundary"); })]);
        const entryA = runningProcesses.get(dirId)!;
        const childA = f.spawn.mock.results[0].value;
        const capturedA = { child: childA, pid: entryA.pid, port: entryA.port };
        expect(entryA.process).toBe(capturedA.child);
        expect(capturedA).toMatchObject({ pid, port });
        expect(f.release).toHaveBeenCalledOnce(); // The real launcher has released its startup lock.

        // Supply the post-stop native exit boundary, not a copied stop routine.
        // B must use the real launcher's ESRCH path if A has no exit listener yet.
        entryA.stopping = true;
        childA.exitCode = 0; f.deadPids.add(capturedA.pid);
        childA.emit("exit", 0, null);
        const resultB = await launchBrowser(dirId);
        const entryB = runningProcesses.get(dirId)!;
        const childB = f.spawn.mock.results[1].value;
        expect(resultB).toMatchObject({ pid: pid + 1, cdpPort: port + 1 });
        expect(entryB.process).toBe(childB);
        expect(f.spawn).toHaveBeenCalledTimes(2);
        expect(f.release).toHaveBeenCalledTimes(2);
        expect(assertChromiumLaunchProvenance(f.spawn.mock.calls[1][1], chromiumLaunchRequestHash(currentMeta(), f.cfg), "managed"))
          .toEqual(entryB.launchProvenance);
        const closeB = vi.fn(async () => undefined);
        const timerFired = vi.fn();
        timer = setTimeout(timerFired, 60_000);
        const bridgeB = { close: closeB };
        entryB.killTimer = timer; entryB.stopping = true; entryB.proxyBridge = bridgeB as any;
        const cleared = vi.spyOn(globalThis, "clearTimeout");
        const send = vi.fn();
        f.windows = [{ isDestroyed: () => false, webContents: { send } }];
        const eventsBeforeFailure = vi.mocked(emitEvent).mock.calls.slice();
        f.fs.closeSync.mockClear();

        if (boundary === "readiness-rejection") {
          // The actual readiness loop catches fetch rejection, sleeps 250 ms,
          // then checks its original 15 s deadline. Advance only the fake clock.
          await vi.advanceTimersByTimeAsync(15_001);
          reject(new Error("controlled late A discovery rejection"));
          await vi.advanceTimersByTimeAsync(250);
        } else {
          resume({ tz: "Asia/Tokyo" }); // Real diff/risk logic produces the block.
        }
        const outcome = await launchingA;
        expect.soft(outcome.result).toBeNull();
        expect.soft(outcome.error).toBeInstanceOf(Error);
        if (boundary === "readiness-rejection") expect.soft(outcome.error?.message).toContain("CDP did not become ready");
        else {
          expect.soft(outcome.error?.message).toMatch(/^Fingerprint drift blocked \(/);
          expect.soft(outcome.error).toBeInstanceOf(LaunchBlockedError);
          expect.soft(outcome.error).toMatchObject({ code: "fingerprint-drift", driftBlocked: true,
            driftCheck: { checked: true, risky: true, observedAt: expect.any(Number),
              drift: [{ field: "tz", baseline: "UTC", current: "Asia/Tokyo" }] } });
        }

        // A's failure may retire A's own resources, never B's ownership lease.
        expect.soft(runningProcesses.get(dirId)).toBe(entryB);
        expect.soft(entryB).toMatchObject({ pid: resultB.pid, port: resultB.cdpPort, stopping: true });
        expect.soft(entryB.process).toBe(childB);
        expect.soft(entryB.proxyBridge).toBe(bridgeB);
        expect.soft(entryB.killTimer).toBe(timer);
        expect.soft(cleared).not.toHaveBeenCalledWith(timer);
        expect.soft(timerFired).not.toHaveBeenCalled();
        expect.soft(closeB).not.toHaveBeenCalled();
        expect.soft(f.fs.closeSync).not.toHaveBeenCalledWith(22);
        expect.soft(send).not.toHaveBeenCalled();
        expect.soft(vi.mocked(emitEvent).mock.calls).toEqual(eventsBeforeFailure);
        expect.soft(f.kill.mock.calls.filter((call) => call[1] !== 0).every((call) => call[0] === capturedA.pid)).toBe(true);
        expect.soft(f.secrets).not.toHaveBeenCalled();

        // Positive arm: B's own registered exit still clears its own lease and
        // emits its notifications exactly once; a blanket no-cleanup fix fails.
        childB.exitCode = 0; f.deadPids.add(resultB.pid);
        childB.emit("exit", 0, null);
        expect(runningProcesses.has(dirId)).toBe(false);
        expect(cleared).toHaveBeenCalledWith(timer);
        expect(closeB).toHaveBeenCalledOnce();
        expect(send.mock.calls).toEqual([
          ["browser:exited", { dirId, pid: resultB.pid, timestamp: expect.any(Number) }],
          ["cloak:exited", { dirId, pid: resultB.pid, timestamp: expect.any(Number) }],
        ]);
        expect(emitEvent).toHaveBeenLastCalledWith("profile:exited", { dirId, pid: resultB.pid });
        expect(vi.mocked(emitEvent).mock.calls).toHaveLength(eventsBeforeFailure.length + 1);
      } finally {
        // Also settle A if a fixture/precondition assertion failed while held.
        resume(boundary === "readiness-rejection" ? { ok: true } : { tz: "UTC" });
        await vi.advanceTimersByTimeAsync(250);
        await launchingA;
        if (timer) clearTimeout(timer);
        f.fetch.mockReset();
        vi.useRealTimers();
      }
    },
  );
});

describe("explicit scoped NetLog launch wiring", () => {
  const filePath = "/virtual/state/diagnostics/route.netlog.json";

  it("forwards only the explicitly scoped request through the actual fresh launcher", async () => {
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_APP_DATA_DIR", "/virtual/state");
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_FILE", filePath);
    const diagnosticArgs = [
      `--log-net-log=${filePath}`, "--net-log-capture-mode=Default",
      "--net-log-file-format=json", "--net-log-max-size-mb=64", "--net-log-duration=180",
    ];
    f.diagnostics.mockReturnValue(diagnosticArgs);
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    expect(f.diagnostics).toHaveBeenCalledOnce();
    expect(f.diagnostics).toHaveBeenCalledWith("/virtual/state", { appDataDir: "/virtual/state", filePath });
    const args = f.spawn.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(diagnosticArgs));
    expect(args).not.toContain("--disable-infobars");
    expect(args).not.toContain("--test-type");
    expect(f.secrets).not.toHaveBeenCalled();
  });

  it.each([20, 90])("forwards the explicit direct-fd %is mode and its fixed four flags on a fresh launch", async duration => {
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_APP_DATA_DIR", "/virtual/state");
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_FILE", filePath);
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE", `direct-fd-${duration}s`);
    const diagnosticArgs = [
      `--log-net-log=${filePath}`, "--net-log-capture-mode=Default",
      "--net-log-file-format=json", `--net-log-duration=${duration}`,
    ];
    f.diagnostics.mockReturnValue(diagnosticArgs);
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    expect(f.diagnostics).toHaveBeenCalledExactlyOnceWith("/virtual/state", {
      appDataDir: "/virtual/state", filePath, mode: `direct-fd-${duration}s`,
    });
    const args = f.spawn.mock.calls[0][1] as string[];
    expect(args.filter(arg => /^--(?:log-net-log|net-log-)/.test(arg))).toEqual(diagnosticArgs);
    expect(args.some(arg => arg.startsWith("--net-log-max-size-mb"))).toBe(false);
    expect(f.secrets).not.toHaveBeenCalled();
  });

  it.each(["direct-fd-90s", "unknown-mode", ""])("does not drop a fresh mode-only request (%j) before validation", async mode => {
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE", mode);
    f.diagnostics.mockImplementation((_root, request) => {
      if (request.mode !== undefined) throw new Error("Invalid Chromium diagnostic NetLog: mode or missing paths");
      return [];
    });
    await expect(launchBrowser(dirId)).rejects.toThrow(/Invalid Chromium diagnostic NetLog/);
    expect(f.diagnostics).toHaveBeenCalledExactlyOnceWith("/virtual/state", {
      appDataDir: undefined, filePath: undefined, mode,
    });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.secrets).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["cached", "direct-fd-90s"], ["app-restart", "direct-fd-90s"],
    ["cached", "unknown-mode"], ["app-restart", ""],
  ])("rejects mode-only %s reuse (%j) without reserving a file or spawning", async (route, mode) => {
    const fixture = launchedFixture();
    f.lines = [fixture.line];
    if (route === "cached") runningProcesses.set(dirId, fixture.entry);
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE", mode);
    const error = await blocked("restart-required");
    expect(error.message).toContain("cannot be armed on a reused browser");
    if (route === "cached") expect(runningProcesses.get(dirId)).toBe(fixture.entry);
  });

  it.each(["fresh", "cached"])("does not silently ignore an explicit Chromium diagnostic mode on %s Firefox", async route => {
    currentMeta().engine = "firefox";
    if (route === "cached") runningProcesses.set(dirId, { pid, process: null, port, lastActivityAt: 123, engine: "firefox" });
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE", "direct-fd-90s");
    await expect(launchBrowser(dirId)).rejects.toThrow(/Invalid Chromium diagnostic NetLog: mode requires a Chromium profile/);
    noLaunchEffects();
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["cached", "app-restart"])("does not pretend a new capture was armed on a %s process", async route => {
    const fixture = launchedFixture();
    f.lines = [fixture.line];
    if (route === "cached") runningProcesses.set(dirId, fixture.entry);
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_APP_DATA_DIR", "/virtual/state");
    vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_FILE", filePath);
    const error = await blocked("restart-required");
    expect(error.message).toContain("cannot be armed on a reused browser");
    expect(f.diagnostics).not.toHaveBeenCalled();
  });
});

describe("exported Chromium reuse", () => {
  it.each(["cached", "app-restart"])("reuses the unique main with five inherited-CDP helpers after %s without proxy/write/spawn", async (route) => {
    const fixture = launchedFixture();
    const helpers = Array.from({ length: 5 }, (_, index) => `${pid + 1 + index} /virtual/Chromium Helper (Renderer) --type=renderer --user-data-dir=${profileDir} --remote-debugging-port=${port}`);
    f.lines = [...helpers, fixture.line];
    if (route === "cached") runningProcesses.set(dirId, fixture.entry);
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    expect(runningProcesses.get(dirId)?.pid).toBe(pid);
    expect(runningProcesses.get(dirId)?.launchProvenance).toEqual(fixture.provenance);
    noLaunchEffects();
  });

  it.each(["with-main", "helper-only", "typed-owned-helper", "typed-owned-display-helper"])("refuses a tracked/cached real renderer helper (%s) without adopting, killing or spawning", async (kind) => {
    const fixture = launchedFixture();
    const helperPid = pid + 1;
    const helperArgs = kind === "typed-owned-display-helper"
      ? [...fixture.args, "--agent-browser-window-title-prefix=Helper", "--type=renderer"]
      : kind === "typed-owned-helper" ? ["--type=renderer", ...fixture.args]
      : ["--type=renderer", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`];
    const helperLine = `${helperPid} ${bin} ${helperArgs.join(" ")}`;
    f.lines = kind === "with-main" ? [helperLine, fixture.line] : [helperLine];
    const cached = {
      ...fixture.entry, pid: helperPid,
      process: kind.startsWith("typed-owned") ? { pid: helperPid, spawnargs: [bin, ...helperArgs], exitCode: null, signalCode: null, killed: false } : null,
    };
    runningProcesses.set(dirId, cached);
    await blocked("restart-required");
    expect(runningProcesses.get(dirId)).toBe(cached);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["cached", "app-restart"])("reuses exactly verified startup inputs after %s without proxy, write or spawn", async (route) => {
    const fixture = launchedFixture();
    f.lines = [fixture.line];
    if (route === "cached") runningProcesses.set(dirId, fixture.entry);
    currentMeta().name = "Renamed";
    currentMeta().note = "Not a startup identity input";
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    expect(runningProcesses.get(dirId)?.launchProvenance).toEqual(fixture.provenance);
    noLaunchEffects();
    expect(f.version).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each(["cached", "discovered"])("requires an explicit restart for changed seed/mode/engine/DNS after %s", async (route) => {
    for (const change of ["seed", "mode", "engine", "dns", "os"] as const) {
      currentMeta().engine = "chromium";
      currentMeta().fingerprintMode = "managed";
      currentMeta().platform = change === "os" ? "windows" : "macos";
      currentMeta().fingerprintSeed = 12345;
      currentMeta().proxyMode = "named";
      currentMeta().proxyName = "primary";
      f.cfg.proxies = { primary: { type: "http", host: "proxy.example.test", port: 8080 } as ProxyConfig };
      delete f.cfg.managedSecureDnsUrl;
      const fixture = launchedFixture();
      f.lines = [fixture.line];
      runningProcesses.clear();
      if (route === "cached") runningProcesses.set(dirId, fixture.entry);
      if (change === "seed") currentMeta().fingerprintSeed = 12346;
      if (change === "mode") currentMeta().fingerprintMode = "off";
      if (change === "engine") currentMeta().engine = "firefox";
      if (change === "dns") f.cfg.managedSecureDnsUrl = "https://dns.example.test/query{?dns}";
      if (change === "os") currentMeta().platform = "macos";
      await blocked("restart-required");
      if (route === "cached") expect(runningProcesses.get(dirId)).toBe(fixture.entry);
      else expect(runningProcesses.has(dirId)).toBe(false);
    }
  });

  it.each(["legacy", "malformed-stamp", "unknown-version", "duplicate-stamp", "payload", "wrong-exe", "ambiguous", "reused-pid", "missing-port"])("does not adopt, kill or relaunch %s evidence", async (kind) => {
    const fixture = launchedFixture();
    let line = fixture.line;
    if (kind === "legacy") line = `${pid} ${bin} ${fixture.args.slice(0, -1).join(" ")}`;
    if (kind === "malformed-stamp") line = line.replace(/v2\.[a-f0-9]+\.[a-f0-9]+$/, "v2.invalid.invalid");
    if (kind === "unknown-version") line = line.replace(CHROMIUM_LAUNCH_STAMP_SWITCH + "v2.", CHROMIUM_LAUNCH_STAMP_SWITCH + "v3.");
    if (kind === "duplicate-stamp") line += " " + fixture.args.at(-1);
    if (kind === "payload") line = line.replace(/--agent-browser-fingerprint-config=\S+/, "--agent-browser-fingerprint-config=malformed");
    if (kind === "wrong-exe") line = line.replace(bin, "/virtual/OtherChromium");
    if (kind === "reused-pid") line = `${pid} /virtual/other --user-data-dir=/virtual/other --remote-debugging-port=9333`;
    if (kind === "missing-port") line = line.replace(`--remote-debugging-port=${port}`, "");
    f.lines = [line, ...(kind === "ambiguous" ? [line.replace(/^4101/, "4102")] : [])];
    if (kind === "reused-pid") runningProcesses.set(dirId, fixture.entry);
    await blocked("restart-required");
    if (kind === "reused-pid") expect(runningProcesses.get(dirId)).toBe(fixture.entry);
    else expect(runningProcesses.has(dirId)).toBe(false);
  });

  it("does not swallow a restart guard in the old kill(pid,0) catch and clear the live entry", async () => {
    const fixture = launchedFixture();
    runningProcesses.set(dirId, fixture.entry);
    f.lines = [fixture.line];
    currentMeta().fingerprintSeed = 99999;
    await blocked("restart-required");
    expect(runningProcesses.get(dirId)).toBe(fixture.entry);
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(pid, 0);
  });

  it.each(["unavailable-discovery", "closed-port", "wrong-endpoint", "liveness-unknown"])("does not replace a cached live profile when verification is %s", async (failure) => {
    const fixture = launchedFixture();
    runningProcesses.set(dirId, fixture.entry);
    f.lines = [fixture.line];
    if (failure === "unavailable-discovery") f.inspect.mockReturnValue({ available: false, candidates: [], tracked: null });
    if (failure === "closed-port") f.fetch.mockRejectedValue(new Error("fixture: endpoint unavailable"));
    if (failure === "wrong-endpoint") f.fetch.mockResolvedValue({ ok: true, json: async () => ({ Browser: "Not Chromium", webSocketDebuggerUrl: "ws://other.example.test:9222/devtools/browser/other" }) });
    if (failure === "liveness-unknown") f.kill.mockImplementation(() => { throw Object.assign(new Error("fixture: access denied"), { code: "EPERM" }); });
    await blocked("restart-required");
    expect(runningProcesses.get(dirId)).toBe(fixture.entry);
  });
});

describe("startup proxy snapshot races", () => {
  it.each(["A-to-B", "A-to-B-to-A"] as const)("cancels stale %s preparation without mixing request A with proxy payload B", async (race) => {
    const proxyA: ProxyConfig = { type: "http", host: "proxy-a.example.test", port: 8080 };
    const proxyB: ProxyConfig = { type: "http", host: "proxy-b.example.test", port: 8080 };
    currentMeta().proxyMode = "named";
    currentMeta().proxyName = "primary";
    currentMeta().webrtcMode = "disable";
    f.cfg.proxies = { primary: proxyA };
    const requestA = chromiumLaunchRequestHash(currentMeta(), f.cfg);
    let resumeDiscovery!: (value: { binaryPath: string; version: string }) => void;
    let enteredDiscovery!: () => void;
    const discoveryEntered = new Promise<void>((resolve) => { enteredDiscovery = resolve; });
    f.managedBinary.mockImplementation(() => {
      enteredDiscovery();
      return new Promise<{ binaryPath: string; version: string }>((resolve) => { resumeDiscovery = resolve; });
    });
    // Mimic the real resolver's old live-read/default and the new optional
    // snapshot contract. No credentials, proxy sockets, or OS calls are used.
    f.proxy.mockImplementation((_dir: string, snapshot?: typeof f.cfg) => ({
      mode: "named", name: "primary", config: { ...(snapshot || f.cfg).proxies.primary },
    }));
    f.proxyProbe.mockImplementation(async () => {
      // On the old route B has already been captured here; restoring A before
      // spawn exposes the requestA/payloadB bug. A guard may cancel even earlier
      // while B is visible, which is also the required safe outcome.
      if (race === "A-to-B-to-A") f.cfg.proxies.primary = proxyA;
      await Promise.resolve();
      return true;
    });
    const launching = launchBrowser(dirId).then(() => null, (error) => error);
    await discoveryEntered;
    f.cfg.proxies.primary = proxyB;
    expect(chromiumLaunchRequestHash(currentMeta(), f.cfg)).not.toBe(requestA);
    resumeDiscovery({ binaryPath: bin, version: "150.0.7800.1" });
    const error = await launching;
    expect(error).toBeInstanceOf(LaunchBlockedError);
    expect(error).toMatchObject({ code: "restart-required" });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.firefoxSpawn).not.toHaveBeenCalled();
    expect(runningProcesses.has(dirId)).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
    // If resolution happened, it must have received the original snapshot,
    // never silently read the newer B configuration behind request A.
    for (const call of f.proxy.mock.calls) expect(call[1]?.proxies.primary.host).toBe(proxyA.host);
    expect(f.secrets).not.toHaveBeenCalled();
  });

  it.each(["proxy-probe", "version"])("cancels a request changed at the awaited %s boundary before preference writes or spawn", async (boundary) => {
    const proxyA: ProxyConfig = { type: "http", host: "proxy-a.example.test", port: 8080 };
    const proxyB: ProxyConfig = { type: "http", host: "proxy-b.example.test", port: 8080 };
    currentMeta().proxyMode = "named";
    currentMeta().proxyName = "primary";
    currentMeta().webrtcMode = "disable";
    f.cfg.proxies = { primary: proxyA };
    f.proxy.mockImplementation((_dir: string, snapshot?: typeof f.cfg) => ({
      mode: "named", name: "primary", config: { ...(snapshot || f.cfg).proxies.primary },
    }));
    f.proxyProbe.mockImplementation(async () => {
      if (boundary === "proxy-probe") f.cfg.proxies.primary = proxyB;
      return true;
    });
    f.version.mockImplementation(async () => {
      if (boundary === "version") f.cfg.proxies.primary = proxyB;
      return { stdout: "Chromium 150.0.7800.1", stderr: "" };
    });
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    expect(f.proxy.mock.calls[0][1].proxies.primary.host).toBe(proxyA.host);
    expect(f.spawn).not.toHaveBeenCalled();
    for (const writer of [f.fs.mkdirSync, f.fs.writeFileSync, f.fs.openSync, f.fs.writeSync, f.fs.renameSync]) expect(writer).not.toHaveBeenCalled();
    expect(runningProcesses.has(dirId)).toBe(false);
    expect(f.secrets).not.toHaveBeenCalled();
  });

  it("allows honest coherent A/A after an unobserved A-to-B-to-A between await checkpoints", async () => {
    const proxyA: ProxyConfig = { type: "http", host: "proxy-a.example.test", port: 8080 };
    const proxyB: ProxyConfig = { type: "http", host: "proxy-b.example.test", port: 8080 };
    currentMeta().proxyMode = "named";
    currentMeta().proxyName = "primary";
    currentMeta().webrtcMode = "disable";
    f.cfg.proxies = { primary: proxyA };
    const requestA = chromiumLaunchRequestHash(currentMeta(), f.cfg);
    f.proxy.mockImplementation((_dir: string, snapshot?: typeof f.cfg) => ({
      mode: "named", name: "primary", config: { ...(snapshot || f.cfg).proxies.primary },
    }));
    f.proxyProbe.mockImplementation(async () => {
      f.cfg.proxies.primary = proxyB;
      await Promise.resolve();
      f.cfg.proxies.primary = proxyA;
      return true;
    });
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    expect(f.proxy).toHaveBeenCalledOnce();
    const snapshot = f.proxy.mock.calls[0][1];
    expect(snapshot).not.toBe(f.cfg);
    expect(snapshot.proxies.primary.host).toBe(proxyA.host);
    const args = f.spawn.mock.calls[0][1] as string[];
    expect(args).toContain("--proxy-server=http://proxy-a.example.test:8080");
    expect(args.some((arg) => arg.includes(proxyB.host))).toBe(false);
    expect(chromiumLaunchRequestHash(currentMeta(), f.cfg)).toBe(requestA);
    expect(assertChromiumLaunchProvenance(args, requestA, "managed")).toEqual(runningProcesses.get(dirId)?.launchProvenance);
    expect(f.secrets).not.toHaveBeenCalled();
  });
});

describe("exported managed GPU generation policy", () => {
  const context = { hostPlatform: "darwin", hostArchitecture: "arm64", kernelArchitecture: "arm64" };

  it.each(["cached", "discovered"])("rejects a legacy native-GPU %s process before version or proxy activity", async (route) => {
    const old = launchedFixture();
    f.lines = [old.line];
    if (route === "cached") runningProcesses.set(dirId, old.entry);
    f.gpuContext.mockReturnValue(context);
    await blocked("restart-required");
    expect(f.version).not.toHaveBeenCalled();
    expect(f.managedBinary).not.toHaveBeenCalled();
  });

  it.each(["cached", "discovered"])("reuses a matching generated GPU %s process without a second spawn", async (route) => {
    f.gpuContext.mockReturnValue(context);
    const current = launchedFixture(currentMeta(), context);
    f.lines = [current.line];
    if (route === "cached") runningProcesses.set(dirId, current.entry);
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    noLaunchEffects();
  });

  it("encodes the generated GPU in the same actual launch payload that is stamped", async () => {
    f.gpuContext.mockReturnValue(context);
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    const args = f.spawn.mock.calls[0][1] as string[];
    const encoded = args.find((arg) => arg.startsWith("--agent-browser-fingerprint-config="))!.split("=")[1];
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    expect(payload.webgl).toEqual({ vendor: "Google Inc. (Apple)", renderer: "Apple M2" });
    const expected = buildBrowserFingerprintConfig(currentMeta(), "150.0.7800.1", null, "chromium", context);
    expect(payload).toEqual(expected);
    const request = chromiumLaunchRequestHash(currentMeta(), f.cfg, { gpuContext: context });
    expect(assertChromiumLaunchProvenance(args, request, "managed")).toEqual(runningProcesses.get(dirId)!.launchProvenance);
  });

  it("rejects kernel eligibility changing during async version detection", async () => {
    f.gpuContext.mockReturnValue(context);
    f.version.mockImplementation(async () => {
      f.gpuContext.mockReturnValue({ ...context, kernelArchitecture: "x64" });
      return { stdout: "Chromium 150.0.7800.1", stderr: "" };
    });
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("keeps off free of GPU configuration and architecture inspection", async () => {
    currentMeta().fingerprintMode = "off";
    currentMeta().gpuRenderer = "inactive metadata";
    f.gpuContext.mockReturnValue(context);
    await launchBrowser(dirId);
    expect(f.gpuContext).not.toHaveBeenCalled();
    const args = f.spawn.mock.calls[0][1] as string[];
    expect(args.some((arg) => arg.startsWith("--agent-browser-fingerprint-config="))).toBe(false);
  });
});

describe("spawn binding and retained off/Firefox routes", () => {
  it.each(["--lang=fr", "--type=renderer"])("uses exact live owned argv for a name containing %s, but requires unambiguous evidence after app restart", async (pseudoFlag) => {
    currentMeta().name = `QA ${pseudoFlag}`;
    await launchBrowser(dirId);
    const [actualBin, args] = f.spawn.mock.calls[0] as [string, string[]];
    expect(args.at(-1)).toBe(`--agent-browser-window-title-prefix=QA ${pseudoFlag}`);
    f.lines = [`${pid} ${actualBin} ${args.join(" ")}`];
    for (const mock of [f.proxy, f.spawn, f.netCreate, f.diagnostics, f.webRtcPreferencesValidate, f.webRtcPreferencesApply, ...Object.values(f.fs)]) mock.mockClear();
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    noLaunchEffects();
    runningProcesses.clear();
    await blocked("restart-required"); // Flat ps lost the display argv boundary.
    expect(runningProcesses.has(dirId)).toBe(false);
    f.lines = [`${pid} ${JSON.stringify(actualBin)} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`];
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port }); // CIM retains that boundary.
    noLaunchEffects();
  });

  it.each(["exited-child", "reused-pid", "wrong-observed-exe"])("does not trust stale owned argv when the child is %s", async (failure) => {
    currentMeta().name = "QA --lang=fr";
    await launchBrowser(dirId);
    const [actualBin, args] = f.spawn.mock.calls[0] as [string, string[]];
    const entry = runningProcesses.get(dirId)!;
    f.lines = [`${pid} ${actualBin} ${args.join(" ")}`];
    if (failure === "exited-child") entry.process.exitCode = 0;
    if (failure === "reused-pid") entry.process.pid = pid + 1;
    if (failure === "wrong-observed-exe") f.lines = [`${pid} /virtual/OtherChromium ${args.join(" ")}`];
    for (const mock of [f.proxy, f.spawn, f.netCreate, f.diagnostics, f.webRtcPreferencesValidate, f.webRtcPreferencesApply, ...Object.values(f.fs)]) mock.mockClear();
    await blocked("restart-required");
    expect(runningProcesses.get(dirId)).toBe(entry);
  });

  it.each(["managed", "off"] as const)("binds the actual %s spawn payload and then permits verified app-restart discovery", async (mode) => {
    currentMeta().fingerprintMode = mode;
    if (mode === "off") currentMeta().platform = "windows"; // Inactive on this native macOS host.
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    expect(f.spawn).toHaveBeenCalledOnce();
    const [actualBin, args] = f.spawn.mock.calls[0] as [string, string[]];
    expect(actualBin).toBe(bin);
    expect(args.filter((arg) => arg.startsWith(CHROMIUM_LAUNCH_STAMP_SWITCH))).toHaveLength(1);
    const requestHash = chromiumLaunchRequestHash(currentMeta(), f.cfg);
    expect(assertChromiumLaunchProvenance(args, requestHash, mode)).toEqual(runningProcesses.get(dirId)?.launchProvenance);
    expect(args.some((arg) => arg.startsWith("--agent-browser-fingerprint-config="))).toBe(mode === "managed");
    expect(args.some((arg) => arg.startsWith("--user-agent="))).toBe(mode === "managed");
    f.lines = [`${pid} ${actualBin} ${args.join(" ")}`];
    runningProcesses.clear(); // App restart: no persistent registry is available.
    for (const mock of [f.proxy, f.spawn, f.netCreate, f.diagnostics, f.webRtcPreferencesValidate, f.webRtcPreferencesApply, ...Object.values(f.fs)]) mock.mockClear();
    expect(await launchBrowser(dirId)).toMatchObject({ pid, cdpPort: port });
    noLaunchEffects();
  });

  it.each(["cached", "discovered"])("does not bypass the existing off+DoH pre-spawn rejection through %s reuse", async (route) => {
    currentMeta().fingerprintMode = "off";
    currentMeta().platform = "android";
    currentMeta().proxyMode = "named";
    currentMeta().proxyName = "primary";
    f.cfg.proxies = { primary: { type: "http", host: "proxy.example.test", port: 8080 } };
    const fixture = launchedFixture();
    f.lines = [fixture.line];
    if (route === "cached") runningProcesses.set(dirId, fixture.entry);
    f.cfg.managedSecureDnsUrl = "https://dns.example.test/query{?dns}";
    await expect(launchBrowser(dirId, { forceDeadProxy: true })).rejects.toThrow("Explicit proxy DoH requires managed Chromium identity mode");
    noLaunchEffects();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it.each(["cached", "discovered"])("does not relabel an untyped/unknown %s browser as Firefox after an engine edit", async (route) => {
    currentMeta().engine = "firefox";
    currentMeta().platform = "android";
    const legacy = { pid, process: null, port, lastActivityAt: 123 };
    if (route === "cached") runningProcesses.set(dirId, legacy);
    else f.legacy.mockReturnValue({ pid, cdpPort: port });
    f.inspect.mockReturnValue({ available: false, candidates: [], tracked: null });
    await blocked("restart-required");
    if (route === "cached") expect(runningProcesses.get(dirId)).toBe(legacy);
    else expect(runningProcesses.has(dirId)).toBe(false);
  });

  it.each(["cached", "discovered"])("refuses unproven Firefox %s reuse even with a portable foreign OS", async (route) => {
    currentMeta().engine = "firefox";
    currentMeta().platform = "android";
    const firefox = { pid: 5101, process: null, port, lastActivityAt: 123, engine: "firefox" as const };
    f.lines = [`5101 /virtual/firefox-bin -profile ${profileDir} --remote-debugging-port ${port} -no-remote`];
    if (route === "cached") runningProcesses.set(dirId, firefox);
    else f.legacy.mockReturnValue({ pid: 5101, cdpPort: port });
    await blocked("restart-required");
    if (route === "cached") expect(runningProcesses.get(dirId)).toBe(firefox);
    else expect(runningProcesses.has(dirId)).toBe(false);
  });

  it("refuses a stopping Firefox entry instead of reporting it as running", async () => {
    currentMeta().engine = "firefox";
    runningProcesses.set(dirId, { pid: 5101, process: null, port, engine: "firefox", stopping: true, lastActivityAt: 123 });
    f.lines = [`5101 /virtual/firefox-bin -profile ${profileDir} --remote-debugging-port ${port} -no-remote`];
    await blocked("restart-required");
  });

  it("rejects Firefox identity changes during asynchronous binary selection before proxy or prefs writes", async () => {
    currentMeta().engine = "firefox";
    f.firefoxBinary.mockImplementation(async () => {
      currentMeta().fingerprintSeed++;
      return "/virtual/firefox-bin";
    });
    await blocked("restart-required");
  });

  it("does not apply inactive Firefox locale or timezone overrides in off mode", async () => {
    currentMeta().engine = "firefox";
    currentMeta().fingerprintMode = "off";
    currentMeta().locale = "fr-FR";
    currentMeta().timezone = "Europe/Paris";
    f.firefoxBinary.mockResolvedValue("/virtual/firefox-bin");
    await launchBrowser(dirId);
    expect(f.firefoxPrefs.mock.calls[0][1]).toMatchObject({ fingerprintMode: "off", locale: undefined });
    expect(f.firefoxSpawn.mock.calls[0][2]?.env).toBeUndefined();
    expect(f.envRisk).not.toHaveBeenCalled();
  });

  it.each(["1", "0", ""])('rejects inherited sandbox-disable value "%s" before Firefox side effects', async (value) => {
    currentMeta().engine = "firefox";
    f.firefoxBinary.mockResolvedValue("/virtual/firefox-bin");
    vi.stubEnv("MOZ_DISABLE_CONTENT_SANDBOX", value);
    await expect(launchBrowser(dirId)).rejects.toThrow("MOZ_DISABLE_CONTENT_SANDBOX");
    noLaunchEffects();
  });

  it("keeps fresh fingerprint-off Firefox on its own launcher without a Chromium stamp", async () => {
    currentMeta().engine = "firefox";
    currentMeta().fingerprintMode = "off";
    currentMeta().platform = "android";
    f.firefoxBinary.mockResolvedValue("/virtual/firefox-bin");
    expect(await launchBrowser(dirId)).toMatchObject({ pid: 5101, cdpPort: port });
    expect(f.firefoxSpawn).toHaveBeenCalledOnce();
    const args = f.firefoxSpawn.mock.calls[0][1] as string[];
    expect(args.some((arg) => arg.startsWith(CHROMIUM_LAUNCH_STAMP_SWITCH))).toBe(false);
    expect(runningProcesses.get(dirId)?.launchProvenance).toBeUndefined();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.secrets).not.toHaveBeenCalled();
  });
});

describe("Firefox effective Auto launch identity", () => {
  const proxy: ProxyConfig = { type: "http", host: "auto-proxy.example.test", port: 8080 };
  const geo = (timezone = "America/Toronto", countryCode = "CA") => ({
    success: true, exitIp: "192.0.2.40", country: countryCode, countryCode, timezone,
    provider: "mock-geo", latencyMs: 2,
    observedAt: 1_800_000_000_000, source: "network" as const, observationId: "synthetic-launch-observation",
  });

  function autoProxy() {
    Object.assign(currentMeta(), { engine: "firefox", timezone: null, locale: null, proxyMode: "named", proxyName: "primary" });
    f.cfg.proxies = { primary: proxy };
    f.firefoxBinary.mockResolvedValue("/virtual/firefox-bin");
    f.proxy.mockReturnValue({ mode: "named", name: "primary", config: proxy });
    f.proxyProbe.mockResolvedValue(true);
    f.geoDetect.mockResolvedValue(geo());
    f.geoObservedAt.mockReturnValue(1_800_000_000_000);
    f.persistDetection.mockReturnValue(true);
  }

  function healthRouting() {
    autoProxy();
    f.cfg.proxies = {
      primary: { ...proxy, fallbacks: ["backup"] },
      backup: { ...proxy, host: "fallback.example.test" },
    };
    f.cfg.proxyHealth = {
      primary: { risk: "good", consecutiveFailures: 0, lastCheckedAt: 100 },
      backup: { risk: "good", consecutiveFailures: 0, lastCheckedAt: 100 },
    };
    f.proxy.mockImplementation((profileId, snapshot) => {
      if (!snapshot) throw new Error("This route fixture requires an explicit config snapshot");
      const meta = snapshot.browserProfiles[profileId];
      const requested = meta.proxyMode === "default" ? snapshot.defaultProxy : meta.proxyName;
      const primary = snapshot.proxies[requested];
      const backup = primary.fallbacks?.find(name => snapshot.proxyHealth[name]?.risk !== "poor");
      const name = snapshot.proxyHealth[requested]?.risk === "poor" && backup ? backup : requested;
      return { mode: meta.proxyMode, name, config: { ...snapshot.proxies[name] },
        rotatedFrom: name === requested ? null : requested };
    });
  }

  function pause<T>() {
    let entered!: () => void, complete!: (value: T) => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    return { ready, wait: () => { entered(); return new Promise<T>(resolve => { complete = resolve; }); },
      resume: (value: T) => complete(value) };
  }

  function hostDefaults(timeZone = "Europe/Berlin", locale = "de-DE") {
    const host = { timeZone, locale };
    const RealFormatter = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((function(locales, options) {
      const formatter = new RealFormatter(locales, options);
      if (locales === undefined && options === undefined) {
        const actual = formatter.resolvedOptions();
        formatter.resolvedOptions = () => ({ ...actual, ...host });
      }
      return formatter;
    }) as typeof Intl.DateTimeFormat);
    return host;
  }

  async function realIdentity() {
    const actual = await vi.importActual<typeof import("../../src/main/services/firefox-fingerprint.js")>("../../src/main/services/firefox-fingerprint.js");
    f.firefoxManaged.mockImplementation(actual.buildFirefoxManagedIdentity);
  }

  async function launchOwned() {
    const response = await launchBrowser(dirId);
    const entry = runningProcesses.get(dirId)!;
    f.lines = [`${response.pid} /virtual/firefox-bin ${f.firefoxSpawn.mock.calls[0][1].join(" ")}`];
    const effects = [f.firefoxSpawn, f.firefoxPrefs, f.bidiConnect, f.bidiPreload, f.persistDetection,
      f.fs.mkdirSync, f.fs.writeFileSync, f.fs.openSync, f.fs.writeSync, f.fs.renameSync, f.fs.unlinkSync, f.fs.rmSync];
    const counts = effects.map(effect => effect.mock.calls.length);
    return { response, entry, unchanged: () => {
      effects.forEach((effect, index) => expect(effect).toHaveBeenCalledTimes(counts[index]));
      expect(entry.process.kill).not.toHaveBeenCalled();
      expect(f.kill.mock.calls.every(call => call[1] === 0)).toBe(true);
      expect(f.secrets).not.toHaveBeenCalled();
    } };
  }

  it("resolves Auto through the actual proxy before constructing Firefox identity and native TZ", async () => {
    autoProxy();
    const before = structuredClone(currentMeta());
    await launchBrowser(dirId);
    expect(f.firefoxManaged.mock.calls[0][0]).toMatchObject({ timezone: "America/Toronto", locale: "en-CA" });
    expect(f.geoDetect).toHaveBeenCalledExactlyOnceWith(proxy);
    expect(f.firefoxPrefs.mock.calls[0][1].locale).toBe("en-CA");
    expect(f.firefoxSpawn.mock.calls[0][2].env.TZ).toBe("America/Toronto");
    expect(f.envRisk.mock.calls[0][0]).toMatchObject({ timezone: "America/Toronto", locale: "en-CA" });
    expect(currentMeta()).toEqual(before);
    expect(f.saveConfig).not.toHaveBeenCalled();
    expect(f.transact).not.toHaveBeenCalled();
  });

  it("requires restart when unchanged raw Auto intent resolves to a different effective identity", async () => {
    autoProxy();
    const response = await launchBrowser(dirId);
    const entry = runningProcesses.get(dirId)!;
    f.lines = [`${response.pid} /virtual/firefox-bin ${f.firefoxSpawn.mock.calls[0][1].join(" ")}`];
    f.geoDetect.mockResolvedValue(geo("Asia/Tokyo", "JP"));
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    expect(runningProcesses.get(dirId)).toBe(entry);
    expect(entry.process.kill).not.toHaveBeenCalled();
    expect(f.firefoxSpawn).toHaveBeenCalledOnce();
    expect(f.firefoxPrefs).toHaveBeenCalledOnce();
    expect(f.bidiConnect).toHaveBeenCalledOnce();
  });

  it.each(["fallback", "native"] as const)("feeds one effective identity to %s config, prefs, child TZ and verification expectations", async route => {
    autoProxy();
    await realIdentity();
    if (route === "native") {
      f.nativeRequested = true;
      f.firefoxCapabilities.mockResolvedValue({ capabilities: ["config-v1", "parity-v1"] });
    }
    currentMeta().fingerprintBaseline = { timezone: "America/Toronto" } as any;
    await launchBrowser(dirId);
    const identity = f.firefoxManaged.mock.results[0].value;
    const prefs = f.firefoxPrefs.mock.calls[0][1];
    expect(identity.config).toMatchObject({ timezone: "America/Toronto", languages: ["en-CA", "en"] });
    expect(identity.nativeConfig).toMatchObject({ timezone: "America/Toronto", languages: ["en-CA", "en"] });
    expect(prefs.locale).toBe("en-CA");
    expect(prefs.extraPrefs["intl.accept_languages"]).toBe("en-CA,en");
    expect(f.firefoxSpawn.mock.calls[0][2].env.TZ).toBe(identity.config.timezone);
    expect(f.consistency.mock.calls[0][0]).toMatchObject({ timezone: "America/Toronto", locale: "en-CA", proxyGeo: { timezone: "America/Toronto", countryCode: "CA" } });
    expect(f.persona.mock.calls[0][0]).toMatchObject({ timezone: "America/Toronto" });
    expect(f.envRisk.mock.calls[0][0]).toMatchObject({ timezone: "America/Toronto", locale: "en-CA" });
    if (route === "native") {
      expect(JSON.parse(Buffer.from(prefs.extraPrefs["agent.browser.fingerprint.config"], "base64url").toString("utf8"))).toEqual(identity.nativeConfig);
      expect(f.bidiPreload).not.toHaveBeenCalled();
    } else {
      expect(f.bidiPreload.mock.calls[0][1]).toBe(identity.preloadScript);
      expect(identity.preloadScript).toContain('"timezone":"America/Toronto"');
      expect(identity.preloadScript).toContain('"languages":["en-CA","en"]');
    }
    expect(currentMeta()).toMatchObject({ timezone: null, locale: null });
    expect(f.geoDetect).toHaveBeenCalledExactlyOnceWith(proxy);
  });

  it.each([
    ["Europe/Paris", null, "Europe/Paris", "en-CA", 1],
    [null, "fr-FR", "America/Toronto", "fr-FR", 1],
    ["Europe/Paris", "fr-FR", "Europe/Paris", "fr-FR", 0],
  ] as const)("keeps explicit timezone %s and locale %s ahead of Auto proxy values", async (timezone, locale, expectedTimezone, expectedLocale, lookups) => {
    autoProxy();
    Object.assign(currentMeta(), { timezone, locale });
    await launchBrowser(dirId);
    expect(f.firefoxManaged.mock.calls[0][0]).toMatchObject({ timezone: expectedTimezone, locale: expectedLocale });
    expect(f.firefoxSpawn.mock.calls[0][2].env.TZ).toBe(expectedTimezone);
    expect(f.firefoxPrefs.mock.calls[0][1].locale).toBe(expectedLocale);
    expect(f.geoDetect).toHaveBeenCalledTimes(lookups);
    expect(currentMeta()).toMatchObject({ timezone, locale });
  });

  it.each([["Mars/Invalid", "en-US"], ["+05:30", "en-US"], ["UTC", "not_a_locale"]])("refuses invalid explicit managed identity %s/%s before Geo or prefs", async (timezone, locale) => {
    autoProxy();
    Object.assign(currentMeta(), { timezone, locale });
    await expect(launchBrowser(dirId)).rejects.toThrow(/Invalid (?:IANA )?(?:timezone|locale)/);
    expect(f.geoDetect).not.toHaveBeenCalled();
    expect(f.firefoxPrefs).not.toHaveBeenCalled();
    expect(f.firefoxSpawn).not.toHaveBeenCalled();
  });

  it.each(["named", "none"] as const)("keeps off fields dormant with a %s route, on fresh launch and reuse", async route => {
    autoProxy();
    // Identity fields stay dormant garbage on purpose. WebRTC routing does NOT:
    // the selector remains live with fingerprinting off, so it must carry a
    // valid stored value and is validated on every launch.
    Object.assign(currentMeta(), { fingerprintMode: "off", timezone: "inactive/invalid", locale: "inactive_invalid", webrtcMode: "auto", webrtcIp: "inactive", proxyMode: route });
    const before = structuredClone(currentMeta());
    const owned = await launchOwned();
    expect(f.firefoxManaged).not.toHaveBeenCalled();
    expect(f.geoDetect).not.toHaveBeenCalled();
    expect(f.firefoxSpawn.mock.calls[0][2].env).toBeUndefined();
    expect(f.firefoxPrefs.mock.calls[0][1]).toMatchObject({ fingerprintMode: "off", locale: undefined });
    expect(f.firefoxPrefs.mock.calls[0][1].extraPrefs).toBeUndefined();
    expect(f.bidiPreload).not.toHaveBeenCalled();
    expect(currentMeta()).toEqual(before);
    Object.assign(currentMeta(), { timezone: "another/invalid", locale: "another_invalid" });
    expect(await launchBrowser(dirId)).toMatchObject({ pid: owned.response.pid });
    expect(f.geoDetect).not.toHaveBeenCalled();
    owned.unchanged();
  });

  it.each(["none", "unconfigured-default"])("uses documented host defaults without Geo for a %s route", async route => {
    autoProxy();
    const host = hostDefaults();
    currentMeta().proxyMode = route === "none" ? "none" : "default";
    f.proxy.mockReturnValue({ mode: "none", name: null, config: null });
    await launchBrowser(dirId);
    expect(f.firefoxManaged.mock.calls[0][0]).toMatchObject({ timezone: host.timeZone, locale: host.locale });
    expect(f.firefoxSpawn.mock.calls[0][2].env.TZ).toBe(host.timeZone);
    expect(f.geoDetect).not.toHaveBeenCalled();
    expect(f.persistDetection).not.toHaveBeenCalled();
    expect(f.audit.mock.calls.some(([event]) => event.action === "firefox-identity" && /source=host.*host fallback, proxy alignment unverified/.test(event.detail))).toBe(true);
    expect(currentMeta()).toMatchObject({ timezone: null, locale: null });
  });

  it.each(["failed", "throw", "invalid-zone", "offset-zone", "country-without-zone", "invalid-country"])("handles %s Geo per field without using persisted geo or claiming proxy alignment", async failure => {
    autoProxy();
    hostDefaults();
    f.cachedDetection.mockReturnValue({ success: true, timezone: "Pacific/Honolulu", countryCode: "US", detectedAt: 1 });
    let expectedTimezone = "Europe/Berlin", expectedLocale = "de-DE";
    if (failure === "failed") f.geoDetect.mockResolvedValue({ ...geo(), success: false, error: "controlled lookup failure" });
    if (failure === "throw") f.geoDetect.mockRejectedValue(new Error("controlled network failure"));
    if (failure === "invalid-zone" || failure === "offset-zone") {
      f.geoDetect.mockResolvedValue(geo(failure === "invalid-zone" ? "Mars/Invalid" : "+05:30", "JP"));
      expectedLocale = "ja-JP";
    }
    if (failure === "country-without-zone") { f.geoDetect.mockResolvedValue(geo("", "US")); expectedLocale = "en-US"; }
    if (failure === "invalid-country") { f.geoDetect.mockResolvedValue(geo("America/Toronto", "??")); expectedTimezone = "America/Toronto"; }
    await launchBrowser(dirId);
    expect(f.firefoxManaged.mock.calls[0][0]).toMatchObject({ timezone: expectedTimezone, locale: expectedLocale });
    expect(f.firefoxSpawn.mock.calls[0][2].env.TZ).toBe(expectedTimezone);
    expect(f.firefoxPrefs.mock.calls[0][1].locale).toBe(expectedLocale);
    expect(f.cachedDetection).not.toHaveBeenCalled();
    expect(f.audit.mock.calls.some(([event]) => event.action === "firefox-identity" && event.detail.includes("host fallback, proxy alignment unverified"))).toBe(true);
    expect(currentMeta()).toMatchObject({ timezone: null, locale: null });
    if (failure === "failed" || failure === "throw") {
      // An actually completed network failure is now an atomic negative sample;
      // a thrown/non-observation still cannot invent persistence authority.
      if (failure === "throw") expect(f.persistDetection).not.toHaveBeenCalled();
      else expect(f.persistDetection).toHaveBeenCalledWith("primary", proxy, expect.objectContaining({ success: false, source: "network", detectedAt: 1_800_000_000_000 }));
      expect(f.consistency.mock.calls[0][0].proxyGeo).toBeNull();
    } else if (failure !== "invalid-country") {
      expect(f.persistDetection.mock.calls[0][2].timezone).toBeNull();
    }
  });

  it("uses the health-selected fallback proxy, not the requested primary, for both routing and Geo", async () => {
    healthRouting();
    const fallback = { ...proxy, host: "fallback.example.test", port: 8181 };
    f.cfg.proxies.backup = fallback;
    f.cfg.proxyHealth.primary = { risk: "poor", consecutiveFailures: 1 };
    await launchBrowser(dirId);
    expect(f.proxy.mock.calls.length).toBeGreaterThan(1);
    for (const [requestedId, snapshot] of f.proxy.mock.calls) {
      expect(requestedId).toBe(dirId);
      expect(snapshot).not.toBe(f.cfg);
      expect(snapshot.proxies.backup).toEqual(fallback);
    }
    expect(f.geoDetect).toHaveBeenCalledExactlyOnceWith(fallback);
    expect(f.firefoxPrefs.mock.calls[0][1].proxy).toEqual(fallback);
    expect(f.persistDetection.mock.calls[0].slice(0, 2)).toEqual(["backup", fallback]);
  });

  it("persists the original cached observation time rather than renewing its age at launch", async () => {
    autoProxy();
    const result = { ...geo(), source: "cache" as const };
    const observedAt = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(observedAt + 5 * 60_000);
    f.geoDetect.mockResolvedValue(result);
    f.geoObservedAt.mockImplementation(value => value === result ? observedAt : null);
    const owned = await launchOwned();
    expect(f.geoObservedAt).toHaveBeenCalledExactlyOnceWith(result);
    expect(f.persistDetection.mock.calls[0][2]).toMatchObject({ detectedAt: observedAt, source: "cache", observationId: result.observationId });
    expect(f.persistDetection.mock.calls[0][2].detectedAt).not.toBe(Date.now());
    expect(f.captureDetectionTarget.mock.invocationCallOrder[0]).toBeLessThan(f.geoDetect.mock.invocationCallOrder[0]);
    expect(f.policies).toEqual(["prefer-cache"]);
    expect(await launchBrowser(dirId)).toMatchObject({ pid: owned.response.pid });
    owned.unchanged();
  });

  it.each(["chromium", "firefox"] as const)("captures %s proxy authority before await and preserves original startup cache metadata", async engine => {
    autoProxy(); currentMeta().engine = engine;
    const result = { ...geo(), observedAt: 1_800_000_000_000, source: "cache" as const, observationId: "synthetic-cached-startup" };
    vi.spyOn(Date, "now").mockReturnValue(result.observedAt + 9 * 60_000);
    f.geoDetect.mockImplementation(async () => {
      expect(f.captureDetectionTarget).toHaveBeenCalledExactlyOnceWith("primary", proxy);
      await Promise.resolve();
      return result;
    });
    await launchBrowser(dirId);
    expect(f.captureDetectionTarget.mock.invocationCallOrder[0]).toBeLessThan(f.geoDetect.mock.invocationCallOrder[0]);
    expect(f.policies).toEqual(["prefer-cache"]);
    expect(f.commitObservation).toHaveBeenCalledExactlyOnceWith(f.captureDetectionTarget.mock.results[0].value, result);
    expect(f.persistDetection.mock.calls[0][2]).toMatchObject({ source: "cache", detectedAt: result.observedAt, observationId: result.observationId });
    expect(f.persistDetection.mock.calls[0][2].detectedAt).not.toBe(Date.now());
  });

  it.each(["chromium", "firefox"] as const)("does not invent a persistence stamp for unknown %s startup results", async engine => {
    autoProxy(); currentMeta().engine = engine;
    f.geoDetect.mockResolvedValue({ ...geo(), observedAt: null, source: "unknown", observationId: null });
    f.geoObservedAt.mockReturnValue(null);
    await launchBrowser(dirId);
    expect(f.persistDetection).not.toHaveBeenCalled(); expect(f.commitObservation).not.toHaveBeenCalled();
  });

  it("uses an unobserved success as identity input without inventing a fresh persistence timestamp", async () => {
    autoProxy();
    f.geoDetect.mockResolvedValue({ ...geo(), observedAt: null, source: "unknown", observationId: null });
    f.geoObservedAt.mockReturnValue(null);
    await launchBrowser(dirId);
    expect(f.firefoxManaged.mock.calls[0][0]).toMatchObject({ timezone: "America/Toronto", locale: "en-CA" });
    expect(f.persistDetection).not.toHaveBeenCalled();
  });

  it("reuses the same semantic Auto result despite changed detection timing and diagnostics", async () => {
    autoProxy();
    const owned = await launchOwned();
    f.geoDetect.mockResolvedValue({ ...geo(), detectedAt: Date.now() + 60000, latencyMs: 99, provider: "other-mock", exitIp: "192.0.2.41" });
    expect(await launchBrowser(dirId)).toMatchObject({ pid: owned.response.pid });
    expect(f.geoDetect).toHaveBeenCalledTimes(2);
    owned.unchanged();
  });

  it.each(["timezone", "locale"] as const)("refuses changed effective %s without respawn, preference writes or preload replacement", async field => {
    autoProxy();
    const owned = await launchOwned();
    f.geoDetect.mockResolvedValue(field === "timezone" ? geo("America/Vancouver", "CA") : geo("America/Toronto", "US"));
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    expect(runningProcesses.get(dirId)).toBe(owned.entry);
    owned.unchanged();
  });

  it.each(["timezone", "locale"] as const)("refuses a changed direct host Auto %s without changing the running instance", async field => {
    autoProxy();
    currentMeta().proxyMode = "none";
    const host = hostDefaults();
    const owned = await launchOwned();
    if (field === "timezone") host.timeZone = "Europe/Paris";
    else host.locale = "fr-FR";
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    expect(f.geoDetect).not.toHaveBeenCalled();
    owned.unchanged();
  });

  it.each(["managed", "off"] as const)("binds the actual fallback route even with all %s fields manual or dormant", async mode => {
    autoProxy();
    Object.assign(currentMeta(), { fingerprintMode: mode, timezone: "UTC", locale: "en-US" });
    const fallback = { ...proxy, host: "fallback.example.test" };
    f.cfg.proxies.primary = { ...proxy, fallbacks: ["backup"] };
    f.cfg.proxies.backup = fallback;
    const owned = await launchOwned();
    f.proxy.mockReturnValue({ mode: "named", name: "backup", config: fallback, rotatedFrom: "primary", rotationReason: "new fixture health" });
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    expect(f.geoDetect).not.toHaveBeenCalled();
    owned.unchanged();
  });

  it("rejects a changed default proxy with the cheap request hash before resolving Geo", async () => {
    autoProxy();
    currentMeta().proxyMode = "default";
    f.cfg.defaultProxy = "primary";
    f.cfg.proxies.backup = { ...proxy, host: "backup.example.test" };
    const owned = await launchOwned();
    f.cfg.defaultProxy = "backup";
    f.geoDetect.mockClear(); f.proxy.mockClear();
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    expect(f.proxy).not.toHaveBeenCalled();
    expect(f.geoDetect).not.toHaveBeenCalled();
    owned.unchanged();
  });

  it.each(["seed", "binary", "prefs", "closed", "unregistered", "sandbox"])("preserves cheap %s refusal before Auto resolution on reuse", async refusal => {
    autoProxy();
    const owned = await launchOwned();
    if (refusal === "seed") currentMeta().fingerprintSeed++;
    if (refusal === "binary") f.firefoxIdentity.mockResolvedValue("changed-binary");
    if (refusal === "prefs") f.fs.readFileSync.mockReturnValue("changed prefs");
    if (refusal === "closed") owned.entry.bidiConn!.closed = true;
    if (refusal === "unregistered") f.bidiSessions.delete(port);
    if (refusal === "sandbox") vi.stubEnv("MOZ_DISABLE_CONTENT_SANDBOX", "0");
    f.geoDetect.mockClear(); f.proxy.mockClear();
    await expect(launchBrowser(dirId)).rejects.toThrow(refusal === "sandbox" ? /MOZ_DISABLE_CONTENT_SANDBOX/ : /restart/i);
    expect(f.proxy).not.toHaveBeenCalled();
    expect(f.geoDetect).not.toHaveBeenCalled();
    owned.unchanged();
  });

  it("refuses unsupported native-only mode before resolving a proxy or Auto identity", async () => {
    autoProxy();
    f.nativeRequested = true;
    await expect(launchBrowser(dirId)).rejects.toThrow(/lacks the binary-attested/);
    expect(f.proxy).not.toHaveBeenCalled();
    expect(f.geoDetect).not.toHaveBeenCalled();
    expect(f.firefoxPrefs).not.toHaveBeenCalled();
    expect(f.firefoxSpawn).not.toHaveBeenCalled();
  });

  it.each(["fresh", "reuse"] as const)("rejects a request changed while awaiting %s Auto Geo without a new spawn or preference writes", async route => {
    autoProxy();
    const owned = route === "reuse" ? await launchOwned() : null;
    let resume!: (value: ReturnType<typeof geo>) => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.geoDetect.mockImplementation(() => { entered(); return new Promise(resolve => { resume = resolve; }); });
    const launching = launchBrowser(dirId).then(() => null, error => error);
    await ready;
    currentMeta().locale = "fr-FR";
    resume(geo());
    expect(await launching).toMatchObject({ code: "restart-required" });
    if (owned) owned.unchanged();
    else {
      expect(f.firefoxPrefs).not.toHaveBeenCalled();
      expect(f.firefoxSpawn).not.toHaveBeenCalled();
      expect(f.persistDetection).not.toHaveBeenCalled();
    }
  });

  it.each((["fresh-probe", "fresh-geo", "fresh-final-files", "reuse-bidi", "reuse-geo", "reuse-final-files"] as const)
    .flatMap(boundary => [[boundary, "route"], [boundary, "metadata"]] as const))(
    "revalidates health-selected route after %s during a %s update", async (boundary, change) => {
      healthRouting();
      const owned = boundary.startsWith("reuse") ? await launchOwned() : null;
      const gate = pause<any>();
      f.geoDetect.mockClear();
      if (boundary === "fresh-probe") f.proxyProbe.mockImplementation(() => gate.wait());
      if (boundary === "reuse-bidi") owned!.entry.bidiConn!.send = vi.fn(() => gate.wait());
      if (boundary.endsWith("-geo")) f.geoDetect.mockImplementation(() => gate.wait());
      if (boundary.endsWith("-final-files")) {
        let suspendFiles = false;
        f.geoDetect.mockImplementation(async () => { suspendFiles = true; return geo(); });
        f.firefoxIdentity.mockImplementation(async () => {
          if (suspendFiles) { suspendFiles = false; return gate.wait(); }
          return "unit-launcher-and-XUL-identity";
        });
      }
      const launching = launchBrowser(dirId).then(result => ({ result, error: null }), error => ({ result: null, error }));
      await gate.ready;
      f.cfg.proxyHealth.primary = { ...f.cfg.proxyHealth.primary,
        risk: change === "route" ? "poor" : "good", consecutiveFailures: change === "route" ? 1 : 0,
        lastCheckedAt: 200, checks: 99 };
      gate.resume(boundary === "fresh-probe" ? true : boundary === "reuse-bidi" ? { contexts: [{ context: "unit-context" }] }
        : boundary.endsWith("-final-files") ? "unit-launcher-and-XUL-identity" : geo());
      const outcome = await launching;
      if (change === "route") {
        expect(outcome.error).toMatchObject({ code: "restart-required" });
        expect(runningProcesses.get(dirId)).toBe(owned?.entry);
        if (!owned) {
          expect(f.firefoxPrefs).not.toHaveBeenCalled();
          expect(f.firefoxSpawn).not.toHaveBeenCalled();
          expect(f.persistDetection).not.toHaveBeenCalled();
          for (const writer of [f.fs.mkdirSync, f.fs.writeFileSync, f.fs.openSync, f.fs.writeSync, f.fs.renameSync]) expect(writer).not.toHaveBeenCalled();
        }
        if (boundary === "fresh-probe" || boundary === "reuse-bidi") expect(f.geoDetect).not.toHaveBeenCalled();
      } else {
        expect(outcome.error).toBeNull();
        expect(outcome.result).toMatchObject({ pid: 5101, cdpPort: port });
      }
      if (change === "route") expect(f.proxy.mock.calls.some(([, snapshot]) => snapshot.proxyHealth.primary.lastCheckedAt === 200)).toBe(true);
      if (owned) owned.unchanged();
    },
  );

  it.each(["closed", "unregistered", "prefs", "binary"])("rejects %s drift during Auto resolution without touching the owned instance", async change => {
    autoProxy();
    const owned = await launchOwned();
    f.geoDetect.mockImplementation(async () => {
      if (change === "closed") owned.entry.bidiConn!.closed = true;
      if (change === "unregistered") f.bidiSessions.delete(port);
      if (change === "prefs") f.fs.readFileSync.mockReturnValue("changed during Geo");
      if (change === "binary") f.firefoxIdentity.mockResolvedValue("changed during Geo");
      return geo();
    });
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    owned.unchanged();
  });
});

describe("actual Firefox queued-Cookie launch evidence", () => {
  function setupQueue() {
    currentMeta().engine = "firefox"; currentMeta().fingerprintMode = "off";
    f.firefoxBinary.mockResolvedValue("/virtual/firefox-bin");
    f.queuedCookies = ["first", "second"].map((name) => ({ domain: "example.test", name, value: "synthetic-unit-cookie", path: "/", secure: false, httpOnly: false, expires: null, sameSite: 1 }));
  }

  it.each([0, 1])("reports %i/2 and the retained queue as incomplete, not successful identity restoration", async (applied) => {
    setupQueue(); f.firefoxCookieApply.mockResolvedValue(applied);
    const result = await launchBrowser(dirId);
    expect(result).toMatchObject({ pid: 5101, cdpPort: port, cookieCheck: { checked: true, applied, pending: 2, error: "COOKIE_IMPORT_INCOMPLETE" } });
    expect(f.firefoxCookieApply).toHaveBeenCalledExactlyOnceWith(dirId, expect.objectContaining({ port, isCurrent: expect.any(Function) }));
    const target = f.firefoxCookieApply.mock.calls[0][1];
    expect(target.isCurrent()).toBe(true);
    const entry = runningProcesses.get(dirId)!;
    runningProcesses.set(dirId, { ...entry, process: {} }); expect(target.isCurrent()).toBe(false);
    runningProcesses.set(dirId, { ...entry, bidiConn: { ...entry.bidiConn! } }); expect(target.isCurrent()).toBe(false);
    runningProcesses.set(dirId, entry);
    expect(f.bidiConnect).toHaveBeenCalledOnce(); expect(entry.bidiConn!.closed).toBe(false);
  });

  it("reports complete application only after rereading a consumed queue", async () => {
    setupQueue(); f.firefoxCookieApply.mockImplementation(async () => { f.queuedCookies = []; return 2; });
    const result = await launchBrowser(dirId);
    expect(result).toMatchObject({ cookieCheck: { checked: true, applied: 2, pending: 0 } });
    expect(result.cookieCheck?.error).toBeUndefined();
  });

  it.each(["connection", "queue"] as const)("surfaces a redacted %s error while leaving the launched session open", async (failure) => {
    setupQueue();
    if (failure === "connection") f.firefoxCookieApply.mockRejectedValue(new Error("synthetic-cookie-error-canary"));
    else f.cookieReadError = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await launchBrowser(dirId);
    expect(result).toMatchObject({ cookieCheck: { checked: true, applied: 0, error: "COOKIE_IMPORT_UNAVAILABLE" } });
    if (failure === "connection") expect(result.cookieCheck?.pending).toBe(2);
    else expect(f.firefoxCookieApply).not.toHaveBeenCalled();
    expect(warning.mock.calls.flat().join(" ")).not.toContain("canary");
    expect(runningProcesses.get(dirId)?.bidiConn?.closed).toBe(false);
  });

  it.each(["exitCode", "signalCode", "killed", "pid"] as const)("pins queue application to a live child and notices changed %s", async (field) => {
    setupQueue(); const observed: boolean[] = [];
    f.firefoxCookieApply.mockImplementation(async (_id, target) => {
      const child = runningProcesses.get(dirId)!.process, original = child[field];
      observed.push(target.isCurrent());
      child[field] = field === "exitCode" ? 0 : field === "signalCode" ? "SIGTERM" : field === "killed" ? true : 5102;
      observed.push(target.isCurrent()); child[field] = original; return 0;
    });
    await launchBrowser(dirId); expect(observed).toEqual([true, false]);
  });
});

describe("owned Firefox startup evidence and live session reuse", () => {
  async function started(mode: "managed" | "off" = "managed", options?: { headless?: boolean }) {
    currentMeta().engine = "firefox";
    currentMeta().fingerprintMode = mode;
    f.firefoxBinary.mockResolvedValue("/virtual/firefox-bin");
    const response = await launchBrowser(dirId, options);
    const entry = runningProcesses.get(dirId)!;
    f.lines = [`${response.pid} /virtual/firefox-bin ${f.firefoxSpawn.mock.calls[0][1].join(" ")}`];
    const connection = f.bidiSessions.get(port);
    vi.clearAllMocks();
    return { entry, connection, response };
  }

  it.each(["managed", "off"] as const)("reuses a verified same-request owned %s process without a new preload or writes", async (mode) => {
    const { response, connection } = await started(mode);
    expect(await launchBrowser(dirId)).toMatchObject({ pid: response.pid, cdpPort: port });
    expect(connection.send).toHaveBeenCalledExactlyOnceWith("browsingContext.getTree", {}, 1500);
    noLaunchEffects();
  });

  it.each(["managed", "off"] as const)("reuses an unchanged Windows %s launch with real headless/app URL arguments", async (mode) => {
    currentMeta().platform = "windows";
    currentMeta().appUrl = "https://example.test/app";
    const options = { headless: true };
    const { response, connection, entry } = await started(mode, options);
    expect(entry.process.spawnargs).toContain("-headless");
    expect(entry.process.spawnargs).toContain(currentMeta().appUrl);
    expect(entry.process.spawnargs).not.toContain("-new-instance");
    expect(await launchBrowser(dirId, options)).toMatchObject({ pid: response.pid, cdpPort: port });
    expect(connection.send).toHaveBeenCalledExactlyOnceWith("browsingContext.getTree", {}, 1500);
    expect(entry.process.kill).not.toHaveBeenCalled();
    noLaunchEffects();
  });

  it.each(["headless", "appUrl"])("reuses an unchanged Windows off launch with only %s", async (variant) => {
    currentMeta().platform = "windows";
    if (variant === "appUrl") currentMeta().appUrl = "https://example.test/app";
    const options = { headless: variant === "headless" };
    const { response, entry } = await started("off", options);
    expect(await launchBrowser(dirId, options)).toMatchObject({ pid: response.pid, cdpPort: port });
    expect(entry.process.kill).not.toHaveBeenCalled();
    noLaunchEffects();
  });

  it.each([
    '--remote-debugging-port "9222 https://example.test/"',
    '--remote-debugging-port 9222junk https://example.test/',
    '--remote-debugging-port 9222 https://example.test/ --remote-debugging-port 9222',
    '--remote-debugging-port 9222 https://example.test/ --remote-debugging-port',
  ])("refuses malformed or duplicate Firefox port evidence without changing ownership: %s", async (portArgs) => {
    const { entry } = await started("off");
    f.lines = [`${entry.pid} /virtual/firefox-bin -profile ${profileDir} ${portArgs} -no-remote`];
    await blocked("restart-required");
    expect(runningProcesses.get(dirId)).toBe(entry);
    expect(entry.process.kill).not.toHaveBeenCalled();
  });

  it.each(["seed", "mode", "proxy", "binary", "prefs", "closed", "unregistered", "bidi-error", "stopping", "argv", "pid", "selection-unavailable"])(
    "rejects %s drift without stopping or replacing the owned Firefox", async (change) => {
      const { entry, connection } = await started();
      if (change === "seed") currentMeta().fingerprintSeed++;
      if (change === "mode") currentMeta().fingerprintMode = "off";
      if (change === "proxy") { currentMeta().proxyMode = "default"; f.cfg.defaultProxy = "changed"; f.cfg.proxies.changed = { type: "http", host: "proxy.example.test", port: 8080 }; }
      if (change === "binary") f.firefoxIdentity.mockResolvedValue("different-XUL");
      if (change === "prefs") f.fs.readFileSync.mockReturnValue("externally changed preferences");
      if (change === "closed") connection.closed = true;
      if (change === "unregistered") f.bidiSessions.delete(port);
      if (change === "bidi-error") connection.send.mockRejectedValue(new Error("controlled protocol error"));
      if (change === "stopping") entry.stopping = true;
      if (change === "argv") entry.process.spawnargs.push("-headless");
      if (change === "pid") f.lines = [];
      if (change === "selection-unavailable") f.firefoxIdentity.mockResolvedValue(null);
      await blocked("restart-required");
      expect(runningProcesses.get(dirId)).toBe(entry);
      expect(entry.process.kill).not.toHaveBeenCalled();
    },
  );

  it("does not collapse distinct opaque preference bytes while verifying reuse", async () => {
    let bytes = Buffer.concat([Buffer.from('user_pref("custom.opaque", "'), Buffer.from([0xff]), Buffer.from('");\n')]);
    f.fs.readFileSync.mockImplementation((_file, encoding) => encoding ? bytes.toString(encoding) : bytes);
    const { entry } = await started("off");
    bytes = Buffer.concat([Buffer.from('user_pref("custom.opaque", "'), Buffer.from([0xfe]), Buffer.from('");\n')]);
    await blocked("restart-required");
    expect(entry.process.kill).not.toHaveBeenCalled();
  });

  it("does not reapply inactive identity fields when reusing off", async () => {
    const { response } = await started("off");
    currentMeta().fingerprintSeed++;
    currentMeta().locale = "fr-FR";
    currentMeta().timezone = "Europe/Paris";
    currentMeta().gpuRenderer = "inactive";
    expect(await launchBrowser(dirId)).toMatchObject({ pid: response.pid });
    noLaunchEffects();
  });

  it("rejects a request changed during the awaited BiDi health check", async () => {
    const { connection } = await started();
    connection.send.mockImplementation(async () => {
      currentMeta().fingerprintSeed++;
      return { contexts: [{ context: "unit-context" }] };
    });
    await blocked("restart-required");
  });

  it.each(["unregistered", "replaced-session", "prefs", "binary", "binary-selection"])("rejects %s changed during the awaited BiDi check", async (change) => {
    const { connection, entry } = await started();
    connection.send.mockImplementation(async () => {
      if (change === "unregistered") f.bidiSessions.delete(port);
      if (change === "replaced-session") entry.bidiConn = { ...connection };
      if (change === "prefs") f.fs.readFileSync.mockReturnValue("changed during health check");
      if (change === "binary") f.firefoxIdentity.mockResolvedValue("changed during health check");
      if (change === "binary-selection") f.firefoxBinary.mockResolvedValue("/virtual/replacement-firefox");
      return { contexts: [{ context: "unit-context" }] };
    });
    await blocked("restart-required");
    expect(entry.process.kill).not.toHaveBeenCalled();
  });

  it("terminates only the newly spawned Firefox if intent changes before session setup", async () => {
    currentMeta().engine = "firefox";
    f.firefoxBinary.mockResolvedValue("/virtual/firefox-bin");
    const original = f.firefoxSpawn.getMockImplementation()!;
    f.firefoxSpawn.mockImplementation(async (...args) => {
      const spawned = await original(...args);
      currentMeta().fingerprintSeed++;
      return spawned;
    });
    await expect(launchBrowser(dirId)).rejects.toMatchObject({ code: "restart-required" });
    expect(f.firefoxSpawn).toHaveBeenCalledOnce();
    expect(f.bidiConnect).not.toHaveBeenCalled();
    expect(f.deadPids.has(5101)).toBe(true);
    expect(runningProcesses.has(dirId)).toBe(false);
  });
});
