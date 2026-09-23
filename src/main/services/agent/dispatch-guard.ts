import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A per-async-call assertion that runs at the final protocol dispatch point.
 * The callback must throw when the concrete endpoint is no longer authorized.
 */
export type ProtocolDispatchGuard = (actualPort: number) => void;

const dispatchGuardStorage = new AsyncLocalStorage<ProtocolDispatchGuard>();

/** Run an operation with a guard inherited by every async protocol send below it. */
export function runWithProtocolDispatchGuard<T>(
  guard: ProtocolDispatchGuard | undefined,
  operation: () => T,
): T {
  // Do not clear an outer guard merely because a nested legacy helper omitted
  // one. Unscoped top-level callers still have no store and retain old behavior.
  if (!guard) return operation();
  return dispatchGuardStorage.run(guard, operation);
}

/**
 * Capture the current call's guard for callbacks that may later run under a
 * different async context (for example, events emitted by a cached socket).
 */
export function captureProtocolDispatchGuard(): ProtocolDispatchGuard | undefined {
  return dispatchGuardStorage.getStore();
}

/** Assert the active call's authority for the actual wire endpoint, if scoped. */
export function assertProtocolDispatchAllowed(actualPort: number): void {
  captureProtocolDispatchGuard()?.(actualPort);
}

/**
 * Wait without attaching cancellation state to a shared protocol client. Scoped
 * calls poll their captured guard and promptly clear both timers on rejection;
 * legacy calls retain the ordinary one-shot timeout behavior.
 */
export function waitForProtocolDelay(ms: number, actualPort: number): Promise<void> {
  const guard = captureProtocolDispatchGuard();
  if (!guard) return new Promise((resolve) => setTimeout(resolve, ms));
  guard(actualPort);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(guardTimer);
      if (ok) resolve();
      else reject(error);
    };
    const check = () => {
      try {
        guard(actualPort);
        return true;
      } catch (error) {
        finish(false, error);
        return false;
      }
    };
    const timeoutTimer = setTimeout(() => {
      if (check()) finish(true);
    }, ms);
    const guardTimer = setInterval(check, Math.min(25, Math.max(1, ms)));
  });
}
