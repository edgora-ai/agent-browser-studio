import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Offline source-policy guard only. This does not compile Chromium, launch a
// browser, or establish banner / external-site / DNS-wire acceptance.
const PATCH_ROOT = path.resolve(__dirname, "../../patches/chromium");
const PATCH_NAME = "patches/0051-agent-browser-local-dns-policy.patch";
const patch = fs.readFileSync(path.join(PATCH_ROOT, PATCH_NAME), "utf8");
const sections = new Map(
  patch.split(/(?=^diff --git )/m).filter(Boolean).map((section) => {
    const match = /^diff --git a\/(\S+) b\/\1$/m.exec(section);
    if (!match) throw new Error("Invalid 0051 patch section");
    return [match[1], section] as const;
  }),
);
function section(relative: string): string {
  const value = sections.get(relative);
  if (!value) throw new Error(`Missing patch target: ${relative}`);
  return value;
}
function added(relative: string): string {
  return section(relative).split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1)).join("\n");
}
const helper = added("services/network/public/cpp/agent_browser_local_dns_policy.cc");
const header = added("services/network/public/cpp/agent_browser_local_dns_policy.h");
const consumer = section("services/network/network_context.cc").split("\n")
  .filter((line) => /^[ +]/.test(line) && !line.startsWith("+++"))
  .map((line) => line.slice(1)).join("\n");
const nativeTests = added("services/network/public/cpp/agent_browser_local_dns_policy_unittest.cc");
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("Chromium 0051 restricted local-DNS native source policy", () => {
  it("has a dedicated capability and a single opt-in mode, independent of fingerprint payloads", () => {
    expect(header).toContain('"agent-browser-local-dns-policy"');
    expect(header).toContain('"agent-browser-proxy-bootstrap-host"');
    expect(header).toContain('"proxy-local-dns-deny"');
    expect(added("chrome/browser/net/roxy_proxy_auth.h"))
      .toContain('"agent-browser-local-dns-policy-v1"');
    expect(added("chrome/app/chrome_main_delegate.cc"))
      .toContain("roxy::kAgentBrowserLocalDnsPolicyCapability");
    expect(header + helper).not.toMatch(/RoxyFingerprintConfig|blink\/|fingerprint-config/);
    const mojom = added("services/network/public/mojom/network_context.mojom");
    expect(mojom).toMatch(/enum AgentBrowserLocalDnsMode\s*\{\s*kProxyLocalDnsDeny,\s*\}/);
    expect(mojom).toContain("AgentBrowserLocalDnsPolicy? agent_browser_local_dns_policy;");
    expect(mojom).toContain("string? proxy_bootstrap_host;");
    expect(mojom).not.toMatch(/string\?? (?:host_mapping_rules|fingerprint_config|replacement_host)/);
  });

  it("validates before strict-DoH isolation and fails explicitly rather than falling back on malformed input", () => {
    expect(helper).toContain("CHECK(!command_line.HasSwitch(kAgentBrowserProxyBootstrapHostSwitch))");
    expect(helper).toMatch(/CHECK\(command_line\.GetSwitchValueASCII\(kAgentBrowserLocalDnsPolicySwitch\) ==\s*kAgentBrowserProxyLocalDnsDeny\)/);
    expect(helper).toContain("CHECK(policy->proxy_bootstrap_host.has_value())");
    expect(helper.indexOf("CHECK(policy->proxy_bootstrap_host.has_value())"))
      .toBeLessThan(helper.indexOf("if (managed_secure_dns)"));
    expect(helper).toMatch(/if \(managed_secure_dns\)\s*\{\s*return nullptr;\s*\}/);
    expect(helper).toContain("CHECK(policy->mode == mojom::AgentBrowserLocalDnsMode::kProxyLocalDnsDeny)");
    expect(helper).toContain("CanonicalBootstrapHost(*policy->proxy_bootstrap_host)");
    expect(helper).toContain("CHECK(host.has_value())");
    expect(helper).not.toMatch(/catch\s*\(|FromStringLax|LOG_IF|return true;|\/\/\s*TODO/);
    const stub = added("chrome/browser/net/stub_resolver_config_reader.cc");
    expect(stub).toMatch(/return config\.enabled\(\) && config\.secure_dns_enabled\(\) &&\s*!config\.secure_dns_templates\(\)\.empty\(\)/);
    expect(stub).toContain("const bool managed_secure_dns = IsManagedSecureDnsEnabled();");
  });

  it("constructs only the real 152 deny sentinel and exact loopback/bootstrap exclusions, never redirects", () => {
    expect(helper).toContain('"MAP * ^NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"');
    expect(helper).not.toContain('"MAP * ~NOTFOUND');
    expect(helper).not.toMatch(/EXCLUDE (?:\*|127\.\*|\[?::1\]?\")|MAP \* (?:127\.|192\.)/);
    expect(helper).toContain('rules.append(", EXCLUDE ").append(*host)');
    for (const guard of [
      "host.empty()", "host.size() > 253", "!base::IsStringASCII(host)",
      "dns_name.empty()", "label.empty()", "label.size() > 63",
      "!base::IsAsciiAlphaNumeric(label.front())", "!base::IsAsciiAlphaNumeric(label.back())",
      "!base::IsAsciiAlphaNumeric(c) && c != '-'", "address.AssignFromIPLiteral(ip_literal)",
      "address.IsIPv4() && host != canonical", "url::CanonHostInfo::NEUTRAL",
    ]) expect(helper).toContain(guard);
    expect(helper).not.toMatch(/GetSwitchValueASCII\([^)]*(?:HostResolverRules|HostRules)/);
  });

  it("wires common defaults, the URLRequestContext builder, and standalone override resolvers", () => {
    const defaults = added("chrome/browser/net/system_network_context_manager.cc");
    expect(defaults).toMatch(/network_context_params->agent_browser_local_dns_policy =\s*network::ParseAgentBrowserLocalDnsPolicy\(\s*command_line, StubResolverConfigReader::IsManagedSecureDnsEnabled\(\)\)/);
    expect(consumer).toMatch(/CreateStandaloneResolver\([\s\S]*?BuildAgentBrowserHostMappingRules\(\s*params_->agent_browser_local_dns_policy\.get\(\)\)/);
    expect(consumer).toMatch(/if \(params_->agent_browser_local_dns_policy\)\s*\{[\s\S]*?builder\.set_host_mapping_rules\(BuildAgentBrowserHostMappingRules\([\s\S]*?\} else if \(command_line->HasSwitch\(switches::kHostResolverRules\)\)/);
    const browserTest = added("chrome/browser/net/system_network_context_manager_browsertest.cc");
    expect(browserTest).toContain("manager->CreateDefaultNetworkContextParams()");
    expect(browserTest).toContain("manager->ConfigureDefaultNetworkContextParams(profile_params.get())");
    expect(browserTest).toContain("profile_params->agent_browser_local_dns_policy.Clone()");
    expect(added("services/network/public/cpp/BUILD.gn"))
      .toContain('"agent_browser_local_dns_policy_unittest.cc"');
  });

  it("ships native malformed, exact-exception, no-backend, service-endpoint and override negative cases", () => {
    for (const test of [
      "StockOffModeAndStrictDohAreSeparate", "CanonicalBootstrapHostOnly",
      "MalformedCommandLineDiesEvenWithStrictDoh", "MalformedTypedPolicyDies",
      "ResolverDeniesBeforeFallbackWithExactExceptions",
    ]) expect(nativeTests).toContain(test);
    expect(nativeTests).toContain("for (bool managed_secure_dns : {false, true})");
    expect(nativeTests).toContain("EXPECT_CHECK_DEATH");
    expect(nativeTests).toContain('"proxy.example, EXCLUDE *"');
    expect(nativeTests).toContain('"sub.localhost", "localhost.evil", "127.0.0.2", "::1"');
    expect(nativeTests).toContain("parameters.source = net::HostResolverSource::SYSTEM");
    expect(nativeTests).toContain("parameters.secure_dns_policy = net::SecureDnsPolicy::kDisable");
    expect(nativeTests).toContain("CreateServiceEndpointRequest(");
    expect(nativeTests).toContain("EXPECT_EQ(0u, state->num_resolve())");
    expect(nativeTests).toContain('EXPECT_EQ("192.0.2.42:443"');
    const integration = added("services/network/network_context_unittest.cc");
    expect(integration).toContain("AgentBrowserLocalDnsPolicyReachesContextResolver");
    expect(integration).toContain("AgentBrowserLocalDnsPolicySurvivesConfigOverrides");
    expect(integration).toContain("ElementsAre(rules, rules)");
    expect(integration).toContain("net::HostResolverSource::LOCAL_ONLY");
    expect(integration).toContain('switches::kHostResolverRules, "MAP * 127.0.0.1"');
  });

  it("keeps released patches immutable and lists every new native target in the final-source manifest", () => {
    const manifest = fs.readFileSync(path.join(PATCH_ROOT, "PATCHSET.sha256"), "utf8").trim().split("\n");
    const entries = new Map(manifest.map((line) => {
      const [digest, relative] = line.split("  ");
      return [relative, digest] as const;
    }));
    expect(entries.size).toBe(manifest.length);
    expect(entries.get(PATCH_NAME)).toBe(sha256(patch));
    for (const [relative, digest] of entries) {
      expect(sha256(fs.readFileSync(path.join(PATCH_ROOT, relative))), relative).toBe(digest);
    }
    expect(entries.get("patches/0044-agent-browser-managed-dns-locale-refresh.patch"))
      .toBe("444111027b22e9836f463a3c591de07b6df496cbca194956d940ef31000bdb95");
    expect(entries.get("patches/0050-parse-managed-secure-dns-config.patch"))
      .toBe("59f4811d70ca5b7ae346b03af9f57c6576a746b91723c52e59bd916b7d0e6cef");
    const finalSources = fs.readFileSync(path.join(PATCH_ROOT, "PATCHED_SOURCE.sha256"), "utf8");
    for (const relative of sections.keys()) expect(finalSources).toContain(`  ${relative}\n`);
    expect([...sections.keys()]).toHaveLength(13);
    expect([...sections.keys()].join("\n"))
      .not.toMatch(/bad_flags|infobar|keychain|tls|renderer|preconnect|fingerprint_config/);
  });
});
