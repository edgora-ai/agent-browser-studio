import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  canonicalizeHttp3,
  canonicalizeTlsAndHttp2,
  diffNetworkFingerprint,
  networkFingerprintHash,
  type Http2CorpusIdentity,
  type Http3CorpusIdentity,
  type TlsCorpusIdentity,
} from "./network-fingerprint-corpus.js";

const PEET_ENDPOINT = "https://tls.peet.ws/api/all";
const TLS_ENDPOINT = "https://tls.tlsfingerprint.io/api/client-fingerprint";
const QUIC_ENDPOINT = "https://quic.tlsfingerprint.io/api/client-fingerprint-quic";

interface BrowserSpec {
  label: string;
  executablePath: string;
  bootstrapFile: string | null;
}

interface Options {
  reference: string;
  candidates: string[];
  samples: number;
  output: string | null;
  browsers: BrowserSpec[];
}

interface ComponentSample {
  index: number;
  tls: TlsCorpusIdentity | null;
  http2: Http2CorpusIdentity | null;
  http3: Http3CorpusIdentity | null;
  errors: string[];
}

interface ComponentSummary<T> {
  complete: boolean;
  stable: boolean;
  hashes: string[];
  identity: T | null;
}

interface BrowserResult {
  label: string;
  executablePath: string;
  version: string;
  majorVersion: number | null;
  samples: ComponentSample[];
  tls: ComponentSummary<TlsCorpusIdentity>;
  http2: ComponentSummary<Http2CorpusIdentity>;
  http3: ComponentSummary<Http3CorpusIdentity>;
}

function resolveExecutable(input: string): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() && resolved.endsWith(".app")) {
    const appName = path.basename(resolved, ".app");
    for (const name of [appName, "Chromium", "Google Chrome", "RoxyChrome"]) {
      const candidate = path.join(resolved, "Contents", "MacOS", name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  throw new Error(`browser executable not found: ${input}`);
}

function parseBrowser(value: string, index: number): BrowserSpec {
  const separator = value.indexOf("=");
  const label = separator > 0 ? value.slice(0, separator) : `browser-${index + 1}`;
  const spec = separator > 0 ? value.slice(separator + 1) : value;
  const bootstrapSeparator = spec.indexOf("::");
  const executableInput = bootstrapSeparator < 0 ? spec : spec.slice(0, bootstrapSeparator);
  const bootstrapInput = bootstrapSeparator < 0 ? "" : spec.slice(bootstrapSeparator + 2);
  const bootstrapFile = bootstrapInput ? path.resolve(bootstrapInput) : null;
  if (!label || !/^[a-zA-Z0-9._-]+$/.test(label)) throw new Error(`invalid browser label: ${label}`);
  if (bootstrapFile && (!fs.existsSync(bootstrapFile) || !fs.statSync(bootstrapFile).isFile())) {
    throw new Error(`bootstrap file not found: ${bootstrapInput}`);
  }
  return { label, executablePath: resolveExecutable(executableInput), bootstrapFile };
}

function parseOptions(argv: string[]): Options {
  let reference = "";
  const candidates: string[] = [];
  let samples = 2;
  let output: string | null = null;
  const browserArgs: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--reference=")) reference = arg.slice("--reference=".length);
    else if (arg.startsWith("--candidate=")) candidates.push(arg.slice("--candidate=".length));
    else if (arg.startsWith("--samples=")) samples = Number(arg.slice("--samples=".length));
    else if (arg.startsWith("--output=")) output = path.resolve(arg.slice("--output=".length));
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else browserArgs.push(arg);
  }
  if (!reference || !candidates.length || browserArgs.length < 2) {
    throw new Error(
      "usage: verify-network-fingerprint --reference=stock --candidate=managed " +
      "[--samples=2] 'stock=/path/to/browser[::bootstrap]' 'managed=/path/to/browser' [...]",
    );
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 5) {
    throw new Error("--samples must be an integer from 1 to 5");
  }
  const browsers = browserArgs.map(parseBrowser);
  const labels = browsers.map((browser) => browser.label);
  if (new Set(labels).size !== labels.length) throw new Error("browser labels must be unique");
  for (const label of [reference, ...candidates]) {
    if (!labels.includes(label)) throw new Error(`comparison label is missing: ${label}`);
  }
  return { reference, candidates, samples, output, browsers };
}

function detectVersion(executablePath: string): { version: string; majorVersion: number | null } {
  try {
    const output = execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
    const version = output.match(/\d+\.\d+\.\d+\.\d+/)?.[0] || output;
    const majorVersion = Number(version.split(".")[0]);
    return { version, majorVersion: Number.isInteger(majorVersion) ? majorVersion : null };
  } catch {
    return { version: path.basename(executablePath), majorVersion: null };
  }
}

function runToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readJsonNavigation(
  page: Page,
  endpoint: string,
  label: string,
  attempts = 2,
): Promise<{ value: unknown; protocol: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const joiner = endpoint.includes("?") ? "&" : "?";
      const response = await page.goto(`${endpoint}${joiner}run=${runToken()}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (!response || !response.ok()) {
        throw new Error(`${label} returned HTTP ${response?.status() ?? "no response"}`);
      }
      const body = (await page.textContent("body"))?.trim() || "";
      if (!body) throw new Error(`${label} returned an empty body`);
      const value = JSON.parse(body) as unknown;
      const protocol = await page.evaluate(() =>
        (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)
          ?.nextHopProtocol || "");
      return { value, protocol };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await page.waitForTimeout(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function launchArgs(): string[] {
  return [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--password-store=basic",
    "--use-mock-keychain",
    "--enable-quic",
    "--origin-to-force-quic-on=quic.tlsfingerprint.io:443",
  ];
}

async function captureSample(spec: BrowserSpec, index: number): Promise<ComponentSample> {
  const result: ComponentSample = { index, tls: null, http2: null, http3: null, errors: [] };
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let temporaryProfile: string | null = null;
  try {
    let page: Page;
    if (spec.bootstrapFile) {
      temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), "roxy-network-fingerprint-"));
      fs.copyFileSync(spec.bootstrapFile, path.join(temporaryProfile, path.basename(spec.bootstrapFile)));
      context = await chromium.launchPersistentContext(temporaryProfile, {
        executablePath: spec.executablePath,
        headless: true,
        locale: "en-US",
        timeout: 30_000,
        args: launchArgs(),
      });
      page = context.pages()[0] || await context.newPage();
    } else {
      browser = await chromium.launch({
        executablePath: spec.executablePath,
        headless: true,
        timeout: 30_000,
        args: launchArgs(),
      });
      context = await browser.newContext({ locale: "en-US" });
      page = await context.newPage();
    }

    let peet: { value: unknown; protocol: string } | null = null;
    let tlsFingerprint: { value: unknown; protocol: string } | null = null;
    try {
      peet = await readJsonNavigation(page, PEET_ENDPOINT, "TLS/HTTP2 observer");
      tlsFingerprint = await readJsonNavigation(page, TLS_ENDPOINT, "normalized TLS observer");
      const identity = canonicalizeTlsAndHttp2(peet.value, tlsFingerprint.value, peet.protocol);
      result.tls = identity.tls;
      result.http2 = identity.http2;
    } catch (error) {
      result.errors.push(`TLS/HTTP2: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const quic = await readJsonNavigation(page, QUIC_ENDPOINT, "HTTP3/QUIC observer");
      result.http3 = canonicalizeHttp3(quic.value, quic.protocol);
    } catch (error) {
      result.errors.push(`HTTP3/QUIC: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    result.errors.push(`launch: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (temporaryProfile?.startsWith(path.join(os.tmpdir(), "roxy-network-fingerprint-"))) {
      fs.rmSync(temporaryProfile, { recursive: true, force: true });
    }
  }
  return result;
}

function summarize<T>(samples: ComponentSample[], key: "tls" | "http2" | "http3"): ComponentSummary<T> {
  const identities = samples.map((sample) => sample[key]).filter((value): value is NonNullable<typeof value> => value !== null);
  const hashes = [...new Set(identities.map(networkFingerprintHash))];
  return {
    complete: identities.length === samples.length,
    stable: identities.length === samples.length && hashes.length === 1,
    hashes,
    identity: (identities[0] || null) as T | null,
  };
}

async function captureBrowser(spec: BrowserSpec, samples: number): Promise<BrowserResult> {
  const version = detectVersion(spec.executablePath);
  const captures: ComponentSample[] = [];
  for (let index = 1; index <= samples; index++) {
    process.stderr.write(`[verify:network] ${spec.label} sample ${index}/${samples}\n`);
    captures.push(await captureSample(spec, index));
  }
  return {
    label: spec.label,
    executablePath: spec.executablePath,
    ...version,
    samples: captures,
    tls: summarize<TlsCorpusIdentity>(captures, "tls"),
    http2: summarize<Http2CorpusIdentity>(captures, "http2"),
    http3: summarize<Http3CorpusIdentity>(captures, "http3"),
  };
}

function compareCandidate(reference: BrowserResult, candidate: BrowserResult): {
  candidate: string;
  sameMajorVersion: boolean;
  tls: boolean;
  http2: boolean;
  http3: boolean;
  differences: string[];
} {
  const differences: string[] = [];
  const sameMajorVersion = reference.majorVersion !== null && reference.majorVersion === candidate.majorVersion;
  if (!sameMajorVersion) differences.push("browser major versions differ");
  for (const component of ["tls", "http2", "http3"] as const) {
    const referenceComponent = reference[component];
    const candidateComponent = candidate[component];
    if (!referenceComponent.complete || !referenceComponent.stable || !referenceComponent.identity) {
      differences.push(`reference ${component} corpus was incomplete or unstable`);
      continue;
    }
    if (!candidateComponent.complete || !candidateComponent.stable || !candidateComponent.identity) {
      differences.push(`candidate ${component} corpus was incomplete or unstable`);
      continue;
    }
    differences.push(...diffNetworkFingerprint(
      referenceComponent.identity,
      candidateComponent.identity,
      component,
    ));
  }
  return {
    candidate: candidate.label,
    sameMajorVersion,
    tls: Boolean(reference.tls.identity && candidate.tls.identity) &&
      JSON.stringify(reference.tls.identity) === JSON.stringify(candidate.tls.identity),
    http2: Boolean(reference.http2.identity && candidate.http2.identity) &&
      JSON.stringify(reference.http2.identity) === JSON.stringify(candidate.http2.identity),
    http3: Boolean(reference.http3.identity && candidate.http3.identity) &&
      JSON.stringify(reference.http3.identity) === JSON.stringify(candidate.http3.identity),
    differences: [...new Set(differences)].sort(),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const results: BrowserResult[] = [];
  for (const browser of options.browsers) results.push(await captureBrowser(browser, options.samples));
  const reference = results.find((result) => result.label === options.reference)!;
  const comparisons = options.candidates.map((label) =>
    compareCandidate(reference, results.find((result) => result.label === label)!));
  const failures = comparisons.flatMap((comparison) => comparison.differences
    .map((difference) => `${comparison.candidate}: ${difference}`));
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    sources: {
      tlsAndHttp2: PEET_ENDPOINT,
      normalizedTls: TLS_ENDPOINT,
      http3AndQuic: QUIC_ENDPOINT,
    },
    reference: options.reference,
    candidates: options.candidates,
    samplesPerBrowser: options.samples,
    ok: failures.length === 0,
    comparisons,
    results,
  };
  if (options.output) {
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    generatedAt: report.generatedAt,
    sources: report.sources,
    output: options.output,
    reference: report.reference,
    candidates: report.candidates,
    samplesPerBrowser: report.samplesPerBrowser,
    ok: report.ok,
    comparisons: report.comparisons,
    results: results.map((result) => ({
      label: result.label,
      version: result.version,
      tls: {
        complete: result.tls.complete,
        stable: result.tls.stable,
        hashes: result.tls.hashes,
        ja4: result.tls.identity?.ja4 || null,
      },
      http2: {
        complete: result.http2.complete,
        stable: result.http2.stable,
        hashes: result.http2.hashes,
        akamaiFingerprint: result.http2.identity?.akamaiFingerprint || null,
      },
      http3: {
        complete: result.http3.complete,
        stable: result.http3.stable,
        hashes: result.http3.hashes,
        topFingerprintId: result.http3.identity?.topFingerprintId || null,
        normalizedClientHelloId: result.http3.identity?.normalizedClientHelloId || null,
        transportFingerprintId: result.http3.identity?.transportFingerprintId || null,
      },
      errors: [...new Set(result.samples.flatMap((sample) => sample.errors))],
    })),
  }, null, 2)}\n`);
  if (failures.length) throw new Error(`network fingerprint corpus failed:\n${failures.join("\n")}`);
}

main().catch((error) => {
  process.stderr.write(`[verify:network] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
