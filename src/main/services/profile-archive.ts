// Profile backup / transfer (RoxyBrowser-style). Exports a managed profile
// (its Chromium data dir + fingerprint/proxy meta) into a portable ZIP archive
// and re-imports it under a fresh dirId on this or another machine. Cache and
// lock files are excluded so archives stay lean and consistent. Running
// profiles are refused for export (browser data may be mid-write).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProfilesDir, getConfig, getProfileMeta, normalizePortableProfileMeta } from "./config-manager.js";
import type { BrowserProfileMeta } from "../types.js";
import { transact } from "./config/store.js";
import { requireProfileMutation } from "./team.js";
import { hasInstalledRepositoryExtension } from "./extension-repository.js";
import { statusBrowser } from "./browser-manager.js";
import { validateDirId } from "./utils.js";
import { PROFILE_ID_PREFIX } from "../branding.js";
import { writeZipArchive, extractZipArchive, type ZipFileEntry, type ZipDirEntry } from "./zip-writer.js";
import { assertSafeArchiveExportDir, assertSafeArchiveExportPath, assertSafeArchiveImportPath } from "./archive-path-guard.js";

export const PROFILE_ARCHIVE_FORMAT = 1;
const META_FILE = "meta.json";
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Directory names that are pure cache and always excluded from backups. */
const SKIP_DIR_NAMES = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "GraphiteDawnCache",
  "ShaderCache", "GrShaderCache", "DawnCache", "blob_storage", "CacheStorage",
  "Shared Dictionary",
]);
/** Top-level lock/pid files that must never be archived. */
const SKIP_FILE_NAMES = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile", "LOCK", "lock"]);

export interface ExportProfileResult {
  dirId: string;
  filePath: string;
  entries: number;
  bytes: number;
}

export interface ImportProfileResult {
  dirId: string;
  name: string;
  files: number;
  bytes: number;
  /** Local dependencies referenced by the backup, never bundled with it. */
  warnings: string[];
}

export interface BatchExportItem {
  dirId: string;
  filePath: string;
  entries: number;
  bytes: number;
}

export interface BatchExportReport {
  exported: BatchExportItem[];
  skipped: Array<{ dirId: string; reason: string }>;
  failed: Array<{ dirId: string; error: string }>;
}

export interface BatchImportItem {
  zipPath: string;
  dirId: string;
  name: string;
  files: number;
  bytes: number;
  warnings: string[];
}

export interface BatchImportReport {
  imported: BatchImportItem[];
  failed: Array<{ zipPath: string; error: string }>;
}

function newDirId(): string {
  return PROFILE_ID_PREFIX + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);
}

function collectProfileEntries(profileDir: string): Array<ZipFileEntry | ZipDirEntry> {
  const entries: Array<ZipFileEntry | ZipDirEntry> = [];
  const walk = (baseRel: string): void => {
    const absDir = baseRel ? path.join(profileDir, baseRel) : profileDir;
    for (const dirent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = baseRel ? baseRel + "/" + dirent.name : dirent.name;
      const absPath = path.join(absDir, dirent.name);
      if (dirent.isSymbolicLink()) continue; // never follow links out of the profile
      if (dirent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(dirent.name)) continue;
        entries.push({ name: rel + "/", isDirectory: true });
        walk(rel);
      } else if (dirent.isFile()) {
        if (SKIP_FILE_NAMES.has(dirent.name)) continue;
        entries.push({ name: rel, filePath: absPath });
      }
    }
  };
  walk("");
  return entries;
}

// Version 1 remains compatible: new properties are optional, and this single
// allowlist is used on both sides. Never export device paths (fontsDir), sync
// markers, team locks, credentials, or extension repository/package paths.
const PORTABLE_PROFILE_FIELDS = [
  "name", "fingerprintMode", "engine", "browserVersion", "allowThirdPartyCookies",
  "fingerprintSeed", "platform", "timezone", "locale", "webrtcMode", "webrtcIp",
  "geolocationMode", "geolocationLatitude", "geolocationLongitude", "geolocationAccuracy",
  "gpuVendor", "gpuRenderer", "hardwareConcurrency", "deviceMemory", "screenWidth",
  "screenHeight", "storageQuota", "taskbarHeight", "renderScaleMode", "windowTitlePrefix",
  "appUrl", "drm", "proxyMode", "proxyName", "note", "tags", "preset",
  "extensions", "fingerprintBaseline",
] as const satisfies readonly (keyof BrowserProfileMeta)[];

function portableProfile(raw: BrowserProfileMeta): Partial<BrowserProfileMeta> {
  const result: Record<string, unknown> = {};
  for (const field of PORTABLE_PROFILE_FIELDS) {
    if (raw[field] !== undefined) result[field] = raw[field];
  }
  return result as Partial<BrowserProfileMeta>;
}

function importWarnings(profile: BrowserProfileMeta, hadLocalFontsDir: boolean): string[] {
  const warnings: string[] = [];
  if (hadLocalFontsDir) {
    warnings.push("Custom fonts directory is device-local and not included in this backup; configure a local fonts directory before launching.");
  }
  if (profile.proxyMode === "named" && profile.proxyName) {
    warnings.push(`Named proxy ${profile.proxyName} is not included in this backup; configure its settings and credentials before launching.`);
  }
  for (const [id, enabled] of Object.entries(profile.extensions || {})) {
    if (enabled && !hasInstalledRepositoryExtension(id)) {
      warnings.push(`Extension ${id} package is not included in this backup; install it in the private repository before launching.`);
    }
  }
  return warnings;
}

function uniqueName(baseName: string): string {
  const cfg = getConfig() as any;
  const names = new Set(Object.values(cfg.browserProfiles || {}).map((p: any) => String(p?.name || "")));
  if (!names.has(baseName)) return baseName;
  let n = 2;
  while (names.has(baseName + " (" + n + ")")) n++;
  return baseName + " (" + n + ")";
}

export async function exportProfileArchive(dirId: string, destPath: string): Promise<ExportProfileResult> {
  validateDirId(dirId);
  destPath = assertSafeArchiveExportPath(destPath);
  const meta = getProfileMeta(dirId);
  if (!meta) throw new Error("Profile not found");
  if (statusBrowser(dirId).running) {
    throw new Error("Stop the profile before exporting (browser data may be mid-write)");
  }
  const profileDir = path.join(getProfilesDir(), dirId);
  if (!fs.existsSync(profileDir)) throw new Error("Profile data directory missing");

  const metaDoc = {
    formatVersion: PROFILE_ARCHIVE_FORMAT,
    exportedAt: Date.now(),
    sourceDirId: dirId,
    // Boolean only: never leak the source machine's absolute fonts path.
    omitted: { fontsDir: Boolean(meta.fontsDir) },
    profile: portableProfile(meta),
  };
  const dataEntries = collectProfileEntries(profileDir);
  const result = await writeZipArchive(destPath, [
    { name: META_FILE, data: Buffer.from(JSON.stringify(metaDoc, null, 2), "utf8") },
    ...dataEntries,
  ]);
  return { dirId, filePath: destPath, entries: result.entries, bytes: result.bytes };
}

export function importProfileArchive(zipPath: string): ImportProfileResult {
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  zipPath = assertSafeArchiveImportPath(zipPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abs-profile-import-"));
  try {
    const extracted = extractZipArchive(zipPath, tmpDir, { maxTotalBytes: MAX_IMPORT_BYTES });
    const metaPath = path.join(tmpDir, META_FILE);
    if (!fs.existsSync(metaPath)) throw new Error("Archive is missing meta.json — not a profile backup");
    let metaDoc: any;
    try {
      metaDoc = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      throw new Error("Archive meta.json is corrupt");
    }
    if (metaDoc?.formatVersion !== PROFILE_ARCHIVE_FORMAT) {
      throw new Error("Unsupported archive format: " + JSON.stringify(metaDoc?.formatVersion));
    }
    const importedMeta = normalizePortableProfileMeta(metaDoc.profile);
    const hadLocalFontsDir = metaDoc.omitted?.fontsDir === true ||
      (typeof metaDoc.profile?.fontsDir === "string" && Boolean(metaDoc.profile.fontsDir.trim()));
    const warnings = importWarnings(importedMeta, hadLocalFontsDir);
    const dirId = newDirId();
    const profileDir = path.join(getProfilesDir(), dirId);
    const importedName = uniqueName(importedMeta.name);
    try {
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      // Move extracted entries (everything except meta.json) into the profile dir.
      for (const child of fs.readdirSync(tmpDir)) {
        if (child === META_FILE) continue;
        fs.renameSync(path.join(tmpDir, child), path.join(profileDir, child));
      }
      transact((draft) => {
        draft.browserProfiles = draft.browserProfiles || {};
        draft.browserProfiles[dirId] = { ...importedMeta, name: importedName };
      });
    } catch (error) {
      // Only the newly allocated destination is ours to remove; a failed
      // config commit must not leave unlisted browser data behind.
      fs.rmSync(profileDir, { recursive: true, force: true });
      throw error;
    }
    const stored = getProfileMeta(dirId);
    if (!stored) throw new Error("Imported profile was not saved");
    return { dirId, name: stored.name, files: extracted.files, bytes: extracted.bytes, warnings };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Export several profiles into one destination directory. Running profiles are
 * skipped (their browser data may be mid-write); missing/errored profiles are
 * reported per item so a single bad profile never aborts the whole batch.
 */
export async function exportProfileArchives(dirIds: string[], destDir: string): Promise<BatchExportReport> {
  destDir = assertSafeArchiveExportDir(destDir);
  fs.mkdirSync(destDir, { recursive: true });
  const report: BatchExportReport = { exported: [], skipped: [], failed: [] };
  for (const dirId of dirIds) {
    try {
      validateDirId(dirId);
      const meta = getProfileMeta(dirId);
      if (!meta) {
        report.failed.push({ dirId, error: "Profile not found" });
        continue;
      }
      if (statusBrowser(dirId).running) {
        report.skipped.push({ dirId, reason: "running" });
        continue;
      }
      const safeName = String(meta.name || dirId).replace(/[^A-Za-z0-9._-]/g, "_").trim() || dirId;
      const filePath = path.join(destDir, safeName + "-" + dirId + ".zip");
      const result = await exportProfileArchive(dirId, filePath);
      report.exported.push({ dirId, filePath: result.filePath, entries: result.entries, bytes: result.bytes });
    } catch (e: any) {
      report.failed.push({ dirId, error: e?.message || String(e) });
    }
  }
  return report;
}

/** Import several profile backup ZIPs, reporting per-archive success/failure. */
export function importProfileArchives(zipPaths: string[]): BatchImportReport {
  const report: BatchImportReport = { imported: [], failed: [] };
  for (const zipPath of zipPaths) {
    try {
      const r = importProfileArchive(zipPath);
      report.imported.push({ zipPath, dirId: r.dirId, name: r.name, files: r.files, bytes: r.bytes, warnings: r.warnings });
    } catch (e: any) {
      report.failed.push({ zipPath, error: e?.message || String(e) });
    }
  }
  return report;
}
