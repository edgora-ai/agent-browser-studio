import * as fs from "node:fs";
import type { ChromiumGpuContext } from "../browser-fingerprint-config.js";

type Architecture = "arm64" | "x64";
export interface ChromiumGpuContextObservation extends ChromiumGpuContext {
  readonly architectureObservation: "observed" | "unknown" | "not-required";
  readonly architectureReason: string | null;
}

function cpuArchitecture(cpu: number): Architecture | null {
  return cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : null;
}

function thinArchitecture(bytes: Buffer): Architecture | null {
  if (bytes.length < 32) return null;
  const little = bytes.readUInt32LE(0) === 0xfeedfacf;
  if (!little && bytes.readUInt32BE(0) !== 0xfeedfacf) return null;
  const word = (offset: number) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (word(12) !== 2) return null; // MH_EXECUTE, not a library or object file.
  return cpuArchitecture(word(4));
}

function architectureFromFile(fd: number, size: number): Architecture | null {
  const read = (offset: number, length: number): Buffer | null => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > size) return null;
    const bytes = Buffer.alloc(length);
    return fs.readSync(fd, bytes, 0, length, offset) === length ? bytes : null;
  };
  const header = read(0, 32);
  if (!header) return null;
  const thin = thinArchitecture(header);
  if (thin) return thin;
  const magic = header.readUInt32BE(0);
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return null;
  const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
  if (count < 1 || count > 32) return null;
  const stride = fat64 ? 32 : 20;
  const table = read(8, count * stride);
  if (!table) return null;
  const ranges: Array<{ offset: number; end: number }> = [];
  const architectures = new Set<Architecture>();
  for (let i = 0; i < count; i++) {
    const entry = table.subarray(i * stride, (i + 1) * stride);
    const word = (offset: number) => little ? entry.readUInt32LE(offset) : entry.readUInt32BE(offset);
    const wide = (offset: number) => little ? entry.readBigUInt64LE(offset) : entry.readBigUInt64BE(offset);
    const offset = fat64 ? Number(wide(8)) : word(8);
    const length = fat64 ? Number(wide(16)) : word(12);
    const alignment = word(fat64 ? 24 : 16);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 32 ||
        offset < 8 + table.length || offset > size - length || alignment > 31 || offset % 2 ** alignment !== 0) return null;
    if (ranges.some((range) => offset < range.end && offset + length > range.offset)) return null;
    ranges.push({ offset, end: offset + length });
    const declared = cpuArchitecture(word(0));
    if (!declared) continue;
    const slice = read(offset, 32);
    if (!slice || thinArchitecture(slice) !== declared || architectures.has(declared)) return null;
    architectures.add(declared);
  }
  // This reader is used only by a native arm64 host context. A universal image
  // with an arm64 executable slice therefore has a supported native slice.
  return architectures.has("arm64") ? "arm64" : architectures.has("x64") ? "x64" : null;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Read bounded executable headers only; unknown identity never enables GPU overrides. */
export function readChromiumGpuContext(
  executablePath: string,
  host: { hostPlatform: string; hostArchitecture: string } = {
    hostPlatform: process.platform, hostArchitecture: process.arch,
  },
): ChromiumGpuContextObservation {
  const observation = (kernelArchitecture: Architecture | null,
    architectureObservation: ChromiumGpuContextObservation["architectureObservation"],
    architectureReason: string | null): ChromiumGpuContextObservation => Object.freeze({
      hostPlatform: host.hostPlatform, hostArchitecture: host.hostArchitecture,
      kernelArchitecture, architectureObservation, architectureReason,
    });
  if (host.hostPlatform !== "darwin" || host.hostArchitecture !== "arm64") {
    return observation(null, "not-required", "host-does-not-support-managed-apple-gpu");
  }
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(executablePath);
    if (!before.isFile() || !Number.isSafeInteger(before.size)) return observation(null, "unknown", "not-a-regular-executable");
    fd = fs.openSync(executablePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!sameFile(before, fs.fstatSync(fd))) return observation(null, "unknown", "executable-changed-before-read");
    const architecture = architectureFromFile(fd, before.size);
    const after = fs.lstatSync(executablePath);
    if (!after.isFile() || !sameFile(before, after) || !sameFile(before, fs.fstatSync(fd))) {
      return observation(null, "unknown", "executable-changed-during-read");
    }
    return observation(architecture, architecture ? "observed" : "unknown", architecture ? null : "unsupported-or-malformed-mach-o");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return observation(null, "unknown", "executable-header-read-failed:" + (typeof code === "string" ? code : "unknown"));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
