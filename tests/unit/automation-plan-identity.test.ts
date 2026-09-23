// M3 unit tests: planId lifecycle — when a plan is reissued, and when it must not be.
//
// The failure mode this guards is subtle and asymmetric. If planId bumps too
// eagerly, "has this plan run yet?" becomes meaningless (every rename wipes the
// plan's history). If it never bumps, a stale success from a superseded plan is
// presented as evidence that the CURRENT plan already ran — the exact
// masquerading the milestone exists to remove. Both directions are asserted.
//
// The renderer sends the whole rule object back on every edit (including the
// enable/disable toggle and renames), which is why "any update is a new plan"
// would be wrong in practice and not merely in theory.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// pid-suffixed: concurrent vitest processes must not share one config store.
const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-m3-plan-identity-test-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
}));

import { reloadConfig, getConfig, saveConfig } from "../../src/main/services/config-manager.js";
import {
  createAutomationRule,
  updateAutomationRule,
  rescheduleOnceRule,
  newPlanId,
  planChanged,
} from "../../src/main/services/automation-rules.js";

function onceTrigger(at = Date.now() + 60_000): any {
  return { type: "once", at };
}

function makeRule(overrides: Record<string, unknown> = {}): any {
  return createAutomationRule({
    name: "probe",
    trigger: onceTrigger(),
    action: { type: "sync-push" },
    ...overrides,
  } as any);
}

function stored(ruleId: string): any {
  return (getConfig().automation || []).find((r: any) => r.id === ruleId);
}

describe("planId generation", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    reloadConfig();
    const cfg = getConfig();
    cfg.automation = [];
    saveConfig(cfg);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("mints ids the normalizer accepts", () => {
    // If this regex and the normalizer's ever drift, planId is silently dropped
    // on the next save and every card degrades to "legacy plan".
    for (let i = 0; i < 50; i++) {
      expect(newPlanId()).toMatch(/^plan_[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("does not repeat within a tight loop", () => {
    // Randomness is only 8 base36 chars, so this is a real (if unlikely)
    // collision check, not a tautology: Date.now() is identical across the loop.
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(newPlanId());
    expect(ids.size).toBe(200);
  });

  it("gives a new rule a planId and ignores any caller-supplied one", () => {
    const rule = makeRule({ planId: "plan_forged_by_caller" } as any);
    expect(rule.planId).toMatch(/^plan_/);
    expect(rule.planId).not.toBe("plan_forged_by_caller");
    expect(stored(rule.id).planId).toBe(rule.planId);
  });

  it("survives a config round-trip, not just the in-memory object", () => {
    const rule = makeRule();
    reloadConfig();
    expect(stored(rule.id).planId).toBe(rule.planId);
  });
});

describe("planChanged", () => {
  it("treats a trigger change as a new plan", () => {
    expect(planChanged({ trigger: onceTrigger(1_000) }, { trigger: onceTrigger(2_000) })).toBe(true);
    expect(planChanged(
      { trigger: { type: "cron", cron: "0 3 * * *" } },
      { trigger: { type: "cron", cron: "0 4 * * *" } },
    )).toBe(true);
  });

  it("treats an action change as a new plan", () => {
    expect(planChanged(
      { action: { type: "sync-push" } },
      { action: { type: "sync-pull" } },
    )).toBe(true);
  });

  it("ignores key order, so a re-serialized equal plan is not a new plan", () => {
    // The renderer rebuilds the object; JSON.stringify comparison would report
    // a spurious change here and wipe the plan on every unrelated edit.
    expect(planChanged(
      { trigger: { type: "cron", cron: "0 3 * * *" }, action: { type: "sync-push", profileDirId: "ab_1" } },
      { action: { profileDirId: "ab_1", type: "sync-push" }, trigger: { cron: "0 3 * * *", type: "cron" } },
    )).toBe(false);
  });

  it("compares nested action structures, not just their top level", () => {
    expect(planChanged(
      { action: { type: "agent-task", templateInputs: { topic: "a" } } },
      { action: { type: "agent-task", templateInputs: { topic: "b" } } },
    )).toBe(true);
  });

  it("ignores name, enabled and retry knobs", () => {
    const base = { trigger: onceTrigger(5_000), action: { type: "sync-push" } };
    expect(planChanged(base, { ...base, name: "renamed" })).toBe(false);
    expect(planChanged(base, { ...base, enabled: false })).toBe(false);
    expect(planChanged(base, { ...base, runTimeoutMs: 1000, maxRetries: 3 })).toBe(false);
  });
});

describe("planId reissue on update", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    reloadConfig();
    const cfg = getConfig();
    cfg.automation = [];
    saveConfig(cfg);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("keeps the planId across a rename", () => {
    const rule = makeRule();
    const r = updateAutomationRule({ ...rule, name: "renamed" } as any);
    expect(r.success).toBe(true);
    expect(r.planReissued).toBe(false);
    expect(r.rule!.planId).toBe(rule.planId);
    expect(stored(rule.id).planId).toBe(rule.planId);
  });

  it("keeps the planId across an enable/disable toggle", () => {
    // automationToggle re-sends the entire rule. If that bumped the plan, every
    // toggle would erase the rule's result history.
    const rule = makeRule();
    const off = updateAutomationRule({ ...rule, enabled: false } as any);
    expect(off.planReissued).toBe(false);
    expect(off.rule!.planId).toBe(rule.planId);

    const on = updateAutomationRule({ ...off.rule, enabled: true } as any);
    expect(on.planReissued).toBe(false);
    expect(on.rule!.planId).toBe(rule.planId);
  });

  it("reissues the planId when the trigger changes", () => {
    const rule = makeRule();
    const r = updateAutomationRule({ ...rule, trigger: onceTrigger(Date.now() + 120_000) } as any);
    expect(r.planReissued).toBe(true);
    expect(r.rule!.planId).not.toBe(rule.planId);
    expect(stored(rule.id).planId).toBe(r.rule!.planId);
  });

  it("reissues the planId when the action changes", () => {
    const rule = makeRule();
    const r = updateAutomationRule({ ...rule, action: { type: "sync-pull" } } as any);
    expect(r.planReissued).toBe(true);
    expect(r.rule!.planId).not.toBe(rule.planId);
  });

  it("ignores a payload planId that claims the old plan", () => {
    // Forgery worth blocking: asserting "this is still the old plan" so a
    // superseded plan's success would count as evidence for the new one.
    const rule = makeRule();
    const r = updateAutomationRule({
      ...rule, trigger: onceTrigger(Date.now() + 120_000), planId: rule.planId,
    } as any);
    expect(r.planReissued).toBe(true);
    expect(r.rule!.planId).not.toBe(rule.planId);
  });

  it("ignores a payload planId that invents a fresh one", () => {
    // The mirror forgery: a fresh id would make the plan look outcome-free
    // while its real history still stands. Asserted against the CURRENT stored
    // id (not the original) because this is a separate rule with no prior edit.
    const rule = makeRule();
    const r = updateAutomationRule({ ...rule, name: "renamed", planId: "plan_injected" } as any);
    expect(r.planReissued).toBe(false);
    expect(r.rule!.planId).toBe(rule.planId);
    expect(r.rule!.planId).not.toBe("plan_injected");
  });

  it("mints a planId for a legacy rule that has none", () => {
    // Pre-M3 rules carry no planId. Adopting one on the next edit is what lets
    // their future runs be attributed at all; it is not a semantic change.
    const rule = makeRule();
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation.map((r: any) => {
      const { planId, ...rest } = r;
      return rest;
    });
    saveConfig(cfg);
    expect(stored(rule.id).planId).toBeUndefined();

    const r = updateAutomationRule({ ...rule, name: "renamed" } as any);
    expect(r.success).toBe(true);
    expect(r.rule!.planId).toMatch(/^plan_/);
  });

  it("clears a stale missedAt when the plan is reissued", () => {
    const rule = makeRule();
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation.map((r: any) => (r.id === rule.id ? { ...r, missedAt: 1_700_000_000_000 } : r));
    saveConfig(cfg);
    expect(stored(rule.id).missedAt).toBe(1_700_000_000_000);

    const r = updateAutomationRule({ ...rule, trigger: onceTrigger(Date.now() + 120_000) } as any);
    expect(r.planReissued).toBe(true);
    expect(stored(rule.id).missedAt).toBeUndefined();
  });

  it("keeps a missedAt when the edit is not a semantic change", () => {
    // Renaming a rule the user has already been told is missed must not
    // silently un-miss it.
    const rule = makeRule();
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation.map((r: any) => (r.id === rule.id ? { ...r, missedAt: 1_700_000_000_000 } : r));
    saveConfig(cfg);

    const r = updateAutomationRule({ ...rule, name: "renamed" } as any);
    expect(r.planReissued).toBe(false);
    expect(stored(rule.id).missedAt).toBe(1_700_000_000_000);
  });
});

describe("rescheduleOnceRule", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    reloadConfig();
    const cfg = getConfig();
    cfg.automation = [];
    saveConfig(cfg);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("moves the time, re-enables, reissues the plan and clears the miss", () => {
    const rule = makeRule({ enabled: false });
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation.map((r: any) => (r.id === rule.id ? { ...r, missedAt: 1_700_000_000_000 } : r));
    saveConfig(cfg);

    const at = Date.now() + 3_600_000;
    const r = rescheduleOnceRule(rule.id, at);
    expect(r.success).toBe(true);
    const got = stored(rule.id);
    expect(got.trigger.at).toBe(at);
    expect(got.enabled).toBe(true);
    expect(got.planId).not.toBe(rule.planId);
    expect(got.missedAt).toBeUndefined();
  });

  it("preserves run history rather than erasing it", () => {
    // The new plan is outcome-free by virtue of its new planId. Deleting the
    // old result would destroy the very evidence the user just acted on.
    const rule = makeRule();
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation.map((r: any) =>
      r.id === rule.id ? { ...r, lastRunAt: 1_600_000_000_000, lastResult: "failed: boom" } : r);
    saveConfig(cfg);

    const r = rescheduleOnceRule(rule.id, Date.now() + 3_600_000);
    expect(r.success).toBe(true);
    expect(stored(rule.id).lastRunAt).toBe(1_600_000_000_000);
    expect(stored(rule.id).lastResult).toBe("failed: boom");
  });

  it("refuses a past time instead of silently creating another dead rule", () => {
    const rule = makeRule();
    const r = rescheduleOnceRule(rule.id, Date.now() - 1_000);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/future/);
    expect(stored(rule.id).trigger.at).toBe(rule.trigger.at);
  });

  it("refuses a non-finite time", () => {
    const rule = makeRule();
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(rescheduleOnceRule(rule.id, bad).success).toBe(false);
    }
    expect(stored(rule.id).trigger.at).toBe(rule.trigger.at);
  });

  it("refuses an unknown rule and a non-once rule", () => {
    expect(rescheduleOnceRule("rule_nope", Date.now() + 60_000).success).toBe(false);

    const cron = createAutomationRule({
      name: "cron rule",
      trigger: { type: "cron", cron: "0 3 * * *" },
      action: { type: "sync-push" },
    } as any);
    const r = rescheduleOnceRule(cron.id, Date.now() + 60_000);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/once/);
  });

  it("refuses an event rule", () => {
    const ev = createAutomationRule({
      name: "event rule",
      trigger: { type: "event", event: "profile:launched" },
      action: { type: "sync-push" },
    } as any);
    expect(rescheduleOnceRule(ev.id, Date.now() + 60_000).success).toBe(false);
  });
});
