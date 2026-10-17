// Proxy geo-IP detection cache + short-circuit (Slice 57 — launch speed).
// Successful detections are cached per proxy identity (10 min TTL) so repeat
// launches skip the network round-trip; failures are never cached.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  rememberProxyDetectionForTests,
  cachedProxyDetectionForTests,
  resetProxyDetectionCacheForTests,
  proxyDetectionObservedAt,
} from "../../src/main/services/proxy-detector.js";

const PROXY = { type: "socks5", host: "127.0.0.1", port: 7890 } as any;

function successResult(): any {
  return {
    success: true, exitIp: "1.2.3.4", country: "United States", countryCode: "US",
    region: null, regionName: null, city: null, timezone: "America/New_York",
    lat: null, lon: null, isp: null, org: null, as: null, provider: "ipwho.is",
    latencyMs: 120, error: null,
  };
}

afterEach(() => {
  resetProxyDetectionCacheForTests();
  vi.useRealTimers();
});

describe("proxy geo-IP detection cache (Slice 57)", () => {
  it("returns a cached successful detection for the same proxy identity", () => {
    const result = successResult();
    rememberProxyDetectionForTests(PROXY, result);
    const cached = cachedProxyDetectionForTests(PROXY);
    expect(cached).not.toBeNull();
    expect(cached!.exitIp).toBe("1.2.3.4");
  });

  it("keys the cache by proxy identity (type/host/port/username)", () => {
    rememberProxyDetectionForTests(PROXY, successResult());
    expect(cachedProxyDetectionForTests({ ...PROXY, host: "proxy.example.test" })).toBeNull();
    expect(cachedProxyDetectionForTests({ type: "socks5", host: "127.0.0.1", port: 7891 } as any)).toBeNull();
    expect(cachedProxyDetectionForTests({ type: "http", host: "127.0.0.1", port: 7890 } as any)).toBeNull();
    expect(cachedProxyDetectionForTests({ type: "socks5", host: "127.0.0.1", port: 7890, username: "u" } as any)).toBeNull();
  });

  it("never caches failed or empty-exit detections", () => {
    const failed = { success: false, exitIp: null, error: "timeout", provider: null, timezone: null, locale: null } as any;
    rememberProxyDetectionForTests(PROXY, failed);
    expect(cachedProxyDetectionForTests(PROXY)).toBeNull();
    const empty = { ...successResult(), exitIp: null };
    rememberProxyDetectionForTests(PROXY, empty);
    expect(cachedProxyDetectionForTests(PROXY)).toBeNull();
  });

  it("isolates geo detections when only proxy authentication changes", () => {
    const west = { ...PROXY, username: "route", password: "west" };
    const east = { ...west, password: "east" };
    rememberProxyDetectionForTests(west, { ...successResult(), timezone: "America/Los_Angeles" });
    expect(cachedProxyDetectionForTests(east)).toBeNull();
    rememberProxyDetectionForTests(east, successResult());
    expect(cachedProxyDetectionForTests(west)!.timezone).toBe("America/Los_Angeles");
    expect(cachedProxyDetectionForTests(east)!.timezone).toBe("America/New_York");
  });

  it("expires entries after ten minutes without clearing the cache", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-17T00:00:00Z");
    vi.setSystemTime(start);
    rememberProxyDetectionForTests(PROXY, successResult());
    vi.setSystemTime(start + 10 * 60 * 1000 - 1);
    expect(cachedProxyDetectionForTests(PROXY)).not.toBeNull();
    vi.setSystemTime(start + 10 * 60 * 1000 + 1);
    expect(cachedProxyDetectionForTests(PROXY)).toBeNull();
  });

  it("does not refresh the observation age when a cached result is read", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-17T00:00:00Z");
    vi.setSystemTime(start);
    rememberProxyDetectionForTests(PROXY, successResult());
    vi.setSystemTime(start + 9 * 60 * 1000);
    expect(cachedProxyDetectionForTests(PROXY)).not.toBeNull();
    vi.setSystemTime(start + 10 * 60 * 1000 + 1);
    expect(cachedProxyDetectionForTests(PROXY)).toBeNull();
  });

  it("exposes the original observation time rather than a cached read time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-17T00:00:00Z");
    vi.setSystemTime(start);
    const original = successResult();
    rememberProxyDetectionForTests(PROXY, original);
    vi.setSystemTime(start + 9 * 60 * 1000);
    const cached = cachedProxyDetectionForTests(PROXY)!;
    expect(cached).toBe(original);
    expect(proxyDetectionObservedAt(cached)).toBe(start);
    rememberProxyDetectionForTests(PROXY, successResult());
    expect(proxyDetectionObservedAt(cachedProxyDetectionForTests(PROXY)!)).toBe(start + 9 * 60 * 1000);
    expect(proxyDetectionObservedAt(original)).toBe(start);
  });

  it("does not invent an observation time for unobserved or failed results", () => {
    const synthetic = successResult();
    const failed = { ...successResult(), success: false, exitIp: null };
    rememberProxyDetectionForTests(PROXY, failed);
    expect(proxyDetectionObservedAt(synthetic)).toBeNull();
    expect(proxyDetectionObservedAt(failed)).toBeNull();
  });
});
