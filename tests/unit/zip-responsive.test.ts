import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import * as vm from "node:vm";
import ts from "typescript";
import type { ZipGuard } from "../../src/main/services/zip-writer.js";

const CHUNK = 64 * 1024, BATCH = 4 * 1024 * 1024;
const roots: Array<{ directory: string; owner: fs.Stats }> = [];
const realms: Array<{ state: { files: Map<number, string>; codecs: number; frames: number; nativeFrameFaults: number; maxIO: number } }> = [];
let compiled: string;
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zip-responsive-"));
  roots.push({ directory, owner: fs.lstatSync(directory) }); return directory;
}
function realm(realClock = false) {
  compiled ??= ts.transpileModule(fs.readFileSync(new URL("../../src/main/services/zip-writer.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const state = {
    turns: 0, frames: 0, codecs: 0, deflates: 0, inflates: 0, nativeFrameFaults: 0, readLimit: 0, writeLimit: 0,
    files: new Map<number, string>(), reads: 0, writes: 0, maxIO: 0,
    onTurn: undefined as undefined | (() => void | Promise<void>),
    beforeRead: undefined as undefined | ((file: string, buffer: Buffer) => void),
    inspectCodec: undefined as undefined | ((stream: zlib.InflateRaw | zlib.DeflateRaw) => void),
    onRead: undefined as undefined | ((file: string, buffer: Buffer, offset: number, size: number, position: number) => void),
    onWrite: undefined as undefined | ((file: string, size: number) => void),
    onCodec: undefined as undefined | ((kind: "inflate" | "deflate") => void),
    onSync: undefined as undefined | ((file: string, directory: boolean) => void),
    onStat: undefined as undefined | ((file: string, fd: number) => void),
    onPublish: undefined as undefined | (() => void),
  };
  const disk = { ...fs,
    openSync(file: fs.PathLike, flags: number, mode?: number) {
      const fd = fs.openSync(file, flags, mode); state.files.set(fd, String(file)); return fd;
    },
    closeSync(fd: number) { fs.closeSync(fd); state.files.delete(fd); },
    fstatSync(fd: number) { state.onStat?.(state.files.get(fd)!, fd); return fs.fstatSync(fd); },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      state.beforeRead?.(state.files.get(fd)!, buffer);
      const n = fs.readSync(fd, buffer, offset, state.readLimit ? Math.max(0, Math.min(length, state.readLimit)) : length, position); state.reads++; state.maxIO = Math.max(state.maxIO, length);
      state.onRead?.(state.files.get(fd)!, buffer, offset, n, position); return n;
    },
    writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      const n = fs.writeSync(fd, buffer, offset, state.writeLimit ? Math.max(0, Math.min(length, state.writeLimit)) : length, position); state.writes++; state.maxIO = Math.max(state.maxIO, length);
      state.onWrite?.(state.files.get(fd)!, n); return n;
    },
    fsyncSync(fd: number) { state.onSync?.(state.files.get(fd)!, fs.fstatSync(fd).isDirectory()); fs.fsyncSync(fd); },
    linkSync(from: fs.PathLike, to: fs.PathLike) { fs.linkSync(from, to); state.onPublish?.(); },
    renameSync(from: fs.PathLike, to: fs.PathLike) { fs.renameSync(from, to); state.onPublish?.(); },
  };
  const codec = (kind: "inflate" | "deflate", options: zlib.ZlibOptions) => {
    const stream = kind === "inflate" ? zlib.createInflateRaw(options) : zlib.createDeflateRaw(options);
    state.codecs++; if (kind === "inflate") state.inflates++; else state.deflates++;
    stream.on("data", () => { if (state.frames) state.nativeFrameFaults++; });
    stream.once("close", () => { state.codecs--; }); state.inspectCodec?.(stream); state.onCodec?.(kind); return stream;
  };
  const dependencies = new Map<string, unknown>([
    ["node:fs", disk], ["node:path", path], ["node:os", os], ["node:crypto", crypto],
    ["node:zlib", { ...zlib,
      inflateRawSync() { throw new Error("async ZIP unexpectedly used blocking inflate"); },
      deflateRawSync() { throw new Error("async ZIP unexpectedly used blocking deflate"); },
      createInflateRaw: (options: zlib.ZlibOptions) => codec("inflate", options),
      createDeflateRaw: (options: zlib.ZlibOptions) => codec("deflate", options),
    }],
  ]);
  const context = vm.createContext({ Buffer, Date: realClock ? Date : class extends Date { static now() { return 1_800_000_000_000; } },
    setImmediate: (resume: () => void) => setImmediate(() => {
      expect(state.frames).toBe(0); state.turns++; const gate = state.onTurn?.();
      if (gate) void gate.then(resume); else resume();
    }),
  });
  const module = { exports: {} };
  vm.runInContext(`(function(require, module, exports) { ${compiled}\n})`, context)((name: string) => {
    if (!dependencies.has(name)) throw new Error("Unexpected ZIP dependency " + name);
    return dependencies.get(name);
  }, module, module.exports);
  const h = { api: module.exports as typeof import("../../src/main/services/zip-writer.js"), state };
  realms.push(h); return h;
}
function framed(h: ReturnType<typeof realm>): ZipGuard {
  const guard: ZipGuard = () => { if (!h.state.frames) return; expect(h.state.frames).toBe(1); };
  guard.runSynchronous = <T>(action: () => T): T => {
    expect(h.state.frames).toBe(0); h.state.frames++;
    try { return action(); } finally { h.state.frames--; }
  };
  return guard;
}
function captureOwnedBuffers(h: ReturnType<typeof realm>) {
  const reads = new Set<Buffer>(), inputs = new Set<Buffer>(), outputs = new Set<Buffer>();
  const unfinished = new Set<Buffer>(), streams: Array<zlib.InflateRaw | zlib.DeflateRaw> = [];
  let nativeErrors = 0, nativeErrorsAfterClose = 0;
  const prematureInputWipes: Array<{ phase: string; closed: boolean; expected: number; actual: number }> = [];
  h.state.beforeRead = (_file, buffer) => {
    // Poison even unread suffixes and zero-byte EOF probes. Only initialize each
    // actual buffer once, so short reads do not overwrite earlier bytes.
    if (!reads.has(buffer)) { reads.add(buffer); buffer.fill(0xa5); }
  };
  h.state.inspectCodec = stream => {
    streams.push(stream);
    const write = stream.write.bind(stream), pending = new Map<Buffer, number>();
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (error?: Error) => {
      const native = error as NodeJS.ErrnoException | undefined;
      if (native && (["Z_NEED_DICT", "Z_ERRNO", "Z_STREAM_ERROR", "Z_DATA_ERROR", "Z_MEM_ERROR", "Z_BUF_ERROR", "Z_VERSION_ERROR"] as const).some(code => native.code === code && native.errno === zlib.constants[code])) {
        nativeErrors++; if (stream.closed) nativeErrorsAfterClose++;
        // Native fatal completion calls destroy(error), but may emit no event
        // after an earlier Abort and may omit all outstanding write callbacks.
        for (const [chunk, expected] of pending) {
          const actual = h.api.crc32(chunk);
          if (actual !== expected) prematureInputWipes.push({ phase: "native error", closed: stream.closed, expected, actual });
          unfinished.delete(chunk);
        }
      }
      return destroy(error);
    };
    stream.once("close", () => {
      // Error callbacks do not prove native quiescence. Those inputs must still
      // be intact when close fires, before the production close waiter resumes.
      for (const [chunk, expected] of pending) { const actual = h.api.crc32(chunk); if (actual !== expected) prematureInputWipes.push({ phase: "close", closed: stream.closed, expected, actual }); }
    });
    stream.write = ((chunk: Buffer, callback: (error?: Error | null) => void) => {
      inputs.add(chunk); const expected = h.api.crc32(chunk); pending.set(chunk, expected); unfinished.add(chunk);
      return write(chunk, error => {
        unfinished.delete(chunk);
        // Before handing successful completion back, native input must still
        // contain the bytes submitted, never an early-cleared scratch alias.
        if (!error) { const actual = h.api.crc32(chunk); if (actual !== expected) prematureInputWipes.push({ phase: "success callback", closed: stream.closed, expected, actual }); pending.delete(chunk); }
        callback(error);
      });
    }) as typeof stream.write;
    stream.on("data", (chunk: Buffer) => { outputs.add(chunk); });
  };
  return { reads, inputs, outputs, streams, get nativeErrors() { return nativeErrors; }, get nativeErrorsAfterClose() { return nativeErrorsAfterClose; }, assertCleared() {
    expect(unfinished.size).toBe(0); expect(prematureInputWipes).toEqual([]);
    for (const [kind, buffers] of [["read", reads], ["native input", inputs], ["native output", outputs]] as const) {
      const dirty = [...buffers].map((buffer, index) => ({ index, length: buffer.length, firstNonzero: buffer.findIndex(byte => byte !== 0) })).filter(buffer => buffer.firstNonzero !== -1);
      expect(dirty, kind + " buffers must be zero after the operation settles").toEqual([]);
    }
  } };
}
// Independent standard ZIP fixtures; do not use the new writer to prove its reader.
function fixture(entries: Array<{ name: string; data?: Buffer; method?: number; size?: number; crc?: number; mode?: number }>): Buffer {
  const body: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0), method = entry.method ?? 0;
    const raw = method === 8 ? zlib.deflateRawSync(data) : data, name = Buffer.from(entry.name), crc = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30), c = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(entry.size ?? data.length, 22); local.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(raw.length, 20); c.writeUInt32LE(entry.size ?? data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((entry.mode ?? (entry.name.endsWith("/") ? 0o40700 : 0o100600)) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    body.push(local, name, raw); central.push(c, name); offset += local.length + name.length + raw.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, cd, end]);
}
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return (c ^ 0xffffffff) >>> 0;
}
function archive(zip: Buffer) {
  const directory = root(), file = path.join(directory, "invented.zip"), out = path.join(directory, "out");
  fs.writeFileSync(file, zip); return { directory, file, out };
}
afterEach(() => {
  for (const h of realms.splice(0)) { expect(h.state.files.size).toBe(0); expect(h.state.codecs).toBe(0); expect(h.state.frames).toBe(0); expect(h.state.nativeFrameFaults).toBe(0); expect(h.state.maxIO).toBeLessThanOrEqual(CHUNK); }
  for (const { directory, owner } of roots.splice(0)) {
    const resolved = path.resolve(directory), current = fs.lstatSync(resolved);
    if (resolved !== directory || path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("zip-responsive-") || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Refusing unowned ZIP fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("bounded asynchronous ZIP reads and streaming compression", () => {
  it.each([0, 8])("round-trips independent method %i entries without blocking inflate", async method => {
    const h = realm(), data = Buffer.alloc(2 * BATCH + 17, 0x6a), zip = fixture([{ name: "nested/body", data, method }]);
    const entries = await h.api.readZipEntriesAsync(zip, { guard: framed(h) });
    expect((await h.api.extractZipEntryAsync(zip, entries[0], { guard: framed(h) })).equals(data)).toBe(true);
    const f = archive(zip), result = await h.api.extractZipArchiveAsync(f.file, f.out, { guard: framed(h) });
    expect(result).toEqual({ files: 1, bytes: data.length }); expect(fs.readFileSync(path.join(f.out, "nested/body")).equals(data)).toBe(true);
    expect(h.state.turns).toBeGreaterThan(4); expect(h.state.inflates).toBe(method ? 2 : 0);
  });

  it.each([0, 8])("cancels a method %i member on a real macrotask within a finite byte batch", async method => {
    const h = realm(), data = Buffer.alloc(3 * BATCH + 17, 0x51), zip = fixture([{ name: "body", data, method }]);
    const entry = h.api.readZipEntries(zip)[0], controller = new AbortController(), buffers = captureOwnedBuffers(h), originalZip = Buffer.from(zip);
    let processed = 0, abortTurn = 0;
    await expect(h.api.extractZipEntryAsync(zip, entry, { signal: controller.signal, guard: framed(h), onProgress(value) {
      if (value.bytes && !processed) { processed = value.bytes; h.state.onTurn = () => { abortTurn++; h.state.onTurn = undefined; controller.abort(); }; }
    } })).rejects.toMatchObject({ code: "ABORT_ERR", name: "AbortError" });
    expect(processed).toBeGreaterThan(0); expect(processed).toBeLessThanOrEqual(BATCH); expect(abortTurn).toBe(1);
    expect(zip.equals(originalZip)).toBe(true); buffers.assertCleared();
  });

  it("cancels an already backpressured native write without draining a high-expansion member", async () => {
    const h = realm(), data = Buffer.alloc(2 * BATCH, 0x68), f = archive(fixture([{ name: "body", data, method: 8 }]));
    const buffers = captureOwnedBuffers(h), controller = new AbortController(); let bufferedAtAbort = 0, readsAtAbort = 0, writesAtAbort = 0;
    h.state.onCodec = kind => {
      if (kind !== "inflate") return;
      const stream = buffers.streams.at(-1)!; stream.pause();
      stream.once("readable", () => {
        bufferedAtAbort = stream.readableLength; readsAtAbort = h.state.reads; writesAtAbort = h.state.writes;
        controller.abort();
      });
    };
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { signal: controller.signal, guard: framed(h) })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(bufferedAtAbort).toBeGreaterThanOrEqual(CHUNK); expect(h.state.reads).toBe(readsAtAbort); expect(h.state.writes).toBe(writesAtAbort);
    expect([...buffers.outputs].reduce((sum, chunk) => sum + chunk.length, 0)).toBeLessThanOrEqual(2 * CHUNK);
    expect(fs.existsSync(f.out)).toBe(false); expect(buffers.nativeErrors).toBe(0); buffers.assertCleared();
  }, 5000);

  it.each([0, 8])("cancels method %i disk extraction, closes descriptors and removes only owned output", async method => {
    const h = realm(), f = archive(fixture([{ name: "nested/body", data: Buffer.alloc(3 * BATCH + 1, 0x4d), method }]));
    fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, "sentinel"), "invented existing bytes");
    const controller = new AbortController(), buffers = captureOwnedBuffers(h); let written = 0;
    h.state.onWrite = (file, n) => { if (file.endsWith("/nested/body")) { written += n; h.state.onTurn = () => { h.state.onTurn = undefined; controller.abort(); }; } };
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { signal: controller.signal, guard: framed(h) })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(written).toBeGreaterThan(0); expect(written).toBeLessThanOrEqual(BATCH);
    expect(fs.readdirSync(f.out)).toEqual(["sentinel"]); expect(fs.readFileSync(path.join(f.out, "sentinel"), "utf8")).toBe("invented existing bytes");
    buffers.assertCleared();
  });

  it("streams compressible data, preserves STORE default and remains readable by existing ZIP APIs", async () => {
    const h = realm(), directory = root(), source = path.join(directory, "source"), destination = path.join(directory, "compressed.zip");
    const data = Buffer.alloc(2 * BATCH + 17, 0x78); fs.writeFileSync(source, data);
    const progress: number[] = [];
    const result = await h.api.writeZipArchive(destination, [{ name: "empty/", isDirectory: true }, { name: "body", filePath: source }, { name: "zero", data: Buffer.alloc(0) }], {
      compression: "deflate", guard: framed(h), onProgress(value) { expect(h.state.frames).toBe(0); progress.push(value.bytes); },
    });
    const zip = fs.readFileSync(destination), entries = h.api.readZipEntries(zip);
    expect(entries.map(entry => entry.method)).toEqual([0, 8, 8]); expect(result.bytes).toBeLessThan(data.length / 10);
    expect(progress.at(-1)).toBe(data.length * 3); expect(progress.every((n, i) => !i || n >= progress[i - 1])).toBe(true);
    // Use the real legacy reader outside the realm that forbids blocking codecs.
    expect(zlib.inflateRawSync(zip.subarray(30 + Buffer.byteLength("empty/") + 30 + 4, entries[2].localHeaderOffset)).equals(data)).toBe(true);
    const extracted = path.join(directory, "extracted"); await h.api.extractZipArchiveAsync(destination, extracted);
    expect(fs.readFileSync(path.join(extracted, "body")).equals(data)).toBe(true);
    const stored = path.join(directory, "stored.zip"); await h.api.writeZipArchive(stored, [{ name: "body", data: Buffer.from("legacy store") }]);
    expect(h.api.readZipEntries(fs.readFileSync(stored))[0].method).toBe(0);
    expect(fs.readdirSync(directory).some(name => name.startsWith(".abs-profile-archive-"))).toBe(false);
  });

  it.each(["CRC prepass", "compression", "readback"] as const)("cancels DEFLATE during %s without replacing an existing archive", async phase => {
    const h = realm(), directory = root(), source = path.join(directory, "source"), destination = path.join(directory, "previous.zip");
    fs.writeFileSync(source, Buffer.alloc(3 * BATCH + 17, 0x54)); fs.writeFileSync(destination, "invented previous archive");
    const controller = new AbortController(), buffers = captureOwnedBuffers(h); let armed = false;
    const arm = () => { if (!armed) { armed = true; h.state.onTurn = () => { h.state.onTurn = undefined; controller.abort(); }; } };
    h.state.onRead = (file) => { if (phase === "CRC prepass" && file === source) arm(); };
    h.state.onCodec = kind => { if (phase === "compression" && kind === "deflate" || phase === "readback" && kind === "inflate") arm(); };
    await expect(h.api.writeZipArchive(destination, [{ name: "body", filePath: source }], { overwrite: true, compression: "deflate", signal: controller.signal, guard: framed(h) })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(armed).toBe(true); expect(fs.readFileSync(destination, "utf8")).toBe("invented previous archive");
    expect(fs.readdirSync(directory).sort()).toEqual(["previous.zip", "source"]);
    buffers.assertCleared();
  });

  it.each(["store", "deflate"] as const)("zeros private reads, EOF probes and native buffers after %s success without wiping public data", async compression => {
    const h = realm(), directory = root(), source = path.join(directory, "source"), destination = path.join(directory, "archive.zip");
    const data = Buffer.alloc(2 * CHUNK + 11, 0x5a), callerData = Buffer.from("caller-owned invented bytes"), buffers = captureOwnedBuffers(h);
    fs.writeFileSync(source, data);
    await h.api.writeZipArchive(destination, [{ name: "body", filePath: source }, { name: "caller", data: callerData }], { compression, guard: framed(h) });
    const zip = fs.readFileSync(destination), originalZip = Buffer.from(zip), entries = await h.api.readZipEntriesAsync(zip, { guard: framed(h) });
    const returned = await h.api.extractZipEntryAsync(zip, entries[0], { guard: framed(h) });
    expect(returned.equals(data)).toBe(true); expect(zip.equals(originalZip)).toBe(true);
    expect(callerData.toString()).toBe("caller-owned invented bytes");
    const out = path.join(directory, "out"); await h.api.extractZipArchiveAsync(destination, out, { guard: framed(h) });
    expect(fs.readFileSync(path.join(out, "body")).equals(data)).toBe(true);
    if (compression === "store") {
      expect(h.api.extractZipEntry(zip, entries[0]).equals(data)).toBe(true);
      h.api.extractZipArchive(destination, path.join(directory, "sync-out"));
    } else { expect(buffers.inputs.size).toBeGreaterThan(0); expect(buffers.outputs.size).toBeGreaterThan(0); }
    expect([...buffers.reads].some(buffer => buffer.length === 1)).toBe(true);
    expect(fs.readFileSync(source).equals(data)).toBe(true); expect(returned.equals(data)).toBe(true);
    buffers.assertCleared();
  });

  it.each(["cancel", "read error", "guard error"] as const)("zeros partial private metadata reads on %s including unread poisoned suffixes", async outcome => {
    const h = realm(), zip = fixture([{ name: "body", data: Buffer.alloc(CHUNK + 17, 0x6d) }]), f = archive(zip);
    const buffers = captureOwnedBuffers(h), controller = new AbortController(); let read = false;
    h.state.readLimit = 31;
    h.state.onRead = () => {
      if (read) return; read = true;
      if (outcome === "read error") throw new Error("invented partial read failure");
      if (outcome === "cancel") h.state.onTurn = () => { h.state.onTurn = undefined; controller.abort(); };
    };
    const guard = framed(h), options = { signal: controller.signal, guard: outcome === "guard error" ? Object.assign(() => { if (read) throw new Error("invented guard failure"); guard(); }, { runSynchronous: guard.runSynchronous }) : guard };
    const operation = h.api.extractZipArchiveAsync(f.file, f.out, options);
    if (outcome === "cancel") await expect(operation).rejects.toMatchObject({ code: "ABORT_ERR", name: "AbortError" });
    else await expect(operation).rejects.toThrow(/invented/);
    expect(read).toBe(true); expect([...buffers.reads].some(buffer => buffer.length > CHUNK)).toBe(true);
    expect(fs.readFileSync(f.file).equals(zip)).toBe(true); buffers.assertCleared();
  });

  it.each([0, 8])("zeros method %i read and native buffers when the output consumer fails", async method => {
    const h = realm(), f = archive(fixture([{ name: "body", data: Buffer.alloc(CHUNK + 17, 0x7b), method }])), buffers = captureOwnedBuffers(h);
    h.state.onWrite = file => { if (file === path.join(f.out, "body")) throw new Error("invented output consumer failure"); };
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { guard: framed(h) })).rejects.toThrow(/invented output consumer failure/);
    expect(buffers.reads.size).toBeGreaterThan(0);
    if (method === 8) { expect(buffers.inputs.size).toBeGreaterThan(0); expect(buffers.outputs.size).toBeGreaterThan(0); }
    buffers.assertCleared();
  });

  it("zeros the entire CRC scratch and poisoned EOF probe when the EOF syscall fails", async () => {
    const h = realm(), directory = root(), source = path.join(directory, "source"), buffers = captureOwnedBuffers(h);
    fs.writeFileSync(source, Buffer.from("invented short plaintext")); let failed = false;
    h.state.onRead = (file, _buffer, _offset, size) => { if (file === source && size === 0) { failed = true; throw new Error("invented EOF EIO"); } };
    await expect(h.api.writeZipArchive(path.join(directory, "archive.zip"), [{ name: "body", filePath: source }], { compression: "deflate", guard: framed(h) })).rejects.toThrow(/invented EOF EIO/);
    expect(failed).toBe(true); expect([...buffers.reads].map(buffer => buffer.length)).toEqual([CHUNK, 1]); buffers.assertCleared();
  });

  it("does not report cancellation or invoke observers after compressed publication", async () => {
    const h = realm(), directory = root(), destination = path.join(directory, "done.zip"), controller = new AbortController();
    let published = false;
    h.state.onPublish = () => { published = true; controller.abort(); };
    await expect(h.api.writeZipArchive(destination, [{ name: "body", data: Buffer.from("invented") }], { compression: "deflate", signal: controller.signal,
      guard() { expect(published).toBe(false); }, onProgress() { expect(published).toBe(false); },
    })).resolves.toMatchObject({ entries: 1 });
    expect(published).toBe(true); expect(fs.existsSync(destination)).toBe(true);
  });

  it("rejects a compressed bomb at declared output size and cleans staging", async () => {
    const h = realm(), f = archive(fixture([{ name: "bomb", data: Buffer.alloc(2 * BATCH, 0x61), method: 8, size: 7 }]));
    await expect(h.api.extractZipArchiveAsync(f.file, f.out)).rejects.toThrow("size mismatch"); expect(fs.existsSync(f.out)).toBe(false);
  });
  it.each([0, 8])("rejects method %i CRC corruption and cleans staging", async method => {
    const h = realm(), f = archive(fixture([{ name: "body", data: Buffer.from("invented CRC failure"), method, crc: 3 }]));
    await expect(h.api.extractZipArchiveAsync(f.file, f.out)).rejects.toThrow("CRC mismatch"); expect(fs.existsSync(f.out)).toBe(false);
  });
  it("rejects an output readback mismatch and fsync failure without returning partial success", async () => {
    for (const failure of ["readback", "fsync"]) {
      const h = realm(), f = archive(fixture([{ name: "body", data: Buffer.from("invented verified bytes"), method: 8 }]));
      if (failure === "readback") h.state.onRead = (file, buffer, offset, n) => { if (file.endsWith("/out/body") && n) buffer[offset] ^= 1; };
      else h.state.onSync = (_file, directory) => { if (!directory) throw new Error("invented fsync failure"); };
      await expect(h.api.extractZipArchiveAsync(f.file, f.out)).rejects.toThrow(failure === "readback" ? "readback" : "fsync"); expect(fs.existsSync(f.out)).toBe(false);
    }
  });
  it("closes an output descriptor when its first fstat fails without unlinking unknown identities", async () => {
    for (const replaced of [false, true]) {
      const h = realm(), f = archive(fixture([{ name: "body", data: Buffer.from("invented output bytes") }]));
      fs.mkdirSync(f.out);
      const target = path.join(f.out, "body"), sentinel = path.join(f.out, "sentinel"), quarantine = path.join(f.directory, "quarantined");
      fs.writeFileSync(sentinel, "untouched invented sentinel");
      let outputFd: number | undefined, initialStats = 0;
      h.state.onStat = (file, fd) => {
        if (file !== target) return;
        initialStats++; outputFd = fd; h.state.onStat = undefined;
        if (replaced) {
          // Both paths are literal descendants of this test's identity-checked root.
          expect(path.resolve(target)).toBe(target); expect(path.relative(f.directory, target)).toBe(path.join("out", "body"));
          expect(path.resolve(quarantine)).toBe(quarantine); expect(path.dirname(quarantine)).toBe(f.directory);
          expect(fs.lstatSync(target).isFile()).toBe(true); expect(fs.existsSync(quarantine)).toBe(false);
          fs.renameSync(target, quarantine); fs.symlinkSync(sentinel, target);
        }
        throw Object.assign(new Error("invented initial output fstat EIO"), { code: "EIO" });
      };
      try {
        await expect(h.api.extractZipArchiveAsync(f.file, f.out)).rejects.toThrow("invented initial output fstat EIO");
        expect(initialStats).toBe(1); expect(outputFd).toBeTypeOf("number");
        expect(h.state.files.size).toBe(0);
        expect(() => fs.fstatSync(outputFd!)).toThrow(/EBADF/);
        expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched invented sentinel");
        if (replaced) { expect(fs.lstatSync(target).isSymbolicLink()).toBe(true); expect(fs.statSync(quarantine).size).toBe(0); }
        else { expect(fs.lstatSync(target).isFile()).toBe(true); expect(fs.statSync(target).size).toBe(0); }
      } finally {
        h.state.onStat = undefined;
        // Keep a failing regression run from leaving its deliberately exposed fd open.
        for (const fd of [...h.state.files.keys()]) { fs.closeSync(fd); h.state.files.delete(fd); }
      }
    }
  });
  it("rejects later observer mutation of an earlier verified output", async () => {
    const h = realm(), f = archive(fixture([{ name: "first", data: Buffer.from("first") }, { name: "second", data: Buffer.alloc(BATCH + 1, 0x62) }]));
    let changed = false;
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { onProgress() {
      if (!changed && fs.existsSync(path.join(f.out, "second"))) { changed = true; fs.writeFileSync(path.join(f.out, "first"), "observer changed first file"); }
    } })).rejects.toThrow("changed"); expect(changed).toBe(true); expect(fs.existsSync(f.out)).toBe(false);
  });
  it("refuses symlink replacement cleanup and leaves unrelated sentinel bytes untouched", async () => {
    const h = realm(), f = archive(fixture([{ name: "body", data: Buffer.alloc(2 * BATCH, 0x4e) }]));
    const sentinel = path.join(f.directory, "sentinel"), target = path.join(f.out, "body"); fs.writeFileSync(sentinel, "untouched invented sentinel");
    let changed = false;
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { onProgress(value) {
      if (value.bytes && !changed) { changed = true; fs.renameSync(target, path.join(f.directory, "quarantined")); fs.symlinkSync(sentinel, target); }
    } })).rejects.toThrow("Refusing cleanup"); expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched invented sentinel"); expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });
  it.each(["../outside", "/absolute", "safe/../escape", "CON", "safe\\escape"])("retains strict path rejection for %s", async name => {
    const h = realm(), f = archive(fixture([{ name, data: Buffer.from("invented") }]));
    await expect(h.api.extractZipArchiveAsync(f.file, f.out)).rejects.toThrow("Unsafe ZIP"); expect(fs.existsSync(f.out)).toBe(false);
  });
  it("enforces extraction limits and rejects symlink entries before creating output", async () => {
    const h = realm(), f = archive(fixture([{ name: "body", data: Buffer.alloc(100) }]));
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { maxEntryBytes: 99 })).rejects.toThrow("too large");
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { maxTotalBytes: 99 })).rejects.toThrow("size limit");
    const link = archive(fixture([{ name: "link", data: Buffer.from("target"), mode: 0o120777 }]));
    await expect(h.api.extractZipArchiveAsync(link.file, link.out)).rejects.toThrow("symlink ZIP entry"); expect(fs.existsSync(f.out)).toBe(false);
  });
  it("bounds metadata-only traversal and admits cancellation with no payload", async () => {
    const h = realm(), zip = fixture(Array.from({ length: 1500 }, (_, i) => ({ name: `empty-${i}/` }))), controller = new AbortController();
    h.state.onTurn = () => { h.state.onTurn = undefined; controller.abort(); };
    await expect(h.api.readZipEntriesAsync(zip, { signal: controller.signal, guard: framed(h) })).rejects.toMatchObject({ code: "ABORT_ERR" }); expect(h.state.turns).toBe(1);
  });
  it.each(["guard", "progress", "skip"])("rejects asynchronous %s callbacks without unhandled rejection or leaked ownership", async callback => {
    const h = realm(), f = archive(fixture([{ name: "body", data: Buffer.from("invented") }]));
    const bad = () => Promise.reject(new Error("invented async rejection"));
    const options = callback === "guard" ? { guard: bad as unknown as ZipGuard } : callback === "progress" ? { onProgress: bad } : { skipNames: bad as unknown as (name: string) => boolean };
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, options)).rejects.toThrow("must be synchronous"); expect(fs.existsSync(f.out)).toBe(false);
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it.each([0, 8])("keeps partial method %i reads and writes cooperative and correct", async method => {
    const h = realm(), data = Buffer.alloc(CHUNK + 31, 0x5b), f = archive(fixture([{ name: "body", data, method }]));
    h.state.readLimit = 31; h.state.writeLimit = 17;
    let previous = 0, maxCalls = 0;
    h.state.onTurn = () => { const now = h.state.reads + h.state.writes; maxCalls = Math.max(maxCalls, now - previous); previous = now; };
    await h.api.extractZipArchiveAsync(f.file, f.out, { guard: framed(h) });
    expect(fs.readFileSync(path.join(f.out, "body")).equals(data)).toBe(true); expect(maxCalls).toBeLessThanOrEqual(130); expect(h.state.turns).toBeGreaterThan(30);
  });
  it.each([0, 8])("cancels inside partial method %i writes rather than draining an entire chunk", async method => {
    const h = realm(), f = archive(fixture([{ name: "body", data: Buffer.alloc(CHUNK + 1), method }])), controller = new AbortController();
    h.state.writeLimit = 1;
    h.state.onWrite = () => { h.state.onTurn = () => { h.state.onTurn = undefined; controller.abort(); }; };
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { signal: controller.signal, guard: framed(h) })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(h.state.writes).toBeLessThanOrEqual(128); expect(fs.existsSync(f.out)).toBe(false);
  });
  it("rejects broken native DEFLATE without hanging or leaking a codec", async () => {
    const h = realm(), buffers = captureOwnedBuffers(h), zip = fixture([{ name: "body", data: Buffer.alloc(CHUNK, 0x4a), method: 8 }]);
    const entry = h.api.readZipEntries(zip)[0]; zip.fill(0xff, 34, 34 + entry.compressedSize);
    const f = archive(zip); await expect(h.api.extractZipArchiveAsync(f.file, f.out)).rejects.toMatchObject({ code: "Z_DATA_ERROR" }); expect(fs.existsSync(f.out)).toBe(false);
    expect(buffers.inputs.size).toBeGreaterThan(0); expect(buffers.nativeErrors).toBe(1); buffers.assertCleared();
  });
  it("settles Abort before a later native fatal error even when close suppresses its error event and write callback", async () => {
    const h = realm(), buffers = captureOwnedBuffers(h), controller = new AbortController();
    const zip = fixture([{ name: "body", data: Buffer.alloc(CHUNK, 0x4a), method: 8 }]), entry = h.api.readZipEntries(zip)[0];
    zip.fill(0xff, 34, 34 + entry.compressedSize); const originalZip = Buffer.from(zip);
    h.state.onCodec = () => {
      const stream = buffers.streams.at(-1)!, write = stream.write.bind(stream);
      stream.write = ((chunk: Buffer, callback: (error?: Error | null) => void) => {
        const result = write(chunk, callback); controller.abort(); return result;
      }) as typeof stream.write;
    };
    await expect(h.api.extractZipEntryAsync(zip, entry, { signal: controller.signal, guard: framed(h) })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(buffers.nativeErrorsAfterClose).toBe(1); expect(zip.equals(originalZip)).toBe(true); buffers.assertCleared();
  }, 5000);

  it("stops every nested partial-read step after native failure without another disk or codec write attempt", async () => {
    const h = realm(), buffers = captureOwnedBuffers(h), zip = fixture([{ name: "body", data: crypto.randomBytes(3 * CHUNK), method: 8 }]);
    const entry = h.api.readZipEntries(zip)[0]; expect(entry.compressedSize).toBeGreaterThan(2 * CHUNK);
    zip.fill(0xff, 34, 34 + entry.compressedSize); const f = archive(zip);
    let codecWrites = 0, partial: Buffer | undefined, partialBytes = 0;
    let atFailure: { error: Error; reads: number; writes: number; codecWrites: number; partialBytes: number } | undefined;
    let nativeFailed!: () => void;
    const failureSeen = new Promise<void>(resolve => { nativeFailed = resolve; });
    h.state.onCodec = () => {
      const stream = buffers.streams.at(-1)!, write = stream.write.bind(stream);
      stream.write = ((chunk: Buffer, callback: (error?: Error | null) => void) => {
        codecWrites++; const result = write(chunk, callback); h.state.readLimit = 1; return result;
      }) as typeof stream.write;
      stream.once("error", error => {
        atFailure = { error, reads: h.state.reads, writes: h.state.writes, codecWrites, partialBytes };
        nativeFailed();
      });
    };
    h.state.onRead = (file, buffer, offset, size) => {
      if (file === f.file && codecWrites && !atFailure) { partial = buffer; partialBytes = offset + size; }
    };
    // Hold only the test continuation, never the native worker: prove the real
    // malformed-input error lands while the second raw allocation is partial.
    h.state.onTurn = () => { if (partial && !atFailure) return failureSeen; };
    await expect(h.api.extractZipArchiveAsync(f.file, f.out, { guard: framed(h) })).rejects.toMatchObject({ code: "Z_DATA_ERROR" });
    expect(atFailure?.error).toMatchObject({ code: "Z_DATA_ERROR" });
    expect(atFailure!.partialBytes).toBeGreaterThan(0); expect(atFailure!.partialBytes).toBeLessThan(CHUNK);
    expect(partial?.length).toBe(CHUNK); expect(h.state.reads).toBe(atFailure!.reads); expect(h.state.writes).toBe(atFailure!.writes);
    expect(atFailure!.codecWrites).toBe(1); expect(codecWrites).toBe(1); expect(buffers.nativeErrors).toBe(1);
    expect(fs.existsSync(f.out)).toBe(false); expect(fs.readFileSync(f.file).equals(zip)).toBe(true);
    expect(h.state.files.size).toBe(0); expect(h.state.codecs).toBe(0); expect(h.state.frames).toBe(0); expect(h.state.nativeFrameFaults).toBe(0);
    buffers.assertCleared();
  }, 5000);

  it("preserves a raced destination and refuses late source mutation for DEFLATE", async () => {
    for (const race of ["destination", "source"]) {
      const h = realm(), directory = root(), source = path.join(directory, "source"), destination = path.join(directory, "archive.zip"), data = Buffer.from("invented source witness");
      fs.writeFileSync(source, data); let changed = false;
      await expect(h.api.writeZipArchive(destination, [{ name: "body", filePath: source }], { compression: "deflate", onProgress(value) {
        if (changed) return;
        if (race === "destination" && value.items === 1) { changed = true; fs.writeFileSync(destination, "invented competing destination"); }
        if (race === "source" && value.bytes === data.length * 3) { changed = true; fs.appendFileSync(source, "changed after readback"); }
      } })).rejects.toThrow(race === "destination" ? "another writer" : "changed");
      expect(changed).toBe(true);
      if (race === "destination") expect(fs.readFileSync(destination, "utf8")).toBe("invented competing destination");
      else expect(fs.existsSync(destination)).toBe(false);
      expect(fs.readdirSync(directory).some(name => name.startsWith(".abs-profile-archive-"))).toBe(false);
    }
  });
  it("benchmarks an invented 128 MiB entry plus 2048 small entries and 4 MiB incompressible sample", async () => {
    const h = realm(true), directory = root(), source = path.join(directory, "invented-large"), destination = path.join(directory, "benchmark.zip");
    const largeBytes = 128 * 1024 * 1024, randomBytes = 4 * 1024 * 1024, block = Buffer.alloc(CHUNK, 0x61);
    const sourceFd = fs.openSync(source, "wx", 0o600);
    try { for (let offset = 0; offset < largeBytes; offset += CHUNK) fs.writeSync(sourceFd, block, 0, block.length, offset); fs.fsyncSync(sourceFd); }
    finally { fs.closeSync(sourceFd); }
    const small = Array.from({ length: 2048 }, (_, index) => ({ name: `small/item-${index}.json`, data: Buffer.from(JSON.stringify({ invented: true, index, padding: "x".repeat(512) })) }));
    const entries = [{ name: "CacheStorage/invented-large", filePath: source }, ...small, { name: "invented-incompressible", data: crypto.randomBytes(randomBytes) }];
    const rawBytes = largeBytes + randomBytes + small.reduce((sum, entry) => sum + entry.data.length, 0);
    let heartbeats = 0, last = performance.now(), maxGapMs = 0, completedBytes = 0;
    const heartbeat = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; heartbeats++; }, 1);
    const started = performance.now();
    let result: Awaited<ReturnType<typeof h.api.writeZipArchive>>;
    try { result = await h.api.writeZipArchive(destination, entries, { compression: "deflate", guard: framed(h), onProgress(value) { completedBytes = value.bytes; } }); }
    finally { clearInterval(heartbeat); }
    const elapsedMs = performance.now() - started;
    const parsed = await h.api.readZipEntriesAsync(fs.readFileSync(destination));
    expect(parsed).toHaveLength(2050); expect(parsed[0].uncompressedSize).toBe(largeBytes); expect(result!.bytes).toBeLessThan(rawBytes / 20);
    expect(completedBytes).toBe(rawBytes * 3); expect(heartbeats).toBeGreaterThan(10);
    const controller = new AbortController(), cancelTarget = path.join(directory, "cancelled.zip");
    let cancelAt = 0;
    await expect(h.api.writeZipArchive(cancelTarget, [{ name: "large", filePath: source }], { compression: "deflate", signal: controller.signal, onProgress(value) {
      if (value.bytes && !cancelAt) h.state.onTurn = () => { h.state.onTurn = undefined; cancelAt = performance.now(); controller.abort(); };
    } })).rejects.toMatchObject({ code: "ABORT_ERR" });
    const cancelCleanupMs = performance.now() - cancelAt;
    expect(fs.existsSync(cancelTarget)).toBe(false);
    console.info("ZIP_SYNTHETIC_BENCHMARK " + JSON.stringify({ largeBytes, smallEntries: small.length, randomBytes, rawBytes, zipBytes: result!.bytes,
      elapsedMs: Math.round(elapsedMs), heartbeats, maxHeartbeatGapMs: Number(maxGapMs.toFixed(1)), cancelAndCleanupMs: Number(cancelCleanupMs.toFixed(1)), maxIORequest: h.state.maxIO,
      note: "invented repeatable bulk bytes plus random sample; no real profile, process scans, browser or network; not a production compression estimate" }));
  }, 60_000);
});
