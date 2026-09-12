#!/usr/bin/env node
/**
 * Visual verification harness (renderer layer).
 *
 * Why this exists: the Playwright+Electron e2e suites (tests/e2e/j2xx) need a
 * working Chromium sandbox, which sandboxed dev shells and some CI containers
 * cannot provide — Electron aborts with "sandbox initialization failed" before
 * a window ever appears. Every UI change then ships unverified. This harness
 * loads the *real* renderer (src/renderer/index.html, no build step) into
 * Playwright's bundled Chromium, stubs window.agentBrowserAPI with
 * scripts/visual-mock.js, and gives you two things:
 *
 *   node scripts/visual-shot.mjs                 # screenshots, light + dark
 *   node scripts/visual-shot.mjs --audit         # overflow + contrast report
 *
 * Flags:
 *   --out DIR        output directory                 (default /tmp/abs-shots)
 *   --tabs a,b,c     tabs to capture                  (default all 12)
 *   --theme light,dark | light | dark
 *   --width N        viewport width                   (default 1280)
 *   --height N       viewport height                  (default 860)
 *   --dsf N          device scale factor              (default 2)
 *   --lang zh|en     UI language                      (default zh)
 *   --team-empty     render the first-run team workspace (no roster)
 *   --dialog CMD     also shoot a dialog: after the profiles tab settles,
 *                    click [data-cmd=CMD] and capture (e.g. newProfile)
 *   --audit          never writes screenshots; prints measured violations:
 *                    runtime exceptions, layout overflow at --width, WCAG AA
 *                    contrast at 1440, icon/text vertical alignment, selector
 *                    references no template produces, mock-coverage gaps,
 *                    content census, and literal undefined/NaN in rendered text.
 *                    Exits 1 when any of those fail, so it can gate CI.
 *   --only NAME      run one audit and print just its section, for fast
 *                    iteration: icons | contrast | overflow | errors | selectors
 *   --dump TAB       print the measured box model of a tab (or of
 *                    --dump-selector inside it) and exit; pairs with
 *                    --dump-depth N (default 3). Use it when a layout is
 *                    reported as "off" but the cause is not obvious: every row
 *                    shows its width/height and vertical centre, so a
 *                    misaligned row reads as siblings with different cy.
 *
 * The audits measure the real box model / computed styles, because eyeballing
 * screenshots misses 2-8px overflow and 4.3:1 contrast. The census exists for
 * the same reason in the other direction: a tab that never drew a card has
 * nothing to overflow and no text to measure, so it passes vacuously — see the
 * team-role contrast bug in sync.js, hidden behind a mock that returned [].
 */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { chromium } = require("playwright");

const ALL_TABS = [
  "profiles", "proxy", "storage", "sync", "browser", "extensions",
  "accounts", "agent", "automation", "runs", "activity", "db",
];

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const OUT = path.resolve(flag("out", "/tmp/abs-shots"));
const WIDTH = Number(flag("width", 1280));
const HEIGHT = Number(flag("height", 860));
const DSF = Number(flag("dsf", 2));
const THEMES = flag("theme", "light,dark").split(",").map((s) => s.trim()).filter(Boolean);
const TABS = flag("tabs", ALL_TABS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
// Accept the shorthand people actually type (--lang zh) but store the locale
// code the renderer's dictionary is keyed by. The value must match a dict key
// exactly or i18n.js falls back to navigator.language.
const LANG = { zh: "zh-CN", en: "en-US", "zh-cn": "zh-CN", "en-us": "en-US" }[String(flag("lang", "zh")).toLowerCase()] || "zh-CN";
const DIALOG = flag("dialog", "");
const TEAM_EMPTY = has("team-empty");
const AUDIT = has("audit");
// Geometry dump: prints the measured box model of a subtree, because "the
// layout is off" is not actionable until you can see which box is the wrong
// size. Reads the real computed box, so it reports what the browser laid out
// rather than what the stylesheet intended.
const DUMP = flag("dump", "");
const DUMP_SELECTOR = flag("dump-selector", "");
const DUMP_DEPTH = Number(flag("dump-depth", 3));
// Run one audit while iterating on a fix; the full sweep boots 8 browsers.
const ONLY = flag("only", "");

// ── The real API surface (src/main/preload.cjs) ─────────────────────────────
// Parse the preload rather than a hand-kept list, so "does this call site
// point at an API that actually exists?" is answered by the source of truth.
// A renderer call that is NOT in here is a dead call site: it silently does
// nothing at runtime and no test notices, because the mock's Proxy answers it
// with an empty array.
function realApiSurface() {
  const src = readFileSync(path.join(ROOT, "src", "main", "preload.cjs"), "utf-8");
  const paths = new Set();
  const stack = [];
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const opens = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/);
    if (opens) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name: opens[1] });
      continue;
    }
    const fn = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*\(/);
    if (fn) {
      const ns = stack.filter((s) => s.indent < indent).map((s) => s.name).join(".");
      paths.add((ns ? ns + "." : "") + fn[1] + "()");
    }
  }
  return paths;
}
const REAL_API = realApiSurface();

// ── Locate Playwright's bundled Chromium ────────────────────────────────────
// The package cache lives in different places per platform and the revision
// number changes on every install, so match any chromium-<rev> directory.
function resolveChromium() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_PATH || process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const roots = [
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
  ];
  // Chromium ships under a per-platform directory name; on macOS the binary is
  // nested inside the .app bundle.
  const candidates = process.platform === "darwin"
    ? ["chrome-mac-arm64", "chrome-mac-x64"].map((v) => [v, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"])
    : process.platform === "win32"
      ? [["chrome-win", "chrome.exe"]]
      : [["chrome-linux", "chrome"]];
  const hits = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!/^chromium-\d+$/.test(entry)) continue;
      for (const parts of candidates) {
        const bin = path.join(root, entry, ...parts);
        if (existsSync(bin)) hits.push({ rev: Number(entry.split("-")[1]), path: bin });
      }
    }
  }
  hits.sort((a, b) => b.rev - a.rev);
  return hits[0] ? hits[0].path : null;
}

const MOCK = readFileSync(path.join(ROOT, "scripts", "visual-mock.js"), "utf-8");
const PAGE_URL = "file://" + path.join(ROOT, "src", "renderer", "index.html");

// ── Page bootstrap ──────────────────────────────────────────────────────────
async function openPage(browser, theme, width = WIDTH, height = HEIGHT, teamEmpty = TEAM_EMPTY, lang = LANG) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: DSF,
    // file:// pages need no origin allowance; keep storage so init reads it.
  });
  const page = await ctx.newPage();
  await page.addInitScript(`
    ${MOCK}
    try {
      if (${JSON.stringify(teamEmpty)}) window.__visualHarness.teamMode = 'empty';
      localStorage.setItem('agent-browser-studio-theme', ${JSON.stringify(theme)});
      localStorage.setItem('agent-browser-studio-wizard-dismissed', '1');
      localStorage.setItem('agent-browser-studio-terms-accepted-v1', '1');
      localStorage.setItem('abs-backup-hint-dismissed', '1');
      // R146: was 'agent-browser-studio-lang' holding 'zh'/'en'. The renderer
      // reads 'agent-browser-studio-language' (i18n.js STORAGE_KEY) and matches
      // the value against its dictionary keys, which are 'zh-CN'/'en-US'. Both
      // halves were wrong, so the key was ignored and the language fell through
      // to navigator.language — meaning --lang never did anything and every
      // "en" capture was really zh. Any audit that compares two locales was
      // silently comparing one against itself.
      localStorage.setItem('agent-browser-studio-language', ${JSON.stringify(lang)});
      localStorage.setItem('cloak-lite-language', ${JSON.stringify(lang)});
    } catch (e) {}
  `);
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => !!(window.agentBrowser && window.agentBrowser.api), { timeout: 15000 });
  // Fail loudly rather than silently rendering the wrong locale: a verify step
  // that cannot distinguish its two inputs must not report a clean diff.
  const actual = await page.evaluate(() => (window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : null);
  if (actual && actual !== lang) {
    throw new Error(`harness requested lang=${lang} but renderer resolved ${actual} — check STORAGE_KEY in i18n.js`);
  }
  await page.waitForTimeout(700);
  return { ctx, page };
}

async function goTab(page, tab) {
  if (tab === "profiles") await page.waitForSelector("#profiles-list .profile-card", { timeout: 8000 }).catch(() => {});
  await page.evaluate((t) => window.agentBrowser.switchTab(t), tab);
  await page.waitForTimeout(600);
}

// ── Shots ───────────────────────────────────────────────────────────────────
async function shoot(browser) {
  mkdirSync(OUT, { recursive: true });
  const written = [];
  // Keep the two workspace states from overwriting each other.
  const mode = TEAM_EMPTY ? "-team-empty" : "";
  for (const theme of THEMES) {
    const { ctx, page } = await openPage(browser, theme);
    for (const tab of TABS) {
      await goTab(page, tab);
      const file = path.join(OUT, `${theme}${mode}-${tab}.png`);
      await page.screenshot({ path: file });
      written.push(file);
      console.log("shot", file);
    }
    if (DIALOG) {
      // The trigger lives on a specific tab (newProfile on profiles,
      // agentNewConv on agent), so the target tab is selectable.
      await goTab(page, flag("dialog-tab", "profiles"));
      await page.click(`[data-cmd="${DIALOG}"]`).catch((e) => console.error("dialog click failed:", e.message));
      await page.waitForTimeout(600);
      const file = path.join(OUT, `${theme}${mode}-dialog-${DIALOG}.png`);
      await page.screenshot({ path: file });
      written.push(file);
      console.log("shot", file);
    }
    await ctx.close();
  }
  return written;
}

// ── Audit: layout overflow ──────────────────────────────────────────────────
async function auditOverflow(browser, width) {
  const rows = [];
  for (const theme of THEMES) {
    const { ctx, page } = await openPage(browser, theme, width, HEIGHT);
    for (const tab of TABS) {
      await goTab(page, tab);
      const found = await page.evaluate(() => {
        const content = document.getElementById("content");
        if (!content) return [];
        const cs = getComputedStyle(content);
        const box = content.getBoundingClientRect();
        const limit = box.right - parseFloat(cs.paddingRight);
        const out = [];
        if (content.scrollWidth - content.clientWidth > 1) {
          out.push({ sel: "#content", kind: "h-scroll", detail: `scrollWidth ${content.scrollWidth} > clientWidth ${content.clientWidth}` });
        }
        for (const el of content.querySelectorAll("*")) {
          const s = getComputedStyle(el);
          if (s.display === "none" || s.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // Only report elements that visibly stick out, not intentionally
          // clipped scroll containers.
          if (r.right > limit + 1 && s.overflowX !== "auto" && s.overflowX !== "scroll" && s.overflowX !== "hidden") {
            const id = el.id ? `#${el.id}` : "";
            const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
            out.push({ sel: el.tagName.toLowerCase() + id + cls, kind: "overflow", detail: `${Math.round(r.right - limit)}px past content edge` });
          }
        }
        return out.slice(0, 12);
      });
      for (const f of found) rows.push({ theme, tab, ...f });
    }
    await ctx.close();
  }
  return rows;
}

// ── Audit: contrast (WCAG AA on rendered text) ───────────────────────────────
const CONTRAST_PROBE = () => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => {
    let node = el;
    let acc = null;
    while (node && node.nodeType === 1) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 0.999) return acc; }
      node = node.parentElement;
    }
    return acc || { r: 255, g: 255, b: 255, a: 1 };
  };

  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || "").trim();
    if (text.length < 2) continue;
    const el = node.parentElement;
    if (!el || el.closest("[hidden]")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.15) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const fg = parse(cs.color);
    if (!fg || fg.a === 0) continue;
    const bg = bgOf(el);
    const eff = fg.a < 1 ? over(fg, bg) : fg;
    const cr = ratio(eff, bg);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    if (cr + 0.02 >= need) continue;
    const key = `${el.tagName}.${el.className}|${text.slice(0, 24)}|${Math.round(size)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sel: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""),
      text: text.slice(0, 40),
      ratio: Math.round(cr * 100) / 100,
      need,
      size: Math.round(size),
      color: cs.color,
    });
  }
  return out.slice(0, 40);
};

async function auditContrast(browser) {
  const rows = [];
  for (const theme of THEMES) {
    const { ctx, page } = await openPage(browser, theme, 1440, 900);
    for (const tab of TABS) {
      await goTab(page, tab);
      const found = await page.evaluate(CONTRAST_PROBE);
      for (const f of found) rows.push({ theme, tab, ...f });
    }
    await ctx.close();
  }
  return rows;
}

// ── Audit: runtime exceptions on every tab ──────────────────────────────────
// Most renderer failures are swallowed by a `.catch(e) { el.innerHTML = "…" }`,
// so they never reach window.onerror and no test notices. Pausing on *every*
// throw (including caught ones) is the only way to see them. A ReferenceError
// here is usually a typo'd identifier — e.g. calling an i18n helper by the
// wrong name — and it takes a whole page down.
async function auditErrors(browser) {
  const unique = new Map();
  for (const theme of THEMES) {
    const { ctx, page } = await openPage(browser, theme);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Debugger.enable");
    await cdp.send("Debugger.setPauseOnExceptions", { state: "all" });
    cdp.on("Debugger.paused", async (ev) => {
      const frames = (ev.callFrames || []).slice(0, 4).map((f) => ({
        fn: f.functionName || "(anonymous)",
        file: path.relative(ROOT, f.url.replace("file://", "")) || f.url,
        line: f.location.lineNumber + 1,
      }));
      const key = `${(ev.data && ev.data.description) || "?"}|${frames.map((f) => `${f.file}:${f.line}`).join(">")}`;
      if (!unique.has(key)) unique.set(key, { theme, what: (ev.data && ev.data.description) || "exception", frames });
      try { await cdp.send("Debugger.resume"); } catch (e) { /* already resumed */ }
    });
    // Reload under the debugger so boot-time failures are caught too.
    await page.reload();
    await page.waitForTimeout(1200);
    for (const tab of TABS) {
      await goTab(page, tab).catch(() => {});
    }
    await ctx.close();
  }
  return [...unique.values()];
}

// ── Audit: icon / text vertical alignment ───────────────────────────────────
// An <svg> is an inline-level box, so unless its host is a flex container the
// glyph sits on the text *baseline*: an 18px icon against 14px text ends up
// ~3-4px high, and the line box grows to fit it. Every [data-icon] host in the
// stylesheet is flex, but hosts added later silently miss that rule — which is
// invisible in a screenshot at 1x and reads as "the icons are off" at 2x.
//
// The reference is the union rect of the host's own text nodes, measured with a
// Range (a Range gives the *line box*, which is what flex centring aligns to;
// the element's own rect would include padding the text never touches).
const ICON_ALIGN_PROBE = () => {
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const textRect = (host, svg) => {
    let top = Infinity, bottom = -Infinity, found = false;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        found = true;
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
    }
    return found ? { top, bottom, center: (top + bottom) / 2, height: bottom - top } : null;
  };

  const out = [];
  for (const svg of document.querySelectorAll("svg")) {
    const r = svg.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(svg);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    // The text partner may not be the svg's direct parent (an icon can sit in
    // its own wrapper span), so climb — but only through *wrappers*, never into
    // a container. Climbing into `.card-actions` (9 buttons) or `#agent-sidebar`
    // measured an icon-only control against a whole region of unrelated text and
    // reported 38-770px "misalignments" that mean nothing. A host is a wrapper
    // only if it holds exactly one element child and so does its parent.
    let host = svg.parentElement;
    let text = host ? textRect(host, svg) : null;
    for (let hops = 0; !text && host && host.parentElement && hops < 2; hops++) {
      if (host.children.length !== 1) break;
      const up = host.parentElement;
      if (up.children.length !== 1) break;
      host = up;
      text = textRect(host, svg);
    }
    // A control with no label has nothing to align to — an icon-only button is
    // centred by its own flex box, which is a different (and already correct)
    // rule.
    if (!text) continue;
    const fontSize = parseFloat(getComputedStyle(host).fontSize) || 14;
    const delta = Math.abs((r.top + r.bottom) / 2 - text.center);
    // Larger type is deliberately set on its optical centre, so it tolerates
    // more than a 12-14px label does.
    const limit = fontSize >= 20 ? 2 : 1.25;
    const hcs = getComputedStyle(host);
    const flex = hcs.display === "flex" || hcs.display === "inline-flex";
    // `align-items: baseline` is an explicit baseline alignment, so it must not
    // be treated as centred — that is the very defect being looked for.
    const centred = flex && (hcs.alignItems === "center" || hcs.alignItems === "normal");
    // Report by *cause*, not only by measurement. An inline <svg> next to text
    // is baseline-aligned, so it is wrong by construction — but at 11-12px with
    // line-height 1.5 the resulting offset can land inside any threshold by
    // coincidence (measured: 1.5px). A structural check does not depend on that
    // luck; the measured offset is printed alongside as the evidence.
    if (centred && delta <= limit) continue;
    out.push({
      // The host alone is often a bare `span`; the text it holds and its parent
      // are what make the row identifiable in the source.
      sel: describe(host),
      parent: host.parentElement ? describe(host.parentElement) : "(none)",
      text: (host.textContent || "").trim().replace(/\s+/g, " ").slice(0, 26),
      kind: centred ? "offset" : "baseline",
      delta: Math.round(delta * 10) / 10,
      limit,
      size: Math.round(fontSize),
      box: `${Math.round(r.width)}x${Math.round(r.height)}`,
      display: hcs.display + (flex ? `/${hcs.alignItems}` : " (not flex → baseline)"),
    });
  }
  return out;
};

// ── Audit: card-header reading order ────────────────────────────────────────
// A card header is meant to read "name, then status" — that is what every
// screenshot of every page shows and what the eye scans. `.card-header` is a
// grid whose first track is reserved for the selection checkbox, and the badge
// only lands in the second row when the caller wraps it in `.card-status`. A
// caller that inlines a bare badge leaves it unplaced, so auto-placement files
// it into the *checkbox* track: the badge renders first, hard against the card
// edge, and the name is pushed right. Six pages shipped that way (R147) and no
// existing audit could see it — nothing overflowed, no contrast failed, no icon
// was misaligned. It was only visible by looking.
//
// So this measures reading order directly: for each header, every badge must
// start to the right of the name's box and share its horizontal band. It is a
// comparison against a sibling, not an absolute position, so it survives
// re-layout and does not care how the header is implemented (grid or flex).
const CARD_HEADER_ORDER_PROBE = () => {
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const out = [];
  for (const header of document.querySelectorAll(".profile-card .card-header")) {
    const name = header.querySelector(".name");
    if (!name) continue;
    const nr = name.getBoundingClientRect();
    if (nr.width < 1) continue;
    for (const badge of header.querySelectorAll(".status-badge")) {
      // Only a badge that is a *direct child* of the header is placed by the
      // header's own layout, which is what this audit is about. A badge nested
      // inside the name (runs.js tags a retried run by appending one to the
      // name) is deliberately part of the name's own text flow — it is left of
      // the name's right edge by construction and is not a placement bug.
      if (badge.parentElement !== header) continue;
      const br = badge.getBoundingClientRect();
      if (br.width < 1 || br.height < 1) continue;
      const cs = getComputedStyle(badge);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // Same band: the badge's vertical centre inside the name's box (with a
      // line of tolerance for a wrapped second row, which is legitimate).
      const sameBand = br.top < nr.bottom + 2 && br.bottom > nr.top - 2;
      if (!sameBand) continue;              // own row — not a reading-order bug
      if (br.left >= nr.right - 1) continue; // correctly after the name
      out.push({
        header: describe(header),
        name: describe(name),
        nameText: (name.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24),
        badge: describe(badge),
        badgeText: (badge.textContent || "").trim().replace(/\s+/g, " ").slice(0, 18),
        nameX: Math.round(nr.left),
        nameRight: Math.round(nr.right),
        badgeX: Math.round(br.left),
        overlap: Math.round(nr.right - br.left),
        card: header.closest(".profile-card")?.className || "(none)",
      });
    }
  }
  return out;
};

function printHeaderOrder(rows) {
  console.log("\n=== card-header reading order (badge before name) ===");
  if (!rows.length) {
    console.log("clean — every header badge follows the name it belongs to");
    return rows;
  }
  for (const r of rows) {
    console.log(`  BADGE BEFORE NAME  ${r.header} in ${r.card}`);
    console.log(`      name "${r.nameText}" at x=${r.nameX}..${r.nameRight}, badge "${r.badgeText}" at x=${r.badgeX} → ${r.overlap}px overlap`);
  }
  return rows;
}

async function auditHeaderOrder(browser) {
  const rows = [];
  const seen = new Set();
  // Reading order is geometry, not colour — one theme pass is enough.
  const { ctx, page } = await openPage(browser, THEMES[0]);
  for (const tab of TABS) {
    await goTab(page, tab);
    const found = await page.evaluate(CARD_HEADER_ORDER_PROBE);
    for (const f of found) {
      const key = `${f.header}|${f.badge}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ tab, ...f });
    }
  }
  await ctx.close();
  return rows;
}

async function auditIconAlign(browser) {
  const rows = [];
  const seen = new Set();
  for (const theme of THEMES) {
    const { ctx, page } = await openPage(browser, theme);
    for (const tab of TABS) {
      await goTab(page, tab);
      const found = await page.evaluate(ICON_ALIGN_PROBE);
      for (const f of found) {
        // Nav/toolbar icons repeat on every tab; report each host once.
        const key = `${theme}|${f.sel}|${f.delta}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ theme, tab, ...f });
      }
    }
    await ctx.close();
  }
  return rows;
}

// ── Audit: content census + mock coverage ───────────────────────────────────
// "No violations" only means something if the tab actually drew something. A
// tab that fell through to its empty state has nothing to overflow and no text
// to measure, so it passes vacuously — exactly how the team-role contrast bug
// stayed hidden behind a mock that returned [].
//
// The headline number is visible text, not card count: tabs disagree on markup
// (db uses .db-table-row, agent renders a chat), so counting .profile-card
// alone would misreport them as empty. Cards are reported alongside as context.
//
// A tab counts as thin when it is left showing nothing but an empty state —
// presence of an empty-state marker AND almost no text. Text alone is not
// enough (the db tab is legitimately terse at ~90 chars) and an empty-state
// alone is not either (sync has one empty sub-section inside a full page).
//
// The same walk also collects mock misses, so the two cheap tab sweeps are one
// page boot instead of two. Misses are classified against the real preload
// surface: an API that exists but has no fixture is harness debt; an API the
// renderer calls that does not exist at all is a dead call site (real bug).
const THIN_CHARS = 200;

async function censusAndCoverage(browser) {
  const rows = [];
  const misses = new Set();
  // Data shape, not styling — one theme pass is enough.
  const { ctx, page } = await openPage(browser, THEMES[0]);
  for (const tab of TABS) {
    await goTab(page, tab);
    const stats = await page.evaluate((tabId) => {
      const pane = document.getElementById("tab-" + tabId);
      if (!pane) return { missing: true, cards: 0, empty: 0, chars: 0, garbage: [] };
      const text = (pane.innerText || "").trim();
      // Literal `undefined` on screen is what a missing field plus an
      // unguarded interpolation looks like. It is invisible to a DOM-structure
      // audit (the element exists, it just says the wrong thing) and easy to
      // miss in a screenshot, so grep the rendered text for it directly.
      const garbage = [];
      const re = /\bundefined\b|\bNaN\b|\[object Object\]/g;
      let hit;
      while ((hit = re.exec(text))) {
        const line = text.slice(Math.max(0, hit.index - 40), hit.index + 40).replace(/\s+/g, " ");
        if (!garbage.some((g) => g.token === hit[0] && g.line === line)) garbage.push({ token: hit[0], line });
      }
      return {
        missing: false,
        cards: pane.querySelectorAll(".profile-card").length,
        empty: pane.querySelectorAll(".empty-state, .view-state-empty").length,
        chars: text.length,
        garbage: garbage.slice(0, 4),
      };
    }, tab);
    rows.push({ tab, thin: stats.empty > 0 && stats.chars < THIN_CHARS, ...stats });
  }
  const found = await page.evaluate(() => (window.__visualHarness && window.__visualHarness.mockMisses) || []);
  for (const m of found) misses.add(m);
  await ctx.close();

  const dead = [];
  const unstubbed = [];
  for (const m of [...misses].sort()) {
    if (REAL_API.has(m)) { unstubbed.push(m); continue; }
    // A bare `ns()` hit is a namespace access, not a method call. Call it a
    // mock gap when real methods live under that namespace, otherwise the
    // renderer is reaching for an API that does not exist.
    const bare = m.endsWith("()") ? m.slice(0, -2) : m;
    const underRealNamespace = [...REAL_API].some((p) => p.startsWith(bare + "."));
    (underRealNamespace ? unstubbed : dead).push(m);
  }
  return { rows, dead, unstubbed };
}

// ── Audit: untranslated English in a non-English UI ─────────────────────────
// check-i18n.mjs guards the *source* (CJK text with no key, CJK literals in
// JS). It structurally cannot see the opposite leak: an English string baked
// into a JS render path ships verbatim into the zh UI, and the source contains
// no CJK for the gate to notice. That is exactly the shape of the defects this
// probe found (sync.js "Device ID", accounts.js "password saved", the
// extensions SHARED/PRIVATE badges), so the check has to run against rendered
// text, not source.
//
// Only meaningful when the UI language is not English; --lang en skips it.
// Everything below is about *tagged UI copy*, so the allowlist matters more
// than the detector: product names, hostnames, file paths, hex hashes, IDs,
// cron expressions, locale codes and units are English by nature and are not
// leaks. A bare allowlist of whole strings would miss "Save changes", so the
// test is per-token: a text node qualifies as translated-looking when it
// contains CJK; otherwise it is flagged only if it reads as prose (two or more
// Latin words) and none of those words is a known-legitimate term.
// Single source of truth for "this Latin word is not English copy": product
// and vendor names, protocol/format vocabulary, and units. Two copies of this
// list previously drifted apart inside the probe and at module scope, which is
// how the mixed-script check below ended up referencing a name that only
// existed in one of them.
const EN_KEEP = [
  "chromium", "chrome", "firefox", "webkit", "gecko", "safari", "edge",
  "amazon", "google", "netflix", "disney", "stun", "webrtc", "drm", "widevine",
  "cdm", "gpu", "cpu", "ram", "macos", "windows", "linux", "ubuntu", "android",
  "ios", "mac", "iphone", "ipad", "sql", "csv", "json", "html", "http", "https",
  "api", "llm", "mcp", "cli", "ui", "ux", "id", "url", "uri", "hash", "dns",
  "socks", "socks5", "tls", "ssl", "cidr", "px", "ms", "kb", "mb", "gb", "tb",
  "ipv4", "ipv6", "nat", "rtc", "cdn", "jwt", "otp", "totp", "dpi", "unpacked",
  "crx", "zip", "app", "s3", "aws", "gcp", "azure", "oss", "saas", "os", "vm",
  "vps",
];
const KEEP_WORDS = new Set(EN_KEEP);

// ── Audit: untranslated copy in a non-English UI ────────────────────────────
// check-i18n.mjs guards the *source* (CJK text with no key, CJK literals in
// JS). It structurally cannot see the opposite leak: an English string baked
// into a JS render path ships verbatim into the zh UI, and the source contains
// no CJK for the gate to notice. That is the shape of every defect this probe
// found (sync.js "Device ID", accounts.js "password saved", the extensions
// SHARED/PRIVATE badges).
//
// The oracle is differential rather than heuristic. The same tab is rendered
// with the UI in zh and in en; any text node whose value is *identical* in both
// was never passed through the translation table, whatever it happens to say.
// Earlier versions of this audit guessed from word shape against allowlists and
// a fixture corpus, which is why they mis-filed datum names as leaks and missed
// one-word buttons like "Update". Comparing the two renders removes the guess:
//
//   - translated copy differs between locales  -> ignored
//   - fixture data (profile names, job errors) is identical in both too, so a
//     second gate requires the string to read as English prose. Identifiers,
//     hashes, paths, hosts, locale codes and units are filtered per word.
//
// Known limit: a fixture value that is itself an English sentence (a job error
// like "step 9 failed") is indistinguishable from copy by this method and does
// get reported. Treat those hits as "confirm against the fixture" rather than
// automatic defects — this audit produces a reviewer's shortlist, not a verdict.
//
// Only meaningful when the UI language is not English; --lang en skips it.
const EN_PROSE_MIN_WORDS = 2;

// Strings that are correct as English in every locale. Each entry is a claim
// that translating it would be wrong, not a claim that it is untranslatable:
//   - the product name, which is a brand and never localised
//   - "Chrome Web Store", a proper noun for a third-party service
//   - the running engine's display name, which identifies the binary
// The value is the reason, so a future reader can tell a decision from a dodge.
const EN_INTENTIONALLY_ENGLISH = new Map([
  ["agent browser studio managed chromium", "engine display name"],
  ["chrome web store", "third-party proper noun"],
]);

// Role names are the one piece of real UI copy that stays English by design:
// they name stored API values (viewer/member/admin/owner) that also appear in
// config files and docs, so localising them would break that mapping. They live
// in the dictionary as identical zh/en entries, which is why the differential
// test sees them as "untranslated" — this set is that intent, expressed once.
const ROLE_WORDS = new Set(["owner", "admin", "member", "viewer"]);

function isIntentionallyEnglish(text) {
  const norm = text.replace(/\s+/g, " ").trim().toLowerCase();
  for (const [keep] of EN_INTENTIONALLY_ENGLISH) {
    if (norm === keep || norm.includes(keep)) return true;
  }
  return false;
}

// Every string literal the mock can hand to the renderer, as whole values and
// as individual words. Read from the source rather than hand-listed so adding a
// fixture cannot silently widen a manual allowlist — the corpus tracks the data
// automatically. The word set exists because the UI *composes* data with
// chrome: the local-device badge renders `<device name> · <role>`, which is not
// a fixture literal but is entirely data plus a deliberately-untranslated role.
function mockFixtureStrings() {
  const src = readFileSync(path.join(ROOT, "scripts", "visual-mock.js"), "utf-8");
  const whole = new Set();
  const words = new Set();
  for (const m of src.matchAll(/'([^'\\\n]{2,})'|"([^"\\\n]{2,})"/g)) {
    const lit = (m[1] ?? m[2]).replace(/\s+/g, " ").trim().toLowerCase();
    if (lit) whole.add(lit);
    for (const w of lit.split(/[\s·|,;:()[\]{}<>/\\→]+/)) {
      const bare = w.replace(/[.,;:!?()"'’]+$/g, "");
      if (bare.length >= 2) words.add(bare);
    }
  }
  return { whole, words };
}

async function auditEnglishLeak(browser) {
  const theme = THEMES[0];               // a copy defect is not theme-specific
  const fixtures = mockFixtureStrings();
  const collect = async (lang) => {
    const { ctx, page } = await openPage(browser, theme, WIDTH, HEIGHT, TEAM_EMPTY, lang);
    const perTab = {};
    for (const tab of TABS) {
      await goTab(page, tab);
      perTab[tab] = await page.evaluate(({ minWords, keep }) => {
        const CJK = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;
        const KEEP = new Set(keep);
        const HOSTISH = /^[\w.-]+\.(com|net|org|io|dev|cn|co|local|example|internal)\b/i;
        const PATHISH = /^(~?\/|[A-Za-z]:\\|\.\/|\.\.\/)/;
        const HEXISH = /^[0-9a-f]{6,}$/i;
        const IDENT = /^[\w-]+(_[\w-]+)+$/;
        const TZ = /^(UTC|GMT|[A-Za-z]+\/[A-Za-z_]+)$/;
        const LOCALE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;
        const VERSION = /^v?\d+(\.\d+)*$/;
        const out = [];
        const seen = new Set();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const raw = (node.nodeValue || "").replace(/\s+/g, " ").trim();
          if (raw.length < 3) continue;
          const el = node.parentElement;
          if (!el) continue;
          // Machine-readable regions: code, paths, raw data.
          if (el.closest("pre, code, script, style, textarea, input, .mono")) continue;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.15) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          // Only the visible pane: other tabs stay mounted but hidden.
          if (el.closest(".tab-content:not(.active)")) continue;
          if (el.closest("#sidebar")) continue;   // nav copy is checked by check-i18n
          if (el.closest("[data-i18n-en-ok]")) continue;
          const words = raw.split(/[\s·|,;:()\[\]{}<>\/\\]+/).filter(Boolean);
          const prose = words.filter((w) => {
            const bare = w.replace(/[.,;:!?()"'’]+$/g, "");
            if (bare.length < 2) return false;
            if (KEEP.has(bare.toLowerCase())) return false;
            if (HOSTISH.test(bare) || PATHISH.test(bare) || HEXISH.test(bare)) return false;
            if (IDENT.test(bare) || TZ.test(bare) || LOCALE.test(bare) || VERSION.test(bare)) return false;
            if (/^\d/.test(bare) || /^[A-Z]$/.test(bare)) return false;
            return /^[A-Za-z][A-Za-z'’-]*$/.test(bare);
          });
          const key = raw.slice(0, 80);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            text: raw.slice(0, 120),
            sel: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
              (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""),
            hasCJK: CJK.test(raw),
            proseCount: prose.length,
            prose,                       // array: filtered again after the diff
            proseList: prose.slice(0, 6).join(", "),
            minWords,
          });
        }
        return out;
      }, { minWords: EN_PROSE_MIN_WORDS, keep: EN_KEEP }).catch(() => []);
    }
    await ctx.close();
    return perTab;
  };

  const zh = await collect("zh-CN");
  const en = await collect("en-US");
  const rows = [];
  for (const tab of TABS) {
    const enTexts = new Set((en[tab] || []).map((e) => e.text));
    for (const z of zh[tab] || []) {
      // Different in en => it went through the dictionary (translated).
      if (!enTexts.has(z.text)) continue;
      // Already Chinese => normally not a leak. But a CJK string with a Latin
      // word stuck to it is the signature of a *partial* translation: zh chrome
      // concatenated with either a raw stored enum or copy the template hardcoded
      // in English. That shipped as "由system" and was invisible to the whole-
      // string test above, because the CJK bail-out skipped the node entirely.
      // Allow a space or an interpunct between the two, since those are the
      // separator conventions this UI already uses.
      if (z.hasCJK) {
        // The discriminator is *separation*, not adjacency. A Chinese sentence
        // may legitimately borrow an English technical term and space it out
        // ("push/pull 前变更对比", "Team Diff 预览") — that is a translator's
        // choice. A leak is different: untranslated copy or a raw enum butted
        // straight against CJK with no delimiter, because the join assumed a
        // separator the dictionary value did not have. That shipped as
        // "由system" and "事件stopped". So require zero separation.
        const GLUED = /[一-鿿][A-Za-z]{3,}|[A-Za-z]{3,}[一-鿿]/;
        if (!GLUED.test(z.text)) continue;
        // Deliberately NOT consulted here: the fixture corpus. It exists for
        // the whole-string gate, where a fixture value is painted verbatim as
        // data. In this branch the CJK proves the string came *through* the
        // dictionary, so a Latin run glued to it cannot be "just fixture data" —
        // `actor: "system"` is in the corpus as an enum the UI is supposed to
        // name, and exempting it here is precisely what let "由system" through
        // when this check was first written.
        const latinWords = (z.text.match(/[A-Za-z][A-Za-z'’-]{2,}/g) || []);
        const unexplainedMixed = latinWords.filter((w) => {
          const low = w.toLowerCase();
          return !ROLE_WORDS.has(low) && !KEEP_WORDS.has(low) && !isIntentionallyEnglish(low);
        });
        if (!unexplainedMixed.length) continue;
        rows.push({ tab, sel: z.sel, text: z.text, words: unexplainedMixed, identicalIn: "zh+en (glued)" });
        continue;
      }
      // Second gate: fixture values (profile names, job results, team member
      // names) are identical across locales too, but they are data the user
      // supplies, not copy we author. Matching the corpus verbatim settles it.
      if (fixtures.whole.has(z.text.toLowerCase())) continue;
      // Third gate: copy that is deliberately English (brand, proper noun).
      if (isIntentionallyEnglish(z.text)) continue;
      // Third gate, composed form: the UI mixes data into chrome (the local
      // badge renders "<device name> · <role>"). Such a string is not copy if
      // every English word in it is either a fixture token or a role name, so
      // score the words the way gate one scores the whole value.
      const unexplained = z.prose.filter((w) => {
        const bare = w.replace(/[.,;:!?()"'’]+$/g, "").toLowerCase();
        return !fixtures.words.has(bare) && !isIntentionallyEnglish(bare) &&
          !ROLE_WORDS.has(bare) && !/^[一-鿿]+$/.test(bare);
      });
      // Identical in both languages AND still reading as English prose once the
      // data and role terms are accounted for => the string bypassed i18n. A
      // single unexplained word is more likely an identifier that survived the
      // per-word filters, so require prose.
      if (unexplained.length < EN_PROSE_MIN_WORDS) continue;
      rows.push({ tab, sel: z.sel, text: z.text, words: unexplained, identicalIn: "zh+en" });
    }
  }
  return rows;
}

function printEnglishLeak(rows) {
  console.log(`\n=== untranslated copy (same text in zh and en) ===`);
  if (LANG === "en-US") { console.log("skipped (lang=en)"); return []; }
  if (!rows.length) { console.log("clean — every visible string changes with the language"); return rows; }
  for (const r of rows) console.log(`  [${r.tab}] ${r.sel} — "${r.text}" (words: ${r.words})`);
  return rows;
}

// ── Geometry dump ───────────────────────────────────────────────────────────
// Prints the *laid out* box of a subtree. Every row carries the box's vertical
// centre (cy), so a misaligned row is readable as two siblings with different
// cy, and a mis-sized box as a width/height that disagrees with its siblings.
async function dumpTree(browser) {
  const { ctx, page } = await openPage(browser, THEMES[0]);
  await goTab(page, DUMP);
  const lines = await page.evaluate(({ sel, depth, tab }) => {
    const scoped = sel ? document.querySelector(sel) : null;
    const root = scoped || document.getElementById("tab-" + tab) || document.body;
    const out = [];
    const describe = (el) => {
      const id = el.id ? "#" + el.id : "";
      const cls = typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
        : "";
      return el.tagName.toLowerCase() + id + cls;
    };
    const walk = (el, level, parent) => {
      if (level > depth || out.length > 400) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none") return;
      const r = el.getBoundingClientRect();
      const bits = [
        `${Math.round(r.width)}x${Math.round(r.height)}`,
        `@${Math.round(r.left)},${Math.round(r.top)}`,
        `cy=${Math.round(r.top + r.height / 2)}`,
      ];
      if (parent) {
        const pr = parent.getBoundingClientRect();
        bits.push(`Δcy=${Math.round(r.top + r.height / 2 - (pr.top + pr.height / 2))}`);
      }
      if (cs.display.includes("flex") || cs.display.includes("grid")) {
        bits.push(cs.display);
        bits.push(cs.display.includes("grid")
          ? `cols=${cs.gridTemplateColumns} gap=${cs.gap}`
          : `dir=${cs.flexDirection} align=${cs.alignItems} gap=${cs.gap}`);
      }
      if (!el.children.length && el.textContent.trim()) {
        bits.push(`font=${Math.round(parseFloat(cs.fontSize))}/${cs.lineHeight} w=${cs.fontWeight}`);
        bits.push(`"${el.textContent.trim().slice(0, 30)}"`);
      }
      out.push(`${"  ".repeat(level)}${describe(el)}  [${bits.join(" ")}]`);
      for (const c of el.children) walk(c, level + 1, el);
    };
    walk(root, 0, null);
    return out;
  }, { sel: DUMP_SELECTOR, depth: DUMP_DEPTH, tab: DUMP });
  console.log(`\n=== dump: ${DUMP_SELECTOR || "#tab-" + DUMP} (depth ${DUMP_DEPTH}, ${THEMES[0]}) ===`);
  for (const l of lines) console.log(l);
  await ctx.close();
}

// ── Report sections ─────────────────────────────────────────────────────────

function printErrors(errors) {
  console.log(`\n=== runtime exceptions ===`);
  if (!errors.length) console.log("clean");
  for (const e of errors) {
    console.log(`  [${e.theme}] ${e.what}`);
    for (const f of e.frames) console.log(`      ${f.fn} — ${f.file}:${f.line}`);
  }
}

function printOverflow(rows) {
  console.log(`\n=== overflow @${flag("width", 700)}px ===`);
  if (!rows.length) console.log("clean");
  for (const r of rows) console.log(`  [${r.theme}/${r.tab}] ${r.kind} ${r.sel} — ${r.detail}`);
}

function printContrast(rows) {
  console.log(`\n=== contrast (WCAG AA) ===`);
  if (!rows.length) console.log("clean");
  for (const r of rows) console.log(`  [${r.theme}/${r.tab}] ${r.ratio}:1 (need ${r.need}) ${r.size}px ${r.sel} — "${r.text}"`);
}

function printIcons(rows) {
  console.log(`\n=== icon / text vertical alignment ===`);
  if (!rows.length) console.log("clean");
  for (const r of rows) {
    // `baseline` is a cause, `offset` is a measurement: the host is already a
    // centred flex row but the icon still sits off-centre.
    const why = r.kind === "baseline" ? "BASELINE-ALIGNED" : "off-centre";
    console.log(`  [${r.theme}/${r.tab}] ${why} ${r.delta}px off (limit ${r.limit}px) ${r.sel} — icon ${r.box}, text ${r.size}px, host ${r.display}`);
    console.log(`      in <${r.parent}>  "${r.text}"`);
  }
}

function printCoverage(dead, unstubbed) {
  console.log(`\n=== mock coverage (${REAL_API.size} real API paths) ===`);
  if (!dead.length && !unstubbed.length) {
    console.log("clean — every API the renderer called has a fixture");
  }
  if (dead.length) {
    console.log(`  ${dead.length} DEAD CALL SITE(S) — not in preload.cjs, so these silently no-op:`);
    for (const m of dead) console.log(`  ! ${m}`);
  }
  if (unstubbed.length) {
    console.log(`  ${unstubbed.length} unstubbed path(s) — these tabs rendered with the empty-array fallback:`);
    for (const m of unstubbed) console.log(`  · ${m}`);
  }
}

function printCensus(counts) {
  const thin = counts.filter((c) => c.thin || c.missing);
  console.log(`\n=== content census (per tab: text / cards / empty-state) ===`);
  for (const c of counts) {
    if (c.missing) { console.log(`  ${c.tab.padEnd(11)}  NO SUCH PANE (#tab-${c.tab})`); continue; }
    const flag = c.thin ? "THIN — only an empty state, audit pass is vacuous" : "";
    console.log(`  ${c.tab.padEnd(11)} ${String(c.chars).padStart(5)} chars  ${String(c.cards).padStart(2)} cards  ${String(c.empty).padStart(2)} empty  ${flag}`);
  }
  if (thin.length) {
    console.log(`  ${thin.length} tab(s) rendered only an empty state — fill the mock before trusting their pass.`);
  }
  return thin;
}

function printGarbage(counts) {
  const garbage = counts.filter((c) => c.garbage && c.garbage.length);
  console.log(`\n=== rendered-text sanity (undefined / NaN / [object Object]) ===`);
  if (!garbage.length) console.log("clean");
  for (const c of garbage) {
    for (const g of c.garbage) console.log(`  [${c.tab}] literal "${g.token}" — …${g.line}…`);
  }
  return garbage;
}

// ── Audit: selector references with no producer ─────────────────────────────
// Every other pass here runs the renderer, so each one is bounded by what the
// fixture happens to render. A `querySelector(".foo")` whose `.foo` no template
// emits is invisible to all of them: the lookup returns null, and the handler
// either no-ops (a control that silently does nothing) or throws on the next
// property access (a crash on click). Neither surfaces as an exception, because
// nothing in the sweep clicks that control. This pass is static on purpose.
//
// Scope is deliberately narrow so the signal stays clean. Only pure `.class` and
// `#id` literals are resolved; anything with a combinator, attribute selector,
// pseudo-class, or a name built by concatenation is skipped, because it cannot
// be resolved without running the renderer and guessing would produce noise.
// A literal ending in `-`/`_` is the concatenation case
// (`getElementById("detect-" + name)`) — skipped for the same reason.
function auditSelectors() {
  const appDir = path.join(ROOT, "src/renderer/js/app");
  const files = [
    path.join(ROOT, "src/renderer/index.html"),
    ...(existsSync(appDir) ? readdirSync(appDir).filter((f) => f.endsWith(".js")).map((f) => path.join(appDir, f)) : []),
  ].filter((f) => existsSync(f));
  const sources = files.map((f) => ({ f, src: readFileSync(f, "utf-8") }));

  // Producers. A class attribute is usually split across a concatenation
  // (`class="profile-card' + (x ? ' running' : '')`), so take the first token
  // run after the opening quote instead of requiring a closed attribute.
  const produced = new Set();
  const addClasses = (run) => {
    for (const tok of String(run).split(/\s+/)) {
      const clean = tok.replace(/[^A-Za-z0-9_-].*$/, "");
      if (clean) produced.add("." + clean);
    }
  };
  for (const { src } of sources) {
    for (const m of src.matchAll(/class\s*=\s*["'`]\s*([A-Za-z0-9_][A-Za-z0-9_ -]*)/g)) addClasses(m[1]);
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*["']([^"']+)/g)) addClasses(m[1]);
    for (const m of src.matchAll(/className\s*=\s*["']([^"']*)/g)) addClasses(m[1]);
    for (const m of src.matchAll(/\bid\s*=\s*["']([^"']+)/g)) produced.add("#" + m[1]);
  }

  const REF = /(?:querySelectorAll|querySelector|closest|matches)\(\s*["']([^"']+)["']|getElementById\(\s*["']([^"']+)["']/g;
  const refs = new Map();
  for (const { f, src } of sources) {
    if (f.endsWith(".html")) continue; // the markup queries nothing
    src.split("\n").forEach((line, i) => {
      REF.lastIndex = 0;
      let m;
      while ((m = REF.exec(line))) {
        const sel = m[2] ? "#" + m[2] : m[1];
        if (!/^[.#][A-Za-z0-9_-]+$/.test(sel)) continue;
        if (/[-_]$/.test(sel)) continue; // concatenated name
        if (!refs.has(sel)) refs.set(sel, []);
        refs.get(sel).push(`${path.relative(ROOT, f)}:${i + 1}`);
      }
    });
  }

  const out = [];
  for (const [sel, sites] of refs) if (!produced.has(sel)) out.push({ sel, sites });
  out.sort((a, b) => (a.sel < b.sel ? -1 : a.sel > b.sel ? 1 : 0));
  return out;
}

function printSelectors(rows) {
  console.log("\n=== selector references with no producer ===");
  if (!rows.length) {
    console.log("clean — every .class / #id a handler looks up is emitted somewhere");
    return rows;
  }
  for (const r of rows) {
    console.log(`  DEAD SELECTOR ${r.sel} — no template emits it, so the lookup is always null`);
    for (const s of r.sites.slice(0, 4)) console.log(`      at ${s}`);
  }
  return rows;
}

// ── Main ────────────────────────────────────────────────────────────────────
const bin = resolveChromium();
if (!bin) {
  console.error("No Playwright Chromium found. Run: npx playwright install chromium");
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: bin });
try {
  if (DUMP) {
    await dumpTree(browser);
  } else if (ONLY) {
    // Fast iteration on a single audit.
    const runners = {
      icons: async () => { const r = await auditIconAlign(browser); printIcons(r); return r.length; },
      contrast: async () => { const r = await auditContrast(browser); printContrast(r); return r.length; },
      overflow: async () => { const r = await auditOverflow(browser, Number(flag("width", 700))); printOverflow(r); return r.length; },
      errors: async () => { const r = await auditErrors(browser); printErrors(r); return r.length; },
      selectors: async () => { const r = auditSelectors(); printSelectors(r); return r.length; },
      headerorder: async () => { const r = await auditHeaderOrder(browser); printHeaderOrder(r); return r.length; },
      english: async () => { const r = await auditEnglishLeak(browser); printEnglishLeak(r); return LANG === "en-US" ? 0 : r.length; },
    };
    const run = runners[ONLY];
    if (!run) {
      console.error(`Unknown --only value "${ONLY}". Known: ${Object.keys(runners).join(", ")}`);
      process.exit(2);
    }
    const n = await run();
    console.log(`\n${n === 0 ? "PASS" : "FAIL"}: ${n} violation(s) in "${ONLY}"`);
    if (n > 0) process.exitCode = 1;
  } else if (AUDIT) {
    const errors = await auditErrors(browser);
    const overflow = await auditOverflow(browser, Number(flag("width", 700)));
    const contrast = await auditContrast(browser);
    const icons = await auditIconAlign(browser);
    const { rows: counts, dead, unstubbed } = await censusAndCoverage(browser);
    const selectors = auditSelectors();
    const english = await auditEnglishLeak(browser);
    const headerOrder = await auditHeaderOrder(browser);
    printErrors(errors);
    printOverflow(overflow);
    printContrast(contrast);
    printIcons(icons);
    printHeaderOrder(headerOrder);
    printSelectors(selectors);
    printCoverage(dead, unstubbed);
    const thin = printCensus(counts);
    const garbage = printGarbage(counts);
    printEnglishLeak(english);
    // Dead call sites, leaked `undefined`, and untranslated copy are real
    // defects; thin tabs and unstubbed paths are harness debt that silently
    // undermines the rest.
    const enFails = LANG === "en-US" ? 0 : english.length;
    const failures = overflow.length + contrast.length + errors.length + dead.length + garbage.length + icons.length + selectors.length + headerOrder.length + enFails;
    console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${errors.length} exceptions, ${overflow.length} overflow, ${contrast.length} contrast, ${icons.length} icon misalignments, ${headerOrder.length} header order, ${selectors.length} dead selectors, ${dead.length} dead call sites, ${garbage.length} garbage text, ${enFails} untranslated, ${unstubbed.length} unstubbed, ${thin.length} thin`);
    // Non-zero exit so --audit works as a gate in CI or an automation, not just
    // as something a human reads.
    if (failures > 0) process.exitCode = 1;
  } else {
    const files = await shoot(browser);
    console.log(`\n${files.length} screenshots in ${OUT}`);
  }
} finally {
  await browser.close();
}
