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
  const trimmed = line.trim();
  if (!trimmed) return null;
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) return null;
  const pid = parseInt(trimmed.slice(0, firstSpace), 10);
  if (!Number.isInteger(pid) || pid < 1) return null;
  return { pid, args: trimmed.slice(firstSpace + 1) };
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

function collectLinesSync(): string[] {
  if (process.platform === "win32") {
    const wmic = wmicLinesSync();
    if (wmic.length) return wmic;
    const tl = tasklistLinesSync();
    if (tl.length) return tl;
    // As absolute last resort, try PowerShell Get-CimInstance via execFileSync.
    try {
      const out = execFileSyncImpl("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | Format-List"], {
        encoding: "utf-8",
        timeout: 3000,
      }) as unknown as string;
      const lines: string[] = [];
      let pid: number | null = null;
      let cmd = "";
      for (const raw of out.split(/\r?\n/)) {
        const mPid = raw.match(/^\s*ProcessId\s*:\s*(\d+)/i);
        if (mPid) {
          pid = parseInt(mPid[1], 10);
          continue;
        }
        const mCmd = raw.match(/^\s*CommandLine\s*:\s*(.*)$/i);
        if (mCmd) {
          cmd = mCmd[1].trim();
          if (pid && cmd) lines.push(`${pid} ${cmd}`);
          pid = null;
          cmd = "";
        }
      }
      if (lines.length) return lines;
    } catch {}
    return [];
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
  void dirId;
  const lines = collectLinesSync();
  for (const line of lines) {
    if (!line.includes(profileDir)) continue;
    const mEq = line.match(/--remote-debugging-port=(\d+)/);
    if (mEq) {
      const p = parseInt(mEq[1], 10);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
    }
    const mSp = line.match(/--remote-debugging-port\s+(\d+)/);
    if (mSp) {
      const p = parseInt(mSp[1], 10);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
    }
  }
  return null;
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
