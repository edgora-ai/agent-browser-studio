// Browser engine abstraction (Slice 77 — Firefox capability; Slice 78 — aligned
// with RoxyFirefox's proven launch approach).
//
// The product core engine is the independently patched Chromium 150 build
// (managed fingerprint injection via the --fingerprint-* switch family). This
// module makes "Firefox" a first-class, modeled option in the product:
//  - profiles can declare engine = "chromium" | "firefox";
//  - Firefox binary discovery + version detection (`AGENT_BROWSER_FIREFOX_BINARY_PATH`);
//  - a Firefox launch-argument builder and `user.js` preferences writer modeled
//    on RoxyBrowser's real RoxyFirefox engine (Slice 78 reference):
//    * launch with `-profile`, `--marionette`, `--remote-debugging-port=0`,
//      `-no-remote` (Roxy's proven CLI);
//    * parse `WebDriver BiDi listening on ws://...` from stderr to discover the
//      automation WebSocket, and `Marionette INFO Listening on port N` from
//      stdout for the legacy Marionette port — exactly like Roxy's launcher;
//    * write the same managed `user.js` family (automation-friendly prefs, GPU,
//      sandbox, color-scheme/theme) plus proxy/DoH/locale prefs.
//  - an engine-status surface used by IPC / REST / MCP / UI.
//
// Honest scope note: full managed fingerprint-injection parity for Firefox
// (Roxy drives Firefox mostly through Marionette/BiDi + user.js, not a
// --fingerprint-* patch set — see Slice 78) is the remaining follow-up. This
// slice delivers the engine plumbing + Roxy-aligned launch so Firefox profiles
// are real, detectable and launch like RoxyFirefox does.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ProxyConfig } from "../types.js";
import { bundledFirefoxBinaryPath } from "./bundled-native-browsers.js";

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

/** Find the Firefox binary (env override wins, then the bundled copy, then platform defaults). */
export function findFirefoxBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = getFirefoxBinaryOverride(env);
  if (override) return fs.existsSync(override) ? override : null;
  const bundled = bundledFirefoxBinaryPath();
  if (bundled) return bundled;
  for (const candidate of defaultFirefoxBinaryPaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Detect the Firefox product version via `firefox --version`. */
export function detectFirefoxVersion(bin: string): string | null {
  const run = (useShell: boolean): ReturnType<typeof spawnSync> | null => {
    try {
      return spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true, shell: useShell } as any);
    } catch { return null; }
  };
  // On Windows a Node .js shim needs shell:true; real binaries work either way.
  // Missing binaries must return null, not shell error text — treat any non-zero
  // exit as "not a Firefox binary".
  for (const useShell of [false, true] as const) {
    const result = run(useShell);
    if (!result || result.error) continue;
    if (typeof (result as any).status === "number" && (result as any).status !== 0) continue;
    const raw = String((result.stdout as unknown as string) || (result.stderr as unknown as string) || "").trim();
    if (!raw) continue;
    const match = raw.match(/Mozilla Firefox\s*([\d.]+)/i);
    if (match) return match[1];
    if (raw) return raw;
  }
  return null;
}

export interface FirefoxStatus {
  engine: "firefox";
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Native `--fingerprint-*` patch parity is NOT delivered on stock Firefox. */
  fingerprintParity: false;
  /** What the runtime DOES deliver (Slice 79): prefs + BiDi preload injection. */
  managedInjection: "prefs+bidi-preload" | "none";
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
      managedInjection: "none",
      hint: `Firefox binary not found. Install Firefox or set ${FIREFOX_ENV}.`,
    };
  }
  return {
    engine: "firefox",
    installed: true,
    path: bin,
    version: detectFirefoxVersion(bin),
    fingerprintParity: false,
    managedInjection: "prefs+bidi-preload",
    hint: "Firefox is driven via WebDriver BiDi + user.js (RoxyFirefox-aligned). " +
      "Managed identity = prefs + preload injection (Slice 79); native --fingerprint-* patch parity is a known follow-up.",
  };
}

// ═══════════════════════════════════════════════════════════
// Firefox launch arguments
// ═══════════════════════════════════════════════════════════

export interface FirefoxLaunchArgsOpts {
  profileDir: string;
  /** 0 (default) = auto-assign and parse from Firefox output; or a specific port. */
  remotePort?: number;
  headless?: boolean;
  platform?: "windows" | "macos" | "android";
  /** First-tab URL (Web App / PWA-ish mode; Firefox has no --app= flag). */
  appUrl?: string | null;
}

/**
 * Build the Firefox command line, modeled on RoxyBrowser's real RoxyFirefox
 * engine (Slice 78 reference — Roxy uses `-profile`, `--marionette`,
 * `--remote-debugging-port=0`, `-no-remote`):
 *  - Firefox uses `-profile <dir>` (not `--user-data-dir=`);
 *  - `--marionette` enables the Marionette automation port (parsed from stdout);
 *  - `--remote-debugging-port` exposes the WebDriver BiDi WebSocket (parsed from
 *    stderr as `WebDriver BiDi listening on ws://...`); Roxy uses 0 = auto;
 *  - `-no-remote` prevents the running-instance takeover; `-new-instance` forces
 *    a fresh instance on macOS/Linux (Firefox for Windows does not accept it).
 */
export function buildFirefoxLaunchArgs(opts: FirefoxLaunchArgsOpts): string[] {
  const args: string[] = ["-profile", opts.profileDir, "--marionette", "--remote-debugging-port", String(opts.remotePort ?? 0)];
  if (opts.platform !== "windows") args.push("-new-instance");
  if (opts.headless) args.push("-headless");
  if (opts.appUrl) args.push(opts.appUrl);
  args.push("-no-remote");
  return args;
}

// ═══════════════════════════════════════════════════════════
// Firefox debugging discovery (RoxyFirefox-aligned, Slice 78)
//
// Roxy parses Firefox's own output instead of guessing a port:
//  - stderr: `WebDriver BiDi listening on ws://127.0.0.1:PORT/...`
//  - stdout: `Marionette  INFO  Listening on port N`
// We mirror that so a Firefox profile launches on a conflict-free port and we
// can report the real automation endpoint to the rest of the product.
// ═══════════════════════════════════════════════════════════

const BIDI_WS_RE = /WebDriver BiDi listening on (ws:\/\/\S+)/i;
const MARIONETTE_PORT_RE = /Marionette\s+INFO\s+Listening on port\s+(\d+)/i;

export function extractBidiWebSocketUrl(text: string): string | null {
  const m = String(text || "").match(BIDI_WS_RE);
  return m ? m[1] : null;
}

export function extractMarionettePort(text: string): number | null {
  const m = String(text || "").match(MARIONETTE_PORT_RE);
  if (!m) return null;
  const port = Number.parseInt(m[1], 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export interface FirefoxDebugInfo {
  /** WebDriver BiDi WebSocket URL parsed from stderr. */
  bidiWebSocketUrl: string | null;
  /** Marionette port parsed from stdout. */
  marionettePort: number | null;
  /** The port from the BiDi WebSocket URL (actual remote-debugging port). */
  actualPort: number | null;
}

/**
 * Spawn Firefox and wait for its debugging endpoint, mirroring Roxy's launcher.
 * Resolves once the WebDriver BiDi WebSocket is printed (with a hard timeout),
 * or rejects with a clear message if Firefox exits before announcing a port.
 */
export function spawnFirefoxWithDebugInfo(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ child: ChildProcess; info: FirefoxDebugInfo }> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  return new Promise((resolve, reject) => {
    const needsShell = process.platform === "win32" && (bin.endsWith(".js") || bin.endsWith(".cmd") || bin.endsWith(".bat"));
    const child = spawn(bin, args, { detached: false, stdio: ["ignore", "pipe", "pipe"], env: opts.env ?? process.env, shell: needsShell } as any);
    let bidiUrl: string | null = null;
    let marionettePort: number | null = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error("Firefox launch timed out waiting for the debugging port"));
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      const port = extractMarionettePort(text);
      if (port !== null && marionettePort === null) marionettePort = port;
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      const url = extractBidiWebSocketUrl(text);
      if (url && bidiUrl === null) {
        bidiUrl = url;
        let actualPort: number | null = null;
        try { actualPort = Number.parseInt(new URL(url).port, 10) || null; } catch { /* ignore */ }
        finish(() => {
          clearTimeout(timer);
          resolve({ child, info: { bidiWebSocketUrl: url, marionettePort, actualPort } });
        });
      }
    });
    child.on("error", (err) => {
      finish(() => { clearTimeout(timer); reject(err); });
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        finish(() => {
          clearTimeout(timer);
          reject(new Error(`Firefox exited early (code ${code}) before announcing a debugging port`));
        });
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════
// Firefox user.js preferences (proxy / DoH / locale)
// ═══════════════════════════════════════════════════════════

export interface FirefoxUserJsOpts {
  proxy?: ProxyConfig | null;
  /** DoH endpoint URI; when set, Firefox uses TRR as the DNS resolver. */
  dohUrl?: string | null;
  locale?: string | null;
  /** Extra managed prefs (Slice 79 fingerprint parity: UA / concurrency / DNT). */
  extraPrefs?: Record<string, string | number | boolean> | null;
  /** Hardware acceleration enabled (Roxy maps this to layers/webrender prefs). */
  useGpu?: boolean;
  /** Content sandbox level: true = 0 (enabled), false = -1 (disabled). */
  sandboxPermission?: boolean;
  /** Color scheme: "system" | "dark" | "light" (Roxy's color-scheme family). */
  colorScheme?: "system" | "dark" | "light";
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
 * Build the managed `user.js` prefs file for a Firefox profile, modeled on
 * RoxyBrowser's RoxyFirefox `prepareFirefoxProfile` (Slice 78 reference):
 * Firefox does not expose proxy / DoH on the command line like Chromium does,
 * so the standard, reversible way to steer a launched profile is a `user.js`
 * in the profile directory. We keep Roxy's family (automation-friendly prefs,
 * GPU / sandbox, color-scheme + active theme) and layer our proxy / DoH /
 * locale prefs on top. The file lives inside the (already sealed) profile dir
 * and is never logged.
 */
export function buildFirefoxUserJs(opts: FirefoxUserJsOpts): string {
  const lines: string[] = [];
  lines.push("// Agent Browser Studio managed Firefox preferences (RoxyFirefox-aligned, regenerated at launch).");

  // Extra managed prefs (Slice 79 fingerprint parity family), laid down before
  // the Roxy base family so a conflict always resolves in Roxy's favor.
  if (opts.extraPrefs) {
    for (const [key, value] of Object.entries(opts.extraPrefs)) {
      if (typeof value === "boolean") lines.push(prefBoolean(key, value));
      else if (typeof value === "number") lines.push(prefNumber(key, value));
      else lines.push(prefString(key, String(value)));
    }
  }

  // Roxy's automation-friendly base prefs (keeps WebDriver/Marionette sessions
  // and background tabs stable for unattended runs).
  lines.push(prefBoolean("focusmanager.testmode", true));
  lines.push(prefBoolean("layout.testing.top-level-always-active", true));
  lines.push(prefNumber("dom.min_background_timeout_value", 0));
  lines.push(prefNumber("dom.min_background_timeout_value_without_budget_throttling", 0));
  lines.push(prefBoolean("dom.timeout.enable_budget_timer_throttling", false));
  lines.push(prefString("browser.startup.homepage", "about:home"));
  lines.push(prefBoolean("browser.newtabpage.enabled", true));

  // GPU (hardware acceleration) — Roxy maps `useGpu` to these two prefs.
  if (opts.useGpu) {
    lines.push(prefBoolean("layers.acceleration.disabled", false));
    lines.push(prefBoolean("gfx.webrender.disabled", false));
  } else {
    lines.push(prefBoolean("layers.acceleration.disabled", true));
    lines.push(prefBoolean("gfx.webrender.disabled", true));
  }

  // Content sandbox — Roxy: true = level 0 (enabled), false = -1 (disabled).
  lines.push(prefNumber("security.sandbox.content.level", opts.sandboxPermission ? 0 : -1));

  // Color scheme + active theme (Roxy's `browserColorScheme` family).
  const scheme = opts.colorScheme ?? "system";
  if (scheme === "system") {
    lines.push(prefNumber("layout.css.prefers-color-scheme.content-override", 2));
  } else {
    const dark = scheme === "dark";
    lines.push(prefNumber("layout.css.prefers-color-scheme.content-override", dark ? 0 : 1));
    lines.push(prefBoolean("ui.systemUsesDarkTheme", dark));
  }
  const theme = scheme === "dark"
    ? "firefox-compact-dark@mozilla.org"
    : scheme === "light"
      ? "firefox-compact-light@mozilla.org"
      : "default-theme@mozilla.org";
  lines.push(prefString("extensions.activeThemeID", theme));

  // Proxy — HTTP or SOCKS (socks5h → remote DNS) via the standard prefs.
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
    // TRR mode 3 = DoH ONLY (no native-DNS fallback). The fingerprint goal is
    // a coherent DNS view: a fallback path would let instrumented pages see
    // two resolver populations (native + DoH) at once, which careers as a
    // proxy/DNS tell. Mode 2 is what an interactive user wants; a managed,
    // deployment-guaranteed DoH endpoint is what the platform wants.
    lines.push(prefNumber("network.trr.mode", 3));
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