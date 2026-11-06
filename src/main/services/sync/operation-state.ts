import { randomUUID } from "node:crypto";
import type { SyncItemResult, SyncResult } from "../../types.js";
import { emitEvent } from "../event-bus.js";
import { SyncOperationResult } from "./operation-result.js";

export type SyncOperationKind = "push" | "pull";
export type SyncOperationStage = "preparing" | "publishing" | "downloading" | "verifying" | "applying" | "finalizing";
export interface SyncWorkProgress {
  scope?: SyncItemResult["scope"];
  itemId?: string;
  completedItems?: number;
  totalItems?: number;
}
export interface SyncTransferProgress {
  direction: "upload" | "download";
  /** Bytes consumed by the HTTP client/reader, not a remote commit receipt. */
  bytes: number;
  totalBytes?: number;
  startedAt: number;
  state: "transferring" | "waiting-response" | "complete";
}
export interface SyncLocalProgress {
  /** Local work only: these counters never imply a network or snapshot commit. */
  phase: "scanning" | "reading-archive" | "verifying-source" | "verifying-profile" | "verifying-extras" |
    "packing" | "encrypting" | "decrypting" | "extracting";
  bytes: number;
  items: number;
  totalBytes?: number;
  totalItems?: number;
}
export interface ActiveSyncOperation {
  operationId: string;
  kind: SyncOperationKind;
  stage: SyncOperationStage;
  startedAt: number;
  progress: SyncWorkProgress & {
    sequence: number;
    updatedAt: number;
    transfer?: SyncTransferProgress;
    local?: SyncLocalProgress;
  };
}
export interface SyncTransferReporter {
  update: (bytes: number, totalBytes?: number) => void;
  waiting: () => void;
  finish: () => void;
}
export interface SyncProgressReporter {
  stage: (stage: SyncOperationStage, work?: SyncWorkProgress) => void;
  progress: (work: SyncWorkProgress) => void;
  transfer: (direction: "upload" | "download", totalBytes?: number) => SyncTransferReporter;
  /** Own one local phase stream; a later stage/work/transfer invalidates it. */
  local: () => { update: (progress: SyncLocalProgress) => void };
}
const ALL_SCOPES = ["profiles", "accounts", "proxies", "extensions", "sync", "team"];
const PROGRESS_INTERVAL_MS = 100;
let active: ActiveSyncOperation | null = null;
let last: SyncResult | null = null;
let generation = 0;

function resultFacts(result: SyncResult): Record<string, unknown> {
  return { success: result.success, outcome: result.outcome, localCommit: result.localCommit,
    remoteCommit: result.remoteCommit, code: result.code };
}

export function getSyncOperationState(): { generation: number; active: ActiveSyncOperation | null; last: SyncResult | null } {
  return { generation, active: active ? structuredClone(active) : null, last: last ? structuredClone(last) : null };
}

/** One in-process owner across IPC, REST and automation. Conflicts never queue. */
export function beginSyncOperation(kind: SyncOperationKind): (SyncProgressReporter & {
  operation: SyncOperationResult;
  finish: (result: SyncResult) => void;
}) | { busy: SyncResult } {
  if (active) return { busy: { success: false, code: "SYNC_BUSY", message: "Another synchronization operation is still running; wait for its actual result",
    outcome: "failed", localCommit: "none", remoteCommit: "none" } };
  const operation = new SyncOperationResult();
  const startedAt = Date.now();
  active = { operationId: operation.operationId, kind, stage: "preparing", startedAt,
    progress: { sequence: 0, updatedAt: startedAt } };
  let transferOwner = 0;
  let lastProgressAt = 0;
  function owns(): boolean { return active?.operationId === operation.operationId; }
  function publish(force = true): void {
    if (!owns()) return;
    const now = Date.now();
    // Keep the status snapshot current even when a chunk event is throttled.
    active!.progress.sequence++;
    active!.progress.updatedAt = now;
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    emitEvent("sync:progress", { generation, ...structuredClone(active!) });
  }
  function work(info: SyncWorkProgress = {}): void {
    transferOwner++;
    active!.progress = { ...info, sequence: active!.progress.sequence, updatedAt: Date.now() };
  }
  emitEvent("sync:state-changed", { operationId: operation.operationId, generation: ++generation,
    kind, phase: "started", scopes: [...ALL_SCOPES] });
  return {
    operation,
    stage(stage, info) {
      if (!owns()) throw new Error("Sync operation ownership was lost");
      active!.stage = stage;
      work(info ?? { scope: active!.progress.scope, itemId: active!.progress.itemId,
        completedItems: active!.progress.completedItems, totalItems: active!.progress.totalItems });
      publish();
    },
    progress(info) {
      if (!owns()) return;
      work(info);
      publish();
    },
    transfer(direction, totalBytes) {
      if (!owns()) return { update() {}, waiting() {}, finish() {} };
      const owner = ++transferOwner;
      delete active!.progress.local;
      active!.progress.transfer = { direction, bytes: 0, startedAt: Date.now(), state: "transferring",
        ...(Number.isSafeInteger(totalBytes) && totalBytes! >= 0 ? { totalBytes } : {}) };
      publish();
      const current = () => owns() && owner === transferOwner && active!.progress.transfer?.state !== "complete" ? active!.progress.transfer : undefined;
      return {
        update(bytes, totalBytes) {
          const transfer = current();
          if (!transfer || transfer.state !== "transferring" || !Number.isSafeInteger(bytes) || bytes < transfer.bytes) return;
          transfer.bytes = bytes;
          if (transfer.totalBytes !== undefined && bytes > transfer.totalBytes) delete transfer.totalBytes;
          if (Number.isSafeInteger(totalBytes) && totalBytes! >= bytes) transfer.totalBytes = totalBytes;
          publish(false);
        },
        waiting() {
          const transfer = current();
          if (!transfer) return;
          transfer.state = "waiting-response";
          publish();
        },
        finish() {
          const transfer = current();
          if (!transfer) return;
          transfer.state = "complete";
          publish();
        },
      };
    },
    local() {
      if (!owns()) return { update() {} };
      const owner = ++transferOwner;
      delete active!.progress.transfer;
      delete active!.progress.local;
      return {
        update(info) {
          if (!owns() || owner !== transferOwner) return;
          if (!["scanning", "reading-archive", "verifying-source", "verifying-profile", "verifying-extras", "packing", "encrypting", "decrypting", "extracting"].includes(info.phase) ||
            !Number.isSafeInteger(info.bytes) || info.bytes < 0 || !Number.isSafeInteger(info.items) || info.items < 0) return;
          const previous = active!.progress.local;
          const changedPhase = previous?.phase !== info.phase;
          if (!changedPhase && (info.bytes < previous.bytes || info.items < previous.items)) return;
          active!.progress.local = { phase: info.phase, bytes: info.bytes, items: info.items,
            ...(Number.isSafeInteger(info.totalBytes) && info.totalBytes! >= info.bytes ? { totalBytes: info.totalBytes } : {}),
            ...(Number.isSafeInteger(info.totalItems) && info.totalItems! >= info.items ? { totalItems: info.totalItems } : {}) };
          const complete = info.totalBytes !== undefined && info.bytes === info.totalBytes && previous?.bytes !== info.bytes;
          publish(changedPhase || complete);
        },
      };
    },
    finish(result) {
      if (!owns()) throw new Error("Sync operation ownership was lost");
      last = structuredClone(result);
      active = null;
      const scopes = result.localCommit && result.localCommit !== "none"
        ? result.items?.some((item) => item.side !== "remote" && item.scope === "config") ? [...ALL_SCOPES] : ["profiles", "extensions", "sync"]
        : ["sync"];
      emitEvent("sync:state-changed", { operationId: operation.operationId, generation: ++generation,
        kind, phase: "completed", scopes, result: resultFacts(result) });
    },
  };
}

/** Settings change invalidates target-dependent views, not an active owner's lease. */
export function invalidateSyncSettings(): void {
  emitEvent("sync:state-changed", { operationId: randomUUID(), generation: ++generation,
    kind: "configure", phase: "completed", scopes: ["profiles", "accounts", "sync", "team"] });
}
