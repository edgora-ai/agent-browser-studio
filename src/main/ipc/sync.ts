import { BrowserWindow, ipcMain } from "electron";
import { syncService } from "../services/sync-service.js";
import { setSyncConfig } from "../services/config-manager.js";
import { requireSettingsMutation } from "../services/team.js";
import { onEvent } from "../services/event-bus.js";
import type { SyncResult, SyncConfig, SyncComparisonToken } from "../types.js";

let unsubscribeSyncEvents: (() => void) | undefined;

export function registerSyncHandlers(): void {
  unsubscribeSyncEvents?.();
  unsubscribeSyncEvents = onEvent("sync:state-changed", (payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try { window.webContents.send("sync:state-changed", payload); }
      catch (error) { console.warn("[sync] Could not notify a closing renderer:", error); }
    }
  });

  ipcMain.handle("sync:push", async (_event, opts?: { force?: boolean; comparisonToken?: SyncComparisonToken; history?: boolean }): Promise<SyncResult> => {
    if (opts?.history !== undefined && typeof opts.history !== "boolean") return { success: false, code: "INVALID_HISTORY_SCOPE", message: "History scope must be a boolean" };
    return opts?.history === undefined ? syncService.push(undefined, opts?.force === true, opts?.comparisonToken)
      : syncService.push(undefined, opts?.force === true, opts?.comparisonToken, { history: opts.history });
  });

  ipcMain.handle("sync:pull", async (_event, opts?: { strategy?: string; resolutions?: Record<string, string>; comparisonToken?: SyncComparisonToken; history?: boolean; allowRunningPartial?: boolean }): Promise<SyncResult> => {
    if (opts?.history !== undefined && typeof opts.history !== "boolean") return { success: false, code: "INVALID_HISTORY_SCOPE", message: "History scope must be a boolean" };
    if (opts?.allowRunningPartial !== undefined && typeof opts.allowRunningPartial !== "boolean") return { success: false, code: "INVALID_RUNNING_SCOPE", message: "Running-profile partial restore must be explicitly enabled with a boolean" };
    // Omission belongs to the service's selected scope, not the transport.
    const strategy = opts?.strategy === undefined ? undefined
      : opts.strategy === "remote" || opts.strategy === "newest" ? opts.strategy : "local";
    const resolutions: Record<string, "local" | "remote" | "newest"> = {};
    for (const [key, value] of Object.entries(opts?.resolutions || {})) {
      if (value === "local" || value === "remote" || value === "newest") resolutions[key] = value;
    }
    return syncService.pull(undefined, { strategy, resolutions, comparisonToken: opts?.comparisonToken, ...(opts?.history === undefined ? {} : { history: opts.history }),
      ...(opts?.allowRunningPartial === undefined ? {} : { allowRunningPartial: opts.allowRunningPartial }) });
  });

  ipcMain.handle("sync:status", async () => syncService.getStatus());
  ipcMain.handle("sync:history-state", async (_event, dirId: string) => syncService.historyState(dirId));
  ipcMain.handle("sync:preview", async () => syncService.preview());
  ipcMain.handle("sync:preview-diff", async () => syncService.previewDiff());

  ipcMain.handle("sync:configure", async (_event, config: Partial<SyncConfig> & { custodyConsent?: boolean; historyConsent?: boolean; fullProfileConsent?: boolean }): Promise<{ success: boolean; error?: string; code?: string }> => {
    const gate = requireSettingsMutation();
    if (!gate.ok) return { success: false, code: "TEAM_ROLE_DENIED", error: gate.error };
    try {
      setSyncConfig(config);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message, ...(typeof e.code === "string" ? { code: e.code } : {}) };
    }
  });
}
