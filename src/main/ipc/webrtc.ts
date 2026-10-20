import { ipcMain } from "electron";
import { runWebRtcDiagnostics, listWebRtcDiagnostics } from "../services/webrtc-diagnostics.js";
import { statusBrowser } from "../services/browser-manager.js";
import { clearProfileHealthHistory } from "../services/profile-health.js";
import { gatedLaunch, withIpcHealthOwner } from "./browser.js";
import { validateDirId } from "../services/utils.js";

export function registerWebRtcHandlers(): void {
  // Run one in-browser WebRTC probe for a profile and persist history.
  // Starting a stopped profile is opt-in (review item PL-03).
  ipcMain.handle("webrtc:diag", async (event, params: { dirId: string; allowLaunch?: boolean; requestId?: string }) => {
    try {
      const dirId = params?.dirId;
      validateDirId(dirId);
      return await withIpcHealthOwner(event, async (options) => {
        // Starting from diagnostics is still a launch, not a license/team bypass.
        if (!statusBrowser(dirId).running && params?.allowLaunch === true) await gatedLaunch(dirId);
        // Do not let the service start implicitly if the runtime disappears
        // between the check above and the probe's own guarded preparation.
        return runWebRtcDiagnostics(dirId, { ...options, requestId: params?.requestId, allowLaunch: false });
      });
    } catch (error: any) {
      return { ok: false, outcome: "error", requestId: params?.requestId, code: error?.code, error: error?.message || String(error) };
    }
  });

  // Read persisted WebRTC diagnostics history for a profile.
  ipcMain.handle("webrtc:diag-history", async (_event, dirId: string) => {
    validateDirId(dirId);
    return { success: true, entries: listWebRtcDiagnostics(dirId) };
  });

  // Clear persisted WebRTC diagnostics history for a profile.
  ipcMain.handle("webrtc:diag-clear", async (_event, dirId: string) => {
    validateDirId(dirId);
    clearProfileHealthHistory(dirId, "webrtc");
    return { success: true };
  });
}

