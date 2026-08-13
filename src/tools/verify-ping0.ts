/// <reference lib="dom" />

// Reusable ping0.cc environment-consistency verifier for the managed engine.
//
// Spawns the independent Chromium build the exact way the app does (managed
// fingerprint switch, proxy, geo-consistent timezone/locale), loads
// https://ping0.cc/env, waits for the Vue app to actually FINISH
// (finished === true) — not just for the DOM to load — then settles for a
// configurable period before capturing the full report. This is the
// "don't close the page before the results are out" guarantee.
//
// Usage (after npm run build):
//   node dist/tools/verify-ping0.js --browser=/path/to/Chromium.app \
//     [--upstream=127.0.0.1:7890] [--proxy-type=http|socks5] [--runs=1..3]
//     [--settle-ms=15000] [--headless] [--tag=run1] [--out=docs/verification]
//
// Writes one JSON report per run: docs/verification/ping0-<tag>.json

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as net from "node:net";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import {
  AGENT_BROWSER_FINGERPRINT_SWITCH,
  MANAGED_SECURE_DNS_TEMPLATES,
  buildBrowserFingerprintArg,
} from "../main/services/browser-fingerprint-config.js";

interface Options {
  browser: string;
  upstreamHost: string;
  upstreamPort: number;
  proxyType: "http" | "socks5";
  runs: number;
  settleMs: number;
  waitTimeoutMs: number;
  headless: boolean;
  tag: string;
  outDir: string;
  seedBase: number;
  webrtcIp: string | null;
}

interface GeoInfo {
  exitIp: string | null;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  isp: string | null;
  org: string | null;
  asn: string | null;
  provider: string;
}

interface Ping0State {
  startedAt: string;
  finishedAt: string;
  settledAt: string;
  endedAt: string;
  score: number | null;
  level: string | null;
  reportId: string;
  findings: unknown[];
  rows: Record<string, unknown>;
  quickProbes: unknown;
  status: string;
  raf: unknown;
  probeFocus: { visibility: string; hasFocus: boolean } | null;
  bodyText: string;
}

interface RunReport {
  launch: {
    runId: string;
    seed: number;
    platform: string;
    proxy: { type: string; host: string; port: number };
    geo: GeoInfo;
    timezone: string | null;
    locale: string | null;
    webrtcIp: string | null;
    browserVersion: string;
    browserPath: string;
    headless: boolean;
  };
  state: Ping0State;
}

function resolveExecutable(input: string): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (process.platform === "darwin" && resolved.endsWith(".app")) {
    const name = path.basename(resolved, ".app");
    const candidate = path.join(resolved, "Contents", "MacOS", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("browser executable not found: " + input);
}

function parseOptions(argv: string[]): Options {
  let browser = "";
  let upstreamHost = "127.0.0.1";
  let upstreamPort = 7890;
  let proxyType: Options["proxyType"] = "http";
  let runs = 1;
  let settleMs = 15000;
  let waitTimeoutMs = 360000;
  let headless = false;
  let tag = "run";
  let outDir = "docs/verification";
  let seedBase = 70000;
  let webrtcIp: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--browser=")) browser = arg.slice("--browser=".length);
    else if (arg.startsWith("--upstream=")) {
      const spec = arg.slice("--upstream=".length);
      const separator = spec.lastIndexOf(":");
      if (separator <= 0) throw new Error("invalid --upstream=" + spec);
      upstreamHost = spec.slice(0, separator);
      upstreamPort = Number(spec.slice(separator + 1));
      if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
        throw new Error("invalid --upstream=" + spec);
      }
    } else if (arg.startsWith("--proxy-type=")) {
      const value = arg.slice("--proxy-type=".length);
      if (value !== "http" && value !== "socks5") throw new Error("--proxy-type must be http or socks5");
      proxyType = value;
    } else if (arg.startsWith("--runs=")) {
      runs = Number(arg.slice("--runs=".length));
      if (!Number.isInteger(runs) || runs < 1 || runs > 3) throw new Error("--runs must be 1..3");
    } else if (arg.startsWith("--settle-ms=")) {
      settleMs = Number(arg.slice("--settle-ms=".length));
      if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 300000) throw new Error("--settle-ms out of range");
    } else if (arg.startsWith("--wait-timeout-ms=")) {
      waitTimeoutMs = Number(arg.slice("--wait-timeout-ms=".length));
      if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 30000 || waitTimeoutMs > 600000) throw new Error("--wait-timeout-ms out of range");
    } else if (arg.startsWith("--tag=")) tag = arg.slice("--tag=".length);
    else if (arg.startsWith("--out=")) outDir = arg.slice("--out=".length);
    else if (arg.startsWith("--seed-base=")) {
      seedBase = Number(arg.slice("--seed-base=".length));
      if (!Number.isInteger(seedBase) || seedBase < 1) throw new Error("--seed-base must be a positive integer");
    } else if (arg.startsWith("--webrtc-ip=")) webrtcIp = arg.slice("--webrtc-ip=".length) || null;
    else if (arg === "--headless") headless = true;
    else if (arg.startsWith("--")) throw new Error("unknown option: " + arg);
    else browser = arg;
  }
  if (!browser) {
    throw new Error(
      "usage: verify-ping0 --browser=/path/to/Chromium.app [--upstream=host:port] [--proxy-type=http|socks5] [--runs=n] [--settle-ms=n] [--headless] [--tag=name] [--out=dir]",
    );
  }
  return {
    browser: resolveExecutable(browser),
    upstreamHost,
    upstreamPort,
    proxyType,
    runs,
    settleMs,
    waitTimeoutMs,
    headless,
    tag,
    outDir,
    seedBase,
    webrtcIp,
  };
}

function localeFromCountry(countryCode: string | null): string | null {
  if (!countryCode || !/^[A-Za-z]{2}$/.test(countryCode)) return null;
  const region = countryCode.toUpperCase();
  try {
    const language = new Intl.Locale("und-" + region).maximize().language;
    if (!language || language === "und") return null;
    return Intl.getCanonicalLocales(language + "-" + region)[0] || null;
  } catch {
    return null;
  }
}

function curlJson(proxyType: "http" | "socks5", host: string, port: number, url: string, timeoutSeconds = 8): Promise<unknown> {
  return new Promise((resolve) => {
    const proxyUrl = proxyType === "http"
      ? "http://" + host + ":" + port
      : "socks5h://" + host + ":" + port;
    const args = [
      "-s", "--connect-timeout", "5", "--max-time", String(timeoutSeconds),
      "-x", proxyUrl,
      url,
    ];
    execFile("curl", args, { timeout: (timeoutSeconds + 2) * 1000 }, (error, stdout) => {
      if (error) {
        resolve({ success: false, error: error.message });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ success: false, error: "unparseable response" });
      }
    });
  });
}

async function detectGeo(opts: Options): Promise<GeoInfo> {
  const data = (await curlJson(opts.proxyType, opts.upstreamHost, opts.upstreamPort, "https://ipwho.is/")) as any;
  if (!data || data.success === false) {
    throw new Error("Geo-IP detection through proxy failed: " + (data?.error || "no data"));
  }
  return {
    exitIp: data.ip || null,
    country: data.country || null,
    countryCode: data.country_code || null,
    region: data.region_code || null,
    city: data.city || null,
    timezone: data.timezone?.id || null,
    isp: data.connection?.isp || null,
    org: data.connection?.org || null,
    asn: data.connection?.asn ? "AS" + data.connection.asn : null,
    provider: "ipwho.is",
  };
}

function proxyArgs(opts: Options): string[] {
  if (opts.proxyType === "http") {
    return ["--proxy-server=http://" + opts.upstreamHost + ":" + opts.upstreamPort, "--disable-quic"];
  }
  return ["--proxy-server=socks5://" + opts.upstreamHost + ":" + opts.upstreamPort, "--enable-quic"];
}

async function waitForPing0Finished(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "";
  let stuckSince = 0;
  while (Date.now() < deadline) {
    const probe = await page.evaluate(() => {
      const el = document.querySelector("#envdetect-app") as any;
      const data = el && el.__vue__ ? el.__vue__.$data : null;
      const rows = data ? data.rows || {} : {};
      const pending = Object.keys(rows).filter((k) => rows[k] && rows[k].pending).slice(0, 40);
      return {
        finished: !!(data && data.finished),
        phase: data ? data.phase : null,
        score: data ? data.score : null,
        progressDone: data ? data.progressDone : null,
        progressTotal: data ? data.progressTotal : null,
        pending,
        body: (document.body.innerText || "").slice(0, 400),
      };
    }).catch(() => ({ finished: false, phase: null, score: null, progressDone: null, progressTotal: null, pending: [], body: "" }));
    if (probe.finished) return;
    const state = probe.phase + "|" + probe.score + "|" + probe.progressDone + "/" + probe.progressTotal;
    if (state !== lastState) {
      const pendingText = probe.pending.length ? " pending=" + probe.pending.join(",") : "";
      process.stderr.write("[verify-ping0] waiting… phase=" + probe.phase + " progress=" + probe.progressDone + "/" + probe.progressTotal + pendingText + " body=\"" + probe.body.replace(/\s+/g, " ").slice(0, 70) + "\"\n");
      lastState = state;
      stuckSince = Date.now();
    } else if (Date.now() - stuckSince > 20000) {
      process.stderr.write("[verify-ping0] still stuck at " + state + " pending=" + probe.pending.join(",") + "\n");
      stuckSince = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("ping0 did not finish within " + Math.round(timeoutMs / 1000) + "s (last phase=" + lastState + ")");
}

async function captureState(page: Page, settledAt: string): Promise<Ping0State> {
  const captured = await page.evaluate(() => {
    const el = document.querySelector("#envdetect-app") as any;
    const data = el && el.__vue__ ? el.__vue__.$data : null;
    return {
      score: data && typeof data.score === "number" ? data.score : null,
      level: data ? data.level : null,
      reportId: data ? data.reportId : "",
      findings: data ? (data.finalFindings || data.findings || []) : [],
      rows: data ? (data.rows || {}) : {},
      quickProbes: data ? (data.quickProbes || null) : null,
      status: data ? data.status : null,
      raf: data ? (data.raf || null) : null,
      bodyText: document.body.innerText || "",
    };
  });
  const focus = await page.evaluate(() => ({
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
  })).catch(() => null);
  const now = new Date().toISOString();
  return {
    startedAt: "",
    finishedAt: "",
    settledAt,
    endedAt: now,
    score: captured.score,
    level: captured.level,
    reportId: String(captured.reportId || ""),
    findings: captured.findings,
    rows: captured.rows,
    quickProbes: captured.quickProbes,
    status: captured.status,
    raf: captured.raf,
    probeFocus: focus,
    bodyText: captured.bodyText,
  };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = "http://127.0.0.1:" + port + "/json/version";
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("CDP did not come up on port " + port));
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

function buildLaunchArgs(
  opts: Options,
  userDataDir: string,
  cdpPort: number,
  fingerprintArg: string,
): string[] {
  return [
    "--user-data-dir=" + userDataDir,
    "--remote-debugging-port=" + cdpPort,
    ...proxyArgs(opts),
    fingerprintArg,
    "--use-mock-keychain",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    ...(opts.headless ? ["--headless=new"] : []),
  ];
}

async function runOnce(
  opts: Options,
  index: number,
  geo: GeoInfo,
  temporaryRoot: string,
  browserVersion: string,
): Promise<RunReport> {
  const seed = opts.seedBase + index;
  const locale = localeFromCountry(geo.countryCode);
  const timezone = geo.timezone;
  const userDataDir = fs.mkdtempSync(path.join(temporaryRoot, "ping0-profile-" + index + "-"));
  const runId = opts.tag + "-" + index;
  const fingerprintArg = buildBrowserFingerprintArg(
    {
      fingerprintSeed: seed,
      platform: "windows",
      locale,
      timezone,
      webrtcMode: opts.webrtcIp ? "altered" : "auto",
      webrtcIp: opts.webrtcIp,
    },
    browserVersion,
    AGENT_BROWSER_FINGERPRINT_SWITCH,
    { enabled: true, templates: [...MANAGED_SECURE_DNS_TEMPLATES] },
 );
const startedAt = new Date().toISOString();
const cdpPort = await getFreePort();
const child: ChildProcess = spawn(
  opts.browser,
  buildLaunchArgs(opts, userDataDir, cdpPort, fingerprintArg),
  { stdio: "ignore" },
);
let browser: Browser | null = null;
try {
  await waitForCdp(cdpPort, opts.waitTimeoutMs);
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());
   await page.goto("https://ping0.cc/env", { waitUntil: "domcontentloaded", timeout: 60000 });
   // Best-effort foreground the window so ping0's stealth/rAF probes measure
   // a visible, focused window — an occluded/background tab throttles rAF to
   // ~100ms and false-flags stealth.raf_timing even on a clean engine.
   try { await page.bringToFront(); } catch { /* ignore */ }
   await new Promise((resolve) => setTimeout(resolve, 400));
   let timedOut = false;
   try {
     await waitForPing0Finished(page, opts.waitTimeoutMs);
   } catch (error) {
     timedOut = true;
     process.stderr.write("[verify-ping0] warning: " + (error instanceof Error ? error.message : String(error)) + " — capturing partial state\n");
   }
   const finishedAt = new Date().toISOString();
   try { await page.bringToFront(); } catch { /* ignore */ }
   if (!timedOut && opts.settleMs > 0) {
     process.stderr.write("[verify-ping0] finished, settling " + opts.settleMs + "ms before capture…\n");
     await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
   }
   const settledAt = new Date().toISOString();
   const state = await captureState(page, settledAt);
   state.startedAt = startedAt;
   state.finishedAt = finishedAt;
   if (timedOut) state.status = "timeout";
   return {
     launch: {
       runId,
       seed,
       platform: "windows",
       proxy: { type: opts.proxyType, host: opts.upstreamHost, port: opts.upstreamPort },
       geo,
       timezone,
       locale,
       webrtcIp: opts.webrtcIp,
       browserVersion,
       browserPath: opts.browser,
       headless: opts.headless,
     },
     state,
   };
} finally {
    await browser?.close().catch(() => undefined);
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
   if (userDataDir.startsWith(temporaryRoot)) {
      // Give the killed Chromium a beat to release the profile dir (macOS
      // can still hold files briefly after SIGKILL); retry instead of failing.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
      }
   }
 }
}

function browserVersionOf(browserPath: string): string {
  try {
    const out = execFileSync(browserPath, ["--version"], { encoding: "utf8" });
    const match = String(out).match(/\d+\.\d+\.\d+\.\d+/);
    return match ? match[0] : "150.0.7871.114";
  } catch {
    return "150.0.7871.114";
  }
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ping0-"));
  try {
    fs.mkdirSync(opts.outDir, { recursive: true });
    process.stderr.write("[verify-ping0] proxy=" + opts.proxyType + "://" + opts.upstreamHost + ":" + opts.upstreamPort + " runs=" + opts.runs + " settle=" + opts.settleMs + "ms headless=" + opts.headless + "\n");
    const geo = await detectGeo(opts);
    process.stderr.write("[verify-ping0] exit=" + geo.exitIp + " country=" + geo.countryCode + " tz=" + geo.timezone + "\n");
    if (!opts.webrtcIp) opts.webrtcIp = geo.exitIp;
    const browserVersion = browserVersionOf(opts.browser);
    const reports: RunReport[] = [];
    for (let index = 1; index <= opts.runs; index += 1) {
      process.stderr.write("[verify-ping0] run " + index + "/" + opts.runs + " starting\n");
      const report = await runOnce(opts, index, geo, temporaryRoot, browserVersion);
      const file = path.join(opts.outDir, "ping0-" + report.launch.runId + ".json");
      fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
      reports.push(report);
      process.stderr.write("[verify-ping0] run " + index + " → score=" + report.state.score + " level=" + report.state.level + " findings=" + report.state.findings.length + " report=" + file + "\n");
    }
    process.stdout.write("\n| run | score | level | findings |\n");
    process.stdout.write("| --- | --- | --- | --- |\n");
    for (const report of reports) {
      process.stdout.write("| " + report.launch.runId + " | " + report.state.score + " | " + report.state.level + " | " + report.state.findings.length + " |\n");
    }
    if (reports.some((r) => r.state.status === "timeout")) {
      process.stderr.write("[verify-ping0] one or more runs timed out (partial capture)\n");
      process.exitCode = 2;
    }
  } finally {
    if (temporaryRoot.startsWith(os.tmpdir())) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write("[verify-ping0] error: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
