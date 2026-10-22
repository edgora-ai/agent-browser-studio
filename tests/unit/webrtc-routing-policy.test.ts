import { describe, expect, it } from "vitest";
import {
  assertChromiumWebRtcRoutingArgs,
  chromiumWebRtcRoutingArgs,
  CHROMIUM_WEBRTC_IP_HANDLING_SWITCH,
  CHROMIUM_WEBRTC_PROTECTED_SWITCHES,
  CHROMIUM_WEBRTC_PROFILE_ARG,
  CHROMIUM_WEBRTC_PROXY_ONLY_ARG,
  CHROMIUM_WEBRTC_ROUTING_POLICY_VERSION,
  resolveChromiumWebRtcRoutingPolicy,
  WebRtcRoutingPolicyError,
  type ChromiumWebRtcRoutingInput,
} from "../../src/main/services/browser/webrtc-policy.js";

// Pure decisions and synthetic argv only: no config, filesystem, DNS, process,
// browser, native-capability or license imports/effects.
const proxyArg = "--proxy-server=http://proxy.example.test:8080";
const ip = "203.0.113.19";

function expectPolicyError(action: () => unknown, code: string) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(WebRtcRoutingPolicyError);
  expect(error).toMatchObject({ code });
  return error as WebRtcRoutingPolicyError;
}

function policy(input: Partial<ChromiumWebRtcRoutingInput> = {}) {
  return resolveChromiumWebRtcRoutingPolicy({ requestedMode: "auto", fingerprintMode: "managed", hasProxy: true, ...input });
}

const proxyOnlyArgs = () => [CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, CHROMIUM_WEBRTC_PROXY_ONLY_ARG];

describe("pure Chromium WebRTC routing matrix", () => {
  it.each([null, ip])("Auto with an upstream proxy uses proxy-only independently of exit IP %s", webrtcIp => {
    const input: ChromiumWebRtcRoutingInput = Object.freeze({ requestedMode: "auto", fingerprintMode: "managed", hasProxy: true, webrtcIp });
    const resolved = resolveChromiumWebRtcRoutingPolicy(input);
    expect(resolved).toMatchObject({
      version: CHROMIUM_WEBRTC_ROUTING_POLICY_VERSION,
      requestedMode: "auto", effectiveMode: "proxy-only", nativeMode: "real", nativeIp: null,
      restrictNonProxiedUdp: true,
    });
    expect(chromiumWebRtcRoutingArgs(resolved)).toEqual([CHROMIUM_WEBRTC_PROFILE_ARG, CHROMIUM_WEBRTC_PROXY_ONLY_ARG]);
    expect(input.webrtcIp).toBe(webrtcIp);
  });

  it.each([null, ip])("Auto without a proxy defaults to real, not a fabricated exit IP %s", webrtcIp => {
    const resolved = policy({ hasProxy: false, webrtcIp });
    expect(resolved).toMatchObject({ effectiveMode: "real", nativeMode: "real", nativeIp: null, restrictNonProxiedUdp: false });
    expect(chromiumWebRtcRoutingArgs(resolved)).toEqual([CHROMIUM_WEBRTC_PROFILE_ARG]);
  });

  it("explicit proxy-only clears an old rewrite IP and still requires a proxy", () => {
    expect(policy({ requestedMode: "proxy-only", webrtcIp: ip })).toMatchObject({ effectiveMode: "proxy-only", nativeMode: "real", nativeIp: null });
    expectPolicyError(() => policy({ requestedMode: "proxy-only", hasProxy: false, webrtcIp: ip }), "webrtc-proxy-required");
  });

  it.each(["managed", "off"] as const)("explicit real retains stock behavior with a proxy in %s mode", fingerprintMode => {
    const resolved = policy({ requestedMode: "real", fingerprintMode, webrtcIp: ip });
    expect(resolved).toMatchObject({ effectiveMode: "real", nativeMode: "real", nativeIp: null, restrictNonProxiedUdp: false });
    expect(chromiumWebRtcRoutingArgs(resolved)).toEqual([CHROMIUM_WEBRTC_PROFILE_ARG]);
  });

  it.each([true, false])("altered with hasProxy=%s needs an IP and continues to restrict non-proxied UDP", hasProxy => {
    expectPolicyError(() => policy({ requestedMode: "altered", hasProxy }), "webrtc-ip-required");
    expectPolicyError(() => policy({ requestedMode: "altered", hasProxy, webrtcIp: " " }), "webrtc-ip-required");
    const resolved = policy({ requestedMode: "altered", hasProxy, webrtcIp: ip });
    expect(resolved).toMatchObject({ effectiveMode: "altered", nativeMode: "altered", nativeIp: ip, restrictNonProxiedUdp: true });
    expect(chromiumWebRtcRoutingArgs(resolved)).toEqual([CHROMIUM_WEBRTC_PROFILE_ARG, CHROMIUM_WEBRTC_PROXY_ONLY_ARG]);
  });

  it.each([true, false])("disable with hasProxy=%s retains the native all-ICE block, not native real", hasProxy => {
    const resolved = policy({ requestedMode: "disable", hasProxy, webrtcIp: ip });
    expect(resolved).toMatchObject({ effectiveMode: "disable", nativeMode: "disable", nativeIp: null });
    expect(chromiumWebRtcRoutingArgs(resolved)).toEqual([CHROMIUM_WEBRTC_PROFILE_ARG]);
  });

  it.each(["auto", "proxy-only"] as const)("fingerprint-off plus %s and a proxy still restricts routing", requestedMode => {
    const resolved = policy({ fingerprintMode: "off", requestedMode, webrtcIp: ip });
    expect(resolved).toMatchObject({ fingerprintMode: "off", effectiveMode: "proxy-only", nativeMode: "real", nativeIp: null, restrictNonProxiedUdp: true });
    expect(chromiumWebRtcRoutingArgs(resolved)).toEqual([CHROMIUM_WEBRTC_PROFILE_ARG, CHROMIUM_WEBRTC_PROXY_ONLY_ARG]);
  });

  it("fingerprint-off Auto without a proxy stays stock; explicit proxy-only without a proxy refuses", () => {
    expect(policy({ fingerprintMode: "off", hasProxy: false })).toMatchObject({ effectiveMode: "real", restrictNonProxiedUdp: false });
    expectPolicyError(() => policy({ fingerprintMode: "off", requestedMode: "proxy-only", hasProxy: false }), "webrtc-proxy-required");
  });

  it.each(["altered", "disable"] as const)("fingerprint-off cannot silently claim native %s enforcement", requestedMode => {
    const error = expectPolicyError(() => policy({ fingerprintMode: "off", requestedMode, webrtcIp: ip }), "webrtc-managed-required");
    expect(error.message).toContain("Select managed fingerprint mode");
    expect(error.message).toContain("explicitly select real");
  });

  it("exports the routing switch for external extraArgs protection", () => {
    expect(CHROMIUM_WEBRTC_PROTECTED_SWITCHES).toContain(CHROMIUM_WEBRTC_IP_HANDLING_SWITCH);
    expect(CHROMIUM_WEBRTC_PROTECTED_SWITCHES).toContain("--profile-directory");
  });
});

describe("final WebRTC argv cannot be duplicated, removed, split or downgraded", () => {
  it.each([[], ["--profile-directory=Profile 1"], ["--profile-directory", "Default"], ["--Profile-Directory=Default"], ["--profile-directory=Default", "--profile-directory=Default"]])("refuses an unbound or ambiguous Chrome profile %j", (...selection) => {
    expectPolicyError(() => assertChromiumWebRtcRoutingArgs([proxyArg, CHROMIUM_WEBRTC_PROXY_ONLY_ARG, ...selection], policy()), "webrtc-routing-policy");
  });

  it("accepts only the exact owned proxy-only routing argv without mutating it", () => {
    const args = Object.freeze(proxyOnlyArgs());
    expect(() => assertChromiumWebRtcRoutingArgs(args, policy())).not.toThrow();
    expect(args).toEqual(proxyOnlyArgs());
  });

  it.each([
    [],
    [CHROMIUM_WEBRTC_IP_HANDLING_SWITCH],
    [CHROMIUM_WEBRTC_IP_HANDLING_SWITCH, "disable_non_proxied_udp"],
    [CHROMIUM_WEBRTC_IP_HANDLING_SWITCH, "default"],
    [`${CHROMIUM_WEBRTC_IP_HANDLING_SWITCH}=default`],
    [`${CHROMIUM_WEBRTC_IP_HANDLING_SWITCH}=default_public_interface_only`],
    [`${CHROMIUM_WEBRTC_IP_HANDLING_SWITCH}=default_public_and_private_interfaces`],
    ["-force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    ["/force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    ["--Force-WebRTC-IP-Handling-Policy=disable_non_proxied_udp"],
    [CHROMIUM_WEBRTC_PROXY_ONLY_ARG, CHROMIUM_WEBRTC_PROXY_ONLY_ARG],
    [CHROMIUM_WEBRTC_PROXY_ONLY_ARG, `${CHROMIUM_WEBRTC_IP_HANDLING_SWITCH}=default`],
    [`${CHROMIUM_WEBRTC_IP_HANDLING_SWITCH}=default`, CHROMIUM_WEBRTC_PROXY_ONLY_ARG],
    [CHROMIUM_WEBRTC_PROXY_ONLY_ARG, "-force-webrtc-ip-handling-policy=default"],
    [CHROMIUM_WEBRTC_PROXY_ONLY_ARG, "/force-webrtc-ip-handling-policy=default"],
    [CHROMIUM_WEBRTC_PROXY_ONLY_ARG, CHROMIUM_WEBRTC_IP_HANDLING_SWITCH, "default"],
    ["--", CHROMIUM_WEBRTC_PROXY_ONLY_ARG],
  ])("rejects missing/ambiguous/noncanonical routing tokens %j", (...tokens) => {
    expectPolicyError(() => assertChromiumWebRtcRoutingArgs([CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, ...tokens], policy()), "webrtc-routing-policy");
  });

  it.each([
    "--no-proxy-server", "--proxy-auto-detect", "--proxy-pac-url=https://proxy.example.test/proxy.pac", "--proxy-pac-mandatory",
    "-no-proxy-server", "/no-proxy-server", "--Proxy-Pac-Url=https://proxy.example.test/proxy.pac",
  ])("rejects fixed-proxy overrides even when the routing flag survives: %s", override => {
    expectPolicyError(() => assertChromiumWebRtcRoutingArgs([...proxyOnlyArgs(), override], policy()), "webrtc-routing-policy");
  });

  it.each([[], ["--proxy-server"], ["--proxy-server="], [proxyArg, proxyArg]])("rejects missing, split or duplicate fixed proxy arguments %j", (...proxyArgs) => {
    expectPolicyError(() => assertChromiumWebRtcRoutingArgs([CHROMIUM_WEBRTC_PROFILE_ARG, ...proxyArgs, CHROMIUM_WEBRTC_PROXY_ONLY_ARG], policy()), "webrtc-routing-policy");
  });

  it.each([
    "direct://", "http://proxy.example.test:8080;direct://", "http=proxy.example.test:8080;https=direct://",
    "http://proxy.example.test:8080,socks5://fallback.example.test:1080", "http://proxy.example.test:0", "http://proxy.example.test:65536",
    "http://user:password@proxy.example.test:8080", "http://proxy.example.test:8080/path", "http://proxy.example.test:8080?fallback=direct",
  ])("rejects DIRECT/fallback lists and noncanonical fixed proxy endpoints: %s", endpoint => {
    expectPolicyError(() => assertChromiumWebRtcRoutingArgs([CHROMIUM_WEBRTC_PROFILE_ARG, `--proxy-server=${endpoint}`, CHROMIUM_WEBRTC_PROXY_ONLY_ARG], policy()), "webrtc-routing-policy");
  });

  it.each([
    `--fingerprint-webrtc-ip=${ip}`, `-fingerprint-webrtc-ip=${ip}`, `/fingerprint-webrtc-ip=${ip}`,
    "--fingerprint-webrtc=altered", "--fingerprint-webrtc-mode=real",
  ])("refuses legacy native overrides in proxy-only mode: %s", override => {
    expectPolicyError(() => assertChromiumWebRtcRoutingArgs([...proxyOnlyArgs(), override], policy()), "webrtc-routing-policy");
  });

  it("altered only permits its exact native IP override, never duplicates or a different IP", () => {
    const resolved = policy({ requestedMode: "altered", webrtcIp: ip });
    const args = [...proxyOnlyArgs(), `--fingerprint-webrtc-ip=${ip}`];
    expect(() => assertChromiumWebRtcRoutingArgs(args, resolved)).not.toThrow();
    expectPolicyError(() => assertChromiumWebRtcRoutingArgs([...args, `--fingerprint-webrtc-ip=${ip}`], resolved), "webrtc-routing-policy");
    expectPolicyError(() => assertChromiumWebRtcRoutingArgs([...proxyOnlyArgs(), "--fingerprint-webrtc-ip=203.0.113.20"], resolved), "webrtc-routing-policy");
  });

  it("real/disable modes do not accept externally supplied routing switches", () => {
    for (const requestedMode of ["real", "disable"] as const) {
      expectPolicyError(() => assertChromiumWebRtcRoutingArgs(proxyOnlyArgs(), policy({ requestedMode })), "webrtc-routing-policy");
    }
  });
});
