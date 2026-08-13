// Pure cron validation unit tests (Slice 59 — extracted from automation.ts).
import { describe, it, expect } from "vitest";
import { validateCron } from "../../src/main/services/cron-validate.js";

describe("cron-validate", () => {
  it("accepts valid 5-field expressions", () => {
    expect(() => validateCron("0 3 * * *")).not.toThrow();
    expect(() => validateCron("*/15 * * * *")).not.toThrow();
    expect(() => validateCron("0 9-17 * * 1-5")).not.toThrow();
    expect(() => validateCron("5,35 8-20/2 * * *")).not.toThrow();
  });

  it("rejects a wrong number of fields", () => {
    expect(() => validateCron("0 3 * *")).toThrow(/5 fields/);
    expect(() => validateCron("0 3 * * * *")).toThrow(/5 fields/);
    expect(() => validateCron("")).toThrow(/5 fields/);
  });

  it("rejects out-of-range field values", () => {
    expect(() => validateCron("99 * * * *")).toThrow(/invalid cron/i);
    expect(() => validateCron("0 25 * * *")).toThrow(/invalid cron/i);
    expect(() => validateCron("0 3 * 13 *")).toThrow(/invalid cron/i);
    expect(() => validateCron("0 3 * * 7")).toThrow(/invalid cron/i);
    expect(() => validateCron("60-90 * * * *")).toThrow(/invalid cron/i);
    expect(() => validateCron("*/0 * * * *")).toThrow(/invalid cron/i);
    expect(() => validateCron("5-2 * * * *")).toThrow(/invalid cron/i);
  });
});
