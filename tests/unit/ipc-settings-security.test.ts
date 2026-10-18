import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "ipc-settings-"));
  const forbidden = vi.fn((...args: unknown[]) => { throw new Error(`Undeclared native capability: ${String(args[0])}`); });
  return { root, handlers: new Map<string, (...args: any[]) => any>(), forbidden, picker: vi.fn() };
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
  dialog: { showOpenDialog: h.picker },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden,
  execFileSync: h.forbidden, spawn: h.forbidden, spawnSync: h.forbidden,
}));

import { registerSettingsHandlers } from "../../src/main/ipc/settings.js";
import { getConfig, getConfigPath, getProfilesDir, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
registerSettingsHandlers();
const PROFILE = "ab_ipc_settings";
const EXT = "a".repeat(32);
const invoke = (channel: string, ...args: any[]) => h.handlers.get(channel)!({ sender: { id: 1 } }, ...args);
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
function role(value: "owner" | "member" | "viewer", enabled = true): void {
  const cfg = structuredClone(getConfig());
  cfg.team = { name: "IPC tests", ownerDeviceId: cfg.deviceId!, enabled, updatedAt: 1,
    members: [{ deviceId: cfg.deviceId!, name: "Fixture", role: value, addedAt: 1 }] };
  saveConfig(cfg);
}
function fixtureExtension(): string {
  const dir = path.join(h.root, "source-extension");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "IPC fixture extension", version: "1.0.0", description: "permission proof" }));
  return dir;
}

beforeEach(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.mkdirSync(h.root);
  reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.browserProfiles[PROFILE] = { name: "IPC settings fixture", fingerprintSeed: 12345, fingerprintMode: "off", extensions: {} } as any;
  cfg.extensionRepository = { [EXT]: { id: EXT, name: "Existing extension", description: "fixture", version: "1.0", source: "chrome-web-store",
    updateUrl: `https://clients2.google.com/service/update2/crx?x=id%3D${EXT}`, unpackedPath: path.join(h.root, "extension-repository", EXT, "current"), packageHash: "a".repeat(128), manifestHash: "b".repeat(128), shared: false, tags: ["fixture"], addedAt: 1, updatedAt: 1 } };
  saveConfig(cfg);
  fs.mkdirSync(path.join(getProfilesDir(), PROFILE, "Default"), { recursive: true });
  h.forbidden.mockClear();
  h.picker.mockReset();
});
afterAll(() => fs.rmSync(h.root, { recursive: true, force: true }));

describe("real settings IPC security and persistence", () => {
  it("viewer cannot expand agent file access, including when input is malformed", async () => {
    role("viewer");
    const before = fs.readFileSync(getConfigPath(), "utf8");
    for (const params of [{ mode: "allowlist", allowlist: [h.root] }, { mode: "readonly" }, null]) {
      expect(await invoke("settings:agent-fs-set", params)).toMatchObject({ success: false, error: "requires member role (current: viewer)" });
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    }
    reloadConfig();
    expect(await invoke("settings:agent-fs-get")).toEqual({ mode: "sandbox", allowlist: [] });
  });

  it("member writes agent file access through disk, reload, and the real query", async () => {
    role("member");
    expect(await invoke("settings:agent-fs-set", { mode: "allowlist", allowlist: [h.root] })).toMatchObject({ success: true });
    expect(disk().agentFs).toEqual({ mode: "allowlist", allowlist: [h.root] });
    reloadConfig();
    expect(await invoke("settings:agent-fs-get")).toEqual({ mode: "allowlist", allowlist: [h.root] });
  });

  const mutations: Array<[string, () => unknown]> = [
    ["settings:add-repository-extension", () => ({ extId: EXT })],
    ["settings:update-repository-extension", () => EXT],
    ["settings:delete-repository-extension", () => EXT],
    ["settings:set-repository-extension-meta", () => ({ extId: EXT, shared: true, tags: ["changed"] })],
    ["settings:install-extension", () => ({ dirId: PROFILE, extId: EXT })],
    ["settings:install-local-extension", () => ({ path: fixtureExtension() })],
    ["settings:toggle-extension", () => ({ dirId: PROFILE, extId: EXT, enabled: true })],
    ["settings:delete-extension", () => ({ dirId: PROFILE, extId: EXT })],
    ["settings:set-profile-extensions", () => ({ dirId: PROFILE, extensions: { [EXT]: true } })],
  ];
  it.each(mutations)("viewer is denied by %s before repository/profile I/O", async (channel, args) => {
    const params = args();
    role("viewer");
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const entriesBefore = fs.readdirSync(h.root).sort();
    expect(await invoke(channel, params)).toMatchObject({ success: false, error: "requires member role (current: viewer)" });
    expect(h.forbidden).not.toHaveBeenCalled();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(fs.readdirSync(h.root).sort()).toEqual(entriesBefore);
    reloadConfig();
    expect((await invoke("settings:extension-repository", "Existing"))[0].id).toBe(EXT);
    expect(await invoke("settings:profile-extensions", PROFILE)).toEqual({});
  });

  it("bookmarks and preference routes change real profile files and query after reload", async () => {
    const profileDefault = path.join(getProfilesDir(), PROFILE, "Default");
    expect(await invoke("settings:bookmarks", PROFILE)).toBeNull();
    expect(await invoke("settings:add-bookmark", { dirId: PROFILE, url: "https://example.test", name: "Missing root" })).toEqual({ success: false });
    expect(await invoke("settings:write-bookmarks", { dirId: PROFILE, bookmarks: { roots: { bookmark_bar: { name: "Bookmarks", children: [] } } } })).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(path.join(profileDefault, "Bookmarks"), "utf8")).roots.bookmark_bar.children).toEqual([]);
    expect(await invoke("settings:add-bookmark", { dirId: PROFILE, url: "https://example.test", name: "IPC needle" })).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(path.join(profileDefault, "Bookmarks"), "utf8")).roots.bookmark_bar.children[0].name).toBe("IPC needle"); reloadConfig();
    expect((await invoke("settings:bookmarks", PROFILE)).roots.bookmark_bar.children.find((item: any) => item.name === "IPC needle").url).toBe("https://example.test");
    expect(await invoke("settings:preferences", PROFILE)).toBeNull();
    expect(await invoke("settings:update-preferences", { dirId: PROFILE, prefs: { custom: "preserved" } })).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(path.join(profileDefault, "Preferences"), "utf8"))).toEqual({ custom: "preserved" }); reloadConfig();
    expect(await invoke("settings:preferences", PROFILE)).toEqual({ custom: "preserved" });
    expect(await invoke("settings:apply-profile", { dirId: PROFILE, settings: { homepage: "https://example.test/home", allowPopups: ["example.test"], downloadDir: h.root, pdfDownload: true } })).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(path.join(profileDefault, "Preferences"), "utf8")).session.startup_urls).toEqual(["https://example.test/home"]); reloadConfig();
    expect(await invoke("settings:preferences", PROFILE)).toMatchObject({ custom: "preserved", plugins: { always_open_pdf_externally: true } });
    await expect(invoke("settings:preferences", "../escape")).rejects.toThrow();
    expect(await invoke("settings:write-bookmarks", { dirId: "ab_absent", bookmarks: {} })).toEqual({ success: false });
  });

  it("launch gates and notification settings preserve valid fields across disk and query", async () => {
    role("member");
    expect(await invoke("settings:launch-gates:set", { blockOnConsistencyConflict: true, blockOnProxyRisk: true, blockOnFingerprintDrift: false, blockOnEnvironmentRisk: true })).toEqual({ success: true });
    expect(disk()).toMatchObject({ blockOnConsistencyConflict: true, blockOnFingerprintDrift: false }); reloadConfig();
    expect(await invoke("settings:launch-gates")).toMatchObject({ blockOnProxyRisk: true, blockOnEnvironmentRisk: true });
    expect(await invoke("settings:automation-notify:set", { system: true, sound: true })).toMatchObject({ success: true });
    expect(disk().automationNotify).toEqual({ system: true, sound: true }); reloadConfig();
    expect(await invoke("settings:automation-notify")).toEqual({ system: true, sound: true });
    expect(await invoke("settings:automation-notify:set", { system: "not-a-boolean" })).toMatchObject({ automationNotify: { system: true, sound: true } });
  });

  it("extension picker cancellation, malformed inputs and authorized native failures surface truthfully", async () => {
    h.picker.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await invoke("settings:pick-extension-file")).toBeNull(); expect(await invoke("settings:pick-extension-dir")).toBeNull();
    h.picker.mockResolvedValue({ canceled: false, filePaths: [h.root] });
    expect(await invoke("settings:pick-extension-file")).toBe(h.root); expect(await invoke("settings:pick-extension-dir")).toBe(h.root);
    expect(await invoke("settings:check-extension-update", { dirId: PROFILE, extId: EXT })).toMatchObject({ hasUpdate: false, error: "Extension not installed" });
    for (const [channel, params] of [["settings:add-repository-extension", { extId: "bad" }], ["settings:update-repository-extension", "bad"], ["settings:delete-repository-extension", "bad"], ["settings:set-repository-extension-meta", { extId: "bad" }], ["settings:toggle-extension", { dirId: PROFILE, extId: "bad", enabled: true }], ["settings:install-extension", { dirId: "../escape", extId: EXT }], ["settings:set-profile-extensions", { dirId: "ab_missing", extensions: {} }], ["settings:install-local-extension", { path: path.join(h.root, "missing") }], ["settings:agent-fs-set", null]] as Array<[string, any]>) expect(await invoke(channel, params), channel).toMatchObject({ success: false });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await invoke("settings:add-repository-extension", { extId: EXT })).toMatchObject({ success: false });
    expect(h.forbidden).toHaveBeenCalled(); expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  it("real local install, metadata edits, selection, search and delete persist", async () => {
    role("member");
    const result = await invoke("settings:install-local-extension", { path: fixtureExtension(), shared: true, tags: ["ipc"] });
    expect(result.success).toBe(true);
    const id = result.entry.id;
    expect(JSON.parse(fs.readFileSync(path.join(result.entry.unpackedPath, "manifest.json"), "utf8")).name).toBe("IPC fixture extension");
    expect(disk().extensionRepository[id].name).toBe("IPC fixture extension");
    reloadConfig();
    expect((await invoke("settings:extension-repository", "permission proof")).map((entry: any) => entry.id)).toEqual([id]);
    expect(await invoke("settings:toggle-extension", { dirId: PROFILE, extId: id, enabled: true })).toEqual({ success: true });
    expect(disk().browserProfiles[PROFILE].extensions[id]).toBe(true);
    reloadConfig();
    expect((await invoke("settings:extensions", PROFILE)).find((entry: any) => entry.id === id).enabled).toBe(true);
    expect(await invoke("settings:set-repository-extension-meta", { extId: id, shared: false, tags: ["renamed"] })).toMatchObject({ success: true, entry: { shared: false } });
    expect(disk().extensionRepository[id].tags).toEqual(["renamed"]);
    reloadConfig();
    expect((await invoke("settings:extension-repository", "renamed"))[0].id).toBe(id);
    expect(await invoke("settings:delete-extension", { dirId: PROFILE, extId: id })).toEqual({ success: true });
    expect(disk().browserProfiles[PROFILE].extensions[id]).toBe(false);
    expect(await invoke("settings:delete-repository-extension", id)).toEqual({ success: true });
    expect(disk().extensionRepository[id]).toBeUndefined();
    reloadConfig();
    expect(await invoke("settings:extension-repository", "renamed")).toEqual([]);
    expect(h.forbidden).not.toHaveBeenCalled();
  });
});
