import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRule } from "../../src/main/types.js";

const mocks = vi.hoisted(() => ({
  config: { automation: [] as AutomationRule[], maxConcurrentJobs: 1 },
  saveConfig: vi.fn(),
  launchBrowser: vi.fn(),
}));

// Keep the scheduler, guard and SQLite store real. Only configuration and
// external actions are replaced; unexpected disk access fails the test.
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => mocks.config,
  saveConfig: mocks.saveConfig,
  getAppDataDir: () => { throw new Error("scheduler-store test must not access user data"); },
  sanitizeTracePayload: (value: unknown) => value,
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
  launchBrowser: mocks.launchBrowser,
  stopBrowser: vi.fn(),
  statusBrowser: vi.fn(),
  touchProfileActivity: vi.fn(),
}));
vi.mock("../../src/main/services/local-agent.js", () => ({ agentChat: vi.fn(), getOrDetectLlmConfig: vi.fn() }));
vi.mock("../../src/main/services/sync-service.js", () => ({ syncService: {} }));

import {
  getSchedulerLiveState, jobGuard, reloadSchedule, startScheduler, stopScheduler,
} from "../../src/main/services/automation.js";
import { _setDbForTesting, getJob, listJobs, type Job } from "../../src/main/services/job-store.js";

let db: DatabaseSync;
let nextRule = 0;
const pending: Array<() => void> = [];

function once(overrides: Partial<AutomationRule> = {}): AutomationRule {
  const id = `store_once_${++nextRule}`;
  const rule: AutomationRule = {
    id, name: id, planId: `plan_${id}`, enabled: true, createdAt: Date.now(),
    trigger: { type: "once", at: Date.now() + 100 },
    action: { type: "launch-profile", profileDirId: id },
    ...overrides,
  };
  mocks.config.automation.push(rule);
  return rule;
}

function current(rule: AutomationRule): AutomationRule {
  return mocks.config.automation.find((r) => r.id === rule.id)!;
}

function holdLaunch(): () => void {
  let resolve!: (value: { pid: number; cdpPort: number }) => void;
  mocks.launchBrowser.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const release = () => resolve({ pid: 10, cdpPort: 20 });
  pending.push(release);
  return release;
}

/** Query SQL first, then require both service readback and filtered search to
 * agree on every field, not just the return value of a state-changing call. */
function stored(rule: AutomationRule, expected: Partial<Job>): Job {
  const rows = db.prepare(`
    SELECT id, rule_id AS ruleId, rule_name AS ruleName, source, status, attempt,
      result, error, run_id AS runId, created_at AS createdAt, started_at AS startedAt,
      finished_at AS finishedAt, plan_id AS planId, retry_at AS retryAt
    FROM jobs WHERE rule_id=?
  `).all(rule.id) as unknown as Job[];
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(getJob(row.id)).toEqual(row);
  expect(listJobs({ ruleId: rule.id, status: row.status })).toEqual([row]);
  expect(row).toMatchObject(expected);
  return row;
}

function expectIdle(rule: AutomationRule): void {
  expect(getSchedulerLiveState(rule.id)).toEqual({
    executing: false, retryAt: null, waitingForSlot: false, armedAt: null, armed: false,
  });
}

async function queuedRetry() {
  mocks.launchBrowser.mockRejectedValueOnce(new Error("first failure"));
  const release = holdLaunch();
  const a = once({ maxRetries: 1 });
  const b = once({ trigger: { type: "once", at: Date.now() + 200 } });
  startScheduler();
  await vi.advanceTimersByTimeAsync(100);
  const first = stored(a, {
    status: "retry-waiting", attempt: 0, error: "first failure", source: "once",
    startedAt: Date.now(), finishedAt: null, retryAt: Date.now() + 30_000, planId: a.planId,
  });
  expect(getSchedulerLiveState(a.id).retryAt).toBe(first.retryAt);
  await vi.advanceTimersByTimeAsync(100);
  stored(b, { status: "running", startedAt: Date.now() });
  await vi.advanceTimersByTimeAsync(first.retryAt! - Date.now());
  // The production retry timer has fired, removing its bookkeeping, but the
  // durable row must remain between attempts until a slot is actually granted.
  expect(stored(a, { status: "retry-waiting" })).toEqual(first);
  expect(getSchedulerLiveState(a.id)).toMatchObject({
    executing: true, waitingForSlot: true, retryAt: null, armed: false,
  });
  expect(mocks.launchBrowser.mock.calls.map((args) => args[0])).toEqual([a.id, b.id]);
  expect(vi.getTimerCount()).toBe(1); // B's timeout, not an orphaned retry timer
  return { a, b, first, release };
}

function expectAbandoned(rule: AutomationRule, first: Job, reason: string): Job {
  const row = stored(rule, {
    status: "failed", retryAt: null, finishedAt: Date.now(),
    attempt: first.attempt, startedAt: first.startedAt, createdAt: first.createdAt,
    error: expect.stringContaining(reason),
  });
  expect(listJobs({ ruleId: rule.id, status: "retry-waiting" })).toEqual([]);
  expectIdle(rule);
  return row;
}

async function expectNoLateExecution(rule: AutomationRule, row: Job, release: () => void): Promise<void> {
  release();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.launchBrowser.mock.calls.filter((args) => args[0] === rule.id)).toHaveLength(1);
  expect(stored(rule, {})).toEqual(row);
  expectIdle(rule);
  expect(db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running','retry-waiting')").all()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  vi.clearAllMocks();
  mocks.config = { automation: [], maxConcurrentJobs: 1 };
  mocks.saveConfig.mockImplementation((cfg) => { mocks.config = structuredClone(cfg); });
  mocks.launchBrowser.mockReset().mockResolvedValue({ pid: 10, cdpPort: 20 });
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

describe("production scheduler with the real job store", () => {
  it.each(["reload", "stop"])("fails a queued retry after %s instead of stranding its original row", async (change) => {
    const { a, first, release } = await queuedRetry();
    if (change === "reload") reloadSchedule();
    else stopScheduler();
    await vi.advanceTimersByTimeAsync(0);
    const row = expectAbandoned(a, first, change === "reload" ? "reload" : "stopping");
    expect(current(a)).toMatchObject({ enabled: true, failureCount: 1, lastError: "first failure" });
    await expectNoLateExecution(a, row, release);
  });

  it.each(["disable", "delete"])("fails the queued retry when its rule is %sd before the slot is granted", async (change) => {
    const { a, first, release } = await queuedRetry();
    if (change === "disable") current(a).enabled = false;
    else mocks.config.automation = mocks.config.automation.filter((r) => r.id !== a.id);
    release();
    await vi.advanceTimersByTimeAsync(0);
    const row = expectAbandoned(a, first, "no longer runnable");
    await expectNoLateExecution(a, row, release);
  });

  it.each(["reload", "stop"])("fails a retry if %s invalidates it after slot grant but before execution", async (change) => {
    const { a, first, release } = await queuedRetry();
    const save = mocks.saveConfig.getMockImplementation()!;
    let invalidation: Promise<void> | undefined;
    mocks.saveConfig.mockImplementation((cfg) => {
      save(cfg);
      // B's completion persists before its finally grants A the slot. This
      // microtask runs after that grant, ahead of A's acquire-await continuation.
      invalidation ??= Promise.resolve().then(() => {
        expect(getSchedulerLiveState(a.id)).toMatchObject({ executing: true, waitingForSlot: false });
        expect(stored(a, { status: "retry-waiting" })).toEqual(first);
        if (change === "reload") reloadSchedule();
        else stopScheduler();
      });
    });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidation).toBeDefined();
    await invalidation;
    const row = expectAbandoned(a, first, "retry abandoned");
    await expectNoLateExecution(a, row, release);
  });

  it.each(["reload", "stop", "disable"])("still cancels a first queued attempt after %s without inventing a failure", async (change) => {
    const release = holdLaunch();
    once();
    const queued = once();
    startScheduler();
    await vi.advanceTimersByTimeAsync(101);
    const first = stored(queued, { status: "queued", attempt: 0, startedAt: null, retryAt: null, finishedAt: null });
    if (change === "disable") current(queued).enabled = false;
    else if (change === "reload") reloadSchedule();
    else stopScheduler();
    release();
    await vi.advanceTimersByTimeAsync(0);
    const row = stored(queued, {
      status: "cancelled", error: null, retryAt: null, finishedAt: Date.now(),
      attempt: first.attempt, startedAt: null,
    });
    expectIdle(queued);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser).toHaveBeenCalledOnce();
    expect(stored(queued, {})).toEqual(row);
    expect(db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running','retry-waiting')").all()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes the same logical row only after a slot is granted, preserving its first start time", async () => {
    const { a, first, release } = await queuedRetry();
    release();
    await vi.advanceTimersByTimeAsync(0);
    const row = stored(a, {
      id: first.id, status: "done", attempt: 1, retryAt: null, error: null,
      startedAt: first.startedAt, finishedAt: Date.now(),
    });
    expect(current(a).enabled).toBe(false);
    expectIdle(a);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser.mock.calls.filter((args) => args[0] === a.id)).toHaveLength(2);
    expect(stored(a, {})).toEqual(row);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["slot rejection", "runnable gate"])("reports SQLite abandonment errors at the %s and releases scheduler state", async (path) => {
    const { a, first, release } = await queuedRetry();
    db.exec(`
      CREATE TRIGGER deny_retry_abandonment BEFORE UPDATE OF status ON jobs
      WHEN OLD.status='retry-waiting' AND NEW.status='failed'
      BEGIN SELECT RAISE(ABORT, 'retry row finalization denied'); END;
    `);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    if (path === "slot rejection") stopScheduler();
    else current(a).enabled = false;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith(
      `[automation] failed to finalize unstarted job ${first.id}:`,
      expect.objectContaining({ message: expect.stringContaining("retry row finalization denied") }),
    );
    // A denied database write cannot be claimed as persisted success. It is
    // observable as an error, while the scheduler must still free its guard/slot.
    expect(stored(a, { status: "retry-waiting" })).toEqual(first);
    expectIdle(a);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.launchBrowser.mock.calls.filter((args) => args[0] === a.id)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
