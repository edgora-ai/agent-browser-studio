// Dependency-free classic ZIP (UTF-8, store writer; store/deflate reader).
// Publication is staged, fsynced and verified from disk before the final name
// is acquired. Payload I/O and store-method verification use 64 KiB buffers.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import * as zlib from "node:zlib";

export const MAX_ZIP_ENTRIES = 20000;
export const MAX_ZIP_ENTRY_BYTES = 512 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
// Bound names/extra fields/comments as well as payloads. This is not ZIP64.
const MAX_ZIP_METADATA_BYTES = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;
const WRITE_BATCH_BYTES = 4 * 1024 * 1024;
const WRITE_BATCH_MS = 16;
const WRITE_BATCH_ITEMS = 128;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const TEMP_ROOTS = [path.resolve(os.tmpdir()), fs.realpathSync(os.tmpdir())];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32Update(crcState: number, buf: Buffer): number {
  let c = crcState;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}
export function crc32(buf: Buffer): number { return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0; }

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}
export interface ZipFileEntry { name: string; filePath?: string; data?: Buffer; }
export interface ZipDirEntry { name: string; isDirectory: true; }
export interface WriteZipProgress {
  phase: "packing";
  /** Cumulative payload bytes processed by CRC prepass, copy and readback (not network/archive size). */
  bytes: number;
  /** Entries copied to staging; this does not mean verification/publication has completed. */
  items: number;
  totalBytes?: number;
  totalItems?: number;
}
export interface WriteZipOptions {
  /** Only a caller with explicit replacement confirmation may opt in. */
  overwrite?: boolean;
  signal?: AbortSignal;
  /** Synchronous, fresh admission check at batch/await/callback and publication boundaries. */
  guard?: () => void;
  /** Synchronous local-work observer, never called after publication. */
  onProgress?: (progress: WriteZipProgress) => void;
}
export interface WriteZipResult { entries: number; bytes: number; warnings?: string[]; }
export interface ZipEntry {
  name: string; isDirectory: boolean; method: number; crc: number;
  compressedSize: number; uncompressedSize: number; localHeaderOffset: number;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
function checkWriteSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(codedError("ABORT_ERR", "ZIP writing aborted"), { name: "AbortError", cause: signal.reason });
}
function rejectAsyncCallback(result: unknown, name: string): void {
  if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === "function") {
    // Observe rejection, but never treat an unresolved guard/observer as admitted.
    void Promise.resolve(result).catch(() => undefined);
    throw new Error(`ZIP ${name} must be synchronous`);
  }
}
function checkWriteGuard(options: WriteZipOptions): void {
  checkWriteSignal(options.signal);
  if (options.guard !== undefined) {
    if (typeof options.guard !== "function") throw new Error("ZIP guard must be synchronous");
    rejectAsyncCallback(options.guard(), "guard");
  }
  checkWriteSignal(options.signal);
}
interface WriteCheckpoint { bytes: number; items: number; packed?: number; boundary?: boolean; }
type WriteSteps<T> = Generator<WriteCheckpoint, T, void>;
const ITEM_CHECKPOINT: WriteCheckpoint = { bytes: 0, items: 1 };
function drainSteps<T>(steps: WriteSteps<T>): T {
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
async function writeCooperatively(steps: WriteSteps<WriteZipResult>, options: WriteZipOptions, totalItems: number): Promise<WriteZipResult> {
  let bytes = 0, items = 0;
  try {
    if (options.onProgress !== undefined && typeof options.onProgress !== "function") throw new Error("ZIP progress callback must be synchronous");
    for (;;) {
      // There is no process cache here: one fresh admission covers only this
      // synchronous batch. Expensive admission is outside the payload budget.
      checkWriteGuard(options);
      const started = Date.now();
      let batchBytes = 0, batchCheckpoints = 0;
      for (;;) {
        checkWriteSignal(options.signal);
        const step = steps.next();
        // The last iterator step acquires the final name synchronously. Never
        // report progress/cancellation after that point, even if it aborted there.
        if (step.done) return step.value;
        bytes += step.value.bytes; items += step.value.packed ?? 0;
        batchBytes += step.value.bytes; batchCheckpoints++;
        // Reserve a full next read, including when the previous file ended in a
        // partial chunk. Exactly aligned batches still admit all 64 chunks.
        // Count zero-byte metadata and short-I/O checkpoints, not only entries.
        if (step.value.boundary || batchBytes > WRITE_BATCH_BYTES - CHUNK ||
            batchCheckpoints >= WRITE_BATCH_ITEMS || Date.now() - started >= WRITE_BATCH_MS) break;
      }
      if (options.onProgress) rejectAsyncCallback(options.onProgress({ phase: "packing", bytes, items, totalItems }), "progress callback");
      checkWriteGuard(options); // Also covers synchronous observer side effects.
      // Keep the existing global scheduler: ZIP callers include restricted VMs
      // that expose setImmediate but intentionally deny new module dependencies.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    // Inject failure into the suspended operation: its nested finally blocks
    // close every fd and check/remove staging before this promise can reject.
    steps.throw(error);
    throw error;
  } finally { steps.return(undefined as never); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function combinedError(original: unknown, cleanup: unknown): Error {
  const result = new Error(`${message(original)}; archive cleanup failed: ${message(cleanup)}`, { cause: original });
  if ((original as NodeJS.ErrnoException)?.code) Object.assign(result, { code: (original as NodeJS.ErrnoException).code });
  return result;
}
export function isPathInside(childPath: string, basePath: string): boolean {
  const rel = path.relative(basePath, childPath);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** Do not follow planted directory links. Only the OS-provided temporary root
 * (and its canonical spelling) is an anchor, allowing macOS /var -> /private/var
 * without treating user-created links BELOW that root as platform aliases. */
export function ensureArchiveDirectory(directory: string, create = false): string {
  const resolved = path.resolve(directory);
  const anchor = TEMP_ROOTS.find((root) => isPathInside(resolved, root)) || path.parse(resolved).root;
  let current = anchor;
  const visit = (): void => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink directory: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Archive path is not a directory: ${current}`);
  };
  visit();
  for (const part of path.relative(anchor, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); visit();
  }
  return resolved;
}

/** Same precise unsupported case as run-result-store/agent-run-export. File
 * fsync is never optional, nor are open/EACCES/EIO/ENOSPC directory failures. */
export function syncArchiveDirectory(directory: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | NOFOLLOW);
    fs.fsyncSync(fd);
    return true;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (fd === null || process.platform !== "win32" || failure.code !== "EPERM" || failure.syscall !== "fsync") throw error;
    return false; // Unsupported directory durability, not a successful fsync.
  } finally { if (fd !== null) fs.closeSync(fd); }
}

function sameIdentity(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameSnapshot(a: fs.Stats, b: fs.Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function regularFile(file: string): fs.Stats {
  ensureArchiveDirectory(path.dirname(path.resolve(file)));
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Archive source must be a regular file, not a symlink: ${file}`);
  return stat;
}
function openRegularFile(file: string, expected = regularFile(file)): number {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const actual = fs.fstatSync(fd);
    if (!actual.isFile() || !sameSnapshot(actual, expected)) throw new Error(`Archive source changed: ${file}`);
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function assertSourceUnchanged(file: string, expected: fs.Stats, fd?: number): void {
  const stat = regularFile(file);
  if (!sameSnapshot(stat, expected) || (fd !== undefined && !sameSnapshot(fs.fstatSync(fd), expected))) {
    throw new Error(`Archive source changed: ${file}`);
  }
}
function writeAll(fd: number, data: Buffer, position: number): void {
  let offset = 0;
  while (offset < data.length) {
    const wanted = Math.min(CHUNK, data.length - offset);
    const written = fs.writeSync(fd, data, offset, wanted, position + offset);
    if (!Number.isInteger(written) || written <= 0 || written > wanted) throw new Error("ZIP write made no valid progress");
    offset += written;
  }
}
function* readExactSteps(fd: number, length: number, position: number, signal?: AbortSignal): WriteSteps<Buffer> {
  const data = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    checkWriteSignal(signal);
    const wanted = Math.min(CHUNK, length - offset);
    const n = fs.readSync(fd, data, offset, wanted, position + offset);
    if (!Number.isInteger(n) || n <= 0 || n > wanted) throw new Error("Unexpected EOF/short read in ZIP archive");
    offset += n;
    // Metadata reads are timed work, but not payload-processing progress.
    yield { bytes: 0, items: 0 };
  }
  return data;
}
function readSourceChunk(fd: number, buffer: Buffer, position: number, size: number, signal?: AbortSignal): number {
  checkWriteSignal(signal);
  const wanted = Math.min(buffer.length, size - position);
  const n = fs.readSync(fd, buffer, 0, wanted, position);
  if (!Number.isInteger(n) || n <= 0 || n > wanted) throw new Error("Archive source short read or size changed");
  return n;
}
function assertSourceEnd(fd: number, size: number, signal?: AbortSignal): void {
  checkWriteSignal(signal);
  if (fs.readSync(fd, Buffer.allocUnsafe(1), 0, 1, size) !== 0) throw new Error("Archive source size changed");
}
function fileCRC(fd: number, size: number): number {
  const chunk = Buffer.allocUnsafe(CHUNK);
  let state = 0xffffffff, position = 0;
  while (position < size) {
    const n = readSourceChunk(fd, chunk, position, size);
    state = crc32Update(state, chunk.subarray(0, n)); position += n;
  }
  assertSourceEnd(fd, size);
  return (state ^ 0xffffffff) >>> 0;
}

function* fileCRCSteps(fd: number, size: number, signal?: AbortSignal): WriteSteps<number> {
  const chunk = Buffer.allocUnsafe(CHUNK);
  let state = 0xffffffff, position = 0;
  while (position < size) {
    const n = readSourceChunk(fd, chunk, position, size, signal);
    state = crc32Update(state, chunk.subarray(0, n)); position += n;
    yield { bytes: n, items: 0 };
  }
  assertSourceEnd(fd, size, signal);
  return (state ^ 0xffffffff) >>> 0;
}
function* bufferCRCSteps(data: Buffer, signal?: AbortSignal): WriteSteps<number> {
  let state = 0xffffffff;
  for (let position = 0; position < data.length; position += CHUNK) {
    checkWriteSignal(signal);
    const chunk = data.subarray(position, Math.min(position + CHUNK, data.length));
    state = crc32Update(state, chunk);
    yield { bytes: chunk.length, items: 0 };
  }
  return (state ^ 0xffffffff) >>> 0;
}

export function validateZipEntryName(name: string): void {
  if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/") ||
      /[\x00-\x1f<>:"|?*]/.test(name) || Buffer.byteLength(name, "utf8") > 0xffff) {
    throw new Error("Unsafe ZIP entry name: " + JSON.stringify(name));
  }
  const parts = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  for (const part of parts) {
    // Also reject Windows aliases/streams, even on another host. Never let a
    // transferred ZIP acquire a different path meaning on the destination OS.
    if (!part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error("Unsafe ZIP entry name: " + JSON.stringify(name));
    }
  }
}
function* entryNameSteps(entries: Array<{ name: string; isDirectory?: boolean }>): WriteSteps<void> {
  const explicit = new Set<string>(), files = new Set<string>(), directories = new Set<string>();
  let nameBytes = 0;
  for (const entry of entries) {
    const directory = entry.isDirectory === true;
    validateZipEntryName(entry.name);
    if (directory !== entry.name.endsWith("/")) throw new Error("Conflicting ZIP directory name: " + entry.name);
    nameBytes += Buffer.byteLength(entry.name, "utf8");
    if (nameBytes > MAX_ZIP_METADATA_BYTES) throw new Error("ZIP metadata size limit exceeded");
    const key = entry.name.replace(/\/$/, "").normalize("NFC").toLowerCase();
    if (explicit.has(key) || (directory ? files.has(key) : directories.has(key))) throw new Error("Duplicate/conflicting ZIP entry: " + entry.name);
    explicit.add(key);
    if (directory) directories.add(key); else files.add(key);
    const parents = key.split("/");
    parents.pop();
    while (parents.length) {
      const parent = parents.join("/");
      if (files.has(parent)) throw new Error("Conflicting ZIP file/directory entries: " + entry.name);
      directories.add(parent); parents.pop();
      yield { bytes: 0, items: 0 };
    }
    yield ITEM_CHECKPOINT;
  }
}
interface ZipSource {
  size: number;
  read(position: number, length: number): Buffer;
  readSteps?(position: number, length: number): WriteSteps<Buffer>;
}
function* sourceReadSteps(source: ZipSource, position: number, length: number): WriteSteps<Buffer> {
  return source.readSteps ? yield* source.readSteps(position, length) : source.read(position, length);
}
function bufferSource(zip: Buffer): ZipSource {
  return { size: zip.length, read: (position, length) => {
    if (!Number.isSafeInteger(position) || position < 0 || length < 0 || position + length > zip.length) throw new Error("ZIP entry exceeds archive bounds");
    return zip.subarray(position, position + length);
  } };
}
function fileSource(fd: number, signal?: AbortSignal): ZipSource {
  const size = fs.fstatSync(fd).size;
  function* readSteps(position: number, length: number): WriteSteps<Buffer> {
    if (!Number.isSafeInteger(position) || position < 0 || length < 0 || position + length > size) throw new Error("ZIP entry exceeds archive bounds");
    return yield* readExactSteps(fd, length, position, signal);
  }
  return { size, readSteps, read: (position, length) => drainSteps(readSteps(position, length)) };
}
function* entryDataOffsetSteps(source: ZipSource, entry: ZipEntry, centralOffset = source.size, expectedFlags?: number): WriteSteps<number> {
  const local = yield* sourceReadSteps(source, entry.localHeaderOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP local header");
  const flags = local.readUInt16LE(6), method = local.readUInt16LE(8);
  const nameLen = local.readUInt16LE(26), extraLen = local.readUInt16LE(28);
  const start = entry.localHeaderOffset + 30 + nameLen + extraLen;
  if (start + entry.compressedSize > centralOffset) throw new Error("ZIP entry exceeds archive bounds");
  const name = (yield* sourceReadSteps(source, entry.localHeaderOffset + 30, nameLen)).toString("utf8");
  if (name !== entry.name || method !== entry.method || (flags & 0x41) || (expectedFlags !== undefined && flags !== expectedFlags)) {
    throw new Error("ZIP local/central header name, method or flags mismatch");
  }
  for (const [offset, value] of [[14, entry.crc], [18, entry.compressedSize], [22, entry.uncompressedSize]]) {
    const localValue = local.readUInt32LE(offset);
    if (localValue !== value && (!(flags & 8) || localValue !== 0)) throw new Error("ZIP local/central header size or CRC mismatch");
  }
  return start;
}
function entryDataOffset(source: ZipSource, entry: ZipEntry): number { return drainSteps(entryDataOffsetSteps(source, entry)); }
function* parseEntrySteps(source: ZipSource): WriteSteps<ZipEntry[]> {
  if (source.size < 22) throw new Error("ZIP end-of-central-directory not found");
  const tailOffset = Math.max(0, source.size - 65557);
  const tail = yield* sourceReadSteps(source, tailOffset, source.size - tailOffset);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) throw new Error("ZIP end-of-central-directory not found");
  const count = tail.readUInt16LE(end + 10), cdSize = tail.readUInt32LE(end + 12), cdOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (count > MAX_ZIP_ENTRIES) throw new Error(`ZIP entry count too large: ${count} (max ${MAX_ZIP_ENTRIES})`);
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count) throw new Error("Multi-disk ZIP archives are not supported");
  if (cdSize > MAX_ZIP_METADATA_BYTES || cdOffset + cdSize !== tailOffset + end) throw new Error("Invalid ZIP central directory bounds/size limit");
  const entries: ZipEntry[] = [], spans: Array<{ start: number; end: number }> = [];
  let p = cdOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize) throw new Error("Invalid ZIP central directory entry");
    const c = yield* sourceReadSteps(source, p, 46);
    if (c.readUInt32LE(0) !== 0x02014b50) throw new Error("Invalid ZIP central directory entry");
    const nameLen = c.readUInt16LE(28), extraLen = c.readUInt16LE(30), commentLen = c.readUInt16LE(32);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize || c.readUInt16LE(34) || (c.readUInt16LE(8) & 0x41)) throw new Error("Invalid/encrypted ZIP central directory entry");
    const name = (yield* sourceReadSteps(source, p + 46, nameLen)).toString("utf8");
    const entry: ZipEntry = {
      name, isDirectory: name.endsWith("/"), method: c.readUInt16LE(10), crc: c.readUInt32LE(16),
      compressedSize: c.readUInt32LE(20), uncompressedSize: c.readUInt32LE(24), localHeaderOffset: c.readUInt32LE(42),
    };
    if ((c.readUInt32LE(38) >>> 16 & 0xf000) === 0xa000) throw new Error("Refusing symlink ZIP entry: " + name);
    if (entry.method !== 0 && entry.method !== 8) throw new Error("Unsupported ZIP compression method: " + entry.method);
    if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES || entry.compressedSize > MAX_ZIP_ENTRY_BYTES * 2) throw new Error("ZIP entry too large: " + name);
    if ((entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) || (entry.isDirectory && (entry.uncompressedSize !== 0 || entry.crc !== 0))) throw new Error("ZIP entry size/CRC mismatch: " + name);
    total += entry.uncompressedSize;
    if (total > MAX_ZIP_TOTAL_BYTES) throw new Error("Archive exceeds size limit (" + MAX_ZIP_TOTAL_BYTES + " bytes)");
    const dataOffset = yield* entryDataOffsetSteps(source, entry, cdOffset, c.readUInt16LE(8));
    spans.push({ start: entry.localHeaderOffset, end: dataOffset + entry.compressedSize });
    entries.push(entry); p = next;
    yield ITEM_CHECKPOINT;
  }
  if (p !== cdOffset + cdSize) throw new Error("Invalid ZIP central directory size/count mismatch");
  yield* entryNameSteps(entries);
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) throw new Error("Overlapping ZIP entry data");
    yield ITEM_CHECKPOINT;
  }
  return entries;
}
function parseEntries(source: ZipSource): ZipEntry[] { return drainSteps(parseEntrySteps(source)); }
export function readZipEntries(zip: Buffer): ZipEntry[] { return parseEntries(bufferSource(zip)); }

function readContent(source: ZipSource, entry: ZipEntry): Buffer {
  const start = entryDataOffset(source, entry);
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES || entry.compressedSize > MAX_ZIP_ENTRY_BYTES * 2) throw new Error("ZIP entry too large: " + entry.name);
  const raw = source.read(start, entry.compressedSize);
  const content = entry.method === 0 ? Buffer.from(raw) : entry.method === 8
    ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(MAX_ZIP_ENTRY_BYTES, entry.uncompressedSize)) })
    : (() => { throw new Error("Unsupported ZIP compression method: " + entry.method); })();
  if (content.length !== entry.uncompressedSize) throw new Error("ZIP entry size mismatch");
  if (crc32(content) !== entry.crc) throw new Error("ZIP entry CRC mismatch");
  return content;
}
export function extractZipEntry(zip: Buffer, entry: ZipEntry): Buffer { return readContent(bufferSource(zip), entry); }

function visitStoredContent(source: ZipSource, entry: ZipEntry, consume: (chunk: Buffer, position: number) => void): void {
  if (entry.method !== 0 || entry.compressedSize !== entry.uncompressedSize) throw new Error("ZIP store entry size/method mismatch");
  const start = entryDataOffset(source, entry);
  let state = 0xffffffff;
  for (let position = 0; position < entry.uncompressedSize; position += CHUNK) {
    const chunk = source.read(start + position, Math.min(CHUNK, entry.uncompressedSize - position));
    state = crc32Update(state, chunk); consume(chunk, position);
  }
  if (((state ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error("ZIP entry CRC mismatch");
}
function* verifyWrittenArchiveSteps(file: string, expected: ZipEntry[], size: number, written: fs.Stats, signal?: AbortSignal): WriteSteps<fs.Stats> {
  checkWriteSignal(signal);
  const before = regularFile(file);
  if (!sameSnapshot(before, written)) throw new Error("ZIP staging file changed before verification");
  const fd = openRegularFile(file, before);
  try {
    if (before.size !== size) throw new Error("ZIP verification size mismatch");
    const source = fileSource(fd, signal), entries = yield* parseEntrySteps(source);
    if (entries.length !== expected.length) throw new Error("ZIP verification entry count mismatch");
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i], wanted = expected[i];
      checkWriteSignal(signal);
      if (Object.keys(wanted).some((key) => entry[key as keyof ZipEntry] !== wanted[key as keyof ZipEntry])) throw new Error("ZIP verification entry/header mismatch");
      if (entry.method !== 0 || entry.compressedSize !== entry.uncompressedSize) throw new Error("ZIP store entry size/method mismatch");
      const start = yield* entryDataOffsetSteps(source, entry);
      let state = 0xffffffff, position = 0;
      while (position < entry.uncompressedSize) {
        checkWriteSignal(signal);
        const wantedBytes = Math.min(CHUNK, entry.uncompressedSize - position);
        const n = fs.readSync(fd, chunk, 0, wantedBytes, start + position);
        if (!Number.isInteger(n) || n <= 0 || n > wantedBytes) throw new Error("Unexpected EOF/short read in ZIP archive");
        state = crc32Update(state, chunk.subarray(0, n)); position += n;
        yield { bytes: n, items: 0 };
      }
      if (((state ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error("ZIP entry CRC mismatch");
      yield ITEM_CHECKPOINT;
    }
    assertSourceUnchanged(file, before, fd);
    return before;
  } finally { fs.closeSync(fd); }
}
function verifyExtractedFile(file: string, entry: ZipEntry, written: fs.Stats): void {
  const fd = openRegularFile(file, written);
  try {
    if (written.size !== entry.uncompressedSize || fileCRC(fd, entry.uncompressedSize) !== entry.crc) {
      throw new Error("Extracted ZIP entry readback size/CRC verification failed: " + entry.name);
    }
    assertSourceUnchanged(file, written, fd);
  } finally { fs.closeSync(fd); }
}
function destinationStat(destPath: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(destPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Archive destination is not a regular file (symlinks refused): " + destPath);
    return stat;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Default no-clobber publication is an atomic hard-link acquisition; confirmed
 * replacement uses same-directory rename, never predelete. Success warnings are
 * post-commit cleanup/durability notices, not portable profile metadata. */
export async function writeZipArchive(
  destPath: string, entries: Array<ZipFileEntry | ZipDirEntry>, options: WriteZipOptions = {},
): Promise<WriteZipResult> {
  return writeCooperatively(writeZipSteps(destPath, entries, options), options, entries.length);
}
function* writeZipSteps(destPath: string, entries: Array<ZipFileEntry | ZipDirEntry>, options: WriteZipOptions): WriteSteps<WriteZipResult> {
  destPath = path.resolve(destPath);
  const parent = ensureArchiveDirectory(path.dirname(destPath));
  const previous = destinationStat(destPath);
  if (previous && options.overwrite !== true) throw codedError("ARCHIVE_DESTINATION_EXISTS", "Destination already exists; explicit overwrite confirmation required");
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`ZIP entry count too large: ${entries.length} (max ${MAX_ZIP_ENTRIES})`);
  yield* entryNameSteps(entries);
  let total = 0, metadataBytes = 0;
  const prepared: Array<{ entry: ZipFileEntry | ZipDirEntry; directory: boolean; stat: fs.Stats | null; size: number }> = [];
  for (const entry of entries) {
    checkWriteSignal(options.signal);
    const directory = "isDirectory" in entry && entry.isDirectory === true;
    const file = entry as ZipFileEntry;
    if (!directory && file.filePath !== undefined && file.data !== undefined) throw new Error("ZIP entry has conflicting file/data sources");
    if (file.data !== undefined && !Buffer.isBuffer(file.data)) throw new Error("ZIP entry data must be a Buffer");
    const stat = !directory && file.filePath !== undefined ? regularFile(file.filePath) : null;
    const size = directory ? 0 : stat ? stat.size : (file.data?.length ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ZIP_ENTRY_BYTES) throw new Error("ZIP entry too large: " + entry.name);
    total += size;
    metadataBytes += 46 + Buffer.byteLength(entry.name, "utf8");
    if (total > MAX_ZIP_TOTAL_BYTES) throw new Error("Archive exceeds size limit (" + MAX_ZIP_TOTAL_BYTES + " bytes)");
    if (metadataBytes > MAX_ZIP_METADATA_BYTES) throw new Error("ZIP metadata size limit exceeded");
    prepared.push({ entry, directory, stat, size });
    yield ITEM_CHECKPOINT;
  }
  const tmp = path.join(parent, `.abs-profile-archive-${randomUUID()}.tmp`);
  let fd: number | null = null, owned: fs.Stats | null = null, committed = false;
  let error: unknown;
  let offset = 0;
  const warnings: string[] = [], central: Buffer[] = [], expected: ZipEntry[] = [];
  function* emit(data: Buffer, payload = false): WriteSteps<void> {
    let position = 0;
    while (position < data.length) {
      checkWriteSignal(options.signal);
      const wanted = Math.min(CHUNK, data.length - position);
      const written = fs.writeSync(fd!, data, position, wanted, offset);
      if (!Number.isInteger(written) || written <= 0 || written > wanted) throw new Error("ZIP write made no valid progress");
      position += written; offset += written;
      yield { bytes: payload ? written : 0, items: 0 };
    }
  }
  const syncParent = (): void => {
    if (!syncArchiveDirectory(parent) && !warnings.includes("Directory fsync is unsupported on Windows; only file durability was verified.")) {
      warnings.push("Directory fsync is unsupported on Windows; only file durability was verified.");
    }
  };
  try {
    checkWriteSignal(options.signal);
    // Metadata preparation may yield; O_NOFOLLOW protects only the leaf, so
    // revalidate the parent immediately before exclusive staging acquisition.
    ensureArchiveDirectory(parent);
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    owned = fs.fstatSync(fd);
    for (const item of prepared) {
      const { entry, directory, stat, size } = item;
      const name = Buffer.from(entry.name, "utf8"), file = entry as ZipFileEntry;
      const dt = dosDateTime(stat?.mtimeMs ?? Date.now());
      let sourceFd: number | null = null, crc = 0;
      try {
        checkWriteSignal(options.signal);
        if (stat) {
          sourceFd = openRegularFile(file.filePath!, stat);
          crc = yield* fileCRCSteps(sourceFd, size, options.signal);
          assertSourceUnchanged(file.filePath!, stat, sourceFd);
        } else if (!directory) crc = yield* bufferCRCSteps(file.data ?? Buffer.alloc(0), options.signal);
        const localOffset = offset, local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(dt.time, 10); local.writeUInt16LE(dt.date, 12); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
        yield* emit(local); yield* emit(name);
        let bodyState = 0xffffffff;
        if (sourceFd !== null) {
          const chunk = Buffer.allocUnsafe(CHUNK);
          let position = 0;
          while (position < size) {
            const n = readSourceChunk(sourceFd, chunk, position, size, options.signal), data = chunk.subarray(0, n);
            bodyState = crc32Update(bodyState, data); position += n;
            yield* emit(data, true);
          }
          assertSourceEnd(sourceFd, size, options.signal); assertSourceUnchanged(file.filePath!, stat!, sourceFd);
        } else if (!directory) {
          const data = file.data ?? Buffer.alloc(0);
          for (let position = 0; position < size; position += CHUNK) {
            checkWriteSignal(options.signal);
            const chunk = data.subarray(position, Math.min(position + CHUNK, size));
            bodyState = crc32Update(bodyState, chunk);
            yield* emit(chunk, true);
          }
        }
        if (((bodyState ^ 0xffffffff) >>> 0) !== crc) throw new Error("Archive source changed (body CRC differs from prepass): " + entry.name);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(dt.time, 12); c.writeUInt16LE(dt.date, 14); c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28);
        c.writeUInt32LE(directory ? 0x41ed0010 : (0o100644 << 16) >>> 0, 38); c.writeUInt32LE(localOffset, 42);
        central.push(Buffer.concat([c, name]));
        expected.push({ name: entry.name, isDirectory: directory, method: 0, crc, compressedSize: size, uncompressedSize: size, localHeaderOffset: localOffset });
      } finally { if (sourceFd !== null) fs.closeSync(sourceFd); }
      yield { bytes: 0, items: 1, packed: 1 };
    }
    const cdOffset = offset;
    for (const record of central) {
      checkWriteSignal(options.signal);
      yield* emit(record);
      yield ITEM_CHECKPOINT;
    }
    const cdSize = offset - cdOffset, end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdOffset, 16); yield* emit(end);
    // Even tiny writes yield with the staging descriptor still owned, as before.
    // A cancellation/progress error closes it before rejecting the public promise.
    yield { bytes: 0, items: 0, boundary: true };
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    const closing = fd; fd = null; fs.closeSync(closing);
    const verified = yield* verifyWrittenArchiveSteps(tmp, expected, offset, written, options.signal);
    // Deliver complete processing counts BEFORE final source/staging checks.
    // There is no observer, await, or cancellation check after name acquisition.
    yield { bytes: 0, items: 0, boundary: true };
    syncParent(); // All ordinary directory-sync failures must precede commit.
    ensureArchiveDirectory(parent);
    checkWriteGuard(options);
    // Final witnesses and name acquisition are one synchronous segment. Yielding
    // after checking an early source would let an observer change it unnoticed.
    // This bounded-count stat-only loop is the intentional commit-time residual.
    for (const item of prepared) {
      checkWriteSignal(options.signal);
      if (item.stat) assertSourceUnchanged((item.entry as ZipFileEntry).filePath!, item.stat);
    }
    assertSourceUnchanged(tmp, verified);
    const current = destinationStat(destPath);
    checkWriteSignal(options.signal);
    if (previous) {
      if (!current || !sameSnapshot(current, previous)) throw codedError("ARCHIVE_DESTINATION_CHANGED", "Destination changed since overwrite was confirmed");
      fs.renameSync(tmp, destPath);
    } else {
      // A preflight exists() check cannot provide no-clobber semantics.
      try { fs.linkSync(tmp, destPath); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "EEXIST") throw codedError("ARCHIVE_DESTINATION_EXISTS", "Destination was created by another writer");
        throw failure;
      }
    }
    committed = true;
    try { syncParent(); } catch (failure) { warnings.push("Archive published, but directory durability is uncertain: " + message(failure)); }
  } catch (failure) { error = failure; }
  finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (failure) { error = error ? combinedError(error, failure) : failure; }
    }
    if (owned) {
      try {
        let current: fs.Stats | null = null;
        try { current = fs.lstatSync(tmp); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure; }
        if (current) {
          if (current.isSymbolicLink() || !sameIdentity(current, owned)) throw new Error("Refusing cleanup of a replaced ZIP staging file");
          fs.unlinkSync(tmp);
        }
      } catch (failure) {
        if (committed) warnings.push("Archive published; staging cleanup failed: " + message(failure));
        else error = error ? combinedError(error, failure) : failure;
      }
    }
  }
  if (error) throw error;
  return { entries: entries.length, bytes: offset, ...(warnings.length ? { warnings } : {}) };
}

export interface ExtractOptions { skipNames?: (name: string) => boolean; maxTotalBytes?: number; maxEntryBytes?: number; }
export function extractZipArchive(zipPath: string, destDir: string, opts: ExtractOptions = {}): { files: number; bytes: number } {
  const before = regularFile(zipPath), input = openRegularFile(zipPath, before);
  let total = 0, files = 0;
  try {
    const source = fileSource(input), entries = parseEntries(source);
    const perEntryCap = Math.min(opts.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES, MAX_ZIP_ENTRY_BYTES);
    const totalCap = Math.min(opts.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES, MAX_ZIP_TOTAL_BYTES);
    if (!Number.isSafeInteger(perEntryCap) || perEntryCap < 0 || !Number.isSafeInteger(totalCap) || totalCap < 0) throw new Error("Invalid ZIP extraction size limit");
    const selected = entries.filter((entry) => !opts.skipNames?.(entry.name));
    for (const entry of selected) {
      if (entry.uncompressedSize > perEntryCap || entry.compressedSize > perEntryCap * 2) throw new Error("ZIP entry too large: " + entry.name);
      total += entry.uncompressedSize;
      if (total > totalCap) throw new Error("Archive exceeds size limit (" + totalCap + " bytes)");
    }
    const destRoot = ensureArchiveDirectory(destDir, true), directories = new Set([destRoot]);
    const trackDirectory = (directory: string): void => {
      for (let current = directory; current !== destRoot; current = path.dirname(current)) directories.add(current);
    };
    for (const entry of selected) {
      const target = path.resolve(destRoot, entry.name);
      if (!isPathInside(target, destRoot) || target === destRoot) throw new Error("Unsafe ZIP path: " + entry.name);
      if (entry.isDirectory) {
        if (entry.method === 8) readContent(source, entry); // Verify a deflated empty directory as well.
        ensureArchiveDirectory(target, true); trackDirectory(target); continue;
      }
      const parent = ensureArchiveDirectory(path.dirname(target), true); trackDirectory(parent);
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      let written: fs.Stats;
      try {
        if (entry.method === 0) visitStoredContent(source, entry, (chunk, position) => writeAll(fd, chunk, position));
        else writeAll(fd, readContent(source, entry), 0); // Deflate is bounded per entry, never the whole ZIP.
        fs.fsyncSync(fd);
        written = fs.fstatSync(fd);
      } finally { fs.closeSync(fd); }
      verifyExtractedFile(target, entry, written);
      files++;
    }
    assertSourceUnchanged(zipPath, before, input);
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) syncArchiveDirectory(directory);
    return { files, bytes: total };
  } finally { fs.closeSync(input); }
}
