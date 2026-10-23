import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-archive-guard-test");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return TEST_USER_DATA;
      if (name === "home") return os.homedir();
      if (name === "downloads") return path.join(os.homedir(), "Downloads");
      if (name === "documents") return path.join(os.homedir(), "Documents");
      if (name === "desktop") return path.join(os.homedir(), "Desktop");
      if (name === "temp") return os.tmpdir();
      return "/tmp";
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../../src/main/services/config-manager.js", () => ({ getAppDataDir: () => TEST_USER_DATA }));

import {
  assertSafeArchiveExportPath,
  assertSafeArchiveExportDir,
  assertSafeArchiveImportPath,
} from "../../src/main/services/archive-path-guard.js";

// The real guard runs with Windows path semantics and metadata-only fs mocks.
// Drive/UNC fixtures must never cause a local-drive or network-share access.
async function windowsAncestorFixture(root: string, escape = false) {
  const owned = path.win32.join(root, "owned");
  const allowed = path.win32.join(owned, "exports");
  const link = path.win32.join(allowed, "link");
  const sub = path.win32.join(link, "sub");
  const outside = path.win32.join(root, "outside");
  const directories = new Set([root, owned, allowed, link, sub]);
  const missing = () => Object.assign(new Error("Synthetic path not found"), { code: "ENOENT" });
  const metadata = {
    existsSync: vi.fn((file: string) => directories.has(file)),
    lstatSync: vi.fn((file: string) => {
      if (!directories.has(file)) throw missing();
      return { isSymbolicLink: () => escape && file === link, isFile: () => false, isDirectory: () => true };
    }),
    realpathSync: vi.fn((file: string) => {
      if (!directories.has(file)) throw missing();
      return escape && (file === link || file === sub)
        ? path.win32.join(outside, path.win32.relative(link, file)) : file;
    }),
  };
  vi.resetModules();
  vi.doMock("node:path", () => path.win32);
  vi.doMock("node:fs", () => metadata);
  vi.doMock("node:os", () => ({ tmpdir: () => allowed, homedir: () => path.win32.join(root, "synthetic-home") }));
  vi.doMock("electron", () => ({ app: { getPath: () => allowed } }));
  vi.doMock("../../src/main/services/config-manager.js", () => ({ getAppDataDir: () => allowed }));
  const guard = await import("../../src/main/services/archive-path-guard.js");
  return { guard, metadata, owned, allowed, link, sub };
}

const windowsRoots = [
  ["drive", "C:\\"],
  ["UNC", "\\\\synthetic-host\\synthetic-share\\"],
] as const;

describe("archive-path-guard Windows ancestor metadata", () => {
  afterEach(() => {
    vi.doUnmock("node:path");
    vi.doUnmock("node:fs");
    vi.doUnmock("node:os");
    vi.doUnmock("electron");
    vi.doUnmock("../../src/main/services/config-manager.js");
    vi.resetModules();
  });

  it.each(windowsRoots)("preserves the %s root while checking every ancestor", async (_kind, root) => {
    const { guard, metadata, owned, allowed, link, sub } = await windowsAncestorFixture(root);
    const archive = path.win32.join(sub, "out.zip");
    const batch = path.win32.join(sub, "batch");
    expect(guard.assertSafeArchiveExportPath(archive)).toBe(archive);
    expect(metadata.lstatSync.mock.calls.slice(1, 5).map(([file]) => file)).toEqual([owned, allowed, link, sub]);
    metadata.lstatSync.mockClear();
    expect(guard.assertSafeArchiveExportDir(batch)).toBe(batch);
    expect(metadata.lstatSync.mock.calls.slice(0, 4).map(([file]) => file)).toEqual([owned, allowed, link, sub]);
    expect(metadata.lstatSync).not.toHaveBeenCalledWith(root);
    expect(guard.assertSafeArchiveExportPath(path.win32.join(allowed, "missing", "sub", "out.zip")))
      .toBe(path.win32.join(allowed, "missing", "sub", "out.zip"));
  });

  it.each(windowsRoots)("rejects an escaping %s ancestor above the immediate parent", async (_kind, root) => {
    const { guard, metadata, link, sub } = await windowsAncestorFixture(root, true);
    expect(() => guard.assertSafeArchiveExportPath(path.win32.join(sub, "out.zip"))).toThrow(/Refusing symlink ancestor/);
    expect(() => guard.assertSafeArchiveExportDir(path.win32.join(sub, "batch"))).toThrow(/Refusing symlink ancestor/);
    expect(metadata.lstatSync).toHaveBeenCalledWith(link);
    expect(metadata.realpathSync).toHaveBeenCalledWith(link);
  });

  it.each(windowsRoots)("does not treat an unreadable %s ancestor as missing", async (_kind, root) => {
    const { guard, metadata, owned, sub } = await windowsAncestorFixture(root);
    const lstat = metadata.lstatSync.getMockImplementation()!;
    const denied = Object.assign(new Error("Synthetic permission denied"), { code: "EACCES" });
    metadata.lstatSync.mockImplementation(file => {
      if (file === owned) throw denied;
      return lstat(file);
    });
    expect(() => guard.assertSafeArchiveExportPath(path.win32.join(sub, "out.zip"))).toThrow(denied);
    expect(() => guard.assertSafeArchiveExportDir(path.win32.join(sub, "batch"))).toThrow(denied);
  });
});

describe("archive-path-guard", () => {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const docsDir = path.join(os.homedir(), "Documents");
  const tmpRoot = path.join(os.tmpdir(), "agent-browser-archive-guard-probe");

  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects export destinations outside the allowlist (e.g. /etc/hosts, ~/.zshrc)", () => {
    expect(() => assertSafeArchiveExportPath("/etc/hosts.zip")).toThrow(/Refusing symlink|not in allowed directory/i);
    expect(() => assertSafeArchiveExportPath(path.join(os.homedir(), ".zshrc"))).toThrow(/must be a \.zip/i);
    // Exercise the allowlist, not an unrelated symlink in the runner's HOME path.
    expect(() => assertSafeArchiveExportPath(path.join(fs.realpathSync(os.homedir()), ".zshrc.zip"))).toThrow(/not in allowed directory/i);
    expect(() => assertSafeArchiveExportPath("/tmp/../etc/passwd.zip")).toThrow(/Refusing symlink|not in allowed directory/i);
  });

  it("rejects non-zip export paths and NUL bytes", () => {
    expect(() => assertSafeArchiveExportPath(path.join(downloadsDir, "a.txt"))).toThrow(/must be a \.zip/i);
    expect(() => assertSafeArchiveExportPath(path.join(downloadsDir, "a.zip\0.txt"))).toThrow(/NUL/i);
    expect(() => assertSafeArchiveExportDir(path.join(tmpRoot, "x.zip"))).toThrow(/must be a directory/i);
  });

  it("allows legitimate export destinations in appData/downloads/documents/tmp", () => {
    const backupsDir = path.join(TEST_USER_DATA, "backups");
    expect(assertSafeArchiveExportPath(path.join(backupsDir, "profile-a.zip")).endsWith("profile-a.zip")).toBe(true);
    expect(assertSafeArchiveExportDir(path.join(tmpRoot, "batch"))).toBe(path.resolve(path.join(tmpRoot, "batch")));
    // Also allow explicit absolute .zip under user tmp even if parent doesn't exist yet.
    expect(assertSafeArchiveExportPath(path.join(tmpRoot, "a", "b.zip")).endsWith("b.zip")).toBe(true);
  });

  it("rejects symlink parents and symlink archives on export/import", () => {
    const real = path.join(tmpRoot, "real");
    const link = path.join(tmpRoot, "link");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, link);
    // Parent is a symlink → reject.
    expect(() => assertSafeArchiveExportPath(path.join(link, "out.zip"))).toThrow(/symlink/i);
    expect(() => assertSafeArchiveExportDir(path.join(link, "batch"))).toThrow(/symlink/i);

    const zipPath = path.join(tmpRoot, "src.zip");
    fs.writeFileSync(zipPath, "not a zip");
    const zipLink = path.join(tmpRoot, "src-link.zip");
    fs.symlinkSync(zipPath, zipLink);
    expect(() => assertSafeArchiveImportPath(zipLink)).toThrow(/symlink/i);
  });

  it("rejects symlink ANCESTORS above the immediate parent (R5 #70)", () => {
    if (process.platform === "win32") return; // symlink privileges vary on CI
    // Escape target: a dir OUTSIDE every allowed root. Prefer the app-data
    // backups dir's parent subtree is allowed... so instead use a fresh dir
    // under the test tmpRoot's PARENT (os.tmpdir itself is allowed, but the
    // escape works when the LINK lives in an allowed root and points at a
    // location whose realpath is outside ALL allowed roots).
    //
    // Portable construction: link inside tmpRoot (allowed) -> target is a
    // sibling of tmpRoot that we then REMOVE from allowed consideration by
    // pointing at os.homedir() (never an allowed root) via a subdir we can
    // create. HOME is always writable by the test user.
    const outsideBase = path.join(os.homedir(), ".agent-browser-guard-probe-outside");
    fs.rmSync(outsideBase, { recursive: true, force: true });
    const outside = path.join(outsideBase, "secret");
    const link = path.join(tmpRoot, "link");
    const sub = path.join(link, "sub");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, link);
    try {
      // Immediate parent (link/sub resolved lexically) looks innocent, but an
      // ancestor is a symlink escaping every allowed root.
      expect(() => assertSafeArchiveExportPath(path.join(sub, "evil.zip"))).toThrow(/symlink/i);
      expect(() => assertSafeArchiveExportDir(sub)).toThrow(/symlink/i);
    } finally {
      fs.rmSync(outsideBase, { recursive: true, force: true });
    }
  });

  it("import validates existence, extension and symlink, not strict allowlist", () => {
    const missing = path.join(tmpRoot, "missing.zip");
    expect(() => assertSafeArchiveImportPath(missing)).toThrow(/not found/i);
    const txt = path.join(tmpRoot, "a.txt");
    fs.writeFileSync(txt, "x");
    expect(() => assertSafeArchiveImportPath(txt)).toThrow(/must be a \.zip/i);
    const ok = path.join(tmpRoot, "ok.zip");
    fs.writeFileSync(ok, "x");
    expect(assertSafeArchiveImportPath(ok)).toBe(path.resolve(ok));
  });
});
