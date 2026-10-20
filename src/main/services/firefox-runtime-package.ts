import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUTIL = "/usr/bin/plutil";
const PLIST_LIMIT = 1024 * 1024;
const PLIST_OPTIONS = { encoding: "utf8", timeout: 3_000, maxBuffer: PLIST_LIMIT, killSignal: "SIGKILL" } as const;
const HELPER_APPS = ["plugin-container.app", "gpu-helper.app", "gpu-process.app", "media-plugin-helper.app"];
const DEVELOPER_PATH_KEYS = ["MozillaDeveloperObjPath", "MozillaDeveloperRepoPath"];

function invalid(file: string, reason: string): Error & { code: string } {
  return Object.assign(new Error(`Invalid Firefox runtime package: ${reason}: ${file}`), {
    code: "FIREFOX_RUNTIME_PACKAGE_INVALID",
  });
}

function layout(binaryPath: string) {
  const binary = path.resolve(binaryPath);
  const macos = path.dirname(binary);
  const contents = path.dirname(macos);
  const app = path.dirname(contents);
  if (path.basename(macos) !== "MacOS" || path.basename(contents) !== "Contents" || !app.endsWith(".app")) {
    throw invalid(binary, "expected an application bundle executable in Contents/MacOS");
  }
  const resources = path.join(contents, "Resources");
  return {
    directories: [app, contents, macos, resources, path.join(resources, "browser")],
    files: [binary, path.join(resources, "omni.ja"), path.join(resources, "browser", "omni.ja")],
    mainPlist: path.join(contents, "Info.plist"),
    helpers: HELPER_APPS.map((name) => path.join(macos, name)),
  };
}

function requireDirectory(file: string, stat: fs.Stats): void {
  if (!stat.isDirectory()) throw invalid(file, "expected a real directory, not a symlink");
}
function requireFile(file: string, stat: fs.Stats, plist = false): void {
  if (!stat.isFile() || stat.size === 0 || (plist && stat.size > PLIST_LIMIT)) {
    throw invalid(file, "expected a nonempty regular file (bounded to 1 MiB for plists), not a symlink");
  }
}
function statSync(file: string, optional = false): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid(file, "missing or unreadable file/directory");
  }
}
async function statAsync(file: string, optional = false): Promise<fs.Stats | null> {
  try { return await fs.promises.lstat(file); } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid(file, "missing or unreadable file/directory");
  }
}

function parsePlist(file: string, json: string, expectedVersion?: string): void {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw invalid(file, "could not decode Info.plist"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(file, "Info.plist must be a dictionary");
  const plist = value as Record<string, unknown>;
  for (const key of DEVELOPER_PATH_KEYS) {
    // Presence, not truthiness: empty development paths are not distribution metadata.
    if (Object.prototype.hasOwnProperty.call(plist, key)) throw invalid(file, `development path key ${key} is forbidden`);
  }
  // Compare the full product version when the caller has a directory/probe/report
  // version. CFBundleVersion is a macOS build-order field, not necessarily the
  // product version (e.g. packaged Nightly); helper bundles have their own versions.
  if (expectedVersion !== undefined && plist.CFBundleShortVersionString !== expectedVersion) {
    throw invalid(file, `product version does not match ${expectedVersion}`);
  }
}
function plistArgs(file: string): string[] { return ["-convert", "json", "-o", "-", "--", file]; }
function readPlistSync(file: string): string {
  try { return execFileSync(PLUTIL, plistArgs(file), { ...PLIST_OPTIONS, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw invalid(file, "could not parse XML/binary Info.plist with plutil"); }
}
async function readPlistAsync(file: string): Promise<string> {
  // Do not use the binary-only browser-command cache: changing a plist must be
  // observed even when the plutil executable and Firefox/XUL identities are hot.
  return new Promise((resolve, reject) => {
    const failure = () => invalid(file, "could not parse XML/binary Info.plist with plutil");
    try {
      execFile(PLUTIL, plistArgs(file), PLIST_OPTIONS, (error, stdout) => {
        if (error) reject(failure());
        else resolve(stdout);
      });
    } catch { reject(failure()); }
  });
}

/** Static macOS distribution-layout gate, not ZIP/resource integrity, signature,
 * executable provenance or launch verification. Never executes the selected
 * Firefox file. Other platforms retain their existing selection/attestation.
 * No success cache: every candidate (including a bundled-cache hit) is rechecked.
 */
export function assertFirefoxRuntimePackage(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
  expectedVersion?: string,
): void {
  if (platform !== "darwin") return;
  const spec = layout(binaryPath);
  for (const file of spec.directories) requireDirectory(file, statSync(file)!);
  for (const file of spec.files) requireFile(file, statSync(file)!);
  const checkPlist = (file: string, version?: string) => {
    requireFile(file, statSync(file)!, true);
    parsePlist(file, readPlistSync(file), version);
  };
  checkPlist(spec.mainPlist, expectedVersion);
  for (const helper of spec.helpers) {
    const stat = statSync(helper, true);
    if (!stat) continue; // Older distributions need not contain all helper kinds.
    requireDirectory(helper, stat);
    const contents = path.join(helper, "Contents");
    requireDirectory(contents, statSync(contents)!);
    checkPlist(path.join(contents, "Info.plist"));
  }
}

export async function assertFirefoxRuntimePackageAsync(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
  expectedVersion?: string,
): Promise<void> {
  if (platform !== "darwin") return;
  const spec = layout(binaryPath);
  for (const file of spec.directories) requireDirectory(file, (await statAsync(file))!);
  for (const file of spec.files) requireFile(file, (await statAsync(file))!);
  const checkPlist = async (file: string, version?: string) => {
    requireFile(file, (await statAsync(file))!, true);
    parsePlist(file, await readPlistAsync(file), version);
  };
  await checkPlist(spec.mainPlist, expectedVersion);
  for (const helper of spec.helpers) {
    const stat = await statAsync(helper, true);
    if (!stat) continue;
    requireDirectory(helper, stat);
    const contents = path.join(helper, "Contents");
    requireDirectory(contents, (await statAsync(contents))!);
    await checkPlist(path.join(contents, "Info.plist"));
  }
}
