/**
 * R145 check: the "Add Chrome Extension" dialog used to be store-only, so the
 * primary entry point was a dead end for local extensions. This proves the new
 * local import controls actually render, are visible, and that clicking
 * "Import from Folder" closes the dialog and calls the directory picker.
 *
 * Reuses the visual harness mock so no Electron is needed.
 */
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Derived, not hardcoded: an absolute path pinned to one machine's worktree
// fails for everyone else and silently points at a stale checkout here.
const ROOT = path.resolve(import.meta.dirname, "..");
const MOCK = fs.readFileSync(path.join(ROOT, "scripts", "visual-mock.js"), "utf-8");
const PAGE_URL = "file://" + path.join(ROOT, "src", "renderer", "index.html");

function resolveChromium() {
  const roots = [path.join(os.homedir(), "Library", "Caches", "ms-playwright")];
  const candidates = process.platform === "darwin"
    ? ["chrome-mac-arm64", "chrome-mac-x64"].map((v) => [v, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"])
    : process.platform === "win32"
      ? [["chrome-win", "chrome.exe"]]
      : [["chrome-linux", "chrome"]];
  const hits = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!/^chromium-\d+$/.test(entry)) continue;
      for (const parts of candidates) {
        const bin = path.join(root, entry, ...parts);
        if (fs.existsSync(bin)) hits.push({ rev: Number(entry.split("-")[1]), path: bin });
      }
    }
  }
  hits.sort((a, b) => b.rev - a.rev);
  return hits[0] ? hits[0].path : null;
}

const bin = resolveChromium();
if (!bin) { console.error("no chromium"); process.exit(2); }

const browser = await chromium.launch({ executablePath: bin });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(`
  ${MOCK}
  try {
    localStorage.setItem('agent-browser-studio-theme', 'light');
    localStorage.setItem('agent-browser-studio-wizard-dismissed', '1');
    localStorage.setItem('agent-browser-studio-terms-accepted-v1', '1');
    localStorage.setItem('abs-backup-hint-dismissed', '1');
    // R146: the renderer's STORAGE_KEY is 'agent-browser-studio-language' and
    // its values are dictionary keys ('zh-CN'/'en-US'); this wrote a key and a
    // value it does not read, so the UI fell through to navigator.language.
    localStorage.setItem('agent-browser-studio-language', 'zh-CN');
    localStorage.setItem('cloak-lite-language', 'zh-CN');
    localStorage.setItem('cloak-lang', 'zh');
  } catch (e) {}
  // Record which picker the renderer asks for.
  window.__picked = [];
`);
await page.goto(PAGE_URL);
await page.waitForFunction(() => !!(window.agentBrowser && window.agentBrowser.api), { timeout: 15000 });
await page.waitForTimeout(700);

const fail = [];
function check(name, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  — " + detail : ""));
  if (!ok) fail.push(name);
}

// Instrument the two pickers so we can see which one the click reaches.
await page.evaluate(() => {
  const s = window.agentBrowser.api.settings;
  window.__origDir = s.pickExtensionDir;
  window.__origFile = s.pickExtensionFile;
  s.pickExtensionDir = function () { window.__picked.push("dir"); return Promise.resolve(null); };
  s.pickExtensionFile = function () { window.__picked.push("file"); return Promise.resolve(null); };
});

await page.evaluate(() => window.agentBrowser.switchTab("extensions"));
await page.waitForTimeout(400);

// 1. Header button label is now plain language.
const headerLabel = await page.evaluate(() => {
  const b = document.querySelector('#tab-extensions [data-cmd="extInstallFromDir"]');
  return b ? b.textContent.trim() : null;
});
check("header folder button exists", !!headerLabel, headerLabel);
check("header folder button is not jargon", headerLabel === "从文件夹导入", "got: " + headerLabel);

// 2. Open the add dialog from the primary button.
await page.evaluate(() => window.agentBrowser.showRepositoryAdd());
await page.waitForTimeout(300);
const open = await page.evaluate(() => document.getElementById("dlg-extension-repo").open);
check("add dialog opens", open === true);

// 3. The dialog now offers a local folder path.
const dlgButtons = await page.evaluate(() => {
  const dlg = document.getElementById("dlg-extension-repo");
  return [...dlg.querySelectorAll("[data-cmd]")].map((b) => ({
    cmd: b.dataset.cmd,
    label: b.textContent.trim(),
    visible: !!(b.offsetWidth || b.offsetHeight),
  }));
});
const dirBtn = dlgButtons.find((b) => b.cmd === "extInstallFromDir");
const fileBtn = dlgButtons.find((b) => b.cmd === "extInstallFromFile");
check("dialog has folder import", !!dirBtn && dirBtn.visible, dirBtn && dirBtn.label);
check("dialog has CRX/ZIP import", !!fileBtn && fileBtn.visible, fileBtn && fileBtn.label);

// 4. Clicking it closes the dialog and reaches the directory picker.
await page.evaluate(() => {
  document.querySelector('#dlg-extension-repo [data-cmd="extInstallFromDir"]').click();
});
await page.waitForTimeout(300);
const afterClick = await page.evaluate(() => ({
  open: document.getElementById("dlg-extension-repo").open,
  picked: window.__picked.slice(),
}));
check("dialog closed before picker", afterClick.open === false);
check("directory picker called", afterClick.picked.includes("dir"), JSON.stringify(afterClick.picked));
check("file picker not called", !afterClick.picked.includes("file"));

await browser.close();
console.log("\n" + (fail.length ? "FAILURES: " + fail.join(", ") : "ALL CHECKS PASSED"));
process.exit(fail.length ? 1 : 0);
