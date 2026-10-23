import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { getConfig, onProfileHealthRecordsCleared } from "./config-manager.js";
import { getEntry, runningProcesses, type RunningEntry } from "./browser/runtime-table.js";
import { listNetworkPageTargets, createNetworkPageObserver } from "./browser/cdp-network-observer.js";
import {
  NETWORK_OBSERVATION_LIMITS, normalizeNetworkObservationSummary,
  type NetworkObservationSummary, type NetworkObservationPayload,
  type ObservedNetworkHop, type NetworkHttpStatusEvidence,
} from "./network-diagnostics-contract.js";
import {
  beginProfileHealthRun, recordProfileHealthResult, ProfileHealthError,
  type ProfileHealthOptions, type ProfileHealthRun,
} from "./profile-health.js";
import { validateDirId } from "./utils.js";
import type {
  ProfileHealthOutcome, ProfileNetworkPage, ProfileNetworkPagesResult,
  ProfileNetworkObservationResult, ProfileNetworkArmedEvent,
} from "../types.js";

export interface ProfileNetworkObservationOptions extends ProfileHealthOptions {
  selection: string;
  onArmed?: (event: ProfileNetworkArmedEvent) => void;
}
type PageTarget = Awaited<ReturnType<typeof listNetworkPageTargets>>[number];
type ObserverHandle = Awaited<ReturnType<typeof createNetworkPageObserver>>;
interface OwnedRuntime {
  readonly dirId: string;
  readonly port: number;
  readonly assertCurrent: () => void;
}
interface PageSelection {
  readonly owner: string;
  readonly runtime: OwnedRuntime;
  readonly target: PageTarget;
  readonly expiresAt: number;
}
const selections = new Map<string, PageSelection>();
const SELECTION_TTL_MS = 30_000;
const MAX_PAGES = 32;
const MAX_SELECTIONS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const SAFE_CODES = new Set([
  "PROFILE_NOT_FOUND", "HEALTH_INVALID_REQUEST", "HEALTH_BUSY", "HEALTH_CANCELLED", "HEALTH_TIMEOUT", "HEALTH_PROFILE_CHANGED",
  "HEALTH_HISTORY_WRITE_FAILED", "NETWORK_RUNTIME_UNAVAILABLE", "NETWORK_ENGINE_UNSUPPORTED", "NETWORK_SELECTION_STALE",
  "NETWORK_SELECTION_LIMIT", "NETWORK_SETUP_TIMEOUT", "NETWORK_PROTOCOL_INVALID", "NETWORK_OBSERVATION_FAILED",
]);

function failure(code: string, outcome: ProfileHealthOutcome = "error"): ProfileHealthError {
  return new ProfileHealthError(code, code, outcome);
}
function invalid(): never { throw failure("HEALTH_INVALID_REQUEST"); }
function dataRecord(value: unknown, allowed?: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string" && (!allowed || allowed.includes(key))
      && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
  } catch { return false; }
}
function validateProfile(dirId: string): void {
  if (typeof dirId !== "string") invalid();
  try { validateDirId(dirId); } catch { invalid(); }
  const profiles = getConfig().browserProfiles;
  if (!Object.hasOwn(profiles || {}, dirId) || !profiles[dirId] || typeof profiles[dirId] !== "object") {
    throw failure("PROFILE_NOT_FOUND", "unavailable");
  }
}
function validateOptions(options: ProfileHealthOptions, extra: readonly string[] = []): void {
  if (!dataRecord(options, ["requestId", "owner", "signal", ...extra])) invalid();
  if (options.requestId !== undefined && (typeof options.requestId !== "string" || !REQUEST_ID.test(options.requestId))) invalid();
  if (options.owner !== undefined && (typeof options.owner !== "string" || !options.owner || options.owner.length > 160)) invalid();
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) invalid();
}
function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw failure("HEALTH_CANCELLED", "cancelled");
}
function hasUniquePort(dirId: string, port: number): boolean {
  for (const [otherId, entry] of runningProcesses) if (otherId !== dirId && entry.port === port) return false;
  return true;
}
function childIsLive(entry: RunningEntry, child: ChildProcess, pid: number): boolean {
  if (entry.stopping || child.pid !== pid || child.exitCode !== null || child.signalCode !== null || child.killed !== false) return false;
  try { return process.kill(pid, 0) === true; } catch { return false; }
}

/** Cache-only authority. Never call statusBrowser/getRuntime or adopt a PID. */
function captureOwnedRuntime(dirId: string): OwnedRuntime {
  validateProfile(dirId);
  const entry = getEntry(dirId);
  if (!entry) throw failure("NETWORK_RUNTIME_UNAVAILABLE", "unavailable");
  const child = entry.process;
  const { pid, port, engine, proxyBridge: bridge, launchProxy } = entry;
  if (!(child instanceof ChildProcess) || !Number.isSafeInteger(pid) || pid < 1 || !Number.isInteger(port) || port < 1 || port > 65535
    || !launchProxy || launchProxy.source !== "fresh-launch" || !["none", "default", "named"].includes(launchProxy.mode)
    || launchProxy.type !== undefined && !["http", "socks5", "socks5h"].includes(launchProxy.type)
    || bridge !== undefined && (!bridge || typeof bridge.close !== "function")
    || !hasUniquePort(dirId, port) || !childIsLive(entry, child, pid)) {
    throw failure("NETWORK_RUNTIME_UNAVAILABLE", "unavailable");
  }
  // Missing/unknown engine is unverified ownership, not Firefox support proof.
  if (engine !== "chromium" && engine !== "firefox") throw failure("NETWORK_RUNTIME_UNAVAILABLE", "unavailable");
  if (engine === "firefox") throw failure("NETWORK_ENGINE_UNSUPPORTED", "unavailable");
  // Pin references AND scalars now, before enumeration's first await. In-place
  // mutation of an entry/receipt cannot silently change the dispatch authority.
  const mode = launchProxy.mode;
  const type = launchProxy.type;
  return Object.freeze({ dirId, port, assertCurrent() {
    if (getEntry(dirId) !== entry || entry.process !== child || entry.pid !== pid || entry.port !== port || entry.engine !== engine
      || entry.proxyBridge !== bridge || entry.launchProxy !== launchProxy || launchProxy.source !== "fresh-launch"
      || launchProxy.mode !== mode || launchProxy.type !== type || !hasUniquePort(dirId, port) || !childIsLive(entry, child, pid)) {
      throw failure("HEALTH_PROFILE_CHANGED", "cancelled");
    }
    try { validateProfile(dirId); } catch { throw failure("HEALTH_PROFILE_CHANGED", "cancelled"); }
  } });
}
function sweepSelections(): void {
  const now = Date.now();
  for (const [handle, selected] of selections) {
    if (selected.expiresAt <= now) { selections.delete(handle); continue; }
    try { selected.runtime.assertCurrent(); } catch { selections.delete(handle); }
  }
}
let clearSubscribed = false;
function subscribeToClear(): void {
  if (clearSubscribed) return;
  onProfileHealthRecordsCleared((dirId, kind) => {
    if (kind !== undefined && kind !== "network") return;
    for (const [handle, selected] of selections) if (selected.runtime.dirId === dirId) selections.delete(handle);
  });
  clearSubscribed = true;
}

function safeOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
function projectTarget(target: PageTarget, port: number): PageTarget {
  if (!dataRecord(target, ["id", "origin", "webSocketDebuggerUrl"]) || typeof target.id !== "string" || !target.id || target.id.length > 1024
    || !safeOrigin(target.origin) || typeof target.webSocketDebuggerUrl !== "string" || target.webSocketDebuggerUrl.length > 4096) {
    throw failure("NETWORK_PROTOCOL_INVALID");
  }
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const loopback = isIP(hostname) === 4 ? hostname.startsWith("127.") : isIP(hostname) === 6 && hostname === "::1";
    if (url.protocol !== "ws:" || !loopback || Number(url.port) !== port || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith("/devtools/page/") || decodeURIComponent(url.pathname.slice("/devtools/page/".length)) !== target.id) {
      throw failure("NETWORK_PROTOCOL_INVALID");
    }
  } catch { throw failure("NETWORK_PROTOCOL_INVALID"); }
  return Object.freeze({ id: target.id, origin: target.origin, webSocketDebuggerUrl: target.webSocketDebuggerUrl });
}
function projectTargets(targets: PageTarget[], port: number): PageTarget[] {
  if (!Array.isArray(targets)) throw failure("NETWORK_PROTOCOL_INVALID");
  const result = targets.slice(0, MAX_PAGES).map(target => projectTarget(target, port));
  if (new Set(result.map(target => target.id)).size !== result.length) throw failure("NETWORK_PROTOCOL_INVALID");
  return result;
}

/** One setup clock, followed by the observer-owned armed/cleanup clocks. */
function requestScope(runtime: OwnedRuntime, signal: AbortSignal | undefined, run?: ProfileHealthRun) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadline = startedAt + NETWORK_OBSERVATION_LIMITS.setupMs;
  let preparing = true;
  let setupExpired = false;
  let callbackFailed = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { if (preparing) { setupExpired = true; controller.abort(); } }, NETWORK_OBSERVATION_LIMITS.setupMs);
  timer.unref?.();
  const assertCurrent = () => {
    run?.assertCurrent();
    if (setupExpired || preparing && Date.now() >= deadline) throw failure("NETWORK_SETUP_TIMEOUT", "unavailable");
    if (callbackFailed) throw failure("HEALTH_CANCELLED", "cancelled");
    assertNotAborted(controller.signal);
    runtime.assertCurrent();
  };
  return { startedAt, deadline, signal: controller.signal, assertCurrent,
    armed() { preparing = false; clearTimeout(timer); },
    callbackFailed() { callbackFailed = true; controller.abort(); },
    dispose() { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
  };
}
function safeFailure(error: unknown): { code: string; outcome: ProfileHealthOutcome } {
  return error instanceof ProfileHealthError && SAFE_CODES.has(error.code)
    ? { code: error.code, outcome: error.outcome }
    : { code: "NETWORK_OBSERVATION_FAILED", outcome: "error" };
}
function emptyObservation(code: string): NetworkObservationSummary {
  // Without a validated collector stop there is no measured window to report.
  // This is an unavailable result at reply time, never an estimate from arming
  // through cleanup. Actual observation timing comes only from projectPayload.
  return {
    version: 1, completion: code === "HEALTH_CANCELLED" ? "cancelled" : "unavailable",
    stopReason: code === "HEALTH_PROFILE_CHANGED" ? "target-changed" : code === "HEALTH_TIMEOUT" ? "deadline"
      : code === "HEALTH_CANCELLED" ? "cancelled" : code === "NETWORK_SETUP_TIMEOUT" ? "setup-timeout"
        : code === "NETWORK_PROTOCOL_INVALID" ? "protocol-invalid" : "setup-rejected",
    armedAt: null, endedAt: Date.now(), durationMs: 0,
    counts: { requests: 0, hops: 0, responses: 0, finished: 0, failed: 0, blocked: 0, requestCancelled: 0, redirects: 0, http4xx: 0, http5xx: 0, pending: 0, cache: 0, serviceWorker: 0, unattributed: 0, cspIssues: 0 },
    coverage: { network: "unavailable", csp: "unavailable", worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" },
  };
}
const HOP_KEYS = ["id", "chainId", "redirectedFrom", "origin", "method", "resourceType", "status", "networkStatus", "terminal", "errorCode", "blockedReason", "corsReason", "fromDiskCache", "fromServiceWorker", "fromPrefetchCache", "servedFromCache"] as const;
const STATUS_KEYS = ["id", "chainId", "hopId", "status", "source", "association"] as const;
function projectPayload(raw: NetworkObservationPayload): NetworkObservationPayload {
  if (!dataRecord(raw, ["observation", "hops", "httpStatusEvidence"])) throw failure("NETWORK_PROTOCOL_INVALID");
  const observation = normalizeNetworkObservationSummary(raw.observation);
  if (!observation || !Array.isArray(raw.hops) || !Array.isArray(raw.httpStatusEvidence)
    || raw.hops.length !== observation.counts.hops || raw.hops.length > NETWORK_OBSERVATION_LIMITS.maxHops
    || raw.hops.length + raw.httpStatusEvidence.length > NETWORK_OBSERVATION_LIMITS.maxProjections) throw failure("NETWORK_PROTOCOL_INVALID");
  // The dedicated observer owns enum/ingestion validation. Re-project its shared
  // typed detail shape so aliases/raw fields cannot become a second wire API.
  const hops: ObservedNetworkHop[] = raw.hops.map(hop => {
    if (!dataRecord(hop, HOP_KEYS) || HOP_KEYS.some(key => !Object.hasOwn(hop, key)) || !safeOrigin(hop.origin)) throw failure("NETWORK_PROTOCOL_INVALID");
    return { id: hop.id, chainId: hop.chainId, redirectedFrom: hop.redirectedFrom, origin: hop.origin, method: hop.method, resourceType: hop.resourceType,
      status: hop.status, networkStatus: hop.networkStatus, terminal: hop.terminal, errorCode: hop.errorCode, blockedReason: hop.blockedReason, corsReason: hop.corsReason,
      fromDiskCache: hop.fromDiskCache, fromServiceWorker: hop.fromServiceWorker, fromPrefetchCache: hop.fromPrefetchCache, servedFromCache: hop.servedFromCache };
  });
  const httpStatusEvidence: NetworkHttpStatusEvidence[] = raw.httpStatusEvidence.map(evidence => {
    if (!dataRecord(evidence, STATUS_KEYS) || STATUS_KEYS.some(key => !Object.hasOwn(evidence, key))) throw failure("NETWORK_PROTOCOL_INVALID");
    return { id: evidence.id, chainId: evidence.chainId, hopId: evidence.hopId, status: evidence.status, source: evidence.source, association: evidence.association };
  });
  if (Buffer.byteLength(JSON.stringify({ hops, httpStatusEvidence }), "utf8") > NETWORK_OBSERVATION_LIMITS.maxDetailBytes) throw failure("NETWORK_PROTOCOL_INVALID");
  return { observation, hops, httpStatusEvidence };
}
function observationOutcome(observation: NetworkObservationSummary): ProfileHealthOutcome {
  if (observation.completion === "cancelled") return "cancelled";
  if (observation.completion === "unavailable") return "unavailable";
  if (observation.completion === "partial") return "inconclusive";
  const { counts } = observation;
  if (counts.failed || counts.blocked || counts.http5xx) return "risk";
  if (counts.http4xx || counts.cspIssues || counts.requestCancelled) return "warn";
  return "inconclusive";
}

/** Listing is a read, not an observation, health sample, or launch request. */
export async function listProfileNetworkPages(dirId: string, options: ProfileHealthOptions = {}): Promise<ProfileNetworkPagesResult> {
  let scope: ReturnType<typeof requestScope> | undefined;
  try {
    validateOptions(options); assertNotAborted(options.signal); subscribeToClear();
    const runtime = captureOwnedRuntime(dirId);
    scope = requestScope(runtime, options.signal);
    scope.assertCurrent();
    const raw = await listNetworkPageTargets(runtime.port, { signal: scope.signal, assertCurrent: scope.assertCurrent, deadline: scope.deadline });
    scope.assertCurrent();
    const targets = projectTargets(raw, runtime.port);
    sweepSelections();
    if (selections.size + targets.length > MAX_SELECTIONS) throw failure("NETWORK_SELECTION_LIMIT", "unavailable");
    const pages: ProfileNetworkPage[] = targets.map((target, index) => {
      let handle: string;
      do { handle = randomUUID(); } while (selections.has(handle));
      selections.set(handle, { owner: options.owner ?? "internal", runtime, target, expiresAt: Date.now() + SELECTION_TTL_MS });
      return { handle, origin: target.origin, ordinal: index + 1 };
    });
    return { ok: true, pages };
  } catch (error) {
    const safe = safeFailure(error);
    return { ok: false, pages: [], code: safe.code, outcome: safe.outcome };
  } finally { scope?.dispose(); }
}

/** One awaited, selected-page observation; internal owned handles never cross IPC. */
export async function runProfileNetworkObservation(dirId: string, options: ProfileNetworkObservationOptions): Promise<ProfileNetworkObservationResult> {
  let requestId: string = randomUUID();
  let run: ProfileHealthRun | undefined;
  let runtime: OwnedRuntime | undefined;
  let scope: ReturnType<typeof requestScope> | undefined;
  let observer: ObserverHandle | undefined;
  let closed: Promise<boolean> | undefined;
  let cleanupComplete = false;
  let armedAt: number | null = null;
  let observed: NetworkObservationPayload | undefined;
  try {
    validateOptions(options, ["selection", "onArmed"]);
    if (typeof options.selection !== "string" || !UUID.test(options.selection) || options.onArmed !== undefined && typeof options.onArmed !== "function") invalid();
    requestId = options.requestId ?? requestId;
    assertNotAborted(options.signal); subscribeToClear();
    // Classify today's actual runtime before looking up a handle from an older
    // listing. Unowned/recovered cases must not masquerade as engine support.
    captureOwnedRuntime(dirId);
    sweepSelections();
    const selected = selections.get(options.selection);
    if (!selected || selected.owner !== (options.owner ?? "internal") || selected.runtime.dirId !== dirId || selected.expiresAt <= Date.now()) {
      throw failure("NETWORK_SELECTION_STALE", "unavailable");
    }
    runtime = selected.runtime;
    runtime.assertCurrent();
    run = beginProfileHealthRun(dirId, "network", { requestId, owner: options.owner, signal: options.signal });
    // Consume only after acquiring this request's lease, but before any await.
    selections.delete(options.selection);
    scope = requestScope(runtime, run.signal, run);
    scope.assertCurrent();
    const raw = await listNetworkPageTargets(runtime.port, { signal: scope.signal, assertCurrent: scope.assertCurrent, deadline: scope.deadline });
    scope.assertCurrent();
    const target = projectTargets(raw, runtime.port).find(target => target.id === selected.target.id && target.origin === selected.target.origin
      && target.webSocketDebuggerUrl === selected.target.webSocketDebuggerUrl);
    if (!target) throw failure("NETWORK_SELECTION_STALE", "unavailable");
    const currentScope = scope;
    observer = await createNetworkPageObserver(runtime.port, target, { signal: scope.signal, assertCurrent: scope.assertCurrent, deadline: scope.deadline,
      onArmed(event) {
        try {
          currentScope.assertCurrent();
          if (armedAt !== null) return;
          if (!dataRecord(event, ["armedAt", "observeForMs"]) || !Number.isSafeInteger(event.armedAt)
            || event.armedAt < currentScope.startedAt || event.armedAt > Date.now() || event.armedAt >= currentScope.deadline
            || event.observeForMs !== 10_000) throw failure("NETWORK_PROTOCOL_INVALID");
          armedAt = event.armedAt;
          currentScope.armed();
          options.onArmed?.({ dirId, requestId, armedAt, observeForMs: 10_000 });
        } catch { currentScope.callbackFailed(); }
      },
    });
    // A resolved result does not prove that its owned transport closed. Observe
    // the separate promise and keep the health lease until that actual proof.
    closed = observer.closed.then(() => { cleanupComplete = true; return true; }, () => false);
    let currentFailure: unknown;
    try { scope.assertCurrent(); } catch (error) { currentFailure = error; }
    // Even after cancellation/replacement, await this owned observer exactly
    // once. Its validated stop time excludes cleanup; the reply-time clock does
    // not. Guards are still rechecked immediately after each await, but their
    // failure is returned only after preserving any genuine safe payload.
    const rawResult = await observer.result;
    try { scope.assertCurrent(); } catch (error) { currentFailure = error; }
    const result = projectPayload(rawResult);
    if (result.observation.armedAt !== armedAt) throw failure("NETWORK_PROTOCOL_INVALID");
    observed = result;
    if (currentFailure) throw currentFailure;
    scope.armed();
    if (!cleanupComplete || !observer.cleanupVerified || result.observation.stopReason === "cleanup-unverified") {
      const observation: NetworkObservationSummary = { ...result.observation,
        completion: armedAt === null ? "unavailable" : "partial", stopReason: "cleanup-unverified",
        coverage: { ...result.observation.coverage, network: armedAt === null ? "unavailable" : "partial" } };
      return { ok: false, outcome: observationOutcome(observation), requestId, ...result, observation };
    }
    const outcome = observationOutcome(result.observation);
    if (result.observation.completion !== "cancelled") {
      scope.assertCurrent();
      try {
        recordProfileHealthResult(dirId, { kind: "network", at: result.observation.endedAt, outcome, source: "runtime", requestId,
          summary: "NETWORK_OBSERVATION_V1", networkSummary: result.observation });
      } catch {
        // The finite observation remains a fact even when its summary could not
        // be saved. Do not replace observed responses with an empty window.
        return { ok: false, outcome: "error", requestId, ...result, code: "HEALTH_HISTORY_WRITE_FAILED" };
      }
    }
    return { ok: result.observation.completion === "completed", outcome, requestId, ...result };
  } catch (error) {
    let cause = error;
    if (scope) { try { scope.assertCurrent(); } catch (current) { cause = current; } }
    else if (run) { try { run.assertCurrent(); } catch (current) { cause = current; } }
    const safe = safeFailure(cause);
    if (observed) return { ok: false, outcome: safe.outcome, requestId, ...observed, code: safe.code };
    return { ok: false, outcome: safe.outcome, requestId, observation: emptyObservation(safe.code), hops: [], httpStatusEvidence: [], code: safe.code };
  } finally {
    const finish = () => { scope?.dispose(); run?.finish(); };
    if (observer && closed) {
      // Never append on this deferred path. Rejection is not cleanup proof, so
      // an unverified transport deliberately retains its already-aborted lease.
      void closed.then(verified => { if (verified) finish(); });
    } else finish();
  }
}
