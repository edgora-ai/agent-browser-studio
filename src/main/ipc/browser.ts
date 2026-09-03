import { ipcMain, BrowserWindow } from "electron";
import * as nodePath from "node:path";
import {
  launchBrowser, stopBrowser, statusBrowser, listBrowserProfiles, checkFingerprintDrift,
  getRuntimeChromiumStatus, verifyRuntimeChromium, getEngineStatus,
  getRuntimeChromiumVersion, isRuntimeChromiumInstalled,
  createBrowserProfile, deleteBrowserProfile,
  getLaunchLogPath,
} from "../services/browser-manager.js";
import * as fs from "node:fs";
import { listAudit } from "../services/audit-log.js";
import { getConfig, saveConfig, setProfileMeta, resolveProfileProxy, getProxyDetection } from "../services/config-manager.js";
import { checkProfileConsistency } from "../services/consistency-check.js";
import { captureFingerprint, diffFingerprints, hasRiskyDrift, checkPersonaConsistency, mismatchesAsDrift } from "../services/fingerprint-baseline.js";
import { checkEnvironmentRisk, checkEnvironmentRiskRuntime } from "../services/environment-risk.js";
import { recordAudit } from "../services/audit-log.js";
import { parseBulkCsv } from "../services/bulk-import.js";
import { listBusinessPresets, resolveBusinessPreset, presetProfileToCreateOpts } from "../services/business-presets.js";
import { validateDirId } from "../services/utils.js";
import { sanitizeBrowserEngine } from "../services/browser-engine.js";
import { cdpConnect, cdpNavigate, cdpWaitForLoad, cdpDisconnect, assertSafeNavigationUrl } from "../services/local-agent.js";
import {
  runBatch,
  normalizeConcurrency,
  MAX_BATCH_CONCURRENCY,
  type BatchResult,
} from "../services/batch-queue.js";
import { newTraceId, logInfo } from "../services/observability.js";
import type { BrowserEngine, BrowserPlatform, FingerprintMode, GeolocationMode, ProxyMode, WebRtcMode } from "../types.js";

type BrowserIpcHandler = Parameters<typeof ipcMain.handle>[1];

function handleBrowser(action: string, handler: BrowserIpcHandler): void {
  ipcMain.handle(`browser:${action}`, handler);
  // Keep the pre-rename channel as an unadvertised compatibility alias for
  // automation clients during the data migration window.
  ipcMain.handle(`cloak:${action}`, handler);
}

/**
 * Resolve a user-picked path to a Chromium executable.
 * Accepts the .app bundle (Contents/MacOS/<binary>) or the binary directly.
 */
function resolveChromiumExecutable(picked: string): string | null {
  if (!picked) return null;
  try {
    if (fs.statSync(picked).isFile()) return picked;
  } catch {
    return null;
  }
  for (const rel of ["Contents/MacOS", "Contents"]) {
    const dir = nodePath.join(picked, rel);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && (st.mode & 0o111) !== 0) return full;
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  return null;
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

  // Combined engine status (Slice 77): Chromium + Firefox availability.
  handleBrowser("engine-status", async () => {
    return getEngineStatus();
  });

  handleBrowser("verify-binary", async () => {
    try {
      return { success: true, status: verifyRuntimeChromium() };
    } catch (e: any) {
      return { success: false, error: e.message || String(e), status: getRuntimeChromiumStatus() };
    }
  });

  // Review item PL-07: a missing engine used to surface only as a launch
  // failure. This lets the Profiles page offer a direct in-app recovery path.
  handleBrowser("select-binary", async () => {
    try {
      const { dialog } = await import("electron");
      const win = BrowserWindow.getFocusedWindow();
      const picked = await dialog.showOpenDialog(win as any, {
        title: "Select the Chromium app or executable",
        properties: ["openDirectory", "openFile"],
      });
      if (picked.canceled || !picked.filePaths.length) return { success: false, cancelled: true };
      const chosen = picked.filePaths[0];
      const exe = resolveChromiumExecutable(chosen);
      if (!exe) return { success: false, error: "No Chromium executable found inside that selection" };
      const cfg = getConfig();
      cfg.chromiumBin = exe;
      saveConfig(cfg);
      recordAudit({
        category: "profile",
        action: "engine-binary-selected",
        target: exe,
        actor: "user",
        detail: "chromium binary configured from the UI",
      });
      return { success: true, path: exe, status: verifyRuntimeChromium() };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  // Business one-click preset catalog (Slice 75).
  handleBrowser("presets", async () => listBusinessPresets());

  handleBrowser("create", async (_event, opts: {
    name: string; engine?: BrowserEngine; fingerprintSeed?: number; platform?: BrowserPlatform;
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
    businessPresetId?: string;
  }) => {
    const explicit: Parameters<typeof createBrowserProfile>[0] = {
      name: opts.name,
      engine: opts.engine,
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
    };
    // Business preset: the main process applies the preset authoritatively so a
    // preset profile can never be created with a partial/incoherent identity.
    // Explicit user fields always win over preset defaults.
    if (opts.businessPresetId) {
      const presetFields = presetProfileToCreateOpts(resolveBusinessPreset(opts.businessPresetId));
      for (const key of Object.keys(presetFields) as Array<keyof ReturnType<typeof presetProfileToCreateOpts>>) {
        const value = (explicit as Record<string, unknown>)[key];
        if (value === undefined || value === null || value === "") {
          (explicit as Record<string, unknown>)[key] = presetFields[key];
        }
      }
    }
    const r = createBrowserProfile({ ...explicit, preset: opts.businessPresetId || null });
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
      return { success: true, pid: r.pid, cdpPort: r.cdpPort, driftCheck: r.driftCheck, envCheck: r.envCheck, cookieCheck: (r as any).cookieCheck ?? { checked: false } };
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

  // ── Batch operations (review items PL-01 / PL-02) ──
  // Concurrency is bounded here as well as in the renderer, so automation
  // clients that bypass the UI cannot fan out unbounded Chromium launches.
  const activeBatchJobs = new Map<string, { cancelled: boolean }>();

  function profileName(dirId: string): string {
    try {
      const cfg = getConfig() as any;
      return cfg.browserProfiles?.[dirId]?.name || dirId.slice(0, 8);
    } catch {
      return dirId.slice(0, 8);
    }
  }

  function emitProgress(event: any, payload: Record<string, unknown>): void {
    try {
      const sender = event?.sender;
      if (sender && typeof sender.send === "function" && !sender.isDestroyed()) {
        sender.send("batch:progress", payload);
      }
    } catch {
      /* window closed mid-batch — progress is best effort */
    }
  }

  handleBrowser("batch-launch", async (event, params: { dirIds: string[]; concurrency?: number; jobId?: string }) => {
    const dirIds = Array.isArray(params?.dirIds) ? params.dirIds.filter(Boolean) : [];
    const jobId = params?.jobId || newTraceId();
    if (!dirIds.length) {
      return { total: 0, succeeded: 0, failed: 0, cancelled: false, durationMs: 0, concurrency: 0, traceId: jobId, jobId, results: [] } as BatchResult<string> & { jobId: string };
    }
    for (const id of dirIds) validateDirId(id);
    const concurrency = normalizeConcurrency(params?.concurrency);
    const signal = { cancelled: false };
    activeBatchJobs.set(jobId, signal);
    logInfo("batch.launch.start", { jobId, total: dirIds.length, concurrency });
    try {
      const result = await runBatch<string>({
        items: dirIds,
        label: "launch",
        concurrency,
        signal,
        onProgress: (done, total) => emitProgress(event, { jobId, kind: "launch", done, total }),
        worker: async (dirId) => {
          const r = await launchBrowser(dirId);
          return { dirId, name: profileName(dirId), pid: r.pid, cdpPort: r.cdpPort };
        },
      });
      return { ...result, jobId };
    } finally {
      activeBatchJobs.delete(jobId);
    }
  });

  handleBrowser("batch-stop", async (event, params: { dirIds: string[]; concurrency?: number; jobId?: string }) => {
    const dirIds = Array.isArray(params?.dirIds) ? params.dirIds.filter(Boolean) : [];
    const jobId = params?.jobId || newTraceId();
    if (!dirIds.length) {
      return { total: 0, succeeded: 0, failed: 0, cancelled: false, durationMs: 0, concurrency: 0, traceId: jobId, jobId, results: [] } as BatchResult<string> & { jobId: string };
    }
    for (const id of dirIds) validateDirId(id);
    const concurrency = normalizeConcurrency(params?.concurrency);
    const signal = { cancelled: false };
    activeBatchJobs.set(jobId, signal);
    logInfo("batch.stop.start", { jobId, total: dirIds.length, concurrency });
    try {
      const result = await runBatch<string>({
        items: dirIds,
        label: "stop",
        concurrency,
        signal,
        onProgress: (done, total) => emitProgress(event, { jobId, kind: "stop", done, total }),
        worker: async (dirId) => {
          const ok = stopBrowser(dirId);
          if (!ok) throw new Error("Stop failed");
          return { dirId, name: profileName(dirId) };
        },
      });
      return { ...result, jobId };
    } finally {
      activeBatchJobs.delete(jobId);
    }
  });

  handleBrowser("batch-cancel", async (_event, jobId: string) => {
    const job = activeBatchJobs.get(String(jobId || ""));
    if (!job) return { success: false, error: "Unknown or finished batch job" };
    job.cancelled = true;
    logInfo("batch.cancel", { jobId });
    return { success: true };
  });

  handleBrowser("batch-max-concurrency", async () => ({ max: MAX_BATCH_CONCURRENCY }));

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
      const cfg = getConfig() as any;
      const engine = sanitizeBrowserEngine(cfg.browserProfiles?.[dirId]?.engine);
      const current = await captureFingerprint(st.cdpPort, engine);
      const meta = cfg.browserProfiles?.[dirId] || {};
      const drift = diffFingerprints(meta.fingerprintBaseline, current);
      const personaDrift = mismatchesAsDrift(checkPersonaConsistency(
        { platform: meta.platform || "windows", timezone: meta.timezone },
        current,
      ));
      const combined = [...drift, ...personaDrift];
      const risky = hasRiskyDrift(drift) || personaDrift.length > 0;
      cfg.browserProfiles[dirId] = { ...meta, fingerprintBaseline: current };
      saveConfig(cfg);
      if (combined.length) {
        recordAudit({ category: "profile", action: "fingerprint-drift", target: dirId,
          detail: `${combined.length} field(s) changed${risky ? " (risky)" : ""}: ${combined.map((d) => d.field).slice(0, 8).join(", ")}` });
      } else {
        recordAudit({ category: "profile", action: "fingerprint-baseline", target: dirId, detail: "baseline captured (stable)" });
      }
      return { ok: true, fields: Object.keys(current).length, drift: combined, risky, baseline: current };
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

  // Open fingerprint risk-check URL in a profile.
  //
  // Review item PL-03: this used to auto-launch a stopped profile without
  // asking, so a "read-only" check silently started a browser (burning
  // resources and changing the profile's live state). Launching now requires
  // the caller to pass `allowLaunch: true`, which the UI only does after an
  // explicit confirmation.
  //
  // Review item TE-04: the destination is a third-party site, so the UI must
  // obtain consent before calling this handler at all.
  handleBrowser("open-risk-check", async (_event, params: { dirId: string; allowLaunch?: boolean; url?: string }) => {
    const { dirId } = params;
    validateDirId(dirId);
    // Privileged-browser navigation allowlist (R7 #39): a compromised
    // renderer must not drive the profile to an arbitrary URL (metadata IP,
    // attacker host). Custom URLs go through the same SSRF guard as agent
    // navigation; the default ping0 URL is always allowed.
    const rawUrl = String(params?.url || "https://ping0.cc/env");
    let url: string;
    try {
      url = await assertSafeNavigationUrl(rawUrl);
    } catch (e: any) {
      return { success: false, error: `Refused unsafe navigation URL: ${e?.message || String(e)}` };
    }

    let status = statusBrowser(dirId);
    let cdpPort = status.cdpPort || 0;

    // Auto-launch only when the caller (UI, after user confirmation) allows it.
    if (!status.running) {
      if (!params?.allowLaunch) {
        return {
          success: false,
          code: "PROFILE_NOT_RUNNING",
          error: "The profile is not running. This check needs a running browser.",
        };
      }
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
    const rawAppUrl = String(params.url && params.url.trim() ? params.url : (meta.appUrl || "")).trim();
    if (!rawAppUrl) return { success: false, error: "No Web App URL configured for this profile" };
    let appUrl: string;
    try {
      appUrl = await assertSafeNavigationUrl(rawAppUrl);
    } catch (e: any) {
      return { success: false, error: `Refused unsafe navigation URL: ${e?.message || String(e)}` };
    }

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
          logTail = buf.toString("utf-8").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
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
