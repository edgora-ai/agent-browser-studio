import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAppDataDir } from "./config-manager.js";
import { validateDirId } from "./utils.js";
import { syncArchiveDirectory } from "./zip-writer.js";

// Local evidence invalidation, never portable profile metadata or browser data.
// One bounded record per profile; no history, expiry, or read-triggered writes.
// This invalidates current-session candidates, never authorizes one from disk.
// Candidates/tokens are memory-only and die on restart. If Windows explicitly
// cannot fsync directories, file fsync + atomic rename + strict readback still
// establish visible invalidation; do not claim directory crash durability.
const STORE = "profile-data-revisions";
const MAX_BYTES = 512;
const MAX_FILES = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

type RecordValue = { version: 1; dirId: string; revision: string };
type RecordSnapshot = { value: RecordValue; stat: fs.Stats };

function unavailable(message: string, cause?: unknown): Error {
  return Object.assign(new Error("Profile data revision unavailable: " + message, { cause }), { code: "PROFILE_DATA_REVISION_UNAVAILABLE" });
}
function owned(stat: fs.Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}
function same(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function directoryStat(directory: string, privateDirectory: boolean): fs.Stats | undefined {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) ||
      privateDirectory && process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw unavailable("unsafe revision directory");
  }
  return stat;
}
function openDirectory(directory: string, stat: fs.Stats): number {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | NOFOLLOW | (fs.constants.O_DIRECTORY || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw unavailable("revision directory changed");
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function assertDirectory(directory: string, fd: number): void {
  const stat = directoryStat(directory, true);
  const opened = fs.fstatSync(fd);
  if (!stat || stat.dev !== opened.dev || stat.ino !== opened.ino) throw unavailable("revision directory changed");
}
function syncRevisionDirectory(directory: string, fd: number, privateDirectory = true): void {
  const check = () => {
    const current = directoryStat(directory, privateDirectory), opened = fs.fstatSync(fd);
    if (!current || current.dev !== opened.dev || current.ino !== opened.ino) throw unavailable("revision directory changed during sync");
  };
  check();
  // Reuse the exact existing Windows predicate: only EPERM from fsync after a
  // successful directory open is unsupported; open/EACCES/EIO/ENOSPC stay fatal.
  const synced = syncArchiveDirectory(directory);
  check();
  if (!synced) console.warn("[profile-data-revision] Windows directory fsync is unsupported; directory crash durability is unverified. File fsync, atomic publication and strict readback remain required. Candidates are memory-only and do not survive restart.");
}
function readRecord(file: string, dirId: string): RecordSnapshot | undefined {
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !owned(before) || before.size > MAX_BYTES ||
      process.platform !== "win32" && (before.mode & 0o077) !== 0) throw unavailable("unsafe revision file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!same(before, opened)) throw unavailable("revision file changed before read");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.lstatSync(file, { throwIfNoEntry: false });
    if (count !== before.size || count > MAX_BYTES || !same(opened, fs.fstatSync(fd)) || !after || !same(before, after)) {
      throw unavailable("revision file changed during read");
    }
    const value = JSON.parse(bytes.subarray(0, count).toString("utf8")) as RecordValue;
    if (!value || Object.keys(value).sort().join(",") !== "dirId,revision,version" || value.version !== 1 ||
        value.dirId !== dirId || typeof value.revision !== "string" || !UUID.test(value.revision)) throw unavailable("invalid revision record");
    return { value, stat: before };
  } finally { fs.closeSync(fd); }
}
function paths(dirId: string): { base: string; directory: string; file: string } {
  validateDirId(dirId);
  const base = getAppDataDir(); // This getter resolves a path only; it does not create the store.
  const directory = path.join(base, STORE);
  return { base, directory, file: path.join(directory, dirId + ".json") };
}

/** Read-only: missing evidence has a stable initial revision and creates nothing. */
export function getProfileDataRevision(dirId: string): string {
  const { base, directory, file } = paths(dirId);
  try {
    if (!directoryStat(base, false)) return "initial";
    const stat = directoryStat(directory, true);
    if (!stat) return "initial";
    const fd = openDirectory(directory, stat);
    try {
      const snapshot = readRecord(file, dirId);
      assertDirectory(directory, fd);
      return snapshot?.value.revision ?? "initial";
    } finally { fs.closeSync(fd); }
  } catch (error) { throw unavailable("could not read the local revision", error); }
}

/**
 * Call under the profile mutation/restore owner BEFORE any potentially effective
 * write or runtime dispatch. File flush/publication/readback errors stop that
 * write. Only the documented unsupported Windows directory-fsync case is a
 * diagnostic, not a claim of directory durability. A failed/unknown restore may
 * invalidate evidence; it must never resurrect it.
 */
export function markProfileDataChanging(dirId: string): void {
  const { base, directory, file } = paths(dirId);
  let directoryFd: number | undefined;
  let temporary: string | undefined;
  let temporaryOwner: fs.Stats | undefined;
  try {
    const baseStat = directoryStat(base, false);
    if (!baseStat) throw unavailable("application data directory is missing");
    let stat = directoryStat(directory, true);
    if (!stat) {
      const baseFd = openDirectory(base, baseStat);
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
        syncRevisionDirectory(base, baseFd, false);
      } finally { fs.closeSync(baseFd); }
      stat = directoryStat(directory, true);
    }
    if (!stat) throw unavailable("revision directory is missing");
    directoryFd = openDirectory(directory, stat);
    const previous = readRecord(file, dirId);
    if (!previous) {
      const entries = fs.opendirSync(directory);
      try {
        let count = 0;
        while (entries.readSync()) if (++count >= MAX_FILES) throw unavailable("revision store file limit exceeded");
      } finally { entries.closeSync(); }
    }
    const value: RecordValue = { version: 1, dirId, revision: randomUUID() };
    const bytes = Buffer.from(JSON.stringify(value));
    temporary = path.join(directory, "." + dirId + "." + randomUUID() + ".tmp");
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try {
      temporaryOwner = fs.fstatSync(fd);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (readRecord(temporary, dirId)?.value.revision !== value.revision) throw unavailable("revision staging readback mismatch");
    assertDirectory(directory, directoryFd);
    const current = fs.lstatSync(file, { throwIfNoEntry: false });
    if (previous ? !current || !same(previous.stat, current) : current !== undefined) throw unavailable("revision changed before publication");
    fs.renameSync(temporary, file);
    temporary = undefined;
    syncRevisionDirectory(directory, directoryFd);
    if (readRecord(file, dirId)?.value.revision !== value.revision) throw unavailable("revision publication readback mismatch");
    assertDirectory(directory, directoryFd);
  } catch (error) {
    throw unavailable("could not durably advance the local revision; restore was not authorized", error);
  } finally {
    let cleanupError: unknown;
    try {
      if (temporary && temporaryOwner && directoryFd !== undefined) {
        assertDirectory(directory, directoryFd);
        const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
        if (current && current.dev === temporaryOwner.dev && current.ino === temporaryOwner.ino && !current.isSymbolicLink()) fs.unlinkSync(temporary);
      }
    } catch (error) { cleanupError = error; }
    try { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
    catch (error) { cleanupError ??= error; }
    if (cleanupError) throw unavailable("revision cleanup failed; restore was not authorized", cleanupError);
  }
}
