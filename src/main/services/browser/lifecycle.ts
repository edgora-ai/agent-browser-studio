import * as path from "node:path";
import { runningProcesses, type RunningEntry } from "./runtime-table.js";
import { requestChromiumClose } from "./graceful-close.js";
import { findBrowserByProfileSync, inspectBrowserLaunchesSync } from "../process-discovery.js";
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

const BROWSER_GRACEFUL_CLOSE_MS = 2_500;
const BROWSER_FORCE_KILL_AFTER_MS = 3_000;
const BROWSER_SHUTDOWN_POLL_MS = 25;
// Covers native close, the existing TERM-to-KILL interval, and exit observation.
export const BROWSER_SHUTDOWN_WAIT_MS = 6_000;
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
  const owned: RunningEntry = entry || { pid: pids[0], process: null, port: 0, lastActivityAt: Date.now() };
  const pid = owned.pid;
  const port = owned.port;
  if (!entry) runningProcesses.set(dirId, owned);
  if (owned.killTimer) clearTimeout(owned.killTimer);
  owned.stopping = true;
  console.info("[browser-stop]", JSON.stringify({ event: "requested", dirId, pid, port, engine: owned.engine || "unknown" }));

  const isCurrent = () => runningProcesses.get(dirId) === owned && owned.pid === pid && owned.port === port;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let phase: "graceful" | "signal" | "finished" = "graceful";
  let deadline = Date.now() + BROWSER_GRACEFUL_CLOSE_MS;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    if (owned.killTimer === timer) delete owned.killTimer;
    timer = undefined;
  };
  const releaseExited = (): boolean => {
    if (!isCurrent()) { clearTimer(); phase = "finished"; return true; }
    if (pids.some(isLivePid)) return false;
    clearTimer();
    phase = "finished";
    void owned.proxyBridge?.close().catch((error) => console.error("[browser-stop] proxy bridge cleanup failed:", error));
    runningProcesses.delete(dirId);
    return true;
  };
  const signal = (kind: "SIGTERM" | "SIGKILL") => {
    for (const target of pids) {
      if (!isCurrent() || !isLivePid(target)) continue;
      try {
        process.kill(target, kind);
        console.info("[browser-stop]", JSON.stringify({ event: "signal-sent", dirId, pid: target, signal: kind }));
      }
      catch (error: any) {
        if (error?.code !== "ESRCH") console.error(`[browser-stop] ${kind} failed for ${dirId}:`, error);
      }
    }
  };
  const poll = () => {
    clearTimer();
    if (phase === "finished" || releaseExited()) return;
    if (Date.now() >= deadline) {
      if (phase === "graceful") { fallback("timeout"); return; }
      signal("SIGKILL");
      // A sent signal is not an exit. Keep a still-live runtime owned/stopping;
      // status and awaited shutdown must continue to report it as unfinished.
      releaseExited();
      phase = "finished";
      return;
    }
    timer = setTimeout(poll, Math.min(BROWSER_SHUTDOWN_POLL_MS, deadline - Date.now()));
    owned.killTimer = timer;
  };
  const fallback = (reason: string) => {
    if (phase !== "graceful" || releaseExited()) return;
    clearTimer();
    phase = "signal";
    deadline = Date.now() + BROWSER_FORCE_KILL_AFTER_MS;
    if (owned.engine === "chromium") {
      console.warn(`[browser-stop] native close ${reason}; falling back to signals for ${dirId}, persistence unverified`);
    }
    if (owned.bidiConn) {
      dropFirefoxSession(port);
      try { owned.bidiConn.close(); }
      catch (error) { console.error("[browser-stop] BiDi disconnect failed:", error); }
      delete owned.bidiConn;
    }
    signal("SIGTERM");
    poll();
  };

  if (owned.engine === "chromium" && Number.isInteger(port) && port > 0 && port <= 65535) {
    poll();
    if (isCurrent()) {
      try {
        void requestChromiumClose(port, isCurrent, BROWSER_GRACEFUL_CLOSE_MS).then((result) => {
          console.info("[browser-stop]", JSON.stringify({ event: "native-close-result", dirId, pid, result }));
          if (phase !== "graceful" || releaseExited()) return;
          if (result !== "acknowledged" && result !== "disconnected") fallback(result);
        }, () => fallback("failed"));
      } catch { fallback("failed"); }
    }
  } else {
    fallback("unavailable");
  }

  recordAudit({ category: "profile", action: "stop", target: dirId, actor: "user" });
  // Existing callers consume an accepted boolean, not a completion Promise.
  return true;
}

export function stopBrowser(dirId: string): boolean {
  validateDirId(dirId);
  const entry = runningProcesses.get(dirId);
  if (entry?.stopping) return false;
  // Ownership rule: a stop may only signal processes this app launched and
  // still tracks. Discovery is used solely to describe a residue that is
  // already ours — never to adopt an unrelated process that happens to carry
  // the same --user-data-dir. A second browser sharing the directory belongs
  // to someone else (another app instance, an adopted/foreign launch, or a
  // stale handler), and signalling it would be an unowned kill.
  const pids: number[] = [];
  if (entry) pids.push(entry.pid);
  const psFound = findBrowserByProfile(dirId);
  if (psFound && entry && psFound.pid === entry.pid) {
    // Same PID: discovery only confirms the owned runtime is still alive.
    pids.push(psFound.pid);
  } else if (psFound && !entry && launchProvenanceMatches(dirId, psFound)) {
    // No tracked runtime, but the process carries this profile's fresh-launch
    // stamp: it is a residue of an owned launch (e.g. after a crash), so it may
    // be signalled. The check is narrow and fails closed.
    pids.push(psFound.pid);
  }
  return beginBrowserStop(dirId, entry, pids);
}

/** True only for a process whose argv carries this profile's launch stamp. */
function launchProvenanceMatches(
  dirId: string,
  found: { pid: number; cdpPort: number },
): boolean {
  try {
    const expectedProfileDir = path.resolve(getProfilesDir(), dirId);
    const snapshot = inspectBrowserLaunchesSync(expectedProfileDir, found.pid);
    const tracked = snapshot.tracked;
    if (!tracked || tracked.pid !== found.pid || tracked.engine !== "chromium") return false;
    const hasStamp = tracked.args.some((arg) => arg.startsWith("--agent-browser-launch-stamp="));
    return hasStamp && tracked.profileDirs.includes(expectedProfileDir);
  } catch {
    return false;
  }
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
