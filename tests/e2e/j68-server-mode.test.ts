// J68: Headless server mode (Slice 42). Launches the controller with
// --headless, verifies the REST API comes up without a GUI window, health
// reports mode=headless, and a managed Chromium profile can be created and
// launched purely over REST (profiles run as separate headed processes with
// CDP, even though the controller has no window).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import { launchHeadlessApp, HeadlessAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j68");

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

describe("J68 — headless server mode", () => {
  let h: HeadlessAppHandle;

  beforeAll(async () => {
    h = await launchHeadlessApp({ userDataDir: USERDATA, token: "j68-headless-token" });
  }, 60000);
  afterAll(async () => { if (h) await h.close(); }, 90000);

  it("health reports headless mode and a live API version", async () => {
    const r = await apiRequest(h.port, h.token, "GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.mode).toBe("headless");
    expect(r.body.port).toBe(h.port);
    expect(r.body.version).toBeTruthy();
    expect(r.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  }, 20000);

  it("openapi and version endpoints work without a window", async () => {
    const spec = await apiRequest(h.port, h.token, "GET", "/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.paths["/api/profiles"]).toBeDefined();
    const ver = await apiRequest(h.port, h.token, "GET", "/version");
    expect(ver.status).toBe(200);
    expect(ver.body.version).toBeTruthy();
  }, 20000);

  it("creates a profile over REST in headless mode", async () => {
    const created = await apiRequest(h.port, h.token, "POST", "/api/profiles", {
      name: "J68-server",
      platform: "windows",
      fingerprintSeed: 68686,
    });
    expect(created.status).toBe(201);
    expect(created.body.dirId).toBeTruthy();
    const dirId = created.body.dirId as string;

    const list = await apiRequest(h.port, h.token, "GET", "/api/profiles");
    expect(list.status).toBe(200);
    expect(list.body.profiles.some((p: any) => p.dirId === dirId)).toBe(true);
  }, 20000);

  it("launches and stops the profile headlessly (real Chromium + CDP)", async () => {
    const created = await apiRequest(h.port, h.token, "POST", "/api/profiles", {
      name: "J68-launch",
      platform: "windows",
      fingerprintSeed: 68687,
    });
    const dirId = created.body.dirId as string;

    const launch = await apiRequest(h.port, h.token, "POST", "/api/profiles/" + dirId + "/launch");
    expect(launch.status).toBe(200);
    expect(launch.body.success).toBe(true);
    expect(launch.body.cdpPort).toBeGreaterThan(0);

    // Give the renderer a moment, then verify the profile is listed as running.
    await new Promise((r) => setTimeout(r, 1500));
    const status = await apiRequest(h.port, h.token, "GET", "/api/profiles/" + dirId);
    expect(status.status).toBe(200);
    expect(status.body.running).toBe(true);

    const stop = await apiRequest(h.port, h.token, "POST", "/api/profiles/" + dirId + "/stop");
    expect(stop.status).toBe(200);
  }, 60000);

  it("automation surface is reachable over REST (rules list)", async () => {
    const r = await apiRequest(h.port, h.token, "GET", "/api/automation/rules");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rules)).toBe(true);
  }, 20000);

  it("no GUI window was created in headless mode", async () => {
    // Playwright sees zero BrowserWindows — the controller runs windowless.
    expect(h.app.windows().length).toBe(0);
  });


});

