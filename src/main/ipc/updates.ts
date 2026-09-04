import { ipcMain } from "electron";
import {
  checkForUpdates,
  installRelease,
  activateVersion,
  rollback,
  getUpdateState,
  getCurrentVersion,
} from "../services/update-manager.js";
import { recordAudit } from "../services/audit-log.js";

export function registerUpdateHandlers(): void {
  ipcMain.handle("updates:status", async () => {
    try {
      return { success: true, currentVersion: getCurrentVersion(), state: getUpdateState() };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("updates:check", async (_event, { manifestUrl }: { manifestUrl?: string } = {}) => {
    try {
      // Caller-supplied overrides are untrusted: validate before fetching.
      // (The UI never sends an override; this closes the SSRF/LFI path for
      // compromised renderers or future callers.)
      let safeUrl: string | undefined;
      if (manifestUrl != null && manifestUrl !== "") {
        const { assertSafeManifestUrl } = await import("../services/update-manager.js");
        safeUrl = await assertSafeManifestUrl(manifestUrl);
      }
      const result = await checkForUpdates(safeUrl);
      return { success: true, ...result };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("updates:install", async (_event, { version }: { version: string }) => {
    try {
      const state = await installRelease(version);
      return { success: true, state };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("updates:activate", async (_event, { version }: { version: string }) => {
    try {
      const state = activateVersion(version);
      recordAudit({ category: "updates", action: "activate-request", target: version, actor: "user" });
      return { success: true, state };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("updates:rollback", async () => {
    try {
      const state = rollback();
      return { success: true, state };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });
}
