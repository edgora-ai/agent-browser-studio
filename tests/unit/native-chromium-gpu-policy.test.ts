import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(() => { throw new Error("GPU unit tests must not launch a browser"); }),
  launch: vi.fn(() => { throw new Error("GPU unit tests must not launch a browser"); }),
  execFileSync: vi.fn(() => { throw new Error("GPU unit tests must not execute a native binary"); }),
  createServer: vi.fn(() => { throw new Error("GPU unit tests must not bind an origin"); }),
}));
vi.mock("playwright", () => ({ chromium: startup }));
vi.mock("node:child_process", () => ({ execFileSync: startup.execFileSync }));
vi.mock("node:http", () => ({ createServer: startup.createServer }));

import {
  gpuPersonaDiagnostic,
  parseNativeChromiumVerificationArgs,
  prepareGpuArtifactsRoot,
  verifyNativeGpuCorpus,
  verifyManagedGpuIdentity,
  webGlCorpusSha256,
  webGpuCorpusSha256,
} from "../../src/tools/verify-native-chromium.js";

const EXECUTABLE = path.resolve("fixture-Chromium");
const ARTIFACTS = path.resolve("owned-gpu-fixtures");

// These tiny fixtures live under the test runner's owned TMPDIR. They never
// inspect user profiles or follow symlinks into pre-existing application data.
function ownedFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gpu-owned-root-unit-"));
}

describe("native Chromium GPU verifier boundary", () => {
  it("is safe to import for pure GPU regression tests without any startup", () => {
    expect(typeof verifyNativeGpuCorpus).toBe("function");
    expect(typeof webGlCorpusSha256).toBe("function");
    expect(typeof webGpuCorpusSha256).toBe("function");
    for (const operation of Object.values(startup)) expect(operation).not.toHaveBeenCalled();
  });

  it("accepts a managed identity only when its User-Agent and persona platform are active", () => {
    const configured = { userAgent: "ManagedChromium/152.0.7977.72", platform: "Win32" as const };
    expect(() => verifyManagedGpuIdentity({ ...configured }, configured)).not.toThrow();
  });

  it("rejects an executable ignoring the managed switch even if it exposes the native GPU", () => {
    const configured = { userAgent: "ManagedChromium/152.0.7977.72", platform: "MacIntel" as const };
    expect(() => verifyManagedGpuIdentity({ userAgent: "NativeHeadlessChromium/152.0.7977.72", platform: "MacIntel" }, configured))
      .toThrow(/managed User-Agent activation/);
  });

  it("rejects native-host platform leakage under an activated cross-OS persona User-Agent", () => {
    const configured = { userAgent: "ManagedChromium/152.0.7977.72", platform: "Win32" as const };
    expect(() => verifyManagedGpuIdentity({ userAgent: configured.userAgent, platform: "MacIntel" }, configured))
      .toThrow(/managed platform activation/);
  });

  it("rejects relative artifact roots before any filesystem creation", () => {
    expect(() => prepareGpuArtifactsRoot("relative-gpu-artifacts")).toThrow(/absolute owned directory path/);
  });

  it("preserves the legacy positional executable for the full verifier", () => {
    expect(parseNativeChromiumVerificationArgs([EXECUTABLE]))
      .toEqual({ executable: EXECUTABLE, gpuOnly: false, artifacts: null });
  });

  it.each([
    { argv: [EXECUTABLE, "--gpu-only", "--artifacts", ARTIFACTS] },
    { argv: ["--gpu-only", "--artifacts", ARTIFACTS, EXECUTABLE] },
  ])("accepts bounded GPU-only arguments regardless of option position (%#)", ({ argv }) => {
    expect(parseNativeChromiumVerificationArgs(argv))
      .toEqual({ executable: EXECUTABLE, gpuOnly: true, artifacts: ARTIFACTS });
  });

  it.each([
    { label: "missing executable", argv: ["--gpu-only", "--artifacts", ARTIFACTS], error: /usage:/ },
    { label: "missing artifacts option", argv: [EXECUTABLE, "--gpu-only"], error: /requires --artifacts/ },
    { label: "missing artifacts path", argv: [EXECUTABLE, "--gpu-only", "--artifacts"], error: /absolute owned directory path/ },
    { label: "empty artifacts path", argv: [EXECUTABLE, "--gpu-only", "--artifacts", ""], error: /absolute owned directory path/ },
    { label: "flag used as artifacts path", argv: [EXECUTABLE, "--artifacts", "--gpu-only"], error: /absolute owned directory path/ },
    { label: "relative artifacts path", argv: [EXECUTABLE, "--gpu-only", "--artifacts", "relative-owned-path"], error: /absolute owned directory path/ },
    { label: "artifacts silently ignored by full mode", argv: [EXECUTABLE, "--artifacts", ARTIFACTS], error: /only supported with --gpu-only/ },
    { label: "duplicate GPU-only option", argv: [EXECUTABLE, "--gpu-only", "--gpu-only", "--artifacts", ARTIFACTS], error: /Duplicate --gpu-only/ },
    { label: "duplicate artifacts option", argv: [EXECUTABLE, "--gpu-only", "--artifacts", ARTIFACTS, "--artifacts", ARTIFACTS], error: /Duplicate --artifacts/ },
    { label: "unknown option", argv: [EXECUTABLE, "--gpu-only", "--physical-windows"], error: /Unsupported verification option/ },
    { label: "extra executable", argv: [EXECUTABLE, "other-Chromium"], error: /Unexpected extra executable/ },
  ])("rejects $label instead of silently relaxing GPU verification", ({ argv, error }) => {
    expect(() => parseNativeChromiumVerificationArgs(argv)).toThrow(error);
  });

  it.each([
    ["macos", "darwin", "native-host-persona"],
    ["windows", "win32", "native-host-persona"],
    ["windows", "darwin", "unsupported-cross-os-persona-diagnostic"],
    ["macos", "win32", "unsupported-cross-os-persona-diagnostic"],
    ["windows", "linux", "unsupported-cross-os-persona-diagnostic"],
    ["macos", "linux", "unsupported-cross-os-persona-diagnostic"],
  ] as const)("labels the %s persona on %s without claiming a different physical runtime", (platform, runtime, diagnostic) => {
    expect(gpuPersonaDiagnostic(platform, runtime)).toBe(diagnostic);
  });
});

describe.skipIf(typeof process.getuid !== "function")("GPU verifier owned artifact directory", () => {
  it("creates and reuses only a canonical current-user-owned private root", () => {
    const root = path.join(ownedFixture(), "nested", "artifacts");
    expect(prepareGpuArtifactsRoot(root)).toBe(root);
    expect(prepareGpuArtifactsRoot(root)).toBe(root);
    const stats = fs.lstatSync(root);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.uid).toBe(process.getuid!());
    expect(stats.mode & 0o777).toBe(0o700);
    expect(fs.realpathSync(root)).toBe(root);
  });

  it("rejects an existing root symlink instead of following it", () => {
    const fixture = ownedFixture();
    const target = path.join(fixture, "target");
    const alias = path.join(fixture, "artifacts-alias");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, alias, "dir");
    expect(() => prepareGpuArtifactsRoot(alias)).toThrow(/must not contain a symlink/);
  });

  it("rejects an ancestor redirect before creating anything through it", () => {
    const fixture = ownedFixture();
    const target = path.join(fixture, "target");
    const alias = path.join(fixture, "ancestor-alias");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, alias, "dir");
    expect(() => prepareGpuArtifactsRoot(path.join(alias, "nested-artifacts"))).toThrow(/must not contain a symlink/);
    expect(fs.existsSync(path.join(target, "nested-artifacts"))).toBe(false);
  });

  it("rejects a non-directory ancestor without replacing existing evidence", () => {
    const file = path.join(ownedFixture(), "existing-file");
    fs.writeFileSync(file, "owned fixture", { flag: "wx", mode: 0o600 });
    expect(() => prepareGpuArtifactsRoot(path.join(file, "artifacts"))).toThrow(/must be a directory/);
    expect(fs.readFileSync(file, "utf8")).toBe("owned fixture");
  });

  it("rejects an artifact root belonging to a different process user", () => {
    const root = ownedFixture();
    const uid = process.getuid!();
    const getter = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(() => prepareGpuArtifactsRoot(root)).toThrow(/must be owned by the current user/);
    } finally {
      getter.mockRestore();
    }
  });

  it("rejects a root writable by other users without changing its permissions", () => {
    const root = ownedFixture();
    fs.chmodSync(root, 0o777);
    try {
      expect(() => prepareGpuArtifactsRoot(root)).toThrow(/must not be writable by other users/);
      expect(fs.statSync(root).mode & 0o777).toBe(0o777);
    } finally {
      fs.chmodSync(root, 0o700);
    }
  });
});
