import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir, getProfilesDir } from "./config-manager.js";
import { validateDirId } from "./utils.js";

const heldLocks = new Map<string, { fd: number; token: string }>();

function getRestoreLockPath(dirId: string): string {
  validateDirId(dirId);
  return path.join(getAppDataDir(), "locks", `${dirId}.restore.lock`);
}

export function isRestoreLocked(dirId: string, options?: { reclaimStale?: boolean }): boolean {
  validateDirId(dirId);
  if (heldLocks.has(dirId)) return true;
  const lockPath = getRestoreLockPath(dirId);
  const snapshot = readRestoreLock(lockPath);
  if (snapshot?.stale) {
    if (options?.reclaimStale === false) return false;
    if (removeRestoreLockIfTokenMatches(lockPath, snapshot.token, true)) return false;
  }
  return snapshot !== null;
}

type RestoreLockSnapshot = { token: string; stale: boolean; stat?: fs.Stats };
function readRestoreLock(lockPath: string): RestoreLockSnapshot | null {
  try {
    const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (!stat) return null;
    // Unknown/malformed ownership is contention, never permission to reclaim.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) return { token: "", stale: false };
    const fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let parsed: { pid?: number; token?: string };
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) return { token: "", stale: false };
      const buffer = Buffer.alloc(4097);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const after = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (count !== stat.size || !after || after.dev !== stat.dev || after.ino !== stat.ino ||
          after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return { token: "", stale: false };
      parsed = JSON.parse(buffer.subarray(0, count).toString("utf8"));
    } finally { fs.closeSync(fd); }
    const token = typeof parsed?.token === "string" ? parsed.token : "";
    if (!token || token.length > 128 || !Number.isInteger(parsed?.pid) || parsed.pid! <= 0) return { token, stale: false, stat };
    try {
      process.kill(parsed.pid!, 0);
      return { token, stale: false, stat };
    } catch (error) {
      // Age, EPERM, discovery errors and malformed records are not proof of exit.
      return { token, stale: (error as NodeJS.ErrnoException)?.code === "ESRCH", stat };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return { token: "", stale: false };
  }
}

function removeRestoreLockIfTokenMatches(lockPath: string, token: string, requireDead = false): boolean {
  try {
    const current = readRestoreLock(lockPath);
    if (!current) return true;
    if (current.token !== token || requireDead && !current.stale || !current.stat) return false;
    const latest = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (!latest) return true;
    if (latest.dev !== current.stat.dev || latest.ino !== current.stat.ino || latest.size !== current.stat.size ||
        latest.mtimeMs !== current.stat.mtimeMs || latest.ctimeMs !== current.stat.ctimeMs || latest.isSymbolicLink()) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    console.error("[sync] failed to remove restore lock:", error);
    return false;
  }
}

export function acquireRestoreLock(dirId: string): () => void {
  validateDirId(dirId);
  if (heldLocks.has(dirId)) throw new Error(`Restore already in progress for ${dirId}`);
  const lockPath = getRestoreLockPath(dirId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(path.dirname(lockPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe restore lock directory");
  let fd: number | null = null;
  let created: fs.Stats | undefined;
  const token = randomUUID();
  try {
    fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    created = fs.fstatSync(fd);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, dirId, token, createdAt: new Date().toISOString() }));
    heldLocks.set(dirId, { fd, token });
  } catch (error: any) {
    if (fd !== null) fs.closeSync(fd);
    if (error?.code === "EEXIST") {
      const snapshot = readRestoreLock(lockPath);
      if (snapshot?.stale) removeRestoreLockIfTokenMatches(lockPath, snapshot.token, true);
      throw new Error(`Restore already in progress for ${dirId}`);
    }
    if (created) {
      try {
        const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        if (current && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(lockPath);
      } catch (unlinkError: any) { if (unlinkError?.code !== "ENOENT") console.error(`[sync] failed to remove partial restore lock for ${dirId}:`, unlinkError); }
    }
    throw error;
  }

  const ownedFd = fd!;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = heldLocks.get(dirId);
    if (!current || current.token !== token || current.fd !== ownedFd) return;
    heldLocks.delete(dirId);
    try { fs.closeSync(ownedFd); } catch (error) { console.error(`[sync] failed to close restore lock for ${dirId}:`, error); }
    removeRestoreLockIfTokenMatches(lockPath, token);
  };
}

export interface ProfileTransferStatus {
  running?: unknown;
  pid?: unknown;
  stopping?: unknown;
  state?: unknown;
  unknown?: unknown;
}

/**
 * Shared read-only runtime gate for archive/LocalStorage/History transfers.
 * Call while owning the restore lock and recheck after awaited preparation.
 * A stop request, missing PID evidence, discovery error or dangling lock marker
 * cannot certify exit. Browser lock markers are inspected, never deleted.
 * Configured Firefox may leave an inert empty regular .parentlock/parent.lock
 * after exit (including crash). Two strict rich stopped checks around pinned
 * unchanged empty files prove absence/inertness only, NOT graceful DB flush or
 * recovery cleanliness; callers must retain their schema/recovery validation.
 */
export function assertProfileTransferStopped(
  dirId: string,
  status: () => ProfileTransferStatus,
  hasRunningBrowser?: () => boolean,
  options?: { engine?: "chromium" | "firefox" },
): void {
  validateDirId(dirId);
  const blocked = (reason: string, cause?: unknown) => Object.assign(
    new Error("Stop the profile and wait for browser exit before transferring browser data (" + reason + ")", { cause }),
    { code: "PROFILE_STOP_REQUIRED", stopRequired: true, dirId },
  );
  try {
    const confirmStopped = () => {
      if (hasRunningBrowser && hasRunningBrowser() !== false) throw blocked("runtime still active or unconfirmed");
      const current = status();
      if (!current || current.running !== false || current.pid !== null ||
          current.stopping !== undefined && current.stopping !== false ||
          current.unknown !== undefined && current.unknown !== false ||
          current.state !== undefined && current.state !== "stopped") throw blocked("runtime is not confirmed stopped");
    };
    confirmStopped();
    const root = getProfilesDir();
    const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw blocked("unsafe profile root");
    const directory = path.join(root, dirId);
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw blocked("unsafe profile directory");
    const sentinels: Array<{ file: string; before: fs.Stats; fd: number }> = [];
    const sameSentinel = (before: fs.Stats, after: fs.Stats | undefined): boolean => Boolean(after && after.isFile() && !after.isSymbolicLink() &&
      after.size === 0 && after.nlink === 1 && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
      before.uid === after.uid && before.gid === after.gid && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
    try {
      for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "parent.lock", ".parentlock", "lock"]) {
        const file = path.join(directory, name), before = fs.lstatSync(file, { throwIfNoEntry: false });
        if (!before) continue;
        if (options?.engine !== "firefox" || name !== "parent.lock" && name !== ".parentlock" ||
            !before.isFile() || before.isSymbolicLink() || before.size !== 0 || before.nlink !== 1) throw blocked("browser lock marker present");
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        sentinels.push({ file, before, fd });
        const byte = Buffer.alloc(1);
        if (!sameSentinel(before, fs.fstatSync(fd)) || fs.readSync(fd, byte, 0, 1, 0) !== 0 ||
            !sameSentinel(before, fs.lstatSync(file, { throwIfNoEntry: false }))) throw blocked("Firefox sentinel changed during inspection");
      }
      if (sentinels.length) {
        // Production status uses strict rich profile ownership, not a CDP-port
        // lookup. A port-0/no-debug browser appearing here must still refuse.
        confirmStopped();
        const rootAfter = fs.lstatSync(root, { throwIfNoEntry: false }), directoryAfter = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!rootStat || !stat || !rootAfter?.isDirectory() || rootAfter.isSymbolicLink() || rootAfter.dev !== rootStat.dev || rootAfter.ino !== rootStat.ino ||
            !directoryAfter?.isDirectory() || directoryAfter.isSymbolicLink() || directoryAfter.dev !== stat.dev || directoryAfter.ino !== stat.ino) throw blocked("profile directory changed during sentinel confirmation");
        for (const sentinel of sentinels) {
          if (!sameSentinel(sentinel.before, fs.fstatSync(sentinel.fd)) ||
              !sameSentinel(sentinel.before, fs.lstatSync(sentinel.file, { throwIfNoEntry: false }))) throw blocked("Firefox sentinel changed during stopped confirmation");
        }
      }
    } finally {
      let closeError: unknown;
      for (const sentinel of sentinels) {
        try { fs.closeSync(sentinel.fd); } catch (error) { closeError ??= error; }
      }
      if (closeError) throw closeError;
    }
  } catch (error) {
    if ((error as { code?: string })?.code === "PROFILE_STOP_REQUIRED") throw error;
    throw blocked("runtime discovery or lock inspection failed", error);
  }
}
