// Profile backup / transfer (RoxyBrowser-style). Exports a managed profile
// (its Chromium data dir + fingerprint/proxy meta) into a portable ZIP archive
// and re-imports it under a fresh dirId on this or another machine. Cache and
// lock files are excluded so archives stay lean and consistent. Running
// profiles are refused for export (browser data may be mid-write).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProfilesDir, getConfig, saveConfig, getProfileMeta } from "./config-manager.js";
import { statusBrowser } from "./browser-manager.js";
import { validateDirId } from "./utils.js";
import { PROFILE_ID_PREFIX } from "../branding.js";
import { writeZipArchive, extractZipArchive, type ZipFileEntry, type ZipDirEntry } from "./zip-writer.js";

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

/** Strip sync/team fields so an imported profile starts as a local profile. */
function sanitizeImportedMeta(raw: any): Record<string, unknown> {
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const isStr = (v: unknown): v is string => typeof v === "string";
  const isInt = (v: unknown): v is number => Number.isInteger(v);
  const str = (v: unknown, max: number, fallback: string | null): string | null => (isStr(v) ? v.slice(0, max) : fallback);
  const mode = (v: unknown, allowed: string[], fallback: string): string =>
    isStr(v) && allowed.includes(v) ? v : fallback;
  return {
    name: str(raw?.name, 120, "Imported profile") || "Imported profile",
    fingerprintMode: mode(raw?.fingerprintMode, ["off", "managed"], "managed"),
    browserVersion: str(raw?.browserVersion, 80, null),
    allowThirdPartyCookies: raw?.allowThirdPartyCookies === true,
    fingerprintSeed: isInt(raw?.fingerprintSeed) ? raw.fingerprintSeed : Math.floor(Math.random() * 90000) + 10000,
    platform: mode(raw?.platform, ["windows", "macos"], "windows"),
    timezone: str(raw?.timezone, 64, null),
    locale: str(raw?.locale, 32, null),
    webrtcMode: mode(raw?.webrtcMode, ["auto", "altered", "disable", "real"], "auto"),
    webrtcIp: str(raw?.webrtcIp, 64, null),
    geolocationMode: mode(raw?.geolocationMode, ["real", "disable", "custom"], "real"),
    geolocationLatitude: isNum(raw?.geolocationLatitude) ? raw.geolocationLatitude : null,
    geolocationLongitude: isNum(raw?.geolocationLongitude) ? raw.geolocationLongitude : null,
    geolocationAccuracy: isNum(raw?.geolocationAccuracy) ? raw.geolocationAccuracy : null,
    gpuVendor: str(raw?.gpuVendor, 128, null),
    gpuRenderer: str(raw?.gpuRenderer, 256, null),
    hardwareConcurrency: isInt(raw?.hardwareConcurrency) ? raw.hardwareConcurrency : null,
    deviceMemory: isInt(raw?.deviceMemory) ? raw.deviceMemory : null,
    screenWidth: isInt(raw?.screenWidth) ? raw.screenWidth : null,
    screenHeight: isInt(raw?.screenHeight) ? raw.screenHeight : null,
    storageQuota: isInt(raw?.storageQuota) ? raw.storageQuota : null,
    taskbarHeight: isInt(raw?.taskbarHeight) ? raw.taskbarHeight : null,
    fontsDir: str(raw?.fontsDir, 500, null),
    proxyMode: mode(raw?.proxyMode, ["none", "default", "named"], "default"),
    proxyName: str(raw?.proxyName, 120, null),
    note: str(raw?.note, 2000, null),
    tags: Array.isArray(raw?.tags) ? raw.tags.filter(isStr).slice(0, 20) : [],
    fingerprintBaseline: raw?.fingerprintBaseline && typeof raw.fingerprintBaseline === "object" ? raw.fingerprintBaseline : undefined,
    updatedAt: Date.now(),
  };
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
    profile: meta,
  };
  const dataEntries = collectProfileEntries(profileDir);
  const result = await writeZipArchive(destPath, [
    { name: META_FILE, data: Buffer.from(JSON.stringify(metaDoc, null, 2), "utf8") },
    ...dataEntries,
  ]);
  return { dirId, filePath: destPath, entries: result.entries, bytes: result.bytes };
}

export function importProfileArchive(zipPath: string): ImportProfileResult {
  if (!fs.existsSync(zipPath)) throw new Error("Archive file not found");
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
    const importedMeta = sanitizeImportedMeta(metaDoc.profile);

    const dirId = newDirId();
    const profileDir = path.join(getProfilesDir(), dirId);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    // Move extracted entries (everything except meta.json) into the profile dir.
    for (const child of fs.readdirSync(tmpDir)) {
      if (child === META_FILE) continue;
      fs.renameSync(path.join(tmpDir, child), path.join(profileDir, child));
    }

    const cfg = getConfig();
    cfg.browserProfiles = cfg.browserProfiles || {};
    cfg.browserProfiles[dirId] = { ...importedMeta, name: uniqueName(String(importedMeta.name)) } as any;
    saveConfig(cfg);
    return { dirId, name: cfg.browserProfiles[dirId].name as string, files: extracted.files, bytes: extracted.bytes };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
