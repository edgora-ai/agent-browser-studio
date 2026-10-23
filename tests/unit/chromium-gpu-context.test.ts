import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

import { readChromiumGpuContext } from "../../src/main/services/browser/chromium-gpu-context.js";

const host = { hostPlatform: "darwin", hostArchitecture: "arm64" };
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-architecture-unit-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function thin(cpu = 0x0100000c, little = true): Buffer {
  const bytes = Buffer.alloc(64);
  const word = (value: number, offset: number) => little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  word(0xfeedfacf, 0); word(cpu, 4); word(2, 12);
  return bytes;
}
function file(bytes: Buffer, name = "Chromium"): string {
  const result = path.join(root, name);
  fs.writeFileSync(result, bytes, { flag: "wx", mode: 0o600 });
  return result;
}
function universal(wide = false, little = false): Buffer {
  const bytes = Buffer.alloc(256);
  const word = (value: number, offset: number) => little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  word(wide ? 0xcafebabf : 0xcafebabe, 0); word(2, 4);
  for (const [i, cpu] of [0x01000007, 0x0100000c].entries()) {
    const start = 8 + i * (wide ? 32 : 20), offset = 128 + i * 64;
    word(cpu, start);
    if (wide) {
      if (little) { bytes.writeBigUInt64LE(BigInt(offset), start + 8); bytes.writeBigUInt64LE(64n, start + 16); }
      else { bytes.writeBigUInt64BE(BigInt(offset), start + 8); bytes.writeBigUInt64BE(64n, start + 16); }
      word(5, start + 24);
    } else { word(offset, start + 8); word(64, start + 12); word(5, start + 16); }
    thin(cpu).copy(bytes, offset);
  }
  return bytes;
}

describe("bounded Mach-O GPU policy context (synthetic headers, not runtime proof)", () => {
  it.each([true, false])("reads the arm64 executable header with little endian %s", (little) => {
    const result = readChromiumGpuContext(file(thin(0x0100000c, little)), host);
    expect(result).toMatchObject({ ...host, kernelArchitecture: "arm64", architectureObservation: "observed", architectureReason: null });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("distinguishes an x64 executable from a native arm64 one", () => {
    expect(readChromiumGpuContext(file(thin(0x01000007)), host).kernelArchitecture).toBe("x64");
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])("verifies universal slices wide=%s little=%s", (wide, little) => {
    const read = vi.spyOn(fs, "readSync");
    expect(readChromiumGpuContext(file(universal(wide, little)), host).kernelArchitecture).toBe("arm64");
    // readSync's final type overload uses options; production calls use positional length.
    const total = read.mock.calls.reduce((sum, call) => sum + Number((call as readonly unknown[])[3]), 0);
    expect(total).toBeLessThan(4096);
  });
  it.each([
    ["truncated", () => thin().subarray(0, 20)],
    ["not-mach-o", () => Buffer.from("not an executable".repeat(4))],
    ["dylib", () => { const b = thin(); b.writeUInt32LE(6, 12); return b; }],
    ["unsupported-cpu", () => thin(12)],
    ["excessive-fat-count", () => { const b = universal(); b.writeUInt32BE(33, 4); return b; }],
    ["slice-out-of-file", () => { const b = universal(); b.writeUInt32BE(250, 36); return b; }],
    ["slice-overlaps-table", () => { const b = universal(); b.writeUInt32BE(32, 16); return b; }],
    ["slices-overlap", () => { const b = universal(); b.writeUInt32BE(128, 36); return b; }],
    ["slice-cpu-mismatch", () => { const b = universal(); thin(0x01000007).copy(b, 192); return b; }],
    ["alignment-invalid", () => { const b = universal(); b.writeUInt32BE(32, 24); return b; }],
    ["unsafe-wide-offset", () => { const b = universal(true); b.writeBigUInt64BE(2n ** 63n, 16); return b; }],
  ] as const)("keeps malformed input %s unknown", (_name, bytes) => {
    expect(readChromiumGpuContext(file(bytes()), host)).toMatchObject({ kernelArchitecture: null, architectureObservation: "unknown" });
  });
  it.each([
    { hostPlatform: "darwin", hostArchitecture: "x64" },
    { hostPlatform: "linux", hostArchitecture: "arm64" },
    { hostPlatform: "win32", hostArchitecture: "arm64" },
  ])("does not inspect a binary for unsupported host %j", (unsupported) => {
    const stat = vi.spyOn(fs, "lstatSync");
    expect(readChromiumGpuContext("not-read", unsupported)).toMatchObject({ kernelArchitecture: null, architectureObservation: "not-required" });
    expect(stat).not.toHaveBeenCalled();
  });
  it("does not read through a test symlink or directory", () => {
    const target = file(thin()), link = path.join(root, "link");
    fs.symlinkSync(target, link);
    const read = vi.spyOn(fs, "readSync");
    expect(readChromiumGpuContext(link, host).kernelArchitecture).toBeNull();
    expect(readChromiumGpuContext(root, host).kernelArchitecture).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it("retains an explicit read failure without enabling the policy", () => {
    const executable = file(thin());
    vi.spyOn(fs, "readSync").mockImplementation(() => { throw Object.assign(new Error("controlled EIO"), { code: "EIO" }); });
    const close = vi.spyOn(fs, "closeSync");
    expect(readChromiumGpuContext(executable, host)).toMatchObject({ kernelArchitecture: null, architectureReason: "executable-header-read-failed:EIO" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps a real path replacement or exact native Windows rename denial unknown while the original descriptor is being read", () => {
    const originalBytes = thin(), replacementBytes = thin(0x01000007);
    const executable = file(originalBytes), replacement = file(replacementBytes, "replacement");
    const originalOwner = fs.lstatSync(executable, { bigint: true }), replacementOwner = fs.lstatSync(replacement, { bigint: true });
    const originalRead = fs.readSync, close = vi.spyOn(fs, "closeSync");
    let attempts = 0, replacements = 0, readCount = 0, readOwner: fs.BigIntStats | undefined, replacementError: unknown;
    const read = vi.spyOn(fs, "readSync").mockImplementation((...args: any[]) => {
      const count = (originalRead as any)(...args);
      readCount = count; readOwner = fs.fstatSync(args[0], { bigint: true }); attempts++;
      try { fs.renameSync(replacement, executable); replacements++; }
      catch (error) { replacementError = error; throw error; }
      return count;
    });
    const result = readChromiumGpuContext(executable, host);
    expect(read).toHaveBeenCalledOnce(); expect(attempts).toBe(1); expect(readCount).toBe(32);
    expect(readOwner?.isFile()).toBe(true); expect(readOwner).toMatchObject({ dev: originalOwner.dev, ino: originalOwner.ino });
    const fd = read.mock.calls[0][0];
    expect(close).toHaveBeenCalledExactlyOnceWith(fd); expect(close.mock.results[0].type).toBe("return");
    expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    read.mockRestore(); close.mockRestore();
    const expectOwnedBytes = (name: string, bytes: Buffer, owner: fs.BigIntStats) => {
      const current = fs.lstatSync(name, { bigint: true });
      expect(current.isFile()).toBe(true); expect(current.nlink).toBe(owner.nlink);
      expect([current.dev, current.ino]).toEqual([owner.dev, owner.ino]);
      expect(fs.readFileSync(name)).toEqual(bytes);
    };
    if (replacementError !== undefined) {
      // This is an observed failed mutation, NOT replacement/identity-change
      // coverage. Reject any other errno, syscall or non-Windows failure.
      expect(process.platform).toBe("win32"); expect(replacements).toBe(0);
      expect(replacementError).toMatchObject({ code: "EPERM", syscall: "rename", path: replacement, dest: executable });
      expect(result).toMatchObject({ kernelArchitecture: null, architectureObservation: "unknown", architectureReason: "executable-header-read-failed:EPERM" });
      expectOwnedBytes(executable, originalBytes, originalOwner); expectOwnedBytes(replacement, replacementBytes, replacementOwner);
    } else {
      expect(replacements).toBe(1);
      expect(result).toMatchObject({ kernelArchitecture: null, architectureObservation: "unknown", architectureReason: "executable-changed-during-read" });
      expectOwnedBytes(executable, replacementBytes, replacementOwner);
      expect(fs.lstatSync(replacement, { throwIfNoEntry: false })).toBeUndefined();
      expect([replacementOwner.dev, replacementOwner.ino]).not.toEqual([originalOwner.dev, originalOwner.ino]);
    }
  });
});
