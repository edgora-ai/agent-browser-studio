#!/usr/bin/env node
/**
 * Marketing-copy guard (sale-93 / sale-102).
 *
 * Sale pages must avoid promise words (no 最/第一/防封/包过/100%过审) and the
 * English bypass-family (bypass / evade / undetectable) that trips payment
 * KYB/AUP reviews and marketplace policy. This script scans the user-visible
 * surfaces (renderer HTML/JS + sales docs) and reports hits for HUMAN review —
 * it exits non-zero only with --strict, so normal CI stays green while the
 * sales checklist (`npm run check:marketing`) has a repeatable artifact.
 *
 * Legitimate technical uses (proxy bypass-lists, "bypassing the consent
 * dialog" in code comments, "never for ..." prohibitions) are allowlisted by
 * file/pattern below. Keep the allowlist tight: every entry names WHY the hit
 * is not a marketing promise.
 *
 * Usage: node scripts/check-marketing-copy.mjs [--strict]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const strict = process.argv.includes("--strict");

// Chinese promise words (marketing surface only).
const ZH_BANNED = ["防封", "包过", "100%过审", "百分百过审", "最强", "第一"];
// English bypass-family (case-insensitive).
const EN_BANNED = [/\bbypass(?:ing|ed)?\b/i, /\bevade?\b/i, /\bevasion\b/i, /\bundetectable\b/i];

const SCAN_FILES = [
  "src/renderer/index.html",
  "docs/PRICING.md",
  "docs/DEPLOY_SERVICE.md",
  "docs/USER_GUIDE.zh-CN.md",
  "docs/USER_GUIDE.en.md",
  "README.md",
];
const SCAN_DIRS = ["src/renderer/js/app", "src/renderer/js"];

// Allowlisted hits: [file suffix, substring that must be present on the line].
// Each is a TECHNICAL or PROHIBITION use, not a sales promise.
const ALLOWLIST = [
  // Proxy bypass-list is a standard networking term (Chromium --proxy-bypass-list).
  ["proxies.js", "bypass"],
  ["index.html", "dlg-proxy-bypass"],
  // Code comments describing what a fix stops (not a promise to users).
  ["profiles.js", "bypass"],
  ["wizard.js", "bypass"],
  ["core.js", "bypass"],
  // Compliance prohibitions ("never for ...", "not anti-ban").
  ["i18n.js", "evad"],
  ["i18n.js", "规避"],
  ["i18n.js", "防封"],
  ["wizard.js", "规避"],
  ["index.html", "规避"],
  ["sync.js", "bypass"],
  // Proxy bypass-list is Chromium's --proxy-bypass-list term (both locales).
  ["i18n.js", "bypass"],
  // "第一个" as in "create your FIRST profile" / "first healthy backup".
  ["USER_GUIDE.zh-CN.md", "第一"],
  // Compliance negation ("anti-detection ≠ anti-ban") — the required disclaimer.
  ["USER_GUIDE.zh-CN.md", "防封"],
  ["USER_GUIDE.en.md", "anti-ban"],
  // Compliance prohibitions in docs ("ban evasion" in a Do-NOT list).
  ["README.md", "evasion"],
  ["USER_GUIDE.en.md", "evasion"],
  ["USER_GUIDE.en.md", "bypass"],
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function allowlisted(rel, line) {
  return ALLOWLIST.some(([suffix, sub]) => rel.endsWith(suffix) && line.includes(sub));
}

const hits = [];
function scanFile(abs) {
  const rel = path.relative(ROOT, abs);
  if (!fs.existsSync(abs)) return;
  const lines = fs.readFileSync(abs, "utf-8").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "");
    for (const w of ZH_BANNED) {
      if (raw.includes(w) && !allowlisted(rel, raw)) {
        hits.push({ file: rel, line: i + 1, word: w, text: raw.trim().slice(0, 120) });
      }
    }
    for (const re of EN_BANNED) {
      if (re.test(line) && !allowlisted(rel, raw)) {
        hits.push({ file: rel, line: i + 1, word: re.source, text: raw.trim().slice(0, 120) });
      }
    }
  });
}

for (const f of SCAN_FILES) scanFile(path.join(ROOT, f));
for (const d of SCAN_DIRS) for (const f of walk(path.join(ROOT, d))) scanFile(f);

if (!hits.length) {
  console.log("✓ marketing-copy check passed");
  process.exit(0);
}
console.log(`marketing-copy: ${hits.length} hit(s) need human review:`);
for (const h of hits) console.log(`  ${h.file}:${h.line} [${h.word}] ${h.text}`);
if (strict) process.exit(1);
process.exit(0);
