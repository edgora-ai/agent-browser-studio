// M3 unit tests: automation plan identity + notification config normalization.
//
// These are trust-boundary tests, not formatting tests. `normalizeAutomationRules`
// rebuilds each rule field by field, so a field missing from it is silently
// dropped on the next saveConfig — and `persistRunState` saves on EVERY run.
// A planId that survives only until the first run would make the whole
// "this plan already ran" judgement meaningless.
import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

// pid-suffixed: concurrent vitest processes must not share one config store.
const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-m3-plan-norm-test-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
}));

import { mergeConfigForStore } from "../../src/main/services/config-manager.js";

function baseRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rule_plan1",
    name: "plan probe",
    enabled: true,
    trigger: { type: "once", at: 1_800_000_000_000 },
    action: { type: "agent-task", agentPrompt: "collect" },
    createdAt: 100,
    ...overrides,
  };
}

function normalizeOne(rule: Record<string, unknown>): any {
  const merged = mergeConfigForStore({ automation: [rule] }, "save");
  const rules = (merged as any).automation || [];
  expect(rules).toHaveLength(1);
  return rules[0];
}

describe("automation rule planId normalization", () => {
  it("preserves a well-formed main-process planId across a save round-trip", () => {
    const rule = normalizeOne(baseRule({ planId: "plan_abc12345" }));
    // The whole point: it must still be there after the normalizer ran.
    expect(rule.planId).toBe("plan_abc12345");
  });

  it("drops a planId that is not main-process shaped", () => {
    for (const bad of [
      "plan_",                        // no body
      "notaplan_abc",                 // wrong prefix
      "plan_" + "x".repeat(80),       // over the 64-char body cap
      "plan_abc/../etc",              // path-ish characters
      "plan_abc def",                 // whitespace
      "",                             // empty
    ]) {
      const rule = normalizeOne(baseRule({ planId: bad }));
      expect(rule.planId, `planId ${JSON.stringify(bad)} should be dropped`).toBeUndefined();
    }
  });

  it("drops a non-string planId rather than coercing it", () => {
    for (const bad of [123, null, true, {}, ["plan_abc"]]) {
      expect(normalizeOne(baseRule({ planId: bad })).planId).toBeUndefined();
    }
  });

  it("leaves planId absent for a legacy rule that never had one", () => {
    const rule = normalizeOne(baseRule());
    expect("planId" in rule).toBe(false);
  });
});

describe("automation rule missedAt normalization", () => {
  it("preserves a positive missedAt timestamp", () => {
    expect(normalizeOne(baseRule({ missedAt: 1_700_000_000_000 })).missedAt).toBe(1_700_000_000_000);
  });

  it("drops zero, negative and non-numeric missedAt", () => {
    for (const bad of [0, -5, "soon", null, NaN, Infinity]) {
      expect(normalizeOne(baseRule({ missedAt: bad })).missedAt, `missedAt ${String(bad)}`).toBeUndefined();
    }
  });

  it("does not invent missedAt on a rule that never had one", () => {
    expect("missedAt" in normalizeOne(baseRule())).toBe(false);
  });
});

describe("automationNotify config normalization", () => {
  it("defaults to system off and sound off", () => {
    const merged = mergeConfigForStore({}, "load") as any;
    expect(merged.automationNotify).toEqual({ system: false, sound: false });
  });

  it("preserves an explicit opt-in across a save round-trip", () => {
    // The regression this guards: without an explicit mergeConfig branch the
    // strict unknown-key whitelist drops the key, so the user's choice reverts
    // to the default on the next save.
    const merged = mergeConfigForStore({ automationNotify: { system: true, sound: true } }, "save") as any;
    expect(merged.automationNotify).toEqual({ system: true, sound: true });
  });

  it("coerces non-boolean members to false instead of trusting them", () => {
    const merged = mergeConfigForStore({ automationNotify: { system: "yes", sound: 1 } }, "save") as any;
    expect(merged.automationNotify).toEqual({ system: false, sound: false });
  });

  it("ignores a malformed automationNotify block", () => {
    for (const bad of ["on", 42, null, ["system"]]) {
      const merged = mergeConfigForStore({ automationNotify: bad }, "save") as any;
      expect(merged.automationNotify, `automationNotify ${String(bad)}`).toEqual({ system: false, sound: false });
    }
  });
});
