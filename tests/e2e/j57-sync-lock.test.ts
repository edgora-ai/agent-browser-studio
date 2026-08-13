// J57: Team profile checkout locks (Slice 21). A device can lock a profile so
// another device's push refuses to overwrite it; diff preview surfaces remote
// locks; force push bypasses. Verifies the whole flow against a mock S3.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j57");
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

function decodeRemoteConfig(raw: Buffer): { payload: any; data: any } {
  const payload = JSON.parse(raw.toString("utf8"));
  const data = JSON.parse(zlib.gunzipSync(Buffer.from(payload.data, "base64")).toString("utf8"));
  return { payload, data };
}

describe("J57 — team profile checkout locks", () => {
  let h: TestAppHandle;
  let s3: Awaited<ReturnType<typeof startMockS3>>;
  let p1 = "";
  let p2 = "";
  let myLockOwner = "";

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
    const r1 = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J57-A", platform: "windows", fingerprintSeed: 71717 }));
    const r2 = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J57-B", platform: "windows", fingerprintSeed: 81818 }));
    p1 = r1.dirId;
    p2 = r2.dirId;
  }, 60000);
  afterAll(async () => {
    if (h) await closeApp(h);
    if (s3) await s3.close();
  }, 90000);

  it("locks a profile to the current device", async () => {
    const r = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.setLock(id, true), p1);
    expect(r.success).toBe(true);
    expect(r.lock).toBeTruthy();
    expect(r.lock.owner).toBeTruthy();
    myLockOwner = r.lock.owner;
  }, 20000);

  it("push carries the lock to the remote", async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(r.success).toBe(true);
    const { data } = decodeRemoteConfig(s3.get(CONFIG_KEY)!);
    expect(data.browserProfiles[p1].lock.owner).toBe(myLockOwner);
  }, 60000);

  it("diff preview flags a profile locked by another device", async () => {
    // Simulate a colleague checking out p2 on their machine.
    const { payload, data } = decodeRemoteConfig(s3.get(CONFIG_KEY)!);
    data.browserProfiles[p2].lock = { owner: "colleague-device", ownerName: "Colleague Mac", at: Date.now() };
    payload.data = zlib.gzipSync(JSON.stringify(data, null, 2)).toString("base64");
    s3.put(CONFIG_KEY, Buffer.from(JSON.stringify(payload)));

    const diff: any = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.previewDiff());
    expect(diff.ok).toBe(true);
    const lock = (diff.remoteLocks || []).find((l: any) => l.id === p2);
    expect(lock).toBeTruthy();
    expect(lock.ownerName).toBe("Colleague Mac");
    expect(diff.pushWarnings.some((w: string) => w.includes("锁定"))).toBe(true);
  }, 30000);

  it("push refuses to overwrite a profile locked by another device", async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/locked by another device/i);
    expect(r.message).toContain(p2);
  }, 30000);

  it("force push bypasses the lock", async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push({ force: true }));
    expect(r.success).toBe(true);
    // After force push, the remote reflects our local state (p2 unlocked).
    const { data } = decodeRemoteConfig(s3.get(CONFIG_KEY)!);
    expect(data.browserProfiles[p2].lock).toBeUndefined();
    expect(data.browserProfiles[p1].lock.owner).toBe(myLockOwner);
  }, 60000);

  it("unlocks the profile locally", async () => {
    const r = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.setLock(id, false), p1);
    expect(r.success).toBe(true);
    expect(r.lock).toBeNull();
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
