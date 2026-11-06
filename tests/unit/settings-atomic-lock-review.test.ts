// Task-35: real config/store + IPC dispatch, synthetic side-effect boundaries.
// No Electron runtime, browser, downloads, sockets, child processes or user data.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const h = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path");
  if (!process.env.TMPDIR) throw new Error("An isolated TMPDIR is required");
  const parent = fs.realpathSync(process.env.TMPDIR);
  const root = fs.mkdtempSync(path.join(parent, "settings-atomic-lock-"));
  const forbidden = vi.fn(() => { throw new Error("Undeclared native/network capability"); });
  return {
    root, parent, handlers: new Map<string, (...args: any[]) => any>(), forbidden,
    failure: "" as "" | "write" | "rename", writes: [] as string[],
    addBookmark: vi.fn(() => true), writeBookmarks: vi.fn(() => true),
    writePreferences: vi.fn(() => true), applyProfileSettings: vi.fn(() => true),
    install: vi.fn(async () => ({})),
  };
});
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, fn: any) => {
    if (h.handlers.has(name)) throw new Error(`Duplicate handler ${name}`);
    h.handlers.set(name, fn);
  } },
  app: { getPath: (name: string) => {
    if (name === "userData" || name === "home") return h.root;
    throw new Error(`Undeclared Electron path: ${name}`);
  } }, dialog: { showOpenDialog: h.forbidden },
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    writeFileSync: (...args: any[]) => {
      h.writes.push("write");
      if (h.failure === "write" && typeof args[0] === "number") throw new Error("synthetic ENOSPC write failure");
      return (actual.writeFileSync as any)(...args);
    },
    renameSync: (...args: any[]) => {
      h.writes.push("rename");
      if (h.failure === "rename") throw new Error("synthetic EACCES rename failure");
      return (actual.renameSync as any)(...args);
    },
  };
});
vi.mock("node:child_process", () => ({ spawn: h.forbidden, spawnSync: h.forbidden,
  exec: h.forbidden, execSync: h.forbidden, execFile: h.forbidden, execFileSync: h.forbidden, fork: h.forbidden }));
vi.mock("node:net", async (original) => ({ ...await original<typeof import("node:net")>(),
  connect: h.forbidden, createConnection: h.forbidden, createServer: h.forbidden }));
vi.mock("node:http", () => ({ request: h.forbidden, get: h.forbidden, createServer: h.forbidden }));
vi.mock("node:https", () => ({ request: h.forbidden, get: h.forbidden, createServer: h.forbidden }));
vi.mock("../../src/main/services/launch-args.js", () => ({
  readBookmarks: vi.fn(() => null), readPreferences: vi.fn(() => ({})), checkExtensionUpdate: h.forbidden,
  addBookmark: h.addBookmark, writeBookmarks: h.writeBookmarks,
  writePreferences: h.writePreferences, applyProfileSettings: h.applyProfileSettings,
}));
vi.mock("../../src/main/services/extension-repository.js", () => ({
  addOrUpdateChromeStoreExtension: h.install, installLocalExtension: h.forbidden,
  updateRepositoryExtension: h.forbidden, deleteRepositoryExtension: h.forbidden,
  exportSharedExtensionRepository: h.forbidden, listExtensionRepository: vi.fn(() => []),
  setRepositoryExtensionMeta: h.forbidden,
}));
vi.mock("../../src/main/services/native-chromium-manager.js", () => ({ normalizeManagedChromiumVersion: () => null }));
vi.mock("../../src/main/services/browser-engine.js", () => ({
  sanitizeBrowserEngine: (value: unknown) => value === "firefox" ? "firefox" : "chromium",
  normalizeManagedFirefoxVersion: () => null,
}));
vi.mock("../../src/main/services/fingerprint-baseline.js", () => ({ sanitizePortableFingerprintBaseline: () => undefined }));
vi.mock("../../src/main/services/secrets.js", () => ({
  clearLegacySecretMigrationCache: vi.fn(), usingEncryption: () => false, isEncrypted: () => false,
  decryptSecretOr: (v: string) => v, encryptSecret: (v: string) => v, migrateSecret: (v: string) => v,
}));
vi.mock("../../src/main/services/sync/operation-state.js", () => ({ invalidateSyncSettings: vi.fn() }));
vi.mock("../../src/main/services/proxy-health.js", () => ({ clearProxyHealth: h.forbidden,
  listProxyHealth: h.forbidden, proxyHealthSummary: h.forbidden, recordProxyRotation: h.forbidden }));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: h.forbidden }));
vi.mock("../../src/main/services/proxy-import.js", () => ({ parseProxyText: h.forbidden, importProxies: h.forbidden, exportProxiesCsv: h.forbidden }));
vi.mock("qrcode", () => ({ default: { toDataURL: h.forbidden } }));

import { registerSettingsHandlers } from "../../src/main/ipc/settings.js";
import { registerProxyHandlers } from "../../src/main/ipc/proxy.js";
import { getConfig, getConfigPath, reloadConfig, saveConfig, setProfileProxy, setProfileProxyOnConfig, assertProfileWritable } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
registerSettingsHandlers();
registerProxyHandlers();
const ID = "ab_settings_atomic_lock";
const EXT = "a".repeat(32);
const GATES = ["blockOnConsistencyConflict", "blockOnProxyRisk", "blockOnFingerprintDrift", "blockOnEnvironmentRisk"] as const;
const invoke = (channel: string, input?: unknown) => h.handlers.get(channel)!({}, input);
const disk = () => fs.readFileSync(getConfigPath(), "utf8");
function cleanupOwnedRoot(): void {
  if (path.dirname(path.resolve(h.root)) !== h.parent || !path.basename(h.root).startsWith("settings-atomic-lock-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(h.root, { force: true, recursive: true });
}
function seed(owner?: string, role: "member" | "viewer" = "member"): void {
  transact((cfg) => {
    cfg.deviceId = "local-device";
    cfg.team = { enabled: true, name: "Synthetic", ownerDeviceId: "local-device", updatedAt: 1,
      members: [{ deviceId: "local-device", role, name: "Local", addedAt: 1 }] };
    for (const gate of GATES) cfg[gate] = true;
    cfg.proxies = { fixture: { type: "http", host: "127.0.0.1", port: 18080 } };
    cfg.browserProfiles[ID] = { name: "Fixture", fingerprintSeed: 12345, fingerprintMode: "off",
      proxyMode: "none", proxyName: null, extensions: {},
      ...(owner ? { lock: { owner, ownerName: "Other", at: 1 } } : {}) };
    cfg.extensionRepository = { [EXT]: { id: EXT, name: "Fixture", version: "1.0", source: "chrome-web-store",
      updateUrl: `https://clients2.google.com/service/update2/crx?x=id%3D${EXT}`,
      unpackedPath: path.join(h.root, "extension-repository", EXT, "current"), packageHash: "a".repeat(128),
      manifestHash: "b".repeat(128), shared: false, tags: [], addedAt: 1, updatedAt: 1 } };
  });
  h.writes.length = 0;
}
beforeEach(() => {
  h.failure = "";
  cleanupOwnedRoot();
  fs.mkdirSync(h.root);
  reloadConfig(); getConfig(); seed();
  for (const mock of [h.forbidden, h.addBookmark, h.writeBookmarks, h.writePreferences, h.applyProfileSettings]) mock.mockClear();
  h.install.mockReset().mockResolvedValue({});
  vi.stubGlobal("fetch", h.forbidden);
  vi.stubGlobal("WebSocket", h.forbidden);
});
afterEach(() => { h.failure = ""; expect(h.forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(cleanupOwnedRoot);

const profileWrites: Array<[string, Record<string, unknown>]> = [
  ["settings:delete-extension", { dirId: ID, extId: EXT }],
  ["settings:install-extension", { dirId: ID, extId: EXT }],
  ["settings:toggle-extension", { dirId: ID, extId: EXT, enabled: true }],
  ["settings:set-profile-extensions", { dirId: ID, extensions: { [EXT]: true } }],
  ["settings:add-bookmark", { dirId: ID, url: "https://example.invalid", name: "Fixture" }],
  ["settings:write-bookmarks", { dirId: ID, bookmarks: {} }],
  ["settings:update-preferences", { dirId: ID, prefs: {} }],
  ["settings:apply-profile", { dirId: ID, settings: {} }],
];
function expectNoSideEffects(): void {
  expect(h.writes).toEqual([]);
  for (const mock of [h.install, h.addBookmark, h.writeBookmarks, h.writePreferences, h.applyProfileSettings]) expect(mock).not.toHaveBeenCalled();
}

describe("launch-policy transaction publication", () => {
  it.each(["write", "rename"] as const)("%s failure preserves memory, disk and subsequent unrelated saves", async (failure) => {
    const live = getConfig(), before = structuredClone(live), bytes = disk();
    h.failure = failure;
    const result = await invoke("settings:launch-gates:set", Object.fromEntries(GATES.map(k => [k, false])));
    expect(result).toMatchObject({ success: false, error: expect.stringContaining(`synthetic ${failure === "write" ? "ENOSPC" : "EACCES"}`) });
    expect(getConfig()).toBe(live);
    expect(getConfig()).toEqual(before);
    expect(disk()).toBe(bytes);
    expect(await invoke("settings:launch-gates")).toEqual(Object.fromEntries(GATES.map(k => [k, true])));
    h.failure = "";
    const unrelated = structuredClone(getConfig()); unrelated.automationNotify = { system: true, sound: false };
    saveConfig(unrelated);
    reloadConfig();
    for (const key of GATES) expect(getConfig()[key]).toBe(true);
    expect(getConfig().automationNotify?.system).toBe(true);
  });
  it("publishes only supplied boolean gates after success and reload", async () => {
    expect(await invoke("settings:launch-gates:set", { blockOnProxyRisk: false, blockOnEnvironmentRisk: "false" })).toEqual({ success: true });
    reloadConfig();
    expect(getConfig().blockOnProxyRisk).toBe(false);
    for (const key of GATES.filter(k => k !== "blockOnProxyRisk")) expect(getConfig()[key]).toBe(true);
  });
  it("denies viewers before even reading mutation arguments", async () => {
    seed(undefined, "viewer"); const bytes = disk();
    const input = Object.defineProperty({}, "blockOnProxyRisk", { get() { throw new Error("argument touched before authorization"); } });
    expect(await invoke("settings:launch-gates:set", input)).toMatchObject({ success: false, error: expect.stringContaining("viewer") });
    expect(disk()).toBe(bytes); expectNoSideEffects();
  });
});

// Task-57: extend the same owned-root/store facade; no additional capabilities.
describe("notification preference transaction publication", () => {
  it.each([
    ["write", false], ["write", true], ["rename", false], ["rename", true],
  ] as const)("%s failure preserves both notification flags when previously %s", async (failure, enabled) => {
    const saved = { system: enabled, sound: enabled };
    transact((cfg) => { cfg.automationNotify = { ...saved }; });
    h.writes.length = 0;
    const live = getConfig(), before = structuredClone(live), bytes = disk();
    h.failure = failure;
    const result = await invoke("settings:automation-notify:set", { system: !enabled, sound: !enabled });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining(`synthetic ${failure === "write" ? "ENOSPC" : "EACCES"}`) });
    expect(result).not.toHaveProperty("automationNotify");
    expect(getConfig()).toBe(live);
    expect(getConfig()).toEqual(before);
    expect(disk()).toBe(bytes);
    expect(await invoke("settings:automation-notify")).toEqual(saved);
    expect(h.writes).toEqual(failure === "write" ? ["write"] : ["write", "rename"]);
    h.failure = "";
    const unrelated = structuredClone(getConfig()); unrelated.blockOnProxyRisk = false;
    saveConfig(unrelated); reloadConfig();
    expect(getConfig().blockOnProxyRisk).toBe(false);
    expect(getConfig().automationNotify).toEqual(saved);
    expect(await invoke("settings:automation-notify")).toEqual(saved);
  });
  it("publishes explicit false flags once and returns a detached committed response", async () => {
    transact((cfg) => { cfg.automationNotify = { system: true, sound: true }; });
    h.writes.length = 0;
    const live = getConfig(), requested = { system: false, sound: false };
    const result = await invoke("settings:automation-notify:set", requested);
    expect(result).toEqual({ success: true, automationNotify: { system: false, sound: false } });
    expect(h.writes).toEqual(["write", "rename"]);
    expect(getConfig()).not.toBe(live);
    expect(live.automationNotify).toEqual({ system: true, sound: true });
    expect(result.automationNotify).not.toBe(getConfig().automationNotify);
    requested.sound = true; result.automationNotify.system = true;
    expect(getConfig().automationNotify).toEqual({ system: false, sound: false });
    expect(JSON.parse(disk()).automationNotify).toEqual({ system: false, sound: false });
    reloadConfig();
    expect(await invoke("settings:automation-notify")).toEqual({ system: false, sound: false });
  });
  it("merges partial boolean updates with the latest values and preserves omitted fields", async () => {
    expect(await invoke("settings:automation-notify")).toEqual({ system: false, sound: false });
    expect(await invoke("settings:automation-notify:set", { system: true })).toEqual({ success: true, automationNotify: { system: true, sound: false } });
    expect(await invoke("settings:automation-notify:set", { sound: true })).toEqual({ success: true, automationNotify: { system: true, sound: true } });
    expect(await invoke("settings:automation-notify:set", { system: false })).toEqual({ success: true, automationNotify: { system: false, sound: true } });
    for (const input of [{}, { system: undefined, sound: undefined }]) {
      expect(await invoke("settings:automation-notify:set", input)).toEqual({ success: true, automationNotify: { system: false, sound: true } });
    }
    reloadConfig();
    expect(getConfig().automationNotify).toEqual({ system: false, sound: true });
  });
  it("retains legacy non-boolean fallback while accepting a valid sibling boolean", async () => {
    transact((cfg) => { cfg.automationNotify = { system: true, sound: true }; });
    expect(await invoke("settings:automation-notify:set", { system: "not-a-boolean" })).toEqual({ success: true, automationNotify: { system: true, sound: true } });
    expect(await invoke("settings:automation-notify:set", { system: 0, sound: false })).toEqual({ success: true, automationNotify: { system: true, sound: false } });
    expect(await invoke("settings:automation-notify:set", { system: false, sound: "true" })).toEqual({ success: true, automationNotify: { system: false, sound: false } });
    reloadConfig();
    expect(getConfig().automationNotify).toEqual({ system: false, sound: false });
  });
  it("denies viewers before reading notification arguments or mutating config", async () => {
    seed(undefined, "viewer");
    const live = getConfig(), before = structuredClone(live), bytes = disk();
    const getter = vi.fn(() => { throw new Error("notification argument decoded before authorization"); });
    const input = Object.defineProperty({}, "system", { get: getter });
    for (const payload of [null, input, { system: true, sound: true }]) {
      expect(await invoke("settings:automation-notify:set", payload)).toMatchObject({ success: false, error: expect.stringContaining("viewer") });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(getConfig()).toBe(live); expect(getConfig()).toEqual(before); expect(disk()).toBe(bytes);
    expectNoSideEffects();
  });
  it("rejects malformed payload shapes before any notification draft or persistence", async () => {
    const live = getConfig(), before = structuredClone(live), bytes = disk();
    for (const input of [undefined, null, true, 1, "true", [], [true, false]]) {
      expect(await invoke("settings:automation-notify:set", input)).toEqual({ success: false, error: "Automation notification preferences must be an object" });
    }
    expect(getConfig()).toBe(live); expect(getConfig()).toEqual(before); expect(disk()).toBe(bytes);
    expectNoSideEffects();
  });
});

describe("profile proxy lock enforcement", () => {
  it("denies a viewer before proxy input decoding or foreign-lock evaluation", async () => {
    seed("other-device", "viewer"); const bytes = disk();
    for (const input of [null, Object.defineProperty({}, "dirId", { get() { throw new Error("decoded before authorization"); } })]) {
      expect(await invoke("proxy:set-profile", input)).toMatchObject({ success: false, error: expect.stringContaining("viewer") });
    }
    expect(disk()).toBe(bytes); expectNoSideEffects();
  });
  it.each(["service", "draft", "ipc"])("blocks the %s writer without publishing or widening force", async (entry) => {
    seed("other-device"); const before = structuredClone(getConfig()), bytes = disk();
    if (entry === "service") expect(() => setProfileProxy(ID, "fixture", "named")).toThrow(/locked/);
    if (entry === "draft") {
      const draft = structuredClone(getConfig());
      expect(() => setProfileProxyOnConfig(draft, ID, "fixture", "named")).toThrow(/locked/);
      expect(draft).toEqual(before);
    }
    if (entry === "ipc") expect(await invoke("proxy:set-profile", { dirId: ID, proxyName: "fixture", mode: "named", force: true })).toMatchObject({ success: false, error: expect.stringContaining("locked") });
    expect(getConfig()).toEqual(before); expect(disk()).toBe(bytes); expectNoSideEffects();
  });
  it.each([undefined, "local-device"])("retains unlocked/self-owned behavior (%s) for all proxy modes", (owner) => {
    seed(owner);
    for (const mode of ["named", "default", "none"] as const) {
      setProfileProxy(ID, mode === "named" ? "fixture" : null, mode);
      reloadConfig(); expect(getConfig().browserProfiles[ID].proxyMode).toBe(mode);
    }
  });
  it("preserves existing explicit force helper semantics without granting force to new routes", () => {
    seed("other-device");
    expect(() => assertProfileWritable(ID)).toThrow(/locked/);
    expect(() => assertProfileWritable(ID, { force: true })).not.toThrow();
    expectNoSideEffects();
  });
});

describe("profile settings lock before filesystem, staging or download", () => {
  it.each(profileWrites)("blocks foreign-locked %s before any side effect", async (channel, input) => {
    seed("other-device"); const before = structuredClone(getConfig()), bytes = disk();
    expect(await invoke(channel, { ...input, force: true })).toMatchObject({ success: false, error: expect.stringContaining("locked") });
    expect(getConfig()).toEqual(before); expect(disk()).toBe(bytes); expectNoSideEffects();
  });
  it.each(profileWrites)("denies viewer %s before argument decoding", async (channel) => {
    seed(undefined, "viewer");
    expect(await invoke(channel, null)).toMatchObject({ success: false, error: expect.stringContaining("viewer") });
    expectNoSideEffects();
  });
  it.each([undefined, "local-device"])("keeps all unlocked/self-owned settings writable (%s)", async (owner) => {
    seed(owner);
    for (const [channel, input] of profileWrites) expect(await invoke(channel, input), channel).toEqual({ success: true });
    expect(h.install).toHaveBeenCalledOnce();
    for (const mock of [h.addBookmark, h.writeBookmarks, h.writePreferences, h.applyProfileSettings]) expect(mock).toHaveBeenCalledOnce();
  });
  it("rechecks the lock after an authorized asynchronous extension download", async () => {
    h.install.mockImplementationOnce(async () => { seed("other-device"); return {}; });
    expect(await invoke("settings:install-extension", { dirId: ID, extId: EXT })).toMatchObject({ success: false, error: expect.stringContaining("locked") });
    expect(getConfig().browserProfiles[ID].extensions).toEqual({});
    expect(h.install).toHaveBeenCalledOnce();
  });
});
