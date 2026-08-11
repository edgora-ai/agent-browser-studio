import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { buildBrowserFingerprintArg } from "../main/services/browser-fingerprint-config.js";
import { captureFontCorpusInPage, type FontCorpus } from "./font-corpus.js";

interface Options {
  executable: string;
  profiles: string[];
  browserArgs: string[];
  label: string;
  output: string | null;
  managedPlatform: "windows" | "macos" | null;
  managedVersion: string;
  managedSeed: number;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    executable: "",
    profiles: [],
    browserArgs: [],
    label: "font-corpus",
    output: null,
    managedPlatform: null,
    managedVersion: "150.0.7871.114",
    managedSeed: 24680,
  };
  for (const arg of argv) {
    if (arg.startsWith("--executable=")) options.executable = path.resolve(arg.slice("--executable=".length));
    else if (arg.startsWith("--profile=")) options.profiles.push(path.resolve(arg.slice("--profile=".length)));
    else if (arg.startsWith("--browser-arg=")) options.browserArgs.push(arg.slice("--browser-arg=".length));
    else if (arg.startsWith("--label=")) options.label = arg.slice("--label=".length) || options.label;
    else if (arg.startsWith("--output=")) options.output = path.resolve(arg.slice("--output=".length));
    else if (arg === "--managed-platform=windows") options.managedPlatform = "windows";
    else if (arg === "--managed-platform=macos") options.managedPlatform = "macos";
    else if (arg.startsWith("--managed-version=")) options.managedVersion = arg.slice("--managed-version=".length);
    else if (arg.startsWith("--managed-seed=")) options.managedSeed = Number(arg.slice("--managed-seed=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.executable || !fs.existsSync(options.executable)) {
    throw new Error("usage: capture-font-corpus --executable=/path/to/browser [--profile=/path/to/template] [--browser-arg=flag]");
  }
  if (!Number.isInteger(options.managedSeed) || options.managedSeed <= 0) {
    throw new Error("--managed-seed must be a positive integer");
  }
  if (options.managedPlatform) {
    options.browserArgs.push(buildBrowserFingerprintArg({
      fingerprintSeed: options.managedSeed,
      platform: options.managedPlatform,
      locale: "en-US",
      timezone: "America/New_York",
    }, options.managedVersion));
  }
  return options;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function componentHashes(corpus: FontCorpus): Record<string, string> {
  return {
    availability: sha256({ window: corpus.window.availability, worker: corpus.worker.availability }),
    genericMetrics: sha256({
      window: corpus.window.genericMetrics,
      worker: corpus.worker.genericMetrics,
      dom: corpus.window.domGenericMetrics,
    }),
    namedMetrics: sha256({
      window: corpus.window.namedMetrics,
      worker: corpus.worker.namedMetrics,
      dom: corpus.window.domNamedMetrics,
    }),
    raster: sha256({ window: corpus.window.raster, worker: corpus.worker.raster }),
    localAccess: sha256(corpus.localAccess),
    full: sha256(corpus),
  };
}

async function startOrigin(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><meta charset=utf-8><title>Font corpus</title>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind font corpus origin");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function captureOne(
  options: Options,
  origin: string,
  profileTemplate: string | null,
  index: number,
): Promise<Record<string, unknown>> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-font-corpus-"));
  const userDataDir = path.join(tempRoot, "profile");
  if (profileTemplate) fs.cpSync(profileTemplate, userDataDir, { recursive: true, force: false });
  else fs.mkdirSync(userDataDir, { recursive: true });
  for (const relative of ["SingletonCookie", "SingletonLock", "SingletonSocket", path.join("Default", "LOCK")]) {
    const target = path.join(userDataDir, relative);
    try { fs.rmSync(target, { force: true }); } catch { /* temporary copy only */ }
  }
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: options.executable,
      headless: true,
      viewport: { width: 1280, height: 800 },
      timeout: 30_000,
      args: ["--no-first-run", "--disable-background-networking", ...options.browserArgs],
    });
    process.stderr.write(`[font-corpus] ${options.label} browser launched\n`);
    try { await context.grantPermissions(["local-fonts"], { origin }); } catch { /* captured as an API error */ }
    await context.route(`${origin}/**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><meta charset=utf-8><title>Font corpus</title>",
      });
    });
    const page = context.pages()[0] || await context.newPage();
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[font-corpus:page]")) process.stderr.write(`${text}\n`);
    });
    await page.goto(origin, { waitUntil: "load", timeout: 15_000 });
    process.stderr.write(`[font-corpus] ${options.label} page ready\n`);
    let corpusTimer: NodeJS.Timeout | null = null;
    const corpus = await Promise.race([
      page.evaluate(captureFontCorpusInPage),
      new Promise<never>((_resolve, reject) => {
        corpusTimer = setTimeout(() => reject(new Error("Font corpus page evaluation timed out")), 90_000);
      }),
    ]).finally(() => {
      if (corpusTimer) clearTimeout(corpusTimer);
    });
    const identity = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
    }));
    return {
      index,
      profile: profileTemplate ? path.basename(profileTemplate) : "fresh",
      identity,
      hashes: componentHashes(corpus),
      counts: {
        availableFonts: Object.values(corpus.window.availability).filter(Boolean).length,
        localFonts: corpus.localAccess.entries.length,
        genericMetricCases: Object.keys(corpus.window.genericMetrics).length,
        namedMetricCases: Object.keys(corpus.window.namedMetrics).length,
        rasterCases: Object.keys(corpus.window.raster).length,
      },
      corpus,
    };
  } finally {
    if (context) await context.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const origin = await startOrigin();
  try {
    const profiles = options.profiles.length ? options.profiles : [null];
    const results = [];
    for (let index = 0; index < profiles.length; index++) {
      process.stderr.write(`[font-corpus] ${options.label} ${index + 1}/${profiles.length}\n`);
      results.push(await captureOne(options, origin.origin, profiles[index], index + 1));
    }
    const report = { label: options.label, executable: options.executable, results };
    if (options.output) {
      fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    }
    process.stdout.write(JSON.stringify({
      label: options.label,
      executable: options.executable,
      output: options.output,
      results: results.map((result) => ({
        index: result.index,
        profile: result.profile,
        identity: result.identity,
        hashes: result.hashes,
        counts: result.counts,
      })),
    }, null, 2) + "\n");
  } finally {
    await origin.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[font-corpus] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
