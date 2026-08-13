import { ipcMain } from "electron";
import { runWebRtcDiagnostics, listWebRtcDiagnostics, clearWebRtcDiagnostics } from "../services/webrtc-diagnostics.js";
import { validateDirId } from "../services/utils.js";

export function registerWebRtcHandlers(): void {
  // Run one in-browser WebRTC probe for a profile (auto-launch if needed) and persist history.
  ipcMain.handle("webrtc:diag", async (_event, dirId: string) => {
    validateDirId(dirId);
    return runWebRtcDiagnostics(dirId);
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

