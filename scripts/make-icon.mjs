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

// macOS Big Sur+ geometry: content occupies 824 of a 1024 canvas with an
// 185.4pt corner radius. The previous icon filled 945/1024 (92%), which is why
// it looked oversized and crowded next to other Dock icons.
const CANVAS = 1024;
const PLATE = 824;
const OFF = (CANVAS - PLATE) / 2;
const RADIUS = 185.4;

// A raster smaller than this gets a grid-snapped face instead of the scaled
// master. Unlike the previous mark, only 16px needs it: the robot's features
// are chunky enough that 32px renders the 24-unit version cleanly.
const HINT_BELOW_16 = 32;

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
 * The mark: a robot head on the accent-gradient plate.
 *
 * The proportions come from the app's own `robot` glyph (src/renderer/js/app/
 * icons.js, used by the Agents nav item), so the Dock icon and the product's
 * icon set are the same character: rounded head, antenna with a ball, two eyes,
 * a mouth line.
 *
 * Read at three distances: the plate at 16px, the head at 32px, the eyes and
 * mouth at 64px+. The browser-window mark this replaced leaned on chrome detail
 * that had to be suppressed at small sizes to avoid a grey smear; the robot's
 * features scale down more gracefully.
 */
function appIconSvg(size) {
  const s = size / CANVAS;
  const plate = PLATE * s;
  const off = OFF * s;
  const r = RADIUS * s;
  const inset = 3 * s;

  // The head grows as the raster shrinks, so the mark keeps its optical weight
  // once the fine detail drops away. The hinted face only spans 14 of its 16
  // units, so it needs a larger frac to land at the same optical size.
  const hinted = size < HINT_BELOW_16;
  const frac = hinted ? 0.84 : size <= 128 ? 0.66 : 0.6;
  const head = plate * frac;
  const hx = off + (plate - head) / 2;

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
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#eeeaff"/>
    </linearGradient>
    <filter id="soft" x="-45%" y="-45%" width="190%" height="190%">
      <feDropShadow dx="0" dy="${7 * s}" stdDeviation="${10 * s}"
                    flood-color="#2a1a66" flood-opacity="0.40"/>
    </filter>
  </defs>
  <rect x="${off}" y="${off}" width="${plate}" height="${plate}" rx="${r}" ry="${r}" fill="url(#g)"/>
  <rect x="${off}" y="${off}" width="${plate}" height="${plate}" rx="${r}" ry="${r}" fill="url(#spec)"/>
  <rect x="${off + inset / 2}" y="${off + inset / 2}" width="${plate - inset}" height="${plate - inset}"
        rx="${Math.max(r - inset / 2, 0)}" ry="${Math.max(r - inset / 2, 0)}"
        fill="none" stroke="url(#rim)" stroke-width="${inset}"/>
  <g transform="translate(${hx} ${hx}) scale(${head / (hinted ? 16 : 24)})" filter="url(#soft)">
${hinted ? robotHint16() : robotFace24()}
  </g>
</svg>`;
}

/** Robot face on the app's 24-unit grid, matching the `robot` nav glyph. */
function robotFace24() {
  // Eyes and mouth knock out to the plate gradient rather than a flat purple,
  // so the face reads as cut into the head instead of painted on it.
  return `    <rect x="11.1" y="4.2" width="1.8" height="3.8" rx="0.9" fill="url(#face)"/>
    <circle cx="12" cy="3" r="2" fill="url(#face)"/>
    <rect x="3.6" y="7.6" width="16.8" height="12.4" rx="3.4" fill="url(#face)"/>
    <circle cx="8.6" cy="13.4" r="1.7" fill="url(#g)"/>
    <circle cx="15.4" cy="13.4" r="1.7" fill="url(#g)"/>
    <rect x="9.5" y="16.4" width="5" height="1.4" rx="0.7" fill="url(#g)"/>`;
}

/**
 * Robot face snapped to an integer 16-unit grid, for 16px only.
 *
 * At that size the plate is ~12.9px, so the 24-grid face puts each eye on well
 * under a pixel and the whole thing smears. Three adjustments make it read,
 * each chosen by comparing renders:
 *   - the head is enlarged to 0.84 of the plate (vs 0.6) to buy pixel room;
 *   - the eyes are 2.4 units apart with a 2.6-unit gap, so they rasterize as
 *     two marks rather than merging into a single band;
 *   - the mouth is kept despite the tight space — without it the two eye marks
 *     read as slots in a blank box.
 */
function robotHint16() {
  return `    <rect x="7" y="2.2" width="2" height="2.6" rx="0.8" fill="url(#face)"/>
    <rect x="6" y="0.8" width="4" height="2" rx="1" fill="url(#face)"/>
    <rect x="1" y="4.2" width="14" height="9.8" rx="2.6" fill="url(#face)"/>
    <rect x="4.2" y="7.4" width="2.4" height="3" rx="0.9" fill="url(#g)"/>
    <rect x="9.4" y="7.4" width="2.4" height="3" rx="0.9" fill="url(#g)"/>
    <rect x="6" y="11.6" width="4" height="1.4" rx="0.6" fill="url(#g)"/>`;
}

/**
 * Monochrome menu-bar template — the same robot as the app icon.
 *
 * macOS recolours a template image from its ALPHA channel alone, so the face is
 * not two colours: it is holes punched through a solid head. Drawn on a 16-unit
 * grid.
 *
 * Two details are what make it read at 16pt, both found by comparing renders:
 * the eyes sit in the middle of the face (just under the top edge they read as
 * notches in the silhouette), and the antenna is separated from the head by a
 * gap (touching, the two merge into one lump).
 */
function traySvg(size) {
  const pad = size * 0.02;
  const inner = size - pad * 2;
  const scale = inner / 16;
  const headTop = 5.4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <mask id="knock">
      <rect x="0" y="0" width="16" height="16" fill="#000"/>
      <rect x="6" y="${headTop - 3.4}" width="4" height="2.2" rx="1" fill="#fff"/>
      <rect x="7.1" y="${headTop - 1.4}" width="1.8" height="1.5" rx="0.6" fill="#fff"/>
      <rect x="1.5" y="${headTop}" width="13" height="${16 - headTop - 2.2}" rx="2.8" fill="#fff"/>
      <g fill="#000">
        <circle cx="5.8" cy="8.4" r="1.5"/>
        <circle cx="10.2" cy="8.4" r="1.5"/>
        <rect x="5.8" y="11.3" width="4.4" height="1.5" rx="0.7"/>
      </g>
    </mask>
  </defs>
  <g transform="translate(${pad} ${pad}) scale(${scale})">
    <rect x="0" y="0" width="16" height="16" fill="#000" mask="url(#knock)"/>
  </g>
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
