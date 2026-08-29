import { ipcMain } from "electron";
import { runWebRtcDiagnostics, listWebRtcDiagnostics, clearWebRtcDiagnostics } from "../services/webrtc-diagnostics.js";
import { validateDirId } from "../services/utils.js";

export function registerWebRtcHandlers(): void {
  // Run one in-browser WebRTC probe for a profile and persist history.
  // Starting a stopped profile is opt-in (review item PL-03).
  ipcMain.handle("webrtc:diag", async (_event, params: { dirId: string; allowLaunch?: boolean }) => {
    const dirId = String(params?.dirId || "");
    validateDirId(dirId);
    return runWebRtcDiagnostics(dirId, { allowLaunch: params?.allowLaunch === true });
  });

  // Read persisted WebRTC diagnostics history for a profile.
  ipcMain.handle("webrtc:diag-history", async (_event, dirId: string) => {
    validateDirId(dirId);
    return { success: true, entries: listWebRtcDiagnostics(dirId) };
  });

  // Clear persisted WebRTC diagnostics history for a profile.
  ipcMain.handle("webrtc:diag-clear", async (_event, dirId: string) => {
    validateDirId(dirId);
    clearWebRtcDiagnostics(dirId);
    return { success: true };
  });
}

