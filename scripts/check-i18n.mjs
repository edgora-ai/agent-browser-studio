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

// ── Report ─────────────────────────────────────────────────────────────────
if (problems.length) {
  console.log(`\n✗ ${problems.length} hard-coded CJK string(s) found:\n`);
  for (const p of problems) {
    console.log(`  ${p.file}:${p.line}  [${p.kind}]  ${p.text}`);
  }
}

if (keyReport) {
  console.log(`\ni18n key parity: zh=${keyReport.zh} en=${keyReport.en}`);
  if (keyReport.missingInEn.length) console.log(`  missing in en: ${keyReport.missingInEn.slice(0, 20).join(", ")}`);
  if (keyReport.missingInZh.length) console.log(`  missing in zh: ${keyReport.missingInZh.slice(0, 20).join(", ")}`);
}

const keyMismatch = keyReport && (keyReport.missingInEn.length > 0 || keyReport.missingInZh.length > 0);
if (problems.length || keyMismatch) {
  console.log(`\n${problems.length} string problem(s), key parity ${keyMismatch ? "FAILED" : "ok"}\n`);
  process.exit(strict || problems.length ? 1 : 0);
}
console.log("\n✓ i18n check passed\n");
