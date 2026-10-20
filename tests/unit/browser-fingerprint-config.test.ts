import { describe, expect, it } from "vitest";
import {
  buildBrowserFingerprintArg,
  buildBrowserFingerprintConfig,
  composeGpuRenderer,
  getChromiumManagedGpuIdentity,
  validateBrowserHardwareProfile,
  AGENT_BROWSER_FINGERPRINT_SWITCH,
  LEGACY_FINGERPRINT_SWITCH,
  type ChromiumGpuContext,
} from "../../src/main/services/browser-fingerprint-config.js";
import type { BrowserFingerprintMeta } from "../../src/main/types.js";

const NATIVE_WEBGPU_CONFIG = {
  mode: "native",
  vendor: "",
  architecture: "",
  device: "",
  description: "",
  subgroupMinSize: 0,
  subgroupMaxSize: 0,
} as const;

const MAC_ARM64_GPU_CONTEXT: ChromiumGpuContext = Object.freeze({
  hostPlatform: "darwin",
  hostArchitecture: "arm64",
  kernelArchitecture: "arm64",
});
const MAC_GPU_PERSONAS = [
  { id: "mac-apple-m1-8c-8gb-1440x900", renderer: "Apple M1", cpu: 8, memory: 8, width: 1440, height: 900 },
  { id: "mac-apple-m2-8c-16gb-1512x982", renderer: "Apple M2", cpu: 8, memory: 16, width: 1512, height: 982 },
  { id: "mac-apple-m3-8c-16gb-1710x1107", renderer: "Apple M3", cpu: 8, memory: 16, width: 1710, height: 1107 },
  { id: "mac-apple-m2pro-12c-16gb-1728x1117", renderer: "Apple M2 Pro", cpu: 12, memory: 16, width: 1728, height: 1117 },
] as const;
const legacyMacRenderer = (model: string): string => `ANGLE (Apple, ANGLE Metal Renderer: ${model}, Unspecified Version)`;
const GPU_SUPPORT_ERROR = /Unsupported GPU overrides for Chromium:.*macos.*darwin.*arm64.*kernelArchitecture.*arm64.*off/;

describe("Agent Browser fingerprint config", () => {
  it.each(["windows", "macos", "android"] as const)("keeps Chromium GPU identity native for the %s persona", (platform) => {
    const config = buildBrowserFingerprintConfig({ fingerprintSeed: 424242, platform }, "152.0.7977.72");
    expect(config.schemaVersion).toBe(1);
    expect(config.seed).toBe(424242);
    expect(config.webgl).toEqual({ vendor: "", renderer: "" });
    expect(config.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
  });

  it("requires a runtime GPU context for Chromium overrides but allows coherent Mac fields to be saved", () => {
    for (const overrides of [
      { gpuVendor: "Google Inc. (Apple)" },
      { gpuRenderer: "Apple M1" },
      { gpuVendor: "Google Inc. (Apple)", gpuRenderer: legacyMacRenderer("Apple M3") },
    ]) {
      const meta: BrowserFingerprintMeta = { fingerprintSeed: 424242, platform: "macos", ...overrides };
      expect(() => buildBrowserFingerprintConfig(meta, "152.0.7977.72")).toThrow(GPU_SUPPORT_ERROR);
      expect(() => buildBrowserFingerprintArg(meta, "152.0.7977.72")).toThrow(GPU_SUPPORT_ERROR);
      expect(() => validateBrowserHardwareProfile(meta)).not.toThrow();
    }
    for (const overrides of [
      { gpuRenderer: legacyMacRenderer("Apple M1 Pro") },
      { gpuVendor: " ", gpuRenderer: " " },
    ]) {
      const meta: BrowserFingerprintMeta = { fingerprintSeed: 424242, platform: "macos", ...overrides };
      expect(() => buildBrowserFingerprintConfig(meta, "152.0.7977.72")).toThrow(GPU_SUPPORT_ERROR);
      expect(() => validateBrowserHardwareProfile(meta)).toThrow(/Incoherent advanced hardware overrides/);
    }
  });

  it("intentionally migrates full Chromium GPU override tuples while preserving Firefox support", () => {
    const meta: BrowserFingerprintMeta = {
      fingerprintSeed: 4242,
      platform: "windows",
      hardwareConcurrency: 12,
      deviceMemory: 16,
      screenWidth: 1920,
      screenHeight: 1080,
      taskbarHeight: 48,
      gpuVendor: "Google Inc. (NVIDIA)",
      gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    };
    expect(() => buildBrowserFingerprintConfig(meta, "152.0.7977.72")).toThrow(/Unsupported GPU overrides for Chromium/);
    expect(() => validateBrowserHardwareProfile(meta, "chromium")).toThrow(/Unsupported GPU overrides for Chromium/);
    expect(() => validateBrowserHardwareProfile(meta, "firefox")).not.toThrow();
    const firefox = buildBrowserFingerprintConfig(meta, "154.0", null, "firefox");
    expect(firefox).toEqual(buildBrowserFingerprintConfig(meta, "154.0", null, "firefox"));
    expect(firefox.hardwareProfile).toMatchObject({ id: "win-nvidia-rtx3060-12c-16gb-1080p", source: "validated-override" });
    expect(firefox.webgl).toEqual({ vendor: meta.gpuVendor, renderer: meta.gpuRenderer });
    expect(firefox.webgpu).toMatchObject({ mode: "webgl", vendor: "NVIDIA", architecture: "Ampere", subgroupMinSize: 32, subgroupMaxSize: 32 });
  });

  it("allows absent or empty GPU override fields as native Chromium fall-through sentinels", () => {
    for (const overrides of [{}, { gpuVendor: null, gpuRenderer: null }, { gpuVendor: "", gpuRenderer: "" }]) {
      const meta: BrowserFingerprintMeta = { fingerprintSeed: 424242, platform: "windows", ...overrides };
      expect(() => validateBrowserHardwareProfile(meta, "chromium")).not.toThrow();
      const config = buildBrowserFingerprintConfig(meta, "152.0.7977.72");
      expect(config.hardwareProfile.source).toBe("seeded");
      expect(config.webgl).toEqual({ vendor: "", renderer: "" });
      expect(config.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
    }
  });

  it("preserves schema-1 non-GPU fields and privacy noise across engine GPU policies", () => {
    const engineSpecificFields = new Set(["userAgent", "appVersion", "vendor", "webgl", "webgpu"]);
    for (const platform of ["windows", "macos", "android"] as const) {
      const meta = { fingerprintSeed: 424242, platform, locale: "zh-CN", timezone: "Asia/Shanghai", webrtcMode: "disable" as const };
      const chromium = buildBrowserFingerprintConfig(meta, "152.0.7977.72");
      const firefox = buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "firefox");
      const nonGpuFields = (config: typeof chromium) => Object.fromEntries(
        Object.entries(config).filter(([key]) => !engineSpecificFields.has(key)),
      );
      expect(nonGpuFields(chromium)).toEqual(nonGpuFields(firefox));
      expect(chromium.canvas).toMatchObject({ enabled: true, seed: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(chromium.audio).toMatchObject({ enabled: true, seed: expect.stringMatching(/^[0-9a-f]{16}$/), amplitude: 0.0000001 });
      expect(chromium.canvas.seed).not.toBe(chromium.audio.seed);
      const nextSeed = buildBrowserFingerprintConfig({ ...meta, fingerprintSeed: 424243 }, "152.0.7977.72");
      expect(nextSeed.canvas.seed).not.toBe(chromium.canvas.seed);
      expect(nextSeed.audio.seed).not.toBe(chromium.audio.seed);
      expect(nextSeed.webgl).toEqual(chromium.webgl);
      expect(nextSeed.webgpu).toEqual(chromium.webgpu);
    }
  });

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
      // Legacy Chromium full-GPU tuples migrate to non-GPU constraints. GPU
      // overrides are tested separately as unsupported, not silently ignored.
      webrtcIp: "203.0.113.9",
      geolocationMode: "custom" as const,
      geolocationLatitude: 31.2304,
      geolocationLongitude: 121.4737,
      geolocationAccuracy: 25,
    };
    const first = buildBrowserFingerprintConfig(meta, "149.0.7827.22");
    const second = buildBrowserFingerprintConfig(meta, "149.0.7827.22");

    expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([
      "appVersion", "audio", "canvas", "deviceMemory", "doNotTrack", "fonts",
      "geolocation", "hardwareConcurrency", "hardwareProfile", "languages", "maxTouchPoints",
      "mediaDevices", "platform", "platformVersion", "pluginProfile", "schemaVersion", "screen", "secureDns",
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
    expect(first.webgl).toEqual({ vendor: "", renderer: "" });
    expect(first.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
    expect(first.webauthn).toEqual({
      enabled: true,
      conditionalGet: true,
      conditionalCreate: true,
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
      userVerifyingPlatformAuthenticator: true,
    });
    expect(first.doNotTrack).toBe("1");
    expect(first.pluginProfile).toEqual({
      pdfViewerEnabled: true,
      plugins: [
        {
          name: "Internal PDF Plugin",
          filename: "pdfium.dll",
          description: "Portable Document Format",
          mimeTypes: [{ type: "application/pdf", suffixes: "pdf" }],
        },
        {
          name: "Widevine Content Decryption Module",
          filename: "widevinecdm.dll",
          description:
            "Enables Widevine decryption for HTML audio/video content.",
          mimeTypes: [],
        },
      ],
      mimeTypes: [{ type: "application/pdf", suffixes: "pdf" }],
    });
    expect(first.speechSynthesis).toEqual({
      enabled: true,
      voices: [{ name: "Microsoft Huihui - Chinese (Simplified, PRC)", lang: "zh-CN", localService: true }],
    });
    expect(first.geolocation).toEqual({ mode: "custom", latitude: 31.2304, longitude: 121.4737, accuracy: 25 });
    expect(first.mediaDevices).toEqual({ enabled: true, audioInputs: 1, videoInputs: 1, audioOutputs: 1 });
  });

  it("encodes a versioned config without proprietary lumi.conf data", () => {
    const arg = buildBrowserFingerprintArg({ fingerprintSeed: 7, platform: "macos" }, "150.0.7871.114");
    expect(arg.startsWith(AGENT_BROWSER_FINGERPRINT_SWITCH)).toBe(true);
    const json = Buffer.from(arg.slice(AGENT_BROWSER_FINGERPRINT_SWITCH.length), "base64url").toString("utf8");
    const decoded = JSON.parse(json);
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.platform).toBe("MacIntel");
    expect(decoded.userAgent).toContain("Chrome/150.0.7871.114");
    expect(decoded.screen).toMatchObject({ availLeft: 0, availTop: 25, windowX: 32, windowY: 57, outerWidth: 1280, outerHeight: 800 });
    expect(decoded.webgl).toEqual({ vendor: "", renderer: "" });
    expect(decoded.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
    expect(decoded.speechSynthesis.voices.map((voice: { name: string }) => voice.name))
      .toEqual(["Samantha", "Alex"]);
    expect(decoded.pluginProfile.plugins[0]).toMatchObject({
      name: "Internal PDF Plugin",
      filename: "libpdf.dylib",
    });
    expect(decoded.pluginProfile.plugins[1].filename).toBe("libwidevinecdm.dylib");
    expect(decoded.pluginProfile.pdfViewerEnabled).toBe(true);
    expect(json).not.toContain("license");
    expect(json).not.toContain("lumi.conf");
  });

  it("selects default hardware as coherent seed-owned personas", () => {
    const windows = [1, 2, 3, 4, 5].map((fingerprintSeed) =>
      buildBrowserFingerprintConfig({ fingerprintSeed, platform: "windows" }, "150.0.7871.114"));
    expect(windows.map((config) => ({
      cpu: config.hardwareConcurrency,
      memory: config.deviceMemory,
      screen: `${config.screen.width}x${config.screen.height}@${config.screen.devicePixelRatio}`,
      id: config.hardwareProfile.id,
    }))).toEqual([
      { cpu: 8, memory: 16, screen: "1920x1080@1", id: "win-intel-irisxe-8c-16gb-1080p" },
      { cpu: 12, memory: 16, screen: "1920x1080@1", id: "win-nvidia-rtx3060-12c-16gb-1080p" },
      { cpu: 16, memory: 16, screen: "2560x1440@1", id: "win-nvidia-rtx4060-16c-16gb-1440p" },
      { cpu: 16, memory: 16, screen: "1920x1080@1", id: "win-amd-radeon-16c-16gb-1080p" },
      { cpu: 8, memory: 8, screen: "1920x1080@1", id: "win-intel-uhd620-8c-8gb-1080p" },
    ]);

    const mac = [1, 2, 3, 4].map((fingerprintSeed) =>
      buildBrowserFingerprintConfig({ fingerprintSeed, platform: "macos" }, "150.0.7871.114"));
    expect(mac.map((config) => ({
      cpu: config.hardwareConcurrency,
      memory: config.deviceMemory,
      screen: `${config.screen.width}x${config.screen.height}@${config.screen.devicePixelRatio}`,
      id: config.hardwareProfile.id,
    }))).toEqual([
      { cpu: 8, memory: 16, screen: "1512x982@2", id: "mac-apple-m2-8c-16gb-1512x982" },
      { cpu: 8, memory: 16, screen: "1710x1107@2", id: "mac-apple-m3-8c-16gb-1710x1107" },
      { cpu: 12, memory: 16, screen: "1728x1117@2", id: "mac-apple-m2pro-12c-16gb-1728x1117" },
      { cpu: 8, memory: 8, screen: "1440x900@2", id: "mac-apple-m1-8c-8gb-1440x900" },
    ]);
    for (const config of [...windows, ...mac]) {
      expect(config.webgl).toEqual({ vendor: "", renderer: "" });
      expect(config.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
    }

    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114"))
      .toEqual(buildBrowserFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114"));
  });

  it("keeps the legacy renderer composer and Firefox Windows GPU shape without spoofing Chromium", () => {
    const chromium = buildBrowserFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114", null, "chromium");
    const firefox = buildBrowserFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114", null, "firefox");
    expect(chromium.webgl).toEqual({ vendor: "", renderer: "" });
    expect(chromium.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
    expect(firefox.webgl.renderer).toBe("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)");
    expect(firefox.webgpu).toEqual({
      mode: "webgl",
      vendor: "NVIDIA",
      architecture: "Ampere",
      device: "NVIDIA GeForce RTX 3060",
      description: firefox.webgl.renderer,
      subgroupMinSize: 32,
      subgroupMaxSize: 32,
    });
    expect(firefox.userAgent).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0");
    expect(firefox.appVersion).toBe("5.0 (Windows)");
    expect(firefox.vendor).toBe("");
    expect(chromium.vendor).toBe("Google Inc.");
    expect(chromium.userAgent).toContain("Chrome/150.0.7871.114");
    const legacyChromeRenderer = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)";
    expect(composeGpuRenderer(firefox.webgl.renderer, "0x00002504", "chromium")).toBe(legacyChromeRenderer);
    expect(composeGpuRenderer(firefox.webgl.renderer, "0x00002504", "firefox")).toBe(firefox.webgl.renderer);
    expect(composeGpuRenderer(legacyChromeRenderer, "0x00002504", "chromium")).toBe(legacyChromeRenderer);
  });

  it("aligns Firefox Android UA with the seeded Android platform version", () => {
    const firefox = buildBrowserFingerprintConfig({ fingerprintSeed: 154004, platform: "android" }, "154.0", null, "firefox");
    expect(firefox.platformVersion).toBe("13.0.0");
    expect(firefox.userAgent).toContain("(Android 13; Mobile; rv:154.0)");
    expect(firefox.appVersion).toBe("5.0 (Android)");
  });

  it("uses Gecko's Apple privacy bucket and retains Android/native-WebGPU intents without spoofing Chromium", () => {
    for (const platform of ["macos", "android"] as const) {
      const chromium = buildBrowserFingerprintConfig({ fingerprintSeed: 3, platform }, "150.0.7871.114", null, "chromium");
      const firefox = buildBrowserFingerprintConfig({ fingerprintSeed: 3, platform }, "150.0.7871.114", null, "firefox");
      expect(chromium.webgl).toEqual({ vendor: "", renderer: "" });
      expect(firefox.webgl.renderer).toContain(platform === "macos" ? "Apple M1, or similar" : "Adreno (TM) 740");
      expect(firefox.webgl.renderer).not.toContain("(0x");
      expect(composeGpuRenderer(firefox.webgl.renderer, null, "chromium")).toBe(firefox.webgl.renderer);
      expect(firefox.webgpu).toEqual({
        mode: "webgl",
        vendor: platform === "macos" ? "Apple" : "Qualcomm",
        architecture: platform === "macos" ? "metal-3" : "Adreno 7xx",
        device: platform === "macos" ? "Apple M2 Pro" : "Adreno (TM) 740",
        description: platform === "macos" ? "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)" : firefox.webgl.renderer,
        subgroupMinSize: 32,
        subgroupMaxSize: 32,
      });
    }
  });

  it("rejects the former Chromium GPU override but preserves its Firefox tuple constraint", () => {
    const meta: BrowserFingerprintMeta = {
      fingerprintSeed: 99,
      platform: "windows",
      gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    };
    expect(() => buildBrowserFingerprintConfig(meta, "150.0.7871.114")).toThrow(/Unsupported GPU overrides for Chromium.*gpuRenderer/);
    const firefox = buildBrowserFingerprintConfig(meta, "154.0", null, "firefox");
    expect(firefox.webgl.renderer).toBe(meta.gpuRenderer);
    expect(firefox.hardwareProfile).toMatchObject({ id: "win-nvidia-rtx4060-16c-16gb-1440p", source: "validated-override" });
    expect(firefox.webgpu).toMatchObject({ vendor: "NVIDIA", architecture: "Lovelace" });
  });

  it("treats advanced non-GPU hardware fields as constraints on a complete persona", () => {
    const config = buildBrowserFingerprintConfig({
      fingerprintSeed: 99,
      platform: "windows",
      hardwareConcurrency: 16,
      screenWidth: 2560,
      screenHeight: 1440,
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
      webgl: { vendor: "", renderer: "" },
      webgpu: NATIVE_WEBGPU_CONFIG,
    });
  });

  it("rejects non-GPU advanced overrides that cannot belong to one supported persona", () => {
    for (const meta of [
      { fingerprintSeed: 100, platform: "windows", hardwareConcurrency: 8, screenWidth: 2560 },
      { fingerprintSeed: 101, platform: "macos", hardwareConcurrency: 12, screenWidth: 1710 },
      { fingerprintSeed: 102, platform: "windows", deviceMemory: 24 },
      { fingerprintSeed: 103, platform: "windows", hardwareConcurrency: 8.5 },
    ] as const) {
      expect(() => buildBrowserFingerprintConfig(meta, "150.0.7871.114")).toThrow(/Incoherent advanced hardware overrides/);
      expect(() => validateBrowserHardwareProfile(meta)).toThrow(/Incoherent advanced hardware overrides/);
    }
  });

  it("retains Firefox rejection of incoherent legacy GPU tuple overrides", () => {
    for (const meta of [
      {
        fingerprintSeed: 100,
        platform: "windows",
        hardwareConcurrency: 8,
        gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      { fingerprintSeed: 101, platform: "macos", gpuVendor: "Google Inc. (NVIDIA)" },
    ] as const) {
      expect(() => buildBrowserFingerprintConfig(meta, "154.0", null, "firefox")).toThrow(/Incoherent advanced hardware overrides/);
      expect(() => validateBrowserHardwareProfile(meta, "firefox")).toThrow(/Incoherent advanced hardware overrides/);
    }
  });

  it("keeps a large seed corpus inside the versioned joint-profile catalog", () => {
    const windowsIds = new Set<string>();
    const macIds = new Set<string>();
    for (let fingerprintSeed = 1; fingerprintSeed <= 500; fingerprintSeed++) {
      const windows = buildBrowserFingerprintConfig({ fingerprintSeed, platform: "windows" }, "150.0.7871.114");
      const mac = buildBrowserFingerprintConfig({ fingerprintSeed, platform: "macos" }, "150.0.7871.114");
      windowsIds.add(windows.hardwareProfile.id);
      macIds.add(mac.hardwareProfile.id);
      expect(windows.hardwareProfile).toMatchObject({ source: "seeded", fontProfile: "windows-portable", audioProfile: "chromium-desktop" });
      expect(mac.hardwareProfile).toMatchObject({ source: "seeded", fontProfile: "macos-system", audioProfile: "chromium-desktop" });
      expect(windows.webgl).toEqual({ vendor: "", renderer: "" });
      expect(mac.webgl).toEqual({ vendor: "", renderer: "" });
      expect(windows.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
      expect(mac.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
      const firefoxWindows = buildBrowserFingerprintConfig({ fingerprintSeed, platform: "windows" }, "154.0", null, "firefox");
      const firefoxMac = buildBrowserFingerprintConfig({ fingerprintSeed, platform: "macos" }, "154.0", null, "firefox");
      expect(firefoxWindows.hardwareProfile).toEqual(windows.hardwareProfile);
      expect(firefoxMac.hardwareProfile).toEqual(mac.hardwareProfile);
      expect(firefoxWindows.webgl.renderer).toContain(firefoxWindows.webgpu.vendor);
      expect(firefoxMac.webgl.renderer).toContain("Apple");
      expect(firefoxMac.webgpu.vendor).toBe("Apple");
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
    const config = buildBrowserFingerprintConfig({ fingerprintSeed: 8, geolocationMode: "disable" }, "149.0.7827.22");
    expect(config.geolocation).toEqual({ mode: "disable", latitude: null, longitude: null, accuracy: null });
  });

  it("preserves all native WebRTC policy modes", () => {
    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 10, webrtcMode: "disable" }, "149.0.7827.22").webrtc)
      .toEqual({ mode: "disable", publicIp: null });
    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 11, webrtcMode: "real", webrtcIp: "203.0.113.2" }, "149.0.7827.22").webrtc)
      .toEqual({ mode: "real", publicIp: null });
    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 12, webrtcMode: "altered", webrtcIp: "203.0.113.3" }, "149.0.7827.22").webrtc)
      .toEqual({ mode: "altered", publicIp: "203.0.113.3" });
    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 13, webrtcMode: "altered" }, "149.0.7827.22").webrtc)
      .toEqual({ mode: "altered", publicIp: null });
  });

  it("produces a coherent mobile Android persona with a touch + phone identity", () => {
    const config = buildBrowserFingerprintConfig({
      fingerprintSeed: 55,
      platform: "android",
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
    }, "150.0.7871.114");

    expect(Object.keys(config.hardwareProfile)).toEqual(["id", "source", "fontProfile", "audioProfile"]);
    expect(config.platform).toBe("Linux armv81");
    expect(config.platformVersion).toMatch(/^\d+\.0\.0$/);
    expect(config.maxTouchPoints).toBe(5);
    expect(config.screen.mobile).toBe(true);
    expect(config.screen.outerWidth).toBe(config.screen.availWidth);
    expect(config.screen.outerHeight).toBe(config.screen.availHeight);
    expect(config.screen.availTop).toBe(0);
    expect(config.screen.availLeft).toBe(0);
    expect(config.screen.windowX).toBe(0);
    expect(config.screen.windowY).toBe(0);
    expect(config.userAgent).toMatch(/^Mozilla\/5\.0 \(Linux; Android 1[34]; /);
    expect(config.userAgent).toContain(`Chrome/150.0.7871.114 Mobile Safari/537.36`);
    expect(config.appVersion).toContain("Mobile Safari");
    expect(config.hardwareProfile.fontProfile).toBe("android-system");
    expect(config.hardwareProfile.source).toBe("seeded");
    expect(config.webauthn.hybridTransport).toBe(false);
    expect(config.webauthn.passkeyPlatformAuthenticator).toBe(true);
    expect(config.mediaDevices).toEqual({ enabled: true, audioInputs: 1, videoInputs: 2, audioOutputs: 1 });
    expect(config.speechSynthesis.voices[0]).toEqual({
      name: "Google 普通话（中国大陆）", lang: "zh-CN", localService: true,
    });
    expect(config.fonts).toContain("Roboto");
    expect(config.fonts).toContain("sans-serif");
    expect(config.fonts.some((font) => /^Noto Sans (SC|CJK) SC|Noto Serif CJK SC$/.test(font))).toBe(true);
    expect(config.fonts).toEqual([...config.fonts].sort());
    expect(config.fonts.length).toBeGreaterThanOrEqual(4);
    expect(config.webgl).toEqual({ vendor: "", renderer: "" });
    expect(config.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
    expect(config.pluginProfile).toEqual({
      pdfViewerEnabled: true,
      plugins: [],
      mimeTypes: [],
    });
  });

  it("selects Android personas as seed-owned coherent tuples", () => {
    const corpus = [1, 2, 3, 4, 5, 6, 7, 8].map((fingerprintSeed) =>
      buildBrowserFingerprintConfig({ fingerprintSeed, platform: "android", locale: "en-US" }, "150.0.7871.114"));
    expect(new Set(corpus.map((config) => config.hardwareProfile.id)).size).toBeGreaterThan(1);
    for (const config of corpus) {
      expect(config.screen.width).toBeLessThan(500);
      expect(config.screen.height).toBeLessThan(1200);
      expect(config.screen.devicePixelRatio).toBeGreaterThan(1);
      expect(config.userAgent).toContain("Mobile");
      expect(config.maxTouchPoints).toBe(5);
      expect(config.hardwareProfile.source).toBe("seeded");
      expect(config.webrtc).toMatchObject({ mode: "real", publicIp: null });
      expect(config.pluginProfile.plugins).toEqual([]);
      expect(config.pluginProfile.pdfViewerEnabled).toBe(true);
    }
    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 7, platform: "android" }, "150.0.7871.114"))
      .toEqual(buildBrowserFingerprintConfig({ fingerprintSeed: 7, platform: "android" }, "150.0.7871.114"));
  });

  it("keeps legacy Firefox Android GPUs coherent with their WebGL/WebGPU vendor", () => {
    for (let fingerprintSeed = 1; fingerprintSeed <= 40; fingerprintSeed++) {
      const config = buildBrowserFingerprintConfig({ fingerprintSeed, platform: "android" }, "154.0", null, "firefox");
      expect(config.webgl.vendor).toContain("Google Inc. (");
      expect(config.webgpu.mode).toBe("webgl");
      if (config.webgpu.vendor === "Qualcomm") expect(config.webgl.renderer).toContain("Adreno");
      if (config.webgpu.vendor === "ARM") expect(config.webgl.renderer).toMatch(/Mali|Immortalis/);
    }
  });

  it("applies legacy Firefox Android GPU constraints to a complete mobile persona", () => {
    const config = buildBrowserFingerprintConfig({
      fingerprintSeed: 99,
      platform: "android",
      gpuRenderer: "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2 ANGLE (Google, Vulkan 1.3.0 (Adreno (TM) 740)))",
    }, "154.0", null, "firefox");
    expect(config.hardwareProfile.source).toBe("validated-override");
    expect(config.hardwareProfile.id).toMatch(/^android-/);
    expect(config.webgpu.vendor).toBe("Qualcomm");
  });

  it("rejects unsupported platforms instead of silently degrading to Windows", () => {
    expect(() => buildBrowserFingerprintConfig({ fingerprintSeed: 9, platform: "ios" as never }, "150.0.7871.114"))
      .toThrow(/Unsupported browser platform/);
    expect(() => buildBrowserFingerprintConfig({ fingerprintSeed: 9, platform: "linux" as never }, "150.0.7871.114"))
      .toThrow(/Unsupported browser platform/);
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
      const config = buildBrowserFingerprintConfig({ fingerprintSeed: 21, platform: "windows", locale }, "150.0.7871.114");
      expect(config.languages).toEqual([locale, locale.split("-")[0]]);
      expect(config.speechSynthesis.voices[0]).toEqual({ name: expectedVoice, lang: locale, localService: true });
    }

    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 22, platform: "macos", locale: "el-GR" }, "150.0.7871.114")
      .speechSynthesis.voices[0].name).toBe("Melina");
    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 23, platform: "macos", locale: "zh-TW" }, "150.0.7871.114")
      .speechSynthesis.voices[0].name).toBe("Mei-Jia");
  });

  it("rejects incomplete custom geolocation", () => {
    expect(() => buildBrowserFingerprintConfig({ fingerprintSeed: 9, geolocationMode: "custom", geolocationLatitude: 10 }, "149.0.7827.22"))
      .toThrow(/latitude|longitude/i);
  });

  it("keeps secure DNS disabled by default and carries a managed DoH block when enabled", () => {
    const defaultConfig = buildBrowserFingerprintConfig({ fingerprintSeed: 30, platform: "windows" }, "150.0.7871.114");
    expect(defaultConfig.secureDns).toEqual({ enabled: false, templates: [] });

    const secureDns = { enabled: true, templates: ["https://dns.google/dns-query{?dns}"] };
    const managedConfig = buildBrowserFingerprintConfig({ fingerprintSeed: 31, platform: "windows" }, "150.0.7871.114", secureDns);
    expect(managedConfig.secureDns).toEqual(secureDns);

    const arg = buildBrowserFingerprintArg({ fingerprintSeed: 32, platform: "macos" }, "150.0.7871.114", AGENT_BROWSER_FINGERPRINT_SWITCH, secureDns);
    const decoded = JSON.parse(Buffer.from(arg.slice(AGENT_BROWSER_FINGERPRINT_SWITCH.length), "base64url").toString("utf8"));
    expect(decoded.secureDns).toEqual(secureDns);
  });
});

describe("Chromium managed macOS Apple-model GPU policy", () => {
  it.each(MAC_GPU_PERSONAS)("projects $renderer without changing its original hardware tuple", (persona) => {
    const meta: BrowserFingerprintMeta = {
      fingerprintSeed: MAC_GPU_PERSONAS.indexOf(persona) || 4,
      platform: "macos",
      fingerprintMode: "managed",
    };
    const native = buildBrowserFingerprintConfig(meta, "152.0.7977.72");
    const config = buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT);
    expect(config).toEqual({ ...native, webgl: { vendor: "Google Inc. (Apple)", renderer: persona.renderer } });
    expect(config).toMatchObject({
      hardwareConcurrency: persona.cpu,
      deviceMemory: persona.memory,
      hardwareProfile: { id: persona.id, source: "seeded" },
      screen: { width: persona.width, height: persona.height, availTop: 25, devicePixelRatio: 2 },
      webgpu: NATIVE_WEBGPU_CONFIG,
    });
  });

  it("preserves every non-GPU field and the four-entry seed mapping across a 500-seed corpus", () => {
    for (let fingerprintSeed = 1; fingerprintSeed <= 500; fingerprintSeed++) {
      const meta: BrowserFingerprintMeta = { fingerprintSeed, platform: "macos", locale: "zh-CN", timezone: "Asia/Shanghai", webrtcMode: "disable" };
      const native = buildBrowserFingerprintConfig(meta, "152.0.7977.72");
      const managed = buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT);
      const persona = MAC_GPU_PERSONAS[fingerprintSeed % 4];
      expect(managed).toEqual({ ...native, webgl: { vendor: "Google Inc. (Apple)", renderer: persona.renderer } });
      expect(managed.hardwareProfile.id).toBe(persona.id);
      expect(managed.hardwareConcurrency).toBe(persona.cpu);
      expect(managed.deviceMemory).toBe(persona.memory);
      expect(managed.screen).toMatchObject({ width: persona.width, height: persona.height, availHeight: persona.height - 25, devicePixelRatio: 2 });
    }
  });

  it.each(MAC_GPU_PERSONAS)("accepts only the exact bare/legacy $renderer aliases as partial tuple constraints", (persona) => {
    const seed = 11;
    for (const overrides of [
      { gpuRenderer: persona.renderer },
      { gpuRenderer: legacyMacRenderer(persona.renderer) },
      { gpuVendor: "Google Inc. (Apple)", gpuRenderer: persona.renderer },
      { gpuVendor: "Google Inc. (Apple)", gpuRenderer: legacyMacRenderer(persona.renderer) },
      { hardwareConcurrency: persona.cpu, deviceMemory: persona.memory, screenWidth: persona.width, screenHeight: persona.height, taskbarHeight: 25, gpuRenderer: persona.renderer },
    ]) {
      const meta: BrowserFingerprintMeta = { fingerprintSeed: seed, platform: "macos", ...overrides };
      expect(() => validateBrowserHardwareProfile(meta)).not.toThrow();
      expect(() => validateBrowserHardwareProfile(meta, "chromium", MAC_ARM64_GPU_CONTEXT)).not.toThrow();
      const config = buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT);
      expect(config.hardwareProfile).toMatchObject({ id: persona.id, source: "validated-override" });
      expect(config.webgl).toEqual({ vendor: "Google Inc. (Apple)", renderer: persona.renderer });
      expect(getChromiumManagedGpuIdentity(meta, MAC_ARM64_GPU_CONTEXT)?.webgl).toEqual(config.webgl);
    }
  });

  it("keeps vendor-only and numeric partial constraints on the original joint catalog", () => {
    for (const overrides of [
      { gpuVendor: "Google Inc. (Apple)" },
      { hardwareConcurrency: 8, gpuVendor: "Google Inc. (Apple)" },
      { deviceMemory: 16, gpuVendor: "Google Inc. (Apple)" },
      { screenWidth: 1728, gpuVendor: "Google Inc. (Apple)" },
    ]) {
      const meta: BrowserFingerprintMeta = { fingerprintSeed: 99, platform: "macos", ...overrides };
      const baseline = buildBrowserFingerprintConfig({ ...meta, gpuVendor: undefined }, "152.0.7977.72");
      const config = buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT);
      expect(config).toEqual({
        ...baseline,
        hardwareProfile: { ...baseline.hardwareProfile, source: "validated-override" },
        webgl: { vendor: "Google Inc. (Apple)", renderer: legacyModel(baseline.hardwareProfile.id) },
      });
    }
  });

  it("rejects unknown models, loose aliases, mixed tuples and invalid field types instead of coercing them", () => {
    const invalidOverrides: Record<string, unknown>[] = [
      { gpuRenderer: "Apple M1 Pro" },
      { gpuRenderer: "Apple M1Pro" },
      { gpuRenderer: legacyMacRenderer("Apple M1 Pro") },
      { gpuRenderer: legacyMacRenderer("Apple M4") },
      { gpuRenderer: "Apple M4" },
      { gpuRenderer: "apple m1" },
      { gpuRenderer: " Apple M1" },
      { gpuRenderer: "Apple M1 " },
      { gpuRenderer: legacyMacRenderer("Apple M1").replace("Unspecified Version", "Other Version") },
      { gpuRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
      { gpuRenderer: " " },
      { gpuVendor: "Apple" },
      { gpuVendor: "Google Inc. (NVIDIA)", gpuRenderer: "Apple M1" },
      { gpuVendor: " Google Inc. (Apple)" },
      { gpuRenderer: "Apple M1", hardwareConcurrency: 12 },
      { gpuRenderer: "Apple M1", deviceMemory: 16 },
      { gpuRenderer: "Apple M2", screenWidth: 1710 },
      { gpuRenderer: "Apple M3", screenHeight: 982 },
      { gpuRenderer: "Apple M2 Pro", taskbarHeight: 48 },
      { hardwareConcurrency: "8" },
      { deviceMemory: 8.5 },
      { screenWidth: Number.NaN },
      { screenHeight: Number.POSITIVE_INFINITY },
      { gpuRenderer: 1 },
      { gpuVendor: false },
      { gpuRenderer: ["Apple M1"] },
      { gpuRenderer: { toString: () => "Apple M1" } },
      { gpuRenderer: { toString: () => legacyMacRenderer("Apple M1") } },
      { gpuVendor: { toString: () => "Google Inc. (Apple)" } },
      { gpuRenderer: new String("Apple M1") },
    ];
    for (const overrides of invalidOverrides) {
      const meta = { fingerprintSeed: 99, platform: "macos", ...overrides } as BrowserFingerprintMeta;
      expect(() => validateBrowserHardwareProfile(meta), JSON.stringify(overrides)).toThrow(/Incoherent advanced hardware overrides/);
      expect(() => validateBrowserHardwareProfile(meta, "chromium", MAC_ARM64_GPU_CONTEXT)).toThrow(/Incoherent advanced hardware overrides/);
      expect(() => buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT))
        .toThrow(/Incoherent advanced hardware overrides/);
      expect(() => getChromiumManagedGpuIdentity(meta, MAC_ARM64_GPU_CONTEXT)).toThrow(/Incoherent advanced hardware overrides/);
    }
  });

  it.each([
    { name: "missing context", context: undefined },
    { name: "null context", context: null as unknown as ChromiumGpuContext },
    { name: "incomplete context", context: {} as ChromiumGpuContext },
    { name: "unknown kernel architecture", context: { ...MAC_ARM64_GPU_CONTEXT, kernelArchitecture: null } },
    { name: "x64 main process / Rosetta", context: { ...MAC_ARM64_GPU_CONTEXT, hostArchitecture: "x64" } },
    { name: "x64 kernel", context: { ...MAC_ARM64_GPU_CONTEXT, kernelArchitecture: "x64" } },
    { name: "Windows host", context: { ...MAC_ARM64_GPU_CONTEXT, hostPlatform: "win32" } },
    { name: "Linux host", context: { ...MAC_ARM64_GPU_CONTEXT, hostPlatform: "linux" } },
    { name: "unrecognized platform casing", context: { ...MAC_ARM64_GPU_CONTEXT, hostPlatform: "Darwin" } },
    { name: "unrecognized architecture casing", context: { ...MAC_ARM64_GPU_CONTEXT, kernelArchitecture: "ARM64" } },
  ])("keeps native GPU and rejects runtime overrides for $name", ({ context }) => {
    const meta: BrowserFingerprintMeta = { fingerprintSeed: 3, platform: "macos" };
    const config = buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", context);
    expect(config.webgl).toEqual({ vendor: "", renderer: "" });
    expect(config.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
    expect(() => validateBrowserHardwareProfile(meta, "chromium", context)).not.toThrow();
    const explicit = { ...meta, gpuRenderer: "Apple M2 Pro" };
    expect(() => buildBrowserFingerprintConfig(explicit, "152.0.7977.72", null, "chromium", context)).toThrow(GPU_SUPPORT_ERROR);
    expect(() => buildBrowserFingerprintArg(explicit, "152.0.7977.72", AGENT_BROWSER_FINGERPRINT_SWITCH, null, "chromium", context))
      .toThrow(GPU_SUPPORT_ERROR);
    if (context === undefined) {
      expect(() => validateBrowserHardwareProfile(explicit, "chromium", context)).not.toThrow();
    } else {
      expect(() => validateBrowserHardwareProfile(explicit, "chromium", context)).toThrow(GPU_SUPPORT_ERROR);
    }
    expect(getChromiumManagedGpuIdentity(meta, context)).toBeNull();
  });

  it.each(["windows", "android"] as const)("does not change native Chromium GPU or permit explicit GPU fields for %s", (platform) => {
    const meta: BrowserFingerprintMeta = { fingerprintSeed: 3, platform };
    expect(buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT))
      .toEqual(buildBrowserFingerprintConfig(meta, "152.0.7977.72"));
    expect(getChromiumManagedGpuIdentity(meta, MAC_ARM64_GPU_CONTEXT)).toBeNull();
    for (const overrides of [{ gpuVendor: "Google Inc. (Apple)" }, { gpuRenderer: "Apple M1" }]) {
      const explicit = { ...meta, ...overrides };
      expect(() => validateBrowserHardwareProfile(explicit)).toThrow(/Unsupported GPU overrides for Chromium:/);
      expect(() => validateBrowserHardwareProfile(explicit, "chromium", MAC_ARM64_GPU_CONTEXT)).toThrow(GPU_SUPPORT_ERROR);
      expect(() => buildBrowserFingerprintConfig(explicit, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT)).toThrow(GPU_SUPPORT_ERROR);
    }
  });

  it("keeps off mode native and rejects active GPU constraints only at runtime validation", () => {
    const meta: BrowserFingerprintMeta = { fingerprintSeed: 3, platform: "macos", fingerprintMode: "off" };
    const config = buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT);
    expect(config).toEqual(buildBrowserFingerprintConfig(meta, "152.0.7977.72"));
    expect(config.webgl).toEqual({ vendor: "", renderer: "" });
    expect(getChromiumManagedGpuIdentity(meta, MAC_ARM64_GPU_CONTEXT)).toBeNull();
    const explicit = { ...meta, gpuRenderer: "Apple M1" };
    expect(() => validateBrowserHardwareProfile(explicit)).not.toThrow();
    expect(() => validateBrowserHardwareProfile(explicit, "chromium", MAC_ARM64_GPU_CONTEXT)).toThrow(GPU_SUPPORT_ERROR);
    expect(() => buildBrowserFingerprintConfig(explicit, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT)).toThrow(GPU_SUPPORT_ERROR);
  });

  it("treats undefined, null and empty GPU fields as absent constraints even on supported Mac contexts", () => {
    const meta: BrowserFingerprintMeta = { fingerprintSeed: 4, platform: "macos" };
    const seeded = buildBrowserFingerprintConfig(meta, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT);
    for (const overrides of [{ gpuVendor: undefined, gpuRenderer: undefined }, { gpuVendor: null, gpuRenderer: null }, { gpuVendor: "", gpuRenderer: "" }]) {
      const explicit = { ...meta, ...overrides };
      expect(() => validateBrowserHardwareProfile(explicit, "chromium", MAC_ARM64_GPU_CONTEXT)).not.toThrow();
      expect(buildBrowserFingerprintConfig(explicit, "152.0.7977.72", null, "chromium", MAC_ARM64_GPU_CONTEXT)).toEqual(seeded);
      expect(getChromiumManagedGpuIdentity(explicit, MAC_ARM64_GPU_CONTEXT)?.webgl).toEqual(seeded.webgl);
    }
    expect(seeded.hardwareProfile.source).toBe("seeded");
    expect(seeded.webgl).toEqual({ vendor: "Google Inc. (Apple)", renderer: "Apple M1" });
  });

  it("returns a deterministic detached policy projection for request hashing without mutating its inputs", () => {
    const meta = Object.freeze({ fingerprintSeed: 99, platform: "macos" as const, gpuRenderer: legacyMacRenderer("Apple M2 Pro") });
    const expected = {
      policy: "macos-arm64-apple-model-v1",
      hostPlatform: "darwin",
      hostArchitecture: "arm64",
      kernelArchitecture: "arm64",
      webgl: { vendor: "Google Inc. (Apple)", renderer: "Apple M2 Pro" },
    };
    const first = getChromiumManagedGpuIdentity(meta, MAC_ARM64_GPU_CONTEXT);
    expect(first).toEqual(expected);
    expect(getChromiumManagedGpuIdentity({ ...meta, gpuRenderer: "Apple M2 Pro" }, MAC_ARM64_GPU_CONTEXT)).toEqual(expected);
    first!.webgl.renderer = "mutated result";
    expect(getChromiumManagedGpuIdentity(meta, MAC_ARM64_GPU_CONTEXT)).toEqual(expected);
    for (const platform of [undefined, "ios", "linux", null] as const) {
      expect(getChromiumManagedGpuIdentity({ fingerprintSeed: 4, platform } as BrowserFingerprintMeta, MAC_ARM64_GPU_CONTEXT)).toBeNull();
    }
  });

  it("threads the sixth argument into both supported fingerprint switches without changing secure DNS", () => {
    const meta: BrowserFingerprintMeta = { fingerprintSeed: 4, platform: "macos", gpuRenderer: "Apple M2" };
    const secureDns = { enabled: true, templates: ["https://dns.google/dns-query{?dns}"] };
    const expected = buildBrowserFingerprintConfig(meta, "152.0.7977.72", secureDns, "chromium", MAC_ARM64_GPU_CONTEXT);
    for (const prefix of [AGENT_BROWSER_FINGERPRINT_SWITCH, LEGACY_FINGERPRINT_SWITCH]) {
      const arg = buildBrowserFingerprintArg(meta, "152.0.7977.72", prefix, secureDns, "chromium", MAC_ARM64_GPU_CONTEXT);
      const decoded = JSON.parse(Buffer.from(arg.slice(prefix.length), "base64url").toString("utf8"));
      expect(arg.startsWith(prefix)).toBe(true);
      expect(decoded).toEqual(expected);
      expect(decoded.webgl).toEqual({ vendor: "Google Inc. (Apple)", renderer: "Apple M2" });
      expect(decoded.webgpu).toEqual(NATIVE_WEBGPU_CONFIG);
    }
  });

  it("projects Firefox Apple WebGL independently of Chromium while preserving native-WebGPU and catalog selection", () => {
    for (const persona of MAC_GPU_PERSONAS) {
      const meta: BrowserFingerprintMeta = { fingerprintSeed: 99, platform: "macos", gpuRenderer: legacyMacRenderer(persona.renderer) };
      const baseline = buildBrowserFingerprintConfig(meta, "154.0", null, "firefox");
      expect(buildBrowserFingerprintConfig(meta, "154.0", null, "firefox", MAC_ARM64_GPU_CONTEXT)).toEqual(baseline);
      expect(() => validateBrowserHardwareProfile(meta, "firefox", { ...MAC_ARM64_GPU_CONTEXT, kernelArchitecture: null })).not.toThrow();
      expect(baseline.webgl).toEqual({ vendor: "Apple", renderer: "Apple M1, or similar" });
      expect(baseline.webgpu).toEqual({
        mode: "webgl", vendor: "Apple", architecture: "metal-3", device: persona.renderer,
        description: legacyMacRenderer(persona.renderer), subgroupMinSize: 32, subgroupMaxSize: 32,
      });
      expect(buildBrowserFingerprintConfig({ ...meta, gpuRenderer: ` ${meta.gpuRenderer} ` }, "154.0", null, "firefox")).toEqual(baseline);
      expect(() => validateBrowserHardwareProfile({ ...meta, gpuRenderer: persona.renderer }, "firefox")).toThrow(/Incoherent advanced hardware overrides/);
    }
  });
});

function legacyModel(id: string): string {
  const persona = MAC_GPU_PERSONAS.find((item) => item.id === id);
  expect(persona, `Unknown original Mac persona ${id}`).toBeDefined();
  return persona!.renderer;
}
