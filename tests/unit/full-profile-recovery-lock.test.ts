import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import * as vm from "node:vm";
import ts from "typescript";

type RecoveryTicket = import("../../src/main/services/profile-restore-lock.js").FullProfileRecoveryTicket;
const state = vi.hoisted(() => ({ appDataDir: "", profilesDir: "" }));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => state.appDataDir,
  getProfilesDir: () => state.profilesDir,
}));

const ID = "synthetic_recovery_profile";
const OPERATION = "synthetic-operation-1";
const INERT_OPERATION = "synthetic-inert-orphan-no-issued-ticket";
let root: string;
let locks: typeof import("../../src/main/services/profile-restore-lock.js");
const releases: Array<() => void> = [];
const receipt = (dirId = ID) => path.join(state.appDataDir, "locks", `${dirId}.full-profile-recovery.json`);
const stage = () => path.join(root, "owned-staging");
function hold(dirId = ID): () => void {
  const release = locks.acquireRestoreLock(dirId); releases.push(release); return release;
}
function pending(bytes: string | Buffer = '{"state":"pending","synthetic":true}', dirId = ID): void {
  fs.mkdirSync(path.dirname(receipt(dirId)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(receipt(dirId), bytes, { mode: 0o600 });
}
function caught(operation: () => unknown): any {
  try { operation(); } catch (error) { return error; }
  return undefined;
}

// Observe real owned filesystem capabilities, not just process.platform. Only the
// native Windows EPERM from fsync on an already-open, identity-checked directory
// is unsupported here. Open errors, other fsync errors and file-fsync errors fail.
function probeOwnedDirectoryDurability(): "supported" | "win32-eperm-fsync" {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-profile-recovery-capability-"));
  try {
    const file = path.join(directory, "owned-file"), bytes = Buffer.from("synthetic-fsync-probe");
    const fileFd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fileFd, bytes); fs.fsyncSync(fileFd); }
    finally { fs.closeSync(fileFd); }
    if (!fs.readFileSync(file).equals(bytes)) throw new Error("Owned file probe readback changed");
    const owner = fs.lstatSync(directory);
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!owner.isDirectory() || owner.isSymbolicLink() || !opened.isDirectory() ||
          opened.dev !== owner.dev || opened.ino !== owner.ino) throw new Error("Owned directory probe identity changed");
      try { fs.fsyncSync(fd); }
      catch (error) {
        const native = error as NodeJS.ErrnoException;
        if (process.platform === "win32" && native.code === "EPERM" && native.syscall === "fsync") return "win32-eperm-fsync";
        throw error;
      }
    } finally { fs.closeSync(fd); }
    return "supported";
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
const nativeDurability = probeOwnedDirectoryDurability();
const nativeCase = (supported: string, refused: string) => nativeDurability === "supported" ? supported :
  `native Windows EPERM/fsync refuses begin; ${refused}`;

// Transparent observation: every fsync either invokes the real fsync or throws
// an explicitly counted fault below. No successful durability is synthesized.
function observeOwnedIO() {
  const open = fsMutable.openSync, close = fsMutable.closeSync, sync = fsMutable.fsyncSync, unlink = fsMutable.unlinkSync, write = fsMutable.writeFileSync;
  const faults: { open?: (file: fs.PathLike) => void; write?: (file: fs.PathOrFileDescriptor) => void; sync?: (fd: number, file: string) => void } = {};
  const opened: Array<{ fd: number; file: string; flags: fs.OpenMode; owner: fs.Stats; closed: boolean }> = [];
  const live = new Map<number, typeof opened[number]>();
  const syncs: Array<{ file: string; owner: fs.Stats; ok: boolean; error?: unknown }> = [];
  const unlinks: string[] = [];
  vi.spyOn(fsMutable, "openSync").mockImplementation((file, flags, mode) => {
    faults.open?.(file);
    const fd = open(file, flags, mode);
    if (String(file).startsWith(root + path.sep)) {
      const observation = { fd, file: String(file), flags, owner: fs.fstatSync(fd), closed: false };
      opened.push(observation); live.set(fd, observation);
    }
    return fd;
  });
  vi.spyOn(fsMutable, "closeSync").mockImplementation((fd) => {
    close(fd);
    const observation = live.get(fd);
    if (observation) { observation.closed = true; live.delete(fd); }
  });
  vi.spyOn(fsMutable, "fsyncSync").mockImplementation((fd) => {
    const observation = live.get(fd);
    if (!observation) return sync(fd);
    const attempt: typeof syncs[number] = { file: observation.file, owner: fs.fstatSync(fd), ok: false };
    syncs.push(attempt);
    try { faults.sync?.(fd, observation.file); sync(fd); attempt.ok = true; }
    catch (error) { attempt.error = error; throw error; }
  });
  vi.spyOn(fsMutable, "writeFileSync").mockImplementation((file, data, options) => {
    faults.write?.(file);
    return write(file, data, options);
  });
  vi.spyOn(fsMutable, "unlinkSync").mockImplementation((file) => {
    if (String(file).startsWith(root + path.sep)) unlinks.push(String(file));
    return unlink(file);
  });
  syncBuiltinESMExports();
  return {
    opened, syncs, unlinks, faults, writeActual: write,
    fileFor: (fd: number) => live.get(fd)?.file,
    mark: () => ({ opened: opened.length, syncs: syncs.length, unlinks: unlinks.length }),
    expectClosedSince(mark: { opened: number }) {
      for (const observation of opened.slice(mark.opened)) {
        expect(observation.closed, observation.file).toBe(true);
        expect(caught(() => fs.fstatSync(observation.fd))).toMatchObject({ code: "EBADF" });
      }
    },
  };
}
let io: ReturnType<typeof observeOwnedIO>;
interface DiskSnapshot { file: string; bytes: Buffer; owner: fs.Stats; }
let untouchedPayloads: DiskSnapshot[];
function statFields(stat: fs.Stats) {
  const { dev, ino, size, mode, nlink, uid, gid, mtimeMs, ctimeMs } = stat;
  return { dev, ino, size, mode, nlink, uid, gid, mtimeMs, ctimeMs };
}
function expectSameObject(file: string, owner: fs.Stats): void {
  expect(statFields(fs.lstatSync(file))).toEqual(statFields(owner));
}
function snapshot(file = receipt()): DiskSnapshot {
  const owner = fs.lstatSync(file), bytes = fs.readFileSync(file);
  expect(owner.isFile()).toBe(true); expect(owner.isSymbolicLink()).toBe(false); expect(owner.nlink).toBe(1);
  expect(bytes.length).toBe(owner.size); expectSameObject(file, owner);
  return { file, bytes, owner };
}
function expectUnchanged(record: DiskSnapshot): void {
  expectSameObject(record.file, record.owner);
  expect(fs.readFileSync(record.file)).toEqual(record.bytes);
  expectSameObject(record.file, record.owner);
}
function expectNoTransfer(): void {
  for (const payload of untouchedPayloads) expectUnchanged(payload);
  expect(fs.lstatSync(path.join(state.profilesDir, ID) + ".full-profile-backup-" + OPERATION, { throwIfNoEntry: false })).toBeUndefined();
}
function expectRecoveryRequired(error: unknown, dirId = ID, file = receipt(dirId)): void {
  expect(error).toMatchObject({
    message: "Full-profile recovery is required before launching or transferring this profile.",
    code: "FULL_PROFILE_RECOVERY_REQUIRED", dirId, receiptPath: file,
  });
  expect(error).not.toHaveProperty("receiptHandleClosureUnconfirmed");
}
function expectDiskFields(record: DiskSnapshot): void {
  const parsed = JSON.parse(record.bytes.toString("utf8"));
  expect(parsed).toMatchObject({ version: 1, state: "pending", dirId: ID, operationId: OPERATION,
    receiptPath: receipt(), profileDir: path.join(state.profilesDir, ID),
    backupDir: path.join(state.profilesDir, ID) + ".full-profile-backup-" + OPERATION, stagingDir: stage() });
  expect(parsed.token).toMatch(/^[a-f0-9-]{36}$/);
  expect(fs.readdirSync(path.dirname(receipt())).filter(name => name.includes(ID + ".full-profile-recovery"))).toEqual([path.basename(receipt())]);
  if (process.platform !== "win32") expect(record.owner.mode & 0o777).toBe(0o600);
}
function expectNativeDirectoryRefusal(mark: { syncs: number; opened: number; unlinks: number }): void {
  const attempts = io.syncs.slice(mark.syncs);
  expect(attempts.map(attempt => attempt.file)).toEqual([receipt(), state.appDataDir]);
  expect(attempts[0].owner.isFile()).toBe(true); expect(attempts[0].ok).toBe(true);
  expect(attempts[1].owner.isDirectory()).toBe(true); expect(attempts[1].ok).toBe(false);
  expect(attempts[1].error).toMatchObject({ code: "EPERM", syscall: "fsync" });
  const directoryOpen = io.opened.slice(mark.opened).filter(open => open.file === state.appDataDir);
  expect(directoryOpen).toHaveLength(1);
  expect(directoryOpen[0].flags).toBe(fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  expect(directoryOpen[0].owner.dev).toBe(fs.lstatSync(state.appDataDir).dev);
  expect(directoryOpen[0].owner.ino).toBe(fs.lstatSync(state.appDataDir).ino);
  expect(io.opened.slice(mark.opened).filter(open => open.file === path.dirname(receipt()))).toHaveLength(0);
  expect(io.unlinks.slice(mark.unlinks)).toEqual([]);
}
type RecoveryAttempt = { release: () => void; record: DiskSnapshot } & (
  { kind: "issued"; ticket: RecoveryTicket } | { kind: "refused"; ticket: undefined }
);
function beginObservedRecovery(): RecoveryAttempt {
  const release = hold(), mark = io.mark();
  let ticket: RecoveryTicket | undefined;
  const error = caught(() => { ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }); });
  io.expectClosedSince(mark);
  if (nativeDurability === "supported") {
    expect(error).toBeUndefined(); expect(ticket).toBeDefined();
    if (!ticket) throw new Error("Native durable begin did not issue its real ticket");
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(io.syncs.slice(mark.syncs).map(attempt => [attempt.file, attempt.ok])).toEqual([
      [receipt(), true], [state.appDataDir, true], [path.dirname(receipt()), true],
    ]);
    const record = snapshot(); expectDiskFields(record); expectNoTransfer();
    return { kind: "issued", ticket, record, release };
  }
  expect(ticket).toBeUndefined(); expectRecoveryRequired(error);
  expect(error.recoveryPaths).toEqual([receipt(), path.join(state.profilesDir, ID),
    path.join(state.profilesDir, ID) + ".full-profile-backup-" + OPERATION, stage()]);
  expect(error).not.toHaveProperty("recoveryGateConfirmed");
  expectNativeDirectoryRefusal(mark);
  const record = snapshot(); expectDiskFields(record); expectNoTransfer();
  return { kind: "refused", ticket: undefined, record, release };
}

// Deliberately invalid consumer input, NEVER an issued ticket or permission to
// finish. No WeakMap authority, token or valid active-completion proof is forged.
function syntheticInertInput(dirId = ID): RecoveryTicket {
  return { dirId, operationId: INERT_OPERATION, receiptPath: receipt(dirId), profileDir: path.join(state.profilesDir, dirId),
    backupDir: path.join(state.profilesDir, dirId) + ".full-profile-backup-" + INERT_OPERATION, stagingDir: stage() };
}
function completionConsumer(attempt: RecoveryAttempt, laterLease = false) {
  if (attempt.kind === "issued") return { dirId: ID, ticket: attempt.ticket, record: attempt.record, release: attempt.release, close: attempt.release };
  // Exercise orphan/replacement consumers in a SEPARATE owned namespace. Never
  // move, rewrite or temporarily hide the real gate left by the refused begin.
  const originalScope = { ...state }, dirId = "synthetic_inert_orphan_consumer";
  state.appDataDir = path.join(root, "synthetic-inert-consumer", "app");
  state.profilesDir = path.join(state.appDataDir, "profiles");
  fs.mkdirSync(state.profilesDir, { recursive: true, mode: 0o700 });
  let release = hold(dirId);
  const ticket = syntheticInertInput(dirId);
  if (laterLease) { release(); release = hold(dirId); }
  pending("SYNTHETIC_HISTORICAL_ORPHAN_NO_ACTIVE_AUTHORITY", dirId);
  const record = snapshot(receipt(dirId));
  return { dirId, ticket, record, release, close: () => { release(); Object.assign(state, originalScope); } };
}
async function expectRetainedAfterReleaseRestartAndRetry(attempt: RecoveryAttempt, record = attempt.record): Promise<void> {
  const input = attempt.kind === "issued" ? attempt.ticket : syntheticInertInput(), mark = io.mark();
  attempt.release();
  expect(fs.lstatSync(path.join(state.appDataDir, "locks", `${ID}.restore.lock`), { throwIfNoEntry: false })).toBeUndefined();
  const assertBlocked = () => {
    expectUnchanged(record); expectNoTransfer();
    expect(locks.isRestoreLocked(ID)).toBe(true); expect(locks.isRestoreLocked(ID, { reclaimStale: false })).toBe(true);
    expectRecoveryRequired(caught(() => locks.assertNoFullProfileRecovery(ID)));
    expectRecoveryRequired(caught(() => hold()));
    const retry = caught(() => locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }));
    expectRecoveryRequired(retry); expect(retry.recoveryPaths).toEqual([receipt(), path.join(state.profilesDir, ID)]);
    expectUnchanged(record);
  };
  assertBlocked();
  vi.resetModules(); locks = await import("../../src/main/services/profile-restore-lock.js");
  assertBlocked();
  expectRecoveryRequired(caught(() => locks.finishFullProfileRecovery(input)));
  expectUnchanged(record); io.expectClosedSince({ opened: 0 });
  expect(io.syncs.slice(mark.syncs)).toEqual([]);
  expect(io.unlinks.slice(mark.unlinks).filter(file => file === record.file)).toEqual([]);
  if (attempt.kind === "refused") expect(io.unlinks.filter(file => file === record.file)).toEqual([]);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "full-profile-recovery-lock-test-"));
  state.appDataDir = path.join(root, "app"); state.profilesDir = path.join(state.appDataDir, "profiles");
  fs.mkdirSync(path.join(state.profilesDir, ID), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stage(), { mode: 0o700 });
  untouchedPayloads = [path.join(state.profilesDir, ID, "synthetic-original"), path.join(stage(), "synthetic-staged")].map(file => {
    fs.writeFileSync(file, "SYNTHETIC_UNCOMMITTED_PAYLOAD", { mode: 0o600 }); return snapshot(file);
  });
  vi.resetModules(); locks = await import("../../src/main/services/profile-restore-lock.js");
  io = observeOwnedIO();
});
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const release of releases.splice(0).reverse()) release();
  fs.rmSync(root, { recursive: true, force: true });
  expect(fs.lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
});

describe(`persistent full-profile recovery lease gate [native directory fsync: ${nativeDurability}]`, () => {
  it("blocks an existing pending receipt before granting a fresh restore lease", () => {
    pending(); const before = fs.readFileSync(receipt());
    const error = caught(() => hold());
    expect(error).toMatchObject({ code: "FULL_PROFILE_RECOVERY_REQUIRED", dirId: ID, receiptPath: receipt() });
    expect(fs.readFileSync(receipt())).toEqual(before);
    expect(fs.existsSync(path.join(state.appDataDir, "locks", `${ID}.restore.lock`))).toBe(false);
  });
  it(nativeCase(
    "writes/fsyncs a private owned receipt, verifies disk fields, finds it by id, and finishes only under its original lease",
    "retains verified disk bytes/identity with closed fds, no ticket, no transfer or clearing, including release/restart/retry",
  ), async () => {
    const attempt = beginObservedRecovery();
    expect(locks.isRestoreLocked(ID)).toBe(true);
    expectRecoveryRequired(caught(() => locks.assertNoFullProfileRecovery(ID)));
    const mark = io.mark();
    if (attempt.kind === "issued") {
      locks.finishFullProfileRecovery(attempt.ticket);
      expect(fs.lstatSync(receipt(), { throwIfNoEntry: false })).toBeUndefined();
      expect(io.syncs.slice(mark.syncs).map(sync => [sync.file, sync.ok])).toEqual([
        [state.appDataDir, true], [path.dirname(receipt()), true], [state.appDataDir, true], [path.dirname(receipt()), true],
      ]);
      expect(io.unlinks.slice(mark.unlinks)).toEqual([receipt()]); io.expectClosedSince(mark);
      const retry = io.mark();
      locks.finishFullProfileRecovery(attempt.ticket); // Same lease/absence: harmless retry.
      expect(io.syncs.slice(retry.syncs)).toEqual([]); expect(io.unlinks.slice(retry.unlinks)).toEqual([]); io.expectClosedSince(retry);
      attempt.release(); expect(locks.isRestoreLocked(ID)).toBe(false); hold();
    } else {
      expectRecoveryRequired(caught(() => locks.finishFullProfileRecovery(syntheticInertInput())));
      expect(io.syncs.slice(mark.syncs)).toEqual([]); expect(io.unlinks.slice(mark.unlinks)).toEqual([]); io.expectClosedSince(mark);
      expectUnchanged(attempt.record);
      await expectRetainedAfterReleaseRestartAndRetry(attempt);
    }
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
  it(nativeCase(
    "survives normal lease release and a module restart; neither PID staleness nor a reset WeakMap makes the marker reclaimable",
    "retains the unconfirmed-durability gate after normal release and restart/retry, without any issued ticket",
  ), async () => {
    const attempt = beginObservedRecovery();
    await expectRetainedAfterReleaseRestartAndRetry(attempt);
  });
  it.each(["empty", "malformed", "directory", "symlink", "dangling-symlink", "hardlink"])("fails closed for an existing %s marker without opening its content or link target", (kind) => {
    fs.mkdirSync(path.dirname(receipt()), { recursive: true, mode: 0o700 });
    const sentinel = path.join(root, "owned-sentinel"); fs.writeFileSync(sentinel, "SYNTHETIC_SECRET_NOT_TO_BE_READ");
    if (kind === "directory") fs.mkdirSync(receipt());
    else if (kind === "symlink" || kind === "dangling-symlink") fs.symlinkSync(kind === "symlink" ? sentinel : sentinel + "-missing", receipt());
    else if (kind === "hardlink") fs.linkSync(sentinel, receipt());
    else fs.writeFileSync(receipt(), kind === "empty" ? "" : "{SYNTHETIC_SECRET_MALFORMED");
    let receiptOpened = false;
    io.faults.open = (file) => {
      if (String(file) === receipt() || String(file) === sentinel) { receiptOpened = true; throw new Error("SYNTHETIC_SECRET_OPENED"); }
    };
    const error = caught(() => locks.assertNoFullProfileRecovery(ID));
    expect(error).toMatchObject({ code: "FULL_PROFILE_RECOVERY_REQUIRED", dirId: ID, receiptPath: receipt() });
    expect(caught(() => hold())?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(receiptOpened).toBe(false);
    expect(error.message).not.toMatch(/SYNTHETIC|MALFORMED|OPENED/); expect(JSON.stringify(error)).not.toContain("SECRET");
  });
  it("refuses a symlink locks directory without opening a file under its target", () => {
    const outside = path.join(root, "owned-outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, path.basename(receipt())), "sentinel");
    fs.symlinkSync(outside, path.dirname(receipt()));
    let opened = false;
    io.faults.open = (file) => {
      if ([outside, path.dirname(receipt())].some(directory => String(file) === directory || String(file).startsWith(directory + path.sep))) {
        opened = true; throw new Error("Synthetic recovery link must not be opened through either alias");
      }
    };
    expect(caught(() => hold())?.code).toBe("FULL_PROFILE_RECOVERY_REQUIRED"); expect(opened).toBe(false);
  });
  it(nativeCase(
    "rejects copied or fabricated tickets and a released lease, preserving the genuine receipt",
    "rejects copied/fabricated/released inert orphan consumer inputs (not active-ticket ownership coverage)",
  ), async () => {
    const attempt = beginObservedRecovery(), fixture = completionConsumer(attempt), mark = io.mark();
    expectRecoveryRequired(caught(() => locks.finishFullProfileRecovery({ ...fixture.ticket })), fixture.dirId);
    expectRecoveryRequired(caught(() => locks.finishFullProfileRecovery(syntheticInertInput(fixture.dirId))), fixture.dirId);
    fixture.release(); expectRecoveryRequired(caught(() => locks.finishFullProfileRecovery(fixture.ticket)), fixture.dirId);
    expectUnchanged(fixture.record);
    expect(io.syncs.slice(mark.syncs)).toEqual([]);
    expect(io.unlinks.slice(mark.unlinks).filter(file => file === fixture.record.file)).toEqual([]); io.expectClosedSince(mark);
    fixture.close();
    if (attempt.kind === "refused") await expectRetainedAfterReleaseRestartAndRetry(attempt);
  });
  it(nativeCase(
    "does not accept a later lease for the same id as the original ticket owner",
    "rejects an inert orphan input under a later ordinary lease (no original recovery-ticket authority)",
  ), async () => {
    const attempt = beginObservedRecovery(), fixture = completionConsumer(attempt, true);
    let laterRelease = fixture.release;
    if (attempt.kind === "issued") {
      attempt.release();
      const retained = fixture.record.file + ".synthetic-retained";
      // Original adversarial fixture: retain the genuine object, change the
      // ordinary lease, then restore the gate before attempting completion.
      fs.renameSync(fixture.record.file, retained); laterRelease = hold(); fs.renameSync(retained, fixture.record.file);
    }
    const before = snapshot(fixture.record.file), mark = io.mark();
    expectRecoveryRequired(caught(() => locks.finishFullProfileRecovery(fixture.ticket)), fixture.dirId);
    expectUnchanged(before); expect(io.syncs.slice(mark.syncs)).toEqual([]); expect(io.unlinks.slice(mark.unlinks)).toEqual([]); io.expectClosedSince(mark);
    laterRelease(); fixture.close();
    if (attempt.kind === "refused") await expectRetainedAfterReleaseRestartAndRetry(attempt);
  });
  it.each(["same-bytes-new-inode", "mutated-bytes", "symlink", "hardlink"])(nativeCase(
    "never removes a %s receipt replacement",
    "rejects inert orphan consumer input and preserves its %s replacement (not active-ticket replacement coverage)",
  ), async (kind) => {
    const attempt = beginObservedRecovery(), fixture = completionConsumer(attempt), file = fixture.record.file, original = fixture.record.bytes;
    const retained = file + ".synthetic-retained";
    if (kind === "mutated-bytes") fs.writeFileSync(file, "SYNTHETIC_OTHER_TRANSACTION");
    else {
      fs.renameSync(file, retained);
      if (kind === "same-bytes-new-inode") fs.writeFileSync(file, original);
      else if (kind === "symlink") fs.symlinkSync(retained, file);
      else fs.linkSync(retained, file);
    }
    const stat = fs.lstatSync(file);
    if (kind === "same-bytes-new-inode") {
      expect(stat.isFile()).toBe(true);
      // Observe exact native identities; large Windows inode numbers can lose
      // precision when represented as ordinary JavaScript numbers.
      expect(fs.lstatSync(file, { bigint: true }).ino).not.toBe(fs.lstatSync(retained, { bigint: true }).ino);
      expect(fs.readFileSync(file)).toEqual(original);
    } else if (kind === "mutated-bytes") {
      expect(stat.ino).toBe(fixture.record.owner.ino); expect(stat.dev).toBe(fixture.record.owner.dev);
    } else if (kind === "symlink") {
      expect(stat.isSymbolicLink()).toBe(true);
    } else {
      expect(stat.nlink).toBe(2); expect(stat.ino).toBe(fixture.record.owner.ino); expect(stat.dev).toBe(fixture.record.owner.dev);
    }
    const mark = io.mark(), error = caught(() => locks.finishFullProfileRecovery(fixture.ticket));
    expectRecoveryRequired(error, fixture.dirId); expectSameObject(file, stat);
    if (kind === "mutated-bytes") expect(fs.readFileSync(file, "utf8")).toBe("SYNTHETIC_OTHER_TRANSACTION");
    else expect(fs.readFileSync(retained)).toEqual(original);
    expect(io.syncs.slice(mark.syncs)).toEqual([]); expect(io.unlinks.slice(mark.unlinks)).toEqual([]); io.expectClosedSince(mark);
    fixture.close();
    if (attempt.kind === "refused") await expectRetainedAfterReleaseRestartAndRetry(attempt);
  });
  it(nativeCase(
    "never deletes a receipt under a replaced locks directory",
    "rejects an inert orphan input under a replaced directory without moving the refused-begin gate",
  ), async () => {
    const attempt = beginObservedRecovery(), fixture = completionConsumer(attempt), file = fixture.record.file;
    const directory = path.dirname(file), retained = directory + "-retained";
    fs.renameSync(directory, retained); fs.mkdirSync(directory); pending("foreign-directory-receipt", fixture.dirId);
    const foreign = snapshot(file), mark = io.mark();
    try {
      expectRecoveryRequired(caught(() => locks.finishFullProfileRecovery(fixture.ticket)), fixture.dirId);
      expectUnchanged(foreign);
      expect(fs.readFileSync(path.join(retained, path.basename(file)))).toEqual(fixture.record.bytes);
      expect(io.syncs.slice(mark.syncs)).toEqual([]); expect(io.unlinks.slice(mark.unlinks)).toEqual([]); io.expectClosedSince(mark);
    } finally {
      // Restore only the attacked fixture's directory for ordinary lease release.
      fs.renameSync(directory, directory + "-foreign-retained"); fs.renameSync(retained, directory);
    }
    fixture.close();
    if (attempt.kind === "refused") await expectRetainedAfterReleaseRestartAndRetry(attempt);
  });
  it.each([
    ["retains a blocking marker after injected partial-write failure (one hit)", "partial-write"],
    ["retains a blocking marker after injected file-fsync failure (one hit)", "file-fsync"],
    [nativeCase("retains a blocking marker after injected locks-directory fsync failure (one hit)",
      "retains its gate before the downstream locks-directory fault (zero hits, not injected-fault coverage)"), "directory-fsync"],
  ])("%s", async (_label, phase) => {
    const release = hold(), mark = io.mark();
    let hits = 0, ticket: RecoveryTicket | undefined;
    io.faults.write = (file) => {
      if (phase === "partial-write" && typeof file === "number" && io.fileFor(file) === receipt()) {
        hits++; io.writeActual(file, Buffer.from("{partial-pending")); throw new Error("SYNTHETIC_WRITE_FAILURE_PRIVATE_PAYLOAD");
      }
    };
    io.faults.sync = (_fd, file) => {
      if ((phase === "file-fsync" && file === receipt()) || (phase === "directory-fsync" && file === path.dirname(receipt()))) {
        hits++; throw new Error("SYNTHETIC_FSYNC_FAILURE_PRIVATE_PAYLOAD");
      }
    };
    const error = caught(() => { ticket = locks.beginFullProfileRecovery({ dirId: ID, operationId: OPERATION, stagingDir: stage() }); });
    expectRecoveryRequired(error); expect(ticket).toBeUndefined(); expect(error.message).not.toContain("PRIVATE_PAYLOAD");
    expect(error.recoveryPaths).toEqual([receipt(), path.join(state.profilesDir, ID),
      path.join(state.profilesDir, ID) + ".full-profile-backup-" + OPERATION, stage()]);
    expect(error).not.toHaveProperty("recoveryGateConfirmed");
    const nativeFirst = phase === "directory-fsync" && nativeDurability === "win32-eperm-fsync";
    expect(hits).toBe(nativeFirst ? 0 : 1);
    if (nativeFirst) expectNativeDirectoryRefusal(mark);
    io.expectClosedSince(mark); expect(io.unlinks.slice(mark.unlinks)).toEqual([]);
    const record = snapshot();
    if (phase === "partial-write") expect(record.bytes).toEqual(Buffer.from("{partial-pending"));
    else expectDiskFields(record);
    expectNoTransfer();
    await expectRetainedAfterReleaseRestartAndRetry({ kind: "refused", ticket: undefined, release, record });
    expect(hits).toBe(nativeFirst ? 0 : 1);
  });
  it(nativeCase(
    "does not delete the marker if pre-removal directory durability fails (one fault hit)",
    "rejects inert completion input before pre-removal durability (zero fault hits, not finish-fault coverage)",
  ), async () => {
    const attempt = beginObservedRecovery(), mark = io.mark();
    let hits = 0;
    io.faults.sync = (_fd, file) => {
      if (file === state.appDataDir) { hits++; throw new Error("SYNTHETIC_FSYNC_FAILURE"); }
    };
    const input = attempt.kind === "issued" ? attempt.ticket : syntheticInertInput();
    const error = caught(() => locks.finishFullProfileRecovery(input));
    expectRecoveryRequired(error); expect(error).not.toHaveProperty("recoveryGateConfirmed"); expectUnchanged(attempt.record);
    expect(hits).toBe(attempt.kind === "issued" ? 1 : 0); expect(io.syncs.slice(mark.syncs)).toHaveLength(attempt.kind === "issued" ? 1 : 0);
    expect(io.unlinks.slice(mark.unlinks)).toEqual([]); io.expectClosedSince(mark); expectNoTransfer();
    await expectRetainedAfterReleaseRestartAndRetry(attempt);
  });
  it(nativeCase(
    "exclusively re-establishes the same gate after post-unlink durability failure (one hit), never reports finish success, then retries",
    "rejects inert completion input before post-unlink durability (zero fault/reinstatement hits, not rollback coverage)",
  ), async () => {
    const attempt = beginObservedRecovery(), mark = io.mark();
    let hits = 0;
    io.faults.sync = () => {
      if (hits === 0 && !fs.existsSync(receipt())) { hits++; throw new Error("SYNTHETIC_POST_UNLINK_FSYNC_FAILURE"); }
    };
    const input = attempt.kind === "issued" ? attempt.ticket : syntheticInertInput();
    const error = caught(() => locks.finishFullProfileRecovery(input)); expectRecoveryRequired(error);
    expect(fs.readFileSync(receipt())).toEqual(attempt.record.bytes); io.expectClosedSince(mark); expectNoTransfer();
    const recreated = io.opened.slice(mark.opened).filter(open => open.file === receipt() &&
      typeof open.flags === "number" && (open.flags & fs.constants.O_EXCL) !== 0);
    if (attempt.kind === "issued") {
      expect(hits).toBe(1); expect(io.syncs.slice(mark.syncs)).toHaveLength(6); expect(recreated).toHaveLength(1);
      expect(io.unlinks.slice(mark.unlinks)).toEqual([receipt()]);
      expect(error).toMatchObject({ recoveryGateConfirmed: true });
      expectRecoveryRequired(caught(() => locks.assertNoFullProfileRecovery(ID)));
      const retry = io.mark();
      locks.finishFullProfileRecovery(attempt.ticket); expect(fs.existsSync(receipt())).toBe(false);
      expect(hits).toBe(1); expect(io.syncs.slice(mark.syncs)).toHaveLength(10); expect(io.unlinks.slice(retry.unlinks)).toEqual([receipt()]); io.expectClosedSince(retry);
    } else {
      expect(hits).toBe(0); expect(io.syncs.slice(mark.syncs)).toHaveLength(0); expect(recreated).toHaveLength(0);
      expect(io.unlinks.slice(mark.unlinks)).toEqual([]); expect(error).not.toHaveProperty("recoveryGateConfirmed");
      expectUnchanged(attempt.record);
      await expectRetainedAfterReleaseRestartAndRetry(attempt);
    }
  });
  it(nativeCase(
    "does not replace a foreign object appearing during the post-unlink check (one planting fault hit)",
    "rejects inert completion input before post-unlink foreign-object planting (zero fault hits, not rollback coverage)",
  ), async () => {
    const attempt = beginObservedRecovery(), mark = io.mark();
    let hits = 0, foreign: DiskSnapshot | undefined;
    io.faults.sync = () => {
      if (hits === 0 && !fs.existsSync(receipt())) {
        hits++; pending("foreign-post-unlink-receipt"); foreign = snapshot(); throw new Error("SYNTHETIC_POST_UNLINK_FAILURE");
      }
    };
    const input = attempt.kind === "issued" ? attempt.ticket : syntheticInertInput();
    const error = caught(() => locks.finishFullProfileRecovery(input)); expectRecoveryRequired(error);
    if (attempt.kind === "issued") {
      expect(hits).toBe(1); expect(io.syncs.slice(mark.syncs)).toHaveLength(3); expect(foreign).toBeDefined();
      if (!foreign) throw new Error("Post-unlink foreign-object fault was not reached");
      expect(error).toMatchObject({ recoveryGateConfirmed: true }); expectUnchanged(foreign);
      expect(foreign.bytes.toString("utf8")).toBe("foreign-post-unlink-receipt");
      expect(io.unlinks.slice(mark.unlinks)).toEqual([receipt()]); io.expectClosedSince(mark);
      await expectRetainedAfterReleaseRestartAndRetry(attempt, foreign);
    } else {
      expect(hits).toBe(0); expect(io.syncs.slice(mark.syncs)).toHaveLength(0); expect(foreign).toBeUndefined();
      expect(error).not.toHaveProperty("recoveryGateConfirmed"); expectUnchanged(attempt.record);
      expect(io.unlinks.slice(mark.unlinks)).toEqual([]); io.expectClosedSince(mark);
      await expectRetainedAfterReleaseRestartAndRetry(attempt);
    }
  });
  it("production launch acquire catch preserves recovery errors, maps ordinary contention to busy, before any browser work (LF and CRLF)", async () => {
    const actual = fs.readFileSync(new URL("../../src/main/services/browser-manager.ts", import.meta.url), "utf8");
    for (const lineEndings of ["LF", "CRLF"] as const) {
      const fixture = lineEndings === "CRLF" ? actual.replace(/\r?\n/g, "\r\n") : actual;
      // Git's Windows checkout may be CRLF. Normalize only line endings; still
      // execute the actual production function prefix, not a copied catch.
      const source = fixture.replace(/\r\n/g, "\n"), start = source.indexOf("export async function launchBrowser(");
      const stop = source.indexOf("\n\n  try {\n  // Keep startup identity intent stable", start);
      expect(start).toBeGreaterThan(0); expect(stop).toBeGreaterThan(start);
      // No Electron/config/runtime module, browser binary or native process is loaded.
      const prefix = source.slice(start, stop) + '\n  if (releaseLaunchLock) releaseLaunchLock();\n  markBrowserWork();\n  return { reachedBrowserWork: true };\n}';
      const compiled = ts.transpileModule(prefix, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
      const module = { exports: {} as Record<string, any> };
      let browserWorkHits = 0;
      const context = { exports: module.exports, validateDirId: () => undefined, isManagedProfileId: () => true,
        acquireRestoreLock: locks.acquireRestoreLock, markBrowserWork: () => { browserWorkHits++; } };
      vm.runInNewContext(compiled, context);
      const recoveryId = `${ID}_${lineEndings}_recovery`, busyId = `${ID}_${lineEndings}_busy`;
      // A synthetic inert launch-gate consumer, not an active completion proof.
      pending('{"synthetic":"inert-launch-consumer"}', recoveryId); const marker = snapshot(receipt(recoveryId));
      const error = await module.exports.launchBrowser(recoveryId).catch((cause: unknown) => cause);
      expectRecoveryRequired(error, recoveryId); expect(error.message).not.toContain("temporarily blocked");
      expect(browserWorkHits).toBe(0); expectUnchanged(marker);
      // Separate id: never remove a recovery gate to reach the busy/success paths.
      const release = hold(busyId);
      const busy = await module.exports.launchBrowser(busyId).catch((cause: unknown) => cause);
      expect(busy.message).toContain("temporarily blocked"); expect(browserWorkHits).toBe(0); release();
      await expect(module.exports.launchBrowser(busyId)).resolves.toMatchObject({ reachedBrowserWork: true });
      expect(browserWorkHits).toBe(1); expectUnchanged(marker);
    }
  });
});
