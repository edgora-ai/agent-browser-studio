#!/usr/bin/env node
// Real-Firefox two-world fingerprint comparison (Slice 79 ground truth):
//   injected world (long-lived session with the managed preload) vs true world
//   (second Firefox process, same binary, fresh profile, no preload) vs the
//   managed identity the app expects.
// Firefox allows exactly ONE BiDi session per port, so the true world runs on
// its own process/profile — exactly like the app treats another profile as the
// honest ground truth.
// Runs the app's own dist modules (firefox-fingerprint, bidi-client).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

const FX = process.env.AGENT_BROWSER_FIREFOX_BINARY_PATH || "/Applications/Firefox.app/Contents/MacOS/firefox";

const repoRoot = new URL("..", import.meta.url).pathname;
const fp = await import(`${repoRoot}dist/main/services/firefox-fingerprint.js`);
const bidi = await import(`${repoRoot}dist/main/services/bidi-client.js`);
const {
  buildFirefoxManagedIdentity,
  buildInjectionProbeExpression,
  buildInjectionProbeExpectation,
  judgeInjectionProbe,
} = fp;
const {
  connectBidi,
  bidiAddPreloadScript,
  bidiCreateContext,
  bidiCloseContext,
  bidiEvaluateInContext,
} = bidi;
console.log("step0: modules imported");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

async function launchFirefox(name, { extraPrefs, tz } = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `roc-fx-${name}-`));
  if (extraPrefs) {
    const { buildFirefoxUserJs, writeFirefoxUserJs } = await import(`${repoRoot}dist/main/services/browser-engine.js`);
    writeFirefoxUserJs(profileDir, { extraPrefs, useGpu: true, sandboxPermission: true, colorScheme: "system", dohUrl: null });
  }
  const port = await freePort();
  // Bounded stderr tail (P2-7): a verbose binary must not grow memory without
  // limit while we poll for the BiDi endpoint.
  const ERR_CAP = 64 * 1024;
  let childErr = "";
  const child = spawn(FX, ["-profile", profileDir, `--remote-debugging-port=${port}`, "--headless", "--no-remote"], {
    stdio: ["ignore", "ignore", "pipe"],
    ...(tz ? { env: { ...process.env, TZ: tz } } : {}),
  });
  child.on("error", (err) => {
    console.error(`spawn failed (${name}):`, err?.message || String(err));
    process.exitCode = 1;
  });
  child.stderr.on("data", (d) => {
    childErr += String(d);
    if (childErr.length > ERR_CAP) childErr = childErr.slice(-ERR_CAP);
  });
  console.log(`step1: spawned firefox (${name}) port ${port}`);
  const connectWithRetry = async () => {
    for (let i = 0; i < 60; i++) {
      try { return await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 3000 }); } catch (e) {
        if (i < 3 || i % 5 === 4) console.log(`  ${name} attempt ${i}:`, String(e && e.message).slice(0, 120));
        await sleep(500);
      }
    }
    throw new Error(`${name}: Firefox did not announce a BiDi endpoint. stderr tail: ` + childErr.slice(-500));
  };
  return { child, profileDir, connectWithRetry };
}

const identity = buildFirefoxManagedIdentity(
  { fingerprintSeed: 20240819, platform: "mac", locale: "en-US", timezone: "America/New_York" },
  "154.0",
);

const managed = await launchFirefox("managed", {
  extraPrefs: identity.prefs,
  tz: "America/New_York",
});
const trueOne = await launchFirefox("true");

const trueWorldExpr = `(function(){
  var o = {};
  try { o.webdriver = navigator.webdriver; } catch (e) {}
  try { o.platform = navigator.platform; } catch (e) {}
  try { o.language = navigator.language; } catch (e) {}
  try { o.screenWidth = screen.width; } catch (e) {}
  try { o.hardwareConcurrency = navigator.hardwareConcurrency; } catch (e) {}
  try { o.ua = navigator.userAgent; } catch (e) {}
  try { o.vendor = navigator.vendor; } catch (e) {}
  function drawCanvas(){
    var c = document.createElement("canvas"); c.width = 64; c.height = 16;
    var x = c.getContext("2d");
    x.textBaseline = "top"; x.font = "12px Arial";
    x.fillRect(2, 2, 8, 4);
    x.fillText("Roxy two-world probe", 2, 2);
    x.strokeRect(40, 2, 10, 6);
    x.beginPath(); x.arc(48, 12, 4, 0, Math.PI * 1.5); x.stroke();
    return x.getImageData(0, 0, 64, 16).data;
  }
  try {
    var a = drawCanvas(); var b = drawCanvas();
    var same = a.length === b.length;
    if (same) { for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { same = false; break; } } }
    o.doubleDrawEqual = same;
  } catch (e) {}
  return o;
})()`;

const trueWorldDetailExpr = `(function(){
  var o = {};
  try { o.oscpu = navigator.oscpu; } catch (e) {}
  try { o.appVersion = navigator.appVersion; } catch (e) {}
  try { o.appName = navigator.appName; } catch (e) {}
  try { o.platform = navigator.platform; } catch (e) {}
  try { o.languages = (navigator.languages || []).join(','); } catch (e) {}
  try {
    var gl = document.createElement('canvas').getContext('webgl');
    o.webglVendor = gl ? gl.getParameter(gl.VENDOR) : null;
    o.webglRenderer = gl ? gl.getParameter(gl.RENDERER) : null;
    o.webglLanguage = gl ? gl.getParameter(gl.SHADING_LANGUAGE_VERSION) : null;
  } catch (e) {}
  try {
    var d = new Intl.DateTimeFormat();
    o.dtfResolved = d.resolvedOptions().locale + '|' + d.resolvedOptions().calendar + '|' + d.resolvedOptions().numberingSystem;
    o.dtfSample = d.format(new Date(2026, 7, 19, 8, 36, 20));
  } catch (e) {}
  try { o.nfSample = new Intl.NumberFormat().format(1234.5); } catch (e) {}
  try { o.localeRegion = new Intl.Locale(navigator.language).region; } catch (e) {}
  try { o.acceptLang = (document.querySelector('html').lang) || null; } catch (e) {}
  try { o.tzOffsetMin = new Date(2026, 0, 1).getTimezoneOffset(); } catch (e) {}
  return o;
})()`;

const webrtcExpr = `(function(){
  var out = { candidates: [], error: null };
  return new Promise(function (resolve) {
    try {
      var pc = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
      var done = false;
      var finish = function () { if (done) return; done = true; try { pc.close(); } catch (e) {} resolve(out); };
      var poke = function () { try { pc.createDataChannel("x"); } catch (e) {} };
      pc.onicecandidate = function (ev) {
        if (ev && ev.candidate && ev.candidate.candidate) out.candidates.push(ev.candidate.candidate);
        if (!ev || !ev.candidate) finish();
      };
      try { pc.onicecandidateerror = function () {}; } catch (e) {}
      setTimeout(function () {
        out.error = "timeout";
        finish();
      }, 8000);
      poke();
      pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).catch(function (e) { out.error = String(e); finish(); });
    } catch (e) { out.error = String(e); resolve(out); }
  });
})()`;

try {
  // ── injected world: preload registered in the managed profile's session ──
  const conn = await managed.connectWithRetry();
  console.log("step2: managed session live");
  await bidiAddPreloadScript(conn, identity.preloadScript, 15000);
  const probeCtx = await bidiCreateContext(conn, 15000);
  console.log("step3: preload registered, probe context live");
  const injected = await bidiEvaluateInContext(conn, buildInjectionProbeExpression(), probeCtx, 20000);
  await bidiCloseContext(conn, probeCtx, 8000);
  const check = judgeInjectionProbe(injected, buildInjectionProbeExpectation(identity.config));

  const injectedExtraCtx = await bidiCreateContext(conn, 15000);
  const injectedExtra = await bidiEvaluateInContext(
    conn,
    `(function(){
      var o = {};
      try { o.ua = navigator.userAgent; } catch (e) {}
      try { o.vendor = navigator.vendor; } catch (e) {}
      try { o.webdriver = navigator.webdriver; } catch (e) {}
      try { o.languages = (navigator.languages || []).join(','); } catch (e) {}
      return o;
    })()`,
    injectedExtraCtx,
  );
  await bidiCloseContext(conn, injectedExtraCtx, 8000);

  const injectedDetailCtx = await bidiCreateContext(conn, 15000);
  const injectedDetail = await bidiEvaluateInContext(conn, trueWorldDetailExpr, injectedDetailCtx, 20000);
  const injectedRtc = await bidiEvaluateInContext(conn, webrtcExpr, injectedDetailCtx, 20000);
  await bidiCloseContext(conn, injectedDetailCtx, 8000);

  // ── true world: fresh process/profile, NO preload ──
  const conn2 = await trueOne.connectWithRetry();
  console.log("step4: true-world session live (no preload)");
  const trueCtx = await bidiCreateContext(conn2, 15000);
  const realWorld = await bidiEvaluateInContext(conn2, trueWorldExpr, trueCtx, 20000);
  const realDetailCtx = await bidiCreateContext(conn2, 15000);
  const realDetail = await bidiEvaluateInContext(conn2, trueWorldDetailExpr, realDetailCtx, 20000);
  const realRtc = await bidiEvaluateInContext(conn2, webrtcExpr, realDetailCtx, 20000);
  await bidiCloseContext(conn2, realDetailCtx, 8000);
  await bidiCloseContext(conn2, trueCtx, 8000);
  conn2.close();
  conn.close();

  // ── comparison table ──
  const rows = [
    ["navigator.webdriver", String(injected.webdriver), String(realWorld.webdriver), "false"],
    ["navigator.platform", injected.platform, realWorld.platform, identity.config.platform],
    ["navigator.language", injected.language, realWorld.language, identity.config.languages[0]],
    ["screen.width", String(injected.screenWidth), String(realWorld.screenWidth), String(identity.config.screen.width)],
    ["hardwareConcurrency", String(injected.hardwareConcurrency), String(realWorld.hardwareConcurrency), String(identity.config.hardwareConcurrency)],
  ];
  console.log("\n=== REAL Firefox 154.0 (managed profile vs true-world profile) ===");
  console.log("field                       injected      true-world    managed-expect");
  for (const [field, inj, real, expect] of rows) {
    console.log(field.padEnd(28), String(inj).padEnd(14), String(real).padEnd(14), expect);
  }
  console.log("\ncanvas double-draw equal: injected=" + injected.doubleDrawEqual + "  true-world=" + realWorld.doubleDrawEqual + "  (stable noise => both equal; noiseActive=" + check.noiseActive + ")");
  console.log("UA injected:", injectedExtra.ua);
  console.log("UA true   :", realWorld.ua);
  console.log("languages injected: [" + injectedExtra.languages + "]");
  console.log("\nprobe verdict:", JSON.stringify(check));

  // ── detailed leak table (the fields ping0 flagged on the external run) ──
  const detailRows = [
    ["oscpu", injectedDetail.oscpu, realDetail.oscpu],
    ["appVersion", injectedDetail.appVersion, realDetail.appVersion],
    ["appName", injectedDetail.appName, realDetail.appName],
    ["languages", injectedDetail.languages, realDetail.languages],
    ["webglVendor", injectedDetail.webglVendor, realDetail.webglVendor],
    ["webglRenderer", injectedDetail.webglRenderer, realDetail.webglRenderer],
    ["webglLanguage", injectedDetail.webglLanguage, realDetail.webglLanguage],
    ["dtfResolved", injectedDetail.dtfResolved, realDetail.dtfResolved],
    ["dtfSample", injectedDetail.dtfSample, realDetail.dtfSample],
    ["nfSample", injectedDetail.nfSample, realDetail.nfSample],
    ["localeRegion", injectedDetail.localeRegion, realDetail.localeRegion],
    ["html lang", injectedDetail.acceptLang, realDetail.acceptLang],
    ["tzOffsetMin", String(injectedDetail.tzOffsetMin), String(realDetail.tzOffsetMin)],
    ["rtcCandidates", (injectedRtc.candidates || []).join(" ; ") || ("error=" + injectedRtc.error), (realRtc.candidates || []).join(" ; ") || ("error=" + realRtc.error)],
  ];
  console.log("\nfield           injected                               true-world");
  for (const [field, inj, real] of detailRows) {
    console.log(field.padEnd(16), String(inj).padEnd(38), String(real));
  }

  // ── verdict logic (the launch gate's own decision) ──
  const fail = [];
  if (!check.checked || !check.confirmed) fail.push("injection probe not confirmed on real Firefox");
  if (check.ambiguous) fail.push("probe ambiguous");
  if (check.mismatches.length) fail.push("mismatches: " + check.mismatches.join(","));
  if (realWorld.webdriver !== true) fail.push("expected navigator.webdriver=true in the TRUE world under a live BiDi session (got " + realWorld.webdriver + ")");
  if (injected.webdriver !== false) fail.push("injected world webdriver must be false (got " + injected.webdriver + ")");
  if (injected.doubleDrawEqual !== true) fail.push("injected canvas double-draw must be equal (stable per-draw noise), got equal=" + injected.doubleDrawEqual);
  if (realWorld.doubleDrawEqual !== true) fail.push("true-world canvas double-draw must be identical, got equal=" + realWorld.doubleDrawEqual);
  if (injectedDetail.tzOffsetMin !== 300) fail.push("managed TZ env must pin Date.getTimezoneOffset to America/New_York (+300), got " + injectedDetail.tzOffsetMin);
  const ipv4re = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  const leaked = (injectedRtc.candidates || []).filter((c) => ipv4re.test(c));
  if (leaked.length) fail.push("injected world RTC candidates leak real IPv4: " + leaked.join(" ; "));
  if (injected.platform !== identity.config.platform) fail.push("platform not pinned to managed identity");
  if (injected.screenWidth !== identity.config.screen.width) fail.push("screen.width not pinned to managed identity");

  if (fail.length) {
    console.error("\nFAIL:");
    for (const f of fail) console.error("  - " + f);
    process.exitCode = 1;
  } else {
    console.log("\nPASS: real Firefox confirms the managed injection (probe, noise, pinned fields).");
  }
} finally {
  for (const fx of [managed, trueOne]) {
    try { fx.child.kill("SIGTERM"); } catch {}
  }
  await sleep(500);
  for (const fx of [managed, trueOne]) {
    fs.rmSync(fx.profileDir, { recursive: true, force: true });
  }
}