import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "ipc-health-"));
  const forbidden = vi.fn((...args: unknown[]) => { throw new Error(`Undeclared native capability: ${String(args[0])}`); });
  const state = { snapshot: {} as Record<string, unknown>, evaluate: undefined as undefined | (() => any), sockets: [] as any[], commands: [] as { url: string; method: string }[], error: "", renameFailAt: 0, renameCalls: 0, renameObserver: undefined as undefined | (() => void), auditWriteFail: false, auditRefusals: 0 };
  class Socket extends EventEmitter {
    closed = false;
    constructor(readonly url: string) {
      super();
      if (url !== "ws://127.0.0.1:45671/devtools/page/ipc-fixture" && url !== "ws://127.0.0.1:45671/session") throw new Error(`Unexpected WebSocket: ${url}`);
      state.sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      state.commands.push({ url: this.url, method: request.method });
      let result: Promise<unknown>;
      if (request.method === "Runtime.evaluate" || request.method === "script.evaluate") {
        result = Promise.resolve(state.evaluate ? state.evaluate() : state.snapshot).then((value) => request.method === "script.evaluate"
          ? { type: "success", realm: "ipc-fixture-realm", result: { type: "string", value: JSON.stringify(value) } }
          : { result: { value: request.params.expression.includes("rtcAvailable") ? value : JSON.stringify(value) } });
      } else if (request.method === "session.new") result = Promise.resolve({ sessionId: "ipc-fixture-session", capabilities: {} });
      else if (request.method === "browsingContext.getTree") result = Promise.resolve({ contexts: [{ context: "ipc-fixture", url: "about:blank", children: [] }] });
      else result = Promise.resolve({});
      result.then((value) => queueMicrotask(() => this.emit("message", JSON.stringify({ id: request.id,
        ...(state.error ? { error: { message: state.error } } : { result: value }) }))));
    }
    close() { this.closed = true; this.emit("close"); }
  }
  return { root, handlers: new Map<string, (...args: any[]) => any>(), forbidden, state, Socket };
});
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: any) => {
    if (h.handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
    h.handlers.set(channel, handler);
  } },
  app: { getPath: (name: string) => {
    if (name === "userData" || name === "home") return h.root;
    throw new Error(`Undeclared Electron path: ${name}`);
  } },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  screen: { getPrimaryDisplay: h.forbidden }, dialog: { showOpenDialog: h.forbidden },
}));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(),
  exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden, execFileSync: h.forbidden, spawn: h.forbidden, spawnSync: h.forbidden,
}));
vi.mock("ws", () => ({ default: h.Socket, WebSocket: h.Socket }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const renameSync = (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === path.join(h.root, "config.json")) h.state.renameObserver?.();
    if (String(destination) === path.join(h.root, "config.json") && h.state.renameFailAt && ++h.state.renameCalls === h.state.renameFailAt) {
      throw Object.assign(new Error("fixture history commit refused"), { code: "EACCES" });
    }
    return actual.renameSync(source, destination);
  };
  const appendFileSync: typeof actual.appendFileSync = (file, data, options) => {
    if (String(file) === path.join(h.root, "audit.log.jsonl") && h.state.auditWriteFail) {
      h.state.auditRefusals++;
      throw Object.assign(new Error("fixture audit append refused"), { code: "EACCES" });
    }
    return actual.appendFileSync(file, data, options);
  };
  return { ...actual, renameSync, appendFileSync, default: { ...actual, renameSync, appendFileSync } };
});

import { registerBrowserHandlers } from "../../src/main/ipc/browser.js";
import { registerWebRtcHandlers } from "../../src/main/ipc/webrtc.js";
import { getConfig, getConfigPath, getProfileMeta, getProfilesDir, reloadConfig, saveConfig, setProfileMeta } from "../../src/main/services/config-manager.js";
import * as browserManager from "../../src/main/services/browser-manager.js";
import * as fingerprintBaseline from "../../src/main/services/fingerprint-baseline.js";
import * as fingerprintReports from "../../src/main/services/fingerprint-drift-reports.js";
import { getProfileDataRevision, markProfileDataChanging } from "../../src/main/services/profile-data-revision.js";
import { LaunchBlockedError, type LaunchDriftCheck } from "../../src/main/services/browser/launch-guards.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";
import { beginProfileHealthRun, recordProfileHealthResult } from "../../src/main/services/profile-health.js";
import { _setAuditPathForTesting, listAudit, recordAudit } from "../../src/main/services/audit-log.js";
import { __resetProcessDiscoveryExecForTest, __setProcessDiscoveryExecForTest } from "../../src/main/services/process-discovery.js";
import { acquireRestoreLock, isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";
registerBrowserHandlers();
registerWebRtcHandlers();
const PROFILE = "ab_ipc_health";
const BASELINE = { platform: "MacIntel", userAgent: "Fixture Browser", plugins: "PDF Viewer", tz: "Europe/London", canvasHash: "old" };
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const owner = Object.assign(new EventEmitter(), { id: 47, isDestroyed: () => false });
const invoke = (payload: unknown, sender: any = owner) => h.handlers.get("browser:capture-baseline")!({ sender }, payload);
const capture = (options?: { confirmationToken?: string; reportId?: string }, sender: any = owner) => invoke(options ? { dirId: PROFILE, ...options } : PROFILE, sender);
const driftReport = (sender: any = owner) => h.handlers.get("browser:drift-report")!({ sender }, PROFILE);
const reportPath = () => path.join(h.root, "fingerprint-comparisons.json");
const reportDisk = () => JSON.parse(fs.readFileSync(reportPath(), "utf8"));
// Trusted authority must originate in the actual main-process observation API;
// writing equivalent JSON reports alone never creates an acceptance capability.
function saveComparison(current: fingerprintBaseline.Fingerprint = { ...BASELINE, canvasHash: "new" }, observedAt = Date.now()) {
  const meta = structuredClone(getConfig().browserProfiles[PROFILE]);
  const observation = fingerprintReports.beginFingerprintObservation(PROFILE, meta);
  const persona = fingerprintBaseline.mismatchesAsDrift(fingerprintBaseline.checkPersonaConsistency({ platform: meta.platform || "windows", timezone: meta.timezone }, current));
  const analysis = fingerprintBaseline.analyzeFingerprintDrift(meta.fingerprintBaseline, current, [...fingerprintBaseline.diffFingerprints(meta.fingerprintBaseline, current), ...persona]);
  const report = fingerprintReports.saveFingerprintComparison(observation, { dirId: PROFILE, meta, current, analysis, observedAt, source: "launch" });
  expect(report).toMatchObject({ saved: true, id: expect.any(String), observedAt });
  const stored = reportDisk().reports.find((entry: any) => entry.report.id === report.id);
  expect(stored).toMatchObject({ witness: fingerprintReports.fingerprintProfileWitness(meta), dataRevision: getProfileDataRevision(PROFILE), report: { id: report.id, observedAt, source: "launch" } });
  return { report, current, analysis, stored };
}
const reset = (options?: { confirmationToken?: string }, sender: any = owner) => h.handlers.get("browser:reset-baseline")!({ sender }, options ? { dirId: PROFILE, ...options } : PROFILE);
// Discovery succeeds with an explicitly empty synthetic table. The native
// fence remains armed: swallowed ps/spawn errors must never imply "stopped".
const discoverySync = vi.fn((command: string) => command === "powershell.exe" ? "[]" : "");
const discoveryAsync = vi.fn((_command: string, _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
  callback(null, "", "");
  return {} as any;
});
beforeEach(() => {
  discoverySync.mockClear(); discoveryAsync.mockClear();
  __setProcessDiscoveryExecForTest({ execFileSync: discoverySync as any, exec: discoveryAsync as any });
  _setAuditPathForTesting(path.join(h.root, "audit.log.jsonl"));
  h.state.renameFailAt = 0; h.state.renameCalls = 0; h.state.renameObserver = undefined; h.state.auditWriteFail = false; h.state.auditRefusals = 0;
  fs.rmSync(h.root, { recursive: true, force: true }); fs.mkdirSync(h.root);
  reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.browserProfiles[PROFILE] = { name: "Health fixture", fingerprintSeed: 12345, fingerprintMode: "off", platform: "macos", timezone: "Europe/London", fingerprintBaseline: BASELINE } as any;
  saveConfig(cfg);
  runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: unknown) => {
    if ((pid === 987654 || pid === process.pid) && signal === 0) return true;
    throw new Error(`Undeclared process signal: ${pid}/${String(signal)}`);
  }) as any);
  h.state.snapshot = { ...BASELINE, canvasHash: "new" };
  h.state.sockets = []; h.state.commands = []; h.state.evaluate = undefined; h.state.error = "";
  h.forbidden.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url !== "http://127.0.0.1:45671/json") throw new Error(`Undeclared fetch: ${url}`);
    return { json: async () => [{ type: "page", id: "ipc-fixture", webSocketDebuggerUrl: "ws://127.0.0.1:45671/devtools/page/ipc-fixture" }] };
  }));
});
afterEach(() => {
  try {
    for (const socket of h.state.sockets) expect(socket.closed).toBe(true);
    expect(h.forbidden).not.toHaveBeenCalled();
  } finally {
    owner.emit("destroyed");
    runningProcesses.clear();
    __resetProcessDiscoveryExecForTest();
    _setAuditPathForTesting(null);
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
afterAll(() => fs.rmSync(h.root, { recursive: true, force: true }));

describe("real baseline IPC with only native CDP capabilities replaced", () => {
  it("a risky snapshot never silently overwrites the prior baseline", async () => {
    const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await capture()).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: expect.any(String), risky: true });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig();
    expect(getConfig().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
  });

  it("one-use confirmation saves the reviewed risk but never labels it PASS", async () => {
    const preview = await capture();
    expect(preview.code).toBe("BASELINE_CONFIRMATION_REQUIRED");
    const result = await capture({ confirmationToken: preview.confirmationToken });
    expect(result).toMatchObject({ ok: true, risky: true, outcome: "risk" });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline.canvasHash).toBe("new");
    reloadConfig();
    expect(getConfig().browserProfiles[PROFILE].fingerprintBaseline).toEqual(h.state.snapshot);
    expect(await capture({ confirmationToken: preview.confirmationToken })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
  });

  it("token binds the sender, old baseline and reviewed current snapshot", async () => {
    const preview = await capture();
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const foreign = Object.assign(new EventEmitter(), { id: 48, isDestroyed: () => false });
    expect(await capture({ confirmationToken: preview.confirmationToken }, foreign)).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    const next = await capture();
    h.state.snapshot = { ...h.state.snapshot, canvasHash: "changed-after-review" };
    expect(await capture({ confirmationToken: next.confirmationToken })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
    const again = await capture();
    setProfileMeta(PROFILE, { fingerprintBaseline: { ...BASELINE, canvasHash: "concurrent" } });
    expect(await capture({ confirmationToken: again.confirmationToken })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline.canvasHash).toBe("concurrent");
  });

  it("persona conflicts cannot be accepted as a reference even without a prior baseline", async () => {
    const cfg = structuredClone(getConfig()); delete cfg.browserProfiles[PROFILE].fingerprintBaseline; saveConfig(cfg);
    const before = fs.readFileSync(getConfigPath(), "utf8");
    h.state.snapshot = { ...BASELINE, platform: "Win32" };
    const result = await capture();
    expect(result).toMatchObject({ ok: false, code: "BASELINE_IDENTITY_CONFLICT", outcome: "risk", risky: true,
      report: { saved: true, baselineCandidate: false, changes: expect.arrayContaining([expect.objectContaining({ field: "persona.platform", baseline: "MacIntel", current: "Win32", severity: "risk" })]) } });
    expect(result).not.toHaveProperty("confirmationToken");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toBeUndefined();
    expect(await driftReport()).toMatchObject({ ok: true, canUpdateBaseline: false, report: { id: result.report.id, baselineCandidate: false } });
  });

  it("checkout lock refuses baseline capture before any native call", async () => {
    const cfg = structuredClone(getConfig()); cfg.browserProfiles[PROFILE].lock = { owner: "other-device", ownerName: "Other", at: 1 }; saveConfig(cfg);
    const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await capture()).toMatchObject({ ok: false, error: expect.stringContaining("locked") });
    expect(h.state.sockets).toHaveLength(0);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  it("a lock acquired during CDP capture cannot be overwritten by a stale config save", async () => {
    h.state.evaluate = () => {
      const cfg = structuredClone(getConfig()); cfg.browserProfiles[PROFILE].lock = { owner: "other-device", ownerName: "Other", at: 1 }; saveConfig(cfg);
      return BASELINE;
    };
    expect(await capture()).toMatchObject({ ok: false, error: expect.stringContaining("locked") });
    expect(disk().browserProfiles[PROFILE]).toMatchObject({ lock: { owner: "other-device" }, fingerprintBaseline: BASELINE });
  });

  it("first reference records every baseline-missing row as review, establishes a baseline but never earns PASS", async () => {
    const cfg = structuredClone(getConfig()); delete cfg.browserProfiles[PROFILE].fingerprintBaseline; saveConfig(cfg);
    h.state.snapshot = BASELINE;
    const result = await capture();
    expect(result).toMatchObject({ ok: true, baselineCommitted: true, outcome: "baseline-established", risky: false, partial: true,
      report: { saved: true, hasBaseline: false, baselineFields: 0, availableFields: Object.keys(BASELINE).length, comparedFields: 0,
        counts: { risk: 0, review: Object.keys(BASELINE).length, info: 0, unavailable: 0 } } });
    const stored = reportDisk().reports.find((entry: any) => entry.report.id === result.report.id).report;
    expect(stored.changes).toEqual(Object.entries(BASELINE).map(([field, current]) => ({ field, baseline: null, current,
      category: "availability", severity: "review", reason: "baseline-missing", availability: "baseline-missing" })));
    expect(stored.acceptedAt).toEqual(expect.any(Number));
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
    reloadConfig();
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect((await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries).toContainEqual(expect.objectContaining({ outcome: "baseline-established", source: "baseline", summary: expect.stringContaining("not a health pass") }));
  });

  it("a changed profile cancels the captured lease without losing a concurrent note", async () => {
    const cfg = structuredClone(getConfig()); delete cfg.browserProfiles[PROFILE].fingerprintBaseline; saveConfig(cfg);
    h.state.evaluate = () => { setProfileMeta(PROFILE, { note: "concurrent edit" }); return BASELINE; };
    expect(await capture()).toMatchObject({ ok: false, code: "HEALTH_PROFILE_CHANGED", outcome: "cancelled" });
    expect(disk().browserProfiles[PROFILE]).toMatchObject({ note: "concurrent edit" });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toBeUndefined();
    reloadConfig();
    expect(getConfig().browserProfiles[PROFILE].note).toBe("concurrent edit");
  });

  it("cancelled/destroyed preview owner cannot confirm and expired tokens cannot mutate", async () => {
    const preview = await capture();
    owner.emit("destroyed");
    expect(await capture({ confirmationToken: preview.confirmationToken })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    const second = await capture();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
    expect(await capture({ confirmationToken: second.confirmationToken })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
  });

  it("health history is backed by canonical stored summaries and remains queryable after reload", async () => {
    recordProfileHealthResult(PROFILE, { kind: "drift", at: 101, outcome: "risk", summary: "reviewed fingerprint change", source: "baseline" });
    expect(disk().profileHealthHistory[PROFILE][0]).toMatchObject({ kind: "drift", outcome: "risk" });
    reloadConfig();
    const result = await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE);
    expect(result.entries).toContainEqual(expect.objectContaining({ kind: "drift", outcome: "risk", summary: "reviewed fingerprint change" }));
  });

  it("health cancellation binds profile, kind, request and sender before aborting the real lease", async () => {
    const run = beginProfileHealthRun(PROFILE, "env", { requestId: "ipc-health-owned", owner: "ipc:47" });
    try {
      const cancel = h.handlers.get("browser:health-cancel")!;
      expect(await cancel({ sender: { id: 48 } }, PROFILE, { kind: "env", requestId: run.requestId })).toMatchObject({ success: false, cancelled: false });
      expect(run.signal.aborted).toBe(false);
      expect(await cancel({ sender: owner }, PROFILE, { kind: "webrtc", requestId: run.requestId })).toMatchObject({ success: false });
      expect(await cancel({ sender: owner }, PROFILE, { kind: "env", requestId: run.requestId })).toMatchObject({ success: true, cancelled: true });
      expect(run.signal.aborted).toBe(true);
    } finally { run.finish(); }
  });

  it("drift without a prior baseline reports unavailable rather than PASS", async () => {
    const cfg = structuredClone(getConfig()); delete cfg.browserProfiles[PROFILE].fingerprintBaseline; saveConfig(cfg);
    const result = await h.handlers.get("browser:check-drift")!({ sender: owner }, PROFILE);
    expect(result).toMatchObject({ checked: false, hasBaseline: false, outcome: "unavailable" });
  });

  it("a live drift probe error remains ERROR rather than a missing-baseline verdict", async () => {
    h.state.error = "fixture drift evaluation failed";
    const result = await h.handlers.get("browser:check-drift")!({ sender: owner }, PROFILE);
    expect(result).toMatchObject({ ok: false, outcome: "error", error: expect.stringContaining("fixture drift") });
  });

  it("confirmation expiring during recapture is stale before the final write", async () => {
    const preview = await capture();
    const now = Date.now();
    h.state.evaluate = () => { vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000); return h.state.snapshot; };
    expect(await capture({ confirmationToken: preview.confirmationToken })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
  });

  it("an empty native snapshot is inconclusive, never an accepted replacement baseline", async () => {
    h.state.snapshot = {};
    expect(await capture()).toMatchObject({ ok: false, outcome: "inconclusive", code: "BASELINE_EMPTY_SNAPSHOT" });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
  });

  it("baseline commit stays truthful when the later history write fails", async () => {
    h.state.snapshot = { ...BASELINE, language: "en-GB" };
    const preview = await capture();
    expect(preview).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", outcome: "inconclusive", review: true, risky: false });
    h.state.renameCalls = 0; h.state.renameFailAt = 2;
    expect(await capture({ confirmationToken: preview.confirmationToken })).toMatchObject({ ok: true, baselineCommitted: true, code: "HEALTH_HISTORY_WRITE_FAILED", warning: expect.stringContaining("Baseline saved") });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline.language).toBe("en-GB");
    reloadConfig(); expect(getConfig().browserProfiles[PROFILE].fingerprintBaseline?.language).toBe("en-GB");
  });

  it.each([false, true])("native audit EACCES cannot erase baseline commit facts (history failure: %s)", async (historyFails) => {
    h.state.snapshot = { ...BASELINE, language: "en-GB" };
    const preview = await capture();
    expect(preview).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", review: true, risky: false });
    h.state.renameFailAt = historyFails ? 2 : 0;
    h.state.auditWriteFail = true;
    const result = await capture({ confirmationToken: preview.confirmationToken });
    expect(result).toMatchObject({ ok: true, baselineCommitted: true, outcome: "baseline-established", baseline: h.state.snapshot });
    expect(h.state.auditRefusals).toBe(1);
    expect(fs.readFileSync(path.join(h.root, "audit.log.jsonl"), "utf8")).toBe("");
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(h.state.snapshot);
    const history = disk().profileHealthHistory?.[PROFILE] || [];
    if (historyFails) {
      expect(result).toMatchObject({ code: "HEALTH_HISTORY_WRITE_FAILED", warning: expect.stringContaining("health history could not be saved") });
      expect(history).toEqual([]);
    } else {
      expect(history).toContainEqual(expect.objectContaining({ kind: "drift", outcome: "baseline-established", requestId: result.requestId }));
    }
    reloadConfig();
    expect(getConfig().browserProfiles[PROFILE].fingerprintBaseline).toEqual(h.state.snapshot);
    expect((await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries).toEqual(history);
  });

  it("a pre-commit atomic write failure preserves the old baseline and cannot claim a commit", async () => {
    h.state.snapshot = { ...BASELINE, language: "en-GB" };
    const preview = await capture();
    expect(preview).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", review: true, risky: false });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    h.state.renameFailAt = 1; h.state.auditWriteFail = true;
    const result = await capture({ confirmationToken: preview.confirmationToken });
    expect(result).toMatchObject({ ok: false, outcome: "error", code: "HEALTH_DIAGNOSTIC_FAILED" });
    expect(result.baselineCommitted).not.toBe(true);
    expect(h.state.auditRefusals).toBe(0);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(getConfig().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
    reloadConfig();
    expect(getConfig().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
    expect((await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries).toEqual([]);
  });

  it.each([
    { runtime: "chromium", intent: "firefox", expected: "chromium" },
    { runtime: "firefox", intent: "chromium", expected: "firefox" },
    { runtime: "legacy", intent: "firefox", expected: "chromium" },
  ] as const)("does not lock $runtime identity under future $intent settings, then dispatches aligned capture correctly", async ({ runtime, intent, expected }) => {
    setProfileMeta(PROFILE, { engine: intent });
    const entry = runningProcesses.get(PROFILE)!;
    if (runtime === "legacy") delete entry.engine;
    else entry.engine = runtime;
    h.state.snapshot = BASELINE;
    const before = fs.readFileSync(getConfigPath());
    expect(await capture()).toMatchObject({ ok: false, code: "BASELINE_IDENTITY_CONFLICT", outcome: "unavailable" });
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
    expect(h.state.sockets).toEqual([]);
    expect(h.state.commands).toEqual([]);
    expect(disk().browserProfiles[PROFILE]).toMatchObject({ engine: intent, fingerprintBaseline: BASELINE });

    // The synthetic running tuple must agree with configured engine intent
    // before a reference can be committed. This is not a native restart test.
    setProfileMeta(PROFILE, { engine: expected });
    const result = await capture();
    expect(result).toMatchObject({ ok: true, baselineCommitted: true, outcome: "baseline-established", report: { engine: expected } });
    const url = expected === "firefox" ? "ws://127.0.0.1:45671/session" : "ws://127.0.0.1:45671/devtools/page/ipc-fixture";
    expect(h.state.sockets.map((socket) => socket.url)).toEqual([url]);
    expect(h.state.commands).toContainEqual({ url, method: expected === "firefox" ? "script.evaluate" : "Runtime.evaluate" });
    if (expected === "firefox") expect(fetch).not.toHaveBeenCalled();
    expect(disk().browserProfiles[PROFILE]).toMatchObject({ engine: expected, fingerprintBaseline: BASELINE });
    reloadConfig();
    expect(getConfig().browserProfiles[PROFILE]).toMatchObject({ engine: expected, fingerprintBaseline: BASELINE });
    expect((await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries).toContainEqual(expect.objectContaining({ requestId: result.requestId, outcome: "baseline-established" }));
  });

  it("native evaluation failure is explicit and does not change baseline", async () => {
    h.state.error = "CDP fixture refused evaluation";
    expect(await capture()).toMatchObject({ ok: false, error: expect.stringContaining("CDP fixture refused") });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
  });
});

describe("blocked launch and stopped drift recovery IPC", () => {
  it.each([
    { code: "fingerprint-drift", message: "Fingerprint drift blocked (canvasHash, webgl.vendor). Review the launch snapshot.",
      driftCheck: { checked: true, risky: true, observedAt: 1_780_000_000_123, drift: [
        { field: "canvasHash", baseline: "old", current: "new" },
        { field: "webgl.vendor", baseline: "Fixture Vendor A", current: "Fixture Vendor B" },
      ] } },
    { code: "fingerprint-check-unavailable", message: "Fingerprint check unavailable: fixture capture refused.",
      driftCheck: { checked: false, error: "fixture capture refused" } },
  ] satisfies { code: string; message: string; driftCheck: LaunchDriftCheck }[])("actual launch handler serializes real $code evidence without dropping the exact diff", async ({ code, message, driftCheck }) => {
    const cfg = structuredClone(getConfig()); cfg.trialStartedAt = Date.now(); saveConfig(cfg);
    const error = new LaunchBlockedError(code, message, driftCheck);
    const launch = vi.spyOn(browserManager, "launchBrowser").mockRejectedValue(error);
    expect(error.driftBlocked).toBe(true);
    const result = await h.handlers.get("browser:launch")!({ sender: owner }, { dirId: PROFILE });
    expect(launch).toHaveBeenCalledExactlyOnceWith(PROFILE, { forceDeadProxy: false });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ success: false, error: message, code, driftCheck });
    expect(result.driftCheck).toEqual(driftCheck);
    expect(h.state.sockets).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { detail: "Fingerprint drift blocked (canvasHash, webgl.vendor, bad-field, <script>, tz (+3 more fields)). AUDIT_ONLY_UNTRUSTED <img onerror=fixture>",
      fields: ["canvasHash", "webgl.vendor", "tz"] },
    { detail: "AUDIT_ONLY_UNTRUSTED legacy free text <img onerror=fixture>", fields: [] },
  ])("stopped drift replays only original blocked time and typed fields, never a fresh history sample ($fields)", async ({ detail, fields }) => {
    runningProcesses.delete(PROFILE);
    const captureProbe = vi.spyOn(fingerprintBaseline, "captureFingerprint");
    const launch = vi.spyOn(browserManager, "launchBrowser").mockRejectedValue(new Error("Unexpected recovery launch"));
    recordProfileHealthResult(PROFILE, { kind: "drift", at: 101, outcome: "risk", source: "runtime", summary: "prior canonical risk sentinel" });
    const at = 1_770_000_000_123;
    recordAudit({ category: "profile", action: "fingerprint-drift-block", target: PROFILE, at: at - 1, detail: "Fingerprint drift blocked (oldField)." });
    recordAudit({ category: "profile", action: "fingerprint-drift-block", target: PROFILE, at, detail });
    recordAudit({ category: "profile", action: "fingerprint-drift-block", target: "ab_unrelated_audit_only", at: at + 1, detail: "Fingerprint drift blocked (unrelatedField)." });
    recordAudit({ category: "settings", action: "fingerprint-drift-block", target: PROFILE, at: at + 2, detail: "Fingerprint drift blocked (wrongCategory)." });
    recordAudit({ category: "profile", action: "fingerprint-drift", target: PROFILE, at: at + 3, detail: "Fingerprint drift blocked (wrongAction)." });
    expect(listAudit(2000, { category: "profile", target: PROFILE }).find(entry => entry.action === "fingerprint-drift-block")).toMatchObject({ at, detail });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const auditBefore = fs.readFileSync(path.join(h.root, "audit.log.jsonl"), "utf8");
    const priorHistory = structuredClone(disk().profileHealthHistory[PROFILE]);
    const ids = [];
    for (let call = 0; call < 2; call++) {
      const result = await h.handlers.get("browser:check-drift")!({ sender: owner }, PROFILE);
      expect(result).toMatchObject({ ok: false, checked: false, hasBaseline: true, code: "PROFILE_NOT_RUNNING", outcome: "unavailable", requestId: expect.any(String) });
      expect(result.lastBlocked).toEqual({ at, fields });
      expect(result).not.toHaveProperty("drift");
      expect(JSON.stringify(result)).not.toContain("AUDIT_ONLY_UNTRUSTED");
      expect(JSON.stringify(result)).not.toContain("<img");
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(fs.readFileSync(path.join(h.root, "audit.log.jsonl"), "utf8")).toBe(auditBefore);
      ids.push(result.requestId);
    }
    expect(new Set(ids).size).toBe(2);
    expect(discoverySync.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(discoverySync.mock.results.every(result => result.type === "return" && (result.value === "" || result.value === "[]"))).toBe(true);
    expect(captureProbe).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    expect(h.state.sockets).toEqual([]); expect(h.state.commands).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    expect(runningProcesses.size).toBe(0);
    reloadConfig();
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect(Object.keys(getConfig().browserProfiles)).toEqual([PROFILE]);
    expect((await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries).toEqual(priorHistory);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });
});

describe("stopped baseline reset IPC confirmation and atomic recovery", () => {
  beforeEach(() => { runningProcesses.delete(PROFILE); });
  afterEach(() => {
    expect(isRestoreLocked(PROFILE)).toBe(false);
    expect(fs.existsSync(path.join(h.root, "locks", `${PROFILE}.restore.lock`))).toBe(false);
  });
  const canonical = async () => (await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries;
  const noProbe = () => {
    expect(h.state.sockets).toEqual([]); expect(h.state.commands).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  };
  const requireResetReview = async () => {
    const result = await reset();
    expect(result).toEqual({ ok: false, code: "BASELINE_RESET_CONFIRMATION_REQUIRED", outcome: "inconclusive", confirmationToken: expect.any(String) });
    return result.confirmationToken as string;
  };

  it("two-phase reset removes only the baseline, preserving concurrent note, identity, proxy, gates, history and session bytes through reload/query", async () => {
    const captureProbe = vi.spyOn(fingerprintBaseline, "captureFingerprint");
    const launch = vi.spyOn(browserManager, "launchBrowser").mockRejectedValue(new Error("Unexpected reset launch"));
    const cfg = structuredClone(getConfig());
    cfg.browserProfiles[PROFILE] = { ...cfg.browserProfiles[PROFILE], name: "Recovery searchable fixture", note: "original note sentinel", engine: "chromium",
      locale: "en-GB", tags: ["recovery-fixture"], proxyMode: "named", proxyName: "fixture-proxy", gpuVendor: "Fixture Native Vendor",
      gpuRenderer: "Fixture Native Renderer", hardwareConcurrency: 8, renderScaleMode: "native" };
    cfg.proxies["fixture-proxy"] = { type: "http", host: "proxy.fixture.test", port: 8080 };
    cfg.blockOnFingerprintDrift = true; cfg.blockOnEnvironmentRisk = true; cfg.blockOnConsistencyConflict = true;
    cfg.blockOnProxyRisk = true; cfg.blockOnInjectionProbe = true; cfg.blockOnUnhealthyProxy = true;
    saveConfig(cfg);
    recordProfileHealthResult(PROFILE, { kind: "drift", at: 101, outcome: "risk", source: "runtime", summary: "canonical history sentinel" });
    const sentinels = [
      { file: path.join(getProfilesDir(), PROFILE, "Default", "History"), bytes: Buffer.from("synthetic history sentinel\n") },
      { file: path.join(getProfilesDir(), PROFILE, "Default", "Sessions", "Session_fixture"), bytes: Buffer.from([0, 1, 2, 3, 255, 127]) },
    ];
    for (const { file, bytes } of sentinels) {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      expect(fs.readFileSync(file)).toEqual(bytes);
    }
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const beforeConfig = disk();
    const token = await requireResetReview();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(h.root, "audit.log.jsonl"))).toBe(false);
    expect(isRestoreLocked(PROFILE)).toBe(false);
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect(await canonical()).toEqual(beforeConfig.profileHealthHistory[PROFILE]);
    setProfileMeta(PROFILE, { note: "concurrent recovery note sentinel" });
    const reviewedProfile = disk().browserProfiles[PROFILE];
    const result = await reset({ confirmationToken: token });
    expect(result).toEqual({ ok: true, baselineReset: true, outcome: "inconclusive" });
    const after = disk();
    expect(after.browserProfiles[PROFILE]).not.toHaveProperty("fingerprintBaseline");
    const { fingerprintBaseline: _oldBaseline, updatedAt: _oldUpdatedAt, ...preserved } = reviewedProfile;
    const { updatedAt: _newUpdatedAt, ...actual } = after.browserProfiles[PROFILE];
    expect(actual).toEqual(preserved);
    const { browserProfiles: _beforeProfiles, profileHealthHistory: _beforeHealth, ...stableBefore } = beforeConfig;
    const { browserProfiles: _afterProfiles, profileHealthHistory: _afterHealth, ...stableAfter } = after;
    expect(stableAfter).toEqual(stableBefore);
    expect(after.profileHealthHistory[PROFILE]).toEqual([...beforeConfig.profileHealthHistory[PROFILE], expect.objectContaining({
      kind: "drift", outcome: "inconclusive", source: "baseline", summary: expect.stringContaining("not a health pass"),
    })]);
    for (const { file, bytes } of sentinels) expect(fs.readFileSync(file)).toEqual(bytes);
    const committedBytes = fs.readFileSync(getConfigPath(), "utf8");
    reloadConfig();
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toBeUndefined();
    expect(getProfileMeta(PROFILE)).toMatchObject({ fingerprintSeed: 12345, platform: "macos", timezone: "Europe/London", locale: "en-GB",
      engine: "chromium", fingerprintMode: "off", note: "concurrent recovery note sentinel", proxyMode: "named", proxyName: "fixture-proxy" });
    const rows = await h.handlers.get("browser:list")!({ sender: owner });
    expect(rows.filter((row: any) => row.note?.includes("concurrent recovery note sentinel"))).toEqual([
      expect.objectContaining({ dirId: PROFILE, name: "Recovery searchable fixture", fingerprintSeed: 12345, proxyName: "fixture-proxy", running: false }),
    ]);
    expect(await canonical()).toEqual(after.profileHealthHistory[PROFILE]);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(committedBytes);
    for (const { file, bytes } of sentinels) expect(fs.readFileSync(file)).toEqual(bytes);
    expect(listAudit(10, { category: "profile", target: PROFILE })).toContainEqual(expect.objectContaining({ action: "fingerprint-baseline-reset", detail: expect.stringContaining("not a health pass") }));
    expect(captureProbe).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); noProbe();
  });

  it.each(["request", "confirmation"].flatMap(phase => ["viewer", "checkout", "restore", "running"].map(gate => ({ phase, gate }))))("$gate rejection at $phase preserves baseline/config and cannot release a foreign restore lock", async ({ phase, gate }) => {
    const token = phase === "confirmation" ? await requireResetReview() : undefined;
    let release: (() => void) | undefined;
    if (gate === "viewer") {
      const cfg = structuredClone(getConfig());
      cfg.team = { name: "Viewer fixture", ownerDeviceId: cfg.deviceId!, enabled: true, updatedAt: 1,
        members: [{ deviceId: cfg.deviceId!, name: "Viewer", role: "viewer", addedAt: 1 }] };
      saveConfig(cfg);
    } else if (gate === "checkout") {
      const cfg = structuredClone(getConfig()); cfg.browserProfiles[PROFILE].lock = { owner: "other-device", ownerName: "Other", at: 1 }; saveConfig(cfg);
    } else if (gate === "restore") release = acquireRestoreLock(PROFILE);
    else runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
    try {
      const before = fs.readFileSync(getConfigPath(), "utf8");
      const lockFile = path.join(h.root, "locks", `${PROFILE}.restore.lock`);
      const lockBefore = gate === "restore" ? fs.readFileSync(lockFile, "utf8") : undefined;
      const result = await reset(token ? { confirmationToken: token } : undefined);
      if (gate === "viewer") expect(result).toMatchObject({ ok: false, code: "TEAM_ROLE_DENIED", outcome: "error" });
      else if (gate === "running") expect(result).toMatchObject({ ok: false, code: "PROFILE_RUNNING", outcome: "unavailable" });
      else expect(result).toMatchObject({ ok: false, code: "HEALTH_DIAGNOSTIC_FAILED", outcome: "error", error: expect.stringContaining(gate === "checkout" ? "locked" : "Restore already in progress") });
      expect(result).not.toHaveProperty("confirmationToken");
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
      if (gate === "restore") {
        expect(isRestoreLocked(PROFILE)).toBe(true);
        expect(fs.readFileSync(lockFile, "utf8")).toBe(lockBefore);
        expect(() => acquireRestoreLock(PROFILE)).toThrow("Restore already in progress");
      } else expect(isRestoreLocked(PROFILE)).toBe(false);
      reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
      expect(await canonical()).toEqual([]); noProbe();
    } finally { release?.(); }
  });

  it.each([
    { changed: "baseline", patch: { fingerprintBaseline: { ...BASELINE, canvasHash: "concurrent-baseline" } } },
    { changed: "identity seed", patch: { fingerprintSeed: 54321 } },
    { changed: "identity timezone", patch: { timezone: "America/New_York" } },
  ])("confirmation rejects changed $changed without overwriting the concurrent edit", async ({ patch }) => {
    const token = await requireResetReview();
    setProfileMeta(PROFILE, patch);
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const current = structuredClone(getProfileMeta(PROFILE));
    expect(await reset({ confirmationToken: token })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE", outcome: "inconclusive" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(getProfileMeta(PROFILE)).toEqual(current);
    reloadConfig(); expect(getProfileMeta(PROFILE)).toEqual(current);
    expect(await canonical()).toEqual([]); noProbe();
  });

  it("a wrong sender cannot spend the legitimate sender's reset confirmation", async () => {
    const token = await requireResetReview();
    const foreign = Object.assign(new EventEmitter(), { id: owner.id, isDestroyed: () => false });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await reset({ confirmationToken: token }, foreign)).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(await reset({ confirmationToken: token })).toEqual({ ok: true, baselineReset: true, outcome: "inconclusive" });
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toBeUndefined(); noProbe();
  });

  it("a spent reset token and a new reset with no baseline cannot mint another write/history sample", async () => {
    const token = await requireResetReview();
    expect(await reset({ confirmationToken: token })).toMatchObject({ ok: true, baselineReset: true });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const history = await canonical();
    expect(await reset({ confirmationToken: token })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE", outcome: "inconclusive" });
    expect(await reset()).toMatchObject({ ok: false, code: "BASELINE_NOT_SET", outcome: "unavailable" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toBeUndefined();
    expect(await canonical()).toEqual(history); noProbe();
  });

  it.each(["expired", "destroyed"])("%s reset confirmation cannot mutate a stopped baseline", async (reason) => {
    const token = await requireResetReview();
    const before = fs.readFileSync(getConfigPath(), "utf8");
    if (reason === "destroyed") owner.emit("destroyed");
    else vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    expect(await reset({ confirmationToken: token })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE", outcome: "inconclusive" });
    expect(owner.listenerCount("destroyed")).toBe(0);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect(await canonical()).toEqual([]); noProbe();
  });

  it("a sender already destroyed at confirmation is rejected before any reset write", async () => {
    let destroyed = false;
    const sender = Object.assign(new EventEmitter(), { id: 49, isDestroyed: () => destroyed });
    const preview = await reset(undefined, sender);
    expect(preview.code).toBe("BASELINE_RESET_CONFIRMATION_REQUIRED");
    const before = fs.readFileSync(getConfigPath(), "utf8");
    destroyed = true; sender.emit("destroyed");
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect(await reset({ confirmationToken: preview.confirmationToken }, sender)).toMatchObject({ ok: false, code: "HEALTH_DIAGNOSTIC_FAILED", error: "Diagnostic owner is unavailable" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE); noProbe();
  });

  it.each(["capture-to-reset", "reset-to-capture"])("shared confirmation registry rejects %s tokens before any replacement write/probe", async (direction) => {
    let token: string;
    if (direction === "capture-to-reset") {
      runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
      const preview = await capture();
      expect(preview.code).toBe("BASELINE_CONFIRMATION_REQUIRED"); token = preview.confirmationToken;
      runningProcesses.delete(PROFILE);
    } else {
      token = await requireResetReview();
      runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
    }
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const socketCount = h.state.sockets.length;
    const fetchCount = vi.mocked(fetch).mock.calls.length;
    const result = direction === "capture-to-reset" ? await reset({ confirmationToken: token }) : await capture({ confirmationToken: token });
    expect(result).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE", outcome: "inconclusive" });
    expect(h.state.sockets).toHaveLength(socketCount); expect(fetch).toHaveBeenCalledTimes(fetchCount);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect(await canonical()).toEqual([]);
  });

  it("reset rename failure preserves memory/disk baseline and releases its own restore lock", async () => {
    const token = await requireResetReview();
    const before = fs.readFileSync(getConfigPath(), "utf8");
    h.state.renameCalls = 0; h.state.renameFailAt = 1;
    const result = await reset({ confirmationToken: token });
    expect(result).toMatchObject({ ok: false, outcome: "error", code: "HEALTH_DIAGNOSTIC_FAILED" });
    expect(result.baselineReset).not.toBe(true);
    expect(h.state.renameCalls).toBe(1);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect(isRestoreLocked(PROFILE)).toBe(false);
    expect(fs.existsSync(path.join(h.root, "locks", `${PROFILE}.restore.lock`))).toBe(false);
    const release = acquireRestoreLock(PROFILE);
    try { expect(isRestoreLocked(PROFILE)).toBe(true); } finally { release(); }
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect(await canonical()).toEqual([]);
    expect(listAudit(10, { target: PROFILE })).toEqual([]); noProbe();
  });

  it("history failure after reset is a committed reset warning, not a false rollback", async () => {
    recordProfileHealthResult(PROFILE, { kind: "drift", at: 101, outcome: "risk", source: "runtime", summary: "prior canonical risk sentinel" });
    const prior = structuredClone(disk().profileHealthHistory[PROFILE]);
    const token = await requireResetReview();
    h.state.renameCalls = 0; h.state.renameFailAt = 2;
    const result = await reset({ confirmationToken: token });
    expect(result).toMatchObject({ ok: true, baselineReset: true, outcome: "inconclusive", code: "HEALTH_HISTORY_WRITE_FAILED", warning: expect.stringContaining("Baseline reset, but health history could not be saved") });
    expect(h.state.renameCalls).toBe(2);
    expect(disk().browserProfiles[PROFILE]).not.toHaveProperty("fingerprintBaseline");
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toBeUndefined();
    expect(disk().profileHealthHistory[PROFILE]).toEqual(prior);
    expect(isRestoreLocked(PROFILE)).toBe(false);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toBeUndefined();
    expect(await canonical()).toEqual(prior);
    expect(listAudit(10, { target: PROFILE })).toContainEqual(expect.objectContaining({ action: "fingerprint-baseline-reset" })); noProbe();
  });
});

describe("current-session comparison report IPC and stopped reference acceptance", () => {
  const noStartStop = () => ({
    start: vi.spyOn(browserManager, "launchBrowser").mockRejectedValue(new Error("Unexpected report recovery launch")),
    stop: vi.spyOn(browserManager, "stopBrowser").mockImplementation(() => { throw new Error("Unexpected report recovery stop"); }),
  });
  let runtime: ReturnType<typeof noStartStop>;
  beforeEach(() => { runningProcesses.delete(PROFILE); runtime = noStartStop(); });
  afterEach(() => {
    expect(runtime.start).not.toHaveBeenCalled(); expect(runtime.stop).not.toHaveBeenCalled();
    expect(isRestoreLocked(PROFILE)).toBe(false);
    expect(fs.existsSync(path.join(h.root, "locks", `${PROFILE}.restore.lock`))).toBe(false);
    expect(listAudit(2000, { target: PROFILE }).some(entry => entry.action === "fingerprint-baseline-reset")).toBe(false);
  });
  const canonical = async () => (await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries;
  const review = async (reportId: string, sender: any = owner) => {
    const result = await capture({ reportId }, sender);
    expect(result).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: expect.any(String),
      report: { id: reportId }, currentConfigMatches: true, canUpdateBaseline: true });
    return result.confirmationToken as string;
  };
  const noProbe = () => {
    expect(h.state.sockets).toEqual([]); expect(h.state.commands).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  };

  it("real manual comparison -> raw report read -> stopped review/accept -> config reload/list preserves all browser data and gates without start/stop/reset", async () => {
    const cfg = structuredClone(getConfig());
    cfg.browserProfiles[PROFILE] = { ...cfg.browserProfiles[PROFILE], name: "Report journey searchable fixture", note: "original report note", locale: "en-GB",
      proxyMode: "named", proxyName: "report-proxy", tags: ["report-journey"], gpuVendor: "Fixture Vendor", gpuRenderer: "Fixture Renderer" };
    cfg.proxies["report-proxy"] = { type: "http", host: "proxy.fixture.test", port: 8080 };
    cfg.blockOnFingerprintDrift = true; cfg.blockOnEnvironmentRisk = true; cfg.blockOnProxyRisk = true;
    cfg.blockOnConsistencyConflict = true; cfg.blockOnInjectionProbe = true; cfg.blockOnUnhealthyProxy = true;
    saveConfig(cfg);
    const release = acquireRestoreLock(PROFILE);
    try { markProfileDataChanging(PROFILE); } finally { release(); }
    const revisionFile = path.join(h.root, "profile-data-revisions", `${PROFILE}.json`);
    const revision = JSON.parse(fs.readFileSync(revisionFile, "utf8"));
    expect(revision).toEqual({ version: 1, dirId: PROFILE, revision: getProfileDataRevision(PROFILE) });
    expect(revision.revision).not.toBe("initial");
    const revisionBytes = fs.readFileSync(revisionFile, "utf8");
    const sentinels = [
      { file: path.join(getProfilesDir(), PROFILE, "Default", "Network", "Cookies"), bytes: Buffer.from("synthetic-cookie-fixture-only\n") },
      { file: path.join(getProfilesDir(), PROFILE, "Default", "History"), bytes: Buffer.from("synthetic-history-fixture-only\n") },
      { file: path.join(getProfilesDir(), PROFILE, "Default", "Sessions", "Session_fixture"), bytes: Buffer.from([0, 2, 4, 8, 128, 255]) },
    ];
    for (const { file, bytes } of sentinels) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); expect(fs.readFileSync(file)).toEqual(bytes); }
    recordProfileHealthResult(PROFILE, { kind: "drift", at: 101, outcome: "risk", source: "runtime", summary: "prior report history sentinel" });
    const snapshot = { ...BASELINE, canvasHash: "reviewed-report-snapshot" };
    h.state.snapshot = snapshot;
    runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
    const observed = await h.handlers.get("browser:check-drift")!({ sender: owner }, PROFILE);
    expect(observed).toMatchObject({ ok: true, checked: true, risky: true, outcome: "risk", report: { saved: true, baselineCandidate: true, source: "manual" } });
    runningProcesses.delete(PROFILE); // Simulate already-observed exit; never dispatch stop/start.
    const captureProbe = vi.spyOn(fingerprintBaseline, "captureFingerprint");
    const stored = reportDisk().reports.find((entry: any) => entry.report.id === observed.report.id);
    expect(stored).toMatchObject({ witness: fingerprintReports.fingerprintProfileWitness(getConfig().browserProfiles[PROFILE]), dataRevision: revision.revision,
      report: { id: observed.report.id, observedAt: observed.observedAt, source: "manual", engine: "chromium", engineVersion: null,
        changes: [{ field: "canvasHash", baseline: "old", current: "reviewed-report-snapshot", category: "identity", severity: "risk", reason: "opaque-signal-change" }] } });
    expect(stored).not.toHaveProperty("snapshot");
    const beforeBytes = fs.readFileSync(getConfigPath(), "utf8"), reportBytes = fs.readFileSync(reportPath(), "utf8");
    const beforeConfig = disk(), oldHistory = structuredClone(beforeConfig.profileHealthHistory[PROFILE]);
    const discoveries = discoverySync.mock.calls.length, socketCount = h.state.sockets.length, fetchCount = vi.mocked(fetch).mock.calls.length;
    for (let call = 0; call < 2; call++) {
      expect(await driftReport()).toMatchObject({ ok: true, currentConfigMatches: true, canUpdateBaseline: true,
        report: { id: observed.report.id, observedAt: observed.observedAt, baselineCandidate: true } });
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
      expect(fs.readFileSync(reportPath(), "utf8")).toBe(reportBytes);
      expect(await canonical()).toEqual(oldHistory);
    }
    expect(discoverySync.mock.calls.length).toBe(discoveries);
    const token = await review(observed.report.id);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reportBytes);
    setProfileMeta(PROFILE, { note: "concurrent report note searchable sentinel" });
    expect(await driftReport()).toMatchObject({ currentConfigMatches: true, canUpdateBaseline: true });
    const profileBeforeCommit = disk().browserProfiles[PROFILE];
    const commits: { locked: boolean; baseline: unknown }[] = [];
    h.state.renameObserver = () => commits.push({ locked: isRestoreLocked(PROFILE), baseline: structuredClone(getConfig().browserProfiles[PROFILE].fingerprintBaseline) });
    const result = await capture({ reportId: observed.report.id, confirmationToken: token });
    h.state.renameObserver = undefined;
    expect(result).toMatchObject({ ok: true, baselineCommitted: true, outcome: "risk", risky: true, canUpdateBaseline: false,
      report: { id: observed.report.id, observedAt: observed.observedAt, acceptedAt: expect.any(Number), baselineCandidate: false } });
    expect(commits).toEqual([{ locked: true, baseline: BASELINE }, { locked: true, baseline: snapshot }]);
    const after = disk();
    expect(after.browserProfiles[PROFILE].fingerprintBaseline).toEqual(snapshot);
    const { fingerprintBaseline: _prior, updatedAt: _priorAt, ...preserved } = profileBeforeCommit;
    const { fingerprintBaseline: _accepted, updatedAt: _acceptedAt, ...actual } = after.browserProfiles[PROFILE];
    expect(actual).toEqual(preserved);
    const { browserProfiles: _bp, profileHealthHistory: _bh, ...stableBefore } = beforeConfig;
    const { browserProfiles: _ap, profileHealthHistory: _ah, ...stableAfter } = after;
    expect(stableAfter).toEqual(stableBefore);
    expect(after.profileHealthHistory[PROFILE]).toEqual([...oldHistory, expect.objectContaining({ kind: "drift", source: "baseline", outcome: "risk", summary: expect.stringContaining("not a health pass") })]);
    expect(reportDisk().reports.find((entry: any) => entry.report.id === observed.report.id).report).toMatchObject({ observedAt: observed.observedAt, acceptedAt: expect.any(Number) });
    reloadConfig();
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(snapshot);
    expect(getProfileMeta(PROFILE)).toMatchObject({ fingerprintSeed: 12345, note: "concurrent report note searchable sentinel", platform: "macos", timezone: "Europe/London", proxyName: "report-proxy" });
    const rows = await h.handlers.get("browser:list")!({ sender: owner });
    expect(rows.filter((row: any) => row.note?.includes("concurrent report note searchable sentinel"))).toEqual([
      expect.objectContaining({ dirId: PROFILE, name: "Report journey searchable fixture", running: false, fingerprintSeed: 12345, proxyName: "report-proxy" }),
    ]);
    const finalConfig = fs.readFileSync(getConfigPath(), "utf8"), finalReport = fs.readFileSync(reportPath(), "utf8");
    expect(await driftReport()).toMatchObject({ ok: true, currentConfigMatches: false, canUpdateBaseline: false,
      report: { id: observed.report.id, observedAt: observed.observedAt, baselineCandidate: false, acceptedAt: expect.any(Number) } });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(finalConfig); expect(fs.readFileSync(reportPath(), "utf8")).toBe(finalReport);
    expect(await canonical()).toEqual(after.profileHealthHistory[PROFILE]);
    expect(fs.readFileSync(revisionFile, "utf8")).toBe(revisionBytes);
    for (const { file, bytes } of sentinels) expect(fs.readFileSync(file)).toEqual(bytes);
    expect(captureProbe).not.toHaveBeenCalled(); expect(h.state.sockets).toHaveLength(socketCount); expect(fetch).toHaveBeenCalledTimes(fetchCount);
    expect(runningProcesses.size).toBe(0);
  });

  it("two stopped checks reopen full saved details at the original time without capture or new canonical history", async () => {
    const saved = saveComparison({ ...BASELINE, canvasHash: "original stopped report snapshot" }, 1_770_000_000_123);
    recordProfileHealthResult(PROFILE, { kind: "drift", at: 101, outcome: "risk", source: "runtime", summary: "existing stopped history sentinel" });
    const captureProbe = vi.spyOn(fingerprintBaseline, "captureFingerprint");
    const before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8"), history = await canonical();
    for (let call = 0; call < 2; call++) {
      expect(await h.handlers.get("browser:check-drift")!({ sender: owner }, PROFILE)).toMatchObject({ ok: false, checked: false, hasBaseline: true,
        code: "PROFILE_NOT_RUNNING", outcome: "unavailable", currentConfigMatches: true, canUpdateBaseline: true,
        report: { id: saved.report.id, observedAt: 1_770_000_000_123, changes: [{ field: "canvasHash", baseline: "old", current: "original stopped report snapshot", severity: "risk" }] } });
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports); expect(await canonical()).toEqual(history);
    }
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE); expect(await canonical()).toEqual(history);
    expect(captureProbe).not.toHaveBeenCalled(); expect(discoverySync.mock.calls.length).toBeGreaterThanOrEqual(2); noProbe();
  });

  it("read-only details refuse even a dead restore marker without unlinking it or doing process discovery", async () => {
    const saved = saveComparison(), file = path.join(h.root, "locks", `${PROFILE}.restore.lock`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const marker = JSON.stringify({ pid: 987653, dirId: PROFILE, token: "dead-fixture-restore-owner", createdAt: "fixture" }); fs.writeFileSync(file, marker);
    vi.mocked(process.kill).mockImplementation(((pid: number, signal: unknown) => {
      if (pid === 987653 && signal === 0) throw Object.assign(new Error("synthetic missing PID"), { code: "ESRCH" });
      if ((pid === 987654 || pid === process.pid) && signal === 0) return true;
      throw new Error(`Undeclared process signal: ${pid}/${String(signal)}`);
    }) as any);
    const before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8");
    try {
      expect(await driftReport()).toMatchObject({ ok: true, currentConfigMatches: true, canUpdateBaseline: false, report: { id: saved.report.id, baselineCandidate: false } });
      expect(fs.readFileSync(file, "utf8")).toBe(marker); expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
      expect(discoverySync).not.toHaveBeenCalled(); expect(await canonical()).toEqual([]); noProbe();
    } finally { fs.unlinkSync(file); }
  });

  it.each(["request", "confirmation"].flatMap(phase => ["baseline", "identity", "revision", "same-config-restored-data", "same-name-proxy"].map(change => ({ phase, change }))))("$change invalidates report acceptance at $phase without losing the concurrent state", async ({ phase, change }) => {
    if (change === "same-name-proxy") {
      const cfg = structuredClone(getConfig()); cfg.proxies["same-name-proxy"] = { type: "http", host: "before.fixture.test", port: 8080 };
      cfg.browserProfiles[PROFILE] = { ...cfg.browserProfiles[PROFILE], proxyMode: "named", proxyName: "same-name-proxy" }; saveConfig(cfg);
    }
    // Normalize the fixture's serialization order before observing it. The
    // later same-content save must still leave the exact reference bytes intact.
    if (change === "same-config-restored-data") saveConfig(structuredClone(getConfig()));
    const saved = saveComparison();
    const token = phase === "confirmation" ? await review(saved.report.id) : undefined;
    const originalConfig = fs.readFileSync(getConfigPath(), "utf8");
    let restored: string | undefined;
    if (change === "baseline") setProfileMeta(PROFILE, { fingerprintBaseline: { ...BASELINE, canvasHash: "concurrent reference" } });
    else if (change === "identity") setProfileMeta(PROFILE, { fingerprintSeed: 54321 });
    else if (change === "same-name-proxy") {
      const cfg = structuredClone(getConfig()); cfg.proxies["same-name-proxy"] = { type: "http", host: "after.fixture.test", port: 8081 }; saveConfig(cfg);
      expect(getProfileMeta(PROFILE)?.proxyName).toBe("same-name-proxy");
    } else {
      const release = acquireRestoreLock(PROFILE);
      try {
        markProfileDataChanging(PROFILE);
        const revision = JSON.parse(fs.readFileSync(path.join(h.root, "profile-data-revisions", `${PROFILE}.json`), "utf8"));
        expect(revision.revision).toBe(getProfileDataRevision(PROFILE)); expect(revision.revision).not.toBe(saved.stored.dataRevision);
        if (change === "same-config-restored-data") {
          restored = path.join(getProfilesDir(), PROFILE, "Default", "History");
          fs.mkdirSync(path.dirname(restored), { recursive: true }); fs.writeFileSync(restored, "restored synthetic history sentinel\n");
          saveConfig(structuredClone(getConfig()));
        }
      } finally { release(); }
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(originalConfig);
    }
    const before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8"), meta = structuredClone(getProfileMeta(PROFILE));
    expect(await driftReport()).toMatchObject({ ok: true, currentConfigMatches: false, canUpdateBaseline: false, report: { id: saved.report.id, observedAt: saved.report.observedAt } });
    expect(await capture({ reportId: saved.report.id, ...(token ? { confirmationToken: token } : {}) })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
    expect(getProfileMeta(PROFILE)).toEqual(meta);
    reloadConfig(); expect(getProfileMeta(PROFILE)).toEqual(meta); expect(await canonical()).toEqual([]);
    if (restored) expect(fs.readFileSync(restored, "utf8")).toBe("restored synthetic history sentinel\n"); noProbe();
  });

  it.each(["request", "confirmation"].flatMap(phase => ["viewer", "checkout", "restore", "running", "browser-marker"].map(gate => ({ phase, gate }))))("$gate refuses stopped-report $phase and preserves another restore owner's lock", async ({ phase, gate }) => {
    const saved = saveComparison(), token = phase === "confirmation" ? await review(saved.report.id) : undefined;
    let release: (() => void) | undefined;
    let marker: string | undefined;
    if (gate === "viewer") {
      const cfg = structuredClone(getConfig()); cfg.team = { name: "Report viewer fixture", ownerDeviceId: cfg.deviceId!, enabled: true, updatedAt: 1,
        members: [{ deviceId: cfg.deviceId!, name: "Viewer", role: "viewer", addedAt: 1 }] }; saveConfig(cfg);
    } else if (gate === "checkout") {
      const cfg = structuredClone(getConfig()); cfg.browserProfiles[PROFILE].lock = { owner: "other-device", ownerName: "Other", at: 1 }; saveConfig(cfg);
    } else if (gate === "restore") release = acquireRestoreLock(PROFILE);
    else if (gate === "running") runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
    else {
      marker = path.join(getProfilesDir(), PROFILE, "SingletonLock"); fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, "fixture browser lock marker");
    }
    try {
      const before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8");
      const lockFile = path.join(h.root, "locks", `${PROFILE}.restore.lock`), lock = release ? fs.readFileSync(lockFile, "utf8") : undefined;
      const result = await capture({ reportId: saved.report.id, ...(token ? { confirmationToken: token } : {}) });
      if (gate === "viewer") expect(result).toMatchObject({ ok: false, code: "TEAM_ROLE_DENIED", outcome: "error" });
      else if (gate === "running" || gate === "browser-marker") expect(result).toMatchObject({ ok: false, code: "PROFILE_STOP_REQUIRED", outcome: "unavailable" });
      else expect(result).toMatchObject({ ok: false, code: "HEALTH_DIAGNOSTIC_FAILED", error: expect.stringContaining(gate === "checkout" ? "locked" : "Restore already in progress") });
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
      expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE); expect(await canonical()).toEqual([]);
      if (release) { expect(isRestoreLocked(PROFILE)).toBe(true); expect(fs.readFileSync(lockFile, "utf8")).toBe(lock); expect(() => acquireRestoreLock(PROFILE)).toThrow("Restore already in progress"); }
      if (marker) expect(fs.readFileSync(marker, "utf8")).toBe("fixture browser lock marker"); noProbe();
    } finally { release?.(); }
  });

  it("report review binds the exact sender object, allows its owner once, and refuses reuse without new history", async () => {
    const saved = saveComparison(), token = await review(saved.report.id);
    const foreign = Object.assign(new EventEmitter(), { id: owner.id, isDestroyed: () => false });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await capture({ reportId: saved.report.id, confirmationToken: token }, foreign)).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(await capture({ reportId: saved.report.id, confirmationToken: token })).toMatchObject({ ok: true, baselineCommitted: true, outcome: "risk" });
    const committed = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8"), history = await canonical();
    expect(await capture({ reportId: saved.report.id, confirmationToken: token })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(await capture({ reportId: saved.report.id })).toMatchObject({ ok: false, code: "BASELINE_SNAPSHOT_EXPIRED" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(committed); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(saved.current); expect(await canonical()).toEqual(history); noProbe();
  });

  it.each(["expired", "destroyed"])("%s five-minute report review cannot authorize a still-readable thirty-minute snapshot", async (reason) => {
    const saved = saveComparison(), token = await review(saved.report.id);
    const before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8");
    if (reason === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    else owner.emit("destroyed");
    expect(await capture({ reportId: saved.report.id, confirmationToken: token })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(await driftReport()).toMatchObject({ ok: true, currentConfigMatches: true, canUpdateBaseline: true, report: { id: saved.report.id, observedAt: saved.report.observedAt } });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
    expect(owner.listenerCount("destroyed")).toBe(0); noProbe();
  });

  it("a thirty-minute-old report remains viewable at its original time but cannot mint a new review", async () => {
    const saved = saveComparison(), before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1000);
    expect(await driftReport()).toMatchObject({ ok: true, currentConfigMatches: true, canUpdateBaseline: false, report: { id: saved.report.id, observedAt: saved.report.observedAt, baselineCandidate: false } });
    expect(await capture({ reportId: saved.report.id })).toMatchObject({ ok: false, code: "BASELINE_SNAPSHOT_EXPIRED" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
    expect(await canonical()).toEqual([]); noProbe();
  });

  it.each(["report-to-capture", "report-to-reset", "capture-to-report", "reset-to-report"])("shared registry rejects %s without treating one confirmation kind as another", async (direction) => {
    let saved = saveComparison(), token: string;
    if (direction.startsWith("report-to")) token = await review(saved.report.id);
    else if (direction === "reset-to-report") { const preview = await reset(); expect(preview.code).toBe("BASELINE_RESET_CONFIRMATION_REQUIRED"); token = preview.confirmationToken; }
    else {
      runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
      const preview = await capture(); expect(preview.code).toBe("BASELINE_CONFIRMATION_REQUIRED"); token = preview.confirmationToken;
      saved = { ...saved, report: preview.report }; runningProcesses.delete(PROFILE);
    }
    const before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8"), sockets = h.state.sockets.length;
    const result = direction === "report-to-reset" ? await reset({ confirmationToken: token }) : await capture({ confirmationToken: token, ...(direction === "report-to-capture" ? {} : { reportId: saved.report.id }) });
    expect(result).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
    expect(h.state.sockets).toHaveLength(sockets); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE); expect(await canonical()).toEqual([]);
  });

  it("a report review token cannot be rebound to a different current-session report ID", async () => {
    const first = saveComparison(), token = await review(first.report.id), second = saveComparison({ ...BASELINE, canvasHash: "second report snapshot" });
    const before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8");
    expect(await capture({ reportId: second.report.id, confirmationToken: token })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports); noProbe();
  });

  it.each([
    { kind: "persona conflict", current: { ...BASELINE, platform: "Win32" }, field: "persona.platform", severity: "risk" },
    { kind: "required unavailable", current: { platform: BASELINE.platform, userAgent: BASELINE.userAgent, plugins: BASELINE.plugins, tz: BASELINE.tz }, field: "canvasHash", severity: "unavailable" },
  ])("$kind details can be viewed but never replace the reference", async ({ current, field, severity }) => {
    const saved = saveComparison(current), before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8");
    expect(saved.report.baselineCandidate).toBe(false);
    expect(await driftReport()).toMatchObject({ ok: true, currentConfigMatches: true, canUpdateBaseline: false,
      report: { id: saved.report.id, changes: expect.arrayContaining([expect.objectContaining({ field, severity })]) } });
    expect(await capture({ reportId: saved.report.id })).toMatchObject({ ok: false, code: "BASELINE_SNAPSHOT_EXPIRED" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE); expect(await canonical()).toEqual([]); noProbe();
  });

  it("report acceptance rename failure preserves baseline/report bytes and releases its own restore lock", async () => {
    const saved = saveComparison(), token = await review(saved.report.id), before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8");
    h.state.renameCalls = 0; h.state.renameFailAt = 1;
    const result = await capture({ reportId: saved.report.id, confirmationToken: token });
    expect(result).toMatchObject({ ok: false, code: "HEALTH_DIAGNOSTIC_FAILED", outcome: "error" }); expect(result.baselineCommitted).not.toBe(true);
    expect(h.state.renameCalls).toBe(1); expect(isRestoreLocked(PROFILE)).toBe(false);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    const release = acquireRestoreLock(PROFILE); try { expect(isRestoreLocked(PROFILE)).toBe(true); } finally { release(); }
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE); expect(await canonical()).toEqual([]); noProbe();
  });

  it.each([false, true])("manual summary I/O failure retains the measured details without PASS (observed risk: %s)", async (risky) => {
    h.state.snapshot = risky ? { ...BASELINE, canvasHash: "manual-risk" } : { ...BASELINE };
    runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    h.state.renameCalls = 0; h.state.renameFailAt = 1;
    const result = await h.handlers.get("browser:check-drift")!({ sender: owner }, PROFILE);
    expect(result).toMatchObject({ ok: false, code: "HEALTH_HISTORY_WRITE_FAILED", historySaved: false,
      outcome: risky ? "risk" : "inconclusive", canUpdateBaseline: false,
      warning: expect.stringContaining("health history could not be saved"), report: { source: "manual", risky, saved: true } });
    expect(result.outcome).not.toBe("pass");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    const stored = reportDisk().reports.find((entry: any) => entry.report.id === result.report.id).report;
    expect(stored).toMatchObject({ observedAt: result.report.observedAt, source: "manual", risky, changes: result.report.changes });
    expect(await canonical()).toEqual([]);
    h.state.renameFailAt = 0;
    reloadConfig();
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect(await driftReport()).toMatchObject({ ok: true, report: { id: result.report.id, observedAt: result.report.observedAt, risky } });
    expect(await canonical()).toEqual([]);
  });

  it.each(["preview", "confirmation"])("unknown runtime refuses advanced reset at %s without losing the reference", async (phase) => {
    const invoke = (options?: Record<string, unknown>) => h.handlers.get("browser:reset-baseline")!({ sender: owner }, options ? { dirId: PROFILE, ...options } : PROFILE);
    runningProcesses.clear();
    const token = phase === "confirmation" ? (await invoke()).confirmationToken : undefined;
    if (phase === "confirmation") expect(token).toEqual(expect.any(String));
    const before = fs.readFileSync(getConfigPath(), "utf8");
    vi.spyOn(browserManager, "statusBrowser").mockReturnValue({ running: false, pid: null, cdpPort: null, unknown: true });
    const result = await invoke(token ? { confirmationToken: token } : undefined);
    expect(result).toMatchObject({ ok: false, code: "PROFILE_STOP_REQUIRED", outcome: "unavailable" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(BASELINE);
    expect(h.state.sockets).toEqual([]);
    expect(h.state.commands).toEqual([]);
    expect(isRestoreLocked(PROFILE)).toBe(false);
  });

  it("history failure after report acceptance warns without inventing a rollback or health pass", async () => {
    recordProfileHealthResult(PROFILE, { kind: "drift", at: 101, outcome: "risk", source: "runtime", summary: "prior report health sentinel" });
    const prior = await canonical(), saved = saveComparison(), token = await review(saved.report.id);
    h.state.renameCalls = 0; h.state.renameFailAt = 2;
    expect(await capture({ reportId: saved.report.id, confirmationToken: token })).toMatchObject({ ok: true, baselineCommitted: true, outcome: "risk", warning: expect.stringContaining("Baseline saved, but health history could not be saved") });
    expect(h.state.renameCalls).toBe(2); expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(saved.current);
    expect(reportDisk().reports.find((entry: any) => entry.report.id === saved.report.id).report.acceptedAt).toEqual(expect.any(Number));
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(saved.current); expect(await canonical()).toEqual(prior); noProbe();
  });

  it("a fresh IPC/module session may reopen the real disk report but has no snapshot acceptance authority", async () => {
    const saved = saveComparison(), before = fs.readFileSync(getConfigPath(), "utf8"), reports = fs.readFileSync(reportPath(), "utf8");
    expect(await driftReport()).toMatchObject({ canUpdateBaseline: true });
    const oldHandlers = new Map(h.handlers);
    let resetDiscovery: (() => void) | undefined;
    try {
      vi.resetModules(); h.handlers.clear();
      const fresh = await import("../../src/main/ipc/browser.js");
      const discovery = await import("../../src/main/services/process-discovery.js");
      discovery.__setProcessDiscoveryExecForTest({ execFileSync: discoverySync as any, exec: discoveryAsync as any }); resetDiscovery = discovery.__resetProcessDiscoveryExecForTest;
      fresh.registerBrowserHandlers();
      expect(await driftReport()).toMatchObject({ ok: true, currentConfigMatches: true, canUpdateBaseline: false,
        report: { id: saved.report.id, observedAt: saved.report.observedAt, baselineCandidate: false } });
      expect(await capture({ reportId: saved.report.id })).toMatchObject({ ok: false, code: "BASELINE_SNAPSHOT_EXPIRED" });
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(fs.readFileSync(reportPath(), "utf8")).toBe(reports);
      expect(await canonical()).toEqual([]); noProbe();
    } finally {
      resetDiscovery?.(); h.handlers.clear(); for (const [channel, handler] of oldHandlers) h.handlers.set(channel, handler);
    }
  });
});

describe("live reference confirmation semantic snapshot fence", () => {
  const semantic = {
    ...BASELINE, innerWidth: 1000, innerHeight: 700, screenX: 10, screenY: 20,
    uaHighEntropy: JSON.stringify({ architecture: "arm", bitness: "64", brands: [{ brand: "Chromium", version: "150" }, { brand: "Not.A/Brand", version: "99" }] }),
    workerIdentity: JSON.stringify({ language: "en-GB", hardwareConcurrency: 8 }),
  };
  beforeEach(() => { setProfileMeta(PROFILE, { fingerprintBaseline: semantic }); h.state.snapshot = { ...semantic, canvasHash: "reviewed" }; });

  it("confirmation accepts semantic JSON reordering and informational geometry only, committing the current reviewed identity", async () => {
    const preview = await capture(); expect(preview).toMatchObject({ code: "BASELINE_CONFIRMATION_REQUIRED", risky: true });
    h.state.snapshot = { ...h.state.snapshot, innerWidth: 1280, innerHeight: 800, screenX: -200, screenY: 42,
      uaHighEntropy: JSON.stringify({ brands: [{ version: "99", brand: "Not.A/Brand" }, { version: "150", brand: "Chromium" }], bitness: "64", architecture: "arm" }),
      workerIdentity: JSON.stringify({ hardwareConcurrency: 8, language: "en-GB" }) };
    const result = await capture({ confirmationToken: preview.confirmationToken });
    expect(result).toMatchObject({ ok: true, baselineCommitted: true, outcome: "risk", risky: true, report: { changes: expect.arrayContaining([
      expect.objectContaining({ field: "canvasHash", severity: "risk" }), expect.objectContaining({ field: "innerWidth", severity: "info", reason: "window-geometry" }),
    ]) } });
    expect(result.report.changes.some((change: any) => change.field.startsWith("uaHighEntropy") || change.field.startsWith("workerIdentity"))).toBe(false);
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(h.state.snapshot);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(h.state.snapshot);
  });

  it.each(["substantive", "required unavailable", "optional unavailable", "invalid geometry"])("confirmation rejects %s recapture without replacing its reference", async (change) => {
    const preview = await capture(); expect(preview.code).toBe("BASELINE_CONFIRMATION_REQUIRED");
    const before = fs.readFileSync(getConfigPath(), "utf8");
    if (change === "substantive") h.state.snapshot = { ...h.state.snapshot, canvasHash: "changed-again" };
    else if (change === "required unavailable") delete h.state.snapshot.canvasHash;
    else if (change === "optional unavailable") h.state.snapshot = { ...h.state.snapshot, workerIdentity: JSON.stringify({ timeout: true }) };
    else h.state.snapshot = { ...h.state.snapshot, innerWidth: 0 };
    expect(await capture({ confirmationToken: preview.confirmationToken })).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE", outcome: "inconclusive" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(semantic);
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(semantic);
  });

  it("initial required-probe loss saves unavailable details but never offers reference acceptance", async () => {
    delete h.state.snapshot.canvasHash;
    const before = fs.readFileSync(getConfigPath(), "utf8"), result = await capture();
    expect(result).toMatchObject({ ok: false, code: "BASELINE_CAPTURE_UNAVAILABLE", outcome: "unavailable", report: { saved: true, baselineCandidate: false,
      changes: expect.arrayContaining([expect.objectContaining({ field: "canvasHash", severity: "unavailable", required: true })]) } });
    expect(result).not.toHaveProperty("confirmationToken"); expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(await driftReport()).toMatchObject({ ok: true, canUpdateBaseline: false, report: { id: result.report.id, observedAt: result.report.observedAt } });
    reloadConfig(); expect(getProfileMeta(PROFILE)?.fingerprintBaseline).toEqual(semantic);
  });
});

describe("cached consistency IPC canonical history", () => {
  const check = (channel = "browser:consistency-check") => h.handlers.get(channel)!({ sender: owner }, PROFILE);
  const canonical = async () => (await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries;

  it.each(["browser:consistency-check", "cloak:consistency-check"])("%s persists a cached no-conflict result as inconclusive, never PASS", async (channel) => {
    const before = structuredClone(disk().browserProfiles[PROFILE]);
    const result = await check(channel);
    expect(result).toMatchObject({ ok: true, warnings: [], blockers: [] });
    expect(disk().profileHealthHistory?.[PROFILE] || []).toContainEqual(expect.objectContaining({ kind: "consistency", outcome: "inconclusive", source: "cached" }));
    reloadConfig();
    expect(await canonical()).toContainEqual(expect.objectContaining({ kind: "consistency", outcome: "inconclusive", source: "cached", requestId: result.requestId }));
    expect(result).toMatchObject({ outcome: "inconclusive", source: "cached" });
    expect(disk().browserProfiles[PROFILE]).toEqual(before);
    expect(h.state.sockets).toEqual([]); expect(h.forbidden).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("stored proxy mismatch is WARN with cached provenance after disk/reload/query", async () => {
    const cfg = structuredClone(getConfig());
    cfg.browserProfiles[PROFILE] = { ...cfg.browserProfiles[PROFILE], fingerprintMode: "managed", locale: "en-GB", proxyMode: "named", proxyName: "cached-proxy" };
    cfg.proxies["cached-proxy"] = { type: "http", host: "proxy.fixture.test", port: 8080 };
    cfg.proxyDetections = { "cached-proxy": { detectedAt: Date.now(), success: true, exitIp: "203.0.113.7", country: "US", countryCode: "US", timezone: "America/New_York", provider: "fixture", latencyMs: 1, org: null, as: null, hosting: false, isProxy: false, error: null } };
    saveConfig(cfg); reloadConfig();
    const result = await check();
    expect(result).toMatchObject({ ok: true, blockers: [], warnings: expect.arrayContaining([expect.objectContaining({ code: "proxy-tz" })]) });
    expect(disk().profileHealthHistory?.[PROFILE] || []).toContainEqual(expect.objectContaining({ kind: "consistency", outcome: "warn", source: "cached" }));
    reloadConfig(); expect(await canonical()).toContainEqual(expect.objectContaining({ kind: "consistency", outcome: "warn", source: "cached" }));
    expect(result).toMatchObject({ outcome: "warn", source: "cached" }); expect(h.state.sockets).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

  it("stored configuration blocker remains RISK and preserves existing result fields", async () => {
    setProfileMeta(PROFILE, { fingerprintMode: "managed", webrtcMode: "altered", webrtcIp: "203.0.113.47", proxyMode: "none" });
    const result = await check();
    expect(result).toMatchObject({ ok: false, warnings: expect.any(Array), blockers: expect.arrayContaining([expect.objectContaining({ severity: "blocker", code: "webrtc-no-proxy" })]) });
    expect(disk().profileHealthHistory?.[PROFILE] || []).toContainEqual(expect.objectContaining({ kind: "consistency", outcome: "risk", source: "cached" }));
    reloadConfig(); expect(await canonical()).toContainEqual(expect.objectContaining({ kind: "consistency", outcome: "risk", source: "cached" }));
    expect(result).toMatchObject({ outcome: "risk", source: "cached" });
  });

  it("viewer retains the original diagnostic read permission without profile mutations", async () => {
    const cfg = structuredClone(getConfig());
    cfg.team = { name: "Viewer workspace", ownerDeviceId: cfg.deviceId!, enabled: true, updatedAt: 1,
      members: [{ deviceId: cfg.deviceId!, name: "Viewer", role: "viewer", addedAt: 1 }] };
    saveConfig(cfg);
    const meta = structuredClone(disk().browserProfiles[PROFILE]);
    expect(await check()).toMatchObject({ ok: true, outcome: "inconclusive", source: "cached" });
    expect(disk().browserProfiles[PROFILE]).toEqual(meta); reloadConfig(); expect(await canonical()).toHaveLength(1);
  });

  it("a busy consistency request cannot cancel or release another diagnostic owner's lease", async () => {
    const existing = beginProfileHealthRun(PROFILE, "env", { requestId: "other-diagnostic", owner: "ipc:48" });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    try {
      expect(await check()).toMatchObject({ ok: false, code: "HEALTH_BUSY", warnings: [], blockers: [] });
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(existing.signal.aborted).toBe(false);
      expect(() => beginProfileHealthRun(PROFILE, "consistency", { owner: "ipc:47" })).toThrow("HEALTH_BUSY");
      expect(await h.handlers.get("browser:health-cancel")!({ sender: owner }, PROFILE, { kind: "env", requestId: existing.requestId })).toMatchObject({ success: false, cancelled: false });
      existing.assertCurrent();
    } finally { existing.finish(); }
  });

  it("failed canonical commit reports the error, leaves disk unchanged and releases only its own lease", async () => {
    const before = fs.readFileSync(getConfigPath(), "utf8"); h.state.renameCalls = 0; h.state.renameFailAt = 1;
    expect(await check()).toMatchObject({ ok: false, outcome: "error", code: "HEALTH_DIAGNOSTIC_FAILED", warnings: [], blockers: [] });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig(); expect(await canonical()).toEqual([]);
    h.state.renameFailAt = 0;
    expect(await check()).toMatchObject({ ok: true, outcome: "inconclusive", source: "cached" });
    expect(disk().profileHealthHistory?.[PROFILE]).toHaveLength(1);
  });
});

const rtcSnapshot = { rtcAvailable: true, candidates: ["candidate:fixture 1 udp 1 fixture.local 4567 typ host"], mdnsHosts: ["fixture.local"], hostIps: [], srflxIps: [], connectionState: "new", gatheringState: "complete", rttMs: null, error: null };
const rtc = (requestId: string) => h.handlers.get("webrtc:diag")!({ sender: owner }, { dirId: PROFILE, requestId });
describe("health IPC owner cancellation and canonical WebRTC history", () => {
  it("completed WebRTC probe commits detailed and canonical facts before readback", async () => {
    h.state.snapshot = rtcSnapshot;
    const result = await rtc("rtc-completed");
    expect(result).toMatchObject({ ok: true, outcome: "pass", requestId: "rtc-completed" });
    expect(disk().webrtcDiagnostics[PROFILE][0]).toMatchObject({ outcome: "pass", requestId: "rtc-completed" });
    expect(disk().profileHealthHistory[PROFILE][0]).toMatchObject({ kind: "webrtc", outcome: "pass" });
    reloadConfig();
    expect((await h.handlers.get("webrtc:diag-history")!({ sender: owner }, PROFILE)).entries[0].requestId).toBe("rtc-completed");
    expect((await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries[0].outcome).toBe("pass");
  });

  it("empty/error probe evidence never earns PASS and a later result does not erase risk", async () => {
    h.state.snapshot = { ...rtcSnapshot, hostIps: ["192.0.2.5"] };
    expect(await rtc("rtc-risk")).toMatchObject({ outcome: "risk" });
    h.state.snapshot = { ...rtcSnapshot, candidates: [], mdnsHosts: [], gatheringState: "new", error: "timeout" };
    expect(await rtc("rtc-error")).toMatchObject({ ok: false, outcome: "error" });
    reloadConfig();
    const history = await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE);
    expect(history.entries.map((entry: any) => entry.outcome)).toContain("risk");
    expect(history.entries.at(-1).outcome).not.toBe("pass");
  });

  it("cancelled native work keeps its lease until actual finally and cannot publish late results", async () => {
    let release!: (value: unknown) => void;
    let entered = false;
    h.state.evaluate = () => { entered = true; return new Promise((resolve) => { release = resolve; }); };
    const pending = rtc("rtc-cancelled");
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await h.handlers.get("browser:health-cancel")!({ sender: owner }, PROFILE, { kind: "webrtc", requestId: "rtc-cancelled" })).toMatchObject({ success: true, cancelled: true });
    expect(await h.handlers.get("browser:env-risk")!({ sender: owner }, { dirId: PROFILE, requestId: "env-overlap" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
    release(rtcSnapshot);
    expect(await pending).toMatchObject({ ok: false, outcome: "cancelled" });
    expect(disk().webrtcDiagnostics?.[PROFILE] || []).toEqual([]);
    expect(disk().profileHealthHistory?.[PROFILE] || []).toEqual([]);
    h.state.evaluate = undefined; h.state.snapshot = rtcSnapshot;
    expect(await rtc("rtc-after-cancel")).toMatchObject({ ok: true, outcome: "pass" });
  });

  it("clearing and renderer destruction invalidate native work before any late history commit", async () => {
    let release!: (value: unknown) => void;
    let entered = false;
    h.state.evaluate = () => { entered = true; return new Promise((resolve) => { release = resolve; }); };
    const pending = rtc("rtc-clear");
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await h.handlers.get("webrtc:diag-clear")!({ sender: owner }, PROFILE)).toEqual({ success: true });
    release(rtcSnapshot); expect(await pending).toMatchObject({ ok: false, outcome: "cancelled" });
    expect((await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries).toEqual([]);
    entered = false;
    const destroyed = rtc("rtc-destroyed"); await vi.waitFor(() => expect(entered).toBe(true));
    owner.emit("destroyed"); release(rtcSnapshot);
    expect(await destroyed).toMatchObject({ ok: false, outcome: "cancelled" });
    expect(disk().webrtcDiagnostics?.[PROFILE] || []).toEqual([]);
    expect(owner.listenerCount("destroyed")).toBe(0);
  });
});
