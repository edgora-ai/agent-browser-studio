import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRule } from "../../src/main/types.js";

const mocks = vi.hoisted(() => ({
  config: { automation: [] as AutomationRule[], maxConcurrentJobs: 1 },
  jobs: [] as any[],
  saveConfig: vi.fn(),
  launchBrowser: vi.fn(),
  stopBrowser: vi.fn(),
  enqueueJob: vi.fn(),
  markRunning: vi.fn(),
  markRunningAttempt: vi.fn(),
  markRetryWaiting: vi.fn(),
  markRetryAbandoned: vi.fn(),
  markDone: vi.fn(),
  markFailed: vi.fn(),
  markSkipped: vi.fn(),
  markCancelled: vi.fn(),
  // config/store.js is mocked so missed-once marking can be asserted. Left
  // real, its base provider is absent under the mocked config-manager, so the
  // call would throw into a catch and the behaviour would go untested.
  transact: vi.fn(),
}));

vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => mocks.config,
  saveConfig: mocks.saveConfig,
}));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  launchBrowser: mocks.launchBrowser,
  stopBrowser: mocks.stopBrowser,
  statusBrowser: vi.fn(),
  touchProfileActivity: vi.fn(),
}));
vi.mock("../../src/main/services/local-agent.js", () => ({ agentChat: vi.fn(), getOrDetectLlmConfig: vi.fn() }));
vi.mock("../../src/main/services/agent-run-trace.js", () => ({ agentRunRecorder: {} }));
vi.mock("../../src/main/services/sync-service.js", () => ({ syncService: {} }));
vi.mock("../../src/main/services/event-bus.js", () => ({ onEvent: () => vi.fn() }));
// Applies the mutation to the mock config so assertions can read the result
// through current(), mirroring what the real store does via its hook.
vi.mock("../../src/main/services/config/store.js", () => ({
  transact: mocks.transact.mockImplementation((mutate: (draft: any) => void) => mutate(mocks.config)),
}));
// The factory must list every job-store export automation.ts imports — a
// missing one is a mechanical failure, not a behavioural one.
vi.mock("../../src/main/services/job-store.js", () => ({
  enqueueJob: mocks.enqueueJob,
  markRunning: mocks.markRunning,
  markRunningAttempt: mocks.markRunningAttempt,
  markRetryWaiting: mocks.markRetryWaiting,
  markRetryAbandoned: mocks.markRetryAbandoned,
  markDone: mocks.markDone,
  markFailed: mocks.markFailed,
  markSkipped: mocks.markSkipped,
  markCancelled: mocks.markCancelled,
  markJobRunId: vi.fn(),
  recoverInterruptedJobs: () => 0,
  pruneJobs: () => 0,
  getJob: vi.fn(),
  listJobs: () => mocks.jobs,
}));

import {
  startScheduler, stopScheduler, reloadSchedule, testRunRule,
  cancelRunningJob, jobGuard, getRunLogs, getSchedulerLiveState,
  getScheduleStates, getScheduleState,
} from "../../src/main/services/automation.js";

let nextRule = 0;
const pending: Array<() => void> = [];
function once(overrides: Partial<AutomationRule> = {}): AutomationRule {
  const id = `once_${++nextRule}`;
  const rule: AutomationRule = {
    id, name: id, enabled: true, createdAt: Date.now(),
    trigger: { type: "once", at: Date.now() + 100 },
    action: { type: "launch-profile", profileDirId: id },
    ...overrides,
  };
  mocks.config.automation.push(rule);
  return rule;
}
function holdLaunch(): () => void {
  let resolve!: (value: { pid: number; cdpPort: number }) => void;
  mocks.launchBrowser.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const release = () => resolve({ pid: 10, cdpPort: 20 });
  pending.push(release);
  return release;
}
function current(rule: AutomationRule): AutomationRule | undefined {
  return mocks.config.automation.find((r) => r.id === rule.id);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  vi.clearAllMocks();
  mocks.config.automation = [];
  mocks.config.maxConcurrentJobs = 1;
  mocks.jobs = [];
  mocks.saveConfig.mockImplementation((cfg) => { mocks.config = structuredClone(cfg); });
  mocks.launchBrowser.mockReset().mockResolvedValue({ pid: 10, cdpPort: 20 });
  mocks.stopBrowser.mockReturnValue(true);
  let jobId = 0;
  mocks.enqueueJob.mockImplementation(() => ({ id: `job_${++jobId}` }));
  jobGuard.reset();
});

afterEach(async () => {
  stopScheduler();
  for (const release of pending.splice(0)) release();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

describe("once scheduler execution lifecycle", () => {
  it("actually executes when due, then disables and never repeats after reload", async () => {
    const rule = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launchBrowser).toHaveBeenCalledExactlyOnceWith(rule.id);
    expect(mocks.markDone).toHaveBeenCalledOnce();
    expect(current(rule)?.enabled).toBe(false);
    expect(current(rule)?.lastRunAt).toBe(Date.now());
    expect(getRunLogs().filter((log) => log.ruleId === rule.id)).toHaveLength(1);
    reloadSchedule();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
  });

  it("stays enabled while its action is pending", async () => {
    const release = holdLaunch();
    const rule = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
    expect(current(rule)?.enabled).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(current(rule)?.enabled).toBe(false);
  });

  it("disables after an executed terminal failure", async () => {
    mocks.launchBrowser.mockRejectedValue(new Error("launch failed"));
    const rule = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.markFailed).toHaveBeenCalledWith("job_1", "launch failed");
    expect(current(rule)).toMatchObject({ enabled: false, failureCount: 1, lastError: "launch failed" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps enabled through retry and disables at its terminal result (failure=%s)", async (failRetry) => {
    mocks.launchBrowser.mockRejectedValueOnce(new Error("first failure"));
    if (failRetry) mocks.launchBrowser.mockRejectedValueOnce(new Error("last failure"));
    const rule = once({ maxRetries: 1 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.markFailed).toHaveBeenCalledOnce();
    expect(current(rule)?.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.launchBrowser).toHaveBeenCalledTimes(2);
    expect(current(rule)?.enabled).toBe(false);
    // M3 decision 4: one logical execution is one job row. The first attempt
    // marks it running via markRunning; the retry RESUMES the same row through
    // markRunningAttempt, so markRunning is called exactly once no matter how
    // many attempts there are.
    expect(mocks.markRunning).toHaveBeenCalledOnce();
    expect(mocks.markRunning.mock.calls[0][1]).toBe(0);
    expect(mocks.enqueueJob).toHaveBeenCalledOnce();
    expect(mocks.markRunningAttempt).toHaveBeenCalledOnce();
    expect(mocks.markRunningAttempt.mock.calls[0][1]).toBe(1);
    // Both calls target the same row — the whole point of the change.
    expect(mocks.markRunningAttempt.mock.calls[0][0]).toBe(mocks.markRunning.mock.calls[0][0]);
    expect(mocks.markFailed).toHaveBeenCalledTimes(failRetry ? 2 : 1);
    expect(mocks.markDone).toHaveBeenCalledTimes(failRetry ? 0 : 1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser).toHaveBeenCalledTimes(2);
  });

  it("waits for a FIFO slot without consuming the queued once rule", async () => {
    const release = holdLaunch();
    const first = once();
    const second = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launchBrowser).toHaveBeenCalledExactlyOnceWith(first.id);
    expect(current(second)?.enabled).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.launchBrowser.mock.calls.map((args) => args[0])).toEqual([first.id, second.id]);
    expect(current(first)?.enabled).toBe(false);
    expect(current(second)?.enabled).toBe(false);
    expect(mocks.markDone).toHaveBeenCalledTimes(2);
  });

  it("creates the queued row BEFORE the slot wait, so waiting is visible", async () => {
    // M3 decision 5. Before this the row was created after acquireRunSlot(), so
    // a rule blocked on the global cap had no row at all and the UI could only
    // show "enabled" while it sat in a queue.
    const release = holdLaunch();
    const first = once();
    const second = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    // Both rules have a row even though only one is running.
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueJob.mock.calls.map((c) => c[0].ruleId)).toEqual([first.id, second.id]);
    // The second is queued, not running: its row exists but was never marked.
    expect(mocks.markRunning).toHaveBeenCalledOnce();
    expect(mocks.markRunning.mock.calls[0][0]).toBe("job_1");
    expect(getSchedulerLiveState(second.id).waitingForSlot).toBe(true);
    expect(getSchedulerLiveState(first.id).waitingForSlot).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(getSchedulerLiveState(second.id).waitingForSlot).toBe(false);
  });

  it("cancels the pre-created row when the slot is refused", async () => {
    // Without this cancel, moving enqueueJob earlier would leak a permanently
    // queued row — inventing the exact defect M3 exists to remove.
    const release = holdLaunch();
    once();
    const queued = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    const queuedRow = mocks.enqueueJob.mock.calls[1][0].ruleId;
    expect(queuedRow).toBe(queued.id);
    stopScheduler(); // rejects every queued slot
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.markCancelled).toHaveBeenCalledWith("job_2");
  });

  it("cancels the pre-created row when the generation gate rejects it", async () => {
    const release = holdLaunch();
    once();
    const queued = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    // Disable the waiting rule, then release the slot: it clears the guard's
    // runnable check at the gate rather than the slot check.
    current(queued)!.enabled = false;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.markCancelled).toHaveBeenCalledWith("job_2");
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
  });

  it("parks the row in retry-waiting between attempts", async () => {
    // The state that had no representation before M3: neither running nor
    // finished, and previously invisible to the UI.
    mocks.launchBrowser.mockRejectedValueOnce(new Error("first failure"));
    const rule = once({ maxRetries: 1 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.markRetryWaiting).toHaveBeenCalledOnce();
    const [rowId, retryAt] = mocks.markRetryWaiting.mock.calls[0];
    expect(rowId).toBe("job_1");
    // The recorded time is the timer's deadline, so the card and the scheduler
    // cannot disagree about when the retry fires.
    expect(retryAt).toBe(Date.now() + 30_000);
    expect(getSchedulerLiveState(rule.id).retryAt).toBe(retryAt);
    await vi.advanceTimersByTimeAsync(30_000);
    // Cleared once the retry actually starts.
    expect(getSchedulerLiveState(rule.id).retryAt).toBeNull();
  });

  it("does not leave a row parked when the retry can no longer run", async () => {
    mocks.launchBrowser.mockRejectedValueOnce(new Error("first failure"));
    const rule = once({ maxRetries: 1 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.markRetryWaiting).toHaveBeenCalledOnce();
    // The user disables the rule during the backoff window.
    current(rule)!.enabled = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.markRetryAbandoned).toHaveBeenCalledWith("job_1", expect.stringContaining("no longer runnable"));
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
  });

  it.each(["disable", "delete", "reload", "stop"])("does not execute a queued rule after %s", async (change) => {
    const release = holdLaunch();
    once();
    const queued = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
    if (change === "disable") current(queued)!.enabled = false;
    if (change === "delete") mocks.config.automation = mocks.config.automation.filter((r) => r.id !== queued.id);
    // Avoid re-arming the expired original deadline at equality.
    await vi.advanceTimersByTimeAsync(1);
    if (change === "stop") stopScheduler();
    else reloadSchedule();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
    expect(getRunLogs().filter((log) => log.ruleId === queued.id)).toHaveLength(0);
    expect(jobGuard.getState(queued.id).running).toBe(false);
    if (change === "reload" || change === "stop") expect(current(queued)?.enabled).toBe(true);
  });

  it("does not consume a rule skipped by the cooldown guard", async () => {
    const rule = once({ cooldownUntil: Date.now() + 60_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launchBrowser).not.toHaveBeenCalled();
    expect(mocks.markSkipped).toHaveBeenCalledWith("job_1", "skipped: cooldown");
    expect(current(rule)?.enabled).toBe(true);
    expect(current(rule)?.lastRunAt).toBeUndefined();
  });

  it("marks a cooldown-skipped once as missed, and still never re-arms it", async () => {
    // M3 does NOT fix this (see the plan's 明确不做): the rule stays enabled and
    // permanently dead. What changes is that it is now visible as missed-once
    // instead of silently claiming to be enabled. Asserted in both directions
    // so a future "fix" cannot land unnoticed.
    const rule = once({ cooldownUntil: Date.now() + 60_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    reloadSchedule();
    expect(current(rule)?.missedAt).toBeGreaterThan(0);
    // Still enabled — the mark is display-only.
    expect(current(rule)?.enabled).toBe(true);
    // And the at-time was not rewritten.
    expect(current(rule)?.trigger).toEqual(rule.trigger);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser).not.toHaveBeenCalled();
  });

  it("does not mark a once that is still in the future", async () => {
    const rule = once({ trigger: { type: "once", at: Date.now() + 60_000 } });
    startScheduler();
    reloadSchedule();
    expect(current(rule)?.missedAt).toBeUndefined();
  });

  it("does not mark a disabled once", async () => {
    const rule = once({ enabled: false, trigger: { type: "once", at: Date.now() - 1_000 } });
    startScheduler();
    reloadSchedule();
    expect(current(rule)?.missedAt).toBeUndefined();
  });

  it("does not mark a once whose run is in flight", async () => {
    // The heart of §6.1: a past-due once that is currently running is NOT
    // missed. It is past due only because the run started at its at-time.
    const release = holdLaunch();
    const rule = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
    // The deadline has passed and the action is still pending.
    await vi.advanceTimersByTimeAsync(5_000);
    reloadSchedule();
    expect(current(rule)?.missedAt).toBeUndefined();
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("converges a parked retry when a reload abandons it", async () => {
    // A reload drops every pending retry (a timer from the old generation must
    // not fire into the new one). The execution then has no future, so the row
    // is converged to failed AND the once is marked missed — the honest pair.
    // Leaving the row in retry-waiting would keep promising a retry.
    mocks.launchBrowser.mockRejectedValueOnce(new Error("first failure"));
    const rule = once({ maxRetries: 1 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.markRetryWaiting).toHaveBeenCalledOnce();
    expect(getSchedulerLiveState(rule.id).retryAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);
    reloadSchedule();
    expect(mocks.markRetryAbandoned).toHaveBeenCalledWith("job_1", expect.stringContaining("reload"));
    expect(getSchedulerLiveState(rule.id).retryAt).toBeNull();
    expect(current(rule)?.missedAt).toBeGreaterThan(0);
    // And the abandoned retry never fires.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
  });

  it("does not rewrite an existing missed mark on reload", async () => {
    // The mark records when the condition was FIRST observed. A reload happens
    // on every edit, so re-stamping would keep moving the timestamp.
    const rule = once({ cooldownUntil: Date.now() + 60_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    reloadSchedule();
    const first = current(rule)?.missedAt;
    expect(first).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_000);
    reloadSchedule();
    expect(current(rule)?.missedAt).toBe(first);
  });

  it("marks a once that was skipped by the guard at startup, not only at fire time", async () => {
    // The rule's at-time is already past when the scheduler starts, so it is
    // never armed at all — this is the "expired once silently dropped" path.
    const rule = once({ trigger: { type: "once", at: Date.now() - 5_000 } });
    startScheduler();
    expect(mocks.launchBrowser).not.toHaveBeenCalled();
    expect(current(rule)?.missedAt).toBeGreaterThan(0);
  });

  it("does not retry or consume a cancelled execution", async () => {
    const release = holdLaunch();
    const rule = once({ maxRetries: 2 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.markRunning).toHaveBeenCalledOnce();
    cancelRunningJob("job_1");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.markCancelled).toHaveBeenCalledWith("job_1");
    expect(current(rule)?.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
  });

  it("does not disable an edited rule when the old generation completes", async () => {
    const release = holdLaunch();
    const rule = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    current(rule)!.trigger = { type: "once", at: Date.now() + 1_000 };
    reloadSchedule();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(current(rule)?.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.launchBrowser).toHaveBeenCalledTimes(2);
    expect(current(rule)?.enabled).toBe(false);
  });

  it.each(["disable", "delete", "reload", "stop"])("cancels a pending retry after %s without consuming the rule", async (change) => {
    mocks.launchBrowser.mockRejectedValueOnce(new Error("retry pending"));
    const rule = once({ maxRetries: 1 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(101);
    expect(current(rule)?.enabled).toBe(true);
    if (change === "disable") current(rule)!.enabled = false;
    if (change === "delete") mocks.config.automation = [];
    if (change === "stop") stopScheduler();
    else reloadSchedule();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
    if (change === "reload" || change === "stop") expect(current(rule)?.enabled).toBe(true);
  });

  it("does not consume a running-guard skip", async () => {
    const rule = once();
    jobGuard.begin(rule.id, Date.now());
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launchBrowser).not.toHaveBeenCalled();
    expect(mocks.markSkipped).toHaveBeenCalledWith("job_1", "skipped: running");
    expect(current(rule)?.enabled).toBe(true);
  });

  it("does not retry or consume a timed-out action still unwinding", async () => {
    holdLaunch();
    const rule = once({ runTimeoutMs: 200, maxRetries: 1 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.markCancelled).toHaveBeenCalledWith("job_1");
    expect(current(rule)?.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
  });

  it("logs a failed disable write without leaving an unsaved disabled rule", async () => {
    const rule = once();
    const error = new Error("cannot save config");
    mocks.saveConfig.mockImplementation((cfg) => {
      if (cfg.automation.some((r: AutomationRule) => !r.enabled)) throw error;
      mocks.config = structuredClone(cfg);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      startScheduler();
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.markDone).toHaveBeenCalledOnce();
      expect(current(rule)?.enabled).toBe(true);
      expect(jobGuard.getState(rule.id).running).toBe(false);
      expect(log).toHaveBeenCalledWith(`[automation] once run failed for ${rule.name}:`, error);
    } finally {
      log.mockRestore();
    }
  });

  it("manual execution neither consumes once nor changes production failure counters", async () => {
    mocks.launchBrowser.mockRejectedValueOnce(new Error("manual failure"));
    const rule = once({ maxRetries: 2, failureCount: 1 });
    startScheduler();
    const result = await testRunRule(rule.id);
    expect(result).toEqual({ ok: false, result: "manual failure" });
    expect(current(rule)).toMatchObject({ enabled: true, failureCount: 1 });
    expect(jobGuard.getState(rule.id).consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.launchBrowser).toHaveBeenCalledTimes(2);
    expect(current(rule)?.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser).toHaveBeenCalledTimes(2);
  });
});

describe("getScheduleStates — the scheduler/card meeting point", () => {
  it("reports the phase from the scheduler, not from a date comparison", async () => {
    const rule = once();
    startScheduler();
    // Before the deadline: armed, and the armed instant is what is reported.
    let state = getScheduleState(rule.id)!;
    expect(state.phase).toBe("scheduled-once");
    expect(state.nextRunAt).toBe(rule.trigger.at);
    expect(state.nextRunSource).toBe("armed-timer");

    const release = holdLaunch();
    await vi.advanceTimersByTimeAsync(100);
    // Mid-run the deadline has passed — a date comparison would say "missed".
    state = getScheduleState(rule.id)!;
    expect(state.phase).toBe("running");
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reports a waiting rule as queued", async () => {
    const release = holdLaunch();
    once();
    const queued = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(getScheduleState(queued.id)!.phase).toBe("queued");
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reports retry-waiting with the retry instant", async () => {
    mocks.launchBrowser.mockRejectedValueOnce(new Error("boom"));
    const rule = once({ maxRetries: 1 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    const state = getScheduleState(rule.id)!;
    expect(state.phase).toBe("retry-waiting");
    expect(state.nextRunAt).toBe(Date.now() + 30_000);
    expect(state.nextRunSource).toBe("armed-timer");
  });

  it("reports missed-once with the mark, and no next run", async () => {
    const rule = once({ cooldownUntil: Date.now() + 60_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    reloadSchedule();
    const state = getScheduleState(rule.id)!;
    expect(state.phase).toBe("missed-once");
    expect(state.missedAt).toBeGreaterThan(0);
    expect(state.nextRunAt).toBeNull();
    expect(state.onceAt).toBe(rule.trigger.at);
  });

  it("carries a real timezone and offset", () => {
    once();
    startScheduler();
    const state = getScheduleStates()[0];
    expect(state.timezone).toBeTruthy();
    expect(Number.isInteger(state.timezoneOffsetMinutes)).toBe(true);
  });

  it("degrades rather than guessing when the plan has no jobs", () => {
    const rule = once();
    startScheduler();
    const state = getScheduleState(rule.id)!;
    // The test rule helper mints no planId, so there is nothing to attribute.
    expect(state.degraded).toBe(true);
    expect(state.lastOutcome).toBeNull();
  });

  it("returns null for an unknown rule and an empty list when unconfigured", () => {
    expect(getScheduleState("rule_nope")).toBeNull();
    expect(getScheduleStates()).toEqual([]);
  });
});
