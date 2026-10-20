import type { BidiConnection } from "../bidi-client.js";
import type { InjectionProbeCheck } from "../firefox-fingerprint.js";
import type { ChromiumLaunchProvenance } from "./launch-provenance.js";
import type { ProxyConfig, ResolvedProfileProxy } from "../../types.js";

/** Minimal launch evidence, not a current-config lookup or DNS attestation. */
export interface LaunchProxySnapshot {
  mode: "none" | "default" | "named";
  type?: ProxyConfig["type"];
  source: "fresh-launch";
}

/** Capture only the effective route selected by this fresh launch. */
export function captureLaunchProxySnapshot(resolvedProxy: ResolvedProfileProxy): LaunchProxySnapshot {
  return Object.freeze({
    mode: resolvedProxy.mode,
    ...(resolvedProxy.mode !== "none" && resolvedProxy.config ? { type: resolvedProxy.config.type } : {}),
    source: "fresh-launch" as const,
  });
}

export interface RunningEntry {
  pid: number;
  process: any;
  port: number;
  lastActivityAt: number;
  engine?: "chromium" | "firefox";
  /** Version read from the selected binary on this owned fresh launch only. */
  browserVersion?: string | null;
  /** Opaque startup-input hashes only; never credentials or GPU attestation. */
  launchProvenance?: ChromiumLaunchProvenance;
  /** Absent for legacy/adopted processes; never backfilled from current settings. */
  launchProxy?: LaunchProxySnapshot;
  killTimer?: ReturnType<typeof setTimeout>;
  stopping?: boolean;
  proxyBridge?: { close: () => Promise<void> };
  bidiConn?: BidiConnection;
  injectionProbe?: InjectionProbeCheck;
}

export const runningProcesses = new Map<string, RunningEntry>();

export function getEntry(dirId: string): RunningEntry | undefined {
  return runningProcesses.get(dirId);
}

/** A detached, credential-free receipt; missing evidence remains unknown. */
export function getLaunchProxySnapshot(dirId: string): LaunchProxySnapshot | null {
  const snapshot = runningProcesses.get(dirId)?.launchProxy;
  return snapshot ? { mode: snapshot.mode, ...(snapshot.type !== undefined ? { type: snapshot.type } : {}), source: snapshot.source } : null;
}

/** Saved intent, discovery and a page's UA are never selected-binary evidence. */
export function getOwnedBrowserVersion(dirId: string): string | null {
  const entry = runningProcesses.get(dirId), child = entry?.process;
  return entry && !entry.stopping && child && child.pid === entry.pid && child.exitCode === null &&
    child.signalCode === null && child.killed !== true && typeof entry.browserVersion === "string" &&
    /^\d+(?:\.\d+){1,3}$/.test(entry.browserVersion) ? entry.browserVersion : null;
}

export function setEntry(dirId: string, entry: RunningEntry): void {
  runningProcesses.set(dirId, entry);
}

export function clearEntry(dirId: string): void {
  runningProcesses.delete(dirId);
}

export function killTimerOf(entry: RunningEntry): ReturnType<typeof setTimeout> | undefined {
  return entry.killTimer;
}

export function markStopping(entry: RunningEntry, timer: ReturnType<typeof setTimeout>): void {
  entry.stopping = true;
  entry.killTimer = timer;
}

export function clearStopping(entry: RunningEntry): void {
  if (entry.killTimer) clearTimeout(entry.killTimer);
  delete entry.stopping;
  delete entry.killTimer;
}
