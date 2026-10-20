/** The transport-free, persistable portion of a selected-page observation. */
export const NETWORK_OBSERVATION_LIMITS = Object.freeze({
  setupMs: 5_000,
  observeMs: 10_000,
  cleanupMs: 2_000,
  livenessMs: 25,
  maxHops: 128,
  maxProjections: 256,
  maxDetailBytes: 262_144,
  maxRawMessageBytes: 1_048_576,
  maxDiscoveryBytes: 524_288,
});

export type NetworkObservationStopReason =
  | "window-ended" | "cancelled" | "deadline" | "connection-closed"
  | "target-changed" | "setup-rejected" | "setup-timeout" | "protocol-invalid"
  | "limit-exceeded" | "evidence-incomplete" | "cleanup-unverified";
export type NetworkObservationCompletion = "completed" | "partial" | "cancelled" | "unavailable";
export interface NetworkCoverage {
  network: "observed" | "partial" | "unavailable";
  csp: "observed" | "unavailable";
  worker: "not-observed";
  oopif: "not-observed";
  console: "not-observed";
  storage: "not-observed";
  frames: "selected-target-main-frame";
  bridgeHop: "unknown";
  upstreamHop: "unknown";
}
export interface NetworkCounts {
  requests: number;
  hops: number;
  responses: number;
  finished: number;
  failed: number;
  blocked: number;
  requestCancelled: number;
  redirects: number;
  http4xx: number;
  http5xx: number;
  pending: number;
  cache: number;
  serviceWorker: number;
  unattributed: number;
  cspIssues: number;
}
export interface NetworkObservationSummary {
  version: 1;
  completion: NetworkObservationCompletion;
  stopReason: NetworkObservationStopReason;
  armedAt: number | null;
  endedAt: number;
  durationMs: number;
  counts: NetworkCounts;
  coverage: NetworkCoverage;
}
export type NetworkRequestMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "CONNECT" | "TRACE" | "OTHER";
export type NetworkResourceType =
  | "Document" | "Stylesheet" | "Image" | "Media" | "Font" | "Script" | "TextTrack"
  | "XHR" | "Fetch" | "Prefetch" | "EventSource" | "WebSocket" | "Manifest"
  | "SignedExchange" | "Ping" | "CSPViolationReport" | "Preflight" | "FedCM" | "Other";
export type NetworkNativeErrorCode =
  | "ERR_FAILED" | "ERR_ABORTED" | "ERR_TIMED_OUT" | "ERR_CONNECTION_TIMED_OUT"
  | "ERR_CONNECTION_CLOSED" | "ERR_CONNECTION_RESET" | "ERR_CONNECTION_REFUSED"
  | "ERR_CONNECTION_ABORTED" | "ERR_CONNECTION_FAILED" | "ERR_NAME_NOT_RESOLVED"
  | "ERR_INTERNET_DISCONNECTED" | "ERR_NETWORK_CHANGED" | "ERR_ADDRESS_UNREACHABLE"
  | "ERR_PROXY_CONNECTION_FAILED" | "ERR_TUNNEL_CONNECTION_FAILED"
  | "ERR_PROXY_AUTH_UNSUPPORTED" | "ERR_INVALID_AUTH_CREDENTIALS"
  | "ERR_NO_SUPPORTED_PROXIES" | "ERR_SOCKS_CONNECTION_FAILED"
  | "ERR_SOCKS_CONNECTION_HOST_UNREACHABLE" | "ERR_BLOCKED_BY_CLIENT"
  | "ERR_BLOCKED_BY_RESPONSE" | "ERR_BLOCKED_BY_CSP" | "ERR_ACCESS_DENIED"
  | "ERR_CERT_AUTHORITY_INVALID" | "ERR_CERT_COMMON_NAME_INVALID"
  | "ERR_CERT_DATE_INVALID" | "ERR_CERT_INVALID" | "ERR_SSL_PROTOCOL_ERROR"
  | "ERR_HTTP2_PROTOCOL_ERROR" | "ERR_QUIC_PROTOCOL_ERROR"
  | "ERR_EMPTY_RESPONSE" | "ERR_CONTENT_LENGTH_MISMATCH" | "ERR_INCOMPLETE_CHUNKED_ENCODING"
  | "ERR_TOO_MANY_REDIRECTS" | "ERR_UNSAFE_REDIRECT" | "ERR_INVALID_RESPONSE" | "OTHER";
export type NetworkBlockedReason =
  | "other" | "csp" | "mixed-content" | "origin" | "inspector" | "integrity"
  | "subresource-filter" | "content-type" | "coep-frame-resource-needs-coep-header"
  | "coop-sandboxed-iframe-cannot-navigate-to-coop-page" | "corp-not-same-origin"
  | "corp-not-same-origin-after-defaulted-to-same-origin-by-coep"
  | "corp-not-same-origin-after-defaulted-to-same-origin-by-dip"
  | "corp-not-same-origin-after-defaulted-to-same-origin-by-coep-and-dip"
  | "corp-not-same-site" | "sri-message-signature-mismatch" | "OTHER";
export type NetworkCorsReason =
  | "DisallowedByMode" | "InvalidResponse" | "WildcardOriginNotAllowed"
  | "MissingAllowOriginHeader" | "MultipleAllowOriginValues" | "InvalidAllowOriginValue"
  | "AllowOriginMismatch" | "InvalidAllowCredentials" | "CorsDisabledScheme"
  | "PreflightInvalidStatus" | "PreflightDisallowedRedirect" | "PreflightWildcardOriginNotAllowed"
  | "PreflightMissingAllowOriginHeader" | "PreflightMultipleAllowOriginValues"
  | "PreflightInvalidAllowOriginValue" | "PreflightAllowOriginMismatch"
  | "PreflightInvalidAllowCredentials" | "PreflightMissingAllowExternal" | "PreflightInvalidAllowExternal"
  | "InvalidAllowMethodsPreflightResponse" | "InvalidAllowHeadersPreflightResponse"
  | "MethodDisallowedByPreflightResponse" | "HeaderDisallowedByPreflightResponse"
  | "RedirectContainsCredentials" | "InsecureLocalNetwork" | "InvalidLocalNetworkAccess"
  | "NoCorsRedirectModeNotFollow" | "LocalNetworkAccessPermissionDenied" | "OTHER";
export interface ObservedNetworkHop {
  id: string;
  chainId: string;
  redirectedFrom: string | null;
  origin: string;
  method: NetworkRequestMethod;
  resourceType: NetworkResourceType;
  status: number | null;
  networkStatus: number | null;
  terminal: "pending" | "finished" | "failed" | "blocked" | "cancelled" | "redirected";
  errorCode: NetworkNativeErrorCode | null;
  blockedReason: NetworkBlockedReason | null;
  corsReason: NetworkCorsReason | null;
  fromDiskCache: boolean | null;
  fromServiceWorker: boolean | null;
  fromPrefetchCache: boolean | null;
  servedFromCache: boolean;
}
export interface NetworkHttpStatusEvidence {
  id: string;
  chainId: string | null;
  hopId: string | null;
  status: number;
  source: "extra-info";
  association: "unique" | "unknown";
}
export interface NetworkObservationPayload {
  observation: NetworkObservationSummary;
  hops: ObservedNetworkHop[];
  httpStatusEvidence: NetworkHttpStatusEvidence[];
}

const SUMMARY_KEYS = ["version", "completion", "stopReason", "armedAt", "endedAt", "durationMs", "counts", "coverage"] as const;
const COUNT_KEYS = ["requests", "hops", "responses", "finished", "failed", "blocked", "requestCancelled", "redirects", "http4xx", "http5xx", "pending", "cache", "serviceWorker", "unattributed", "cspIssues"] as const;
const COVERAGE_KEYS = ["network", "csp", "worker", "oopif", "console", "storage", "frames", "bridgeHop", "upstreamHop"] as const;
const STOP_REASONS = ["window-ended", "cancelled", "deadline", "connection-closed", "target-changed", "setup-rejected", "setup-timeout", "protocol-invalid", "limit-exceeded", "evidence-incomplete", "cleanup-unverified"] as const;
const COMPLETIONS = ["completed", "partial", "cancelled", "unavailable"] as const;

function exactRecord(raw: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const names = Reflect.ownKeys(raw);
  if (names.length !== expected.length || names.some(name => typeof name !== "string" || !expected.includes(name))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values: Record<string, unknown> = Object.create(null);
  for (const name of expected) {
    const descriptor = descriptors[name];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    values[name] = descriptor.value;
  }
  return values;
}
function integer(raw: unknown, maximum = Number.MAX_SAFE_INTEGER): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= maximum;
}

/**
 * Strict storage/IPC boundary. Reject, rather than repair, unknown data. Reading
 * descriptors prevents accessors from supplying fields or exfiltrating through
 * getters. A fresh projection also prevents later mutation of an input alias.
 */
export function normalizeNetworkObservationSummary(raw: unknown): NetworkObservationSummary | null {
  try {
    const value = exactRecord(raw, SUMMARY_KEYS);
    if (!value || value.version !== 1 || !COMPLETIONS.includes(value.completion as NetworkObservationCompletion) || !STOP_REASONS.includes(value.stopReason as NetworkObservationStopReason)) return null;
    const rawCounts = exactRecord(value.counts, COUNT_KEYS), rawCoverage = exactRecord(value.coverage, COVERAGE_KEYS);
    if (!rawCounts || !rawCoverage) return null;
    const counts = {} as NetworkCounts;
    for (const key of COUNT_KEYS) {
      const maximum = key === "unattributed" || key === "cspIssues" ? NETWORK_OBSERVATION_LIMITS.maxProjections : NETWORK_OBSERVATION_LIMITS.maxHops;
      if (!integer(rawCounts[key], maximum)) return null;
      counts[key] = rawCounts[key] as number;
    }
    if (!["observed", "partial", "unavailable"].includes(rawCoverage.network as string) || !["observed", "unavailable"].includes(rawCoverage.csp as string)) return null;
    if (rawCoverage.worker !== "not-observed" || rawCoverage.oopif !== "not-observed" || rawCoverage.console !== "not-observed" || rawCoverage.storage !== "not-observed" || rawCoverage.frames !== "selected-target-main-frame" || rawCoverage.bridgeHop !== "unknown" || rawCoverage.upstreamHop !== "unknown") return null;
    const coverage: NetworkCoverage = { network: rawCoverage.network as NetworkCoverage["network"], csp: rawCoverage.csp as NetworkCoverage["csp"], worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" };
    const { armedAt, endedAt, durationMs } = value;
    if (!integer(endedAt) || !integer(durationMs, NETWORK_OBSERVATION_LIMITS.observeMs)) return null;
    if (armedAt === null) {
      if (durationMs !== 0 || coverage.network !== "unavailable" || coverage.csp !== "unavailable" || COUNT_KEYS.some(key => counts[key] !== 0)) return null;
    } else if (!integer(armedAt) || endedAt < armedAt || endedAt - armedAt !== durationMs || coverage.network === "unavailable") return null;
    const completion = value.completion as NetworkObservationCompletion, stopReason = value.stopReason as NetworkObservationStopReason;
    if (completion === "unavailable" && armedAt !== null) return null;
    if (completion === "completed" && (armedAt === null || durationMs !== NETWORK_OBSERVATION_LIMITS.observeMs || stopReason !== "window-ended" || coverage.network !== "observed" || counts.pending !== 0 || counts.unattributed !== 0 || counts.responses < counts.finished + counts.redirects)) return null;
    if ((completion === "cancelled") !== (stopReason === "cancelled")) return null;
    if (armedAt !== null && completion !== "completed" && coverage.network !== "partial") return null;
    if (counts.requests !== counts.hops || counts.finished + counts.failed + counts.blocked + counts.requestCancelled + counts.redirects + counts.pending !== counts.hops) return null;
    if (counts.responses > counts.hops || counts.http4xx > counts.responses || counts.http5xx > counts.responses || counts.cache > counts.hops || counts.serviceWorker > counts.hops) return null;
    if (counts.cspIssues > 0 && coverage.csp !== "observed") return null;
    return { version: 1, completion, stopReason, armedAt: armedAt as number | null, endedAt, durationMs, counts, coverage };
  } catch {
    // Hostile proxies/descriptors are invalid input, not persistent error prose.
    return null;
  }
}
