import { ipcMain } from "electron";
import {
  launchBrowser, stopBrowser, statusBrowser, listBrowserProfiles, checkFingerprintDrift,
  getRuntimeChromiumStatus, verifyRuntimeChromium,
  getRuntimeChromiumVersion, isRuntimeChromiumInstalled,
  createBrowserProfile, deleteBrowserProfile,
  getLaunchLogPath,
} from "../services/browser-manager.js";
import * as fs from "node:fs";
import { listAudit } from "../services/audit-log.js";
import { getConfig, saveConfig, setProfileMeta, resolveProfileProxy, getProxyDetection } from "../services/config-manager.js";
import { checkProfileConsistency } from "../services/consistency-check.js";
import { captureFingerprint, diffFingerprints, hasRiskyDrift } from "../services/fingerprint-baseline.js";
import { checkEnvironmentRisk, checkEnvironmentRiskRuntime } from "../services/environment-risk.js";
import { recordAudit } from "../services/audit-log.js";
import { parseBulkCsv } from "../services/bulk-import.js";
import { validateDirId } from "../services/utils.js";
import { cdpConnect, cdpNavigate, cdpWaitForLoad, cdpDisconnect } from "../services/local-agent.js";
import type { BrowserPlatform, FingerprintMode, GeolocationMode, ProxyMode, WebRtcMode } from "../types.js";

type BrowserIpcHandler = Parameters<typeof ipcMain.handle>[1];

function handleBrowser(action: string, handler: BrowserIpcHandler): void {
  ipcMain.handle(`browser:${action}`, handler);
  // Keep the pre-rename channel as an unadvertised compatibility alias for
  // automation clients during the data migration window.
  ipcMain.handle(`cloak:${action}`, handler);
}

export function registerBrowserHandlers(): void {
  // Parse a bulk-import CSV (header or legacy positional) into profile specs.
  handleBrowser("parse-bulk-csv", async (_event, text: string) => {
    try { return { ok: true, specs: parseBulkCsv(String(text || "")) }; }
    catch (e: any) { return { ok: false, error: e.message || String(e) }; }
  });

  handleBrowser("list", async () => {
    return listBrowserProfiles().map(p => ({
      ...p,
      installed: isRuntimeChromiumInstalled(),
      version: p.version || getRuntimeChromiumVersion() || "?",
    }));
  });

  handleBrowser("binary", async () => {
    return getRuntimeChromiumStatus();
  });

  handleBrowser("verify-binary", async () => {
    try {
      return { success: true, status: verifyRuntimeChromium() };
    } catch (e: any) {
      return { success: false, error: e.message || String(e), status: getRuntimeChromiumStatus() };
    }
  });

  handleBrowser("create", async (_event, opts: {
    name: string; fingerprintSeed?: number; platform?: BrowserPlatform;
    fingerprintMode?: FingerprintMode; browserVersion?: string | null;
    allowThirdPartyCookies?: boolean;
    drm?: boolean;
    timezone?: string; locale?: string; webrtcMode?: WebRtcMode; webrtcIp?: string;
    geolocationMode?: GeolocationMode; geolocationLatitude?: number | null; geolocationLongitude?: number | null; geolocationAccuracy?: number | null;
    gpuVendor?: string | null; gpuRenderer?: string | null; hardwareConcurrency?: number | null; deviceMemory?: number | null;
    screenWidth?: number | null; screenHeight?: number | null; storageQuota?: number | null; taskbarHeight?: number | null; fontsDir?: string | null;
    windowTitlePrefix?: string | null;
    appUrl?: string | null;
    proxyMode?: ProxyMode; proxyName?: string | null; tags?: string[];
  }) => {
    const r = createBrowserProfile({
      name: opts.name,
      fingerprintMode: opts.fingerprintMode,
      browserVersion: opts.browserVersion,
      allowThirdPartyCookies: opts.allowThirdPartyCookies,
      drm: opts.drm,
      fingerprintSeed: opts.fingerprintSeed,
      platform: opts.platform,
      timezone: opts.timezone,
      locale: opts.locale,
      webrtcMode: opts.webrtcMode,
      webrtcIp: opts.webrtcIp,
      geolocationMode: opts.geolocationMode,
      geolocationLatitude: opts.geolocationLatitude,
      geolocationLongitude: opts.geolocationLongitude,
      geolocationAccuracy: opts.geolocationAccuracy,
      gpuVendor: opts.gpuVendor,
      gpuRenderer: opts.gpuRenderer,
      hardwareConcurrency: opts.hardwareConcurrency,
      deviceMemory: opts.deviceMemory,
      screenWidth: opts.screenWidth,
      screenHeight: opts.screenHeight,
      storageQuota: opts.storageQuota,
      taskbarHeight: opts.taskbarHeight,
      fontsDir: opts.fontsDir,
      windowTitlePrefix: opts.windowTitlePrefix,
      appUrl: opts.appUrl,
      proxyMode: opts.proxyMode,
      proxyName: opts.proxyName,
      tags: opts.tags,
    });
    return r;
  });

  handleBrowser("delete", async (_event, dirId: string) => {
    try {
      return { success: deleteBrowserProfile(dirId) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  handleBrowser("launch", async (_event, params: {
    dirId: string;
  }) => {
    try {
      const r = await launchBrowser(params.dirId);
      return { success: true, pid: r.pid, cdpPort: r.cdpPort, driftCheck: r.driftCheck, envCheck: r.envCheck };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Host environment risk check (DNS resolvers / CN fonts / proxy DNS / RAF).
  handleBrowser("env-risk", async (_event, dirId: string) => {
    try {
      validateDirId(dirId);
      const cfg = getConfig() as any;
      const meta = cfg.browserProfiles?.[dirId];
      if (!meta) return { ok: false, error: "Profile not found" };
      const profile = { timezone: meta.timezone, locale: meta.locale, platform: meta.platform };
      const st = statusBrowser(dirId);
      if (st.running && st.cdpPort) {
        return { ok: true, result: await checkEnvironmentRiskRuntime(profile, st.cdpPort) };
      }
      return { ok: true, result: checkEnvironmentRisk(profile) };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // Read-only fingerprint drift check against the stored baseline (no state change).
  handleBrowser("check-drift", async (_event, dirId: string) => {
    return checkFingerprintDrift(dirId);
  });

  // Team checkout lock: lock/unlock a profile to the current device so a
  // sync push from another device refuses to overwrite it.
  handleBrowser("set-lock", async (_event, params: { dirId: string; locked: boolean }) => {
    try {
      validateDirId(params.dirId);
      const cfg = getConfig() as any;
      const meta = cfg.browserProfiles?.[params.dirId];
      if (!meta) return { success: false, error: "Profile not found" };
      if (params.locked) {
        meta.lock = { owner: cfg.deviceId || "local", ownerName: cfg.deviceName || "device", at: Date.now() };
        recordAudit({ category: "profile", action: "lock", target: params.dirId, actor: "user", detail: "locked by " + meta.lock.ownerName + " (" + meta.lock.owner + ")" });
      } else {
        delete meta.lock;
        recordAudit({ category: "profile", action: "unlock", target: params.dirId, actor: "user", detail: "released" });
      }
      saveConfig(cfg);
      return { success: true, lock: meta.lock || null };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  handleBrowser("stop", async (_event, dirId: string) => {
    return { success: stopBrowser(dirId) };
  });

  handleBrowser("status", async (_event, dirId: string) => {
    return statusBrowser(dirId);
  });

  // Pre-launch consistency check (timezone / locale / WebRTC vs proxy) for the UI badge.
  handleBrowser("consistency-check", async (_event, dirId: string) => {
    validateDirId(dirId);
    const cfg = getConfig() as any;
    const meta = cfg.browserProfiles?.[dirId];
    if (!meta) return { ok: false, warnings: [], blockers: [{ severity: "blocker", code: "no-profile", message: "Profile not found" }] };
    if (meta.fingerprintMode === "off") return { ok: true, warnings: [], blockers: [] };
    const resolved = resolveProfileProxy(dirId);
    const proxyGeo = resolved.name ? getProxyDetection(resolved.name) : null;
    return checkProfileConsistency({
      timezone: meta.timezone, locale: meta.locale, webrtcIp: meta.webrtcIp, platform: meta.platform,
      proxyMode: resolved.mode,
      proxyGeo,
    }, { blockOnProxyRisk: cfg.blockOnProxyRisk === true });
  });

  // Capture (or re-capture) the live fingerprint baseline; diff vs the prior one.
  handleBrowser("capture-baseline", async (_event, dirId: string) => {
    validateDirId(dirId);
    const st = statusBrowser(dirId);
    if (!st.running || !st.cdpPort) return { ok: false, error: "profile not running" };
    try {
      const current = await captureFingerprint(st.cdpPort);
      const cfg = getConfig() as any;
      const meta = cfg.browserProfiles?.[dirId] || {};
      const drift = diffFingerprints(meta.fingerprintBaseline, current);
      const risky = hasRiskyDrift(drift);
      cfg.browserProfiles[dirId] = { ...meta, fingerprintBaseline: current };
      saveConfig(cfg);
      if (drift.length) {
        recordAudit({ category: "profile", action: "fingerprint-drift", target: dirId,
          detail: `${drift.length} field(s) changed${risky ? " (risky)" : ""}: ${drift.map((d) => d.field).slice(0, 8).join(", ")}` });
      } else {
        recordAudit({ category: "profile", action: "fingerprint-baseline", target: dirId, detail: "baseline captured (stable)" });
      }
      return { ok: true, fields: Object.keys(current).length, drift, risky, baseline: current };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // Set fingerprint seed for a profile
  handleBrowser("set-seed", async (_event, params: {
    dirId: string; seed: number;
  }) => {
    validateDirId(params.dirId);
    const cfg = getConfig();
    if (!Object.hasOwn(cfg.browserProfiles || {}, params.dirId)) return { success: false };
    cfg.browserProfiles[params.dirId]!.fingerprintSeed = params.seed;
    saveConfig(cfg);
    return { success: true };
  });

  // Set managed Chromium fingerprint metadata (name, timezone, locale, WebRTC IP, platform, seed, note)
  handleBrowser("set-meta", async (_event, params: {
    dirId: string;
    name?: string;
    fingerprintMode?: FingerprintMode;
    browserVersion?: string | null;
    allowThirdPartyCookies?: boolean;
    drm?: boolean;
    fingerprintSeed?: number;
    platform?: BrowserPlatform;
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
    windowTitlePrefix?: string | null;
    note?: string;
    appUrl?: string | null;
    proxyMode?: ProxyMode;
    proxyName?: string | null;
    tags?: string[];
  }) => {
    validateDirId(params.dirId);
    const cfg = getConfig();
    if (!Object.hasOwn(cfg.browserProfiles || {}, params.dirId)) return { success: false };
    try {
      setProfileMeta(params.dirId, {
        name: params.name,
        fingerprintMode: params.fingerprintMode,
        browserVersion: params.browserVersion,
        allowThirdPartyCookies: params.allowThirdPartyCookies,
        drm: params.drm,
        fingerprintSeed: params.fingerprintSeed,
        platform: params.platform,
        timezone: params.timezone,
        locale: params.locale,
        webrtcMode: params.webrtcMode,
        webrtcIp: params.webrtcIp,
        geolocationMode: params.geolocationMode,
        geolocationLatitude: params.geolocationLatitude,
        geolocationLongitude: params.geolocationLongitude,
        geolocationAccuracy: params.geolocationAccuracy,
        note: params.note,
        tags: params.tags,
        proxyMode: params.proxyMode,
        proxyName: params.proxyName,
        gpuVendor: params.gpuVendor,
        gpuRenderer: params.gpuRenderer,
        hardwareConcurrency: params.hardwareConcurrency,
        deviceMemory: params.deviceMemory,
        screenWidth: params.screenWidth,
        screenHeight: params.screenHeight,
        storageQuota: params.storageQuota,
        taskbarHeight: params.taskbarHeight,
        windowTitlePrefix: params.windowTitlePrefix,
        fontsDir: params.fontsDir,
        appUrl: params.appUrl,
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // Open fingerprint risk-check URL in a profile
  // If profile is not running, auto-launches it first and waits for CDP readiness.
  handleBrowser("open-risk-check", async (_event, params: { dirId: string }) => {
    const { dirId } = params;
    validateDirId(dirId);
    const url = "https://ping0.cc/env";

    let status = statusBrowser(dirId);
    let cdpPort = status.cdpPort || 0;

    // Auto-launch if not running
    if (!status.running) {
      try {
        const launchResult = await launchBrowser(dirId);
        cdpPort = launchResult.cdpPort || 0;
        status = statusBrowser(dirId);
      } catch (e: any) {
        return { success: false, error: `Failed to launch: ${e.message || String(e)}`, autoLaunched: true };
      }
    }

    if (!cdpPort || !status.running) {
      return { success: false, error: "Profile is not running and CDP port could not be obtained" };
    }

    let client;
    try {
      client = await cdpConnect(cdpPort);
      await cdpNavigate(client, url);
      // Wait up to 10s for page load
      await cdpWaitForLoad(client, 10000);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    } finally {
      if (client) { try { cdpDisconnect(client); } catch (e) { /* ignore */ } }
    }
  });

  // Open a profile as its Web App (PWA app-mode): auto-launch if needed and
  // navigate to the profile's appUrl. When the profile was launched with
  // --app=<appUrl> the standalone app window is already at that URL; this
  // handler covers the already-running-without-app case and one-click "open
  // as app" from the profile card.
  handleBrowser("open-app", async (_event, params: { dirId: string; url?: string }) => {
    const { dirId } = params;
    validateDirId(dirId);
    const cfg = getConfig() as any;
    const meta = cfg.browserProfiles?.[dirId];
    if (!meta) return { success: false, error: "Profile not found" };
    const appUrl = String(params.url && params.url.trim() ? params.url : (meta.appUrl || "")).trim();
    if (!appUrl) return { success: false, error: "No Web App URL configured for this profile" };

    let status = statusBrowser(dirId);
    let cdpPort = status.cdpPort || 0;
    if (!status.running) {
      try {
        const launchResult = await launchBrowser(dirId);
        cdpPort = launchResult.cdpPort || 0;
        status = statusBrowser(dirId);
      } catch (e: any) {
        return { success: false, error: `Failed to launch: ${e.message || String(e)}`, autoLaunched: true };
      }
    }
    if (!cdpPort || !status.running) {
      return { success: false, error: "Profile is not running and CDP port could not be obtained" };
    }

    let client;
    try {
      client = await cdpConnect(cdpPort);
      await cdpNavigate(client, appUrl);
      await cdpWaitForLoad(client, 10000);
      return { success: true, appUrl };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    } finally {
      if (client) { try { cdpDisconnect(client); } catch (e) { /* ignore */ } }
    }
  });

  // Per-profile operation logs + rolling browser log tail (RoxyBrowser 4.0.3
  // "Trackable Profile Activity" / 4.0.2 "rolling logs" parity): return recent
  // audit entries for this profile plus the tail of its managed Chromium
  // launch log. The launch log is masked at write time (no proxy credentials).
  handleBrowser("logs", async (_event, dirId: string) => {
    try {
      validateDirId(dirId);
      const activity = listAudit(50, { target: dirId });
      const logFile = getLaunchLogPath(dirId);
      let logTail = "";
      let logExists = false;
      let logBytes = 0;
      try {
        const stat = fs.statSync(logFile);
        logExists = true;
        logBytes = stat.size;
        const maxBytes = 256 * 1024;
        const fd = fs.openSync(logFile, "r");
        try {
          const start = Math.max(0, stat.size - maxBytes);
          const length = stat.size - start;
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, start);
          logTail = buf.toString("utf-8").replace(/[ --]/g, "");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* no log file yet */
      }
      return { success: true, dirId, activity, logTail, logExists, logBytes };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });
}
