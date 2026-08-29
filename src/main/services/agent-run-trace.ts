// RunRecorder — owns the lifecycle + persistence + redaction + live events for
// agent run traces. Two entry points (chat-stream, automation agent-task) call
// startRun/recordStep/finishRun and thread runId into executeToolCall.
import { BrowserWindow, type WebContents } from "electron";
import { getConfig, saveConfig, sanitizeTracePayload } from "./config-manager.js";
import type { AgentRun, AgentRunStep } from "../types.js";

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
    };
    this.runWebContents.set(run.id, p.webContents);
    this.runVariables.set(run.id, {});

    const cfg = getConfig() as any;
    cfg.agentRuns = cfg.agentRuns || [];
    cfg.agentRuns.push(run);
    this.trimAndSave(cfg);
    this.emit("agent:run-start", { run: safeRun(run) }, p.webContents);
    return run;
  }

  recordStep(runId: string, p: RecordStepParams): AgentRunStep | null {
    const cfg = getConfig() as any;
    const run: AgentRun | undefined = (cfg.agentRuns || []).find((r: AgentRun) => r.id === runId);
    if (!run) return null;
    if (run.steps.length >= MAX_STEPS) {
      // Drop oldest to make room rather than silently stop recording.
      run.steps.shift();
    }
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
    run.steps.push(step);
    this.trimAndSave(cfg);
    this.emit("agent:run-step", { runId, run: safeRun(run), step }, this.runWebContents.get(runId));
    return step;
  }

  setVar(runId: string, key: string, value: unknown): { key: string; value: string } {
    const k = String(key || "");
    if (!VAR_KEY_RE.test(k) || RESERVED_VAR_KEYS.has(k)) {
      return { key: k, value: "[invalid key]" };
    }
      const v = typeof value === "string" ? value : JSON.stringify(value);
    const sliced = v.slice(0, VAR_VALUE_CAP);

    const cfg = getConfig() as any;
    const run: AgentRun | undefined = (cfg.agentRuns || []).find((r: AgentRun) => r.id === runId);
    if (!run) return { key: k, value: "[no active run]" };
    const vars = this.runVariables.get(runId) || {};
    vars[k] = sliced;
    this.runVariables.set(runId, vars);
    run.variables = run.variables || {};
    run.variables[k] = redactedVarValue(sliced);
    this.trimAndSave(cfg);
    this.emit("agent:run-step", { runId, run: safeRun(run), step: null }, this.runWebContents.get(runId));
    return { key: k, value: sliced };
  }

  getVar(runId: string, key: string): { key: string; value: string | null } {
    const k = String(key);
    const vars = this.runVariables.get(runId);
    if (!vars || !Object.hasOwn(vars, k)) return { key: k, value: null };
    return { key: k, value: vars[k] ?? null };
  }

  finishRun(runId: string, status: "done" | "error", error?: string): AgentRun | null {
    const cfg = getConfig() as any;
    const run: AgentRun | undefined = (cfg.agentRuns || []).find((r: AgentRun) => r.id === runId);
    if (!run) return null;
    run.status = status;
    run.finishedAt = Date.now();
    if (status === "error" && error) run.error = String(error).slice(0, 1000);
    this.trimAndSave(cfg);
    const wc = this.runWebContents.get(runId);
    this.runWebContents.delete(runId);
    this.runVariables.delete(runId);
    this.emit("agent:run-finish", { run: safeRun(run) }, wc);
    return run;
  }

  getRun(runId: string): AgentRun | null {
    const cfg = getConfig() as any;
    const run = (cfg.agentRuns || []).find((r: AgentRun) => r.id === runId) || null;
    return run ? safeRun(run) : null;
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
    const cfg = getConfig() as any;
    const before = (cfg.agentRuns || []).length;
    cfg.agentRuns = (cfg.agentRuns || []).filter((r: AgentRun) => r.id !== runId);
    const after = cfg.agentRuns.length;
    if (before !== after) {
      saveConfig(cfg);
      this.runWebContents.delete(runId);
      this.runVariables.delete(runId);
    }
    return before !== after;
  }

  clearRuns(): number {
    const cfg = getConfig() as any;
    const n = (cfg.agentRuns || []).length;
    cfg.agentRuns = [];
    saveConfig(cfg);
    this.runWebContents.clear();
    this.runVariables.clear();
    return n;
  }

  private trimAndSave(_cfg: any): void {
    try {
      const { transact } = require("./config/store.js");
      // We already mutated the singleton in-place; persist current snapshot transactionally
      // To avoid double-apply, just persist current cache via transact no-op
      const { getConfig } = require("./config-manager.js");
      const snap = getConfig();
      transact((draft: any) => { draft.agentRuns = snap.agentRuns; draft.agentFs = snap.agentFs; });
      return;
    } catch {}
    saveConfig(_cfg);
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
