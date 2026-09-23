// Data export IPC — pull structured JSON of the user's data (profiles/proxies/
// accounts/runs/jobs/db). Secrets are never exported.
import { ipcMain } from "electron";
import { exportData, isExportScope, EXPORT_SCOPES } from "../services/data-export.js";

export function registerDataHandlers(): void {
  ipcMain.handle("data:export", async (_event, scope: string) => {
    // An unknown scope is an explicit failure. Pre-M2 this returned ok:true
    // with an empty object, which a caller could not tell from "no data".
    if (!isExportScope(scope)) {
      return { ok: false, error: `unknown export scope: ${JSON.stringify(scope)}`, allowed: EXPORT_SCOPES };
    }
    try { return { ok: true, ...exportData(scope) }; }
    catch (e: any) { return { ok: false, error: e.message || String(e) }; }
  });
}
