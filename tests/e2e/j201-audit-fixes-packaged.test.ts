// J201: audit-R1 fixes visible in the packaged app (#107 B1/B3).
// Boots the REAL packaged .app via ABS_PACKAGED_APP, creates a profile with
// appUrl, and asserts the card renders the App badge + the health menu
// offers the consistency (4-field alignment) entry. Skipped when unset.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { _electron as electron, ElectronApplication, Page } from "playwright";

const APP = process.env.ABS_PACKAGED_APP || "";
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "abs-pkg201-"));

describe("J201 — audit fixes in packaged app (#107)", () => {
  let app: ElectronApplication | null = null;
  let page: Page | null = null;

  beforeAll(async () => {
    if (!APP) return;
    const exe = path.join(APP, "Contents", "MacOS", "Agent Browser Studio");
    app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${USERDATA}`], timeout: 60000 });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    await page.waitForTimeout(4000);
  }, 120000);

  afterAll(async () => {
    try { await app?.close(); } catch { /* already closed */ }
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 90000);

  it("card renders the App badge for appUrl profiles (B1)", async () => {
    if (!APP || !page) return;
    await page.evaluate(async () => {
      const api = (window as any).agentBrowserAPI;
      await api.browser.create({ name: "J201-app", platform: "windows", fingerprintSeed: 201201, appUrl: "https://example.com/app" });
      (window as any).agentBrowser.switchTab("profiles");
      await new Promise((r) => setTimeout(r, 1500));
    });
    const html = await page.evaluate(() => document.getElementById("profile-list")!.innerHTML);
    expect(html).toContain("App</span>");
  });

  it("health menu offers the consistency check (B3)", async () => {
    if (!APP || !page) return;
    const html = await page.evaluate(() => document.getElementById("profile-list")!.innerHTML);
    expect(html).toContain('value="consistency"');
  });
});
