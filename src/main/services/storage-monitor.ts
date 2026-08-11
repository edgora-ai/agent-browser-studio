import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { getProfileMeta, getProfilesDir } from "./config-manager.js";
import type { StorageInfo } from "../types.js";
import { getDirectorySizeAsync, getLatestModifiedAsync, validateDirId } from "./utils.js";

// Cache dirs that are safe to delete
const clearableDirs = [
  "GPUCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Code Cache",
  "Cache",
  "GraphiteDawnCache",
];

export const storageMonitor = {
  /**
   * Get storage info for all profiles.
   */
  async getInfo(): Promise<StorageInfo> {
    const profiles: StorageInfo["profiles"] = [];
    const profilesDir = getProfilesDir();

    if (fs.existsSync(profilesDir)) {
      const entries = await fsPromises.readdir(profilesDir, { withFileTypes: true });
      const tasks = entries.map(async entry => {
        if (!entry.isDirectory()) return;
        const dirId = entry.name;
        const profilePath = path.join(profilesDir, dirId);
        const meta = getProfileMeta(dirId);
        const [sizeBytes, lastModified] = await Promise.all([
          getDirectorySizeAsync(profilePath),
          getLatestModifiedAsync(profilePath),
        ]);
        profiles.push({
          dirId,
          name: meta?.name || dirId.substring(0, 8),
          browser: "chromium",
          sizeBytes,
          lastModified,
        });
      });
      await Promise.all(tasks);
    }

    profiles.sort((a, b) => b.sizeBytes - a.sizeBytes);

    const totalProfileBytes = profiles.reduce((sum, p) => sum + p.sizeBytes, 0);
    const [availableDiskBytes, totalDiskBytes] = await Promise.all([
      getAvailableDiskSpaceAsync(),
      getTotalDiskSpaceAsync(),
    ]);
    const diskUsagePercent = totalDiskBytes > 0
      ? Math.round(((totalDiskBytes - availableDiskBytes) / totalDiskBytes) * 100)
      : 0;

    return {
      profiles,
      totalProfileBytes,
      availableDiskBytes,
      diskUsagePercent,
    };
  },

  /**
   * Clear caches for a specific profile or all profiles.
   */
  async clearCache(dirId?: string): Promise<{ freed: number }> {
    let totalFreed = 0;

    if (dirId) {
      totalFreed = await clearProfileCacheAsync(dirId);
    } else {
      const baseDir = getProfilesDir();
      if (fs.existsSync(baseDir)) {
        const entries = await fsPromises.readdir(baseDir, { withFileTypes: true });
        const tasks = entries.map(async entry => {
          if (entry.isDirectory()) {
            const freed = await clearProfileCacheAsync(entry.name);
            totalFreed += freed;
          }
        });
        await Promise.all(tasks);
      }
    }

    return { freed: totalFreed };
  },

  /**
   * Get available disk space in bytes.
   */
  async getAvailableDiskSpace(): Promise<number> {
    return getAvailableDiskSpaceAsync();
  },
};

// ── Internal ──

async function clearProfileCacheAsync(dirId: string): Promise<number> {
  const profilePath = resolveProfileDir(dirId);
  if (!fs.existsSync(profilePath)) return 0;

  let freed = 0;
  for (const cacheDir of clearableDirs) {
    const targetPath = path.join(profilePath, cacheDir);
    if (fs.existsSync(targetPath)) {
      const size = await getDirectorySizeAsync(targetPath);
      try {
        await fsPromises.rm(targetPath, { recursive: true, force: true });
        freed += size;
      } catch {
        // ignore deletion errors
      }
    }
  }

  return freed;
}

function resolveProfileDir(dirId: string): string {
  validateDirId(dirId);
  const baseDir = path.resolve(getProfilesDir());
  const profilePath = path.resolve(baseDir, dirId);
  const relative = path.relative(baseDir, profilePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Profile path escapes profiles directory: ${JSON.stringify(dirId)}`);
  }
  return profilePath;
}

function getAvailableDiskSpaceAsync(): Promise<number> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32"
      ? "wmic logicaldisk get size,freespace,deviceid"
      : "df -k .";
    exec(cmd, { timeout: 2000 }, (error, stdout) => {
      if (error || !stdout) {
        resolve(1024 * 1024 * 1024 * 10); // 10 GB default
        return;
      }
      if (process.platform === "win32") {
        try {
          const lines = stdout.trim().split("\n");
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2 && !isNaN(parseInt(parts[0]))) {
              resolve(parseInt(parts[0]) * 1024); // freespace in KB
              return;
            }
          }
        } catch { /* fallback */ }
      } else {
        try {
          const lines = stdout.trim().split("\n");
          if (lines.length >= 2) {
            const parts = lines[1].trim().split(/\s+/);
            if (parts.length >= 4 && !isNaN(parseInt(parts[3]))) {
              resolve(parseInt(parts[3]) * 1024); // KB to bytes
              return;
            }
          }
        } catch { /* fallback */ }
      }
      resolve(1024 * 1024 * 1024 * 10);
    });
  });
}

function getTotalDiskSpaceAsync(): Promise<number> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32"
      ? "wmic logicaldisk get size,freespace,deviceid"
      : "df -k .";
    exec(cmd, { timeout: 2000 }, (error, stdout) => {
      if (error || !stdout) {
        resolve(1024 * 1024 * 1024 * 100); // 100 GB default
        return;
      }
      if (process.platform === "win32") {
        try {
          const lines = stdout.trim().split("\n");
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3 && !isNaN(parseInt(parts[2]))) {
              resolve(parseInt(parts[2]) * 1024); // size in KB
              return;
            }
          }
        } catch { /* fallback */ }
      } else {
        try {
          const lines = stdout.trim().split("\n");
          if (lines.length >= 2) {
            const parts = lines[1].trim().split(/\s+/);
            if (parts.length >= 2 && !isNaN(parseInt(parts[1]))) {
              resolve(parseInt(parts[1]) * 1024); // KB to bytes
              return;
            }
          }
        } catch { /* fallback */ }
      }
      resolve(1024 * 1024 * 1024 * 100);
    });
  });
}
