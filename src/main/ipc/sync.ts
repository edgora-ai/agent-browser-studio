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

  ipcMain.handle("sync:push", async (_event, opts?: { force?: boolean; comparisonToken?: SyncComparisonToken }): Promise<SyncResult> => {
    return syncService.push(undefined, opts?.force === true, opts?.comparisonToken);
  });

  ipcMain.handle("sync:pull", async (_event, opts?: { strategy?: string; resolutions?: Record<string, string>; comparisonToken?: SyncComparisonToken }): Promise<SyncResult> => {
    const strategy = opts?.strategy === "remote" || opts?.strategy === "newest" ? opts.strategy : "local";
    const resolutions: Record<string, "local" | "remote" | "newest"> = {};
    for (const [key, value] of Object.entries(opts?.resolutions || {})) {
      if (value === "local" || value === "remote" || value === "newest") resolutions[key] = value;
    }
    return syncService.pull(undefined, { strategy, resolutions, comparisonToken: opts?.comparisonToken });
  });

  ipcMain.handle("sync:status", async () => syncService.getStatus());
  ipcMain.handle("sync:preview", async () => syncService.preview());
  ipcMain.handle("sync:preview-diff", async () => syncService.previewDiff());

  ipcMain.handle("sync:configure", async (_event, config: Partial<SyncConfig> & { custodyConsent?: boolean }): Promise<{ success: boolean; error?: string; code?: string }> => {
    const gate = requireSettingsMutation();
    if (!gate.ok) return { success: false, code: "TEAM_ROLE_DENIED", error: gate.error };
    try {
      setSyncConfig(config);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
}
