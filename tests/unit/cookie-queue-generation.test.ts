// Real owned files and queue I/O; metadata models are explicitly synthetic,
// not a native Windows reproduction. No browser, network or user data is used.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { CookieInfo } from "../../src/main/types.js";

const fixture = vi.hoisted(() => {
  const real = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const root = real.mkdtempSync(path.join(os.tmpdir(), "abs-cookie-queue-generation-"));
  real.chmodSync(root, 0o700);
  return {
    real, root, owner: real.lstatSync(root, { bigint: true }), caseRoot: "", file: "",
    model: "native" as "native" | "inode-collision" | "nanoseconds",
    inodeBase: 17169973579350272n, inodes: new Map<string, bigint>(),
    mtimeNs: 1700000000000000000n, ctimeNs: 1700000000000000000n,
    changeAfterRead: null as "mtimeNs" | "ctimeNs" | null,
    pendingChange: null as "mtimeNs" | "ctimeNs" | null,
    fds: new Map<number, string>(),
    opens: [] as Parameters<typeof real.openSync>[],
    renames: [] as Parameters<typeof real.renameSync>[],
    fsyncs: [] as string[], unlinks: [] as string[],
    stats: [] as Array<{ operation: "lstat" | "fstat"; file: string; bigint: boolean }>,
  };
});

vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  function owned(target: unknown): string | number {
    if (typeof target === "number") {
      if (!fixture.fds.has(target)) throw new Error("Foreign descriptor refused by owned queue fixture");
      return target;
    }
    if (typeof target !== "string" || !fixture.caseRoot ||
        (target !== fixture.caseRoot && !target.startsWith(fixture.caseRoot + path.sep))) {
      throw new Error("Foreign path refused by owned queue fixture");
    }
    return target;
  }
  function view<T extends fs.Stats | fs.BigIntStats>(stat: T, raw: fs.BigIntStats, file: string): T {
    if (file !== fixture.file || fixture.model === "native") return stat;
    if (fixture.pendingChange) {
      fixture[fixture.pendingChange] += 100n;
      fixture.pendingChange = null;
    }
    let ino = fixture.inodeBase;
    if (fixture.model === "inode-collision") {
      const key = `${raw.dev}:${raw.ino}`;
      if (!fixture.inodes.has(key)) fixture.inodes.set(key, fixture.inodeBase + BigInt(fixture.inodes.size));
      ino = fixture.inodes.get(key)!;
    }
    const { mtimeNs, ctimeNs } = fixture;
    const modeled = typeof stat.ino === "bigint"
      ? { ino, mtimeNs, ctimeNs, mtimeMs: mtimeNs / 1000000n, ctimeMs: ctimeNs / 1000000n }
      : { ino: Number(ino), mtimeMs: Number(mtimeNs) / 1000000, ctimeMs: Number(ctimeNs) / 1000000 };
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, modeled);
  }
  return { ...real,
    lstatSync: (file: fs.PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }) => {
      owned(file);
      const stat = real.lstatSync(file, options);
      fixture.stats.push({ operation: "lstat", file: String(file), bigint: options?.bigint === true });
      if (!stat || fixture.model === "native" || file !== fixture.file) return stat;
      return view(stat, real.lstatSync(file, { bigint: true }), String(file));
    },
    fstatSync: (fd: number, options?: { bigint?: boolean }) => {
      owned(fd);
      const file = fixture.fds.get(fd)!;
      const stat = real.fstatSync(fd, options);
      fixture.stats.push({ operation: "fstat", file, bigint: options?.bigint === true });
      return fixture.model === "native" ? stat : view(stat, real.fstatSync(fd, { bigint: true }), file);
    },
    openSync: (...args: Parameters<typeof real.openSync>) => {
      owned(args[0]); const fd = real.openSync(...args);
      fixture.opens.push(args); fixture.fds.set(fd, String(args[0])); return fd;
    },
    closeSync: (fd: number) => {
      owned(fd); const file = fixture.fds.get(fd); real.closeSync(fd); fixture.fds.delete(fd);
      if (file === fixture.file && fixture.changeAfterRead) {
        fixture.pendingChange = fixture.changeAfterRead; fixture.changeAfterRead = null;
      }
    },
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => { owned(args[0]); return real.readFileSync(...args); },
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => { owned(args[0]); return real.writeFileSync(...args); },
    existsSync: (file: fs.PathLike) => { owned(file); return real.existsSync(file); },
    mkdirSync: (...args: Parameters<typeof real.mkdirSync>) => { owned(args[0]); return real.mkdirSync(...args); },
    fsyncSync: (fd: number) => { owned(fd); real.fsyncSync(fd); fixture.fsyncs.push(fixture.fds.get(fd)!); },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      owned(args[0]); owned(args[1]); real.renameSync(...args); fixture.renames.push(args);
    },
    unlinkSync: (file: fs.PathLike) => { owned(file); real.unlinkSync(file); fixture.unlinks.push(String(file)); },
    rmSync: (...args: Parameters<typeof real.rmSync>) => { owned(args[0]); return real.rmSync(...args); },
  };
});
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => fixture.caseRoot,
  getProfilesDir: () => path.join(fixture.caseRoot, "profiles"),
}));
vi.mock("../../src/main/services/process-discovery.js", () => ({
  findCdpPortSync: () => { throw new Error("No process discovery permitted in owned queue fixture"); },
}));

import { clearQueuedCookieImportsIfUnchanged, readQueuedCookieImports, readQueuedCookieImportSnapshot, writeQueuedCookieImports } from "../../src/main/services/cdp-cookie-service.js";

const ID = "ab_owned_cookie_generation";
const COOKIE: CookieInfo = { domain: "owned.invalid", name: "owned", value: "owned-cookie-value", path: "/", expires: null, secure: true, httpOnly: true, sameSite: 1 };
const CI_NUMBERS = [17169973579350272n, 17451448556060928n];
const FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;
function assertRoot(): void {
  const stat = fixture.real.lstatSync(fixture.root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== fixture.owner.dev || stat.ino !== fixture.owner.ino) throw new Error("Owned queue fixture root changed");
}
function publish(cookies: CookieInfo[] = [COOKIE]): Buffer {
  const opens = fixture.opens.length, renames = fixture.renames.length, fsyncs = fixture.fsyncs.length;
  writeQueuedCookieImports(ID, cookies);
  const bytes = fixture.real.readFileSync(fixture.file);
  expect(JSON.parse(bytes.toString("utf8"))).toEqual(cookies);
  expect(readQueuedCookieImports(ID, { strict: true })).toEqual(cookies);
  expect(fixture.real.readdirSync(path.dirname(fixture.file))).toEqual([`${ID}.json`]);
  const opened = fixture.opens.slice(opens);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toEqual([expect.stringMatching(/\.tmp$/), "wx", 0o600]);
  expect(fixture.renames.slice(renames)).toEqual([[opened[0][0], fixture.file]]);
  expect(fixture.fsyncs.slice(fsyncs)).toEqual([String(opened[0][0])]);
  const stat = fixture.real.lstatSync(fixture.file, { bigint: true });
  expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true); expect(stat.nlink).toBe(1n);
  if (process.platform !== "win32") expect(stat.mode & 0o777n).toBe(0o600n);
  return bytes;
}
function retained(bytes: Buffer): void {
  expect(fixture.real.readFileSync(fixture.file)).toEqual(bytes);
  expect(readQueuedCookieImports(ID, { strict: true })).toEqual([COOKIE]);
  expect(fixture.real.readdirSync(path.dirname(fixture.file))).toEqual([`${ID}.json`]);
  expect(fixture.unlinks).toEqual([]);
}
function numericIdentity(stat: fs.Stats) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

beforeEach(() => {
  assertRoot();
  fixture.caseRoot = fixture.real.mkdtempSync(path.join(fixture.root, "case-"));
  fixture.file = path.join(fixture.caseRoot, "pending-cookie-imports", `${ID}.json`);
  fixture.model = "native"; fixture.inodeBase = CI_NUMBERS[0]; fixture.inodes.clear();
  fixture.mtimeNs = fixture.ctimeNs = 1700000000000000000n;
  fixture.changeAfterRead = fixture.pendingChange = null;
  fixture.opens.length = fixture.renames.length = fixture.fsyncs.length = fixture.unlinks.length = fixture.stats.length = 0;
});
afterEach(() => {
  expect(fixture.fds.size).toBe(0); assertRoot();
  fixture.real.rmSync(fixture.caseRoot, { recursive: true, force: false });
  expect(fixture.real.existsSync(fixture.caseRoot)).toBe(false);
});
afterAll(() => { assertRoot(); fixture.real.rmSync(fixture.root, { recursive: true, force: false }); });

describe("owned cookie queue exact generation (metadata models are not native Windows proof)", () => {
  it.each(CI_NUMBERS)("proves the numerical negative control around CI Number %s, without claiming its raw Windows ID", value => {
    expect(Number.isSafeInteger(Number(value))).toBe(false);
    expect(Object.is(Number(value), Number(value + 1n))).toBe(true);
    expect(value).not.toBe(value + 1n);
  });

  it.each(CI_NUMBERS)("retains a real same-byte atomic replacement with modeled colliding Number inode %s", value => {
    fixture.model = "inode-collision"; fixture.inodeBase = value;
    const original = publish(), before = fixture.real.lstatSync(fixture.file, { bigint: true });
    const numericBefore = numericIdentity(fs.lstatSync(fixture.file));
    const snapshot = readQueuedCookieImportSnapshot(ID);
    const replacement = publish(), after = fixture.real.lstatSync(fixture.file, { bigint: true });
    expect(after.ino).not.toBe(before.ino); expect(replacement).toEqual(original);
    expect(numericIdentity(fs.lstatSync(fixture.file))).toEqual(numericBefore);
    expect(fixture.renames[0][0]).not.toBe(fixture.renames[1][0]);
    const cleared = clearQueuedCookieImportsIfUnchanged(ID, snapshot);
    expect({ cleared, replacementPresent: fixture.real.existsSync(fixture.file) }).toEqual({ cleared: false, replacementPresent: true });
    retained(replacement);
    expect(readQueuedCookieImportSnapshot(ID).witness!.ino).not.toBe(snapshot.witness!.ino);
  });

  it.each(["mtimeNs", "ctimeNs"] as const)("retains a same-inode queue when only modeled %s changes below Number-ms precision", field => {
    fixture.model = "nanoseconds";
    const bytes = publish(), numericBefore = numericIdentity(fs.lstatSync(fixture.file));
    const snapshot = readQueuedCookieImportSnapshot(ID);
    const fd = fs.openSync(fixture.file, "r+");
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fixture[field] += 100n;
    expect(numericIdentity(fs.lstatSync(fixture.file))).toEqual(numericBefore);
    const cleared = clearQueuedCookieImportsIfUnchanged(ID, snapshot);
    expect({ cleared, replacementPresent: fixture.real.existsSync(fixture.file) }).toEqual({ cleared: false, replacementPresent: true });
    retained(bytes);
  });

  it("checks exact nanoseconds again after the final snapshot FD closes and before unlink", () => {
    fixture.model = "nanoseconds";
    const bytes = publish(), snapshot = readQueuedCookieImportSnapshot(ID);
    fixture.changeAfterRead = "ctimeNs";
    const cleared = clearQueuedCookieImportsIfUnchanged(ID, snapshot);
    expect({ cleared, replacementPresent: fixture.real.existsSync(fixture.file) }).toEqual({ cleared: false, replacementPresent: true });
    expect(fixture.pendingChange).toBeNull(); retained(bytes);
  });

  it("closes real native metadata and bytes readback through BigInt path/FD witnesses", () => {
    const bytes = publish(), before = fixture.real.lstatSync(fixture.file, { bigint: true });
    const snapshot = readQueuedCookieImportSnapshot(ID);
    const after = fixture.real.lstatSync(fixture.file, { bigint: true });
    expect(snapshot.cookies).toEqual([COOKIE]); expect(snapshot.witness).not.toBeNull();
    for (const field of FIELDS) {
      expect(typeof snapshot.witness![field]).toBe("bigint");
      expect(snapshot.witness![field]).toBe(before[field]); expect(after[field]).toBe(before[field]);
    }
    expect(snapshot.witness!.size).toBe(BigInt(bytes.length));
    expect(snapshot.witness!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const fstats = fixture.stats.filter(stat => stat.operation === "fstat");
    expect(fstats.length).toBeGreaterThanOrEqual(2); expect(fstats.every(stat => stat.bigint)).toBe(true);
    expect(fixture.stats.some(stat => stat.operation === "lstat" && stat.file === fixture.file && stat.bigint)).toBe(true);
    retained(bytes);
  });

  it.each([{ label: "nonempty", cookies: [COOKIE] }, { label: "empty", cookies: [] }])(
    "clears an unchanged real native $label generation only after confirmed write and readback", ({ cookies }) => {
      publish(cookies); const snapshot = readQueuedCookieImportSnapshot(ID);
      expect(snapshot.cookies).toEqual(cookies); expect(fixture.fds.size).toBe(0);
      expect(clearQueuedCookieImportsIfUnchanged(ID, snapshot)).toBe(true);
      expect(fixture.unlinks).toEqual([fixture.file]); expect(fixture.real.existsSync(fixture.file)).toBe(false);
      expect(fixture.real.readdirSync(path.dirname(fixture.file))).toEqual([]);
      expect(readQueuedCookieImportSnapshot(ID).witness).toBeNull();
      expect(readQueuedCookieImports(ID, { strict: true })).toEqual([]); expect(fixture.fds.size).toBe(0);
    },
  );

  it("keeps the missing-queue contract without opening an FD or attempting unlink", () => {
    const snapshot = readQueuedCookieImportSnapshot(ID);
    expect(snapshot.cookies).toEqual([]); expect(snapshot.witness).toBeNull();
    expect(clearQueuedCookieImportsIfUnchanged(ID, snapshot)).toBe(false);
    expect(readQueuedCookieImports(ID, { strict: true })).toEqual([]);
    expect(fixture.opens).toEqual([]); expect(fixture.unlinks).toEqual([]); expect(fixture.fds.size).toBe(0);
    expect(fixture.real.readdirSync(fixture.caseRoot)).toEqual([]);
  });
});
