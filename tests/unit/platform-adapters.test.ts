import { describe, it, expect } from "vitest";
import {
  PLATFORM_ADAPTERS, detectAdapter, getAdapter, getPlatformAdapter, listPlatformAdapters, renderAdapterCatalog,
} from "../../src/main/services/platform-adapters.js";
import { listBusinessPresets } from "../../src/main/services/business-presets.js";

const ALLOWED_CATEGORIES = new Set(["ecommerce", "social", "ads", "crypto", "productivity", "utility", "generic"]);

describe("platform adapters", () => {
  it("ships a rich Skills Hub catalog with the core platforms + a generic fallback", () => {
    const ids = PLATFORM_ADAPTERS.map((a) => a.id);
    expect(ids).toContain("generic-web");
    expect(ids).toContain("amazon-seller");
    expect(ids).toContain("shopee-seller");
    expect(ids).toContain("facebook");
    expect(ids.length).toBeGreaterThanOrEqual(14);
  });

  it("adapter ids are unique and non-generic adapters have domains", () => {
    const ids = PLATFORM_ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of PLATFORM_ADAPTERS) {
      if (a.id === "generic-web") {
        expect(a.domains).toHaveLength(0);
      } else {
        expect(a.domains.length).toBeGreaterThan(0);
      }
    }
  });

  it("every adapter has a versioned loginCheck expression", () => {
    for (const a of PLATFORM_ADAPTERS) {
      expect(a.selectorVersion).toBeGreaterThanOrEqual(1);
      expect(a.capabilities.length).toBeGreaterThan(0);
      expect(Object.keys(a.selectors).length).toBeGreaterThan(0);
      expect(a.recipes.length).toBeGreaterThan(0);
      expect(a.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.notes).toBeTruthy();
      expect(a.loginCheck).toBeTruthy();
      expect(a.loginCheck.length).toBeGreaterThan(20);
      expect(a.loginCheck).not.toContain("[aria-label*=Your profile i]");
    }
  });

  it("every adapter carries valid hub catalog metadata", () => {
    for (const a of PLATFORM_ADAPTERS) {
      expect(ALLOWED_CATEGORIES.has(a.hub.category), `${a.id} category ${a.hub.category}`).toBe(true);
      expect(Array.isArray(a.hub.regions)).toBe(true);
      expect(Array.isArray(a.hub.presets)).toBe(true);
      expect(typeof a.hub.pitch).toBe("string");
      expect(a.hub.pitch.length).toBeGreaterThan(0);
      // every linked preset must actually exist in the business preset catalog
      for (const presetId of a.hub.presets) {
        expect(listBusinessPresets().some((p) => p.id === presetId), `${a.id} references ${presetId}`).toBe(true);
      }
    }
  });

  it("detectAdapter matches by domain substring", () => {
    expect(detectAdapter("https://sellercentral.amazon.com/home").id).toBe("amazon-seller");
    expect(detectAdapter("https://seller.shopee.ph/").id).toBe("shopee-seller");
    expect(detectAdapter("https://www.facebook.com/").id).toBe("facebook");
  });

  it("detectAdapter covers the new hub platforms", () => {
    expect(detectAdapter("https://www.instagram.com/").id).toBe("instagram");
    expect(detectAdapter("https://ads.google.com/aw/overview").id).toBe("google-ads");
    expect(detectAdapter("https://www.ebay.co.uk/").id).toBe("ebay");
    expect(detectAdapter("https://www.amazon.com/gp/buy").id).toBe("amazon-retail");
    expect(detectAdapter("https://www.lazada.sg/").id).toBe("lazada");
    expect(detectAdapter("https://x.com/home").id).toBe("x-twitter");
    expect(detectAdapter("https://www.linkedin.com/feed/").id).toBe("linkedin");
    expect(detectAdapter("https://www.youtube.com/").id).toBe("youtube");
    expect(detectAdapter("https://www.binance.com/").id).toBe("crypto-exchange");
    expect(detectAdapter("https://www.otto.de/").id).toBe("eu-marketplace");
    // amazon-seller stays more specific than amazon-retail
    expect(detectAdapter("https://sellercentral.amazon.com/").id).toBe("amazon-seller");
  });

  it("detectAdapter falls back to generic for unknown sites", () => {
    expect(detectAdapter("https://example.com/").id).toBe("generic-web");
    expect(detectAdapter("").id).toBe("generic-web");
  });

  it("getAdapter looks up by id", () => {
    expect(getAdapter("facebook")?.name).toBe("Facebook");
    expect(getAdapter("nope")).toBeUndefined();
  });

  it("listPlatformAdapters returns lean summaries sorted by category", () => {
    const list = listPlatformAdapters();
    expect(list.length).toBe(PLATFORM_ADAPTERS.length);
    const first = list[0];
    // summaries are lean: no loginCheck / no raw selectors on the list
    expect("loginCheck" in first).toBe(false);
    expect("selectors" in first).toBe(false);
    expect(first.id).toBeTruthy();
    expect(first.category).toBeTruthy();
    expect(first.pitch).toBeTruthy();
    const categories = list.map((a) => a.category);
    expect(categories).toEqual([...categories].sort((a, b) => indexOfCategory(a) - indexOfCategory(b)));
    // first group should be ecommerce
    expect(list[0].category).toBe("ecommerce");
  });

  it("listPlatformAdapters filters by id/category/region/preset/capability", () => {
    expect(listPlatformAdapters("instagram").map((a) => a.id)).toEqual(["instagram"]);
    expect(listPlatformAdapters("crypto").map((a) => a.id)).toEqual(["crypto-exchange"]);
    expect(listPlatformAdapters("SG").some((a) => a.id === "crypto-exchange")).toBe(true);
    expect(listPlatformAdapters("ecommerce").map((a) => a.category).every((c) => c === "ecommerce")).toBe(true);
    expect(listPlatformAdapters("amazon-seller-us").some((a) => a.id === "amazon-seller")).toBe(true);
    expect(listPlatformAdapters("login-check").length).toBe(listPlatformAdapters().length);
    expect(listPlatformAdapters("no-such-thing").length).toBe(0);
  });

  it("getPlatformAdapter returns the full recipe with loginCheck + selectors", () => {
    const full = getPlatformAdapter("crypto-exchange");
    expect(full).toBeTruthy();
    expect(full!.loginCheck.length).toBeGreaterThan(20);
    expect(Object.keys(full!.selectors).length).toBeGreaterThan(0);
    // one full adapter not in the lean summary
    const summary = listPlatformAdapters().find((a) => a.id === "crypto-exchange")!;
    expect("loginCheck" in summary).toBe(false);
    expect(getPlatformAdapter("nope")).toBeUndefined();
  });

  it("renderAdapterCatalog advertises each platform in the prompt", () => {
    const text = renderAdapterCatalog();
    expect(text).toContain("amazon-seller");
    expect(text).toContain("browser_evaluate");
    expect(text).toContain("selectorVersion");
    expect(text).toContain("capabilities");
    expect(text).toContain("loginCheck:");
    expect(text).toContain("loginUrlHints:");
    expect(text).toContain("recipes:");
    expect(text).toContain('[aria-label*="Your profile" i]');
    expect(text).toContain("category:");
    expect(text).toContain("agent_browser_platform_adapters_list");
  });
});

function indexOfCategory(category: string): number {
  const order = ["ecommerce", "social", "ads", "crypto", "productivity", "utility", "generic"];
  const index = order.indexOf(category);
  return index === -1 ? 999 : index;
}