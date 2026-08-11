import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_HOME = path.join(os.tmpdir(), "agent-browser-extension-repo-test-home");
  const TEST_USER_DATA = path.join(TEST_HOME, "userData");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "home") return TEST_HOME;
        if (name === "userData") return TEST_USER_DATA;
        return "/tmp";
      },
    },
  };
});

const TEST_HOME = path.join(os.tmpdir(), "agent-browser-extension-repo-test-home");

import {
  getAppDataDir,
  getConfig,
  getConfigPath,
  reloadConfig,
  saveConfig,
} from "../../src/main/services/config-manager.js";
import {
  __extensionRepositoryTestHooks,
  getEnabledRepositoryExtensionPaths,
  listExtensionRepository,
  installLocalExtension,
  restoreSyncedExtensionPackage,
} from "../../src/main/services/extension-repository.js";

describe("Extension repository data flow", () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("writes repository entries, verifies storage, reads back, and searches", () => {
    const extId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const unpackedPath = path.join(getAppDataDir(), "extension-repository", extId, "current");
    fs.mkdirSync(unpackedPath, { recursive: true });
    fs.writeFileSync(path.join(unpackedPath, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Flow Test", version: "1.2.3" }));

    const cfg = structuredClone(getConfig()) as any;
    cfg.extensionRepository = {
      [extId]: {
        id: extId,
        name: "Flow Test",
        version: "1.2.3",
        description: "Data flow verification entry",
        source: "chrome-web-store",
        chromeStoreUrl: `https://chromewebstore.google.com/detail/${extId}`,
        updateUrl: `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=149.0&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
        unpackedPath,
        packageHash: "a".repeat(128),
        manifestHash: "b".repeat(128),
        shared: true,
        tags: ["flow", "verify"],
        addedAt: 1710000000000,
        updatedAt: 1710000000001,
      },
    };
    cfg.browserProfiles = {
      cb_flow_verify: {
        dirId: "cb_flow_verify",
        name: "Flow Verify",
        version: "149",
        fingerprintSeed: 12345,
        platform: "windows",
        extensions: { [extId]: true },
        syncedAt: null,
        syncStatus: "never",
        lastModified: 1710000000002,
      },
    };

    saveConfig(cfg);

    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    const readBack = listExtensionRepository();
    const searched = listExtensionRepository("verify");
    const enabledPaths = getEnabledRepositoryExtensionPaths("cb_flow_verify");

    expect(stored.extensionRepository[extId].name).toBe("Flow Test");
    expect(stored.extensionRepository[extId].shared).toBe(true);
    expect(readBack).toHaveLength(1);
    expect(readBack[0].id).toBe(extId);
    expect(searched).toHaveLength(1);
    expect(searched[0].tags).toContain("verify");
    expect(enabledPaths).toEqual([unpackedPath]);
  });

  it("rejects unsafe ZIP paths before writing files", () => {
    const zipPath = path.join(TEST_HOME, "unsafe-path.zip");
    const outDir = path.join(TEST_HOME, "unsafe-path-out");
    fs.mkdirSync(TEST_HOME, { recursive: true });
    fs.writeFileSync(zipPath, buildStoredZip([{ name: "../evil.txt", content: "bad" }]));

    expect(() => __extensionRepositoryTestHooks.assertSafeZipEntries(zipPath)).toThrow(/unsafe path/);
    expect(() => __extensionRepositoryTestHooks.extractZipSafely(zipPath, outDir)).toThrow(/unsafe path/);
    expect(fs.existsSync(path.join(TEST_HOME, "evil.txt"))).toBe(false);
  });

  it("rejects ZIP symlink entries before extraction", () => {
    const zipPath = path.join(TEST_HOME, "symlink.zip");
    const outDir = path.join(TEST_HOME, "symlink-out");
    fs.mkdirSync(TEST_HOME, { recursive: true });
    fs.writeFileSync(zipPath, buildStoredZip([{ name: "link", content: "target", mode: 0o120777 }]));

    expect(() => __extensionRepositoryTestHooks.assertSafeZipEntries(zipPath)).toThrow(/unsafe link/);
    expect(() => __extensionRepositoryTestHooks.extractZipSafely(zipPath, outDir)).toThrow(/unsafe link/);
    expect(fs.existsSync(path.join(outDir, "link"))).toBe(false);
  });

  it("does not accept symlinked repository paths", () => {
    const extId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const repoEntryDir = path.join(getAppDataDir(), "extension-repository", extId);
    const currentPath = path.join(repoEntryDir, "current");
    const outsidePath = path.join(TEST_HOME, "outside-extension");
    fs.mkdirSync(repoEntryDir, { recursive: true });
    fs.mkdirSync(outsidePath, { recursive: true });
    fs.writeFileSync(path.join(outsidePath, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Outside", version: "1" }));
    fs.symlinkSync(outsidePath, currentPath);

    const cfg = structuredClone(getConfig()) as any;
    cfg.extensionRepository = {
      [extId]: {
        id: extId,
        name: "Symlink Test",
        version: "1",
        description: "",
        source: "chrome-web-store",
        chromeStoreUrl: `https://chromewebstore.google.com/detail/${extId}`,
        updateUrl: `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=149.0&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
        unpackedPath: currentPath,
        packageHash: "c".repeat(128),
        manifestHash: "d".repeat(128),
        shared: false,
        tags: [],
        addedAt: 1710000000000,
        updatedAt: 1710000000001,
      },
    };
    cfg.browserProfiles = {
      cb_symlink_verify: {
        dirId: "cb_symlink_verify",
        name: "Symlink Verify",
        version: "149",
        fingerprintSeed: 12345,
        platform: "windows",
        extensions: { [extId]: true },
        syncedAt: null,
        syncStatus: "never",
        lastModified: 1710000000002,
      },
    };
    expect(() => saveConfig(cfg)).toThrow(/not a real directory/);
  });

  it("does not return paths when extension entry directory is a symlink", () => {
    const extId = "cccccccccccccccccccccccccccccccc";
    const repoRoot = path.join(getAppDataDir(), "extension-repository");
    const outsideEntry = path.join(TEST_HOME, "outside-entry");
    const currentPath = path.join(repoRoot, extId, "current");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(path.join(outsideEntry, "current"), { recursive: true });
    fs.writeFileSync(path.join(outsideEntry, "current", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Outside", version: "1" }));
    fs.symlinkSync(outsideEntry, path.join(repoRoot, extId));

    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      defaultProxy: "",
      proxies: {},
      sync: { enabled: false },
      browserProfiles: {
        cb_symlink_entry: {
          dirId: "cb_symlink_entry",
          name: "Symlink Entry",
          version: "149",
          fingerprintSeed: 12345,
          platform: "windows",
          extensions: { [extId]: true },
          syncedAt: null,
          syncStatus: "never",
          lastModified: 1710000000002,
        },
      },
      extensionRepository: {
        [extId]: {
          id: extId,
          name: "Symlink Entry",
          version: "1",
          description: "",
          source: "chrome-web-store",
          chromeStoreUrl: `https://chromewebstore.google.com/detail/${extId}`,
          updateUrl: `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=149.0&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
          unpackedPath: currentPath,
          packageHash: "e".repeat(128),
          manifestHash: "f".repeat(128),
          shared: false,
          tags: [],
          addedAt: 1710000000000,
          updatedAt: 1710000000001,
        },
      },
    }));

    reloadConfig();
    expect(getEnabledRepositoryExtensionPaths("cb_symlink_entry")).toEqual([]);
  });
});

describe("installLocalExtension", () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });
    reloadConfig();
  });
  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  const MANIFEST = JSON.stringify({
    manifest_version: 3,
    name: "Test Local Ext",
    version: "1.2.3",
    description: "a local test extension",
  });

  it("installs a local ZIP into the repository", async () => {
    const zipPath = path.join(TEST_HOME, "local-ext.zip");
    fs.writeFileSync(zipPath, buildStoredZip([
      { name: "manifest.json", content: MANIFEST },
      { name: "background.js", content: "console.log('hi');" },
    ]));

    const entry = await installLocalExtension(zipPath, { shared: false, tags: ["local"] });
    expect(entry.source).toBe("local");
    expect(entry.name).toBe("Test Local Ext");
    expect(entry.version).toBe("1.2.3");
    expect(entry.id).toMatch(/^local_/);
    expect(entry.tags).toEqual(["local"]);

    // Persisted to config + disk
    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(stored.extensionRepository[entry.id].source).toBe("local");
    expect(fs.existsSync(entry.unpackedPath)).toBe(true);
    expect(fs.existsSync(path.join(entry.unpackedPath, "manifest.json"))).toBe(true);

    // Listed back
    const listed = listExtensionRepository();
    expect(listed.find((e) => e.id === entry.id)).toBeTruthy();
  });

  it("installs an unpacked directory", async () => {
    const dirPath = path.join(TEST_HOME, "unpacked-ext");
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, "manifest.json"), MANIFEST);
    fs.writeFileSync(path.join(dirPath, "popup.html"), "<html></html>");

    const entry = await installLocalExtension(dirPath);
    expect(entry.source).toBe("local");
    expect(entry.name).toBe("Test Local Ext");
    expect(fs.existsSync(path.join(entry.unpackedPath, "popup.html"))).toBe(true);
  });

  it("re-importing the same path creates non-path-derived local IDs", async () => {
    const zipPath = path.join(TEST_HOME, "same.zip");
    fs.writeFileSync(zipPath, buildStoredZip([{ name: "manifest.json", content: MANIFEST }]));
    const e1 = await installLocalExtension(zipPath);
    const e2 = await installLocalExtension(zipPath);
    const pathDerivedId = "local_" + createHash("sha256").update(path.resolve(zipPath)).digest("hex").slice(0, 24);
    expect(e1.id).toMatch(/^local_[a-f0-9]{24}$/);
    expect(e2.id).toMatch(/^local_[a-f0-9]{24}$/);
    expect(e2.id).not.toBe(e1.id);
    expect(e1.id).not.toBe(pathDerivedId);
    expect(e2.id).not.toBe(pathDerivedId);
  });

  it("rejects a ZIP without manifest.json", async () => {
    const zipPath = path.join(TEST_HOME, "no-manifest.zip");
    fs.writeFileSync(zipPath, buildStoredZip([{ name: "background.js", content: "x" }]));
    await expect(installLocalExtension(zipPath)).rejects.toThrow(/manifest/);
  });

  it("rejects a manifest without a name", async () => {
    const badManifest = JSON.stringify({ manifest_version: 3, version: "1" });
    const zipPath = path.join(TEST_HOME, "no-name.zip");
    fs.writeFileSync(zipPath, buildStoredZip([{ name: "manifest.json", content: badManifest }]));
    await expect(installLocalExtension(zipPath)).rejects.toThrow(/name/);
  });

  it("rejects manifest_version other than 2 or 3", async () => {
    const badManifest = JSON.stringify({ manifest_version: 1, name: "x", version: "1" });
    const zipPath = path.join(TEST_HOME, "bad-mv.zip");
    fs.writeFileSync(zipPath, buildStoredZip([{ name: "manifest.json", content: badManifest }]));
    await expect(installLocalExtension(zipPath)).rejects.toThrow(/manifest_version/);
  });

  it("verifies synced extension package hashes before restore", async () => {
    const zipPath = path.join(TEST_HOME, "synced-ext.zip");
    fs.writeFileSync(zipPath, buildStoredZip([
      { name: "manifest.json", content: MANIFEST },
      { name: "background.js", content: "console.log('synced');" },
    ]));
    const manifestHash = createHash("sha512").update(MANIFEST).digest("hex");
    const packageHash = createHash("sha512").update(fs.readFileSync(zipPath)).digest("hex");

    const entry = await restoreSyncedExtensionPackage("local_abcdefgh", zipPath, {
      id: "local_abcdefgh",
      name: "Synced Ext",
      version: "1.2.3",
      description: "synced",
      source: "local",
      manifestHash,
      packageHash,
      shared: true,
      tags: ["synced"],
    });
    expect(entry.manifestHash).toBe(manifestHash);
    expect(entry.packageHash).toBe(packageHash);
    expect(entry.unpackedPath).toContain("local_abcdefgh");

    await expect(restoreSyncedExtensionPackage("local_abcdefghi", zipPath, {
      id: "local_abcdefghi",
      source: "local",
      manifestHash: "0".repeat(128),
      packageHash,
    })).rejects.toThrow(/manifest hash/);
    await expect(restoreSyncedExtensionPackage("local_abcdefghij", zipPath, {
      id: "local_abcdefghij",
      source: "local",
      manifestHash,
      packageHash: "0".repeat(128),
    })).rejects.toThrow(/package hash/);
    await expect(restoreSyncedExtensionPackage("local_abcdefghijk", zipPath, {
      id: "local_abcdefghijk",
      source: "local",
      packageHash,
    })).rejects.toThrow(/manifest hash is required/);
    await expect(restoreSyncedExtensionPackage("local_abcdefghijkl", zipPath, {
      id: "local_abcdefghijkl",
      source: "local",
      manifestHash,
    })).rejects.toThrow(/package hash is required/);
  });

  it("rejects a non-existent path", async () => {
    await expect(installLocalExtension(path.join(TEST_HOME, "nope.zip"))).rejects.toThrow(/does not exist/);
  });
});

function buildStoredZip(entries: Array<{ name: string; content: string; mode?: number }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt32LE(0, 12);
    c.writeUInt32LE(0, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE(((entry.mode || 0o100600) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, eocd]);
}
