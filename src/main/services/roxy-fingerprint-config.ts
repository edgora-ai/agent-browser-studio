import { createHash } from "node:crypto";
import type { CloakFingerprintMeta, CloakPlatform, GeolocationMode, WebRtcMode } from "../types.js";

export const ROXY_FINGERPRINT_SWITCH = "--roxy-fingerprint-config=";
export const ROXY_FINGERPRINT_SCHEMA_VERSION = 1;

const PORTABLE_WINDOWS_FONT_POOL = [
  "Arial", "Arial Unicode MS", "Comic Sans MS", "Courier New", "Georgia",
  "Impact", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
];
const REQUIRED_MAC_FONT_POOL = [
  "Apple Chancery", "Apple Color Emoji", "Helvetica", "Menlo", "Papyrus",
  "STIX Two Math", "Times",
];
const MAC_FONT_POOL = [
  "Arial", "Avenir", "Courier New", "Georgia", "Helvetica", "Helvetica Neue",
  "Hoefler Text", "Menlo", "Monaco", "Optima", "Palatino", "San Francisco",
  "Times", "Times New Roman", "Trebuchet MS", "Verdana",
];
const MAC_CJK_FONT_POOL = [
  "PingFang SC", "PingFang TC", "Hiragino Kaku Gothic ProN",
];

interface HardwarePersona {
  id: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  screenWidth: number;
  screenHeight: number;
  taskbarHeight: number;
  devicePixelRatio: number;
  gpuVendor: string;
  gpuRenderer: string;
}

// Publicly common hardware combinations, kept as whole tuples so the default
// seed path cannot independently combine an entry-level GPU, workstation CPU,
// unusual RAM size, and unrelated display. Explicit advanced profile fields
// still override individual values for controlled testing and migration.
const WINDOWS_HARDWARE_PERSONAS: readonly HardwarePersona[] = [
  {
    id: "win-intel-uhd620-8c-8gb-1080p",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    taskbarHeight: 48,
    devicePixelRatio: 1,
    gpuVendor: "Google Inc. (Intel)",
    gpuRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win-intel-irisxe-8c-16gb-1080p",
    hardwareConcurrency: 8,
    deviceMemory: 16,
    screenWidth: 1920,
    screenHeight: 1080,
    taskbarHeight: 48,
    devicePixelRatio: 1,
    gpuVendor: "Google Inc. (Intel)",
    gpuRenderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win-nvidia-rtx3060-12c-16gb-1080p",
    hardwareConcurrency: 12,
    deviceMemory: 16,
    screenWidth: 1920,
    screenHeight: 1080,
    taskbarHeight: 48,
    devicePixelRatio: 1,
    gpuVendor: "Google Inc. (NVIDIA)",
    gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win-nvidia-rtx4060-16c-16gb-1440p",
    hardwareConcurrency: 16,
    deviceMemory: 16,
    screenWidth: 2560,
    screenHeight: 1440,
    taskbarHeight: 48,
    devicePixelRatio: 1,
    gpuVendor: "Google Inc. (NVIDIA)",
    gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win-amd-radeon-16c-16gb-1080p",
    hardwareConcurrency: 16,
    deviceMemory: 16,
    screenWidth: 1920,
    screenHeight: 1080,
    taskbarHeight: 48,
    devicePixelRatio: 1,
    gpuVendor: "Google Inc. (AMD)",
    gpuRenderer: "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
];

const MAC_HARDWARE_PERSONAS: readonly HardwarePersona[] = [
  {
    id: "mac-apple-m1-8c-8gb-1440x900",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screenWidth: 1440,
    screenHeight: 900,
    taskbarHeight: 25,
    devicePixelRatio: 2,
    gpuVendor: "Google Inc. (Apple)",
    gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
  },
  {
    id: "mac-apple-m2-8c-16gb-1512x982",
    hardwareConcurrency: 8,
    deviceMemory: 16,
    screenWidth: 1512,
    screenHeight: 982,
    taskbarHeight: 25,
    devicePixelRatio: 2,
    gpuVendor: "Google Inc. (Apple)",
    gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
  },
  {
    id: "mac-apple-m3-8c-16gb-1710x1107",
    hardwareConcurrency: 8,
    deviceMemory: 16,
    screenWidth: 1710,
    screenHeight: 1107,
    taskbarHeight: 25,
    devicePixelRatio: 2,
    gpuVendor: "Google Inc. (Apple)",
    gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)",
  },
  {
    id: "mac-apple-m2pro-12c-16gb-1728x1117",
    hardwareConcurrency: 12,
    deviceMemory: 16,
    screenWidth: 1728,
    screenHeight: 1117,
    taskbarHeight: 25,
    devicePixelRatio: 2,
    gpuVendor: "Google Inc. (Apple)",
    gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
  },
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
  hardwareProfile: {
    id: string;
    source: "seeded" | "validated-override";
    fontProfile: "windows-portable" | "macos-system";
    audioProfile: "chromium-desktop";
  };
  screen: {
    width: number;
    height: number;
    availLeft: number;
    availTop: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
    windowX: number;
    windowY: number;
    outerWidth: number;
    outerHeight: number;
  };
  storageQuotaBytes: number;
  canvas: { enabled: boolean; seed: string };
  audio: { enabled: boolean; seed: string; amplitude: number };
  webgl: { vendor: string; renderer: string };
  webgpu: {
    mode: "webgl";
    vendor: string;
    architecture: string;
    subgroupMinSize: number;
    subgroupMaxSize: number;
  };
  webauthn: {
    enabled: boolean;
    conditionalGet: boolean;
    conditionalCreate: boolean;
    hybridTransport: boolean;
    passkeyPlatformAuthenticator: boolean;
    userVerifyingPlatformAuthenticator: boolean;
  };
  speechSynthesis: {
    enabled: boolean;
    voices: Array<{ name: string; lang: string; localService: boolean }>;
  };
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
  const { persona, source: personaSource } = selectHardwarePersona(seed, platform, meta);
  const screenWidth = persona.screenWidth;
  const screenHeight = persona.screenHeight;
  const taskbarHeight = persona.taskbarHeight;
  const availLeft = 0;
  const availTop = platform === "MacIntel" ? Math.min(taskbarHeight, Math.max(0, screenHeight - 1)) : 0;
  const availWidth = screenWidth;
  const availHeight = Math.max(1, screenHeight - taskbarHeight);
  const outerWidth = Math.min(availWidth, 1280);
  const outerHeight = Math.min(availHeight, 800);
  const windowX = availLeft + Math.min(32, Math.max(0, availWidth - outerWidth));
  const windowY = availTop + Math.min(32, Math.max(0, availHeight - outerHeight));
  const devicePixelRatio = persona.devicePixelRatio;
  const osToken = platform === "MacIntel"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : "Windows NT 10.0; Win64; x64";
  const ua = `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  const webgl = {
    vendor: persona.gpuVendor,
    renderer: persona.gpuRenderer,
  };

  return {
    schemaVersion: ROXY_FINGERPRINT_SCHEMA_VERSION,
    seed,
    platform,
    platformVersion: platform === "MacIntel" ? "15.7.0" : "10.0.0",
    userAgent: ua,
    appVersion: ua.replace(/^Mozilla\//, ""),
    vendor: "Google Inc.",
    languages,
    hardwareConcurrency: persona.hardwareConcurrency,
    deviceMemory: persona.deviceMemory,
    maxTouchPoints: 0,
    hardwareProfile: {
      id: persona.id,
      source: personaSource,
      fontProfile: platform === "MacIntel" ? "macos-system" : "windows-portable",
      audioProfile: "chromium-desktop",
    },
    screen: {
      width: screenWidth,
      height: screenHeight,
      availLeft,
      availTop,
      availWidth,
      availHeight,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio,
      windowX,
      windowY,
      outerWidth,
      outerHeight,
    },
    storageQuotaBytes: normalizeInteger(meta.storageQuota, 1, 1048576, 120000) * 1024 * 1024,
    canvas: { enabled: true, seed: deriveSeed(seed, "canvas") },
    audio: { enabled: true, seed: deriveSeed(seed, "audio"), amplitude: 0.0000001 },
    webgl,
    webgpu: deriveWebGpuIdentity(webgl.vendor, webgl.renderer),
    webauthn: {
      enabled: true,
      conditionalGet: true,
      conditionalCreate: true,
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
      userVerifyingPlatformAuthenticator: true,
    },
    speechSynthesis: { enabled: true, voices: selectSpeechVoices(platform, locale) },
    webrtc: normalizeWebRtc(meta.webrtcMode, meta.webrtcIp),
    timezone: typeof meta.timezone === "string" && meta.timezone ? meta.timezone : null,
    geolocation: normalizeGeolocation(meta),
    mediaDevices: { enabled: true, audioInputs: 1, videoInputs: 1, audioOutputs: 1 },
    fonts: selectStableFonts(seed, platform, locale),
    doNotTrack: "1",
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

/** Validate that advanced fields can resolve to one complete hardware tuple. */
export function validateRoxyHardwareProfile(meta: CloakFingerprintMeta): void {
  selectHardwarePersona(normalizeSeed(meta.fingerprintSeed), normalizePlatform(meta.platform), meta);
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

function deriveWebGpuIdentity(
  webglVendor: string,
  webglRenderer: string,
): RoxyFingerprintConfig["webgpu"] {
  const identity = `${webglVendor} ${webglRenderer}`;
  let vendor = "Google";
  for (const vendor of ["NVIDIA", "AMD", "Apple", "Intel", "Qualcomm", "ARM", "Imagination", "Microsoft", "Google"]) {
    if (new RegExp(`\\b${vendor}\\b`, "i").test(identity)) {
      return {
        mode: "webgl",
        vendor,
        architecture: deriveWebGpuArchitecture(vendor, identity),
        subgroupMinSize: vendor === "Intel" ? 8 : 32,
        subgroupMaxSize: vendor === "AMD" ? 64 : 32,
      };
    }
  }
  return {
    mode: "webgl",
    vendor,
    architecture: "",
    subgroupMinSize: 32,
    subgroupMaxSize: 32,
  };
}

function deriveWebGpuArchitecture(vendor: string, identity: string): string {
  if (vendor === "Apple") return "metal-3";
  if (vendor === "NVIDIA") return /RTX\s*40/i.test(identity) ? "Lovelace" : "Ampere";
  if (vendor === "Intel") return /Iris|Xe/i.test(identity) ? "Gen 12 LP" : "Gen 9";
  if (vendor === "AMD") return "RDNA 2";
  if (vendor === "Qualcomm") return "Adreno 7xx";
  return "";
}

function selectSpeechVoices(
  platform: "Win32" | "MacIntel",
  locale: string,
): Array<{ name: string; lang: string; localService: boolean }> {
  const language = locale.split("-")[0].toLowerCase();
  const localeKey = locale.toLowerCase();
  const windows: Record<string, string[]> = {
    en: [
      "Microsoft David - English (United States)",
      "Microsoft Mark - English (United States)",
      "Microsoft Zira - English (United States)",
    ],
    "en-gb": [
      "Microsoft George - English (United Kingdom)",
      "Microsoft Hazel - English (United Kingdom)",
      "Microsoft Susan - English (United Kingdom)",
    ],
    ar: ["Microsoft Naayf - Arabic (Saudi Arabia)"],
    de: ["Microsoft Katja - German (Germany)"],
    el: ["Microsoft Stefanos - Greek (Greece)"],
    es: ["Microsoft Helena - Spanish (Spain)"],
    fr: ["Microsoft Hortense - French (France)"],
    it: ["Microsoft Elsa - Italian (Italy)"],
    ja: ["Microsoft Haruka - Japanese (Japan)"],
    ko: ["Microsoft Heami - Korean (Korea)"],
    pt: ["Microsoft Maria - Portuguese (Brazil)"],
    ru: ["Microsoft Irina - Russian (Russia)"],
    th: ["Microsoft Pattara - Thai (Thailand)"],
    vi: ["Microsoft An - Vietnamese (Vietnam)"],
    zh: ["Microsoft Huihui - Chinese (Simplified, PRC)"],
    "zh-tw": ["Microsoft Hanhan - Chinese (Traditional, Taiwan)"],
  };
  const mac: Record<string, string[]> = {
    en: ["Samantha", "Alex"],
    "en-gb": ["Daniel", "Kate"],
    ar: ["Maged"],
    de: ["Anna"],
    el: ["Melina"],
    es: ["Monica"],
    fr: ["Thomas"],
    it: ["Alice"],
    ja: ["Kyoko"],
    ko: ["Yuna"],
    pt: ["Joana"],
    ru: ["Milena"],
    th: ["Kanya"],
    vi: ["Linh"],
    zh: ["Tingting"],
    "zh-tw": ["Mei-Jia"],
  };
  const voices = platform === "Win32" ? windows : mac;
  const names = voices[localeKey] || voices[language] || voices.en;
  return names.map((name) => ({ name, lang: locale, localService: true }));
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

function normalizeWebRtc(
  requestedMode: WebRtcMode | undefined,
  publicIp: string | null | undefined,
): RoxyFingerprintConfig["webrtc"] {
  const mode = requestedMode || (publicIp ? "altered" : "auto");
  if (mode === "disable") return { mode: "disable", publicIp: null };
  if (mode === "real") return { mode: "real", publicIp: null };
  if (publicIp) return { mode: "altered", publicIp };
  return mode === "altered"
    ? { mode: "altered", publicIp: null }
    : { mode: "real", publicIp: null };
}

function normalizeFiniteNumber(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return number;
}

function selectHardwarePersona(
  seed: number,
  platform: "Win32" | "MacIntel",
  meta: CloakFingerprintMeta,
): { persona: HardwarePersona; source: "seeded" | "validated-override" } {
  const personas = platform === "MacIntel" ? MAC_HARDWARE_PERSONAS : WINDOWS_HARDWARE_PERSONAS;
  const numericConstraints = [
    ["hardwareConcurrency", "hardwareConcurrency"],
    ["deviceMemory", "deviceMemory"],
    ["screenWidth", "screenWidth"],
    ["screenHeight", "screenHeight"],
    ["taskbarHeight", "taskbarHeight"],
  ] as const;
  const hasValue = (value: unknown): boolean => value !== undefined && value !== null && value !== "";
  const hasOverrides = numericConstraints.some(([metaKey]) => hasValue(meta[metaKey])) ||
    hasValue(meta.gpuVendor) || hasValue(meta.gpuRenderer);
  if (!hasOverrides) {
    return { persona: personas[Math.abs(seed) % personas.length], source: "seeded" };
  }

  const candidates = personas.filter((persona) => {
    for (const [metaKey, personaKey] of numericConstraints) {
      const requested = meta[metaKey];
      if (!hasValue(requested)) continue;
      if (!Number.isInteger(requested) || Number(requested) !== persona[personaKey]) return false;
    }
    if (hasValue(meta.gpuVendor) && String(meta.gpuVendor).trim() !== persona.gpuVendor) return false;
    if (hasValue(meta.gpuRenderer) && String(meta.gpuRenderer).trim() !== persona.gpuRenderer) return false;
    return true;
  });
  if (candidates.length === 0) {
    const requested = [
      ...numericConstraints
        .filter(([metaKey]) => hasValue(meta[metaKey]))
        .map(([metaKey]) => `${metaKey}=${JSON.stringify(meta[metaKey])}`),
      ...(hasValue(meta.gpuVendor) ? [`gpuVendor=${JSON.stringify(meta.gpuVendor)}`] : []),
      ...(hasValue(meta.gpuRenderer) ? [`gpuRenderer=${JSON.stringify(meta.gpuRenderer)}`] : []),
    ];
    throw new Error(
      `Incoherent advanced hardware overrides for ${platform}: ${requested.join(", ")}. ` +
      `Use one supported joint profile (${personas.map((persona) => persona.id).join(", ")}) or clear the overrides.`,
    );
  }
  return {
    persona: candidates[Math.abs(seed) % candidates.length],
    source: "validated-override",
  };
}

function deriveSeed(seed: number, surface: string): string {
  return createHash("sha256").update(`${seed}:${surface}`).digest("hex").slice(0, 16);
}

function selectStableFonts(seed: number, platform: "Win32" | "MacIntel", locale: string): string[] {
  if (platform === "Win32") {
    return [...new Set(stableShuffle(PORTABLE_WINDOWS_FONT_POOL, seed))].sort();
  }
  const pool = stableShuffle(MAC_FONT_POOL, seed);
  const selected = /^(zh|ja|ko)(-|$)/i.test(locale)
    ? [...REQUIRED_MAC_FONT_POOL, ...pool.slice(0, 12), ...stableShuffle(MAC_CJK_FONT_POOL, seed ^ 0x7f4a7c15)]
    : [...REQUIRED_MAC_FONT_POOL, ...pool.slice(0, 15)];
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
