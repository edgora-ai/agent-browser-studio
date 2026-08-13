// J62: Sync pull merge strategy (Slice 27). Pull supports local/remote/newest
// conflict resolution for id-keyed sections. This exercises the whole path
// against a loopback mock S3: local-wins is the default, remote-wins adopts
// the remote entry on conflict, newest compares timestamps, and the pull
// message reports how many entries were adopted from remote.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j62");
const CONFIG_KEY = "agent-browser-studio-config.json";

function startMockS3(): Promise<{ port: number; get: (key: string) => Buffer | undefined; put: (key: string, body: Buffer) => void; close: () => Promise<void> }> {
  const store = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        store.set(url, Buffer.concat(chunks));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      return;
    }
    if (req.method === "GET") {
      const body = store.get(url);
      if (!body) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(405); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as any;
      resolve({
        port: address.port,
        get: (key) => store.get("/bucket/" + key),
        put: (key, body) => { store.set("/bucket/" + key, body); },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function readRemoteData(s3: any): { payload: any; data: any } {
  const raw = s3.get(CONFIG_KEY)!.toString("utf8");
  const payload = JSON.parse(raw);
  return {
    payload,
    data: JSON.parse(zlib.gunzipSync(Buffer.from(payload.data, "base64")).toString("utf8")),
  };
}

function writeRemoteData(s3: any, payload: any, data: any): void {
  payload.data = zlib.gzipSync(JSON.stringify(data, null, 2)).toString("base64");
  payload.timestamp = Date.now() + 1000;
  s3.put(CONFIG_KEY, Buffer.from(JSON.stringify(payload)));
}

describe("J62 — sync pull merge strategy", () => {
  let h: TestAppHandle;
  let s3: Awaited<ReturnType<typeof startMockS3>>;
  let dirId = "";

  beforeAll(async () => {
    s3 = await startMockS3();
    h = await setupTestApp({ userDataDir: USERDATA });
    await h.page.evaluate((cfg) => (window as any).agentBrowser.api.sync.configure(cfg), {
      enabled: true,
      endpoint: "http://127.0.0.1:" + s3.port,
      bucket: "bucket",
      accessKey: "testak",
      secretKey: "testsk",
    });
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J62", platform: "windows", fingerprintSeed: 62626 }));
    dirId = r.dirId;
    const push = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(push.success).toBe(true);
    expect(s3.get(CONFIG_KEY)).toBeTruthy();
  }, 90000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (s3) await s3.close();
  }, 90000);

  it("default pull is local-wins: conflict keeps local, remote-only data imported", async () => {
    // Simulate another machine editing the remote store: rename our profile,
    // add a remote-only profile + proxy.
    const { payload, data } = readRemoteData(s3);
    data.browserProfiles[dirId].name = "J62-Remote";
    data.browserProfiles[dirId].updatedAt = 9999999999999;
    data.browserProfiles[dirId].syncedAt = 9999999999999;
    data.browserProfiles["cb_remote_only"] = { name: "RemoteOnly", fingerprintMode: "managed", fingerprintSeed: 7, platform: "windows", syncedAt: 9999999999998 };
    data.proxies["remote_proxy"] = { type: "http", host: "10.0.0.9", port: 3128 };
    writeRemoteData(s3, payload, data);

    // Local conflict: rename our profile locally.
    const ren = await h.page.evaluate((id) => (window as any).agentBrowser.api.profile.rename(id, "J62-Local"), dirId);
    expect(ren.success).toBe(true);

    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull());
    expect(r.success).toBe(true);
    expect(r.message).not.toContain("merged (remote adopted)");

    const profiles: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list());
    expect(profiles.find((p) => p.dirId === dirId).name).toBe("J62-Local");
    expect(profiles.some((p) => p.dirId === "cb_remote_only")).toBe(true);

    const proxies: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.proxy.list());
    expect(proxies.some((p) => p.name === "remote_proxy")).toBe(true);
  }, 60000);

  it("remote strategy adopts the remote entry on conflict and reports it", async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "remote" }));
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/profiles merged \(remote adopted\)/);
    const profiles: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list());
    expect(profiles.find((p) => p.dirId === dirId).name).toBe("J62-Remote");
  }, 60000);

  it("newest strategy adopts the newer side by timestamp", async () => {
    // Local rename (syncedAt stays at the huge value adopted previously).
    await h.page.evaluate((id) => (window as any).agentBrowser.api.profile.rename(id, "J62-Newest-Local"), dirId);
    // Remote side: newer syncedAt + different name → newest adopts remote.
    const { payload, data } = readRemoteData(s3);
    data.browserProfiles[dirId].name = "J62-Newest-Remote";
    data.browserProfiles[dirId].updatedAt = 9999999999999 + 1000;
    data.browserProfiles[dirId].syncedAt = 9999999999999 + 1000;
    writeRemoteData(s3, payload, data);

    let r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "newest" }));
    expect(r.success).toBe(true);
    expect(r.message).toContain("1 profiles merged (remote adopted)");
    let profiles: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list());
    expect(profiles.find((p) => p.dirId === dirId).name).toBe("J62-Newest-Remote");

    // Reverse: remote is older → newest keeps local.
    const { payload: p2, data: d2 } = readRemoteData(s3);
    d2.browserProfiles[dirId].name = "J62-Past-Remote";
    d2.browserProfiles[dirId].updatedAt = 1;
    d2.browserProfiles[dirId].syncedAt = 1;
    writeRemoteData(s3, p2, d2);
    r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "newest" }));
    expect(r.success).toBe(true);
    expect(r.message).not.toContain("merged (remote adopted)");
    profiles = await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list());
    expect(profiles.find((p) => p.dirId === dirId).name).toBe("J62-Newest-Remote");
  }, 60000);

  it("invalid strategy falls back to local-wins", async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "bogus" }));
    expect(r.success).toBe(true);
    expect(r.message).not.toContain("merged (remote adopted)");
  }, 60000);

  it("per-entry resolutions override the global strategy", async () => {
    // Remote side: rename the profile (conflict) and add a remote-only proxy.
    const { payload, data } = readRemoteData(s3);
    data.browserProfiles[dirId].name = "J62-PerEntry-Remote";
    data.browserProfiles[dirId].updatedAt = 9999999999999 + 2000;
    data.browserProfiles[dirId].syncedAt = 9999999999999 + 2000;
    data.proxies["entry_proxy"] = { type: "http", host: "10.1.1.1", port: 8080, updatedAt: 9999999999999 + 2000 };
    writeRemoteData(s3, payload, data);

    // Local conflict: rename the profile locally.
    await h.page.evaluate((id) => (window as any).agentBrowser.api.profile.rename(id, "J62-PerEntry-Local"), dirId);

    // Global strategy is remote, but this profile entry explicitly resolves local.
    const r = await h.page.evaluate((id) => (window as any).agentBrowser.api.sync.pull({
      strategy: "remote",
      resolutions: { ["profiles:" + id]: "local" },
   }), dirId);

    expect(r.success).toBe(true);

    // The per-entry local override must keep THIS profile's local name even
    // though the global strategy is remote. (Other profiles without an
    // override may still legitimately adopt the remote side.)
    const profiles: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list());
    expect(profiles.find((p) => p.dirId === dirId).name).toBe("J62-PerEntry-Local");
    // Remote-only proxy is still adopted (no conflict, no override).
    const proxies: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.proxy.list());
    expect(proxies.some((p) => p.name === "entry_proxy")).toBe(true);
  }, 60000);

  it("diff view exposes a per-entry conflict strategy select", async () => {
    // A conflict still exists (local name vs remote name), so the diff must
    // render per-entry strategy selects for the profiles section.
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("sync"));
    await h.page.evaluate(() => (window as any).agentBrowser.loadSyncDiff());
    await h.page.waitForSelector("#sync-diff .sync-entry-strategy", { timeout: 8000 });
    const count = await h.page.locator('#sync-diff .sync-entry-strategy[data-section="profiles"]').count();
    expect(count).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
