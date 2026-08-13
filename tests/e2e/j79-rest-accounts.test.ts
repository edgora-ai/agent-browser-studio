// J79: REST account write endpoints (Slice 56).
// Closes the Slice 53 "后续项": POST/PATCH/DELETE /api/accounts, bulk import
// (optionally creating bound profiles), and password reveal — all over the
// loopback API with team RBAC (viewer → 403) and passwords encrypted at rest.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j79");

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

describe("J79 — REST account write endpoints", () => {
  let h: TestAppHandle;
  let port = 0;
  let token = "";

  beforeAll(async () => {
    h = await setupTestApp({
      userDataDir: USERDATA,
      env: { AGENT_BROWSER_API_PORT: "0" },
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

  it("lists accounts with index/url/username/tags/profileIds/hasPassword and no password", async () => {
    const r = await apiRequest(port, token, "GET", "/api/accounts");
    expect(r.status).toBe(200);
    expect(r.body.accounts).toEqual([]);
  }, 20000);

  it("creates an account via POST with an encrypted-at-rest password", async () => {
    const r = await apiRequest(port, token, "POST", "/api/accounts", {
      url: "https://amazon.com",
      username: "j79buyer",
      password: "j79secret",
      tags: ["shop", "us"],
    });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.account.index).toBe(0);
    expect(r.body.account.url).toBe("https://amazon.com");
    expect(r.body.account.username).toBe("j79buyer");
    expect(r.body.account.tags).toEqual(["shop", "us"]);
    expect(r.body.account.hasPassword).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("j79secret");
  }, 20000);

  it("reveals the password only through the dedicated endpoint", async () => {
    const r = await apiRequest(port, token, "GET", "/api/accounts/0/password");
    expect(r.status).toBe(200);
    expect(r.body.password).toBe("j79secret");
  }, 20000);

  it("patches an account (update username/tags/bind, keep stored password when omitted)", async () => {
    const r = await apiRequest(port, token, "PATCH", "/api/accounts/0", {
      username: "j79buyer2",
      tags: ["shop"],
      profileIds: ["prof_abc", "prof_abc", "bad id!"],
    });
    expect(r.status).toBe(200);
    expect(r.body.account.username).toBe("j79buyer2");
    expect(r.body.account.tags).toEqual(["shop"]);
    expect(r.body.account.profileIds).toEqual(["prof_abc"]);
    // Password was omitted → still stored and decryptable.
    const reveal = await apiRequest(port, token, "GET", "/api/accounts/0/password");
    expect(reveal.body.password).toBe("j79secret");
  }, 20000);

  it("rejects invalid create payloads with 400", async () => {
    const r = await apiRequest(port, token, "POST", "/api/accounts", { username: "only-user" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("url and username are required");
  }, 20000);

  it("bulk imports accounts (and can create a bound profile per account)", async () => {
    const bulk = await apiRequest(port, token, "POST", "/api/accounts/bulk", {
      text: "https://twitter.com, alice, twsecret, social\nhttps://ebay.com, bob, ebsecret",
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.report.added).toBe(2);
    expect(bulk.body.report.skipped).toBe(0);
    const list = await apiRequest(port, token, "GET", "/api/accounts");
    expect(list.body.accounts).toHaveLength(3);

    const created = await apiRequest(port, token, "POST", "/api/accounts/bulk", {
      text: "https://etsy.com, carol, etssecret",
      createProfiles: true,
      platform: "windows",
    });
    expect(created.status).toBe(200);
    expect(created.body.report.added).toBe(1);
    expect(created.body.report.created).toBe(1);
    const profiles = await apiRequest(port, token, "GET", "/api/profiles");
    expect(profiles.body.profiles.some((p: any) => p.name === "etsy.com · carol")).toBe(true);
  }, 30000);

  it("deletes an account and returns 404 for a second delete", async () => {
    // Indices shift after a delete; delete the last account so the repeat
    // delete is genuinely out of range.
    const list0 = await apiRequest(port, token, "GET", "/api/accounts");
    const lastIndex = list0.body.accounts.length - 1;
    const lastUsername = list0.body.accounts[lastIndex].username;
    const del = await apiRequest(port, token, "DELETE", `/api/accounts/${lastIndex}`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
    const again = await apiRequest(port, token, "DELETE", `/api/accounts/${lastIndex}`);
    expect(again.status).toBe(404);
    const list = await apiRequest(port, token, "GET", "/api/accounts");
    expect(list.body.accounts.some((a: any) => a.username === lastUsername)).toBe(false);
  }, 20000);

  it("denies a viewer account writes and secret reads over REST with 403", async () => {
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    const deviceId = cfg.deviceId || "local";
    cfg.team = {
      name: "J79 Workspace",
      ownerDeviceId: deviceId,
      members: [{ deviceId, name: "Local", role: "viewer", addedAt: Date.now() }],
      enabled: true,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());

    const add = await apiRequest(port, token, "POST", "/api/accounts", { url: "https://x.com", username: "u", password: "p" });
    expect(add.status).toBe(403);
    const patch = await apiRequest(port, token, "PATCH", "/api/accounts/1", { tags: ["x"] });
    expect(patch.status).toBe(403);
    const del = await apiRequest(port, token, "DELETE", "/api/accounts/1");
    expect(del.status).toBe(403);
    const bulk = await apiRequest(port, token, "POST", "/api/accounts/bulk", { text: "https://x.com, u, p" });
    expect(bulk.status).toBe(403);
    const reveal = await apiRequest(port, token, "GET", "/api/accounts/1/password");
    expect(reveal.status).toBe(403);
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
