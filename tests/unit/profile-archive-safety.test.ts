// Real, disposable file trees; only Electron/status and individual fs syscalls
// are intercepted. No user profile, browser instance, SQLite engine or cloud.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import type * as Fs from "node:fs";

type IoEvent = {
  op: string; path: string; to?: string; fd?: number; buffer?: Buffer;
  offset?: number; length?: number; position?: number | null; flags?: string | number;
  stat?: Fs.Stats; directory?: boolean;
};
const io = vi.hoisted(() => ({
  appData: "", paths: new Map<number, string>(), events: [] as IoEvent[],
  hook: null as null | ((event: IoEvent) => void | { value: any }),
  streams: [] as Fs.WriteStream[],
  running: false, statusExtra: {} as Record<string, unknown>, inspectStatus: null as null | ((id: string) => void),
}));
vi.mock("electron", () => ({
  app: { getPath: () => io.appData }, BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  statusBrowser: (id: string) => { io.inspectStatus?.(id); return { running: io.running, pid: null, ...io.statusExtra }; },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const intercept = <T>(event: IoEvent, action: () => T): T => {
    io.events.push(event);
    const result = io.hook?.(event);
    return result ? result.value as T : action();
  };
  return {
    ...actual,
    openSync: (file: any, flags: any, mode?: any) => {
      const name = String(file);
      const fd = intercept({ op: "open", path: name, flags }, () => actual.openSync(file, flags, mode));
      io.paths.set(fd, name);
      return fd;
    },
    closeSync: (fd: number) => {
      intercept({ op: "close", path: io.paths.get(fd) || "", fd }, () => actual.closeSync(fd));
      io.paths.delete(fd);
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) =>
      intercept({ op: "read", path: io.paths.get(fd) || "", fd, buffer, offset, length, position },
        () => actual.readSync(fd, buffer, offset, length, position)),
    writeSync: (fd: number, buffer: Buffer, offset = 0, length = buffer.length - offset, position?: number | null) =>
      intercept({ op: "write", path: io.paths.get(fd) || "", fd, buffer, offset, length, position },
        () => actual.writeSync(fd, buffer, offset, length, position)),
    readFileSync: (file: any, ...args: any[]) =>
      intercept({ op: "readFile", path: typeof file === "number" ? io.paths.get(file) || "" : String(file) },
        () => (actual.readFileSync as any)(file, ...args)),
    lstatSync: (file: any, ...args: any[]) => {
      const stat = (actual.lstatSync as any)(file, ...args);
      return intercept({ op: "lstat", path: String(file), stat }, () => stat);
    },
    statSync: (file: any, ...args: any[]) => {
      const stat = (actual.statSync as any)(file, ...args);
      return intercept({ op: "stat", path: String(file), stat }, () => stat);
    },
    fstatSync: (fd: number, ...args: any[]) => {
      const stat = (actual.fstatSync as any)(fd, ...args);
      return intercept({ op: "fstat", path: io.paths.get(fd) || "", fd, stat }, () => stat);
    },
    fsyncSync: (fd: number) => intercept({
      op: "fsync", path: io.paths.get(fd) || "", fd, directory: actual.fstatSync(fd).isDirectory(),
    }, () => actual.fsyncSync(fd)),
    renameSync: (from: any, to: any) => intercept({ op: "rename", path: String(from), to: String(to) }, () => actual.renameSync(from, to)),
    linkSync: (from: any, to: any) => intercept({ op: "link", path: String(from), to: String(to) }, () => actual.linkSync(from, to)),
    unlinkSync: (file: any) => intercept({ op: "unlink", path: String(file) }, () => actual.unlinkSync(file)),
    rmSync: (file: any, options: any) => intercept({ op: "rm", path: String(file) }, () => actual.rmSync(file, options)),
    mkdirSync: (file: any, options: any) => intercept({ op: "mkdir", path: String(file) }, () => actual.mkdirSync(file, options)),
    mkdtempSync: (prefix: any, ...args: any[]) => intercept({ op: "mkdtemp", path: String(prefix) }, () => (actual.mkdtempSync as any)(prefix, ...args)),
    // Exercise the old writer's real stream too, so RED sees its destructive
    // final-path open. The replacement uses intercepted, real writeSync calls.
    createWriteStream: (file: any, options: any) => {
      const stream = actual.createWriteStream(file, options);
      io.streams.push(stream);
      stream.on("error", () => undefined);
      const write = stream.write.bind(stream);
      stream.write = ((buffer: Buffer, callback: (error?: Error) => void) => {
        try { intercept({ op: "streamWrite", path: String(file), buffer, length: buffer.length }, () => undefined); }
        catch (error) { callback(error as Error); stream.destroy(); return false; }
        return write(buffer, callback);
      }) as typeof stream.write;
      return stream;
    },
  };
});

const disk = await vi.importActual<typeof import("node:fs")>("node:fs");
const ROOT = disk.mkdtempSync(path.join(os.tmpdir(), "abs-archive-safety-"));
io.appData = path.join(ROOT, "user-data");
const WORK = path.join(ROOT, "work");
import { writeZipArchive, readZipEntries, extractZipEntry, extractZipArchive, MAX_ZIP_ENTRIES } from "../../src/main/services/zip-writer.js";
import { exportProfileArchive, importProfileArchive } from "../../src/main/services/profile-archive.js";
import { getConfig, getConfigPath, getProfileMeta, getProfilesDir, reloadConfig } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import { acquireRestoreLock, isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";
import { PROFILE_ID_PREFIX } from "../../src/main/branding.js";
import { getProfileDataRevision } from "../../src/main/services/profile-data-revision.js";

function failure(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected ${syscall} failure`), { code, syscall });
}
const overwrite = { overwrite: true };
const write = writeZipArchive;
const exportProfile = exportProfileArchive;

async function settleStreams(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const stream of io.streams.splice(0)) {
    if (stream.closed) continue;
    await new Promise<void>((resolve) => { stream.once("close", resolve); stream.destroy(); });
  }
}
beforeEach(() => {
  io.hook = null; io.events = []; io.running = false; io.statusExtra = {}; io.inspectStatus = null;
  disk.rmSync(WORK, { recursive: true, force: true });
  disk.rmSync(io.appData, { recursive: true, force: true });
  disk.mkdirSync(WORK, { recursive: true, mode: 0o700 });
  reloadConfig(); getConfig();
});
afterEach(async () => {
  io.hook = null; io.inspectStatus = null;
  vi.restoreAllMocks();
  await settleStreams();
  expect(io.paths.size, "all intercepted descriptors closed").toBe(0);
});
afterAll(() => disk.rmSync(ROOT, { recursive: true, force: true }));

async function existingBackup(): Promise<{ dest: string; before: Buffer; source: string }> {
  const dest = path.join(WORK, "backup.zip");
  const source = path.join(WORK, "source.bin");
  disk.writeFileSync(source, Buffer.alloc(100_000, 0x41));
  await write(dest, [{ name: "old.txt", data: Buffer.from("last valid backup") }]);
  await settleStreams();
  return { dest, before: disk.readFileSync(dest), source };
}
function expectOnlyFixtureFiles(): void {
  expect(disk.readdirSync(WORK).sort()).toEqual(["backup.zip", "source.bin"]);
}
function makeProfile(id = "ab_synthetic", name = "Synthetic"): string {
  const dir = path.join(getProfilesDir(), id);
  disk.mkdirSync(path.join(dir, "Default"), { recursive: true, mode: 0o700 });
  disk.writeFileSync(path.join(dir, "Default", "Preferences"), '{"synthetic":true}');
  transact((draft) => { draft.browserProfiles[id] = { name, platform: "windows", fingerprintSeed: 12345 }; });
  return id;
}
async function importFixture(): Promise<string> {
  const zip = path.join(WORK, "import.zip");
  await write(zip, [
    { name: "meta.json", data: Buffer.from(JSON.stringify({ formatVersion: 1, profile: { name: "Incoming", platform: "windows", fingerprintSeed: 12345 } })) },
    { name: "Default/Preferences", data: Buffer.from('{"incoming":true}') },
  ]);
  await settleStreams();
  return zip;
}
function frozenImportId(): string {
  const now = 1700000000123;
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(Math, "random").mockReturnValue(0.25);
  return PROFILE_ID_PREFIX + now.toString(36) + "_" + (0.25).toString(36).substring(2, 8);
}
async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  try { Object.defineProperty(process, "platform", { value: platform }); return await run(); }
  finally { Object.defineProperty(process, "platform", original); }
}

describe("ZIP staged verified publication", () => {
  it("rejects an existing destination by default with a stable code and unchanged bytes", async () => {
    const { dest, before } = await existingBackup();
    await expect(write(dest, [{ name: "new.txt", data: Buffer.from("new") }])).rejects.toMatchObject({ code: "ARCHIVE_DESTINATION_EXISTS" });
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it("does not truncate an old valid backup when a source is missing", async () => {
    const { dest, before } = await existingBackup();
    await expect(write(dest, [{ name: "missing", filePath: path.join(WORK, "absent") }], overwrite)).rejects.toThrow();
    await settleStreams();
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it.each(["EIO", "ENOSPC"])("preserves the backup on a real mid-write %s", async (code) => {
    const { dest, before, source } = await existingBackup();
    let writes = 0;
    io.hook = (e) => {
      if (["write", "streamWrite"].includes(e.op) && e.path !== source && ++writes === 3) throw failure(code, "write");
    };
    await expect(write(dest, [{ name: "data", filePath: source }], overwrite)).rejects.toThrow(code);
    await settleStreams(); io.hook = null;
    expect(writes).toBeGreaterThanOrEqual(3);
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it.each(["crc-prepass", "body"])("rejects a premature zero read in the %s without publication", async (phase) => {
    const { dest, before, source } = await existingBackup();
    let passes = 0;
    io.hook = (e) => {
      if (e.op !== "read" || e.path !== source) return;
      if (e.position === 0) passes++;
      if (passes !== (phase === "body" ? 2 : 1)) return;
      if (Number(e.position) >= 17) return { value: 0 };
      return { value: disk.readSync(e.fd!, e.buffer!, e.offset!, Math.min(17, e.length!), e.position!) };
    };
    await expect(write(dest, [{ name: "data", filePath: source }], overwrite)).rejects.toThrow(/read|changed|size|EOF/i);
    await settleStreams(); io.hook = null;
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it.each(["same-length", "grow", "shrink"])("rejects %s source mutation between CRC prepass and body", async (kind) => {
    const { dest, before, source } = await existingBackup();
    let starts = 0;
    io.hook = (e) => {
      if (e.op !== "read" || e.path !== source || e.position !== 0 || ++starts !== 2) return;
      if (kind === "same-length") disk.writeFileSync(source, Buffer.alloc(100_000, 0x42));
      else disk.truncateSync(source, kind === "grow" ? 100_001 : 10);
    };
    await expect(write(dest, [{ name: "data", filePath: source }], overwrite)).rejects.toThrow(/changed|size|read|CRC/i);
    await settleStreams(); io.hook = null;
    expect(starts).toBe(2);
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it("accounts for positive short reads and writes using actual bytes", async () => {
    const { dest, source } = await existingBackup();
    io.hook = (e) => {
      if (e.op === "read") return { value: disk.readSync(e.fd!, e.buffer!, e.offset!, Math.min(997, e.length!), e.position!) };
      if (e.op === "write") return { value: disk.writeSync(e.fd!, e.buffer!, e.offset!, Math.min(113, e.length!), e.position) };
    };
    const result = await write(dest, [{ name: "data", filePath: source }], overwrite);
    io.hook = null;
    const zip = disk.readFileSync(dest);
    expect(result.bytes).toBe(zip.length);
    expect(extractZipEntry(zip, readZipEntries(zip)[0])).toEqual(disk.readFileSync(source));
    expectOnlyFixtureFiles();
  });

  it("rejects zero-progress writes instead of publishing a truncated file", async () => {
    const { dest, before } = await existingBackup();
    io.hook = (e) => e.op === "write" ? { value: 0 } : undefined;
    await expect(write(dest, [{ name: "data", data: Buffer.from("x") }], overwrite)).rejects.toThrow(/write|progress/i);
    io.hook = null;
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it("streams closed-file readback with bounded reads before atomic publication", async () => {
    const dest = path.join(WORK, "new.zip");
    const payload = Buffer.alloc(180_000, 0x5a);
    io.events = [];
    io.hook = (e) => {
      if (e.op === "readFile" && path.dirname(e.path) === WORK) throw new Error("whole archive read is forbidden");
      if (e.op === "read" && path.dirname(e.path) === WORK) {
        expect(disk.existsSync(dest)).toBe(false);
        expect(e.length).toBeLessThanOrEqual(64 * 1024);
      }
      if ((e.op === "rename" || e.op === "link") && e.to === dest) {
        expect(disk.existsSync(dest)).toBe(false);
        expect(path.dirname(e.path)).toBe(path.dirname(dest));
        expect(io.events.some((v) => v.op === "fsync" && !v.directory && v.path === e.path)).toBe(true);
        expect(io.events.some((v) => v.op === "close" && v.path === e.path)).toBe(true);
        expect(io.events.some((v) => v.op === "read" && v.path === e.path)).toBe(true);
      }
    };
    await write(dest, [{ name: "payload", data: payload }]);
    io.hook = null;
    const publication = io.events.find((e) => (e.op === "rename" || e.op === "link") && e.to === dest);
    expect(publication).toBeDefined();
    const creation = io.events.find((e) => e.op === "open" && e.path === publication!.path);
    expect(typeof creation!.flags === "number" ? creation!.flags & disk.constants.O_EXCL : String(creation!.flags).includes("x")).toBeTruthy();
    const zip = disk.readFileSync(dest);
    expect(extractZipEntry(zip, readZipEntries(zip)[0])).toEqual(payload);
    expect(disk.readdirSync(WORK)).toEqual(["new.zip"]);
  });

  it("rechecks the verified staging snapshot immediately before publication", async () => {
    const { dest, before } = await existingBackup();
    io.events = [];
    let changed = false;
    io.hook = (e) => {
      if (changed || e.op !== "fsync" || !e.directory) return;
      const staged = io.events.find((event) => event.op === "read" && path.dirname(event.path) === WORK && event.path !== dest)?.path;
      if (!staged) return;
      changed = true;
      const fd = disk.openSync(staged, "r+");
      try { disk.writeSync(fd, Buffer.from([0xff]), 0, 1, 31); }
      finally { disk.closeSync(fd); }
    };
    await expect(write(dest, [{ name: "x", data: Buffer.from("verified") }], overwrite)).rejects.toThrow(/changed|CRC|verif/i);
    io.hook = null;
    expect(changed).toBe(true);
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it("preserves the old file when confirmed replacement rename fails", async () => {
    const { dest, before } = await existingBackup();
    io.hook = (e) => { if (e.op === "rename" && e.to === dest) throw failure("EIO", "rename"); };
    await expect(write(dest, [{ name: "x", data: Buffer.from("new") }], overwrite)).rejects.toThrow("EIO");
    io.hook = null;
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it("does not replace a destination changed after overwrite preflight", async () => {
    const { dest } = await existingBackup();
    const concurrent = Buffer.from("concurrently updated destination");
    let changed = false;
    io.hook = (e) => {
      if (!changed && e.op === "fsync" && e.directory) { changed = true; disk.writeFileSync(dest, concurrent); }
    };
    await expect(write(dest, [{ name: "x", data: Buffer.from("new") }], overwrite)).rejects.toMatchObject({ code: "ARCHIVE_DESTINATION_CHANGED" });
    io.hook = null;
    expect(disk.readFileSync(dest)).toEqual(concurrent);
    expectOnlyFixtureFiles();
  });

  it("rejects corruption discovered by readback and preserves the previous backup", async () => {
    const { dest, source, before } = await existingBackup();
    let damaged = false;
    io.hook = (e) => {
      if (damaged || e.op !== "read" || e.path === source || path.dirname(e.path) !== WORK) return;
      damaged = true;
      const fd = disk.openSync(e.path, "r+");
      try { disk.writeSync(fd, Buffer.from([0xff]), 0, 1, 30 + Buffer.byteLength("data")); }
      finally { disk.closeSync(fd); }
    };
    await expect(write(dest, [{ name: "data", filePath: source }], overwrite)).rejects.toThrow(/CRC|changed|verif/i);
    io.hook = null;
    expect(damaged).toBe(true);
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it.each(["file", "directory"])("fails closed on precommit %s fsync failure", async (kind) => {
    const { dest, source, before } = await existingBackup();
    io.hook = (e) => { if (e.op === "fsync" && e.directory === (kind === "directory")) throw failure("EIO", "fsync"); };
    await expect(write(dest, [{ name: "data", filePath: source }], overwrite)).rejects.toThrow("EIO");
    io.hook = null;
    expect(disk.readFileSync(dest)).toEqual(before);
    expectOnlyFixtureFiles();
  });

  it("never clobbers a destination created between preflight and publication", async () => {
    const dest = path.join(WORK, "race.zip");
    const concurrent = Buffer.from("another writer owns this path");
    io.hook = (e) => {
      if ((e.op === "link" || e.op === "rename") && e.to === dest) disk.writeFileSync(dest, concurrent, { flag: "wx" });
    };
    await expect(write(dest, [{ name: "x", data: Buffer.from("x") }])).rejects.toMatchObject({ code: "ARCHIVE_DESTINATION_EXISTS" });
    io.hook = null;
    expect(disk.readFileSync(dest)).toEqual(concurrent);
    expect(disk.readdirSync(WORK)).toEqual(["race.zip"]);
  });

  it("reports post-publication cleanup/durability failures without claiming rollback", async () => {
    const dest = path.join(WORK, "committed.zip");
    let published = false;
    io.hook = (e) => {
      if ((e.op === "link" || e.op === "rename") && e.to === dest) published = true;
      if (published && (e.op === "unlink" || (e.op === "fsync" && e.directory))) throw failure("EIO", e.op);
    };
    const result = await write(dest, [{ name: "x", data: Buffer.from("committed") }]);
    io.hook = null;
    expect((result as any).warnings).toEqual(expect.arrayContaining([expect.stringMatching(/committed|published|cleanup|durab/i)]));
    const zip = disk.readFileSync(dest);
    expect(extractZipEntry(zip, readZipEntries(zip)[0]).toString()).toBe("committed");
  });

  it("tolerates only the precise unsupported Windows directory-fsync case", async () => {
    io.hook = (e) => { if (e.op === "fsync" && e.directory) throw failure("EPERM", "fsync"); };
    await onPlatform("win32", () => write(path.join(WORK, "supported.zip"), [{ name: "x", data: Buffer.from("x") }]));
    expect(io.events.some((e) => e.op === "fsync" && !e.directory)).toBe(true);
    expect(io.events.some((e) => e.op === "fsync" && e.directory)).toBe(true);
  });

  it.each(["EACCES", "EIO", "ENOSPC"])("does not swallow Windows directory %s as unsupported fsync", async (code) => {
    const { dest, before } = await existingBackup();
    io.hook = (e) => { if (e.op === "fsync" && e.directory) throw failure(code, "fsync"); };
    await onPlatform("win32", async () => {
      await expect(write(dest, [{ name: "x", data: Buffer.from("x") }], overwrite)).rejects.toThrow(code);
    });
    io.hook = null;
    expect(disk.readFileSync(dest)).toEqual(before);
  });

  it("rejects a source symlink without reading its independently owned target", async () => {
    const { dest, before, source } = await existingBackup();
    const link = path.join(WORK, "link");
    disk.symlinkSync(source, link);
    io.hook = (e) => { if (e.op === "read" && e.path === link) throw new Error("must not read test symlinks"); };
    await expect(write(dest, [{ name: "x", filePath: link }], overwrite)).rejects.toThrow(/symlink|regular|source/i);
    io.hook = null;
    expect(disk.readFileSync(dest)).toEqual(before);
  });

  it("enforces the reader's entry-count limit before creating output", async () => {
    const dest = path.join(WORK, "count.zip");
    await expect(write(dest, Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `entry-${i}`, data: Buffer.alloc(0) })))).rejects.toThrow(/entry count/i);
    expect(disk.existsSync(dest)).toBe(false);
  });

  it.each(["entry", "total"])("enforces the %s size limit before reading payloads (small real files, scoped stat sizes)", async (kind) => {
    const source = path.join(WORK, "small-source");
    disk.writeFileSync(source, "small real source");
    let payloadReads = 0;
    io.hook = (e) => {
      if (["stat", "lstat", "fstat"].includes(e.op) && e.path === source) {
        Object.defineProperty(e.stat!, "size", { value: 512 * 1024 * 1024 + (kind === "entry" ? 1 : 0) });
      }
      if (e.op === "read" && e.path === source) payloadReads++;
    };
    const dest = path.join(WORK, "size.zip");
    const entries = Array.from({ length: kind === "total" ? 5 : 1 }, (_, i) => ({ name: `data-${i}`, filePath: source }));
    await expect(write(dest, entries)).rejects.toThrow(/too large|size limit/i);
    io.hook = null;
    expect(payloadReads).toBe(0);
    expect(disk.existsSync(dest)).toBe(false);
  });

  it.each([
    ["../escape"], ["/absolute"], ["a\\b"], ["C:/absolute"],
    ["same", "same"], ["data", "data/child"], ["Case", "case"], ["a/./b"],
  ])("rejects unsafe or conflicting writer names %j", async (...names) => {
    const dest = path.join(WORK, "unsafe.zip");
    await expect(write(dest, names.map((name) => ({ name, data: Buffer.from("x") })))).rejects.toThrow(/unsafe|conflict|duplicate/i);
    expect(disk.existsSync(dest)).toBe(false);
  });
});

describe("ZIP extraction with real short writes and hostile bytes", () => {
  it.each([7, 0])("accounts for extraction writes returning %i bytes", async (amount) => {
    const zip = path.join(WORK, "extract.zip");
    const payload = Buffer.alloc(90_000, 0x6b);
    await write(zip, [{ name: "data", data: payload }]);
    const dest = path.join(WORK, "extracted");
    io.hook = (e) => {
      if (e.op === "write" && e.path.startsWith(dest + path.sep)) {
        return { value: amount === 0 ? 0 : disk.writeSync(e.fd!, e.buffer!, e.offset!, Math.min(amount, e.length!), e.position) };
      }
    };
    if (!amount) expect(() => extractZipArchive(zip, dest)).toThrow(/write|progress/i);
    else {
      expect(extractZipArchive(zip, dest)).toEqual({ files: 1, bytes: payload.length });
      expect(disk.readFileSync(path.join(dest, "data"))).toEqual(payload);
    }
  });

  it("rejects CRC-corrupted payloads and central/local disagreement", async () => {
    const zipPath = path.join(WORK, "corrupt.zip");
    await write(zipPath, [{ name: "data", data: Buffer.from("data") }]);
    const original = disk.readFileSync(zipPath);
    const corrupt = Buffer.from(original); corrupt[34] ^= 1;
    disk.writeFileSync(zipPath, corrupt);
    expect(() => extractZipArchive(zipPath, path.join(WORK, "crc"))).toThrow(/CRC/i);
    const mismatch = Buffer.from(original); mismatch.write("evil", 30, "utf8");
    disk.writeFileSync(zipPath, mismatch);
    expect(() => extractZipArchive(zipPath, path.join(WORK, "name"))).toThrow(/header|name|mismatch/i);
  });

  it("refuses a symlinked extraction ancestor before opening its target", async () => {
    const zip = path.join(WORK, "links.zip");
    await write(zip, [{ name: "link/new-file", data: Buffer.from("x") }]);
    const dest = path.join(WORK, "dest"), other = path.join(WORK, "other");
    disk.mkdirSync(dest); disk.mkdirSync(other); disk.symlinkSync(other, path.join(dest, "link"));
    io.hook = (e) => { if (e.op === "open" && e.path.startsWith(path.join(dest, "link") + path.sep)) throw new Error("must not open a symlinked test path"); };
    expect(() => extractZipArchive(zip, dest)).toThrow(/symlink/i);
    expect(disk.readdirSync(other)).toEqual([]);
  });
});

describe("profile archive ownership, restore lock and live config commit", () => {
  it("takes the existing restore lock through status, data reads, verification and publication", async () => {
    const id = makeProfile();
    io.inspectStatus = (checked) => expect(isRestoreLocked(checked)).toBe(true);
    let reads = 0, published = false;
    const dest = path.join(WORK, "profile.zip");
    io.hook = (e) => {
      if (e.op === "read" && e.path.includes(`${path.sep}${id}${path.sep}`)) { reads++; expect(isRestoreLocked(id)).toBe(true); }
      if ((e.op === "rename" || e.op === "link") && e.to === dest) { published = true; expect(isRestoreLocked(id)).toBe(true); }
    };
    await exportProfile(id, dest);
    expect(reads).toBeGreaterThan(0); expect(published).toBe(true); expect(isRestoreLocked(id)).toBe(false);
  });

  it("rejects an already-held restore lock and releases its own lock after failure", async () => {
    const id = makeProfile(), dest = path.join(WORK, "locked.zip");
    const release = acquireRestoreLock(id);
    try { await expect(exportProfile(id, dest)).rejects.toThrow(/in progress|lock/i); }
    finally { release(); }
    io.running = true;
    await expect(exportProfile(id, dest)).rejects.toThrow(/stop/i);
    expect(isRestoreLocked(id)).toBe(false); expect(disk.existsSync(dest)).toBe(false);
  });

  it.each([{ pid: 1234 }, { stopping: true }, { state: "unknown" }])("refuses export while exit is unconfirmed: %j", async (extra) => {
    const id = makeProfile(), dest = path.join(WORK, "unconfirmed.zip");
    const before = getProfileDataRevision(id);
    io.statusExtra = extra;
    await expect(exportProfile(id, dest)).rejects.toMatchObject({ code: "PROFILE_STOP_REQUIRED" });
    expect(disk.existsSync(dest)).toBe(false); expect(isRestoreLocked(id)).toBe(false);
    expect(getProfileDataRevision(id)).toBe(before);
  });

  it.each(["SingletonLock", "SingletonCookie", "SingletonSocket", "parent.lock", ".parentlock", "lock"])("refuses dangling browser ownership marker %s without removing it", async (name) => {
    const id = makeProfile(), dest = path.join(WORK, "marker.zip");
    const marker = path.join(getProfilesDir(), id, name);
    disk.symlinkSync(path.join(ROOT, "owned-missing-lock-target"), marker);
    await expect(exportProfile(id, dest)).rejects.toMatchObject({ code: "PROFILE_STOP_REQUIRED" });
    expect(disk.lstatSync(marker).isSymbolicLink()).toBe(true);
    expect(disk.existsSync(dest)).toBe(false); expect(isRestoreLocked(id)).toBe(false);
  });

  it.each([".parentlock", "parent.lock"])("exports configured stopped Firefox with inert %s, retaining the source file but not archiving OS sentinels", async (name) => {
    const id = makeProfile(), dest = path.join(WORK, "inert-firefox.zip");
    transact((draft) => { draft.browserProfiles[id].engine = "firefox"; });
    const marker = path.join(getProfilesDir(), id, name); disk.writeFileSync(marker, "", { mode: 0o600 });
    const before = disk.lstatSync(marker), revision = getProfileDataRevision(id);
    const nested = path.join(getProfilesDir(), id, "Default", "nested", name); disk.mkdirSync(path.dirname(nested), { recursive: true }); disk.writeFileSync(nested, "owned nested payload, not an OS sentinel");
    await exportProfile(id, dest);
    expect(disk.readFileSync(marker)).toEqual(Buffer.alloc(0)); expect(disk.lstatSync(marker).ino).toBe(before.ino);
    const archive = disk.readFileSync(dest), entries = readZipEntries(archive);
    expect(entries.some((entry) => entry.name === name)).toBe(false);
    expect(extractZipEntry(archive, entries.find((entry) => entry.name === "Default/nested/" + name)!)).toEqual(disk.readFileSync(nested));
    expect(getProfileDataRevision(id)).toBe(revision); expect(isRestoreLocked(id)).toBe(false);
  });

  it("publishes a new local revision before the first imported profile file is adopted", async () => {
    const zip = await importFixture();
    let observed = false;
    io.hook = (event) => {
      if (event.op !== "rename" || !event.path.includes("profile-import-") || !event.to?.startsWith(getProfilesDir() + path.sep)) return;
      const id = path.relative(getProfilesDir(), event.to).split(path.sep)[0];
      observed = true;
      expect(isRestoreLocked(id)).toBe(true);
      expect(getProfileDataRevision(id)).not.toBe("initial");
      const value = JSON.parse(disk.readFileSync(path.join(io.appData, "profile-data-revisions", id + ".json"), "utf8"));
      expect(value.revision).toBe(getProfileDataRevision(id));
    };
    const imported = importProfileArchive(zip);
    expect(observed).toBe(true); expect(isRestoreLocked(imported.dirId)).toBe(false);
    expect(getProfileDataRevision(imported.dirId)).not.toBe("initial");
  });

  it("does not adopt files or metadata when revision durability fails", async () => {
    const existing = makeProfile("ab_revision_untouched", "Existing");
    const zip = await importFixture(), before = disk.readFileSync(getConfigPath());
    let failed = false;
    io.hook = (event) => {
      if (event.op === "fsync" && event.path.includes("profile-data-revisions") && !event.directory) {
        failed = true; throw failure("EIO", "revision fsync");
      }
    };
    expect(() => importProfileArchive(zip)).toThrow(/revision unavailable/i);
    io.hook = null;
    expect(failed).toBe(true);
    expect(disk.readFileSync(getConfigPath())).toEqual(before);
    expect(disk.readdirSync(getProfilesDir())).toEqual([existing]);
    reloadConfig(); expect(Object.keys(getConfig().browserProfiles)).toEqual([existing]);
    expect(getProfileDataRevision(existing)).toBe("initial");
  });

  it("stages imports under the profiles volume rather than the system temporary volume", async () => {
    const zip = await importFixture();
    let staged = false;
    io.hook = (e) => {
      if (e.op !== "mkdtemp") return;
      staged = true;
      expect(path.dirname(e.path)).toBe(getProfilesDir());
    };
    const imported = importProfileArchive(zip);
    expect(staged).toBe(true);
    expect(disk.readFileSync(path.join(getProfilesDir(), imported.dirId, "Default", "Preferences"), "utf8")).toBe('{"incoming":true}');
    expect(disk.readdirSync(getProfilesDir())).toEqual([imported.dirId]);
  });

  it.each(["directory", "config"])("never adopts or removes a pre-existing %s on ID collision", async (kind) => {
    const zip = await importFixture();
    const id = frozenImportId();
    if (kind === "config") makeProfile(id, "Existing owner");
    else disk.mkdirSync(path.join(getProfilesDir(), id), { recursive: true });
    const sentinel = path.join(getProfilesDir(), id, "sentinel");
    disk.writeFileSync(sentinel, "existing owner data");
    const before = disk.readFileSync(getConfigPath());
    expect(() => importProfileArchive(zip)).toThrow(/exist|collision|owned/i);
    expect(disk.readFileSync(sentinel, "utf8")).toBe("existing owner data");
    expect(disk.readFileSync(getConfigPath())).toEqual(before);
    reloadConfig();
    expect(getProfileMeta(id)?.name ?? null).toBe(kind === "config" ? "Existing owner" : null);
  });

  it("validates staged output bytes, not just input CRC and write return lengths", async () => {
    const existing = makeProfile("ab_existing", "Existing");
    const zip = await importFixture(), before = disk.readFileSync(getConfigPath());
    let damaged = false;
    io.hook = (e) => {
      if (damaged || e.op !== "write" || !e.path.includes("profile-import-") || !e.path.endsWith("Preferences")) return;
      damaged = true;
      const wrong = Buffer.from(e.buffer!.subarray(e.offset!, e.offset! + e.length!)); wrong[0] ^= 1;
      return { value: disk.writeSync(e.fd!, wrong, 0, wrong.length, e.position) };
    };
    expect(() => importProfileArchive(zip)).toThrow(/CRC|verif/i);
    io.hook = null;
    expect(damaged).toBe(true);
    expect(disk.readdirSync(getProfilesDir())).toEqual([existing]);
    expect(disk.readFileSync(getConfigPath())).toEqual(before);
    reloadConfig(); expect(Object.keys(getConfig().browserProfiles)).toEqual([existing]);
  });

  it("rejects corrupt archive bytes without changing existing profiles or config", async () => {
    const existing = makeProfile("ab_existing", "Existing");
    const zipPath = await importFixture(), before = disk.readFileSync(getConfigPath());
    const bytes = disk.readFileSync(zipPath), entry = readZipEntries(bytes).find((e) => e.name.endsWith("Preferences"))!;
    const dataOffset = entry.localHeaderOffset + 30 + bytes.readUInt16LE(entry.localHeaderOffset + 26) + bytes.readUInt16LE(entry.localHeaderOffset + 28);
    bytes[dataOffset] ^= 1; disk.writeFileSync(zipPath, bytes);
    expect(() => importProfileArchive(zipPath)).toThrow(/CRC/i);
    expect(disk.readdirSync(getProfilesDir())).toEqual([existing]);
    expect(disk.readFileSync(getConfigPath())).toEqual(before);
    reloadConfig(); expect(Object.keys(getConfig().browserProfiles)).toEqual([existing]);
  });

  it("refuses to clean a newly allocated directory replaced by another owner", async () => {
    const zip = await importFixture(), before = disk.readFileSync(getConfigPath());
    let replacement: string | null = null;
    io.hook = (e) => {
      if (replacement || e.op !== "rename" || !e.to || !e.path.includes("profile-import-") || !e.to.includes(getProfilesDir() + path.sep)) return;
      replacement = path.dirname(e.to);
      disk.renameSync(replacement, path.join(WORK, "moved-original"));
      disk.mkdirSync(replacement); disk.writeFileSync(path.join(replacement, "sentinel"), "other owner");
      throw failure("EIO", "rename");
    };
    expect(() => importProfileArchive(zip)).toThrow(/EIO.*cleanup.*replaced/i);
    io.hook = null;
    expect(replacement).not.toBeNull();
    expect(disk.readFileSync(path.join(replacement!, "sentinel"), "utf8")).toBe("other owner");
    expect(disk.readFileSync(getConfigPath())).toEqual(before);
  });

  it("cleans only its uncommitted new profile when the config rename fails", async () => {
    const existing = makeProfile("ab_existing", "Existing");
    const sentinel = path.join(getProfilesDir(), existing, "sentinel");
    disk.writeFileSync(sentinel, "untouched");
    const zip = await importFixture(), before = disk.readFileSync(getConfigPath());
    io.hook = (e) => { if (e.op === "rename" && e.to === getConfigPath()) throw failure("ENOSPC", "rename"); };
    expect(() => importProfileArchive(zip)).toThrow("ENOSPC");
    io.hook = null;
    expect(disk.readdirSync(getProfilesDir())).toEqual([existing]);
    expect(disk.readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(disk.readFileSync(getConfigPath())).toEqual(before);
    reloadConfig(); expect(Object.keys(getConfig().browserProfiles)).toEqual([existing]);
  });

  it("deduplicates the name against the live transaction and retains unrelated updates", async () => {
    const zip = await importFixture();
    let inserted = false;
    io.hook = (e) => {
      if (inserted || e.op !== "mkdir" || path.dirname(e.path) !== getProfilesDir() || !path.basename(e.path).startsWith(PROFILE_ID_PREFIX)) return;
      inserted = true;
      transact((draft) => { draft.browserProfiles.ab_concurrent = { name: "Incoming", platform: "windows", fingerprintSeed: 12345 }; });
    };
    const imported = importProfileArchive(zip);
    io.hook = null;
    expect(inserted).toBe(true); expect(imported.name).toBe("Incoming (2)");
    const stored = JSON.parse(disk.readFileSync(getConfigPath(), "utf8"));
    expect(stored.browserProfiles.ab_concurrent.name).toBe("Incoming");
    expect(stored.browserProfiles[imported.dirId].name).toBe("Incoming (2)");
    reloadConfig(); expect(getProfileMeta(imported.dirId)?.name).toBe("Incoming (2)");
  });

  it("returns a cleanup warning after config commit without deleting adopted data", async () => {
    const zip = await importFixture();
    let cleanupFailed = false;
    io.hook = (e) => {
      if (e.op === "rm" && path.basename(e.path).includes("profile-import-") && Object.keys(getConfig().browserProfiles).length) {
        cleanupFailed = true; throw failure("EACCES", "rm");
      }
    };
    const imported = importProfileArchive(zip);
    io.hook = null;
    expect(cleanupFailed).toBe(true);
    expect(imported.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/cleanup|staging/i)]));
    expect(disk.readFileSync(path.join(getProfilesDir(), imported.dirId, "Default", "Preferences"), "utf8")).toBe('{"incoming":true}');
    reloadConfig(); expect(getProfileMeta(imported.dirId)?.name).toBe("Incoming");
  });

  it("round-trips closed synthetic DB/WAL bytes without checkpointing and reloads by imported ID", async () => {
    const id = makeProfile();
    const sourceDir = path.join(getProfilesDir(), id, "Default");
    const database = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(8192, 0xa5)]);
    const wal = Buffer.concat([Buffer.from([0x37, 0x7f, 0x06, 0x82]), Buffer.alloc(4096, 0x5a)]);
    disk.writeFileSync(path.join(sourceDir, "Cookies"), database);
    disk.writeFileSync(path.join(sourceDir, "Cookies-wal"), wal);
    const zip = path.join(WORK, "snapshot.zip");
    await exportProfile(id, zip);
    const imported = importProfileArchive(zip);
    expect(imported.dirId).not.toBe(id);
    for (const [name, bytes] of [["Cookies", database], ["Cookies-wal", wal]] as const) {
      expect(disk.readFileSync(path.join(sourceDir, name))).toEqual(bytes);
      expect(disk.readFileSync(path.join(getProfilesDir(), imported.dirId, "Default", name))).toEqual(bytes);
    }
    const stored = JSON.parse(disk.readFileSync(getConfigPath(), "utf8"));
    expect(stored.browserProfiles[imported.dirId].name).toBe("Synthetic (2)");
    reloadConfig(); expect(getProfileMeta(imported.dirId)?.name).toBe("Synthetic (2)");
    expect(Object.keys(getConfig().browserProfiles)).toContain(imported.dirId);
  });
});
