import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/main/services/config-manager.js", () => ({
  getProfilesDir: () => "/isolated-test-profiles",
}));
vi.mock("../../src/main/services/process-discovery.js", () => ({
  findBrowserByProfileSync: () => null,
}));
vi.mock("../../src/main/services/bidi-client.js", () => ({
  dropFirefoxSession: vi.fn(),
}));
vi.mock("../../src/main/services/audit-log.js", () => ({
  recordAudit: vi.fn(),
}));

import {
  BROWSER_SHUTDOWN_MAX_WAIT_MS,
  shutdownAllBrowserProfiles,
} from "../../src/main/services/browser/lifecycle.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";

const alive = new Set<number>();
const termExitAfter = new Map<number, number>();
const ignoreKill = new Set<number>();
let killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];

function missingProcess(): NodeJS.ErrnoException {
  return Object.assign(new Error("No such process"), { code: "ESRCH" });
}

function register(dirId: string, pid: number): void {
  alive.add(pid);
  runningProcesses.set(dirId, {
    pid,
    process: null,
    port: 40_000 + (pid % 10_000),
    lastActivityAt: Date.now(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  alive.clear();
  termExitAfter.clear();
  ignoreKill.clear();
  killCalls = [];
  runningProcesses.clear();
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    killCalls.push({ pid, signal: signal as NodeJS.Signals | 0 | undefined });
    if (signal === 0) {
      if (!alive.has(pid)) throw missingProcess();
      return true;
    }
    if (signal === "SIGTERM") {
      const delay = termExitAfter.get(pid);
      if (delay !== undefined) setTimeout(() => alive.delete(pid), delay);
      return true;
    }
    if (signal === "SIGKILL") {
      if (!ignoreKill.has(pid)) alive.delete(pid);
      return true;
    }
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  for (const entry of runningProcesses.values()) {
    if (entry.killTimer) clearTimeout(entry.killTimer);
  }
  runningProcesses.clear();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("awaited managed-browser shutdown", () => {
  it("observes a real exit after SIGTERM and clears the pending escalation", async () => {
    register("profile-term", 41_001);
    termExitAfter.set(41_001, 50);

    const pending = shutdownAllBrowserProfiles(1_000);
    await vi.advanceTimersByTimeAsync(50);
    const report = await pending;

    expect(report).toEqual({
      requested: [{ dirId: "profile-term", pid: 41_001 }],
      exited: [{ dirId: "profile-term", pid: 41_001 }],
      unfinished: [],
      timedOut: false,
      elapsedMs: 50,
    });
    expect(killCalls).toContainEqual({ pid: 41_001, signal: "SIGTERM" });
    expect(killCalls).not.toContainEqual({ pid: 41_001, signal: "SIGKILL" });
    expect(runningProcesses.has("profile-term")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the shared three-second escalation without serial per-profile waits", async () => {
    register("profile-stubborn-a", 42_001);
    register("profile-stubborn-b", 42_002);

    let settled = false;
    const pending = shutdownAllBrowserProfiles(5_000).then((report) => {
      settled = true;
      return report;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    expect(killCalls.filter((call) => call.signal === "SIGKILL")).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;
    expect(report.elapsedMs).toBe(3_000);
    expect(report.timedOut).toBe(false);
    expect(report.unfinished).toEqual([]);
    expect(report.exited).toEqual([
      { dirId: "profile-stubborn-a", pid: 42_001 },
      { dirId: "profile-stubborn-b", pid: 42_002 },
    ]);
    expect(killCalls.filter((call) => call.signal === "SIGKILL")).toEqual([
      { pid: 42_001, signal: "SIGKILL" },
      { pid: 42_002, signal: "SIGKILL" },
    ]);
  });

  it("returns an explicit unfinished report at the caller's deadline", async () => {
    register("profile-timeout", 43_001);
    ignoreKill.add(43_001);

    let settled = false;
    const pending = shutdownAllBrowserProfiles(100).then((report) => {
      settled = true;
      return report;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;

    expect(report).toMatchObject({
      requested: [{ dirId: "profile-timeout", pid: 43_001 }],
      exited: [],
      unfinished: [{ dirId: "profile-timeout", pid: 43_001 }],
      timedOut: true,
      elapsedMs: 100,
    });
    expect(killCalls).toContainEqual({ pid: 43_001, signal: "SIGTERM" });
    expect(killCalls).not.toContainEqual({ pid: 43_001, signal: "SIGKILL" });
  });

  it("caps even an oversized caller deadline", async () => {
    register("profile-hard-cap", 44_001);
    ignoreKill.add(44_001);

    let settled = false;
    const pending = shutdownAllBrowserProfiles(Number.MAX_SAFE_INTEGER).then((report) => {
      settled = true;
      return report;
    });
    await vi.advanceTimersByTimeAsync(BROWSER_SHUTDOWN_MAX_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;

    expect(report.elapsedMs).toBe(BROWSER_SHUTDOWN_MAX_WAIT_MS);
    expect(report.timedOut).toBe(true);
    expect(report.unfinished).toEqual([{ dirId: "profile-hard-cap", pid: 44_001 }]);
    expect(killCalls).toContainEqual({ pid: 44_001, signal: "SIGKILL" });
  });
});
