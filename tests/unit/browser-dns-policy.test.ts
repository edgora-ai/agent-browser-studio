import { describe, expect, it } from "vitest";
import { buildProxyDnsArgs, buildRemoteDnsRule, normalizeManagedSecureDnsUrl, resolveChromiumDnsPolicy } from "../../src/main/services/browser-dns-policy.js";
import type { ProxyConfig } from "../../src/main/types.js";

const proxy: ProxyConfig = { type: "http", host: "proxy.example", port: 8080 };

describe("Chromium proxy DNS policy", () => {
  it("uses Chromium's actual rejection sentinel rather than an unresolved replacement hostname", () => {
    expect(buildRemoteDnsRule("proxy.example", null)).toBe(
      "MAP * ^NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE proxy.example",
    );
    expect(buildRemoteDnsRule("127.0.0.1", null)).toBe(
      "MAP * ^NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    );
  });

  it("uses native local-DNS policy only for an explicitly capable engine", () => {
    expect(buildProxyDnsArgs("proxy.example", true)).toEqual([
      "--agent-browser-local-dns-policy=proxy-local-dns-deny",
      "--agent-browser-proxy-bootstrap-host=proxy.example",
    ]);
    expect(buildProxyDnsArgs("proxy.example", false)).toEqual([
      "--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE proxy.example",
    ]);
  });

  it.each([
    ["Proxy.Example.", "proxy.example."], ["127.0.0.1", "127.0.0.1"],
    ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"], ["[2001:db8::1]", "2001:db8::1"], ["::1", "::1"],
  ])("normalizes one native proxy bootstrap host without adding a mapping (%s)", (host, expected) => {
    const args = buildProxyDnsArgs(host, true);
    expect(args).toEqual([
      "--agent-browser-local-dns-policy=proxy-local-dns-deny",
      "--agent-browser-proxy-bootstrap-host=" + expected,
    ]);
    expect(args.join(" ")).not.toMatch(/--host-rules=|--host-resolver-rules=|--disable-infobars|--test-type/);
  });

  it.each([
    "", " proxy.example", "proxy.example ", "proxy.example:8080", "https://proxy.example", "a,b",
    "*", "*.example", "MAP * 127.0.0.1", "bad\nname", "bad\0name", "bücher.example", "a..b", ".",
    "-bad.example", "bad-.example", "[127.0.0.1]", "[::1]:8080", "2001:db8::z", "a".repeat(64) + ".example",
    "127.1", "127.000.0.1", "0x7f000001", "2130706433", "999.1.2.3",
  ])("rejects native bootstrap values that could widen DNS policy (%#)", (host) => {
    expect(() => buildProxyDnsArgs(host, true)).toThrow(/Invalid proxy bootstrap host/);
  });

  it("does not combine the restricted native policy with arbitrary legacy mappings", () => {
    expect(() => buildProxyDnsArgs("proxy.example", true, "MAP private.example 127.0.0.1"))
      .toThrow(/cannot be combined with arbitrary resolver rules/);
    expect(buildProxyDnsArgs("proxy.example", false, "MAP bridge 127.0.0.1")[0])
      .toContain(",MAP bridge 127.0.0.1");
  });

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
