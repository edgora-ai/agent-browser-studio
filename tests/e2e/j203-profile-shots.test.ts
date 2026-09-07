// J203: profile card screenshots (light + dark) for visual review.
import { describe, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, ElectronApplication, Page } from "playwright";

const ENABLED = process.env.ABS_SHOTS === "1";
const EXE = "/Applications/Agent Browser Studio.app/Contents/MacOS/Agent Browser Studio";
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "abs-shot-"));

describe("J203 — profile screenshots", () => {
  let app: ElectronApplication | null = null;
  let page: Page | null = null;

  beforeAll(async () => {
    if (!ENABLED) return;
    app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${USERDATA}`], timeout: 60000 });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    await page.waitForTimeout(4000);
    // Fresh userData always shows the terms gate first — accept it so the
    // screenshots capture the actual profiles UI, not the dialog.
    await page.evaluate(() => {
      try {
        const box = document.getElementById("terms-ack") as HTMLInputElement | null;
        if (box) box.checked = true;
      } catch { /* ignore */ }
    });
    await page.evaluate(() => (window as any).agentBrowser.termsAccept());
    await page.waitForTimeout(1500);
    // Fresh userData with no profiles also triggers the first-run wizard —
    // skip it so the screenshots capture the profiles UI.
    await page.evaluate(() => {
      try { (window as any).agentBrowser.wizardSkip(); } catch { /* ignore */ }
      try {
        const dlg = document.getElementById("dlg-wizard") as HTMLDialogElement | null;
        if (dlg && dlg.open) dlg.close();
      } catch { /* ignore */ }
    });
    await page.waitForTimeout(800);
  }, 120000);

  afterAll(async () => {
    try { await app?.close(); } catch { /* already closed */ }
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 90000);

  it("captures light and dark", async () => {
    if (!ENABLED || !page) return;
    await page.evaluate(async () => {
      const api = (window as any).agentBrowserAPI;
      const names = [
        "Shop-US-001-America-West-Coast-Flagship-Store",
        "短名字测试中文截断效果看看",
        "A Very Long Profile Name That Should Definitely Be Truncated By Ellipsis Rules",
      ];
      for (let i = 0; i < names.length; i++) {
        await api.browser.create({ name: names[i], platform: "windows", fingerprintSeed: 10000 + i });
      }
      (window as any).agentBrowser.switchTab("profiles");
      await new Promise((r) => setTimeout(r, 2000));
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    // Forensics for the stray sidebar "Loading...": dump elements near it.
    const probe = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("#sidebar .loading, #sidebar .empty-state"));
      return els.map((el) => ({
        cls: el.className,
        text: (el.textContent || "").slice(0, 60),
        html: (el.parentElement && el.parentElement.id) || el.parentElement?.className || "?",
      }));
    });
    // eslint-disable-next-line no-console
    console.log("SIDEBAR_LOADING_PROBE " + JSON.stringify(probe));
    const listKids = await page.evaluate(() => {
      const list = document.getElementById("profile-list");
      if (!list) return [];
      return Array.from(list.children).map((el) => ({
        tag: el.tagName,
        cls: el.className,
        dirId: (el as HTMLElement).dataset?.dirId || null,
        text: (el.textContent || "").slice(0, 40),
      }));
    });
    // eslint-disable-next-line no-console
    console.log("LIST_KIDS_PROBE " + JSON.stringify(listKids));
    await page.screenshot({ path: "/tmp/profiles-light.png" });
    await page.evaluate(() => (window as any).agentBrowser.toggleTheme());
    await page.waitForTimeout(800);
    await page.screenshot({ path: "/tmp/profiles-dark.png" });
  });
});
