// J204: R11 card-layout verification screenshots (source build).
import { describe, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, ElectronApplication, Page } from "playwright";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j204");

describe("J204 — R11 card layout shots", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("captures fixed card layout", async () => {
    const names = [
      "Shop-US-001-America-West-Coast-Flagship-Store",
      "短名字测试中文截断效果看看",
      "A Very Long Profile Name That Should Definitely Be Truncated By Ellipsis Rules",
    ];
    for (let i = 0; i < names.length; i++) {
      await h.page.evaluate(
        ([nm, seed]: [string, number]) =>
          (window as any).agentBrowser.api.browser.create({ name: nm, platform: "windows", fingerprintSeed: seed }),
        [names[i], 10000 + i] as any,
      );
    }
    await h.page.evaluate(() => {
      (window as any).agentBrowser.switchTab("profiles");
      localStorage.setItem("agent-browser-studio-terms-accepted-v1", "1");
    });
    await h.page.waitForTimeout(2000);
    await h.page.setViewportSize({ width: 1280, height: 900 });
    await h.page.screenshot({ path: "/tmp/r11-fixed.png" });
  }, 60000);
});
