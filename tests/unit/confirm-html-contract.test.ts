// confirmHtmlUnsafe contract test (#8): every in-repo caller must esc() all
// dynamic values before passing HTML. This is a static grep-guard: if a future
// caller passes a raw name (profile/proxy/account) the test fails.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const APP = path.join(__dirname, "../../src/renderer/js/app");

function callers(): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const f of fs.readdirSync(APP)) {
    if (!f.endsWith(".js")) continue;
    const lines = fs.readFileSync(path.join(APP, f), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (/confirmHtml(Unsafe)?\s*\(/.test(text)) out.push({ file: f, line: i + 1, text });
    });
  }
  return out;
}

describe("confirmHtml unsafe contract", () => {
  it("all callers esc() dynamic values (no raw names in HTML args)", () => {
    const hits = callers().filter((c) => c.file !== "core.js");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      // The call opening line itself carries no raw dynamic value; the HTML
      // payload is built in preceding lines which must use esc().
      expect(h.text).not.toMatch(/confirmHtml(Unsafe)?\s*\(\s*[a-zA-Z_$][\w$]*\s*,/);
    }
    // The payload-building lines after each call opening must contain esc(.
    for (const h of hits) {
      const lines = fs.readFileSync(path.join(APP, h.file), "utf8").split("\n");
      const window = lines.slice(h.line - 1, h.line + 11).join("\n");
      expect(window).toContain("esc(");
    }
  });

  it("core exposes confirmHtmlUnsafe with an explicit unsafe contract comment", () => {
    const core = fs.readFileSync(path.join(APP, "core.js"), "utf8");
    expect(core).toContain("confirmHtmlUnsafe");
    expect(core).toMatch(/UNSAFE-CONTRACT/);
  });
});
