import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";
import { syncArchiveDirectory } from "../../src/main/services/zip-writer.js";

// Execute the actual private confirmation function with real owned-file I/O.
// Only the Windows file-flush access rule and explicit failure are injected;
// directory durability remains a separate gate, never a fabricated success.
const text = fs.readFileSync(new URL("../../src/main/services/sync-service.ts", import.meta.url), "utf8");
const start = text.indexOf("function confirmFullProfileConfigCommitted(): void {");
const end = text.indexOf("\nfunction cleanupFullProfileStage", start);
if (start < 0 || end < start) throw new Error("Complete-config durability function not found");
const code = ts.transpileModule(text.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let root: string, file: string;
const config = { version: 1, fixture: "owned-full-config-readback" };
const descriptors = new Map<number, number | string>();

function check(options: { fileError?: boolean; directoryUnconfirmed?: boolean } = {}) {
  let fileFlushes = 0, directoryCalls = 0, directoryConfirmed: boolean | undefined;
  const io = { ...fs,
    openSync: (target: fs.PathLike, flags: number | string, mode?: fs.Mode) => {
      if (String(target) !== file) throw new Error("Unexpected complete-config fixture path");
      const fd = fs.openSync(target, flags, mode); descriptors.set(fd, flags); return fd;
    },
    closeSync: (fd: number) => { try { fs.closeSync(fd); } finally { descriptors.delete(fd); } },
    fsyncSync: (fd: number) => {
      const flags = descriptors.get(fd);
      if (options.fileError) throw Object.assign(new Error("Synthetic file flush failed"), { code: "EIO", syscall: "fsync" });
      if (typeof flags !== "number" || (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === fs.constants.O_RDONLY) {
        throw Object.assign(new Error("Synthetic Windows flush requires write access"), { code: "EPERM", syscall: "fsync" });
      }
      fs.fsyncSync(fd); fileFlushes++;
    },
  };
  const confirm = vm.runInNewContext(code + "\nconfirmFullProfileConfigCommitted;", {
    fs: io, path, Buffer, process: { platform: "win32" }, getConfigPath: () => file, getConfig: () => config,
    syncArchiveDirectory: (directory: string) => {
      expect(directory).toBe(root); directoryCalls++;
      directoryConfirmed = options.directoryUnconfirmed ? false : syncArchiveDirectory(directory);
      return directoryConfirmed;
    },
  }, { timeout: 1_000 }) as () => void;
  return { confirm, facts: () => ({ fileFlushes, directoryCalls, directoryConfirmed }) };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "full-config-durability-")));
  file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
});
afterEach(() => {
  const leaked = descriptors.size;
  for (const fd of descriptors.keys()) fs.closeSync(fd);
  descriptors.clear(); fs.rmSync(root, { recursive: true, force: true });
  expect(leaked).toBe(0);
});

describe("complete-profile configuration durability", () => {
  it("uses a writable Windows file descriptor without waiving actual directory durability", () => {
    const before = fs.readFileSync(file), run = check();
    let error: unknown;
    try { run.confirm(); } catch (failure) { error = failure; }
    expect(run.facts()).toMatchObject({ fileFlushes: 1, directoryCalls: 1 });
    if (run.facts().directoryConfirmed === false) expect(String((error as Error)?.message)).toMatch(/directory durability is unconfirmed/);
    else expect(error).toBeUndefined();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))).find(([key]) => key === "fixture")?.[1]).toBe(config.fixture);
  });

  it("keeps regular-file flush failures fatal before directory confirmation", () => {
    const before = fs.readFileSync(file), run = check({ fileError: true });
    expect(run.confirm).toThrowError(expect.objectContaining({ code: "EIO" }));
    expect(run.facts()).toMatchObject({ fileFlushes: 0, directoryCalls: 0 });
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("refuses unconfirmed directory durability even after successful file flushing", () => {
    const before = fs.readFileSync(file), run = check({ directoryUnconfirmed: true });
    expect(run.confirm).toThrow(/directory durability is unconfirmed/);
    expect(run.facts()).toMatchObject({ fileFlushes: 1, directoryCalls: 1, directoryConfirmed: false });
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
