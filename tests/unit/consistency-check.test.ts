import { describe, it, expect } from "vitest";
import { checkProfileConsistency, tzToCountry, localeToRegion } from "../../src/main/services/consistency-check.js";

describe("consistency-check helpers", () => {
  it("maps common IANA timezones to countries", () => {
    expect(tzToCountry("America/New_York")).toBe("US");
    expect(tzToCountry("asia/shanghai")).toBe("CN");
    expect(tzToCountry("Europe/London")).toBe("GB");
    expect(tzToCountry("Europe/Athens")).toBe("GR");
    expect(tzToCountry("Asia/Nicosia")).toBe("CY");
    expect(tzToCountry("Asia/Tokyo")).toBe("JP");
    expect(tzToCountry("Mars/Olympus")).toBeNull();
    expect(tzToCountry(null)).toBeNull();
  });

  it("extracts the region from a BCP-47 locale", () => {
    expect(localeToRegion("en-US")).toBe("US");
    expect(localeToRegion("zh-CN")).toBe("CN");
    expect(localeToRegion("en_GB")).toBe("GB");
    expect(localeToRegion("en")).toBeNull();
    expect(localeToRegion(undefined)).toBeNull();
  });
});

describe("checkProfileConsistency", () => {
  it("passes a clean, consistent profile", () => {
    const r = checkProfileConsistency({ timezone: "America/New_York", locale: "en-US", proxyMode: "named", proxyGeo: { country: "US" } });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(0);
    expect(r.blockers).toHaveLength(0);
  });

  it("accepts the Greek Greece and Cyprus locale/timezone pairs", () => {
    const greece = checkProfileConsistency({ timezone: "Europe/Athens", locale: "el-GR", proxyMode: "named", proxyGeo: { countryCode: "GR" } });
    const cyprus = checkProfileConsistency({ timezone: "Asia/Nicosia", locale: "el-CY", proxyMode: "named", proxyGeo: { countryCode: "CY" } });
    expect(greece.warnings).toHaveLength(0);
    expect(cyprus.warnings).toHaveLength(0);
  });

  it("blocks when a WebRTC IP is set but there is no proxy", () => {
    const r = checkProfileConsistency({ webrtcIp: "203.0.113.5", proxyMode: "none" });
    expect(r.ok).toBe(false);
    expect(r.blockers[0].code).toBe("webrtc-no-proxy");
  });

  it("does not block WebRTC when a proxy is configured", () => {
    const r = checkProfileConsistency({ webrtcIp: "203.0.113.5", proxyMode: "named" });
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it("warns on timezone vs locale region mismatch", () => {
    const r = checkProfileConsistency({ timezone: "America/New_York", locale: "en-GB", proxyMode: "none" });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "tz-locale")).toBe(true);
  });

  it("warns on proxy country vs timezone mismatch", () => {
    const r = checkProfileConsistency({ timezone: "Asia/Shanghai", locale: "zh-CN", proxyMode: "named", proxyGeo: { country: "US" } });
    expect(r.warnings.some((w) => w.code === "proxy-tz")).toBe(true);
    expect(r.warnings.some((w) => w.code === "proxy-locale")).toBe(true);
  });

  it("uses proxy countryCode when cached geo includes both name and code", () => {
    const r = checkProfileConsistency({ timezone: "Asia/Shanghai", locale: "zh-CN", proxyMode: "named", proxyGeo: { country: "United States", countryCode: "US" } });
    expect(r.warnings.some((w) => w.code === "proxy-tz")).toBe(true);
    expect(r.warnings.some((w) => w.code === "proxy-locale")).toBe(true);
  });

  it("warns on proxy-detected timezone vs declared timezone", () => {
    const r = checkProfileConsistency({ timezone: "Asia/Tokyo", proxyMode: "named", proxyGeo: { timezone: "Asia/Shanghai" } });
    expect(r.warnings.some((w) => w.code === "proxy-tz-mismatch")).toBe(true);
  });

  it("does not flag when country info is unknown", () => {
    const r = checkProfileConsistency({ timezone: "Mars/Olympus", locale: "xx", proxyMode: "named", proxyGeo: { country: null } });
    expect(r.warnings).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("treats empty/undefined inputs as a no-warning pass", () => {
    const r = checkProfileConsistency({ proxyMode: "none" });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });
});
