import type { SyncTransferReporter } from "./operation-state.js";

const UPLOAD_CHUNK_BYTES = 256 * 1024;

/** Small objects stay buffered; large ones honor fetch backpressure without
 * duplicating the already authenticated payload. Counts are HTTP-client input,
 * never proof of a server commit; the final state waits for its response. */
export function syncUploadBody(body: Buffer, progress?: SyncTransferReporter, signal?: AbortSignal, onBytes?: () => void): RequestInit {
  if ((!progress && !onBytes) || body.length <= UPLOAD_CHUNK_BYTES) return { body: body as any };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(signal.reason ?? new Error("Sync upload cancelled"));
        return;
      }
      if (offset === body.length) {
        controller.close();
        progress?.waiting();
        return;
      }
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, body.length);
      controller.enqueue(body.subarray(offset, end));
      offset = end;
      onBytes?.();
      progress?.update(offset);
    },
  }, { highWaterMark: 0 });
  return { body: stream, duplex: "half" } as RequestInit;
}

/** Independent compatibility sidecars may overlap. Always settle every worker
 * before returning/throwing so no publication outlives the sync owner's lease. */
export async function forEachSyncSidecar<T>(items: readonly T[], action: (item: T, index: number) => Promise<void>, concurrency = 3): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Math.min(3, Number.isSafeInteger(concurrency) ? concurrency : 1))) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { await action(items[index], index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
}

/** Active transfers may outlast the former 30-second wall deadline, but a
 * stalled socket must still stop promptly. Never leave a timer after settle. */
export function syncRequestDeadline(parent?: AbortSignal, idleMs = 60000, totalMs = 30 * 60 * 1000): {
  signal: AbortSignal; touch: () => void; dispose: () => void;
} {
  const timeout = new AbortController();
  const signal = AbortSignal.any([...(parent ? [parent] : []), timeout.signal]);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    signal.removeEventListener("abort", dispose);
  };
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (disposed || signal.aborted) return;
    idleTimer = setTimeout(() => timeout.abort(new Error("Sync transfer stalled: no data for " + Math.round(idleMs / 1000) + " seconds")), idleMs);
    idleTimer.unref?.();
  };
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  else {
    totalTimer = setTimeout(() => timeout.abort(new Error("Sync request exceeded its maximum duration")), totalMs);
    totalTimer.unref?.();
    touch();
  }
  return { signal, touch, dispose };
}
