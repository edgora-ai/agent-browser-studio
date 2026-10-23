// Read-only review regressions: actual SyncService/config/repository/ZIP paths,
// private real files, runtime Cookie boundary mock, and an in-memory Map-S3.
// Production-source fixes belong to the coordinator, not this test's owner.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import type { CookieInfo, SyncResult } from "../../src/main/types.js";

type PutAction = { status?: number; replacement?: Buffer; lost?: boolean; afterStore?: () => void };
type GetAction = { status?: number; replacement?: Buffer };
const h = await vi.hoisted(async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "abs-sync-publication-boundaries-")),
    objects: new Map<string, Buffer>(), requests: [] as Array<{ method: string; key: string }>,
    onPut: null as null | ((key: string, body: Buffer) => PutAction | void | Promise<PutAction | void>),
    onGet: null as null | ((key: string, body?: Buffer) => GetAction | void),
    snapshot: vi.fn(), running: new Set<string>(),
  };
});
vi.mock("electron", () => ({ app: { getPath: (name: string) => path.join(h.root, name === "home" ? "home" : "user-data") } }));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  statusBrowser: (id: string) => ({ running: h.running.has(id), pid: null, cdpPort: null }),
}));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({
  runtimeCookieOps: {
    hasRunningBrowser: (id: string) => h.running.has(id), exportCookiesSnapshot: h.snapshot,
    importCookies: async (_id: string, cookies: unknown[]) => cookies.length,
  },
}));
vi.mock("../../src/main/services/proxy-detector.js", () => ({
  downloadFileWithCurl: () => { throw new Error("Real downloads are forbidden in publication fixtures"); },
}));
import { syncService } from "../../src/main/services/sync-service.js";
import { getConfig, getConfigPath, getProfilesDir, getProfileMeta, reloadConfig, saveConfig, setProfileMeta } from "../../src/main/services/config-manager.js";
import { readProfileSyncState } from "../../src/main/services/sync/profile-state.js";
import { installLocalExtension } from "../../src/main/services/extension-repository.js";
import { listExtensions } from "../../src/main/services/launch-args.js";

const ID = "ab_publication_boundary", ENDPOINT = "https://publication-fixture.example.test", BUCKET = "synthetic";
const PREFIX = `${ENDPOINT}/${BUCKET}/`, MAIN = "agent-browser-studio-config.json";
const cookieKey = (id = ID) => `cookies-${id}.json`;
const prefsKey = (id = ID) => `preferences-${id}.json`;
const gzip = (value: unknown) => zlib.gzipSync(JSON.stringify(value)).toString("base64");
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const cloud = () => JSON.parse(h.objects.get(MAIN)!.toString("utf8"));
const remoteConfig = () => JSON.parse(zlib.gunzipSync(Buffer.from(cloud().data, "base64")).toString("utf8"));
const cookie: CookieInfo = { domain: "example.test", name: "sid", value: "owned synthetic cookie", path: "/", expires: null, secure: false, httpOnly: false, sameSite: 0 };
const packageKey = (key: string) => /^extension-.+\.(zip|crx)$/.test(key);
const puts = (key: string) => h.requests.filter((request) => request.method === "PUT" && request.key === key);

function writePreferences(id: string, value: unknown = { boundary: "before" }): void {
  const file = path.join(getProfilesDir(), id, "Default", "Preferences");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value));
}
function seed(ids = [ID]): void {
  const cfg = structuredClone(getConfig());
  cfg.sync = { enabled: true, endpoint: ENDPOINT, bucket: BUCKET, accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: Date.now() } as any;
  cfg.browserProfiles = Object.fromEntries(ids.map((id) => [id, { name: "frozen before", engine: "chromium", fingerprintMode: "managed", fingerprintSeed: 12345, platform: "windows", updatedAt: 100 }])) as any;
  cfg.extensionRepository = {};
  saveConfig(cfg);
  for (const id of ids) writePreferences(id);
  expect(getConfigPath()).toBe(path.join(h.root, "user-data", "config.json"));
  expect(Object.keys(disk().browserProfiles).sort()).toEqual([...ids].sort());
  reloadConfig();
  for (const id of ids) expect(getProfileMeta(id)?.name).toBe("frozen before");
}
function previous(cookies: Record<string, string> = {}): Buffer {
  const cfg = getConfig();
  const body = Buffer.from(JSON.stringify({ timestamp: 100, data: gzip({ version: 4, browserProfiles: cfg.browserProfiles, proxies: {}, accounts: [] }), cookies }));
  h.objects.set(MAIN, body);
  return body;
}
async function pushResult(signal?: AbortSignal): Promise<SyncResult> {
  try { return await syncService.push(signal); }
  catch (error) {
    if (!(error as any)?.syncResult) throw error;
    return (error as any).syncResult;
  }
}
async function extension(): Promise<string> {
  const source = fs.mkdtempSync(path.join(h.root, "owned-extension-"));
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Publication boundary", version: "1.0.0" }));
  fs.writeFileSync(path.join(source, "worker.js"), "globalThis.ownedPublicationBoundary = true;\n");
  const installed = await installLocalExtension(source);
  expect(disk().extensionRepository[installed.id]).toBeDefined();
  reloadConfig();
  expect(getConfig().extensionRepository?.[installed.id]).toBeDefined();
  return installed.id;
}
function assertPublishedFacts(result: SyncResult): void {
  expect(result.remoteCommit).toBe("committed");
  expect(result.localCommit).toBe("committed");
  expect(cloud().snapshotId).toBe(result.operationId);
  expect(disk().browserProfiles[ID].syncBaseline.snapshotId).toBe(result.operationId);
  reloadConfig();
  expect(getProfileMeta(ID)?.syncBaseline?.snapshotId ?? getConfig().browserProfiles[ID].syncBaseline?.snapshotId).toBe(result.operationId);
}

beforeEach(() => {
  h.onPut = null; h.onGet = null; h.objects.clear(); h.requests = []; h.running.clear();
  h.snapshot.mockReset().mockResolvedValue({ state: "available", cookies: [] });
  for (const child of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, child), { recursive: true, force: true });
  reloadConfig();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(PREFIX)) throw new Error("Unknown external destination is forbidden in Map-S3 fixtures");
    const key = url.slice(PREFIX.length), method = init?.method || "GET";
    h.requests.push({ method, key });
    if (method === "PUT") {
      const body = Buffer.from(init?.body as any), action = (await h.onPut?.(key, body)) || undefined;
      if (action?.status && action.status >= 400) return new Response("owned fixture rejection", { status: action.status });
      h.objects.set(key, Buffer.from(action?.replacement ?? body));
      action?.afterStore?.();
      if (action?.lost) throw new Error("owned fixture lost PUT acknowledgement");
      return new Response("", { status: action?.status ?? 200 });
    }
    if (method !== "GET") throw new Error("Unexpected Map-S3 operation");
    const stored = h.objects.get(key), action = h.onGet?.(key, stored) || undefined;
    if (action?.status && action.status >= 400) return new Response("owned fixture read failure", { status: action.status });
    const body = action?.replacement ?? stored;
    return body ? new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } }) : new Response("not found", { status: 404 });
  }));
  seed(); previous();
});
afterEach(() => { h.onPut = null; h.onGet = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => {
  expect(path.dirname(h.root)).toBe(os.tmpdir());
  expect(fs.lstatSync(h.root).isSymbolicLink()).toBe(false);
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("required extension packages precede the authoritative snapshot", () => {
  it("publishes and byte-verifies required packages before the manifest", async () => {
    const id = await extension();
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    const entry = remoteConfig().extensionRepository[id];
    const key = [...h.objects.keys()].find(packageKey)!;
    expect(createHash("sha512").update(h.objects.get(key)!).digest("hex")).toBe(entry.packageHash);
    const packagePut = h.requests.findIndex((r) => r.method === "PUT" && r.key === key);
    const packageGet = h.requests.findIndex((r) => r.method === "GET" && r.key === key);
    const manifestPut = h.requests.findIndex((r) => r.method === "PUT" && r.key === MAIN);
    expect(packagePut).toBeLessThan(packageGet); expect(packageGet).toBeLessThan(manifestPut);
    assertPublishedFacts(result);
  });

  it.each(["reject", "missing", "tamper"] as const)("does not replace the manifest when required package %s prevents verification", async (fault) => {
    const id = await extension(), beforeHash = sha(h.objects.get(MAIN)!), beforePackageHash = disk().extensionRepository[id].packageHash;
    h.onPut = (key) => packageKey(key) && fault === "reject" ? { status: 500 } : undefined;
    h.onGet = (key) => packageKey(key) ? fault === "missing" ? { status: 404 } : fault === "tamper" ? { replacement: Buffer.from("wrong immutable package bytes") } : undefined : undefined;
    const result = await syncService.push();
    expect(result.success).toBe(false); expect(result.remoteCommit).toBe("none");
    expect(puts(MAIN)).toHaveLength(0); expect(sha(h.objects.get(MAIN)!)).toBe(beforeHash);
    expect(disk().browserProfiles[ID].syncBaseline).toBeUndefined();
    expect(disk().extensionRepository[id].packageHash).toBe(beforePackageHash);
  });
});

describe("compatibility sidecars and publication facts", () => {
  it("retains committed primary/local facts when a compatibility sidecar returns HTTP 500", async () => {
    const oldSidecar = Buffer.from("owned old sidecar"); h.objects.set(cookieKey(), oldSidecar);
    h.onPut = (key) => key === cookieKey() ? { status: 500 } : undefined;
    const result = await syncService.push();
    expect(result).toMatchObject({ success: false, outcome: "partial", remoteCommit: "committed", localCommit: "committed" });
    expect(result.items).toContainEqual(expect.objectContaining({ scope: "sidecar", id: cookieKey(), state: "failed" }));
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/authoritative snapshot.*published/i)]));
    expect(sha(h.objects.get(cookieKey())!)).toBe(sha(oldSidecar));
    assertPublishedFacts(result);
  });

  it("does not report rollback or republish the manifest after a lost sidecar acknowledgement", async () => {
    h.onPut = (key) => key === cookieKey() ? { lost: true } : undefined;
    const result = await syncService.push();
    assertPublishedFacts(result);
    expect(puts(MAIN)).toHaveLength(1); expect(puts(cookieKey())).toHaveLength(1);
    expect(JSON.parse(h.objects.get(cookieKey())!.toString()).cookies).toEqual([]);
    if (result.success) {
      expect(h.requests.some((request) => request.method === "GET" && request.key === cookieKey())).toBe(true);
    } else {
      expect(result.outcome).toBe("partial");
      expect(result.items).toContainEqual(expect.objectContaining({ scope: "sidecar", id: cookieKey(), state: "unknown" }));
      expect(result.warnings?.length).toBeGreaterThan(0);
    }
  });

  it("does not claim complete verified publication for an acknowledged but tampered sidecar", async () => {
    h.onPut = (key) => key === cookieKey() ? { replacement: Buffer.from(JSON.stringify({ dirId: ID, count: 1, cookies: [cookie] })) } : undefined;
    const result = await syncService.push();
    assertPublishedFacts(result);
    expect(JSON.parse(zlib.gunzipSync(Buffer.from(cloud().cookies[ID], "base64")).toString())).toEqual([]);
    expect(JSON.parse(h.objects.get(cookieKey())!.toString()).cookies).toHaveLength(1);
    expect(result.success, "HTTP acknowledgement alone cannot verify the stored compatibility bytes").toBe(false);
    expect(result.outcome).toBe("partial");
    expect(result.items).toContainEqual(expect.objectContaining({ scope: "sidecar", id: cookieKey(), state: expect.stringMatching(/failed|unknown/) }));
  });

  it.each(["new", "stale"] as const)("retains per-profile extension inventory sidecar creation/refresh (%s)", async (mode) => {
    const extId = "a".repeat(32), key = `extensions-${ID}.json`;
    const directory = path.join(getProfilesDir(), ID, "Default", "Extensions", extId, "2.0.0_0");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Current inventory fixture", version: "2.0.0" }));
    expect(listExtensions(ID)).toEqual(expect.arrayContaining([expect.objectContaining({ id: extId, name: "Current inventory fixture", version: "2.0.0" })]));
    if (mode === "stale") h.objects.set(key, Buffer.from(JSON.stringify({ dirId: ID, timestamp: 1, extensions: [{ id: extId, name: "stale inventory", version: "1.0.0" }] })));
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    expect(puts(key), "the compatibility inventory must not disappear from the new producer").toHaveLength(1);
    const inventory = JSON.parse(h.objects.get(key)!.toString());
    expect(inventory.extensions).toEqual([{ id: extId, name: "Current inventory fixture", version: "2.0.0" }]);
    expect(inventory.timestamp).toBe(cloud().timestamp);
  });
});

describe("cancellation and concurrent edits around commit", () => {
  it("records no commit when capture is cancelled before the first publication", async () => {
    const controller = new AbortController(), before = sha(h.objects.get(MAIN)!), local = sha(fs.readFileSync(getConfigPath()));
    h.snapshot.mockImplementation(async () => { controller.abort(); return { state: "available", cookies: [] }; });
    const result = await pushResult(controller.signal);
    expect(result).toMatchObject({ success: false, outcome: "cancelled", localCommit: "none", remoteCommit: "none" });
    expect(h.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(sha(h.objects.get(MAIN)!)).toBe(before); expect(sha(fs.readFileSync(getConfigPath()))).toBe(local);
  });

  it("retains the manifest commit fact after cancellation at an accepted primary PUT", async () => {
    const controller = new AbortController(), local = sha(fs.readFileSync(getConfigPath()));
    h.onPut = (key) => key === MAIN ? { afterStore: () => controller.abort() } : undefined;
    const result = await pushResult(controller.signal);
    expect(result).toMatchObject({ success: false, outcome: "partial", remoteCommit: "committed", localCommit: "none" });
    expect(cloud().snapshotId).toBe(result.operationId); expect(puts(MAIN)).toHaveLength(1);
    expect(sha(fs.readFileSync(getConfigPath()))).toBe(local);
    expect(disk().browserProfiles[ID].syncBaseline).toBeUndefined();
  });

  it.each(["first", "last"] as const)("reports cancellation after the %s accepted sidecar without hiding completed commits", async (phase) => {
    const controller = new AbortController(), selected = phase === "first" ? cookieKey() : prefsKey();
    h.onPut = (key) => key === selected ? { afterStore: () => controller.abort() } : undefined;
    const result = await pushResult(controller.signal);
    expect(controller.signal.aborted).toBe(true);
    assertPublishedFacts(result);
    expect(result).toMatchObject({ success: false, outcome: "partial", code: "SYNC_CANCELLED" });
    expect(puts(MAIN)).toHaveLength(1);
  });

  it.each(["retain", "revert"] as const)("stores only the frozen baseline while a concurrent edit is %s", async (edit) => {
    h.onPut = (key) => {
      if (key !== MAIN) return;
      setProfileMeta(ID, { name: "concurrent edit" });
      if (edit === "revert") setProfileMeta(ID, { name: "frozen before" });
    };
    const result = await syncService.push();
    expect(result.success, result.message).toBe(true);
    expect(remoteConfig().browserProfiles[ID].name).toBe("frozen before");
    expect(disk().browserProfiles[ID].name).toBe(edit === "retain" ? "concurrent edit" : "frozen before");
    expect(disk().browserProfiles[ID].syncBaseline).toEqual(remoteConfig().browserProfiles[ID].syncBaseline);
    reloadConfig();
    expect(readProfileSyncState(ID, getConfig().browserProfiles[ID]).syncStatus).toBe(edit === "retain" ? "dirty" : "synced");
  });
});

describe("producer/receiver budget and Cookie structure contracts", () => {
  it("counts retained old Cookies together with captured Cookies before publication", async () => {
    const ids = ["ab_limit_a", "ab_limit_b", "ab_limit_c"];
    seed(ids);
    const list = Array.from({ length: 20_000 }, (_, index) => ({ ...cookie, name: `c${index}` }));
    const old = previous({ [ids[0]]: gzip(list), [ids[1]]: gzip(list) }); // Valid prior total: 40k.
    h.snapshot.mockImplementation(async (id: string) => id === ids[2] ? { state: "available", cookies: list } : { state: "unavailable", reason: "fixture_stopped" });
    const pushed = await syncService.push();
    if (pushed.success) {
      const total = Object.values(cloud().cookies).reduce((count: number, encoded: any) => count + JSON.parse(zlib.gunzipSync(Buffer.from(encoded, "base64")).toString()).length, 0);
      expect(total).toBe(60_000);
      const beforePull = sha(fs.readFileSync(getConfigPath()));
      const pulled = await syncService.pull(undefined, { strategy: "remote" });
      expect(pulled).toMatchObject({ success: false, localCommit: "none" });
      expect(pulled.message).toMatch(/too many cookies/i);
      expect(sha(fs.readFileSync(getConfigPath()))).toBe(beforePull);
    }
    expect(pushed.success, "a valid 40k prior snapshot plus 20k new Cookies must not publish a receiver-rejected 60k snapshot").toBe(false);
    expect(sha(h.objects.get(MAIN)!)).toBe(sha(old));
    expect(puts(MAIN)).toHaveLength(0);
  });

  it("rejects an oversized captured Cookie blob before primary/baseline commit, not during sidecar construction", async () => {
    const old = Buffer.from(h.objects.get(MAIN)!);
    const list = Array.from({ length: 2000 }, (_, index) => ({ ...cookie, name: `large${index}`, value: randomBytes(3072).toString("base64") }));
    const encoded = zlib.gzipSync(JSON.stringify(list));
    expect(encoded.length).toBeGreaterThan(5 * 1024 * 1024);
    h.snapshot.mockResolvedValue({ state: "available", cookies: list });
    const result = await syncService.push();
    if (puts(MAIN).length) {
      const pulled = await syncService.pull(undefined, { strategy: "remote" });
      expect(pulled.success).toBe(false); expect(pulled.message).toMatch(/cookies.*too large/i);
    }
    expect(result.success).toBe(false);
    expect(result.remoteCommit, "oversized Cookie blob validation belongs before authoritative publication").toBe("none");
    expect(result.localCommit).toBe("none");
    expect(sha(h.objects.get(MAIN)!)).toBe(sha(old));
  });

  it("does not publish a Preferences gzip that the receiver's 2 MiB compressed cap rejects", async () => {
    const old = Buffer.from(h.objects.get(MAIN)!);
    // One bounded ~2.9 MiB disposable file, not 50/500 MiB aggregate fixtures.
    const value = { entropy: randomBytes(2 * 1024 * 1024 + 64 * 1024).toString("base64") };
    const raw = Buffer.from(JSON.stringify(value));
    expect(raw.length).toBeLessThan(10 * 1024 * 1024);
    expect(zlib.gzipSync(raw).length).toBeGreaterThan(2 * 1024 * 1024);
    writePreferences(ID, value);
    const pushed = await syncService.push();
    if (pushed.success) {
      const pulled = await syncService.pull(undefined, { strategy: "remote" });
      expect(pulled.success).toBe(false); expect(pulled.message).toMatch(/preferences.*too large/i);
    }
    expect(pushed.success, "producer accepted a Preferences blob rejected by its own receiver").toBe(false);
    expect(puts(MAIN)).toHaveLength(0); expect(sha(h.objects.get(MAIN)!)).toBe(sha(old));
  });

  it.each([{ secure: "false" }, { httpOnly: "false" }, { value: null }])("rejects malformed CookieInfo rather than silently changing credential semantics: %j", async (fault) => {
    previous({ [ID]: gzip([{ ...cookie, ...fault }]) });
    const before = sha(fs.readFileSync(getConfigPath()));
    const result = await syncService.pull(undefined, { strategy: "remote" });
    if (result.success) {
      const queue = JSON.parse(fs.readFileSync(path.join(h.root, "user-data", "pending-cookie-imports", `${ID}.json`), "utf8"));
      if ("secure" in fault) expect(queue[0].secure).toBe(true);
      if ("httpOnly" in fault) expect(queue[0].httpOnly).toBe(true);
      if ("value" in fault) expect(queue[0].value).toBe("");
    }
    expect(result.success, "malformed transport CookieInfo must not be silently coerced into different values").toBe(false);
    expect(result.localCommit).toBe("none");
    expect(sha(fs.readFileSync(getConfigPath()))).toBe(before);
  });
});
