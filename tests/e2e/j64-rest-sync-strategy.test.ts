// J64: REST sync pull strategy (Slice 30). POST /api/sync/pull accepts a
// conflict merge strategy (local/remote/newest) and merges the team-workspace
// config accordingly, round-tripped over the loopback REST API with a mock S3.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j64");
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
  const payload = JSON.parse(s3.get(CONFIG_KEY)!.toString("utf8"));
  return { payload, data: JSON.parse(zlib.gunzipSync(Buffer.from(payload.data, "base64")).toString("utf8")) };
}
function writeRemoteData(s3: any, payload: any, data: any): void {
  payload.data = zlib.gzipSync(JSON.stringify(data, null, 2)).toString("base64");
  payload.timestamp = Date.now() + 1000;
  s3.put(CONFIG_KEY, Buffer.from(JSON.stringify(payload)));
}

function apiRequest(port: number, token: string, method: string, p: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json", authorization: "Bearer " + token };
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("J64 — REST sync pull merge strategy", () => {
  let h: TestAppHandle;
  let s3: Awaited<ReturnType<typeof startMockS3>>;
  let port = 0;
  let token = "";
  let dirId = "";

  beforeAll(async () => {
    s3 = await startMockS3();
    h = await setupTestApp({ userDataDir: USERDATA, env: { AGENT_BROWSER_API_PORT: "0" } });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      if (st && st.running && st.port > 0) { port = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(port).toBeGreaterThan(0);
    const tok = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken());
    token = tok.token;
    expect(token).toBeTruthy();

    await h.page.evaluate((cfg) => (window as any).agentBrowser.api.sync.configure(cfg), {
      enabled: true,
      endpoint: "http://127.0.0.1:" + s3.port,
      bucket: "bucket",
      accessKey: "testak",
      secretKey: "testsk",
    });
    const created = await apiRequest(port, token, "POST", "/api/profiles", { name: "J64", platform: "windows", fingerprintSeed: 64646 });
    expect(created.status).toBe(201);
    dirId = created.body.dirId;
    const push = await apiRequest(port, token, "POST", "/api/sync/push", {});
    expect(push.status).toBe(200);
    expect(s3.get(CONFIG_KEY)).toBeTruthy();
  }, 90000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (s3) await s3.close();
  }, 90000);

  it("REST pull with remote strategy adopts the remote entry and reports the merge", async () => {
    const { payload, data } = readRemoteData(s3);
    data.browserProfiles[dirId].name = "J64-Remote";
    data.browserProfiles[dirId].updatedAt = 9999999999999;
    data.browserProfiles["cb_remote_only"] = { name: "RemoteOnly", fingerprintMode: "managed", fingerprintSeed: 7, platform: "windows" };
    writeRemoteData(s3, payload, data);

    const ren = await h.page.evaluate((id) => (window as any).agentBrowser.api.profile.rename(id, "J64-Local"), dirId);
    expect(ren.success).toBe(true);

    const r = await apiRequest(port, token, "POST", "/api/sync/pull", { strategy: "remote" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.strategy).toBe("remote");
    expect(r.body.message).toMatch(/profiles merged \(remote adopted\)/);

    const list = await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list());
    expect(list.find((p: any) => p.dirId === dirId).name).toBe("J64-Remote");
    expect(list.some((p: any) => p.dirId === "cb_remote_only")).toBe(true);
  }, 60000);

  it("REST pull with newest strategy adopts the newer side by updatedAt", async () => {
    await h.page.evaluate((id) => (window as any).agentBrowser.api.profile.rename(id, "J64-Newest-Local"), dirId);
    const { payload, data } = readRemoteData(s3);
    data.browserProfiles[dirId].name = "J64-Newest-Remote";
    data.browserProfiles[dirId].updatedAt = 9999999999999 + 1000;
    writeRemoteData(s3, payload, data);

    const r = await apiRequest(port, token, "POST", "/api/sync/pull", { strategy: "newest" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.strategy).toBe("newest");
    const list = await h.page.evaluate(() => (window as any).agentBrowser.api.profile.list());
    expect(list.find((p: any) => p.dirId === dirId).name).toBe("J64-Newest-Remote");
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});

