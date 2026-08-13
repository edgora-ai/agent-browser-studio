// Automation 数据层(CRUD) — 从 automation.ts 拆出,避免循环依赖
// (automation.ts import agentChat,local-agent import automation 会环)
// 这里只做 config 读写,调度由 automation.ts 管。
import { getConfig, saveConfig } from "./config-manager.js";
import { reloadSchedule } from "./automation.js";
import type { AutomationRule, AutomationTrigger, AutomationAction, AutomationTriggerType, AutomationActionType } from "../types.js";

const TRIGGER_TYPES = new Set(["cron", "once", "event"]);
const ACTION_TYPES = new Set(["launch-profile", "stop-profile", "agent-task", "sync-push", "sync-pull", "custom-js"]);
const EVENTS = new Set(["profile:launched", "profile:exited"]);

function newRuleId(): string {
  return "rule_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function createAutomationRule(args: any): { success: boolean; rule?: AutomationRule; error?: string } {
  try {
    const name = String(args?.name || "Untitled").slice(0, 120);
    const t = args?.trigger || {};
    const triggerType = TRIGGER_TYPES.has(t.type) ? t.type as AutomationTriggerType : null;
    if (!triggerType) return { success: false, error: "invalid trigger type" };
    const a = args?.action || {};
    const actionType = ACTION_TYPES.has(a.type) ? a.type as AutomationActionType : null;
    if (!actionType) return { success: false, error: "invalid action type" };
    const trigger: AutomationTrigger = { type: triggerType };
    if (triggerType === "cron" && typeof t.cron === "string") trigger.cron = t.cron.slice(0, 100);
    if (triggerType === "once" && typeof t.at === "number") trigger.at = t.at;
    if (triggerType === "event" && EVENTS.has(t.event)) {
      trigger.event = t.event as any;
      if (t.profileFilter) trigger.profileFilter = String(t.profileFilter).slice(0, 100);
    }
    const action: AutomationAction = { type: actionType };
    if (a.profileDirId) action.profileDirId = String(a.profileDirId).slice(0, 100);
    if (Array.isArray(a.profileDirIds)) {
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const id of a.profileDirIds) {
        if (typeof id !== "string") continue;
        const trimmed = id.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        ids.push(trimmed.slice(0, 100));
        if (ids.length >= 100) break;
      }
      if (ids.length) action.profileDirIds = ids;
    }
    if (Number.isInteger(a.concurrency)) action.concurrency = Math.min(Math.max(a.concurrency, 1), 16);
    if (typeof a.templateId === "string") action.templateId = a.templateId.slice(0, 80);
    if (typeof a.agentPrompt === "string") action.agentPrompt = a.agentPrompt.slice(0, 8000);
    if (typeof a.jsCode === "string") action.jsCode = a.jsCode.slice(0, 50000);
    const rule: AutomationRule = {
      id: newRuleId(), name, enabled: args?.enabled !== false,
      trigger, action, createdAt: Date.now(),
    };
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation || [];
    cfg.automation.push(rule);
    saveConfig(cfg);
    reloadSchedule();
    return { success: true, rule };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

export function deleteAutomationRule(ruleId: string): { success: boolean } {
  const cfg = getConfig() as any;
  cfg.automation = (cfg.automation || []).filter((r: AutomationRule) => r.id !== ruleId);
  saveConfig(cfg);
  reloadSchedule();
  return { success: true };
}
