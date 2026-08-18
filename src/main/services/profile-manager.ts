import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { exec, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getProfilesDir,
  resolveProfileProxy,
  getProfileMeta,
  removeProfileMeta,
} from "./config-manager.js";
import { runtimeCookieOps } from "./bidi-cookie-service.js";
import { getProfileEngineByDirId } from "./page-eval.js";
import { validateDirId, getDirectorySizeAsync } from "./utils.js";
import type { ProfileInfo, CookieInfo } from "../types.js";
import { PROFILE_DIR_NAME } from "../branding.js";

interface RunningProcess {
  pid: number;
  args: string;
}

function getRunningProcesses(): Promise<RunningProcess[]> {
  return new Promise((resolve) => {
    exec("ps -eo pid,args", { timeout: 2000 }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      const processes: RunningProcess[] = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const firstSpace = trimmed.indexOf(" ");
        if (firstSpace === -1) continue;
        const pidStr = trimmed.substring(0, firstSpace);
        const argsStr = trimmed.substring(firstSpace + 1);
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid)) {
          processes.push({ pid, args: argsStr });
        }
      }
      resolve(processes);
    });
  });
}

export async function listProfiles(): Promise<ProfileInfo[]> {
  const profiles: ProfileInfo[] = [];
  const runningProcesses = await getRunningProcesses();

  const profilesDir = getProfilesDir();
  const profileTasks: Promise<void>[] = [];
  if (fs.existsSync(profilesDir)) {
    const dirs = await fsPromises.readdir(profilesDir, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory()) {
        profileTasks.push((async () => {
          try {
            const info = await getProfileInfo(d.name, runningProcesses);
            profiles.push(info);
          } catch { /* ignore corrupted */ }
        })());
      }
    }
  }

  await Promise.all(profileTasks);
  return profiles.sort((a, b) => b.lastModified - a.lastModified);
}

export async function getProfileInfo(dirId: string, preloadedProcesses?: RunningProcess[]): Promise<ProfileInfo> {
  validateDirId(dirId);
  const profilePath = path.join(getProfilesDir(), dirId);
  const meta = getProfileMeta(dirId);

  let sizeBytes = 0;
  if (fs.existsSync(profilePath)) {
    sizeBytes = await getDirectorySizeAsync(profilePath);
  }

  let running = false;
  let pid: number | null = null;
  const targetPath = profilePath;

  const checkRunning = (procList: RunningProcess[]) => {
    for (const proc of procList) {
      if (proc.args.includes("Chromium") && proc.args.includes(targetPath)) {
        pid = proc.pid;
        running = true;
        break;
      }
    }
  };

  if (preloadedProcesses) {
    checkRunning(preloadedProcesses);
  } else {
    checkRunning(await getRunningProcesses());
  }

  let lastModified = 0;
  try {
    if (fs.existsSync(profilePath)) {
      const stat = await fsPromises.stat(profilePath);
      lastModified = Math.floor(stat.mtimeMs);
    }
  } catch { /* ignore */ }

  const syncedAt = meta?.syncedAt ?? null;
  let syncStatus: "synced" | "dirty" | "never" = "never";
  if (syncedAt) {
    const syncedHash = (meta as any)?.syncedHash;
    if (syncedHash) syncStatus = hashProfileMeta(meta) === syncedHash ? "synced" : "dirty";
    else syncStatus = lastModified > syncedAt ? "dirty" : "synced";
  }

  const resolvedProxy = resolveProfileProxy(dirId);

  return {
    dirId,
    name: meta?.name ?? dirId.substring(0, 8),
    path: profilePath,
    sizeBytes,
    lastModified,
    running,
    pid,
    proxyMode: resolvedProxy.mode,
    proxyName: resolvedProxy.name,
    proxy: resolvedProxy.config,
    syncedAt,
    syncStatus,
    tags: meta?.tags ?? [],
    fingerprint: {
      fingerprintSeed: meta?.fingerprintSeed ?? 12345,
      platform: meta?.platform ?? "windows",
      timezone: meta?.timezone ?? null,
      locale: meta?.locale ?? null,
      webrtcMode: meta?.webrtcMode ?? (meta?.webrtcIp ? "altered" : "auto"),
      webrtcIp: meta?.webrtcIp ?? null,
      geolocationMode: meta?.geolocationMode ?? "real",
      geolocationLatitude: meta?.geolocationLatitude ?? null,
      geolocationLongitude: meta?.geolocationLongitude ?? null,
      geolocationAccuracy: meta?.geolocationAccuracy ?? null,
    },
  };
}

export async function deleteProfile(dirId: string): Promise<boolean> {
  validateDirId(dirId);
  const profilePath = path.join(getProfilesDir(), dirId);
  if (!fs.existsSync(profilePath)) return false;

  try {
    const targetPath = profilePath;
    const processes = await getRunningProcesses();
    const isRunning = processes.some(proc => proc.args.includes("Chromium") && proc.args.includes(targetPath));
    if (isRunning) {
      throw new Error("Cannot delete profile while browser is running");
    }
  } catch (e: any) {
    if (e.message.includes("Cannot delete")) throw e;
  }

  await fsPromises.rm(profilePath, { recursive: true, force: true });
  removeProfileMeta(dirId);
  return true;
}

export async function listCookies(dirId: string, filter?: string): Promise<CookieInfo[]> {
  validateDirId(dirId);
  if (filter !== undefined) validateCookieText("filter", filter, 200, true);

  if (runtimeCookieOps.hasRunningBrowser(dirId)) {
    const normalizedFilter = filter?.toLowerCase();
    const cookies = await runtimeCookieOps.exportCookies(dirId);
    const filtered = normalizedFilter
      ? cookies.filter((c) => c.domain.toLowerCase().includes(normalizedFilter) || c.name.toLowerCase().includes(normalizedFilter))
      : cookies;
    return filtered.sort((a, b) => a.domain.localeCompare(b.domain)).slice(0, 200);
  }

  // A running Firefox profile has no Chromium-style sqlite file; when the
  // runtime export is unavailable we simply report none rather than reading
  // another engine's on-disk format.
  if (getProfileEngineByDirId(dirId) === "firefox") return [];

  return listCookiesFromSqlite(dirId, filter);
}

export async function setCookie(dirId: string, cookie: { domain: string; name: string; value: string }): Promise<boolean> {
  validateDirId(dirId);
  validateCookieDomain(cookie.domain);
  validateCookieName(cookie.name);
  validateCookieText("value", cookie.value, 4096, true);

  if (!runtimeCookieOps.hasRunningBrowser(dirId)) {
    throw new Error("Launch this profile before adding cookies. Stopped profiles are read-only to avoid corrupting the browser cookie store.");
  }

  return runtimeCookieOps.setCookie(dirId, {
    domain: cookie.domain,
    name: cookie.name,
    value: cookie.value,
    path: "/",
    expires: Math.floor(Date.now() / 1000) + 86400 * 365,
    secure: false,
    httpOnly: false,
    sameSite: 1,
  });
}

export async function deleteCookie(dirId: string, domain: string, name: string): Promise<boolean> {
  validateDirId(dirId);
  validateCookieDomain(domain);
  validateCookieName(name);

  if (!runtimeCookieOps.hasRunningBrowser(dirId)) {
    throw new Error("Launch this profile before deleting cookies. Stopped profiles are read-only to avoid corrupting the browser cookie store.");
  }

  return runtimeCookieOps.deleteCookie(dirId, domain, name);
}

function listCookiesFromSqlite(dirId: string, filter?: string): CookieInfo[] {
  const cookieDb = resolveProfileFilePath(dirId, path.join("Default", "Cookies"));
  if (!fs.existsSync(cookieDb)) return [];

  const filterSql = filter
    ? "WHERE host_key LIKE '%' || :filter || '%' ESCAPE '~' OR name LIKE '%' || :filter || '%' ESCAPE '~'"
    : "";
  const sql = `SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies ${filterSql} ORDER BY host_key LIMIT 200`;

  try {
    const output = runSqlite(cookieDb, sql, filter ? { filter: escapeSqlLike(filter) } : undefined, ["-json"]).trim();
    if (!output) return [];

    const rows = JSON.parse(output) as Array<{
      host_key: string; name: string; value: string; path: string;
      expires_utc: number; is_secure: number; is_httponly: number; samesite: number;
    }>;

    return rows.map(r => ({
      domain: r.host_key,
      name: r.name,
      value: r.value,
      path: r.path,
      expires: chromeFiletimeToUnixSeconds(r.expires_utc),
      secure: r.is_secure === 1,
      httpOnly: r.is_httponly === 1,
      sameSite: r.samesite ?? -1,
    }));
  } catch (e: any) {
    console.error("listCookies sqlite error:", e.message);
    throw e;
  }
}

export function getProfileSubdir(dirId: string): string {
  validateDirId(dirId);
  return PROFILE_DIR_NAME;
}

function hashProfileMeta(meta: any): string {
  const clean = JSON.parse(JSON.stringify(meta || {}));
  delete clean.syncedAt;
  delete clean.syncedHash;
  return createHash("sha256").update(JSON.stringify(sortKeys(clean))).digest("hex");
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

function resolveProfilePath(dirId: string): string {
  validateDirId(dirId);
  const baseDir = path.resolve(getProfilesDir());
  const profilePath = path.resolve(baseDir, dirId);
  if (!isPathInside(profilePath, baseDir)) {
    throw new Error(`Profile path escapes profiles directory: ${JSON.stringify(dirId)}`);
  }
  return profilePath;
}

function resolveProfileFilePath(dirId: string, relativePath: string): string {
  const profilePath = resolveProfilePath(dirId);
  const filePath = path.resolve(profilePath, relativePath);
  if (!isPathInside(filePath, profilePath)) {
    throw new Error(`Profile file path escapes profile: ${JSON.stringify(relativePath)}`);
  }
  return filePath;
}

function isPathInside(childPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function runSqlite(dbPath: string, sql: string, params?: Record<string, string | number>, extraArgs: string[] = []): string {
  const args: string[] = [...extraArgs];
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid sqlite parameter: ${key}`);
      args.push(`-cmd`, `.parameter set :${key} ${JSON.stringify(value)}`);
    }
  }
  args.push(dbPath, sql);
  return execFileSync("sqlite3", args, { encoding: "utf-8", timeout: 5000 });
}

function escapeSqlLike(value: string): string {
  return value.replace(/~/g, "~~").replace(/%/g, "~%").replace(/_/g, "~_");
}

function chromeFiletimeToUnixSeconds(expiresUtc: number): number | null {
  if (!expiresUtc) return null;
  const unixSeconds = Math.floor(expiresUtc / 1000000) - 11644473600;
  return unixSeconds > 0 ? unixSeconds : null;
}

function validateCookieDomain(domain: string): void {
  validateCookieText("domain", domain, 255);
  if (!/^\.?[A-Za-z0-9*_-]+(?:\.[A-Za-z0-9*_-]+)*$/.test(domain)) {
    throw new Error(`Invalid cookie domain: ${JSON.stringify(domain)}`);
  }
}

function validateCookieName(name: string): void {
  validateCookieText("name", name, 255);
  if (/[\x00-\x1f\x7f;=\s]/.test(name)) {
    throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`);
  }
}

function validateCookieText(field: string, value: string, maxLength: number, allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxLength || /\x00/.test(value)) {
    throw new Error(`Invalid cookie ${field}`);
  }
}
