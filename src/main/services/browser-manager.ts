// ── Agent Browser Studio managed Chromium profiles ──
// The browser runtime is the independently built Chromium patchset installed
// under the managed cache. No upstream wrapper, downloader, or license service
// participates in profile launch.

import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execSync, execFileSync } from "node:child_process";
import { parseBrowserProcessLine, findBrowserByProfileSync, inspectBrowserLaunchesSync, browserLaunchProcessFromArgv, normalizeBrowserProcessPath, type BrowserLaunchProcess } from "./process-discovery.js";
import { BrowserWindow, screen as electronScreen } from "electron";
import { getConfig, saveConfig, getAppDataDir, getProfilesDir, resolveProfileProxy, resolveProfileProxySecret, getProxyDetection, sanitizeAppUrl, getProxyHealthEntry, assertProfileWritable } from "./config-manager.js";
import { cdpCookieService, readQueuedCookieImports } from "./cdp-cookie-service.js";
import { decryptSecretOr } from "./secrets.js";
import { recordAudit } from "./audit-log.js";
import { checkProfileConsistency } from "./consistency-check.js";
import { drmLaunchArgs } from "./drm.js";
import { getProfileEngineByDirId } from "./page-eval.js";
import {
  captureFingerprint, diffFingerprints, hasRiskyDrift, summarizeDrift,
  checkPersonaConsistency, mismatchesAsDrift,
  type FingerprintDrift,
} from "./fingerprint-baseline.js";
import { checkEnvironmentRiskRuntime, shouldBlockEnvironmentRisk, summarizeEnvFindings, type EnvRiskFinding } from "./environment-risk.js";
import { runFingerprintDriftGuard, runEnvironmentRiskGuard, LaunchBlockedError, assertHostPlatformCompatible } from "./browser/launch-guards.js";
import { getHostBrowserPlatform } from "./browser-platform-policy.js";
import {
  assertChromiumLaunchProvenance, assertChromiumReuseDnsCompatible, assertChromiumReuseEvidence,
  chromiumLaunchRequestHash, chromiumLaunchStampArg, restartRequired, stampChromiumLaunch,
} from "./browser/launch-provenance.js";
import { prepareChromiumDiagnosticNetLogArgs } from "./browser/launch-diagnostics.js";
import { readChromiumGpuContext } from "./browser/chromium-gpu-context.js";
import { getEnabledRepositoryExtensionPaths } from "./extension-repository.js";
import { acquireRestoreLock } from "./profile-restore-lock.js";
import { readProfileSyncState, type ProfileSyncState } from "./sync/profile-state.js";
import {
  startAuthenticatedSocksBridge,
} from "./authenticated-socks-bridge.js";
import { startMasqueSocksBridge } from "./masque-socks-bridge.js";
import { buildChromiumProxyUrl, proxyDetector, proxyDetectionObservedAt, probeProxyPort, type ProxyDetectionResult } from "./proxy-detector.js";
import { captureProxyDetectionTarget, detectProxyTarget, commitProxyDetectionIfCurrent, type ProxyDetectionTarget } from "./proxy-detection.js";
import { recordProxyRotation } from "./proxy-health.js";
import { validateDirId } from "./utils.js";
import { requireProfileMutation } from "./team.js";
import { transact } from "./config/store.js";
import { emitEvent } from "./event-bus.js";
import {
  AGENT_BROWSER_FINGERPRINT_SWITCH,
  LEGACY_FINGERPRINT_SWITCH,
  buildBrowserFingerprintConfig,
  encodeBrowserFingerprintConfig,
  validateBrowserHardwareProfile,
  type ChromiumGpuContext,
} from "./browser-fingerprint-config.js";
import {
  findManagedChromiumBinary,
  findManagedChromiumBinaryAsync,
  getManagedChromiumRoot,
  listManagedChromiumBinaries,
  listManagedChromiumBinariesAsync,
  normalizeManagedChromiumVersion,
} from "./native-chromium-manager.js";
import {
  LEGACY_NATIVE_PROXY_AUTH_SWITCH,
  NATIVE_PROXY_AUTH_SWITCH,
  NATIVE_SUPPRESS_GOOGLE_API_KEY_INFOBAR_SWITCH,
  nativeProxyAuthSwitch,
  type NativeProxyAuthFile,
  supportsAgentBrowserFingerprintConfig,
  supportsGoogleApiKeyInfoBarSuppression,
  supportsNativeLocalDnsPolicy,
  supportsNativeProxyAuth,
  supportsNativeQuicProxy,
  writeNativeProxyAuthFile,
} from "./native-proxy-auth.js";
import type { FingerprintMode, GeolocationMode, ProxyConfig, ResolvedProfileProxy, WebRtcMode, ProfileLock, BrowserProfileMeta, BrowserEngine, RenderScaleMode } from "../types.js";
import { PROFILE_ID_PREFIX, isManagedProfileId } from "../branding.js";
import {
  buildFirefoxLaunchArgs,
  detectFirefoxVersionAsync,
  findFirefoxBinaryAsync,
  getFirefoxBinaryOverride,
  getFirefoxStatus,
  getFirefoxStatusAsync,
  defaultFirefoxBinaryPaths,
  normalizeManagedFirefoxVersion,
  sanitizeBrowserEngine,
  spawnFirefoxWithDebugInfo,
  writeFirefoxUserJs,
  type FirefoxStatus,
} from "./browser-engine.js";
import { buildFirefoxManagedIdentity, buildInjectionProbeExpression, buildInjectionProbeExpectation, judgeInjectionProbe, normalizeFirefoxVersion, shouldBlockInjectionProbe, type InjectionProbeCheck } from "./firefox-fingerprint.js";
import {
  firefoxNativeModeRequested,
  readFirefoxNativeCapabilityReportAsync,
  getFirefoxNativeSelectionIdentityAsync,
  FIREFOX_NATIVE_CONFIG_CAPABILITIES,
  FIREFOX_NATIVE_PARITY_CAPABILITIES,
} from "./firefox-native-capabilities.js";
import { connectBidi, bidiAddPreloadScript, bidiCreateContext, bidiCloseContext, bidiEvaluateInContext, registerFirefoxSession, dropFirefoxSession, getRegisteredFirefoxSession, type BidiConnection } from "./bidi-client.js";
import { firefoxCookieService } from "./bidi-cookie-service.js";

import { runBrowserCommand } from "./browser-command.js";
import { bundledBrowsersRoot } from "./bundled-native-browsers.js";
import { getManagedFirefoxRoot } from "./native-firefox-manager.js";
import { captureLaunchProxySnapshot, runningProcesses, type RunningEntry } from "./browser/runtime-table.js";
import { firefoxEffectiveLaunchHash, firefoxLaunchDigest, firefoxLaunchRequestHash } from "./browser/firefox-launch-provenance.js";

interface OwnedFirefoxLaunch {
  requestHash: string;
  effectiveHash: string;
  executablePath: string;
  binaryIdentity: string;
  profileDir: string;
  argvHash: string;
  userJsHash: string;
  connection: BidiConnection;
}
const ownedFirefoxLaunches = new WeakMap<object, OwnedFirefoxLaunch>();
import { buildProxyDnsArgs, resolveChromiumDnsPolicy } from "./browser-dns-policy.js";
export { buildRemoteDnsRule } from "./browser-dns-policy.js";
import { launchBrowserPipeline } from "./browser/launch-pipeline.js";

export interface BrowserProfile {
  dirId: string;
  name: string;
  version: string;       // engine version (Chromium or Firefox)
  browserVersion: string | null; // exact installed version pin, or auto
  engine: BrowserEngine; // chromium (managed build, default) | firefox (Slice 77)
  fingerprintMode: FingerprintMode;
  allowThirdPartyCookies: boolean;
  drm: boolean;
  fingerprintSeed: number; // integer seed for deterministic fingerprint
  platform: "windows" | "macos" | "android";
  timezone: string | null;  // IANA timezone (e.g. 'Asia/Shanghai', 'America/New_York')
  locale: string | null;    // BCP 47 locale (e.g. 'zh-CN', 'en-US')
  webrtcMode: WebRtcMode;
  webrtcIp: string | null;  // WebRTC exit IP override
  geolocationMode: GeolocationMode;
  geolocationLatitude: number | null;
  geolocationLongitude: number | null;
  geolocationAccuracy: number | null;
  gpuVendor: string | null;
  gpuRenderer: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  storageQuota: number | null;
  taskbarHeight: number | null;
  fontsDir: string | null;
  /** Raster scale strategy at launch (default `native`; Chromium only). */
  renderScaleMode: RenderScaleMode;
  windowTitlePrefix?: string | null; // null = prefix disabled, undefined = default
  appUrl: string | null;  // Web App (PWA app-mode) launch URL, or null
  proxyMode: "none" | "default" | "named";
  proxyName: string | null;  // resolved proxy reference name
  note: string | null;      // user note
  tags: string[];
  preset: string | null;    // business preset id used at creation (Slice 75)
  syncedAt: number | null;
  syncStatus: ProfileSyncState["syncStatus"];
  syncScope: ProfileSyncState["syncScope"];
  syncReason: ProfileSyncState["syncReason"];
  lastModified: number;
  lock: ProfileLock | null;
  running: boolean;
  pid: number | null;
  cdpPort: number | null;
}


// ═══════════════════════════════════════════════════════════════
// Binary Discovery
// ═══════════════════════════════════════════════════════════════

function getChromiumBinaryOverride(): string | null {
  return process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH
    || process.env.CLOAKLITE_CHROMIUM_BINARY_PATH // pre-rename compatibility
    || null;
}

export function findManagedRuntimeChromium(requestedVersion?: string | null): string | null {
  return findManagedChromiumBinary(requestedVersion)?.binaryPath || null;
}

export function findRuntimeChromiumBinary(requestedVersion?: string | null): string | null {
  const version = normalizeManagedChromiumVersion(requestedVersion);
  const cfg = getConfig() as any;
  if (cfg.chromiumBin && cfg.chromiumBin !== "auto" && fs.existsSync(cfg.chromiumBin)) {
    return !version || detectBinaryVersion(cfg.chromiumBin) === version ? cfg.chromiumBin : null;
  }

  const envBin = getChromiumBinaryOverride();
  if (envBin && fs.existsSync(envBin)) {
    return !version || detectBinaryVersion(envBin) === version ? envBin : null;
  }

  return findManagedRuntimeChromium(version);
}

export function getRuntimeChromiumVersion(): string | null {
  const bin = findRuntimeChromiumBinary();
  if (!bin) return null;
  return detectBinaryVersion(bin);
}

function detectBinaryVersion(bin: string): string | null {
  const m = bin.match(/chromium-([\d.]+)/);
  if (m) return m[1];

  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
    const vm = out.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (vm) return vm[1];
  } catch { /* can't detect */ }
  return null;
}

export function isRuntimeChromiumInstalled(): boolean {
  return findRuntimeChromiumBinary() !== null;
}

export interface ManagedChromiumStatus {
  path: string | null;
  version: string | null;
  source: "managed" | "configured" | null;
  installed: boolean;
  platform: string;
  cacheDir: string | null;
  installedVersions: Array<{ version: string; path: string }>;
}

export function getRuntimeChromiumStatus(): ManagedChromiumStatus {
  const managedCandidates = listManagedChromiumBinaries();
  const pathValue = findRuntimeChromiumBinary();
  const managedCandidate = pathValue
    ? managedCandidates.find((candidate) => path.resolve(candidate.binaryPath) === path.resolve(pathValue)) || null
    : null;
  const installedVersions = managedCandidates.map((candidate) => ({
    version: candidate.version,
    path: candidate.binaryPath,
  }));
  const detectedVersion = pathValue ? detectBinaryVersion(pathValue) : null;
  return {
    path: pathValue,
    version: detectedVersion,
    source: pathValue ? (managedCandidate ? "managed" : "configured") : null,
    installed: pathValue !== null,
    platform: `${process.platform}-${process.arch}`,
    cacheDir: managedCandidate?.installDir || null,
    installedVersions,
  };
}

function fileIdentity(file: string | null): unknown {
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  } catch {
    return [file, "missing"];
  }
}

function firefoxIdentity(file: string | null): unknown {
  if (!file) return null;
  const marker = path.join(path.dirname(file), process.platform === "darwin" ? "XUL" : process.platform === "win32" ? "xul.dll" : "libxul.so");
  return [fileIdentity(file), fileIdentity(marker)];
}

function runtimeSelectionKey(): string {
  const configured = (getConfig() as any).chromiumBin || "auto";
  const chromiumOverride = getChromiumBinaryOverride();
  const firefoxOverride = process.env.AGENT_BROWSER_FIREFOX_BINARY_PATH || process.env.FIREFOX_BINARY_PATH || null;
  const chromiumRoot = getManagedChromiumRoot();
  const firefoxRoot = getManagedFirefoxRoot();
  const resources = process.env.AGENT_BROWSER_BUNDLED_RESOURCES || process.resourcesPath || null;
  const bundles = bundledBrowsersRoot(process.platform, resources);
  const artifacts: unknown[] = [fileIdentity(configured === "auto" ? null : configured),
    fileIdentity(chromiumOverride), firefoxIdentity(firefoxOverride)];
  // Bound metadata projection to input roots and known paths, never enumerate
  // installed engines synchronously. Discovery owns the asynchronous inventory.
  for (const root of new Set([chromiumRoot, firefoxRoot])) artifacts.push(fileIdentity(root));
  if (bundles) {
    artifacts.push(fileIdentity(bundles));
    if (process.platform === "darwin") {
      artifacts.push(fileIdentity(path.join(bundles, "Chromium.app", "Contents", "MacOS", "Chromium")));
      artifacts.push(firefoxIdentity(path.join(bundles, "Firefox.app", "Contents", "MacOS", "firefox")));
    }
    for (const name of ["browsers-manifest.json", "Chromium.app.zip", "Firefox.app.zip"]) {
      artifacts.push(fileIdentity(path.join(bundles, name)));
    }
  }
  return JSON.stringify([configured, chromiumOverride, firefoxOverride, chromiumRoot, firefoxRoot, resources,
    process.env.AGENT_BROWSER_BUNDLED_CACHE_DIR || null, process.env.AGENT_BROWSER_FIREFOX_NATIVE || null,
    ...defaultFirefoxBinaryPaths().map(firefoxIdentity), artifacts]);
}

let completedChromium: { key: string; value: ManagedChromiumStatus; identity: unknown } | null = null;
let completedFirefox: { key: string; value: FirefoxStatus; identity: unknown } | null = null;
const pendingChromium = new Map<string, Promise<ManagedChromiumStatus>>();
const pendingFirefox = new Map<string, Promise<FirefoxStatus>>();
const MAX_RUNTIME_DISCOVERIES = 64;

async function executableIdentity(file: string | null): Promise<unknown> {
  if (!file) return null;
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] : null;
  } catch {
    return null;
  }
}

async function detectBinaryVersionAsync(bin: string): Promise<string | null> {
  // Directory labels are inventory hints, not evidence for a launch version pin.
  const output = await runBrowserCommand(bin, ["--version"], { timeout: 5000 });
  const raw = (output?.stdout || output?.stderr || "").trim();
  return raw.match(/\b(?:Chromium|Google Chrome)\s+(\d+\.\d+\.\d+\.\d+)/i)?.[1] || null;
}

export async function findRuntimeChromiumBinaryAsync(requestedVersion?: string | null): Promise<string | null> {
  const version = normalizeManagedChromiumVersion(requestedVersion);
  const configured = (getConfig() as any).chromiumBin;
  const override = getChromiumBinaryOverride();
  for (const binary of [configured && configured !== "auto" ? configured : null, override]) {
    if (binary && fs.existsSync(binary)) return !version || await detectBinaryVersionAsync(binary) === version ? binary : null;
  }
  const binary = (await findManagedChromiumBinaryAsync(version))?.binaryPath || null;
  return binary && (!version || await detectBinaryVersionAsync(binary) === version) ? binary : null;
}

export function getRuntimeChromiumStatusAsync(): Promise<ManagedChromiumStatus> {
  const key = runtimeSelectionKey();
  const pending = pendingChromium.get(key);
  if (pending) return pending;
  if (pendingChromium.size >= MAX_RUNTIME_DISCOVERIES) return Promise.reject(new Error("Browser discovery is busy; retry the status request"));
  const configured = (getConfig() as any).chromiumBin;
  const override = getChromiumBinaryOverride();
  const root = getManagedChromiumRoot();
  const operation = (async () => {
    const candidates = await listManagedChromiumBinariesAsync(root);
    const binary = [configured && configured !== "auto" ? configured : null, override]
      .find(candidate => candidate && fs.existsSync(candidate)) || candidates[0]?.binaryPath || null;
    const selected = binary ? candidates.find(candidate => path.resolve(candidate.binaryPath) === path.resolve(binary)) : null;
    const identity = await executableIdentity(binary);
    if (binary && !identity) throw new Error("Chromium executable changed during discovery; retry the status request");
    const version = binary ? await detectBinaryVersionAsync(binary) : null;
    if (JSON.stringify(identity) !== JSON.stringify(await executableIdentity(binary))) {
      throw new Error("Chromium executable changed during discovery; retry the status request");
    }
    const value: ManagedChromiumStatus = {
      path: binary, version,
      source: binary ? (selected ? "managed" : "configured") : null,
      installed: binary !== null, platform: `${process.platform}-${process.arch}`,
      cacheDir: selected?.installDir || null,
      installedVersions: candidates.map(candidate => ({ version: candidate.version, path: candidate.binaryPath })),
    };
    if (runtimeSelectionKey() !== key) throw new Error("Browser selection changed during discovery; retry the status request");
    completedChromium = { key, value, identity };
    return value;
  })();
  pendingChromium.set(key, operation);
  const clearPending = () => { if (pendingChromium.get(key) === operation) pendingChromium.delete(key); };
  void operation.then(clearPending, () => {
    clearPending();
    if (completedChromium?.key === key) completedChromium = null;
  }); // Callers still receive the original rejection; metadata becomes unknown.
  return operation;
}

export async function getEngineStatusAsync(): Promise<{ chromium: ManagedChromiumStatus; firefox: FirefoxStatus }> {
  const key = runtimeSelectionKey();
  let firefox = pendingFirefox.get(key);
  if (!firefox) {
    if (pendingFirefox.size >= MAX_RUNTIME_DISCOVERIES) throw new Error("Browser discovery is busy; retry the status request");
    firefox = getFirefoxStatusAsync({ ...process.env });
    pendingFirefox.set(key, firefox);
    const operation = firefox;
    const clearPending = () => { if (pendingFirefox.get(key) === operation) pendingFirefox.delete(key); };
    void operation.then(clearPending, () => {
      clearPending();
      if (completedFirefox?.key === key) completedFirefox = null;
    }); // Keep discovery failures on the original promise.
  }
  const [chromiumResult, firefoxResult] = await Promise.all([
    getRuntimeChromiumStatusAsync().then(value => ({ value, identity: fileIdentity(value.path) })),
    firefox.then(value => ({ value, identity: firefoxIdentity(value.path) })),
  ]);
  if (runtimeSelectionKey() !== key ||
      JSON.stringify(chromiumResult.identity) !== JSON.stringify(fileIdentity(chromiumResult.value.path)) ||
      JSON.stringify(firefoxResult.identity) !== JSON.stringify(firefoxIdentity(firefoxResult.value.path))) {
    throw new Error("Browser selection changed during discovery; retry the status request");
  }
  completedFirefox = { key, value: firefoxResult.value, identity: firefoxResult.identity };
  return { chromium: chromiumResult.value, firefox: firefoxResult.value };
}

export interface ProfileRuntimeSnapshot {
  chromiumPath: string | null;
  chromiumVersion: string | null;
  firefoxVersion: string | null;
  chromiumInstalled: boolean | null;
  pending: boolean;
}

/** Read-only projection: never prepares an engine or executes its binary.
 * A cached absence is not fresh launch authority; project it as unknown.
 */
export function getProfileRuntimeSnapshot(): ProfileRuntimeSnapshot {
  const key = runtimeSelectionKey();
  const chromium = completedChromium?.key === key && completedChromium.value.installed && JSON.stringify(completedChromium.identity) === JSON.stringify(fileIdentity(completedChromium.value.path))
    ? completedChromium.value : null;
  const firefox = completedFirefox?.key === key && completedFirefox.value.installed && JSON.stringify(completedFirefox.identity) === JSON.stringify(firefoxIdentity(completedFirefox.value.path))
    ? completedFirefox.value : null;
  return { chromiumPath: chromium?.path || null, chromiumVersion: chromium?.version || null, firefoxVersion: firefox?.version || null,
    chromiumInstalled: chromium?.installed ?? null, pending: !chromium || !firefox };
}

export async function verifyRuntimeChromiumAsync(): Promise<ManagedChromiumStatus> {
  const status = await getRuntimeChromiumStatusAsync();
  if (!status.installed || !status.path) {
    throw new Error(
      "Managed Chromium is not installed. Build the repository patchset and run " +
      "`npm run install:chromium -- /path/to/Chromium.app`, or set " +
      "AGENT_BROWSER_CHROMIUM_BINARY_PATH to an independently built binary.",
    );
  }
  return status;
}

export function verifyRuntimeChromium(): ManagedChromiumStatus {
  const status = getRuntimeChromiumStatus();
  if (!status.installed || !status.path) {
    throw new Error(
      "Managed Chromium is not installed. Build the repository patchset and run " +
      "`npm run install:chromium -- /path/to/Chromium.app`, or set " +
      "AGENT_BROWSER_CHROMIUM_BINARY_PATH to an independently built binary.",
    );
  }
  return status;
}

// ═══════════════════════════════════════════════════════════════
// Engine status (Slice 77): report both engines for IPC / REST / MCP / UI.
// ═══════════════════════════════════════════════════════════════

export function getEngineStatus(): {
  chromium: ManagedChromiumStatus;
  firefox: FirefoxStatus;
} {
  return {
    chromium: getRuntimeChromiumStatus(),
    firefox: getFirefoxStatus(),
  };
}

// ═══════════════════════════════════════════════════════════════
// Profile Management
// ═══════════════════════════════════════════════════════════════

/** Create a managed Chromium profile using --fingerprint=<seed>, or a Firefox profile (Slice 77). */
export function createBrowserProfile(opts: {
  name: string;
  engine?: BrowserEngine;
  fingerprintMode?: FingerprintMode;
  browserVersion?: string | null;
  allowThirdPartyCookies?: boolean;
  fingerprintSeed?: number;
  platform?: "windows" | "macos" | "android";
  timezone?: string;
  locale?: string;
  webrtcMode?: WebRtcMode;
  webrtcIp?: string;
  geolocationMode?: GeolocationMode;
  geolocationLatitude?: number | null;
  geolocationLongitude?: number | null;
  geolocationAccuracy?: number | null;
  gpuVendor?: string | null;
  gpuRenderer?: string | null;
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  storageQuota?: number | null;
  taskbarHeight?: number | null;
  windowTitlePrefix?: string | null;
  fontsDir?: string | null;
  /** Raster scale strategy (default `native`); see RenderScaleMode. */
  renderScaleMode?: RenderScaleMode;
  appUrl?: string | null;
  proxyMode?: "none" | "default" | "named";
  proxyName?: string | null;
  tags?: string[];
  drm?: boolean;
  /** Business preset id used at creation (Slice 75). */
  preset?: string | null;
}): { dirId: string } {
  // Team RBAC: viewers are read-only.
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  const dirId = PROFILE_ID_PREFIX + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);

  const cfg = structuredClone(getConfig());
  cfg.browserProfiles = cfg.browserProfiles || {};
  const proxyMode = opts.proxyMode || (opts.proxyName ? "named" : "default");
  const webrtcMode = normalizeWebRtcMode(opts.webrtcMode, opts.webrtcIp);
  if (proxyMode !== "none" && proxyMode !== "default" && proxyMode !== "named") {
    throw new Error(`Invalid proxy mode: ${JSON.stringify(proxyMode)}`);
  }
  if (proxyMode === "named" && (!opts.proxyName || !Object.hasOwn(cfg.proxies, opts.proxyName))) {
    throw new Error(`Proxy not found: ${opts.proxyName || ""}`);
  }
  const engine = sanitizeBrowserEngine(opts.engine);
  // Firefox carries the same managed identity intent as Chromium (Slice 79):
  // prefs (user.js) + a WebDriver BiDi preload script. `fingerprintMode: off`
  // explicitly opts out on both engines.
  const fingerprintMode = normalizeFingerprintMode(opts.fingerprintMode);
  const profile = {
    name: opts.name,
    engine,
    fingerprintMode,
    // Engine-aware version pin (R3 #58): Firefox pins like "154.0" would be
    // rejected by the Chromium 4-segment validator — validate per engine.
    browserVersion: engine === "firefox"
      ? normalizeManagedFirefoxVersion(opts.browserVersion)
      : normalizeManagedChromiumVersion(opts.browserVersion),
    allowThirdPartyCookies: normalizeBoolean(opts.allowThirdPartyCookies, "third-party cookie compatibility"),
    fingerprintSeed: normalizeFingerprintSeed(opts.fingerprintSeed || Math.floor(Math.random() * 90000) + 10000),
    // Explicit foreign platforms remain portable. Unsupported hosts retain the
    // legacy storage default, not a claim of native-GPU Windows support.
    platform: normalizePlatform(opts.platform || getHostBrowserPlatform() || "windows"),
    timezone: normalizeOptionalTimezone(opts.timezone),
    locale: normalizeOptionalLocale(opts.locale),
    webrtcMode,
    webrtcIp: webrtcMode === "real" || webrtcMode === "disable" ? null : normalizeOptionalIp(opts.webrtcIp),
    ...normalizeGeolocationMeta(opts),
    ...normalizeHardwareFingerprintMeta(opts),
    proxyMode,
    proxyName: proxyMode === "named" ? opts.proxyName || null : null,
    drm: normalizeBoolean(opts.drm, "drm"),
    renderScaleMode: normalizeRenderScaleMode(opts.renderScaleMode),
    windowTitlePrefix: opts.windowTitlePrefix === undefined ? undefined : (opts.windowTitlePrefix === null ? null : sanitizeWindowTitlePrefix(opts.windowTitlePrefix)),
    appUrl: sanitizeAppUrl(opts.appUrl),
    note: null,
    tags: normalizeTags(opts.tags),
    preset: opts.preset || null,
    updatedAt: Date.now(),
  };
  if (profile.fingerprintMode !== "off") validateBrowserHardwareProfile(profile, engine);
  cfg.browserProfiles[dirId] = profile;

  const profileDir = path.join(getProfilesDir(), dirId);
  const _profile = profile;
  const _dirId = dirId;
  try {
    fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
    try { const { transact } = require("./config/store.js"); transact((draft:any)=>{ draft.browserProfiles=draft.browserProfiles||{}; draft.browserProfiles[_dirId]=_profile; }); } catch { saveConfig(cfg); }
  } catch (e) {
    if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    throw e;
  }

  return { dirId };
}

/**
 * Soft-delete (review item PL-09): move the profile directory into a local
 * trash instead of removing it, so a mis-click is recoverable for
 * TRASH_TTL_MS. The trash lives outside the profiles directory (under app
 * data) so it is never picked up by sync or by the profile list.
 */
export const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function trashRoot(): string {
  return path.join(getAppDataDir(), "trash", "profiles");
}

function trashIndexPath(): string {
  return path.join(getAppDataDir(), "trash", "index.json");
}

export interface TrashEntry {
  dirId: string;
  name: string;
  deletedAt: number;
  /** Full profile meta snapshot (R6 #73): restore must bring back engine,
   * version pin, proxy, fingerprint — not a fresh chromium shell. */
  meta?: Record<string, unknown>;
  /** A purge was attempted; remaining files may be incomplete even if the directory exists. */
  deletionAttempted?: true;
}

/** The writer and reader must enforce the same persisted-entry invariants. */
function validateTrashIndex(parsed: unknown): TrashEntry[] {
  if (!Array.isArray(parsed)) throw new Error("Invalid trash index: expected an array");
  const seen = new Set<string>();
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid trash index entry");
    const entry = value as TrashEntry;
    if (typeof entry.dirId !== "string") throw new Error("Invalid trash index profile ID");
    validateDirId(entry.dirId);
    if (typeof entry.name !== "string" ||
        typeof entry.deletedAt !== "number" || !Number.isFinite(entry.deletedAt) || entry.deletedAt < 0 ||
        (entry.deletionAttempted !== undefined && entry.deletionAttempted !== true) ||
        (entry.meta !== undefined && (!entry.meta || typeof entry.meta !== "object" || Array.isArray(entry.meta) ||
          ("name" in entry.meta && typeof entry.meta.name !== "string")))) {
      throw new Error(`Invalid trash index entry for ${entry.dirId}`);
    }
    if (seen.has(entry.dirId)) throw new Error(`Duplicate trash index ID: ${entry.dirId}`);
    seen.add(entry.dirId);
  }
  return parsed as TrashEntry[];
}

function readTrashIndex(): TrashEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(trashIndexPath(), "utf-8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return validateTrashIndex(JSON.parse(raw));
}

/** lstat (not existsSync): permission errors must never masquerade as absence. */
function pathKind(p: string): "missing" | "directory" | "other" {
  try {
    const stat = fs.lstatSync(p);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "other";
  } catch (error: any) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

/** Atomic visibility under normal execution, not a multi-resource/crash-atomic transaction. */
function writeTrashIndex(entries: TrashEntry[]): void {
  // Validate the serialized form as well: JSON may omit unsupported values.
  const serialized = JSON.stringify(entries, null, 2);
  validateTrashIndex(JSON.parse(serialized));
  const indexPath = trashIndexPath();
  const temp = `${indexPath}.tmp-${randomUUID()}`;
  fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  let error: unknown;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, serialized, "utf-8");
    fs.fsyncSync(fd);
  } catch (failure) {
    error = failure;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (failure) {
        error = error ? new AggregateError([error, failure], `Trash index write failed: ${String(error)}; close failed: ${String(failure)}`) : failure;
      }
    }
  }
  if (!error) {
    try { fs.renameSync(temp, indexPath); } catch (failure) { error = failure; }
  }
  if (error) {
    try { fs.rmSync(temp); } catch (cleanup: any) {
      if (cleanup?.code !== "ENOENT") {
        throw new AggregateError([error, cleanup],
          `Trash index write failed: ${String(error)}; temporary cleanup failed: ${String(cleanup)}. Recovery required at ${temp}`);
      }
    }
    throw error;
  }
}

/** Report both failures and concrete state when best-effort compensation fails. */
function compensateTrashMove(
  failure: unknown, dirId: string, from: string, to: string, configUndo?: () => void,
): never {
  const failures: string[] = [];
  if (configUndo) {
    try { configUndo(); } catch (error) { failures.push(`config compensation: ${String(error)}`); }
  }
  try { fs.renameSync(from, to); } catch (error) { failures.push(`directory compensation: ${String(error)}`); }
  if (failures.length) {
    const location = (p: string) => {
      try { return `${p} (${pathKind(p)})`; } catch (error) { return `${p} (inspection failed: ${String(error)})`; }
    };
    const configLocation = path.join(getAppDataDir(), "config.json");
    const configState = (() => {
      try {
        const saved = JSON.parse(fs.readFileSync(configLocation, "utf-8"));
        return `disk config ${configLocation}: profile ${Object.hasOwn(saved.browserProfiles || {}, dirId) ? "present" : "absent"}`;
      } catch (error) { return `disk config ${configLocation}: inspection failed (${String(error)})`; }
    })();
    throw new Error(`Trash operation failed: ${String(failure)}. Recovery required: ${failures.join("; ")}. ` +
      `Remaining paths: ${location(from)}, ${location(to)}, ${location(trashIndexPath())}; ${configState}.`, { cause: failure });
  }
  throw failure;
}

/** A stale live config key or directory may be the only path back to a failed operation. */
function trashRecoveryConflict(dirId: string, liveProfiles: Record<string, unknown>): boolean {
  return Object.hasOwn(liveProfiles, dirId) || pathKind(path.join(getProfilesDir(), dirId)) !== "missing";
}

/** Directory presence alone cannot prove a prior recursive purge left intact data. */
export function listTrashedProfiles(): Array<TrashEntry & { recoverable: boolean; incomplete: boolean; recoveryRequired: boolean }> {
  const entries = readTrashIndex();
  const liveProfiles = getConfig().browserProfiles || {};
  return entries.map((entry) => {
    const recoveryRequired = trashRecoveryConflict(entry.dirId, liveProfiles);
    const incomplete = entry.deletionAttempted === true;
    const kind = pathKind(path.join(trashRoot(), entry.dirId));
    return {
      ...entry,
      incomplete,
      recoveryRequired,
      recoverable: !recoveryRequired && !incomplete && kind === "directory",
    };
  });
}

/** Move a stopped profile into the trash, remove exactly its config key, commit index. */
export function trashBrowserProfile(dirId: string, opts?: { force?: boolean }): boolean {
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  validateDirId(dirId);
  assertProfileWritable(dirId, opts); // TE-05 lock remains enforced
  // Share export/restore/launch ownership, including any F09 compensation.
  const release = acquireRestoreLock(dirId);
  try {
    if (statusBrowser(dirId).running) throw new Error("Cannot delete profile while managed Chromium is running");

    const entries = readTrashIndex(); // read and validate BEFORE any mutation
    const cfg = getConfig() as any;
    if (!Object.hasOwn(cfg.browserProfiles || {}, dirId)) throw new Error("Profile metadata is missing; cannot move it to trash");
    const meta = structuredClone(cfg.browserProfiles[dirId]);
    const newEntry: TrashEntry = { dirId, name: meta?.name || dirId.slice(0, 8), deletedAt: Date.now(), meta };
    const profileDir = path.join(getProfilesDir(), dirId);
    const target = path.join(trashRoot(), dirId);
    if (pathKind(profileDir) !== "directory") throw new Error("Profile data directory is missing or is not a real directory");
    if (entries.some((entry) => entry.dirId === dirId) || pathKind(target) !== "missing") {
      throw new Error("A trashed copy with that id already exists; refusing to replace it");
    }
    validateTrashIndex([...entries, newEntry]); // reject invalid snapshots BEFORE moving any data
    fs.mkdirSync(trashRoot(), { recursive: true, mode: 0o700 });
    fs.renameSync(profileDir, target);
    let configCommitted = false;
    try {
      transact((draft: any) => {
        if (!Object.hasOwn(draft.browserProfiles || {}, dirId)) throw new Error("Profile metadata disappeared during trash");
        delete draft.browserProfiles[dirId];
      });
      configCommitted = true;
      writeTrashIndex([...entries, newEntry]);
    } catch (error) {
      compensateTrashMove(error, dirId, target, profileDir, configCommitted ? () => {
        transact((draft: any) => {
          draft.browserProfiles = draft.browserProfiles || {};
          if (Object.hasOwn(draft.browserProfiles, dirId)) throw new Error("Profile id occupied during trash compensation");
          draft.browserProfiles[dirId] = meta;
        });
      } : undefined);
    }
    recordAudit({ category: "profile", action: "trash", target: dirId, actor: "user",
      detail: `moved to trash as "${meta.name || dirId.slice(0, 8)}" (recoverable for 7 days)` });
    return true;
  } finally {
    release();
  }
}

/** Restore only into an unoccupied live config key AND directory. */
export function restoreTrashedProfile(dirId: string): boolean {
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  validateDirId(dirId);
  const release = acquireRestoreLock(dirId);
  try {
    const entries = readTrashIndex();
    const entry = entries.find((value) => value.dirId === dirId);
    if (!entry) throw new Error("That profile is no longer in the trash");
    const source = path.join(trashRoot(), dirId);
    const profileDir = path.join(getProfilesDir(), dirId);
    if (entry.deletionAttempted) throw new Error("Trashed profile data may be incomplete after a purge attempt; cannot restore it as complete. Review and delete remaining files manually.");
    if (pathKind(source) !== "directory") throw new Error("The trashed profile data is missing or not a real directory");
    if (Object.hasOwn(getConfig().browserProfiles || {}, dirId) || pathKind(profileDir) !== "missing") {
      throw new Error("A profile with that id already exists");
    }

    fs.mkdirSync(getProfilesDir(), { recursive: true, mode: 0o700 });
    fs.renameSync(source, profileDir);
    let configCommitted = false;
    try {
      transact((draft: any) => {
        draft.browserProfiles = draft.browserProfiles || {};
        if (Object.hasOwn(draft.browserProfiles, dirId)) throw new Error("Profile id occupied during restore");
        draft.browserProfiles[dirId] = entry.meta
          ? { ...entry.meta, dirId, createdAt: entry.meta.createdAt ?? Date.now() }
          : { dirId, name: entry.name, createdAt: Date.now(), engine: "chromium" };
      });
      configCommitted = true;
      writeTrashIndex(entries.filter((value) => value.dirId !== dirId));
    } catch (error) {
      compensateTrashMove(error, dirId, profileDir, source, configCommitted ? () => {
        transact((draft: any) => {
          if (!Object.hasOwn(draft.browserProfiles || {}, dirId)) throw new Error("Restored metadata disappeared during compensation");
          delete draft.browserProfiles[dirId];
        });
      } : undefined);
    }
    recordAudit({ category: "profile", action: "restore", target: dirId, actor: "user", detail: `restored "${entry.name}"` });
    return true;
  } finally {
    release();
  }
}

/** Irreversible deletion: only remove the index entry after rm succeeded. */
export function purgeTrashedProfile(dirId: string): boolean {
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  validateDirId(dirId);
  const release = acquireRestoreLock(dirId);
  try {
    const entries = readTrashIndex();
    const entry = entries.find((value) => value.dirId === dirId);
    if (!entry) throw new Error("That profile is not in the trash");
    const target = path.join(trashRoot(), dirId);
    if (trashRecoveryConflict(dirId, getConfig().browserProfiles || {})) {
      throw new Error(`Recovery required: live config or directory still occupies ${dirId}; refusing to delete ${target}`);
    }
    const kind = pathKind(target);
    if (kind === "other") throw new Error(`Refusing to purge non-directory trash path: ${target}`);
    if (kind === "directory") {
      // Persist uncertainty BEFORE recursive deletion: a partial rm (or process
      // restart before the final index commit) must never advertise restoration.
      if (!entry.deletionAttempted) {
        try { writeTrashIndex(entries.map((value) => value.dirId === dirId ? { ...value, deletionAttempted: true } : value)); }
        catch (error) { throw new Error(`Failed to mark trash data incomplete at ${target}; no deletion attempted: ${String(error)}`, { cause: error }); }
      }
      try { fs.rmSync(target, { recursive: true }); }
      catch (error) { throw new Error(`Failed to remove trashed data at ${target}; data may be partially removed: ${String(error)}`, { cause: error }); }
    }
    try { writeTrashIndex(entries.filter((value) => value.dirId !== dirId)); }
    catch (error) { throw new Error(`Trash index update failed after deleting ${target}; data may already be removed (no rollback): ${String(error)}`, { cause: error }); }
    recordAudit({ category: "profile", action: "purge", target: dirId, actor: "user", detail: `permanently deleted "${entry.name}" from trash` });
    return true;
  } finally {
    release();
  }
}

/** Sweep one entry at a time: only committed removals count as purged. */
export function purgeExpiredTrash(ttlMs: number = TRASH_TTL_MS): string[] {
  const cutoff = Date.now() - ttlMs;
  let entries = readTrashIndex();
  const purged: string[] = [];
  const failures: string[] = [];
  for (const entry of entries.slice()) {
    if (entry.deletedAt >= cutoff) continue;
    const target = path.join(trashRoot(), entry.dirId);
    let release: () => void;
    try { release = acquireRestoreLock(entry.dirId); }
    catch (error) {
      failures.push(`${entry.dirId}: restore/export lock unavailable at ${target}; no deletion attempted: ${String(error)}`);
      continue;
    }
    try {
      let kind: ReturnType<typeof pathKind>;
      try {
        if (trashRecoveryConflict(entry.dirId, getConfig().browserProfiles || {})) {
          failures.push(`${entry.dirId}: recovery required; live config or directory still exists; retained ${target}`);
          continue;
        }
        if (entry.deletionAttempted) {
          failures.push(`${entry.dirId}: recovery required; earlier purge may have left incomplete data at ${target}; manual review needed`);
          continue;
        }
        kind = pathKind(target);
        if (kind === "other") throw new Error("not a real directory");
      } catch (error) {
        failures.push(`${entry.dirId}: inspection failed at ${target}; no deletion attempted: ${String(error)}`);
        continue;
      }
      if (kind === "directory") {
        try {
          const marked = entries.map((value) => value.dirId === entry.dirId ? { ...value, deletionAttempted: true as const } : value);
          writeTrashIndex(marked);
          entries = marked;
        } catch (error) {
          failures.push(`${entry.dirId}: pre-delete index update failed at ${target}; no deletion attempted: ${String(error)}`);
          continue;
        }
        try { fs.rmSync(target, { recursive: true }); }
        catch (error) {
          failures.push(`${entry.dirId}: removal failed at ${target}; data may be partially removed: ${String(error)}`);
          continue;
        }
      }
      try {
        writeTrashIndex(entries.filter((value) => value.dirId !== entry.dirId));
        entries = entries.filter((value) => value.dirId !== entry.dirId);
        purged.push(entry.dirId);
      } catch (error) {
        failures.push(`${entry.dirId}: index update failed after deletion at ${target}; data may already be removed: ${String(error)}`);
      }
    } finally {
      release();
    }
  }
  if (failures.length) {
    throw new Error(`Expired trash sweep partially failed: ${purged.length} committed purge(s) [${purged.join(", ")}]; ` +
      `${failures.length} failure(s), index entries retained for review or manual retry: ${failures.join("; ")}`);
  }
  return purged;
}

export function deleteBrowserProfile(dirId: string, opts?: { force?: boolean }): boolean {
  // Team RBAC: viewers are read-only.
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);

  validateDirId(dirId);
  // TE-05: honour another device's checkout lock on the hard-delete path too.
  assertProfileWritable(dirId, opts);
  const release = acquireRestoreLock(dirId);
  try {
    const st = statusBrowser(dirId);
    if (st.running) throw new Error("Cannot delete profile while managed Chromium is running");
    const profileDir = path.join(getProfilesDir(), dirId);
    try {
      if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (e: any) {
      throw new Error(`Failed to remove profile directory: ${e?.message || String(e)}`);
    }
    // Single write path (no swallowed catch/boolean): a failed transact
    // surfaces its error so callers can tell "rm failed" from "save failed".
    let deleted = false;
    transact((draft: any) => {
      if (draft.browserProfiles?.[dirId]) { delete draft.browserProfiles[dirId]; deleted = true; }
    });
    return deleted;
  } finally {
    release();
  }
}

export function listBrowserProfiles(runtime: ProfileRuntimeSnapshot = getProfileRuntimeSnapshot()): BrowserProfile[] {
  const cfg = getConfig() as any;
  const profiles = cfg.browserProfiles || {};
  const result: BrowserProfile[] = [];
  for (const [dirId, meta] of Object.entries(profiles)) {
    const m = meta as any;
    const st = statusBrowser(dirId);
    const profileDir = path.join(getProfilesDir(), dirId);
    const lastModified = fs.existsSync(profileDir) ? Math.floor(fs.statSync(profileDir).mtimeMs) : 0;
    const syncState = readProfileSyncState(dirId, m);
    const resolvedProxy = resolveProfileProxy(dirId);
    const engine = sanitizeBrowserEngine(m.engine);
    result.push({
      dirId,
      name: m.name || dirId.slice(0, 8),
      version: engine === "firefox"
        ? (normalizeManagedFirefoxVersion(m.browserVersion) || runtime.firefoxVersion || "?")
        : (normalizeManagedChromiumVersion(m.browserVersion) || runtime.chromiumVersion || "?"),
      // Engine-aware pin display (R4): a Firefox "154.0" pin must not go
      // through the Chromium 4-segment validator (it throws and breaks the
      // entire profile list).
      browserVersion: engine === "firefox"
        ? normalizeManagedFirefoxVersion(m.browserVersion)
        : normalizeManagedChromiumVersion(m.browserVersion),
      engine,
      fingerprintMode: normalizeFingerprintMode(m.fingerprintMode),
      allowThirdPartyCookies: normalizeBoolean(m.allowThirdPartyCookies, "third-party cookie compatibility"),
      drm: normalizeBoolean(m.drm, "drm"),
      fingerprintSeed: m.fingerprintSeed || 12345,
      platform: m.platform || "windows",
      timezone: m.timezone || null,
      locale: m.locale || null,
      webrtcMode: normalizeWebRtcMode(m.webrtcMode, m.webrtcIp),
      webrtcIp: m.webrtcIp || null,
      geolocationMode: normalizeGeolocationMode(m.geolocationMode),
      geolocationLatitude: normalizeOptionalNumber(m.geolocationLatitude, -90, 90, "geolocation latitude"),
      geolocationLongitude: normalizeOptionalNumber(m.geolocationLongitude, -180, 180, "geolocation longitude"),
      geolocationAccuracy: normalizeOptionalNumber(m.geolocationAccuracy, 0, 100000, "geolocation accuracy"),
      gpuVendor: m.gpuVendor || null,
      gpuRenderer: m.gpuRenderer || null,
      hardwareConcurrency: Number.isInteger(m.hardwareConcurrency) ? m.hardwareConcurrency : null,
      deviceMemory: Number.isInteger(m.deviceMemory) ? m.deviceMemory : null,
      screenWidth: Number.isInteger(m.screenWidth) ? m.screenWidth : null,
      screenHeight: Number.isInteger(m.screenHeight) ? m.screenHeight : null,
      storageQuota: Number.isInteger(m.storageQuota) ? m.storageQuota : null,
      taskbarHeight: Number.isInteger(m.taskbarHeight) ? m.taskbarHeight : null,
      fontsDir: m.fontsDir || null,
      renderScaleMode: m.renderScaleMode === "strict" ? "strict" : "native",
      // B2 (#107): the edit form reads windowTitlePrefix to decide the
      // checkbox state — omitting it made the checkbox always-on and every
      // save clobbered the stored prefix via setMeta.
      windowTitlePrefix: m.windowTitlePrefix === null ? null : (m.windowTitlePrefix || undefined),
      appUrl: m.appUrl || null,
      proxyMode: resolvedProxy.mode,
      proxyName: resolvedProxy.name,
      note: m.note || null,
      tags: normalizeTags(m.tags),
      preset: m.preset || null,
      ...syncState,
      lastModified,
      lock: m.lock || null,
      running: st.running,
      pid: st.pid,
      cdpPort: st.cdpPort,
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// Launch / Stop
// ═══════════════════════════════════════════════════════════════

/**
 * Shared proxy fail-closed gate (review item PL-04, R2 #46): if the profile
 * asked for a proxy and none is resolvable, launching would silently fall
 * back to a direct connection and expose the host IP. Both the Chromium and
 * the Firefox paths must call this before writing prefs / spawning.
 */
export function assertProxyResolvable(meta: any, cfg: any, resolvedProxy: { mode: string; name?: string | null; config: any }): void {
  const declaredProxyMode = String(meta.proxyMode || (meta.proxyName ? "named" : "none"));
  const proxyWasRequested = declaredProxyMode !== "none" && declaredProxyMode !== "off";
  const defaultModeUnconfigured = declaredProxyMode === "default" && !cfg.defaultProxy;
  if (proxyWasRequested && !defaultModeUnconfigured && (!resolvedProxy.config || resolvedProxy.mode === "none")) {
    const label = resolvedProxy.name || meta.proxyName || cfg.defaultProxy || declaredProxyMode;
    const health = getProxyHealthEntry(String(label));
    const when = health?.lastCheckedAt ? new Date(health.lastCheckedAt).toISOString() : "never checked";
    const reason = !label || label === declaredProxyMode
      ? declaredProxyMode === "default"
        ? "no default proxy is configured"
        : "the named proxy no longer exists"
      : "it is not configured";
    throw new Error(
      `Profile requires proxy "${label}" but ${reason}. ` +
      `Refusing to launch without it — a direct connection would expose your real IP. ` +
      `(proxy: ${label}, last health check: ${when})`,
    );
  }
  if (resolvedProxy.mode !== "none" && !resolvedProxy.config) {
    const label = resolvedProxy.name ? `"${resolvedProxy.name}"` : resolvedProxy.mode;
    throw new Error(`Profile proxy ${label} is not configured; refusing to launch without the requested proxy`);
  }
}

/**
 * Shared launch-time proxy liveness gate (R10 product P1-1/P1-2): after
 * assertProxyResolvable passes, refuse when the proxy is known-unhealthy
 * (consecutive health failures) or fails a TCP liveness probe. Both the
 * Chromium and Firefox paths must call this before spawning — a configured-
 * but-dead proxy used to launch a browser that could never load a page,
 * with the blame landing on engine/network instead of the proxy.
 */
/**
 * Shared pre-launch consistency gate (R11 P1-4 item 3): timezone / locale /
 * WebRTC vs proxy warnings land in audit on both engines. Blocks only under
 * the same opt-in flags as the Chromium path. Firefox previously skipped
 * this entirely, so identity/proxy mismatches launched silently there.
 */
export function runConsistencyGate(
  dirId: string,
  cfg: any,
  opts: {
    passThrough: boolean;
    timezone: any; locale: any; webrtcIp: any; platform: any;
    proxyMode: any; proxyGeo: any;
  },
): void {
  const consistency = opts.passThrough ? { ok: true, warnings: [], blockers: [] } : checkProfileConsistency({
    timezone: opts.timezone, locale: opts.locale,
    webrtcIp: opts.webrtcIp,
    platform: opts.platform,
    proxyMode: opts.proxyMode,
    proxyGeo: opts.proxyGeo,
  }, { blockOnProxyRisk: cfg.blockOnProxyRisk === true });
  for (const w of consistency.warnings) recordAudit({ category: "profile", action: "consistency-warning", target: dirId, detail: `${w.code}: ${w.message}` });
  if (!consistency.ok) {
    for (const b of consistency.blockers) recordAudit({ category: "profile", action: "consistency-blocker", target: dirId, detail: `${b.code}: ${b.message}` });
    const proxyRiskBlocker = consistency.blockers.some((b) => b.code === "proxy-idc" || b.code === "proxy-anonymous");
    const otherBlocker = consistency.blockers.some((b) => b.code !== "proxy-idc" && b.code !== "proxy-anonymous");
    if ((cfg.blockOnProxyRisk && proxyRiskBlocker) || (cfg.blockOnConsistencyConflict && otherBlocker)) {
      throw new Error(`Launch blocked by consistency check: ${consistency.blockers.map((b) => b.message).join("; ")}`);
    }
  }
}

export async function assertProxyLaunchable(
  dirId: string,
  resolvedProxy: { mode: string; name?: string | null; config: any },
  cfg?: any,
  opts?: { forceDeadProxy?: boolean },
): Promise<void> {
  // R12: unhealthy-history is warn-by-default like every other gate
  // (consistency/env/drift all default to warn). A stale failure record must
  // not permanently brick launches — the live TCP probe below is the hard
  // signal. Opt in to hard blocking with blockOnUnhealthyProxy=true.
  if (resolvedProxy.name) {
    const health = getProxyHealthEntry(resolvedProxy.name);
    if (health && health.consecutiveFailures > 0) {
      const when = health.lastCheckedAt ? new Date(health.lastCheckedAt).toISOString() : "never checked";
      const blocked = cfg?.blockOnUnhealthyProxy === true;
      recordAudit({
        category: "proxy",
        action: blocked ? "launch-blocked-unhealthy-proxy" : "launch-with-unhealthy-proxy",
        target: resolvedProxy.name,
        actor: "auto",
        detail: `profile ${dirId.slice(0, 8)}: ${health.consecutiveFailures} consecutive failure(s), risk=${health.risk}, last check ${when}`,
      });
      if (blocked) {
        throw new Error(
          `Profile proxy "${resolvedProxy.name}" is unhealthy (${health.consecutiveFailures} consecutive failure(s), last health check: ${when}). ` +
          `Refusing to launch a browser that cannot load pages — fix the proxy or assign a healthy one.`,
        );
      }
      console.warn(
        `[agent-browser] profile ${dirId.slice(0, 8)} launching through unhealthy proxy "${resolvedProxy.name}" ` +
        `(${health.consecutiveFailures} consecutive failure(s), last check ${when}); set blockOnUnhealthyProxy=true to refuse`,
      );
    }
  }
  if (resolvedProxy.config?.host && resolvedProxy.config?.port) {
    const alive = await probeProxyPort(resolvedProxy.config, 3000);
    if (!alive) {
      const label = resolvedProxy.name || `${resolvedProxy.config.host}:${resolvedProxy.config.port}`;
      const health = resolvedProxy.name ? getProxyHealthEntry(resolvedProxy.name) : null;
      const when = health?.lastCheckedAt ? new Date(health.lastCheckedAt).toISOString() : "never checked";
      // R12 P1-1: explicit escape hatch — the UI asks for a second confirm
      // ("I know the proxy is dead") and passes forceDeadProxy. Audited.
      if (opts?.forceDeadProxy === true) {
        recordAudit({
          category: "proxy",
          action: "launch-force-dead-proxy",
          target: label,
          actor: "user",
          detail: `profile ${dirId.slice(0, 8)}: user forced launch despite failed TCP probe to ${resolvedProxy.config.host}:${resolvedProxy.config.port}`,
        });
        return;
      }
      recordAudit({
        category: "proxy",
        action: "launch-blocked-dead-proxy",
        target: label,
        actor: "auto",
        detail: `profile ${dirId.slice(0, 8)}: TCP probe to ${resolvedProxy.config.host}:${resolvedProxy.config.port} failed, last health check: ${when}`,
      });
      const err: any = new Error(
        `Profile proxy "${label}" is unreachable (${resolvedProxy.config.host}:${resolvedProxy.config.port} refused the connection). ` +
        `Refusing to launch — check the proxy process and port (last health check: ${when}).`,
      );
      err.code = "PROXY_UNREACHABLE";
      throw err;
    }
  }
}

export interface LaunchDriftCheck {
  checked: boolean;
  risky?: boolean;
  drift?: FingerprintDrift[];
  error?: string;
}

export interface LaunchEnvCheck {
  checked: boolean;
  high?: boolean;
  findings?: EnvRiskFinding[];
  error?: string;
}

export interface LaunchCookieCheck {
  checked: boolean;
  applied?: number;
  pending?: number;
  error?: string;
}

export async function launchBrowser(
  dirId: string,
  opts?: { headless?: boolean; forceDeadProxy?: boolean },
): Promise<{ pid: number; cdpPort: number; driftCheck: LaunchDriftCheck; envCheck: LaunchEnvCheck; cookieCheck?: LaunchCookieCheck }> {
  validateDirId(dirId);
  if (!isManagedProfileId(dirId)) {
    throw new Error(`Profile ${dirId.slice(0, 8)} is not a managed Chromium profile`);
  }
  let releaseLaunchLock: (() => void) | null = null;
  let pendingNativeProxyAuth: NativeProxyAuthFile | null = null;
  let pendingProxyBridge: { close: () => Promise<void> } | null = null;
  try {
    releaseLaunchLock = acquireRestoreLock(dirId);
  } catch {
    throw new Error(`Profile ${dirId.slice(0, 8)} is being restored; launch is temporarily blocked`);
  }

  try {
  // Keep startup identity intent stable across the asynchronous preparation.
  const cfg = structuredClone(getConfig()) as any;
  const meta = cfg.browserProfiles?.[dirId];
  if (!meta) throw new Error(`Managed Chromium profile not found: ${dirId}`);

  // Authoritative even for already-running profiles. This is deliberately
  // before reuse/discovery, proxy resolution, profile writes, or any spawn.
  assertHostPlatformCompatible(meta);
  const engine = sanitizeBrowserEngine(meta.engine);
  const fingerprintMode = normalizeFingerprintMode(meta.fingerprintMode);
  const passThrough = fingerprintMode === "off";
  const profileDir = path.join(getProfilesDir(), dirId);
  const configuredBin = cfg.chromiumBin && cfg.chromiumBin !== "auto" ? cfg.chromiumBin : null;
  const envBin = getChromiumBinaryOverride();
  const diagnosticNetLogRequest = {
    appDataDir: process.env.AGENT_BROWSER_DIAGNOSTIC_APP_DATA_DIR,
    filePath: process.env.AGENT_BROWSER_DIAGNOSTIC_NETLOG_FILE,
    ...(process.env.AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE !== undefined
      ? { mode: process.env.AGENT_BROWSER_DIAGNOSTIC_NETLOG_MODE } : {}),
  };
  if (engine !== "chromium" && diagnosticNetLogRequest.mode !== undefined) {
    throw new Error("Invalid Chromium diagnostic NetLog: mode requires a Chromium profile");
  }
  if (engine === "chromium") assertChromiumReuseDnsCompatible(meta, cfg);
  let gpuContext: ChromiumGpuContext | undefined;
  let gpuContextBinary: string | null = null;
  let requestHash = engine === "chromium"
    ? chromiumLaunchRequestHash(meta, cfg, { headless: opts?.headless, binaryOverride: envBin })
    : null;
  const assertCurrentRequest = () => {
    if (gpuContextBinary && readChromiumGpuContext(gpuContextBinary).kernelArchitecture !== gpuContext?.kernelArchitecture) {
      throw restartRequired("Chromium GPU policy eligibility changed during preparation");
    }
    const current = getConfig();
    const currentMeta = current.browserProfiles?.[dirId];
    let matches = false;
    try {
      matches = Boolean(currentMeta) && chromiumLaunchRequestHash(currentMeta!, current, {
        headless: opts?.headless, binaryOverride: getChromiumBinaryOverride(), gpuContext,
      }) === requestHash;
    } catch {
      throw restartRequired("startup identity request became invalid during preparation");
    }
    if (!matches) throw restartRequired("startup identity request changed during preparation");
  };
  const bindGpuContext = (executablePath: string) => {
    assertCurrentRequest();
    gpuContextBinary = passThrough ? null : executablePath;
    gpuContext = passThrough ? undefined : readChromiumGpuContext(executablePath);
    requestHash = chromiumLaunchRequestHash(meta, cfg, {
      headless: opts?.headless, binaryOverride: envBin, gpuContext,
    });
    assertCurrentRequest();
  };

  let existing = runningProcesses.get(dirId);
  if (existing) {
    // Only an actual dead-PID result clears a cached entry. Validation errors
    // must never fall through this catch and spawn another live profile.
    try { process.kill(existing.pid, 0); }
    catch (error: any) {
      if (error?.code !== "ESRCH") throw restartRequired("cached process liveness could not be verified");
      runningProcesses.delete(dirId);
      existing = undefined;
    }
  }

  if (engine === "firefox") {
    const requestOptions = () => ({ headless: opts?.headless, binaryOverride: getFirefoxBinaryOverride(),
      managedRoot: getManagedFirefoxRoot(), nativeRequested: firefoxNativeModeRequested() });
    const firefoxRequestHash = firefoxLaunchRequestHash(meta, cfg, requestOptions());
    const assertFirefoxRequest = () => {
      // Gecko treats presence (even "0" or an empty string) as disabling the
      // content sandbox; prefs alone cannot restore its secure default.
      if (process.env.MOZ_DISABLE_CONTENT_SANDBOX !== undefined) {
        throw new Error("Firefox cannot launch with MOZ_DISABLE_CONTENT_SANDBOX set; remove it and restart Studio.");
      }
      const current = getConfig();
      const requested = current.browserProfiles?.[dirId];
      if (!requested || firefoxLaunchRequestHash(requested, current, requestOptions()) !== firefoxRequestHash) {
        throw restartRequired("Firefox startup identity request changed during preparation");
      }
    };
    assertFirefoxRequest();
    if (existing?.stopping) throw restartRequired("the Firefox profile is still stopping");
    if (existing?.engine === "chromium" || existing?.launchProvenance) throw restartRequired("profile engine changed from Chromium to Firefox");
    const observed = inspectBrowserLaunchesSync(profileDir, existing?.pid);
    if (!observed.available) throw restartRequired("Firefox process discovery is unavailable");
    if (observed.candidates.length > 1) throw restartRequired("multiple processes claim this Firefox profile");
    if (observed.tracked?.engine === "chromium" || observed.candidates.some((entry) => entry.engine === "chromium")) {
      throw restartRequired("profile engine changed while a Chromium browser is still running");
    }
    const candidate = observed.candidates[0];
    if (existing) {
      const child = existing.process;
      const owned = child && ownedFirefoxLaunches.get(child);
      if (!owned || owned.requestHash !== firefoxRequestHash) throw restartRequired("Firefox startup intent is changed or not owned by this Studio session");
      if (existing.engine !== "firefox" || !candidate || candidate.malformed || candidate.engine !== "firefox" ||
          candidate.pid !== existing.pid || observed.tracked?.pid !== existing.pid || child.pid !== existing.pid ||
          child.exitCode !== null || child.signalCode !== null || child.killed ||
          candidate.profileDirs.length !== 1 || candidate.cdpPorts.length !== 1 || candidate.cdpPorts[0] !== existing.port ||
          normalizeBrowserProcessPath(candidate.profileDirs[0]) !== normalizeBrowserProcessPath(profileDir) ||
          normalizeBrowserProcessPath(owned.profileDir) !== normalizeBrowserProcessPath(profileDir) ||
          normalizeBrowserProcessPath(candidate.executablePath) !== normalizeBrowserProcessPath(owned.executablePath) ||
          firefoxLaunchDigest(JSON.stringify(child.spawnargs)) !== owned.argvHash) {
        throw restartRequired("Firefox PID, executable, profile, port or launch arguments no longer match");
      }
      const assertOwnedFiles = async () => {
        const selectedBinary = await findFirefoxBinaryAsync();
        if (!selectedBinary || normalizeBrowserProcessPath(selectedBinary) !== normalizeBrowserProcessPath(owned.executablePath) ||
            await getFirefoxNativeSelectionIdentityAsync(selectedBinary) !== owned.binaryIdentity) {
          throw restartRequired("the selected Firefox binary changed or cannot be verified");
        }
        assertFirefoxRequest();
        try {
          if (firefoxLaunchDigest(fs.readFileSync(path.join(profileDir, "user.js"))) !== owned.userJsHash) {
            throw new Error("startup preferences changed");
          }
        } catch { throw restartRequired("Firefox startup preferences changed or cannot be read back"); }
      };
      await assertOwnedFiles();
      const connection = getRegisteredFirefoxSession(existing.port);
      if (!connection || connection !== owned.connection || connection !== existing.bidiConn || connection.closed) {
        throw restartRequired("the Firefox preload/automation session is no longer live");
      }
      try {
        const endpoint = new URL(connection.wsUrl);
        if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || Number(endpoint.port) !== existing.port) throw new Error("wrong endpoint");
        const tree = await connection.send("browsingContext.getTree", {}, 1500);
        if (!Array.isArray(tree?.contexts) || !tree.contexts.length) throw new Error("no live browser context");
      } catch { throw restartRequired("the Firefox BiDi session could not be verified"); }
      const assertOwnedSession = () => {
        if (runningProcesses.get(dirId) !== existing || existing.stopping || connection.closed ||
            getRegisteredFirefoxSession(existing.port) !== connection || existing.bidiConn !== connection ||
            child.killed || child.exitCode !== null || child.signalCode !== null) {
          throw restartRequired("the Firefox process changed during reuse verification");
        }
      };
      await assertOwnedFiles();
      assertOwnedSession();
      const resolvedProxy = resolveFirefoxProxy(dirId, meta, cfg);
      assertFirefoxProxyCurrent(dirId, meta, resolvedProxy);
      const effective = await resolveFirefoxLaunchIdentity(meta, resolvedProxy, assertFirefoxRequest);
      assertFirefoxProxyCurrent(dirId, meta, resolvedProxy);
      if (firefoxEffectiveLaunchHash(effective.meta, resolvedProxy) !== owned.effectiveHash) {
        throw restartRequired("Firefox effective timezone, locale or proxy route changed");
      }
      await assertOwnedFiles();
      assertOwnedSession();
      assertReusableProcessAlive(existing.pid);
      assertFirefoxProxyCurrent(dirId, meta, resolvedProxy);
      existing.lastActivityAt = Date.now();
      return { pid: existing.pid, cdpPort: existing.port, driftCheck: { checked: false }, envCheck: { checked: false } };
    }
    // A persisted prefs file or a matching executable cannot prove which prefs
    // a different process loaded or whether its session still owns a preload.
    if (candidate || findBrowserByProfile(dirId)) throw restartRequired("the discovered Firefox process has no owned startup/session evidence");
    return await launchFirefoxProfile(dirId, meta, cfg, opts?.headless, null, {
      forceDeadProxy: opts?.forceDeadProxy === true, requestHash: firefoxRequestHash, assertCurrentRequest: assertFirefoxRequest,
    });
  }

  if (existing?.stopping) throw restartRequired("the profile browser is still stopping");
  if (existing?.engine === "firefox") throw restartRequired("profile engine changed from Firefox to Chromium");
  const observed = inspectBrowserLaunchesSync(profileDir, existing?.pid);
  if (!observed.available) throw restartRequired("browser process discovery is unavailable");
  if (observed.candidates.length > 1) throw restartRequired("multiple processes claim this profile directory");
  let candidate = observed.candidates[0];
  if (existing && (!candidate || candidate.pid !== existing.pid || observed.tracked?.pid !== candidate.pid)) {
    throw restartRequired("cached PID no longer identifies this profile's browser");
  }
  const owned = ownedChromiumLaunchEvidence(existing);
  if (owned && candidate) {
    const processProfileArg = candidate.args.find((arg) => arg.startsWith("--user-data-dir="));
    if (normalizeBrowserProcessPath(candidate.executablePath) !== normalizeBrowserProcessPath(owned.executablePath) ||
        !processProfileArg || normalizeBrowserProcessPath(processProfileArg.slice("--user-data-dir=".length)) !== normalizeBrowserProcessPath(profileDir) ||
        candidate.cdpPorts[0] !== existing?.port) throw restartRequired("owned process PID, executable, profile path, or port no longer matches");
    // A live owned ChildProcess retains real argv boundaries even when ps has
    // flattened a display-only name such as 'QA --lang=fr' into fake switches.
    candidate = owned;
  }
  if (candidate) {
    // Only bounded file headers are read here; no version subprocess or proxy
    // activity is needed to reject an old, otherwise self-consistent payload.
    bindGpuContext(configuredBin || envBin || candidate.executablePath);
    if (existing?.launchProvenance && existing.launchProvenance.requestHash !== requestHash) throw restartRequired("startup identity request changed");
    if (Object.values(diagnosticNetLogRequest).some((value) => value !== undefined)) {
      throw restartRequired("scoped NetLog diagnostics require a fresh process and cannot be armed on a reused browser");
    }
    // Reject changed/legacy/ambiguous inputs before binary probing or proxy I/O.
    assertChromiumLaunchProvenance(candidate.args, requestHash!, fingerprintMode);
    const expectedBin = configuredBin || envBin || (await findManagedChromiumBinaryAsync(normalizeManagedChromiumVersion(meta.browserVersion)))?.binaryPath;
    assertCurrentRequest();
    if (!expectedBin || !fs.existsSync(expectedBin)) throw restartRequired("the expected Chromium executable is unavailable");
    bindGpuContext(expectedBin);
    const provenance = assertChromiumReuseEvidence(candidate, {
      profileDir, executablePath: expectedBin, requestHash: requestHash!, mode: fingerprintMode,
      ...(existing ? { pid: existing.pid, port: existing.port, provenance: existing.launchProvenance } : {}),
    });
    if (!passThrough) validateBrowserHardwareProfile(meta, "chromium", gpuContext);
    assertReusableProcessAlive(candidate.pid);
    await assertReusableChromiumPort(candidate.cdpPorts[0]);
    assertCurrentRequest();
    assertReusableProcessAlive(candidate.pid);
    runningProcesses.set(dirId, {
      ...existing, pid: candidate.pid, process: existing?.process || null, port: candidate.cdpPorts[0],
      lastActivityAt: Date.now(), engine: "chromium", launchProvenance: provenance,
    });
    return { pid: candidate.pid, cdpPort: candidate.cdpPorts[0], driftCheck: { checked: false }, envCheck: { checked: false } };
  }

  if (!passThrough) validateBrowserHardwareProfile(meta, "chromium");
  const requestedVersion = normalizeManagedChromiumVersion(meta.browserVersion);
  const managedBin = (await findManagedChromiumBinaryAsync(requestedVersion))?.binaryPath || null;
  assertCurrentRequest();
  if (configuredBin && !fs.existsSync(configuredBin)) {
    throw new Error(`Configured Chromium binary does not exist: ${configuredBin}`);
  }
  if (envBin && !fs.existsSync(envBin)) {
    throw new Error(`AGENT_BROWSER_CHROMIUM_BINARY_PATH does not exist: ${envBin}`);
  }
  const overrideBin = configuredBin || envBin;
  if (requestedVersion && overrideBin) {
    const version = await detectBinaryVersionAsync(overrideBin);
    assertCurrentRequest();
    if (version !== requestedVersion) throw new Error(`Profile requires Chromium ${requestedVersion}, but the configured binary is ${version || "unknown"}`);
  }
  if (requestedVersion && !overrideBin && !managedBin) {
    const available = (await listManagedChromiumBinariesAsync()).map((candidate) => candidate.version).join(", ") || "none";
    throw new Error(`Chromium ${requestedVersion} is not installed; available managed versions: ${available}`);
  }
  const preferredBin = configuredBin || envBin || managedBin;
  if (!preferredBin) {
    throw new Error(
      "Managed Chromium is required. Install the independent patchset with " +
      "`npm run install:chromium -- /path/to/Chromium.app`; upstream wrapper fallback is disabled.",
    );
  }

  bindGpuContext(preferredBin);
  if (!passThrough) validateBrowserHardwareProfile(meta, "chromium", gpuContext);

  // Find free CDP port (retry once if the port is stolen between allocation and spawn)
  let cdpPort = await findFreePortWithRetry(1);
  assertCurrentRequest();
  const seed = normalizeFingerprintSeed(meta.fingerprintSeed || 12345);
  const platform = normalizePlatform(meta.platform || "windows");
  const resolvedProxy = resolveProfileProxySecret(dirId, cfg);
  // ── Fail closed on proxy resolution (review item PL-04) ──
  // The proxy is the whole point of the profile identity: if the profile asked
  // for one and we cannot produce a usable config, launching would silently
  // fall back to a direct connection and expose the host IP. Refuse instead,
  // and name the proxy plus its last health check so the user can act.
  // Shared with the Firefox path via assertProxyResolvable (R2 #46).
  assertProxyResolvable(meta, cfg, resolvedProxy);
  await assertProxyLaunchable(dirId, resolvedProxy, cfg, { forceDeadProxy: opts?.forceDeadProxy === true });
  assertCurrentRequest();
  // Health-based rotation: when the configured proxy was unhealthy and a
  // healthy fallback was selected, record it (health counters + audit) so the
  // rotation is visible and attributable.
  if (resolvedProxy.rotatedFrom && resolvedProxy.name && resolvedProxy.name !== resolvedProxy.rotatedFrom) {
    try {
      recordProxyRotation(resolvedProxy.rotatedFrom, resolvedProxy.name);
    } catch (e) {
      console.warn(`[agent-browser] failed to record proxy rotation:`, e);
    }
    recordAudit({
      category: "proxy",
      action: "rotate",
      target: resolvedProxy.rotatedFrom,
      actor: "auto",
      detail: `profile ${dirId} rotated to ${resolvedProxy.name} (${resolvedProxy.rotationReason || "unhealthy"})`,
    });
  }
  const activeProxy = resolvedProxy.config;
  let dnsPolicy: ReturnType<typeof resolveChromiumDnsPolicy>;
  try {
    dnsPolicy = resolveChromiumDnsPolicy(activeProxy, cfg.managedSecureDnsUrl);
    if (passThrough && dnsPolicy.route === "doh") {
      throw new Error("Explicit proxy DoH requires managed Chromium identity mode in this engine; fingerprint-off profiles use proxy-side DNS without identity overrides");
    }
  } catch (error) {
    recordAudit({ category: "profile", action: "dns-route", target: dirId, actor: "auto",
      detail: "failed: proxy DNS configuration is invalid or unsupported; browser was not spawned" });
    throw error;
  }
  const requestedWebRtcMode = passThrough ? "real" : normalizeWebRtcMode(meta.webrtcMode, meta.webrtcIp);
  const shouldResolveWebRtc = requestedWebRtcMode === "auto" || requestedWebRtcMode === "altered";
  console.log(`[agent-browser] Preparing profile ${dirId.slice(0, 8)} mode=${fingerprintMode} browser=${requestedVersion || "auto"}`);

  // Pre-launch consistency check (timezone / locale / WebRTC vs proxy). Warns
  // by default; blocks only when config.blockOnConsistencyConflict is set.
  // Shared with the Firefox path via runConsistencyGate (R11 P1-4, item 3).
  runConsistencyGate(dirId, cfg, {
    passThrough,
    timezone: meta.timezone, locale: meta.locale,
    webrtcIp: shouldResolveWebRtc ? meta.webrtcIp : null,
    platform: meta.platform,
    proxyMode: resolvedProxy.mode,
    proxyGeo: resolvedProxy.name ? getProxyDetection(resolvedProxy.name) : null,
  });

  const requestedArgs = buildBrowserLaunchArgs({
    profileDir,
    seed,
    platform,
    cdpPort,
    fingerprintMode,
    headless: opts?.headless,
  });
  // Geo-IP is resolved at most once per launch (even though both the
  // timezone/locale and the WebRTC exit-IP paths can consume it).
  let geoDetection: { timezone: string | null; locale: string | null; exitIp: string | null; detection: ProxyDetectionResult | null } | null = null;
  let effectiveTimezone = passThrough ? null : normalizeOptionalTimezone(meta.timezone);
  let effectiveLocale = passThrough ? null : normalizeOptionalLocale(meta.locale);
  let webrtcIp = shouldResolveWebRtc ? normalizeOptionalIp(meta.webrtcIp) : null;
  if (!passThrough) {
    if (activeProxy && (!effectiveTimezone || !effectiveLocale || (shouldResolveWebRtc && !webrtcIp))) {
      const target = resolvedProxy.name ? captureProxyDetectionTarget(resolvedProxy.name, activeProxy) : null;
      geoDetection = await resolveGeoFromProxy(activeProxy, target);
      assertCurrentRequest();
      if (target && geoDetection.detection) persistLaunchDetection(target, geoDetection.detection);
      if (!effectiveTimezone) effectiveTimezone = geoDetection.timezone;
      if (!effectiveLocale) effectiveLocale = geoDetection.locale;
      if (shouldResolveWebRtc && !webrtcIp) {
        webrtcIp = geoDetection.exitIp;
      }
    }
    if (!effectiveTimezone) effectiveTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    if (!effectiveLocale) effectiveLocale = normalizeOptionalLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  }
  console.log(`[agent-browser] Identity resolved for ${dirId.slice(0, 8)}: geoip=bounded locale=${effectiveLocale || "auto"} timezone=${effectiveTimezone || "auto"}`);
  if (!passThrough && webrtcIp) requestedArgs.push(`--fingerprint-webrtc-ip=${webrtcIp}`);
  if (activeProxy?.bypassList?.length) requestedArgs.push(`--proxy-bypass-list=${activeProxy.bypassList.join(";")}`);
  if (!passThrough) addHardwareFingerprintArgs(requestedArgs, meta);

  const launchPlan = {
    executablePath: preferredBin,
    args: dedupeChromeArgs([
      ...requestedArgs,
      ...(!passThrough && effectiveTimezone ? [`--fingerprint-timezone=${effectiveTimezone}`] : []),
      ...(!passThrough && effectiveLocale ? [`--lang=${effectiveLocale}`, `--fingerprint-locale=${effectiveLocale}`] : []),
    ]),
    env: process.env,
  };
  console.log(`[agent-browser] Managed Chromium launch plan ready for ${dirId.slice(0, 8)}`);
  const bin = launchPlan.executablePath;
  if (!fs.existsSync(bin)) throw new Error("Managed Chromium binary is unavailable after selection");
  const nativeChromiumVersion = await detectBinaryVersionAsync(bin);
  assertCurrentRequest();
  if (requestedVersion && nativeChromiumVersion !== requestedVersion) {
    throw new Error(`Profile requires Chromium ${requestedVersion}, resolved ${nativeChromiumVersion || "unknown"}`);
  }
  let args = [...(launchPlan.args || [])];
  if (passThrough) args = stripManagedFingerprintArgs(args);
  if (supportsGoogleApiKeyInfoBarSuppression(bin)) {
    args = dedupeChromeArgs([
      ...args,
      NATIVE_SUPPRESS_GOOGLE_API_KEY_INFOBAR_SWITCH,
    ]);
  }

  // Resolve the exit identity through our bounded proxy detector. Explicit
  // altered mode must never
  // silently degrade to real-IP WebRTC.
  if (shouldResolveWebRtc && !webrtcIp) {
    webrtcIp = normalizeOptionalIp(getLaunchArgValue(args, "--fingerprint-webrtc-ip"));
    if (!webrtcIp && activeProxy) {
      if (!geoDetection) {
        const target = resolvedProxy.name ? captureProxyDetectionTarget(resolvedProxy.name, activeProxy) : null;
        geoDetection = await resolveGeoFromProxy(activeProxy, target);
        assertCurrentRequest();
        if (target && geoDetection.detection) persistLaunchDetection(target, geoDetection.detection);
      }
      webrtcIp = geoDetection.exitIp;
      assertCurrentRequest();
    }
  }
  if (requestedWebRtcMode === "altered" && !webrtcIp) {
    throw new Error("WebRTC altered mode requires a custom IP or a proxy with a detectable exit IP");
  }
  const effectiveWebRtcMode = requestedWebRtcMode === "auto"
    ? (webrtcIp ? "altered" : "real")
    : requestedWebRtcMode;

  // Our Chromium fork consumes one versioned, base64url JSON identity. Add it
  // after bounded proxy resolution so native WebRTC uses the final exit IP.
  if (!passThrough) {
    const nativeFingerprintMeta = {
      ...meta,
      fingerprintSeed: seed,
      platform,
      timezone: effectiveTimezone,
      locale: effectiveLocale,
      webrtcMode: effectiveWebRtcMode,
      webrtcIp,
    };
    // Fixed proxies resolve origin hostnames at egress by default. Only an
    // explicit, validated provider selects the engine's strict proxy DoH path.
    const managedSecureDns = dnsPolicy.secureDns;
    const nativeFingerprint = buildBrowserFingerprintConfig(
      nativeFingerprintMeta,
      nativeChromiumVersion,
      managedSecureDns,
      "chromium",
      gpuContext,
    );
    const fingerprintSwitch = supportsAgentBrowserFingerprintConfig(bin)
      ? AGENT_BROWSER_FINGERPRINT_SWITCH
      : LEGACY_FINGERPRINT_SWITCH;
    args.push(fingerprintSwitch + encodeBrowserFingerprintConfig(nativeFingerprint));
    args.push(`--user-agent=${nativeFingerprint.userAgent}`);
    // Raster scale: `native` renders at the host's real scale factor (crisp on
    // HiDPI/Retina) while the fork still reports the persona's devicePixelRatio
    // to JS; `strict` forces the raster scale to the spoofed DPR for maximum
    // identity consistency at the cost of upscaled, blurry output on HiDPI.
    const renderScaleFactor = resolveRenderScaleFactor(
      meta.renderScaleMode,
      nativeFingerprint.screen.devicePixelRatio,
      detectHostScaleFactor(),
    );
    args = dedupeChromeArgs([
      ...args,
      `--window-size=${nativeFingerprint.screen.outerWidth},${nativeFingerprint.screen.outerHeight}`,
      `--window-position=${nativeFingerprint.screen.windowX},${nativeFingerprint.screen.windowY}`,
      `--force-device-scale-factor=${renderScaleFactor}`,
    ]);
    args = applyManagedNativeRefreshRate(args);
  }

  if (activeProxy) {
    recordAudit({ category: "profile", action: "dns-route", target: dirId, actor: "auto",
      detail: dnsPolicy.route === "doh"
        ? "configured: strict proxy DoH; successful DNS transactions have not yet been verified"
        : "configured: proxy-side hostname resolution; successful DNS transactions have not yet been verified" });
  }

  // RoxyBrowser-style taskbar/window title: show the profile name at the OS
  // level without touching document.title (zero fingerprint surface). The
  // Chromium fork consumes an optional window-title prefix switch.
  const windowTitlePrefix = resolveWindowTitlePrefix(meta);
  // Append display-only text last, after the stamp. Flat ps output must not
  // require guessing where a name ends and real startup switches begin.

  // Chromium 150 builds advertising the native QUIC-proxy capability route
  // SOCKS5 TCP and UDP through a profile-owned loopback MASQUE bridge. Older
  // builds and HTTP proxies continue to fail closed with QUIC disabled rather
  // than allowing an unmanaged UDP path. HTTP 407 credentials use the
  // browser-only native channel when available.
  const runtimeExtensionPaths: string[] = [];
  if (activeProxy) {
    let chromiumProxy = activeProxy;
    const isSocks = activeProxy.type === "socks5" || activeProxy.type === "socks5h";
    if (isSocks && supportsNativeQuicProxy(bin) && dnsPolicy.route === "doh") {
      const masqueBridge = await startMasqueSocksBridge(activeProxy);
      pendingProxyBridge = masqueBridge;
      assertCurrentRequest();
      const proxyOrigin = `${masqueBridge.proxyHost}:${masqueBridge.port}`;
      const resolverRule = `MAP ${masqueBridge.proxyHost} ${masqueBridge.listenHost}`;
      args = args.filter((arg) => arg !== "--disable-quic");
      args = dedupeChromeArgs([
        ...args,
        `--proxy-server=quic://${proxyOrigin}`,
        `--host-resolver-rules=${mergeCommaSeparatedValue(resolverRule, getLaunchArgValue(args, "--host-resolver-rules"))}`,
        `--ignore-certificate-errors-spki-list=${mergeCommaSeparatedValue(masqueBridge.spki, getLaunchArgValue(args, "--ignore-certificate-errors-spki-list"))}`,
        `--origin-to-force-quic-on=${mergeCommaSeparatedValue(proxyOrigin, getLaunchArgValue(args, "--origin-to-force-quic-on"))}`,
        "--enable-quic",
      ]);
    } else {
      let proxyConnectHost = activeProxy.host;
      if (activeProxy.username && isSocks) {
        const socksBridge = await startAuthenticatedSocksBridge(activeProxy);
        pendingProxyBridge = socksBridge;
        assertCurrentRequest();
        chromiumProxy = {
          ...activeProxy,
          type: "socks5",
          host: socksBridge.host,
          port: socksBridge.port,
          username: undefined,
          password: undefined,
        };
        proxyConnectHost = socksBridge.host;
      }
      args = dedupeChromeArgs([
        ...args,
        `--proxy-server=${buildChromiumProxyUrl(chromiumProxy)}`,
        ...(dnsPolicy.route === "proxy"
          ? buildProxyDnsArgs(proxyConnectHost, supportsNativeLocalDnsPolicy(bin), getLaunchArgValue(args, "--host-resolver-rules"))
          : []),
        "--disable-quic",
      ]);
    }
    if (activeProxy.username && activeProxy.type === "http" && supportsNativeProxyAuth(bin)) {
      pendingNativeProxyAuth = writeNativeProxyAuthFile({
        host: activeProxy.host,
        port: activeProxy.port,
        username: activeProxy.username,
        password: activeProxy.password || "",
      });
      const proxyAuthSwitch = nativeProxyAuthSwitch(bin);
      args = dedupeChromeArgs([
        ...args,
        `${proxyAuthSwitch}=${pendingNativeProxyAuth.filePath}`,
      ]);
    } else if (activeProxy.username && activeProxy.type === "http") {
      runtimeExtensionPaths.push(writeProxyAuthExtension(dirId, activeProxy));
    }
  }
  addExtensionArgs(args, dirId, runtimeExtensionPaths);
  addDrmArgs(args, dirId);

  // Web App (PWA app-mode) launch: when the profile has an appUrl, open it as
  // a standalone app window (no tabs/omnibox) carrying the full managed
  // fingerprint identity. Mirrors RoxyBrowser 3.9.2 "PWA / Sub apps" — a
  // profile can run a site as its own dedicated app window.
  const appUrl = sanitizeAppUrl(meta.appUrl);
  if (appUrl) {
    args = dedupeChromeArgs([...args, `--app=${appUrl}`]);
  }

  // No stale preparation may mutate profile preferences or mint a stamp.
  assertCurrentRequest();
  // If bounded egress resolution is unavailable, use a deterministic locale
  // fallback instead of leaking the host UI language.
  if (!passThrough) {
    let launchLocale = getLaunchArgValue(args, "--fingerprint-locale") || getLaunchArgValue(args, "--lang");
    if (!launchLocale) {
      launchLocale = "en-US";
      args.push(`--lang=${launchLocale}`, `--fingerprint-locale=${launchLocale}`);
    }
    patchBrowserLocale(profileDir, launchLocale);
  }
  patchThirdPartyCookieCompatibility(
    profileDir,
    !passThrough && normalizeBoolean(meta.allowThirdPartyCookies, "third-party cookie compatibility"),
  );

  assertCurrentRequest();
  args.push(...prepareChromiumDiagnosticNetLogArgs(getAppDataDir(), diagnosticNetLogRequest));
  const launchProvenance = stampChromiumLaunch(args, requestHash!, fingerprintMode);
  args.push(chromiumLaunchStampArg(launchProvenance));
  if (windowTitlePrefix) args.push(`--agent-browser-window-title-prefix=${windowTitlePrefix}`);
  const logFile = getLaunchLogPath(dirId);
  const logFd = fs.openSync(logFile, "a");
  fs.writeSync(logFd, `\n[${new Date().toISOString()}] Launching ${bin}\n${maskSensitiveLaunchArgs(args).join(" ")}\n`);
  const launchEnv = (launchPlan as any).env as NodeJS.ProcessEnv | undefined;
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", logFd, logFd], env: launchEnv || process.env });
  child.unref();
  const pid = child.pid;
  // Retain only this launch's resource if its runtime entry is later replaced.
  // A failed spawn with no PID leaves pending bridge cleanup to the outer finally.
  const launchProxyBridge = pid ? pendingProxyBridge : null;
  const takeOwnedRuntimeEntry = (): RunningEntry | undefined => {
    const entry = runningProcesses.get(dirId);
    // Warm reuse may replace the entry object but keeps this exact child tuple.
    // No liveness test: an exited child can still own the entry needing cleanup.
    if (entry?.process === child && entry.pid === pid && entry.port === cdpPort) {
      runningProcesses.delete(dirId);
      return entry;
    }
    return undefined;
  };

  child.on("error", (err: Error) => {
    const failedEntry = takeOwnedRuntimeEntry();
    void (failedEntry?.proxyBridge || launchProxyBridge)?.close().catch(() => undefined);
    console.error(`[agent-browser] spawn error for ${dirId.slice(0, 8)}:`, err.message);
  });

  if (!pid) throw new Error(`Managed Chromium failed to start (no PID returned) for ${dirId.slice(0, 8)}`);

  const launchedEntry: RunningEntry = {
    pid,
    process: child,
    port: cdpPort,
    lastActivityAt: Date.now(),
    engine: "chromium",
    launchProvenance,
    launchProxy: captureLaunchProxySnapshot(resolvedProxy),
    ...(pendingProxyBridge ? { proxyBridge: pendingProxyBridge } : {}),
  };
  runningProcesses.set(dirId, launchedEntry);
  pendingProxyBridge = null;
  if (releaseLaunchLock) {
    releaseLaunchLock();
    releaseLaunchLock = null;
  }

  try {
    try {
      await waitForCdpReady(cdpPort, 15000);
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e);
      if (/EADDRINUSE|ECONNREFUSED/i.test(msg)) {
        const retryPort = await findFreePortWithRetry(0);
        const hint = retryPort && retryPort !== cdpPort ? " (next free port " + retryPort + " was available — retry the launch)" : "";
        throw new Error(msg + hint);
      }
      throw e;
    }
  } catch (e) {
    const failedEntry = takeOwnedRuntimeEntry();
    await (failedEntry?.proxyBridge || launchProxyBridge)?.close().catch(() => undefined);
    try { process.kill(pid, "SIGTERM"); } catch (killError) { console.error(`[agent-browser] failed to terminate unready process ${pid}:`, killError); }
    try { fs.closeSync(logFd); } catch (closeError) { console.error(`[agent-browser] failed to close launch log:`, closeError); }
    throw e;
  }

  // A running browser and a restored Cookie identity are separate facts. Use
  // this launch's owned endpoint, then read the queue back even after failure.
  let expectedCookies: number | undefined, pendingCookies: number | undefined;
  let appliedCookies = 0, cookieError: string | undefined;
  try {
    expectedCookies = readQueuedCookieImports(dirId, { strict: true }).length;
    if (expectedCookies > 0) {
      const applied = await cdpCookieService.applyQueuedImports(dirId, {
        port: cdpPort,
        isCurrent: () => {
          const entry = runningProcesses.get(dirId);
          return entry?.process === child && entry.pid === pid && entry.port === cdpPort && !entry.stopping &&
            child.pid === pid && child.exitCode === null && child.signalCode === null && child.killed !== true;
        },
      });
      if (!Number.isSafeInteger(applied) || applied < 0 || applied > expectedCookies) throw new Error("Invalid Cookie import count");
      appliedCookies = applied;
    }
  } catch { cookieError = "COOKIE_IMPORT_UNAVAILABLE"; }
  try { pendingCookies = readQueuedCookieImports(dirId, { strict: true }).length; }
  catch { cookieError = "COOKIE_IMPORT_UNAVAILABLE"; }
  if (!cookieError && (expectedCookies !== appliedCookies || pendingCookies !== 0)) cookieError = "COOKIE_IMPORT_INCOMPLETE";
  const cookieCheck: LaunchCookieCheck = {
    checked: true, applied: appliedCookies,
    ...(pendingCookies !== undefined ? { pending: pendingCookies } : {}),
    ...(cookieError ? { error: cookieError } : {}),
  };
  if (cookieError) console.warn(`[agent-browser] queued Cookie import for ${dirId.slice(0, 8)}: ${cookieError}`);
  else if (appliedCookies > 0) console.log(`[agent-browser] Applied ${appliedCookies} queued cookies for ${dirId.slice(0, 8)}`);

  let driftCheck: LaunchDriftCheck = { checked: false };
  try {
    driftCheck = await runFingerprintDriftGuard(
      {
        captureFingerprint: (port: number) => captureFingerprint(port),
        audit: (detail: string) => recordAudit({ category: "profile", action: "fingerprint-drift", target: dirId, actor: "auto", detail }),
        auditBlock: (detail: string) => recordAudit({ category: "profile", action: "fingerprint-drift-block", target: dirId, actor: "auto", detail }),
        auditError: (detail: string) => recordAudit({ category: "profile", action: "fingerprint-drift-error", target: dirId, actor: "auto", detail }),
      },
      { cdpPort, meta, cfg, passThrough },
    );
  } catch (e: any) {
    if (e instanceof LaunchBlockedError) {
      const failedEntry = takeOwnedRuntimeEntry();
      await (failedEntry?.proxyBridge || launchProxyBridge)?.close().catch(() => undefined);
      try { process.kill(pid, "SIGTERM"); } catch (killError) { console.error("[agent-browser] failed to terminate drifted process " + pid + ":", killError); }
      try { fs.closeSync(logFd); } catch (closeError) { console.error("[agent-browser] failed to close launch log:", closeError); }
      await waitForProcessExit(pid);
      const blockError: any = new Error(e.message);
      blockError.driftBlocked = true;
      throw blockError;
    }
    throw e;
  }

  let envCheck: LaunchEnvCheck = { checked: false };
  try {
    const r = runEnvironmentRiskGuard(
      {
        auditHigh: (detail: string) => recordAudit({ category: "profile", action: "env-risk-high", target: dirId, actor: "auto", detail }),
        auditError: (detail: string) => recordAudit({ category: "profile", action: "env-risk-error", target: dirId, actor: "auto", detail }),
      },
      { meta, resolvedProxy, cfg, passThrough },
    );
    envCheck = r as any;
  } catch (e: any) {
    if (e instanceof LaunchBlockedError) {
      const detail = e.message;
      recordAudit({ category: "profile", action: "env-risk-block", target: dirId, actor: "auto", detail });
      const failedEntry = takeOwnedRuntimeEntry();
      await (failedEntry?.proxyBridge || launchProxyBridge)?.close().catch(() => undefined);
      try { process.kill(pid, "SIGTERM"); } catch (killError) { console.error("[agent-browser] failed to terminate env-blocked process " + pid + ":", killError); }
      try { fs.closeSync(logFd); } catch (closeError) { console.error("[agent-browser] failed to close launch log:", closeError); }
      await waitForProcessExit(pid);
      const envBlockError: any = new Error(e.message);
      envBlockError.envBlocked = true;
      throw envBlockError;
    }
    throw e;
  }

  child.on("exit", () => {
    // Verified warm reuse replaces the entry, but retains the same owned child.
    // PID/port alone must never identify a replacement process as that child.
    const entry = runningProcesses.get(dirId);
    const currentIsOwned = entry?.process === child && entry.pid === pid && entry.port === cdpPort;
    if (currentIsOwned) {
      if (entry.killTimer) clearTimeout(entry.killTimer);
      delete entry.stopping;
      void entry.proxyBridge?.close().catch((error) => console.error("[browser-stop] proxy bridge cleanup failed:", error));
      runningProcesses.delete(dirId);
    }
    try { fs.closeSync(logFd); } catch (closeError) { console.error(`[agent-browser] failed to close launch log:`, closeError); }
    if (entry && !currentIsOwned) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        const payload = { dirId, pid, timestamp: Date.now() };
        win.webContents.send("browser:exited", payload);
        win.webContents.send("cloak:exited", payload); // legacy IPC compatibility
      }
    }
    emitEvent("profile:exited", { dirId, pid });
  });

  emitEvent("profile:launched", { dirId, pid, cdpPort });
  recordAudit({ category: "profile", action: "launch", target: dirId, actor: "user", detail: `pid=${pid} cdpPort=${cdpPort} fingerprint=${fingerprintMode} browser=${nativeChromiumVersion || "unknown"}` });
  return { pid, cdpPort, driftCheck, envCheck, cookieCheck };
  } finally {
    pendingNativeProxyAuth?.cleanup();
    await pendingProxyBridge?.close().catch(() => undefined);
    if (releaseLaunchLock) releaseLaunchLock();
  }
}

/** Wait for a spawned child to exit, escalating to SIGKILL so a "blocked"
 *  launch never leaves a live process behind. */
function ownedChromiumLaunchEvidence(entry: RunningEntry | undefined): BrowserLaunchProcess | null {
  const child = entry?.process;
  if (entry?.engine !== "chromium" || !entry.launchProvenance || !child || child.pid !== entry.pid ||
      child.exitCode !== null || child.signalCode !== null || child.killed === true ||
      !Array.isArray(child.spawnargs) || child.spawnargs.length < 1 ||
      !child.spawnargs.every((arg: unknown) => typeof arg === "string") ||
      child.spawnargs.slice(1).some((arg: string) => /^--type(?:=|$)/.test(arg))) return null;
  return browserLaunchProcessFromArgv(entry.pid, child.spawnargs[0], child.spawnargs.slice(1));
}

function assertReusableProcessAlive(pid: number): void {
  try { process.kill(pid, 0); }
  catch { throw restartRequired("the discovered process is not verifiably live"); }
}

async function assertReusableChromiumPort(port: number): Promise<void> {
  try {
    // This is the already-advertised, loopback-only CDP endpoint, not a proxy
    // or website probe. A random listening HTTP port is not reuse evidence.
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) throw new Error("CDP endpoint unavailable");
    const version = await response.json() as { Browser?: string; webSocketDebuggerUrl?: string };
    const websocket = new URL(version.webSocketDebuggerUrl || "");
    if (!/^(?:HeadlessChrome|Chrome|Chromium)\/\d/.test(version.Browser || "") ||
        websocket.protocol !== "ws:" || websocket.hostname !== "127.0.0.1" || websocket.port !== String(port) ||
        !websocket.pathname.startsWith("/devtools/browser/")) throw new Error("unexpected debugging endpoint");
  } catch {
    throw restartRequired("the Chromium debugging endpoint could not be verified");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid: number, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

export interface FingerprintDriftCheckResult {
  ok: boolean;
  error?: string;
  checked?: boolean;
  hasBaseline?: boolean;
  risky?: boolean;
  drift?: FingerprintDrift[];
  fields?: number;
}

/** Read-only live fingerprint check against the stored baseline (no state change). */
export async function checkFingerprintDrift(dirId: string): Promise<FingerprintDriftCheckResult> {
  validateDirId(dirId);
  const cfg = getConfig() as any;
  const meta = cfg.browserProfiles?.[dirId];
  if (!meta) return { ok: false, error: "Profile not found" };
  const engine = getProfileEngineByDirId(dirId);
  if (!meta.fingerprintBaseline) {
    return { ok: true, checked: false, hasBaseline: false, risky: false, drift: [] };
  }
  const st = statusBrowser(dirId);
  if (!st.running || !st.cdpPort) return { ok: false, error: "profile not running" };
  try {
    const current = await captureFingerprint(st.cdpPort, engine);
    const drift = diffFingerprints(meta.fingerprintBaseline, current);
    const personaDrift = mismatchesAsDrift(checkPersonaConsistency(
      { platform: meta.platform || "windows", timezone: meta.timezone },
      current,
    ));
    const combined = [...drift, ...personaDrift];
    const risky = hasRiskyDrift(drift) || personaDrift.length > 0;
    return { ok: true, checked: true, hasBaseline: true, risky, drift: combined, fields: Object.keys(current).length };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}

function resolveFirefoxProxy(dirId: string, meta: BrowserProfileMeta, cfg: any): ResolvedProfileProxy {
  // A direct profile needs no secret resolution, including during cheap reuse.
  const resolved = meta.proxyMode === "none" || (meta.proxyMode === undefined && !meta.proxyName)
    ? { mode: "none" as const, name: null, config: null }
    : resolveProfileProxySecret(dirId, cfg);
  assertProxyResolvable(meta, cfg, resolved);
  return resolved;
}

function assertFirefoxProxyCurrent(dirId: string, meta: BrowserProfileMeta, proxy: ResolvedProfileProxy): void {
  const current = structuredClone(getConfig());
  const requested = current.browserProfiles?.[dirId];
  if (!requested || firefoxEffectiveLaunchHash(meta, resolveFirefoxProxy(dirId, requested, current)) !== firefoxEffectiveLaunchHash(meta, proxy)) {
    throw restartRequired("Firefox effective proxy route changed during preparation");
  }
}

function normalizeFirefoxTimezone(value: unknown): string | null {
  const timezone = normalizeOptionalTimezone(value);
  if (!timezone) return null;
  if (/^[+-]/.test(timezone)) throw new Error(`Invalid IANA timezone: ${JSON.stringify(value)}`);
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
}

async function resolveFirefoxLaunchIdentity(
  meta: BrowserProfileMeta,
  proxy: ResolvedProfileProxy,
  assertCurrentRequest: () => void,
) {
  if (meta.fingerprintMode === "off") {
    return { meta: { ...meta, timezone: null, locale: null }, geo: null, observedAt: null, observation: null, target: null, timezoneSource: "off", localeSource: "off" };
  }
  let timezone = normalizeFirefoxTimezone(meta.timezone);
  let locale = normalizeOptionalLocale(meta.locale);
  let timezoneSource = timezone ? "explicit" : "host";
  let localeSource = locale ? "explicit" : "host";
  let geo: ProxyDetectionResult | null = null;
  let observedAt: number | null = null;
  let observation: ProxyDetectionResult | null = null;
  let target: ProxyDetectionTarget | null = null;
  if (proxy.config && (!timezone || !locale)) {
    target = proxy.name ? captureProxyDetectionTarget(proxy.name, proxy.config) : null;
    const resolved = await resolveGeoFromProxy(proxy.config, target);
    assertCurrentRequest();
    let proxyTimezone: string | null = null;
    try { proxyTimezone = normalizeFirefoxTimezone(resolved.timezone); }
    catch (error) { console.warn("[agent-browser] Firefox ignored an invalid proxy IANA timezone:", error); }
    // Retain the original authenticated result before making a normalized
    // consistency-check projection; a spread/IPC clone is not new authority.
    observation = resolved.detection;
    observedAt = observation ? proxyDetectionObservedAt(observation) : null;
    geo = observation?.success ? { ...observation, timezone: proxyTimezone } : null;
    if (!timezone && proxyTimezone) { timezone = proxyTimezone; timezoneSource = "proxy"; }
    if (!locale && resolved.locale) { locale = normalizeOptionalLocale(resolved.locale); localeSource = "proxy"; }
  }
  // Auto remains null in stored meta. A missing/failed proxy observation uses
  // validated host defaults, not persisted geo or a country-to-timezone guess.
  if (!timezone || !locale) {
    const host = Intl.DateTimeFormat().resolvedOptions();
    if (!timezone) timezone = normalizeFirefoxTimezone(host.timeZone);
    if (!locale) locale = normalizeOptionalLocale(host.locale);
  }
  if (!timezone || !locale) throw new Error("Firefox Auto timezone or locale could not be resolved from the proxy or host");
  return { meta: { ...meta, timezone, locale }, geo, observedAt, observation, target, timezoneSource, localeSource };
}

/**
 * Firefox engine launch (Slice 77/78/79), aligned with RoxyBrowser's real
 * RoxyFirefox engine AND with the managed Chromium capability set:
 *
 *  - command line matches RoxyFirefox — `-profile`, `--marionette`,
 *    `--remote-debugging-port=<free port>` (explicit so the port survives app
 *    restarts and ps-based rediscovery), `-no-remote` — and we parse the
 *    WebDriver BiDi WebSocket URL from stderr (Marionette port from stdout);
 *  - managed identity (Slice 79): the profile's fingerprint config is applied
 *    through the two channels stock Firefox supports — prefs (user.js) and a
 *    WebDriver BiDi preload script registered over a long-lived session;
 *  - runtime tools (Slice 79): queued cookie import, live fingerprint drift
 *    check and the host environment risk check run against the running
 *    Firefox exactly like they do against managed Chromium.
 *
 * Honest scope note: stock Firefox cannot carry the native `--fingerprint-*`
 * patch set; the preload-script shims are JS-level and weaker than renderer
 * patching. The fingerprint drift baseline keeps that difference visible.
 */
async function launchFirefoxProfile(
  dirId: string,
  meta: any,
  cfg: any,
  headless: boolean | undefined,
  releaseLaunchLock: (() => void) | null,
  opts: { forceDeadProxy?: boolean; requestHash: string; assertCurrentRequest: () => void },
): Promise<{ pid: number; cdpPort: number; driftCheck: LaunchDriftCheck; envCheck: LaunchEnvCheck; cookieCheck: LaunchCookieCheck }> {
  const bin = await findFirefoxBinaryAsync();
  opts.assertCurrentRequest();
  if (!bin) {
    if (releaseLaunchLock) releaseLaunchLock();
    throw new Error(
      "Managed Firefox is required for this profile. Install Firefox or set AGENT_BROWSER_FIREFOX_BINARY_PATH.",
    );
  }
  const binaryIdentity = await getFirefoxNativeSelectionIdentityAsync(bin);
  opts.assertCurrentRequest();
  if (!binaryIdentity) throw new Error("Cannot verify the selected Firefox executable identity");
  let preparedProxy: ResolvedProfileProxy | null = null;
  const assertPrepared = async () => {
    opts.assertCurrentRequest();
    const selected = await findFirefoxBinaryAsync();
    if (!selected || normalizeBrowserProcessPath(selected) !== normalizeBrowserProcessPath(bin) ||
        await getFirefoxNativeSelectionIdentityAsync(bin) !== binaryIdentity) {
      throw restartRequired("Firefox binary selection changed during preparation");
    }
    opts.assertCurrentRequest();
    if (preparedProxy) assertFirefoxProxyCurrent(dirId, meta, preparedProxy);
  };
  const firefoxVersion = await detectFirefoxVersionAsync(bin);
  opts.assertCurrentRequest();
  if (!firefoxVersion || !/^\d+(?:\.\d+){1,2}$/.test(firefoxVersion)) throw new Error("Cannot verify the selected Firefox runtime version");
  // Compare major.minor (R4): a legal "154.0" pin must match a "154.0.1"
  // binary — strict string inequality would always block. Unknown is not a match.
  if (meta.browserVersion && !firefoxVersion) throw new Error(`Cannot verify the installed Firefox version required by profile: ${meta.browserVersion}`);
  if (meta.browserVersion && normalizeFirefoxVersion(firefoxVersion) !== normalizeFirefoxVersion(meta.browserVersion)) {
    if (releaseLaunchLock) releaseLaunchLock();
    throw new Error(`Profile requires Firefox ${meta.browserVersion}, but the installed binary is ${firefoxVersion}`);
  }

  const profileDir = path.join(getProfilesDir(), dirId);
  const fingerprintMode = normalizeFingerprintMode(meta.fingerprintMode);
  const nativeRequested = firefoxNativeModeRequested();
  const capabilityReport = await readFirefoxNativeCapabilityReportAsync(bin);
  await assertPrepared();
  const capabilities = new Set(capabilityReport?.capabilities || []);
  const nativeConfig = FIREFOX_NATIVE_CONFIG_CAPABILITIES.every(capability => capabilities.has(capability));
  const nativeParity = FIREFOX_NATIVE_PARITY_CAPABILITIES.every(capability => capabilities.has(capability));
  if (fingerprintMode !== "off" && nativeRequested && !nativeConfig) {
    if (releaseLaunchLock) releaseLaunchLock();
    throw new Error(
      "Firefox native-only A/B mode was requested, but the selected binary lacks the binary-attested config-v1, native-required-v1, and snapshot-v1 capabilities.",
    );
  }
  const nativeMode = fingerprintMode !== "off" && nativeConfig && (nativeParity || nativeRequested);
  const resolvedProxy = resolveFirefoxProxy(dirId, meta, cfg);
  preparedProxy = resolvedProxy;
  assertFirefoxProxyCurrent(dirId, meta, resolvedProxy);
  // R10/R12: liveness gate — history warns by default (opt-in block via
  // blockOnUnhealthyProxy), the TCP probe refuses dead ports.
  await assertProxyLaunchable(dirId, resolvedProxy, cfg, { forceDeadProxy: opts.forceDeadProxy === true });
  await assertPrepared();
  const effective = await resolveFirefoxLaunchIdentity(meta, resolvedProxy, opts.assertCurrentRequest);
  await assertPrepared();
  const effectiveMeta = effective.meta;
  const effectiveHash = firefoxEffectiveLaunchHash(effectiveMeta, resolvedProxy);
  const managedIdentity = fingerprintMode === "off" ? null : buildFirefoxManagedIdentity(effectiveMeta, firefoxVersion, null);
  assertFirefoxProxyCurrent(dirId, meta, resolvedProxy);
  if (effective.observation && effective.observedAt !== null && effective.target) {
    persistLaunchDetection(effective.target, effective.observation);
  }
  if (managedIdentity) recordAudit({
    category: "profile", action: "firefox-identity", target: dirId, actor: "auto",
    detail: `timezone=${effectiveMeta.timezone} source=${effective.timezoneSource}; locale=${effectiveMeta.locale} source=${effective.localeSource}` +
      (effective.timezoneSource === "host" || effective.localeSource === "host" ? "; host fallback, proxy alignment unverified" : ""),
  });
  // R11 P1-4 item 3: same consistency warnings as Chromium (warn by default).
  // R12 P2-1: normalize like the Chromium path — real/disable modes carry no
  // effective IP at runtime, so a stale meta.webrtcIp must not trigger
  // webrtc-no-proxy on Firefox while Chromium stays silent.
  const requestedWebRtcMode = fingerprintMode === "off" ? "real" : normalizeWebRtcMode(meta.webrtcMode, meta.webrtcIp);
  runConsistencyGate(dirId, cfg, {
    passThrough: fingerprintMode === "off",
    timezone: effectiveMeta.timezone, locale: effectiveMeta.locale,
    webrtcIp: requestedWebRtcMode === "auto" || requestedWebRtcMode === "altered" ? meta.webrtcIp : null,
    platform: meta.platform,
    proxyMode: resolvedProxy.mode,
    proxyGeo: effective.geo ?? (effective.timezoneSource === "explicit" && effective.localeSource === "explicit" && resolvedProxy.name ? getProxyDetection(resolvedProxy.name) : null),
  });
  const dohUrl = cfg.managedSecureDnsUrl && typeof cfg.managedSecureDnsUrl === "string" ? cfg.managedSecureDnsUrl : null;

  opts.assertCurrentRequest();
  assertFirefoxProxyCurrent(dirId, meta, resolvedProxy);
  writeFirefoxUserJs(profileDir, {
    fingerprintMode,
    proxy: resolvedProxy.config,
    dohUrl,
    locale: managedIdentity ? effectiveMeta.locale || undefined : undefined,
    // R12 P1-2: honor the same opt-in flag as Chromium (default off).
    allowThirdPartyCookies: normalizeBoolean(meta.allowThirdPartyCookies, "third-party cookie compatibility", false),
    useGpu: true,
    sandboxPermission: true,
    colorScheme: "system",
    ...(managedIdentity ? { extraPrefs: nativeMode ? managedIdentity.nativePrefs : managedIdentity.prefs } : {}),
  });

  const userJsHash = firefoxLaunchDigest(fs.readFileSync(path.join(profileDir, "user.js")));

  // Explicit free port (not 0): the BiDi endpoint is deterministic and the
  // `ps`-based port rediscovery (statusBrowser after an app restart) works.
  // Loopback-bound probe with error handling — never the sync wildcard bind
  // (fail-closed: a listen failure rejects instead of crashing Electron main).
  const remotePort = await findFreePortWithRetry(2);
  const args = buildFirefoxLaunchArgs({
    profileDir,
    remotePort,
    headless,
    platform: meta.platform,
    appUrl: meta.appUrl || undefined,
    nativeRequired: nativeMode,
  });
  await assertPrepared();

  const logFile = getLaunchLogPath(dirId);
  let logFd: number | null = null;
  try {
    logFd = fs.openSync(logFile, "a");
  } catch { /* launch without a log file */ }
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, `\n[${new Date().toISOString()}] Launching ${bin}\n${maskSensitiveLaunchArgs(args).join(" ")}\n`);
    } catch { /* ignore */ }
  }
  console.log(`[agent-browser] Firefox launch plan ready for ${dirId.slice(0, 8)}: ${bin}`);

  // Engine-level timezone: JS shims can rewrite `Intl.DateTimeFormat` strings,
  // but `Date.getTimezoneOffset` / `Date` parsing read the OS clock and still
  // leak `+08:00`-style host offsets. Firefox honors the `TZ` env var natively,
  // so the managed timezone rides on the child environment (engine-level).
  const spawnEnv = managedIdentity && effectiveMeta.timezone ? { ...process.env, TZ: effectiveMeta.timezone } : undefined;
  let spawned: Awaited<ReturnType<typeof spawnFirefoxWithDebugInfo>>;
  try {
    opts.assertCurrentRequest();
    assertFirefoxProxyCurrent(dirId, meta, resolvedProxy);
    spawned = await spawnFirefoxWithDebugInfo(bin, args, { timeoutMs: 60000, env: spawnEnv });
  } catch (error) {
    if (logFd !== null) { try { fs.closeSync(logFd); } catch (closeError) { console.error("[agent-browser] Firefox launch log close failed:", closeError); } }
    throw error;
  }
  const { child, info } = spawned;
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    try { child.kill(); } catch { /* ignore */ }
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ignore */ } }
    if (releaseLaunchLock) releaseLaunchLock();
    throw new Error("Failed to spawn Firefox: no pid");
  }

  // Firefox speaks WebDriver BiDi (not Chromium CDP). The BiDi port is the
  // profile's debug port; agent CDP tooling remains Chromium-only for now
  // (documented follow-up), while the product's own tools went BiDi (Slice 79).
  const actualPort = info.actualPort ?? info.marionettePort ?? remotePort;
  runningProcesses.set(dirId, { pid, process: child, port: actualPort, lastActivityAt: Date.now(), engine: "firefox",
    launchProxy: captureLaunchProxySnapshot(resolvedProxy) });
  child.on("exit", () => {
    const entry = runningProcesses.get(dirId);
    if (entry && entry.pid === pid) {
      if (entry.killTimer) clearTimeout(entry.killTimer);
      if (entry.bidiConn) {
        dropFirefoxSession(entry.port);
        try { entry.bidiConn.close(); } catch { /* ignore */ }
      }
      runningProcesses.delete(dirId);
    }
  });

  let bidiInjected = false;
  let bidiSessionId: string | null = null;
  let bidiError: string | null = null;
  let driftCheck: LaunchDriftCheck = { checked: false };
  let envCheck: LaunchEnvCheck = { checked: false };
  let cookieCheck: LaunchCookieCheck = { checked: false };

  try {
    await assertPrepared();
    // Long-lived BiDi session: the fingerprint preload script lives in the
    // session, so the connection stays open while the profile runs.
    if (info.bidiWebSocketUrl) {
      try {
        const conn = await connectBidi(info.bidiWebSocketUrl, { timeoutMs: 15000 });
        runningProcesses.get(dirId)!.bidiConn = conn;
        registerFirefoxSession(info.actualPort ?? info.marionettePort ?? remotePort, conn);
        if (managedIdentity && !nativeMode) {
          const scriptId = await bidiAddPreloadScript(conn, managedIdentity.preloadScript, 15000);
          bidiInjected = scriptId !== null;
          bidiSessionId = scriptId;
        }
      } catch (e: any) {
        bidiError = e?.message || String(e);
      }
    }

    const liveBidi = runningProcesses.get(dirId)?.bidiConn;
    if (!liveBidi || liveBidi.closed) {
      throw new Error(
        `Firefox ${managedIdentity ? "managed identity" : "launch"} requires a live BiDi session${bidiError ? `: ${bidiError}` : "."}`,
      );
    }
    if (managedIdentity && !nativeMode && !bidiInjected) {
      throw new Error(
        `Fingerprint injection probe blocked — BiDi preload registration failed${bidiError ? `: ${bidiError}` : "."}`,
      );
    }

    // Queued cookie imports (shared with the Chromium pipeline). A failure is
    // surfaced on the launch result — never a silent warn — so callers can see
    // the session launched without its queued identity.
    try {
      const queuedCookies = await firefoxCookieService.applyQueuedImports(dirId);
      cookieCheck = { checked: true, applied: queuedCookies };
      if (queuedCookies > 0) console.log(`[agent-browser] Applied ${queuedCookies} queued cookies for ${dirId.slice(0, 8)}`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.warn(`[agent-browser] Firefox queued-cookie apply failed for ${dirId.slice(0, 8)}:`, msg);
      cookieCheck = { checked: true, applied: 0, error: msg };
    }

    // Post-launch fingerprint drift check — same gate as managed Chromium:
    // a stored baseline that no longer matches the live fingerprint on
    // high-risk fields blocks the launch (blockOnFingerprintDrift).
    if (managedIdentity && meta.fingerprintBaseline) {
      try {
        const current = await captureFingerprint(actualPort, "firefox");
        const drift = diffFingerprints(meta.fingerprintBaseline, current);
        // R12 P2-2: same persona cross-check as the read-only drift check —
        // platform/timezone vs live fingerprint mismatches are risky too.
        const personaDrift = mismatchesAsDrift(checkPersonaConsistency(
          { platform: meta.platform || "windows", timezone: effectiveMeta.timezone },
          current,
        ));
        const combined = [...drift, ...personaDrift];
        const risky = hasRiskyDrift(drift) || personaDrift.length > 0;
        driftCheck = { checked: true, risky, drift: combined };
        if (combined.length) {
          recordAudit({
            category: "profile", action: "fingerprint-drift", target: dirId, actor: "auto",
            detail: combined.length + " field(s) changed" + (risky ? " (risky)" : "") + ": " + summarizeDrift(combined),
          });
        }
        if (risky && cfg.blockOnFingerprintDrift !== false) {
          const reason = "Fingerprint drift blocked (" + summarizeDrift(combined) + "). Re-capture the baseline or set blockOnFingerprintDrift=false to launch.";
          recordAudit({ category: "profile", action: "fingerprint-drift-block", target: dirId, actor: "auto", detail: reason });
          const blockError: any = new Error(reason);
          blockError.driftBlocked = true;
          throw blockError;
        }
      } catch (e: any) {
        if (e && e.driftBlocked) throw e;
        console.warn("[agent-browser] fingerprint drift check failed for " + dirId.slice(0, 8) + ":", e?.message || e);
        driftCheck = { checked: false, error: (e && e.message) || String(e) };
      }
    }

    // Managed-injection self-check — the drift gate cannot tell whether the
    // preload took effect (baseline and live both read the "true" world when
    // nothing is injected; real Firefox also exposes navigator.webdriver=true
    // under BiDi). Probe a fresh tab inside the launch session: webdriver must
    // be disarmed, the noise layer must be live, and the managed fields must
    // match the profile's identity. Fail closed: an unconfirmed OR undecidable
    // probe blocks the launch by default (blockOnInjectionProbe=false escapes).
    // Native mode registers no preload, so the probe only runs on fallback.
    if (managedIdentity && !nativeMode) {
      // No BiDi connection at all (connect failed, endpoint never announced)
      // means the preload could not possibly be registered — fail closed like
      // an undecidable probe instead of launching silently uninjected (R2 #47).
      // blockOnInjectionProbe=false opts out explicitly.
      const entry = runningProcesses.get(dirId);
      const conn = entry?.bidiConn;
      if (!conn && cfg.blockOnInjectionProbe !== false) {
        const reason = "Fingerprint injection probe blocked — no BiDi connection, so the managed preload could not be registered" +
          (bidiError ? " (BiDi error: " + bidiError + ")" : "") +
          ". Set blockOnInjectionProbe=false to launch without this verification.";
        recordAudit({ category: "profile", action: "injection-probe-block", target: dirId, actor: "auto", detail: reason });
        throw new Error(reason);
      }
      try {
        if (conn) {
          const expected = buildInjectionProbeExpectation(managedIdentity.config);
          const expression = buildInjectionProbeExpression();
          let probeCheck: InjectionProbeCheck = { checked: false, confirmed: false, ambiguous: true, mismatches: [] };
          for (let attempt = 0; attempt < 2 && !probeCheck.checked; attempt++) {
            if (attempt > 0) await sleep(1500);
            let probeContext: string | null = null;
            try {
              probeContext = await bidiCreateContext(conn, 15000);
              const response = await bidiEvaluateInContext(conn, expression, probeContext, 15000);
              probeCheck = judgeInjectionProbe(response, expected);
            } catch (e: any) {
              probeCheck = { checked: false, confirmed: false, ambiguous: true, mismatches: [], error: e?.message || String(e) };
            } finally {
              if (probeContext) await bidiCloseContext(conn, probeContext, 8000);
            }
          }
          if (entry && entry.bidiConn === conn) entry.injectionProbe = probeCheck;
          if (shouldBlockInjectionProbe(probeCheck, cfg.blockOnInjectionProbe)) {
            const reason = "Fingerprint injection probe blocked — the managed preload did not take effect (navigator.webdriver is not disarmed). Set blockOnInjectionProbe=false to launch without this verification.";
            recordAudit({ category: "profile", action: "injection-probe-block", target: dirId, actor: "auto", detail: reason });
            throw new Error(reason);
          }
          if (probeCheck.checked) {
            const verdict = probeCheck.confirmed ? "injected" : probeCheck.ambiguous ? "ambiguous" : "not-injected";
            console.log(`[agent-browser] Firefox injection probe for ${dirId.slice(0, 8)}: ${verdict}` + (probeCheck.mismatches.length ? " mismatches=" + probeCheck.mismatches.join(",") : ""));
          }
        }
      } catch (e: any) {
        if (/injection probe blocked/.test(String(e?.message || e))) throw e;
        console.warn("[agent-browser] injection probe failed for " + dirId.slice(0, 8) + ":", e?.message || e);
      }
    }

    // Off mode makes no managed persona claim. Like Chromium, do not compare
    // its real environment with inactive locale/platform fields.
    if (managedIdentity) {
      try {
        const envResult = await checkEnvironmentRiskRuntime(
          { timezone: effectiveMeta.timezone, locale: effectiveMeta.locale, platform: meta.platform },
          actualPort,
          { proxy: { mode: resolvedProxy.mode, config: resolvedProxy.config ? { type: resolvedProxy.config.type } : null } },
          "firefox",
        );
        envCheck = { checked: true, high: !envResult.ok, findings: envResult.findings };
        if (!envResult.ok) {
          recordAudit({
            category: "profile", action: "env-risk-high", target: dirId, actor: "auto",
            detail: "high: " + summarizeEnvFindings(envResult.findings, "high") + (envResult.findings.some((f) => f.severity === "medium") ? "; medium: " + summarizeEnvFindings(envResult.findings, "medium") : ""),
          });
        }
        if (shouldBlockEnvironmentRisk(envResult, cfg.blockOnEnvironmentRisk)) {
          const reason = "Environment risk blocked (" + summarizeEnvFindings(envResult.findings, "high") + "). Fix the host environment or set blockOnEnvironmentRisk=false to launch.";
          recordAudit({ category: "profile", action: "env-risk-block", target: dirId, actor: "auto", detail: reason });
          throw new Error(reason);
        }
      } catch (e: any) {
        // The outer launch failure handler owns session/process cleanup.
        if (e?.driftBlocked || /Environment risk blocked/.test(String(e?.message || e))) throw e;
        console.warn("[agent-browser] environment risk check failed for " + dirId.slice(0, 8) + ":", e?.message || e);
        envCheck = { checked: false, error: (e && e.message) || String(e) };
      }
    }
    await assertPrepared();
    const connection = getRegisteredFirefoxSession(actualPort);
    if (!connection || connection !== runningProcesses.get(dirId)?.bidiConn || connection.closed) {
      throw restartRequired("Firefox BiDi session ended during launch verification");
    }
    if (firefoxLaunchDigest(fs.readFileSync(path.join(profileDir, "user.js"))) !== userJsHash) {
      throw restartRequired("Firefox preferences changed during launch verification");
    }
    if (child.killed || child.exitCode !== null || child.signalCode !== null) throw restartRequired("Firefox exited during launch verification");
    assertFirefoxProxyCurrent(dirId, meta, resolvedProxy);
    ownedFirefoxLaunches.set(child, {
      requestHash: opts.requestHash, effectiveHash, executablePath: bin, binaryIdentity, profileDir,
      argvHash: firefoxLaunchDigest(JSON.stringify(child.spawnargs)), userJsHash, connection,
    });
  } catch (e: any) {
    // Drift-blocked or fatal post-launch gate failure: terminate and clean up.
    const failedEntry = runningProcesses.get(dirId);
    if (failedEntry?.bidiConn) {
      dropFirefoxSession(failedEntry.port);
      try { failedEntry.bidiConn.close(); } catch { /* ignore */ }
    }
    runningProcesses.delete(dirId);
    try { child.kill(); } catch { /* ignore */ }
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ignore */ } }
    await waitForProcessExit(pid);
    throw e;
  }

  if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ignore */ } }
  recordAudit({
    category: "profile",
    action: "launch",
    target: dirId,
    actor: "user",
    detail: `firefox ${firefoxVersion || "?"} mode=${nativeMode ? "native" : "fallback"} port=${actualPort} bidi=${info.bidiWebSocketUrl ? "yes" : "no"} injected=${bidiInjected ? "yes" : "no"}${bidiError ? " bidiError=" + bidiError : ""} drift=${driftCheck.checked ? (driftCheck.risky ? "risky" : "ok") : "unchecked"} cookies=${cookieCheck.checked ? (cookieCheck.error ? "failed: " + cookieCheck.error : "applied=" + (cookieCheck.applied ?? 0)) : "unchecked"}`,
  });
  if (releaseLaunchLock) releaseLaunchLock();
  return { pid, cdpPort: actualPort, driftCheck, envCheck, cookieCheck };
}

import {
  stopBrowser as _stopBrowser,
  statusBrowser as _statusBrowser,
  stopAllBrowserProfiles as _stopAll,
  shutdownAllBrowserProfiles as _shutdownAll,
  getCdpWebSocketUrl as _getCdpUrl,
  findBrowserByProfile as _findByProfile,
} from "./browser/lifecycle.js";
export type { BrowserShutdownReport, BrowserShutdownTarget } from "./browser/lifecycle.js";
import {
  setIdlePolicyTimeoutMs as _setIdle,
  getIdlePolicyTimeoutMs as _getIdle,
  touchProfileActivity as _touch,
  touchProfileActivityByPort as _touchByPort,
  getEngineByPort as _getEngineByPort,
  getFirefoxBidiSessionByPort as _getBidiByPort,
  getProfileIdleMs as _getIdleMs,
  listRunningProfileIdle as _listIdle,
  sweepIdleProfiles as _sweep,
} from "./browser/idle-tracker.js";
export const stopBrowser = _stopBrowser;
export const statusBrowser = _statusBrowser;
export const stopAllBrowserProfiles = _stopAll;
export const shutdownAllBrowserProfiles = _shutdownAll;
export const getCdpWebSocketUrl = _getCdpUrl;
const findBrowserByProfile = _findByProfile;

export const setIdlePolicyTimeoutMs = _setIdle;
export const getIdlePolicyTimeoutMs = _getIdle;
export const touchProfileActivity = _touch;
export const touchProfileActivityByPort = _touchByPort;
export const getEngineByPort = _getEngineByPort;
export const getFirefoxBidiSessionByPort = _getBidiByPort;
export const getProfileIdleMs = _getIdleMs;
export const listRunningProfileIdle = _listIdle;
export function sweepIdleProfiles(maxIdleMs: number): string[] {
  return _sweep(maxIdleMs, stopBrowser);
}

// ═══════════════════════════════════════════════════════════════
// Launch helpers
// ═══════════════════════════════════════════════════════════════

function buildBrowserLaunchArgs(opts: {
  profileDir: string;
  seed: number;
  platform: string;
  cdpPort: number;
  fingerprintMode: FingerprintMode;
  headless?: boolean;
}): string[] {
  const args = [
    `--user-data-dir=${opts.profileDir}`,
    `--remote-debugging-port=${opts.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ];
  // Automation launches headless so there is no window to focus; the headless
  // compositor drives BeginFrames with the timer (60 Hz) so rAF, screenshots
  // and Playwright/Puppeteer actionability checks keep working.
  if (opts.headless) args.push("--headless=new");
  if (opts.fingerprintMode === "managed") {
    args.push(`--fingerprint=${opts.seed}`, `--fingerprint-platform=${opts.platform}`);
  }
  // Direct Chromium launches on macOS can block page navigation while the
  // real Keychain backend waits for OS authorization. Automation profiles do
  // not need that backend; use Chromium's deterministic in-memory keychain.
  if (process.platform === "darwin") args.push("--use-mock-keychain");
  return dedupeChromeArgs(args);
}

const MANAGED_FINGERPRINT_ARG_PREFIXES = [
  "--fingerprint",
  AGENT_BROWSER_FINGERPRINT_SWITCH,
  LEGACY_FINGERPRINT_SWITCH,
  "--user-agent=",
  "--lang=",
  "--window-size=",
  "--window-position=",
  "--force-device-scale-factor=",
];

export function stripManagedFingerprintArgs(args: string[]): string[] {
  return args.filter((arg) => !MANAGED_FINGERPRINT_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix)));
}

function maskSensitiveLaunchArgs(args: string[]): string[] {
  return args.map((arg) => {
    const authSwitch = [NATIVE_PROXY_AUTH_SWITCH, LEGACY_NATIVE_PROXY_AUTH_SWITCH]
      .find((candidate) => arg.startsWith(`${candidate}=`));
    if (authSwitch) {
      return `${authSwitch}=<ephemeral>`;
    }
    if (!arg.startsWith("--proxy-server=")) return arg;
    return arg.replace(/(\w+:\/\/)([^@\s]+)@/, "$1***:***@");
  });
}

function getLaunchArgValue(args: string[], key: string): string | null {
  const prefix = `${key}=`;
  const arg = [...args].reverse().find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function mergeCommaSeparatedValue(value: string, existing: string | null): string {
  const entries = [value, ...(existing || "").split(",")]
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(entries)].join(",");
}

const THROTTLE_MAIN_FRAME_TO_60HZ_FEATURE = "ThrottleMainFrameTo60Hz";

function featureEntryName(entry: string): string {
  return entry.split(/[<:]/, 1)[0].trim();
}

/**
 * Keep managed rAF/compositor pacing on the display's native VSync cadence.
 * Chromium's ThrottleMainFrameTo60Hz field trial deliberately halves main
 * frames on 120Hz displays even while DisplayLink continues at 120Hz. Managed
 * profiles disable that experiment; pass-through launches never call this.
 */
export function applyManagedNativeRefreshRate(args: string[]): string[] {
  const enabled = (getLaunchArgValue(args, "--enable-features") || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && featureEntryName(entry) !== THROTTLE_MAIN_FRAME_TO_60HZ_FEATURE);
  const disabled = (getLaunchArgValue(args, "--disable-features") || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!disabled.some((entry) => featureEntryName(entry) === THROTTLE_MAIN_FRAME_TO_60HZ_FEATURE)) {
    disabled.push(THROTTLE_MAIN_FRAME_TO_60HZ_FEATURE);
  }

  const next = args.filter((arg) =>
    !arg.startsWith("--enable-features=") && !arg.startsWith("--disable-features="));
  if (enabled.length) next.push(`--enable-features=${[...new Set(enabled)].join(",")}`);
  next.push(`--disable-features=${[...new Set(disabled)].join(",")}`);
  return dedupeChromeArgs(next);
}

function addExtensionArgs(args: string[], dirId: string, runtimeExtensionPaths: string[] = []): void {
  const paths = [...runtimeExtensionPaths, ...getEnabledRepositoryExtensionPaths(dirId)];
  if (!paths.length) return;
  const joined = paths.join(",");
  args.push(`--load-extension=${joined}`);
  args.push(`--disable-extensions-except=${joined}`);
}

function addDrmArgs(args: string[], dirId: string): void {
  const drmArgs = drmLaunchArgs(dirId);
  for (const a of drmArgs) args.push(a);
}

function addHardwareFingerprintArgs(args: string[], meta: any): void {
  const normalized = normalizeHardwareFingerprintMeta(meta);
  // Managed GPU identity is carried only by the validated versioned payload;
  // never reintroduce it through unrelated legacy command-line switches.
  if (Number.isInteger(normalized.hardwareConcurrency)) args.push(`--fingerprint-hardware-concurrency=${normalized.hardwareConcurrency}`);
  if (Number.isInteger(normalized.deviceMemory)) args.push(`--fingerprint-device-memory=${normalized.deviceMemory}`);
  if (Number.isInteger(normalized.screenWidth)) args.push(`--fingerprint-screen-width=${normalized.screenWidth}`);
  if (Number.isInteger(normalized.screenHeight)) args.push(`--fingerprint-screen-height=${normalized.screenHeight}`);
  if (Number.isInteger(normalized.storageQuota)) args.push(`--fingerprint-storage-quota=${normalized.storageQuota}`);
  if (Number.isInteger(normalized.taskbarHeight)) args.push(`--fingerprint-taskbar-height=${normalized.taskbarHeight}`);
  if (normalized.fontsDir) args.push(`--fingerprint-fonts-dir=${normalized.fontsDir}`);
}

const WINDOW_TITLE_PREFIX_MAX_LENGTH = 64;

/** Clean a taskbar window-title prefix before handing it to the OS-level switch. */
export function sanitizeWindowTitlePrefix(text: string): string {
  return String(text)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WINDOW_TITLE_PREFIX_MAX_LENGTH);
}

/**
 * Resolve the OS-level window-title prefix for a managed profile. Mirrors
 * RoxyBrowser's Taskbar Icon Display > Profile Name: undefined/empty uses the
 * profile name, a non-empty string is used verbatim, null disables. Never
 * touches document.title.
 */
export function resolveWindowTitlePrefix(meta: BrowserProfileMeta): string | null {
  const raw = meta.windowTitlePrefix;
  if (raw === null) return null;
  const text = raw === undefined || raw === "" ? meta.name || "" : raw;
  const cleaned = sanitizeWindowTitlePrefix(text);
  return cleaned || null;
}

function normalizeHardwareFingerprintMeta(meta: any): {
  gpuVendor?: string | null;
  gpuRenderer?: string | null;
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  storageQuota?: number | null;
  taskbarHeight?: number | null;
  fontsDir?: string | null;
} {
  const fontsDir = normalizeOptionalFontsDir(meta.fontsDir);
  return {
    gpuVendor: normalizeOptionalText(meta.gpuVendor, 80, "GPU vendor"),
    gpuRenderer: normalizeOptionalText(meta.gpuRenderer, 160, "GPU renderer"),
    hardwareConcurrency: normalizeOptionalInteger(meta.hardwareConcurrency, 1, 64, "CPU cores"),
    deviceMemory: normalizeOptionalInteger(meta.deviceMemory, 1, 128, "device memory"),
    screenWidth: normalizeOptionalInteger(meta.screenWidth, 320, 10000, "screen width"),
    screenHeight: normalizeOptionalInteger(meta.screenHeight, 240, 10000, "screen height"),
    storageQuota: normalizeOptionalInteger(meta.storageQuota, 1, 1048576, "storage quota"),
    taskbarHeight: normalizeOptionalInteger(meta.taskbarHeight, 0, 500, "taskbar height"),
    fontsDir,
  };
}

function normalizeOptionalText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength || /[\x00-\x1f\x7f]/.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => normalizeOptionalText(tag, 40, "profile tag")).filter((tag): tag is string => Boolean(tag)))].slice(0, 20);
}

function normalizeOptionalInteger(value: unknown, min: number, max: number, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  return n;
}

function normalizeOptionalFontsDir(value: unknown): string | null {
  const fontsDir = normalizeOptionalText(value, 500, "fonts directory");
  if (!fontsDir) return null;
  const resolved = path.resolve(fontsDir);
  const allowedRoot = path.join(getAppDataDir(), "fonts");
  const realRoot = fs.existsSync(allowedRoot) ? fs.realpathSync(allowedRoot) : allowedRoot;
  const realDir = fs.realpathSync(resolved);
  if (!path.isAbsolute(fontsDir) || !fs.lstatSync(resolved).isDirectory() || !realDir.startsWith(realRoot + path.sep)) {
    throw new Error(`Fonts directory must be inside ${allowedRoot}`);
  }
  return realDir;
}

function normalizeFingerprintSeed(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999999) throw new Error(`Invalid fingerprint seed: ${JSON.stringify(value)}`);
  return n;
}

function normalizeFingerprintMode(value: unknown): FingerprintMode {
  if (value === undefined || value === null || value === "" || value === "managed") return "managed";
  if (value === "off") return "off";
  throw new Error(`Invalid fingerprint mode: ${JSON.stringify(value)}`);
}

function normalizeRenderScaleMode(value: unknown): RenderScaleMode {
  if (value === undefined || value === null || value === "" || value === "native") return "native";
  if (value === "strict") return "strict";
  throw new Error(`Invalid render scale mode: ${JSON.stringify(value)}`);
}

/**
 * Host display's real raster scale (2 on Retina, 1 on a plain 1080p panel).
 * Returns null when the screen module is unavailable (unit tests mock
 * electron without `screen`, and `screen` throws before app-ready).
 */
function detectHostScaleFactor(): number | null {
  try {
    const scale = electronScreen?.getPrimaryDisplay?.()?.scaleFactor;
    return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : null;
  } catch {
    return null;
  }
}

/**
 * Pick the `--force-device-scale-factor` value for a managed launch.
 * `strict` keeps the historical behavior — raster scale equals the spoofed
 * devicePixelRatio, so the rendered pixels match the claimed identity exactly
 * (blurry on HiDPI hosts when the persona claims DPR 1). `native` renders at
 * the host's real scale for crisp text; JS-visible identity values still come
 * from the fingerprint config, so only physical raster scale differs.
 */
export function resolveRenderScaleFactor(mode: RenderScaleMode | null | undefined, personaDevicePixelRatio: number, hostScaleFactor: number | null): number {
  if (mode === "strict") return personaDevicePixelRatio;
  if (hostScaleFactor !== null && Number.isFinite(hostScaleFactor) && hostScaleFactor > 0) return hostScaleFactor;
  return personaDevicePixelRatio;
}

function normalizeBoolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

function normalizePlatform(value: unknown): "windows" | "macos" | "android" {
  if (value === "windows" || value === "macos" || value === "android") return value;
  throw new Error(`Invalid browser platform: ${JSON.stringify(value)}`);
}

function normalizeOptionalLocale(value: unknown): string | null {
  const locale = normalizeOptionalText(value, 35, "locale");
  if (!locale) return null;
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    throw new Error(`Invalid locale: ${JSON.stringify(value)}`);
  }
}

function normalizeOptionalTimezone(value: unknown): string | null {
  const timezone = normalizeOptionalText(value, 80, "timezone");
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    throw new Error(`Invalid timezone: ${JSON.stringify(value)}`);
  }
}

function normalizeOptionalIp(value: unknown): string | null {
  const ip = normalizeOptionalText(value, 45, "WebRTC IP");
  if (!ip) return null;
  if (!net.isIP(ip)) throw new Error(`Invalid WebRTC IP: ${JSON.stringify(value)}`);
  return ip;
}

function normalizeWebRtcMode(value: unknown, legacyIp?: unknown): WebRtcMode {
  if (value === undefined || value === null || value === "") {
    return normalizeOptionalIp(legacyIp) ? "altered" : "auto";
  }
  if (value === "auto" || value === "real" || value === "altered" || value === "disable") return value;
  throw new Error(`Invalid WebRTC mode: ${JSON.stringify(value)}`);
}

function normalizeGeolocationMode(value: unknown): GeolocationMode {
  if (value === undefined || value === null || value === "") return "real";
  if (value === "real" || value === "disable" || value === "custom") return value;
  throw new Error(`Invalid geolocation mode: ${JSON.stringify(value)}`);
}

function normalizeOptionalNumber(value: unknown, min: number, max: number, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return number;
}

function normalizeGeolocationMeta(meta: any): {
  geolocationMode: GeolocationMode;
  geolocationLatitude: number | null;
  geolocationLongitude: number | null;
  geolocationAccuracy: number | null;
} {
  const geolocationMode = normalizeGeolocationMode(meta.geolocationMode);
  const geolocationLatitude = normalizeOptionalNumber(meta.geolocationLatitude, -90, 90, "geolocation latitude");
  const geolocationLongitude = normalizeOptionalNumber(meta.geolocationLongitude, -180, 180, "geolocation longitude");
  let geolocationAccuracy = normalizeOptionalNumber(meta.geolocationAccuracy, 0, 100000, "geolocation accuracy");
  if (geolocationMode === "custom") {
    if (geolocationLatitude == null || geolocationLongitude == null) {
      throw new Error("Custom geolocation requires latitude and longitude");
    }
    geolocationAccuracy ??= 50;
  }
  return { geolocationMode, geolocationLatitude, geolocationLongitude, geolocationAccuracy };
}

function writeProxyAuthExtension(dirId: string, proxy: ProxyConfig): string {
  const extDir = path.join(getAppDataDir(), "runtime-extensions", `proxy-auth-${dirId}`);
  fs.mkdirSync(extDir, { recursive: true, mode: 0o700 });
  const manifest = {
    manifest_version: 3,
    name: "Agent Browser Studio Proxy Auth",
    version: "1.0.0",
    permissions: ["webRequest", "webRequestAuthProvider"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "background.js" },
  };
  const background = `chrome.webRequest.onAuthRequired.addListener(\n` +
    `  function(details, callback) { callback({ authCredentials: { username: ${JSON.stringify(proxy.username || "")}, password: ${JSON.stringify(decryptSecretOr(proxy.password || ""))} } }); },\n` +
    `  { urls: ["<all_urls>"] },\n` +
    `  ["asyncBlocking"]\n` +
    `);\n`;
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.writeFileSync(path.join(extDir, "background.js"), background, { encoding: "utf-8", mode: 0o600 });
  return extDir;
}

export function getLaunchLogPath(dirId: string): string {
  const logDir = path.join(getAppDataDir(), "logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  return path.join(logDir, `browser-${dirId}.log`);
}

async function waitForCdpReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
      const listResp = await fetch(`http://127.0.0.1:${port}/json`);
      if (versionResp.ok && listResp.ok) return;
      lastError = new Error(`CDP returned HTTP ${versionResp.status}/${listResp.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Managed Chromium CDP did not become ready on port ${port}${detail}`);
}

function dedupeChromeArgs(args: string[]): string[] {
  const keyOf = (arg: string) => arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
  const map = new Map<string, string>();
  for (const arg of args) map.set(keyOf(arg), arg);
  return [...map.values()];
}

// Re-export for callers that imported this from browser-manager; implementation lives in process-discovery.
export { parseBrowserProcessLine } from "./process-discovery.js";


// ═══════════════════════════════════════════════════════════════
// Geo-IP: Auto-detect timezone + locale from proxy exit IP
// ═══════════════════════════════════════════════════════════════

async function resolveGeoFromProxy(proxy: ProxyConfig, target: ProxyDetectionTarget | null = null): Promise<{ timezone: string | null; locale: string | null; exitIp: string | null; detection: ProxyDetectionResult | null }> {
  try {
    const detection = target ? await detectProxyTarget(target, "prefer-cache") : await proxyDetector.detect(proxy);
    if (!detection.success) {
      console.log(`[agent-browser] Geo-IP detection skipped: ${detection.error || "proxy may be local or unreachable"}`);
      return { timezone: null, locale: null, exitIp: null, detection };
    }
    const locale = localeFromCountry(detection.countryCode);
    console.log(`[agent-browser] Geo-IP via ${detection.provider}: country=${detection.countryCode || ""} tz=${detection.timezone || ""} locale=${locale || ""}`);
    return { timezone: detection.timezone || null, locale, exitIp: detection.exitIp || null, detection };
  } catch {
    console.log("[agent-browser] Geo-IP detection skipped (proxy may be local or unreachable)");
    return { timezone: null, locale: null, exitIp: null, detection: null };
  }
}

/** Launches share the authenticated atomic observation path. Cache reuse keeps
 * its original time and never renews health/cooldown; unknown time is not now. */
function persistLaunchDetection(target: ProxyDetectionTarget, detection: ProxyDetectionResult): void {
  if (typeof detection.observedAt !== "number" || detection.source === "unknown") return;
  try { commitProxyDetectionIfCurrent(target, detection); }
  catch (error) {
    // Launching a browser is not a promise that a diagnostic was saved. Keep
    // the warning explicit and avoid logging target/credential-comparable keys.
    console.warn("[agent-browser] launch proxy observation was not committed:", error);
  }
}

function localeFromCountry(countryCode: string | null): string | null {
  if (!countryCode || !/^[A-Za-z]{2}$/.test(countryCode)) return null;
  const region = countryCode.toUpperCase();
  try {
    const language = new Intl.Locale(`und-${region}`).maximize().language;
    if (!language || language === "und") return null;
    return Intl.getCanonicalLocales(`${language}-${region}`)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Patch the profile's Preferences file to set the locale so that
 * navigator.languages and navigator.language match the fingerprint locale.
 *
 * --lang CLI flag sets Accept-Language header and UI locale but does NOT
 * change navigator.languages — Chromium always reads that from Preferences.
 */
function patchBrowserLocale(profileDir: string, locale: string): void {
  try {
    const prefsPath = path.join(profileDir, "Default", "Preferences");
    let prefs: any = {};
    if (fs.existsSync(prefsPath)) {
      try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8")); } catch { /* use empty */ }
    }
    if (!prefs.intl) prefs.intl = {};
    prefs.intl.selected_languages = `${locale},${locale.split("-")[0]}`;
    prefs.intl.accept_languages = `${locale},${locale.split("-")[0]}`;
    const tmp = prefsPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(prefs), "utf-8");
    fs.renameSync(tmp, prefsPath);
    console.log(`[agent-browser] Patched locale in Preferences: ${locale}`);
  } catch (e: any) {
    console.error(`[agent-browser] Failed to patch locale in Preferences: ${e.message}`);
  }
}

interface PreferenceBackupValue {
  present: boolean;
  value?: unknown;
}

interface ThirdPartyCookiePreferenceBackup {
  schemaVersion: 1;
  cookieControlsMode: PreferenceBackupValue;
  trackingProtection3pcdEnabled: PreferenceBackupValue;
  blockAll3pcToggleEnabled: PreferenceBackupValue;
}

function backupValue(object: Record<string, unknown>, key: string): PreferenceBackupValue {
  return Object.hasOwn(object, key) ? { present: true, value: object[key] } : { present: false };
}

function restoreValue(object: Record<string, unknown>, key: string, backup: PreferenceBackupValue): void {
  if (backup.present) object[key] = backup.value;
  else delete object[key];
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(value), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function patchThirdPartyCookieCompatibility(profileDir: string, enabled: boolean): void {
  const prefsPath = path.join(profileDir, "Default", "Preferences");
  const managedBackupPath = path.join(profileDir, ".agent-browser-third-party-cookie-backup.json");
  const legacyBackupPath = path.join(profileDir, ".roxy-third-party-cookie-backup.json");
  const existingBackupPath = fs.existsSync(managedBackupPath)
    ? managedBackupPath
    : fs.existsSync(legacyBackupPath) ? legacyBackupPath : null;
  try {
    let prefs: Record<string, any> = {};
    if (fs.existsSync(prefsPath)) {
      prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    }
    if (!prefs.profile || typeof prefs.profile !== "object") prefs.profile = {};
    if (!prefs.tracking_protection || typeof prefs.tracking_protection !== "object") prefs.tracking_protection = {};

    if (enabled) {
      if (!existingBackupPath) {
        const backup: ThirdPartyCookiePreferenceBackup = {
          schemaVersion: 1,
          cookieControlsMode: backupValue(prefs.profile, "cookie_controls_mode"),
          trackingProtection3pcdEnabled: backupValue(prefs.tracking_protection, "tracking_protection_3pcd_enabled"),
          blockAll3pcToggleEnabled: backupValue(prefs.tracking_protection, "block_all_3pc_toggle_enabled"),
        };
        writeJsonAtomic(managedBackupPath, backup);
      }
      // These are Chromium's stock user preferences. kOff is 0; both tracking
      // protection toggles must also be off for a true opt-in compatibility
      // mode in current Chrome rather than a feature-flag approximation.
      prefs.profile.cookie_controls_mode = 0;
      prefs.tracking_protection.tracking_protection_3pcd_enabled = false;
      prefs.tracking_protection.block_all_3pc_toggle_enabled = false;
      writeJsonAtomic(prefsPath, prefs);
      return;
    }

    if (!existingBackupPath) return;
    const backup = JSON.parse(fs.readFileSync(existingBackupPath, "utf-8")) as ThirdPartyCookiePreferenceBackup;
    if (backup.schemaVersion !== 1 || !backup.cookieControlsMode ||
        !backup.trackingProtection3pcdEnabled || !backup.blockAll3pcToggleEnabled) {
      throw new Error("invalid third-party cookie preference backup");
    }
    restoreValue(prefs.profile, "cookie_controls_mode", backup.cookieControlsMode);
    restoreValue(prefs.tracking_protection, "tracking_protection_3pcd_enabled", backup.trackingProtection3pcdEnabled);
    restoreValue(prefs.tracking_protection, "block_all_3pc_toggle_enabled", backup.blockAll3pcToggleEnabled);
    if (Object.keys(prefs.profile).length === 0) delete prefs.profile;
    if (Object.keys(prefs.tracking_protection).length === 0) delete prefs.tracking_protection;
    writeJsonAtomic(prefsPath, prefs);
    fs.unlinkSync(existingBackupPath);
  } catch (error) {
    throw new Error(`Failed to apply third-party cookie compatibility: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

async function findFreePortWithRetry(retries = 2): Promise<number> {
  let last: unknown = null;
  for (let i = 0; i <= retries; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    }).catch(e => { last = e; return null as unknown as number; });
    if (port) return port;
  }
  throw last instanceof Error ? last : new Error(String(last || 'No free port'));
}
function findFreePort(): number {
  // Sync fallback for legacy call sites: best-effort single probe.
  // Binds loopback only and cleans up synchronously; throws (instead of
  // crashing via an unhandled 'error' event) when no port is available.
  // New call sites must use findFreePortWithRetry (async, with retries).
  const srv = net.createServer();
  srv.on("error", () => { /* handled below via address check */ });
  srv.listen(0, "127.0.0.1");
  const addr = srv.address();
  srv.close();
  if (!addr || typeof addr === "string" || typeof (addr as net.AddressInfo).port !== "number") {
    throw new Error("No free loopback port available");
  }
  return (addr as net.AddressInfo).port;
}
