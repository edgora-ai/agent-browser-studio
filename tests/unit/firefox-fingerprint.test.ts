// Unit tests for Firefox managed identity (Slice 79): the prefs family and
// the WebDriver BiDi preload script that carry fingerprint parity, plus the
// full bundle builder shared with Chromium's BrowserFingerprintConfig.
import { describe, it, expect } from "vitest";
import {
  normalizeFirefoxVersion,
  buildFirefoxUserAgent,
  buildFirefoxFingerprintPrefs,
  buildFirefoxFingerprintPreloadScript,
  buildFirefoxManagedIdentity,
  buildInjectionProbeExpression,
  buildInjectionProbeExpectation,
  judgeInjectionProbe,
  shouldBlockInjectionProbe,
} from "../../src/main/services/firefox-fingerprint.js";
import { buildBrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";
import type { BrowserFingerprintMeta } from "../../src/main/types.js";

function meta(overrides: Partial<BrowserFingerprintMeta> = {}): BrowserFingerprintMeta {
  return {
    fingerprintSeed: 4242,
    platform: "windows",
    locale: "en-US",
    ...overrides,
  } as BrowserFingerprintMeta;
}

describe("buildFirefoxUserAgent", () => {
  it("builds a real Firefox UA for Windows and macOS platforms", () => {
    expect(buildFirefoxUserAgent("Win32", "137.0.2")).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0");
    expect(buildFirefoxUserAgent("MacIntel", "136.1.0")).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.1) Gecko/20100101 Firefox/136.1");
  });

  it("normalizes missing/odd versions to a sane Firefox version", () => {
    expect(normalizeFirefoxVersion(null)).toBe("135.0");
    expect(normalizeFirefoxVersion("138")).toBe("138.0");
    expect(normalizeFirefoxVersion("Mozilla Firefox 139.0.1")).toBe("139.0");
  });
});

describe("buildFirefoxFingerprintPrefs", () => {
  it("carries UA override, hardware concurrency, language and DNT", () => {
    const config = buildBrowserFingerprintConfig(meta({ fingerprintSeed: 7, locale: "zh-CN" }), null);
    const prefs = buildFirefoxFingerprintPrefs(config, "137.0");
    expect(prefs["general.useragent.override"]).toContain("Firefox/137.0");
    expect(prefs["general.useragent.site_specific_overrides"]).toBe(false);
    expect(prefs["dom.maxHardwareConcurrency"]).toBe(config.hardwareConcurrency);
    expect(prefs["intl.accept_languages"]).toBe("zh-CN,zh");
    expect(prefs["privacy.donottrackheader.enabled"]).toBe(true);
    expect(prefs["privacy.donottrackheader.value"]).toBe(1);
  });

  it("omits DNT when the config has it disabled", () => {
    const config = buildBrowserFingerprintConfig(meta(), null);
    const withDnt = buildFirefoxFingerprintPrefs({ ...config, doNotTrack: null }, "137.0");
    expect(withDnt["privacy.donottrackheader.enabled"]).toBeUndefined();
  });
});

describe("buildFirefoxFingerprintPreloadScript", () => {
  const config = buildBrowserFingerprintConfig(
    meta({
      fingerprintSeed: 20240819,
      platform: "macos",
      locale: "en-US",
      timezone: "America/New_York",
      geolocationMode: "custom",
      geolocationLatitude: 40.7128,
      geolocationLongitude: -74.006,
    }),
    null,
  );
  const script = buildFirefoxFingerprintPreloadScript(config);

  it("embeds the same BrowserFingerprintConfig JSON that drives Chromium", () => {
    expect(script).toContain(JSON.stringify(config.seed));
    expect(script).toContain(JSON.stringify(config.hardwareConcurrency));
    expect(script).toContain(config.timezone);
  });

  it("overrides navigator platform / languages / webdriver", () => {
    expect(script).toContain('Navigator.prototype, "platform"');
    expect(script).toContain('Navigator.prototype, "languages"');
    expect(script).toContain('Navigator.prototype, "webdriver", false');
  });

  it("shims screen metrics, devicePixelRatio and window geometry", () => {
    expect(script).toContain('Screen.prototype, "width"');
    expect(script).toContain('"availHeight"');
    expect(script).toContain('"devicePixelRatio"');
    expect(script).toContain(config.screen.width.toString());
  });

  it("injects deterministic canvas seed noise and WebGL identity", () => {
    expect(script).toContain("seedFromHex(cfg.canvas.seed)");
    expect(script).toContain("mulberry32");
    expect(script).toContain(config.webgl.vendor);
    expect(script).toContain(config.webgl.renderer);
  });

  it("patches timezone via Intl.resolvedOptions + Date.getTimezoneOffset", () => {
    expect(script).toContain("resolvedOptions");
    expect(script).toContain('"getTimezoneOffset"');
    expect(script).toContain("timeZoneName: \"shortOffset\"");
  });

  it("patches geolocation to the configured custom coordinates", () => {
    expect(script).toContain("cfg.geolocation.mode === \"real\"");
    expect(script).toContain("cfg.geolocation.mode === \"disable\"");
    expect(script).toContain("PERMISSION_DENIED");
    expect(script).toContain("latitude: cfg.geolocation.latitude");
  });

  it("patches media devices, speech voices, storage quota and audio noise", () => {
    expect(script).toContain('"enumerateDevices"');
    expect(script).toContain('speechSynthesis.getVoices');
    expect(script).toContain("cfg.storageQuotaBytes");
    expect(script).toContain("copyToChannel");
  });

  it("reaches OffscreenCanvas 2d + WebGL and WebGPU adapter identity (Slice 79.1)", () => {
    // OffscreenCanvas 2D noise — same deterministic seed family as the page.
    expect(script).toContain("OffscreenCanvasRenderingContext2D.prototype");
    expect(script).toContain('patchProto(typeof OffscreenCanvasRenderingContext2D !== "undefined" ? OffscreenCanvasRenderingContext2D.prototype : null)');
    // Shared WebGL patch helper used by BOTH the page canvas and offscreen.
    expect(script).toContain("function patchWebglContext(ctx)");
    expect(script).toContain('typeof OffscreenCanvas !== "undefined" ? OffscreenCanvas.prototype : null');
    // WebGPU adapter identity (navigator.gpu / adapter.info, Firefox 137+).
    expect(script).toContain("navigator.gpu.requestAdapter");
    expect(script).toContain("gpuInfo.vendor");
    expect(script).toContain("subgroupMinSize");
  });

  it("is deterministic for the same seed (drift-stable identity)", () => {
    expect(buildFirefoxFingerprintPreloadScript(config)).toBe(script);
  });
});

describe("buildFirefoxManagedIdentity", () => {
  it("produces a coherent bundle of config/prefs/script/UA", () => {
    const bundle = buildFirefoxManagedIdentity(meta({ fingerprintSeed: 555, locale: "de-DE", platform: "windows" }), "138.0");
    expect(bundle.userAgent).toContain("Firefox/138.0");
    expect(bundle.prefs["general.useragent.override"]).toBe(bundle.userAgent);
    expect(bundle.prefs["dom.maxHardwareConcurrency"]).toBe(bundle.config.hardwareConcurrency);
    expect(bundle.preloadScript).toContain(bundle.config.seed.toString());
    expect(bundle.preloadScript).toContain("cfg.screen.width");
  });
});

describe("injection self-check probe (Slice 79.2)", () => {
  const exp = buildInjectionProbeExpectation(buildBrowserFingerprintConfig(meta({})));

  it("expression carries a marker, reads webdriver and double-draws a canvas", () => {
    const expression = buildInjectionProbeExpression();
    expect(expression).toContain("roxy-managed-probe");
    expect(expression).toContain("navigator.webdriver");
    expect(expression).toContain("doubleDrawEqual");
    expect(expression).toContain("getImageData");
    expect(expression).toContain("drawCanvas");
  });

  it("confirms injection when webdriver is disarmed and fields match", () => {
    const check = judgeInjectionProbe(
      { webdriver: false, doubleDrawEqual: false, platform: exp.platform, language: exp.language, screenWidth: exp.screenWidth, hardwareConcurrency: exp.hardwareConcurrency },
      exp,
    );
    expect(check.checked).toBe(true);
    expect(check.confirmed).toBe(true);
    expect(check.ambiguous).toBe(false);
    expect(check.noiseActive).toBe(true);
    expect(check.mismatches).toHaveLength(0);
    expect(shouldBlockInjectionProbe(check, undefined)).toBe(false);
  });

  it("flags a dead injection (webdriver still true — the BiDi-automation tell)", () => {
    const check = judgeInjectionProbe({ webdriver: true, doubleDrawEqual: true }, exp);
    expect(check.checked).toBe(true);
    expect(check.confirmed).toBe(false);
    expect(check.ambiguous).toBe(false);
    expect(shouldBlockInjectionProbe(check, undefined)).toBe(true);
    expect(shouldBlockInjectionProbe(check, false)).toBe(false);
  });

  it("reports injected fields that drifted from the managed identity", () => {
    const check = judgeInjectionProbe(
      { webdriver: false, doubleDrawEqual: false, platform: "Win32", language: "de-DE", screenWidth: 999, hardwareConcurrency: 2 },
      { ...exp, platform: "MacIntel" },
    );
    expect(check.confirmed).toBe(true);
    expect(check.mismatches).toEqual(expect.arrayContaining(["platform", "language", "screenWidth", "hardwareConcurrency"]));
  });

  it("is ambiguous (never blocking) when the probe could not decide", () => {
    const check = judgeInjectionProbe(null, exp);
    expect(check.checked).toBe(false);
    expect(check.ambiguous).toBe(true);
    expect(shouldBlockInjectionProbe(check, undefined)).toBe(false);

    const noWebdriver = judgeInjectionProbe({ platform: "MacIntel" }, exp);
    expect(noWebdriver.checked).toBe(true);
    expect(noWebdriver.ambiguous).toBe(true);
    expect(shouldBlockInjectionProbe(noWebdriver, undefined)).toBe(false);
  });

  it("expectation mirrors the preload's own patch surface (platform/language/screen/hwc/webdriver)", () => {
    expect(exp.webdriver).toBe(false);
    expect(exp.platform).toBe("Win32");
    expect(exp.language).toBe("en-US");
    expect(exp.screenWidth).toBe(1920);
    expect(typeof exp.hardwareConcurrency).toBe("number");
  });
});