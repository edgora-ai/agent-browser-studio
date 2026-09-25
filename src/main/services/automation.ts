// 自动化引擎 — 定时任务(cron) + 单次定时(once) + 事件触发(event)
// 复用 launchBrowser/stopBrowser/agentChat/syncService 执行动作。
import type { AutomationRule, AutomationAction, AgentRunEndReason, AgentRunVerification, AgentRunArtifactRef } from "../types.js";
import { getConfig, saveConfig } from "./config-manager.js";
import { launchBrowser, stopBrowser, statusBrowser, touchProfileActivity } from "./browser-manager.js";
import { agentChat, getOrDetectLlmConfig, type LlmConfig } from "./local-agent.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import { syncService } from "./sync-service.js";
import { onEvent } from "./event-bus.js";
import { resolveRetryTarget, listJobRetryCandidates } from "./automation-retry.js";
import { JobGuard, withTimeout, DEFAULT_JOB_GUARD_CONFIG } from "./job-guard.js";
import { enqueueJob, markRunning, markRunningAttempt, markRetryWaiting, markRetryAbandoned, markDone, markFailed, markSkipped, markCancelled, markJobRunId, recoverInterruptedJobs, pruneJobs, getJob, listJobs } from "./job-store.js";
import { runSandboxedWithHandle } from "./script-sandbox.js";
import { validateCron } from "./cron-validate.js";
// nextCronTime lives in the pure classifier so the scheduler and the card
// share one implementation; a second copy would let "what will happen" and
// "what we say will happen" drift apart.
import { nextCronTime, computeScheduleStates, type SchedulerLiveState, type RuleScheduleState, type JobFact } from "./automation-state.js";
import { transact } from "./config/store.js";
import { notifyTerminal } from "./automation-notify.js";
import { getTemplate } from "./task-templates.js";
import { getRunVerifier, type TemplateVerifier } from "./run-verifiers.js";
import { runResultStore } from "./run-result-store.js";


export { validateCron } from "./cron-validate.js";

function runTimeoutMsFor(rule: AutomationRule): number {
  return jobGuard.configFor(rule).runTimeoutMs;
}

// ── 调度状态 ──
/**
 * ruleId -> armed timer, WITH the instant it was armed for and what kind of
 * trigger armed it. M3 added the metadata so the status card can report an
 * OBSERVED next-run time instead of recomputing one: `at` is recorded when the
 * timer is set and is never consulted by any scheduling decision — a stale or
 * wrong `at` can mislead a card, but it cannot change what fires.
 */
interface ArmedTimer {
  handle: NodeJS.Timeout;
  /**
   * True fire time, or null when the armed wait is only a ≤24h re-arm chunk
   * (see MAX_ARM_MS below). Null is the honest answer there: the timer is real
   * but its deadline is not when the rule runs, and reporting the chunk as a
   * next-run time would be a fabrication. The classifier reads null as "no
   * observation available" and recomputes.
   */
  at: number | null;
  kind: "once" | "cron";
}
const timers = new Map<string, ArmedTimer>(); // ruleId -> armed timer (cron/once)
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
  if (!signal?.aborted) return;
  // Preserve a typed abort reason so the run trace records a faithful
  // endReason (timeout / user_cancelled / interrupted) instead of a generic error.
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(typeof reason === "string" && reason ? reason : "automation job cancelled");
}

/** Map an abort/exception to a faithful run endReason. */
function endReasonFromFailure(e: unknown, signal?: AbortSignal): AgentRunEndReason {
  const source = (signal?.aborted ? signal.reason : undefined) ?? e;
  const msg = source instanceof Error ? source.message : String(source || "");
  if (/timed out/.test(msg)) return "timeout";
  if (/cancelled by user/.test(msg)) return "user_cancelled";
  if (/scheduler stopping/.test(msg)) return "interrupted";
  if (signal?.aborted) return "interrupted";
  return "execution_error";
}

async function executeAction(rule: AutomationRule, context: ExecuteActionContext = {}): Promise<string> {
  assertActionNotAborted(context.signal);
  const a = rule.action;
  try {
    switch (a.type) {
      case "launch-profile": {
        if (!a.profileDirId) throw new Error("missing profileDirId");
        const r = await launchBrowser(a.profileDirId);
        touchProfileActivity(a.profileDirId);
        assertActionNotAborted(context.signal);
        return `launched pid=${r.pid} cdpPort=${r.cdpPort}`;
      }
      case "stop-profile": {
        if (!a.profileDirId) throw new Error("missing profileDirId");
        touchProfileActivity(a.profileDirId);
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
        // R15 P0-1: partial failure must fail the job (markFailed + retry
        // accounting), not markDone. Same semantics as the single-profile
        // path above which throws on !out.ok.
        if (failed.length > 0) {
          throw new Error(`agent batch: ${okCount} ok / ${failed.length} failed (runs ${runIds}; first error: ${failed[0].error})`);
        }
        return `agent batch done: ${okCount} ok / 0 failed (runs ${runIds})`;
      }
      // R15 P0-2: sync failure must fail the job, not markDone with a
      // "push failed" message. Same throw semantics as agent-task.
      case "sync-push": {
        assertActionNotAborted(context.signal);
        const r = await syncService.push(context.signal);
        assertActionNotAborted(context.signal);
        if (!r.success) throw new Error(`push failed: ${r.message}`);
        return `pushed: ${r.message}`;
      }
      case "sync-pull": {
        assertActionNotAborted(context.signal);
        const r = await syncService.pull(context.signal);
        assertActionNotAborted(context.signal);
        if (!r.success) throw new Error(`pull failed: ${r.message}`);
        return `pulled: ${r.message}`;
      }
      case "custom-js": {
        if (!a.jsCode) throw new Error("missing jsCode");
        assertActionNotAborted(context.signal);
        // Sandboxed: no require/process/fs/global; sync-loop timeout bounded.
        // Intervals are disposed on settle so cron runs cannot leak repeating
        // host timers across executions (R6 #72).
        const logs: string[] = [];
        const handle = runSandboxedWithHandle(a.jsCode, {
          logger: (m: string) => { logs.push(m); if (logs.length <= 20) console.log(`[custom-js:${rule.name}] ${m}`); },
        }, Math.min(runTimeoutMsFor(rule), 60_000));
        try {
          const r = await Promise.resolve(handle.result);
          assertActionNotAborted(context.signal);
          const summary = logs.length ? ` (logs: ${logs.slice(0, 3).join(" | ")})` : "";
          return `js result: ${JSON.stringify(r).slice(0, 200)}${summary}`;
        } finally {
          handle.dispose();
        }
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
  sourceMeta?: { retryOf?: string },
): Promise<AgentTaskOutcome> {
  try {
    // 启动 profile(若未运行),让 agent 有 CDP target
    const st = statusBrowser(dirId);
    if (!st.running) await launchBrowser(dirId);
    touchProfileActivity(dirId);
  } catch (e: any) {
    return { dirId, runId: "", ok: false, error: `launch failed: ${e?.message || String(e)}` };
  }
  assertActionNotAborted(context.signal);
  const isRetry = Boolean(sourceMeta?.retryOf);

  // M2: resolve the machine-checkable template contract (if any) BEFORE the
  // run starts so the run carries its template identity from the first write.
  const template = action.templateId ? getTemplate(action.templateId) : undefined;
  const verifier: TemplateVerifier | undefined = template?.machine
    ? getRunVerifier(template.id, template.machine.version)
    : undefined;
  let templateInputs: Record<string, string> | undefined;
  let preconditionFailure: { reasonCode: string; detail: string } | null = null;
  if (verifier) {
    if (action.templateInputs === undefined) {
      // Legacy rule without structured inputs: it still runs prompt-guided,
      // but the outcome cannot be machine-graded (manual_review).
      preconditionFailure = { reasonCode: "input_unavailable", detail: "rule has no structured templateInputs" };
    } else {
      const check = verifier.validateInputs(action.templateInputs);
      if (check.ok) templateInputs = check.inputs;
      else preconditionFailure = { reasonCode: check.reasonCode, detail: check.detail };
    }
    if (!preconditionFailure) {
      const prep = verifier.prepareStorage();
      if (!prep.ok) preconditionFailure = { reasonCode: prep.reasonCode, detail: prep.detail };
    }
  }

  const run = agentRunRecorder.startRun({
    source: {
      type: "automation",
      ruleId: rule.id,
      ruleName: rule.name,
      jobId: context.jobId,
      ...(template?.machine ? { templateId: template.id, templateVersion: template.machine.version } : {}),
      ...(isRetry ? { retryOf: sourceMeta?.retryOf } : {}),
    },
    // Retry lineage is shown from source.retryOf (localized badge), not baked
    // into the persisted name.
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

  // Single finalize path for EVERY terminal state (success, error, cancel,
  // timeout): verify the rows the run actually wrote, materialize the
  // snapshot, then commit status + verification + artifact refs in one write.
  // Verification never changes the execution verdict — the two layers stay
  // separate so a partial harvest does not reschedule the job.
  const finalize = (exec: { ok: boolean; error?: string; endReason: AgentRunEndReason }): AgentTaskOutcome => {
    let verification: AgentRunVerification = { status: "unverified" };
    let artifacts: AgentRunArtifactRef[] | undefined;
    if (verifier) {
      const manual = (reasonCode: string, detail?: string): AgentRunVerification => ({
        status: "manual_review",
        checkedAt: Date.now(),
        reasonCode,
        verifierId: verifier.verifierId,
        verifierVersion: verifier.version,
        ...(detail ? { issues: [{ code: reasonCode, detail: detail.slice(0, 200) }] } : {}),
      });
      if (preconditionFailure) {
        verification = manual(preconditionFailure.reasonCode, preconditionFailure.detail);
      } else if (templateInputs) {
        try {
          const outcome = verifier.verify({ runId: run.id, inputs: templateInputs });
          if (outcome.kind === "auto") {
            const commit = runResultStore.commitRunResult({
              runId: run.id,
              runStartedAt: run.startedAt,
              templateId: template!.id,
              templateVersion: template!.machine!.version,
              verification: outcome.verification,
              terminal: {
                status: exec.ok ? "done" : "error",
                endReason: exec.endReason,
                finishedAt: Date.now(),
                ...(exec.error ? { error: exec.error.slice(0, 1000) } : {}),
              },
              dataset: outcome.dataset,
            });
            if (commit.ok) {
              artifacts = commit.artifacts;
              // R0925-03: the store is the single source of truth for the
              // verdict — it already downgraded to manual_review when the
              // snapshot had to be truncated, so manifest and config agree.
              verification = commit.verification;
            } else {
              verification = manual(commit.reasonCode === "artifact_limit" ? "artifact_limit" : "integrity_error", commit.detail);
            }
          } else {
            verification = outcome.verification;
          }
        } catch (e: any) {
          verification = manual("integrity_error", e?.message || String(e));
        }
      }
    }
    agentRunRecorder.finishRun(run.id, exec.ok ? "done" : "error", exec.error, {
      endReason: exec.endReason,
      verification,
      ...(artifacts ? { artifacts } : {}),
    });
    return { dirId, runId: run.id, ok: exec.ok, ...(exec.error ? { error: exec.error } : {}) };
  };

  // A failed hard precondition (invalid inputs, incompatible schema) means
  // storage cannot hold this run's rows — skip the model call entirely.
  // input_unavailable is soft: the rule runs prompt-guided like a legacy rule.
  if (preconditionFailure && preconditionFailure.reasonCode !== "input_unavailable") {
    return finalize({ ok: false, error: `template precondition failed: ${preconditionFailure.detail}`, endReason: "execution_error" });
  }

  try {
    const result = await agentChat(config, [{ role: "user", content: action.agentPrompt || "" }], {
      runId: run.id,
      signal: context.signal,
      profileDirId: dirId,
      ...(templateInputs && verifier
        ? { templateExecution: verifier.buildExecutionContract({ runId: run.id, inputs: templateInputs }) }
        : {}),
    });
    const endReason: AgentRunEndReason = result.endReason ?? (result.error ? "execution_error" : "completed");
    return finalize({ ok: !result.error, error: result.error, endReason });
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    return finalize({ ok: false, error: errMsg, endReason: endReasonFromFailure(e, context.signal) });
  }
}

/** Manual retry of one failed automation run, scoped to its single profile.
 *  Re-runs the rule's agent-task action on just that profile; the new run
 *  carries source.retryOf = original run id. */
export async function retryAgentRun(runId: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const resolved = resolveRetryTarget(runId);
  if (!resolved.ok) return resolved;
  const { rule, action, dirId } = resolved.target;
  const config = getOrDetectLlmConfig();
  if (!config) return { ok: false, error: "no LLM config" };
  const outcome = await runAgentTaskOnProfile(rule, config, dirId, action, {}, { retryOf: runId });
  if (outcome.ok) return { ok: true, runId: outcome.runId };
  return { ok: false, error: outcome.error };
}

/** Retry every failed profile of one batch job (same source.jobId). Each
 *  failed run is re-run through its rule's agent-task action on that profile
 *  (the same path as a single retry). Returns a per-run summary. */
export async function retryJobRuns(jobId: string): Promise<{
  ok: boolean;
  attempted: number;
  succeeded: number;
  failed: Array<{ runId: string; error: string }>;
}> {
  const candidates = listJobRetryCandidates(jobId);
  const config = getOrDetectLlmConfig();
  const failed: Array<{ runId: string; error: string }> = [];
  let succeeded = 0;
  for (const run of candidates) {
    const resolved = resolveRetryTarget(run.id);
    if (!resolved.ok) {
      failed.push({ runId: run.id, error: resolved.error });
      continue;
    }
    if (!config) {
      failed.push({ runId: run.id, error: "no LLM config" });
      continue;
    }
    const outcome = await runAgentTaskOnProfile(
      resolved.target.rule,
      config,
      resolved.target.dirId,
      resolved.target.action,
      {},
      { retryOf: run.id },
    );
    if (outcome.ok) succeeded++;
    else failed.push({ runId: run.id, error: outcome.error || "failed" });
  }
  return { ok: failed.length === 0, attempted: candidates.length, succeeded, failed };
}

/**
 * Execute a rule with hardening: re-entry lock, timeout, failure counting,
 * cooldown, and retry-with-backoff. `attempt` is 0-indexed (0 = first try).
 * The guard persists failureCount/lastError/cooldownUntil onto the rule.
 */
async function runRule(
  rule: AutomationRule,
  attempt = 0,
  source: "cron" | "once" | "event" = "cron",
  generation = schedulerGeneration,
  /**
   * M3: the job row of the execution being retried. A retry re-marks that row
   * running(attempt+1) instead of inserting a new one, so one logical execution
   * is one row — which is what makes "notify once per final execution" and
   * "show the retry-waiting state" expressible at all. Absent on a first try.
   */
  resumeJobId?: string,
): Promise<void> {
  if (generation !== schedulerGeneration || stopping) return;
  const now = Date.now();
  const decision = jobGuard.tryBegin(rule.id, now);
  if (!decision.run) {
    if (resumeJobId) {
      // A retry that the guard now refuses (the rule was re-armed, or another
      // run slipped in). The execution is over, so its row must not be left
      // parked in retry-waiting forever — that would be a lie the UI shows.
      try { markRetryAbandoned(resumeJobId, `retry abandoned: ${decision.reason}`); } catch { /* ignore */ }
      console.log(`[automation] ⏹️ ${rule.name}: retry abandoned (${decision.reason})`);
      return;
    }
    // Record the skip as a durable job for observability.
    try {
      const j = enqueueJob({ ruleId: rule.id, ruleName: rule.name, source, planId: rule.planId ?? null });
      markSkipped(j.id, `skipped: ${decision.reason}`);
    } catch { /* ignore */ }
    console.log(`[automation] ⏭️ ${rule.name}: skipped (${decision.reason})`);
    return;
  }
  const cfg = jobGuard.configFor(rule);
  let slotAcquired = false;
  let job: { id: string } | null = null;
  try {
    // M3: the row is created BEFORE the slot wait, so "queued" is visible. It
    // is cancelled on both early-exit paths below — without those cancels this
    // change would leak a permanently-queued row, i.e. invent the very defect
    // the milestone exists to remove.
    if (resumeJobId) {
      job = { id: resumeJobId };
    } else {
      try { job = enqueueJob({ ruleId: rule.id, ruleName: rule.name, source, planId: rule.planId ?? null }); } catch { /* ignore */ }
    }
    // Global concurrency cap — overlapping different-rule runs queue up after the per-rule guard is held.
    try {
      await acquireRunSlot(rule.id, job?.id ?? null);
    } catch (e: any) {
      if (job?.id) { try { markCancelled(job.id); } catch { /* ignore */ } }
      console.log(`[automation] ⏹️ ${rule.name}: ${e?.message || String(e)}`);
      return;
    }
    slotAcquired = true;
    if (generation !== schedulerGeneration || stopping || !isRuleStillRunnable(rule.id)) {
      if (job?.id) { try { markCancelled(job.id); } catch { /* ignore */ } }
      jobGuard.cancel(rule.id, Date.now());
      return;
    }
    try {
      if (resumeJobId) markRunningAttempt(resumeJobId, attempt);
      else if (job?.id) markRunning(job.id, attempt);
      if (job?.id) activeJobIds.add(job.id);
    } catch { /* ignore */ }
    let ok = false;
    let resultText = "";
    let errMsg: string | undefined;
    try {
      resultText = await withTimeout((signal) => {
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (job?.id) activeJobControllers.set(job.id, controller);
        return executeAction(rule, { jobId: job?.id, signal: controller.signal }).finally(() => {
          signal?.removeEventListener("abort", abort);
          if (job?.id) activeJobControllers.delete(job.id);
        });
      }, cfg.runTimeoutMs, `automation:${rule.name}`, {
        // The timed-out action keeps running until it observes the abort
        // (e.g. a profile launch already past the point of no return). Mark
        // its job cancelled so the retry below never double-executes while
        // the zombie is still active — the zombie's own completion path sees
        // the cancelled flag and records cancelled, not done.
        onTimeout: () => { if (job?.id) cancelledJobIds.add(job.id); },
      });
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
    const stillRunnable = !cancelled && generation === schedulerGeneration && !stopping && isRuleStillRunnable(rule.id);
    if (end.scheduleRetry && stillRunnable) {
      console.log(`[automation] 🔁 ${rule.name}: retry ${attempt + 2}/${cfg.maxRetries + 1} in ${end.retryDelayMs}ms`);
      clearRetry(rule.id);
      const resumeId = job?.id;
      // Park the row between attempts. This is the state that had no
      // representation before M3: the rule was neither running nor finished,
      // and the UI showed nothing at all.
      const retryAt = Date.now() + end.retryDelayMs;
      retryAtByRule.set(rule.id, retryAt);
      if (resumeId) {
        retryJobByRule.set(rule.id, resumeId);
        try { markRetryWaiting(resumeId, retryAt); } catch { /* ignore */ }
      }
      const t = setTimeout(() => {
        if (retryTimers.get(rule.id) === t) {
          // The retry is starting, so it is no longer "waiting": drop the
          // bookkeeping WITHOUT converging the row — runRule is about to resume
          // it. clearRetry would mark it failed first.
          retryTimers.delete(rule.id);
          retryAtByRule.delete(rule.id);
          retryJobByRule.delete(rule.id);
        }
        const currentRule = getRunnableRule(rule.id);
        if (currentRule && generation === schedulerGeneration && !stopping) {
          void runRule(currentRule, attempt + 1, source, generation, resumeId).catch((e) => {
            console.error(`[automation] retry failed for ${rule.name}:`, e);
          });
        } else if (resumeId) {
          // Nothing will resume it: converge the row rather than leave it
          // parked in a state that claims a retry is coming.
          try { markRetryAbandoned(resumeId, "retry abandoned: rule no longer runnable"); } catch { /* ignore */ }
        }
      }, end.retryDelayMs);
      retryTimers.set(rule.id, t);
    } else if (source === "once" && stillRunnable) {
      // Consume once only after an executed terminal attempt, never while queued
      // or waiting for retry. A stale generation must not disable a user's edit.
      const config = structuredClone(getConfig());
      const currentRule = config.automation?.find((r) => r.id === rule.id);
      if (currentRule?.enabled && currentRule.trigger.type === "once") {
        currentRule.enabled = false;
        saveConfig(config);
      }
    }
    // M3 terminal notification — the ONLY trigger point.
    //
    // Placed after the job row reached its terminal state and after the
    // retry/consume decision, so `isFinal` reflects the real outcome. Since
    // M3 makes one job row per logical execution, notifying on the terminal
    // attempt here is one notification per execution BY CONSTRUCTION, with no
    // separate bookkeeping to drift.
    //
    // Not called from testRunRule (a manual test must not masquerade as a plan
    // execution) nor from the manual retry paths (a manual retry is not a plan
    // execution either).
    try {
      const isFinal = cancelled || !end.scheduleRetry || !stillRunnable;
      if (isFinal) {
        // The runId comes back from the durable row (executeAction writes it
        // via markJobRunId) rather than a parallel in-memory map, so a click
        // can always reach the run the notification is about.
        let runId: string | null = null;
        if (job?.id) { try { runId = getJob(job.id)?.runId ?? null; } catch { /* ignore */ } }
        notifyTerminal({
          ruleId: rule.id,
          ruleName: rule.name,
          planId: rule.planId ?? null,
          jobId: job?.id ?? null,
          runId,
          kind: cancelled ? "cancelled" : (ok ? "done" : "failed"),
          dedupKey: job?.id ? `job:${job.id}` : `run:${rule.id}:${Date.now()}`,
        });
      }
    } catch { /* notification must never affect execution */ }
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
/**
 * M3: queue entries carry the ruleId (and the job row created before the wait)
 * so "waiting for a run slot" is attributable to a rule. Before this the queue
 * held anonymous resolvers, so a waiting rule was invisible to every caller
 * and the card could only say "enabled" while the rule sat in a queue.
 */
const slotQueue: Array<{ ruleId: string; jobId: string | null; resolve: () => void; reject: (e: Error) => void }> = [];
function acquireRunSlot(ruleId: string, jobId: string | null = null): Promise<void> {
  if (stopping) return Promise.reject(new Error("automation scheduler stopping"));
  if (activeRuns < maxConcurrent()) { activeRuns++; return Promise.resolve(); }
  return new Promise((resolve, reject) => { slotQueue.push({ ruleId, jobId, resolve: () => { activeRuns++; resolve(); }, reject }); });
}
function releaseRunSlot(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  if (slotQueue.length && !stopping) { const next = slotQueue.shift()!; next.resolve(); }
}
function rejectQueuedRunSlots(reason: string): void {
  while (slotQueue.length) slotQueue.shift()!.reject(new Error(reason));
}

/**
 * Drop a pending retry. Clearing the timer IS the decision that the retry will
 * not happen, so the job row it was going to resume is converged here rather
 * than left parked in retry-waiting — otherwise the card keeps promising a
 * retry that nothing will deliver.
 *
 * Neither caller re-arms the retry: re-running a side-effecting action
 * unprompted is exactly what this codebase refuses to do. The row becomes
 * failed with the reason recorded, which for a `once` is what surfaces the
 * missed-once state and prompts the user to reschedule.
 */
function clearRetry(ruleId: string, reason = "retry abandoned: schedule reloaded"): void {
  const t = retryTimers.get(ruleId);
  const jobId = retryJobByRule.get(ruleId);
  if (t) { clearTimeout(t); retryTimers.delete(ruleId); }
  // Keep the recorded retry time in step with the timer it describes: a stale
  // entry would make the card report a retry that is not going to fire.
  retryAtByRule.delete(ruleId);
  retryJobByRule.delete(ruleId);
  if (jobId) { try { markRetryAbandoned(jobId, reason); } catch { /* ignore */ } }
}

function clearAllRetries(reason?: string): void {
  for (const id of [...retryTimers.keys()]) clearRetry(id, reason);
}

// ── cron 解析(轻量,5 字段: min hour dom mon dow) ──
// 算 cron 下次触发时间(从 now 之后)
// ── 调度单个规则 ──
function scheduleRule(rule: AutomationRule): void {
  clearRule(rule.id);
  if (!rule.enabled) return;
  if (rule.trigger.type === "event") return; // 事件触发由总线处理,不主动调度

  const now = Date.now();
  if (rule.trigger.type === "once") {
    const at = rule.trigger.at || 0;
    const delay = at - now;
    if (delay < 0) return; // expired — surfaced as missed-once by the classifier, never silently re-armed
    const generation = schedulerGeneration;
    const entry: ArmedTimer = { handle: null as any, at, kind: "once" };
    entry.handle = setTimeout(() => {
      if (timers.get(rule.id) === entry) timers.delete(rule.id);
      if (generation !== schedulerGeneration || stopping || !isRuleStillRunnable(rule.id)) return;
      void runRule(rule, 0, "once", generation).catch((e) => {
        console.error(`[automation] once run failed for ${rule.name}:`, e);
      });
    }, delay);
    timers.set(rule.id, entry);
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
        // A real deadline: the timer fires at the rule's actual next run.
        const entry: ArmedTimer = { handle: null as any, at: next, kind: "cron" };
        entry.handle = setTimeout(() => { runRule(rule, 0, "cron", generation); if (generation === schedulerGeneration && !stopping) armNext(); }, Math.max(remaining, 0));
        timers.set(rule.id, entry);
      } else {
        // A re-arm chunk, not a deadline: `at: null` so nobody mistakes the
        // chunk boundary for the fire time.
        const entry: ArmedTimer = { handle: null as any, at: null, kind: "cron" };
        entry.handle = setTimeout(() => { if (generation === schedulerGeneration && !stopping) armNext(); }, MAX_ARM_MS);
        timers.set(rule.id, entry);
      }
    };
    armNext();
  }
}

function clearRule(ruleId: string): void {
  const t = timers.get(ruleId);
  if (t) { clearTimeout(t.handle); timers.delete(ruleId); }
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
    try {
      const pruned = pruneJobs();
      if (pruned > 0) console.log(`[automation] pruned ${pruned} old job row(s)`);
    } catch (e) { console.error("[automation] job prune failed:", e); }
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
  // Mark (never re-arm) past-due onces. Runs after scheduling so "no pending
  // work" is judged against the state we just established.
  try { markMissedOnceRules(rules); } catch (e) { console.error("[automation] missed-once marking failed:", e); }
}

/**
 * M3: stamp `missedAt` on enabled `once` rules that are past due with no
 * pending work. Display-only — it never disables the rule, never rewrites
 * `trigger.at`, and never re-arms anything.
 *
 * Guarded on "not already marked" so a reload (which happens on every edit)
 * does not keep rewriting the timestamp, and so the mark records when the
 * condition was FIRST observed rather than when it was last noticed.
 */
function markMissedOnceRules(rules: AutomationRule[]): void {
  const now = Date.now();
  const candidates = rules.filter((r) => {
    if (r.enabled === false) return false;
    if (r.trigger?.type !== "once") return false;
    if (r.missedAt) return false;               // already marked
    const at = r.trigger.at ?? 0;
    if (!(at > 0 && at <= now)) return false;   // not past due
    // Pending work means it is NOT missed: a run in flight, a parked retry, or
    // a queued row all mean this once still has a future.
    if (jobGuard.getState(r.id).running) return false;
    if (retryTimers.has(r.id)) return false;
    if (slotQueue.some((q) => q.ruleId === r.id)) return false;
    // Nothing pending. One question left: is a fire still going to happen?
    //
    // Not armed at all — scheduleRule refused to arm a past-due at-time. That
    // is the plain expired-once case, and it is dead. Missed.
    if (!timers.has(r.id)) return true;
    // Armed. The timer is about to fire (at <= now, so delay was 0 at arm
    // time), and the guard decides whether that fire is allowed. A rule in
    // cooldown gets refused, and since scheduleRule never re-arms a past-due
    // at-time the refusal is permanent: armed, enabled, and dead. Missed.
    // If the guard allows it, the fire is genuinely imminent — not missed.
    return !jobGuard.shouldRun(r.id, now).run;
  });
  if (!candidates.length) return;
  const ids = new Set(candidates.map((r) => r.id));
  try {
    transact((draft: any) => {
      for (const rule of draft.automation || []) {
        if (!ids.has(rule.id)) continue;
        // Re-check inside the transaction: the guard above ran against a
        // snapshot, and a run may have started in between.
        if (rule.missedAt) continue;
        rule.missedAt = now;
      }
    });
  } catch (e) {
    console.error("[automation] failed to persist missed-once marks:", e);
  }
}

/**
 * M3: what the scheduler knows about a rule RIGHT NOW, for the classifier.
 *
 * This is the single meeting point between the scheduler and the status card.
 * Everything returned is observed (map lookups), not recomputed — except
 * `armedAt` for a chunked cron, which is null precisely because there is no
 * observation to make there.
 */
export function getSchedulerLiveState(ruleId: string): SchedulerLiveState {
  const timer = timers.get(ruleId);
  const retry = retryTimers.get(ruleId);
  const guard = jobGuard.getState(ruleId);
  return {
    executing: Boolean(guard.running),
    // The timer's own delay is not readable, so the recorded `at` is what we
    // report; it is written when the timer is armed and never read back by any
    // scheduling decision.
    retryAt: retry ? retryAtFor(ruleId) : null,
    waitingForSlot: slotQueue.some((q) => q.ruleId === ruleId),
    armedAt: timer ? timer.at : null,
    armed: Boolean(timer),
  };
}

/**
 * When the parked retry will fire. Recorded on the job row at park time, which
 * is the same instant the timer was set for — one source, so the card and the
 * scheduler cannot disagree.
 */
const retryAtByRule = new Map<string, number>();
/** ruleId -> the job row the pending retry will resume, so abandoning the
 *  retry can also converge that row instead of stranding it. */
const retryJobByRule = new Map<string, string>();
function retryAtFor(ruleId: string): number | null {
  return retryAtByRule.get(ruleId) ?? null;
}

/** Every rule's live state, for a full schedule-state snapshot. */
export function getAllSchedulerLiveStates(): Record<string, SchedulerLiveState> {
  const out: Record<string, SchedulerLiveState> = {};
  for (const ruleId of new Set([...timers.keys(), ...retryTimers.keys()])) {
    out[ruleId] = getSchedulerLiveState(ruleId);
  }
  return out;
}

/**
 * The full status picture for every rule: config + durable jobs + live state,
 * classified by the pure module.
 *
 * This is the ONE place the two worlds meet, and it is deliberately read-only:
 * nothing here arms, disarms, or writes. The card cannot change scheduling by
 * being displayed.
 *
 * `timezone`/offset come from the host at call time, so a system timezone
 * change is reflected on the next read without any reconciliation step.
 */
export function getScheduleStates(now = Date.now()): RuleScheduleState[] {
  let rules: AutomationRule[] = [];
  try {
    rules = ((getConfig() as any).automation || []) as AutomationRule[];
  } catch {
    return [];
  }
  let jobs: JobFact[] = [];
  try {
    jobs = listJobs({ limit: 1000 }) as unknown as JobFact[];
  } catch { /* a missing job store degrades to "no evidence", never to a guess */ }

  let timezone = "UTC";
  let offsetMinutes = 0;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    // getTimezoneOffset is minutes BEHIND UTC (UTC+8 → -480); the card wants
    // the conventional sign, so it is negated here once, at the boundary.
    offsetMinutes = -new Date(now).getTimezoneOffset();
  } catch { /* keep UTC */ }

  return computeScheduleStates({
    rules,
    jobs,
    liveFor: (ruleId) => getSchedulerLiveState(ruleId),
    now,
    timezone,
    timezoneOffsetMinutes: offsetMinutes,
  });
}

/** One rule's status, or null when it no longer exists. */
export function getScheduleState(ruleId: string, now = Date.now()): RuleScheduleState | null {
  return getScheduleStates(now).find((s) => s.ruleId === ruleId) ?? null;
}

export function cancelRunningJob(jobId: string): void {
  cancelledJobIds.add(jobId);
  activeJobControllers.get(jobId)?.abort(new Error("job cancelled by user"));
}

export function stopScheduler(): void {
  schedulerGeneration++;
  stopping = true;
  rejectQueuedRunSlots("automation scheduler stopping");
  for (const id of [...timers.keys()]) clearRule(id);
  clearAllRetries("retry abandoned: scheduler stopped");
  for (const id of activeJobIds) {
    cancelledJobIds.add(id);
    try { markCancelled(id); } catch { /* ignore */ }
  }
  for (const controller of activeJobControllers.values()) controller.abort(new Error("automation scheduler stopping"));
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
      const abort = () => controller.abort(signal?.reason);
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
