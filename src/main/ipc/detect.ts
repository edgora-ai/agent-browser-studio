import { ipcMain } from "electron";
import { proxyDetector, type ProxyDetectionResult } from "../services/proxy-detector.js";
import { recordProxyDetection } from "../services/proxy-health.js";
import { webrtcDetector } from "../services/webrtc-detector.js";
import { getProxySecret, setProxyDetectionIfCurrent } from "../services/config-manager.js";
import type { ProxyConfig, ProxyDetectionCacheEntry } from "../types.js";

function cacheEntryFromDetection(result: ProxyDetectionResult): ProxyDetectionCacheEntry {
  return {
    detectedAt: Date.now(),
    success: Boolean(result?.success),
    exitIp: result?.exitIp || null,
    country: result?.country || result?.countryCode || null,
    countryCode: result?.countryCode || null,
    timezone: result?.timezone || null,
    provider: result?.provider || null,
    latencyMs: typeof result?.latencyMs === "number" ? result.latencyMs : null,
    org: result?.org || null,
    as: result?.as || null,
    hosting: result?.hosting ?? null,
    isProxy: result?.isProxy ?? null,
    error: result?.error || null,
  };
}

export function registerDetectHandlers(): void {
  ipcMain.handle("detect:proxy", async (_event, config: ProxyConfig) => {
    return proxyDetector.detect(config);
  });

  ipcMain.handle("detect:proxy-ping", async (_event, config: ProxyConfig) => {
    return proxyDetector.ping(config);
  });

  ipcMain.handle("detect:proxy-by-name", async (_event, name: string) => {
    const config = getProxySecret(name);
    if (!config) return { success: false, error: "Proxy not found" };
    const result = await proxyDetector.detect(config);
    try {
      setProxyDetectionIfCurrent(name, config, cacheEntryFromDetection(result));
      recordProxyDetection(name, {
        success: Boolean(result?.success),
        exitIp: result?.exitIp || null,
        countryCode: result?.countryCode || null,
        timezone: result?.timezone || null,
        provider: result?.provider || null,
        latencyMs: typeof result?.latencyMs === "number" ? result.latencyMs : null,
        isp: result?.isp || null,
        org: result?.org || null,
        as: result?.as || null,
        hosting: result?.hosting ?? null,
        isProxy: result?.isProxy ?? null,
        error: result?.error || null,
      });
    } catch (e) {
      console.warn(`[detect] failed to persist proxy detection for ${name}:`, e);
    }
    return result;
  });

  ipcMain.handle("detect:webrtc-leak", async (_event, config: ProxyConfig) => {
    return webrtcDetector.detect(config);
  });
}
