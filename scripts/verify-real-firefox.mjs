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

async function launchFirefox(name) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `roc-fx-${name}-`));
  const port = await freePort();
  let childErr = "";
  const child = spawn(FX, ["-profile", profileDir, `--remote-debugging-port=${port}`, "--headless", "--no-remote"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => { childErr += String(d); });
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

const managed = await launchFirefox("managed");
const trueOne = await launchFirefox("true");

const identity = buildFirefoxManagedIdentity(
  { fingerprintSeed: 20240819, platform: "mac", locale: "en-US", timezone: "America/New_York" },
  "154.0",
);

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

  // ── true world: fresh process/profile, NO preload ──
  const conn2 = await trueOne.connectWithRetry();
  console.log("step4: true-world session live (no preload)");
  const trueCtx = await bidiCreateContext(conn2, 15000);
  const realWorld = await bidiEvaluateInContext(conn2, trueWorldExpr, trueCtx, 20000);
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
  console.log("\ncanvas double-draw equal: injected=" + injected.doubleDrawEqual + "  true-world=" + realWorld.doubleDrawEqual + "  (injected must be false, true-world true)");
  console.log("UA injected:", injectedExtra.ua);
  console.log("UA true   :", realWorld.ua);
  console.log("languages injected: [" + injectedExtra.languages + "]");
  console.log("\nprobe verdict:", JSON.stringify(check));

  // ── verdict logic (the launch gate's own decision) ──
  const fail = [];
  if (!check.checked || !check.confirmed) fail.push("injection probe not confirmed on real Firefox");
  if (check.ambiguous) fail.push("probe ambiguous");
  if (check.mismatches.length) fail.push("mismatches: " + check.mismatches.join(","));
  if (realWorld.webdriver !== true) fail.push("expected navigator.webdriver=true in the TRUE world under a live BiDi session (got " + realWorld.webdriver + ")");
  if (injected.webdriver !== false) fail.push("injected world webdriver must be false (got " + injected.webdriver + ")");
  if (injected.doubleDrawEqual !== false) fail.push("injected canvas double-draw must differ (noise live), got equal=" + injected.doubleDrawEqual);
  if (realWorld.doubleDrawEqual !== true) fail.push("true-world canvas double-draw must be identical, got equal=" + realWorld.doubleDrawEqual);
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