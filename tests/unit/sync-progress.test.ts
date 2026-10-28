// Node-only proofs of the real operation owner and event producer. No service,
// renderer, native browser, configuration, or remote storage fixture is involved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncResult } from "../../src/main/types.js";
import type { ActiveSyncOperation, SyncOperationKind, SyncTransferReporter } from "../../src/main/services/sync/operation-state.js";

type State = typeof import("../../src/main/services/sync/operation-state.js");
type ProgressEvent = ActiveSyncOperation & { generation: number };
type StateEvent = { operationId: string; generation: number; kind: string; phase: string; scopes: string[]; result?: Record<string, unknown> };
const START = Date.UTC(2026, 0, 1);
let state: State;
let progressEvents: ProgressEvent[];
let stateEvents: StateEvent[];
let unsubscribe: Array<() => void>;

function begin(kind: SyncOperationKind = "push") {
  const owner = state.beginSyncOperation(kind);
  if ("busy" in owner) throw new Error("Unexpected occupied test operation");
  return owner;
}
function lateCallbacks(transfer: SyncTransferReporter) {
  transfer.update(999, 1024);
  transfer.waiting();
  transfer.finish();
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  state = await import("../../src/main/services/sync/operation-state.js");
  const events = await import("../../src/main/services/event-bus.js");
  progressEvents = []; stateEvents = [];
  unsubscribe = [
    events.onEvent("sync:progress", payload => progressEvents.push(payload as unknown as ProgressEvent)),
    events.onEvent("sync:state-changed", payload => stateEvents.push(payload as unknown as StateEvent)),
  ];
});
afterEach(() => {
  for (const off of unsubscribe) off();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("backend synchronization progress ownership", () => {
  it("keeps one owner, does not queue conflicts, and advances generations only at lifecycle boundaries", () => {
    expect(state.getSyncOperationState()).toEqual({ generation: 0, active: null, last: null });
    const owner = begin(), id = owner.operation.operationId;
    expect(state.getSyncOperationState()).toEqual({ generation: 1, last: null, active: {
      operationId: id, kind: "push", stage: "preparing", startedAt: START,
      progress: { sequence: 0, updatedAt: START },
    } });
    expect(stateEvents).toEqual([expect.objectContaining({ operationId: id, generation: 1, kind: "push", phase: "started" })]);
    expect(progressEvents).toEqual([]);
    const beforeConflict = state.getSyncOperationState();
    for (const kind of ["push", "pull"] as const) expect(state.beginSyncOperation(kind)).toMatchObject({ busy: {
      success: false, code: "SYNC_BUSY", outcome: "failed", localCommit: "none", remoteCommit: "none",
    } });
    expect(state.getSyncOperationState()).toEqual(beforeConflict);
    expect(stateEvents).toHaveLength(1);

    owner.stage("publishing"); owner.progress({ completedItems: 1, totalItems: 1 });
    expect(state.getSyncOperationState().generation).toBe(1);
    const result = owner.operation.complete("Synthetic finished operation");
    owner.finish(result);
    expect(state.getSyncOperationState()).toEqual({ generation: 2, active: null, last: result });
    expect(stateEvents[1]).toMatchObject({ operationId: id, generation: 2, phase: "completed" });
    const next = begin("pull");
    expect(next.operation.operationId).not.toBe(id);
    expect(state.getSyncOperationState()).toMatchObject({ generation: 3, last: result, active: { kind: "pull", progress: { sequence: 0 } } });
    next.finish(next.operation.complete("Synthetic next operation"));
    expect(stateEvents.map(event => [event.phase, event.generation])).toEqual([["started", 1], ["completed", 2], ["started", 3], ["completed", 4]]);
  });

  it("throttles only chunk events while status remains current, and immediately emits transfer/stage boundaries", () => {
    const owner = begin();
    owner.stage("publishing", { scope: "profiles", itemId: "synthetic-profile", completedItems: 0, totalItems: 2 });
    vi.setSystemTime(START + 1);
    const transfer = owner.transfer("upload", 1024);
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[1]).toMatchObject({ generation: 1, stage: "publishing", progress: {
      sequence: 2, scope: "profiles", itemId: "synthetic-profile", completedItems: 0, totalItems: 2,
      transfer: { direction: "upload", bytes: 0, totalBytes: 1024, startedAt: START + 1, state: "transferring" },
    } });
    transfer.update(100);
    vi.setSystemTime(START + 100); transfer.update(200);
    expect(progressEvents).toHaveLength(2);
    expect(state.getSyncOperationState().active?.progress).toMatchObject({ sequence: 4, updatedAt: START + 100, transfer: { bytes: 200 } });
    expect(progressEvents[1].progress.transfer?.bytes).toBe(0);

    vi.setSystemTime(START + 101); transfer.update(300);
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents[2].progress).toMatchObject({ sequence: 5, updatedAt: START + 101, transfer: { bytes: 300 } });
    vi.setSystemTime(START + 102); transfer.update(400);
    expect(progressEvents).toHaveLength(3);
    transfer.waiting();
    expect(progressEvents).toHaveLength(4);
    expect(progressEvents[3].progress.transfer).toMatchObject({ bytes: 400, state: "waiting-response" });
    expect(state.getSyncOperationState().last).toBeNull();
    transfer.finish();
    expect(progressEvents).toHaveLength(5);
    expect(progressEvents[4].progress.transfer?.state).toBe("complete");
    owner.stage("finalizing");
    expect(progressEvents).toHaveLength(6);
    expect(progressEvents[5]).toMatchObject({ generation: 1, stage: "finalizing", progress: { sequence: 9, scope: "profiles", itemId: "synthetic-profile" } });
    expect(progressEvents[5].progress).not.toHaveProperty("transfer");
    owner.progress({ scope: "profiles", completedItems: 2, totalItems: 2 });
    expect(progressEvents).toHaveLength(7);
    expect(progressEvents[6].progress).toMatchObject({ sequence: 10, updatedAt: START + 102, completedItems: 2, totalItems: 2 });
    expect(stateEvents).toHaveLength(1);
  });

  it("deep-clones active snapshots, emitted transfer facts, and the incoming and outgoing terminal receipt", () => {
    const owner = begin();
    owner.stage("publishing", { scope: "fullProfile", itemId: "synthetic-profile", completedItems: 1, totalItems: 2 });
    const transfer = owner.transfer("upload", 1024); transfer.update(256);
    const before = state.getSyncOperationState(), detached = state.getSyncOperationState();
    detached.active!.stage = "applying";
    detached.active!.progress.itemId = "poison";
    detached.active!.progress.transfer!.bytes = 999;
    detached.active!.progress.transfer!.totalBytes = 999;
    progressEvents.at(-1)!.progress.transfer!.bytes = 888;
    progressEvents.at(-1)!.progress.itemId = "event poison";
    expect(state.getSyncOperationState()).toEqual(before);
    transfer.update(512); transfer.waiting();
    expect(progressEvents.at(-1)!.progress).toMatchObject({ itemId: "synthetic-profile", transfer: { bytes: 512, totalBytes: 1024 } });
    expect(before.active!.progress.transfer!.bytes).toBe(256);

    const result: SyncResult = { success: false, operationId: owner.operation.operationId, message: "Synthetic receipt", outcome: "recovery-required",
      code: "SYNC_FAILED", localCommit: "partial", remoteCommit: "none",
      items: [{ side: "local", scope: "fullProfile", id: "synthetic-profile", state: "unknown", runtimeEffect: {
        state: "running-or-unconfirmed", action: "running-partial", stopRequired: true, restartRequired: true, queuedCookies: 0, liveCookiesApplied: 0,
      } }], warnings: ["Synthetic warning"], recovery: [{ resource: "profiles", id: "synthetic-profile", paths: ["/synthetic/rescue"], receiptPath: "/synthetic/receipt" }],
    };
    const expected = structuredClone(result);
    owner.finish(result);
    result.items![0].runtimeEffect!.restartRequired = false;
    result.warnings!.push("input poison"); result.recovery![0].paths.length = 0;
    expect(state.getSyncOperationState().last).toEqual(expected);
    const terminal = state.getSyncOperationState();
    terminal.last!.items![0].runtimeEffect!.stopRequired = false;
    terminal.last!.warnings!.length = 0; terminal.last!.recovery![0].paths.push("output poison");
    expect(state.getSyncOperationState().last).toEqual(expected);
    expect(stateEvents.at(-1)!.result).toEqual({ success: false, outcome: "recovery-required", localCommit: "partial", remoteCommit: "none", code: "SYNC_FAILED" });
    expect(stateEvents.at(-1)).not.toHaveProperty("items");
    expect(stateEvents.at(-1)).not.toHaveProperty("recovery");
  });

  it.each(["stage", "work", "replacement-transfer"] as const)("ignores late callbacks after the next %s owns progress", boundary => {
    const owner = begin(), old = owner.transfer("upload", 1024);
    old.update(128);
    if (boundary === "stage") owner.stage("verifying", { scope: "fullProfile", itemId: "next-stage" });
    else if (boundary === "work") owner.progress({ scope: "profiles", itemId: "next-item", completedItems: 1, totalItems: 2 });
    else owner.transfer("download", 2048).update(256);
    const before = state.getSyncOperationState(), emitted = progressEvents.length;
    lateCallbacks(old);
    expect(state.getSyncOperationState()).toEqual(before);
    expect(progressEvents).toHaveLength(emitted);
  });

  it("keeps waiting bytes frozen and transfer completion terminal without implying operation completion", () => {
    const owner = begin(), transfer = owner.transfer("upload", 512);
    transfer.update(512); transfer.waiting();
    const waiting = state.getSyncOperationState(), waitingEvents = progressEvents.length;
    transfer.update(1024, 1024);
    expect(state.getSyncOperationState()).toEqual(waiting);
    expect(progressEvents).toHaveLength(waitingEvents);
    transfer.finish();
    const complete = state.getSyncOperationState(), completeEvents = progressEvents.length;
    expect(complete).toMatchObject({ generation: 1, last: null, active: { progress: { transfer: { bytes: 512, state: "complete" } } } });
    lateCallbacks(transfer);
    expect(state.getSyncOperationState()).toEqual(complete);
    expect(progressEvents).toHaveLength(completeEvents);
    expect(stateEvents).toHaveLength(1);
  });

  it("cannot mutate a completed operation or steal the following owner's progress through stale callbacks", () => {
    const previous = begin(), transfer = previous.transfer("upload", 1024);
    previous.finish(previous.operation.complete("Synthetic completion"));
    const finished = state.getSyncOperationState(), emitted = progressEvents.length;
    lateCallbacks(transfer);
    previous.progress({ itemId: "stale-item" });
    lateCallbacks(previous.transfer("download", 100));
    expect(() => previous.stage("applying")).toThrow(/ownership/i);
    expect(() => previous.finish(previous.operation.complete("Stale receipt"))).toThrow(/ownership/i);
    expect(state.getSyncOperationState()).toEqual(finished);
    expect(progressEvents).toHaveLength(emitted);

    const current = begin("pull");
    current.stage("downloading", { scope: "fullProfile", itemId: "current-item" });
    current.transfer("download", 2048).update(256);
    const currentState = state.getSyncOperationState(), currentEvents = progressEvents.length, lifecycleEvents = stateEvents.length;
    lateCallbacks(transfer); previous.progress({ completedItems: 99 });
    lateCallbacks(previous.transfer("upload", 999));
    expect(() => previous.stage("finalizing")).toThrow(/ownership/i);
    expect(() => previous.finish(previous.operation.complete("Old owner"))).toThrow(/ownership/i);
    expect(state.getSyncOperationState()).toEqual(currentState);
    expect(progressEvents).toHaveLength(currentEvents);
    expect(stateEvents).toHaveLength(lifecycleEvents);
  });

  it("rejects invalid/regressing byte counts and omits unknown or contradicted totals", () => {
    const owner = begin(), transfer = owner.transfer("download", Number.NaN);
    expect(state.getSyncOperationState().active!.progress.transfer).not.toHaveProperty("totalBytes");
    const before = state.getSyncOperationState();
    for (const bytes of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) transfer.update(bytes, 100);
    expect(state.getSyncOperationState()).toEqual(before);
    transfer.update(64, 128);
    expect(state.getSyncOperationState().active!.progress.transfer).toMatchObject({ bytes: 64, totalBytes: 128 });
    const monotone = state.getSyncOperationState();
    transfer.update(63, 1000);
    expect(state.getSyncOperationState()).toEqual(monotone);
    transfer.update(129, 128);
    expect(state.getSyncOperationState().active!.progress.transfer).toMatchObject({ bytes: 129 });
    expect(state.getSyncOperationState().active!.progress.transfer).not.toHaveProperty("totalBytes");
    transfer.update(256, 512);
    expect(state.getSyncOperationState().active!.progress.transfer).toMatchObject({ bytes: 256, totalBytes: 512 });
    for (const total of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(owner.transfer("upload", total)).toBeDefined();
      expect(state.getSyncOperationState().active!.progress.transfer).not.toHaveProperty("totalBytes");
    }
  });

  it("reports local phase counters without transfer speed or implying commit, and throttles chunk notifications", () => {
    const owner = begin();
    owner.stage("preparing", { scope: "fullProfile", itemId: "synthetic-profile", completedItems: 0, totalItems: 2 });
    const transfer = owner.transfer("download", 1024); transfer.finish();
    const local = owner.local();
    local.update({ phase: "scanning", bytes: 0, items: 0 });
    const emitted = progressEvents.length;
    local.update({ phase: "scanning", bytes: 64, items: 1 });
    expect(progressEvents).toHaveLength(emitted);
    expect(state.getSyncOperationState().active?.progress).toMatchObject({ scope: "fullProfile", itemId: "synthetic-profile",
      local: { phase: "scanning", bytes: 64, items: 1 } });
    expect(state.getSyncOperationState().active?.progress).not.toHaveProperty("transfer");
    vi.setSystemTime(START + 101);
    local.update({ phase: "scanning", bytes: 128, items: 2 });
    expect(progressEvents).toHaveLength(emitted + 1);
    local.update({ phase: "reading-archive", bytes: 0, items: 0, totalBytes: 512 });
    expect(progressEvents).toHaveLength(emitted + 2);
    local.update({ phase: "reading-archive", bytes: 512, items: 1, totalBytes: 512 });
    expect(progressEvents).toHaveLength(emitted + 3);
    expect(state.getSyncOperationState()).toMatchObject({ last: null, active: { stage: "preparing" } });
    expect(stateEvents).toHaveLength(1);
    const snapshot = state.getSyncOperationState();
    snapshot.active!.progress.local!.bytes = 900;
    progressEvents.at(-1)!.progress.local!.bytes = 901;
    expect(state.getSyncOperationState().active?.progress.local?.bytes).toBe(512);
  });

  it.each(["stage", "work", "transfer", "local", "finish", "next-operation"] as const)("rejects stale local callbacks after %s", boundary => {
    const owner = begin(), local = owner.local();
    local.update({ phase: "scanning", bytes: 64, items: 1 });
    if (boundary === "stage") owner.stage("publishing");
    else if (boundary === "work") owner.progress({ itemId: "next-profile" });
    else if (boundary === "transfer") owner.transfer("upload", 1024);
    else if (boundary === "local") owner.local().update({ phase: "verifying-profile", bytes: 0, items: 0 });
    else { owner.finish(owner.operation.complete("done")); if (boundary === "next-operation") begin("pull"); }
    const snapshot = state.getSyncOperationState(), emitted = progressEvents.length;
    local.update({ phase: "scanning", bytes: 100, items: 2 });
    expect(state.getSyncOperationState()).toEqual(snapshot);
    expect(progressEvents).toHaveLength(emitted);
  });

  it("rejects invalid or regressing local counters and discards contradicted totals", () => {
    const owner = begin(), transfer = owner.transfer("download", 1024), local = owner.local();
    local.update({ phase: "scanning", bytes: 64, items: 1, totalBytes: 128, totalItems: 2 });
    const snapshot = state.getSyncOperationState();
    lateCallbacks(transfer);
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      local.update({ phase: "scanning", bytes: invalid, items: 1 });
      local.update({ phase: "scanning", bytes: 64, items: invalid });
    }
    local.update({ phase: "scanning", bytes: 63, items: 1 });
    local.update({ phase: "scanning", bytes: 64, items: 0 });
    local.update({ phase: "untrusted-path" as any, bytes: 64, items: 1 });
    expect(state.getSyncOperationState()).toEqual(snapshot);
    local.update({ phase: "scanning", bytes: 129, items: 3, totalBytes: 128, totalItems: 2 });
    expect(state.getSyncOperationState().active?.progress.local).toEqual({ phase: "scanning", bytes: 129, items: 3 });
  });

  it("settings invalidation advances generation without replacing the active owner's lease", () => {
    const owner = begin("pull"), transfer = owner.transfer("download", 1024), operationId = owner.operation.operationId;
    state.invalidateSyncSettings();
    expect(stateEvents.at(-1)).toMatchObject({ kind: "configure", phase: "completed", generation: 2 });
    expect(state.getSyncOperationState()).toMatchObject({ generation: 2, active: { operationId, kind: "pull" } });
    vi.setSystemTime(START + 100); transfer.update(128);
    expect(progressEvents.at(-1)).toMatchObject({ operationId, generation: 2, progress: { transfer: { bytes: 128 } } });
    owner.stage("applying");
    owner.finish(owner.operation.complete("Synthetic settings-safe completion"));
    expect(stateEvents.at(-1)).toMatchObject({ operationId, generation: 3, kind: "pull", phase: "completed" });
  });
});
