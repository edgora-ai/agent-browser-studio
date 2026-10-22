// Proxy tab grid layout.
//
// R141 fixed the health summary being a 338px tall grid tile by claiming the
// whole row — but the rule named `.proxy-health-summary`, while the element
// that is actually a direct child of `.profile-grid` is the
// `.proxy-health-summary-host` wrapper around it. The fix was therefore inert:
// the banner took column 1 of row 1, the first proxy card sat beside it in
// column 2, and the rest of the grid shifted one column right (measured in a
// real render: rows at x=315 / 707 / 1099 with the banner in the first slot).
//
// These assertions read the real stylesheet and the real renderer source, so
// re-introducing a selector that does not match the DOM fails here.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import postcss from "postcss";

const root = path.resolve(__dirname, "../..");
const css = postcss.parse(fs.readFileSync(path.join(root, "src/renderer/css/style.css"), "utf8"));
const renderer = fs.readFileSync(path.join(root, "src/renderer/js/app/proxies.js"), "utf8");

function topLevel(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  css.walkRules(rule => {
    if (rule.selector !== selector || rule.parent?.type !== "root") return;
    rule.walkDecls(d => { out[d.prop] = d.value; });
  });
  return out;
}

describe("proxy tab grid", () => {
  it("makes the summary wrapper — not its inner banner — span the grid row", () => {
    expect(renderer).toContain('<div class="proxy-health-summary-host">');
    const host = topLevel(".profile-grid > .proxy-health-summary-host");
    expect(host["grid-column"]).toBe("1 / -1");
    expect(host["align-self"]).toBe("start");
  });

  it("keeps the inner banner sized to its content inside that row", () => {
    const inner = topLevel(".profile-grid > .proxy-health-summary");
    expect(inner["grid-column"]).toBe("1 / -1");
    expect(inner["align-self"]).toBe("start");
  });

  it("gives the cards a shared label column", () => {
    // Every proxy info row must resolve to the same subgrid, or the value
    // column starts at a different x per card (the R143 defect).
    const meta = topLevel(".profile-card > .card-meta > .info-row");
    expect(meta["grid-template-columns"]).toBe("subgrid");
    expect(topLevel(".profile-card > .card-meta")["grid-template-columns"]).toContain("max-content");
  });

  it("lets the health value wrap instead of forcing the row wider", () => {
    expect(topLevel(".proxy-health-row")["flex-wrap"]).toBe("wrap");
    expect(topLevel(".proxy-health-row")["min-width"]).toBe("0");
  });
});
