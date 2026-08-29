import * as path from "node:path";
import { runningProcesses } from "./runtime-table.js";
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

export function stopBrowser(dirId: string): boolean {
  validateDirId(dirId);
  const entry = runningProcesses.get(dirId);
  if (entry && (entry as any).stopping) return false;
  const pids: number[] = [];
  if (entry) pids.push(entry.pid);
  const psFound = findBrowserByProfile(dirId);
  if (psFound && !pids.includes(psFound.pid)) pids.push(psFound.pid);
  if (!pids.length) return false;

  if (entry?.bidiConn) {
    dropFirefoxSession(entry.port);
    try { entry.bidiConn.close(); } catch { /* ignore */ }
  }
  entry && delete (entry as any).bidiConn;

  if (entry?.killTimer) { clearTimeout(entry.killTimer); }

  for (const p of pids) {
    try { process.kill(p, "SIGTERM"); } catch {}
  }
  const killTimer = setTimeout(() => {
    const current = runningProcesses.get(dirId);
    if (current && current.pid === pids[0]) {
      for (const p of pids) {
        try { process.kill(p, "SIGKILL"); } catch {}
      }
      void current.proxyBridge?.close().catch(() => undefined);
      runningProcesses.delete(dirId);
    }
  }, 3000);

  if (entry) {
    (entry as any).stopping = true;
    entry.killTimer = killTimer;
  } else {
    runningProcesses.set(dirId, { pid: pids[0], process: null, port: 0, lastActivityAt: Date.now(), killTimer });
  }

  recordAudit({ category: "profile", action: "stop", target: dirId, actor: "user" });
  return true;
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
