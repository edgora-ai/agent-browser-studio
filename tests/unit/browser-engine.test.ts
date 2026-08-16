import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  sanitizeBrowserEngine,
  getFirefoxBinaryOverride,
  findFirefoxBinary,
  detectFirefoxVersion,
  getFirefoxStatus,
  buildFirefoxLaunchArgs,
  buildFirefoxUserJs,
  writeFirefoxUserJs,
} from "../../src/main/services/browser-engine.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-engine-test-"));
afterAll(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFakeFirefox(version = "137.0"): string {
  const bin = path.join(tempDir, "fake-firefox-" + version.replace(/\./g, "_"));
  const isWin = process.platform === "win32";
  const script = isWin
    ? `@echo off\necho Mozilla Firefox ${version}`
    : `#!/bin/sh\necho "Mozilla Firefox ${version}"`;
  fs.writeFileSync(bin, script, "utf8");
  if (!isWin) fs.chmodSync(bin, 0o755);
  return bin;
}

describe("browser engine (Slice 77 — Firefox capability)", () => {
  it("sanitizeBrowserEngine only accepts chromium/firefox (default chromium)", () => {
    expect(sanitizeBrowserEngine("firefox")).toBe("firefox");
    expect(sanitizeBrowserEngine("chromium")).toBe("chromium");
    expect(sanitizeBrowserEngine(undefined)).toBe("chromium");
    expect(sanitizeBrowserEngine("edge")).toBe("chromium");
    expect(sanitizeBrowserEngine("")).toBe("chromium");
  });

  it("reads the Firefox binary override env vars", () => {
    const env = { AGENT_BROWSER_FIREFOX_BINARY_PATH: "/opt/firefox" } as any;
    expect(getFirefoxBinaryOverride(env)).toBe("/opt/firefox");
    const env2 = { FIREFOX_BINARY_PATH: "/usr/lib/firefox/firefox" } as any;
    expect(getFirefoxBinaryOverride(env2)).toBe("/usr/lib/firefox/firefox");
    expect(getFirefoxBinaryOverride({} as any)).toBeNull();
  });

  it("finds the Firefox binary via the env override (only when the path exists)", () => {
    const real = makeFakeFirefox();
    expect(findFirefoxBinary({ AGENT_BROWSER_FIREFOX_BINARY_PATH: real } as any)).toBe(real);
    expect(findFirefoxBinary({ AGENT_BROWSER_FIREFOX_BINARY_PATH: path.join(tempDir, "missing-firefox") } as any)).toBeNull();
  });

  it("detectFirefoxVersion parses `Mozilla Firefox x.y.z`", () => {
    const real = makeFakeFirefox("138.0.1");
    expect(detectFirefoxVersion(real)).toBe("138.0.1");
    expect(detectFirefoxVersion(path.join(tempDir, "does-not-exist"))).toBeNull();
  });

  it("getFirefoxStatus reports not-installed gracefully, and installed with version when present", () => {
    const missing = getFirefoxStatus({ AGENT_BROWSER_FIREFOX_BINARY_PATH: path.join(tempDir, "nope") } as any);
    expect(missing.installed).toBe(false);
    expect(missing.path).toBeNull();
    expect(missing.fingerprintParity).toBe(false);
    expect(missing.hint).toContain("Firefox binary not found");

    const real = makeFakeFirefox("139.0");
    const ok = getFirefoxStatus({ AGENT_BROWSER_FIREFOX_BINARY_PATH: real } as any);
    expect(ok.installed).toBe(true);
    expect(ok.path).toBe(real);
    expect(ok.version).toBe("139.0");
  });

  it("buildFirefoxLaunchArgs uses -profile + remote debugging + headless + first-URL", () => {
    const args = buildFirefoxLaunchArgs({
      profileDir: "/tmp/fx-profile",
      remotePort: 39201,
      headless: true,
      platform: "macos",
      appUrl: "https://example.com",
    });
    expect(args).toContain("-profile");
    expect(args).toContain("/tmp/fx-profile");
    expect(args).toContain("-no-remote");
    expect(args).toContain("-new-instance"); // non-Windows
    expect(args).toContain("--remote-debugging-port");
    expect(args).toContain("39201");
    expect(args).toContain("-headless");
    expect(args[args.length - 1]).toBe("https://example.com");

    // Windows omits -new-instance
    const winArgs = buildFirefoxLaunchArgs({ profileDir: "C:\\fx", remotePort: 1, platform: "windows" });
    expect(winArgs).not.toContain("-new-instance");
  });

  it("buildFirefoxUserJs writes proxy prefs for HTTP and SOCKS", () => {
    const http = buildFirefoxUserJs({ proxy: { type: "http", host: "1.2.3.4", port: 8080 } as any });
    expect(http).toContain('user_pref("network.proxy.type", 1)');
    expect(http).toContain('user_pref("network.proxy.http", "1.2.3.4")');
    expect(http).toContain('user_pref("network.proxy.http_port", 8080)');
    expect(http).toContain('user_pref("network.proxy.ssl", "1.2.3.4")');

    const socks = buildFirefoxUserJs({ proxy: { type: "socks5h", host: "5.6.7.8", port: 1080 } as any });
    expect(socks).toContain('user_pref("network.proxy.socks", "5.6.7.8")');
    expect(socks).toContain('user_pref("network.proxy.socks_port", 1080)');
    expect(socks).toContain('user_pref("network.proxy.socks_remote_dns", true)');

    const direct = buildFirefoxUserJs({ proxy: null });
    expect(direct).toContain('user_pref("network.proxy.type", 0)');
  });

  it("buildFirefoxUserJs sets DoH (TRR) and locale and quiet-first-run prefs", () => {
    const prefs = buildFirefoxUserJs({ dohUrl: "https://dns.example/dns-query", locale: "en-US" });
    expect(prefs).toContain('user_pref("network.trr.mode", 2)');
    expect(prefs).toContain('user_pref("network.trr.uri", "https://dns.example/dns-query")');
    expect(prefs).toContain('user_pref("intl.locale.requested", "en-US")');
    expect(prefs).toContain('user_pref("browser.shell.checkDefaultBrowser", false)');
    expect(prefs).toContain('user_pref("app.update.auto", false)');

    const noDoh = buildFirefoxUserJs({});
    expect(noDoh).toContain('user_pref("network.trr.mode", 5)');
  });

  it("writeFirefoxUserJs creates the profile dir and persists user.js", () => {
    const dir = path.join(tempDir, "fx-profile");
    writeFirefoxUserJs(dir, { locale: "en-US" });
    const content = fs.readFileSync(path.join(dir, "user.js"), "utf8");
    expect(content).toContain("intl.locale.requested");
    expect(fs.existsSync(path.join(dir, "user.js"))).toBe(true);
  });
});