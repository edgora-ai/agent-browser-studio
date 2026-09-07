// J206: premium dialog verification — key dialogs, light + dark.
import { describe, it, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j206");

describe("J206 — premium dialog shots", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("captures key dialogs light then dark", async () => {
    await h.page.evaluate(async () => {
      await (window as any).agentBrowser.api.browser.create({ name: "Dialog-Check-Profile", platform: "windows", fingerprintSeed: 42 });
      (window as any).agentBrowser.switchTab("profiles");
    });
    await h.page.waitForTimeout(1500);
    await h.page.setViewportSize({ width: 1280, height: 900 });
    const shots: Array<[string, string]> = [
      ["dlg-proxy", "proxy"],
      ["dlg-profile", "profile"],
      ["dlg-confirm", "confirm"],
      ["dlg-license", "license"],
    ];
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") {
        await h.page.evaluate(() => (window as any).agentBrowser.toggleTheme());
        await h.page.waitForTimeout(600);
      }
      for (const [id, name] of shots) {
        await h.page.evaluate((dlgId: string) => {
          const d = document.getElementById(dlgId) as HTMLDialogElement | null;
          if (d && !d.open) { try { d.showModal(); } catch { /* ignore */ } }
        }, id);
        await h.page.waitForTimeout(500);
        await h.page.screenshot({ path: `/tmp/j206-${theme}-${name}.png` });
        await h.page.evaluate(() => {
          document.querySelectorAll("dialog[open]").forEach((d) => { try { (d as HTMLDialogElement).close(); } catch { /* ignore */ } });
        });
        await h.page.waitForTimeout(200);
      }
    }
    // Toast check: fire one success + one error toast, capture.
    for (const theme of ["light", "dark"]) {
      await h.page.evaluate((t: string) => {
        if (t === "dark" && !(window as any).__j206dark) {
          (window as any).agentBrowser.toggleTheme();
          (window as any).__j206dark = true;
        }
        if (t === "light" && (window as any).__j206dark) {
          (window as any).agentBrowser.toggleTheme();
          (window as any).__j206dark = false;
        }
        (window as any).agentBrowser.helpers.toast("Profile launched — premium check", "success");
        (window as any).agentBrowser.helpers.toast("Proxy unreachable — premium check", "error");
      }, theme);
      await h.page.waitForTimeout(600);
      await h.page.screenshot({ path: `/tmp/j206-${theme}-toasts.png` });
      await h.page.waitForTimeout(3500);
    }
  }, 120000);
});
