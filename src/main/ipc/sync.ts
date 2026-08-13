import { ipcMain } from "electron";
import { syncService } from "../services/sync-service.js";
import { getSyncConfig, setSyncConfig } from "../services/config-manager.js";
import type { SyncResult, SyncConfig } from "../types.js";

export function registerSyncHandlers(): void {
  ipcMain.handle("sync:push", async (_event, opts?: { force?: boolean }): Promise<SyncResult> => {
    return syncService.push(undefined, Boolean(opts?.force));
  });

  ipcMain.handle("sync:pull", async (_event, opts?: { strategy?: string; resolutions?: Record<string, string> }): Promise<SyncResult> => {
    const strategy = (opts?.strategy === "remote" || opts?.strategy === "newest" ? opts.strategy : "local");
    const resolutions: Record<string, "local" | "remote" | "newest"> = {};
    for (const [key, value] of Object.entries(opts?.resolutions || {})) {
      if (value === "local" || value === "remote" || value === "newest") resolutions[key] = value;
    }
   const result = await syncService.pull(undefined, { strategy, resolutions });
    return result;
  });

  ipcMain.handle("sync:status", async () => {
    return syncService.getStatus();
  });

  ipcMain.handle("sync:preview", async () => {
    return syncService.preview();
  });

  ipcMain.handle("sync:preview-diff", async (): Promise<any> => {
    return syncService.previewDiff();
  });

  ipcMain.handle("sync:configure", async (_event, config: Partial<SyncConfig>): Promise<{ success: boolean; error?: string }> => {
    try {
      setSyncConfig(config);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
}
