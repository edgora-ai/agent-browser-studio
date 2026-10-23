import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "ipc-browser-"));
  const forbidden = vi.fn((...args: unknown[]) => { throw new Error(`Undeclared native capability: ${String(args[0])}`); });
  const execFileSync = vi.fn((...args: unknown[]) => forbidden(...args));
  const findBrowserByProfileSync = vi.fn<typeof import("../../src/main/services/process-discovery.js").findBrowserByProfileSync>(() => null);
  return { root, handlers: new Map<string, (...args: any[]) => any>(), forbidden, execFileSync, findBrowserByProfileSync };
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
  screen: { getPrimaryDisplay: h.forbidden },
  dialog: { showOpenDialog: h.forbidden },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden,
  execFileSync: h.execFileSync, spawn: h.forbidden, spawnSync: h.forbidden,
}));

// Only runtime discovery is synthetic. Keep the real IPC, lifecycle and
// license/team gates, without permitting either Unix or Windows host commands.
vi.mock("../../src/main/services/process-discovery.js", async (original) => ({
  ...await original<typeof import("../../src/main/services/process-discovery.js")>(),
  findBrowserByProfileSync: h.findBrowserByProfileSync,
}));

import { registerBrowserHandlers } from "../../src/main/ipc/browser.js";
import { registerWebRtcHandlers } from "../../src/main/ipc/webrtc.js";
import { getConfig, getConfigPath, getProfilesDir, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";
registerBrowserHandlers();
registerWebRtcHandlers();
const PROFILE = "ab_ipc_browser";
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
function sender(id = 1) {
  return Object.assign(new EventEmitter(), { id, send: vi.fn(), isDestroyed: vi.fn(() => false) });
}
const invoke = (channel: string, event: any, ...args: any[]) => h.handlers.get(channel)!(event, ...args);
function role(value: "owner" | "viewer") {
  const cfg = structuredClone(getConfig());
  cfg.team = { name: "IPC workspace", enabled: true, ownerDeviceId: cfg.deviceId!, updatedAt: 1,
    members: [{ deviceId: cfg.deviceId!, name: "IPC device", role: value, addedAt: 1 }] };
  saveConfig(cfg);
}

beforeEach(() => {
  h.findBrowserByProfileSync.mockReset().mockReturnValue(null);
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.mkdirSync(h.root);
  reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.browserProfiles[PROFILE] = { name: "IPC browser fixture", fingerprintSeed: 12345, fingerprintMode: "off", proxyMode: "none", platform: "macos" } as any;
  saveConfig(cfg);
  h.forbidden.mockClear();
  h.execFileSync.mockClear();
  vi.stubGlobal("fetch", h.forbidden);
});
afterEach(() => {
  for (const entry of runningProcesses.values()) if (entry.killTimer) clearTimeout(entry.killTimer);
  runningProcesses.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(h.forbidden).not.toHaveBeenCalled();
  expect(h.execFileSync).not.toHaveBeenCalled();
});
afterAll(() => fs.rmSync(h.root, { recursive: true, force: true }));

describe("real browser IPC security", () => {
  it("all browser routes retain their cloak alias without duplicate channel registration", () => {
    for (const [channel, handler] of h.handlers) {
      if (channel.startsWith("browser:")) expect(h.handlers.get(channel.replace("browser:", "cloak:"))).toBe(handler);
    }
    expect(() => registerBrowserHandlers()).toThrow("Duplicate IPC channel");
  });

  it.each(["browser:set-seed", "cloak:set-seed"])("%s respects another device's checkout lock before writing", async (channel) => {
    const cfg = structuredClone(getConfig());
    cfg.browserProfiles[PROFILE].lock = { owner: "other-device", ownerName: "Other device", at: 1 };
    saveConfig(cfg);
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const result = await invoke(channel, { sender: sender() }, { dirId: PROFILE, seed: 67890 });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("locked") });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig();
    expect(disk().browserProfiles[PROFILE].fingerprintSeed).toBe(12345);
    expect((await invoke("browser:list", { sender: sender() })).find((entry: any) => entry.dirId === PROFILE).fingerprintSeed).toBe(12345);
  });

  it("seed writes use partial validated metadata and persist through disk/reload/query", async () => {
    expect(await invoke("browser:set-seed", { sender: sender() }, { dirId: PROFILE, seed: 67890 })).toEqual({ success: true });
    expect(disk().browserProfiles[PROFILE]).toMatchObject({ name: "IPC browser fixture", fingerprintSeed: 67890, proxyMode: "none" });
    reloadConfig();
    expect((await invoke("browser:list", { sender: sender() })).find((entry: any) => entry.dirId === PROFILE).fingerprintSeed).toBe(67890);
    expect(await invoke("browser:set-seed", { sender: sender() }, { dirId: PROFILE, seed: -1 })).toMatchObject({ success: false });
    expect(disk().browserProfiles[PROFILE].fingerprintSeed).toBe(67890);
  });

  it("viewer launch is denied by existing team policy before any native capability", async () => {
    role("viewer");
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const result = await invoke("browser:launch", { sender: sender() }, { dirId: PROFILE });
    expect(result).toMatchObject({ success: false, error: "requires member role (current: viewer)" });
    expect(h.forbidden).not.toHaveBeenCalled();
    expect(h.execFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  it("WebRTC explicit auto-launch cannot bypass an expired license", async () => {
    const cfg = structuredClone(getConfig()) as any;
    cfg.trialStartedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    saveConfig(cfg);
    const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await invoke("webrtc:diag", { sender: sender() }, { dirId: PROFILE, allowLaunch: true, requestId: "rtc-expired" })).toMatchObject({ ok: false, code: "LICENSE_EXPIRED" });
    expect(h.findBrowserByProfileSync).toHaveBeenCalledExactlyOnceWith(PROFILE, path.join(getProfilesDir(), PROFILE), { strict: true });
    expect(h.forbidden).not.toHaveBeenCalled();
    expect(h.execFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig();
    expect((await invoke("browser:list", { sender: sender() })).find((entry: any) => entry.dirId === PROFILE)).toMatchObject({ name: "IPC browser fixture", fingerprintSeed: 12345 });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  it("WebRTC explicit auto-launch cannot bypass the team launch policy", async () => {
    role("viewer");
    const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await invoke("webrtc:diag", { sender: sender() }, { dirId: PROFILE, allowLaunch: true, requestId: "rtc-viewer" })).toMatchObject({ ok: false, code: "TEAM_ROLE_DENIED" });
    expect(h.findBrowserByProfileSync).toHaveBeenCalledExactlyOnceWith(PROFILE, path.join(getProfilesDir(), PROFILE), { strict: true });
    expect(h.forbidden).not.toHaveBeenCalled();
    expect(h.execFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    reloadConfig();
    expect((await invoke("browser:list", { sender: sender() })).find((entry: any) => entry.dirId === PROFILE)).toMatchObject({ name: "IPC browser fixture", fingerprintSeed: 12345 });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  it("expired trial blocks single and batch launches before native I/O", async () => {
    const cfg = structuredClone(getConfig()) as any;
    cfg.trialStartedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    saveConfig(cfg);
    const event = { sender: sender() };
    expect(await invoke("browser:launch", event, { dirId: PROFILE })).toMatchObject({ success: false, code: "LICENSE_EXPIRED" });
    expect(await invoke("browser:batch-launch", event, { dirIds: [PROFILE], jobId: "expired-trial" })).toMatchObject({ succeeded: 0, failed: 1, results: [{ code: "LICENSE_EXPIRED" }] });
    expect(h.forbidden).not.toHaveBeenCalled();
    expect(h.execFileSync).not.toHaveBeenCalled();
  });
});

describe("batch owner and lifetime", () => {
  it("an active jobId cannot be overwritten by either launch or stop", async () => {
    const event = { sender: sender() };
    const first = invoke("browser:batch-stop", event, { dirIds: [PROFILE, PROFILE], concurrency: 1, jobId: "collision" });
    const duplicate = invoke("browser:batch-launch", event, { dirIds: [PROFILE], jobId: "collision" });
    const result = await duplicate;
    expect(result).toMatchObject({ success: false, code: "BATCH_JOB_CONFLICT" });
    await first;
  });

  it("foreign sender cannot cancel another window's active job", async () => {
    const owner = { sender: sender(1) };
    const pending = invoke("browser:batch-stop", owner, { dirIds: [PROFILE, PROFILE], concurrency: 1, jobId: "owned" });
    const foreign = await invoke("browser:batch-cancel", { sender: sender(2) }, "owned");
    expect(foreign).toMatchObject({ success: false });
    expect(await invoke("browser:batch-cancel", owner, "owned")).toMatchObject({ success: true });
    expect(await pending).toMatchObject({ cancelled: true });
  });

  it("destroyed owner cancels queued work and does not send progress to a dead window", async () => {
    const webContents = sender(3);
    const pending = invoke("browser:batch-stop", { sender: webContents }, { dirIds: [PROFILE, PROFILE, PROFILE], concurrency: 1, jobId: "destroyed" });
    webContents.isDestroyed.mockReturnValue(true);
    webContents.emit("destroyed");
    expect(await pending).toMatchObject({ cancelled: true, succeeded: 0 });
    expect(webContents.send).not.toHaveBeenCalled();
    expect(await invoke("browser:batch-cancel", { sender: webContents }, "destroyed")).toMatchObject({ success: false });
    expect(webContents.listenerCount("destroyed")).toBe(0);
  });

  it("owner listener setup failure cannot leak a jobId reservation", async () => {
    const broken = sender(5);
    vi.spyOn(broken, "once").mockImplementationOnce(() => { throw new Error("fixture listener failed"); });
    await expect(invoke("browser:batch-stop", { sender: broken }, { dirIds: [PROFILE], jobId: "setup-failed" })).rejects.toThrow("fixture listener failed");
    expect(await invoke("browser:batch-stop", { sender: sender(6) }, { dirIds: [PROFILE], jobId: "setup-failed" })).toMatchObject({ jobId: "setup-failed", failed: 1 });
  });

  it("batch validation, empty sets and bounded concurrency preserve truthful outcomes", async () => {
    const event = { sender: sender(7) };
    for (const params of [null, { dirIds: [null] }, { dirIds: ["../escape"] }, { dirIds: [PROFILE], jobId: {} }]) expect(await invoke("browser:batch-stop", event, params)).toMatchObject({ success: false, code: "BATCH_INVALID_ARGUMENT" });
    expect(await invoke("browser:batch-stop", event, { dirIds: [], jobId: "empty" })).toMatchObject({ total: 0, succeeded: 0, failed: 0, results: [] });
    const { max } = await invoke("browser:batch-max-concurrency", event);
    const result = await invoke("browser:batch-stop", event, { dirIds: [PROFILE, PROFILE], concurrency: 999, jobId: "bounded" });
    expect(result).toMatchObject({ concurrency: max, total: 2, failed: 2 });
    expect(event.sender.send).toHaveBeenLastCalledWith("batch:progress", expect.objectContaining({ jobId: "bounded", kind: "stop", done: 2, total: 2 }));
  });

  it("progress send errors do not turn real item failures into successful work or leak ownership", async () => {
    const webContents = sender(8); webContents.send.mockImplementation(() => { throw new Error("window closing"); });
    expect(await invoke("browser:batch-stop", { sender: webContents }, { dirIds: [PROFILE, PROFILE], jobId: "send-failed" })).toMatchObject({ failed: 2, succeeded: 0 });
    expect(await invoke("browser:batch-cancel", { sender: webContents }, "send-failed")).toMatchObject({ success: false });
    expect(webContents.listenerCount("destroyed")).toBe(0);
  });

  it("finished jobs cannot be cancelled; errors release the id for reuse", async () => {
    const event = { sender: sender(4) };
    const params = { dirIds: [PROFILE], jobId: "reuse" };
    expect(await invoke("browser:batch-stop", event, params)).toMatchObject({ failed: 1, results: [{ error: "Stop failed" }] });
    expect(await invoke("browser:batch-cancel", event, "reuse")).toMatchObject({ success: false });
    expect(await invoke("cloak:batch-stop", event, params)).toMatchObject({ jobId: "reuse", failed: 1 });
    expect(event.sender.listenerCount("destroyed")).toBe(0);
  });
});
