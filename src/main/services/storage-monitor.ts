import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
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
    const { availableDiskBytes, totalDiskBytes } = await getDiskSpaceAsync(profilesDir);
    const diskUsagePercent = Math.round(((totalDiskBytes - availableDiskBytes) / totalDiskBytes) * 100);

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
    return (await getDiskSpaceAsync(getProfilesDir())).availableDiskBytes;
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

function storageDirectoryIdentity(stats: fs.BigIntStats): { dev: bigint; ino: bigint; type: bigint } {
  if (typeof stats?.dev !== "bigint" || typeof stats?.ino !== "bigint" || typeof stats?.mode !== "bigint") {
    throw new Error("Invalid configured storage directory identity metadata");
  }
  const type = stats.mode & BigInt(fs.constants.S_IFMT);
  if (type !== BigInt(fs.constants.S_IFDIR)) {
    throw new Error("Configured storage path is not a directory");
  }
  return { dev: stats.dev, ino: stats.ino, type };
}

// A current-path capacity observation, not historical mount identity or write
// authority. Bracketing dev/ino/type checks detect ordinary path replacement;
// they are not atomic and do not prove a historical mount UUID.
async function getDiskSpaceAsync(profilesDir: string): Promise<{ availableDiskBytes: number; totalDiskBytes: number }> {
  // Missing/dangling profiles are unavailable. Never create the directory or
  // query app-data, an ancestor, cwd, or another root as a fallback filesystem.
  const before = storageDirectoryIdentity(await fsPromises.stat(profilesDir, { bigint: true }));
  const stats = await fsPromises.statfs(profilesDir, { bigint: true });
  const after = storageDirectoryIdentity(await fsPromises.stat(profilesDir, { bigint: true }));
  if (before.dev !== after.dev || before.ino !== after.ino || before.type !== after.type) {
    throw new Error("Configured storage directory changed during filesystem capacity query");
  }
  if (typeof stats?.bsize !== "bigint" || typeof stats?.blocks !== "bigint"
    || typeof stats?.bfree !== "bigint" || typeof stats?.bavail !== "bigint"
    || stats.bsize <= 0n || stats.blocks <= 0n || stats.bfree < 0n || stats.bavail < 0n
    || stats.bfree > stats.blocks || stats.bavail > stats.bfree) {
    throw new Error("Invalid filesystem capacity metadata for configured storage");
  }

  // bavail excludes reserved blocks; statfs counts blocks, not KB or WMIC bytes.
  const availableDiskBytes = stats.bavail * stats.bsize;
  const totalDiskBytes = stats.blocks * stats.bsize;
  const maxSafeBytes = BigInt(Number.MAX_SAFE_INTEGER);
  if (availableDiskBytes > maxSafeBytes || totalDiskBytes > maxSafeBytes) {
    throw new RangeError("Filesystem capacity exceeds the safe integer byte range");
  }
  return { availableDiskBytes: Number(availableDiskBytes), totalDiskBytes: Number(totalDiskBytes) };
}
