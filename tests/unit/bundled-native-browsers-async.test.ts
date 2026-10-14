import { EventEmitter } from "node:events";
import { promises as fsPromises, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const children = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
const filesystemGate = vi.hoisted(() => ({ checking: false, calls: [] as string[] }));
const priorities = vi.hoisted(() => ({ getPriority: vi.fn() }));
vi.mock("node:child_process", () => children);
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(), getPriority: priorities.getPriority,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
    name.endsWith("Sync") && typeof value === "function"
      ? (...args: unknown[]) => {
        if (filesystemGate.checking) filesystemGate.calls.push(name);
        return Reflect.apply(value, actual, args);
      }
      : value,
  ]));
});

import {
  bundledChromiumBinaryPath,
  bundledChromiumBinaryPathAsync,
  bundledFirefoxBinaryPath,
  bundledFirefoxBinaryPathAsync,
  readBundledBrowsersManifest,
  readBundledBrowsersManifestAsync,
} from "../../src/main/services/bundled-native-browsers.js";

type Kind = "chromium" | "firefox";
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  closed = false;
  kill = vi.fn((_signal: string) => true);
  finish(code: number | null = 0, signal: string | null = null): void {
    this.closed = true;
    this.emit("close", code, signal);
  }
}
interface Invocation {
  command: string;
  args: string[];
  child: FakeChild;
}
interface Fixture {
  resources: string;
  root: string;
  zip: string;
  cache: string;
  binary: string;
  relativeBinary: string;
}

const originalResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
let owned: string;
let calls: Invocation[];
let promises: Promise<unknown>[];
const browsers = [
  { kind: "chromium" as const, async: bundledChromiumBinaryPathAsync, sync: bundledChromiumBinaryPath },
  { kind: "firefox" as const, async: bundledFirefoxBinaryPathAsync, sync: bundledFirefoxBinaryPath },
];

function setResources(resources: string | undefined): void {
  Object.defineProperty(process, "resourcesPath", { configurable: true, writable: true, value: resources });
}

function watch<T>(promise: Promise<T>): Promise<T> {
  promises.push(promise);
  // Attach immediately: tests intentionally hold subprocesses before asserting rejection.
  void promise.catch(() => undefined);
  return promise;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Mock subprocess / private filesystem operation did not progress");
}

async function invocation(index: number, command: string): Promise<Invocation> {
  await until(() => calls.length > index);
  expect(calls[index].command).toBe(command);
  return calls[index];
}

function put(file: string, content = "non-executable fixture"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture(kind: Kind = "chromium", label: string = kind, version = "150.0+fixture"): Fixture {
  const resources = path.join(owned, label, "resources");
  const root = path.join(resources, "native-browsers");
  const app = kind === "chromium" ? "Chromium.app" : "Firefox.app";
  const relativeBinary = path.join(app, "Contents", "MacOS", kind === "chromium" ? "Chromium" : "firefox");
  const zip = path.join(root, `${app}.zip`);
  put(zip, "not a real archive");
  put(path.join(root, "browsers-manifest.json"), JSON.stringify({ [`${kind}Version`]: version }));
  const stat = statSync(zip);
  const key = /^[0-9A-Za-z._+-]+$/.test(version) ? `${version}-${stat.size}-${Math.trunc(stat.mtimeMs)}` : `${stat.size}-${Math.trunc(stat.mtimeMs)}`;
  const cache = path.join(process.env.AGENT_BROWSER_BUNDLED_CACHE_DIR!, `${kind}-darwin-${key.replace(/[^0-9A-Za-z._-]/g, "_")}`);
  return { resources, root, zip, cache, binary: path.join(cache, relativeBinary), relativeBinary };
}

function extract(call: Invocation, item: Fixture): string {
  expect(call.args.slice(0, 3)).toEqual(["-x", "-k", item.zip]);
  const stage = call.args[3];
  expect(stage.startsWith(`${item.cache}.stage-`)).toBe(true);
  expect(stage).not.toBe(item.cache);
  put(path.join(stage, item.relativeBinary));
  return stage;
}

async function succeed(item: Fixture, index = 0): Promise<string> {
  const unpack = await invocation(index, "ditto");
  const stage = extract(unpack, item);
  expect(existsSync(path.join(stage, ".ready"))).toBe(false);
  unpack.child.finish();
  const verify = await invocation(index + 1, "codesign");
  expect(verify.args).toEqual(["--verify", "--deep", "--strict", path.join(stage, item.relativeBinary.split(path.sep)[0])]);
  expect(existsSync(path.join(stage, ".ready"))).toBe(false);
  expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
  verify.child.finish();
  return stage;
}

function seedReady(item: Fixture, content = "verified winner"): void {
  put(item.binary, content);
  const marker = "winner marker\n";
  const stat = statSync(item.zip);
  const archive = { source: realpathSync(item.zip), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  put(path.join(item.cache, ".ready.archive.json"), JSON.stringify({ protocol: "bundled-browser-ready-v1", marker, archive }));
  put(path.join(item.cache, ".ready"), marker);
}

function assertNoOwnedWork(item: Fixture): void {
  expect(existsSync(`${item.cache}.lock`)).toBe(false);
  const parent = path.dirname(item.cache);
  if (existsSync(parent)) expect(readdirSync(parent).filter((name) => name.startsWith(`${path.basename(item.cache)}.stage-`))).toEqual([]);
}

beforeEach(() => {
  filesystemGate.checking = false;
  filesystemGate.calls = [];
  priorities.getPriority.mockReset().mockImplementation(() => { throw new Error("Unexpected PID lookup"); });
  // The offline wrapper sets TMPDIR to the private sandbox. All binaries are
  // plain non-executable files and both child-process entry points are mocked.
  owned = mkdtempSync(path.join(tmpdir(), "bundled-native-async-"));
  calls = [];
  promises = [];
  setResources(undefined);
  vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", undefined);
  vi.stubEnv("AGENT_BROWSER_BUNDLED_CACHE_DIR", path.join(owned, "cache"));
  children.spawn.mockReset().mockImplementation((command: string, args: string[]) => {
    if (command !== "ditto" && command !== "codesign") throw new Error(`Unexpected mock command ${command}`);
    const child = new FakeChild();
    calls.push({ command, args, child });
    return child;
  });
  children.spawnSync.mockReset().mockImplementation(() => {
    throw new Error("Async discovery must never call a synchronous subprocess");
  });
});

afterEach(async () => {
  filesystemGate.checking = false;
  for (const call of calls) if (!call.child.closed) call.child.finish(1);
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(350000);
  await Promise.allSettled(promises);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalResources) Object.defineProperty(process, "resourcesPath", originalResources);
  else Reflect.deleteProperty(process, "resourcesPath");
  rmSync(owned, { recursive: true, force: true });
});

describe.each(browsers)("$kind asynchronous archive discovery", (browser) => {
  it("defers both real async subprocess entry points, keeps timers responsive, and publishes only after strict verification", async () => {
    const item = fixture(browser.kind);
    let settled = false;
    const result = watch(browser.async("darwin", item.resources));
    void result.then(() => { settled = true; });
    const unpack = await invocation(0, "ditto");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(existsSync(item.binary)).toBe(false);
    expect(existsSync(`${item.cache}.lock`)).toBe(true);
    expect(children.spawnSync).not.toHaveBeenCalled();
    expect(children.spawn.mock.calls[0][2]).toEqual({ stdio: ["ignore", "pipe", "pipe"] });
    const stage = await succeed(item);
    await expect(result).resolves.toBe(item.binary);
    expect(readFileSync(item.binary, "utf8")).toBe("non-executable fixture");
    expect(readFileSync(path.join(item.cache, ".ready"), "utf8")).toMatch(/^\d+\n$/);
    expect(existsSync(stage)).toBe(false);
    expect(unpack.child.kill).not.toHaveBeenCalled();
    assertNoOwnedWork(item);
    await expect(browser.async("darwin", item.resources)).resolves.toBe(item.binary);
    expect(calls).toHaveLength(2);
  });

  it("coalesces overlaps but does not keep a permanent fulfilled singleton", async () => {
    const item = fixture(browser.kind);
    const first = watch(browser.async("darwin", item.resources));
    const second = watch(browser.async("darwin", item.resources));
    const third = watch(browser.async("darwin", item.resources));
    const stage = await succeed(item);
    await expect(Promise.all([first, second, third])).resolves.toEqual([item.binary, item.binary, item.binary]);
    expect(calls).toHaveLength(2);
    rmSync(item.cache, { recursive: true });
    const retry = watch(browser.async("darwin", item.resources));
    const nextStage = await succeed(item, 2);
    await expect(retry).resolves.toBe(item.binary);
    expect(nextStage).not.toBe(stage);
    assertNoOwnedWork(item);
  });

  it("preserves a ready+binary fast path even with an unknown live lock", async () => {
    const item = fixture(browser.kind);
    seedReady(item);
    put(`${item.cache}.lock`, "unknown owner");
    await expect(browser.async("darwin", item.resources)).resolves.toBe(item.binary);
    expect(browser.sync("darwin", item.resources)).toBe(item.binary);
    expect(readFileSync(`${item.cache}.lock`, "utf8")).toBe("unknown owner");
    expect(calls).toHaveLength(0);
    expect(children.spawnSync).not.toHaveBeenCalled();
  });

  it.each(["unpack nonzero", "missing binary", "verification nonzero", "binary removed after verification"])("fails closed for %s and retries after shared rejection", async (failure) => {
    const item = fixture(browser.kind);
    const first = watch(browser.async("darwin", item.resources));
    const second = watch(browser.async("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    const stage = unpack.args[3];
    if (failure !== "missing binary") extract(unpack, item);
    unpack.child.stderr.emit("data", Buffer.from("fixture extraction diagnostic"));
    unpack.child.finish(failure === "unpack nonzero" ? 7 : 0);
    let next = 1;
    if (failure.startsWith("verification") || failure.startsWith("binary removed")) {
      const verify = await invocation(1, "codesign");
      if (failure.startsWith("binary removed")) unlinkSync(path.join(stage, item.relativeBinary));
      verify.child.stderr.emit("data", Buffer.from("fixture signature diagnostic"));
      verify.child.finish(failure.startsWith("verification") ? 9 : 0);
      next = 2;
    }
    await expect(first).rejects.toThrow(/failed|missing/);
    await expect(second).rejects.toThrow(/failed|missing/);
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
    expect(existsSync(stage)).toBe(false);
    expect(calls).toHaveLength(next);
    assertNoOwnedWork(item);
    const retry = watch(browser.async("darwin", item.resources));
    await succeed(item, next);
    await expect(retry).resolves.toBe(item.binary);
  });
});

describe("bounded subprocess failure and ownership", () => {
  it.each([
    { command: "ditto", timeout: 300000, index: 0 },
    { command: "codesign", timeout: 30000, index: 1 },
  ])("$command timeout kills only its own child and waits for close before cleanup", async ({ command, timeout, index }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    let settled = false;
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    void result.then(() => { settled = true; }, () => { settled = true; });
    const unpack = await invocation(0, "ditto");
    const stage = extract(unpack, item);
    if (index === 1) unpack.child.finish();
    const running = await invocation(index, command);
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(running.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(running.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);
    expect(existsSync(stage)).toBe(true);
    expect(existsSync(`${item.cache}.lock`)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(running.child.kill).toHaveBeenCalledWith("SIGKILL");
    running.child.emit("exit", null, "SIGKILL");
    expect(settled).toBe(false);
    expect(existsSync(stage)).toBe(true);
    running.child.finish(null, "SIGKILL");
    await expect(result).rejects.toThrow(`${command} timed out after ${timeout}ms`);
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
    assertNoOwnedWork(item);
  });

  it("bounds combined stdout/stderr, waits for termination, and does not mask the output limit error", async () => {
    const item = fixture();
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    unpack.child.stdout.emit("data", Buffer.alloc(512 * 1024));
    unpack.child.stderr.emit("data", Buffer.alloc(512 * 1024 + 1));
    expect(unpack.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(existsSync(unpack.args[3])).toBe(true);
    expect(existsSync(`${item.cache}.lock`)).toBe(true);
    unpack.child.finish(null, "SIGTERM");
    await expect(result).rejects.toThrow("output exceeded 1048576 bytes");
    assertNoOwnedWork(item);
  });

  it("waits for close after a child error, and permits retry", async () => {
    const item = fixture();
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    unpack.child.emit("error", new Error("fixture spawn failure"));
    expect(existsSync(unpack.args[3])).toBe(true);
    expect(existsSync(`${item.cache}.lock`)).toBe(true);
    unpack.child.finish(null);
    await expect(result).rejects.toThrow("fixture spawn failure");
    assertNoOwnedWork(item);
    const retry = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await succeed(item, 1);
    await expect(retry).resolves.toBe(item.binary);
  });

  it("cleans only staging when spawn itself throws", async () => {
    const item = fixture();
    put(item.binary, "incomplete legacy binary");
    children.spawn.mockImplementationOnce(() => { throw new Error("fixture synchronous spawn throw"); });
    await expect(bundledChromiumBinaryPathAsync("darwin", item.resources)).rejects.toThrow("fixture synchronous spawn throw");
    expect(readFileSync(item.binary, "utf8")).toBe("incomplete legacy binary");
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
    assertNoOwnedWork(item);
  });

  it("never removes an unknown replacement lock", async () => {
    const item = fixture();
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await invocation(0, "ditto");
    rmSync(`${item.cache}.lock`, { recursive: true });
    put(`${item.cache}.lock`, "replacement owner");
    await succeed(item);
    await expect(result).rejects.toThrow(/lock ownership changed/);
    expect(readFileSync(`${item.cache}.lock`, "utf8")).toBe("replacement owner");
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
  });
});

describe("shared sync / async / cross-main destination lock", () => {
  it("sync explicitly reports busy during async extraction rather than deleting or advertising its work", async () => {
    const item = fixture();
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/cache is busy/);
    expect(existsSync(unpack.args[3])).toBe(true);
    expect(existsSync(item.binary)).toBe(false);
    expect(children.spawnSync).not.toHaveBeenCalled();
    await succeed(item);
    await expect(result).resolves.toBe(item.binary);
    expect(bundledChromiumBinaryPath("darwin", item.resources)).toBe(item.binary);
  });

  it("async waits with timers for a synchronous winner, without launching another child", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    let follower: Promise<string | null> | undefined;
    children.spawnSync.mockImplementation((command: string, args: string[], options: Record<string, unknown>) => {
      expect(options.maxBuffer).toBe(1048576);
      if (command === "ditto") {
        expect(options.timeout).toBe(300000);
        expect(existsSync(`${item.cache}.lock`)).toBe(true);
        follower = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
        put(path.join(args[3], item.relativeBinary));
        expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/cache is busy/);
      } else {
        expect(command).toBe("codesign");
        expect(args.slice(0, 3)).toEqual(["--verify", "--deep", "--strict"]);
        expect(options.timeout).toBe(30000);
      }
      return { status: 0, stderr: "" };
    });
    expect(bundledChromiumBinaryPath("darwin", item.resources)).toBe(item.binary);
    await vi.advanceTimersByTimeAsync(50);
    await expect(follower).resolves.toBe(item.binary);
    expect(children.spawn).not.toHaveBeenCalled();
    expect(children.spawnSync).toHaveBeenCalledTimes(2);
    assertNoOwnedWork(item);
  });

  it("separate module instances coordinate through the filesystem, not just the in-memory map", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    vi.resetModules();
    const otherMain = await import("../../src/main/services/bundled-native-browsers.js");
    const first = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await invocation(0, "ditto");
    const other = watch(otherMain.bundledChromiumBinaryPathAsync("darwin", item.resources));
    await until(() => vi.getTimerCount() >= 2);
    expect(calls).toHaveLength(1);
    await succeed(item);
    await expect(first).resolves.toBe(item.binary);
    await vi.advanceTimersByTimeAsync(50);
    await expect(other).resolves.toBe(item.binary);
    expect(calls).toHaveLength(2);
    assertNoOwnedWork(item);
  });

  it("bounds async lock waits without stealing, signaling, or adopting unknown live owners", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    put(item.binary, "unverified binary");
    put(`${item.cache}.lock`, JSON.stringify({ pid: process.pid, unknown: true }));
    const lockContent = readFileSync(`${item.cache}.lock`, "utf8");
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await until(() => vi.getTimerCount() === 1);
    expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/cache is busy/);
    await vi.advanceTimersByTimeAsync(350000);
    await expect(result).rejects.toThrow(/lock wait timed out/);
    expect(readFileSync(`${item.cache}.lock`, "utf8")).toBe(lockContent);
    expect(readFileSync(item.binary, "utf8")).toBe("unverified binary");
    expect(calls).toHaveLength(0);
    expect(children.spawnSync).not.toHaveBeenCalled();
  });

  it("adopts a valid winner appearing before publication and never deletes it", async () => {
    const item = fixture();
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    const stage = extract(unpack, item);
    unpack.child.finish();
    const verify = await invocation(1, "codesign");
    seedReady(item, "concurrent winner survives");
    // A ready winner bypasses the old pending promise even before its verifier closes.
    await expect(bundledChromiumBinaryPathAsync("darwin", item.resources)).resolves.toBe(item.binary);
    expect(verify.child.closed).toBe(false);
    verify.child.finish();
    await expect(result).resolves.toBe(item.binary);
    expect(readFileSync(item.binary, "utf8")).toBe("concurrent winner survives");
    expect(readFileSync(path.join(item.cache, ".ready"), "utf8")).toBe("winner marker\n");
    expect(existsSync(stage)).toBe(false);
    assertNoOwnedWork(item);
  });

  it("moves an incomplete final aside only after successful verification and preserves its contents", async () => {
    const item = fixture();
    put(item.binary, "old incomplete binary");
    put(path.join(item.cache, "old-data"), "preserved evidence");
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const stage = await succeed(item);
    await expect(result).resolves.toBe(item.binary);
    expect(readFileSync(path.join(`${stage}.previous`, item.relativeBinary), "utf8")).toBe("old incomplete binary");
    expect(readFileSync(path.join(`${stage}.previous`, "old-data"), "utf8")).toBe("preserved evidence");
    expect(readFileSync(item.binary, "utf8")).toBe("non-executable fixture");
    expect(existsSync(`${item.cache}.lock`)).toBe(false);
  });

  it.each(["missing binary", "signature failure"])("sync also fails closed for %s without removing an incomplete final", (failure) => {
    const item = fixture();
    put(item.binary, "incomplete sync cache");
    children.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "ditto" && failure !== "missing binary") put(path.join(args[3], item.relativeBinary));
      return { status: command === "codesign" ? 1 : 0, stderr: "fixture signature failure" };
    });
    expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/missing|signature verification failed/);
    expect(readFileSync(item.binary, "utf8")).toBe("incomplete sync cache");
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
    assertNoOwnedWork(item);
  });
});

function readOwner(lock: string): string {
  return readFileSync(path.join(lock, "owner.json"), "utf8");
}

function protocolLock(item: Fixture, pid = 41000042): string {
  const lock = `${item.cache}.lock`;
  mkdirSync(lock, { recursive: true });
  const identity = statSync(lock);
  const record = {
    protocol: "bundled-browser-directory-lock-v1", destination: item.cache,
    uid: process.getuid!(), pid, lockIdentity: { dev: identity.dev, ino: identity.ino },
    operationId: "12345678-1234-4234-9234-123456789abc",
  };
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify(record) + "\n");
  return lock;
}

function deadOwner(): Error {
  return Object.assign(new Error("mock dead owner"), {
    code: "ERR_SYSTEM_ERROR", info: { code: "ESRCH", syscall: "uv_os_getpriority" },
  });
}

describe("review regressions", () => {
  it("uses no synchronous filesystem operations throughout cold async discovery and publication", async () => {
    const item = fixture();
    filesystemGate.checking = true;
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    filesystemGate.checking = false;
    extract(unpack, item);
    filesystemGate.checking = true;
    unpack.child.finish();
    const verify = await invocation(1, "codesign");
    filesystemGate.checking = false;
    expect(verify.args.slice(0, 3)).toEqual(["--verify", "--deep", "--strict"]);
    filesystemGate.checking = true;
    verify.child.finish();
    await expect(result).resolves.toBe(item.binary);
    filesystemGate.checking = false;
    expect(filesystemGate.calls).toEqual([]);
  });

  it("rejects archive B after capturing archive A instead of publishing B under A's identity", async () => {
    const item = fixture();
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    extract(unpack, item);
    writeFileSync(item.zip, "mutated archive B with a different identity");
    unpack.child.finish();
    // Old implementation proceeds to codesign; finish it so the RED result is
    // a behavior failure rather than a dangling fake subprocess.
    await until(() => calls.length > 1 || !existsSync(`${item.cache}.lock`));
    if (calls.length > 1) calls[1].child.finish();
    await expect(result).rejects.toThrow(/archive.*changed/i);
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
    assertNoOwnedWork(item);
  });

  it.each(["distinct inodes", "hard-linked inode"])("cannot reuse another source root's ready cache with equal version/size/mtime and %s", async (scenario) => {
    const firstItem = fixture("chromium", "ready-source-a");
    const secondItem = fixture("chromium", "ready-source-b");
    if (scenario === "hard-linked inode") {
      const { linkSync } = await import("node:fs");
      unlinkSync(secondItem.zip);
      linkSync(firstItem.zip, secondItem.zip);
      expect(statSync(firstItem.zip).ino).toBe(statSync(secondItem.zip).ino);
    }
    const exact = new Date(1700000000000);
    for (const item of [firstItem, secondItem]) {
      utimesSync(item.zip, exact, exact);
      item.cache = path.join(process.env.AGENT_BROWSER_BUNDLED_CACHE_DIR!, `chromium-darwin-150.0_fixture-${statSync(item.zip).size}-${exact.getTime()}`);
      item.binary = path.join(item.cache, item.relativeBinary);
    }
    const first = watch(bundledChromiumBinaryPathAsync("darwin", firstItem.resources));
    await succeed(firstItem);
    await expect(first).resolves.toBe(firstItem.binary);
    const second = watch(bundledChromiumBinaryPathAsync("darwin", secondItem.resources));
    const unpack = await invocation(2, "ditto");
    const stage = extract(unpack, secondItem);
    put(path.join(stage, secondItem.relativeBinary), "verified source B binary");
    unpack.child.finish();
    const verify = await invocation(3, "codesign");
    verify.child.finish();
    await expect(second).resolves.toBe(secondItem.binary);
    expect(readFileSync(secondItem.binary, "utf8")).toBe("verified source B binary");
    expect(readFileSync(path.join(`${stage}.previous`, firstItem.relativeBinary), "utf8")).toBe("non-executable fixture");
  });

  it("recovers a well-formed inode/UID/destination-bound dead protocol owner without signals", () => {
    const item = fixture();
    const lock = protocolLock(item);
    const original = readOwner(lock);
    priorities.getPriority.mockImplementation(() => { throw deadOwner(); });
    children.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "ditto") put(path.join(args[3], item.relativeBinary));
      else expect(args.slice(0, 3)).toEqual(["--verify", "--deep", "--strict"]);
      return { status: 0, stderr: "" };
    });
    expect(bundledChromiumBinaryPath("darwin", item.resources)).toBe(item.binary);
    expect(priorities.getPriority).toHaveBeenCalledWith(41000042);
    expect(existsSync(lock)).toBe(false);
    const displaced = readdirSync(path.dirname(lock)).find((name) => name.startsWith(`${path.basename(lock)}.abandoned-`));
    expect(displaced).toBeDefined();
    expect(readOwner(path.join(path.dirname(lock), displaced!))).toBe(original);
  });
});

function abandonedPath(lock: string): string {
  const stat = statSync(lock);
  const owner = JSON.parse(readOwner(lock));
  return `${lock}.abandoned-${stat.dev}-${stat.ino}-${owner.operationId}`;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("directory lock review regressions", () => {
  it.each(["empty directory", "legacy file", "dangling symlink"])("preserves a pre-existing unknown %s without querying any owner", async (kind) => {
    const { lstatSync, symlinkSync, readlinkSync } = await import("node:fs");
    const item = fixture();
    const lock = `${item.cache}.lock`;
    mkdirSync(path.dirname(lock), { recursive: true });
    if (kind === "empty directory") mkdirSync(lock);
    if (kind === "legacy file") put(lock, '{"pid":54280}');
    if (kind === "dangling symlink") symlinkSync(path.join(owned, "missing-lock-target"), lock);
    const inode = lstatSync(lock).ino;
    expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/cache is busy/);
    expect(lstatSync(lock).ino).toBe(inode);
    if (kind === "empty directory") expect(readdirSync(lock)).toEqual([]);
    if (kind === "legacy file") expect(readFileSync(lock, "utf8")).toBe('{"pid":54280}');
    if (kind === "dangling symlink") expect(readlinkSync(lock)).toBe(path.join(owned, "missing-lock-target"));
    expect(priorities.getPriority).not.toHaveBeenCalled();
    expect(children.spawnSync).not.toHaveBeenCalled();
  });

  it("never exposes partial preparation at the canonical lock and ignores crash-orphaned preparations", async () => {
    const item = fixture();
    const lock = `${item.cache}.lock`;
    const orphan = `${lock}.prepare-crashed-owner`;
    put(path.join(orphan, "owner.json"), '{"interrupted":');
    const gate = deferred();
    let entered = false;
    const actualOpen = fsPromises.open.bind(fsPromises);
    const actualWrite = fsPromises.writeFile.bind(fsPromises);
    // New-directory implementation: suspend a partial owner.json write in its
    // unique sibling. Old-file implementation: expose the old canonical bug.
    vi.spyOn(fsPromises, "writeFile").mockImplementation(async (file, data, options) => {
      if (typeof file === "string" && file.includes(`${lock}.prepare-`) && file.endsWith(`${path.sep}owner.json`)) {
        await actualWrite(file, "{", options);
        entered = true;
        await gate.promise;
        throw new Error("simulated partial preparation");
      }
      return actualWrite(file, data, options);
    });
    vi.spyOn(fsPromises, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await actualOpen(file, flags, mode);
      if (file === lock && flags === "wx") {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await write("{");
          entered = true;
          await gate.promise;
          throw new Error("simulated partial preparation");
        });
      }
      return handle;
    });
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    try {
      await until(() => entered);
      expect(existsSync(lock)).toBe(false);
      expect(calls).toHaveLength(0);
      expect(priorities.getPriority).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await expect(result).rejects.toThrow("simulated partial preparation");
    }
    expect(existsSync(lock)).toBe(false);
    expect(readOwner(orphan)).toBe('{"interrupted":');
    const preparations = readdirSync(path.dirname(lock)).filter((name) => name.startsWith(`${path.basename(lock)}.prepare-`));
    expect(preparations).toEqual([path.basename(orphan)]);
    expect(existsSync(`${lock}.recovery`)).toBe(false);
  });

  it("recovers a crash-published nonempty canonical owner directory without a central recovery claim", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    const lock = protocolLock(item);
    const before = readOwner(lock);
    const abandoned = abandonedPath(lock);
    priorities.getPriority.mockImplementation(() => { throw deadOwner(); });
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await invocation(0, "ditto");
    expect(statSync(lock).isDirectory()).toBe(true);
    const owner = JSON.parse(readOwner(lock));
    const stat = statSync(lock);
    expect(owner.protocol).toBe("bundled-browser-directory-lock-v1");
    expect(owner.lockIdentity).toEqual({ dev: stat.dev, ino: stat.ino });
    expect(owner.uid).toBe(process.getuid!());
    expect(owner.pid).toBe(process.pid);
    expect(readdirSync(lock)).toEqual(["owner.json"]);
    expect(readOwner(abandoned)).toBe(before);
    expect(existsSync(`${lock}.recovery`)).toBe(false);
    await succeed(item);
    await expect(result).resolves.toBe(item.binary);
    expect(existsSync(lock)).toBe(false);
    expect(readOwner(abandoned)).toBe(before);
    expect(readdirSync(path.dirname(lock)).filter((name) => name.startsWith(`${path.basename(lock)}.released-`))).toEqual([]);
  });

  it("a recoverer paused after its stale check cannot rename a new live lock once the other recoverer has moved the old one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    const lock = protocolLock(item);
    const before = readOwner(lock);
    const abandoned = abandonedPath(lock);
    priorities.getPriority.mockImplementation(() => { throw deadOwner(); });
    vi.resetModules();
    const otherMain = await import("../../src/main/services/bundled-native-browsers.js");
    const actualRename = fsPromises.rename.bind(fsPromises);
    const gate = deferred();
    let firstPaused = false;
    let firstFailed = false;
    let moves = 0;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (from === lock && to === abandoned && ++moves === 1) {
        firstPaused = true;
        await gate.promise;
        try { return await actualRename(from, to); }
        catch (error) { firstFailed = true; throw error; }
      }
      return actualRename(from, to);
    });
    const first = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    try {
      await until(() => firstPaused);
      const second = watch(otherMain.bundledChromiumBinaryPathAsync("darwin", item.resources));
      await invocation(0, "ditto");
      const live = readOwner(lock);
      const liveInode = statSync(lock).ino;
      expect(readOwner(abandoned)).toBe(before);
      gate.release();
      await until(() => firstFailed);
      expect(readOwner(lock)).toBe(live);
      expect(statSync(lock).ino).toBe(liveInode);
      expect(JSON.parse(live).pid).toBe(process.pid);
      await succeed(item);
      await expect(second).resolves.toBe(item.binary);
      await vi.advanceTimersByTimeAsync(50);
      await expect(first).resolves.toBe(item.binary);
      expect(calls).toHaveLength(2);
      expect(readOwner(abandoned)).toBe(before);
      expect(priorities.getPriority.mock.calls.every(([pid]) => pid === 41000042)).toBe(true);
    } finally { gate.release(); }
  });

  it("normal release moves its whole directory before cleanup and cannot delete a newly acquired canonical lock", async () => {
    const item = fixture();
    alignArchiveKey(item);
    vi.resetModules();
    const otherMain = await import("../../src/main/services/bundled-native-browsers.js");
    const actualRm = fsPromises.rm.bind(fsPromises);
    const gate = deferred();
    let released: string | undefined;
    vi.spyOn(fsPromises, "rm").mockImplementation(async (file, options) => {
      if (!released && typeof file === "string" && file.startsWith(`${item.cache}.lock.released-`)) {
        released = file;
        await gate.promise;
      }
      return actualRm(file, options);
    });
    const first = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    try {
      await succeed(item);
      await until(() => !!released);
      expect(existsSync(`${item.cache}.lock`)).toBe(false);
      expect(readdirSync(released!)).toEqual(["owner.json"]);
      const releasedOwner = JSON.parse(readOwner(released!));
      const before = statSync(item.zip);
      writeFileSync(item.zip, Buffer.alloc(before.size, "B"));
      utimesSync(item.zip, new Date(1700000000000), new Date(1700000000000));
      expect(statSync(item.zip).ctimeMs).not.toBe(before.ctimeMs);
      const second = watch(otherMain.bundledChromiumBinaryPathAsync("darwin", item.resources));
      await invocation(2, "ditto");
      const live = readOwner(`${item.cache}.lock`);
      expect(JSON.parse(live).operationId).not.toBe(releasedOwner.operationId);
      gate.release();
      await expect(first).resolves.toBe(item.binary);
      expect(readOwner(`${item.cache}.lock`)).toBe(live);
      expect(existsSync(released!)).toBe(false);
      const unpack = calls[2];
      extract(unpack, item);
      unpack.child.finish();
      const verify = await invocation(3, "codesign");
      verify.child.finish();
      await expect(second).resolves.toBe(item.binary);
      expect(existsSync(`${item.cache}.lock`)).toBe(false);
      expect(priorities.getPriority).not.toHaveBeenCalled();
    } finally { gate.release(); }
  });

  it("a crash after the abandoned move but before normal acquisition leaves no stranded canonical or recovery lock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    const lock = protocolLock(item);
    const before = readOwner(lock);
    const abandoned = abandonedPath(lock);
    priorities.getPriority.mockImplementation(() => { throw deadOwner(); });
    const actualMkdtemp = fsPromises.mkdtemp.bind(fsPromises);
    let interrupted = false;
    const spy = vi.spyOn(fsPromises, "mkdtemp").mockImplementation(async (prefix, options) => {
      if (typeof prefix === "string" && prefix.startsWith(`${lock}.prepare-`) && !interrupted) {
        interrupted = true;
        throw new Error("simulated interruption after recovery move");
      }
      return actualMkdtemp(prefix, options);
    });
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await until(() => interrupted || vi.getTimerCount() > 0);
    if (!interrupted) await vi.advanceTimersByTimeAsync(350000);
    await expect(result).rejects.toThrow("simulated interruption after recovery move");
    expect(readOwner(abandoned)).toBe(before);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.recovery`)).toBe(false);
    expect(calls).toHaveLength(0);
    spy.mockRestore();
    const retry = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await succeed(item);
    await expect(retry).resolves.toBe(item.binary);
    expect(readOwner(abandoned)).toBe(before);
  });
});

describe("protocol-owner recovery safety", () => {
  it.each(["unknown PID 54280", "wrong UID", "wrong destination", "wrong inode", "wrong protocol", "invalid operation UUID"])("does not even query %s", (invalid) => {
    const item = fixture();
    const lock = protocolLock(item);
    const record = JSON.parse(readOwner(lock));
    if (invalid === "unknown PID 54280") { delete record.protocol; record.pid = 54280; }
    if (invalid === "wrong UID") record.uid += 1;
    if (invalid === "wrong destination") record.destination += "-other";
    if (invalid === "wrong inode") record.lockIdentity.ino += 1;
    if (invalid === "wrong protocol") record.protocol = "legacy-pid-lock";
    if (invalid === "invalid operation UUID") record.operationId = "00000000-0000-0000-0000-000000000000";
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify(record));
    const before = readOwner(lock);
    expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/cache is busy/);
    expect(priorities.getPriority).not.toHaveBeenCalled();
    expect(readOwner(lock)).toBe(before);
    expect(children.spawnSync).not.toHaveBeenCalled();
  });

  it.each(["live owner", "PID reused before claim"])("preserves a %s", (scenario) => {
    const item = fixture();
    const lock = protocolLock(item);
    const before = readOwner(lock);
    priorities.getPriority.mockReturnValue(0);
    if (scenario.startsWith("PID")) priorities.getPriority.mockImplementationOnce(() => { throw deadOwner(); });
    expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/cache is busy/);
    expect(priorities.getPriority).toHaveBeenCalledWith(41000042);
    expect(readOwner(lock)).toBe(before);
    expect(existsSync(`${lock}.recovery`)).toBe(false);
    expect(children.spawnSync).not.toHaveBeenCalled();
  });

  it.each(["changed bytes", "replacement inode"])("does not recover stale snapshots after %s", (scenario) => {
    const item = fixture();
    const lock = protocolLock(item);
    priorities.getPriority.mockImplementationOnce(() => {
      if (scenario === "replacement inode") {
        rmSync(lock, { recursive: true });
        mkdirSync(lock);
      }
      put(path.join(lock, "owner.json"), "unknown replacement owns this lock");
      throw deadOwner();
    });
    expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/cache is busy/);
    expect(readOwner(lock)).toBe("unknown replacement owns this lock");
    expect(existsSync(`${lock}.recovery`)).toBe(false);
    expect(children.spawnSync).not.toHaveBeenCalled();
  });

  it("async recovery uses promises, preserves dead-owned staging, and cleans only its own work", async () => {
    const item = fixture();
    const lock = protocolLock(item);
    const abandoned = path.join(`${item.cache}.stage-dead-owner`, "evidence");
    put(abandoned, "do not clean another operation's staging");
    priorities.getPriority.mockImplementation(() => { throw deadOwner(); });
    filesystemGate.checking = true;
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    filesystemGate.checking = false;
    extract(unpack, item);
    filesystemGate.checking = true;
    unpack.child.finish();
    const verify = await invocation(1, "codesign");
    verify.child.finish();
    await expect(result).resolves.toBe(item.binary);
    filesystemGate.checking = false;
    expect(filesystemGate.calls).toEqual([]);
    expect(priorities.getPriority).toHaveBeenCalledWith(41000042);
    expect(readFileSync(abandoned, "utf8")).toBe("do not clean another operation's staging");
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.recovery`)).toBe(false);
  });

  it("concurrent main instances elect one stale-lock recoverer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    protocolLock(item);
    priorities.getPriority.mockImplementation(() => { throw deadOwner(); });
    vi.resetModules();
    const otherMain = await import("../../src/main/services/bundled-native-browsers.js");
    const first = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const second = watch(otherMain.bundledChromiumBinaryPathAsync("darwin", item.resources));
    await invocation(0, "ditto");
    await until(() => vi.getTimerCount() >= 2);
    await succeed(item);
    await until(() => existsSync(path.join(item.cache, ".ready")) && !existsSync(`${item.cache}.lock`));
    await vi.advanceTimersByTimeAsync(50);
    await expect(Promise.all([first, second])).resolves.toEqual([item.binary, item.binary]);
    expect(calls).toHaveLength(2);
    const preserved = readdirSync(path.dirname(item.cache)).filter((name) => name.startsWith(`${path.basename(item.cache)}.lock.abandoned-`));
    expect(preserved).toHaveLength(1);
  });

  it.each(["unknown claim", "protocol-bound dead claim"])("an interrupted %s remains fail-closed rather than inventing recovery authority", (scenario) => {
    const item = fixture();
    const lock = protocolLock(item);
    put(`${lock}.recovery`, "interrupted or unknown recovery claim");
    const before = readOwner(lock);
    if (scenario.startsWith("protocol")) {
      const record = JSON.parse(before);
      const stat = statSync(`${lock}.recovery`);
      record.protocol = "bundled-browser-recovery-v1";
      record.lockIdentity = { dev: stat.dev, ino: stat.ino };
      writeFileSync(`${lock}.recovery`, JSON.stringify(record));
    }
    const claim = readFileSync(`${lock}.recovery`, "utf8");
    priorities.getPriority.mockImplementation(() => { throw deadOwner(); });
    expect(() => bundledChromiumBinaryPath("darwin", item.resources)).toThrow(/cache is busy/);
    expect(priorities.getPriority).not.toHaveBeenCalled();
    expect(readOwner(lock)).toBe(before);
    expect(readFileSync(`${lock}.recovery`, "utf8")).toBe(claim);
  });
});

function alignArchiveKey(item: Fixture): void {
  const exact = new Date(1700000000000);
  utimesSync(item.zip, exact, exact);
  item.cache = path.join(process.env.AGENT_BROWSER_BUNDLED_CACHE_DIR!, `chromium-darwin-150.0_fixture-${statSync(item.zip).size}-${exact.getTime()}`);
  item.binary = path.join(item.cache, item.relativeBinary);
}

describe("strong archive identity and bounded async manifest", () => {
  it.each(["same inode changed ctime", "replacement inode"])("rejects %s even with identical size and mtime", async (scenario) => {
    const item = fixture();
    alignArchiveKey(item);
    const before = statSync(item.zip);
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    extract(unpack, item);
    if (scenario === "replacement inode") unlinkSync(item.zip);
    writeFileSync(item.zip, Buffer.alloc(before.size, "B"));
    utimesSync(item.zip, new Date(1700000000000), new Date(1700000000000));
    const after = statSync(item.zip);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    if (scenario.startsWith("same")) expect(after.ctimeMs).not.toBe(before.ctimeMs);
    else expect(after.ino).not.toBe(before.ino);
    unpack.child.finish();
    await expect(result).rejects.toThrow(/archive.*changed/i);
    expect(calls).toHaveLength(1);
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
    assertNoOwnedWork(item);
  });

  it("rechecks source identity before launching extraction after lock waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    const lock = `${item.cache}.lock`;
    put(lock, '{"pid":54280}');
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await until(() => vi.getTimerCount() === 1);
    writeFileSync(item.zip, "changed before extraction");
    unlinkSync(lock); // Remove only this test-owned unknown fixture.
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).rejects.toThrow(/archive.*changed/i);
    expect(priorities.getPriority).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    assertNoOwnedWork(item);
  });

  it("rechecks source identity after strict verification, before publication", async () => {
    const item = fixture();
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    extract(unpack, item);
    unpack.child.finish();
    const verify = await invocation(1, "codesign");
    writeFileSync(item.zip, "changed during strict verification");
    verify.child.finish();
    await expect(result).rejects.toThrow(/archive.*changed/i);
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
    assertNoOwnedWork(item);
  });

  it("does not share an old epoch's rejected promise with a new epoch at the same source/cache path", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const item = fixture();
    alignArchiveKey(item);
    const first = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    extract(unpack, item);
    writeFileSync(item.zip, Buffer.alloc(statSync(item.zip).size, "B"));
    utimesSync(item.zip, new Date(1700000000000), new Date(1700000000000));
    const second = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    await until(() => vi.getTimerCount() >= 2);
    unpack.child.finish();
    await expect(first).rejects.toThrow(/archive.*changed/i);
    await vi.advanceTimersByTimeAsync(50);
    await succeed(item, 1);
    await expect(second).resolves.toBe(item.binary);
    assertNoOwnedWork(item);
  });

  it("revalidates a legacy unbound ready marker and preserves the displaced final", async () => {
    const item = fixture();
    put(item.binary, "legacy unbound cache");
    put(path.join(item.cache, ".ready"), "legacy marker\n");
    const result = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(0, "ditto");
    const stage = extract(unpack, item);
    unpack.child.finish();
    const verify = await invocation(1, "codesign");
    verify.child.finish();
    await expect(result).resolves.toBe(item.binary);
    expect(readFileSync(path.join(`${stage}.previous`, item.relativeBinary), "utf8")).toBe("legacy unbound cache");
    expect(readFileSync(path.join(`${stage}.previous`, ".ready"), "utf8")).toBe("legacy marker\n");
    const provenance = JSON.parse(readFileSync(path.join(item.cache, ".ready.archive.json"), "utf8"));
    expect(provenance.archive.source).toBe(realpathSync(item.zip));
    expect(provenance.marker).toBe(readFileSync(path.join(item.cache, ".ready"), "utf8"));
  });

  it("reads at most a 64KiB manifest asynchronously and keeps the synchronous reader available", async () => {
    const item = fixture();
    const file = path.join(item.root, "browsers-manifest.json");
    const payload = '{"chromiumVersion":"fixture-version"}';
    put(file, payload.padEnd(64 * 1024, " "));
    filesystemGate.checking = true;
    await expect(readBundledBrowsersManifestAsync("darwin", item.resources)).resolves.toEqual({ chromiumVersion: "fixture-version" });
    filesystemGate.checking = false;
    expect(filesystemGate.calls).toEqual([]);
    expect(readBundledBrowsersManifest("darwin", item.resources)).toEqual({ chromiumVersion: "fixture-version" });
    put(file, payload.padEnd(64 * 1024 + 1, " "));
    await expect(readBundledBrowsersManifestAsync("darwin", item.resources)).resolves.toBeNull();
    expect(readBundledBrowsersManifest("darwin", item.resources)).toBeNull();
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it("async manifest defaults, precedence, and resource capture match the sync reader", async () => {
    const firstItem = fixture("chromium", "manifest-first", "first-version");
    const secondItem = fixture("chromium", "manifest-second", "second-version");
    setResources(firstItem.resources);
    await expect(readBundledBrowsersManifestAsync("darwin")).resolves.toEqual(readBundledBrowsersManifest("darwin"));
    await expect(readBundledBrowsersManifestAsync()).resolves.toEqual(readBundledBrowsersManifest());
    await expect(readBundledBrowsersManifestAsync("darwin", undefined)).resolves.toEqual({ chromiumVersion: "first-version" });
    await expect(readBundledBrowsersManifestAsync("darwin", secondItem.resources)).resolves.toEqual({ chromiumVersion: "second-version" });
    await expect(readBundledBrowsersManifestAsync("darwin", null)).resolves.toBeNull();
    await expect(readBundledBrowsersManifestAsync("darwin", "")).resolves.toBeNull();
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", secondItem.resources);
    const captured = readBundledBrowsersManifestAsync("darwin", null);
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", firstItem.resources);
    await expect(captured).resolves.toEqual({ chromiumVersion: "second-version" });
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", "");
    await expect(readBundledBrowsersManifestAsync("darwin")).resolves.toEqual({ chromiumVersion: "first-version" });
  });
});

describe("entry-time resource, archive, and cache identity", () => {
  it("captures resource and cache overrides before a deferred child can observe later env changes", async () => {
    const firstItem = fixture("chromium", "first");
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", firstItem.resources);
    const first = watch(bundledChromiumBinaryPathAsync("darwin", null));
    vi.stubEnv("AGENT_BROWSER_BUNDLED_CACHE_DIR", path.join(owned, "second-cache"));
    const secondItem = fixture("chromium", "second");
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", secondItem.resources);
    const second = watch(bundledChromiumBinaryPathAsync("darwin", firstItem.resources));
    await until(() => calls.length === 2);
    for (const item of [firstItem, secondItem]) {
      const unpack = calls.find((call) => call.args[2] === item.zip)!;
      extract(unpack, item);
      unpack.child.finish();
    }
    await until(() => calls.length === 4);
    for (const call of calls.filter((entry) => entry.command === "codesign")) call.child.finish();
    await expect(first).resolves.toBe(firstItem.binary);
    await expect(second).resolves.toBe(secondItem.binary);
    expect(firstItem.cache).not.toBe(secondItem.cache);
    assertNoOwnedWork(firstItem);
    assertNoOwnedWork(secondItem);
  });

  it("does not coalesce distinct archives sharing the same version-size-mtime destination", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const firstItem = fixture("chromium", "first");
    const secondItem = fixture("chromium", "second");
    const exact = new Date(1700000000000);
    utimesSync(firstItem.zip, exact, exact);
    utimesSync(secondItem.zip, exact, exact);
    expect(statSync(secondItem.zip).size).toBe(statSync(firstItem.zip).size);
    const sharedKey = `chromium-darwin-150.0_fixture-${statSync(firstItem.zip).size}-${exact.getTime()}`;
    firstItem.cache = secondItem.cache = path.join(process.env.AGENT_BROWSER_BUNDLED_CACHE_DIR!, sharedKey);
    firstItem.binary = path.join(firstItem.cache, firstItem.relativeBinary);
    secondItem.binary = path.join(secondItem.cache, secondItem.relativeBinary);
    const first = watch(bundledChromiumBinaryPathAsync("darwin", firstItem.resources));
    await invocation(0, "ditto");
    const second = watch(bundledChromiumBinaryPathAsync("darwin", secondItem.resources));
    await until(() => vi.getTimerCount() >= 2);
    calls[0].child.finish(4);
    await expect(first).rejects.toThrow(/ditto failed/);
    await vi.advanceTimersByTimeAsync(50);
    await succeed(secondItem, 1);
    await expect(second).resolves.toBe(secondItem.binary);
    expect(calls[1].args[2]).toBe(secondItem.zip);
    assertNoOwnedWork(secondItem);
  });

  it.each(["150.0+fixture", "invalid/version"])("retains cache naming for declared version %s but rejects publishing a mutated zip under the captured key", async (version) => {
    const item = fixture("chromium", "identity", version);
    const first = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const original = await invocation(0, "ditto");
    extract(original, item);
    writeFileSync(item.zip, "different-sized archive identity, still never actually extracted");
    utimesSync(item.zip, new Date(1700000000000), new Date(1700000000000));
    original.child.finish();
    await expect(first).rejects.toThrow(/archive.*changed/i);
    expect(existsSync(item.binary)).toBe(false);
    expect(existsSync(path.join(item.cache, ".ready"))).toBe(false);
    assertNoOwnedWork(item);
    const next = watch(bundledChromiumBinaryPathAsync("darwin", item.resources));
    const unpack = await invocation(1, "ditto");
    expect(unpack.args[3].startsWith(`${item.cache}.stage-`)).toBe(false);
    const changedCache = unpack.args[3].split(".stage-")[0];
    const changed: Fixture = { ...item, cache: changedCache, binary: path.join(changedCache, item.relativeBinary) };
    await succeed(changed, 1);
    await expect(next).resolves.toBe(changed.binary);
    expect(readFileSync(changed.binary, "utf8")).toBe("non-executable fixture");
    expect(existsSync(item.binary)).toBe(false);
  });

  it.each(["darwin", "win32", "linux"] as const)("preserves direct %s binary discovery without any child calls", async (platform) => {
    const resources = path.join(owned, "direct");
    const root = path.join(resources, "native-browsers", ...(platform === "darwin" ? [] : [platform === "win32" ? "win" : platform]));
    const chromium = platform === "darwin" ? path.join(root, "Chromium.app", "Contents", "MacOS", "Chromium") : platform === "win32" ? path.join(root, "chromium", "chrome.exe") : path.join(root, "chromium");
    const firefox = platform === "darwin" ? path.join(root, "Firefox.app", "Contents", "MacOS", "firefox") : path.join(root, "firefox", platform === "win32" ? "firefox.exe" : "firefox");
    put(chromium);
    put(firefox);
    setResources(resources);
    await expect(bundledChromiumBinaryPathAsync(platform)).resolves.toBe(chromium);
    await expect(bundledFirefoxBinaryPathAsync(platform, undefined)).resolves.toBe(firefox);
    await expect(bundledChromiumBinaryPathAsync(platform, null)).resolves.toBeNull();
    await expect(bundledFirefoxBinaryPathAsync(platform, "")).resolves.toBeNull();
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", resources);
    await expect(bundledChromiumBinaryPathAsync(platform, null)).resolves.toBe(chromium);
    await expect(bundledFirefoxBinaryPathAsync(platform, path.join(owned, "missing"))).resolves.toBe(firefox);
    expect(children.spawn).not.toHaveBeenCalled();
    expect(children.spawnSync).not.toHaveBeenCalled();
  });

  it("preserves default arguments and missing resource behavior", async () => {
    await expect(bundledChromiumBinaryPathAsync()).resolves.toBeNull();
    await expect(bundledFirefoxBinaryPathAsync()).resolves.toBeNull();
    await expect(bundledChromiumBinaryPathAsync("darwin", path.join(owned, "missing"))).resolves.toBeNull();
    const item = fixture();
    put(path.join(item.root, "Chromium.app", "Contents", "MacOS", "Chromium"));
    setResources(item.resources);
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", "");
    await expect(bundledChromiumBinaryPathAsync("darwin")).resolves.toBe(path.join(item.root, item.relativeBinary));
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", path.join(owned, "missing-override"));
    await expect(bundledChromiumBinaryPathAsync("darwin", item.resources)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});
