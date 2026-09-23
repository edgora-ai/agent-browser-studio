import * as path from "node:path";
import { runningProcesses, type RunningEntry } from "./runtime-table.js";
import { findBrowserByProfileSync } from "../process-discovery.js";
import { getProfilesDir } from "../config-manager.js";
import { validateDirId } from "../utils.js";
import { dropFirefoxSession } from "../bidi-client.js";
import { recordAudit } from "../audit-log.js";
import type { InjectionProbeCheck } from "../firefox-fingerprint.js";

function findBrowserByProfile(dirId: string): { pid: number; cdpPort: number } | null {
  validateDirId(dirId);
  const expectedProfileDir = path.resolve(getProfilesDir(), dirId);
  try {
    return findBrowserByProfileSync(dirId, expectedProfileDir);
  } catch {
    return null;
  }
}

const BROWSER_FORCE_KILL_AFTER_MS = 3_000;
const BROWSER_SHUTDOWN_POLL_MS = 25;
export const BROWSER_SHUTDOWN_WAIT_MS = 5_000;
export const BROWSER_SHUTDOWN_MAX_WAIT_MS = 15_000;

export interface BrowserShutdownTarget {
  dirId: string;
  pid: number;
}

export interface BrowserShutdownReport {
  requested: BrowserShutdownTarget[];
  exited: BrowserShutdownTarget[];
  unfinished: BrowserShutdownTarget[];
  timedOut: boolean;
  elapsedMs: number;
}

function beginBrowserStop(
  dirId: string,
  entry: RunningEntry | undefined,
  pids: number[],
): boolean {
  if (!pids.length) return false;

  if (entry?.bidiConn) {
    dropFirefoxSession(entry.port);
    try { entry.bidiConn.close(); } catch { /* ignore */ }
  }
  if (entry) delete entry.bidiConn;

  if (entry?.killTimer) clearTimeout(entry.killTimer);

  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* liveness is verified below */ }
  }
  const killTimer = setTimeout(() => {
    const current = runningProcesses.get(dirId);
    if (current && current.pid === pids[0]) {
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* reported by awaited shutdown */ }
      }
      void current.proxyBridge?.close().catch(() => undefined);
      runningProcesses.delete(dirId);
    }
  }, BROWSER_FORCE_KILL_AFTER_MS);

  if (entry) {
    entry.stopping = true;
    entry.killTimer = killTimer;
  } else {
    runningProcesses.set(dirId, {
      pid: pids[0], process: null, port: 0, lastActivityAt: Date.now(), killTimer,
    });
  }

  recordAudit({ category: "profile", action: "stop", target: dirId, actor: "user" });
  return true;
}

export function stopBrowser(dirId: string): boolean {
  validateDirId(dirId);
  const entry = runningProcesses.get(dirId);
  if (entry?.stopping) return false;
  const pids: number[] = [];
  if (entry) pids.push(entry.pid);
  const psFound = findBrowserByProfile(dirId);
  if (psFound && !pids.includes(psFound.pid)) pids.push(psFound.pid);
  return beginBrowserStop(dirId, entry, pids);
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but this user cannot signal it.
    return error?.code === "EPERM";
  }
}

function normalizeShutdownWait(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return BROWSER_SHUTDOWN_MAX_WAIT_MS;
  return Math.min(BROWSER_SHUTDOWN_MAX_WAIT_MS, Math.max(0, Math.floor(timeoutMs)));
}

/**
 * Stop every runtime currently owned by this process and wait for the snapshotted
 * PIDs to really disappear. A single shared deadline keeps the wait independent
 * of profile count, while staying alive long enough for stopBrowser's three-
 * second SIGKILL escalation to run.
 */
export async function shutdownAllBrowserProfiles(
  timeoutMs = BROWSER_SHUTDOWN_WAIT_MS,
): Promise<BrowserShutdownReport> {
  const startedAt = Date.now();
  const waitMs = normalizeShutdownWait(timeoutMs);
  const tracked = [...runningProcesses.entries()].map(([dirId, entry]) => ({
    dirId,
    pid: entry.pid,
    entry,
  }));
  const requested = tracked.map(({ dirId, pid }) => ({ dirId, pid }));

  // Reuse the same termination path as stopBrowser, but do not repeat an OS-wide
  // process-table scan for PIDs already pinned in the runtime table.
  for (const target of tracked) {
    const current = runningProcesses.get(target.dirId);
    if (current === target.entry && !current.stopping) {
      try {
        beginBrowserStop(target.dirId, current, [target.pid]);
      } catch (error) {
        // One broken profile must not prevent the remaining known children from
        // receiving their bounded shutdown attempt. PID verification below
        // keeps this failure visible in the unfinished report.
        console.error(`[browser-shutdown] failed to begin stop for ${target.dirId}:`, error);
      }
    }
  }

  const classify = () => {
    const exited: typeof tracked = [];
    const unfinished: typeof tracked = [];
    for (const target of tracked) {
      (isLivePid(target.pid) ? unfinished : exited).push(target);
    }
    for (const target of exited) {
      const current = runningProcesses.get(target.dirId);
      if (current === target.entry) {
        if (current.killTimer) clearTimeout(current.killTimer);
        void current.proxyBridge?.close().catch(() => undefined);
        runningProcesses.delete(target.dirId);
      }
    }
    return { exited, unfinished };
  };

  let state = classify();
  const deadline = startedAt + waitMs;
  while (state.unfinished.length && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(BROWSER_SHUTDOWN_POLL_MS, remaining));
    });
    state = classify();
  }

  const strip = (target: (typeof tracked)[number]): BrowserShutdownTarget => ({
    dirId: target.dirId,
    pid: target.pid,
  });
  return {
    requested,
    exited: state.exited.map(strip),
    unfinished: state.unfinished.map(strip),
    timedOut: state.unfinished.length > 0,
    elapsedMs: Date.now() - startedAt,
  };
}

export function statusBrowser(dirId: string): { running: boolean; pid: number | null; cdpPort: number | null; injectionProbe?: InjectionProbeCheck } {
  validateDirId(dirId);
  const entry = runningProcesses.get(dirId);
  if (entry) {
    try {
      process.kill(entry.pid, 0);
      const status: { running: boolean; pid: number | null; cdpPort: number | null; injectionProbe?: InjectionProbeCheck } = { running: true, pid: entry.pid, cdpPort: entry.port };
      if (entry.injectionProbe) status.injectionProbe = entry.injectionProbe;
      return status;
    } catch {
      void entry.proxyBridge?.close().catch(() => undefined);
      runningProcesses.delete(dirId);
    }
  }
  const psFound = findBrowserByProfile(dirId);
  if (psFound) {
    runningProcesses.set(dirId, { pid: psFound.pid, process: null, port: psFound.cdpPort, lastActivityAt: Date.now() });
    return { running: true, pid: psFound.pid, cdpPort: psFound.cdpPort };
  }
  return { running: false, pid: null, cdpPort: null };
}

export function stopAllBrowserProfiles(): void {
  const ids = [...runningProcesses.keys()];
  for (const dirId of ids) {
    try { stopBrowser(dirId); } catch {}
  }
}

export async function getCdpWebSocketUrl(port: number): Promise<string | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  try {
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (versionResp.ok) {
      const version = await versionResp.json() as { webSocketDebuggerUrl?: string };
      if (typeof version.webSocketDebuggerUrl === "string" && version.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`)) {
        return version.webSocketDebuggerUrl;
      }
    }
  } catch { /* fall back */ }

  try {
    const listResp = await fetch(`http://127.0.0.1:${port}/json`);
    if (!listResp.ok) return null;
    const targets = await listResp.json() as Array<{ webSocketDebuggerUrl?: string }>;
    const target = targets.find((item) => typeof item.webSocketDebuggerUrl === "string" && item.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`));
    return target?.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

export { findBrowserByProfile };
