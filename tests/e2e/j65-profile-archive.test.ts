// J65: Profile backup / transfer (Slice 35). Export a managed profile (browser
// data + fingerprint meta) to a portable ZIP archive via the renderer API,
// delete the source, re-import it under a fresh dirId, and verify name, meta
// and data all survive. The Profiles tab also exposes an export button.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j65");

describe("J65 — profile backup export/import", () => {
  let h: TestAppHandle;
  let zipPath = path.join(USERDATA, "profile-backup.zip");

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => {
    if (h) await closeApp(h);
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
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
    await h.page.waitForSelector(".profile-card [data-action='export-archive']", { timeout: 5000 });
    expect(await h.page.locator(".profile-card [data-action='export-archive']").count()).toBeGreaterThanOrEqual(1);
    // Toolbar import-backup button exists.
    expect(await h.page.locator('[data-cmd="importProfileArchive"]').count()).toBe(1);
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
