import { describe, expect, it } from "vitest";
import {
  FIREFOX_WEBRTC_ROUTING_POLICY_VERSION,
  FirefoxWebRtcPolicyError,
  firefoxWebRtcCheckpointHash,
  firefoxWebRtcCheckpointMatches,
  resolveFirefoxWebRtcRoutingPolicy,
  type FirefoxWebRtcRoutingInput,
} from "../../src/main/services/browser/firefox-webrtc-policy.js";

const policy = (input: Partial<FirefoxWebRtcRoutingInput> = {}) =>
  resolveFirefoxWebRtcRoutingPolicy({ requestedMode: "auto", fingerprintMode: "managed", hasProxy: true, ...input });

function refusal(input: Partial<FirefoxWebRtcRoutingInput>, code: string) {
  let error: unknown;
  try { policy(input); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(FirefoxWebRtcPolicyError);
  expect(error).toMatchObject({ code });
}

describe("Firefox WebRTC routing policy", () => {
  it.each([null, "203.0.113.19"])("Auto with a proxy is proxy-only regardless of legacy IP %s", ip => {
    expect(policy({ webrtcIp: ip })).toMatchObject({
      version: FIREFOX_WEBRTC_ROUTING_POLICY_VERSION,
      effectiveMode: "proxy-only", forceProxy: true, obfuscateHostAddresses: true,
      disablePeerConnectionApi: false, socksUdpAvailable: false,
    });
  });

  it("Auto without a proxy is real; explicit proxy-only without a proxy refuses", () => {
    expect(policy({ hasProxy: false })).toMatchObject({ effectiveMode: "real", forceProxy: false, disablePeerConnectionApi: false });
    refusal({ requestedMode: "proxy-only", hasProxy: false }, "webrtc-proxy-required");
  });

  it("fingerprint-off keeps proxy-only routing and never silently becomes Real", () => {
    expect(policy({ fingerprintMode: "off" })).toMatchObject({ effectiveMode: "proxy-only", forceProxy: true });
    expect(policy({ fingerprintMode: "off", requestedMode: "real" })).toMatchObject({ effectiveMode: "real", forceProxy: false });
    expect(policy({ fingerprintMode: "off", hasProxy: false })).toMatchObject({ effectiveMode: "real", forceProxy: false });
    refusal({ fingerprintMode: "off", requestedMode: "proxy-only", hasProxy: false }, "webrtc-proxy-required");
  });

  it("explicit Real disables managed ICE routing even with a proxy", () => {
    expect(policy({ requestedMode: "real" })).toMatchObject({ effectiveMode: "real", forceProxy: false, obfuscateHostAddresses: true });
  });

  it("Disable removes the WebRTC API instead of pretending to rewrite candidates", () => {
    expect(policy({ requestedMode: "disable" })).toMatchObject({ effectiveMode: "disable", forceProxy: false,
      obfuscateHostAddresses: false, disablePeerConnectionApi: true });
    refusal({ requestedMode: "disable", fingerprintMode: "off" }, "webrtc-managed-required");
  });

  it("Altered is refused on Firefox because no engine rewrite channel exists", () => {
    refusal({ requestedMode: "altered", webrtcIp: "203.0.113.19" }, "webrtc-altered-unsupported");
    refusal({ requestedMode: "altered", webrtcIp: null }, "webrtc-altered-unsupported");
  });

  it("rejects unknown stored modes rather than guessing", () => {
    refusal({ requestedMode: "proxy-all-udp" as never }, "webrtc-routing-policy");
  });
});

describe("Firefox WebRTC applied-preference checkpoint", () => {
  it("is stable for the same applied values and changes with the routing decision", () => {
    const proxyOnly = policy(), real = policy({ requestedMode: "real" }), direct = policy({ hasProxy: false });
    expect(firefoxWebRtcCheckpointHash(proxyOnly)).toMatch(/^[a-f0-9]{64}$/);
    expect(firefoxWebRtcCheckpointHash(policy())).toBe(firefoxWebRtcCheckpointHash(proxyOnly));
    const digests = new Set([proxyOnly, real, direct, policy({ requestedMode: "disable" })].map(firefoxWebRtcCheckpointHash));
    expect(digests.size).toBe(4);
  });

  it("matches only an exact stored checkpoint and never a missing/malformed one", () => {
    const current = policy();
    expect(firefoxWebRtcCheckpointMatches(firefoxWebRtcCheckpointHash(current), current)).toBe(true);
    expect(firefoxWebRtcCheckpointMatches(null, current)).toBe(false);
    expect(firefoxWebRtcCheckpointMatches("0".repeat(64), current)).toBe(false);
    expect(firefoxWebRtcCheckpointMatches(firefoxWebRtcCheckpointHash(current), policy({ requestedMode: "real" }))).toBe(false);
  });
});
