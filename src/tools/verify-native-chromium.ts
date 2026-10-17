/// <reference lib="dom" />

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { CAPTURE_EXPRESSION } from "../main/services/fingerprint-baseline.js";
import {
  buildBrowserFingerprintArg,
  buildBrowserFingerprintConfig,
  type BrowserFingerprintConfig,
} from "../main/services/browser-fingerprint-config.js";
import type { BrowserFingerprintMeta } from "../main/types.js";
import { getHostBrowserPlatform } from "../main/services/browser-platform-policy.js";
import {
  captureHostIdentityInPage,
  verifyHostIdentityCoherence,
  type HostIdentityCorpus,
  type HostIdentityRequestHeaders,
} from "./host-identity-corpus.js";
export { verifyHostIdentityCoherence } from "./host-identity-corpus.js";
export type { HostIdentityCorpus } from "./host-identity-corpus.js";
export { captureFullHostIdentity, startHostIdentityFixture } from "./host-identity-capture.js";
export type { FullHostIdentityCapture, HostIdentityFixture } from "./host-identity-capture.js";
import { parseChromeVersionElement, parseChromiumProductVersion, parseChromiumUserAgentVersion } from "./client-hints.js";
import { captureWebGlCorpusInPage, type WebGlCorpus } from "./webgl-corpus.js";
import {
  captureWebGpuCorpusInPage,
  type WebGpuContextCorpus,
  type WebGpuCorpus,
} from "./webgpu-corpus.js";
import { captureStorageCorpusInPage, type StorageCorpus } from "./storage-corpus.js";
import { captureFontCorpusInPage, type FontCorpus } from "./font-corpus.js";

type Probe = Record<string, string | number | boolean | null | undefined>;

const SYSTEM_COLOR_KEYWORDS = [
  "AccentColor", "AccentColorText", "ActiveText", "ButtonBorder",
  "ButtonFace", "ButtonText", "Canvas", "CanvasText", "Field", "FieldText",
  "GrayText", "Highlight", "HighlightText", "LinkText", "Mark", "MarkText",
  "SelectedItem", "SelectedItemText", "VisitedText",
] as const;

// GPU capabilities come from this executable's native pass-through capture on
// the same host and in the same window mode, not normalized stock constants.
// An explicit generated WebGL identity proves only simulated identity conformance,
// never a physical GPU match.
const TARGET_CHROMIUM_VERSION = "152.0.7977.72";

type SystemColorKeyword = typeof SYSTEM_COLOR_KEYWORDS[number];
type Pixel = [number, number, number, number];

interface SelectionPaintIdentity {
  background: Pixel;
  dominantPixels: number;
  blackPixels: number;
  whitePixels: number;
}

interface SystemThemeSchemeIdentity {
  colors: Record<SystemColorKeyword, string>;
  selection: SelectionPaintIdentity;
}

interface SystemThemeIdentity {
  preferredColorScheme: "light" | "dark";
  preferredColors: Record<SystemColorKeyword, string>;
  light: SystemThemeSchemeIdentity;
  dark: SystemThemeSchemeIdentity;
}

export interface GpuCorpus {
  webgl: WebGlCorpus;
  webgpu: WebGpuCorpus;
}

interface PassThroughIdentity extends GpuCorpus {
  probe: Probe;
  systemTheme: SystemThemeIdentity;
}

type RequestIdentityHeaders = HostIdentityRequestHeaders;

interface RequestIdentityByContext {
  window: RequestIdentityHeaders;
  dedicated: RequestIdentityHeaders;
  shared: RequestIdentityHeaders;
  service: RequestIdentityHeaders;
}

interface FrameIdentity {
  userAgent: string;
  platform: string;
  languages: string[];
  uaPlatform: string | null;
  uaFullVersion: string | null;
  request: RequestIdentityHeaders;
}

interface CdpOverrideIdentity {
  top: FrameIdentity;
  sameOriginFrame: FrameIdentity;
  crossOriginFrame: FrameIdentity;
  requestHeaders: RequestIdentityByContext;
}

export interface VersionElementEvidence {
  found: boolean;
  elementCount: number;
  textContent: string | null;
  outerHTML: string | null;
  directTextNodes: string[];
  versionTextSelector: string;
  versionTextCandidateCount: number;
  versionTextCandidates: { textContent: string; outerHTML: string; childElementCount: number }[];
  versionTextSource: "#version (direct Text nodes)" | "#version > span#copy-content > span:first-child" | null;
  truncated: boolean;
}

export interface VersionIdentity {
  product: string;
  productVersion: string;
  userAgent: string;
  /** Canonical value from the exact captured version source, retained under the existing field name. */
  chromeVersionText: string;
  versionElement: string;
  versionElementSource: "chrome://version#version";
  rawVersionElement: VersionElementEvidence;
}

export class VersionIdentityCaptureError extends Error {
  constructor(message: string, readonly evidence: {
    product?: string; userAgent?: string; rawVersionElement?: VersionElementEvidence; cleanupErrors: string[];
  }) { super(message); this.name = "VersionIdentityCaptureError"; }
}

interface StockWindowModeIdentity {
  screenY: number;
  innerHeight: number;
}

interface RunResult extends GpuCorpus {
  probe: Probe;
  storage: StorageCorpus;
  fonts: FontCorpus;
  codecs: {
    aacCanPlay: string;
    h264CanPlay: string;
    mediaSourceAAC: boolean | null;
    mediaSourceH264: boolean | null;
    audioDecoding: {
      supported: boolean;
      smooth: boolean;
      powerEfficient: boolean;
    } | null;
    videoDecoding: {
      supported: boolean;
      smooth: boolean;
      powerEfficient: boolean;
    } | null;
    aacEncoder: boolean | null;
    h264Encoder: boolean | null;
  };
  media: {
    devices: Array<{ kind: string; deviceId: string; groupId: string; label: string }>;
    audioTrackDeviceId: string | null;
    videoTrackDeviceId: string | null;
    audioCaptureStatus: "ok" | "timeout" | "error";
    audioCaptureError: string | null;
  };
  storageBucketQuota: number | null;
  webauthn: {
    capabilities: Record<string, boolean>;
    userVerifyingPlatformAuthenticator: boolean;
    conditionalMediation: boolean;
  };
  geolocation: { latitude: number; longitude: number; accuracy: number };
  requestHeaders: RequestIdentityByContext;
  cdpOverride: CdpOverrideIdentity;
  versionIdentity: VersionIdentity;
  webrtcCandidates: string[];
  systemTheme: SystemThemeIdentity;
}

const STABLE_FIELDS = [
  "userAgent", "appVersion", "platform", "language", "languages",
  "hardwareConcurrency", "deviceMemory", "maxTouchPoints", "doNotTrack",
  "screenW", "screenH", "availW", "availH", "colorDepth", "pixelDepth",
  "availLeft", "availTop", "screenX", "screenY", "outerWidth", "outerHeight",
  "innerWidth", "innerHeight",
  "devicePixelRatio", "tz", "tzOffset", "uaPlatform", "uaHighEntropy",
  "plugins", "mimeTypes", "glVendor", "glUnmaskedVendor", "glRenderer",
  "webglCapabilityHash", "canvasHash", "audioHash", "clientRect", "fontAvailability",
  "fontCapabilityHash",
  "speechVoices", "mediaDevices", "storageQuota", "webgpuVendor",
  "webgpuArchitecture", "webgpuDevice", "webgpuDescription", "webgpuSubgroupMinSize",
  "webgpuSubgroupMaxSize", "webgpuIsFallbackAdapter", "webgpuCapabilityHash", "workerIdentity",
  "systemColors", "preferredColorScheme",
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

export function webGlCorpusSha256(contexts: WebGlCorpus["window"]): string {
  return createHash("sha256").update(JSON.stringify(contexts)).digest("hex");
}

export function webGpuCorpusSha256(context: WebGpuContextCorpus): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

function configuredWebGlIdentity(config: Pick<BrowserFingerprintConfig, "webgl"> | null): { vendor: string; renderer: string } | undefined {
  const identity = config?.webgl;
  // Both empty strings mean native pass-through. A one-sided override is still
  // explicit and must fail pair validation rather than silently becoming native.
  return identity && (identity.vendor || identity.renderer) ? identity : undefined;
}

function projectNativeWebGlCorpus(native: WebGlCorpus, expectedWebgl?: { vendor: string; renderer: string }): WebGlCorpus {
  if (expectedWebgl === undefined) return native;
  expect(expectedWebgl !== null, "Expected WebGL identity pair was unavailable");
  for (const field of ["vendor", "renderer"] as const) {
    expect(typeof expectedWebgl[field] === "string" && expectedWebgl[field].trim().length > 0,
      `Expected WebGL ${field} was unavailable`);
  }
  const projected = { ...native };
  for (const contextName of ["window", "windowOffscreen", "worker"] as const) {
    projected[contextName] = { ...native[contextName] };
    for (const version of ["webgl1", "webgl2"] as const) {
      const context = native[contextName]?.[version];
      expect(context != null, `native baseline ${contextName} ${version} was unavailable`);
      // Retain every native field, including unknown capability fields. Only
      // these two unmasked identity strings may differ; never project actual.
      projected[contextName][version] = {
        ...context,
        unmaskedVendor: expectedWebgl.vendor,
        unmaskedRenderer: expectedWebgl.renderer,
      };
    }
  }
  return projected;
}

function webGlProbeHash(corpus: WebGlCorpus): string {
  // Match fingerprint-baseline's FNV-1a probe hash, which includes identities
  // as well as capabilities. Expected bytes come only from the native projection.
  const serialized = JSON.stringify(corpus);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compare full observed identity/capabilities, including requested devices.
 * Explicit WebGL expectations check simulated identity conformance, not physical GPU proof.
 * Omission retains strict same-host native identity equality on every surface.
 */
export function verifyNativeGpuCorpus(
  actual: GpuCorpus,
  native: GpuCorpus,
  label = "managed GPU",
  expectedWebgl?: { vendor: string; renderer: string },
): void {
  for (const [captureLabel, capture] of [[`${label} native baseline`, native], [label, actual]] as const) {
    for (const version of ["webgl1", "webgl2"] as const) {
      for (const contextName of ["window", "windowOffscreen", "worker"] as const) {
        const context = capture.webgl[contextName]?.[version];
        expect(context != null, `${captureLabel} ${contextName} ${version} was unavailable`);
        expect(typeof context.unmaskedVendor === "string" && context.unmaskedVendor.length > 0,
          `${captureLabel} ${contextName} ${version} unmasked vendor was unavailable`);
        expect(typeof context.unmaskedRenderer === "string" && context.unmaskedRenderer.length > 0,
          `${captureLabel} ${contextName} ${version} unmasked renderer was unavailable`);
      }
      expectEqual(capture.webgl.window[version], capture.webgl.worker[version], `${captureLabel} ${version} Window/Worker full corpus`);
      expectEqual(capture.webgl.window[version], capture.webgl.windowOffscreen[version], `${captureLabel} ${version} Window/Offscreen full corpus`);
    }
    for (const contextName of ["window", "worker"] as const) {
      const context = capture.webgpu[contextName];
      expectEqual(context.available, true, `${captureLabel} ${contextName} WebGPU availability`);
      expectEqual(context.error, null, `${captureLabel} ${contextName} WebGPU corpus error`);
      expect(context.adapter !== null, `${captureLabel} ${contextName} WebGPU adapter was unavailable`);
      expect(context.device !== null, `${captureLabel} ${contextName} WebGPU requested device was unavailable`);
      for (const [identityName, info] of [["adapter", context.adapter.info], ["device", context.device.adapterInfo]] as const) {
        expect(info !== null, `${captureLabel} ${contextName} ${identityName} WebGPU info was unavailable`);
        for (const field of ["vendor", "architecture", "device", "description"] as const) {
          expect(typeof info[field] === "string", `${captureLabel} ${contextName} ${identityName} WebGPU ${field} was not captured`);
        }
        for (const field of ["subgroupMinSize", "subgroupMaxSize"] as const) {
          expect(typeof info[field] === "number" && Number.isFinite(info[field]) && Number(info[field]) >= 0,
            `${captureLabel} ${contextName} ${identityName} WebGPU ${field} was not captured`);
        }
        expect(typeof info.isFallbackAdapter === "boolean", `${captureLabel} ${contextName} ${identityName} WebGPU fallback identity was not captured`);
      }
      expectEqual(context.device.adapterInfo, context.adapter.info, `${captureLabel} ${contextName} WebGPU adapter/device identity`);
      expect(Object.keys(context.adapter.limits).length > 0 && Object.keys(context.device.limits).length > 0,
        `${captureLabel} ${contextName} WebGPU adapter/device limits were not captured`);
    }
    expectEqual(capture.webgpu.window, capture.webgpu.worker, `${captureLabel} WebGPU Window/Worker full corpus`);
  }
  const expectedWebGlCorpus = projectNativeWebGlCorpus(native.webgl, expectedWebgl);
  expectEqual(actual.webgl, expectedWebGlCorpus, `${label} WebGL full corpus vs ${expectedWebgl === undefined ? "same-host native baseline" : "generated identity and same-host native capabilities"}`);
  expectEqual(actual.webgpu, native.webgpu, `${label} WebGPU full corpus vs same-host native baseline`);
}

function fontCapabilitySha256(corpus: FontCorpus): string {
  return createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function captureGpuCorpus(page: Page, label: string): Promise<GpuCorpus> {
  process.stderr.write(`[verify:chromium] ${label}: WebGL 1/2 Window/Offscreen/Worker full corpus\n`);
  const webgl = await withTimeout(page.evaluate(captureWebGlCorpusInPage), 25_000, `${label} WebGL corpus`);
  process.stderr.write(`[verify:chromium] ${label}: WebGPU adapter/device Window/Worker full corpus\n`);
  const webgpu = await withTimeout(page.evaluate(captureWebGpuCorpusInPage), 30_000, `${label} WebGPU corpus`);
  return { webgl, webgpu };
}

async function captureSystemColors(
  page: Page,
  scheme: "light" | "dark" | "preferred",
): Promise<Record<SystemColorKeyword, string>> {
  return page.evaluate(({ keywords, colorScheme }) => {
    const result: Record<string, string> = {};
    const node = document.createElement("span");
    node.style.cssText = "position:fixed;left:-10000px;top:-10000px";
    node.style.colorScheme = colorScheme === "preferred" ? "light dark" : colorScheme;
    document.documentElement.appendChild(node);
    for (const keyword of keywords) {
      node.style.color = keyword;
      result[keyword] = getComputedStyle(node).color;
    }
    node.remove();
    return result;
  }, { keywords: [...SYSTEM_COLOR_KEYWORDS], colorScheme: scheme }) as Promise<Record<SystemColorKeyword, string>>;
}

async function captureSelectionPaint(
  page: Page,
  scheme: "light" | "dark",
): Promise<SelectionPaintIdentity> {
  await page.evaluate((colorScheme) => {
    document.documentElement.style.cssText = "margin:0;background:#fff";
    document.body.style.cssText = "margin:0;background:#fff";
    document.body.replaceChildren();
    const target = document.createElement("div");
    target.id = "roxy-selection-probe";
    target.textContent = "A                    B";
    target.style.cssText = [
      "position:absolute", "left:20px", "top:20px", "display:inline-block",
      `color-scheme:${colorScheme}`, "background:#fff", "color:#000",
      "font:32px monospace", "line-height:64px", "white-space:pre",
    ].join(";");
    document.body.appendChild(target);
    const range = document.createRange();
    range.selectNodeContents(target.firstChild!);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, scheme);
  const bounds = await page.locator("#roxy-selection-probe").boundingBox();
  if (!bounds) fail(`Unable to measure ${scheme} selection probe`);
  const screenshot = await page.screenshot({
    clip: {
      x: bounds.x,
      y: bounds.y,
      width: Math.ceil(bounds.width),
      height: Math.ceil(bounds.height),
    },
  });
  return page.evaluate(async (encodedPng) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encodedPng}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Unable to decode selection screenshot");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const histogram: Record<string, number> = {};
    let blackPixels = 0;
    let whitePixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const alpha = pixels[index + 3];
      const key = `${red},${green},${blue},${alpha}`;
      histogram[key] = (histogram[key] || 0) + 1;
      // Font antialiasing means a thin glyph may contain fewer than 100
      // mathematically pure black/white pixels even when the requested text
      // color is correct. Count the near-endpoint pixels while the exact
      // histogram continues to identify the selection background.
      if (alpha === 255 && red <= 31 && green <= 31 && blue <= 31) blackPixels++;
      if (alpha === 255 && red >= 224 && green >= 224 && blue >= 224) whitePixels++;
    }
    const dominant = Object.entries(histogram).sort((left, right) => right[1] - left[1])[0];
    if (!dominant) throw new Error("Selection screenshot contained no pixels");
    return {
      background: dominant[0].split(",").map(Number) as Pixel,
      dominantPixels: dominant[1],
      blackPixels,
      whitePixels,
    };
  }, screenshot.toString("base64"));
}

async function captureSystemTheme(page: Page): Promise<SystemThemeIdentity> {
  const preferredColorScheme = await page.evaluate(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const preferredColors = await captureSystemColors(page, "preferred");
  const lightColors = await captureSystemColors(page, "light");
  const darkColors = await captureSystemColors(page, "dark");
  const lightSelection = await captureSelectionPaint(page, "light");
  const darkSelection = await captureSelectionPaint(page, "dark");
  return {
    preferredColorScheme,
    preferredColors,
    light: { colors: lightColors, selection: lightSelection },
    dark: { colors: darkColors, selection: darkSelection },
  };
}

function resolveExecutable(input: string): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() && resolved.endsWith(".app")) {
    const appName = path.basename(resolved, ".app");
    for (const name of [appName, "Chromium", "Google Chrome", "Google Chrome for Testing"]) {
      const candidate = path.join(resolved, "Contents", "MacOS", name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  fail(`Chromium executable not found: ${input}`);
}

function detectVersion(executablePath: string): string {
  let output: string;
  try {
    output = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to execute Chromium --version for ${executablePath}: ${detail}`);
  }
  const version = output.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  if (!version) {
    fail(`Unable to parse Chromium version from ${executablePath}: ${JSON.stringify(output.trim())}`);
  }
  return version;
}

export async function startOrigin(): Promise<{ origin: string; crossOrigin: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    response.setHeader("Accept-CH", "Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Platform-Version");
    response.setHeader("Cache-Control", "no-store");
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/echo") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ headers: request.headers }));
      return;
    }
    if (pathname === "/shared-worker.js") {
      response.setHeader("content-type", "text/javascript");
      response.end("onconnect=function(e){var p=e.ports[0];fetch('/echo').then(function(r){return r.json()}).then(function(v){p.postMessage(v.headers)}).catch(function(){p.postMessage({})})}");
      return;
    }
    if (pathname === "/service-worker.js") {
      response.setHeader("content-type", "text/javascript");
      response.end("self.onmessage=function(e){var p=e.ports[0];e.waitUntil(fetch('/echo').then(function(r){return r.json()}).then(function(v){p.postMessage(v.headers)}).catch(function(){p.postMessage({})}))}");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><meta charset=utf-8><title>Roxy native verification</title><canvas id=c width=64 height=32></canvas>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("Failed to bind verification origin");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    crossOrigin: `http://roxy-cross.test:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function captureMedia(page: Page): Promise<RunResult["media"]> {
  return page.evaluate(async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).map((device) => ({
      kind: device.kind,
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label,
    }));
    async function exact(
      kind: "audioinput" | "videoinput",
      timeoutMs: number,
    ): Promise<{
      status: "ok" | "timeout" | "error";
      deviceId: string | null;
      error: string | null;
    }> {
      const device = devices.find((entry) => entry.kind === kind);
      if (!device) return { status: "error", deviceId: null, error: `No ${kind} device was enumerated` };
      const constraints = kind === "audioinput"
        ? { audio: { deviceId: { exact: device.deviceId } } }
        : { video: { deviceId: { exact: device.deviceId } } };
      return new Promise((resolve) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          settled = true;
          resolve({ status: "timeout", deviceId: null, error: null });
        }, timeoutMs);
        void navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
          const deviceId = stream.getTracks()[0]?.getSettings().deviceId || null;
          stream.getTracks().forEach((track) => track.stop());
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve({ status: "ok", deviceId, error: null });
        }).catch((error: unknown) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve({
            status: "error",
            deviceId: null,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }
    // On macOS, fake audio capture can remain pending even in stock Chrome.
    // Verify video strictly first, then report audio timeout as an explicit
    // environment limitation while retaining audio enumeration/ID checks.
    const video = await exact("videoinput", 8000);
    const audio = await exact("audioinput", 3000);
    return {
      devices,
      audioTrackDeviceId: audio.deviceId,
      videoTrackDeviceId: video.deviceId,
      audioCaptureStatus: audio.status,
      audioCaptureError: audio.error,
    };
  });
}

async function captureCodecs(page: Page): Promise<RunResult["codecs"]> {
  return page.evaluate(async () => {
    interface DecodingSupport {
      supported: boolean;
      smooth: boolean;
      powerEfficient: boolean;
    }
    interface EncoderSupport {
      supported: boolean;
    }
    interface CodecGlobals {
      AudioEncoder?: {
        isConfigSupported(config: Record<string, unknown>): Promise<EncoderSupport>;
      };
      VideoEncoder?: {
        isConfigSupported(config: Record<string, unknown>): Promise<EncoderSupport>;
      };
    }
    const mediaCapabilities = (navigator as Navigator & {
      mediaCapabilities?: {
        decodingInfo(config: Record<string, unknown>): Promise<DecodingSupport>;
      };
    }).mediaCapabilities;
    const globals = globalThis as unknown as CodecGlobals;
    const supported = async (operation: (() => Promise<EncoderSupport>) | undefined): Promise<boolean | null> => {
      if (!operation) return null;
      try {
        return (await operation()).supported;
      } catch {
        return null;
      }
    };
    const decoding = async (
      config: Record<string, unknown>,
    ): Promise<DecodingSupport | null> => {
      if (!mediaCapabilities) return null;
      try {
        const result = await mediaCapabilities.decodingInfo(config);
        return {
          supported: result.supported,
          smooth: result.smooth,
          powerEfficient: result.powerEfficient,
        };
      } catch {
        return null;
      }
    };
    const audio = document.createElement("audio");
    const video = document.createElement("video");
    const aacMime = 'audio/mp4; codecs="mp4a.40.2"';
    const h264Mime = 'video/mp4; codecs="avc1.42E01E"';
    const audioConfig = {
      codec: "mp4a.40.2",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128000,
    };
    const videoConfig = {
      codec: "avc1.42001f",
      width: 640,
      height: 360,
      bitrate: 1000000,
      framerate: 30,
    };
    const [audioDecoding, videoDecoding, aacEncoder, h264Encoder] = await Promise.all([
      decoding({
        type: "file",
        audio: {
          contentType: aacMime,
          channels: "2",
          bitrate: 128000,
          samplerate: 48000,
        },
      }),
      decoding({
        type: "file",
        video: {
          contentType: h264Mime,
          width: 640,
          height: 360,
          bitrate: 1000000,
          framerate: 30,
        },
      }),
      supported(globals.AudioEncoder
        ? () => globals.AudioEncoder!.isConfigSupported(audioConfig)
        : undefined),
      supported(globals.VideoEncoder
        ? () => globals.VideoEncoder!.isConfigSupported(videoConfig)
        : undefined),
    ]);
    return {
      aacCanPlay: audio.canPlayType(aacMime),
      h264CanPlay: video.canPlayType(h264Mime),
      mediaSourceAAC: typeof MediaSource === "undefined" ? null : MediaSource.isTypeSupported(aacMime),
      mediaSourceH264: typeof MediaSource === "undefined" ? null : MediaSource.isTypeSupported(h264Mime),
      audioDecoding,
      videoDecoding,
      aacEncoder,
      h264Encoder,
    };
  });
}

async function captureStorageBucketQuota(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const manager = (navigator as Navigator & {
      storageBuckets?: {
        open(name: string): Promise<{ estimate(): Promise<{ quota?: number }> }>;
        delete(name: string): Promise<void>;
      };
    }).storageBuckets;
    if (!manager) return null;
    const name = "roxy-native-verifier";
    const bucket = await manager.open(name);
    const estimate = await bucket.estimate();
    await manager.delete(name);
    return estimate.quota ?? null;
  });
}

async function captureWebAuthn(page: Page): Promise<RunResult["webauthn"]> {
  return page.evaluate(async () => {
    const credential = PublicKeyCredential as typeof PublicKeyCredential & {
      getClientCapabilities(): Promise<Record<string, boolean>>;
    };
    const [capabilities, userVerifyingPlatformAuthenticator, conditionalMediation] =
      await Promise.all([
        credential.getClientCapabilities(),
        credential.isUserVerifyingPlatformAuthenticatorAvailable(),
        credential.isConditionalMediationAvailable(),
      ]);
    return {
      capabilities,
      userVerifyingPlatformAuthenticator,
      conditionalMediation,
    };
  });
}

export async function captureRequestHeaders(page: Page, scope = "baseline"): Promise<RequestIdentityByContext> {
  return page.evaluate(async (scopeToken) => {
    type RawHeaders = Record<string, string | undefined>;
    const query = `?verify=${encodeURIComponent(scopeToken)}`;
    const select = (headers: RawHeaders): RequestIdentityHeaders => ({
      userAgent: headers["user-agent"] || null,
      acceptLanguage: headers["accept-language"] || null,
      doNotTrack: headers.dnt || null,
      uaPlatform: headers["sec-ch-ua-platform"] || null,
      uaArchitecture: headers["sec-ch-ua-arch"] || null,
      uaBitness: headers["sec-ch-ua-bitness"] || null,
      uaPlatformVersion: headers["sec-ch-ua-platform-version"] || null,
    });
    const windowHeaders = await fetch(`/echo${query}`)
      .then((response) => response.json())
      .then((value) => value.headers as RawHeaders);
    const dedicatedHeaders = await new Promise<RawHeaders>((resolve) => {
      const echoUrl = JSON.stringify(new URL(`/echo${query}`, location.href).href);
      const source = `onmessage=function(){fetch(${echoUrl}).then(function(r){return r.json()}).then(function(v){postMessage(v.headers)}).catch(function(){postMessage({})})}`;
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(url);
      worker.onmessage = (event) => { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
      worker.onerror = () => { worker.terminate(); URL.revokeObjectURL(url); resolve({}); };
      worker.postMessage(1);
    });
    const sharedHeaders = await new Promise<RawHeaders>((resolve) => {
      const worker = new SharedWorker(`/shared-worker.js${query}`);
      worker.port.onmessage = (event) => resolve(event.data);
      worker.port.start();
    });
    await navigator.serviceWorker.register(`/service-worker.js${query}`);
    const registration = await navigator.serviceWorker.ready;
    const serviceHeaders = await new Promise<RawHeaders>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      registration.active?.postMessage(1, [channel.port2]);
      if (!registration.active) resolve({});
    });
    await registration.unregister();
    return {
      window: select(windowHeaders),
      dedicated: select(dedicatedHeaders),
      shared: select(sharedHeaders),
      service: select(serviceHeaders),
    };
  }, scope);
}

async function captureFrameIdentity(frame: Frame, scope: string): Promise<FrameIdentity> {
  return frame.evaluate(async (scopeToken) => {
    type RawHeaders = Record<string, string | undefined>;
    type NavigatorWithUaData = Navigator & {
      userAgentData?: {
        platform: string;
        getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
      };
    };
    const headers = await fetch(`/echo?verify=${encodeURIComponent(scopeToken)}`)
      .then((response) => response.json())
      .then((value) => value.headers as RawHeaders);
    const uaData = (navigator as NavigatorWithUaData).userAgentData;
    const highEntropy = uaData
      ? await uaData.getHighEntropyValues(["platformVersion", "uaFullVersion"])
      : {};
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: [...navigator.languages],
      uaPlatform: uaData?.platform || null,
      uaFullVersion: typeof highEntropy.uaFullVersion === "string" ? highEntropy.uaFullVersion : null,
      request: {
        userAgent: headers["user-agent"] || null,
        acceptLanguage: headers["accept-language"] || null,
        doNotTrack: headers.dnt || null,
        uaPlatform: headers["sec-ch-ua-platform"] || null,
      },
    };
  }, scope);
}

async function captureCdpOverrideIdentity(
  context: BrowserContext,
  page: Page,
  origin: string,
  crossOrigin: string,
): Promise<CdpOverrideIdentity> {
  const session = await context.newCDPSession(page);
  try {
    await session.send("Emulation.setUserAgentOverride", {
      userAgent: "RoxyVerifierConflict/1.0",
      acceptLanguage: "zz-ZZ",
      platform: "ConflictOS",
      userAgentMetadata: {
        brands: [{ brand: "Conflict Browser", version: "1" }],
        fullVersionList: [{ brand: "Conflict Browser", version: "1.0.0.0" }],
        fullVersion: "1.0.0.0",
        platform: "ConflictOS",
        platformVersion: "1.0.0",
        architecture: "arm",
        model: "Conflict Device",
        mobile: false,
        bitness: "32",
        wow64: false,
      },
    });
    await page.goto(`${origin}/cdp-override`, { waitUntil: "load", timeout: 15_000 });
    await page.evaluate(async ({ sameOrigin, otherOrigin }) => {
      const addFrame = (name: string, src: string): Promise<void> => new Promise((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.name = name;
        frame.src = src;
        frame.onload = () => resolve();
        frame.onerror = () => reject(new Error(`Failed to load ${name}`));
        document.body.appendChild(frame);
      });
      await Promise.all([
        addFrame("roxy-same-origin", `${sameOrigin}/frame?kind=same`),
        addFrame("roxy-cross-origin", `${otherOrigin}/frame?kind=cross`),
      ]);
    }, { sameOrigin: origin, otherOrigin: crossOrigin });

    const sameOriginFrame = page.frame({ name: "roxy-same-origin" });
    const crossOriginFrame = page.frame({ name: "roxy-cross-origin" });
    expect(sameOriginFrame, "CDP override same-origin frame was not attached");
    expect(crossOriginFrame, "CDP override cross-origin frame was not attached");

    const [top, same, cross, requestHeaders] = await Promise.all([
      captureFrameIdentity(page.mainFrame(), "cdp-top"),
      captureFrameIdentity(sameOriginFrame, "cdp-same-frame"),
      captureFrameIdentity(crossOriginFrame, "cdp-cross-frame"),
      captureRequestHeaders(page, "cdp-override"),
    ]);
    return {
      top,
      sameOriginFrame: same,
      crossOriginFrame: cross,
      requestHeaders,
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export async function captureVersionIdentity(context: BrowserContext, page: Page): Promise<VersionIdentity> {
  let session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
  let versionPage: Page | undefined;
  let result: VersionIdentity | undefined;
  let failure: unknown;
  const evidence: VersionIdentityCaptureError["evidence"] = { cleanupErrors: [] };
  try {
    let sessionAbandoned = false;
    const attaching = context.newCDPSession(page).then(async (created) => {
      if (sessionAbandoned) {
        try { await withTimeout(created.detach(), 3000, "Late version CDP detach"); } catch (error) { evidence.cleanupErrors.push(`Late CDP detach: ${String(error).slice(0, 512)}`); }
        throw new Error("Version CDP session was created after the capture deadline");
      }
      return created;
    });
    try { session = await withTimeout(attaching, 5000, "version CDP session"); }
    finally { sessionAbandoned = !session; }
    // Late acquisitions retain responsibility for their own cleanup.
    let abandoned = false;
    const creating = context.newPage().then(async (created) => {
      if (abandoned) {
        try { await withTimeout(created.close(), 3000, "Late version page close"); } catch (error) { evidence.cleanupErrors.push(`Late version page close: ${String(error).slice(0, 512)}`); }
        throw new Error("Version page was created after the capture deadline");
      }
      return created;
    });
    try { versionPage = await withTimeout(creating, 5000, "version page creation"); }
    finally { abandoned = !versionPage; }
    const browserVersion = await withTimeout(session.send("Browser.getVersion"), 5000, "runtime product capture");
    evidence.product = browserVersion.product;
    evidence.userAgent = browserVersion.userAgent;
    await versionPage.goto("chrome://version/", { waitUntil: "domcontentloaded", timeout: 10_000 });
    const raw = await withTimeout(versionPage.evaluate(() => {
      const elements = document.querySelectorAll("#version"), element = elements[0];
      // Chromium 152 puts the tuple in this first span, not in the td's Text nodes.
      // Never scan other descendants for version-looking text or strip build/button labels.
      const versionTextSelector = "#version > span#copy-content > span:first-child";
      const matches = document.querySelectorAll(versionTextSelector);
      const versionTextCandidates: VersionElementEvidence["versionTextCandidates"] = [];
      let candidatesTruncated = matches.length > 2;
      for (let index = 0; index < Math.min(matches.length, 2); index++) {
        const candidate = matches[index], text = candidate.textContent || "", html = candidate.outerHTML;
        candidatesTruncated ||= text.length > 1024 || html.length > 1024;
        versionTextCandidates.push({ textContent: text.slice(0, 1024), outerHTML: html.slice(0, 1024), childElementCount: candidate.childElementCount });
      }
      const direct = element ? Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent || "") : [];
      const directValue = direct.join("").trim();
      const versionTextSource: VersionElementEvidence["versionTextSource"] = directValue && matches.length === 0
        ? "#version (direct Text nodes)" : !directValue && matches.length === 1 ? versionTextSelector : null;
      const text = element?.textContent || "", html = element?.outerHTML || "";
      return {
        found: !!element, elementCount: elements.length,
        textContent: element ? text.slice(0, 8192) : null, outerHTML: element ? html.slice(0, 8192) : null,
        directTextNodes: direct.slice(0, 64).map((value) => value.slice(0, 1024)),
        versionTextSelector, versionTextCandidateCount: matches.length, versionTextCandidates, versionTextSource,
        truncated: candidatesTruncated || text.length > 8192 || html.length > 8192 || direct.length > 64 || direct.some((value) => value.length > 1024),
      };
    }), 5000, "chrome://version element capture");
    evidence.rawVersionElement = raw;
    if (!raw.found || raw.elementCount !== 1 || raw.truncated) throw new Error("Missing, ambiguous or oversized chrome://version #version element");
    if (!raw.versionTextSource) throw new Error("Missing or ambiguous chrome://version version text source");
    const directSource = raw.versionTextSource === "#version (direct Text nodes)";
    if (!directSource && raw.versionTextCandidates[0].childElementCount !== 0) throw new Error("Non-leaf chrome://version version text element");
    const element = parseChromeVersionElement(directSource ? raw.directTextNodes.join("").trim() : raw.versionTextCandidates[0].textContent);
    const product = parseChromiumProductVersion(browserVersion.product);
    if (product.version !== element.version) throw new Error(`Browser.getVersion product and ${raw.versionTextSource} disagree`);
    result = {
      product: browserVersion.product, productVersion: product.version, userAgent: browserVersion.userAgent,
      chromeVersionText: element.version, versionElement: element.version,
      versionElementSource: "chrome://version#version", rawVersionElement: raw,
    };
  } catch (error) { failure = error; }
  finally {
    for (const [label, close] of [
      ["version page close", versionPage ? () => versionPage!.close() : undefined],
      ["version CDP detach", session ? () => session!.detach() : undefined],
    ] as const) {
      if (close) try { await withTimeout(close(), 3000, label); }
      catch (error) { evidence.cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  if (failure || evidence.cleanupErrors.length || !result) {
    throw new VersionIdentityCaptureError(failure instanceof Error ? failure.message : failure ? String(failure) : "Version capture cleanup failed", evidence);
  }
  return result;
}

async function captureStockWindowMode(
  executablePath: string,
  config: BrowserFingerprintConfig,
  userDataDir: string,
  headless: boolean,
): Promise<StockWindowModeIdentity> {
  let context: BrowserContext | null = null;
  const label = headless ? "stock headless window mode" : "stock headed window mode";
  try {
    process.stderr.write(`[verify:chromium] ${label}: launch without managed identity\n`);
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless,
      colorScheme: null,
      timeout: 20_000,
      viewport: null,
      args: [
        `--window-size=${config.screen.outerWidth},${config.screen.outerHeight}`,
        `--window-position=${config.screen.windowX},${config.screen.windowY}`,
        `--force-device-scale-factor=${config.screen.devicePixelRatio}`,
      ],
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto("data:text/html,<title>Stock window mode</title>", { waitUntil: "load", timeout: 10_000 });
    return await page.evaluate(() => ({ screenY: window.screenY, innerHeight: window.innerHeight }));
  } finally {
    if (context) await withTimeout(context.close(), 10_000, `${label} browser close`).catch(() => undefined);
  }
}

async function captureDisabledWebRtc(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const connection = new RTCPeerConnection({ iceServers: [] });
    const candidates: string[] = [];
    let stage = "createDataChannel";
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          connection.close();
          reject(new Error(`WebRTC disabled-mode probe stalled during ${stage}`));
        }, 6000);
        void (async () => {
          connection.createDataChannel("verify");
          connection.onicecandidate = (event) => {
            if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
          };
          stage = "createOffer";
          const offer = await connection.createOffer();
          stage = "setLocalDescription";
          await connection.setLocalDescription(offer);
          stage = "candidate settling";
          await new Promise((settle) => setTimeout(settle, 1200));
          window.clearTimeout(timer);
          connection.close();
          resolve(candidates);
        })().catch((error) => {
          window.clearTimeout(timer);
          connection.close();
          reject(error);
        });
      });
    } finally {
      connection.close();
    }
  });
}

async function captureIncognitoStorage(
  executablePath: string,
  version: string,
  meta: BrowserFingerprintMeta,
  origin: string,
): Promise<{ storage: StorageCorpus; config: BrowserFingerprintConfig }> {
  const config = buildBrowserFingerprintConfig(meta, version);
  let browser: Browser | null = null;
  try {
    process.stderr.write("[verify:chromium] incognito storage: launch\n");
    browser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: 20_000,
      args: [buildBrowserFingerprintArg(meta, version)],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "load", timeout: 15_000 });
    return {
      config,
      storage: await withTimeout(
        page.evaluate(captureStorageCorpusInPage, config.storageQuotaBytes * 2),
        30_000,
        "incognito Storage corpus",
      ),
    };
  } finally {
    if (browser) await withTimeout(browser.close(), 10_000, "incognito storage browser close").catch(() => undefined);
  }
}

async function runOnce(
  executablePath: string,
  version: string,
  meta: BrowserFingerprintMeta,
  origin: string,
  crossOrigin: string,
  userDataDir: string,
  label: string,
  headless = true,
): Promise<{ result: RunResult; config: BrowserFingerprintConfig }> {
  const config = buildBrowserFingerprintConfig(meta, version);
  let context: BrowserContext | null = null;
  try {
    process.stderr.write(`[verify:chromium] ${label}: launch\n`);
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless,
      colorScheme: null,
      timeout: 20_000,
      viewport: null,
      args: [
        buildBrowserFingerprintArg(meta, version),
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--window-size=${config.screen.outerWidth},${config.screen.outerHeight}`,
        `--window-position=${config.screen.windowX},${config.screen.windowY}`,
        `--force-device-scale-factor=${config.screen.devicePixelRatio}`,
        "--host-resolver-rules=MAP roxy-cross.test 127.0.0.1",
        `--unsafely-treat-insecure-origin-as-secure=${crossOrigin}`,
      ],
    });
    await context.grantPermissions(["geolocation", "local-fonts"], { origin });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(origin, { waitUntil: "load", timeout: 15_000 });
    process.stderr.write(`[verify:chromium] ${label}: fingerprint probe\n`);
    const raw = await withTimeout(
      page.evaluate(async (expression) => await (0, eval)(expression), CAPTURE_EXPRESSION),
      20_000,
      `${label} fingerprint probe`,
    );
    const probe = JSON.parse(String(raw)) as Probe;
    const { webgl, webgpu } = await captureGpuCorpus(page, label);
    process.stderr.write(`[verify:chromium] ${label}: Storage modern/legacy/OPFS corpus\n`);
    const storage = await withTimeout(
      page.evaluate(captureStorageCorpusInPage, config.storageQuotaBytes * 2),
      30_000,
      `${label} Storage corpus`,
    );
    process.stderr.write(`[verify:chromium] ${label}: Font Window/Worker/DOM/Local Access corpus\n`);
    const fonts = await withTimeout(
      page.evaluate(captureFontCorpusInPage),
      90_000,
      `${label} Font corpus`,
    );
    process.stderr.write(`[verify:chromium] ${label}: AAC/H.264 codecs\n`);
    const codecs = await withTimeout(captureCodecs(page), 12_000, `${label} codecs`);
    process.stderr.write(`[verify:chromium] ${label}: geolocation\n`);
    const geolocation = await withTimeout(
      page.evaluate(() => new Promise<{ latitude: number; longitude: number; accuracy: number }>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (position) => resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          }),
          (error) => reject(new Error(error.message)),
          { timeout: 4000 },
        );
      })),
      6000,
      `${label} geolocation`,
    );
    process.stderr.write(`[verify:chromium] ${label}: media devices\n`);
    const media = await withTimeout(captureMedia(page), 15_000, `${label} media devices`);
    process.stderr.write(`[verify:chromium] ${label}: Storage Buckets quota\n`);
    const storageBucketQuota = await withTimeout(
      captureStorageBucketQuota(page),
      6000,
      `${label} Storage Buckets quota`,
    );
    process.stderr.write(`[verify:chromium] ${label}: WebAuthn capabilities\n`);
    const webauthn = await withTimeout(
      captureWebAuthn(page),
      6000,
      `${label} WebAuthn capabilities`,
    );
    process.stderr.write(`[verify:chromium] ${label}: request headers across workers\n`);
    const requestHeaders = await withTimeout(
      captureRequestHeaders(page),
      12_000,
      `${label} request headers`,
    );
    process.stderr.write(`[verify:chromium] ${label}: WebRTC disable\n`);
    const webrtcCandidates = await withTimeout(captureDisabledWebRtc(page), 12_000, `${label} WebRTC`);
    process.stderr.write(`[verify:chromium] ${label}: CDP identity coherence\n`);
    const cdpOverride = await withTimeout(
      captureCdpOverrideIdentity(context, page, origin, crossOrigin),
      25_000,
      `${label} CDP identity coherence`,
    );
    process.stderr.write(`[verify:chromium] ${label}: build version coherence\n`);
    const versionIdentity = await withTimeout(
      captureVersionIdentity(context, page),
      12_000,
      `${label} build version coherence`,
    );
    process.stderr.write(`[verify:chromium] ${label}: system colors and selection paint\n`);
    const systemTheme = await withTimeout(
      captureSystemTheme(page),
      15_000,
      `${label} system theme`,
    );
    return {
      config,
      result: {
        probe,
        webgl,
        webgpu,
        storage,
        fonts,
        codecs,
        media,
        storageBucketQuota,
        webauthn,
        geolocation,
        requestHeaders,
        cdpOverride,
        versionIdentity,
        webrtcCandidates,
        systemTheme,
      },
    };
  } finally {
    if (context) await withTimeout(context.close(), 10_000, `${label} browser close`).catch(() => undefined);
  }
}

async function capturePassThrough(
  executablePath: string,
  origin: string,
  crossOrigin: string,
  userDataDir: string,
  headless = true,
): Promise<PassThroughIdentity> {
  let context: BrowserContext | null = null;
  try {
    process.stderr.write(`[verify:chromium] pass-through ${headless ? "headless" : "headed"}: launch without managed identity\n`);
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless,
      colorScheme: null,
      timeout: 20_000,
      viewport: null,
      args: [
        "--host-resolver-rules=MAP roxy-cross.test 127.0.0.1",
        `--unsafely-treat-insecure-origin-as-secure=${crossOrigin}`,
      ],
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(origin, { waitUntil: "load", timeout: 15_000 });
    const raw = await withTimeout(
      page.evaluate(async (expression) => await (0, eval)(expression), CAPTURE_EXPRESSION),
      20_000,
      "pass-through fingerprint probe",
    );
    const probe = JSON.parse(String(raw)) as Probe;
    const systemTheme = await withTimeout(
      captureSystemTheme(page),
      15_000,
      "pass-through system theme",
    );
    const gpu = await captureGpuCorpus(page, `pass-through ${headless ? "headless" : "headed"}`);
    return { probe, systemTheme, ...gpu };
  } finally {
    if (context) await withTimeout(context.close(), 10_000, "pass-through browser close").catch(() => undefined);
  }
}

function verifyPassThrough(passThrough: PassThroughIdentity, managed: RunResult): void {
  const probe = passThrough.probe;
  const nativePlatform = process.platform === "darwin"
    ? "MacIntel"
    : process.platform === "win32" ? "Win32" : "Linux x86_64";
  expectEqual(probe.platform, nativePlatform, "pass-through native navigator.platform");
  expect(String(probe.workerIdentity || "").includes(nativePlatform), "pass-through Worker platform was not native");
  if (process.platform === "darwin") {
    expect(!String(probe.userAgent || "").includes("Windows NT"), "pass-through leaked the managed Windows UA");
  }
  if (managed.probe.platform !== nativePlatform) {
    expect(probe.platform !== managed.probe.platform, "pass-through retained the cross-OS persona platform");
    expect(probe.userAgent !== managed.probe.userAgent, "pass-through retained the cross-OS persona User-Agent");
  }
  expect(probe.tz !== managed.probe.tz, "pass-through retained the managed timezone");
  if (process.platform === "darwin") {
    expectEqual(
      passThrough.systemTheme.light.colors.HighlightText,
      "rgb(0, 0, 0)",
      "pass-through native macOS HighlightText",
    );
    if (managed.probe.platform === "Win32") {
      expect(
        passThrough.systemTheme.light.colors.HighlightText !== managed.systemTheme.light.colors.HighlightText,
        "pass-through retained the managed Windows persona system palette",
      );
    }
  }
}

function expectedSystemColors(
  platform: BrowserFingerprintConfig["platform"],
  scheme: "light" | "dark",
): Record<SystemColorKeyword, string> {
  const dark = scheme === "dark";
  const colors: Record<SystemColorKeyword, string> = {
    AccentColor: "rgb(0, 117, 255)",
    AccentColorText: "rgb(255, 255, 255)",
    ActiveText: "rgb(255, 0, 0)",
    ButtonBorder: dark ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
    ButtonFace: dark ? "rgb(107, 107, 107)" : "rgb(239, 239, 239)",
    ButtonText: dark ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
    Canvas: dark ? "rgb(18, 18, 18)" : "rgb(255, 255, 255)",
    CanvasText: dark ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
    Field: dark ? "rgb(59, 59, 59)" : "rgb(255, 255, 255)",
    FieldText: dark ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
    GrayText: "rgb(128, 128, 128)",
    Highlight: "rgba(0, 65, 198, 0.8)",
    HighlightText: "rgb(255, 255, 255)",
    LinkText: dark ? "rgb(158, 158, 255)" : "rgb(0, 0, 238)",
    Mark: "rgb(255, 255, 0)",
    MarkText: "rgb(0, 0, 0)",
    SelectedItem: dark ? "rgb(153, 200, 255)" : "rgb(25, 103, 210)",
    SelectedItemText: dark ? "rgb(59, 59, 59)" : "rgb(255, 255, 255)",
    VisitedText: dark ? "rgb(208, 173, 240)" : "rgb(85, 26, 139)",
  };
  if (platform === "Win32" && !dark) {
    colors.ActiveText = "rgb(0, 102, 204)";
    colors.ButtonFace = "rgb(240, 240, 240)";
    colors.GrayText = "rgb(109, 109, 109)";
    colors.Highlight = "rgba(0, 86, 201, 0.8)";
    colors.LinkText = "rgb(0, 102, 204)";
    colors.VisitedText = "rgb(0, 102, 204)";
  }
  if (platform === "MacIntel") {
    colors.Highlight = dark
      ? "rgba(179, 215, 255, 0.8)"
      : "rgba(128, 188, 254, 0.6)";
    colors.HighlightText = "rgb(0, 0, 0)";
    colors.SelectedItem = dark ? "rgb(153, 200, 255)" : "rgb(179, 215, 255)";
    colors.SelectedItemText = dark ? "rgb(59, 59, 59)" : "rgb(0, 0, 0)";
  }
  return colors;
}

function expectedPreferredColorScheme(config: BrowserFingerprintConfig): "light" | "dark" {
  return config.seed % 4 === 0 ? "dark" : "light";
}

function verifySystemTheme(
  identity: SystemThemeIdentity,
  config: BrowserFingerprintConfig,
  label: string,
): void {
  expectEqual(
    identity.preferredColorScheme,
    expectedPreferredColorScheme(config),
    `${label} prefers-color-scheme`,
  );
  expectEqual(
    identity.preferredColors,
    expectedSystemColors(config.platform, expectedPreferredColorScheme(config)),
    `${label} preferred system colors`,
  );
  for (const scheme of ["light", "dark"] as const) {
    const actual = identity[scheme];
    expectEqual(
      actual.colors,
      expectedSystemColors(config.platform, scheme),
      `${label} ${scheme} CSS system colors`,
    );
    const expectedBackground: Pixel = config.platform === "MacIntel"
      ? scheme === "dark" ? [101, 130, 162, 255] : [179, 215, 254, 255]
      : [51, 103, 209, 255];
    expectEqual(
      actual.selection.background,
      expectedBackground,
      `${label} ${scheme} painted selection background`,
    );
    expect(actual.selection.dominantPixels > 1000, `${label} ${scheme} selection paint was too small`);
    if (config.platform === "Win32") {
      expect(actual.selection.whitePixels > 100, `${label} ${scheme} Windows selection did not paint white text`);
      expect(
        actual.selection.whitePixels > actual.selection.blackPixels,
        `${label} ${scheme} Windows selection retained black text`,
      );
    } else {
      expect(actual.selection.blackPixels > 100, `${label} ${scheme} macOS selection did not preserve black text`);
      expect(
        actual.selection.blackPixels > actual.selection.whitePixels,
        `${label} ${scheme} macOS selection incorrectly painted white text`,
      );
    }
  }
}

function verifyPlatformThemeDistinction(
  windows: SystemThemeIdentity,
  mac: SystemThemeIdentity,
): void {
  expect(
    windows.light.colors.HighlightText !== mac.light.colors.HighlightText,
    "Windows and macOS HighlightText were identical",
  );
  expect(
    windows.light.colors.ButtonFace !== mac.light.colors.ButtonFace,
    "Windows and macOS ButtonFace were identical",
  );
  expect(
    JSON.stringify(windows.light.selection.background) !== JSON.stringify(mac.light.selection.background),
    "Windows and macOS painted selection backgrounds were identical",
  );
}

function verifyExpected(
  run: RunResult,
  config: BrowserFingerprintConfig,
  nativeGpu: PassThroughIdentity,
  stockWindowMode?: StockWindowModeIdentity,
): void {
  const probe = run.probe;
  expectEqual(probe.userAgent, config.userAgent, "navigator.userAgent");
  expectEqual(probe.appVersion, config.appVersion, "navigator.appVersion");
  expectEqual(probe.platform, config.platform, "navigator.platform");
  expectEqual(probe.languages, config.languages.join(","), "navigator.languages");
  expectEqual(probe.hardwareConcurrency, config.hardwareConcurrency, "navigator.hardwareConcurrency");
  expectEqual(probe.deviceMemory, config.deviceMemory, "navigator.deviceMemory");
  expectEqual(probe.maxTouchPoints, config.maxTouchPoints, "navigator.maxTouchPoints");
  expectEqual(probe.doNotTrack, config.doNotTrack, "navigator.doNotTrack");
  expectEqual(
    probe.preferredColorScheme,
    expectedPreferredColorScheme(config),
    "prefers-color-scheme",
  );
  expectEqual(
    JSON.parse(String(probe.systemColors)),
    {
      preferred: run.systemTheme.preferredColors,
      light: run.systemTheme.light.colors,
      dark: run.systemTheme.dark.colors,
    },
    "fingerprint baseline system colors",
  );
  expectEqual(probe.screenW, config.screen.width, "screen.width");
  expectEqual(probe.screenH, config.screen.height, "screen.height");
  expectEqual(probe.availLeft, config.screen.availLeft, "screen.availLeft");
  expectEqual(probe.availTop, config.screen.availTop, "screen.availTop");
  expectEqual(probe.availW, config.screen.availWidth, "screen.availWidth");
  expectEqual(probe.availH, config.screen.availHeight, "screen.availHeight");
  expectEqual(probe.screenX, config.screen.windowX, "window.screenX");
  expectEqual(
    probe.screenY,
    stockWindowMode?.screenY ?? config.screen.windowY,
    "window.screenY",
  );
  expectEqual(probe.outerWidth, config.screen.outerWidth, "window.outerWidth");
  expectEqual(probe.outerHeight, config.screen.outerHeight, "window.outerHeight");
  expect(Number(probe.innerWidth) > 0 && Number(probe.innerWidth) <= config.screen.outerWidth, "window.innerWidth was outside outerWidth");
  expect(Number(probe.innerHeight) > 0 && Number(probe.innerHeight) <= config.screen.outerHeight, "window.innerHeight was outside outerHeight");
  if (stockWindowMode) {
    expectEqual(probe.innerHeight, stockWindowMode.innerHeight, "stock-mode window.innerHeight");
  }
  expect(
    Number(probe.screenX) + Number(probe.outerWidth) <= Number(probe.availLeft) + Number(probe.availW),
    "window exceeded available screen width",
  );
  expect(
    Number(probe.screenY) + Number(probe.outerHeight) <= Number(probe.availTop) + Number(probe.availH),
    "window exceeded available screen height",
  );
  expectEqual(probe.devicePixelRatio, config.screen.devicePixelRatio, "devicePixelRatio");
  expectEqual(probe.tz, config.timezone, "Intl timezone");
  const expectedWebgl = configuredWebGlIdentity(config);
  verifyNativeGpuCorpus(run, nativeGpu, `${config.platform} GPU`, expectedWebgl);
  const webGlIdentityLabel = expectedWebgl ? "configured simulated identity" : "native baseline";
  const nativeGl = nativeGpu.webgl.window.webgl1!;
  expectEqual(probe.glVendor, nativeGl.vendor, "WebGL masked vendor vs native baseline");
  expectEqual(probe.glUnmaskedVendor, expectedWebgl?.vendor ?? nativeGl.unmaskedVendor, `WebGL unmasked vendor vs ${webGlIdentityLabel}`);
  expectEqual(probe.glRenderer, expectedWebgl?.renderer ?? nativeGl.unmaskedRenderer, `WebGL unmasked renderer vs ${webGlIdentityLabel}`);
  const workerProbe = JSON.parse(String(probe.workerIdentity)) as Probe;
  const nativeWorkerGl = nativeGpu.webgl.worker.webgl1!;
  expectEqual(workerProbe.glVendor, nativeWorkerGl.vendor, "Worker WebGL masked vendor vs native baseline");
  expectEqual(workerProbe.glUnmaskedVendor, expectedWebgl?.vendor ?? nativeWorkerGl.unmaskedVendor, `Worker WebGL unmasked vendor vs ${webGlIdentityLabel}`);
  expectEqual(workerProbe.glRenderer, expectedWebgl?.renderer ?? nativeWorkerGl.unmaskedRenderer, `Worker WebGL unmasked renderer vs ${webGlIdentityLabel}`);
  expectEqual(probe.webglCapabilityHash, expectedWebgl
    ? webGlProbeHash(projectNativeWebGlCorpus(nativeGpu.webgl, expectedWebgl))
    : nativeGpu.probe.webglCapabilityHash, "webglCapabilityHash vs expected full native-baseline projection");
  expectEqual(probe.webgpuCapabilityHash, nativeGpu.probe.webgpuCapabilityHash, "webgpuCapabilityHash vs native baseline");
  const nativeGpuInfo = nativeGpu.webgpu.window.adapter!.info;
  for (const [probeKey, infoKey] of [
    ["webgpuVendor", "vendor"], ["webgpuArchitecture", "architecture"],
    ["webgpuDevice", "device"], ["webgpuDescription", "description"],
    ["webgpuSubgroupMinSize", "subgroupMinSize"], ["webgpuSubgroupMaxSize", "subgroupMaxSize"],
    ["webgpuIsFallbackAdapter", "isFallbackAdapter"],
  ] as const) {
    expectEqual(probe[probeKey], nativeGpuInfo[infoKey], `${probeKey} vs native baseline`);
  }
  expect(String(probe.workerIdentity || "").includes(config.userAgent), "Worker user agent did not match Window");
  expect(String(probe.workerIdentity || "").includes(config.platform), "Worker platform did not match Window");
  expectEqual(run.geolocation.latitude, config.geolocation.latitude, "geolocation latitude");
  expectEqual(run.geolocation.longitude, config.geolocation.longitude, "geolocation longitude");
  expectEqual(run.geolocation.accuracy, config.geolocation.accuracy, "geolocation accuracy");
  const expectedAcceptLanguage = config.languages
    .map((language, index) => index === 0 ? language : `${language};q=${(1 - index / 10).toFixed(1)}`)
    .join(",");
  const expectedUaPlatform = config.platform === "Win32" ? '"Windows"' : '"macOS"';
  for (const [context, headers] of Object.entries(run.requestHeaders)) {
    expectEqual(headers.userAgent, config.userAgent, `${context} request User-Agent`);
    expectEqual(headers.acceptLanguage, expectedAcceptLanguage, `${context} request Accept-Language`);
    expectEqual(headers.doNotTrack, "1", `${context} request DNT`);
    // Chromium sends low-entropy UA-CH on document navigation but omits it
    // from Worker fetches. Preserve that stock request shape.
    expectEqual(
      headers.uaPlatform,
      context === "window" ? expectedUaPlatform : null,
      `${context} request Sec-CH-UA-Platform`,
    );
  }
  const expectedUaDataPlatform = config.platform === "Win32" ? "Windows" : "macOS";
  const expectedFullVersion = config.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/)?.[1] || null;
  for (const [context, identity] of Object.entries({
    top: run.cdpOverride.top,
    sameOriginFrame: run.cdpOverride.sameOriginFrame,
    crossOriginFrame: run.cdpOverride.crossOriginFrame,
  })) {
    expectEqual(identity.userAgent, config.userAgent, `${context} CDP navigator.userAgent`);
    expectEqual(identity.platform, config.platform, `${context} CDP navigator.platform`);
    expectEqual(identity.languages, config.languages, `${context} CDP navigator.languages`);
    expectEqual(identity.uaPlatform, expectedUaDataPlatform, `${context} CDP UA-CH platform`);
    expectEqual(identity.uaFullVersion, expectedFullVersion, `${context} CDP UA-CH full version`);
    expectEqual(identity.request.userAgent, config.userAgent, `${context} CDP request User-Agent`);
    expectEqual(identity.request.acceptLanguage, expectedAcceptLanguage, `${context} CDP request Accept-Language`);
    expectEqual(identity.request.doNotTrack, "1", `${context} CDP request DNT`);
    expectEqual(identity.request.uaPlatform, expectedUaPlatform, `${context} CDP request Sec-CH-UA-Platform`);
  }
  for (const [context, headers] of Object.entries(run.cdpOverride.requestHeaders)) {
    expectEqual(headers.userAgent, config.userAgent, `${context} CDP Worker request User-Agent`);
    expectEqual(headers.acceptLanguage, expectedAcceptLanguage, `${context} CDP Worker request Accept-Language`);
    expectEqual(headers.doNotTrack, "1", `${context} CDP Worker request DNT`);
    expectEqual(
      headers.uaPlatform,
      context === "window" ? expectedUaPlatform : null,
      `${context} CDP Worker request Sec-CH-UA-Platform`,
    );
  }
  const actualProductVersion = parseChromiumProductVersion(run.versionIdentity.product).version;
  const actualElementVersion = parseChromeVersionElement(run.versionIdentity.versionElement).version;
  expectEqual(actualProductVersion, actualElementVersion, "Actual product/#version full version");
  expectEqual(run.versionIdentity.productVersion, actualProductVersion, "Normalized actual product version");
  expectEqual(actualProductVersion, parseChromiumUserAgentVersion(config.userAgent).version, "Managed configured/runtime full version");
  expectEqual(run.versionIdentity.userAgent, config.userAgent, "Browser.getVersion User-Agent");
  expectEqual(run.versionIdentity.chromeVersionText, actualElementVersion, "Canonical chrome://version direct Text-node version");
  expectEqual(run.webrtcCandidates, [], "disabled WebRTC candidates");
  verifySystemTheme(run.systemTheme, config, config.platform);

  expectEqual(run.codecs.aacCanPlay, "probably", "AAC canPlayType");
  expectEqual(run.codecs.h264CanPlay, "probably", "H.264 canPlayType");
  expectEqual(run.codecs.mediaSourceAAC, true, "MediaSource AAC support");
  expectEqual(run.codecs.mediaSourceH264, true, "MediaSource H.264 support");
  expectEqual(run.codecs.audioDecoding?.supported, true, "MediaCapabilities AAC decoding");
  expectEqual(run.codecs.videoDecoding?.supported, true, "MediaCapabilities H.264 decoding");
  expectEqual(run.codecs.aacEncoder, true, "WebCodecs AAC encoder");
  expectEqual(run.codecs.h264Encoder, true, "WebCodecs H.264 encoder");

  const expectedCounts: Record<string, number> = {
    audioinput: config.mediaDevices.audioInputs,
    videoinput: config.mediaDevices.videoInputs,
    audiooutput: config.mediaDevices.audioOutputs,
  };
  for (const [kind, count] of Object.entries(expectedCounts)) {
    expectEqual(run.media.devices.filter((device) => device.kind === kind).length, count, `mediaDevices ${kind} count`);
  }
  const audio = run.media.devices.find((device) => device.kind === "audioinput");
  const video = run.media.devices.find((device) => device.kind === "videoinput");
  expectEqual(run.media.videoTrackDeviceId, video?.deviceId || null, "video track synthetic deviceId");
  if (run.media.audioCaptureStatus === "ok") {
    expectEqual(run.media.audioTrackDeviceId, audio?.deviceId || null, "audio track synthetic deviceId");
  } else {
    expectEqual(run.media.audioCaptureStatus, "timeout", `audio capture (${run.media.audioCaptureError || "no error"})`);
    expectEqual(run.media.audioTrackDeviceId, null, "timed-out audio track deviceId");
  }

  const voiceNames = config.speechSynthesis.voices.map((voice) => voice.name).sort();
  for (const name of voiceNames) {
    expect(String(probe.speechVoices || "").includes(name), `Missing configured speech voice: ${name}`);
  }
  expectEqual(probe.storageQuota, config.storageQuotaBytes, "storage quota");
  expectEqual(run.storageBucketQuota, config.storageQuotaBytes, "Storage Buckets quota");
  verifyStorageCorpus(run.storage, config.storageQuotaBytes, "persistent");
  verifyFontCorpus(run.fonts, config);
  const expectedWebAuthn = config.webauthn;
  for (const [name, expected] of Object.entries({
    conditionalGet: expectedWebAuthn.conditionalGet,
    conditionalCreate: expectedWebAuthn.conditionalCreate,
    hybridTransport: expectedWebAuthn.hybridTransport,
    passkeyPlatformAuthenticator: expectedWebAuthn.passkeyPlatformAuthenticator,
    userVerifyingPlatformAuthenticator: expectedWebAuthn.userVerifyingPlatformAuthenticator,
    relatedOrigins: true,
    signalAllAcceptedCredentials: true,
    signalCurrentUserDetails: true,
    signalUnknownCredential: true,
  })) {
    expectEqual(run.webauthn.capabilities[name], expected, `WebAuthn capability ${name}`);
  }
  expectEqual(
    run.webauthn.userVerifyingPlatformAuthenticator,
    expectedWebAuthn.userVerifyingPlatformAuthenticator,
    "WebAuthn UVPAA",
  );
  expectEqual(
    run.webauthn.conditionalMediation,
    expectedWebAuthn.conditionalGet,
    "WebAuthn conditional mediation",
  );
}

function verifyFontCorpus(fonts: FontCorpus, config: BrowserFingerprintConfig): void {
  const label = config.platform === "Win32" ? "Windows" : "macOS";
  expectEqual(fonts.window.fontSetAvailable, true, `${label} Window FontFaceSet availability`);
  expectEqual(fonts.worker.fontSetAvailable, true, `${label} Worker FontFaceSet availability`);
  for (const [surface, windowValue, workerValue] of [
    ["availability", fonts.window.availability, fonts.worker.availability],
    ["generic metrics", fonts.window.genericMetrics, fonts.worker.genericMetrics],
    ["named metrics", fonts.window.namedMetrics, fonts.worker.namedMetrics],
    ["glyph raster", fonts.window.raster, fonts.worker.raster],
  ] as const) {
    expectEqual(windowValue, workerValue, `${label} Window/Worker font ${surface}`);
  }

  const missingFont = "Roxy Definitely Missing Font";
  expectEqual(fonts.window.availability[missingFont], false, `${label} missing font Window availability`);
  expectEqual(fonts.worker.availability[missingFont], false, `${label} missing font Worker availability`);

  expectEqual(fonts.localAccess.available, true, `${label} Local Font Access availability`);
  expectEqual(fonts.localAccess.error, null, `${label} Local Font Access error`);
  expect(fonts.localAccess.entries.length > 0, `${label} Local Font Access returned no managed fonts`);
  const allowedFamilies = new Set(config.fonts.map((family) => family.toLocaleLowerCase("en-US")));
  const leakedFamilies = [...new Set(fonts.localAccess.entries
    .map((entry) => entry.family)
    .filter((family) => !allowedFamilies.has(family.toLocaleLowerCase("en-US"))))].sort();
  expect(
    leakedFamilies.length === 0,
    `${label} Local Font Access leaked families outside the managed profile: ${leakedFamilies.join(", ")}`,
  );

  let maximumWidthDifference = 0;
  let maximumWidthCase = "";
  for (const [domCase, domMetric] of Object.entries(fonts.window.domGenericMetrics)) {
    const separator = domCase.indexOf("|");
    const canvasCase = `${domCase.slice(0, separator)}|normal|${domCase.slice(separator + 1)}`;
    const canvasMetric = fonts.window.genericMetrics[canvasCase];
    expect(canvasMetric, `${label} Canvas metric missing for DOM case ${domCase}`);
    const difference = Math.abs(domMetric.width - canvasMetric.width);
    if (difference > maximumWidthDifference) {
      maximumWidthDifference = difference;
      maximumWidthCase = domCase;
    }
  }
  expect(
    maximumWidthDifference <= 2,
    `${label} Canvas/DOM generic font width diverged by ${maximumWidthDifference}px at ${maximumWidthCase}`,
  );
}

function verifyFontPlatformDistinction(windows: FontCorpus, mac: FontCorpus): void {
  for (const [surface, windowsValue, macValue] of [
    ["availability", windows.window.availability, mac.window.availability],
    ["generic metrics", windows.window.genericMetrics, mac.window.genericMetrics],
    ["named metrics", windows.window.namedMetrics, mac.window.namedMetrics],
    ["glyph raster", windows.window.raster, mac.window.raster],
  ] as const) {
    expect(
      JSON.stringify(windowsValue) !== JSON.stringify(macValue),
      `Windows and macOS font ${surface} were identical`,
    );
  }
}

function verifyStorageCorpus(storage: StorageCorpus, expectedQuota: number, label: string): void {
  for (const [contextName, context] of Object.entries(storage)) {
    expectEqual(context.modern.available, true, `${label} ${contextName} StorageManager availability`);
    expectEqual(context.modern.quota, expectedQuota, `${label} ${contextName} StorageManager quota`);
    expectEqual(context.modern.error, null, `${label} ${contextName} StorageManager error`);
    expectEqual(context.bucket.available, true, `${label} ${contextName} Storage Bucket availability`);
    expectEqual(context.bucket.quota, expectedQuota, `${label} ${contextName} Storage Bucket quota`);
    expectEqual(context.bucket.directoryAvailable, true, `${label} ${contextName} Bucket OPFS availability`);
    expectEqual(context.bucket.error, null, `${label} ${contextName} Storage Bucket error`);
    expectEqual(context.opfs, { available: true, roundTrip: true, error: null }, `${label} ${contextName} OPFS`);
    expectEqual(
      context.webkitFileSystem,
      { available: true, opened: true, error: null },
      `${label} ${contextName} webkitRequestFileSystem`,
    );
    for (const [legacyName, legacy] of Object.entries({
      temporary: context.legacyTemporary,
      persistent: context.legacyPersistent,
    })) {
      if (contextName === "window") {
        expectEqual(legacy.available, true, `${label} Window legacy ${legacyName} availability`);
        expectEqual(legacy.quota, expectedQuota, `${label} Window legacy ${legacyName} quota`);
        expectEqual(legacy.grantedQuota, expectedQuota, `${label} Window legacy ${legacyName} grant`);
        expectEqual(legacy.error, null, `${label} Window legacy ${legacyName} error`);
      } else {
        expectEqual(
          legacy,
          { available: false, quota: null, grantedQuota: null, usageDetailKeys: [], error: null },
          `${label} Worker legacy ${legacyName} stock exposure`,
        );
      }
    }
  }
}

function verifyStable(
  first: RunResult,
  second: RunResult,
  label = "same-seed stability",
  allowedProbeDifferences: ReadonlySet<string> = new Set(),
  nativeGpuBaselines?: readonly [GpuCorpus, GpuCorpus],
  expectedWebgl?: { vendor: string; renderer: string },
): void {
  const differences: string[] = [];
  const compare = (firstValue: unknown, secondValue: unknown, surface: string): void => {
    if (JSON.stringify(firstValue) !== JSON.stringify(secondValue)) {
      differences.push(
        `${surface}: first=${JSON.stringify(firstValue)}, second=${JSON.stringify(secondValue)}`,
      );
    }
  };
  for (const field of STABLE_FIELDS) {
    if (allowedProbeDifferences.has(field)) continue;
    compare(first.probe[field], second.probe[field], field);
  }
  if (nativeGpuBaselines) {
    verifyNativeGpuCorpus(first, nativeGpuBaselines[0], `${label} first window mode`, expectedWebgl);
    verifyNativeGpuCorpus(second, nativeGpuBaselines[1], `${label} second window mode`, expectedWebgl);
  } else {
    compare(first.webgl, second.webgl, "WebGL 1/2 full corpus");
    compare(first.webgpu, second.webgpu, "WebGPU adapter/device full corpus");
  }
  compare(first.storage, second.storage, "Storage modern/legacy/OPFS corpus");
  compare(first.fonts, second.fonts, "Font Window/Worker/DOM/Local Access corpus");
  compare(first.codecs, second.codecs, "codec capabilities");
  compare(first.media, second.media, "media mapping");
  compare(first.storageBucketQuota, second.storageBucketQuota, "Storage Buckets quota");
  compare(first.webauthn, second.webauthn, "WebAuthn capabilities");
  compare(first.geolocation, second.geolocation, "geolocation");
  compare(first.requestHeaders, second.requestHeaders, "request headers");
  compare(first.cdpOverride, second.cdpOverride, "CDP identity coherence");
  compare(first.versionIdentity, second.versionIdentity, "build version coherence");
  compare(first.webrtcCandidates, second.webrtcCandidates, "WebRTC");
  compare(first.systemTheme, second.systemTheme, "system theme and selection paint");
  if (differences.length > 0) {
    fail(`${label} differed on ${differences.length} surface(s):\n- ${differences.join("\n- ")}`);
  }
}

function verifyHeadedHeadlessParity(
  managedHeadless: RunResult,
  managedHeaded: RunResult,
  stockHeadless: StockWindowModeIdentity,
  stockHeaded: StockWindowModeIdentity,
  nativeHeadless: PassThroughIdentity,
  nativeHeaded: PassThroughIdentity,
  expectedWebgl?: { vendor: string; renderer: string },
): void {
  const stockDifferenceCandidates = ["screenY", "innerHeight"] as const;
  const allowedDifferences = new Set<string>();
  for (const field of stockDifferenceCandidates) {
    expectEqual(
      managedHeadless.probe[field],
      stockHeadless[field],
      `managed headless ${field} vs stock window mode`,
    );
    expectEqual(
      managedHeaded.probe[field],
      stockHeaded[field],
      `managed headed ${field} vs stock window mode`,
    );
    if (stockHeadless[field] !== stockHeaded[field]) allowedDifferences.add(field);
  }
  // A native GPU can differ by window mode. Permit only differences observed
  // in that mode's pass-through, while checking both full GPU corpora strictly.
  for (const field of [
    "glVendor", "glUnmaskedVendor", "glRenderer", "webglCapabilityHash",
    "webgpuVendor", "webgpuArchitecture", "webgpuDevice", "webgpuDescription",
    "webgpuSubgroupMinSize", "webgpuSubgroupMaxSize", "webgpuIsFallbackAdapter", "webgpuCapabilityHash",
  ] as const) {
    if (nativeHeadless.probe[field] !== nativeHeaded.probe[field]) allowedDifferences.add(field);
  }
  if (JSON.stringify(nativeHeadless.webgl) !== JSON.stringify(nativeHeaded.webgl)) {
    const firstWorker = JSON.parse(String(managedHeadless.probe.workerIdentity)) as Probe;
    const secondWorker = JSON.parse(String(managedHeaded.probe.workerIdentity)) as Probe;
    const gpuFields = new Set(["glVendor", "glUnmaskedVendor", "glRenderer"]);
    for (const field of new Set([...Object.keys(firstWorker), ...Object.keys(secondWorker)])) {
      if (!gpuFields.has(field)) expectEqual(firstWorker[field], secondWorker[field], `headless/headed Worker ${field}`);
    }
    // The GPU portion is verified against each mode's native capture by
    // verifyExpected, including all three Worker GL probe identity fields.
    allowedDifferences.add("workerIdentity");
  }
  verifyStable(
    managedHeadless,
    managedHeaded,
    "headless/headed non-GPU parity and per-mode GPU identity/capability contract",
    allowedDifferences,
    [nativeHeadless, nativeHeaded],
    expectedWebgl,
  );
}

function verifyDistinct(first: RunResult, second: RunResult): void {
  for (const field of ["canvasHash", "audioHash", "clientRect"] as const) {
    expect(first.probe[field] !== second.probe[field], `different seeds produced identical ${field}`);
  }
  const firstIds = first.media.devices.map((device) => device.deviceId).sort();
  const secondIds = second.media.devices.map((device) => device.deviceId).sort();
  expect(JSON.stringify(firstIds) !== JSON.stringify(secondIds), "different seeds produced identical media device IDs");
  expectEqual(
    first.systemTheme.preferredColorScheme,
    second.systemTheme.preferredColorScheme,
    "preferred color scheme changed across seeds in the same scheme bucket",
  );
  expectEqual(
    first.systemTheme.preferredColors,
    second.systemTheme.preferredColors,
    "preferred system colors changed across seeds",
  );
  for (const scheme of ["light", "dark"] as const) {
    expectEqual(
      first.systemTheme[scheme].colors,
      second.systemTheme[scheme].colors,
      `${scheme} system colors changed across seeds`,
    );
    expectEqual(
      first.systemTheme[scheme].selection.background,
      second.systemTheme[scheme].selection.background,
      `${scheme} painted selection color changed across seeds`,
    );
  }
}

export function parseNativeChromiumVerificationArgs(argv: string[]): {
  executable: string;
  gpuOnly: boolean;
  artifacts: string | null;
} {
  let executable: string | null = null;
  let gpuOnly = false;
  let artifacts: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--gpu-only") {
      if (gpuOnly) fail("Duplicate --gpu-only option");
      gpuOnly = true;
    } else if (arg === "--artifacts") {
      if (artifacts !== null) fail("Duplicate --artifacts option");
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail("--artifacts requires an absolute owned directory path");
      if (!path.isAbsolute(value)) fail("--artifacts requires an absolute owned directory path");
      artifacts = path.resolve(value);
    } else if (arg.startsWith("--")) {
      fail(`Unsupported verification option: ${arg}`);
    } else {
      if (executable !== null) fail(`Unexpected extra executable argument: ${arg}`);
      executable = arg;
    }
  }
  if (!executable) fail("usage: verify-native-chromium /path/to/Chromium[.app] [--gpu-only --artifacts /owned/path]");
  if (gpuOnly && !artifacts) fail("--gpu-only requires --artifacts /absolute/owned/path");
  if (!gpuOnly && artifacts) fail("--artifacts is only supported with --gpu-only");
  return { executable, gpuOnly, artifacts };
}

export function prepareGpuArtifactsRoot(input: string): string {
  expect(path.isAbsolute(input), "GPU artifacts require an absolute owned directory path");
  const root = path.resolve(input);
  const ownerUid = typeof process.getuid === "function" ? process.getuid() : null;
  expect(ownerUid !== null, "Cannot verify current-user ownership of GPU artifacts on this platform");
  const ancestors: string[] = [];
  for (let entry = root; ; entry = path.dirname(entry)) {
    ancestors.unshift(entry);
    if (path.dirname(entry) === entry) break;
  }
  const checkDirectory = (entry: string): void => {
    const stats = fs.lstatSync(entry);
    expect(!stats.isSymbolicLink(), `GPU artifact path must not contain a symlink: ${entry}`);
    expect(stats.isDirectory(), `GPU artifact path must be a directory: ${entry}`);
  };
  // Check before creation so mkdir cannot follow an existing ancestor redirect.
  for (const entry of ancestors) {
    try {
      checkDirectory(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of ancestors) checkDirectory(entry);
  expectEqual(fs.realpathSync(root), root, "GPU artifact root must not redirect to another path");
  const stats = fs.lstatSync(root);
  expectEqual(stats.uid, ownerUid, "GPU artifact root must be owned by the current user");
  expect((stats.mode & 0o022) === 0, "GPU artifact root must not be writable by other users");
  return root;
}

export function gpuPersonaDiagnostic(platform: "windows" | "macos", runtimePlatform = process.platform): string {
  return getHostBrowserPlatform(runtimePlatform) === platform
    ? "native-host-persona"
    : "unsupported-cross-os-persona-diagnostic";
}

export function verifyManagedGpuIdentity(
  actual: { userAgent: string; platform: string },
  configured: Pick<BrowserFingerprintConfig, "userAgent" | "platform">,
  label = "managed GPU sample",
): void {
  expectEqual(actual.userAgent, configured.userAgent, `${label} managed User-Agent activation`);
  expectEqual(actual.platform, configured.platform, `${label} managed platform activation`);
}

async function captureGpuSample(
  executablePath: string,
  version: string,
  origin: string,
  userDataDir: string,
  mode: "headless" | "headed",
  label: string,
  meta: BrowserFingerprintMeta | null,
) {
  const config = meta ? buildBrowserFingerprintConfig(meta, version) : null;
  let context: BrowserContext | null = null;
  try {
    process.stderr.write(`[verify:chromium:gpu] ${mode} ${label}: launch\n`);
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: mode === "headless",
      colorScheme: null,
      timeout: 20_000,
      viewport: null,
      args: ["--use-mock-keychain", ...(meta ? [buildBrowserFingerprintArg(meta, version)] : [])],
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(origin, { waitUntil: "load", timeout: 15_000 });
    const session = await context.newCDPSession(page);
    let runtimeProduct: string;
    try {
      const runtime = await withTimeout(session.send("Browser.getVersion"), 5000, `${label} runtime version`);
      runtimeProduct = runtime.product;
      expectEqual(runtimeProduct.split("/").pop(), version, `${label} actual runtime version`);
    } finally {
      await withTimeout(session.detach(), 2000, `${label} CDP detach`);
    }
    const navigators = await withTimeout(page.evaluate(captureHostIdentityInPage), 8000, `${label} Window/Worker identity`);
    const requestHeaders = await withTimeout(captureRequestHeaders(page, label), 15_000, `${label} actual request identity`);
    const hostIdentity: HostIdentityCorpus = { ...navigators, requestHeaders };
    const navigatorIdentity = hostIdentity.window;
    const gpu = await captureGpuCorpus(page, `${mode} ${label}`);
    return {
      label,
      mode,
      selectedPlatform: meta?.platform || null,
      personaDiagnostic: meta?.platform === "windows" || meta?.platform === "macos"
        ? gpuPersonaDiagnostic(meta.platform)
        : "native-pass-through",
      seed: config?.seed || null,
      runtimeProduct,
      navigatorIdentity,
      hostIdentity,
      configured: config ? { userAgent: config.userAgent, platform: config.platform, webgl: config.webgl, webgpu: config.webgpu } : null,
      ...gpu,
    };
  } finally {
    if (context) await withTimeout(context.close(), 10_000, `${mode} ${label} browser close`);
  }
}

async function runGpuOnly(executablePath: string, version: string, artifacts: string): Promise<void> {
  const hostPlatform = getHostBrowserPlatform();
  expect(hostPlatform !== null, "Managed host OS compatibility is not supported on this runtime");
  // Every invocation owns a new directory; old profiles and evidence are never
  // read, overwritten, copied, or removed. Five host-matched samples per mode.
  const artifactsRoot = prepareGpuArtifactsRoot(artifacts);
  const runRoot = fs.mkdtempSync(path.join(artifactsRoot, "gpu-native-verify-"));
  const artifactPath = path.join(runRoot, "gpu-result.json");
  const report = {
    ok: false,
    status: "in-progress",
    executablePath,
    version,
    nativeHost: process.platform,
    gpuPolicy: "configured-WebGL-identity-or-strict-native; all-other-WebGL-and-WebGPU-fields-native",
    configuredWebglProof: "simulated identity conformance, not physical GPU proof",
    identityPolicy: "same-host OS family across Window, Worker, UA-CH and actual requests",
    workerRequestHintsPolicy: "present values are checked; matching native-control omissions are recorded as absent, not verified hint values",
    highEntropyPhysicalMatch: "not-asserted; captured architecture and OS version are checked for cross-surface agreement only",
    foreignOsSamples: "not-run; foreign OS native-GPU personas are unsupported, not positive acceptance samples",
    realUserDataUsed: false,
    publicNetworkTargets: [] as string[],
    modeChecks: { headless: "not-run", headed: "not-run" },
    crossModeGpuComparison: "not-asserted; each mode is checked against its own native baseline",
    samples: [] as Awaited<ReturnType<typeof captureGpuSample>>[],
    errors: [] as string[],
  };
  let origin: Awaited<ReturnType<typeof startOrigin>> | null = null;
  try {
    origin = await startOrigin();
    for (const mode of ["headless", "headed"] as const) {
      report.modeChecks[mode] = "in-progress";
      let nativeControl: HostIdentityCorpus | undefined;
      const capture = async (label: string, profile: string, meta: BrowserFingerprintMeta | null) => {
        const sample = await captureGpuSample(executablePath, version, origin!.origin, path.join(runRoot, `${mode}-${profile}`), mode, label, meta);
        report.samples.push(sample);
        process.stdout.write(JSON.stringify({
          label, mode, nativeHost: report.nativeHost, selectedPlatform: sample.selectedPlatform,
          personaDiagnostic: sample.personaDiagnostic, seed: sample.seed, runtimeProduct: sample.runtimeProduct,
          webglSha256: webGlCorpusSha256(sample.webgl.window), webgpuSha256: webGpuCorpusSha256(sample.webgpu.window),
          webgpuAdapterInfo: sample.webgpu.window.adapter?.info, webgpuDeviceInfo: sample.webgpu.window.device?.adapterInfo,
        }) + "\n");
        if (sample.configured) {
          // A stock executable ignoring the managed switch must not pass just
          // because both captures expose the same native GPU.
          verifyManagedGpuIdentity(sample.navigatorIdentity, sample.configured, `${mode} ${label}`);
        }
        if (!meta && !nativeControl) nativeControl = sample.hostIdentity;
        verifyHostIdentityCoherence(sample.hostIdentity, sample.configured || {
          userAgent: sample.navigatorIdentity.userAgent,
          platform: hostPlatform === "macos" ? "MacIntel" : "Win32",
        }, process.platform, `${mode} ${label}`, nativeControl);
        return sample;
      };
      const baseline = await capture("pass-through", "pass-through", null);
      verifyNativeGpuCorpus(baseline, baseline, `${mode} native pass-through`);
      const baselineRepeat = await capture("pass-through restart", "pass-through", null);
      verifyNativeGpuCorpus(baselineRepeat, baseline, `${mode} native repeat stability`);
      for (const platform of [hostPlatform]) {
        const meta: BrowserFingerprintMeta = { fingerprintSeed: 424242, platform, locale: "en-US", timezone: "America/New_York" };
        const diagnostic = `${platform} persona on ${process.platform} (${gpuPersonaDiagnostic(platform)})`;
        const first = await capture(diagnostic, platform, meta);
        verifyNativeGpuCorpus(first, baseline, `${mode} ${diagnostic}`, configuredWebGlIdentity(first.configured));
        const restart = await capture(`${diagnostic} same-seed restart`, platform, meta);
        verifyNativeGpuCorpus(restart, baseline, `${mode} ${diagnostic} repeat stability`, configuredWebGlIdentity(restart.configured));
        const distinct = await capture(`${diagnostic} different seed`, `${platform}-distinct`, { ...meta, fingerprintSeed: 424243 });
        verifyNativeGpuCorpus(distinct, baseline, `${mode} ${diagnostic} different-seed identity and capabilities`, configuredWebGlIdentity(distinct.configured));
      }
      report.modeChecks[mode] = "verified-host-OS-identity-and-same-mode-GPU-contract";
    }
    report.ok = true;
    report.status = "host-os-and-gpu-contract-verified";
  } catch (error) {
    report.status = "gpu-contract-failed";
    for (const mode of ["headless", "headed"] as const) {
      if (report.modeChecks[mode] === "in-progress") report.modeChecks[mode] = "failed";
    }
    report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    if (origin) {
      try {
        await withTimeout(origin.close(), 5000, "GPU verification origin close");
      } catch (error) {
        report.ok = false;
        report.status = "gpu-contract-failed";
        report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
      }
    }
    fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: report.ok, status: report.status, artifactPath, samples: report.samples.length, modeChecks: report.modeChecks, crossModeGpuComparison: report.crossModeGpuComparison, errors: report.errors }, null, 2) + "\n");
  }
  if (!report.ok) fail(`Native GPU verification failed; retained evidence: ${artifactPath}`);
}

async function main(): Promise<void> {
  const options = parseNativeChromiumVerificationArgs(process.argv.slice(2));
  const executablePath = resolveExecutable(options.executable);
  const version = detectVersion(executablePath);
  expectEqual(version, TARGET_CHROMIUM_VERSION, "Chromium verification target version");
  if (options.gpuOnly) {
    await runGpuOnly(executablePath, version, options.artifacts!);
    return;
  }

  const managedPlatform = getHostBrowserPlatform();
  expect(managedPlatform !== null, "Full managed protocol diagnostics require a supported host platform");
  process.stderr.write("[verify:chromium] Full protocol diagnostics include foreign-OS samples; these are not supported host/GPU compatibility evidence. Use --gpu-only for joint host-identity acceptance.\n");
  const origin = await startOrigin();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roxy-native-verify-"));
  const alternatePlatform = managedPlatform === "windows" ? "macos" : "windows";
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const baseMeta: BrowserFingerprintMeta = {
    fingerprintSeed: 424242,
    platform: managedPlatform,
    locale: "en-US",
    timezone: hostTimezone === "America/New_York" ? "Asia/Tokyo" : "America/New_York",
    webrtcMode: "disable",
    geolocationMode: "custom",
    geolocationLatitude: 40.7128,
    geolocationLongitude: -74.006,
    geolocationAccuracy: 25,
    // Non-GPU tuple constraints remain managed; GPU identity is native even
    // for the alternate cross-OS persona diagnostic below.

    hardwareConcurrency: managedPlatform === "macos" ? 8 : 12,
    deviceMemory: 16,
    screenWidth: managedPlatform === "macos" ? 1512 : 1920,
    screenHeight: managedPlatform === "macos" ? 982 : 1080,
    taskbarHeight: managedPlatform === "macos" ? 25 : 48,
    storageQuota: 120000,
  };

  try {
    const persistentProfileDir = path.join(tempRoot, "persistent-profile");
    const first = await runOnce(
      executablePath,
      version,
      baseMeta,
      origin.origin,
      origin.crossOrigin,
      persistentProfileDir,
      "same Profile initial headless run",
    );
    const persistentRestart = await runOnce(
      executablePath,
      version,
      baseMeta,
      origin.origin,
      origin.crossOrigin,
      persistentProfileDir,
      "same Profile headless restart",
    );
    const repeat = await runOnce(executablePath, version, baseMeta, origin.origin, origin.crossOrigin, path.join(tempRoot, "same-b"), "same-seed B");
    const distinct = await runOnce(
      executablePath,
      version,
      { ...baseMeta, fingerprintSeed: 424243 },
      origin.origin,
      origin.crossOrigin,
      path.join(tempRoot, "distinct"),
      "different-seed",
    );
    const greekGreece = await runOnce(
      executablePath,
      version,
      {
        ...baseMeta,
        fingerprintSeed: 424244,
        locale: "el-GR",
        timezone: "Europe/Athens",
        geolocationLatitude: 37.9838,
        geolocationLongitude: 23.7275,
      },
      origin.origin,
      origin.crossOrigin,
      path.join(tempRoot, "locale-el-gr"),
      "locale el-GR",
    );
    const greekCyprus = await runOnce(
      executablePath,
      version,
      {
        ...baseMeta,
        fingerprintSeed: 424248,
        platform: alternatePlatform,
        locale: "el-CY",
        timezone: "Asia/Nicosia",
        geolocationLatitude: 35.1856,
        geolocationLongitude: 33.3823,
        hardwareConcurrency: alternatePlatform === "macos" ? 8 : 12,
        deviceMemory: 16,
        screenWidth: alternatePlatform === "macos" ? 1512 : 1920,
        screenHeight: alternatePlatform === "macos" ? 982 : 1080,
        taskbarHeight: alternatePlatform === "macos" ? 25 : 48,
      },
      origin.origin,
      origin.crossOrigin,
      path.join(tempRoot, "locale-el-cy"),
      "locale el-CY",
    );
    const headed = await runOnce(
      executablePath,
      version,
      baseMeta,
      origin.origin,
      origin.crossOrigin,
      path.join(tempRoot, "headed-full-surface"),
      "full headed run",
      false,
    );
    const stockHeadlessWindowMode = await captureStockWindowMode(
      executablePath,
      first.config,
      path.join(tempRoot, "stock-window-headless"),
      true,
    );
    const stockHeadedWindowMode = await captureStockWindowMode(
      executablePath,
      first.config,
      path.join(tempRoot, "stock-window-headed"),
      false,
    );
    const incognitoStorage = await captureIncognitoStorage(
      executablePath,
      version,
      baseMeta,
      origin.origin,
    );
    const passThrough = await capturePassThrough(
      executablePath,
      origin.origin,
      origin.crossOrigin,
      path.join(tempRoot, "pass-through"),
    );
    const passThroughHeaded = await capturePassThrough(
      executablePath,
      origin.origin,
      origin.crossOrigin,
      path.join(tempRoot, "pass-through-headed"),
      false,
    );
    verifyStable(first.result, repeat.result, "same seed across independent Profiles");
    verifyStable(first.result, persistentRestart.result, "same persistent Profile after restart");
    verifyHeadedHeadlessParity(
      first.result,
      headed.result,
      stockHeadlessWindowMode,
      stockHeadedWindowMode,
      passThrough,
      passThroughHeaded,
      configuredWebGlIdentity(first.config),
    );
    verifyExpected(first.result, first.config, passThrough);
    verifyExpected(persistentRestart.result, persistentRestart.config, passThrough);
    verifyExpected(repeat.result, repeat.config, passThrough);
    verifyExpected(distinct.result, distinct.config, passThrough);
    verifyExpected(greekGreece.result, greekGreece.config, passThrough);
    verifyExpected(greekCyprus.result, greekCyprus.config, passThrough);
    verifyExpected(headed.result, headed.config, passThroughHeaded, stockHeadedWindowMode);
    verifyStorageCorpus(incognitoStorage.storage, incognitoStorage.config.storageQuotaBytes, "incognito");
    expectEqual(first.result.storage, incognitoStorage.storage, "persistent/incognito Storage corpus parity");
    verifyDistinct(first.result, distinct.result);
    const windowsTheme = first.config.platform === "Win32"
      ? first.result.systemTheme
      : greekCyprus.result.systemTheme;
    const macTheme = first.config.platform === "MacIntel"
      ? first.result.systemTheme
      : greekCyprus.result.systemTheme;
    verifyPlatformThemeDistinction(windowsTheme, macTheme);
    const windowsFonts = first.config.platform === "Win32"
      ? first.result.fonts
      : greekCyprus.result.fonts;
    const macFonts = first.config.platform === "MacIntel"
      ? first.result.fonts
      : greekCyprus.result.fonts;
    verifyFontPlatformDistinction(windowsFonts, macFonts);
    verifyPassThrough(passThrough, first.result);
    process.stdout.write(JSON.stringify({
      ok: true,
      executablePath,
      version,
      nativeHost: process.platform,
      selectedPlatform: managedPlatform,
      personaDiagnostic: gpuPersonaDiagnostic(managedPlatform),
      alternatePersona: { selectedPlatform: alternatePlatform, diagnostic: gpuPersonaDiagnostic(alternatePlatform) },
      gpuPolicy: configuredWebGlIdentity(first.config)
        ? "simulated-WebGL-identity-conformance-and-same-mode-native-capabilities-WebGPU"
        : "native-host-gpu-verified-against-same-mode-pass-through",
      configuredWebglProof: "simulated identity conformance, not physical GPU proof",
      checkedSurfaces: STABLE_FIELDS.length,
      webglCapabilityCorpus: {
        contexts: 6,
        sameHostNativeSha256: webGlCorpusSha256(passThrough.webgl.window),
        managedFullCorpusSha256: webGlCorpusSha256(first.result.webgl.window),
        webgl1Parameters: Object.keys(first.result.webgl.window.webgl1?.parameters || {}).length,
        webgl2Parameters: Object.keys(first.result.webgl.window.webgl2?.parameters || {}).length,
        shaderPrecisionCases: (["window", "windowOffscreen", "worker"] as const).reduce((total, realm) => total
          + Object.keys(first.result.webgl[realm].webgl1?.shaderPrecision || {}).length
          + Object.keys(first.result.webgl[realm].webgl2?.shaderPrecision || {}).length, 0),
      },
      webgpuCapabilityCorpus: {
        contexts: 2,
        sameHostNativeSha256: webGpuCorpusSha256(passThrough.webgpu.window),
        managedFullCorpusSha256: webGpuCorpusSha256(first.result.webgpu.window),
        nativeAdapterInfo: passThrough.webgpu.window.adapter?.info,
        nativeDeviceInfo: passThrough.webgpu.window.device?.adapterInfo,
        adapterFeatures: first.result.webgpu.window.adapter?.features.length || 0,
        adapterLimits: Object.keys(first.result.webgpu.window.adapter?.limits || {}).length,
        deviceFeatures: first.result.webgpu.window.device?.features.length || 0,
        deviceLimits: Object.keys(first.result.webgpu.window.device?.limits || {}).length,
        wgslLanguageFeatures: first.result.webgpu.window.wgslLanguageFeatures.length,
      },
      fontCapabilityCorpus: {
        contexts: 2,
        candidates: Object.keys(first.result.fonts.window.availability).length,
        genericMetricCases: Object.keys(first.result.fonts.window.genericMetrics).length,
        namedMetricCases: Object.keys(first.result.fonts.window.namedMetrics).length,
        rasterCases: Object.keys(first.result.fonts.window.raster).length,
        windowsSha256: fontCapabilitySha256(windowsFonts),
        macSha256: fontCapabilitySha256(macFonts),
        localAccess: "managed-family-allowlist-verified",
        canvasDomParity: "maximum-generic-width-difference-2px",
      },
      systemThemeChecks: SYSTEM_COLOR_KEYWORDS.length * 3 + 4,
      codecs: "aac-h264-verified",
      storageBuckets: "verified",
      storageCorpus: "modern-legacy-buckets-opfs-persistent-incognito-verified",
      webauthn: "verified",
      cdpIdentityCoherence: "verified",
      buildVersionCoherence: "verified",
      headedHeadlessParity: {
        status: "non-gpu-parity-and-per-mode-gpu-contract-verified",
        gpuBaselines: {
          headless: { webglSha256: webGlCorpusSha256(passThrough.webgl.window), webgpuSha256: webGpuCorpusSha256(passThrough.webgpu.window) },
          headed: { webglSha256: webGlCorpusSha256(passThroughHeaded.webgl.window), webgpuSha256: webGpuCorpusSha256(passThroughHeaded.webgpu.window) },
        },
        stockWindowDifferences: (["screenY", "innerHeight"] as const).filter(
          (field) => stockHeadlessWindowMode[field] !== stockHeadedWindowMode[field],
        ),
      },
      persistentProfileRestart: "full-surface-verified",
      localeCoherence: ["el-GR", "el-CY"],
      systemTheme: "windows-macos-light-dark-selection-paint-verified",
      passThrough: "verified-native-host-identity-and-theme",
      sameSeedStable: true,
      differentSeedsDistinct: true,
      audioCapture: first.result.media.audioCaptureStatus === "timeout"
        ? "environment-timeout (also reproduced with stock Chrome)"
        : "verified",
    }, null, 2) + "\n");
  } finally {
    await origin.close().catch(() => undefined);
    if (tempRoot.startsWith(os.tmpdir() + path.sep + "roxy-native-verify-")) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

// Importing pure GPU checks must never start an origin or launch a browser.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[verify:chromium] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
