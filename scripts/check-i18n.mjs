#!/usr/bin/env node
/**
 * i18n guard (review items UE-02 / TE-07).
 *
 * Before this check shipped, index.html carried ~37 lines of hard-coded
 * Chinese with no data-i18n key, so switching the UI to English left those
 * strings Chinese. This script fails the build when:
 *  1. a user-visible string in the renderer contains CJK but its element has
 *     no data-i18n key (HTML);
 *  2. a user-visible JS string literal contains CJK outside the translation
 *     table itself;
 *  3. the zh-CN and en-US key sets in i18n.js disagree.
 *
 * Usage: node scripts/check-i18n.mjs [--strict]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML = path.join(ROOT, "src/renderer/index.html");
const I18N = path.join(ROOT, "src/renderer/js/i18n.js");
const JS_DIRS = [path.join(ROOT, "src/renderer/js/app")];
const MAIN_I18N = path.join(ROOT, "src/main/services/main-i18n.ts");
let mainKeyReport = null;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
// `zh ? "一致性" : "Consistency"` — inline bilingual, already serves both locales.
const BILINGUAL_TERNARY = /\?\s*["'][^"']*[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff][^"']*["']\s*:\s*["']/;
const strict = process.argv.includes("--strict");

const problems = [];

// ── 1. HTML: CJK text without a data-i18n key on the same element ──────────
if (fs.existsSync(HTML)) {
  const lines = fs.readFileSync(HTML, "utf-8").split("\n");
  lines.forEach((raw, index) => {
    if (!CJK.test(raw)) return;
    if (raw.includes("data-i18n")) return;
    // Collect the CJK runs so the report shows what needs a key.
    const runs = [];
    const re = />([^<>]*[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef][^<>]*)</g;
    let m;
    while ((m = re.exec(raw))) runs.push(m[1].trim());
    const attrRe = /(?:placeholder|title)="([^"]*[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef][^"]*)"/g;
    while ((m = attrRe.exec(raw))) runs.push(m[1].trim());
    if (!runs.length) return;
    problems.push({
      file: "src/renderer/index.html",
      line: index + 1,
      kind: "html-missing-i18n-key",
      text: runs.join(" | ").slice(0, 120),
    });
  });
}

// ── 1b. HTML: English text without a data-i18n key on the same element ─────
// The mirror image of check 1. Check 1 only caught hard-coded Chinese leaking
// into the English UI; nothing caught hard-coded English leaking into the
// Chinese UI, which is how ~50 static labels (Loading..., Close, Import
// Existing Profiles, the whole skill editor, …) stayed English in zh-CN until
// R144. This pass matches per element rather than per line, so a line that
// happens to carry a data-i18n somewhere else no longer hides its siblings.
const LATIN_TEXT = /[A-Za-z]{2,}/;
// Identifiers and code samples that are legitimately the same in every locale.
const LATIN_SKIP_TAG = /^(option|code|script|style|title|pre|svg|path)$/i;
const LATIN_ALLOW_TEXT = new Set(["Agent Browser Studio"]);
const LATIN_ALLOW_RE = [
  /^v\d+(\.\d+)+$/,       // version strings: v1.0.0
  /^(EN|ZH|EN-US|ZH-CN)$/i, // the language toggle shows the *other* language
  /^--/,                  // CLI flags: --fingerprint=<seed>
];
// R146: this pass used to run line-by-line, which made it blind to exactly the
// strings it exists to find — copy that a formatter wrapped across lines. An
// element whose text spans two lines never matched the single-line tag regex,
// so the extensions dialog footer and the fingerprint dialog note stayed
// English in zh-CN while the check reported success. It now walks the whole
// document; the reported line number is derived from the match offset.
if (fs.existsSync(HTML)) {
  const html = fs.readFileSync(HTML, "utf-8");
  const lineOf = (offset) => html.slice(0, offset).split("\n").length;
  const tagRe = /<([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)>([^<]*)<\/\1\s*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1];
    const attrs = m[2] || "";
    const text = (m[3] || "").replace(/\s+/g, " ").trim();
    if (!text || !LATIN_TEXT.test(text)) continue;
    if (CJK.test(text)) continue; // inline bilingual, serves both locales
    if (LATIN_SKIP_TAG.test(tag)) continue;
    if (attrs.includes("data-i18n")) continue;
    if (attrs.includes("data-i18n-en-ok")) continue;
    if (LATIN_ALLOW_TEXT.has(text)) continue;
    if (LATIN_ALLOW_RE.some((re) => re.test(text))) continue;
    problems.push({
      file: "src/renderer/index.html",
      line: lineOf(m.index),
      kind: "html-missing-i18n-key-latin",
      text: "<" + tag + "> " + text.slice(0, 100),
    });
  }
}

// ── 1b-ii. HTML: English `placeholder` without a data-i18n-placeholder ─────
// Section 1b scans element *text*, so it is structurally blind to attributes —
// and a placeholder is visible copy that sits in an attribute. That is how
// "e.g. 54321" (the fingerprint-seed field) and "My First Profile" (wizard step
// 2) stayed English in a zh-CN UI while 1b reported success, even though the
// seed field's own sibling input already carried data-i18n-placeholder.
//
// Format examples are *not* copy: a SQL starter (`SELECT * FROM customers`), a
// proxy-import sample (`socks5://user:pass@1.2.3.4:1080`) or a bulk-import
// column order are the same bytes in every locale and translating them would
// misrepresent the input the user must type. Those opt out explicitly with
// data-i18n-en-ok, matching how 1b handles the same judgement, so each
// exemption is a visible decision in the markup rather than a silent rule.
if (fs.existsSync(HTML)) {
  const html = fs.readFileSync(HTML, "utf-8");
  const lineOf = (offset) => html.slice(0, offset).split("\n").length;
  const attrRe = /<([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)>/g;
  let m;
  while ((m = attrRe.exec(html))) {
    const attrs = m[2] || "";
    const ph = attrs.match(/\splaceholder\s*=\s*"([^"]*)"/);
    if (!ph) continue;
    const text = ph[1].replace(/&#10;/g, " ").replace(/\s+/g, " ").trim();
    if (!text || !LATIN_TEXT.test(text)) continue;
    if (CJK.test(text)) continue;             // inline bilingual, serves both
    if (attrs.includes("data-i18n-placeholder")) continue;
    if (attrs.includes("data-i18n-en-ok")) continue;
    if (LATIN_ALLOW_RE.some((re) => re.test(text))) continue;
    problems.push({
      file: "src/renderer/index.html",
      line: lineOf(m.index),
      kind: "html-placeholder-missing-i18n-key",
      text: "<" + m[1] + ' placeholder="' + text.slice(0, 80) + '">',
    });
  }
}

// ── 1c. JS: t('key', …) call sites whose key exists in no locale ───────────
// Such a call always renders its fallback, in *both* languages, so the string
// silently ignores i18n. Two had Chinese fallbacks and therefore leaked Chinese
// into the English UI ("清空失败: "). Nothing caught this before: the CJK pass
// skips fallbacks (they are the translation) and the latin pass only reads HTML.
// Scanned after the dictionary is parsed so it can be checked against it.
function collectDefinedKeys() {
  if (!fs.existsSync(I18N)) return null;
  const src = fs.readFileSync(I18N, "utf-8");
  const keys = new Set();
  const re = /^\s{6}"([A-Za-z0-9_.\-]+)"\s*:/gm;
  let m;
  while ((m = re.exec(src))) keys.add(m[1]);
  return keys;
}
const DEFINED_KEYS = collectDefinedKeys();

// Drop CRLF's CR before the end-anchored comment filters below, so documented
// counterexamples are ignored consistently across checkout line endings.
function findUndefinedKeys() {
  if (!DEFINED_KEYS) return [];
  const found = [];
  for (const dir of JS_DIRS) {
    for (const file of walk(dir)) {
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      lines.forEach((line, index) => {
        // Strip comments first: a comment that *names* a key (as the fix for one
        // of these writes does) is documentation, not a call site.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!code.includes("t(")) return;
        const re = /\bt\(\s*["']([A-Za-z0-9_.\-]+)["']\s*,/g;
        let m;
        while ((m = re.exec(code))) {
          if (DEFINED_KEYS.has(m[1])) continue;
          found.push({
            file: path.relative(ROOT, file),
            line: index + 1,
            kind: "i18n-key-not-defined",
            text: m[1] + "  — always falls back, in both locales",
          });
        }
      });
    }
  }
  return found;
}

// ── 1d. JS: separators that live in the English fallback only ──────────────
// A call like `x + t('k', ' 行')` puts the joining whitespace in the *fallback*
// string. The dictionary value for that key has no such edge space, so the
// moment a locale supplies a real translation the parts collide: EN rendered
// "JS ×3profiles" and "128rows", and the zh entry had to compensate with its
// own leading space. This is a layout decision smuggled into a string literal.
//
// A value that already ends in punctuation (：。？！、）) or already carries the
// space separates itself, so those are not reported — otherwise every
// `t('k', 'Failed: ')` in the codebase would be noise.
const SELF_SEPARATING_END = /[：:。！？，、；（）()\]]$/;
const SELF_SEPARATING_START = /^[：:。！？，、；（）()\[]/;

function collectI18nValues() {
  if (!fs.existsSync(I18N)) return new Map();
  const src = fs.readFileSync(I18N, "utf-8");
  const byKey = new Map();
  const re = /"([A-Za-z0-9_.\-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(src))) {
    if (!byKey.has(m[1])) byKey.set(m[1], new Set());
    byKey.get(m[1]).add(m[2]);
  }
  return byKey;
}
const I18N_VALUES = collectI18nValues();

function findSeparatorLeaks() {
  const found = [];
  for (const dir of JS_DIRS) {
    for (const file of walk(dir)) {
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!code.includes("t(")) return;
        // Quote handling: a fallback may contain the *other* quote char (and
        // often does, e.g. 'Delete proxy "{name}"?'). Match the literal as the
        // same quote style that opened it, so the capture does not stop at an
        // embedded quote and report a truncated fragment.
        const re = /\bt\(\s*(['"])([A-Za-z0-9_.\-]+)\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g;
        let m;
        while ((m = re.exec(code))) {
          const key = m[2];
          const fb = m[4];
          const trailing = /\s$/.test(fb);
          const leading = /^\s/.test(fb);
          if (!trailing && !leading) continue;
          const values = I18N_VALUES.get(key);
          if (!values) continue; // undefined keys are 1c's job
          // A fallback carrying {placeholders} is already a whole-sentence
          // template; the edge space is padding inside the sentence, and the
          // call site substitutes before rendering.
          if (/\{[a-zA-Z]/.test(fb)) continue;
          const separated = [...values].every((v) =>
            trailing
              ? (/\s$/.test(v) || SELF_SEPARATING_END.test(v))
              : (/\s/.test(v[0] || "") || SELF_SEPARATING_START.test(v)));
          if (separated) continue;
          found.push({
            file: path.relative(ROOT, file),
            line: index + 1,
            kind: "i18n-separator-in-fallback",
            text: `${key} — fallback ${JSON.stringify(fb)} pads with whitespace the dictionary value lacks; use a whole-sentence template`,
          });
        }
      });
    }
  }
  return found;
}

// ── 1e. Dictionary values that drop a placeholder the fallback supplies ────
// Every `t(key, fallback)` is called as `t(key, fb).replace("{x}", …)`. When a
// refactor rewrites a multi-fragment sentence into one template — which is what
// the R146 pass did across the codebase — the *call site* keeps its placeholders
// but the dictionary entry can be left holding the old fragment. The call then
// renders that fragment verbatim and the interpolated values vanish.
//
// Two shipped this way: `db.table-head` had become a bare "·" (the whole
// "{table} · {shown}/{total} rows" sentence was gone, so the SQL result grid
// printed a lone separator instead of a caption) and `db.no-result` had become
// "(no result," — an unclosed bracket and no count. Both are invisible to every
// other gate: the key exists in both locales, the string is non-empty, and it
// renders without throwing. The comparison has to be made *against the call
// site*, which is the only place that knows the sentence needs those values.
//
// A fallback with no placeholders cannot disagree, so only calls whose fallback
// has at least one `{x}` are compared.
//
// Each locale is merged *separately* across the three dictionaries, in source
// order, because that is what i18n.js does (`Object.assign(dict[locale], …)`).
// Reading one flat map and letting the last write win silently resolves every
// key to its en-US value, which makes the check blind in exactly the direction
// that matters — a zh entry losing its placeholder would be compared against
// the intact English one and pass. That is not hypothetical: it is how the
// first version of this check reported green on a planted zh defect.
const placeholders = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]));

function collectValuesByLocale() {
  const byLocale = new Map();                 // locale -> Map(key -> value)
  if (!fs.existsSync(I18N)) return byLocale;
  const lines = fs.readFileSync(I18N, "utf-8").split("\n");
  const localeRe = /^\s*"(zh-CN|en-US)"\s*:\s*\{/;
  const entryRe = /^\s*"([A-Za-z0-9_.\-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
  let locale = null;
  for (const line of lines) {
    const l = line.match(localeRe);
    if (l) { locale = l[1]; continue; }
    if (!locale) continue;
    const e = line.match(entryRe);
    if (!e) continue;
    if (!byLocale.has(locale)) byLocale.set(locale, new Map());
    byLocale.get(locale).set(e[1], e[2]);     // last write wins within a locale
  }
  return byLocale;
}
const VALUES_BY_LOCALE = collectValuesByLocale();

// ── 1f. dict shadowing that leaks raw placeholders ─────────────────────────
// The dict is built from several merged object literals, so a key can be
// defined more than once *within a locale* — the last definition wins.
// Duplicate keys across locales (zh + en) are normal and must NOT be counted.
// When the winner carries a {placeholder} and a call site references the key
// without substituting it, the user sees a literal "{msg}".
const BILINGUAL_VALUES = collectI18nValues();

function winnerPerLocale() {
  if (!fs.existsSync(I18N)) return new Map();
  const src = fs.readFileSync(I18N, "utf-8");
  const lines = src.split("\n");
  // Locale blocks are the object literals assigned under each language key.
  // Track the block by the language marker each literal belongs to.
  const byLocale = new Map();  // locale -> Map(key -> [values in order])
  let locale = null;
  const marker = /^\s*"?((?:zh|en)-[A-Z]{2})"?\s*:\s*\{\s*$/;
  for (const line of lines) {
    const mk = line.match(marker);
    if (mk) { locale = mk[1]; continue; }
    if (/^\s*\},?\s*$/.test(line)) { locale = null; continue; }
    if (!locale) continue;
    const km = line.match(/^\s{6}"([A-Za-z0-9_.\-]+)"\s*:\s*"((?:[^"\\]|\\.)*)",?\s*$/);
    if (!km) continue;
    if (!byLocale.has(locale)) byLocale.set(locale, new Map());
    const m = byLocale.get(locale);
    if (!m.has(km[1])) m.set(km[1], []);
    m.get(km[1]).push(km[2]);
  }
  const winners = new Map();  // key -> Set of winning values (one per locale)
  for (const [, m] of byLocale) {
    for (const [key, values] of m) {
      if (values.length < 2) continue;
      if (!winners.has(key)) winners.set(key, new Set());
      winners.get(key).add(values[values.length - 1]);
    }
  }
  return winners;
}
const SHADOWED_WINNERS = winnerPerLocale();

function findShadowedPlaceholderLeaks() {
  if (!SHADOWED_WINNERS.size) return [];
  const found = [];
  for (const dir of JS_DIRS) {
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, "utf-8");
      const lines = src.split(/\r?\n/);
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!code.includes("t(")) return;
        const re = /\bt\(\s*(["'])([A-Za-z0-9_.\-]+)\1\s*(?:\)|,)/g;
        let m;
        while ((m = re.exec(code))) {
          const key = m[2];
          const winners = SHADOWED_WINNERS.get(key);
          if (!winners) continue;
          const need = new Set();
          for (const w of winners) for (const ph of w.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) need.add(ph[1]);
          if (need.size === 0) continue;
          // Substitution may be chained over a wrapped call, so widen the net
          // to the whole statement before deciding the call cannot fill it.
          const window = lines.slice(index, index + 4).join("\n");
          if (window.includes(".replace")) continue;
          found.push({
            file: path.relative(ROOT, file),
            line: index + 1,
            kind: "i18n-shadowed-placeholder-leak",
            text: `${key} — dict defines this key more than once and the winning value keeps ${[...need].map((x) => "{" + x + "}").join(", ")}, but this call never substitutes it`,
          });
        }
      });
    }
  }
  return found;
}

// ── 1g. <label> without an association ─────────────────────────────────────
// R180: this template writes the same field two ways — a <label for="x"> that
// points at its control, and a bare <label> that merely sits next to it. Half
// the file used each. Sighted users cannot tell the difference; a screen
// reader can: an unassociated label contributes no accessible name, so the
// control is announced as a bare "text field"/"popup button". Measured with
// CDP Accessibility.getFullAXTree: 5 unnamed controls in the sync tab, and
// ~52 more that would surface once their dialog renders.
//
// A label that *wraps* its control needs no for= and is not reported — the
// pattern below only matches the "immediately followed by" form, which cannot
// be a wrapper. Controls without an id are skipped: they cannot be fixed with
// for=, and the JS-generated ones need aria-label instead (see sync.js
// team-role-select).
const LABEL_THEN_CONTROL = /<label(?<attrs>[^>]*)>(?<text>[^<]{0,80})<\/label>\s*(?<ctl><input|<select|<textarea)(?<ctlattrs>[^>]*)>/g;
const A11Y_SKIP_TYPES = /type\s*=\s*["'](?:hidden|submit|button|reset|image)["']/;

function findUnassociatedLabels() {
  const found = [];
  const targets = [...walk(JS_DIRS[0])];
  const html = path.join(ROOT, "src/renderer/index.html");
  if (fs.existsSync(html)) targets.push(html);
  for (const file of targets) {
    const src = fs.readFileSync(file, "utf-8");
    let m;
    LABEL_THEN_CONTROL.lastIndex = 0;
    while ((m = LABEL_THEN_CONTROL.exec(src))) {
      if (/\bfor\s*=/.test(m.groups.attrs)) continue;
      if (!/\bid="[^"]+"/.test(m.groups.ctlattrs)) continue;
      if (A11Y_SKIP_TYPES.test(m.groups.ctlattrs)) continue;
      found.push({
        file: path.relative(ROOT, file),
        line: src.slice(0, m.start).split("\n").length,
        kind: "label-not-associated",
        text: `<label>${m.groups.text.trim().slice(0, 34)}</label> precedes a control but has no for= — the control has no accessible name`,
      });
    }
  }
  return found;
}

function findDroppedPlaceholders() {
  const found = [];
  for (const dir of JS_DIRS) {
    for (const file of walk(dir)) {
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!code.includes("t(")) return;
        const re = /\bt\(\s*(['"])([A-Za-z0-9_.\-]+)\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g;
        let m;
        while ((m = re.exec(code))) {
          const key = m[2];
          const wanted = placeholders(m[4]);
          if (wanted.size === 0) continue;
          for (const [locale, values] of VALUES_BY_LOCALE) {
            const value = values.get(key);
            if (value === undefined) continue;  // missing key is check 1c's job
            const lost = [...wanted].filter((p) => !placeholders(value).has(p));
            if (lost.length === 0) continue;
            found.push({
              file: path.relative(ROOT, file),
              line: index + 1,
              kind: "i18n-value-drops-placeholder",
              text: `${key} [${locale}] — value ${JSON.stringify(value)} drops ${lost.map((p) => "{" + p + "}").join(", ")} that the fallback supplies`,
            });
          }
        }
      });
    }
  }
  return found;
}

// ── 2. JS: CJK string literals outside the translation table ───────────────
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

for (const dir of JS_DIRS) {
  for (const file of walk(dir)) {
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    lines.forEach((raw, index) => {
      const code = raw.replace(/\/\/.*$/, "");
      if (!CJK.test(code)) return;
      // Skip lines that already route through i18n.
      if (/i18n\.t\(|window\.i18n|\bt\(/.test(code)) return;
      // Skip inline bilingual ternaries such as `zh ? "一致性" : "Consistency"`:
      // those already serve both locales and are not a defect.
      if (BILINGUAL_TERNARY.test(code)) return;
      const lits = [];
      const re = /(["'`])((?:\\.|(?!\1).)*)\1/g;
      let m;
      while ((m = re.exec(code))) {
        if (CJK.test(m[2])) lits.push(m[2]);
      }
      if (!lits.length) return;
      problems.push({
        file: path.relative(ROOT, file),
        line: index + 1,
        kind: "js-hardcoded-cjk",
        text: lits.join(" | ").slice(0, 120),
      });
    });
  }
}

// ── 3. Translation table: full merged zh/en parity ─────────────────────────
// A locale-header regex missed quoted headers entirely; reading only the first
// literal also misses extraDict/auditFixDict. Execute the whole renderer runtime
// with inert DOM/storage fixtures, then compare its own keys (never t fallback).
// AST last-merge winners independently catch late value shadows/runtime drift;
// this is a structural check, not a linguistic audit of all legacy translations.
let keyReport = null;
try {
  const src = fs.readFileSync(I18N, "utf-8");
  const { default: ts } = await import("typescript");
  const vm = await import("node:vm");
  const file = ts.createSourceFile(I18N, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const requireShape = (condition, message) => { if (!condition) throw new Error(message); };
  requireShape(file.parseDiagnostics.length === 0, "Renderer dictionary has invalid JavaScript");
  const localeNames = ["en-US", "zh-CN"];
  const layerNames = ["dict", "extraDict", "auditFixDict"];
  const layers = [];
  const merges = [];
  const exposes = [];
  const expected = Object.fromEntries(localeNames.map(locale => [locale, Object.create(null)]));
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && layerNames.includes(node.name.text)) {
      requireShape(node.initializer && ts.isObjectLiteralExpression(node.initializer), `Non-literal ${node.name.text}`);
      const locales = [];
      for (const property of node.initializer.properties) {
        requireShape(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isObjectLiteralExpression(property.initializer), `Invalid locale in ${node.name.text}`);
        const locale = property.name.text;
        requireShape(localeNames.includes(locale) && !locales.includes(locale), `Unexpected locale ${locale}`);
        locales.push(locale);
        for (const entry of property.initializer.properties) {
          requireShape(ts.isPropertyAssignment(entry) && ts.isStringLiteral(entry.name) && ts.isStringLiteral(entry.initializer), `Non-string entry in ${node.name.text}/${locale}`);
          expected[locale][entry.name.text] = entry.initializer.text;
        }
      }
      requireShape(localeNames.every(locale => locales.includes(locale)), `Missing locale in ${node.name.text}`);
      layers.push(node.name.text);
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === "Object.assign") {
      merges.push(node.getText(file).replace(/\s+/g, ""));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(file) === "window.i18n") exposes.push(node.getStart(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  requireShape(JSON.stringify(layers) === JSON.stringify(layerNames), "Renderer dictionary layer shape changed");
  requireShape(JSON.stringify(merges) === JSON.stringify(layerNames.slice(1).map(name => `Object.assign(dict[locale]||{},${name}[locale])`)), "Renderer dictionary merge order changed");
  requireShape(exposes.length === 1, "Renderer i18n exposure must be unique");
  const window = {};
  const document = { documentElement: {}, querySelectorAll: () => [], addEventListener: () => {}, dispatchEvent: () => true };
  const context = {
    window, document, navigator: { language: "en-US" },
    localStorage: { getItem: () => null, setItem: () => {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  };
  const at = exposes[0];
  vm.runInNewContext(src.slice(0, at) + "window.__guardBundles = dict;\n" + src.slice(at), context, { filename: I18N, timeout: 2000 });
  const bundles = window.__guardBundles;
  requireShape(bundles && window.i18n, "Renderer dictionary/runtime did not load");
  for (const locale of localeNames) {
    requireShape(Object.hasOwn(bundles, locale) && bundles[locale] && typeof bundles[locale] === "object", `Missing own renderer locale ${locale}`);
    window.i18n.set(locale);
    requireShape(window.i18n.get() === locale, `Cannot select renderer locale ${locale}`);
    const actual = bundles[locale];
    for (const key of new Set([...Object.keys(expected[locale]), ...Object.keys(actual)])) {
      if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected[locale], key) || actual[key] !== expected[locale][key] || window.i18n.t(key, "__GUARD_FALLBACK__") !== expected[locale][key]) {
        problems.push({ file: path.relative(ROOT, I18N), line: 1, kind: "i18n-effective-value", text: `${locale}: ${key} disagrees with the literal last-merge winner` });
      }
    }
  }
  const en = Object.keys(bundles["en-US"]);
  const zh = Object.keys(bundles["zh-CN"]);
  keyReport = {
    zh: zh.length, en: en.length,
    missingInZh: en.filter(key => !Object.hasOwn(bundles["zh-CN"], key)),
    missingInEn: zh.filter(key => !Object.hasOwn(bundles["en-US"], key)),
  };
} catch (error) {
  problems.push({ file: path.relative(ROOT, I18N), line: 1, kind: "i18n-parity-evaluation", text: error.message });
}

// ── 3b. Main-process table: bounded own zh/en key parity ───────────────────
// Never evaluate this service module. A suffix scan of zh also read en and hid
// missing Chinese keys; locale order/quotes/indentation must not affect ownership.
// Main has one static top-level table, unlike the renderer's merged runtime.
// Reject unexpected structure and writes/aliases instead of guessing its keys.
// Renderer-only fixtures may omit the module; a present module must validate.
if (fs.existsSync(MAIN_I18N)) {
  try {
    const src = fs.readFileSync(MAIN_I18N, "utf-8");
    const { default: ts } = await import("typescript");
    const file = ts.createSourceFile(MAIN_I18N, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const requireShape = (condition, message) => { if (!condition) throw new Error(message); };
    requireShape(file.parseDiagnostics.length === 0, "Main dictionary has invalid TypeScript");
    const declarations = [];
    const references = [];
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "dict") declarations.push(node);
      if (ts.isIdentifier(node) && node.text === "dict"
        && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) references.push(node);
      ts.forEachChild(node, visit);
    }
    visit(file);
    requireShape(declarations.length === 1, "Main dictionary declaration must be unique");
    const declaration = declarations[0];
    requireShape(ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      && ts.isVariableStatement(declaration.parent.parent)
      && declaration.parent.parent.parent === file
      && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer),
    "Main dictionary must be one top-level const object");
    const locales = new Map();
    for (const property of declaration.initializer.properties) {
      requireShape(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)
        && ts.isObjectLiteralExpression(property.initializer), "Main dictionary locale structure changed");
      const locale = property.name.text;
      requireShape(["zh-CN", "en-US"].includes(locale) && !locales.has(locale), "Main dictionary locale structure changed");
      const keys = new Set();
      for (const entry of property.initializer.properties) {
        requireShape(ts.isPropertyAssignment(entry) && ts.isStringLiteral(entry.name)
          && ts.isStringLiteral(entry.initializer), "Main dictionary entries must be literal strings");
        // __proto__ is a prototype setter in an object literal, not an own key.
        requireShape(entry.name.text !== "__proto__", "Main dictionary contains a non-own property");
        // Duplicate literal properties are still one own key, as at runtime.
        keys.add(entry.name.text);
      }
      requireShape(keys.size > 0, "Main dictionary locale must not be empty");
      locales.set(locale, keys);
    }
    requireShape(locales.size === 2 && locales.has("zh-CN") && locales.has("en-US"), "Main dictionary locale structure changed");

    // Bound the supported reader as well as direct dict references: its bundle
    // alias must not mutate or escape. This is a syntax allowlist for the pure
    // existing reader, not a general JavaScript side-effect/security analysis.
    // AST comparison ignores comments, whitespace and string quote style, but
    // rejects added statements, nested captures, shadowed bindings and writes.
    const supportedReader = ts.createSourceFile("main-reader.ts", `
      export function tMain(key: string, fallback?: string): string {
        const bundle = dict[currentLang] || dict["en-US"];
        if (bundle && bundle[key] !== undefined) return bundle[key];
        if (dict["en-US"][key] !== undefined) return dict["en-US"][key];
        return fallback !== undefined ? fallback : key;
      }
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).statements[0];
    function readerShape(node) {
      const children = [];
      ts.forEachChild(node, child => { children.push(readerShape(child)); });
      return [node.kind, ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null,
        ts.isVariableDeclarationList(node) ? node.flags & ts.NodeFlags.BlockScoped : null, children];
    }
    const readers = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "tMain");
    requireShape(readers.length === 1
      && JSON.stringify(readerShape(readers[0])) === JSON.stringify(readerShape(supportedReader)),
    "Main dictionary reader structure changed");

    // An unmodelled use outside this reader can also change ownership after the
    // initializer; fail closed rather than execute main-process code to find out.
    const isIdentifier = (node, name) => node && ts.isIdentifier(node) && node.text === name;
    function isSupportedRead(reference) {
      let owner = reference.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      if (!owner || owner.parent !== file || !isIdentifier(owner.name, "tMain")) return false;
      const access = reference.parent;
      if (!ts.isElementAccessExpression(access) || access.expression !== reference) return false;
      const argument = access.argumentExpression;
      const english = ts.isStringLiteral(argument) && argument.text === "en-US";
      const parent = access.parent;
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        const variable = parent.parent;
        return (english || isIdentifier(argument, "currentLang"))
          && ts.isVariableDeclaration(variable) && isIdentifier(variable.name, "bundle") && variable.initializer === parent
          && parent.left.getText(file).replace(/\s/g, "") === "dict[currentLang]"
          && ts.isElementAccessExpression(parent.right) && isIdentifier(parent.right.expression, "dict")
          && ts.isStringLiteral(parent.right.argumentExpression) && parent.right.argumentExpression.text === "en-US";
      }
      if (!english || !ts.isElementAccessExpression(parent) || parent.expression !== access || !isIdentifier(parent.argumentExpression, "key")) return false;
      const use = parent.parent;
      return (ts.isReturnStatement(use) && use.expression === parent)
        || (ts.isBinaryExpression(use) && use.left === parent
          && use.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && isIdentifier(use.right, "undefined"));
    }
    requireShape(references.filter(reference => reference !== declaration.name).every(isSupportedRead), "Main dictionary has unsupported writes or aliases");
    const zh = locales.get("zh-CN");
    const en = locales.get("en-US");
    mainKeyReport = {
      zh: zh.size, en: en.size,
      missingInEn: [...zh].filter(key => !en.has(key)),
      missingInZh: [...en].filter(key => !zh.has(key)),
    };
  } catch (error) {
    // Do not expose source, translations, parser excerpts or host exception text.
    const diagnostic = error instanceof Error && /^Main dictionary /.test(error.message)
      ? error.message : "Main dictionary could not be inspected";
    problems.push({ file: path.relative(ROOT, MAIN_I18N), line: 1, kind: "main-i18n-parity-structure", text: diagnostic });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
problems.push(...findUndefinedKeys());
problems.push(...findSeparatorLeaks());
problems.push(...findDroppedPlaceholders());
problems.push(...findShadowedPlaceholderLeaks());
problems.push(...findUnassociatedLabels());

if (problems.length) {
  console.log(`\n✗ ${problems.length} i18n problem(s) found:\n`);
  for (const p of problems) {
    console.log(`  ${p.file}:${p.line}  [${p.kind}]  ${p.text}`);
  }
}

if (keyReport) {
  console.log(`\ni18n key parity: zh=${keyReport.zh} en=${keyReport.en}`);
  if (keyReport.missingInEn.length) console.log(`  missing in en: ${keyReport.missingInEn.slice(0, 20).join(", ")}`);
  if (keyReport.missingInZh.length) console.log(`  missing in zh: ${keyReport.missingInZh.slice(0, 20).join(", ")}`);
}

if (mainKeyReport) {
  console.log(`\nmain-process key parity: zh=${mainKeyReport.zh} en=${mainKeyReport.en}`);
  if (mainKeyReport.missingInEn.length) console.log(`  missing in en: ${mainKeyReport.missingInEn.slice(0, 20).join(", ")}`);
  if (mainKeyReport.missingInZh.length) console.log(`  missing in zh: ${mainKeyReport.missingInZh.slice(0, 20).join(", ")}`);
}

const keyMismatch = keyReport && (keyReport.missingInEn.length > 0 || keyReport.missingInZh.length > 0);
const mainKeyMismatch = mainKeyReport && (mainKeyReport.missingInEn.length > 0 || mainKeyReport.missingInZh.length > 0);
if (problems.length || keyMismatch || mainKeyMismatch) {
  const parity = keyMismatch || mainKeyMismatch ? "FAILED" : "ok";
  console.log(`\n${problems.length} string problem(s), key parity ${parity}\n`);
  process.exit(strict || problems.length || keyMismatch || mainKeyMismatch ? 1 : 0);
}
console.log("\n✓ i18n check passed\n");
