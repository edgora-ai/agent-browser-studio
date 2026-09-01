// J65: Profile backup / transfer (Slice 35). Export a managed profile (browser
// data + fingerprint meta) to a portable ZIP archive via the renderer API,
// delete the source, re-import it under a fresh dirId, and verify name, meta
// and data all survive. The Profiles tab also exposes an export button.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";
import { openCardMenu } from "./helpers/find.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j65");

function apiRequest(
  port: number, token: string, method: string, p: string, body?: any, auth = true,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = "Bearer " + token;
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

describe("J65 — profile backup export/import", () => {
  let h: TestAppHandle;
  let zipPath = path.join(USERDATA, "profile-backup.zip");
  let restZipPath = path.join(USERDATA, "rest-backup.zip");
  let port = 0;
  let token = "";

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
    expect(token, "REST API token must be available").toBeTruthy();
  }, 60000);
  afterAll(async () => {
    if (h) await closeApp(h);
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(restZipPath, { force: true }); } catch { /* ignore */ }
  }, 90000);

  it("exports a profile to a zip and re-imports it with meta + data intact", async () => {
    const created = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "Backup Me",
      platform: "windows",
      fingerprintSeed: 77123,
      timezone: "America/New_York",
      tags: ["shop", "us"],
    }));
    const dirId = created.dirId;
    expect(dirId).toBeTruthy();

    const info = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.profile.get(id), dirId);
    expect(info.path).toBeTruthy();
    fs.mkdirSync(path.join(info.path, "Default"), { recursive: true });
    fs.writeFileSync(path.join(info.path, "Default", "Preferences"), JSON.stringify({ profile: { name: "backup-data" } }));
    fs.writeFileSync(path.join(info.path, "bookmarks.html"), "bookmarks-html");

    const exp = await h.page.evaluate(async ({ id, p }: { id: string; p: string }) =>
      (window as any).agentBrowser.api.profile.exportArchive(id, p), { id: dirId, p: zipPath });
    expect(exp.success, JSON.stringify(exp)).toBe(true);
    expect(exp.entries).toBeGreaterThan(0);
    expect(fs.existsSync(zipPath)).toBe(true);

    // Remove the source profile, then import the backup.
    const del = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.profile.delete(id), dirId);
    expect(del.success).toBe(true);

    const imp = await h.page.evaluate(async (p: string) => (window as any).agentBrowser.api.profile.importArchive(p), zipPath);
    expect(imp.success, JSON.stringify(imp)).toBe(true);
    expect(imp.dirId).toBeTruthy();
    expect(imp.dirId).not.toBe(dirId);
    expect(imp.name).toBe("Backup Me");
    expect(imp.files).toBeGreaterThan(0);

    const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const imported = list.find((p) => p.dirId === imp.dirId);
    expect(imported).toBeTruthy();
    expect(imported.name).toBe("Backup Me");
    expect(imported.fingerprintSeed).toBe(77123);
    expect(imported.platform).toBe("windows");
    expect(imported.timezone).toBe("America/New_York");

    const iinfo = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.profile.get(id), imp.dirId);
    const prefs = JSON.parse(fs.readFileSync(path.join(iinfo.path, "Default", "Preferences"), "utf8"));
    expect(prefs.profile.name).toBe("backup-data");
    expect(fs.readFileSync(path.join(iinfo.path, "bookmarks.html"), "utf8")).toBe("bookmarks-html");
  }, 60000);

  it("profiles tab shows the export-backup button", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    await h.page.evaluate(() => (window as any).agentBrowser.loadProfiles());
    const card = h.page.locator("#profile-list .profile-card").first();
    await card.waitFor({ state: "visible", timeout: 5000 });
    await openCardMenu(card);
    await h.page.waitForSelector("#profile-list .profile-card [data-action='export-archive']", { timeout: 5000 });
    expect(await h.page.locator("#profile-list .profile-card [data-action='export-archive']").count()).toBeGreaterThanOrEqual(1);
    // Toolbar import-backup button exists.
    expect(await h.page.locator('[data-cmd="importProfileArchive"]').count()).toBe(1);
    // Batch bar exposes the export-selected action.
    expect(await h.page.locator('[data-cmd="batchExportSelected"]').count()).toBe(1);
  }, 30000);

  it("exposes profile backup export/import over the REST API", async () => {
    // Create a profile through the REST API so the round-trip is fully API-driven.
    const created = await apiRequest(port, token, "POST", "/api/profiles", {
      name: "REST Backup",
      platform: "windows",
      fingerprintSeed: 4242,
      timezone: "Europe/Paris",
      tags: ["rest"],
    });
    expect(created.status).toBe(201);
    const dirId = created.body.dirId;
    expect(dirId).toBeTruthy();

    // Drop a data file into the profile so we can verify it survives the round trip.
    const info = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.profile.get(id), dirId);
    fs.mkdirSync(path.join(info.path, "Default"), { recursive: true });
    fs.writeFileSync(path.join(info.path, "Default", "Preferences"), JSON.stringify({ profile: { name: "rest-data" } }));
    fs.writeFileSync(path.join(info.path, "cookies.sqlite"), "cookie-db");

    const exp = await apiRequest(port, token, "POST", "/api/profiles/" + dirId + "/export", { destPath: restZipPath });
    expect(exp.status, JSON.stringify(exp)).toBe(200);
    expect(exp.body.success).toBe(true);
    expect(exp.body.filePath).toBe(restZipPath);
    expect(exp.body.entries).toBeGreaterThan(0);
    expect(exp.body.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(restZipPath)).toBe(true);

    // Delete the source, then import the archive back under a fresh dirId.
    const del = await apiRequest(port, token, "DELETE", "/api/profiles/" + dirId);
    expect(del.status).toBe(200);
    const imp = await apiRequest(port, token, "POST", "/api/profiles/import", { zipPath: restZipPath });
    expect(imp.status, JSON.stringify(imp)).toBe(200);
    expect(imp.body.success).toBe(true);
    expect(imp.body.dirId).toBeTruthy();
    expect(imp.body.dirId).not.toBe(dirId);
    expect(imp.body.name).toBe("REST Backup");

    const iinfo = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.profile.get(id), imp.body.dirId);
    const prefs = JSON.parse(fs.readFileSync(path.join(iinfo.path, "Default", "Preferences"), "utf8"));
    expect(prefs.profile.name).toBe("rest-data");
    expect(fs.readFileSync(path.join(iinfo.path, "cookies.sqlite"), "utf8")).toBe("cookie-db");

    // Import without a zipPath must be a client error.
    const missing = await apiRequest(port, token, "POST", "/api/profiles/import", {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/zipPath/i);

    // OpenAPI document advertises both endpoints.
    const spec = await apiRequest(port, token, "GET", "/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.paths["/api/profiles/import"]).toBeTruthy();
    expect(spec.body.paths["/api/profiles/{dirId}/export"]).toBeTruthy();

    // Cleanup: remove the imported profile so later tests stay deterministic.
    const clean = await apiRequest(port, token, "DELETE", "/api/profiles/" + imp.body.dirId);
    expect(clean.status).toBe(200);
  }, 60000);

  it("batch exports/imports several profiles over the REST API", async () => {
    const destDir = path.join(USERDATA, "rest-batch");
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    const mk = async (name: string): Promise<string> => {
      const r = await apiRequest(port, token, "POST", "/api/profiles", { name, platform: "windows" });
      expect(r.status).toBe(201);
      return r.body.dirId;
    };
    const a = await mk("Batch REST A");
    const b = await mk("Batch REST B");
    const info = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.profile.get(id), a);
    fs.writeFileSync(path.join(info.path, "batch-a.txt"), "A-data");

    const exp = await apiRequest(port, token, "POST", "/api/profiles/export", { dirIds: [a, b], destDir });
    expect(exp.status, JSON.stringify(exp)).toBe(200);
    expect(exp.body.success).toBe(true);
    expect(exp.body.report.exported.length).toBe(2);
    expect(exp.body.report.failed.length).toBe(0);
    const files = fs.readdirSync(destDir).filter((f) => f.endsWith(".zip"));
    expect(files.length).toBe(2);

    // Delete both sources, then import the whole batch back.
    expect((await apiRequest(port, token, "DELETE", "/api/profiles/" + a)).status).toBe(200);
    expect((await apiRequest(port, token, "DELETE", "/api/profiles/" + b)).status).toBe(200);
    const imp = await apiRequest(port, token, "POST", "/api/profiles/import-batch", {
      zipPaths: files.map((f) => path.join(destDir, f)),
    });
    expect(imp.status, JSON.stringify(imp)).toBe(200);
    expect(imp.body.report.imported.length).toBe(2);
    expect(imp.body.report.failed.length).toBe(0);

    // At least one of the imported profiles must carry the data file.
    const dirIds = imp.body.report.imported.map((i: any) => i.dirId);
    let found = false;
    for (const d of dirIds) {
      const ii = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.profile.get(id), d);
      if (fs.existsSync(path.join(ii.path, "batch-a.txt"))) { found = true; break; }
    }
    expect(found).toBe(true);

    // Batch import without zipPaths is a client error.
    const missing = await apiRequest(port, token, "POST", "/api/profiles/import-batch", {});
    expect(missing.status).toBe(400);

    // Cleanup imported profiles + temp dir.
    for (const d of dirIds) {
      expect((await apiRequest(port, token, "DELETE", "/api/profiles/" + d)).status).toBe(200);
    }
    fs.rmSync(destDir, { recursive: true, force: true });
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
