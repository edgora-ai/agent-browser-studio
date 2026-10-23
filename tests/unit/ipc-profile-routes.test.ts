import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const h = vi.hoisted(() => {
  const fs = require("node:fs"); const path = require("node:path");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "ipc-profile-"));
  delete process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH;
  const forbidden = vi.fn((...args: unknown[]) => { throw new Error(`Undeclared native capability: ${String(args[0])}`); });
  const findBrowserByProfileSync = vi.fn<typeof import("../../src/main/services/process-discovery.js").findBrowserByProfileSync>(() => null);
  const findCdpPortSync = vi.fn<typeof import("../../src/main/services/process-discovery.js").findCdpPortSync>(() => null);
  const getRunningProcessesAsync = vi.fn<typeof import("../../src/main/services/process-discovery.js").getRunningProcessesAsync>(async () => []);
  return { root, handlers: new Map<string, (...args: any[]) => any>(), forbidden, openDialog: vi.fn(), saveDialog: vi.fn(), confirm: vi.fn(),
    findBrowserByProfileSync, findCdpPortSync, getRunningProcessesAsync };
});
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: any) => { if (h.handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`); h.handlers.set(channel, handler); } },
  app: { getPath: (name: string) => { if (["userData", "home", "downloads", "documents", "desktop", "temp"].includes(name)) return h.root; throw new Error(`Unexpected Electron path: ${name}`); } },
  BrowserWindow: { getAllWindows: () => [] }, screen: { getPrimaryDisplay: h.forbidden },
  dialog: { showOpenDialog: h.openDialog, showSaveDialog: h.saveDialog, showMessageBox: h.confirm },
}));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(),
  exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden,
  execFileSync: h.forbidden, spawn: h.forbidden, spawnSync: h.forbidden,
}));
// These owned fixtures have no runtime. Isolate the discovery entry points,
// not lifecycle refusal, cookie validation, config/files or archive operations.
// findCdpPortSync has its own internal lookup, so it needs its own boundary.
vi.mock("../../src/main/services/process-discovery.js", async (original) => ({
  ...await original<typeof import("../../src/main/services/process-discovery.js")>(),
  findBrowserByProfileSync: h.findBrowserByProfileSync,
  findCdpPortSync: h.findCdpPortSync,
  getRunningProcessesAsync: h.getRunningProcessesAsync,
}));

import { registerProfileHandlers } from "../../src/main/ipc/profile.js";
import { getConfig, getConfigPath, getProfilesDir, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
registerProfileHandlers();
const invoke = (channel: string, ...args: any[]) => h.handlers.get(channel)!({ sender: { id: 47 } }, ...args);
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
function role(value: "owner" | "viewer") {
  const cfg = structuredClone(getConfig()); cfg.team = { name: "IPC team", ownerDeviceId: cfg.deviceId!, enabled: true, updatedAt: 1,
    members: [{ deviceId: cfg.deviceId!, name: "IPC device", role: value, addedAt: 1 }] }; saveConfig(cfg);
}
async function create(name = "IPC fixture") {
  return invoke("profile:create", { name, fingerprintSeed: 23456, platform: "macos", timezone: "Europe/London", locale: "en-GB", proxyMode: "none" });
}
beforeEach(() => {
  h.findBrowserByProfileSync.mockReset().mockReturnValue(null);
  h.findCdpPortSync.mockReset().mockReturnValue(null);
  h.getRunningProcessesAsync.mockReset().mockResolvedValue([]);
  fs.rmSync(h.root, { recursive: true, force: true }); fs.mkdirSync(h.root); reloadConfig(); getConfig();
  h.forbidden.mockClear(); h.openDialog.mockReset(); h.saveDialog.mockReset(); h.confirm.mockReset();
});
afterEach(() => { expect(h.forbidden).not.toHaveBeenCalled(); });
afterAll(() => fs.rmSync(h.root, { recursive: true, force: true }));

describe("profile IPC with real profile, trash and archive stores", () => {
  it("creates, reads, renames and deletes profiles with disk/reload/list verification", async () => {
    const created = await create(); expect(created.dirId).toMatch(/^(?:ab|cloak|browser|cloaking|profile)_/);
    const id = created.dirId;
    expect(fs.existsSync(path.join(getProfilesDir(), id, "Default"))).toBe(true);
    expect(disk().browserProfiles[id]).toMatchObject({ name: "IPC fixture", fingerprintSeed: 23456 });
    reloadConfig(); expect(await invoke("profile:get", id)).toMatchObject({ dirId: id, name: "IPC fixture" });
    expect(await invoke("profile:rename", { dirId: id, name: "Renamed fixture" })).toEqual({ success: true });
    expect(disk().browserProfiles[id].name).toBe("Renamed fixture"); reloadConfig();
    expect(await invoke("profile:list")).toContainEqual(expect.objectContaining({ dirId: id, name: "Renamed fixture" }));
    expect(await invoke("profile:delete", id)).toEqual({ success: true }); expect(disk().browserProfiles[id]).toBeUndefined();
    expect(fs.existsSync(path.join(getProfilesDir(), id))).toBe(false); reloadConfig(); expect(await invoke("profile:list")).toEqual([]);
  });

  it("existing service checkout and team gates protect rename/delete/trash without duplicated IPC policies", async () => {
    const { dirId } = await create();
    const cfg = structuredClone(getConfig()); cfg.browserProfiles[dirId].lock = { owner: "other-device", ownerName: "Other", at: 1 }; saveConfig(cfg);
    const locked = fs.readFileSync(getConfigPath(), "utf8");
    for (const [channel, input] of [["profile:rename", { dirId, name: "Denied" }], ["profile:delete", dirId], ["profile:trash", dirId]] as Array<[string, any]>) expect(await invoke(channel, input)).toMatchObject({ success: false, error: expect.stringContaining("locked") });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(locked);
    role("viewer"); const denied = fs.readFileSync(getConfigPath(), "utf8");
    for (const channel of ["profile:delete", "profile:trash", "profile:trash-restore", "profile:trash-purge"]) expect(await invoke(channel, dirId)).toMatchObject({ success: false, error: "requires member role (current: viewer)" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(denied);
  });

  it("soft delete, restore, permanent purge and missing entries report real disk state", async () => {
    const { dirId } = await create(); fs.writeFileSync(path.join(getProfilesDir(), dirId, "Default", "fixture"), "profile content");
    expect(await invoke("profile:trash", dirId)).toEqual({ success: true }); expect(disk().browserProfiles[dirId]).toBeUndefined(); reloadConfig();
    expect((await invoke("profile:trash-list")).entries).toContainEqual(expect.objectContaining({ dirId }));
    expect(await invoke("profile:trash-restore", dirId)).toEqual({ success: true }); expect(fs.readFileSync(path.join(getProfilesDir(), dirId, "Default", "fixture"), "utf8")).toBe("profile content");
    expect(disk().browserProfiles[dirId].name).toBe("IPC fixture"); reloadConfig(); expect(await invoke("profile:get", dirId)).toMatchObject({ name: "IPC fixture" });
    expect(await invoke("profile:trash", dirId)).toEqual({ success: true }); expect(await invoke("profile:trash-purge", dirId)).toEqual({ success: true });
    expect((await invoke("profile:trash-list")).entries).toEqual([]);
    expect(await invoke("profile:trash-restore", dirId)).toMatchObject({ success: false }); expect(await invoke("profile:trash-purge", dirId)).toMatchObject({ success: false });
  });

  it("archive IPC preserves explicit overwrite/cancel results and round-trips real bytes", async () => {
    const { dirId } = await create(); fs.writeFileSync(path.join(getProfilesDir(), dirId, "Default", "archive-fixture"), "portable profile bytes");
    const destPath = path.join(h.root, "profile.zip");
    const exported = await invoke("profile:export-archive", { dirId, destPath }); expect(exported).toMatchObject({ success: true, outcome: "completed", filePath: destPath });
    expect(fs.readFileSync(destPath).subarray(0, 2).toString()).toBe("PK");
    const before = fs.readFileSync(destPath);
    expect(await invoke("profile:export-archive", { dirId, destPath, overwrite: false })).toMatchObject({ success: false }); expect(fs.readFileSync(destPath)).toEqual(before);
    expect(await invoke("profile:export-archive", { dirId, destPath, overwrite: true })).toMatchObject({ success: true, outcome: "completed" });
    const imported = await invoke("profile:import-archive", { zipPath: destPath }); expect(imported).toMatchObject({ success: true, outcome: "completed" });
    expect(fs.readFileSync(path.join(getProfilesDir(), imported.dirId, "Default", "archive-fixture"), "utf8")).toBe("portable profile bytes");
    expect(disk().browserProfiles[imported.dirId].name).toBeTruthy(); reloadConfig(); expect((await invoke("profile:list")).map((entry: any) => entry.dirId)).toContain(imported.dirId);
    h.saveDialog.mockResolvedValue({ canceled: true }); expect(await invoke("profile:export-archive", { dirId })).toMatchObject({ success: false, cancelled: true, code: "ARCHIVE_CANCELLED" });
    h.openDialog.mockResolvedValue({ canceled: true }); expect(await invoke("profile:import-archive")).toMatchObject({ success: false, cancelled: true });
  });

  it("batch archive routers preserve current reports, user-picked overwrite consent and invalid arguments", async () => {
    const { dirId } = await create(); const destDir = path.join(h.root, "backups"); fs.mkdirSync(destDir);
    const first = await invoke("profile:export-archives", { dirIds: [dirId], destDir }); expect(first).toMatchObject({ success: true, outcome: "completed" });
    const paths = fs.readdirSync(destDir).map((name) => path.join(destDir, name)); expect(paths).toHaveLength(1);
    expect(await invoke("profile:import-archives", { zipPaths: paths })).toMatchObject({ success: true, outcome: "completed" });
    expect(Object.keys(disk().browserProfiles).length).toBe(2); reloadConfig(); expect((await invoke("profile:list")).length).toBe(2);
    h.openDialog.mockResolvedValue({ canceled: false, filePaths: [destDir] }); h.confirm.mockResolvedValue({ response: 0 });
    expect(await invoke("profile:export-archives", { dirIds: [dirId] })).toMatchObject({ success: false, cancelled: true });
    h.confirm.mockResolvedValue({ response: 1 }); expect(await invoke("profile:export-archives", { dirIds: [dirId] })).toMatchObject({ success: true });
    for (const params of [{ dirIds: [], destDir }, { dirIds: [dirId], destDir, overwrite: "yes" }, { dirIds: [null], destDir }]) expect(await invoke("profile:export-archives", params)).toMatchObject({ success: false });
    expect(await invoke("profile:import-archives", { zipPaths: [] })).toMatchObject({ success: false });
    h.openDialog.mockResolvedValue({ canceled: true }); expect(await invoke("profile:import-archives")).toMatchObject({ success: false, cancelled: true });
    expect(await invoke("profile:export-archive", { dirId, destPath: path.join(h.root, "wrong.txt") })).toMatchObject({ success: false });
    expect(await invoke("profile:import-archive", { zipPath: path.join(h.root, "missing.zip") })).toMatchObject({ success: false });
  });

  it.each(["unknown", "running"] as const)("%s runtime refuses delete/trash and archives while conserving real stored bytes", async (runtime) => {
    const { dirId } = await create();
    const profileDir = path.join(getProfilesDir(), dirId), sentinel = path.join(profileDir, "Default", "refusal-fixture");
    fs.writeFileSync(sentinel, "owned refusal bytes");
    const index = path.join(h.root, "trash", "index.json");
    fs.mkdirSync(path.dirname(index), { recursive: true }); fs.writeFileSync(index, "[]");
    const destDir = path.join(h.root, "refused-exports"), destPath = path.join(destDir, "unchanged.zip");
    fs.mkdirSync(destDir);
    expect(await invoke("profile:export-archive", { dirId, destPath })).toMatchObject({ success: true, outcome: "completed" });
    const savedArchive = fs.readFileSync(destPath), savedConfig = fs.readFileSync(getConfigPath(), "utf8"), savedIndex = fs.readFileSync(index, "utf8");
    const savedMeta = structuredClone(disk().browserProfiles[dirId]);
    h.findBrowserByProfileSync.mockClear();
    if (runtime === "unknown") {
      h.findBrowserByProfileSync.mockImplementation(() => {
        throw Object.assign(new Error("Synthetic process discovery unavailable"), { code: "PROCESS_DISCOVERY_UNAVAILABLE" });
      });
    } else {
      // Exercise the real running-owner refusal without adopting a fake PID
      // that a later readback would probe with a real process operation.
      h.findBrowserByProfileSync.mockReturnValue({ pid: 1234, cdpPort: 0, unknown: true });
    }
    const reason = runtime === "unknown" ? /runtime state is unknown/ : /while managed Chromium is running/;
    for (const channel of ["profile:delete", "profile:trash"]) {
      expect(await invoke(channel, dirId)).toMatchObject({ success: false, error: expect.stringMatching(reason) });
    }
    expect(await invoke("profile:export-archive", { dirId, destPath, overwrite: true })).toMatchObject({
      success: false, outcome: "failed", code: "PROFILE_STOP_REQUIRED",
    });
    expect(await invoke("profile:export-archives", { dirIds: [dirId], destDir, overwrite: true })).toEqual({
      success: false, outcome: "skipped", report: { exported: [], failed: [], skipped: [{ dirId, reason: "running-or-unconfirmed", code: "PROFILE_STOP_REQUIRED" }] },
    });
    expect(h.findBrowserByProfileSync.mock.calls).toEqual(Array.from({ length: 4 }, () => [dirId, profileDir, { strict: true }]));
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(savedConfig);
    expect(fs.readFileSync(index, "utf8")).toBe(savedIndex);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("owned refusal bytes");
    expect(fs.readFileSync(destPath)).toEqual(savedArchive);
    expect(fs.readdirSync(destDir)).toEqual(["unchanged.zip"]);
    expect(fs.existsSync(path.join(h.root, "trash", "profiles", dirId))).toBe(false);
    h.findBrowserByProfileSync.mockReset().mockReturnValue(null);
    reloadConfig();
    expect(disk().browserProfiles[dirId]).toEqual(savedMeta);
    expect(await invoke("profile:get", dirId)).toMatchObject({ dirId, name: "IPC fixture" });
    expect(await invoke("profile:list")).toContainEqual(expect.objectContaining({ dirId, name: "IPC fixture", fingerprint: expect.objectContaining({ fingerprintSeed: 23456 }) }));
    expect((await invoke("profile:trash-list")).entries).toEqual([]);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(savedConfig);
    expect(fs.readFileSync(index, "utf8")).toBe(savedIndex);
  });

  it("invalid IDs/cookie parameters and stopped-profile mutation fail before native capabilities", async () => {
    const { dirId } = await create();
    expect(await invoke("profile:cookies", { dirId, filter: "needle" })).toEqual([]);
    expect(await invoke("profile:set-cookie", { dirId, domain: "example.test", name: "session", value: "fixture" })).toMatchObject({ success: false, error: expect.stringContaining("Launch") });
    expect(await invoke("profile:delete-cookie", { dirId, domain: "example.test", name: "session" })).toMatchObject({ success: false, error: expect.stringContaining("Launch") });
    for (const channel of ["profile:delete", "profile:trash", "profile:trash-restore", "profile:trash-purge"]) expect(await invoke(channel, "../escape")).toMatchObject({ success: false });
    expect(await invoke("profile:rename", { dirId: "../escape", name: "bad" })).toMatchObject({ success: false });
    await expect(invoke("profile:get", "../escape")).rejects.toThrow(); await expect(invoke("profile:cookies", { dirId: "../escape" })).rejects.toThrow();
    expect(await invoke("profile:set-cookie", { dirId, domain: "invalid domain", name: "session", value: "fixture" })).toMatchObject({ success: false });
    expect(await invoke("profile:delete-cookie", { dirId, domain: "example.test", name: "invalid;name" })).toMatchObject({ success: false });
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("expired trial blocks the legacy create entry without touching existing profiles", async () => {
    const cfg = structuredClone(getConfig()) as any; cfg.trialStartedAt = Date.now() - 30 * 24 * 60 * 60 * 1000; saveConfig(cfg);
    const before = fs.readFileSync(getConfigPath(), "utf8"); expect(await create()).toMatchObject({ success: false, code: "LICENSE_EXPIRED" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before); expect(await invoke("profile:list")).toEqual([]);
  });
});
