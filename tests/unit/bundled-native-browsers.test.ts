import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundledBrowsersRoot,
  bundledChromiumBinaryPath,
  bundledFirefoxBinaryPath,
  readBundledBrowsersManifest,
} from "../../src/main/services/bundled-native-browsers.js";

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
let nextFixtureBuild = 0;

function clearResourcesPath(): void {
  // Plain Node has no Electron resourcesPath; do not retype Electron's required property as optional.
  if (!Reflect.deleteProperty(process, "resourcesPath")) {
    throw new Error("Unable to clear process.resourcesPath for the resource fixture");
  }
}

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, "resourcesPath", { configurable: true, writable: true, value });
}

function makeResources(platform: NodeJS.Platform) {
  const resourcesPath = mkdtempSync(path.join(tmpdir(), "bundled-resources-"));
  const base = path.join(resourcesPath, "native-browsers");
  const root = platform === "darwin" ? base : path.join(base, platform === "win32" ? "win" : platform);
  const chromium = platform === "darwin"
    ? path.join(root, "Chromium.app", "Contents", "MacOS", "Chromium")
    : platform === "win32" ? path.join(root, "chromium", "chrome.exe") : path.join(root, "chromium");
  const firefox = platform === "darwin"
    ? path.join(root, "Firefox.app", "Contents", "MacOS", "firefox")
    : path.join(root, "firefox", platform === "win32" ? "firefox.exe" : "firefox");
  const build = ++nextFixtureBuild;
  const manifest = { platform, chromiumVersion: `150.0.7871.${build}`, firefoxVersion: `154.${build}` };
  for (const binary of [chromium, firefox]) {
    mkdirSync(path.dirname(binary), { recursive: true });
    // Non-executable fixtures: discovery must never launch or unpack a host browser.
    writeFileSync(binary, resourcesPath);
  }
  writeFileSync(path.join(root, "browsers-manifest.json"), JSON.stringify(manifest));
  return { resourcesPath, root, chromium, firefox, manifest };
}

type ResourcesFixture = ReturnType<typeof makeResources>;
const discoveries = [
  { name: "Chromium", resolve: bundledChromiumBinaryPath, expected: (fixture: ResourcesFixture) => fixture.chromium },
  { name: "Firefox", resolve: bundledFirefoxBinaryPath, expected: (fixture: ResourcesFixture) => fixture.firefox },
  { name: "manifest", resolve: readBundledBrowsersManifest, expected: (fixture: ResourcesFixture) => fixture.manifest },
];

beforeEach(() => {
  clearResourcesPath();
  vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", undefined);
  vi.stubEnv("AGENT_BROWSER_BUNDLED_CACHE_DIR", mkdtempSync(path.join(tmpdir(), "bundled-cache-")));
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else clearResourcesPath();
});

describe("bundled-native-browsers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bundled-browsers-"));
  const macRoot = path.join(root, "native-browsers");
  mkdirSync(macRoot, { recursive: true });
  writeFileSync(path.join(macRoot, "browsers-manifest.json"), JSON.stringify({
    platform: "mac",
    chromiumVersion: "150.0.7871.114",
    firefoxVersion: "154.0",
  }));
  writeFileSync(path.join(macRoot, "contents-marker"), "x");

  it("roots resolve per platform", () => {
    expect(bundledBrowsersRoot("darwin", root)).toBe(macRoot);
    // Win-static-audit P0-1: Node "win32" maps to the staged "win" dir
    // (sync-native-browsers.mjs + electron-builder extraResources).
    expect(bundledBrowsersRoot("win32", root)).toBe(path.join(macRoot, "win"));
    expect(bundledBrowsersRoot("linux", root)).toBe(path.join(macRoot, "linux"));
    expect(bundledBrowsersRoot("darwin", undefined)).toBeNull();
  });

  it("returns null when nothing is shipped", () => {
    expect(bundledChromiumBinaryPath("darwin", root)).toBeNull();
    expect(bundledFirefoxBinaryPath("darwin", root)).toBeNull();
  });

  it("reads the shipped manifest", () => {
    const manifest = readBundledBrowsersManifest("darwin", root);
    expect(manifest?.chromiumVersion).toBe("150.0.7871.114");
    expect(manifest?.firefoxVersion).toBe("154.0");
  });

  it("resolves mac app-bundle binaries when present", () => {
    const chromBin = path.join(macRoot, "Chromium.app", "Contents", "MacOS", "Chromium");
    const ffBin = path.join(macRoot, "Firefox.app", "Contents", "MacOS", "firefox");
    [path.dirname(chromBin), path.dirname(ffBin)].forEach((d) => mkdirSync(d, { recursive: true }));
    writeFileSync(chromBin, "x");
    writeFileSync(ffBin, "x");
    expect(bundledChromiumBinaryPath("darwin", root)).toBe(chromBin);
    expect(bundledFirefoxBinaryPath("darwin", root)).toBe(ffBin);
  });

  it("resolves win/linux binary names when present", () => {
    const winChrome = path.join(macRoot, "win", "chromium", "chrome.exe");
    const winFf = path.join(macRoot, "win", "firefox", "firefox.exe");
    const linuxChrome = path.join(macRoot, "linux", "chromium");
    const linuxFf = path.join(macRoot, "linux", "firefox", "firefox");
    [path.dirname(winChrome), path.dirname(winFf), path.dirname(linuxChrome), path.dirname(linuxFf)]
      .forEach((d) => mkdirSync(d, { recursive: true }));
    writeFileSync(winChrome, "x");
    writeFileSync(winFf, "x");
    writeFileSync(linuxChrome, "x");
    writeFileSync(linuxFf, "x");
    expect(bundledChromiumBinaryPath("win32", root)).toBe(winChrome);
    expect(bundledFirefoxBinaryPath("win32", root)).toBe(winFf);
    expect(bundledChromiumBinaryPath("linux", root)).toBe(linuxChrome);
    expect(bundledFirefoxBinaryPath("linux", root)).toBe(linuxFf);
  });
});

describe.each(discoveries)("$name resources-path precedence", ({ resolve, expected }) => {
  let fixture: ResourcesFixture;
  beforeEach(() => {
    fixture = makeResources(process.platform);
    setResourcesPath(fixture.resourcesPath);
  });

  it("discovers the process.resourcesPath fixture with no arguments or env override", () => {
    expect(process.env.AGENT_BROWSER_BUNDLED_RESOURCES).toBeUndefined();
    expect(resolve()).toEqual(expected(fixture));
  });

  it("uses process.resourcesPath when the resource argument is explicitly undefined", () => {
    expect(resolve(process.platform, undefined)).toEqual(expected(fixture));
  });

  it("prefers an explicit resource path over process.resourcesPath", () => {
    const explicit = makeResources(process.platform);
    expect(resolve(process.platform, explicit.resourcesPath)).toEqual(expected(explicit));
  });

  it.each([null, ""])("preserves an explicit %j resource path as disabled", (resourcesPath) => {
    expect(resolve(process.platform, resourcesPath)).toBeNull();
  });

  it("keeps a nonempty env override ahead of process, explicit path, and explicit null", () => {
    const override = makeResources(process.platform);
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", override.resourcesPath);
    expect(resolve()).toEqual(expected(override));
    expect(resolve(process.platform, fixture.resourcesPath)).toEqual(expected(override));
    expect(resolve(process.platform, null)).toEqual(expected(override));
    clearResourcesPath();
    expect(resolve()).toEqual(expected(override));
  });

  it("ignores an empty env override and uses the process resource fixture", () => {
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", "");
    expect(resolve()).toEqual(expected(fixture));
  });

  it("does not fall through a missing env override to a valid process fixture", () => {
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", path.join(fixture.resourcesPath, "missing-resources"));
    expect(resolve()).toBeNull();
  });

  it("returns null without process.resourcesPath but still accepts an explicit fixture", () => {
    clearResourcesPath();
    expect(resolve()).toBeNull();
    expect(resolve(process.platform, fixture.resourcesPath)).toEqual(expected(fixture));
  });

  it.each([undefined, ""])("returns null when process.resourcesPath is %j", (resourcesPath) => {
    setResourcesPath(resourcesPath);
    expect(resolve()).toBeNull();
  });

  it("returns null when the process resource directory contains no shipped browser", () => {
    setResourcesPath(mkdtempSync(path.join(tmpdir(), "empty-bundled-resources-")));
    expect(resolve()).toBeNull();
  });
});

describe("default platform-specific resource discovery", () => {
  it.each(["darwin", "win32", "linux"] as const)("discovers both browsers and manifest for %s", (platform) => {
    const fixture = makeResources(platform);
    setResourcesPath(fixture.resourcesPath);
    expect(bundledBrowsersRoot(platform)).toBe(fixture.root);
    expect(bundledBrowsersRoot(platform, null)).toBeNull();
    expect(bundledChromiumBinaryPath(platform)).toBe(fixture.chromium);
    expect(bundledFirefoxBinaryPath(platform)).toBe(fixture.firefox);
    expect(readBundledBrowsersManifest(platform)).toEqual(fixture.manifest);
  });

  it.each([
    { kind: "chromium", app: "Chromium.app", binary: "Chromium", version: "150.0.7871.114", resolve: bundledChromiumBinaryPath },
    { kind: "firefox", app: "Firefox.app", binary: "firefox", version: "154.0", resolve: bundledFirefoxBinaryPath },
  ])("discovers the packaged $kind archive through a preseeded fixture cache", ({ kind, app, binary, version, resolve }) => {
    const resourcesPath = mkdtempSync(path.join(tmpdir(), "archived-bundled-resources-"));
    const root = path.join(resourcesPath, "native-browsers");
    mkdirSync(root);
    writeFileSync(path.join(root, "browsers-manifest.json"), JSON.stringify({ chromiumVersion: "150.0.7871.114", firefoxVersion: "154.0" }));
    const archive = path.join(root, `${app}.zip`);
    // Only the archive identity is read; the ready fixture cache avoids extraction.
    writeFileSync(archive, "fixture archive identity");
    const stat = statSync(archive);
    const cacheRoot = process.env.AGENT_BROWSER_BUNDLED_CACHE_DIR;
    if (!cacheRoot) throw new Error("Missing private bundled browser fixture cache");
    const cacheDir = path.join(cacheRoot, `${kind}-darwin-${version}-${stat.size}-${Math.trunc(stat.mtimeMs)}`);
    const cachedBinary = path.join(cacheDir, app, "Contents", "MacOS", binary);
    mkdirSync(path.dirname(cachedBinary), { recursive: true });
    writeFileSync(cachedBinary, "fixture binary");
    writeFileSync(path.join(cacheDir, ".ready"), "fixture cache is ready\n");
    // Synthetic ready-cache metadata is bound to this exact inert archive;
    // discovery must still avoid all extraction/signature/browser subprocesses.
    writeFileSync(path.join(cacheDir, ".ready.archive.json"), JSON.stringify({
      protocol: "bundled-browser-ready-v1",
      marker: "fixture cache is ready\n",
      archive: { source: realpathSync(archive), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
    }));
    setResourcesPath(resourcesPath);

    expect(resolve("darwin", resourcesPath)).toBe(cachedBinary);
    expect(resolve("darwin")).toBe(cachedBinary);
  });
});