import * as http from "node:http";
import { isIP } from "node:net";
import WebSocket, { type RawData } from "ws";
import {
  NETWORK_OBSERVATION_LIMITS as LIMITS,
  type NetworkObservationPayload, type NetworkObservationSummary, type NetworkObservationStopReason,
  type NetworkCoverage, type NetworkCounts, type ObservedNetworkHop, type NetworkHttpStatusEvidence,
  type NetworkRequestMethod, type NetworkResourceType, type NetworkNativeErrorCode,
  type NetworkBlockedReason, type NetworkCorsReason,
} from "../network-diagnostics-contract.js";

export interface NetworkPageTarget { id: string; origin: string; webSocketDebuggerUrl: string }
export interface NetworkPageOptions { signal?: AbortSignal; assertCurrent: () => void; deadline: number }
export interface NetworkPageObserverOptions extends NetworkPageOptions {
  onArmed?: (notice: { armedAt: number; observeForMs: 10000 }) => void;
}
export interface NetworkPageObserverHandle {
  result: Promise<NetworkObservationPayload>;
  closed: Promise<void>;
  readonly cleanupVerified: boolean;
}

// These are static protocol vocabularies, never patterns accepting arbitrary
// ERR_* or other page-controlled strings. Unknown values become an explicit OTHER.
const METHODS: readonly NetworkRequestMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "OTHER"];
const RESOURCE_TYPES: readonly NetworkResourceType[] = ["Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket", "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "FedCM", "Other"];
const ERROR_CODES: readonly NetworkNativeErrorCode[] = [
  "ERR_FAILED", "ERR_ABORTED", "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_ABORTED", "ERR_CONNECTION_FAILED", "ERR_NAME_NOT_RESOLVED", "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_CHANGED", "ERR_ADDRESS_UNREACHABLE", "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_PROXY_AUTH_UNSUPPORTED", "ERR_INVALID_AUTH_CREDENTIALS", "ERR_NO_SUPPORTED_PROXIES", "ERR_SOCKS_CONNECTION_FAILED", "ERR_SOCKS_CONNECTION_HOST_UNREACHABLE", "ERR_BLOCKED_BY_CLIENT", "ERR_BLOCKED_BY_RESPONSE", "ERR_BLOCKED_BY_CSP", "ERR_ACCESS_DENIED", "ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_COMMON_NAME_INVALID", "ERR_CERT_DATE_INVALID", "ERR_CERT_INVALID", "ERR_SSL_PROTOCOL_ERROR", "ERR_HTTP2_PROTOCOL_ERROR", "ERR_QUIC_PROTOCOL_ERROR", "ERR_EMPTY_RESPONSE", "ERR_CONTENT_LENGTH_MISMATCH", "ERR_INCOMPLETE_CHUNKED_ENCODING", "ERR_TOO_MANY_REDIRECTS", "ERR_UNSAFE_REDIRECT", "ERR_INVALID_RESPONSE", "OTHER",
];
const BLOCKED_REASONS: readonly NetworkBlockedReason[] = ["other", "csp", "mixed-content", "origin", "inspector", "integrity", "subresource-filter", "content-type", "coep-frame-resource-needs-coep-header", "coop-sandboxed-iframe-cannot-navigate-to-coop-page", "corp-not-same-origin", "corp-not-same-origin-after-defaulted-to-same-origin-by-coep", "corp-not-same-origin-after-defaulted-to-same-origin-by-dip", "corp-not-same-origin-after-defaulted-to-same-origin-by-coep-and-dip", "corp-not-same-site", "sri-message-signature-mismatch", "OTHER"];
const CORS_REASONS: readonly NetworkCorsReason[] = ["DisallowedByMode", "InvalidResponse", "WildcardOriginNotAllowed", "MissingAllowOriginHeader", "MultipleAllowOriginValues", "InvalidAllowOriginValue", "AllowOriginMismatch", "InvalidAllowCredentials", "CorsDisabledScheme", "PreflightInvalidStatus", "PreflightDisallowedRedirect", "PreflightWildcardOriginNotAllowed", "PreflightMissingAllowOriginHeader", "PreflightMultipleAllowOriginValues", "PreflightInvalidAllowOriginValue", "PreflightAllowOriginMismatch", "PreflightInvalidAllowCredentials", "PreflightMissingAllowExternal", "PreflightInvalidAllowExternal", "InvalidAllowMethodsPreflightResponse", "InvalidAllowHeadersPreflightResponse", "MethodDisallowedByPreflightResponse", "HeaderDisallowedByPreflightResponse", "RedirectContainsCredentials", "InsecureLocalNetwork", "InvalidLocalNetworkAccess", "NoCorsRedirectModeNotFollow", "LocalNetworkAccessPermissionDenied", "OTHER"];

class ObserverFailure extends Error {
  constructor(readonly reason: NetworkObservationStopReason) {
    super(`NETWORK_OBSERVER_${reason.replace(/-/g, "_").toUpperCase()}`);
    this.name = "NetworkObserverError";
  }
}
function fail(reason: NetworkObservationStopReason): never { throw new ObserverFailure(reason); }
function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("protocol-invalid");
  return raw as Record<string, unknown>;
}
function nativeId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1_024) fail("protocol-invalid");
  return raw;
}
function portAllowed(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}
function setupDeadline(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) fail("setup-rejected");
  const deadline = Math.min(raw, Date.now() + LIMITS.setupMs);
  if (deadline <= Date.now()) fail("setup-timeout");
  return deadline;
}
function current(options: NetworkPageOptions): void {
  if (options.signal?.aborted) fail("cancelled");
  try { options.assertCurrent(); }
  catch { fail("target-changed"); }
  // A guard can itself cancel the operation without throwing.
  if (options.signal?.aborted) fail("cancelled");
}
function httpOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") fail("protocol-invalid");
  let url: URL;
  try { url = new URL(raw); }
  catch { fail("protocol-invalid"); }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname && url.origin !== "null" ? url.origin : null;
}
function socketEndpoint(raw: unknown, port: number, id: string): string {
  if (typeof raw !== "string") fail("setup-rejected");
  let url: URL;
  try { url = new URL(raw); }
  catch { fail("setup-rejected"); }
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const loopback = isIP(hostname) === 4 ? hostname.startsWith("127.") : isIP(hostname) === 6 && hostname === "::1";
  const effectivePort = url.port === "" ? 80 : Number(url.port);
  if (!loopback || url.protocol !== "ws:" || effectivePort !== port || url.username || url.password || url.search || url.hash || url.pathname !== `/devtools/page/${id}`) fail("setup-rejected");
  // Check the original too: WHATWG normalization must not bless x/../target,
  // encoded separators, alternate authority spellings, or decorated endpoints.
  // Only the explicit/default spellings of ws port80 are equivalent here.
  const explicit = `ws://${url.hostname}:${port}/devtools/page/${id}`;
  const implicitDefault = `ws://${url.hostname}/devtools/page/${id}`;
  if (raw !== explicit && (port !== 80 || raw !== implicitDefault)) fail("setup-rejected");
  return raw;
}
function selectedTarget(raw: NetworkPageTarget, port: number): NetworkPageTarget {
  if (raw === null || typeof raw !== "object" || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(raw.id)) fail("setup-rejected");
  let origin: string | null;
  try { origin = httpOrigin(raw.origin); }
  catch { fail("setup-rejected"); }
  if (origin === null || origin !== raw.origin) fail("setup-rejected");
  return { id: raw.id, origin, webSocketDebuggerUrl: socketEndpoint(raw.webSocketDebuggerUrl, port, raw.id) };
}
function status(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 100 || raw > 599) fail("protocol-invalid");
  return raw;
}
function flag(raw: unknown): boolean | null {
  if (raw === undefined) return null;
  if (typeof raw !== "boolean") fail("protocol-invalid");
  return raw;
}
function code(raw: unknown): NetworkNativeErrorCode {
  if (typeof raw !== "string") fail("protocol-invalid");
  return ERROR_CODES.find(candidate => raw === candidate || raw === `net::${candidate}`) ?? "OTHER";
}
function staticReason<T extends string>(raw: unknown, values: readonly T[]): T | "OTHER" | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") fail("protocol-invalid");
  return values.find(candidate => candidate === raw) ?? "OTHER";
}
function emptyCounts(): NetworkCounts {
  return { requests: 0, hops: 0, responses: 0, finished: 0, failed: 0, blocked: 0, requestCancelled: 0, redirects: 0, http4xx: 0, http5xx: 0, pending: 0, cache: 0, serviceWorker: 0, unattributed: 0, cspIssues: 0 };
}

/** Bounded, redirect-refusing discovery on the trusted main-supplied port only. */
export function listNetworkPageTargets(port: number, options: NetworkPageOptions): Promise<NetworkPageTarget[]> {
  return new Promise((resolve, reject) => {
    let request: http.ClientRequest | undefined, response: http.IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    let settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    let deadline: number;
    const check = () => { current(options); if (Date.now() >= deadline) fail("setup-timeout"); };
    const finish = (reason: NetworkObservationStopReason | null, targets?: NetworkPageTarget[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(heartbeat);
      options.signal?.removeEventListener("abort", onAbort);
      chunks.length = 0;
      // These are only this request's HTTP objects; no shared CDP client exists.
      response?.destroy(); request?.destroy();
      if (reason) reject(new ObserverFailure(reason)); else resolve(targets!);
    };
    const checked = () => {
      try { check(); }
      catch (error) { finish(error instanceof ObserverFailure ? error.reason : "setup-rejected"); }
    };
    const onAbort = () => finish("cancelled");
    try {
      if (!portAllowed(port) || typeof options.assertCurrent !== "function") fail("setup-rejected");
      deadline = setupDeadline(options.deadline); check();
      timer = setTimeout(() => finish("setup-timeout"), Math.max(1, deadline - Date.now()));
      heartbeat = setInterval(checked, LIMITS.livenessMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      check(); // final-wire fence, after all listener/timer preparation
      request = http.get(`http://127.0.0.1:${port}/json/list`, { agent: false, headers: { Accept: "application/json" } }, incoming => {
        response = incoming;
        if (settled) { incoming.destroy(); return; }
        try {
          check();
          if (incoming.statusCode !== 200) fail("setup-rejected");
          const advertised = incoming.headers["content-length"];
          if (typeof advertised === "string" && /^\d+$/.test(advertised) && Number(advertised) > LIMITS.maxDiscoveryBytes) fail("limit-exceeded");
        } catch (error) { finish(error instanceof ObserverFailure ? error.reason : "setup-rejected"); return; }
        incoming.on("error", () => finish("connection-closed"));
        incoming.on("aborted", () => finish("connection-closed"));
        incoming.on("close", () => { if (!settled && !incoming.complete) finish("connection-closed"); });
        incoming.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          try {
            check();
            const length = Buffer.byteLength(chunk);
            if (bytes + length > LIMITS.maxDiscoveryBytes) fail("limit-exceeded");
            bytes += length; chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          } catch (error) { finish(error instanceof ObserverFailure ? error.reason : "protocol-invalid"); }
        });
        incoming.on("end", () => {
          if (settled) return;
          try {
            check();
            const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
            chunks.length = 0;
            const list: unknown = JSON.parse(text);
            if (!Array.isArray(list)) fail("protocol-invalid");
            const targets: NetworkPageTarget[] = [], ids = new Set<string>();
            for (const item of list) {
              const row = record(item);
              if (row.type !== "page") continue;
              if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(row.id) || typeof row.url !== "string" || typeof row.webSocketDebuggerUrl !== "string") fail("setup-rejected");
              const origin = httpOrigin(row.url);
              if (origin === null) continue;
              if (ids.has(row.id)) fail("setup-rejected");
              ids.add(row.id);
              targets.push({ id: row.id, origin, webSocketDebuggerUrl: socketEndpoint(row.webSocketDebuggerUrl, port, row.id) });
            }
            check(); // do not accept a late successful decode/projection
            finish(null, targets);
          } catch (error) { finish(error instanceof ObserverFailure ? error.reason : "protocol-invalid"); }
        });
      });
      request.on("error", () => finish("connection-closed"));
    } catch (error) { finish(error instanceof ObserverFailure ? error.reason : "setup-rejected"); }
  });
}

interface Chain {
  id: string;
  hops: ObservedNetworkHop[];
  evidence: NetworkHttpStatusEvidence[];
  fullyObserved: boolean;
  expected: Map<string, boolean>;
}
interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: ObserverFailure) => void;
  project: (raw: unknown) => unknown;
  optional: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One selected-page socket, one bounded observation, no shared connection or job
 * store. The owner must hold its health lease until `closed`, not just `result`.
 */
export function createNetworkPageObserver(port: number, target: NetworkPageTarget, options: NetworkPageObserverOptions): NetworkPageObserverHandle {
  let resolveResult!: (value: NetworkObservationPayload) => void, resolveClosed!: () => void;
  const result = new Promise<NetworkObservationPayload>(resolve => { resolveResult = resolve; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let cleanupVerified = false, resultSettled = false, stopping = false;
  let ws: WebSocket | undefined, selected: NetworkPageTarget, deadline: number;
  let armedAt: number | null = null, rootFrame: string | null = null;
  let setupTimer: ReturnType<typeof setTimeout> | undefined, windowTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined, forceTimer: ReturnType<typeof setTimeout> | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveOpen: (() => void) | undefined, rejectOpen: ((reason: ObserverFailure) => void) | undefined;
  let commandId = 0, localId = 0, projections = 0, unattributed = 0, incomplete = false, detailLimit = false;
  let snapshot: NetworkObservationPayload | undefined;
  const chains = new Map<string, Chain>(), ignored = new Set<string>(), pending = new Map<number, PendingCommand>();
  // Scope-only routing metadata is bounded independently of raw events. It lets
  // later frame proof retract facts that initially had no frame attribution.
  const unknownRoutes = new Map<string, { events: number; evidence: NetworkHttpStatusEvidence[] }>();
  const setupFrames = new Map<string, string>();
  const hops: ObservedNetworkHop[] = [], evidence: NetworkHttpStatusEvidence[] = [];
  const handle: NetworkPageObserverHandle = { result, closed, get cleanupVerified() { return cleanupVerified; } };
  const opaque = (kind: string) => `${kind}-${++localId}`;

  function check(): void {
    if (stopping) fail("connection-closed");
    current(options);
    if (Date.now() >= (armedAt === null ? deadline : armedAt + LIMITS.observeMs)) fail(armedAt === null ? "setup-timeout" : "window-ended");
  }
  function stopped(error: unknown, fallback: NetworkObservationStopReason = "protocol-invalid"): void {
    stop(error instanceof ObserverFailure ? error.reason : fallback);
  }
  function checkHeartbeat(): void { try { check(); } catch (error) { stopped(error); } }
  function onAbort(): void { stop("cancelled"); }
  function fits(nextHops: ObservedNetworkHop[], nextEvidence: NetworkHttpStatusEvidence[]): boolean {
    return Buffer.byteLength(JSON.stringify({ hops: nextHops, httpStatusEvidence: nextEvidence })) <= LIMITS.maxDetailBytes;
  }
  function projected(): void {
    projections++;
    if (projections >= LIMITS.maxProjections || hops.length >= LIMITS.maxHops) stop("limit-exceeded");
  }
  function unknownRoute(id: string) {
    let route = unknownRoutes.get(id);
    if (!route) {
      if (unknownRoutes.size >= LIMITS.maxProjections) { stop("limit-exceeded"); return undefined; }
      route = { events: 0, evidence: [] }; unknownRoutes.set(id, route);
    }
    return route;
  }
  function unknown(id: string): void {
    const route = unknownRoute(id); if (!route) return;
    route.events++; unattributed++; projected();
    // Incompleteness is derived from the remaining unattributed facts at stop,
    // not a sticky flag that survives proof that this request was out of scope.
  }
  function ignore(id: string): void {
    // A foreign-frame event cannot poison an already admitted main-frame chain.
    if (chains.has(id)) return;
    const route = unknownRoutes.get(id);
    if (route) {
      const discarded = new Set(route.evidence);
      for (let index = evidence.length - 1; index >= 0; index--) if (discarded.has(evidence[index])) evidence.splice(index, 1);
      unattributed -= route.events;
      projections -= route.events + route.evidence.length;
      unknownRoutes.delete(id);
    }
    // Retract proved child facts even when retaining one more scope identity
    // would hit the routing bound; a limit never licenses foreign counters.
    if (ignored.size >= LIMITS.maxProjections && !ignored.has(id)) { stop("limit-exceeded"); return; }
    ignored.add(id);
  }
  function setupScope(value: Record<string, unknown>): void {
    const id = value.requestId;
    if (typeof id !== "string" || id.length === 0 || id.length > 1_024) return;
    if (value.loaderId === "") { ignore(id); return; }
    const frame = value.frameId;
    if (typeof frame !== "string" || frame.length === 0 || frame.length > 1_024) return;
    if (rootFrame !== null) { if (frame !== rootFrame) ignore(id); return; }
    if (setupFrames.size >= LIMITS.maxProjections && !setupFrames.has(id)) { stop("limit-exceeded"); return; }
    setupFrames.set(id, frame);
  }
  function apply(hop: ObservedNetworkHop, change: Partial<ObservedNetworkHop>): boolean {
    const replacement = { ...hop, ...change };
    if (!fits(hops.map(value => value === hop ? replacement : value), evidence)) { stop("limit-exceeded"); return false; }
    Object.assign(hop, change); return true;
  }
  function responseFacts(raw: unknown): Pick<ObservedNetworkHop, "status" | "fromDiskCache" | "fromServiceWorker" | "fromPrefetchCache"> {
    const value = record(raw);
    return { status: status(value.status), fromDiskCache: flag(value.fromDiskCache), fromServiceWorker: flag(value.fromServiceWorker), fromPrefetchCache: flag(value.fromPrefetchCache) };
  }
  function mergeResponse(hop: ObservedNetworkHop, raw: unknown, terminal?: "redirected"): boolean {
    const facts = responseFacts(raw);
    if (hop.status !== null && hop.status !== facts.status) fail("protocol-invalid");
    return apply(hop, {
      status: facts.status,
      fromDiskCache: facts.fromDiskCache ?? hop.fromDiskCache,
      fromServiceWorker: facts.fromServiceWorker ?? hop.fromServiceWorker,
      fromPrefetchCache: facts.fromPrefetchCache ?? hop.fromPrefetchCache,
      ...(terminal ? { terminal } : {}),
    });
  }
  function reconcile(): void {
    // Delay association until the complete finite inventory is known. A status
    // arriving before a redirect must not be provisionally pinned to that hop.
    for (const chain of chains.values()) {
      const single = chain.hops.length === 1 ? chain.hops[0] : undefined;
      if (chain.fullyObserved && single && single.terminal !== "pending" && single.terminal !== "redirected" && chain.evidence.length === 1 && chain.expected.get(single.id) !== false) {
        const item = chain.evidence[0];
        const nextHop = { ...single, networkStatus: item.status };
        const nextEvidence: NetworkHttpStatusEvidence = { ...item, hopId: single.id, association: "unique" };
        if (fits(hops.map(hop => hop === single ? nextHop : hop), evidence.map(value => value === item ? nextEvidence : value))) {
          single.networkStatus = item.status; item.hopId = single.id; item.association = "unique";
        } else { detailLimit = true; incomplete = true; }
      }
      // Redirect extra-info intentionally stays chain-level. Even matching
      // counts or adjacent receipt order do not establish a hop identity.
      if (!chain.fullyObserved || chain.hops.some(hop => hop.terminal === "pending" || hop.terminal === "finished" && hop.status === null && hop.networkStatus === null) || [...chain.expected.entries()].some(([id, required]) => required && !chain.evidence.some(item => item.hopId === id))) incomplete = true;
    }
    if (evidence.some(item => item.association === "unknown")) incomplete = true;
  }
  function makeSnapshot(reason: NetworkObservationStopReason): NetworkObservationPayload {
    reconcile();
    if (detailLimit) reason = "limit-exceeded";
    const counts = emptyCounts(); counts.requests = counts.hops = hops.length;
    counts.unattributed = unattributed + evidence.filter(item => item.association === "unknown").length;
    for (const hop of hops) {
      if (hop.terminal === "cancelled") counts.requestCancelled++;
      else if (hop.terminal === "redirected") counts.redirects++;
      else counts[hop.terminal]++;
      if (hop.status !== null || hop.networkStatus !== null) counts.responses++;
      if ([hop.status, hop.networkStatus].some(value => value !== null && value >= 400 && value < 500)) counts.http4xx++;
      if ([hop.status, hop.networkStatus].some(value => value !== null && value >= 500 && value < 600)) counts.http5xx++;
      if (hop.servedFromCache || hop.fromDiskCache === true || hop.fromPrefetchCache === true) counts.cache++;
      if (hop.fromServiceWorker === true) counts.serviceWorker++;
    }
    let completion: NetworkObservationSummary["completion"] = armedAt === null ? "unavailable" : "partial";
    if (reason === "cancelled") completion = "cancelled";
    else if (reason === "window-ended") {
      if (incomplete || counts.pending > 0 || counts.unattributed > 0) reason = "evidence-incomplete";
      else completion = "completed";
    }
    const endedAt = armedAt === null ? Date.now() : Math.max(armedAt, Math.min(Date.now(), armedAt + LIMITS.observeMs));
    const coverage: NetworkCoverage = { network: armedAt === null ? "unavailable" : completion === "completed" ? "observed" : "partial", csp: "unavailable", worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" };
    return { observation: { version: 1, completion, stopReason: reason, armedAt, endedAt, durationMs: armedAt === null ? 0 : endedAt - armedAt, counts, coverage }, hops: hops.map(hop => ({ ...hop })), httpStatusEvidence: evidence.map(item => ({ ...item })) };
  }
  function finishResult(unverified = false): void {
    if (resultSettled || !snapshot) return;
    resultSettled = true;
    if (unverified) snapshot = { ...snapshot, observation: { ...snapshot.observation, completion: "partial", stopReason: "cleanup-unverified", coverage: { ...snapshot.observation.coverage, network: armedAt === null ? "unavailable" : "partial" } } };
    resolveResult(snapshot);
  }
  function onOpen(): void { rejectOpen = undefined; resolveOpen?.(); resolveOpen = undefined; }
  function onClose(): void {
    if (!cleanupVerified) { cleanupVerified = true; resolveClosed(); }
    clearTimeout(forceTimer); clearTimeout(cleanupTimer);
    if (!stopping) stop("connection-closed");
    else finishResult();
  }
  function onError(error: Error & { code?: string }): void {
    if (stopping) return; // keep a handler until close, but never retain its prose
    stop(error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? "limit-exceeded" : "connection-closed");
  }
  function terminate(): void {
    if (cleanupVerified || !ws) return;
    try { ws.terminate(); }
    catch { finishResult(true); } // not proof of closure; `closed` stays pending
  }
  function stop(reason: NetworkObservationStopReason): void {
    if (stopping) return;
    stopping = true;
    clearTimeout(setupTimer); clearTimeout(windowTimer); clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", onAbort);
    rejectOpen?.(new ObserverFailure(reason)); rejectOpen = undefined; resolveOpen = undefined;
    ws?.removeListener("open", onOpen);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new ObserverFailure(reason)); }
    pending.clear();
    snapshot = makeSnapshot(reason);
    chains.clear(); ignored.clear(); unknownRoutes.clear(); setupFrames.clear(); // discard native routing identities now
    hops.length = 0; evidence.length = 0; // only the detached safe snapshot remains
    ws?.removeListener("message", onMessage);
    if (!ws) { cleanupVerified = true; resolveClosed(); finishResult(); return; }
    if (cleanupVerified) { finishResult(); return; }
    forceTimer = setTimeout(terminate, LIMITS.cleanupMs / 2);
    cleanupTimer = setTimeout(() => { clearTimeout(forceTimer); finishResult(true); }, LIMITS.cleanupMs);
    try { ws.close(); }
    catch { terminate(); }
  }
  function send(method: string, project: (raw: unknown) => unknown, params?: Record<string, unknown>, optional = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++commandId;
      const waiter: PendingCommand = { resolve, reject, project, optional };
      try {
        check();
        if (!ws || ws.readyState !== WebSocket.OPEN) fail("connection-closed");
        pending.set(id, waiter);
        if (optional) waiter.timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          try { check(); resolve(false); }
          catch (error) { reject(error instanceof ObserverFailure ? error : new ObserverFailure("setup-rejected")); }
        }, Math.max(1, Math.min(200, deadline - Date.now())));
        check(); // final-wire guard immediately adjacent to this owned send
        ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
      } catch (error) {
        pending.delete(id); clearTimeout(waiter.timer);
        reject(error instanceof ObserverFailure ? error : new ObserverFailure("connection-closed"));
      }
    });
  }
  function enabled(raw: unknown): boolean { record(raw); return true; }
  function frameTree(raw: unknown): { id: string; origin: string } {
    const frame = record(record(record(raw).frameTree).frame);
    if (frame.parentId !== undefined && frame.parentId !== "") fail("setup-rejected");
    const id = nativeId(frame.id), origin = httpOrigin(frame.url);
    if (origin === null || origin !== selected.origin) fail("setup-rejected");
    if (rootFrame !== null && rootFrame !== id) fail("target-changed");
    return { id, origin }; // never resolve/retain the original tree or child URLs
  }
  function startRequest(value: Record<string, unknown>): void {
    if (value.frameId !== rootFrame || value.loaderId === "") {
      const ignoredId = value.requestId;
      if (typeof ignoredId === "string" && ignoredId.length > 0 && ignoredId.length <= 1_024 && !chains.has(ignoredId)) ignore(ignoredId);
      return;
    }
    const id = nativeId(value.requestId);
    if (typeof value.loaderId !== "string") fail("protocol-invalid");
    const request = record(value.request), origin = httpOrigin(request.url);
    if (origin === null) { ignore(id); return; }
    if (typeof request.method !== "string" || request.method.length === 0) fail("protocol-invalid");
    if (value.type !== undefined && typeof value.type !== "string") fail("protocol-invalid");
    if (typeof value.redirectHasExtraInfo !== "boolean") fail("protocol-invalid");
    let chain = chains.get(id);
    let previous: ObservedNetworkHop | undefined;
    if (!chain) {
      chain = { id: opaque("chain"), hops: [], evidence: [], fullyObserved: value.redirectResponse === undefined, expected: new Map() };
      if (!chain.fullyObserved) { responseFacts(value.redirectResponse); incomplete = true; }
    } else {
      previous = chain.hops[chain.hops.length - 1];
      if (value.redirectResponse === undefined || previous.terminal !== "pending") fail("protocol-invalid");
      if (!mergeResponse(previous, value.redirectResponse, "redirected")) return;
      chain.expected.set(previous.id, value.redirectHasExtraInfo);
    }
    const hop: ObservedNetworkHop = { id: opaque("hop"), chainId: chain.id, redirectedFrom: previous?.id ?? null, origin, method: METHODS.find(method => method === request.method) ?? "OTHER", resourceType: RESOURCE_TYPES.find(type => type === value.type) ?? "Other", status: null, networkStatus: null, terminal: "pending", errorCode: null, blockedReason: null, corsReason: null, fromDiskCache: null, fromServiceWorker: null, fromPrefetchCache: null, servedFromCache: false };
    if (!fits([...hops, hop], evidence)) {
      chain.fullyObserved = false; // the redirect/new-hop inventory is truncated
      stop("limit-exceeded"); return;
    }
    ignored.delete(id); chains.set(id, chain); chain.hops.push(hop); hops.push(hop); projected();
  }
  function browserResponse(value: Record<string, unknown>): void {
    if (value.frameId !== undefined && value.frameId !== rootFrame) {
      const id = value.requestId;
      if (typeof value.frameId === "string" && value.frameId.length > 0 && value.frameId.length <= 1_024 && typeof id === "string" && id.length > 0 && id.length <= 1_024) ignore(id);
      return;
    }
    const id = nativeId(value.requestId);
    if (ignored.has(id)) return;
    const chain = chains.get(id);
    if (!chain) { if (value.frameId === rootFrame) unknown(id); return; }
    const hop = chain.hops[chain.hops.length - 1];
    if (typeof value.hasExtraInfo !== "boolean") fail("protocol-invalid");
    if (!mergeResponse(hop, value.response)) return;
    chain.expected.set(hop.id, value.hasExtraInfo); projected();
  }
  function extraResponse(value: Record<string, unknown>): void {
    const id = nativeId(value.requestId);
    if (ignored.has(id)) return;
    const chain = chains.get(id);
    const item: NetworkHttpStatusEvidence = { id: opaque("status"), chainId: chain?.id ?? null, hopId: null, status: status(value.statusCode), source: "extra-info", association: "unknown" };
    if (!fits(hops, [...evidence, item])) { stop("limit-exceeded"); return; }
    const route = chain ? undefined : unknownRoute(id);
    if (!chain && !route) return;
    evidence.push(item); chain?.evidence.push(item); route?.evidence.push(item); projected();
  }
  function terminal(value: Record<string, unknown>, failed: boolean): void {
    const id = nativeId(value.requestId);
    if (ignored.has(id)) return;
    const chain = chains.get(id);
    if (!chain) { unknown(id); return; }
    const hop = chain.hops[chain.hops.length - 1];
    if (hop.terminal !== "pending") return; // duplicate terminal cannot count twice
    if (!failed) { if (apply(hop, { terminal: "finished" })) projected(); return; }
    const cancelled = flag(value.canceled) === true;
    const blockedReason = staticReason(value.blockedReason, BLOCKED_REASONS);
    const corsReason = value.corsErrorStatus === undefined ? null : staticReason(record(value.corsErrorStatus).corsError, CORS_REASONS);
    if (apply(hop, { terminal: cancelled ? "cancelled" : blockedReason !== null ? "blocked" : "failed", errorCode: code(value.errorText), blockedReason, corsReason })) projected();
  }
  function pageEvent(method: string, value: Record<string, unknown>): void {
    if (method === "Page.frameDetached") { if (value.frameId === rootFrame) stop("target-changed"); return; }
    if (method !== "Page.frameNavigated") return;
    const frame = record(value.frame);
    if (frame.parentId !== undefined && frame.parentId !== "") return;
    const id = nativeId(frame.id);
    if (rootFrame !== null && id !== rootFrame || httpOrigin(frame.url) !== selected.origin) { stop("target-changed"); return; }
    // A root transition can race the getFrameTree reply/await. Remember only its
    // safe identity so that an old reply cannot arm a replaced main frame.
    if (rootFrame === null) rootFrame = id;
  }
  function protocolEvent(method: string, value: Record<string, unknown>): void {
    if (method.startsWith("Page.frame")) { pageEvent(method, value); return; }
    if (method === "Inspector.detached" || method === "Inspector.targetCrashed") { stop("connection-closed"); return; }
    if (armedAt === null) {
      // Retain only bounded routing identity, never setup traffic or its values.
      // This can prove that later frame-less events belong to a child/worker.
      if (method === "Network.requestWillBeSent" || method === "Network.responseReceived") setupScope(value);
      return;
    }
    switch (method) {
      case "Network.requestWillBeSent": startRequest(value); break;
      case "Network.responseReceived": browserResponse(value); break;
      case "Network.responseReceivedExtraInfo": extraResponse(value); break;
      case "Network.loadingFinished": terminal(value, false); break;
      case "Network.loadingFailed": terminal(value, true); break;
      case "Network.requestServedFromCache": {
        const id = nativeId(value.requestId); if (ignored.has(id)) return;
        const chain = chains.get(id); if (!chain) { unknown(id); return; }
        if (apply(chain.hops[chain.hops.length - 1], { servedFromCache: true })) projected();
        break;
      }
      case "Audits.issueAdded":
        // CSP counting is unavailable in this passive agent. The installed CDP
        // issue has no violated-frame identity: frameAncestor, a source URL and
        // BackendNodeId cannot prove the selected main frame, even after ACK.
        // Do not count it, spend network projection budget, or resolve DOM nodes.
        break;
      // All other domains/fields are discarded; none becomes console/storage or
      // worker/OOPIF coverage, and no raw sample is put into a pending buffer.
    }
  }
  function onMessage(raw: RawData, binary: boolean): void {
    if (stopping) return;
    try {
      check();
      const length = typeof raw === "string" ? Buffer.byteLength(raw) : Array.isArray(raw) ? raw.reduce((total, chunk) => total + chunk.byteLength, 0) : raw.byteLength;
      if (length > LIMITS.maxRawMessageBytes) fail("limit-exceeded");
      if (binary) fail("protocol-invalid");
      const bytes = typeof raw === "string" ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw, length) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const packet = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (packet.sessionId !== undefined) { if (typeof packet.sessionId !== "string") fail("protocol-invalid"); return; }
      if (packet.id !== undefined) {
        if (typeof packet.id !== "number" || !Number.isSafeInteger(packet.id) || packet.id <= 0) fail("protocol-invalid");
        const waiter = pending.get(packet.id);
        if (!waiter) return;
        pending.delete(packet.id); clearTimeout(waiter.timer);
        if (packet.error !== undefined) {
          if (waiter.optional) waiter.resolve(false); else waiter.reject(new ObserverFailure("setup-rejected"));
          return;
        }
        try { const projectedValue = waiter.project(packet.result); check(); waiter.resolve(projectedValue); }
        catch (error) { waiter.reject(error instanceof ObserverFailure ? error : new ObserverFailure("protocol-invalid")); }
        return;
      }
      if (typeof packet.method !== "string") fail("protocol-invalid");
      protocolEvent(packet.method, record(packet.params));
    } catch (error) { stopped(error); }
  }

  try {
    if (!portAllowed(port) || typeof options.assertCurrent !== "function") fail("setup-rejected");
    deadline = setupDeadline(options.deadline); current(options); selected = selectedTarget(target, port); check();
    setupTimer = setTimeout(() => stop("setup-timeout"), Math.max(1, deadline - Date.now()));
    heartbeat = setInterval(checkHeartbeat, LIMITS.livenessMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    check();
    ws = new WebSocket(selected.webSocketDebuggerUrl, { maxPayload: LIMITS.maxRawMessageBytes, handshakeTimeout: Math.max(1, deadline - Date.now()), perMessageDeflate: false, followRedirects: false });
    ws.on("message", onMessage); ws.on("close", onClose); ws.on("error", onError);
    const opened = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; ws!.once("open", onOpen); });
    void (async () => {
      try {
        await opened; check();
        await send("Page.enable", enabled); check();
        await send("Network.enable", enabled, { maxPostDataSize: 0 }); check();
        const frame = await send("Page.getFrameTree", frameTree) as { id: string; origin: string }; check();
        if (rootFrame !== null && rootFrame !== frame.id) fail("target-changed");
        rootFrame = frame.id;
        for (const [id, observedFrame] of setupFrames) {
          if (observedFrame !== rootFrame) ignore(id);
          if (stopping) break;
        }
        setupFrames.clear(); check();
        // ACK is necessary but not sufficient for CSP coverage: this CDP stream
        // cannot prove violated-main-frame identity without forbidden DOM work.
        await send("Audits.enable", enabled, undefined, true); check();
        armedAt = Date.now(); clearTimeout(setupTimer);
        windowTimer = setTimeout(checkHeartbeat, LIMITS.observeMs);
        options.onArmed?.({ armedAt, observeForMs: 10000 });
        check();
      } catch (error) { stopped(error, "setup-rejected"); }
    })();
  } catch (error) { stopped(error, "setup-rejected"); }
  return handle;
}
