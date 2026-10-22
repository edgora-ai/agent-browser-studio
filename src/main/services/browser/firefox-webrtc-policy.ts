import { createHash } from "node:crypto";
import type { WebRtcMode } from "../../types.js";

/** Bump when Firefox's engine-preference/default semantics change. */
export const FIREFOX_WEBRTC_ROUTING_POLICY_VERSION = 1;

export interface FirefoxWebRtcRoutingInput {
  requestedMode: WebRtcMode;
  fingerprintMode: "managed" | "off";
  /** The resolved upstream proxy; Firefox's own proxy config decides use. */
  hasProxy: boolean;
  webrtcIp?: string | null;
}

export interface FirefoxWebRtcRoutingPolicy {
  version: typeof FIREFOX_WEBRTC_ROUTING_POLICY_VERSION;
  fingerprintMode: "managed" | "off";
  requestedMode: WebRtcMode;
  effectiveMode: Exclude<WebRtcMode, "auto">;
  hasProxy: boolean;
  /**
   * Firefox `media.peerconnection.ice.proxy_only`. Unlike Chromium's
   * disable_non_proxied_udp, this does not itself ban direct UDP; it forces
   * ICE to use the browser's proxy configuration. Availability therefore
   * depends on a usable proxy for WebRTC, not on this flag alone.
   */
  forceProxy: boolean;
  obfuscateHostAddresses: boolean;
  /** Managed `disable` removes the RTCPeerConnection API itself. */
  disablePeerConnectionApi: boolean;
  /**
   * Firefox's WebRTC proxy path is TCP (`WebrtcTCPSocket`), not SOCKS UDP
   * ASSOCIATE. UDP remains unverified/unsupported here regardless of pref.
   */
  socksUdpAvailable: false;
}

export class FirefoxWebRtcPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FirefoxWebRtcPolicyError";
  }
}

/**
 * Pure launch decision. Managed keeps Firefox's established leak-avoidance
 * defaults; explicit Real opts out. Fingerprint-off must not silently become
 * Real: with a proxy, Auto/Proxy-only still force the proxy path.
 */
export function resolveFirefoxWebRtcRoutingPolicy(input: FirefoxWebRtcRoutingInput): FirefoxWebRtcRoutingPolicy {
  const { requestedMode, fingerprintMode, hasProxy } = input;
  if (!["auto", "proxy-only", "real", "altered", "disable"].includes(requestedMode)) {
    throw new FirefoxWebRtcPolicyError("webrtc-routing-policy", "Invalid Firefox WebRTC routing mode");
  }
  const effectiveMode = requestedMode === "auto" ? (hasProxy ? "proxy-only" : "real") : requestedMode;
  if (effectiveMode === "proxy-only" && !hasProxy) {
    throw new FirefoxWebRtcPolicyError("webrtc-proxy-required", "Firefox WebRTC proxy-only mode requires a resolved upstream proxy; direct fallback is not permitted");
  }
  if (fingerprintMode === "off" && (effectiveMode === "altered" || effectiveMode === "disable")) {
    throw new FirefoxWebRtcPolicyError("webrtc-managed-required", "Firefox WebRTC altered/disable mode requires managed fingerprint mode; fingerprint-off cannot apply the managed ICE policy. Select Auto/proxy-only routing or explicitly select Real.");
  }
  if (effectiveMode === "altered") {
    // Firefox has no parallel native address-rewrite channel here. Refusing is
    // truthful; pretending to rewrite would change no ICE traffic.
    throw new FirefoxWebRtcPolicyError("webrtc-altered-unsupported", "Firefox does not implement managed WebRTC address replacement; choose Proxy-only, Real or Disabled.");
  }
  return {
    version: FIREFOX_WEBRTC_ROUTING_POLICY_VERSION,
    fingerprintMode,
    requestedMode,
    effectiveMode,
    hasProxy,
    // Managed: Firefox's established default is proxy-only ICE. Explicit Real
    // disables it; fingerprint-off with a proxy keeps the restriction.
    forceProxy: effectiveMode === "proxy-only",
    obfuscateHostAddresses: effectiveMode !== "disable",
    disablePeerConnectionApi: effectiveMode === "disable",
    socksUdpAvailable: false,
  };
}

/** Digest of the exact pref values a route applies. The state stores only this
 * hash, so reusing a process can be checked against what it actually loaded
 * without persisting user preference values or credentials. */
export function firefoxWebRtcCheckpointHash(policy: FirefoxWebRtcRoutingPolicy): string {
  const applied = policy.disablePeerConnectionApi
    ? { v: 1, enabled: false, proxyOnly: null, obfuscate: null }
    : policy.forceProxy
      ? { v: 1, enabled: null, proxyOnly: true, obfuscate: policy.obfuscateHostAddresses }
      : policy.hasProxy
        ? { v: 1, enabled: null, proxyOnly: null, obfuscate: null }
        : { v: 1, enabled: null, proxyOnly: false, obfuscate: false };
  return createHash("sha256").update(JSON.stringify(applied)).digest("hex");
}

/** Check a stored checkpoint against the currently requested policy. */
export function firefoxWebRtcCheckpointMatches(stored: string | null | undefined, policy: FirefoxWebRtcRoutingPolicy): boolean {
  return typeof stored === "string" && stored === firefoxWebRtcCheckpointHash(policy);
}
