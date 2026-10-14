// F06: the real Electron IPC must stop profile creation at the trial cap
// without stopping an existing managed browser profile. No external navigation.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupTestApp, closeApp, resolveManagedChromiumPath, type TestAppHandle } from "./helpers/app.js";
import { connectPageCdp, isPortListening, listTargets, waitForCdpPort, waitForPageUrl, waitForPortClosed } from "./helpers/cdp.js";

// Only the explicit browser fixture paths are read from the parent environment.
// Resolve a cache fixture to its binary before launch so the child still gets
// an isolated cache, never the host's cache root or any provider credentials.
const MANAGED_CHROMIUM_FIXTURE: NodeJS.ProcessEnv = {
  AGENT_BROWSER_CHROMIUM_BINARY_PATH: process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH,
  CLOAKLITE_CHROMIUM_BINARY_PATH: process.env.CLOAKLITE_CHROMIUM_BINARY_PATH,
  AGENT_BROWSER_CHROMIUM_CACHE_DIR: process.env.AGENT_BROWSER_CHROMIUM_CACHE_DIR,
  CLOAKLITE_CHROMIUM_CACHE_DIR: process.env.CLOAKLITE_CHROMIUM_CACHE_DIR,
};
// Discover an existing read-only managed installation, never download an engine.
const INSTALLED_BINARY = resolveManagedChromiumPath(MANAGED_CHROMIUM_FIXTURE);
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-f06-license-e2e-"));
const SCREENSHOT = process.env.F06_SCREENSHOT_PATH
  ? path.resolve(process.env.F06_SCREENSHOT_PATH)
  : path.join(os.tmpdir(), `studio-f06-license-window-${process.pid}.png`);
const diskConfig = () => JSON.parse(fs.readFileSync(path.join(USERDATA, "config.json"), "utf8"));
const profileDirectory = (id: string) => path.join(USERDATA, "profiles", id);

describe("F06 — profile quota does not block existing launch", () => {
  let h: TestAppHandle;
  let launchedId = "";
  let cdpPort = 0;
  const launchedPorts = new Set<number>();

  async function waitForStopped(pid: number, port: number): Promise<void> {
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(async () => {
      expect(await isPortListening(port), `CDP port ${port} still listening`).toBe(false);
      let exitCode: string | undefined;
      try {
        process.kill(pid, 0);
      } catch (error) {
        exitCode = (error as NodeJS.ErrnoException).code;
        // Permission denied does not mean the process exited.
        if (exitCode !== "ESRCH") throw error;
      }
      expect(exitCode, `Chromium PID ${pid} still alive`).toBe("ESRCH");
      const status = await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.status(id), launchedId);
      expect(status.running).toBe(false);
    }, { timeout: 20_000, interval: 100 });
  }

  beforeAll(async () => {
    if (!INSTALLED_BINARY || !fs.statSync(INSTALLED_BINARY).isFile()) {
      throw new Error("F06 requires an existing managed Chromium installation; no engine was downloaded");
    }
    h = await setupTestApp({
      userDataDir: USERDATA,
      env: { AGENT_BROWSER_CHROMIUM_BINARY_PATH: INSTALLED_BINARY },
    });
    const isolation = await h.app.evaluate(({ app }) => ({
      nodeHome: process.getBuiltinModule("node:os").homedir(),
      envHome: process.env.HOME,
      userData: app.getPath("userData"),
      chromiumCache: process.env.AGENT_BROWSER_CHROMIUM_CACHE_DIR,
      chromiumBinary: process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH,
      providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(isolation.nodeHome)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(fs.realpathSync(isolation.envHome!)).toBe(fs.realpathSync(isolation.nodeHome));
    expect(fs.realpathSync(isolation.userData)).toBe(fs.realpathSync(USERDATA));
    expect(isolation.chromiumCache).toBe(path.join(USERDATA, "chromium-cache"));
    expect(fs.realpathSync(isolation.chromiumBinary!)).toBe(fs.realpathSync(INSTALLED_BINARY));
    expect(isolation.providerKeys).toEqual([]);
    const llm = await h.page.evaluate(async () => ({
      configured: await (window as any).agentBrowserAPI.agent.llmConfig(),
      detected: await (window as any).agentBrowserAPI.agent.detectLlmConfig(),
    }));
    expect(llm.configured?.hasApiKey ?? false).toBe(false);
    expect(llm.detected?.hasApiKey ?? false).toBe(false);
    const binary = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.binary());
    expect(binary.installed).toBe(true);
    expect(fs.realpathSync(binary.path)).toBe(fs.realpathSync(INSTALLED_BINARY));
  }, 90_000);

  afterAll(async () => {
    try {
      if (h) await closeApp(h);
      // Even on an assertion failure, the test-owned Chromium ports must close.
      for (const port of launchedPorts) await waitForPortClosed(port, 20_000);
    } finally {
      fs.rmSync(USERDATA, { recursive: true, force: true });
    }
  }, 90_000);

  it("writes ten unique profiles, rejects the eleventh, launches and stops the tenth actual browser", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const created = await h.page.evaluate((n: number) => (window as any).agentBrowser.api.browser.create({
        name: `F06 isolated ${n}`,
        platform: "macos",
        fingerprintMode: "off",
        proxyMode: "none",
        ...(n === 9 ? { appUrl: "data:text/html,<title>F06%20local%20fixture</title><h1>F06%20local%20fixture</h1>" } : {}),
      }), i);
      expect(created.success, JSON.stringify(created)).not.toBe(false);
      expect(created.dirId).toEqual(expect.any(String));
      ids.push(created.dirId);
      expect(new Set(ids).size).toBe(i + 1);
      expect(fs.statSync(path.join(profileDirectory(created.dirId), "Default")).isDirectory()).toBe(true);
      const disk = diskConfig();
      expect(Object.keys(disk.browserProfiles).sort()).toEqual([...ids].sort());
      const fromIpc = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
      expect(fromIpc.map((profile: any) => profile.dirId).sort()).toEqual([...ids].sort());
    }
    launchedId = ids[9];
    const configBefore = fs.readFileSync(path.join(USERDATA, "config.json"));
    const rejected = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: "F06 refused eleventh", proxyMode: "none",
    }));
    expect(rejected).toMatchObject({ success: false, code: "PROFILE_LIMIT" });
    expect(fs.readFileSync(path.join(USERDATA, "config.json"))).toEqual(configBefore);
    expect(Object.keys(diskConfig().browserProfiles).sort()).toEqual([...ids].sort());
    const fromIpc = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    expect(fromIpc.map((profile: any) => profile.dirId).sort()).toEqual([...ids].sort());
    const fromProfile = await h.page.evaluate((id) => (window as any).agentBrowser.api.profile.get(id), launchedId);
    expect(fromProfile.dirId).toBe(launchedId);

    const result = await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.launch(id), launchedId) as {
      success: boolean; pid?: number; cdpPort?: number; code?: string; error?: string;
    };
    cdpPort = result.cdpPort || 0;
    if (cdpPort > 0) launchedPorts.add(cdpPort);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    expect(cdpPort).toBeGreaterThan(0);
    await waitForCdpPort(cdpPort, 20_000);
    process.kill(result.pid!, 0);
    const running = await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.status(id), launchedId);
    expect(running).toMatchObject({ running: true, pid: result.pid, cdpPort });
    // The managed Chromium CDP page endpoint is the app's supported control
    // surface. The browser-level Playwright connection previously opened its
    // WebSocket but timed out before completing its handshake.
    const fixtureUrl = await waitForPageUrl(cdpPort, "data:text/html", 20_000);
    expect(fixtureUrl).toContain("F06%20local%20fixture");
    const targets = await listTargets(cdpPort);
    expect(targets.filter((target) => target.type === "page" && target.url === fixtureUrl)).toHaveLength(1);
    const pageCdp = await connectPageCdp(cdpPort, (target) => target.url === fixtureUrl);
    try {
      // A CDP target may advertise its pending data: URL while its renderer
      // still exposes about:blank. Wait for the actual document, not just /json.
      let document: { text?: string; title?: string; url?: string } = {};
      const deadline = Date.now() + 10_000;
      do {
        const evaluated = await pageCdp.send<{ result: { value: typeof document } }>(
          "Runtime.evaluate",
          { expression: "({ text: document.querySelector('h1')?.textContent, title: document.title, url: location.href })", returnByValue: true },
        );
        document = evaluated.result.value;
        if (document.text === "F06 local fixture" && document.title === "F06 local fixture" && document.url === fixtureUrl) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      expect(document).toMatchObject({ text: "F06 local fixture", title: "F06 local fixture", url: fixtureUrl });
      const shot = await pageCdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const png = Buffer.from(shot.data, "base64");
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.length).toBeGreaterThan(1024);
      fs.writeFileSync(SCREENSHOT, png);
      console.info(`F06 managed Chromium screenshot: ${SCREENSHOT}`);
    } finally {
      pageCdp.close();
    }
    const stopped = await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.stop(id), launchedId);
    expect(stopped.success).toBe(true);
    await waitForStopped(result.pid!, cdpPort);
    // The batch IPC routes through the same launch-only gate, never create's quota.
    const batch = await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.batchLaunch([id], 1), launchedId);
    expect(batch).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    const batchStatus = await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.status(id), launchedId);
    if (batchStatus.cdpPort > 0) launchedPorts.add(batchStatus.cdpPort);
    expect(batchStatus.running).toBe(true);
    expect(batchStatus.pid).toBeGreaterThan(0);
    expect(batchStatus.cdpPort).toBeGreaterThan(0);
    await waitForCdpPort(batchStatus.cdpPort, 20_000);
    process.kill(batchStatus.pid, 0);
    expect((await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.stop(id), launchedId)).success).toBe(true);
    await waitForStopped(batchStatus.pid, batchStatus.cdpPort);
    const diskIds = Object.keys(diskConfig().browserProfiles).sort();
    expect(diskIds).toEqual([...ids].sort());
    const readback = await h.page.evaluate(async (id) => {
      const api = (window as any).agentBrowser.api;
      return { profile: await api.profile.get(id), profiles: await api.browser.list(), status: await api.browser.status(id) };
    }, launchedId);
    expect(readback.profile.dirId).toBe(launchedId);
    expect(readback.profiles.map((profile: any) => profile.dirId).sort()).toEqual(diskIds);
    expect(readback.status.running).toBe(false);
    expect((await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({ name: "Still refused", proxyMode: "none" }))).code).toBe("PROFILE_LIMIT");
    console.info(`F06 disk/IPC readback: profiles=${diskIds.length}, queriedId=${launchedId}, finalRunning=${readback.status.running}, rejected=PROFILE_LIMIT`);
  }, 120_000);
});
