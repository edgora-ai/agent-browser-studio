import { describe, expect, it } from "vitest";
import { buildBrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";
import { buildFirefoxManagedIdentity } from "../../src/main/services/firefox-fingerprint.js";
import { buildFirefoxUserJs, parseFirefoxPrefs } from "../../src/main/services/firefox-prefs.js";

const meta = { fingerprintSeed: 25516, platform: "macos" as const, locale: "en-US" };
const nativeWebGpu = { mode: "native", vendor: "", architecture: "", device: "", description: "", subgroupMinSize: 0, subgroupMaxSize: 0 };

describe("Firefox GPU identity uses Gecko, not page-only Chromium shims", () => {
  it.each(["Apple M1", "Apple M2", "Apple M3", "Apple M2 Pro"])("uses Gecko's Apple-family coarsening for %s", (model) => {
    const config = buildBrowserFingerprintConfig({ ...meta, gpuRenderer: `ANGLE (Apple, ANGLE Metal Renderer: ${model}, Unspecified Version)` }, "154.0", null, "firefox");
    expect(config.webgl).toEqual({ vendor: "Apple", renderer: "Apple M1, or similar" });
    expect(config.userAgent).toContain("Firefox/154.0");
  });

  it("carries the same WebGL identity through engine prefs for Window and Worker", () => {
    const bundle = buildFirefoxManagedIdentity(meta, "154.0");
    expect(bundle.prefs["webgl.override-unmasked-vendor"]).toBe(bundle.config.webgl.vendor);
    expect(bundle.prefs["webgl.override-unmasked-renderer"]).toBe(bundle.config.webgl.renderer);
    expect(bundle.prefs["webgl.sanitize-unmasked-renderer"]).toBeUndefined();
    expect(bundle.preloadScript).not.toContain("function patchWebglContext");
    expect(bundle.preloadScript).not.toContain("UNMASKED_VENDOR =");
  });

  it("keeps fallback WebGPU native rather than changing only the Window adapter", () => {
    const bundle = buildFirefoxManagedIdentity(meta, "154.0");
    expect(bundle.config.webgpu).toEqual(nativeWebGpu);
    expect(bundle.preloadScript).not.toContain('Object.defineProperty(Ctor.prototype, field');
    expect(bundle.nativeConfig.webgpu.mode).toBe("webgl");
    expect(bundle.nativeConfig.seed).toBe(bundle.config.seed);
  });

  it("passes the exact engine preference keys through the owned writer allowlist", () => {
    const bundle = buildFirefoxManagedIdentity(meta, "154.0");
    const values = new Map(parseFirefoxPrefs(buildFirefoxUserJs({ extraPrefs: bundle.prefs })).map(entry => [entry.key, entry.value]));
    expect(values.get("webgl.override-unmasked-vendor")).toBe("Apple");
    expect(values.get("webgl.override-unmasked-renderer")).toBe("Apple M1, or similar");
  });

  it("does not change the Chromium projection or the seed-owned non-GPU identity", () => {
    const context = { hostPlatform: "darwin" as const, hostArchitecture: "arm64", kernelArchitecture: "arm64" as const };
    const chromium = buildBrowserFingerprintConfig(meta, "152.0", null, "chromium", context);
    const firefox = buildFirefoxManagedIdentity(meta, "154.0").config;
    expect(chromium.webgl).toEqual({ vendor: "Google Inc. (Apple)", renderer: "Apple M1" });
    for (const field of ["seed", "hardwareProfile", "hardwareConcurrency", "deviceMemory", "screen", "canvas", "audio"] as const) {
      expect(firefox[field]).toEqual(chromium[field]);
    }
  });
});
