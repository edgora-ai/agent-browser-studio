// Structured data export — lets users (and external systems) pull their data as
// stable JSON. The scenario eval flagged "standard export schema" as a P2
// integration lever. Scopes: profiles / proxies / accounts / runs / jobs / db.
// Secrets are NEVER exported (passwords/keys redacted or omitted).
import { getConfig } from "./config-manager.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import { listJobs } from "./job-store.js";
import { agentDbTables } from "./agent-db.js";
import { redactSensitive } from "./observability.js";

export type ExportScope = "profiles" | "proxies" | "accounts" | "runs" | "jobs" | "db" | "risk" | "all";

/** Every accepted scope. An unknown or empty scope is an explicit failure —
 *  silently exporting nothing (the pre-M2 behavior) looks like success to a
 *  caller that then reads an empty object as "this account has no data". */
export const EXPORT_SCOPES: readonly ExportScope[] = ["profiles", "proxies", "accounts", "runs", "jobs", "db", "risk", "all"] as const;

export function isExportScope(scope: unknown): scope is ExportScope {
  return typeof scope === "string" && (EXPORT_SCOPES as readonly string[]).includes(scope);
}

/** Bounded projection of a persisted verification for the export payload.
 *  Rebuilt field by field (never spread) so a foreign or future config cannot
 *  smuggle extra fields into an export. */
function redactVerification(v: any): any {
  if (!v || typeof v !== "object") return { status: "unverified" };
  const status = v.status;
  if (status === "unverified") return { status: "unverified" };
  if (status === "manual_review") {
    return {
      status,
      checkedAt: typeof v.checkedAt === "number" ? v.checkedAt : undefined,
      reasonCode: typeof v.reasonCode === "string" ? v.reasonCode.slice(0, 80) : "unknown",
      ...(typeof v.verifierId === "string" ? { verifierId: v.verifierId.slice(0, 80) } : {}),
      ...(Number.isInteger(v.verifierVersion) ? { verifierVersion: v.verifierVersion } : {}),
    };
  }
  if (status !== "passed" && status !== "partial" && status !== "failed") return { status: "unverified" };
  // Same completeness bar as the config normalizer: a status without a
  // verifier identity and self-consistent counts is not an auto verdict we are
  // willing to publish, whatever the object claims.
  const c = v.counts;
  if (!c || typeof c !== "object") return { status: "unverified" };
  if (typeof v.verifierId !== "string" || !v.verifierId || !Number.isInteger(v.verifierVersion)) return { status: "unverified" };
  const counts = {
    expected: Number(c.expected) || 0,
    observed: Number(c.observed) || 0,
    inspected: Number(c.inspected) || 0,
    accepted: Number(c.accepted) || 0,
    rejected: Number(c.rejected) || 0,
    missing: Number(c.missing) || 0,
    extra: Number(c.extra) || 0,
  };
  if (counts.inspected !== counts.observed) return { status: "unverified" };
  if (counts.accepted + counts.rejected !== counts.inspected) return { status: "unverified" };
  return {
    status,
    checkedAt: typeof v.checkedAt === "number" ? v.checkedAt : undefined,
    verifierId: v.verifierId.slice(0, 80),
    verifierVersion: v.verifierVersion,
    counts,
    // Issue details are free text derived from scraped content — keep the
    // codes (bounded, machine-readable) and drop the prose.
    issueCodes: Array.isArray(v.issues)
      ? [...new Set(v.issues.map((i: any) => (typeof i?.code === "string" ? i.code.slice(0, 40) : null)).filter(Boolean))] as string[]
      : [],
    issuesTruncated: v.issuesTruncated === true,
  };
}

const SAFE_AGENT_RUN_END_REASONS = new Set([
  "completed",
  "user_cancelled",
  "timeout",
  "round_limit",
  "interrupted",
  "execution_error",
]);

function redactProxy(p: any) {
  if (!p) return p;
  const { password, ...safe } = p;
  return { ...safe, hasPassword: Boolean(password) };
}

function redactProxyDetection(d: any) {
  if (!d) return null;
  return {
    detectedAt: typeof d.detectedAt === "number" ? d.detectedAt : null,
    success: d.success === true,
    exitIp: d.exitIp || null,
    country: d.country || null,
    countryCode: d.countryCode || null,
    timezone: d.timezone || null,
    provider: d.provider || null,
    latencyMs: typeof d.latencyMs === "number" ? d.latencyMs : null,
    error: d.error || null,
  };
}

function redactAgentRun(run: any) {
  if (!run) return run;
  // R10 P0-1: step/run error are free-text (tool output, agent errors) and
  // may embed secrets — redact like the jobs path, or the file-header
  // "Secrets are NEVER exported" promise is broken for runs.
  return {
    id: run.id,
    dirId: typeof run.dirId === "string" ? run.dirId : undefined,
    name: run.name,
    summary: run.summary,
    source: run.source,
    status: run.status,
    endReason: SAFE_AGENT_RUN_END_REASONS.has(run.endReason) ? run.endReason : undefined,
    // Rebuilt field by field rather than spread, so a foreign or future config
    // cannot smuggle extra fields into an export. M2: the real verification
    // (bounded, no issue prose) plus artifact metadata — never payload bytes.
    verification: redactVerification(run.verification),
    artifacts: Array.isArray(run.artifacts) ? run.artifacts.map((a: any) => ({
      id: String(a?.id ?? "").slice(0, 64),
      kind: a?.kind === "file" ? "file" : "dataset",
      name: String(a?.name ?? "").slice(0, 128),
      mediaType: String(a?.mediaType ?? "").slice(0, 80),
      bytes: Number(a?.bytes) || 0,
      sha256: typeof a?.sha256 === "string" ? a.sha256.slice(0, 64) : "",
      completeness: a?.completeness === "partial" ? "partial" : "complete",
      truncated: a?.truncated === true,
      ...(Number.isFinite(a?.rowCount) ? { rowCount: a.rowCount } : {}),
      ...(Number.isFinite(a?.sourceRowCount) ? { sourceRowCount: a.sourceRowCount } : {}),
      ...(Number.isFinite(a?.rejectedRowCount) ? { rejectedRowCount: a.rejectedRowCount } : {}),
      ...(Array.isArray(a?.columns) ? { columns: a.columns.map((c: any) => String(c).slice(0, 64)) } : {}),
      ...(Array.isArray(a?.redactedColumns) && a.redactedColumns.length
        ? { redactedColumns: a.redactedColumns.map((c: any) => String(c).slice(0, 64)) } : {}),
    })) : [],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: Array.isArray(run.steps) ? run.steps.map((step: any) => ({
      id: step.id,
      tool: step.tool,
      ok: step.ok,
      error: redactSensitive(step.error),
      durationMs: step.durationMs,
      timestamp: step.timestamp,
    })) : [],
    variableKeys: Object.keys(run.variables || {}),
    error: redactSensitive(run.error),
  };
}

export function exportData(scope: ExportScope): { scope: string; exportedAt: number; data: any } {
  const cfg = getConfig() as any;
  const out: any = {};
  const want = (s: string) => scope === "all" || scope === s;

  if (want("profiles")) {
    out.profiles = Object.entries(cfg.browserProfiles || {}).map(([dirId, m]: any) => ({
      dirId, name: m.name, platform: m.platform, timezone: m.timezone, locale: m.locale,
      proxyMode: m.proxyMode, proxyName: m.proxyName, tags: Array.isArray(m.tags) ? m.tags : [], createdAt: m.createdAt,
    }));
  }
  if (want("proxies")) {
    const detections = cfg.proxyDetections || {};
    out.proxies = Object.fromEntries(Object.entries(cfg.proxies || {}).map(([n, p]: any) => [n, {
      ...redactProxy(p),
      detection: redactProxyDetection(detections[n]),
    }]));
    out.proxyDetections = Object.fromEntries(Object.entries(detections).map(([n, d]: any) => [n, redactProxyDetection(d)]));
  }
  if (want("accounts")) {
    // Accounts hold credentials — export metadata only, never the password.
    out.accounts = (cfg.accounts || []).map((a: any) => ({
      platformUrl: a.platformUrl, platformUserName: a.platformUserName, tags: a.tags, profileIds: a.profileIds,
    }));
  }
  if (want("runs")) out.runs = agentRunRecorder.listRuns().slice(0, 200).map(redactAgentRun);
  // R8 P1-9: job result/error are free-text (custom-js output, agent errors)
  // and may embed secrets — pass through the same redactor as the log path.
  if (want("jobs")) out.jobs = redactSensitive(listJobs({ limit: 500 }));
  // R11 P2-4: risk/diagnostics scope — proxy health + env-risk history +
  // webrtc summary per profile. Summaries are analyst-facing text (may embed
  // host paths/IPs), so each branch goes through redactSensitive like jobs.
  if (want("risk")) {
    const health = cfg.proxyHealth || {};
    out.proxyHealth = redactSensitive(Object.fromEntries(Object.entries(health).map(([n, h]: any) => [n, {
      score: h.score ?? null, risk: h.risk ?? null, checks: h.checks ?? 0,
      successes: h.successes ?? 0, consecutiveFailures: h.consecutiveFailures ?? 0,
      lastCheckedAt: h.lastCheckedAt ?? null, suggestion: h.suggestion ?? null,
    }])));
    const envHist = cfg.envRiskDiagnostics || {};
    out.envRisk = redactSensitive(Object.fromEntries(Object.entries(envHist).map(([dirId, entries]: any) => [
      dirId, (Array.isArray(entries) ? entries : []).slice(-20).map((en: any) => ({
        at: en.at, ok: en.ok, high: en.high, medium: en.medium, summary: en.summary,
      })),
    ])));
    const wrtc = cfg.webrtcDiagnostics || {};
    out.webrtc = redactSensitive(Object.fromEntries(Object.entries(wrtc).map(([dirId, entries]: any) => [
      dirId, (Array.isArray(entries) ? entries : []).slice(-20).map((en: any) => ({
        at: en.at, success: en.success, summary: en.summary,
        hostIps: en.hostIps || [], mdnsHosts: en.mdnsHosts || [],
      })),
    ])));
  }
  if (want("db")) {
    try {
      out.db = agentDbTables().map((t: any) => ({ name: t.name, rowCount: t.rowCount }));
    } catch { out.db = []; }
  }
  return { scope, exportedAt: Date.now(), data: out };
}
