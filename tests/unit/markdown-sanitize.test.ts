import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const CORE = fs.readFileSync(path.join(__dirname, "../../src/renderer/js/app/core.js"), "utf8");

// Extract sanitizeMdHtml + its allowlist tables from core.js and run them in a
// sandbox (no DOM needed — the sanitizer is DOM-free by design).
function loadSanitizer(): (html: string) => string {
  const start = CORE.indexOf("var ALLOWED_MD_TAGS");
  const end = CORE.indexOf("function renderChatMarkdown");
  if (start === -1 || end === -1 || end <= start) throw new Error("sanitizer block not found in core.js");
  const src = CORE.slice(start, end);
  const sandbox: any = {};
  vm.createContext(sandbox);
  vm.runInContext(src + "\nthis.__sanitize = sanitizeMdHtml;", sandbox);
  return sandbox.__sanitize as (html: string) => string;
}

const sanitize = loadSanitizer();

describe("markdown sanitize", () => {
  it("uses an allowlist sanitizer with no DOMPurify dependency", () => {
    expect(CORE).toContain("ALLOWED_MD_TAGS");
    expect(CORE).toContain("SAFE_URI_REGEXP");
    expect(CORE).not.toContain("window.DOMPurify");
  });

  it("strips javascript: links (plain, quoted, entity-encoded)", () => {
    expect(sanitize('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
    expect(sanitize("<a href='javascript:alert(1)'>x</a>")).not.toMatch(/javascript:/i);
    expect(sanitize('<a href="java&#x09;script:alert(1)">x</a>')).not.toMatch(/script:/i);
    expect(sanitize('<a href="java&#58;script:alert(1)">x</a>')).not.toMatch(/script:/i);
  });

  it("strips on* handlers in all quote styles", () => {
    expect(sanitize('<a href="#" onclick="alert(1)">x</a>')).not.toMatch(/onclick/i);
    expect(sanitize("<img src=x onerror='alert(1)'>")).not.toMatch(/onerror/i);
    expect(sanitize("<img src=x onerror=alert(1)>")).not.toMatch(/onerror/i);
  });

  it("removes dangerous content tags with their content", () => {
    for (const tag of ["script", "iframe", "object", "embed", "form", "style", "link", "meta"]) {
      const out = sanitize(`<${tag} src="x">evil()</${tag}>`);
      expect(out).not.toContain("evil()");
      expect(out).not.toMatch(new RegExp(`<${tag}`, "i"));
    }
  });

  it("drops data:text/html and srcdoc vectors", () => {
    expect(sanitize('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toMatch(/data:text\/html/i);
    expect(sanitize('<iframe srcdoc="<p>hi</p>"></iframe>')).not.toContain("srcdoc");
  });

  it("unwraps non-allowlisted tags but keeps their text", () => {
    expect(sanitize("<div>hello</div>")).toBe("hello");
    expect(sanitize("<svg onload=alert(1)>hi</svg>")).toBe("hi");
  });

  it("keeps legitimate formatting and safe links intact", () => {
    const out = sanitize('<p><strong>bold</strong> <a href="https://example.com/docs">docs</a></p>');
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toMatch(/href="https:\/\/example\.com\/docs"/);
  });

  it("CSP is present and restricts script-src", () => {
    const html = fs.readFileSync(path.join(__dirname, "../../src/renderer/index.html"), "utf8");
    expect(html).toContain("script-src");
    expect(html).toMatch(/script-src[^"]*'self'/);
    expect(html).not.toMatch(/script-src[^"]*unsafe-inline/);
    expect(html).toContain("style-src 'self' 'unsafe-inline'");
  });
});
