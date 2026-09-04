/**
 * Local-first observability: structured event log on disk + in-memory metrics.
 *
 * Design constraints (review item TE-01):
 * - Nothing is ever sent off-device. There is no network path in this module.
 * - Logs rotate (single file cap) and age out (retention window).
 * - Every entry can carry a traceId so a UI action can be joined to the
 *   main-process work it triggered (review item TE-03).
 * - Sensitive values are redacted before they ever reach disk, so an exported
 *   diagnostic bundle is safe to hand to someone else.
 *
 * This module deliberately depends only on node:fs / node:path so it can be
 * unit-tested without an Electron runtime.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  event: string;
  traceId?: string;
  [key: string]: unknown;
}

export interface TimingSummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
  lastAt: number;
}

export interface MetricsSnapshot {
  generatedAt: number;
  counters: Record<string, number>;
  timings: Record<string, TimingSummary>;
  gauges: Record<string, number>;
}

export interface ObservabilityOptions {
  dir?: string;
  maxFileBytes?: number;
  retentionDays?: number;
  enabled?: boolean;
}

const DEFAULTS = {
  maxFileBytes: 5 * 1024 * 1024, // 5 MB per file (TE-01 acceptance)
  retentionDays: 7,
  enabled: true,
  memoryEvents: 500,
  timingSamples: 200,
};

const SENSITIVE_KEY = /(pass|pwd|token|secret|apikey|api_key|accesskey|access_key|authorization|bearer|cookie|credential|private|mnemonic|session|sid\b)/i;
const REDACTED = "[redacted]";

let options: Required<Pick<ObservabilityOptions, "maxFileBytes" | "retentionDays" | "enabled">> & { dir: string | null } = {
  dir: null,
  maxFileBytes: DEFAULTS.maxFileBytes,
  retentionDays: DEFAULTS.retentionDays,
  enabled: DEFAULTS.enabled,
};

let currentFilePath: string | null = null;
const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const timings = new Map<string, number[]>();
const timingLast = new Map<string, number>();
const memoryEvents: LogEntry[] = [];
let counter = 0;

// ── Configuration ──────────────────────────────────────────────────────────

export function configureObservability(opts: ObservabilityOptions = {}): void {
  options = {
    dir: opts.dir ?? options.dir,
    maxFileBytes: opts.maxFileBytes ?? options.maxFileBytes,
    retentionDays: opts.retentionDays ?? options.retentionDays,
    enabled: opts.enabled ?? options.enabled,
  };
  currentFilePath = null;
}

/** Resolve (and create) the log directory. Null when observability is off. */
function logDir(): string | null {
  if (!options.enabled) return null;
  if (!options.dir) return null;
  return options.dir;
}

function ensureDir(): string | null {
  const dir = logDir();
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX */ }
    return dir;
  } catch {
    return null;
  }
}

function dayStamp(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${m}${day}`;
}

/**
 * Pick the active log file, rolling over when the current one exceeds the cap.
 * Roll-over names use a monotonic suffix so files never collide within a day.
 */
function activeFile(): string | null {
  const dir = ensureDir();
  if (!dir) return null;
  if (currentFilePath) {
    try {
      const size = fs.statSync(currentFilePath).size;
      if (size < options.maxFileBytes) return currentFilePath;
    } catch {
      // file missing -> fall through and (re)create
    }
  }
  const base = `agent-browser-${dayStamp(Date.now())}`;
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i === 0 ? `${base}.log` : `${base}-${i}.log`);
    try {
      const exists = fs.existsSync(candidate);
      if (!exists) {
        // Owner-only from birth: appendFileSync would create 0666&~umask.
        const fd = fs.openSync(candidate, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        fs.closeSync(fd);
        currentFilePath = candidate;
        pruneOldFiles(dir);
        return candidate;
      }
      if (fs.statSync(candidate).size < options.maxFileBytes) {
        currentFilePath = candidate;
        pruneOldFiles(dir);
        return candidate;
      }
    } catch {
      currentFilePath = candidate;
      return candidate;
    }
  }
  return null;
}

function pruneOldFiles(dir: string): void {
  try {
    const cutoff = Date.now() - options.retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".log")) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* ignore individual failures */
      }
    }
  } catch {
    /* directory unreadable — nothing to prune */
  }
}

// ── Redaction ──────────────────────────────────────────────────────────────

/** Deep-copy a value with sensitive-looking keys replaced. */
export function redactSensitive<T>(value: T, depth = 0): T {
  if (depth > 6) return "[depth-limit]" as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Never let a proxy URL with inline credentials leak into a log file.
    return scrubUrlCredentials(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

function scrubUrlCredentials(text: string): string {
  if (!/:\/\//.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
      return url.toString();
    }
    return text;
  } catch {
    return text;
  }
}

// ── Event log ──────────────────────────────────────────────────────────────

export function newTraceId(): string {
  counter = (counter + 1) % 0xffff;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${counter.toString(36)}`;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS = new Set(Object.keys(LEVEL_ORDER));

function normalizeLevel(level: unknown): LogLevel {
  return LEVELS.has(String(level)) ? (String(level) as LogLevel) : "info";
}

/**
 * Append one structured event. Never throws: observability must not be able to
 * break the feature it is observing.
 *
 * Privacy (R8 P0-1): the in-memory ring is the read-back path for `obs:events`
 * and the diagnostics bundle, so it must never hold plaintext secrets. The
 * entry is redacted BEFORE it is stored; the returned handle is the redacted
 * copy so callers cannot keep a plaintext reference either. Disk was already
 * redacted — memory was not.
 */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): LogEntry {
  const raw: LogEntry = { ts: Date.now(), level: normalizeLevel(level), event: String(event) };
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    raw[key] = value;
  }

  const entry = redactSensitive(raw);
  memoryEvents.push(entry);
  if (memoryEvents.length > DEFAULTS.memoryEvents) memoryEvents.splice(0, memoryEvents.length - DEFAULTS.memoryEvents);

  try {
    const file = activeFile();
    if (file) fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    /* disk full / permissions — drop the write, keep the app running */
  }
  return entry;
}

export const logDebug = (event: string, fields?: Record<string, unknown>) => log("debug", event, fields);
export const logInfo = (event: string, fields?: Record<string, unknown>) => log("info", event, fields);
export const logWarn = (event: string, fields?: Record<string, unknown>) => log("warn", event, fields);
export const logError = (event: string, fields?: Record<string, unknown>) => log("error", event, fields);

/** Read back recent events (newest last). Used by the diagnostics panel. */
export function getRecentEvents(limit = 200, filter?: { level?: LogLevel; event?: string }): LogEntry[] {
  let out = memoryEvents;
  if (filter?.level) out = out.filter((e) => e.level === filter.level);
  if (filter?.event) out = out.filter((e) => e.event === filter.event);
  return out.slice(-Math.max(1, Math.min(limit, DEFAULTS.memoryEvents)));
}

// ── Metrics ────────────────────────────────────────────────────────────────

// Renderer-reachable metric names are untrusted input (obs:timing/counter/gauge
// accept arbitrary strings). Bound both the name length and the key-space size
// so a hostile renderer cannot grow the maps without limit (R8 P1-8).
const MAX_METRIC_NAME_LEN = 128;
const MAX_METRIC_KEYS = 500;

function sanitizeMetricName(name: unknown): string | null {
  const s = String(name || "unnamed").slice(0, MAX_METRIC_NAME_LEN);
  if (!s) return null;
  return s;
}

function metricKeyAllowed(map: Map<string, unknown>, name: string): boolean {
  return map.has(name) || map.size < MAX_METRIC_KEYS;
}

export function recordCounter(name: string, delta = 1): void {
  const key = sanitizeMetricName(name);
  if (!key) return;
  if (!metricKeyAllowed(counters, key)) return;
  const d = Number(delta);
  counters.set(key, (counters.get(key) || 0) + (Number.isFinite(d) ? d : 1));
}

export function setGauge(name: string, value: number): void {
  const key = sanitizeMetricName(name);
  if (!key) return;
  if (!metricKeyAllowed(gauges, key)) return;
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  gauges.set(key, v);
}

export function recordTiming(name: string, ms: number): void {
  const key = sanitizeMetricName(name);
  if (!key) return;
  if (!metricKeyAllowed(timings, key)) return;
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return;
  const samples = timings.get(key) || [];
  samples.push(v);
  if (samples.length > DEFAULTS.timingSamples) samples.splice(0, samples.length - DEFAULTS.timingSamples);
  timings.set(key, samples);
  timingLast.set(key, Date.now());
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

export function getMetricsSnapshot(): MetricsSnapshot {
  const timingOut: Record<string, TimingSummary> = {};
  for (const [name, samples] of timings) {
    const sorted = [...samples].sort((a, b) => a - b);
    timingOut[name] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      lastAt: timingLast.get(name) || 0,
    };
  }
  return {
    generatedAt: Date.now(),
    counters: Object.fromEntries(counters),
    timings: timingOut,
    gauges: Object.fromEntries(gauges),
  };
}

/**
 * Measure a labelled operation end to end. The counter is bumped for both
 * outcomes so success rate is derivable without extra bookkeeping.
 */
export async function measure<T>(name: string, fn: () => Promise<T> | T, fields: Record<string, unknown> = {}): Promise<T> {
  const traceId = (fields.traceId as string) || newTraceId();
  const started = Date.now();
  try {
    const result = await fn();
    recordTiming(name, Date.now() - started);
    recordCounter(`${name}.total`);
    recordCounter(`${name}.success`);
    log("info", `${name}.ok`, { ...fields, traceId, durationMs: Date.now() - started });
    return result;
  } catch (error: any) {
    recordTiming(name, Date.now() - started);
    recordCounter(`${name}.total`);
    recordCounter(`${name}.failure`);
    log("error", `${name}.failed`, { ...fields, traceId, durationMs: Date.now() - started, error: error?.message || String(error) });
    throw error;
  }
}

// ── Diagnostic bundle ──────────────────────────────────────────────────────

export interface DiagnosticBundleResult {
  success: boolean;
  filePath?: string;
  bytes?: number;
  error?: string;
}

const BUNDLE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Write a redacted snapshot (metrics + recent events + environment) to disk.
 * The bundle is capped at 10 MB: if the event log alone would exceed it we
 * trim events instead of shipping an oversized file.
 */
export function exportDiagnosticBundle(extra: Record<string, unknown> = {}): DiagnosticBundleResult {
  const dir = ensureDir();
  if (!dir) return { success: false, error: "Observability is disabled or has no log directory" };

  let events = getRecentEvents(DEFAULTS.memoryEvents);
  let payload = buildBundle(events, extra);
  while (Buffer.byteLength(payload, "utf-8") > BUNDLE_MAX_BYTES && events.length > 50) {
    events = events.slice(-Math.floor(events.length / 2));
    payload = buildBundle(events, extra);
  }

  const filePath = path.join(dir, `diagnostics-${Date.now()}.json`);
  try {
    // Owner-only like the audit log: bundles embed proxy/account metadata.
    const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, payload, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on non-POSIX */ }
    const bytes = fs.statSync(filePath).size;
    log("info", "diagnostics.exported", { filePath, bytes });
    return { success: true, filePath, bytes };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

function buildBundle(events: LogEntry[], extra: Record<string, unknown>): string {
  return JSON.stringify(
    redactSensitive({
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      metrics: getMetricsSnapshot(),
      events,
      extra,
    }),
    null,
    2,
  );
}

// ── Test helpers ───────────────────────────────────────────────────────────

/** Wipe all in-memory state. Intended for unit tests only. */
export function resetObservabilityForTest(): void {
  counters.clear();
  gauges.clear();
  timings.clear();
  timingLast.clear();
  memoryEvents.length = 0;
  currentFilePath = null;
}
