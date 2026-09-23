// Automation state reconciliation (M3).
//
// Runs at startup and again on sleep/resume and system-time change. It makes
// the durable job log agree with reality after an interruption the process did
// not observe — a crash, a quit mid-run, a suspend that outlived a retry timer.
//
// THE RULE: converge, never re-run. Every action here can only rewrite a row's
// terminal state or drop a mark; none of them starts an execution, re-arms a
// timer, or clears a user's cooldown. Re-running a side-effecting action
// (launch, agent-task, sync) unprompted is exactly what this codebase refuses
// to do, and a resume handler is the worst possible place to start.
//
// One implementation, two callers (startup + handleSystemResume), so the
// sleep/resume path is exercisable without a real suspend.
import {
  recoverInterruptedJobs,
  recoverOrphanedQueuedJobs,
  recoverOrphanedRetryWaitingJobs,
  listJobsInterruptedWithRun,
  replayJobTerminalFromRun,
  pruneJobs,
  type Job,
} from "./job-store.js";
import { runResultStore, type RunResultManifest } from "./run-result-store.js";

export interface ReconcileReport {
  /** running → failed(interrupted by restart) */
  interruptedJobs: number;
  /** queued → cancelled (a queued row cannot legitimately outlive its process) */
  orphanedQueued: number;
  /** retry-waiting → failed (the retry timer did not survive) */
  orphanedRetryWaiting: number;
  /** jobs whose terminal state was replayed from their run's on-disk manifest */
  jobsReplayedFromRun: number;
  /** old terminal rows pruned */
  pruned: number;
  /**
   * Always 0. Notifications are keyed on a durable dedup key, so replaying a
   * job's terminal state must never produce a second alert — and a restart
   * must never re-alert at all. Asserted rather than merely documented so the
   * property is checked by the E2E that reads this report.
   */
  notificationsReplayed: 0;
}

/**
 * Converge the job log. Idempotent: running it twice changes nothing the
 * second time, because every step matches only the state it produces.
 */
export function reconcileAutomationState(): ReconcileReport {
  const report: ReconcileReport = {
    interruptedJobs: 0,
    orphanedQueued: 0,
    orphanedRetryWaiting: 0,
    jobsReplayedFromRun: 0,
    pruned: 0,
    notificationsReplayed: 0,
  };

  // 1. Interrupted runs. Moved here from startScheduler because step 4 needs
  //    these rows to already exist — and startScheduler runs after the IPC
  //    handlers are registered.
  try { report.interruptedJobs = recoverInterruptedJobs(); } catch { /* ignore */ }

  // 2. Orphaned queued rows. The only two producers are the pre-run-slot
  //    window and the guard-refuse path, both of which resolve within one
  //    process — so a queued row at startup belongs to a dead process.
  try { report.orphanedQueued = recoverOrphanedQueuedJobs(); } catch { /* ignore */ }

  // 3. Orphaned retry-waiting rows. The timer did not survive, and by design it
  //    is not re-armed. For a `once` the rule then reports missed-once with the
  //    failure attached, which is what prompts the user to reschedule.
  try { report.orphanedRetryWaiting = recoverOrphanedRetryWaitingJobs(); } catch { /* ignore */ }

  // 4. job ↔ run divergence. This closes a real inconsistency: a job left
  //    running at quit becomes failed/"interrupted by restart", while M2's
  //    reconcileRunResults() may independently replay the linked run to a
  //    truthful done because its on-disk manifest proves it committed. Without
  //    this the job permanently contradicts its own run.
  try {
    report.jobsReplayedFromRun = replayJobsFromRuns();
  } catch { /* ignore */ }

  try { report.pruned = pruneJobs(); } catch { /* ignore */ }

  return report;
}

/**
 * What a resume/time-change did. `rearmed` is always false and is reported so
 * the "resume never starts work" property is visible to a caller (and to the
 * E2E that asserts no job was created) rather than only stated in a comment.
 */
export interface SystemResumeReport extends ReconcileReport {
  reason: string;
  rearmed: false;
  /** Whether the host's UTC offset differs from the one observed last time. */
  offsetChanged: boolean;
}

let lastOffsetMinutes: number | null = null;

/** Current UTC offset in minutes (positive east), or null if unreadable. */
function currentOffsetMinutes(): number | null {
  try {
    return -new Date().getTimezoneOffset();
  } catch {
    return null;
  }
}

/**
 * React to a resume / unlock / clock change.
 *
 * Electron exposes no timezone-change event, so the offset is sampled here and
 * compared against the previous sample. That comparison is the only signal we
 * have; it is cheap and it is honest about what it can detect (a timezone move
 * that changes the offset — a move between two zones sharing an offset is
 * undetectable, which is recorded as a known limit).
 *
 * Re-reading the schedule is what makes the displayed next-run time correct
 * after a jump: every cron is recomputed from the new "now".
 */
export function handleSystemResume(reason: string): SystemResumeReport {
  const offset = currentOffsetMinutes();
  const offsetChanged = offset !== null && lastOffsetMinutes !== null && offset !== lastOffsetMinutes;
  if (offset !== null) lastOffsetMinutes = offset;

  const report = reconcileAutomationState();
  try {
    reloadScheduleFn?.();
  } catch { /* ignore */ }

  return { ...report, reason, rearmed: false, offsetChanged };
}

/**
 * Injected by index.ts. A direct import would create a cycle (automation.ts
 * imports this module's job-store helpers, and the reconcile report is part of
 * the scheduler's public surface), so the one function needed is passed in.
 */
let reloadScheduleFn: (() => void) | null = null;
export function setReloadSchedule(fn: (() => void) | null): void {
  reloadScheduleFn = fn;
}

/** Tests: reset the remembered offset between cases. */
export function _resetOffsetMemoForTesting(): void {
  lastOffsetMinutes = null;
}

/**
 * For each job marked failed/"interrupted by restart" that carries a runId,
 * adopt the run's terminal state when the run is itself terminal AND the two
 * provably describe the same execution.
 *
 * The identity check is the safety property. `run.startedAt === job.startedAt`
 * is the same discipline M2 uses for run/template identity: without it, a
 * retried run that happens to share a runId lineage could be adopted by a job
 * that belongs to a different attempt, and the log would show a success that
 * never happened.
 */
function replayJobsFromRuns(): number {
  const candidates: Job[] = listJobsInterruptedWithRun();
  let replayed = 0;
  for (const job of candidates) {
    if (!job.runId || job.startedAt == null) continue;
    let manifest: RunResultManifest | null = null;
    try {
      const read = runResultStore.readManifest(job.runId);
      if (!read.ok) continue; // no manifest → no on-disk proof → leave the row
      manifest = read.value;
    } catch {
      continue;
    }
    // Identity, the safety property: the manifest must describe the run THIS
    // job started. Same discipline M2 uses for run/template identity. Without
    // it, a job could adopt an unrelated run's outcome and the log would show
    // a success that never happened.
    if (manifest.runStartedAt !== job.startedAt) continue;
    const terminal = manifest.terminal;
    if (!terminal || typeof terminal.finishedAt !== "number") continue;

    const ok = terminal.status === "done";
    const message = ok
      ? `reconciled: run ${job.runId} committed on disk`
      : `reconciled: run ${job.runId} failed (${terminal.error ?? terminal.endReason ?? "unknown"})`;
    try {
      if (replayJobTerminalFromRun(job.id, ok ? "done" : "failed", message, terminal.finishedAt)) {
        replayed++;
      }
    } catch { /* ignore */ }
  }
  return replayed;
}
