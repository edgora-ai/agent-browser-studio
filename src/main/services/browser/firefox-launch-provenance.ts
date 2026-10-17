import { createHmac, randomBytes } from "node:crypto";
import type { BrowserProfileMeta, ProxyConfig } from "../../types.js";

// Firefox has no native launch-stamp switch. Evidence belongs only to this
// Studio process; an app restart must not adopt an unverifiable old session.
// A per-process HMAC also binds credential changes without persisting a value
// or exposing an offline password-verification digest.
const intentKey = randomBytes(32);

interface FirefoxRequestConfig {
  defaultProxy?: string | null;
  proxies?: Record<string, ProxyConfig>;
  managedSecureDnsUrl?: unknown;
  blockOnFingerprintDrift?: boolean;
  blockOnEnvironmentRisk?: boolean;
  blockOnInjectionProbe?: boolean;
  blockOnUnhealthyProxy?: boolean;
}

export interface FirefoxRequestOptions {
  headless?: boolean;
  binaryOverride?: string | null;
  managedRoot: string;
  nativeRequested: boolean;
}

function proxyIntent(proxy: ProxyConfig | null | undefined): unknown {
  if (!proxy) return null;
  return {
    type: proxy.type, host: proxy.host, port: proxy.port,
    username: proxy.username ?? null, password: proxy.password ?? null,
    bypassList: proxy.bypassList ?? [],
  };
}

export function firefoxLaunchDigest(value: string | Uint8Array): string {
  return createHmac("sha256", intentKey).update(value).digest("hex");
}

/** Pure cached intent, before any binary/version/proxy or profile-file I/O. */
export function firefoxLaunchRequestHash(
  meta: BrowserProfileMeta,
  cfg: FirefoxRequestConfig,
  options: FirefoxRequestOptions,
): string {
  const mode = meta.fingerprintMode === "off" ? "off" : "managed";
  const proxyMode = meta.proxyMode || (meta.proxyName ? "named" : "none");
  const proxyName = proxyMode === "default" ? cfg.defaultProxy : proxyMode === "named" ? meta.proxyName : null;
  const proxy = proxyName && cfg.proxies && Object.hasOwn(cfg.proxies, proxyName) ? cfg.proxies[proxyName] : null;
  return firefoxLaunchDigest(JSON.stringify({
    policy: "firefox-owned-launch-v1",
    engine: meta.engine ?? "chromium", mode,
    browserVersion: meta.browserVersion ?? null,
    binaryOverride: options.binaryOverride ?? null,
    managedRoot: options.managedRoot,
    nativeRequested: mode === "managed" && options.nativeRequested,
    headless: options.headless === true,
    // The Firefox argument builder currently uses the profile platform for
    // its platform-specific flags even with fingerprint identity disabled.
    launchPlatform: meta.platform ?? null,
    appUrl: meta.appUrl ?? null,
    allowThirdPartyCookies: meta.allowThirdPartyCookies === true,
    identity: mode === "off" ? null : {
      seed: meta.fingerprintSeed,
      locale: meta.locale ?? null, timezone: meta.timezone ?? null,
      webrtcMode: meta.webrtcMode ?? null, webrtcIp: meta.webrtcIp ?? null,
      geolocationMode: meta.geolocationMode ?? null,
      geolocationLatitude: meta.geolocationLatitude ?? null,
      geolocationLongitude: meta.geolocationLongitude ?? null,
      geolocationAccuracy: meta.geolocationAccuracy ?? null,
      gpuVendor: meta.gpuVendor ?? null, gpuRenderer: meta.gpuRenderer ?? null,
      hardwareConcurrency: meta.hardwareConcurrency ?? null,
      deviceMemory: meta.deviceMemory ?? null,
      screenWidth: meta.screenWidth ?? null, screenHeight: meta.screenHeight ?? null,
      storageQuota: meta.storageQuota ?? null, taskbarHeight: meta.taskbarHeight ?? null,
      fontsDir: meta.fontsDir ?? null, renderScaleMode: meta.renderScaleMode ?? null,
      baseline: meta.fingerprintBaseline ?? null,
    },
    proxyMode, proxyName: proxyName ?? null, proxy: proxyIntent(proxy),
    fallbacks: (proxy?.fallbacks || []).map(name => proxyIntent(cfg.proxies?.[name])),
    doh: cfg.managedSecureDnsUrl ?? null,
    gates: [cfg.blockOnFingerprintDrift, cfg.blockOnEnvironmentRisk,
      cfg.blockOnInjectionProbe, cfg.blockOnUnhealthyProxy].map(value => value ?? null),
  }));
}
