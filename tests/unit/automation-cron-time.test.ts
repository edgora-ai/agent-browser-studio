// M3 unit tests: pin nextCronTime's behaviour so it cannot drift silently.
//
// These are CHARACTERIZATION tests, not correctness tests. M3 deliberately does
// not change cron semantics (see the plan's "明确不做"); what it adds is a card
// that promises a specific next-run time. If the scheduler's real behaviour
// moved, the card would start lying — so the behaviour is pinned here, and any
// future "fix" has to be a deliberate, visible act.
//
// Every value below was OBSERVED, not assumed. One contradicts what the plan
// predicted, and the test records what the code actually does:
//   - spring-forward: the gap day is skipped entirely (matches the plan)
//   - fall-back: the repeated hour fires ONCE, not twice (the plan predicted a
//     double fire). The scan walks wall-clock minutes, so it passes local 01:30
//     a single time and the extra hour is absorbed. See the M3 acceptance doc.
//
// TZ is pinned in beforeAll and the pin is asserted first. If it did not take
// effect every DST case below would be measuring the CI box's own zone, so the
// DST cases fail loudly on an inactive pin rather than passing for the wrong
// reason.
import { describe, it, expect, beforeAll } from "vitest";
import { nextCronTime } from "../../src/main/services/automation-state.js";

const TZ = "America/New_York";
let tzPinned = false;

beforeAll(() => {
  process.env.TZ = TZ;
});

function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s, 0);
}

/** Wall-clock identity of an instant: what the user would read on a clock. */
function wall(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The DST cases are only meaningful under the pinned zone. */
function requirePin(): void {
  expect(tzPinned, `TZ=${TZ} pin inactive — DST case would measure the wrong zone`).toBe(true);
}

describe("nextCronTime", () => {
  it("the TZ pin actually took effect", () => {
    tzPinned = local(2023, 7, 1).getTimezoneOffset() === 240 && local(2023, 1, 1).getTimezoneOffset() === 300;
    expect(tzPinned, `TZ=${TZ} did not take effect (July offset ${local(2023, 7, 1).getTimezoneOffset()}, expected 240)`).toBe(true);
  });

  it("picks the next matching minute, never the current one", () => {
    const next = new Date(nextCronTime("0 3 * * *", local(2023, 6, 15, 3, 0, 0)));
    expect(wall(next)).toBe("2023-6-16 3:00");
  });

  it("scans forward across a month boundary", () => {
    const next = new Date(nextCronTime("0 3 1 * *", local(2023, 6, 15, 12, 0, 0)));
    expect(wall(next)).toBe("2023-7-1 3:00");
  });

  it("spring-forward: the gap day is skipped, not fired at 03:30", () => {
    // 2023-03-12 02:00 EST → 03:00 EDT, so local 02:30 does not exist that day.
    // The scheduler skips that occurrence and fires the following day.
    requirePin();
    const next = new Date(nextCronTime("30 2 * * *", local(2023, 3, 11, 12, 0, 0)));
    expect(wall(next)).toBe("2023-3-13 2:30");
  });

  it("fall-back: the repeated hour resolves to its first occurrence", () => {
    // 2023-11-05 02:00 EDT → 01:00 EST, so local 01:30 happens twice in epoch
    // terms. The scan is by wall-clock minute, so it passes 01:30 once and
    // picks the EDT (offset 240) instant.
    requirePin();
    const next = new Date(nextCronTime("30 1 * * *", local(2023, 11, 5, 0, 0, 0)));
    expect(wall(next)).toBe("2023-11-5 1:30");
    expect(next.getTimezoneOffset()).toBe(240); // EDT — the earlier instant
  });

  it("fall-back: does NOT fire the repeated hour twice", () => {
    // The plan predicted a double fire; the code does not do that. Re-arming
    // from the first occurrence lands on the NEXT day, 25 wall-clock hours
    // later — the extra hour is absorbed, not repeated.
    requirePin();
    const first = new Date(nextCronTime("30 1 * * *", local(2023, 11, 5, 0, 0, 0)));
    const second = new Date(nextCronTime("30 1 * * *", first));
    expect(wall(second)).toBe("2023-11-6 1:30");
    expect(second.getTime() - first.getTime()).toBe(25 * 3600 * 1000);
  });

  it("DOM and DOW combine with AND, not POSIX OR", () => {
    // POSIX says "0 0 13 * 5" fires on the 13th OR any Friday. This scheduler
    // requires BOTH, so the answer is a Friday the 13th. Pinned because the
    // plan explicitly declines to change it.
    const next = new Date(nextCronTime("0 0 13 * 5", local(2023, 6, 1, 0, 0, 0)));
    expect(wall(next)).toBe("2023-10-13 0:00");
    expect(next.getDay()).toBe(5);
  });

  it("supports steps and ranges", () => {
    const next = new Date(nextCronTime("*/15 9-17 * * 1-5", local(2023, 6, 15, 10, 0, 0)));
    expect(wall(next)).toBe("2023-6-15 10:15");
  });

  it("throws rather than looping forever when nothing can match", () => {
    expect(() => nextCronTime("0 0 30 2 *", local(2023, 1, 1))).toThrow(/no next cron time/);
  });
});
