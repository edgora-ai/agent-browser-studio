// J54: Local REST API + OpenAPI (Slice 18). Starts the app with an ephemeral
// loopback API port, then exercises the full surface: open /health +
// /openapi.json, token auth, version, profile CRUD + launch/stop, proxy CRUD
// + health, and the read-only accounts/automation/runs/jobs/audit endpoints.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j54");

function apiRequest(
  port: number, token: string, method: string, p: string, body?: any, auth = true,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = `Bearer ${token}`;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: p, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("J54 — local REST API + OpenAPI", () => {
  let h: TestAppHandle;
  let port = 0;
  let token = "";

  beforeAll(async () => {
    h = await setupTestApp({
      userDataDir: USERDATA,
      env: { AGENT_BROWSER_API_PORT: "0" }, // ephemeral loopback port
    });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      if (st && st.running && st.port > 0) { port = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(port, "REST API server must be running").toBeGreaterThan(0);
    const tok = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken());
    token = tok.token;
    expect(token, "REST API token must be available").toBeTruthy();
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("serves /health and /openapi.json without auth", async () => {
    const health = await apiRequest(port, token, "GET", "/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");

    const spec = await apiRequest(port, token, "GET", "/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toMatch(/^3\.0/);
    expect(spec.body.paths["/api/profiles"]).toBeTruthy();
    expect(spec.body.paths["/api/profiles/{dirId}/launch"]).toBeTruthy();
    expect(spec.body.paths["/api/proxies/{name}/rotate"]).toBeTruthy();
    expect(spec.body.paths["/api/audit"]).toBeTruthy();
    expect(Array.isArray(spec.body.security)).toBe(true);
  }, 20000);

  it("rejects data endpoints without a token", async () => {
    const r = await apiRequest(port, token, "GET", "/api/profiles", undefined, false);
    expect(r.status).toBe(401);
  }, 20000);

  it("reports product + runtime chromium versions", async () => {
    const r = await apiRequest(port, token, "GET", "/version");
    expect(r.status).toBe(200);
    expect(r.body.name).toContain("Agent Browser");
    expect(r.body.chromium).toBeTruthy();
  }, 20000);

  it("creates, reads, lists, and deletes a profile", async () => {
    const created = await apiRequest(port, token, "POST", "/api/profiles", {
      name: "j54-api-profile", platform: "windows", locale: "en-US",
      timezone: "America/New_York", tags: ["api", "e2e"],
    });
    expect(created.status).toBe(201);
    const dirId = created.body.dirId;
    expect(dirId).toMatch(/^ab_/);

    const detail = await apiRequest(port, token, "GET", "/api/profiles/" + dirId);
    expect(detail.status).toBe(200);
    expect(detail.body.name).toBe("j54-api-profile");
    expect(detail.body.tags).toContain("api");
    expect(detail.body.running).toBe(false);

    const list = await apiRequest(port, token, "GET", "/api/profiles");
    expect(list.body.profiles.some((p: any) => p.dirId === dirId)).toBe(true);

    const del = await apiRequest(port, token, "DELETE", "/api/profiles/" + dirId);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
  }, 30000);

  it("launches and stops a profile via the API", async () => {
    const created = await apiRequest(port, token, "POST", "/api/profiles", { name: "j54-api-launch" });
    const dirId = created.body.dirId;

    const launch = await apiRequest(port, token, "POST", "/api/profiles/" + dirId + "/launch");
    expect(launch.status).toBe(200);
    expect(launch.body.success).toBe(true);

    let running = false;
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const st = await apiRequest(port, token, "GET", "/api/profiles/" + dirId + "/status");
      if (st.body && st.body.running) { running = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(running, "profile should report running").toBe(true);

    const stop = await apiRequest(port, token, "POST", "/api/profiles/" + dirId + "/stop");
    expect(stop.status).toBe(200);
    expect(stop.body.success).toBe(true);

    await apiRequest(port, token, "DELETE", "/api/profiles/" + dirId);
  }, 60000);

  it("adds, lists, updates, and deletes a proxy", async () => {
    const add = await apiRequest(port, token, "POST", "/api/proxies", {
      name: "j54-proxy", config: { type: "http", host: "127.0.0.1", port: 7802, fallbacks: [] },
    });
    expect(add.status).toBe(201);

    const list = await apiRequest(port, token, "GET", "/api/proxies");
    expect(list.body.proxies.some((p: any) => p.name === "j54-proxy")).toBe(true);

    const health = await apiRequest(port, token, "GET", "/api/proxies/health");
    expect(health.status).toBe(200);
    expect(Array.isArray(health.body.entries)).toBe(true);

    const detail = await apiRequest(port, token, "GET", "/api/proxies/j54-proxy");
    expect(detail.body.port).toBe(7802);

    const upd = await apiRequest(port, token, "PATCH", "/api/proxies/j54-proxy", {
      config: { type: "http", host: "127.0.0.1", port: 7803 },
    });
    expect(upd.body.success).toBe(true);

    const del = await apiRequest(port, token, "DELETE", "/api/proxies/j54-proxy");
    expect(del.body.success).toBe(true);
  }, 30000);

  it("exposes accounts, automation, runs, jobs, and audit", async () => {
    const accounts = await apiRequest(port, token, "GET", "/api/accounts");
    expect(accounts.status).toBe(200);
    expect(Array.isArray(accounts.body.accounts)).toBe(true);

    const rules = await apiRequest(port, token, "GET", "/api/automation/rules");
    expect(rules.status).toBe(200);
    expect(Array.isArray(rules.body.rules)).toBe(true);

    const runs = await apiRequest(port, token, "GET", "/api/runs");
    expect(runs.status).toBe(200);
    expect(Array.isArray(runs.body.runs)).toBe(true);

    const jobs = await apiRequest(port, token, "GET", "/api/jobs");
    expect(jobs.status).toBe(200);
    expect(Array.isArray(jobs.body.jobs)).toBe(true);

    const audit = await apiRequest(port, token, "GET", "/api/audit");
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.body.audit)).toBe(true);
    // REST mutations above were audited with actor=api.
    expect(audit.body.audit.some((e: any) => e.actor === "api")).toBe(true);
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
