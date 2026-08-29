#!/usr/bin/env node
/**
 * Module size guard (review item TE-06).
 *
 * Several main-process services grew past 1,500 lines (local-agent.ts,
 * rest-api-server.ts, browser-manager.ts, config-manager.ts), which makes
 * every change riskier and slower to review. Splitting them is a staged
 * refactor, so this script does two things:
 *   - reports every file over the threshold, with the current baseline marked;
 *   - fails only when a file *newly* crosses the threshold.
 *
 * The baseline shrinks as modules get split out.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const THRESHOLD = 1500;
const strict = process.argv.includes("--strict");

// Known oversized modules accepted at the time of the review. Entries must be
// removed as each module is split.
const BASELINE = new Set([
  "src/main/services/local-agent.ts",
  "src/main/services/rest-api-server.ts",
  "src/main/services/browser-manager.ts",
  "src/main/services/config-manager.ts",
  "src/main/services/mcp-server.ts",
  "src/main/services/firefox-fingerprint.ts",
  "src/main/services/browser-fingerprint-config.ts",
  "src/main/services/environment-risk.ts",
  "src/main/services/extension-repository.ts",
  "src/main/services/sync-service.ts",
  "src/tools/verify-native-chromium.ts",
  "src/renderer/js/i18n.js",
  // Grew from 1,204 to ~1,640 lines during the review pass (batch runner,
  // health-check gating, paging, i18n). Candidate for splitting next: extract
  // the batch UI and the health-check section into their own modules.
  "src/renderer/js/app/profiles.js",
]);

const TARGETS = ["src/main", "src/renderer/js/app", "src/tools"];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const files = TARGETS.flatMap((t) => walk(path.join(ROOT, t)));
const rows = files
  .map((file) => ({
    rel: path.relative(ROOT, file),
    lines: fs.readFileSync(file, "utf-8").split("\n").length,
  }))
  .filter((r) => r.lines > THRESHOLD)
  .sort((a, b) => b.lines - a.lines);

if (!rows.length) {
  console.log(`\n✓ no file exceeds ${THRESHOLD} lines\n`);
  process.exit(0);
}

console.log(`\nFiles over ${THRESHOLD} lines:\n`);
const newlyOver = [];
for (const row of rows) {
  const known = BASELINE.has(row.rel);
  if (!known) newlyOver.push(row.rel);
  console.log(`  ${known ? "baseline" : "NEW     "}  ${String(row.lines).padStart(6)}  ${row.rel}`);
}

if (newlyOver.length) {
  console.log(`\n✗ ${newlyOver.length} file(s) newly exceed the limit: ${newlyOver.join(", ")}`);
  console.log("  Split the module, or add it to BASELINE with a linked refactor ticket.\n");
  process.exit(1);
}

console.log(`\n✓ ${rows.length} oversized file(s), all in the accepted baseline`);
if (strict) {
  console.log("  --strict: baseline entries are treated as failures");
  process.exit(1);
}
console.log("");
