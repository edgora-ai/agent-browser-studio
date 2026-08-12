import type { ProxyHealthEntry, ProxyHealthHistoryPoint, ProxyRiskLevel } from "../types.js";
import { getConfig, getProxyHealthEntry, saveConfig, setProxyHealth } from "./config-manager.js";

export interface ProxyHealthObservation {
  success: boolean;
  exitIp?: string | null;
  countryCode?: string | null;
  timezone?: string | null;
  provider?: string | null;
  latencyMs?: number | null;
  isp?: string | null;
  org?: string | null;
  as?: string | null;
  error?: string | null;
}

export interface ProxyHealthSummary {
  total: number;
  good: number;
  watch: number;
  poor: number;
  inCooldown: number;
  lastCheckedAt: number | null;
}

const MAX_HISTORY = 20;
const MAX_EXIT_IPS = 5;
const COOLDOWN_AFTER_FAILURES = 3;
const COOLDOWN_MS = 30 * 60 * 1000;
const STALE_DAILY_DECAY = 24 * 60 * 60 * 1000;

function freshEntry(name: string): ProxyHealthEntry {
  const now = Date.now();
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
  };
}

/**
 * Record one proxy detection observation (success or failure) and update the
 * proxy's rolling health entry. Keeps at most MAX_HISTORY points, tracks
 * consecutive failures / cooldown, exit-IP and geo drift, and recomputes the
 * score, risk, bindings and suggestion.
 */
export function recordProxyDetection(name: string, obs: ProxyHealthObservation): ProxyHealthEntry {
  const existing = getProxyHealthEntry(name) || freshEntry(name);
  const now = Date.now();
  const point: ProxyHealthHistoryPoint = {
    at: now,
    success: Boolean(obs.success),
    exitIp: obs.exitIp || null,
    countryCode: obs.countryCode || null,
    timezone: obs.timezone || null,
    provider: obs.provider || null,
    latencyMs: typeof obs.latencyMs === "number" && Number.isFinite(obs.latencyMs) ? Math.max(0, Math.floor(obs.latencyMs)) : null,
    isp: obs.isp || null,
    org: obs.org || null,
    as: obs.as || null,
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
  entry.score = computeScore(entry);
  entry.risk = riskFromScore(entry.score);
  entry.bindings = computeBindings(name);
  entry.suggestion = suggestionFor(entry);

  setProxyHealth(name, entry);
  return entry;
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
export function computeScore(entry: Pick<ProxyHealthEntry, "checks" | "successes" | "avgLatencyMs" | "ipDriftCount" | "geoDriftCount" | "lastCheckedAt">): number {
  const checks = entry.checks || 0;
  const successRate = checks > 0 ? (entry.successes || 0) / checks : 0;
  const successScore = successRate * 45;

  let latencyScore = 15;
  if (typeof entry.avgLatencyMs === "number") {
    latencyScore = Math.max(0, 25 - Math.max(0, entry.avgLatencyMs - 200) / 40);
  }

  const driftPenalty = Math.max(0, 20 - (entry.ipDriftCount || 0) * 10 - (entry.geoDriftCount || 0) * 10);

  const ageMs = entry.lastCheckedAt ? Date.now() - entry.lastCheckedAt : Number.MAX_SAFE_INTEGER;
  const freshness = Math.max(0, 10 - Math.floor(ageMs / STALE_DAILY_DECAY));

  return Math.max(0, Math.min(100, Math.round(successScore + latencyScore + driftPenalty + freshness)));
}

export function riskFromScore(score: number): ProxyRiskLevel {
  if (score >= 80) return "good";
  if (score >= 55) return "watch";
  return "poor";
}

export function suggestionFor(entry: ProxyHealthEntry): string | null {
  const now = Date.now();
  if (entry.cooldownUntil && now < entry.cooldownUntil) {
    return "连续失败 ≥3 次，已进入 30 分钟冷却，建议先检查代理凭据或更换节点";
  }
  if (entry.consecutiveFailures >= COOLDOWN_AFTER_FAILURES) {
    return "连续失败，建议更换节点或检查代理配置";
  }
  if ((entry.geoDriftCount || 0) >= 2) {
    return "出口国家/地区频繁漂移，建议固定到单一节点";
  }
  if ((entry.ipDriftCount || 0) >= 2) {
    return "出口 IP 频繁漂移，可能触发账号风控，建议使用固定 IP";
  }
  if (typeof entry.avgLatencyMs === "number" && entry.avgLatencyMs > 800) {
    return "延迟偏高，建议换更近的节点";
  }
  if (!entry.checks) return "尚未检测";
  if (entry.risk === "good") return "状态良好";
  return null;
}

/** Which profiles route through the given proxy (named binding or default). */
export function computeBindings(name: string): string[] {
  const cfg = getConfig();
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
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => b.lastCheckedAt - a.lastCheckedAt);
}

/** Clear one proxy's health history, or all when no name is given. Returns count cleared. */
export function clearProxyHealth(name?: string): number {
  const cfg = getConfig();
  if (name) {
    if (!Object.hasOwn(cfg.proxies || {}, name)) throw new Error(`Proxy not found: ${name}`);
    if (cfg.proxyHealth && Object.hasOwn(cfg.proxyHealth, name)) {
      delete cfg.proxyHealth[name];
      saveConfig(cfg);
      return 1;
    }
    return 0;
  }
  const count = Object.keys(cfg.proxyHealth || {}).length;
  cfg.proxyHealth = {};
  saveConfig(cfg);
  return count;
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
    lastCheckedAt: null,
  };
  const now = Date.now();
  for (const e of entries) {
    summary[e.risk] += 1;
    if (e.cooldownUntil && e.cooldownUntil > now) summary.inCooldown += 1;
    if (!summary.lastCheckedAt || e.lastCheckedAt > summary.lastCheckedAt) summary.lastCheckedAt = e.lastCheckedAt;
  }
  return summary;
}
