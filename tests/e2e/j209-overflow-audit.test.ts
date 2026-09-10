// J209: layout overflow audit at narrow width (R134).
// Eyeballing screenshots misses 2-8px overflows. This measures every element
// in the active tab at 700px and reports any whose right edge crosses the
// content box, plus any horizontal scroll on the scroll container.
import { describe, it, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j209");

const TABS = [
  "profiles", "proxy", "storage", "sync", "browser", "extensions",
  "accounts", "agent", "automation", "runs", "activity", "db",
];

describe("J209 — narrow overflow audit", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("reports elements overflowing the content box at 700px", async () => {
    await h.page.evaluate(async () => {
      await (window as any).agentBrowser.api.browser.create({ name: "Overflow-Audit-Profile-With-A-Long-Name", platform: "windows", fingerprintSeed: 3 });
    });
    await h.page.setViewportSize({ width: 700, height: 800 });

    const report: string[] = [];
    for (const tab of TABS) {
      await h.page.evaluate((t: string) => (window as any).agentBrowser.switchTab(t), tab);
      await h.page.waitForTimeout(500);
      const rows = await h.page.evaluate(() => {
        const content = document.getElementById("content");
        if (!content) return [];
        const cs = getComputedStyle(content);
        const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
        const box = content.getBoundingClientRect();
        const limit = box.right - padR;
        const out: string[] = [];
        const tab = document.querySelector(".tab-content.active");
        if (!tab) return out;
        tab.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          const over = r.right - limit;
          if (over > 1) {
            const tag = el.tagName.toLowerCase();
            const cls = (el.className && typeof el.className === "string") ? el.className.split(" ")[0] : "";
            out.push(`${tag}.${cls} over=${over.toFixed(1)} w=${r.width.toFixed(0)} text=${(el.textContent || "").trim().slice(0, 28)}`);
          }
        });
        // horizontal scroll on the scroller itself
        if (content.scrollWidth > content.clientWidth + 1) {
          out.unshift(`SCROLLER scrollWidth=${content.scrollWidth} clientWidth=${content.clientWidth}`);
        }
        return out;
      });
      if (rows.length) report.push(`[${tab}]`, ...rows.slice(0, 12));
    }
    if (report.length) {
      console.log("OVERFLOW REPORT:\n" + report.join("\n"));
    } else {
      console.log("OVERFLOW REPORT: clean — no element crosses the content box at 700px");
    }
  }, 180000);
});
