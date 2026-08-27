import { describe, expect, it } from "vitest";
import {
  buildBrowserFingerprintArg,
  buildBrowserFingerprintConfig,
  AGENT_BROWSER_FINGERPRINT_SWITCH,
} from "../../src/main/services/browser-fingerprint-config.js";

describe("Agent Browser fingerprint config", () => {
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
    expect(decoded.webgpu).toEqual({
      mode: "webgl",
      vendor: "Apple",
      architecture: "metal-3",
      subgroupMinSize: 32,
      subgroupMaxSize: 32,
    });
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
      gpu: config.webgpu.vendor,
    }))).toEqual([
      { cpu: 8, memory: 16, screen: "1920x1080@1", gpu: "Intel" },
      { cpu: 12, memory: 16, screen: "1920x1080@1", gpu: "NVIDIA" },
      { cpu: 16, memory: 16, screen: "2560x1440@1", gpu: "NVIDIA" },
      { cpu: 16, memory: 16, screen: "1920x1080@1", gpu: "AMD" },
      { cpu: 8, memory: 8, screen: "1920x1080@1", gpu: "Intel" },
    ]);

    const mac = [1, 2, 3, 4].map((fingerprintSeed) =>
      buildBrowserFingerprintConfig({ fingerprintSeed, platform: "macos" }, "150.0.7871.114"));
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

    expect(buildBrowserFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114"))
      .toEqual(buildBrowserFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114"));
  });

  it("composes the Windows renderer per engine: Chrome embeds the PCI device id, Firefox strips it", () => {
    const chromium = buildBrowserFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114", null, "chromium");
    const firefox = buildBrowserFingerprintConfig({ fingerprintSeed: 2, platform: "windows" }, "150.0.7871.114", null, "firefox");
    expect(chromium.webgl.renderer).toBe("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    expect(firefox.webgl.renderer).toBe("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)");
    // Chrome's device-id form must be a strict refinement of the persona base string.
    expect(chromium.webgl.renderer.startsWith(firefox.webgl.renderer.split(" Direct3D11")[0])).toBe(true);
    // WebGPU identity derivation is unaffected by the embedded device id.
    expect(chromium.webgpu).toEqual(firefox.webgpu);
  });

  it("keeps Metal and Android renderer forms shared across engines (no device id exists there)", () => {
    for (const platform of ["macos", "android"] as const) {
      const chromium = buildBrowserFingerprintConfig({ fingerprintSeed: 3, platform }, "150.0.7871.114", null, "chromium");
      const firefox = buildBrowserFingerprintConfig({ fingerprintSeed: 3, platform }, "150.0.7871.114", null, "firefox");
      expect(chromium.webgl.renderer).toBe(firefox.webgl.renderer);
      expect(chromium.webgl.renderer).not.toContain("(0x");
    }
  });

  it("composes an explicit gpuRenderer override with the Chrome device id too", () => {
    const config = buildBrowserFingerprintConfig({
      fingerprintSeed: 99,
      platform: "windows",
      gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    }, "150.0.7871.114");
    expect(config.webgl.renderer).toBe("ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)");
  });

  it("treats advanced hardware fields as constraints on a complete persona", () => {
    const config = buildBrowserFingerprintConfig({
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
    expect(() => buildBrowserFingerprintConfig({
      fingerprintSeed: 100,
      platform: "windows",
      hardwareConcurrency: 8,
      gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    }, "150.0.7871.114")).toThrow(/Incoherent advanced hardware overrides/);
    expect(() => buildBrowserFingerprintConfig({
      fingerprintSeed: 101,
      platform: "macos",
      gpuVendor: "Google Inc. (NVIDIA)",
    }, "150.0.7871.114")).toThrow(/Incoherent advanced hardware overrides/);
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
    expect(config.webgpu).toMatchObject({ mode: "webgl" });
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

  it("keeps every Android GPU coherent with its WebGL/WebGPU vendor", () => {
    for (let fingerprintSeed = 1; fingerprintSeed <= 40; fingerprintSeed++) {
      const config = buildBrowserFingerprintConfig({ fingerprintSeed, platform: "android" }, "150.0.7871.114");
      expect(config.webgl.vendor).toContain("Google Inc. (");
      if (config.webgpu.vendor === "Qualcomm") expect(config.webgl.renderer).toContain("Adreno");
      if (config.webgpu.vendor === "ARM") expect(config.webgl.renderer).toMatch(/Mali|Immortalis/);
    }
  });

  it("applies Android as a constraint on a complete mobile persona", () => {
    const config = buildBrowserFingerprintConfig({
      fingerprintSeed: 99,
      platform: "android",
      gpuRenderer: "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2 ANGLE (Google, Vulkan 1.3.0 (Adreno (TM) 740)))",
    }, "150.0.7871.114");
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
