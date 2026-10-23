import { randomUUID } from "node:crypto";
import type { SyncCommitState, SyncItemResult, SyncRecoveryInfo, SyncResult } from "../../types.js";

/** Retry needs positive proof that this failed attempt committed nothing. */
export function syncMayRetryAutomatically(result: SyncResult): boolean {
  return result.outcome === "failed" && result.localCommit === "none" && result.remoteCommit === "none";
}

/** Facts about this operation, not a second config cache or a rollback promise. */
export class SyncOperationResult {
  readonly operationId = randomUUID();
  readonly items: SyncItemResult[] = [];
  readonly warnings: string[] = [];
  readonly recovery: SyncRecoveryInfo[] = [];
  localCommit: SyncCommitState = "none";
  remoteCommit: SyncCommitState = "none";

  add(item: SyncItemResult): void {
    this.items.push(item);
    if (item.side === "remote") return;
    if (item.state === "applied" || item.state === "queued") {
      if (this.localCommit === "none") this.localCommit = "partial";
    } else if (item.state === "unknown" && item.scope !== "sidecar") {
      this.localCommit = "unknown";
    }
  }

  complete(message: string, transferredBytes?: number): SyncResult {
    const incomplete = this.items.some((item) => item.required !== false &&
      (item.state === "failed" || item.state === "unknown" || item.state === "skipped" || item.scope === "history" && item.state === "preserved"));
    return this.result({ success: !incomplete, message, transferredBytes, outcome: incomplete ? "partial" : "complete" });
  }

  failure(error: unknown, cancelled = false): SyncResult {
    const e = error as any;
    const code = typeof e?.code === "string" ? e.code : cancelled ? "SYNC_CANCELLED" : "SYNC_FAILED";
    if (code === "EXTENSION_REPOSITORY_RECOVERY_REQUIRED" || code === "LOCAL_STORAGE_RECOVERY_REQUIRED" || code === "HISTORY_RECOVERY_REQUIRED" || code === "FULL_PROFILE_RECOVERY_REQUIRED") {
      this.recovery.push({
        resource: code === "FULL_PROFILE_RECOVERY_REQUIRED" ? "profiles" : code === "HISTORY_RECOVERY_REQUIRED" ? "history" : code === "LOCAL_STORAGE_RECOVERY_REQUIRED" ? "localStorage" : "extensions",
        id: e.dirId || e.extensionId || "",
        receiptPath: e.recoveryReceiptPath ?? e.receiptPath,
        paths: Array.isArray(e.recoveryPaths) ? e.recoveryPaths : [],
      });
      if (e.localChanged !== false && this.localCommit === "none") this.localCommit = "partial";
      return this.result({ success: false, code, message: e.message || String(error), outcome: "recovery-required" });
    }
    const changed = this.localCommit !== "none" || this.remoteCommit !== "none";
    return this.result({
      success: false,
      code,
      message: e?.message || String(error),
      outcome: changed ? "partial" : cancelled ? "cancelled" : "failed",
    });
  }

  private result(result: SyncResult): SyncResult {
    return {
      ...result,
      operationId: this.operationId,
      localCommit: this.localCommit,
      remoteCommit: this.remoteCommit,
      items: structuredClone(this.items),
      warnings: [...this.warnings],
      recovery: this.recovery.map((entry) => ({ ...entry, paths: [...entry.paths] })),
    };
  }
}
