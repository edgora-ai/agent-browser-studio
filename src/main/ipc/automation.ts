// Automation IPC handlers — CRUD + test-run + logs
import { ipcMain } from "electron";
import { getConfig, saveConfig } from "../services/config-manager.js";
import { reloadSchedule, testRunRule, getRunLogs, validateCron, cancelRunningJob, retryAgentRun } from "../services/automation.js";
import { listJobs, getJob, markCancelled } from "../services/job-store.js";
import type { AutomationRule } from "../types.js";

function newRuleId(): string {
  return "rule_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function registerAutomationHandlers(): void {
  ipcMain.handle("automation:list", async () => {
    const cfg = getConfig() as any;
    return cfg.automation || [];
  });

  ipcMain.handle("automation:create", async (_event, rule: Partial<AutomationRule>) => {
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation || [];
    const full: AutomationRule = {
      id: rule.id || newRuleId(),
      name: String(rule.name || "Untitled").slice(0, 120),
      enabled: rule.enabled !== false,
      trigger: rule.trigger as any,
      action: rule.action as any,
      createdAt: Date.now(),
      ...(typeof rule.runTimeoutMs === "number" ? { runTimeoutMs: rule.runTimeoutMs } : {}),
      ...(Number.isInteger(rule.maxRetries) ? { maxRetries: rule.maxRetries } : {}),
    };
    // validate cron if present
    if (full.trigger?.type === "cron" && full.trigger.cron) validateCron(full.trigger.cron);
    cfg.automation.push(full);
    saveConfig(cfg);
    reloadSchedule();
    return { success: true, rule: full };
  });

  ipcMain.handle("automation:update", async (_event, rule: AutomationRule) => {
    const cfg = getConfig() as any;
    cfg.automation = cfg.automation || [];
    const idx = cfg.automation.findIndex((r: AutomationRule) => r.id === rule.id);
    if (idx < 0) return { success: false, error: "rule not found" };
    if (rule.trigger?.type === "cron" && rule.trigger.cron) validateCron(rule.trigger.cron);
    cfg.automation[idx] = { ...cfg.automation[idx], ...rule };
    saveConfig(cfg);
    reloadSchedule();
    return { success: true, rule: cfg.automation[idx] };
  });

  ipcMain.handle("automation:delete", async (_event, ruleId: string) => {
    const cfg = getConfig() as any;
    cfg.automation = (cfg.automation || []).filter((r: AutomationRule) => r.id !== ruleId);
    saveConfig(cfg);
    reloadSchedule();
    return { success: true };
  });

  ipcMain.handle("automation:test-run", async (_event, ruleId: string) => {
    return await testRunRule(ruleId);
  });

  ipcMain.handle("automation:retry-run", async (_event, runId: string) => {
    return await retryAgentRun(runId);
  });

  ipcMain.handle("automation:logs", async () => {
    return getRunLogs();
  });

  ipcMain.handle("automation:validate-cron", async (_event, expr: string) => {
    try { validateCron(expr); return { valid: true }; }
    catch (e: any) { return { valid: false, error: e.message }; }
  });

  // Durable job queue inspection / control.
  ipcMain.handle("automation:jobs", async (_event, opts?: { status?: string; ruleId?: string; limit?: number }) => {
    return listJobs({ status: opts?.status as any, ruleId: opts?.ruleId, limit: opts?.limit });
  });
  ipcMain.handle("automation:job-get", async (_event, id: string) => {
    return getJob(id);
  });
  ipcMain.handle("automation:job-cancel", async (_event, id: string) => {
    const success = markCancelled(id);
    if (success) cancelRunningJob(id);
    return { success };
  });
}
