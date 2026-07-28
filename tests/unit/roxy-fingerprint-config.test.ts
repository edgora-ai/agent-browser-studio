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
      geolocationMode: "custom" as const,
      geolocationLatitude: 31.2304,
      geolocationLongitude: 121.4737,
      geolocationAccuracy: 25,
    };
    const first = buildRoxyFingerprintConfig(meta, "149.0.7827.22");
    const second = buildRoxyFingerprintConfig(meta, "149.0.7827.22");

    expect(second).toEqual(first);
    expect(first.platform).toBe("Win32");
    expect(first.languages).toEqual(["zh-CN", "zh"]);
    expect(first.userAgent).toContain("Chrome/149.0.7827.22");
    expect(first.screen.availHeight).toBe(1032);
    expect(first.storageQuotaBytes).toBe(120000 * 1024 * 1024);
    expect(first.fonts).toHaveLength(15);
    expect(first.fonts).toEqual([...first.fonts].sort());
    expect(first.fonts.some((font) => /YaHei|Gothic|PingFang|Malgun/.test(font))).toBe(true);
    expect(first.webrtc).toEqual({ mode: "altered", publicIp: "203.0.113.9" });
    expect(first.webgpu).toEqual({ mode: "webgl", vendor: "NVIDIA" });
    expect(first.doNotTrack).toBe("1");
    expect(first.geolocation).toEqual({ mode: "custom", latitude: 31.2304, longitude: 121.4737, accuracy: 25 });
    expect(first.mediaDevices).toEqual({ enabled: true, audioInputs: 1, videoInputs: 1, audioOutputs: 1 });
  });

  it("encodes a versioned config without proprietary lumi.conf data", () => {
    const arg = buildRoxyFingerprintArg({ fingerprintSeed: 7, platform: "macos" }, "150.0.7871.114");
    expect(arg.startsWith(ROXY_FINGERPRINT_SWITCH)).toBe(true);
    const json = Buffer.from(arg.slice(ROXY_FINGERPRINT_SWITCH.length), "base64url").toString("utf8");
    const decoded = JSON.parse(json);
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.platform).toBe("MacIntel");
    expect(decoded.userAgent).toContain("Chrome/150.0.7871.114");
    expect(decoded.webgpu).toEqual({ mode: "webgl", vendor: "Apple" });
    expect(json).not.toContain("license");
    expect(json).not.toContain("lumi.conf");
  });

  it("emits a native disabled geolocation policy without coordinates", () => {
    const config = buildRoxyFingerprintConfig({ fingerprintSeed: 8, geolocationMode: "disable" }, "149.0.7827.22");
    expect(config.geolocation).toEqual({ mode: "disable", latitude: null, longitude: null, accuracy: null });
  });

  it("rejects incomplete custom geolocation", () => {
    expect(() => buildRoxyFingerprintConfig({ fingerprintSeed: 9, geolocationMode: "custom", geolocationLatitude: 10 }, "149.0.7827.22"))
      .toThrow(/latitude|longitude/i);
  });
});
