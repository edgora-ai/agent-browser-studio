import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "health-diagnostics-")),
    evaluate: vi.fn(),
    navigate: vi.fn(async () => undefined),
    status: vi.fn(() => ({ running: true, cdpPort: 42001, pid: 123 })),
    launch: vi.fn(async () => { throw new Error("Unexpected browser launch in a unit test"); }),
    audit: vi.fn(),
    engine: "firefox" as "chromium" | "firefox",
    renameFailure: false,
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (h.renameFailure && String(to) === path.join(h.root, "config.json")) throw Object.assign(new Error("EIO: owned health commit failure"), { code: "EIO" });
    return actual.renameSync(from, to);
  } };
});
vi.mock("electron", () => ({
  app: { getPath: () => h.root },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: h.status, launchBrowser: h.launch }));
vi.mock("../../src/main/services/page-eval.js", () => ({
  evaluateInPage: h.evaluate,
  navigateInPage: h.navigate,
  getProfileEngineByDirId: () => h.engine,
}));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: h.audit }));

import { getConfig, getConfigPath, getWebRtcDiagnostics, reloadConfig, setProfileMeta, setWebRtcDiagnostics, clearWebRtcDiagnostics as clearStoredWebRtcDiagnostics } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import { runWebRtcDiagnostics } from "../../src/main/services/webrtc-diagnostics.js";
import { beginProfileHealthRun, cancelProfileHealthRun, clearProfileHealthHistory, listProfileHealthHistory, recordProfileHealthResult } from "../../src/main/services/profile-health.js";

const ID = "ab_health_diagnostic";
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const probe = (overrides: Record<string, unknown> = {}) => ({
  rtcAvailable: true,
  candidates: ["candidate:1 1 udp 123 synthetic-host.local 9 typ host"],
  mdnsHosts: ["synthetic-host.local"],
  hostIps: [],
  srflxIps: [],
  connectionState: "new",
  gatheringState: "complete",
  rttMs: null,
  error: null,
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  h.renameFailure = false;
  for (const name of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, name), { recursive: true, force: true });
  reloadConfig(); getConfig();
  transact((draft) => {
    draft.browserProfiles[ID] = { name: "Owned health profile", engine: "firefox", fingerprintMode: "off", proxyMode: "none", updatedAt: 1 };
  });
  vi.clearAllMocks();
  h.audit.mockReset(); h.evaluate.mockReset();
  h.engine = "firefox";
  h.status.mockReturnValue({ running: true, cdpPort: 42001, pid: 123 });
  h.evaluate.mockResolvedValue(probe());
});
afterEach(() => { h.renameFailure = false; vi.useRealTimers(); });
afterAll(() => {
  if (path.dirname(h.root) !== os.tmpdir() || !path.basename(h.root).startsWith("health-diagnostics-")) throw new Error("Unsafe health fixture cleanup");
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("actual WebRTC diagnostics cannot turn missing evidence into a green result", () => {
  it.each(["create failed: synthetic failure", "offer failed: synthetic failure", "timeout"])("records %s as an error rather than success", async (error) => {
    h.evaluate.mockResolvedValue(probe({ candidates: [], mdnsHosts: [], gatheringState: "new", error }));
    const result: any = await runWebRtcDiagnostics(ID);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.outcome).toBe("error");
    expect.soft(result.result?.success).toBe(false);
    expect.soft(result.result?.outcome).toBe("error");
    const saved = disk().webrtcDiagnostics[ID].at(-1);
    expect(saved.error).toBe(error);
    expect(saved.success).toBe(false);
    reloadConfig();
    expect(getWebRtcDiagnostics(ID).at(-1)?.error).toBe(error);
  });

  it("does not call disabled or unavailable WebRTC a pass", async () => {
    h.evaluate.mockResolvedValue(probe({ rtcAvailable: false, candidates: [], mdnsHosts: [], gatheringState: "new" }));
    const result: any = await runWebRtcDiagnostics(ID);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.outcome).toBe("unavailable");
    expect.soft(result.result?.success).toBe(false);
    expect(disk().webrtcDiagnostics[ID].at(-1).outcome).toBe("unavailable");
  });

  it("keeps a completed but empty ICE result inconclusive", async () => {
    h.evaluate.mockResolvedValue(probe({ candidates: [], mdnsHosts: [] }));
    const result: any = await runWebRtcDiagnostics(ID);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.outcome).toBe("inconclusive");
    expect(result.result?.success).toBe(false);
  });

  it("requires completion evidence even if an mDNS candidate was observed", async () => {
    h.evaluate.mockResolvedValue(probe({ gatheringState: "gathering" }));
    const result: any = await runWebRtcDiagnostics(ID);
    expect.soft(result.ok).toBe(false);
    expect(result.outcome).toBe("inconclusive");
  });

  it("persists a proven mDNS-only completion and reads it back after reload", async () => {
    const result: any = await runWebRtcDiagnostics(ID);
    expect(result.ok).toBe(true);
    expect.soft(result.outcome).toBe("pass");
    expect.soft(result.result?.gatheringState).toBe("complete");
    expect(h.evaluate).toHaveBeenCalledWith(42001, "firefox", expect.any(String), expect.any(Object));
    const saved = disk().webrtcDiagnostics[ID].at(-1);
    expect(saved.mdnsHosts).toEqual(["synthetic-host.local"]);
    reloadConfig();
    expect(getWebRtcDiagnostics(ID).find((entry) => entry.at === saved.at)).toEqual(saved);
  });

  it("reports observed host addresses as risk, not as a transport failure", async () => {
    h.evaluate.mockResolvedValue(probe({ hostIps: ["192.0.2.16"], mdnsHosts: [] }));
    const result: any = await runWebRtcDiagnostics(ID);
    expect(result.ok).toBe(true);
    expect.soft(result.outcome).toBe("risk");
    expect(disk().webrtcDiagnostics[ID].at(-1).outcome).toBe("risk");
  });

  it("does not evaluate or create history for an unknown profile", async () => {
    const result: any = await runWebRtcDiagnostics("ab_health_missing");
    expect.soft(result.ok).toBe(false);
    expect.soft(result.code).toBe("PROFILE_NOT_FOUND");
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(disk().webrtcDiagnostics?.ab_health_missing).toBeUndefined();
  });

  it("does not commit a late result over an edited profile", async () => {
    const pending = deferred<any>();
    h.evaluate.mockReturnValue(pending.promise);
    const operation = runWebRtcDiagnostics(ID);
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(1));
    setProfileMeta(ID, { timezone: "Asia/Tokyo" });
    pending.resolve(probe());
    const result: any = await operation;
    expect.soft(result.ok).toBe(false);
    expect.soft(result.code).toBe("HEALTH_PROFILE_CHANGED");
    expect(disk().webrtcDiagnostics?.[ID] || []).toEqual([]);
    reloadConfig();
    expect(getWebRtcDiagnostics(ID)).toEqual([]);
  });
});

describe("health ownership, storage and late-result boundaries", () => {
  it("only cancels the matching owner and keeps the lease until the actual probe settles", async () => {
    const pending = deferred<any>(); h.evaluate.mockReturnValue(pending.promise);
    let settled = false;
    const running = runWebRtcDiagnostics(ID, { requestId: "owned-run", owner: "ipc:11" }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(1));
    expect(cancelProfileHealthRun(ID, { kind: "webrtc", requestId: "owned-run", owner: "ipc:12" }).cancelled).toBe(false);
    expect(h.evaluate.mock.calls[0][3].signal.aborted).toBe(false);
    expect(cancelProfileHealthRun(ID, { kind: "webrtc", requestId: "owned-run", owner: "ipc:11" }).cancelled).toBe(true);
    expect(h.evaluate.mock.calls[0][3].signal.aborted).toBe(true);
    expect((await runWebRtcDiagnostics(ID)).code).toBe("HEALTH_BUSY");
    expect(settled).toBe(false);
    pending.resolve(probe());
    expect((await running).outcome).toBe("cancelled");
    expect(disk().webrtcDiagnostics?.[ID] || []).toEqual([]);
    expect((await runWebRtcDiagnostics(ID)).ok).toBe(true);
  });

  it("clears canonical and raw history atomically and prevents a late probe from restoring them", async () => {
    expect((await runWebRtcDiagnostics(ID)).ok).toBe(true);
    expect(listProfileHealthHistory(ID)).toHaveLength(1);
    const pending = deferred<any>(); h.evaluate.mockReturnValue(pending.promise);
    const running = runWebRtcDiagnostics(ID);
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(2));
    clearProfileHealthHistory(ID, "webrtc");
    expect(disk().webrtcDiagnostics?.[ID]).toBeUndefined();
    expect(disk().profileHealthHistory[ID]).toEqual([]);
    pending.resolve(probe());
    expect((await running).outcome).toBe("cancelled");
    reloadConfig();
    expect(getWebRtcDiagnostics(ID)).toEqual([]);
    expect(listProfileHealthHistory(ID)).toEqual([]);
  });

  it("does not cancel another diagnostic kind when clearing environment history", async () => {
    const pending = deferred<any>(); h.evaluate.mockReturnValue(pending.promise);
    const running = runWebRtcDiagnostics(ID);
    clearProfileHealthHistory(ID, "env");
    expect(h.evaluate.mock.calls[0][3].signal.aborted).toBe(false);
    pending.resolve(probe());
    expect((await running).outcome).toBe("pass");
  });

  it("does not publish a result from a different browser process", async () => {
    const pending = deferred<any>(); h.evaluate.mockReturnValue(pending.promise);
    const running = runWebRtcDiagnostics(ID);
    h.status.mockReturnValue({ running: true, cdpPort: 42001, pid: 124 });
    pending.resolve(probe());
    expect((await running).code).toBe("HEALTH_PROFILE_CHANGED");
    expect(getWebRtcDiagnostics(ID)).toEqual([]);
  });

  it("deadline requests cancellation without releasing a pending native operation", async () => {
    vi.useFakeTimers();
    const pending = deferred<any>(); h.evaluate.mockReturnValue(pending.promise);
    const running = runWebRtcDiagnostics(ID, { requestId: "deadline" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.evaluate.mock.calls[0][3].signal.aborted).toBe(true);
    expect((await runWebRtcDiagnostics(ID)).code).toBe("HEALTH_BUSY");
    pending.resolve(probe());
    const result = await running;
    expect(result.code).toBe("HEALTH_TIMEOUT");
    expect(result.outcome).toBe("cancelled");
    expect(listProfileHealthHistory(ID)).toEqual([]);
  });

  it("honors a pre-aborted caller before evaluating and releases its own lease", async () => {
    const controller = new AbortController(); controller.abort();
    expect((await runWebRtcDiagnostics(ID, { signal: controller.signal })).outcome).toBe("cancelled");
    expect(h.evaluate).not.toHaveBeenCalled();
    expect((await runWebRtcDiagnostics(ID)).ok).toBe(true);
  });

  it.each([null, [], { requestId: "not a request id" }, { signal: {} }])("rejects malformed options %j without evaluation", async (options) => {
    const result = await runWebRtcDiagnostics(ID, options as any);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("HEALTH_INVALID_REQUEST");
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it.each([null, {}, { rtcAvailable: true, candidates: [12] }, probe({ candidates: ["not an ICE candidate"] }), probe({ hostIps: [{ bad: true }] })])("does not certify malformed probe data %j", async (raw) => {
    h.evaluate.mockResolvedValue(raw);
    const result = await runWebRtcDiagnostics(ID);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("error");
    expect(disk().webrtcDiagnostics[ID].at(-1).success).toBe(false);
  });

  it("stores transport failure as an error with queryable details", async () => {
    h.evaluate.mockRejectedValue(new Error("synthetic wire failure"));
    const result = await runWebRtcDiagnostics(ID);
    expect(result.ok).toBe(false); expect(result.outcome).toBe("error");
    expect(disk().webrtcDiagnostics[ID].at(-1).error).toBe("synthetic wire failure");
    reloadConfig();
    expect(listProfileHealthHistory(ID).find((entry) => entry.summary.includes("synthetic wire failure"))?.outcome).toBe("error");
  });

  it("never navigates away to make an unavailable diagnostic appear supported", async () => {
    h.evaluate.mockResolvedValue(probe({ rtcAvailable: false }));
    expect((await runWebRtcDiagnostics(ID)).outcome).toBe("unavailable");
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("leaves live and disk histories unchanged when the single health commit fails", async () => {
    const original = fs.readFileSync(getConfigPath());
    h.renameFailure = true;
    const result = await runWebRtcDiagnostics(ID);
    expect(result.ok).toBe(false); expect(result.error).toContain("owned health commit failure");
    expect(fs.readFileSync(getConfigPath())).toEqual(original);
    expect(getWebRtcDiagnostics(ID)).toEqual([]);
    expect(listProfileHealthHistory(ID)).toEqual([]);
    h.renameFailure = false; reloadConfig();
    expect(getWebRtcDiagnostics(ID)).toEqual([]);
    expect(listProfileHealthHistory(ID)).toEqual([]);
  });

  it("keeps legacy raw history readable without modifying disk or promoting missing evidence", () => {
    setWebRtcDiagnostics(ID, [{ at: 1, success: true, rtcAvailable: true, candidates: [], mdnsHosts: [], hostIps: [], srflxIps: [], connectionState: "new", rttMs: null, error: null, summary: "legacy clean claim" }]);
    const original = fs.readFileSync(getConfigPath());
    const entry = listProfileHealthHistory(ID)[0];
    expect(entry.source).toBe("legacy"); expect(entry.outcome).toBe("inconclusive");
    entry.summary = "detached mutation";
    expect(listProfileHealthHistory(ID)[0].summary).toBe("legacy clean claim");
    expect(fs.readFileSync(getConfigPath())).toEqual(original);
  });

  it("caps both histories, preserves unrelated data, and supports read/reload/search", async () => {
    const note = getConfig().browserProfiles[ID].note;
    for (let i = 0; i < 25; i++) expect((await runWebRtcDiagnostics(ID, { requestId: `cap-${i}` })).ok).toBe(true);
    const stored = disk();
    expect(stored.webrtcDiagnostics[ID]).toHaveLength(20);
    expect(stored.profileHealthHistory[ID]).toHaveLength(20);
    expect(stored.browserProfiles[ID].note).toBe(note);
    reloadConfig();
    expect(listProfileHealthHistory(ID).find((entry) => entry.requestId === "cap-24")?.outcome).toBe("pass");
  });

  it("does not turn a legacy summary into a pass and rejects unknown profile writes", () => {
    recordProfileHealthResult(ID, { kind: "env", at: 1, outcome: "pass", source: "legacy", summary: "unverified" });
    expect(disk().profileHealthHistory[ID][0].outcome).toBe("inconclusive");
    expect(() => recordProfileHealthResult("ab_missing_health", { kind: "env", at: 1, outcome: "pass", source: "runtime", summary: "bad" })).toThrow("PROFILE_NOT_FOUND");
  });

  it("bounds concurrent profiles and only releases the owning lease", () => {
    const ids = [ID, "ab_health_two", "ab_health_three", "ab_health_four", "ab_health_five"];
    transact((draft) => { for (const id of ids.slice(1)) draft.browserProfiles[id] = { ...draft.browserProfiles[ID] }; });
    const runs = ids.slice(0, 4).map((id) => beginProfileHealthRun(id, "env"));
    try {
      expect(() => beginProfileHealthRun(ids[4], "env")).toThrow("HEALTH_BUSY");
      runs[0].finish(); runs[0].finish();
      const replacement = beginProfileHealthRun(ID, "env");
      try { runs[0].finish(); replacement.assertCurrent(); } finally { replacement.finish(); }
    } finally { for (const run of runs) run.finish(); }
  });
});

describe("independent review counterexamples", () => {
  it("does not trust an empty hostIps projection over a host address in the actual candidate", async () => {
    h.evaluate.mockResolvedValue(probe({ candidates: ["candidate:1 1 udp 123 192.0.2.16 9 typ host"], mdnsHosts: [], hostIps: [] }));
    const result = await runWebRtcDiagnostics(ID);
    expect(result.outcome).toBe("risk");
    expect(result.result?.hostIps).toContain("192.0.2.16");
    expect(disk().profileHealthHistory[ID].at(-1).outcome).toBe("risk");
  });

  it("does not count a truncated candidate as usable ICE evidence", async () => {
    h.evaluate.mockResolvedValue(probe({ candidates: ["candidate:1 junk typ host"], mdnsHosts: [] }));
    expect((await runWebRtcDiagnostics(ID)).outcome).toBe("error");
  });

  it("retains a local related address exposed by a server-reflexive candidate", async () => {
    h.evaluate.mockResolvedValue(probe({ candidates: ["candidate:1 1 udp 123 203.0.113.7 42001 typ srflx raddr 192.0.2.16 rport 42002"], mdnsHosts: [], hostIps: [] }));
    const result = await runWebRtcDiagnostics(ID);
    expect(result.outcome).toBe("risk");
    expect(result.result?.hostIps).toContain("192.0.2.16");
    expect(result.result?.summary).toContain("192.0.2.16");
  });

  it.each([
    "candidate:1 1 udp NaN synthetic-host.local 9 typ host",
    "candidate:1 1 udp 123 synthetic-host.local 70000 typ host",
    "candidate:1 1 udp 123 synthetic-host.local.invalid 9 typ host",
    "candidate:1 1 tcp 123 synthetic-host.local 9 typ host",
    "candidate:1 1 udp 123 synthetic-host.local 9 typ host dangling",
  ])("does not accept malformed ICE fields: %s", async (candidate) => {
    h.evaluate.mockResolvedValue(probe({ candidates: [candidate], mdnsHosts: [] }));
    expect((await runWebRtcDiagnostics(ID)).outcome).toBe("error");
  });

  it("does not treat an unspecified address as proof of clean usable ICE evidence", async () => {
    h.evaluate.mockResolvedValue(probe({ candidates: ["candidate:1 1 udp 123 0.0.0.0 9 typ host"], mdnsHosts: [] }));
    expect((await runWebRtcDiagnostics(ID)).outcome).toBe("inconclusive");
  });

  it.each(["0.0.0.0", "::"])("keeps a placeholder address in the raw projection inconclusive: %s", async (address) => {
    h.evaluate.mockResolvedValue(probe({ candidates: [`candidate:1 1 udp 123 ${address} 9 typ host`], mdnsHosts: [], hostIps: [address] }));
    const result = await runWebRtcDiagnostics(ID);
    expect(result.outcome).toBe("inconclusive");
    expect(result.result?.success).toBe(false);
    expect(result.result?.hostIps).toEqual([]);
  });

  it("the retained config clear export also invalidates a pending diagnostic", async () => {
    const pending = deferred<any>(); h.evaluate.mockReturnValue(pending.promise);
    const running = runWebRtcDiagnostics(ID);
    clearStoredWebRtcDiagnostics(ID);
    pending.resolve(probe());
    expect((await running).outcome).toBe("cancelled");
    expect(disk().webrtcDiagnostics?.[ID] || []).toEqual([]);
    expect(listProfileHealthHistory(ID)).toEqual([]);
  });
});
