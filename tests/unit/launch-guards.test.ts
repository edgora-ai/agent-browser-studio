import { describe, it, expect, vi } from "vitest";
import { runFingerprintDriftGuard, runEnvironmentRiskGuard, LaunchBlockedError, assertHostPlatformCompatible, assertChromiumWebRtcLaunchPolicy, resolveChromiumWebRtcLaunchPolicy } from "../../src/main/services/browser/launch-guards.js";
import { CHROMIUM_WEBRTC_PROFILE_ARG, CHROMIUM_WEBRTC_PROXY_ONLY_ARG } from "../../src/main/services/browser/webrtc-policy.js";
import type { BrowserPlatform } from "../../src/main/types.js";

describe("native-GPU host launch guard", () => {
  it.each([
    ["darwin", "windows"], ["win32", "macos"],
    ["darwin", "android"], ["win32", "android"],
    ["linux", "windows"], ["freebsd", "macos"],
  ])("blocks managed %s/%s without rewriting the portable profile", (host, platform) => {
    const meta = { platform: platform as BrowserPlatform, fingerprintMode: "managed" as const };
    const before = structuredClone(meta);
    let blocked: unknown;
    try { assertHostPlatformCompatible(meta, host); } catch (error) { blocked = error; }
    expect(blocked).toBeInstanceOf(LaunchBlockedError);
    expect(blocked).toMatchObject({ code: "host-platform-mismatch" });
    expect((blocked as Error).message).toContain("saved profile has not been changed");
    expect((blocked as Error).message).toContain("fingerprint-off or Firefox");
    expect(meta).toEqual(before);
  });

  it.each([["darwin", "macos"], ["win32", "windows"]])("permits supported matching %s/%s", (host, platform) => {
    expect(() => assertHostPlatformCompatible({ platform: platform as BrowserPlatform }, host)).not.toThrow();
  });

  it.each(["darwin", "win32", "linux"])("leaves fingerprint-off and Firefox OS fields inactive on %s", (host) => {
    expect(() => assertHostPlatformCompatible({ platform: "android", fingerprintMode: "off" }, host)).not.toThrow();
    expect(() => assertHostPlatformCompatible({ engine: "firefox", platform: "android", fingerprintMode: "managed" }, host)).not.toThrow();
  });

  it("does not interpret an unsupported host as Windows, including legacy missing platform", () => {
    expect(() => assertHostPlatformCompatible({}, "win32")).not.toThrow();
    expect(() => assertHostPlatformCompatible({}, "linux")).toThrow(LaunchBlockedError);
    expect(() => assertHostPlatformCompatible({}, "darwin")).toThrow(LaunchBlockedError);
  });
});

describe("final native WebRTC launch guard", () => {
  const proxyArg = "--proxy-server=http://proxy.example.test:8080";
  const nativeArg = (mode: string, publicIp: string | null = null) => "--agent-browser-fingerprint-config=" +
    Buffer.from(JSON.stringify({ schemaVersion: 1, webrtc: { mode, publicIp } })).toString("base64url");
  const proxyOnly = () => resolveChromiumWebRtcLaunchPolicy({ requestedMode: "auto", fingerprintMode: "managed", hasProxy: true });

  it("requires proxy-only to remain native real/null plus the separate routing flag", () => {
    const args = [CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, nativeArg("real"), CHROMIUM_WEBRTC_PROXY_ONLY_ARG];
    expect(() => assertChromiumWebRtcLaunchPolicy(args, proxyOnly())).not.toThrow();
    for (const native of [nativeArg("proxy-only"), nativeArg("altered", "203.0.113.19"), nativeArg("real", "203.0.113.19"), nativeArg("disable")]) {
      expect(() => assertChromiumWebRtcLaunchPolicy([CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, native, CHROMIUM_WEBRTC_PROXY_ONLY_ARG], proxyOnly())).toThrow(LaunchBlockedError);
    }
    expect(() => assertChromiumWebRtcLaunchPolicy([CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, CHROMIUM_WEBRTC_PROXY_ONLY_ARG], proxyOnly())).toThrow(LaunchBlockedError);
    expect(() => assertChromiumWebRtcLaunchPolicy([...args, "--fingerprint-webrtc-ip=203.0.113.19"], proxyOnly())).toThrow(LaunchBlockedError);
  });

  it("rejects missing, malformed, duplicated or alternate-prefix native JSON channels", () => {
    const native = nativeArg("real");
    for (const natives of [
      ["--agent-browser-fingerprint-config=malformed"], [native, native],
      [native, native.replace("--agent-browser-", "--roxy-")],
      [native.replace(/^--/, "-")], [native.replace(/^--/, "/")],
    ]) {
      expect(() => assertChromiumWebRtcLaunchPolicy([CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, ...natives, CHROMIUM_WEBRTC_PROXY_ONLY_ARG], proxyOnly())).toThrow(LaunchBlockedError);
    }
  });

  it("keeps disable as the native all-ICE block and altered tied to its resolved IP", () => {
    const disabled = resolveChromiumWebRtcLaunchPolicy({ requestedMode: "disable", fingerprintMode: "managed", hasProxy: true });
    expect(() => assertChromiumWebRtcLaunchPolicy([CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, nativeArg("disable")], disabled)).not.toThrow();
    expect(() => assertChromiumWebRtcLaunchPolicy([CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, nativeArg("real")], disabled)).toThrow(LaunchBlockedError);
    const altered = resolveChromiumWebRtcLaunchPolicy({ requestedMode: "altered", fingerprintMode: "managed", hasProxy: true, webrtcIp: "203.0.113.19" });
    expect(() => assertChromiumWebRtcLaunchPolicy([CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, nativeArg("altered", "203.0.113.19"), CHROMIUM_WEBRTC_PROXY_ONLY_ARG], altered)).not.toThrow();
    expect(() => assertChromiumWebRtcLaunchPolicy([CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, nativeArg("altered", "203.0.113.20"), CHROMIUM_WEBRTC_PROXY_ONLY_ARG], altered)).toThrow(LaunchBlockedError);
  });

  it("off+proxy requires the routing switch but never a native identity payload", () => {
    const off = resolveChromiumWebRtcLaunchPolicy({ requestedMode: "auto", fingerprintMode: "off", hasProxy: true });
    const args = [CHROMIUM_WEBRTC_PROFILE_ARG, proxyArg, CHROMIUM_WEBRTC_PROXY_ONLY_ARG];
    expect(() => assertChromiumWebRtcLaunchPolicy(args, off)).not.toThrow();
    expect(() => assertChromiumWebRtcLaunchPolicy([proxyArg], off)).toThrow(LaunchBlockedError);
    expect(() => assertChromiumWebRtcLaunchPolicy([...args, nativeArg("real")], off)).toThrow(LaunchBlockedError);
  });

  it.each([
    ["proxy-only", "managed", false, "webrtc-proxy-required"],
    ["altered", "managed", true, "webrtc-ip-required"],
    ["altered", "off", true, "webrtc-managed-required"],
    ["disable", "off", true, "webrtc-managed-required"],
  ] as const)("preserves stable %s/%s launch refusal %s/%s", (requestedMode, fingerprintMode, hasProxy, code) => {
    let blocked: unknown;
    try { resolveChromiumWebRtcLaunchPolicy({ requestedMode, fingerprintMode, hasProxy }); } catch (error) { blocked = error; }
    expect(blocked).toBeInstanceOf(LaunchBlockedError);
    expect(blocked).toMatchObject({ code });
  });
});

describe("launch-guards", () => {
  it("drift: keeps the actual CPU drift evidence after refusing a launch", async () => {
    const baseline = { platform: "MacIntel", plugins: "PDF", uaHighEntropy: '{"architecture":"arm"}' };
    const current = { ...baseline, uaHighEntropy: '{"architecture":"x86"}' };
    const meta = { fingerprintBaseline: baseline, platform: "macos" };
    const before = structuredClone(meta);
    const auditBlock = vi.fn();
    await expect(runFingerprintDriftGuard(
      { captureFingerprint: async () => current, audit: vi.fn(), auditBlock },
      { cdpPort: 1, meta, cfg: {}, passThrough: false },
    )).rejects.toMatchObject({
      code: "fingerprint-drift",
      driftCheck: { checked: true, risky: true, observedAt: expect.any(Number),
        drift: [{ field: "uaHighEntropy.architecture", baseline: "arm", current: "x86" }] },
    });
    expect(auditBlock).toHaveBeenCalledWith(expect.stringContaining("uaHighEntropy"));
    expect(meta).toEqual(before);
  });

  it("drift: reports a content viewport change without treating browser chrome as a new identity", async () => {
    const baseline = { platform: "MacIntel", plugins: "PDF", innerHeight: 713, outerHeight: 800 };
    await expect(runFingerprintDriftGuard(
      { captureFingerprint: async () => ({ ...baseline, innerHeight: 600 }), audit: vi.fn(), auditBlock: vi.fn() },
      { cdpPort: 1, meta: { fingerprintBaseline: baseline, platform: "macos" }, cfg: {}, passThrough: false },
    )).resolves.toMatchObject({ checked: true, risky: false, drift: [{ field: "innerHeight", baseline: 713, current: 600 }] });
  });

  it("drift: separates missing required evidence from observed identity risk", async () => {
    const baseline = { platform: "MacIntel", plugins: "PDF", screenW: 1280 };
    const auditBlock = vi.fn();
    await expect(runFingerprintDriftGuard(
      { captureFingerprint: async () => ({ platform: "MacIntel", plugins: "PDF" }), audit: vi.fn(), auditBlock },
      { cdpPort: 1, meta: { platform: "macos", fingerprintBaseline: baseline }, cfg: {}, passThrough: false },
    )).rejects.toMatchObject({ code: "fingerprint-check-unavailable", driftCheck: { checked: false, risky: false, partial: true,
      blockingUnavailable: true, drift: [{ field: "screenW", required: true, availability: "probe-unavailable" }] } });
    expect(auditBlock).not.toHaveBeenCalled();
  });

  it("drift: an optional timed-out worker remains partial without inventing an identity change", async () => {
    const baseline = { platform: "MacIntel", plugins: "PDF", workerIdentity: '{"platform":"MacIntel"}' };
    await expect(runFingerprintDriftGuard(
      { captureFingerprint: async () => ({ ...baseline, workerIdentity: '{"timeout":true}' }), audit: vi.fn(), auditBlock: vi.fn() },
      { cdpPort: 1, meta: { platform: "macos", fingerprintBaseline: baseline }, cfg: {}, passThrough: false },
    )).resolves.toMatchObject({ checked: true, risky: false, partial: true, blockingUnavailable: false });
  });

  it("drift: only owned matching binary evidence makes a coherent version update review-only", async () => {
    const snapshot = (version: string) => ({ platform: "MacIntel", plugins: "PDF",
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/" + version.split(".")[0] + ".0.0.0 Safari/537.36",
      uaHighEntropy: JSON.stringify({ architecture: "arm", fullVersionList: [{ brand: "Chromium", version }] }) });
    const baseline = snapshot("152.0.7977.72"), current = snapshot("153.0.8000.10");
    const meta = { platform: "macos", fingerprintBaseline: baseline };
    const deps = { captureFingerprint: async () => current, audit: vi.fn(), auditBlock: vi.fn() };
    await expect(runFingerprintDriftGuard(deps, { cdpPort: 1, meta, cfg: {}, passThrough: false,
      expectedBrowserVersion: "153.0.8000.10" })).resolves.toMatchObject({ checked: true, risky: false, review: true, partial: false });
    await expect(runFingerprintDriftGuard(deps, { cdpPort: 1, meta, cfg: {}, passThrough: false }))
      .rejects.toMatchObject({ code: "fingerprint-drift", driftCheck: { risky: true } });
    expect(meta.fingerprintBaseline).toEqual(baseline);
  });

  it("drift: a locked profile cannot randomly pass when its live capture fails", async () => {
    const auditError = vi.fn();
    const auditBlock = vi.fn();
    await expect(runFingerprintDriftGuard(
      { captureFingerprint: async () => { throw new Error("No debuggable page found"); }, audit: vi.fn(), auditBlock, auditError },
      { cdpPort: 1, meta: { fingerprintBaseline: { platform: "MacIntel" } }, cfg: {}, passThrough: false },
    )).rejects.toMatchObject({ code: "fingerprint-check-unavailable", driftCheck: { checked: false, error: "No debuggable page found" } });
    expect(auditError).toHaveBeenCalled();
    expect(auditBlock).not.toHaveBeenCalled(); // Unknown is not observed identity drift.
  });

  it("drift: explicitly disabled gate still returns an unverified capture failure", async () => {
    await expect(runFingerprintDriftGuard(
      { captureFingerprint: async () => { throw new Error("capture unavailable"); }, audit: vi.fn(), auditBlock: vi.fn() },
      { cdpPort: 1, meta: { fingerprintBaseline: { platform: "MacIntel" } }, cfg: { blockOnFingerprintDrift: false }, passThrough: false },
    )).resolves.toMatchObject({ checked: false, error: "capture unavailable" });
  });

  it("drift: passThrough skips", async () => {
    const r = await runFingerprintDriftGuard(
      { captureFingerprint: async () => { throw new Error("should not call"); }, audit: vi.fn(), auditBlock: vi.fn() },
      { cdpPort: 1, meta: { fingerprintBaseline: {} }, cfg: {}, passThrough: true },
    );
    expect(r.checked).toBe(false);
  });

  it("env: high gate throws LaunchBlockedError", async () => {
    const mod = await import("../../src/main/services/environment-risk.js");
    const spy = vi.spyOn(mod, "checkEnvironmentRisk").mockReturnValue({
      ok: false,
      hostPlatform: "linux",
      hostLocale: "en-US",
      resolvers: [],
      cnFonts: [],
      proxy: null as any,
      raf: null as any,
      findings: [{ severity: "high", code: "dns-resolver-leak", message: "x", fix: "y" }],
    } as any);
    try {
      expect(() => runEnvironmentRiskGuard(
        { auditHigh: vi.fn() },
        { meta: { timezone: "UTC", locale: "en-US", platform: "windows" }, resolvedProxy: { mode: "none", config: null }, cfg: { blockOnEnvironmentRisk: true }, passThrough: false },
      )).toThrow(LaunchBlockedError);
    } finally { spy.mockRestore(); }
  });

  it("env: gate off does not throw", () => {
    expect(() => runEnvironmentRiskGuard(
      { auditHigh: vi.fn() },
      { meta: { timezone: "UTC", locale: "en-US", platform: "windows" }, resolvedProxy: { mode: "none", config: null }, cfg: { blockOnEnvironmentRisk: false }, passThrough: false },
    )).not.toThrow();
  });
});
