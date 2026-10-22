// Profile backup / transfer (RoxyBrowser-style). Exports a managed profile
// (its Chromium data dir + fingerprint/proxy meta) into a portable ZIP archive
// and re-imports it under a fresh dirId on this or another machine. Cache and
// lock files are excluded so archives stay lean and consistent. Running
// profiles are refused for export (browser data may be mid-write).

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAppDataDir, getProfilesDir, getConfig, getProfileMeta, normalizePortableProfileMeta } from "./config-manager.js";
import { PORTABLE_PROFILE_FIELDS } from "./profile-portability.js";
import { compareProfileIdentity, type ProfileIdentityComparison } from "./profile-identity.js";
import type { BrowserEngine, BrowserProfileMeta } from "../types.js";
import { transact } from "./config/store.js";
import { requireProfileMutation, requireAccountSecret } from "./team.js";
import { hasInstalledRepositoryExtension } from "./extension-repository.js";
import { statusBrowser } from "./browser-manager.js";
import { validateDirId } from "./utils.js";
import { PROFILE_ID_PREFIX } from "../branding.js";
import {
  writeZipArchive, extractZipArchive, ensureArchiveDirectory, syncArchiveDirectory, isPathInside,
  MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES, type ZipFileEntry, type ZipDirEntry, type WriteZipOptions,
} from "./zip-writer.js";
import { acquireRestoreLock, assertProfileTransferStopped } from "./profile-restore-lock.js";
import { markProfileDataChanging } from "./profile-data-revision.js";
import { assertSafeArchiveExportDir, assertSafeArchiveExportPath, assertSafeArchiveImportPath } from "./archive-path-guard.js";
import { hasSqliteLocalStorage, SQLITE_LOCAL_STORAGE_SIDECARS } from "./sync/sqlite-local-storage.js";
import { historyBasename, historySidecars } from "./sync/sqlite-history.js";

export const PROFILE_ARCHIVE_FORMAT = 1;
const META_FILE = "meta.json";
const MAX_IMPORT_BYTES = MAX_ZIP_TOTAL_BYTES;

/** Directory names that are pure cache and always excluded from backups. */
const SKIP_DIR_NAMES = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "GraphiteDawnCache",
  "ShaderCache", "GrShaderCache", "DawnCache", "blob_storage", "CacheStorage",
  "Shared Dictionary",
]);
/** Top-level lock/pid files that must never be archived. */
const SKIP_FILE_NAMES = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile", "LOCK", "lock"]);

export interface ExportProfileResult {
  dirId: string;
  filePath: string;
  entries: number;
  bytes: number;
  /** Post-publication cleanup/durability notices, never profile metadata. */
  warnings?: string[];
}

export interface ImportProfileResult {
  dirId: string;
  name: string;
  files: number;
  bytes: number;
  /** Local dependencies referenced by the backup, never bundled with it. */
  warnings: string[];
  /** Saved configuration only; imported baseline data is not a live retest. */
  identity?: ProfileIdentityComparison;
}

export interface BatchExportItem {
  dirId: string;
  filePath: string;
  entries: number;
  bytes: number;
  warnings?: string[];
}

export interface BatchExportReport {
  exported: BatchExportItem[];
  skipped: Array<{ dirId: string; reason: string; code?: string }>;
  failed: Array<{ dirId: string; error: string; code?: string }>;
}

export interface BatchImportItem {
  zipPath: string;
  dirId: string;
  name: string;
  files: number;
  bytes: number;
  warnings: string[];
  identity?: ProfileIdentityComparison;
}

export interface BatchImportReport {
  imported: BatchImportItem[];
  failed: Array<{ zipPath: string; error: string; code?: string }>;
}

export function classifyArchiveBatchReport(report: BatchExportReport | BatchImportReport): {
  success: boolean; outcome: "completed" | "partial" | "skipped" | "failed";
} {
  const completed = "exported" in report ? report.exported.length : report.imported.length;
  const skipped = "skipped" in report ? report.skipped.length : 0;
  const failed = report.failed.length;
  const outcome = completed > 0 ? (skipped || failed ? "partial" : "completed") : (skipped > 0 && failed === 0 ? "skipped" : "failed");
  return { success: outcome === "completed", outcome };
}

export function archiveOperationFailure(error: unknown): { success: false; outcome: "failed"; error: string; code?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return { success: false, outcome: "failed", error: error instanceof Error ? error.message : String(error),
    ...(typeof code === "string" ? { code } : {}) };
}

function assertArchiveBatchInput(values: unknown, label: string): asserts values is string[] {
  if (!Array.isArray(values) || !values.length || Array.from(values).some((value) => typeof value !== "string" || !value.trim())) {
    throw Object.assign(new Error(`${label} must be a non-empty array of non-empty strings`), { code: "ARCHIVE_INVALID_INPUT" });
  }
}

function newDirId(): string {
  return PROFILE_ID_PREFIX + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);
}

const SQLITE_RESCUE_PREFIX = ".sqlite-localstorage-backup-";
const HISTORY_RESCUE_PREFIX = ".history-backup-";
const LEVELDB_RESCUE_PREFIX = ".leveldb-backup-";
const RECOVERY_HISTORY = ".profile-archive-recovery";
interface ArchiveRecovery { sqlite: string[]; historySqlite: string[]; legacy: string[]; history: boolean; }

function recoveryRequired(reason: string, cause?: unknown): Error {
  return Object.assign(new Error("Profile data recovery requires manual resolution before profile backup/transfer: " + reason, { cause }), { code: "ARCHIVE_RECOVERY_REQUIRED" });
}
function sameRecoveryStat(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
// Bounded, pinned reads; neither receipt paths nor rescue symlinks are followed.
function visitRecoveryFile(file: string, limit: number, visit: (chunk: Buffer) => void): void {
  ensureArchiveDirectory(path.dirname(file));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error("Unsafe recovery file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!sameRecoveryStat(before, fs.fstatSync(fd))) throw new Error("Recovery file changed before reading");
    const buffer = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < before.size;) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!n) throw new Error("Recovery file changed during reading");
      visit(buffer.subarray(0, n)); offset += n;
    }
    if (fs.readSync(fd, buffer, 0, 1, before.size) || !sameRecoveryStat(before, fs.fstatSync(fd)) ||
        !sameRecoveryStat(before, fs.lstatSync(file))) throw new Error("Recovery file changed during reading");
  } finally { fs.closeSync(fd); }
}
function recoveryReceipt(file: string, keys: string[]): Record<string, any> {
  const chunks: Buffer[] = [];
  visitRecoveryFile(file, 16384, (chunk) => chunks.push(Buffer.from(chunk)));
  const bytes = Buffer.concat(chunks), value = JSON.parse(bytes.toString("utf8"));
  // The v1 sync producer writes canonical JSON. Reject duplicate/prototype keys,
  // ambiguous encodings and unknown fields rather than inventing their meaning.
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      Object.keys(value).sort().join("|") !== [...keys].sort().join("|") ||
      !bytes.equals(Buffer.from(JSON.stringify(value)))) throw new Error("Invalid recovery receipt");
  return value;
}
function recoverySourceId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Recovery source ID is missing");
  validateDirId(value); return value;
}
function assertRecoveryTarget(target: unknown, sourceId: string, profileRoot = false): void {
  if (typeof target !== "string" || /[\x00-\x1f\x7f]/.test(target)) throw new Error("Invalid recovery target");
  const style = target.startsWith("/") && !target.includes("\\") ? path.posix : path.win32;
  if (style === path.win32 && target.replace(/^[A-Za-z]:\\/, "").split("\\").filter(Boolean).some((part) =>
      /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe Windows recovery target");
  if (!style.isAbsolute(target) || style.normalize(target) !== target || target.endsWith(style.sep) ||
      (style === path.win32 && !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(target)) ||
      (profileRoot ? style.basename(target) !== sourceId : style.basename(target) !== "Default" || style.basename(style.dirname(target)) !== sourceId)) throw new Error("Recovery target is not its source profile's canonical path");
  // This is only a foreign-path identity check. Never resolve/read that path.
}
function recoveryInventory(value: unknown, requireMain: boolean, historyEngine?: BrowserEngine): Array<{ name: string; hash: string }> {
  const main = historyEngine ? historyBasename(historyEngine) : "LocalStorage";
  const names: readonly string[] = historyEngine ? historySidecars(historyEngine) : SQLITE_LOCAL_STORAGE_SIDECARS;
  if (!Array.isArray(value) || value.length > names.length) throw new Error("Invalid SQLite recovery inventory");
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join("|") !== "hash|name" ||
        !names.includes(item.name) || typeof item.hash !== "string" || !/^[a-f0-9]{64}$/.test(item.hash) || seen.has(item.name)) throw new Error("Invalid SQLite recovery member");
    seen.add(item.name);
  }
  if ((requireMain || value.length) && !seen.has(main)) throw new Error("SQLite recovery inventory has no main database");
  if (requireMain && value.some((item) => ![main, main + "-wal"].includes(item.name))) throw new Error("Invalid incoming SQLite recovery sidecar");
  return value;
}
function assertCompletedSqliteRecovery(transaction: string, sourceId: string, liveDirectory?: string, exactSourcePath = false, historyEngine?: BrowserEngine): void {
  ensureArchiveDirectory(transaction);
  if (fs.readdirSync(transaction).sort().join("|") !== "new|old|pending.json|published.json") throw new Error("Incomplete or unknown SQLite rescue material");
  const pending = recoveryReceipt(path.join(transaction, "pending.json"), ["version", "format", "operationId", "dirId", "target", "old", "incoming", ...(historyEngine ? ["scope"] : [])]);
  const published = recoveryReceipt(path.join(transaction, "published.json"), ["state", "pendingHash"]);
  if (pending.version !== 1 || pending.format !== "sqlite" || pending.dirId !== sourceId || historyEngine && pending.scope !== "history" ||
      typeof pending.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(pending.operationId) ||
      published.state !== "published" || published.pendingHash !== createHash("sha256").update(JSON.stringify(pending)).digest("hex")) throw new Error("SQLite recovery publication is unconfirmed");
  assertRecoveryTarget(pending.target, sourceId, historyEngine === "firefox");
  if (exactSourcePath && pending.target !== liveDirectory) throw new Error("SQLite recovery belongs to another source path");
  const old = recoveryInventory(pending.old, false, historyEngine);
  recoveryInventory(pending.incoming, true, historyEngine);
  const oldDir = ensureArchiveDirectory(path.join(transaction, "old")), newDir = ensureArchiveDirectory(path.join(transaction, "new"));
  if (fs.readdirSync(newDir).length || fs.readdirSync(oldDir).sort().join("|") !== old.map((item) => item.name).sort().join("|")) throw new Error("SQLite rescue inventory is incomplete");
  for (const item of old) {
    const hash = createHash("sha256");
    visitRecoveryFile(path.join(oldDir, item.name), MAX_IMPORT_BYTES, (chunk) => { hash.update(chunk); });
    if (hash.digest("hex") !== item.hash) throw new Error("SQLite old rescue bytes do not match their receipt");
  }
  if (liveDirectory) {
    if (historyEngine) {
      let header: Buffer | undefined;
      visitRecoveryFile(path.join(liveDirectory, historyBasename(historyEngine)), MAX_IMPORT_BYTES, (chunk) => { header ??= Buffer.from(chunk.subarray(0, 16)); });
      if (!header?.equals(Buffer.from("SQLite format 3\0"))) throw new Error("History live database is missing or invalid");
    } else if (!hasSqliteLocalStorage(liveDirectory)) throw new Error("SQLite live database is missing");
  }
}
function assertLegacyRescue(directory: string): void {
  ensureArchiveDirectory(directory);
  for (const name of fs.readdirSync(directory)) {
    if (["pending.json", "published.json", "recovery-required.json"].includes(name.toLowerCase())) throw new Error("Unresolved legacy rescue marker");
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Unsafe legacy rescue material");
    if (stat.isDirectory()) assertLegacyRescue(file);
  }
}
function inspectArchiveRecovery(profileDir: string, sourceId: unknown, exporting = false, engine: BrowserEngine = "chromium"): ArchiveRecovery {
  try {
    if (exporting) {
      const receipts = path.join(getAppDataDir(), "sync-recovery");
      if (fs.lstatSync(receipts, { throwIfNoEntry: false })) {
        ensureArchiveDirectory(receipts);
        for (const scope of ["localStorage", "history"]) {
          if (fs.lstatSync(path.join(receipts, `${recoverySourceId(sourceId)}.${scope}.json`), { throwIfNoEntry: false })) throw new Error("A local recovery-required receipt is still present");
        }
      }
    }
    const result: ArchiveRecovery = { sqlite: [], historySqlite: [], legacy: [], history: false };
    // Case aliases must not change meaning when a ZIP crosses filesystems.
    const canonicalChild = (directory: string, name: string): string | null => {
      if (fs.readdirSync(directory).some((child) => child !== name && child.toLowerCase() === name.toLowerCase())) throw new Error("Ambiguous recovery directory spelling");
      const child = path.join(directory, name);
      return fs.lstatSync(child, { throwIfNoEntry: false }) ? ensureArchiveDirectory(child) : null;
    };
    const liveDefault = canonicalChild(profileDir, "Default");
    if (liveDefault) {
      for (const name of fs.readdirSync(liveDefault).filter((name) => name.toLowerCase().startsWith(SQLITE_RESCUE_PREFIX))) {
        if (!name.startsWith(SQLITE_RESCUE_PREFIX)) throw new Error("Ambiguous SQLite rescue spelling");
        const id = recoverySourceId(sourceId), transaction = path.join(liveDefault, name);
        assertCompletedSqliteRecovery(transaction, id, liveDefault, exporting);
        result.sqlite.push("Default/" + name);
      }
      const legacyParent = canonicalChild(liveDefault, "Local Storage");
      if (legacyParent) {
        if (result.sqlite.length && fs.lstatSync(path.join(legacyParent, "leveldb"), { throwIfNoEntry: false })) throw new Error("Mixed SQLite/LevelDB recovery layouts");
        for (const name of fs.readdirSync(legacyParent).filter((name) => name.toLowerCase().startsWith(LEVELDB_RESCUE_PREFIX))) {
          if (!name.startsWith(LEVELDB_RESCUE_PREFIX)) throw new Error("Ambiguous legacy rescue spelling");
          if (!canonicalChild(legacyParent, "leveldb")) throw new Error("Legacy live database is missing beside its rescue copy");
          assertLegacyRescue(path.join(legacyParent, name));
          result.legacy.push("Default/Local Storage/" + name);
        }
      }
    }
    for (const [directory, prefix, ownerEngine] of [[profileDir, "", "firefox"], [liveDefault, "Default/", "chromium"]] as const) {
      if (!directory) continue;
      for (const name of fs.readdirSync(directory).filter((name) => name.toLowerCase().startsWith(HISTORY_RESCUE_PREFIX))) {
        if (!name.startsWith(HISTORY_RESCUE_PREFIX) || engine !== ownerEngine) throw new Error("Ambiguous History rescue spelling or engine layout");
        assertCompletedSqliteRecovery(path.join(directory, name), recoverySourceId(sourceId), directory, exporting, engine);
        result.historySqlite.push(prefix + name);
      }
    }
    const history = canonicalChild(profileDir, RECOVERY_HISTORY);
    if (history) {
      result.history = true;
      for (const originalId of fs.readdirSync(history)) {
        recoverySourceId(originalId);
        const root = ensureArchiveDirectory(path.join(history, originalId)), children = fs.readdirSync(root);
        if (!children.length) throw new Error("Unknown recovery history layout");
        for (const child of children) {
          if (child === "Default") {
            const originalDefault = ensureArchiveDirectory(path.join(root, child));
            for (const name of fs.readdirSync(originalDefault)) {
              if (!name.startsWith(SQLITE_RESCUE_PREFIX) && !name.startsWith(HISTORY_RESCUE_PREFIX)) throw new Error("Unknown recovery history material");
              assertCompletedSqliteRecovery(path.join(originalDefault, name), originalId, undefined, false, name.startsWith(HISTORY_RESCUE_PREFIX) ? "chromium" : undefined);
            }
          } else if (child.startsWith(HISTORY_RESCUE_PREFIX)) {
            assertCompletedSqliteRecovery(path.join(root, child), originalId, undefined, false, "firefox");
          } else throw new Error("Unknown recovery history layout");
        }
      }
    }
    return result;
  } catch (error) { throw recoveryRequired(error instanceof Error ? error.message : String(error), error); }
}
function preserveImportedRecovery(staging: string, sourceId: unknown, recovery: ArchiveRecovery, warnings: string[]): void {
  const namespaces = [...recovery.sqlite, ...recovery.historySqlite];
  if (namespaces.length) {
    const id = recoverySourceId(sourceId);
    const moves = namespaces.map((relative) => ({ from: path.join(staging, relative), to: path.join(staging, RECOVERY_HISTORY, id, relative) }));
    for (const move of moves) if (fs.lstatSync(move.to, { throwIfNoEntry: false })) throw recoveryRequired("Recovery history destination already exists; refusing to overwrite it");
    const directories = new Set<string>([staging]);
    for (const move of moves) {
      ensureArchiveDirectory(path.dirname(move.to), true);
      fs.renameSync(move.from, move.to); directories.add(path.dirname(move.from));
      for (let directory = path.dirname(move.to); directory !== staging; directory = path.dirname(directory)) directories.add(directory);
    }
    let durable = true;
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      if (!syncArchiveDirectory(directory)) durable = false;
    }
    if (!durable) warnings.push("Directory fsync is unsupported on Windows; recovery history directory durability is not guaranteed.");
  }
  if (recovery.sqlite.length || recovery.history) warnings.push(`Completed SQLite rescue copies and original receipts are preserved in ${RECOVERY_HISTORY}; this inert history is not a recovery/commit proof for the imported profile.`);
  if (recovery.historySqlite.length) warnings.push(`Completed History/Places rescue copies and original receipts are preserved in ${RECOVERY_HISTORY}; this inert history is not a recovery/commit proof for the imported profile.`);
  if (recovery.legacy.length) warnings.push("Legacy LevelDB rescue copies are retained unchanged beside the live database; they are not a recovery/commit proof for the imported profile.");
}

function collectProfileEntries(profileDir: string, recovery: ArchiveRecovery): Array<ZipFileEntry | ZipDirEntry> {
  const entries: Array<ZipFileEntry | ZipDirEntry> = [];
  const protectedRoots = [...recovery.sqlite, ...recovery.historySqlite, ...recovery.legacy, ...(recovery.history ? [RECOVERY_HISTORY] : [])];
  const walk = (baseRel: string): void => {
    const absDir = baseRel ? path.join(profileDir, baseRel) : profileDir;
    ensureArchiveDirectory(absDir);
    for (const dirent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = baseRel ? baseRel + "/" + dirent.name : dirent.name;
      const absPath = path.join(absDir, dirent.name);
      const rescue = protectedRoots.some((root) => rel === root || rel.startsWith(root + "/"));
      if (dirent.isSymbolicLink() && !rescue) continue; // never follow links out of the profile
      const stat = fs.lstatSync(absPath); // recheck the dirent before descending
      if (rescue && (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw recoveryRequired("Unsafe rescue material must not be silently omitted");
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!rescue && SKIP_DIR_NAMES.has(dirent.name)) continue;
        entries.push({ name: rel + "/", isDirectory: true });
        if (entries.length >= MAX_ZIP_ENTRIES) throw new Error("ZIP entry count too large (including meta.json)");
        walk(rel);
      } else if (stat.isFile()) {
        if (!rescue && (SKIP_FILE_NAMES.has(dirent.name) || !baseRel && (dirent.name === ".parentlock" || dirent.name === "parent.lock"))) continue;
        entries.push({ name: rel, filePath: absPath });
        if (entries.length >= MAX_ZIP_ENTRIES) throw new Error("ZIP entry count too large (including meta.json)");
      }
    }
  };
  walk("");
  return entries;
}

// Version 1 remains compatible: new properties are optional, and this single
// allowlist is used on both sides. Never export device paths (fontsDir), sync
// markers, team locks, credentials, or extension repository/package paths.
function portableProfile(raw: BrowserProfileMeta): Partial<BrowserProfileMeta> {
  const result: Record<string, unknown> = {};
  for (const field of PORTABLE_PROFILE_FIELDS) {
    if (raw[field] !== undefined) result[field] = raw[field];
  }
  return result as Partial<BrowserProfileMeta>;
}

function importWarnings(profile: BrowserProfileMeta, hadLocalFontsDir: boolean): string[] {
  const warnings: string[] = [];
  if (hadLocalFontsDir) {
    warnings.push("Custom fonts directory is device-local and not included in this backup; configure a local fonts directory before launching.");
  }
  if (profile.proxyMode === "named" && profile.proxyName) {
    warnings.push(`Named proxy ${profile.proxyName} is not included in this backup; configure its settings and credentials before launching.`);
  }
  for (const [id, enabled] of Object.entries(profile.extensions || {})) {
    if (enabled && !hasInstalledRepositoryExtension(id)) {
      warnings.push(`Extension ${id} package is not included in this backup; install it in the private repository before launching.`);
    }
  }
  return warnings;
}

function uniqueName(baseName: string, profiles: Record<string, BrowserProfileMeta>): string {
  const names = new Set(Object.values(profiles).map((profile) => String(profile?.name || "")));
  if (!names.has(baseName)) return baseName;
  let n = 2;
  while (names.has(baseName + " (" + n + ")")) n++;
  return baseName + " (" + n + ")";
}

export async function exportProfileArchive(
  dirId: string, destPath: string, options: WriteZipOptions = {},
): Promise<ExportProfileResult> {
  // The archive carries Cookies and Login Data, i.e. live session material.
  // Import was gated but export was not, so a team viewer could walk away with
  // every logged-in session. Same member+ rule as plaintext proxy export.
  const secretGate = requireAccountSecret();
  if (!secretGate.ok) throw new Error(secretGate.error);
  validateDirId(dirId);
  destPath = assertSafeArchiveExportPath(destPath);
  const release = acquireRestoreLock(dirId);
  try {
    // Launch, restore and deletion must cooperate with this same lock. A
    // pre-lock running check alone cannot protect an awaited file snapshot.
    const meta = getProfileMeta(dirId);
    if (!meta) throw new Error("Profile not found");
    assertProfileTransferStopped(dirId, () => statusBrowser(dirId), undefined, { engine: meta.engine });
    const profileDir = path.join(getProfilesDir(), dirId);
    if (!fs.existsSync(profileDir)) throw new Error("Profile data directory missing");
    ensureArchiveDirectory(profileDir);
    if (isPathInside(destPath, profileDir)) throw new Error("Export destination must be outside the profile data directory");
    const metaDoc = {
      formatVersion: PROFILE_ARCHIVE_FORMAT,
      exportedAt: Date.now(),
      sourceDirId: dirId,
      // Boolean only: never leak the source machine's absolute fonts path.
      omitted: { fontsDir: Boolean(meta.fontsDir) },
      profile: portableProfile(meta),
    };
    const recovery = inspectArchiveRecovery(profileDir, dirId, true, meta.engine || "chromium");
    const dataEntries = collectProfileEntries(profileDir, recovery);
    const result = await writeZipArchive(destPath, [
      { name: META_FILE, data: Buffer.from(JSON.stringify(metaDoc, null, 2), "utf8") },
      ...dataEntries,
    ], options);
    return { dirId, filePath: destPath, ...result };
  } finally { release(); }
}

function removeOwnedDirectory(directory: string, owned: fs.Stats): void {
  ensureArchiveDirectory(path.dirname(directory));
  let current: fs.Stats;
  try { current = fs.lstatSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) {
    throw new Error("Refusing cleanup of a replaced import directory: " + directory);
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
function cleanupError(original: unknown, cleanup: unknown): Error {
  const text = (error: unknown): string => error instanceof Error ? error.message : String(error);
  return new Error(`${text(original)}; import cleanup failed: ${text(cleanup)}`, { cause: original });
}

export function importProfileArchive(zipPath: string): ImportProfileResult {
  const mutationGate = requireProfileMutation();
  if (!mutationGate.ok) throw new Error(mutationGate.error);
  zipPath = assertSafeArchiveImportPath(zipPath);
  const profilesDir = ensureArchiveDirectory(getProfilesDir(), true);
  // Renaming children from os.tmpdir() can fail with EXDEV on relocated data.
  // An exclusive private staging directory under profiles is on the same volume.
  const tmpDir = fs.mkdtempSync(path.join(profilesDir, ".abs-profile-import-"));
  const stagingOwner = fs.lstatSync(tmpDir);
  let profileDir: string | null = null, profileOwner: fs.Stats | null = null;
  let dirId: string | null = null, release: (() => void) | null = null;
  let committed = false, result: ImportProfileResult | null = null, failure: unknown;
  try {
    const extracted = extractZipArchive(zipPath, tmpDir, { maxTotalBytes: MAX_IMPORT_BYTES });
    const metaPath = path.join(tmpDir, META_FILE);
    if (!fs.existsSync(metaPath)) throw new Error("Archive is missing meta.json — not a profile backup");
    let metaDoc: any;
    try { metaDoc = JSON.parse(fs.readFileSync(metaPath, "utf8")); }
    catch (error) { throw new Error("Archive meta.json is corrupt", { cause: error }); }
    if (metaDoc?.formatVersion !== PROFILE_ARCHIVE_FORMAT) throw new Error("Unsupported archive format: " + JSON.stringify(metaDoc?.formatVersion));
    // Compare the original document before the normalizer supplies a new seed
    // for legacy backups. A generated value cannot prove the old identity.
    const importedMeta = normalizePortableProfileMeta(metaDoc.profile);
    const identity = compareProfileIdentity(metaDoc.profile, importedMeta);
    const hadLocalFontsDir = metaDoc.omitted?.fontsDir === true ||
      (typeof metaDoc.profile?.fontsDir === "string" && Boolean(metaDoc.profile.fontsDir.trim()));
    const warnings = importWarnings(importedMeta, hadLocalFontsDir);
    if (identity.configuration.state === "missing-seed") {
      warnings.push("Legacy backup has no fingerprint seed; a new seed was generated. The previous fingerprint cannot be verified, and runtime identity has not been retested.");
    } else if (identity.configuration.state === "changed") {
      warnings.push("Imported fingerprint configuration was normalized with changes; review the identity differences before launching. Runtime identity has not been retested.");
    } else if (identity.configuration.state === "not-verifiable") {
      warnings.push("The backup's fingerprint configuration cannot be verified. A copied fingerprint baseline is not a runtime identity retest.");
    }
    const recovery = inspectArchiveRecovery(tmpDir, metaDoc.sourceDirId, false, importedMeta.engine || "chromium");
    preserveImportedRecovery(tmpDir, metaDoc.sourceDirId, recovery, warnings);
    dirId = newDirId(); validateDirId(dirId);
    if (Object.hasOwn(getConfig().browserProfiles || {}, dirId)) throw new Error("Imported profile ID already exists (config collision)");
    profileDir = path.join(profilesDir, dirId);
    release = acquireRestoreLock(dirId);
    // Fresh local generation: an imported baseline/report is not runtime proof.
    markProfileDataChanging(dirId);
    // Never use recursive mkdir here: EEXIST is not proof of ownership.
    fs.mkdirSync(profileDir, { mode: 0o700 });
    profileOwner = fs.lstatSync(profileDir);
    for (const child of fs.readdirSync(tmpDir)) {
      if (child === META_FILE) continue;
      fs.renameSync(path.join(tmpDir, child), path.join(profileDir, child));
    }
    const profileSynced = syncArchiveDirectory(profileDir), rootSynced = syncArchiveDirectory(profilesDir);
    if (!profileSynced || !rootSynced) {
      warnings.push("Directory fsync is unsupported on Windows; imported files were synced, but directory durability is not guaranteed.");
    }
    const id = dirId;
    const name = transact((draft) => {
      draft.browserProfiles = draft.browserProfiles || {};
      if (Object.hasOwn(draft.browserProfiles, id)) throw new Error("Imported profile ID already exists (live config collision)");
      const name = uniqueName(importedMeta.name, draft.browserProfiles);
      draft.browserProfiles[id] = { ...importedMeta, name };
      return name;
    });
    // No fallible post-commit lookup may turn this adoption into a rollback.
    committed = true;
    result = { dirId, name, files: extracted.files, bytes: extracted.bytes, warnings, identity };
  } catch (error) {
    failure = error;
    if (!committed && profileDir && profileOwner && dirId) {
      try {
        // If a live transaction adopted the ID, its data is no longer ours to
        // delete, even if some later observer reported an exception.
        if (Object.hasOwn(getConfig().browserProfiles || {}, dirId)) {
          failure = new Error("Import may already be committed; adopted profile data retained: " + (error instanceof Error ? error.message : String(error)), { cause: error });
        } else removeOwnedDirectory(profileDir, profileOwner);
      } catch (cleanup) { failure = cleanupError(failure, cleanup); }
    }
  } finally {
    try { removeOwnedDirectory(tmpDir, stagingOwner); }
    catch (cleanup) {
      if (committed && result) result.warnings.push("Import committed; staging cleanup failed: " + (cleanup instanceof Error ? cleanup.message : String(cleanup)));
      else failure = cleanupError(failure || new Error("Import did not commit"), cleanup);
    }
    release?.();
  }
  if (failure) throw failure;
  return result!;
}

export interface BatchArchiveExportOptions extends WriteZipOptions {
  /** Main-only native confirmation scope, not a renderer-provided permission. */
  confirmedOverwritePaths?: readonly string[];
}

function batchArchivePath(destDir: string, dirId: string, name: string): string {
  const safeName = String(name || dirId).replace(/[^A-Za-z0-9._-]/g, "_").trim() || dirId;
  return path.join(destDir, safeName + "-" + dirId + ".zip");
}

/** Read-only native confirmation preflight. Picking a directory alone is not
 * consent to replace its files; callers approve only these exact paths. */
export function getProfileArchiveExportConflicts(dirIds: string[], destDir: string): string[] {
  assertArchiveBatchInput(dirIds, "dirIds");
  destDir = assertSafeArchiveExportDir(destDir);
  const conflicts: string[] = [];
  for (const dirId of dirIds) {
    validateDirId(dirId);
    const meta = getProfileMeta(dirId);
    if (!meta) continue;
    try { assertProfileTransferStopped(dirId, () => statusBrowser(dirId), undefined, { engine: meta.engine }); }
    catch (error) { if ((error as { code?: string })?.code === "PROFILE_STOP_REQUIRED") continue; throw error; }
    const filePath = assertSafeArchiveExportPath(batchArchivePath(destDir, dirId, meta.name));
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })) conflicts.push(filePath);
  }
  return [...new Set(conflicts)];
}

/**
 * Export several profiles into one destination directory. Running profiles are
 * skipped (their browser data may be mid-write); missing/errored profiles are
 * reported per item so a single bad profile never aborts the whole batch.
 */
export async function exportProfileArchives(dirIds: string[], destDir: string, options: BatchArchiveExportOptions = {}): Promise<BatchExportReport> {
  // Refuse up front rather than letting the per-item catch turn a viewer
  // denial into a report full of "failed" entries.
  const secretGate = requireAccountSecret();
  if (!secretGate.ok) throw new Error(secretGate.error);
  assertArchiveBatchInput(dirIds, "dirIds");
  if (options.overwrite !== undefined && typeof options.overwrite !== "boolean") throw Object.assign(new Error("overwrite must be a boolean"), { code: "ARCHIVE_INVALID_INPUT" });
  destDir = assertSafeArchiveExportDir(destDir);
  fs.mkdirSync(destDir, { recursive: true });
  const report: BatchExportReport = { exported: [], skipped: [], failed: [] };
  for (const dirId of dirIds) {
    try {
      validateDirId(dirId);
      const meta = getProfileMeta(dirId);
      if (!meta) {
        report.failed.push({ dirId, error: "Profile not found" });
        continue;
      }
      try { assertProfileTransferStopped(dirId, () => statusBrowser(dirId), undefined, { engine: meta.engine }); }
      catch (error) {
        if ((error as { code?: string })?.code !== "PROFILE_STOP_REQUIRED") throw error;
        report.skipped.push({ dirId, reason: "running-or-unconfirmed", code: "PROFILE_STOP_REQUIRED" });
        continue;
      }
      const filePath = batchArchivePath(destDir, dirId, meta.name);
      const overwrite = options.overwrite === true || options.confirmedOverwritePaths?.includes(filePath) === true;
      const result = await exportProfileArchive(dirId, filePath, { overwrite });
      report.exported.push({ dirId, filePath: result.filePath, entries: result.entries, bytes: result.bytes, ...(result.warnings ? { warnings: result.warnings } : {}) });
    } catch (e: any) {
      const failure = archiveOperationFailure(e);
      report.failed.push({ dirId, error: failure.error, ...(failure.code ? { code: failure.code } : {}) });
    }
  }
  return report;
}

/** Import several profile backup ZIPs, reporting per-archive success/failure. */
export function importProfileArchives(zipPaths: string[]): BatchImportReport {
  assertArchiveBatchInput(zipPaths, "zipPaths");
  const report: BatchImportReport = { imported: [], failed: [] };
  for (const zipPath of zipPaths) {
    try {
      const r = importProfileArchive(zipPath);
      report.imported.push({ zipPath, dirId: r.dirId, name: r.name, files: r.files, bytes: r.bytes, warnings: r.warnings, ...(r.identity ? { identity: r.identity } : {}) });
    } catch (e: any) {
      const failure = archiveOperationFailure(e);
      report.failed.push({ zipPath, error: failure.error, ...(failure.code ? { code: failure.code } : {}) });
    }
  }
  return report;
}
