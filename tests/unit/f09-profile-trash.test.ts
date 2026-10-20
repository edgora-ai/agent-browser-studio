// F09: real temp files, selective filesystem faults, durable config/index readback.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "studio-f09-unit-"));
const CONFIG = path.join(ROOT, "config.json");
const INDEX = path.join(ROOT, "trash", "index.json");
const LIVE = path.join(ROOT, "profiles");
const TRASH = path.join(ROOT, "trash", "profiles");
const ID = "f09_profile_a";
const OTHER = "f09_profile_b";
const h = vi.hoisted(() => ({
  faults: [] as Array<{ op: string; path: string; code: string; skip?: number; remaining?: number }>,
  fdPaths: new Map<number, string>(),
  onIndexError: null as null | (() => void),
  findBrowserByProfileSync: vi.fn(),
}));

// Only synthetic paths under ROOT are affected. The wrapper deliberately acts
// on real disk files; an in-memory fake would hide post-rename/readback bugs.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  function inject(op: string, file: unknown) {
    const name = String(file);
    if (!name.startsWith(ROOT + path.sep)) return;
    for (const f of h.faults) {
      if (f.op !== op || !name.includes(f.path) || f.remaining === 0) continue;
      if (f.skip) { f.skip--; continue; }
      if (f.remaining !== undefined) f.remaining--;
      if (op === "rename-to" && name === INDEX && h.onIndexError) {
        const write = h.onIndexError;
        h.onIndexError = null;
        write();
      }
      const error = new Error(`${f.code}: injected ${op} ${name}`) as NodeJS.ErrnoException;
      error.code = f.code;
      throw error;
    }
  }
  return {
    ...actual,
    readFileSync: (file: any, ...args: any[]) => { inject("read", file); return (actual.readFileSync as any)(file, ...args); },
    openSync: (file: any, ...args: any[]) => {
      inject("open", file);
      const fd = (actual.openSync as any)(file, ...args);
      h.fdPaths.set(fd, String(file));
      return fd;
    },
    writeFileSync: (file: any, ...args: any[]) => {
      inject("write", typeof file === "number" ? h.fdPaths.get(file) : file);
      return (actual.writeFileSync as any)(file, ...args);
    },
    closeSync: (fd: number) => { h.fdPaths.delete(fd); return actual.closeSync(fd); },
    renameSync: (from: any, to: any) => { inject("rename-from", from); inject("rename-to", to); return actual.renameSync(from, to); },
    rmSync: (file: any, ...args: any[]) => {
      const p = String(file);
      if (p.startsWith(ROOT + path.sep)) {
        const partial = h.faults.find((f) => f.op === "rm-partial" && p.includes(f.path) && f.remaining !== 0);
        if (partial) {
          if (partial.remaining !== undefined) partial.remaining--;
          actual.rmSync(path.join(p, "Default", "sentinel.txt"));
          const error = new Error(`${partial.code}: injected partial rm ${p}`) as NodeJS.ErrnoException;
          error.code = partial.code;
          throw error;
        }
      }
      inject("rm", file);
      return (actual.rmSync as any)(file, ...args);
    },
  };
});
vi.mock("electron", () => ({
  app: { getPath: (key: string) => key === "userData" || key === "home" ? ROOT : ROOT },
  BrowserWindow: { getAllWindows: () => [] },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));

// Only process discovery is isolated: real files, config/index commits,
// deletion, compensation and durable readback remain the production paths.
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  findBrowserByProfileSync: h.findBrowserByProfileSync,
}));

import { getConfig, getConfigPath, getProfileMeta, reloadConfig } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import { listBrowserProfiles, listTrashedProfiles, purgeExpiredTrash, purgeTrashedProfile, restoreTrashedProfile, trashBrowserProfile } from "../../src/main/services/browser-manager.js";
import { exportData } from "../../src/main/services/data-export.js";

const disk = () => JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const index = () => JSON.parse(fs.readFileSync(INDEX, "utf8"));
const liveFile = (id: string) => path.join(LIVE, id, "Default", "sentinel.txt");
const trashFile = (id: string) => path.join(TRASH, id, "Default", "sentinel.txt");
function entry(id: string, deletedAt = Date.now()): any {
  return { dirId: id, name: id, deletedAt, meta: { name: id, engine: "chromium", fingerprintSeed: 12345, proxyMode: "none" } };
}
function seed(id = ID, content = `live:${id}`): void {
  fs.mkdirSync(path.dirname(liveFile(id)), { recursive: true });
  fs.writeFileSync(liveFile(id), content);
  transact((draft: any) => {
    draft.browserProfiles[id] = { ...entry(id).meta, note: "synthetic note", updatedAt: 42 };
    draft.automationNotify = { system: true, sound: false }; // unrelated key survives compensation
  });
  getConfig(); // complete first-load device identity before arming a config fault
}
function writeIndex(entries: any[]): void {
  fs.mkdirSync(path.dirname(INDEX), { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(entries));
}
function fault(op: string, file: string, code = "EACCES", skip = 0, remaining = 1): void {
  h.faults.push({ op, path: file, code, skip, remaining });
}
function state(id: string, expected: { live?: string; trashed?: string; config: boolean; indexed: boolean }): void {
  const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  expect(read(liveFile(id))).toBe(expected.live);
  expect(read(trashFile(id))).toBe(expected.trashed);
  expect(Object.hasOwn(disk().browserProfiles, id)).toBe(expected.config);
  expect(fs.existsSync(INDEX) ? index().some((en: any) => en.dirId === id) : false).toBe(expected.indexed);
  expect(Boolean(getConfig().browserProfiles[id])).toBe(expected.config);
  expect(Boolean(getProfileMeta(id))).toBe(expected.config);
  expect(listBrowserProfiles().some((p) => p.dirId === id)).toBe(expected.config);
  expect(listTrashedProfiles().some((p) => p.dirId === id)).toBe(expected.indexed);
  reloadConfig();
  expect(Boolean(getConfig().browserProfiles[id])).toBe(expected.config);
  expect(Boolean(getProfileMeta(id))).toBe(expected.config);
  expect(listBrowserProfiles().some((p) => p.dirId === id)).toBe(expected.config);
  expect(listTrashedProfiles().some((p) => p.dirId === id)).toBe(expected.indexed);
  expect(disk().automationNotify.system).toBe(true);
  expect(getConfigPath()).toBe(CONFIG);
}

beforeEach(() => {
  h.findBrowserByProfileSync.mockReset();
  h.findBrowserByProfileSync.mockReturnValue(null);
  h.faults = [];
  h.onIndexError = null;
  fs.rmSync(ROOT, { recursive: true, force: true });
  reloadConfig();
});
afterEach(() => { h.faults = []; h.onIndexError = null; });
afterAll(() => {
  if (path.dirname(ROOT) !== os.tmpdir() || !path.basename(ROOT).startsWith("studio-f09-unit-")) throw new Error("unsafe cleanup path");
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("F09 trash/restore/purge and expiration", () => {
  it.each([
    { label: "dated", initial: 1700000000123 },
    { label: "epoch", initial: 0 },
    { label: "missing", initial: undefined },
    { label: "null", initial: null },
  ])("preserves createdAt across repeated restore, reload and structured export ($label)", ({ label, initial }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1791800000000);
    try {
      seed(); seed(OTHER);
      const bytes = Buffer.from([0, 255, 1, 13, 10, 128, 42]);
      fs.writeFileSync(liveFile(ID), bytes);
      transact((draft: any) => {
        const meta = draft.browserProfiles[ID];
        meta.dirId = OTHER; // The indexed ID, not a stale metadata ID, is authoritative.
        meta.tags = ["synthetic", "createdAt-regression"];
        if (initial === undefined) delete meta.createdAt;
        else meta.createdAt = initial;
      });
      const original = disk().browserProfiles[ID];
      const unrelated = disk().browserProfiles[OTHER];
      const firstRestoreAt = 1791800000150;
      const expectedCreatedAt = initial ?? firstRestoreAt;
      let expectedMeta = original;
      const exported = () => JSON.parse(JSON.stringify(exportData("profiles"))).data.profiles;

      for (const cycle of [1, 2]) {
        clock.mockReturnValue(1791800000000 + cycle * 100);
        expect(trashBrowserProfile(ID)).toBe(true);
        expect(fs.existsSync(path.join(LIVE, ID))).toBe(false);
        expect(fs.readFileSync(trashFile(ID))).toEqual(bytes);
        expect(Object.hasOwn(disk().browserProfiles, ID)).toBe(false);
        expect(index()).toHaveLength(1);
        expect(index()[0]).toMatchObject({ dirId: ID, deletedAt: Date.now() });
        expect.soft(index()[0].meta).toEqual(expectedMeta);
        expect(listTrashedProfiles()).toMatchObject([{ dirId: ID, recoverable: true }]);
        reloadConfig();
        expect(getProfileMeta(ID)).toBeNull();
        expect(listBrowserProfiles().some((p) => p.dirId === ID)).toBe(false);
        expect(exported().some((p: any) => p.dirId === ID)).toBe(false);
        expect.soft(listTrashedProfiles()[0].meta).toEqual(expectedMeta);
        console.info("F09_CREATEDAT_STORAGE", JSON.stringify({ label, cycle, stage: "trashed",
          indexedCreatedAt: index()[0].meta.createdAt ?? null,
          sentinelSha256: createHash("sha256").update(fs.readFileSync(trashFile(ID))).digest("hex") }));

        clock.mockReturnValue(firstRestoreAt + (cycle - 1) * 100);
        expect(restoreTrashedProfile(ID)).toBe(true);
        expectedMeta = { ...original, dirId: ID, createdAt: expectedCreatedAt };
        const saved = disk().browserProfiles[ID];
        // Soft timestamp assertions let RED exercise the second restore too.
        expect.soft(saved.createdAt, "restore preserves an existing timestamp").toBe(expectedCreatedAt);
        const { createdAt: _actual, ...savedRest } = saved;
        const { createdAt: _expected, ...expectedRest } = expectedMeta;
        expect(savedRest).toEqual(expectedRest);
        expect(fs.readFileSync(liveFile(ID))).toEqual(bytes);
        expect(fs.existsSync(path.join(TRASH, ID))).toBe(false);
        expect(index()).toEqual([]);
        expect(listTrashedProfiles()).toEqual([]);
        expect(disk().browserProfiles[OTHER]).toEqual(unrelated);
        expect(disk().automationNotify).toEqual({ system: true, sound: false });
        reloadConfig();
        expect.soft((getConfig().browserProfiles[ID] as any).createdAt).toBe(expectedCreatedAt);
        expect.soft(getConfig().browserProfiles[ID]).toEqual(expectedMeta);
        expect(getProfileMeta(ID)).toMatchObject({ name: original.name, note: original.note, tags: original.tags });
        expect(listBrowserProfiles().filter((p) => p.dirId === ID)).toMatchObject([{ dirId: ID, name: original.name }]);
        const rows = exported().filter((p: any) => p.dirId === ID);
        expect(rows).toHaveLength(1);
        expect.soft(rows[0]).toMatchObject({ dirId: ID, name: original.name, tags: original.tags, createdAt: expectedCreatedAt });
        expect(getConfig().browserProfiles[OTHER]).toEqual(unrelated);
        expect(fs.readFileSync(liveFile(ID))).toEqual(bytes);
        console.info("F09_CREATEDAT_STORAGE", JSON.stringify({ label, cycle, stage: "restored",
          diskCreatedAt: saved.createdAt, reloadedCreatedAt: (getConfig().browserProfiles[ID] as any).createdAt,
          exportedCreatedAt: rows[0].createdAt, expectedCreatedAt,
          sentinelSha256: createHash("sha256").update(fs.readFileSync(liveFile(ID))).digest("hex") }));
      }
    } finally { clock.mockRestore(); }
  });

  it("round-trips directory bytes, complete metadata, index and config through reload", () => {
    seed(); seed(OTHER);
    const before = disk().browserProfiles[ID];
    expect(trashBrowserProfile(ID)).toBe(true);
    state(ID, { trashed: `live:${ID}`, config: false, indexed: true });
    expect(index()[0].meta).toMatchObject(before);
    expect(listTrashedProfiles()).toMatchObject([{ dirId: ID, recoverable: true }]);
    expect(restoreTrashedProfile(ID)).toBe(true);
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
    expect(getProfileMeta(ID)).toMatchObject({ name: before.name, note: before.note, engine: before.engine });
    expect(getConfig().browserProfiles[OTHER]).toBeDefined();
    expect(trashBrowserProfile(ID)).toBe(true);
    expect(purgeTrashedProfile(ID)).toBe(true);
    state(ID, { config: false, indexed: false });
    expect(getConfig().browserProfiles[OTHER]).toBeDefined();
  });

  it("refuses trashing an injected running browser without changing files or config/index", () => {
    seed();
    const configBefore = fs.readFileSync(CONFIG);
    const liveBefore = fs.readFileSync(liveFile(ID));
    h.findBrowserByProfileSync.mockReturnValue({
      pid: 424242, dirId: ID, engine: "chromium",
      args: `fixture --user-data-dir="${path.join(LIVE, ID)}"`,
    });
    expect(() => trashBrowserProfile(ID)).toThrow(/running|close|stop/i);
    expect(h.findBrowserByProfileSync).toHaveBeenCalled();
    expect(fs.readFileSync(CONFIG)).toEqual(configBefore);
    expect(fs.readFileSync(liveFile(ID))).toEqual(liveBefore);
    expect(fs.existsSync(INDEX)).toBe(false);
    expect(fs.existsSync(path.join(TRASH, ID))).toBe(false);
    h.findBrowserByProfileSync.mockReturnValue(null);
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
  });

  it("rejects a non-string profile name before moving files or changing config/index", () => {
    seed(); seed(OTHER);
    writeIndex([entry(OTHER)]);
    transact((draft: any) => { draft.browserProfiles[ID].name = 42; });
    const configBefore = fs.readFileSync(CONFIG);
    const indexBefore = fs.readFileSync(INDEX);
    expect(() => trashBrowserProfile(ID)).toThrow(/invalid.*(name|entry)|name.*invalid/i);
    expect(fs.readFileSync(CONFIG)).toEqual(configBefore);
    expect(fs.readFileSync(INDEX)).toEqual(indexBefore);
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
    state(OTHER, { live: `live:${OTHER}`, config: true, indexed: true });
    expect(listTrashedProfiles()).toMatchObject([{ dirId: OTHER }]);
  });

  it("rejects corrupt, nonarray, invalid-shape, duplicate and unsafe ID indexes without moving data", () => {
    seed();
    for (const raw of ["{broken", "{}", "[null]", '[{"dirId":"../escape","name":"x","deletedAt":1}]',
      JSON.stringify([entry(ID), entry(ID)]), JSON.stringify([{ ...entry(ID), deletedAt: "today" }]),
      JSON.stringify([{ ...entry(ID), dirId: 123 }]), JSON.stringify([{ ...entry(ID), meta: { name: null } }]),
      JSON.stringify([{ ...entry(ID), deletionAttempted: false }])]) {
      fs.mkdirSync(path.dirname(INDEX), { recursive: true });
      fs.writeFileSync(INDEX, raw);
      expect(() => listTrashedProfiles()).toThrow();
      expect(() => trashBrowserProfile(ID)).toThrow();
      expect(() => restoreTrashedProfile(ID)).toThrow();
      expect(() => purgeTrashedProfile(ID)).toThrow();
      expect(() => purgeExpiredTrash()).toThrow();
      expect(fs.readFileSync(INDEX, "utf8")).toBe(raw);
      expect(fs.readFileSync(liveFile(ID), "utf8")).toBe(`live:${ID}`);
      expect(disk().browserProfiles[ID]).toBeDefined();
      reloadConfig();
      expect(getProfileMeta(ID)).not.toBeNull();
    }
  });

  it("treats only ENOENT as an empty index; EACCES and other I/O errors propagate", () => {
    seed();
    expect(listTrashedProfiles()).toEqual([]);
    fault("read", "index.json", "EACCES");
    expect(() => trashBrowserProfile(ID)).toThrow(/EACCES/);
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
    writeIndex([]);
    fault("read", "index.json", "EACCES", 0, 2);
    expect(() => listTrashedProfiles()).toThrow(/EACCES/);
    expect(() => purgeExpiredTrash()).toThrow(/EACCES/);
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
  });

  it("preserves both copies when an indexed or orphaned trash directory collides", () => {
    seed();
    fs.mkdirSync(path.dirname(trashFile(ID)), { recursive: true });
    fs.writeFileSync(trashFile(ID), "older-trash");
    expect(() => trashBrowserProfile(ID)).toThrow(/already|exists|collision/i);
    state(ID, { live: `live:${ID}`, trashed: "older-trash", config: true, indexed: false });
    fs.rmSync(path.join(TRASH, ID), { recursive: true });
    writeIndex([entry(ID)]);
    expect(() => trashBrowserProfile(ID)).toThrow(/already|exists|collision/i);
    state(ID, { live: `live:${ID}`, config: true, indexed: true });
  });

  it("rejects restore when live metadata OR a live directory is occupied, preserving trash", () => {
    seed(); trashBrowserProfile(ID);
    fs.mkdirSync(path.dirname(liveFile(ID)), { recursive: true }); fs.writeFileSync(liveFile(ID), "new-live");
    expect(() => restoreTrashedProfile(ID)).toThrow(/already|exists/i);
    state(ID, { live: "new-live", trashed: `live:${ID}`, config: false, indexed: true });
    fs.rmSync(path.join(LIVE, ID), { recursive: true });
    transact((draft: any) => { draft.browserProfiles[ID] = { ...entry(ID).meta, name: "new metadata" }; });
    expect(() => restoreTrashedProfile(ID)).toThrow(/already|exists/i);
    state(ID, { trashed: `live:${ID}`, config: true, indexed: true });
  });

  it("requires both live metadata and a real directory before trashing", () => {
    seed();
    fs.rmSync(path.join(LIVE, ID), { recursive: true });
    expect(() => trashBrowserProfile(ID)).toThrow(/directory is missing/i);
    state(ID, { config: true, indexed: false });
    fs.mkdirSync(path.dirname(liveFile(ID)), { recursive: true });
    fs.writeFileSync(liveFile(ID), "orphan-data");
    transact((draft: any) => { delete draft.browserProfiles[ID]; });
    expect(() => trashBrowserProfile(ID)).toThrow(/metadata is missing/i);
    state(ID, { live: "orphan-data", config: false, indexed: false });
  });

  it("on move failure does not modify config/index or damage either copy", () => {
    seed();
    fault("rename-from", `${path.sep}profiles${path.sep}${ID}`, "EACCES");
    expect(() => trashBrowserProfile(ID)).toThrow(/EACCES/);
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
    h.faults = [];
    trashBrowserProfile(ID);
    fault("rename-from", `${path.sep}trash${path.sep}profiles${path.sep}${ID}`, "EACCES");
    expect(() => restoreTrashedProfile(ID)).toThrow(/EACCES/);
    state(ID, { trashed: `live:${ID}`, config: false, indexed: true });
  });

  it("compensates config commit failure for trash and restore, retaining unrelated writes", () => {
    seed();
    fault("rename-to", "config.json", "EACCES");
    expect(() => trashBrowserProfile(ID)).toThrow(/EACCES/);
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
    h.faults = [];
    trashBrowserProfile(ID);
    fault("rename-to", "config.json", "EACCES");
    expect(() => restoreTrashedProfile(ID)).toThrow(/EACCES/);
    state(ID, { trashed: `live:${ID}`, config: false, indexed: true });
  });

  it("atomically rejects index temp ENOSPC and rename failure, compensating trash/restore", () => {
    for (const [op, file, code] of [["write", "index.json.tmp-", "ENOSPC"], ["rename-to", "index.json", "EACCES"]]) {
      seed();
      fault(op, file, code);
      expect(() => trashBrowserProfile(ID)).toThrow(new RegExp(code));
      state(ID, { live: `live:${ID}`, config: true, indexed: false });
      expect(fs.readdirSync(path.dirname(INDEX)).filter((file) => file.startsWith("index.json.tmp-"))).toEqual([]);
      h.faults = [];
      trashBrowserProfile(ID);
      fault(op, file, code);
      expect(() => restoreTrashedProfile(ID)).toThrow(new RegExp(code));
      state(ID, { trashed: `live:${ID}`, config: false, indexed: true });
      expect(fs.readdirSync(path.dirname(INDEX)).filter((file) => file.startsWith("index.json.tmp-"))).toEqual([]);
      h.faults = [];
      fs.rmSync(ROOT, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it("reports index temporary cleanup failure and its actual recovery path", () => {
    seed();
    fault("write", "index.json.tmp-", "ENOSPC");
    fault("rm", "index.json.tmp-", "EACCES");
    let message = "";
    try { trashBrowserProfile(ID); } catch (e: any) { message = e.message; }
    expect(message).toMatch(/ENOSPC.*cleanup failed.*EACCES.*recovery required/is);
    const leftovers = fs.readdirSync(path.dirname(INDEX)).filter((file) => file.startsWith("index.json.tmp-"));
    expect(leftovers).toHaveLength(1);
    expect(message).toContain(path.join(path.dirname(INDEX), leftovers[0]));
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
  });

  it("preserves unrelated config writes made after forward commit during compensation", () => {
    seed();
    fault("rename-to", "index.json", "ENOSPC");
    h.onIndexError = () => transact((draft: any) => { draft.automationNotify.sound = true; });
    expect(() => trashBrowserProfile(ID)).toThrow(/ENOSPC/);
    state(ID, { live: `live:${ID}`, config: true, indexed: false });
    expect(disk().automationNotify).toMatchObject({ system: true, sound: true });
    expect(getConfig().automationNotify?.sound).toBe(true);
    h.faults = [];
    trashBrowserProfile(ID);
    fault("rename-to", "index.json", "ENOSPC");
    h.onIndexError = () => transact((draft: any) => { draft.automationNotify.system = false; });
    expect(() => restoreTrashedProfile(ID)).toThrow(/ENOSPC/);
    expect(fs.readFileSync(trashFile(ID), "utf8")).toBe(`live:${ID}`);
    expect(index().some((en: any) => en.dirId === ID)).toBe(true);
    expect(disk().automationNotify).toMatchObject({ system: false, sound: true });
    reloadConfig();
    expect(getConfig().automationNotify).toMatchObject({ system: false, sound: true });
    expect(getProfileMeta(ID)).toBeNull();
  });

  it("reports both original failure and recovery-required paths when config compensation fails", () => {
    seed();
    fault("rename-to", "index.json", "ENOSPC");
    fault("rename-to", "config.json", "EACCES", 1); // forward commit succeeds; compensation fails
    expect(() => trashBrowserProfile(ID)).toThrow(/ENOSPC.*recover|recover.*ENOSPC/is);
    state(ID, { live: `live:${ID}`, config: false, indexed: false });
  });

  it("reports failed restore config compensation without clobbering the indexed copy", () => {
    seed(); trashBrowserProfile(ID);
    fault("rename-to", "index.json", "ENOSPC");
    fault("rename-to", "config.json", "EACCES", 1);
    let message = "";
    try { restoreTrashedProfile(ID); } catch (e: any) { message = e.message; }
    expect(message).toMatch(/ENOSPC.*recovery required.*config compensation.*EACCES/is);
    expect(message).toContain(path.join(TRASH, ID));
    state(ID, { trashed: `live:${ID}`, config: true, indexed: true });
  });

  it("reports restore compensation failure with on-disk state and paths", () => {
    seed(); trashBrowserProfile(ID);
    fault("rename-to", "index.json", "ENOSPC");
    fault("rename-from", path.join(LIVE, ID), "EACCES");
    let message = "";
    try { restoreTrashedProfile(ID); } catch (e: any) { message = e.message; }
    expect(message).toMatch(/ENOSPC.*recovery required/is);
    expect(message).toContain(path.join(LIVE, ID));
    expect(message).toContain(path.join(TRASH, ID));
    state(ID, { live: `live:${ID}`, config: false, indexed: true });
  });

  it("reports original failure and actual locations if filesystem compensation fails", () => {
    seed();
    fault("rename-to", "index.json", "ENOSPC");
    fault("rename-from", `${path.sep}trash${path.sep}profiles${path.sep}${ID}`, "EACCES");
    let message = "";
    try { trashBrowserProfile(ID); } catch (e: any) { message = e.message; }
    expect(message).toMatch(/ENOSPC/);
    expect(message).toMatch(/recover|manual/i);
    expect(message).toContain(path.join(TRASH, ID));
    state(ID, { trashed: `live:${ID}`, config: true, indexed: false });
  });

  it("keeps index on partial rm failure and calls post-delete index failure irreversible", () => {
    seed(); trashBrowserProfile(ID);
    fault("rm", `${path.sep}trash${path.sep}profiles${path.sep}${ID}`, "EACCES");
    expect(() => purgeTrashedProfile(ID)).toThrow(/EACCES/);
    state(ID, { trashed: `live:${ID}`, config: false, indexed: true });
    h.faults = [];
    fault("rename-to", "index.json", "ENOSPC");
    expect(() => purgeTrashedProfile(ID)).toThrow(/(already|may|removed|irreversible).*ENOSPC/is);
    state(ID, { config: false, indexed: true });
    expect(listTrashedProfiles()[0].recoverable).toBe(false);
    h.faults = [];
    expect(purgeTrashedProfile(ID)).toBe(true); // honest index-only cleanup
    state(ID, { config: false, indexed: false });
  });

  it("keeps the index and remaining directory bytes when recursive rm fails after partial deletion", () => {
    seed(); trashBrowserProfile(ID);
    const survivor = path.join(TRASH, ID, "Default", "survivor.txt");
    fs.writeFileSync(survivor, "do-not-lose-me");
    fault("rm-partial", `${path.sep}trash${path.sep}profiles${path.sep}${ID}`, "EIO");
    expect(() => purgeTrashedProfile(ID)).toThrow(/partially removed.*EIO/i);
    expect(fs.existsSync(trashFile(ID))).toBe(false);
    expect(fs.readFileSync(survivor, "utf8")).toBe("do-not-lose-me");
    expect(index().some((en: any) => en.dirId === ID)).toBe(true);
    expect(index()[0].deletionAttempted).toBe(true);
    expect(getConfig().browserProfiles[ID]).toBeUndefined();
    expect(listTrashedProfiles()).toMatchObject([{ dirId: ID, recoverable: false, incomplete: true }]);
    expect(() => restoreTrashedProfile(ID)).toThrow(/incomplete|partial|purge/i);
    reloadConfig();
    expect(getProfileMeta(ID)).toBeNull();
    expect(listTrashedProfiles()).toMatchObject([{ dirId: ID, recoverable: false, incomplete: true }]);
    expect(() => restoreTrashedProfile(ID)).toThrow(/incomplete|partial|purge/i);
    expect(fs.readFileSync(survivor, "utf8")).toBe("do-not-lose-me");
    h.faults = [];
    writeIndex([{ ...index()[0], deletedAt: 1 }]);
    expect(() => purgeExpiredTrash(1)).toThrow(/incomplete.*manual review/i);
    expect(fs.readFileSync(survivor, "utf8")).toBe("do-not-lose-me");
    expect(index()[0].deletionAttempted).toBe(true);
    expect(purgeTrashedProfile(ID)).toBe(true);
    expect(index()).toEqual([]);
    expect(fs.existsSync(survivor)).toBe(false);
  });

  it("does not delete data if the durable incomplete marker cannot be saved", () => {
    seed(); trashBrowserProfile(ID);
    const indexBefore = fs.readFileSync(INDEX);
    fault("rename-to", "index.json", "ENOSPC");
    expect(() => purgeTrashedProfile(ID)).toThrow(/ENOSPC/);
    expect(fs.readFileSync(INDEX)).toEqual(indexBefore);
    state(ID, { trashed: `live:${ID}`, config: false, indexed: true });
    expect(listTrashedProfiles()).toMatchObject([{ dirId: ID, recoverable: true }]);
    h.faults = [];
    writeIndex([entry(ID, 1)]);
    fault("rename-to", "index.json", "ENOSPC");
    expect(() => purgeExpiredTrash(1)).toThrow(/0 committed purge\(s\).*pre-delete index update failed.*no deletion attempted.*ENOSPC/is);
    state(ID, { trashed: `live:${ID}`, config: false, indexed: true });
    expect(index()[0].deletionAttempted).toBeUndefined();
  });

  it("never sweeps a conflicted recovery copy, including after a failed restore compensation", () => {
    seed(); seed(OTHER);
    trashBrowserProfile(ID); trashBrowserProfile(OTHER);
    writeIndex([entry(ID, 1), entry(OTHER, 1)]);
    // The restore moves data/config forward, then index commit fails and config
    // compensation fails, leaving the only copy in trash but a live config key.
    fault("rename-to", "index.json", "ENOSPC");
    fault("rename-to", "config.json", "EACCES", 1);
    expect(() => restoreTrashedProfile(ID)).toThrow(/recovery required/i);
    state(ID, { trashed: `live:${ID}`, config: true, indexed: true });
    h.faults = [];
    let message = "";
    try { purgeExpiredTrash(1); } catch (e: any) { message = e.message; }
    expect(message).toMatch(/partially failed.*1 committed purge.*recovery required/is);
    state(ID, { trashed: `live:${ID}`, config: true, indexed: true });
    state(OTHER, { config: false, indexed: false });
    expect(listTrashedProfiles()).toMatchObject([{ dirId: ID, recoverable: false, recoveryRequired: true }]);
    expect(() => purgeTrashedProfile(ID)).toThrow(/recovery required/i);
    expect(fs.readFileSync(trashFile(ID), "utf8")).toBe(`live:${ID}`);
    reloadConfig();
    expect(getProfileMeta(ID)).not.toBeNull();
    expect(index()).toHaveLength(1);
  });

  it("sweeps expired entries individually, retains failures and reports only committed successes", () => {
    seed(); seed(OTHER);
    trashBrowserProfile(ID); trashBrowserProfile(OTHER);
    writeIndex([entry(ID, 1), entry(OTHER, 1)]);
    fault("rm", `${path.sep}${OTHER}`, "EACCES");
    let message = "";
    try { purgeExpiredTrash(1); } catch (e: any) { message = e.message; }
    expect(message).toMatch(/partial|failed/i);
    expect(message).toMatch(/1 committed purge\(s\)/);
    expect(message).toContain(OTHER);
    state(ID, { config: false, indexed: false });
    state(OTHER, { trashed: `live:${OTHER}`, config: false, indexed: true });
    h.faults = [];
    expect(listTrashedProfiles()).toMatchObject([{ dirId: OTHER, recoverable: false, incomplete: true }]);
    expect(() => purgeExpiredTrash(1)).toThrow(/incomplete|manual review/i);
    expect(purgeTrashedProfile(OTHER)).toBe(true); // user-initiated retry, never silent automatic removal
    state(OTHER, { config: false, indexed: false });
  });

  it("reports post-delete expiry index failure without counting it as a committed purge", () => {
    seed(); trashBrowserProfile(ID);
    writeIndex([entry(ID, 1)]);
    fault("rename-to", "index.json", "ENOSPC", 1); // pre-delete marker succeeds, final index commit fails
    expect(() => purgeExpiredTrash(1)).toThrow(/0 committed purge\(s\).*index update failed.*already be removed.*ENOSPC/is);
    state(ID, { config: false, indexed: true });
    expect(listTrashedProfiles()).toMatchObject([{ dirId: ID, recoverable: false, incomplete: true }]);
    h.faults = [];
    expect(() => purgeExpiredTrash(1)).toThrow(/manual review/i);
    expect(purgeTrashedProfile(ID)).toBe(true); // manual index-only cleanup
    state(ID, { config: false, indexed: false });
  });
});
