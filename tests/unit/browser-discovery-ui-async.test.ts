import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FirefoxStatus } from "../../src/main/services/browser-engine.js";
import type { ManagedChromiumBinary } from "../../src/main/services/native-chromium-manager.js";

// Never bind Electron/config to the real user-data tree. The offline wrapper
// supplies this private TMPDIR, and this suite owns only its exclusive child.
const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const privateTmp = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(privateTmp, "browser-discovery-ui-async-")));
  const identity = fs.lstatSync(root);
  const marker = path.join(root, ".fixture-owner");
  const owner = JSON.stringify({ role: "browser-discovery-ui-async", root, dev: identity.dev, ino: identity.ino });
  fs.writeFileSync(marker, owner, { flag: "wx", mode: 0o600 });
  const markerIdentity = fs.lstatSync(marker);
  let caseRoot = root;
  function assertOwned(): void {
    const st = fs.lstatSync(root);
    const mark = fs.lstatSync(marker);
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino ||
        fs.realpathSync(root) !== root || !mark.isFile() || mark.isSymbolicLink() || mark.nlink !== 1 ||
        mark.dev !== markerIdentity.dev || mark.ino !== markerIdentity.ino || fs.readFileSync(marker, "utf8") !== owner) {
      throw new Error("Refusing unowned fixture access: " + root);
    }
  }
  function assertTree(file: string): void {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1 || (st.mode & 0o111) !== 0))) {
      throw new Error("Refusing non-physical or executable fixture: " + file);
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(file)) assertTree(path.join(file, name));
  }
  function clear(): void {
    assertOwned();
    const names = fs.readdirSync(root).filter(name => name !== ".fixture-owner");
    for (const name of names) {
      if (name !== "config.json" && name !== "cases") throw new Error("Unexpected fixture role: " + name);
      assertTree(path.join(root, name));
    }
    for (const name of names) fs.rmSync(path.join(root, name), { recursive: true });
  }
  function readConfig(): Record<string, any> {
    assertOwned();
    return JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  }
  function writeConfig(config: Record<string, any>): void {
    assertOwned();
    const file = path.join(root, "config.json");
    if (fs.existsSync(file)) assertTree(file);
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  }
  return {
    root, readConfig, writeConfig, clear,
    get caseRoot() { return caseRoot; },
    begin(serial: number) {
      assertOwned();
      caseRoot = path.join(root, "cases", `case-${serial}`);
      for (const name of ["profiles", "chromium-cache", "firefox-cache", "binaries", "bundled"]) {
        fs.mkdirSync(path.join(caseRoot, name), { recursive: true, mode: 0o700 });
      }
      return caseRoot;
    },
    assertFile(file: string) {
      assertOwned();
      if (!path.resolve(file).startsWith(caseRoot + path.sep)) throw new Error("Not an owned fixture file: " + file);
      assertTree(file);
      if (!fs.lstatSync(file).isFile()) throw new Error("Not a fixture regular file: " + file);
    },
    dispose() { clear(); fs.unlinkSync(marker); fs.rmdirSync(root); },
  };
});

const mocks = vi.hoisted(() => {
  const forbidden = (role: string) => vi.fn(() => { throw new Error("Forbidden real side effect: " + role); });
  return {
    forbidden,
    children: Object.fromEntries(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]
      .map(name => [name, forbidden("child_process." + name)])),
    net: forbidden("network/server"), fetch: forbidden("fetch"), readdirSync: vi.fn(),
    syncList: forbidden("synchronous Chromium discovery/extraction"),
    syncFind: forbidden("synchronous Chromium binary discovery"),
    syncFirefoxStatus: forbidden("synchronous Firefox status/version/capabilities"),
    syncFirefoxFind: forbidden("synchronous Firefox discovery/extraction"),
    syncFirefoxVersion: forbidden("synchronous Firefox version"),
    syncCapabilities: forbidden("synchronous Firefox capability probe"),
    chromiumList: vi.fn(), chromiumFind: vi.fn(), firefoxStatus: vi.fn(), firefoxFind: vi.fn(),
    firefoxVersion: vi.fn<(binary: string) => Promise<string | null>>(() => { throw new Error("Forbidden real side effect: Firefox launch version probe"); }),
    capabilities: forbidden("Firefox launch capability probe"),
    firefoxSpawn: forbidden("Firefox launch"), firefoxPrefs: forbidden("Firefox profile prefs write"),
    command: vi.fn(), processDiscovery: vi.fn(() => null),
    acquireRestoreLock: vi.fn(), releaseRestoreLock: vi.fn(),
    lockHeld: false,
    versions: new Map<string, string>(),
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => fixture.root },
  BrowserWindow: Object.assign(mocks.forbidden("GUI BrowserWindow"), { getAllWindows: () => [] }),
  screen: { getPrimaryDisplay: mocks.forbidden("GUI screen") },
}));
vi.mock("node:child_process", () => mocks.children);
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // Native ESM namespace properties are not configurable. This forwarding spy
  // observes production directory reads without replacing real fixture I/O.
  mocks.readdirSync.mockImplementation(actual.readdirSync);
  return { ...actual, readdirSync: mocks.readdirSync };
});
vi.mock("node:net", () => ({ createServer: mocks.net, createConnection: mocks.net, connect: mocks.net, Socket: mocks.net }));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => fixture.readConfig(),
  getAppDataDir: () => fixture.root,
  getProfilesDir: () => path.join(fixture.caseRoot, "profiles"),
  resolveProfileProxy: () => ({ mode: "none", name: null, config: null }),
  resolveProfileProxySecret: () => ({ mode: "none", name: null, config: null }),
  saveConfig: mocks.forbidden("production config write"),
  getProxyDetection: mocks.forbidden("proxy detection"),
  setProxyDetectionIfCurrent: mocks.forbidden("proxy detection write"),
  sanitizeAppUrl: mocks.forbidden("profile creation"),
  getProxyHealthEntry: mocks.forbidden("proxy health"),
  assertProfileWritable: mocks.forbidden("profile mutation"),
}));
vi.mock("../../src/main/services/native-chromium-manager.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/main/services/native-chromium-manager.js")>();
  return {
    ...actual,
    getManagedChromiumRoot: () => path.join(fixture.caseRoot, "chromium-cache"),
    listManagedChromiumBinaries: mocks.syncList,
    findManagedChromiumBinary: mocks.syncFind,
    listManagedChromiumBinariesAsync: mocks.chromiumList,
    findManagedChromiumBinaryAsync: mocks.chromiumFind,
  };
});
vi.mock("../../src/main/services/native-firefox-manager.js", () => ({
  getManagedFirefoxRoot: () => path.join(fixture.caseRoot, "firefox-cache"),
  findManagedFirefoxBinary: mocks.forbidden("synchronous managed Firefox discovery"),
  findManagedFirefoxBinaryAsync: mocks.forbidden("unexpected managed Firefox discovery"),
}));
vi.mock("../../src/main/services/bundled-native-browsers.js", () => ({
  bundledBrowsersRoot: () => path.join(fixture.caseRoot, "bundled"),
  bundledChromiumBinaryPath: mocks.forbidden("synchronous Chromium extraction"),
  bundledFirefoxBinaryPath: mocks.forbidden("synchronous Firefox extraction"),
  bundledChromiumBinaryPathAsync: mocks.forbidden("unexpected Chromium extraction"),
  bundledFirefoxBinaryPathAsync: mocks.forbidden("unexpected Firefox extraction"),
  readBundledBrowsersManifest: mocks.forbidden("unexpected bundled manifest read"),
}));
vi.mock("../../src/main/services/firefox-native-capabilities.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/main/services/firefox-native-capabilities.js")>();
  return {
    FIREFOX_NATIVE_REQUIRED_SWITCH: "--agent-browser-native-required",
    FIREFOX_NATIVE_CONFIG_PREF: "agent_browser.fingerprint.config",
    FIREFOX_NATIVE_CONFIG_CAPABILITIES: ["config-v1", "native-required-v1", "snapshot-v1"],
    FIREFOX_NATIVE_PARITY_CAPABILITIES: ["fixture-parity-v1"],
    firefoxNativeModeRequested: () => false,
    readFirefoxNativeCapabilityReport: mocks.syncCapabilities,
    readFirefoxNativeCapabilityReportAsync: mocks.capabilities,
    getFirefoxNativeSelectionIdentityAsync: async (binary: string) => {
      fixture.assertFile(binary);
      fixture.assertFile(path.join(path.dirname(binary), process.platform === "darwin" ? "XUL" : process.platform === "win32" ? "xul.dll" : "libxul.so"));
      return actual.getFirefoxNativeSelectionIdentityAsync(binary);
    },
  };
});
vi.mock("../../src/main/services/browser-engine.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/main/services/browser-engine.js")>();
  return {
    ...actual,
    defaultFirefoxBinaryPaths: () => [], // Do not even stat system/browser paths.
    getFirefoxStatus: mocks.syncFirefoxStatus,
    getFirefoxStatusAsync: mocks.firefoxStatus,
    findFirefoxBinary: mocks.syncFirefoxFind,
    findFirefoxBinaryAsync: mocks.firefoxFind,
    detectFirefoxVersion: mocks.syncFirefoxVersion,
    detectFirefoxVersionAsync: mocks.firefoxVersion,
    spawnFirefoxWithDebugInfo: mocks.firefoxSpawn,
    writeFirefoxUserJs: mocks.firefoxPrefs,
  };
});
vi.mock("../../src/main/services/browser-command.js", () => ({ runBrowserCommand: mocks.command }));
vi.mock("../../src/main/services/process-discovery.js", () => ({
  findBrowserByProfileSync: mocks.processDiscovery,
  inspectBrowserLaunchesSync: (profileDir: string) => {
    if (!path.resolve(profileDir).startsWith(path.join(fixture.caseRoot, "profiles") + path.sep)) {
      throw new Error("Refusing process discovery outside the owned profile fixture");
    }
    return { available: true, candidates: [], tracked: null };
  },
  parseBrowserProcessLine: mocks.forbidden("unexpected process parsing"),
}));
vi.mock("../../src/main/services/profile-restore-lock.js", () => ({ acquireRestoreLock: mocks.acquireRestoreLock }));
// These are not part of discovery. Mock their modules, not the browser-manager
// functions under test, so no global helper can open SQLite or contact a service.
vi.mock("../../src/main/services/cdp-cookie-service.js", () => ({ cdpCookieService: {} }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ firefoxCookieService: {} }));
vi.mock("../../src/main/services/secrets.js", () => ({ decryptSecretOr: mocks.forbidden("secret store") }));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: mocks.forbidden("audit persistence") }));
vi.mock("../../src/main/services/drm.js", () => ({ drmLaunchArgs: mocks.forbidden("DRM discovery") }));
vi.mock("../../src/main/services/fingerprint-baseline.js", () => ({
  captureFingerprint: mocks.forbidden("fingerprint capture"), diffFingerprints: vi.fn(), hasRiskyDrift: vi.fn(),
  summarizeDrift: vi.fn(), checkPersonaConsistency: vi.fn(), mismatchesAsDrift: vi.fn(),
}));
vi.mock("../../src/main/services/environment-risk.js", () => ({
  checkEnvironmentRiskRuntime: mocks.forbidden("environment network probe"), shouldBlockEnvironmentRisk: vi.fn(), summarizeEnvFindings: vi.fn(),
}));
vi.mock("../../src/main/services/browser/launch-guards.js", async importOriginal => ({
  assertHostPlatformCompatible: (await importOriginal<typeof import("../../src/main/services/browser/launch-guards.js")>()).assertHostPlatformCompatible,
  runFingerprintDriftGuard: mocks.forbidden("launch drift guard"), runEnvironmentRiskGuard: mocks.forbidden("launch risk guard"),
  LaunchBlockedError: class LaunchBlockedError extends Error {},
}));
vi.mock("../../src/main/services/extension-repository.js", () => ({ getEnabledRepositoryExtensionPaths: mocks.forbidden("extension repository") }));
vi.mock("../../src/main/services/authenticated-socks-bridge.js", () => ({ startAuthenticatedSocksBridge: mocks.net }));
vi.mock("../../src/main/services/masque-socks-bridge.js", () => ({ startMasqueSocksBridge: mocks.net }));
vi.mock("../../src/main/services/proxy-detector.js", () => ({
  buildChromiumProxyUrl: mocks.forbidden("proxy launch"), proxyDetector: {}, probeProxyPort: mocks.net,
}));
vi.mock("../../src/main/services/proxy-health.js", () => ({ recordProxyRotation: mocks.forbidden("proxy health persistence") }));
vi.mock("../../src/main/services/team.js", () => ({ requireProfileMutation: mocks.forbidden("profile mutation RBAC") }));
vi.mock("../../src/main/services/config/store.js", () => ({ transact: mocks.forbidden("config transaction") }));
vi.mock("../../src/main/services/event-bus.js", () => ({ emitEvent: mocks.forbidden("launch event") }));
vi.mock("../../src/main/services/native-proxy-auth.js", () => ({
  LEGACY_NATIVE_PROXY_AUTH_SWITCH: "--fixture-legacy-proxy-auth", NATIVE_PROXY_AUTH_SWITCH: "--fixture-proxy-auth",
  NATIVE_SUPPRESS_GOOGLE_API_KEY_INFOBAR_SWITCH: "--fixture-infobar",
  nativeProxyAuthSwitch: vi.fn(), supportsAgentBrowserFingerprintConfig: vi.fn(), supportsGoogleApiKeyInfoBarSuppression: vi.fn(),
  supportsNativeProxyAuth: vi.fn(), supportsNativeQuicProxy: vi.fn(), writeNativeProxyAuthFile: mocks.forbidden("proxy auth write"),
}));
vi.mock("../../src/main/services/bidi-client.js", () => ({
  connectBidi: mocks.net, bidiAddPreloadScript: mocks.net, bidiCreateContext: mocks.net, bidiCloseContext: mocks.net,
  bidiEvaluateInContext: mocks.net, registerFirefoxSession: mocks.forbidden("Firefox session registration"),
  dropFirefoxSession: vi.fn(), getRegisteredFirefoxSession: vi.fn(),
}));

import {
  findRuntimeChromiumBinaryAsync,
  getEngineStatusAsync,
  getProfileRuntimeSnapshot,
  getRuntimeChromiumStatusAsync,
  launchBrowser,
  listBrowserProfiles,
  verifyRuntimeChromiumAsync,
} from "../../src/main/services/browser-manager.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";

const chromiumVersion = "150.0.7871.2";
const chromiumPin = "149.0.7000.8";
const firefoxVersion = "154.0.1";
const firefoxPin = "153.0";
let serial = 0;
let chromium: string;
let firefox: string;
let xul: string;
let firefoxResult: FirefoxStatus;
let operations: Promise<unknown>[];
let gates: Array<{ reject: (error: Error) => void }>;
let killSpy: ReturnType<typeof vi.spyOn>;
let expectedFirefoxVersionCalls: number;

function put(file: string, text = "owned non-executable fixture"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
  fixture.assertFile(file);
}
function replace(file: string, text: string): void {
  fixture.assertFile(file);
  fs.writeFileSync(file, text);
  fixture.assertFile(file);
  expect(fs.readFileSync(file, "utf8")).toBe(text);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  gates.push({ reject });
  return { promise, resolve, reject };
}
function watch<T>(promise: Promise<T>): Promise<T> {
  operations.push(promise);
  void promise.catch(() => undefined);
  return promise;
}
function selectChromium(binary: string): void {
  const config = fixture.readConfig();
  config.chromiumBin = binary;
  fixture.writeConfig(config);
  expect(fixture.readConfig().chromiumBin).toBe(binary);
}
function projection() {
  return listBrowserProfiles().map(({ dirId, name, browserVersion, version, engine, running, pid, cdpPort }) =>
    ({ dirId, name, browserVersion, version, engine, running, pid, cdpPort }));
}
function expectNoSynchronousDiscovery(): void {
  for (const mock of [mocks.syncList, mocks.syncFind, mocks.syncFirefoxStatus, mocks.syncFirefoxFind,
    mocks.syncFirefoxVersion, mocks.syncCapabilities, ...Object.values(mocks.children)]) {
    expect(mock).not.toHaveBeenCalled();
  }
}
async function until(predicate: () => boolean, phase: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  } while (Date.now() < deadline);
  throw new Error("Owned asynchronous fixture did not reach " + phase);
}
async function turn(): Promise<void> {
  // Both a real timer and the immediate queue must run while discovery stays pending.
  const events: string[] = [];
  await Promise.all([
    new Promise<void>(resolve => setTimeout(() => { events.push("timer"); resolve(); }, 0)),
    new Promise<void>(resolve => setImmediate(() => { events.push("immediate"); resolve(); })),
  ]);
  expect(events.sort()).toEqual(["immediate", "timer"]);
}
function expectEmptySnapshot(): void {
  expect(getProfileRuntimeSnapshot()).toEqual({
    chromiumPath: null, chromiumVersion: null, firefoxVersion: null, chromiumInstalled: null, pending: true,
  });
}
function expectFullSnapshot(chrome = chromiumVersion, ff = firefoxVersion): void {
  expect(getProfileRuntimeSnapshot()).toEqual({
    chromiumPath: chromium, chromiumVersion: chrome, firefoxVersion: ff, chromiumInstalled: true, pending: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.begin(++serial);
  operations = [];
  gates = [];
  expectedFirefoxVersionCalls = 0;
  runningProcesses.clear();
  for (const name of ["AGENT_BROWSER_CHROMIUM_BINARY_PATH", "CLOAKLITE_CHROMIUM_BINARY_PATH",
    "AGENT_BROWSER_FIREFOX_BINARY_PATH", "FIREFOX_BINARY_PATH", "AGENT_BROWSER_FIREFOX_NATIVE",
    "AGENT_BROWSER_BUNDLED_CACHE_DIR"]) vi.stubEnv(name, undefined);
  vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", path.join(fixture.caseRoot, "bundled"));
  vi.stubGlobal("fetch", mocks.fetch);
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("Forbidden actual process signaling"); });
  chromium = path.join(fixture.caseRoot, "binaries", "selected-chrome");
  firefox = path.join(fixture.caseRoot, "binaries", "selected-firefox");
  xul = path.join(path.dirname(firefox), process.platform === "darwin" ? "XUL" : process.platform === "win32" ? "xul.dll" : "libxul.so");
  put(chromium);
  put(firefox);
  put(xul, "owned XUL identity fixture");
  const profiles = {
    ab_chromium_pinned: { name: "Pinned Chromium", engine: "chromium", browserVersion: chromiumPin, fingerprintMode: "off", proxyMode: "none" },
    ab_chromium_auto: { name: "Auto Chromium", engine: "chromium", browserVersion: null, fingerprintMode: "off", proxyMode: "none" },
    ab_firefox_pinned: { name: "Pinned Firefox", engine: "firefox", browserVersion: firefoxPin, fingerprintMode: "off", proxyMode: "none" },
    ab_firefox_auto: { name: "Auto Firefox", engine: "firefox", browserVersion: null, fingerprintMode: "off", proxyMode: "none" },
  };
  fixture.writeConfig({ chromiumBin: chromium, browserProfiles: profiles, proxies: {}, defaultProxy: null });
  expect(fixture.readConfig().browserProfiles).toEqual(profiles);
  mocks.versions.clear();
  mocks.versions.set(chromium, chromiumVersion);
  mocks.chromiumList.mockReset().mockResolvedValue([]);
  mocks.chromiumFind.mockReset().mockResolvedValue(null);
  mocks.command.mockReset().mockImplementation(async (binary: string, args: string[], options: unknown) => {
    fixture.assertFile(binary);
    expect(args).toEqual(["--version"]);
    expect(options).toEqual({ timeout: 5000 });
    const version = mocks.versions.get(binary);
    if (!version) throw new Error("No mocked version for owned binary: " + binary);
    return { stdout: `Chromium ${version}\n`, stderr: "" };
  });
  firefoxResult = {
    engine: "firefox", installed: true, path: firefox, version: firefoxVersion,
    fingerprintParity: false, managedInjection: "prefs+bidi-preload", nativeConfig: false, nativeRequested: false,
    nativeCapabilities: [], sourceStamp: null, hint: "owned mocked Firefox status",
  };
  mocks.firefoxStatus.mockReset().mockImplementation(async () => ({ ...firefoxResult }));
  mocks.firefoxFind.mockReset().mockResolvedValue(null);
  mocks.lockHeld = false;
  mocks.releaseRestoreLock.mockReset().mockImplementation(() => {
    if (!mocks.lockHeld) throw new Error("Restore lock released more than once");
    mocks.lockHeld = false;
  });
  mocks.acquireRestoreLock.mockReset().mockImplementation(() => {
    if (mocks.lockHeld) throw new Error("Owned restore lock is already held");
    mocks.lockHeld = true;
    return mocks.releaseRestoreLock;
  });
});

afterEach(async () => {
  // Drain only this test's deferred mocks, even if a strong assertion failed.
  for (const gate of gates) gate.reject(new Error("Owned mock teardown"));
  await Promise.allSettled(operations);
  try {
    expectNoSynchronousDiscovery();
    for (const mock of [mocks.net, mocks.fetch, mocks.firefoxSpawn, mocks.firefoxPrefs, mocks.capabilities]) {
      expect(mock).not.toHaveBeenCalled();
    }
    expect(mocks.firefoxVersion).toHaveBeenCalledTimes(expectedFirefoxVersionCalls);
    expect(killSpy).not.toHaveBeenCalled();
    expect(runningProcesses.size).toBe(0);
    expect(mocks.lockHeld).toBe(false);
  } finally {
    killSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fixture.clear();
  }
});
afterAll(() => fixture.dispose());

describe("browser-manager metadata-only UI discovery", () => {
  it("returns persisted config IDs, names and engine-aware pins before and during deferred status, without extraction/version/capability work", async () => {
    expectEmptySnapshot();
    const expected = Object.entries(fixture.readConfig().browserProfiles).map(([dirId, meta]: [string, any]) => ({
      dirId, name: meta.name, browserVersion: meta.browserVersion, version: meta.browserVersion || "?", engine: meta.engine,
      running: false, pid: null, cdpPort: null,
    }));
    expect(projection()).toEqual(expected);
    for (const mock of [mocks.chromiumList, mocks.chromiumFind, mocks.firefoxStatus, mocks.firefoxFind, mocks.command]) {
      expect(mock).not.toHaveBeenCalled();
    }
    const chromeGate = deferred<ManagedChromiumBinary[]>();
    const firefoxGate = deferred<FirefoxStatus>();
    mocks.chromiumList.mockReturnValueOnce(chromeGate.promise);
    mocks.firefoxStatus.mockReturnValueOnce(firefoxGate.promise);
    const status = watch(getEngineStatusAsync());
    await turn();
    expect(projection()).toEqual(expected);
    expectEmptySnapshot();
    expect(mocks.command).not.toHaveBeenCalled();
    expectNoSynchronousDiscovery();
    const injected = { chromiumPath: chromium, chromiumVersion: "152.0.1.8", firefoxVersion: "156.0.2", chromiumInstalled: true, pending: false };
    expect(listBrowserProfiles(injected).map(p => p.version)).toEqual([chromiumPin, "152.0.1.8", firefoxPin, "156.0.2"]);
    chromeGate.resolve([]);
    firefoxGate.resolve(firefoxResult);
    await status;
    expectFullSnapshot();
    expect(projection().map(p => p.version)).toEqual([chromiumPin, chromiumVersion, firefoxPin, firefoxVersion]);
  });

  it("coalesces pending Chromium discovery and version work while real timers and the event loop respond", async () => {
    const discovery = deferred<ManagedChromiumBinary[]>();
    const version = deferred<{ stdout: string; stderr: string }>();
    mocks.chromiumList.mockReturnValueOnce(discovery.promise);
    mocks.command.mockReturnValueOnce(version.promise);
    let settled = false;
    const first = watch(getRuntimeChromiumStatusAsync());
    void first.then(() => { settled = true; }, () => { settled = true; });
    expect(watch(getRuntimeChromiumStatusAsync())).toBe(first);
    expect(watch(getRuntimeChromiumStatusAsync())).toBe(first);
    await turn();
    expect(settled).toBe(false);
    expect(mocks.chromiumList).toHaveBeenCalledTimes(1);
    expect(mocks.command).not.toHaveBeenCalled();
    expectEmptySnapshot();
    discovery.resolve([]);
    await until(() => mocks.command.mock.calls.length === 1, "the pending Chromium version command");
    await turn();
    expect(settled).toBe(false);
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(mocks.command).toHaveBeenCalledWith(chromium, ["--version"], { timeout: 5000 });
    expect(watch(getRuntimeChromiumStatusAsync())).toBe(first);
    version.resolve({ stdout: `Chromium ${chromiumVersion}`, stderr: "" });
    await expect(first).resolves.toEqual({
      path: chromium, version: chromiumVersion, source: "configured", installed: true,
      platform: `${process.platform}-${process.arch}`, cacheDir: null, installedVersions: [],
    });
    expect(getProfileRuntimeSnapshot()).toEqual({
      chromiumPath: chromium, chromiumVersion, firefoxVersion: null, chromiumInstalled: true, pending: true,
    });
    expect(mocks.chromiumList).toHaveBeenCalledTimes(1);
    expect(mocks.command).toHaveBeenCalledTimes(1);
  });

  it("rejects stale Chromium status after config selection changes and never marks the new selection installed prematurely", async () => {
    const discovery = deferred<ManagedChromiumBinary[]>();
    mocks.chromiumList.mockReturnValueOnce(discovery.promise);
    const old = watch(getRuntimeChromiumStatusAsync());
    const nextBinary = path.join(fixture.caseRoot, "binaries", "next-chrome");
    put(nextBinary, "different owned Chromium selection");
    mocks.versions.set(nextBinary, "151.0.8000.4");
    selectChromium(nextBinary);
    expectEmptySnapshot();
    discovery.resolve([]);
    await expect(old).rejects.toThrow(/selection changed during discovery/i);
    expect(mocks.command).toHaveBeenCalledWith(chromium, ["--version"], { timeout: 5000 });
    expectEmptySnapshot();
    await expect(watch(getRuntimeChromiumStatusAsync())).resolves.toMatchObject({ path: nextBinary, version: "151.0.8000.4", installed: true });
    expect(getProfileRuntimeSnapshot()).toMatchObject({ chromiumPath: nextBinary, chromiumVersion: "151.0.8000.4", chromiumInstalled: true });
    expect(mocks.chromiumList).toHaveBeenCalledTimes(2);
  });

  it("coalesces Firefox status but rejects the old aggregate when Firefox selection changes before completion", async () => {
    const pendingFirefox = deferred<FirefoxStatus>();
    mocks.firefoxStatus.mockReturnValueOnce(pendingFirefox.promise);
    const first = watch(getEngineStatusAsync());
    const second = watch(getEngineStatusAsync());
    await turn();
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(1);
    expect(mocks.chromiumList).toHaveBeenCalledTimes(1);
    const nextFirefox = path.join(fixture.caseRoot, "binaries", "next-firefox");
    put(nextFirefox);
    vi.stubEnv("AGENT_BROWSER_FIREFOX_BINARY_PATH", nextFirefox);
    expectEmptySnapshot();
    pendingFirefox.resolve(firefoxResult);
    await expect(first).rejects.toThrow(/selection changed during discovery/i);
    await expect(second).rejects.toThrow(/selection changed during discovery/i);
    expectEmptySnapshot();
    firefoxResult = { ...firefoxResult, path: nextFirefox, version: "155.0.2" };
    await expect(watch(getEngineStatusAsync())).resolves.toMatchObject({ firefox: { path: nextFirefox, version: "155.0.2" } });
    expectFullSnapshot(chromiumVersion, "155.0.2");
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(2);
  });

  it("rejects bundled-like Firefox native status when XUL changes after Firefox completes but before Chromium completes", async () => {
    // The Firefox status path is outside both managed roots, is not an env
    // override, and is not in the mocked system-path list. Selection-key scans
    // cannot detect this change; the individually captured identity must do so.
    expect(firefox.startsWith(path.join(fixture.caseRoot, "firefox-cache") + path.sep)).toBe(false);
    expect(firefox.startsWith(path.join(fixture.caseRoot, "chromium-cache") + path.sep)).toBe(false);
    expect(process.env.AGENT_BROWSER_FIREFOX_BINARY_PATH).toBeUndefined();
    expect(process.env.FIREFOX_BINARY_PATH).toBeUndefined();
    const configBefore = fixture.readConfig();
    const chromiumPending = deferred<ManagedChromiumBinary[]>();
    const firefoxPending = deferred<FirefoxStatus>();
    mocks.chromiumList.mockReturnValueOnce(chromiumPending.promise);
    mocks.firefoxStatus.mockReturnValueOnce(firefoxPending.promise);
    const nativeFirefox: FirefoxStatus = {
      ...firefoxResult, fingerprintParity: true, nativeConfig: true, managedInjection: "native",
      nativeCapabilities: ["config-v1", "native-required-v1", "snapshot-v1", "fixture-parity-v1"],
      sourceStamp: "owned native status before XUL replacement",
    };
    let published = false;
    const status = watch(getEngineStatusAsync());
    void status.then(() => { published = true; }, () => undefined);
    firefoxPending.resolve(nativeFirefox);
    await turn();
    expect(published).toBe(false);
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(1);
    expect(mocks.chromiumList).toHaveBeenCalledTimes(1);
    expect(mocks.command).not.toHaveBeenCalled();
    expectEmptySnapshot();
    replace(xul, "XUL replaced after individual Firefox completion, while Chromium discovery is still pending");
    expect(fixture.readConfig()).toEqual(configBefore);
    chromiumPending.resolve([]);
    await expect(status).rejects.toThrow(/selection changed during discovery/i);
    expect(published).toBe(false); // No installed/native-parity response escaped.
    expect(getProfileRuntimeSnapshot()).toEqual({
      chromiumPath: chromium, chromiumVersion, firefoxVersion: null, chromiumInstalled: true, pending: true,
    });
    expect(listBrowserProfiles().map(p => p.version)).toEqual([chromiumPin, chromiumVersion, firefoxPin, "?"]);
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects bundled-like Chromium status when its binary changes after Chromium completes but before Firefox completes", async () => {
    // Auto selection makes this mocked candidate external to configured,
    // managed-root and default-system identities in runtimeSelectionKey.
    selectChromium("auto");
    expect(chromium.startsWith(path.join(fixture.caseRoot, "chromium-cache") + path.sep)).toBe(false);
    expect(chromium.startsWith(path.join(fixture.caseRoot, "firefox-cache") + path.sep)).toBe(false);
    expect(process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBeUndefined();
    expect(process.env.CLOAKLITE_CHROMIUM_BINARY_PATH).toBeUndefined();
    const configBefore = fixture.readConfig();
    mocks.chromiumList.mockResolvedValue([{ binaryPath: chromium, version: chromiumVersion, installDir: path.dirname(chromium) }]);
    const firefoxPending = deferred<FirefoxStatus>();
    mocks.firefoxStatus.mockReturnValueOnce(firefoxPending.promise);
    let published = false;
    const status = watch(getEngineStatusAsync());
    void status.then(() => { published = true; }, () => undefined);
    await until(() => getProfileRuntimeSnapshot().chromiumInstalled === true, "individual Chromium completion with Firefox held");
    await turn();
    expect(published).toBe(false);
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith(chromium, ["--version"], { timeout: 5000 });
    expect(getProfileRuntimeSnapshot()).toEqual({
      chromiumPath: chromium, chromiumVersion, firefoxVersion: null, chromiumInstalled: true, pending: true,
    });
    replace(chromium, "Chromium replaced after individual Chromium completion, while Firefox discovery is still pending");
    expect(fixture.readConfig()).toEqual(configBefore);
    expectEmptySnapshot();
    firefoxPending.resolve(firefoxResult);
    await expect(status).rejects.toThrow(/selection changed during discovery/i);
    expect(published).toBe(false); // The old installed Chromium response must not escape.
    expectEmptySnapshot();
    expect(listBrowserProfiles().map(p => p.version)).toEqual([chromiumPin, "?", firefoxPin, "?"]);
    expect(mocks.chromiumList).toHaveBeenCalledTimes(1);
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(1);
  });

  it("invalidates a completed snapshot when the selected Chromium file identity changes and refreshes its version", async () => {
    await watch(getEngineStatusAsync());
    expectFullSnapshot();
    const probes = mocks.command.mock.calls.length;
    expectFullSnapshot();
    listBrowserProfiles();
    expect(mocks.command).toHaveBeenCalledTimes(probes);
    replace(chromium, "replacement Chromium file with a distinct size and identity");
    mocks.versions.set(chromium, "151.0.8000.4");
    expectEmptySnapshot();
    expect(listBrowserProfiles().map(p => p.version)).toEqual([chromiumPin, "?", firefoxPin, "?"]);
    expect(mocks.command).toHaveBeenCalledTimes(probes);
    await watch(getEngineStatusAsync());
    expectFullSnapshot("151.0.8000.4");
    expect(mocks.command).toHaveBeenCalledTimes(probes + 1);
  });

  it.each(["Firefox binary", "Firefox XUL"])("invalidates completed %s identity even outside configured/default discovery paths", async changed => {
    await watch(getEngineStatusAsync());
    expectFullSnapshot();
    const chromeProbes = mocks.command.mock.calls.length;
    const firefoxProbes = mocks.firefoxStatus.mock.calls.length;
    replace(changed === "Firefox binary" ? firefox : xul, `replacement ${changed} contents with a distinct fixture identity`);
    expect(getProfileRuntimeSnapshot()).toEqual({
      chromiumPath: chromium, chromiumVersion, firefoxVersion: null, chromiumInstalled: true, pending: true,
    });
    expect(listBrowserProfiles().map(p => p.version)).toEqual([chromiumPin, chromiumVersion, firefoxPin, "?"]);
    expect(mocks.command).toHaveBeenCalledTimes(chromeProbes);
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(firefoxProbes);
    firefoxResult = { ...firefoxResult, version: "155.0.2" };
    await watch(getEngineStatusAsync());
    expectFullSnapshot(chromiumVersion, "155.0.2");
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(firefoxProbes + 1);
  });

  it("retries Chromium discovery after a shared rejection rather than caching failure", async () => {
    const discovery = deferred<ManagedChromiumBinary[]>();
    mocks.chromiumList.mockReturnValueOnce(discovery.promise);
    const first = watch(getRuntimeChromiumStatusAsync());
    const second = watch(getRuntimeChromiumStatusAsync());
    expect(second).toBe(first);
    discovery.reject(new Error("owned discovery failure"));
    await expect(first).rejects.toThrow("owned discovery failure");
    await expect(second).rejects.toThrow("owned discovery failure");
    expectEmptySnapshot();
    expect(mocks.command).not.toHaveBeenCalled();
    await expect(watch(getRuntimeChromiumStatusAsync())).resolves.toMatchObject({ path: chromium, installed: true, version: chromiumVersion });
    expect(mocks.chromiumList).toHaveBeenCalledTimes(2);
    expect(mocks.command).toHaveBeenCalledTimes(1);
  });

  it("retries failed Firefox discovery without publishing a completed Firefox snapshot", async () => {
    const discovery = deferred<FirefoxStatus>();
    mocks.firefoxStatus.mockReturnValueOnce(discovery.promise);
    const first = watch(getEngineStatusAsync());
    const second = watch(getEngineStatusAsync());
    await turn();
    discovery.reject(new Error("owned Firefox discovery failure"));
    await expect(first).rejects.toThrow("owned Firefox discovery failure");
    await expect(second).rejects.toThrow("owned Firefox discovery failure");
    expect(getProfileRuntimeSnapshot()).toMatchObject({ firefoxVersion: null, pending: true });
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(1);
    await watch(getEngineStatusAsync());
    expectFullSnapshot();
    expect(mocks.firefoxStatus).toHaveBeenCalledTimes(2);
  });

  it.each(["disappears", "is replaced"])("rejects individual Chromium status and verification when a bundled-like candidate %s during its version command", async change => {
    selectChromium("auto");
    mocks.chromiumList.mockResolvedValue([{ binaryPath: chromium, version: chromiumVersion, installDir: path.dirname(chromium) }]);
    const versionPending = deferred<{ stdout: string; stderr: string }>();
    mocks.command.mockReturnValueOnce(versionPending.promise);
    const status = watch(getRuntimeChromiumStatusAsync());
    const verified = watch(verifyRuntimeChromiumAsync());
    await until(() => mocks.command.mock.calls.length === 1, "the individual Chromium version command");
    await turn();
    expect(mocks.chromiumList).toHaveBeenCalledTimes(1);
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith(chromium, ["--version"], { timeout: 5000 });
    expectEmptySnapshot();
    fixture.assertFile(chromium);
    fs.unlinkSync(chromium);
    if (change === "is replaced") put(chromium, "new owned non-executable Chromium file, not the one whose version is pending");
    expect(fs.existsSync(chromium)).toBe(change === "is replaced");
    versionPending.resolve({ stdout: `Chromium ${chromiumVersion}`, stderr: "" });
    const outcomes = await Promise.allSettled([status, verified]);
    // Check both consumers and the snapshot, even when the first safety check
    // is red. A fulfilled installed:true result for a missing binary is unsafe.
    expect.soft(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
    expect.soft(getProfileRuntimeSnapshot()).toEqual({
      chromiumPath: null, chromiumVersion: null, firefoxVersion: null, chromiumInstalled: null, pending: true,
    });
    expect(mocks.chromiumList).toHaveBeenCalledTimes(1);
    expect(mocks.command).toHaveBeenCalledTimes(1);
  });

  it.each(["snapshot", "default profile list"])("returns metadata from %s without any full engine-root readdirSync scan", kind => {
    // Observe only the production metadata call, not fixture setup/teardown.
    // Stat-only checks of already-known identities are deliberately allowed.
    const scan = mocks.readdirSync;
    scan.mockClear();
    if (kind === "snapshot") expectEmptySnapshot();
    else expect(listBrowserProfiles().map(profile => profile.dirId)).toEqual(Object.keys(fixture.readConfig().browserProfiles));
    expect(scan).not.toHaveBeenCalled();
    expect(mocks.chromiumList).not.toHaveBeenCalled();
    expect(mocks.firefoxStatus).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it.each([
    { label: "wrong actual version", requested: chromiumPin, stdout: `Chromium ${chromiumVersion}`, accepted: false },
    { label: "missing command output", requested: chromiumPin, stdout: null, accepted: false },
    { label: "matching actual version despite the wrong directory name", requested: chromiumVersion, stdout: `Chromium ${chromiumVersion}`, accepted: true },
  ])("enforces an explicit Chromium pin using $label, never the chromium-* directory name", async scenario => {
    const misleadingBinary = path.join(fixture.caseRoot, "binaries", `chromium-${chromiumPin}`, "misnamed-chrome");
    put(misleadingBinary, "owned non-executable file under a misleading version directory");
    selectChromium(misleadingBinary);
    mocks.command.mockResolvedValueOnce(scenario.stdout === null ? null : { stdout: scenario.stdout, stderr: "" });
    const resolved = await watch(findRuntimeChromiumBinaryAsync(scenario.requested));
    expect.soft(resolved).toBe(scenario.accepted ? misleadingBinary : null);
    expect.soft(mocks.command).toHaveBeenCalledExactlyOnceWith(misleadingBinary, ["--version"], { timeout: 5000 });
    expect(mocks.chromiumFind).not.toHaveBeenCalled();
    expect(mocks.firefoxSpawn).not.toHaveBeenCalled();
    expectEmptySnapshot();
  });

  it("resolves configured Chromium pins asynchronously and fails closed on mismatch without managed fallback", async () => {
    const version = deferred<{ stdout: string; stderr: string }>();
    mocks.command.mockReturnValueOnce(version.promise);
    let settled = false;
    const result = watch(findRuntimeChromiumBinaryAsync(chromiumVersion));
    void result.then(() => { settled = true; }, () => { settled = true; });
    await turn();
    expect(settled).toBe(false);
    expect(mocks.chromiumFind).not.toHaveBeenCalled();
    version.resolve({ stdout: `Chromium ${chromiumVersion}`, stderr: "" });
    await expect(result).resolves.toBe(chromium);
    await expect(watch(findRuntimeChromiumBinaryAsync(chromiumPin))).resolves.toBeNull();
    expect(mocks.chromiumFind).not.toHaveBeenCalled();
    expect(mocks.command).toHaveBeenCalledTimes(2);
    expectEmptySnapshot(); // A resolver is not a completed status request.
  });

  it("uses the mocked asynchronous managed finder for auto selection and preserves the requested pin", async () => {
    selectChromium("auto");
    const managed = deferred<ManagedChromiumBinary | null>();
    mocks.chromiumFind.mockReturnValueOnce(managed.promise);
    const result = watch(findRuntimeChromiumBinaryAsync(chromiumPin));
    await turn();
    expect(mocks.chromiumFind).toHaveBeenCalledExactlyOnceWith(chromiumPin);
    expect(mocks.command).not.toHaveBeenCalled();
    mocks.versions.set(chromium, chromiumPin); // The returned candidate's actual mocked version is truthful.
    managed.resolve({ binaryPath: chromium, version: chromiumPin, installDir: path.dirname(chromium) });
    await expect(result).resolves.toBe(chromium);
    expectEmptySnapshot();
  });

  it("rejects a pinned Firefox profile when the discovered binary version is unknown, releasing once before capability/prefs/spawn", async () => {
    const configBefore = fixture.readConfig();
    const versionPending = deferred<string | null>();
    mocks.firefoxFind.mockResolvedValueOnce(firefox);
    mocks.firefoxVersion.mockReturnValueOnce(versionPending.promise);
    expectedFirefoxVersionCalls = 1;
    const launched = watch(launchBrowser("ab_firefox_pinned"));
    await Promise.race([
      launched,
      vi.waitFor(() => expect(mocks.firefoxVersion).toHaveBeenCalledExactlyOnceWith(firefox)),
    ]);
    expect(mocks.acquireRestoreLock).toHaveBeenCalledExactlyOnceWith("ab_firefox_pinned");
    expect(mocks.firefoxFind).toHaveBeenCalledTimes(1);
    expect(mocks.firefoxVersion).toHaveBeenCalledExactlyOnceWith(firefox);
    expect(mocks.lockHeld).toBe(true);
    expect(mocks.releaseRestoreLock).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
    expect(mocks.firefoxPrefs).not.toHaveBeenCalled();
    expect(mocks.firefoxSpawn).not.toHaveBeenCalled();
    versionPending.resolve(null);
    await expect(launched).rejects.toThrow(/Cannot verify the selected Firefox runtime version/);
    expect(mocks.lockHeld).toBe(false);
    expect(mocks.releaseRestoreLock).toHaveBeenCalledTimes(1);
    await turn();
    expect(mocks.releaseRestoreLock).toHaveBeenCalledTimes(1);
    expect(mocks.capabilities).not.toHaveBeenCalled();
    expect(mocks.firefoxPrefs).not.toHaveBeenCalled();
    expect(mocks.firefoxSpawn).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(fixture.readConfig()).toEqual(configBefore);
  });

  it.each(["missing binary", "rejected discovery"])("holds the Firefox restore lock throughout pending discovery and releases once on %s", async failure => {
    const discovery = deferred<string | null>();
    mocks.firefoxFind.mockReturnValueOnce(discovery.promise);
    let settled = false;
    const launched = watch(launchBrowser("ab_firefox_auto"));
    void launched.then(() => { settled = true; }, () => { settled = true; });
    expect(mocks.acquireRestoreLock).toHaveBeenCalledExactlyOnceWith("ab_firefox_auto");
    expect(mocks.lockHeld).toBe(true);
    expect(mocks.releaseRestoreLock).not.toHaveBeenCalled();
    await turn();
    expect(settled).toBe(false);
    expect(mocks.lockHeld).toBe(true);
    expect(mocks.releaseRestoreLock).not.toHaveBeenCalled();
    await expect(watch(launchBrowser("ab_firefox_auto"))).rejects.toThrow(/being restored; launch is temporarily blocked/i);
    expect(mocks.firefoxFind).toHaveBeenCalledTimes(1);
    expect(mocks.releaseRestoreLock).not.toHaveBeenCalled();
    if (failure === "missing binary") discovery.resolve(null);
    else discovery.reject(new Error("owned Firefox resolution failure"));
    await expect(launched).rejects.toThrow(failure === "missing binary" ? /Managed Firefox is required/ : /owned Firefox resolution failure/);
    expect(mocks.lockHeld).toBe(false);
    expect(mocks.releaseRestoreLock).toHaveBeenCalledTimes(1);
    await turn();
    expect(mocks.releaseRestoreLock).toHaveBeenCalledTimes(1);
    expect(mocks.firefoxSpawn).not.toHaveBeenCalled();
    expect(mocks.firefoxVersion).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(fixture.readConfig().browserProfiles.ab_firefox_auto.name).toBe("Auto Firefox");
  });
});
