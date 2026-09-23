// M3 unit tests: the pure schedule-state classifier.
//
// Injected clock, literal epochs, no fake timers — the job-guard.test.ts
// discipline. Every phase gets its own `it` so a regression names itself
// instead of collapsing into "the table case failed".
//
// The load-bearing cases are the three `once` rules with a PAST at-time that
// also have pending work. A frontend date comparison flags all three as
// expired; §6.1 says a queued/running/retry-waiting once must never be
// misjudged that way. Those three assertions are the reason this module exists.
import { describe, it, expect } from "vitest";
import {
  classifyRuleState,
  nextCronTime,
  type JobFact,
  type SchedulerLiveState,
} from "../../src/main/services/automation-state.js";

const TZ = "Asia/Shanghai";
const TZ_OFFSET = 480; // minutes

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z — a fixed literal, never Date.now()
const PAST = NOW - 3_600_000;
const FUTURE = NOW + 3_600_000;

function idleLive(over: Partial<SchedulerLiveState> = {}): SchedulerLiveState {
  return { executing: false, retryAt: null, waitingForSlot: false, armedAt: null, armed: false, ...over };
}

function rule(over: Record<string, unknown> = {}): any {
  return {
    id: "rule_1",
    name: "probe",
    enabled: true,
    trigger: { type: "once", at: FUTURE },
    action: { type: "sync-push" },
    createdAt: 1,
    planId: "plan_current",
    ...over,
  };
}

function job(over: Partial<JobFact> = {}): JobFact {
  return {
    id: "job_1",
    ruleId: "rule_1",
    planId: "plan_current",
    status: "done",
    source: "once",
    attempt: 0,
    result: "ok",
    error: null,
    startedAt: NOW - 1_000,
    finishedAt: NOW - 500,
    createdAt: NOW - 2_000,
    ...over,
  };
}

function classify(over: {
  rule?: any;
  jobs?: JobFact[];
  live?: Partial<SchedulerLiveState>;
  now?: number;
} = {}) {
  return classifyRuleState({
    rule: over.rule ?? rule(),
    jobs: over.jobs ?? [],
    live: idleLive(over.live),
    now: over.now ?? NOW,
    timezone: TZ,
    timezoneOffsetMinutes: TZ_OFFSET,
  });
}

describe("classifyRuleState phases", () => {
  it("event → event-driven, with no next run", () => {
    const s = classify({ rule: rule({ trigger: { type: "event", event: "profile:launched" } }) });
    expect(s.phase).toBe("event-driven");
    expect(s.nextRunAt).toBeNull();
    expect(s.nextRunSource).toBeNull();
  });

  it("disabled with no completed plan run → user-disabled", () => {
    const s = classify({ rule: rule({ enabled: false }) });
    expect(s.phase).toBe("user-disabled");
    expect(s.nextRunAt).toBeNull();
  });

  it("disabled after its own once completed → disabled-after-success", () => {
    // The consumed-once shape: runRule turned it off after a terminal success.
    const s = classify({
      rule: rule({ enabled: false, trigger: { type: "once", at: PAST } }),
      jobs: [job({ status: "done" })],
    });
    expect(s.phase).toBe("disabled-after-success");
    expect(s.lastOutcome!.status).toBe("done");
  });

  it("executing → running, even when the at-time is long past", () => {
    const s = classify({ rule: rule({ trigger: { type: "once", at: PAST } }), live: { executing: true }, jobs: [job({ status: "running", finishedAt: null })] });
    expect(s.phase).toBe("running");
  });

  it("pending retry → retry-waiting, not missed", () => {
    const retryAt = NOW + 30_000;
    const s = classify({
      rule: rule({ trigger: { type: "once", at: PAST } }),
      live: { retryAt },
      jobs: [job({ status: "retry-waiting", finishedAt: null, error: "boom" })],
    });
    expect(s.phase).toBe("retry-waiting");
    expect(s.nextRunAt).toBe(retryAt);
    // An armed retry timer is an observation, not a recomputation.
    expect(s.nextRunSource).toBe("armed-timer");
  });

  it("waiting for a run slot → queued, not missed", () => {
    const s = classify({
      rule: rule({ trigger: { type: "once", at: PAST } }),
      live: { waitingForSlot: true },
      jobs: [job({ status: "queued", startedAt: null, finishedAt: null })],
    });
    expect(s.phase).toBe("queued");
  });

  it("cooling down → cooldown, and promises no next run", () => {
    const cooldownUntil = NOW + 600_000;
    const s = classify({ rule: rule({ cooldownUntil }) });
    expect(s.phase).toBe("cooldown");
    expect(s.cooldownUntil).toBe(cooldownUntil);
    // Showing a next-run time here would promise a fire the guard will refuse.
    expect(s.nextRunAt).toBeNull();
  });

  it("ignores an expired cooldown", () => {
    const s = classify({ rule: rule({ cooldownUntil: NOW - 1 }) });
    expect(s.phase).toBe("scheduled-once");
    expect(s.cooldownUntil).toBeNull();
  });

  it("future once → scheduled-once from the at-time", () => {
    const s = classify();
    expect(s.phase).toBe("scheduled-once");
    expect(s.nextRunAt).toBe(FUTURE);
    expect(s.onceAt).toBe(FUTURE);
  });

  it("past once with no pending work → missed-once", () => {
    const s = classify({ rule: rule({ trigger: { type: "once", at: PAST }, missedAt: NOW - 1_000 }) });
    expect(s.phase).toBe("missed-once");
    expect(s.nextRunAt).toBeNull();
    expect(s.missedAt).toBe(NOW - 1_000);
  });

  it("an armed timer beats recomputation for a once", () => {
    const armedAt = NOW + 5_000;
    const s = classify({ rule: rule({ trigger: { type: "once", at: FUTURE } }), live: { armed: true, armedAt } });
    expect(s.phase).toBe("scheduled-once");
    expect(s.nextRunAt).toBe(armedAt);
    expect(s.nextRunSource).toBe("armed-timer");
  });

  it("cron → scheduled-cron from the armed timer when one exists", () => {
    const armedAt = NOW + 60_000;
    const s = classify({
      rule: rule({ trigger: { type: "cron", cron: "0 3 * * *" } }),
      live: { armed: true, armedAt },
    });
    expect(s.phase).toBe("scheduled-cron");
    expect(s.nextRunAt).toBe(armedAt);
    expect(s.nextRunSource).toBe("armed-timer");
  });

  it("cron with no armed timer → computed, and says so", () => {
    // A cron more than 24h out is re-armed in chunks, so there is no true
    // deadline to observe. The value still comes from the scheduler's own
    // function — never from a frontend date comparison — but the card must be
    // able to distinguish it from an observation.
    const s = classify({ rule: rule({ trigger: { type: "cron", cron: "0 3 1 1 *" } }) });
    expect(s.phase).toBe("scheduled-cron");
    expect(s.nextRunSource).toBe("computed");
    expect(s.nextRunAt).toBeGreaterThan(NOW);
  });

  it("unparseable cron → invalid-cron rather than a thrown error", () => {
    const s = classify({ rule: rule({ trigger: { type: "cron", cron: "not a cron" } }) });
    expect(s.phase).toBe("invalid-cron");
    expect(s.nextRunAt).toBeNull();
  });

  it("cron with no expression → invalid-cron", () => {
    expect(classify({ rule: rule({ trigger: { type: "cron" } }) }).phase).toBe("invalid-cron");
  });

  it("an unparseable cron that is disabled still reports disabled", () => {
    // Order matters: enabled-ness is decided before cron validity, so a broken
    // expression on a switched-off rule does not look like an active problem.
    const s = classify({ rule: rule({ enabled: false, trigger: { type: "cron", cron: "nope" } }) });
    expect(s.phase).toBe("user-disabled");
  });
});

describe("classifyRuleState plan isolation", () => {
  it("does not count a manual test run as the plan having executed", () => {
    // testRunRule enqueues without a planId, so the row cannot satisfy this
    // plan's outcome. §6.1: a test run must not masquerade as a real run.
    const s = classify({
      rule: rule({ enabled: false, trigger: { type: "once", at: PAST } }),
      jobs: [job({ planId: null, source: "test", status: "done" })],
    });
    expect(s.phase).toBe("user-disabled");
    expect(s.lastOutcome).toBeNull();
    expect(s.degraded).toBe(true);
  });

  it("does not let a previous plan's success stand in for the current plan", () => {
    const s = classify({
      rule: rule({ enabled: false, trigger: { type: "once", at: PAST }, planId: "plan_current" }),
      jobs: [job({ planId: "plan_old", status: "done" })],
    });
    // The old plan succeeded, but THIS plan has no results.
    expect(s.phase).toBe("user-disabled");
    expect(s.lastOutcome).toBeNull();
    expect(s.degraded).toBe(true);
  });

  it("treats a pre-M3 rule with no planId as degraded, never as proven", () => {
    const s = classify({
      rule: rule({ enabled: false, trigger: { type: "once", at: PAST }, planId: undefined }),
      jobs: [job({ planId: null, status: "done" })],
    });
    expect(s.phase).toBe("user-disabled");
    expect(s.degraded).toBe(true);
    expect(s.lastOutcome).toBeNull();
  });

  it("reports the newest current-plan outcome, not the newest row overall", () => {
    const s = classify({
      jobs: [
        job({ id: "job_new", status: "failed", error: "late failure", createdAt: NOW - 100, finishedAt: NOW - 50, startedAt: NOW - 80 }),
        job({ id: "job_old", status: "done", createdAt: NOW - 9_000, finishedAt: NOW - 8_000, startedAt: NOW - 8_500 }),
      ],
    });
    expect(s.lastOutcome!.status).toBe("failed");
    expect(s.lastOutcome!.error).toBe("late failure");
  });

  it("surfaces the pending job and its attempt count", () => {
    const s = classify({
      live: { retryAt: NOW + 30_000 },
      jobs: [job({ id: "job_pending", status: "retry-waiting", attempt: 2, finishedAt: null })],
    });
    expect(s.activeJob!.id).toBe("job_pending");
    expect(s.activeJob!.attempt).toBe(2);
    expect(s.lastAttempt!.attempt).toBe(2);
  });

  it("is not degraded when the current plan has a run", () => {
    const s = classify({ jobs: [job()] });
    expect(s.degraded).toBe(false);
  });
});

describe("classifyRuleState timezone", () => {
  it("reports the zone name and offset it was given", () => {
    const s = classify();
    expect(s.timezone).toBe(TZ);
    expect(s.timezoneOffsetMinutes).toBe(TZ_OFFSET);
  });

  it("carries the offset through on every phase", () => {
    // A card that lost the offset on one phase would show an unlabelled time.
    const cases = [
      classify({ rule: rule({ trigger: { type: "event", event: "profile:launched" } }) }),
      classify({ rule: rule({ enabled: false }) }),
      classify({ live: { executing: true } }),
      classify({ rule: rule({ cooldownUntil: NOW + 1_000 }) }),
      classify({ rule: rule({ trigger: { type: "cron", cron: "0 3 * * *" } }) }),
      classify({ rule: rule({ trigger: { type: "cron", cron: "bad" } }) }),
    ];
    for (const s of cases) {
      expect(s.timezoneOffsetMinutes, s.phase).toBe(TZ_OFFSET);
      expect(s.timezone, s.phase).toBe(TZ);
    }
  });
});

describe("nextCronTime", () => {
  it("returns the next matching minute strictly after now", () => {
    const now = new Date(2023, 10, 14, 22, 13, 20, 0); // local 22:13:20
    expect(new Date(nextCronTime("0 3 * * *", now)).getHours()).toBe(3);
  });

  it("does not return the current minute even when it matches", () => {
    // now is exactly 03:00:00 and the expression matches 03:00 — the answer
    // must be tomorrow, not now (the scheduler would otherwise spin).
    const now = new Date(2023, 10, 14, 3, 0, 0, 0);
    const next = new Date(nextCronTime("0 3 * * *", now));
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
  });

  it("throws rather than looping forever on an impossible expression", () => {
    // Feb 30 never occurs. Callers treat the throw as invalid-cron.
    expect(() => nextCronTime("0 0 30 2 *", new Date(2023, 0, 1))).toThrow(/no next cron time/);
  });
});
