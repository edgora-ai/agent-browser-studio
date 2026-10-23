import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import * as crypto from "node:crypto";
import * as timers from "node:timers/promises";
import * as vm from "node:vm";
import ts from "typescript";
import { captureFullProfile, prepareFullProfile, resealPreparedFullProfile, restorePreparedFullProfile, type CaptureFullProfileOptions } from "../../src/main/services/sync/full-profile-artifact.js";
import * as zip from "../../src/main/services/zip-writer.js";

// Only the artifact/ZIP modules and invented bytes are used. Fence accidental
// process/network work; no app/config, browser, credentials or storage is loaded.
vi.mock("node:child_process", () => {
  const blocked = () => { throw new Error("Unexpected process work in owned artifact fixture"); };
  return { exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, spawn: blocked, spawnSync: blocked, fork: blocked };
});

const CHUNK = 64 * 1024;
const roots: Array<{ directory: string; owner: fs.Stats }> = [];
const turns = new Set<ReturnType<typeof setImmediate>>();
function nextTurn(operation: () => void): void {
  const turn = setImmediate(() => { turns.delete(turn); operation(); });
  turns.add(turn);
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-profile-responsiveness-"));
  fs.chmodSync(directory, 0o700); roots.push({ directory, owner: fs.lstatSync(directory) });
  const profileDir = path.join(directory, "source"), stagingDir = path.join(directory, "staging");
  for (const item of [profileDir, stagingDir]) fs.mkdirSync(item, { mode: 0o700 });
  const bytes = Buffer.alloc(4 * CHUNK + 17, 0x5a);
  bytes.write("task113-owned-marker=searchable-byte-readback", 3 * CHUNK);
  const file = path.join(profileDir, "state.bin");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const guard = vi.fn<() => void>(() => undefined);
  const options: CaptureFullProfileOptions = { profileDir, stagingDir, dirId: "synthetic-responsive-profile", engine: "chromium",
    snapshotId: "synthetic-responsive-snapshot", passphrase: "synthetic responsive artifact phrase", sourcePlatform: "darwin", guard };
  return { directory, file, bytes, guard, options };
}
function digest(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

let compiledArtifact: string | undefined;
function artifactRealm(scheduler: () => Promise<unknown> = timers.setImmediate) {
  compiledArtifact ??= ts.transpileModule(fs.readFileSync(new URL("../../src/main/services/sync/full-profile-artifact.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({ Buffer, TextDecoder, TextEncoder }), module = { exports: {} };
  const dependencies = new Map<string, unknown>([["node:fs", fsMutable], ["node:path", path], ["node:crypto", crypto],
    ["node:timers/promises", { setImmediate: scheduler }], ["../zip-writer.js", zip]]);
  vm.runInContext(`(function(require, module, exports) { ${compiledArtifact}\n})`, context)((name: string) => {
    if (!dependencies.has(name)) throw new Error("Unfenced artifact VM dependency: " + name);
    return dependencies.get(name);
  }, module, module.exports);
  expect(vm.runInContext("typeof setImmediate", context)).toBe("undefined");
  return module.exports as typeof import("../../src/main/services/sync/full-profile-artifact.js");
}

/** Observe real reads/closure only inside this fresh root. Identify a read-only
 * OPEN, not a reusable fd number or the extraction writer for the same pathname. */
function observeReads(root: string, matches: (file: string) => boolean, onFirstRead: () => void, guards?: () => number) {
  const open = fsMutable.openSync, read = fsMutable.readSync, close = fsMutable.closeSync;
  const owned = new Map<number, { file: string; serial: number }>();
  const chunks: Array<{ position: number; bytes: number }> = [], buffers: Buffer[] = [], guardsAtRead: number[] = [];
  let serial = 0, selected: number | undefined, opened = 0, closed = 0, tailReads = 0, guardsAtClose: number | undefined;
  vi.spyOn(fsMutable, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
    const fd = open(...args), file = typeof args[0] === "string" ? path.resolve(args[0]) : "";
    if (file === root || file.startsWith(root + path.sep)) {
      const record = { file, serial: ++serial }; owned.set(fd, record); opened++;
      const readOnly = typeof args[1] === "number" ? (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0 : args[1] === "r";
      if (selected === undefined && readOnly && matches(file)) selected = record.serial;
    }
    return fd;
  }) as typeof open);
  vi.spyOn(fsMutable, "readSync").mockImplementation(((...args: any[]) => {
    const count = Reflect.apply(read, fsMutable, args), record = owned.get(args[0]);
    if (record && record.serial === selected) {
      if (args[3] === 1) tailReads++;
      if (count > 0 && args[3] > 1) {
        chunks.push({ position: args[4], bytes: count }); buffers.push(args[1]);
        if (guards) guardsAtRead.push(guards());
        if (chunks.length === 1) onFirstRead();
      }
    }
    return count;
  }) as typeof read);
  vi.spyOn(fsMutable, "closeSync").mockImplementation((fd) => {
    const record = owned.get(fd);
    if (record && record.serial === selected) guardsAtClose = guards?.();
    close(fd);
    if (owned.delete(fd)) closed++;
  });
  syncBuiltinESMExports();
  return { chunks, guardsAtRead, get tailReads() { return tailReads; }, get guardsAtClose() { return guardsAtClose; },
    assertClosed() {
      expect(owned.size).toBe(0); expect(closed).toBe(opened);
      for (const buffer of buffers) expect(buffer.every(byte => byte === 0)).toBe(true);
    } };
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => { throw new Error("Unexpected network work in owned artifact fixture"); });
});
afterEach(() => {
  for (const turn of turns) clearImmediate(turn);
  turns.clear(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    const current = fs.lstatSync(root.directory);
    expect(current.isDirectory() && !current.isSymbolicLink() && current.dev === root.owner.dev && current.ino === root.owner.ino).toBe(true);
    const inspect = (directory: string): void => {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        expect(stat.isSymbolicLink()).toBe(false);
        if (stat.isDirectory()) inspect(file);
        else expect(stat.isFile() && stat.nlink === 1).toBe(true);
      }
    };
    inspect(root.directory); fs.rmSync(root.directory, { recursive: true });
    expect(fs.lstatSync(root.directory, { throwIfNoEntry: false })).toBeUndefined();
  }
});

describe("cooperative full-profile artifact traversal", () => {
  it("observes timer cancellation after the first source chunk, before all bytes or any directory durability gate", async () => {
    const f = fixture(), controller = new AbortController(), durability = vi.spyOn(fsMutable, "fsyncSync");
    let readsAtCancellation = 0;
    const cancel = vi.fn(() => { readsAtCancellation = observed.chunks.length; controller.abort(); });
    const observed = observeReads(f.directory, file => file === f.file, () => nextTurn(cancel));
    await expect(captureFullProfile({ ...f.options, signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" });
    observed.assertClosed(); expect(cancel).toHaveBeenCalledTimes(1);
    expect(readsAtCancellation).toBe(1);
    expect(observed.chunks).toEqual([{ position: 0, bytes: CHUNK }]);
    expect(f.guard.mock.calls.length).toBeGreaterThanOrEqual(2); expect(durability).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]);
    expect(digest(fs.readFileSync(f.file))).toBe(digest(f.bytes));
  });

  it("rechecks a changed synchronous runtime/config guard before any next chunk", async () => {
    const f = fixture(); let blocked = false;
    f.guard.mockImplementation(() => { if (blocked) throw new Error("SYNTHETIC_RUNTIME_CHANGED"); });
    const change = vi.fn(() => { blocked = true; });
    const observed = observeReads(f.directory, file => file === f.file, () => nextTurn(change));
    await expect(captureFullProfile(f.options)).rejects.toThrow("SYNTHETIC_RUNTIME_CHANGED");
    expect(change).toHaveBeenCalledTimes(1); expect(observed.chunks).toHaveLength(1); observed.assertClosed();
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]); expect(fs.readFileSync(f.file)).toEqual(f.bytes);
  });

  it("gives every chunk a real turn and rechecks cancellation even after the final chunk before stability I/O", async () => {
    const f = fixture(), controller = new AbortController(), durability = vi.spyOn(fsMutable, "fsyncSync"), abort = vi.spyOn(controller, "abort");
    const readsAtTurns: number[] = [], count = Math.ceil(f.bytes.length / CHUNK);
    const untilLastChunk = () => {
      readsAtTurns.push(observed.chunks.length);
      if (observed.chunks.length === count) controller.abort();
      else nextTurn(untilLastChunk);
    };
    const observed = observeReads(f.directory, file => file === f.file, () => nextTurn(untilLastChunk));
    await expect(captureFullProfile({ ...f.options, signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(readsAtTurns).toEqual([1, 2, 3, 4, 5]); expect(abort).toHaveBeenCalledTimes(1);
    expect(observed.tailReads).toBe(0); observed.assertClosed(); expect(durability).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]);
  });

  it.each(["append", "replace"] as const)("refuses source %s after a real read/yield witness, retaining the changed owned source", async (kind) => {
    const f = fixture(); let readsAtMutation = 0;
    const expected = kind === "append" ? Buffer.concat([f.bytes, Buffer.from([0x21])]) : Buffer.from(f.bytes);
    if (kind === "replace") expected[0] ^= 0xff;
    const mutate = vi.fn(() => {
      readsAtMutation = observed.chunks.length;
      if (kind === "append") {
        const fd = fs.openSync(f.file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
        try { fs.writeSync(fd, expected.subarray(-1), 0, 1, f.bytes.length); } finally { fs.closeSync(fd); }
      } else {
        const replacement = path.join(f.directory, "owned-replacement.bin");
        fs.writeFileSync(replacement, expected, { flag: "wx", mode: 0o600 }); fs.renameSync(replacement, f.file);
      }
    });
    const observed = observeReads(f.directory, file => file === f.file, () => nextTurn(mutate));
    await expect(captureFullProfile(f.options)).rejects.toThrow(/changed|unstable/i);
    expect(mutate).toHaveBeenCalledTimes(1); expect(readsAtMutation).toBe(1); observed.assertClosed();
    expect(fs.readFileSync(f.file)).toEqual(expected); expect(fs.readdirSync(f.options.stagingDir)).toEqual([]);
  });

  it("cancels owned ZIP readback after one chunk and cleans only its workspace", async () => {
    const f = fixture(), controller = new AbortController();
    const callerFile = path.join(f.options.stagingDir, "caller-owned.txt");
    fs.writeFileSync(callerFile, "not the artifact workspace", { flag: "wx", mode: 0o600 });
    const cancel = vi.fn(() => controller.abort());
    const observed = observeReads(f.directory, file => path.basename(file) === "profile.zip", () => nextTurn(cancel));
    await expect(captureFullProfile({ ...f.options, signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(cancel).toHaveBeenCalledTimes(1); expect(observed.chunks).toEqual([{ position: 0, bytes: CHUNK }]); observed.assertClosed();
    expect(fs.readdirSync(f.options.stagingDir)).toEqual(["caller-owned.txt"]);
    expect(fs.readFileSync(callerFile, "utf8")).toBe("not the artifact workspace"); expect(fs.readFileSync(f.file)).toEqual(f.bytes);
  });

  it("cancels prepare's extracted-file verification after one chunk without publishing prepared state", async () => {
    const f = fixture(), bundle = await captureFullProfile(f.options), controller = new AbortController();
    const before = fs.readdirSync(f.options.stagingDir), cancel = vi.fn(() => controller.abort());
    let verificationOpens = 0;
    // The first readonly open is extraction's synchronous CRC readback, the
    // second is the cooperative manifest scan. Real fsync gates stay unchanged.
    const observed = observeReads(f.directory, file => file.endsWith(path.join("contents", "profile", "state.bin")) && ++verificationOpens === 2, () => nextTurn(cancel));
    await expect(prepareFullProfile({ ...f.options, ...bundle, signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(verificationOpens).toBe(2); expect(cancel).toHaveBeenCalledTimes(1);
    expect(observed.chunks).toEqual([{ position: 0, bytes: CHUNK }]); observed.assertClosed();
    expect(fs.readdirSync(f.options.stagingDir)).toEqual(before); expect(fs.readFileSync(f.file)).toEqual(f.bytes);
  });

  it("checks cancellation after an empty-directory member yield before inspecting that member", async () => {
    const f = fixture(), controller = new AbortController();
    fs.unlinkSync(f.file); const empty = path.join(f.options.profileDir, "empty"); fs.mkdirSync(empty, { mode: 0o700 });
    const observed = observeReads(f.directory, () => false, () => { throw new Error("Unexpected fixture read"); });
    const readdir = fsMutable.readdirSync, cancel = vi.fn(() => controller.abort()); let scheduled = false;
    vi.spyOn(fsMutable, "readdirSync").mockImplementation(((...args: any[]) => {
      const names = Reflect.apply(readdir, fsMutable, args);
      if (String(args[0]) === f.options.profileDir && !scheduled) { scheduled = true; nextTurn(cancel); }
      return names;
    }) as typeof readdir);
    const lstat = vi.spyOn(fsMutable, "lstatSync"), durability = vi.spyOn(fsMutable, "fsyncSync"); syncBuiltinESMExports();
    await expect(captureFullProfile({ ...f.options, signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(cancel).toHaveBeenCalledTimes(1); expect(lstat.mock.calls.filter(([file]) => String(file) === empty)).toHaveLength(0);
    expect(durability).not.toHaveBeenCalled(); observed.assertClosed(); expect(fs.readdirSync(f.options.stagingDir)).toEqual([]);
  });

  it("rechecks the await continuation of an empty scan before creating a workspace", async () => {
    const f = fixture(); fs.unlinkSync(f.file);
    let enumerated = false, finalRootStats = 0, blocked = false, scheduled = false;
    const change = vi.fn(() => { blocked = true; });
    const observed = observeReads(f.directory, () => false, () => { throw new Error("Unexpected empty fixture read"); });
    const readdir = fsMutable.readdirSync, lstat = fsMutable.lstatSync;
    vi.spyOn(fsMutable, "readdirSync").mockImplementation(((...args: any[]) => {
      const names = Reflect.apply(readdir, fsMutable, args);
      if (String(args[0]) === f.options.profileDir) enumerated = true;
      return names;
    }) as typeof readdir);
    vi.spyOn(fsMutable, "lstatSync").mockImplementation(((...args: any[]) => {
      const stat = Reflect.apply(lstat, fsMutable, args);
      if (enumerated && String(args[0]) === f.options.profileDir) finalRootStats++;
      return stat;
    }) as typeof lstat);
    const workspaces = vi.spyOn(fsMutable, "mkdtempSync");
    f.guard.mockImplementation(() => {
      if (blocked) throw new Error("SYNTHETIC_EMPTY_SCAN_SCOPE_CHANGED");
      if (finalRootStats === 2 && !scheduled) { scheduled = true; queueMicrotask(change); }
    });
    syncBuiltinESMExports();
    await expect(captureFullProfile(f.options)).rejects.toThrow("SYNTHETIC_EMPTY_SCAN_SCOPE_CHANGED");
    expect(change).toHaveBeenCalledTimes(1); expect(workspaces).not.toHaveBeenCalled(); observed.assertClosed();
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]);
  });

  it("uses its explicit timer dependency in a strict VM with no global setImmediate", async () => {
    const realm = artifactRealm(), f = fixture(), controller = new AbortController(), cancel = vi.fn(() => controller.abort());
    const observed = observeReads(f.directory, file => file === f.file, () => nextTurn(cancel));
    await expect(realm.captureFullProfile({ ...f.options, signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(cancel).toHaveBeenCalledTimes(1); expect(observed.chunks).toHaveLength(1); observed.assertClosed();
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]);
  });

  it("closes a suspended iterator's fd and clears its buffer when the async driver itself rejects", async () => {
    const f = fixture(); let reading = false, faults = 0;
    const realm = artifactRealm(() => {
      if (reading) { faults++; return Promise.reject(new Error("SYNTHETIC_SCHEDULER_FAILURE")); }
      return timers.setImmediate();
    });
    const observed = observeReads(f.directory, file => file === f.file, () => { reading = true; });
    await expect(realm.captureFullProfile(f.options)).rejects.toThrow("SYNTHETIC_SCHEDULER_FAILURE");
    expect(faults).toBe(1); expect(observed.chunks).toHaveLength(1); observed.assertClosed();
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]); expect(fs.readFileSync(f.file)).toEqual(f.bytes);
  });

  it("preserves chunk guards and byte/hash/searchable readback with synchronous reseal, restore and rollback", async () => {
    const f = fixture(); fs.mkdirSync(path.join(f.options.profileDir, "empty"), { mode: 0o700 });
    let readsAtTurn = 0;
    const observeTurn = vi.fn(() => { readsAtTurn = observed.chunks.length; });
    const observed = observeReads(f.directory, file => file === f.file, () => nextTurn(observeTurn), () => f.guard.mock.calls.length);
    const bundle = await captureFullProfile(f.options);
    expect(observeTurn).toHaveBeenCalledTimes(1); expect(readsAtTurn).toBe(1); expect(observed.chunks).toHaveLength(5);
    for (let i = 1; i < observed.guardsAtRead.length; i++) expect(observed.guardsAtRead[i] - observed.guardsAtRead[i - 1]).toBe(2);
    expect(observed.guardsAtClose! - observed.guardsAtRead.at(-1)!).toBe(2); expect(observed.tailReads).toBe(1);
    expect(bundle.descriptor.sha256).toBe(digest(bundle.body)); expect(bundle.descriptor.size).toBe(bundle.body.length);
    const prepared = await prepareFullProfile({ ...f.options, ...bundle });
    const member = prepared.manifest.files.find(item => item.path === "state.bin");
    expect(member).toMatchObject({ size: f.bytes.length, sha256: digest(f.bytes) });
    const readback = fs.readFileSync(path.join(prepared.directory, "state.bin"));
    expect(readback).toEqual(f.bytes); expect(readback.includes(Buffer.from("task113-owned-marker=searchable-byte-readback"))).toBe(true);
    expect(fs.lstatSync(path.join(prepared.directory, "empty")).isDirectory()).toBe(true);
    const target = path.join(f.directory, "receiver"); fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "old.txt"), "owned previous bytes", { flag: "wx", mode: 0o600 });
    let turnRan = false; nextTurn(() => { turnRan = true; });
    const resealed = resealPreparedFullProfile({ prepared, changedPaths: [], guard: f.options.guard });
    expect(resealed).not.toHaveProperty("then"); expect(turnRan).toBe(false);
    const restored = restorePreparedFullProfile({ prepared: resealed, profileDir: target, backupSuffix: ".owned-old", guard: f.options.guard });
    expect(restored).not.toHaveProperty("then"); expect(turnRan).toBe(false);
    expect(fs.readFileSync(path.join(target, "state.bin"))).toEqual(f.bytes);
    expect(restored.rollback()).toBeUndefined(); expect(turnRan).toBe(false);
    expect(fs.readFileSync(path.join(target, "old.txt"), "utf8")).toBe("owned previous bytes");
    const retained = fs.readFileSync(path.join(restored.rollbackDir!, "state.bin"));
    expect(digest(retained)).toBe(member!.sha256); expect(retained.includes(Buffer.from("task113-owned-marker="))).toBe(true);
    observed.assertClosed(); await timers.setImmediate(); expect(turnRan).toBe(true);
  });
});
