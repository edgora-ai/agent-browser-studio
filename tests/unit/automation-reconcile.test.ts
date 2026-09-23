// M3 unit tests: startup / resume reconciliation.
//
// The property that matters most here is what reconciliation must NOT do:
// start work. A resume handler is the worst possible place to begin
// side-effecting actions unprompted, so `rearmed` is asserted false and the
// job count is asserted unchanged across every path.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

const mocks = vi.hoisted(() => ({
  manifests: new Map<string, any>(),
  reloadCalls: 0,
}));

vi.mock("../../src/main/services/run-result-store.js", () => ({
  runResultStore: {
    readManifest: (runId: string) => {
      const m = mocks.manifests.get(runId);
      return m ? { ok: true, value: m } : { ok: false, reasonCode: "not_found", detail: "no manifest" };
    },
  },
}));

import {
  _setDbForTesting, enqueueJob, markRunning, markRetryWaiting, markDone, markFailed,
  recoverInterruptedJobs, getJob, listJobs,
} from "../../src/main/services/job-store.js";
import {
  reconcileAutomationState, handleSystemResume, setReloadSchedule,
  _resetOffsetMemoForTesting,
} from "../../src/main/services/automation-reconcile.js";

beforeEach(() => {
  _setDbForTesting(new DatabaseSync(":memory:"));
  mocks.manifests = new Map();
  mocks.reloadCalls = 0;
  _resetOffsetMemoForTesting();
  setReloadSchedule(() => { mocks.reloadCalls++; });
});

describe("reconcileAutomationState", () => {
  it("converges an interrupted run to failed", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(j.id, 0);
    const report = reconcileAutomationState();
    expect(report.interruptedJobs).toBe(1);
    expect(getJob(j.id)!.status).toBe("failed");
    expect(getJob(j.id)!.error).toContain("interrupted");
  });

  it("converges an orphaned queued row to cancelled, not failed", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    const report = reconcileAutomationState();
    expect(report.orphanedQueued).toBe(1);
    // The work never started and no side effect occurred, so there is nothing
    // to report as a failure.
    expect(getJob(j.id)!.status).toBe("cancelled");
  });

  it("converges an orphaned retry-waiting row to failed and never re-arms", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "once" });
    markRunning(j.id, 0);
    markRetryWaiting(j.id, Date.now() + 30_000);
    const report = reconcileAutomationState();
    expect(report.orphanedRetryWaiting).toBe(1);
    const got = getJob(j.id)!;
    expect(got.status).toBe("failed");
    expect(got.retryAt).toBeNull();
    expect(got.error).toContain("not rescheduled");
  });

  it("is idempotent — a second pass changes nothing", () => {
    const a = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(a.id, 0);
    const b = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    reconcileAutomationState();
    const second = reconcileAutomationState();
    expect(second.interruptedJobs).toBe(0);
    expect(second.orphanedQueued).toBe(0);
    expect(second.orphanedRetryWaiting).toBe(0);
    expect(second.jobsReplayedFromRun).toBe(0);
  });

  it("never replays a notification", () => {
    // Asserted rather than documented: the dedup key makes a second alert
    // impossible, and this field is what the E2E reads to prove it.
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron", runId: "run_a" });
    markRunning(j.id, 0);
    mocks.manifests.set("run_a", {
      runId: "run_a", runStartedAt: getJob(j.id)!.startedAt,
      terminal: { status: "done", endReason: "completed", finishedAt: 5_000 },
    });
    const report = reconcileAutomationState();
    expect(report.notificationsReplayed).toBe(0);
  });

  it("leaves a clean job log untouched", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(j.id, 0);
    markDone(j.id, "ok");
    const report = reconcileAutomationState();
    expect(report.interruptedJobs).toBe(0);
    expect(getJob(j.id)!.status).toBe("done");
    expect(getJob(j.id)!.result).toBe("ok");
  });
});

describe("reconcileAutomationState job ↔ run convergence", () => {
  function interruptedWithRun(runId: string): { jobId: string; startedAt: number } {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron", runId });
    markRunning(j.id, 0);
    recoverInterruptedJobs();
    const job = getJob(j.id)!;
    expect(job.status).toBe("failed");
    return { jobId: j.id, startedAt: job.startedAt! };
  }

  it("adopts a committed run's success, closing the contradiction", () => {
    // Without this, the job says "failed: interrupted by restart" forever while
    // its own run's on-disk manifest proves it committed.
    const { jobId, startedAt } = interruptedWithRun("run_ok");
    mocks.manifests.set("run_ok", {
      runId: "run_ok", runStartedAt: startedAt,
      terminal: { status: "done", endReason: "completed", finishedAt: 9_000 },
    });
    const report = reconcileAutomationState();
    expect(report.jobsReplayedFromRun).toBe(1);
    const job = getJob(jobId)!;
    expect(job.status).toBe("done");
    expect(job.finishedAt).toBe(9_000);
  });

  it("adopts a failed run's failure", () => {
    const { jobId, startedAt } = interruptedWithRun("run_bad");
    mocks.manifests.set("run_bad", {
      runId: "run_bad", runStartedAt: startedAt,
      terminal: { status: "error", endReason: "execution_error", error: "boom", finishedAt: 7_000 },
    });
    expect(reconcileAutomationState().jobsReplayedFromRun).toBe(1);
    expect(getJob(jobId)!.status).toBe("failed");
    expect(getJob(jobId)!.error).toContain("boom");
  });

  it("refuses to adopt a run that is not this job's execution", () => {
    // The identity guard. A different start time means a different execution,
    // and adopting its outcome would record a success that never happened.
    const { jobId, startedAt } = interruptedWithRun("run_mismatch");
    mocks.manifests.set("run_mismatch", {
      runId: "run_mismatch", runStartedAt: startedAt + 1,
      terminal: { status: "done", endReason: "completed", finishedAt: 9_000 },
    });
    const report = reconcileAutomationState();
    expect(report.jobsReplayedFromRun).toBe(0);
    expect(getJob(jobId)!.error).toContain("interrupted");
  });

  it("leaves a job alone when no manifest exists", () => {
    const { jobId } = interruptedWithRun("run_missing");
    expect(reconcileAutomationState().jobsReplayedFromRun).toBe(0);
    expect(getJob(jobId)!.error).toContain("interrupted");
  });

  it("leaves a job alone when the manifest has no terminal state", () => {
    const { jobId, startedAt } = interruptedWithRun("run_open");
    mocks.manifests.set("run_open", { runId: "run_open", runStartedAt: startedAt });
    expect(reconcileAutomationState().jobsReplayedFromRun).toBe(0);
    expect(getJob(jobId)!.error).toContain("interrupted");
  });

  it("cannot rewrite a job that was not interrupted by a restart", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron", runId: "run_real" });
    markRunning(j.id, 0);
    // A genuine product failure, not an interruption.
    markFailed(j.id, "genuine error");
    mocks.manifests.set("run_real", {
      runId: "run_real", runStartedAt: getJob(j.id)!.startedAt,
      terminal: { status: "done", endReason: "completed", finishedAt: 9_000 },
    });
    expect(reconcileAutomationState().jobsReplayedFromRun).toBe(0);
    expect(getJob(j.id)!.error).toBe("genuine error");
  });
});

describe("handleSystemResume", () => {
  it("reconciles and re-reads the schedule, and starts nothing", () => {
    const before = listJobs().length;
    const report = handleSystemResume("resume");
    expect(report.reason).toBe("resume");
    expect(report.rearmed).toBe(false);
    expect(mocks.reloadCalls).toBe(1);
    // The load-bearing assertion: no job was created by a resume.
    expect(listJobs().length).toBe(before);
  });

  it("converges orphaned state on resume, not only at startup", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(j.id, 0);
    const report = handleSystemResume("resume");
    expect(report.interruptedJobs).toBe(1);
    expect(getJob(j.id)!.status).toBe("failed");
  });

  it("reports the offset unchanged when the timezone has not moved", () => {
    handleSystemResume("first");
    expect(handleSystemResume("second").offsetChanged).toBe(false);
  });

  it("survives a reload failure without throwing", () => {
    setReloadSchedule(() => { throw new Error("boom"); });
    expect(() => handleSystemResume("resume")).not.toThrow();
  });

  it("works with no reload function wired", () => {
    setReloadSchedule(null);
    expect(() => handleSystemResume("resume")).not.toThrow();
  });
});
