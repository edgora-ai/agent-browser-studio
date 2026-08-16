// Browser engine abstraction (Slice 77 — Firefox capability).
//
// The product core engine is the independently patched Chromium 150 build
// (managed fingerprint injection via the --fingerprint-* switch family). This
// module makes "Firefox" a first-class, modeled option in the product:
//  - profiles can declare engine = "chromium" | "firefox";
//  - Firefox binary discovery + version detection (`AGENT_BROWSER_FIREFOX_BINARY_PATH`);
//  - a Firefox launch-argument builder (`-profile`, remote debugging / BiDi port,
//    headless, first-URL) and a `user.js` preferences writer (proxy / DoH /
//    locale) — the standard way to steer Firefox at runtime;
//  - an engine-status surface used by IPC / REST / MCP / UI.
//
// Honest scope note: full managed fingerprint-injection parity for Firefox
// (the --fingerprint-* patch set does not exist on stock Firefox) is the
// remaining follow-up. This slice delivers the engine plumbing + surfaces so
// Firefox profiles are real, detectable and launcan play well with the rest of
// the product; fingerprint parity is tracked in docs/improvement-roadmap.md.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ProxyConfig } from "../types.js";

export type BrowserEngine = "chromium" | "firefox";

const FIREFOX_ENV = "AGENT_BROWSER_FIREFOX_BINARY_PATH";
const FIREFOX_ENV_LEGACY = "FIREFOX_BINARY_PATH";

export function sanitizeBrowserEngine(value: unknown): BrowserEngine {
  return value === "firefox" ? "firefox" : "chromium";
}

// ═══════════════════════════════════════════════════════════
// Firefox binary discovery
// ═══════════════════════════════════════════════════════════

export function getFirefoxBinaryOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[FIREFOX_ENV] || env[FIREFOX_ENV_LEGACY] || null;
}

export function defaultFirefoxBinaryPaths(platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        path.join(process.env.HOME || "", "Applications", "Firefox.app", "Contents", "MacOS", "firefox"),
      ];
    case "win32": {
      const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
      const pfX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
      return [
        path.join(pf, "Mozilla Firefox", "firefox.exe"),
        path.join(pfX86, "Mozilla Firefox", "firefox.exe"),
      ];
    }
    default:
      return ["/usr/bin/firefox", "/usr/lib/firefox/firefox", "/snap/bin/firefox"];
  }
}

/** Find the Firefox binary (env override wins, then platform defaults). */
export function findFirefoxBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = getFirefoxBinaryOverride(env);
  if (override) return fs.existsSync(override) ? override : null;
  for (const candidate of defaultFirefoxBinaryPaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Detect the Firefox product version via `firefox --version`. */
export function detectFirefoxVersion(bin: string): string | null {
  try {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const raw = String(result.stdout || result.stderr || "").trim();
    const match = raw.match(/Mozilla Firefox\s*([\d.]+)/i);
    return match ? match[1] : (raw || null);
  } catch {
    return null;
  }
}

export interface FirefoxStatus {
  engine: "firefox";
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Stock Firefox does not carry the managed --fingerprint-* patch set. */
  fingerprintParity: false;
  hint: string;
}

export function getFirefoxStatus(env: NodeJS.ProcessEnv = process.env): FirefoxStatus {
  const bin = findFirefoxBinary(env);
  if (!bin) {
    return {
      engine: "firefox",
      installed: false,
      path: null,
      version: null,
      fingerprintParity: false,
      hint: `Firefox binary not found. Install Firefox or set ${FIREFOX_ENV}.`,
    };
  }
  return {
    engine: "firefox",
    installed: true,
    path: bin,
    version: detectFirefoxVersion(bin),
    fingerprintParity: false,
    hint: "Firefox remote debugging (WebDriver BiDi) is used. Managed fingerprint-injection parity is a known follow-up.",
  };
}

// ═══════════════════════════════════════════════════════════
// Firefox launch arguments
// ═══════════════════════════════════════════════════════════

export interface FirefoxLaunchArgsOpts {
  profileDir: string;
  remotePort: number;
  headless?: boolean;
  platform?: "windows" | "macos";
  /** First-tab URL (Web App / PWA-ish mode; Firefox has no --app= flag). */
  appUrl?: string | null;
}

/**
 * Build the Firefox command line. Note the surface differences vs Chromium:
 *  - Firefox uses `-profile <dir>` (not `--user-data-dir=`);
 *  - remote debugging is enabled with `--remote-debugging-port` (WebDriver BiDi
 *    endpoint) rather than the Chromium CDP listener;
 *  - `-no-remote` prevents the running-instance takeover, `-new-instance` forces
 *    a fresh instance on macOS/Linux (Firefox for Windows does not accept it).
 */
export function buildFirefoxLaunchArgs(opts: FirefoxLaunchArgsOpts): string[] {
  const args: string[] = ["-profile", opts.profileDir, "-no-remote"];
  if (opts.platform !== "windows") args.push("-new-instance");
  args.push("--remote-debugging-port", String(opts.remotePort));
  if (opts.headless) args.push("-headless");
  if (opts.appUrl) args.push(opts.appUrl);
  return args;
}

// ═══════════════════════════════════════════════════════════
// Firefox user.js preferences (proxy / DoH / locale)
// ═══════════════════════════════════════════════════════════

export interface FirefoxUserJsOpts {
  proxy?: ProxyConfig | null;
  /** DoH endpoint URI; when set, Firefox uses TRR as the DNS resolver. */
  dohUrl?: string | null;
  locale?: string | null;
}

function prefString(key: string, value: string): string {
  return `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`;
}

function prefNumber(key: string, value: number): string {
  return `user_pref(${JSON.stringify(key)}, ${value});`;
}

function prefBoolean(key: string, value: boolean): string {
  return `user_pref(${JSON.stringify(key)}, ${value});`;
}

/**
 * Build the managed `user.js` prefs file for a Firefox profile. Firefox does
 * not expose proxy / DoH on the command line like Chromium does, so the
 * standard, reversible way to steer a launched profile is a `user.js` in the
 * profile directory. Proxy credentials are written as SOCKS/HTTP proxy auth via
 * the network proxy prefs; the file lives inside the (already sealed) profile
 * dir and is never logged.
 */
export function buildFirefoxUserJs(opts: FirefoxUserJsOpts): string {
  const lines: string[] = [];
  lines.push("// Agent Browser Studio managed Firefox preferences (regenerated at launch).");

  const proxy = opts.proxy;
  const isSocks = proxy?.type === "socks5" || proxy?.type === "socks5h";
  if (proxy && proxy.port) {
    lines.push(prefNumber("network.proxy.type", 1)); // manual
    if (isSocks) {
      lines.push(prefString("network.proxy.socks", proxy.host));
      lines.push(prefNumber("network.proxy.socks_port", proxy.port));
      // Firefox SOCKS always performs remote DNS; socks5h semantics map to TRUE.
      lines.push(prefBoolean("network.proxy.socks_remote_dns", true));
    } else {
      lines.push(prefString("network.proxy.http", proxy.host));
      lines.push(prefNumber("network.proxy.http_port", proxy.port));
      lines.push(prefString("network.proxy.ssl", proxy.host));
      lines.push(prefNumber("network.proxy.ssl_port", proxy.port));
      // Keep the stock "no proxy for these hosts" behavior isolated to loopback.
      lines.push(prefString("network.proxy.no_proxies_on", "localhost, 127.0.0.1, ::1"));
    }
    if (proxy.username || proxy.password) {
      lines.push(prefString("network.proxy.username", proxy.username || ""));
      lines.push(prefString("network.proxy.password", proxy.password || ""));
    }
  } else {
    lines.push(prefNumber("network.proxy.type", 0)); // direct
  }

  if (opts.dohUrl) {
    // TRR mode 2 = prefer DoH (fall back to native on failure).
    lines.push(prefNumber("network.trr.mode", 2));
    lines.push(prefString("network.trr.uri", opts.dohUrl));
  } else {
    // Explicit native-DNS default so a previous managed profile never lingers.
    lines.push(prefNumber("network.trr.mode", 5));
  }

  if (opts.locale) {
    lines.push(prefString("intl.locale.requested", opts.locale));
  }

  // Quiet first-run / UX noise that could flag automation.
  lines.push(prefBoolean("app.update.auto", false));
  lines.push(prefBoolean("browser.shell.checkDefaultBrowser", false));
  lines.push(prefNumber("browser.startup.page", 0));

  return lines.join("\n") + "\n";
}

/** Ensure a Firefox profile dir exists and (re)write managed prefs into it. */
export function writeFirefoxUserJs(profileDir: string, opts: FirefoxUserJsOpts, file = "user.js"): void {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, file), buildFirefoxUserJs(opts), "utf8");
}