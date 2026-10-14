import { describe, expect, it } from "vitest";
import { normalizeManagedSecureDnsUrl, resolveChromiumDnsPolicy } from "../../src/main/services/browser-dns-policy.js";
import type { ProxyConfig } from "../../src/main/types.js";

const proxy: ProxyConfig = { type: "http", host: "proxy.example", port: 8080 };

describe("Chromium proxy DNS policy", () => {
  it("keeps direct profiles on stock DNS without forcing a provider", () => {
    expect(resolveChromiumDnsPolicy(null, undefined)).toEqual({ route: "stock", secureDns: null });
    expect(resolveChromiumDnsPolicy(null, "https://dns.example/dns-query")).toEqual({ route: "stock", secureDns: null });
  });

  it.each(["http", "socks5", "socks5h"] as const)("uses %s proxy-side resolution by default", (type) => {
    expect(resolveChromiumDnsPolicy({ ...proxy, type }, undefined)).toEqual({ route: "proxy", secureDns: null });
    expect(resolveChromiumDnsPolicy({ ...proxy, type }, "  ")).toEqual({ route: "proxy", secureDns: null });
  });

  it.each([
    "https://dns.example/dns-query",
    "https://dns.example/dns-query{?dns}",
    "https://dns.example/dns-query?version=1{&dns}",
    "https://[2001:db8::1]:8443/dns-query",
  ])("honors an explicit valid provider: %s", (template) => {
    expect(normalizeManagedSecureDnsUrl(` ${template} `)).toBe(template);
    expect(resolveChromiumDnsPolicy(proxy, template)).toEqual({
      route: "doh", secureDns: { enabled: true, templates: [template] },
    });
  });

  it.each([
    "http://dns.example/dns-query", "file:///dns-query", "https://user:password@dns.example/dns-query",
    "https://dns.example/dns-query#fragment", "https://dns.example/a b", "https://dns.example/{unknown}",
    "https://dns.example/dns-query?version=1{?dns}", "https://dns.example/dns-query{&dns}",
    "not a URL", "https://", "https://dns.example/" + "x".repeat(1000),
  ])("rejects invalid providers without exposing their contents: %s", (template) => {
    expect(normalizeManagedSecureDnsUrl(template)).toBeNull();
    expect(() => resolveChromiumDnsPolicy(proxy, template)).toThrow(/Invalid managed secure DNS URL/);
    try {
      resolveChromiumDnsPolicy(proxy, template);
    } catch (error) {
      expect(String(error)).not.toContain(template);
    }
  });
});
