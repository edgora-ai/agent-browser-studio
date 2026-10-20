import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "extension-repository-f09-")),
    faults: [] as Array<{ op: string; matches: (file: string) => boolean; code: string; skip: number; remaining: number }>,
    onPublish: null as null | { destination: string; run: () => void },
    downloadSource: "",
  };
});

// F09 pattern: production filesystem operations still touch real bytes. Only
// selected operations below this test's exclusive mkdtemp root can fail.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  function inject(op: string, file: unknown): void {
    const name = String(file);
    if (!name.startsWith(h.root + path.sep)) return;
    for (const fault of h.faults) {
      if (fault.op !== op || !fault.matches(name) || fault.remaining === 0) continue;
      if (fault.skip > 0) { fault.skip--; continue; }
      fault.remaining--;
      const error = new Error(`${fault.code}: injected ${op} ${name}`) as NodeJS.ErrnoException;
      error.code = fault.code;
      throw error;
    }
  }
  function publishing(destination: unknown): void {
    const name = String(destination);
    if (!name.startsWith(h.root + path.sep)) return;
    if (h.onPublish?.destination === name) {
      const run = h.onPublish.run;
      h.onPublish = null;
      run();
    }
    inject("publish", name);
  }
  return {
    ...actual,
    renameSync: (from: any, to: any) => {
      inject("rename-from", from); inject("rename-to", to); publishing(to);
      return actual.renameSync(from, to);
    },
    copyFileSync: (from: any, to: any, ...args: any[]) => {
      publishing(to); inject("copy-to", to);
      const target = String(to);
      if (target.startsWith(h.root + path.sep) && h.faults.some((fault) => fault.op === "copy-partial" && fault.matches(target) && fault.remaining > 0)) {
        actual.writeFileSync(to, actual.readFileSync(from).subarray(0, 17), { flag: "wx" });
        inject("copy-partial", to);
      }
      return (actual.copyFileSync as any)(from, to, ...args);
    },
    rmSync: (file: any, ...args: any[]) => {
      inject("rm", file);
      return (actual.rmSync as any)(file, ...args);
    },
    writeFileSync: (file: any, ...args: any[]) => {
      inject("write", file);
      return (actual.writeFileSync as any)(file, ...args);
    },
  };
});
vi.mock("electron", () => ({
  app: { getPath: (name: string) => name === "userData" ? path.join(h.root, "userData") : h.root },
}));
// Chrome Store tests use synthetic local ZIP bytes, never a real download.
vi.mock("../../src/main/services/proxy-detector.js", () => ({
  downloadFileWithCurl: (_url: string, destination: string) => {
    if (!h.downloadSource) throw new Error("Test download source is not configured");
    fs.copyFileSync(h.downloadSource, destination);
  },
}));

const TEST_HOME = h.root;

import {
  getAppDataDir,
  getConfig,
  getConfigPath,
  reloadConfig,
  saveConfig,
} from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import {
  __extensionRepositoryTestHooks,
  addOrUpdateChromeStoreExtension,
  deleteRepositoryExtension,
  getEnabledRepositoryExtensionPaths,
  getRepositoryExtension,
  hasInstalledRepositoryExtension,
  listExtensionRepository,
  installLocalExtension,
  prepareSyncedExtensionPackage,
  restoreSyncedExtensionPackage,
  setRepositoryExtensionMeta,
} from "../../src/main/services/extension-repository.js";

beforeEach(() => {
  h.faults = [];
  h.onPublish = null;
  h.downloadSource = "";
  for (const name of fs.readdirSync(TEST_HOME)) {
    fs.rmSync(path.join(TEST_HOME, name), { recursive: true, force: true });
  }
  reloadConfig();
  getConfig(); // Finish synthetic device identity initialization before faults.
});
afterEach(() => {
  h.faults = [];
  h.onPublish = null;
  vi.restoreAllMocks();
});
afterAll(() => {
  if (path.dirname(TEST_HOME) !== os.tmpdir() || !path.basename(TEST_HOME).startsWith("extension-repository-f09-")) {
    throw new Error("Unsafe extension test cleanup root");
  }
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("Extension repository data flow", () => {

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

const SAFETY_ID = "local_safetytest";
const OTHER_ID = "local_othersafety";
const diskConfig = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const sha512 = (file: string) => fs.existsSync(file) ? createHash("sha512").update(fs.readFileSync(file)).digest("hex") : null;
function directoryDigests(directory: string): Array<{ file: string; hash: string }> | null {
  if (!fs.existsSync(directory)) return null;
  const rows: Array<{ file: string; hash: string }> = [];
  function walk(current: string): void {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Test digest must not follow symlinks");
      if (stat.isDirectory()) walk(file);
      else rows.push({ file: path.relative(directory, file), hash: sha512(file)! });
    }
  }
  walk(directory);
  return rows;
}
function repositoryFixture(version: string, id = SAFETY_ID, source: "local" | "chrome-web-store" = "local") {
  const manifest = JSON.stringify({ manifest_version: 3, name: "Safety Extension", version, description: "real filesystem sentinel" });
  const file = path.join(TEST_HOME, `${id}-${version}.zip`);
  fs.writeFileSync(file, buildStoredZip([
    { name: "manifest.json", content: manifest },
    { name: "background.js", content: `version=${JSON.stringify(version)};\n` },
    { name: "nested/sentinel.bin", content: `\0sentinel:${version}ÿ` },
  ]));
  return {
    file,
    remote: {
      id, source, name: "Safety Extension", version, description: "real filesystem sentinel",
      manifestHash: createHash("sha512").update(manifest).digest("hex"),
      packageHash: sha512(file)!, shared: true, tags: ["safety", "sentinel"],
      ...(source === "chrome-web-store" ? {
        chromeStoreUrl: `https://chromewebstore.google.com/detail/${id}`,
        updateUrl: `https://clients2.google.com/service/update2/crx?x=id%3D${id}`,
      } : {}),
    },
  };
}
async function seedSafetyRepository(id = SAFETY_ID, source: "local" | "chrome-web-store" = "local") {
  const previous = repositoryFixture("1.0", id, source);
  await restoreSyncedExtensionPackage(id, previous.file, previous.remote);
  transact((draft) => { draft.automationNotify = { system: true, sound: false }; });
  const directory = path.join(getAppDataDir(), "extension-repository", id, "current");
  const packageFile = path.join(path.dirname(directory), source === "local" ? "package.zip" : "package.crx");
  return { id, directory, packageFile, config: diskConfig(), directoryHashes: directoryDigests(directory), packageHash: sha512(packageFile) };
}
function fault(op: string, file: string | ((name: string) => boolean), code = "EACCES", skip = 0): void {
  h.faults.push({ op, matches: typeof file === "string" ? (name) => name === file : file, code, skip, remaining: 1 });
}
function assertStoredEntry(expected: any): void {
  expect(diskConfig().extensionRepository[expected.id]).toEqual(expected);
  reloadConfig();
  expect(getRepositoryExtension(expected.id)).toEqual(expected);
  expect(listExtensionRepository("sentinel").find((entry) => entry.id === expected.id)).toEqual(expected);
}
function assertOriginalResources(before: Awaited<ReturnType<typeof seedSafetyRepository>>): void {
  expect.soft(directoryDigests(before.directory), "complete original unpacked directory digests").toEqual(before.directoryHashes);
  expect.soft(sha512(before.packageFile), "original package digest").toBe(before.packageHash);
  expect.soft(diskConfig()).toEqual(before.config);
  assertStoredEntry(before.config.extensionRepository[before.id]);
}
async function caughtError(operation: Promise<unknown>): Promise<any> {
  try { await operation; } catch (error) { return error; }
  throw new Error("Expected repository operation to reject");
}
function retainedOriginals(error: any, before: Awaited<ReturnType<typeof seedSafetyRepository>>): void {
  expect(error).toMatchObject({ code: "EXTENSION_REPOSITORY_RECOVERY_REQUIRED", extensionId: before.id });
  expect(error.message).toMatch(/EIO.*recovery required.*EACCES/is);
  expect(error.recoveryPaths.some((file: string) => fs.existsSync(file) && fs.lstatSync(file).isDirectory()
    && JSON.stringify(directoryDigests(file)) === JSON.stringify(before.directoryHashes))).toBe(true);
  expect(error.recoveryPaths.some((file: string) => fs.existsSync(file) && fs.lstatSync(file).isFile()
    && sha512(file) === before.packageHash)).toBe(true);
  expect(fs.existsSync(error.recoveryReceiptPath)).toBe(true);
  expect(JSON.parse(fs.readFileSync(error.recoveryReceiptPath, "utf8"))).toMatchObject({ state: "recovery-required", extensionId: before.id });
  expect(diskConfig()).toEqual(before.config);
  assertStoredEntry(before.config.extensionRepository[before.id]);
}

describe("F09 extension repository commit safety", () => {
  it("never deletes the original directory/package when the first backup rename fails", async () => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    fault("rename-from", before.directory);
    await expect(restoreSyncedExtensionPackage(before.id, next.file, next.remote)).rejects.toThrow(/EACCES/);
    assertOriginalResources(before);
  });

  it("restores the moved directory without deleting an original package whose backup rename failed", async () => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    fault("rename-from", before.packageFile);
    await expect(restoreSyncedExtensionPackage(before.id, next.file, next.remote)).rejects.toThrow(/EACCES/);
    assertOriginalResources(before);
  });

  it.each(["directory", "package"])("compensates a new %s publication failure with original bytes/config intact", async (resource) => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    fault("publish", resource === "directory" ? before.directory : before.packageFile, "EIO");
    await expect(restoreSyncedExtensionPackage(before.id, next.file, next.remote)).rejects.toThrow(/EIO/);
    assertOriginalResources(before);
  });

  it("compensates config commit failure without publishing in-memory extension metadata", async () => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    fault("rename-to", getConfigPath(), "EIO");
    await expect(restoreSyncedExtensionPackage(before.id, next.file, next.remote)).rejects.toThrow(/EIO/);
    assertOriginalResources(before);
  });

  it.each(["remove-new-directory", "restore-old-directory"])("retains original rescue bytes and durably guards a target after failed compensation (%s)", async (failure) => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    fault("rename-to", getConfigPath(), "EIO");
    if (failure === "remove-new-directory") fault("rm", before.directory);
    else fault("rename-to", before.directory, "EACCES", 1); // publication succeeds, restore fails
    const error = await caughtError(restoreSyncedExtensionPackage(before.id, next.file, next.remote));
    retainedOriginals(error, before);
    h.faults = [];
    const rescueHashes = directoryDigests(path.dirname(before.directory));
    const retry = await caughtError(restoreSyncedExtensionPackage(before.id, next.file, next.remote));
    expect(retry.code).toBe("EXTENSION_REPOSITORY_RECOVERY_REQUIRED");
    expect(() => deleteRepositoryExtension(before.id)).toThrow(/EXTENSION_REPOSITORY_RECOVERY_REQUIRED/);
    expect(() => setRepositoryExtensionMeta(before.id, { shared: false })).toThrow(/EXTENSION_REPOSITORY_RECOVERY_REQUIRED/);
    expect(directoryDigests(path.dirname(before.directory))).toEqual(rescueHashes);
    // Re-import the module to prove protection is on disk, not just a process-local flag.
    vi.resetModules();
    const reopened = await import("../../src/main/services/extension-repository.js");
    const restartedRetry = await caughtError(reopened.restoreSyncedExtensionPackage(before.id, next.file, next.remote));
    expect(restartedRetry.code).toBe("EXTENSION_REPOSITORY_RECOVERY_REQUIRED");
    expect(directoryDigests(path.dirname(before.directory))).toEqual(rescueHashes);
    expect(hasInstalledRepositoryExtension(before.id)).toBe(false);
  });

  it.each(["directory", "package"])("keeps committed new config/files and reports a warning when old %s cleanup fails", async (resource) => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fault("rm", (name) => name.startsWith(path.dirname(before.directory) + path.sep)
      && name.includes(resource === "directory" ? "current.backup" : "package") && name.includes(".backup"));
    const result = await restoreSyncedExtensionPackage(before.id, next.file, next.remote) as any;
    expect(result.repositoryCommit).toMatchObject({ committed: true, cleanupWarnings: [{ code: "EXTENSION_REPOSITORY_CLEANUP_FAILED" }] });
    const cleanupWarning = result.repositoryCommit.cleanupWarnings[0];
    expect(cleanupWarning.message).toMatch(/EACCES/);
    expect(fs.existsSync(cleanupWarning.path)).toBe(true);
    expect(warning).toHaveBeenCalled();
    expect(sha512(before.packageFile)).toBe(next.remote.packageHash);
    const stored = diskConfig().extensionRepository[before.id];
    expect(stored).toMatchObject({ version: "2.0", packageHash: next.remote.packageHash, manifestHash: next.remote.manifestHash });
    expect(stored).not.toHaveProperty("repositoryCommit");
    expect(sha512(path.join(before.directory, "manifest.json"))).toBe(next.remote.manifestHash);
    assertStoredEntry(stored);
    expect(hasInstalledRepositoryExtension(before.id)).toBe(true);
  });

  it("returns committed success with a cleanup warning if outer staging cleanup fails", async () => {
    const next = repositoryFixture("2.0");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fault("rm", (name) => path.basename(name).startsWith(".tmp-") && name.startsWith(getAppDataDir() + path.sep));
    const result = await restoreSyncedExtensionPackage(SAFETY_ID, next.file, next.remote) as any;
    expect(result.repositoryCommit).toMatchObject({ committed: true, cleanupWarnings: [{ code: "EXTENSION_REPOSITORY_CLEANUP_FAILED" }] });
    expect(fs.existsSync(result.repositoryCommit.cleanupWarnings[0].path)).toBe(true);
    const stored = diskConfig().extensionRepository[SAFETY_ID];
    expect(stored.packageHash).toBe(next.remote.packageHash);
    expect(sha512(path.join(result.unpackedPath, "manifest.json"))).toBe(next.remote.manifestHash);
    assertStoredEntry(stored);
  });

  it("writes only its extension record on the live draft, preserving unrelated changes during publication", async () => {
    const before = await seedSafetyRepository();
    await seedSafetyRepository(OTHER_ID);
    const next = repositoryFixture("2.0");
    h.onPublish = { destination: before.directory, run: () => transact((draft) => {
      draft.automationNotify.sound = true;
      draft.extensionRepository[OTHER_ID].tags = ["changed-during-publication"];
    }) };
    await restoreSyncedExtensionPackage(before.id, next.file, next.remote);
    expect(diskConfig().automationNotify).toEqual({ system: true, sound: true });
    expect(diskConfig().extensionRepository[OTHER_ID].tags).toEqual(["changed-during-publication"]);
    reloadConfig();
    expect(getConfig().automationNotify).toEqual({ system: true, sound: true });
    expect(getRepositoryExtension(OTHER_ID)?.tags).toEqual(["changed-during-publication"]);
    const stored = diskConfig().extensionRepository[before.id];
    assertStoredEntry(stored);
    expect(sha512(before.packageFile)).toBe(next.remote.packageHash);
  });

  it("isolates partial package-copy bytes before any original resource is moved", async () => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    fault("copy-partial", (name) => name.endsWith(path.sep + "package.new"), "ENOSPC");
    await expect(restoreSyncedExtensionPackage(before.id, next.file, next.remote)).rejects.toThrow(/ENOSPC/);
    assertOriginalResources(before);
    expect(fs.readdirSync(path.dirname(before.directory)).filter((name) => name.startsWith(".update-") || name.startsWith(".tmp-"))).toEqual([]);
  });

  it("does not mask a failed compensation or remove rescue bytes if outer staging cleanup also fails", async () => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fault("rename-to", getConfigPath(), "EIO");
    fault("rm", before.directory);
    fault("rm", (name) => path.basename(name).startsWith(".tmp-") && name.startsWith(getAppDataDir() + path.sep), "EBUSY");
    const error = await caughtError(restoreSyncedExtensionPackage(before.id, next.file, next.remote));
    retainedOriginals(error, before);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/cleanup.*EBUSY/i));
  });

  it("keeps committed state and rescue material if the postcommit receipt update fails", async () => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fault("rename-to", (name) => name.endsWith(path.sep + "receipt.json"), "EACCES", 1);
    const result = await restoreSyncedExtensionPackage(before.id, next.file, next.remote);
    expect(result.repositoryCommit).toMatchObject({ committed: true, cleanupWarnings: [{ code: "EXTENSION_REPOSITORY_CLEANUP_FAILED" }] });
    const updateDir = result.repositoryCommit.cleanupWarnings[0].path;
    expect(directoryDigests(path.join(updateDir, "current.backup"))).toEqual(before.directoryHashes);
    expect(sha512(path.join(updateDir, "package.backup"))).toBe(before.packageHash);
    expect(sha512(before.packageFile)).toBe(next.remote.packageHash);
    const stored = diskConfig().extensionRepository[before.id];
    expect(stored.version).toBe("2.0");
    assertStoredEntry(stored);
    await expect(restoreSyncedExtensionPackage(before.id, next.file, next.remote)).rejects.toMatchObject({ code: "EXTENSION_REPOSITORY_RECOVERY_REQUIRED" });
    expect(sha512(before.packageFile)).toBe(next.remote.packageHash);
  });

  it("preflights a pinned package snapshot without touching existing repository/config and rejects staging reuse", async () => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    const staging = path.join(TEST_HOME, "pull-preflight");
    const prepared = prepareSyncedExtensionPackage(before.id, next.file, next.remote, staging);
    expect(prepared).toMatchObject({ packageHash: next.remote.packageHash, manifestHash: next.remote.manifestHash, manifest: { version: "2.0" } });
    expect(prepared.packagePath).not.toBe(next.file);
    expect(sha512(prepared.packagePath)).toBe(next.remote.packageHash);
    expect(sha512(path.join(prepared.stagedDir, "manifest.json"))).toBe(next.remote.manifestHash);
    fs.writeFileSync(next.file, "source changed after preflight");
    expect(sha512(prepared.packagePath)).toBe(next.remote.packageHash);
    expect(() => prepareSyncedExtensionPackage(before.id, prepared.packagePath, next.remote, staging)).toThrow(/exist/i);
    assertOriginalResources(before);
  });

  it("preflight rejects invalid hashes and cancellation without publishing an extension", async () => {
    const before = await seedSafetyRepository();
    const next = repositoryFixture("2.0");
    const staging = path.join(TEST_HOME, "bad-preflight");
    expect(() => prepareSyncedExtensionPackage(before.id, next.file, { ...next.remote, packageHash: "0".repeat(128) }, staging)).toThrow(/package hash does not match/);
    const controller = new AbortController();
    controller.abort();
    const cancelledStaging = path.join(TEST_HOME, "cancelled-preflight");
    expect(() => prepareSyncedExtensionPackage(before.id, next.file, next.remote, cancelledStaging, controller.signal)).toThrow(/cancelled/i);
    expect(fs.existsSync(cancelledStaging)).toBe(false);
    assertOriginalResources(before);
  });

  it("does not retry a failed Chrome Store config transaction via replaceable saveConfig", async () => {
    const id = "dddddddddddddddddddddddddddddddd";
    const before = await seedSafetyRepository(id, "chrome-web-store");
    const next = repositoryFixture("2.0", id, "chrome-web-store");
    h.downloadSource = next.file;
    fault("rename-to", getConfigPath(), "EIO");
    await expect(addOrUpdateChromeStoreExtension(id)).rejects.toThrow(/EIO/);
    assertOriginalResources(before);
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
