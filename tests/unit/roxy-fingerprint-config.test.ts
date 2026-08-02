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
      hardwareConcurrency: 12,
      deviceMemory: 16,
      gpuVendor: "Google Inc. (NVIDIA)",
      gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      webrtcIp: "203.0.113.9",
      geolocationMode: "custom" as const,
      geolocationLatitude: 31.2304,
      geolocationLongitude: 121.4737,
      geolocationAccuracy: 25,
    };
    const first = buildRoxyFingerprintConfig(meta, "149.0.7827.22");
    const second = buildRoxyFingerprintConfig(meta, "149.0.7827.22");

    expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([
      "appVersion", "audio", "canvas", "deviceMemory", "doNotTrack", "fonts",
      "geolocation", "hardwareConcurrency", "hardwareProfile", "languages", "maxTouchPoints",
      "mediaDevices", "platform", "platformVersion", "schemaVersion", "screen",
      "seed", "speechSynthesis", "storageQuotaBytes", "timezone", "userAgent",
      "vendor", "webauthn", "webgl", "webgpu", "webrtc",
    ]);
    expect(first.platform).toBe("Win32");
    expect(first.maxTouchPoints).toBe(0);
    expect(first.hardwareProfile).toEqual({
      id: "win-nvidia-rtx3060-12c-16gb-1080p",
      source: "validated-override",
      fontProfile: "windows-portable",
      audioProfile: "chromium-desktop",
    });
    expect(first.languages).toEqual(["zh-CN", "zh"]);
    expect(first.userAgent).toContain("Chrome/149.0.7827.22");
    expect(first.screen.availLeft).toBe(0);
    expect(first.screen.availTop).toBe(0);
    expect(first.screen.availHeight).toBe(1032);
    expect(first.screen).toMatchObject({ windowX: 32, windowY: 32, outerWidth: 1280, outerHeight: 800 });
    expect(first.storageQuotaBytes).toBe(120000 * 1024 * 1024);
    expect(first.fonts).toHaveLength(10);
    expect(first.fonts).toEqual([...first.fonts].sort());
    expect(first.fonts).toContain("Arial Unicode MS");
    expect(first.fonts).toContain("Tahoma");
    expect(first.fonts.some((font) => /Calibri|Segoe UI|PingFang/.test(font))).toBe(false);
    expect(first.webrtc).toEqual({ mode: "altered", publicIp: "203.0.113.9" });
    expect(first.webgpu).toEqual({
      mode: "webgl",
      vendor: "NVIDIA",
      architecture: "Ampere",
      subgroupMinSize: 32,
      subgroupMaxSize: 32,
    });
    expect(first.webauthn).toEqual({
      enabled: true,
      conditionalGet: true,
      conditionalCreate: true,
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
      userVerifyingPlatformAuthenticator: true,
    });
    expect(first.doNotTrack).toBe("1");
    expect(first.speechSynthesis).toEqual({
      enabled: true,
      voices: [{ name: "Microsoft Huihui - Chinese (Simplified, PRC)", lang: "zh-CN", localService: true }],
    });
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
    expect(decoded.screen).toMatchObject({ availLeft: 0, availTop: 25, windowX: 32, windowY: 57, outerWidth: 1280, outerHeight: 800 });
    expect(decoded.webgpu).toEqual({
      mode: "webgl",
      vendor: "Apple",
      architecture: "metal-3",
      subgroupMinSize: 32,
      subgroupMaxSize: 32,
    });
    expect(decoded.speechSynthesis.voices.map((voice: { name: string }) => voice.name))
      .toEqual(["Samantha", "Alex"]);
    expect(json).not.toContain("license");
    expect(json).not.toContain("lumi.conf");
  });

  it("selects default hardware as coherent seed-owned personas", () => {
    const windows = [1, 2, 3, 4, 5].map((fingerprintSeed) =>
      buildRoxyFingerprintConfig({ fingerprintSeed, platform: "windows" }, "150.0.7871.114"));
    expect(windows.map((config) => ({
      cpu: config.hardwareConcurrency,
      memory: config.deviceMemory,
      screen: `${config.screen.width}x${config.screen.height}@${config.screen.devicePixelRatio}`,
      gpu: config.webgpu.vendor,
    }))).toEqual([
      { cpu: 8, memory: 16, screen: "1920x1080@1", gpu: "Intel" },
      { cpu: 12, memory: 16, screen: "1920x1080@1", gpu: "NVIDIA" },
      { cpu: 16, memory: 16, screen: "2560x1440@1", gpu: "NVIDIA" },
      { cpu: 16, memory: 16, screen: "1920x1080@1", gpu: "AMD" },
      { cpu: 8, memory: 8, screen: "1920x1080@1", gpu: "Intel" },
    ]);

    const mac = [1, 2, 3, 4].map((fingerprintSeed) =>
      buildRoxyFingerprintConfig({ fingerprintSeed, platform: "macos" }, "150.0.7871.114"));
    expect(mac.map((config) => ({
      cpu: config.hardwareConcurrency,
      memory: config.deviceMemory,
      screen: `${config.screen.width}x${config.screen.height}@${config.screen.devicePixelRatio}`,
      renderer: config.webgl.renderer,
    }))).toEqual([
      { cpu: 8, memory: 16, screen: "1512x982@2", renderer: expect.stringContaining("Apple M2,") },
      { cpu: 8, memory: 16, screen: "1710x1107@2", renderer: expect.stringContaining("Apple M3,") },
      { cpu: 12, memory: 16, screen: "1728x1117@2", renderer: expect.stringContaining("Apple M2 Pro,") },
      { cpu: 8, memory: 8, screen: "1440x900@2", renderer: expect.stringContaining("Apple M1,") },
    ]);

    expect(buildRoxyFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114"))
      .toEqual(buildRoxyFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114"));
  });

  it("treats advanced hardware fields as constraints on a complete persona", () => {
    const config = buildRoxyFingerprintConfig({
      fingerprintSeed: 99,
      platform: "windows",
      gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    }, "150.0.7871.114");
    expect(config.hardwareProfile).toEqual({
      id: "win-nvidia-rtx4060-16c-16gb-1440p",
      source: "validated-override",
      fontProfile: "windows-portable",
      audioProfile: "chromium-desktop",
    });
    expect(config).toMatchObject({
      hardwareConcurrency: 16,
      deviceMemory: 16,
      screen: { width: 2560, height: 1440, devicePixelRatio: 1 },
      webgl: { vendor: "Google Inc. (NVIDIA)" },
      webgpu: { vendor: "NVIDIA", architecture: "Lovelace" },
    });
  });

  it("rejects advanced overrides that cannot belong to one supported persona", () => {
    expect(() => buildRoxyFingerprintConfig({
      fingerprintSeed: 100,
      platform: "windows",
      hardwareConcurrency: 8,
      gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    }, "150.0.7871.114")).toThrow(/Incoherent advanced hardware overrides/);
    expect(() => buildRoxyFingerprintConfig({
      fingerprintSeed: 101,
      platform: "macos",
      gpuVendor: "Google Inc. (NVIDIA)",
    }, "150.0.7871.114")).toThrow(/Incoherent advanced hardware overrides/);
  });

  it("keeps a large seed corpus inside the versioned joint-profile catalog", () => {
    const windowsIds = new Set<string>();
    const macIds = new Set<string>();
    for (let fingerprintSeed = 1; fingerprintSeed <= 500; fingerprintSeed++) {
      const windows = buildRoxyFingerprintConfig({ fingerprintSeed, platform: "windows" }, "150.0.7871.114");
      const mac = buildRoxyFingerprintConfig({ fingerprintSeed, platform: "macos" }, "150.0.7871.114");
      windowsIds.add(windows.hardwareProfile.id);
      macIds.add(mac.hardwareProfile.id);
      expect(windows.hardwareProfile).toMatchObject({ source: "seeded", fontProfile: "windows-portable", audioProfile: "chromium-desktop" });
      expect(mac.hardwareProfile).toMatchObject({ source: "seeded", fontProfile: "macos-system", audioProfile: "chromium-desktop" });
      expect(windows.webgl.renderer).toContain(windows.webgpu.vendor);
      expect(mac.webgl.renderer).toContain("Apple");
      expect(mac.webgpu.vendor).toBe("Apple");
      expect(windows.screen.devicePixelRatio).toBe(1);
      expect(mac.screen.devicePixelRatio).toBe(2);
      expect(windows.audio).toMatchObject({ enabled: true, amplitude: 0.0000001 });
      expect(mac.audio).toMatchObject({ enabled: true, amplitude: 0.0000001 });
    }
    expect([...windowsIds].sort()).toEqual([
      "win-amd-radeon-16c-16gb-1080p",
      "win-intel-irisxe-8c-16gb-1080p",
      "win-intel-uhd620-8c-8gb-1080p",
      "win-nvidia-rtx3060-12c-16gb-1080p",
      "win-nvidia-rtx4060-16c-16gb-1440p",
    ]);
    expect([...macIds].sort()).toEqual([
      "mac-apple-m1-8c-8gb-1440x900",
      "mac-apple-m2-8c-16gb-1512x982",
      "mac-apple-m2pro-12c-16gb-1728x1117",
      "mac-apple-m3-8c-16gb-1710x1107",
    ]);
  });

  it("emits a native disabled geolocation policy without coordinates", () => {
    const config = buildRoxyFingerprintConfig({ fingerprintSeed: 8, geolocationMode: "disable" }, "149.0.7827.22");
    expect(config.geolocation).toEqual({ mode: "disable", latitude: null, longitude: null, accuracy: null });
  });

  it("preserves all native WebRTC policy modes", () => {
    expect(buildRoxyFingerprintConfig({ fingerprintSeed: 10, webrtcMode: "disable" }, "149.0.7827.22").webrtc)
      .toEqual({ mode: "disable", publicIp: null });
    expect(buildRoxyFingerprintConfig({ fingerprintSeed: 11, webrtcMode: "real", webrtcIp: "203.0.113.2" }, "149.0.7827.22").webrtc)
      .toEqual({ mode: "real", publicIp: null });
    expect(buildRoxyFingerprintConfig({ fingerprintSeed: 12, webrtcMode: "altered", webrtcIp: "203.0.113.3" }, "149.0.7827.22").webrtc)
      .toEqual({ mode: "altered", publicIp: "203.0.113.3" });
    expect(buildRoxyFingerprintConfig({ fingerprintSeed: 13, webrtcMode: "altered" }, "149.0.7827.22").webrtc)
      .toEqual({ mode: "altered", publicIp: null });
  });

  it("keeps every supported locale on a locale-shaped speech identity", () => {
    const windowsCases = [
      ["en-GB", "Microsoft George - English (United Kingdom)"],
      ["zh-TW", "Microsoft Hanhan - Chinese (Traditional, Taiwan)"],
      ["ar-SA", "Microsoft Naayf - Arabic (Saudi Arabia)"],
      ["th-TH", "Microsoft Pattara - Thai (Thailand)"],
      ["vi-VN", "Microsoft An - Vietnamese (Vietnam)"],
      ["el-GR", "Microsoft Stefanos - Greek (Greece)"],
      ["el-CY", "Microsoft Stefanos - Greek (Greece)"],
    ] as const;
    for (const [locale, expectedVoice] of windowsCases) {
      const config = buildRoxyFingerprintConfig({ fingerprintSeed: 21, platform: "windows", locale }, "150.0.7871.114");
      expect(config.languages).toEqual([locale, locale.split("-")[0]]);
      expect(config.speechSynthesis.voices[0]).toEqual({ name: expectedVoice, lang: locale, localService: true });
    }

    expect(buildRoxyFingerprintConfig({ fingerprintSeed: 22, platform: "macos", locale: "el-GR" }, "150.0.7871.114")
      .speechSynthesis.voices[0].name).toBe("Melina");
    expect(buildRoxyFingerprintConfig({ fingerprintSeed: 23, platform: "macos", locale: "zh-TW" }, "150.0.7871.114")
      .speechSynthesis.voices[0].name).toBe("Mei-Jia");
  });

  it("rejects incomplete custom geolocation", () => {
    expect(() => buildRoxyFingerprintConfig({ fingerprintSeed: 9, geolocationMode: "custom", geolocationLatitude: 10 }, "149.0.7827.22"))
      .toThrow(/latitude|longitude/i);
  });
});
