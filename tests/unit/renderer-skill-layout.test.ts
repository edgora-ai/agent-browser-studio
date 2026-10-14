import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import postcss from "postcss";

const css = postcss.parse(fs.readFileSync(path.resolve(__dirname, "../../src/renderer/css/style.css"), "utf8"));
const html = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8");
function declarations(selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  css.walkRules(rule => {
    if (rule.selector !== selector || rule.parent?.type !== "root") return;
    rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
  });
  return result;
}

describe("skill cards reserve reading space before placing action groups", () => {
  it("wraps the card row instead of compressing its summary beside buttons", () => {
    expect(declarations(".skill-layout")["flex-wrap"]).toBe("wrap");
    expect(declarations(".skill-main")).toMatchObject({ "min-width": "0", flex: "1 1 240px", "overflow-wrap": "anywhere" });
  });
  it("keeps action groups bounded and permits long button labels to wrap", () => {
    expect(declarations(".skill-actions")).toMatchObject({ "flex-wrap": "wrap", "min-width": "0", "max-width": "100%", flex: "0 1 auto" });
    expect(declarations(".skill-actions .btn")).toMatchObject({ "max-width": "100%", "white-space": "normal", "overflow-wrap": "anywhere" });
  });
  it("reflows the Skills header without splitting its short page title", () => {
    expect(html).toMatch(/id="agent-view-skills"[^>]*>[\s\S]*?<div class="skill-view-header">/);
    expect(declarations(".skill-view-header")["flex-wrap"]).toBe("wrap");
    expect(declarations(".skill-view-header > h4")).toMatchObject({ "flex-shrink": "0", "white-space": "nowrap" });
    expect(declarations(".skill-view-actions")).toMatchObject({ display: "flex", "flex-wrap": "wrap", "min-width": "0", "max-width": "100%" });
  });
});
