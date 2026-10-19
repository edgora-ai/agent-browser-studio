import { ipcMain, BrowserWindow } from "electron";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  launchBrowser, stopBrowser, statusBrowser, listBrowserProfiles, checkFingerprintDrift,
  getRuntimeChromiumStatusAsync, verifyRuntimeChromiumAsync, getEngineStatusAsync,
  getProfileRuntimeSnapshot,
  createBrowserProfile, deleteBrowserProfile,
  getLaunchLogPath,
} from "../services/browser-manager.js";
import * as fs from "node:fs";
import { listAudit } from "../services/audit-log.js";
import { getConfig, saveConfig, setProfileMeta, assertProfileWritable, resolveProfileProxy, getProxyDetection, getEnvRiskDiagnostics } from "../services/config-manager.js";
import { checkProfileConsistency, type ConsistencyResult } from "../services/consistency-check.js";
import { captureFingerprint, diffFingerprints, hasRiskyDrift, checkPersonaConsistency, mismatchesAsDrift, sanitizePortableFingerprintBaseline } from "../services/fingerprint-baseline.js";
import {
  beginProfileHealthRun, cancelProfileHealthRun, clearProfileHealthHistory, listProfileHealthHistory,
  profileHealthFailure, recordProfileHealthResult, runProfileEnvironmentRisk,
  type ProfileHealthOptions, type ProfileHealthRun,
} from "../services/profile-health.js";
import type { ProfileHealthKind, ProfileHealthOutcome, ProfileNetworkObservationResult } from "../types.js";
import { listProfileNetworkPages, runProfileNetworkObservation } from "../services/profile-network-diagnostics.js";
import { recordAudit } from "../services/audit-log.js";
import { parseBulkCsv } from "../services/bulk-import.js";
import { listBusinessPresets, resolveBusinessPreset, presetProfileToCreateOpts } from "../services/business-presets.js";
import { validateDirId } from "../services/utils.js";
import { sanitizeBrowserEngine } from "../services/browser-engine.js";
import { getProfileEngineByDirId, navigateInPage } from "../services/page-eval.js";
import { assertSafeNavigationUrl } from "../services/local-agent.js";
import { getEntry } from "../services/browser/runtime-table.js";
import { assertChatBrowserScopePort, captureChatBrowserScope } from "../services/agent/run-scope.js";
import {
  runBatch,
  normalizeConcurrency,
  MAX_BATCH_CONCURRENCY,
  type BatchResult,
} from "../services/batch-queue.js";
import { newTraceId, logInfo } from "../services/observability.js";
import { checkCreateAllowed, checkLaunchAllowed } from "../services/license.js";
import { requireProfileMutation } from "../services/team.js";
import type { BrowserEngine, BrowserPlatform, BrowserProfileMeta, FingerprintMode, GeolocationMode, ProxyMode, RenderScaleMode, WebRtcMode } from "../types.js";

type BrowserIpcHandler = Parameters<typeof ipcMain.handle>[1];

export function ipcHealthOwner(event: Electron.IpcMainInvokeEvent): string {
  if (!event?.sender || !Number.isSafeInteger(event.sender.id) || event.sender.isDestroyed()) {
    throw new Error("Diagnostic owner is unavailable");
  }
  return `ipc:${event.sender.id}`;
}

/** Renderer teardown aborts work, but the service retains its lease until finally. */
export async function withIpcHealthOwner<T>(event: Electron.IpcMainInvokeEvent, task: (options: ProfileHealthOptions) => Promise<T>): Promise<T> {
  const owner = ipcHealthOwner(event);
  const controller = new AbortController();
  const destroyed = () => controller.abort();
  event.sender.once("destroyed", destroyed);
  try { return await task({ owner, signal: controller.signal }); }
  finally { event.sender.removeListener("destroyed", destroyed); }
}

/**
 * Sale-90/92 license gate and existing team policy shared by browser:launch,
 * browser:batch-launch, browser:open-risk-check, browser:open-app and the
 * WebRTC diagnostic's explicit auto-launch. Refusals throw with a machine `code` (LICENSE_EXPIRED /
 * PROFILE_LIMIT) so these handlers surface the paywall through the same
 * `{ success: false, code }` shape. The launch gate checks validity/expiry,
 * not creation quota; all four IPC launch paths must keep using this helper.
 * Stopping, exporting and deleting are never gated. Other service callers
 * of launchBrowser are outside this IPC gate (pre-existing boundary).
 */
export async function gatedLaunch(
  dirId: string,
  opts?: { forceDeadProxy?: boolean },
): Promise<Awaited<ReturnType<typeof launchBrowser>>> {
  const role = requireProfileMutation();
  if (!role.ok) throw Object.assign(new Error(role.error), { code: "TEAM_ROLE_DENIED" });
  const gate = checkLaunchAllowed();
  if (!gate.allowed) {
    const err = new Error(gate.error) as Error & { code?: string };
    err.code = gate.code;
    throw err;
  }
  return launchBrowser(dirId, { forceDeadProxy: opts?.forceDeadProxy === true });
}

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
    const runtime = getProfileRuntimeSnapshot();
    return listBrowserProfiles(runtime).map(p => ({
      ...p,
      installed: runtime.chromiumInstalled,
      runtimePending: runtime.pending,
    }));
  });

  handleBrowser("binary", async () => {
    return getRuntimeChromiumStatusAsync();
  });

  // Combined engine status (Slice 77): Chromium + Firefox availability.
  handleBrowser("engine-status", async () => {
    return getEngineStatusAsync();
  });

  handleBrowser("verify-binary", async () => {
    try {
      return { success: true, status: await verifyRuntimeChromiumAsync() };
    } catch (e: any) {
      return { success: false, error: e.message || String(e), status: await getRuntimeChromiumStatusAsync() };
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
      return { success: true, path: exe, status: await verifyRuntimeChromiumAsync() };
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
    renderScaleMode?: RenderScaleMode;
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
      renderScaleMode: opts.renderScaleMode,
      windowTitlePrefix: opts.windowTitlePrefix,
      appUrl: opts.appUrl,
      proxyMode: opts.proxyMode,
      proxyName: opts.proxyName,
      tags: opts.tags,
    };
    // Sale-90/92 license gate (IPC boundary, not the service layer): unit
    // tests and automation call createBrowserProfile directly; rental/expired
    // installs are refused here with a machine code the UI turns into the
    // paywall dialog. Data is never touched — only new profiles are refused.
    const createGate = checkCreateAllowed();
    if (!createGate.allowed) {
      return { success: false as const, error: createGate.error, code: createGate.code };
    }
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
    forceDeadProxy?: boolean;
  }) => {
    try {
      const r = await gatedLaunch(params.dirId, { forceDeadProxy: params?.forceDeadProxy === true });
      return { success: true, pid: r.pid, cdpPort: r.cdpPort, driftCheck: r.driftCheck, envCheck: r.envCheck, cookieCheck: (r as any).cookieCheck ?? { checked: false } };
    } catch (e: any) {
      // R12 P1-1: surface the machine code so the UI can offer the force-launch escape hatch.
      // Sale-90/92: the paywall code rides the same field (UI opens the dialog).
      return { success: false, error: e.message, code: (e as any)?.code || undefined };
    }
  });

  // Host environment risk check (DNS resolvers / CN fonts / proxy DNS / RAF).
  // R9 P1-4: every run is persisted (mirrors webrtc:diag-history) so the
  // report survives dialog close and supports detail replay + export.
  handleBrowser("env-risk", async (event, params: string | { dirId: string; requestId?: string }) => {
    const dirId = typeof params === "string" ? params : params?.dirId;
    const requestId = typeof params === "string" ? undefined : params?.requestId;
    try {
      return await withIpcHealthOwner(event, (options) => runProfileEnvironmentRisk(dirId, { ...options, requestId }));
    } catch (error) { return profileHealthFailure(error, requestId); }
  });

  handleBrowser("env-risk-history", async (_event, dirId: string) => {
    try {
      validateDirId(dirId);
      return { ok: true, entries: getEnvRiskDiagnostics(dirId) };
    } catch (e: any) {
      return { ok: false, entries: [], error: e.message || String(e) };
    }
  });

  handleBrowser("env-risk-clear", async (_event, dirId: string) => {
    try {
      validateDirId(dirId);
      clearProfileHealthHistory(dirId, "env");
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  handleBrowser("health-history", async (_event, dirId: string) => {
    let reading = false;
    try {
      if (typeof dirId !== "string") return { ok: false, entries: [], outcome: "error", code: "HEALTH_INVALID_REQUEST" };
      validateDirId(dirId); reading = true;
      return { entries: listProfileHealthHistory(dirId) };
    } catch {
      // Failure is not an authoritative empty history. Neither a malformed
      // identity nor storage/native exception prose may cross this shared route.
      return { ok: false, entries: [], outcome: "error", code: reading ? "NETWORK_OBSERVATION_FAILED" : "HEALTH_INVALID_REQUEST" };
    }
  });
  handleBrowser("health-cancel", async (event, dirId: string, options: { kind: ProfileHealthKind; requestId: string }) => {
    try { return cancelProfileHealthRun(dirId, { kind: options?.kind, requestId: options?.requestId, owner: ipcHealthOwner(event) }); }
    catch { return { success: false, cancelled: false, code: "HEALTH_INVALID_REQUEST" }; }
  });

  // New network routes accept only this positional contract. Ports, URLs,
  // target IDs, owners and observation times are never renderer authority.
  const networkRequestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
  const networkSelection = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function networkOptions(raw: unknown): raw is { selection: string; requestId: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 2 || keys.some(key => key !== "selection" && key !== "requestId")) return false;
    const selection = Object.getOwnPropertyDescriptor(raw, "selection");
    const requestId = Object.getOwnPropertyDescriptor(raw, "requestId");
    return Boolean(selection?.enumerable && requestId?.enumerable && Object.hasOwn(selection, "value") && Object.hasOwn(requestId, "value")
      && typeof selection.value === "string" && networkSelection.test(selection.value)
      && typeof requestId.value === "string" && networkRequestId.test(requestId.value));
  }
  function invalidNetworkObservation(requestId: string): ProfileNetworkObservationResult {
    return { ok: false, outcome: "error", requestId, code: "HEALTH_INVALID_REQUEST", hops: [], httpStatusEvidence: [], observation: {
      version: 1, completion: "unavailable", stopReason: "setup-rejected", armedAt: null, endedAt: Date.now(), durationMs: 0,
      counts: { requests: 0, hops: 0, responses: 0, finished: 0, failed: 0, blocked: 0, requestCancelled: 0, redirects: 0, http4xx: 0, http5xx: 0, pending: 0, cache: 0, serviceWorker: 0, unattributed: 0, cspIssues: 0 },
      coverage: { network: "unavailable", csp: "unavailable", worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" },
    } };
  }
  handleBrowser("network-pages", async (event, ...args: unknown[]) => {
    try {
      if (args.length !== 1 || typeof args[0] !== "string") return { ok: false, pages: [], code: "HEALTH_INVALID_REQUEST", outcome: "error" };
      validateDirId(args[0]);
      return await withIpcHealthOwner(event, options => listProfileNetworkPages(args[0] as string, options));
    } catch { return { ok: false, pages: [], code: "HEALTH_INVALID_REQUEST", outcome: "error" }; }
  });
  handleBrowser("network-observe", async (event, ...args: unknown[]) => {
    let requestId: string = randomUUID();
    try {
      if (args.length !== 2 || typeof args[0] !== "string" || !networkOptions(args[1])) return invalidNetworkObservation(requestId);
      const dirId = args[0]; const params = args[1]; requestId = params.requestId;
      validateDirId(dirId);
      return await withIpcHealthOwner(event, options => runProfileNetworkObservation(dirId, { ...options,
        selection: params.selection, requestId,
        onArmed(armed) {
          if (options.signal?.aborted || event.sender.isDestroyed() || armed.dirId !== dirId || armed.requestId !== requestId) return;
          event.sender.send("browser:network-armed", { dirId, requestId, armedAt: armed.armedAt, observeForMs: 10_000 });
        },
      }));
    } catch { return invalidNetworkObservation(requestId); }
  });
  handleBrowser("health-clear", async (event, ...args: unknown[]) => {
    let clearing = false;
    try {
      if (args.length < 1 || args.length > 2 || typeof args[0] !== "string"
        || args[1] !== undefined && !["env", "webrtc", "drift", "consistency", "network"].includes(args[1] as string)) {
        return { ok: false, code: "HEALTH_INVALID_REQUEST" };
      }
      validateDirId(args[0]); ipcHealthOwner(event);
      clearing = true;
      // The shared clear service invalidates active work before the transaction.
      // Diagnostic reads/clears do not gain baseline or launch mutation gates.
      clearProfileHealthHistory(args[0], args[1] as ProfileHealthKind | undefined);
      return { ok: true };
    } catch { return { ok: false, code: clearing ? "HEALTH_HISTORY_WRITE_FAILED" : "HEALTH_INVALID_REQUEST" }; }
  });

  // A missing baseline is unavailable, not a passed live drift comparison.
  handleBrowser("check-drift", async (event, dirId: string) => {
    let run: ProfileHealthRun | undefined;
    try {
      return await withIpcHealthOwner(event, async (options) => {
        run = beginProfileHealthRun(dirId, "drift", options);
        const result = await checkFingerprintDrift(dirId);
        run.assertCurrent();
        const outcome: ProfileHealthOutcome = result.hasBaseline === false || result.error === "profile not running" ? "unavailable" : !result.ok ? "error"
          : result.checked !== true ? "inconclusive" : result.risky ? "risk" : result.drift?.length ? "warn" : "pass";
        recordProfileHealthResult(dirId, { kind: "drift", at: Date.now(), outcome, requestId: run.requestId,
          source: result.checked ? "runtime" : "baseline", summary: result.error || (outcome === "unavailable" ? "No fingerprint baseline" : `Fingerprint drift: ${outcome}`) });
        return { ...result, outcome, requestId: run.requestId };
      });
    } catch (error) { return profileHealthFailure(error, run?.requestId); }
    finally { run?.finish(); }
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
  type ActiveBatchJob = { signal: { cancelled: boolean }; sender: Electron.WebContents; destroyed: () => void };
  const activeBatchJobs = new Map<string, ActiveBatchJob>();

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

  type BatchParams = { dirIds: string[]; concurrency?: number; jobId?: string };
  async function runBrowserBatch(kind: "launch" | "stop", event: Electron.IpcMainInvokeEvent, params: BatchParams) {
    let jobId: string;
    let dirIds: string[];
    try {
      if (!Array.isArray(params?.dirIds)) throw new Error("dirIds must be an array");
      dirIds = [...params.dirIds];
      for (const id of dirIds) validateDirId(id);
      if (params.jobId !== undefined && (typeof params.jobId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(params.jobId))) {
        throw new Error("Invalid batch jobId");
      }
      jobId = params.jobId || newTraceId();
    } catch (error: any) {
      return { success: false, code: "BATCH_INVALID_ARGUMENT", error: error?.message || String(error) };
    }
    // Reserve once across both operations. An older finally can never delete
    // another request's job, and guessing a renderer's ID grants no ownership.
    if (activeBatchJobs.has(jobId)) return { success: false, code: "BATCH_JOB_CONFLICT", error: "Batch jobId is already active" };
    if (!dirIds.length) {
      return { total: 0, succeeded: 0, failed: 0, cancelled: false, durationMs: 0, concurrency: 0, traceId: jobId, jobId, results: [] } as BatchResult<string> & { jobId: string };
    }
    const sender = event?.sender;
    if (!sender || sender.isDestroyed()) return { success: false, code: "BATCH_OWNER_UNAVAILABLE", error: "Batch owner is unavailable" };
    const signal = { cancelled: false };
    const job: ActiveBatchJob = { signal, sender, destroyed: () => { signal.cancelled = true; } };
    activeBatchJobs.set(jobId, job);
    try {
      sender.once("destroyed", job.destroyed);
      const concurrency = normalizeConcurrency(params.concurrency);
      logInfo(`batch.${kind}.start`, { jobId, traceId: jobId, total: dirIds.length, concurrency });
      const result = await runBatch<string>({
        items: dirIds, label: kind, concurrency, signal, traceId: jobId,
        onProgress: (done, total) => emitProgress(event, { jobId, kind, done, total }),
        worker: async (dirId) => {
          if (kind === "launch") {
            // Keep the same license/team/startup gates on every launch entry.
            const r = await gatedLaunch(dirId);
            return { dirId, name: profileName(dirId), pid: r.pid, cdpPort: r.cdpPort };
          }
          if (!stopBrowser(dirId)) throw new Error("Stop failed");
          return { dirId, name: profileName(dirId) };
        },
      });
      return { ...result, jobId };
    } finally {
      sender.removeListener("destroyed", job.destroyed);
      if (activeBatchJobs.get(jobId) === job) activeBatchJobs.delete(jobId);
    }
  }
  handleBrowser("batch-launch", (event, params: BatchParams) => runBrowserBatch("launch", event, params));
  handleBrowser("batch-stop", (event, params: BatchParams) => runBrowserBatch("stop", event, params));

  handleBrowser("batch-cancel", async (event, jobId: string) => {
    const job = typeof jobId === "string" ? activeBatchJobs.get(jobId) : undefined;
    if (!job || job.sender !== event?.sender) return { success: false, error: "Unknown or finished batch job" };
    job.signal.cancelled = true;
    logInfo("batch.cancel", { jobId });
    return { success: true };
  });

  handleBrowser("batch-max-concurrency", async () => ({ max: MAX_BATCH_CONCURRENCY }));

  handleBrowser("status", async (_event, dirId: string) => {
    return statusBrowser(dirId);
  });

  // sale-95: parameter-only preview for the create/edit form — the profile
  // may not exist yet, so check raw values instead of stored meta.
  handleBrowser("consistency-preview", async (_event, params: {
    timezone?: string | null; locale?: string | null; platform?: string;
    proxyMode?: string; proxyName?: string | null;
  }) => {
    try {
      const cfg = getConfig() as any;
      const p = params || {};
      const proxyGeo = p.proxyName ? getProxyDetection(String(p.proxyName)) : null;
      return checkProfileConsistency({
        timezone: p.timezone || null, locale: p.locale || null, webrtcIp: null, platform: p.platform || "windows",
        proxyMode: (p.proxyMode as any) || "none",
        proxyGeo,
      }, { blockOnProxyRisk: cfg.blockOnProxyRisk === true });
    } catch (e: any) {
      return { ok: false, warnings: [], blockers: [], error: e?.message || String(e) };
    }
  });

  // This is stored-field/cached-proxy alignment, not a fresh exit observation.
  // Preserve the existing findings API, but persist its honest provenance in
  // the same canonical history queried by every health UI entry point.
  handleBrowser("consistency-check", async (event, dirId: string) => {
    let run: ProfileHealthRun | undefined;
    let result: ConsistencyResult = { ok: false, warnings: [], blockers: [] };
    try {
      validateDirId(dirId);
      return await withIpcHealthOwner(event, async (options) => {
        const cfg = getConfig();
        const meta = Object.hasOwn(cfg.browserProfiles, dirId) ? cfg.browserProfiles[dirId] : undefined;
        if (!meta) return { ok: false, outcome: "unavailable", source: "cached", warnings: [], blockers: [{ severity: "blocker", code: "no-profile", message: "Profile not found" }] };
        // Diagnostic reads retain their original viewer permission. The lease
        // still prevents publishing under another request's cancellation owner.
        run = beginProfileHealthRun(dirId, "consistency", options);
        if (meta.fingerprintMode === "off") result = { ok: true, warnings: [], blockers: [] };
        else {
          const resolved = resolveProfileProxy(dirId);
          result = checkProfileConsistency({
            timezone: meta.timezone, locale: meta.locale, webrtcIp: meta.webrtcIp, platform: meta.platform,
            proxyMode: resolved.mode, proxyGeo: resolved.name ? getProxyDetection(resolved.name) : null,
          }, { blockOnProxyRisk: cfg.blockOnProxyRisk === true });
        }
        const outcome: ProfileHealthOutcome = result.blockers.length ? "risk" : result.warnings.length ? "warn" : "inconclusive";
        const summary = ["Cached consistency check; not a live measurement", ...result.blockers.map(finding => finding.message), ...result.warnings.map(finding => finding.message)].join("; ").slice(0, 2048);
        run.assertCurrent();
        recordProfileHealthResult(dirId, { kind: "consistency", at: Date.now(), outcome, source: "cached", requestId: run.requestId, summary });
        return { ...result, outcome, source: "cached", requestId: run.requestId };
      });
    } catch (error) { return { ...result, ...profileHealthFailure(error, run?.requestId), source: "cached" }; }
    finally { run?.finish(); }
  });

  // Risk acceptance is a short-lived, one-use capability, never a stored flag.
  // Bind it to the reviewed old/new identities and the invoking window. Ignore
  // presentation-only edits so a concurrent note is preserved by setProfileMeta.
  type BaselineConfirmation = {
    dirId: string; sender: Electron.WebContents; before: unknown; current: unknown;
    identity: unknown; pid: number | null; port: number; expiresAt: number; destroyed: () => void; timer?: ReturnType<typeof setTimeout>;
  };
  const baselineConfirmations = new Map<string, BaselineConfirmation>();
  function releaseBaselineConfirmation(token: string): void {
    const pending = baselineConfirmations.get(token);
    if (!pending) return;
    pending.sender.removeListener("destroyed", pending.destroyed);
    if (pending.timer) clearTimeout(pending.timer);
    baselineConfirmations.delete(token);
  }
  function baselineIdentity(meta: BrowserProfileMeta): Record<string, unknown> {
    const { name, note, tags, updatedAt, syncedAt, syncedHash, syncBaseline, lock, fingerprintBaseline, ...identity } = meta;
    return identity;
  }
  const staleBaseline = () => ({ ok: false, code: "BASELINE_CONFIRMATION_STALE", outcome: "inconclusive", error: "The reviewed fingerprint or profile changed. Capture and review it again." });

  handleBrowser("capture-baseline", async (event, params: string | { dirId: string; confirmationToken?: string }) => {
    let run: ProfileHealthRun | undefined;
    try {
      return await withIpcHealthOwner(event, async (options) => {
        const dirId = typeof params === "string" ? params : params?.dirId;
        validateDirId(dirId);
        const role = requireProfileMutation();
        if (!role.ok) return { ok: false, code: "TEAM_ROLE_DENIED", outcome: "error", error: role.error };
        assertProfileWritable(dirId);
        const meta = structuredClone(getConfig().browserProfiles?.[dirId]);
        if (!meta) return { ok: false, outcome: "unavailable", error: "Profile not found" };
        const st = statusBrowser(dirId);
        if (!st.running || !st.cdpPort) return { ok: false, outcome: "unavailable", error: "profile not running" };
        const sender = event.sender;
        if (!sender || sender.isDestroyed()) return { ok: false, outcome: "cancelled", error: "Capture owner is unavailable" };
        for (const [token, pending] of baselineConfirmations) {
          if (pending.expiresAt <= Date.now()) releaseBaselineConfirmation(token);
        }
        const token = typeof params === "string" ? undefined : params.confirmationToken;
        let confirmation: BaselineConfirmation | undefined;
        if (token !== undefined) {
          confirmation = typeof token === "string" ? baselineConfirmations.get(token) : undefined;
          if (!confirmation || confirmation.dirId !== dirId || confirmation.sender !== sender) return staleBaseline();
          releaseBaselineConfirmation(token!);
          if (confirmation.expiresAt <= Date.now() || !isDeepStrictEqual(confirmation.before, meta.fingerprintBaseline) ||
              !isDeepStrictEqual(confirmation.identity, baselineIdentity(meta)) || confirmation.pid !== st.pid || confirmation.port !== st.cdpPort) return staleBaseline();
        }
        const identity = baselineIdentity(meta);
        run = beginProfileHealthRun(dirId, "drift", options);
        const captured = await captureFingerprint(st.cdpPort, getProfileEngineByDirId(dirId));
        const current = sanitizePortableFingerprintBaseline(captured);
        // Async CDP must not grant permission to overwrite a lock or a baseline
        // that arrived while it was running. Re-read immediately before commit.
        assertProfileWritable(dirId);
        run.assertCurrent();
        if (!current) return { ok: false, outcome: "inconclusive", code: "BASELINE_EMPTY_SNAPSHOT", error: "The probe returned no fingerprint fields; the old baseline was preserved." };
        const latest = getConfig().browserProfiles?.[dirId];
        const live = statusBrowser(dirId);
        if (sender.isDestroyed() || !latest || !live.running || live.pid !== st.pid || live.cdpPort !== st.cdpPort ||
            !isDeepStrictEqual(meta.fingerprintBaseline, latest.fingerprintBaseline) ||
            !isDeepStrictEqual(identity, baselineIdentity(latest))) return staleBaseline();
        if (confirmation && (confirmation.expiresAt <= Date.now() || !isDeepStrictEqual(confirmation.current, current))) return staleBaseline();
        const prior = sanitizePortableFingerprintBaseline(meta.fingerprintBaseline);
        const drift = diffFingerprints(prior, current);
        const personaDrift = mismatchesAsDrift(checkPersonaConsistency({ platform: meta.platform || "windows", timezone: meta.timezone }, current));
        const combined = [...drift, ...personaDrift];
        const risky = hasRiskyDrift(drift) || personaDrift.length > 0;
        if (risky && !confirmation) {
          // One pending review per window/profile; global bound prevents renderer
          // spam from retaining unbounded full snapshots or destroyed listeners.
          for (const [pendingToken, pending] of baselineConfirmations) {
            if (pending.sender === sender && pending.dirId === dirId) releaseBaselineConfirmation(pendingToken);
          }
          while (baselineConfirmations.size >= 32) releaseBaselineConfirmation(baselineConfirmations.keys().next().value!);
          const confirmationToken = randomUUID();
          const pending: BaselineConfirmation = { dirId, sender, before: meta.fingerprintBaseline, current, identity,
            pid: st.pid, port: st.cdpPort, expiresAt: Date.now() + 5 * 60 * 1000,
            destroyed: () => releaseBaselineConfirmation(confirmationToken) };
          baselineConfirmations.set(confirmationToken, pending);
          sender.once("destroyed", pending.destroyed);
          pending.timer = setTimeout(pending.destroyed, 5 * 60 * 1000);
          pending.timer.unref?.();
          return { ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", outcome: "risk", confirmationToken, fields: Object.keys(current).length, drift: combined, risky, baseline: current };
        }
        run.assertCurrent();
        setProfileMeta(dirId, { fingerprintBaseline: current });
        const outcome = risky ? "risk" as const : "baseline-established" as const;
        let historyWarning: string | undefined;
        try {
          recordProfileHealthResult(dirId, { kind: "drift", at: Date.now(), outcome, requestId: run.requestId, source: "baseline",
            summary: risky ? "Risky fingerprint baseline explicitly accepted" : "Fingerprint baseline established; not a health pass" });
        } catch (error: any) {
          // The baseline transaction already committed. Do not report a rollback
          // merely because the separate historical summary could not be saved.
          historyWarning = `Baseline saved, but health history could not be saved: ${error?.message || String(error)}`;
        }
        if (combined.length) {
          recordAudit({ category: "profile", action: "fingerprint-drift", target: dirId,
            detail: `${combined.length} field(s) changed${risky ? " (risky, explicitly accepted)" : ""}: ${combined.map((d) => d.field).slice(0, 8).join(", ")}` });
        } else {
          recordAudit({ category: "profile", action: "fingerprint-baseline", target: dirId, detail: "baseline established; not a health pass" });
        }
        return { ok: true, outcome, baselineCommitted: true, requestId: run.requestId, fields: Object.keys(current).length, drift: combined, risky, baseline: current,
          ...(historyWarning ? { code: "HEALTH_HISTORY_WRITE_FAILED", warning: historyWarning } : {}) };
      });
    } catch (error) { return profileHealthFailure(error, run?.requestId); }
    finally { run?.finish(); }
  });

  // Set fingerprint seed for a profile
  handleBrowser("set-seed", async (_event, params: {
    dirId: string; seed: number;
  }) => {
    try {
      validateDirId(params?.dirId);
      if (!Object.hasOwn(getConfig().browserProfiles || {}, params.dirId)) return { success: false };
      if (typeof params.seed !== "number") throw new Error("Fingerprint seed must be a number");
      // Keep the checkout lock, validation and other concurrent metadata intact.
      setProfileMeta(params.dirId, { fingerprintSeed: params.seed });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
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
    renderScaleMode?: RenderScaleMode;
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
        renderScaleMode: params.renderScaleMode,
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
      ipcHealthOwner(_event);
      url = await assertSafeNavigationUrl(rawUrl);
      ipcHealthOwner(_event);
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
        const launchResult = await gatedLaunch(dirId);
        cdpPort = launchResult.cdpPort || 0;
        status = statusBrowser(dirId);
      } catch (e: any) {
        // Sale-90/92: the paywall code rides through (UI opens the dialog);
        // anything else keeps the legacy bare message.
        if ((e as any)?.code === "LICENSE_EXPIRED" || (e as any)?.code === "PROFILE_LIMIT") {
          return { success: false, error: e.message, code: (e as any).code, autoLaunched: true };
        }
        return { success: false, error: `Failed to launch: ${e.message || String(e)}`, autoLaunched: true };
      }
    }

    if (!cdpPort || !status.running) {
      return { success: false, error: "Profile is not running and CDP port could not be obtained" };
    }

    try {
      const runtime = getEntry(dirId);
      const scope = captureChatBrowserScope(dirId);
      if (!runtime || !scope || runtime.port !== cdpPort) throw new Error("Browser navigation runtime changed");
      const engine = runtime.engine ?? "chromium";
      const session = runtime.bidiConn ?? null;
      const assertCurrent = () => {
        ipcHealthOwner(_event);
        assertChatBrowserScopePort(scope, cdpPort);
        if ((runtime.engine ?? "chromium") !== engine || (runtime.bidiConn ?? null) !== session) throw new Error("Browser navigation runtime was replaced");
      };
      await withIpcHealthOwner(_event, ({ signal }) => navigateInPage(cdpPort, engine, url, {
        timeoutMs: 10000, waitForLoad: true, signal, assertCurrent,
        ...(engine === "firefox" ? { expectedFirefoxSession: session } : {}),
      }));
      assertCurrent();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
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
      ipcHealthOwner(_event);
      appUrl = await assertSafeNavigationUrl(rawAppUrl);
      ipcHealthOwner(_event);
    } catch (e: any) {
      return { success: false, error: `Refused unsafe navigation URL: ${e?.message || String(e)}` };
    }

    let status = statusBrowser(dirId);
    let cdpPort = status.cdpPort || 0;
    if (!status.running) {
      try {
        const launchResult = await gatedLaunch(dirId);
        cdpPort = launchResult.cdpPort || 0;
        status = statusBrowser(dirId);
      } catch (e: any) {
        if ((e as any)?.code === "LICENSE_EXPIRED" || (e as any)?.code === "PROFILE_LIMIT") {
          return { success: false, error: e.message, code: (e as any).code, autoLaunched: true };
        }
        return { success: false, error: `Failed to launch: ${e.message || String(e)}`, autoLaunched: true };
      }
    }
    if (!cdpPort || !status.running) {
      return { success: false, error: "Profile is not running and CDP port could not be obtained" };
    }

    try {
      const runtime = getEntry(dirId);
      const scope = captureChatBrowserScope(dirId);
      if (!runtime || !scope || runtime.port !== cdpPort) throw new Error("Browser navigation runtime changed");
      const engine = runtime.engine ?? "chromium";
      const session = runtime.bidiConn ?? null;
      const assertCurrent = () => {
        ipcHealthOwner(_event);
        assertChatBrowserScopePort(scope, cdpPort);
        if ((runtime.engine ?? "chromium") !== engine || (runtime.bidiConn ?? null) !== session) throw new Error("Browser navigation runtime was replaced");
      };
      await withIpcHealthOwner(_event, ({ signal }) => navigateInPage(cdpPort, engine, appUrl, {
        timeoutMs: 10000, waitForLoad: true, signal, assertCurrent,
        ...(engine === "firefox" ? { expectedFirefoxSession: session } : {}),
      }));
      assertCurrent();
      return { success: true, appUrl };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
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
