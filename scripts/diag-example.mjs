import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { buildFirefoxLaunchArgs, writeFirefoxUserJs, findFirefoxBinary } from "../dist/main/services/browser-engine.js";
import { buildFirefoxManagedIdentity } from "../dist/main/services/firefox-fingerprint.js";
import { buildBrowserFingerprintConfig } from "../dist/main/services/browser-fingerprint-config.js";
import { connectBidi, bidiAddPreloadScript, bidiCreateContext, bidiEvaluateInContext, bidiNavigate } from "../dist/main/services/bidi-client.js";

const meta = {
  platform: "win32",
  persona: "windows",
  timezone: "Asia/Tokyo",
  locale: "ja-JP",
  screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
  timezoneId: "Asia/Tokyo",
};

const remotePort = 9223 + Math.floor(Math.random() * 200);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "roxy-diag-"));
const INJECT = process.env.DIAG_INJECT === "1";
const identity = buildFirefoxManagedIdentity(meta, "154.0");
await writeFirefoxUserJs(profileDir, {
  ...identity.prefs,
  "network.proxy.type": 1,
  "network.proxy.http": "127.0.0.1",
  "network.proxy.http_port": 7890,
  "network.proxy.ssl": "127.0.0.1",
  "network.proxy.ssl_port": 7890,
});
const env = identity.config.timezone ? { ...process.env, TZ: identity.config.timezone } : process.env;

const child = spawn(findFirefoxBinary(), buildFirefoxLaunchArgs({ profileDir, remotePort, headless: false, platform: "windows" }), { stdio: "ignore", env });
child.on("exit", (code, signal) => console.error("FF EXIT code=" + code + " signal=" + signal));
const wf = (ms) => new Promise((r) => setTimeout(r, ms));
let conn = null;
for (let i = 0; i < 60; i++) {
  try { conn = await connectBidi("ws://127.0.0.1:" + remotePort + "/session", { timeoutMs: 3000 }); break; } catch { await wf(2000); }
}
if (!conn) { console.error("bidi connect failed"); child.kill("SIGKILL"); process.exit(1); }
if (INJECT) {
  try { const added = await bidiAddPreloadScript(conn, identity.preloadScript, 15000); console.error("addPreloadScript ->", JSON.stringify(added)); } catch (e) { console.error("addPreloadScript FAILED:", e.message || e); }
}
const ctx = await bidiCreateContext(conn, 15000);
await bidiNavigate(conn, "https://example.com/", ctx, 60000);
await wf(15000);

const PROBE = `(function(){
  var out = {};
  try { out.fontsType = typeof document.fonts; } catch (e) { out.fontsType = "err:" + e.message; }
  try { out.fontsCtor = document.fonts && document.fonts.constructor && document.fonts.constructor.name; } catch (e) {}
  try {
    var ffs = document.fonts && document.fonts.constructor.prototype;
    out.checkIsOurs = !!(ffs && ffs.__roxyFontsInstalled);
    out.checkIsOursC2D = !!(CanvasRenderingContext2D.prototype && CanvasRenderingContext2D.prototype.__roxyFontsInstalled);
  } catch (e) { out.own = "err:" + e.message; }
  function chk(s){ try { return String(document.fonts.check(s)); } catch (e) { return "err:" + e.message; } }
  out.checkSimSun = chk("16px SimSun");
  out.checkSimHei = chk("16px SimHei");
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
  out.mYaHei = measure("16px 'Microsoft YaHei'");
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
  return JSON.stringify(out);
})()`;
const result = await bidiEvaluateInContext(conn, ctx, PROBE, 30000);
console.log(JSON.stringify(JSON.parse(result), null, 1));
child.kill("SIGKILL");
process.exit(0);