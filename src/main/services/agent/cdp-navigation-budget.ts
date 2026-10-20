import { performance } from "node:perf_hooks";
import {
  captureProtocolDispatchGuard, runWithProtocolDispatchGuard, type ProtocolDispatchGuard,
} from "./dispatch-guard.js";

/** One caller-owned deadline, including preparation, commands, delays and post-await checks. */
export class NavigationBudget {
  readonly signal: AbortSignal;
  readonly guard: ProtocolDispatchGuard;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly deadlineTimer: ReturnType<typeof setTimeout>;
  private readonly guardTimer: ReturnType<typeof setInterval>;

  constructor(
    timeoutMs: number,
    private readonly port: number,
    private readonly timeoutError: () => Error,
    extraGuard?: () => void,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error("Invalid browser navigation timeout");
    }
    const captured = captureProtocolDispatchGuard();
    // Monotonic budget: wall-clock corrections must not shorten or fabricate a
    // navigation timeout. setTimeout below remains the backstop.
    this.deadline = performance.now() + timeoutMs;
    this.signal = this.controller.signal;
    this.guard = (actualPort) => {
      if (this.signal.aborted) throw this.signal.reason;
      if (actualPort !== port) throw new Error("Navigation protocol endpoint changed");
      captured?.(actualPort);
      extraGuard?.();
      if (performance.now() >= this.deadline) throw this.timeoutError();
    };
    // Check before allocating timers. Each caller captures its own assertion; a
    // callback emitted under another socket owner's ALS never changes it.
    this.guard(port);
    this.deadlineTimer = setTimeout(() => {
      try { this.check(); this.fail(this.timeoutError()); }
      catch (error) { this.fail(error); }
    }, timeoutMs);
    this.guardTimer = setInterval(() => {
      try { this.check(); } catch (error) { this.fail(error); }
    }, 25);
  }

  check(): void { this.guard(this.port); }

  remaining(): number {
    this.check();
    // Downstream transports validate an integer millisecond budget; performance.now()
    // is fractional, so round up (never below 1) rather than leaking a float.
    return Math.max(1, Math.ceil(this.deadline - performance.now()));
  }

  fail(error: unknown): void {
    if (!this.signal.aborted) this.controller.abort(error);
  }

  /** Races only this call, never closing a shared CDP client or managed BiDi session. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, value: any) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", aborted);
        if (ok) resolve(value); else reject(value);
      };
      const aborted = () => finish(false, this.signal.reason);
      this.signal.addEventListener("abort", aborted, { once: true });
      try {
        const pending = runWithProtocolDispatchGuard(this.guard, operation);
        pending.then((value) => {
          try { this.check(); finish(true, value); }
          catch (error) { finish(false, error); }
        }, (error) => {
          try { this.check(); finish(false, error); }
          catch (guardError) { finish(false, guardError); }
        });
      } catch (error) { finish(false, error); }
    });
  }

  close(): void {
    clearTimeout(this.deadlineTimer);
    clearInterval(this.guardTimer);
  }
}
