/**
 * Bounded-concurrency batch runner (review items PL-01 / PL-02).
 *
 * The old batch launch fired one `setTimeout` per profile and reported success
 * without ever looking at an individual result, so 20 of 50 failures still
 * produced "50 profiles started". This runner:
 * - runs at most `concurrency` workers at once (default 4, capped 1..8);
 * - gives every item its own timeout so one hung profile cannot stall the queue;
 * - collects per-item outcomes, so the caller can report an honest tally;
 * - supports cooperative cancellation.
 */
import { newTraceId, recordCounter, recordTiming, log as obsLog } from "./observability.js";

export const DEFAULT_BATCH_CONCURRENCY = 4;
export const MAX_BATCH_CONCURRENCY = 8;
export const DEFAULT_ITEM_TIMEOUT_MS = 20_000;

export interface BatchItemResult<T> {
  item: T;
  index: number;
  ok: boolean;
  error?: string;
  value?: unknown;
}

export interface BatchResult<T> {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: boolean;
  durationMs: number;
  concurrency: number;
  traceId: string;
  results: BatchItemResult<T>[];
}

export interface BatchSignal {
  cancelled: boolean;
  cancel?: (reason?: string) => void;
}

export interface BatchOptions<T> {
  items: T[];
  worker: (item: T, index: number) => Promise<unknown>;
  concurrency?: number;
  timeoutMs?: number;
  signal?: BatchSignal;
  onProgress?: (done: number, total: number, latest: BatchItemResult<T>) => void;
  label?: string;
  /**
   * Join key for renderer→main log correlation (R8 P1-1). The renderer
   * generates the batch jobId and passes it as traceId so both sides log
   * the same id; falls back to a fresh id for direct (non-UI) callers.
   */
  traceId?: string;
}

export function normalizeConcurrency(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BATCH_CONCURRENCY;
  return Math.min(MAX_BATCH_CONCURRENCY, Math.max(1, Math.floor(n)));
}

function withItemTimeout<T>(promise: Promise<T>, ms: number, index: number): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`Timed out after ${Math.round(ms / 1000)}s`);
      (err as Error & { code?: string }).code = "BATCH_ITEM_TIMEOUT";
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Run `worker` over `items` with bounded concurrency.
 * Never rejects: per-item failures are reported in the result tally.
 */
export async function runBatch<T>(opts: BatchOptions<T>): Promise<BatchResult<T>> {
  const items = Array.isArray(opts.items) ? opts.items : [];
  const concurrency = normalizeConcurrency(opts.concurrency);
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : DEFAULT_ITEM_TIMEOUT_MS;
  const signal = opts.signal;
  const label = opts.label || "batch";
  // R8 P1-1: prefer the caller-supplied join key so renderer logs and
  // main-process logs share one id for the same batch.
  const traceId = typeof opts.traceId === "string" && opts.traceId ? opts.traceId : newTraceId();
  const startedAt = Date.now();

  const results: BatchItemResult<T>[] = new Array(items.length);
  let cursor = 0;
  let done = 0;
  let cancelled = Boolean(signal?.cancelled);

  async function runner(): Promise<void> {
    for (;;) {
      if (signal?.cancelled) {
        cancelled = true;
        return;
      }
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        const value = await withItemTimeout(Promise.resolve().then(() => opts.worker(item, index)), timeoutMs, index);
        results[index] = { item, index, ok: true, value };
      } catch (error: any) {
        results[index] = { item, index, ok: false, error: error?.message || String(error) };
      }
      done++;
      try {
        opts.onProgress?.(done, items.length, results[index]);
      } catch {
        /* progress callbacks must never break the queue */
      }
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runner()));

  // Items that were never started because the batch was cancelled.
  for (let i = 0; i < items.length; i++) {
    if (!results[i]) {
      results[i] = { item: items[i], index: i, ok: false, error: cancelled ? "Cancelled" : "Not started" };
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const durationMs = Date.now() - startedAt;

  recordTiming(`batch.${label}`, durationMs);
  recordCounter(`batch.${label}.items`, results.length);
  recordCounter(`batch.${label}.succeeded`, succeeded);
  recordCounter(`batch.${label}.failed`, failed);
  obsLog("info", `batch.${label}.finished`, {
    traceId,
    total: results.length,
    succeeded,
    failed,
    cancelled,
    concurrency,
    durationMs,
  });

  return { total: results.length, succeeded, failed, cancelled, durationMs, concurrency, traceId, results };
}
