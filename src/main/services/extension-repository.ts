import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { getAppDataDir, getConfig, saveConfig } from "./config-manager.js";
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

export async function addOrUpdateChromeStoreExtension(extId: string, opts: { shared?: boolean; tags?: string[] } = {}): Promise<ExtensionRepositoryEntry> {
  validateExtensionId(extId);
  const repoDir = getExtensionRepoEntryDir(extId);
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(path.join(repoDir, ".tmp-"));
  fs.chmodSync(tempDir, 0o700);
  const stagingDir = path.join(tempDir, "extract");
  const tmpCrx = path.join(tempDir, "package.crx");
  const tmpZip = path.join(tempDir, "package.zip");

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

    const cfg = structuredClone(getConfig()) as any;
    cfg.extensionRepository = cfg.extensionRepository || {};
    cfg.extensionRepository[extId] = entry;
    commitRepositoryUpdate(stagingDir, finalUnpackedDir, tmpCrx, finalPackagePath, () => saveConfig(cfg));
    return entry;
  } finally {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Install an extension from a local CRX/ZIP file or an unpacked directory.
 * Reuses the same extract/validate/commit pipeline as the Chrome Store path.
 * Generates a random local ID (local_<hex>) since local packages don't carry a
 * Chrome Web Store 32-char ID. Local extensions cannot auto-update.
 */
export async function installLocalExtension(localPath: string, opts: { shared?: boolean; tags?: string[]; signal?: AbortSignal } = {}): Promise<ExtensionRepositoryEntry> {
  const signal = opts.signal;
  assertExtensionNotAborted(signal);
  const resolved = path.resolve(String(localPath || "").trim());
  if (!fs.existsSync(resolved)) throw new Error(`Local extension path does not exist: ${resolved}`);

  const isDir = fs.statSync(resolved).isDirectory();
  const extId = "local_" + crypto.randomBytes(12).toString("hex");
  validateExtensionId(extId);

  const repoDir = getExtensionRepoEntryDir(extId);
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(path.join(repoDir, ".tmp-"));
  fs.chmodSync(tempDir, 0o700);
  const stagingDir = path.join(tempDir, "extract");
  const tmpZip = path.join(tempDir, "package.zip");

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
    const cfg = structuredClone(getConfig()) as any;
    cfg.extensionRepository = cfg.extensionRepository || {};
    cfg.extensionRepository[extId] = entry;
    // For directories there's no package file; commit only the unpacked dir.
    assertExtensionNotAborted(signal);
    if (isDir) {
      commitRepositoryUpdate(stagingDir, finalUnpackedDir, "", "", () => saveConfig(cfg));
    } else {
      commitRepositoryUpdate(stagingDir, finalUnpackedDir, archivePath, finalPackagePath, () => saveConfig(cfg));
    }
    return entry;
  } finally {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
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
      // Reject symlinks (zip-slip style safety for unpacked-dir import).
      let isLink = false;
      try { isLink = fs.lstatSync(s).isSymbolicLink(); } catch { /* ignore */ }
      if (!isLink) fs.copyFileSync(s, d);
    }
  }
}

/**
 * Update a repository extension. Dispatches by source:
 *  - chrome-web-store: re-download from Chrome Web Store
 *  - local: no remote source → cannot auto-update; caller should re-import.
 */
export async function updateRepositoryExtension(extId: string): Promise<ExtensionRepositoryEntry> {
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
  const cfg = structuredClone(getConfig()) as any;
  if (!cfg.extensionRepository?.[extId]) return false;
  delete cfg.extensionRepository[extId];
  for (const profile of Object.values(cfg.browserProfiles || {}) as any[]) {
    if (profile.extensions) delete profile.extensions[extId];
  }
  saveConfig(cfg);
  const repoDir = getExtensionRepoEntryDir(extId);
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  return true;
}

export async function restoreSyncedExtensionPackage(extId: string, packagePath: string, remoteEntry: Partial<ExtensionRepositoryEntry>, signal?: AbortSignal): Promise<ExtensionRepositoryEntry> {
  validateExtensionId(extId);
  assertExtensionNotAborted(signal);
  const resolved = path.resolve(String(packagePath || "").trim());
  if (!fs.existsSync(resolved)) throw new Error(`Synced extension package does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.size < 100) throw new Error("Synced extension package is too small");
  if (stat.size > MAX_EXTENSION_PACKAGE_BYTES) throw new Error("Synced extension package is too large");

  const repoDir = getExtensionRepoEntryDir(extId);
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(path.join(repoDir, ".tmp-"));
  fs.chmodSync(tempDir, 0o700);
  const stagingDir = path.join(tempDir, "extract");
  const tmpZip = path.join(tempDir, "package.zip");

  try {
    let archivePath = resolved;
    try {
      assertSafeZipEntries(archivePath);
    } catch (_zipError) {
      assertExtensionNotAborted(signal);
      const crxData = fs.readFileSync(resolved);
      const zipStart = crxData.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      if (zipStart <= 0) throw new Error("Could not find ZIP payload in synced extension package");
      fs.writeFileSync(tmpZip, crxData.subarray(zipStart), { mode: 0o600 });
      archivePath = tmpZip;
      assertSafeZipEntries(archivePath);
    }
    extractZipSafely(archivePath, stagingDir, signal);
    assertExtensionNotAborted(signal);
    const manifestDir = findManifestDir(stagingDir);
    if (!manifestDir) throw new Error("Extension manifest.json not found after extraction");
    validateExtractedExtension(stagingDir);

    const manifestPath = path.join(manifestDir, "manifest.json");
    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw) as { name?: string; version?: string; description?: string; manifest_version?: number };
    if (!manifest.name) throw new Error("Extension manifest must declare a name");
    if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error("Extension manifest_version must be 2 or 3");

    const finalUnpackedDir = path.join(repoDir, "current");
    const isChromeStorePackage = remoteEntry.source === "chrome-web-store";
    const finalPackagePath = path.join(repoDir, isChromeStorePackage ? "package.crx" : "package.zip");
    const previous = getRepositoryExtension(extId);
    const now = Date.now();
    const manifestHash = crypto.createHash("sha512").update(manifestRaw).digest("hex");
    const packageHash = hashFile(isChromeStorePackage ? resolved : (archivePath || resolved));
    if (!/^[0-9a-f]{128}$/i.test(String(remoteEntry.manifestHash || ""))) {
      throw new Error("Synced extension manifest hash is required");
    }
    if (!/^[0-9a-f]{128}$/i.test(String(remoteEntry.packageHash || ""))) {
      throw new Error("Synced extension package hash is required");
    }
    if (remoteEntry.manifestHash !== manifestHash) {
      throw new Error("Synced extension manifest hash does not match package contents");
    }
    if (remoteEntry.packageHash !== packageHash) {
      throw new Error("Synced extension package hash does not match downloaded package");
    }
    const entry: ExtensionRepositoryEntry = {
      id: extId,
      name: typeof remoteEntry.name === "string" ? remoteEntry.name : resolveManifestText(stagingDir, manifest, "name") || manifest.name || extId,
      version: typeof remoteEntry.version === "string" ? remoteEntry.version : manifest.version || "?",
      description: typeof remoteEntry.description === "string" ? remoteEntry.description : resolveManifestText(stagingDir, manifest, "description") || manifest.description || "",
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
    const cfg = structuredClone(getConfig()) as any;
    cfg.extensionRepository = cfg.extensionRepository || {};
    cfg.extensionRepository[extId] = entry;
    assertExtensionNotAborted(signal);
    commitRepositoryUpdate(stagingDir, finalUnpackedDir, isChromeStorePackage ? resolved : archivePath, finalPackagePath, () => saveConfig(cfg));
    return entry;
  } finally {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function setRepositoryExtensionMeta(extId: string, opts: { shared?: boolean; tags?: string[] }): ExtensionRepositoryEntry {
  validateExtensionId(extId);
  const cfg = structuredClone(getConfig()) as any;
  const entry = cfg.extensionRepository?.[extId];
  if (!entry) throw new Error("Extension is not in the repository");
  if (opts.shared !== undefined) entry.shared = Boolean(opts.shared);
  if (opts.tags !== undefined) entry.tags = normalizeTags(opts.tags);
  entry.updatedAt = Date.now();
  saveConfig(cfg);
  return entry;
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

function commitRepositoryUpdate(stagedDir: string, finalDir: string, stagedPackage: string, finalPackage: string, save: () => void): void {
  const suffix = `.backup-${process.pid}-${Date.now()}`;
  const backupDir = `${finalDir}${suffix}`;
  const backupPackage = `${finalPackage}${suffix}`;
  let backupDirCreated = false;
  let backupPackageCreated = false;
  try {
    if (fs.existsSync(finalDir)) {
      fs.renameSync(finalDir, backupDir);
      backupDirCreated = true;
    }
    if (fs.existsSync(finalPackage)) {
      fs.renameSync(finalPackage, backupPackage);
      backupPackageCreated = true;
    }
    fs.renameSync(stagedDir, finalDir);
    if (stagedPackage && finalPackage) {
      fs.copyFileSync(stagedPackage, finalPackage);
      fs.chmodSync(finalPackage, 0o600);
    }
    save();
    if (backupDirCreated) fs.rmSync(backupDir, { recursive: true, force: true });
    if (backupPackageCreated) fs.rmSync(backupPackage, { force: true });
  } catch (e) {
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    if (fs.existsSync(finalPackage)) fs.rmSync(finalPackage, { force: true });
    if (backupDirCreated && fs.existsSync(backupDir)) fs.renameSync(backupDir, finalDir);
    if (backupPackageCreated && fs.existsSync(backupPackage)) fs.renameSync(backupPackage, finalPackage);
    throw e;
  }
}

function validateExtractedExtension(rootDir: string): void {
  const rootReal = fs.realpathSync(rootDir);
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const entryReal = fs.realpathSync(entryPath);
      if (!isPathInside(entryReal, rootReal)) throw new Error("Extension archive contains files outside target directory");
      if (entry.isSymbolicLink()) throw new Error("Extension archive contains symlinks");
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
