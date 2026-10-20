// Markdown rendering tests — run the REAL production pipeline from core.js
// (sanitizeMdHtml allowlist + wrapMdCodeBlocks + renderChatMarkdown), not a
// mirrored regex. R0925-06: the previous version of this file copied an old
// sanitizer and forced `breaks: true`, so it kept passing while production
// rendered differently. Extraction markers are asserted so a refactor of
// core.js fails here loudly instead of silently testing stale code.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { marked } from "marked";

const CORE = fs.readFileSync(path.join(__dirname, "../../src/renderer/js/app/core.js"), "utf8");

interface Pipeline {
  render: (text: string) => string;
  markedOptions: () => Record<string, unknown>;
}

function loadProductionPipeline(): Pipeline {
  const start = CORE.indexOf("function safeCodeLanguage");
  const end = CORE.indexOf("function shortPath");
  if (start === -1 || end === -1 || end <= start) throw new Error("markdown pipeline block not found in core.js");
  const src = CORE.slice(start, end);
  for (const marker of ["function sanitizeMdHtml", "function wrapMdCodeBlocks", "function renderChatMarkdown"]) {
    if (!src.includes(marker)) throw new Error(`extraction lost ${marker} — update the test boundaries`);
  }

  let lastOptions: Record<string, unknown> = {};
  const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sandbox: any = {
    window: {
      marked: {
        setOptions: (opts: Record<string, unknown>) => { lastOptions = opts; marked.setOptions(opts as any); },
        parse: (text: string) => marked.parse(text),
      },
    },
    pi18n: (_key: string, fallback: string) => fallback,
    esc,
    escAttr: (v: unknown) => esc(v).replace(/"/g, "&quot;"),
    icon: () => "",
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\nthis.__render = renderChatMarkdown;", sandbox);
  if (typeof sandbox.__render !== "function") throw new Error("renderChatMarkdown not exported from extraction");
  return { render: sandbox.__render as (text: string) => string, markedOptions: () => lastOptions };
}

const pipeline = loadProductionPipeline();
const render = pipeline.render;

describe("chat markdown — production pipeline wiring", () => {
  it("configures marked with the production options (breaks OFF)", () => {
    render("# Title");
    expect(pipeline.markedOptions()).toMatchObject({ breaks: false, gfm: true, headerIds: false, mangle: false });
  });

  it("wraps fenced code blocks in the card anatomy with a copy action", () => {
    const html = render("```js\nconst x = 1;\n```");
    expect(html).toContain("md-codeblock");
    expect(html).toContain("data-code-copy");
    expect(html).toContain("language-js");
    expect(html).toContain("const x = 1;");
    // The copy button label must not leak into the code body.
    const body = html.match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/)?.[1] || "";
    expect(body).not.toContain("Copy");
  });
});

describe("chat markdown — marked output", () => {
  it("renders headings", () => {
    const html = render("# Title\n## Sub");
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>Sub<\/h2>/);
  });

  it("renders bullet and ordered lists", () => {
    const html = render("- a\n- b\n\n1. one\n2. two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>a</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>one</li>");
  });

  it("renders inline code", () => {
    const html = render("use `npm test` to run");
    expect(html).toContain("<code>npm test</code>");
  });

  it("renders bold and italic", () => {
    const html = render("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders links with safe href and forces noopener target", () => {
    const html = render("[Anthropic](https://www.anthropic.com)");
    expect(html).toMatch(/<a [^>]*href="https:\/\/www\.anthropic\.com"/);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders tables", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders task lists (GFM checkboxes)", () => {
    const html = render("- [x] done\n- [ ] todo");
    expect(html).toContain("checkbox");
  });

  it("renders blockquotes", () => {
    const html = render("> quoted text");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("quoted text");
  });

  it("renders horizontal rules", () => {
    const html = render("a\n\n---\n\nb");
    expect(html).toContain("<hr");
  });

  it("renders nested lists", () => {
    const html = render("- top\n  - nested");
    expect(html).toContain("<ul>");
    expect(html).toContain("nested");
  });

  it("does NOT soft-break single newlines into <br> (production breaks:false)", () => {
    const html = render("line one\nline two");
    expect(html).not.toContain("line one<br>");
  });
});

describe("chat markdown — XSS sanitization (production allowlist)", () => {
  it("strips <script> blocks", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).not.toMatch(/<script/i);
  });

  it("strips inline event handlers", () => {
    const html = render('<a href="#" onclick="alert(1)">x</a>');
    expect(html).not.toMatch(/onclick=/i);
  });

  it("neutralizes javascript: URLs from markdown links", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("escapes HTML inside code blocks (no execution)", () => {
    const html = render("```\n<div onclick=alert(1)>\n```");
    expect(html).not.toMatch(/<div onclick/i);
  });

  it("returns safe output for empty input", () => {
    const html = render("");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });

  it("keeps legitimate https links intact", () => {
    const html = render("[docs](https://example.com/docs)");
    expect(html).toMatch(/href="https:\/\/example\.com\/docs"/);
  });

  it("drops data:text/html and srcdoc vectors", () => {
    expect(render('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toMatch(/data:text\/html/i);
  });
});
