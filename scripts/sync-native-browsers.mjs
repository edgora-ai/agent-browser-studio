#!/usr/bin/env node
// Sync the compiled (patched) Chromium + Firefox bundles into the staging
// directory that electron-builder embeds as extraResources. Building is the
// only step that knows where each platform's artifacts live; the repository
// never stores the multi-hundred-MB binaries themselves.
//
// Usage:
//   node scripts/sync-native-browsers.mjs [--platform=mac|win|linux] [--chromium=PATH] [--firefox=PATH]
//
// Sources per platform (in priority order):
//   mac   Chromium:  ~/.agent-browser-studio/chromium-<ver>/Chromium.app
//                    (AGENT_BROWSER_CHROMIUM_CACHE_DIR to override)
//           Firefox: --firefox, else /Applications/Firefox.app
//   win   Chromium:  --chromium (a dir containing chrome.exe, or a chrome.exe)
//           Firefox: --firefox (a dir containing firefox.exe, or a firefox.exe)
//   linux Chromium:  --chromium (a dir containing chromium, or the chromium bin)
//           Firefox: --firefox (a dir containing firefox, or the firefox bin)
//
// Refuses to run without both binaries present: a release that omits them would
// ship 106MB of UI with no engine at all.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const outDir = path.join(repoRoot, "native-browsers");

function parseInto(raw, key) {
  const eq = `${key}=`;
  const hit = raw.find((a) => a.startsWith(eq));
  if (hit) return hit.slice(eq.length);
  return null;
}

const args = process.argv.slice(2);
const platform = parseInto(args, "--platform") || process.env.AGENT_BROWSER_BUILD_PLATFORM || "mac";
function explicit(k) {
  // parseInto matches a key prefix verbatim: CLI flags carry the leading
  // dashes (--chromium=...), so pass them through (bare "chromium=" never
  // matches an argv entry and win/linux staging always failed).
  const v = parseInto(args, `--${k}`) || process.env[`AGENT_BROWSER_${k.toUpperCase()}`];
  return v || null;
}

function die(msg) {
  console.error(`sync-native-browsers: ${msg}`);
  process.exit(1);
}
function fail(msg, detail) {
  die(`${msg}\n  ${detail}`);
}
function binVersion(bin) {
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
    const raw = String(r.stdout || r.stderr || "").trim();
    const m = raw.match(/(?:Chromium|Mozilla Firefox)\s*([0-9][\w.+-]*)/i);
    return m ? m[1] : (raw || null);
  } catch {
    return null;
  }
}

function chromiumCacheRoots() {
  const override = process.env.AGENT_BROWSER_CHROMIUM_CACHE_DIR || process.env.CLOAKLITE_CHROMIUM_CACHE_DIR;
  return [override ? path.resolve(override) : path.join(os.homedir(), ".agent-browser-studio")].filter(Boolean);
}

function findPendingPath(cands, kind) {
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// ── Platform-independent normalization -------------------------------------
function resolveSources(platform) {
  const chromium = explicit("chromium");
  const firefox = explicit("firefox");
  if (platform === "mac") {
    const cacheRoots = chromiumCacheRoots();
    const cacheCandidates = cacheRoots.flatMap((root) => {
      let entries = [];
      try { entries = fs.readdirSync(root); } catch { return []; }
      return entries
        .filter((e) => /^chromium-\d+(?:\.\d+){3}$/.test(e))
        .sort((a, b) => {
          const va = a.split("-")[1].split(".").map(Number);
          const vb = b.split("-")[1].split(".").map(Number);
          for (let i = 0; i < 4; i++) if (va[i] !== vb[i]) return va[i] < vb[i] ? 1 : -1;
          return 0;
        })
        .map((e) => path.join(root, e, "Chromium.app"));
    });
    const chromiumApp = explicit("chromium")
      ? path.resolve(chromium)
      : findPendingPath(cacheCandidates, "chromium");
    const firefoxApp = explicit("firefox")
      ? path.resolve(firefox)
      : "/Applications/Firefox.app";
    if (!chromiumApp || !fs.existsSync(chromiumApp)) fail("cannot resolve Chromium.app", "checked " + JSON.stringify(cacheCandidates));
    if (!fs.existsSync(firefoxApp)) fail("cannot resolve Firefox.app", firefoxApp);
    return { chromiumApp, firefoxApp };
  }
  // win/linux: directories containing the binary, or the binary itself.
  const puckByPlat = {
    win: { chromium: "chrome.exe", firefox: "firefox.exe" },
    linux: { chromium: "chromium", firefox: "firefox" },
  }[platform];
  if (!puckByPlat) fail("unsupported platform", platform);
  const spec = {
    chromium: chromium ? { given: chromium, name: puckByPlat.chromium } : null,
    firefox: firefox ? { given: firefox, name: puckByPlat.firefox } : null,
  };
  const resolved = {};
  for (const kind of ["chromium", "firefox"]) {
    const s = spec[kind];
    if (!s) fail(`no --${kind} source provided for ${platform}`, "set --chromium/--firefox or AGENT_BROWSER_CHROMIUM/FIREFOX");
    const p = path.resolve(s.given);
    const info = fs.statSync(p);
    resolved[kind] = info.isDirectory() ? path.join(p, s.name) : p;
    if (!fs.existsSync(resolved[kind])) fail(`--${kind} does not contain ${s.name}`, resolved[kind]);
  }
  return { chromiumApp: resolved.chromium, firefoxApp: resolved.firefox };
}

// ── Layout inside the app bundle -------------------------------------------
// macOS bundles are shipped as <name>.app.zip archives: the Electron app's own
// code signature would otherwise recurse into the nested .app (it is detected
// as a CFBundle by structure, not by extension) and abort on Chromium's
// Framework symlink layout with "invalid destination for symbolic link in
// bundle". A single zip is an opaque resource to codesign; the runtime unpacks
// it to the cache dir on first use. Windows/Linux have no such restriction and
// ship as plain directories.
function targets(platform) {
  if (platform === "mac") {
    return {
      chromium: path.join(outDir, "mac", "Chromium.app"),
      firefox: path.join(outDir, "mac", "Firefox.app"),
      chromiumZip: path.join(outDir, "mac", "Chromium.app.zip"),
      firefoxZip: path.join(outDir, "mac", "Firefox.app.zip"),
      manifest: path.join(outDir, "mac", "browsers-manifest.json"),
    };
  }
  return {
    chromium: path.join(outDir, platform, "chromium"),
    firefox: path.join(outDir, platform, "firefox"),
    manifest: path.join(outDir, platform, "browsers-manifest.json"),
  };
}

function stageTree(src, staging) {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  const result = spawnSync("ditto", [src, staging], { encoding: "utf8" });
  if (result.error || result.status !== 0 || !fs.existsSync(staging)) {
    fail("ditto failed to stage a macOS browser bundle", String(result.stderr || result.error || "unknown error"));
  }
  return staging;
}

function verifyMacBundle(bundlePath) {
  const result = spawnSync("codesign", ["--verify", "--deep", "--strict", bundlePath], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    fail("staged macOS browser bundle has an invalid code signature", String(result.stderr || result.error || bundlePath));
  }
}

function dittoZip(staging, outZip) {
  fs.rmSync(outZip, { force: true });
  spawnSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", staging, outZip], {
    stdio: "inherit",
  });
  if (fs.existsSync(outZip) && fs.statSync(outZip).size > 0) return;
  throw new Error(`ditto zip failed to produce ${outZip}`);
}

function copyTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`  ${src}\n    -> ${dst}`);
}

const t = targets(platform);
console.log(`sync-native-browsers [${platform}] -> ${outDir}`);
const { chromiumApp, firefoxApp } = resolveSources(platform);
if (platform === "mac") {
  const chromiumStage = stageTree(chromiumApp, path.join(outDir, ".stage", "Chromium.app"));
  const firefoxStage = stageTree(firefoxApp, path.join(outDir, ".stage", "Firefox.app"));
  verifyMacBundle(chromiumStage);
  verifyMacBundle(firefoxStage);
  dittoZip(chromiumStage, t.chromiumZip);
  dittoZip(firefoxStage, t.firefoxZip);
  const chromiumVersion = binVersion(path.join(chromiumStage, "Contents", "MacOS", "Chromium"));
  const firefoxVersion = binVersion(path.join(firefoxStage, "Contents", "MacOS", "firefox"));
  fs.rmSync(path.join(outDir, ".stage"), { recursive: true, force: true });
  fs.writeFileSync(t.manifest, JSON.stringify({ platform, chromiumVersion, firefoxVersion, syncedAt: new Date().toISOString() }, null, 2) + "\n");
  if (!chromiumVersion || !firefoxVersion) fail("version detection failed for a bundled browser", JSON.stringify({ chromiumVersion, firefoxVersion }));
  console.log(`  ${t.chromiumZip} (${(fs.statSync(t.chromiumZip).size / 1048576).toFixed(0)} MiB)`);
  console.log(`  ${t.firefoxZip} (${(fs.statSync(t.firefoxZip).size / 1048576).toFixed(0)} MiB)`);
  console.log(`  chromium ${chromiumVersion}, firefox ${firefoxVersion} — manifests ${t.manifest}`);
} else if (platform === "win") {
  // Win-static-audit P0-2/P0-3: the reader expects directories
  // chromium/chrome.exe + firefox/firefox.exe (bundled-native-browsers.ts),
  // and binVersion must spawn the .exe (extensionless spawn fails on Windows).
  copyTree(chromiumApp, path.join(t.chromium, "chrome.exe"));
  copyTree(firefoxApp, path.join(t.firefox, "firefox.exe"));
  const chromiumVersion = binVersion(path.join(t.chromium, "chrome.exe"));
  const firefoxVersion = binVersion(path.join(t.firefox, "firefox.exe"));
  fs.writeFileSync(t.manifest, JSON.stringify({ platform, chromiumVersion, firefoxVersion, syncedAt: new Date().toISOString() }, null, 2) + "\n");
  if (!chromiumVersion || !firefoxVersion) fail("version detection failed for a bundled browser", JSON.stringify({ chromiumVersion, firefoxVersion }));
  console.log(`  manifest: ${t.manifest}`);
  console.log(`  chromium ${chromiumVersion}, firefox ${firefoxVersion}`);
} else {
  // Linux keeps the bare-file layout (reader expects a `chromium` file).
  copyTree(chromiumApp, t.chromium);
  copyTree(firefoxApp, t.firefox);
  const chromiumVersion = binVersion(t.chromium);
  const firefoxVersion = binVersion(t.firefox);
  fs.writeFileSync(t.manifest, JSON.stringify({ platform, chromiumVersion, firefoxVersion, syncedAt: new Date().toISOString() }, null, 2) + "\n");
  if (!chromiumVersion || !firefoxVersion) fail("version detection failed for a bundled browser", JSON.stringify({ chromiumVersion, firefoxVersion }));
  console.log(`  manifest: ${t.manifest}`);
  console.log(`  chromium ${chromiumVersion}, firefox ${firefoxVersion}`);
}