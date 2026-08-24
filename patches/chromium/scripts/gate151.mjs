#!/usr/bin/env node
// Phase-5 gate runner for the Chromium 151 upgrade.
// Captures the same corpora from OUR built binary that capture-stock151.mjs
// captured from stock Chrome, then compares capability SHAs using the exact
// normalization from verify-native-chromium.ts.
//
// Usage:
//   node patches/chromium/scripts/gate151.mjs <our-chromium-binary> [stock-ref-json]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { captureWebGlCorpusInPage } from "../../../dist/tools/webgl-corpus.js";
import { captureWebGpuCorpusInPage } from "../../../dist/tools/webgpu-corpus.js";
import { captureStorageCorpusInPage } from "../../../dist/tools/storage-corpus.js";
import { captureFontCorpusInPage } from "../../../dist/tools/font-corpus.js";

const [, , binArg, refArg] = process.argv;
if (!binArg) {
  console.error("usage: gate151.mjs <our-chromium-binary> [stock-ref-json]");
  process.exit(2);
}
const bin = path.resolve(binArg);
const refPath = path.resolve(
  refArg ?? new URL("../corpora-151/stock-chrome-151.0.7922.170.json", import.meta.url).pathname,
);
const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));

const sha = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
const normGl = (c) => ({
  vendor: c.vendor,
  renderer: c.renderer,
  contextAttributes: c.contextAttributes,
  extensions: c.extensions,
  parameters: c.parameters,
  shaderPrecision: c.shaderPrecision,
});
const glSha = (w) => sha({ webgl1: normGl(w.webgl1), webgl2: normGl(w.webgl2) });
const gpuSha = (w) =>
  sha({
    available: w.available,
    adapter: w.adapter ? { features: w.adapter.features, limits: w.adapter.limits } : null,
    device: w.device ? { features: w.device.features, limits: w.device.limits } : null,
    preferredCanvasFormat: w.preferredCanvasFormat,
    wgslLanguageFeatures: w.wgslLanguageFeatures,
    error: w.error,
  });

const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
console.log(`gate target : ${version}\n             ${bin}`);
console.log(`stock ref   : ${ref.browserVersion} (${refPath})\n`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate151-profile-"));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>gate151</title>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: bin,
  headless: false,
  args: ["--no-first-run", "--no-default-browser-check"],
});
let ours;
try {
  const page = await context.newPage();
  const { port } = server.address();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  ours = {
    userAgent: await page.evaluate(() => navigator.userAgent),
    webgl: await page.evaluate(captureWebGlCorpusInPage),
    webgpu: await page.evaluate(captureWebGpuCorpusInPage),
    storage: await page.evaluate(captureStorageCorpusInPage),
    fonts: await page.evaluate(captureFontCorpusInPage),
  };
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  server.close();
}

const rows = [];
const check = (name, pass, detail) => rows.push({ name, pass, detail });

check(
  "UA version family",
  /Chrome\/151\./.test(ours.userAgent) || /151\./.test(version),
  `ours=${ours.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "?"}`,
);
check(
  "WebGL capability SHA == stock151",
  glSha(ours.webgl.window) === glSha(ref.webgl.window),
  `${glSha(ours.webgl.window).slice(0, 12)}… vs ${glSha(ref.webgl.window).slice(0, 12)}…`,
);
check(
  "WebGPU capability SHA == stock151",
  gpuSha(ours.webgpu.window) === gpuSha(ref.webgpu.window),
  `${gpuSha(ours.webgpu.window).slice(0, 12)}… vs ${gpuSha(ref.webgpu.window).slice(0, 12)}…`,
);
check(
  "WebGL Window==Worker",
  JSON.stringify(ours.webgl.window) === JSON.stringify(ours.webgl.worker),
  "",
);
check(
  "WebGPU Window==Worker",
  JSON.stringify(ours.webgpu.window) === JSON.stringify(ours.webgpu.worker),
  "",
);
check("OPFS available", ours.storage.window.opfs.available === true, "");
check(
  "Fonts generic cases == stock151",
  Object.keys(ours.fonts.window.genericMetrics ?? {}).length ===
    Object.keys(ref.fonts.window.genericMetrics ?? {}).length,
  `${Object.keys(ours.fonts.window.genericMetrics ?? {}).length} vs ${
    Object.keys(ref.fonts.window.genericMetrics ?? {}).length
  }`,
);

for (const r of rows) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `   (${r.detail})` : ""}`);
}
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} gates passed`);
process.exit(failed ? 1 : 0);
