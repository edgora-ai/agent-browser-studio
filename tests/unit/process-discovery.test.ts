import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const fixture = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-discovery-owned-")) };
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
import { assertProfileTransferStopped } from "../../src/main/services/profile-restore-lock.js";

afterAll(() => {
  if (path.dirname(fixture.root) !== os.tmpdir() || !path.basename(fixture.root).startsWith("agent-browser-discovery-owned-")) throw new Error("Unsafe discovery fixture cleanup");
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe("process-discovery", () => {
  const expectedDir = path.join(getProfilesDir(), "ab_test123");
  const expectedResolved = path.resolve(expectedDir);

  beforeEach(() => {
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
});
