// J208: narrow-viewport sweep across every tab (R133).
// J207 only covered profiles + sync; the other ten tabs had never been
// checked at the 700px breakpoint where the sidebar collapses to 168px.
import { describe, it, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j208");

const TABS = [
  "profiles", "proxy", "storage", "sync", "browser", "extensions",
  "accounts", "agent", "automation", "runs", "activity", "db",
];

describe("J208 — narrow viewport sweep", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("captures every tab at 700px", async () => {
    await h.page.evaluate(async () => {
      await (window as any).agentBrowser.api.browser.create({ name: "Narrow-Sweep-Profile", platform: "windows", fingerprintSeed: 11 });
    });
    await h.page.setViewportSize({ width: 700, height: 800 });
    for (const tab of TABS) {
      await h.page.evaluate((t: string) => (window as any).agentBrowser.switchTab(t), tab);
      await h.page.waitForTimeout(700);
      await h.page.screenshot({ path: `/tmp/j208-w700-${tab}.png` });
    }
  }, 180000);
});
