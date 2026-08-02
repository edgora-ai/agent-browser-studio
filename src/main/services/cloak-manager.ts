// ── CloakBrowser Manager ──
// CloakBrowser is an open-source stealth Chromium (MIT, 58 C++ patches).
// Uses --fingerprint=<seed> for deterministic fingerprint profiles.
// Auto-downloads binary via pip/npm. No encryption needed.

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import { createHash } from "node:crypto";
import { spawn, execSync, execFileSync } from "node:child_process";
import { BrowserWindow } from "electron";
import { binaryInfo, ensureBinary, checkForUpdate, clearCache, buildLaunchOptions, getDefaultStealthArgs } from "cloakbrowser";
import { getConfig, saveConfig, getAppDataDir, getProfilesDir, resolveProfileProxy, resolveProfileProxySecret, getProxyDetection } from "./config-manager.js";
import { cdpCookieService } from "./cdp-cookie-service.js";
import { decryptSecretOr } from "./secrets.js";
import { recordAudit } from "./audit-log.js";
import { checkProfileConsistency } from "./consistency-check.js";
import { getEnabledRepositoryExtensionPaths } from "./extension-repository.js";
import { acquireRestoreLock } from "./profile-restore-lock.js";
import {
  startAuthenticatedSocksBridge,
  type AuthenticatedSocksBridge,
} from "./authenticated-socks-bridge.js";
import { buildProxyUrl, buildChromiumProxyUrl, proxyDetector } from "./proxy-detector.js";
import { validateDirId } from "./utils.js";
import { emitEvent } from "./event-bus.js";
import {
  buildRoxyFingerprintArg,
  buildRoxyFingerprintConfig,
  validateRoxyHardwareProfile,
} from "./roxy-fingerprint-config.js";
import {
  findManagedChromiumBinary,
  getManagedChromiumRoot,
  listManagedChromiumBinaries,
  normalizeManagedChromiumVersion,
} from "./native-chromium-manager.js";
import {
  NATIVE_PROXY_AUTH_SWITCH,
  type NativeProxyAuthFile,
  supportsNativeProxyAuth,
  writeNativeProxyAuthFile,
} from "./native-proxy-auth.js";
import type { FingerprintMode, GeolocationMode, ProxyConfig, WebRtcMode } from "../types.js";

export interface CloakProfile {
  dirId: string;
  name: string;
  version: string;       // Chromium version
  browserVersion: string | null; // exact installed version pin, or auto
  fingerprintMode: FingerprintMode;
  allowThirdPartyCookies: boolean;
  fingerprintSeed: number; // integer seed for deterministic fingerprint
  platform: "windows" | "macos";
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
  proxyMode: "none" | "default" | "named";
  proxyName: string | null;  // resolved proxy reference name
  note: string | null;      // user note
  tags: string[];
  syncedAt: number | null;
  syncStatus: "synced" | "dirty" | "never";
  lastModified: number;
  running: boolean;
  pid: number | null;
  cdpPort: number | null;
}

const runningProcesses = new Map<string, {
  pid: number;
  process: any;
  port: number;
  killTimer?: ReturnType<typeof setTimeout>;
  proxyBridge?: AuthenticatedSocksBridge;
}>();

// ═══════════════════════════════════════════════════════════════
// Binary Discovery
// ═══════════════════════════════════════════════════════════════

export function getManagedRoxyChromiumRoot(): string {
  return getManagedChromiumRoot();
}

export function findManagedRoxyBinary(requestedVersion?: string | null): string | null {
  return findManagedChromiumBinary(requestedVersion)?.binaryPath || null;
}

export function findCloakBinary(requestedVersion?: string | null): string | null {
  const version = normalizeManagedChromiumVersion(requestedVersion);
  const cfg = getConfig() as any;
  if (cfg.cloakBin && cfg.cloakBin !== "auto" && fs.existsSync(cfg.cloakBin)) {
    return !version || detectBinaryVersion(cfg.cloakBin) === version ? cfg.cloakBin : null;
  }

  const envBin = process.env.CLOAKBROWSER_BINARY_PATH;
  if (envBin && fs.existsSync(envBin)) {
    return !version || detectBinaryVersion(envBin) === version ? envBin : null;
  }

  const managedBin = findManagedRoxyBinary(version);
  if (managedBin) return managedBin;

  const info = binaryInfo();
  if (!info.installed || !fs.existsSync(info.binaryPath)) return null;
  return !version || detectBinaryVersion(info.binaryPath) === version ? info.binaryPath : null;
}

export function getCloakVersion(): string | null {
  const bin = findCloakBinary();
  if (!bin) return null;
  const detected = detectBinaryVersion(bin);
  if (detected) return detected;
  const info = binaryInfo();
  return fs.existsSync(info.binaryPath) && path.resolve(bin) === path.resolve(info.binaryPath)
    ? info.version
    : "?";
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

export function isCloakInstalled(): boolean {
  return findCloakBinary() !== null;
}

export interface CloakBinaryStatus {
  path: string | null;
  version: string | null;
  bundledVersion: string | null;
  tier: "community" | "free" | "pro" | null;
  installed: boolean;
  platform: string | null;
  cacheDir: string | null;
  downloadUrl: string | null;
  installedVersions: Array<{ version: string; path: string }>;
}

export function getCloakBinaryStatus(): CloakBinaryStatus {
  const info = binaryInfo();
  const pathValue = findCloakBinary();
  const managedPath = findManagedRoxyBinary();
  const installedVersions = listManagedChromiumBinaries().map((candidate) => ({
    version: candidate.version,
    path: candidate.binaryPath,
  }));
  const isManaged = Boolean(pathValue && managedPath && path.resolve(pathValue) === path.resolve(managedPath));
  const detectedVersion = pathValue ? detectBinaryVersion(pathValue) : null;
  return {
    path: pathValue,
    version: detectedVersion || (pathValue ? getCloakVersion() : null),
    bundledVersion: isManaged ? detectedVersion : info.bundledVersion || null,
    tier: pathValue ? "community" : null,
    installed: pathValue !== null,
    platform: info.platform || null,
    cacheDir: isManaged && pathValue
      ? path.join(getManagedRoxyChromiumRoot(), path.relative(getManagedRoxyChromiumRoot(), pathValue).split(path.sep)[0])
      : info.cacheDir || null,
    downloadUrl: isManaged ? null : info.downloadUrl || null,
    installedVersions,
  };
}

export async function installCloakBinary(): Promise<CloakBinaryStatus> {
  await ensureBinary();
  return getCloakBinaryStatus();
}

export async function checkCloakBinaryUpdate(): Promise<{ currentVersion: string | null; latestVersion: string | null; hasUpdate: boolean; status: CloakBinaryStatus }> {
  const status = getCloakBinaryStatus();
  const latestVersion = await getLatestCloakChromiumVersion(status.platform);
  return {
    currentVersion: status.version,
    latestVersion,
    hasUpdate: Boolean(latestVersion && status.version && versionNewer(latestVersion, status.version)),
    status,
  };
}

export async function updateCloakBinary(): Promise<{ updated: boolean; latestVersion: string | null; status: CloakBinaryStatus }> {
  const before = getCloakBinaryStatus();
  await ensureBinary();
  const resolved = getCloakBinaryStatus();
  const installedVersion = resolved.tier === "community" || resolved.tier === "free"
    ? await checkForUpdate()
    : null;
  const status = getCloakBinaryStatus();
  return {
    updated: Boolean(installedVersion || status.version !== before.version || status.tier !== before.tier),
    latestVersion: installedVersion || status.version,
    status,
  };
}

export function clearCloakBinaryCache(): CloakBinaryStatus {
  clearCache();
  return getCloakBinaryStatus();
}

async function getLatestCloakChromiumVersion(platformTag: string | null): Promise<string | null> {
  if (!platformTag) return null;
  try {
    const resp = await fetch("https://api.github.com/repos/CloakHQ/cloakbrowser/releases?per_page=10", {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const releases = await resp.json() as Array<{ tag_name?: string; draft?: boolean; assets?: Array<{ name?: string }> }>;
    const archiveExt = process.platform === "win32" ? ".zip" : ".tar.gz";
    const archiveName = `cloakbrowser-${platformTag}${archiveExt}`;
    for (const release of releases) {
      if (!release.tag_name || !/^chromium-v\d+(?:\.\d+)+$/.test(release.tag_name) || release.draft) continue;
      const assetNames = new Set((release.assets || []).map((asset) => asset.name));
      if (assetNames.has(archiveName)) return release.tag_name.replace(/^chromium-v/, "");
    }
    return null;
  } catch {
    return null;
  }
}

function versionNewer(a: string, b: string): boolean {
  const va = a.split(".").map(Number);
  const vb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const ai = Number.isFinite(va[i]) ? va[i] : 0;
    const bi = Number.isFinite(vb[i]) ? vb[i] : 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// Profile Management
// ═══════════════════════════════════════════════════════════════

/** Create a CloakBrowser profile using --fingerprint=<seed>. */
export function createCloakProfile(opts: {
  name: string;
  fingerprintMode?: FingerprintMode;
  browserVersion?: string | null;
  allowThirdPartyCookies?: boolean;
  fingerprintSeed?: number;
  platform?: "windows" | "macos";
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
  fontsDir?: string | null;
  proxyMode?: "none" | "default" | "named";
  proxyName?: string | null;
  tags?: string[];
}): { dirId: string } {
  const dirId = "cb_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);

  const cfg = structuredClone(getConfig());
  cfg.cloakProfiles = cfg.cloakProfiles || {};
  const proxyMode = opts.proxyMode || (opts.proxyName ? "named" : "default");
  const webrtcMode = normalizeWebRtcMode(opts.webrtcMode, opts.webrtcIp);
  if (proxyMode !== "none" && proxyMode !== "default" && proxyMode !== "named") {
    throw new Error(`Invalid proxy mode: ${JSON.stringify(proxyMode)}`);
  }
  if (proxyMode === "named" && (!opts.proxyName || !Object.hasOwn(cfg.proxies, opts.proxyName))) {
    throw new Error(`Proxy not found: ${opts.proxyName || ""}`);
  }
  const profile = {
    name: opts.name,
    fingerprintMode: normalizeFingerprintMode(opts.fingerprintMode),
    browserVersion: normalizeManagedChromiumVersion(opts.browserVersion),
    allowThirdPartyCookies: normalizeBoolean(opts.allowThirdPartyCookies, "third-party cookie compatibility"),
    fingerprintSeed: normalizeFingerprintSeed(opts.fingerprintSeed || Math.floor(Math.random() * 90000) + 10000),
    platform: normalizePlatform(opts.platform || (process.platform === "darwin" ? "macos" : "windows")),
    timezone: normalizeOptionalTimezone(opts.timezone),
    locale: normalizeOptionalLocale(opts.locale),
    webrtcMode,
    webrtcIp: webrtcMode === "real" || webrtcMode === "disable" ? null : normalizeOptionalIp(opts.webrtcIp),
    ...normalizeGeolocationMeta(opts),
    ...normalizeHardwareFingerprintMeta(opts),
    proxyMode,
    proxyName: proxyMode === "named" ? opts.proxyName || null : null,
    note: null,
    tags: normalizeTags(opts.tags),
  };
  if (profile.fingerprintMode !== "off") validateRoxyHardwareProfile(profile);
  cfg.cloakProfiles[dirId] = profile;

  const profileDir = path.join(getProfilesDir(), dirId);
  try {
    fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
    saveConfig(cfg);
  } catch (e) {
    if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    throw e;
  }

  return { dirId };
}

export function deleteCloakProfile(dirId: string): boolean {
  validateDirId(dirId);
  const st = statusCloak(dirId);
  if (st.running) throw new Error("Cannot delete profile while CloakBrowser is running");
  const profileDir = path.join(getProfilesDir(), dirId);
  try {
    if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    const cfg = getConfig();
    if (cfg.cloakProfiles) { delete cfg.cloakProfiles[dirId]; }
    saveConfig(cfg);
    return true;
  } catch { return false; }
}

export function listCloakProfiles(): CloakProfile[] {
  const cfg = getConfig() as any;
  const profiles = cfg.cloakProfiles || {};
  const result: CloakProfile[] = [];
  for (const [dirId, meta] of Object.entries(profiles)) {
    const m = meta as any;
    const st = statusCloak(dirId);
    const profileDir = path.join(getProfilesDir(), dirId);
    const lastModified = fs.existsSync(profileDir) ? Math.floor(fs.statSync(profileDir).mtimeMs) : 0;
    const syncedAt = m.syncedAt || null;
    const syncStatus = getProfileSyncStatus(m, lastModified, dirId);
    const resolvedProxy = resolveProfileProxy(dirId);
    result.push({
      dirId,
      name: m.name || dirId.slice(0, 8),
      version: normalizeManagedChromiumVersion(m.browserVersion) || getCloakVersion() || "?",
      browserVersion: normalizeManagedChromiumVersion(m.browserVersion),
      fingerprintMode: normalizeFingerprintMode(m.fingerprintMode),
      allowThirdPartyCookies: normalizeBoolean(m.allowThirdPartyCookies, "third-party cookie compatibility"),
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
      proxyMode: resolvedProxy.mode,
      proxyName: resolvedProxy.name,
      note: m.note || null,
      tags: normalizeTags(m.tags),
      syncedAt,
      syncStatus,
      lastModified,
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

export async function launchCloak(dirId: string): Promise<{ pid: number; cdpPort: number }> {
  validateDirId(dirId);
  if (!dirId.startsWith("cb_")) {
    throw new Error(`Profile ${dirId.slice(0, 8)} is not a CloakBrowser profile`);
  }
  let releaseLaunchLock: (() => void) | null = null;
  let pendingNativeProxyAuth: NativeProxyAuthFile | null = null;
  let pendingSocksBridge: AuthenticatedSocksBridge | null = null;
  try {
    releaseLaunchLock = acquireRestoreLock(dirId);
  } catch {
    throw new Error(`Profile ${dirId.slice(0, 8)} is being restored; launch is temporarily blocked`);
  }

  try {
  const cfg = getConfig() as any;
  const meta = cfg.cloakProfiles?.[dirId];
  if (!meta) throw new Error(`CloakBrowser profile not found: ${dirId}`);

  // Memory-map check with alive test
  const existing = runningProcesses.get(dirId);
  if (existing) {
    try { process.kill(existing.pid, 0); return { pid: existing.pid, cdpPort: existing.port }; }
    catch { runningProcesses.delete(dirId); }
  }

  // ps fallback: survive app restarts
  const psFallback = findCloakByProfile(dirId);
  if (psFallback) {
    runningProcesses.set(dirId, { pid: psFallback.pid, process: null, port: psFallback.cdpPort });
    return { pid: psFallback.pid, cdpPort: psFallback.cdpPort };
  }

  const configuredBin = cfg.cloakBin && cfg.cloakBin !== "auto" ? cfg.cloakBin : null;
  const envBin = process.env.CLOAKBROWSER_BINARY_PATH || null;
  const fingerprintMode = normalizeFingerprintMode(meta.fingerprintMode);
  const passThrough = fingerprintMode === "off";
  const requestedVersion = normalizeManagedChromiumVersion(meta.browserVersion);
  const managedBin = findManagedRoxyBinary(requestedVersion);
  if (configuredBin && !fs.existsSync(configuredBin)) {
    throw new Error(`Configured CloakBrowser binary does not exist: ${configuredBin}`);
  }
  if (envBin && !fs.existsSync(envBin)) {
    throw new Error(`CLOAKBROWSER_BINARY_PATH does not exist: ${envBin}`);
  }
  const overrideBin = configuredBin || envBin;
  if (requestedVersion && overrideBin && detectBinaryVersion(overrideBin) !== requestedVersion) {
    throw new Error(`Profile requires Chromium ${requestedVersion}, but the configured binary is ${detectBinaryVersion(overrideBin) || "unknown"}`);
  }
  if (requestedVersion && !overrideBin && !managedBin) {
    const available = listManagedChromiumBinaries().map((candidate) => candidate.version).join(", ") || "none";
    throw new Error(`Chromium ${requestedVersion} is not installed; available managed versions: ${available}`);
  }

  const profileDir = path.join(getProfilesDir(), dirId);

  // Find free CDP port
  const cdpPort = findFreePort();
  const seed = normalizeFingerprintSeed(meta.fingerprintSeed || 12345);
  const platform = normalizePlatform(meta.platform || "windows");
  const resolvedProxy = resolveProfileProxySecret(dirId);
  if (resolvedProxy.mode !== "none" && !resolvedProxy.config) {
    const label = resolvedProxy.name ? `"${resolvedProxy.name}"` : resolvedProxy.mode;
    throw new Error(`Profile proxy ${label} is not configured; refusing to launch without the requested proxy`);
  }
  const activeProxy = resolvedProxy.config;
  const requestedWebRtcMode = passThrough ? "real" : normalizeWebRtcMode(meta.webrtcMode, meta.webrtcIp);
  const shouldResolveWebRtc = requestedWebRtcMode === "auto" || requestedWebRtcMode === "altered";
  console.log(`[cloak] Preparing profile ${dirId.slice(0, 8)} mode=${fingerprintMode} browser=${requestedVersion || "auto"}`);

  // Pre-launch consistency check (timezone / locale / WebRTC vs proxy). Warns
  // by default; blocks only when config.blockOnConsistencyConflict is set.
  const consistency = passThrough ? { ok: true, warnings: [], blockers: [] } : checkProfileConsistency({
    timezone: meta.timezone, locale: meta.locale,
    webrtcIp: shouldResolveWebRtc ? meta.webrtcIp : null,
    platform: meta.platform,
    proxyMode: resolvedProxy.mode,
    proxyGeo: resolvedProxy.name ? getProxyDetection(resolvedProxy.name) : null,
  });
  for (const w of consistency.warnings) recordAudit({ category: "profile", action: "consistency-warning", target: dirId, detail: `${w.code}: ${w.message}` });
  if (!consistency.ok) {
    for (const b of consistency.blockers) recordAudit({ category: "profile", action: "consistency-blocker", target: dirId, detail: `${b.code}: ${b.message}` });
    if (cfg.blockOnConsistencyConflict) {
      throw new Error(`Launch blocked by consistency check: ${consistency.blockers.map((b) => b.message).join("; ")}`);
    }
  }

  const requestedArgs = buildCloakLaunchArgs({
    profileDir,
    seed,
    platform,
    cdpPort,
    fingerprintMode,
  });
  let effectiveTimezone = passThrough ? null : normalizeOptionalTimezone(meta.timezone);
  let effectiveLocale = passThrough ? null : normalizeOptionalLocale(meta.locale);
  let webrtcIp = shouldResolveWebRtc ? normalizeOptionalIp(meta.webrtcIp) : null;
  const wrapperGeoip = !passThrough && shouldUseWrapperGeoip();
  if (!passThrough && !wrapperGeoip) {
    if (activeProxy && (!effectiveTimezone || !effectiveLocale || (shouldResolveWebRtc && !webrtcIp))) {
      const detected = await resolveGeoFromProxy(activeProxy);
      if (!effectiveTimezone) effectiveTimezone = detected.timezone;
      if (!effectiveLocale) effectiveLocale = detected.locale;
      if (shouldResolveWebRtc && !webrtcIp) {
        webrtcIp = detected.exitIp;
      }
    }
    if (!effectiveTimezone) effectiveTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    if (!effectiveLocale) effectiveLocale = normalizeOptionalLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  }
  console.log(`[cloak] Identity resolved for ${dirId.slice(0, 8)}: geoip=${wrapperGeoip ? "wrapper" : "bounded"} locale=${effectiveLocale || "auto"} timezone=${effectiveTimezone || "auto"}`);
  if (!passThrough && webrtcIp) requestedArgs.push(`--fingerprint-webrtc-ip=${webrtcIp}`);
  if (activeProxy?.bypassList?.length) requestedArgs.push(`--proxy-bypass-list=${activeProxy.bypassList.join(";")}`);
  if (!passThrough) addHardwareFingerprintArgs(requestedArgs, meta);

  const preferredBin = configuredBin || envBin || managedBin;
  if (passThrough && !preferredBin) {
    throw new Error("Pass-through mode requires an installed independent Chromium build");
  }
  // A self-built/configured Chromium is launched from our own deterministic
  // plan. The license-free community wrapper remains only as a compatibility
  // fallback when no independent binary has been installed.
  const launchPlan = preferredBin
    ? {
        executablePath: preferredBin,
        args: dedupeChromeArgs([
          ...(passThrough ? [] : getDefaultStealthArgs()),
          ...requestedArgs,
          ...(!passThrough && effectiveTimezone ? [`--fingerprint-timezone=${effectiveTimezone}`] : []),
          ...(!passThrough && effectiveLocale ? [`--lang=${effectiveLocale}`, `--fingerprint-locale=${effectiveLocale}`] : []),
        ]),
        env: process.env,
      }
    : await buildLaunchOptions({
        headless: false,
        args: requestedArgs,
        timezone: effectiveTimezone || undefined,
        locale: effectiveLocale || undefined,
        geoip: wrapperGeoip,
        stealthArgs: !passThrough,
        proxy: activeProxy ? buildAuthenticatedProxyUrl(activeProxy) : undefined,
      });
  console.log(`[cloak] ${preferredBin ? "Native" : "Wrapper"} launch plan ready for ${dirId.slice(0, 8)}`);
  const bin = preferredBin || launchPlan.executablePath;
  if (!bin || !fs.existsSync(bin)) throw new Error("CloakBrowser binary is unavailable after install check");
  const nativeChromiumVersion = detectBinaryVersion(bin) || getCloakVersion();
  if (requestedVersion && nativeChromiumVersion !== requestedVersion) {
    throw new Error(`Profile requires Chromium ${requestedVersion}, resolved ${nativeChromiumVersion || "unknown"}`);
  }
  let args = [...(launchPlan.args || [])];
  if (passThrough) args = stripManagedFingerprintArgs(args);

  // Prefer the wrapper's resolved exit identity, then perform a bounded proxy
  // lookup for our native altered mode. Explicit altered mode must never
  // silently degrade to real-IP WebRTC.
  if (shouldResolveWebRtc && !webrtcIp) {
    webrtcIp = normalizeOptionalIp(getLaunchArgValue(args, "--fingerprint-webrtc-ip"));
    if (!webrtcIp && activeProxy) {
      webrtcIp = (await resolveGeoFromProxy(activeProxy)).exitIp;
    }
  }
  if (requestedWebRtcMode === "altered" && !webrtcIp) {
    throw new Error("WebRTC altered mode requires a custom IP or a proxy with a detectable exit IP");
  }
  const effectiveWebRtcMode = requestedWebRtcMode === "auto"
    ? (webrtcIp ? "altered" : "real")
    : requestedWebRtcMode;

  // Our Chromium fork consumes one versioned, base64url JSON identity. Add it
  // after wrapper resolution so native WebRTC uses the final proxy exit IP.
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
    const nativeFingerprint = buildRoxyFingerprintConfig(nativeFingerprintMeta, nativeChromiumVersion);
    args.push(buildRoxyFingerprintArg(nativeFingerprintMeta, nativeChromiumVersion));
    args.push(`--user-agent=${nativeFingerprint.userAgent}`);
    if (preferredBin) {
      args = dedupeChromeArgs([
        ...args,
        `--window-size=${nativeFingerprint.screen.outerWidth},${nativeFingerprint.screen.outerHeight}`,
        `--window-position=${nativeFingerprint.screen.windowX},${nativeFingerprint.screen.windowY}`,
        `--force-device-scale-factor=${nativeFingerprint.screen.devicePixelRatio}`,
      ]);
    }
  }

  // Ordinary HTTP/SOCKS proxies cannot carry Chromium QUIC traffic. Fail
  // closed instead of allowing a UDP path outside the managed proxy. HTTP 407
  // credentials use the browser-only native channel when available; older or
  // third-party binaries retain the extension compatibility fallback.
  const runtimeExtensionPaths: string[] = [];
  if (activeProxy) {
    let chromiumProxy = activeProxy;
    if (activeProxy.username && (activeProxy.type === "socks5" || activeProxy.type === "socks5h")) {
      pendingSocksBridge = await startAuthenticatedSocksBridge(activeProxy);
      chromiumProxy = {
        ...activeProxy,
        type: "socks5",
        host: pendingSocksBridge.host,
        port: pendingSocksBridge.port,
        username: undefined,
        password: undefined,
      };
    }
    args = dedupeChromeArgs([
      ...args,
      `--proxy-server=${buildChromiumProxyUrl(chromiumProxy)}`,
      "--disable-quic",
    ]);
    if (activeProxy.username && activeProxy.type === "http" && supportsNativeProxyAuth(bin)) {
      pendingNativeProxyAuth = writeNativeProxyAuthFile({
        host: activeProxy.host,
        port: activeProxy.port,
        username: activeProxy.username,
        password: activeProxy.password || "",
      });
      args = dedupeChromeArgs([
        ...args,
        `${NATIVE_PROXY_AUTH_SWITCH}=${pendingNativeProxyAuth.filePath}`,
      ]);
    } else if (activeProxy.username && activeProxy.type === "http") {
      runtimeExtensionPaths.push(writeProxyAuthExtension(dirId, activeProxy));
    }
  }
  addExtensionArgs(args, dirId, runtimeExtensionPaths);

  // The wrapper fills locale from the egress IP. If resolution is unavailable,
  // use a deterministic fallback instead of leaking the host UI language.
  if (!passThrough) {
    let launchLocale = getLaunchArgValue(args, "--fingerprint-locale") || getLaunchArgValue(args, "--lang");
    if (!launchLocale) {
      launchLocale = "en-US";
      args.push(`--lang=${launchLocale}`, `--fingerprint-locale=${launchLocale}`);
    }
    patchCloakLocale(profileDir, launchLocale);
  }
  patchThirdPartyCookieCompatibility(
    profileDir,
    !passThrough && normalizeBoolean(meta.allowThirdPartyCookies, "third-party cookie compatibility"),
  );

  const logFile = getLaunchLogPath(dirId);
  const logFd = fs.openSync(logFile, "a");
  fs.writeSync(logFd, `\n[${new Date().toISOString()}] Launching ${bin}\n${maskSensitiveLaunchArgs(args).join(" ")}\n`);
  const launchEnv = (launchPlan as any).env as NodeJS.ProcessEnv | undefined;
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", logFd, logFd], env: launchEnv || process.env });
  child.unref();

  child.on("error", (err: Error) => {
    const failedEntry = runningProcesses.get(dirId);
    void failedEntry?.proxyBridge?.close().catch(() => undefined);
    runningProcesses.delete(dirId);
    console.error(`[cloak] spawn error for ${dirId.slice(0, 8)}:`, err.message);
  });

  if (!child.pid) throw new Error(`CloakBrowser failed to start (no PID returned) for ${dirId.slice(0, 8)}`);
  const pid = child.pid;

  runningProcesses.set(dirId, {
    pid,
    process: child,
    port: cdpPort,
    ...(pendingSocksBridge ? { proxyBridge: pendingSocksBridge } : {}),
  });
  pendingSocksBridge = null;
  if (releaseLaunchLock) {
    releaseLaunchLock();
    releaseLaunchLock = null;
  }

  try {
    await waitForCdpReady(cdpPort, 15000);
    const queuedCookies = await cdpCookieService.applyQueuedImports(dirId);
    if (queuedCookies > 0) console.log(`[cloak] Applied ${queuedCookies} queued cookies for ${dirId.slice(0, 8)}`);
  } catch (e) {
    const failedEntry = runningProcesses.get(dirId);
    runningProcesses.delete(dirId);
    await failedEntry?.proxyBridge?.close().catch(() => undefined);
    try { process.kill(pid, "SIGTERM"); } catch (killError) { console.error(`[cloak] failed to terminate unready process ${pid}:`, killError); }
    try { fs.closeSync(logFd); } catch (closeError) { console.error(`[cloak] failed to close launch log:`, closeError); }
    throw e;
  }

  child.on("exit", () => {
    // Cancel pending SIGKILL timer if any — process exited naturally
    const entry = runningProcesses.get(dirId);
    if (entry?.killTimer) { clearTimeout(entry.killTimer); }
    void entry?.proxyBridge?.close().catch(() => undefined);
    runningProcesses.delete(dirId);
    try { fs.closeSync(logFd); } catch (closeError) { console.error(`[cloak] failed to close launch log:`, closeError); }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("cloak:exited", { dirId, pid, timestamp: Date.now() });
    }
    emitEvent("profile:exited", { dirId, pid });
  });

  emitEvent("profile:launched", { dirId, pid, cdpPort });
  recordAudit({ category: "profile", action: "launch", target: dirId, actor: "user", detail: `pid=${pid} cdpPort=${cdpPort} fingerprint=${fingerprintMode} browser=${nativeChromiumVersion || "unknown"}` });
  return { pid, cdpPort };
  } finally {
    pendingNativeProxyAuth?.cleanup();
    await pendingSocksBridge?.close().catch(() => undefined);
    if (releaseLaunchLock) releaseLaunchLock();
  }
}

export function stopCloak(dirId: string): boolean {
  validateDirId(dirId);
  const entry = runningProcesses.get(dirId);
  const pids: number[] = [];
  if (entry) pids.push(entry.pid);
  // ps fallback: pick up processes we lost track of
  const psFound = findCloakByProfile(dirId);
  if (psFound && !pids.includes(psFound.pid)) pids.push(psFound.pid);
  if (!pids.length) return false;

  // Cancel any pending SIGKILL timer to prevent stale PID reuse race
  if (entry?.killTimer) { clearTimeout(entry.killTimer); }

  for (const p of pids) {
    try { process.kill(p, "SIGTERM"); } catch {}
  }
  const killTimer = setTimeout(() => {
    // Only SIGKILL if the process is still tracked (hasn't exited naturally)
    const current = runningProcesses.get(dirId);
    if (current && current.pid === pids[0]) {
      for (const p of pids) {
        try { process.kill(p, "SIGKILL"); } catch {}
      }
      void current.proxyBridge?.close().catch(() => undefined);
      runningProcesses.delete(dirId);
    }
  }, 3000);

  // Update entry with killTimer so it can be cancelled on natural exit
  if (entry) {
    entry.killTimer = killTimer;
  } else {
    runningProcesses.set(dirId, { pid: pids[0], process: null, port: 0, killTimer });
  }

  recordAudit({ category: "profile", action: "stop", target: dirId, actor: "user" });
  return true;
}

export function statusCloak(dirId: string): { running: boolean; pid: number | null; cdpPort: number | null } {
  validateDirId(dirId);
  const entry = runningProcesses.get(dirId);
  if (entry) {
    try {
      process.kill(entry.pid, 0);
      return { running: true, pid: entry.pid, cdpPort: entry.port };
    } catch {
      void entry.proxyBridge?.close().catch(() => undefined);
      runningProcesses.delete(dirId);
    }
  }
  // ps fallback
  const psFound = findCloakByProfile(dirId);
  if (psFound) {
    runningProcesses.set(dirId, { pid: psFound.pid, process: null, port: psFound.cdpPort });
    return { running: true, pid: psFound.pid, cdpPort: psFound.cdpPort };
  }
  return { running: false, pid: null, cdpPort: null };
}

export async function getCdpWebSocketUrl(port: number): Promise<string | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  try {
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (versionResp.ok) {
      const version = await versionResp.json() as { webSocketDebuggerUrl?: string };
      if (typeof version.webSocketDebuggerUrl === "string" && version.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`)) {
        return version.webSocketDebuggerUrl;
      }
    }
  } catch { /* fall back to page target list */ }

  try {
    const listResp = await fetch(`http://127.0.0.1:${port}/json`);
    if (!listResp.ok) return null;
    const targets = await listResp.json() as Array<{ webSocketDebuggerUrl?: string }>;
    const target = targets.find((item) => typeof item.webSocketDebuggerUrl === "string" && item.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`));
    return target?.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Launch helpers
// ═══════════════════════════════════════════════════════════════

function buildCloakLaunchArgs(opts: {
  profileDir: string;
  seed: number;
  platform: string;
  cdpPort: number;
  fingerprintMode: FingerprintMode;
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
  "--roxy-fingerprint-config=",
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
    if (arg.startsWith(`${NATIVE_PROXY_AUTH_SWITCH}=`)) {
      return `${NATIVE_PROXY_AUTH_SWITCH}=<ephemeral>`;
    }
    if (!arg.startsWith("--proxy-server=")) return arg;
    return arg.replace(/(\w+:\/\/)([^@\s]+)@/, "$1***:***@");
  });
}

function buildAuthenticatedProxyUrl(config: ProxyConfig): string {
  const raw = buildProxyUrl(config);
  if (!config.username) return raw;
  const url = new URL(raw);
  url.username = config.username;
  url.password = config.password || "";
  return url.href.replace(/\/$/, "");
}

function getLaunchArgValue(args: string[], key: string): string | null {
  const prefix = `${key}=`;
  const arg = [...args].reverse().find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function shouldUseWrapperGeoip(): boolean {
  if (process.env.CLOAKBROWSER_GEOIP_AUTO_DOWNLOAD?.toLowerCase() === "true") return true;
  return fs.existsSync(path.join(os.homedir(), ".cloakbrowser", "geoip", "GeoLite2-City.mmdb"));
}

function addExtensionArgs(args: string[], dirId: string, runtimeExtensionPaths: string[] = []): void {
  const paths = [...runtimeExtensionPaths, ...getEnabledRepositoryExtensionPaths(dirId)];
  if (!paths.length) return;
  const joined = paths.join(",");
  args.push(`--load-extension=${joined}`);
  args.push(`--disable-extensions-except=${joined}`);
}

function addHardwareFingerprintArgs(args: string[], meta: any): void {
  const normalized = normalizeHardwareFingerprintMeta(meta);
  if (normalized.gpuVendor) args.push(`--fingerprint-gpu-vendor=${normalized.gpuVendor}`);
  if (normalized.gpuRenderer) args.push(`--fingerprint-gpu-renderer=${normalized.gpuRenderer}`);
  if (Number.isInteger(normalized.hardwareConcurrency)) args.push(`--fingerprint-hardware-concurrency=${normalized.hardwareConcurrency}`);
  if (Number.isInteger(normalized.deviceMemory)) args.push(`--fingerprint-device-memory=${normalized.deviceMemory}`);
  if (Number.isInteger(normalized.screenWidth)) args.push(`--fingerprint-screen-width=${normalized.screenWidth}`);
  if (Number.isInteger(normalized.screenHeight)) args.push(`--fingerprint-screen-height=${normalized.screenHeight}`);
  if (Number.isInteger(normalized.storageQuota)) args.push(`--fingerprint-storage-quota=${normalized.storageQuota}`);
  if (Number.isInteger(normalized.taskbarHeight)) args.push(`--fingerprint-taskbar-height=${normalized.taskbarHeight}`);
  if (normalized.fontsDir) args.push(`--fingerprint-fonts-dir=${normalized.fontsDir}`);
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

function normalizeBoolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

function normalizePlatform(value: unknown): "windows" | "macos" {
  if (value === "windows" || value === "macos") return value;
  throw new Error(`Invalid Cloak platform: ${JSON.stringify(value)}`);
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
    name: "CloakLite Proxy Auth",
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

function getLaunchLogPath(dirId: string): string {
  const logDir = path.join(getAppDataDir(), "logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  return path.join(logDir, `cloak-${dirId}.log`);
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
  throw new Error(`CloakBrowser CDP did not become ready on port ${port}${detail}`);
}

function dedupeChromeArgs(args: string[]): string[] {
  const keyOf = (arg: string) => arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
  const map = new Map<string, string>();
  for (const arg of args) map.set(keyOf(arg), arg);
  return [...map.values()];
}

// ═══════════════════════════════════════════════════════════════
// Internal: ps-based process discovery (survives app restarts)
// ═══════════════════════════════════════════════════════════════

export function parseCloakProcessLine(
  line: string,
  expectedProfileDir: string,
): { pid: number; cdpPort: number } | null {
  const pid = parseInt(line.trim().split(/\s+/, 1)[0], 10);
  if (!Number.isInteger(pid) || pid < 1) return null;
  const profileMatch = line.match(/--user-data-dir=("[^"]+"|'[^']+'|\S+)/);
  if (!profileMatch) return null;
  const profileArg = profileMatch[1].replace(/^['\"]|['\"]$/g, "");
  if (path.resolve(profileArg) !== path.resolve(expectedProfileDir)) return null;
  const portMatch = line.match(/--remote-debugging-port=(\d+)/);
  // Renderer/helper processes can briefly outlive the browser process and
  // retain the profile path, but they do not own its CDP endpoint.
  if (!portMatch) return null;
  const cdpPort = parseInt(portMatch[1], 10);
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) return null;
  return { pid, cdpPort };
}

function findCloakByProfile(dirId: string): { pid: number; cdpPort: number } | null {
  validateDirId(dirId);
  const expectedProfileDir = path.resolve(getProfilesDir(), dirId);
  try {
    const output = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf-8", timeout: 2000 });
    for (const line of output.split("\n")) {
      const processInfo = parseCloakProcessLine(line, expectedProfileDir);
      if (processInfo) return processInfo;
    }
    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Geo-IP: Auto-detect timezone + locale from proxy exit IP
// ═══════════════════════════════════════════════════════════════

async function resolveGeoFromProxy(proxy: ProxyConfig): Promise<{ timezone: string | null; locale: string | null; exitIp: string | null }> {
  try {
    const detection = await proxyDetector.detect(proxy);
    if (!detection.success) {
      console.log(`[cloak] Geo-IP detection skipped: ${detection.error || "proxy may be local or unreachable"}`);
      return { timezone: null, locale: null, exitIp: null };
    }
    const locale = localeFromCountry(detection.countryCode);
    console.log(`[cloak] Geo-IP via ${detection.provider}: country=${detection.countryCode || ""} tz=${detection.timezone || ""} locale=${locale || ""}`);
    return { timezone: detection.timezone || null, locale, exitIp: detection.exitIp || null };
  } catch {
    console.log("[cloak] Geo-IP detection skipped (proxy may be local or unreachable)");
    return { timezone: null, locale: null, exitIp: null };
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
function patchCloakLocale(profileDir: string, locale: string): void {
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
    console.log(`[cloak] Patched locale in Preferences: ${locale}`);
  } catch (e: any) {
    console.error(`[cloak] Failed to patch locale in Preferences: ${e.message}`);
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
  const backupPath = path.join(profileDir, ".roxy-third-party-cookie-backup.json");
  try {
    let prefs: Record<string, any> = {};
    if (fs.existsSync(prefsPath)) {
      prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    }
    if (!prefs.profile || typeof prefs.profile !== "object") prefs.profile = {};
    if (!prefs.tracking_protection || typeof prefs.tracking_protection !== "object") prefs.tracking_protection = {};

    if (enabled) {
      if (!fs.existsSync(backupPath)) {
        const backup: ThirdPartyCookiePreferenceBackup = {
          schemaVersion: 1,
          cookieControlsMode: backupValue(prefs.profile, "cookie_controls_mode"),
          trackingProtection3pcdEnabled: backupValue(prefs.tracking_protection, "tracking_protection_3pcd_enabled"),
          blockAll3pcToggleEnabled: backupValue(prefs.tracking_protection, "block_all_3pc_toggle_enabled"),
        };
        writeJsonAtomic(backupPath, backup);
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

    if (!fs.existsSync(backupPath)) return;
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8")) as ThirdPartyCookiePreferenceBackup;
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
    fs.unlinkSync(backupPath);
  } catch (error) {
    throw new Error(`Failed to apply third-party cookie compatibility: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function getProfileSyncStatus(meta: any, lastModified: number, dirId: string): "synced" | "dirty" | "never" {
  if (!meta?.syncedAt) return "never";
  if (meta.syncedHash) {
    const clean = JSON.parse(JSON.stringify(meta));
    delete clean.syncedAt;
    delete clean.syncedHash;
    delete clean.__artifactHash;
    const prefsPath = path.join(getProfilesDir(), dirId, "Default", "Preferences");
    if (!fs.existsSync(prefsPath)) return "dirty";
    clean.__artifactHash = zlibSafeBase64(prefsPath);
    return hashJson(clean) === meta.syncedHash ? "synced" : "dirty";
  }
  return lastModified && lastModified > meta.syncedAt ? "dirty" : "synced";
}

function zlibSafeBase64(filePath: string): string {
  return fs.readFileSync(filePath).toString("base64");
}

function hashJson(value: any): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

function findFreePort(): number {
  const s = net.createServer();
  s.listen(0);
  const port = (s.address() as net.AddressInfo).port;
  s.close();
  return port;
}

export function stopAllCloakProfiles(): void {
  for (const [dirId, entry] of runningProcesses) {
    const pid = entry.pid;
    if (entry.killTimer) clearTimeout(entry.killTimer);
    try { process.kill(pid, "SIGTERM"); } catch {}
    // Give a brief window for clean exit before SIGKILL
    setTimeout(() => {
      try { process.kill(pid, "SIGKILL"); } catch {}
      runningProcesses.delete(dirId);
    }, 1000).unref();
  }
  runningProcesses.clear();
}
