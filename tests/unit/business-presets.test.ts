import { describe, it, expect } from "vitest";
import {
  listBusinessPresets,
  resolveBusinessPreset,
  presetProfileToCreateOpts,
} from "../../src/main/services/business-presets.js";

describe("business-presets catalog", () => {
  it("exposes a non-empty catalog with unique ids", () => {
    const presets = listBusinessPresets();
    expect(presets.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(presets.map((p) => p.id));
    expect(ids.size).toBe(presets.length);
  });

  it("every preset is an internally coherent identity", () => {
    for (const p of listBusinessPresets()) {
      // Valid IANA timezone
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: p.profile.timezone }).format(0)).not.toThrow();
      // Canonical locale (so the main-process sanitizer accepts it)
      expect(Intl.getCanonicalLocales(p.profile.locale)[0]).toBe(p.profile.locale);
      // Custom geolocation in range
      expect(p.profile.geolocationMode).toBe("custom");
      expect(p.profile.geolocationLatitude).toBeGreaterThanOrEqual(-90);
      expect(p.profile.geolocationLatitude).toBeLessThanOrEqual(90);
      expect(p.profile.geolocationLongitude).toBeGreaterThanOrEqual(-180);
      expect(p.profile.geolocationLongitude).toBeLessThanOrEqual(180);
      expect(p.profile.geolocationAccuracy).toBeGreaterThan(0);
      // Tags + platform + webrtc mode valid
      expect(p.profile.tags.length).toBeGreaterThan(0);
      expect(["windows", "macos"]).toContain(p.profile.platform);
      expect(["auto", "real", "altered", "disable"]).toContain(p.profile.webrtcMode);
      // Recommended gates are booleans
      for (const v of Object.values(p.recommendedGates)) expect(typeof v).toBe("boolean");
    }
  });

  it("resolves a known preset and returns a deep clone", () => {
    const p = resolveBusinessPreset("tiktok-shop-us");
    expect(p.profile.locale).toBe("en-US");
    expect(p.profile.timezone).toBe("America/Los_Angeles");
    p.profile.tags.push("mutated");
    expect(resolveBusinessPreset("tiktok-shop-us").profile.tags).not.toContain("mutated");
  });

  it("throws on an unknown preset id", () => {
    expect(() => resolveBusinessPreset("no-such-preset")).toThrow(/Unknown business preset/);
  });

  it("presetProfileToCreateOpts maps the identity fields for create", () => {
    const opts = presetProfileToCreateOpts(resolveBusinessPreset("ebay-uk"));
    expect(opts).toMatchObject({
      platform: "windows",
      timezone: "Europe/London",
      locale: "en-GB",
      webrtcMode: "auto",
      geolocationMode: "custom",
      geolocationLatitude: 51.5074,
      geolocationLongitude: -0.1278,
    });
    expect(opts.tags).toEqual(["ebay", "ecommerce", "uk"]);
  });

  it("covers the main account scenarios", () => {
    const ids = listBusinessPresets().map((p) => p.id);
    for (const id of [
      "tiktok-shop-us", "amazon-seller-us", "facebook-ads-us", "instagram-matrix-us",
      "ebay-uk", "ecommerce-de", "ai-automation-us", "crypto-sg",
    ]) {
      expect(ids).toContain(id);
    }
  });
});
