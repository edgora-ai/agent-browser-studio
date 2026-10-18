// F01: the profile selected by pull also selects its browser artifacts.
// Real Electron + IPC + temp userData, with a loopback-only in-process S3 fixture.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";

const CONFIG_KEY = "agent-browser-studio-config.json";
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "f01-sync-pull-"));
const profileDir = (id: string) => path.join(USERDATA, "profiles", id, "Default");
const cookiePath = (id: string) => path.join(USERDATA, "pending-cookie-imports", `${id}.json`);
const prefs = (side: string) => JSON.stringify({ profile: { f01: side } });
const cookie = (side: string) => ({ domain: "example.test", name: "f01", value: side, path: "/", expires: null, secure: false, httpOnly: true, sameSite: 0 });
const readConfig = () => JSON.parse(fs.readFileSync(path.join(USERDATA, "config.json"), "utf8"));

function localStorageArchive(side: string): string {
  // Structural selection fixture only; real LevelDB semantics are exercised
  // by sync-state-acceptance with a production-launched managed browser.
  const parts: Buffer[] = [];
  for (const [name, text] of [["CURRENT", "MANIFEST-000001\n"], ["MANIFEST-000001", "synthetic manifest"], ["000001.log", side]]) {
    const data = Buffer.from(text), header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000600\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.fill(0x20, 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    parts.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])).toString("base64");
}

async function mockS3() {
  const objects = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === `/bucket/${CONFIG_KEY}` && objects.has(req.url)) {
      const body = objects.get(req.url)!;
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
    put(payload: object) { objects.set(`/bucket/${CONFIG_KEY}`, Buffer.from(JSON.stringify(payload))); },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("F01 pull source selection and browser artifacts", () => {
  let h: TestAppHandle;
  let s3: Awaited<ReturnType<typeof mockS3>>;

  beforeAll(async () => {
    s3 = await mockS3();
    h = await setupTestApp({ userDataDir: USERDATA });
    const runtime = await h.app.evaluate(({ app }) => ({
      nodeHome: process.getBuiltinModule("os").homedir(),
      userData: app.getPath("userData"),
      envHome: process.env.HOME,
      providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(runtime.nodeHome)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(fs.realpathSync(runtime.userData)).toBe(fs.realpathSync(USERDATA));
    expect(fs.realpathSync(runtime.envHome!)).toBe(fs.realpathSync(runtime.nodeHome));
    expect(runtime.providerKeys).toEqual([]);
    const llm = await h.page.evaluate(async () => ({
      configured: await (window as any).agentBrowserAPI.agent.llmConfig(),
      detected: await (window as any).agentBrowserAPI.agent.detectLlmConfig(),
    }));
    expect(llm.configured?.hasApiKey ?? false).toBe(false);
    expect(llm.detected?.hasApiKey ?? false).toBe(false);
    const configured = await h.page.evaluate((endpoint) => (window as any).agentBrowser.api.sync.configure({
      enabled: true, endpoint, bucket: "bucket", accessKey: "f01ak", secretKey: "f01sk", custodyConsent: true,
    }), s3.endpoint);
    expect(configured.success).toBe(true);
    expect((await h.page.evaluate(() => (window as any).agentBrowser.api.sync.status())).custodyConsentAt).toBeGreaterThan(0);
  }, 90000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (s3) await s3.close();
    // The only path removed here was created by this test's mkdtempSync call.
    if (path.dirname(USERDATA) !== os.tmpdir() || !path.basename(USERDATA).startsWith("f01-sync-pull-")) throw new Error("Unsafe F01 cleanup path");
    fs.rmSync(USERDATA, { recursive: true, force: true });
  }, 90000);

  async function scenario(name: string, options: {
    strategy?: string;
    resolution?: "local" | "remote" | "newest";
    remoteAt?: number | "tie";
    sameMeta?: boolean;
    remoteMarker?: boolean;
    expected: "local" | "remote";
    locked?: boolean;
  }) {
    const created = await h.page.evaluate((label) => (window as any).agentBrowser.api.browser.create({ name: label, platform: "windows", fingerprintSeed: 63636 }), `F01-${name}`);
    const id = created.dirId as string;
    expect(id, JSON.stringify(created)).toMatch(/^ab_/);
    const disk = readConfig();
    const local = disk.browserProfiles[id];
    expect(local.name).toBe(`F01-${name}`);
    const actualLocal = readConfig().browserProfiles[id];
    const remote = {
      ...actualLocal,
      name: options.sameMeta ? actualLocal.name : `${actualLocal.name}-remote`,
      updatedAt: options.remoteAt === "tie" ? actualLocal.updatedAt : options.remoteAt ?? actualLocal.updatedAt + 10000,
      ...(options.remoteMarker ? { syncedAt: 1760000000000, syncedHash: "remote-marker" } : {}),
    };
    const localDefault = profileDir(id);
    const localLs = path.join(localDefault, "Local Storage", "leveldb", "000001.log");
    fs.mkdirSync(path.dirname(localLs), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(localLs), "CURRENT"), "MANIFEST-000001\n");
    fs.writeFileSync(path.join(path.dirname(localLs), "MANIFEST-000001"), "synthetic local manifest");
    fs.writeFileSync(localLs, "local");
    fs.writeFileSync(path.join(localDefault, "Preferences"), prefs("local"));
    fs.mkdirSync(path.dirname(cookiePath(id)), { recursive: true });
    fs.writeFileSync(cookiePath(id), JSON.stringify([cookie("local")]));
    if (options.locked) fs.writeFileSync(path.join(USERDATA, "profiles", id, "SingletonLock"), "running-marker");

    s3.put({
      version: 4, timestamp: 1760000000000,
      data: zlib.gzipSync(JSON.stringify({ version: 4, browserProfiles: { [id]: remote }, proxies: {}, accounts: [] })).toString("base64"),
      cookies: { [id]: zlib.gzipSync(JSON.stringify([cookie("remote")])).toString("base64") },
      localStorage: { [id]: localStorageArchive("remote") },
      preferences: { [id]: zlib.gzipSync(prefs("remote")).toString("base64") },
    });
    const pull = await h.page.evaluate((input) => (window as any).agentBrowser.api.sync.pull(input), {
      strategy: options.strategy,
      resolutions: options.resolution ? { [`profiles:${id}`]: options.resolution } : undefined,
    });
    expect(pull.success, pull.message).toBe(!options.locked);
    if (options.locked) expect(pull.outcome).toBe("partial");
    const metadata = readConfig().browserProfiles[id];
    const fromApi = await h.page.evaluate((profileId) => (window as any).agentBrowser.api.profile.get(profileId), id);
    const fromQuery = (await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list()) as any[]).filter((entry) => entry.dirId === id);
    expect(fromQuery).toHaveLength(1);
    const source = options.expected;
    expect(metadata.name).toBe(source === "remote" ? remote.name : actualLocal.name);
    expect(fromApi.name).toBe(metadata.name);
    expect(fromQuery[0].name).toBe(metadata.name);
    expect(JSON.parse(fs.readFileSync(path.join(localDefault, "Preferences"), "utf8")).profile.f01).toBe(options.locked ? "local" : source);
    expect(fs.readFileSync(localLs, "utf8")).toBe(options.locked ? "local" : source);
    expect(JSON.parse(fs.readFileSync(cookiePath(id), "utf8"))[0].value).toBe(source);
    if (source === "local") {
      expect(metadata.syncedAt).toBe(actualLocal.syncedAt);
      expect(metadata.syncedHash).toBe(actualLocal.syncedHash);
      expect(fromQuery[0].syncStatus).not.toBe("synced");
    }
    return { id, metadata, fromApi, fromQuery };
  }

  it("keeps existing files, queued cookies, and sync markers for default local despite newer remote", async () => {
    await scenario("local", { expected: "local" });
  });

  it("imports the remote browser artifacts with remote metadata", async () => {
    await scenario("remote", { strategy: "remote", expected: "remote" });
  });

  it("newest chooses the newer remote and preserves the newer local or tied local", async () => {
    await scenario("newest-remote", { strategy: "newest", expected: "remote" });
    await scenario("newest-local", { strategy: "newest", remoteAt: 1, expected: "local" });
    await scenario("newest-tie", { strategy: "newest", remoteAt: "tie", expected: "local" });
  });

  it("applies per-profile resolution before files, overriding either global choice", async () => {
    await scenario("override-local", { strategy: "remote", resolution: "local", expected: "local" });
    await scenario("override-remote", { strategy: "local", resolution: "remote", remoteAt: 1, expected: "remote" });
  });

  it("resolves artifact-only differences even when profile metadata is identical", async () => {
    const { id, metadata } = await scenario("equal", { strategy: "local", sameMeta: true, remoteMarker: true, expected: "local" });
    const result = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "remote" }));
    expect(result.success, result.message).toBe(true);
    expect(readConfig().browserProfiles[id].name).toBe(metadata.name);
    expect(JSON.parse(fs.readFileSync(path.join(profileDir(id), "Preferences"), "utf8")).profile.f01).toBe("remote");
    expect(fs.readFileSync(path.join(profileDir(id), "Local Storage", "leveldb", "000001.log"), "utf8")).toBe("remote");
    expect(JSON.parse(fs.readFileSync(cookiePath(id), "utf8"))[0].value).toBe("remote");
    expect((await h.page.evaluate((profileId) => (window as any).agentBrowser.api.profile.get(profileId), id)).name).toBe(metadata.name);
  });

  it("imports remote-only and retains local-only profiles while preserving running-profile files", async () => {
    const remoteOnlyId = "ab_f01_remote_only";
    const { browserProfiles } = readConfig();
    const localOnlyId = Object.keys(browserProfiles)[0];
    const localOnlySnapshot = JSON.stringify(browserProfiles[localOnlyId]);
    const remoteOnly = { name: "F01 remote only", fingerprintMode: "managed", fingerprintSeed: 7, platform: "windows", updatedAt: 10 };
    s3.put({
      version: 4, timestamp: 1760000000000,
      data: zlib.gzipSync(JSON.stringify({ version: 4, browserProfiles: { [remoteOnlyId]: remoteOnly }, proxies: {}, accounts: [] })).toString("base64"),
      cookies: { [remoteOnlyId]: zlib.gzipSync(JSON.stringify([cookie("remote")])).toString("base64") },
      localStorage: { [remoteOnlyId]: localStorageArchive("remote") },
      preferences: { [remoteOnlyId]: zlib.gzipSync(prefs("remote")).toString("base64") },
    });
    const result = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "local" }));
    expect(result.success, result.message).toBe(true);
    const config = readConfig();
    expect(JSON.stringify(config.browserProfiles[localOnlyId])).toBe(localOnlySnapshot);
    expect(config.browserProfiles[remoteOnlyId].name).toBe(remoteOnly.name);
    expect(JSON.parse(fs.readFileSync(path.join(profileDir(remoteOnlyId), "Preferences"), "utf8")).profile.f01).toBe("remote");
    expect(fs.readFileSync(path.join(profileDir(remoteOnlyId), "Local Storage", "leveldb", "000001.log"), "utf8")).toBe("remote");
    expect(JSON.parse(fs.readFileSync(cookiePath(remoteOnlyId), "utf8"))[0].value).toBe("remote");
    const profiles = await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list()) as any[];
    expect(profiles.filter((p) => p.dirId === remoteOnlyId).map((p) => p.name)).toEqual([remoteOnly.name]);
    expect(profiles.filter((p) => p.dirId === localOnlyId)).toHaveLength(1);
    await scenario("running", { strategy: "remote", expected: "remote", locked: true });
  });

  it("leaves the chosen profile unchanged if artifact decoding fails before its restore", async () => {
    const id = Object.keys(readConfig().browserProfiles)[0];
    const before = JSON.stringify(readConfig().browserProfiles[id]);
    const beforePrefs = fs.readFileSync(path.join(profileDir(id), "Preferences"));
    const beforeLs = fs.readFileSync(path.join(profileDir(id), "Local Storage", "leveldb", "CURRENT"));
    s3.put({
      version: 4, timestamp: 1760000000000,
      data: zlib.gzipSync(JSON.stringify({ version: 4, browserProfiles: { [id]: { ...readConfig().browserProfiles[id], name: "malformed remote" } }, proxies: {}, accounts: [] })).toString("base64"),
      localStorage: { [id]: "invalid base64!" },
    });
    const result = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "remote" }));
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/base64/);
    expect(JSON.stringify(readConfig().browserProfiles[id])).toBe(before);
    expect(fs.readFileSync(path.join(profileDir(id), "Preferences"))).toEqual(beforePrefs);
    expect(fs.readFileSync(path.join(profileDir(id), "Local Storage", "leveldb", "CURRENT"))).toEqual(beforeLs);
    const entry = await h.page.evaluate((profileId) => (window as any).agentBrowser.api.profile.get(profileId), id);
    expect(entry.name).toBe(JSON.parse(before).name);
  });

  it("rejects unknown artifact IDs before touching a local profile or creating remote-only directories", async () => {
    const existingId = Object.keys(readConfig().browserProfiles)[0];
    const before = JSON.stringify(readConfig().browserProfiles[existingId]);
    const phantom = "ab_f01_phantom";
    s3.put({
      version: 4, timestamp: 1760000000000,
      data: zlib.gzipSync(JSON.stringify({ version: 4, browserProfiles: { ab_f01_new: { name: "new" } }, proxies: {}, accounts: [] })).toString("base64"),
      cookies: { [phantom]: zlib.gzipSync(JSON.stringify([cookie("remote")])).toString("base64") },
    });
    const result = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "remote" }));
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/unknown profile/);
    expect(JSON.stringify(readConfig().browserProfiles[existingId])).toBe(before);
    expect(fs.existsSync(path.join(USERDATA, "profiles", "ab_f01_new"))).toBe(false);
    expect(fs.existsSync(cookiePath(phantom))).toBe(false);
  });
});
