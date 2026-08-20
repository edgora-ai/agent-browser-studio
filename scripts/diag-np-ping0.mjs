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
await writeFirefoxUserJs(profileDir, identity.prefs);
const env = identity.config.timezone ? { ...process.env, TZ: identity.config.timezone } : process.env;

const child = spawn(findFirefoxBinary(), buildFirefoxLaunchArgs({ profileDir, remotePort, headless: false, platform: "windows" }), { stdio: "ignore", env });

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
await bidiNavigate(conn, "https://ping0.cc/env", ctx, 30000);
await wf(3000);

const PROBE = `(function(){
  var out = {};
  function d(o, k){
    try { var x = Object.getOwnPropertyDescriptor(o, k); if (!x) return "none"; var kind = ("get" in x) ? "getter:" + String(x.get).slice(0, 22) : "data:" + (typeof x.value === "function" ? "fn:" + String(x.value).slice(0, 22) : JSON.stringify(x.value).slice(0, 30)); return kind + " cfg=" + x.configurable + " enum=" + x.enumerable + " own=" + Object.prototype.hasOwnProperty.call(o, k); } catch (e) { return "err:" + e.message; }
  }
  out.win_screenX = d(window, "screenX");
  out.win_screenY = d(window, "screenY");
  out.win_outerWidth = d(window, "outerWidth");
  out.win_innerWidth = d(window, "innerWidth");
  out.win_devicePixelRatio = d(window, "devicePixelRatio");
  out.win_outerHeight = d(window, "outerHeight");
  out.win_innerHeight = d(window, "innerHeight");
  out.screen_width = d(Screen.prototype, "width");
  out.screen_availWidth = d(Screen.prototype, "availWidth");
  out.nav_platform = d(Navigator.prototype, "platform");
  out.nav_language = d(Navigator.prototype, "language");
  out.nav_languages = d(Navigator.prototype, "languages");
  out.nav_oscpu = d(Navigator.prototype, "oscpu");
  out.nav_appVersion = d(Navigator.prototype, "appVersion");
  out.nav_webdriver = d(Navigator.prototype, "webdriver");
  out.nav_hardwareConcurrency = d(Navigator.prototype, "hardwareConcurrency");
  out.nav_maxTouchPoints = d(Navigator.prototype, "maxTouchPoints");
  out.nav_userAgent = d(Navigator.prototype, "userAgent");
  out.date_getTZOffset = d(Date.prototype, "getTimezoneOffset");
  out.ctx_measureText = d(CanvasRenderingContext2D.prototype, "measureText");
  out.canvas_getContext = d(HTMLCanvasElement.prototype, "getContext");
  out.ffs_check = d(FontFaceSet.prototype, "check");
  out.ffs_match = d(FontFaceSet.prototype, "match");
  out.intl_dtf = d(Intl, "DateTimeFormat");
  out.intl_nf = d(Intl, "NumberFormat");
  out.media_enum = d(navigator.mediaDevices && navigator.mediaDevices.constructor.prototype, "enumerateDevices");
  out.media_own = Object.prototype.hasOwnProperty.call(navigator.mediaDevices || {}, "enumerateDevices");
  out.speech_getVoices = d((typeof speechSynthesis !== "undefined" && speechSynthesis.constructor) ? speechSynthesis.constructor.prototype : {}, "getVoices");
  out.speech_own = Object.prototype.hasOwnProperty.call(typeof speechSynthesis !== "undefined" ? speechSynthesis : {}, "getVoices");
  out.storage_estimate = d(navigator.storage && navigator.storage.constructor.prototype, "estimate");
  out.storage_own = Object.prototype.hasOwnProperty.call(navigator.storage || {}, "estimate");
  out.geo_getCurrent = d(navigator.geolocation && navigator.geolocation.constructor.prototype, "getCurrentPosition");
  out.geo_own = Object.prototype.hasOwnProperty.call(navigator.geolocation || {}, "getCurrentPosition");
  out.fnproto_toString = String(Function.prototype.toString).slice(0, 60);
  out.fnproto_toString_own = String(Object.getOwnPropertyDescriptor(Function.prototype, "toString").value).slice(0, 40);
  out.fnproto_toSource = String(Function.prototype.toSource).slice(0, 60);
  return out;
})()
`;

const result = await bidiEvaluateInContext(conn, PROBE, ctx, 15000);
console.log(JSON.stringify(result, null, 1));
child.kill("SIGKILL");
process.exit(0);