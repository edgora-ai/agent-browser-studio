import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as vm from "node:vm";
import * as zlib from "node:zlib";
import ts from "typescript";
import { isPathInside } from "../../src/main/services/zip-writer.js";

// Execute the actual private helper, not a copied implementation. Process and
// clock boundaries are controlled; the final case also holds a real owned writer.
const source = fs.readFileSync(new URL("../../src/main/services/sync-service.ts", import.meta.url), "utf8");
const start = source.indexOf("function spawnTar(");
const end = source.indexOf("\nfunction resolveProfileDir", start);
if (start < 0 || end < start) throw new Error("Production TAR helper not found");
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
type Run = (args: string[], timeout: number, signal?: AbortSignal, cwd?: string) => Promise<boolean>;
class Child extends EventEmitter { kill = vi.fn<(signal: string) => boolean>(() => false); }
function harness(child: Child | ChildProcess = new Child(), beforeSpawn?: () => void) {
  let timer: (() => void) | undefined;
  const launch = vi.fn((_command: string, _args: string[], _options: unknown) => { beforeSpawn?.(); return child; });
  const run = vm.runInNewContext(code + "\nspawnTar;", {
    spawn: launch,
    assertSyncNotAborted: (signal?: AbortSignal) => { if (signal?.aborted) throw Object.assign(new Error("Sync operation cancelled"), { code: "ABORT_ERR" }); },
    setTimeout: (callback: () => void) => { timer = callback; return 1; },
    clearTimeout: () => { timer = undefined; },
  }, { timeout: 1000 }) as Run;
  return { run, child, launch, deadline: () => { const callback = timer; timer = undefined; if (!callback) throw new Error("No owned TAR timer"); callback(); }, hasTimer: () => timer !== undefined };
}
function observe(pending: Promise<boolean>) {
  const state: { kind: "pending" | "resolved" | "rejected"; value?: boolean; error?: any } = { kind: "pending" };
  const done = pending.then(value => { state.kind = "resolved"; state.value = value; }, error => { state.kind = "rejected"; state.error = error; });
  return { state, done };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => vi.restoreAllMocks());

describe("TAR subprocess quiescence", () => {
  it("keeps ownership after exit until the actual close event", async () => {
    const f = harness(), result = observe(f.run(["owned-argument"], 15000));
    f.child.emit("exit", 0, null); await turn();
    expect(result.state.kind).toBe("pending"); expect(f.hasTimer()).toBe(true);
    f.child.emit("close", 0, null); await result.done;
    expect(result.state).toEqual({ kind: "resolved", value: true }); expect(f.hasTimer()).toBe(false);
  });
  it.each([1, null])("reports a terminal non-success code %s without inventing success", async code => {
    const f = harness(), result = observe(f.run([], 15000));
    f.child.emit("close", code, code === null ? "SIGTERM" : null); await result.done;
    expect(result.state).toEqual({ kind: "resolved", value: false });
  });
  it("does not send duplicate termination requests when abort follows a deadline", async () => {
    const child = new Child(), f = harness(child), controller = new AbortController(), result = observe(f.run([], 15000, controller.signal));
    f.deadline(); controller.abort(); await turn(); expect(result.state.kind).toBe("pending");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", 0, null); await result.done; expect(result.state.kind).toBe("rejected");
  });
  it.each([false, true])("keeps ownership after abort even when kill returns %s", async accepted => {
    const child = new Child(); child.kill.mockReturnValue(accepted);
    const f = harness(child), controller = new AbortController(), released = vi.fn();
    const result = observe(f.run([], 15000, controller.signal).finally(released));
    controller.abort(); await turn();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(result.state.kind).toBe("pending"); expect(released).not.toHaveBeenCalled();
    child.emit("exit", 0, null); await turn(); expect(result.state.kind).toBe("pending");
    child.emit("close", 0, null); await result.done;
    expect(result.state.kind).toBe("rejected"); expect(result.state.error.message).toMatch(/cancelled/);
    expect(released).toHaveBeenCalledTimes(1); expect(f.hasTimer()).toBe(false);
  });
  it.each([false, true])("keeps ownership after deadline even when kill returns %s and late close is zero", async accepted => {
    const child = new Child(); child.kill.mockReturnValue(accepted);
    const f = harness(child), result = observe(f.run([], 15000));
    f.deadline(); await turn();
    expect(result.state.kind).toBe("pending"); expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", 0, null); await result.done;
    expect(result.state).toEqual({ kind: "resolved", value: false });
  });
  it("retains process errors until close rather than treating error as proof of exit", async () => {
    const f = harness(), error = Object.assign(new Error("Synthetic TAR spawn failure"), { code: "ENOENT" });
    const result = observe(f.run([], 15000));
    f.child.emit("error", error); await turn(); expect(result.state.kind).toBe("pending");
    f.child.emit("close", -2, null); await result.done;
    expect(result.state.kind).toBe("rejected"); expect(result.state.error).toBe(error);
  });
  it("does not lose an abort that occurs inside the spawn boundary", async () => {
    const controller = new AbortController(), child = new Child(), f = harness(child, () => controller.abort());
    const result = observe(f.run([], 15000, controller.signal));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", 0, null); await result.done;
    expect(result.state.kind).toBe("rejected"); expect(result.state.error.message).toMatch(/cancelled/);
  });
  it("keeps the lease and both error facts if requesting termination throws", async () => {
    const child = new Child(), failure = Object.assign(new Error("Synthetic termination denied"), { code: "EPERM" });
    child.kill.mockImplementation(() => { throw failure; });
    const f = harness(child), controller = new AbortController(), result = observe(f.run([], 15000, controller.signal));
    controller.abort(); await turn(); expect(result.state.kind).toBe("pending");
    child.emit("close", 1, null); await result.done;
    expect(result.state.kind).toBe("rejected"); expect(result.state.error.message).toMatch(/cancelled/);
    expect(result.state.error.errors).toContain(failure);
  });
  it("passes an explicit owned working directory to the subprocess", async () => {
    const f = harness(), cwd = path.join(os.tmpdir(), "invented-tar-cwd");
    const result = observe(f.run(["-czf", "localstorage.tgz"], 15000, undefined, cwd));
    expect(f.launch).toHaveBeenCalledExactlyOnceWith("tar", ["-czf", "localstorage.tgz"], { stdio: "ignore", cwd });
    f.child.emit("close", 0, null); await result.done; expect(result.state.value).toBe(true);
  });
  it("never starts an already aborted operation", async () => {
    const f = harness(), controller = new AbortController(); controller.abort();
    expect(() => f.run([], 15000, controller.signal)).toThrow(/cancelled/); expect(f.launch).not.toHaveBeenCalled();
  });
});

it("exports with a relative archive argument in an owned cwd and reads back real native TAR bytes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-tar-command-"))), owner = fs.lstatSync(root);
  const stage = path.join(root, "stage"), input = path.join(root, "input"), restored = path.join(root, "restored");
  for (const directory of [stage, input, restored]) fs.mkdirSync(directory, { mode: 0o700 });
  const payload = "owned-native-leveldb-data", current = "MANIFEST-000001\n";
  fs.writeFileSync(path.join(input, "CURRENT"), current, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(input, "MANIFEST-000001"), payload, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(input, "LOCK"), "owned-inert-lock", { flag: "wx", mode: 0o600 });
  const exportStart = source.indexOf("async function exportLocalStorage("), exportEnd = source.indexOf("\ninterface PreparedLocalStorage", exportStart);
  const readStart = source.indexOf("function extractSafeLocalStorageArchive("), readEnd = source.indexOf("\nfunction validatePreferencesJson", readStart);
  if (exportStart < 0 || exportEnd < exportStart || readStart < 0 || readEnd < readStart) throw new Error("Production LocalStorage transport functions not found");
  const exporter = ts.transpileModule(source.slice(exportStart, exportEnd) + "\n" + source.slice(readStart, readEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const launch = vi.fn((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    const archive = args[args.indexOf("-czf") + 1];
    expect(path.isAbsolute(archive) || path.win32.isAbsolute(archive) || /[:\\]/.test(archive)).toBe(false);
    expect(typeof options?.cwd).toBe("string");
    expect(String(options!.cwd).startsWith(stage + path.sep)).toBe(true);
    return spawn(command, args, options!);
  });
  const transport = vm.runInNewContext(exporter + "\n" + code + "\n({ create: exportLocalStorage, read: extractSafeLocalStorageArchive });", {
    fs, path, zlib, Buffer, isPathInside, spawn: launch, setTimeout, clearTimeout,
    assertSyncNotAborted: (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Owned fixture cancelled"); },
    assertLocalStorageRestorable: (id: string) => { expect(id).toBe("owned_tar_profile"); },
    localStorageFormat: () => "leveldb", resolveProfileFile: () => input,
    MAX_LOCAL_STORAGE_TGZ_BYTES: 1024 * 1024, MAX_PULL_LOCAL_STORAGE_BYTES: 1024 * 1024,
    MAX_LOCAL_STORAGE_TAR_BYTES: 2 * 1024 * 1024, MAX_LOCAL_STORAGE_FILES: 64,
  }) as { create: (id: string, stage: string) => Promise<Buffer | null>; read: (bytes: Buffer, target: string) => { files: number; bytesWritten: number } };
  try {
    const archive = await transport.create("owned_tar_profile", stage);
    expect(launch).toHaveBeenCalledTimes(1);
    if (!archive) throw new Error("Owned native TAR export failed");
    // The product reads TAR itself; do not test GNU tar's unrelated extraction
    // metadata/permission behavior as though it were the application reader.
    expect(transport.read(archive, restored)).toEqual({ files: 2, bytesWritten: Buffer.byteLength(current + payload) });
    expect(fs.readdirSync(restored).sort()).toEqual(["CURRENT", "MANIFEST-000001"]);
    expect(fs.readFileSync(path.join(restored, "CURRENT"), "utf8")).toBe(current);
    expect(fs.readFileSync(path.join(restored, "MANIFEST-000001"), "utf8")).toBe(payload);
    expect(fs.readdirSync(stage)).toEqual([]);
    expect(fs.readFileSync(path.join(input, "CURRENT"), "utf8")).toBe(current);
    expect(fs.readFileSync(path.join(input, "MANIFEST-000001"), "utf8")).toBe(payload);
    expect(fs.readFileSync(path.join(input, "LOCK"), "utf8")).toBe("owned-inert-lock");
  } finally {
    const current = fs.lstatSync(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Owned TAR command root changed");
    const inspect = (directory: string): void => { for (const name of fs.readdirSync(directory)) { const file = path.join(directory, name), info = fs.lstatSync(file); if (info.isSymbolicLink()) throw new Error("Unexpected owned TAR symlink"); if (info.isDirectory()) inspect(file); } };
    inspect(root); fs.rmSync(root, { recursive: true });
  }
});

function message(child: ChildProcess, wanted: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off("message", received); child.off("error", failed); child.off("exit", exited); };
    const received = (value: unknown) => { if (value === wanted) { cleanup(); resolve(); } };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = () => failed(new Error("Owned writer exited before its expected message"));
    child.on("message", received); child.once("error", failed); child.once("exit", exited);
  });
}
it("retains caller cleanup while a real owned writer remains alive after an unsuccessful stop request", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-tar-owned-writer-"))), owner = fs.lstatSync(root), file = path.join(root, "owned.bin");
  const child = spawn(process.execPath, ["-e", `
    const fs = require('node:fs');
    const fd = fs.openSync(process.argv[1], 'wx', 0o600);
    fs.writeSync(fd, 'owned-start');
    process.on('message', value => {
      if (value === 'stop-requested') process.send('stop-observed');
      if (value === 'finish') { fs.writeSync(fd, '-owned-finished'); fs.fsyncSync(fd); fs.closeSync(fd); process.exit(0); }
    });
    process.send('ready');
  `, file], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  const nativeKill = child.kill.bind(child);
  try {
    await message(child, "ready");
    const stopObserved = message(child, "stop-observed");
    vi.spyOn(child, "kill").mockImplementation(() => { child.send("stop-requested"); return false; });
    const f = harness(child), controller = new AbortController(), cleanup = vi.fn();
    const result = observe(f.run([], 15000, controller.signal).finally(cleanup));
    controller.abort(); await stopObserved; await turn();
    expect(child.exitCode).toBeNull(); expect(result.state.kind).toBe("pending"); expect(cleanup).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe("owned-start");
    child.send("finish"); await closed; await result.done;
    expect(result.state.kind).toBe("rejected"); expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, "utf8")).toBe("owned-start-owned-finished");
    expect(fs.readdirSync(root).find(name => name === "owned.bin")).toBe("owned.bin");
  } finally {
    if (child.exitCode === null && child.signalCode === null) nativeKill("SIGKILL");
    await closed;
    const current = fs.lstatSync(root);
    expect(current.isDirectory() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino).toBe(true);
    for (const name of fs.readdirSync(root)) expect(fs.lstatSync(path.join(root, name)).isSymbolicLink()).toBe(false);
    fs.rmSync(root, { recursive: true });
  }
});
