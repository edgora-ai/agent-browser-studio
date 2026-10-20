import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import postcss from "postcss";

const css = postcss.parse(fs.readFileSync(path.resolve(__dirname, "../../src/renderer/css/style.css"), "utf8"));
const html = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8");
function declarations(selector: string, compact = false): Record<string, string> {
  const result: Record<string, string> = {};
  css.walkRules(rule => {
    if (rule.selector !== selector) return;
    const parent = rule.parent;
    if (compact ? parent?.type !== "atrule" || parent.name !== "container" || parent.params !== "agent-pane (max-width: 560px)" : parent?.type !== "root") return;
    rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
  });
  return result;
}

describe("narrow layout keeps text and Agent controls scroll reachable", () => {
  it("wraps icon-heading text rather than clipping an anonymous flex item", () => {
    expect(declarations(".tab-title")["max-width"]).toBe("100%");
    expect(declarations(".tab-header h2[data-icon] > span")).toMatchObject({ "min-width": "0", "white-space": "normal", "overflow-wrap": "anywhere" });
  });
  it("reflows the secondary navigation based on actual available width", () => {
    expect(declarations("#tab-agent")).toMatchObject({ "container-type": "inline-size", "container-name": "agent-pane" });
    expect(declarations(".agent-layout", true)["flex-direction"]).toBe("column");
    expect(declarations("#agent-sidebar", true)).toMatchObject({ width: "100%", "min-width": "0", display: "grid" });
    expect(html).not.toMatch(/id="agent-sidebar"[^>]*style="[^"]*width:210px/);
    expect(declarations(".agent-subnav .btn-icon", true)["aspect-ratio"]).toBe("auto");
  });
  it("exposes oversized chat content through a real vertical scroll path", () => {
    expect(declarations("#agent-view-chat")["overflow-y"]).toBe("auto");
    expect(declarations("#agent-chat-messages", true)["min-height"]).toBe("104px");
    expect(declarations(".agent-scope-label", true)).toMatchObject({ "max-width": "100%", flex: "0 1 auto" });
    expect(declarations("#agent-env-select", true)["min-width"]).toBe("0");
    expect(declarations(".agent-action-row")["flex-wrap"]).toBe("wrap");
  });
});
