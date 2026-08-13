import { ipcMain } from "electron";
import { syncService } from "../services/sync-service.js";
import { getSyncConfig, setSyncConfig } from "../services/config-manager.js";
import type { SyncResult, SyncConfig } from "../types.js";

export function registerSyncHandlers(): void {
  ipcMain.handle("sync:push", async (): Promise<SyncResult> => {
    return syncService.push();
  });

  ipcMain.handle("sync:pull", async (): Promise<SyncResult> => {
    return syncService.pull();
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
