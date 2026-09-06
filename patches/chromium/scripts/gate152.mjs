#!/usr/bin/env node
// Phase-5 gate runner for the Chromium 152 upgrade.
// Captures the same corpora from OUR built binary that capture-stock152.mjs
// captured from stock Chrome, then compares capability SHAs using the exact
// normalization from verify-native-chromium.ts.
//
// Usage:
//   node patches/chromium/scripts/gate152.mjs <our-chromium-binary> [stock-ref-json]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { captureWebGlCorpusInPage } from "../../../dist/tools/webgl-corpus.js";
import { captureWebGpuCorpusInPage } from "../../../dist/tools/webgpu-corpus.js";
import { captureStorageCorpusInPage } from "../../../dist/tools/storage-corpus.js";
import { captureFontCorpusInPage } from "../../../dist/tools/font-corpus.js";

const TARGET_VERSION = "152.0.7977.72";
const [, , binArg, refArg] = process.argv;
if (!binArg) {
  console.error("usage: gate152.mjs <our-chromium-binary> [stock-ref-json]");
  process.exit(2);
}
const bin = path.resolve(binArg);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const refPath = path.resolve(
  refArg ?? path.join(scriptDirectory, "..", "corpora-152", "stock-chrome-152.0.7977.64.json"),
);
if (!fs.existsSync(bin) || !fs.statSync(bin).isFile()) {
  console.error(`target Chromium binary does not exist: ${bin}`);
  process.exit(2);
}
try {
  fs.accessSync(bin, fs.constants.X_OK);
} catch {
  console.error(`target Chromium binary is not executable: ${bin}`);
  process.exit(2);
}
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
const fontCanvasSha = (fonts) => sha({ window: fonts.window, worker: fonts.worker });
const withTimeout = (label, promise, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
const capture = async (page, label, evaluator, timeoutMs = 120_000) => {
  const startedAt = Date.now();
  console.log(`capture     : ${label}`);
  const result = await withTimeout(label, page.evaluate(evaluator), timeoutMs);
  console.log(`captured    : ${label} (${Date.now() - startedAt} ms)`);
  return result;
};
const workerComparableFontCanvas = (windowCanvas) => {
  const { domGenericMetrics: _domGenericMetrics, domNamedMetrics: _domNamedMetrics, ...canvas } = windowCanvas;
  return canvas;
};

const versionText = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
const version = versionText.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
if (version !== TARGET_VERSION) {
  console.error(`target Chromium version must be ${TARGET_VERSION}, got: ${versionText}`);
  process.exit(1);
}
console.log(`gate target : ${versionText}\n             ${bin}`);
console.log(`stock ref   : ${ref.browserVersion} (${refPath})\n`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate152-profile-"));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>gate152</title>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
let context;
let ours;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: bin,
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = await context.newPage();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gate152 origin did not bind to a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  await context.grantPermissions(["local-fonts"], { origin });
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("[font-corpus:page]")) console.log(text);
  });
  await page.goto(`${origin}/`, { waitUntil: "load" });
  ours = {
    userAgent: await capture(page, "user agent", () => navigator.userAgent, 30_000),
    webgl: await capture(page, "WebGL corpus", captureWebGlCorpusInPage),
    webgpu: await capture(page, "WebGPU corpus", captureWebGpuCorpusInPage, 180_000),
    storage: await capture(page, "storage corpus", captureStorageCorpusInPage),
    fonts: await capture(page, "font corpus", captureFontCorpusInPage, 180_000),
  };
} finally {
  if (context) await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}

const rows = [];
const check = (name, pass, detail) => rows.push({ name, pass, detail });

check(
  "UA version family",
  /Chrome\/152\./.test(ours.userAgent),
  `ours=${ours.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "?"}`,
);
check(
  "WebGL capability SHA == stock152",
  glSha(ours.webgl.window) === glSha(ref.webgl.window),
  `${glSha(ours.webgl.window).slice(0, 12)}... vs ${glSha(ref.webgl.window).slice(0, 12)}...`,
);
check(
  "WebGPU capability SHA == stock152",
  gpuSha(ours.webgpu.window) === gpuSha(ref.webgpu.window),
  `${gpuSha(ours.webgpu.window).slice(0, 12)}... vs ${gpuSha(ref.webgpu.window).slice(0, 12)}...`,
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
  "Fonts canvas SHA == stock152",
  fontCanvasSha(ours.fonts) === fontCanvasSha(ref.fonts),
  `${fontCanvasSha(ours.fonts).slice(0, 12)}... vs ${fontCanvasSha(ref.fonts).slice(0, 12)}...`,
);
check(
  "Fonts Window==Worker canvas",
  JSON.stringify(workerComparableFontCanvas(ours.fonts.window)) === JSON.stringify(ours.fonts.worker),
  "",
);

for (const row of rows) {
  console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.name}${row.detail ? `   (${row.detail})` : ""}`);
}
const failed = rows.filter((row) => !row.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} gates passed`);
process.exit(failed ? 1 : 0);
