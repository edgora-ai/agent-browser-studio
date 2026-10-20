import { EventEmitter } from "node:events";
import type { exec, execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CloseResult = "acknowledged" | "disconnected" | "unavailable" | "failed" | "timeout" | "stale";
const protocol = vi.hoisted(() => ({
  requestChromiumClose: vi.fn<(
    port: number,
    isCurrent: () => boolean,
    timeoutMs: number,
  ) => Promise<CloseResult>>(),
}));

// String factory intentionally permits the proposed helper to be absent in the
// RED source. No production placeholder or lifecycle implementation is mocked.
vi.mock("../../src/main/services/browser/graceful-close.js", () => ({
  requestChromiumClose: protocol.requestChromiumClose,
}));
// Environment-only fences, matching the existing shutdown tests: do not load
// Electron/user configuration or append an audit file in a control-flow test.
vi.mock("../../src/main/services/config-manager.js", () => ({
  getProfilesDir: () => "/virtual/graceful-stop-unit-profiles",
}));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: vi.fn() }));

import { shutdownAllBrowserProfiles, stopBrowser } from "../../src/main/services/browser/lifecycle.js";
import { runningProcesses, type RunningEntry } from "../../src/main/services/browser/runtime-table.js";
import {
  __resetProcessDiscoveryExecForTest,
  __setProcessDiscoveryExecForTest,
} from "../../src/main/services/process-discovery.js";

const GRACEFUL_MS = 2_500;
const TERM_TO_KILL_MS = 3_000;
const EPOCH = Date.parse("2026-10-18T00:00:00.000Z");
const ID = "graceful-stop-owned-fixture";
const PID = 51_001;
const PORT = 41_001;
const alive = new Set<number>();
const ignoreKill = new Set<number>();
const signals: Array<{ pid: number; signal: NodeJS.Signals | undefined; at: number }> = [];
const asyncExec = vi.fn(() => { throw new Error("Undeclared asynchronous process discovery"); });

type FixtureChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function register(options: { pid?: number; port?: number; engine?: "chromium" | "firefox" } = {}): RunningEntry {
  const pid = options.pid ?? PID;
  const child: FixtureChild = Object.assign(new EventEmitter(), {
    pid, exitCode: null, signalCode: null,
  });
  const entry: RunningEntry = {
    pid,
    process: child,
    port: options.port ?? PORT,
    lastActivityAt: Date.now(),
    engine: options.engine ?? "chromium",
  };
  alive.add(pid);
  runningProcesses.set(ID, entry);
  return entry;
}

function exit(entry: RunningEntry, signal: NodeJS.Signals | null = null): void {
  alive.delete(entry.pid);
  const child = entry.process as FixtureChild;
  child.exitCode = signal ? null : 0;
  child.signalCode = signal;
  child.emit("exit", child.exitCode, signal);
}

function deferredClose() {
  let resolve!: (result: CloseResult) => void;
  const promise = new Promise<CloseResult>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
  alive.clear();
  ignoreKill.clear();
  signals.length = 0;
  runningProcesses.clear();
  asyncExec.mockClear();
  protocol.requestChromiumClose.mockReset();
  protocol.requestChromiumClose.mockResolvedValue("acknowledged");
  // Preserve real discovery/argv parsing, but give its OS-command boundary an
  // empty process table on every host. Neither hook executes a real process.
  __setProcessDiscoveryExecForTest({
    execFileSync: vi.fn(() => "") as unknown as typeof execFileSync,
    exec: asyncExec as unknown as typeof exec,
  });
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (!alive.has(pid)) throw Object.assign(new Error("No such fixture process"), { code: "ESRCH" });
    if (signal === 0) return true;
    if (signal !== "SIGTERM" && signal !== "SIGKILL") {
      throw new Error(`Undeclared fixture signal: ${String(signal)}`);
    }
    signals.push({ pid, signal, at: Date.now() - EPOCH });
    if (signal === "SIGKILL" && !ignoreKill.has(pid)) {
      const entry = [...runningProcesses.values()].find((candidate) => candidate.pid === pid);
      if (entry) exit(entry, "SIGKILL");
      else alive.delete(pid);
    }
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  for (const entry of runningProcesses.values()) {
    if (entry.killTimer) clearTimeout(entry.killTimer);
  }
  runningProcesses.clear();
  vi.clearAllTimers();
  __resetProcessDiscoveryExecForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(asyncExec).not.toHaveBeenCalled();
});

describe("production lifecycle graceful Chromium stop (no process/socket/browser)", () => {
  it("returns an ordinary accepted boolean and requests close before any signal; repeated stop does not resend", async () => {
    const entry = register();
    const close = deferredClose();
    protocol.requestChromiumClose.mockReturnValue(close.promise);

    const accepted = stopBrowser(ID);
    expect(accepted).toBe(true);
    expect(typeof accepted).toBe("boolean");
    expect(entry.stopping).toBe(true);
    expect(stopBrowser(ID)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(protocol.requestChromiumClose).toHaveBeenCalledExactlyOnceWith(PORT, expect.any(Function), GRACEFUL_MS);
    expect(protocol.requestChromiumClose.mock.calls[0][1]()).toBe(true);
    expect(signals).toEqual([]);
    close.resolve("acknowledged");
    await vi.advanceTimersByTimeAsync(0);
    expect(stopBrowser(ID)).toBe(false);
    expect(protocol.requestChromiumClose).toHaveBeenCalledOnce();
  });

  it("observes PID exit after acknowledged close without ever sending TERM or KILL", async () => {
    const entry = register();
    protocol.requestChromiumClose.mockResolvedValue("acknowledged");
    // Schedule the observed exit independently so unchanged RED code also
    // settles; absence of Browser.close must fail an assertion, not hang a test.
    setTimeout(() => exit(entry), 50);
    const pending = shutdownAllBrowserProfiles(1_000);
    await vi.advanceTimersByTimeAsync(100);
    const report = await pending;

    expect(protocol.requestChromiumClose).toHaveBeenCalledExactlyOnceWith(PORT, expect.any(Function), GRACEFUL_MS);
    expect(report).toMatchObject({
      requested: [{ dirId: ID, pid: PID }],
      exited: [{ dirId: ID, pid: PID }],
      unfinished: [], timedOut: false,
    });
    expect(signals).toEqual([]);
    expect(runningProcesses.has(ID)).toBe(false);
    await vi.advanceTimersByTimeAsync(GRACEFUL_MS + TERM_TO_KILL_MS);
    expect(signals).toEqual([]);
  });

  it.each(["acknowledged", "disconnected"] as const)("does not treat %s as completed while the PID is still alive", async (result) => {
    const entry = register();
    protocol.requestChromiumClose.mockResolvedValue(result);
    let settled = false;
    const pending = shutdownAllBrowserProfiles(1_000).then((report) => {
      settled = true;
      return report;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    expect(runningProcesses.get(ID)).toBe(entry);
    expect(signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;

    expect(protocol.requestChromiumClose).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      exited: [], unfinished: [{ dirId: ID, pid: PID }], timedOut: true,
    });
    expect(alive.has(PID)).toBe(true);
    expect(runningProcesses.get(ID)).toBe(entry);
    expect(signals).toEqual([]);
  });

  it("spends one 2500ms graceful budget, then TERM, then KILL only 3000ms after TERM", async () => {
    register();
    protocol.requestChromiumClose.mockImplementation((_port, _isCurrent, timeoutMs) => {
      return new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
    });
    expect(stopBrowser(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(protocol.requestChromiumClose).toHaveBeenCalledExactlyOnceWith(PORT, expect.any(Function), GRACEFUL_MS);
    await vi.advanceTimersByTimeAsync(GRACEFUL_MS - 1);
    expect(signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual([{ pid: PID, signal: "SIGTERM", at: GRACEFUL_MS }]);
    await vi.advanceTimersByTimeAsync(TERM_TO_KILL_MS - 1);
    expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual([
      { pid: PID, signal: "SIGTERM", at: GRACEFUL_MS },
      { pid: PID, signal: "SIGKILL", at: GRACEFUL_MS + TERM_TO_KILL_MS },
    ]);
    await vi.advanceTimersByTimeAsync(50);
    expect(alive.has(PID)).toBe(false);
    expect(runningProcesses.has(ID)).toBe(false);
  });

  it.each(["unavailable", "failed"] as const)("explicitly falls back on protocol %s, retaining the normal TERM-to-KILL interval", async (result) => {
    register();
    protocol.requestChromiumClose.mockResolvedValue(result);
    expect(stopBrowser(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(protocol.requestChromiumClose).toHaveBeenCalledOnce();
    expect(signals).toEqual([{ pid: PID, signal: "SIGTERM", at: 0 }]);
    await vi.advanceTimersByTimeAsync(TERM_TO_KILL_MS - 1);
    expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[1]).toEqual({ pid: PID, signal: "SIGKILL", at: TERM_TO_KILL_MS });
  });

  it.each(["rejected promise", "synchronous throw"] as const)("explicitly falls back on a helper %s without leaking its error or changing the boolean contract", async (failure) => {
    register();
    const error = new Error("controlled browser-close transport failure");
    if (failure === "rejected promise") protocol.requestChromiumClose.mockRejectedValue(error);
    else protocol.requestChromiumClose.mockImplementation(() => { throw error; });

    const accepted = stopBrowser(ID);
    expect(accepted).toBe(true);
    expect(typeof accepted).toBe("boolean");
    await vi.advanceTimersByTimeAsync(0);
    expect(protocol.requestChromiumClose).toHaveBeenCalledOnce();
    expect(signals).toEqual([{ pid: PID, signal: "SIGTERM", at: 0 }]);
  });

  it.each(["different entry, same PID and port", "different entry, same PID and new port", "same entry, changed port"] as const)("pins the complete runtime identity: %s", async (change) => {
    const original = register();
    const close = deferredClose();
    protocol.requestChromiumClose.mockReturnValue(close.promise);
    expect(stopBrowser(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(protocol.requestChromiumClose).toHaveBeenCalledOnce();
    const isCurrent = protocol.requestChromiumClose.mock.calls[0][1];
    expect(isCurrent()).toBe(true);

    let replacement: RunningEntry;
    if (change === "same entry, changed port") {
      original.port = PORT + 1;
      replacement = original;
    } else {
      replacement = register({ port: change === "different entry, same PID and port" ? PORT : PORT + 1 });
    }
    expect(isCurrent()).toBe(false);
    // An ACK raced with replacement. Lifecycle must recheck identity itself,
    // not trust a previously valid protocol callback or PID equality alone.
    close.resolve("acknowledged");
    await vi.advanceTimersByTimeAsync(GRACEFUL_MS + TERM_TO_KILL_MS + 100);
    expect(signals).toEqual([]);
    expect(runningProcesses.get(ID)).toBe(replacement);
    expect(alive.has(PID)).toBe(true);
  });

  it("does not let a stale TERM-to-KILL timer kill or delete a replacement entry with the same PID and port", async () => {
    register();
    protocol.requestChromiumClose.mockResolvedValue("unavailable");
    expect(stopBrowser(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toEqual([{ pid: PID, signal: "SIGTERM", at: 0 }]);
    const replacement = register();
    await vi.advanceTimersByTimeAsync(TERM_TO_KILL_MS + 100);

    expect(signals).toEqual([{ pid: PID, signal: "SIGTERM", at: 0 }]);
    expect(runningProcesses.get(ID)).toBe(replacement);
    expect(alive.has(PID)).toBe(true);
  });

  it("retains a still-live entry after KILL and reports unfinished instead of deleting ownership", async () => {
    const entry = register();
    ignoreKill.add(PID);
    protocol.requestChromiumClose.mockResolvedValue("unavailable");
    expect(stopBrowser(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(TERM_TO_KILL_MS + 100);

    expect(signals.map(({ signal }) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(alive.has(PID)).toBe(true);
    expect(runningProcesses.get(ID)).toBe(entry);
    const pending = shutdownAllBrowserProfiles(100);
    await vi.advanceTimersByTimeAsync(100);
    const report = await pending;
    expect(report).toMatchObject({
      exited: [], unfinished: [{ dirId: ID, pid: PID }], timedOut: true,
    });
    expect(runningProcesses.get(ID)).toBe(entry);
  });

  it("keeps Firefox on its existing BiDi-close and TERM-to-KILL path without requesting Chromium close", async () => {
    const entry = register({ engine: "firefox" });
    const close = vi.fn();
    entry.bidiConn = { close } as unknown as NonNullable<RunningEntry["bidiConn"]>;
    expect(stopBrowser(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(protocol.requestChromiumClose).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(signals).toEqual([{ pid: PID, signal: "SIGTERM", at: 0 }]);
    await vi.advanceTimersByTimeAsync(TERM_TO_KILL_MS);
    expect(signals[1]).toEqual({ pid: PID, signal: "SIGKILL", at: TERM_TO_KILL_MS });
  });

  it("returns ordinary false when neither runtime nor the injected empty process table identifies a target", () => {
    expect(stopBrowser(ID)).toBe(false);
    expect(protocol.requestChromiumClose).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });
});
