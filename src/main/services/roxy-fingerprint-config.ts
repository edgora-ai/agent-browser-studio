import { createHash } from "node:crypto";
import type { CloakFingerprintMeta, CloakPlatform, GeolocationMode } from "../types.js";

export const ROXY_FINGERPRINT_SWITCH = "--roxy-fingerprint-config=";
export const ROXY_FINGERPRINT_SCHEMA_VERSION = 1;

const WINDOWS_FONT_POOL = [
  "Arial", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas",
  "Constantia", "Corbel", "Courier New", "Ebrima", "Georgia", "Impact",
  "Microsoft Sans Serif", "Palatino Linotype", "Segoe UI", "Tahoma",
  "Times New Roman", "Trebuchet MS", "Verdana",
];
const MAC_FONT_POOL = [
  "Arial", "Avenir", "Courier New", "Georgia", "Helvetica", "Helvetica Neue",
  "Hoefler Text", "Menlo", "Monaco", "Optima", "Palatino", "San Francisco",
  "Times", "Times New Roman", "Trebuchet MS", "Verdana",
];
const CJK_FONT_POOL = [
  "Microsoft YaHei", "Microsoft JhengHei", "MS Gothic", "Yu Gothic",
  "PingFang SC", "PingFang TC", "Hiragino Kaku Gothic ProN", "Malgun Gothic",
];

export interface RoxyFingerprintConfig {
  schemaVersion: 1;
  seed: number;
  platform: "Win32" | "MacIntel";
  platformVersion: string;
  userAgent: string;
  appVersion: string;
  vendor: "Google Inc.";
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
  };
  storageQuotaBytes: number;
  canvas: { enabled: boolean; seed: string };
  audio: { enabled: boolean; seed: string; amplitude: number };
  webgl: { vendor: string; renderer: string };
  webrtc: { mode: "real" | "altered" | "disable"; publicIp: string | null };
  timezone: string | null;
  geolocation: {
    mode: GeolocationMode;
    latitude: number | null;
    longitude: number | null;
    accuracy: number | null;
  };
  mediaDevices: {
    enabled: boolean;
    audioInputs: number;
    videoInputs: number;
    audioOutputs: number;
  };
  fonts: string[];
  doNotTrack: string | null;
}

/**
 * Build the versioned, public configuration consumed by our Chromium fork.
 * This deliberately does not reuse RoxyChrome's encrypted lumi.conf format.
 */
export function buildRoxyFingerprintConfig(
  meta: CloakFingerprintMeta,
  chromiumVersion: string | null,
): RoxyFingerprintConfig {
  const seed = normalizeSeed(meta.fingerprintSeed);
  const platform = normalizePlatform(meta.platform);
  const version = normalizeChromiumVersion(chromiumVersion);
  const locale = normalizeLocale(meta.locale);
  const languages = locale.includes("-") ? [locale, locale.split("-")[0]] : [locale];
  const screenWidth = normalizeInteger(meta.screenWidth, 320, 10000, platform === "MacIntel" ? 1728 : 1920);
  const screenHeight = normalizeInteger(meta.screenHeight, 240, 10000, platform === "MacIntel" ? 1117 : 1080);
  const taskbarHeight = normalizeInteger(meta.taskbarHeight, 0, 500, platform === "MacIntel" ? 25 : 48);
  const devicePixelRatio = platform === "MacIntel" ? 2 : 1;
  const osToken = platform === "MacIntel"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : "Windows NT 10.0; Win64; x64";
  const ua = `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

  return {
    schemaVersion: ROXY_FINGERPRINT_SCHEMA_VERSION,
    seed,
    platform,
    platformVersion: platform === "MacIntel" ? "15.7.0" : "10.0.0",
    userAgent: ua,
    appVersion: ua.replace(/^Mozilla\//, ""),
    vendor: "Google Inc.",
    languages,
    hardwareConcurrency: normalizeInteger(meta.hardwareConcurrency, 1, 64, seededChoice(seed, [4, 8, 12, 16])),
    deviceMemory: normalizeInteger(meta.deviceMemory, 1, 128, seededChoice(seed ^ 0x45d9f3b, [4, 8, 16])),
    maxTouchPoints: 0,
    screen: {
      width: screenWidth,
      height: screenHeight,
      availWidth: screenWidth,
      availHeight: Math.max(1, screenHeight - taskbarHeight),
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio,
    },
    storageQuotaBytes: normalizeInteger(meta.storageQuota, 1, 1048576, 120000) * 1024 * 1024,
    canvas: { enabled: true, seed: deriveSeed(seed, "canvas") },
    audio: { enabled: true, seed: deriveSeed(seed, "audio"), amplitude: 0.0000001 },
    webgl: {
      vendor: normalizeText(meta.gpuVendor, platform === "MacIntel" ? "Google Inc. (Apple)" : "Google Inc. (NVIDIA)"),
      renderer: normalizeText(
        meta.gpuRenderer,
        platform === "MacIntel"
          ? "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"
          : "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      ),
    },
    webrtc: meta.webrtcIp
      ? { mode: "altered", publicIp: meta.webrtcIp }
      : { mode: "real", publicIp: null },
    timezone: typeof meta.timezone === "string" && meta.timezone ? meta.timezone : null,
    geolocation: normalizeGeolocation(meta),
    mediaDevices: { enabled: true, audioInputs: 1, videoInputs: 1, audioOutputs: 1 },
    fonts: selectStableFonts(seed, platform, locale),
    doNotTrack: null,
  };
}

export function encodeRoxyFingerprintConfig(config: RoxyFingerprintConfig): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

export function buildRoxyFingerprintArg(
  meta: CloakFingerprintMeta,
  chromiumVersion: string | null,
): string {
  return ROXY_FINGERPRINT_SWITCH + encodeRoxyFingerprintConfig(buildRoxyFingerprintConfig(meta, chromiumVersion));
}

function normalizeSeed(value: unknown): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 12345;
}

function normalizePlatform(value: CloakPlatform | undefined): "Win32" | "MacIntel" {
  return value === "macos" ? "MacIntel" : "Win32";
}

function normalizeChromiumVersion(value: string | null): string {
  const match = value?.match(/\d+\.\d+\.\d+\.\d+/);
  return match?.[0] || "149.0.7827.22";
}

function normalizeLocale(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "en-US";
  try {
    return Intl.getCanonicalLocales(value.trim())[0] || "en-US";
  } catch {
    return "en-US";
  }
}

function normalizeInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeGeolocation(meta: CloakFingerprintMeta): RoxyFingerprintConfig["geolocation"] {
  const mode = meta.geolocationMode === "disable" || meta.geolocationMode === "custom"
    ? meta.geolocationMode
    : "real";
  if (mode !== "custom") {
    return { mode, latitude: null, longitude: null, accuracy: null };
  }
  const latitude = normalizeFiniteNumber(meta.geolocationLatitude, -90, 90, "geolocation latitude");
  const longitude = normalizeFiniteNumber(meta.geolocationLongitude, -180, 180, "geolocation longitude");
  const accuracy = meta.geolocationAccuracy == null
    ? 50
    : normalizeFiniteNumber(meta.geolocationAccuracy, 0, 100000, "geolocation accuracy");
  return { mode, latitude, longitude, accuracy };
}

function normalizeFiniteNumber(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return number;
}

function seededChoice(seed: number, values: readonly number[]): number {
  return values[Math.abs(seed) % values.length];
}

function deriveSeed(seed: number, surface: string): string {
  return createHash("sha256").update(`${seed}:${surface}`).digest("hex").slice(0, 16);
}

function selectStableFonts(seed: number, platform: "Win32" | "MacIntel", locale: string): string[] {
  const pool = stableShuffle(platform === "MacIntel" ? MAC_FONT_POOL : WINDOWS_FONT_POOL, seed);
  const selected = /^(zh|ja|ko)(-|$)/i.test(locale)
    ? [...pool.slice(0, 12), ...stableShuffle(CJK_FONT_POOL, seed ^ 0x7f4a7c15).slice(0, 3)]
    : pool.slice(0, 15);
  return [...new Set(selected)].sort();
}

function stableShuffle(values: readonly string[], seed: number): string[] {
  const pool = [...values];
  let state = seed >>> 0;
  for (let index = pool.length - 1; index > 0; index--) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const target = (state >>> 0) % (index + 1);
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  return pool;
}
