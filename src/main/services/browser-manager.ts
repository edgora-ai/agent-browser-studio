// ── Agent Browser Studio managed Chromium profiles ──
// The browser runtime is the independently built Chromium patchset installed
// under the managed cache. No upstream wrapper, downloader, or license service
// participates in profile launch.

import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import { createHash } from "node:crypto";
import { spawn, execSync, execFileSync } from "node:child_process";
import { parseBrowserProcessLine, findBrowserByProfileSync } from "./process-discovery.js";
import { BrowserWindow } from "electron";
import { getConfig, saveConfig, getAppDataDir, getProfilesDir, resolveProfileProxy, resolveProfileProxySecret, getProxyDetection, setProxyDetectionIfCurrent, sanitizeAppUrl, getProxyHealthEntry, assertProfileWritable } from "./config-manager.js";
import { cdpCookieService } from "./cdp-cookie-service.js";
import { decryptSecretOr } from "./secrets.js";
import { recordAudit } from "./audit-log.js";
import { checkProfileConsistency } from "./consistency-check.js";
import { drmLaunchArgs } from "./drm.js";
import {
  captureFingerprint, diffFingerprints, hasRiskyDrift, summarizeDrift,
  checkPersonaConsistency, mismatchesAsDrift,
  type FingerprintDrift,
} from "./fingerprint-baseline.js";
import { checkEnvironmentRiskRuntime, shouldBlockEnvironmentRisk, summarizeEnvFindings, type EnvRiskFinding } from "./environment-risk.js";
import { runFingerprintDriftGuard, runEnvironmentRiskGuard, LaunchBlockedError } from "./browser/launch-guards.js";
import { getEnabledRepositoryExtensionPaths } from "./extension-repository.js";
import { acquireRestoreLock } from "./profile-restore-lock.js";
import {
  startAuthenticatedSocksBridge,
} from "./authenticated-socks-bridge.js";
import { startMasqueSocksBridge } from "./masque-socks-bridge.js";
import { buildChromiumProxyUrl, proxyDetector, probeProxyPort, type ProxyDetectionResult } from "./proxy-detector.js";
import { recordProxyRotation } from "./proxy-health.js";
import { validateDirId } from "./utils.js";
import { requireProfileMutation } from "./team.js";
import { transact } from "./config/store.js";
import { emitEvent } from "./event-bus.js";
import {
  AGENT_BROWSER_FINGERPRINT_SWITCH,
  LEGACY_FINGERPRINT_SWITCH,
  MANAGED_SECURE_DNS_TEMPLATES,
  buildBrowserFingerprintArg,
  buildBrowserFingerprintConfig,
  validateBrowserHardwareProfile,
} from "./browser-fingerprint-config.js";
import {
  findManagedChromiumBinary,
  listManagedChromiumBinaries,
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
  supportsNativeProxyAuth,
  supportsNativeQuicProxy,
  writeNativeProxyAuthFile,
} from "./native-proxy-auth.js";
import type { FingerprintMode, GeolocationMode, ProxyConfig, WebRtcMode, ProfileLock, BrowserProfileMeta, BrowserEngine } from "../types.js";
import { PROFILE_ID_PREFIX, isManagedProfileId } from "../branding.js";
import {
  buildFirefoxLaunchArgs,
  detectFirefoxVersion,
  findFirefoxBinary,
  getFirefoxStatus,
  normalizeManagedFirefoxVersion,
  sanitizeBrowserEngine,
  spawnFirefoxWithDebugInfo,
  writeFirefoxUserJs,
  type FirefoxStatus,
} from "./browser-engine.js";
import { buildFirefoxManagedIdentity, buildInjectionProbeExpression, buildInjectionProbeExpectation, judgeInjectionProbe, normalizeFirefoxVersion, shouldBlockInjectionProbe, type InjectionProbeCheck } from "./firefox-fingerprint.js";
import {
  firefoxNativeModeRequested,
  supportsFirefoxNativeConfig,
  supportsFirefoxNativeParity,
} from "./firefox-native-capabilities.js";
import { connectBidi, bidiAddPreloadScript, bidiCreateContext, bidiCloseContext, bidiEvaluateInContext, registerFirefoxSession, dropFirefoxSession, getRegisteredFirefoxSession, type BidiConnection } from "./bidi-client.js";
import { firefoxCookieService } from "./bidi-cookie-service.js";

import { runningProcesses } from "./browser/runtime-table.js";
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
  appUrl: string | null;  // Web App (PWA app-mode) launch URL, or null
  proxyMode: "none" | "default" | "named";
  proxyName: string | null;  // resolved proxy reference name
  note: string | null;      // user note
  tags: string[];
  preset: string | null;    // business preset id used at creation (Slice 75)
  syncedAt: number | null;
  syncStatus: "synced" | "dirty" | "never";
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
    platform: normalizePlatform(opts.platform || (process.platform === "darwin" ? "macos" : "windows")),
    timezone: normalizeOptionalTimezone(opts.timezone),
    locale: normalizeOptionalLocale(opts.locale),
    webrtcMode,
    webrtcIp: webrtcMode === "real" || webrtcMode === "disable" ? null : normalizeOptionalIp(opts.webrtcIp),
    ...normalizeGeolocationMeta(opts),
    ...normalizeHardwareFingerprintMeta(opts),
    proxyMode,
    proxyName: proxyMode === "named" ? opts.proxyName || null : null,
    drm: normalizeBoolean(opts.drm, "drm"),
    windowTitlePrefix: opts.windowTitlePrefix === undefined ? undefined : (opts.windowTitlePrefix === null ? null : sanitizeWindowTitlePrefix(opts.windowTitlePrefix)),
    appUrl: sanitizeAppUrl(opts.appUrl),
    note: null,
    tags: normalizeTags(opts.tags),
    preset: opts.preset || null,
    updatedAt: Date.now(),
  };
  if (profile.fingerprintMode !== "off") validateBrowserHardwareProfile(profile);
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
}

function readTrashIndex(): TrashEntry[] {
  try {
    const raw = fs.readFileSync(trashIndexPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTrashIndex(entries: TrashEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(trashIndexPath()), { recursive: true });
    fs.writeFileSync(trashIndexPath(), JSON.stringify(entries, null, 2), "utf-8");
  } catch (e) {
    console.warn("[agent-browser] failed to write trash index:", e);
  }
}

/** List profiles currently recoverable from the trash. */
export function listTrashedProfiles(): Array<TrashEntry & { recoverable: boolean }> {
  return readTrashIndex().map((entry) => ({
    ...entry,
    recoverable: fs.existsSync(path.join(trashRoot(), entry.dirId)),
  }));
}

/** Move a stopped profile into the trash and drop it from the config. */
export function trashBrowserProfile(dirId: string, opts?: { force?: boolean }): boolean {
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  validateDirId(dirId);
  // TE-05: a profile checked out by another device cannot be deleted from here.
  assertProfileWritable(dirId, opts);

  const st = statusBrowser(dirId);
  if (st.running) throw new Error("Cannot delete profile while managed Chromium is running");

  const cfg = getConfig() as any;
  const meta = cfg.browserProfiles?.[dirId];
  const profileDir = path.join(getProfilesDir(), dirId);
  const target = path.join(trashRoot(), dirId);

  fs.mkdirSync(trashRoot(), { recursive: true });
  // A previous trashed copy of the same id is already superseded.
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(profileDir)) fs.renameSync(profileDir, target);

  let removed = false;
  try {
    const { transact } = require("./config/store.js");
    transact((draft: any) => {
      if (draft.browserProfiles?.[dirId]) {
        delete draft.browserProfiles[dirId];
        removed = true;
      }
    });
  } catch {
    const fallback = getConfig() as any;
    if (fallback.browserProfiles?.[dirId]) {
      delete fallback.browserProfiles[dirId];
      saveConfig(fallback);
      removed = true;
    }
  }

  const entries = readTrashIndex().filter((e) => e.dirId !== dirId);
  entries.push({
    dirId,
    name: meta?.name || dirId.slice(0, 8),
    deletedAt: Date.now(),
    meta: meta ? structuredClone(meta) : undefined,
  });
  writeTrashIndex(entries);

  recordAudit({
    category: "profile",
    action: "trash",
    target: dirId,
    actor: "user",
    detail: `moved to trash as "${meta?.name || dirId.slice(0, 8)}" (recoverable for 7 days)`,
  });
  return removed || !fs.existsSync(profileDir);
}

/** Put a trashed profile back, restoring its metadata. */
export function restoreTrashedProfile(dirId: string): boolean {
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  validateDirId(dirId);

  const entry = readTrashIndex().find((e) => e.dirId === dirId);
  if (!entry) throw new Error("That profile is no longer in the trash");
  const source = path.join(trashRoot(), dirId);
  if (!fs.existsSync(source)) throw new Error("The trashed profile data is missing");

  const profileDir = path.join(getProfilesDir(), dirId);
  if (fs.existsSync(profileDir)) throw new Error("A profile with that id already exists");

  fs.mkdirSync(getProfilesDir(), { recursive: true });
  fs.renameSync(source, profileDir);

  let restored = false;
  try {
    const { transact } = require("./config/store.js");
    transact((draft: any) => {
      draft.browserProfiles = draft.browserProfiles || {};
      if (!draft.browserProfiles[dirId]) {
        draft.browserProfiles[dirId] = entry.meta
          ? { ...(entry.meta as object), dirId, createdAt: Date.now() }
          : {
              dirId,
              name: entry.name || dirId.slice(0, 8),
              createdAt: Date.now(),
              engine: "chromium",
            };
      }
      restored = true;
    });
  } catch {
    const cfg = getConfig() as any;
    cfg.browserProfiles = cfg.browserProfiles || {};
    if (!cfg.browserProfiles[dirId]) {
      cfg.browserProfiles[dirId] = { dirId, name: entry.name || dirId.slice(0, 8), createdAt: Date.now(), engine: "chromium" };
    }
    saveConfig(cfg);
    restored = true;
  }

  writeTrashIndex(readTrashIndex().filter((e) => e.dirId !== dirId));
  recordAudit({ category: "profile", action: "restore", target: dirId, actor: "user", detail: `restored "${entry.name}"` });
  return restored;
}

/**
 * Permanently delete one trashed profile (R10 UX P1-1): remove the trashed
 * data directory and drop the index entry. Requires a UI double-confirm —
 * this is irreversible, unlike restore. Also clears index-only leftovers
 * whose data directory is already gone (unrecoverable entries).
 */
export function purgeTrashedProfile(dirId: string): boolean {
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  validateDirId(dirId);
  const entries = readTrashIndex();
  const entry = entries.find((e) => e.dirId === dirId);
  if (!entry) throw new Error("That profile is not in the trash");
  const target = path.join(trashRoot(), dirId);
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  } catch (e: any) {
    throw new Error(`Failed to remove trashed data: ${e?.message || String(e)}`);
  }
  writeTrashIndex(entries.filter((e) => e.dirId !== dirId));
  recordAudit({ category: "profile", action: "purge", target: dirId, actor: "user", detail: `permanently deleted "${entry.name}" from trash` });
  return true;
}

/** Permanently remove trash entries older than the retention window. */
export function purgeExpiredTrash(ttlMs: number = TRASH_TTL_MS): string[] {
  const cutoff = Date.now() - ttlMs;
  const kept: TrashEntry[] = [];
  const purged: string[] = [];
  for (const entry of readTrashIndex()) {
    if (entry.deletedAt < cutoff) {
      try {
        fs.rmSync(path.join(trashRoot(), entry.dirId), { recursive: true, force: true });
      } catch {
        /* already gone */
      }
      purged.push(entry.dirId);
    } else {
      kept.push(entry);
    }
  }
  if (purged.length) writeTrashIndex(kept);
  return purged;
}

export function deleteBrowserProfile(dirId: string, opts?: { force?: boolean }): boolean {
  // Team RBAC: viewers are read-only.
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);

  validateDirId(dirId);
  // TE-05: honour another device's checkout lock on the hard-delete path too.
  assertProfileWritable(dirId, opts);
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
}

export function listBrowserProfiles(): BrowserProfile[] {
  const cfg = getConfig() as any;
  const profiles = cfg.browserProfiles || {};
  const result: BrowserProfile[] = [];
  for (const [dirId, meta] of Object.entries(profiles)) {
    const m = meta as any;
    const st = statusBrowser(dirId);
    const profileDir = path.join(getProfilesDir(), dirId);
    const lastModified = fs.existsSync(profileDir) ? Math.floor(fs.statSync(profileDir).mtimeMs) : 0;
    const syncedAt = m.syncedAt || null;
    const syncStatus = getProfileSyncStatus(m, lastModified, dirId);
    const resolvedProxy = resolveProfileProxy(dirId);
    const engine = sanitizeBrowserEngine(m.engine);
    result.push({
      dirId,
      name: m.name || dirId.slice(0, 8),
      version: engine === "firefox"
        ? (getFirefoxStatus().version || "?")
        : (normalizeManagedChromiumVersion(m.browserVersion) || getRuntimeChromiumVersion() || "?"),
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
      appUrl: m.appUrl || null,
      proxyMode: resolvedProxy.mode,
      proxyName: resolvedProxy.name,
      note: m.note || null,
      tags: normalizeTags(m.tags),
      preset: m.preset || null,
      syncedAt,
      syncStatus,
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
  error?: string;
}

export async function launchBrowser(
  dirId: string,
  opts?: { headless?: boolean; forceDeadProxy?: boolean },
): Promise<{ pid: number; cdpPort: number; driftCheck: LaunchDriftCheck; envCheck: LaunchEnvCheck }> {
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
  const cfg = getConfig() as any;
  const meta = cfg.browserProfiles?.[dirId];
  if (!meta) throw new Error(`Managed Chromium profile not found: ${dirId}`);

  // Memory-map check with alive test
  const existing = runningProcesses.get(dirId);
  if (existing) {
    try { process.kill(existing.pid, 0); return { pid: existing.pid, cdpPort: existing.port, driftCheck: { checked: false }, envCheck: { checked: false } }; }
    catch { runningProcesses.delete(dirId); }
  }

  // ps fallback: survive app restarts
  const psFallback = findBrowserByProfile(dirId);
  if (psFallback) {
    runningProcesses.set(dirId, { pid: psFallback.pid, process: null, port: psFallback.cdpPort, lastActivityAt: Date.now() });
    return { pid: psFallback.pid, cdpPort: psFallback.cdpPort, driftCheck: { checked: false }, envCheck: { checked: false } };
  }

  // Firefox engine path (Slice 77): stock Firefox with remote debugging.
  if (sanitizeBrowserEngine(meta.engine) === "firefox") {
    return launchFirefoxProfile(dirId, meta, cfg, opts?.headless, releaseLaunchLock, { forceDeadProxy: opts?.forceDeadProxy === true });
  }

  const configuredBin = cfg.chromiumBin && cfg.chromiumBin !== "auto" ? cfg.chromiumBin : null;
  const envBin = getChromiumBinaryOverride();
  const fingerprintMode = normalizeFingerprintMode(meta.fingerprintMode);
  const passThrough = fingerprintMode === "off";
  const requestedVersion = normalizeManagedChromiumVersion(meta.browserVersion);
  const managedBin = findManagedRuntimeChromium(requestedVersion);
  if (configuredBin && !fs.existsSync(configuredBin)) {
    throw new Error(`Configured Chromium binary does not exist: ${configuredBin}`);
  }
  if (envBin && !fs.existsSync(envBin)) {
    throw new Error(`AGENT_BROWSER_CHROMIUM_BINARY_PATH does not exist: ${envBin}`);
  }
  const overrideBin = configuredBin || envBin;
  if (requestedVersion && overrideBin && detectBinaryVersion(overrideBin) !== requestedVersion) {
    throw new Error(`Profile requires Chromium ${requestedVersion}, but the configured binary is ${detectBinaryVersion(overrideBin) || "unknown"}`);
  }
  if (requestedVersion && !overrideBin && !managedBin) {
    const available = listManagedChromiumBinaries().map((candidate) => candidate.version).join(", ") || "none";
    throw new Error(`Chromium ${requestedVersion} is not installed; available managed versions: ${available}`);
  }
  const preferredBin = configuredBin || envBin || managedBin;
  if (!preferredBin) {
    throw new Error(
      "Managed Chromium is required. Install the independent patchset with " +
      "`npm run install:chromium -- /path/to/Chromium.app`; upstream wrapper fallback is disabled.",
    );
  }

  const profileDir = path.join(getProfilesDir(), dirId);

  // Find free CDP port (retry once if the port is stolen between allocation and spawn)
  let cdpPort = await findFreePortWithRetry(1);
  const seed = normalizeFingerprintSeed(meta.fingerprintSeed || 12345);
  const platform = normalizePlatform(meta.platform || "windows");
  const resolvedProxy = resolveProfileProxySecret(dirId);
  // ── Fail closed on proxy resolution (review item PL-04) ──
  // The proxy is the whole point of the profile identity: if the profile asked
  // for one and we cannot produce a usable config, launching would silently
  // fall back to a direct connection and expose the host IP. Refuse instead,
  // and name the proxy plus its last health check so the user can act.
  // Shared with the Firefox path via assertProxyResolvable (R2 #46).
  assertProxyResolvable(meta, cfg, resolvedProxy);
  await assertProxyLaunchable(dirId, resolvedProxy, cfg, { forceDeadProxy: opts?.forceDeadProxy === true });
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
      geoDetection = await resolveGeoFromProxy(activeProxy);
      if (resolvedProxy.name && geoDetection?.detection?.success) {
        persistLaunchDetection(resolvedProxy.name, activeProxy, geoDetection.detection);
      }
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
  const nativeChromiumVersion = detectBinaryVersion(bin) || getRuntimeChromiumVersion();
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
      webrtcIp = geoDetection?.exitIp ?? (await resolveGeoFromProxy(activeProxy)).exitIp;
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
    // Managed profiles with a proxy resolve DNS over HTTPS through that same
    // proxy (secure-only, no host-resolver fallback) so the resolver and DNS
    // queries stay consistent with the exit identity. Without a proxy the
    // browser keeps its stock DNS behavior.
    const managedSecureDns = activeProxy
      ? { enabled: true, templates: [...MANAGED_SECURE_DNS_TEMPLATES] }
      : null;
    const nativeFingerprint = buildBrowserFingerprintConfig(
      nativeFingerprintMeta,
      nativeChromiumVersion,
      managedSecureDns,
      "chromium",
    );
    const fingerprintSwitch = supportsAgentBrowserFingerprintConfig(bin)
      ? AGENT_BROWSER_FINGERPRINT_SWITCH
      : LEGACY_FINGERPRINT_SWITCH;
    args.push(buildBrowserFingerprintArg(
      nativeFingerprintMeta,
      nativeChromiumVersion,
      fingerprintSwitch,
      managedSecureDns,
      "chromium",
    ));
    // DNS routing audit: managed profiles behind a proxy route every DNS query
    // (including the DoH probe) through that same proxy with no host-resolver
    // fallback, so the resolver stays coherent with the exit identity. Record
    // per-launch evidence so profile logs prove proxy-coherent DNS.
    if (managedSecureDns) {
      recordAudit({ category: "profile", action: "dns-route", target: dirId, actor: "auto",
        detail: "proxy DNS active: DoH routed through the exit proxy (no host-resolver fallback)" });
    } else if (!passThrough && resolvedProxy.mode !== "none") {
      recordAudit({ category: "profile", action: "dns-route", target: dirId, actor: "auto",
        detail: "warning: profile expects a proxy but no managed secure DNS is active — check proxy resolution" });
    }
    args.push(`--user-agent=${nativeFingerprint.userAgent}`);
    args = dedupeChromeArgs([
      ...args,
      `--window-size=${nativeFingerprint.screen.outerWidth},${nativeFingerprint.screen.outerHeight}`,
      `--window-position=${nativeFingerprint.screen.windowX},${nativeFingerprint.screen.windowY}`,
      `--force-device-scale-factor=${nativeFingerprint.screen.devicePixelRatio}`,
    ]);
    args = applyManagedNativeRefreshRate(args);
  }

  // RoxyBrowser-style taskbar/window title: show the profile name at the OS
  // level without touching document.title (zero fingerprint surface). The
  // Chromium fork consumes an optional window-title prefix switch.
  const windowTitlePrefix = resolveWindowTitlePrefix(meta);
  if (windowTitlePrefix) {
    args = dedupeChromeArgs([
      ...args,
      `--agent-browser-window-title-prefix=${windowTitlePrefix}`,
    ]);
  }

  // Chromium 150 builds advertising the native QUIC-proxy capability route
  // SOCKS5 TCP and UDP through a profile-owned loopback MASQUE bridge. Older
  // builds and HTTP proxies continue to fail closed with QUIC disabled rather
  // than allowing an unmanaged UDP path. HTTP 407 credentials use the
  // browser-only native channel when available.
  const runtimeExtensionPaths: string[] = [];
  if (activeProxy) {
    let chromiumProxy = activeProxy;
    const isSocks = activeProxy.type === "socks5" || activeProxy.type === "socks5h";
    if (isSocks && supportsNativeQuicProxy(bin)) {
      const masqueBridge = await startMasqueSocksBridge(activeProxy);
      pendingProxyBridge = masqueBridge;
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
        ...(activeProxy.type === "socks5h"
          ? [`--host-resolver-rules=${buildRemoteDnsRule(proxyConnectHost, getLaunchArgValue(args, "--host-resolver-rules"))}`]
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
    console.error(`[agent-browser] spawn error for ${dirId.slice(0, 8)}:`, err.message);
  });

  if (!child.pid) throw new Error(`Managed Chromium failed to start (no PID returned) for ${dirId.slice(0, 8)}`);
  const pid = child.pid;

  runningProcesses.set(dirId, {
    pid,
    process: child,
    port: cdpPort,
    lastActivityAt: Date.now(),
    ...(pendingProxyBridge ? { proxyBridge: pendingProxyBridge } : {}),
  });
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
    const queuedCookies = await cdpCookieService.applyQueuedImports(dirId);
    if (queuedCookies > 0) console.log(`[agent-browser] Applied ${queuedCookies} queued cookies for ${dirId.slice(0, 8)}`);
  } catch (e) {
    const failedEntry = runningProcesses.get(dirId);
    runningProcesses.delete(dirId);
    await failedEntry?.proxyBridge?.close().catch(() => undefined);
    try { process.kill(pid, "SIGTERM"); } catch (killError) { console.error(`[agent-browser] failed to terminate unready process ${pid}:`, killError); }
    try { fs.closeSync(logFd); } catch (closeError) { console.error(`[agent-browser] failed to close launch log:`, closeError); }
    throw e;
  }

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
      const failedEntry = runningProcesses.get(dirId);
      runningProcesses.delete(dirId);
      await failedEntry?.proxyBridge?.close().catch(() => undefined);
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
      const failedEntry = runningProcesses.get(dirId);
      runningProcesses.delete(dirId);
      await failedEntry?.proxyBridge?.close().catch(() => undefined);
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
    // Cancel pending SIGKILL timer if any — process exited naturally
    const entry = runningProcesses.get(dirId);
    if (entry?.killTimer) { clearTimeout(entry.killTimer); }
    if (entry) delete (entry as any).stopping;
    void entry?.proxyBridge?.close().catch(() => undefined);
    runningProcesses.delete(dirId);
    try { fs.closeSync(logFd); } catch (closeError) { console.error(`[agent-browser] failed to close launch log:`, closeError); }
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
  return { pid, cdpPort, driftCheck, envCheck };
  } finally {
    pendingNativeProxyAuth?.cleanup();
    await pendingProxyBridge?.close().catch(() => undefined);
    if (releaseLaunchLock) releaseLaunchLock();
  }
}

/** Wait for a spawned child to exit, escalating to SIGKILL so a "blocked"
 *  launch never leaves a live process behind. */
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
  const engine = sanitizeBrowserEngine(meta.engine);
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
  opts?: { forceDeadProxy?: boolean },
): Promise<{ pid: number; cdpPort: number; driftCheck: LaunchDriftCheck; envCheck: LaunchEnvCheck; cookieCheck: LaunchCookieCheck }> {
  const bin = findFirefoxBinary();
  if (!bin) {
    if (releaseLaunchLock) releaseLaunchLock();
    throw new Error(
      "Managed Firefox is required for this profile. Install Firefox or set AGENT_BROWSER_FIREFOX_BINARY_PATH.",
    );
  }
  const firefoxVersion = detectFirefoxVersion(bin);
  // Compare major.minor (R4): a legal "154.0" pin must match a "154.0.1"
  // binary — strict string inequality would always block.
  if (meta.browserVersion && firefoxVersion && normalizeFirefoxVersion(firefoxVersion) !== normalizeFirefoxVersion(meta.browserVersion)) {
    if (releaseLaunchLock) releaseLaunchLock();
    throw new Error(`Profile requires Firefox ${meta.browserVersion}, but the installed binary is ${firefoxVersion}`);
  }

  const profileDir = path.join(getProfilesDir(), dirId);
  const fingerprintMode = normalizeFingerprintMode(meta.fingerprintMode);
  const managedIdentity = fingerprintMode === "off" ? null : buildFirefoxManagedIdentity(meta, firefoxVersion, null);
  const nativeRequested = firefoxNativeModeRequested();
  const nativeConfig = supportsFirefoxNativeConfig(bin);
  const nativeParity = supportsFirefoxNativeParity(bin);
  if (managedIdentity && nativeRequested && !nativeConfig) {
    if (releaseLaunchLock) releaseLaunchLock();
    throw new Error(
      "Firefox native-only A/B mode was requested, but the selected binary lacks the binary-attested config-v1, native-required-v1, and snapshot-v1 capabilities.",
    );
  }
  const nativeMode = managedIdentity !== null && nativeConfig && (nativeParity || nativeRequested);
  const resolvedProxy = resolveProfileProxySecret(dirId);
  // Same fail-closed gate as the Chromium path (R2 #46): a requested-but-
  // unresolvable proxy must refuse — never write a direct user.js.
  assertProxyResolvable(meta, cfg, resolvedProxy);
  // R10/R12: liveness gate — history warns by default (opt-in block via
  // blockOnUnhealthyProxy), the TCP probe refuses dead ports.
  await assertProxyLaunchable(dirId, resolvedProxy, cfg, { forceDeadProxy: opts?.forceDeadProxy === true });
  // R11 P1-4 item 3: same consistency warnings as Chromium (warn by default).
  // R12 P2-1: normalize like the Chromium path — real/disable modes carry no
  // effective IP at runtime, so a stale meta.webrtcIp must not trigger
  // webrtc-no-proxy on Firefox while Chromium stays silent.
  runConsistencyGate(dirId, cfg, {
    passThrough: fingerprintMode === "off",
    timezone: meta.timezone, locale: meta.locale,
    webrtcIp: normalizeWebRtcMode(meta.webrtcMode, meta.webrtcIp) === "auto" || normalizeWebRtcMode(meta.webrtcMode, meta.webrtcIp) === "altered" ? meta.webrtcIp : null,
    platform: meta.platform,
    proxyMode: resolvedProxy.mode,
    proxyGeo: resolvedProxy.name ? getProxyDetection(resolvedProxy.name) : null,
  });
  const dohUrl = cfg.managedSecureDnsUrl && typeof cfg.managedSecureDnsUrl === "string" ? cfg.managedSecureDnsUrl : null;

  writeFirefoxUserJs(profileDir, {
    proxy: resolvedProxy.config,
    dohUrl,
    locale: meta.locale || undefined,
    // R12 P1-2: honor the same opt-in flag as Chromium (default off).
    allowThirdPartyCookies: normalizeBoolean(meta.allowThirdPartyCookies, "third-party cookie compatibility", false),
    useGpu: true,
    sandboxPermission: true,
    colorScheme: "system",
    ...(managedIdentity ? { extraPrefs: nativeMode ? managedIdentity.nativePrefs : managedIdentity.prefs } : {}),
  });

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
  const spawnEnv = meta.timezone ? { ...process.env, TZ: meta.timezone } : undefined;
  const { child, info } = await spawnFirefoxWithDebugInfo(bin, args, { timeoutMs: 60000, env: spawnEnv });
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
  runningProcesses.set(dirId, { pid, process: child, port: actualPort, lastActivityAt: Date.now() });
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
    if (managedIdentity && !liveBidi) {
      throw new Error(
        `Firefox managed identity requires a live BiDi session${bidiError ? `: ${bidiError}` : "."}`,
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
          { platform: meta.platform || "windows", timezone: meta.timezone },
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

    // Host environment risk — for Firefox the runtime font-exposure and rAF
    // probes run through BiDi (there is no engine-level font isolation).
    try {
      const envResult = await checkEnvironmentRiskRuntime(
        { timezone: meta.timezone, locale: meta.locale, platform: meta.platform },
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
      if (e?.driftBlocked) throw e;
      if (/Environment risk blocked/.test(String(e?.message || e))) {
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
      console.warn("[agent-browser] environment risk check failed for " + dirId.slice(0, 8) + ":", e?.message || e);
      envCheck = { checked: false, error: (e && e.message) || String(e) };
    }
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

import { stopBrowser as _stopBrowser, statusBrowser as _statusBrowser, stopAllBrowserProfiles as _stopAll, getCdpWebSocketUrl as _getCdpUrl, findBrowserByProfile as _findByProfile } from "./browser/lifecycle.js";
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

/**
 * Build the --host-resolver-rules value that makes Chromium resolve target
 * hostnames through a SOCKS5 proxy (socks5h semantics) instead of locally.
 * Chromium always resolves DNS locally for --proxy-server=socks5://; mapping
 * every hostname to ~NOTFOUND forces it to hand the hostname to the proxy,
 * which resolves at egress. The proxy connect host (and localhost) must stay
 * resolvable, so they are excluded. Existing rules (e.g. a MASQUE bridge map)
 * are preserved and merged.
 */
export function buildRemoteDnsRule(proxyConnectHost: string, existing: string | null): string {
  const host = String(proxyConnectHost || "").trim();
  const excludes = Array.from(new Set(["localhost", "127.0.0.1", host].filter((v) => v && v !== "*")));
  const rule = `MAP * ~NOTFOUND${excludes.map((entry) => `, EXCLUDE ${entry}`).join("")}`;
  return mergeCommaSeparatedValue(rule, existing);
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

async function resolveGeoFromProxy(proxy: ProxyConfig): Promise<{ timezone: string | null; locale: string | null; exitIp: string | null; detection: ProxyDetectionResult | null }> {
  try {
    const detection = await proxyDetector.detect(proxy);
    if (!detection.success) {
      console.log(`[agent-browser] Geo-IP detection skipped: ${detection.error || "proxy may be local or unreachable"}`);
      return { timezone: null, locale: null, exitIp: null, detection: null };
    }
    const locale = localeFromCountry(detection.countryCode);
    console.log(`[agent-browser] Geo-IP via ${detection.provider}: country=${detection.countryCode || ""} tz=${detection.timezone || ""} locale=${locale || ""}`);
    return { timezone: detection.timezone || null, locale, exitIp: detection.exitIp || null, detection };
  } catch {
    console.log("[agent-browser] Geo-IP detection skipped (proxy may be local or unreachable)");
    return { timezone: null, locale: null, exitIp: null, detection: null };
  }
}

/**
 * Persist a launch-time geo detection into the proxy's detection cache so the
 * next launch's consistency check sees fresh risk flags (hosting / isProxy)
 * even when the user never clicked Detect. Only touches the detection cache,
 * not the health history (which is owned by the manual Detect flow).
 */
function persistLaunchDetection(proxyName: string, proxy: ProxyConfig, detection: ProxyDetectionResult): void {
  try {
    setProxyDetectionIfCurrent(proxyName, proxy, {
      detectedAt: Date.now(),
      success: true,
      exitIp: detection.exitIp,
      country: detection.country || detection.countryCode || null,
      countryCode: detection.countryCode,
      timezone: detection.timezone,
      provider: detection.provider,
      latencyMs: typeof detection.latencyMs === "number" ? detection.latencyMs : null,
      org: detection.org,
      as: detection.as,
      hosting: detection.hosting,
      isProxy: detection.isProxy,
      error: null,
    });
  } catch (e) {
    console.warn(`[agent-browser] failed to persist launch detection for ${proxyName}:`, e);
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
