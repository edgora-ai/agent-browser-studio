import type { MgmtConfig, ProxyHealthEntry, ProxyHealthHistoryPoint, ProxyRiskLevel, ProxyObservationMetadata } from "../types.js";
import { getConfig, getProxyHealthEntry } from "./config-manager.js";
import { transact, ProxyDetectionCommitError } from "./config/store.js";
import { proxyObservationTime, PROXY_OBSERVATION_TTL_MS } from "./proxy-observation.js";
import { tMain } from "./main-i18n.js";


export interface ProxyHealthObservation extends Partial<ProxyObservationMetadata> {
  success: boolean;
  exitIp?: string | null;
  countryCode?: string | null;
  timezone?: string | null;
  provider?: string | null;
  latencyMs?: number | null;
  isp?: string | null;
  org?: string | null;
  as?: string | null;
  hosting?: boolean | null;
  isProxy?: boolean | null;
  error?: string | null;
}

export interface ProxyHealthSummary {
  total: number;
  good: number;
  watch: number;
  poor: number;
  inCooldown: number;
  stale: number;
  unknown: number;
  lastCheckedAt: number | null;
}

const MAX_HISTORY = 20;
const MAX_EXIT_IPS = 5;
const COOLDOWN_AFTER_FAILURES = 3;
const COOLDOWN_MS = 30 * 60 * 1000;
const STALE_DAILY_DECAY = 24 * 60 * 60 * 1000;

function freshEntry(name: string, now: number): ProxyHealthEntry {
  return {
    proxyName: name,
    firstSeenAt: now,
    lastCheckedAt: now,
    lastSuccessAt: null,
    checks: 0,
    successes: 0,
    consecutiveFailures: 0,
    distinctExitIps: [],
    ipDriftCount: 0,
    geoDriftCount: 0,
    avgLatencyMs: null,
    score: 0,
    risk: "poor",
    history: [],
    bindings: [],
    cooldownUntil: null,
    suggestion: null,
    rotations: 0,
    lastRotatedAt: null,
    lastRotatedTo: null,
  };
}

/**
 * Record one proxy detection observation (success or failure) and update the
 * proxy's rolling health entry. Keeps at most MAX_HISTORY points, tracks
 * consecutive failures / cooldown, exit-IP and geo drift, and recomputes the
 * score, risk, bindings and suggestion.
 */
export function reduceProxyDetection(name: string, previous: ProxyHealthEntry | null, obs: ProxyHealthObservation,
  observedAt: number, bindings: string[]): ProxyHealthEntry {
  const now = observedAt;
  const existing = previous ? structuredClone(previous) : freshEntry(name, now);
  const point: ProxyHealthHistoryPoint = {
    at: now,
    source: obs.source === "network" || obs.source === "cache" ? obs.source : "unknown",
    observationId: obs.observationId || null,
    success: Boolean(obs.success),
    exitIp: obs.exitIp || null,
    countryCode: obs.countryCode || null,
    timezone: obs.timezone || null,
    provider: obs.provider || null,
    latencyMs: typeof obs.latencyMs === "number" && Number.isFinite(obs.latencyMs) ? Math.max(0, Math.floor(obs.latencyMs)) : null,
    isp: obs.isp || null,
    org: obs.org || null,
    as: obs.as || null,
    hosting: obs.hosting ?? null,
    isProxy: obs.isProxy ?? null,
    error: obs.error || null,
  };

  const entry: ProxyHealthEntry = {
    ...existing,
    history: [...(existing.history || []), point].slice(-MAX_HISTORY),
  };
  entry.checks = (entry.checks || 0) + 1;
  entry.lastCheckedAt = now;

  if (point.success) {
    entry.successes = (entry.successes || 0) + 1;
    entry.consecutiveFailures = 0;
    entry.lastSuccessAt = now;
    entry.cooldownUntil = null;
    if (point.exitIp) {
      const ips = entry.distinctExitIps || [];
      if (!ips.includes(point.exitIp)) {
        entry.distinctExitIps = [...ips, point.exitIp].slice(-MAX_EXIT_IPS);
      }
    }
    const priorHistory = entry.history.slice(0, -1);
    const prevSuccess = [...priorHistory].reverse().find((h) => h.success && h.exitIp);
    if (prevSuccess) {
      if (point.exitIp && prevSuccess.exitIp && point.exitIp !== prevSuccess.exitIp) {
        entry.ipDriftCount = (entry.ipDriftCount || 0) + 1;
      }
      if (point.countryCode && prevSuccess.countryCode && point.countryCode !== prevSuccess.countryCode) {
        entry.geoDriftCount = (entry.geoDriftCount || 0) + 1;
      }
    }
  } else {
    entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
    if (entry.consecutiveFailures >= COOLDOWN_AFTER_FAILURES) {
      entry.cooldownUntil = now + COOLDOWN_MS;
    }
  }

  entry.avgLatencyMs = computeAvgLatency(entry.history);
  entry.score = computeScore(entry, now);
  entry.risk = riskFromScore(entry.score);
  entry.bindings = [...bindings];
  entry.suggestion = suggestionFor(entry, now);
  return entry;
}

/** Main-only explicit observation writer. Transport callers instead use the
 * authenticated target+stamp transaction, which also writes detection. */
export function recordProxyDetection(name: string, obs: ProxyHealthObservation): ProxyHealthEntry {
  const at = proxyObservationTime(obs.observedAt);
  if (at === null || obs.source !== "network") throw new ProxyDetectionCommitError("PROXY_DETECTION_UNOBSERVED");
  getConfig();
  return transact((draft: MgmtConfig) => {
    if (!Object.hasOwn(draft.proxies, name)) throw new Error(`Proxy not found: ${name}`);
    const entry = reduceProxyDetection(name, draft.proxyHealth?.[name] || null, obs, at, computeBindings(name, draft));
    draft.proxyHealth = { ...draft.proxyHealth, [name]: entry };
    return structuredClone(entry);
  });
}

/**
 * Record that a profile launched on fallback `toName` because `fromName` was
 * unhealthy. Updates the rotation counters on the primary proxy's health entry.
 */
export function recordProxyRotation(fromName: string, toName: string): ProxyHealthEntry | null {
  const existing = getProxyHealthEntry(fromName);
  if (!existing) return null;
  return transact((draft: MgmtConfig) => {
    const current = draft.proxyHealth?.[fromName];
    if (!current) return null;
    const entry: ProxyHealthEntry = { ...current, rotations: (current.rotations || 0) + 1, lastRotatedAt: Date.now(), lastRotatedTo: toName };
    draft.proxyHealth![fromName] = entry;
    return structuredClone(entry);
  });
}

export function computeAvgLatency(history: ProxyHealthHistoryPoint[]): number | null {
  const latencies = history
    .filter((h) => typeof h.latencyMs === "number")
    .map((h) => h.latencyMs as number);
  if (!latencies.length) return null;
  return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
}

/**
 * 0-100 health score:
 *   success rate 45 + latency 25 + stability/drift 20 + freshness 10
 */
export function computeScore(entry: Pick<ProxyHealthEntry, "checks" | "successes" | "avgLatencyMs" | "ipDriftCount" | "geoDriftCount" | "lastCheckedAt">, now = Date.now()): number {
  const checks = entry.checks || 0;
  const successRate = checks > 0 ? (entry.successes || 0) / checks : 0;
  const successScore = successRate * 45;

  let latencyScore = 15;
  if (typeof entry.avgLatencyMs === "number") {
    latencyScore = Math.max(0, 25 - Math.max(0, entry.avgLatencyMs - 200) / 40);
  }

  const driftPenalty = Math.max(0, 20 - (entry.ipDriftCount || 0) * 10 - (entry.geoDriftCount || 0) * 10);

  const ageMs = entry.lastCheckedAt !== null ? Math.max(0, now - entry.lastCheckedAt) : Number.MAX_SAFE_INTEGER;
  const freshness = Math.max(0, 10 - Math.floor(ageMs / STALE_DAILY_DECAY));

  return Math.max(0, Math.min(100, Math.round(successScore + latencyScore + driftPenalty + freshness)));
}

export function riskFromScore(score: number): ProxyRiskLevel {
  if (score >= 80) return "good";
  if (score >= 55) return "watch";
  return "poor";
}

// R146: these were hardcoded Chinese, so the EN UI rendered Chinese on every
// proxy card — the mirror image of the renderer's English leak. Text now comes
// from tMain so it follows the UI language; the renderer pushes the user's
// choice over IPC ("app:set-language"), so this stays in sync without the
// main process knowing about the renderer's dictionary.
export function suggestionFor(entry: ProxyHealthEntry, now = Date.now()): string | null {
  if (entry.cooldownUntil && now < entry.cooldownUntil) {
    return tMain("proxy.sug.cooldown", "Repeated failures — in cooldown, check credentials or switch nodes");
  }
  if (entry.consecutiveFailures >= COOLDOWN_AFTER_FAILURES) {
    return tMain("proxy.sug.consecutive", "Failing repeatedly — switch nodes or check the proxy configuration");
  }
  // Freshness is localized by the renderer's explicit source/age badge. Never
  // retain the historical "Healthy" suggestion for a stale/unknown sample.
  if (entry.freshness === "stale" || entry.freshness === "unknown") return null;
  if ((entry.geoDriftCount || 0) >= 2) {
    return tMain("proxy.sug.geo-drift", "Exit country/region keeps drifting — pin this proxy to a single node");
  }
  if ((entry.ipDriftCount || 0) >= 2) {
    return tMain("proxy.sug.ip-drift", "Exit IP keeps drifting — use a fixed IP");
  }
  const latest = entry.history && entry.history.length ? entry.history[entry.history.length - 1] : null;
  if (latest?.success && latest.hosting === true) {
    const who = [latest.org, latest.as].filter(Boolean).join(" · ");
    return tMain(
      "proxy.sug.idc",
      "Exit is a datacenter/IDC IP{who} — prefer a residential, non-IDC exit",
    ).replace("{who}", who ? tMain("proxy.sug.idc-org", " ({who})").replace("{who}", who) : "");
  }
  if (typeof entry.avgLatencyMs === "number" && entry.avgLatencyMs > 800) {
    return tMain("proxy.sug.latency", "Latency is high — switch to a closer node");
  }
  if (!entry.checks) return tMain("proxy.sug.unchecked", "Not checked yet");
  if (entry.risk === "good") return tMain("proxy.sug.good", "Healthy");
  return null;
}

/** Which profiles route through the given proxy (named binding or default). */
export function computeBindings(name: string, cfg: MgmtConfig = getConfig()): string[] {
  const bindings: string[] = [];
  for (const [dirId, meta] of Object.entries(cfg.browserProfiles || {})) {
    const mode = meta.proxyMode;
    if (mode === "named" && meta.proxyName === name) {
      bindings.push(dirId);
    } else if ((mode === "default" || mode === undefined) && cfg.defaultProxy === name) {
      bindings.push(`${dirId} (默认)`);
    }
  }
  return bindings;
}

/** All proxies that have health data, most recently checked first. */
export function listProxyHealth(): ProxyHealthEntry[] {
  const cfg = getConfig();
  const entries: ProxyHealthEntry[] = [];
  for (const name of Object.keys(cfg.proxies || {})) {
    const entry = getProxyHealthEntry(name);
    if (!entry) continue;
    // Current UI is a detached projection, never a new sample. Ten minutes is
    // the detector's reuse TTL; an old perfect score cannot remain green merely
    // because the historical formula loses at most ten freshness points.
    const now = Date.now(), latest = entry.history.at(-1);
    const at = proxyObservationTime(entry.lastCheckedAt);
    entry.observationAgeMs = at === null ? null : Math.max(0, now - at);
    entry.freshness = at === null || latest?.source !== "network" ? "unknown"
      : entry.observationAgeMs! > PROXY_OBSERVATION_TTL_MS ? "stale" : "fresh";
    entry.score = Math.min(computeScore(entry, now), entry.freshness === "fresh" ? 100 : entry.freshness === "stale" ? 79 : 54);
    entry.risk = riskFromScore(entry.score);
    entry.bindings = computeBindings(name, cfg);
    entry.suggestion = suggestionFor(entry, now);
    entries.push(entry);
  }
  return entries.sort((a, b) => (b.lastCheckedAt ?? -1) - (a.lastCheckedAt ?? -1));
}

/** Clear one proxy's health history, or all when no name is given. Returns count cleared. */
export function clearProxyHealth(name?: string): number {
  getConfig();
  return transact((draft: MgmtConfig) => {
    if (name !== undefined) {
      if (!Object.hasOwn(draft.proxies || {}, name)) throw new Error(`Proxy not found: ${name}`);
      const count = draft.proxyHealth && Object.hasOwn(draft.proxyHealth, name) ? 1 : 0;
      if (draft.proxyHealth) delete draft.proxyHealth[name];
      return count;
    }
    const count = Object.keys(draft.proxyHealth || {}).length;
    draft.proxyHealth = {};
    return count;
  }, undefined, { invalidateProxyTargets: name === undefined ? "all" : [name] });
}

/** Aggregate health counts without exposing proxy configuration. */
export function proxyHealthSummary(): ProxyHealthSummary {
  const entries = listProxyHealth();
  const summary: ProxyHealthSummary = {
    total: entries.length,
    good: 0,
    watch: 0,
    poor: 0,
    inCooldown: 0,
    stale: 0,
    unknown: 0,
    lastCheckedAt: null,
  };
  const now = Date.now();
  for (const e of entries) {
    summary[e.risk] += 1;
    if (e.freshness === "stale") summary.stale++;
    if (e.freshness === "unknown") summary.unknown++;
    if (e.cooldownUntil && e.cooldownUntil > now) summary.inCooldown += 1;
    if (e.lastCheckedAt !== null && (summary.lastCheckedAt === null || e.lastCheckedAt > summary.lastCheckedAt)) summary.lastCheckedAt = e.lastCheckedAt;
  }
  return summary;
}
