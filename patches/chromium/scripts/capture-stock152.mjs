#!/usr/bin/env node
// Capture the stock-Chrome capability corpora (WebGL / WebGPU / Storage) used
// as Phase-4 references for the Chromium 152 upgrade. Writes one JSON evidence
// file per run into patches/chromium/corpora-152/.
//
// Usage:
//   node patches/chromium/scripts/capture-stock152.mjs <chrome-executable> <out-json> [label]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { captureWebGlCorpusInPage } from "../../../dist/tools/webgl-corpus.js";
import { captureWebGpuCorpusInPage } from "../../../dist/tools/webgpu-corpus.js";
import { captureStorageCorpusInPage } from "../../../dist/tools/storage-corpus.js";
import { captureFontCorpusInPage } from "../../../dist/tools/font-corpus.js";

const [, , executableArg, outArg, labelArg] = process.argv;
if (!executableArg || !outArg) {
  console.error("usage: capture-stock152.mjs <chrome-executable> <out-json> [label]");
  process.exit(2);
}
const executable = path.resolve(executableArg);
const outPath = path.resolve(outArg);
const label = labelArg ?? "stock";
if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
  console.error(`stock Chrome binary does not exist: ${executable}`);
  process.exit(2);
}

const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stock152-profile-"));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>stock152</title>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let context;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: executable,
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  // Storage buckets/OPFS and full WebGPU require a secure context; loopback
  // HTTP is a potentially trustworthy origin under the secure-context spec.
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stock152 origin did not bind to a TCP port");
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  const result = {
    label,
    executable,
    browserVersion: version,
    capturedAt: new Date().toISOString(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    userAgentData: await page.evaluate(() =>
      navigator.userAgentData ? JSON.parse(JSON.stringify(navigator.userAgentData)) : null),
    webgl: await page.evaluate(captureWebGlCorpusInPage),
    webgpu: await page.evaluate(captureWebGpuCorpusInPage),
    storage: await page.evaluate(captureStorageCorpusInPage),
    fonts: await page.evaluate(captureFontCorpusInPage),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`captured ${version} -> ${outPath}`);
} finally {
  if (context) await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}
