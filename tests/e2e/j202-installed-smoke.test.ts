// J202: installed-app smoke. Connects to the REAL installed
// /Applications build (not source, not dmg copy) via executablePath and
// asserts the sale surface: trial banner, license API, quota create,
// consistency menu entry. Skipped unless ABS_INSTALLED_APP=1.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, ElectronApplication, Page } from "playwright";

const ENABLED = process.env.ABS_INSTALLED_APP === "1";
const EXE = "/Applications/Agent Browser Studio.app/Contents/MacOS/Agent Browser Studio";
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "abs-inst-"));

describe("J202 — installed app smoke", () => {
  let app: ElectronApplication | null = null;
  let page: Page | null = null;

  beforeAll(async () => {
    if (!ENABLED) return;
    app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${USERDATA}`], timeout: 60000 });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    await page.waitForTimeout(4000);
  }, 120000);

  afterAll(async () => {
    try { await app?.close(); } catch { /* already closed */ }
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 90000);

  it("shows the trial banner with days left", async () => {
    if (!ENABLED || !page) return;
    await page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    const banner = page.locator("#license-banner");
    await banner.waitFor({ state: "visible", timeout: 15000 });
    expect(((await banner.textContent()) || "")).toMatch(/Trial|试用/);
  });

  it("license API reports a live trial with device id", async () => {
    if (!ENABLED || !page) return;
    const st = await page.evaluate(() => (window as any).agentBrowserAPI.license.status());
    expect(st.plan).toBe("trial");
    expect(st.daysLeft).toBeGreaterThan(0);
    expect(st.expired).toBe(false);
    expect(st.deviceId.length).toBeGreaterThan(0);
  });

  it("creates a profile and shows App badge + consistency entry", async () => {
    if (!ENABLED || !page) return;
    await page.evaluate(async () => {
      const api = (window as any).agentBrowserAPI;
      await api.browser.create({ name: "J202-inst", platform: "windows", fingerprintSeed: 202202, appUrl: "https://example.com/app" });
      (window as any).agentBrowser.switchTab("profiles");
      await new Promise((r) => setTimeout(r, 1500));
    });
    const html = await page.evaluate(() => document.getElementById("profile-list")!.innerHTML);
    expect(html).toContain("App</span>");
    expect(html).toContain('value="consistency"');
  });
});
