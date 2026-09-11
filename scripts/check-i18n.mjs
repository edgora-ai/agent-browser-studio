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

function findUndefinedKeys() {
  if (!DEFINED_KEYS) return [];
  const found = [];
  for (const dir of JS_DIRS) {
    for (const file of walk(dir)) {
      const lines = fs.readFileSync(file, "utf-8").split("\n");
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
      const lines = fs.readFileSync(file, "utf-8").split("\n");
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
    const lines = fs.readFileSync(file, "utf-8").split("\n");
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

// ── 3. Translation table: zh/en key parity ─────────────────────────────────
let keyReport = null;
if (fs.existsSync(I18N)) {
  const src = fs.readFileSync(I18N, "utf-8");
  const locales = {};
  const localeRe = /(zh[-_]?CN|zh|en[-_]?US|en)\s*:\s*\{/gi;
  let m;
  while ((m = localeRe.exec(src))) {
    const name = m[1].toLowerCase().startsWith("zh") ? "zh" : "en";
    // brace-match the object literal
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(start + 1, i);
    const keys = new Set();
    const keyRe = /(?:^|[,{\s])["']([A-Za-z0-9_.\-]+)["']\s*:/g;
    let k;
    while ((k = keyRe.exec(body))) keys.add(k[1]);
    locales[name] = locales[name] ? new Set([...locales[name], ...keys]) : keys;
  }
  if (locales.zh && locales.en) {
    const missingInZh = [...locales.en].filter((k) => !locales.zh.has(k));
    const missingInEn = [...locales.zh].filter((k) => !locales.en.has(k));
    keyReport = { zh: locales.zh.size, en: locales.en.size, missingInZh, missingInEn };
  }
}

// ── 3b. Main-process table: zh/en key parity ───────────────────────────────
// The main process owns a second, separate dictionary (tray, proxy
// suggestions, WebRTC summaries, sync warnings). Nothing checked it, so a key
// added only to one locale would silently fall back to the hardcoded English
// default in tMain — the same shape of bug as the renderer leak this script
// already guards, one layer down.
if (fs.existsSync(MAIN_I18N)) {
  const src = fs.readFileSync(MAIN_I18N, "utf-8");
  const grab = (from) => {
    const body = src.slice(from);
    const keys = new Set();
    const re = /^\s{4}"([\w.\-]+)"\s*:/gm;
    let k;
    while ((k = re.exec(body))) keys.add(k[1]);
    return keys;
  };
  const zhAt = src.indexOf('"zh-CN": {');
  const enAt = src.indexOf('"en-US": {');
  if (zhAt >= 0 && enAt >= 0 && enAt > zhAt) {
    const zh = grab(zhAt);
    const en = grab(enAt);
    mainKeyReport = {
      zh: zh.size,
      en: en.size,
      missingInEn: [...zh].filter((k) => !en.has(k)),
      missingInZh: [...en].filter((k) => !zh.has(k)),
    };
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
problems.push(...findUndefinedKeys());
problems.push(...findSeparatorLeaks());

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
  process.exit(strict || problems.length || mainKeyMismatch ? 1 : 0);
}
console.log("\n✓ i18n check passed\n");
