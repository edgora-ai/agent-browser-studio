import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "extension-sync-snapshot-")),
    objects: new Map<string, Buffer>(), opened: new Map<number, string>(), reads: [] as string[],
    onRead: null as null | ((file: string) => void),
    onList: null as null | ((directory: string) => void),
    onCopy: null as null | ((destination: string) => void),
    onRename: null as null | ((destination: string) => void),
    failRename: "", failRemoveBackup: false,
  };
});
// Only deterministic faults/hooks inside the exclusive fixture root. Reads,
// writes, ZIPs, repository commits, config reloads and search all use real bytes.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const owned = (file: unknown) => String(file).startsWith(h.root + path.sep);
  return {
    ...actual,
    openSync: (...args: any[]) => {
      const fd = (actual.openSync as any)(...args);
      if (owned(args[0])) { h.opened.set(fd, String(args[0])); h.reads.push(String(args[0])); }
      return fd;
    },
    closeSync: (fd: number) => { h.opened.delete(fd); return actual.closeSync(fd); },
    readSync: (...args: any[]) => {
      const count = (actual.readSync as any)(...args);
      const file = h.opened.get(args[0]);
      if (file) h.onRead?.(file);
      return count;
    },
    readFileSync: (...args: any[]) => {
      if (owned(args[0])) h.reads.push(String(args[0]));
      return (actual.readFileSync as any)(...args);
    },
    readdirSync: (...args: any[]) => {
      const result = (actual.readdirSync as any)(...args);
      if (owned(args[0])) h.onList?.(String(args[0]));
      return result;
    },
    copyFileSync: (...args: any[]) => {
      if (owned(args[0])) h.reads.push(String(args[0]));
      const result = (actual.copyFileSync as any)(...args);
      if (owned(args[1])) h.onCopy?.(String(args[1]));
      return result;
    },
    renameSync: (from: any, to: any) => {
      if (owned(to)) {
        h.onRename?.(String(to));
        if (String(to) === h.failRename) { h.failRename = ""; throw Object.assign(new Error("EIO: synthetic repair config failure"), { code: "EIO" }); }
      }
      return actual.renameSync(from, to);
    },
    rmSync: (...args: any[]) => {
      if (owned(args[0]) && h.failRemoveBackup && String(args[0]).endsWith(path.sep + "current.backup")) {
        h.failRemoveBackup = false;
        throw Object.assign(new Error("EACCES: synthetic repair backup cleanup failure"), { code: "EACCES" });
      }
      return (actual.rmSync as any)(...args);
    },
  };
});
vi.mock("electron", () => ({ app: { getPath: (name: string) => path.join(h.root, name === "home" ? "home" : "userData") } }));
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: () => ({ running: false, pid: null, cdpPort: null }) }));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({ runtimeCookieOps: {
  hasRunningBrowser: () => false,
  exportCookies: vi.fn(async () => []),
  exportCookiesSnapshot: vi.fn(async () => ({ state: "available", cookies: [] })),
  importCookies: vi.fn(async () => 0),
} }));
vi.mock("../../src/main/services/proxy-detector.js", () => ({ downloadFileWithCurl: () => { throw new Error("Real downloads are forbidden in snapshot tests"); } }));

import { getAppDataDir, getConfig, getConfigPath, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import {
  captureRepositoryExtensionForSync, deleteRepositoryExtension, getExtensionRepoEntryDir, getRepositoryExtension,
  installLocalExtension, listExtensionRepository, prepareSyncedExtensionPackage, restoreSyncedExtensionPackage,
  setRepositoryExtensionMeta,
} from "../../src/main/services/extension-repository.js";
import type { ExtensionRepositoryEntry } from "../../src/main/services/extension-repository.js";
import { extractZipEntry, readZipEntries, writeZipArchive } from "../../src/main/services/zip-writer.js";
import { syncService } from "../../src/main/services/sync-service.js";

const ENDPOINT = "https://extension-sync.example.test";
const MAIN = `${ENDPOINT}/synthetic/agent-browser-studio-config.json`;
const MANIFEST = JSON.stringify({ manifest_version: 3, name: "Snapshot Sentinel", version: "1.2.3", description: "verified directory roundtrip" });
const WORKER = "globalThis.snapshotSentinel = 'directory bytes, not just metadata';\n";
const BINARY = Buffer.from([0, 0xff, 1, 2, 0xfe, 0, 0x7f]);
const sha = (data: Buffer | string) => createHash("sha512").update(data).digest("hex");
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const stage = (name: string) => path.join(h.root, `stage-${name}`);

function directoryState(root: string): unknown {
  if (!fs.existsSync(root)) return null;
  const rows: Array<{ name: string; kind: string; hash?: string; target?: string }> = [];
  function visit(current: string, relative: string): void {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) { rows.push({ name: relative, kind: "link", target: fs.readlinkSync(current) }); return; }
    if (!stat.isDirectory()) { rows.push({ name: relative, kind: "file", hash: sha(fs.readFileSync(current)) }); return; }
    rows.push({ name: relative, kind: "directory" });
    for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), relative ? `${relative}/${name}` : name);
  }
  visit(root, "");
  return rows;
}
function beforeCapture(entry: ExtensionRepositoryEntry) {
  return { config: fs.readFileSync(getConfigPath()), repository: directoryState(getExtensionRepoEntryDir(entry.id)) };
}
function assertUnchanged(entry: ExtensionRepositoryEntry, before: ReturnType<typeof beforeCapture>): void {
  expect(fs.readFileSync(getConfigPath())).toEqual(before.config);
  expect(directoryState(getExtensionRepoEntryDir(entry.id))).toEqual(before.repository);
}
async function unpacked() {
  const source = fs.mkdtempSync(path.join(h.root, "source-"));
  fs.mkdirSync(path.join(source, "nested"));
  fs.mkdirSync(path.join(source, "empty"));
  fs.writeFileSync(path.join(source, "manifest.json"), MANIFEST);
  fs.writeFileSync(path.join(source, "worker.js"), WORKER);
  fs.writeFileSync(path.join(source, "nested", "sentinel.bin"), BINARY);
  const installed = await installLocalExtension(source, { shared: true, tags: ["snapshot", "sentinel"] });
  const stored = disk().extensionRepository[installed.id];
  expect(stored.packageHash).toBe(stored.manifestHash);
  expect(fs.existsSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"))).toBe(false);
  expect(fs.existsSync(path.join(getExtensionRepoEntryDir(installed.id), "package.crx"))).toBe(false);
  return installed;
}
async function packaged() {
  const file = stage("input.zip");
  await writeZipArchive(file, [
    { name: "manifest.json", data: Buffer.from(MANIFEST) },
    { name: "worker.js", data: Buffer.from(WORKER) },
    { name: "nested/sentinel.bin", data: BINARY },
    { name: "empty/", isDirectory: true },
  ]);
  return installLocalExtension(file, { shared: true, tags: ["snapshot", "sentinel"] });
}
function assertStored(entry: ExtensionRepositoryEntry): void {
  expect(disk().extensionRepository[entry.id]).toEqual(entry);
  reloadConfig();
  expect(getRepositoryExtension(entry.id)).toEqual(entry);
  expect(listExtensionRepository("sentinel").find((item) => item.id === entry.id)).toEqual(entry);
}
function resetHooks(): void {
  h.onRead = h.onList = h.onCopy = h.onRename = null;
  h.failRename = "";
  h.failRemoveBackup = false;
  h.opened.clear();
  h.reads = [];
}

beforeEach(() => {
  resetHooks();
  for (const name of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, name), { recursive: true, force: true });
  h.objects.clear();
  reloadConfig();
  expect(getAppDataDir()).toBe(path.join(h.root, "userData"));
  const config = structuredClone(getConfig());
  config.sync = { enabled: true, endpoint: ENDPOINT, bucket: "synthetic", accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: Date.now() } as any;
  config.browserProfiles = {};
  config.extensionRepository = {};
  saveConfig(config);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(`${ENDPOINT}/synthetic/`)) throw new Error("Unexpected external request in snapshot test");
    if (init?.method === "PUT") {
      h.objects.set(url, Buffer.from(init.body as any));
      return new Response("", { status: 200 });
    }
    const value = h.objects.get(url);
    return value ? new Response(new Uint8Array(value), { status: 200 }) : new Response("not found", { status: 404 });
  }));
});
afterEach(() => { resetHooks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => {
  expect(path.dirname(h.root)).toBe(os.tmpdir());
  expect(path.basename(h.root)).toMatch(/^extension-sync-snapshot-/);
  expect(fs.lstatSync(h.root).isSymbolicLink()).toBe(false);
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("extension sync snapshot behavioral baseline", () => {
  it("does not announce successful Push while silently omitting an installed directory extension package", async () => {
    const installed = await unpacked();
    const pushed = await syncService.push();
    expect(pushed.success, pushed.message).toBe(true);
    const cloud = JSON.parse(h.objects.get(MAIN)!.toString("utf8"));
    const remote = JSON.parse(zlib.gunzipSync(Buffer.from(cloud.data, "base64")).toString("utf8"));
    expect(remote.extensionRepository[installed.id]).toBeDefined();
    const publications = [...h.objects.keys()];
    const packages = publications.filter((url) => url.includes(`extension-${installed.id}`) && /\.(zip|crx)$/.test(url));
    expect(packages, "successful published manifest must have actual extension bytes, not a silently omitted unpacked directory").toHaveLength(1);
    expect(sha(h.objects.get(packages[0])!)).toBe(remote.extensionRepository[installed.id].packageHash);
    expect(publications.indexOf(packages[0])).toBeLessThan(publications.indexOf(MAIN));
    expect(disk().extensionRepository[installed.id].packageHash).toBe(remote.extensionRepository[installed.id].packageHash);
  });
});

describe("captureRepositoryExtensionForSync", () => {
  it("packages an existing unpacked installation with meaningful byte roundtrip and no capture-time repository/config mutation", async () => {
    const installed = await unpacked();
    const before = beforeCapture(installed);
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("unpacked"));
    expect(snapshot.entry).toEqual({ ...disk().extensionRepository[installed.id], unpackedPath: "", packageHash: sha(fs.readFileSync(snapshot.packagePath)) });
    expect(snapshot.entry.manifestHash).toBe(sha(MANIFEST));
    expect(snapshot.entry.packageHash).not.toBe(installed.packageHash);
    expect(snapshot.entry).not.toHaveProperty("repositoryCommit");
    expect(snapshot.packagePath.startsWith(stage("unpacked") + path.sep)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(snapshot.packagePath).mode & 0o222).toBe(0);
    expect(snapshot.commitLocalRepair).toBeTypeOf("function");
    const bytes = fs.readFileSync(snapshot.packagePath);
    const entries = readZipEntries(bytes);
    expect(extractZipEntry(bytes, entries.find((item) => item.name === "worker.js")!).toString()).toBe(WORKER);
    expect(extractZipEntry(bytes, entries.find((item) => item.name === "nested/sentinel.bin")!)).toEqual(BINARY);
    expect(entries.some((item) => item.name === "empty/" && item.isDirectory)).toBe(true);
    assertUnchanged(installed, before);
    assertStored(disk().extensionRepository[installed.id]);

    // A different target ID models restore on another repository without real
    // userData, cloud, browser, credentials or network access.
    const restored = await restoreSyncedExtensionPackage("local_roundtrip01", snapshot.packagePath, snapshot.entry);
    expect(fs.readFileSync(path.join(restored.unpackedPath, "worker.js"), "utf8")).toBe(WORKER);
    expect(fs.readFileSync(path.join(restored.unpackedPath, "nested", "sentinel.bin"))).toEqual(BINARY);
    expect(sha(fs.readFileSync(path.join(getExtensionRepoEntryDir(restored.id), "package.zip")))).toBe(snapshot.entry.packageHash);
    expect(restored.manifestHash).toBe(snapshot.entry.manifestHash);
    assertStored(disk().extensionRepository[restored.id]);
  });

  it("repairs an unchanged source only when explicitly invoked, aligns exact uploaded metadata, and preserves unrelated live transactions", async () => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("repair"));
    expect(disk().extensionRepository[installed.id].packageHash).toBe(installed.manifestHash);
    transact((draft) => { draft.automationNotify.sound = true; draft.browserProfiles.ab_unrelated = { name: "live edit", updatedAt: 123 }; });
    const unrelated = disk();
    const repaired = await snapshot.commitLocalRepair!();
    expect(repaired?.repositoryCommit).toEqual({ committed: true, cleanupWarnings: [] });
    const stored = disk().extensionRepository[installed.id];
    expect(stored).toEqual({ ...snapshot.entry, unpackedPath: installed.unpackedPath });
    expect(stored).not.toHaveProperty("repositoryCommit");
    expect(disk().automationNotify).toEqual(unrelated.automationNotify);
    expect(disk().browserProfiles).toEqual(unrelated.browserProfiles);
    expect(sha(fs.readFileSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip")))).toBe(snapshot.entry.packageHash);
    expect(fs.readFileSync(path.join(installed.unpackedPath, "worker.js"), "utf8")).toBe(WORKER);
    assertStored(stored);
    expect(await snapshot.commitLocalRepair!()).toBeNull();
  });

  it.each(["metadata", "file", "delete", "repository-update", "new-package", "same-bytes-new-directory", "current-symlink", "file-symlink"])("preserves concurrent %s instead of repairing or reviving the captured source", async (change) => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("diverged"));
    const repository = getExtensionRepoEntryDir(installed.id);
    if (change === "metadata") setRepositoryExtensionMeta(installed.id, { shared: false, tags: ["new-live-tag"] });
    if (change === "file") fs.writeFileSync(path.join(installed.unpackedPath, "worker.js"), "globalThis.locallyEdited = true;\n");
    if (change === "delete") deleteRepositoryExtension(installed.id);
    if (change === "repository-update") {
      const replacement = await packaged();
      const file = path.join(getExtensionRepoEntryDir(replacement.id), "package.zip");
      await restoreSyncedExtensionPackage(installed.id, file, { ...replacement, name: "Replacement Sentinel" });
    }
    if (change === "new-package") fs.writeFileSync(path.join(repository, "package.zip"), "a concurrent new package must not be overwritten");
    if (change === "same-bytes-new-directory") {
      fs.renameSync(installed.unpackedPath, stage("original-current"));
      fs.cpSync(stage("original-current"), installed.unpackedPath, { recursive: true });
    }
    if (change === "current-symlink") {
      fs.renameSync(installed.unpackedPath, stage("original-current"));
      fs.symlinkSync(stage("original-current"), installed.unpackedPath, process.platform === "win32" ? "junction" : "dir");
    }
    if (change === "file-symlink") {
      fs.writeFileSync(stage("known-target.js"), "owned sentinel, never read through symlink");
      fs.unlinkSync(path.join(installed.unpackedPath, "worker.js"));
      fs.symlinkSync(stage("known-target.js"), path.join(installed.unpackedPath, "worker.js"));
    }
    const beforeRepair = beforeCapture(installed);
    expect(await snapshot.commitLocalRepair!()).toBeNull();
    assertUnchanged(installed, beforeRepair);
    if (change === "delete") { expect(getRepositoryExtension(installed.id)).toBeNull(); expect(fs.existsSync(repository)).toBe(false); }
    expect(sha(fs.readFileSync(snapshot.packagePath))).toBe(snapshot.entry.packageHash);
  });

  it("pins a valid existing package without repair or local changes and does not follow later live mutations", async () => {
    const installed = await packaged();
    const before = beforeCapture(installed);
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("packaged"));
    expect(snapshot.commitLocalRepair).toBeUndefined();
    expect(snapshot.entry.packageHash).toBe(installed.packageHash);
    expect(snapshot.entry.manifestHash).toBe(installed.manifestHash);
    expect(snapshot.packagePath).not.toBe(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"));
    assertUnchanged(installed, before);
    fs.writeFileSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"), "live package changed after capture");
    fs.writeFileSync(path.join(installed.unpackedPath, "worker.js"), "live code changed after capture");
    const prepared = prepareSyncedExtensionPackage(installed.id, snapshot.packagePath, snapshot.entry, stage("verify-pinned"));
    expect(sha(fs.readFileSync(snapshot.packagePath))).toBe(installed.packageHash);
    expect(fs.readFileSync(path.join(prepared.stagedDir, "worker.js"), "utf8")).toBe(WORKER);
  });

  it("pins complete Chrome Store CRX bytes with their actual hash while verifying extracted current content", async () => {
    const local = await packaged();
    const zip = fs.readFileSync(path.join(getExtensionRepoEntryDir(local.id), "package.zip"));
    const header = Buffer.alloc(20); header.write("Cr24"); header.writeUInt32LE(3, 4); header.writeUInt32LE(8, 8);
    const crx = Buffer.concat([header, zip]);
    const file = stage("synthetic.crx"); fs.writeFileSync(file, crx);
    const id = "abcdefghijklmnopabcdefghijklmnop";
    const chrome = await restoreSyncedExtensionPackage(id, file, {
      ...local, source: "chrome-web-store", packageHash: sha(crx),
      chromeStoreUrl: `https://chromewebstore.google.com/detail/${id}`,
      updateUrl: `https://clients2.google.com/service/update2/crx?x=id%3D${id}`,
    });
    const before = beforeCapture(chrome);
    const snapshot = await captureRepositoryExtensionForSync(chrome, stage("chrome"));
    expect(snapshot.commitLocalRepair).toBeUndefined();
    expect(snapshot.entry).toMatchObject({ source: "chrome-web-store", packageHash: sha(crx), manifestHash: sha(MANIFEST), unpackedPath: "" });
    expect(fs.readFileSync(snapshot.packagePath)).toEqual(crx);
    assertUnchanged(chrome, before);
  });

  it.each(["edited", "missing", "extra", "missing-empty-directory"])("rejects a valid stored package whose current tree is %s", async (change) => {
    const installed = await packaged();
    if (change === "edited") fs.writeFileSync(path.join(installed.unpackedPath, "worker.js"), "edited code, unchanged manifest");
    if (change === "missing") fs.unlinkSync(path.join(installed.unpackedPath, "worker.js"));
    if (change === "extra") fs.writeFileSync(path.join(installed.unpackedPath, "extra.js"), "extra code absent from ZIP");
    if (change === "missing-empty-directory") fs.rmdirSync(path.join(installed.unpackedPath, "empty"));
    const before = beforeCapture(installed);
    await expect(captureRepositoryExtensionForSync(installed, stage("mismatch"))).rejects.toThrow(/current contents do not match.*package/i);
    assertUnchanged(installed, before);
  });

  it("rejects a corrupted existing package without ignoring it or regenerating from current", async () => {
    const installed = await packaged();
    const file = path.join(getExtensionRepoEntryDir(installed.id), "package.zip");
    const bytes = fs.readFileSync(file);
    const worker = bytes.indexOf(Buffer.from(WORKER));
    expect(worker).toBeGreaterThan(0);
    bytes[worker] ^= 1;
    fs.writeFileSync(file, bytes);
    const before = beforeCapture(installed);
    await expect(captureRepositoryExtensionForSync(installed, stage("corrupt"))).rejects.toThrow(/package hash does not match/i);
    assertUnchanged(installed, before);
  });

  it("rejects a missing previously packaged source rather than misclassifying it as a legacy directory install", async () => {
    const installed = await packaged();
    fs.unlinkSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"));
    const before = beforeCapture(installed);
    await expect(captureRepositoryExtensionForSync(installed, stage("missing-package"))).rejects.toThrow(/package is missing/i);
    assertUnchanged(installed, before);
  });

  it("rejects stored manifest metadata that does not match the existing package", async () => {
    const installed = await packaged();
    transact((draft) => { draft.extensionRepository[installed.id].manifestHash = "0".repeat(128); });
    const current = getRepositoryExtension(installed.id)!;
    const before = beforeCapture(current);
    await expect(captureRepositoryExtensionForSync(current, stage("bad-manifest"))).rejects.toThrow(/manifest hash does not match/i);
    assertUnchanged(current, before);
  });

  it.each(["unpacked-file", "unpacked-directory", "current", "repository-entry", "package", "staging-parent"])("rejects %s symlinks without reading the owned link target", async (link) => {
    const installed = link === "package" ? await packaged() : await unpacked();
    let stagingRoot = stage("symlink");
    const target = stage("known-target");
    let forbidden = target;
    if (link === "unpacked-file") {
      fs.writeFileSync(target, "known owned sentinel");
      forbidden = path.join(installed.unpackedPath, "worker.js");
      fs.unlinkSync(forbidden); fs.symlinkSync(target, forbidden);
    } else if (link === "unpacked-directory") {
      fs.mkdirSync(target); fs.writeFileSync(path.join(target, "sentinel.js"), "known owned sentinel");
      forbidden = path.join(installed.unpackedPath, "linked"); fs.symlinkSync(target, forbidden, process.platform === "win32" ? "junction" : "dir");
    } else if (link === "current" || link === "repository-entry") {
      forbidden = link === "current" ? installed.unpackedPath : getExtensionRepoEntryDir(installed.id);
      fs.renameSync(forbidden, target); fs.symlinkSync(target, forbidden, process.platform === "win32" ? "junction" : "dir");
    } else if (link === "package") {
      forbidden = path.join(getExtensionRepoEntryDir(installed.id), "package.zip");
      fs.renameSync(forbidden, target); fs.symlinkSync(target, forbidden);
    } else {
      fs.mkdirSync(target);
      forbidden = stage("linked-staging"); fs.symlinkSync(target, forbidden, process.platform === "win32" ? "junction" : "dir");
      stagingRoot = path.join(forbidden, "capture");
    }
    const configBefore = fs.readFileSync(getConfigPath());
    h.reads = [];
    await expect(captureRepositoryExtensionForSync(installed, stagingRoot)).rejects.toThrow(/symlink|real directory|unsafe/i);
    const reads = [...h.reads];
    expect(reads.some((file) => file === forbidden || file.startsWith(forbidden + path.sep) || file === target || file.startsWith(target + path.sep))).toBe(false);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
  });

  it.each(["content", "listing"])("rejects source %s changes while the initial snapshot is being read", async (change) => {
    const installed = await unpacked();
    const file = path.join(installed.unpackedPath, "worker.js");
    if (change === "content") h.onRead = (name) => {
      if (name !== file) return;
      h.onRead = null;
      fs.writeFileSync(file, "changed while reading real source bytes");
    };
    else h.onList = (name) => {
      if (name !== installed.unpackedPath) return;
      h.onList = null;
      fs.writeFileSync(path.join(name, "arrived.js"), "arrived during enumeration");
    };
    const configBefore = fs.readFileSync(getConfigPath());
    await expect(captureRepositoryExtensionForSync(installed, stage("changed-read"))).rejects.toThrow(/changed/i);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.existsSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"))).toBe(false);
  });

  it.each(["add", "edit", "metadata"])("rejects a source %s during asynchronous ZIP writing before yielding upload bytes", async (change) => {
    const installed = await unpacked();
    const promise = captureRepositoryExtensionForSync(installed, stage("changed-writing"));
    const mutation = new Promise<void>((resolve) => setImmediate(() => {
      if (change === "add") fs.writeFileSync(path.join(installed.unpackedPath, "late.js"), "late arrival");
      if (change === "edit") fs.writeFileSync(path.join(installed.unpackedPath, "nested", "sentinel.bin"), Buffer.from("edited after prepass"));
      if (change === "metadata") setRepositoryExtensionMeta(installed.id, { tags: ["changed-during-capture"] });
      resolve();
    }));
    await expect(promise).rejects.toThrow(/changed|match/i);
    await mutation;
    expect(fs.existsSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"))).toBe(false);
    expect(getRepositoryExtension(installed.id)?.packageHash).toBe(installed.manifestHash);
  });

  it("rejects pre-aborted and in-flight cancelled captures without local publication", async () => {
    const installed = await unpacked();
    const before = beforeCapture(installed);
    const first = new AbortController(); first.abort();
    await expect(captureRepositoryExtensionForSync(installed, stage("pre-aborted"), first.signal)).rejects.toThrow(/cancelled/i);
    expect(fs.existsSync(stage("pre-aborted"))).toBe(false);
    const second = new AbortController();
    const promise = captureRepositoryExtensionForSync(installed, stage("cancel-writing"), second.signal);
    setImmediate(() => second.abort());
    await expect(promise).rejects.toThrow(/cancelled/i);
    assertUnchanged(installed, before);
  });

  it("rejects oversized individual files before reading payloads or producing a package", async () => {
    const installed = await unpacked();
    const huge = path.join(installed.unpackedPath, "oversized.bin");
    fs.closeSync(fs.openSync(huge, "wx"));
    fs.truncateSync(huge, 50 * 1024 * 1024 + 1); // sparse; no large fixture allocation
    h.reads = [];
    await expect(captureRepositoryExtensionForSync(installed, stage("oversized"))).rejects.toThrow(/size limits/i);
    expect(h.reads).not.toContain(huge);
    expect(fs.existsSync(stage("oversized"))).toBe(false);
  });

  it("rejects staging reuse and repository-internal staging without overwriting anything", async () => {
    const installed = await unpacked();
    const existing = stage("already-owned"); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, "marker"), "keep");
    await expect(captureRepositoryExtensionForSync(installed, existing)).rejects.toThrow(/already exists/i);
    expect(fs.readFileSync(path.join(existing, "marker"), "utf8")).toBe("keep");
    const inside = path.join(getExtensionRepoEntryDir(installed.id), "capture");
    await expect(captureRepositoryExtensionForSync(installed, inside)).rejects.toThrow(/outside the repository/i);
    expect(fs.existsSync(inside)).toBe(false);
  });

  it("rejects repository-internal staging through the OS temporary-directory alias as well", async () => {
    const installed = await unpacked();
    const repository = getExtensionRepoEntryDir(installed.id);
    const aliased = path.join(fs.realpathSync(repository), "capture");
    await expect(captureRepositoryExtensionForSync(installed, aliased)).rejects.toThrow(/outside the repository/i);
    expect(fs.existsSync(path.join(repository, "capture"))).toBe(false);
  });

  it.each(["capture", "repair", "repair-prepublish"])("retains foreign pending recovery receipts and original bytes during %s", async (phase) => {
    const installed = await unpacked();
    const snapshot = phase === "capture" ? null : await captureRepositoryExtensionForSync(installed, stage("recovery"));
    const rescue = path.join(getExtensionRepoEntryDir(installed.id), ".update-foreign-recovery");
    const plant = () => {
      fs.mkdirSync(rescue);
      fs.writeFileSync(path.join(rescue, "receipt.json"), JSON.stringify({ version: 1, extensionId: installed.id, state: "pending" }));
      fs.writeFileSync(path.join(rescue, "original-sentinel"), "retained rescue data, never auto-clean");
    };
    if (phase !== "repair-prepublish") plant();
    else h.onCopy = (destination) => { if (destination.endsWith(path.sep + "package.new")) { h.onCopy = null; plant(); } };
    const before = beforeCapture(installed);
    if (phase === "capture") await expect(captureRepositoryExtensionForSync(installed, stage("blocked"))).rejects.toMatchObject({ code: "EXTENSION_REPOSITORY_RECOVERY_REQUIRED" });
    else await expect(snapshot!.commitLocalRepair!()).rejects.toMatchObject({ code: "EXTENSION_REPOSITORY_RECOVERY_REQUIRED" });
    expect(fs.readFileSync(path.join(rescue, "original-sentinel"), "utf8")).toBe("retained rescue data, never auto-clean");
    expect(fs.readFileSync(getConfigPath())).toEqual(before.config);
    expect(fs.readFileSync(path.join(installed.unpackedPath, "worker.js"), "utf8")).toBe(WORKER);
    expect(fs.existsSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"))).toBe(false);
    if (phase !== "repair-prepublish") assertUnchanged(installed, before);
  });

  it("does not capture stale caller metadata after a live edit", async () => {
    const installed = await unpacked();
    setRepositoryExtensionMeta(installed.id, { tags: ["live-tag"] });
    await expect(captureRepositoryExtensionForSync(installed, stage("stale"))).rejects.toThrow(/metadata/i);
  });

  it("keeps the repair's private hashes/metadata independent from mutations of the returned snapshot entry", async () => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("detached"));
    const original = structuredClone(snapshot.entry);
    snapshot.entry.packageHash = "0".repeat(128); snapshot.entry.tags.push("caller-mutated");
    const repaired = await snapshot.commitLocalRepair!();
    expect(repaired?.packageHash).toBe(original.packageHash);
    expect(repaired?.tags).toEqual(original.tags);
    expect(disk().extensionRepository[installed.id]).toEqual({ ...original, unpackedPath: installed.unpackedPath });
  });

  it("revalidates pinned package bytes before post-publish repair", async () => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("tampered"));
    fs.chmodSync(snapshot.packagePath, 0o600);
    fs.writeFileSync(snapshot.packagePath, "caller tampered with its staging file");
    const before = beforeCapture(installed);
    await expect(snapshot.commitLocalRepair!()).rejects.toThrow(/package|small/i);
    assertUnchanged(installed, before);
  });

  it.each(["metadata", "file", "delete"])("checks %s again after repair preparation and preserves a divergence before publication", async (change) => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("guard"));
    h.onCopy = (destination) => {
      if (!destination.endsWith(path.sep + "package.new")) return;
      h.onCopy = null;
      if (change === "metadata") transact((draft) => { draft.extensionRepository[installed.id].tags = ["edited-during-repair"]; });
      if (change === "file") fs.writeFileSync(path.join(installed.unpackedPath, "worker.js"), "file edited during repair preparation");
      if (change === "delete") transact((draft) => { delete draft.extensionRepository[installed.id]; });
    };
    expect(await snapshot.commitLocalRepair!()).toBeNull();
    expect(fs.existsSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"))).toBe(false);
    expect(fs.readdirSync(getExtensionRepoEntryDir(installed.id))).toEqual(["current"]);
    if (change === "metadata") expect(disk().extensionRepository[installed.id].tags).toEqual(["edited-during-repair"]);
    if (change === "file") expect(fs.readFileSync(path.join(installed.unpackedPath, "worker.js"), "utf8")).toBe("file edited during repair preparation");
    if (change === "delete") expect(disk().extensionRepository[installed.id]).toBeUndefined();
  });

  it("uses a conditional live transaction even when metadata changes during directory publication", async () => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("late-cas"));
    h.onRename = (destination) => {
      if (destination !== installed.unpackedPath) return;
      h.onRename = null;
      transact((draft) => { draft.extensionRepository[installed.id].tags = ["last-moment-edit"]; });
    };
    expect(await snapshot.commitLocalRepair!()).toBeNull();
    expect(disk().extensionRepository[installed.id].tags).toEqual(["last-moment-edit"]);
    expect(fs.readFileSync(path.join(installed.unpackedPath, "worker.js"), "utf8")).toBe(WORKER);
    expect(fs.existsSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"))).toBe(false);
    expect(fs.readdirSync(getExtensionRepoEntryDir(installed.id))).toEqual(["current"]);
  });

  it.each(["edit", "remove"])("preserves a source file %s between the final guard and the original directory backup move", async (change) => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("late-file"));
    const configBefore = fs.readFileSync(getConfigPath());
    const worker = path.join(installed.unpackedPath, "worker.js");
    h.onRename = (destination) => {
      if (!destination.endsWith(path.sep + "current.backup")) return;
      h.onRename = null;
      if (change === "edit") fs.writeFileSync(worker, "last-moment live source edit");
      else fs.unlinkSync(worker);
    };
    expect(await snapshot.commitLocalRepair!()).toBeNull();
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    if (change === "edit") expect(fs.readFileSync(worker, "utf8")).toBe("last-moment live source edit");
    else expect(fs.existsSync(worker)).toBe(false);
    expect(fs.existsSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip"))).toBe(false);
  });

  it("surfaces an actual repair commit failure, compensates safely, and leaves the original metadata/files unchanged", async () => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("commit-failure"));
    const before = beforeCapture(installed);
    h.failRename = getConfigPath();
    await expect(snapshot.commitLocalRepair!()).rejects.toThrow(/EIO/i);
    assertUnchanged(installed, before);
    assertStored(disk().extensionRepository[installed.id]);
    expect(fs.readdirSync(getExtensionRepoEntryDir(installed.id))).toEqual(["current"]);
  });

  it("returns committed cleanup warnings only as transient facts and keeps repaired durable data searchable", async () => {
    const installed = await unpacked();
    const snapshot = await captureRepositoryExtensionForSync(installed, stage("cleanup-warning"));
    h.failRemoveBackup = true;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repaired = await snapshot.commitLocalRepair!();
    expect(repaired?.repositoryCommit).toMatchObject({ committed: true, cleanupWarnings: [{ code: "EXTENSION_REPOSITORY_CLEANUP_FAILED" }] });
    const warning = repaired!.repositoryCommit.cleanupWarnings[0];
    expect(warning.message).toMatch(/EACCES/);
    expect(fs.existsSync(warning.path)).toBe(true);
    const stored = disk().extensionRepository[installed.id];
    expect(stored).toEqual({ ...snapshot.entry, unpackedPath: installed.unpackedPath });
    expect(stored).not.toHaveProperty("repositoryCommit");
    assertStored(stored);
    expect(sha(fs.readFileSync(path.join(getExtensionRepoEntryDir(installed.id), "package.zip")))).toBe(stored.packageHash);
  });
});
