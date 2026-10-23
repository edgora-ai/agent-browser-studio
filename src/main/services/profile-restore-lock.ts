import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir, getProfilesDir } from "./config-manager.js";
import { validateDirId } from "./utils.js";

const heldLocks = new Map<string, { fd: number; token: string }>();

export interface FullProfileRecoveryTicket {
  readonly dirId: string;
  readonly operationId: string;
  readonly receiptPath: string;
  readonly profileDir: string;
  readonly backupDir: string;
  readonly stagingDir: string;
}
interface RecoveryDirectoryOwner { directory: string; stat: fs.Stats; }
interface RecoveryTicketRecord {
  ticket: FullProfileRecoveryTicket;
  lease: { fd: number; token: string; stat: fs.Stats };
  directories: RecoveryDirectoryOwner[];
  receiptOwner: fs.Stats;
  bytes: Buffer;
  finished: boolean;
}
const recoveryTickets = new WeakMap<FullProfileRecoveryTicket, RecoveryTicketRecord>();
const RECOVERY_RECEIPT_LIMIT = 16 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function recoveryLocation(dirId: string) {
  validateDirId(dirId);
  const appDirectory = path.resolve(getAppDataDir());
  const lockDirectory = path.join(appDirectory, "locks");
  const profilesDirectory = path.resolve(getProfilesDir());
  return { appDirectory, lockDirectory, profilesDirectory, profileDir: path.join(profilesDirectory, dirId),
    receiptPath: path.join(lockDirectory, `${dirId}.full-profile-recovery.json`) };
}
function fullProfileRecoveryError(dirId: string, receiptPath: string, recoveryPaths: string[] = [receiptPath]): Error {
  // Never append receipt bytes, JSON, supplied filesystem errors or credentials.
  return Object.assign(new Error("Full-profile recovery is required before launching or transferring this profile."), {
    code: "FULL_PROFILE_RECOVERY_REQUIRED", dirId, receiptPath, recoveryPaths,
  });
}
function recoveryIdentity(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function recoverySnapshot(a: fs.Stats, b: fs.Stats): boolean {
  return recoveryIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink &&
    a.uid === b.uid && a.gid === b.gid && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function recoveryDirectory(directory: string): RecoveryDirectoryOwner {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe recovery directory");
  return { directory, stat };
}
function assertRecoveryDirectories(directories: RecoveryDirectoryOwner[]): void {
  for (const owner of directories) {
    const current = fs.lstatSync(owner.directory);
    if (!current.isDirectory() || current.isSymbolicLink() || !recoveryIdentity(current, owner.stat)) throw new Error("Recovery directory ownership changed");
  }
}
function syncRecoveryDirectory(owner: RecoveryDirectoryOwner): void {
  const fd = fs.openSync(owner.directory, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    if (!current.isDirectory() || !recoveryIdentity(current, owner.stat)) throw new Error("Recovery directory ownership changed");
    // Unlike an optional export warning, an unconfirmed durable launch gate
    // cannot authorize the destructive operation. Unsupported fsync fails closed.
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Existence is sufficient: never parse an untrusted receipt, follow a link,
 * reclaim by PID/age, or interpret malformed recovery material as permission. */
export function assertNoFullProfileRecovery(dirId: string): void {
  const location = recoveryLocation(dirId);
  try {
    const app = fs.lstatSync(location.appDirectory, { throwIfNoEntry: false });
    if (!app) return;
    if (!app.isDirectory() || app.isSymbolicLink()) throw new Error("Unsafe recovery root");
    const parent = fs.lstatSync(location.lockDirectory, { throwIfNoEntry: false });
    if (!parent) return;
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe recovery parent");
    if (fs.lstatSync(location.receiptPath, { throwIfNoEntry: false })) throw new Error("Recovery receipt exists");
  } catch {
    throw fullProfileRecoveryError(dirId, location.receiptPath, [location.receiptPath, location.profileDir]);
  }
}
function assertRecoveryLease(dirId: string, expected?: RecoveryTicketRecord["lease"]): RecoveryTicketRecord["lease"] {
  const lease = heldLocks.get(dirId);
  if (!lease || expected && (lease.fd !== expected.fd || lease.token !== expected.token)) throw new Error("Recovery lease is not owned");
  const stat = fs.fstatSync(lease.fd), onDisk = readRestoreLock(getRestoreLockPath(dirId));
  if (!stat.isFile() || stat.nlink !== 1 || !onDisk?.stat || onDisk.token !== lease.token ||
      !recoverySnapshot(stat, onDisk.stat) || expected && !recoverySnapshot(stat, expected.stat)) throw new Error("Recovery lease ownership changed");
  return { fd: lease.fd, token: lease.token, stat };
}
function verifyRecoveryReceipt(file: string, owner: fs.Stats, expected: Buffer): void {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > RECOVERY_RECEIPT_LIMIT ||
      !recoverySnapshot(before, owner) || before.size !== expected.length) throw new Error("Recovery receipt ownership changed");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    if (!recoverySnapshot(fs.fstatSync(fd), before)) throw new Error("Recovery receipt changed during open");
    const actual = Buffer.alloc(expected.length + 1); let count = 0;
    while (count < actual.length) {
      const read = fs.readSync(fd, actual, count, actual.length - count, count);
      if (!Number.isInteger(read) || read < 0 || read > actual.length - count) throw new Error("Recovery receipt invalid read");
      if (read === 0) break;
      count += read;
    }
    if (count !== expected.length || !actual.subarray(0, count).equals(expected) ||
        !recoverySnapshot(fs.fstatSync(fd), before) || !recoverySnapshot(fs.lstatSync(file), before)) throw new Error("Recovery receipt byte identity changed");
  } finally { fs.closeSync(fd); }
}

/** Must run under the SAME lease that will cover apply, config CAS and cleanup.
 * A write/flush/readback failure leaves any created receipt in place. */
export function beginFullProfileRecovery(options: { dirId: string; operationId: string; stagingDir: string }): FullProfileRecoveryTicket {
  const location = recoveryLocation(options.dirId);
  const recoveryPaths = [location.receiptPath, location.profileDir];
  let fd: number | undefined;
  try {
    if (typeof options.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.operationId) ||
        typeof options.stagingDir !== "string" || !path.isAbsolute(options.stagingDir) ||
        options.stagingDir !== path.resolve(options.stagingDir) || Buffer.byteLength(options.stagingDir) > 4096) throw new Error("Invalid recovery operation");
    assertNoFullProfileRecovery(options.dirId);
    const directories = [recoveryDirectory(location.appDirectory), recoveryDirectory(location.lockDirectory), recoveryDirectory(location.profilesDirectory)];
    recoveryDirectory(options.stagingDir);
    const lease = assertRecoveryLease(options.dirId);
    const ticket: FullProfileRecoveryTicket = Object.freeze({ dirId: options.dirId, operationId: options.operationId,
      receiptPath: location.receiptPath, profileDir: location.profileDir,
      backupDir: location.profileDir + ".full-profile-backup-" + options.operationId, stagingDir: options.stagingDir });
    recoveryPaths.push(ticket.backupDir, ticket.stagingDir);
    const bytes = Buffer.from(JSON.stringify({ version: 1, state: "pending", token: randomUUID(), ...ticket }));
    if (bytes.length > RECOVERY_RECEIPT_LIMIT) throw new Error("Recovery receipt exceeds limit");
    assertRecoveryDirectories(directories); assertRecoveryLease(options.dirId, lease);
    fd = fs.openSync(location.receiptPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    const receiptOwner = fs.fstatSync(fd);
    const closing = fd; fd = undefined; fs.closeSync(closing);
    const record: RecoveryTicketRecord = { ticket, lease, directories, receiptOwner, bytes, finished: false };
    assertRecoveryDirectories(directories); verifyRecoveryReceipt(location.receiptPath, receiptOwner, bytes);
    for (const directory of directories.slice(0, 2)) syncRecoveryDirectory(directory);
    assertRecoveryDirectories(directories); assertRecoveryLease(options.dirId, lease);
    verifyRecoveryReceipt(location.receiptPath, receiptOwner, bytes);
    recoveryTickets.set(ticket, record); return ticket;
  } catch {
    const error = fullProfileRecoveryError(options.dirId, location.receiptPath, recoveryPaths);
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { Object.assign(error, { receiptHandleClosureUnconfirmed: true }); }
    }
    throw error;
  }
}
function assertRecoveryTicket(record: RecoveryTicketRecord): void {
  const current = recoveryLocation(record.ticket.dirId);
  if (current.receiptPath !== record.ticket.receiptPath || current.profileDir !== record.ticket.profileDir) throw new Error("Recovery scope changed");
  assertRecoveryDirectories(record.directories); assertRecoveryLease(record.ticket.dirId, record.lease);
}
/** On a failed post-unlink durability/readback check, re-establish the gate by
 * exclusive creation only. A new object is itself a gate and is never replaced. */
function reinstateRecoveryReceipt(record: RecoveryTicketRecord): boolean {
  let fd: number | undefined;
  try {
    assertRecoveryTicket(record);
    if (fs.lstatSync(record.ticket.receiptPath, { throwIfNoEntry: false })) return true;
    fd = fs.openSync(record.ticket.receiptPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    fs.writeFileSync(fd, record.bytes); fs.fsyncSync(fd);
    const owner = fs.fstatSync(fd), closing = fd; fd = undefined; fs.closeSync(closing);
    record.receiptOwner = owner;
    for (const directory of record.directories.slice(0, 2)) syncRecoveryDirectory(directory);
    assertRecoveryTicket(record); verifyRecoveryReceipt(record.ticket.receiptPath, owner, record.bytes); return true;
  } catch {
    // Partial/unreadable receipts are also blocking. Do not erase failed writes.
    try { assertRecoveryDirectories(record.directories); return Boolean(fs.lstatSync(record.ticket.receiptPath, { throwIfNoEntry: false })); }
    catch { return false; }
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { return false; } } }
}

/** Only the original live lease and unmodified owned receipt authorize removal.
 * Caller must already have confirmed config commit OR full rollback and cleanup. */
export function finishFullProfileRecovery(ticket: FullProfileRecoveryTicket): void {
  const record = recoveryTickets.get(ticket);
  if (!record) {
    let dirId = "";
    try { if (ticket && typeof ticket.dirId === "string") { validateDirId(ticket.dirId); dirId = ticket.dirId; } } catch { dirId = ""; }
    const location = dirId ? recoveryLocation(dirId) : undefined;
    throw fullProfileRecoveryError(dirId, location?.receiptPath || "", location ? [location.receiptPath, location.profileDir] : []);
  }
  let removed = false;
  try {
    assertRecoveryTicket(record);
    if (record.finished) {
      if (fs.lstatSync(ticket.receiptPath, { throwIfNoEntry: false })) throw new Error("A different recovery receipt appeared");
      return;
    }
    verifyRecoveryReceipt(ticket.receiptPath, record.receiptOwner, record.bytes);
    // Fail while the gate is still present on ordinary durability errors.
    for (const directory of record.directories.slice(0, 2)) syncRecoveryDirectory(directory);
    assertRecoveryTicket(record); verifyRecoveryReceipt(ticket.receiptPath, record.receiptOwner, record.bytes);
    assertRecoveryTicket(record);
    const latest = fs.lstatSync(ticket.receiptPath);
    if (!latest.isFile() || latest.isSymbolicLink() || !recoverySnapshot(latest, record.receiptOwner)) throw new Error("Recovery receipt changed before removal");
    fs.unlinkSync(ticket.receiptPath); removed = true;
    for (const directory of record.directories.slice(0, 2)) syncRecoveryDirectory(directory);
    assertRecoveryTicket(record);
    if (fs.lstatSync(ticket.receiptPath, { throwIfNoEntry: false })) throw new Error("Recovery removal was not confirmed");
    record.finished = true;
  } catch {
    const error = fullProfileRecoveryError(ticket.dirId, ticket.receiptPath, [ticket.receiptPath, ticket.profileDir, ticket.backupDir, ticket.stagingDir]);
    if (removed) Object.assign(error, { recoveryGateConfirmed: reinstateRecoveryReceipt(record) });
    throw error;
  }
}

function getRestoreLockPath(dirId: string): string {
  validateDirId(dirId);
  return path.join(getAppDataDir(), "locks", `${dirId}.restore.lock`);
}

export function isRestoreLocked(dirId: string, options?: { reclaimStale?: boolean }): boolean {
  validateDirId(dirId);
  try { assertNoFullProfileRecovery(dirId); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "FULL_PROFILE_RECOVERY_REQUIRED") return true; throw error; }
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
  assertNoFullProfileRecovery(dirId);
  if (heldLocks.has(dirId)) throw new Error(`Restore already in progress for ${dirId}`);
  const lockPath = getRestoreLockPath(dirId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(path.dirname(lockPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe restore lock directory");
  assertNoFullProfileRecovery(dirId);
  let fd: number | null = null;
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let created: fs.Stats | undefined;
    try {
      assertNoFullProfileRecovery(dirId);
      const currentParent = fs.lstatSync(path.dirname(lockPath));
      if (!currentParent.isDirectory() || currentParent.isSymbolicLink() || !recoveryIdentity(parent, currentParent)) throw new Error("Restore lock directory changed");
      fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      created = fs.fstatSync(fd);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, dirId, token, createdAt: new Date().toISOString() }));
      assertNoFullProfileRecovery(dirId);
      heldLocks.set(dirId, { fd, token });
      break;
    } catch (error: any) {
      if (fd !== null) { const closing = fd; fd = null; fs.closeSync(closing); }
      if (error?.code === "EEXIST") {
        const snapshot = readRestoreLock(lockPath);
        // A proven-dead lease is not an active restore. Reclaim by the same
        // token/inode checks, then compete for O_EXCL once, never spin or steal.
        if (attempt === 0 && snapshot?.stale && removeRestoreLockIfTokenMatches(lockPath, snapshot.token, true)) continue;
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
