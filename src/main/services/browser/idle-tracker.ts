import { runningProcesses } from "./runtime-table.js";
import { getConfig } from "../config-manager.js";
import { sanitizeBrowserEngine } from "../browser-engine.js";
import { recordAudit } from "../audit-log.js";
import { getRegisteredFirefoxSession } from "../bidi-client.js";
import type { BidiConnection } from "../bidi-client.js";
import type { BrowserEngine } from "../../types.js";

let idlePolicyTimeoutMs = 0;

export function setIdlePolicyTimeoutMs(ms: number): void {
  idlePolicyTimeoutMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
}

export function getIdlePolicyTimeoutMs(): number {
  return idlePolicyTimeoutMs;
}

export function touchProfileActivity(dirId: string): void {
  if (typeof dirId !== "string" || !dirId) return;
  const entry = runningProcesses.get(dirId);
  if (entry) entry.lastActivityAt = Date.now();
}

export function touchProfileActivityByPort(port: number): void {
  if (!Number.isInteger(port) || port < 1) return;
  for (const [, entry] of runningProcesses) {
    if (entry.port === port) {
      entry.lastActivityAt = Date.now();
      return;
    }
  }
}

export function getEngineByPort(port: number): BrowserEngine | null {
  if (!Number.isInteger(port) || port < 1) return null;
  for (const [dirId, entry] of runningProcesses) {
    if (entry.port !== port) continue;
    try { process.kill(entry.pid, 0); } catch { continue; }
    const cfg = getConfig() as any;
    return sanitizeBrowserEngine(cfg.browserProfiles?.[dirId]?.engine);
  }
  return null;
}

export function getFirefoxBidiSessionByPort(port: number): BidiConnection | null {
  return getRegisteredFirefoxSession(port);
}

export function getProfileIdleMs(dirId: string): number | null {
  if (typeof dirId !== "string" || !dirId) return null;
  const entry = runningProcesses.get(dirId);
  if (!entry) return null;
  return Math.max(0, Date.now() - entry.lastActivityAt);
}

export function listRunningProfileIdle(): Array<{ dirId: string; pid: number; cdpPort: number; idleMs: number }> {
  const out: Array<{ dirId: string; pid: number; cdpPort: number; idleMs: number }> = [];
  for (const [dirId, entry] of runningProcesses) {
    if (entry.killTimer) continue;
    try { process.kill(entry.pid, 0); } catch { continue; }
    out.push({ dirId, pid: entry.pid, cdpPort: entry.port, idleMs: Math.max(0, Date.now() - entry.lastActivityAt) });
  }
  return out;
}

export function sweepIdleProfiles(
  maxIdleMs: number,
  stopFn: (dirId: string) => boolean,
): string[] {
  if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) return [];
  const stopped: string[] = [];
  for (const [dirId, entry] of runningProcesses) {
    if (entry.killTimer) continue;
    try { process.kill(entry.pid, 0); } catch { continue; }
    if (Date.now() - entry.lastActivityAt >= maxIdleMs) {
      try {
        const ok = stopFn(dirId);
        if (ok) {
          stopped.push(dirId);
          recordAudit({ category: "profile", action: "stop", target: dirId, actor: "auto", detail: "idle timeout" });
        }
      } catch (error) {
        console.error("[agent-browser] idle sweep failed for " + dirId.slice(0, 8) + ":", error);
      }
    }
  }
  return stopped;
}
