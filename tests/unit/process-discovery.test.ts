import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const fixture = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-discovery-owned-")));
  fs.chmodSync(root, 0o700);
  return { root, owner: fs.lstatSync(root) };
});
// Discovery providers below are injected. Any accidental native command or
// protocol connection must fail, not inspect the host or contact a browser.
vi.mock("node:child_process", () => {
  const blocked = () => { throw new Error("Unfenced native command in owned discovery fixture"); };
  return { exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, spawn: blocked, spawnSync: blocked, fork: blocked };
});
vi.mock("ws", () => {
  const blocked = () => { throw new Error("Unfenced WebSocket in owned discovery fixture"); };
  return { default: blocked, WebSocket: blocked, WebSocketServer: blocked };
});
const TEST_USER_DATA = fixture.root;
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => name === "home" ? path.join(fixture.root, "home") : fixture.root,
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  parseBrowserProcessLine,
  findBrowserByProfileSync,
  inspectBrowserLaunchesSync,
  __setProcessDiscoveryExecForTest,
  __resetProcessDiscoveryExecForTest,
} from "../../src/main/services/process-discovery.js";
import { getProfilesDir } from "../../src/main/services/config-manager.js";
import { statusBrowser } from "../../src/main/services/browser/lifecycle.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";
import { acquireRestoreLock, assertProfileTransferStopped, isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";
import { cdpCookieService } from "../../src/main/services/cdp-cookie-service.js";
import { captureFullProfile, prepareFullProfile, type CaptureFullProfileOptions } from "../../src/main/services/sync/full-profile-artifact.js";

function assertFixtureOwner(): void {
  const current = fs.lstatSync(fixture.root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== fixture.owner.dev || current.ino !== fixture.owner.ino ||
      path.dirname(fixture.root) !== fs.realpathSync(os.tmpdir()) || !path.basename(fixture.root).startsWith("agent-browser-discovery-owned-")) {
    throw new Error("Owned discovery fixture changed");
  }
}
afterAll(() => {
  assertFixtureOwner();
  fs.rmSync(fixture.root, { recursive: true });
});

describe("process-discovery", () => {
  const expectedDir = path.join(getProfilesDir(), "ab_test123");
  const expectedResolved = path.resolve(expectedDir);

  beforeEach(() => {
    assertFixtureOwner();
    runningProcesses.clear();
    for (const name of fs.readdirSync(fixture.root)) fs.rmSync(path.join(fixture.root, name), { recursive: true, force: true });
    vi.spyOn(process, "kill").mockReturnValue(true);
    __setProcessDiscoveryExecForTest({ execFileSync: (() => { throw new Error("Unfenced synthetic discovery command"); }) as any });
  });
  afterEach(() => {
    runningProcesses.clear();
    __resetProcessDiscoveryExecForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    assertFixtureOwner();
  });

  it("parses chromium ps lines with --user-data-dir and --remote-debugging-port", () => {
    const line = `12345 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=${expectedResolved} --remote-debugging-port=9222 --flag`;
    expect(parseBrowserProcessLine(line, expectedDir)).toEqual({ pid: 12345, cdpPort: 9222 });
  });

  it("parses firefox -profile lines", () => {
    const line = `9876 /Applications/Firefox.app/Contents/MacOS/firefox -profile ${expectedResolved} --remote-debugging-port 9223`;
    expect(parseBrowserProcessLine(line, expectedDir)).toEqual({ pid: 9876, cdpPort: 9223 });
  });

  it("returns null when cdp port is missing or profile dir mismatches", () => {
    expect(parseBrowserProcessLine(`100 /bin/chrome --user-data-dir=${expectedResolved}`, expectedDir)).toBeNull();
    expect(parseBrowserProcessLine(`100 /bin/chrome --user-data-dir=/tmp/other --remote-debugging-port=9222`, expectedDir)).toBeNull();
  });

  it("strict production discovery -> lifecycle -> transfer gate does not convert two provider failures into stopped", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const command = vi.fn(() => { throw Object.assign(new Error("Synthetic process table unavailable"), { code: "EACCES" }); });
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    expect(() => findBrowserByProfileSync("ab_test123", expectedDir, { strict: true })).toThrow(/discovery unavailable/i);
    expect(command.mock.calls).toHaveLength(2);
    expect(() => inspectBrowserLaunchesSync(expectedDir, undefined, { strict: true })).toThrow(/discovery unavailable/i);
    expect(() => inspectBrowserLaunchesSync(expectedDir)).not.toThrow(); // ordinary rich inspection still degrades
    expect(findBrowserByProfileSync("ab_test123", expectedDir)).toBeNull(); // legacy degradation unchanged
    expect(statusBrowser("ab_test123")).toEqual({ running: false, pid: null, cdpPort: null, unknown: true });
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).toThrow(/not confirmed stopped/);
    expect(fs.readdirSync(fixture.root)).toEqual([]);
  });

  it("preserves successful ps fallback discovery and the healthy running status shape", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const command = vi.fn((_cmd: string, args: string[]) => {
      if (args[1] === "pid,args") throw new Error("Synthetic primary unavailable");
      return `55123 /owned/chromium --user-data-dir=${expectedResolved} --remote-debugging-port=55124\n`;
    });
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    expect(findBrowserByProfileSync("ab_test123", expectedDir, { strict: true })).toEqual({ pid: 55123, cdpPort: 55124 });
    expect(statusBrowser("ab_test123")).toEqual({ running: true, pid: 55123, cdpPort: 55124 });
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).toThrow(/not confirmed stopped/);
  });

  it.each([
    { engine: "chromium", endpoint: "" }, { engine: "chromium", endpoint: " --remote-debugging-port=0" },
    { engine: "firefox", endpoint: "" }, { engine: "firefox", endpoint: " --remote-debugging-port 0" },
  ])("strict production status refuses transfer for live $engine with endpoint '$endpoint' without adoption", ({ engine, endpoint }) => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const profileArg = engine === "firefox" ? `-profile ${expectedResolved}` : `--user-data-dir=${expectedResolved}`;
    __setProcessDiscoveryExecForTest({ execFileSync: (() => `59123 /owned/${engine} ${profileArg}${endpoint}\n`) as any });
    expect(findBrowserByProfileSync("ab_test123", expectedDir)).toBeNull(); // legacy endpoint lookup unchanged
    expect(findBrowserByProfileSync("ab_test123", expectedDir, { strict: true })).toEqual({ pid: 59123, cdpPort: 0, unknown: true });
    expect(statusBrowser("ab_test123")).toEqual({ running: true, pid: 59123, cdpPort: null, unknown: true });
    expect(runningProcesses.has("ab_test123")).toBe(false);
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).toThrow(/not confirmed stopped/);
    expect(runningProcesses.has("ab_test123")).toBe(false);
  });

  it("ambiguous strict ownership remains unknown and is not adopted as a managed runtime", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    __setProcessDiscoveryExecForTest({ execFileSync: (() => [
      `59201 /owned/chromium --user-data-dir=${expectedResolved} --remote-debugging-port=59211`,
      `59202 /owned/chromium --user-data-dir=${expectedResolved} --remote-debugging-port=59212`,
    ].join("\n")) as any });
    expect(statusBrowser("ab_test123")).toEqual({ running: true, pid: 59201, cdpPort: 59211, unknown: true });
    expect(runningProcesses.has("ab_test123")).toBe(false);
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).toThrow(/not confirmed stopped/);
  });

  it("strict rich launch inspection preserves fallback evidence, candidate ordering and tracked selection", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const command = vi.fn((_cmd: string, args: string[]) => {
      if (args[1] === "pid,args") throw new Error("Synthetic primary unavailable");
      return [
        `601 /owned/chromium --user-data-dir=${expectedResolved} --remote-debugging-port=56001`,
        `602 /owned/chromium --user-data-dir=${expectedResolved} --remote-debugging-port=56002`,
        `603 /owned/chromium --user-data-dir=${expectedResolved} --remote-debugging-port=56003 --type=renderer`,
      ].join("\n");
    });
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    const strict = inspectBrowserLaunchesSync(expectedDir, 602, { strict: true });
    expect(strict.available).toBe(true); expect(strict.candidates.map((entry) => entry.pid)).toEqual([601, 602]);
    expect(strict.tracked).toMatchObject({ pid: 602, engine: "chromium", cdpPorts: [56002], malformed: false });
    expect(inspectBrowserLaunchesSync(expectedDir, 602)).toEqual(strict);
  });

  it("a successful empty primary listing remains confirmed stopped, not unknown", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const command = vi.fn(() => "");
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    expect(statusBrowser("ab_test123")).toEqual({ running: false, pid: null, cdpPort: null });
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).not.toThrow();
    expect(command.mock.calls.every((call: any[]) => call[1][1] === "pid,args")).toBe(true);
  });

  it.each([".parentlock", "parent.lock"])("actual strict stopped discovery permits only unchanged empty regular Firefox %s without deletion", (name) => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    fs.mkdirSync(expectedDir, { recursive: true });
    const marker = path.join(expectedDir, name); fs.writeFileSync(marker, "", { mode: 0o600 });
    const before = fs.lstatSync(marker), command = vi.fn(() => "");
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"), undefined, { engine: "firefox" })).not.toThrow();
    expect(command).toHaveBeenCalledTimes(2);
    const after = fs.lstatSync(marker);
    expect(fs.readFileSync(marker)).toEqual(Buffer.alloc(0));
    expect([after.dev, after.ino, after.nlink, after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.dev, before.ino, before.nlink, before.size, before.mtimeMs, before.ctimeMs]);
  });

  it.each([
    { engine: "firefox", endpoint: "" }, { engine: "firefox", endpoint: " --remote-debugging-port 0" },
    { engine: "chromium", endpoint: "" }, { engine: "chromium", endpoint: " --remote-debugging-port=0" },
  ])("refuses an inert Firefox sentinel when a $engine no-port/port0 owner appears between strict checks", ({ engine, endpoint }) => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    fs.mkdirSync(expectedDir, { recursive: true });
    const marker = path.join(expectedDir, ".parentlock"); fs.writeFileSync(marker, "", { mode: 0o600 });
    const before = fs.lstatSync(marker); let calls = 0;
    const profileArg = engine === "firefox" ? `-profile ${expectedResolved}` : `--user-data-dir=${expectedResolved}`;
    __setProcessDiscoveryExecForTest({ execFileSync: (() => ++calls === 1 ? "" : `59301 /owned/${engine} ${profileArg}${endpoint}\n`) as any });
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"), undefined, { engine: "firefox" })).toThrow(/not confirmed stopped/);
    expect(calls).toBe(2); expect(runningProcesses.has("ab_test123")).toBe(false);
    expect(fs.readFileSync(marker)).toEqual(Buffer.alloc(0)); expect(fs.lstatSync(marker).ino).toBe(before.ino);
  });

  it("strict Windows failures become unknown while ordinary tasklist fallback remains available", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const command = vi.fn(() => { throw new Error("Synthetic provider unavailable"); });
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    expect(statusBrowser("ab_test123")).toEqual({ running: false, pid: null, cdpPort: null, unknown: true });
    expect(command.mock.calls.map((call: any[]) => call[0])).toEqual(["wmic", "powershell.exe"]);
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).toThrow(/not confirmed stopped/);
    command.mockClear();
    expect(findBrowserByProfileSync("ab_test123", expectedDir)).toBeNull();
    expect(command.mock.calls.map((call: any[]) => call[0])).toEqual(["wmic", "tasklist", "powershell.exe"]);
  });

  it.each([false, true])("strict Windows CIM fallback succeeds without inventing unavailable (found=%s)", (found) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const command = vi.fn((cmd: string) => {
      if (cmd === "wmic") throw new Error("Synthetic WMIC unavailable");
      if (cmd === "powershell.exe") return JSON.stringify(found ? [{ ProcessId: 56123, CommandLine: `/owned/chromium --user-data-dir=${expectedResolved} --remote-debugging-port=56124` }] : []);
      throw new Error("Lossy provider must not be used by authoritative absence checks");
    });
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    expect(statusBrowser("ab_test123")).toEqual(found ? { running: true, pid: 56123, cdpPort: 56124 } : { running: false, pid: null, cdpPort: null });
    expect(command.mock.calls.map((call) => call[0])).toEqual(["wmic", "powershell.exe"]);
    if (found) expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).toThrow(/not confirmed stopped/);
    else expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).not.toThrow();
  });

  it("a successful empty Windows command-line listing remains stopped", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const command = vi.fn((cmd: string) => { if (cmd !== "wmic") throw new Error("Unexpected fallback"); return "Node,CommandLine,ProcessId\n"; });
    __setProcessDiscoveryExecForTest({ execFileSync: command as any });
    expect(statusBrowser("ab_test123")).toEqual({ running: false, pid: null, cdpPort: null });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it.each(["EPERM", "EIO", "EINVAL", undefined])("preserves cached PID/bridge on non-exit kill(0) error %s and refuses transfer", (code) => {
    const close = vi.fn(async () => undefined);
    const entry = { pid: 57123, process: null, port: 57124, lastActivityAt: 1, proxyBridge: { close } } as any;
    runningProcesses.set("ab_test123", entry);
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("Synthetic liveness failure"), { code }); });
    expect(statusBrowser("ab_test123")).toEqual({ running: true, pid: 57123, cdpPort: 57124, unknown: true });
    expect(runningProcesses.get("ab_test123")).toBe(entry); expect(close).not.toHaveBeenCalled();
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).toThrow(/not confirmed stopped/);
    expect(runningProcesses.get("ab_test123")).toBe(entry); expect(close).not.toHaveBeenCalled();
  });

  it("drops cached ownership and closes its bridge only on ESRCH, then requires successful discovery", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const close = vi.fn(async () => undefined);
    runningProcesses.set("ab_test123", { pid: 58123, process: null, port: 58124, lastActivityAt: 1, proxyBridge: { close } } as any);
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("Synthetic exited process"), { code: "ESRCH" }); });
    __setProcessDiscoveryExecForTest({ execFileSync: (() => "") as any });
    expect(statusBrowser("ab_test123")).toEqual({ running: false, pid: null, cdpPort: null });
    expect(runningProcesses.has("ab_test123")).toBe(false); expect(close).toHaveBeenCalledTimes(1);
    expect(() => assertProfileTransferStopped("ab_test123", () => statusBrowser("ab_test123"))).not.toThrow();
  });

  it("findBrowserByProfileSync uses injected execFileSync stub (Windows WMIC/tasklist parity)", () => {
    const stub = vi.fn((cmd: string, args: string[], _opts: any) => {
      if (cmd === "ps") return `111 ${expectedResolved} --user-data-dir=${expectedResolved} --remote-debugging-port=5555\n`;
      if (cmd === "wmic") return `Node,CommandLine,ProcessId\nHOST,"/bin/chrome --user-data-dir=${expectedResolved} --remote-debugging-port=5556",222\n`;
      return "";
    });
    // ps path (darwin/linux)
    __setProcessDiscoveryExecForTest({ execFileSync: stub as any });
    vi.stubGlobal("process", { ...process, platform: "linux" } as any);
    expect(findBrowserByProfileSync("ab_test123", expectedDir)).toEqual({ pid: 111, cdpPort: 5555 });

    // WMIC path (windows)
    vi.stubGlobal("process", { ...process, platform: "win32" } as any);
    expect(findBrowserByProfileSync("ab_test123", expectedDir)).toEqual({ pid: 222, cdpPort: 5556 });
    expect(stub).toHaveBeenCalled();
  });

  describe("owned-guard-cost: actual cold transfer gate with injected providers", () => {
    const CHUNK = 64 * 1024, turns = new Set<ReturnType<typeof setImmediate>>();
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    function nextOwnedTurn(action: () => void): void {
      const turn = setImmediate(() => { turns.delete(turn); action(); }); turns.add(turn);
    }
    function coldProfile(size: number) {
      const id = "ab_guard_cost_" + size, directory = path.join(getProfilesDir(), id), stage = path.join(fixture.root, "stage-" + size);
      for (const root of [directory, stage]) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const bytes = Buffer.alloc(size, 0x61), marker = Buffer.from("owned-guard-cost=searchable-byte-readback");
      if (size > CHUNK) marker.copy(bytes, 3 * CHUNK);
      const file = path.join(directory, "state.bin"); fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      return { id, directory, stage, bytes, marker, file };
    }
    function observeOwnedIO(source: string, onFirstRead: () => void) {
      const open = fsMutable.openSync, read = fsMutable.readSync, close = fsMutable.closeSync;
      const fds = new Map<number, number>(), buffers: Buffer[] = [], chunks: Array<{ position: number; bytes: number }> = [];
      let serial = 0, selected: number | undefined, opened = 0, closed = 0;
      const openSpy = vi.spyOn(fsMutable, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
        if (typeof args[0] !== "string" || !path.resolve(args[0]).startsWith(fixture.root + path.sep)) throw new Error("Foreign open refused in owned guard fixture");
        const fd = open(...args), current = ++serial; fds.set(fd, current); opened++;
        const readOnly = typeof args[1] === "number" ? (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0 : args[1] === "r";
        if (selected === undefined && args[0] === source && readOnly) selected = current;
        return fd;
      }) as typeof open);
      const readSpy = vi.spyOn(fsMutable, "readSync").mockImplementation(((...args: any[]) => {
        const count = Reflect.apply(read, fsMutable, args);
        if (fds.get(args[0]) === selected && selected !== undefined && count > 0) {
          chunks.push({ position: args[4], bytes: count }); buffers.push(args[1]);
          if (chunks.length === 1) onFirstRead();
        }
        return count;
      }) as typeof read);
      const closeSpy = vi.spyOn(fsMutable, "closeSync").mockImplementation(fd => { close(fd); if (fds.delete(fd)) closed++; });
      syncBuiltinESMExports();
      return { chunks, assertClosed() {
        expect(opened).toBeGreaterThan(0); expect(closed).toBe(opened); expect(fds.size).toBe(0);
        for (const buffer of buffers) expect(buffer.every(byte => byte === 0)).toBe(true);
      }, restore() { openSpy.mockRestore(); readSpy.mockRestore(); closeSpy.mockRestore(); syncBuiltinESMExports(); } };
    }
    function stoppedGate(id: string, unavailable: () => boolean = () => false) {
      const providers: string[] = []; let guards = 0;
      __setProcessDiscoveryExecForTest({ execFileSync: ((command: string, args: string[]) => {
        if (!["ps", "wmic", "tasklist", "powershell.exe"].includes(command) || !Array.isArray(args)) throw new Error("Unexpected synthetic provider");
        providers.push(command);
        if (unavailable()) throw Object.assign(new Error("Synthetic process table unavailable"), { code: "EACCES" });
        return command === "wmic" ? "Node,CommandLine,ProcessId\n" : command === "powershell.exe" ? "[]" : "";
      }) as any });
      const guard = () => {
        guards++;
        // The production runtime branch, not a cheap vi.fn or a cached stopped
        // conclusion. Its providers are synthetic; this is NOT native ps timing.
        assertProfileTransferStopped(id, () => statusBrowser(id), () => cdpCookieService.hasRunningChrome(id), { engine: "chromium" });
      };
      return { guard, providers, get guards() { return guards; } };
    }
    function options(f: ReturnType<typeof coldProfile>, guard: () => void, signal?: AbortSignal): CaptureFullProfileOptions {
      return { profileDir: f.directory, stagingDir: f.stage, dirId: f.id, engine: "chromium", snapshotId: "owned-guard-cost-snapshot",
        passphrase: "owned guard cost migration phrase", sourcePlatform: process.platform, guard, signal };
    }
    beforeEach(() => vi.stubGlobal("fetch", () => { throw new Error("Unfenced network in owned guard fixture"); }));
    afterEach(() => { for (const turn of turns) clearImmediate(turn); turns.clear(); });

    it("measures provider repetition for 1B and 262161B without inventing a UI latency budget", async () => {
      const measurements: Array<{ bytes: number; guards: number; providers: number; commands: Record<string, number>; firstScanChunks: number; firstTurnChunks: number; heartbeatTicks: number; maxHeartbeatGapMs: number; elapsedMs: number }> = [];
      for (const size of [1, 4 * CHUNK + 17]) {
        const f = coldProfile(size), gate = stoppedGate(f.id); let firstTurnChunks = 0;
        const io = observeOwnedIO(f.file, () => nextOwnedTurn(() => { firstTurnChunks = io.chunks.length; }));
        const release = acquireRestoreLock(f.id), started = performance.now();
        let lastBeat = started, maxGap = 0, heartbeatTicks = 0, timer: ReturnType<typeof setTimeout>;
        const beat = () => { const now = performance.now(); maxGap = Math.max(maxGap, now - lastBeat); lastBeat = now; heartbeatTicks++; timer = setTimeout(beat, 0); };
        timer = setTimeout(beat, 0);
        try {
          const bundle = await captureFullProfile(options(f, gate.guard)), ended = performance.now();
          clearTimeout(timer); maxGap = Math.max(maxGap, ended - lastBeat);
          const providers = gate.providers.length, guards = gate.guards;
          expect(providers).toBe(guards * (process.platform === "win32" ? 4 : 2));
          expect(firstTurnChunks).toBe(1); expect(io.chunks).toHaveLength(Math.ceil(size / CHUNK));
          measurements.push({ bytes: size, guards, providers, commands: gate.providers.reduce<Record<string, number>>((counts, command) => { counts[command] = (counts[command] || 0) + 1; return counts; }, {}),
            firstScanChunks: io.chunks.length, firstTurnChunks, heartbeatTicks, maxHeartbeatGapMs: Number(maxGap.toFixed(3)), elapsedMs: Number((ended - started).toFixed(3)) });
          expect(bundle.descriptor.sha256).toBe(sha(bundle.body)); expect(bundle.descriptor.size).toBe(bundle.body.length);
          const prepared = await prepareFullProfile({ ...options(f, gate.guard), ...bundle });
          const member = prepared.manifest.files.find(item => item.path === "state.bin");
          expect(member).toMatchObject({ size, sha256: sha(f.bytes) });
          const readback = fs.readFileSync(path.join(prepared.directory, "state.bin"));
          expect(readback).toEqual(f.bytes); if (size > CHUNK) expect(readback.includes(f.marker)).toBe(true);
          expect(fs.readFileSync(f.file)).toEqual(f.bytes); expect(runningProcesses.size).toBe(0); expect(isRestoreLocked(f.id)).toBe(true);
        } finally { clearTimeout(timer); try { release(); io.assertClosed(); } finally { io.restore(); } }
        expect(isRestoreLocked(f.id)).toBe(false);
      }
      expect(measurements[1].guards).toBeGreaterThan(measurements[0].guards);
      expect(measurements[1].providers).toBeGreaterThan(measurements[0].providers);
      console.info("owned-guard-cost " + JSON.stringify({ scope: "runtime-guard branch; injected providers, no native process timings or UI budget", platform: process.platform, measurements }));
    });

    it.each(["cancel", "unknown"] as const)("rechecks %s after the first cooperative source chunk while retaining caller ownership", async mode => {
      const f = coldProfile(4 * CHUNK + 17), controller = new AbortController(); let unavailable = false, readsAtChange = 0;
      const gate = stoppedGate(f.id, () => unavailable);
      const io = observeOwnedIO(f.file, () => nextOwnedTurn(() => { readsAtChange = io.chunks.length; if (mode === "cancel") controller.abort(); else unavailable = true; }));
      const release = acquireRestoreLock(f.id);
      try {
        await expect(captureFullProfile(options(f, gate.guard, controller.signal))).rejects.toMatchObject({ code: mode === "cancel" ? "ABORT_ERR" : "PROFILE_STOP_REQUIRED" });
        expect(readsAtChange).toBe(1); expect(io.chunks).toEqual([{ position: 0, bytes: CHUNK }]);
        expect(fs.readdirSync(f.stage)).toEqual([]); expect(fs.readFileSync(f.file)).toEqual(f.bytes);
        expect(sha(fs.readFileSync(f.file))).toBe(sha(f.bytes)); expect(fs.readFileSync(f.file).includes(f.marker)).toBe(true);
        expect(isRestoreLocked(f.id)).toBe(true); expect(runningProcesses.size).toBe(0);
      } finally { try { release(); io.assertClosed(); } finally { io.restore(); } }
      expect(isRestoreLocked(f.id)).toBe(false);
    });
  });
});
