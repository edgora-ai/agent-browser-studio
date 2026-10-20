import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";

const fixture = vi.hoisted(() => ({ root: "", status: { running: false, pid: null } as Record<string, unknown>, statusError: false }));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  statusBrowser: () => { if (fixture.statusError) throw new Error("Synthetic status discovery failure"); return fixture.status; },
}));
vi.mock("electron", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  fixture.root = mkdtempSync(join(tmpdir(), "f01-runtime-pull-"));
  return { app: { getPath: (name: string) => name === "home" ? join(fixture.root, "test-home") : fixture.root } };
});

import { syncService } from "../../src/main/services/sync-service.js";
import { runtimeCookieOps } from "../../src/main/services/bidi-cookie-service.js";
import { getConfig, getProfileMeta, getProfilesDir, saveConfig, reloadConfig } from "../../src/main/services/config-manager.js";
import { getProfileDataRevision } from "../../src/main/services/profile-data-revision.js";
import { isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";

const ID = "ab_f01_runtime";
const CONCURRENT_ID = "ab_f01_concurrent";
const remoteCookie = { domain: "example.test", name: "f01", value: "remote", path: "/", expires: null, secure: false, httpOnly: true, sameSite: 0 };

function prepareRemote(engine: "chromium" | "firefox" = "chromium") {
  const cfg = structuredClone(getConfig());
  cfg.sync = { enabled: true, endpoint: "http://127.0.0.1:1", bucket: "bucket", accessKey: "f01ak", secretKey: "f01sk", custodyConsentAt: Date.now() } as any;
  cfg.browserProfiles[ID] = { name: "local", engine, fingerprintMode: "managed", fingerprintSeed: 123, platform: "windows", updatedAt: 100,
    fingerprintBaseline: { platform: "Win32", canvasHash: "synthetic-locked-canvas" } } as any;
  saveConfig(cfg);
  const payload = {
    timestamp: 1000,
    data: zlib.gzipSync(JSON.stringify({
      version: 4, browserProfiles: { [ID]: { ...cfg.browserProfiles[ID], name: "remote", updatedAt: 200 } }, proxies: {}, accounts: [],
    })).toString("base64"),
    cookies: { [ID]: zlib.gzipSync(JSON.stringify([remoteCookie])).toString("base64") },
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
  return cfg;
}

describe("F01 running-profile runtime cookies obey selected profile source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(path.dirname(getProfilesDir())).toBe(fixture.root);
    fs.rmSync(path.join(getProfilesDir(), ID), { recursive: true, force: true });
    fs.rmSync(path.join(fixture.root, "profile-data-revisions", ID + ".json"), { force: true });
    fs.rmSync(path.join(fixture.root, "pending-cookie-imports", ID + ".json"), { force: true });
    fixture.status = { running: false, pid: null }; fixture.statusError = false;
  });
  afterAll(() => {
    expect(path.dirname(fixture.root)).toBe(os.tmpdir());
    expect(path.basename(fixture.root)).toMatch(/^f01-runtime-pull-/);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("never calls the runtime importer for selected-local data and keeps existing profile state", async () => {
    prepareRemote();
    const local = structuredClone(getConfig().browserProfiles[ID]);
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "local" });
    expect(result.success, result.message).toBe(true);
    expect(importer).not.toHaveBeenCalled();
    expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(fs.existsSync(path.join(getProfilesDir(), ID))).toBe(false);
  });

  it("imports runtime cookies only with explicit partial-live merge opt-in", async () => {
    prepareRemote();
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote", allowRunningPartial: true });
    expect(result.success, result.message).toBe(true);
    expect(importer).toHaveBeenCalledWith(ID, [remoteCookie], expect.any(AbortSignal));
    expect(importer.mock.calls[0][2]?.aborted).toBe(false);
    expect(getConfig().browserProfiles[ID].name).toBe("remote");
  });

  it.each([undefined, false])("default/false partial permission (%s) skips an entire running profile without changing its metadata, queue, or data revision", async (allowRunningPartial) => {
    prepareRemote();
    const local = structuredClone(getConfig().browserProfiles[ID]);
    const before = getProfileDataRevision(ID);
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote", ...(allowRunningPartial === undefined ? {} : { allowRunningPartial }) });
    expect(result.success).toBe(false); expect(result.outcome).toBe("partial");
    expect(importer).not.toHaveBeenCalled();
    expect(result.items).toContainEqual(expect.objectContaining({ scope: "profiles", id: ID, state: "skipped", code: "PROFILE_STOP_REQUIRED",
      runtimeEffect: { state: "running-or-unconfirmed", action: "skipped-stop-required", stopRequired: true, restartRequired: false, queuedCookies: 0, liveCookiesApplied: 0 } }));
    expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "config.json"), "utf8")).browserProfiles[ID]).toEqual(local);
    reloadConfig(); expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(fs.existsSync(path.join(getProfilesDir(), ID))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, "pending-cookie-imports", ID + ".json"))).toBe(false);
    expect(getProfileDataRevision(ID)).toBe(before);
  });

  it.each([{ running: false, pid: 1234 }, { running: false, pid: null, stopping: true }, { running: false, pid: null, state: "unknown" }])("does not mistake stopping/unknown ownership for stopped: %j", async (status) => {
    prepareRemote(); fixture.status = status;
    const local = structuredClone(getConfig().browserProfiles[ID]);
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(false);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.items).toContainEqual(expect.objectContaining({ scope: "profiles", id: ID, code: "PROFILE_STOP_REQUIRED" }));
    expect(importer).not.toHaveBeenCalled(); expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(getProfileDataRevision(ID)).toBe("initial");
  });

  it("discovery errors do not authorize metadata adoption or Cookie writes", async () => {
    prepareRemote(); fixture.statusError = true;
    const local = structuredClone(getConfig().browserProfiles[ID]);
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(false);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.items).toContainEqual(expect.objectContaining({ code: "PROFILE_STOP_REQUIRED" }));
    expect(importer).not.toHaveBeenCalled(); expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(getProfileDataRevision(ID)).toBe("initial");
  });

  it("rechecks after preparation and skips a profile that becomes active before the first mutation", async () => {
    prepareRemote();
    const local = structuredClone(getConfig().browserProfiles[ID]);
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValueOnce(false).mockReturnValue(true);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.items).toContainEqual(expect.objectContaining({ id: ID, code: "PROFILE_STOP_REQUIRED" }));
    expect(importer).not.toHaveBeenCalled(); expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(getProfileDataRevision(ID)).toBe("initial"); expect(isRestoreLocked(ID)).toBe(false);
  });

  it("stopped restore persists a new revision even with the same portable fingerprint baseline and reports queued-not-applied Cookies", async () => {
    prepareRemote();
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(false);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const seed = getConfig().browserProfiles[ID].fingerprintSeed;
    const baseline = structuredClone(getConfig().browserProfiles[ID].fingerprintBaseline);
    const before = getProfileDataRevision(ID);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success, result.message).toBe(true);
    expect(importer).not.toHaveBeenCalled(); expect(getProfileDataRevision(ID)).not.toBe(before);
    const revision = JSON.parse(fs.readFileSync(path.join(fixture.root, "profile-data-revisions", ID + ".json"), "utf8")).revision;
    expect(revision).toBe(getProfileDataRevision(ID));
    expect(getConfig().browserProfiles[ID].fingerprintSeed).toBe(seed);
    expect(getConfig().browserProfiles[ID].fingerprintBaseline).toEqual(baseline);
    expect(result.items).toContainEqual(expect.objectContaining({ scope: "profiles", id: ID, state: "applied",
      runtimeEffect: { state: "stopped", action: "restored-stopped", stopRequired: false, restartRequired: false, queuedCookies: 1, liveCookiesApplied: 0 } }));
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "pending-cookie-imports", ID + ".json"), "utf8"))).toEqual([remoteCookie]);
    reloadConfig(); expect(getConfig().browserProfiles[ID].name).toBe("remote"); expect(getProfileDataRevision(ID)).toBe(revision);
  });

  it("does not adopt metadata if runtime becomes unconfirmed after a queued Cookie commit", async () => {
    prepareRemote(); const local = structuredClone(getConfig().browserProfiles[ID]);
    const queue = path.join(fixture.root, "pending-cookie-imports", ID + ".json");
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockImplementation(() => fs.existsSync(queue));
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, outcome: "partial", localCommit: "partial", code: "PROFILE_STOP_REQUIRED" });
    expect(importer).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(queue, "utf8"))).toEqual([remoteCookie]);
    expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "config.json"), "utf8")).browserProfiles[ID]).toEqual(local);
    expect(result.items).toContainEqual(expect.objectContaining({ scope: "profiles", id: ID, code: "PROFILE_STOP_REQUIRED",
      runtimeEffect: expect.objectContaining({ state: "running-or-unconfirmed", stopRequired: true, restartRequired: true, queuedCookies: 1, liveCookiesApplied: 0 }) }));
    expect(getProfileDataRevision(ID)).not.toBe("initial"); expect(isRestoreLocked(ID)).toBe(false);
  });

  it.each(["firefox", "chromium"] as const)("an inert .parentlock permits stopped restore only for configured Firefox, not %s", async (engine) => {
    prepareRemote(engine);
    const directory = path.join(getProfilesDir(), ID); fs.mkdirSync(directory, { recursive: true });
    const marker = path.join(directory, ".parentlock"); fs.writeFileSync(marker, "", { mode: 0o600 });
    const before = fs.lstatSync(marker), revision = getProfileDataRevision(ID);
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(false);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(importer).not.toHaveBeenCalled(); expect(fs.readFileSync(marker)).toEqual(Buffer.alloc(0)); expect(fs.lstatSync(marker).ino).toBe(before.ino);
    if (engine === "firefox") {
      expect(result.success, result.message).toBe(true); expect(getConfig().browserProfiles[ID].name).toBe("remote");
      expect(getProfileDataRevision(ID)).not.toBe(revision);
      expect(result.items).toContainEqual(expect.objectContaining({ scope: "profiles", id: ID, state: "applied", runtimeEffect: expect.objectContaining({ action: "restored-stopped", queuedCookies: 1 }) }));
    } else {
      expect(result.items).toContainEqual(expect.objectContaining({ scope: "profiles", id: ID, state: "skipped", code: "PROFILE_STOP_REQUIRED" }));
      expect(getConfig().browserProfiles[ID].name).toBe("local"); expect(getProfileDataRevision(ID)).toBe(revision);
      expect(fs.existsSync(path.join(fixture.root, "pending-cookie-imports", ID + ".json"))).toBe(false);
    }
  });

  it("advances revision before an explicitly authorized runtime dispatch and retains unknown-mutation facts", async () => {
    prepareRemote(); const before = getProfileDataRevision(ID);
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockImplementation(async () => {
      expect(getProfileDataRevision(ID)).not.toBe(before); expect(isRestoreLocked(ID)).toBe(true);
      return null as any;
    });
    const result = await syncService.pull(undefined, { strategy: "remote", allowRunningPartial: true });
    expect(result.success).toBe(false); expect(result.localCommit).toBe("unknown");
    expect(importer).toHaveBeenCalledTimes(1);
    expect(result.items).toContainEqual(expect.objectContaining({ scope: "profiles", id: ID,
      runtimeEffect: expect.objectContaining({ restartRequired: true, liveCookiesUnconfirmed: true }) }));
    expect(getConfig().browserProfiles[ID].name).toBe("local");
    expect(getProfileDataRevision(ID)).not.toBe(before); expect(isRestoreLocked(ID)).toBe(false);
  });

  it("a revision publication failure fences live Cookie dispatch and metadata adoption", async () => {
    prepareRemote();
    fs.mkdirSync(path.join(fixture.root, "profile-data-revisions"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fixture.root, "profile-data-revisions", ID + ".json"), "{invalid", { mode: 0o600 });
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote", allowRunningPartial: true });
    expect(result.code).toBe("PROFILE_DATA_REVISION_UNAVAILABLE");
    expect(importer).not.toHaveBeenCalled(); expect(getConfig().browserProfiles[ID].name).toBe("local");
    expect(fs.existsSync(path.join(getProfilesDir(), ID))).toBe(false); expect(isRestoreLocked(ID)).toBe(false);
  });

  it("propagates abort without importing runtime cookies or changing metadata", async () => {
    prepareRemote();
    const local = structuredClone(getConfig().browserProfiles[ID]);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const controller = new AbortController();
    controller.abort();
    await expect(syncService.pull(controller.signal, { strategy: "remote", allowRunningPartial: true })).rejects.toThrow(/cancelled/);
    expect(importer).not.toHaveBeenCalled();
    expect(getConfig().browserProfiles[ID]).toEqual(local);
  });

  it("preserves local data if cancellation happens while fetching the remote payload", async () => {
    prepareRemote();
    const local = structuredClone(getConfig().browserProfiles[ID]);
    const controller = new AbortController();
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify({ data: zlib.gzipSync(JSON.stringify({ browserProfiles: { [ID]: { name: "remote" } } })).toString("base64") }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncService.pull(controller.signal, { strategy: "remote", allowRunningPartial: true })).rejects.toThrow(/cancelled/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(importer).not.toHaveBeenCalled();
    expect(getConfig().browserProfiles[ID]).toEqual(local);
    expect(fs.existsSync(path.join(getProfilesDir(), ID))).toBe(false);
  });

  it("retains a new unrelated profile created while runtime Cookie import waits", async () => {
    prepareRemote();
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    let started!: () => void;
    const importing = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(runtimeCookieOps, "importCookies").mockImplementation(async () => { started(); await held; return 1; });

    const pull = syncService.pull(undefined, { strategy: "remote", allowRunningPartial: true });
    try {
      await importing;
      const concurrent = structuredClone(getConfig());
      concurrent.browserProfiles[CONCURRENT_ID] = {
        name: "created-during-pull", fingerprintMode: "managed", fingerprintSeed: 456, platform: "windows", updatedAt: 300,
      } as any;
      saveConfig(concurrent);
      const diskPath = path.join(fixture.root, "config.json");
      expect(JSON.parse(fs.readFileSync(diskPath, "utf8")).browserProfiles[CONCURRENT_ID].name).toBe("created-during-pull");
    } finally {
      release();
    }
    const result = await pull;
    expect(result.success, result.message).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "config.json"), "utf8")).browserProfiles[CONCURRENT_ID]?.name).toBe("created-during-pull");
    expect(getConfig().browserProfiles[CONCURRENT_ID]?.name).toBe("created-during-pull");
    expect(getProfileMeta(CONCURRENT_ID)?.name).toBe("created-during-pull");
  });

  it("rejects a selected profile edit made while runtime Cookie import waits", async () => {
    prepareRemote();
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    let started!: () => void;
    const importing = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(runtimeCookieOps, "importCookies").mockImplementation(async () => { started(); await held; return 1; });

    const pull = syncService.pull(undefined, { strategy: "remote", allowRunningPartial: true });
    try {
      await importing;
      const edited = structuredClone(getConfig());
      edited.browserProfiles[ID].name = "edited-during-pull";
      edited.browserProfiles[ID].updatedAt = 300;
      saveConfig(edited);
      expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "config.json"), "utf8")).browserProfiles[ID].name).toBe("edited-during-pull");
    } finally {
      release();
    }
    const result = await pull;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/profile changed during sync pull/i);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "config.json"), "utf8")).browserProfiles[ID].name).toBe("edited-during-pull");
    expect(getConfig().browserProfiles[ID].name).toBe("edited-during-pull");
  });
});
