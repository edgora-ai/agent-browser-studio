// J45: independent Chromium lifecycle gates — exact installed version pins,
// retained rollback build selection, and a real-host pass-through identity.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { evaluateInPage, getBrowserVersion, waitForCdpPort, waitForPortClosed } from "./helpers/cdp.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j45");

interface LaunchResult { success: boolean; pid: number; cdpPort: number; error?: string }

describe("J45 — exact Chromium pin, rollback and pass-through", () => {
  let h: TestAppHandle;
  let versions: string[] = [];

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, allowProfileVersionSelection: true });
    const status = await h.page.evaluate(async () => (window as any).cloak.api.cloak.binary());
    versions = (status.installedVersions || []).map((entry: { version: string }) => entry.version);
    expect(versions.length, "No independent managed Chromium build is installed").toBeGreaterThan(0);
  }, 60_000);

  afterAll(async () => {
    if (h) await closeApp(h);
  }, 90_000);

  async function createAndLaunch(options: Record<string, unknown>): Promise<{ dirId: string; launch: LaunchResult }> {
    const created = await h.page.evaluate(async (profile) => (window as any).cloak.api.cloak.create(profile), options) as { dirId: string };
    const launch = await h.page.evaluate(async (dirId: string) => (window as any).cloak.api.cloak.launch(dirId), created.dirId) as LaunchResult;
    expect(launch.success, launch.error || "profile launch failed").toBe(true);
    h.cdpPids.push(launch.pid);
    await waitForCdpPort(launch.cdpPort, 15_000);
    return { dirId: created.dirId, launch };
  }

  async function stop(dirId: string, port: number): Promise<void> {
    await h.page.evaluate(async (id: string) => (window as any).cloak.api.cloak.stop(id), dirId);
    await waitForPortClosed(port, 10_000);
  }

  it("launches a pinned build with native host identity in pass-through mode", async () => {
    const pinned = versions[versions.length - 1];
    const { dirId, launch } = await createAndLaunch({
      name: "J45 pass-through",
      fingerprintMode: "off",
      browserVersion: pinned,
      platform: "windows",
      locale: "en-US",
      timezone: "America/New_York",
      fingerprintSeed: 45451,
      proxyMode: "none",
    });
    const listed = await h.page.evaluate(async (id: string) => {
      const profiles = await (window as any).cloak.api.cloak.list();
      return profiles.find((profile: any) => profile.dirId === id);
    }, dirId);
    expect(listed.fingerprintMode).toBe("off");
    expect(listed.browserVersion).toBe(pinned);

    const browser = await getBrowserVersion(launch.cdpPort);
    expect(browser.browser).toContain(pinned);
    const platform = await evaluateInPage<string>(launch.cdpPort, "navigator.platform");
    const ua = await evaluateInPage<string>(launch.cdpPort, "navigator.userAgent");
    const webdriver = await evaluateInPage<boolean>(launch.cdpPort, "navigator.webdriver");
    const timezone = await evaluateInPage<string>(launch.cdpPort, "Intl.DateTimeFormat().resolvedOptions().timeZone");
    expect(platform).toBe(process.platform === "darwin" ? "MacIntel" : process.platform === "win32" ? "Win32" : "Linux x86_64");
    if (process.platform === "darwin") expect(ua).not.toContain("Windows NT");
    expect(webdriver).toBe(false);
    expect(timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    await stop(dirId, launch.cdpPort);
  }, 45_000);

  it("selects the newest exact build and can roll back to the retained prior build", async () => {
    if (versions.length < 2) return;
    const newest = versions[0];
    const previous = versions[versions.length - 1];

    for (const [label, version, seed] of [["newest", newest, 45452], ["rollback", previous, 45453]] as const) {
      const { dirId, launch } = await createAndLaunch({
        name: `J45 ${label}`,
        fingerprintMode: "managed",
        browserVersion: version,
        platform: "windows",
        fingerprintSeed: seed,
        proxyMode: "none",
      });
      const browser = await getBrowserVersion(launch.cdpPort);
      expect(browser.browser, `${label} selected wrong build`).toContain(version);
      expect(await evaluateInPage<string>(launch.cdpPort, "navigator.platform")).toBe("Win32");
      await stop(dirId, launch.cdpPort);
    }
  }, 90_000);

  it("has no unexpected app errors", () => {
    const errors = filterKnownConsoleErrors(h.consoleErrors).filter((error: string) =>
      !/file is not a database|connect to 127\.0\.0\.1 port 1/i.test(error));
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
