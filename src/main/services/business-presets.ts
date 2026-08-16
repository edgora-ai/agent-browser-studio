// Business one-click presets (RoxyBrowser 3.8.7 "one-click environment setup"
// parity, deepened for this project).
//
// A preset is a coherent full identity — platform / timezone / locale / WebRTC
// / custom geolocation / tags — for one target business + region, plus a proxy
// region hint and recommended launch gates. The main process applies the
// preset authoritatively at create time, so a profile created from a preset can
// never carry a partial or internally incoherent identity. Unlike RoxyBrowser's
// presets (which prefill a fingerprint and suggest a premium IP), each preset
// here also derives a self-consistent identity set and is validated by the same
// launch-time safety gates used across the app.
import type { BrowserPlatform, GeolocationMode, WebRtcMode } from "../types.js";

export type BusinessPresetCategory = "ecommerce" | "social" | "ads" | "ai" | "crypto";

export interface BusinessPresetProfile {
  platform: BrowserPlatform;
  timezone: string;
  locale: string;
  webrtcMode: WebRtcMode;
  geolocationMode: GeolocationMode;
  geolocationLatitude: number;
  geolocationLongitude: number;
  geolocationAccuracy: number;
  tags: string[];
}

export interface BusinessPreset {
  id: string;
  icon: string;
  category: BusinessPresetCategory;
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  region: string;
  regionZh: string;
  nameSuffix: string;
  proxyHint: string;
  proxyHintZh: string;
  /** Informational only: launch gates are global settings, surfaced as a hint. */
  recommendedGates: {
    blockOnConsistencyConflict: boolean;
    blockOnProxyRisk: boolean;
    blockOnEnvironmentRisk: boolean;
  };
  profile: BusinessPresetProfile;
}

const CATALOG: BusinessPreset[] = [
  {
    id: "tiktok-shop-us",
    icon: "🎵",
    category: "ecommerce",
    name: "TikTok Shop US",
    nameZh: "TikTok Shop 美国站",
    description: "TikTok Shop US storefront operation (e-commerce + social).",
    descriptionZh: "TikTok Shop 美国站店铺运营（电商 + 社媒一体）。",
    region: "United States",
    regionZh: "美国",
    nameSuffix: "TikTok Shop US",
    proxyHint: "US residential / non-IDC exit",
    proxyHintZh: "美国住宅 / 非机房出口",
    recommendedGates: { blockOnConsistencyConflict: true, blockOnProxyRisk: true, blockOnEnvironmentRisk: true },
    profile: {
      platform: "windows", timezone: "America/Los_Angeles", locale: "en-US", webrtcMode: "auto",
      geolocationMode: "custom", geolocationLatitude: 34.0522, geolocationLongitude: -118.2437, geolocationAccuracy: 100,
      tags: ["tiktok", "ecommerce", "us"],
    },
  },
  {
    id: "amazon-seller-us",
    icon: "📦",
    category: "ecommerce",
    name: "Amazon Seller US",
    nameZh: "Amazon 美国卖家",
    description: "Amazon US marketplace seller account operation.",
    descriptionZh: "Amazon 美国站卖家账号运营。",
    region: "United States",
    regionZh: "美国",
    nameSuffix: "Amazon Seller US",
    proxyHint: "US residential / non-IDC exit",
    proxyHintZh: "美国住宅 / 非机房出口",
    recommendedGates: { blockOnConsistencyConflict: true, blockOnProxyRisk: true, blockOnEnvironmentRisk: true },
    profile: {
      platform: "windows", timezone: "America/New_York", locale: "en-US", webrtcMode: "auto",
      geolocationMode: "custom", geolocationLatitude: 40.7128, geolocationLongitude: -74.006, geolocationAccuracy: 100,
      tags: ["amazon", "ecommerce", "us"],
    },
  },
  {
    id: "facebook-ads-us",
    icon: "📣",
    category: "ads",
    name: "Facebook / IG Ads US",
    nameZh: "Facebook / IG 广告投放（美国）",
    description: "Facebook & Instagram ads account warming and delivery.",
    descriptionZh: "Facebook / Instagram 广告账户养号与投放。",
    region: "United States",
    regionZh: "美国",
    nameSuffix: "FB Ads US",
    proxyHint: "US residential / non-IDC exit",
    proxyHintZh: "美国住宅 / 非机房出口",
    recommendedGates: { blockOnConsistencyConflict: true, blockOnProxyRisk: true, blockOnEnvironmentRisk: true },
    profile: {
      platform: "windows", timezone: "America/Chicago", locale: "en-US", webrtcMode: "auto",
      geolocationMode: "custom", geolocationLatitude: 41.8781, geolocationLongitude: -87.6298, geolocationAccuracy: 100,
      tags: ["facebook", "instagram", "ads", "us"],
    },
  },
  {
    id: "instagram-matrix-us",
    icon: "📸",
    category: "social",
    name: "Instagram Matrix US",
    nameZh: "Instagram 社媒矩阵（美国）",
    description: "Multi-account Instagram matrix operation with isolated identities.",
    descriptionZh: "Instagram 多账号矩阵运营，身份相互隔离。",
    region: "United States",
    regionZh: "美国",
    nameSuffix: "IG Matrix US",
    proxyHint: "US residential / non-IDC exit, per-account dedicated",
    proxyHintZh: "美国住宅 / 非机房出口，账号间独立",
    recommendedGates: { blockOnConsistencyConflict: true, blockOnProxyRisk: true, blockOnEnvironmentRisk: true },
    profile: {
      platform: "windows", timezone: "America/Los_Angeles", locale: "en-US", webrtcMode: "auto",
      geolocationMode: "custom", geolocationLatitude: 34.0522, geolocationLongitude: -118.2437, geolocationAccuracy: 100,
      tags: ["instagram", "social", "matrix", "us"],
    },
  },
  {
    id: "ebay-uk",
    icon: "🏷️",
    category: "ecommerce",
    name: "eBay UK",
    nameZh: "eBay 英国站",
    description: "eBay UK marketplace seller account operation.",
    descriptionZh: "eBay 英国站卖家账号运营。",
    region: "United Kingdom",
    regionZh: "英国",
    nameSuffix: "eBay UK",
    proxyHint: "UK residential / non-IDC exit",
    proxyHintZh: "英国住宅 / 非机房出口",
    recommendedGates: { blockOnConsistencyConflict: true, blockOnProxyRisk: true, blockOnEnvironmentRisk: true },
    profile: {
      platform: "windows", timezone: "Europe/London", locale: "en-GB", webrtcMode: "auto",
      geolocationMode: "custom", geolocationLatitude: 51.5074, geolocationLongitude: -0.1278, geolocationAccuracy: 100,
      tags: ["ebay", "ecommerce", "uk"],
    },
  },
  {
    id: "ecommerce-de",
    icon: "🛒",
    category: "ecommerce",
    name: "EU E-commerce (DE)",
    nameZh: "欧盟电商（德国）",
    description: "EU marketplace operation with a German identity.",
    descriptionZh: "欧盟平台运营，使用德国本地身份。",
    region: "Germany / EU",
    regionZh: "德国 / 欧盟",
    nameSuffix: "EU Shop DE",
    proxyHint: "DE / EU residential, non-IDC exit",
    proxyHintZh: "德国 / 欧盟住宅，非机房出口",
    recommendedGates: { blockOnConsistencyConflict: true, blockOnProxyRisk: true, blockOnEnvironmentRisk: true },
    profile: {
      platform: "windows", timezone: "Europe/Berlin", locale: "de-DE", webrtcMode: "auto",
      geolocationMode: "custom", geolocationLatitude: 52.52, geolocationLongitude: 13.405, geolocationAccuracy: 100,
      tags: ["ecommerce", "eu", "de"],
    },
  },
  {
    id: "ai-automation-us",
    icon: "🤖",
    category: "ai",
    name: "AI Automation Workbench",
    nameZh: "AI 自动化工作台",
    description: "Headless-friendly AI / scraping / automation profile.",
    descriptionZh: "面向 AI 采集与自动化的工作台环境。",
    region: "United States",
    regionZh: "美国",
    nameSuffix: "AI Workbench",
    proxyHint: "US residential or low-risk datacenter for non-account work",
    proxyHintZh: "美国住宅或低风险机房（非账号场景）",
    recommendedGates: { blockOnConsistencyConflict: true, blockOnProxyRisk: false, blockOnEnvironmentRisk: true },
    profile: {
      platform: "windows", timezone: "America/New_York", locale: "en-US", webrtcMode: "auto",
      geolocationMode: "custom", geolocationLatitude: 40.7128, geolocationLongitude: -74.006, geolocationAccuracy: 100,
      tags: ["ai", "automation", "us"],
    },
  },
  {
    id: "crypto-sg",
    icon: "🪙",
    category: "crypto",
    name: "Crypto Exchange (SG)",
    nameZh: "加密交易所（新加坡）",
    description: "Crypto exchange account with a Singapore identity.",
    descriptionZh: "加密交易所账号，使用新加坡本地身份。",
    region: "Singapore",
    regionZh: "新加坡",
    nameSuffix: "Crypto SG",
    proxyHint: "SG residential, stable single exit",
    proxyHintZh: "新加坡住宅，固定单一出口",
    recommendedGates: { blockOnConsistencyConflict: true, blockOnProxyRisk: true, blockOnEnvironmentRisk: true },
    profile: {
      platform: "windows", timezone: "Asia/Singapore", locale: "en-SG", webrtcMode: "auto",
      geolocationMode: "custom", geolocationLatitude: 1.3521, geolocationLongitude: 103.8198, geolocationAccuracy: 100,
      tags: ["crypto", "exchange", "sg"],
    },
  },
];

export function listBusinessPresets(): BusinessPreset[] {
  return CATALOG.map((p) => structuredClone(p));
}

export function resolveBusinessPreset(id: string): BusinessPreset {
  const preset = CATALOG.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown business preset: ${id}`);
  return structuredClone(preset);
}

/**
 * Map a preset to the subset of createBrowserProfile options it supplies, so
 * the main process can apply it authoritatively alongside explicit user fields.
 */
export function presetProfileToCreateOpts(preset: BusinessPreset): {
  platform: BrowserPlatform;
  timezone: string;
  locale: string;
  webrtcMode: WebRtcMode;
  geolocationMode: GeolocationMode;
  geolocationLatitude: number;
  geolocationLongitude: number;
  geolocationAccuracy: number;
  tags: string[];
} {
  return {
    platform: preset.profile.platform,
    timezone: preset.profile.timezone,
    locale: preset.profile.locale,
    webrtcMode: preset.profile.webrtcMode,
    geolocationMode: preset.profile.geolocationMode,
    geolocationLatitude: preset.profile.geolocationLatitude,
    geolocationLongitude: preset.profile.geolocationLongitude,
    geolocationAccuracy: preset.profile.geolocationAccuracy,
    tags: [...preset.profile.tags],
  };
}
