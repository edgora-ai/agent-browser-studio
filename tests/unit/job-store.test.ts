import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  _setDbForTesting, enqueueJob, markRunning, markDone, markFailed, markSkipped,
  markJobRunId, markCancelled, getJob, listJobs, recoverInterruptedJobs, pruneJobs,
  markRunningAttempt, markRetryWaiting, recoverOrphanedQueuedJobs,
  recoverOrphanedRetryWaitingJobs, replayJobTerminalFromRun, listJobsInterruptedWithRun,
  recordNotification, listNotifications, countUnreadNotifications, markNotificationsRead,
} from "../../src/main/services/job-store.js";

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  _setDbForTesting(db);
});

describe("job-store", () => {
  it("enqueues a queued job with the right defaults", () => {
    const j = enqueueJob({ ruleId: "rule_1", ruleName: "Daily", source: "cron" });
    expect(j.status).toBe("queued");
    expect(j.ruleId).toBe("rule_1");
    expect(j.source).toBe("cron");
    expect(j.attempt).toBe(0);
    expect(j.runId).toBeNull();
    expect(j.id.startsWith("job_")).toBe(true);
  });

  it("transitions queued → running → done", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(j.id, 0);
    markDone(j.id, "agent done");
    const got = getJob(j.id);
    expect(got.status).toBe("done");
    expect(got.result).toBe("agent done");
    expect(got.startedAt).toBeGreaterThan(0);
    expect(got.finishedAt).toBeGreaterThanOrEqual(got.startedAt!);
  });

  it("records failure with error text", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "test" });
    markRunning(j.id, 0);
    markFailed(j.id, "boom");
    expect(getJob(j.id).status).toBe("failed");
    expect(getJob(j.id).error).toBe("boom");
  });

  it("records a skip with a reason", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markSkipped(j.id, "skipped: cooldown");
    expect(getJob(j.id).status).toBe("skipped");
    expect(getJob(j.id).result).toContain("cooldown");
  });

  it("persists runId on jobs and exposes it through getJob/listJobs", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "test", runId: "run_abc123" });
    expect(j.runId).toBe("run_abc123");
    expect(getJob(j.id)?.runId).toBe("run_abc123");
    expect(listJobs({ ruleId: "r" })[0].runId).toBe("run_abc123");
  });

  it("can attach runId after enqueue", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "test" });
    markJobRunId(j.id, "run_late");
    expect(getJob(j.id)?.runId).toBe("run_late");
  });

  it("migrates an existing jobs table without run_id and preserves old rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO jobs (id, rule_id, rule_name, source, status, attempt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("job_old", "r", "n", "test", "done", 0, Date.now());
    _setDbForTesting(db);
    expect(getJob("job_old")?.runId).toBeNull();
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "test", runId: "run_new" });
    expect(getJob(j.id)?.runId).toBe("run_new");
  });

  it("cancels a queued/running job; ignores a finished one", () => {
    const a = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    expect(markCancelled(a.id)).toBe(true);
    expect(getJob(a.id).status).toBe("cancelled");
    // Already cancelled → no-op.
    expect(markCancelled(a.id)).toBe(false);
  });

  it("does not let late completion overwrite a cancelled running job", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(j.id, 0);
    expect(markCancelled(j.id)).toBe(true);
    markDone(j.id, "late success");
    expect(getJob(j.id).status).toBe("cancelled");
    expect(getJob(j.id).result).toBeNull();
  });

  it("does not let late failure overwrite a cancelled running job", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(j.id, 0);
    expect(markCancelled(j.id)).toBe(true);
    markFailed(j.id, "late error");
    expect(getJob(j.id).status).toBe("cancelled");
    expect(getJob(j.id).error).toBeNull();
  });

  it("listJobs filters by status and ruleId, newest-first", () => {
    const j1 = enqueueJob({ ruleId: "r1", ruleName: "a", source: "cron" });
    const j2 = enqueueJob({ ruleId: "r1", ruleName: "a", source: "cron" });
    const j3 = enqueueJob({ ruleId: "r2", ruleName: "b", source: "test" });
    markRunning(j1.id, 0);
    markDone(j1.id, "ok");
    expect(listJobs({ status: "done" }).map((j) => j.id)).toEqual([j1.id]);
    expect(listJobs({ ruleId: "r1" }).length).toBe(2);
    expect(listJobs({ ruleId: "r2" }).length).toBe(1);
    // newest-first by created_at
    const all = listJobs();
    expect(all[0].id).toBe(j3.id);
  });

  it("listJobs honors a limit", () => {
    for (let i = 0; i < 5; i++) enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    expect(listJobs({ limit: 2 }).length).toBe(2);
  });

  it("recoverInterruptedJobs marks running jobs as failed(interrupted)", () => {
    const a = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    const b = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(a.id, 0); // interrupted
    markRunning(b.id, 0);
    markDone(b.id, "ok"); // finished cleanly
    const n = recoverInterruptedJobs();
    expect(n).toBe(1);
    expect(getJob(a.id).status).toBe("failed");
    expect(getJob(a.id).error).toContain("interrupted");
    expect(getJob(b.id).status).toBe("done"); // untouched
  });

  it("getJob returns null for an unknown id", () => {
    expect(getJob("nope")).toBeNull();
  });

  it("caps skipped rows so a cooldown cron cannot grow the table forever", () => {
    for (let i = 0; i < 250; i++) {
      const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
      markSkipped(j.id, "skipped: cooldown");
    }
    expect(listJobs({ status: "skipped", limit: 1000 }).length).toBeLessThanOrEqual(200);
  });

  it("pruneJobs caps terminal rows too", () => {
    for (let i = 0; i < 100; i++) {
      const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
      markRunning(j.id, 0);
      markDone(j.id, "ok");
    }
    expect(listJobs({ status: "done", limit: 10000 }).length).toBe(100);
    expect(pruneJobs()).toBe(0); // under cap: nothing pruned
  });
});

// ── M3: plan identity, retry-waiting, reconciliation ──

describe("job-store M3 plan identity", () => {
  it("persists planId through enqueue and reads it back", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "once", planId: "plan_abc123" });
    expect(j.planId).toBe("plan_abc123");
    expect(getJob(j.id)?.planId).toBe("plan_abc123");
    expect(listJobs({ ruleId: "r" })[0].planId).toBe("plan_abc123");
  });

  it("reads a pre-M3 row back as planId null rather than inventing one", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, rule_name TEXT NOT NULL,
        source TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
        result TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
      );
    `);
    db.prepare("INSERT INTO jobs (id, rule_id, rule_name, source, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("job_legacy", "r", "n", "cron", "done", 0, Date.now());
    _setDbForTesting(db);
    // Both M3 ALTERs ran and the old row is intact and honest about its gaps.
    expect(getJob("job_legacy")?.planId).toBeNull();
    expect(getJob("job_legacy")?.retryAt).toBeNull();
    const fresh = enqueueJob({ ruleId: "r", ruleName: "n", source: "test", planId: "plan_new1" });
    expect(getJob(fresh.id)?.planId).toBe("plan_new1");
  });
});

describe("job-store M3 retry-waiting", () => {
  it("parks a running job as retry-waiting and then reuses the SAME row", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron", planId: "plan_x" });
    markRunning(j.id, 0);
    const firstStart = getJob(j.id)!.startedAt;
    expect(markRetryWaiting(j.id, 5_000)).toBe(true);
    const waiting = getJob(j.id)!;
    expect(waiting.status).toBe("retry-waiting");
    expect(waiting.retryAt).toBe(5_000);

    markRunningAttempt(j.id, 1);
    const retried = getJob(j.id)!;
    expect(retried.status).toBe("running");
    expect(retried.attempt).toBe(1);
    expect(retried.retryAt).toBeNull();
    // The execution began at attempt 0; a retry must not look like a new run.
    expect(retried.startedAt).toBe(firstStart);
    // One logical execution, one row.
    expect(listJobs({ ruleId: "r" })).toHaveLength(1);
  });

  it("refuses to park a job that is not running", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(j.id, 0);
    markCancelled(j.id);
    // A late retry callback must not reopen a cancelled execution.
    expect(markRetryWaiting(j.id, 9_000)).toBe(false);
    expect(getJob(j.id)!.status).toBe("cancelled");
  });

  it("refuses to park a job that already finished", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(j.id, 0);
    markDone(j.id, "ok");
    expect(markRetryWaiting(j.id, 9_000)).toBe(false);
    expect(getJob(j.id)!.status).toBe("done");
  });
});

describe("job-store M3 reconciliation", () => {
  it("converges orphaned queued rows to cancelled, leaving other states alone", () => {
    const orphan = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    const running = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(running.id, 0);
    const done = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(done.id, 0);
    markDone(done.id, "ok");

    expect(recoverOrphanedQueuedJobs()).toBe(1);
    const got = getJob(orphan.id)!;
    expect(got.status).toBe("cancelled");
    // Cancelled, not failed: the work never started and no side effect occurred.
    expect(got.error).toContain("orphaned");
    expect(getJob(running.id)!.status).toBe("running");
    expect(getJob(done.id)!.status).toBe("done");
  });

  it("converges orphaned retry-waiting rows to failed with a truthful reason", () => {
    const j = enqueueJob({ ruleId: "r", ruleName: "n", source: "once" });
    markRunning(j.id, 0);
    markRetryWaiting(j.id, 9_000);
    expect(recoverOrphanedRetryWaitingJobs()).toBe(1);
    const got = getJob(j.id)!;
    expect(got.status).toBe("failed");
    expect(got.error).toContain("retry was not rescheduled");
    expect(got.retryAt).toBeNull();
  });

  it("replays a job terminal from its run, but only for the interrupted row", () => {
    const interrupted = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron", runId: "run_a" });
    markRunning(interrupted.id, 0);
    recoverInterruptedJobs();
    expect(getJob(interrupted.id)!.status).toBe("failed");

    expect(replayJobTerminalFromRun(interrupted.id, "done", "recovered", 1_000)).toBe(true);
    const got = getJob(interrupted.id)!;
    expect(got.status).toBe("done");
    expect(got.result).toBe("recovered");
    expect(got.finishedAt).toBe(1_000);
  });

  it("cannot rewrite a user-cancelled or genuinely-failed job", () => {
    const cancelled = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron", runId: "run_b" });
    markRunning(cancelled.id, 0);
    markCancelled(cancelled.id);
    // The guard is the safety property: only rows this reconcile path created.
    expect(replayJobTerminalFromRun(cancelled.id, "done", "should not apply", 1_000)).toBe(false);
    expect(getJob(cancelled.id)!.status).toBe("cancelled");

    const realFail = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron", runId: "run_c" });
    markRunning(realFail.id, 0);
    markFailed(realFail.id, "genuine product error");
    expect(replayJobTerminalFromRun(realFail.id, "done", "should not apply", 1_000)).toBe(false);
    expect(getJob(realFail.id)!.error).toBe("genuine product error");
  });

  it("lists only interrupted jobs that carry a runId", () => {
    const withRun = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron", runId: "run_d" });
    const withoutRun = enqueueJob({ ruleId: "r", ruleName: "n", source: "cron" });
    markRunning(withRun.id, 0);
    markRunning(withoutRun.id, 0);
    recoverInterruptedJobs();
    const candidates = listJobsInterruptedWithRun();
    expect(candidates.map((j) => j.id)).toEqual([withRun.id]);
  });
});

describe("job-store M3 notifications", () => {
  const base = { ruleId: "rule_1", kind: "done" as const, now: 1_000, delivered: true };

  it("records a notification once and reports the duplicate", () => {
    const first = recordNotification({ ...base, dedupKey: "job_1" });
    expect(first.created).toBe(true);
    expect(first.notification.deliveredAt).toBe(1_000);

    const second = recordNotification({ ...base, dedupKey: "job_1" });
    expect(second.created).toBe(false);
    expect(listNotifications()).toHaveLength(1);
  });

  it("keeps the first record when a duplicate arrives with different content", () => {
    recordNotification({ ...base, dedupKey: "job_2", kind: "done" });
    recordNotification({ ...base, dedupKey: "job_2", kind: "failed", now: 2_000 });
    const rows = listNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("done");
    expect(rows[0].createdAt).toBe(1_000);
  });

  it("records the row even when delivery did not happen", () => {
    // This is the permission-denial shape: the in-app record is written
    // regardless of whether the OS notification could be shown.
    const r = recordNotification({ ...base, dedupKey: "job_3", delivered: false });
    expect(r.created).toBe(true);
    expect(r.notification.deliveredAt).toBeNull();
    expect(listNotifications()).toHaveLength(1);
  });

  it("counts and marks unread notifications", () => {
    recordNotification({ ...base, dedupKey: "job_4" });
    recordNotification({ ...base, dedupKey: "job_5" });
    expect(countUnreadNotifications()).toBe(2);
    expect(markNotificationsRead(["job_4", "missing_key"])).toBe(1);
    expect(countUnreadNotifications()).toBe(1);
    expect(listNotifications({ unreadOnly: true }).map((n) => n.dedupKey)).toEqual(["job_5"]);
  });

  it("caps the notification log", () => {
    for (let i = 0; i < 520; i++) {
      recordNotification({ ...base, dedupKey: `job_cap_${i}`, now: 1_000 + i });
    }
    // countUnreadNotifications is uncapped, so it observes the table itself.
    // Asserting through listNotifications would pass even if pruning were a
    // no-op, because that API caps its own result at 500.
    expect(countUnreadNotifications()).toBe(500);
    // The newest survive, the oldest are the ones dropped.
    const keys = listNotifications({ limit: 500 }).map((n) => n.dedupKey);
    expect(keys).toContain("job_cap_519");
    expect(keys).not.toContain("job_cap_0");
  });
});
