import { ipcMain } from "electron";
import {
  launchCloak, stopCloak, statusCloak, listCloakProfiles,
  getCloakBinaryStatus, installCloakBinary, checkCloakBinaryUpdate,
  updateCloakBinary, clearCloakBinaryCache,
  getCloakVersion, isCloakInstalled,
  createCloakProfile, deleteCloakProfile,
} from "../services/cloak-manager.js";
import { getConfig, saveConfig, setProfileMeta, resolveProfileProxy, getProxyDetection } from "../services/config-manager.js";
import { checkProfileConsistency } from "../services/consistency-check.js";
import { captureFingerprint, diffFingerprints, hasRiskyDrift } from "../services/fingerprint-baseline.js";
import { recordAudit } from "../services/audit-log.js";
import { parseBulkCsv } from "../services/bulk-import.js";
import { validateDirId } from "../services/utils.js";
import { cdpConnect, cdpNavigate, cdpWaitForLoad, cdpDisconnect } from "../services/local-agent.js";
import type { CloakPlatform, GeolocationMode, ProxyMode } from "../types.js";

export function registerCloakHandlers(): void {
  // Parse a bulk-import CSV (header or legacy positional) into profile specs.
  ipcMain.handle("cloak:parse-bulk-csv", async (_event, text: string) => {
    try { return { ok: true, specs: parseBulkCsv(String(text || "")) }; }
    catch (e: any) { return { ok: false, error: e.message || String(e) }; }
  });

  ipcMain.handle("cloak:list", async () => {
    return listCloakProfiles().map(p => ({
      ...p,
      installed: isCloakInstalled(),
      version: getCloakVersion() || p.version || "?",
    }));
  });

  ipcMain.handle("cloak:binary", async () => {
    return getCloakBinaryStatus();
  });

  ipcMain.handle("cloak:install-binary", async () => {
    try {
      return { success: true, status: await installCloakBinary() };
    } catch (e: any) {
      return { success: false, error: e.message || String(e), status: getCloakBinaryStatus() };
    }
  });

  ipcMain.handle("cloak:check-update", async () => {
    try {
      return { success: true, ...(await checkCloakBinaryUpdate()) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e), status: getCloakBinaryStatus() };
    }
  });

  ipcMain.handle("cloak:update-binary", async () => {
    try {
      return { success: true, ...(await updateCloakBinary()) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e), status: getCloakBinaryStatus() };
    }
  });

  ipcMain.handle("cloak:clear-cache", async () => {
    try {
      return { success: true, status: clearCloakBinaryCache() };
    } catch (e: any) {
      return { success: false, error: e.message || String(e), status: getCloakBinaryStatus() };
    }
  });

  ipcMain.handle("cloak:create", async (_event, opts: {
    name: string; fingerprintSeed?: number; platform?: CloakPlatform;
    timezone?: string; locale?: string; webrtcIp?: string;
    geolocationMode?: GeolocationMode; geolocationLatitude?: number | null; geolocationLongitude?: number | null; geolocationAccuracy?: number | null;
    gpuVendor?: string | null; gpuRenderer?: string | null; hardwareConcurrency?: number | null; deviceMemory?: number | null;
    screenWidth?: number | null; screenHeight?: number | null; storageQuota?: number | null; taskbarHeight?: number | null; fontsDir?: string | null;
    proxyMode?: ProxyMode; proxyName?: string | null; tags?: string[];
  }) => {
    const r = createCloakProfile({
      name: opts.name,
      fingerprintSeed: opts.fingerprintSeed,
      platform: opts.platform,
      timezone: opts.timezone,
      locale: opts.locale,
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
      proxyMode: opts.proxyMode,
      proxyName: opts.proxyName,
      tags: opts.tags,
    });
    return r;
  });

  ipcMain.handle("cloak:delete", async (_event, dirId: string) => {
    try {
      return { success: deleteCloakProfile(dirId) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("cloak:launch", async (_event, params: {
    dirId: string;
  }) => {
    try {
      const r = await launchCloak(params.dirId);
      return { success: true, pid: r.pid, cdpPort: r.cdpPort };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("cloak:stop", async (_event, dirId: string) => {
    return { success: stopCloak(dirId) };
  });

  ipcMain.handle("cloak:status", async (_event, dirId: string) => {
    return statusCloak(dirId);
  });

  // Pre-launch consistency check (timezone / locale / WebRTC vs proxy) for the UI badge.
  ipcMain.handle("cloak:consistency-check", async (_event, dirId: string) => {
    validateDirId(dirId);
    const cfg = getConfig() as any;
    const meta = cfg.cloakProfiles?.[dirId];
    if (!meta) return { ok: false, warnings: [], blockers: [{ severity: "blocker", code: "no-profile", message: "Profile not found" }] };
    const resolved = resolveProfileProxy(dirId);
    const proxyGeo = resolved.name ? getProxyDetection(resolved.name) : null;
    return checkProfileConsistency({
      timezone: meta.timezone, locale: meta.locale, webrtcIp: meta.webrtcIp, platform: meta.platform,
      proxyMode: resolved.mode,
      proxyGeo,
    });
  });

  // Capture (or re-capture) the live fingerprint baseline; diff vs the prior one.
  ipcMain.handle("cloak:capture-baseline", async (_event, dirId: string) => {
    validateDirId(dirId);
    const st = statusCloak(dirId);
    if (!st.running || !st.cdpPort) return { ok: false, error: "profile not running" };
    try {
      const current = await captureFingerprint(st.cdpPort);
      const cfg = getConfig() as any;
      const meta = cfg.cloakProfiles?.[dirId] || {};
      const drift = diffFingerprints(meta.fingerprintBaseline, current);
      const risky = hasRiskyDrift(drift);
      cfg.cloakProfiles[dirId] = { ...meta, fingerprintBaseline: current };
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
  ipcMain.handle("cloak:set-seed", async (_event, params: {
    dirId: string; seed: number;
  }) => {
    validateDirId(params.dirId);
    const cfg = getConfig();
    if (!Object.hasOwn(cfg.cloakProfiles || {}, params.dirId)) return { success: false };
    cfg.cloakProfiles[params.dirId]!.fingerprintSeed = params.seed;
    saveConfig(cfg);
    return { success: true };
  });

  // Set CloakBrowser fingerprint metadata (name, timezone, locale, webrtc IP, platform, seed, note)
  ipcMain.handle("cloak:set-meta", async (_event, params: {
    dirId: string;
    name?: string;
    fingerprintSeed?: number;
    platform?: CloakPlatform;
    timezone?: string;
    locale?: string;
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
    note?: string;
    proxyMode?: ProxyMode;
    proxyName?: string | null;
    tags?: string[];
  }) => {
    validateDirId(params.dirId);
    const cfg = getConfig();
    if (!Object.hasOwn(cfg.cloakProfiles || {}, params.dirId)) return { success: false };
    try {
      setProfileMeta(params.dirId, {
        name: params.name,
        fingerprintSeed: params.fingerprintSeed,
        platform: params.platform,
        timezone: params.timezone,
        locale: params.locale,
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
        fontsDir: params.fontsDir,
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // Open fingerprint risk-check URL in a profile
  // If profile is not running, auto-launches it first and waits for CDP readiness.
  ipcMain.handle("cloak:open-risk-check", async (_event, params: { dirId: string }) => {
    const { dirId } = params;
    validateDirId(dirId);
    const url = "https://ping0.cc/env";

    let status = statusCloak(dirId);
    let cdpPort = status.cdpPort || 0;

    // Auto-launch if not running
    if (!status.running) {
      try {
        const launchResult = await launchCloak(dirId);
        cdpPort = launchResult.cdpPort || 0;
        status = statusCloak(dirId);
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
}
