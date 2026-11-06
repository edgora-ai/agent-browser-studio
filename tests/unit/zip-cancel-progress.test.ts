import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import * as vm from "node:vm";
import ts from "typescript";
import type { WriteZipOptions, WriteZipProgress } from "../../src/main/services/zip-writer.js";

// Only the real ZIP module, invented bytes, and owned temporary directories run.
// The realm fences imports and lets syscall/turn observers target actual passes
// without replacing the writer, touching the app, or relying on wall-clock speed.
const CHUNK = 64 * 1024, BATCH = 4 * 1024 * 1024;
type Event = { op: string; file: string; fd?: number; position?: number; wanted?: number; bytes?: number; flags?: number; directory?: boolean };
const roots: Array<{ directory: string; owner: fs.Stats }> = [];
const realms: Array<ReturnType<typeof writerRealm>> = [];
let compiled: string | undefined;
function fixture(size = 2 * BATCH + 17, existing = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zip-cancel-progress-"));
  roots.push({ directory, owner: fs.lstatSync(directory) });
  const source = path.join(directory, "invented.bin"), destination = path.join(directory, "archive.zip");
  const bytes = Buffer.alloc(size, 0x5a), sentinel = Buffer.from("invented previous destination; never clobber on cancel");
  fs.writeFileSync(source, bytes);
  if (existing) fs.writeFileSync(destination, sentinel);
  return { directory, source, destination, bytes, sentinel };
}
function writerRealm() {
  compiled ??= ts.transpileModule(fs.readFileSync(new URL("../../src/main/services/zip-writer.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const state = {
    now: 1_800_000_000_000, turns: 0, shortRead: 0, shortWrite: 0,
    files: new Map<number, string>(), events: [] as Event[],
    hook: undefined as undefined | ((event: Event) => void),
    onTurn: undefined as undefined | (() => void),
  };
  const observe = (event: Event) => { state.events.push(event); state.hook?.(event); };
  const disk = {
    ...fs,
    lstatSync(file: fs.PathLike) {
      const stat = fs.lstatSync(file); observe({ op: "lstat", file: String(file) }); return stat;
    },
    openSync(file: fs.PathLike, flags: number, mode?: number) {
      const fd = fs.openSync(file, flags, mode); state.files.set(fd, String(file));
      observe({ op: "open", file: String(file), fd, flags }); return fd;
    },
    closeSync(fd: number) {
      const file = state.files.get(fd)!; fs.closeSync(fd); state.files.delete(fd);
      observe({ op: "close", file, fd });
    },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      const bytes = fs.readSync(fd, buffer, offset, state.shortRead ? Math.min(length, state.shortRead) : length, position);
      observe({ op: "read", file: state.files.get(fd)!, fd, position, wanted: length, bytes }); return bytes;
    },
    writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      const bytes = fs.writeSync(fd, buffer, offset, state.shortWrite ? Math.min(length, state.shortWrite) : length, position);
      observe({ op: "write", file: state.files.get(fd)!, fd, position, wanted: length, bytes }); return bytes;
    },
    fsyncSync(fd: number) {
      fs.fsyncSync(fd); observe({ op: "fsync", file: state.files.get(fd)!, fd, directory: fs.fstatSync(fd).isDirectory() });
    },
    linkSync(from: fs.PathLike, to: fs.PathLike) { observe({ op: "link", file: String(to) }); fs.linkSync(from, to); },
    renameSync(from: fs.PathLike, to: fs.PathLike) { observe({ op: "rename", file: String(to) }); fs.renameSync(from, to); },
    unlinkSync(file: fs.PathLike) { observe({ op: "unlink", file: String(file) }); fs.unlinkSync(file); },
  };
  const dependencies = new Map<string, unknown>([["node:fs", disk], ["node:path", path], ["node:os", os], ["node:crypto", crypto], ["node:zlib", zlib]]);
  const context = vm.createContext({ Buffer, Date: class extends Date { static now() { return state.now; } },
    setImmediate: (resume: () => void) => setImmediate(() => { state.turns++; state.onTurn?.(); resume(); }),
  });
  const module = { exports: {} };
  vm.runInContext(`(function(require, module, exports) { ${compiled}\n})`, context)((name: string) => {
    if (!dependencies.has(name)) throw new Error("Unexpected ZIP fixture dependency: " + name);
    return dependencies.get(name);
  }, module, module.exports);
  const api = module.exports as typeof import("../../src/main/services/zip-writer.js");
  const result = { api, state }; realms.push(result); return result;
}
function expectSettled(h: ReturnType<typeof writerRealm>, f: ReturnType<typeof fixture>, existing = true) {
  expect(h.state.files.size, "public promise settles only after real descriptors close").toBe(0);
  const opened = h.state.events.filter(event => event.op === "open");
  expect(h.state.events.filter(event => event.op === "close")).toHaveLength(opened.length);
  for (const event of opened) expect(() => fs.fstatSync(event.fd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
  expect(fs.readdirSync(f.directory).filter(name => name.startsWith(".abs-profile-archive-"))).toEqual([]);
  if (existing) expect(fs.readFileSync(f.destination)).toEqual(f.sentinel);
  else expect(fs.existsSync(f.destination)).toBe(false);
  expect(fs.readFileSync(f.source).equals(f.bytes)).toBe(true);
}
afterEach(() => {
  for (const h of realms.splice(0)) expect(h.state.files.size, "no detached writer or leaked descriptor").toBe(0);
  for (const { directory, owner } of roots.splice(0)) {
    const resolved = path.resolve(directory), current = fs.lstatSync(resolved);
    if (resolved !== directory || path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith("zip-cancel-progress-") || current.isSymbolicLink() ||
        current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Refusing unowned ZIP fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("bounded ZIP writer cancellation and local processing progress", () => {
  it("rejects an already aborted operation before any open, guard, or observer", async () => {
    const f = fixture(1), h = writerRealm(), controller = new AbortController(), guard = vi.fn(), onProgress = vi.fn();
    controller.abort(new Error("synthetic cancellation"));
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], {
      overwrite: true, signal: controller.signal, guard, onProgress,
    })).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(h.state.events).toEqual([]); expect(guard).not.toHaveBeenCalled(); expect(onProgress).not.toHaveBeenCalled();
    expectSettled(h, f);
  });

  it.each(["CRC prepass", "copy", "readback"] as const)("cancels on an event-loop turn inside %s and awaits cleanup", async phase => {
    const f = fixture(), h = writerRealm(), controller = new AbortController();
    let sourcePass = 0, armed = false, readsAtCancel = 0, passBytes = 0;
    h.state.hook = event => {
      if (event.op !== "read") return;
      if (event.file === f.source && event.position === 0) sourcePass++;
      const selected = phase === "CRC prepass" ? event.file === f.source && sourcePass === 1 :
        phase === "copy" ? event.file === f.source && sourcePass === 2 :
          path.basename(event.file).startsWith(".abs-profile-archive-") && event.position === 34 && event.wanted === CHUNK;
      if (selected && !armed) {
        armed = true;
        h.state.onTurn = () => {
          h.state.onTurn = undefined;
          readsAtCancel = h.state.events.filter(item => item.op === "read").length;
          controller.abort();
        };
      }
      if (armed) passBytes += event.bytes ?? 0;
    };
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], {
      overwrite: true, signal: controller.signal,
    })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(armed).toBe(true); expect(h.state.turns).toBeGreaterThan(0);
    expect(passBytes).toBeGreaterThan(0); expect(passBytes).toBeLessThanOrEqual(BATCH);
    expect(h.state.events.filter(event => event.op === "read")).toHaveLength(readsAtCancel);
    expectSettled(h, f);
  });

  it("also yields inside an in-memory CRC prepass, before any payload copy", async () => {
    const f = fixture(), h = writerRealm(), controller = new AbortController();
    let observed: WriteZipProgress | undefined;
    h.state.onTurn = () => { h.state.onTurn = undefined; controller.abort(); };
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", data: f.bytes }], {
      overwrite: true, signal: controller.signal, onProgress: progress => { observed = progress; },
    })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(observed).toMatchObject({ phase: "packing", bytes: BATCH, items: 0, totalItems: 1 });
    expect(h.state.events.filter(event => event.op === "write")).toEqual([]);
    expectSettled(h, f);
  });

  it("checks a signal before the very next 64KiB read without an expensive guard", async () => {
    const f = fixture(), h = writerRealm(), controller = new AbortController(), guard = vi.fn();
    h.state.hook = event => { if (event.op === "read" && event.file === f.source) controller.abort(); };
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], {
      overwrite: true, signal: controller.signal, guard,
    })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(h.state.events.filter(event => event.op === "read")).toHaveLength(1);
    expect(guard).toHaveBeenCalledTimes(1); expect(h.state.turns).toBe(0); expectSettled(h, f);
  });

  it.each(["await", "progress callback"] as const)("gets fresh guard admission after every %s", async boundary => {
    const f = fixture(), h = writerRealm(); let denied = false, readsAtDenial = 0;
    const deny = () => { denied = true; readsAtDenial = h.state.events.filter(event => event.op === "read").length; };
    const guard = vi.fn(() => { if (denied) throw new Error("synthetic lease changed"); });
    if (boundary === "await") h.state.onTurn = deny;
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], {
      overwrite: true, guard, ...(boundary === "progress callback" ? { onProgress: deny } : {}),
    })).rejects.toThrow("synthetic lease changed");
    expect(readsAtDenial).toBe(BATCH / CHUNK);
    expect(h.state.events.filter(event => event.op === "read")).toHaveLength(readsAtDenial);
    expect(guard).toHaveBeenCalledTimes(boundary === "await" ? 3 : 2);
    expectSettled(h, f);
  });

  it.each(["guard", "onProgress"] as const)("rejects async %s callbacks, including rejected promises, with synchronous cleanup", async callback => {
    for (const rejected of [false, true]) {
      const f = fixture(3), h = writerRealm();
      const invalid = () => rejected ? Promise.reject(new Error("synthetic async failure")) : Promise.resolve();
      const options = { overwrite: true, [callback]: invalid } as WriteZipOptions;
      await expect(h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], options)).rejects.toThrow(/must be synchronous/);
      if (callback === "guard") expect(h.state.events).toEqual([]);
      expectSettled(h, f);
    }
  });

  it.each(["signal", "guard"] as const)("honors fresh %s state after precommit directory fsync without changing the destination", async check => {
    const f = fixture(3), h = writerRealm(), controller = new AbortController(); let denied = false;
    h.state.hook = event => {
      if (event.op === "fsync" && event.directory) { denied = true; if (check === "signal") controller.abort(); }
    };
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], {
      overwrite: true, signal: controller.signal, guard: () => { if (check === "guard" && denied) throw new Error("synthetic precommit lease changed"); },
    })).rejects.toThrow(check === "signal" ? /aborted/ : /precommit lease changed/);
    expect(denied).toBe(true); expect(h.state.events.filter(event => ["link", "rename"].includes(event.op))).toEqual([]);
    expectSettled(h, f);
  });

  it("allows final complete progress to cancel before publication and keeps a new destination absent", async () => {
    const f = fixture(7, false), h = writerRealm(), controller = new AbortController(); let cancelled = false;
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", data: f.bytes }], {
      signal: controller.signal, onProgress: progress => {
        if (progress.bytes === 3 * f.bytes.length) { cancelled = true; controller.abort(); }
      },
    })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(cancelled).toBe(true); expectSettled(h, f, false);
  });

  it.each([false, true])("never falsely reports cancellation after atomic publication (overwrite=%s)", async overwrite => {
    const f = fixture(7, overwrite), h = writerRealm(), controller = new AbortController(); let published = false;
    const onProgress = vi.fn(() => { expect(published, "no post-commit observer").toBe(false); });
    h.state.hook = event => { if (event.op === (overwrite ? "rename" : "link")) { published = true; controller.abort(); } };
    const result = await h.api.writeZipArchive(f.destination, [{ name: "body", data: f.bytes }], { overwrite, signal: controller.signal, onProgress });
    expect(published).toBe(true); expect(controller.signal.aborted).toBe(true); expect(onProgress).toHaveBeenCalled();
    expect(result).toEqual({ entries: 1, bytes: fs.statSync(f.destination).size });
    const archive = fs.readFileSync(f.destination), entry = h.api.readZipEntries(archive)[0];
    expect(h.api.extractZipEntry(archive, entry).equals(f.bytes)).toBe(true);
    expect(h.state.files.size).toBe(0); expect(fs.readdirSync(f.directory)).toEqual(["archive.zip", "invented.bin"]);
  });

  it("reports monotonic accurate three-pass bytes and strictly capped mixed-tail batches, not network/archive bytes", async () => {
    const f = fixture(BATCH / 2 + 17, false), h = writerRealm(), progress: WriteZipProgress[] = [], guard = vi.fn();
    const inline = Buffer.alloc(BATCH / 2 + 31, 0x7b), payload = f.bytes.length + inline.length;
    const result = await h.api.writeZipArchive(f.destination, [
      { name: "body", filePath: f.source }, { name: "directory/", isDirectory: true }, { name: "directory/inline", data: inline },
    ], { guard, onProgress: value => progress.push(value) });
    let previousBytes = 0, previousItems = 0;
    for (const item of progress) {
      expect(item.phase).toBe("packing"); expect(item.totalItems).toBe(3); expect(item.totalBytes).toBeUndefined();
      expect(item.bytes).toBeGreaterThanOrEqual(previousBytes); expect(item.bytes - previousBytes).toBeLessThanOrEqual(BATCH);
      expect(item.items).toBeGreaterThanOrEqual(previousItems); expect(item.items).toBeLessThanOrEqual(3);
      previousBytes = item.bytes; previousItems = item.items;
    }
    expect(progress[0].bytes).toBeGreaterThan(BATCH - CHUNK); expect(progress[0].bytes).toBeLessThan(BATCH);
    expect(progress.at(-1)).toMatchObject({ bytes: 3 * payload, items: 3 });
    expect(result.entries).toBe(3); expect(result.bytes).toBe(fs.statSync(f.destination).size); expect(result.bytes).not.toBe(3 * payload);
    const archive = fs.readFileSync(f.destination), entries = h.api.readZipEntries(archive);
    expect(h.api.extractZipEntry(archive, entries[0]).equals(f.bytes)).toBe(true); expect(h.api.extractZipEntry(archive, entries[2]).equals(inline)).toBe(true);
    expect(guard.mock.calls.length).toBeLessThan(h.state.events.filter(event => event.op === "read").length / 4);
    expect(h.state.files.size).toBe(0);
  });

  it("keeps exact processing counters across short source/readback reads and short writes", async () => {
    const f = fixture(CHUNK + 19, false), h = writerRealm(), progress: WriteZipProgress[] = [];
    h.state.shortRead = 997; h.state.shortWrite = 113;
    await h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], { onProgress: value => progress.push(value) });
    expect(progress.at(-1)).toMatchObject({ bytes: 3 * f.bytes.length, items: 1 });
    const archive = fs.readFileSync(f.destination), [entry] = h.api.readZipEntries(archive);
    expect(h.api.extractZipEntry(archive, entry).equals(f.bytes)).toBe(true); expect(h.state.files.size).toBe(0);
  });

  it("starts its 16ms payload budget after expensive guard admission", async () => {
    const f = fixture(), h = writerRealm(), controller = new AbortController(); let first: WriteZipProgress | undefined;
    h.state.hook = event => { if (event.op === "read" && event.file === f.source) h.state.now++; };
    const guard = vi.fn(() => { h.state.now += 1000; });
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], {
      overwrite: true, guard, signal: controller.signal, onProgress: progress => { first = progress; controller.abort(); },
    })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(first).toMatchObject({ bytes: 16 * CHUNK, items: 0 });
    expect(h.state.events.filter(event => event.op === "read")).toHaveLength(16); expect(guard).toHaveBeenCalledTimes(1);
    expectSettled(h, f);
  });

  it.each(["readback metadata", "short staging writes"] as const)("honors the 16ms budget during %s", async phase => {
    const f = fixture(CHUNK + 19), h = writerRealm(), controller = new AbortController();
    let operations = 0, observed: WriteZipProgress | undefined;
    if (phase === "readback metadata") h.state.shortRead = 997;
    else h.state.shortWrite = 113;
    h.state.hook = event => {
      if (path.basename(event.file).startsWith(".abs-profile-archive-") && event.op === (phase === "readback metadata" ? "read" : "write")) {
        operations++; h.state.now++;
      }
    };
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", data: f.bytes }], {
      overwrite: true, signal: controller.signal, onProgress: progress => {
        if (operations) { observed = progress; controller.abort(); }
      },
    })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(operations).toBe(16);
    if (phase === "readback metadata") expect(observed).toMatchObject({ bytes: 2 * f.bytes.length, items: 1 });
    else expect(observed).toMatchObject({ bytes: f.bytes.length + 14 * 113, items: 0 });
    expectSettled(h, f);
  });

  it.each(["source reads", "staging writes"] as const)("caps frozen-clock 1-byte %s at 128 checkpoints between callbacks", async phase => {
    const f = fixture(512, false), h = writerRealm();
    let operations = 0, maximum = 0, total = 0;
    if (phase === "source reads") h.state.shortRead = 1;
    else h.state.shortWrite = 1;
    h.state.hook = event => {
      const selected = phase === "source reads" ? event.op === "read" && event.file === f.source && (event.bytes ?? 0) > 0 : event.op === "write";
      if (selected) { operations++; total++; }
    };
    const progress: WriteZipProgress[] = [];
    await h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], {
      onProgress: value => {
        maximum = Math.max(maximum, operations);
        expect(operations).toBeLessThanOrEqual(128); operations = 0; progress.push(value);
      },
    });
    expect(total).toBeGreaterThan(512); expect(maximum).toBeGreaterThan(100); expect(h.state.turns).toBeGreaterThan(4);
    expect(progress.at(-1)).toMatchObject({ bytes: 3 * f.bytes.length, items: 1 });
    expect(h.state.files.size).toBe(0);
    const archive = fs.readFileSync(f.destination), [entry] = h.api.readZipEntries(archive);
    expect(h.api.extractZipEntry(archive, entry).equals(f.bytes)).toBe(true);
  });

  it("bounds empty-entry work to at most 128 items between turns", async () => {
    const f = fixture(0, false), h = writerRealm(); let writesThisTurn = 0, maxWrites = 0;
    h.state.hook = event => {
      if (event.op === "write" && event.wanted === 30) { writesThisTurn++; maxWrites = Math.max(maxWrites, writesThisTurn); }
    };
    h.state.onTurn = () => { writesThisTurn = 0; };
    const progress: WriteZipProgress[] = [];
    const result = await h.api.writeZipArchive(f.destination, Array.from({ length: 513 }, (_, index) => ({ name: `empty-${index}`, data: Buffer.alloc(0) })), {
      onProgress: value => progress.push(value),
    });
    expect(result.entries).toBe(513); expect(maxWrites).toBeGreaterThan(1); expect(maxWrites).toBeLessThanOrEqual(128);
    expect(h.state.turns).toBeGreaterThan(4); expect(progress.at(-1)).toMatchObject({ bytes: 0, items: 513 });
    expect(h.api.readZipEntries(fs.readFileSync(f.destination))).toHaveLength(513); expect(h.state.files.size).toBe(0);
  });

  it("revalidates the staging parent after metadata yields and refuses a planted parent symlink", async () => {
    const f = fixture(1), h = writerRealm();
    const output = path.join(f.directory, "output"), retained = path.join(f.directory, "retained-output"), outside = path.join(f.directory, "other-owned-directory");
    fs.mkdirSync(output); fs.mkdirSync(outside);
    const destination = path.join(output, "archive.zip"); fs.writeFileSync(destination, f.sentinel);
    let swapped = false;
    h.state.onTurn = () => {
      h.state.onTurn = undefined;
      // Both paths and the alternate target are invented, owned fixture paths.
      expect(path.dirname(path.resolve(output))).toBe(f.directory);
      expect(path.dirname(path.resolve(retained))).toBe(f.directory);
      fs.renameSync(output, retained); fs.symlinkSync(outside, output, "dir"); swapped = true;
    };
    await expect(h.api.writeZipArchive(destination, Array.from({ length: 129 }, (_, index) => ({ name: `item-${index}`, filePath: f.source })), {
      overwrite: true,
    })).rejects.toThrow(/symlink|symbolic|directory/i);
    expect(swapped).toBe(true); expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(retained, "archive.zip"))).toEqual(f.sentinel);
    expect(h.state.events.filter(event => event.op === "open" || event.op === "write")).toEqual([]);
    expectSettled(h, f);
  });

  it("never yields or calls an observer after the first final witness in a >128-source commit", async () => {
    const f = fixture(1, false), h = writerRealm();
    const sources = [f.source];
    for (let i = 1; i < 130; i++) {
      const file = path.join(f.directory, `invented-${i}.bin`); fs.writeFileSync(file, Buffer.from([i])); sources.push(file);
    }
    const sourcePaths = new Set(sources); let processingComplete = false, witnesses = 0, lateObserver = false, lateTurn = false;
    h.state.hook = event => { if (processingComplete && event.op === "lstat" && sourcePaths.has(event.file)) witnesses++; };
    h.state.onTurn = () => { if (witnesses) lateTurn = true; };
    await h.api.writeZipArchive(f.destination, sources.map((filePath, i) => ({ name: `item-${i}`, filePath })), {
      onProgress: progress => {
        if (witnesses) {
          lateObserver = true;
          // A hypothetical late observer must not be able to alter an already
          // checked source and then let the stale snapshot publish successfully.
          fs.appendFileSync(f.source, Buffer.from("invented late mutation"));
        }
        if (progress.bytes === 3 * sources.length) processingComplete = true;
      },
    });
    expect(processingComplete).toBe(true); expect(witnesses).toBe(sources.length);
    expect(lateObserver).toBe(false); expect(lateTurn).toBe(false); expect(fs.readFileSync(f.source).equals(f.bytes)).toBe(true);
    expect(h.api.readZipEntries(fs.readFileSync(f.destination))).toHaveLength(sources.length); expect(h.state.files.size).toBe(0);
  });

  it("rechecks every source after the last processing-progress observer", async () => {
    const f = fixture(1), h = writerRealm(); let changed = false;
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }], {
      overwrite: true, onProgress: progress => {
        if (progress.bytes === 3 && !changed) { changed = true; fs.appendFileSync(f.source, Buffer.from("invented observer mutation")); }
      },
    })).rejects.toThrow(/source changed/i);
    expect(changed).toBe(true); expect(h.state.files.size).toBe(0);
    expect(fs.readFileSync(f.destination)).toEqual(f.sentinel);
    expect(fs.readdirSync(f.directory).filter(name => name.startsWith(".abs-profile-archive-"))).toEqual([]);
  });

  it("retains old-call defaults and no-clobber behavior", async () => {
    const f = fixture(9, false), h = writerRealm();
    const result = await h.api.writeZipArchive(f.destination, [{ name: "body", filePath: f.source }]);
    expect(result).toEqual({ entries: 1, bytes: fs.statSync(f.destination).size });
    const before = fs.readFileSync(f.destination);
    await expect(h.api.writeZipArchive(f.destination, [{ name: "body", data: Buffer.from("unapproved replacement") }])).rejects.toMatchObject({ code: "ARCHIVE_DESTINATION_EXISTS" });
    expect(fs.readFileSync(f.destination)).toEqual(before); expect(h.state.files.size).toBe(0);
  });
});
