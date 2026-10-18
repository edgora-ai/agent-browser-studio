import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  root: "", failConfigCommit: false, unreadableRemote: false,
  objects: new Map<string, Buffer>(), requests: [] as Array<{ method: string; url: string }>,
  onPut: null as null | ((url: string, body: Buffer) => Promise<"reject" | "lost" | void>),
  snapshot: vi.fn(), legacyExport: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: (from: any, to: any) => {
    if (h.failConfigCommit && String(to) === `${h.root}/config.json`) throw Object.assign(new Error("EACCES: synthetic config commit failure"), { code: "EACCES" });
    return actual.renameSync(from, to);
  } };
});
vi.mock("electron", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  h.root = mkdtempSync(join(tmpdir(), "studio-sync-snapshot-"));
  return { app: { getPath: (name: string) => name === "home" ? join(h.root, "home") : h.root }, BrowserWindow: { getAllWindows: () => [] }, screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) } };
});
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  findBrowserByProfileSync: vi.fn(() => null),
}));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({
  runtimeCookieOps: { hasRunningBrowser: vi.fn(() => false), exportCookies: h.legacyExport, exportCookiesSnapshot: h.snapshot, importCookies: vi.fn(async () => 0) },
  firefoxCookieService: { applyQueuedImports: vi.fn(async () => 0) },
}));

import { syncService } from "../../src/main/services/sync-service.js";
import { getConfig, getConfigPath, getProfilesDir, getProfileMeta, reloadConfig, saveConfig, setProfileMeta } from "../../src/main/services/config-manager.js";
import { listBrowserProfiles } from "../../src/main/services/browser-manager.js";
import { getProfileInfo } from "../../src/main/services/profile-manager.js";
import { installLocalExtension } from "../../src/main/services/extension-repository.js";
import { writeZipArchive } from "../../src/main/services/zip-writer.js";

const ID = "ab_snapshot_a";
const NEW_ID = "ab_snapshot_new";
const ENDPOINT = "https://sync.example.test";
const MAIN = `${ENDPOINT}/synthetic/agent-browser-studio-config.json`;
const rawConfig = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const payload = () => JSON.parse(h.objects.get(MAIN)!.toString("utf8"));
const remoteConfig = () => JSON.parse(zlib.gunzipSync(Buffer.from(payload().data, "base64")).toString("utf8"));
const gzip = (v: unknown) => zlib.gzipSync(JSON.stringify(v)).toString("base64");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function preferences(id = ID, content = { snapshot: "before" }): void {
  const target = path.join(getProfilesDir(), id, "Default", "Preferences");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(content));
}
function seed(): void {
  expect(getConfigPath()).toBe(path.join(h.root, "config.json"));
  expect(path.dirname(getProfilesDir())).toBe(h.root);
  const cfg = structuredClone(getConfig());
  cfg.sync = { enabled: true, endpoint: ENDPOINT, bucket: "synthetic", accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: Date.now() } as any;
  cfg.browserProfiles = { [ID]: {
    name: "before", fingerprintMode: "managed", engine: "chromium", fingerprintSeed: 12345, platform: "windows", updatedAt: 100,
    tags: ["business"], preset: "qa-preset", appUrl: "https://example.test/app", drm: true,
  } };
  cfg.extensionRepository = {};
  saveConfig(cfg);
  preferences();
}
function previousCloud(cookies: unknown[] = []): Buffer {
  const cfg = getConfig();
  const document = Buffer.from(JSON.stringify({ timestamp: 99, data: gzip({ version: 4, browserProfiles: { [ID]: cfg.browserProfiles[ID] }, proxies: {}, accounts: [] }), cookies: { [ID]: gzip(cookies) } }));
  h.objects.set(MAIN, document);
  return document;
}
function cleanup(): void {
  expect(path.dirname(h.root)).toBe(os.tmpdir());
  expect(path.basename(h.root)).toMatch(/^studio-sync-snapshot-/);
  fs.rmSync(h.root, { recursive: true, force: true });
}

beforeEach(() => {
  h.failConfigCommit = false;
  h.unreadableRemote = false;
  h.onPut = null;
  h.objects.clear();
  h.requests = [];
  h.snapshot.mockReset().mockResolvedValue({ state: "available", cookies: [] });
  h.legacyExport.mockReset().mockResolvedValue([]);
  cleanup();
  fs.mkdirSync(h.root);
  reloadConfig();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    h.requests.push({ method, url });
    if (method === "PUT") {
      const body = Buffer.from(init?.body as any);
      const action = await h.onPut?.(url, body);
      if (action === "reject") return new Response("synthetic rejection", { status: 500 });
      h.objects.set(url, body);
      if (action === "lost") { h.unreadableRemote = true; throw new Error("synthetic lost PUT response"); }
      return new Response("", { status: 200 });
    }
    if (h.unreadableRemote) return new Response("synthetic read unavailable", { status: 503 });
    const value = h.objects.get(url);
    return value ? new Response(new Uint8Array(value), { status: 200, headers: { "content-length": String(value.length) } }) : new Response("not found", { status: 404 });
  }));
  seed();
});
afterEach(() => { h.failConfigCommit = false; vi.unstubAllGlobals(); });
afterAll(cleanup);

describe("sync publishes a frozen snapshot, not the latest local draft", () => {
  it("shows unchanged pushed content as synced consistently after disk reload", async () => {
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    expect(listBrowserProfiles().find((item) => item.dirId === ID)?.syncStatus).toBe("synced");
    expect((await getProfileInfo(ID, []))?.syncStatus).toBe("synced");
    expect(rawConfig().browserProfiles[ID].syncBaseline?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    reloadConfig();
    expect(getProfileMeta(ID)?.name).toBe("before");
    expect(listBrowserProfiles().find((item) => item.dirId === ID)?.syncStatus).toBe("synced");
  });

  it("compares Preferences-only changes instead of disagreeing with the profile dirty state", async () => {
    const pushed = await syncService.push();
    expect(pushed.success, pushed.message).toBe(true);
    preferences(ID, { snapshot: "changed-preferences-only" });
    expect(listBrowserProfiles().find((item) => item.dirId === ID)?.syncStatus).toBe("dirty");
    const diff = await syncService.previewDiff();
    expect(diff.ok, diff.message).toBe(true);
    expect(diff.profiles.changed).toEqual(expect.arrayContaining([expect.objectContaining({ id: ID, fields: expect.arrayContaining(["preferences"]) })]));
  });

  it("does not compare sync bookkeeping as a content difference", async () => {
    expect((await syncService.push()).success).toBe(true);
    const cfg = structuredClone(getConfig());
    cfg.browserProfiles[ID].updatedAt = Date.now() + 1000;
    saveConfig(cfg);
    const diff = await syncService.previewDiff();
    expect(diff.ok, diff.message).toBe(true);
    expect(diff.profiles.changed).toEqual([]);
    expect(diff.coverage?.unverified).toEqual([]);
    expect(diff.coverage?.notCompared).toContain("live-cookies");
    expect(listBrowserProfiles().find((item) => item.dirId === ID)?.syncStatus).toBe("synced");
  });

  it("reports legacy missing Preferences as unverified instead of identical", async () => {
    const document = JSON.parse(previousCloud().toString());
    delete document.preferences;
    h.objects.set(MAIN, Buffer.from(JSON.stringify(document)));
    const before = fs.readFileSync(getConfigPath());
    const diff = await syncService.previewDiff();
    expect(diff.ok, diff.message).toBe(true);
    expect(diff.coverage?.unverified).toContainEqual({ id: ID, reason: "remote-preferences-not-covered" });
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
  });

  it.each(["missing-baseline", "contradictory-preferences", "wrong-snapshot"])("does not verify a new snapshot with %s proof", async (fault) => {
    expect((await syncService.push()).success).toBe(true);
    const document = payload();
    const cfg = remoteConfig();
    if (fault === "missing-baseline") delete cfg.browserProfiles[ID].syncBaseline;
    if (fault === "contradictory-preferences") cfg.browserProfiles[ID].syncBaseline.preferences = { state: "absent" };
    if (fault === "wrong-snapshot") cfg.browserProfiles[ID].syncBaseline.snapshotId = "another-snapshot";
    document.data = gzip(cfg);
    h.objects.set(MAIN, Buffer.from(JSON.stringify(document)));
    const diff = await syncService.previewDiff();
    expect(diff.ok, diff.message).toBe(true);
    expect(diff.coverage?.unverified).toContainEqual({ id: ID, reason: "remote-baseline-mismatch" });
  });

  it("preserves transferable business fields instead of omitting them in the upload", async () => {
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    expect(remoteConfig().browserProfiles[ID]).toMatchObject({ tags: ["business"], preset: "qa-preset", appUrl: "https://example.test/app", drm: true });
  });

  it("stores the actual uploaded baseline while retaining edits made during PUT", async () => {
    h.onPut = async (url) => { if (url === MAIN) setProfileMeta(ID, { name: "edited-during-upload" }); };
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    expect(remoteConfig().browserProfiles[ID].name).toBe("before");
    expect(rawConfig().browserProfiles[ID].name).toBe("edited-during-upload");
    const local = rawConfig().browserProfiles[ID].syncBaseline;
    const remote = remoteConfig().browserProfiles[ID].syncBaseline;
    expect(local?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(local).toEqual(remote);
    reloadConfig();
    expect(listBrowserProfiles().find((item) => item.dirId === ID)?.syncStatus).toBe("dirty");
  });

  it("does not mark a profile created during upload as uploaded", async () => {
    h.onPut = async (url) => {
      if (url !== MAIN) return;
      const cfg = structuredClone(getConfig());
      cfg.browserProfiles[NEW_ID] = { name: "new-during-upload", fingerprintSeed: 23456, updatedAt: 200 };
      preferences(NEW_ID);
      saveConfig(cfg);
    };
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    expect(remoteConfig().browserProfiles[NEW_ID]).toBeUndefined();
    expect(rawConfig().browserProfiles[NEW_ID].syncedAt).toBeUndefined();
    expect(rawConfig().browserProfiles[NEW_ID].syncBaseline).toBeUndefined();
    reloadConfig();
    expect(getProfileMeta(NEW_ID)?.name).toBe("new-during-upload");
  });

  it("does not revive a profile deleted during upload", async () => {
    h.onPut = async (url) => { if (url === MAIN) { const cfg = structuredClone(getConfig()); delete cfg.browserProfiles[ID]; saveConfig(cfg); } };
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    expect(remoteConfig().browserProfiles[ID].name).toBe("before");
    expect(rawConfig().browserProfiles[ID]).toBeUndefined();
    reloadConfig();
    expect(getProfileMeta(ID)).toBeNull();
  });

  it("uploads an available empty Cookie snapshot instead of resurrecting old remote cookies", async () => {
    previousCloud([{ domain: "example.test", name: "old", value: "old-remote", path: "/", expires: null, secure: false, httpOnly: true, sameSite: 0 }]);
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    expect(h.snapshot).toHaveBeenCalledWith(ID, undefined);
    expect(JSON.parse(zlib.gunzipSync(Buffer.from(payload().cookies[ID], "base64")).toString())).toEqual([]);
  });

  it("marks unavailable Cookie export as preserved and not freshly verified", async () => {
    const old = previousCloud([{ domain: "example.test", name: "old", value: "old-remote", path: "/", expires: null, secure: false, httpOnly: true, sameSite: 0 }]);
    h.snapshot.mockResolvedValue({ state: "unavailable", reason: "not-running" });
    const result = await syncService.push();
    expect(payload().cookies[ID]).toBe(JSON.parse(old.toString()).cookies[ID]);
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "cookies", id: ID, state: "preserved", code: "COOKIE_SOURCE_UNAVAILABLE" })]));
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it.each([false, true])("does not overwrite an unreadable existing manifest (force=%s)", async (force) => {
    const document = JSON.parse(previousCloud().toString());
    document.data = zlib.gzipSync("not valid config JSON").toString("base64");
    const old = Buffer.from(JSON.stringify(document));
    h.objects.set(MAIN, old);
    const result = await syncService.push(undefined, force);
    expect(result.success).toBe(false);
    expect(h.requests.filter((request) => request.method === "PUT")).toEqual([]);
    expect(h.objects.get(MAIN)).toEqual(old);
    expect(rawConfig().browserProfiles[ID].syncBaseline).toBeUndefined();
  });

  it("does not publish a new manifest if a required extension package PUT is rejected", async () => {
    const zip = path.join(h.root, "extension.zip");
    await writeZipArchive(zip, [
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ manifest_version: 3, name: "Synthetic extension", version: "1.0.0" })) },
      { name: "worker.js", data: Buffer.from("console.log('synthetic extension fixture');") },
    ]);
    await installLocalExtension(zip);
    const old = previousCloud();
    h.onPut = async (url) => /\.(zip|crx)$/.test(url) ? "reject" : undefined;
    const result = await syncService.push();
    expect(result.success).toBe(false);
    expect(hash(h.objects.get(MAIN)!)).toBe(hash(old));
    expect(rawConfig().browserProfiles[ID].syncBaseline).toBeUndefined();
  });

  it("reports unknown remote commit on a lost PUT response without auto-republishing", async () => {
    h.onPut = async (url) => url === MAIN ? "lost" : undefined;
    const result = await syncService.push();
    expect(result).toMatchObject({ success: false, outcome: "partial", remoteCommit: "unknown" });
    expect(h.requests.filter((request) => request.method === "PUT" && request.url === MAIN)).toHaveLength(1);
    expect(remoteConfig().browserProfiles[ID].name).toBe("before");
    expect(rawConfig().browserProfiles[ID].syncBaseline).toBeUndefined();
  });

  it("does not mutate the live config object when saving the local published baseline fails", async () => {
    const before = fs.readFileSync(getConfigPath());
    h.failConfigCommit = true;
    const result = await syncService.push();
    expect(result).toMatchObject({ success: false, outcome: "partial", remoteCommit: "committed", localCommit: "none" });
    expect(hash(fs.readFileSync(getConfigPath()))).toBe(hash(before));
    expect(getConfig().browserProfiles[ID].syncedAt).toBeUndefined();
    expect(getConfig().browserProfiles[ID].syncBaseline).toBeUndefined();
    expect(remoteConfig().browserProfiles[ID].name).toBe("before");
  });
});
