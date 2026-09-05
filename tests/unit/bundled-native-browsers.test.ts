import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledBrowsersRoot,
  bundledChromiumBinaryPath,
  bundledFirefoxBinaryPath,
  readBundledBrowsersManifest,
} from "../../src/main/services/bundled-native-browsers.js";

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