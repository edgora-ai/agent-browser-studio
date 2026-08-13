// Profile archive export/import round-trip: meta + browser data survive the
// zip, cache/lock files are excluded, names dedupe on re-import, and corrupt /
// foreign archives are rejected.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-archive-test");
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { vi } from "vitest";
import { createBrowserProfile, deleteBrowserProfile } from "../../src/main/services/browser-manager.js";
import { exportProfileArchive, importProfileArchive } from "../../src/main/services/profile-archive.js";
import { getProfilesDir, getProfileMeta, getConfig, reloadConfig } from "../../src/main/services/config-manager.js";
import { writeZipArchive } from "../../src/main/services/zip-writer.js";

const ARCHIVES = path.join(os.tmpdir(), "agent-browser-archive-export");

function profileDir(dirId: string): string {
  return path.join(getProfilesDir(), dirId);
}

describe("profile archive export/import", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.rmSync(ARCHIVES, { recursive: true, force: true });
    fs.mkdirSync(ARCHIVES, { recursive: true });
    reloadConfig();
  });
  afterEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.rmSync(ARCHIVES, { recursive: true, force: true });
    reloadConfig();
  });

  it("exports a profile and re-imports it under a fresh dirId with meta + data intact", async () => {
    const created = createBrowserProfile({ name: "Export Me", platform: "windows", fingerprintSeed: 4242, timezone: "America/New_York" });
    const dir = profileDir(created.dirId);
    fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Default", "Preferences"), JSON.stringify({ profile: { name: "x" } }));
    fs.writeFileSync(path.join(dir, "bookmarks"), "bookmarks-data");
    // Cache + lock files must be excluded.
    fs.mkdirSync(path.join(dir, "Cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Cache", "f"), "cache");
    fs.writeFileSync(path.join(dir, "SingletonLock"), "lock");

    const zipPath = path.join(ARCHIVES, "export.zip");
    const exported = await exportProfileArchive(created.dirId, zipPath);
    expect(exported.dirId).toBe(created.dirId);
    expect(fs.existsSync(zipPath)).toBe(true);
    // Remove the source so the import lands with its original name.
    expect(deleteBrowserProfile(created.dirId)).toBe(true);

    const imported = importProfileArchive(zipPath);
    expect(imported.dirId).not.toBe(created.dirId);
    expect(imported.name).toBe("Export Me");
    expect(imported.files).toBeGreaterThan(0);

    const meta = getProfileMeta(imported.dirId);
    expect(meta).toBeTruthy();
    expect(meta!.name).toBe("Export Me");
    expect(meta!.fingerprintSeed).toBe(4242);
    expect(meta!.platform).toBe("windows");
    expect(meta!.timezone).toBe("America/New_York");

    const idir = profileDir(imported.dirId);
    expect(JSON.parse(fs.readFileSync(path.join(idir, "Default", "Preferences"), "utf8")).profile.name).toBe("x");
    expect(fs.readFileSync(path.join(idir, "bookmarks"), "utf8")).toBe("bookmarks-data");
    expect(fs.existsSync(path.join(idir, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(idir, "SingletonLock"))).toBe(false);

    // Source profile was removed; the imported one fully replaces it.
    expect(getProfileMeta(created.dirId)).toBeNull();
  });

  it("dedupes the imported profile name when it already exists", async () => {
    const a = createBrowserProfile({ name: "Same Name", platform: "windows" });
    const zipPath = path.join(ARCHIVES, "a.zip");
    await exportProfileArchive(a.dirId, zipPath);
    deleteBrowserProfile(a.dirId);
    const first = importProfileArchive(zipPath);
    expect(first.name).toBe("Same Name");
    const second = importProfileArchive(zipPath);
    expect(second.name).toBe("Same Name (2)");
  });

  it("rejects an archive that is missing meta.json", async () => {
    const zipPath = path.join(ARCHIVES, "no-meta.zip");
    await writeZipArchive(zipPath, [{ name: "Default/Preferences", data: Buffer.from("{}") }]);
    expect(() => importProfileArchive(zipPath)).toThrow(/meta.json/);
  });

  it("rejects a missing archive file", () => {
    expect(() => importProfileArchive(path.join(ARCHIVES, "nope.zip"))).toThrow(/not found/);
  });

  it("preserves tags and drops sync/lock fields on import", async () => {
    const created = createBrowserProfile({ name: "Tagged", platform: "macos", tags: ["shop", "us"] });
    const dir = profileDir(created.dirId);
    const cfg = getConfig() as any;
    cfg.browserProfiles[created.dirId].lock = { owner: "dev-1", ownerName: "dev-1", at: Date.now() };
    cfg.browserProfiles[created.dirId].syncedAt = 12345;
    (cfg as any).__t = undefined;
    const zipPath = path.join(ARCHIVES, "t.zip");
    await exportProfileArchive(created.dirId, zipPath);
    const imported = importProfileArchive(zipPath);
    const meta = getProfileMeta(imported.dirId) as any;
    expect(meta.tags).toEqual(["shop", "us"]);
    expect(meta.lock).toBeUndefined();
    expect(meta.syncedAt).toBeUndefined();
    expect(meta.platform).toBe("macos");
  });
});
