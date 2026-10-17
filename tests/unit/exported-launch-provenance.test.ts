import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserProfileMeta, ProxyConfig } from "../../src/main/types.js";

// Every external effect is replaced before importing the ACTUAL exported
// launcher. Synthetic PIDs are only ever passed to a mocked process.kill.
const f = vi.hoisted(() => ({
  cfg: {} as any, host: "macos" as "macos" | "windows" | null, lines: [] as string[],
  inspect: vi.fn(), legacy: vi.fn(), proxy: vi.fn(), audit: vi.fn(), release: vi.fn(), lock: vi.fn(),
  spawn: vi.fn(), version: vi.fn(), managedBinary: vi.fn(), fetch: vi.fn(), netCreate: vi.fn(), kill: vi.fn(),
  proxyProbe: vi.fn(), proxyUrl: vi.fn(), diagnostics: vi.fn(), gpuContext: vi.fn(),
  secrets: vi.fn(() => { throw new Error("No secret access allowed"); }), saveConfig: vi.fn(), transact: vi.fn(),
  fs: {
    existsSync: vi.fn(), mkdirSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(),
    openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn(), renameSync: vi.fn(), unlinkSync: vi.fn(),
    rmSync: vi.fn(), realpathSync: vi.fn(), lstatSync: vi.fn(), statSync: vi.fn(),
  },
  firefoxBinary: vi.fn(), firefoxSpawn: vi.fn(), firefoxPrefs: vi.fn(),
  firefoxIdentity: vi.fn(), firefoxManaged: vi.fn(), bidiConnect: vi.fn(), bidiSessions: new Map<number, any>(),
  deadPids: new Set<number>(), envRisk: vi.fn(),
}));

vi.mock("node:fs", () => f.fs);
vi.mock("node:net", () => ({ createServer: f.netCreate }));
vi.mock("node:child_process", () => ({
  spawn: f.spawn,
  execSync: vi.fn(() => { throw new Error("No real process commands"); }),
  execFileSync: vi.fn(() => { throw new Error("No real process enumeration"); }),
  exec: vi.fn(() => { throw new Error("No real process enumeration"); }),
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] }, screen: { getPrimaryDisplay: () => ({ scaleFactor: 2 }) } }));
vi.mock("../../src/main/services/browser-platform-policy.js", () => ({ getHostBrowserPlatform: () => f.host }));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => f.cfg, getProfilesDir: () => "/virtual/profiles", getAppDataDir: () => "/virtual/state",
  saveConfig: f.saveConfig,
  resolveProfileProxy: vi.fn(), resolveProfileProxySecret: f.proxy, getProxyDetection: vi.fn(() => null),
  setProxyDetectionIfCurrent: vi.fn(() => { throw new Error("No proxy cache writes allowed"); }),
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
vi.mock("../../src/main/services/secrets.js", () => ({ decryptSecretOr: f.secrets }));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: f.audit }));
vi.mock("../../src/main/services/consistency-check.js", () => ({ checkProfileConsistency: () => ({ ok: true, warnings: [], blockers: [] }) }));
vi.mock("../../src/main/services/drm.js", () => ({ drmLaunchArgs: () => [] }));
vi.mock("../../src/main/services/extension-repository.js", () => ({ getEnabledRepositoryExtensionPaths: () => [] }));
vi.mock("../../src/main/services/team.js", () => ({ requireProfileMutation: () => ({ ok: true }) }));
vi.mock("../../src/main/services/config/store.js", () => ({ transact: f.transact }));
vi.mock("../../src/main/services/event-bus.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../../src/main/services/cdp-cookie-service.js", () => ({ cdpCookieService: { applyQueuedImports: vi.fn(async () => 0) } }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ firefoxCookieService: { applyQueuedImports: vi.fn(async () => 0) } }));
vi.mock("../../src/main/services/fingerprint-baseline.js", () => ({
  captureFingerprint: vi.fn(), diffFingerprints: () => [], hasRiskyDrift: () => false,
  summarizeDrift: () => "", checkPersonaConsistency: () => ({ ok: true, mismatches: [] }), mismatchesAsDrift: () => [],
}));
vi.mock("../../src/main/services/environment-risk.js", () => ({
  checkEnvironmentRisk: () => ({ ok: true, findings: [] }), checkEnvironmentRiskRuntime: f.envRisk,
  shouldBlockEnvironmentRisk: () => false, summarizeEnvFindings: () => "",
}));
vi.mock("../../src/main/services/authenticated-socks-bridge.js", () => ({ startAuthenticatedSocksBridge: vi.fn(() => { throw new Error("No bridge allowed"); }) }));
vi.mock("../../src/main/services/masque-socks-bridge.js", () => ({ startMasqueSocksBridge: vi.fn(() => { throw new Error("No bridge allowed"); }) }));
vi.mock("../../src/main/services/proxy-detector.js", () => ({
  buildChromiumProxyUrl: f.proxyUrl, probeProxyPort: f.proxyProbe,
  proxyDetector: { detect: vi.fn(() => { throw new Error("No proxy/network probe allowed"); }) },
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
  firefoxNativeModeRequested: () => false, readFirefoxNativeCapabilityReportAsync: async () => null,
  getFirefoxNativeSelectionIdentityAsync: f.firefoxIdentity,
  FIREFOX_NATIVE_CONFIG_CAPABILITIES: ["config-v1"], FIREFOX_NATIVE_PARITY_CAPABILITIES: ["parity-v1"],
}));
vi.mock("../../src/main/services/bidi-client.js", () => ({
  connectBidi: f.bidiConnect,
  bidiAddPreloadScript: async () => "unit-preload", bidiCreateContext: async () => "unit-context", bidiCloseContext: vi.fn(), bidiEvaluateInContext: async () => ({}),
  registerFirefoxSession: (port: number, conn: any) => f.bidiSessions.set(port, conn),
  dropFirefoxSession: (port: number) => f.bidiSessions.delete(port),
  getRegisteredFirefoxSession: (port: number) => f.bidiSessions.get(port),
}));

import { createBrowserProfile, launchBrowser } from "../../src/main/services/browser-manager.js";
import { LaunchBlockedError } from "../../src/main/services/browser/launch-guards.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";
import {
  assertChromiumLaunchProvenance, chromiumLaunchRequestHash, chromiumLaunchStampArg, stampChromiumLaunch,
  CHROMIUM_LAUNCH_STAMP_SWITCH,
} from "../../src/main/services/browser/launch-provenance.js";
import { buildBrowserFingerprintArg, buildBrowserFingerprintConfig, type ChromiumGpuContext } from "../../src/main/services/browser-fingerprint-config.js";
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
  const native = buildBrowserFingerprintConfig(profile, "150.0.7800.1", null, "chromium", gpuContext);
  const args = [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, ...(mode === "managed" ? [
    `--fingerprint=${profile.fingerprintSeed}`, `--fingerprint-platform=${profile.platform}`,
    buildBrowserFingerprintArg(profile, "150.0.7800.1", undefined, null, "chromium", gpuContext), `--user-agent=${native.userAgent}`,
  ] : [])];
  const provenance = stampChromiumLaunch(args, requestHash, mode);
  args.push(chromiumLaunchStampArg(provenance));
  const entry = { pid, process: null, port, lastActivityAt: 123, engine: "chromium" as const, launchProvenance: provenance };
  return { args, provenance, entry, line: `${pid} ${bin} ${args.join(" ")}` };
}

function noLaunchEffects() {
  expect(f.proxy).not.toHaveBeenCalled();
  expect(f.secrets).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.firefoxSpawn).not.toHaveBeenCalled();
  expect(f.netCreate).not.toHaveBeenCalled();
  expect(f.diagnostics).not.toHaveBeenCalled();
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
  f.deadPids.clear(); f.bidiSessions.clear();
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
  vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_APP_DATA_DIR", undefined);
  vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_FILE", undefined);
  vi.stubEnv("AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE", undefined);
  f.diagnostics.mockReset().mockReturnValue([]);
  f.gpuContext.mockReset().mockReturnValue({ hostPlatform: "darwin", hostArchitecture: "arm64", kernelArchitecture: null });
  f.proxy.mockReturnValue({ mode: "none", name: null, config: null });
  f.proxyProbe.mockImplementation(() => { throw new Error("No proxy/network probe allowed"); });
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
    once: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => ready(),
    address: () => ({ port }), close: (closed: () => void) => closed(),
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
    if (kind === "malformed-stamp") line = line.replace(/v1\.[a-f0-9]+\.[a-f0-9]+$/, "v1.invalid.invalid");
    if (kind === "unknown-version") line = line.replace(CHROMIUM_LAUNCH_STAMP_SWITCH + "v1.", CHROMIUM_LAUNCH_STAMP_SWITCH + "v2.");
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
    for (const mock of [f.proxy, f.spawn, f.netCreate, f.diagnostics, ...Object.values(f.fs)]) mock.mockClear();
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
    for (const mock of [f.proxy, f.spawn, f.netCreate, f.diagnostics, ...Object.values(f.fs)]) mock.mockClear();
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
    for (const mock of [f.proxy, f.spawn, f.netCreate, f.diagnostics, ...Object.values(f.fs)]) mock.mockClear();
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
