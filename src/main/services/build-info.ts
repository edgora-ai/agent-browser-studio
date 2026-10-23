// ── Build / runtime identity for the About dialog ──
//
// Everything here is read-only evidence about *this* binary, not a lookup of
// what the source tree currently says. That distinction matters: a packaged
// build's package.json version comes from the app.asar, while a dev run's
// version comes from the checked-out tree, and the two must not be blended.
//
// "Packaged at" has no single reliable source across electron-builder targets,
// so this module reports the facts it can actually observe — app bundle mtime,
// archive mtimes, compile-entry mtime — and marks each with what it is. It
// never backfills a guessed timestamp or substitutes "now".

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { BundledBrowsersManifest } from "./bundled-native-browsers.js";

/**
 * Electron patches `node:fs` so an `.asar` path stats as a VIRTUAL DIRECTORY
 * (`isFile() === false`, size 0). `fileStamp` rejected that shape, so the About
 * dialog reported the app archive as unavailable even though it existed.
 * `original-fs` is Electron's unpatched binding and sees the real file; under
 * plain Node it is absent, so the fallback keeps unit tests and tools working.
 */
const realFs = (() => {
  try {
    return createRequire(import.meta.url)("original-fs") as typeof fs;
  } catch {
    return fs;
  }
})();

export interface BuildFileStamp {
  path: string;
  /** ISO-8601 mtime, or null when the file is absent/unreadable. */
  mtime: string | null;
}

export interface BuildEngineInfo {
  version: string | null;
  /** Version of the shipped archive/manifest, not of an installed engine. */
  bundledVersion: string | null;
  /** Source of bundledVersion: manifest, archive name, or null. */
  bundledSource: "manifest" | "archive" | null;
  appArchive: BuildFileStamp | null;
}

export interface BuildInfo {
  name: string;
  version: string;
  appId: string;
  packaged: boolean;
  /** Electron's app path (asar inside a bundle, repo root in dev). */
  appPath: string;
  resourcesPath: string | null;
  /** mtime of the .app bundle (macOS) — the pack time witness, not a build log. */
  bundle: BuildFileStamp | null;
  appArchive: BuildFileStamp | null;
  /** Compiled main entry; its mtime is the last compile into this build. */
  mainEntry: BuildFileStamp | null;
  engines: { chromium: BuildEngineInfo; firefox: BuildEngineInfo };
  /**
   * Versions of engines installed on this host. Null means "not discovered",
   * not "absent" — this is a label, and the bundled version is reported
   * separately because the two can legitimately differ.
   */
  engineInstalled: { chromium: string | null; firefox: string | null };
  runtime: {
    electron: string;
    chrome: string;
    node: string;
    v8: string;
    modules: string;
  };
  host: {
    platform: NodeJS.Platform;
    arch: string;
    release: string;
    osName: string | null;
    osVersion: string | null;
  };
  locale: {
    app: string;
    system: string;
  };
}

export interface BuildInfoInput {
  pkg: { name?: string; version?: string };
  packaged: boolean;
  appPath: string;
  resourcesPath: string | null;
  bundleRoot: string | null;
  mainEntry: string;
  enginesRoot: string | null;
  runtime: BuildInfo["runtime"];
  host: BuildInfo["host"];
  locale: BuildInfo["locale"];
  appId: string;
  engineInstalled?: BuildInfo["engineInstalled"];
}

function fileStamp(file: string | null): BuildFileStamp | null {
  if (!file) return null;
  try {
    // Read through original-fs: Electron's patched fs reports the .asar as a
    // directory, which is exactly the file the dialog needs to describe.
    const stat = realFs.statSync(file);
    if (!stat.isFile()) return null;
    return { path: file, mtime: new Date(stat.mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

function directoryStamp(dir: string | null): BuildFileStamp | null {
  if (!dir) return null;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return null;
    return { path: dir, mtime: new Date(stat.mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

/**
 * Version embedded in an archive name like
 * `chromium-darwin-152.0.7977.72-159625279-1792670536465`. The trailing
 * numbers are the archive size and a sync timestamp, not version components.
 */
export function versionFromArchiveName(name: string, kind: "chromium" | "firefox"): string | null {
  // Archive resource names are `Chromium.app.zip` / `Firefox.app.zip`; unpack
  // cache directories are `chromium-darwin-152.0.7977.72-<bytes>-<stamp>`.
  // Accept both shapes and require a dot-separated numeric version, so the
  // trailing size/timestamp cannot be mistaken for one.
  const haystack = name.toLowerCase();
  if (!haystack.includes(kind)) return null;
  const match = /(\d+\.\d+(?:\.\d+)*)/.exec(name);
  return match ? match[1] : null;
}

/** Read the shipped manifest if present. Never throws on malformed input. */
export function readBrowsersManifest(root: string | null): BundledBrowsersManifest | null {
  if (!root) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "browsers-manifest.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as BundledBrowsersManifest : null;
  } catch {
    return null;
  }
}

function findEngineArchive(enginesRoot: string | null, kind: "chromium" | "firefox"): BuildFileStamp | null {
  if (!enginesRoot) return null;
  const expected = kind === "chromium" ? "Chromium.app.zip" : "Firefox.app.zip";
  const direct = path.join(enginesRoot, expected);
  const stamp = fileStamp(direct);
  if (stamp) return stamp;
  // Date/platform sub-directories are used by some historical layouts.
  try {
    for (const entry of fs.readdirSync(enginesRoot)) {
      const candidate = path.join(enginesRoot, entry, expected);
      const nested = fileStamp(candidate);
      if (nested) return nested;
    }
  } catch {
    /* no such directory — reported as absent */
  }
  return null;
}

function engineInfo(
  root: string | null,
  manifest: BundledBrowsersManifest | null,
  kind: "chromium" | "firefox",
): BuildEngineInfo {
  const archive = findEngineArchive(root, kind);
  const manifestVersion = kind === "chromium" ? manifest?.chromiumVersion : manifest?.firefoxVersion;
  if (manifestVersion) {
    return { version: null, bundledVersion: String(manifestVersion), bundledSource: "manifest", appArchive: archive };
  }
  let archiveVersion: string | null = null;
  if (root) {
    try {
      for (const entry of fs.readdirSync(root)) {
        const parsed = versionFromArchiveName(entry, kind);
        if (parsed) { archiveVersion = parsed; break; }
      }
    } catch {
      /* absent root */
    }
  }
  return { version: null, bundledVersion: archiveVersion, bundledSource: archiveVersion ? "archive" : null, appArchive: archive };
}

/**
 * Pure-ish collector: reads filesystem metadata and returns the About payload.
 * No network, no config, no license state — those are added by the caller so
 * this stays testable without Electron.
 */
export function collectBuildInfo(input: BuildInfoInput): BuildInfo {
  const manifest = readBrowsersManifest(input.enginesRoot);
  return {
    name: String(input.pkg.name || ""),
    version: String(input.pkg.version || ""),
    appId: input.appId,
    packaged: input.packaged,
    appPath: input.appPath,
    resourcesPath: input.resourcesPath,
    bundle: directoryStamp(input.bundleRoot),
    // `appPath` IS the asar inside a packaged app and the repo root in dev, so
    // the bundle-relative candidate only applies to the dev shape. Prefer the
    // resources directory first: it is correct in both layouts.
    appArchive: fileStamp(path.join(input.resourcesPath || "", "app.asar")) ??
      fileStamp(path.join(input.appPath, "Contents", "Resources", "app.asar")) ??
      (input.appPath.endsWith("app.asar") ? fileStamp(input.appPath) : null),
    mainEntry: fileStamp(input.mainEntry),
    engines: {
      chromium: engineInfo(input.enginesRoot, manifest, "chromium"),
      firefox: engineInfo(input.enginesRoot, manifest, "firefox"),
    },
    engineInstalled: input.engineInstalled ?? { chromium: null, firefox: null },
    runtime: input.runtime,
    // Normalize here, not in the renderer: every consumer of build info gets
    // the same reduced form, and the raw kernel banner never reaches the UI.
    host: { ...input.host, osVersion: conciseOsVersion(input.host.osName, input.host.osVersion) },
    locale: input.locale,
  };
}

/** ISO text or the literal "unavailable" — never a fabricated date. */
export function formatStamp(stamp: BuildFileStamp | null): string {
  return stamp?.mtime ?? "unavailable";
}

/**
 * macOS `os.version()` returns the whole kernel banner
 * ("Darwin Kernel Version 25.3.0: Wed Jan 28 … root:xnu-…"), and `os.type()`
 * already says "Darwin". The About row showed "Darwin Darwin Kernel Version…".
 * Reduce it to the release-plus-build identity a user can compare, keeping the
 * raw banner out of the dialog; unknown shapes pass through unchanged.
 */
export function conciseOsVersion(osName: string | null, osVersion: string | null): string | null {
  if (!osVersion) return null;
  const banner = /Darwin Kernel Version\s+([^:\s]+)(?::\s*([^;]+))?/.exec(osVersion);
  if (banner) {
    const build = banner[2]?.trim();
    return build ? `${banner[1]} (${build})` : banner[1];
  }
  return osVersion;
}
