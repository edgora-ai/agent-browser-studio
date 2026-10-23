import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const h = vi.hoisted(() => {
  const fs = require("node:fs"); const path = require("node:path"); const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ipc-thin-"));
  delete process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH;
  const forbidden = vi.fn((...args: unknown[]) => { throw new Error(`Undeclared native capability: ${String(args[0])}`); });
  const state = { serverError: false, trusted: true };
  class Server extends EventEmitter {
    listen(_port: number, host: string, callback: () => void) {
      if (host !== "127.0.0.1") throw new Error("Unexpected server bind");
      queueMicrotask(() => state.serverError ? this.emit("error", Object.assign(new Error("fixture bind refused"), { code: "EACCES" })) : callback());
      return this;
    }
    address() { return { port: 45991 }; }
    close(callback: (error?: Error) => void) { queueMicrotask(() => callback()); }
  }
  return { root, handlers: new Map<string, (...args: any[]) => any>(), forbidden, state, Server,
    openPath: vi.fn(async () => ""), openExternal: vi.fn(async () => undefined), quit: vi.fn(),
  };
});
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: any) => { if (h.handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`); h.handlers.set(channel, handler); } },
  app: { getPath: (name: string) => { if (["userData", "home", "appData", "downloads"].includes(name)) return h.root; throw new Error(`Unexpected app path ${name}`); },
    getVersion: () => "1.0.1", getName: () => "IPC fixture", getAppPath: () => h.root, quit: h.quit, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => h.state.trusted ? { isDestroyed: () => false } : null },
  shell: { openPath: h.openPath, openExternal: h.openExternal },
  screen: { getPrimaryDisplay: h.forbidden }, clipboard: { writeText: h.forbidden }, dialog: {},
}));
// Observe real statfs results instead of inventing shell output/capacity.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(),
  exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden, spawn: h.forbidden, spawnSync: h.forbidden, fork: h.forbidden,
  execFileSync: (file: string) => file === "ps" || file === "/bin/ps" ? "" : h.forbidden(file),
}));
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  const overrides = { createServer: () => new h.Server(), request: h.forbidden, get: h.forbidden };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
vi.mock("node:https", async (original) => {
  const actual = await original<typeof import("node:https")>();
  return { ...actual, request: h.forbidden, get: h.forbidden, default: { ...actual, request: h.forbidden, get: h.forbidden } };
});

import { registerAppHandlers } from "../../src/main/ipc/app.js";
import { registerApiHandlers } from "../../src/main/ipc/api.js";
import { registerMcpHandlers } from "../../src/main/ipc/mcp.js";
import { registerAuditHandlers } from "../../src/main/ipc/audit.js";
import { registerDataHandlers } from "../../src/main/ipc/data.js";
import { registerDetectHandlers } from "../../src/main/ipc/detect.js";
import { registerDrmHandlers } from "../../src/main/ipc/drm.js";
import { registerLicenseHandlers } from "../../src/main/ipc/license.js";
import { registerObservabilityHandlers } from "../../src/main/ipc/observability.js";
import { registerStorageHandlers } from "../../src/main/ipc/storage.js";
import { registerTeamHandlers } from "../../src/main/ipc/team.js";
import { registerUpdateHandlers } from "../../src/main/ipc/updates.js";
import { registerProxyHandlers } from "../../src/main/ipc/proxy.js";
import { registerAutomationHandlers } from "../../src/main/ipc/automation.js";
import { registerSyncHandlers } from "../../src/main/ipc/sync.js";
import { getConfig, getConfigPath, getProfilesDir, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { recordAudit } from "../../src/main/services/audit-log.js";
import { configureObservability, resetObservabilityForTest } from "../../src/main/services/observability.js";
import { closeAgentDb } from "../../src/main/services/agent-db.js";
import { closeJobDb, enqueueJob, recordNotification } from "../../src/main/services/job-store.js";
import { stopScheduler } from "../../src/main/services/automation.js";
import { stopRestApiServer } from "../../src/main/services/rest-api-server.js";
import { stopMcpServer } from "../../src/main/services/mcp-server.js";

for (const register of [registerAppHandlers, registerApiHandlers, registerMcpHandlers, registerAuditHandlers, registerDataHandlers,
  registerDetectHandlers, registerDrmHandlers, registerLicenseHandlers, registerObservabilityHandlers, registerStorageHandlers,
  registerTeamHandlers, registerUpdateHandlers, registerProxyHandlers, registerAutomationHandlers, registerSyncHandlers]) register();
const PROFILE = "ab_ipc_thin";
const invoke = (channel: string, ...args: any[]) => h.handlers.get(channel)!({ sender: { id: 3 } }, ...args);
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const statfs = vi.mocked(fsPromises.statfs);
function role(value: "owner" | "viewer") {
  const cfg = structuredClone(getConfig()); cfg.team = { name: "IPC workspace", ownerDeviceId: cfg.deviceId!, enabled: true, updatedAt: 1,
    members: [{ deviceId: cfg.deviceId!, name: "IPC device", role: value, addedAt: 1 }] }; saveConfig(cfg);
}
beforeEach(async () => {
  stopScheduler(); await stopRestApiServer(); await stopMcpServer(); closeAgentDb(); closeJobDb();
  fs.rmSync(h.root, { recursive: true, force: true }); fs.mkdirSync(h.root); reloadConfig();
  const cfg = structuredClone(getConfig()); cfg.browserProfiles[PROFILE] = { name: "Thin fixture", fingerprintSeed: 12345, fingerprintMode: "off", proxyMode: "none" } as any; saveConfig(cfg);
  configureObservability({ dir: path.join(h.root, "logs"), enabled: true }); resetObservabilityForTest();
  h.state.serverError = false; h.state.trusted = true; h.forbidden.mockClear(); h.openExternal.mockClear(); h.openPath.mockClear(); h.quit.mockClear();
  statfs.mockReset().mockImplementation(fs.promises.statfs);
  vi.stubGlobal("fetch", h.forbidden);
});
afterEach(async () => { stopScheduler(); await stopRestApiServer(); await stopMcpServer(); closeAgentDb(); closeJobDb(); vi.unstubAllGlobals(); });
afterAll(() => fs.rmSync(h.root, { recursive: true, force: true }));

describe("real thin IPC routes and isolated durable state", () => {
  it("app routes expose local paths/language and restrict shell destinations", async () => {
    expect(await invoke("app:get-version")).toBe("1.0.1");
    expect(await invoke("app:set-language", "zh-CN")).toMatchObject({ success: true, language: "zh-CN" });
    expect(await invoke("app:get-language")).toEqual({ language: "zh-CN" });
    await invoke("app:set-language", "en");
    expect(await invoke("app:reload-config")).toEqual({ success: true });
    expect(await invoke("app:paths")).toMatchObject({ appDataDir: h.root, configPath: getConfigPath(), profilesDir: getProfilesDir() });
    expect(await invoke("app:open-dir", getProfilesDir())).toEqual({ success: true });
    expect(h.openPath).toHaveBeenLastCalledWith(getProfilesDir());
    await expect(invoke("app:open-dir", path.dirname(h.root))).rejects.toThrow("Refusing");
    expect(await invoke("app:open-url", "https://example.test/help")).toEqual({ success: true });
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.test/help");
    expect(await invoke("app:open-url", "file:///private/fixture")).toMatchObject({ success: false });
    await expect(invoke("app:open-url", null)).rejects.toThrow("Invalid URL");
    expect(await invoke("app:quit")).toEqual({ success: true }); expect(h.quit).toHaveBeenCalledOnce();
  });

  it.each(["api", "mcp"])("%s status/restart/reveal use real service lifecycle with a native server fixture", async (prefix) => {
    expect(await invoke(`${prefix}:status`)).toMatchObject({ running: false, hasToken: true });
    expect(await invoke(`${prefix}:restart`)).toMatchObject({ running: true, port: 45991, hasToken: true });
    expect(await invoke(`${prefix}:status`)).toMatchObject({ running: true, port: 45991 });
    expect((await invoke(`${prefix}:reveal-token`)).token.length).toBeGreaterThan(16);
    h.state.serverError = true;
    expect(await invoke(`${prefix}:restart`)).toMatchObject({ running: false, error: "fixture bind refused" });
  });

  it("audit reads/filtering and confirmed/trusted destructive clear use the real log", async () => {
    recordAudit({ category: "profile", action: "ipc-proof", target: PROFILE, actor: "user" });
    expect(await invoke("audit:list", { category: "profile", target: PROFILE, limit: 5 })).toContainEqual(expect.objectContaining({ action: "ipc-proof" }));
    expect(await invoke("audit:clear")).toMatchObject({ success: false });
    h.state.trusted = false; expect(await invoke("audit:clear", { confirmed: true })).toMatchObject({ success: false });
    expect(await invoke("audit:list")).toHaveLength(1);
    h.state.trusted = true; expect(await invoke("audit:clear", { confirmed: true })).toEqual({ success: true });
    expect(await invoke("audit:list")).toEqual([]);
  });

  it("team mutations persist, query and reject invalid roles and viewer writes", async () => {
    expect(await invoke("team:status")).toMatchObject({ success: true });
    expect(await invoke("team:init", { name: "IPC team" })).toMatchObject({ success: true, team: { name: "IPC team" } });
    expect(disk().team.name).toBe("IPC team"); reloadConfig();
    expect(await invoke("team:add-member", { deviceId: "other", name: "Other", role: "member" })).toMatchObject({ success: true });
    expect(disk().team.members.some((entry: any) => entry.deviceId === "other")).toBe(true); reloadConfig();
    expect(await invoke("team:set-role", { deviceId: "other", role: "viewer" })).toMatchObject({ success: true });
    expect(disk().team.members.find((entry: any) => entry.deviceId === "other").role).toBe("viewer");
    expect(await invoke("team:set-role", { deviceId: "other", role: "invalid" })).toMatchObject({ success: false });
    expect(await invoke("team:add-member", { deviceId: "bad", role: "invalid" })).toMatchObject({ success: false });
    expect(await invoke("team:rename", { name: "Renamed team" })).toMatchObject({ success: true });
    expect(disk().team.name).toBe("Renamed team"); reloadConfig();
    expect(await invoke("team:set-enabled", { enabled: false })).toMatchObject({ success: true });
    expect(disk().team.enabled).toBe(false);
    expect(await invoke("team:remove-member", { deviceId: "other" })).toMatchObject({ success: true });
    expect(disk().team.members.some((entry: any) => entry.deviceId === "other")).toBe(false);
    role("viewer"); const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await invoke("team:add-member", { deviceId: "new", role: "member" })).toMatchObject({ success: false });
    expect(await invoke("team:rename", { name: "Denied" })).toMatchObject({ success: false });
    expect(await invoke("team:set-enabled", { enabled: false })).toMatchObject({ success: false });
    expect(await invoke("team:remove-member", { deviceId: "missing" })).toMatchObject({ success: false });
    expect(await invoke("team:set-role", { deviceId: "missing", role: "admin" })).toMatchObject({ success: false });
    expect(await invoke("team:init", { name: "Takeover" })).toMatchObject({ success: false });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  it("proxy routes use real CRUD, redacted reads, profile references and secret role gates", async () => {
    const config = { type: "http", host: "proxy.example.test", port: 8080, username: "alice", password: "fixture-secret" };
    expect(await invoke("proxy:add", { name: "first", config })).toMatchObject({ success: true });
    expect(disk().proxies.first.host).toBe(config.host); reloadConfig();
    expect((await invoke("proxy:list"))[0]).toMatchObject({ name: "first", config: { hasAuth: true } });
    expect(await invoke("proxy:get", "first")).not.toHaveProperty("password");
    expect(await invoke("proxy:set-default", "first")).toMatchObject({ success: true });
    expect(disk().defaultProxy).toBe("first");
    expect(await invoke("proxy:set-profile", { dirId: PROFILE, proxyName: "first", mode: "named" })).toMatchObject({ success: true });
    expect(disk().browserProfiles[PROFILE].proxyName).toBe("first"); reloadConfig();
    expect(await invoke("proxy:get-profile", PROFILE)).toMatchObject({ name: "first", mode: "named" });
    expect(await invoke("proxy:update", { name: "first", config: { ...config, port: 8081 } })).toMatchObject({ success: true });
    expect(disk().proxies.first.port).toBe(8081);
    expect(await invoke("proxy:rename", { oldName: "first", newName: "renamed", config: { ...config, port: 8081 } })).toMatchObject({ success: true });
    expect(disk().browserProfiles[PROFILE].proxyName).toBe("renamed"); reloadConfig();
    expect(await invoke("proxy:rotation-info", "renamed")).toMatchObject({ success: true });
    expect(await invoke("proxy:rotate", "renamed")).toMatchObject({ success: true });
    expect(await invoke("proxy:health-get")).toHaveProperty("entries");
    expect(await invoke("proxy:health-clear", "renamed")).toMatchObject({ success: true });
    expect((await invoke("proxy:export-csv")).csv).not.toContain("fixture-secret");
    expect((await invoke("proxy:qrcode", { name: "renamed" })).dataUrl).toMatch(/^data:image\/png/);
    role("viewer");
    expect(await invoke("proxy:export-csv", { includePasswords: true })).toMatchObject({ success: false });
    expect(await invoke("proxy:qrcode", { name: "renamed" })).toMatchObject({ success: false });
    role("owner");
    expect(await invoke("proxy:delete", "renamed")).toMatchObject({ success: false });
    expect(await invoke("proxy:set-profile", { dirId: PROFILE, proxyName: null, mode: "none" })).toMatchObject({ success: true });
    expect(await invoke("proxy:delete", "renamed")).toMatchObject({ success: true });
    expect(disk().proxies.renamed).toBeUndefined(); reloadConfig(); expect(await invoke("proxy:get", "renamed")).toBeNull();
  });

  it("invalid proxy mutations, missing proxies and parser failures surface without native traffic", async () => {
    for (const [channel, params] of [
      ["proxy:add", { name: "invalid", config: { type: "wrong", host: "host", port: -1 } }],
      ["proxy:update", { name: "missing", config: {} }], ["proxy:rename", { oldName: "missing", newName: "next", config: {} }],
      ["proxy:set-default", "missing"], ["proxy:set-profile", { dirId: "../escape", proxyName: null }],
      ["proxy:rotate", "missing"], ["proxy:rotation-info", "missing"], ["proxy:qrcode", { name: "missing" }],
    ] as Array<[string, any]>) expect(await invoke(channel, params), channel).toMatchObject({ success: false });
    expect(await invoke("detect:proxy-by-name", "missing")).toMatchObject({ success: false, error: "Proxy not found" });
    const imported = await invoke("proxy:import-text", { text: "http://imported.example.test:8888\nnot-a-proxy" });
    expect(imported).toMatchObject({ success: true }); expect(imported.report.failed.length).toBeGreaterThan(0);
    expect(Object.keys(disk().proxies).length).toBeGreaterThan(0); reloadConfig();
    expect((await invoke("proxy:list")).length).toBeGreaterThan(0);
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("storage queries the owned filesystem and deletes only real cache files", async () => {
    const cache = path.join(getProfilesDir(), PROFILE, "Cache"); fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, "data"), "cached bytes");
    const keep = path.join(getProfilesDir(), PROFILE, "keep"); fs.writeFileSync(keep, "persistent");
    expect(fs.readFileSync(path.join(cache, "data"), "utf8")).toBe("cached bytes");
    expect(fs.readFileSync(keep, "utf8")).toBe("persistent");
    const available = await invoke("storage:available-disk");
    expect(statfs).toHaveBeenCalledExactlyOnceWith(getProfilesDir(), { bigint: true });
    const availableSnapshot = await statfs.mock.results[0].value as fs.BigIntStatsFs;
    expect(available).toBe(Number(availableSnapshot.bavail * availableSnapshot.bsize));
    const info = await invoke("storage:info");
    expect(statfs).toHaveBeenCalledTimes(2);
    expect(statfs).toHaveBeenLastCalledWith(getProfilesDir(), { bigint: true });
    const infoSnapshot = await statfs.mock.results[1].value as fs.BigIntStatsFs;
    expect(info).toMatchObject({
      profiles: [expect.objectContaining({ dirId: PROFILE, sizeBytes: Buffer.byteLength("cached bytespersistent") })],
      totalProfileBytes: Buffer.byteLength("cached bytespersistent"),
      availableDiskBytes: Number(infoSnapshot.bavail * infoSnapshot.bsize),
      diskUsagePercent: Math.round(Number(infoSnapshot.blocks - infoSnapshot.bavail) / Number(infoSnapshot.blocks) * 100),
    });
    expect(await invoke("storage:clear-cache", PROFILE)).toEqual({ freed: Buffer.byteLength("cached bytes") });
    expect(fs.existsSync(cache)).toBe(false); expect(fs.readFileSync(keep, "utf8")).toBe("persistent");
    expect(await invoke("storage:clear-cache")).toEqual({ freed: 0 });
    expect(await invoke("storage:info")).toMatchObject({ totalProfileBytes: Buffer.byteLength("persistent") });
    await expect(invoke("storage:clear-cache", "../escape")).rejects.toThrow();
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("storage IPC rejects unavailable capacity without fake numbers or persistent-file changes", async () => {
    const profile = path.join(getProfilesDir(), PROFILE); fs.mkdirSync(profile, { recursive: true });
    const keep = path.join(profile, "keep"); fs.writeFileSync(keep, "persistent");
    const error = Object.assign(new Error("fixture statfs unsupported"), { code: "ENOTSUP" });
    statfs.mockRejectedValue(error);
    await expect(invoke("storage:available-disk")).rejects.toBe(error);
    await expect(invoke("storage:info")).rejects.toBe(error);
    expect(statfs).toHaveBeenCalledTimes(2);
    for (const args of statfs.mock.calls) expect(args).toEqual([getProfilesDir(), { bigint: true }]);
    expect(fs.readFileSync(keep, "utf8")).toBe("persistent");
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("data exports return isolated facts and explicitly refuse unknown scopes", async () => {
    for (const scope of ["profiles", "proxies", "accounts", "runs", "jobs", "db", "risk", "all"]) expect(await invoke("data:export", scope)).toMatchObject({ ok: true });
    expect(await invoke("data:export", "unknown")).toMatchObject({ ok: false, allowed: expect.arrayContaining(["profiles"]) });
  });

  it("DRM mutation is real metadata and invalid paths/probes fail without browser access", async () => {
    expect(await invoke("drm:set-profile", { dirId: PROFILE, enabled: true })).toEqual({ success: true });
    expect(disk().browserProfiles[PROFILE].drm).toBe(true); reloadConfig();
    expect(getConfig().browserProfiles[PROFILE].drm).toBe(true);
    expect(await invoke("drm:set-cdm-path", null)).toMatchObject({ success: true, configuredPath: null });
    expect(await invoke("drm:set-cdm-path", "/absent/ipc-cdm")).toMatchObject({ success: true, configuredPath: "/absent/ipc-cdm" });
    expect(disk().drm.cdmPath).toBe("/absent/ipc-cdm");
    expect(await invoke("drm:set-cdm-path", 42)).toMatchObject({ success: false });
    expect(await invoke("drm:probe", PROFILE)).toMatchObject({ success: false, error: "Profile is not running" });
    expect(await invoke("drm:set-profile", { dirId: "../escape", enabled: true })).toMatchObject({ success: false });
  });

  it("offline license status and malformed activation never need network", async () => {
    expect(await invoke("license:status")).toMatchObject({ plan: "trial", expired: false, deviceId: getConfig().deviceId });
    for (const code of [null, "x".repeat(8193), "bad-format"]) expect(await invoke("license:activate", code)).toMatchObject({ ok: false });
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("update status and invalid staged actions return explicit errors", async () => {
    expect(await invoke("updates:status")).toMatchObject({ success: true, currentVersion: "1.0.1" });
    expect(await invoke("updates:check", { manifestUrl: "file:///private/fixture" })).toMatchObject({ success: false });
    expect(await invoke("updates:install", { version: "not-a-version" })).toMatchObject({ success: false });
    expect(await invoke("updates:activate", { version: "99.0.0" })).toMatchObject({ success: false });
    expect(await invoke("updates:rollback")).toMatchObject({ success: false });
  });

  it("observability routes record metrics and redact fields through real event search/export", async () => {
    expect((await invoke("obs:trace")).traceId).toMatch(/^[a-zA-Z0-9-]+$/);
    await invoke("obs:event", { event: "ipc.fixture", level: "warn", fields: { password: "do-not-export" } });
    await invoke("obs:timing", { name: "ipc.fixture.time", ms: 12 }); await invoke("obs:counter", { name: "ipc.fixture.count", delta: 3 }); await invoke("obs:gauge", { name: "ipc.fixture.gauge", value: 7 });
    expect(await invoke("obs:status")).toMatchObject({ enabled: true }); expect(await invoke("obs:metrics")).toHaveProperty("counters");
    const events = await invoke("obs:events", { event: "ipc.fixture", level: "warn", limit: 2 });
    expect(events.events.length).toBeGreaterThan(0); expect(JSON.stringify(events)).not.toContain("do-not-export");
    const bundle = await invoke("obs:export"); expect(bundle).toHaveProperty("success", true);
  });

  it("automation rules persist and invalid cron/update/reschedule use real failure paths", async () => {
    const created = await invoke("automation:create", { name: "IPC schedule", enabled: false, trigger: { type: "once", at: Date.now() + 3600000 }, action: { type: "launch-profile", profileDirId: PROFILE } });
    expect(created).toMatchObject({ success: true }); const id = created.rule.id;
    expect(disk().automation[0].id).toBe(id); reloadConfig(); expect((await invoke("automation:list"))[0].id).toBe(id);
    expect(await invoke("automation:update", { ...created.rule, name: "Renamed schedule", enabled: false })).toMatchObject({ success: true });
    expect(disk().automation[0].name).toBe("Renamed schedule"); reloadConfig(); expect((await invoke("automation:list"))[0].name).toBe("Renamed schedule");
    expect(await invoke("automation:update", { id: "missing", action: { type: "launch" } })).toMatchObject({ success: false });
    expect(await invoke("automation:validate-cron", "* * * * *")).toEqual({ valid: true }); expect(await invoke("automation:validate-cron", "wrong")).toMatchObject({ valid: false });
    expect(await invoke("automation:create", { trigger: { type: "cron", cron: "wrong" }, action: { type: "launch" } })).toMatchObject({ success: false });
    expect(await invoke("automation:reschedule-once", { ruleId: id, at: 1 })).toMatchObject({ success: false });
    expect(await invoke("automation:schedule-state")).toMatchObject({ success: true }); expect(await invoke("automation:reconcile")).toMatchObject({ success: true }); expect(await invoke("automation:logs")).toEqual([]);
    expect(await invoke("automation:delete", id)).toEqual({ success: true }); expect(disk().automation).toEqual([]); reloadConfig(); expect(await invoke("automation:list")).toEqual([]);
    expect(await invoke("automation:delete", id)).toEqual({ success: false });
  });

  it("automation job cancellation and notification read state reach real SQLite", async () => {
    const job = enqueueJob({ ruleId: "fixture-rule", ruleName: "IPC job", source: "test" });
    expect((await invoke("automation:jobs"))[0].id).toBe(job.id); expect(await invoke("automation:job-get", job.id)).toMatchObject({ id: job.id });
    expect(await invoke("automation:job-cancel", job.id)).toEqual({ success: true }); closeJobDb();
    const direct = new DatabaseSync(path.join(h.root, "jobs.sqlite"), { readOnly: true });
    try { expect(direct.prepare("SELECT status, source FROM jobs WHERE id=?").get(job.id)).toMatchObject({ status: "cancelled", source: "test" }); } finally { direct.close(); }
    expect(await invoke("automation:job-get", job.id)).toMatchObject({ status: "cancelled" });
    expect(await invoke("automation:job-cancel", "missing")).toEqual({ success: false });
    const notification = recordNotification({ dedupKey: "ipc-notification", jobId: job.id, ruleId: "fixture-rule", kind: "failed", now: Date.now(), delivered: false });
    expect(await invoke("automation:notifications-unread-count")).toEqual({ count: 1 });
    expect((await invoke("automation:notifications", { unreadOnly: true })).length).toBe(1);
    const rows = await invoke("automation:notifications");
    expect(await invoke("automation:notifications-read", [rows[0].dedupKey])).toMatchObject({ success: true });
    expect(await invoke("automation:notifications-unread-count")).toEqual({ count: 0 });
    expect(notification).toBeDefined();
  });

  it("sync read/rejected configuration preserves existing sync fixes and role policy", async () => {
    expect(await invoke("sync:status")).toBeDefined();
    role("viewer"); const before = fs.readFileSync(getConfigPath(), "utf8");
    expect(await invoke("sync:configure", { enabled: true })).toMatchObject({ success: false, code: "TEAM_ROLE_DENIED" });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    role("owner"); expect(await invoke("sync:configure", { endpoint: "not-a-url" })).toMatchObject({ success: false });
    expect(await invoke("sync:configure", { enabled: false })).toMatchObject({ success: true });
    expect(disk().sync.enabled).toBe(false); reloadConfig(); expect(getConfig().sync.enabled).toBe(false);
  });
});
