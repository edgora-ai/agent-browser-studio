// Profile archive export/import round-trip: meta + browser data survive the
// zip, cache/lock files are excluded, names dedupe on re-import, and corrupt /
// foreign archives are rejected.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-archive-test-${process.pid}`);
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { vi } from "vitest";
const stoppedFixture = vi.hoisted(() => ({ discover: vi.fn() }));
// These profiles are synthetic and never launched. Isolate only the real OS
// process scanner; actual ZIP creation, validation, disk and reload paths stay real.
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  findBrowserByProfileSync: stoppedFixture.discover,
}));
import { createBrowserProfile, deleteBrowserProfile } from "../../src/main/services/browser-manager.js";
import { exportProfileArchive, importProfileArchive, exportProfileArchives, importProfileArchives } from "../../src/main/services/profile-archive.js";
import { getProfilesDir, getProfileMeta, getConfig, getConfigPath, reloadConfig, saveConfig, setProfileMeta } from "../../src/main/services/config-manager.js";
import { writeZipArchive, readZipEntries, extractZipEntry } from "../../src/main/services/zip-writer.js";

const ARCHIVES = path.join(os.tmpdir(), `agent-browser-archive-export-${process.pid}`);

function profileDir(dirId: string): string {
  return path.join(getProfilesDir(), dirId);
}

function archiveMeta(zipPath: string): any {
  const zip = fs.readFileSync(zipPath);
  const entry = readZipEntries(zip).find((item) => item.name === "meta.json");
  expect(entry).toBeDefined();
  return JSON.parse(extractZipEntry(zip, entry!).toString("utf8"));
}

function diskProfile(dirId: string): any {
  return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).browserProfiles[dirId];
}

describe("profile archive export/import", () => {
  beforeEach(() => {
    stoppedFixture.discover.mockReset().mockReturnValue(null);
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.rmSync(ARCHIVES, { recursive: true, force: true });
    fs.mkdirSync(ARCHIVES, { recursive: true });
    reloadConfig();
  });
  afterEach(() => {
    for (const [dirId, expectedDir] of stoppedFixture.discover.mock.calls) {
      expect(path.resolve(expectedDir)).toBe(path.resolve(getProfilesDir(), dirId));
      expect(path.resolve(expectedDir).startsWith(path.resolve(TEST_USER_DATA) + path.sep)).toBe(true);
    }
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

  it("exports an explicit portable behavior allowlist and restores it through disk/reload/ID lookup", async () => {
    const extId = "abcdefghijklmnopabcdefghijklmnop";
    const localFontsDir = path.join(TEST_USER_DATA, "fonts", "synthetic");
    fs.mkdirSync(localFontsDir, { recursive: true });
    const created = createBrowserProfile({ name: "Portable", platform: "windows", fingerprintSeed: 4242 });
    setProfileMeta(created.dirId, {
      fontsDir: localFontsDir,
      drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict", windowTitlePrefix: null,
      allowThirdPartyCookies: true, note: "Work session", tags: ["portable"],
      extensions: { [extId]: true },
    });
    const baseline = {
      userAgent: "Synthetic UA", screenW: 1920, webgpuIsFallbackAdapter: false,
      systemColors: JSON.stringify({ preferred: { Canvas: "rgb(0, 0, 0)" } }),
      workerIdentity: JSON.stringify({ userAgent: "Synthetic worker" }),
    };
    const cfg = getConfig();
    cfg.browserProfiles[created.dirId].preset = "amazon-seller-us";
    cfg.browserProfiles[created.dirId].fingerprintBaseline = baseline;
    cfg.browserProfiles[created.dirId].proxyMode = "named";
    cfg.browserProfiles[created.dirId].proxyName = "absent_proxy";
    cfg.browserProfiles[created.dirId].lock = { owner: "other-device", ownerName: "other-device", at: 1 };
    cfg.browserProfiles[created.dirId].syncedAt = 123;
    cfg.browserProfiles[created.dirId].syncedHash = "remote-hash";
    cfg.browserProfiles[created.dirId].updatedAt = 456;
    saveConfig(cfg);

    const zipPath = path.join(ARCHIVES, "portable.zip");
    await exportProfileArchive(created.dirId, zipPath);
    const doc = archiveMeta(zipPath);
    expect(doc.formatVersion).toBe(1);
    expect(doc.omitted).toEqual({ fontsDir: true });
    expect(JSON.stringify(doc)).not.toContain(localFontsDir);
    expect(doc.profile).toMatchObject({
      drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict",
      windowTitlePrefix: null, allowThirdPartyCookies: true, preset: "amazon-seller-us",
      fingerprintBaseline: baseline, extensions: { [extId]: true }, proxyMode: "named", proxyName: "absent_proxy",
    });
    for (const field of ["lock", "syncedAt", "syncedHash", "updatedAt", "fontsDir", "secretKey"]) {
      expect(doc.profile).not.toHaveProperty(field);
    }
    const beforeImport = Date.now();
    const imported = importProfileArchive(zipPath);
    expect(imported.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/named proxy.*absent_proxy.*not included/i),
      expect.stringMatching(/extension.*not included/i),
      expect.stringMatching(/fonts directory.*not included/i),
    ]));
    const stored = diskProfile(imported.dirId);
    expect(stored).toMatchObject({
      drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict",
      windowTitlePrefix: null, allowThirdPartyCookies: true, preset: "amazon-seller-us",
      fingerprintBaseline: baseline, extensions: { [extId]: true }, proxyMode: "named", proxyName: "absent_proxy",
    });
    expect(stored.updatedAt).toBeGreaterThanOrEqual(beforeImport);
    expect(stored.updatedAt).not.toBe(456);
    for (const field of ["lock", "syncedAt", "syncedHash"]) expect(stored).not.toHaveProperty(field);
    expect(stored.fontsDir).toBeNull(); // local default, never an exported device path
    reloadConfig();
    expect(getProfileMeta(imported.dirId)).toMatchObject({
      drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict",
      windowTitlePrefix: null, preset: "amazon-seller-us", fingerprintBaseline: baseline,
      extensions: { [extId]: true }, proxyMode: "named", proxyName: "absent_proxy",
    });
    expect(Object.keys(getConfig().browserProfiles).filter((id) => id === imported.dirId)).toHaveLength(1);
  });

  it.each([
    { label: "LF", note: "  First line\nSecond line  ", expected: "First line\nSecond line" },
    { label: "CRLF", note: "\r\nFirst line\r\nSecond line\r\n", expected: "First line\r\nSecond line" },
    { label: "CR", note: "First line\rSecond line", expected: "First line\rSecond line" },
    { label: "TAB", note: " \tFirst\tSecond\t ", expected: "First\tSecond" },
    { label: "empty", note: "", expected: null },
    { label: "whitespace", note: " \t\r\n ", expected: null },
    { label: "null", note: null, expected: null },
    { label: "long", note: "n".repeat(2001), expected: "n".repeat(2000) },
    {
      label: "long multiline", note: " \tHeader\n" + "n".repeat(2100) + "\r\n",
      expected: (" \tHeader\n" + "n".repeat(2100) + "\r\n").slice(0, 2000).trim(),
    },
  ])("round-trips a $label note through a real ZIP, disk, reload and ID lookup", async ({ note, expected }) => {
    const created = createBrowserProfile({ name: "Note round-trip", platform: "windows", fingerprintSeed: 4242 });
    setProfileMeta(created.dirId, { note });
    fs.writeFileSync(path.join(profileDir(created.dirId), "note-sentinel.txt"), "note-browser-data");
    expect(diskProfile(created.dirId).note).toBe(note || null);
    const zipPath = path.join(ARCHIVES, "note.zip");
    await exportProfileArchive(created.dirId, zipPath);
    expect(archiveMeta(zipPath).profile.note).toBe(note || null);

    const imported = importProfileArchive(zipPath);
    expect(imported.dirId).not.toBe(created.dirId);
    expect(diskProfile(imported.dirId).note).toBe(expected);
    expect(fs.readFileSync(path.join(profileDir(imported.dirId), "note-sentinel.txt"), "utf8")).toBe("note-browser-data");
    reloadConfig();
    expect(getProfileMeta(imported.dirId)?.note).toBe(expected);
    expect(Object.entries(getConfig().browserProfiles).filter(([id, meta]) => id === imported.dirId && meta.note === expected)).toHaveLength(1);
    expect(getProfileMeta(created.dirId)?.note).toBe(note || null);
  });

  it.each(Array.from({ length: 32 }, (_, code) => code).filter((code) => ![9, 10, 13].includes(code)).concat(127))(
    "rejects note control code %i in a real ZIP without changing stored profiles or files",
    async (code) => {
      const created = createBrowserProfile({ name: "Rejected note", platform: "windows" });
      const sentinel = path.join(profileDir(created.dirId), "note-sentinel.txt");
      fs.writeFileSync(sentinel, "existing-browser-data");
      // Neither trim nor the 2000-character limit may hide forbidden controls.
      const control = String.fromCharCode(code);
      for (const note of ["before" + control + "after", control + "note", "note" + control, control, "n".repeat(2000) + control]) {
        setProfileMeta(created.dirId, { note });
        const zipPath = path.join(ARCHIVES, "rejected-note.zip");
        await exportProfileArchive(created.dirId, zipPath);
        expect(archiveMeta(zipPath).profile.note).toBe(note);
        const beforeConfig = fs.readFileSync(getConfigPath(), "utf8");
        const beforeIds = fs.readdirSync(getProfilesDir()).sort();
        expect(() => importProfileArchive(zipPath)).toThrow(/Invalid.*text value/);
        expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(beforeConfig);
        expect(fs.readdirSync(getProfilesDir()).sort()).toEqual(beforeIds);
        expect(fs.readFileSync(sentinel, "utf8")).toBe("existing-browser-data");
        reloadConfig();
        expect(getProfileMeta(created.dirId)?.note).toBe(note);
        expect(Object.keys(getConfig().browserProfiles)).toEqual([created.dirId]);
      }
      expect(stoppedFixture.discover).toHaveBeenCalledWith(created.dirId, path.resolve(getProfilesDir(), created.dirId));
    },
  );

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

  it("accepts older format-1 metadata with absent optional fields and ignores device-only fields", async () => {
    const zipPath = path.join(ARCHIVES, "legacy.zip");
    await writeZipArchive(zipPath, [{ name: "meta.json", data: Buffer.from(JSON.stringify({
      formatVersion: 1, profile: {
        name: "Legacy", fingerprintSeed: 12345, platform: "windows",
        fontsDir: "/source-device/secret-fonts", syncedAt: 7, syncedHash: "hash",
        updatedAt: 2, lock: { owner: "source-device" }, secretKey: "do-not-transfer",
      },
    })) }]);
    const imported = importProfileArchive(zipPath);
    expect(imported.warnings).toEqual([expect.stringMatching(/fonts directory.*not included/i)]);
    const disk = diskProfile(imported.dirId);
    expect(disk).toMatchObject({ name: "Legacy", drm: false, renderScaleMode: "native", appUrl: null, fontsDir: null });
    for (const field of ["syncedAt", "syncedHash", "lock", "secretKey"]) expect(disk).not.toHaveProperty(field);
    reloadConfig();
    expect(getProfileMeta(imported.dirId)).toMatchObject({ name: "Legacy", drm: false, renderScaleMode: "native", appUrl: null });
  });

  it("accepts Firefox pins and captured scalar baseline fields, but not nested or unknown keys", async () => {
    const zipPath = path.join(ARCHIVES, "firefox.zip");
    const baseline = {
      systemColors: JSON.stringify({ dark: { Canvas: "rgb(0, 0, 0)" } }),
      uaHighEntropy: JSON.stringify({ architecture: "x86" }),
      webgpuIsFallbackAdapter: false, devicePixelRatio: 2,
      injected: { path: "/other-device/secrets" },
    };
    await writeZipArchive(zipPath, [{ name: "meta.json", data: Buffer.from(JSON.stringify({
      formatVersion: 1, profile: { name: "Firefox", engine: "firefox", browserVersion: "154.0", fingerprintBaseline: baseline },
    })) }]);
    const imp = importProfileArchive(zipPath);
    const stored = diskProfile(imp.dirId);
    expect(stored.engine).toBe("firefox");
    expect(stored.browserVersion).toBe("154.0");
    expect(stored.fingerprintBaseline).toEqual({
      systemColors: baseline.systemColors, uaHighEntropy: baseline.uaHighEntropy,
      webgpuIsFallbackAdapter: false, devicePixelRatio: 2,
    });
    reloadConfig();
    expect(getProfileMeta(imp.dirId)?.fingerprintBaseline).toEqual(stored.fingerprintBaseline);
  });

  it("rejects invalid behavior fields without creating a profile or changing config", async () => {
    const badProfiles = [
      { appUrl: "file:///source/private" },
      { engine: "chromium", browserVersion: "154.0" },
      { engine: "firefox", browserVersion: "149.0.7827.22" },
      { extensions: { "../unsafe": true } },
      { extensions: { abcdefghijklmnopabcdefghijklmnop: "yes" } },
      { fingerprintBaseline: { userAgent: { token: "nested" } } },
      { fingerprintBaseline: { userAgent: "x".repeat(65 * 1024) } },
      { geolocationMode: "custom", geolocationLatitude: 91, geolocationLongitude: 0 },
      { hardwareConcurrency: 10000 },
      { proxyMode: "named", proxyName: "../../outside" },
      // The archive note exception must not relax single-line metadata.
      ...["\n", "\r", "\t"].flatMap((control) => [
        { name: `Bad${control}name` },
        { gpuVendor: `Bad${control}vendor` },
        { gpuRenderer: `Bad${control}renderer` },
      ]),
    ];
    fs.mkdirSync(getProfilesDir(), { recursive: true });
    getConfig(); // seed the installation identity before comparing archive-only writes
    for (const [index, bad] of badProfiles.entries()) {
      const zipPath = path.join(ARCHIVES, `bad-${index}.zip`);
      await writeZipArchive(zipPath, [{ name: "meta.json", data: Buffer.from(JSON.stringify({
        formatVersion: 1, profile: { name: "Bad", fingerprintSeed: 12345, platform: "windows", ...bad },
      })) }]);
      const before = fs.readFileSync(getConfigPath(), "utf8");
      const ids = fs.readdirSync(getProfilesDir());
      expect(() => importProfileArchive(zipPath), JSON.stringify(bad).slice(0, 100)).toThrow();
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(fs.readdirSync(getProfilesDir())).toEqual(ids);
    }
  });

  it("retains enabled extension references without claiming an installed repository was transferred", async () => {
    const installedId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const missingId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const unpackedPath = path.join(TEST_USER_DATA, "extension-repository", installedId, "current");
    fs.mkdirSync(unpackedPath, { recursive: true });
    fs.writeFileSync(path.join(unpackedPath, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Local", version: "1.0" }));
    const cfg = getConfig();
    cfg.extensionRepository = cfg.extensionRepository || {};
    cfg.extensionRepository[installedId] = {
      id: installedId, name: "Local", version: "1.0", description: "", source: "local",
      unpackedPath, packageHash: "a".repeat(128), manifestHash: "b".repeat(128), shared: false,
      tags: [], addedAt: 1, updatedAt: 1,
    };
    saveConfig(cfg);
    const zipPath = path.join(ARCHIVES, "extensions.zip");
    await writeZipArchive(zipPath, [{ name: "meta.json", data: Buffer.from(JSON.stringify({ formatVersion: 1, profile: {
      name: "Referenced", extensions: { [installedId]: true, [missingId]: true },
    } })) }]);
    const imp = importProfileArchive(zipPath);
    expect(imp.warnings).toHaveLength(1);
    expect(imp.warnings[0]).toContain(missingId);
    const stored = diskProfile(imp.dirId);
    expect(stored.extensions).toEqual({ [installedId]: true, [missingId]: true });
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).extensionRepository).toHaveProperty(installedId);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).extensionRepository).not.toHaveProperty(missingId);
    reloadConfig();
    expect(getProfileMeta(imp.dirId)?.extensions).toEqual(stored.extensions);

    // A repository row alone is not an installed package. A stale/missing
    // manifest must trigger the same warning as a missing extension ID.
    fs.rmSync(path.join(unpackedPath, "manifest.json"));
    const stale = importProfileArchive(zipPath);
    expect(stale.warnings).toHaveLength(2);
    expect(stale.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(installedId), expect.stringContaining(missingId),
    ]));
    expect(diskProfile(stale.dirId).extensions).toEqual(stored.extensions);
  });

  it("batch-exports several profiles into one directory, reporting failures per item", async () => {
    const a = createBrowserProfile({ name: "Batch A", platform: "windows" });
    const b = createBrowserProfile({ name: "Batch B", platform: "windows" });
    fs.writeFileSync(path.join(profileDir(a.dirId), "a.txt"), "a-data");
    fs.writeFileSync(path.join(profileDir(b.dirId), "b.txt"), "b-data");

    const dest = path.join(ARCHIVES, "batch");
    const report = await exportProfileArchives([a.dirId, b.dirId, "ab_missing_batch"], dest);
    expect(report.exported.length).toBe(2);
    expect(report.failed.length).toBe(1);
    expect(report.failed[0].dirId).toBe("ab_missing_batch");
    expect(fs.existsSync(path.join(dest, "Batch_A-" + a.dirId + ".zip"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "Batch_B-" + b.dirId + ".zip"))).toBe(true);
  });

  it("batch-imports several archives, reporting per-zip failures", async () => {
    const a = createBrowserProfile({ name: "Multi A", platform: "windows" });
    const b = createBrowserProfile({ name: "Multi B", platform: "windows" });
    const dest = path.join(ARCHIVES, "multi");
    fs.mkdirSync(dest, { recursive: true });
    const za = path.join(dest, "a.zip");
    const zb = path.join(dest, "b.zip");
    await exportProfileArchive(a.dirId, za);
    await exportProfileArchive(b.dirId, zb);
    expect(deleteBrowserProfile(a.dirId)).toBe(true);
    expect(deleteBrowserProfile(b.dirId)).toBe(true);

    const report = importProfileArchives([za, zb, path.join(dest, "missing.zip")]);
    expect(report.imported.length).toBe(2);
    expect(report.failed.length).toBe(1);
    expect(report.failed[0].zipPath).toBe(path.join(dest, "missing.zip"));
    const names = report.imported.map((i) => i.name).sort();
    expect(names).toEqual(["Multi A", "Multi B"]);
  });
});
