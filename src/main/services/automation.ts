// 自动化引擎 — 定时任务(cron) + 单次定时(once) + 事件触发(event)
// 复用 launchBrowser/stopBrowser/agentChat/syncService 执行动作。
import type { AutomationRule, AutomationAction } from "../types.js";
import { getConfig, saveConfig } from "./config-manager.js";
import { launchBrowser, stopBrowser, statusBrowser } from "./browser-manager.js";
import { agentChat, getOrDetectLlmConfig, type LlmConfig } from "./local-agent.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import { syncService } from "./sync-service.js";
import { onEvent } from "./event-bus.js";
import { JobGuard, withTimeout, DEFAULT_JOB_GUARD_CONFIG } from "./job-guard.js";
import { enqueueJob, markRunning, markDone, markFailed, markSkipped, markCancelled, markJobRunId, recoverInterruptedJobs, getJob } from "./job-store.js";
import { runSandboxed } from "./script-sandbox.js";

function runTimeoutMsFor(rule: AutomationRule): number {
  return jobGuard.configFor(rule).runTimeoutMs;
}

// ── 调度状态 ──
const timers = new Map<string, NodeJS.Timeout>(); // ruleId -> timer (cron/once)
const retryTimers = new Map<string, NodeJS.Timeout>(); // ruleId -> retry timer
let started = false;
let stopping = false;
let schedulerGeneration = 0;
let recoveredInterruptedJobsOnStartup = false;

// ── 执行硬化(超时/防重入/失败计数/冷却/重试) ──
export const jobGuard = new JobGuard();

// ── 执行日志(内存,最近 200 条) ──
interface RunLog { ruleId: string; ruleName: string; at: number; ok: boolean; result: string; }
const runLogs: RunLog[] = [];

/** Persist runtime state (lastRun + guard state) into the rule in config. */
function persistRunState(rule: AutomationRule, ok: boolean, result: string, error?: string) {
  runLogs.push({ ruleId: rule.id, ruleName: rule.name, at: Date.now(), ok, result: result.slice(0, 500) });
  if (runLogs.length > 200) runLogs.shift();
  try {
    const cfg = getConfig() as any;
    const rules: AutomationRule[] = cfg.automation || [];
    const r = rules.find((x) => x.id === rule.id);
    if (r) {
      r.lastRunAt = Date.now();
      r.lastResult = result.slice(0, 500);
      const g = jobGuard.getState(rule.id);
      r.failureCount = g.consecutiveFailures;
      r.lastError = ok ? undefined : (error || g.lastError);
      r.cooldownUntil = g.cooldownUntil || undefined;
      saveConfig(cfg);
    }
  } catch { /* ignore */ }
}
export function getRunLogs(): RunLog[] { return runLogs.slice().reverse(); }

// ── 动作执行 ──
interface ExecuteActionContext { jobId?: string; signal?: AbortSignal; }

const activeJobControllers = new Map<string, AbortController>();
const cancelledJobIds = new Set<string>();
const activeJobIds = new Set<string>();
const eventUnsubscribers: Array<() => void> = [];

function assertActionNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("automation job cancelled");
}

async function executeAction(rule: AutomationRule, context: ExecuteActionContext = {}): Promise<string> {
  assertActionNotAborted(context.signal);
  const a = rule.action;
  try {
    switch (a.type) {
      case "launch-profile": {
        if (!a.profileDirId) throw new Error("missing profileDirId");
        const r = await launchBrowser(a.profileDirId);
        assertActionNotAborted(context.signal);
        return `launched pid=${r.pid} cdpPort=${r.cdpPort}`;
      }
      case "stop-profile": {
        if (!a.profileDirId) throw new Error("missing profileDirId");
        const ok = stopBrowser(a.profileDirId);
        assertActionNotAborted(context.signal);
        return ok ? "stopped" : "not running";
      }
      case "agent-task": {
        if (!a.agentPrompt) throw new Error("missing agentPrompt");
        const dirIds = (Array.isArray(a.profileDirIds) && a.profileDirIds.length > 0)
          ? a.profileDirIds
          : (a.profileDirId ? [a.profileDirId] : []);
        if (dirIds.length === 0) throw new Error("missing profileDirId/profileDirIds");
        const config = getOrDetectLlmConfig();
        if (!config) throw new Error("no LLM config");
        if (dirIds.length === 1) {
          const out = await runAgentTaskOnProfile(rule, config, dirIds[0], a, context);
          if (!out.ok) throw new Error(`agent error: ${out.error} (run ${out.runId})`);
          return `agent done (run ${out.runId})`;
        }
        // Batch mode: same prompt on every profile, one scoped run per profile, with
        // optional parallel workers (concurrency; default 1 = sequential). Per-profile
        // failures are recorded as error runs; the job keeps going so the rest of the
        // batch still completes, then the summary reports N ok / M failed.
        const concurrency = Math.max(1, Math.min(a.concurrency ?? 1, 16));
        const results: (AgentTaskOutcome | undefined)[] = new Array(dirIds.length);
        let nextIdx = 0;
        const workerCount = Math.min(concurrency, dirIds.length);
        const workers = Array.from({ length: workerCount }, async () => {
          while (true) {
            if (context.signal?.aborted) return;
            const idx = nextIdx++;
            if (idx >= dirIds.length) return;
            results[idx] = await runAgentTaskOnProfile(rule, config, dirIds[idx], a, context);
          }
        });
        await Promise.all(workers);
        assertActionNotAborted(context.signal);
        const outcomes = results.filter((x): x is AgentTaskOutcome => Boolean(x));
        const okCount = outcomes.filter((x) => x.ok).length;
        const failed = outcomes.filter((x) => !x.ok);
        const runIds = outcomes.map((x) => x.runId).filter(Boolean).join(",");
        if (failed.length > 0) {
          return `agent batch: ${okCount} ok / ${failed.length} failed (runs ${runIds}; first error: ${failed[0].error})`;
        }
        return `agent batch done: ${okCount} ok / 0 failed (runs ${runIds})`;
      }
      case "sync-push": {
        assertActionNotAborted(context.signal);
        const r = await syncService.push(context.signal);
        assertActionNotAborted(context.signal);
        return r.success ? `pushed: ${r.message}` : `push failed: ${r.message}`;
      }
      case "sync-pull": {
        assertActionNotAborted(context.signal);
        const r = await syncService.pull(context.signal);
        assertActionNotAborted(context.signal);
        return r.success ? `pulled: ${r.message}` : `pull failed: ${r.message}`;
      }
      case "custom-js": {
        if (!a.jsCode) throw new Error("missing jsCode");
        assertActionNotAborted(context.signal);
        // Sandboxed: no require/process/fs/global; sync-loop timeout bounded.
        const logs: string[] = [];
        const r = await Promise.resolve(runSandboxed(a.jsCode, {
          logger: (m: string) => { logs.push(m); if (logs.length <= 20) console.log(`[custom-js:${rule.name}] ${m}`); },
        }, Math.min(runTimeoutMsFor(rule), 60_000)));
        assertActionNotAborted(context.signal);
        const summary = logs.length ? ` (logs: ${logs.slice(0, 3).join(" | ")})` : "";
        return `js result: ${JSON.stringify(r).slice(0, 200)}${summary}`;
      }
      default:
        throw new Error(`unknown action type: ${a.type}`);
    }
  } catch (e: any) {
    throw e;
  }
}

interface AgentTaskOutcome { dirId: string; runId: string; ok: boolean; error?: string; }

/** Run one agent task on one profile: launch if needed, own run trace, scoped system prompt. */
async function runAgentTaskOnProfile(
  rule: AutomationRule,
  config: LlmConfig,
  dirId: string,
  action: AutomationAction,
  context: ExecuteActionContext,
): Promise<AgentTaskOutcome> {
  try {
    // 启动 profile(若未运行),让 agent 有 CDP target
    const st = statusBrowser(dirId);
    if (!st.running) await launchBrowser(dirId);
  } catch (e: any) {
    return { dirId, runId: "", ok: false, error: `launch failed: ${e?.message || String(e)}` };
  }
  assertActionNotAborted(context.signal);
  const run = agentRunRecorder.startRun({
    source: { type: "automation", ruleId: rule.id, ruleName: rule.name, jobId: context.jobId },
    name: rule.name || "Automation agent task",
    summary: String(action.agentPrompt || "").slice(0, 500),
    dirId,
  });
  if (context.jobId) {
    try {
      markJobRunId(context.jobId, run.id);
    } catch (e) {
      console.warn(`[automation] failed to link job ${context.jobId} to run ${run.id}:`, e);
    }
  }
  try {
    const result = await agentChat(config, [{ role: "user", content: action.agentPrompt || "" }], {
      runId: run.id,
      signal: context.signal,
      profileDirId: dirId,
    });
    agentRunRecorder.finishRun(run.id, result.error ? "error" : "done", result.error);
    if (result.error) return { dirId, runId: run.id, ok: false, error: result.error };
    return { dirId, runId: run.id, ok: true };
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    agentRunRecorder.finishRun(run.id, "error", errMsg);
    return { dirId, runId: run.id, ok: false, error: errMsg };
  }
}

/**
 * Execute a rule with hardening: re-entry lock, timeout, failure counting,
 * cooldown, and retry-with-backoff. `attempt` is 0-indexed (0 = first try).
 * The guard persists failureCount/lastError/cooldownUntil onto the rule.
 */
async function runRule(rule: AutomationRule, attempt = 0, source: "cron" | "once" | "event" = "cron", generation = schedulerGeneration): Promise<void> {
  if (generation !== schedulerGeneration || stopping) return;
  const now = Date.now();
  const decision = jobGuard.tryBegin(rule.id, now);
  if (!decision.run) {
    // Record the skip as a durable job for observability.
    try {
      const j = enqueueJob({ ruleId: rule.id, ruleName: rule.name, source });
      markSkipped(j.id, `skipped: ${decision.reason}`);
    } catch { /* ignore */ }
    console.log(`[automation] ⏭️ ${rule.name}: skipped (${decision.reason})`);
    return;
  }
  const cfg = jobGuard.configFor(rule);
  let slotAcquired = false;
  let job: { id: string } | null = null;
  try {
    // Global concurrency cap — overlapping different-rule runs queue up after the per-rule guard is held.
    try {
      await acquireRunSlot();
    } catch (e: any) {
      console.log(`[automation] ⏹️ ${rule.name}: ${e?.message || String(e)}`);
      return;
    }
    slotAcquired = true;
    if (generation !== schedulerGeneration || stopping || !isRuleStillRunnable(rule.id)) {
      jobGuard.cancel(rule.id, Date.now());
      return;
    }
    try { job = enqueueJob({ ruleId: rule.id, ruleName: rule.name, source }); markRunning(job.id, attempt); if (job?.id) activeJobIds.add(job.id); } catch { /* ignore */ }
    let ok = false;
    let resultText = "";
    let errMsg: string | undefined;
    try {
      resultText = await withTimeout((signal) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (job?.id) activeJobControllers.set(job.id, controller);
        return executeAction(rule, { jobId: job?.id, signal: controller.signal }).finally(() => {
          signal?.removeEventListener("abort", abort);
          if (job?.id) activeJobControllers.delete(job.id);
        });
      }, cfg.runTimeoutMs, `automation:${rule.name}`);
      ok = true;
      console.log(`[automation] ✅ ${rule.name}: ${resultText}`);
    } catch (e: any) {
      errMsg = e.message || String(e);
      resultText = `error: ${errMsg}`;
      console.error(`[automation] ❌ ${rule.name} (attempt ${attempt + 1}):`, errMsg);
    }
      const cancelled = Boolean(job?.id && cancelledJobIds.has(job.id)) || stopping;
    const end = cancelled
      ? jobGuard.cancel(rule.id, Date.now())
      : jobGuard.end(rule.id, ok, errMsg, attempt, {
        maxRetries: cfg.maxRetries,
        cooldownAfterFailures: DEFAULT_JOB_GUARD_CONFIG.cooldownAfterFailures,
        cooldownMs: DEFAULT_JOB_GUARD_CONFIG.cooldownMs,
        retryBaseMs: DEFAULT_JOB_GUARD_CONFIG.retryBaseMs,
        retryMaxMs: DEFAULT_JOB_GUARD_CONFIG.retryMaxMs,
      }, Date.now());
    if (job) {
      try {
        if (ok) markDone(job.id, resultText);
        else if (cancelled) markCancelled(job.id);
        else markFailed(job.id, errMsg || resultText);
      } catch { /* ignore */ }
    }
    persistRunState(rule, ok, ok ? resultText : resultText, errMsg);
    if (end.enteredCooldown) {
      console.warn(`[automation] 🧊 ${rule.name}: entered cooldown after ${jobGuard.getState(rule.id).consecutiveFailures} consecutive failures`);
    }
    if (job?.id) {
      activeJobIds.delete(job.id);
      cancelledJobIds.delete(job.id);
    }
    if (end.scheduleRetry && generation === schedulerGeneration && !stopping && isRuleStillRunnable(rule.id)) {
      console.log(`[automation] 🔁 ${rule.name}: retry ${attempt + 2}/${cfg.maxRetries + 1} in ${end.retryDelayMs}ms`);
      clearRetry(rule.id);
      const t = setTimeout(() => {
        retryTimers.delete(rule.id);
        const currentRule = getRunnableRule(rule.id);
        if (currentRule && generation === schedulerGeneration && !stopping) runRule(currentRule, attempt + 1, source, generation);
      }, end.retryDelayMs);
      retryTimers.set(rule.id, t);
    }
  } finally {
    if (slotAcquired) releaseRunSlot();
    else jobGuard.cancel(rule.id, Date.now());
  }
}

function getRunnableRule(ruleId: string): AutomationRule | null {
  try {
    const cfg = getConfig() as any;
    const rules: AutomationRule[] = cfg.automation || [];
    return rules.find((x) => x.id === ruleId && x.enabled !== false) || null;
  } catch {
    return null;
  }
}

function isRuleStillRunnable(ruleId: string): boolean {
  return Boolean(getRunnableRule(ruleId));
}

// ── Global concurrency cap ──
function maxConcurrent(): number {
  try { return Math.max(1, (getConfig() as any)?.maxConcurrentJobs ?? 3); } catch { return 3; }
}
let activeRuns = 0;
const slotQueue: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
function acquireRunSlot(): Promise<void> {
  if (stopping) return Promise.reject(new Error("automation scheduler stopping"));
  if (activeRuns < maxConcurrent()) { activeRuns++; return Promise.resolve(); }
  return new Promise((resolve, reject) => { slotQueue.push({ resolve: () => { activeRuns++; resolve(); }, reject }); });
}
function releaseRunSlot(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  if (slotQueue.length && !stopping) { const next = slotQueue.shift()!; next.resolve(); }
}
function rejectQueuedRunSlots(reason: string): void {
  while (slotQueue.length) slotQueue.shift()!.reject(new Error(reason));
}

function clearRetry(ruleId: string): void {
  const t = retryTimers.get(ruleId);
  if (t) { clearTimeout(t); retryTimers.delete(ruleId); }
}

function clearAllRetries(): void {
  for (const id of [...retryTimers.keys()]) clearRetry(id);
}

// ── cron 解析(轻量,5 字段: min hour dom mon dow) ──
function parseCronField(field: string, min: number, max: number): number[] {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const f = part.trim();
    if (f === "*") { for (let i = min; i <= max; i++) result.add(i); continue; }
    const stepMatch = f.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      for (let i = min; i <= max; i += step) result.add(i);
      continue;
    }
    const rangeMatch = f.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]), hi = Number(rangeMatch[2]), step = Number(rangeMatch[3] || 1);
      for (let i = lo; i <= hi; i += step) result.add(i);
      continue;
    }
    const n = Number(f);
    if (Number.isInteger(n) && n >= min && n <= max) result.add(n);
    else throw new Error(`invalid cron field value: ${f}`);
  }
  return [...result];
}

export function validateCron(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron must have 5 fields: min hour dom mon dow");
  parseCronField(parts[0], 0, 59); // min
  parseCronField(parts[1], 0, 23); // hour
  parseCronField(parts[2], 1, 31); // dom
  parseCronField(parts[3], 1, 12); // mon
  parseCronField(parts[4], 0, 6);  // dow (0=Sun)
}

// 算 cron 下次触发时间(从 now 之后)
function nextCronTime(expr: string, now: Date): number {
  const [minF, hourF, domF, monF, dowF] = expr.trim().split(/\s+/);
  const mins = parseCronField(minF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const mons = parseCronField(monF, 1, 12);
  const dows = parseCronField(dowF, 0, 6);
  // 从下一分钟开始搜(最多扫一年)
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (mons.includes(t.getMonth() + 1) && doms.includes(t.getDate()) && dows.includes(t.getDay()) && hours.includes(t.getHours()) && mins.includes(t.getMinutes())) {
      return t.getTime();
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error("no next cron time found within a year");
}

// ── 调度单个规则 ──
function scheduleRule(rule: AutomationRule): void {
  clearRule(rule.id);
  if (!rule.enabled) return;
  if (rule.trigger.type === "event") return; // 事件触发由总线处理,不主动调度

  const now = Date.now();
  if (rule.trigger.type === "once") {
    const at = rule.trigger.at || 0;
    const delay = at - now;
    if (delay < 0) return; // 已过期
    const generation = schedulerGeneration;
    const timer = setTimeout(() => {
      if (generation !== schedulerGeneration || stopping || !isRuleStillRunnable(rule.id)) return;
      runRule(rule, 0, "once", generation);
      // 执行后自动 disable
      if (generation !== schedulerGeneration || stopping) return;
      const cfg = getConfig() as any;
      const rules: AutomationRule[] = cfg.automation || [];
      const r = rules.find((x) => x.id === rule.id);
      if (r && r.enabled !== false) { r.enabled = false; saveConfig(cfg); }
      timers.delete(rule.id);
    }, delay);
    timers.set(rule.id, timer);
  } else if (rule.trigger.type === "cron") {
    if (!rule.trigger.cron) return;
    try {
      validateCron(rule.trigger.cron);
    } catch (e) {
      console.error(`[automation] invalid cron for ${rule.name}:`, (e as Error).message);
      return;
    }
    const generation = schedulerGeneration;
    const armNext = () => {
      if (generation !== schedulerGeneration || stopping || !isRuleStillRunnable(rule.id)) return;
      const next = nextCronTime(rule.trigger.cron!, new Date());
      const remaining = next - Date.now();
      // setTimeout overflows past ~24.8 days (2^31-1 ms) and fires immediately,
      // which would spin a monthly/yearly cron in a tight loop. Cap each armed
      // wait at one day and re-evaluate; the final day arms the real fire.
      const MAX_ARM_MS = 24 * 3600 * 1000;
      if (remaining <= MAX_ARM_MS) {
        timers.set(rule.id, setTimeout(() => { runRule(rule, 0, "cron", generation); if (generation === schedulerGeneration && !stopping) armNext(); }, Math.max(remaining, 0)));
      } else {
        timers.set(rule.id, setTimeout(() => { if (generation === schedulerGeneration && !stopping) armNext(); }, MAX_ARM_MS));
      }
    };
    armNext();
  }
}

function clearRule(ruleId: string): void {
  const t = timers.get(ruleId);
  if (t) { clearTimeout(t); timers.delete(ruleId); }
  clearRetry(ruleId);
}

// ── 事件触发注册 ──
function registerEventTriggers(): void {
  if (eventUnsubscribers.length) return;
  eventUnsubscribers.push(onEvent("profile:launched", (payload) => {
    handleEvent("profile:launched", String(payload.dirId || ""));
  }));
  eventUnsubscribers.push(onEvent("profile:exited", (payload) => {
    handleEvent("profile:exited", String(payload.dirId || ""));
  }));
}

function unregisterEventTriggers(): void {
  while (eventUnsubscribers.length) {
    try { eventUnsubscribers.pop()!(); } catch { /* ignore */ }
  }
}

function handleEvent(eventName: string, dirId: string): void {
  const cfg = getConfig() as any;
  const rules: AutomationRule[] = cfg.automation || [];
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger.type !== "event" || rule.trigger.event !== eventName) continue;
    if (rule.trigger.profileFilter && rule.trigger.profileFilter !== dirId) continue;
    runRule(rule, 0, "event");
  }
}

// ── 公共 API ──
export function startScheduler(): void {
  if (started) return;
  stopping = false;
  started = true;
  // Recover jobs interrupted by a prior crash/quit once per process. A stop/start
  // inside the same process may still have async cancellations unwinding.
  if (!recoveredInterruptedJobsOnStartup) {
    recoveredInterruptedJobsOnStartup = true;
    try {
      const n = recoverInterruptedJobs();
      if (n > 0) console.log(`[automation] recovered ${n} interrupted job(s)`);
    } catch (e) { console.error("[automation] job recovery failed:", e); }
  }
  registerEventTriggers();
  reloadSchedule();
  console.log("[automation] scheduler started");
}

export function reloadSchedule(): void {
  schedulerGeneration++;
  const cfg = getConfig() as any;
  const rules: AutomationRule[] = cfg.automation || [];
  // 清掉所有定时器/队列,重新调度；已在运行的 job 继续由自身 guard 收尾。
  rejectQueuedRunSlots("automation schedule reloaded");
  for (const id of [...timers.keys()]) clearRule(id);
  clearAllRetries();
  // Hydrate the guard from persisted runtime state so failure counts /
  // cooldowns survive a restart.
  for (const rule of rules) {
    jobGuard.hydrate(rule.id, { failureCount: rule.failureCount, lastError: rule.lastError, cooldownUntil: rule.cooldownUntil });
    scheduleRule(rule);
  }
}

export function cancelRunningJob(jobId: string): void {
  cancelledJobIds.add(jobId);
  activeJobControllers.get(jobId)?.abort();
}

export function stopScheduler(): void {
  schedulerGeneration++;
  stopping = true;
  rejectQueuedRunSlots("automation scheduler stopping");
  for (const id of [...timers.keys()]) clearRule(id);
  clearAllRetries();
  for (const id of activeJobIds) {
    cancelledJobIds.add(id);
    try { markCancelled(id); } catch { /* ignore */ }
  }
  for (const controller of activeJobControllers.values()) controller.abort();
  activeJobControllers.clear();
  unregisterEventTriggers();
  started = false;
}

/** 手动测试执行一个规则(不等触发)。应用超时,但用户显式触发不重试。 */
export async function testRunRule(ruleId: string): Promise<{ ok: boolean; result: string }> {
  const cfg = getConfig() as any;
  const rules: AutomationRule[] = cfg.automation || [];
  const rule = rules.find((x) => x.id === ruleId);
  if (!rule) return { ok: false, result: "rule not found" };
  const guardDecision = jobGuard.tryBegin(ruleId, Date.now());
  if (!guardDecision.run) return { ok: false, result: `skipped: ${guardDecision.reason}` };
  const guardCfg = jobGuard.configFor(rule);
  let job: { id: string } | null = null;
  try { job = enqueueJob({ ruleId: rule.id, ruleName: rule.name, source: "test" }); markRunning(job.id, 0); } catch { /* ignore */ }
  if (job?.id) cancelledJobIds.delete(job.id);
  let wasCancelled = false;
  let ok = false;
  let result = "";
  let errMsg: string | undefined;
  try {
    result = await withTimeout((signal) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (job?.id) activeJobControllers.set(job.id, controller);
      return executeAction(rule, { jobId: job?.id, signal: controller.signal }).finally(() => {
        signal?.removeEventListener("abort", abort);
        if (job?.id) activeJobControllers.delete(job.id);
      });
    }, guardCfg.runTimeoutMs, `automation-test:${rule.name}`);
    ok = true;
  } catch (e: any) {
    errMsg = e.message || String(e);
    result = errMsg || "unknown error";
  }
  wasCancelled = Boolean(job?.id && cancelledJobIds.has(job.id)) || stopping;
  if (job) {
    try {
      if (ok) markDone(job.id, result);
      else if (wasCancelled) markCancelled(job.id);
      else markFailed(job.id, result);
    } catch { /* ignore */ }
  }
  // Manual test runs use the shared guard only as a running lock; success/failure/cancel must not
  // reset or poison production scheduler failure/cooldown counters.
  jobGuard.cancel(ruleId, Date.now());
  runLogs.push({ ruleId: rule.id, ruleName: rule.name, at: Date.now(), ok, result: (ok ? result : `error: ${result}`).slice(0, 500) });
  if (runLogs.length > 200) runLogs.shift();
  if (job?.id) cancelledJobIds.delete(job.id);
  return { ok, result: ok ? result : result };
}
