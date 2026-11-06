import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

// Entirely synthetic local state and HTTP fixtures; no application/browser or
// process discovery, native credentials, real cloud endpoint or user data.
const h = vi.hoisted(() => ({ root: "", status: vi.fn(), running: false }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), mkdtempSync: vi.fn(actual.mkdtempSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
vi.mock("electron", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-read-responsive-"));
  return { app: { getPath: () => h.root }, safeStorage: { isEncryptionAvailable: () => false } };
});
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: (id: string) => h.status(id) }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ runtimeCookieOps: { hasRunningBrowser: () => h.running } }));
import { getConfig, getProfilesDir, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { getSyncOperationState } from "../../src/main/services/sync/operation-state.js";
import { syncService } from "../../src/main/services/sync-service.js";

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(actualFs.readFileSync);
  vi.mocked(fs.mkdtempSync).mockReset().mockImplementation(actualFs.mkdtempSync);
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(actualFs.unlinkSync);
  expect(path.dirname(h.root)).toBe(os.tmpdir());
  for (const entry of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, entry), { recursive: true, force: true });
  reloadConfig();
  const cfg = structuredClone(getConfig());
  cfg.sync = { enabled: true, endpoint: "https://synthetic-read.example.test", bucket: "fixture", accessKey: "fixture-access", secretKey: "fixture-secret", custodyConsentAt: 1 };
  cfg.browserProfiles = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`ab_read_${i}`, { name: `synthetic-${i}`, fingerprintMode: "managed", fingerprintSeed: 12345 + i, platform: "windows" }]));
  cfg.proxies = {}; cfg.accounts = []; cfg.extensionRepository = {};
  saveConfig(cfg);
  h.running = false;
  h.status.mockReset().mockReturnValue({ running: false, pid: null, cdpPort: null });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => {
  expect(path.dirname(h.root)).toBe(os.tmpdir());
  expect(path.basename(h.root).startsWith("sync-read-responsive-")).toBe(true);
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("owned read-only service cancellation", () => {
  it("rejects pre-aborted synchronous and asynchronous preview before runtime/filesystem work", async () => {
    const controller = new AbortController(); controller.abort();
    expect(() => syncService.preview(controller.signal)).toThrow();
    await expect(syncService.previewAsync(controller.signal)).rejects.toThrow();
    await expect(syncService.previewDiff(controller.signal)).rejects.toThrow();
    expect(h.status).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(getSyncOperationState().active).toBeNull();
  });

  it("allows the next macrotask to cancel between preview profiles, without a fabricated write receipt", async () => {
    const controller = new AbortController();
    h.status.mockImplementation(() => {
      setImmediate(() => controller.abort());
      return { running: false, pid: null, cdpPort: null };
    });
    await expect(syncService.previewAsync(controller.signal)).rejects.toThrow();
    expect(h.status).toHaveBeenCalledTimes(1);
    expect(getSyncOperationState().active).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps legacy REST preview return shape and asynchronous IPC preview byte-equivalent", async () => {
    const before = fs.readFileSync(path.join(h.root, "config.json"));
    const legacy = syncService.preview();
    expect(legacy).not.toHaveProperty("then");
    const cooperative = await syncService.previewAsync();
    expect(cooperative).toEqual(legacy);
    expect(cooperative).toMatchObject({ configured: true, profiles: 12, runningProfiles: [] });
    expect(fs.readFileSync(path.join(h.root, "config.json")).equals(before)).toBe(true);
    expect(getSyncOperationState().active).toBeNull();
  });

  it("propagates Cancel into the original remote-read request and rejects rather than reports an empty comparison", async () => {
    const controller = new AbortController();
    let remoteSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      remoteSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        remoteSignal!.addEventListener("abort", () => reject(new Error("synthetic remote read aborted")), { once: true });
      });
    }));
    const pending = syncService.previewDiff(controller.signal);
    expect(remoteSignal).toBeDefined();
    controller.abort();
    await expect(pending).rejects.toThrow("synthetic remote read aborted");
    expect(remoteSignal!.aborted).toBe(true);
    expect(getSyncOperationState().active).toBeNull();
  });

  it("checks Cancel after remote completion before accepting a first-push token", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const response = new Response("not found", { status: 404 });
      setImmediate(() => controller.abort());
      return response;
    }));
    await expect(syncService.previewDiff(controller.signal)).rejects.toThrow();
    expect(getSyncOperationState().active).toBeNull();
  });

  it("still returns complete synthetic first-push comparison and canonical decision token without cancellation", async () => {
    const preview = await syncService.previewDiff();
    expect(preview).toMatchObject({ ok: true, firstPush: true });
    expect(preview.comparisonToken).toEqual({ targetId: expect.stringMatching(/^[a-f0-9]{64}$/), localHash: expect.stringMatching(/^[a-f0-9]{64}$/), remoteHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(getSyncOperationState().active).toBeNull();
  });
  it("binds displayed preference coverage and write admission to one captured evidence map", async () => {
    const id = "ab_read_0", profile = path.join(getProfilesDir(), id, "Default");
    fs.mkdirSync(profile, { recursive: true });
    const file = path.join(profile, "Preferences");
    const compared = Buffer.from(JSON.stringify({ browser: { fixture: "compared-A" } }));
    const later = Buffer.from(JSON.stringify({ browser: { fixture: "uncompared-B" } }));
    fs.writeFileSync(file, compared);
    const identity = fs.statSync(file);
    const payload = { version: 1, timestamp: 1,
      data: gzipSync(Buffer.from(JSON.stringify(getConfig()))).toString("base64"),
      preferences: { [id]: gzipSync(compared).toString("base64") }, cookies: {}, localStorage: {} };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const read = actualFs.readFileSync.bind(actualFs);
    let preferenceReads = 0;
    vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const value = read(...args);
      if (typeof args[0] === "number" && fs.fstatSync(args[0]).ino === identity.ino) {
        preferenceReads++;
        if (preferenceReads === 1) setImmediate(() => fs.writeFileSync(file, later));
      }
      return value;
    }) as typeof fs.readFileSync);
    const preview = await syncService.previewDiff();
    expect(preview.ok, preview.message).toBe(true);
    expect(preview.coverage?.unverified.some(item => item.id === id)).toBe(false);
    expect(preview.profiles.changed.some(item => item.id === id && item.fields.includes("preferences"))).toBe(false);
    expect(preferenceReads).toBe(1);
    expect(fs.readFileSync(file).equals(later)).toBe(true);
    const result = await syncService.push(undefined, false, preview.comparisonToken);
    expect(result).toMatchObject({ success: false, code: "SYNC_PREVIEW_STALE", localCommit: "none", remoteCommit: "none" });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
    expect(getSyncOperationState().active).toBeNull();
  });

  it.each([false, true])("holds the operation through cooperative owned cleanup (replace root: %s)", async replaceRoot => {
    const config = getConfig(); config.browserProfiles = {}; config.extensionRepository = {};
    config.sync!.includeHistory = false; saveConfig(config);
    const cloud = new Map<string, Buffer>();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const key = new URL(String(input)).pathname;
      if (init?.method === "PUT") {
        cloud.set(key, Buffer.from(await new Response(init.body).arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      const body = cloud.get(key);
      return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
    }));
    let root = "", retained = "", scheduled = false;
    let observed: ReturnType<typeof getSyncOperationState> | undefined, callbackError: unknown;
    vi.mocked(fs.mkdtempSync).mockImplementation(((...args: Parameters<typeof fs.mkdtempSync>) => {
      const directory = actualFs.mkdtempSync(...args) as string;
      if (path.basename(String(args[0])).startsWith(".sync-pull-stage-")) {
        root = directory;
        for (let i = 0; i < 1000; i++) actualFs.writeFileSync(path.join(root, `owned-${i}.tmp`), "fixture");
      }
      return directory;
    }) as typeof fs.mkdtempSync);
    vi.mocked(fs.unlinkSync).mockImplementation(file => {
      actualFs.unlinkSync(file);
      if (!scheduled && root && path.dirname(String(file)) === root) {
        scheduled = true;
        setImmediate(() => {
          try {
            observed = getSyncOperationState();
            if (replaceRoot) {
              // Verify both absolute fixture paths before the intentional move.
              expect(path.resolve(root)).toBe(root);
              expect(path.dirname(root)).toBe(path.resolve(getProfilesDir()));
              expect(path.basename(root)).toMatch(/^\.sync-pull-stage-/);
              retained = root + "-retained-original";
              expect(path.resolve(retained)).toBe(retained);
              expect(path.dirname(retained)).toBe(path.dirname(root));
              actualFs.renameSync(root, retained);
              actualFs.mkdirSync(root);
              actualFs.writeFileSync(path.join(root, "unknown-replacement.txt"), "DO NOT DELETE");
            }
          } catch (error) { callbackError = error; }
        });
      }
    });
    const result = await syncService.push();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(callbackError).toBeUndefined();
    expect(result).toMatchObject({ success: true, localCommit: "committed", remoteCommit: "committed" });
    expect(root).not.toBe("");
    expect(observed?.active?.operationId).toBe(result.operationId);
    if (replaceRoot) {
      expect(actualFs.readFileSync(path.join(root, "unknown-replacement.txt"), "utf8")).toBe("DO NOT DELETE");
      expect(actualFs.existsSync(retained)).toBe(true);
      expect(result.warnings?.some(warning => warning.includes("ownership changed"))).toBe(true);
    } else {
      expect(actualFs.existsSync(root)).toBe(false);
    }
    expect(getSyncOperationState().active).toBeNull();
  });

});
