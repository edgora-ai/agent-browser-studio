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
    const total = read.mock.calls.reduce((sum, call) => sum + Number(call[3]), 0);
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
  it("rejects a path replaced while its original descriptor is being read", () => {
    const executable = file(thin()), replacement = file(thin(0x01000007), "replacement");
    const originalRead = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation((...args: any[]) => {
      const count = (originalRead as any)(...args);
      fs.renameSync(replacement, executable);
      return count;
    });
    expect(readChromiumGpuContext(executable, host)).toMatchObject({ kernelArchitecture: null, architectureReason: "executable-changed-during-read" });
  });
});
