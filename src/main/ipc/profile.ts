import { ipcMain, dialog } from "electron";
import {
  getProfileInfo,
  listCookies,
  setCookie,
  deleteCookie,
} from "../services/profile-manager.js";
import {
  listBrowserProfiles,
  createBrowserProfile,
  deleteBrowserProfile,
} from "../services/browser-manager.js";
import { setProfileMeta } from "../services/config-manager.js";
import { validateDirId } from "../services/utils.js";
import { exportProfileArchive, importProfileArchive, exportProfileArchives, importProfileArchives } from "../services/profile-archive.js";
import type { GeolocationMode, ProfileInfo, ProxyMode, WebRtcMode } from "../types.js";

export function registerProfileHandlers(): void {
  ipcMain.handle("profile:list", async (): Promise<ProfileInfo[]> => {
    const browserProfiles = listBrowserProfiles();
    const result: ProfileInfo[] = [];
    for (const p of browserProfiles) {
      try {
        result.push(await getProfileInfo(p.dirId));
      } catch (e) {
        // ignore individual failed profiles
      }
    }
    return result.sort((a, b) => b.lastModified - a.lastModified);
  });

  ipcMain.handle("profile:get", async (_event, dirId: string): Promise<ProfileInfo> => {
    validateDirId(dirId);
    return await getProfileInfo(dirId);
  });

  ipcMain.handle("profile:create", async (_event, {
    name,
    fingerprintSeed,
    platform,
    timezone,
    locale,
    webrtcMode,
    webrtcIp,
    geolocationMode,
    geolocationLatitude,
    geolocationLongitude,
    geolocationAccuracy,
    proxyMode,
    proxyName,
  }: {
    name: string;
    fingerprintSeed?: number;
    platform?: "windows" | "macos" | "android";
    timezone?: string;
    locale?: string;
    webrtcMode?: WebRtcMode;
    webrtcIp?: string;
    geolocationMode?: GeolocationMode;
    geolocationLatitude?: number | null;
    geolocationLongitude?: number | null;
    geolocationAccuracy?: number | null;
    proxyMode?: ProxyMode;
    proxyName?: string | null;
  }): Promise<ProfileInfo> => {
    const { dirId } = createBrowserProfile({
      name,
      fingerprintSeed,
      platform,
      timezone,
      locale,
      webrtcMode,
      webrtcIp,
      geolocationMode,
      geolocationLatitude,
      geolocationLongitude,
      geolocationAccuracy,
      proxyMode,
      proxyName,
    });
    return await getProfileInfo(dirId);
  });

  ipcMain.handle("profile:delete", async (_event, dirId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = deleteBrowserProfile(dirId);
      return { success: result };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Profile backup / transfer ──
  ipcMain.handle("profile:export-archive", async (_event, opts: { dirId: string; destPath?: string }): Promise<{
    success: boolean; filePath?: string; entries?: number; bytes?: number; error?: string;
  }> => {
    try {
      let destPath = opts?.destPath;
      if (!destPath) {
        const r = await dialog.showSaveDialog({
          title: "Export Profile Backup",
          defaultPath: "profile-backup.zip",
          filters: [{ name: "Profile backup", extensions: ["zip"] }],
        });
        if (r.canceled || !r.filePath) return { success: false, error: "cancelled" };
        destPath = r.filePath;
      }
      const result = await exportProfileArchive(opts?.dirId, destPath);
      return { success: true, filePath: result.filePath, entries: result.entries, bytes: result.bytes };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("profile:import-archive", async (_event, opts?: { zipPath?: string }): Promise<{
    success: boolean; dirId?: string; name?: string; files?: number; bytes?: number; error?: string;
  }> => {
    try {
      let zipPath = opts?.zipPath;
      if (!zipPath) {
        const r = await dialog.showOpenDialog({
          title: "Import Profile Backup",
          properties: ["openFile"],
          filters: [{ name: "Profile backup", extensions: ["zip"] }],
        });
        if (r.canceled || !r.filePaths?.[0]) return { success: false, error: "cancelled" };
        zipPath = r.filePaths[0];
      }
      const result = importProfileArchive(zipPath);
      return { success: true, dirId: result.dirId, name: result.name, files: result.files, bytes: result.bytes };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  // ── Batch profile backup (export selected profiles / import many zips) ──
  ipcMain.handle("profile:export-archives", async (_event, opts: { dirIds?: string[]; destDir?: string }): Promise<{
    success: boolean; report?: import("../services/profile-archive.js").BatchExportReport; error?: string;
  }> => {
    try {
      let destDir = opts?.destDir;
      if (!destDir) {
        const r = await dialog.showOpenDialog({
          title: "Export Profile Backups",
          properties: ["openDirectory", "createDirectory"],
        });
        if (r.canceled || !r.filePaths?.[0]) return { success: false, error: "cancelled" };
        destDir = r.filePaths[0];
      }
      const report = await exportProfileArchives(opts?.dirIds || [], destDir);
      return { success: true, report };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("profile:import-archives", async (_event, opts?: { zipPaths?: string[] }): Promise<{
    success: boolean; report?: import("../services/profile-archive.js").BatchImportReport; error?: string;
  }> => {
    try {
      let zipPaths = opts?.zipPaths;
      if (!zipPaths || !zipPaths.length) {
        const r = await dialog.showOpenDialog({
          title: "Import Profile Backups",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Profile backup", extensions: ["zip"] }],
        });
        if (r.canceled || !r.filePaths?.length) return { success: false, error: "cancelled" };
        zipPaths = r.filePaths;
      }
      const report = importProfileArchives(zipPaths);
      return { success: true, report };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  // Rename a profile
  ipcMain.handle("profile:rename", async (_event, {
    dirId,
    name,
  }: {
    dirId: string;
    name: string;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      validateDirId(dirId);
      setProfileMeta(dirId, { name });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Cookie management ──
  ipcMain.handle("profile:cookies", async (_event, {
    dirId,
    filter,
  }: {
    dirId: string;
    filter?: string;
  }) => {
    validateDirId(dirId);
    return await listCookies(dirId, filter);
  });

  ipcMain.handle("profile:set-cookie", async (_event, {
    dirId,
    domain,
    name,
    value,
  }: {
    dirId: string;
    domain: string;
    name: string;
    value: string;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      validateDirId(dirId);
      const ok = await setCookie(dirId, { domain, name, value });
      return { success: ok };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("profile:delete-cookie", async (_event, {
    dirId,
    domain,
    name,
  }: {
    dirId: string;
    domain: string;
    name: string;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      validateDirId(dirId);
      const ok = await deleteCookie(dirId, domain, name);
      return { success: ok };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
}
