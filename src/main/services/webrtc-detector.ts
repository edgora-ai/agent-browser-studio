// A proxy configuration is not a browser WebRTC observation. Keep the legacy
// IPC result explicit instead of relabelling HTTP IP lookups as STUN/DNS tests.
import { tMain } from "./main-i18n.js";
import type { ProxyConfig } from "../types.js";

export interface WebRtcLeakResult {
  success: boolean;
  outcome: "unavailable" | "cancelled";
  code: "BROWSER_PROFILE_REQUIRED" | "HEALTH_CANCELLED";
  webRtcIps: string[];
  stunIps: string[];
  dnsLeakIps: string[];
  /** Null means no browser leak measurement was performed. */
  hasLeak: boolean | null;
  summary: string;
  error: string | null;
}

export const webrtcDetector = {
  async detect(_config: ProxyConfig, opts?: { signal?: AbortSignal }): Promise<WebRtcLeakResult> {
    const cancelled = opts?.signal?.aborted === true;
    return {
      success: false,
      outcome: cancelled ? "cancelled" : "unavailable",
      code: cancelled ? "HEALTH_CANCELLED" : "BROWSER_PROFILE_REQUIRED",
      webRtcIps: [], stunIps: [], dnsLeakIps: [], hasLeak: null,
      summary: tMain("webrtc.legacy.profile-required", "WebRTC and DNS leaks were not measured. Run the in-browser diagnostic on a running profile; HTTP IP lookups cannot verify ICE or UDP routing."),
      error: cancelled ? "aborted" : "BROWSER_PROFILE_REQUIRED",
    };
  },
};
