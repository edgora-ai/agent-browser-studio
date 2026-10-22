// Read-only build identity for the About dialog.
//
// These tests pin the two properties the dialog depends on:
//   1. it reports what this binary actually carries (manifest/archive version,
//      file stamps), and
//   2. it never invents a value — a missing stamp stays null so the UI can say
//      "unavailable" instead of silently showing a plausible date.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectBuildInfo,
  formatStamp,
  readBrowsersManifest,
  versionFromArchiveName,
  conciseOsVersion,
  type BuildInfoInput,
} from "../../src/main/services/build-info.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "abs-build-info-"));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeEngineLayout(dir: string, files: { archives?: string[]; manifest?: unknown }): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files.archives ?? []) fs.writeFileSync(path.join(dir, name), "zip");
  if (files.manifest !== undefined) {
    fs.writeFileSync(path.join(dir, "browsers-manifest.json"), JSON.stringify(files.manifest));
  }
  return dir;
}

function input(overrides: Partial<BuildInfoInput> = {}): BuildInfoInput {
  const appPath = path.join(root, "app", "Contents", "Resources");
  fs.mkdirSync(appPath, { recursive: true });
  const asar = path.join(appPath, "app.asar");
  if (!fs.existsSync(asar)) fs.writeFileSync(asar, "asar");
  const mainEntry = path.join(root, "dist", "main", "index.js");
  fs.mkdirSync(path.dirname(mainEntry), { recursive: true });
  fs.writeFileSync(mainEntry, "// compiled");
  const bundleRoot = path.join(root, "Agent Browser Studio.app");
  fs.mkdirSync(path.join(bundleRoot, "Contents"), { recursive: true });
  return {
    pkg: { name: "agent-browser-studio", version: "9.8.7" },
    packaged: true,
    appPath,
    resourcesPath: appPath,
    bundleRoot,
    mainEntry,
    enginesRoot: writeEngineLayout(path.join(root, "engines-manifest"), {
      manifest: { platform: "mac", chromiumVersion: "152.0.7977.72", firefoxVersion: "154.0" },
      archives: ["Chromium.app.zip", "Firefox.app.zip"],
    }),
    runtime: { electron: "42.4.0", chrome: "152.0.7977.72", node: "22.16.0", v8: "15.2", modules: "136" },
    host: { platform: "darwin", arch: "arm64", release: "25.3.0", osName: "Darwin", osVersion: "macOS 26.3" },
    locale: { app: "zh-CN", system: "zh-CN" },
    appId: "com.ahoo.agent-browser-studio",
    ...overrides,
  };
}

describe("build info collection", () => {
  it("reports the manifest engine versions with their source", () => {
    const info = collectBuildInfo(input());
    expect(info.version).toBe("9.8.7");
    expect(info.packaged).toBe(true);
    expect(info.engines.chromium.bundledVersion).toBe("152.0.7977.72");
    expect(info.engines.chromium.bundledSource).toBe("manifest");
    expect(info.engines.firefox.bundledVersion).toBe("154.0");
    expect(info.engines.chromium.appArchive?.path.endsWith("Chromium.app.zip")).toBe(true);
    expect(info.runtime.electron).toBe("42.4.0");
  });

  it("falls back to the archive name when no manifest is shipped", () => {
    const enginesRoot = writeEngineLayout(path.join(root, "engines-archive"), {
      archives: ["chromium-darwin-151.0.7000.1-159625279-1792670536465"],
    });
    const info = collectBuildInfo(input({ enginesRoot }));
    expect(info.engines.chromium.bundledVersion).toBe("151.0.7000.1");
    expect(info.engines.chromium.bundledSource).toBe("archive");
    // Firefox has neither manifest nor archive: unknown, not guessed.
    expect(info.engines.firefox.bundledVersion).toBeNull();
    expect(info.engines.firefox.bundledSource).toBeNull();
  });

  it("marks absent stamps as null instead of substituting now", () => {
    const info = collectBuildInfo(input({
      bundleRoot: path.join(root, "does-not-exist.app"),
      enginesRoot: path.join(root, "no-engines"),
      mainEntry: path.join(root, "no-main.js"),
    }));
    expect(info.bundle).toBeNull();
    expect(info.mainEntry).toBeNull();
    expect(formatStamp(info.bundle)).toBe("unavailable");
    expect(info.engines.chromium.bundledVersion).toBeNull();
  });

  it("never passes an installed engine version off as a bundled one", () => {
    const info = collectBuildInfo(input({
      enginesRoot: null,
      engineInstalled: { chromium: "152.0.7977.72", firefox: null },
    }));
    expect(info.engines.chromium.bundledVersion).toBeNull();
    expect(info.engineInstalled.chromium).toBe("152.0.7977.72");
    expect(info.engineInstalled.firefox).toBeNull();
  });
});

describe("archive naming", () => {
  it("extracts the version and ignores the trailing size/timestamp", () => {
    expect(versionFromArchiveName("chromium-darwin-152.0.7977.72-159625279-1792670536465", "chromium")).toBe("152.0.7977.72");
    expect(versionFromArchiveName("firefox-darwin-154.0-203931857-1792670536510", "firefox")).toBe("154.0");
  });

  it("rejects unrelated names", () => {
    expect(versionFromArchiveName("chromium-darwin-not-a-version", "chromium")).toBeNull();
    expect(versionFromArchiveName("Firefox.app.zip", "chromium")).toBeNull();
  });
});

describe("manifest reading", () => {
  it("returns null for absent or malformed manifests", () => {
    const bad = path.join(root, "bad-manifest");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "browsers-manifest.json"), "{not json");
    expect(readBrowsersManifest(bad)).toBeNull();
    expect(readBrowsersManifest(null)).toBeNull();
  });
});

describe("packaged layout and OS banner", () => {
  it("finds app.asar from the resources directory when appPath is the asar itself", () => {
    const resources = path.join(root, "packaged", "Contents", "Resources");
    fs.mkdirSync(resources, { recursive: true });
    const asar = path.join(resources, "app.asar");
    if (!fs.existsSync(asar)) fs.writeFileSync(asar, "asar");
    // Electron's app.getAppPath() returns the asar path in a packaged app.
    const info = collectBuildInfo(input({ appPath: asar, resourcesPath: resources, bundleRoot: null }));
    expect(info.appArchive?.path).toBe(asar);
    expect(info.appArchive?.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reduces the macOS kernel banner to a comparable version", () => {
    const banner = "Darwin Kernel Version 25.3.0: Wed Jan 28 20:53:15 PST 2026; root:xnu-12377.81.4~5/RELEASE_ARM64_T6000";
    const info = collectBuildInfo(input({
      host: { platform: "darwin", arch: "arm64", release: "25.3.0", osName: "Darwin", osVersion: banner },
    }));
    expect(info.host.osVersion).toBe("25.3.0 (Wed Jan 28 20:53:15 PST 2026)");
    expect(info.host.osVersion).not.toContain("Darwin Kernel");
    expect(info.host.osVersion).not.toContain("root:xnu");
  });

  it("leaves non-macOS version strings untouched and null stays null", () => {
    expect(conciseOsVersion("Windows_NT", "10.0.22631")).toBe("10.0.22631");
    expect(conciseOsVersion("Linux", null)).toBeNull();
  });
});
