// Real scheduler/guard/job-store; SQLite is :memory: only. No Electron,
// browser, process, network, agent trace or real configuration is imported.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRule } from "../../src/main/types.js";

const mocks = vi.hoisted(() => ({
  config: { automation: [] as AutomationRule[], maxConcurrentJobs: 1 },
  launch: vi.fn(),
  touch: vi.fn(),
  unexpected: () => { throw new Error("queued-cancel test crossed external boundary"); },
}));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => mocks.config,
  saveConfig: (cfg: typeof mocks.config) => { mocks.config = structuredClone(cfg); },
  getAppDataDir: mocks.unexpected,
}));
vi.mock("../../src/main/services/config/store.js", () => ({
  transact: (mutate: (draft: typeof mocks.config) => unknown) => {
    const draft = structuredClone(mocks.config);
    const result = mutate(draft);
    mocks.config = draft;
    return result;
  },
}));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  launchBrowser: mocks.launch, stopBrowser: mocks.unexpected,
  statusBrowser: mocks.unexpected, touchProfileActivity: mocks.touch,
}));
vi.mock("../../src/main/services/local-agent.js", () => ({ agentChat: mocks.unexpected, getOrDetectLlmConfig: mocks.unexpected }));
vi.mock("../../src/main/services/agent-run-trace.js", () => ({ agentRunRecorder: {} }));
vi.mock("../../src/main/services/sync-service.js", () => ({ syncService: {} }));
vi.mock("../../src/main/services/automation-retry.js", () => ({ resolveRetryTarget: mocks.unexpected, listJobRetryCandidates: mocks.unexpected }));
vi.mock("../../src/main/services/script-sandbox.js", () => ({ runSandboxedWithHandle: mocks.unexpected }));
vi.mock("../../src/main/services/automation-notify.js", () => ({ notifyTerminal: vi.fn() }));
vi.mock("../../src/main/services/task-templates.js", () => ({ getTemplate: mocks.unexpected }));
vi.mock("../../src/main/services/run-verifiers.js", () => ({ getRunVerifier: mocks.unexpected }));
vi.mock("../../src/main/services/run-result-store.js", () => ({ runResultStore: {} }));

import { cancelRunningJob, getSchedulerLiveState, jobGuard, startScheduler, stopScheduler, testRunRule } from "../../src/main/services/automation.js";
import { _setDbForTesting, enqueueJob, getJob, listJobs, markCancelled, markDone, markFailed, markRunning, markRunningAttempt, markRetryWaiting, markSkipped } from "../../src/main/services/job-store.js";

let db: DatabaseSync;
let sequence = 0;
const pending: Array<() => void> = [];
function once(at = Date.now() + 100, extra: Partial<AutomationRule> = {}): AutomationRule {
  const id = `queued_cancel_${++sequence}`;
  const rule: AutomationRule = {
    id, name: id, planId: `plan_${id}`, enabled: true, createdAt: Date.now(),
    trigger: { type: "once", at }, action: { type: "launch-profile", profileDirId: id }, ...extra,
  };
  mocks.config.automation.push(rule);
  return rule;
}
function holdLaunch(): () => void {
  let resolve!: (value: { pid: number; cdpPort: number }) => void;
  mocks.launch.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const release = () => resolve({ pid: 10, cdpPort: 20 });
  pending.push(release);
  return release;
}
function row(rule: AutomationRule) {
  const rows = db.prepare("SELECT * FROM jobs WHERE rule_id=?").all(rule.id) as any[];
  expect(rows).toHaveLength(1);
  const job = getJob(rows[0].id)!;
  expect(job.status).toBe(rows[0].status);
  expect(job.attempt).toBe(rows[0].attempt);
  expect(job.startedAt).toBe(rows[0].started_at);
  expect(job.finishedAt).toBe(rows[0].finished_at);
  expect(job.retryAt).toBe(rows[0].retry_at);
  expect(listJobs({ ruleId: rule.id, status: job.status })).toEqual([job]);
  return job;
}
function idle(rule: AutomationRule) {
  expect(jobGuard.getState(rule.id).running).toBe(false);
  expect(getSchedulerLiveState(rule.id)).toMatchObject({ executing: false, waitingForSlot: false, retryAt: null });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T02:00:00Z"));
  mocks.config = { automation: [], maxConcurrentJobs: 1 };
  mocks.touch.mockReset();
  mocks.launch.mockReset().mockResolvedValue({ pid: 10, cdpPort: 20 });
  db = new DatabaseSync(":memory:");
  _setDbForTesting(db);
  jobGuard.reset();
});
afterEach(async () => {
  stopScheduler();
  for (const release of pending.splice(0)) release();
  await vi.advanceTimersByTimeAsync(0);
  _setDbForTesting(null);
  db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("atomic execution admission in the real SQLite store", () => {
  it("admits queued exactly once, not missing or any terminal state", () => {
    const fresh = enqueueJob({ ruleId: "fresh", ruleName: "fresh", source: "test" });
    expect(markRunning(fresh.id, 0)).toBe(true);
    const running = getJob(fresh.id);
    expect(markRunning(fresh.id, 99)).toBe(false);
    expect(getJob(fresh.id)).toEqual(running);
    expect(markRunning("missing", 0)).toBe(false);
    for (const terminal of ["cancelled", "done", "failed", "skipped"] as const) {
      const job = enqueueJob({ ruleId: terminal, ruleName: terminal, source: "test" });
      if (terminal === "cancelled") markCancelled(job.id);
      else if (terminal === "skipped") markSkipped(job.id, "skip");
      else { markRunning(job.id, 0); if (terminal === "done") markDone(job.id, "done"); else markFailed(job.id, "failed"); }
      const before = getJob(job.id);
      expect(markRunning(job.id, 1)).toBe(false);
      expect(markRunningAttempt(job.id, 1)).toBe(false);
      expect(getJob(job.id)).toEqual(before);
    }
  });
  it("only resumes retry-waiting, preserving the first start and row identity", () => {
    const job = enqueueJob({ ruleId: "retry", ruleName: "retry", source: "test" });
    expect(markRunningAttempt(job.id, 1)).toBe(false);
    expect(markRunning(job.id, 0)).toBe(true);
    const startedAt = getJob(job.id)!.startedAt;
    expect(markRunningAttempt(job.id, 1)).toBe(false);
    expect(markRetryWaiting(job.id, Date.now() + 30_000, "retry")).toBe(true);
    vi.setSystemTime(Date.now() + 30_000);
    expect(markRunningAttempt(job.id, 1)).toBe(true);
    expect(getJob(job.id)).toMatchObject({ id: job.id, status: "running", attempt: 1, startedAt, retryAt: null });
    expect(markRunningAttempt(job.id, 2)).toBe(false);
  });
});

describe("cancelled automatic work never acquires permission to execute", () => {
  it("keeps a cancelled queued row terminal, frees its slot/guard and admits the next task", async () => {
    const release = holdLaunch();
    const first = once(); const cancelled = once(); const next = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(row(first).status).toBe("running");
    const queued = row(cancelled);
    expect(queued).toMatchObject({ status: "queued", startedAt: null, attempt: 0 });
    expect(markCancelled(queued.id)).toBe(true);
    cancelRunningJob(queued.id); // same production sequence as the IPC handler
    const terminal = row(cancelled);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.launch.mock.calls.map((args) => args[0])).toEqual([first.id, next.id]);
    expect(row(cancelled)).toEqual(terminal);
    expect(row(next).status).toBe("done");
    idle(cancelled); idle(next);
    expect(mocks.config.automation.find((r) => r.id === cancelled.id)).toMatchObject({ enabled: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(row(cancelled)).toEqual(terminal);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks durable cancellation after a slot is granted, before its await continuation", async () => {
    const release = holdLaunch();
    const first = once(); const cancelled = once(); const next = once();
    startScheduler(); await vi.advanceTimersByTimeAsync(100);
    const queued = row(cancelled);
    let cancelledAfterGrant = false;
    // Bypass the in-memory cancellation set: SQL is the permission boundary.
    const update = db.prepare("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status='queued'");
    const get = mocks.config;
    // The current action's .finally microtask runs before runRule releases its
    // slot. Queue a cancellation from the completion persistence getter instead.
    const original = mocks.config.automation;
    Object.defineProperty(get, "automation", { configurable: true, get() {
      if (row(first).status === "done" && !cancelledAfterGrant) {
        cancelledAfterGrant = true;
        void Promise.resolve().then(() => {
          expect(getSchedulerLiveState(cancelled.id).waitingForSlot).toBe(false);
          expect(update.run(Date.now(), queued.id).changes).toBe(1);
        });
      }
      return original;
    } });
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(cancelledAfterGrant).toBe(true);
    expect(mocks.launch.mock.calls.map((args) => args[0])).toEqual([first.id, next.id]);
    expect(row(cancelled)).toMatchObject({ status: "cancelled", startedAt: null, attempt: 0 });
    idle(cancelled); idle(next);
  });

  it("does not run when SQLite rejects the queued-to-running update and still releases the next slot", async () => {
    const release = holdLaunch(); const first = once(); const denied = once(); const next = once();
    startScheduler(); await vi.advanceTimersByTimeAsync(100);
    db.exec(`CREATE TRIGGER deny_start BEFORE UPDATE OF status ON jobs
      WHEN OLD.rule_id='${denied.id}' AND NEW.status='running'
      BEGIN SELECT RAISE(ABORT, 'start denied by SQLite'); END;`);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.launch.mock.calls.map((args) => args[0])).toEqual([first.id, next.id]);
    expect(row(denied).startedAt).toBeNull();
    expect(log.mock.calls.some((args) => args.some((arg) => String(arg).includes("start denied by SQLite")))).toBe(true);
    idle(denied); idle(next);
  });

  it("fails closed when the durable enqueue itself is rejected", async () => {
    const denied = once();
    db.exec("CREATE TRIGGER deny_enqueue BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'enqueue denied'); END;");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startScheduler(); await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(listJobs()).toEqual([]);
    idle(denied);
    expect(log.mock.calls.some((args) => args.some((arg) => String(arg).includes("enqueue denied")))).toBe(true);
  });

  it.each(["cancel", "stop"])("keeps an automatic late success cancelled after %s", async (change) => {
    const rule = once();
    mocks.touch.mockImplementationOnce(() => {
      void Promise.resolve().then(() => {
        if (change === "stop") stopScheduler();
        else { const id = row(rule).id; expect(markCancelled(id)).toBe(true); cancelRunningJob(id); }
      });
    });
    startScheduler(); await vi.advanceTimersByTimeAsync(100);
    expect(row(rule).status).toBe("cancelled");
    expect(mocks.config.automation.find((r) => r.id === rule.id)!.lastResult).toContain("cancelled");
    idle(rule);
  });

  it.each(["cancel", "stop"])("returns manual late success as cancelled after %s", async (change) => {
    const rule = once(); startScheduler();
    mocks.touch.mockImplementationOnce(() => {
      void Promise.resolve().then(() => {
        if (change === "stop") stopScheduler();
        else { const id = row(rule).id; expect(markCancelled(id)).toBe(true); cancelRunningJob(id); }
      });
    });
    const result = await testRunRule(rule.id);
    expect(result.ok).toBe(false);
    expect(row(rule).status).toBe("cancelled");
    expect(jobGuard.getState(rule.id).running).toBe(false);
  });

  it("rejects manual admission on SQL failure and after scheduler stop", async () => {
    const rule = once(); startScheduler();
    db.exec("CREATE TRIGGER deny_manual BEFORE UPDATE OF status ON jobs WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT, 'manual start denied'); END;");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await testRunRule(rule.id)).ok).toBe(false);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(row(rule).status).toBe("cancelled");
    expect(jobGuard.getState(rule.id).running).toBe(false);
    stopScheduler();
    expect(await testRunRule(rule.id)).toEqual({ ok: false, result: "automation scheduler stopping" });
    expect(listJobs()).toHaveLength(1);
  });

  it("immediately clears a cancelled parked retry timer", async () => {
    mocks.launch.mockRejectedValueOnce(new Error("first failure"));
    const rule = once(Date.now() + 100, { maxRetries: 1 });
    startScheduler(); await vi.advanceTimersByTimeAsync(100);
    const waiting = row(rule);
    expect(waiting.status).toBe("retry-waiting");
    expect(markCancelled(waiting.id)).toBe(true); cancelRunningJob(waiting.id);
    const terminal = row(rule); idle(rule);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(row(rule)).toEqual(terminal);
    expect(mocks.launch).toHaveBeenCalledOnce();
  });

  it("does not revive a cancelled retry queued behind another action", async () => {
    mocks.launch.mockRejectedValueOnce(new Error("first failure"));
    const release = holdLaunch();
    const retry = once(Date.now() + 100, { maxRetries: 1 });
    const blocker = once(Date.now() + 200);
    startScheduler(); await vi.advanceTimersByTimeAsync(100);
    const waiting = row(retry);
    expect(waiting.status).toBe("retry-waiting");
    await vi.advanceTimersByTimeAsync(waiting.retryAt! - Date.now());
    expect(getSchedulerLiveState(retry.id).waitingForSlot).toBe(true);
    expect(markCancelled(waiting.id)).toBe(true);
    cancelRunningJob(waiting.id);
    const terminal = row(retry);
    release(); await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launch.mock.calls.map((args) => args[0])).toEqual([retry.id, blocker.id]);
    expect(row(retry)).toEqual(terminal);
    expect(row(retry)).toMatchObject({ id: waiting.id, status: "cancelled", attempt: 0, startedAt: waiting.startedAt, retryAt: null });
    idle(retry); idle(blocker);
    expect(vi.getTimerCount()).toBe(0);
  });
});
