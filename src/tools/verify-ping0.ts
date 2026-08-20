/// <reference lib="dom" />

// Reusable ping0.cc environment-consistency verifier for the managed engine.
//
// Spawns the managed engine the exact way the app does (managed fingerprint
// injection, proxy, geo-consistent timezone/locale), loads https://ping0.cc/env,
// waits for the Vue app to actually FINISH (finished === true) — not just for
// the DOM to load — then settles for a configurable period before capturing the
// full report. This is the "don't close the page before the results are out"
// guarantee.
//
// Engines:
//  - chromium (default): the independent patched build with --fingerprint-*
//    native switches, driven over CDP (no Playwright *launch* — connectOverCDP
//    only, so no automation signals are injected).
//  - firefox: the real RoxyFirefox-aligned path — writer.js prefs + WebDriver
//    BiDi preload injection (Slice 79), driven over BiDi exactly like the app.
//
// Usage (after npm run build):
//   node dist/tools/verify-ping0.js --browser=/path/to/Chromium.app \
//     [--upstream=127.0.0.1:7890] [--proxy-type=http|socks5] [--runs=1..3]
//     [--settle-ms=15000] [--headless] [--tag=run1] [--out=docs/verification]
//   node dist/tools/verify-ping0.js --engine=firefox \
//     [--browser=/Applications/Firefox.app] [--upstream=…] [--runs=1..3] ...
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
import { buildFirefoxLaunchArgs, writeFirefoxUserJs, findFirefoxBinary, detectFirefoxVersion } from "../main/services/browser-engine.js";
import { buildFirefoxManagedIdentity } from "../main/services/firefox-fingerprint.js";
import {
  connectBidi,
  bidiAddPreloadScript,
  bidiCreateContext,
  bidiCloseContext,
  bidiGetTopContext,
  bidiEvaluateInContext,
  bidiNavigate,
  bidiActivateContext,
  type BidiConnection,
} from "../main/services/bidi-client.js";

type Engine = "chromium" | "firefox";

interface Options {
  engine: Engine;
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
  dohUrl: string | null;
  diagProbe: boolean;
  platform: "windows" | "macos" | "android";
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
  fontsDiag?: unknown;
  probeFocus: { visibility: string; hasFocus: boolean } | null;
  bodyText: string;
}

interface RunReport {
  launch: {
    engine: Engine;
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
  let engine: Engine = "chromium";
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
  let diagProbe = false;
  let platform: Options["platform"] = "windows";
  // Firefox with an HTTP proxy still resolves DNS client-side (SOCKS does
  // remote DNS); managed DoH keeps resolvers out of the host's CN pool, the
  // same isolation Chromium gets from its secure-DNS templates.
  let dohUrl: string | null = MANAGED_SECURE_DNS_TEMPLATES[0];
  for (const arg of argv) {
    if (arg.startsWith("--browser=")) browser = arg.slice("--browser=".length);
    else if (arg.startsWith("--engine=")) engine = arg.slice("--engine=".length) as Engine;
    else if (arg.startsWith("--platform=")) {
      const value = arg.slice("--platform=".length);
      if (value !== "windows" && value !== "macos" && value !== "android") {
        throw new Error("--platform must be windows, macos or android");
      }
      platform = value;
    }
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
    else if (arg.startsWith("--doh-url=")) {
      const value = arg.slice("--doh-url=".length);
      dohUrl = !value || value === "none" ? null : value;
    }
    else if (arg === "--headless") headless = true;
    else if (arg === "--diag-probe") diagProbe = true;
    else if (arg.startsWith("--")) throw new Error("unknown option: " + arg);
    else browser = arg;
  }
  if (!browser && engine === "firefox") {
    const detected = findFirefoxBinary();
    if (detected) browser = detected;
  }
  if (!browser) {
    throw new Error(
      "usage: verify-ping0 [--engine=chromium|firefox] --browser=/path/to/Chromium.app " +
        "[--upstream=host:port] [--proxy-type=http|socks5] [--runs=n] [--settle-ms=n] [--headless] [--tag=name] [--out=dir]",
    );
  }
  return {
    engine,
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
    dohUrl,
    diagProbe,
    platform,
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

// ── ping0 Vue app probes, shared between the Chromium (Playwright) and
// Firefox (BiDi) paths so both measure the exact same state machine ──

const PING0_WAIT_PROBE = `(function(){
  var el = document.querySelector('#envdetect-app');
  var data = el && el.__vue__ ? el.__vue__.$data : null;
  var rows = data ? data.rows || {} : {};
  var pending = Object.keys(rows).filter(function(k){ return rows[k] && rows[k].pending; }).slice(0, 40);
  return {
    finished: !!(data && data.finished),
    phase: data ? data.phase : null,
    score: data ? data.score : null,
    progressDone: data ? data.progressDone : null,
    progressTotal: data ? data.progressTotal : null,
    pending: pending,
    body: (document.body.innerText || '').slice(0, 400)
  };
})()`;

const PING0_CAPTURE_PROBE = `(function(){
  var el = document.querySelector('#envdetect-app');
  var data = el && el.__vue__ ? el.__vue__.$data : null;
  return {
    score: data && typeof data.score === 'number' ? data.score : null,
    level: data ? data.level : null,
    reportId: data ? data.reportId : '',
    findings: data ? (data.finalFindings || data.findings || []) : [],
    rows: data ? (data.rows || {}) : {},
    quickProbes: data ? (data.quickProbes || null) : null,
    status: data ? data.status : null,
    raf: data ? (data.raf || null) : null,
    bodyText: document.body.innerText || '',
    visibility: document.visibilityState,
    hasFocus: document.hasFocus()
  };
})()`;

const PING0_DIAG_PROBE = `(function(){
  var out = {};
  function chk(s){ try { return String(document.fonts.check(s)); } catch (e) { return "err:" + e.message; } }
  out.checkSimSun = chk("16px SimSun");
  out.checkYaHei = chk("16px 'Microsoft YaHei'");
  out.checkPingFang = chk("16px 'PingFang SC'");
  out.checkArial = chk("16px Arial");
  function measure(font){
    try {
      var c = document.createElement("canvas").getContext("2d");
      c.font = font;
      return String(c.measureText("中 text").width);
    } catch (e) { return "err:" + e.message; }
  }
  out.mSimSun = measure("16px SimSun");
  out.mFallback = measure("16px sans-serif");
  function pixels(font){
    try {
      var a = document.createElement("canvas"); var ca = a.getContext("2d");
      ca.font = font; ca.fillText("中", 10, 20);
      var b = document.createElement("canvas"); var cb = b.getContext("2d");
      cb.font = "16px sans-serif"; cb.fillText("中", 10, 20);
      var da = ca.getImageData(0,0,200,40).data, db = cb.getImageData(0,0,200,40).data;
      var diff = 0;
      for (var i = 0; i < da.length; i += 4) { diff += (da[i]===db[i]&&da[i+1]===db[i+1]&&da[i+2]===db[i+2]) ? 0 : 1; }
      return String(diff);
    } catch (e) { return "err:" + e.message; }
  }
  out.pixSimSun = pixels("16px SimSun");
  out.pixFallback = pixels("16px sans-serif");
  try { out.checkIsOurs = !!(document.fonts && document.fonts.constructor && document.fonts.constructor.prototype.__roxyFontsInstalled); } catch (e) {}
  try { out.c2dOurs = !!(CanvasRenderingContext2D.prototype.__roxyFontsInstalled); } catch (e) {}
  try { out.fontsProtoName = document.fonts && document.fonts.constructor && document.fonts.constructor.name; } catch (e) {}
  try { out.checkOnProto = typeof document.fonts.constructor.prototype.check; } catch (e) {}
  // Attempt install with error capture
  try {
    var ffs = document.fonts.constructor.prototype;
    var real = ffs.check;
    out.realCheckProto = typeof real;
    ffs.check = function(font){ return false; };
    out.tryInstall = chk("16px SimSun");
    ffs.check = real;
  } catch (e) { out.installErr = e.message; }
  // check what preload set
  try { var d = Object.getOwnPropertyDescriptor(document.fonts.constructor.prototype, "check"); out.checkDesc = d ? (d.get ? "getter" : "data:" + String(d.value).slice(0,50)) : "none"; } catch (e) { out.descErr = e.message; }
  // Which channel leaks host fonts? Probe fonts a scanner would use:
  function widthMethod(families){
    try {
      var c = document.createElement("canvas").getContext("2d");
      c.font = "72px " + families;
      out._lastFontReadback = String(c.font);
      return String(c.measureText("mmmmmmmmmmlli").width);
    } catch (e) { return "err:" + e.message; }
  }
  function offscreenMethod(families){
    try {
      var c = new OffscreenCanvas(400, 100).getContext("2d");
      c.font = "72px " + families;
      return String(c.measureText("mmmmmmmmmmlli").width);
    } catch (e) { return "err:" + e.message; }
  }
  function domMethod(families){
    try {
      var s = document.createElement("span");
      s.textContent = "mmmmmmmmmmlli";
      s.style.position = "absolute"; s.style.visibility = "hidden";
      s.style.fontFamily = families; s.style.fontSize = "72px";
      document.body.appendChild(s);
      var w = s.offsetWidth;
      s.parentNode.removeChild(s);
      return String(w);
    } catch (e) { return "err:" + e.message; }
  }
  var probes = ["'PingFang SC',sans-serif", "sans-serif", "'STKaiti',sans-serif", "Arial"];
  out.widths = {};
  out.offscreen = {};
  out.doms = {};
  for (var i = 0; i < probes.length; i++) {
    var key = probes[i].replace(/^'(.*)',.*$/, "$1");
    out.widths[key] = widthMethod(probes[i]);
    out.offscreen[key] = offscreenMethod(probes[i]);
    out.doms[key] = domMethod(probes[i]);
  }
  try {
    var c2 = document.createElement("canvas").getContext("2d");
    c2.font = "72px 'PingFang SC',sans-serif";
    var rb = c2.font;
    out.rawRb = JSON.stringify(rb);
    // manually reproduce the swap
    try {
      var c4 = document.createElement("canvas").getContext("2d");
      c4.font = "72px 'PingFang SC',sans-serif";
      out.wBefore = String(c4.measureText("mmmmmmmmmmlli").width);
      c4.font = "72px sans-serif";
      out.wAfter = String(c4.measureText("mmmmmmmmmmlli").width);
      var c5 = document.createElement("canvas").getContext("2d");
      c5.font = rb;
      out.wRb = String(c5.measureText("mmmmmmmmmmlli").width);
      c5.font = "72px 'PingFang SC'";
      out.wSingle = String(c5.measureText("mmmmmmmmmmlli").width);
      out.mtName = String(CanvasRenderingContext2D.prototype.measureText.name);
      out.mtOwn = JSON.stringify(Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, "measureText").value.toString().slice(0, 60));
      // exact replica of the preload familyAllowed
      var famTokens2 = function(spec){
        var o = [];
        if (typeof spec !== "string") return o;
        var parts = spec.split(",");
        for (var p = 0; p < parts.length; p++) {
          var tokens = parts[p].trim().split(/\\s+/);
          for (var t = tokens.length - 1; t >= 0; t--) {
            var tok = (tokens[t] || "").replace(/^["']|["']$/g, "");
            if (!tok) continue;
            if (/^-?\\d/.test(tok)) break;
            if (/^(bold|bolder|lighter|italic|oblique|normal|small-caps|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|[1-9]00)$/i.test(tok)) break;
            o.push(tok.toLowerCase());
          }
        }
        return o;
      };
      out.ftRb = JSON.stringify(famTokens2(rb));
      out.ftRaw = JSON.stringify(famTokens2("72px 'PingFang SC',sans-serif"));
      // manually run the swap to see resulting width
      var c6 = document.createElement("canvas").getContext("2d");
      c6.font = rb;
      var before = c6.font;
      var parts6 = before.split(","), o6 = [];
      for (var p = 0; p < parts6.length; p++) {
        var seg = parts6[p], toks6 = seg.trim().split(/\\s+/);
        var splitAt = toks6.length;
        for (var t = toks6.length - 1; t >= 0; t--) {
          var tok6 = (toks6[t] || "").replace(/^["']|["']$/g, "");
          if (!tok6 || /^-?\\d/.test(tok6)) break;
          splitAt = t;
        }
        if (splitAt >= toks6.length) { o6.push(seg); continue; }
        var inline6 = toks6.slice(splitAt).map(function(x){ return x.replace(/^["']|["']$/g, ""); }).join(" ");
        var allowedAny = false;
        var tt = inline6.split(/\\s+/);
        for (var k = 0; k < tt.length; k++) { var ff = tt[k].toLowerCase(); if (/^(serif|sans-serif|monospace|cursive|fantasy)$/.test(ff)) { allowedAny = true; break; } }
        if (allowedAny) { o6.push(seg); continue; }
        toks6[splitAt] = "sans-serif";
        for (var r = splitAt + 1; r < toks6.length; r++) toks6[r] = "";
        o6.push(toks6.join(" ").replace(/\\s+/g, " ").trim());
      }
      out.swapped = JSON.stringify(o6.join(", "));
    } catch (e) { out.swapErr = e.message; }
    var toks = rb.replace(/^[^,]+,/,"").trim();
    out.familyTokensResult = toks;
    function famTokens(spec){
      var o = [];
      if (typeof spec !== "string") return o;
      var parts = spec.split(",");
      for (var p = 0; p < parts.length; p++) {
        var tokens = parts[p].trim().split(/\\s+/);
        for (var t = tokens.length - 1; t >= 0; t--) {
          var tok = (tokens[t] || "").replace(/^["']|["']$/g, "");
          if (!tok) continue;
          if (/^-?\\d/.test(tok)) break;
          if (/^(bold|bolder|lighter|italic|oblique|normal|small-caps|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|[1-9]00)$/i.test(tok)) break;
          o.push(tok.toLowerCase());
        }
      }
      return o;
    }
    out.ft = JSON.stringify(famTokens(rb));
    out.ft2 = JSON.stringify(famTokens("72px 'PingFang SC',sans-serif"));
  } catch (e) { out.ftErr = e.message; }
  try {
    var iterCount = 0, iterFams = [];
    for (var fv = document.fonts.values(); !fv.next().done; ) iterCount++;
    out.iterCount = iterCount;
    out.fontsSize = String(document.fonts.size);
    out.fontsSizeReal = (function(){ var d = Object.getOwnPropertyDescriptor(document.fonts.constructor.prototype, "size"); return d && d.get ? String(d.get).slice(0, 40) : "none"; })();
    var iter2 = document.fonts.values();
    for (var i2 = 0; i2 < 12; i2++) { var s2 = iter2.next(); if (s2.done) break; try { iterFams.push(String(s2.value.family)); } catch (e) {} }
    out.iterFams = JSON.stringify(iterFams);
    var ql = (typeof window.queryLocalFonts === "function");
    out.localFontsApi = ql;
    if (ql) {
      (function(){
        var qlArr = [];
        window.queryLocalFonts().then(function(arr){ qlArr = arr || []; }).catch(function(e){ out.qlErr = e.message; }).then(function(){
          out.qlCount = qlArr.length;
          out.qlFams = JSON.stringify(qlArr.slice(0, 5).map(function(f){ return String(f.family); }));
        });
      })();
    }
  } catch (e) { out.iterErr = e.message; }
  try {
    var csd = typeof CSSStyleDeclaration !== "undefined" ? CSSStyleDeclaration.prototype : null;
    out.cssFontFamDesc = csd ? (function(){
      var d = Object.getOwnPropertyDescriptor(csd, "fontFamily");
      return JSON.stringify({ has: !!d, setIsInstalled: !!(d && d.set && d.set.__roxyFontsInstalled), setSrc: d && d.set ? String(d.set).slice(0, 40) : null });
    })() : "no-csd";
    var sp = document.createElement("span");
    var ownFf = Object.getOwnPropertyDescriptor(sp.style, "fontFamily");
    out.cssOwnFf = ownFf ? JSON.stringify({ has: true, setInstalled: !!(ownFf.set && ownFf.set.__roxyFontsInstalled) }) : JSON.stringify({ has: false });
    out.cssCtor = String(sp.style && sp.style.constructor && sp.style.constructor.name);
    out.cssProtoName = Object.getPrototypeOf(sp.style) === CSSStyleDeclaration.prototype ? "same" : Object.getPrototypeOf(sp.style) && Object.getPrototypeOf(sp.style).constructor && Object.getPrototypeOf(sp.style).constructor.name;
    sp.style.fontFamily = "'PingFang SC', sans-serif";
    out.cssReadback = JSON.stringify(sp.style.fontFamily);
    out.cssComputed = JSON.stringify(getComputedStyle(sp).fontFamily);
    var sp2 = document.createElement("span");
    if (csd) {
      var d2 = Object.getOwnPropertyDescriptor(csd, "fontFamily");
      try { d2.set.call(sp2.style, "'STKaiti', monospace"); out.cssRawSetReading = JSON.stringify(sp2.style.fontFamily); } catch (e) { out.cssRawSetErr = e.message; }
    }
    document.body.appendChild(sp);
    out.cssWidth = String(sp.offsetWidth || 0) + "/" + String(sp.clientWidth || 0);
    sp.remove();
  } catch (e) { out.cssErr = e.message; }
  try {
    var ff1 = new FontFace("PingFang SC", "local('PingFang SC')");
    var ff2 = new FontFace("Arial", "local('Arial')");
    var ffRes = { pf: "pending", arial: "pending" };
    ff1.load().then(function(){ ffRes.pf = "loaded"; }).catch(function(e){ ffRes.pf = "rejected:" + e.name; });
    ff2.load().then(function(){ ffRes.arial = "loaded"; }).catch(function(e){ ffRes.arial = "rejected:" + e.name; });
    out.fontFaceLoad = JSON.stringify(ffRes);
  } catch (e) { out.ffErr = e.message; }
  try { out.measureTextStr = String(CanvasRenderingContext2D.prototype.measureText).slice(0, 60); } catch (e) { out.mtStrErr = e.message; }
  try {
    var __names = ["Arial","Arial Black","Arial Narrow","Arial Rounded MT Bold","Helvetica","Helvetica Neue","Times","Times New Roman","Courier","Courier New","Verdana","Georgia","Tahoma","Trebuchet MS","Comic Sans MS","Impact","Lucida Console","Lucida Sans Unicode","Palatino","Palatino Linotype","Book Antiqua","Garamond","Bookman Old Style","Century Gothic","Symbol","Webdings","Wingdings","Wingdings 2","Wingdings 3","Segoe UI","Segoe UI Light","Segoe UI Semibold","Segoe UI Symbol","Segoe UI Historic","Segoe Print","Segoe Script","Calibri","Calibri Light","Cambria","Candara","Consolas","Constantia","Corbel","Ebrima","Gabriola","Gadugi","Javanese Text","Leelawadee UI","Malgun Gothic","MV Boli","Microsoft Sans Serif","Microsoft Tai Le","Microsoft Himalaya","Microsoft New Tai Lue","Microsoft PhagsPa","Microsoft Yi Baiti","MingLiU-ExtB","Mongolian Baiti","Myanmar Text","Nirmala UI","Sitka","Sitka Banner","Sitka Display","Sitka Heading","Sitka Subheading","Sitka Text","Sylfaen","Yu Gothic","Yu Gothic UI","Yu Mincho","-apple-system","BlinkMacSystemFont","Helvetica Neue","Helvetica","San Francisco","SF Pro Display","SF Pro Text","SF Mono","New York","Lucida Grande","Geneva","Monaco","Menlo","Andale Mono","Apple Chancery","Apple SD Gothic Neo","Apple Symbols","AppleGothic","AppleMyungjo","Avenir","Avenir Next","Avenir Next Condensed","Big Caslon","Brush Script MT","Chalkboard","Chalkboard SE","Chalkduster","Charter","Cochin","Copperplate","Didot","Futura","GillSans","Hiragino Kaku Gothic Pro","Hiragino Maru Gothic Pro","Hiragino Mincho ProN","Hoefler Text","Iowan Old Style","Lucida Sans","Marker Felt","Noteworthy","Optima","Papyrus","Phosphate","PingFang HK","PingFang SC","PingFang TC","Rockwell","Savoye LET","SignPainter","Skia","Snell Roundhand","Songti SC","Songti TC","Superclarendon","Times","Trattatello","Zapfino","Heiti SC","Heiti TC","DejaVu Sans","DejaVu Sans Mono","Liberation Sans","Liberation Mono","Bitstream Vera Sans","Bitstream Vera Sans Mono","Noto Sans","Noto Sans Mono","Ubuntu","Ubuntu Mono","Cantarell","FreeSans","FreeMono","FreeSerif","Droid Sans","Droid Sans Mono","Source Code Pro","Source Sans Pro","Fira Sans","Fira Mono","Fira Code","Inconsolata","Hack","JetBrains Mono","IBM Plex Sans","IBM Plex Mono","Open Sans","Lato","Roboto","Roboto Mono","Roboto Slab","PT Sans","PT Mono","PT Serif","Adobe Garamond Pro","Adobe Caslon Pro","Adobe Devanagari","Bickham Script Pro","Birch Std","Blackoak Std","Brush Script Std","Chaparral Pro","Charlemagne Std","Cooper Std","Eccentric Std","Giddyup Std","Hobo Std","Kozuka Gothic Pr6N","Kozuka Mincho Pr6N","Lithos Pro","Mesquite Std","Minion Pro","Myriad Pro","Myriad Pro Cond","Nueva Std","OCR A Std","Orator Std","Poplar Std","Prestige Elite Std","Rosewood Std","Stencil Std","Tekton Pro","Trajan Pro","Aldhabi","Aharoni","Aparajita","Bahnschrift","Bell MT","Berlin Sans FB","Bodoni MT","Book Antiqua","Broadway","Calligraphy","Castellar","Centaur","Century","Century Schoolbook","Chiller","Colonna MT","Cooper Black","David","DilleniaUPC","EucrosiaUPC","FrankRuehl","Franklin Gothic Book","Franklin Gothic Demi","Goudy Old Style","Goudy Stout","Gulim","GulimChe","Haettenschweiler","High Tower Text","Informal Roman","IrisUPC","JasmineUPC","KodchiangUPC","Kunstler Script","LilyUPC","Magneto","Maiandra GD","MingLiU","Mongolian Baiti","MoolBoran","MS Outlook","Niagara Engraved","Niagara Solid","Nyala","Onyx","Parchment","Plantagenet Cherokee","Playbill","Poor Richard","Pristina","Raavi","Ravie","Rockwell","Sakkal Majalla","Showcard Gothic","Sylfaen","Symbol","Tunga","Tw Cen MT","Vijaya","Vivaldi","Vladimir Script","SimSun","SimHei","Microsoft YaHei","Microsoft YaHei UI","Microsoft JhengHei","Microsoft JhengHei UI","KaiTi","NSimSun","DengXian","LiSu","YouYuan","STXihei","STKaiti","STSong","STZhongsong","STFangsong","STCaiyun","STHupo","STLiti","STXingkai","STXinwei","PingFang SC","PingFang TC","PingFang HK","Heiti SC","Heiti TC","Hiragino Sans GB","Lantinghei SC","Lantinghei TC","Wawati SC","Wawati TC","Weibei SC","Weibei TC","Yuanti SC","Yuanti TC","Yuppy SC","Yuppy TC","Source Han Sans CN","Source Han Sans HK","Source Han Sans TW","Noto Sans CJK SC","Noto Sans CJK TC","Noto Sans CJK HK","WenQuanYi Micro Hei","WenQuanYi Zen Hei","HarmonyOS Sans SC","HarmonyOS Sans TC","OPPO Sans","MiSans","HYQiHei","HYQiHei-50S"];
    var __base = 0;
    var __c2 = document.createElement("canvas").getContext("2d");
    __c2.font = "72px sans-serif";
    __base = __c2.measureText("mmmmmmmmmmlli").width;
    var __d = [];
    for (var ni = 0; ni < __names.length; ni++) {
      var nm2 = __names[ni];
      __c2.font = "72px '" + nm2 + "', sans-serif";
      var wdt = __c2.measureText("mmmmmmmmmmlli").width;
      if (Math.abs(wdt - __base) > 0.5) __d.push(nm2 + ":" + wdt.toFixed(1));
    }
    out.replicaCanvas = JSON.stringify(__d);
  } catch (e) { out.replicaErr = e.message; }
  try {
    var __s = document.createElement("span");
    __s.style.position = "absolute"; __s.style.visibility = "hidden"; __s.style.fontSize = "72px";
    document.body.appendChild(__s);
    var __d2 = [];
    for (var ni2 = 0; ni2 < __names.length; ni2++) {
      var nm3 = __names[ni2];
      __s.style.fontFamily = "'" + nm3 + "', sans-serif";
      var w1 = __s.offsetWidth || __s.getBoundingClientRect().width;
      __s.style.fontFamily = "sans-serif";
      var w0 = __s.offsetWidth || __s.getBoundingClientRect().width;
      if (Math.abs(w1 - w0) > 0.5) __d2.push(nm3);
    }
    __s.remove();
    out.replicaDom = JSON.stringify(__d2);
  } catch (e) { out.replicaDomErr = e.message; }
  try {
    var __d3 = [];
    for (var ni3 = 0; ni3 < __names.length; ni3++) {
      if (document.fonts.check("72px '" + __names[ni3] + "', sans-serif")) __d3.push(__names[ni3]);
    }
    out.replicaCheck = JSON.stringify(__d3);
  } catch (e) { out.replicaCheckErr = e.message; }
  try { out.workerWrapInstalled = String(window.Worker === undefined ? "no-worker" : (window.Worker.__roxyFontsInstalled === true ? "yes" : "no")); } catch (e) { out.workerWrapErr = e.message; }
  try {
    var _b = URL.createObjectURL(new Blob(["x"], { type: "text/plain" }));
    var _x = new XMLHttpRequest();
    try { _x.open("GET", _b, false); } catch (e) { out.xhrBlobOpenErr = e.message; }
    if (!out.xhrBlobOpenErr) { try { _x.send(); } catch (e) { out.xhrBlobSendErr = e.message; } }
    out.xhrBlobStatus = String(_x.status); out.xhrBlobLen = String(((_x.responseText) || "").length);
    URL.revokeObjectURL(_b);
  } catch (e) { out.blobXhrErr = e.message; }
  try {
    var c3 = document.createElement("canvas").getContext("2d");
    var realMt = c3.measureText;
    out.mtFnStr = String(realMt).slice(0, 60);
  } catch (e) { out.mtFnErr = e.message; }
  try {
    var __pl = window.navigator.plugins;
    out.plugins = String(__pl.length);
    out.pdfv = String(window.navigator.pdfViewerEnabled);
    try { out.plugin0 = String(__pl && __pl[0] ? (__pl[0].filename || __pl[0].name || "") : ""); } catch (e) { out.plugin0e = e.message; }
    try { out.pdfMime = String(window.navigator.mimeTypes && window.navigator.mimeTypes["application/pdf"] ? window.navigator.mimeTypes["application/pdf"].suffixes : ""); } catch (e) { out.mimee = e.message; }
    try { out.dtStr = String(new Date(2024, 0, 15, 12, 0, 0)).slice(0, 80); } catch (e) { out.dtsErr = e.message; }
  } catch (e) { out.pluginsErr = e.message; }
  return out;
})()`;

const PING0_DIAG_WORKER = `(function(){
  return new Promise(function(resolve){
    var out = {};
    try {
      var wkCode =
        'self.onmessage=function(e){var r={};try{r.wd=String(navigator.webdriver);r.plat=String(navigator.platform);r.oscpu=String(navigator.oscpu);r.hw=String(navigator.hardwareConcurrency);r.lang=JSON.stringify(navigator.languages);try{r.tz=Intl.DateTimeFormat().resolvedOptions().timeZone;}catch(e){r.tz="err";}r.shimFlag=String(OffscreenCanvasRenderingContext2D.prototype.__roxyFontsInstalled===true);var d=self.__roxyFontDiag;if(d){try{r.san1=JSON.stringify(d.sanitize(String.fromCharCode(39)+"PingFang SC"+String.fromCharCode(39)+",sans-serif"));r.san2=JSON.stringify(d.sanitize("72px sans-serif"));r.known=JSON.stringify(Object.keys(d.known));}catch(e){r.sanErr=e.message;}}else{r.san1="no-diag-handle";}var c=new OffscreenCanvas(400,100).getContext("2d");var q=String.fromCharCode(39);var w=function(f){c.font=f;return c.measureText("mmmmmmmmmmlli").width;};var sf=function(name){return "72px "+q+name+q+",sans-serif";};r.pf=w(sf("PingFang SC"));r.pf2=w("72px "+q+"PingFang SC"+q);r.ss=w("72px sans-serif");r.stk=w(sf("STKaiti"));r.a=w(sf("Arial"));r.own=String(OffscreenCanvasRenderingContext2D.prototype.measureText);c.font=sf("PingFang SC");r.rbPf=JSON.stringify(c.font);c.font="13px sans-serif, sans-serif";r.rbSw=JSON.stringify(c.font);}catch(e){r.err=e.message;}postMessage(r);};';
      var wkUrl = URL.createObjectURL(new Blob([wkCode], { type: "text/javascript" }));
      var wk;
      try { wk = new Worker(wkUrl); } catch (e) { out.workerNewErr = e.message; resolve(out); return; }
      var done = false;
      var timer = setTimeout(function(){ if (!done) { done = true; out.worker = "timeout"; resolve(out); } }, 4000);
      wk.onmessage = function(ev){ if (done) return; done = true; clearTimeout(timer); out.worker = JSON.stringify(ev.data); resolve(out); };
      wk.onerror = function(ev){ if (done) return; done = true; clearTimeout(timer); out.worker = "err:" + ev.message; resolve(out); };
      wk.postMessage("go");
    } catch (e) { out.workerTopErr = e.message; resolve(out); }
  });
})()`;

async function waitForBidi(port: number, timeoutMs: number): Promise<BidiConnection> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      return await connectBidi("ws://127.0.0.1:" + port + "/session", { timeoutMs: 3000 });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Firefox BiDi did not come up on port " + port + " (last error: " + lastError + ")");
}

/** The managed-identity config + prefs/preload the app itself would use. */
function buildFirefoxLaunchPlan(opts: Options, index: number, geo: GeoInfo, profileDir: string, firefoxVersion: string) {
  const seed = opts.seedBase + index;
  const locale = localeFromCountry(geo.countryCode);
  const timezone = geo.timezone;
  const identity = buildFirefoxManagedIdentity(
    {
      fingerprintSeed: seed,
      platform: opts.platform,
      locale,
      timezone,
      webrtcMode: opts.webrtcIp ? "altered" : "auto",
      webrtcIp: opts.webrtcIp,
    },
    firefoxVersion,
    null,
  );
  const proxy = opts.upstreamPort
    ? { type: opts.proxyType as "http" | "socks5", host: opts.upstreamHost, port: opts.upstreamPort }
    : null;
  writeFirefoxUserJs(profileDir, {
    proxy,
    dohUrl: opts.dohUrl,
    locale: locale || undefined,
    useGpu: true,
    sandboxPermission: true,
    colorScheme: "system",
    ...(identity ? { extraPrefs: identity.prefs } : {}),
  });
  return { seed, locale, timezone, identity };
}

async function runOnceFirefox(
  opts: Options,
  index: number,
  geo: GeoInfo,
  temporaryRoot: string,
  firefoxVersion: string,
): Promise<RunReport> {
  const profileDir = fs.mkdtempSync(path.join(temporaryRoot, "ping0-ff-profile-" + index + "-"));
  const runId = opts.tag + "-" + index;
  const plan = buildFirefoxLaunchPlan(opts, index, geo, profileDir, firefoxVersion);
  const remotePort = await getFreePort();
  const startedAt = new Date().toISOString();
  const spawnEnv = plan.timezone ? { ...process.env, TZ: plan.timezone } : undefined;
  const child: ChildProcess = spawn(
    opts.browser,
    buildFirefoxLaunchArgs({ profileDir, remotePort, headless: opts.headless, platform: opts.platform }),
    { stdio: "ignore", env: spawnEnv },
  );
  let conn: BidiConnection | null = null;
  try {
    conn = await waitForBidi(remotePort, opts.waitTimeoutMs);
    await bidiAddPreloadScript(conn, plan.identity.preloadScript, 15000);
    const context = await bidiCreateContext(conn, 15000);
    await bidiNavigate(conn, "https://ping0.cc/env", context, 60000);
    try { await bidiActivateContext(conn, context, 8000); } catch { /* tab activation is best-effort */ }
    let timedOut = false;
    try {
      const deadline = Date.now() + opts.waitTimeoutMs;
      let lastState = "";
      let stuckSince = 0;
      while (Date.now() < deadline) {
        const probe = await bidiEvaluateInContext(conn, PING0_WAIT_PROBE, context, 15000);
        if (probe && probe.finished) break;
        const state = String(probe?.phase || "") + "|" + String(probe?.score ?? "") + "|" + String(probe?.progressDone ?? "") + "/" + String(probe?.progressTotal ?? "");
        if (state !== lastState) {
          const pendingText = (probe?.pending || []).length ? " pending=" + (probe.pending as string[]).join(",") : "";
          process.stderr.write("[verify-ping0] waiting… phase=" + state + pendingText + " body=\"" + String(probe?.body || "").replace(/\s+/g, " ").slice(0, 70) + "\"\n");
          lastState = state;
          stuckSince = Date.now();
        } else if (Date.now() - stuckSince > 20000) {
          process.stderr.write("[verify-ping0] still stuck at " + state + "\n");
          stuckSince = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (Date.now() >= deadline) throw new Error("ping0 did not finish in time (phase=" + lastState + ")");
    } catch (error) {
      timedOut = true;
      process.stderr.write("[verify-ping0] warning: " + (error instanceof Error ? error.message : String(error)) + " — capturing partial state\n");
    }
    const finishedAt = new Date().toISOString();
    if (!timedOut && opts.settleMs > 0) {
      process.stderr.write("[verify-ping0] finished, settling " + opts.settleMs + "ms before capture…\n");
      await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
    }
    const settledAt = new Date().toISOString();
    const captured = await bidiEvaluateInContext(conn, PING0_CAPTURE_PROBE, context, 15000);
    let fontsDiag = null;
    if (opts.diagProbe) {
      try {
        fontsDiag = await bidiEvaluateInContext(conn, PING0_DIAG_PROBE, context, 15000);
        process.stderr.write("[verify-ping0] diag-probe returned " + JSON.stringify(fontsDiag)?.slice(0, 200) + "\n");
        try {
          const workerDiag = await bidiEvaluateInContext(conn, PING0_DIAG_WORKER, context, 15000);
          if (fontsDiag && workerDiag) Object.assign(fontsDiag, workerDiag);
          if (fontsDiag && typeof fontsDiag.plat === "string") {
            const expectedWorkerPlat = opts.platform === "macos" ? "MacIntel"
              : opts.platform === "android" ? "Linux armv81" : "Win32";
            if (fontsDiag.plat !== expectedWorkerPlat) {
              process.stderr.write(`[verify-ping0] WARNING: worker navigator.platform="${fontsDiag.plat}" != persona "${expectedWorkerPlat}"\n`);
              fontsDiag.workerPlatMismatch = expectedWorkerPlat;
            }
            if (fontsDiag.wd !== "false") {
              process.stderr.write(`[verify-ping0] WARNING: worker navigator.webdriver="${fontsDiag.wd}" should be false\n`);
              fontsDiag.workerWebdriverMismatch = "false";
            }
          }
        } catch (e) { process.stderr.write("[verify-ping0] worker-diag: " + String((e as Error)?.message || e) + "\n"); }
      } catch (e) {
        process.stderr.write("[verify-ping0] diag-probe failed: " + String((e as Error)?.message || e) + "\n");
      }
    }
    const state: Ping0State = {
      startedAt,
      finishedAt,
      settledAt,
      endedAt: new Date().toISOString(),
      score: typeof captured?.score === "number" ? captured.score : null,
      level: captured?.level ?? null,
      reportId: String(captured?.reportId || ""),
      findings: captured?.findings ?? [],
      rows: captured?.rows ?? {},
      quickProbes: captured?.quickProbes ?? null,
      status: captured?.status ?? null,
      raf: captured?.raf ?? null,
      fontsDiag,
      probeFocus: { visibility: String(captured?.visibility || ""), hasFocus: captured?.hasFocus === true },
      bodyText: String(captured?.bodyText || ""),
    };
    if (timedOut) state.status = "timeout";
    return {
      launch: {
        engine: "firefox",
        runId,
        seed: plan.seed,
        platform: opts.platform,
        proxy: { type: opts.proxyType, host: opts.upstreamHost, port: opts.upstreamPort },
        geo,
        timezone: plan.timezone,
        locale: plan.locale,
        webrtcIp: opts.webrtcIp,
        browserVersion: firefoxVersion,
        browserPath: opts.browser,
        headless: opts.headless,
      },
      state,
    };
  } finally {
    conn?.close();
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    if (profileDir.startsWith(temporaryRoot)) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(profileDir, { recursive: true, force: true }); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
      }
    }
  }
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
      platform: opts.platform,
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
        engine: "chromium",
        runId,
        seed,
        platform: opts.platform,
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

/**
 * Findings that are NOT a property of the managed identity — they are either
 * measurements of the site's own infra (ping0.cc serves its API behind a
 * Cloudflare edge, so IP-geo comparisons use the CDN edge instead of the real
 * exit) or documented engine/environment boundaries (confirmed by the two-world
 * and frame-level forensics in Slice 79). Kept here so the summary can separate
 * "identity failures" from "site-infra / boundary noise" instead of conflating
 * them into a single number.
 */
const SITE_INFRA_OR_BOUNDARY = new Set([
  // Site-CDN artifacts: the page's own IP/geo reads are Cloudflare edge IPs.
  "net.isidc",
  "net.iprisk",
  "net.isproxy",
  "net.tor_exit",
  "net.dc_asn_catalog",
  "xc.ip_tz",
  "xc.ip_lang",
  "xc.ip_fonts_cn",
  "xc.multi_geo_ip",
  // Proxy-path DNS (gateway-owned; DoH already removed the native-CN path).
  "xc.dns_ip_country",
  "xc.dns_blackhole",
  // Environment/overlay boundaries (framing at Slice 79.5/79.6).
  "stealth.raf_timing",
  "stealth.descriptor_modified",
]);

/** Split a run's findings into (identity failures) vs (site-infra/boundary). */
export function categorizeFindings(findings: Array<any>): {
  identityFails: Array<any>;
  boundaryFails: Array<any>;
} {
  const identity: Array<any> = [];
  const boundary: Array<any> = [];
  for (const f of findings) {
    if (SITE_INFRA_OR_BOUNDARY.has(f.id) || !f.fail) continue;
    identity.push(f);
  }
  for (const f of findings) {
    if (SITE_INFRA_OR_BOUNDARY.has(f.id) && f.fail) boundary.push(f);
  }
  return { identityFails: identity, boundaryFails: boundary };
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
    process.stderr.write("[verify-ping0] engine=" + opts.engine + " proxy=" + opts.proxyType + "://" + opts.upstreamHost + ":" + opts.upstreamPort + " runs=" + opts.runs + " settle=" + opts.settleMs + "ms headless=" + opts.headless + "\n");
    const geo = await detectGeo(opts);
    process.stderr.write("[verify-ping0] exit=" + geo.exitIp + " country=" + geo.countryCode + " tz=" + geo.timezone + "\n");
    if (!opts.webrtcIp) opts.webrtcIp = geo.exitIp;
    const browserVersion = opts.engine === "firefox"
      ? detectFirefoxVersion(opts.browser) || "unknown"
      : browserVersionOf(opts.browser);
    const reports: RunReport[] = [];
    for (let index = 1; index <= opts.runs; index += 1) {
      process.stderr.write("[verify-ping0] run " + index + "/" + opts.runs + " starting\n");
      const report = opts.engine === "firefox"
        ? await runOnceFirefox(opts, index, geo, temporaryRoot, browserVersion)
        : await runOnce(opts, index, geo, temporaryRoot, browserVersion);
      const file = path.join(opts.outDir, "ping0-" + report.launch.runId + ".json");
      fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
      reports.push(report);
      process.stderr.write("[verify-ping0] run " + index + " → score=" + report.state.score + " level=" + report.state.level + " findings=" + report.state.findings.length + " report=" + file + "\n");
    }
    process.stdout.write("\n| run | engine | score | identity-fails | site-infra/boundary | level |\n");
    process.stdout.write("| --- | --- | --- | --- | --- | --- |\n");
    for (const report of reports) {
      const { identityFails, boundaryFails } = categorizeFindings(report.state.findings);
      process.stdout.write(
        "| " + report.launch.runId + " | " + report.launch.engine +
        " | " + report.state.score + " | " + identityFails.length + " | " + boundaryFails.length +
        " | " + report.state.level + " |\n",
      );
      const identityIds = identityFails.length
        ? "identity: " + identityFails.map((f) => f.id).join(", ") + "\n"
        : "identity: none — managed identity fully consistent\n";
      const boundaryIds = boundaryFails.length
        ? "site-infra/boundary: " + boundaryFails.map((f) => f.id).join(", ") + "\n"
        : "";
      process.stdout.write("  " + identityIds + (boundaryIds ? "  " + boundaryIds : ""));
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
