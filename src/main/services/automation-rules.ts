// Automation rule CRUD — shared by the IPC handlers and the local REST API.
// Pure config manipulation (no scheduler timers here); callers trigger
// reloadSchedule() after a successful mutation.
//
// Single write path: store.transact drafts from the live config, normalizes,
// and persists atomically. There is deliberately NO getConfig()+mutate+save
// fallback — a failed transact surfaces its error so callers see the failure
// instead of writing through a stale/live-mutated singleton (#28).
import { transact } from "./config/store.js";
import { validateCron } from "./cron-validate.js";
import { normalizeTemplateInputs } from "./config-manager.js";
import { validateTemplateInputsForAction } from "./run-verifiers.js";
import type { AutomationRule } from "../types.js";


function newRuleId(): string {
  return "rule_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Identity of the current plan (rule version). Reissued only when the rule's
 * semantics actually change — see planChanged(). The `plan_` prefix and
 * character set are load-bearing: normalizeAutomationRules validates against
 * them, so a value that does not look main-generated is dropped on save.
 */
export function newPlanId(): string {
  return "plan_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Stable stringify so key order cannot make two equal plans look different. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((value as any)[k])).join(",") + "}";
}

/**
 * Does this update change what the rule actually DOES?
 *
 * Only trigger and action count. A rename, an enable/disable toggle, or a
 * retry/timeout tweak are not new plans, and the renderer re-sends the whole
 * rule object on every one of those paths — so treating any update as a new
 * plan would make "has this plan run yet?" meaningless.
 */
export function planChanged(stored: Partial<AutomationRule>, incoming: Partial<AutomationRule>): boolean {
  return canonical(stored.trigger) !== canonical(incoming.trigger)
    || canonical(stored.action) !== canonical(incoming.action);
}

/** Authoritative semantic check for structured template inputs (M2). Throws
 *  on invalid input; rules without a machine-checkable template pass. */
function assertTemplateInputsValid(action: AutomationRule["action"]): void {
  const res = validateTemplateInputsForAction(action || {}, normalizeTemplateInputs);
  if (!res.ok) throw new Error(res.error);
}

export function createAutomationRule(input: Partial<AutomationRule>): AutomationRule {
  assertTemplateInputsValid(input.action as AutomationRule["action"]);
  const full: AutomationRule = {
    id: input.id || newRuleId(),
    name: String(input.name || "Untitled").slice(0, 120),
    enabled: input.enabled !== false,
    trigger: input.trigger as any,
    action: input.action as any,
    createdAt: Date.now(),
    // A brand-new rule is a brand-new plan. Callers cannot supply one.
    planId: newPlanId(),
    ...(typeof input.runTimeoutMs === "number" ? { runTimeoutMs: input.runTimeoutMs } : {}),
    ...(Number.isInteger(input.maxRetries) ? { maxRetries: input.maxRetries } : {}),
  };
  if (full.trigger?.type === "cron" && full.trigger.cron) validateCron(full.trigger.cron);
  transact((draft: any) => { draft.automation = draft.automation || []; draft.automation.push(full); });
  return full;
}

export function updateAutomationRule(rule: AutomationRule): { success: boolean; rule?: AutomationRule; error?: string; planReissued?: boolean } {
  if (rule.trigger?.type === "cron" && rule.trigger.cron) validateCron(rule.trigger.cron);
  try {
    assertTemplateInputsValid(rule.action);
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
  let updated: any = null;
  let found = false;
  let planReissued = false;
  transact((draft: any) => {
    draft.automation = draft.automation || [];
    const idx = draft.automation.findIndex((r: AutomationRule) => r.id === rule.id);
    if (idx < 0) return;
    found = true;
    const stored = draft.automation[idx] as AutomationRule;
    // planId is derived here, never taken from the payload: a caller must not
    // be able to assert "this is still the old plan" (which would let a stale
    // success stand in for a changed rule) or invent a fresh one.
    const nextPlanId = planChanged(stored, rule) || !stored.planId ? newPlanId() : stored.planId;
    planReissued = nextPlanId !== stored.planId;
    // A semantic change invalidates any previous "this once was missed" mark:
    // the user has just edited the plan, so the stale miss no longer applies.
    draft.automation[idx] = {
      ...stored,
      ...rule,
      planId: nextPlanId,
      ...(planReissued ? { missedAt: undefined } : {}),
    };
    if (planReissued) delete draft.automation[idx].missedAt;
    updated = draft.automation[idx];
  });
  if (!found) return { success: false, error: "rule not found" };
  return { success: true, rule: updated as AutomationRule, planReissued };
}

/**
 * Reschedule a missed `once` (M3).
 *
 * This is the ONLY new mutation M3 adds, and it is deliberately the only way a
 * missed once recovers: the scheduler never auto-catches-up and never re-arms a
 * past-due rule on its own. Setting a new `at` is a new plan, so it gets a new
 * planId — the previous plan's history stays visible in `lastRunAt`/`lastResult`
 * but cannot be read as "this plan already ran".
 */
export function rescheduleOnceRule(ruleId: string, at: number): { success: boolean; rule?: AutomationRule; error?: string } {
  if (!Number.isFinite(at)) return { success: false, error: "invalid schedule time" };
  if (at <= Date.now()) return { success: false, error: "reschedule time must be in the future" };
  let updated: any = null;
  let found = false;
  transact((draft: any) => {
    const idx = (draft.automation || []).findIndex((r: AutomationRule) => r.id === ruleId);
    if (idx < 0) return;
    found = true;
    const stored = draft.automation[idx] as AutomationRule;
    if (stored.trigger?.type !== "once") return;
    draft.automation[idx] = {
      ...stored,
      enabled: true,
      trigger: { ...stored.trigger, at },
      planId: newPlanId(),
      // lastRunAt / lastResult are intentionally preserved: they are the
      // historical record, and the new plan is outcome-free by virtue of its
      // new planId rather than by erasing history.
    };
    delete draft.automation[idx].missedAt;
    updated = draft.automation[idx];
  });
  if (!found) return { success: false, error: "rule not found" };
  if (!updated) return { success: false, error: "only a once rule can be rescheduled" };
  return { success: true, rule: updated as AutomationRule };
}

export function deleteAutomationRule(ruleId: string): boolean {
  let deleted = false;
  transact((draft: any) => {
    const before = (draft.automation || []).length;
    draft.automation = (draft.automation || []).filter((r: AutomationRule) => r.id !== ruleId);
    deleted = draft.automation.length !== before;
  });
  return deleted;
}
