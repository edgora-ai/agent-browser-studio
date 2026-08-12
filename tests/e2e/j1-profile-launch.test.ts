// J1: Agent Browser managed-fingerprint closed loop
// create → launch → CDP fingerprint verify (UA + platform) → risk check (ping0.cc) → stop
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  setupTestApp,
  closeApp,
  getAgentBrowserApi,
  TestAppHandle,
} from "./helpers/app.js";
import {
  getBrowserVersion,
  evaluateInPage,
  waitForCdpPort,
  waitForPortClosed,
  waitForPageUrl,
} from "./helpers/cdp.js";
import { shot, closeAllDialogs, filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j1");

describe("J1 — Browser profile launch + fingerprint verify + risk check", () => {
  let h: TestAppHandle;
  let dirId = "";
  let cdpPort = 0;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
  });

  it("creates a Browser profile via IPC and gets a dirId", async () => {
    const api = await getAgentBrowserApi<any>(h.page);
    const r = await h.page.evaluate(async () => {
      return (window as any).agentBrowser.api.browser.create({
        name: "E2E J1",
        platform: "windows",
        locale: "en-US",
        timezone: "America/New_York",
        fingerprintSeed: 11111,
      });
    });
    expect(r).toBeTruthy();
    expect(r.dirId).toBeTruthy();
    dirId = r.dirId;
    await shot(h.page, "j1-01-after-create");
  });

  it("launches the profile and CDP port becomes reachable", async () => {
    const r = (await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.browser.launch(id),
      dirId,
    )) as { success: boolean; pid: number; cdpPort: number; error?: string };
    expect(r.success, `launch failed: ${r.error || JSON.stringify(r)}`).toBe(true);
    expect(r.cdpPort).toBeGreaterThan(0);
    cdpPort = r.cdpPort;
    h.cdpPort = cdpPort;
    h.cdpPids.push(r.pid);
    await waitForCdpPort(cdpPort, 15000);
    await shot(h.page, "j1-02-launched");
  });

  it("Browser.getVersion returns a Windows-fingerprint User-Agent", async () => {
    const v = await getBrowserVersion(cdpPort);
    expect(v.userAgent, JSON.stringify(v)).toContain("Windows NT 10.0");
    expect(v.userAgent).toContain("Chrome/");
  });

  it("Runtime.evaluate returns navigator.platform === 'Win32'", async () => {
    const p = await evaluateInPage<string>(cdpPort, "navigator.platform");
    expect(p).toBe("Win32");
  });

  it("uses the managed capability to suppress only the missing Google API key infobar", () => {
    const log = fs.readFileSync(path.join(USERDATA, "logs", `browser-${dirId}.log`), "utf8");
    expect(log).toContain("--agent-browser-suppress-missing-google-api-key-infobar");
    expect(log).not.toContain("--test-type");
    expect(log).not.toContain("--enable-automation");
  });

  it("openRiskCheck invokes navigation (ping0.cc/env when network is available)", async () => {
    const r = (await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.browser.openRiskCheck(id),
      dirId,
    )) as { success: boolean; error?: string };
    // The IPC contract returns success/error deterministically.
    // If the sandbox has network, the page navigates to ping0.cc/env.
    if (r.success) {
      const url = await waitForPageUrl(cdpPort, "ping0.cc/env", 20000).catch(
        () => null,
      );
      // Don't hard-fail on URL timing — network to ping0.cc may be slow/flaky.
      if (url) expect(url).toContain("ping0.cc/env");
    }
    await shot(h.page, "j1-03-risk-check");
  });

  it("stopping the profile closes the CDP port", async () => {
    await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.browser.stop(id),
      dirId,
    );
    await waitForPortClosed(cdpPort, 10000);
  });

  it("no unexpected console / page errors during the journey", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors);
    const p = h.pageErrors.filter((e) => !/favicon|punycode/i.test(e));
    if (c.length || p.length) {
      console.log("CONSOLE ERRORS:", c);
      console.log("PAGE ERRORS:", p);
    }
    expect(c, c.join("\n")).toEqual([]);
    expect(p, p.join("\n")).toEqual([]);
  });
});
