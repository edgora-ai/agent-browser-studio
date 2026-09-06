// Bundled (shipped-in-app) browser discovery.
//
// electron-builder embeds the compiled Chromium + Firefox bundles from
// `native-browsers/<platform>` into `Contents/Resources/native-browsers` (mac)
// / `<install>/resources/native-browsers` (win/linux). On macOS the bundles are
// shipped as `.app.zip` archives: the Electron app's own sign step would
// otherwise recurse into the nested .app and abort on Chromium's Framework
// symlink layout. The runtime unpacks an archive to the user cache directory on
// first use and reuses it afterwards. The env-var override (debug) wins over
// everything; the shipped bundle is the reliable default underneath it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export interface BundledBrowsersManifest {
  platform?: string;
  chromiumVersion?: string | null;
  firefoxVersion?: string | null;
  syncedAt?: string;
}

type ProcessLike = NodeJS.Process & { resourcesPath?: string };

const UNPACK_CACHE_DIR = "bundled-browsers";

export function bundledBrowsersRoot(
  platform: NodeJS.Platform = process.platform,
  resourcesPath: string | undefined | null = (process as ProcessLike).resourcesPath,
): string | null {
  if (!resourcesPath) return null;
  const base = path.join(resourcesPath, "native-browsers");
  // Node reports "win32" but staged dir + builder extraResources use "win".
  if (platform === "darwin") return base;
  if (platform === "win32") return path.join(base, "win");
  return path.join(base, platform);
}

function effectiveResourcesPath(
  env: NodeJS.ProcessEnv,
  resourcesPath?: string | null,
): string | null {
  if (env.AGENT_BROWSER_BUNDLED_RESOURCES) return env.AGENT_BROWSER_BUNDLED_RESOURCES;
  return resourcesPath ?? null;
}

function bundledRoot(
  platform: NodeJS.Platform = process.platform,
  resourcesPath?: string | null,
): string | null {
  return bundledBrowsersRoot(platform, effectiveResourcesPath(process.env, resourcesPath));
}

function unpackCacheDir(platform: NodeJS.Platform, kind: "chromium" | "firefox"): string {
  const home = os.homedir();
  return path.join(home, ".agent-browser-studio", UNPACK_CACHE_DIR, `${kind}-${platform}`);
}

function unpackArchiveIfNeeded(
  zipPath: string,
  cacheDir: string,
): void {
  const marker = path.join(cacheDir, ".ready");
  if (fs.existsSync(marker)) return;
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  spawnSync("ditto", ["-x", "-k", zipPath, cacheDir], { encoding: "utf8", timeout: 300000 });
  fs.writeFileSync(marker, `${Date.now()}\n`);
}

function macBinaryInsideUnpacked(kind: "chromium" | "firefox", cacheDir: string): string | null {
  const candidate = path.join(cacheDir, kind === "chromium" ? "Chromium.app" : "Firefox.app", "Contents", "MacOS", kind === "chromium" ? "Chromium" : "firefox");
  return fs.existsSync(candidate) ? candidate : null;
}

export function bundledChromiumBinaryPath(
  platform: NodeJS.Platform = process.platform,
  resourcesPath?: string | null,
): string | null {
  const root = bundledRoot(platform, resourcesPath);
  if (!root) return null;
  if (platform === "darwin") {
    const unpacked = path.join(root, "Chromium.app", "Contents", "MacOS", "Chromium");
    if (fs.existsSync(unpacked)) return unpacked;
    const zip = path.join(root, "Chromium.app.zip");
    if (fs.existsSync(zip)) {
      const cacheDir = unpackCacheDir(platform, "chromium");
      unpackArchiveIfNeeded(zip, cacheDir);
      return macBinaryInsideUnpacked("chromium", cacheDir);
    }
    return null;
  }
  const candidate = platform === "win32" ? path.join(root, "chromium", "chrome.exe") : path.join(root, "chromium");
  return fs.existsSync(candidate) ? candidate : null;
}

export function bundledFirefoxBinaryPath(
  platform: NodeJS.Platform = process.platform,
  resourcesPath?: string | null,
): string | null {
  const root = bundledRoot(platform, resourcesPath);
  if (!root) return null;
  if (platform === "darwin") {
    const unpacked = path.join(root, "Firefox.app", "Contents", "MacOS", "firefox");
    if (fs.existsSync(unpacked)) return unpacked;
    const zip = path.join(root, "Firefox.app.zip");
    if (fs.existsSync(zip)) {
      const cacheDir = unpackCacheDir(platform, "firefox");
      unpackArchiveIfNeeded(zip, cacheDir);
      return macBinaryInsideUnpacked("firefox", cacheDir);
    }
    return null;
  }
  const candidate = path.join(root, "firefox", platform === "win32" ? "firefox.exe" : "firefox");
  return fs.existsSync(candidate) ? candidate : null;
}

export function readBundledBrowsersManifest(
  platform: NodeJS.Platform = process.platform,
  resourcesPath?: string | null,
): BundledBrowsersManifest | null {
  const root = bundledRoot(platform, resourcesPath);
  if (!root) return null;
  try {
    const raw = fs.readFileSync(path.join(root, "browsers-manifest.json"), "utf8");
    return JSON.parse(raw) as BundledBrowsersManifest;
  } catch {
    return null;
  }
}