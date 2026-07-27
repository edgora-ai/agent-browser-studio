import { describe, expect, it } from "vitest";
import {
  buildRoxyFingerprintArg,
  buildRoxyFingerprintConfig,
  ROXY_FINGERPRINT_SWITCH,
} from "../../src/main/services/roxy-fingerprint-config.js";

describe("Roxy fingerprint config", () => {
  it("produces a deterministic Chromium 149+ identity", () => {
    const meta = {
      fingerprintSeed: 4242,
      platform: "windows" as const,
      locale: "zh-cn",
      timezone: "Asia/Shanghai",
      screenWidth: 1920,
      screenHeight: 1080,
      taskbarHeight: 48,
      storageQuota: 120000,
      hardwareConcurrency: 8,
      deviceMemory: 16,
      gpuVendor: "Google Inc. (NVIDIA)",
      gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)",
      webrtcIp: "203.0.113.9",
    };
    const first = buildRoxyFingerprintConfig(meta, "149.0.7827.22");
    const second = buildRoxyFingerprintConfig(meta, "149.0.7827.22");

    expect(second).toEqual(first);
    expect(first.platform).toBe("Win32");
    expect(first.languages).toEqual(["zh-CN", "zh"]);
    expect(first.userAgent).toContain("Chrome/149.0.7827.22");
    expect(first.screen.availHeight).toBe(1032);
    expect(first.storageQuotaBytes).toBe(120000 * 1024 * 1024);
    expect(first.webrtc).toEqual({ mode: "altered", publicIp: "203.0.113.9" });
  });

  it("encodes a versioned config without proprietary lumi.conf data", () => {
    const arg = buildRoxyFingerprintArg({ fingerprintSeed: 7, platform: "macos" }, "150.0.7871.114");
    expect(arg.startsWith(ROXY_FINGERPRINT_SWITCH)).toBe(true);
    const json = Buffer.from(arg.slice(ROXY_FINGERPRINT_SWITCH.length), "base64url").toString("utf8");
    const decoded = JSON.parse(json);
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.platform).toBe("MacIntel");
    expect(decoded.userAgent).toContain("Chrome/150.0.7871.114");
    expect(json).not.toContain("license");
    expect(json).not.toContain("lumi.conf");
  });
});
