import { describe, it, expect, vi } from "vitest";
import { runFingerprintDriftGuard, runEnvironmentRiskGuard, LaunchBlockedError, assertHostPlatformCompatible } from "../../src/main/services/browser/launch-guards.js";
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

describe("launch-guards", () => {
  it("drift: blocks on risky drift", async () => {
    const captureFingerprint = async () => ({ gpu: "different" });
    // Mock diff to report drift; use real hasRisky path via stubbed capture mismatch
    // We inject a capture that will cause diff; use real diff logic by providing baseline vs current mismatch
    // Simpler: mock the underlying module via a wrapper capture that returns a known current
    // For this isolated test, verify guard blocks when hasRiskyDrift would be true
    // Use a known risky field: gpuVendor
    const audit = vi.fn();
    const auditBlock = vi.fn();
    // Baseline with gpuVendor, current with different gpuVendor
    const meta = { fingerprintBaseline: { gpuVendor: "Intel" }, platform: "windows", timezone: "UTC" };
    // Provide a capture that returns a different gpuVendor than baseline
    // The real diffFingerprints will see the delta
    await expect(runFingerprintDriftGuard(
      { captureFingerprint: async () => ({ gpuVendor: "NVIDIA", gpuRenderer: "ANGLE", platform: "windows", timezone: "UTC" } as any), audit, auditBlock },
      { cdpPort: 1, meta, cfg: { blockOnFingerprintDrift: true }, passThrough: false },
    )).rejects.toBeInstanceOf(LaunchBlockedError);
    expect(auditBlock).toHaveBeenCalled();
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
