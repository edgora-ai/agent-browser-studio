import { ipcMain } from "electron";
import { proxyDetector } from "../services/proxy-detector.js";
import { captureProxyDetectionTarget, commitProxyDetectionIfCurrent, detectProxyTarget, proxyDetectionTargetKey } from "../services/proxy-detection.js";
import { ProxyDetectionCommitError } from "../services/config/store.js";
import { webrtcDetector } from "../services/webrtc-detector.js";
import { withTimeout } from "../services/job-guard.js";
import type { ProxyConfig } from "../types.js";

// Share a complete named operation, not only transport: one physical fresh
// measurement has one persistence attempt/sample and one truthful IPC outcome.
const inflightDetections = new Map<string, Promise<unknown>>();
function dedupeDetection<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflightDetections.get(key);
  if (existing) return existing as Promise<T>;
  const pending = fn().finally(() => {
    if (inflightDetections.get(key) === pending) inflightDetections.delete(key);
  });
  inflightDetections.set(key, pending);
  return pending;
}
const DETECT_TIMEOUT_MS = 25_000;

export function registerDetectHandlers(): void {
  ipcMain.handle("detect:proxy", async (_event, config: ProxyConfig) => {
    return withTimeout(signal => proxyDetector.detect(config, { signal, cachePolicy: "refresh" }), DETECT_TIMEOUT_MS, "detect:proxy");
  });
  ipcMain.handle("detect:proxy-ping", async (_event, config: ProxyConfig) => {
    return withTimeout(signal => proxyDetector.ping(config, { signal }), DETECT_TIMEOUT_MS, "detect:proxy-ping");
  });
  ipcMain.handle("detect:proxy-by-name", async (_event, name: string) => {
    // Capture committed identity/lifecycle BEFORE dedupe and before any await.
    const target = captureProxyDetectionTarget(name);
    if (!target) return { success: false, error: "Proxy not found", code: "PROXY_DETECTION_TARGET_CHANGED" };
    const result = await dedupeDetection(proxyDetectionTargetKey(target, "refresh"), async () => {
      const detected = await withTimeout(signal => detectProxyTarget(target, "refresh", signal), DETECT_TIMEOUT_MS, "detect:proxy-by-name");
      // Aborted/not-dispatched results have no authenticated sample to save.
      if (detected.source === "unknown") return detected;
      try { commitProxyDetectionIfCurrent(target, detected); }
      catch (error) {
        const code = error instanceof ProxyDetectionCommitError ? error.code : "PROXY_DETECTION_SAVE_FAILED";
        return { ...detected, success: false, code, error: code };
      }
      return detected;
    });
    // Electron clones too, but direct main callers must not share a result.
    return structuredClone(result);
  });
  ipcMain.handle("detect:webrtc-leak", async (_event, config: ProxyConfig) => {
    return withTimeout(signal => webrtcDetector.detect(config, { signal }), DETECT_TIMEOUT_MS, "detect:webrtc-leak");
  });
}
