import type { WebRtcMode } from "../../types.js";

/** Bump whenever the launcher's WebRTC routing/default semantics change. */
export const CHROMIUM_WEBRTC_ROUTING_POLICY_VERSION = 3;
export const CHROMIUM_WEBRTC_PROFILE_ARG = "--profile-directory=Default";
export const CHROMIUM_WEBRTC_IP_HANDLING_SWITCH = "--force-webrtc-ip-handling-policy";
export const CHROMIUM_WEBRTC_PROXY_ONLY_ARG = `${CHROMIUM_WEBRTC_IP_HANDLING_SWITCH}=disable_non_proxied_udp`;
/** External arguments must not redirect the profile receiving the routing prefs. */
export const CHROMIUM_WEBRTC_PROTECTED_SWITCHES = [CHROMIUM_WEBRTC_IP_HANDLING_SWITCH, "--profile-directory"] as const;

export interface ChromiumWebRtcRoutingInput {
  requestedMode: WebRtcMode;
  fingerprintMode: "managed" | "off";
  /** The resolved upstream proxy, not an exit-IP observation or loopback bridge. */
  hasProxy: boolean;
  /** Validated custom/detected IP; only explicit altered mode consumes it. */
  webrtcIp?: string | null;
}

export interface ChromiumWebRtcRoutingPolicy {
  version: typeof CHROMIUM_WEBRTC_ROUTING_POLICY_VERSION;
  fingerprintMode: "managed" | "off";
  requestedMode: WebRtcMode;
  effectiveMode: Exclude<WebRtcMode, "auto">;
  nativeMode: "real" | "altered" | "disable";
  nativeIp: string | null;
  hasProxy: boolean;
  restrictNonProxiedUdp: boolean;
}

export class WebRtcRoutingPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WebRtcRoutingPolicyError";
  }
}

/** Pure launch decision: proxy-only never depends on Geo-IP or rewrites ICE addresses. */
export function resolveChromiumWebRtcRoutingPolicy(input: ChromiumWebRtcRoutingInput): ChromiumWebRtcRoutingPolicy {
  const { requestedMode, fingerprintMode, hasProxy } = input;
  if (!["auto", "proxy-only", "real", "altered", "disable"].includes(requestedMode)) {
    throw new WebRtcRoutingPolicyError("webrtc-routing-policy", "Invalid WebRTC routing mode");
  }
  const effectiveMode = requestedMode === "auto" ? (hasProxy ? "proxy-only" : "real") : requestedMode;
  if (effectiveMode === "proxy-only" && !hasProxy) {
    throw new WebRtcRoutingPolicyError("webrtc-proxy-required", "WebRTC proxy-only mode requires a resolved upstream proxy; direct fallback is not permitted");
  }
  if (fingerprintMode === "off" && (effectiveMode === "altered" || effectiveMode === "disable")) {
    throw new WebRtcRoutingPolicyError("webrtc-managed-required", "WebRTC altered/disable mode requires managed fingerprint mode; fingerprint-off cannot apply the native ICE policy. Select managed fingerprint mode, or choose Auto/proxy-only routing or explicitly select real WebRTC.");
  }
  const nativeIp = effectiveMode === "altered" ? input.webrtcIp?.trim() || null : null;
  if (effectiveMode === "altered" && !nativeIp) {
    throw new WebRtcRoutingPolicyError("webrtc-ip-required", "WebRTC altered mode requires a custom IP or a proxy with a detectable exit IP");
  }
  return {
    version: CHROMIUM_WEBRTC_ROUTING_POLICY_VERSION,
    fingerprintMode,
    requestedMode,
    effectiveMode,
    // Native real leaves TURN relay addresses intact. Chrome's profile privacy
    // preference enforces routing separately, including fingerprint-off. The
    // similarly named CLI switch alone is not Chrome enforcement evidence.
    nativeMode: effectiveMode === "proxy-only" ? "real" : effectiveMode,
    nativeIp,
    hasProxy,
    restrictNonProxiedUdp: effectiveMode === "proxy-only" || effectiveMode === "altered",
  };
}

export function chromiumWebRtcRoutingArgs(policy: ChromiumWebRtcRoutingPolicy): string[] {
  // Local State's last-used profile must not select an unconfigured Preferences file.
  return [CHROMIUM_WEBRTC_PROFILE_ARG, ...(policy.restrictNonProxiedUdp ? [CHROMIUM_WEBRTC_PROXY_ONLY_ARG] : [])];
}

/** Detect Chromium's alternate switch prefixes too, without accepting them as owned argv. */
export function chromiumWebRtcSwitchName(arg: string): string {
  const key = arg.split("=", 1)[0];
  if (key.startsWith("--")) return key.toLowerCase();
  if (key.startsWith("-") || key.startsWith("/")) return `--${key.slice(1).toLowerCase()}`;
  return key;
}

/**
 * Call after all argument producers, without deduping these switches. Even an
 * identical external routing switch is a second owner and must be refused.
 */
export function assertChromiumWebRtcRoutingArgs(args: readonly string[], policy: ChromiumWebRtcRoutingPolicy): void {
  if (args.includes("--")) {
    throw new WebRtcRoutingPolicyError("webrtc-routing-policy", "A command-line terminator would bypass the launcher's WebRTC routing switches");
  }
  const switchName = chromiumWebRtcSwitchName;
  const profiles = args.filter(arg => switchName(arg) === "--profile-directory");
  if (profiles.length !== 1 || profiles[0] !== CHROMIUM_WEBRTC_PROFILE_ARG) {
    throw new WebRtcRoutingPolicyError("webrtc-routing-policy", "The launched Chrome profile is not uniquely bound to its verified Default routing preferences");
  }
  const routing = args.filter(arg => switchName(arg) === CHROMIUM_WEBRTC_IP_HANDLING_SWITCH);
  const expected = policy.restrictNonProxiedUdp ? [CHROMIUM_WEBRTC_PROXY_ONLY_ARG] : [];
  if (routing.length !== expected.length || routing.some((arg, index) => arg !== expected[index])) {
    throw new WebRtcRoutingPolicyError("webrtc-routing-policy", "WebRTC routing switch is missing, duplicated, externally supplied, or weaker than the launch policy");
  }

  // Legacy native switches can override the JSON channel. Only the launcher's
  // exact altered IP is compatible; proxy-only/real/disable carry no override.
  const nativeOverrides = args.filter(arg => switchName(arg).startsWith("--fingerprint-webrtc"));
  const expectedIpArg = policy.nativeMode === "altered" ? `--fingerprint-webrtc-ip=${policy.nativeIp}` : null;
  if (nativeOverrides.length > 1 || nativeOverrides.some(arg => arg !== expectedIpArg)) {
    throw new WebRtcRoutingPolicyError("webrtc-routing-policy", "Native WebRTC override switches conflict with the resolved launch policy");
  }

  if (policy.effectiveMode === "proxy-only") {
    const proxies = args.filter(arg => switchName(arg) === "--proxy-server");
    const override = args.some(arg => ["--no-proxy-server", "--proxy-auto-detect", "--proxy-pac-url", "--proxy-pac-mandatory"].includes(switchName(arg)));
    const endpoint = proxies.length === 1 && proxies[0].startsWith("--proxy-server=")
      ? /^(?:https?|socks5|quic):\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+):([1-9][0-9]{0,4})$/i.exec(proxies[0].slice("--proxy-server=".length)) : null;
    // A DIRECT entry or proxy fallback list is not a fixed proxy-only route.
    if (!policy.hasProxy || !endpoint || Number(endpoint[1]) > 65535 || override) {
      throw new WebRtcRoutingPolicyError("webrtc-routing-policy", "WebRTC proxy-only launch requires exactly one fixed proxy route and no direct/PAC override");
    }
  }
}
