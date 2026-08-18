import { ipcMain } from "electron";
import {
  findWidevineCdm,
  ensureManagedCdm,
  getDrmStatus,
  setProfileDrm,
  probeDrmViaCdp,
} from "../services/drm.js";
import { setDrmCdmPath } from "../services/config-manager.js";
import { statusBrowser } from "../services/browser-manager.js";
import { getProfileEngineByDirId } from "../services/page-eval.js";
import { recordAudit } from "../services/audit-log.js";

export function registerDrmHandlers(): void {
  // Overall Widevine/DRM availability + per-profile state.
  ipcMain.handle("drm:status", async () => {
    try {
      return { success: true, status: getDrmStatus() };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  // Enable/disable Widevine for one profile.
  ipcMain.handle("drm:set-profile", async (_event, { dirId, enabled }: { dirId: string; enabled: boolean }) => {
    try {
      setProfileDrm(dirId, !!enabled);
      recordAudit({ category: "profile", action: enabled ? "drm-enable" : "drm-disable", target: dirId, actor: "user" });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  // Override (or clear, with null) the Widevine CDM path.
  ipcMain.handle("drm:set-cdm-path", async (_event, cdmPath: string | null) => {
    try {
      const cfg = setDrmCdmPath(cdmPath);
      recordAudit({ category: "settings", action: "drm-cdm-path", target: cfg.cdmPath || "auto", actor: "user" });
      return { success: true, configuredPath: cfg.cdmPath || null };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  // Stage the managed CDM copy and return refreshed status.
  ipcMain.handle("drm:ensure", async () => {
    try {
      const cdm = ensureManagedCdm();
      return { success: true, status: getDrmStatus(), staged: !!cdm };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  // Probe a running profile over CDP for real Widevine availability.
  ipcMain.handle("drm:probe", async (_event, dirId: string) => {
    try {
      const st = statusBrowser(dirId);
      if (!st.running || !st.cdpPort) return { success: false, error: "Profile is not running" };
      const result = await probeDrmViaCdp(st.cdpPort, getProfileEngineByDirId(dirId));
      recordAudit({ category: "profile", action: "drm-probe", target: dirId, actor: "user", detail: result.available ? "widevine available" : (result.error || "widevine unavailable") });
      return { success: true, ...result };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });
}
