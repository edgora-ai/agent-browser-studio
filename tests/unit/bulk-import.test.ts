import { describe, it, expect } from "vitest";
import { parseBulkCsv } from "../../src/main/services/bulk-import.js";

describe("parseBulkCsv", () => {
  it("parses a header-based CSV with all columns", () => {
    const specs = parseBulkCsv("name,platform,locale,timezone,seed,proxy,webrtc,tags\nUS-Shop1,windows,en-US,America/New_York,11111,us-proxy,1.2.3.4,shop|priority\nDE-Shop2,macos,de-DE,Europe/Berlin,22222,eu-proxy,,eu");
    expect(specs.length).toBe(2);
    expect(specs[0]).toMatchObject({ name: "US-Shop1", platform: "windows", locale: "en-US", timezone: "America/New_York", fingerprintSeed: 11111, proxyName: "us-proxy", webrtcIp: "1.2.3.4", tags: ["shop", "priority"] });
    expect(specs[1].platform).toBe("macos");
    expect(specs[1].webrtcIp).toBeUndefined();
  });

  it("maps header aliases (tz, proxy_name, fingerprint_seed)", () => {
    const specs = parseBulkCsv("name,tz,proxy_name,fingerprint_seed\nP1,Asia/Tokyo,jp,99999");
    expect(specs[0]).toMatchObject({ name: "P1", timezone: "Asia/Tokyo", proxyName: "jp", fingerprintSeed: 99999 });
  });

  it("parses custom geolocation columns", () => {
    const specs = parseBulkCsv("name,geolocation,lat,lng,accuracy\nShanghai,custom,31.2304,121.4737,25");
    expect(specs[0]).toMatchObject({
      geolocationMode: "custom",
      geolocationLatitude: 31.2304,
      geolocationLongitude: 121.4737,
      geolocationAccuracy: 25,
    });
  });

  it("falls back to legacy positional format when no header", () => {
    const specs = parseBulkCsv("P1,windows,en-US,America/Chicago,12345,5.6.7.8");
    expect(specs[0]).toMatchObject({ name: "P1", platform: "windows", locale: "en-US", timezone: "America/Chicago", fingerprintSeed: 12345, webrtcIp: "5.6.7.8" });
  });

  it("ignores invalid seed values", () => {
    const specs = parseBulkCsv("name,seed\nP1,abc");
    expect(specs[0].fingerprintSeed).toBeUndefined();
  });

  it("skips rows without a name", () => {
    const specs = parseBulkCsv("name,locale\nP1,en\n,en-US");
    expect(specs.length).toBe(1);
    expect(specs[0].name).toBe("P1");
  });

  it("returns [] for empty input", () => {
    expect(parseBulkCsv("")).toEqual([]);
    expect(parseBulkCsv("   \n  ")).toEqual([]);
  });

  it("splits tags on ; or |", () => {
    const specs = parseBulkCsv("name,tags\nP1,a;b|c");
    expect(specs[0].tags).toEqual(["a", "b", "c"]);
  });
});
