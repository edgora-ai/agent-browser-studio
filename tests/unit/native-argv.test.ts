import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import { DARWIN_ARGV_READER, NATIVE_ARGV_LIMITATIONS, readOwnedNativeArgv,
  type ExpectedNativeLaunchIdentity, type NativeArgvGenerationWitness, type OwnedNativeArgvObservation } from "../e2e/helpers/native-argv.js";

const ENVIRONMENT_SENTINEL = "SYNTHETIC_ENVIRONMENT_SECRET=never-emit-environment-value";
const CLEAN_ENV = { PATH: process.env.PATH, LC_ALL: "C" };
const EXPECTED: ExpectedNativeLaunchIdentity = {
  pid: 12345, executablePath: "/owned/executable", argv0: "/owned/executable", profileDir: "/owned/synthetic profile", port: 39817,
};
const flags = (expected = EXPECTED): string[] => [expected.argv0, `--user-data-dir=${expected.profileDir}`, `--remote-debugging-port=${expected.port}`];
interface FixtureSnapshot { executablePath: string; generation: NativeArgvGenerationWitness }
interface FixtureInput { expected: ExpectedNativeLaunchIdentity; before: FixtureSnapshot; after: FixtureSnapshot; buffer: string }
function fixtureBuffer(argv: string[], options: { argc?: number; executablePath?: string; tail?: string } = {}): Buffer {
  const count = Buffer.alloc(4); count.writeInt32LE(options.argc ?? argv.length);
  return Buffer.concat([count, Buffer.from(`${options.executablePath ?? EXPECTED.executablePath}\0\0\0`),
    Buffer.from(`${argv.join("\0")}\0${options.tail ?? ENVIRONMENT_SENTINEL}\0`)]);
}
function fixture(argv = flags(), options: Parameters<typeof fixtureBuffer>[1] = {}): FixtureInput {
  const generation: NativeArgvGenerationWitness = { pid: EXPECTED.pid, uid: process.getuid!(), ppid: 23456, startSeconds: "1792300000", startMicroseconds: "123456" };
  const snapshot = { executablePath: EXPECTED.executablePath, generation };
  return { expected: { ...EXPECTED }, before: structuredClone(snapshot), after: structuredClone(snapshot), buffer: fixtureBuffer(argv, options).toString("base64") };
}
function decode(input: FixtureInput): OwnedNativeArgvObservation & { args: string[] } {
  // Pure fixture mode never calls sysctl/proc_pidinfo for the synthetic PID.
  return JSON.parse(execFileSync("python3", ["-I", "-S", "-B", "-c", DARWIN_ARGV_READER, "decode-fixture"], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 3_000, env: CLEAN_ENV, maxBuffer: 512 * 1024, stdio: "pipe",
  }));
}
function expectRejected(input: FixtureInput, code?: string): void {
  let failure: unknown;
  try { decode(input); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  const error = failure as Error & { stdout: string; stderr: string; status: number };
  expect(error.status).toBe(1);
  expect(error.stdout.length === 0, "Rejected capture must emit no partial argv JSON").toBe(true);
  expect(!error.stderr.includes("SYNTHETIC_ENVIRONMENT_SECRET"), "Failure diagnostics must not expose environment names").toBe(true);
  expect(!error.stderr.includes("never-emit-environment-value"), "Failure diagnostics must not expose environment values").toBe(true);
  if (code) expect(JSON.parse(error.stderr)).toMatchObject({ error: code });
}

// Mac-only test observer. Real reads below target only the exact clean-env child
// created in this test; malformed/generation controls use synthetic byte data.
describe.skipIf(process.platform !== "darwin")("exact owned macOS process argv observation", () => {
  it("keeps empty later/newline/Unicode/quoted arguments and excludes the environment block", () => {
    const argv = [...flags(), "", "title\n中文 \"quoted\"", "data:text/html,<p id='owned'>\nowned\n</p>", ""];
    const observed = decode(fixture(argv));
    expect(JSON.stringify(observed.args) === JSON.stringify(argv), "Owned argv bytes must retain exact argument boundaries").toBe(true);
    const serialized = JSON.stringify(observed);
    expect(!serialized.includes("SYNTHETIC_ENVIRONMENT_SECRET"), "No trailing environment name crosses stdout").toBe(true);
    expect(!serialized.includes("never-emit-environment-value"), "No trailing environment value crosses stdout").toBe(true);
    expect(observed.ownershipWitness).toMatchObject({ source: "PROC_PIDTBSDINFO+proc_pidpath+KERN_PROCARGS2",
      execGeneration: "unavailable-public-sdk", fullExecGenerationProof: false, limitations: NATIVE_ARGV_LIMITATIONS });
    expect(observed.ownershipWitness.before).toEqual(observed.ownershipWitness.after);
    expect(observed.ownershipWitness.limitations.join(" ")).toMatch(/same-image exec\/ABA/);
  });

  it.each([
    { label: "empty first argv only", argv: [""] },
    { label: "empty first argv followed by real flags", argv: ["", ...flags().slice(1)] },
    { label: "two empty first argv entries", argv: ["", "", ...flags().slice(1)] },
    { label: "empty first argv followed by repeated executable and flags", argv: ["", ...flags()] },
  ])("rejects $label without printing an environment candidate", ({ argv }) => {
    expectRejected(fixture(argv));
  });

  it("rejects a malformed argc that would otherwise consume the environment as an extra argument", () => {
    expectRejected(fixture(flags(), { argc: flags().length + 1 }), "ambiguous-environment-argument");
  });

  it("rejects truncated/invalid/budget-exceeding inventories without partial stdout", () => {
    const short = fixture(); short.buffer = Buffer.alloc(3).toString("base64");
    const truncated = fixture(flags(), { argc: 8 });
    const oversized = fixture(); oversized.buffer = Buffer.alloc(262145).toString("base64");
    const missingTerminator = fixture(); missingTerminator.buffer = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from("/owned/unterminated")]).toString("base64");
    const badBase64 = fixture(); badBase64.buffer = "not base64";
    for (const input of [short, truncated, oversized, missingTerminator, badBase64,
      fixture(flags(), { argc: 0 }), fixture(flags(), { argc: 257 })]) expectRejected(input);
  });

  it.each(["before", "after"] as const)("rejects a mismatched %s executable before stdout", (side) => {
    const input = fixture(); input[side].executablePath = "/unowned/executable";
    expectRejected(input, "observed-executable-mismatch");
  });

  it("rejects the kernel buffer executable slot even when before/after paths agree", () => {
    expectRejected(fixture(flags(), { executablePath: "/unowned/kernel-executable" }), "kernel-executable-mismatch");
  });

  it("rejects a spoofed or noncanonical expected argv0 rather than trusting proc_pidpath alone", () => {
    expectRejected(fixture(["/unowned/argv0", ...flags().slice(1)]), "argv0-mismatch-or-leading-empty");
    const input = fixture(); input.expected.argv0 = "/owned/../owned/executable";
    expectRejected(input, "invalid-expected-path");
  });

  it.each(["before", "after"] as const)("rejects %s PID and UID mismatch without emitting argv", (side) => {
    const pid = fixture(); pid[side].generation.pid++;
    expectRejected(pid, "observed-pid-mismatch");
    const uid = fixture(); uid[side].generation.uid++;
    expectRejected(uid, "observed-uid-mismatch");
  });

  it.each(["ppid", "startSeconds", "startMicroseconds"] as const)("rejects changed %s generation evidence", (field) => {
    const input = fixture();
    if (field === "ppid") input.after.generation.ppid++;
    else input.after.generation[field] = String(BigInt(input.after.generation[field]) + 1n);
    expectRejected(input, "process-generation-changed");
  });

  it("rejects malformed start/parent witnesses instead of calling agreement proof", () => {
    for (const update of [{ startSeconds: "0" }, { startSeconds: "1.5" }, { startMicroseconds: "1000000" }, { startMicroseconds: "001" }, { ppid: 0 }]) {
      const input = fixture(); Object.assign(input.before.generation, update); Object.assign(input.after.generation, update);
      expectRejected(input);
    }
  });

  it.each([
    { label: "wrong profile", argv: [...flags(), "--user-data-dir=/unowned/profile"] },
    { label: "duplicate profile", argv: [...flags(), flags()[1]] },
    { label: "split profile flag", argv: [EXPECTED.argv0, "--user-data-dir", EXPECTED.profileDir, flags()[2]] },
    { label: "wrong port", argv: [...flags(), "--remote-debugging-port=39818"] },
    { label: "duplicate port", argv: [...flags(), flags()[2]] },
    { label: "missing port", argv: flags().slice(0, 2) },
  ])("rejects $label inside Python before stdout", ({ argv }) => {
    expectRejected(fixture(argv));
  });

  it("does not accept PID-only or invalid caller identity", () => {
    expect(() => readOwnedNativeArgv(EXPECTED.pid as unknown as ExpectedNativeLaunchIdentity)).toThrow(/exact owned/);
    for (const patch of [{ pid: 0 }, { pid: 2147483648 }, { port: 0 }, { profileDir: "relative" }, { executablePath: "relative" }, { argv0: "/other/executable" }]) {
      expect(() => readOwnedNativeArgv({ ...EXPECTED, ...patch })).toThrow(/exact owned/);
    }
  });

  it("reads only its clean-env owned child, brackets start identity and exits that child normally", async () => {
    // A framework Python launcher can retain sys.executable after re-exec.
    // This newly created isolated probe asks dyld only about ITSELF, then the
    // test launches that canonical image with the same explicit argv0.
    const selfExecutable = "import ctypes,os,sys; lib=ctypes.CDLL(None); lib._NSGetExecutablePath.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)]; lib._NSGetExecutablePath.restype=ctypes.c_int; data=ctypes.create_string_buffer(4096); size=ctypes.c_uint32(4096); result=lib._NSGetExecutablePath(data,ctypes.byref(size)); result==0 or sys.exit(1); sys.stdout.write(os.path.realpath(os.fsdecode(data.value)))";
    const python = execFileSync("python3", ["-I", "-S", "-B", "-c", selfExecutable], {
      encoding: "utf8", timeout: 3_000, env: CLEAN_ENV, stdio: "pipe",
    });
    expect(path.isAbsolute(python)).toBe(true);
    const args = ["-I", "-S", "-B", "-c", "import sys; print('ready',flush=True); sys.stdin.readline()",
      `--user-data-dir=${EXPECTED.profileDir}`, `--remote-debugging-port=${EXPECTED.port}`, "--display-title=中文\nline two", "", "--literal=\"quoted\""];
    const child = spawn(python, args, { argv0: python, env: CLEAN_ENV, stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [ready] = await Promise.race([once(child.stdout, "data"), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned fixture readiness deadline")), 3_000);
      })]);
      if (timer) clearTimeout(timer);
      expect(String(ready).trim()).toBe("ready"); expect(child.pid).toBeGreaterThan(0);
      const expected: ExpectedNativeLaunchIdentity = { ...EXPECTED, pid: child.pid!, executablePath: python, argv0: python };
      const observed = readOwnedNativeArgv(expected);
      expect(observed.pid).toBe(child.pid); expect(observed.executablePath).toBe(python);
      expect(observed.args).toEqual(args);
      expect(observed.profileDirs).toEqual([EXPECTED.profileDir]); expect(observed.cdpPorts).toEqual([EXPECTED.port]);
      expect(observed.malformed).toBe(false);
      expect(observed.ownershipWitness.before).toEqual(observed.ownershipWitness.after);
      expect(observed.ownershipWitness.before).toMatchObject({ pid: child.pid, uid: process.getuid!(), ppid: process.pid });
      expect(observed.ownershipWitness).toMatchObject({ execGeneration: "unavailable-public-sdk", fullExecGenerationProof: false });
      expect(observed.ownershipWitness.limitations).toEqual(NATIVE_ARGV_LIMITATIONS);
      expect(() => readOwnedNativeArgv({ ...expected, port: expected.port + 1 })).toThrow();
    } finally {
      if (timer) clearTimeout(timer);
      child.stdin.end("\n");
      const [code, signal] = await exited;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
    }
  }, 10_000);
});
