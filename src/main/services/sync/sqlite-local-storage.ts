import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { ensureArchiveDirectory } from "../zip-writer.js";

export const SQLITE_LOCAL_STORAGE_FILES = ["LocalStorage", "LocalStorage-wal"] as const;
export const SQLITE_LOCAL_STORAGE_SIDECARS = [...SQLITE_LOCAL_STORAGE_FILES, "LocalStorage-shm", "LocalStorage-journal"] as const;
// Tighter than the enclosing 200 MiB TAR / 500 MiB aggregate limits. Fail
// explicitly, never call an oversized/unsupported SQLite database "absent".
export const MAX_SQLITE_LOCAL_STORAGE_BYTES = 64 * 1024 * 1024;
const MAX_SQLITE_PAGES = 16384;
const MAX_WAL_FRAMES = 16384;
const CHECK_TIMEOUT_MS = 5000;
const BLOCK = 64 * 1024;

export type SqliteFileWitness = { name: string; stat: fs.Stats | undefined };
type Witness = SqliteFileWitness;
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Sync operation cancelled");
}
function sameStat(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function safeDirectory(directory: string): void {
  let current = path.resolve(directory);
  // Reuse the archive helper's OS temporary-root anchor (/var -> /private/var
  // on macOS). Links below that platform anchor are still refused, not followed.
  while (!fs.lstatSync(current, { throwIfNoEntry: false })) {
    const parent = path.dirname(current); if (parent === current) throw new Error("SQLite directory root unavailable"); current = parent;
  }
  ensureArchiveDirectory(current);
}
export function sqliteGroupWitnesses(directory: string, basename = "LocalStorage"): Witness[] {
  if (!["LocalStorage", "History", "places.sqlite"].includes(basename)) throw new Error("Unsupported SQLite group name");
  safeDirectory(directory);
  return [basename, basename + "-wal", basename + "-shm", basename + "-journal"].map((name) => {
    const stat = fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("Unsafe SQLite LocalStorage file");
    // A nonempty rollback journal can carry pre-transaction pages even while
    // main quick_check is green. Never open/checkpoint/repair a live journal.
    if (name === basename + "-journal" && stat && stat.size !== 0) throw new Error("Nonempty SQLite rollback journal is not supported");
    return { name, stat };
  });
}
const witnesses = (directory: string) => sqliteGroupWitnesses(directory);
export function assertSqliteGroupUnchanged(directory: string, expected: Witness[], basename = "LocalStorage"): void {
  const actual = sqliteGroupWitnesses(directory, basename);
  if (actual.some((item, i) => Boolean(item.stat) !== Boolean(expected[i].stat) ||
      item.stat && expected[i].stat && !sameStat(item.stat, expected[i].stat!))) {
    throw new Error("SQLite LocalStorage group changed during capture");
  }
}
const sameGroup = assertSqliteGroupUnchanged;
export function hasSqliteLocalStorage(directory: string): boolean {
  const group = witnesses(directory);
  if (!group[0].stat) {
    if (group.some((item) => item.stat)) throw new Error("Orphan SQLite LocalStorage WAL/SHM without main database");
    return false;
  }
  return true;
}

/** Open once, NOFOLLOW, exact EOF and pre/post identity; bounded chunked I/O. */
export function readPinnedSqliteFile(file: string, before: fs.Stats, signal?: AbortSignal, maxBytes = MAX_SQLITE_LOCAL_STORAGE_BYTES): Buffer {
  abort(signal);
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size === 0 && !path.basename(file).endsWith("-wal") || before.size > maxBytes) throw new Error("SQLite file exceeds validation byte limit or has an empty main");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameStat(opened, before)) throw new Error("SQLite LocalStorage file changed before capture");
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      abort(signal);
      const n = fs.readSync(fd, bytes, offset, Math.min(BLOCK, bytes.length - offset), offset);
      if (!n) throw new Error("SQLite LocalStorage file changed during capture");
      offset += n;
    }
    const extra = Buffer.alloc(1);
    if (fs.readSync(fd, extra, 0, 1, bytes.length) || !sameStat(before, fs.fstatSync(fd)) || !sameStat(before, fs.lstatSync(file))) throw new Error("SQLite LocalStorage file changed during capture");
    return bytes;
  } finally { fs.closeSync(fd); }
}
const readPinned = readPinnedSqliteFile;
export function writeOwnedSqliteFile(file: string, bytes: Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const stat = fs.lstatSync(file);
  if (!readPinned(file, stat).equals(bytes)) throw new Error("SQLite LocalStorage staging readback mismatch");
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** SQLite WAL checksums cover the header and EVERY frame, not merely its length
 * or last commit. A torn/stale/unassociated WAL is rejected before extraction. */
export function validateSqliteLocalStorageGroup(main: Buffer, wal?: Buffer, signal?: AbortSignal): void {
  abort(signal);
  if (main.length < 512 || main.length + (wal?.length || 0) > MAX_SQLITE_LOCAL_STORAGE_BYTES ||
      !main.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "binary"))) throw new Error("Invalid SQLite LocalStorage header or byte limit");
  const encodedPageSize = main.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) || main.length % pageSize ||
      main.length / pageSize > MAX_SQLITE_PAGES || ![1, 2].includes(main[18]) || ![1, 2].includes(main[19]) ||
      main[20] > pageSize - 480 || main[21] !== 64 || main[22] !== 32 || main[23] !== 32 ||
      main.readUInt32BE(28) > MAX_SQLITE_PAGES || main.subarray(72, 92).some((byte) => byte !== 0)) throw new Error("Invalid SQLite LocalStorage page header or page limit");
  // SQLite can retain a zero-byte, already-reset WAL. Preserve that explicit
  // empty member; it has no frames, unlike a truncated nonempty WAL header.
  if (wal === undefined || wal.length === 0) return;
  if (main[18] !== 2 || main[19] !== 2 || wal.length < 32) throw new Error("Invalid SQLite LocalStorage WAL header");
  const magic = wal.readUInt32BE(0);
  if (![0x377f0682, 0x377f0683].includes(magic) || wal.readUInt32BE(4) !== 3007000 || wal.readUInt32BE(8) !== pageSize ||
      (wal.length - 32) % (24 + pageSize)) throw new Error("Invalid SQLite LocalStorage WAL header or truncated frame");
  const frames = (wal.length - 32) / (24 + pageSize);
  if (frames > MAX_WAL_FRAMES) throw new Error("SQLite LocalStorage WAL exceeds frame limit");
  let s1 = 0, s2 = 0;
  const checksum = (bytes: Buffer) => {
    for (let offset = 0; offset < bytes.length; offset += 8) {
      const a = magic === 0x377f0682 ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      const b = magic === 0x377f0682 ? bytes.readUInt32LE(offset + 4) : bytes.readUInt32BE(offset + 4);
      s1 = (s1 + a + s2) >>> 0; s2 = (s2 + b + s1) >>> 0;
    }
  };
  checksum(wal.subarray(0, 24));
  if (wal.readUInt32BE(24) !== s1 || wal.readUInt32BE(28) !== s2) throw new Error("SQLite LocalStorage WAL header checksum mismatch");
  for (let offset = 32; offset < wal.length; offset += 24 + pageSize) {
    abort(signal);
    const page = wal.readUInt32BE(offset), committedSize = wal.readUInt32BE(offset + 4);
    if (!page || page > MAX_SQLITE_PAGES || committedSize > MAX_SQLITE_PAGES ||
        !wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) throw new Error("SQLite LocalStorage WAL salt/page mismatch");
    checksum(wal.subarray(offset, offset + 8)); checksum(wal.subarray(offset + 24, offset + 24 + pageSize));
    if (wal.readUInt32BE(offset + 16) !== s1 || wal.readUInt32BE(offset + 20) !== s2) throw new Error("SQLite LocalStorage WAL frame checksum mismatch");
  }
}

// Trusted checker only. Database SQL is observed as data, never interpolated or
// executed. No browser table names are assumed; Chromium semantics are a later
// runtime gate. Worker V8 heap limits do NOT cap SQLite's entire native heap.
const CHECKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false, timeout: 100 });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA ignore_check_constraints=ON; PRAGMA mmap_size=0; PRAGMA cache_size=-2048;');
  const schema = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema LIMIT 129').all();
  if (schema.length > 128) throw new Error('schema limit');
  let sqlBytes = 0;
  for (const row of schema) {
    if (!['table','index'].includes(row.type) || typeof row.name !== 'string' || row.name.length > 256 ||
        typeof row.tbl_name !== 'string' || row.tbl_name.length > 256 || !Number.isSafeInteger(row.rootpage) ||
        row.rootpage < 1 || row.rootpage > 16384 || row.sql !== null && typeof row.sql !== 'string') throw new Error('unsupported schema');
    sqlBytes += row.sql ? Buffer.byteLength(row.sql) : 0;
    if (sqlBytes > 262144 || row.sql && /\bCHECK\b/i.test(row.sql)) throw new Error('unsupported schema expression/byte limit');
    // quick_check can otherwise evaluate CHECK/generated expressions. Observe
    // column/index metadata through fixed, bound built-in PRAGMA queries only.
    const columns = db.prepare(row.type === 'table' ? 'SELECT hidden AS flag FROM pragma_table_xinfo(?) LIMIT 257' : 'SELECT cid AS flag FROM pragma_index_xinfo(?) LIMIT 257').all(row.name);
    if (columns.length > 256 || columns.some((column) => row.type === 'table' ? column.flag !== 0 : column.flag === -2)) throw new Error('unsupported generated/index expression');
  }
  const pages = db.prepare('PRAGMA page_count').get();
  if (!Number.isSafeInteger(pages.page_count) || pages.page_count < 1 || pages.page_count > 16384) throw new Error('page limit');
  const check = db.prepare('PRAGMA quick_check(1)').get();
  if (!check || check.quick_check !== 'ok') throw new Error('quick_check failed');
  db.close(); db = undefined;
  parentPort.postMessage({ ok: true });
} catch (_) {
  if (db) { try { db.close(); } catch (closeError) { /* worker exit retains failure */ } }
  parentPort.postMessage({ ok: false });
} finally { parentPort.close(); }
`;

export function runSqliteChecker<T = void>(source: string, data: Record<string, unknown>, label: string, signal?: AbortSignal): Promise<T> {
  abort(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    let failure: Error | undefined;
    let passed = false;
    let value: T;
    let terminating = false;
    const stop = (error: Error) => {
      failure ??= error;
      if (!terminating) {
        terminating = true;
        // Never resolve/reject here. Native work and its owned staging stay
        // owned until the actual exit event, including on abort/deadline.
        void worker.terminate().catch((error) => { console.error("[sync] SQLite worker termination failed:", error); });
      }
    };
    const timer = setTimeout(() => stop(new Error(`${label} validation deadline exceeded`)), CHECK_TIMEOUT_MS);
    const onAbort = () => stop(new Error("Sync operation cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message) => {
      passed = message?.ok === true; value = message?.value;
      if (!passed) failure ??= Object.assign(new Error(`${label} integrity/schema validation failed${typeof message?.reason === "string" ? ": " + message.reason : ""}`),
        message?.code === "HISTORY_SCHEMA_UNSUPPORTED" || message?.code === "HISTORY_VALIDATION_FAILED" ? { code: message.code } : {});
    });
    worker.on("error", () => { failure ??= new Error(`${label} checker failed`); });
    worker.once("exit", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0 || !passed) reject(new Error(`${label} validation was not confirmed`));
      else resolve(value);
    });
    if (signal?.aborted) onAbort();
  });
}

/** Only scratch copies are opened by SQLite; SHM is rebuilt there. Confirm the
 * worker stopped before scratch deletion, then recheck untouched prepared bytes. */
export async function validateStagedSqliteLocalStorage(directory: string, signal?: AbortSignal): Promise<void> {
  abort(signal);
  const expected = witnesses(directory);
  if (!expected[0].stat || expected[2].stat) throw new Error("Invalid SQLite LocalStorage staging group");
  const main = readPinned(path.join(directory, "LocalStorage"), expected[0].stat, signal);
  const wal = expected[1].stat ? readPinned(path.join(directory, "LocalStorage-wal"), expected[1].stat, signal) : undefined;
  validateSqliteLocalStorageGroup(main, wal, signal);
  const scratch = fs.mkdtempSync(path.join(directory, ".sqlite-check-"));
  const owner = fs.lstatSync(scratch);
  try {
    writeOwnedSqliteFile(path.join(scratch, "LocalStorage"), main);
    if (wal) writeOwnedSqliteFile(path.join(scratch, "LocalStorage-wal"), wal);
    await runSqliteChecker(CHECKER_SOURCE, { file: path.join(scratch, "LocalStorage") }, "SQLite LocalStorage", signal);
    abort(signal); sameGroup(directory, expected);
    if (!readPinned(path.join(directory, "LocalStorage"), expected[0].stat, signal).equals(main) ||
        wal && !readPinned(path.join(directory, "LocalStorage-wal"), expected[1].stat!, signal).equals(wal)) throw new Error("SQLite LocalStorage staging changed during validation");
  } finally {
    const current = fs.lstatSync(scratch);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("SQLite checker scratch owner changed; retained for recovery");
    fs.rmSync(scratch, { recursive: true });
  }
}

export async function captureSqliteLocalStorage(source: string, destination: string, signal?: AbortSignal): Promise<{ files: number; bytesWritten: number }> {
  abort(signal);
  const expected = witnesses(source);
  if (!expected[0].stat) throw new Error("SQLite LocalStorage main database disappeared during capture");
  const captured = new Map<string, string>();
  let bytesWritten = 0;
  for (const item of expected.slice(0, 2)) {
    if (!item.stat) continue;
    bytesWritten += item.stat.size;
    if (bytesWritten > MAX_SQLITE_LOCAL_STORAGE_BYTES) throw new Error("SQLite LocalStorage group exceeds byte limit");
    const bytes = readPinned(path.join(source, item.name), item.stat, signal);
    writeOwnedSqliteFile(path.join(destination, item.name), bytes); captured.set(item.name, digest(bytes));
  }
  const recheck = () => {
    sameGroup(source, expected);
    for (const item of expected.slice(0, 2)) {
      if (item.stat && digest(readPinned(path.join(source, item.name), item.stat, signal)) !== captured.get(item.name)) throw new Error("SQLite LocalStorage group bytes changed during capture");
    }
    sameGroup(source, expected);
  };
  recheck();
  await validateStagedSqliteLocalStorage(destination, signal);
  abort(signal); recheck();
  return { files: captured.size, bytesWritten };
}
