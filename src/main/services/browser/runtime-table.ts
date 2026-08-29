import type { BidiConnection } from "../bidi-client.js";
import type { InjectionProbeCheck } from "../firefox-fingerprint.js";

export interface RunningEntry {
  pid: number;
  process: any;
  port: number;
  lastActivityAt: number;
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
