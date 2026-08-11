// J51: the desktop controller must use only the independently managed
// Chromium cache. Legacy wrapper environment variables are ignored and a
// missing managed build fails closed without downloading a substitute.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j51");

describe("J51 — independent Chromium runtime", () => {
  let h: TestAppHandle;
  let emptyCache = "";

  beforeAll(async () => {
    emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-empty-chromium-"));
    h = await setupTestApp({
      userDataDir: USERDATA,
      allowProfileVersionSelection: true,
      env: {
        AGENT_BROWSER_CHROMIUM_CACHE_DIR: emptyCache,
        // These historical wrapper variables must have no effect.
        CLOAKBROWSER_BINARY_PATH: process.execPath,
        CLOAKBROWSER_LICENSE_KEY: "ignored-test-value",
        CLOAKBROWSER_DOWNLOAD_URL: "http://127.0.0.1:1/must-not-be-used",
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (emptyCache) fs.rmSync(emptyCache, { recursive: true, force: true });
  }, 30_000);

  it("reports no browser instead of accepting a legacy wrapper override", async () => {
    const status = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.binary());
    expect(status).toMatchObject({ installed: false, path: null, version: null, source: null });
    expect(status.installedVersions).toEqual([]);

    const verified = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.verifyBinary());
    expect(verified.success).toBe(false);
    expect(verified.error).toContain("Managed Chromium is not installed");
  });

  it("fails profile launch closed and leaves the managed cache untouched", async () => {
    const created = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J51 no fallback",
      fingerprintSeed: 51515,
      platform: "windows",
      proxyMode: "none",
    }));
    const launched = await h.page.evaluate(
      async (dirId: string) => (window as any).agentBrowser.api.browser.launch(dirId),
      created.dirId,
    );
    expect(launched.success).toBe(false);
    expect(launched.error).toContain("upstream wrapper fallback is disabled");
    expect(fs.readdirSync(emptyCache)).toEqual([]);
  });
});
