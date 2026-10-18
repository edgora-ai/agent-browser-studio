import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { ensureArchiveDirectory, writeZipArchive } from "./zip-writer.js";
import { getAppDataDir, getConfig } from "./config-manager.js";
import { transact } from "./config/store.js";
import { downloadFileWithCurl } from "./proxy-detector.js";


export interface ExtensionRepositoryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "chrome-web-store" | "local";
  chromeStoreUrl?: string;
  updateUrl?: string;
  unpackedPath: string;
  packageHash: string;
  manifestHash: string;
  shared: boolean;
  tags: string[];
  addedAt: number;
  updatedAt: number;
}

export interface ExtensionRepositoryCleanupWarning {
  code: "EXTENSION_REPOSITORY_CLEANUP_FAILED";
  path: string;
  message: string;
}

export interface ExtensionRepositoryCommitReceipt {
  committed: true;
  cleanupWarnings: ExtensionRepositoryCleanupWarning[];
}

/** Return-only facts: never store the receipt as extension metadata. */
export interface ExtensionRepositoryMutationResult extends ExtensionRepositoryEntry {
  repositoryCommit: ExtensionRepositoryCommitReceipt;
}

export class ExtensionRepositoryRecoveryRequiredError extends Error {
  readonly code = "EXTENSION_REPOSITORY_RECOVERY_REQUIRED";
  constructor(
    readonly extensionId: string,
    readonly recoveryPaths: string[],
    readonly recoveryReceiptPath: string,
    detail: string,
    cause?: unknown,
  ) {
    super(`EXTENSION_REPOSITORY_RECOVERY_REQUIRED: ${cause === undefined ? "Unfinished extension update" : errorMessage(cause)}; recovery required for ${extensionId}: ${detail}. Retained paths: ${recoveryPaths.join(", ")}; receipt: ${recoveryReceiptPath}`, { cause });
    this.name = "ExtensionRepositoryRecoveryRequiredError";
  }
}

const EXTENSION_ID_RE = /^(?:[a-p]{32}|local_[a-z0-9]{8,40})$/;
const CHROME_PRODUCT_VERSION = "149.0";
const MAX_EXTENSION_PACKAGE_BYTES = 80 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

function assertExtensionNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Extension installation cancelled");
}

export function listExtensionRepository(filter?: string): ExtensionRepositoryEntry[] {
  const cfg = getConfig() as any;
  const entries = Object.values(cfg.extensionRepository || {}) as ExtensionRepositoryEntry[];
  const normalizedFilter = String(filter || "").trim().toLowerCase();
  const filtered = normalizedFilter
    ? entries.filter((entry) => [entry.id, entry.name, entry.description, ...entry.tags].some((value) => String(value || "").toLowerCase().includes(normalizedFilter)))
    : entries;
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

export function getRepositoryExtension(extId: string): ExtensionRepositoryEntry | null {
  validateExtensionId(extId);
  const cfg = getConfig() as any;
  return cfg.extensionRepository?.[extId] || null;
}

export async function addOrUpdateChromeStoreExtension(extId: string, opts: { shared?: boolean; tags?: string[] } = {}): Promise<ExtensionRepositoryMutationResult> {
  validateExtensionId(extId);
  const repoDir = prepareRepositoryEntryDir(extId);
  const tempDir = fs.mkdtempSync(path.join(repoDir, ".tmp-"));
  fs.chmodSync(tempDir, 0o700);
  const stagingDir = path.join(tempDir, "extract");
  const tmpCrx = path.join(tempDir, "package.crx");
  const tmpZip = path.join(tempDir, "package.zip");
  let repositoryCommit: ExtensionRepositoryCommitReceipt | undefined;

  try {
    const crxUrl = buildChromeCrxUrl(extId);
    downloadFileWithCurl(crxUrl, tmpCrx, { timeoutMs: 30000 });
    const crxStat = fs.existsSync(tmpCrx) ? fs.statSync(tmpCrx) : null;
    if (!crxStat || crxStat.size < 100) {
      throw new Error("Failed to download extension package");
    }
    if (crxStat.size > MAX_EXTENSION_PACKAGE_BYTES) {
      throw new Error("Extension package is too large");
    }

    let archivePath = tmpCrx;
    try {
      assertSafeZipEntries(archivePath);
    } catch (_zipError) {
      const crxData = fs.readFileSync(tmpCrx);
      const zipStart = crxData.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      if (zipStart <= 0) throw new Error("Could not extract CRX package");
      fs.writeFileSync(tmpZip, crxData.subarray(zipStart), { mode: 0o600 });
      archivePath = tmpZip;
      assertSafeZipEntries(archivePath);
    }

    extractZipSafely(archivePath, stagingDir);
    const manifestDir = findManifestDir(stagingDir);
    if (!manifestDir) throw new Error("Extension manifest.json not found");
    validateExtractedExtension(stagingDir);

    const manifestPath = path.join(manifestDir, "manifest.json");
    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw) as { name?: string; version?: string; description?: string; default_locale?: string };
    const packageHash = hashFile(tmpCrx);
    const manifestHash = crypto.createHash("sha512").update(manifestRaw).digest("hex");
    const finalUnpackedDir = path.join(repoDir, "current");
    const finalPackagePath = path.join(repoDir, "package.crx");
    const previous = getRepositoryExtension(extId);
    const now = Date.now();

    const entry: ExtensionRepositoryEntry = {
      id: extId,
      name: resolveManifestText(stagingDir, manifest, "name") || manifest.name || extId,
      version: manifest.version || "?",
      description: resolveManifestText(stagingDir, manifest, "description") || manifest.description || "",
      source: "chrome-web-store",
      chromeStoreUrl: `https://chromewebstore.google.com/detail/${extId}`,
      updateUrl: crxUrl,
      unpackedPath: finalUnpackedDir,
      packageHash,
      manifestHash,
      shared: opts.shared ?? previous?.shared ?? false,
      tags: normalizeTags(opts.tags ?? previous?.tags ?? []),
      addedAt: previous?.addedAt || now,
      updatedAt: now,
    };

    repositoryCommit = commitRepositoryUpdate(stagingDir, finalUnpackedDir, tmpCrx, finalPackagePath, () => saveRepositoryEntry(entry));
    return { ...entry, repositoryCommit };
  } finally {
    cleanupRepositoryStaging(tempDir, repositoryCommit);
  }
}

/**
 * Install an extension from a local CRX/ZIP file or an unpacked directory.
 * Reuses the same extract/validate/commit pipeline as the Chrome Store path.
 * Generates a random local ID (local_<hex>) since local packages don't carry a
 * Chrome Web Store 32-char ID. Local extensions cannot auto-update.
 */
export async function installLocalExtension(localPath: string, opts: { shared?: boolean; tags?: string[]; signal?: AbortSignal } = {}): Promise<ExtensionRepositoryMutationResult> {
  const signal = opts.signal;
  assertExtensionNotAborted(signal);
  const resolved = path.resolve(String(localPath || "").trim());
  // Fail closed on sensitive reads (R7 #40): /etc/hosts-style paths pass
  // existsSync and then surface content through error oracles / staging.
  // Reuse the archive-guard ancestor walk — extension staging is the same
  // arbitrary-local-path-read surface as archive import.
  {
    const { assertNoSensitiveLocalPath } = await import("./archive-path-guard.js");
    assertNoSensitiveLocalPath(resolved);
  }
  if (!fs.existsSync(resolved)) throw new Error(`Local extension path does not exist: ${resolved}`);

  const localStat = fs.lstatSync(resolved);
  if (localStat.isSymbolicLink()) throw new Error("Local extension source must not be a symlink");
  const isDir = localStat.isDirectory();
  const extId = "local_" + crypto.randomBytes(12).toString("hex");
  validateExtensionId(extId);

  const repoDir = prepareRepositoryEntryDir(extId);
  const tempDir = fs.mkdtempSync(path.join(repoDir, ".tmp-"));
  fs.chmodSync(tempDir, 0o700);
  const stagingDir = path.join(tempDir, "extract");
  const tmpZip = path.join(tempDir, "package.zip");
  let repositoryCommit: ExtensionRepositoryCommitReceipt | undefined;

  try {
    let archivePath = "";
    assertExtensionNotAborted(signal);
    if (isDir) {
      // Unpacked directory: validate then copy into staging.
      const manifestDir = findManifestDir(resolved);
      if (!manifestDir) throw new Error("Extension manifest.json not found in directory");
      validateExtractedExtension(resolved);
      fs.mkdirSync(stagingDir, { recursive: true });
      copyDirContents(resolved, stagingDir, signal);
    } else {
      // File: must be CRX or ZIP.
      assertExtensionNotAborted(signal);
      const stat = fs.statSync(resolved);
      if (stat.size < 100) throw new Error("Extension package is too small");
      if (stat.size > MAX_EXTENSION_PACKAGE_BYTES) throw new Error("Extension package is too large");
      archivePath = resolved;
      try {
        assertSafeZipEntries(archivePath);
      } catch (_zipError) {
        assertExtensionNotAborted(signal);
        // CRX: strip header, find ZIP magic.
        const crxData = fs.readFileSync(resolved);
        const zipStart = crxData.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        if (zipStart <= 0) throw new Error("Could not find ZIP payload in CRX package");
        fs.writeFileSync(tmpZip, crxData.subarray(zipStart), { mode: 0o600 });
        archivePath = tmpZip;
        assertSafeZipEntries(archivePath);
      }
      extractZipSafely(archivePath, stagingDir, signal);
    }

    assertExtensionNotAborted(signal);
    const manifestDir = findManifestDir(stagingDir);
    if (!manifestDir) throw new Error("Extension manifest.json not found after extraction");
    validateExtractedExtension(stagingDir);

    const manifestPath = path.join(manifestDir, "manifest.json");
    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw) as { name?: string; version?: string; description?: string; manifest_version?: number };
    if (!manifest.name) throw new Error("Extension manifest must declare a name");
    if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) {
      throw new Error("Extension manifest_version must be 2 or 3");
    }

    const manifestHash = crypto.createHash("sha512").update(manifestRaw).digest("hex");
    const packageHash = isDir ? manifestHash : hashFile(archivePath || resolved);
    const finalUnpackedDir = path.join(repoDir, "current");
    const finalPackagePath = path.join(repoDir, "package.zip");
    const previous = getRepositoryExtension(extId);
    const now = Date.now();

    const entry: ExtensionRepositoryEntry = {
      id: extId,
      name: resolveManifestText(stagingDir, manifest, "name") || manifest.name || extId,
      version: manifest.version || "?",
      description: resolveManifestText(stagingDir, manifest, "description") || manifest.description || "",
      source: "local",
      unpackedPath: finalUnpackedDir,
      packageHash,
      manifestHash,
      shared: opts.shared ?? previous?.shared ?? false,
      tags: normalizeTags(opts.tags ?? previous?.tags ?? []),
      addedAt: previous?.addedAt || now,
      updatedAt: now,
    };

    assertExtensionNotAborted(signal);
    // For directories there's no package file; commit only the unpacked dir.
    repositoryCommit = commitRepositoryUpdate(stagingDir, finalUnpackedDir, isDir ? "" : archivePath, isDir ? "" : finalPackagePath, () => saveRepositoryEntry(entry));
    return { ...entry, repositoryCommit };
  } finally {
    cleanupRepositoryStaging(tempDir, repositoryCommit);
  }
}

/** Copy directory contents (files + subdirs) into dest, skipping the tmp dir itself. */
function copyDirContents(src: string, dest: string, signal?: AbortSignal): void {
  assertExtensionNotAborted(signal);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    assertExtensionNotAborted(signal);
    if (entry.name.startsWith(".tmp-")) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirContents(s, d, signal);
    else if (entry.isFile()) {
      // Fail closed if the entry changed or cannot be checked while copying.
      if (fs.lstatSync(s).isSymbolicLink()) throw new Error("Extension source contains symlinks");
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Update a repository extension. Dispatches by source:
 *  - chrome-web-store: re-download from Chrome Web Store
 *  - local: no remote source → cannot auto-update; caller should re-import.
 */
export async function updateRepositoryExtension(extId: string): Promise<ExtensionRepositoryMutationResult> {
  const entry = getRepositoryExtension(extId);
  if (!entry) throw new Error("Extension is not in the repository");
  if (entry.source === "chrome-web-store") {
    return addOrUpdateChromeStoreExtension(extId);
  }
  // local source: no updateUrl, no chrome-store ID → cannot refresh.
  throw new Error("Local extensions cannot auto-update; re-import from the source path.");
}

export function deleteRepositoryExtension(extId: string): boolean {
  validateExtensionId(extId);
  const repoDir = getExtensionRepoEntryDir(extId);
  assertRepositoryTargetWritable(extId);
  getConfig();
  const deleted = transact((draft) => {
    if (!draft.extensionRepository?.[extId]) return false;
    delete draft.extensionRepository[extId];
    for (const profile of Object.values(draft.browserProfiles || {}) as any[]) {
      if (profile.extensions) delete profile.extensions[extId];
    }
    return true;
  });
  if (deleted && fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  return deleted;
}

export interface PreparedSyncedExtensionPackage {
  stagedDir: string;
  archivePath: string;
  packagePath: string;
  manifest: { name?: string; version?: string; description?: string; manifest_version?: number };
  packageHash: string;
  manifestHash: string;
}

/** Prepare only: stagingRoot must be absent under a caller-owned temporary
 * directory. The caller owns its cleanup, including on validation failure.
 * No repository/config mutation; Pull can preflight every package first. */
export function prepareSyncedExtensionPackage(extId: string, packagePath: string, remoteEntry: Partial<ExtensionRepositoryEntry>, stagingRoot: string, signal?: AbortSignal): PreparedSyncedExtensionPackage {
  validateExtensionId(extId);
  assertExtensionNotAborted(signal);
  const resolved = path.resolve(String(packagePath || "").trim());
  if (!fs.existsSync(resolved)) throw new Error(`Synced extension package does not exist: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Synced extension package must be a regular file, not a symlink");
  if (stat.size < 100) throw new Error("Synced extension package is too small");
  if (stat.size > MAX_EXTENSION_PACKAGE_BYTES) throw new Error("Synced extension package is too large");
  const parent = fs.lstatSync(path.dirname(path.resolve(stagingRoot)));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Extension staging parent must be a real directory");
  fs.mkdirSync(stagingRoot, { mode: 0o700 }); // exclusive: never merge with existing staging
  const stagedDir = path.join(stagingRoot, "extract");
  const tmpZip = path.join(stagingRoot, "package.zip");
  const snapshotPath = path.join(stagingRoot, "downloaded-package");
  fs.copyFileSync(resolved, snapshotPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(snapshotPath, 0o600);
  const snapshotSize = fs.statSync(snapshotPath).size;
  if (snapshotSize < 100 || snapshotSize > MAX_EXTENSION_PACKAGE_BYTES) throw new Error("Synced extension package snapshot has an invalid size");
  let archivePath = snapshotPath;
  try {
    assertSafeZipEntries(archivePath);
  } catch (_zipError) {
    assertExtensionNotAborted(signal);
    const crxData = fs.readFileSync(snapshotPath);
    const zipStart = crxData.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (zipStart <= 0) throw new Error("Could not find ZIP payload in synced extension package");
    fs.writeFileSync(tmpZip, crxData.subarray(zipStart), { mode: 0o600, flag: "wx" });
    archivePath = tmpZip;
    assertSafeZipEntries(archivePath);
  }
  extractZipSafely(archivePath, stagedDir, signal);
  assertExtensionNotAborted(signal);
  const manifestDir = findManifestDir(stagedDir);
  if (!manifestDir) throw new Error("Extension manifest.json not found after extraction");
  validateExtractedExtension(stagedDir);
  const manifestRaw = fs.readFileSync(path.join(manifestDir, "manifest.json"), "utf-8");
  const manifest = JSON.parse(manifestRaw) as PreparedSyncedExtensionPackage["manifest"];
  if (!manifest.name) throw new Error("Extension manifest must declare a name");
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error("Extension manifest_version must be 2 or 3");
  const manifestHash = crypto.createHash("sha512").update(manifestRaw).digest("hex");
  const publishedPackage = remoteEntry.source === "chrome-web-store" ? snapshotPath : archivePath;
  const packageHash = hashFile(publishedPackage);
  if (!/^[0-9a-f]{128}$/i.test(String(remoteEntry.manifestHash || ""))) throw new Error("Synced extension manifest hash is required");
  if (!/^[0-9a-f]{128}$/i.test(String(remoteEntry.packageHash || ""))) throw new Error("Synced extension package hash is required");
  if (remoteEntry.manifestHash !== manifestHash) throw new Error("Synced extension manifest hash does not match package contents");
  if (remoteEntry.packageHash !== packageHash) throw new Error("Synced extension package hash does not match downloaded package");
  return { stagedDir, archivePath, packagePath: publishedPackage, manifest, packageHash, manifestHash };
}

export interface ExtensionSyncSnapshot {
  /** Portable metadata. No local path or transient repository commit receipt. */
  entry: ExtensionRepositoryEntry;
  /** Owned, read-only package bytes; never a live repository/source path. */
  packagePath: string;
  /** Invoke ONLY after the authoritative cloud manifest has been published.
   * Null means the original source diverged; preserve it as locally dirty. */
  commitLocalRepair?: () => Promise<ExtensionRepositoryMutationResult | null>;
}

interface ExtensionTreeNode {
  name: string;
  directory: boolean;
  stat: fs.Stats;
  hash?: string;
}

class ExtensionSyncSourceChangedError extends Error {
  constructor(detail: string) { super(`Extension sync source changed or is unsafe: ${detail}`); }
}

function sameExtensionSourceStat(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Bounded, no-follow reads. When copying, bind the hash and copied bytes to
 * the same opened source, rather than hashing one path and copying another. */
function readExtensionSnapshotFile(file: string, expected: fs.Stats, signal?: AbortSignal, copyTo?: string): string {
  ensureArchiveDirectory(path.dirname(file));
  const input = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let output: number | undefined;
  try {
    if (!expected.isFile() || !sameExtensionSourceStat(fs.fstatSync(input), expected)) throw new ExtensionSyncSourceChangedError(file);
    if (copyTo) output = fs.openSync(copyTo, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const hash = crypto.createHash("sha512");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < expected.size) {
      assertExtensionNotAborted(signal);
      const wanted = Math.min(chunk.length, expected.size - position);
      const count = fs.readSync(input, chunk, 0, wanted, position);
      if (!Number.isInteger(count) || count <= 0 || count > wanted) throw new ExtensionSyncSourceChangedError(file);
      hash.update(chunk.subarray(0, count));
      if (output !== undefined) {
        let written = 0;
        while (written < count) {
          const amount = fs.writeSync(output, chunk, written, count - written, position + written);
          if (!Number.isInteger(amount) || amount <= 0 || amount > count - written) throw new Error("Extension snapshot write made no valid progress");
          written += amount;
        }
      }
      position += count;
    }
    if (fs.readSync(input, chunk, 0, 1, expected.size) !== 0) throw new ExtensionSyncSourceChangedError(file);
    ensureArchiveDirectory(path.dirname(file));
    if (!sameExtensionSourceStat(fs.fstatSync(input), expected) || !sameExtensionSourceStat(fs.lstatSync(file), expected)) throw new ExtensionSyncSourceChangedError(file);
    if (output !== undefined) fs.fsyncSync(output);
    return hash.digest("hex");
  } finally {
    try { fs.closeSync(input); } finally { if (output !== undefined) fs.closeSync(output); }
  }
}

function captureExtensionTree(root: string, signal?: AbortSignal): ExtensionTreeNode[] {
  const nodes: ExtensionTreeNode[] = [];
  let totalBytes = 0;
  function visit(directory: string, relative: string): void {
    assertExtensionNotAborted(signal);
    ensureArchiveDirectory(directory);
    const before = fs.lstatSync(directory);
    nodes.push({ name: relative, directory: true, stat: before });
    if (nodes.length - 1 > MAX_ZIP_ENTRIES) throw new ExtensionSyncSourceChangedError("too many extension files");
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
      assertExtensionNotAborted(signal);
      const file = path.join(directory, name);
      const entryName = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new ExtensionSyncSourceChangedError(`symlink or non-regular entry: ${entryName}`);
      validateZipEntryName(entryName);
      if (stat.isDirectory()) visit(file, entryName);
      else {
        totalBytes += stat.size;
        if (stat.size > MAX_ZIP_ENTRY_BYTES || totalBytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) throw new ExtensionSyncSourceChangedError("extension contents exceed size limits");
        nodes.push({ name: entryName, directory: false, stat, hash: readExtensionSnapshotFile(file, stat, signal) });
        if (nodes.length - 1 > MAX_ZIP_ENTRIES) throw new ExtensionSyncSourceChangedError("too many extension files");
      }
    }
    ensureArchiveDirectory(directory);
    if (!sameExtensionSourceStat(fs.lstatSync(directory), before) || !isDeepStrictEqual(fs.readdirSync(directory).sort(), names)) throw new ExtensionSyncSourceChangedError(directory);
  }
  visit(root, "");
  return nodes;
}

function sameExtensionTree(a: ExtensionTreeNode[], b: ExtensionTreeNode[], identities = false): boolean {
  return a.length === b.length && a.every((node, i) => {
    const other = b[i];
    return node.name === other.name && node.directory === other.directory && node.hash === other.hash
      && (node.directory || node.stat.size === other.stat.size) && (!identities || sameExtensionSourceStat(node.stat, other.stat));
  });
}

function portableExtensionSnapshotEntry(entry: ExtensionRepositoryEntry, packageHash: string, manifestHash: string): ExtensionRepositoryEntry {
  return {
    id: entry.id, name: entry.name, version: entry.version, description: entry.description, source: entry.source,
    ...(entry.chromeStoreUrl !== undefined ? { chromeStoreUrl: entry.chromeStoreUrl } : {}),
    ...(entry.updateUrl !== undefined ? { updateUrl: entry.updateUrl } : {}),
    unpackedPath: "", packageHash, manifestHash, shared: entry.shared, tags: [...entry.tags],
    addedAt: entry.addedAt, updatedAt: entry.updatedAt,
  };
}

/** Snapshot only: stagingRoot must be absent below a caller-owned temporary
 * directory, outside the repository. The caller cleans it even on failure.
 * Existing packages must match ALL current unpacked files, not just manifest.
 * Legacy unpacked installations become verified ZIPs without publishing locally. */
export async function captureRepositoryExtensionForSync(entry: ExtensionRepositoryEntry, stagingRoot: string, signal?: AbortSignal): Promise<ExtensionSyncSnapshot> {
  validateExtensionId(entry.id);
  assertExtensionNotAborted(signal);
  const original = getRepositoryExtension(entry.id);
  if (!original || !isDeepStrictEqual(portableExtensionSnapshotEntry(entry, entry.packageHash, entry.manifestHash), portableExtensionSnapshotEntry(original, original.packageHash, original.manifestHash))
    || path.resolve(entry.unpackedPath) !== path.resolve(original.unpackedPath)) throw new ExtensionSyncSourceChangedError("repository metadata");
  const source = structuredClone(original);
  assertRepositoryTargetWritable(source.id);
  const repository = getExtensionRepoEntryDir(source.id);
  ensureArchiveDirectory(repository);
  const sourceDirectories = [getAppDataDir(), path.dirname(repository), repository].map((directory) => ({ directory, stat: fs.lstatSync(directory) }));
  const current = path.join(repository, "current");
  if (path.resolve(source.unpackedPath) !== current) throw new ExtensionSyncSourceChangedError("unexpected unpacked path");
  stagingRoot = path.resolve(stagingRoot);
  ensureArchiveDirectory(path.dirname(stagingRoot));
  const realStaging = path.join(fs.realpathSync(path.dirname(stagingRoot)), path.basename(stagingRoot));
  if (isPathInside(realStaging, fs.realpathSync(path.dirname(repository)))) throw new Error("Extension sync staging must be outside the repository");
  if (statIfPresent(stagingRoot)) throw new Error("Extension sync staging already exists");
  const packages = ["package.zip", "package.crx"].map((name) => ({ file: path.join(repository, name), stat: statIfPresent(path.join(repository, name)) }));
  for (const pkg of packages) if (pkg.stat && (!pkg.stat.isFile() || pkg.stat.isSymbolicLink())) throw new ExtensionSyncSourceChangedError("package must be a regular file, not a symlink");
  const packaged = packages.find((pkg) => pkg.stat && pkg.file.endsWith(source.source === "chrome-web-store" ? ".crx" : ".zip")) || packages.find((pkg) => pkg.stat);
  if (!packaged && (source.source !== "local" || source.packageHash !== source.manifestHash)) throw new Error("Repository extension package is missing");
  if (packaged && (packaged.stat!.size < 100 || packaged.stat!.size > MAX_EXTENSION_PACKAGE_BYTES)) throw new Error("Repository extension package has an invalid size");
  const tree = captureExtensionTree(current, signal);
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  let prepared: PreparedSyncedExtensionPackage;
  let sourcePackageHash: string | undefined;
  if (packaged) {
    const pinned = path.join(stagingRoot, "source-package");
    sourcePackageHash = readExtensionSnapshotFile(packaged.file, packaged.stat!, signal, pinned);
    prepared = prepareSyncedExtensionPackage(source.id, pinned, source, path.join(stagingRoot, "verified"), signal);
  } else {
    // The store-method writer streams bytes; preflight its precise package size
    // against the extension cap, not zip-writer's more permissive generic cap.
    const entries = tree.filter((node) => node.name).map((node) => node.directory
      ? { name: `${node.name}/`, isDirectory: true as const }
      : { name: node.name, filePath: path.join(current, ...node.name.split("/")) });
    const packageBytes = tree.reduce((sum, node) => !node.name ? sum : sum + 76 + 2 * Buffer.byteLength(node.name + (node.directory ? "/" : ""), "utf8") + (node.directory ? 0 : node.stat.size), 22);
    if (packageBytes > MAX_EXTENSION_PACKAGE_BYTES) throw new Error("Extension sync package is too large");
    const manifest = tree.filter((node) => node.directory && node.name.split("/").filter(Boolean).length <= 4)
      .map((node) => tree.find((file) => !file.directory && file.name === (node.name ? `${node.name}/manifest.json` : "manifest.json"))).find(Boolean);
    if (!manifest?.hash) throw new Error("Extension manifest.json not found in directory");
    const zip = path.join(stagingRoot, "package.zip");
    await writeZipArchive(zip, entries);
    assertExtensionNotAborted(signal);
    prepared = prepareSyncedExtensionPackage(source.id, zip, { ...source, packageHash: hashFile(zip), manifestHash: manifest.hash }, path.join(stagingRoot, "verified"), signal);
  }
  if (!sameExtensionTree(tree, captureExtensionTree(prepared.stagedDir, signal))) throw new Error("Repository extension current contents do not match its package");
  if (!sameExtensionTree(tree, captureExtensionTree(current, signal), true) || !isDeepStrictEqual(getRepositoryExtension(source.id), source)) throw new ExtensionSyncSourceChangedError("repository content or metadata during capture");
  for (const pkg of packages) {
    const now = statIfPresent(pkg.file);
    if (pkg.stat ? !now || !sameExtensionSourceStat(pkg.stat, now) : now !== null) throw new ExtensionSyncSourceChangedError("repository package during capture");
  }
  if (packaged && readExtensionSnapshotFile(packaged.file, packaged.stat!, signal) !== sourcePackageHash) throw new ExtensionSyncSourceChangedError("repository package bytes during capture");
  assertExtensionNotAborted(signal);
  fs.chmodSync(prepared.packagePath, 0o400);
  const captured = portableExtensionSnapshotEntry(source, prepared.packageHash, prepared.manifestHash);
  const snapshot: ExtensionSyncSnapshot = { entry: structuredClone(captured), packagePath: prepared.packagePath };
  if (!packaged) {
    const sourceUnchanged = (activeUpdateDir?: string): boolean => {
      if (!isDeepStrictEqual(getRepositoryExtension(source.id), source)) return false;
      for (const original of sourceDirectories) {
        const stat = statIfPresent(original.directory);
        if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== original.stat.dev || stat.ino !== original.stat.ino) return false;
      }
      assertRepositoryTargetWritable(source.id, activeUpdateDir);
      const currentStat = statIfPresent(current);
      if (!currentStat || !sameExtensionSourceStat(currentStat, tree[0].stat)) return false;
      if (packages.some((pkg) => statIfPresent(pkg.file) !== null)) return false;
      try { return sameExtensionTree(tree, captureExtensionTree(current, signal), true) && isDeepStrictEqual(getRepositoryExtension(source.id), source); }
      catch (error) {
        if (error instanceof ExtensionSyncSourceChangedError || ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code || "")) return false;
        throw error;
      }
    };
    snapshot.commitLocalRepair = async () => {
      assertExtensionNotAborted(signal);
      if (!sourceUnchanged()) return null;
      try {
        const repair = prepareSyncedExtensionPackage(source.id, prepared.packagePath, captured, path.join(stagingRoot, "repair"), signal);
        const repaired: ExtensionRepositoryEntry = { ...source, packageHash: captured.packageHash, manifestHash: captured.manifestHash };
        const repositoryCommit = commitRepositoryUpdate(repair.stagedDir, current, repair.packagePath, path.join(repository, "package.zip"), (originalDirectory) => {
          // A filesystem writer can edit the original after the prepublication
          // guard. Recheck the moved original before its rescue copy is retired;
          // compensation then restores those edits instead of deleting them.
          const moved = originalDirectory ? captureExtensionTree(originalDirectory, signal) : [];
          if (!sameExtensionTree(tree, moved) || tree.some((node, i) => node.name
            ? !sameExtensionSourceStat(node.stat, moved[i].stat)
            : node.stat.dev !== moved[i].stat.dev || node.stat.ino !== moved[i].stat.ino || node.stat.mode !== moved[i].stat.mode
              || node.stat.size !== moved[i].stat.size || node.stat.mtimeMs !== moved[i].stat.mtimeMs)) {
            throw new ExtensionSyncSourceChangedError("original repository content before repair commit");
          }
          // The guard belongs INSIDE the live draft transaction: never reinsert
          // a deleted record or overwrite tags changed during publication.
          transact((draft) => {
            if (!isDeepStrictEqual(draft.extensionRepository?.[source.id], source)) throw new ExtensionSyncSourceChangedError("repository metadata before repair commit");
            draft.extensionRepository[source.id] = repaired;
          });
        }, (activeUpdateDir) => {
          assertExtensionNotAborted(signal);
          if (!sourceUnchanged(activeUpdateDir)) throw new ExtensionSyncSourceChangedError("repository before repair publication");
        });
        return { ...repaired, repositoryCommit };
      } catch (error) {
        if (error instanceof ExtensionSyncSourceChangedError) return null;
        throw error;
      }
    };
  }
  return snapshot;
}

export async function restoreSyncedExtensionPackage(extId: string, packagePath: string, remoteEntry: Partial<ExtensionRepositoryEntry>, signal?: AbortSignal): Promise<ExtensionRepositoryMutationResult> {
  validateExtensionId(extId);
  assertExtensionNotAborted(signal);
  const repoDir = prepareRepositoryEntryDir(extId);
  const tempDir = fs.mkdtempSync(path.join(repoDir, ".tmp-"));
  let repositoryCommit: ExtensionRepositoryCommitReceipt | undefined;
  try {
    const prepared = prepareSyncedExtensionPackage(extId, packagePath, remoteEntry, path.join(tempDir, "prepared"), signal);
    const { stagedDir, manifest, manifestHash, packageHash } = prepared;
    const finalUnpackedDir = path.join(repoDir, "current");
    const finalPackagePath = path.join(repoDir, remoteEntry.source === "chrome-web-store" ? "package.crx" : "package.zip");
    const previous = getRepositoryExtension(extId);
    const now = Date.now();
    const entry: ExtensionRepositoryEntry = {
      id: extId,
      name: typeof remoteEntry.name === "string" ? remoteEntry.name : resolveManifestText(stagedDir, manifest, "name") || manifest.name || extId,
      version: typeof remoteEntry.version === "string" ? remoteEntry.version : manifest.version || "?",
      description: typeof remoteEntry.description === "string" ? remoteEntry.description : resolveManifestText(stagedDir, manifest, "description") || manifest.description || "",
      source: remoteEntry.source === "chrome-web-store" ? "chrome-web-store" : "local",
      ...(typeof remoteEntry.chromeStoreUrl === "string" ? { chromeStoreUrl: remoteEntry.chromeStoreUrl } : {}),
      ...(typeof remoteEntry.updateUrl === "string" ? { updateUrl: remoteEntry.updateUrl } : {}),
      unpackedPath: finalUnpackedDir,
      packageHash,
      manifestHash,
      shared: remoteEntry.shared ?? previous?.shared ?? false,
      tags: normalizeTags(remoteEntry.tags ?? previous?.tags ?? []),
      addedAt: previous?.addedAt || now,
      updatedAt: now,
    };
    assertExtensionNotAborted(signal);
    repositoryCommit = commitRepositoryUpdate(stagedDir, finalUnpackedDir, prepared.packagePath, finalPackagePath, () => saveRepositoryEntry(entry));
    return { ...entry, repositoryCommit };
  } finally {
    cleanupRepositoryStaging(tempDir, repositoryCommit);
  }
}

export function setRepositoryExtensionMeta(extId: string, opts: { shared?: boolean; tags?: string[] }): ExtensionRepositoryEntry {
  validateExtensionId(extId);
  assertRepositoryTargetWritable(extId);
  getConfig();
  return transact((draft) => {
    const entry = draft.extensionRepository?.[extId];
    if (!entry) throw new Error("Extension is not in the repository");
    if (opts.shared !== undefined) entry.shared = Boolean(opts.shared);
    if (opts.tags !== undefined) entry.tags = normalizeTags(opts.tags);
    entry.updatedAt = Date.now();
    return entry as ExtensionRepositoryEntry;
  });
}

export function exportSharedExtensionRepository(): Array<Pick<ExtensionRepositoryEntry, "id" | "name" | "version" | "description" | "source" | "chromeStoreUrl" | "shared" | "tags">> {
  return listExtensionRepository().filter((entry) => entry.shared).map((entry) => ({
    id: entry.id,
    name: entry.name,
    version: entry.version,
    description: entry.description,
    source: entry.source,
    chromeStoreUrl: entry.chromeStoreUrl,
    shared: true,
    tags: entry.tags,
  }));
}

export const __extensionRepositoryTestHooks = {
  assertSafeZipEntries,
  extractZipSafely,
};

/** An archive may carry an enabled ID while the destination only has a stale
 * repository record. Use the same launch-path checks as the browser, not just
 * the presence of an entry in config.json, when reporting missing packages. */
export function hasInstalledRepositoryExtension(extId: string): boolean {
  const entry = getRepositoryExtension(extId);
  if (!entry?.unpackedPath) return false;
  try {
    return isValidRepositoryLaunchPath(extId, entry.unpackedPath);
  } catch (error) {
    console.warn(`Extension repository package unavailable for ${extId}:`, error);
    return false;
  }
}

export function getEnabledRepositoryExtensionPaths(dirId: string): string[] {
  const cfg = getConfig() as any;
  const profile = cfg.browserProfiles?.[dirId];
  const repository = cfg.extensionRepository || {};
  const enabled = profile?.extensions || {};
  const paths: string[] = [];
  for (const [extId, isEnabled] of Object.entries(enabled)) {
    if (isEnabled === false) continue;
    const entry = repository[extId] as ExtensionRepositoryEntry | undefined;
    if (!entry?.unpackedPath || !isValidRepositoryLaunchPath(extId, entry.unpackedPath)) continue;
    paths.push(entry.unpackedPath);
  }
  return paths;
}

function buildChromeCrxUrl(extId: string): string {
  return `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=${CHROME_PRODUCT_VERSION}&x=id%3D${extId}%26installsource%3Dondemand%26uc`;
}

export function getExtensionRepoEntryDir(extId: string): string {
  validateExtensionId(extId);
  return path.join(getAppDataDir(), "extension-repository", extId);
}

function isValidRepositoryLaunchPath(extId: string, unpackedPath: string): boolean {
  validateExtensionId(extId);
  try { assertRepositoryTargetWritable(extId); }
  catch (error) {
    if (error instanceof ExtensionRepositoryRecoveryRequiredError) return false;
    throw error;
  }
  const repoRoot = path.join(getAppDataDir(), "extension-repository");
  const entryDir = getExtensionRepoEntryDir(extId);
  const expectedPath = path.join(entryDir, "current");
  const resolvedPath = path.resolve(unpackedPath);
  if (resolvedPath !== expectedPath) return false;
  if (!fs.existsSync(resolvedPath)) return false;
  if (!isRealDirectoryInside(repoRoot, getAppDataDir())) return false;
  if (!isRealDirectoryInside(entryDir, repoRoot)) return false;
  if (!isRealDirectoryInside(resolvedPath, entryDir)) return false;
  const manifestPath = path.join(resolvedPath, "manifest.json");
  return fs.existsSync(manifestPath) && !fs.lstatSync(manifestPath).isSymbolicLink();
}

function isRealDirectoryInside(candidate: string, parent: string): boolean {
  if (!fs.existsSync(candidate) || !fs.existsSync(parent)) return false;
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;
  const realCandidate = fs.realpathSync(candidate);
  const realParent = fs.realpathSync(parent);
  return isPathInside(realCandidate, realParent);
}

function assertSafeZipEntries(zipPath: string): void {
  for (const entry of readZipCentralDirectory(zipPath)) {
    validateZipEntryName(entry.name);
    if (entry.isSymlink || entry.isHardlink) throw new Error(`Extension archive contains unsafe link: ${entry.name}`);
    if (entry.encrypted) throw new Error(`Extension archive contains encrypted entry: ${entry.name}`);
    // data descriptor is allowed: the central directory carries the true
    // compressedSize/uncompressedSize, which is what we use to slice the data.
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new Error(`Extension archive uses unsupported compression: ${entry.name}`);
  }
}

function extractZipSafely(zipPath: string, destination: string, signal?: AbortSignal): void {
  assertExtensionNotAborted(signal);
  const zip = fs.readFileSync(zipPath);
  const entries = readZipCentralDirectoryFromBuffer(zip);
  let totalUncompressed = 0;
  const destinationRoot = path.resolve(destination);
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    assertExtensionNotAborted(signal);
    validateZipEntryName(entry.name);
    if (entry.isSymlink || entry.isHardlink) throw new Error(`Extension archive contains unsafe link: ${entry.name}`);
    if (entry.encrypted) throw new Error(`Extension archive contains encrypted entry: ${entry.name}`);
    // data descriptor allowed — central directory has authoritative sizes
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new Error(`Extension archive uses unsupported compression: ${entry.name}`);
    if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error(`ZIP entry is too large: ${entry.name}`);
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) throw new Error("Extension archive is too large after decompression");

    const targetPath = path.resolve(destinationRoot, entry.name);
    if (!isPathInside(targetPath, destinationRoot)) throw new Error(`Extension archive contains unsafe path: ${entry.name}`);
    if (entry.isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 });
      continue;
    }

    const localHeaderOffset = entry.localHeaderOffset;
    if (zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header for ${entry.name}`);
    const method = zip.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
    const compressedStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedEnd = compressedStart + entry.compressedSize;
    if (compressedEnd > zip.length) throw new Error(`ZIP entry exceeds archive bounds: ${entry.name}`);
    const compressed = zip.subarray(compressedStart, compressedEnd);
    const content = method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
    if (content.length !== entry.uncompressedSize) throw new Error(`ZIP entry size mismatch: ${entry.name}`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(targetPath, content, { mode: 0o600, flag: "wx" });
  }
}

interface ZipEntryInfo {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
  usesDataDescriptor: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  isHardlink: boolean;
}

function readZipCentralDirectory(zipPath: string): ZipEntryInfo[] {
  return readZipCentralDirectoryFromBuffer(fs.readFileSync(zipPath));
}

function readZipCentralDirectoryFromBuffer(zip: Buffer): ZipEntryInfo[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  if (eocdOffset < 0) throw new Error("ZIP central directory not found");
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralDirSize = zip.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = zip.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported for extensions");
  }
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error("Extension archive has too many files");
  if (centralDirOffset + centralDirSize > zip.length) throw new Error("ZIP central directory exceeds archive bounds");

  const entries: ZipEntryInfo[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central directory entry");
    const flags = zip.readUInt16LE(offset + 8);
    const compressionMethod = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > zip.length) throw new Error("ZIP entry name exceeds archive bounds");
    const name = zip.subarray(nameStart, nameEnd).toString("utf8");
    if (compressedSize > MAX_EXTENSION_PACKAGE_BYTES) throw new Error(`ZIP entry compressed size is too large: ${name}`);
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error(`ZIP entry is too large: ${name}`);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 0x01) !== 0,
      usesDataDescriptor: (flags & 0x08) !== 0,
      isDirectory: name.endsWith("/"),
      isSymlink: fileType === 0o120000,
      isHardlink: false,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minOffset = Math.max(0, zip.length - 0xffff - 22);
  for (let offset = zip.length - 22; offset >= minOffset; offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function validateZipEntryName(entry: string): void {
  if (!entry || Buffer.byteLength(entry, "utf8") > 4096 || path.isAbsolute(entry) || entry.split(/[\\/]+/).includes("..") || /(^|[\\/])\./.test(entry)) {
    throw new Error(`Extension archive contains unsafe path: ${entry}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statIfPresent(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertRealDirectory(directory: string): void {
  const stat = statIfPresent(directory);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Extension repository path is not a real directory: ${directory}`);
}

/** No writes, and no following an entry/root symlink while looking for rescue data. */
function assertRepositoryTargetWritable(extId: string, activeUpdateDir?: string): void {
  const entryDir = getExtensionRepoEntryDir(extId);
  for (const directory of [getAppDataDir(), path.dirname(entryDir), entryDir]) assertRealDirectory(directory);
  if (!statIfPresent(entryDir)) return;
  for (const name of fs.readdirSync(entryDir)) {
    if (!name.startsWith(".update-")) continue;
    const updateDir = path.join(entryDir, name);
    // Only the snapshot repair's own currently executing commit may be pending.
    // All other rescue receipts retain the ordinary durable recovery guard.
    if (updateDir === activeUpdateDir) continue;
    const receiptPath = path.join(updateDir, "receipt.json");
    let problem: string;
    try {
      const updateStat = fs.lstatSync(updateDir);
      if (!updateStat.isDirectory() || updateStat.isSymbolicLink()) throw new Error("Update rescue path is not a real directory");
      const receiptStat = fs.lstatSync(receiptPath);
      if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 4096) throw new Error("Invalid extension update receipt");
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      if (receipt.version === 1 && receipt.extensionId === extId && receipt.state === "committed") continue;
      problem = "An unfinished extension update needs manual review";
    } catch (error) {
      problem = `Cannot verify extension update receipt: ${errorMessage(error)}`;
    }
    throw new ExtensionRepositoryRecoveryRequiredError(extId, recoveryPaths(entryDir, updateDir), receiptPath, problem);
  }
}

function prepareRepositoryEntryDir(extId: string): string {
  assertRepositoryTargetWritable(extId);
  const entryDir = getExtensionRepoEntryDir(extId);
  fs.mkdirSync(getAppDataDir(), { recursive: true, mode: 0o700 });
  for (const directory of [path.dirname(entryDir), entryDir]) {
    if (!statIfPresent(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    assertRealDirectory(directory);
  }
  return entryDir;
}

function recoveryPaths(entryDir: string, updateDir: string): string[] {
  return [path.join(entryDir, "current"), path.join(entryDir, "package.zip"), path.join(entryDir, "package.crx"),
    path.join(updateDir, "current.backup"), path.join(updateDir, "package.backup"), updateDir];
}

function writeUpdateReceipt(updateDir: string, extensionId: string, state: "pending" | "committed" | "recovery-required"): void {
  const temporary = path.join(updateDir, `receipt.tmp-${crypto.randomUUID()}`);
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, extensionId, state }), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, path.join(updateDir, "receipt.json"));
}

function cleanupWarning(file: string, error: unknown, receipt?: ExtensionRepositoryCommitReceipt): void {
  const warning: ExtensionRepositoryCleanupWarning = {
    code: "EXTENSION_REPOSITORY_CLEANUP_FAILED", path: file,
    message: `Extension repository cleanup failed${receipt ? " after commit (installation remains committed)" : ""}: ${errorMessage(error)}`,
  };
  receipt?.cleanupWarnings.push(warning);
  console.warn(`${warning.code}: ${warning.message}; retained path: ${file}`);
}

function cleanupRepositoryStaging(tempDir: string, receipt?: ExtensionRepositoryCommitReceipt): void {
  // Rescue copies live in a separate exclusive .update-* sibling, never here.
  // Cleanup cannot mask a primary error or turn committed success into failure.
  try { fs.rmSync(tempDir, { recursive: true, force: true }); }
  catch (error) { cleanupWarning(tempDir, error, receipt); }
}

function saveRepositoryEntry(entry: ExtensionRepositoryEntry): void {
  transact((draft) => {
    draft.extensionRepository = draft.extensionRepository || {};
    draft.extensionRepository[entry.id] = entry;
  });
}

function removePublishedResource(file: string, publishedStat: fs.Stats, directory: boolean): void {
  const current = statIfPresent(file);
  if (!current) return;
  if (current.isSymbolicLink() || current.dev !== publishedStat.dev || current.ino !== publishedStat.ino) {
    throw new Error(`Published extension resource changed identity; refusing to remove ${file}`);
  }
  fs.rmSync(file, { recursive: directory, force: true });
}

function restoreBackup(backup: string, destination: string): void {
  if (statIfPresent(destination)) throw new Error(`Extension recovery destination is occupied: ${destination}`);
  fs.renameSync(backup, destination);
}

function commitRepositoryUpdate(stagedDir: string, finalDir: string, stagedPackage: string, finalPackage: string, save: (originalDirectory?: string) => void, beforePublish?: (activeUpdateDir: string) => void): ExtensionRepositoryCommitReceipt {
  const entryDir = path.dirname(finalDir);
  const extId = path.basename(entryDir);
  assertRepositoryTargetWritable(extId);
  const oldDir = statIfPresent(finalDir);
  const oldPackage = finalPackage ? statIfPresent(finalPackage) : null;
  if (oldDir && (!oldDir.isDirectory() || oldDir.isSymbolicLink())) throw new Error("Extension current path is not a real directory");
  if (oldPackage && (!oldPackage.isFile() || oldPackage.isSymbolicLink())) throw new Error("Extension package path is not a regular file");
  const publishedDirStat = fs.lstatSync(stagedDir);
  // Dedicated sibling of extraction staging: outer finally must never delete
  // the only original copy following a failed compensation.
  const updateDir = fs.mkdtempSync(path.join(entryDir, ".update-"));
  const backupDir = path.join(updateDir, "current.backup");
  const backupPackage = path.join(updateDir, "package.backup");
  const preparedPackage = path.join(updateDir, "package.new");
  let publishedPackageStat: fs.Stats | undefined;
  let oldDirMoved = false;
  let oldPackageMoved = false;
  let newDirPublished = false;
  let newPackagePublished = false;
  try {
    writeUpdateReceipt(updateDir, extId, "pending");
    if (stagedPackage && finalPackage) {
      // Copy/chmod before moving originals. Even a partially failed copy is
      // isolated, and publication itself is an ownership-tracked rename.
      fs.copyFileSync(stagedPackage, preparedPackage, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(preparedPackage, 0o600);
      publishedPackageStat = fs.lstatSync(preparedPackage);
    }
    // Optional snapshot CAS guard runs after fallible staging, before originals
    // move. Existing install/restore callers retain their R1 commit semantics.
    beforePublish?.(updateDir);
    if (oldDir) { fs.renameSync(finalDir, backupDir); oldDirMoved = true; }
    if (oldPackage) { fs.renameSync(finalPackage, backupPackage); oldPackageMoved = true; }
    fs.renameSync(stagedDir, finalDir);
    newDirPublished = true;
    if (publishedPackageStat) { fs.renameSync(preparedPackage, finalPackage); newPackagePublished = true; }
    save(oldDirMoved ? backupDir : undefined);
  } catch (error) {
    const failures: string[] = [];
    const compensate = (label: string, action: () => void) => {
      try { action(); } catch (compensationError) { failures.push(`${label}: ${errorMessage(compensationError)}`); }
    };
    if (newDirPublished) compensate("remove published directory", () => removePublishedResource(finalDir, publishedDirStat, true));
    if (newPackagePublished) compensate("remove published package", () => removePublishedResource(finalPackage, publishedPackageStat!, false));
    if (oldDirMoved) compensate("restore original directory", () => restoreBackup(backupDir, finalDir));
    if (oldPackageMoved) compensate("restore original package", () => restoreBackup(backupPackage, finalPackage));
    if (failures.length === 0) compensate("remove rolled-back update staging", () => fs.rmSync(updateDir, { recursive: true, force: true }));
    if (failures.length > 0) {
      // Leave both the old bytes and the pending receipt in place if even the
      // recovery-state write fails. Any unfinished/invalid receipt blocks retry.
      compensate("record recovery state", () => writeUpdateReceipt(updateDir, extId, "recovery-required"));
      throw new ExtensionRepositoryRecoveryRequiredError(extId, recoveryPaths(entryDir, updateDir), path.join(updateDir, "receipt.json"), failures.join("; "), error);
    }
    throw error;
  }

  // Config's successful transaction is the boundary. Nothing below may enter
  // compensation, retry a failed cleanup, or remove a still-needed old copy.
  const receipt: ExtensionRepositoryCommitReceipt = { committed: true, cleanupWarnings: [] };
  try { writeUpdateReceipt(updateDir, extId, "committed"); }
  catch (error) { cleanupWarning(updateDir, error, receipt); return receipt; }
  for (const file of [...(oldDirMoved ? [backupDir] : []), ...(oldPackageMoved ? [backupPackage] : []), updateDir]) {
    try { fs.rmSync(file, { recursive: true, force: true }); }
    catch (error) { cleanupWarning(file, error, receipt); break; }
  }
  return receipt;
}

function validateExtractedExtension(rootDir: string): void {
  const rootReal = fs.realpathSync(rootDir);
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Extension archive contains symlinks");
      const entryReal = fs.realpathSync(entryPath);
      if (!isPathInside(entryReal, rootReal)) throw new Error("Extension archive contains files outside target directory");
      if (entry.isDirectory()) stack.push(entryPath);
    }
  }
}

function findManifestDir(rootDir: string, depth = 4): string | null {
  if (depth < 0) return null;
  if (fs.existsSync(path.join(rootDir, "manifest.json"))) return rootDir;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findManifestDir(path.join(rootDir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

function resolveManifestText(rootDir: string, manifest: any, field: "name" | "description"): string | null {
  const raw = manifest[field];
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("__MSG_") || !raw.endsWith("__")) return raw;
  const key = raw.slice(6, -2).toLowerCase();
  const locale = String(manifest.default_locale || "en");
  for (const candidate of [locale, locale.replace("-", "_"), locale.split("-")[0], "en"]) {
    const messagesPath = path.join(rootDir, "_locales", candidate, "messages.json");
    if (!fs.existsSync(messagesPath)) continue;
    try {
      const messages = JSON.parse(fs.readFileSync(messagesPath, "utf-8"));
      const matched = Object.keys(messages).find((name) => name.toLowerCase() === key);
      const value = matched ? messages[matched]?.message : null;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch (e) {
      console.warn(`Failed to read extension locale messages ${messagesPath}:`, e);
    }
  }
  return null;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => String(tag || "").trim()).filter(Boolean).map((tag) => {
    if (tag.length > 40 || /[\x00-\x1f\x7f]/.test(tag)) throw new Error("Invalid extension tag");
    return tag;
  }))].slice(0, 20);
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha512").update(fs.readFileSync(filePath)).digest("hex");
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (e: any) {
    if (e?.code !== "ENOENT") console.warn(`Failed to remove temporary extension file ${filePath}:`, e);
  }
}

function validateExtensionId(extId: string): void {
  if (!EXTENSION_ID_RE.test(extId)) throw new Error(`Invalid Chrome extension ID: ${JSON.stringify(extId)}`);
}

function isPathInside(childPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
