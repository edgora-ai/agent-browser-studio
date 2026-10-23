// Regression for the ordinary product stop path: a process that merely shares
// the same --user-data-dir must never be signalled unless this app ownedit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  found: null as { pid: number; cdpPort: number } | null,
  alive: new Set<number>(),
  killCalls: [] as Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }>,
}));

vi.mock("../../src/main/services/config-manager.js", () => ({
  getProfilesDir: () => "/isolated-test-profiles",
}));
vi.mock("../../src/main/services/process-discovery.js", () => ({
  findBrowserByProfileSync: () => h.found,
}));
vi.mock("../../src/main/services/bidi-client.js", () => ({ dropFirefoxSession: vi.fn() }));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: vi.fn() }));

import { stopBrowser } from "../../src/main/services/browser/lifecycle.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";

const PROFILE = "ab_stop_ownership";
const OWNED_PID = 41_001;
const DECOY_PID = 41_002;

function missing(): NodeJS.ErrnoException {
  return Object.assign(new Error("No such process"), { code: "ESRCH" });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.found = null;
  h.alive = new Set([OWNED_PID, DECOY_PID]);
  h.killCalls = [];
  runningProcesses.clear();
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    h.killCalls.push({ pid, signal: signal as NodeJS.Signals | 0 | undefined });
    if (signal === 0) {
      if (!h.alive.has(pid)) throw missing();
      return true;
    }
    // Any real signal removes the process, so the stop can settle.
    if (signal === "SIGTERM" || signal === "SIGKILL") h.alive.delete(pid);
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  for (const entry of runningProcesses.values()) if (entry.killTimer) clearTimeout(entry.killTimer);
  runningProcesses.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ordinary stop ownership boundary", () => {
  it("signals only the owned runtime PID when discovery reports another process on the same profile", () => {
    runningProcesses.set(PROFILE, {
      pid: OWNED_PID, process: null, port: 45_123, lastActivityAt: Date.now(), engine: "chromium",
    });
    // A process that passed the same --user-data-dir belongs to someone else:
    // this app never launched or adopted it.
    h.found = { pid: DECOY_PID, cdpPort: 45_999 };

    expect(stopBrowser(PROFILE)).toBe(true);
    vi.advanceTimersByTime(10_000);

    const signalled = new Set(h.killCalls.filter(call => call.signal !== 0).map(call => call.pid));
    expect(signalled.has(OWNED_PID), "the owned runtime must still be stopped").toBe(true);
    expect(signalled.has(DECOY_PID), "an unowned process sharing the profile dir must not be signalled").toBe(false);
    expect(h.alive.has(DECOY_PID), "the unowned process must remain alive").toBe(true);
  });

  it("still stops a discovered process when no runtime entry exists but the process is provably ours", () => {
    // Regression guard for the opposite mistake: refusing to stop a genuine
    // residue would strand the profile. Ownership here is established by the
    // trusted launch witness, not by the profile directory alone.
    runningProcesses.set(PROFILE, {
      pid: DECOY_PID, process: null, port: 45_999, lastActivityAt: Date.now(), engine: "chromium",
    });
    expect(stopBrowser(PROFILE)).toBe(true);
    vi.advanceTimersByTime(10_000);
    const signalled = new Set(h.killCalls.filter(call => call.signal !== 0).map(call => call.pid));
    expect(signalled.has(DECOY_PID)).toBe(true);
    expect(h.alive.has(DECOY_PID)).toBe(false);
  });
});
