import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "storage-monitor-"));
  return {
    root,
    appDataDir: path.join(root, "app-data"),
    forbidden: vi.fn((...args: unknown[]) => { throw new Error(`Undeclared native capability: ${String(args[0])}`); }),
  };
});
vi.mock("electron", () => ({
  app: { getPath: (name: string) => name === "userData" ? h.appDataDir : h.forbidden(name) },
}));
// Only OS boundaries are replaced. Config/profile enumeration and all fixture
// file operations remain real; metadata spies pass through unless declared below.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs), stat: vi.fn(actual.stat) };
});
vi.mock("node:child_process", () => ({
  exec: h.forbidden, execSync: h.forbidden, execFile: h.forbidden, execFileSync: h.forbidden,
  spawn: h.forbidden, spawnSync: h.forbidden, fork: h.forbidden,
}));

import { getAppDataDir, getProfilesDir, reloadConfig } from "../../src/main/services/config-manager.js";
import { storageMonitor } from "../../src/main/services/storage-monitor.js";

const statfs = vi.mocked(fsPromises.statfs);
const stat = vi.mocked(fsPromises.stat);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function metadata(overrides: Record<string, unknown> = {}): fs.BigIntStatsFs {
  return { type: 0n, bsize: 4096n, blocks: 100n, bfree: 40n, bavail: 25n, files: 1000n, ffree: 900n, ...overrides } as fs.BigIntStatsFs;
}
function expectSelectedQuery(target = getProfilesDir(), count = 1): void {
  expect(statfs).toHaveBeenCalledTimes(count);
  for (const args of statfs.mock.calls) expect(args).toEqual([target, { bigint: true }]);
}

beforeEach(() => {
  h.forbidden.mockClear();
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.mkdirSync(getProfilesDir(), { recursive: true });
  reloadConfig();
  statfs.mockReset().mockImplementation(fs.promises.statfs);
  stat.mockReset().mockImplementation(fs.promises.stat);
});
afterEach(() => { expect(h.forbidden).not.toHaveBeenCalled(); });
afterAll(() => fs.rmSync(h.root, { recursive: true, force: true }));

describe("configured-storage filesystem capacity", () => {
  it("queries the selected profile filesystem in bytes, never cwd or a global drive command", async () => {
    statfs.mockResolvedValue(metadata({ bsize: 512n, blocks: 20n, bfree: 5n, bavail: 3n }));
    expect(await storageMonitor.getAvailableDiskSpace()).toBe(1536);
    expectSelectedQuery();
  });

  it("uses one coherent metadata snapshot for available bytes and usage, excluding reserved blocks", async () => {
    statfs.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(metadata({ bavail: 0n }));
    expect(await storageMonitor.getInfo()).toEqual({
      profiles: [], totalProfileBytes: 0, availableDiskBytes: 25 * 4096, diskUsagePercent: 75,
    });
    expectSelectedQuery();
    expect(stat).toHaveBeenCalledTimes(2);
    for (const args of stat.mock.calls) expect(args).toEqual([getProfilesDir(), { bigint: true }]);
    expect(await storageMonitor.getAvailableDiskSpace()).toBe(0);
    expectSelectedQuery(getProfilesDir(), 2);
  });

  it("reads real statfs metadata and small persisted profile bytes under its owned root", async () => {
    const profileDir = path.join(getProfilesDir(), "owned_capacity");
    fs.mkdirSync(profileDir);
    const file = path.join(profileDir, "keep");
    const payload = Buffer.from("owned capacity readback");
    fs.writeFileSync(file, payload);
    expect(fs.readFileSync(file)).toEqual(payload);
    expect(fs.statSync(file).size).toBe(payload.length);

    const info = await storageMonitor.getInfo();
    expectSelectedQuery();
    const snapshot = await statfs.mock.results[0].value as fs.BigIntStatsFs;
    expect(info.availableDiskBytes).toBe(Number(snapshot.bsize * snapshot.bavail));
    expect(info.diskUsagePercent).toBe(Math.round(Number(snapshot.blocks - snapshot.bavail) / Number(snapshot.blocks) * 100));
    expect(info.totalProfileBytes).toBe(payload.length);
    expect(info.profiles).toEqual([expect.objectContaining({ dirId: "owned_capacity", sizeBytes: payload.length })]);
    // Independent real metadata/file readback, without comparing fluctuating free
    // space across queries on a filesystem shared with unrelated processes.
    const readback = await fs.promises.statfs(getProfilesDir(), { bigint: true });
    expect(readback.bsize).toBeGreaterThan(0n);
    expect(readback.bavail).toBeGreaterThanOrEqual(0n);
    expect(readback.bavail).toBeLessThanOrEqual(readback.blocks);
    expect(fs.readFileSync(file)).toEqual(payload);
  });

  it.each([0n, MAX_SAFE])("accepts exact safe-integer bytes with %s available blocks", async (available) => {
    statfs.mockResolvedValue(metadata({ bsize: 1n, blocks: MAX_SAFE, bfree: MAX_SAFE, bavail: available }));
    const info = await storageMonitor.getInfo();
    expect(info.availableDiskBytes).toBe(Number(available));
    expect(info.diskUsagePercent).toBe(available === 0n ? 100 : 0);
    expectSelectedQuery();
  });

  const invalidMetadata: Array<[string, unknown]> = [
    ["missing result", undefined],
    ["null result", null],
    ["textual drive columns", "DeviceID FreeSpace Size\r\nD: 1536 10240\r\n"],
    ["non-BigInt block size", metadata({ bsize: 4096 })],
    ["missing block size", metadata({ bsize: undefined })],
    ["zero block size", metadata({ bsize: 0n })],
    ["negative block size", metadata({ bsize: -1n })],
    ["non-BigInt total blocks", metadata({ blocks: 100 })],
    ["missing total blocks", metadata({ blocks: undefined })],
    ["zero total blocks", metadata({ blocks: 0n, bfree: 0n, bavail: 0n })],
    ["negative total blocks", metadata({ blocks: -1n })],
    ["non-BigInt free blocks", metadata({ bfree: 40 })],
    ["negative free blocks", metadata({ bfree: -1n })],
    ["free blocks exceed total", metadata({ bfree: 101n })],
    ["non-BigInt available blocks", metadata({ bavail: 25 })],
    ["NaN available blocks", metadata({ bavail: Number.NaN })],
    ["missing available blocks", metadata({ bavail: undefined })],
    ["negative available blocks", metadata({ bavail: -1n })],
    ["available blocks exceed total", metadata({ bavail: 101n })],
    ["available blocks exceed free", metadata({ bavail: 41n })],
    ["total byte multiplication overflows safe integers", metadata({ blocks: MAX_SAFE })],
    ["block size overflows safe integers", metadata({ bsize: MAX_SAFE + 1n, blocks: 1n, bfree: 0n, bavail: 0n })],
    ["one byte above the safe integer limit", metadata({ bsize: 1n, blocks: MAX_SAFE + 1n, bfree: MAX_SAFE + 1n, bavail: MAX_SAFE + 1n })],
  ];
  it.each(invalidMetadata)("rejects %s without inventing capacity", async (_label, value) => {
    statfs.mockResolvedValue(value as fs.BigIntStatsFs);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toThrow(/filesystem capacity|safe integer/i);
    await expect(storageMonitor.getInfo()).rejects.toThrow(/filesystem capacity|safe integer/i);
    expectSelectedQuery(getProfilesDir(), 2);
  });

  it.each(["ENOSYS", "ENOTSUP", "EACCES", "EIO", "ENOENT"])("propagates statfs %s without querying another disk", async (code) => {
    const error = Object.assign(new Error(`fixture statfs ${code}`), { code });
    statfs.mockRejectedValue(error);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toBe(error);
    await expect(storageMonitor.getInfo()).rejects.toBe(error);
    expectSelectedQuery(getProfilesDir(), 2);
  });

  it("reports unavailable for an absent configured profile directory without querying app-data or creating it", async () => {
    fs.rmdirSync(getProfilesDir());
    expect(getAppDataDir()).toBe(h.appDataDir);
    expect(fs.statSync(getAppDataDir()).isDirectory()).toBe(true);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storageMonitor.getInfo()).rejects.toMatchObject({ code: "ENOENT" });
    expect(statfs).not.toHaveBeenCalled();
    expect(fs.existsSync(getProfilesDir())).toBe(false);
  });

  it("does not mistake an empty surviving app-data mountpoint for the lost profile volume", async () => {
    // An owned empty directory models the mountpoint left behind after unmount;
    // this test does not mount/unmount volumes or claim historical UUID proof.
    fs.rmSync(getAppDataDir(), { recursive: true });
    fs.mkdirSync(getAppDataDir());
    expect(fs.readdirSync(getAppDataDir())).toEqual([]);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storageMonitor.getInfo()).rejects.toMatchObject({ code: "ENOENT" });
    expect(statfs).not.toHaveBeenCalled();
    expect(fs.readdirSync(getAppDataDir())).toEqual([]);
  });

  it.each(["getAvailableDiskSpace", "getInfo"] as const)("%s rejects ordinary directory replacement during statfs", async (method) => {
    const original = path.join(h.root, "original-profiles");
    const sentinel = "owned profile directory before replacement";
    fs.writeFileSync(path.join(getProfilesDir(), "keep"), sentinel);
    statfs.mockImplementationOnce(async (target, options) => {
      const snapshot = await fs.promises.statfs(target, options);
      fs.renameSync(getProfilesDir(), original);
      fs.mkdirSync(getProfilesDir());
      return snapshot;
    });
    await expect(storageMonitor[method]()).rejects.toThrow("Configured storage directory changed during filesystem capacity query");
    expectSelectedQuery();
    expect(stat).toHaveBeenCalledTimes(2);
    for (const args of stat.mock.calls) expect(args).toEqual([getProfilesDir(), { bigint: true }]);
    const before = await stat.mock.results[0].value as fs.BigIntStats;
    const after = await stat.mock.results[1].value as fs.BigIntStats;
    expect(before.ino).not.toBe(after.ino);
    expect(fs.readFileSync(path.join(original, "keep"), "utf8")).toBe(sentinel);
    expect(fs.readdirSync(getProfilesDir())).toEqual([]);
  });

  it.each(["dev", "ino"] as const)("compares %s identity as BigInt without unsafe-number aliasing", async (field) => {
    const actual = await fs.promises.stat(getProfilesDir(), { bigint: true });
    const before = { ...actual, [field]: MAX_SAFE + 1n };
    const after = { ...before, [field]: MAX_SAFE + 2n };
    expect(Number(before[field])).toBe(Number(after[field]));
    stat.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toThrow("Configured storage directory changed during filesystem capacity query");
    expectSelectedQuery();
    expect(stat).toHaveBeenCalledTimes(2);
    for (const args of stat.mock.calls) expect(args).toEqual([getProfilesDir(), { bigint: true }]);
  });

  it("rejects a directory replaced by a file during statfs and conserves both owned paths", async () => {
    const original = path.join(h.root, "original-profiles");
    fs.writeFileSync(path.join(getProfilesDir(), "keep"), "original");
    statfs.mockImplementationOnce(async (target, options) => {
      const snapshot = await fs.promises.statfs(target, options);
      fs.renameSync(getProfilesDir(), original);
      fs.writeFileSync(getProfilesDir(), "replacement");
      return snapshot;
    });
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toThrow("Configured storage path is not a directory");
    expectSelectedQuery();
    expect(stat).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(original, "keep"), "utf8")).toBe("original");
    expect(fs.readFileSync(getProfilesDir(), "utf8")).toBe("replacement");
  });

  it("fails closed when app-data and profiles are missing even though their parent exists", async () => {
    fs.rmSync(getAppDataDir(), { recursive: true });
    expect(fs.statSync(h.root).isDirectory()).toBe(true);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storageMonitor.getInfo()).rejects.toMatchObject({ code: "ENOENT" });
    expect(statfs).not.toHaveBeenCalled();
    expect(fs.existsSync(getAppDataDir())).toBe(false);
  });

  it.each(["profiles", "app-data"])("refuses a dangling %s link rather than reporting the internal parent disk", async (leaf) => {
    const link = leaf === "profiles" ? getProfilesDir() : getAppDataDir();
    fs.rmSync(link, { recursive: true });
    // The link and its absent target are both owned; no external test symlinks.
    const target = path.join(h.root, "absent-volume", leaf);
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(link)).toBe(false);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storageMonitor.getInfo()).rejects.toMatchObject({ code: "ENOENT" });
    expect(statfs).not.toHaveBeenCalled();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("queries an existing owned profile-directory link itself, not the app-data filesystem", async () => {
    fs.rmdirSync(getProfilesDir());
    const target = path.join(h.root, "owned-volume");
    fs.mkdirSync(target);
    fs.symlinkSync(target, getProfilesDir(), process.platform === "win32" ? "junction" : "dir");
    const info = await storageMonitor.getInfo();
    expectSelectedQuery();
    const snapshot = await statfs.mock.results[0].value as fs.BigIntStatsFs;
    expect(info.availableDiskBytes).toBe(Number(snapshot.bsize * snapshot.bavail));
  });

  it.each(["EACCES", "EIO", "ENOTDIR"])("propagates configured-directory stat %s without a fallback query", async (code) => {
    const error = Object.assign(new Error(`fixture profile stat ${code}`), { code });
    stat.mockRejectedValue(error);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toBe(error);
    expect(statfs).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledExactlyOnceWith(getProfilesDir(), { bigint: true });
  });

  it("does not report capacity if the selected directory disappears after statfs", async () => {
    const error = Object.assign(new Error("fixture removed selected volume"), { code: "ENOENT" });
    const before = await fs.promises.stat(getProfilesDir(), { bigint: true });
    stat.mockResolvedValueOnce(before).mockRejectedValueOnce(error);
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toBe(error);
    expect(stat).toHaveBeenCalledTimes(2);
    for (const args of stat.mock.calls) expect(args).toEqual([getProfilesDir(), { bigint: true }]);
    expectSelectedQuery();
  });

  it("rejects a non-directory profile root without querying its parent filesystem", async () => {
    fs.rmdirSync(getProfilesDir());
    fs.writeFileSync(getProfilesDir(), "not a directory");
    await expect(storageMonitor.getAvailableDiskSpace()).rejects.toThrow(/storage.*directory/i);
    expect(statfs).not.toHaveBeenCalled();
    expect(fs.readFileSync(getProfilesDir(), "utf8")).toBe("not a directory");
  });
});
