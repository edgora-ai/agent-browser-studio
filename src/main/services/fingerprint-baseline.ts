// Fingerprint baseline + drift detection — the trust foundation the scenario
// eval flagged ("可信反检测 = 可证明稳定"). Capture a per-profile signature of
// the live browser fingerprint (UA / platform / languages / hardware / screen /
// timezone / WebGL / canvas), store it as the profile's baseline, and diff
// subsequent captures so drift is visible/auditable before it causes account
// loss. Pure logic for capture/diff (testable); engine-aware eval (CDP / BiDi)
// injected.
import { captureWebGlCorpusInPage } from "../../tools/webgl-corpus.js";
import { captureWebGpuCorpusInPage } from "../../tools/webgpu-corpus.js";
import { captureFontCorpusInPage } from "../../tools/font-corpus.js";
import { evaluateInPage } from "./page-eval.js";
import type { BrowserEngine } from "./browser-engine.js";

const WEBGL_CORPUS_CAPTURE_SOURCE = captureWebGlCorpusInPage.toString();
const WEBGPU_CORPUS_CAPTURE_SOURCE = captureWebGpuCorpusInPage.toString();
const FONT_CORPUS_CAPTURE_SOURCE = captureFontCorpusInPage.toString();

/** The in-page expression that collects the fingerprint signature. */
export const CAPTURE_EXPRESSION = `(async function(){
  var o = {};
  function hash(value) {
    var h = 2166136261;
    for (var i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  try { o.userAgent = navigator.userAgent; } catch(e){}
  try { o.appVersion = navigator.appVersion; } catch(e){}
  try { o.platform = navigator.platform; } catch(e){}
  try { o.language = navigator.language; } catch(e){}
  try { o.languages = (navigator.languages || []).join(","); } catch(e){}
  try { o.hardwareConcurrency = navigator.hardwareConcurrency; } catch(e){}
  try { o.deviceMemory = navigator.deviceMemory; } catch(e){}
  try { o.maxTouchPoints = navigator.maxTouchPoints; } catch(e){}
  try { o.doNotTrack = navigator.doNotTrack; } catch(e){}
  try { o.screenW = screen.width; o.screenH = screen.height; } catch(e){}
  try { o.availW = screen.availWidth; o.availH = screen.availHeight; } catch(e){}
  try { o.availLeft = screen.availLeft; o.availTop = screen.availTop; } catch(e){}
  try { o.screenX = window.screenX; o.screenY = window.screenY; } catch(e){}
  try { o.outerWidth = window.outerWidth; o.outerHeight = window.outerHeight; } catch(e){}
  try { o.innerWidth = window.innerWidth; o.innerHeight = window.innerHeight; } catch(e){}
  try { o.colorDepth = screen.colorDepth; o.pixelDepth = screen.pixelDepth; } catch(e){}
  try { o.devicePixelRatio = devicePixelRatio; } catch(e){}
  try { o.preferredColorScheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch(e){}
  try {
    var systemColorKeywords = ["AccentColor", "AccentColorText", "ActiveText", "ButtonBorder", "ButtonFace", "ButtonText", "Canvas", "CanvasText", "Field", "FieldText", "GrayText", "Highlight", "HighlightText", "LinkText", "Mark", "MarkText", "SelectedItem", "SelectedItemText", "VisitedText"];
    function readSystemColors(scheme) {
      var result = {};
      var node = document.createElement("span");
      node.style.cssText = "position:fixed;left:-10000px;top:-10000px;color-scheme:" + scheme;
      document.documentElement.appendChild(node);
      systemColorKeywords.forEach(function(keyword){
        node.style.color = keyword;
        result[keyword] = getComputedStyle(node).color;
      });
      node.remove();
      return result;
    }
    o.systemColors = JSON.stringify({ preferred: readSystemColors("light dark"), light: readSystemColors("light"), dark: readSystemColors("dark") });
  } catch(e){}
  try { o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(e){}
  try { o.tzOffset = new Date().getTimezoneOffset(); } catch(e){}
  try { o.uaPlatform = navigator.userAgentData ? navigator.userAgentData.platform : null; } catch(e){}
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      var ua = await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "fullVersionList", "platformVersion", "wow64"]);
      o.uaHighEntropy = JSON.stringify(ua);
    }
  } catch(e){}
  try {
    var webglCorpus = await (${WEBGL_CORPUS_CAPTURE_SOURCE})();
    o.webglCapabilityHash = hash(JSON.stringify(webglCorpus));
  } catch(e){}
  try {
    o.plugins = Array.from(navigator.plugins || []).map(function(p){ return [p.name, p.filename, p.description].join("|"); }).sort().join(";");
    o.mimeTypes = Array.from(navigator.mimeTypes || []).map(function(m){ return [m.type, m.suffixes].join("|"); }).sort().join(";");
  } catch(e){}
  try {
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (gl) {
      o.glVendor = gl.getParameter(gl.VENDOR);
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      o.glUnmaskedVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
      o.glRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
    }
  } catch(e){}
  try {
    var fontCorpus = await (${FONT_CORPUS_CAPTURE_SOURCE})();
    o.fontAvailability = Object.keys(fontCorpus.window.availability).sort().map(function(name){
      return name + "|" + fontCorpus.window.availability[name];
    }).join(";");
    o.fontCapabilityHash = hash(JSON.stringify({
      window: {
        fontSetAvailable: fontCorpus.window.fontSetAvailable,
        availability: fontCorpus.window.availability,
        genericMetrics: fontCorpus.window.genericMetrics,
        namedMetrics: fontCorpus.window.namedMetrics,
        raster: fontCorpus.window.raster
      },
      worker: fontCorpus.worker
    }));
  } catch(e){}
  try {
    var OfflineAudio = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (OfflineAudio) {
      var audioContext = new OfflineAudio(1, 8192, 44100);
      var oscillator = audioContext.createOscillator();
      var compressor = audioContext.createDynamicsCompressor();
      oscillator.type = "triangle";
      oscillator.frequency.value = 10000;
      oscillator.connect(compressor);
      compressor.connect(audioContext.destination);
      oscillator.start(0);
      var rendered = await audioContext.startRendering();
      o.audioHash = hash(Array.from(rendered.getChannelData(0).slice(0, 4096)).map(function(v){ return v.toFixed(8); }).join(","));
    }
  } catch(e){}
  try {
    var c2 = document.createElement("canvas"); c2.width = 64; c2.height = 16;
    var x = c2.getContext("2d"); x.textBaseline = "top"; x.font = "12px Arial";
    x.fillText("Agent Browser Studio-FP", 2, 2);
    var canvasData = c2.toDataURL();
    o.canvasLen = canvasData.length;
    o.canvasHash = hash(canvasData);
  } catch(e){}
  try {
    var rectNode = document.createElement("span");
    rectNode.textContent = "Agent Browser Studio-Rect";
    rectNode.style.cssText = "position:fixed;left:-10000px;top:-10000px;font:13px Arial";
    document.documentElement.appendChild(rectNode);
    var rect = rectNode.getBoundingClientRect();
    o.clientRect = [rect.x, rect.y, rect.width, rect.height].join(",");
    rectNode.remove();
  } catch(e){}
  try {
    var voices = speechSynthesis.getVoices();
    if (!voices.length) {
      voices = await new Promise(function(resolve){
        var timer = setTimeout(function(){ resolve(speechSynthesis.getVoices()); }, 1500);
        speechSynthesis.addEventListener("voiceschanged", function done(){
          clearTimeout(timer);
          speechSynthesis.removeEventListener("voiceschanged", done);
          resolve(speechSynthesis.getVoices());
        });
      });
    }
    o.speechVoices = Array.from(voices).map(function(v){ return [v.name, v.lang, v.localService, v.default].join("|"); }).sort().join(";");
  } catch(e){}
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      var devices = await navigator.mediaDevices.enumerateDevices();
      o.mediaDevices = devices.map(function(d){ return [d.kind, d.label].join("|"); }).sort().join(";");
    }
  } catch(e){}
  try {
    if (navigator.storage && navigator.storage.estimate) {
      var estimate = await navigator.storage.estimate();
      o.storageQuota = estimate.quota || 0;
    }
  } catch(e){}
  try {
    var webgpuCorpus = await (${WEBGPU_CORPUS_CAPTURE_SOURCE})();
    var webgpuInfo = webgpuCorpus.window.adapter ? webgpuCorpus.window.adapter.info : null;
    if (webgpuInfo) {
        o.webgpuVendor = webgpuInfo.vendor;
        o.webgpuArchitecture = webgpuInfo.architecture;
        o.webgpuDevice = webgpuInfo.device;
        o.webgpuDescription = webgpuInfo.description;
        o.webgpuSubgroupMinSize = webgpuInfo.subgroupMinSize;
        o.webgpuSubgroupMaxSize = webgpuInfo.subgroupMaxSize;
        o.webgpuIsFallbackAdapter = webgpuInfo.isFallbackAdapter;
      }
    o.webgpuCapabilityHash = hash(JSON.stringify(webgpuCorpus));
  } catch(e){}
  try {
    var workerSource = [
      "onmessage=async function(){var r={};",
      "try{r.userAgent=navigator.userAgent;r.platform=navigator.platform;r.languages=(navigator.languages||[]).join(',');r.hardwareConcurrency=navigator.hardwareConcurrency;r.deviceMemory=navigator.deviceMemory;}catch(e){}",
      "try{r.uaPlatform=navigator.userAgentData?navigator.userAgentData.platform:null;}catch(e){}",
      "try{r.tz=Intl.DateTimeFormat().resolvedOptions().timeZone;r.tzOffset=new Date().getTimezoneOffset();}catch(e){}",
      "try{var c=new OffscreenCanvas(8,8);var gl=c.getContext('webgl');if(gl){var d=gl.getExtension('WEBGL_debug_renderer_info');r.glVendor=gl.getParameter(gl.VENDOR);r.glUnmaskedVendor=d?gl.getParameter(d.UNMASKED_VENDOR_WEBGL):null;r.glRenderer=d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):null;}}catch(e){}",
      "postMessage(r);close();}"
    ].join("");
    var workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    o.workerIdentity = JSON.stringify(await new Promise(function(resolve){
      var worker = new Worker(workerUrl);
      var timer = setTimeout(function(){ worker.terminate(); resolve({ timeout: true }); }, 2000);
      worker.onmessage = function(event){ clearTimeout(timer); resolve(event.data); };
      worker.onerror = function(){ clearTimeout(timer); resolve({ error: true }); };
      worker.postMessage(1);
    }));
    URL.revokeObjectURL(workerUrl);
  } catch(e){}
  return JSON.stringify(o);
})()`;

export type Fingerprint = Record<string, string | number | null | boolean>;

/** Capture the live fingerprint from a running profile (CDP or BiDi by engine). */
export async function captureFingerprint(cdpPort: number, engine: BrowserEngine = "chromium"): Promise<Fingerprint> {
  // Keep the probe importable by the standalone Chromium verifier without
  // loading Electron-only local-agent dependencies (page-eval lazy-loads).
  const raw = await evaluateInPage(cdpPort, engine, CAPTURE_EXPRESSION, { timeoutMs: 20000 });
  const value = typeof raw === "string" ? raw : raw?.value;
  return typeof value === "string" ? JSON.parse(value) : (value || {});
}

export interface FingerprintDrift {
  field: string;
  baseline: unknown;
  current: unknown;
}

/** Compare two fingerprints; return the changed fields (drift). */
export function diffFingerprints(baseline: Fingerprint | null | undefined, current: Fingerprint): FingerprintDrift[] {
  if (!baseline) return [];
  const drift: FingerprintDrift[] = [];
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const k of keys) {
    const b = (baseline as any)[k];
    const c = (current as any)[k];
    if (b === undefined && c === undefined) continue;
    if (String(b ?? "") !== String(c ?? "")) {
      drift.push({ field: k, baseline: b ?? null, current: c ?? null });
    }
  }
  return drift;
}

/** True if the drift contains a high-risk signal field. */
export function hasRiskyDrift(drift: FingerprintDrift[]): boolean {
  const risky = new Set([
    "userAgent", "platform", "uaPlatform", "uaHighEntropy", "tz", "tzOffset",
    "glVendor", "glUnmaskedVendor", "glRenderer", "webglCapabilityHash", "webgpuVendor", "webgpuArchitecture",
    "webgpuDevice", "webgpuDescription", "webgpuCapabilityHash", "webgpuSubgroupMinSize", "webgpuSubgroupMaxSize",
    "webgpuIsFallbackAdapter", "hardwareConcurrency", "deviceMemory",
    "maxTouchPoints", "screenW", "screenH", "availLeft", "availTop",
    "screenX", "screenY", "outerWidth", "outerHeight", "innerWidth", "innerHeight",
    "devicePixelRatio", "canvasHash",
    "clientRect", "workerIdentity", "plugins", "mimeTypes", "speechVoices",
    "fontAvailability", "fontCapabilityHash", "audioHash",
    "mediaDevices", "storageQuota", "doNotTrack", "systemColors", "preferredColorScheme",
  ]);
  return drift.some((d) => risky.has(d.field));
}

/** Human-readable summary of drifted fields (capped for UI/audit). */
export function summarizeDrift(drift: FingerprintDrift[], limit = 8): string {
  if (!drift.length) return "none";
  const head = drift.slice(0, limit).map((d) => d.field).join(", ");
  return drift.length > limit ? head + " (+" + (drift.length - limit) + " more)" : head;
}
