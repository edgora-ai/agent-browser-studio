// Bundled browser discovery. macOS archives are verified in operation-owned
// staging directories and atomically published into the version/size/time cache.
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export interface BundledBrowsersManifest {
  platform?: string;
  chromiumVersion?: string | null;
  firefoxVersion?: string | null;
  syncedAt?: string;
}

type ProcessLike = NodeJS.Process & { resourcesPath?: string };
type BrowserKind = "chromium" | "firefox";
interface BrowserInput { kind: BrowserKind; platform: NodeJS.Platform; root: string | null; cacheRoot: string }
interface ArchiveIdentity { source: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface ArchiveSpec { zipPath: string; cacheDir: string; expectedBinary: string; identity: ArchiveIdentity }
interface LockSnapshot { identity: fs.Stats; bytes: string }
interface LockOwner {
  protocol: "bundled-browser-directory-lock-v1";
  destination: string;
  uid: number | null;
  pid: number;
  lockIdentity: { dev: number; ino: number };
  operationId: string;
}
interface LockBase extends LockSnapshot { file: string; operationId: string }
interface CacheLock extends LockBase { fd: number }
interface AsyncCacheLock extends LockBase { handle: FileHandle }

const UNPACK_CACHE_DIR = "bundled-browsers";
const MAX_SMALL_FILE = 64 * 1024;
const MAX_LOCK_FILE = 4096;
const EXTRACT_TIMEOUT = 300000;
const VERIFY_TIMEOUT = 30000;
const MAX_SUBPROCESS_OUTPUT = 1024 * 1024;
const LOCK_WAIT_TIMEOUT = EXTRACT_TIMEOUT + VERIFY_TIMEOUT + 20000;
const pendingArchives = new Map<string, Promise<void>>();

export function bundledBrowsersRoot(
  platform: NodeJS.Platform = process.platform,
  resourcesPath: string | undefined | null = (process as ProcessLike).resourcesPath,
): string | null {
  if (!resourcesPath) return null;
  const base = path.join(resourcesPath, "native-browsers");
  if (platform === "darwin") return base;
  if (platform === "win32") return path.join(base, "win");
  return path.join(base, platform);
}

function effectiveResourcesPath(
  env: NodeJS.ProcessEnv,
  resourcesPath: string | undefined | null = (process as ProcessLike).resourcesPath,
): string | null {
  if (env.AGENT_BROWSER_BUNDLED_RESOURCES) return env.AGENT_BROWSER_BUNDLED_RESOURCES;
  return resourcesPath ?? null;
}

function bundledRoot(platform: NodeJS.Platform = process.platform, resourcesPath?: string | null): string | null {
  return bundledBrowsersRoot(platform, effectiveResourcesPath(process.env, resourcesPath));
}

function captureInput(kind: BrowserKind, platform: NodeJS.Platform, resourcesPath?: string | null): BrowserInput {
  const root = bundledRoot(platform, resourcesPath);
  const override = process.env.AGENT_BROWSER_BUNDLED_CACHE_DIR;
  const cacheRoot = override ? path.resolve(override) : path.join(os.homedir(), ".agent-browser-studio", UNPACK_CACHE_DIR);
  return { kind, platform, root, cacheRoot };
}

function isFsError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function readBoundedSync(fd: number, limit: number): string {
  const buffer = Buffer.alloc(limit + 1);
  const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
  if (length > limit) throw new Error(`Bundled browser metadata exceeds ${limit} bytes`);
  return buffer.subarray(0, length).toString("utf8");
}

async function readBounded(handle: FileHandle, limit: number): Promise<string> {
  const buffer = Buffer.alloc(limit + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  if (bytesRead > limit) throw new Error(`Bundled browser metadata exceeds ${limit} bytes`);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

function readSmallSync(file: string, limit = MAX_SMALL_FILE): string {
  const fd = fs.openSync(file, "r");
  try { return readBoundedSync(fd, limit); } finally { fs.closeSync(fd); }
}

async function readSmall(file: string, limit = MAX_SMALL_FILE): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try { return await readBounded(handle, limit); } finally { await handle.close(); }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.promises.access(file); return true; } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return false;
    throw error;
  }
}

function readManifestAtRoot(root: string): BundledBrowsersManifest | null {
  try { return JSON.parse(readSmallSync(path.join(root, "browsers-manifest.json"))) as BundledBrowsersManifest; }
  catch { return null; } // An absent/invalid optional manifest uses the archive identity.
}

async function readManifestAtRootAsync(root: string): Promise<BundledBrowsersManifest | null> {
  try { return JSON.parse(await readSmall(path.join(root, "browsers-manifest.json"))) as BundledBrowsersManifest; }
  catch { return null; }
}

function archiveIdentity(source: string, stat: fs.Stats): ArchiveIdentity {
  return { source, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function captureArchiveSync(zipPath: string): ArchiveIdentity {
  const source = fs.realpathSync(zipPath);
  return archiveIdentity(source, fs.statSync(source));
}

async function captureArchive(zipPath: string): Promise<ArchiveIdentity> {
  const source = await fs.promises.realpath(zipPath);
  return archiveIdentity(source, await fs.promises.stat(source));
}

function sameArchive(a: ArchiveIdentity | undefined, b: ArchiveIdentity): boolean {
  return !!a && a.source === b.source && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function requireArchiveUnchangedSync(spec: ArchiveSpec): void {
  if (!sameArchive(captureArchiveSync(spec.zipPath), spec.identity)) throw new Error(`Bundled browser archive changed: ${spec.zipPath}`);
}

async function requireArchiveUnchanged(spec: ArchiveSpec): Promise<void> {
  if (!sameArchive(await captureArchive(spec.zipPath), spec.identity)) throw new Error(`Bundled browser archive changed: ${spec.zipPath}`);
}

function archiveSpec(input: BrowserInput, zipPath: string, relativeBinary: string, identity: ArchiveIdentity, manifest: BundledBrowsersManifest | null): ArchiveSpec {
  const version = input.kind === "chromium" ? manifest?.chromiumVersion : manifest?.firefoxVersion;
  const archiveKey = `${identity.size}-${Math.trunc(identity.mtimeMs)}`;
  const key = version && /^[0-9A-Za-z._+-]+$/.test(version) ? `${version}-${archiveKey}` : archiveKey;
  const cacheDir = path.join(input.cacheRoot, `${input.kind}-${input.platform}-${key.replace(/[^0-9A-Za-z._-]/g, "_")}`);
  return { zipPath, cacheDir, expectedBinary: path.join(cacheDir, relativeBinary), identity };
}

function binaryRelative(kind: BrowserKind): string {
  return path.join(kind === "chromium" ? "Chromium.app" : "Firefox.app", "Contents", "MacOS", kind === "chromium" ? "Chromium" : "firefox");
}

function directCandidate(input: BrowserInput): string {
  const root = input.root!;
  if (input.platform === "darwin") return path.join(root, binaryRelative(input.kind));
  return input.kind === "chromium"
    ? (input.platform === "win32" ? path.join(root, "chromium", "chrome.exe") : path.join(root, "chromium"))
    : path.join(root, "firefox", input.platform === "win32" ? "firefox.exe" : "firefox");
}

function browserLocation(input: BrowserInput): string | ArchiveSpec | null {
  if (!input.root) return null;
  const candidate = directCandidate(input);
  if (fs.existsSync(candidate)) return candidate;
  if (input.platform !== "darwin") return null;
  const zipPath = path.resolve(input.root, `${input.kind === "chromium" ? "Chromium.app" : "Firefox.app"}.zip`);
  if (!fs.existsSync(zipPath)) return null;
  return archiveSpec(input, zipPath, binaryRelative(input.kind), captureArchiveSync(zipPath), readManifestAtRoot(input.root));
}

async function browserLocationAsync(input: BrowserInput): Promise<string | ArchiveSpec | null> {
  if (!input.root) return null;
  const candidate = directCandidate(input);
  if (await exists(candidate)) return candidate;
  if (input.platform !== "darwin") return null;
  const zipPath = path.resolve(input.root, `${input.kind === "chromium" ? "Chromium.app" : "Firefox.app"}.zip`);
  if (!await exists(zipPath)) return null;
  const identity = await captureArchive(zipPath);
  const manifest = await readManifestAtRootAsync(input.root);
  return archiveSpec(input, zipPath, binaryRelative(input.kind), identity, manifest);
}

function readyRecordMatches(bytes: string, marker: string, spec: ArchiveSpec): boolean {
  try {
    const record = JSON.parse(bytes) as { protocol?: string; marker?: string; archive?: ArchiveIdentity };
    return record.protocol === "bundled-browser-ready-v1" && record.marker === marker && sameArchive(record.archive, spec.identity);
  } catch { return false; }
}

function isReady(spec: ArchiveSpec): boolean {
  if (!fs.existsSync(spec.expectedBinary)) return false;
  try {
    const marker = readSmallSync(path.join(spec.cacheDir, ".ready"), 128);
    return readyRecordMatches(readSmallSync(path.join(spec.cacheDir, ".ready.archive.json")), marker, spec);
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function isReadyAsync(spec: ArchiveSpec): Promise<boolean> {
  if (!await exists(spec.expectedBinary)) return false;
  try {
    const marker = await readSmall(path.join(spec.cacheDir, ".ready"), 128);
    return readyRecordMatches(await readSmall(path.join(spec.cacheDir, ".ready.archive.json")), marker, spec);
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return false;
    throw error;
  }
}

function sameInode(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameSnapshot(a: LockSnapshot | null, b: LockSnapshot): boolean {
  return !!a && sameInode(a.identity, b.identity) && a.bytes === b.bytes;
}

// lstat is intentional: a dangling symlink is an existing unknown lock too.
function lockEntryExists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function lockEntryExistsAsync(file: string): Promise<boolean> {
  try { await fs.promises.lstat(file); return true; } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return false;
    throw error;
  }
}

function lockSnapshot(file: string): LockSnapshot | null {
  let fd: number;
  try {
    if (!fs.lstatSync(file).isDirectory()) return null;
    fd = fs.openSync(file, "r");
  } catch (error) { if (isFsError(error, "ENOENT")) return null; throw error; }
  try {
    const identity = fs.fstatSync(fd);
    if (!identity.isDirectory()) return null;
    const ownerFile = path.join(file, "owner.json");
    const ownerStat = fs.lstatSync(ownerFile);
    if (!ownerStat.isFile() || ownerStat.uid !== identity.uid) return null;
    const bytes = readSmallSync(ownerFile, MAX_LOCK_FILE);
    return sameInode(identity, fs.lstatSync(file)) ? { identity, bytes } : null;
  } catch (error) { if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return null; throw error; }
  finally { fs.closeSync(fd); }
}

async function lockSnapshotAsync(file: string): Promise<LockSnapshot | null> {
  let handle: FileHandle;
  try {
    if (!(await fs.promises.lstat(file)).isDirectory()) return null;
    handle = await fs.promises.open(file, "r");
  } catch (error) { if (isFsError(error, "ENOENT")) return null; throw error; }
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory()) return null;
    const ownerFile = path.join(file, "owner.json");
    const ownerStat = await fs.promises.lstat(ownerFile);
    if (!ownerStat.isFile() || ownerStat.uid !== identity.uid) return null;
    const bytes = await readSmall(ownerFile, MAX_LOCK_FILE);
    return sameInode(identity, await fs.promises.lstat(file)) ? { identity, bytes } : null;
  } catch (error) { if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return null; throw error; }
  finally { await handle.close(); }
}

function lockOwner(snapshot: LockSnapshot | null, destination: string): LockOwner | null {
  if (!snapshot || typeof process.getuid !== "function") return null;
  try {
    const owner = JSON.parse(snapshot.bytes) as LockOwner;
    const uid = process.getuid();
    if (owner.protocol !== "bundled-browser-directory-lock-v1" || owner.destination !== destination
      || owner.uid !== uid || snapshot.identity.uid !== uid
      || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647
      || owner.lockIdentity?.dev !== snapshot.identity.dev || owner.lockIdentity?.ino !== snapshot.identity.ino
      || typeof owner.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.operationId)) return null;
    return owner;
  } catch { return null; }
}

function ownerIsDead(owner: LockOwner): boolean {
  if (owner.pid === process.pid) return false;
  try { os.getPriority(owner.pid); return false; } catch (error) {
    const failure = error as NodeJS.ErrnoException & { info?: { code?: string; syscall?: string } };
    return failure.code === "ESRCH" || (failure.code === "ERR_SYSTEM_ERROR" && failure.info?.code === "ESRCH" && failure.info.syscall === "uv_os_getpriority");
  }
}

function ownerBytes(identity: fs.Stats, destination: string, operationId: string): string {
  const owner: LockOwner = {
    protocol: "bundled-browser-directory-lock-v1", destination,
    uid: typeof process.getuid === "function" ? process.getuid() : null, pid: process.pid,
    lockIdentity: { dev: identity.dev, ino: identity.ino }, operationId,
  };
  return JSON.stringify(owner) + "\n";
}

function lockCollision(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].some((code) => isFsError(error, code));
}

// Never mkdir the canonical path. A crash during preparation leaves only an
// ignored unique sibling; owner.json is complete before the nonempty directory
// is atomically published. Refuse all observed existing entries, including empty
// directories: POSIX rename can replace an empty directory, unlike our locks.
function createLock(file: string, destination: string): CacheLock | null {
  if (lockEntryExists(file) || lockEntryExists(`${file}.recovery`)) return null;
  const prepared = fs.mkdtempSync(`${file}.prepare-`);
  let fd: number | undefined;
  let published = false;
  try {
    const identity = fs.lstatSync(prepared);
    const operationId = randomUUID();
    const bytes = ownerBytes(identity, destination, operationId);
    fs.writeFileSync(path.join(prepared, "owner.json"), bytes, { mode: 0o600 });
    fd = fs.openSync(prepared, "r");
    if (!sameInode(identity, fs.fstatSync(fd))) throw new Error("Bundled browser lock preparation ownership changed");
    if (lockEntryExists(file) || lockEntryExists(`${file}.recovery`)) return null;
    try { fs.renameSync(prepared, file); } catch (error) { if (lockCollision(error)) return null; throw error; }
    published = true;
    return { file, fd, identity, bytes, operationId };
  } finally {
    if (!published) {
      try { if (fd !== undefined) fs.closeSync(fd); }
      finally { fs.rmSync(prepared, { recursive: true, force: true }); }
    }
  }
}

async function createLockAsync(file: string, destination: string): Promise<AsyncCacheLock | null> {
  if (await lockEntryExistsAsync(file) || await lockEntryExistsAsync(`${file}.recovery`)) return null;
  const prepared = await fs.promises.mkdtemp(`${file}.prepare-`);
  let handle: FileHandle | undefined;
  let published = false;
  try {
    const identity = await fs.promises.lstat(prepared);
    const operationId = randomUUID();
    const bytes = ownerBytes(identity, destination, operationId);
    await fs.promises.writeFile(path.join(prepared, "owner.json"), bytes, { mode: 0o600 });
    handle = await fs.promises.open(prepared, "r");
    if (!sameInode(identity, await handle.stat())) throw new Error("Bundled browser lock preparation ownership changed");
    if (await lockEntryExistsAsync(file) || await lockEntryExistsAsync(`${file}.recovery`)) return null;
    try { await fs.promises.rename(prepared, file); } catch (error) { if (lockCollision(error)) return null; throw error; }
    published = true;
    return { file, handle, identity, bytes, operationId };
  } finally {
    if (!published) {
      try { if (handle) await handle.close(); }
      finally { await fs.promises.rm(prepared, { recursive: true, force: true }); }
    }
  }
}

function retiredLockPath(file: string, identity: fs.Stats, operationId: string, reason: "abandoned" | "released"): string {
  return `${file}.${reason}-${identity.dev}-${identity.ino}-${operationId}`;
}

function releaseCacheLock(lock: CacheLock): void {
  const released = retiredLockPath(lock.file, lock.identity, lock.operationId, "released");
  let moved = false;
  try {
    if (sameSnapshot(lockSnapshot(lock.file), lock)) {
      fs.renameSync(lock.file, released);
      moved = true;
    }
  } finally {
    try { fs.closeSync(lock.fd); }
    finally { if (moved) fs.rmSync(released, { recursive: true, force: true }); }
  }
}

async function releaseCacheLockAsync(lock: AsyncCacheLock): Promise<void> {
  const released = retiredLockPath(lock.file, lock.identity, lock.operationId, "released");
  let moved = false;
  try {
    if (sameSnapshot(await lockSnapshotAsync(lock.file), lock)) {
      await fs.promises.rename(lock.file, released);
      moved = true;
    }
  } finally {
    try { await lock.handle.close(); }
    finally { if (moved) await fs.promises.rm(released, { recursive: true, force: true }); }
  }
}

// The old directory is nonempty and its deterministic abandoned destination is
// NEVER deleted. Thus concurrent stale snapshots choose the same destination:
// after one move wins, a second rename fails atomically even if the canonical
// path now contains a new live owner's nonempty directory. No recovery claim or
// partial canonical owner record is ever produced by this protocol.
function recoverDeadLock(cacheDir: string): CacheLock | null {
  const file = `${cacheDir}.lock`;
  if (lockEntryExists(`${file}.recovery`)) return null;
  const previous = lockSnapshot(file);
  const owner = lockOwner(previous, cacheDir);
  if (!previous || !owner || !ownerIsDead(owner)) return null;
  if (!sameSnapshot(lockSnapshot(file), previous) || !ownerIsDead(owner) || lockEntryExists(`${file}.recovery`)) return null;
  const abandoned = retiredLockPath(file, previous.identity, owner.operationId, "abandoned");
  try { fs.renameSync(file, abandoned); } catch (error) {
    if (lockCollision(error) || isFsError(error, "ENOENT")) return null;
    throw error;
  }
  return createLock(file, cacheDir);
}

async function recoverDeadLockAsync(cacheDir: string): Promise<AsyncCacheLock | null> {
  const file = `${cacheDir}.lock`;
  if (await lockEntryExistsAsync(`${file}.recovery`)) return null;
  const previous = await lockSnapshotAsync(file);
  const owner = lockOwner(previous, cacheDir);
  if (!previous || !owner || !ownerIsDead(owner)) return null;
  if (!sameSnapshot(await lockSnapshotAsync(file), previous) || !ownerIsDead(owner)
    || await lockEntryExistsAsync(`${file}.recovery`)) return null;
  const abandoned = retiredLockPath(file, previous.identity, owner.operationId, "abandoned");
  try { await fs.promises.rename(file, abandoned); } catch (error) {
    if (lockCollision(error) || isFsError(error, "ENOENT")) return null;
    throw error;
  }
  return await createLockAsync(file, cacheDir);
}

function tryCacheLock(cacheDir: string): CacheLock | null {
  const file = `${cacheDir}.lock`;
  if (lockEntryExists(`${file}.recovery`)) return null;
  const lock = createLock(file, cacheDir) ?? recoverDeadLock(cacheDir);
  if (!lock) return null;
  if (!lockEntryExists(`${file}.recovery`)) return lock;
  releaseCacheLock(lock);
  return null;
}

async function tryCacheLockAsync(cacheDir: string): Promise<AsyncCacheLock | null> {
  const file = `${cacheDir}.lock`;
  if (await lockEntryExistsAsync(`${file}.recovery`)) return null;
  const lock = await createLockAsync(file, cacheDir) ?? await recoverDeadLockAsync(cacheDir);
  if (!lock) return null;
  if (!await lockEntryExistsAsync(`${file}.recovery`)) return lock;
  await releaseCacheLockAsync(lock);
  return null;
}

function stagedBinary(spec: ArchiveSpec, stage: string): string {
  return path.join(stage, path.relative(spec.cacheDir, spec.expectedBinary));
}
function appBundleFor(binary: string): string { return path.dirname(path.dirname(path.dirname(binary))); }
function requireBinary(binary: string): void {
  if (!fs.existsSync(binary)) throw new Error(`Bundled browser expected binary is missing: ${binary}`);
}
async function requireBinaryAsync(binary: string): Promise<void> {
  if (!await exists(binary)) throw new Error(`Bundled browser expected binary is missing: ${binary}`);
}
function readyBytes(spec: ArchiveSpec, marker: string): string {
  return JSON.stringify({ protocol: "bundled-browser-ready-v1", marker, archive: spec.identity }) + "\n";
}

function publishArchive(spec: ArchiveSpec, stage: string, lock: CacheLock): void {
  requireArchiveUnchangedSync(spec);
  if (isReady(spec)) return;
  if (!sameSnapshot(lockSnapshot(lock.file), lock)) throw new Error(`Bundled browser cache lock ownership changed: ${spec.cacheDir}`);
  requireBinary(stagedBinary(spec, stage));
  const marker = `${Date.now()}\n`;
  fs.writeFileSync(path.join(stage, ".ready.archive.json"), readyBytes(spec, marker));
  fs.writeFileSync(path.join(stage, ".ready"), marker);
  requireArchiveUnchangedSync(spec);
  if (fs.existsSync(spec.cacheDir)) fs.renameSync(spec.cacheDir, `${stage}.previous`);
  fs.renameSync(stage, spec.cacheDir);
}

async function publishArchiveAsync(spec: ArchiveSpec, stage: string, lock: AsyncCacheLock): Promise<void> {
  await requireArchiveUnchanged(spec);
  if (await isReadyAsync(spec)) return;
  if (!sameSnapshot(await lockSnapshotAsync(lock.file), lock)) throw new Error(`Bundled browser cache lock ownership changed: ${spec.cacheDir}`);
  await requireBinaryAsync(stagedBinary(spec, stage));
  const marker = `${Date.now()}\n`;
  await fs.promises.writeFile(path.join(stage, ".ready.archive.json"), readyBytes(spec, marker));
  await fs.promises.writeFile(path.join(stage, ".ready"), marker);
  await requireArchiveUnchanged(spec);
  if (await exists(spec.cacheDir)) await fs.promises.rename(spec.cacheDir, `${stage}.previous`);
  await fs.promises.rename(stage, spec.cacheDir);
}

function unpackArchiveIfNeeded(spec: ArchiveSpec): void {
  if (isReady(spec)) { requireArchiveUnchangedSync(spec); return; }
  fs.mkdirSync(path.dirname(spec.cacheDir), { recursive: true });
  const lock = tryCacheLock(spec.cacheDir);
  if (!lock) {
    if (isReady(spec)) { requireArchiveUnchangedSync(spec); return; }
    throw new Error(`Bundled browser cache is busy: ${spec.cacheDir}`);
  }
  let stage: string | undefined;
  try {
    if (isReady(spec)) { requireArchiveUnchangedSync(spec); return; }
    stage = fs.mkdtempSync(`${spec.cacheDir}.stage-${lock.operationId}-`);
    const binary = stagedBinary(spec, stage);
    requireArchiveUnchangedSync(spec);
    const unpack = spawnSync("ditto", ["-x", "-k", spec.zipPath, stage], {
      encoding: "utf8", timeout: EXTRACT_TIMEOUT, maxBuffer: MAX_SUBPROCESS_OUTPUT,
    });
    if (unpack.error || unpack.status !== 0) throw new Error(`Failed to unpack bundled browser ${spec.zipPath}: ${String(unpack.error || unpack.stderr || `exit ${unpack.status}`)}`);
    requireArchiveUnchangedSync(spec);
    requireBinary(binary);
    const signature = spawnSync("codesign", ["--verify", "--deep", "--strict", appBundleFor(binary)], {
      encoding: "utf8", timeout: VERIFY_TIMEOUT, maxBuffer: MAX_SUBPROCESS_OUTPUT,
    });
    if (signature.error || signature.status !== 0) throw new Error(`Bundled browser signature verification failed: ${String(signature.error || signature.stderr || `exit ${signature.status}`)}`);
    publishArchive(spec, stage, lock);
  } finally {
    try { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
    finally { releaseCacheLock(lock); }
  }
}

function runSubprocess(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let failure: Error | undefined;
    let outputBytes = 0;
    const stderr: Buffer[] = [];
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const deadline = setTimeout(() => stop(new Error(`${command} timed out after ${timeout}ms`)), timeout);
    const consume = (chunk: Buffer | string, diagnostic: boolean): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_SUBPROCESS_OUTPUT - outputBytes;
      if (diagnostic && remaining > 0) stderr.push(Buffer.from(data.subarray(0, remaining)));
      outputBytes += data.length;
      if (outputBytes > MAX_SUBPROCESS_OUTPUT) stop(new Error(`${command} output exceeded ${MAX_SUBPROCESS_OUTPUT} bytes`));
    };
    child.stdout?.on("data", (chunk: Buffer) => consume(chunk, false));
    child.stderr?.on("data", (chunk: Buffer) => consume(chunk, true));
    child.on("error", (error) => stop(error));
    // Staging and its lock remain owned until termination AND drained stdio.
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      if (failure) reject(failure);
      else if (code !== 0 || signal) reject(new Error(`${command} failed (${signal || code}): ${Buffer.concat(stderr).toString("utf8")}`));
      else resolve();
    });
  });
}

async function waitForCacheLock(spec: ArchiveSpec): Promise<AsyncCacheLock | null> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT;
  for (;;) {
    if (await isReadyAsync(spec)) return null;
    const lock = await tryCacheLockAsync(spec.cacheDir);
    if (lock) return lock;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Bundled browser cache is busy (lock wait timed out): ${spec.cacheDir}`);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
}

async function produceArchiveAsync(spec: ArchiveSpec): Promise<void> {
  if (await isReadyAsync(spec)) { await requireArchiveUnchanged(spec); return; }
  await fs.promises.mkdir(path.dirname(spec.cacheDir), { recursive: true });
  const lock = await waitForCacheLock(spec);
  if (!lock) { await requireArchiveUnchanged(spec); return; }
  let stage: string | undefined;
  try {
    if (await isReadyAsync(spec)) { await requireArchiveUnchanged(spec); return; }
    stage = await fs.promises.mkdtemp(`${spec.cacheDir}.stage-${lock.operationId}-`);
    const binary = stagedBinary(spec, stage);
    await requireArchiveUnchanged(spec);
    await runSubprocess("ditto", ["-x", "-k", spec.zipPath, stage], EXTRACT_TIMEOUT);
    await requireArchiveUnchanged(spec);
    await requireBinaryAsync(binary);
    await runSubprocess("codesign", ["--verify", "--deep", "--strict", appBundleFor(binary)], VERIFY_TIMEOUT);
    await publishArchiveAsync(spec, stage, lock);
  } finally {
    try { if (stage) await fs.promises.rm(stage, { recursive: true, force: true }); }
    finally { await releaseCacheLockAsync(lock); }
  }
}

async function unpackArchiveIfNeededAsync(spec: ArchiveSpec): Promise<void> {
  if (await isReadyAsync(spec)) { await requireArchiveUnchanged(spec); return; }
  const key = JSON.stringify([spec.zipPath, spec.cacheDir, spec.expectedBinary, spec.identity]);
  const existing = pendingArchives.get(key);
  if (existing) return await existing;
  const pending = produceArchiveAsync(spec).finally(() => {
    if (pendingArchives.get(key) === pending) pendingArchives.delete(key);
  });
  pendingArchives.set(key, pending);
  await pending;
}

function binaryPath(kind: BrowserKind, platform: NodeJS.Platform, resourcesPath?: string | null): string | null {
  const location = browserLocation(captureInput(kind, platform, resourcesPath));
  if (!location || typeof location === "string") return location;
  unpackArchiveIfNeeded(location);
  return location.expectedBinary;
}

async function binaryPathAsync(kind: BrowserKind, platform: NodeJS.Platform, resourcesPath?: string | null): Promise<string | null> {
  // Capture mutable environment/default-resource inputs before the first await;
  // filesystem identity/discovery is deliberately asynchronous, not statSync.
  const input = captureInput(kind, platform, resourcesPath);
  const location = await browserLocationAsync(input);
  if (!location || typeof location === "string") return location;
  await unpackArchiveIfNeededAsync(location);
  return location.expectedBinary;
}

export function bundledChromiumBinaryPath(platform: NodeJS.Platform = process.platform, resourcesPath?: string | null): string | null {
  return binaryPath("chromium", platform, resourcesPath);
}
export function bundledFirefoxBinaryPath(platform: NodeJS.Platform = process.platform, resourcesPath?: string | null): string | null {
  return binaryPath("firefox", platform, resourcesPath);
}
export function bundledChromiumBinaryPathAsync(platform: NodeJS.Platform = process.platform, resourcesPath?: string | null): Promise<string | null> {
  return binaryPathAsync("chromium", platform, resourcesPath);
}
export function bundledFirefoxBinaryPathAsync(platform: NodeJS.Platform = process.platform, resourcesPath?: string | null): Promise<string | null> {
  return binaryPathAsync("firefox", platform, resourcesPath);
}
export function readBundledBrowsersManifest(platform: NodeJS.Platform = process.platform, resourcesPath?: string | null): BundledBrowsersManifest | null {
  const root = bundledRoot(platform, resourcesPath);
  return root ? readManifestAtRoot(root) : null;
}
export async function readBundledBrowsersManifestAsync(platform: NodeJS.Platform = process.platform, resourcesPath?: string | null): Promise<BundledBrowsersManifest | null> {
  const root = bundledRoot(platform, resourcesPath);
  return root ? await readManifestAtRootAsync(root) : null;
}
