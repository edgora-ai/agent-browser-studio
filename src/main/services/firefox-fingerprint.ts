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
  platform: "Win32" | "MacIntel" | "Linux armv81",
  firefoxVersion: string | null | undefined,
): string {
  const version = normalizeFirefoxVersion(firefoxVersion);
  if (platform === "MacIntel") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`;
  }
  if (platform === "Linux armv81") {
    return `Mozilla/5.0 (Android 14; Mobile; rv:${version}) Gecko/${version} Firefox/${version}`;
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
  // WebRTC: the real leak on this engine. Even through an HTTP proxy, WebRTC
  // UDP goes direct, so the STUN server-reflexive candidate exposes the host's
  // true public IP (verified on <https://ping0.cc> — `rtc.public_ip` reads the
  // host public IP while the page's geo IP is the proxy exit). JS preloads
  // cannot touch ICE candidates, so this is a prefs channel: obfuscate host
  // addresses as mDNS AND never gather server-reflexive candidates
  // (`ice.proxy_only` — no STUN placement at all, with or without a proxy, so
  // the real IP cannot appear in any candidate). TURN/relay stays functional
  // when an app configures it. (Verified against the Firefox 154 binary
  // inventory: `media.peerconnection.stun.client.enabled` does not exist.)
  prefs["media.peerconnection.ice.obfuscate_host_addresses"] = true;
  prefs["media.peerconnection.ice.proxy_only"] = true;
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
  // Worker-identity block for the shim (G1): computed HERE (TS side) because
  // the page realm executing the preload has no `config` binding — the
  // generated worker script receives the persona fields as plain JSON.
  const wcfgJson = JSON.stringify({
    platform: config.platform,
    oscpu: config.platform === "MacIntel" ? "Intel Mac OS X 10.15" : config.platform === "Linux armv81" ? "Linux armv8l" : "Windows NT 10.0; Win64; x64",
    appVersion: config.platform === "MacIntel" ? "5.0 (Macintosh)" : config.platform === "Linux armv81" ? "5.0 (Android)" : "5.0 (Windows)",
    maxTouchPoints: config.maxTouchPoints || 0,
    hardwareConcurrency: config.hardwareConcurrency,
    languages: (config.languages || ["en-US"]).slice(0, 3),
    timezone: config.timezone,
    canvasSeed: config.canvas && config.canvas.enabled ? config.canvas.seed : null,
  });
  return `(function(){
"use strict";
var cfg = ${json};
var seedFromHex = function(hex){ var n=0; for(var i=0;i<hex.length&&i<8;i++){ n=(n*16+parseInt(hex[i],16))>>>0; } return n||1; };
var mulberry32 = function(a){ return function(){ a|=0; a=(a+0x6D2B79F5)|0; var t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; };
var has = Object.prototype.hasOwnProperty;
var ok = function(){ try{ return !!document; }catch(e){ return false; } };
var maskLen = function(fn){ try { if (Object.defineProperty && fn.length !== 0) Object.defineProperty(fn, "length", { value: 0, configurable: true }); } catch (e) {} return fn; };
// Registry of functions we install: their toString()/toSource() must present
// the native signature a real engine exposes, else a scanner that reads
// getOwnPropertyDescriptor(...).get.toString() (or the FF-only toSource)
// sees a hand-written body and flags stealth.descriptor_modified.
var fakeFns = typeof WeakSet !== "undefined" ? new WeakSet() : null;
var NATIVE_BODY = "function () { [native code] }";
if (fakeFns && Function.prototype.toString) {
  var realToString = Function.prototype.toString;
  var toStringFn = function(){
    if (fakeFns.has(this)) return NATIVE_BODY;
    return realToString.call(this);
  };
  // The replacement itself must present the native signature when a scanner
  // stringifies Function.prototype.toString (common descriptor audit) — register
  // it in the same registry so its own toString() round-trips as native.
  fakeFns.add(maskLen(toStringFn));
  Function.prototype.toString = toStringFn;
}
if (fakeFns && Function.prototype.toSource) {
  var realToSource = Function.prototype.toSource;
  var toSourceFn = function(){
    if (fakeFns.has(this)) return NATIVE_BODY;
    return realToSource.call(this);
  };
  fakeFns.add(maskLen(toSourceFn));
  Function.prototype.toSource = toSourceFn;
}
function def(obj, key, getter){
  try {
    var d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && !d.configurable) return;
    if (fakeFns) fakeFns.add(maskLen(getter));
    Object.defineProperty(obj, key, { configurable: true, get: getter });
  } catch(e){}
}
function defValue(obj, key, value){
  try {
    var d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && !d.configurable) return;
    if (fakeFns && typeof value === "function") { var wrapped = value; fakeFns.add(maskLen(wrapped)); Object.defineProperty(obj, key, { configurable: true, value: wrapped, writable: true }); return; }
    Object.defineProperty(obj, key, { configurable: true, value: value, writable: true });
  } catch(e){}
}

// ── navigator surface ──
// Native Firefox exposes these as accessors on Navigator.prototype; a data
// property where the engine has a getter is itself a descriptor giveaway.
// Accessor form + registered getter keeps the descriptor shape native-like
// with the getter presenting the native signature.
def(Navigator.prototype, "platform", function(){ return cfg.platform; });
def(Navigator.prototype, "language", function(){ return cfg.languages[0] || "en-US"; });
def(Navigator.prototype, "languages", function(){ return cfg.languages.slice(); });
def(Navigator.prototype, "maxTouchPoints", function(){ return cfg.maxTouchPoints || 0; });
def(Navigator.prototype, "hardwareConcurrency", function(){ return cfg.hardwareConcurrency; });
// Native Firefox exposes webdriver as an accessor, not a data property; a
// data-property override changes the descriptor shape itself (own+getter).
def(Navigator.prototype, "webdriver", function(){ return false; });
// oscpu/appVersion must agree with the mapped platform, else a scanner pairing
// the rewritten UA ("Windows NT 10.0; Win64; x64") with the leaky host
// (real Firefox reports "Intel Mac OS X 10.15" / "5.0 (Macintosh)" here) flags
// an internal contradiction. Android presents "Linux armv8l" / "5.0 (Android)".
def(Navigator.prototype, "oscpu", function(){ return cfg.platform === "MacIntel" ? "Intel Mac OS X 10.15" : cfg.platform === "Linux armv81" ? "Linux armv8l" : "Windows NT 10.0; Win64; x64"; });
def(Navigator.prototype, "appVersion", function(){ return cfg.platform === "MacIntel" ? "5.0 (Macintosh)" : cfg.platform === "Linux armv81" ? "5.0 (Android)" : "5.0 (Windows)"; });
// navigator.plugins materialises the ENGINE's plugin table, which differs per
// OS (Windows pdfium.dll / macOS libpdf.dylib; Android exposes an empty
// surface). Rebuilding the array on each read keeps it fresh and lets a
// scanner's named-item lookups ("Internal PDF Plugin") behave like native.
(function(){
  if (!cfg.pluginProfile) return;
  function iter(arr){
    if (typeof Symbol === "undefined" || !Symbol.iterator) return null;
    arr[Symbol.iterator] = function(){
      var i = 0, self = this;
      return { next: function(){ return i < self.length ? { value: self[i++], done: false } : { value: undefined, done: true }; } };
    };
  }
  function makeMime(m){
    var obj = { type: m.type, suffixes: m.suffixes, description: "", enabledPlugin: null };
    return obj;
  }
  function makeMimeArray(mimes){
    var arr = [];
    for (var i = 0; i < mimes.length; i++) arr[i] = makeMime(mimes[i]);
    arr.item = function(i){ return arr[i] || null; };
    arr.namedItem = function(n){ for (var i = 0; i < arr.length; i++) if (arr[i].type === n) return arr[i]; return null; };
    arr.refresh = function(){ return false; };
    iter(arr);
    return arr;
  }
  function makePlugin(p){
    var mimes = makeMimeArray(p.mimeTypes);
    var obj = { name: p.name, filename: p.filename, description: p.description, length: mimes.length };
    Object.defineProperty(obj, "mimeTypes", { configurable: true, value: mimes });
    obj.item = function(i){ return mimes[i] || null; };
    obj.namedItem = function(n){ for (var i = 0; i < mimes.length; i++) if (mimes[i].type === n) return mimes[i]; return null; };
    iter(obj);
    return obj;
  }
  function makePluginArray(plugins){
    // Array-of-plugins shape: indexable like native PluginArray (length/item/
    // namedItem/refresh + iteration) while staying a plain object so its
    // prototype chain is Object/null exactly as the engine's PluginArray.
    var arr = [];
    for (var i = 0; i < plugins.length; i++) arr[i] = makePlugin(plugins[i]);
    arr.item = function(i){ return arr[i] || null; };
    arr.namedItem = function(n){ for (var i = 0; i < arr.length; i++) if (arr[i].name === n) return arr[i]; return null; };
    arr.refresh = function(){ return false; };
    iter(arr);
    return arr;
  }
  def(Navigator.prototype, "plugins", function(){ return makePluginArray(cfg.pluginProfile.plugins); });
  def(Navigator.prototype, "mimeTypes", function(){ return makeMimeArray(cfg.pluginProfile.mimeTypes); });
  def(Navigator.prototype, "pdfViewerEnabled", function(){ return cfg.pluginProfile.pdfViewerEnabled === true; });
})();

// ── window / screen surface ──
// Native Firefox defines these on Window.prototype / Screen.prototype, NOT as
// own properties of the window object; an own-property override trips a
// scanner running Object.hasOwn(window, ...) against the descriptor map.
def(Window.prototype, "devicePixelRatio", function(){ return cfg.screen.devicePixelRatio; });
def(Window.prototype, "screenX", function(){ return cfg.screen.windowX; });
def(Window.prototype, "screenY", function(){ return cfg.screen.windowY; });
def(Window.prototype, "outerWidth", function(){ return cfg.screen.outerWidth; });
def(Window.prototype, "outerHeight", function(){ return cfg.screen.outerHeight; });
def(Window.prototype, "innerWidth", function(){ return cfg.screen.availWidth; });
def(Window.prototype, "innerHeight", function(){ return cfg.screen.availHeight; });
// Mobile personas also expose the touch-event surface real mobile Firefox has:
// the handler slots exist (null) and TouchEvent is constructible. Desktop
// Firefox lacks these, so a fingerprint scanner reading "ontouchstart in window"
// sees an internally consistent mobile identity only for Android personas.
if (cfg.screen.mobile === true) {
  defValue(Window.prototype, "ontouchstart", null);
  defValue(Window.prototype, "ontouchmove", null);
  defValue(Window.prototype, "ontouchend", null);
  defValue(Window.prototype, "ontouchcancel", null);
  defValue(Window.prototype, "onorientationchange", null);
}
// screen.orientation: a mobile persona running on a desktop host would report
// the host orientation (desktop Firefox says landscape-primary/0) while its
// screen geometry claims a phone. Enforce the persona's own orientation state;
// desktop personas keep the host state (a desktop monitor is landscape).
(function(){
  try {
    var so = typeof screen !== "undefined" ? screen.orientation : null;
    var sop = so ? Object.getPrototypeOf(so) : null;
    if (so) {
      def(so, "type", function(){ return cfg.screen.mobile === true ? "portrait-primary" : "landscape-primary"; });
      def(so, "angle", function(){ return 0; });
    }
    if (sop) {
      def(sop, "type", function(){ return cfg.screen.mobile === true ? "portrait-primary" : "landscape-primary"; });
      def(sop, "angle", function(){ return 0; });
    }
  } catch (e) {}
})();
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
    // Date.prototype.toString() renders the HOST timezone's region name in
    // parentheses (e.g. "GMT+0800 (中国标准时间)") — a scanner comparing the
    // rewritten tz against that spoken name instantly sees the contradiction.
    // Rewrite the parenthesized region with the persona zone's own long name
    // (en-US "China Standard Time"), resolved per date so DST names stay
    // correct. toString is a real method on Date.prototype, so defValue (data
    // property) preserves the shape.
    var RealDateToString = Date.prototype.toString;
    defValue(Date.prototype, "toString", function(){
      var s, region;
      try { s = RealDateToString.call(this); } catch (e) { return ""; }
      try {
        var parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(this);
        for (var i = 0; i < parts.length; i++) if (parts[i].type === "timeZoneName") { region = parts[i].value; break; }
      } catch (e) {}
      if (!region) return s;
      var m = /^(.*GMT[+-]\\d{4}(?::\\d{2})?) \\(([^)]*)\\)$/.exec(s);
      return m ? m[1] + " (" + region + ")" : s;
    });
  })();
}

// ── canvas noise (deterministic from the profile seed) ──
if (cfg.canvas.enabled) {
  (function(){
    function makeNoiser(){
      // One deterministic stream PER CONTEXT: each 2D context carries its own
      // op counter (WeakMap), so replaying the same drawing sequence — a
      // scanner's x5 canvas check, a fingerprint site re-rendering on the same
      // or a fresh canvas — yields byte-identical pixels (the stable overlay
      // Chromium's session noise provides), while different pages/contexts get
      // independent streams.
      var counters = typeof WeakMap !== "undefined" ? new WeakMap() : null;
      var noiseAmount = 0.6;
      function next(ctx){ var n = counters ? (counters.get(ctx) || 0) : 0; if (counters) counters.set(ctx, n + 1); return mulberry32((seedFromHex(cfg.canvas.seed) + n) >>> 0)(); }
      function jitter(ctx){ return (next(ctx) - 0.5) * noiseAmount; }
      return {
        fillRect: function(a, ctx){ return [a[0] + jitter(ctx), a[1] + jitter(ctx), a[2], a[3]]; },
        strokeRect: function(a, ctx){ return [a[0] + jitter(ctx), a[1] + jitter(ctx), a[2], a[3]]; },
        fillText: function(a, ctx){ return [a[0], a[1] + jitter(ctx), a[2], a[3]]; },
        strokeText: function(a, ctx){ return [a[0], a[1] + jitter(ctx), a[2], a[3]]; },
        arc: function(a, ctx){ var r = a.length; a[r-1] = a[r-1] + (next(ctx) - 0.5) * 0.003; return a; },
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
          var patchFn = function(origFn, mapper){
            return function(){ var args = mapper(Array.prototype.slice.call(arguments), this); return origFn.apply(this, args); };
          }(orig, map[name]);
          if (fakeFns) fakeFns.add(maskLen(patchFn));
          Object.defineProperty(proto, name, { configurable: true, value: patchFn });
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

// ── Intl default locale ──
// Real Firefox resolves default formatter locale from the O.S. locale, not
// navigator.language (zh-Hans-CN on this host). A scanner that formats a date
// or number sees the host locale even when navigator.language is managed —
// pin the default to the managed language by injecting options when the page
// leaves them unspecified.
(function(){
  var want = cfg.languages[0] || "en-US";
  var ctorNames = ["DateTimeFormat", "NumberFormat", "Collator", "PluralRules", "RelativeTimeFormat", "DisplayNames", "ListFormat", "Segmenter"];
  for (var ci = 0; ci < ctorNames.length; ci++) {
    let ctorName = ctorNames[ci];
    let RealCtor = Intl[ctorName];
    if (typeof RealCtor !== "function") continue;
    try {
      let Wrapped = function(locales, arg){
        // Firefox resolves an unspecified formatter locale from the O.S.
        // locale, NOT navigator.language (real leak: zh-Hans-CN on this host
        // even when the identity says ja-JP). Inject the managed language as
        // the first positional argument — an explicit page locale is honored.
        if (locales === undefined || locales === null) return new RealCtor(want, arg);
        return new RealCtor(locales, arg);
      };
      Wrapped.prototype = RealCtor.prototype;
      if (typeof Object.setPrototypeOf === "function") Object.setPrototypeOf(Wrapped, RealCtor);
      if (fakeFns) fakeFns.add(maskLen(Wrapped));
      Object.defineProperty(Intl, ctorName, { configurable: true, value: Wrapped });
    } catch (e) {}
  }
})();

// ── WebGL vendor/renderer identity (shared by page + OffscreenCanvas) ──
function patchWebglContext(ctx){
  if (!ctx || typeof ctx.getParameter !== "function" || typeof ctx.getExtension !== "function") return;
  try {
    var vendor = cfg.webgl.vendor, renderer = cfg.webgl.renderer;
    var realParam = ctx.getParameter.bind(ctx);
    var realExt = ctx.getExtension.bind(ctx);
    var UNMASKED_VENDOR = 0x9245, UNMASKED_RENDERER = 0x9246;
    try {
      var paramFn = function(pname){
        if (pname === UNMASKED_VENDOR && vendor) return vendor;
        if (pname === UNMASKED_RENDERER && renderer) return renderer;
        return realParam(pname);
      };
      if (fakeFns) fakeFns.add(maskLen(paramFn));
      Object.defineProperty(ctx, "getParameter", {
        configurable: true,
        value: paramFn,
      });
    } catch (e) {}
    try {
      var extFn = function(name){
        if (/WEBGL_debug_renderer_info/i.test(String(name))) {
          return { UNMASKED_VENDOR_WEBGL: UNMASKED_VENDOR, UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER };
        }
        return realExt(name);
      };
      if (fakeFns) fakeFns.add(maskLen(extFn));
      Object.defineProperty(ctx, "getExtension", {
        configurable: true,
        value: extFn,
      });
    } catch (e) {}
  } catch (e) {}
}
(function(){
  var origGetContext = HTMLCanvasElement.prototype.getContext;
  if (typeof origGetContext !== "function") return;
  var ctxFn = function(kind){
    var ctx = origGetContext.apply(this, arguments);
    patchWebglContext(ctx);
    return ctx;
  };
  if (fakeFns) fakeFns.add(maskLen(ctxFn));
  HTMLCanvasElement.prototype.getContext = ctxFn;
})();
(function(){
  var proto = typeof OffscreenCanvas !== "undefined" ? OffscreenCanvas.prototype : null;
  if (!proto || typeof proto.getContext !== "function") return;
  var origGetContext = proto.getContext;
  var ctxFn = function(kind){
    var ctx = origGetContext.apply(this, arguments);
    patchWebglContext(ctx);
    return ctx;
  };
  if (fakeFns) fakeFns.add(maskLen(ctxFn));
  proto.getContext = ctxFn;
})();

// ── WebGPU adapter identity (Firefox 137+ ships WebGPU) ──
// requestAdapter is a GPU.prototype method; patching it on the navigator.gpu
// instance leaks an own property the engine does not have.
(function(){
  var gpuInfo = cfg.webgpu;
  if (!gpuInfo || typeof navigator === "undefined" || !navigator.gpu || typeof navigator.gpu.requestAdapter !== "function") return;
  var gpuProto = null;
  try { gpuProto = navigator.gpu.constructor.prototype; } catch (e) {}
  if (!gpuProto || typeof gpuProto.requestAdapter !== "function") return;
  try {
    var origRequestAdapter = gpuProto.requestAdapter;
    var requestAdapterFn = function(opts){
      var promise = origRequestAdapter.call(this, opts);
      if (!promise || typeof promise.then !== "function") return promise;
      return promise.then(function(adapter){
        if (adapter && typeof adapter.info === "function") {
          try {
            var origInfo = adapter.info;
            var infoFn = function(){
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
            if (fakeFns) fakeFns.add(maskLen(infoFn));
            adapter.info = infoFn;
          } catch (e) {}
        }
        return adapter;
      });
    };
    if (fakeFns) fakeFns.add(maskLen(requestAdapterFn));
    Object.defineProperty(gpuProto, "requestAdapter", { configurable: true, value: requestAdapterFn });
  } catch (e) {}
})();

// ── audio noise (OfflineAudioContext render path) ──
if (cfg.audio.enabled) {
  (function(){
    var rng = mulberry32(seedFromHex(cfg.audio.seed));
    var amp = cfg.audio.amplitude > 0 ? cfg.audio.amplitude : 0.0000001;
    var proto = typeof AudioBuffer !== "undefined" ? AudioBuffer.prototype : null;
    if (proto && typeof proto.copyToChannel === "function") {
      var origCopy = proto.copyToChannel;
      try {
        var copyFn = function(source){
          var copy = source instanceof Float32Array ? new Float32Array(source) : source;
          if (copy && copy.length) {
            for (var i = 0; i < copy.length; i++) copy[i] = copy[i] + (rng() - 0.5) * amp;
          }
          return origCopy.call(this, copy, arguments[1], arguments[2]);
        };
        if (fakeFns) fakeFns.add(maskLen(copyFn));
        Object.defineProperty(proto, "copyToChannel", {
          configurable: true,
          value: copyFn,
        });
      } catch (e) {}
    }
  })();
}

// ── geolocation ──
// Methods live on Geolocation.prototype natively; patching the instance leaks
// an own-property where the engine has none (descriptor fingerprint).
(function(){
  if (!cfg.geolocation || cfg.geolocation.mode === "real") return;
  var geoProto = null;
  try { geoProto = window.navigator.geolocation && window.navigator.geolocation.constructor.prototype; } catch (e) {}
  if (!geoProto) return;
  var PERMISSION_DENIED = 1;
  if (cfg.geolocation.mode === "disable") {
    var denied = function(cb){ setTimeout(function(){ try { cb({ code: PERMISSION_DENIED, message: "User denied Geolocation" }); } catch (e) {} }, 0); };
    defValue(geoProto, "getCurrentPosition", function(okCb, errCb){ denied(errCb || okCb || function(){}); });
    defValue(geoProto, "watchPosition", function(okCb, errCb){ denied(errCb || okCb || function(){}); return 0; });
    return;
  }
  var coords = { latitude: cfg.geolocation.latitude, longitude: cfg.geolocation.longitude, accuracy: cfg.geolocation.accuracy || 50, altitude: null, altitudeAccuracy: null, heading: null, speed: null };
  var position = function(){ return { coords: coords, timestamp: Date.now() }; };
  defValue(geoProto, "getCurrentPosition", function(okCb){
    setTimeout(function(){ try { okCb(position()); } catch (e) {} }, 0);
  });
  defValue(geoProto, "watchPosition", function(okCb){
    setTimeout(function(){ try { okCb(position()); } catch (e) {} }, 0);
    return 1;
  });
})();

// ── media devices ──
// enumerateDevices is a MediaDevices.prototype method; an own-property on the
// navigator.mediaDevices instance is a descriptor giveaway.
(function(){
  if (!cfg.mediaDevices.enabled || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") return;
  var devicesProto = null;
  try { devicesProto = navigator.mediaDevices.constructor.prototype; } catch (e) {}
  if (!devicesProto) return;
  var deviceIdSeed = mulberry32(seedFromHex(cfg.mediaDevices ? (cfg.canvas.seed || cfg.audio.seed) : "0"));
  function deviceId(prefix){ return prefix + Math.floor(deviceIdSeed() * 0x7fffffff).toString(36); }
  function makeDevice(kind, label, groupId){
    var d = { deviceId: deviceId(kind), kind: kind, label: label, groupId: groupId };
    try { d.toJSON = function(){ return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; }; } catch (e) {}
    return d;
  }
  var groupAudio = deviceId("group-a"), groupVideo = deviceId("group-v");
  var list = [];
  var mobile = cfg.screen.mobile === true;
  var micLabel = mobile ? "Microphone" : "Default - 'default'";
  var camLabel = mobile ? "Rear Camera" : "FaceTime HD Camera (Built-in)";
  for (var a = 0; a < cfg.mediaDevices.audioInputs; a++) list.push(makeDevice("audioinput", a === 0 ? micLabel : "Microphone (" + (a + 1) + ")", groupAudio));
  for (var v = 0; v < cfg.mediaDevices.videoInputs; v++) list.push(makeDevice("videoinput", v === 0 ? camLabel : "Camera (" + (v + 1) + ")", groupVideo));
  for (var o = 0; o < cfg.mediaDevices.audioOutputs; o++) list.push(makeDevice("audiooutput", o === 0 ? "Default - 'default'" : "Speaker (" + (o + 1) + ")", groupAudio));
  try {
    var enumerateFn = function(){ return Promise.resolve(list); };
    if (fakeFns) fakeFns.add(maskLen(enumerateFn));
    Object.defineProperty(devicesProto, "enumerateDevices", { configurable: true, value: enumerateFn });
  } catch (e) {}
})();

// ── speech synthesis voices ──
// getVoices is a SpeechSynthesis.prototype method; an own-property on the
// window.speechSynthesis instance trips the same descriptor scan.
(function(){
  if (!cfg.speechSynthesis.enabled || !window.speechSynthesis || typeof speechSynthesis.getVoices !== "function") return;
  var speechProto = null;
  try { speechProto = window.speechSynthesis.constructor.prototype; } catch (e) {}
  if (!speechProto) return;
  var voices = [];
  try {
    voices = cfg.speechSynthesis.voices.map(function(v, idx){
      var s = new SpeechSynthesisVoice();
      try {
        s.name = v.name; s.lang = v.lang; s.localService = !!v.localService; s.default = idx === 0; s.voiceURI = v.name;
      } catch (e) {}
      return s;
    });
  } catch (e) { voices = []; }
  try {
    var getVoicesFn = function(){ return voices.slice(); };
    if (fakeFns) fakeFns.add(maskLen(getVoicesFn));
    Object.defineProperty(speechProto, "getVoices", { configurable: true, value: getVoicesFn });
  } catch (e) {}
})();

// ── font availability (persona list parity with the Chromium native patch) ──
// The patched Chromium renderer restricts document.fonts + canvas text to the
// configured persona font list, so a scanner sees "not installed" for every
// out-of-persona family even though macOS ships CJK system fonts. A bare
// Firefox page leaks PingFang SC / Songti etc. (real host fonts), which a
// service crosschecking has_cn_fonts against a non-CN IP location flags.
// Worse: Firefox's document.fonts.check() answers true for ANY family (the
// engine falls back to an available font), so a scanner's font probes read
// "installed" for every probe on this engine. Mirror the native-patch
// behaviour from the preload: only persona + generic families are reported
// as available.
(function(){
  var allowed = {};
  var fonts = cfg.fonts || [];
  for (var fi = 0; fi < fonts.length; fi++) {
    var fam = String(fonts[fi]).trim().toLowerCase();
    if (fam) allowed[fam] = true;
  }
  var GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|fangsong|emoji|inherit|initial|unset|revert)$/;
  var STYLE = /^(bold|bolder|lighter|italic|oblique|normal|small-caps|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|[1-9]00)$/;
  // Collect the concrete family tokens of a font spec. Style keywords are
  // *skipped* (not a break): "Bold"/"2"/"Condensed" are often the trailing word
  // of a family name ("Arial Rounded MT Bold", "Wingdings 2", "Avenir Next
  // Condensed") — a break there drops the family and lets the whole probe sail
  // through as generic-only. Only the numeric size prefix ends the scan.
  function familyTokens(spec){
    var out = [];
    if (typeof spec !== "string") return out;
    var parts = spec.split(",");
    for (var p = 0; p < parts.length; p++) {
      var tokens = parts[p].trim().split(/\\s+/);
      for (var t = tokens.length - 1; t >= 0; t--) {
        var tok = (tokens[t] || "").replace(/^["']|["']$/g, "");
        if (!tok) continue;
        if (/^-?\\d/.test(tok)) break;
        if (STYLE.test(tok)) continue;
        out.push(tok.toLowerCase());
      }
    }
    return out;
  }
  function familyAllowed(spec){
    if (typeof spec !== "string") return false;
    var parts = spec.split(",");
    var hasConcrete = false;
    for (var p = 0; p < parts.length; p++) {
      var segTxt = parts[p].trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (!segTxt) continue;
      if (GENERIC.test(segTxt)) continue;
      // Whole-name match first: multi-word persona names ("Times New Roman")
      // must be honored before their tokens are checked individually.
      if (allowed[segTxt]) { hasConcrete = true; continue; }
      var fams = familyTokens(parts[p]);
      for (var i = 0; i < fams.length; i++) {
        if (GENERIC.test(fams[i])) continue;
        hasConcrete = true;
        if (!allowed[fams[i]]) return false;
      }
    }
    return hasConcrete;
  }
  // Rewrite a font spec so every non-persona family becomes the generic
  // sans-serif fallback. Used by canvas text measurement, CSS font-family and
  // the font shorthand setter.
  function sanitizeFontSpec(spec){
    if (typeof spec !== "string" || !spec) return spec;
    if (familyAllowed(spec)) return spec;
    var parts = spec.split(","), out = [];
    for (var p = 0; p < parts.length; p++) {
      var seg = parts[p], tokens = seg.trim().split(/\\s+/);
      var splitAt = tokens.length;
      // Reverse scan with the same style-word *skip* as familyTokens: a style
      // word ("Bold"/"2"/"Condensed") is often the trailing token of a family
      // name ("Arial Rounded MT Bold", "Wingdings 2", "Avenir Next Condensed");
      // breaking there makes the segment look unsplittable and it survives the
      // sanitize as-is — the exact residual leak the canvas replica showed.
      for (var t = tokens.length - 1; t >= 0; t--) {
        var tok = (tokens[t] || "").replace(/^["']|["']$/g, "");
        if (!tok || /^-?\\d/.test(tok)) break;
        if (/^(bold|bolder|lighter|italic|oblique|normal|small-caps|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|[1-9]00)$/i.test(tok)) continue;
        splitAt = t;
      }
      // A segment with no split point is kept only when the whole segment
      // passes the persona check: "72px 'Arial Rounded MT Bold'" must not
      // survive because "arial" alone is allowed, nor "bold" as a style word.
      if (splitAt >= tokens.length) {
        if (familyAllowed(seg)) { out.push(seg); continue; }
        // Keep the leading size token so an unsplittable segment keeps the
        // original metric ("72px 'Wingdings 2'" → "72px sans-serif"): a bare
        // "sans-serif" silently degrades to the 13px default and its width
        // still differs from the site's 72px baseline probe.
        var szTok = tokens[0] || "";
        if (/^(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|inherit|initial|unset|revert)$/i.test(szTok) || /^-?(?:[0-9]+(?:\.[0-9]+)?)(?:px|pt|em|rem|%|cm|mm|in|pc|ex|ch|vw|vh)?$/.test(szTok)) {
          out.push(szTok + " sans-serif");
        } else {
          out.push("sans-serif");
        }
        continue;
      }
      // A segment is kept only when the whole segment passes the persona check:
      // "72px 'Arial Rounded MT Bold'" must not survive because "arial" alone
      // is allowed, nor because "bold" read as a style keyword.
      if (familyAllowed(seg)) { out.push(seg); continue; }
      tokens[splitAt] = "sans-serif";
      for (var r = splitAt + 1; r < tokens.length; r++) tokens[r] = "";
      out.push(tokens.join(" ").replace(/\\s+/g, " ").trim());
    }
    return out.join(", ");
  }
  // Canvas ctx.font (and the CSS font shorthand) is a *shorthand*: it requires
  // a size token. A bare family list ("sans-serif, sans-serif") is silently
  // dropped by the engine, leaving the previous font in effect and undoing the
  // sanitize — the exact reason an unsized font probe still sees PingFang SC.
  // Prefix a neutral size when the sanitized spec has none.
  function ensureFontSize(spec){
    if (typeof spec === "string" && spec && !/^\\s*-?[0-9]/.test(spec)) return "13px " + spec;
    return spec;
  }
  function installOnce(){
    if (typeof document === "undefined") return false;
    var FFS = typeof FontFaceSet !== "undefined" ? FontFaceSet : (document.fonts && document.fonts.constructor) || null;
    if (!FFS || !FFS.prototype || typeof FFS.prototype.check !== "function") return false;
    if (FFS.prototype.__roxyFontsInstalled) return true;
    var realCheck = FFS.prototype.check;
    var checkFn = function(font){
      if (!familyAllowed(font)) return false;
      return realCheck.call(this, font);
    };
    if (fakeFns) fakeFns.add(maskLen(checkFn));
    try {
      Object.defineProperty(FFS.prototype, "check", { configurable: true, value: checkFn });
      Object.defineProperty(FFS.prototype, "__roxyFontsInstalled", { configurable: true, value: true, writable: true });
    } catch (e) { return false; }
    if (typeof FFS.prototype.match === "function") {
      var realMatch = FFS.prototype.match;
      var matchFn = function(font){
        if (!familyAllowed(font)) return [];
        return realMatch.call(this, font);
      };
      if (fakeFns) fakeFns.add(maskLen(matchFn));
      try { Object.defineProperty(FFS.prototype, "match", { configurable: true, value: matchFn }); } catch (e) {}
    }
    // Firefox materialises the OS font inventory into FontFaceSet iteration
    // (document.fonts.values() / for...of), while the patched Chromium only
    // exposes the persona list. Filter iterated FontFace entries to the
    // persona pool so list-based probes see the same set.
    function faceAllowed(face){
      try {
        var fam = String(face && face.family || "").replace(/^["']|["']$/g, "").toLowerCase();
        if (!fam) return false;
        if (GENERIC.test(fam)) return true;
        return !!allowed[fam];
      } catch (e) { return false; }
    }
    function filteredIterable(orig){
      return function(){
        var iter = orig.call(this);
        return {
          next: function(){
            for (;;) {
              var step = iter.next();
              if (step.done) return step;
              if (faceAllowed(step.value)) return step;
            }
          },
          [Symbol.iterator](){ return this; }
        };
      };
    }
    var iterMethods = [["values", FFS.prototype.values], ["keys", FFS.prototype.keys], ["entries", FFS.prototype.entries]];
    for (var im = 0; im < iterMethods.length; im++) {
      if (typeof iterMethods[im][1] !== "function") continue;
      try {
        var filtIter = filteredIterable(iterMethods[im][1]);
        var iterFn = im === 2 ? function(){
          var iter = iterMethods[im][1].call(this), out = [];
          var step;
          while (!(step = iter.next()).done) if (faceAllowed(step.value[1])) out.push(step.value);
          var idx = 0;
          return { next: function(){ return idx < out.length ? { value: out[idx++], done: false } : { value: undefined, done: true }; }, [Symbol.iterator](){ return this; } };
        } : filtIter;
        if (fakeFns) fakeFns.add(maskLen(iterFn));
        Object.defineProperty(FFS.prototype, iterMethods[im][0], { configurable: true, value: iterFn });
      } catch (e) {}
    }
    if (FFS.prototype[Symbol.iterator] && FFS.prototype[Symbol.iterator] !== FFS.prototype.values) {
      try {
        var syFn = filteredIterable(FFS.prototype[Symbol.iterator]);
        if (fakeFns) fakeFns.add(maskLen(syFn));
        Object.defineProperty(FFS.prototype, Symbol.iterator, { configurable: true, value: syFn });
      } catch (e) {}
    }
    if (typeof FFS.prototype.forEach === "function") {
      try {
        var realForEach = FFS.prototype.forEach;
        var forEachFn = function(cb, thisArg){
          var self = this;
          var it = realForEach.call(self, function(face){
            if (faceAllowed(face) && typeof cb === "function") cb.call(thisArg || self, face, face, self);
          }, thisArg);
          return it;
        };
        if (fakeFns) fakeFns.add(maskLen(forEachFn));
        Object.defineProperty(FFS.prototype, "forEach", { configurable: true, value: forEachFn });
      } catch (e) {}
    }
    if (typeof FFS.prototype.load === "function") {
      try {
        var realLoad = FFS.prototype.load;
        var loadFn = function(font){
          if (!familyAllowed(font)) return Promise.resolve([]);
          var args = arguments;
          var self = this;
          return realLoad.apply(self, args).then(function(faces){
            var out = [];
            for (var i = 0; i < faces.length; i++) if (faceAllowed(faces[i])) out.push(faces[i]);
            return out;
          });
        };
        if (fakeFns) fakeFns.add(maskLen(loadFn));
        Object.defineProperty(FFS.prototype, "load", { configurable: true, value: loadFn });
      } catch (e) {}
    }
    // FontFace.load() bypasses the FontFaceSet surface: a scanner constructs
    // new FontFace("PingFang SC", "local('PingFang SC')") and awaits load() to
    // learn whether an out-of-persona family is installed. Reject the promise
    // exactly as a machine that does not have the font would.
    if (typeof FontFace !== "undefined" && FontFace.prototype && typeof FontFace.prototype.load === "function") {
      try {
        var realFaceLoad = FontFace.prototype.load;
        var faceLoadFn = function(){
          try {
            var fam = String(this.family || "").replace(/^["']|["']$/g, "");
            if (fam && !familyAllowed(fam)) return Promise.reject(new DOMException("The operation failed for an operating system or existing font", "NotSupportedError"));
          } catch (e) {}
          return realFaceLoad.apply(this, arguments);
        };
        if (fakeFns) fakeFns.add(maskLen(faceLoadFn));
        Object.defineProperty(FontFace.prototype, "load", { configurable: true, value: faceLoadFn });
      } catch (e) {}
    }
    // Firefox exposes the installed system font count as document.fonts.size
    // while the patched engine reports only what the page actually declared.
    // Report the persona pool size instead of the OS inventory.
    try {
      var sizeDesc = Object.getOwnPropertyDescriptor(FFS.prototype, "size");
      if (sizeDesc && sizeDesc.get && !sizeDesc.get.__roxyFontsInstalled) {
        var realSizeGet = sizeDesc.get;
        var sizeFn = function(){
          try {
            var realSize = realSizeGet.call(this);
            if (realSize > 0) {
              var personaFaces = 0;
              var it = FFS.prototype.values.call(this);
              for (;;) { var st = it.next(); if (st.done) break; personaFaces++; }
              return personaFaces;
            }
            return realSize;
          } catch (e) { return 0; }
        };
        try { sizeFn.__roxyFontsInstalled = true; } catch (e) {}
        Object.defineProperty(FFS.prototype, "size", { configurable: true, get: sizeFn });
      }
    } catch (e) {}
    return true;
  }
  // Preload runs before the document is fully constructed; document.fonts and
  // FontFaceSet may not exist yet. Retry on DOM readiness signals.
  function installRetry(attempt){
    if (installOnce()) return;
    if (attempt <= 0) return;
    setTimeout(function(){ installRetry(attempt - 1); }, 150);
  }
  try { document.addEventListener("DOMContentLoaded", function(){ installRetry(20); }, { once: true }); } catch (e) {}
  installRetry(10);
  // Canvas text measurement: an out-of-persona family must measure like the
  // generic fallback the way it would on a machine that does not have it.
  (function(){
    if (typeof CanvasRenderingContext2D === "undefined") return;
    var C2D = CanvasRenderingContext2D.prototype;
    if (!C2D || typeof C2D.measureText !== "function" || C2D.measureText.__roxyFontsInstalled) return;
    // Shared with the CSS font-family intercept below: rewrite a font spec so
    // every non-persona family becomes the generic sans-serif fallback.
    function withAllowedFont(ctx, fn){
      var before = null;
      try { before = ctx.font; } catch (e) {}
      var swapped = ensureFontSize(sanitizeFontSpec(before));
      if (swapped === before || swapped == null) return fn();
      try { ctx.font = swapped; } catch (e) { return fn(); }
      try { return fn(); } finally { try { ctx.font = before; } catch (e) {} }
    }
    var realMeasure = C2D.measureText;
    var measureFn = function(text){
      var self = this;
      return withAllowedFont(self, function(){ return realMeasure.call(self, text); });
    };
    if (fakeFns) fakeFns.add(maskLen(measureFn));
    try {
      Object.defineProperty(C2D, "measureText", { configurable: true, value: measureFn });
      Object.defineProperty(C2D, "__roxyFontsInstalled", { configurable: true, value: true, writable: true });
    } catch (e) {}
    // Pixel-level font probes render text with a target family and compare the
    // rasterized result against a control ("is this family installed?"). A
    // family outside the persona must rasterize as the generic fallback, the
    // same way fillText/strokeText behave on a machine without that font.
    var textTargets = [["fillText", "fillText"], ["strokeText", "strokeText"]];
    for (var ti = 0; ti < textTargets.length; ti++) {
      var targetName = textTargets[ti][0];
      if (typeof C2D[targetName] !== "function") continue;
      (function(targetName){
        var realText = C2D[targetName];
        var textFn = function(){
          var self = this;
          const wrapped = function(){ return realText.apply(self, arguments); };
          return withAllowedFont(self, wrapped) || undefined;
        };
        if (fakeFns) fakeFns.add(maskLen(textFn));
        try { Object.defineProperty(C2D, targetName, { configurable: true, value: textFn }); } catch (e) {}
      })(targetName);
    }
    // OffscreenCanvas 2D contexts share the same managed measureText behaviour
    // (a scanner probing fonts off the main thread must see the identical
    // persona-restricted surface).
    var O2D = typeof OffscreenCanvasRenderingContext2D !== "undefined" ? OffscreenCanvasRenderingContext2D.prototype : null;
    if (O2D && typeof O2D.measureText === "function" && !O2D.__roxyFontsInstalled) {
      try {
        var oRealMeasure = O2D.measureText;
        var oMeasureFn = function(text){
          var self = this;
          return withAllowedFont(self, function(){ return oRealMeasure.call(self, text); });
        };
        if (fakeFns) fakeFns.add(maskLen(oMeasureFn));
        Object.defineProperty(O2D, "measureText", { configurable: true, value: oMeasureFn });
        Object.defineProperty(O2D, "__roxyFontsInstalled", { configurable: true, value: true, writable: true });
      } catch (e) {}
    }
  })();
  // DOM-based font probes build a hidden span, set style.fontFamily (or the
  // font shorthand) to an out-of-persona family and compare layout width
  // against a control span. The raster layer is untouched by canvas hooks, so
  // intercept the CSSOM setters and land a sanitized spec instead: the span
  // measures as the generic fallback the way it does on the patched engine.
  (function(){
    if (typeof CSSStyleDeclaration === "undefined") return;
    var CSSD = CSSStyleDeclaration.prototype;
    function patchFontSetter(propName){
      try {
        var desc = Object.getOwnPropertyDescriptor(CSSD, propName);
        if (!desc) {
          desc = {};
          try { desc.get = function(){ return this.getPropertyValue(propName === "font" ? "font" : "font-family"); }; } catch (e) {}
          try { desc.set = function(v){ this.setProperty(propName === "font" ? "font" : "font-family", v); }; } catch (e) {}
          desc.configurable = true;
        }
        if (!desc.set) return;
        if (desc.set.__roxyFontsInstalled) return;
        var realSet = desc.set;
        var safeSet = function(v){
          var val = v;
          try {
            if (typeof v === "string" && v && /[a-z]/i.test(v)) {
              if (propName === "font" && /^[^0-9]*[0-9]/.test(v)) {
                // Shorthand: "72px 'PingFang SC', sans-serif" — swap families
                // in place. Size/line-height live before the family list, so
                // locate the last numeric prefix and make the rest parseable.
                var m = /^(-?[0-9.]+(?:px|pt|em|rem|%|vh|vw|ex|ch)?(?:\\s+\\/\\s*[0-9.]+(?:px|pt|em|rem|%|vh|vw|ex|ch)?)?\\s+)(.*)$/i.exec(v);
                if (m) { val = m[1] + sanitizeFontSpec(m[2]); }
                else { val = sanitizeFontSpec(v); }
              } else {
                val = ensureFontSize(sanitizeFontSpec(v));
              }
            }
          } catch (e) {}
          return realSet.call(this, val);
        };
        if (fakeFns) fakeFns.add(maskLen(safeSet));
        try { safeSet.__roxyFontsInstalled = true; } catch (e) {}
        Object.defineProperty(CSSD, propName, {
          configurable: true,
          get: desc.get || realSet,
          set: safeSet
        });
      } catch (e) {}
    }
    patchFontSetter("fontFamily");
    patchFontSetter("font");
    // Firefox exposes the style object on the CSSStyleProperties interface
    // while most engines alias it to CSSStyleDeclaration; patch both so the
    // prototype actually reached by element.style is covered.
    var OCSSP = typeof CSSStyleProperties !== "undefined" ? CSSStyleProperties.prototype : null;
    if (OCSSP && OCSSP !== CSSD) {
      function patchSetter(propName){
        try {
          var desc = Object.getOwnPropertyDescriptor(OCSSP, propName);
          if (!desc || !desc.set || desc.set.__roxyFontsInstalled) return;
          var realSet = desc.set;
          var safeSet = function(v){
            var val = v;
            try {
              if (typeof v === "string" && v) {
                if (propName === "font" && /^[^0-9]*[0-9]/.test(v)) {
                  var m = /^(-?[0-9.]+(?:px|pt|em|rem|%|vh|vw|ex|ch)?(?:\\s+\\/\\s*[0-9.]+(?:px|pt|em|rem|%|vh|vw|ex|ch)?)?\\s+)(.*)$/i.exec(v);
                  if (m) { val = m[1] + sanitizeFontSpec(m[2]); }
                  else { val = sanitizeFontSpec(v); }
                } else {
                  val = ensureFontSize(sanitizeFontSpec(v));
                }
              }
            } catch (e) {}
            return realSet.call(this, val);
          };
          if (fakeFns) fakeFns.add(maskLen(safeSet));
          try { safeSet.__roxyFontsInstalled = true; } catch (e) {}
          Object.defineProperty(OCSSP, propName, { configurable: true, set: safeSet });
        } catch (e) {}
      }
      patchSetter("fontFamily");
      patchSetter("font");
    }
    // Scanner libraries also reach the same surface through
    // CSSStyleDeclaration.setProperty("font-family", ...) (and the cssText
    // shorthand composers): those bypass the property setters above, so
    // sanitize there too.
    function patchSetProperty(proto){
      try {
        var realSP = proto.setProperty;
        if (typeof realSP !== "function" || realSP.__roxyFontsInstalled) return;
        var spFn = function(prop, value, priority){
          var val = value;
          try {
            var propName = String(prop || "").toLowerCase().trim();
            if ((propName === "font-family" || propName === "font") && typeof value === "string" && /[a-z]/i.test(value)) {
              if (propName === "font" && /^[^0-9]*[0-9]/.test(value)) {
                var m = /^(-?[0-9.]+(?:px|pt|em|rem|%|vh|vw|ex|ch)?(?:\\s+\\/\\s*[0-9.]+(?:px|pt|em|rem|%|vh|vw|ex|ch)?)?\\s+)(.*)$/i.exec(value);
                if (m) { val = m[1] + sanitizeFontSpec(m[2]); }
                else { val = sanitizeFontSpec(value); }
              } else {
                val = ensureFontSize(sanitizeFontSpec(value));
              }
            }
          } catch (e) {}
          return realSP.call(this, prop, val, priority);
        };
        if (fakeFns) fakeFns.add(maskLen(spFn));
        try { spFn.__roxyFontsInstalled = true; } catch (e) {}
        Object.defineProperty(proto, "setProperty", { configurable: true, value: spFn });
      } catch (e) {}
    }
    function patchCssText(proto){
      try {
        var desc = Object.getOwnPropertyDescriptor(proto, "cssText");
        if (!desc || typeof desc.set !== "function" || desc.set.__roxyFontsInstalled) return;
        var realSet = desc.set;
        var safeSet = function(v){
          var val = v;
          try {
            if (typeof v === "string" && v) {
              var cleaned = v.replace(/font-family\\s*:\\s*("[^"]*"|'[^']*'|[^;{}]+)/gi, function(match, fam){
                return "font-family: " + sanitizeFontSpec(fam);
              });
              cleaned = cleaned.replace(/(^|;)\\s*font\\s*:\\s*([^;{}]+)(;|$)/gi, function(match, pre, value, post){
                if (!/^[^0-9]*[0-9]/.test(value)) return match;
                var m = /^(-?[0-9.]+(?:px|pt|em|rem|%|vh|vw|ex|ch)?(?:\\s+\\/\\s*[0-9.]+(?:px|pt|em|rem|%|vh|vw|ex|ch)?)?\\s+)(.*)$/i.exec(value);
                if (m) return pre + ";font: " + ensureFontSize(m[1] + sanitizeFontSpec(m[2])) + post;
                return pre + ";font: " + ensureFontSize(sanitizeFontSpec(value)) + post;
              });
              val = cleaned;
            }
          } catch (e) {}
          return realSet.call(this, val);
        };
        if (fakeFns) fakeFns.add(maskLen(safeSet));
        try { safeSet.__roxyFontsInstalled = true; } catch (e) {}
        Object.defineProperty(proto, "cssText", { configurable: true, set: safeSet });
      } catch (e) {}
    }
    patchSetProperty(CSSD);
    patchCssText(CSSD);
    if (OCSSP && OCSSP !== CSSD) {
      patchSetProperty(OCSSP);
      patchCssText(OCSSP);
    }
  })();
  // Dedicated/Shared workers never receive the BiDi preload: a scanner that
  // moved font detection off the main thread reads the unfiltered OS font
  // inventory through OffscreenCanvas measureText there (worker diag confirm:
  // "platform: MacIntel", "measureText: [native code]"). Wrap the Worker
  // constructors so spawned scripts run through a shim that re-applies the
  // same persona filter as the window realm.
  (function(){
    if (typeof window === "undefined" || typeof window.Worker !== "function") return;
    try { if (window.Worker.__roxyFontsInstalled) return; } catch (e) {}
    if (!fonts || !fonts.length) return;
    var RealWorker = window.Worker;
    var workerShimSrc = null;
    function getWorkerShimSrc(){
      if (workerShimSrc != null) return workerShimSrc;
      workerShimSrc = "(function(){try{" +
        'var GENERIC=' + GENERIC.toString() + ';' +
        'var STYLE=' + STYLE.toString() + ';' +
        'var allowed=' + JSON.stringify(allowed) + ';' +
        // The persona font helpers have no closure in the worker realm (the
        // shim runs as a fresh script), so their sources are serialized HERE
        // (page realm, where the functions exist) with JSON.stringify — every
        // control character escaped, no raw newline/apostrophe can break the
        // enclosing quotes — and carried as JSON string values. The shim then
        // rebuilds the functions with Function(...), passing the dependencies
        // it declared above as parameters. The source values are resolved
        // before any reference: no function is called before its var exists.
        'var familyTokensSrc=' + JSON.stringify("return " + familyTokens.toString()) + ';' +
        'var familyTokens=Function("STYLE",familyTokensSrc)(STYLE);' +
        'var familyAllowedSrc=' + JSON.stringify("return " + familyAllowed.toString()) + ';' +
        'var familyAllowed=Function("GENERIC","STYLE","allowed","familyTokens",familyAllowedSrc)(GENERIC,STYLE,allowed,familyTokens);' +
        'var sanitizeFontSpecSrc=' + JSON.stringify("return " + sanitizeFontSpec.toString()) + ';' +
        'var sanitizeFontSpec=Function("familyAllowed",sanitizeFontSpecSrc)(familyAllowed);' +
        'var O2D=typeof OffscreenCanvasRenderingContext2D!=="undefined"?OffscreenCanvasRenderingContext2D.prototype:null;' +
        'if(!O2D||typeof O2D.measureText!=="function"||O2D.__roxyFontsInstalled)return;' +
        // Workers are real browser agents too: their navigator (platform,
        // oscpu, appVersion, hardwareConcurrency, maxTouchPoints, webdriver,
        // languages) and timezone would otherwise expose the HOST identity the
        // window realm is masking — the classic two-realm cross-check.
        // NOTE: the wcfg literal is evaluated in buildFirefoxFingerprintPreloadScript
        // (TS side) and embedded as plain JSON — the page realm has no config.
        'var wcfg=' + ${JSON.stringify(wcfgJson)} + ';' +
        'if(typeof navigator!=="undefined"){try{' +
        'var WNP=Object.getPrototypeOf(navigator)||navigator;' +
        'function wval(o,k,v){try{var d=Object.getOwnPropertyDescriptor(o,k);if(d&&!d.configurable)return;Object.defineProperty(o,k,{configurable:true,get:function(){return v;}});}catch(e){}}' +
        'function wget(o,k,f){try{var d=Object.getOwnPropertyDescriptor(o,k);if(d&&!d.configurable)return;Object.defineProperty(o,k,{configurable:true,get:f});}catch(e){}}' +
        'wval(WNP,"platform",wcfg.platform);' +
        'wval(WNP,"oscpu",wcfg.oscpu);' +
        'wval(WNP,"appVersion",wcfg.appVersion);' +
        'wval(WNP,"maxTouchPoints",wcfg.maxTouchPoints);' +
        'wval(WNP,"hardwareConcurrency",wcfg.hardwareConcurrency);' +
        'wval(WNP,"webdriver",false);' +
        'wget(WNP,"languages",function(){return wcfg.languages.slice();});' +
        'if(wcfg.timezone){' +
        'var rrs=Intl.DateTimeFormat.prototype.resolvedOptions;' +
        'Intl.DateTimeFormat.prototype.resolvedOptions=function(){var r=rrs.call(this);try{r=Object.assign({},r,{timeZone:wcfg.timezone});}catch(e){}return r;};' +
        'var woff=function(date){try{var p=new Intl.DateTimeFormat("ia",{timeZone:wcfg.timezone,timeZoneName:"shortOffset"}).formatToParts(date);var n="";for(var i=0;i<p.length;i++)if(p[i].type==="timeZoneName"){n=p[i].value;break;}var m=/GMT([+-])(\\d{2})(?::?(\\d{2}))?/.exec(n);if(!m)return null;var s=m[1]==="-"?-1:1;return -(s*(parseInt(m[2],10)*60+(m[3]?parseInt(m[3],10):0)));}catch(e){return null;}};' +
        'var rod=Date.prototype.getTimezoneOffset;' +
        'Date.prototype.getTimezoneOffset=function(){var v=woff(this);return v===null?rod.call(this):v;};' +
        '}' +
        '}catch(e){}}' +
        // Mirror the window realm's deterministic canvas noise so Offscreen
        // canvas draws here carry persona-formatted pixels, not host-noise.
        'if(wcfg.canvasSeed){try{' +
        'var seedFromHex=function(hex){var n=0;for(var i=0;i<hex.length&&i<8;i++){n=(n*16+parseInt(hex[i],16))>>>0;}return n||1;};' +
        'var mulberry32=function(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;var t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};};' +
        'var wCounters=typeof WeakMap!=="undefined"?new WeakMap():null;' +
        'function wNext(ctx){var n=wCounters?(wCounters.get(ctx)||0):0;if(wCounters)wCounters.set(ctx,n+1);return mulberry32((seedFromHex(wcfg.canvasSeed)+n)>>>0)();}' +
        'function wJitter(ctx){return(wNext(ctx)-0.5)*0.6;}' +
        'function wMap(op,args,ctx){if(op==="fillRect"||op==="strokeRect"){args[0]=args[0]+wJitter(ctx);args[1]=args[1]+wJitter(ctx);return args;}if(op==="fillText"||op==="strokeText"){args[1]=args[1]+wJitter(ctx);return args;}if(op==="arc"){args[args.length-1]=args[args.length-1]+(wNext(ctx)-0.5)*0.003;return args;}return args;}' +
        'var NWT=[["fillRect","fillRect"],["strokeRect","strokeRect"],["fillText","fillText"],["strokeText","strokeText"],["arc","arc"]];' +
        'for(var i=0;i<NWT.length;i++){(function(n){if(typeof O2D[n]!=="function")return;var rT=O2D[n];O2D[n]=function(){return rT.apply(this,wMap(n,Array.prototype.slice.call(arguments),this));};})(NWT[i][0]);}' +
        '}catch(e){}}' +
        'function withAllowed(ctx,fn){var before=null;try{before=ctx.font;}catch(e){}var sw=sanitizeFontSpec(before);if(sw===before||sw==null)return fn();if(typeof sw==="string"&&sw&&!/^\\s*-?[0-9]/.test(sw))sw="13px "+sw;try{ctx.font=sw;}catch(e){return fn();}try{return fn();}finally{try{ctx.font=before;}catch(e){}}}' +
        'var rM=O2D.measureText;' +
        'O2D.measureText=function(text){var self=this;return withAllowed(self,function(){return rM.call(self,text);});};' +
        'var TT=[["fillText","fillText"],["strokeText","strokeText"]];' +
        'for(var i=0;i<TT.length;i++){(function(n){var rT=O2D[n];O2D[n]=function(){var self=this;var w=function(){return rT.apply(self,arguments);};return withAllowed(self,w)||undefined;};})(TT[i][0]);}' +
        'try{O2D.__roxyFontsInstalled=true;}catch(e){}' +
        'var __d={};try{__d.sanitize=sanitizeFontSpec;__d.known=allowed;__d.generic=GENERIC;self.__roxyFontDiag=__d;}catch(e){}' +
        'var _t=Function.prototype.toString;' +
        'try{Function.prototype.toString=function(){var MM=[[O2D.fillRect,"fillRect"],[O2D.strokeRect,"strokeRect"],[O2D.arc,"arc"]];for(var i=0;i<MM.length;i++){if(this===MM[i][0])return "function "+MM[i][1]+"() { [native code] }";}if(this===O2D.measureText)return "function measureText() { [native code] }";if(this===O2D.fillText)return "function fillText() { [native code] }";if(this===O2D.strokeText)return "function strokeText() { [native code] }";return _t.call(this);};}catch(e){}' +
        "}catch(e){}})();";
      return workerShimSrc;
    }
    function fetchWorkerSource(url){
      try {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", String(url), false);
        xhr.send();
        if (xhr.status !== 200 || typeof xhr.responseText !== "string" || !xhr.responseText) return null;
        return xhr.responseText;
      } catch (e) { return null; }
    }
    function shimUrl(src){
      try {
        var blob = new Blob([getWorkerShimSrc(), "\\n", src], { type: "text/javascript" });
        return URL.createObjectURL(blob);
      } catch (e) { console.error("[roxy-worker-shim]", e && (e.message || e)); return null; }
    }
    function shimImportUrl(url){
      try {
        var blob = new Blob([getWorkerShimSrc(), "\\nimportScripts(", JSON.stringify(String(url)), ");"], { type: "text/javascript" });
        return URL.createObjectURL(blob);
      } catch (e) { console.warn("[roxy-shim-import]", e && (e.message || e)); return null; }
    }
    function shimModuleUrl(url){
      try {
        var blob = new Blob([getWorkerShimSrc(), "\\nimport ", JSON.stringify(String(url)), ";"], { type: "text/javascript" });
        return URL.createObjectURL(blob);
      } catch (e) { return null; }
    }
    function wrapWorkerUrl(url, opts){
      var src = fetchWorkerSource(url);
      if (src) {
        if (opts && opts.type === "module") return shimModuleUrl(url);
        return shimUrl(src);
      }
      if (opts && opts.type === "module") return null;
      return shimImportUrl(url);
    }
    function ShimmedWorker(url, opts){
      try {
        var patched = wrapWorkerUrl(url, opts);
        if (patched) return new RealWorker(patched, opts);
      } catch (e) {}
      return new RealWorker(url, opts);
    }
    ShimmedWorker.prototype = RealWorker.prototype;
    var RealShared = typeof window.SharedWorker === "function" ? window.SharedWorker : null;
    function ShimmedShared(url, name, opts){
      var named = typeof name === "string";
      var options = named ? opts : (name !== undefined ? name : undefined);
      function real(target){
        if (named) return new RealShared(target, name, options);
        return new RealShared(target, options);
      }
      try {
        var patched = wrapWorkerUrl(url, options);
        if (patched) return real(patched);
      } catch (e) {}
      return real(url);
    }
    if (RealShared) ShimmedShared.prototype = RealShared.prototype;
    try {
      Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: ShimmedWorker });
      try { ShimmedWorker.__roxyFontsInstalled = true; } catch (e) {}
    } catch (e) {}
    if (RealShared) {
      try {
        Object.defineProperty(window, "SharedWorker", { configurable: true, writable: true, value: ShimmedShared });
        try { ShimmedShared.__roxyFontsInstalled = true; } catch (e) {}
      } catch (e) {}
    }
  })();
})();
// ── storage quota ──
// estimate is a StorageManager.prototype method; own-property on the
// navigator.storage instance breaks the native descriptor shape.
(function(){
  if (!navigator.storage || typeof navigator.storage.estimate !== "function") return;
  var storageProto = null;
  try { storageProto = navigator.storage.constructor.prototype; } catch (e) {}
  if (!storageProto) return;
  var orig = storageProto.estimate;
  try {
    var estimateFn = function(){
      return orig.call(this).then(function(info){
        return { usage: info.usage || 0, quota: cfg.storageQuotaBytes || info.quota || 0 };
      });
    };
    if (fakeFns) fakeFns.add(maskLen(estimateFn));
    Object.defineProperty(storageProto, "estimate", {
      configurable: true,
      value: estimateFn,
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
  const config = buildBrowserFingerprintConfig(meta, null, secureDns, "firefox");
  return {
    config,
    prefs: buildFirefoxFingerprintPrefs(config, firefoxVersion),
    preloadScript: buildFirefoxFingerprintPreloadScript(config),
    userAgent: buildFirefoxUserAgent(config.platform, firefoxVersion),
  };
}

// ── Injection self-check (launch-time probe, Slice 79.2) ──
//
// The fingerprint drift baseline compares the live page against a stored
// baseline, but it cannot tell whether the managed preload took effect at all
// (both worlds read the same "true" values when nothing is injected). The probe
// closes that gap deterministically:
//   - the decisive check is `navigator.webdriver`: real Firefox exposes
//     `true` while a WebDriver BiDi session is active, and the preload disarms
//     it to `false` — an injection that ran is provable from this one value;
//   - a canvas double-draw confirms the deterministic noise layer is alive
//     (noise is stable per draw — byte-identical replays — so the double-draw
//     reads equal when the managed overlay is active, and also equal on a bare
//     engine; the decisive confirmation stays `navigator.webdriver` below);
//   - the managed fields are echoed back so the launch verifies the injected
//     values are the profile's own identity.

export interface InjectionProbeExpectation {
  platform: string;
  language: string;
  screenWidth: number;
  hardwareConcurrency: number;
  webdriver: boolean;
}

export interface InjectionProbeCheck {
  checked: boolean;
  /** The preload demonstrably ran (navigator.webdriver is disarmed). */
  confirmed: boolean;
  /** The probe could not decide (probe evaluation failed/broken context). */
  ambiguous: boolean;
  /** Fields the page reported that differ from the managed identity. */
  mismatches: string[];
  /** Informational: canvas double-draw reads equal (stable deterministic noise layer). */
  noiseActive?: boolean;
  error?: string;
}

/** The expectations the preload itself implements — derived from the same config. */
export function buildInjectionProbeExpectation(config: BrowserFingerprintConfig): InjectionProbeExpectation {
  return {
    platform: config.platform,
    language: config.languages[0] || "en-US",
    screenWidth: config.screen.width,
    hardwareConcurrency: config.hardwareConcurrency,
    webdriver: false,
  };
}

/** Probe expression evaluated INSIDE the injected world (launch BiDi session). */
export function buildInjectionProbeExpression(): string {
  return `// roxy-managed-probe
(function(){
  var o = {};
  function drawCanvas(){
    var c = document.createElement("canvas"); c.width = 64; c.height = 16;
    var x = c.getContext("2d");
    x.textBaseline = "top"; x.font = "12px Arial";
    x.fillRect(2, 2, 8, 4);
    x.fillText("Agent Browser Studio-FP", 2, 2);
    x.strokeRect(40, 2, 10, 6);
    x.beginPath(); x.arc(48, 12, 4, 0, Math.PI * 1.5); x.stroke();
    return x.getImageData(0, 0, 64, 16).data;
  }
  try {
    var a = drawCanvas(); var b = drawCanvas();
    var same = a.length === b.length;
    if (same) { for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { same = false; break; } } }
    o.doubleDrawEqual = same;
  } catch(e){}
  try { o.webdriver = navigator.webdriver; } catch(e){}
  try { o.platform = navigator.platform; } catch(e){}
  try { o.language = navigator.language; } catch(e){}
  try { o.screenWidth = screen.width; } catch(e){}
  try { o.hardwareConcurrency = navigator.hardwareConcurrency; } catch(e){}
  return o;
})()`;
}

/** Turn the probe's in-page answer into a verdict. */
export function judgeInjectionProbe(response: any, expected: InjectionProbeExpectation): InjectionProbeCheck {
  if (typeof response === "string") {
    try { response = JSON.parse(response); } catch { /* fall through as broken */ }
  }
  const mismatches: string[] = [];
  if (!response || typeof response !== "object") {
    return { checked: false, confirmed: false, ambiguous: true, mismatches: [], error: "probe returned nothing" };
  }
  const fields: Array<[string, any]> = [
    ["platform", expected.platform],
    ["language", expected.language],
    ["screenWidth", expected.screenWidth],
    ["hardwareConcurrency", expected.hardwareConcurrency],
  ];
  for (const [field, want] of fields) {
    if (response[field] !== undefined && response[field] !== want) mismatches.push(field);
  }
  if (typeof response.webdriver !== "boolean") {
    return { checked: true, confirmed: false, ambiguous: true, mismatches, error: "probe did not report navigator.webdriver" };
  }
  const confirmed = response.webdriver === false;
  return {
    checked: true,
    confirmed,
    ambiguous: false,
    mismatches,
    noiseActive: typeof response.doubleDrawEqual === "boolean" ? response.doubleDrawEqual === true : undefined,
  };
}

/** Block rule: an injection we cannot prove is a silent-failure launch gate. */
export function shouldBlockInjectionProbe(check: InjectionProbeCheck, blockOnInjectionProbe: unknown): boolean {
  return !!check.checked && !check.confirmed && !check.ambiguous && blockOnInjectionProbe !== false;
}