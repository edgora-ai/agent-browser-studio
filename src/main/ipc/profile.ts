import { ipcMain, dialog } from "electron";
import * as fs from "node:fs";
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
  trashBrowserProfile,
  restoreTrashedProfile,
  listTrashedProfiles,
  purgeExpiredTrash,
  purgeTrashedProfile,
} from "../services/browser-manager.js";
import { setProfileMeta } from "../services/config-manager.js";
import { checkCreateAllowed } from "../services/license.js";
import { validateDirId } from "../services/utils.js";
import { exportProfileArchive, importProfileArchive, exportProfileArchives, importProfileArchives,
  archiveOperationFailure, classifyArchiveBatchReport, getProfileArchiveExportConflicts,
} from "../services/profile-archive.js";
import { tMain } from "../services/main-i18n.js";
import { assertSafeArchiveExportPath, assertSafeArchiveExportDir, assertSafeArchiveImportPath } from "../services/archive-path-guard.js";
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
  }): Promise<ProfileInfo | { success: false; error: string; code?: string }> => {
    // S5 (#108) + review R2: the legacy alias must carry the same license
    // gate as browser:create AND the same {success:false,code} shape — a
    // throw bypasses the renderer's interceptLicenseGate (paywall dialog).
    const gate = checkCreateAllowed();
    if (!gate.allowed) {
      return { success: false as const, error: gate.error || "License gate refused", code: gate.code };
    }
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

  // ── Recoverable delete (review item PL-09) ──
  // The UI deletes through this channel so a mis-click can be undone for
  // seven days; `profile:delete` remains the hard delete used by the REST API.
  ipcMain.handle("profile:trash", async (_event, dirId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      return { success: trashBrowserProfile(dirId) };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("profile:trash-restore", async (_event, dirId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      return { success: restoreTrashedProfile(dirId) };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("profile:trash-list", async () => {
    let sweepError: unknown;
    try { purgeExpiredTrash(); } // Sweep expired entries whenever the trash is inspected.
    catch (error) { sweepError = error; }
    try {
      const entries = listTrashedProfiles();
      return sweepError
        ? { success: false, entries, error: String(sweepError) }
        : { success: true, entries };
    } catch (error) {
      const listingError = String(error);
      const sweepMessage = sweepError ? String(sweepError) : "";
      return { success: false, entries: [], error: sweepMessage && sweepMessage !== listingError
        ? `${sweepMessage}; trash listing failed: ${listingError}`
        : listingError };
    }
  });

  // R10 UX P1-1: permanent delete of one trashed profile. The UI gates this
  // behind a type-to-confirm dialog — there is no undo after this returns.
  ipcMain.handle("profile:trash-purge", async (_event, dirId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      return { success: purgeTrashedProfile(dirId) };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Profile backup / transfer ──
  const archiveCancelled = () => ({ success: false as const, outcome: "cancelled" as const, cancelled: true, code: "ARCHIVE_CANCELLED", error: "cancelled" });
  const archiveArray = (values: unknown, label: string): string[] => {
    if (!Array.isArray(values) || !values.length || Array.from(values).some((value) => typeof value !== "string" || !value.trim())) {
      throw Object.assign(new Error(`${label} must be a non-empty array of non-empty strings`), { code: "ARCHIVE_INVALID_INPUT" });
    }
    return [...values];
  };
  const archiveOverwrite = (overwrite: unknown): boolean => {
    if (overwrite !== undefined && typeof overwrite !== "boolean") throw Object.assign(new Error("overwrite must be a boolean"), { code: "ARCHIVE_INVALID_INPUT" });
    return overwrite === true;
  };

  ipcMain.handle("profile:export-archive", async (_event, opts: { dirId: string; destPath?: string; overwrite?: boolean }) => {
    try {
      validateDirId(opts?.dirId);
      let overwrite = archiveOverwrite(opts?.overwrite);
      let destPath = opts?.destPath;
      if (!destPath) {
        const r = await dialog.showSaveDialog({
          title: tMain("archive.export.title", "Export Profile Backup"),
          defaultPath: "profile-backup.zip",
          filters: [{ name: tMain("archive.filter.backup", "Profile backup"), extensions: ["zip"] }],
          properties: ["showOverwriteConfirmation"],
        });
        if (r.canceled || !r.filePath) return archiveCancelled();
        destPath = assertSafeArchiveExportPath(r.filePath);
        // Accepted native Save, with native overwrite confirmation enabled, is
        // consent for this specific file. An explicit false still refuses it.
        overwrite = overwrite || (opts?.overwrite === undefined && fs.existsSync(destPath));
      } else destPath = assertSafeArchiveExportPath(destPath);
      const result = await exportProfileArchive(opts.dirId, destPath, { overwrite });
      return { success: true, outcome: "completed" as const, ...result };
    } catch (error) { return archiveOperationFailure(error); }
  });

  ipcMain.handle("profile:import-archive", async (_event, opts?: { zipPath?: string }) => {
    try {
      let zipPath = opts?.zipPath;
      if (!zipPath) {
        const r = await dialog.showOpenDialog({
          title: tMain("archive.import.title", "Import Profile Backup"),
          properties: ["openFile"],
          filters: [{ name: tMain("archive.filter.backup", "Profile backup"), extensions: ["zip"] }],
        });
        if (r.canceled || !r.filePaths?.[0]) return archiveCancelled();
        zipPath = r.filePaths[0];
      }
      const result = importProfileArchive(assertSafeArchiveImportPath(zipPath));
      return { success: true, outcome: "completed" as const, ...result };
    } catch (error) { return archiveOperationFailure(error); }
  });

  // ── Batch profile backup (export selected profiles / import many zips) ──
  ipcMain.handle("profile:export-archives", async (_event, opts: { dirIds?: string[]; destDir?: string; overwrite?: boolean }) => {
    try {
      const dirIds = archiveArray(opts?.dirIds, "dirIds");
      const overwrite = archiveOverwrite(opts?.overwrite);
      let confirmedOverwritePaths: string[] | undefined;
      let destDir = opts?.destDir;
      if (!destDir) {
        const r = await dialog.showOpenDialog({
          title: tMain("archive.export.batch-title", "Export Profile Backups"),
          properties: ["openDirectory", "createDirectory"],
        });
        if (r.canceled || !r.filePaths?.[0]) return archiveCancelled();
        destDir = assertSafeArchiveExportDir(r.filePaths[0]);
        if (opts?.overwrite === undefined) {
          const conflicts = getProfileArchiveExportConflicts(dirIds, destDir);
          if (conflicts.length) {
            const confirmation = await dialog.showMessageBox({
              type: "warning", title: tMain("archive.replace.title", "Replace existing backups?"),
              message: tMain("archive.replace.message", "Replace {n} existing backup file(s)?").replace("{n}", String(conflicts.length)),
              detail: tMain("archive.replace.detail", "Only these existing backup files are approved for replacement:\n{files}").replace("{files}", conflicts.join("\n")),
              buttons: [tMain("archive.cancel", "Cancel"), tMain("archive.replace.confirm", "Replace backups")],
              defaultId: 0, cancelId: 0, noLink: true,
            });
            if (confirmation.response !== 1) return archiveCancelled();
            confirmedOverwritePaths = conflicts;
          }
        }
      } else destDir = assertSafeArchiveExportDir(destDir);
      const report = await exportProfileArchives(dirIds, destDir, { overwrite, ...(confirmedOverwritePaths ? { confirmedOverwritePaths } : {}) });
      return { ...classifyArchiveBatchReport(report), report };
    } catch (error) { return archiveOperationFailure(error); }
  });

  ipcMain.handle("profile:import-archives", async (_event, opts?: { zipPaths?: string[] }) => {
    try {
      let zipPaths: string[];
      if (opts?.zipPaths === undefined) {
        const r = await dialog.showOpenDialog({
          title: tMain("archive.import.batch-title", "Import Profile Backups"),
          properties: ["openFile", "multiSelections"],
          filters: [{ name: tMain("archive.filter.backup", "Profile backup"), extensions: ["zip"] }],
        });
        if (r.canceled || !r.filePaths?.length) return archiveCancelled();
        zipPaths = archiveArray(r.filePaths, "zipPaths");
      } else zipPaths = archiveArray(opts.zipPaths, "zipPaths");
      const report = importProfileArchives(zipPaths.map((file) => assertSafeArchiveImportPath(file)));
      return { ...classifyArchiveBatchReport(report), report };
    } catch (error) { return archiveOperationFailure(error); }
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
