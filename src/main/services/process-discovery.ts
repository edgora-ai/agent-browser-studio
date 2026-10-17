import * as path from "node:path";
import { execFileSync, exec } from "node:child_process";

/**
 * Cross-platform browser process discovery. The managed browsers are launched
 * with a profile-scoped data dir (Chromium --user-data-dir / Firefox -profile)
 * and a known --remote-debugging-port. After an app restart we rediscover
 * those processes by scanning the OS process table.
 *
 * Linux/macOS use `ps`; Windows uses WMIC/tasklist/cmdline parsing so that
 * `getProfilesDir()` no longer relies on a Unix-only `ps -eo` path.
 */

export type PsLine = string;

// Overridable for tests.
let execFileSyncImpl: typeof execFileSync = execFileSync;
let execImpl: typeof exec = exec;

export function __setProcessDiscoveryExecForTest(overrides: {
  execFileSync?: typeof execFileSync;
  exec?: typeof exec;
}): void {
  if (overrides.execFileSync) execFileSyncImpl = overrides.execFileSync as typeof execFileSync;
  if (overrides.exec) execImpl = overrides.exec as typeof exec;
}

export function __resetProcessDiscoveryExecForTest(): void {
  execFileSyncImpl = execFileSync;
  execImpl = exec;
}

function splitPidArgsLine(line: string): { pid: number; args: string } | null {
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return { pid, args: match[2] };
}

// Shared parser used on all platforms once we have a `pid + command line`-like string.
export function parseBrowserProcessLine(
  line: string,
  expectedProfileDir: string,
): { pid: number; cdpPort: number } | null {
  const pid = parseInt(line.trim().split(/\s+/, 1)[0], 10);
  if (!Number.isInteger(pid) || pid < 1) return null;
  const expected = path.resolve(expectedProfileDir);
  let profileArg: string | null = null;
  const chromiumMatch = line.match(/--user-data-dir=("[^"]+"|'[^']+'|\S+)/);
  if (chromiumMatch) profileArg = chromiumMatch[1].replace(/^['\"]|['\"]$/g, "");
  if (profileArg === null) {
    const fxMatch = line.match(/(?:^|\s)-profile\s+("[^"]+"|'[^']+'|\S+)/);
    if (fxMatch) profileArg = fxMatch[1].replace(/^['\"]|['\"]$/g, "");
  }
  if (profileArg === null) return null;
  if (path.resolve(profileArg) !== expected) return null;
  let cdpPort = 0;
  const portEq = line.match(/--remote-debugging-port=(\d+)/);
  const portSpace = line.match(/--remote-debugging-port\s+(\d+)/);
  if (portEq) cdpPort = parseInt(portEq[1], 10);
  else if (portSpace) cdpPort = parseInt(portSpace[1], 10);
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) return null;
  return { pid, cdpPort };
}

/** Additional launch-only evidence; ordinary listing/discovery keeps its legacy contract. */
export interface BrowserLaunchProcess {
  pid: number;
  executablePath: string;
  engine: "chromium" | "firefox" | null;
  args: string[];
  profileDirs: string[];
  cdpPorts: number[];
  malformed: boolean;
}

export interface BrowserLaunchSnapshot {
  available: boolean;
  candidates: BrowserLaunchProcess[];
  tracked: BrowserLaunchProcess | null;
}

export function normalizeBrowserProcessPath(value: string): string {
  // Windows paths also occur in parser fixtures on non-Windows hosts.
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value)
    ? path.win32.resolve(value).toLowerCase()
    : value.startsWith("/") ? path.posix.resolve(value) : path.resolve(value);
}

function isQuotedArgument(value: string): boolean {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
}

function unquoteArgument(value: string): string {
  if (!isQuotedArgument(value)) return value;
  if (value.startsWith("'")) return value.slice(1, -1);
  // Windows CIM preserves CRT quoting, including escaped quotes/backslashes.
  let out = "";
  let quoted = false;
  for (let i = 0; i < value.length;) {
    let slashes = 0;
    while (value[i] === "\\") { slashes++; i++; }
    if (value[i] === '"') {
      out += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2) { out += '"'; i++; }
      else if (quoted && value[i + 1] === '"') { out += '"'; i += 2; }
      else { quoted = !quoted; i++; }
    } else {
      out += "\\".repeat(slashes);
      if (i < value.length) out += value[i++];
    }
  }
  return out;
}

function firefoxPortAndArguments(value: string): string[] | null {
  // Split only a complete numeric port, optional -headless and one app URL.
  // A global -headless boundary would split flat ps paths containing that text.
  const match = /^(\d+)\s+(?:(-headless)(?:\s+|$))?((?:https?:\/\/|data:)\S+|"(?:https?:\/\/|data:)[^"\r\n]*"|'(?:https?:\/\/|data:)[^'\r\n]*')?$/.exec(value);
  if (!match || (!match[2] && !match[3])) return null;
  const appUrl = match[3] ? unquoteArgument(match[3]) : null;
  if (appUrl) {
    try { new URL(appUrl); }
    catch { return null; }
  }
  return [`--remote-debugging-port=${match[1]}`, ...(match[2] ? [match[2]] : []), ...(appUrl ? [appUrl] : [])];
}

function launchSwitchBoundaries(command: string): { switches: Array<{ index: number; key: string }>; unterminated: boolean } {
  const switches: Array<{ index: number; key: string }> = [];
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const boundary = i === 0 || /\s/.test(command[i - 1]);
    if (quote === null && boundary) {
      const start = char === '"' || char === "'" ? i + 1 : i;
      const match = /^(--[A-Za-z][\w-]*|-(?:profile|no-remote|new-instance))(?==|\s|["']|$)/.exec(command.slice(start));
      if (match) switches.push({ index: i, key: match[1] });
    }
    if (char !== '"' && char !== "'") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && command[j] === "\\"; j--) slashes++;
    if (slashes % 2) continue;
    if (quote === char) {
      if (quote === '"' && command[i + 1] === '"') { i++; continue; }
      quote = null;
    } else if (quote === null && (char === '"' || boundary || command[i - 1] === "=")) {
      quote = char;
    }
  }
  return { switches, unterminated: quote !== null };
}

/** Exact in-memory argv needs no lossy command-line reconstruction. */
export function browserLaunchProcessFromArgv(pid: number, executablePath: string, argv: readonly string[]): BrowserLaunchProcess {
  const args = [...argv];
  const chromiumDirs = args.filter((arg) => arg.startsWith("--user-data-dir=")).map((arg) => arg.slice("--user-data-dir=".length));
  const firefoxDirs = args.filter((arg) => arg.startsWith("-profile=")).map((arg) => arg.slice("-profile=".length));
  const ports = args.filter((arg) => arg === "--remote-debugging-port" || arg.startsWith("--remote-debugging-port=")).map((arg) => {
    const value = arg.slice("--remote-debugging-port=".length);
    return /^\d+$/.test(value) ? Number(value) : 0;
  });
  const profileDirs = [...chromiumDirs, ...firefoxDirs];
  return {
    pid, executablePath, args, profileDirs, cdpPorts: ports,
    engine: chromiumDirs.length && !firefoxDirs.length ? "chromium" : firefoxDirs.length && !chromiumDirs.length ? "firefox" : null,
    malformed: !Number.isSafeInteger(pid) || pid < 1 || !executablePath || profileDirs.some((dir) => !dir) ||
      profileDirs.length > 1 || ports.length > 1 || ports.some((port) => port < 1 || port > 65535),
  };
}

/** Quote-aware CIM/ps parsing; a display string is never a source of real flags. */
export function parseBrowserLaunchProcessLine(line: string): BrowserLaunchProcess | null {
  const parsed = splitPidArgsLine(line);
  if (!parsed || !parsed.args.trim()) return null;
  const command = parsed.args.trim();
  if (/^"[^"]*"\s*,/.test(command)) return null; // tasklist titles are not argv.
  const { switches, unterminated } = launchSwitchBoundaries(command);
  const executablePath = unquoteArgument(command.slice(0, switches[0]?.index ?? command.length).trim());
  const hasFirefoxProfile = switches.some((match) => match.key === "-profile");
  let ambiguousDisplay = false;
  const args = switches.flatMap((match, index) => {
    const original = command.slice(match.index, switches[index + 1]?.index ?? command.length).trim();
    const raw = unquoteArgument(original);
    const rest = raw.slice(raw.indexOf(match.key) + match.key.length);
    const valueText = rest.replace(/^(?:=|\s+)/, "").trim();
    if (hasFirefoxProfile && match.key === "--remote-debugging-port" && !isQuotedArgument(original)) {
      const portAndArguments = firefoxPortAndArguments(valueText);
      if (portAndArguments) return portAndArguments;
    }
    if (match.key === "--agent-browser-window-title-prefix" && !isQuotedArgument(original) && !isQuotedArgument(valueText)) {
      // ps has discarded argv boundaries here. Do not guess whether any later
      // apparent switch belongs to the display text. New owned launches put
      // this display-only argument last; live owned spawnargs stay exact.
      ambiguousDisplay ||= index + 1 < switches.length || /\s--[A-Za-z]/.test(valueText);
    }
    return rest ? `${match.key}=${unquoteArgument(valueText)}` : match.key;
  });
  const evidence = browserLaunchProcessFromArgv(parsed.pid, executablePath, args);
  evidence.malformed ||= unterminated || ambiguousDisplay;
  return evidence;
}

/** Pure selection shared by the existing process-table collector and fixtures. */
export function inspectBrowserLaunchLines(
  lines: readonly string[],
  expectedProfileDir: string,
  trackedPid?: number,
): BrowserLaunchSnapshot {
  const processes = lines.map(parseBrowserLaunchProcessLine).filter((entry): entry is BrowserLaunchProcess => entry !== null);
  const expected = normalizeBrowserProcessPath(expectedProfileDir);
  return {
    available: processes.length > 0,
    candidates: processes.filter((entry) => {
      if (!entry.profileDirs.some((dir) => normalizeBrowserProcessPath(dir) === expected)) return false;
      const typeIndex = entry.args.findIndex((arg) => /^--type(?:=|$)/.test(arg));
      if (typeIndex < 0) return true;
      // Actual renderers inherit the profile AND CDP port, but are not owners.
      // A type-looking token after ambiguous flat display text is not proven
      // to be a real switch: retain that unverified claim so recovery blocks,
      // or the existing live-owned exact argv/tracked path can disambiguate it.
      const displayIndex = entry.args.findIndex((arg) => arg.startsWith("--agent-browser-window-title-prefix="));
      return entry.malformed && displayIndex >= 0 && typeIndex > displayIndex;
    }),
    tracked: processes.find((entry) => entry.pid === trackedPid) || null,
  };
}

export function inspectBrowserLaunchesSync(expectedProfileDir: string, trackedPid?: number): BrowserLaunchSnapshot {
  return inspectBrowserLaunchLines(collectLinesSync(true), expectedProfileDir, trackedPid);
}

function psLinesSync(): string[] {
  // Prefer `ps -eo pid,args`; fallback to pid,command.
  try {
    const out = execFileSyncImpl("ps", ["-eo", "pid,args"], { encoding: "utf-8", timeout: 2000 }) as unknown as string;
    return out.split("\n");
  } catch {}
  try {
    const out = execFileSyncImpl("ps", ["-eo", "pid,command"], { encoding: "utf-8", timeout: 2000 }) as unknown as string;
    return out.split("\n");
  } catch {
    return [];
  }
}

function wmicLinesSync(): string[] {
  // WMIC is deprecated on newer Windows but still present on many hosts.
  // Use CSV form so commas inside command lines remain quoted.
  try {
    const out = execFileSyncImpl("wmic", ["process", "get", "ProcessId,CommandLine", "/FORMAT:CSV"], {
      encoding: "utf-8",
      timeout: 3000,
    }) as unknown as string;
    const lines: string[] = [];
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^Node,/i.test(line) || /^CommandLine,/i.test(line)) continue;
      // CSV: Node,CommandLine,ProcessId — CommandLine itself may contain commas/quotes.
      // Heuristic: last comma-separated field is PID; rest is Node + CommandLine.
      const lastComma = line.lastIndexOf(",");
      if (lastComma === -1) continue;
      const pidStr = line.slice(lastComma + 1).trim();
      const pid = parseInt(pidStr, 10);
      if (!Number.isInteger(pid) || pid < 1) continue;
      // Strip leading Node field: first comma.
      const firstComma = line.indexOf(",");
      if (firstComma === -1 || firstComma >= lastComma) continue;
      let cmd = line.slice(firstComma + 1, lastComma).trim();
      // Unquote CSV outer quotes if present.
      if (cmd.length >= 2 && cmd.startsWith('"') && cmd.endsWith('"')) {
        cmd = cmd.slice(1, -1).replace(/""/g, '"');
      }
      lines.push(`${pid} ${cmd}`);
    }
    return lines;
  } catch {
    return [];
  }
}

function tasklistLinesSync(): string[] {
  // tasklist /v is verbose but still parsable; we use /fo csv with images for fallback enumeration.
  // This fallback cannot reliably produce full command lines, so only use it as last resort for PID existence.
  // Prefer `tasklist /v /fo csv` which includes command-ish details on some Windows builds.
  try {
    const out = execFileSyncImpl("tasklist", ["/v", "/fo", "csv", "/nh"], {
      encoding: "utf-8",
      timeout: 3000,
    }) as unknown as string;
    // CSV lines contain quoted fields; we keep the raw line with a fake PID-args prefix
    // so the shared parser can still extract --remote-debugging-port if present in the window title column.
    // In practice this path is lossy — success is defined as "not throwing".
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        // Extract PID from the second quoted field (Image Name, PID, ...).
        // CSV: "chrome.exe","1234",...
        const m = l.match(/^"[^"]*"\s*,\s*"(\d+)"/);
        if (!m) return "";
        return `${m[1]} ${l}`;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function powershellLinesSync(): string[] {
  try {
    // JSON avoids Format-List wrapping/truncating long native payloads. This is
    // the existing one-shot process-table fallback, not a persistent observer.
    const out = execFileSyncImpl("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], {
      encoding: "utf-8", timeout: 3000,
    }) as unknown as string;
    const parsed = JSON.parse(out.startsWith(String.fromCharCode(0xfeff)) ? out.slice(1) : out);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((entry) => Number.isInteger(entry?.ProcessId) && entry.ProcessId > 0 && typeof entry.CommandLine === "string" && entry.CommandLine.trim())
      .map((entry) => `${entry.ProcessId} ${entry.CommandLine}`);
  } catch {
    return [];
  }
}

function collectLinesSync(requireCommandLine = false): string[] {
  if (process.platform === "win32") {
    const wmic = wmicLinesSync();
    if (wmic.length) return wmic;
    // Ordinary listing retains tasklist's lossy fallback. Launch validation
    // cannot treat a window title as argv, so it requires the existing CIM path.
    if (!requireCommandLine) {
      const tl = tasklistLinesSync();
      if (tl.length) return tl;
    }
    return powershellLinesSync();
  }
  return psLinesSync();
}

export function findBrowserByProfileSync(dirId: string, expectedProfileDir: string): { pid: number; cdpPort: number } | null {
  void dirId;
  const lines = collectLinesSync();
  for (const line of lines) {
    const info = parseBrowserProcessLine(line, expectedProfileDir);
    if (info) return info;
  }
  return null;
}

export function findCdpPortSync(dirId: string, profileDir: string): number | null {
  // R15 P1-15: exact directory match like parseBrowserProcessLine — the old
  // substring includes() matched profiles/abc against profiles/abc-def and
  // returned the wrong CDP port (cross-profile cookie confusion).
  const info = findBrowserByProfileSync(dirId, profileDir);
  return info ? info.cdpPort : null;
}

// Async variant for callers that previously used `exec("ps -eo pid,args", cb)`.
export function getRunningProcessesAsync(): Promise<Array<{ pid: number; args: string }>> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const lines = collectLinesSync();
      const out: Array<{ pid: number; args: string }> = [];
      for (const line of lines) {
        const parsed = splitPidArgsLine(line);
        if (parsed) out.push(parsed);
      }
      resolve(out);
      return;
    }
    execImpl("ps -eo pid,args", { timeout: 2000 }, (error: any, stdout: string) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      const out: Array<{ pid: number; args: string }> = [];
      for (const line of stdout.split("\n")) {
        const parsed = splitPidArgsLine(line);
        if (parsed) out.push(parsed);
      }
      resolve(out);
    });
  });
}
