import { describe, it, expect, beforeEach } from "vitest";
import { JobGuard, withTimeout, DEFAULT_JOB_GUARD_CONFIG } from "../../src/main/services/job-guard.js";

const CFG = {
  maxRetries: 2,
  cooldownAfterFailures: 3,
  cooldownMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 8_000,
};

describe("JobGuard", () => {
  let g: JobGuard;
  beforeEach(() => {
    g = new JobGuard();
    g.reset();
  });

  it("allows a run when idle", () => {
    expect(g.shouldRun("r1", 1000)).toEqual({ run: true });
  });

  it("blocks re-entry while a run is in progress", () => {
    g.begin("r1", 1000);
    expect(g.shouldRun("r1", 1001)).toEqual({ run: false, reason: "running" });
  });

  it("tryBegin checks and marks running in one synchronous step", () => {
    expect(g.tryBegin("r1", 1000)).toEqual({ run: true });
    expect(g.tryBegin("r1", 1001)).toEqual({ run: false, reason: "running" });
    expect(g.getState("r1").running).toBe(true);
  });

  it("allows again after the run ends (success)", () => {
    g.begin("r1", 1000);
    g.end("r1", true, undefined, 0, CFG, 2000);
    expect(g.shouldRun("r1", 3000)).toEqual({ run: true });
    expect(g.getState("r1").consecutiveFailures).toBe(0);
  });

  it("counts consecutive failures and schedules retries with exponential backoff", () => {
    g.begin("r1", 1000);
    const e1 = g.end("r1", false, "boom", 0, CFG, 2000); // attempt 0
    expect(e1.scheduleRetry).toBe(true);
    expect(e1.retryDelayMs).toBe(1_000); // base * 2^0
    expect(g.getState("r1").consecutiveFailures).toBe(1);

    g.begin("r1", 3000);
    const e2 = g.end("r1", false, "boom", 1, CFG, 4000); // attempt 1
    expect(e2.scheduleRetry).toBe(true);
    expect(e2.retryDelayMs).toBe(2_000); // base * 2^1

    g.begin("r1", 5000);
    const e3 = g.end("r1", false, "boom", 2, CFG, 6000); // attempt 2 — last allowed
    expect(e3.scheduleRetry).toBe(false); // no attempts remaining (maxRetries=2)
  });

  it("caps retry backoff at retryMaxMs", () => {
    const cfg = { ...CFG, maxRetries: 10, retryBaseMs: 1_000, retryMaxMs: 8_000 };
    g.begin("r1", 1000);
    // attempt 5 → 2^5 * 1000 = 32000, must cap to 8000 (retries still remain).
    const e = g.end("r1", false, "x", 5, cfg, 2000);
    expect(e.scheduleRetry).toBe(true);
    expect(e.retryDelayMs).toBe(8_000);
  });

  it("enters cooldown after the configured failure threshold and blocks further runs", () => {
    // 3 consecutive failures → cooldown
    for (let attempt = 0; attempt < 3; attempt++) {
      g.begin("r1", attempt * 1000);
      g.end("r1", false, "boom", attempt, CFG, attempt * 1000 + 500);
    }
    expect(g.getState("r1").consecutiveFailures).toBe(3);
    const cd = g.getState("r1").cooldownUntil;
    expect(cd).toBeGreaterThan(0);
    // While cooling down, shouldRun blocks.
    expect(g.shouldRun("r1", cd - 1)).toEqual({ run: false, reason: "cooldown" });
    // After cooldown expires, it allows again.
    expect(g.shouldRun("r1", cd + 1)).toEqual({ run: true });
  });

  it("does not schedule a retry on the same turn it enters cooldown", () => {
    // 2 prior failures; the 3rd triggers cooldown AND must not retry this turn.
    g.begin("r1", 1000); g.end("r1", false, "x", 0, CFG, 1100);
    g.begin("r1", 2000); g.end("r1", false, "x", 1, CFG, 2100);
    g.begin("r1", 3000);
    const e = g.end("r1", false, "x", 2, CFG, 3100);
    expect(e.enteredCooldown).toBe(true);
    expect(e.scheduleRetry).toBe(false);
  });

  it("resets failure count + cooldown on a success after failures", () => {
    g.begin("r1", 1000); g.end("r1", false, "x", 0, CFG, 1100);
    g.begin("r1", 2000); g.end("r1", false, "x", 1, CFG, 2100);
    expect(g.getState("r1").consecutiveFailures).toBe(2);
    g.begin("r1", 3000);
    g.end("r1", true, undefined, 0, CFG, 3100);
    expect(g.getState("r1").consecutiveFailures).toBe(0);
    expect(g.getState("r1").cooldownUntil).toBe(0);
  });

  it("configFor applies rule overrides over defaults", () => {
    const c = g.configFor({ runTimeoutMs: 60_000, maxRetries: 5 });
    expect(c.runTimeoutMs).toBe(60_000);
    expect(c.maxRetries).toBe(5);
    const c2 = g.configFor({});
    expect(c2.runTimeoutMs).toBe(DEFAULT_JOB_GUARD_CONFIG.runTimeoutMs);
    expect(c2.maxRetries).toBe(DEFAULT_JOB_GUARD_CONFIG.maxRetries);
  });

  it("hydrate seeds persisted state across a 'restart'", () => {
    g.hydrate("r1", { failureCount: 5, lastError: "old", cooldownUntil: 99999 });
    const s = g.getState("r1");
    expect(s.consecutiveFailures).toBe(5);
    expect(s.lastError).toBe("old");
    expect(s.cooldownUntil).toBe(99999);
    // cooldown from hydrated state blocks runs.
    expect(g.shouldRun("r1", 1000)).toEqual({ run: false, reason: "cooldown" });
  });

  it("guards are isolated per rule id", () => {
    g.begin("r1", 1000);
    expect(g.shouldRun("r1", 1001).run).toBe(false);
    expect(g.shouldRun("r2", 1001).run).toBe(true);
  });

  it("cancels without increasing failure count or cooldown", () => {
    g.begin("r1", 1000);
    expect(g.cancel("r1", 1010)).toEqual({ scheduleRetry: false, retryDelayMs: 0, enteredCooldown: false });
    const s = g.getState("r1");
    expect(s.running).toBe(false);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.cooldownUntil).toBe(0);
  });
});

describe("withTimeout", () => {
  it("resolves with the value when the action finishes in time", async () => {
    const v = await withTimeout(async () => 42, 1000);
    expect(v).toBe(42);
  });

  it("rejects with a timeout error even when the action ignores abort", async () => {
    let aborted = false;
    const slow = (signal?: AbortSignal) => new Promise<string>(() => {
      signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    });
    await expect(withTimeout(slow, 30, "job")).rejects.toThrow(/timed out after 30ms/);
    expect(aborted).toBe(true);
  });

  it("passes through the action's own rejection", async () => {
    await expect(withTimeout(async () => { throw new Error("boom"); }, 1000)).rejects.toThrow("boom");
  });

  it("skips the timer when timeoutMs <= 0", async () => {
    const v = await withTimeout(async () => 7, 0);
    expect(v).toBe(7);
  });

  it("fires onTimeout with the still-running loser and suppresses its late rejection", async () => {
    let aborted = false;
    let seenLoser: Promise<string> | null = null;
    const slow = (signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        // Settles AFTER the timeout already rejected — must not surface.
        setTimeout(() => reject(new Error("late zombie failure")), 10);
      }, { once: true });
    });
    await expect(withTimeout(slow, 30, "job", { onTimeout: (loser) => { seenLoser = loser; } }))
      .rejects.toThrow(/timed out after 30ms/);
    expect(aborted).toBe(true);
    expect(seenLoser).not.toBeNull();
    // Give the zombie time to settle; no unhandled rejection may escape.
    await new Promise((r) => setTimeout(r, 50));
  });
});
