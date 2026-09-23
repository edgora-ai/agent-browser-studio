// Rule schedule state classifier (M3) — PURE.
//
// No Electron, no config store, no timers, no clock: everything arrives as
// plain data plus an injected `now`. Same discipline as job-guard.ts, for the
// same reason — the whole point of this module is that "what the card says"
// can be asserted deterministically, without standing up a scheduler.
//
// The single most important property here: the classifier never compares a
// date to decide whether a `once` was missed. It decides from evidence that a
// pending execution exists (running / retry-waiting / queued), and only calls
// a past-due `once` MISSED when no such work is pending. A frontend date
// comparison would flag a `once` that is mid-flight as expired; that is
// precisely the bug §6.1 names.
import { parseCronField } from "./cron-validate.js";
import type { AutomationRule } from "../types.js";

/**
 * Next fire time for a cron expression strictly after `now`, in host-local
 * time (the scheduler's existing semantics — M3 deliberately does not change
 * them; the timezone is DISPLAYED, not interpreted).
 *
 * Moved here from automation.ts so the scheduler and the classifier share one
 * implementation rather than two that can drift. Scans minute by minute up to
 * a year, then throws — the same bound the scheduler already relied on.
 */
export function nextCronTime(expr: string, now: Date): number {
  const [minF, hourF, domF, monF, dowF] = expr.trim().split(/\s+/);
  const mins = parseCronField(minF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const mons = parseCronField(monF, 1, 12);
  const dows = parseCronField(dowF, 0, 6);
  // Start at the next minute and scan forward (at most one year).
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (mons.includes(t.getMonth() + 1) && doms.includes(t.getDate()) && dows.includes(t.getDay()) && hours.includes(t.getHours()) && mins.includes(t.getMinutes())) {
      return t.getTime();
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error("no next cron time found within a year");
}

/**
 * What the scheduler knows right now about a rule, observed rather than
 * recomputed. Supplied by automation.ts (getSchedulerLiveState) — this module
 * has no way to reach the scheduler itself, which is what keeps it pure.
 */
export interface SchedulerLiveState {
  /** A run is in flight (or waiting on the global concurrency slot). */
  executing: boolean;
  /** Epoch ms of the pending retry, or null. */
  retryAt: number | null;
  /** Waiting for a global run slot; has a queued job row. */
  waitingForSlot: boolean;
  /** Epoch ms the armed timer will fire at, when a real timer is armed. */
  armedAt: number | null;
  /** Whether a timer is currently armed for this rule. */
  armed: boolean;
}

export type SchedulePhase =
  | "event-driven"
  | "running"
  | "retry-waiting"
  | "queued"
  | "cooldown"
  | "scheduled-once"
  | "missed-once"
  | "scheduled-cron"
  | "invalid-cron"
  | "disabled-after-success"
  | "user-disabled";

/** A job reduced to what the classifier needs. Keeps this module free of the
 *  job-store dependency (and of node:sqlite). */
export interface JobFact {
  id: string;
  ruleId: string;
  planId: string | null;
  status: string;
  source: string;
  attempt: number;
  result: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface RuleScheduleState {
  ruleId: string;
  phase: SchedulePhase;
  /** Epoch ms of the next fire, or null when there is none (or it is unknown). */
  nextRunAt: number | null;
  /**
   * "armed-timer" = read off a real armed timer (an observation).
   * "computed"    = derived by nextCronTime, because a far-future cron is
   *                 re-armed in ≤24h chunks and has no true deadline yet.
   */
  nextRunSource: "armed-timer" | "computed" | null;
  /** IANA zone name of the host, e.g. "Asia/Shanghai". Display only. */
  timezone: string;
  /** Offset from UTC in minutes for `now` (DST-correct at that instant). */
  timezoneOffsetMinutes: number;
  /** For a `once`: the absolute epoch ms it is (or was) set for. */
  onceAt: number | null;
  /** When the missed-once mark was applied, if any. */
  missedAt: number | null;
  /** Cooldown end, when in cooldown. */
  cooldownUntil: number | null;
  /** Outcome of the newest job belonging to the CURRENT plan. */
  lastOutcome: { status: string; at: number; attempt: number; error: string | null } | null;
  /** The in-flight / pending job for the current plan, if any. */
  activeJob: { id: string; status: string; attempt: number; startedAt: number | null; retryAt: number | null } | null;
  /** Most recent attempt by the current plan, for evidence when it failed. */
  lastAttempt: { attempt: number; error: string | null; at: number } | null;
  /**
   * True when the rule has no planId, or none of its jobs carry the current
   * planId. The card must then say "no results for this plan yet" rather than
   * borrowing a pre-M3 row's outcome as if it belonged to this plan.
   */
  degraded: boolean;
}

export interface ClassifyInput {
  rule: AutomationRule;
  jobs: JobFact[];
  live: SchedulerLiveState;
  now: number;
  /** Resolved IANA zone; injected so tests can pin it. */
  timezone: string;
  /** Offset in minutes for `now`. Injected for the same reason. */
  timezoneOffsetMinutes: number;
}

const PENDING_STATUSES = new Set(["queued", "running", "retry-waiting"]);

/**
 * Decide a rule's phase. The order below IS the specification — first match
 * wins, and each step exists because a later step would otherwise lie:
 *
 *  1. event rules have no schedule at all.
 *  2. disabled is decided before "running" so a rule turned off mid-run still
 *     reports disabled; its in-flight job is visible via activeJob.
 *  3-5. pending work is claimed BEFORE any date comparison, which is what
 *     makes "a queued/running/retry-waiting once is not missed" structural.
 *     Queued outranks running because a waiting rule also holds the guard lock.
 *  6. cooldown is not a schedule: showing a next-run time here would promise a
 *     fire that the guard will refuse.
 *  7-8. only now is a `once` compared to the clock — and by then we know no
 *     pending execution exists.
 */
export function classifyRuleState(input: ClassifyInput): RuleScheduleState {
  const { rule, jobs, live, now, timezone, timezoneOffsetMinutes } = input;
  const trigger = rule.trigger || ({} as AutomationRule["trigger"]);

  // "Current plan" isolation. A rule with no planId has NO attributable jobs —
  // pre-M3 rows (planId null) and manual test runs (which carry no planId) must
  // never be presented as evidence about this plan.
  const planJobs = rule.planId ? jobs.filter((j) => j.planId === rule.planId) : [];
  const sorted = planJobs.slice().sort((a, b) => (b.createdAt - a.createdAt) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const newest = sorted[0] || null;
  const pending = sorted.find((j) => PENDING_STATUSES.has(j.status)) || null;
  const lastTerminal = sorted.find((j) => !PENDING_STATUSES.has(j.status)) || null;

  const lastOutcome = lastTerminal
    ? {
      status: lastTerminal.status,
      at: lastTerminal.finishedAt ?? lastTerminal.createdAt,
      attempt: lastTerminal.attempt,
      error: lastTerminal.error,
    }
    : null;

  const lastAttempt = sorted.length
    ? {
      attempt: newest!.attempt,
      error: newest!.error,
      at: newest!.startedAt ?? newest!.createdAt,
    }
    : null;

  const activeJob = pending
    ? {
      id: pending.id,
      status: pending.status,
      attempt: pending.attempt,
      startedAt: pending.startedAt,
      retryAt: live.retryAt,
    }
    : null;

  const base = {
    ruleId: rule.id,
    timezone,
    timezoneOffsetMinutes,
    onceAt: trigger.type === "once" ? (trigger.at ?? null) : null,
    missedAt: rule.missedAt ?? null,
    lastOutcome,
    activeJob,
    lastAttempt,
    degraded: !rule.planId || planJobs.length === 0,
  };

  const cooldownUntil = rule.cooldownUntil && rule.cooldownUntil > now ? rule.cooldownUntil : null;

  // 1. Event rules are driven by the bus; there is no next fire time to show.
  if (trigger.type === "event") {
    return { ...base, phase: "event-driven", nextRunAt: null, nextRunSource: null, cooldownUntil };
  }

  // 2. Disabled. "disabled-after-success" is the terminal state of a consumed
  //    once: it ran, and the scheduler turned it off. Distinguished from a
  //    user toggle so the card can say which happened.
  if (rule.enabled === false) {
    const consumed = trigger.type === "once" && lastOutcome != null && lastOutcome.status === "done";
    return {
      ...base,
      phase: consumed ? "disabled-after-success" : "user-disabled",
      nextRunAt: null,
      nextRunSource: null,
      cooldownUntil,
    };
  }

  // 3. Waiting for a global run slot, checked BEFORE "executing" on purpose.
  //    runRule takes the per-rule guard lock before it waits for a slot, so a
  //    queued rule reports executing=true as well — the guard flag means "holds
  //    the re-entry lock", not "is running". Waiting is the more specific
  //    observation, so it wins: the rule is queued, not executing.
  if (live.waitingForSlot) {
    return { ...base, phase: "queued", nextRunAt: null, nextRunSource: null, cooldownUntil };
  }

  // 4. In flight.
  if (live.executing) {
    return { ...base, phase: "running", nextRunAt: null, nextRunSource: null, cooldownUntil };
  }

  // 5. Between retry attempts. `live.retryAt` is the scheduler's own timer; the
  //    job row is corroboration, not the source.
  if (live.retryAt != null) {
    return { ...base, phase: "retry-waiting", nextRunAt: live.retryAt, nextRunSource: "armed-timer", cooldownUntil };
  }

  // 6. Cooling down. Not a schedule: the guard will refuse the next fire, so
  //    reporting a next-run time here would be a promise the scheduler breaks.
  //
  //    Skipped for a past-due `once`, because there is no future fire for the
  //    cooldown to delay — nothing is being postponed. Reporting a transient
  //    10-minute block there would imply the rule resumes when it ends, and it
  //    never will: the permanent missed-once state is the truth that matters.
  const oncePastDue = trigger.type === "once" && (trigger.at ?? 0) <= now;
  if (cooldownUntil && !oncePastDue) {
    return { ...base, phase: "cooldown", nextRunAt: null, nextRunSource: null, cooldownUntil };
  }

  // 7. `once`. Reaching here PROVES no pending execution exists (steps 3-5
  //    claimed those), so a past-due `at` really is missed.
  //
  //    The missedAt mark is checked FIRST and wins over an armed timer, because
  //    the two coexist in the case that matters: a cooldown-skipped once keeps
  //    its timer (it is about to fire) while being permanently dead. Reporting
  //    "scheduled" there because a timer exists would be the exact lie this
  //    milestone removes. The mark is written by the scheduler under the same
  //    "no pending work AND the fire will be refused" condition, so it is the
  //    more specific evidence.
  if (trigger.type === "once") {
    const at = trigger.at ?? 0;
    if (rule.missedAt) {
      return { ...base, phase: "missed-once", nextRunAt: null, nextRunSource: null, cooldownUntil };
    }
    if (live.armed && live.armedAt != null) {
      return { ...base, phase: "scheduled-once", nextRunAt: live.armedAt, nextRunSource: "armed-timer", cooldownUntil };
    }
    if (at > now) {
      return { ...base, phase: "scheduled-once", nextRunAt: at, nextRunSource: "computed", cooldownUntil };
    }
    return { ...base, phase: "missed-once", nextRunAt: null, nextRunSource: null, cooldownUntil };
  }

  // 8. cron.
  const expr = trigger.cron;
  if (!expr) return { ...base, phase: "invalid-cron", nextRunAt: null, nextRunSource: null, cooldownUntil };
  if (live.armed && live.armedAt != null) {
    // An armed timer is an observation — trust it over recomputation. It may
    // be a ≤24h re-arm chunk rather than the true fire time, which is exactly
    // why the source is reported alongside it.
    return { ...base, phase: "scheduled-cron", nextRunAt: live.armedAt, nextRunSource: "armed-timer", cooldownUntil };
  }
  try {
    return { ...base, phase: "scheduled-cron", nextRunAt: nextCronTime(expr, new Date(now)), nextRunSource: "computed", cooldownUntil };
  } catch {
    return { ...base, phase: "invalid-cron", nextRunAt: null, nextRunSource: null, cooldownUntil };
  }
}

/** Classify every rule against one snapshot of jobs and live state. */
export function computeScheduleStates(input: {
  rules: AutomationRule[];
  jobs: JobFact[];
  liveFor: (ruleId: string) => SchedulerLiveState;
  now: number;
  timezone: string;
  timezoneOffsetMinutes: number;
}): RuleScheduleState[] {
  return input.rules.map((rule) => classifyRuleState({
    rule,
    jobs: input.jobs.filter((j) => j.ruleId === rule.id),
    live: input.liveFor(rule.id),
    now: input.now,
    timezone: input.timezone,
    timezoneOffsetMinutes: input.timezoneOffsetMinutes,
  }));
}
