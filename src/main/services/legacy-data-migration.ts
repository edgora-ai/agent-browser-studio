import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  LEGACY_PROFILE_DIR_NAME,
  PROFILE_DIR_NAME,
} from "../branding.js";

export interface LegacyDataMigrationReport {
  migrated: boolean;
  source: string;
  target: string;
  profileCount: number;
  profileFileCount: number;
  profileSymlinkCount: number;
  sourceProfileSha256: string | null;
  targetProfileSha256: string | null;
  sourceConfigSha256: string | null;
  targetConfigSha256: string | null;
}

export interface LegacyChromiumMigrationReport {
  migratedVersions: string[];
  retainedVersions: string[];
  source: string;
  target: string;
}

const MIGRATION_MARKER = ".agent-browser-studio-migration-v1.json";
const CHROMIUM_VERSION_DIR = /^chromium-(\d+(?:\.\d+){3})$/;

function hasManagedChromiumExecutable(directory: string): boolean {
  const candidates = [
    path.join(directory, "Chromium.app", "Contents", "MacOS", "Chromium"),
    path.join(directory, "chrome.exe"),
    path.join(directory, "chromium"),
  ];
  return candidates.some((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function pathExists(filePath: string): boolean {
  try { fs.lstatSync(filePath); return true; } catch { return false; }
}

function removeEmptyDirectory(directory: string): void {
  if (!fs.existsSync(directory)) return;
  if (!fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length > 0) {
    throw new Error(`Migration target is not empty: ${directory}`);
  }
  fs.rmdirSync(directory);
}

function copyTreeCloned(source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), target);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: false, mode: stat.mode });
    for (const entry of fs.readdirSync(source).sort()) {
      copyTreeCloned(path.join(source, entry), path.join(target, entry));
    }
    try { fs.chmodSync(target, stat.mode); } catch { /* best effort */ }
    return;
  }
  if (!stat.isFile()) return;
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE_FORCE);
  } catch {
    fs.copyFileSync(source, target);
  }
  try { fs.chmodSync(target, stat.mode); } catch { /* best effort */ }
}

function rewritePathPrefix(value: unknown, replacements: Array<[string, string]>): unknown {
  if (typeof value === "string") {
    for (const [source, target] of replacements) {
      if (value === source) return target;
      if (value.startsWith(`${source}${path.sep}`)) return `${target}${value.slice(source.length)}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rewritePathPrefix(item, replacements));
  if (!value || typeof value !== "object") return value;
  const rewritten: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) rewritten[key] = rewritePathPrefix(item, replacements);
  return rewritten;
}

function migrateConfig(
  configPath: string,
  replacements: Array<[string, string]>,
): void {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const rewritten = rewritePathPrefix(parsed, replacements) as Record<string, unknown>;
  rewritten.version = Math.max(4, Number(rewritten.version) || 0);
  if (rewritten.chromiumBin === undefined && rewritten["cloakBin"] !== undefined) {
    rewritten.chromiumBin = rewritten["cloakBin"];
  }
  if (rewritten.browserProfiles === undefined && rewritten["cloakProfiles"] !== undefined) {
    rewritten.browserProfiles = rewritten["cloakProfiles"];
  }
  delete rewritten["cloakBin"];
  delete rewritten["cloakProfiles"];
  const temporary = `${configPath}.migration-tmp`;
  fs.writeFileSync(temporary, JSON.stringify(rewritten, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, configPath);
}

export function hashDirectoryTree(directory: string): {
  sha256: string;
  files: number;
  symlinks: number;
  directories: number;
} {
  const hash = createHash("sha256");
  let files = 0;
  let symlinks = 0;
  let directories = 0;
  const visit = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      hash.update(`L\0${relative}\0${fs.readlinkSync(current)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      directories += 1;
      hash.update(`D\0${relative}\0`);
      for (const entry of fs.readdirSync(current).sort()) {
        visit(path.join(current, entry), relative ? `${relative}/${entry}` : entry);
      }
      return;
    }
    if (!stat.isFile()) return;
    files += 1;
    hash.update(`F\0${relative}\0${stat.size}\0`);
    const fd = fs.openSync(current, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    hash.update("\0");
  };
  if (fs.existsSync(directory)) visit(directory, "");
  return { sha256: hash.digest("hex"), files, symlinks, directories };
}

export function migrateLegacyUserData(options: {
  source: string;
  target: string;
  legacyChromiumRoot?: string;
  chromiumRoot?: string;
}): LegacyDataMigrationReport {
  const { source, target } = options;
  const sourceConfig = path.join(source, "config.json");
  const targetConfig = path.join(target, "config.json");
  const sourceProfiles = path.join(source, LEGACY_PROFILE_DIR_NAME);
  const targetProfiles = path.join(target, PROFILE_DIR_NAME);
  if (fs.existsSync(targetConfig)) {
    const tree = hashDirectoryTree(targetProfiles);
    return {
      migrated: false,
      source,
      target,
      profileCount: fs.existsSync(targetProfiles)
        ? fs.readdirSync(targetProfiles).filter((entry) => fs.lstatSync(path.join(targetProfiles, entry)).isDirectory()).length
        : 0,
      profileFileCount: tree.files,
      profileSymlinkCount: tree.symlinks,
      sourceProfileSha256: null,
      targetProfileSha256: tree.sha256,
      sourceConfigSha256: null,
      targetConfigSha256: sha256File(targetConfig),
    };
  }
  if (!fs.existsSync(sourceConfig)) {
    return {
      migrated: false,
      source,
      target,
      profileCount: 0,
      profileFileCount: 0,
      profileSymlinkCount: 0,
      sourceProfileSha256: null,
      targetProfileSha256: null,
      sourceConfigSha256: null,
      targetConfigSha256: null,
    };
  }

  removeEmptyDirectory(target);
  const sourceTree = hashDirectoryTree(sourceProfiles);
  const sourceConfigSha256 = sha256File(sourceConfig);
  const stage = path.join(path.dirname(target), `.${path.basename(target)}.migration-${process.pid}-${Date.now()}`);
  if (pathExists(stage)) throw new Error(`Migration stage already exists: ${stage}`);
  try {
    copyTreeCloned(source, stage);
    const stagedLegacyProfiles = path.join(stage, LEGACY_PROFILE_DIR_NAME);
    const stagedProfiles = path.join(stage, PROFILE_DIR_NAME);
    if (fs.existsSync(stagedLegacyProfiles)) fs.renameSync(stagedLegacyProfiles, stagedProfiles);
    const replacements: Array<[string, string]> = [[source, target]];
    if (options.legacyChromiumRoot && options.chromiumRoot) {
      replacements.push([options.legacyChromiumRoot, options.chromiumRoot]);
    }
    migrateConfig(path.join(stage, "config.json"), replacements);
    const targetTree = hashDirectoryTree(stagedProfiles);
    if (sourceTree.sha256 !== targetTree.sha256 || sourceTree.files !== targetTree.files || sourceTree.symlinks !== targetTree.symlinks) {
      throw new Error("Profile tree changed while copying legacy data");
    }
    const profileCount = fs.existsSync(stagedProfiles)
      ? fs.readdirSync(stagedProfiles).filter((entry) => fs.lstatSync(path.join(stagedProfiles, entry)).isDirectory()).length
      : 0;
    const report: LegacyDataMigrationReport = {
      migrated: true,
      source,
      target,
      profileCount,
      profileFileCount: targetTree.files,
      profileSymlinkCount: targetTree.symlinks,
      sourceProfileSha256: sourceTree.sha256,
      targetProfileSha256: targetTree.sha256,
      sourceConfigSha256,
      targetConfigSha256: sha256File(path.join(stage, "config.json")),
    };
    fs.writeFileSync(path.join(stage, MIGRATION_MARKER), JSON.stringify({ ...report, migratedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(stage, target);
    return report;
  } catch (error) {
    if (pathExists(stage)) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function migrateLegacyChromiumCache(options: {
  source: string;
  target: string;
}): LegacyChromiumMigrationReport {
  const { source, target } = options;
  const report: LegacyChromiumMigrationReport = { migratedVersions: [], retainedVersions: [], source, target };
  if (!fs.existsSync(source)) return report;
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source).sort()) {
    const match = entry.match(CHROMIUM_VERSION_DIR);
    if (!match) continue;
    const sourceVersion = path.join(source, entry);
    if (!hasManagedChromiumExecutable(sourceVersion)) continue;
    const targetVersion = path.join(target, entry);
    if (fs.existsSync(targetVersion)) {
      if (!hasManagedChromiumExecutable(targetVersion)) {
        throw new Error(`Existing Chromium migration target is incomplete: ${targetVersion}`);
      }
      report.retainedVersions.push(match[1]);
      continue;
    }
    const stage = path.join(target, `.${entry}.migration-${process.pid}-${Date.now()}`);
    try {
      copyTreeCloned(sourceVersion, stage);
      if (!hasManagedChromiumExecutable(stage)) {
        throw new Error(`Migrated Chromium ${match[1]} is incomplete`);
      }
      fs.renameSync(stage, targetVersion);
      report.migratedVersions.push(match[1]);
    } catch (error) {
      if (pathExists(stage)) fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }
  return report;
}
