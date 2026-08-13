/// <reference lib="dom" />

// Horizontal anti-detection comparison: drive the real RoxyChrome engine
// (as installed by RoxyBrowser) with a real RoxyBrowser profile against the
// same ping0.cc/environment suite we use for our own managed engine, then
// capture the raw fingerprint surface side by side.
//
// The profile is COPIED to a temp dir before launch so the user's live
// RoxyBrowser profile is never mutated.
//
// Usage (after npm run build):
//   node dist/tools/compare-roxy-ping0.js \
//     --roxy="/path/to/RoxyChrome.app" \
//     --profile="/path/to/RoxyBrowser profile dir" \
//     [--upstream=127.0.0.1:7890] [--proxy-type=http|socks5]
//     [--settle-ms=15000] [--wait-ms=180000] [--tag=run1] [--out=docs/verification]
//
// Writes docs/verification/roxy-ping0-<tag>.json

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as net from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chromium, type Page } from "playwright";
import {
  AGENT_BROWSER_FINGERPRINT_SWITCH,
  MANAGED_SECURE_DNS_TEMPLATES,
  buildBrowserFingerprintArg,
} from "../main/services/browser-fingerprint-config.js";

interface Options {
  roxy: string;
  profile: string;
  ours: string;
  rawOnly: boolean;
  upstreamHost: string;
  upstreamPort: number;
  proxyType: "http" | "socks5";
  settleMs: number;
  waitMs: number;
  tag: string;
  outDir: string;
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

interface RawProbe {
  ua: string;
  appVersion: string;
  platform: string;
  vendor: string;
  language: string;
  languages: string[];
  webdriver: boolean;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  maxTouchPoints: number;
  oscpu: string | null;
  uaDataHighEntropy: unknown;
  screen: [number, number, number, number];
  dpr: number;
  colorDepth: number;
  tz: string;
  intlLocales: string;
  webglVendor: string;
  webglRenderer: string;
  webglUnmaskedVendor: string;
  webglUnmaskedRenderer: string;
  canvasHash: string;
  audioHash: string;
  fonts: string[];
  plugins: string[];
  mimeTypes: string[];
  webrtcLocalCandidates: string[];
  webrtcError: string | null;
  connection: unknown;
}

interface RunReport {
  launch: {
    runId: string;
    roxy: string;
    profile: string;
    ours: string;
    proxy: { type: string; host: string; port: number };
    cdpVersion: unknown;
    headless: boolean;
  };
  state: Ping0State | null;
  raw: RawProbe;
}

function fail(message: string): never {
  throw new Error(message);
}

function resolveExecutable(input: string): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() && resolved.endsWith(".app")) {
    const appName = path.basename(resolved, ".app");
    for (const name of [appName, "Chromium", "RoxyChrome", "Chrome"]) {
      const candidate = path.join(resolved, "Contents", "MacOS", name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  fail("RoxyChrome executable not found: " + input);
}

function parseOptions(argv: string[]): Options {
  let roxy = "";
  let profile = "";
  let ours = "";
  let rawOnly = false;
  let upstreamHost = "127.0.0.1";
  let upstreamPort = 7890;
  let proxyType: Options["proxyType"] = "http";
  let settleMs = 15000;
  let waitMs = 180000;
  let tag = "run";
  let outDir = "docs/verification";
  for (const arg of argv) {
    if (arg.startsWith("--roxy=")) roxy = arg.slice("--roxy=".length);
    else if (arg.startsWith("--profile=")) profile = arg.slice("--profile=".length);
    else if (arg.startsWith("--ours=")) ours = arg.slice("--ours=".length);
    else if (arg === "--raw-only") rawOnly = true;
    else if (arg.startsWith("--upstream=")) {
      const v = arg.slice("--upstream=".length);
      const idx = v.lastIndexOf(":");
      if (idx > 0) {
        upstreamHost = v.slice(0, idx);
        upstreamPort = Number(v.slice(idx + 1));
      } else {
        upstreamHost = v;
      }
    } else if (arg.startsWith("--proxy-type=")) {
      const v = arg.slice("--proxy-type=".length);
      if (v !== "http" && v !== "socks5") fail("proxy-type must be http or socks5");
      proxyType = v;
    } else if (arg.startsWith("--settle-ms=")) settleMs = Number(arg.slice("--settle-ms=".length));
    else if (arg.startsWith("--wait-ms=")) waitMs = Number(arg.slice("--wait-ms=".length));
    else if (arg.startsWith("--tag=")) tag = arg.slice("--tag=".length);
    else if (arg.startsWith("--out=")) outDir = arg.slice("--out=".length);
  }
  if (ours) {
    return { roxy: "", profile: "", ours, rawOnly, upstreamHost, upstreamPort, proxyType, settleMs, waitMs, tag, outDir };
  }
  if (!roxy) fail("usage: --roxy=/path/to/RoxyChrome.app --profile=/path/to/profile  |  --ours=/path/to/Chromium.app [--raw-only]");
  if (!profile || !fs.existsSync(profile)) fail("profile dir not found: " + profile);
  return { roxy, profile, ours: "", rawOnly, upstreamHost, upstreamPort, proxyType, settleMs, waitMs, tag, outDir };
}

function proxyArgs(opts: Options): string[] {
  if (opts.proxyType === "http") {
    return ["--proxy-server=http://" + opts.upstreamHost + ":" + opts.upstreamPort, "--disable-quic"];
  }
  return ["--proxy-server=socks5://" + opts.upstreamHost + ":" + opts.upstreamPort, "--enable-quic"];
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
      process.stderr.write("[compare-roxy] waiting… phase=" + probe.phase + " progress=" + probe.progressDone + "/" + probe.progressTotal + pendingText + " body=\"" + probe.body.replace(/\s+/g, " ").slice(0, 70) + "\"\n");
      lastState = state;
      stuckSince = Date.now();
    } else if (Date.now() - stuckSince > 20000) {
      process.stderr.write("[compare-roxy] still stuck at " + state + " pending=" + probe.pending.join(",") + "\n");
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

const FONT_CHECK_LIST = [
  "Arial", "Arial Black", "Arial Narrow", "Calibri", "Cambria", "Comic Sans MS",
  "Courier New", "Georgia", "Helvetica", "Impact", "Lucida Console", "Segoe UI",
  "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "SimSun", "SimHei",
  "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC",
  "SF Pro SC", "Songti SC", "Heiti SC", "STHeiti", "Apple LiGothic", "PMingLiU",
  "DFKai-SB", "WenQuanYi Micro Hei", "Droid Sans Fallback",
];

async function captureRawProbe(page: Page): Promise<RawProbe> {
  return page.evaluate(async (fontCheckList) => {
    const hash = (s: string): string => {
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      }
      return (h >>> 0).toString(16);
    };
    const canvasHash = (() => {
      try {
        const c = document.createElement("canvas");
        c.width = 200; c.height = 50;
        const ctx = c.getContext("2d");
        if (!ctx) return "";
        ctx.textBaseline = "top";
        ctx.font = "14px Arial";
        ctx.fillStyle = "#f60";
        ctx.fillRect(10, 10, 60, 10);
        ctx.fillStyle = "#069";
        ctx.fillText("antidetect-canvas-probe 1234567890", 5, 5);
        return hash(c.toDataURL());
      } catch {
        return "";
      }
    })();
    const audioHash = (() => {
      try {
        const ctx = new (window as any).AudioContext();
        const analyser = ctx.createAnalyser();
        const freq = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freq);
        return hash(Array.from(freq).join(","));
      } catch {
        return "";
      }
    })();
    const gl = (() => {
      try {
        const c = document.createElement("canvas");
        const g = (c.getContext("webgl") || c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
        if (!g) return null;
        const ext = g.getExtension("WEBGL_debug_renderer_info");
        return {
          vendor: String(g.getParameter(g.VENDOR)),
          renderer: String(g.getParameter(g.RENDERER)),
          unmaskedVendor: ext ? String(g.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : "",
          unmaskedRenderer: ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "",
        };
      } catch {
        return null;
      }
    })();
    const fonts: string[] = [];
    if (document.fonts && document.fonts.check) {
      for (const f of fontCheckList) {
        try {
          if (document.fonts.check('16px "' + f + '"')) fonts.push(f);
        } catch { /* ignore */ }
      }
    }
    const webrtcLocalCandidates: string[] = [];
    let webrtcError: string | null = null;
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("probe");
      const got = await new Promise<string[]>((resolve) => {
        const out: string[] = [];
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            const c = e.candidate;
            if (c.candidate.indexOf("typ host") !== -1) {
              const m = c.candidate.match(/candidate:\S+ \d+ \S+ \d+ (\S+)/);
              if (m) out.push(m[1]);
            }
          } else {
            resolve(out);
          }
        };
        setTimeout(() => resolve(out), 2500);
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve(out));
      });
      webrtcLocalCandidates.push(...got);
      pc.close();
    } catch (e) {
      webrtcError = String(e);
    }
    const uaDataHighEntropy = (() => {
      const ud = (navigator as any).userAgentData;
      if (!ud || !ud.getHighEntropyValues) return null;
      return ud.getHighEntropyValues([
        "architecture", "bitness", "brands", "fullVersionList", "mobile",
        "model", "platform", "platformVersion", "uaFullVersion", "wow64",
      ]).then((v: unknown) => v).catch(() => null);
    })();
    const plugins = Array.from(navigator.plugins || []).map((p) => p.name);
    const mimeTypes = Array.from(navigator.mimeTypes || []).map((m) => m.type);
    return {
      ua: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      vendor: navigator.vendor,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      webdriver: navigator.webdriver,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: (navigator as any).deviceMemory ?? null,
      maxTouchPoints: navigator.maxTouchPoints,
      oscpu: (navigator as any).oscpu ?? null,
      uaDataHighEntropy,
      screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
      dpr: window.devicePixelRatio,
      colorDepth: screen.colorDepth,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      intlLocales: Intl.DateTimeFormat().resolvedOptions().locale,
      webglVendor: gl ? gl.vendor : "",
      webglRenderer: gl ? gl.renderer : "",
      webglUnmaskedVendor: gl ? gl.unmaskedVendor : "",
      webglUnmaskedRenderer: gl ? gl.unmaskedRenderer : "",
      canvasHash,
      audioHash,
      fonts,
      plugins,
      mimeTypes,
      webrtcLocalCandidates,
      webrtcError,
      connection: (navigator as any).connection ? (navigator as any).connection.effectiveType : null,
    } as RawProbe;
  }, FONT_CHECK_LIST);
}

interface GeoInfo {
  exitIp: string | null;
  countryCode: string | null;
  timezone: string | null;
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
    countryCode: data.country_code || null,
    timezone: data.timezone?.id || null,
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

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const runId = opts.tag;
  let executablePath: string;
  let launchArgs: string[];
  let label: string;
  let launch: RunReport["launch"];

  if (opts.ours) {
    executablePath = resolveExecutable(opts.ours);
    label = "AgentBrowser engine";
    const geo = await detectGeo(opts);
    const locale = localeFromCountry(geo.countryCode);
    const fingerprintArg = buildBrowserFingerprintArg(
      {
        fingerprintSeed: 70042,
        platform: "windows",
        locale,
        timezone: geo.timezone,
        webrtcMode: "auto",
        webrtcIp: null,
      },
      "150.0.7871.114",
      AGENT_BROWSER_FINGERPRINT_SWITCH,
      { enabled: true, templates: [...MANAGED_SECURE_DNS_TEMPLATES] },
    );
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ours-compare-"));
    const cdpPort = await getFreePort();
    launchArgs = [
      "--user-data-dir=" + userDataDir,
      "--remote-debugging-port=" + cdpPort,
      ...proxyArgs(opts),
      fingerprintArg,
      "--use-mock-keychain",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
    ];
    launch = {
      runId,
      roxy: "",
      profile: "",
      ours: opts.ours,
      proxy: { type: opts.proxyType, host: opts.upstreamHost, port: opts.upstreamPort },
      cdpVersion: null,
      headless: false,
    };
  } else {
    executablePath = resolveExecutable(opts.roxy);
    label = "RoxyChrome";
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roxy-compare-"));
    const profileCopy = path.join(tempRoot, "profile");
    fs.cpSync(opts.profile, profileCopy, { recursive: true });
    const cdpPort = await getFreePort();
    launchArgs = [
      "--user-data-dir=" + profileCopy,
      "--remote-debugging-port=" + cdpPort,
      ...proxyArgs(opts),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
      "--use-mock-keychain",
      "--disable-session-crashed-bubble",
      "--noerrdialogs",
    ];
    launch = {
      runId,
      roxy: opts.roxy,
      profile: opts.profile,
      ours: "",
      proxy: { type: opts.proxyType, host: opts.upstreamHost, port: opts.upstreamPort },
      cdpVersion: null,
      headless: false,
    };
  }

  const cdpPort = Number(launchArgs.find((a) => a.startsWith("--remote-debugging-port="))?.split("=")[1]);
  const child: ChildProcess = spawn(executablePath, launchArgs, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  let browser: import("playwright").Browser | null = null;
  let page: Page | null = null;
  try {
    await waitForCdp(cdpPort, opts.waitMs);
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
    const context = browser.contexts()[0];
    page = context.pages()[0] || (await context.newPage());
    launch.cdpVersion = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json();

    const raw = await captureRawProbe(page);

    let state: Ping0State | null = null;
    if (!opts.rawOnly) {
      const startedAt = new Date().toISOString();
      await page.goto("https://ping0.cc/env", { waitUntil: "domcontentloaded", timeout: 60000 });
      try { await page.bringToFront(); } catch { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 400));
      let timedOut = false;
      try {
        await waitForPing0Finished(page, opts.waitMs);
      } catch (error) {
        timedOut = true;
        process.stderr.write("[compare-roxy] warning: " + (error instanceof Error ? error.message : String(error)) + " — capturing partial state\n");
      }
      const finishedAt = new Date().toISOString();
      try { await page.bringToFront(); } catch { /* ignore */ }
      if (!timedOut && opts.settleMs > 0) {
        process.stderr.write("[compare-roxy] finished, settling " + opts.settleMs + "ms before capture…\n");
        await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
      }
      const settledAt = new Date().toISOString();
      state = await captureState(page, settledAt);
      state.startedAt = startedAt;
      state.finishedAt = finishedAt;
      if (timedOut) state.status = "timeout";
    }

    const report: RunReport = {
      launch,
      state,
      raw,
    };
    fs.mkdirSync(opts.outDir, { recursive: true });
    const prefix = opts.ours ? "ours" : "roxy";
    const suffix = opts.rawOnly ? "raw" : "ping0";
    const outFile = path.join(opts.outDir, prefix + "-" + suffix + "-" + runId + ".json");
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

    process.stdout.write("\n=== " + label + " result (" + runId + ") ===\n");
    process.stdout.write("score=" + (state ? state.score : "n/a") + " level=" + (state ? state.level : "n/a") + " findings=" + (state ? state.findings.length : "n/a") + "\n");
    process.stdout.write("UA=" + raw.ua + "\n");
    process.stdout.write("platform=" + raw.platform + " tz=" + raw.tz + " lang=" + raw.language + " webdriver=" + raw.webdriver + "\n");
    process.stdout.write("report=" + outFile + "\n");
  } catch (error) {
    process.stderr.write("[compare-roxy] error: " + (error instanceof Error ? error.message : String(error)) + "\n");
    if (stderr) process.stderr.write("[compare-roxy] engine stderr tail: " + stderr.slice(-800) + "\n");
    process.exitCode = 1;
  } finally {
    try { browser?.close(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  process.stderr.write("[compare-roxy] fatal: " + (error instanceof Error ? error.stack : String(error)) + "\n");
  process.exit(1);
});
