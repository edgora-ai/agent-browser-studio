import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import ts from "typescript";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => state.root,
  getProfilesDir: () => path.join(state.root, "profiles"),
}));

const ID = "restore_retry_profile";
const DEAD_PID = 123456;
const source = fileURLToPath(new URL("../../src/main/services/profile-restore-lock.ts", import.meta.url));
const compiled = ts.transpileModule(fs.readFileSync(source, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const childProgram = `
const path = require("node:path"), vm = require("node:vm");
require("node:readline").createInterface({ input: process.stdin }).once("line", line => {
  const { root, id, code } = JSON.parse(line), module = { exports: {} };
  const fixtureRequire = name => {
    if (name === "./config-manager.js") return { getAppDataDir: () => root, getProfilesDir: () => path.join(root, "profiles") };
    if (name === "./utils.js") return { validateDirId: value => { if (value !== id) throw new Error("Unexpected fixture profile"); } };
    if (["node:crypto", "node:fs", "node:path"].includes(name)) return require(name);
    throw new Error("Undeclared child dependency");
  };
  vm.runInThisContext("(function(require,module,exports){" + code + "\\n})")(fixtureRequire, module, module.exports);
  module.exports.acquireRestoreLock(id);
  process.stdout.write("ready\\n");
});
`;
let locks: typeof import("../../src/main/services/profile-restore-lock.js");
const releases: Array<() => void> = [];
const children: Array<{ child: ChildProcessWithoutNullStreams; exited: Promise<unknown> }> = [];
const lockPath = () => path.join(state.root, "locks", `${ID}.restore.lock`);
const receiptPath = () => path.join(state.root, "locks", `${ID}.full-profile-recovery.json`);

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Owned lock fixture deadline")), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function startOwner() {
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", childProgram], {
    stdio: "pipe", windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir() },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  children.push({ child, exited });
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); if (output === "ready\n") resolve(); });
    exited.then(() => reject(new Error("Owned lock fixture exited before readiness")), reject);
  });
  child.stdin.write(JSON.stringify({ root: state.root, id: ID, code: compiled }) + "\n");
  await bounded(ready, 5_000);
  return { child, exited };
}
function deadLease(): void {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: DEAD_PID, token: "synthetic-dead-owner" }), { mode: 0o600 });
  const nativeKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: any) => {
    if (pid === DEAD_PID) throw Object.assign(new Error("Synthetic exited owner"), { code: "ESRCH" });
    return nativeKill(pid, signal);
  }) as any);
}
function afterReclaim(action: () => void): void {
  const unlink = fsMutable.unlinkSync;
  vi.spyOn(fsMutable, "unlinkSync").mockImplementation(file => {
    unlink(file);
    if (String(file) === lockPath()) action();
  });
  syncBuiltinESMExports();
}

beforeEach(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-lock-retry-"));
  vi.resetModules();
  locks = await import("../../src/main/services/profile-restore-lock.js");
});
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const release of releases.splice(0)) release();
  for (const { child, exited } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await bounded(exited, 3_000);
  }
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe("restore lease retry after interrupted synchronization", () => {
  it("blocks its live child, then acquires on the first retry after that exact child is killed", async () => {
    const profile = path.join(state.root, "profiles", ID);
    fs.mkdirSync(profile, { recursive: true });
    const sentinel = path.join(profile, "owned-sentinel");
    fs.writeFileSync(sentinel, "preserve existing browser data");
    const { child, exited } = await startOwner();
    const previous = fs.readFileSync(lockPath());
    expect(JSON.parse(previous.toString())).toMatchObject({ pid: child.pid, dirId: ID });
    expect(() => locks.acquireRestoreLock(ID)).toThrow(/Restore already in progress/);
    expect(fs.readFileSync(lockPath())).toEqual(previous);

    expect(child.kill("SIGKILL")).toBe(true);
    await bounded(exited, 3_000);
    const release = locks.acquireRestoreLock(ID); releases.push(release);
    const current = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
    expect(current).toMatchObject({ pid: process.pid, dirId: ID });
    expect(current.token).not.toBe(JSON.parse(previous.toString()).token);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve existing browser data");
    expect(fs.readdirSync(path.dirname(profile))).toContain(ID);
    expect(locks.isRestoreLocked(ID)).toBe(true);
    release();
    expect(fs.lstatSync(lockPath(), { throwIfNoEntry: false })).toBeUndefined();
    expect(locks.isRestoreLocked(ID)).toBe(false);
  }, 15_000);

  it.each(["live", "dead"] as const)("does not steal a competing %s lease created between reclaim and retry", owner => {
    deadLease();
    const contender = JSON.stringify({ pid: owner === "live" ? process.pid : DEAD_PID, token: "synthetic-competing-owner" });
    let reclaimed = 0;
    afterReclaim(() => { reclaimed++; fs.writeFileSync(lockPath(), contender, { mode: 0o600, flag: "wx" }); });
    expect(() => locks.acquireRestoreLock(ID)).toThrow(/Restore already in progress/);
    expect(reclaimed).toBe(1);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(contender);
  });

  it("preserves a full-profile recovery receipt that appears during stale reclaim", () => {
    deadLease();
    const receipt = "synthetic pending full-profile recovery";
    afterReclaim(() => fs.writeFileSync(receiptPath(), receipt, { mode: 0o600, flag: "wx" }));
    expect(() => locks.acquireRestoreLock(ID)).toThrow(/Full-profile recovery is required/);
    expect(fs.readFileSync(receiptPath(), "utf8")).toBe(receipt);
    expect(fs.lstatSync(lockPath(), { throwIfNoEntry: false })).toBeUndefined();
    expect(locks.isRestoreLocked(ID)).toBe(true);
  });

  it("does not reacquire through a replaced locks directory", () => {
    deadLease();
    afterReclaim(() => {
      fs.renameSync(path.dirname(lockPath()), path.join(state.root, "owned-old-locks"));
      fs.mkdirSync(path.dirname(lockPath()));
    });
    expect(() => locks.acquireRestoreLock(ID)).toThrow(/Restore lock directory changed/);
    expect(fs.lstatSync(lockPath(), { throwIfNoEntry: false })).toBeUndefined();
  });
});
