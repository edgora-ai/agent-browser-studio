import * as fs from "node:fs";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { BrowserEngine, ProxyConfig } from "../../types.js";
import {
  captureStagedFullProfile, disposePreparedFullProfileAsync, prepareFullProfile, resealPreparedFullProfileAsync,
  stageFullProfileCapture, verifyFullProfileArtifact,
  type FullProfileArtifact, type FullProfileGuard, type FullProfileMember, type FullProfileProgress, type PreparedFullProfile,
} from "./full-profile-artifact.js";
import {
  identityForManagedProfile, createBasicChromiumAdapter, inspectProfileCredentials,
  convertProfileCredentials, disposeConvertedProfileCredentials,
  type CredentialIdentity, type CredentialPlatform, type ProfileCredentialReport,
} from "./profile-credentials.js";

const META_PATH = "environment.bin";
const META_MAGIC = Buffer.from("ABSFPM01");
const MAX_METADATA = 2 * 1024 * 1024;
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export interface FullProfileEnvironment {
  profileHash: string;
  /** Only the linked proxy, inside the encrypted artifact, never public config. */
  proxy?: { name: string; publicHash: string; username: string; password: string };
}
interface TransferMetadata extends FullProfileEnvironment {
  version: 1;
  source: CredentialIdentity;
  credentials: ProfileCredentialReport;
}
interface TransferOptions {
  dirId: string;
  engine: BrowserEngine;
  snapshotId: string;
  passphrase: string;
  stagingDir: string;
  guard: FullProfileGuard;
  signal?: AbortSignal;
  onProgress?: (progress: FullProfileProgress) => void;
}
function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function check(options: Pick<TransferOptions, "guard" | "signal">): void {
  if (options.signal?.aborted) throw failure("SYNC_CANCELLED", "Complete profile transfer cancelled");
  options.guard();
  if (options.signal?.aborted) throw failure("SYNC_CANCELLED", "Complete profile transfer cancelled");
}
function platform(value: string): CredentialPlatform {
  if (value !== "darwin" && value !== "linux" && value !== "win32") {
    throw failure("FULL_PROFILE_PLATFORM_UNSUPPORTED", "This platform has no verified profile credential adapter");
  }
  return value;
}
function adapter(identity: CredentialIdentity) {
  return identity.engine === "chromium" && identity.platform !== "win32" ? createBasicChromiumAdapter(identity) : undefined;
}
function relativeProfile(engine: BrowserEngine): string { return engine === "firefox" ? "." : "Default"; }
function credentialOptions(prepared: PreparedFullProfile, source: CredentialIdentity, options: TransferOptions) {
  const owner = fs.lstatSync(prepared.directory);
  if (!owner.isDirectory() || owner.isSymbolicLink()) throw failure("FULL_PROFILE_STAGING_CHANGED", "Profile staging ownership changed");
  return { stagingRoot: prepared.directory, stagingOwner: { dev: owner.dev, ino: owner.ino },
    profileRelativePath: relativeProfile(options.engine), source, guard: options.guard, signal: options.signal };
}
function aad(options: Pick<TransferOptions, "dirId" | "engine" | "snapshotId">): Buffer {
  return Buffer.from(JSON.stringify(["abs-full-profile-metadata-v1", options.dirId, options.engine, options.snapshotId]));
}
async function metadataKey(options: TransferOptions, salt: Buffer): Promise<Buffer> {
  const passphrase = options.passphrase;
  if (typeof passphrase !== "string" || Buffer.byteLength(passphrase) < 12 || Buffer.byteLength(passphrase) > 1024) {
    throw failure("FULL_PROFILE_PASSPHRASE_REQUIRED", "Set the same migration passphrase on both machines (12–1024 UTF-8 bytes)");
  }
  const input = Buffer.from(passphrase, "utf8"); let key: Buffer | undefined;
  try {
    check(options);
    key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(input, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
        if (error) reject(error); else resolve(derived);
      });
    });
    check(options); return key;
  } catch (cause) { key?.fill(0); throw cause; }
  finally { input.fill(0); }
}
async function sealMetadata(value: TransferMetadata, options: TransferOptions): Promise<Buffer> {
  const clear = Buffer.from(JSON.stringify(value)); let key: Buffer | undefined;
  try {
    if (clear.length > MAX_METADATA) throw failure("FULL_PROFILE_METADATA_LIMIT", "Complete profile metadata is too large");
    const salt = randomBytes(16), nonce = randomBytes(12);
    key = await metadataKey(options, salt); check(options);
    const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad(options));
    return Buffer.concat([META_MAGIC, salt, nonce, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
  } finally { key?.fill(0); clear.fill(0); }
}
async function openMetadata(bytes: Buffer, options: TransferOptions): Promise<TransferMetadata> {
  if (bytes.length < 52 || bytes.length > MAX_METADATA + 52 || !bytes.subarray(0, 8).equals(META_MAGIC)) {
    throw failure("FULL_PROFILE_METADATA_INVALID", "Complete profile metadata is missing or invalid");
  }
  const key = await metadataKey(options, bytes.subarray(8, 24));
  let first: Buffer | undefined, clear: Buffer | undefined;
  try {
    check(options);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(24, 36));
      decipher.setAAD(aad(options)); decipher.setAuthTag(bytes.subarray(-16));
      first = decipher.update(bytes.subarray(36, -16)); clear = Buffer.concat([first, decipher.final()]);
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
      if (!value || value.version !== 1 || typeof value.profileHash !== "string" || !/^[a-f0-9]{64}$/.test(value.profileHash) ||
          !value.source || !value.credentials || value.credentials.version !== 1) throw new Error("invalid");
      if (value.proxy !== undefined && (!value.proxy || typeof value.proxy.name !== "string" || value.proxy.name.length > 256 ||
          !/^[a-f0-9]{64}$/.test(value.proxy.publicHash) || typeof value.proxy.username !== "string" || typeof value.proxy.password !== "string" ||
          Buffer.byteLength(value.proxy.username) > 65536 || Buffer.byteLength(value.proxy.password) > 65536)) throw new Error("invalid");
      return value as TransferMetadata;
    } catch { throw failure("FULL_PROFILE_METADATA_INVALID", "Complete profile metadata authentication or validation failed"); }
  } finally { key.fill(0); first?.fill(0); clear?.fill(0); }
}
async function readMetadata(prepared: PreparedFullProfile, options: TransferOptions): Promise<TransferMetadata> {
  check(options);
  if (!prepared.extraDirectory || prepared.manifest.extraEntries.length !== 1 || prepared.manifest.extraEntries[0].path !== META_PATH) {
    throw failure("FULL_PROFILE_METADATA_INVALID", "Complete profile has no authenticated environment metadata");
  }
  const file = path.join(prepared.extraDirectory, META_PATH), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_METADATA + 52) {
    throw failure("FULL_PROFILE_METADATA_INVALID", "Complete profile metadata is not a bounded regular file");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.lstatSync(file);
    if (opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw failure("FULL_PROFILE_STAGING_CHANGED", "Complete profile metadata changed during read");
    }
    return openMetadata(bytes, options);
  } finally { fs.closeSync(fd); }
}

/** First capture a coherent stopped tree, validate credentials on its owned copy,
 * then authenticate that report and linked-proxy secrets inside the final blob. */
export async function captureFullProfileTransfer(options: TransferOptions & {
  profileDir: string; sourcePlatform: string; browserVersion?: string; environment: FullProfileEnvironment;
}): Promise<{ body: Buffer; descriptor: FullProfileArtifact; credentials: ProfileCredentialReport }> {
  check(options);
  const source = identityForManagedProfile(options.engine, platform(options.sourcePlatform), options.dirId);
  if (source.engine === "chromium" && source.platform === "win32") throw failure("FULL_PROFILE_CREDENTIALS_UNSUPPORTED", "Windows OS-bound browser credentials require a native export adapter; no incomplete snapshot was published");
  const sourceAdapter = adapter(source);
  let frozen: PreparedFullProfile | undefined, result: { body: Buffer; descriptor: FullProfileArtifact; credentials: ProfileCredentialReport } | undefined, error: unknown;
  try {
    frozen = await stageFullProfileCapture(options);
    check(options);
    const report = await inspectProfileCredentials({ ...credentialOptions(frozen, source, options), sourceAdapter });
    check(options);
    if (report.status === "source-codec-required") throw failure("FULL_PROFILE_CREDENTIALS_UNSUPPORTED", "The source browser encryption backend cannot be migrated by this build");
    const expected: TransferMetadata = { version: 1, ...options.environment, source, credentials: report };
    const metadata = await sealMetadata(expected, options);
    let extra: Buffer | undefined;
    try {
      const captured = await captureStagedFullProfile({ ...options, prepared: frozen,
        extraEntries: [{ path: META_PATH, data: metadata }] });
      const verified = await verifyFullProfileArtifact({ ...options, ...captured, extraPath: META_PATH, maxExtraBytes: MAX_METADATA + 52 });
      extra = verified.extra;
      const readback = await openMetadata(extra, options);
      check(options);
      if (verified.manifest.extraEntries.length !== 1 || verified.manifest.extraEntries[0].path !== META_PATH ||
          JSON.stringify(readback) !== JSON.stringify(expected)) {
        throw failure("FULL_PROFILE_READBACK_MISMATCH", "Complete profile readback mismatch");
      }
      check(options);
      result = { ...captured, credentials: report };
    } finally { metadata.fill(0); extra?.fill(0); }
  } catch (cause) { error = cause; }
  finally {
    sourceAdapter?.dispose?.();
    if (frozen) {
      try { await disposePreparedFullProfileAsync(frozen); }
      catch (cause) {
        if (!error) error = cause;
        else error = Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}; full-profile snapshot cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause: error }),
          { code: (error as { code?: string }).code || "FULL_PROFILE_FAILED", errors: [error, cause] });
      }
    }
  }
  if (error) throw error;
  check(options); return result!;
}

function safeMember(root: string, relative: string): string {
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || relative.split("/").some(p => !p || p === "." || p === "..")) {
    throw failure("FULL_PROFILE_CREDENTIAL_PATH_INVALID", "Credential conversion produced an invalid profile path");
  }
  const owner = fs.lstatSync(root);
  if (!owner.isDirectory() || owner.isSymbolicLink()) throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential staging root is unsafe");
  const parts = relative.split("/"); let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part); const info = fs.lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure("FULL_PROFILE_CREDENTIAL_PATH_INVALID", "Credential conversion parent is unsafe");
  }
  return path.join(root, relative);
}
/** A path spelling is not an ownership witness. Retain every directory identity,
 * including the root, so a post-await caller cannot mutate a substituted tree. */
function credentialMemberWitness(root: string, relative: string) {
  const file = safeMember(root, relative), ancestors = [root]; let parent = root;
  for (const part of relative.split("/").slice(0, -1)) { parent = path.join(parent, part); ancestors.push(parent); }
  const parents = ancestors.map(directory => ({ directory, stat: fs.lstatSync(directory) })), stat = fs.lstatSync(file);
  return { file, stat, assertUnchanged(): void {
    safeMember(root, relative);
    for (const before of parents) {
      const current = fs.lstatSync(before.directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.stat.dev || current.ino !== before.stat.ino || current.mode !== before.stat.mode) {
        throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential directory ownership changed after readback");
      }
    }
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size ||
        current.mode !== stat.mode || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs || current.nlink !== stat.nlink || current.nlink !== 1) {
      throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential member changed after readback");
    }
  } };
}
async function boundedChunks(length: number, options: TransferOptions, visit: (offset: number, length: number) => void): Promise<void> {
  let offset = 0;
  while (offset < length) {
    check(options);
    const batch = () => {
      const started = Date.now(), end = Math.min(length, offset + 4 * 1024 * 1024);
      do {
        check(options); const bytes = Math.min(64 * 1024, length - offset);
        visit(offset, bytes); offset += bytes;
      } while (offset < end && Date.now() - started < 16);
    };
    if (options.guard.runSynchronous) options.guard.runSynchronous(batch); else batch();
    check(options);
    if (offset < length) { await nextTurn(); check(options); }
  }
}
async function digestCredentialFile(file: string, options: TransferOptions, destinationFd?: number): Promise<string> {
  check(options); const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > 64 * 1024 * 1024) throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential source is not an owned bounded file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  const unchanged = (stat: fs.Stats) => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
    stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs && stat.isFile() && stat.nlink === before.nlink;
  try {
    if (!unchanged(fs.fstatSync(fd))) throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential source ownership changed");
    await boundedChunks(before.size, options, (offset, bytes) => {
      let read = 0;
      while (read < bytes) {
        const n = fs.readSync(fd, buffer, read, bytes - read, offset + read);
        if (n <= 0 || n > bytes - read) throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential readback made no progress");
        read += n;
      }
      hash.update(buffer.subarray(0, bytes));
      if (destinationFd !== undefined) {
        let written = 0;
        while (written < bytes) {
          const n = fs.writeSync(destinationFd, buffer, written, bytes - written, offset + written);
          if (n <= 0 || n > bytes - written) throw failure("FULL_PROFILE_CREDENTIAL_READBACK_FAILED", "Credential publication made no progress");
          written += n;
        }
      }
    });
    check(options);
    if (!unchanged(fs.fstatSync(fd)) || !unchanged(fs.lstatSync(file))) throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential source changed during readback");
    return hash.digest("hex");
  } finally { buffer.fill(0); fs.closeSync(fd); }
}
interface CredentialChanges {
  changedPaths: string[];
  expectations: { files: FullProfileMember[]; removedPaths: string[] };
}
async function applyCredentialChanges(prepared: PreparedFullProfile, converted: Awaited<ReturnType<typeof convertProfileCredentials>>, options: TransferOptions): Promise<CredentialChanges> {
  const inventory = new Map(prepared.manifest.files.map(member => [member.path, member]));
  const outputOwner = fs.lstatSync(converted.outputDirectory);
  if (!outputOwner.isDirectory() || outputOwner.isSymbolicLink() || outputOwner.dev !== converted.outputOwner.dev || outputOwner.ino !== converted.outputOwner.ino) {
    throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential conversion output ownership changed");
  }
  // Keep the converter's verified bytes, not hashes re-derived from mutable
  // staging after subsequent copies, metadata scans or observer turns.
  const expectations = { files: converted.replacements.map(replacement => ({ path: replacement.relativePath, size: replacement.bytes, sha256: replacement.sha256 })),
    removedPaths: [...converted.removeRelativePaths] };
  const changed: string[] = [];
  for (const replacement of converted.replacements) {
    check(options);
    const original = inventory.get(replacement.relativePath);
    if (!original) throw failure("FULL_PROFILE_CREDENTIAL_PATH_INVALID", "Credential conversion may only replace authenticated database members");
    const targetWitness = credentialMemberWitness(prepared.directory, replacement.relativePath), sourceWitness = credentialMemberWitness(converted.outputDirectory, replacement.relativePath);
    const target = targetWitness.file, source = sourceWitness.file;
    if (source !== path.resolve(replacement.outputPath)) throw failure("FULL_PROFILE_CREDENTIAL_PATH_INVALID", "Credential output path mismatch");
    const previous = targetWitness.stat, next = sourceWitness.stat;
    if (!previous.isFile() || previous.isSymbolicLink() || !next.isFile() || next.isSymbolicLink() || next.nlink !== 1 || next.size !== replacement.bytes ||
        next.size > 64 * 1024 * 1024 || await digestCredentialFile(target, options) !== original.sha256) {
      throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential database changed before conversion publication");
    }
    check(options); targetWitness.assertUnchanged(); sourceWitness.assertUnchanged();
    const temp = path.join(path.dirname(target), ".credential-publish-" + randomBytes(12).toString("hex"));
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      if (await digestCredentialFile(source, options, fd) !== replacement.sha256) throw failure("FULL_PROFILE_CREDENTIAL_READBACK_FAILED", "Credential conversion readback mismatch");
      check(options); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    check(options);
    targetWitness.assertUnchanged(); sourceWitness.assertUnchanged();
    if (fs.lstatSync(converted.outputDirectory).dev !== outputOwner.dev || fs.lstatSync(converted.outputDirectory).ino !== outputOwner.ino) throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential publication ownership changed");
    fs.renameSync(temp, target);
    if (await digestCredentialFile(target, options) !== replacement.sha256) throw failure("FULL_PROFILE_CREDENTIAL_READBACK_FAILED", "Credential database publication readback mismatch");
    changed.push(replacement.relativePath);
  }
  for (const relative of converted.removeRelativePaths) {
    check(options);
    const original = inventory.get(relative);
    if (!original || !/(?:-wal|-shm|-journal)$/.test(relative)) throw failure("FULL_PROFILE_CREDENTIAL_PATH_INVALID", "Invalid credential sidecar removal");
    const witness = credentialMemberWitness(prepared.directory, relative), file = witness.file, stat = witness.stat;
    if (!stat.isFile() || stat.isSymbolicLink() || await digestCredentialFile(file, options) !== original.sha256) throw failure("FULL_PROFILE_STAGING_CHANGED", "Credential sidecar changed before removal");
    // This caller continuation is later than digestCredentialFile's own final
    // check. Re-prove the original file AND ancestor identities before unlink.
    check(options); witness.assertUnchanged();
    fs.unlinkSync(file); changed.push(relative);
  }
  check(options); return { changedPaths: changed, expectations };
}

/** Nothing in the live receiver is changed until its native credential codec has
 * verified the converted database and the derived full-tree inventory is sealed. */
export async function prepareFullProfileTransfer(options: TransferOptions & {
  body: Buffer; descriptor: FullProfileArtifact; receiverPlatform: string; profileHash: string;
}): Promise<{ prepared: PreparedFullProfile; credentials: ProfileCredentialReport; environment: FullProfileEnvironment }> {
  let prepared = await prepareFullProfile(options);
  const metadata = await readMetadata(prepared, options);
  check(options);
  if (metadata.profileHash !== options.profileHash) throw failure("FULL_PROFILE_CONFIG_MISMATCH", "Profile configuration does not match its encrypted data snapshot");
  const source = identityForManagedProfile(options.engine, platform(prepared.sourceManifest.sourcePlatform), options.dirId);
  if (JSON.stringify(metadata.source) !== JSON.stringify(source)) throw failure("FULL_PROFILE_CREDENTIAL_IDENTITY_MISMATCH", "Credential provenance does not match its authenticated snapshot");
  const receiver = identityForManagedProfile(options.engine, platform(options.receiverPlatform), options.dirId);
  const sourceAdapter = adapter(source), receiverAdapter = adapter(receiver);
  try {
    const converted = await convertProfileCredentials({ ...credentialOptions(prepared, source, options), sourceAdapter,
      receiver, receiverAdapter, expectedFirefoxPair: metadata.credentials.firefoxPair });
    let changed: CredentialChanges;
    try { changed = await applyCredentialChanges(prepared, converted, options); }
    finally { disposeConvertedProfileCredentials(converted); }
    prepared = await resealPreparedFullProfileAsync({ prepared, guard: options.guard, signal: options.signal,
      onProgress: options.onProgress, ...changed });
    check(options);
    return { prepared, credentials: converted.report, environment: { profileHash: metadata.profileHash, ...(metadata.proxy ? { proxy: metadata.proxy } : {}) } };
  } finally { sourceAdapter?.dispose?.(); receiverAdapter?.dispose?.(); }
}

export function fullProfileProxyHash(proxy: Pick<ProxyConfig, "type" | "host" | "port" | "bypassList">): string {
  return sha256(Buffer.from(JSON.stringify([proxy.type, proxy.host, proxy.port, proxy.bypassList ?? []])));
}
