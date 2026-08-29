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

import {
  assertSafeArchiveExportPath,
  assertSafeArchiveExportDir,
  assertSafeArchiveImportPath,
} from "../../src/main/services/archive-path-guard.js";

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
    expect(() => assertSafeArchiveExportPath("/etc/hosts.zip")).toThrow(/Refusing symlink parent|not in allowed directory/i);
    expect(() => assertSafeArchiveExportPath(path.join(os.homedir(), ".zshrc"))).toThrow(/must be a \.zip/i);
    expect(() => assertSafeArchiveExportPath(path.join(os.homedir(), ".zshrc.zip"))).toThrow(/not in allowed directory/i);
    expect(() => assertSafeArchiveExportPath("/tmp/../etc/passwd.zip")).toThrow(/Refusing symlink parent|not in allowed directory/i);
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
