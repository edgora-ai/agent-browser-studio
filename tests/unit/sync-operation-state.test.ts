import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const h = vi.hoisted(() => ({ root: "", objects: new Map<string, Buffer>(), snapshot: vi.fn(), importCookies: vi.fn(), running: false, onRead: null as null | (() => void), requests: [] as string[] }));
vi.mock("electron", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-sync-lifecycle-"));
  return { app: { getPath: (name: string) => name === "home" ? path.join(h.root, "home") : h.root } };
});
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: () => ({ running: false }) }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ runtimeCookieOps: {
  hasRunningBrowser: () => h.running, exportCookiesSnapshot: h.snapshot, importCookies: h.importCookies,
} }));
import { syncService } from "../../src/main/services/sync-service.js";
import { getConfig, getConfigPath, getProfilesDir, reloadConfig, saveConfig, setProfileMeta, setSyncConfig } from "../../src/main/services/config-manager.js";
import { onEvent } from "../../src/main/services/event-bus.js";

const ID = "ab_sync_lifecycle", ENDPOINT = "https://lifecycle.example.test", MAIN = `${ENDPOINT}/synthetic/agent-browser-studio-config.json`;
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function mutateRemote(): void {
  const document = JSON.parse(h.objects.get(MAIN)!.toString());
  const cfg = JSON.parse(zlib.gunzipSync(Buffer.from(document.data, "base64")).toString());
  cfg.proxies.remote_new = { type: "http", host: "remote.example.test", port: 8081 };
  document.data = zlib.gzipSync(JSON.stringify(cfg)).toString("base64");
  h.objects.set(MAIN, Buffer.from(JSON.stringify(document)));
}
beforeEach(() => {
  h.objects.clear(); h.requests = []; h.running = false; h.onRead = null;
  h.snapshot.mockReset().mockResolvedValue({ state: "available", cookies: [] });
  h.importCookies.mockReset().mockResolvedValue(0);
  expect(path.dirname(h.root)).toBe(os.tmpdir());
  for (const child of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, child), { recursive: true, force: true });
  reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.sync = { enabled: true, endpoint: ENDPOINT, bucket: "synthetic", accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: 1 };
  cfg.browserProfiles = { [ID]: { name: "before", fingerprintMode: "managed", fingerprintSeed: 12345, platform: "windows" } };
  cfg.proxies = {}; cfg.accounts = []; cfg.extensionRepository = {};
  saveConfig(cfg);
  const file = path.join(getProfilesDir(), ID, "Default", "Preferences");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ lifecycle: "before" }));
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const key = String(url), method = init?.method || "GET";
    if (!key.startsWith(`${ENDPOINT}/synthetic/`)) throw new Error("Unexpected fixture destination");
    h.requests.push(method + " " + key);
    if (method === "PUT") { h.objects.set(key, Buffer.from(init?.body as any)); return new Response("", { status: 200 }); }
    h.onRead?.();
    const body = h.objects.get(key);
    return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("missing", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => { expect(path.dirname(h.root)).toBe(os.tmpdir()); fs.rmSync(h.root, { recursive: true, force: true }); });

describe("shared synchronization operation ownership", () => {
  it("rejects push and pull conflicts without starting or queuing another operation", async () => {
    const started = deferred(), release = deferred();
    h.snapshot.mockImplementation(async () => { started.resolve(); await release.promise; return { state: "available", cookies: [] }; });
    const first = syncService.push(); await started.promise;
    try {
      const push = await syncService.push(undefined, true);
      const pull = await syncService.pull(undefined, { strategy: "remote" });
      expect(push.code).toBe("SYNC_BUSY"); expect(pull.code).toBe("SYNC_BUSY");
      expect(h.snapshot).toHaveBeenCalledTimes(1);
      expect(h.requests.some((request) => request.startsWith("PUT"))).toBe(false);
    } finally { release.resolve(); await first; }
  });

  it("keeps ownership until an aborted runtime Cookie mutation actually settles", async () => {
    expect((await syncService.push()).success).toBe(true);
    const document = JSON.parse(h.objects.get(MAIN)!.toString());
    document.cookies[ID] = zlib.gzipSync(JSON.stringify([{ domain: "example.test", name: "sid", value: "runtime-fixture", path: "/", expires: null, secure: false, httpOnly: true, sameSite: 0 }])).toString("base64");
    h.objects.set(MAIN, Buffer.from(JSON.stringify(document)));
    const started = deferred(), release = deferred();
    h.running = true;
    h.importCookies.mockImplementation(async () => { started.resolve(); await release.promise; return 1; });
    const controller = new AbortController();
    const pending = syncService.pull(controller.signal, { strategy: "remote" }).catch((error) => (error as any).syncResult);
    await started.promise; controller.abort(); await new Promise((done) => setImmediate(done));
    try {
      expect((syncService.getStatus() as any).operation.active?.kind).toBe("pull");
      expect((await syncService.push()).code).toBe("SYNC_BUSY");
    } finally { release.resolve(); await pending; }
    const result = await pending;
    expect(result).toMatchObject({ success: false, outcome: "partial", localCommit: "unknown" });
    expect((syncService.getStatus() as any).operation.active).toBeNull();
  });

  it("publishes secret-free invalidations and queryable detached operation state", async () => {
    const events: any[] = [], unsubscribe = onEvent("sync:state-changed", (event) => events.push(event));
    const started = deferred(), release = deferred();
    h.snapshot.mockImplementation(async () => { started.resolve(); await release.promise; return { state: "available", cookies: [] }; });
    const pushed = syncService.push(); await started.promise;
    try {
      const status = syncService.getStatus() as any;
      expect(status.operation?.active).toMatchObject({ kind: "push", stage: "preparing" });
      expect(events).toContainEqual(expect.objectContaining({ phase: "started", kind: "push" }));
      release.resolve(); const result = await pushed;
      expect(result.success, result.message).toBe(true);
      const terminal = (syncService.getStatus() as any).operation;
      expect(terminal.active).toBeNull(); expect(terminal.last.operationId).toBe(result.operationId);
      const end = events.find((event) => event.phase === "completed");
      expect(end).toMatchObject({ operationId: result.operationId, kind: "push", result: { localCommit: "committed", remoteCommit: "committed" } });
      expect(end.generation).toBeGreaterThan(events[0].generation);
      expect(end.scopes).toContain("profiles");
      expect(JSON.stringify(events)).not.toContain("synthetic-secret");
      expect(JSON.stringify(events)).not.toContain("synthetic-access");
      expect(JSON.stringify(events)).not.toContain("lifecycle.example.test");
      terminal.last.items.length = 0;
      expect((syncService.getStatus() as any).operation.last.items.length).toBeGreaterThan(0);
      expect(disk().browserProfiles[ID].syncBaseline.snapshotId).toBe(result.operationId);
      reloadConfig(); expect(getConfig().browserProfiles[ID].syncBaseline?.snapshotId).toBe(result.operationId);
    } finally { release.resolve(); await pushed; unsubscribe(); }
  });
});

describe("settings and authorization reflect committed state", () => {
  it("does not change live custody/config state when settings validation fails", () => {
    const before = structuredClone(getConfig().sync), raw = fs.readFileSync(getConfigPath());
    expect(() => setSyncConfig({ custodyConsent: true, endpoint: "http://not-loopback.example.test" })).toThrow();
    expect(getConfig().sync).toEqual(before);
    expect(fs.readFileSync(getConfigPath())).toEqual(raw);
    reloadConfig(); expect(getConfig().sync).toEqual(before);
  });

  it.each([{ enabled: "false" }, { accessKey: 42 }, { secretKey: null }, { custodyConsent: "true" }])("rejects malformed settings without changing committed or live state: %j", (input) => {
    const before = fs.readFileSync(getConfigPath()), sync = structuredClone(getConfig().sync);
    expect(() => setSyncConfig(input as any)).toThrow();
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
    expect(getConfig().sync).toEqual(sync);
  });

  it("invalidates target-dependent views only after settings are committed and read back", () => {
    const events: any[] = [], unsubscribe = onEvent("sync:state-changed", (event) => events.push(event));
    try {
      setSyncConfig({ bucket: "new-synthetic-target" });
      expect(disk().sync.bucket).toBe("new-synthetic-target");
      expect(events).toContainEqual(expect.objectContaining({ kind: "configure", phase: "completed", scopes: expect.arrayContaining(["profiles", "sync"]) }));
      reloadConfig(); expect(syncService.getStatus().bucket).toBe("new-synthetic-target");
    } finally { unsubscribe(); }
  });

  it.each(["push", "pull"] as const)("rechecks the current role after %s preparation waits", async (kind) => {
    if (kind === "pull") expect((await syncService.push()).success).toBe(true);
    const demote = () => {
      const cfg = structuredClone(getConfig());
      cfg.team = { name: "Synthetic team", enabled: true, ownerDeviceId: "synthetic-owner", updatedAt: 1,
        members: [{ deviceId: cfg.deviceId!, name: "Synthetic viewer", role: "viewer", addedAt: 1 }] };
      saveConfig(cfg);
    };
    const preferences = fs.readFileSync(path.join(getProfilesDir(), ID, "Default", "Preferences"));
    if (kind === "push") h.snapshot.mockImplementation(async () => { demote(); return { state: "available", cookies: [] }; });
    else h.onRead = demote;
    const putsBefore = h.requests.filter((request) => request.startsWith("PUT")).length;
    const result = kind === "push" ? await syncService.push() : await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, code: "TEAM_ROLE_DENIED", localCommit: "none" });
    expect(h.requests.filter((request) => request.startsWith("PUT"))).toHaveLength(putsBefore);
    expect(fs.readFileSync(path.join(getProfilesDir(), ID, "Default", "Preferences"))).toEqual(preferences);
    expect(disk().team.members[0].role).toBe("viewer");
  });

  it("rejects a viewer pull before any provider or local data operation", async () => {
    const cfg = structuredClone(getConfig());
    cfg.team = { name: "Synthetic team", enabled: true, ownerDeviceId: "synthetic-owner", updatedAt: 1,
      members: [{ deviceId: cfg.deviceId!, name: "Synthetic viewer", role: "viewer", addedAt: 1 }] };
    saveConfig(cfg);
    const before = fs.readFileSync(getConfigPath());
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, code: "TEAM_ROLE_DENIED" });
    expect(h.requests).toEqual([]);
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
  });
});

describe("comparison decisions are bound to the viewed content", () => {
  it.each(["local", "remote", "preferences"])("rejects pull decisions after %s content changes without touching live data", async (changed) => {
    expect((await syncService.push()).success).toBe(true);
    const preview = await syncService.previewDiff() as any;
    expect(preview.ok, preview.message).toBe(true);
    expect(preview.comparisonToken).toBeDefined();
    if (changed === "local") setProfileMeta(ID, { name: "edited-after-comparison" });
    if (changed === "remote") mutateRemote();
    if (changed === "preferences") fs.writeFileSync(path.join(getProfilesDir(), ID, "Default", "Preferences"), JSON.stringify({ lifecycle: "edited-after-comparison" }));
    const before = fs.readFileSync(getConfigPath()), preferences = fs.readFileSync(path.join(getProfilesDir(), ID, "Default", "Preferences"));
    const result = await syncService.pull(undefined, { strategy: "remote", comparisonToken: preview.comparisonToken } as any);
    expect(result).toMatchObject({ success: false, code: "SYNC_PREVIEW_STALE", localCommit: "none" });
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
    expect(fs.readFileSync(path.join(getProfilesDir(), ID, "Default", "Preferences"))).toEqual(preferences);
    reloadConfig(); expect(getConfig().browserProfiles[ID].name).toBe(disk().browserProfiles[ID].name);
  });

  it("accepts an unchanged comparison token through actual pull, disk readback and reload", async () => {
    expect((await syncService.push()).success).toBe(true);
    const preview = await syncService.previewDiff() as any;
    const result = await syncService.pull(undefined, { strategy: "remote", comparisonToken: preview.comparisonToken } as any);
    expect(preview.comparisonToken).toBeDefined();
    expect(result.success, result.message).toBe(true);
    expect(disk().browserProfiles[ID].syncBaseline.contentHash).toMatch(/^[a-f0-9]{64}$/);
    reloadConfig(); expect(getConfig().browserProfiles[ID].syncBaseline?.contentHash).toBe(disk().browserProfiles[ID].syncBaseline.contentHash);
  });

  it("does not silently overwrite a changed remote after a push preflight", async () => {
    expect((await syncService.push()).success).toBe(true);
    const preview = await syncService.previewDiff() as any;
    mutateRemote(); const old = Buffer.from(h.objects.get(MAIN)!);
    const result = await (syncService.push as any)(undefined, false, preview.comparisonToken);
    expect(preview.comparisonToken).toBeDefined();
    expect(result).toMatchObject({ success: false, code: "SYNC_PREVIEW_STALE", remoteCommit: "none" });
    expect(h.objects.get(MAIN)).toEqual(old);
  });
});
