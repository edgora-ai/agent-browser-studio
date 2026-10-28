import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { syncService } from "../services/sync-service.js";
import { setSyncConfig } from "../services/config-manager.js";
import { requireSettingsMutation } from "../services/team.js";
import { onEvent } from "../services/event-bus.js";
import type { SyncResult, SyncConfig, SyncComparisonToken } from "../types.js";

let unsubscribeSyncEvents: (() => void) | undefined;

// Cancellation is an invocation capability, never a lookup of the globally
// active lease. REST, automation and other renderers cannot be cancelled here.
// Weak keys keep replay protection for the sender lifetime without retaining a
// closed WebContents. Do not auto-abort on navigation/destruction.
interface OwnedSyncRequest {
  controller: AbortController;
  sender: WebContents;
  frame: IpcMainInvokeEvent["senderFrame"];
  requestId: string;
  kind: "push" | "pull";
  operationId?: string;
}
const senderRequests = new WeakMap<WebContents, { used: Set<string>; active: Map<string, OwnedSyncRequest> }>();
const operationRequests = new Map<string, OwnedSyncRequest>();
let invokingRequest: OwnedSyncRequest | undefined;
function attachedSenderFrame(sender: WebContents, frame: IpcMainInvokeEvent["senderFrame"]): boolean {
  // Electron can retain a non-null outgoing frame during unload after navigation.
  // Inaccessible/detached documents lose authority, but do not auto-abort work.
  try { return Boolean(frame && !sender.isDestroyed() && !frame.detached); }
  catch { return false; }
}
function ownedRequestId(operationId: unknown, sender: WebContents, frame: IpcMainInvokeEvent["senderFrame"]): string | undefined {
  const owner = typeof operationId === "string" ? operationRequests.get(operationId) : undefined;
  return attachedSenderFrame(sender, frame) && owner?.sender === sender && owner.frame === frame ? owner.requestId : undefined;
}
function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}
async function runOwnedSync(event: IpcMainInvokeEvent, requestId: unknown, kind: "push" | "pull", invoke: (signal?: AbortSignal) => Promise<SyncResult>): Promise<SyncResult> {
  // Older callers retain their API, but cannot acquire a cancellation capability.
  if (requestId === undefined) return invoke();
  const frame = event.senderFrame;
  if (!validRequestId(requestId) || !attachedSenderFrame(event.sender, frame)) return { success: false, code: "INVALID_SYNC_REQUEST", message: "A valid synchronization request ID and attached sender frame are required" };
  let requests = senderRequests.get(event.sender);
  if (!requests) {
    requests = { used: new Set(), active: new Map() };
    senderRequests.set(event.sender, requests);
  }
  if (requests.used.has(requestId)) return { success: false, code: "SYNC_REQUEST_REUSED", message: "Synchronization request IDs cannot be reused" };
  // Fail closed rather than evict replay protection in an unusually long session.
  if (requests.used.size >= 10000) return { success: false, code: "SYNC_REQUEST_LIMIT", message: "Reopen this window before starting more synchronization requests" };
  requests.used.add(requestId);
  const controller = new AbortController();
  const owner: OwnedSyncRequest = { controller, sender: event.sender, frame, requestId, kind };
  requests.active.set(requestId, owner);
  try {
    // Current service paths acquire their lease synchronously, before any await.
    // Correlate only the actual start emitted on this invocation's call stack;
    // a future asynchronous start must remain unowned rather than be guessed.
    const previous = invokingRequest;
    let pending: Promise<SyncResult>;
    invokingRequest = owner;
    try { pending = invoke(controller.signal); }
    finally { invokingRequest = previous; }
    return await pending;
  } catch (error: any) {
    // Electron strips custom Error properties. Return the service's structured
    // receipt after its finally/rollback settles, including partial/unknown
    // commits; an abort acknowledgement is NOT a cancellation result.
    if (error?.syncResult && typeof error.syncResult.success === "boolean") return error.syncResult;
    throw error;
  } finally {
    requests.active.delete(requestId);
    if (owner.operationId) operationRequests.delete(owner.operationId);
  }
}

export function registerSyncHandlers(): void {
  unsubscribeSyncEvents?.();
  const subscriptions = ["sync:state-changed", "sync:progress"].map((channel) => onEvent(channel, (payload) => {
    if (channel === "sync:state-changed" && payload.phase === "started" && invokingRequest && !invokingRequest.operationId &&
      payload.kind === invokingRequest.kind && typeof payload.operationId === "string") {
      invokingRequest.operationId = payload.operationId;
      operationRequests.set(payload.operationId, invokingRequest);
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        const requestId = ownedRequestId(payload.operationId, window.webContents, window.webContents.mainFrame);
        window.webContents.send(channel, requestId ? { ...payload, requestId } : payload);
      }
      catch (error) { console.warn("[sync] Could not notify a closing renderer:", error); }
    }
  }));
  unsubscribeSyncEvents = () => subscriptions.forEach((unsubscribe) => unsubscribe());

  ipcMain.handle("sync:cancel", (event, opts?: { requestId?: string }) => {
    if (!validRequestId(opts?.requestId)) return { success: false, code: "INVALID_SYNC_REQUEST" };
    const owned = senderRequests.get(event.sender)?.active.get(opts.requestId);
    const frame = event.senderFrame;
    if (!attachedSenderFrame(event.sender, frame) || !owned || owned.frame !== frame) return { success: false, code: "SYNC_CANCEL_NOT_OWNED" };
    owned.controller.abort();
    return { success: true, requestId: opts.requestId, state: "cancelling" };
  });

  ipcMain.handle("sync:push", async (event, opts?: { requestId?: string; force?: boolean; comparisonToken?: SyncComparisonToken; history?: boolean }): Promise<SyncResult> => {
    if (opts?.history !== undefined && typeof opts.history !== "boolean") return { success: false, code: "INVALID_HISTORY_SCOPE", message: "History scope must be a boolean" };
    return runOwnedSync(event, opts?.requestId, "push", (signal) => opts?.history === undefined ? syncService.push(signal, opts?.force === true, opts?.comparisonToken)
      : syncService.push(signal, opts?.force === true, opts?.comparisonToken, { history: opts.history }));
  });

  ipcMain.handle("sync:pull", async (event, opts?: { requestId?: string; strategy?: string; resolutions?: Record<string, string>; comparisonToken?: SyncComparisonToken; history?: boolean; allowRunningPartial?: boolean }): Promise<SyncResult> => {
    if (opts?.history !== undefined && typeof opts.history !== "boolean") return { success: false, code: "INVALID_HISTORY_SCOPE", message: "History scope must be a boolean" };
    if (opts?.allowRunningPartial !== undefined && typeof opts.allowRunningPartial !== "boolean") return { success: false, code: "INVALID_RUNNING_SCOPE", message: "Running-profile partial restore must be explicitly enabled with a boolean" };
    // Omission belongs to the service's selected scope, not the transport.
    const strategy = opts?.strategy === undefined ? undefined
      : opts.strategy === "remote" || opts.strategy === "newest" ? opts.strategy : "local";
    const resolutions: Record<string, "local" | "remote" | "newest"> = {};
    for (const [key, value] of Object.entries(opts?.resolutions || {})) {
      if (value === "local" || value === "remote" || value === "newest") resolutions[key] = value;
    }
    return runOwnedSync(event, opts?.requestId, "pull", (signal) => syncService.pull(signal, { strategy, resolutions, comparisonToken: opts?.comparisonToken, ...(opts?.history === undefined ? {} : { history: opts.history }),
      ...(opts?.allowRunningPartial === undefined ? {} : { allowRunningPartial: opts.allowRunningPartial }) }));
  });

  ipcMain.handle("sync:status", async (event) => {
    const status = await syncService.getStatus();
    const active = status.operation?.active;
    const requestId = ownedRequestId(active?.operationId, event.sender, event.senderFrame);
    return requestId && active ? { ...status, operation: { ...status.operation, active: { ...active, requestId } } } : status;
  });
  ipcMain.handle("sync:history-state", async (_event, dirId: string) => syncService.historyState(dirId));
  ipcMain.handle("sync:preview", async () => syncService.preview());
  ipcMain.handle("sync:preview-diff", async () => syncService.previewDiff());

  ipcMain.handle("sync:configure", async (_event, config: Partial<SyncConfig> & { custodyConsent?: boolean; historyConsent?: boolean; fullProfileConsent?: boolean }): Promise<{ success: boolean; error?: string; code?: string }> => {
    const gate = requireSettingsMutation();
    if (!gate.ok) return { success: false, code: "TEAM_ROLE_DENIED", error: gate.error };
    try {
      setSyncConfig(config);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message, ...(typeof e.code === "string" ? { code: e.code } : {}) };
    }
  });
}
