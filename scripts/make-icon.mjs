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

  // Cute proportions: a deliberately oversized head with oversized round eyes
  // and an upward smile. The previous mark copied the app's nav glyph, which is
  // a line icon — evenly proportioned by design, and it read as neutral rather
  // than friendly at icon scale.
  const hinted = size < HINT_BELOW_16;
  const frac = hinted ? 0.86 : size <= 128 ? 0.78 : 0.8;
  const head = plate * frac;
  const hx = off + (plate - head) / 2;
  // The eye glint is the strongest cuteness cue but needs pixels to land on:
  // at 32px and below it aliases into a smear inside the eye.
  const glint = size >= 64;

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
    <clipPath id="plate"><rect x="${off}" y="${off}" width="${plate}" height="${plate}" rx="${r}" ry="${r}"/></clipPath>
  </defs>
  <rect x="${off}" y="${off}" width="${plate}" height="${plate}" rx="${r}" ry="${r}" fill="url(#g)"/>
  <rect x="${off}" y="${off}" width="${plate}" height="${plate}" rx="${r}" ry="${r}" fill="url(#spec)"/>
  <rect x="${off + inset / 2}" y="${off + inset / 2}" width="${plate - inset}" height="${plate - inset}"
        rx="${Math.max(r - inset / 2, 0)}" ry="${Math.max(r - inset / 2, 0)}"
        fill="none" stroke="url(#rim)" stroke-width="${inset}"/>
  <g clip-path="url(#plate)">
    <g transform="translate(${hx} ${hx}) scale(${head / (hinted ? 16 : 24)})" filter="url(#soft)">
${hinted ? robotHint16() : robotFace24(glint)}
    </g>
  </g>
</svg>`;
}

/** Cute robot face on a 24-unit grid: big round head, oversized eyes, smile.
 *
 *  The cuteness is carried by four things, each verified by rendering:
 *    - a head that is nearly circular (rx 0.5 of its own height, not 0.27);
 *    - eyes around a third of the head's width, not a seventh;
 *    - an upward-curving smile — a straight mouth line is what made the
 *      previous robot read as neutral rather than friendly;
 *    - a glint in each eye, the single strongest cue, but only at >=64px. */
function robotFace24(glint) {
  const eyeR = 3.1, eyeX = 4.8, eyeY = 12.6;
  let glints = "";
  if (glint) {
    const gr = eyeR * 0.34, gd = eyeR * 0.36;
    glints = `
    <circle cx="${12 - eyeX - gd}" cy="${eyeY - gd}" r="${gr}" fill="#fff"/>
    <circle cx="${12 + eyeX - gd}" cy="${eyeY - gd}" r="${gr}" fill="#fff"/>`;
  }
  return `    <rect x="11.1" y="4.6" width="1.8" height="3.4" rx="0.9" fill="url(#face)"/>
    <circle cx="12" cy="3.1" r="2.1" fill="url(#face)"/>
    <rect x="1.5" y="7.2" width="21" height="17" rx="8.5" fill="url(#face)"/>
    <circle cx="${12 - eyeX}" cy="${eyeY}" r="${eyeR}" fill="url(#g)"/>
    <circle cx="${12 + eyeX}" cy="${eyeY}" r="${eyeR}" fill="url(#g)"/>${glints}
    <path d="M9.2 17.4 a2.8 2.3 0 0 0 5.6 0" fill="none"
          stroke="url(#g)" stroke-width="1.8" stroke-linecap="round"/>`;
}

/**
 * Cute face snapped to an integer 16-unit grid, for 16px only.
 *
 * At that size the plate is ~12.9px, so the 24-grid face puts each eye on well
 * under a pixel and the whole thing smears. Keeping the *cuteness* rather than
 * just legibility needed three changes, each chosen by comparing renders:
 *   - the head nearly fills the grid, widening it to the full 16 units;
 *   - the eyes stay large and round-cornered, and the smile is still an arc —
 *     a plain rectangular mouth made it read as a machine again;
 *   - no glint: it has nowhere to land and just dirties the eye.
 */
function robotHint16() {
  return `    <rect x="7.1" y="1.8" width="1.8" height="2.4" rx="0.9" fill="url(#face)"/>
    <rect x="6" y="0.3" width="4" height="2" rx="1" fill="url(#face)"/>
    <rect x="0.5" y="3.6" width="15" height="11.9" rx="5" fill="url(#face)"/>
    <rect x="4.1" y="6.9" width="2.7" height="3.1" rx="1.3" fill="url(#g)"/>
    <rect x="9.2" y="6.9" width="2.7" height="3.1" rx="1.3" fill="url(#g)"/>
    <path d="M5.9 11.7 a2.1 1.7 0 0 0 4.2 0" fill="none"
          stroke="url(#g)" stroke-width="1.25" stroke-linecap="round"/>`;
}

/**
 * Monochrome menu-bar template — the same robot as the app icon.
 *
 * macOS recolours a template image from its ALPHA channel alone, so the face is
 * not two colours: it is holes punched through a solid head. Drawn on a 16-unit
 * grid.
 *
 * Three details make it read at 16pt, all found by comparing renders:
 *   - the eyes sit in the middle of the face; just under the top edge they read
 *     as notches in the silhouette;
 *   - the antenna is separated from the head by a gap; touching, the two merge
 *     into one lump;
 *   - the smile is a FILLED crescent, not a stroked arc. The app icon's 1.1px
 *     arc has too little pixel area at 1x and rasterizes into a notched blob,
 *     which reads as damage rather than a smile.
 */
function traySvg(size) {
  const pad = size * 0.02;
  const inner = size - pad * 2;
  const scale = inner / 16;
  const headTop = 4.4;
  const headH = 16 - headTop - 1.6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <mask id="knock">
      <rect x="0" y="0" width="16" height="16" fill="#000"/>
      <rect x="6" y="${headTop - 3.2}" width="4" height="2.2" rx="1" fill="#fff"/>
      <rect x="7.2" y="${headTop - 1.2}" width="1.6" height="1.3" rx="0.6" fill="#fff"/>
      <rect x="0.8" y="${headTop}" width="14.4" height="${headH}" rx="4.8" fill="#fff"/>
      <g fill="#000">
        <circle cx="5.9" cy="8.8" r="1.8"/>
        <circle cx="10.1" cy="8.8" r="1.8"/>
      </g>
      <path d="M5.9 11.6 h4.2 a2.1 2.1 0 0 1 -4.2 0 z" fill="#000"/>
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

/**
 * Assert the rendered plate is exactly PLATE/CANVAS of the canvas and that
 * nothing at all is painted outside it.
 *
 * macOS lays app icons out on a fixed grid, so drift here is what makes one
 * icon look oversized in the Dock. Both halves matter, and they fail in
 * different ways:
 *   - the plate size is a plain measurement, easy to get wrong when tuning
 *     proportions by hand;
 *   - content outside the plate means a shadow or glyph escaped its clip.
 *     Enlarging the face for the cute pass did exactly that: the plate stayed
 *     correct at 824/1024 while the drop shadow bled past its edge.
 *
 * The outside-the-plate test uses a threshold of 0 (any non-transparent pixel),
 * deliberately. A first attempt used 60 to "ignore soft shadows" and passed on
 * the broken build — at 512px the spill sat at alpha 17, under the threshold,
 * so the check was blind to the very defect it existed to catch. Measured on a
 * correct build, alpha outside the plate is exactly 0, so there is no such
 * thing as a legitimate shadow bleed to tolerate.
 */
async function assertPlateGeometry(browser, size = 512) {
  const tmp = path.join(os.tmpdir(), `icon-geom-${size}.png`);
  await shoot(browser, appIconSvg(size), size, tmp);
  const page = await browser.newPage();
  const probe = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const alpha = (x, y) => data[(y * c.width + x) * 4 + 3];
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (alpha(x, y) > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { minX, minY, maxX, maxY, W: c.width, H: c.height };
  }, `data:image/png;base64,${fs.readFileSync(tmp).toString("base64")}`);
  await page.close();

  const scale = size / CANVAS;
  const expected = PLATE * scale;
  const off = OFF * scale;
  const gotW = probe.maxX - probe.minX + 1;
  const gotH = probe.maxY - probe.minY + 1;

  const problems = [];
  if (Math.abs(gotW - expected) > 2 || Math.abs(gotH - expected) > 2) {
    problems.push(`plate is ${gotW}x${gotH}, expected ${expected}x${expected}`);
  }
  if (probe.minX < off - 1 || probe.minY < off - 1) {
    problems.push(
      `content escapes the plate (starts at ${probe.minX},${probe.minY}; plate starts at ${off}) — ` +
        `a shadow or glyph is not clipped`
    );
  }
  if (problems.length) {
    throw new Error(`plate geometry wrong at ${size}px: ${problems.join("; ")}`);
  }
  console.log(`✓ plate geometry: ${gotW}x${gotH} of ${size} (${((gotW / size) * 100).toFixed(1)}%)`);
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
    await assertPlateGeometry(browser);

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
