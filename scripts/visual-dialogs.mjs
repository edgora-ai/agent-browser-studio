// Dialog sweep — opens every <dialog> in the renderer through its real
// command and audits what the user actually sees.
//
// Why this exists: visual-shot.mjs walks the 12 *tabs* only. Every dialog was
// therefore covered solely when someone passed --dialog CMD by hand, which
// meant dialog defects (R158 raw "runs.status.undefined", R159 hardcoded EN
// cookie table, R162 "Confirm" title stuck in EN, R166 two dialogs sharing a
// shadowed title key, R168 a failed lookup claiming "no profiles") were all
// found by ad-hoc probes and none by the gate. This script closes that gap.
//
// Usage:
//   node scripts/visual-dialogs.mjs                 # audit, exit 1 on findings
//   node scripts/visual-dialogs.mjs --lang zh-CN
//   node scripts/visual-dialogs.mjs --only dlg-confirm
//   node scripts/visual-dialogs.mjs --shots         # also write PNGs
//
// Findings are the same classes the tab audit checks, applied to open dialogs:
//   - raw i18n keys / "undefined" / "[object Object]" in visible text
//   - English copy that does not change between zh-CN and en-US
//   - text overflowing its dialog
//   - a title that disagrees with the dialog's own purpose (shared key)
import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const has = (n) => process.argv.includes(`--${n}`);
const ONLY = arg("only", "");
const WANT_SHOTS = has("shots");
const OUT = path.resolve(arg("out", "/tmp/abs-dialogs"));

// Same three-platform resolution visual-shot.mjs uses; this sweep has to run
// on the Linux CI runner, not just on a Mac.
function findChromium() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_PATH || process.env.CHROME_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const bases = [
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
  ];
  const rel = process.platform === "darwin"
    ? ["chrome-mac-arm64", "chrome-mac-x64"].map((v) => [
        v, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing",
      ])
    : process.platform === "win32"
      ? [["chrome-win", "chrome.exe"]]
      : [["chrome-linux", "chrome"]];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const parts of rel) {
        const p = path.join(base, d, ...parts);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined; // let playwright resolve
}

// Every dialog, with a command that must open it and the id to look for.
// `needs` documents the fixture each opener reads, so a failure here is
// falsifiable rather than mysterious.
const DIALOGS = [
  { id: "dlg-account", cmd: "agentAddAccount" },
  { id: "dlg-account-bind", cmd: "agentBindAccounts", arg: 0 },
  { id: "dlg-account-import", cmd: "agentImportAccounts" },
  { id: "dlg-agent-run", cmd: "runsOpen", arg: "run_9f0b" },
  { id: "dlg-agent-browser-seed", cmd: "editProfile", arg: "prof_amazon" },
  { id: "dlg-cookies", cmd: "showCookies", arg: "prof_amazon" },
  { id: "dlg-note", cmd: "addNote", arg: "prof_amazon" },
  { id: "dlg-bulk-import", cmd: "bulkImport" },
  { id: "dlg-trash", cmd: "showTrash" },
  { id: "dlg-profile-logs", cmd: "showProfileLogs", arg: "prof_amazon" },
  { id: "dlg-env-risk", cmd: "openEnvRisk", arg: "prof_amazon" },
  // openWebRtcDiag gates a stopped profile behind a confirm; the fixture
  // prof_qa is `running: true` so it opens the dialog directly.
  { id: "dlg-webrtc-diag", cmd: "openWebRtcDiag", arg: "prof_qa" },
  { id: "dlg-skill-market", cmd: "skillMarket" },
  { id: "dlg-skill-import", cmd: "showSkillImport" },
  { id: "dlg-skill-editor", cmd: "showSkillEditor" },
  { id: "dlg-wizard", cmd: "showWizard" },
  { id: "dlg-extensions", cmd: "showExtensions", arg: "prof_amazon" },
  { id: "dlg-extension-repo", cmd: "showRepositoryAdd" },
  { id: "dlg-proxy", cmd: "newProxy" },
  { id: "dlg-proxy-import", cmd: "importProxies" },
  { id: "dlg-proxy-bind", cmd: "bindProxyToProfiles", arg: "hk01" },
  { id: "dlg-proxy-qr", cmd: "qrcodeProxy", arg: "hk01" },
  { id: "dlg-automation", cmd: "automationNew" },
  // R173: these three were listed as "no programmatic opener" — wrong. Each
  // does have one; the sweep just had to pass the right argument.
  { id: "dlg-rename", cmd: "renameProfile", arg: "prof_amazon", arg2: "Amazon US Shop" },
  { id: "dlg-auto-job", cmd: "automationShowJob", arg: "job_4a83" },
  { id: "dlg-auto-log", cmd: "automationShowLogDetail", arg: { at: 1757000000000, ok: false, ruleId: "rule_nightly", ruleName: "Nightly price sweep", result: "step 9 failed: selector .price not found" } },
  // batch.showResult is exported (agentBrowser.batch.showResult), so the
  // dialog is reachable with a synthetic result — no live batch run needed.
  // Fixture mirrors the real contract (batch-queue.ts:187):
  // {total, succeeded, failed, cancelled, durationMs, concurrency, traceId,
  //  results:[{ok, value:{name}, item, error}]}. An earlier version invented
  // `ok` at the top level and omitted durationMs, which rendered a literal
  // "undefined" — a fixture bug that looked like a product bug.
  { id: "dlg-batch-result", cmd: "batch.showResult", arg: { total: 3, succeeded: 2, failed: 1, cancelled: false, durationMs: 41200, concurrency: 2, traceId: "tr_8c31", results: [
      { ok: true, item: "prof_amazon", value: { name: "Amazon US Shop" } },
      { ok: true, item: "prof_qa", value: { name: "QA Local" } },
      { ok: false, item: "prof_cjk", value: { name: "短名字测试中文截断效果看看会不会溢出" }, error: "CDP port 9222 already in use by another profile" },
    ] }, arg2: "launch" },
  { id: "dlg-approval", cmd: null, skip: "opens on a main-process approval request" },
  { id: "dlg-license", cmd: null, skip: "opens from the license surface" },
  { id: "dlg-terms", cmd: null, skip: "first-run only; accepted in setup" },
  { id: "dlg-confirm", cmd: null, skip: "covered separately (see probeConfirm)" },
  { id: "dlg-profile", cmd: null, skip: "new-profile wizard entry" },
];

const GARBAGE = /(?:^|[\s>])(undefined|NaN|\[object Object\])(?:$|[\s<.,;:!?])/;
const RAW_KEY = /\b(?:[a-z][a-zA-Z0-9]*\.){2,}[a-zA-Z][a-zA-Z0-9-]*\b/;

async function boot(browser, lang) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const mock = fs.readFileSync(path.join(ROOT, "scripts/visual-mock.js"), "utf-8");
  await page.addInitScript((l) => {
    localStorage.setItem("agent-browser-studio-language", l);
    localStorage.setItem("cloak-lite-language", l);
  }, lang);
  await page.addInitScript(mock);
  await page.goto("file://" + path.join(ROOT, "src/renderer/index.html"));
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const d = document.getElementById("dlg-terms");
    if (d && d.open) {
      d.querySelector("input[type=checkbox]").click();
      const btn = [...d.querySelectorAll("button")].find((b) => /接受|Accept/.test(b.textContent));
      if (btn) btn.click();
    }
  });
  return page;
}

// Open one dialog and return what the user would see.
async function inspect(page, d) {
  return page.evaluate(async ({ id, cmd, arg, arg2 }) => {
    document.querySelectorAll("dialog[open]").forEach((x) => x.close());
    // cmd may be dotted (e.g. "batch.showResult") — resolve through the path
    // so nested exports are reachable, not just top-level ones.
    const fn = cmd.split(".").reduce((o, k) => (o == null ? o : o[k]), window.agentBrowser);
    if (typeof fn !== "function") return { skipped: `no command ${cmd}` };
    try {
      if (arg2 !== undefined) await fn(arg, arg2);
      else if (arg !== undefined) await fn(arg);
      else await fn();
    } catch (e) {
      return { threw: String((e && e.message) || e) };
    }
    await new Promise((r) => setTimeout(r, 450));
    const dlg = document.getElementById(id);
    if (!dlg) return { skipped: "not in DOM" };
    if (!dlg.open) return { didNotOpen: true };
    const text = dlg.innerText.replace(/\r/g, "").trim();
    // title = the h3 that labels the dialog
    const h3 = dlg.querySelector("h3");
    const overflow = [...dlg.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      if (el.scrollWidth - el.clientWidth <= 1) return false;
      return !["auto", "scroll", "hidden", "clip"].includes(s.overflowX);
    }).length;
    return {
      open: true,
      title: h3 ? h3.textContent.trim() : null,
      text,
      cardCount: dlg.querySelectorAll(".profile-card, .card, .info-row").length,
      overflow,
      emptyish: dlg.querySelectorAll(".empty-state, .loading, .skeleton-list").length,
    };
  }, d);
}

async function run(lang) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  } catch (e) {
    // No browser available (fresh clone, CI without the download). Skipping is
    // deliberate: this sweep must not turn `npm run check` red on a machine
    // that simply has no chromium, or it gets disabled and stops protecting
    // anything. Exit 2 so a caller can tell "skipped" from "clean".
    console.log(`\n! dialog sweep skipped — no chromium available (${String((e && e.message) || e).split("\n")[0]})`);
    console.log("  install with: npx playwright install chromium\n");
    process.exit(2);
  }
  const page = await boot(browser, lang);
  const out = {};
  for (const d of DIALOGS) {
    if (ONLY && d.id !== ONLY) continue;
    if (d.cmd === null) { out[d.id] = { skipped: d.skip }; continue; }
    out[d.id] = await inspect(page, d);
    if (WANT_SHOTS && out[d.id].open) {
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, `${d.id}.${lang}.png`) });
    }
  }
  await browser.close();
  return out;
}

const zh = await run("zh-CN");
const en = await run("en-US");

const findings = [];
let opened = 0, skipped = 0;
for (const d of DIALOGS) {
  const z = zh[d.id] || {};
  const e = en[d.id] || {};
  if (z.skipped || e.skipped) { skipped++; continue; }
  if (z.threw) findings.push({ id: d.id, kind: "opener-threw", detail: `zh: ${z.threw}` });
  if (e.threw) findings.push({ id: d.id, kind: "opener-threw", detail: `en: ${e.threw}` });
  if (z.didNotOpen) findings.push({ id: d.id, kind: "did-not-open", detail: `command ${d.cmd} ran but the dialog stayed closed` });
  if (!z.open) continue;
  opened++;

  const gz = GARBAGE.exec(z.text), ge = GARBAGE.exec(e.text);
  if (gz) findings.push({ id: d.id, kind: "garbage-text", detail: JSON.stringify(gz[0]) });
  if (ge) findings.push({ id: d.id, kind: "garbage-text", detail: JSON.stringify(ge[0]) });

  // A visible raw i18n key is always a defect.
  for (const [lang, r] of [["zh", z], ["en", e]]) {
    const m = r.text.split("\n").map((l) => l.trim()).filter((l) => RAW_KEY.test(l) && !/https?:|\.(com|cn|org|io|example)\b/.test(l));
    if (m.length) findings.push({ id: d.id, kind: "raw-key-leak", detail: `[${lang}] ${m[0].slice(0, 60)}` });
  }

  if (z.overflow > 0) findings.push({ id: d.id, kind: "cell-overflow", detail: `${z.overflow} element(s) spill their box` });

  // Copy that is byte-identical across locales is either untranslated or a
  // proper noun; report the ones that look like sentences.
  const sameBody = z.text === e.text && z.text.length > 40;
  if (sameBody && /[a-zA-Z]{3}/.test(z.text)) {
    findings.push({ id: d.id, kind: "untranslated", detail: z.text.slice(0, 70).replace(/\n/g, " | ") });
  }
}

// Two dialogs showing the same title means they share a key — and since a key
// holds exactly one string, at most one of them can be labelled correctly.
// This is the R166 defect (dlg-extensions and dlg-extension-repo both drew
// "ext.dlg.title", so the add dialog was titled "扩展"). A per-dialog check
// cannot see it, because each dialog renders *something*; only comparing them
// exposes the collision.
const byTitle = new Map();
for (const d of DIALOGS) {
  const r = zh[d.id] || {};
  if (!r.open || !r.title) continue;
  if (!byTitle.has(r.title)) byTitle.set(r.title, []);
  byTitle.get(r.title).push(d.id);
}
for (const [title, ids] of byTitle) {
  if (ids.length > 1) {
    findings.push({
      id: ids.join(" + "),
      kind: "shared-title",
      detail: `${ids.length} dialogs all render the title ${JSON.stringify(title)} — they share an i18n key, so only one can be labelled correctly`,
    });
  }
}

console.log(`\n=== dialog sweep: ${opened} opened, ${skipped} skipped (no programmatic opener) ===\n`);
for (const d of DIALOGS) {
  const r = zh[d.id] || {};
  const tag = r.skipped ? "skip " : r.open ? "open " : r.didNotOpen ? "SHUT " : r.threw ? "THREW" : "?    ";
  console.log(`  ${tag} ${d.id.padEnd(24)} ${r.title ? r.title.slice(0, 46) : (r.skipped || "")}`);
}
if (findings.length) {
  console.log(`\n✗ ${findings.length} finding(s):\n`);
  for (const f of findings) console.log(`  ${f.id.padEnd(24)} [${f.kind}]  ${f.detail}`);
} else {
  console.log("\n✓ no findings\n");
}
if (WANT_SHOTS) console.log(`shots → ${OUT}`);
process.exit(findings.length ? 1 : 0);
