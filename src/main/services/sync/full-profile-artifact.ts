import * as fs from "node:fs";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { BrowserEngine } from "../../types.js";
import {
  ensureArchiveDirectory, extractZipArchive, extractZipEntry, isPathInside, MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES, readZipEntries, syncArchiveDirectory, validateZipEntryName, writeZipArchive,
  type ZipDirEntry, type ZipEntry, type ZipFileEntry,
} from "../zip-writer.js";

export const FULL_PROFILE_FORMAT = "roxy-full-profile-v1" as const;
export const MAX_FULL_PROFILE_BODY_BYTES = 512 * 1024 * 1024;
export const MAX_FULL_PROFILE_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const MAX_FULL_PROFILE_ENTRIES = MAX_ZIP_ENTRIES;
export const MAX_FULL_PROFILE_DEPTH = 64;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const CHUNK = 64 * 1024;
// Keep frequent guards/64 KiB I/O, but amortize process discovery over a bounded
// synchronous batch. The read-work timer starts after fresh process admission:
// one slow, non-preemptible discovery must not reduce every batch to one chunk.
// Subsequent guards/syscalls are soft time bounds; bytes/checkpoints also bound
// work if the wall clock moves backward.
const READ_BATCH_BYTES = 4 * 1024 * 1024;
const READ_BATCH_MS = 16;
const READ_BATCH_CHECKPOINTS = 128;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const MAGIC = Buffer.from("RXYFP001", "ascii");
const PREFIX_BYTES = MAGIC.length + 4;
const TAG_BYTES = 16;
const KDF = "scrypt-32768-8-1";
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface FullProfileArtifact {
  format: typeof FULL_PROFILE_FORMAT;
  /** Content-addressed encrypted object only; never a filesystem path. */
  key: string;
  sha256: string;
  size: number;
  dirId: string;
  engine: BrowserEngine;
  snapshotId: string;
  sourcePlatform: string;
  browserVersion?: string;
  createdAt: number;
}
export interface FullProfileMember { path: string; size: number; sha256: string; }
export interface FullProfileManifest {
  format: typeof FULL_PROFILE_FORMAT;
  dirId: string;
  engine: BrowserEngine;
  snapshotId: string;
  sourcePlatform: string;
  browserVersion?: string;
  createdAt: number;
  files: readonly FullProfileMember[];
  /** Includes empty directories, without trailing slashes. */
  directories: readonly string[];
  /** Separate namespace, never installed in the browser profile. */
  extraEntries: readonly FullProfileMember[];
}
export interface FullProfileExtraEntry {
  path: string;
  /** Only already-encrypted capsules or non-secret metadata. Never raw keys. */
  data: Buffer;
}
export type FullProfileGuard = (() => void) & {
  /** Coalesce discovery only inside this synchronous read slice, never an await. */
  runSynchronous?: <T>(action: () => T) => T;
};
export interface FullProfileProgress {
  phase: "scanning" | "reading-archive" | "verifying-source" | "verifying-profile" | "verifying-extras" |
    "packing" | "encrypting" | "decrypting" | "extracting";
  /** Phase-local cumulative processing bytes and member checkpoints visited. */
  bytes: number;
  items: number;
  totalBytes?: number;
  totalItems?: number;
}
/** Local, synchronous observation only; no paths or profile contents are exposed. */
export type FullProfileProgressCallback = (progress: FullProfileProgress) => void;
export interface CaptureFullProfileOptions {
  profileDir: string;
  stagingDir: string;
  dirId: string;
  engine: BrowserEngine;
  snapshotId: string;
  passphrase: string;
  sourcePlatform: string;
  browserVersion?: string;
  guard: FullProfileGuard;
  signal?: AbortSignal;
  onProgress?: FullProfileProgressCallback;
  extraEntries?: readonly FullProfileExtraEntry[];
}
export interface PrepareFullProfileOptions {
  body: Buffer;
  descriptor: FullProfileArtifact;
  stagingDir: string;
  passphrase: string;
  dirId: string;
  engine: BrowserEngine;
  /** When known from the enclosing snapshot, also bind that identity here. */
  snapshotId?: string;
  guard: FullProfileGuard;
  signal?: AbortSignal;
  onProgress?: FullProfileProgressCallback;
}
export interface PreparedFullProfile {
  readonly directory: string;
  /** Profile files/bytes only, excluding capsules and the internal manifest. */
  readonly files: number;
  readonly bytes: number;
  readonly manifest: FullProfileManifest;
  /** Authenticated remote inventory; never rewritten by local conversion. */
  readonly sourceManifest: FullProfileManifest;
  /** manifest is a local derivative, not the remote object's original hashes. */
  readonly locallyDerived: boolean;
  readonly extraDirectory?: string;
}
export interface RestoredFullProfile {
  files: number;
  bytes: number;
  backupDir?: string;
  /** Filled after rollback; the displaced incoming tree is retained, not erased. */
  rollbackDir?: string;
  warnings?: string[];
  rollback(): void;
}

interface Identity {
  format: typeof FULL_PROFILE_FORMAT; dirId: string; engine: BrowserEngine; snapshotId: string;
  sourcePlatform: string; browserVersion?: string; createdAt: number;
}
interface Header extends Identity { cipher: "aes-256-gcm"; kdf: typeof KDF; salt: string; iv: string; }
interface Witness { path: string; stat: fs.Stats; }
interface ScannedFile extends FullProfileMember { stat: fs.Stats; }
interface Tree {
  root: fs.Stats;
  all: Witness[];
  files: ScannedFile[];
  directories: string[];
}
interface OwnedDirectory { directory: string; owner: fs.Stats; }
interface PreparedRecord {
  workspace: OwnedDirectory;
  profileOwner: fs.Stats;
  extraOwner?: fs.Stats;
  manifest: FullProfileManifest;
  sourceManifest: FullProfileManifest;
}
const preparedRecords = new WeakMap<PreparedFullProfile, PreparedRecord>();

function failure(code: string, message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}
function invalid(message: string): never { throw failure("FULL_PROFILE_INVALID", message); }
function sizeLimit(kind: "entry" | "expanded" | "body", bytes: number, limitBytes: number, memberPath?: string, estimated = false): never {
  throw Object.assign(failure("FULL_PROFILE_SIZE_LIMIT", `Full-profile ${kind} size limit exceeded: ${estimated ? "estimated " : ""}${bytes} bytes; limit ${limitBytes} bytes` +
    (memberPath ? `; retained member ${JSON.stringify(memberPath)}` : "") + ". Persistent browser data is not omitted to fit this limit."),
  { limitKind: kind, ...(estimated ? { estimatedBytes: bytes } : { actualBytes: bytes }), limitBytes, ...(memberPath ? { memberPath } : {}) });
}
function sizeContext(cause: unknown, dirId: string): unknown {
  if ((cause as { code?: unknown })?.code === "FULL_PROFILE_SIZE_LIMIT") {
    const error = cause as Error & { dirId?: string };
    if (error.dirId === undefined) Object.assign(error, { dirId, message: `Profile ${dirId}: ${error.message}` });
  }
  return cause;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function combine(original: unknown, subsequent: unknown, context: string): Error {
  return Object.assign(new Error(`${errorText(original)}; ${context}: ${errorText(subsequent)}`, { cause: original }), {
    code: (original as NodeJS.ErrnoException)?.code || "FULL_PROFILE_FAILED",
    errors: [original, subsequent],
  });
}
function recovery(message: string, paths: string[], cause?: unknown): Error {
  return Object.assign(failure("FULL_PROFILE_RECOVERY_REQUIRED", message + "; retained for recovery", cause), { recoveryPaths: paths });
}
function synchronousSlice<T>(guard: FullProfileGuard, action: () => T): T {
  if (guard.runSynchronous === undefined) return action();
  if (typeof guard.runSynchronous !== "function") invalid("Invalid synchronous full-profile executor");
  const result = guard.runSynchronous(action), inspected: unknown = result;
  if (inspected !== null && inspected !== undefined && typeof (inspected as { then?: unknown }).then === "function") {
    void Promise.resolve(inspected).catch(() => undefined);
    invalid("Full-profile synchronous executor cannot span an await");
  }
  return result;
}
function check(guard: FullProfileGuard, signal?: AbortSignal): void {
  if (typeof guard !== "function") invalid("A synchronous full-profile guard is required");
  if (signal?.aborted) throw failure("ABORT_ERR", "Full-profile operation aborted");
  const result: unknown = guard();
  if (result !== undefined && result !== null && typeof (result as { then?: unknown }).then === "function") {
    // Observe a rejected async guard, but never mistake it for a completed check.
    void Promise.resolve(result).catch(() => undefined);
    invalid("Full-profile guard must be synchronous");
  }
  if (signal?.aborted) throw failure("ABORT_ERR", "Full-profile operation aborted");
}
async function guardedAwait<T>(operation: () => Promise<T>, guard: FullProfileGuard, signal?: AbortSignal): Promise<T> {
  check(guard, signal);
  let value: T | undefined, error: unknown;
  try { value = await operation(); } catch (cause) { error = cause; }
  try { check(guard, signal); } catch (cause) { error = error ? combine(error, cause, "post-await guard failed") : cause; }
  if (error) throw error;
  return value as T;
}
function sameIdentity(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameSnapshot(a: fs.Stats, b: fs.Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode && a.nlink === b.nlink && a.uid === b.uid && a.gid === b.gid;
}
function lstatOptional(file: string): fs.Stats | undefined { return fs.lstatSync(file, { throwIfNoEntry: false }); }
function regular(file: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) invalid(`Full-profile file must be regular, unlinked and not a symlink: ${file}`);
}
function assertOwner(owned: OwnedDirectory): void {
  ensureArchiveDirectory(owned.directory);
  const current = fs.lstatSync(owned.directory);
  if (!current.isDirectory() || !sameIdentity(current, owned.owner)) throw recovery("Full-profile staging ownership changed", [owned.directory]);
}
function makeWorkspace(stagingDir: string, prefix: string): OwnedDirectory {
  const parent = ensureArchiveDirectory(stagingDir);
  const directory = fs.mkdtempSync(path.join(parent, prefix));
  fs.chmodSync(directory, 0o700);
  return { directory, owner: fs.lstatSync(directory) };
}
function cleanupOwned(owned: OwnedDirectory): void {
  assertOwner(owned);
  // Never recursively dispose an unknown replacement, hard link, or planted link.
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_FULL_PROFILE_DEPTH + 2) invalid("Unsafe full-profile cleanup depth");
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.isFile() && stat.nlink !== 1) {
        throw recovery("Unsafe object in owned full-profile staging", [owned.directory]);
      }
      if (stat.isDirectory()) visit(file, depth + 1);
    }
  };
  visit(owned.directory, 0); assertOwner(owned);
  fs.rmSync(owned.directory, { recursive: true });
}
function finishCleanup(owned: OwnedDirectory | undefined, original: unknown): unknown {
  if (!owned) return original;
  try { cleanupOwned(owned); } catch (cause) { return original ? combine(original, cause, "full-profile cleanup failed") : cause; }
  return original;
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
const IDENTITY_KEYS = ["format", "dirId", "engine", "snapshotId", "sourcePlatform", "createdAt"];
function validIdentity(value: Record<string, unknown>): boolean {
  return value.format === FULL_PROFILE_FORMAT && validId(value.dirId) && validId(value.snapshotId) &&
    (value.engine === "chromium" || value.engine === "firefox") && typeof value.sourcePlatform === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value.sourcePlatform) &&
    Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0 &&
    (!Object.hasOwn(value, "browserVersion") || typeof value.browserVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._()+ -]{0,127}$/.test(value.browserVersion));
}
function identity(value: Identity): Identity {
  return { format: FULL_PROFILE_FORMAT, dirId: value.dirId, engine: value.engine, snapshotId: value.snapshotId,
    sourcePlatform: value.sourcePlatform, ...(value.browserVersion !== undefined ? { browserVersion: value.browserVersion } : {}), createdAt: value.createdAt };
}
/** Strict parser for the enclosing sync metadata/backend; it never reads disk. */
export function parseFullProfileArtifact(value: unknown): FullProfileArtifact | null {
  if (!object(value) || !exactKeys(value, [...IDENTITY_KEYS, "key", "sha256", "size"], ["browserVersion"]) || !validIdentity(value) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || value.key !== `full-profile-v1-${value.sha256}.bin` ||
      !Number.isSafeInteger(value.size) || (value.size as number) < PREFIX_BYTES + TAG_BYTES + 2 || (value.size as number) > MAX_FULL_PROFILE_BODY_BYTES) return null;
  return Object.freeze({ ...identity(value as unknown as Identity), key: value.key as string, sha256: value.sha256, size: value.size as number });
}
function validateRelative(relative: string): void {
  validateZipEntryName(relative);
  const parts = relative.split("/");
  if (relative.endsWith("/") || parts.length > MAX_FULL_PROFILE_DEPTH || Buffer.byteLength(relative) > 4096 ||
      parts.some((part) => Buffer.byteLength(part) > 255) || /[\x7f]/.test(relative)) invalid("Full-profile path/depth limit exceeded");
}
function folded(relative: string): string { return relative.normalize("NFC").toLowerCase(); }
function rejectRecoveryOrQueue(relative: string): void {
  const leaf = relative.split("/").at(-1)!.toLowerCase();
  if (/^(?:\.?queued[-_]?cookies?|\.?pending-cookie-imports?)(?:[._-]|$)/.test(leaf)) {
    throw failure("FULL_PROFILE_COOKIE_QUEUE_UNRESOLVED", "Embedded pending Cookie queue must be resolved by the transfer coordinator");
  }
  if (/^(?:\.sqlite-localstorage-backup-|\.history-backup-|\.leveldb-backup-|\.profile-archive-recovery(?:$|-)|\.full-profile-|\.sync-restore|\.profile-restore|\.restore|\.recovery|\.rescue)/.test(leaf) || leaf === "recovery-required.json") {
    throw recovery("Unresolved or unknown profile recovery transaction", [relative]);
  }
}
/** Deliberately contextual: CacheStorage, SW ScriptCache and blob_storage are
 * persistent state. Browser-managed component downloads are omitted ONLY at the
 * Chromium user-data root, never by basename inside a profile or site storage.
 * Never reuse the old profile ZIP cache-name filter here. */
function temporaryPath(relative: string, engine: BrowserEngine): boolean {
  const parts = relative.split("/"), leaf = parts.at(-1)!;
  const processFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort", "lockfile", "parent.lock", ".parentlock", "lock", "MarionetteActivePort", "WebDriverBiDiServer.json"];
  if (leaf === "LOCK" || parts.length === 1 && processFiles.includes(leaf)) return true;
  if (engine === "firefox") return ["cache2", "startupCache", "shader-cache"].includes(parts[0]);
  const caches = ["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GraphiteDawnCache", "GrShaderCache", "ShaderCache"];
  const componentDownloads = ["component_crx_cache", "SODA", "SODALanguagePacks", "TranslateKit", "WasmTtsEngine"];
  return componentDownloads.includes(parts[0]) || caches.includes(parts[0]) ||
    parts.length >= 2 && /^(?:Default|Profile [0-9]+|Guest Profile|System Profile)$/.test(parts[0]) && caches.includes(parts[1]);
}
interface ReadCheckpoint { bytes: number; items: number; }
type Traversal<T> = Generator<ReadCheckpoint, T, void>;
function advanceBatch<T>(steps: Traversal<T>, guard: FullProfileGuard, signal?: AbortSignal, abandon?: (value: T) => void) {
  let completed: IteratorReturnResult<T> | undefined;
  try {
    return synchronousSlice(guard, () => {
      check(guard, signal);
      const started = Date.now();
      let bytes = 0, items = 0, checkpoints = 0;
      for (;;) {
        const step = steps.next();
        if (step.done) { completed = step; return { step, bytes, items }; }
        bytes += step.value.bytes; items += step.value.items; checkpoints++;
        // The next read may be a full chunk even after an uneven file tail.
        // Reserve that headroom so mixed small files cannot overshoot 4 MiB.
        if (bytes > READ_BATCH_BYTES - CHUNK || checkpoints >= READ_BATCH_CHECKPOINTS || Date.now() - started >= READ_BATCH_MS) {
          return { step, bytes, items };
        }
      }
    });
  } catch (error) {
    // A runSynchronous executor also validates the lease AFTER action returns.
    // It can reject a completed archive read before its buffer reaches a caller.
    if (completed) abandon?.(completed.value);
    throw error;
  }
}
function drain<T>(steps: Traversal<T>, guard: FullProfileGuard): T {
  try {
    // Synchronous apply/rollback APIs cannot yield, but still renew discovery at
    // the same bounded checkpoints. Publication remains outside these frames.
    for (;;) { const { step } = advanceBatch(steps, guard); if (step.done) return step.value; }
  } finally { steps.return(undefined as never); }
}
/** Every original guard still runs, including between 64 KiB chunks. Only the
 * process observation may be shared within one bounded synchronous batch. The
 * frame ends before callbacks/nextTurn; no safety observation spans an await.
 * Closing a suspended iterator closes its pinned fd and clears owned bytes. */
async function drainCooperatively<T>(steps: Traversal<T>, guard: FullProfileGuard, signal: AbortSignal | undefined,
  phase: FullProfileProgress["phase"], onProgress?: FullProfileProgressCallback, abandon?: (value: T) => void): Promise<T> {
  let bytes = 0, items = 0, completed: IteratorReturnResult<T> | undefined, returned = false;
  try {
    for (;;) {
      const batch = advanceBatch(steps, guard, signal, abandon);
      if (batch.step.done) completed = batch.step;
      bytes += batch.bytes; items += batch.items;
      if (onProgress) {
        const result: unknown = onProgress({ phase, bytes, items });
        if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === "function") {
          void Promise.resolve(result).catch(() => undefined);
          invalid("Full-profile progress callback must be synchronous");
        }
        // A callback can synchronously cancel or change config/lease state too.
        check(guard, signal);
      }
      if (batch.step.done) { returned = true; return batch.step.value; }
      await nextTurn();
      // The generator's next operation is its original guard, in a NEW frame.
    }
  } finally {
    try { steps.return(undefined as never); }
    finally { if (!returned && completed) abandon?.(completed.value); }
  }
}
function reportLocalProgress(value: FullProfileProgress, options: Pick<CaptureFullProfileOptions, "guard" | "signal" | "onProgress">): void {
  if (options.onProgress) {
    const result: unknown = options.onProgress(value);
    if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
      invalid("Full-profile progress callback must be synchronous");
    }
  }
  check(options.guard, options.signal);
}
/** Expose an honest phase boundary before non-preemptible crypto/extraction.
 * Yield before starting it, never during atomic profile publication/rollback. */
async function enterLocalPhase(phase: FullProfileProgress["phase"], options: Pick<CaptureFullProfileOptions, "guard" | "signal" | "onProgress">): Promise<void> {
  reportLocalProgress({ phase, bytes: 0, items: 0 }, options);
  await nextTurn();
  check(options.guard, options.signal);
}
function* visitFileSteps(file: string, expected: fs.Stats, guard: FullProfileGuard, signal?: AbortSignal, consume?: (chunk: Buffer, position: number) => void): Traversal<string> {
  check(guard, signal); ensureArchiveDirectory(path.dirname(file)); regular(file, expected);
  if (!sameSnapshot(fs.lstatSync(file), expected)) invalid("Full-profile source changed before read");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW), hash = createHash("sha256"), chunk = Buffer.allocUnsafe(CHUNK);
  try {
    if (!sameSnapshot(fs.fstatSync(fd), expected)) invalid("Full-profile source changed during open");
    let position = 0;
    while (position < expected.size) {
      check(guard, signal);
      const wanted = Math.min(CHUNK, expected.size - position), count = fs.readSync(fd, chunk, 0, wanted, position);
      if (!Number.isInteger(count) || count <= 0 || count > wanted) invalid("Full-profile source short read");
      const data = chunk.subarray(0, count); hash.update(data); consume?.(data, position); position += count;
      yield { bytes: count, items: 0 };
      check(guard, signal);
    }
    if (fs.readSync(fd, chunk, 0, 1, expected.size) !== 0 || !sameSnapshot(fs.fstatSync(fd), expected) || !sameSnapshot(fs.lstatSync(file), expected)) invalid("Unstable full-profile source");
    check(guard, signal); return hash.digest("hex");
  } finally { chunk.fill(0); fs.closeSync(fd); }
}
function visitFile(file: string, expected: fs.Stats, guard: FullProfileGuard, signal?: AbortSignal, consume?: (chunk: Buffer, position: number) => void): string {
  return drain(visitFileSteps(file, expected, guard, signal, consume), guard);
}
function* scanTreeSteps(directory: string, engine: BrowserEngine, guard: FullProfileGuard, signal?: AbortSignal, filterTemporary = false, hashFiles = true): Traversal<Tree> {
  check(guard, signal); ensureArchiveDirectory(directory);
  const root = fs.lstatSync(directory), all: Witness[] = [], files: ScannedFile[] = [], directories: string[] = [], names = new Set<string>();
  let bytes = 0;
  const visit = function* (current: string, parentRelative: string, omitted: boolean): Traversal<void> {
    check(guard, signal);
    const before = fs.lstatSync(current);
    if (!before.isDirectory() || before.isSymbolicLink()) invalid("Unsafe full-profile source directory");
    for (const name of fs.readdirSync(current).sort()) {
      yield { bytes: 0, items: 1 };
      check(guard, signal);
      const relative = parentRelative ? parentRelative + "/" + name : name;
      validateRelative(relative); rejectRecoveryOrQueue(relative);
      const key = folded(relative);
      if (names.has(key)) invalid("Duplicate/case-aliased full-profile path");
      names.add(key);
      if (names.size > MAX_FULL_PROFILE_ENTRIES - 3) invalid("Full-profile file/directory count limit exceeded");
      const file = path.join(current, name), stat = fs.lstatSync(file);
      // Even excluded caches/lock names must not hide links or special files.
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) invalid("Symlink or special file in full profile");
      if (stat.isFile()) regular(file, stat);
      all.push({ path: relative, stat });
      const skip = omitted || filterTemporary && temporaryPath(relative, engine);
      if (stat.isDirectory()) {
        if (!skip) directories.push(relative);
        yield* visit(file, relative, skip);
      } else if (!skip) {
        bytes += stat.size;
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) invalid("Invalid full-profile file size");
        if (stat.size > MAX_ZIP_ENTRY_BYTES) sizeLimit("entry", stat.size, MAX_ZIP_ENTRY_BYTES, relative);
        if (bytes > MAX_FULL_PROFILE_EXPANDED_BYTES) sizeLimit("expanded", bytes, MAX_FULL_PROFILE_EXPANDED_BYTES, relative);
        files.push({ path: relative, size: stat.size, sha256: hashFiles ? yield* visitFileSteps(file, stat, guard, signal) : "", stat });
      }
    }
    if (!sameSnapshot(before, fs.lstatSync(current))) invalid("Full-profile directory changed during scan");
    check(guard, signal);
  };
  yield* visit(directory, "", false);
  if (!sameSnapshot(root, fs.lstatSync(directory))) invalid("Full-profile root changed during scan");
  all.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); directories.sort();
  check(guard, signal); return { root, all, files, directories };
}
function scanTree(directory: string, engine: BrowserEngine, guard: FullProfileGuard, signal?: AbortSignal, filterTemporary = false, hashFiles = true): Tree {
  return drain(scanTreeSteps(directory, engine, guard, signal, filterTemporary, hashFiles), guard);
}
function assertTreeSnapshot(before: Tree, after: Tree, ignoreRootMetadata = false): void {
  if (!(ignoreRootMetadata ? sameIdentity(before.root, after.root) : sameSnapshot(before.root, after.root)) || before.all.length !== after.all.length ||
      before.all.some((item, index) => item.path !== after.all[index].path || !sameSnapshot(item.stat, after.all[index].stat)) ||
      before.files.length !== after.files.length || before.files.some((item, index) => item.path !== after.files[index].path || item.sha256 !== after.files[index].sha256)) invalid("Full-profile source changed during capture/apply");
}
/** Revalidate the original hash/inventory witnesses after the last observer,
 * await and guard. This metadata-only commit tail must not call user code or
 * yield: another cooperative hash would just create another stale boundary.
 * Keep the original stats (including omitted entries), never bless new ones. */
function assertTreeWitnesses(directory: string, tree: Tree): void {
  ensureArchiveDirectory(directory);
  if (!sameSnapshot(tree.root, fs.lstatSync(directory))) invalid("Full-profile source changed after verification");
  for (const item of tree.all) {
    const current = lstatOptional(path.join(directory, item.path));
    if (!current || !sameSnapshot(item.stat, current)) invalid("Full-profile source changed after verification");
  }
}
function members(tree: Tree): FullProfileMember[] { return tree.files.map(({ path: relative, size, sha256: digest }) => ({ path: relative, size, sha256: digest })); }
function sumFiles(files: readonly FullProfileMember[]): number { return files.reduce((sum, file) => sum + file.size, 0); }
function assertEngineLayout(files: readonly FullProfileMember[], directories: readonly string[], engine: BrowserEngine): void {
  const roots = new Set([...files.map((item) => item.path.split("/")[0]), ...directories.map((item) => item.split("/")[0])].map(folded));
  if (engine === "chromium" ? ["logins.json", "key4.db", "key3.db", "prefs.js", "places.sqlite"].some((name) => roots.has(name)) : roots.has("local state") || roots.has("default")) invalid("Full-profile engine/layout mismatch");
  if (engine === "firefox" && roots.has("logins.json") && !roots.has("key4.db") && !roots.has("key3.db")) invalid("Firefox saved logins have no paired key database");
}
function freezeManifest(value: FullProfileManifest): FullProfileManifest {
  value.files.forEach(Object.freeze); value.extraEntries.forEach(Object.freeze);
  Object.freeze(value.files); Object.freeze(value.directories); Object.freeze(value.extraEntries);
  return Object.freeze(value);
}
function validateManifest(value: unknown): FullProfileManifest {
  if (!object(value) || !exactKeys(value, [...IDENTITY_KEYS, "files", "directories", "extraEntries"], ["browserVersion"]) || !validIdentity(value) ||
      !Array.isArray(value.files) || !Array.isArray(value.directories) || !Array.isArray(value.extraEntries) ||
      value.files.length + value.directories.length + value.extraEntries.length + 3 > MAX_FULL_PROFILE_ENTRIES) invalid("Invalid full-profile manifest");
  const files: FullProfileMember[] = [], directories: string[] = [], extras: FullProfileMember[] = [];
  const profileNames = new Map<string, "file" | "directory">(), extraNames = new Set<string>(), extraSpellings = new Map<string, string>();
  let total = 0;
  const addName = (relative: string, kind: "file" | "directory"): void => {
    validateRelative(relative); rejectRecoveryOrQueue(relative);
    if (temporaryPath(relative, value.engine as BrowserEngine)) invalid("Temporary process/cache entry in full-profile manifest");
    const key = folded(relative); if (profileNames.has(key)) invalid("Duplicate full-profile manifest path");
    profileNames.set(key, kind);
  };
  for (const relative of value.directories) {
    if (typeof relative !== "string") invalid("Invalid full-profile manifest directory");
    addName(relative, "directory"); directories.push(relative);
  }
  const readMembers = (input: unknown[], output: FullProfileMember[], extra: boolean): void => {
    for (const member of input) {
      if (!object(member) || !exactKeys(member, ["path", "size", "sha256"]) || typeof member.path !== "string" ||
          !Number.isSafeInteger(member.size) || (member.size as number) < 0 || (member.size as number) > MAX_ZIP_ENTRY_BYTES ||
          typeof member.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(member.sha256)) invalid("Invalid full-profile manifest member");
      validateRelative(member.path);
      if (extra) {
        const key = folded(member.path); if (extraNames.has(key)) invalid("Duplicate full-profile extra path"); extraNames.add(key);
        const parts = member.path.split("/");
        for (let count = 1; count <= parts.length; count++) {
          const spelling = parts.slice(0, count).join("/"), alias = folded(spelling);
          if (extraSpellings.has(alias) && extraSpellings.get(alias) !== spelling) invalid("Case-aliased full-profile extra directory");
          extraSpellings.set(alias, spelling);
        }
      } else addName(member.path, "file");
      total += member.size as number; if (total > MAX_FULL_PROFILE_EXPANDED_BYTES) invalid("Full-profile expansion limit exceeded");
      output.push({ path: member.path, size: member.size as number, sha256: member.sha256 });
    }
  };
  readMembers(value.files, files, false); readMembers(value.extraEntries, extras, true);
  for (const relative of profileNames.keys()) {
    const parts = relative.split("/"); parts.pop();
    while (parts.length) {
      if (profileNames.get(parts.join("/")) !== "directory") invalid("Missing/conflicting full-profile manifest parent directory");
      parts.pop();
    }
  }
  for (const relative of extraNames) {
    const parts = relative.split("/"); parts.pop();
    while (parts.length) { if (extraNames.has(parts.join("/"))) invalid("Conflicting full-profile extra file/directory"); parts.pop(); }
  }
  if (canonical(directories) !== canonical([...directories].sort()) || canonical(files.map((item) => item.path)) !== canonical(files.map((item) => item.path).sort()) ||
      canonical(extras.map((item) => item.path)) !== canonical(extras.map((item) => item.path).sort())) invalid("Unsorted full-profile manifest");
  assertEngineLayout(files, directories, value.engine as BrowserEngine);
  return freezeManifest({ ...identity(value as unknown as Identity), files, directories, extraEntries: extras });
}
function jsonBytes(value: unknown): Buffer { return Buffer.from(canonical(value), "utf8"); }
function parseCanonical(bytes: Buffer, limit: number): unknown {
  if (bytes.length > limit) invalid("Full-profile metadata size limit exceeded");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (cause) { throw failure("FULL_PROFILE_INVALID", "Invalid full-profile metadata JSON", cause); }
  if (!bytes.equals(jsonBytes(value))) invalid("Noncanonical/duplicate full-profile metadata");
  return value;
}
function expectedZipNames(manifest: FullProfileManifest): Map<string, { size: number; sha256?: string }> {
  const result = new Map<string, { size: number; sha256?: string }>([["manifest.json", { size: jsonBytes(manifest).length }], ["profile/", { size: 0 }]]);
  for (const directory of manifest.directories) result.set("profile/" + directory + "/", { size: 0 });
  for (const file of manifest.files) result.set("profile/" + file.path, file);
  if (manifest.extraEntries.length) result.set("extras/", { size: 0 });
  for (const file of manifest.extraEntries) result.set("extras/" + file.path, file);
  return result;
}
function assertZipKinds(zip: Buffer, entries: ZipEntry[]): void {
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && !(zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length)) end--;
  if (end < 0) invalid("Missing full-profile ZIP directory");
  let position = zip.readUInt32LE(end + 16);
  for (const entry of entries) {
    const attributes = zip.readUInt32LE(position + 38), kind = attributes >>> 16 & 0xf000;
    if (kind !== 0 && kind !== (entry.isDirectory ? 0x4000 : 0x8000) || !entry.isDirectory && (attributes & 0x10) !== 0) invalid("Special/conflicting file type in full-profile ZIP");
    position += 46 + zip.readUInt16LE(position + 28) + zip.readUInt16LE(position + 30) + zip.readUInt16LE(position + 32);
  }
}
function inspectZip(zip: Buffer, expectedIdentity: Identity, guard: FullProfileGuard, signal?: AbortSignal, verifyPayload = false): FullProfileManifest {
  return synchronousSlice(guard, () => inspectZipInSlice(zip, expectedIdentity, guard, signal, verifyPayload));
}
function inspectZipInSlice(zip: Buffer, expectedIdentity: Identity, guard: FullProfileGuard, signal: AbortSignal | undefined, verifyPayload: boolean): FullProfileManifest {
  check(guard, signal);
  const entries = readZipEntries(zip);
  if (entries.length > MAX_FULL_PROFILE_ENTRIES) invalid("Full-profile ZIP entry limit exceeded");
  let bytes = 0;
  for (const entry of entries) {
    const relative = entry.name.replace(/^(?:profile|extras)\//, "").replace(/\/$/, "");
    if (relative) validateRelative(relative);
    bytes += entry.uncompressedSize; if (bytes > MAX_FULL_PROFILE_EXPANDED_BYTES) invalid("Full-profile ZIP expansion limit exceeded");
  }
  assertZipKinds(zip, entries);
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
  if (!manifestEntry || manifestEntry.isDirectory || manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) invalid("Missing/oversized full-profile manifest");
  const manifest = validateManifest(parseCanonical(extractZipEntry(zip, manifestEntry), MAX_MANIFEST_BYTES));
  if (canonical(identity(manifest)) !== canonical(identity(expectedIdentity))) invalid("Full-profile manifest identity/snapshot/engine mismatch");
  const expected = expectedZipNames(manifest);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry.name) || expected.get(entry.name)!.size !== entry.uncompressedSize)) invalid("Extra/missing/mismatched full-profile ZIP member");
  if (verifyPayload) for (const entry of entries) {
    check(guard, signal);
    const wanted = expected.get(entry.name)!;
    if (wanted.sha256) {
      const data = extractZipEntry(zip, entry);
      try { if (sha256(data) !== wanted.sha256) invalid("Full-profile ZIP member SHA-256 mismatch"); } finally { data.fill(0); }
    }
  }
  check(guard, signal); return manifest;
}
function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || Buffer.byteLength(passphrase, "utf8") < 12 || Buffer.byteLength(passphrase, "utf8") > 1024) invalid("Migration passphrase must be 12 to 1024 UTF-8 bytes");
}
async function deriveKey(passphrase: string, salt: Buffer, guard: FullProfileGuard, signal?: AbortSignal): Promise<Buffer> {
  validatePassphrase(passphrase);
  const input = Buffer.from(passphrase, "utf8"); let key: Buffer | undefined;
  try {
    return await guardedAwait(() => new Promise<Buffer>((resolve, reject) => {
      scrypt(input, salt, 32, SCRYPT_OPTIONS, (error, derived) => { if (error) reject(error); else { key = derived; resolve(derived); } });
    }), guard, signal);
  } catch (cause) { key?.fill(0); throw cause; }
  finally { input.fill(0); }
}
function* readOwnedFileSteps(file: string, limit: number, guard: FullProfileGuard, signal?: AbortSignal): Traversal<Buffer> {
  check(guard, signal);
  const stat = fs.lstatSync(file); regular(file, stat);
  if (stat.size > limit) sizeLimit("body", stat.size, limit);
  const bytes = Buffer.alloc(stat.size);
  let complete = false;
  try {
    yield* visitFileSteps(file, stat, guard, signal, (chunk, position) => chunk.copy(bytes, position));
    complete = true; return bytes;
  } finally { if (!complete) bytes.fill(0); }
}

/** Cold, readonly capture. The caller owns restore/runtime/config guards and the
 * stopped-profile lock. Byte integrity is not a claim of a successful login. */
export async function captureFullProfile(options: CaptureFullProfileOptions): Promise<{ body: Buffer; descriptor: FullProfileArtifact }> {
  const { profileDir, stagingDir, passphrase, guard, signal } = options;
  check(guard, signal); validatePassphrase(passphrase);
  const id: Identity = { format: FULL_PROFILE_FORMAT, dirId: options.dirId, engine: options.engine, snapshotId: options.snapshotId,
    sourcePlatform: options.sourcePlatform, ...(options.browserVersion !== undefined ? { browserVersion: options.browserVersion } : {}), createdAt: Date.now() };
  if (!validIdentity(id as unknown as Record<string, unknown>)) invalid("Invalid full-profile capture identity");
  const source = ensureArchiveDirectory(profileDir), staging = ensureArchiveDirectory(stagingDir);
  if (isPathInside(staging, source)) invalid("Full-profile staging must be outside the source profile");
  const before = await drainCooperatively(scanTreeSteps(source, id.engine, guard, signal, true), guard, signal, "scanning", options.onProgress)
    .catch(cause => { throw sizeContext(cause, options.dirId); });
  // Even an empty traversal settles asynchronously; recheck its caller's turn.
  check(guard, signal);
  const extraCopies: FullProfileExtraEntry[] = [];
  let workspace: OwnedDirectory | undefined, zip: Buffer | undefined, key: Buffer | undefined, result: { body: Buffer; descriptor: FullProfileArtifact } | undefined, error: unknown;
  try {
    if (!Array.isArray(options.extraEntries ?? [])) invalid("Invalid full-profile extra entries");
    let extraBytes = 0;
    const profileBytes = sumFiles(before.files);
    for (const extra of options.extraEntries ?? []) {
      if (!extra || typeof extra.path !== "string" || !Buffer.isBuffer(extra.data)) invalid("Invalid full-profile extra entry");
      validateRelative(extra.path); extraBytes += extra.data.length;
      if (extraBytes + profileBytes > MAX_FULL_PROFILE_BODY_BYTES) sizeLimit("body", extraBytes + profileBytes, MAX_FULL_PROFILE_BODY_BYTES);
      if (extraCopies.length >= MAX_FULL_PROFILE_ENTRIES) invalid("Full-profile extras exceed count limit");
      extraCopies.push({ path: extra.path, data: Buffer.from(extra.data) });
    }
    extraCopies.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest = validateManifest({ ...id, files: members(before), directories: before.directories,
      extraEntries: extraCopies.map((extra) => ({ path: extra.path, size: extra.data.length, sha256: sha256(extra.data) })) });
    const metadata = jsonBytes(manifest);
    if (metadata.length > MAX_MANIFEST_BYTES) invalid("Full-profile manifest size limit exceeded");
    const expected = expectedZipNames(manifest);
    const predictedZipBytes = 22 + [...expected].reduce((sum, [name, item]) => sum + 76 + 2 * Buffer.byteLength(name) + item.size, 0);
    // Reserve the maximum header before doing any plaintext disk writes.
    if (predictedZipBytes + PREFIX_BYTES + MAX_HEADER_BYTES + TAG_BYTES > MAX_FULL_PROFILE_BODY_BYTES) sizeLimit("body", predictedZipBytes + PREFIX_BYTES + MAX_HEADER_BYTES + TAG_BYTES, MAX_FULL_PROFILE_BODY_BYTES, undefined, true);
    workspace = makeWorkspace(staging, "full-profile-capture-");
    const archive = path.join(workspace.directory, "profile.zip");
    const entries: Array<ZipFileEntry | ZipDirEntry> = [{ name: "manifest.json", data: metadata }, { name: "profile/", isDirectory: true },
      ...manifest.directories.map((relative): ZipDirEntry => ({ name: "profile/" + relative + "/", isDirectory: true })),
      ...before.files.map((file): ZipFileEntry => ({ name: "profile/" + file.path, filePath: path.join(source, file.path) }))];
    if (extraCopies.length) entries.push({ name: "extras/", isDirectory: true });
    entries.push(...extraCopies.map((extra) => ({ name: "extras/" + extra.path, data: extra.data })));
    const written = await guardedAwait(() => writeZipArchive(archive, entries, {
      signal, guard: () => check(guard, signal), onProgress: options.onProgress,
    }), guard, signal);
    check(guard, signal);
    if (written.warnings?.some((warning) => warning !== "Directory fsync is unsupported on Windows; only file durability was verified.")) invalid("Full-profile ZIP publication/cleanup was not verified: " + written.warnings.join("; "));
    assertOwner(workspace);
    zip = await drainCooperatively(readOwnedFileSteps(archive, MAX_FULL_PROFILE_BODY_BYTES - PREFIX_BYTES - TAG_BYTES, guard, signal), guard, signal, "reading-archive", options.onProgress, bytes => bytes.fill(0));
    check(guard, signal);
    inspectZip(zip, id, guard, signal, true);
    const salt = randomBytes(16), iv = randomBytes(12);
    const header: Header = { ...id, cipher: "aes-256-gcm", kdf: KDF, salt: salt.toString("hex"), iv: iv.toString("hex") };
    const headerBytes = jsonBytes(header), prefix = Buffer.alloc(PREFIX_BYTES);
    if (headerBytes.length > MAX_HEADER_BYTES) invalid("Full-profile encryption header size limit exceeded");
    MAGIC.copy(prefix); prefix.writeUInt32BE(headerBytes.length, MAGIC.length);
    await enterLocalPhase("encrypting", options);
    check(guard, signal);
    key = await deriveKey(passphrase, salt, guard, signal);
    const after = await drainCooperatively(scanTreeSteps(source, id.engine, guard, signal, true), guard, signal, "verifying-source", options.onProgress);
    check(guard, signal); assertTreeSnapshot(before, after);
    // Keep the original two-scan comparison. The final metadata witness below
    // also covers mutations by the terminal encryption observer.
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.concat([prefix, headerBytes]));
    const encrypted = cipher.update(zip), final = cipher.final();
    const body = Buffer.concat([prefix, headerBytes, encrypted, final, cipher.getAuthTag()]);
    if (body.length > MAX_FULL_PROFILE_BODY_BYTES) sizeLimit("body", body.length, MAX_FULL_PROFILE_BODY_BYTES);
    const digest = sha256(body), descriptor = parseFullProfileArtifact({ ...id, key: `full-profile-v1-${digest}.bin`, sha256: digest, size: body.length })!;
    reportLocalProgress({ phase: "encrypting", bytes: zip.length, items: 1, totalBytes: zip.length, totalItems: 1 }, options);
    check(guard, signal);
    assertTreeWitnesses(source, after);
    result = { body, descriptor };
  } catch (cause) { error = sizeContext(cause, options.dirId); }
  finally {
    key?.fill(0); zip?.fill(0); extraCopies.forEach((extra) => extra.data.fill(0));
    error = finishCleanup(workspace, error);
  }
  if (error) throw error;
  return result!;
}

function assertMembers(tree: Tree, files: readonly FullProfileMember[], directories: readonly string[]): void {
  if (canonical(members(tree)) !== canonical(files) || canonical(tree.directories) !== canonical(directories)) invalid("Full-profile on-disk manifest SHA-256/size/inventory mismatch");
}
function extraDirectories(files: readonly FullProfileMember[]): string[] {
  const parents = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/"); parts.pop();
    while (parts.length) { parents.add(parts.join("/")); parts.pop(); }
  }
  return [...parents].sort();
}
function preparedValue(directory: string, extraDirectory: string | undefined, record: PreparedRecord): PreparedFullProfile {
  const prepared = Object.freeze({ directory, files: record.manifest.files.length, bytes: sumFiles(record.manifest.files), manifest: record.manifest,
    sourceManifest: record.sourceManifest, locallyDerived: record.manifest !== record.sourceManifest,
    ...(extraDirectory ? { extraDirectory } : {}) });
  preparedRecords.set(prepared, record); return prepared;
}
/** Authenticates before writing plaintext, extracts into a fresh owned 0700
 * workspace, then verifies every regular file directly from disk. */
export async function prepareFullProfile(options: PrepareFullProfileOptions): Promise<PreparedFullProfile> {
  const { guard, signal, passphrase } = options;
  check(guard, signal); validatePassphrase(passphrase);
  const descriptor = parseFullProfileArtifact(options.descriptor);
  if (!descriptor || !validId(options.dirId) || descriptor.dirId !== options.dirId || descriptor.engine !== options.engine ||
      options.snapshotId !== undefined && descriptor.snapshotId !== options.snapshotId) invalid("Full-profile descriptor identity/engine/snapshot mismatch");
  if (!Buffer.isBuffer(options.body) || options.body.length > MAX_FULL_PROFILE_BODY_BYTES || options.body.length !== descriptor.size || sha256(options.body) !== descriptor.sha256) invalid("Full-profile encrypted object digest/size mismatch");
  const body = Buffer.from(options.body);
  let key: Buffer | undefined, zip: Buffer | undefined, unauthenticated: Buffer | undefined, workspace: OwnedDirectory | undefined, prepared: PreparedFullProfile | undefined, error: unknown;
  try {
    if (!body.subarray(0, MAGIC.length).equals(MAGIC)) invalid("Invalid full-profile binary format");
    const length = body.readUInt32BE(MAGIC.length), start = PREFIX_BYTES + length;
    if (length > MAX_HEADER_BYTES || length < 2 || start + TAG_BYTES >= body.length) invalid("Invalid full-profile encryption header bounds");
    const rawHeader = parseCanonical(body.subarray(PREFIX_BYTES, start), MAX_HEADER_BYTES);
    if (!object(rawHeader) || !exactKeys(rawHeader, [...IDENTITY_KEYS, "cipher", "kdf", "salt", "iv"], ["browserVersion"]) || !validIdentity(rawHeader) ||
        rawHeader.cipher !== "aes-256-gcm" || rawHeader.kdf !== KDF || typeof rawHeader.salt !== "string" || !/^[a-f0-9]{32}$/.test(rawHeader.salt) ||
        typeof rawHeader.iv !== "string" || !/^[a-f0-9]{24}$/.test(rawHeader.iv) || canonical(identity(rawHeader as unknown as Identity)) !== canonical(identity(descriptor))) invalid("Full-profile header identity/algorithm mismatch");
    await enterLocalPhase("decrypting", options);
    check(guard, signal);
    key = await deriveKey(passphrase, Buffer.from(rawHeader.salt, "hex"), guard, signal);
    check(guard, signal);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(rawHeader.iv, "hex"));
      decipher.setAAD(body.subarray(0, start)); decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      unauthenticated = decipher.update(body.subarray(start, body.length - TAG_BYTES));
      const final = decipher.final(); zip = Buffer.concat([unauthenticated, final]);
    } catch (cause) { throw failure("FULL_PROFILE_DECRYPTION_FAILED", "Unable to decrypt full-profile artifact (wrong passphrase or damaged object)", cause); }
    finally { unauthenticated?.fill(0); unauthenticated = undefined; key.fill(0); key = undefined; }
    reportLocalProgress({ phase: "decrypting", bytes: zip.length, items: 1, totalBytes: zip.length, totalItems: 1 }, options);
    await enterLocalPhase("extracting", options);
    check(guard, signal);
    const manifest = inspectZip(zip, descriptor, guard, signal);
    workspace = makeWorkspace(options.stagingDir, "full-profile-prepare-");
    const archive = path.join(workspace.directory, "profile.zip");
    const fd = fs.openSync(archive, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, zip); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    check(guard, signal);
    const extracted = extractZipArchive(archive, path.join(workspace.directory, "contents"), {
      maxTotalBytes: MAX_FULL_PROFILE_EXPANDED_BYTES, maxEntryBytes: MAX_ZIP_ENTRY_BYTES,
      skipNames: () => { check(guard, signal); return false; },
    });
    reportLocalProgress({ phase: "extracting", bytes: extracted.bytes, items: extracted.files, totalBytes: extracted.bytes, totalItems: extracted.files }, options);
    check(guard, signal); assertOwner(workspace);
    const directory = path.join(workspace.directory, "contents", "profile");
    const tree = await drainCooperatively(scanTreeSteps(directory, descriptor.engine, guard, signal), guard, signal, "verifying-profile", options.onProgress);
    check(guard, signal);
    assertMembers(tree, manifest.files, manifest.directories);
    const extraDirectory = manifest.extraEntries.length ? path.join(workspace.directory, "contents", "extras") : undefined;
    let extraTree: Tree | undefined;
    if (extraDirectory) {
      extraTree = await drainCooperatively(scanTreeSteps(extraDirectory, descriptor.engine, guard, signal), guard, signal, "verifying-extras", options.onProgress);
      check(guard, signal);
      assertMembers(extraTree, manifest.extraEntries, extraDirectories(manifest.extraEntries));
    }
    // Neither of these transport files is part of prepared.directory.
    fs.unlinkSync(archive); fs.unlinkSync(path.join(workspace.directory, "contents", "manifest.json"));
    check(guard, signal); assertOwner(workspace);
    // Revisit BOTH trees after the last phase: an extras observer/await can also
    // mutate the already-verified profile. No observer or yield after this tail.
    assertTreeWitnesses(directory, tree);
    if (extraDirectory && extraTree) assertTreeWitnesses(extraDirectory, extraTree);
    prepared = preparedValue(directory, extraDirectory, { workspace, profileOwner: tree.root, extraOwner: extraTree?.root, manifest, sourceManifest: manifest });
  } catch (cause) { error = sizeContext(cause, options.dirId); }
  finally {
    key?.fill(0); zip?.fill(0); unauthenticated?.fill(0); body.fill(0);
    if (!prepared) error = finishCleanup(workspace, error);
  }
  if (error) throw error;
  return prepared!;
}
function preparedRecord(prepared: PreparedFullProfile, guard: FullProfileGuard): PreparedRecord {
  check(guard);
  const record = preparedRecords.get(prepared);
  if (!record) invalid("Unknown/consumed full-profile preparation");
  assertOwner(record.workspace);
  ensureArchiveDirectory(prepared.directory);
  if (!sameIdentity(fs.lstatSync(prepared.directory), record.profileOwner)) invalid("Full-profile prepared directory ownership changed");
  if (prepared.extraDirectory) {
    ensureArchiveDirectory(prepared.extraDirectory);
    if (!record.extraOwner || !sameIdentity(fs.lstatSync(prepared.extraDirectory), record.extraOwner)) invalid("Full-profile capsule directory ownership changed");
    assertMembers(scanTree(prepared.extraDirectory, record.manifest.engine, guard), record.manifest.extraEntries, extraDirectories(record.manifest.extraEntries));
  }
  check(guard); return record;
}
/** Explicit trust boundary for the coordinator's local password conversion.
 * Only named files may change; all other bytes, directories and capsules must
 * still match the authenticated source. Returns a NEW, locally sealed token. */
export function resealPreparedFullProfile(options: { prepared: PreparedFullProfile; changedPaths: readonly string[]; guard: FullProfileGuard }): PreparedFullProfile {
  const { prepared, guard } = options, record = preparedRecord(prepared, guard);
  if (!Array.isArray(options.changedPaths) || options.changedPaths.length > MAX_FULL_PROFILE_ENTRIES) invalid("Invalid full-profile conversion path list");
  const allowed = new Set<string>();
  for (const relative of options.changedPaths) {
    if (typeof relative !== "string") invalid("Invalid full-profile conversion path");
    validateRelative(relative); rejectRecoveryOrQueue(relative);
    if (allowed.has(folded(relative))) invalid("Duplicate full-profile conversion path");
    allowed.add(folded(relative));
  }
  const tree = scanTree(prepared.directory, record.manifest.engine, guard);
  if (canonical(tree.directories) !== canonical(record.manifest.directories)) invalid("Password conversion changed full-profile directories");
  const oldFiles = new Map(record.manifest.files.map((file) => [file.path, file])), newFiles = new Map(members(tree).map((file) => [file.path, file]));
  for (const relative of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    if (!oldFiles.has(relative)) invalid("Password conversion added an unowned full-profile file");
    if (!allowed.has(folded(relative)) && canonical(oldFiles.get(relative) ?? null) !== canonical(newFiles.get(relative) ?? null)) invalid("Unapproved full-profile file changed during password conversion");
  }
  const manifest = validateManifest({ ...record.manifest, files: members(tree) });
  check(guard);
  const result = preparedValue(prepared.directory, prepared.extraDirectory, { ...record, profileOwner: tree.root, manifest });
  preparedRecords.delete(prepared); return result;
}
function writeChunk(fd: number, data: Buffer, position: number): void {
  let offset = 0;
  while (offset < data.length) {
    const count = fs.writeSync(fd, data, offset, data.length - offset, position + offset);
    if (!Number.isInteger(count) || count <= 0 || count > data.length - offset) invalid("Full-profile copy made no progress");
    offset += count;
  }
}
function copyPrepared(prepared: PreparedFullProfile, tree: Tree, stage: OwnedDirectory, guard: FullProfileGuard): void {
  assertOwner(stage);
  for (const relative of prepared.manifest.directories) { check(guard); ensureArchiveDirectory(path.join(stage.directory, relative), true); check(guard); }
  for (const file of tree.files) {
    check(guard); assertOwner(stage);
    const target = path.join(stage.directory, file.path);
    ensureArchiveDirectory(path.dirname(target));
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try {
      const digest = visitFile(path.join(prepared.directory, file.path), file.stat, guard, undefined, (chunk, position) => writeChunk(fd, chunk, position));
      if (digest !== file.sha256) invalid("Full-profile prepared bytes changed during copy");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (visitFile(target, fs.lstatSync(target), guard) !== file.sha256) invalid("Full-profile installed staging readback mismatch");
    check(guard);
  }
  assertMembers(scanTree(stage.directory, prepared.manifest.engine, guard), prepared.manifest.files, prepared.manifest.directories);
  assertTreeSnapshot(tree, scanTree(prepared.directory, prepared.manifest.engine, guard));
}

/** Same-parent cold directory replacement. No cross-device rename fallback,
 * deletion of the old profile, or best-effort partial restore is permitted. */
export function restorePreparedFullProfile(options: { prepared: PreparedFullProfile; profileDir: string; backupSuffix: string; guard: FullProfileGuard }): RestoredFullProfile {
  const { prepared, guard } = options, record = preparedRecord(prepared, guard);
  const profileDir = path.resolve(options.profileDir), parent = ensureArchiveDirectory(path.dirname(profileDir)), base = path.basename(profileDir);
  validateZipEntryName(base);
  if (profileDir === parent || !/^[._-][A-Za-z0-9._-]{0,127}$/.test(options.backupSuffix)) invalid("Unsafe full-profile restore path/backup suffix");
  if (isPathInside(profileDir, record.workspace.directory) || isPathInside(record.workspace.directory, profileDir)) invalid("Full-profile restore and prepared paths overlap");
  const backupDir = profileDir + options.backupSuffix, stagePrefix = `.${base}.full-profile-stage-`;
  validateZipEntryName(path.basename(backupDir));
  if (lstatOptional(backupDir)) invalid("Full-profile backup destination already exists; refusing overwrite");
  if (fs.readdirSync(parent).some((name) => folded(name).startsWith(folded(stagePrefix)))) throw recovery("An earlier full-profile restore staging directory exists", [parent]);
  check(guard);
  const incoming = scanTree(prepared.directory, record.manifest.engine, guard);
  assertMembers(incoming, record.manifest.files, record.manifest.directories);
  const previousStat = lstatOptional(profileDir), parentOwner = fs.lstatSync(parent);
  if (previousStat && (!previousStat.isDirectory() || previousStat.isSymbolicLink() || previousStat.dev !== parentOwner.dev)) invalid("Unsafe/cross-device full-profile restore target");
  const previous = previousStat ? scanTree(profileDir, record.manifest.engine, guard, undefined, true, false) : undefined;
  const stage = makeWorkspace(parent, stagePrefix);
  if (stage.owner.dev !== parentOwner.dev) throw recovery("Full-profile staging is not on the target volume", [stage.directory]);
  let movedOld = false, installed = false, committedOwner: fs.Stats | undefined, backupOwner: fs.Stats | undefined;
  let guardChanged = false, rolledBack = false;
  const warnings: string[] = [];
  const syncParent = (): void => {
    if (!syncArchiveDirectory(parent) && !warnings.length) warnings.push("Directory fsync is unsupported on Windows; file durability was verified, directory durability is not guaranteed.");
  };
  const guarded: FullProfileGuard = (): void => {
    try { check(guard); } catch (cause) { guardChanged = true; throw cause; }
  };
  if (guard.runSynchronous !== undefined) {
    guarded.runSynchronous = <T>(action: () => T): T => {
      let actionFailed = false;
      try {
        return synchronousSlice(guard, () => {
          try { return action(); } catch (cause) { actionFailed = true; throw cause; }
        });
      } catch (cause) {
        // Executor admission/exit can lose its lease independently of check().
        // A file I/O error inside the action must still permit safe rollback.
        if (!actionFailed) guardChanged = true;
        throw cause;
      }
    };
  }
  const assertParent = (): void => {
    ensureArchiveDirectory(parent);
    if (!sameIdentity(fs.lstatSync(parent), parentOwner)) invalid("Full-profile restore parent changed");
  };
  const assertAbsent = (directory: string): void => { if (lstatOptional(directory)) invalid("Unknown full-profile destination appeared; refusing overwrite"); };
  const assertBackup = (): void => {
    if (!previous || !backupOwner || !sameIdentity(fs.lstatSync(backupDir), backupOwner)) invalid("Full-profile backup ownership changed");
    assertTreeSnapshot(previous, scanTree(backupDir, record.manifest.engine, guarded, undefined, true, false), true);
  };
  const undo = (): void => {
    guarded(); assertParent();
    if (movedOld) assertBackup();
    if (installed) {
      const live = fs.lstatSync(profileDir);
      if (!committedOwner || live.isSymbolicLink() || !live.isDirectory() || !sameIdentity(live, committedOwner)) invalid("Full-profile live target ownership changed; refusing rollback");
      assertAbsent(stage.directory); guarded(); assertParent(); assertAbsent(stage.directory);
      fs.renameSync(profileDir, stage.directory); installed = false; guarded();
    }
    if (movedOld) {
      assertAbsent(profileDir); guarded(); assertParent(); assertAbsent(profileDir); assertBackup();
      fs.renameSync(backupDir, profileDir); movedOld = false; guarded();
    }
    syncParent(); rolledBack = true;
  };
  try {
    copyPrepared(prepared, incoming, stage, guarded);
    for (const directory of [...prepared.manifest.directories].sort((a, b) => b.length - a.length)) syncArchiveDirectory(path.join(stage.directory, directory));
    syncArchiveDirectory(stage.directory);
    syncParent(); guarded(); assertParent(); assertOwner(stage);
    if (previous) {
      assertTreeSnapshot(previous, scanTree(profileDir, record.manifest.engine, guarded, undefined, true, false));
      guarded(); assertParent(); assertAbsent(backupDir);
      fs.renameSync(profileDir, backupDir); movedOld = true; backupOwner = fs.lstatSync(backupDir); guarded();
    } else assertAbsent(profileDir);
    guarded(); assertParent(); assertAbsent(profileDir); assertOwner(stage);
    fs.renameSync(stage.directory, profileDir); installed = true; committedOwner = fs.lstatSync(profileDir); guarded();
    assertMembers(scanTree(profileDir, record.manifest.engine, guarded), record.manifest.files, record.manifest.directories);
    syncParent(); guarded();
  } catch (cause) {
    // A changed runtime/config guard means no further live-directory mutations.
    try { guarded(); } catch (guardFailure) { if (guardFailure !== cause) cause = combine(cause, guardFailure, "restore guard failed"); }
    if (guardChanged) throw recovery("Full-profile restore guard changed; automatic rollback is unsafe", [profileDir, backupDir, stage.directory], cause);
    let error: unknown = cause;
    if (movedOld || installed) {
      try { undo(); } catch (rollbackFailure) { throw recovery("Full-profile restore rollback failed", [profileDir, backupDir, stage.directory], combine(error, rollbackFailure, "rollback failed")); }
    }
    error = finishCleanup(stage, error);
    throw error;
  }
  const retainedRollbackDir = profileDir + ".full-profile-rollback-" + randomBytes(12).toString("hex");
  const result: RestoredFullProfile = { files: prepared.files, bytes: prepared.bytes, ...(previous ? { backupDir } : {}),
    ...(warnings.length ? { warnings } : {}), rollback: () => {
      if (rolledBack && result.rollbackDir) { guarded(); return; }
      try {
        if (!rolledBack) undo();
        // A verified rollback is retained, but is no longer an unfinished stage
        // that would prevent the next complete restore from being attempted.
        guarded(); assertParent(); assertOwner(stage); assertAbsent(retainedRollbackDir);
        fs.renameSync(stage.directory, retainedRollbackDir); guarded();
        assertMembers(scanTree(retainedRollbackDir, record.manifest.engine, guarded), record.manifest.files, record.manifest.directories);
        syncParent(); guarded(); result.rollbackDir = retainedRollbackDir;
      } catch (cause) { throw recovery("Full-profile rollback requires manual resolution", [profileDir, backupDir, stage.directory, retainedRollbackDir], cause); }
    } };
  return result;
}
