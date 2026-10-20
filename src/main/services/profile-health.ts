import { createHash, randomUUID } from "node:crypto";
import {
  appendProfileHealthResult, clearProfileHealthRecords, getConfig, getConfigPath,
  getEnvRiskDiagnostics, getProfileHealthHistory, getWebRtcDiagnostics,
  onProfileHealthRecordsCleared, portableProfileContent, resolveProfileProxy, setEnvRiskDiagnostics,
} from "./config-manager.js";
import { statusBrowser } from "./browser-manager.js";
import { getEntry, getLaunchProxySnapshot } from "./browser/runtime-table.js";
import { sanitizeBrowserEngine } from "./browser-engine.js";
import { clearFingerprintComparison } from "./fingerprint-drift-reports.js";
import { getProfileDataRevision } from "./profile-data-revision.js";
import { isRestoreLocked } from "./profile-restore-lock.js";
import { checkEnvironmentRisk, checkEnvironmentRiskRuntime, summarizeEnvFindings } from "./environment-risk.js";
import type { EnvironmentRiskResult } from "./environment-risk.js";
import { tMain } from "./main-i18n.js";
import { validateDirId } from "./utils.js";
import type { EnvRiskDiagnosticsEntry, ProfileHealthEntry, ProfileHealthKind, ProfileHealthOutcome } from "../types.js";

export interface ProfileHealthOptions {
  requestId?: string;
  signal?: AbortSignal;
  owner?: string;
}
export interface ProfileEnvironmentRiskRunResult {
  ok: boolean;
  outcome: ProfileHealthOutcome;
  requestId?: string;
  result?: EnvironmentRiskResult;
  code?: string;
  error?: string;
}
export class ProfileHealthError extends Error {
  constructor(public readonly code: string, message: string, public readonly outcome: ProfileHealthOutcome = "error") {
    super(`${code}: ${message}`);
    this.name = "ProfileHealthError";
  }
}
export interface ProfileHealthRun {
  readonly dirId: string;
  readonly kind: ProfileHealthKind;
  readonly requestId: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  finish(): void;
}
interface ActiveHealthRun {
  kind: ProfileHealthKind;
  requestId: string;
  owner: string;
  controller: AbortController;
  cancelCode?: string;
}
const active = new Map<string, ActiveHealthRun>();
const MAX_ACTIVE_HEALTH_RUNS = 4;
const HEALTH_DEADLINE_MS = 20_000;
const kinds = new Set<ProfileHealthKind>(["env", "webrtc", "drift", "consistency", "network"]);

onProfileHealthRecordsCleared((dirId, kind) => {
  const running = active.get(dirId);
  if (running && (kind === undefined || running.kind === kind) && !running.controller.signal.aborted) {
    running.cancelCode = "HEALTH_CANCELLED";
    running.controller.abort();
  }
});

function targetIdentity(dirId: string, kind: ProfileHealthKind): string {
  const cfg = getConfig();
  if (!Object.hasOwn(cfg.browserProfiles || {}, dirId) || !cfg.browserProfiles[dirId] || typeof cfg.browserProfiles[dirId] !== "object") {
    throw new ProfileHealthError("PROFILE_NOT_FOUND", "Profile not found");
  }
  if (kind === "network") {
    // statusBrowser can discover/adopt a recovered process. A read-only network
    // lease must never mint runtime authority through that legacy path. Saved
    // proxy intent is deliberately not evidence of this running process's route.
    const runtime = getEntry(dirId);
    const bytes = JSON.stringify({
      configPath: getConfigPath(), deviceId: cfg.deviceId,
      profile: portableProfileContent(cfg.browserProfiles[dirId]),
      engine: runtime?.engine ?? null, pid: runtime?.pid ?? null, port: runtime?.port ?? null,
      stopping: runtime?.stopping === true, launchProxy: getLaunchProxySnapshot(dirId),
      childPid: runtime?.process?.pid ?? null, exitCode: runtime?.process?.exitCode ?? null,
      signalCode: runtime?.process?.signalCode ?? null, killed: runtime?.process?.killed ?? null,
    });
    return createHash("sha256").update(bytes).digest("hex");
  }
  if (kind === "drift" && isRestoreLocked(dirId)) throw new ProfileHealthError("PROFILE_RESTORE_IN_PROGRESS", "Wait for profile data transfer to finish before comparing fingerprints", "unavailable");
  const status = statusBrowser(dirId);
  const bytes = JSON.stringify({
    ...(kind === "drift" ? { dataRevision: getProfileDataRevision(dirId) } : {}),
    configPath: getConfigPath(), deviceId: cfg.deviceId,
    profile: portableProfileContent(cfg.browserProfiles[dirId]),
    proxy: resolveProfileProxy(dirId), launchProxy: getLaunchProxySnapshot(dirId),
    engine: getEntry(dirId)?.engine ?? null,
    running: status.running, pid: status.pid || null, port: status.cdpPort || null,
    unknown: status.unknown === true, stopping: getEntry(dirId)?.stopping === true,
  });
  return createHash("sha256").update(bytes).digest("hex");
}

/** A bounded per-profile lease. Cancellation never releases a still-running probe. */
export function beginProfileHealthRun(dirId: string, kind: ProfileHealthKind, options: ProfileHealthOptions = {}): ProfileHealthRun {
  try { validateDirId(dirId); } catch { throw new ProfileHealthError("HEALTH_INVALID_REQUEST", "Invalid profile identity"); }
  if (!options || typeof options !== "object" || Array.isArray(options)
    || options.signal !== undefined && (typeof options.signal?.aborted !== "boolean" || typeof options.signal?.addEventListener !== "function" || typeof options.signal?.removeEventListener !== "function")) {
    throw new ProfileHealthError("HEALTH_INVALID_REQUEST", "Invalid diagnostic options");
  }
  if (!kinds.has(kind)) throw new ProfileHealthError("HEALTH_INVALID_REQUEST", "Invalid diagnostic kind");
  const requestId = options.requestId ?? randomUUID();
  if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(requestId)
    || options.owner !== undefined && (typeof options.owner !== "string" || !options.owner || options.owner.length > 160)) {
    throw new ProfileHealthError("HEALTH_INVALID_REQUEST", "Invalid diagnostic request identity");
  }
  const initialIdentity = targetIdentity(dirId, kind);
  const initialRuntime = getEntry(dirId);
  const initialBidi = initialRuntime?.bidiConn;
  const initialNetwork = kind === "network" ? {
    child: initialRuntime?.process, bridge: initialRuntime?.proxyBridge,
    pid: initialRuntime?.pid, port: initialRuntime?.port, engine: initialRuntime?.engine,
    launchProxy: initialRuntime?.launchProxy,
  } : undefined;
  if (active.has(dirId) || active.size >= MAX_ACTIVE_HEALTH_RUNS) throw new ProfileHealthError("HEALTH_BUSY", "A diagnostic is still running");
  const controller = new AbortController();
  const entry: ActiveHealthRun = { kind, requestId, owner: options.owner ?? "internal", controller };
  const abort = (code: string) => {
    if (!controller.signal.aborted) { entry.cancelCode = code; controller.abort(); }
  };
  const onAbort = () => abort("HEALTH_CANCELLED");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => abort("HEALTH_TIMEOUT"), HEALTH_DEADLINE_MS);
  timer.unref?.();
  active.set(dirId, entry);
  let finished = false;
  return {
    dirId, kind, requestId, signal: controller.signal,
    assertCurrent() {
      if (controller.signal.aborted) throw new ProfileHealthError(entry.cancelCode || "HEALTH_CANCELLED", "Diagnostic cancelled or its deadline elapsed", "cancelled");
      if (active.get(dirId) !== entry || finished) throw new ProfileHealthError("HEALTH_CANCELLED", "Diagnostic no longer owns its result", "cancelled");
      if (getEntry(dirId) !== initialRuntime || (initialNetwork
        ? initialRuntime?.process !== initialNetwork.child || initialRuntime?.proxyBridge !== initialNetwork.bridge
          || initialRuntime?.pid !== initialNetwork.pid || initialRuntime?.port !== initialNetwork.port
          || initialRuntime?.engine !== initialNetwork.engine || initialRuntime?.launchProxy !== initialNetwork.launchProxy
        : initialRuntime?.bidiConn !== initialBidi)) {
        throw new ProfileHealthError("HEALTH_PROFILE_CHANGED", "Browser session changed while the diagnostic was running", "cancelled");
      }
      let current: string;
      try { current = targetIdentity(dirId, kind); } catch { throw new ProfileHealthError("HEALTH_PROFILE_CHANGED", "Profile changed while the diagnostic was running", "cancelled"); }
      if (current !== initialIdentity) throw new ProfileHealthError("HEALTH_PROFILE_CHANGED", "Profile changed while the diagnostic was running", "cancelled");
    },
    finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (active.get(dirId) === entry) active.delete(dirId);
    },
  };
}

export function cancelProfileHealthRun(dirId: string, options: { kind: ProfileHealthKind; requestId: string; owner?: string }): { success: boolean; cancelled: boolean; code?: string } {
  validateDirId(dirId);
  const current = active.get(dirId);
  if (!current || current.kind !== options?.kind || current.requestId !== options?.requestId || current.owner !== (options.owner ?? "internal")) {
    // The network bridge publishes a closed vocabulary. Keep the established
    // ownership-refusal code unchanged for every pre-existing diagnostic kind.
    return { success: false, cancelled: false, code: options?.kind === "network" ? "HEALTH_INVALID_REQUEST" : "HEALTH_NOT_OWNED" };
  }
  if (!current.controller.signal.aborted) {
    current.cancelCode = "HEALTH_CANCELLED";
    current.controller.abort();
  }
  return { success: true, cancelled: true };
}

/** Clearing invalidates the owning run before removing both detailed and summary facts. */
export function clearProfileHealthHistory(dirId: string, kind?: ProfileHealthKind): void {
  validateDirId(dirId);
  if (kind !== undefined && !kinds.has(kind)) throw new ProfileHealthError("HEALTH_INVALID_REQUEST", "Invalid diagnostic kind");
  if (kind === undefined || kind === "drift") clearFingerprintComparison(dirId);
  clearProfileHealthRecords(dirId, kind);
}
export function recordProfileHealthResult(dirId: string, entry: ProfileHealthEntry): void {
  appendProfileHealthResult(dirId, entry);
}

/** Old raw records remain readable, but missing completion evidence cannot be upgraded to pass. */
export function listProfileHealthHistory(dirId: string): ProfileHealthEntry[] {
  validateDirId(dirId);
  const entries = getProfileHealthHistory(dirId);
  const seen = new Set(entries.map((entry) => `${entry.kind}:${entry.at}`));
  for (const entry of getWebRtcDiagnostics(dirId)) {
    if (!entry || !Number.isSafeInteger(entry.at) || seen.has(`webrtc:${entry.at}`)) continue;
    entries.push({ kind: "webrtc", at: entry.at, outcome: Array.isArray(entry.hostIps) && entry.hostIps.length ? "risk" : "inconclusive",
      summary: String(entry.summary || "").slice(0, 2048), source: "legacy" });
  }
  for (const entry of getEnvRiskDiagnostics(dirId)) {
    if (!entry || !Number.isSafeInteger(entry.at) || seen.has(`env:${entry.at}`)) continue;
    entries.push({ kind: "env", at: entry.at, outcome: entry.high > 0 ? "risk" : entry.medium > 0 ? "warn" : "inconclusive",
      summary: String(entry.summary || "").slice(0, 2048), source: "legacy" });
  }
  return entries.sort((a, b) => a.at - b.at).slice(-20);
}

export function profileHealthFailure(error: unknown, requestId?: string): { ok: false; outcome: ProfileHealthOutcome; code: string; error: string; requestId?: string } {
  const known = error instanceof ProfileHealthError;
  return { ok: false, outcome: known ? error.outcome : "error", code: known ? error.code : "HEALTH_DIAGNOSTIC_FAILED",
    error: error instanceof Error ? error.message : String(error), ...(requestId ? { requestId } : {}) };
}

export function environmentHealthOutcome(result: EnvironmentRiskResult, runtime: boolean): ProfileHealthOutcome {
  if (result.findings.some((finding) => finding.severity === "high")) return "risk";
  if (result.findings.some((finding) => finding.severity === "medium")) return "warn";
  if (!runtime || !result.raf || result.raf.samples < 1 || !result.resolvers.length || result.proxy.mode === "unknown"
    || result.findings.some((finding) => /(?:unknown|unavailable|unmeasurable)$/.test(finding.code))) return "inconclusive";
  return "pass";
}

export async function runProfileEnvironmentRisk(dirId: string, options: ProfileHealthOptions = {}): Promise<ProfileEnvironmentRiskRunResult> {
  let run: ProfileHealthRun | undefined;
  try {
    run = beginProfileHealthRun(dirId, "env", options);
    run.assertCurrent();
    const meta = getConfig().browserProfiles[dirId];
    const profile = { timezone: meta.timezone, locale: meta.locale, platform: meta.platform };
    const status = statusBrowser(dirId);
    const runtime = Boolean(status.running && status.cdpPort);
    const runtimeEntry = getEntry(dirId);
    const launchedProxy = runtime && runtimeEntry?.pid === status.pid && runtimeEntry.port === status.cdpPort ? getLaunchProxySnapshot(dirId) : null;
    const proxy = runtime
      ? launchedProxy ? { mode: launchedProxy.mode, config: launchedProxy.type ? { type: launchedProxy.type } : null } : null
      : resolveProfileProxy(dirId);
    const engine = runtimeEntry ? runtimeEntry.engine ?? "chromium" : sanitizeBrowserEngine(meta.engine);
    const result = runtime
      ? await checkEnvironmentRiskRuntime(profile, status.cdpPort!, { proxy, signal: run.signal }, engine)
      : checkEnvironmentRisk(profile, { proxy });
    result.proxy.source = runtime ? launchedProxy?.source ?? "unknown" : "configured";
    if (runtime && !launchedProxy) result.findings.push({ severity: "info", code: "runtime-proxy-unavailable",
      message: tMain("health.env.runtime-proxy-unavailable", "This running process has no verified launch proxy snapshot; current settings are not evidence of its active route."),
      fix: tMain("health.env.runtime-proxy-retry", "Restart the profile through its normal launch flow before checking the launch configuration again.") });
    run.assertCurrent();
    const outcome = environmentHealthOutcome(result, runtime);
    result.outcome = outcome;
    const source = runtime ? "runtime" : "host";
    const entry: EnvRiskDiagnosticsEntry = {
      at: Date.now(), ok: result.ok, outcome, requestId: run.requestId, source,
      high: result.findings.filter((finding) => finding.severity === "high").length,
      medium: result.findings.filter((finding) => finding.severity === "medium").length,
      summary: summarizeEnvFindings(result.findings) || tMain(outcome === "pass" ? "health.env.no-findings" : "health.env.inconclusive",
        outcome === "pass" ? "No risk signals found in the completed checks" : "Some environment checks were not verified"),
      findings: result.findings.slice(0, 50).map((finding) => ({ ...finding })),
      resolvers: result.resolvers.map((resolver) => resolver.address), cnFonts: result.cnFonts,
    };
    setEnvRiskDiagnostics(dirId, [...getEnvRiskDiagnostics(dirId), entry], {
      kind: "env", at: entry.at, outcome, summary: entry.summary, requestId: run.requestId, source,
    });
    return { ok: outcome === "pass" || outcome === "warn" || outcome === "risk", outcome, requestId: run.requestId, result };
  } catch (error) {
    let failure = error;
    if (run) {
      try { run.assertCurrent(); } catch (current) { failure = current; }
    }
    return profileHealthFailure(failure, run?.requestId ?? options?.requestId);
  } finally {
    run?.finish();
  }
}
