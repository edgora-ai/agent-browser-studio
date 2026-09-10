// J210: contrast audit (R135).
// The stylesheet comments assert WCAG AA for small text; this measures the
// actual rendered foreground/background of every visible text node and
// reports anything below 4.5:1 (normal) or 3:1 (large >=18.66px bold /
// 24px). Comments are not evidence — this is.
import { describe, it, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j210");

const TABS = [
  "profiles", "proxy", "storage", "sync", "browser", "extensions",
  "accounts", "agent", "automation", "runs", "activity", "db",
];

describe("J210 — contrast audit", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("reports text below WCAG AA in light and dark", async () => {
    await h.page.evaluate(async () => {
      await (window as any).agentBrowser.api.browser.create({ name: "Contrast-Profile", platform: "windows", fingerprintSeed: 5 });
    });

    const audit = async (theme: string) => {
      const rows: string[] = [];
      for (const tab of TABS) {
        await h.page.evaluate((t: string) => (window as any).agentBrowser.switchTab(t), tab);
        await h.page.waitForTimeout(400);
        const found = await h.page.evaluate(() => {
          const parse = (c: string) => {
            const m = c.match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const p = m[1].split(",").map((x) => parseFloat(x.trim()));
            return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
          };
          const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          const lum = (c: any) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
          const over = (fg: any, bg: any) => ({
            r: fg.r * fg.a + bg.r * (1 - fg.a),
            g: fg.g * fg.a + bg.g * (1 - fg.a),
            b: fg.b * fg.a + bg.b * (1 - fg.a),
            a: 1,
          });
          const ratio = (a: any, b: any) => {
            const la = lum(a), lb = lum(b);
            return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
          };
          const effBg = (el: Element) => {
            let n: Element | null = el;
            let acc: any = null;
            while (n && n.nodeType === 1) {
              const c = parse(getComputedStyle(n).backgroundColor);
              if (c && c.a > 0) acc = acc ? over(acc, c) : c;
              if (acc && acc.a >= 0.999) return acc;
              n = n.parentElement;
            }
            return acc || { r: 255, g: 255, b: 255, a: 1 };
          };
          const out: string[] = [];
          const seen = new Set<string>();
          document.querySelectorAll(".tab-content.active *, #sidebar *").forEach((el) => {
            const txt = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || "").trim());
            if (!txt) return;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.5) return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            const fg = parse(cs.color);
            if (!fg || fg.a === 0) return;
            const bg = effBg(el);
            const fgEff = fg.a < 1 ? over(fg, bg) : fg;
            const cr = ratio(fgEff, bg);
            const size = parseFloat(cs.fontSize);
            const bold = parseInt(cs.fontWeight, 10) >= 700;
            const large = size >= 24 || (size >= 18.66 && bold);
            const min = large ? 3 : 4.5;
            if (cr < min) {
              const cls = (el.className && typeof el.className === "string") ? el.className.split(" ")[0] : "";
              const key = `${el.tagName}.${cls}|${cs.color}|${size}`;
              if (seen.has(key)) return;
              seen.add(key);
              out.push(`${el.tagName.toLowerCase()}.${cls} ${cr.toFixed(2)}:1 (need ${min}) ${size}px/${cs.fontWeight} ${(el.textContent || "").trim().slice(0, 30)}`);
            }
          });
          return out;
        });
        if (found.length) rows.push(`[${theme}/${tab}]`, ...found.slice(0, 10));
      }
      return rows;
    };

    const light = await audit("light");
    await h.page.evaluate(() => (window as any).agentBrowser.toggleTheme());
    await h.page.waitForTimeout(700);
    const dark = await audit("dark");

    const all = [...light, ...dark];
    if (all.length) console.log("CONTRAST REPORT:\n" + all.join("\n"));
    else console.log("CONTRAST REPORT: clean — every visible text node meets WCAG AA in light and dark");
  }, 300000);
});
