import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-discovery-test");
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  parseBrowserProcessLine,
  findBrowserByProfileSync,
  __setProcessDiscoveryExecForTest,
  __resetProcessDiscoveryExecForTest,
} from "../../src/main/services/process-discovery.js";
import { getProfilesDir } from "../../src/main/services/config-manager.js";

describe("process-discovery", () => {
  const expectedDir = path.join(getProfilesDir(), "ab_test123");
  const expectedResolved = path.resolve(expectedDir);

  afterEach(() => {
    __resetProcessDiscoveryExecForTest();
    vi.unstubAllGlobals();
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
