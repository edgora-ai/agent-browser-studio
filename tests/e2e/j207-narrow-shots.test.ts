// J207: narrow-viewport responsive verification (R124).
import { describe, it, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j207");

describe("J207 — narrow viewport shots", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("captures profiles at 1000px and 700px widths", async () => {
    await h.page.evaluate(async () => {
      await (window as any).agentBrowser.api.browser.create({ name: "Narrow-Check-Profile-With-Long-Name", platform: "windows", fingerprintSeed: 7 });
      (window as any).agentBrowser.switchTab("profiles");
    });
    await h.page.waitForTimeout(1500);
    await h.page.setViewportSize({ width: 1000, height: 800 });
    await h.page.waitForTimeout(600);
    await h.page.screenshot({ path: "/tmp/j207-w1000-profiles.png" });
    await h.page.setViewportSize({ width: 700, height: 800 });
    await h.page.waitForTimeout(600);
    await h.page.screenshot({ path: "/tmp/j207-w700-profiles.png" });
    await h.page.evaluate((t: string) => (window as any).agentBrowser.switchTab(t), "sync");
    await h.page.waitForTimeout(600);
    await h.page.screenshot({ path: "/tmp/j207-w700-sync.png" });
  }, 120000);
});
