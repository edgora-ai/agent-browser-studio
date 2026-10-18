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
  const state = { snapshot: {} as Record<string, unknown>, evaluate: undefined as undefined | (() => any), sockets: [] as any[], commands: [] as { url: string; method: string }[], error: "", renameFailAt: 0, renameCalls: 0, auditWriteFail: false, auditRefusals: 0 };
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
    if (String(destination) === `${h.root}/config.json` && h.state.renameFailAt && ++h.state.renameCalls === h.state.renameFailAt) {
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
import { getConfig, getConfigPath, reloadConfig, saveConfig, setProfileMeta } from "../../src/main/services/config-manager.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";
import { beginProfileHealthRun, recordProfileHealthResult } from "../../src/main/services/profile-health.js";
registerBrowserHandlers();
registerWebRtcHandlers();
const PROFILE = "ab_ipc_health";
const BASELINE = { platform: "MacIntel", userAgent: "Fixture Browser", plugins: "PDF Viewer", tz: "Europe/London", canvasHash: "old" };
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const owner = Object.assign(new EventEmitter(), { id: 47, isDestroyed: () => false });
const invoke = (payload: unknown, sender: any = owner) => h.handlers.get("browser:capture-baseline")!({ sender }, payload);
const capture = (options?: { confirmationToken?: string }, sender: any = owner) => invoke(options ? { dirId: PROFILE, ...options } : PROFILE, sender);
beforeEach(() => {
  h.state.renameFailAt = 0; h.state.renameCalls = 0; h.state.auditWriteFail = false; h.state.auditRefusals = 0;
  fs.rmSync(h.root, { recursive: true, force: true }); fs.mkdirSync(h.root);
  reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.browserProfiles[PROFILE] = { name: "Health fixture", fingerprintSeed: 12345, fingerprintMode: "off", platform: "macos", timezone: "Europe/London", fingerprintBaseline: BASELINE } as any;
  saveConfig(cfg);
  runningProcesses.set(PROFILE, { pid: 987654, process: null, port: 45671, engine: "chromium", lastActivityAt: 1 });
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: unknown) => {
    if (pid === 987654 && signal === 0) return true;
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
  for (const socket of h.state.sockets) expect(socket.closed).toBe(true);
  owner.emit("destroyed");
  runningProcesses.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
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

  it("risky persona mismatch needs confirmation even without a prior baseline", async () => {
    const cfg = structuredClone(getConfig()); delete cfg.browserProfiles[PROFILE].fingerprintBaseline; saveConfig(cfg);
    h.state.snapshot = { ...BASELINE, platform: "Win32" };
    expect(await capture()).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", risky: true });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toBeUndefined();
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

  it("new stable baseline is established, not an earned health pass", async () => {
    const cfg = structuredClone(getConfig()); delete cfg.browserProfiles[PROFILE].fingerprintBaseline; saveConfig(cfg);
    h.state.snapshot = BASELINE;
    expect(await capture()).toMatchObject({ ok: true, outcome: "baseline-established", risky: false });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
    reloadConfig();
    expect(getConfig().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
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
    h.state.renameCalls = 0; h.state.renameFailAt = 2;
    expect(await capture()).toMatchObject({ ok: true, baselineCommitted: true, code: "HEALTH_HISTORY_WRITE_FAILED", warning: expect.stringContaining("Baseline saved") });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline.language).toBe("en-GB");
    reloadConfig(); expect(getConfig().browserProfiles[PROFILE].fingerprintBaseline?.language).toBe("en-GB");
  });

  it.each([false, true])("native audit EACCES cannot erase baseline commit facts (history failure: %s)", async (historyFails) => {
    h.state.snapshot = { ...BASELINE, language: "en-GB" };
    h.state.renameFailAt = historyFails ? 2 : 0;
    h.state.auditWriteFail = true;
    const result = await capture();
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
    const before = fs.readFileSync(getConfigPath(), "utf8");
    h.state.renameFailAt = 1; h.state.auditWriteFail = true;
    const result = await capture();
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
  ] as const)("capture uses $runtime runtime rather than saved $intent intent", async ({ runtime, intent, expected }) => {
    setProfileMeta(PROFILE, { engine: intent });
    const entry = runningProcesses.get(PROFILE)!;
    if (runtime === "legacy") delete entry.engine;
    else entry.engine = runtime;
    h.state.snapshot = BASELINE;
    const result = await capture();
    expect(result).toMatchObject({ ok: true, baselineCommitted: true, outcome: "baseline-established" });
    const url = expected === "firefox" ? "ws://127.0.0.1:45671/session" : "ws://127.0.0.1:45671/devtools/page/ipc-fixture";
    expect(h.state.sockets.map((socket) => socket.url)).toEqual([url]);
    expect(h.state.commands).toContainEqual({ url, method: expected === "firefox" ? "script.evaluate" : "Runtime.evaluate" });
    if (expected === "firefox") expect(fetch).not.toHaveBeenCalled();
    expect(disk().browserProfiles[PROFILE]).toMatchObject({ engine: intent, fingerprintBaseline: BASELINE });
    reloadConfig();
    expect(getConfig().browserProfiles[PROFILE]).toMatchObject({ engine: intent, fingerprintBaseline: BASELINE });
    expect((await h.handlers.get("browser:health-history")!({ sender: owner }, PROFILE)).entries).toContainEqual(expect.objectContaining({ requestId: result.requestId, outcome: "baseline-established" }));
  });

  it("native evaluation failure is explicit and does not change baseline", async () => {
    h.state.error = "CDP fixture refused evaluation";
    expect(await capture()).toMatchObject({ ok: false, error: expect.stringContaining("CDP fixture refused") });
    expect(disk().browserProfiles[PROFILE].fingerprintBaseline).toEqual(BASELINE);
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
