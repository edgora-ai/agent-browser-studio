// JobGuard — per-rule execution hardening: re-entry lock, wall-clock timeout,
// consecutive-failure counting, cooldown, and retry-with-backoff. Pure logic,
// no Electron dependencies → fully unit-testable. automation.ts wires a
// singleton into runRule so every rule gets hardened by default.
//
// Design:
//   - shouldRun(): decide BEFORE running — skip if already running or cooling
//     down. Returns the skip reason so the caller can log it.
//   - begin()/end(): bracket a run. end() computes whether a retry should be
//     scheduled and at what delay.
//   - All time is injected (now: number) so tests are deterministic.

export interface JobGuardConfig {
  runTimeoutMs: number;          // default per-run timeout
  maxRetries: number;            // default auto-retry count
  cooldownAfterFailures: number; // consecutive failures before cooldown
  cooldownMs: number;            // cooldown duration
  retryBaseMs: number;           // base delay for exponential backoff
  retryMaxMs: number;            // backoff cap
}

export const DEFAULT_JOB_GUARD_CONFIG: JobGuardConfig = {
  runTimeoutMs: 5 * 60 * 1000,   // 5 min
  maxRetries: 0,                  // safe default: don't auto-retry side-effecting actions
  cooldownAfterFailures: 3,
  cooldownMs: 10 * 60 * 1000,    // 10 min
  retryBaseMs: 30 * 1000,        // 30s, 60s, 120s...
  retryMaxMs: 10 * 60 * 1000,
};

export interface JobState {
  running: boolean;
  consecutiveFailures: number;
  cooldownUntil: number;         // epoch ms; 0 = no cooldown
  lastError?: string;
  lastRunAt?: number;
}

export type SkipReason = "running" | "cooldown";

export interface ShouldRunResult {
  run: boolean;
  reason?: SkipReason;
}

export interface EndResult {
  /** Whether the caller should schedule a retry. */
  scheduleRetry: boolean;
  retryDelayMs: number;
  /** Whether a cooldown is now active (just entered cooldown). */
  enteredCooldown: boolean;
}

/**
 * Per-rule guard. One instance shared across the app; keyed by ruleId so the
 * guard works correctly even if rule objects are reloaded from config.
 */
export class JobGuard {
  private states = new Map<string, JobState>();
  constructor(private config: JobGuardConfig = DEFAULT_JOB_GUARD_CONFIG) {}

  /** Effective config for a rule (rule overrides win, else defaults). */
  configFor(rule: { runTimeoutMs?: number; maxRetries?: number }): { runTimeoutMs: number; maxRetries: number } {
    return {
      runTimeoutMs: rule.runTimeoutMs ?? this.config.runTimeoutMs,
      maxRetries: rule.maxRetries ?? this.config.maxRetries,
    };
  }

  private get(ruleId: string): JobState {
    let s = this.states.get(ruleId);
    if (!s) {
      s = { running: false, consecutiveFailures: 0, cooldownUntil: 0 };
      this.states.set(ruleId, s);
    }
    return s;
  }

  getState(ruleId: string): Readonly<JobState> {
    return { ...this.get(ruleId) };
  }

  /** Pre-seed state from persisted config (called on scheduler reload). */
  hydrate(ruleId: string, persisted: { failureCount?: number; lastError?: string; cooldownUntil?: number } | undefined): void {
    if (!persisted) return;
    const s = this.get(ruleId);
    if (typeof persisted.failureCount === "number") s.consecutiveFailures = persisted.failureCount;
    if (typeof persisted.lastError === "string") s.lastError = persisted.lastError;
    if (typeof persisted.cooldownUntil === "number") s.cooldownUntil = persisted.cooldownUntil;
  }

  shouldRun(ruleId: string, now: number): ShouldRunResult {
    const s = this.get(ruleId);
    if (s.running) return { run: false, reason: "running" };
    if (s.cooldownUntil && now < s.cooldownUntil) return { run: false, reason: "cooldown" };
    return { run: true };
  }

  begin(ruleId: string, now: number): void {
    const s = this.get(ruleId);
    s.running = true;
    s.lastRunAt = now;
  }

  /** Atomically check and mark a rule running so callers cannot race between shouldRun() and begin(). */
  tryBegin(ruleId: string, now: number): ShouldRunResult {
    const decision = this.shouldRun(ruleId, now);
    if (!decision.run) return decision;
    this.begin(ruleId, now);
    return { run: true };
  }

  /** Mark a run cancelled without changing failure/cooldown counters. */
  cancel(ruleId: string, now: number): EndResult {
    const s = this.get(ruleId);
    s.running = false;
    s.lastRunAt = now;
    return { scheduleRetry: false, retryDelayMs: 0, enteredCooldown: false };
  }

  /** Mark a run finished. Returns retry + cooldown guidance. */
  end(
    ruleId: string,
    ok: boolean,
    error: string | undefined,
    attempt: number,
    cfg: { maxRetries: number; cooldownAfterFailures: number; cooldownMs: number; retryBaseMs: number; retryMaxMs: number },
    now: number,
  ): EndResult {
    const s = this.get(ruleId);
    s.running = false;
    s.lastRunAt = now;
    if (ok) {
      s.consecutiveFailures = 0;
      s.cooldownUntil = 0;
      s.lastError = undefined;
      return { scheduleRetry: false, retryDelayMs: 0, enteredCooldown: false };
    }
    s.lastError = error;
    s.consecutiveFailures += 1;
    // Cooldown once we cross the threshold.
    let enteredCooldown = false;
    if (s.consecutiveFailures >= cfg.cooldownAfterFailures) {
      s.cooldownUntil = now + cfg.cooldownMs;
      enteredCooldown = true;
    }
    // Retry only if attempts remain AND we're not entering cooldown this turn.
    const attemptsRemaining = cfg.maxRetries - attempt; // attempt is 0-indexed
    const scheduleRetry = attemptsRemaining > 0 && !enteredCooldown;
    const retryDelayMs = scheduleRetry
      ? Math.min(cfg.retryBaseMs * 2 ** attempt, cfg.retryMaxMs)
      : 0;
    return { scheduleRetry, retryDelayMs, enteredCooldown };
  }

  /** Force-clear a rule's state (used on delete / disable / test). */
  clear(ruleId: string): void {
    this.states.delete(ruleId);
  }

  /** Reset all (used in tests). */
  reset(): void {
    this.states.clear();
  }
}

/**
 * Race an async action against a timeout. Rejects with a timeout error on
 * expiry. The loser is NOT left to run unattended: on timeout we abort the
 * action's signal AND keep the returned promise tracked — callers must pass an
 * `onTimeout` hook (used by automation to mark the job cancelled so a retry
 * never fires while the zombie is still active) or await settlement.
 */
export async function withTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label = "job",
  opts?: { onTimeout?: (loser: Promise<T>) => void },
): Promise<T> {
  if (!(timeoutMs > 0)) return fn();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let loser: Promise<T> | null = null;
  try {
    const raced = new Promise<T>((resolve, reject) => {
      loser = fn(controller.signal).then(resolve, reject) as Promise<T>;
      timer = setTimeout(() => {
        controller.abort();
        try { opts?.onTimeout?.(loser as Promise<T>); } catch { /* never break the timeout path */ }
        // Attach a no-op catch so the still-running loser cannot surface as an
        // unhandled rejection when it settles after we've already rejected.
        (loser as Promise<T>).then(() => {}, () => {});
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return await raced;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
