// Automation IPC handlers — CRUD + test-run + logs
import { ipcMain } from "electron";
import { getConfig } from "../services/config-manager.js";
import { createAutomationRule, updateAutomationRule, deleteAutomationRule } from "../services/automation-rules.js";
import { reloadSchedule, testRunRule, getRunLogs, validateCron, cancelRunningJob, retryAgentRun, retryJobRuns } from "../services/automation.js";
import { listJobs, getJob, markCancelled } from "../services/job-store.js";
import type { AutomationRule } from "../types.js";

export function registerAutomationHandlers(): void {
  ipcMain.handle("automation:list", async () => {
    const cfg = getConfig() as any;
    return cfg.automation || [];
  });

  ipcMain.handle("automation:create", async (_event, rule: Partial<AutomationRule>) => {
    try {
      const full = createAutomationRule(rule);
      reloadSchedule();
      return { success: true, rule: full };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("automation:update", async (_event, rule: AutomationRule) => {
    try {
      const r = updateAutomationRule(rule);
      if (r.success) reloadSchedule();
      return r;
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("automation:delete", async (_event, ruleId: string) => {
    try {
      const ok = deleteAutomationRule(ruleId);
      if (ok) reloadSchedule();
      return { success: ok };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("automation:test-run", async (_event, ruleId: string) => {
    return await testRunRule(ruleId);
  });

  ipcMain.handle("automation:retry-run", async (_event, runId: string) => {
    return await retryAgentRun(runId);
  });

  ipcMain.handle("automation:retry-job", async (_event, jobId: string) => {
    return await retryJobRuns(jobId);
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
