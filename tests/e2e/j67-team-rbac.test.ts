// J67: Team workspace RBAC — init workspace, member management over IPC and
// REST, and the Sync-tab team panel rendering.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j67");

function apiRequest(port: number, token: string, method: string, p: string, body?: any, auth = true): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = `Bearer ${token}`;
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
  return { payload, data: JSON.parse(zlib.gunzipSync(Buffer.from(payload.data, "base64")).toString("utf8")) };
}

function writeRemoteData(s3: any, payload: any, data: any): void {
  payload.data = zlib.gzipSync(JSON.stringify(data, null, 2)).toString("base64");
  payload.timestamp = Date.now() + 1000;
  s3.put(CONFIG_KEY, Buffer.from(JSON.stringify(payload)));
}

describe("J67 — Team workspace RBAC", () => {
  let h: TestAppHandle;
  let port = 0;
  let token = "";
  let s3: Awaited<ReturnType<typeof startMockS3>> | null = null;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, env: { AGENT_BROWSER_API_PORT: "0" } });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      if (st && st.running && st.port > 0) { port = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(port, "REST API server must be running").toBeGreaterThan(0);
    const tok = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken());
    token = tok.token;
    expect(token).toBeTruthy();
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); if (s3) await s3.close(); }, 90000);

  it("team status is empty before initialization", async () => {
    const st = (await h.page.evaluate(async () => (window as any).agentBrowser.api.team.status())) as any;
    expect(st.success).toBe(true);
    expect(st.team).toBeNull();
    expect(st.local.deviceId).toBeTruthy();
    expect(st.local.role).toBe("owner");
  }, 20000);

  it("initializes the workspace with the local device as owner", async () => {
    const r = (await h.page.evaluate(async () => (window as any).agentBrowser.api.team.init("J67 Ops"))) as any;
    expect(r.success).toBe(true);
    expect(r.team.name).toBe("J67 Ops");
    expect(r.team.members).toHaveLength(1);
    expect(r.team.members[0].role).toBe("owner");
    expect(r.team.enabled).toBe(true);

    const st = (await h.page.evaluate(async () => (window as any).agentBrowser.api.team.status())) as any;
    expect(st.team!.ownerDeviceId).toBe(st.local.deviceId);
  }, 20000);

  it("adds members over IPC with role validation", async () => {
    const r1 = (await h.page.evaluate(async () => (window as any).agentBrowser.api.team.addMember("device-member-101", "Member One", "member"))) as any;
    expect(r1.success).toBe(true);
    const r2 = (await h.page.evaluate(async () => (window as any).agentBrowser.api.team.addMember("device-viewer-102", "Viewer Two", "viewer"))) as any;
    expect(r2.success).toBe(true);
    const r3 = (await h.page.evaluate(async () => (window as any).agentBrowser.api.team.addMember("device-member-101", "Dup", "viewer"))) as any;
    expect(r3.success).toBe(false);

    const st = (await h.page.evaluate(async () => (window as any).agentBrowser.api.team.status())) as any;
    expect(st.team!.members.map((m: any) => m.deviceId).sort()).toEqual(["device-member-101", "device-viewer-102", st.local.deviceId].sort());
  }, 20000);

  it("REST exposes team status, member add/remove and OpenAPI paths", async () => {
    const spec = await apiRequest(port, token, "GET", "/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.paths["/api/team"]).toBeDefined();
    expect(spec.body.paths["/api/team/members"]).toBeDefined();

    const st = await apiRequest(port, token, "GET", "/api/team");
    expect(st.status).toBe(200);
    expect(st.body.team!.name).toBe("J67 Ops");

    const add = await apiRequest(port, token, "POST", "/api/team/members", { deviceId: "device-rest-103", name: "Rest Member", role: "member" });
    expect(add.status).toBe(200);
    expect(add.body.team!.members.some((m: any) => m.deviceId === "device-rest-103")).toBe(true);

    const del = await apiRequest(port, token, "DELETE", "/api/team/members/device-rest-103");
    expect(del.status).toBe(200);
    expect(del.body.team!.members.some((m: any) => m.deviceId === "device-rest-103")).toBe(false);
  }, 20000);

  it("Sync tab team panel renders the workspace and member roster", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("sync"));
    await h.page.waitForSelector("#team-panel", { timeout: 5000 });
    await h.page.waitForFunction(() => {
      const panel = document.getElementById("team-panel");
      return !!panel && panel.textContent!.includes("J67 Ops") && panel.textContent!.includes("Member One");
    }, undefined, { timeout: 8000 });
    const text = await h.page.evaluate(() => (document.getElementById("team-panel") as HTMLElement).textContent || "");
    expect(text).toContain("Viewer Two");
    expect(text).toContain("enforcement on");
    const badge = await h.page.evaluate(() => (document.getElementById("team-local-badge") as HTMLElement).textContent || "");
    expect(badge).toContain("Owner");
  }, 25000);

  it("team manifest travels with the sync snapshot and pull adopts the roster", async () => {
    s3 = await startMockS3();
    await h.page.evaluate((cfg) => (window as any).agentBrowser.api.sync.configure(cfg), {
      enabled: true,
      endpoint: "http://127.0.0.1:" + s3.port,
      bucket: "bucket",
      accessKey: "testak",
      secretKey: "testsk",
    });
    const push = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(push.success, "owner push should succeed").toBe(true);
    expect(s3!.get(CONFIG_KEY)).toBeTruthy();

    // The pushed snapshot must carry the workspace manifest (members + roles).
    const remote = readRemoteData(s3!);
    expect(remote.data.team).toBeDefined();
    expect(remote.data.team.name).toBe("J67 Ops");
    expect(remote.data.team.members.map((m: any) => m.deviceId)).toContain("device-member-101");
    expect(remote.data.team.members.find((m: any) => m.deviceId === "device-member-101").role).toBe("member");
  }, 45000);

  it("a viewer-role device is blocked from pushing after pulling the roster", async () => {
    // Simulate the owner demoting this device to viewer on the remote side.
    const { payload, data } = readRemoteData(s3!);
    const localDeviceId = await h.page.evaluate(() => (window as any).agentBrowser.api.team.status().then((st: any) => st.local.deviceId));
    const me = data.team.members.find((m: any) => m.deviceId === localDeviceId);
    expect(me).toBeTruthy();
    me.role = "viewer";
    data.team.updatedAt = Date.now();
    writeRemoteData(s3!, payload, data);

    const pull = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "remote" }));
    expect(pull.success, "pull should succeed").toBe(true);

    const st = await h.page.evaluate(() => (window as any).agentBrowser.api.team.status());
    expect(st.local.role).toBe("viewer");

    const blocked = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(blocked.success).toBe(false);
    expect(String(blocked.message || "")).toContain("team policy");

    // Restore owner role remotely, pull again, push succeeds.
    const r2 = readRemoteData(s3!);
    const me2 = r2.data.team.members.find((m: any) => m.deviceId === localDeviceId);
    me2.role = "owner";
    r2.data.team.updatedAt = Date.now();
    writeRemoteData(s3!, r2.payload, r2.data);
    const pull2 = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.pull({ strategy: "remote" }));
    expect(pull2.success).toBe(true);
    const push2 = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(push2.success, "owner push after restore should succeed").toBe(true);
  }, 60000);

  it("no unexpected console / page errors during the journey", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors);
    const p = h.pageErrors.filter((e) => !/favicon|punycode/i.test(e));
    if (c.length || p.length) {
      console.log("CONSOLE ERRORS:", c);
      console.log("PAGE ERRORS:", p);
    }
    expect(c, c.join("\n")).toEqual([]);
    expect(p, p.join("\n")).toEqual([]);
  });
});
