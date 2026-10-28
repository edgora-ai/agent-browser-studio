import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import {
  captureFullProfile, prepareFullProfile, type CaptureFullProfileOptions, type FullProfileProgress,
} from "../../src/main/services/sync/full-profile-artifact.js";
import {
  __resetProcessDiscoveryExecForTest, __setProcessDiscoveryExecForTest, findBrowserByProfileSync,
} from "../../src/main/services/process-discovery.js";
import {
  acquireRestoreLock, assertProfileTransferStopped, isRestoreLocked, withProfileTransferProcessSnapshot,
} from "../../src/main/services/profile-restore-lock.js";

// Real process-frame and lease implementations; only fresh invented profiles and
// injected process-table text. Never import real app config or spawn ps/browser.
const location = vi.hoisted(() => ({ root: "", profiles: "" }));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => { if (!location.root) throw new Error("No owned fixture"); return location.root; },
  getProfilesDir: () => { if (!location.profiles) throw new Error("No owned fixture"); return location.profiles; },
}));
vi.mock("node:child_process", () => {
  const blocked = () => { throw new Error("Real subprocesses are forbidden in the synthetic batching fixture"); };
  return { exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, spawn: blocked, spawnSync: blocked, fork: blocked };
});
const ID = "synthetic-bounded-read-profile", CHUNK = 64 * 1024, BATCH = 4 * 1024 * 1024, MIB = 1024 * 1024;
const roots: Array<{ directory: string; stat: fs.Stats }> = [];
const turns = new Set<ReturnType<typeof setImmediate>>();
const releases: Array<() => void> = [];
function schedule(action: () => void): void {
  const turn = setImmediate(() => { turns.delete(turn); action(); }); turns.add(turn);
}
afterEach(() => {
  for (const turn of turns) clearImmediate(turn); turns.clear();
  vi.restoreAllMocks(); syncBuiltinESMExports(); __resetProcessDiscoveryExecForTest();
  for (const release of releases.splice(0)) release();
  for (const root of roots.splice(0)) {
    const current = fs.lstatSync(root.directory);
    expect(path.resolve(root.directory)).toBe(root.directory);
    expect(path.basename(root.directory)).toMatch(/^sync-read-batching-/);
    expect([current.dev, current.ino]).toEqual([root.stat.dev, root.stat.ino]);
    fs.rmSync(root.directory, { recursive: true, force: true });
  }
  location.root = ""; location.profiles = "";
});
interface Frame { bytes: number; reads: number; guards: number; providers: number; }
function fixture(size = 16 * MIB) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-read-batching-"));
  fs.chmodSync(root, 0o700); roots.push({ directory: root, stat: fs.lstatSync(root) });
  location.root = root; location.profiles = path.join(root, "profiles");
  const profileDir = path.join(location.profiles, ID), stagingDir = path.join(root, "staging");
  for (const directory of [profileDir, stagingDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.alloc(size, 0x5a), file = path.join(profileDir, "state.bin");
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  const metadata = path.join(root, "metadata.json"), metadataBytes = Buffer.from('{"syntheticRevision":1}');
  fs.writeFileSync(metadata, metadataBytes, { flag: "wx", mode: 0o600 });
  const state = { running: false, unknown: false, checks: 0, providers: 0, onProvider: () => undefined as void, nonProcess: () => undefined as void };
  let active: Frame | undefined;
  const frames: Frame[] = [], buffers = new Set<Buffer>(), reads: Array<{ file: string; bytes: number }> = [];
  __setProcessDiscoveryExecForTest({ execFileSync: ((command: string) => {
    if (!["ps", "wmic", "tasklist", "powershell.exe"].includes(command)) throw new Error("Unfenced process provider");
    state.providers++; state.onProvider(); if (active) active.providers++;
    if (state.unknown) throw new Error("Synthetic process discovery unavailable");
    if (!state.running) return "";
    const args = `/synthetic/chrome --user-data-dir="${profileDir}" --remote-debugging-port=9222`;
    return command === "wmic" ? `Node,CommandLine,ProcessId\nFIXTURE,${args},4242\n` : `4242 ${args}\n`;
  }) as any });
  const release = acquireRestoreLock(ID); releases.push(release);
  const lease = path.join(root, "locks", ID + ".restore.lock"), leaseBytes = fs.readFileSync(lease);
  const guard = Object.assign(() => {
    state.checks++; if (active) active.guards++;
    state.nonProcess();
    assertProfileTransferStopped(ID, () => {
      const browser = findBrowserByProfileSync(ID, profileDir, { strict: true });
      return { running: browser !== null, pid: browser?.pid ?? null, unknown: browser?.unknown ?? false };
    }, undefined, { engine: "chromium" });
  }, { runSynchronous<T>(action: () => T): T {
    expect(active).toBeUndefined();
    const frame = { bytes: 0, reads: 0, guards: 0, providers: 0 }; frames.push(frame); active = frame;
    try { return withProfileTransferProcessSnapshot(ID, action); }
    finally { active = undefined; }
  } });
  const open = fsMutable.openSync, read = fsMutable.readSync, close = fsMutable.closeSync;
  const fds = new Map<number, string>();
  vi.spyOn(fsMutable, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (typeof args[0] === "string") fds.set(fd, args[0]);
    return fd;
  }) as typeof open);
  vi.spyOn(fsMutable, "readSync").mockImplementation(((...args: any[]) => {
    const count = Reflect.apply(read, fsMutable, args), name = fds.get(args[0]);
    if (active && name && (name.endsWith("/state.bin") || name.endsWith("/profile.zip"))) {
      buffers.add(args[1]);
      if (count > 0) { active.bytes += count; active.reads++; reads.push({ file: name, bytes: count }); }
    }
    return count;
  }) as typeof read);
  vi.spyOn(fsMutable, "closeSync").mockImplementation(fd => { close(fd); fds.delete(fd); });
  syncBuiltinESMExports();
  const options: CaptureFullProfileOptions = { profileDir, stagingDir, dirId: ID, engine: "chromium", snapshotId: "synthetic-batch-snapshot",
    passphrase: "synthetic bounded batching passphrase", sourcePlatform: "darwin", guard };
  function unchanged() {
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readFileSync(metadata)).toEqual(metadataBytes);
    expect(fs.readFileSync(lease)).toEqual(leaseBytes);
    expect(isRestoreLocked(ID)).toBe(true);
    expect(fds.size).toBe(0);
    for (const buffer of buffers) expect(buffer.every(byte => byte === 0)).toBe(true);
  }
  return { root, file, bytes, options, state, frames, reads, buffers, fds, lease, leaseBytes, release, unchanged,
    inFrame: () => active !== undefined };
}

describe("bounded full-profile synchronous read batches", () => {
  it("amortizes a 16 MiB capture/prepare over batches with real process frames and no weakened per-chunk guards", async () => {
    const f = fixture(), progress: FullProfileProgress[] = [];
    const onProgress = (value: FullProfileProgress) => { expect(f.inFrame()).toBe(false); progress.push(value); };
    const started = performance.now();
    const artifact = await captureFullProfile({ ...f.options, onProgress });
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]);
    const captureProviders = f.state.providers, captureReads = f.reads.length, captureFrames = f.frames.length;
    expect(captureReads).toBeGreaterThanOrEqual(3 * f.bytes.length / CHUNK);
    expect(captureProviders).toBeLessThan(captureReads / 4);
    expect(captureFrames).toBeLessThan(captureReads / 4);
    expect(f.frames.some(frame => frame.reads > 1)).toBe(true);
    expect(f.frames.every(frame => frame.providers <= 1)).toBe(true);
    expect(f.frames.every(frame => frame.bytes <= BATCH)).toBe(true);
    expect(f.state.checks).toBeGreaterThan(captureReads);
    const prepared = await prepareFullProfile({ ...f.options, ...artifact, onProgress });
    expect(fs.readFileSync(path.join(prepared.directory, "state.bin")).equals(f.bytes)).toBe(true);
    for (const phase of ["scanning", "reading-archive", "verifying-source", "verifying-profile"] as const) {
      const updates = progress.filter(value => value.phase === phase);
      expect(updates.length).toBeGreaterThanOrEqual(4);
      expect(updates.at(-1)!.bytes).toBeGreaterThanOrEqual(f.bytes.length);
      for (let i = 1; i < updates.length; i++) {
        expect(updates[i].bytes - updates[i - 1].bytes).toBeLessThanOrEqual(BATCH);
        expect(updates[i].bytes).toBeGreaterThanOrEqual(updates[i - 1].bytes);
        expect(updates[i].items).toBeGreaterThanOrEqual(updates[i - 1].items);
      }
      if (phase !== "reading-archive") expect(updates.at(-1)!.items).toBe(1);
    }
    f.unchanged();
    console.info("synthetic 16MiB capture batching", { captureProviders, captureReads, captureFrames, captureAndPrepareMs: Math.round(performance.now() - started) });
  });

  it("keeps uneven file tails within the hard byte cap", async () => {
    const f = fixture(8 * MIB), controller = new AbortController();
    // Test the byte cap independently of a slow machine's valid 16 ms flush.
    const clock = Date.now(); vi.spyOn(Date, "now").mockReturnValue(clock);
    fs.writeFileSync(path.join(f.options.profileDir, "00-prefix.bin"), Buffer.from([1]), { mode: 0o600 });
    let firstBytes = 0;
    await expect(captureFullProfile({ ...f.options, signal: controller.signal, onProgress(value) {
      if (value.phase !== "scanning") return;
      firstBytes = value.bytes;
      expect(firstBytes).toBeLessThanOrEqual(BATCH);
      expect(firstBytes).toBeGreaterThan(BATCH - CHUNK);
      controller.abort();
    } })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(firstBytes).toBeGreaterThan(0); f.unchanged();
  });

  it.each(["running", "unknown"] as const)("rejects fresh %s process state after a batch yield before another payload read", async mode => {
    const f = fixture(); let scheduled = false, readsAtChange = -1, providersAtChange = -1;
    await expect(captureFullProfile({ ...f.options, onProgress(value) {
      if (value.phase !== "scanning" || scheduled) return;
      scheduled = true;
      expect(value.bytes).toBeGreaterThan(0); expect(value.bytes).toBeLessThanOrEqual(BATCH);
      schedule(() => { expect(f.inFrame()).toBe(false); readsAtChange = f.reads.length; providersAtChange = f.state.providers; f.state[mode] = true; });
    } })).rejects.toMatchObject({ code: "PROFILE_STOP_REQUIRED" });
    expect(scheduled).toBe(true); expect(readsAtChange).toBeGreaterThan(1);
    expect(f.reads.length).toBe(readsAtChange); expect(f.state.providers).toBeGreaterThan(providersAtChange);
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]); f.unchanged();
  });

  it.each(["scanning", "reading-archive", "verifying-profile"] as const)("cancels at the next %s batch yield, clears buffers, cleans staging and retains caller metadata/lease", async phase => {
    const f = fixture(), controller = new AbortController();
    const artifact = phase === "verifying-profile" ? await captureFullProfile(f.options) : undefined;
    let scheduled = false, readsAtAbort = -1, abortedAt = 0;
    const onProgress = (value: FullProfileProgress) => {
      if (value.phase !== phase || scheduled) return;
      scheduled = true;
      expect(value.bytes).toBeGreaterThan(0); expect(value.bytes).toBeLessThanOrEqual(BATCH);
      schedule(() => { expect(f.inFrame()).toBe(false); readsAtAbort = f.reads.length; abortedAt = performance.now(); controller.abort(); });
    };
    const work = artifact ? prepareFullProfile({ ...f.options, ...artifact, signal: controller.signal, onProgress })
      : captureFullProfile({ ...f.options, signal: controller.signal, onProgress });
    await expect(work).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(scheduled).toBe(true); expect(readsAtAbort).toBeGreaterThan(0); expect(f.reads.length).toBe(readsAtAbort);
    const settledAfterAbortMs = performance.now() - abortedAt;
    expect(settledAfterAbortMs).toBeLessThan(1000); // Generous CI bound; exact no-more-read assertion is the contract.
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]); f.unchanged();
    console.info("synthetic batch cancellation", { phase, settledAfterAbortMs: Math.round(settledAfterAbortMs) });
  });

  it("retains frequent non-process checks inside the same cached process frame", async () => {
    const f = fixture(); let checksAfterFirstRead = 0;
    f.state.nonProcess = () => {
      if (f.reads.length) { checksAfterFirstRead++; throw new Error("SYNTHETIC_METADATA_CHANGED"); }
    };
    await expect(captureFullProfile(f.options)).rejects.toThrow("SYNTHETIC_METADATA_CHANGED");
    expect(f.reads).toEqual([{ file: f.file, bytes: CHUNK }]); expect(checksAfterFirstRead).toBe(1);
    expect(f.frames).toHaveLength(1); expect(f.frames[0].providers).toBe(1);
    expect(fs.readdirSync(f.options.stagingDir)).toEqual([]); f.unchanged();
  });

  it("revalidates the caller lease before resuming a yielded batch and does not remove a replaced lease", async () => {
    const f = fixture(); let scheduled = false, readsAtChange = -1;
    const replacement = Buffer.from(JSON.stringify({ pid: process.pid, dirId: ID, token: "synthetic-foreign-lease" }));
    await expect(captureFullProfile({ ...f.options, onProgress(value) {
      if (value.phase !== "scanning" || scheduled) return; scheduled = true;
      schedule(() => { readsAtChange = f.reads.length; fs.writeFileSync(f.lease, replacement); });
    } })).rejects.toThrow(/lease ownership changed/);
    expect(f.reads.length).toBe(readsAtChange); expect(fs.readdirSync(f.options.stagingDir)).toEqual([]);
    expect(isRestoreLocked(ID)).toBe(true); expect(fs.readFileSync(f.file).equals(f.bytes)).toBe(true);
    f.release(); expect(fs.readFileSync(f.lease)).toEqual(replacement);
  });

  it("still amortizes a slow admission instead of yielding every chunk after expensive process discovery", async () => {
    const f = fixture(), controller = new AbortController(); let clock = Date.now(), firstBytes = -1;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // Simulate a 50ms ps admission without spawning ps or busy-waiting. A timer
    // started before that admission would repeatedly flush at zero/one chunks.
    f.state.onProvider = () => { clock += 50; };
    await expect(captureFullProfile({ ...f.options, signal: controller.signal, onProgress(value) {
      if (firstBytes !== -1) return; firstBytes = value.bytes; schedule(() => controller.abort());
    } })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(firstBytes).toBe(BATCH); expect(f.reads).toHaveLength(BATCH / CHUNK);
    expect(f.frames[0].providers).toBe(1); f.unchanged();
  });

  it("honors the time bound before the byte bound", async () => {
    const f = fixture(MIB), controller = new AbortController(); let clock = Date.now(), firstBytes = -1;
    vi.spyOn(Date, "now").mockImplementation(() => { clock += 4; return clock; });
    await expect(captureFullProfile({ ...f.options, signal: controller.signal, onProgress(value) {
      if (firstBytes !== -1) return; firstBytes = value.bytes; schedule(() => controller.abort());
    } })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(firstBytes).toBeGreaterThan(0); expect(firstBytes).toBeLessThanOrEqual(4 * CHUNK);
    expect(firstBytes).toBeLessThan(BATCH); expect(f.reads.length).toBe(firstBytes / CHUNK); f.unchanged();
  });

  it("bounds item-only traversal even when there are no payload bytes", async () => {
    const f = fixture(0), controller = new AbortController();
    for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(f.options.profileDir, "empty-" + i), { mode: 0o700 });
    let firstItems = -1;
    await expect(captureFullProfile({ ...f.options, signal: controller.signal, onProgress(value) {
      if (firstItems !== -1) return; firstItems = value.items;
      expect(value.bytes).toBe(0); schedule(() => controller.abort());
    } })).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(firstItems).toBeGreaterThan(0); expect(firstItems).toBeLessThanOrEqual(128);
    expect(fs.readdirSync(f.options.profileDir)).toHaveLength(301); expect(fs.readdirSync(f.options.stagingDir)).toEqual([]); f.unchanged();
  });
});
