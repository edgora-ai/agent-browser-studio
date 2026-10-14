// Node-only CSS AST contracts and box arithmetic, NOT native paint/layout proof.
// Retained Electron evidence: wheel scrollTop 0 -> 141 with unchanged content;
// only Delete's right-edge hit met the overlay scrollbar. Closed EN/ZH batch
// bars already overflowed (scrollWidth 443/clientWidth 365; select 416.33px).
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import postcss, { type Rule } from "postcss";

const ROOT = path.resolve(__dirname, "../..");
const CSS = postcss.parse(fs.readFileSync(path.join(ROOT, "src/renderer/css/style.css"), "utf8"));

// Exact, unconditional author-rule contracts. Do not match comments, a dormant
// @supports/@media branch, similarly named selectors, or a simulated DOM style.
function rules(selector: string, standalone = false): Rule[] {
  const found: Rule[] = [];
  CSS.walkRules(rule => {
    if (rule.selectors.includes(selector) && (!standalone || rule.selectors.length === 1)) {
      expect(rule.parent?.type, `${selector}: contract must apply unconditionally`).toBe("root");
      found.push(rule);
    }
  });
  expect(found.length, `${selector}: real author rule required`).toBeGreaterThan(0);
  return found;
}
function declarations(selector: string, standalone = false): Map<string, string> {
  const result = new Map<string, string>();
  for (const rule of rules(selector, standalone)) rule.walkDecls(decl => {
    expect(decl.important, `${selector}: no !important workaround`).toBeFalsy();
    result.set(decl.prop, decl.value);
  });
  return result;
}
function px(value: string | undefined): number {
  expect(typeof value, "explicit CSS px/zero, not an assumed fallback").toBe("string");
  expect(value).toMatch(/^(?:\d+(?:\.\d+)?px|0)$/);
  return Number.parseFloat(value!);
}
function menuPadding() {
  const base = declarations(".card-menu-list");
  const panel = declarations(".card-menu-list[popover]");
  // Baseline symmetric padding remains; only the trailing overlay lane grows.
  const ordinary = px(base.get("padding"));
  const end = px(panel.get("padding-inline-end"));
  expect(panel.has("padding")).toBe(false); // No late shorthand erasing logical clearance.
  expect(panel.has("padding-right")).toBe(false); // Direction-independent contract.
  return { start: ordinary, end };
}

// Given a native option's measured max-content BORDER-box size, a wrapping
// flex line first caps its hypothetical border-box size to its parent's content
// box. Do not equate a native select's scrollWidth with painted text width, or
// shrink every row to the sum of its neighbours as a nowrap flex model would.
function optionBorderBox(intrinsic: number, available: number, min: number, maxPercent: number) {
  return Math.max(min, Math.min(intrinsic, available * maxPercent / 100));
}
function wrapLines(widths: number[], available: number, gap: number): number[][] {
  const lines: number[][] = [];
  for (const width of widths) {
    const line = lines.at(-1);
    if (!line || line.reduce((a, b) => a + b, 0) + gap * line.length + width > available) lines.push([width]);
    else line.push(width);
  }
  return lines;
}

describe("shared menu scrollbox clearance — source contract, not native hit testing", () => {
  it("reserves an explicit trailing lane even when overlay scrollbars ignore scrollbar-gutter", () => {
    const panel = declarations(".card-menu-list[popover]");
    const padding = menuPadding();
    // 18px modeled overlay + 6px ordinary visual clearance. Native acceptance
    // still must prove the actual center and FOUR edge midpoints immediately
    // after wheel input, when the OS scrollbar is visible.
    expect(padding.end).toBeGreaterThanOrEqual(24);
    expect(padding.start).toBe(6);
    expect(panel.get("position")).toBe("fixed");
    expect(panel.get("inset")).toBe("auto");
    expect(panel.get("box-sizing")).toBe("border-box");
    expect(panel.get("width")).toBe("max-content");
    expect(panel.get("min-width")).toBe("0");
    expect(panel.get("overflow-x")).toBe("hidden");
    expect(panel.get("overflow-y")).toBe("auto");
    expect(panel.get("overscroll-behavior")).toBe("contain");
    expect(declarations(".card-menu-list[popover]:not(:popover-open)").get("display")).toBe("none");
  });

  it("preserves complete wrapped labels, nonshrinking rows, icon lane and the existing hit target", () => {
    const button = declarations(".card-menu-list button");
    expect(button.get("padding")).toBe("7px 10px");
    expect(button.get("min-height")).toBe("28px");
    expect(button.get("white-space")).toBe("normal");
    expect(button.get("overflow-wrap")).toBe("anywhere");
    expect(button.get("flex")).toBe("0 0 auto");
    expect(button.get("min-width")).toBe("0");
    expect(button.get("display")).toBe("flex");
    expect(button.get("gap")).toBe("8px");
    for (const prop of ["overflow", "overflow-x", "overflow-y", "text-overflow", "height", "max-height", "width", "max-width", "transform", "clip-path"]) {
      expect(button.has(prop), `no clipping or smaller target via ${prop}`).toBe(false);
    }
    expect(declarations(".card-menu-list button > svg").get("flex")).toBe("0 0 auto");
  });

  it.each([200, 244.81, 517.33, 750])("fits a %spx bounded border box without pretending to paint native scrollbars", available => {
    const padding = menuPadding();
    const border = 1; // Existing panel's 1px border on both edges.
    expect(declarations(".card-menu-list").get("border")).toBe("1px solid var(--border-light)");
    const retainedButtonWidth = 230.81;
    const preferred = retainedButtonWidth + padding.start + padding.end + border * 2;
    const panelWidth = Math.min(preferred, available);
    const buttonWidth = panelWidth - border * 2 - padding.start - padding.end;
    expect(panelWidth).toBeLessThanOrEqual(available);
    expect(buttonWidth).toBeGreaterThan(28);
    if (available >= preferred) expect(buttonWidth).toBeCloseTo(retainedButtonWidth, 5);
    // In narrow viewports labels wrap; row heights are NOT capped or fabricated.
    // For a modeled overlay occupying the trailing 18px, the entire button,
    // not just its right-2 sample, stays outside that interval.
    const buttonEnd = border + padding.start + buttonWidth;
    const overlayStart = panelWidth - border - 18;
    expect(overlayStart - buttonEnd).toBeGreaterThanOrEqual(6);
    expect(buttonEnd - 2).toBeLessThan(overlayStart);
  });
});

describe("Profiles batch native select sizing — source contract, not option paint", () => {
  it("bounds only the Profiles bars and proxy selector while retaining native selection and intentional wrapping", () => {
    for (const selector of ["#profile-batch-bar", "#profile-batch-actions"]) {
      const bar = declarations(selector);
      expect(bar.get("min-width")).toBe("0");
      expect(bar.get("max-width")).toBe("100%");
      expect(bar.get("box-sizing")).toBe("border-box");
      for (const prop of ["overflow", "overflow-x", "overflow-y", "height", "max-height"]) expect(bar.has(prop)).toBe(false);
    }
    for (const selector of [".batch-bar", ".batch-actions"]) {
      expect(declarations(selector).get("display")).toBe("flex");
      expect(declarations(selector).get("flex-wrap")).toBe("wrap");
    }
    const select = declarations("#batch-assign-proxy", true);
    expect(select.get("min-width")).toBe("0");
    expect(select.get("max-width")).toBe("100%");
    expect(select.get("box-sizing")).toBe("border-box");
    expect(select.get("flex")).toBe("0 1 auto");
    for (const prop of ["width", "appearance", "-webkit-appearance", "overflow", "text-overflow", "font-size", "padding"]) expect(select.has(prop)).toBe(false);
    // The dedicated sizing rule may not turn into a universal select redesign.
    const sizingRule = rules("#batch-assign-proxy", true);
    expect(sizingRule).toHaveLength(1);
    expect(sizingRule[0].selectors).toEqual(["#batch-assign-proxy"]);
    expect([...select.keys()].sort()).toEqual(["box-sizing", "flex", "max-width", "min-width"].sort());
  });

  it.each([365, 533.33, 760])("caps a retained 416.33px native option to a %spx parent before line packing", outer => {
    const bar = declarations(".batch-actions");
    expect(bar.get("padding")).toBe("8px 10px");
    expect(bar.get("border")).toBe("1px solid var(--warning)");
    const available = outer - 20 - 2; // Border-box bar -> flex content box.
    const select = declarations("#batch-assign-proxy", true);
    const min = px(select.get("min-width"));
    expect(select.get("max-width")).toBe("100%");
    const native = optionBorderBox(416.33, available, min, 100);
    const short = optionBorderBox(114, available, min, 100);
    expect(native).toBeCloseTo(Math.min(416.33, available), 5);
    expect(short).toBe(114); // No forced 100% width or lost intrinsic sizing.
    const lines = wrapLines([86, 105, 114, native, 99, 94], available, px(bar.get("gap")));
    for (const line of lines) expect(line.reduce((a, b) => a + b, 0) + (line.length - 1) * 8).toBeLessThanOrEqual(available);
    if (outer === 365) expect(lines.some(line => line.length === 1 && line[0] === native)).toBe(true);
  });
});
