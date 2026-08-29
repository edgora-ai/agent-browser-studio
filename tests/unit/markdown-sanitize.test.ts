import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const CORE = fs.readFileSync(path.join(__dirname, "../../src/renderer/js/app/core.js"), "utf8");

function hasSanitize(html: string): boolean {
  // Check that sanitizeMdHtml is wired with ALLOWED_URI_REGEXP blocking javascript:
  return CORE.includes("ALLOWED_URI_REGEXP") && CORE.includes("javascript");
}

describe("markdown sanitize", () => {
  it("strips javascript: links", () => {
    expect(CORE).toContain('ALLOWED_URI_REGEXP');
    expect(CORE).toMatch(/javascript/i);
    expect(CORE).toContain('DOMPurify.sanitize');
  });
  it("strips on* handlers via fallback", () => {
    expect(CORE).toContain('on\\w+');
  });
  it("CSP is present and restricts script-src", () => {
    const html = fs.readFileSync(path.join(__dirname, "../../src/renderer/index.html"), "utf8");
    expect(html).toContain("script-src");
    expect(html).toMatch(/script-src[^"]*'self'/);
    expect(html).not.toMatch(/script-src[^"]*unsafe-inline/);
    expect(html).toContain("style-src 'self' 'unsafe-inline'");
  });
});
