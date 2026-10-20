// Automation state reconciliation (M3).
//
// Startup recovery and live timer refresh have different ownership rules.
// Only startup can declare unfinished jobs orphaned: while this process is
// alive, its running action, queued slot and retry timer still own those rows.
// Neither path replays a side-effecting execution. Live refresh only recomputes
// future clock/timezone deadlines without invalidating that active work.
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
 * Startup-only recovery, before IPC handlers and the scheduler start.
 * Idempotent: a second pass changes nothing because each step matches only
 * the state it produces. Never call this while the scheduler owns live jobs.
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

/** Live refresh report: startup recovery counters stay zero for owned jobs. */
export interface SystemResumeReport extends ReconcileReport {
  reason: string;
  /** True only when at least one future cron/once TIMER was armed. */
  rearmed: boolean;
  timersRefreshed: number;
  /** A live refresh does not replay or create an execution. */
  workStarted: false;
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
 * Refreshing armed timers makes the displayed next-run time correct after a
 * jump: future crons are recomputed from the new "now", without catch-up.
 * Recovery of unfinished jobs is strictly startup-only.
 */
export function handleSystemResume(reason: string): SystemResumeReport {
  const offset = currentOffsetMinutes();
  const offsetChanged = offset !== null && lastOffsetMinutes !== null && offset !== lastOffsetMinutes;
  const timersRefreshed = refreshScheduleTimersFn?.() ?? 0;
  if (offset !== null) lastOffsetMinutes = offset;
  return {
    reason, offsetChanged, rearmed: timersRefreshed > 0, timersRefreshed,
    workStarted: false, interruptedJobs: 0, orphanedQueued: 0,
    orphanedRetryWaiting: 0, jobsReplayedFromRun: 0, pruned: 0,
    notificationsReplayed: 0,
  };
}

/** Injected by index.ts to avoid coupling startup recovery to live scheduling. */
let refreshScheduleTimersFn: (() => number) | null = null;
export function setRefreshScheduleTimers(fn: (() => number) | null): void {
  refreshScheduleTimersFn = fn;
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
