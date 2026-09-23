// Export path guard (M2) — the destination half of run-result export.
//
// The archive guard (archive-path-guard.ts) already answers "is this path
// inside a user-visible root, with no symlink escape?". Run-result exports add
// one requirement it does not express: the file name must carry the extension
// the export format actually produces, so a CSV can never be written over
// (or as) a .zip / .exe / arbitrary target.
//
// Callers pass a path that either came from the native save dialog (the user
// chose it) or from a test/REST client — both go through this same function.
import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafeExportPath } from "./archive-path-guard.js";

export type ExportExtension = "json" | "csv" | "original";

const ALLOWED_EXTENSIONS: Record<Exclude<ExportExtension, "original">, string[]> = {
  json: ["json"],
  csv: ["csv"],
};

/** Maximum bytes we are willing to write for a run-result export. Mirrors the
 *  per-run store budget plus headroom for the summary envelope. */
export const MAX_EXPORT_BYTES = 16 * 1024 * 1024;

export function assertSafeRunExportPath(destPath: string, expected: ExportExtension): string {
  // Base checks: non-empty, no NUL, extension allowlist, inside an allowed
  // root, no symlink anywhere in the ancestor chain. Reusing the archive
  // guard's core keeps a single implementation of the hard part.
  const resolved = assertSafeExportPath(destPath, expected === "original" ? null : ALLOWED_EXTENSIONS[expected]);
  if (expected === "original" && !path.extname(resolved)) {
    throw new Error(`Export destination must carry a file extension: ${JSON.stringify(destPath)}`);
  }
  // A directory at the destination is always a mistake, and renameSync would
  // fail with a confusing errno. Fail loudly and early instead.
  try {
    if (fs.lstatSync(resolved).isDirectory()) throw new Error(`Export destination is a directory: ${resolved}`);
  } catch (e: any) {
    if (e && /is a directory/.test(e.message)) throw e;
    if (e && e.code !== "ENOENT") throw e;
  }
  return resolved;
}
