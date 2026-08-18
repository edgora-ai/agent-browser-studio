// ── Firefox managed identity — fingerprint capability parity (Slice 79) ──
//
// Chromium gets fingerprint management natively: our patched build reads the
// `--agent-browser-fingerprint-config=` switch and hosts the values at the
// renderer level. Stock Firefox has no such patch, so we deliver the same
// BrowserFingerprintConfig through the two channels Firefox actually has
// (the same ones Roxy's real RoxyFirefox uses):
//
//   1. prefs (`user.js` family) — what Firefox can express as preferences:
//      UA override, hardwareConcurrency, language, DNT, WebGL enabled;
//   2. a WebDriver BiDi preload script (`script.addPreloadScript`) — the
//      renderer-level shims Chromium's patch provides natively: platform,
//      languages, screen metrics, devicePixelRatio, canvas/WebGL/audio noise
//      seeding, timezone, geolocation, media devices, speech voices, storage
//      quota, navigator.webdriver disarm.
//
// Honest scope note: JS-level injection is provably weaker than renderer-level
// patching (a page that grabs the original function before the preload runs,
// or that inspects stack/integrity of getter descriptors, can detect it).
// It is what stock Firefox allows, and the drift baseline (Slice 41 machine)
// is exactly what keeps that honest: `captureFingerprint` reads the live page
// surface, so any shim that drifts from the baseline shows up as risk.

import type { BrowserFingerprintMeta } from "../types.js";
import type { BrowserFingerprintConfig, SecureDnsConfig } from "./browser-fingerprint-config.js";
import { buildBrowserFingerprintConfig } from "./browser-fingerprint-config.js";

/** Normalize a detected Firefox version ("135.0.1") to its major.minor. */
export function normalizeFirefoxVersion(value: string | null | undefined): string {
  const match = String(value || "").match(/(\d+)(?:\.(\d+))?/);
  if (!match) return "135.0";
  return match[2] !== undefined ? `${match[1]}.${match[2]}` : `${match[1]}.0`;
}

/**
 * Build the real-Firefox User-Agent for the configured persona platform.
 * Firefox does not claim Chrome's UA; the honest alignment is a genuine
 * Firefox UA string matching the installed engine version (so the web sees a
 * consistent browser family, unlike passing through a Chrome UA).
 */
export function buildFirefoxUserAgent(
  platform: "Win32" | "MacIntel",
  firefoxVersion: string | null | undefined,
): string {
  const version = normalizeFirefoxVersion(firefoxVersion);
  if (platform === "MacIntel") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version}) Gecko/20100101 Firefox/${version}`;
}

/**
 * The user.js preference family that carries fingerprint parity for stock
 * Firefox. These are merged into the profile's managed user.js (written right
 * before launch), so a stopped profile never leaks them and each launch gets
 * a fresh, coherent identity.
 */
export function buildFirefoxFingerprintPrefs(
  config: BrowserFingerprintConfig,
  firefoxVersion: string | null | undefined,
): Record<string, string | number | boolean> {
  const ua = buildFirefoxUserAgent(config.platform, firefoxVersion);
  const prefs: Record<string, string | number | boolean> = {
    "general.useragent.override": ua,
    "general.useragent.site_specific_overrides": false,
    "dom.maxHardwareConcurrency": config.hardwareConcurrency,
    "intl.accept_languages": config.languages.join(","),
    "webgl.disabled": false,
  };
  if (config.doNotTrack) {
    prefs["privacy.donottrackheader.enabled"] = true;
    prefs["privacy.donottrackheader.value"] = 1;
  }
  return prefs;
}

/**
 * The WebDriver BiDi preload body — Firefox's equivalent of the Chromium
 * `--fingerprint-*` renderer hooks. The same BrowserFingerprintConfig that
 * drives Chromium is embedded here, so one profile configuration produces the
 * same identity intent on both engines (drift baseline stays comparable).
 */
export function buildFirefoxFingerprintPreloadScript(config: BrowserFingerprintConfig): string {
  const json = JSON.stringify(config);
  return `(function(){
"use strict";
var cfg = ${json};
var seedFromHex = function(hex){ var n=0; for(var i=0;i<hex.length&&i<8;i++){ n=(n*16+parseInt(hex[i],16))>>>0; } return n||1; };
var mulberry32 = function(a){ return function(){ a|=0; a=(a+0x6D2B79F5)|0; var t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; };
var has = Object.prototype.hasOwnProperty;
var ok = function(){ try{ return !!document; }catch(e){ return false; } };
function def(obj, key, getter){
  try {
    var d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && !d.configurable) return;
    Object.defineProperty(obj, key, { configurable: true, get: getter });
  } catch(e){}
}
function defValue(obj, key, value){
  try {
    var d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && !d.configurable) return;
    Object.defineProperty(obj, key, { configurable: true, value: value, writable: true });
  } catch(e){}
}

// ── navigator surface ──
defValue(Navigator.prototype, "platform", cfg.platform === "MacIntel" ? "MacIntel" : "Win32");
defValue(Navigator.prototype, "language", cfg.languages[0] || "en-US");
defValue(Navigator.prototype, "languages", cfg.languages.slice());
defValue(Navigator.prototype, "maxTouchPoints", cfg.maxTouchPoints || 0);
defValue(Navigator.prototype, "hardwareConcurrency", cfg.hardwareConcurrency);
defValue(Navigator.prototype, "webdriver", false);

// ── window / screen surface ──
def(window, "devicePixelRatio", function(){ return cfg.screen.devicePixelRatio; });
def(window, "screenX", function(){ return cfg.screen.windowX; });
def(window, "screenY", function(){ return cfg.screen.windowY; });
def(window, "outerWidth", function(){ return cfg.screen.outerWidth; });
def(window, "outerHeight", function(){ return cfg.screen.outerHeight; });
def(window, "innerWidth", function(){ return cfg.screen.availWidth; });
def(window, "innerHeight", function(){ return cfg.screen.availHeight; });
def(Screen.prototype, "width", function(){ return cfg.screen.width; });
def(Screen.prototype, "height", function(){ return cfg.screen.height; });
def(Screen.prototype, "availWidth", function(){ return cfg.screen.availWidth; });
def(Screen.prototype, "availHeight", function(){ return cfg.screen.availHeight; });
def(Screen.prototype, "availLeft", function(){ return cfg.screen.availLeft; });
def(Screen.prototype, "availTop", function(){ return cfg.screen.availTop; });

// ── timezone (Intl + Date offset) ──
if (cfg.timezone) {
  (function(){
    var tz = cfg.timezone;
    var RealResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    defValue(Intl.DateTimeFormat.prototype, "resolvedOptions", function(){
      var r = RealResolved.call(this);
      return Object.assign({}, r, { timeZone: tz });
    });
    var offsetOf = function(date){
      try {
        var parts = new Intl.DateTimeFormat("ia", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(date);
        var name = "";
        for (var i = 0; i < parts.length; i++) if (parts[i].type === "timeZoneName") { name = parts[i].value; break; }
        var m = /GMT([+-])(\\d{2})(?::?(\\d{2}))?/.exec(name);
        if (!m) return null;
        var sign = m[1] === "-" ? -1 : 1;
        var mins = parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
        return -(sign * mins);
      } catch (e) { return null; }
    };
    var RealOffset = Date.prototype.getTimezoneOffset;
    defValue(Date.prototype, "getTimezoneOffset", function(){
      var v = offsetOf(this);
      return v === null ? RealOffset.call(this) : v;
    });
  })();
}

// ── canvas noise (deterministic from the profile seed) ──
if (cfg.canvas.enabled) {
  (function(){
    function makeNoiser(){
      var rng = mulberry32(seedFromHex(cfg.canvas.seed));
      var noiseAmount = 0.6;
      function jitter() { return (rng() - 0.5) * noiseAmount; }
      return {
        fillRect: function(a){ return [a[0] + jitter(), a[1] + jitter(), a[2], a[3]]; },
        strokeRect: function(a){ return [a[0] + jitter(), a[1] + jitter(), a[2], a[3]]; },
        fillText: function(a){ return [a[0], a[1] + jitter(), a[2], a[3]]; },
        strokeText: function(a){ return [a[0], a[1] + jitter(), a[2], a[3]]; },
        arc: function(a){ var r = a.length; a[r-1] = a[r-1] + (rng() - 0.5) * 0.0015; return a; },
      };
    }
    function patchProto(proto){
      if (!proto) return;
      var map = makeNoiser();
      var targets = ["fillRect", "strokeRect", "fillText", "strokeText", "arc"];
      for (var i = 0; i < targets.length; i++) {
        var name = targets[i], orig = proto[name];
        if (typeof orig !== "function") continue;
        try {
          Object.defineProperty(proto, name, { configurable: true, value: function(origFn, mapper){
            return function(){ var args = mapper(Array.prototype.slice.call(arguments)); return origFn.apply(this, args); };
          }(orig, map[name]) });
        } catch (e) {}
      }
    }
    patchProto(CanvasRenderingContext2D && CanvasRenderingContext2D.prototype);
    // OffscreenCanvas 2D contexts share the same deterministic noise so a page
    // fingerprinting via new OffscreenCanvas(...).getContext("2d") sees the
    // same managed surface the main-thread canvas does.
    patchProto(typeof OffscreenCanvasRenderingContext2D !== "undefined" ? OffscreenCanvasRenderingContext2D.prototype : null);
  })();
}

// ── WebGL vendor/renderer identity (shared by page + OffscreenCanvas) ──
function patchWebglContext(ctx){
  if (!ctx || typeof ctx.getParameter !== "function" || typeof ctx.getExtension !== "function") return;
  try {
    var vendor = cfg.webgl.vendor, renderer = cfg.webgl.renderer;
    var realParam = ctx.getParameter.bind(ctx);
    var realExt = ctx.getExtension.bind(ctx);
    var UNMASKED_VENDOR = 0x9245, UNMASKED_RENDERER = 0x9246;
    try {
      Object.defineProperty(ctx, "getParameter", {
        configurable: true,
        value: function(pname){
          if (pname === UNMASKED_VENDOR && vendor) return vendor;
          if (pname === UNMASKED_RENDERER && renderer) return renderer;
          return realParam(pname);
        },
      });
    } catch (e) {}
    try {
      Object.defineProperty(ctx, "getExtension", {
        configurable: true,
        value: function(name){
          if (/WEBGL_debug_renderer_info/i.test(String(name))) {
            return { UNMASKED_VENDOR_WEBGL: UNMASKED_VENDOR, UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER };
          }
          return realExt(name);
        },
      });
    } catch (e) {}
  } catch (e) {}
}
(function(){
  var origGetContext = HTMLCanvasElement.prototype.getContext;
  if (typeof origGetContext !== "function") return;
  HTMLCanvasElement.prototype.getContext = function(kind){
    var ctx = origGetContext.apply(this, arguments);
    patchWebglContext(ctx);
    return ctx;
  };
})();
(function(){
  var proto = typeof OffscreenCanvas !== "undefined" ? OffscreenCanvas.prototype : null;
  if (!proto || typeof proto.getContext !== "function") return;
  var origGetContext = proto.getContext;
  proto.getContext = function(kind){
    var ctx = origGetContext.apply(this, arguments);
    patchWebglContext(ctx);
    return ctx;
  };
})();

// ── WebGPU adapter identity (Firefox 137+ ships WebGPU) ──
(function(){
  var gpuInfo = cfg.webgpu;
  if (!gpuInfo || typeof navigator === "undefined" || !navigator.gpu || typeof navigator.gpu.requestAdapter !== "function") return;
  try {
    var origRequestAdapter = navigator.gpu.requestAdapter;
    navigator.gpu.requestAdapter = function(opts){
      var promise = origRequestAdapter.call(this, opts);
      if (!promise || typeof promise.then !== "function") return promise;
      return promise.then(function(adapter){
        if (adapter && typeof adapter.info === "function") {
          try {
            var origInfo = adapter.info;
            adapter.info = function(){
              return origInfo.call(this).then(function(info){
                var out = {};
                Object.assign(out, info);
                if (gpuInfo.vendor) out.vendor = gpuInfo.vendor;
                if (gpuInfo.architecture) out.architecture = gpuInfo.architecture;
                if (gpuInfo.device) out.device = gpuInfo.device;
                if (gpuInfo.description) out.description = gpuInfo.description;
                if (gpuInfo.subgroupMinSize) out.subgroupMinSize = gpuInfo.subgroupMinSize;
                if (gpuInfo.subgroupMaxSize) out.subgroupMaxSize = gpuInfo.subgroupMaxSize;
                return out;
              });
            };
          } catch (e) {}
        }
        return adapter;
      });
    };
  } catch (e) {}
})();

// ── audio noise (OfflineAudioContext render path) ──
if (cfg.audio.enabled) {
  (function(){
    var rng = mulberry32(seedFromHex(cfg.audio.seed));
    var amp = cfg.audio.amplitude > 0 ? cfg.audio.amplitude : 0.0000001;
    var proto = AudioBuffer.prototype;
    if (proto && typeof proto.copyToChannel === "function") {
      var origCopy = proto.copyToChannel;
      try {
        Object.defineProperty(proto, "copyToChannel", {
          configurable: true,
          value: function(source){
            var copy = source instanceof Float32Array ? new Float32Array(source) : source;
            if (copy && copy.length) {
              for (var i = 0; i < copy.length; i++) copy[i] = copy[i] + (rng() - 0.5) * amp;
            }
            return origCopy.call(this, copy, arguments[1], arguments[2]);
          },
        });
      } catch (e) {}
    }
  })();
}

// ── geolocation ──
(function(){
  if (!cfg.geolocation || cfg.geolocation.mode === "real") return;
  var geo = window.navigator.geolocation;
  if (!geo) return;
  var PERMISSION_DENIED = 1;
  if (cfg.geolocation.mode === "disable") {
    var denied = function(cb){ setTimeout(function(){ try { cb({ code: PERMISSION_DENIED, message: "User denied Geolocation" }); } catch (e) {} }, 0); };
    defValue(geo, "getCurrentPosition", function(okCb, errCb){ denied(errCb || okCb || function(){}); });
    defValue(geo, "watchPosition", function(okCb, errCb){ denied(errCb || okCb || function(){}); return 0; });
    return;
  }
  var coords = { latitude: cfg.geolocation.latitude, longitude: cfg.geolocation.longitude, accuracy: cfg.geolocation.accuracy || 50, altitude: null, altitudeAccuracy: null, heading: null, speed: null };
  var position = function(){ return { coords: coords, timestamp: Date.now() }; };
  defValue(geo, "getCurrentPosition", function(okCb){
    setTimeout(function(){ try { okCb(position()); } catch (e) {} }, 0);
  });
  defValue(geo, "watchPosition", function(okCb){
    setTimeout(function(){ try { okCb(position()); } catch (e) {} }, 0);
    return 1;
  });
})();

// ── media devices ──
(function(){
  if (!cfg.mediaDevices.enabled || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") return;
  var deviceIdSeed = mulberry32(seedFromHex(cfg.mediaDevices ? (cfg.canvas.seed || cfg.audio.seed) : "0"));
  function deviceId(prefix){ return prefix + Math.floor(deviceIdSeed() * 0x7fffffff).toString(36); }
  function makeDevice(kind, label, groupId){
    var d = { deviceId: deviceId(kind), kind: kind, label: label, groupId: groupId };
    try { d.toJSON = function(){ return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; }; } catch (e) {}
    return d;
  }
  var groupAudio = deviceId("group-a"), groupVideo = deviceId("group-v");
  var list = [];
  for (var a = 0; a < cfg.mediaDevices.audioInputs; a++) list.push(makeDevice("audioinput", a === 0 ? "Default - 'default'" : "Microphone (" + (a + 1) + ")", groupAudio));
  for (var v = 0; v < cfg.mediaDevices.videoInputs; v++) list.push(makeDevice("videoinput", v === 0 ? "FaceTime HD Camera (Built-in)" : "Camera (" + (v + 1) + ")", groupVideo));
  for (var o = 0; o < cfg.mediaDevices.audioOutputs; o++) list.push(makeDevice("audiooutput", o === 0 ? "Default - 'default'" : "Speaker (" + (o + 1) + ")", groupAudio));
  try {
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { configurable: true, value: function(){ return Promise.resolve(list); } });
  } catch (e) {}
})();

// ── speech synthesis voices ──
(function(){
  if (!cfg.speechSynthesis.enabled || !window.speechSynthesis || typeof speechSynthesis.getVoices !== "function") return;
  var voices = cfg.speechSynthesis.voices.map(function(v, idx){
    var s = new SpeechSynthesisVoice();
    try {
      s.name = v.name; s.lang = v.lang; s.localService = !!v.localService; s.default = idx === 0; s.voiceURI = v.name;
    } catch (e) {}
    return s;
  });
  try {
    Object.defineProperty(speechSynthesis, "getVoices", { configurable: true, value: function(){ return voices.slice(); } });
  } catch (e) {}
})();

// ── storage quota ──
(function(){
  if (!navigator.storage || typeof navigator.storage.estimate !== "function") return;
  var orig = navigator.storage.estimate;
  try {
    Object.defineProperty(navigator.storage, "estimate", {
      configurable: true,
      value: function(){
        return orig.call(navigator.storage).then(function(info){
          return { usage: info.usage || 0, quota: cfg.storageQuotaBytes || info.quota || 0 };
        });
      },
    });
  } catch (e) {}
})();
})();`;
}

/**
 * Build the whole managed Firefox identity bundle from the same profile meta
 * that drives Chromium (`buildBrowserFingerprintConfig`), plus the prefs and
 * the preload script. Returns everything a launch needs in one pass.
 */
export function buildFirefoxManagedIdentity(
  meta: BrowserFingerprintMeta,
  firefoxVersion: string | null | undefined,
  secureDns: SecureDnsConfig | null = null,
): { config: BrowserFingerprintConfig; prefs: Record<string, string | number | boolean>; preloadScript: string; userAgent: string } {
  const config = buildBrowserFingerprintConfig(meta, null, secureDns);
  return {
    config,
    prefs: buildFirefoxFingerprintPrefs(config, firefoxVersion),
    preloadScript: buildFirefoxFingerprintPreloadScript(config),
    userAgent: buildFirefoxUserAgent(config.platform, firefoxVersion),
  };
}