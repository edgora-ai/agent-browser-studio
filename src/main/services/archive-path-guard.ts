// Archive path guard — defense against arbitrary destPath/zipPath supplied by
// renderer or loopback REST clients. Export destinations are restricted to a
// small set of user-visible roots (Downloads/Documents/Desktop/tmp/appData).
// Import sources are checked for .zip shape, existence and symlink abuse; the
// export side is the critical overwrite surface, so it enforces an allowlist.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { app } from "electron";
import { getAppDataDir } from "./config-manager.js";

function isPathInside(childPath: string, basePath: string): boolean {
  const rel = path.relative(basePath, childPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function getAllowedRoots(): string[] {
  const roots: string[] = [];
  const push = (p: string | undefined | null) => {
    if (!p || typeof p !== "string") return;
    const trimmed = p.trim();
    if (!trimmed) return;
    try {
      roots.push(path.resolve(trimmed));
    } catch {}
  };

  try {
    push(getAppDataDir());
  } catch {}
  try {
    push(path.join(getAppDataDir(), "backups"));
  } catch {}
  try {
    push(os.tmpdir());
  } catch {}
  try {
    push(path.join(os.homedir(), "Downloads"));
  } catch {}
  try {
    push(path.join(os.homedir(), "Documents"));
  } catch {}
  try {
    push(path.join(os.homedir(), "Desktop"));
  } catch {}

  // Electron well-known folders (may overlap with above).
  try {
    push(app.getPath("downloads"));
  } catch {}
  try {
    push(app.getPath("documents"));
  } catch {}
  try {
    push(app.getPath("desktop"));
  } catch {}
  try {
    push(app.getPath("temp"));
  } catch {}

  // Deduplicate while preserving order.
  return [...new Set(roots.filter(Boolean))];
}

function assertNoNul(p: string): void {
  if (p.includes("\0")) throw new Error("Unsafe path: NUL byte");
}

function assertNotSymlink(p: string): void {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`Refusing symlink path: ${p}`);
  } catch (e: any) {
    if (e && e.code === "ENOENT") return;
    if (e && /Refusing symlink/.test(e.message)) throw e;
    throw e;
  }
}

function getExistingParentRealPath(p: string): string | null {
  let cur = path.resolve(p);
  // For a file path, start from its dirname.
  try {
    const st = fs.lstatSync(cur);
    if (st.isFile() || st.isDirectory()) {
      // If cur itself exists, its realpath is the anchor.
      try {
        return fs.realpathSync(cur);
      } catch {
        return path.resolve(cur);
      }
    }
  } catch {}
  cur = path.dirname(cur);
  while (true) {
    try {
      if (fs.existsSync(cur)) {
        try {
          return fs.realpathSync(cur);
        } catch {
          return path.resolve(cur);
        }
      }
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function isInsideAllowedRoots(resolved: string, existingReal: string | null): boolean {
  const roots = getAllowedRoots();
  for (const root of roots) {
    if (resolved === root) return true;
    if (isPathInside(resolved, root)) return true;
    if (existingReal) {
      if (existingReal === root) return true;
      if (isPathInside(existingReal, root)) return true;
      // Also allow when resolved parent is inside root even if real differs by case.
      if (isPathInside(path.dirname(resolved), root)) return true;
    } else {
      if (isPathInside(path.dirname(resolved), root)) return true;
    }
  }
  return false;
}

export function assertSafeArchiveExportPath(destPath: string): string {
  if (typeof destPath !== "string" || !destPath.trim()) throw new Error("Invalid export destination: empty path");
  assertNoNul(destPath);
  const resolved = path.resolve(destPath.trim());
  assertNoNul(resolved);
  if (path.extname(resolved).toLowerCase() !== ".zip") {
    throw new Error("Export destination must be a .zip file: " + JSON.stringify(destPath));
  }
  // Disallow obvious sensitive dotfiles even inside allowed roots? Keep minimal:
  // the allowlist already blocks ~/.zshrc etc. because homedir itself is not allowed.
  assertNotSymlink(resolved);
  // If parent exists and is symlink, reject.
  const parent = path.dirname(resolved);
  if (fs.existsSync(parent)) {
    try {
      const pst = fs.lstatSync(parent);
      if (pst.isSymbolicLink()) throw new Error(`Refusing symlink parent: ${parent}`);
    } catch (e: any) {
      if (e && /Refusing symlink/.test(e.message)) throw e;
      if (e && e.code !== "ENOENT") throw e;
    }
  }
  const existingReal = getExistingParentRealPath(resolved);
  if (!isInsideAllowedRoots(resolved, existingReal)) {
    throw new Error(`Export destination not in allowed directory: ${resolved}`);
  }
  // Also verify real parent is not a symlink escape.
  if (existingReal) {
    try {
      const realParent = fs.realpathSync(parent);
      // If parent is a symlink, realParent will differ and lstat would have caught it above,
      // but keep defense in depth.
      if (path.resolve(realParent) !== path.resolve(parent) && fs.lstatSync(parent).isSymbolicLink()) {
        throw new Error(`Refusing symlink parent: ${parent}`);
      }
    } catch (e: any) {
      if (e && /Refusing symlink/.test(e.message)) throw e;
      if (e && e.code !== "ENOENT") throw e;
    }
  }
  return resolved;
}

export function assertSafeArchiveExportDir(destDir: string): string {
  if (typeof destDir !== "string" || !destDir.trim()) throw new Error("Invalid export directory: empty path");
  assertNoNul(destDir);
  const resolved = path.resolve(destDir.trim());
  assertNoNul(resolved);
  if (path.extname(resolved).toLowerCase() === ".zip") {
    throw new Error("Export directory must be a directory, not a .zip file");
  }
  if (fs.existsSync(resolved)) {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) throw new Error(`Refusing symlink path: ${resolved}`);
    if (!st.isDirectory()) throw new Error(`Export directory is not a directory: ${resolved}`);
  } else {
    // Parent must not be a symlink.
    const parent = path.dirname(resolved);
    if (fs.existsSync(parent)) {
      const pst = fs.lstatSync(parent);
      if (pst.isSymbolicLink()) throw new Error(`Refusing symlink parent: ${parent}`);
    }
  }
  const existingReal = getExistingParentRealPath(path.join(resolved, "_probe"));
  if (!isInsideAllowedRoots(resolved, existingReal)) {
    throw new Error(`Export directory not in allowed directory: ${resolved}`);
  }
  return resolved;
}

export function assertSafeArchiveImportPath(zipPath: string): string {
  if (typeof zipPath !== "string" || !zipPath.trim()) throw new Error("Invalid import source: empty path");
  assertNoNul(zipPath);
  const resolved = path.resolve(zipPath.trim());
  assertNoNul(resolved);
  if (path.extname(resolved).toLowerCase() !== ".zip") {
    throw new Error("Import source must be a .zip file: " + JSON.stringify(zipPath));
  }
  if (!fs.existsSync(resolved)) throw new Error("Archive file not found: " + resolved);
  const st = fs.lstatSync(resolved);
  if (st.isSymbolicLink()) throw new Error(`Refusing symlink archive: ${resolved}`);
  if (!st.isFile()) throw new Error(`Import source is not a file: ${resolved}`);
  // Import is read-only, so we only enforce symlink/extension/existence, not allowlist,
  // to keep automation flexible. The critical overwrite surface is export.
  // Still, if the file is inside a sensitive system location, the zip-reader will
  // reject non-zip content anyway, so we don't need a strict allowlist here.
  return resolved;
}

// For tests / diagnostics.
export function _getAllowedRootsForTest(): string[] {
  return getAllowedRoots();
}
