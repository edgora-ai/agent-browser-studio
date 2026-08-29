// Automation rule CRUD — shared by the IPC handlers and the local REST API.
// Pure config manipulation (no scheduler timers here); callers trigger
// reloadSchedule() after a successful mutation.
import { getConfig, saveConfig } from "./config-manager.js";
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
  try {
    const { transact } = require("./config/store.js");
    transact((draft: any) => { draft.automation = draft.automation || []; draft.automation.push(full); });
  } catch {
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation || [];
    cfg.automation.push(full);
    saveConfig(cfg);
  }
  return full;
}

export function updateAutomationRule(rule: AutomationRule): { success: boolean; rule?: AutomationRule; error?: string } {
  if (rule.trigger?.type === "cron" && rule.trigger.cron) validateCron(rule.trigger.cron);
  let updated: any = null;
  let found = false;
  try {
    const { transact } = require("./config/store.js");
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
  } catch {}
  const cfg = getConfig() as any;
  cfg.automation = cfg.automation || [];
  const idx = cfg.automation.findIndex((r: AutomationRule) => r.id === rule.id);
  if (idx < 0) return { success: false, error: "rule not found" };
  cfg.automation[idx] = { ...cfg.automation[idx], ...rule };
  saveConfig(cfg);
  return { success: true, rule: cfg.automation[idx] };
}

export function deleteAutomationRule(ruleId: string): boolean {
  let deleted = false;
  try {
    const { transact } = require("./config/store.js");
    transact((draft: any) => {
      const before = (draft.automation || []).length;
      draft.automation = (draft.automation || []).filter((r: AutomationRule) => r.id !== ruleId);
      deleted = draft.automation.length !== before;
    });
    return deleted;
  } catch {}
  const cfg = getConfig() as any;
  const before = (cfg.automation || []).length;
  cfg.automation = (cfg.automation || []).filter((r: AutomationRule) => r.id !== ruleId);
  if (cfg.automation.length === before) return false;
  saveConfig(cfg);
  return true;
}
