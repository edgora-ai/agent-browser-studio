import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import * as vm from "node:vm";
import ts from "typescript";

const state = vi.hoisted(() => ({ appDataDir: "", profilesDir: "" }));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => state.appDataDir,
  getProfilesDir: () => state.profilesDir,
}));

const ID = "synthetic_recovery_profile";
const OPERATION = "synthetic-operation-1";
let root: string;
let locks: typeof import("../../src/main/services/profile-restore-lock.js");
const releases: Array<() => void> = [];
const receipt = () => path.join(state.appDataDir, "locks", `${ID}.full-profile-recovery.json`);
const stage = () => path.join(root, "owned-staging");
function hold(): () => void {
  const release = locks.acquireRestoreLock(ID); releases.push(release); return release;
}
function pending(bytes: string | Buffer = '{"state":"pending","synthetic":true}'): void {
  fs.mkdirSync(path.dirname(receipt()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(receipt(), bytes, { mode: 0o600 });
}
function caught(operation: () => unknown): any {
  try { operation(); } catch (error) { return error; }
  return undefined;
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "full-profile-recovery-lock-test-"));
  state.appDataDir = path.join(root, "app"); state.profilesDir = path.join(state.appDataDir, "profiles");
  fs.mkdirSync(state.profilesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stage(), { mode: 0o700 });
  vi.resetModules(); locks = await import("../../src/main/services/profile-restore-lock.js");
});
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const release of releases.splice(0).reverse()) release();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("persistent full-profile recovery lease gate", () => {
  it("blocks an existing pending receipt before granting a fresh restore lease", () => {
    pending(); const before = fs.readFileSync(receipt());
    const error = caught(() => hold());
    expect(error).toMatchObject({ code: "FULL_PROFILE_RECOVERY_REQUIRED", dirId: ID, receiptPath: receipt() });
    expect(fs.readFileSync(receipt())).toEqual(before);
    expect(fs.existsSync(path.join(state.appDataDir, "locks", `${ID}.restore.lock`))).toBe(false);
  });
  it("writes/fsyncs a private owned receipt, verifies actual disk fields, finds it by id, and removes only that receipt under its original lease", () => {
    const release = hold(), ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() });
    const text = fs.readFileSync(receipt(), "utf8"), parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ version: 1, state: "pending", dirId: ID, operationId: OPERATION,
      profileDir: path.join(state.profilesDir, ID), backupDir: path.join(state.profilesDir, ID) + ".full-profile-backup-" + OPERATION, stagingDir: stage() });
    expect(parsed.token).toMatch(/^[a-f0-9-]{36}$/); expect(Object.isFrozen(ticket)).toBe(true);
    expect(fs.readdirSync(path.dirname(receipt())).filter(name => name.includes(ID + ".full-profile-recovery"))).toEqual([path.basename(receipt())]);
    if (process.platform !== "win32") expect(fs.statSync(receipt()).mode & 0o777).toBe(0o600);
    expect(locks.isRestoreLocked(ID)).toBe(true);
    expect(() => locks.assertNoFullProfileRecovery(ID)).toThrow(/recovery is required/);
    locks.finishFullProfileRecovery(ticket); expect(fs.lstatSync(receipt(), { throwIfNoEntry: false })).toBeUndefined();
    locks.finishFullProfileRecovery(ticket); // Same lease/absence: harmless retry.
    release(); expect(locks.isRestoreLocked(ID)).toBe(false); hold();
  });
  it("cannot begin without a currently owned restore lease or overwrite an existing marker", () => {
    const error = caught(() => locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }));
    expect(error?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(fs.existsSync(receipt())).toBe(false);
    hold(); pending("unknown-existing-receipt");
    expect(() => locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() })).toThrow(/recovery is required/);
    expect(fs.readFileSync(receipt(), "utf8")).toBe("unknown-existing-receipt");
  });
  it.each(["bad/op", "..", ""])("rejects unsafe operation id %s without writing a marker", (operationId) => {
    hold(); expect(() => locks.beginFullProfileRecovery({ dirId: ID, operationId, stagingDir: stage() })).toThrow(/recovery is required/);
    expect(fs.existsSync(receipt())).toBe(false);
  });
  it("survives normal lease release and a module restart; neither PID staleness nor a reset WeakMap makes the marker reclaimable", async () => {
    const release = hold(), ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }); release();
    const bytes = fs.readFileSync(receipt()); expect(locks.isRestoreLocked(ID)).toBe(true);
    vi.resetModules(); locks = await import("../../src/main/services/profile-restore-lock.js");
    expect(caught(() => hold())?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED");
    expect(caught(() => locks.finishFullProfileRecovery(ticket))?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED");
    expect(fs.readFileSync(receipt())).toEqual(bytes);
  });
  it.each(["empty", "malformed", "directory", "symlink", "dangling-symlink", "hardlink"])("fails closed for an existing %s marker without opening its content or link target", (kind) => {
    fs.mkdirSync(path.dirname(receipt()), { recursive: true, mode: 0o700 });
    const sentinel = path.join(root, "owned-sentinel"); fs.writeFileSync(sentinel, "SYNTHETIC_SECRET_NOT_TO_BE_READ");
    if (kind === "directory") fs.mkdirSync(receipt());
    else if (kind === "symlink" || kind === "dangling-symlink") fs.symlinkSync(kind === "symlink" ? sentinel : sentinel + "-missing", receipt());
    else if (kind === "hardlink") fs.linkSync(sentinel, receipt());
    else fs.writeFileSync(receipt(), kind === "empty" ? "" : "{SYNTHETIC_SECRET_MALFORMED");
    const original = fsMutable.openSync; let receiptOpened = false;
    vi.spyOn(fsMutable, "openSync").mockImplementation((file, flags, mode) => {
      if (String(file) === receipt() || String(file) === sentinel) { receiptOpened = true; throw new Error("SYNTHETIC_SECRET_OPENED"); }
      return original(file, flags, mode);
    }); syncBuiltinESMExports();
    const error = caught(() => locks.assertNoFullProfileRecovery(ID));
    expect(error).toMatchObject({ code: "FULL_PROFILE_RECOVERY_REQUIRED", dirId: ID, receiptPath: receipt() });
    expect(caught(() => hold())?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(receiptOpened).toBe(false);
    expect(error.message).not.toMatch(/SYNTHETIC|MALFORMED|OPENED/); expect(JSON.stringify(error)).not.toContain("SECRET");
  });
  it("refuses a symlink locks directory without opening a file under its target", () => {
    const outside = path.join(root, "owned-outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, path.basename(receipt())), "sentinel");
    fs.symlinkSync(outside, path.dirname(receipt()));
    const original = fsMutable.openSync; let opened = false;
    vi.spyOn(fsMutable, "openSync").mockImplementation((file, flags, mode) => { if (String(file).startsWith(outside)) opened = true; return original(file, flags, mode); }); syncBuiltinESMExports();
    expect(caught(() => hold())?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(opened).toBe(false);
  });
  it("rejects copied or fabricated tickets and a released lease, preserving the genuine receipt", () => {
    const release = hold(), ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }), before = fs.readFileSync(receipt());
    expect(caught(() => locks.finishFullProfileRecovery({ ...ticket }))?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED");
    release(); expect(caught(() => locks.finishFullProfileRecovery(ticket))?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED");
    expect(fs.readFileSync(receipt())).toEqual(before);
  });
  it("does not accept a later lease for the same id as the original ticket owner", () => {
    const release = hold(), ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }); release();
    const retained = receipt() + ".synthetic-retained"; fs.renameSync(receipt(), retained); hold(); fs.renameSync(retained, receipt());
    expect(caught(() => locks.finishFullProfileRecovery(ticket))?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(fs.existsSync(receipt())).toBe(true);
  });
  it.each(["same-bytes-new-inode", "mutated-bytes", "symlink", "hardlink"])("never removes a %s receipt replacement", (kind) => {
    hold(); const ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }), original = fs.readFileSync(receipt());
    const retained = receipt() + ".synthetic-retained";
    if (kind === "mutated-bytes") fs.writeFileSync(receipt(), "SYNTHETIC_OTHER_TRANSACTION");
    else {
      fs.renameSync(receipt(), retained);
      if (kind === "same-bytes-new-inode") fs.writeFileSync(receipt(), original);
      else if (kind === "symlink") fs.symlinkSync(retained, receipt());
      else fs.linkSync(retained, receipt());
    }
    const stat = fs.lstatSync(receipt()), error = caught(() => locks.finishFullProfileRecovery(ticket));
    expect(error?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(fs.lstatSync(receipt()).ino).toBe(stat.ino);
    if (kind === "mutated-bytes") expect(fs.readFileSync(receipt(), "utf8")).toBe("SYNTHETIC_OTHER_TRANSACTION");
    else expect(fs.readFileSync(retained)).toEqual(original);
  });
  it("never deletes a receipt under a replaced locks directory", () => {
    hold(); const ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }), bytes = fs.readFileSync(receipt());
    const directory = path.dirname(receipt()), retained = directory + "-retained"; fs.renameSync(directory, retained); fs.mkdirSync(directory); pending("foreign-directory-receipt");
    expect(caught(() => locks.finishFullProfileRecovery(ticket))?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED");
    expect(fs.readFileSync(receipt(), "utf8")).toBe("foreign-directory-receipt");
    expect(fs.readFileSync(path.join(retained, path.basename(receipt())))).toEqual(bytes);
    // Restore the fixture's directory path so the original ordinary lease can release.
    fs.renameSync(directory, directory + "-foreign-retained"); fs.renameSync(retained, directory);
  });
  it.each(["partial-write", "file-fsync", "directory-fsync"])("retains a blocking marker when begin fails at %s", (phase) => {
    const release = hold(), opened = new Map<number, string>(), open = fsMutable.openSync, write = fsMutable.writeFileSync, sync = fsMutable.fsyncSync;
    vi.spyOn(fsMutable, "openSync").mockImplementation((file, flags, mode) => { const fd = open(file, flags, mode); opened.set(fd, String(file)); return fd; });
    vi.spyOn(fsMutable, "writeFileSync").mockImplementation((file, data, options) => {
      if (phase === "partial-write" && typeof file === "number" && opened.get(file) === receipt()) { write(file, Buffer.from("{partial-pending")); throw new Error("SYNTHETIC_WRITE_FAILURE_PRIVATE_PAYLOAD"); }
      return write(file, data, options);
    });
    vi.spyOn(fsMutable, "fsyncSync").mockImplementation((fd) => {
      if (phase === "file-fsync" && opened.get(fd) === receipt() || phase === "directory-fsync" && opened.get(fd) === path.dirname(receipt())) throw new Error("SYNTHETIC_FSYNC_FAILURE_PRIVATE_PAYLOAD");
      return sync(fd);
    }); syncBuiltinESMExports();
    const error = caught(() => locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }));
    expect(error?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(error.message).not.toContain("PRIVATE_PAYLOAD"); expect(fs.lstatSync(receipt()).isFile()).toBe(true);
    release(); expect(caught(() => hold())?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED");
  });
  it("does not delete the marker if pre-removal directory durability fails", () => {
    hold(); const ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }), bytes = fs.readFileSync(receipt());
    vi.spyOn(fsMutable, "fsyncSync").mockImplementation(() => { throw new Error("SYNTHETIC_FSYNC_FAILURE"); }); syncBuiltinESMExports();
    expect(caught(() => locks.finishFullProfileRecovery(ticket))?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(fs.readFileSync(receipt())).toEqual(bytes);
  });
  it("exclusively re-establishes the same gate if post-unlink durability fails, and never reports finish success", () => {
    hold(); const ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }), bytes = fs.readFileSync(receipt()), original = fsMutable.fsyncSync;
    let failed = false;
    vi.spyOn(fsMutable, "fsyncSync").mockImplementation((fd) => {
      if (!failed && !fs.existsSync(receipt())) { failed = true; throw new Error("SYNTHETIC_POST_UNLINK_FSYNC_FAILURE"); }
      return original(fd);
    }); syncBuiltinESMExports();
    const error = caught(() => locks.finishFullProfileRecovery(ticket)); expect(failed).toBe(true);
    expect(error).toMatchObject({ code: "FULL_PROFILE_RECOVERY_REQUIRED", recoveryGateConfirmed: true }); expect(fs.readFileSync(receipt())).toEqual(bytes);
    expect(caught(() => locks.assertNoFullProfileRecovery(ID))?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED");
    locks.finishFullProfileRecovery(ticket); expect(fs.existsSync(receipt())).toBe(false);
  });
  it("does not replace a foreign object appearing during the post-unlink check", () => {
    hold(); const ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }), original = fsMutable.fsyncSync;
    let planted = false;
    vi.spyOn(fsMutable, "fsyncSync").mockImplementation((fd) => {
      if (!planted && !fs.existsSync(receipt())) { planted = true; pending("foreign-post-unlink-receipt"); throw new Error("SYNTHETIC_POST_UNLINK_FAILURE"); }
      return original(fd);
    }); syncBuiltinESMExports();
    expect(caught(() => locks.finishFullProfileRecovery(ticket))?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED");
    expect(fs.readFileSync(receipt(), "utf8")).toBe("foreign-post-unlink-receipt");
  });
  it("production launch acquire catch preserves recovery errors but still maps ordinary contention to busy, before any browser work", async () => {
    const source = fs.readFileSync(new URL("../../src/main/services/browser-manager.ts", import.meta.url), "utf8"), start = source.indexOf("export async function launchBrowser(");
    const stop = source.indexOf("\n\n  try {\n  // Keep startup identity intent stable", start);
    expect(start).toBeGreaterThan(0); expect(stop).toBeGreaterThan(start);
    // Execute the actual production function prefix, not a copied catch fixture.
    // No Electron/config/runtime module, browser binary or native process is loaded.
    const prefix = source.slice(start, stop) + '\n  if (releaseLaunchLock) releaseLaunchLock();\n  return { reachedBrowserWork: true };\n}';
    const compiled = ts.transpileModule(prefix, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} as Record<string, any> };
    const context = { exports: module.exports, validateDirId: () => undefined, isManagedProfileId: () => true, acquireRestoreLock: locks.acquireRestoreLock };
    vm.runInNewContext(compiled, context);
    pending(); const error = await module.exports.launchBrowser(ID).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "FULL_PROFILE_RECOVERY_REQUIRED", receiptPath: receipt(), dirId: ID }); expect(error.message).not.toContain("temporarily blocked");
    fs.unlinkSync(receipt()); const release = hold();
    const busy = await module.exports.launchBrowser(ID).catch((cause: unknown) => cause); expect(busy.message).toContain("temporarily blocked"); release();
    await expect(module.exports.launchBrowser(ID)).resolves.toMatchObject({ reachedBrowserWork: true });
  });
});
