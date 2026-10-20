// R1/F09: real isolated files and real restore locks; no app/browser launch.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "profile-mutation-lock-f09-")),
    discover: vi.fn<() => Promise<Array<{ pid: number; args: string }>>>(),
    findBrowser: vi.fn(),
    observe: null as null | ((operation: string, from: string, to?: string) => void),
    failConfigRename: false,
    failAsyncRm: false,
  };
});

// Observe actual mutation boundaries and inject only one scoped config/rm
// failure. All profile, index, config, and lock bytes remain real filesystem I/O.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: any, to: any) => {
      if (String(from).startsWith(h.root + path.sep) && String(to).startsWith(h.root + path.sep)) {
        h.observe?.("rename", String(from), String(to));
        if (h.failConfigRename && String(to) === path.join(h.root, "config.json")) {
          h.failConfigRename = false;
          throw Object.assign(new Error("EIO: scoped config rename failure"), { code: "EIO" });
        }
      }
      return actual.renameSync(from, to);
    },
    rmSync: (file: any, ...args: any[]) => {
      if (String(file).startsWith(h.root + path.sep)) h.observe?.("rm", String(file));
      return (actual.rmSync as any)(file, ...args);
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (file: any, ...args: any[]) => {
      if (String(file).startsWith(h.root + path.sep)) {
        h.observe?.("rm-async", String(file));
        if (h.failAsyncRm) {
          h.failAsyncRm = false;
          throw Object.assign(new Error("EIO: scoped async removal failure"), { code: "EIO" });
        }
      }
      return (actual.rm as any)(file, ...args);
    },
  };
});
vi.mock("electron", () => ({
  app: { getPath: (_name: string) => h.root },
  BrowserWindow: { getAllWindows: () => [] },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  getRunningProcessesAsync: h.discover,
  findBrowserByProfileSync: h.findBrowser,
}));

import { getConfig, getConfigPath, getProfileMeta, reloadConfig } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import { acquireRestoreLock, isRestoreLocked, assertProfileTransferStopped } from "../../src/main/services/profile-restore-lock.js";
import {
  deleteBrowserProfile, trashBrowserProfile, restoreTrashedProfile, purgeTrashedProfile, purgeExpiredTrash,
} from "../../src/main/services/browser-manager.js";
import { deleteProfile } from "../../src/main/services/profile-manager.js";

const ROOT = h.root;
const ID = "restore_lock_profile";
const OTHER = "restore_lock_other";
const INDEX = path.join(ROOT, "trash", "index.json");
const LIVE = path.join(ROOT, "profiles", ID);
const TRASH = path.join(ROOT, "trash", "profiles", ID);
const LOCK = path.join(ROOT, "locks", `${ID}.restore.lock`);
const releases: Array<() => void> = [];
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const index = () => JSON.parse(fs.readFileSync(INDEX, "utf8"));
const content = Buffer.from([0, 255, 1, 13, 10, 128, 42]);

function trackRelease(release: () => void): () => void {
  let active = true;
  const once = () => { if (active) { active = false; release(); } };
  releases.push(once);
  return once;
}
function holdSourceLock(kind: "export" | "external-restore"): () => void {
  if (kind === "export") return trackRelease(acquireRestoreLock(ID));
  // A live owner with no entry in this module's heldLocks map exercises the
  // actual O_EXCL on-disk contention path used by a different admitted writer.
  fs.mkdirSync(path.dirname(LOCK), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(LOCK, "wx", 0o600);
  const text = JSON.stringify({ pid: process.pid, dirId: ID, token: "owned-external-restore", createdAt: new Date().toISOString() });
  fs.writeFileSync(fd, text);
  return trackRelease(() => {
    fs.closeSync(fd);
    if (fs.readFileSync(LOCK, "utf8") !== text) throw new Error("Source restore lock ownership changed");
    fs.unlinkSync(LOCK);
  });
}
function seedLive(): void {
  fs.mkdirSync(path.join(LIVE, "Default", "nested"), { recursive: true });
  fs.writeFileSync(path.join(LIVE, "Default", "sentinel.bin"), content);
  fs.writeFileSync(path.join(LIVE, "Default", "nested", "second.txt"), "complete original profile bytes");
  transact((draft) => {
    draft.browserProfiles[ID] = {
      name: "Restore lock sentinel", engine: "chromium", fingerprintSeed: 12345,
      platform: "windows", proxyMode: "none", note: "synthetic metadata", createdAt: 42,
    };
    draft.browserProfiles[OTHER] = { name: "Unrelated profile", engine: "chromium", fingerprintSeed: 23456, proxyMode: "none" };
    draft.automationNotify = { system: true, sound: false };
  });
  fs.mkdirSync(path.dirname(INDEX), { recursive: true });
  fs.writeFileSync(INDEX, "[]\n");
}
function dataSnapshot(): Array<{ file: string; sha256: string }> {
  const rows: Array<{ file: string; sha256: string }> = [];
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (directory === ROOT && !["config.json", "profiles", "trash"].includes(name)) continue;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Fixture digest refuses symlinks");
      if (stat.isDirectory()) walk(file);
      else rows.push({ file: path.relative(ROOT, file), sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
    }
  };
  walk(ROOT);
  return rows;
}
function assertSourceLockUnchanged(bytes: Buffer): void {
  expect(isRestoreLocked(ID)).toBe(true);
  expect(fs.readFileSync(LOCK)).toEqual(bytes);
  expect(() => acquireRestoreLock(ID)).toThrow(/Restore already in progress/);
  expect(fs.readFileSync(LOCK)).toEqual(bytes);
}
const synchronousMutations = [
  { name: "hard delete", trashed: false, run: () => deleteBrowserProfile(ID) },
  { name: "trash", trashed: false, run: () => trashBrowserProfile(ID) },
  { name: "restore from trash", trashed: true, run: () => restoreTrashedProfile(ID) },
  { name: "manual purge", trashed: true, run: () => purgeTrashedProfile(ID) },
  { name: "expired purge", trashed: true, run: () => purgeExpiredTrash(1) },
];
function prepareMutation(trashed: boolean): void {
  seedLive();
  if (trashed) {
    expect(trashBrowserProfile(ID)).toBe(true);
    fs.writeFileSync(INDEX, JSON.stringify(index().map((entry: any) => ({ ...entry, deletedAt: 1 }))));
  }
}
function assertLegitimateResult(name: string): void {
  const live = name === "restore from trash";
  const trashed = name === "trash";
  expect(fs.existsSync(LIVE)).toBe(live);
  expect(fs.existsSync(TRASH)).toBe(trashed);
  if (live || trashed) expect(fs.readFileSync(path.join(live ? LIVE : TRASH, "Default", "sentinel.bin"))).toEqual(content);
  expect(Object.hasOwn(disk().browserProfiles, ID)).toBe(live);
  expect(index().some((entry: any) => entry.dirId === ID)).toBe(trashed);
  reloadConfig();
  expect(Boolean(getProfileMeta(ID))).toBe(live);
  expect(getProfileMeta(OTHER)?.name).toBe("Unrelated profile");
  expect(getConfig().automationNotify).toEqual({ system: true, sound: false });
  expect(isRestoreLocked(ID)).toBe(false);
  expect(fs.existsSync(LOCK)).toBe(false);
}

beforeEach(() => {
  h.observe = null;
  h.failConfigRename = false;
  h.failAsyncRm = false;
  h.discover.mockReset(); h.discover.mockResolvedValue([]);
  h.findBrowser.mockReset(); h.findBrowser.mockReturnValue(null);
  for (const name of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  reloadConfig(); getConfig();
});
afterEach(() => {
  h.observe = null;
  h.failConfigRename = false;
  h.failAsyncRm = false;
  for (const release of releases.splice(0)) release();
});
afterAll(() => {
  if (path.dirname(ROOT) !== os.tmpdir() || !path.basename(ROOT).startsWith("profile-mutation-lock-f09-")) throw new Error("Unsafe fixture cleanup root");
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("confirmed-stopped transfer gates and active restore-lock owners", () => {
  it.each([
    { running: true, pid: null }, { running: false, pid: 1234 }, { running: false },
    { running: false, pid: null, stopping: true }, { running: false, pid: null, state: "unknown" },
    { running: false, pid: null, unknown: true },
  ])("does not certify stopped from $running / $pid / $state", (status) => {
    expect(() => assertProfileTransferStopped(ID, () => status)).toThrow(/wait for browser exit/);
  });
  it("accepts only a confirmed stopped status and treats discovery failures as stop-required", () => {
    expect(() => assertProfileTransferStopped(ID, () => ({ running: false, pid: null }))).not.toThrow();
    expect(() => assertProfileTransferStopped(ID, () => { throw new Error("synthetic discovery failure"); })).toThrow(/discovery or lock inspection failed/);
    expect(() => assertProfileTransferStopped(ID, () => ({ running: false, pid: null }), () => { throw new Error("synthetic runtime discovery failure"); })).toThrow(/discovery or lock inspection failed/);
  });
  it.each(["SingletonLock", "SingletonCookie", "SingletonSocket", "parent.lock", ".parentlock", "lock"])("detects dangling %s without following or deleting it", (name) => {
    fs.mkdirSync(LIVE, { recursive: true });
    const marker = path.join(LIVE, name);
    fs.symlinkSync(path.join(ROOT, "owned-missing-target"), marker);
    expect(fs.existsSync(marker)).toBe(false);
    expect(() => assertProfileTransferStopped(ID, () => ({ running: false, pid: null }))).toThrow(/lock marker present/);
    expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
  });
  it.each([".parentlock", "parent.lock"])("keeps configured Firefox's unchanged empty regular %s after two stopped checks, without calling crash data clean", (name) => {
    seedLive(); transact((draft) => { draft.browserProfiles[ID].engine = "firefox"; });
    const marker = path.join(LIVE, name); fs.writeFileSync(marker, Buffer.alloc(0), { mode: 0o600 });
    const before = fs.lstatSync(marker), bytes = fs.readFileSync(marker);
    const status = vi.fn(() => ({ running: false, pid: null }));
    const release = acquireRestoreLock(ID);
    try { expect(() => assertProfileTransferStopped(ID, status, undefined, { engine: getProfileMeta(ID)?.engine })).not.toThrow(); }
    finally { release(); }
    expect(status).toHaveBeenCalledTimes(2);
    const after = fs.lstatSync(marker);
    expect(fs.readFileSync(marker)).toEqual(bytes);
    expect([after.dev, after.ino, after.mode, after.nlink, after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.dev, before.ino, before.mode, before.nlink, before.size, before.mtimeMs, before.ctimeMs]);
  });
  it.each([undefined, "chromium", "unknown"])("does not permit an empty Firefox-named sentinel for engine %s", (engine) => {
    seedLive(); const marker = path.join(LIVE, ".parentlock"); fs.writeFileSync(marker, "");
    expect(() => assertProfileTransferStopped(ID, () => ({ running: false, pid: null }), undefined, { engine } as any)).toThrow(/lock marker present/);
    expect(fs.readFileSync(marker)).toEqual(Buffer.alloc(0));
  });
  it.each(["SingletonLock", "SingletonCookie", "SingletonSocket", "lock"])("keeps %s strict even for configured Firefox", (name) => {
    seedLive(); const marker = path.join(LIVE, name); fs.writeFileSync(marker, "");
    expect(() => assertProfileTransferStopped(ID, () => ({ running: false, pid: null }), undefined, { engine: "firefox" })).toThrow(/lock marker present/);
    expect(fs.existsSync(marker)).toBe(true);
  });
  it.each(["nonempty", "directory", "hardlink", "symlink", "dangling-symlink"])("refuses Firefox sentinel boundary %s without deleting or following it", (kind) => {
    seedLive(); const marker = path.join(LIVE, ".parentlock"), target = path.join(ROOT, "owned-sentinel-target");
    if (kind === "directory") fs.mkdirSync(marker);
    else if (kind === "symlink" || kind === "dangling-symlink") {
      if (kind === "symlink") fs.writeFileSync(target, "untouched-owned-target");
      fs.symlinkSync(target, marker);
    } else {
      fs.writeFileSync(marker, kind === "nonempty" ? "busy" : "");
      if (kind === "hardlink") fs.linkSync(marker, target);
    }
    expect(() => assertProfileTransferStopped(ID, () => ({ running: false, pid: null }), undefined, { engine: "firefox" })).toThrow(/lock marker present/);
    expect(fs.lstatSync(marker)).toBeDefined();
    if (kind === "symlink") expect(fs.readFileSync(target, "utf8")).toBe("untouched-owned-target");
  });
  it.each(["content", "inode", "link-count", "timestamp", "disappeared", "symlink", "profile-directory"])("refuses a Firefox sentinel changed between stopped checks: %s", (kind) => {
    seedLive(); const marker = path.join(LIVE, ".parentlock"); fs.writeFileSync(marker, "");
    const before = fs.lstatSync(marker); let checks = 0;
    const status = () => {
      if (++checks === 2) {
        if (kind === "content") fs.writeFileSync(marker, "changed");
        if (kind === "inode") { fs.renameSync(marker, marker + ".old"); fs.writeFileSync(marker, ""); }
        if (kind === "link-count") fs.linkSync(marker, path.join(ROOT, "owned-new-link"));
        if (kind === "timestamp") fs.utimesSync(marker, new Date(before.mtimeMs + 1000), new Date(before.mtimeMs + 1000));
        if (kind === "disappeared") fs.renameSync(marker, marker + ".moved");
        if (kind === "symlink") { fs.renameSync(marker, marker + ".old"); fs.symlinkSync(path.join(ROOT, "owned-missing-target"), marker); }
        if (kind === "profile-directory") {
          fs.renameSync(LIVE, LIVE + ".old"); fs.mkdirSync(LIVE); fs.renameSync(path.join(LIVE + ".old", ".parentlock"), marker);
        }
      }
      return { running: false, pid: null };
    };
    expect(() => assertProfileTransferStopped(ID, status, undefined, { engine: "firefox" })).toThrow(/changed/);
    expect(checks).toBe(2);
  });
  it.each(["unknown", "live", "discovery-error"])("does not accept inert Firefox sentinels when second stopped proof is %s", (kind) => {
    seedLive(); const marker = path.join(LIVE, "parent.lock"); fs.writeFileSync(marker, "");
    let checks = 0;
    const status = () => {
      if (++checks === 2) {
        if (kind === "discovery-error") throw new Error("Synthetic strict discovery unavailable");
        return kind === "unknown" ? { running: false, pid: null, unknown: true } : { running: true, pid: 1234 };
      }
      return { running: false, pid: null };
    };
    expect(() => assertProfileTransferStopped(ID, status, undefined, { engine: "firefox" })).toThrow(/confirmed stopped|discovery/);
    expect(fs.readFileSync(marker)).toEqual(Buffer.alloc(0));
  });

  it("never expires a live restore-lock owner solely by age", () => {
    const release = holdSourceLock("external-restore");
    const bytes = fs.readFileSync(LOCK);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(LOCK, old, old);
    expect(isRestoreLocked(ID)).toBe(true);
    expect(() => acquireRestoreLock(ID)).toThrow(/Restore already in progress/);
    expect(fs.readFileSync(LOCK)).toEqual(bytes);
    release();
  });
  it.each(["EPERM", "EIO"])("does not reclaim an owner when liveness discovery returns %s", (code) => {
    const release = holdSourceLock("external-restore");
    const bytes = fs.readFileSync(LOCK);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("synthetic liveness failure"), { code }); });
    try {
      expect(isRestoreLocked(ID)).toBe(true);
      expect(() => acquireRestoreLock(ID)).toThrow(/Restore already in progress/);
      expect(fs.readFileSync(LOCK)).toEqual(bytes);
    } finally { kill.mockRestore(); release(); }
  });
  it("an old release is idempotent and cannot close or delete a newer acquisition", () => {
    const oldRelease = acquireRestoreLock(ID);
    const oldToken = JSON.parse(fs.readFileSync(LOCK, "utf8")).token;
    oldRelease();
    const newRelease = acquireRestoreLock(ID);
    try {
      const bytes = fs.readFileSync(LOCK);
      expect(JSON.parse(bytes.toString()).token).not.toBe(oldToken);
      oldRelease(); oldRelease();
      expect(isRestoreLocked(ID)).toBe(true);
      expect(fs.readFileSync(LOCK)).toEqual(bytes);
      expect(() => acquireRestoreLock(ID)).toThrow(/Restore already in progress/);
      expect(fs.readFileSync(LOCK)).toEqual(bytes);
    } finally { newRelease(); }
    expect(isRestoreLocked(ID)).toBe(false); expect(fs.existsSync(LOCK)).toBe(false);
  });
  it("read-only inspection reports a dead owner without reclaiming its file", () => {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    const bytes = JSON.stringify({ pid: 123456, token: "dead-read-only-owned-fixture" });
    fs.writeFileSync(LOCK, bytes, { mode: 0o600 });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("synthetic dead owner"), { code: "ESRCH" }); });
    try {
      expect(isRestoreLocked(ID, { reclaimStale: false })).toBe(false);
      expect(fs.readFileSync(LOCK, "utf8")).toBe(bytes);
      expect(isRestoreLocked(ID, { reclaimStale: false })).toBe(false);
      expect(fs.readFileSync(LOCK, "utf8")).toBe(bytes);
      expect(isRestoreLocked(ID)).toBe(false);
      expect(fs.existsSync(LOCK)).toBe(false);
    } finally { kill.mockRestore(); }
  });
  it("reclaims only an ESRCH-proven dead owner", () => {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 123456, token: "dead-owned-fixture" }), { mode: 0o600 });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("synthetic dead owner"), { code: "ESRCH" }); });
    try { expect(isRestoreLocked(ID)).toBe(false); expect(fs.existsSync(LOCK)).toBe(false); }
    finally { kill.mockRestore(); }
    const release = acquireRestoreLock(ID);
    expect(isRestoreLocked(ID)).toBe(true);
    release();
    expect(fs.existsSync(LOCK)).toBe(false);
  });
  it("does not delete malformed or symlinked unknown ownership", () => {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, "{malformed", { mode: 0o600 });
    expect(isRestoreLocked(ID)).toBe(true);
    expect(() => acquireRestoreLock(ID)).toThrow(/Restore already in progress/);
    expect(fs.readFileSync(LOCK, "utf8")).toBe("{malformed");
    fs.unlinkSync(LOCK);
    const target = path.join(ROOT, "owned-lock-target.json");
    fs.writeFileSync(target, "sentinel");
    fs.symlinkSync(target, LOCK);
    expect(isRestoreLocked(ID)).toBe(true);
    expect(() => acquireRestoreLock(ID)).toThrow(/Restore already in progress/);
    expect(fs.lstatSync(LOCK).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("sentinel");
  });
});

describe.each(["export", "external-restore"] as const)("profile mutations while %s holds the restore lock", (kind) => {
  it.each(synchronousMutations)("rejects $name without changing data/config/index or the owner's lock, then works after unlock", ({ name, trashed, run }) => {
    prepareMutation(trashed);
    const before = dataSnapshot();
    const release = holdSourceLock(kind);
    const ownerBytes = fs.readFileSync(LOCK);
    expect.soft(run).toThrow(/Restore already in progress/);
    expect.soft(dataSnapshot()).toEqual(before);
    assertSourceLockUnchanged(ownerBytes);
    release();
    expect(run()).toEqual(name === "expired purge" ? [ID] : true);
    assertLegitimateResult(name);
  });

  it("rejects the direct async ProfileManager deletion before discovery and preserves the source lock", async () => {
    prepareMutation(false);
    const before = dataSnapshot();
    const release = holdSourceLock(kind);
    const ownerBytes = fs.readFileSync(LOCK);
    await expect.soft(deleteProfile(ID)).rejects.toThrow(/Restore already in progress/);
    expect.soft(h.discover).not.toHaveBeenCalled();
    expect.soft(dataSnapshot()).toEqual(before);
    assertSourceLockUnchanged(ownerBytes);
    release();
    expect(await deleteProfile(ID)).toBe(true);
    assertLegitimateResult("direct delete");
  });
});

describe("profile mutation lock ownership and release", () => {
  it.each(synchronousMutations)("owns the same lock throughout $name filesystem/config/index publication without nested locking", ({ name, trashed, run }) => {
    prepareMutation(trashed);
    const observed: Array<{ operation: string; locked: boolean; token: string | null }> = [];
    h.observe = (operation, from, to) => {
      if (from !== LIVE && from !== TRASH && to !== getConfigPath() && to !== INDEX) return;
      observed.push({ operation, locked: isRestoreLocked(ID), token: fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, "utf8")).token : null });
    };
    expect(run()).toEqual(name === "expired purge" ? [ID] : true);
    h.observe = null;
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((event) => event.locked && event.token)).toBe(true);
    expect(new Set(observed.map((event) => event.token)).size).toBe(1);
    assertLegitimateResult(name);
  });

  it("holds ownership across asynchronous discovery/removal and blocks competing browser-manager mutation", async () => {
    prepareMutation(false);
    const before = dataSnapshot();
    let resume!: (processes: Array<{ pid: number; args: string }>) => void;
    h.discover.mockImplementation(() => new Promise((resolve) => { resume = resolve; }));
    const deleting = deleteProfile(ID);
    try {
      expect.soft(isRestoreLocked(ID)).toBe(true);
      expect.soft(() => trashBrowserProfile(ID)).toThrow(/Restore already in progress/);
      expect.soft(dataSnapshot()).toEqual(before);
      const observations: boolean[] = [];
      h.observe = (operation) => { if (operation === "rm-async") observations.push(isRestoreLocked(ID)); };
      resume([]);
      await expect(deleting).resolves.toBe(true);
      expect(observations).toEqual([true]);
      assertLegitimateResult("direct delete");
    } finally {
      resume([]);
      await deleting.catch(() => undefined); // settle only this owned pending fixture operation
    }
  });

  it("releases its own lock after F09 config compensation and allows a legitimate retry", () => {
    prepareMutation(false);
    const before = dataSnapshot();
    h.failConfigRename = true;
    expect(() => trashBrowserProfile(ID)).toThrow(/EIO/);
    expect(dataSnapshot()).toEqual(before);
    expect(isRestoreLocked(ID)).toBe(false);
    expect(trashBrowserProfile(ID)).toBe(true);
    assertLegitimateResult("trash");
  });

  it("releases the async direct-delete lock after removal failure without changing data/config/index", async () => {
    prepareMutation(false);
    const before = dataSnapshot();
    h.failAsyncRm = true;
    await expect(deleteProfile(ID)).rejects.toThrow(/EIO/);
    expect(dataSnapshot()).toEqual(before);
    expect(isRestoreLocked(ID)).toBe(false);
    expect(await deleteProfile(ID)).toBe(true);
    assertLegitimateResult("direct delete");
  });

  it("expired purge isolates a locked entry while committing an unlocked expired entry", () => {
    prepareMutation(true);
    const otherTrash = path.join(ROOT, "trash", "profiles", OTHER);
    fs.mkdirSync(otherTrash, { recursive: true });
    fs.writeFileSync(path.join(otherTrash, "sentinel.bin"), content);
    transact((draft) => { delete draft.browserProfiles[OTHER]; });
    fs.writeFileSync(INDEX, JSON.stringify([...index(), { dirId: OTHER, name: OTHER, deletedAt: 1 }]));
    const originalEntry = index().find((entry: any) => entry.dirId === ID);
    const configBefore = fs.readFileSync(getConfigPath());
    const release = holdSourceLock("export");
    const ownerBytes = fs.readFileSync(LOCK);
    expect(() => purgeExpiredTrash(1)).toThrow(/1 committed purge\(s\).*Restore already in progress/s);
    expect(fs.readFileSync(path.join(TRASH, "Default", "sentinel.bin"))).toEqual(content);
    expect(index()).toEqual([originalEntry]);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.existsSync(otherTrash)).toBe(false);
    assertSourceLockUnchanged(ownerBytes);
    expect(isRestoreLocked(OTHER)).toBe(false);
    release();
    expect(purgeExpiredTrash(1)).toEqual([ID]);
  });
});
