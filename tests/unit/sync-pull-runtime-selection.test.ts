import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  fixture.root = mkdtempSync(join(tmpdir(), "f01-runtime-pull-"));
  return { app: { getPath: (name: string) => name === "home" ? join(fixture.root, "test-home") : fixture.root } };
});

import { syncService } from "../../src/main/services/sync-service.js";
import { runtimeCookieOps } from "../../src/main/services/bidi-cookie-service.js";
import { getConfig, getProfileMeta, getProfilesDir, saveConfig } from "../../src/main/services/config-manager.js";

const ID = "ab_f01_runtime";
const CONCURRENT_ID = "ab_f01_concurrent";
const remoteCookie = { domain: "example.test", name: "f01", value: "remote", path: "/", expires: null, secure: false, httpOnly: true, sameSite: 0 };

function prepareRemote() {
  const cfg = structuredClone(getConfig());
  cfg.sync = { enabled: true, endpoint: "http://127.0.0.1:1", bucket: "bucket", accessKey: "f01ak", secretKey: "f01sk", custodyConsentAt: Date.now() } as any;
  cfg.browserProfiles[ID] = { name: "local", fingerprintMode: "managed", fingerprintSeed: 123, platform: "windows", updatedAt: 100 } as any;
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

  it("imports runtime cookies when remote wins the same profile conflict", async () => {
    prepareRemote();
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success, result.message).toBe(true);
    expect(importer).toHaveBeenCalledWith(ID, [remoteCookie], expect.any(AbortSignal));
    expect(importer.mock.calls[0][2]?.aborted).toBe(false);
    expect(getConfig().browserProfiles[ID].name).toBe("remote");
  });

  it("propagates abort without importing runtime cookies or changing metadata", async () => {
    prepareRemote();
    const local = structuredClone(getConfig().browserProfiles[ID]);
    const importer = vi.spyOn(runtimeCookieOps, "importCookies").mockResolvedValue(1);
    const controller = new AbortController();
    controller.abort();
    await expect(syncService.pull(controller.signal, { strategy: "remote" })).rejects.toThrow(/cancelled/);
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
    await expect(syncService.pull(controller.signal, { strategy: "remote" })).rejects.toThrow(/cancelled/);
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

    const pull = syncService.pull(undefined, { strategy: "remote" });
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

    const pull = syncService.pull(undefined, { strategy: "remote" });
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
