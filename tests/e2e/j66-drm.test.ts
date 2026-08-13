// J66: Widevine/DRM discovery, per-profile enable, and end-to-end probe.
// Requires a Widevine CDM on the host (macOS Chrome/Edge/Brave bundles) and a
// managed Chromium build that registers the CDM from --widevine-cdm-path.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { waitForCdpPort } from "./helpers/cdp.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j66");

describe("J66 — Widevine/DRM discovery, per-profile enable, and probe", () => {
  let h: TestAppHandle;
  let drmDirId = "";
  let plainDirId = "";
  let cdpPort = 0;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
  });

  it("creates a DRM-enabled profile via IPC and shows the DRM badge", async () => {
    const r = (await h.page.evaluate(async () => {
      return (window as any).agentBrowser.api.browser.create({
        name: "J66-drm",
        platform: "windows",
        fingerprintSeed: 66601,
        drm: true,
      });
    })) as { dirId: string };
    expect(r.dirId).toBeTruthy();
    drmDirId = r.dirId;

    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    await h.page.waitForTimeout(400);
    const card = `[data-dir-id="${drmDirId}"]`;
    await h.page.waitForSelector(card, { timeout: 5000 });
    await h.page.waitForFunction((sel: string) => {
      const el = document.querySelector(sel);
      return !!el && el.textContent!.includes("🎬 DRM");
    }, card, { timeout: 5000 });

    const list = (await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.list())) as any[];
    const p = list.find((x) => x.dirId === drmDirId);
    expect(p.drm).toBe(true);
  }, 20000);

  it("DRM status reports an available CDM on the host", async () => {
    const r = (await h.page.evaluate(async () => (window as any).agentBrowser.api.drm.status())) as {
      success: boolean;
      status: { available: boolean; cdm: { version: string; source: string } | null; profilesWithDrm: string[] };
    };
    expect(r.success).toBe(true);
    expect(r.status.available, "host must expose a Widevine CDM (Chrome bundle)").toBe(true);
    expect(r.status.cdm?.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(r.status.profilesWithDrm).toContain(drmDirId);
  }, 20000);

  it("staging via drm.ensure moves the CDM into the managed dir", async () => {
    const r = (await h.page.evaluate(async () => (window as any).agentBrowser.api.drm.ensure())) as {
      success: boolean;
      staged: boolean;
      status: { available: boolean; cdm: { source: string; path: string } | null };
    };
    expect(r.success).toBe(true);
    expect(r.staged).toBe(true);
    expect(r.status.available).toBe(true);
    // The managed copy is staged under <appData>/cdm/widevine/<version>.
    const managedRoot = path.join(USERDATA, "cdm", "widevine");
    const staged = fs.readdirSync(managedRoot).find((v) => fs.existsSync(path.join(managedRoot, v, "manifest.json")));
    expect(staged).toBeTruthy();
  }, 20000);

  it("toggles the DRM flag via the Edit dialog and persists it", async () => {
    const card = `[data-dir-id="${drmDirId}"]`;
    await h.page.locator(`${card} [data-action="edit"]`).click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-agent-browser-seed[open]", { timeout: 5000 });
    // Turn it off, save, verify; then turn it back on for the launch test.
    const drmBox = h.page.locator("#agent-browser-meta-drm");
    await drmBox.uncheck();
    await h.page.evaluate(() => (window as any).agentBrowser.saveBrowserMeta());
    await h.page.waitForTimeout(400);
    let list = (await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.list())) as any[];
    expect(list.find((x) => x.dirId === drmDirId).drm).toBe(false);

    await h.page.locator(`${card} [data-action="edit"]`).click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-agent-browser-seed[open]", { timeout: 5000 });
    await drmBox.check();
    await h.page.evaluate(() => (window as any).agentBrowser.saveBrowserMeta());
    await h.page.waitForTimeout(400);
    list = (await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.list())) as any[];
    expect(list.find((x) => x.dirId === drmDirId).drm).toBe(true);
  }, 25000);

  it("launches the DRM profile and probes real Widevine availability over CDP", async () => {
    const r = (await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.browser.launch(id),
      drmDirId,
    )) as { success: boolean; cdpPort: number; pid: number; error?: string };
    expect(r.success, `launch failed: ${r.error || JSON.stringify(r)}`).toBe(true);
    expect(r.cdpPort).toBeGreaterThan(0);
    cdpPort = r.cdpPort;
    h.cdpPort = cdpPort;
    h.cdpPids.push(r.pid);
    await waitForCdpPort(cdpPort, 15000);

    // Give the renderer + media pipeline a moment, then probe for Widevine.
    await h.page.waitForTimeout(1500);
    const probe = (await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.drm.probe(id),
      drmDirId,
    )) as { success: boolean; available: boolean; keySystems: string[]; error?: string };
    expect(probe.success, `probe failed: ${probe.error || JSON.stringify(probe)}`).toBe(true);
    expect(probe.available, `Widevine probe unavailable: ${probe.error || JSON.stringify(probe)}`).toBe(true);
    expect(probe.keySystems).toContain("com.widevine.alpha");
  }, 45000);

  it("a non-DRM profile has no Widevine key system (per-profile gating)", async () => {
    const r = (await h.page.evaluate(async () => {
      return (window as any).agentBrowser.api.browser.create({
        name: "J66-plain",
        platform: "windows",
        fingerprintSeed: 66602,
      });
    })) as { dirId: string };
    plainDirId = r.dirId;

    const launch = (await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.browser.launch(id),
      plainDirId,
    )) as { success: boolean; cdpPort: number; pid: number; error?: string };
    expect(launch.success, `launch failed: ${launch.error || JSON.stringify(launch)}`).toBe(true);
    h.cdpPids.push(launch.pid);
    await waitForCdpPort(launch.cdpPort, 15000);
    await h.page.waitForTimeout(1500);

    const probe = (await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.drm.probe(id),
      plainDirId,
    )) as { success: boolean; available: boolean };
    expect(probe.success).toBe(true);
    expect(probe.available).toBe(false);
  }, 45000);

  it("stops the profiles", async () => {
    await h.page.evaluate(async (id: string) => {
      await (window as any).agentBrowser.api.browser.stop(id);
    }, drmDirId);
    if (plainDirId) {
      await h.page.evaluate(async (id: string) => {
        await (window as any).agentBrowser.api.browser.stop(id);
      }, plainDirId);
    }
  }, 20000);

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
