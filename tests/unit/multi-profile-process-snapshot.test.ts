import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("node:child_process", () => {
  const blocked = () => { throw new Error("Native process commands are forbidden in the synthetic frame fixture"); };
  return { exec: blocked, execFileSync: blocked };
});
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => fixture.root,
  getProfilesDir: () => path.join(fixture.root, "profiles"),
}));

import {
  __resetProcessDiscoveryExecForTest, __setProcessDiscoveryExecForTest,
  findBrowserByProfileSync, inspectBrowserLaunchesSync,
  withProfileProcessSnapshotSync, withProfileProcessSnapshotsSync, withoutProfileProcessSnapshotSync,
} from "../../src/main/services/process-discovery.js";
import {
  acquireRestoreLock, assertProfileTransferStopped,
  withProfileTransferProcessSnapshot, withProfileTransferProcessSnapshots,
} from "../../src/main/services/profile-restore-lock.js";

const nativePlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const releases: Array<() => void> = [];
const A = "synthetic_profile_a", B = "synthetic_profile_b", C = "synthetic_profile_c";
const directory = (id: string) => path.join(fixture.root, "profiles", id);
const chromium = (id: string, pid: number, port?: number) =>
  `${pid} /synthetic/chromium --user-data-dir="${directory(id)}"${port === undefined ? "" : ` --remote-debugging-port=${port}`}`;
const find = (id: string) => findBrowserByProfileSync(id, directory(id), { strict: true });
function status(id: string) {
  const found = find(id);
  return { running: found !== null, pid: found?.pid ?? null, unknown: found?.unknown ?? false, state: found ? "running" : "stopped" };
}
function hold(id: string): () => void {
  fs.mkdirSync(directory(id), { recursive: true });
  const release = acquireRestoreLock(id);
  releases.push(release);
  return release;
}
function sample(output: () => string) {
  const command = vi.fn(output);
  __setProcessDiscoveryExecForTest({ execFileSync: command as any });
  return command;
}

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-profile-process-frame-"));
  fs.mkdirSync(path.join(fixture.root, "profiles"));
  Object.defineProperty(process, "platform", { value: "darwin" });
  sample(() => { throw new Error("Unconfigured synthetic process provider"); });
});
afterEach(() => {
  try { for (const release of releases.splice(0).reverse()) release(); }
  finally {
    __resetProcessDiscoveryExecForTest();
    Object.defineProperty(process, "platform", nativePlatform);
    vi.restoreAllMocks();
    const target = path.resolve(fixture.root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("multi-profile-process-frame-")) {
      throw new Error("Refusing to remove an unexpected fixture directory");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("synchronous multi-profile process observations", () => {
  it.each([1, 4, 12])("uses one ps per all-profile frame without reducing any of P=%i source guards", (count) => {
    const ids = Array.from({ length: count }, (_, index) => `synthetic_profile_${index}`);
    ids.forEach(hold);
    const command = sample(() => "");
    const guard = vi.fn((id: string) => withProfileTransferProcessSnapshot(id, () =>
      withProfileProcessSnapshotSync(directory(id) + path.sep + ".", () => assertProfileTransferStopped(
        id, () => status(id),
        () => inspectBrowserLaunchesSync(directory(id), undefined, { strict: true }).candidates.length !== 0,
      )),
    ));
    const objects = count + 3; // P profile objects + E extension objects.
    for (let object = 0; object < objects; object++) {
      for (let boundary = 0; boundary < 2; boundary++) {
        expect(withProfileTransferProcessSnapshots(ids, () => { ids.forEach(guard); return "validated"; })).toBe("validated");
      }
    }
    expect(guard).toHaveBeenCalledTimes(2 * count * objects);
    expect(command).toHaveBeenCalledTimes(2 * objects);
    expect(command.mock.calls.every((args: unknown[]) => args[0] === "ps")).toBe(true);
  });

  it("takes a fresh observation at the next frame and blocks newly launched ownership without a CDP port", () => {
    const ids = [A, B, C]; ids.forEach(hold);
    let output = "";
    const command = sample(() => output);
    const guards = () => ids.forEach((id) => assertProfileTransferStopped(id, () => status(id)));
    withProfileTransferProcessSnapshots(ids, guards);
    output = chromium(B, 200);
    expect(() => withProfileTransferProcessSnapshots(ids, guards)).toThrow(expect.objectContaining({ code: "PROFILE_STOP_REQUIRED" }));
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("reuses normalized exact group membership and allowlisted single-profile nesting", () => {
    let output = chromium(A, 100, 9222);
    const command = sample(() => output);
    withProfileProcessSnapshotsSync([directory(A) + path.sep + ".", directory(B)], () => {
      expect(find(A)?.pid).toBe(100);
      output = chromium(A, 101, 9222);
      withProfileProcessSnapshotSync(directory(A), () => expect(find(A)?.pid).toBe(100));
      withProfileProcessSnapshotsSync([directory(B), directory(A), directory(A)], () => expect(find(A)?.pid).toBe(100));
      // A narrower group is a distinct scope, unlike the legacy single API.
      withProfileProcessSnapshotsSync([directory(A)], () => expect(find(A)?.pid).toBe(101));
      expect(find(A)?.pid).toBe(100);
    });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("isolates mismatched nested groups and single frames, then restores the outer observation", () => {
    let output = [chromium(A, 100), chromium(B, 200)].join("\n");
    const command = sample(() => output);
    withProfileProcessSnapshotsSync([directory(A), directory(B)], () => {
      expect(find(A)?.pid).toBe(100);
      output = [chromium(A, 101), chromium(B, 201), chromium(C, 301)].join("\n");
      withProfileProcessSnapshotsSync([directory(A), directory(C)], () => {
        expect(find(A)?.pid).toBe(101);
        expect(find(B)?.pid).toBe(201); // Not allowlisted: independent observation.
        output = chromium(C, 302);
        expect(find(C)?.pid).toBe(301);
      });
      expect(find(B)?.pid).toBe(200);
      withProfileProcessSnapshotSync(directory(C), () => {
        expect(find(C)?.pid).toBe(302);
        expect(find(A)).toBeNull(); // Cannot reach a suspended outer group.
      });
      expect(find(A)?.pid).toBe(100);
    });
    expect(command).toHaveBeenCalledTimes(5);
  });

  it("captures the allowlist rather than retaining a caller-mutable array", () => {
    const dirs = [directory(A)];
    let output = "";
    const command = sample(() => output);
    withProfileProcessSnapshotsSync(dirs, () => {
      expect(find(A)).toBeNull();
      dirs.push(directory(B));
      output = chromium(B, 200);
      expect(find(B)?.pid).toBe(200);
      output = chromium(B, 201);
      expect(find(B)?.pid).toBe(201);
      expect(find(A)).toBeNull();
    });
    expect(command).toHaveBeenCalledTimes(3);
  });

  it("does not expose cached parsed processes or their nested arrays for mutation", () => {
    const command = sample(() => [chromium(A, 100, 9222), chromium(B, 200, 9333)].join("\n"));
    withProfileProcessSnapshotsSync([directory(A), directory(B)], () => {
      const snapshot = inspectBrowserLaunchesSync(directory(A), 200, { strict: true });
      snapshot.candidates[0].pid = 999;
      snapshot.candidates[0].engine = null;
      snapshot.candidates[0].args.splice(0);
      snapshot.candidates[0].profileDirs[0] = directory(C);
      snapshot.candidates[0].cdpPorts[0] = 0;
      snapshot.tracked!.profileDirs.splice(0);
      snapshot.tracked!.args.push("--type=renderer");
      snapshot.candidates.splice(0);
      expect(find(A)).toEqual({ pid: 100, cdpPort: 9222 });
      expect(find(B)).toEqual({ pid: 200, cdpPort: 9333 });
      const again = inspectBrowserLaunchesSync(directory(B), 100, { strict: true });
      expect(again.candidates[0].profileDirs).toEqual([directory(B)]);
      expect(again.tracked).toMatchObject({ pid: 100, engine: "chromium", cdpPorts: [9222] });
      expect(again.tracked!.args.length).toBeGreaterThan(0);
    });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("fails closed once per frame across profiles and does not retain failure into the next frame", () => {
    let failed = true;
    const command = sample(() => { if (failed) throw new Error("Synthetic ps unavailable"); return chromium(B, 200); });
    const errors: unknown[] = [];
    withProfileProcessSnapshotsSync([directory(A), directory(B)], () => {
      for (const id of [A, B, A, B]) {
        try { find(id); } catch (error) { errors.push(error); }
      }
    });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatchObject({ code: "PROCESS_DISCOVERY_UNAVAILABLE" });
    expect(errors.every((error) => error === errors[0])).toBe(true);
    expect(command).toHaveBeenCalledTimes(2); // One strict attempt, including its existing fallback.
    failed = false;
    withProfileProcessSnapshotsSync([directory(A), directory(B)], () => expect(find(B)?.pid).toBe(200));
    expect(command).toHaveBeenCalledTimes(3);
  });

  it("cannot seed a group from a lossy nonstrict Windows fallback or recover a failed frame by retrying", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    let failed = true;
    const command = vi.fn((provider: string) => {
      if (provider === "wmic") throw new Error("Synthetic WMIC failure");
      if (provider === "powershell.exe") {
        if (failed) throw new Error("Synthetic CIM failure");
        return JSON.stringify([{ ProcessId: 200, CommandLine: chromium(B, 200, 9333).replace(/^200 /, "") }]);
      }
      throw new Error("Lossy tasklist must not be consulted within a frame");
    });
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    withProfileProcessSnapshotsSync([directory(A), directory(B)], () => {
      expect(() => findBrowserByProfileSync(A, directory(A))).toThrow(expect.objectContaining({ code: "PROCESS_DISCOVERY_UNAVAILABLE" }));
      failed = false;
      expect(() => find(B)).toThrow(expect.objectContaining({ code: "PROCESS_DISCOVERY_UNAVAILABLE" }));
    });
    expect(command).toHaveBeenCalledTimes(2);
    withProfileProcessSnapshotsSync([directory(A), directory(B)], () => {
      expect(findBrowserByProfileSync(B, directory(B))).toEqual({ pid: 200, cdpPort: 9333 });
      expect(find(B)).toEqual({ pid: 200, cdpPort: 9333 });
    });
    expect(command.mock.calls.map(([provider]) => provider)).toEqual(["wmic", "powershell.exe", "wmic", "powershell.exe"]);
  });

  it("uses independent strict observations for nonmembers without poisoning the allowed group", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    let attempts = 0;
    const command = vi.fn((provider: string) => {
      if (++attempts === 1 && provider === "wmic") {
        return `Node,CommandLine,ProcessId\nHOST,${chromium(A, 100, 9222).replace(/^100 /, "")},100\n`;
      }
      throw new Error("Synthetic independent provider failure");
    });
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    withProfileProcessSnapshotsSync([directory(A)], () => {
      expect(find(A)?.pid).toBe(100);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => findBrowserByProfileSync(B, directory(B))).toThrow(expect.objectContaining({ code: "PROCESS_DISCOVERY_UNAVAILABLE" }));
      }
      expect(find(A)?.pid).toBe(100);
    });
    expect(command.mock.calls.map(([provider]) => provider)).toEqual(["wmic", "wmic", "powershell.exe", "wmic", "powershell.exe"]);
  });

  it.each(["single", "group", "without"] as const)("restores the outer group and clears exited frames after a thrown %s callback", (kind) => {
    let output = [chromium(A, 100), chromium(C, 300)].join("\n");
    const command = sample(() => output);
    const marker = new Error("Synthetic callback failure");
    expect(() => withProfileProcessSnapshotsSync([directory(A), directory(B)], () => {
      expect(find(A)?.pid).toBe(100);
      output = [chromium(A, 101), chromium(C, 301)].join("\n");
      const action = () => { expect(find(C)?.pid).toBe(301); throw marker; };
      expect(() => kind === "single" ? withProfileProcessSnapshotSync(directory(C), action)
        : kind === "group" ? withProfileProcessSnapshotsSync([directory(A), directory(C)], action)
          : withoutProfileProcessSnapshotSync(action)).toThrow(marker);
      expect(find(A)?.pid).toBe(100);
      throw marker;
    })).toThrow(marker);
    expect(find(A)?.pid).toBe(101);
    expect(command).toHaveBeenCalledTimes(3);
  });

  it.each(["single", "group", "without", "transfer-group"] as const)("rejects Promise callbacks in %s and restores the outer group", async (kind) => {
    [A, B].forEach(hold);
    const command = sample(() => chromium(A, 100));
    withProfileProcessSnapshotsSync([directory(A), directory(B)], () => {
      expect(find(A)?.pid).toBe(100);
      const action = () => Promise.reject(new Error("Synthetic async rejection"));
      expect(() => kind === "single" ? withProfileProcessSnapshotSync(directory(A), action)
        : kind === "group" ? withProfileProcessSnapshotsSync([directory(A), directory(C)], action)
          : kind === "without" ? withoutProfileProcessSnapshotSync(action)
            : withProfileTransferProcessSnapshots([A, B], action))
        .toThrow(expect.objectContaining({ code: "PROCESS_DISCOVERY_FRAME_ASYNC" }));
      expect(find(A)?.pid).toBe(100);
    });
    await Promise.resolve();
    expect(find(A)?.pid).toBe(100);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("leaves no observation active when a rejected async callback resumes after await", async () => {
    let output = "";
    let resumedPid: number | undefined;
    let pending: Promise<void> | undefined;
    const command = sample(() => output);
    expect(() => withProfileProcessSnapshotsSync([directory(A), directory(B)], () => {
      pending = (async () => {
        expect(find(A)).toBeNull();
        await Promise.resolve();
        resumedPid = find(B)?.pid;
        throw new Error("Synthetic post-await rejection");
      })();
      return pending;
    })).toThrow(expect.objectContaining({ code: "PROCESS_DISCOVERY_FRAME_ASYNC" }));
    output = chromium(B, 200);
    await expect(pending).rejects.toThrow("Synthetic post-await rejection");
    expect(resumedPid).toBe(200);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("validates every id and requires every restore lease before invoking a transfer group", () => {
    const action = vi.fn(() => "validated");
    expect(() => withProfileTransferProcessSnapshots([A, "../escape"], action)).toThrow(/Invalid profile ID/);
    expect(() => withProfileTransferProcessSnapshots([A, B], action)).toThrow(/lease is not owned/);
    hold(A);
    expect(() => withProfileTransferProcessSnapshots([A, B], action)).toThrow(/lease is not owned/);
    expect(action).not.toHaveBeenCalled();
    hold(B);
    expect(withProfileTransferProcessSnapshots([A, B, A], action)).toBe("validated");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("rechecks every captured lease even if the caller mutates its ids or reacquires a member", () => {
    hold(A); const releaseB = hold(B);
    const ids = [A, B];
    let output = "";
    const command = sample(() => output);
    expect(() => withProfileTransferProcessSnapshots(ids, () => {
      expect(find(A)).toBeNull();
      ids.splice(1);
      releaseB(); hold(B);
      output = chromium(A, 100);
    })).toThrow(/lease is not owned/);
    expect(find(A)?.pid).toBe(100);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("suspends both the group and a nested single slice for Firefox's second sentinel sample", () => {
    [A, B].forEach(hold);
    const sentinel = path.join(directory(A), ".parentlock");
    fs.writeFileSync(sentinel, "");
    let observations = 0;
    const command = sample(() => ++observations === 1 ? "" : `300 /synthetic/firefox -profile "${directory(A)}"`);
    withProfileTransferProcessSnapshots([A, B], () => {
      expect(() => withProfileTransferProcessSnapshot(A, () => assertProfileTransferStopped(
        A, () => status(A), undefined, { engine: "firefox" },
      ))).toThrow(expect.objectContaining({ code: "PROFILE_STOP_REQUIRED" }));
      expect(find(A)).toBeNull(); // Restore the first group observation, not the second sample.
      expect(find(B)).toBeNull();
      expect(command).toHaveBeenCalledTimes(2);
    });
    expect(fs.readFileSync(sentinel)).toEqual(Buffer.alloc(0));
    withProfileTransferProcessSnapshots([A, B], () => expect(find(A)?.pid).toBe(300));
    expect(command).toHaveBeenCalledTimes(3);
  });
});
