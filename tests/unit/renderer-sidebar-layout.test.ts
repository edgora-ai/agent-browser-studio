import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import postcss from "postcss";

const css = postcss.parse(fs.readFileSync(path.resolve(__dirname, "../../src/renderer/css/style.css"), "utf8"));
function declarations(selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  css.walkRules(rule => {
    if (rule.selector !== selector || rule.parent?.type !== "root") return;
    rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
  });
  return result;
}

describe("sidebar flex layout keeps footer controls reachable", () => {
  it("allows navigation to shrink and scroll instead of pushing controls out", () => {
    expect(declarations(".nav-menu")).toMatchObject({ flex: "1", "min-height": "0", "overflow-y": "auto" });
  });
  it("keeps the fixed slider track and its label separate inside footer controls", () => {
    expect(declarations(".theme-toggle .toggle-track")["flex-shrink"]).toBe("0");
    expect(declarations(".sidebar-controls .theme-toggle")).toMatchObject({ margin: "0", padding: "4px 0" });
  });
  it("retains the header and footer without shrinking their controls", () => {
    expect(declarations(".sidebar-header")["flex-shrink"]).toBe("0");
    expect(declarations(".sidebar-footer")["flex-shrink"]).toBe("0");
  });
});
