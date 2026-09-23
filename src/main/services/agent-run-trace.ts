// RunRecorder — owns the lifecycle + persistence + redaction + live events for
// agent run traces. Two entry points (chat-stream, automation agent-task) call
// startRun/recordStep/finishRun and thread runId into executeToolCall.
import { BrowserWindow, type WebContents } from "electron";
import { getConfig, sanitizeTracePayload } from "./config-manager.js";
import { transact } from "./config/store.js";
import { runResultStore, type RunResultManifest } from "./run-result-store.js";
import { cleanupTemplateRowsForRun } from "./run-verifiers.js";
import type { AgentRun, AgentRunArtifactRef, AgentRunEndReason, AgentRunStep, AgentRunVerification } from "../types.js";

const VAR_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
const RESERVED_VAR_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_RUNS = 200;
const MAX_STEPS = 500;
const VAR_VALUE_CAP = 16 * 1024;

export interface StartRunParams {
  source: AgentRun["source"];
  name: string;
  summary?: string;
  dirId?: string;
  webContents?: WebContents;
}

export interface RecordStepParams {
  tool: string;
  args: unknown;
  result?: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
  timestamp?: number;
}

export interface FinishRunMeta {
  endReason?: AgentRunEndReason;
  verification?: AgentRunVerification;
  /** Materialized artifact references (M2). Already committed to the result
   *  store by the caller; this only records the bounded references. */
  artifacts?: AgentRunArtifactRef[];
}

function newRunId(): string {
  return "run_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function newStepId(): string {
  return "step_" + Math.random().toString(36).slice(2, 10);
}

/** Redact + truncate a tool result for both persistence and live events. */
function bodyByteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function redactedVarValue(value: string): string {
  return `[REDACTED:${Buffer.byteLength(String(value), "utf8")}B]`;
}

function summarizeVariables(variables: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables || {})) {
    out[key] = String(value).startsWith("[REDACTED:") ? String(value) : redactedVarValue(value);
  }
  return out;
}

function safeRun(run: AgentRun): AgentRun {
  return { ...run, variables: summarizeVariables(run.variables) };
}

function redactResult(value: unknown): unknown {
  const sanitized = sanitizeTracePayload(value, 16 * 1024) as any;
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return sanitized;
  if (sanitized.value !== undefined) sanitized.value = `[REDACTED_VALUE:${bodyByteLength(sanitized.value)}B]`;
  if (sanitized.body !== undefined) sanitized.body = `[REDACTED_BODY:${bodyByteLength(sanitized.body)}B]`;
  return sanitized;
}
function redactArgs(value: unknown): unknown {
  const sanitized = sanitizeTracePayload(value, 8 * 1024) as any;
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return sanitized;
  if (typeof sanitized.url === "string") sanitized.url = redactTraceUrl(sanitized.url);
  if (sanitized.value !== undefined) sanitized.value = `[REDACTED_VALUE:${bodyByteLength(sanitized.value)}B]`;
  if (sanitized.body !== undefined) sanitized.body = `[REDACTED_BODY:${bodyByteLength(sanitized.body)}B]`;
  return sanitized;
}

/** Keep the newest MAX_RUNS runs (oldest dropped). Mirrors the retention the
 *  config normalizer applies on save, enforced on the draft so the rule holds
 *  at the point of write. Returns the ids of the runs that were dropped. */
function trimRuns(draft: any): string[] {
  if (Array.isArray(draft.agentRuns) && draft.agentRuns.length > MAX_RUNS) {
    const dropped = (draft.agentRuns as AgentRun[]).slice(0, draft.agentRuns.length - MAX_RUNS);
    draft.agentRuns = draft.agentRuns.slice(draft.agentRuns.length - MAX_RUNS);
    return dropped.map((r) => r.id);
  }
  return [];
}

function findRun(draft: any, runId: string): AgentRun | undefined {
  return (draft.agentRuns || []).find((r: AgentRun) => r.id === runId);
}

/** Best-effort removal of result-store payloads and controlled-table rows for
 *  runs that are gone from the config. Config-first: callers invoke this only
 *  after the config mutation has committed. Failures are logged, not thrown —
 *  the startup reconcile converges any leftovers. */
function cleanupRunResultData(runIds: string[]): void {
  for (const runId of runIds) {
    try {
      const res = runResultStore.deleteRunResults(runId);
      if (!res.ok) console.warn(`[runs] result store cleanup failed for ${runId}: ${res.error}`);
    } catch (e) {
      console.warn(`[runs] result store cleanup failed for ${runId}:`, e);
    }
    try {
      cleanupTemplateRowsForRun(runId);
    } catch (e) {
      console.warn(`[runs] template row cleanup failed for ${runId}:`, e);
    }
  }
}

function redactTraceUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = parsed.username ? "[REDACTED]" : "";
    parsed.password = parsed.password ? "[REDACTED]" : "";
    if (parsed.search) {
      const keys = Array.from(parsed.searchParams.keys()).slice(0, 20).join(",");
      parsed.search = keys ? `?keys=${encodeURIComponent(keys)}` : "";
    }
    parsed.hash = parsed.hash ? "#redacted" : "";
    return parsed.toString();
  } catch (_e) {
    return "[invalid-url]";
  }
}

class RunRecorder {
  /** Active runId → the bound webContents (for chat runs). Automation runs broadcast. */
  private runWebContents = new Map<string, WebContents | undefined>();
  private runVariables = new Map<string, Record<string, string>>();

  startRun(p: StartRunParams): AgentRun {
    const run: AgentRun = {
      id: newRunId(),
      dirId: p.dirId ? String(p.dirId).slice(0, 100) : undefined,
      name: String(p.name || "Agent run").slice(0, 160),
      summary: p.summary ? String(p.summary).slice(0, 500) : undefined,
      source: p.source,
      status: "running",
      startedAt: Date.now(),
      steps: [],
      variables: {},
      verification: { status: "unverified" },
    };

    // Commit first: a run that never reached disk must not be announced, and
    // must not be registered as live (callers gate on isActive()).
    let evicted: string[] = [];
    this.commit((draft) => {
      draft.agentRuns = draft.agentRuns || [];
      draft.agentRuns.push(run);
      evicted = trimRuns(draft);
    });
    if (evicted.length) cleanupRunResultData(evicted);
    // Read the run back rather than returning the local object: the value
    // callers receive must be what the normalizer actually stored. A miss here
    // means normalization rejected a run we just committed — surface it instead
    // of handing back a run that is not in the config.
    const persisted = this.persistedRun(run.id);
    if (!persisted) throw new Error(`agent run ${run.id} was persisted but not found after the write`);

    this.runWebContents.set(run.id, p.webContents);
    this.runVariables.set(run.id, {});
    this.emit("agent:run-start", { run: safeRun(persisted) }, p.webContents);
    return persisted;
  }

  recordStep(runId: string, p: RecordStepParams): AgentRunStep | null {
    // Unknown run first, before the payload is redacted/serialized: an unknown
    // runId is a no-op regardless of what was passed in.
    if (!this.hasRun(runId)) return null;
    const step: AgentRunStep = {
      id: newStepId(),
      tool: String(p.tool || "").slice(0, 80),
      args: redactArgs(p.args),
      result: p.result === undefined ? undefined : redactResult(p.result),
      ok: p.ok === true,
      error: p.error ? String(p.error).slice(0, 1000) : undefined,
      durationMs: typeof p.durationMs === "number" ? p.durationMs : 0,
      timestamp: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
    };

    let evicted: string[] = [];
    this.commit((draft) => {
      const run = findRun(draft, runId);
      if (!run) return;
      if (run.steps.length >= MAX_STEPS) {
        // Drop oldest to make room rather than silently stop recording.
        run.steps.shift();
      }
      run.steps.push(step);
      evicted = trimRuns(draft);
    });
    if (evicted.length) cleanupRunResultData(evicted);

    // Return the step as COMMITTED, matched by id: normalization drops a step
    // with an empty tool, and reporting the local object would announce a step
    // that is not in the persisted run.
    const persisted = this.persistedRun(runId);
    const savedStep = persisted?.steps.find((s) => s.id === step.id) || null;
    if (!savedStep) return null;
    this.emit("agent:run-step", { runId, run: persisted ? safeRun(persisted) : null, step: savedStep }, this.runWebContents.get(runId));
    return savedStep;
  }

  setVar(runId: string, key: string, value: unknown): { key: string; value: string } {
    const k = String(key || "");
    if (!VAR_KEY_RE.test(k) || RESERVED_VAR_KEYS.has(k)) {
      return { key: k, value: "[invalid key]" };
    }
    // Unknown run first, before the value is serialized: an unknown runId must
    // not fail on a payload that would never be stored.
    if (!this.hasRun(runId)) return { key: k, value: "[no active run]" };
    const v = typeof value === "string" ? value : JSON.stringify(value);
    const sliced = v.slice(0, VAR_VALUE_CAP);

    let evicted: string[] = [];
    this.commit((draft) => {
      const run = findRun(draft, runId);
      if (!run) return;
      run.variables = run.variables || {};
      run.variables[k] = redactedVarValue(sliced);
      evicted = trimRuns(draft);
    });
    if (evicted.length) cleanupRunResultData(evicted);

    // Only a committed write may enter the in-memory variable map: otherwise a
    // rejected save would leave the raw secret readable via getVar() with
    // nothing on disk backing it.
    const vars = this.runVariables.get(runId) || {};
    vars[k] = sliced;
    this.runVariables.set(runId, vars);
    const persisted = this.persistedRun(runId);
    this.emit("agent:run-step", { runId, run: persisted ? safeRun(persisted) : null, step: null }, this.runWebContents.get(runId));
    return { key: k, value: sliced };
  }

  getVar(runId: string, key: string): { key: string; value: string | null } {
    const k = String(key);
    const vars = this.runVariables.get(runId);
    if (!vars || !Object.hasOwn(vars, k)) return { key: k, value: null };
    return { key: k, value: vars[k] ?? null };
  }

  finishRun(runId: string, status: "done" | "error", error?: string, meta?: FinishRunMeta): AgentRun | null {
    if (!this.hasRun(runId)) return null;
    let evicted: string[] = [];
    this.commit((draft) => {
      const run = findRun(draft, runId);
      if (!run) return;
      run.status = status;
      run.finishedAt = Date.now();
      if (status === "error" && error) run.error = String(error).slice(0, 1000);
      if (meta?.endReason !== undefined) run.endReason = meta.endReason;
      if (meta?.verification !== undefined) run.verification = meta.verification;
      if (meta?.artifacts !== undefined) run.artifacts = meta.artifacts;
      evicted = trimRuns(draft);
    });
    if (evicted.length) cleanupRunResultData(evicted);

    const wc = this.runWebContents.get(runId);
    this.runWebContents.delete(runId);
    this.runVariables.delete(runId);
    const persisted = this.persistedRun(runId);
    this.emit("agent:run-finish", { run: persisted ? safeRun(persisted) : null }, wc);
    return persisted;
  }

  /** Release only process-local bindings once execution has actually stopped.
   *  This is deliberately separate from finishRun: callers use it after a
   *  terminal persistence failure without changing history or claiming that a
   *  finish event was committed. */
  releaseRun(runId: string): void {
    this.runWebContents.delete(runId);
    this.runVariables.delete(runId);
  }

  getRun(runId: string): AgentRun | null {
    const cfg = getConfig() as any;
    const run = (cfg.agentRuns || []).find((r: AgentRun) => r.id === runId) || null;
    return run ? safeRun(run) : null;
  }

  /** Whether the run exists in the committed config (not the live map — a
   *  caller can record into a run after the process restarted it as an error). */
  private hasRun(runId: string): boolean {
    return Boolean(findRun(getConfig() as any, runId));
  }

  /** True while a run is live in memory (started but not yet finished).
   *  Persisted config normalizes active runs to "error" for crash recovery, so
   *  callers that need to tell "running now" from "really failed" must use this. */
  isActive(runId: string): boolean {
    return this.runWebContents.has(runId);
  }

  /** Newest first. */
  listRuns(opts?: { dirId?: string }): AgentRun[] {
    const cfg = getConfig() as any;
    const runs = ((cfg.agentRuns || []) as AgentRun[]).slice().reverse();
    const filtered = opts?.dirId ? runs.filter((r) => r.dirId === opts.dirId) : runs;
    return filtered.map(safeRun);
  }

  deleteRun(runId: string): boolean {
    let removed = false;
    this.commit((draft) => {
      const before = (draft.agentRuns || []).length;
      draft.agentRuns = (draft.agentRuns || []).filter((r: AgentRun) => r.id !== runId);
      removed = (draft.agentRuns as AgentRun[]).length !== before;
    });
    // A write that failed mid-flight throws before reaching here, so the live
    // maps are released only once the removal actually landed — otherwise
    // callers still streaming into the run would lose their binding to a run
    // that the config still contains.
    if (!removed) return false;
    this.runWebContents.delete(runId);
    this.runVariables.delete(runId);
    // Config-first: the run is gone from disk-backed state; now drop its
    // materialized results + controlled-table rows (best effort).
    cleanupRunResultData([runId]);
    return true;
  }

  clearRuns(): number {
    let n = 0;
    let clearedIds: string[] = [];
    this.commit((draft) => {
      clearedIds = ((draft.agentRuns || []) as AgentRun[]).map((r) => r.id);
      n = clearedIds.length;
      draft.agentRuns = [];
    });
    this.runWebContents.clear();
    this.runVariables.clear();
    cleanupRunResultData(clearedIds);
    return n;
  }

  /** Single write path for every mutation. `mutate` runs on the transact draft
   *  (never on the shared getConfig() singleton) so a rejected write — over the
   *  size budget, or a failing tmp/rename — leaves the cache, the file and the
   *  live maps exactly as they were. The failure propagates: callers at the IPC,
   *  REST and MCP boundaries already turn it into an error response, and the
   *  agent tool executor turns it into a tool error, so a trace that cannot be
   *  persisted surfaces instead of quietly recording nothing. */
  private commit(mutate: (draft: any) => void): void {
    transact(mutate);
  }

  /** The committed view of a run — read back after the write so returns and
   *  events carry what the normalizer actually stored, not the pre-commit
   *  draft. Only plain trace data is cloned here; live WebContents handles stay
   *  in runWebContents and are never cloned. */
  private persistedRun(runId: string): AgentRun | null {
    const cfg = getConfig() as any;
    const run = (cfg.agentRuns || []).find((r: AgentRun) => r.id === runId) || null;
    return run ? structuredClone(run) : null;
  }

  private emit(channel: string, payload: unknown, wc?: WebContents): void {
    try {
      if (wc && !wc.isDestroyed()) wc.send(channel, payload);
      for (const win of BrowserWindow.getAllWindows()) {
        const contents = win.webContents;
        if (contents && !contents.isDestroyed() && (!wc || contents.id !== wc.id)) {
          contents.send(channel, payload);
        }
      }
    } catch {
      /* ignore — tests may run without windows */
    }
  }
}

export const agentRunRecorder = new RunRecorder();

// ── Startup reconcile (M2) ──
// Converges config.json references with the on-disk result store. Runs once
// at startup before IPC handlers and the scheduler come up. Never triggers
// any agent/network/browser action; never deletes config entries.
const RECONCILE_END_REASONS = new Set<AgentRunEndReason>([
  "completed", "user_cancelled", "timeout", "round_limit", "interrupted", "execution_error",
]);

export interface ReconcileReport {
  tmpFilesRemoved: number;
  orphanDirsRemoved: number;
  refsBackfilled: number;
  terminalReplayed: number;
  refsDropped: number;
}

export function reconcileRunResults(): ReconcileReport {
  const report: ReconcileReport = { tmpFilesRemoved: 0, orphanDirsRemoved: 0, refsBackfilled: 0, terminalReplayed: 0, refsDropped: 0 };
  try {
    report.tmpFilesRemoved = runResultStore.sweepTempFiles();
  } catch (e) {
    console.warn("[runs] reconcile: tmp sweep failed:", e);
  }

  const cfg = getConfig() as any;
  const runs: AgentRun[] = Array.isArray(cfg.agentRuns) ? cfg.agentRuns : [];
  const byId = new Map(runs.map((r) => [r.id, r] as const));

  let storedIds: string[] = [];
  try {
    storedIds = runResultStore.listStoredRunIds();
  } catch (e) {
    console.warn("[runs] reconcile: listing stored runs failed:", e);
  }
  const storedSet = new Set(storedIds);

  const backfill = new Map<string, { verification?: AgentRunVerification; artifacts?: AgentRunArtifactRef[] }>();
  const replay = new Map<string, { status: "done" | "error"; endReason?: AgentRunEndReason; finishedAt?: number; error?: string; verification?: AgentRunVerification; artifacts?: AgentRunArtifactRef[] }>();
  const dropRefs = new Set<string>();

  for (const runId of storedIds) {
    const run = byId.get(runId);
    if (!run) {
      // Orphan directory: the run was deleted or evicted by retention. Remove
      // its payloads + controlled-table rows. Failures are retried next boot.
      try {
        const res = runResultStore.deleteRunResults(runId);
        if (res.ok) report.orphanDirsRemoved++;
        else console.warn(`[runs] reconcile: orphan cleanup failed for ${runId}: ${res.error}`);
      } catch (e) {
        console.warn(`[runs] reconcile: orphan cleanup failed for ${runId}:`, e);
      }
      try {
        cleanupTemplateRowsForRun(runId);
      } catch { /* logged inside cleanup on a per-verifier basis */ }
      continue;
    }
    let manifest: RunResultManifest | null = null;
    try {
      const m = runResultStore.readManifest(runId);
      manifest = m.ok ? m.value : null;
    } catch {
      manifest = null;
    }
    if (!manifest) {
      // Config references a missing/corrupt manifest → drop refs, downgrade.
      if (run.artifacts && run.artifacts.length) dropRefs.add(runId);
      continue;
    }
    const terminal = manifest.terminal;
    const terminalValid = terminal && (terminal.status === "done" || terminal.status === "error");
    const needsReplay = terminalValid
      && run.status === "error"
      && run.endReason === "interrupted"
      && manifest.runStartedAt === run.startedAt
      && manifest.templateId === run.source?.templateId
      && manifest.templateVersion === run.source?.templateVersion;
    if (needsReplay) {
      replay.set(runId, {
        status: terminal.status,
        endReason: RECONCILE_END_REASONS.has(terminal.endReason as AgentRunEndReason) ? terminal.endReason as AgentRunEndReason : undefined,
        finishedAt: typeof terminal.finishedAt === "number" ? terminal.finishedAt : undefined,
        error: terminal.status === "error" && typeof terminal.error === "string" ? terminal.error.slice(0, 1000) : undefined,
        verification: manifest.verification,
        artifacts: manifest.artifacts,
      });
      continue;
    }
    const lacksRefs = !(run.artifacts && run.artifacts.length);
    const lacksVerdict = !run.verification || run.verification.status === "unverified";
    if (lacksRefs || lacksVerdict) {
      backfill.set(runId, {
        ...(lacksRefs ? { artifacts: manifest.artifacts } : {}),
        ...(lacksVerdict ? { verification: manifest.verification } : {}),
      });
    }
  }

  // Config runs whose refs point at a store directory that no longer exists.
  for (const run of runs) {
    if (run.artifacts && run.artifacts.length && !storedSet.has(run.id) && !dropRefs.has(run.id)) {
      dropRefs.add(run.id);
    }
  }

  if (backfill.size || replay.size || dropRefs.size) {
    try {
      transact((draft: any) => {
        for (const r of (draft.agentRuns || []) as AgentRun[]) {
          const rp = replay.get(r.id);
          if (rp) {
            r.status = rp.status;
            if (rp.endReason !== undefined) r.endReason = rp.endReason;
            if (rp.finishedAt !== undefined) r.finishedAt = rp.finishedAt;
            if (rp.error !== undefined) r.error = rp.error;
            if (rp.verification !== undefined) r.verification = rp.verification;
            if (rp.artifacts !== undefined) r.artifacts = rp.artifacts;
            continue;
          }
          const bf = backfill.get(r.id);
          if (bf) {
            if (bf.artifacts !== undefined) r.artifacts = bf.artifacts;
            if (bf.verification !== undefined) r.verification = bf.verification;
            continue;
          }
          if (dropRefs.has(r.id)) {
            delete r.artifacts;
            r.verification = { status: "manual_review", checkedAt: Date.now(), reasonCode: "integrity_error" };
          }
        }
      });
      report.refsBackfilled = backfill.size;
      report.terminalReplayed = replay.size;
      report.refsDropped = dropRefs.size;
    } catch (e) {
      console.error("[runs] reconcile: config repair failed:", e);
    }
  }
  return report;
}
