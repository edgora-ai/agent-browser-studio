#!/usr/bin/env node
/**
 * Brand app-icon generator.
 *
 * The mark is authored as an SVG using the app's own theme tokens
 * (--accent-gradient = #5b6cf0 → #8b5cf6) and the same bolt path as the sidebar
 * brand mark, so the window, the Dock and the menu bar all show one identity.
 * Rasterizing from a vector master keeps every size crisp and lets a designer
 * change one path instead of re-deriving six PNGs by hand.
 *
 * Usage:
 *   node scripts/make-icon.mjs            # write resources/icon.{icns,ico} + tray
 *   node scripts/make-icon.mjs --preview  # write PNGs to a temp dir only
 *
 * Rasterizer: Playwright's Chromium (a devDependency) — no ImageMagick/rsvg.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── Design tokens (mirror src/renderer/css/style.css) ──
const GRAD_FROM = "#5b6cf0";
const GRAD_TO = "#8b5cf6";
const BOLT = "M13.2 2 5 13.2h4.6L10.8 22 19 10.8h-4.6L13.2 2z";

// macOS Big Sur+ geometry: content occupies 824 of a 1024 canvas with an
// 185.4pt corner radius. The previous icon filled 945/1024 (92%), which is why
// it looked oversized and crowded next to other Dock icons.
const CANVAS = 1024;
const PLATE = 824;
const OFF = (CANVAS - PLATE) / 2;
const RADIUS = 185.4;

// A raster smaller than this gets a hinted glyph instead of a scaled master:
// the bolt's thin diagonal joins dissolve into mush below ~48px.
const HINT_BELOW = 48;

/**
 * Bolt snapped to an integer 16-unit grid, for rasters too small to resolve the
 * master's thin joins. It keeps the bolt silhouette (offset arms + diagonal)
 * rather than degenerating into a plus/dagger, which is what an axis-aligned
 * "pixel bolt" does at 16px.
 */
const BOLT_HINT = "M10 0 3 9h3.5L5.5 16 13 7H9.5L10 0z";

/** Playwright pins one exact browser build; a cache holding a different build
 *  makes launch() throw even though a usable Chromium is on disk. */
function resolveChromium() {
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  let entries = [];
  try {
    entries = fs.readdirSync(cache);
  } catch {
    /* no cache — fall through to system Chrome */
  }
  for (const e of entries.filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const p = path.join(cache, e, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    if (fs.existsSync(p)) return p;
  }
  for (const e of entries.filter((n) => n.startsWith("chromium-")).sort().reverse()) {
    for (const arch of ["chrome-mac-arm64", "chrome-mac"]) {
      const p = path.join(cache, e, arch, "Chromium.app", "Contents", "MacOS", "Chromium");
      if (fs.existsSync(p)) return p;
    }
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return fs.existsSync(chrome) ? chrome : undefined;
}

/**
 * The mark: a browser window (white card, chrome bar, traffic lights) carrying
 * the brand bolt, on the accent-gradient plate.
 *
 * Read at three distances: the plate silhouette at 16px, the window at 32px,
 * and the lights + bolt detail at 64px+. The plain bolt-on-a-plate version this
 * replaced was legible but said nothing about what the app does.
 */
function appIconSvg(size) {
  const s = size / CANVAS;
  const plate = PLATE * s;
  const off = OFF * s;
  const r = RADIUS * s;
  const inset = 3 * s;

  // The window grows as the raster shrinks, so the mark keeps the same optical
  // weight once the fine detail drops away.
  const hinted = size < HINT_BELOW;
  const frac = hinted ? 0.78 : size <= 128 ? 0.71 : 0.64;
  const wside = plate * frac;
  const wx = off + (plate - wside) / 2;
  const wy = wx;
  const wr = wside * 0.22;

  // Chrome-bar detail has a floor below which it rasterizes into a grey smear
  // rather than reading as a bar with lights (see how 16px rendered with it on).
  const showBar = size >= 32;
  const showLights = size >= 64;
  const bar = showBar ? wside * 0.24 : 0;
  const barEdge = Math.max(bar * 0.12, 0.5 * s);

  const grid = hinted ? 16 : 24;
  const bside = wside * 0.54;
  const bscale = bside / grid;
  const bx = wx + wside / 2 - bside / 2;
  const by = wy + bar + (wside - bar) / 2 - bside / 2;

  let lights = "";
  if (showLights) {
    const dr = bar * 0.29;
    for (let i = 0; i < 3; i++) {
      lights += `\n  <circle cx="${wx + bar * 0.66 + i * bar * 0.64}" cy="${wy + bar / 2}" r="${dr}" fill="#cccede"/>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="${GRAD_FROM}"/>
      <stop offset="1" stop-color="${GRAD_TO}"/>
    </linearGradient>
    <radialGradient id="spec" cx="0.3" cy="0.1" r="0.95">
      <stop offset="0" stop-color="#fff" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.5"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-45%" y="-45%" width="190%" height="190%">
      <feDropShadow dx="0" dy="${7 * s}" stdDeviation="${10 * s}"
                    flood-color="#2a1a66" flood-opacity="0.42"/>
    </filter>
    <clipPath id="wc"><rect x="${wx}" y="${wy}" width="${wside}" height="${wside}" rx="${wr}" ry="${wr}"/></clipPath>
  </defs>
  <rect x="${off}" y="${off}" width="${plate}" height="${plate}" rx="${r}" ry="${r}" fill="url(#g)"/>
  <rect x="${off}" y="${off}" width="${plate}" height="${plate}" rx="${r}" ry="${r}" fill="url(#spec)"/>
  <rect x="${off + inset / 2}" y="${off + inset / 2}" width="${plate - inset}" height="${plate - inset}"
        rx="${Math.max(r - inset / 2, 0)}" ry="${Math.max(r - inset / 2, 0)}"
        fill="none" stroke="url(#rim)" stroke-width="${inset}"/>
  <g filter="url(#soft)">
    <rect x="${wx}" y="${wy}" width="${wside}" height="${wside}" rx="${wr}" ry="${wr}" fill="#ffffff"/>
  </g>${
    showBar
      ? `
  <g clip-path="url(#wc)">
    <rect x="${wx}" y="${wy}" width="${wside}" height="${bar}" fill="#f1f1fa"/>
    <rect x="${wx}" y="${wy + bar - barEdge}" width="${wside}" height="${barEdge}" fill="#dfdff0"/>
  </g>${lights}`
      : ""
  }
  <g transform="translate(${bx} ${by}) scale(${bscale})">
    <path d="${hinted ? BOLT_HINT : BOLT}" fill="#7b5cf0"/>
  </g>
</svg>`;
}

/** Monochrome menu-bar template. macOS tints it, so only alpha matters; the
 *  bolt is drawn on a 16-unit grid to survive the 1x raster. */
function traySvg(size) {
  const pad = size * 0.06;
  const inner = size - pad * 2;
  const scale = inner / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="translate(${pad} ${pad}) scale(${scale})"><path d="${BOLT}" fill="#000"/></g>
</svg>`;
}

async function shoot(browser, svg, size, outPath) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;padding:0;background:transparent">${svg}</body></html>`,
    { waitUntil: "load" }
  );
  await page.screenshot({ path: outPath, omitBackground: true });
  await page.close();
}

async function main() {
  const preview = process.argv.includes("--preview");
  // Intermediate rasters are build inputs, not shipped assets: stage them in a
  // temp dir so resources/ holds only icon.icns, icon.ico and the tray.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-build-"));
  const resDir = path.join(repoRoot, "resources");
  if (!preview) fs.mkdirSync(resDir, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  try {
    for (const size of sizes) {
      await shoot(browser, appIconSvg(size), size, path.join(outDir, `icon_${size}.png`));
    }
    // Menu-bar template: 16pt at 1x plus its @2x sibling, which Electron loads
    // automatically for Retina menu bars (Electron resolves the @2x filename).
    const tray1x = path.join(outDir, "tray-icon-Template.png");
    const tray2x = path.join(outDir, "tray-icon-Template@2x.png");
    await shoot(browser, traySvg(16), 16, tray1x);
    await shoot(browser, traySvg(32), 32, tray2x);
    console.log(`rasterized ${sizes.length} icon sizes + tray → ${outDir}`);

    if (preview) return;
    fs.copyFileSync(tray1x, path.join(resDir, "tray-icon-Template.png"));
    fs.copyFileSync(tray2x, path.join(resDir, "tray-icon-Template@2x.png"));
  } finally {
    await browser.close();
  }

  // ── macOS .icns (iconutil needs Apple's exact iconset names) ──
  const iconset = path.join(outDir, "icon.iconset");
  fs.mkdirSync(iconset, { recursive: true });
  for (const [size, name] of [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ]) {
    fs.copyFileSync(path.join(outDir, `icon_${size}.png`), path.join(iconset, name));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(resDir, "icon.icns")]);
  console.log("✓ resources/icon.icns");

  // ── Windows .ico — Pillow assembles the multi-size container ──
  execFileSync(
    "python3",
    [
      "-c",
      `from PIL import Image
d = ${JSON.stringify(outDir)}
Image.open(d + "/icon_256.png").convert("RGBA").save(
    ${JSON.stringify(path.join(resDir, "icon.ico"))},
    format="ICO", sizes=[(s, s) for s in (16, 32, 48, 256)])
print("✓ resources/icon.ico")`,
    ],
    { stdio: "inherit" }
  );

  console.log("\nDone. Rebuild with: npm run build");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
