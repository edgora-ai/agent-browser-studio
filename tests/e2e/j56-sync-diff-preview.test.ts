// J56: Sync team-workspace diff preview (Slice 20). A loopback mock S3 serves
// the sync object store; we exercise previewDiff end-to-end: first push (no
// remote yet), clean state after push, and a simulated "another machine" that
// leaves remote-only data so push warnings surface before overwrite.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j56");
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

describe("J56 — sync team-workspace diff preview", () => {
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
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J56", platform: "windows", fingerprintSeed: 61616 }));
    dirId = r.dirId;
  }, 60000);
  afterAll(async () => {
    if (h) await closeApp(h);
    if (s3) await s3.close();
  }, 90000);

  it("first previewDiff reports firstPush and local-only profiles", async () => {
    const diff: any = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.previewDiff());
    expect(diff.ok).toBe(true);
    expect(diff.firstPush).toBe(true);
    expect(diff.profiles.localOnly).toContain(dirId);
    expect(diff.pushWarnings).toEqual([]);
  }, 20000);

  it("push succeeds and stores a remote config", async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(r.success).toBe(true);
    expect(s3.get(CONFIG_KEY)).toBeTruthy();
  }, 60000);

  it("previewDiff after push is clean with a remote timestamp", async () => {
    const diff: any = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.previewDiff());
    expect(diff.ok).toBe(true);
    expect(diff.firstPush).toBeFalsy();
    expect(typeof diff.remoteTimestamp).toBe("number");
    expect(diff.profiles.localOnly).toEqual([]);
    expect(diff.profiles.remoteOnly).toEqual([]);
    expect(diff.profiles.changed).toEqual([]);
    expect(diff.pushWarnings).toEqual([]);
    expect(Array.isArray(diff.artifacts.cookies)).toBe(true);
  }, 30000);

  it("flags remote-only data left by another machine as push risk", async () => {
    const raw = s3.get(CONFIG_KEY)!.toString("utf8");
    const payload = JSON.parse(raw);
    const data = JSON.parse(zlib.gunzipSync(Buffer.from(payload.data, "base64")).toString("utf8"));
    data.browserProfiles["cb_remote_other"] = { name: "RemoteOther", fingerprintMode: "managed", fingerprintSeed: 7, platform: "windows" };
    payload.data = zlib.gzipSync(JSON.stringify(data, null, 2)).toString("base64");
    payload.timestamp = Date.now() + 1000;
    s3.put(CONFIG_KEY, Buffer.from(JSON.stringify(payload)));

    const diff: any = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.previewDiff());
    expect(diff.ok).toBe(true);
    expect(diff.profiles.remoteOnly).toContain("cb_remote_other");
    expect(diff.pushWarnings.length).toBeGreaterThan(0);
    expect(diff.pushWarnings[0]).toContain("cb_remote_other");
    expect(diff.pullNotes.some((n: string) => n.includes("cb_remote_other"))).toBe(true);
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
