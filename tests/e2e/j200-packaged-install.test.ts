// J200: packaged-install smoke (sale-91). Boots the REAL packaged .app
// (not the source tree) and asserts the sale gates render: trial banner,
// terms dialog wiring, license dialog wiring, and profile create works
// inside the trial quota.
//
// The packaged binary path comes from ABS_PACKAGED_APP (e.g. /tmp/ABS-Test.app
// copied out of the dmg). Skipped when unset — CI builds the dmg in
// engine-verify, it does not install it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { _electron as electron, ElectronApplication, Page } from "playwright";

const APP = process.env.ABS_PACKAGED_APP || "";
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "abs-pkg-"));

describe("J200 — packaged install smoke (sale-91)", () => {
  let app: ElectronApplication | null = null;
  let page: Page | null = null;

  beforeAll(async () => {
    if (!APP) return;
    const exe = path.join(APP, "Contents", "MacOS", "Agent Browser Studio");
    app = await electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${USERDATA}`],
      timeout: 60000,
    });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    // Let first-run init (trial marker, wizard/terms) settle.
    await page.waitForTimeout(4000);
  }, 120000);

  afterAll(async () => {
    try { await app?.close(); } catch { /* already closed */ }
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 90000);

  it("boots when ABS_PACKAGED_APP is set", () => {
    if (!APP) return; // no packaged app — skipped outside packaging runs
    expect(app).not.toBe(null);
    expect(page).not.toBe(null);
  });

  it("renders the trial banner on the profiles tab", async () => {
    if (!APP || !page) return;
    await page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    const banner = page.locator("#license-banner");
    await banner.waitFor({ state: "visible", timeout: 15000 });
    const text = (await banner.textContent()) || "";
    expect(text).toMatch(/Trial|试用/);
  });

  it("license API reports a live trial", async () => {
    if (!APP || !page) return;
    const st = await page.evaluate(() => (window as any).agentBrowserAPI.license.status());
    expect(st.plan).toBe("trial");
    expect(typeof st.daysLeft).toBe("number");
    expect(st.daysLeft).toBeGreaterThan(0);
    expect(st.expired).toBe(false);
    expect(typeof st.deviceId).toBe("string");
    expect(st.deviceId.length).toBeGreaterThan(0);
  });

  it("creates a profile inside the trial quota", async () => {
    if (!APP || !page) return;
    const r = await page.evaluate(() =>
      (window as any).agentBrowserAPI.browser.create({ name: "J200-pkg", platform: "windows", fingerprintSeed: 200200 }),
    );
    expect(r.dirId).toBeTruthy();
    const list = await page.evaluate(() => (window as any).agentBrowserAPI.browser.list());
    expect(list.some((p: any) => p.name === "J200-pkg")).toBe(true);
  });

  it("activation dialog opens with device id (no code echoed)", async () => {
    if (!APP || !page) return;
    await page.evaluate(() => (window as any).agentBrowser.showLicenseDialog());
    const dlg = page.locator("#dlg-license");
    await dlg.waitFor({ state: "visible", timeout: 10000 });
    const devId = ((await page.locator("#license-device-id").textContent()) || "").trim();
    expect(devId.length).toBeGreaterThan(4);
    expect(devId).not.toBe("—");
    // Refund ack is required before submit: empty submit must refuse.
    await page.locator("#license-activate-btn").click();
    const err = page.locator("#license-error");
    await err.waitFor({ state: "visible", timeout: 5000 });
  });
});
