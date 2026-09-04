// Structured data export — lets users (and external systems) pull their data as
// stable JSON. The scenario eval flagged "standard export schema" as a P2
// integration lever. Scopes: profiles / proxies / accounts / runs / jobs / db.
// Secrets are NEVER exported (passwords/keys redacted or omitted).
import { getConfig } from "./config-manager.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import { listJobs } from "./job-store.js";
import { agentDbTables } from "./agent-db.js";
import { redactSensitive } from "./observability.js";

export type ExportScope = "profiles" | "proxies" | "accounts" | "runs" | "jobs" | "db" | "all";

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
    name: run.name,
    summary: run.summary,
    source: run.source,
    status: run.status,
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
  if (want("db")) {
    try {
      out.db = agentDbTables().map((t: any) => ({ name: t.name, rowCount: t.rowCount }));
    } catch { out.db = []; }
  }
  return { scope, exportedAt: Date.now(), data: out };
}
