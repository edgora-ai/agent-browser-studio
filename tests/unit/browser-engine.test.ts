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
  extractBidiWebSocketUrl,
  extractMarionettePort,
  spawnFirefoxWithDebugInfo,
} from "../../src/main/services/browser-engine.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-engine-test-"));
afterAll(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFakeFirefox(version = "137.0"): string {
  const isWin = process.platform === "win32";
  if (isWin) {
    // On Windows spawnSync .js directly fails without shell association; write
    // a .cmd shim that invokes node so spawnSync with/without shell both work.
    const jsPath = path.join(tempDir, "fake-firefox-" + version.replace(/\./g, "_") + ".js");
    fs.writeFileSync(jsPath, `console.log("Mozilla Firefox ${version}");\n`, "utf8");
    const cmdPath = path.join(tempDir, "fake-firefox-" + version.replace(/\./g, "_") + ".cmd");
    fs.writeFileSync(cmdPath, `@node "${jsPath}" %*\n`, "utf8");
    return cmdPath;
  }
  const bin = path.join(tempDir, "fake-firefox-" + version.replace(/\./g, "_"));
  fs.writeFileSync(bin, `#!/usr/bin/env node\nconsole.log("Mozilla Firefox ${version}");\n`, "utf8");
  fs.chmodSync(bin, 0o755);
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
    expect(missing.nativeConfig).toBe(false);
    expect(missing.nativeCapabilities).toEqual([]);
    expect(missing.sourceStamp).toBeNull();
    expect(missing.hint).toContain("Firefox binary not found");

    const real = makeFakeFirefox("139.0");
    const ok = getFirefoxStatus({ AGENT_BROWSER_FIREFOX_BINARY_PATH: real } as any);
    expect(ok.installed).toBe(true);
    expect(ok.path).toBe(real);
    expect(ok.version).toBe("139.0");

    const requested = getFirefoxStatus({
      AGENT_BROWSER_FIREFOX_BINARY_PATH: real,
      AGENT_BROWSER_FIREFOX_NATIVE: "1",
    } as any);
    expect(requested.nativeRequested).toBe(true);
    expect(requested.nativeConfig).toBe(false);
    expect(requested.hint).toContain("launch will fail closed");
  });

  it("buildFirefoxLaunchArgs uses -profile + remote debugging + -no-remote (BiDi-only, no Marionette)", () => {
    const args = buildFirefoxLaunchArgs({
      profileDir: "/tmp/fx-profile",
      remotePort: 39201,
      headless: true,
      platform: "macos",
      appUrl: "https://example.com",
      nativeRequired: true,
    });
    expect(args[0]).toBe("-profile");
    expect(args).toContain("/tmp/fx-profile");
    expect(args).not.toContain("--marionette"); // Marionette's a11y service wedges BiDi on heavy pages
    expect(args).toContain("--remote-debugging-port");
    expect(args).toContain("39201");
    expect(args).toContain("-new-instance"); // non-Windows
    expect(args).toContain("-headless");
    expect(args).toContain("--agent-browser-native-required");
    expect(args).toContain("https://example.com");
    expect(args[args.length - 1]).toBe("-no-remote"); // Roxy appends -no-remote last

    // Windows omits -new-instance; default remotePort is 0 (auto-assign)
    const winArgs = buildFirefoxLaunchArgs({ profileDir: "C:\\fx", remotePort: 1, platform: "windows" });
    expect(winArgs).not.toContain("-new-instance");
    const auto = buildFirefoxLaunchArgs({ profileDir: "/tmp/fx2" });
    expect(auto).toContain("--remote-debugging-port");
    expect(auto[auto.indexOf("--remote-debugging-port") + 1]).toBe("0");
  });

  it("extracts the WebDriver BiDi WebSocket URL and Marionette port from Firefox output", () => {
    expect(extractBidiWebSocketUrl("WebDriver BiDi listening on ws://127.0.0.1:9239/")).toBe("ws://127.0.0.1:9239/");
    expect(extractBidiWebSocketUrl("no bidi here")).toBeNull();
    expect(extractMarionettePort("Marionette  INFO  Listening on port 2828")).toBe(2828);
    expect(extractMarionettePort("Marionette  INFO  Listening on port abc")).toBeNull();
  });

  it("spawnFirefoxWithDebugInfo waits for the BiDi WebSocket and reports the real port", async () => {
    const bin = makeFakeFirefox(); // fake script just prints version; we build a special one
    let special: string;
    if (process.platform === "win32") {
      const jsPath = path.join(tempDir, "fake-firefox-bidi.js");
      fs.writeFileSync(jsPath, `setTimeout(() => { console.log("Marionette  INFO  Listening on port 2828"); console.error("WebDriver BiDi listening on ws://127.0.0.1:9239/"); }, 200); setInterval(() => {}, 30000);\n`, "utf8");
      special = path.join(tempDir, "fake-firefox-bidi.cmd");
      fs.writeFileSync(special, `@node "${jsPath}" %*\n`, "utf8");
    } else {
      special = path.join(tempDir, "fake-firefox-bidi");
      fs.writeFileSync(special, `#!/bin/sh\nsleep 0.2\necho "Marionette  INFO  Listening on port 2828" >&1\necho "WebDriver BiDi listening on ws://127.0.0.1:9239/" >&2\nsleep 30\n`, "utf8");
      fs.chmodSync(special, 0o755);
    }
    const { child, info } = await spawnFirefoxWithDebugInfo(special, ["-profile", "/tmp/fx"], { timeoutMs: 8000 });
    expect(info.bidiWebSocketUrl).toBe("ws://127.0.0.1:9239/");
    expect(info.actualPort).toBe(9239);
    expect(info.marionettePort).toBe(2828);
    try { child.kill(); } catch { /* ignore */ }
    void bin;
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
    expect(prefs).toContain('user_pref("network.trr.mode", 3)');
    expect(prefs).toContain('user_pref("network.trr.uri", "https://dns.example/dns-query")');
    expect(prefs).toContain('user_pref("intl.locale.requested", "en-US")');
    expect(prefs).toContain('user_pref("browser.shell.checkDefaultBrowser", false)');
    expect(prefs).toContain('user_pref("app.update.auto", false)');

    const noDoh = buildFirefoxUserJs({});
    expect(noDoh).toContain('user_pref("network.trr.mode", 5)');
  });

  it("buildFirefoxUserJs writes Roxy's managed prefs family (automation base, GPU, sandbox, color scheme/theme)", () => {
    const prefs = buildFirefoxUserJs({ useGpu: false, sandboxPermission: false, colorScheme: "dark" });
    // automation-friendly base
    expect(prefs).toContain('user_pref("focusmanager.testmode", true)');
    expect(prefs).toContain('user_pref("dom.timeout.enable_budget_timer_throttling", false)');
    expect(prefs).toContain('user_pref("browser.newtabpage.enabled", true)');
    // GPU off
    expect(prefs).toContain('user_pref("layers.acceleration.disabled", true)');
    expect(prefs).toContain('user_pref("gfx.webrender.disabled", true)');
    // sandbox disabled
    expect(prefs).toContain('user_pref("security.sandbox.content.level", -1)');
    // dark scheme
    expect(prefs).toContain('user_pref("layout.css.prefers-color-scheme.content-override", 0)');
    expect(prefs).toContain('user_pref("ui.systemUsesDarkTheme", true)');
    expect(prefs).toContain('user_pref("extensions.activeThemeID", "firefox-compact-dark@mozilla.org")');

    const gpuOn = buildFirefoxUserJs({ useGpu: true, sandboxPermission: true, colorScheme: "light" });
    expect(gpuOn).toContain('user_pref("layers.acceleration.disabled", false)');
    expect(gpuOn).toContain('user_pref("security.sandbox.content.level", 0)');
    expect(gpuOn).toContain('user_pref("layout.css.prefers-color-scheme.content-override", 1)');
    expect(gpuOn).toContain('user_pref("extensions.activeThemeID", "firefox-compact-light@mozilla.org")');

    const system = buildFirefoxUserJs({});
    expect(system).toContain('user_pref("layout.css.prefers-color-scheme.content-override", 2)');
    expect(system).toContain('user_pref("extensions.activeThemeID", "default-theme@mozilla.org")');
  });

  it("writeFirefoxUserJs creates the profile dir and persists user.js", () => {
    const dir = path.join(tempDir, "fx-profile");
    writeFirefoxUserJs(dir, { locale: "en-US" });
    const content = fs.readFileSync(path.join(dir, "user.js"), "utf8");
    expect(content).toContain("intl.locale.requested");
    expect(fs.existsSync(path.join(dir, "user.js"))).toBe(true);
  });
});