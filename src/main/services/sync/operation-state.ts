import { randomUUID } from "node:crypto";
import type { SyncResult } from "../../types.js";
import { emitEvent } from "../event-bus.js";
import { SyncOperationResult } from "./operation-result.js";

export type SyncOperationKind = "push" | "pull";
export type SyncOperationStage = "preparing" | "publishing" | "applying" | "finalizing";
export interface ActiveSyncOperation {
  operationId: string;
  kind: SyncOperationKind;
  stage: SyncOperationStage;
  startedAt: number;
}
const ALL_SCOPES = ["profiles", "accounts", "proxies", "extensions", "sync", "team"];
let active: ActiveSyncOperation | null = null;
let last: SyncResult | null = null;
let generation = 0;

function resultFacts(result: SyncResult): Record<string, unknown> {
  return { success: result.success, outcome: result.outcome, localCommit: result.localCommit,
    remoteCommit: result.remoteCommit, code: result.code };
}

export function getSyncOperationState(): { generation: number; active: ActiveSyncOperation | null; last: SyncResult | null } {
  return { generation, active: active ? { ...active } : null, last: last ? structuredClone(last) : null };
}

/** One in-process owner across IPC, REST and automation. Conflicts never queue. */
export function beginSyncOperation(kind: SyncOperationKind): {
  operation: SyncOperationResult;
  stage: (stage: SyncOperationStage) => void;
  finish: (result: SyncResult) => void;
} | { busy: SyncResult } {
  if (active) return { busy: { success: false, code: "SYNC_BUSY", message: "Another synchronization operation is still running; wait for its actual result",
    outcome: "failed", localCommit: "none", remoteCommit: "none" } };
  const operation = new SyncOperationResult();
  active = { operationId: operation.operationId, kind, stage: "preparing", startedAt: Date.now() };
  emitEvent("sync:state-changed", { operationId: operation.operationId, generation: ++generation,
    kind, phase: "started", scopes: [...ALL_SCOPES] });
  return {
    operation,
    stage(stage) {
      if (active?.operationId !== operation.operationId) throw new Error("Sync operation ownership was lost");
      active.stage = stage;
    },
    finish(result) {
      if (active?.operationId !== operation.operationId) throw new Error("Sync operation ownership was lost");
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
