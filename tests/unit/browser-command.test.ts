import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

const processMock = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: processMock.execFile }));
import { runBrowserCommand } from "../../src/main/services/browser-command.js";

let root: string;
let rootIdentity: fs.Stats;
type Reply = (error: Error | null, stdout: string, stderr: string) => void;

function binary(name = "browser"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, "non-executable fixture", { mode: 0o600 });
  return file;
}

function respond(stdout = "version", stderr = "diagnostic", error: Error | null = null): void {
  processMock.execFile.mockImplementation((_file, _args, _options, callback: Reply) => {
    setImmediate(() => callback(error, stdout, stderr));
    return {};
  });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "browser-command-fixture-")));
  rootIdentity = fs.lstatSync(root);
  processMock.execFile.mockReset();
  respond();
});
afterEach(() => {
  for (const [file] of processMock.execFile.mock.calls) expect(String(file).startsWith(root + path.sep)).toBe(true);
  vi.restoreAllMocks();
  const current = fs.lstatSync(root);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || fs.realpathSync(root) !== root) {
    throw new Error("Browser command fixture ownership changed; preserving it");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded asynchronous browser command probes", () => {
  it("preserves separate raw streams and enforces bounded execFile options", async () => {
    const file = binary();
    respond(" Mozilla Firefox 154.0\n", " warning\n");
    expect(await runBrowserCommand(file, ["--version"], { timeout: 5000 })).toEqual({
      stdout: " Mozilla Firefox 154.0\n", stderr: " warning\n",
    });
    expect(processMock.execFile).toHaveBeenCalledWith(file, ["--version"], {
      timeout: 5000, shell: false, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      encoding: "utf8", windowsHide: true,
    }, expect.any(Function));
  });

  it("keeps the event loop responsive, coalesces pending calls, and caches successes", async () => {
    const file = binary();
    let finish!: Reply;
    processMock.execFile.mockImplementation((_file, _args, _opts, callback: Reply) => { finish = callback; return {}; });
    let settled = false;
    const pending = Promise.all(Array.from({ length: 12 }, () => runBrowserCommand(file, ["--version"], { timeout: 5000 })));
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(processMock.execFile).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish(null, "version", "diagnostic");
    expect(await pending).toEqual(Array.from({ length: 12 }, () => ({ stdout: "version", stderr: "diagnostic" })));
    expect(await runBrowserCommand(file, ["--version"], { timeout: 5000 })).not.toBeNull();
    expect(processMock.execFile).toHaveBeenCalledTimes(1);
  });

  it("retries one confirmed version timeout after termination, coalescing the whole sequence", async () => {
    const file = binary(); let terminate!: Reply; let finish!: Reply;
    processMock.execFile.mockImplementationOnce((_file, _args, _opts, callback: Reply) => { terminate = callback; return {}; });
    processMock.execFile.mockImplementation((_file, _args, opts, callback: Reply) => {
      expect(opts).toMatchObject({ timeout: 20, killSignal: 'SIGKILL', shell: false }); finish = callback; return {};
    });
    const options = { timeout: 20, retryTimeout: true };
    const pending = Promise.all(Array.from({ length: 8 }, () => runBrowserCommand(file, ['--version'], options)));
    await vi.waitFor(() => expect(processMock.execFile).toHaveBeenCalledTimes(1));
    await new Promise<void>(resolve => setImmediate(resolve)); expect(processMock.execFile).toHaveBeenCalledTimes(1);
    terminate(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL', code: null }), '', '');
    await vi.waitFor(() => expect(processMock.execFile).toHaveBeenCalledTimes(2));
    finish(null, 'Mozilla Firefox 154.0\n', '');
    expect(await pending).toEqual(Array.from({ length: 8 }, () => ({ stdout: 'Mozilla Firefox 154.0\n', stderr: '' })));
    expect(await runBrowserCommand(file, ['--version'], options)).toEqual({ stdout: 'Mozilla Firefox 154.0\n', stderr: '' });
    expect(processMock.execFile).toHaveBeenCalledTimes(2);
  });
  it("captures command/options before awaiting, preserving the second attempt's deadline", async () => {
    const file = binary(); const args = ['--version']; const options = { timeout: 20, retryTimeout: true, shell: false };
    let terminate!: Reply;
    processMock.execFile.mockImplementationOnce((_file, argv, opts, callback: Reply) => {
      expect(argv).toEqual(['--version']); expect(opts.timeout).toBe(20); terminate = callback; return {};
    });
    processMock.execFile.mockImplementation((_file, argv, opts, callback: Reply) => {
      expect(argv).toEqual(['--version']); expect(opts).toMatchObject({ timeout: 20, shell: false });
      setImmediate(() => callback(null, 'Mozilla Firefox 154.0', '')); return {};
    });
    const pending = runBrowserCommand(file, args, options);
    args[0] = '--unsupported'; options.timeout = 0; options.shell = true; options.retryTimeout = false;
    await vi.waitFor(() => expect(processMock.execFile).toHaveBeenCalledTimes(1));
    terminate(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL', code: null }), '', '');
    expect(await pending).toEqual({ stdout: 'Mozilla Firefox 154.0', stderr: '' });
    expect(processMock.execFile).toHaveBeenCalledTimes(2);
  });
  it("does not turn aggregate output overflow followed by timeout into a successful retry", async () => {
    const file = binary(); const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL', code: null });
    processMock.execFile.mockImplementationOnce((_file, _args, _opts, callback: Reply) => {
      setImmediate(() => callback(timeout, 'x'.repeat(600_000), 'y'.repeat(600_000))); return {};
    });
    expect(await runBrowserCommand(file, ['--version'], { timeout: 20, retryTimeout: true })).toBeNull();
    expect(processMock.execFile).toHaveBeenCalledTimes(1);
  });
  it("bounds confirmed-timeout retries at one, leaving failed probes retryable", async () => {
    const file = binary(); const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL', code: null });
    respond('', '', timeout);
    expect(await runBrowserCommand(file, ['--version'], { timeout: 20, retryTimeout: true })).toBeNull();
    expect(processMock.execFile).toHaveBeenCalledTimes(2);
    respond('Mozilla Firefox 154.0', '');
    expect(await runBrowserCommand(file, ['--version'], { timeout: 20, retryTimeout: true })).not.toBeNull();
    expect(processMock.execFile).toHaveBeenCalledTimes(3);
  });
  it("does not retry a timeout against a changed executable", async () => {
    const file = binary(); let terminate!: Reply;
    processMock.execFile.mockImplementation((_file, _args, _opts, callback: Reply) => { terminate = callback; return {}; });
    const pending = runBrowserCommand(file, ['--version'], { timeout: 20, retryTimeout: true });
    await vi.waitFor(() => expect(processMock.execFile).toHaveBeenCalledTimes(1)); fs.appendFileSync(file, 'replacement');
    terminate(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL', code: null }), '', '');
    expect(await pending).toBeNull(); expect(processMock.execFile).toHaveBeenCalledTimes(1);
  });
  it.each(['nonzero', 'output', 'capability', 'shell'])("does not retry unrelated %s failures or commands", async mode => {
    const file = binary();
    const error = Object.assign(new Error('failure'), { killed: true, signal: 'SIGKILL', code: mode === 'nonzero' ? 1 : mode === 'output' ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : null });
    respond('', '', error);
    const args = mode === 'capability' ? ['--agent-browser-capabilities'] : ['--version'];
    expect(await runBrowserCommand(file, args, { timeout: 20, retryTimeout: true, shell: mode === 'shell' })).toBeNull();
    expect(processMock.execFile).toHaveBeenCalledTimes(1);
  });
  it("keys cache entries by arguments, timeout, and shell options", async () => {
    const file = binary();
    await runBrowserCommand(file, ["--version"], { timeout: 5000 });
    await runBrowserCommand(file, ["--capabilities"], { timeout: 5000 });
    await runBrowserCommand(file, ["--version"], { timeout: 3000 });
    await runBrowserCommand(file, ["--version"], { timeout: 5000, shell: true });
    await runBrowserCommand(file, ["--version"], { timeout: 5000, shell: false });
    expect(processMock.execFile).toHaveBeenCalledTimes(4);
  });

  it("invalidates changed size/ctime and same-size inode replacement with restored mtime", async () => {
    const file = binary();
    await runBrowserCommand(file, [], { timeout: 100 });
    fs.appendFileSync(file, "changed-size");
    await runBrowserCommand(file, [], { timeout: 100 });
    const previous = fs.statSync(file);
    const replacement = binary("replacement");
    fs.writeFileSync(replacement, "x".repeat(previous.size));
    fs.utimesSync(replacement, previous.atime, previous.mtime);
    fs.renameSync(replacement, file);
    await runBrowserCommand(file, [], { timeout: 100 });
    expect(processMock.execFile).toHaveBeenCalledTimes(3);
  });

  it("invalidates same-size changes even when executable mtime is restored", async () => {
    const file = binary();
    await runBrowserCommand(file, [], { timeout: 100 });
    const before = fs.statSync(file);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fs.writeFileSync(file, "x".repeat(before.size));
    fs.utimesSync(file, before.atime, before.mtime);
    expect(fs.statSync(file).ctimeMs).not.toBe(before.ctimeMs);
    await runBrowserCommand(file, [], { timeout: 100 });
    expect(processMock.execFile).toHaveBeenCalledTimes(2);
  });

  it("invalidates deletion and retries after the file is recreated", async () => {
    const file = binary();
    await runBrowserCommand(file, [], { timeout: 100 });
    fs.unlinkSync(file);
    expect(await runBrowserCommand(file, [], { timeout: 100 })).toBeNull();
    expect(processMock.execFile).toHaveBeenCalledTimes(1);
    binary();
    expect(await runBrowserCommand(file, [], { timeout: 100 })).not.toBeNull();
    expect(processMock.execFile).toHaveBeenCalledTimes(2);
  });

  it("rechecks identity after the subprocess response and discards a stale result", async () => {
    const file = binary();
    let finish!: Reply;
    processMock.execFile.mockImplementation((_file, _args, _opts, callback: Reply) => { finish = callback; return {}; });
    const pending = runBrowserCommand(file, [], { timeout: 100 });
    await vi.waitFor(() => expect(processMock.execFile).toHaveBeenCalledTimes(1));
    fs.appendFileSync(file, "replacement during probe");
    finish(null, "old", "");
    expect(await pending).toBeNull();
    respond("new", "");
    expect(await runBrowserCommand(file, [], { timeout: 100 })).toEqual({ stdout: "new", stderr: "" });
    expect(processMock.execFile).toHaveBeenCalledTimes(2);
  });

  it.each(["ENOENT", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "nonzero-exit"])(
    "does not retain transient %s failures", async (code) => {
      const file = binary();
      respond("", "", Object.assign(new Error(code), { code }));
      expect(await runBrowserCommand(file, [], { timeout: 100 })).toBeNull();
      respond();
      expect(await runBrowserCommand(file, [], { timeout: 100 })).not.toBeNull();
      expect(processMock.execFile).toHaveBeenCalledTimes(2);
    },
  );

  it("retries synchronous launch errors without invoking a synchronous subprocess", async () => {
    const file = binary();
    processMock.execFile.mockImplementationOnce(() => { throw new Error("launch failed"); });
    expect(await runBrowserCommand(file, [], { timeout: 100 })).toBeNull();
    expect(await runBrowserCommand(file, [], { timeout: 100 })).not.toBeNull();
  });

  it("waits for the termination callback rather than resolving at the timeout", async () => {
    const file = binary();
    let terminate!: Reply;
    processMock.execFile.mockImplementation((_file, _args, opts, callback: Reply) => {
      expect(opts).toMatchObject({ timeout: 20, killSignal: "SIGKILL" });
      terminate = callback;
      return {};
    });
    let settled = false;
    const pending = runBrowserCommand(file, [], { timeout: 20 });
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(processMock.execFile).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    terminate(new Error("SIGKILL termination observed"), "", "");
    expect(await pending).toBeNull();
  });

  it("rejects excessive combined output, invalid deadlines, and non-file executables", async () => {
    const file = binary();
    respond("x".repeat(600_000), "y".repeat(600_000));
    expect(await runBrowserCommand(file, [], { timeout: 100 })).toBeNull();
    for (const timeout of [0, -1, NaN, Infinity]) expect(await runBrowserCommand(file, [], { timeout })).toBeNull();
    expect(await runBrowserCommand(root, [], { timeout: 100 })).toBeNull();
    expect(processMock.execFile).toHaveBeenCalledTimes(1);
  });

  it("bounds pending/successful identity entries to 64", async () => {
    const files = Array.from({ length: 65 }, (_, index) => binary(`browser-${index}`));
    for (const file of files) expect(await runBrowserCommand(file, [], { timeout: 100 })).not.toBeNull();
    await runBrowserCommand(files[0], [], { timeout: 100 });
    expect(processMock.execFile).toHaveBeenCalledTimes(66);
  });
});
