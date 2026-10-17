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
//    * manage automation/GPU/theme and proxy/DoH/locale prefs reversibly, while
//      preserving Gecko's platform/build sandbox defaults.
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
import { bundledFirefoxBinaryPath, bundledFirefoxBinaryPathAsync } from "./bundled-native-browsers.js";
import { runBrowserCommand } from "./browser-command.js";
import { assertFirefoxRuntimePackage, assertFirefoxRuntimePackageAsync } from "./firefox-runtime-package.js";
import {
  findManagedFirefoxBinary,
  findManagedFirefoxBinaryAsync,
  getManagedFirefoxRoot,
  compareFirefoxVersions,
} from "./native-firefox-manager.js";
import {
  FIREFOX_NATIVE_REQUIRED_SWITCH,
  FIREFOX_NATIVE_CONFIG_CAPABILITIES,
  FIREFOX_NATIVE_PARITY_CAPABILITIES,
  firefoxNativeModeRequested,
  getFirefoxNativeSelectionIdentityAsync,
  readFirefoxNativeCapabilityReport,
  readFirefoxNativeCapabilityReportAsync,
  type FirefoxNativeCapabilityReport,
} from "./firefox-native-capabilities.js";

export type BrowserEngine = "chromium" | "firefox";

const FIREFOX_ENV = "AGENT_BROWSER_FIREFOX_BINARY_PATH";
const FIREFOX_ENV_LEGACY = "FIREFOX_BINARY_PATH";

export function sanitizeBrowserEngine(value: unknown): BrowserEngine {
  return value === "firefox" ? "firefox" : "chromium";
}

/**
 * Engine-aware version pin for profile creation (R3 #58): Firefox pins look
 * like "154.0" (1-3 dotted numerics), Chromium pins are exact 4-segment.
 * Returns null for unset/auto. Throws on malformed input (fail-closed: a bad
 * pin must not silently become "auto").
 */
export function normalizeManagedFirefoxVersion(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === "auto") return null;
  const s = String(value).trim();
  if (!/^\d+(\.\d+){0,2}$/.test(s)) {
    throw new Error(`Invalid Firefox version: ${JSON.stringify(s.slice(0, 40))}`);
  }
  return s;
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

function usableFirefoxRuntimePackage(candidate: string): boolean {
  try { assertFirefoxRuntimePackage(candidate); return true; }
  catch { return false; } // Skip one incomplete default candidate, not explicit overrides.
}

async function usableFirefoxRuntimePackageAsync(candidate: string): Promise<boolean> {
  try { await assertFirefoxRuntimePackageAsync(candidate); return true; }
  catch { return false; }
}

function bundledFirefoxVersionWins(version: string | null, managedVersion: string): boolean {
  return !!version && /^\d+\.\d+(?:\.\d+)?$/.test(version)
    && compareFirefoxVersions(version, managedVersion) >= 0;
}

/** Find Firefox: explicit override, newest auto candidate (bundled wins ties), then system stock. */
export function findFirefoxBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = getFirefoxBinaryOverride(env);
  if (override) {
    // An invalid explicit macOS package is an actionable error, never fallback.
    assertFirefoxRuntimePackage(override);
    return fs.existsSync(override) ? override : null;
  }
  const managed = findManagedFirefoxBinary(null, getManagedFirefoxRoot(env));
  const bundled = bundledFirefoxBinaryPath();
  if (bundled && usableFirefoxRuntimePackage(bundled)) {
    if (!managed || bundledFirefoxVersionWins(detectFirefoxVersion(bundled), managed.version)) return bundled;
  }
  if (managed) return managed.binaryPath;
  for (const candidate of defaultFirefoxBinaryPaths()) {
    if (fs.existsSync(candidate) && usableFirefoxRuntimePackage(candidate)) return candidate;
  }
  return null;
}

async function firefoxPathExists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Async discovery preserves explicit-override fail-closed precedence. */
export async function findFirefoxBinaryAsync(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const override = getFirefoxBinaryOverride(env);
  if (override) {
    await assertFirefoxRuntimePackageAsync(override);
    return await firefoxPathExists(override) ? override : null;
  }
  const managed = await findManagedFirefoxBinaryAsync(null, getManagedFirefoxRoot(env));
  const bundled = await bundledFirefoxBinaryPathAsync();
  if (bundled && await usableFirefoxRuntimePackageAsync(bundled)) {
    if (!managed || bundledFirefoxVersionWins(await detectFirefoxVersionAsync(bundled), managed.version)) return bundled;
  }
  if (managed) return managed.binaryPath;
  for (const candidate of defaultFirefoxBinaryPaths()) {
    if (await firefoxPathExists(candidate) && await usableFirefoxRuntimePackageAsync(candidate)) return candidate;
  }
  return null;
}

function firefoxVersionShellAttempts(bin: string): readonly boolean[] | null {
  if (/[&|;`$<>(){}$!\n\r]/.test(bin)) return null;
  const isShim = process.platform === "win32" && (bin.endsWith(".js") || bin.endsWith(".cmd") || bin.endsWith(".bat"));
  // CMD expands %VAR%, uses ^ escapes, and permits quote-based command injection.
  // Reject these before either shim attempt; ordinary shim paths remain supported.
  if (isShim && /[%^"']/.test(bin)) return null;
  return isShim ? [false, true] : [false];
}

/** Detect the Firefox product version without blocking the main thread. */
export async function detectFirefoxVersionAsync(bin: string): Promise<string | null> {
  const attempts = firefoxVersionShellAttempts(bin);
  if (!attempts) return null;
  for (const useShell of attempts) {
    const result = await runBrowserCommand(bin, ["--version"], { timeout: 5000, shell: useShell, retryTimeout: attempts.length === 1 });
    if (!result) continue;
    const raw = String(result.stdout || result.stderr || "").trim();
    if (!raw) continue;
    const match = raw.match(/Mozilla Firefox\s*([\d.]+)/i);
    if (match) return match[1];
    return raw;
  }
  return null;
}

/** Detect the Firefox product version via `firefox --version`. */
export function detectFirefoxVersion(bin: string): string | null {
  // Shell-metacharacter guard: the win32 shim path below spawns via a shell,
  // and `bin` comes from an env override. A value like `evil.cmd & calc.exe`
  // must never execute — reject it before it reaches spawnSync.
  // NOTE: backslash is a normal Windows path separator (C:\...), NOT a shell
  // metacharacter — it must not be in the reject set (broke .cmd shims).
  const attempts = firefoxVersionShellAttempts(bin);
  if (!attempts) return null;
  const run = (useShell: boolean): ReturnType<typeof spawnSync> | null => {
    try {
      return spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true, shell: useShell } as any);
    } catch { return null; }
  };
  // Only Windows .js/.cmd/.bat shims need shell:true; real binaries never do.
  // Missing binaries must return null, not shell error text — treat any non-zero
  // exit as "not a Firefox binary".
  for (const useShell of attempts) {
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
  fingerprintParity: boolean;
  managedInjection: "native" | "prefs+bidi-preload" | "none";
  nativeConfig: boolean;
  nativeRequested: boolean;
  nativeCapabilities: readonly string[];
  sourceStamp: string | null;
  hint: string;
}

export function getFirefoxStatus(env: NodeJS.ProcessEnv = process.env): FirefoxStatus {
  const bin = findFirefoxBinary(env);
  const report = bin ? readFirefoxNativeCapabilityReport(bin) : null;
  return buildFirefoxStatus(bin, bin ? detectFirefoxVersion(bin) : null, report, env);
}

function firefoxSelectionChangedError(): Error & { code: string; retryable: boolean } {
  return Object.assign(
    new Error("Firefox binary or XUL changed while status was being checked; retry discovery."),
    { code: "FIREFOX_SELECTION_CHANGED", retryable: true },
  );
}

export async function getFirefoxStatusAsync(env: NodeJS.ProcessEnv = process.env): Promise<FirefoxStatus> {
  const bin = await findFirefoxBinaryAsync(env);
  if (!bin) return buildFirefoxStatus(null, null, null, env);
  const before = await getFirefoxNativeSelectionIdentityAsync(bin);
  if (!before) throw firefoxSelectionChangedError();
  const [report, version] = await Promise.all([
    readFirefoxNativeCapabilityReportAsync(bin), detectFirefoxVersionAsync(bin),
  ]);
  // Each probe validates its own response, but XUL can change after attestation
  // finishes and before the version probe finishes. Validate the combined result.
  if (await getFirefoxNativeSelectionIdentityAsync(bin) !== before) {
    // Changed selection is unknown, not evidence that Firefox is missing.
    throw firefoxSelectionChangedError();
  }
  return buildFirefoxStatus(bin, version, report, env);
}

function buildFirefoxStatus(
  bin: string | null,
  version: string | null,
  report: FirefoxNativeCapabilityReport | null,
  env: NodeJS.ProcessEnv,
): FirefoxStatus {
  if (!bin) {
    return {
      engine: "firefox",
      installed: false,
      path: null,
      version: null,
      fingerprintParity: false,
      managedInjection: "none",
      nativeConfig: false,
      nativeRequested: firefoxNativeModeRequested(env),
      nativeCapabilities: [],
      sourceStamp: null,
      hint: `Firefox binary not found. Install Firefox or set ${FIREFOX_ENV}.`,
    };
  }
  const capabilities = new Set(report?.capabilities ?? []);
  const nativeConfig = FIREFOX_NATIVE_CONFIG_CAPABILITIES.every((capability) => capabilities.has(capability));
  const fingerprintParity = FIREFOX_NATIVE_PARITY_CAPABILITIES.every((capability) => capabilities.has(capability));
  const nativeRequested = firefoxNativeModeRequested(env);
  const nativeActive = nativeConfig && (fingerprintParity || nativeRequested);
  const nativeCapabilities = report?.capabilities ?? [];
  let hint: string;
  if (nativeRequested && !nativeConfig) {
    hint = "Firefox native-only A/B mode was requested, but the selected binary lacks config-v1/native-required-v1/snapshot-v1; launch will fail closed.";
  } else if (nativeActive) {
    hint = fingerprintParity
      ? "Firefox uses the binary-attested native fingerprint engine; BiDi remains available for automation."
      : "Firefox native-only A/B mode is active with partial capabilities; fingerprint parity remains false.";
  } else if (report) {
    hint = "Firefox exposes partial native capabilities; production keeps the complete prefs + BiDi preload fallback.";
  } else {
    hint = "Firefox is driven via WebDriver BiDi + user.js with the complete managed preload fallback.";
  }
  return {
    engine: "firefox",
    installed: true,
    path: bin,
    version,
    fingerprintParity,
    managedInjection: nativeActive ? "native" : "prefs+bidi-preload",
    nativeConfig,
    nativeRequested,
    nativeCapabilities,
    sourceStamp: report?.sourceStamp ?? null,
    hint,
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
  /** Require binary-native config validation before Firefox opens a window. */
  nativeRequired?: boolean;
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
  // NOTE: no `--marionette` here. The Marionette protocol's accessibility
  // service injects a root accessible object into every content document;
  // navigating a heavy third-party app (ping0.cc/env) with Marionette enabled
  // deterministically wedges the content process's BiDi session ("BiDi request
  // failed"), while pure `--remote-debugging-port` (BiDi-only) stays healthy.
  // The app drives Firefox over BiDi only, so Marionette is dead weight.
  const args: string[] = ["-profile", opts.profileDir, "--remote-debugging-port", String(opts.remotePort ?? 0)];
  if (opts.platform !== "windows") args.push("-new-instance");
  if (opts.headless) args.push("-headless");
  if (opts.nativeRequired) args.push(FIREFOX_NATIVE_REQUIRED_SWITCH);
  if (opts.appUrl) {
    // Dash guard: a value like `-profile /evil` must never become a flag.
    // sanitizeAppUrl already restricts the product path to http(s)/data, but
    // this exported builder defends direct callers too.
    if (opts.appUrl.startsWith("-")) {
      throw new Error("Refusing to pass a dash-leading appUrl as a launch argument");
    }
    args.push(opts.appUrl);
  }
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
    // Any pre-announce exit rejects promptly — a code-0 or signal death must
    // not hang the launch on the 60s timer while holding the launch lock.
    child.on("exit", (code, signal) => {
      finish(() => {
        clearTimeout(timer);
        reject(new Error(`Firefox exited early (${signal ? "signal " + signal : "code " + String(code)}) before announcing a debugging port`));
      });
    });
  });
}

// ═══════════════════════════════════════════════════════════
// Firefox user.js preferences (proxy / DoH / locale)
// ═══════════════════════════════════════════════════════════

// Keep the public engine API stable; preference ownership and data-only
// migration live separately from binary discovery / process launch.
export { buildFirefoxUserJs, writeFirefoxUserJs } from "./firefox-prefs.js";
export type { FirefoxUserJsOpts, FirefoxUserJsWriteResult } from "./firefox-prefs.js";