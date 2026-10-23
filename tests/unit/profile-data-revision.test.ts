import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const h = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "profile-data-revision-")), failSyncAt: 0, syncCalls: 0, failRename: false,
    failCode: "EIO", failSyscall: undefined as string | undefined, failDirectoryOpen: false, corruptReadAfterSync: 0,
    syncFaults: [] as Array<{ fd: number; directory: boolean }> };
});
vi.mock("../../src/main/services/config-manager.js", () => ({ getAppDataDir: () => h.root }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    openSync: (file: any, ...args: any[]) => {
      if (h.failDirectoryOpen && String(file) === h.root) throw Object.assign(new Error("Synthetic directory open failure"), { code: "EPERM", syscall: "open" });
      return (actual.openSync as any)(file, ...args);
    },
    readSync: (fd: number, buffer: Buffer, ...args: any[]) => {
      const count = (actual.readSync as any)(fd, buffer, ...args);
      if (h.corruptReadAfterSync && h.syncCalls >= h.corruptReadAfterSync && count) buffer[0] = 0;
      return count;
    },
    fsyncSync: (fd: number) => {
      if (++h.syncCalls === h.failSyncAt) {
        h.syncFaults.push({ fd, directory: actual.fstatSync(fd).isDirectory() });
        throw Object.assign(new Error("Synthetic revision fsync failure"), { code: h.failCode, syscall: h.failSyscall });
      }
      return actual.fsyncSync(fd);
    },
    renameSync: (from: any, to: any) => {
      if (h.failRename && String(to).startsWith(path.join(h.root, "profile-data-revisions") + path.sep)) {
        throw Object.assign(new Error("Synthetic revision rename failure"), { code: "EIO" });
      }
      return actual.renameSync(from, to);
    },
  };
});
import { getProfileDataRevision, markProfileDataChanging } from "../../src/main/services/profile-data-revision.js";

const ID = "revision_profile", OTHER = "revision_other";
const store = () => path.join(h.root, "profile-data-revisions");
const record = (id = ID) => path.join(store(), id + ".json");
function cleanup(): void {
  if (path.dirname(h.root) !== os.tmpdir() || !path.basename(h.root).startsWith("profile-data-revision-")) throw new Error("Unsafe revision fixture cleanup");
  fs.rmSync(h.root, { recursive: true, force: true });
}
beforeEach(() => {
  h.failSyncAt = 0; h.syncCalls = 0; h.failRename = false;
  h.failCode = "EIO"; h.failSyscall = undefined; h.failDirectoryOpen = false; h.corruptReadAfterSync = 0; h.syncFaults = [];
  cleanup(); fs.mkdirSync(h.root, { mode: 0o700 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(cleanup);

describe("local-only durable profile data revisions", () => {
  it("reads a stable missing revision without creating files or directories", () => {
    expect(getProfileDataRevision(ID)).toBe("initial");
    expect(getProfileDataRevision(ID)).toBe("initial");
    expect(getProfileDataRevision(OTHER)).toBe("initial");
    expect(fs.readdirSync(h.root)).toEqual([]);
    fs.rmdirSync(h.root);
    expect(getProfileDataRevision(ID)).toBe("initial");
    expect(fs.existsSync(h.root)).toBe(false);
  });

  it("publishes actual private bounded bytes, reads them back, survives module reload, and changes only the marked profile", async () => {
    markProfileDataChanging(ID);
    const first = getProfileDataRevision(ID);
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    const actual = JSON.parse(fs.readFileSync(record(), "utf8"));
    expect(actual).toEqual({ version: 1, dirId: ID, revision: first });
    expect(fs.statSync(record()).size).toBeLessThanOrEqual(512);
    if (process.platform !== "win32") {
      expect(fs.statSync(store()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(record()).mode & 0o777).toBe(0o600);
    }
    expect(getProfileDataRevision(OTHER)).toBe("initial");
    expect(fs.readdirSync(store())).toEqual([ID + ".json"]);
    vi.resetModules();
    const reloaded = await import("../../src/main/services/profile-data-revision.js");
    expect(reloaded.getProfileDataRevision(ID)).toBe(first);
    reloaded.markProfileDataChanging(ID);
    expect(getProfileDataRevision(ID)).not.toBe(first);
    expect(JSON.parse(fs.readFileSync(record(), "utf8")).revision).toBe(getProfileDataRevision(ID));
    expect(getProfileDataRevision(OTHER)).toBe("initial");
    expect(fs.readdirSync(store())).toEqual([ID + ".json"]);
  });

  it("rejects traversal identifiers before creating the store", () => {
    expect(() => getProfileDataRevision("../outside")).toThrow(/Invalid profile ID/);
    expect(() => markProfileDataChanging("../outside")).toThrow(/Invalid profile ID/);
    expect(fs.readdirSync(h.root)).toEqual([]);
  });

  it("never follows a revision file symlink or writes its owned fixture target", () => {
    fs.mkdirSync(store(), { mode: 0o700 });
    const target = path.join(h.root, "owned-target.json");
    fs.writeFileSync(target, "sentinel", { mode: 0o600 });
    fs.symlinkSync(target, record());
    expect(() => getProfileDataRevision(ID)).toThrow(/revision unavailable/i);
    expect(() => markProfileDataChanging(ID)).toThrow(/revision unavailable/i);
    expect(fs.lstatSync(record()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("sentinel");
  });

  it("never follows a revision directory symlink", () => {
    const target = path.join(h.root, "owned-directory");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "sentinel"), "untouched");
    fs.symlinkSync(target, store());
    expect(() => getProfileDataRevision(ID)).toThrow(/revision unavailable/i);
    expect(() => markProfileDataChanging(ID)).toThrow(/revision unavailable/i);
    expect(fs.readdirSync(target)).toEqual(["sentinel"]);
    expect(fs.readFileSync(path.join(target, "sentinel"), "utf8")).toBe("untouched");
  });

  it.each(["oversized", "malformed", "wrong-profile", "unknown-schema"])("fails closed on %s evidence instead of inventing initial", (kind) => {
    fs.mkdirSync(store(), { mode: 0o700 });
    const value = { version: 1, dirId: ID, revision: "11111111-1111-4111-8111-111111111111" };
    const bytes = kind === "oversized" ? "x".repeat(513) : kind === "malformed" ? "{" :
      JSON.stringify({ ...value, ...(kind === "wrong-profile" ? { dirId: OTHER } : { extra: true }) });
    fs.writeFileSync(record(), bytes, { mode: 0o600 });
    expect(() => getProfileDataRevision(ID)).toThrow(/revision unavailable/i);
    expect(() => markProfileDataChanging(ID)).toThrow(/revision unavailable/i);
    expect(fs.readFileSync(record(), "utf8")).toBe(bytes);
  });

  it("rejects a multiply-linked record without modifying either name", () => {
    markProfileDataChanging(ID);
    const before = fs.readFileSync(record());
    const linked = path.join(h.root, "linked-record.json");
    fs.linkSync(record(), linked);
    expect(() => getProfileDataRevision(ID)).toThrow(/revision unavailable/i);
    expect(() => markProfileDataChanging(ID)).toThrow(/revision unavailable/i);
    expect(fs.readFileSync(record())).toEqual(before);
    expect(fs.readFileSync(linked)).toEqual(before);
  });

  it("a pre-publication fsync failure preserves the previous revision and cleans only its temporary file", () => {
    markProfileDataChanging(ID);
    const before = getProfileDataRevision(ID);
    h.syncCalls = 0; h.failSyncAt = 1;
    expect(() => markProfileDataChanging(ID)).toThrow(/durably advance/i);
    expect(getProfileDataRevision(ID)).toBe(before);
    expect(JSON.parse(fs.readFileSync(record(), "utf8")).revision).toBe(before);
    expect(fs.readdirSync(store())).toEqual([ID + ".json"]);
  });

  it("a rename failure preserves the previous record and cannot authorize restore", () => {
    markProfileDataChanging(ID);
    const before = fs.readFileSync(record());
    h.failRename = true;
    expect(() => markProfileDataChanging(ID)).toThrow(/restore was not authorized/i);
    expect(fs.readFileSync(record())).toEqual(before);
    expect(fs.readdirSync(store())).toEqual([ID + ".json"]);
  });

  it("directory durability failure after rename still fails closed and never resurrects the old revision", () => {
    markProfileDataChanging(ID);
    const before = getProfileDataRevision(ID);
    h.syncCalls = 0; h.failSyncAt = 2;
    expect(() => markProfileDataChanging(ID)).toThrow(/restore was not authorized/i);
    expect(getProfileDataRevision(ID)).not.toBe(before);
    expect(JSON.parse(fs.readFileSync(record(), "utf8")).revision).toBe(getProfileDataRevision(ID));
    expect(fs.readdirSync(store())).toEqual([ID + ".json"]);
  });

  it.each([1, 3])("allows only recognized Windows directory-fsync unsupported at stage %s, with a diagnostic and strict disk readback", (stage) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.failSyncAt = stage; h.failCode = "EPERM"; h.failSyscall = "fsync";
    markProfileDataChanging(ID);
    expect(getProfileDataRevision(ID)).not.toBe("initial");
    expect(JSON.parse(fs.readFileSync(record(), "utf8")).revision).toBe(getProfileDataRevision(ID));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("directory crash durability is unverified"));
    expect(h.syncCalls).toBeGreaterThanOrEqual(3);
  });

  it("does not waive regular-file fsync for the same Windows EPERM/fsync error", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    h.failSyncAt = 2; h.failCode = "EPERM"; h.failSyscall = "fsync";
    expect(() => markProfileDataChanging(ID)).toThrow(/restore was not authorized/i);
    expect(getProfileDataRevision(ID)).toBe("initial"); expect(fs.existsSync(record())).toBe(false);
  });

  it.each([
    { code: "EPERM", syscall: "open" }, { code: "EPERM", syscall: undefined },
    { code: "EACCES", syscall: "fsync" }, { code: "EIO", syscall: "fsync" },
    { code: "ENOSPC", syscall: "fsync" }, { code: "EINVAL", syscall: "fsync" },
  ])("does not classify other Windows errors as unsupported: %j", ({ code, syscall }) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    h.failSyncAt = 1; h.failCode = code; h.failSyscall = syscall;
    expect(() => markProfileDataChanging(ID)).toThrow(/restore was not authorized/i);
    expect(getProfileDataRevision(ID)).toBe("initial"); expect(fs.existsSync(record())).toBe(false);
  });

  it("does not waive a Windows directory-open failure", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    h.failDirectoryOpen = true;
    expect(() => markProfileDataChanging(ID)).toThrow(/restore was not authorized/i);
    expect(fs.existsSync(store())).toBe(false);
  });

  it("does not waive EPERM/fsync on a non-Windows platform", () => {
    const nativeProcess = process, open = vi.spyOn(fs, "openSync"), close = vi.spyOn(fs, "closeSync");
    const warning = vi.spyOn(console, "warn");
    expect(fs.lstatSync(store(), { throwIfNoEntry: false })).toBeUndefined();
    vi.stubGlobal("process", { ...nativeProcess, platform: "linux" });
    try {
      h.failSyncAt = 1; h.failCode = "EPERM"; h.failSyscall = "fsync";
      let failure: unknown;
      try { markProfileDataChanging(ID); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "PROFILE_DATA_REVISION_UNAVAILABLE", message: expect.stringMatching(/restore was not authorized/i),
        cause: { code: "EPERM", syscall: "fsync" } });
      expect(h.syncCalls).toBe(1); expect(warning).not.toHaveBeenCalled();
      expect(open.mock.calls.map(([file]) => String(file))).toEqual([h.root, h.root]);
      expect(open.mock.results.every(result => result.type === "return")).toBe(true);
      const fds = open.mock.results.map(result => result.value as number);
      expect(h.syncFaults).toEqual([{ fd: fds[1], directory: true }]);
      expect(close.mock.calls).toEqual([[fds[1]], [fds[0]]]);
      for (const fd of fds) expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    } finally {
      // Scope the spoof to the refusal predicate. Windows POSIX mode bits are
      // not ACL evidence and must not be interpreted as Linux permissions.
      vi.unstubAllGlobals();
    }
    expect(process === nativeProcess, "restore the real process before native filesystem readback").toBe(true);
    const owner = fs.lstatSync(store(), { bigint: true });
    expect(owner.isDirectory()).toBe(true); expect(owner.isSymbolicLink()).toBe(false);
    expect(getProfileDataRevision(ID)).toBe("initial");
    expect(h.syncCalls).toBe(1); expect(fs.lstatSync(record(), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readdirSync(store())).toEqual([]);
    const after = fs.lstatSync(store(), { bigint: true });
    expect([after.dev, after.ino]).toEqual([owner.dev, owner.ino]);
  });

  it("still requires publication readback after recognized unsupported Windows directory fsync", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.failSyncAt = 3; h.failCode = "EPERM"; h.failSyscall = "fsync"; h.corruptReadAfterSync = 3;
    expect(() => markProfileDataChanging(ID)).toThrow(/restore was not authorized/i);
    h.corruptReadAfterSync = 0;
    expect(getProfileDataRevision(ID)).not.toBe("initial");
    expect(JSON.parse(fs.readFileSync(record(), "utf8")).revision).toBe(getProfileDataRevision(ID));
  });

  it.skipIf(process.platform === "win32")("does not relax unsafe directory/file permissions", () => {
    fs.mkdirSync(store(), { mode: 0o755 });
    expect(() => getProfileDataRevision(ID)).toThrow(/revision unavailable/i);
    expect(() => markProfileDataChanging(ID)).toThrow(/revision unavailable/i);
    expect(fs.statSync(store()).mode & 0o777).toBe(0o755);
  });
});
