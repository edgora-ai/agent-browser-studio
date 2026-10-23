import type { ProxyDetectionCacheEntry } from "../types.js";
import { captureProxyDetectionTarget } from "./config-manager.js";
import { proxyTargetDetails, transactProxyObservation, ProxyDetectionCommitError, type ProxyDetectionTarget } from "./config/store.js";
import { proxyDetector, type ProxyDetectionResult, type ProxyDetectionCachePolicy } from "./proxy-detector.js";
import { cloneProxyObservation, readProxyObservation } from "./proxy-observation.js";
import { computeBindings, reduceProxyDetection } from "./proxy-health.js";
import { decryptSecretOr } from "./secrets.js";

export { captureProxyDetectionTarget };
export type { ProxyDetectionTarget };

/** This key is main-only and must never enter DTOs/logs. Lifecycle and cache
 * request generations are intentionally different mechanisms. */
export function proxyDetectionTargetKey(target: ProxyDetectionTarget, policy: ProxyDetectionCachePolicy): string {
  const details = proxyTargetDetails(target);
  return JSON.stringify([details.name, details.identity, details.generation, policy]);
}
const inflight = new Map<string, Promise<ProxyDetectionResult>>();
export async function detectProxyTarget(target: ProxyDetectionTarget, policy: ProxyDetectionCachePolicy = "prefer-cache",
  signal?: AbortSignal): Promise<ProxyDetectionResult> {
  const key = proxyDetectionTargetKey(target, policy);
  // A cancelled consumer must not inherit another caller's authenticated
  // success, or invalidate its reusable cache. The detector's pre-abort path
  // returns an explicit unknown sample without credentials/decryption/dispatch.
  const canceled = () => proxyDetector.detect(proxyTargetDetails(target).config, { cachePolicy: policy, signal });
  if (signal?.aborted) return canceled();
  let pending = inflight.get(key);
  if (!pending) {
    const { config } = proxyTargetDetails(target);
    if (config.username && config.password) config.password = decryptSecretOr(config.password);
    pending = proxyDetector.detect(config, { cachePolicy: policy, ...(signal ? { signal } : {}) });
    inflight.set(key, pending);
    const own = pending;
    void pending.finally(() => { if (inflight.get(key) === own) inflight.delete(key); }).catch(() => { /* original rejection is returned to every caller */ });
  }
  const result = await pending;
  return signal?.aborted ? canceled() : cloneProxyObservation(result);
}

function observedTimezone(timezone: string | null): string | null {
  if (!timezone || /^[+-]/.test(timezone)) return null;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone; }
  catch { return null; /* unusable provider field, not a new observation */ }
}
function detectionEntry(result: Readonly<ProxyDetectionResult>): ProxyDetectionCacheEntry {
  return {
    detectedAt: result.observedAt, source: result.source, observationId: result.observationId,
    success: result.success, exitIp: result.exitIp, country: result.country || result.countryCode,
    countryCode: result.countryCode, timezone: result.timezone, provider: result.provider, latencyMs: result.latencyMs,
    org: result.org, as: result.as, hosting: result.hosting, isProxy: result.isProxy, error: result.error,
  };
}
/** Authentication ignores serialized frontend claims. One live-base transaction
 * validates lifecycle/identity/order before either projection may be written. */
export function commitProxyDetectionIfCurrent(target: ProxyDetectionTarget, result: ProxyDetectionResult): "committed" | "duplicate" {
  const stamp = readProxyObservation(result);
  if (!stamp) throw new ProxyDetectionCommitError("PROXY_DETECTION_UNOBSERVED");
  const { name } = proxyTargetDetails(target);
  return transactProxyObservation(target, stamp, draft => {
    const observed = { ...stamp.result, timezone: observedTimezone(stamp.result.timezone) };
    draft.proxyDetections = { ...draft.proxyDetections, [name]: detectionEntry(observed) };
    // A cached observation may populate its informational projection, but is
    // never another check/success and cannot clear failure cooldown.
    if (observed.source === "network" && observed.observedAt !== null) {
      draft.proxyHealth = { ...draft.proxyHealth, [name]: reduceProxyDetection(name, draft.proxyHealth?.[name] || null,
        observed, observed.observedAt, computeBindings(name, draft)) };
    }
  });
}
