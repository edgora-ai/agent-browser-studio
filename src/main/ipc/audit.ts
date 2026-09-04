// Audit IPC — expose the audit log to the UI (recent activity / governance view).
import { ipcMain } from "electron";
import { listAudit, clearAudit } from "../services/audit-log.js";

export function registerAuditHandlers(): void {
  ipcMain.handle("audit:list", async (_event, opts?: { limit?: number; category?: string; target?: string }) => {
    return listAudit(opts?.limit ?? 200, { category: opts?.category, target: opts?.target });
  });
  ipcMain.handle("audit:clear", async (event, opts?: { confirmed?: boolean }) => {
    // Destructive + security-sensitive (erases the governance trail): require
    // an explicit confirmation flag from the trusted UI. A bare invoke — e.g.
    // from injected renderer JS via XSS — is rejected without touching the log.
    if (!opts || opts.confirmed !== true) {
      return { success: false, error: "audit:clear requires explicit user confirmation (pass { confirmed: true })" };
    }
    // Only the app's own window may clear; external/fallback webContents cannot.
    try {
      const { BrowserWindow } = await import("electron");
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: "audit:clear rejected: untrusted sender" };
      }
    } catch {
      return { success: false, error: "audit:clear rejected: sender check failed" };
    }
    clearAudit();
    return { success: true };
  });
}
