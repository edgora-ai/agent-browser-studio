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
import type { AutomationRule } from "../types.js";


function newRuleId(): string {
  return "rule_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function createAutomationRule(input: Partial<AutomationRule>): AutomationRule {
  const full: AutomationRule = {
    id: input.id || newRuleId(),
    name: String(input.name || "Untitled").slice(0, 120),
    enabled: input.enabled !== false,
    trigger: input.trigger as any,
    action: input.action as any,
    createdAt: Date.now(),
    ...(typeof input.runTimeoutMs === "number" ? { runTimeoutMs: input.runTimeoutMs } : {}),
    ...(Number.isInteger(input.maxRetries) ? { maxRetries: input.maxRetries } : {}),
  };
  if (full.trigger?.type === "cron" && full.trigger.cron) validateCron(full.trigger.cron);
  transact((draft: any) => { draft.automation = draft.automation || []; draft.automation.push(full); });
  return full;
}

export function updateAutomationRule(rule: AutomationRule): { success: boolean; rule?: AutomationRule; error?: string } {
  if (rule.trigger?.type === "cron" && rule.trigger.cron) validateCron(rule.trigger.cron);
  let updated: any = null;
  let found = false;
  transact((draft: any) => {
    draft.automation = draft.automation || [];
    const idx = draft.automation.findIndex((r: AutomationRule) => r.id === rule.id);
    if (idx < 0) return;
    found = true;
    draft.automation[idx] = { ...draft.automation[idx], ...rule };
    updated = draft.automation[idx];
  });
  if (!found) return { success: false, error: "rule not found" };
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
