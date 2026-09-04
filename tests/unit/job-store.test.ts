import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  _setDbForTesting, enqueueJob, markRunning, markDone, markFailed, markSkipped,
  markJobRunId, markCancelled, getJob, listJobs, recoverInterruptedJobs, pruneJobs,
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
