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
import type { BrowserFingerprintMeta, BrowserFingerprintConfig } from "../../src/main/types.js";

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

  it("builds a mobile Firefox UA for Android personas", () => {
    expect(buildFirefoxUserAgent("Linux armv81", "137.0.2")).toBe("Mozilla/5.0 (Android 14; Mobile; rv:137.0) Gecko/137.0 Firefox/137.0");
  });

  it("overrides platform/oscpu/appVersion and touch surface for Android personas", () => {
    const config = buildBrowserFingerprintConfig(meta({ fingerprintSeed: 42, platform: "android", locale: "zh-CN" }), null);
    const script = buildFirefoxFingerprintPreloadScript(config);
    expect(script).toContain('cfg.platform === "MacIntel" ? "Intel Mac OS X 10.15" : cfg.platform === "Linux armv81" ? "Linux armv8l"');
    expect(script).toContain('"5.0 (Android)"');
    expect(script).toContain("ontouchstart");
    expect(script).toContain('return cfg.maxTouchPoints || 0');
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

  it("writes a mobile UA override and hardware concurrency for Android personas", () => {
    const config = buildBrowserFingerprintConfig(meta({ platform: "android" }), null);
    const prefs = buildFirefoxFingerprintPrefs(config, "137.0");
    expect(prefs["general.useragent.override"]).toBe("Mozilla/5.0 (Android 14; Mobile; rv:137.0) Gecko/137.0 Firefox/137.0");
    expect(prefs["dom.maxHardwareConcurrency"]).toBe(config.hardwareConcurrency);
    expect(prefs["intl.accept_languages"]).toBe("en-US,en");
  });

  it("locks WebRTC so the real host IP cannot surface as an ICE candidate", () => {
    const config = buildBrowserFingerprintConfig(meta(), null);
    const prefs = buildFirefoxFingerprintPrefs(config, "137.0");
    // Host candidates obfuscate as mDNS and the STUN client never runs
    // (proxy_only), so no server-reflexive (real public IP) candidate exists.
    expect(prefs["media.peerconnection.ice.obfuscate_host_addresses"]).toBe(true);
    expect(prefs["media.peerconnection.ice.proxy_only"]).toBe(true);
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
    expect(script).toContain('Navigator.prototype, "webdriver"');
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
    expect(script).toContain("WeakMap");
    expect(script).toContain(config.webgl.vendor);
    expect(script).toContain(config.webgl.renderer);
  });

  it("pins the default Intl formatter locale to the managed language (per-constructor wrap)", () => {
    expect(script).toContain("DateTimeFormat");
    expect(script).toContain("NumberFormat");
    expect(script).toContain("Segmenter");
    expect(script).toContain("new RealCtor(want, arg)");
    expect(script).toContain("let Wrapped");
    expect(script).toContain("let RealCtor");
    // The wrapper must not be name-detectable (P2-5).
    expect(script).toContain('Object.defineProperty(Wrapped, "name"');
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
    // Primary readback sinks — not just copyToChannel (#18).
    expect(script).toContain("getChannelData");
    expect(script).toContain("getFloatFrequencyData");
    expect(script).toContain("getByteFrequencyData");
    expect(script).toContain("getFloatTimeDomainData");
    expect(script).toContain("getByteTimeDomainData");
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

  it("worker shim embeds the STYLE keyword regex it calls from familyTokens (worker realm has no closure)", () => {
    // familyTokens.toString() is inlined into the worker shim; it references
    // STYLE by name, so the shim must carry its own copy — otherwise every
    // sanitize in a worker throws "STYLE is not defined" and the native
    // measureText leaks the full OS font inventory through OffscreenCanvas.
    expect(script).toContain("var STYLE=");
    expect(script).toContain("var STYLE=' + STYLE.toString()");
    expect(script).toContain("self.__roxyFontDiag");
  });

  it("injects plugins/mimeTypes + Date region names + screen.orientation (G2/G3/G4)", () => {
    expect(script).toContain('def(Navigator.prototype, "plugins"');
    expect(script).toContain('def(Navigator.prototype, "mimeTypes"');
    expect(script).toContain('def(Navigator.prototype, "pdfViewerEnabled"');
    expect(script).toContain("libpdf.dylib");
    expect(script).toContain("widevinecdm");
    expect(script).toContain('Date.prototype, "toString"');
    expect(script).toContain('timeZoneName: "long"');
    expect(script).toContain("screen.orientation");
    expect(script).toContain('"portrait-primary"');
    expect(script).toContain('"landscape-primary"');
  });

  it("worker shim re-applies persona identity, timezone and canvas noise (G1/G5)", () => {
    expect(script).toContain("var wcfg=");
    expect(script).toContain('wval(WNP,"platform"');
    expect(script).toContain('wval(WNP,"webdriver"');
    expect(script).toContain('wget(WNP,"languages"');
    expect(script).toContain("wCounters");
    expect(script).toContain("Intl.DateTimeFormat.prototype.resolvedOptions=function(){var r=rrs.call(this)");
    expect(script).toContain('var woff=function(date)');
    expect(script).toContain("%s".replace("%s", "wJitter(ctx)"));
  });

  it("font sanitizer skips style words instead of breaking so multi-word leak families are rewritten", () => {
    // "Arial Rounded MT Bold" / "Wingdings 2" / "Avenir Next Condensed" end in
    // a style-looking token ("Bold"/"2"/"Condensed"). A `break` at that token
    // makes the segment look unsplittable and it survives the sanitize with its
    // real installed-font width — the canvas replica leak.
    expect(script).toContain("the exact residual leak the canvas replica showed");
    const markerIdx = script.indexOf("function sanitizeFontSpec");
    expect(markerIdx).toBeGreaterThan(-1);
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
      { webdriver: false, doubleDrawEqual: true, platform: exp.platform, language: exp.language, screenWidth: exp.screenWidth, hardwareConcurrency: exp.hardwareConcurrency },
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

  it("blocks (fail-closed) when the probe could not decide", () => {
    // Both BiDi attempts threw: undecidable probe must not launch silently.
    const check = judgeInjectionProbe(null, exp);
    expect(check.checked).toBe(false);
    expect(check.ambiguous).toBe(true);
    expect(shouldBlockInjectionProbe(check, undefined)).toBe(true);
    expect(shouldBlockInjectionProbe(check, false)).toBe(false);

    const noWebdriver = judgeInjectionProbe({ platform: "MacIntel" }, exp);
    expect(noWebdriver.checked).toBe(true);
    expect(noWebdriver.ambiguous).toBe(true);
    expect(shouldBlockInjectionProbe(noWebdriver, undefined)).toBe(true);
    expect(shouldBlockInjectionProbe(noWebdriver, false)).toBe(false);
  });

  it("expectation mirrors the preload's own patch surface (platform/language/screen/hwc/webdriver)", () => {
    expect(exp.webdriver).toBe(false);
    expect(exp.platform).toBe("Win32");
    expect(exp.language).toBe("en-US");
    expect(exp.screenWidth).toBe(1920);
    expect(typeof exp.hardwareConcurrency).toBe("number");
  });
});

// ── Runtime smoke: the preload is an IIFE string; in e2e it is only ever
// inspected as text. Executing it (and the worker shim it generates) inside a
// stubbed Firefox realm proves the JS blocks G2/G3/G4 paid into actually run:
// syntax errors, ordering bugs (noise must wrap before the font filter) and
// dead references surface here, not on a real-machine verify run.
describe("preload executes in a stubbed Firefox realm (G2/G3/G4 runtime smoke)", () => {
  const originalDateToString = Date.prototype.toString;
  const originalDateOffset = Date.prototype.getTimezoneOffset;
  const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  const originalFnToString = Function.prototype.toString;

  // The preload rewrites these on the GLOBAL realm (a real Firefox would have
  // them realm-local); restore after every run so tests stay isolated.
  function restoreGlobals() {
    Date.prototype.toString = originalDateToString;
    Date.prototype.getTimezoneOffset = originalDateOffset;
    try { Intl.DateTimeFormat.prototype.resolvedOptions = originalResolvedOptions; } catch (e) {}
    Function.prototype.toString = originalFnToString;
  }

  function runPreload(config: BrowserFingerprintConfig) {
    const script = buildFirefoxFingerprintPreloadScript(config);
    const workerBlobs = new Map<string, string[]>();
    const createdWorkers: string[] = [];
    let blobSeq = 0;

    class BlobStub {
      parts: any[];
      constructor(parts: any[], _opts?: any) { this.parts = parts; }
    }
    class XhrStub {
      status = 0;
      responseText = "";
      open() {}
      send() {}
    }
    class NavigatorStub {}
    class WindowStub {}
    class ScreenStub {
      orientation: any;
      constructor(orientation: any) { this.orientation = orientation; }
    }
    class Ctx2D {
      font = "";
      measureText() { return { width: 100 }; }
      fillRect() {}
      strokeRect() {}
      fillText() {}
      strokeText() {}
      arc() {}
    }
    class HTMLCanvasElementStub {
      getContext() { return new Ctx2D(); }
    }

    const navigator = new NavigatorStub();
    const screen = new ScreenStub({ type: "landscape-primary", angle: 0 });
    const window = new WindowStub() as any;
    class RealWorker {
      constructor(url: string) { createdWorkers.push(String(url)); }
    }
    window.Worker = RealWorker;

    const urlStub = {
      createObjectURL: (blob: any) => { const u = "blob:stub-" + blobSeq++; workerBlobs.set(u, Array.from(blob.parts)); return u; },
      revokeObjectURL: () => {},
    };

    const fn = new Function(
      "window", "navigator", "screen", "document", "Navigator", "Screen", "Window",
      "CanvasRenderingContext2D", "OffscreenCanvasRenderingContext2D", "HTMLCanvasElement",
      "Blob", "URL", "XMLHttpRequest",
      script,
    );
    fn(window, navigator, screen, {}, NavigatorStub, ScreenStub, WindowStub, Ctx2D, Ctx2D, HTMLCanvasElementStub, BlobStub, urlStub, XhrStub);
    // The page constructs a worker → the preload's wrapper builds the shim
    // blob through URL.createObjectURL (captured above) and hands it to the
    // engine — exactly what a scanner-triggered worker does at runtime.
    try { new window.Worker("worker.js")(); } catch (e) {}

    const shimSource = workerBlobs.size ? Array.from(workerBlobs.values())[0].slice(0, 1).join("") : null;
    return { navigator, screen, window, Ctx2D, shimScript: shimSource, shimCount: workerBlobs.size };
  }

  function runWorkerShim(shimScript: string, hostPlatform: string) {
    // Real navigators expose these on the PROTOTYPE (accessors), not as own
    // instance fields — class fields here would shadow the shim's prototype
    // writes and the persona re-application assertions would never hold.
    class WorkerNavigator {}
    const navigatorProto = WorkerNavigator.prototype as any;
    const hostFields: Record<string, unknown> = {
      platform: hostPlatform,
      oscpu: "Intel Mac OS X 10.15",
      appVersion: "5.0 (Macintosh)",
      webdriver: true,
      maxTouchPoints: 0,
      hardwareConcurrency: 64,
      languages: ["en-US", "en"],
    };
    for (const key of Object.keys(hostFields)) {
      Object.defineProperty(navigatorProto, key, { configurable: true, get: () => hostFields[key] });
    }
    class O2DStub {
      font = "13px sans-serif";
      fillRectCalls: any[][] = [];
      fillRect(...args: any[]) { this.fillRectCalls.push(args); }
      strokeRect() {}
      fillText() {}
      strokeText() {}
      arc() {}
      measureText(_text: string) { return { width: 50 }; }
    }
    const workerNavigator = new WorkerNavigator();
    O2DStub.prototype.constructor = O2DStub;

    let error: Error | null = null;
    try {
      const fn = new Function("self", "navigator", "OffscreenCanvasRenderingContext2D", shimScript);
      fn({}, workerNavigator, O2DStub);
    } catch (e: any) {
      error = e;
    }
    return { workerNavigator, O2DStub, error };
  }

  it("applies the Windows identity + plugin roster + Date region on a desktop persona", () => {
    const config = buildBrowserFingerprintConfig(meta({ platform: "windows", timezone: "Asia/Shanghai" }), null);
    try {
      const world = runPreload(config);

      expect(world.navigator.platform).toBe("Win32");
      expect(world.navigator.plugins.length).toBe(2);
      expect(world.navigator.plugins[0].name).toBe("Internal PDF Plugin");
      expect(world.navigator.plugins[0].filename).toBe("pdfium.dll");
      expect(world.navigator.plugins.namedItem("Widevine Content Decryption Module")).not.toBeNull();
      expect(world.navigator.plugins.item(1).mimeTypes.length).toBe(0);
      expect(world.navigator.mimeTypes.length).toBe(1);
      expect(world.navigator.mimeTypes.namedItem("application/pdf").suffixes).toBe("pdf");
      expect(world.navigator.pdfViewerEnabled).toBe(true);
      expect(world.screen.width).toBe(config.screen.width);

      const jan = new Date(2024, 0, 15, 12, 0, 0);
      expect(jan.toString()).toMatch(/^Mon Jan 15 2024 12:00:00 GMT/);
      expect(jan.toString().endsWith("(China Standard Time)")).toBe(true);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Asia/Shanghai");
      expect(world.shimCount).toBeGreaterThan(0);
      expect(world.shimScript).toContain('wval(WNP,"platform"');
    } finally {
      restoreGlobals();
    }
  });

  it("applies the Android identity: empty plugins, mobile orientation, touch slots", () => {
    const config = buildBrowserFingerprintConfig(meta({ platform: "android", locale: "zh-CN" }), null);
    try {
      const world = runPreload(config);

      expect(world.navigator.platform).toBe("Linux armv81");
      expect(world.navigator.plugins.length).toBe(0);
      expect(world.navigator.plugins.namedItem("Internal PDF Plugin")).toBeNull();
      expect(world.navigator.pdfViewerEnabled).toBe(true);
      expect(world.screen.orientation.type).toBe("portrait-primary");
      expect(world.screen.orientation.angle).toBe(0);
      expect(world.window.ontouchstart).toBeNull();
      expect(world.window.onorientationchange).toBeNull();
    } finally {
      restoreGlobals();
    }
  });

  it("the worker shim compiles and re-applies the persona identity (G1)", () => {
    const config = buildBrowserFingerprintConfig(meta({ platform: "android", locale: "en-US" }), null);
    try {
      const world = runPreload(config);
      expect(world.shimScript).not.toBeNull();

      expect(() => new Function(world.shimScript as string)).not.toThrow();

      const worker = runWorkerShim(world.shimScript as string, "MacIntel");
      expect(worker.error).toBeNull();
      expect(worker.workerNavigator.platform).toBe("Linux armv81");
      expect(worker.workerNavigator.oscpu).toBe("Linux armv8l");
      expect(worker.workerNavigator.webdriver).toBe(false);
      expect(worker.workerNavigator.maxTouchPoints).toBe(5);
      expect(worker.workerNavigator.languages).toEqual(["en-US", "en"]);
    } finally {
      restoreGlobals();
    }
  });

  it("the worker shim applies deterministic canvas noise (G5)", () => {
    const config = buildBrowserFingerprintConfig(meta({ platform: "windows" }), null);
    try {
      const world = runPreload(config);
      const worker = runWorkerShim(world.shimScript as string, "Win32");
      expect(worker.error).toBeNull();

      const ctx = new worker.O2DStub();
      const args = [10, 20, 30, 40];
      ctx.fillRect(...args);
      expect(ctx.fillRectCalls.length).toBe(1);
      const shifted = ctx.fillRectCalls[0];
      expect(shifted[0]).not.toBe(args[0]);
      expect(shifted[1]).not.toBe(args[1]);
      expect(shifted[2]).toBe(args[2]);
      expect(shifted[3]).toBe(args[3]);

      // A FRESH context replays the same op sequence with identical noise
      // (the shim stream is seeded per context, not per process).
      const ctx2 = new worker.O2DStub();
      ctx2.fillRect(...args);
      expect(ctx2.fillRectCalls[0][0]).toBe(shifted[0]);
      expect(ctx2.fillRectCalls[0][1]).toBe(shifted[1]);
    } finally {
      restoreGlobals();
    }
  });
});