// J205: premium restyle verification — all 12 tabs, light + dark.
import { describe, it, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j205");
const TABS = ["profiles", "proxy", "storage", "sync", "browser", "extensions", "accounts", "agent", "automation", "runs", "activity", "db"];

describe("J205 — premium full-page shots", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("captures all tabs light then dark", async () => {
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
    await h.page.setViewportSize({ width: 1280, height: 900 });
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") {
        await h.page.evaluate(() => (window as any).agentBrowser.toggleTheme());
        await h.page.waitForTimeout(600);
      }
      for (const tab of TABS) {
        await h.page.evaluate((t: string) => (window as any).agentBrowser.switchTab(t), tab);
        await h.page.waitForTimeout(900);
        await h.page.screenshot({ path: `/tmp/j205-${theme}-${tab}.png` });
      }
    }
  }, 180000);
});
