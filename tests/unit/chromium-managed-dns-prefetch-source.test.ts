import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Offline patch-contract checks, not C++ compilation or DNS/site acceptance.
const root = path.resolve(__dirname, "../../patches/chromium");
const name = "patches/0052-agent-browser-managed-proxy-dns-prefetch.patch";
const patch = fs.readFileSync(path.join(root, name), "utf8");
const sections = new Map(patch.split(/(?=^diff --git )/m)
  .filter((text) => text.startsWith("diff --git "))
  .map((text) => {
    const match = /^diff --git a\/(\S+) b\/\1$/m.exec(text);
    if (!match) throw new Error("Invalid managed DNS prefetch patch section");
    return [match[1], text] as const;
  }));
function source(relative: string): string {
  const section = sections.get(relative);
  if (!section) throw new Error("Missing managed DNS prefetch target: " + relative);
  return section.split("\n").filter((line) => /^[ +]/.test(line) && !line.startsWith("+++"))
    .map((line) => line.slice(1)).join("\n");
}
const delegate = source("content/public/browser/preconnect_manager.h");
const predictor = source("chrome/browser/predictors/loading_predictor.cc");
const consumer = source("content/browser/preloading/preconnect/preconnect_manager_impl.cc");
const nativeTests = source("content/browser/preloading/preconnect/preconnect_manager_impl_unittest.cc");

describe("Chromium 0052 managed proxy DNS-only source contract", () => {
  it("keeps the content-layer permission default-deny without depending on Chrome identity", () => {
    expect(delegate).toContain("virtual bool ShouldPreresolveThroughProxy() { return false; }");
    expect(delegate).not.toMatch(/RoxyFingerprintConfig|chrome\/browser\/|roxy_fingerprint_config/);
    expect(source("chrome/browser/predictors/loading_predictor.h"))
      .toContain("bool ShouldPreresolveThroughProxy() override;");
  });

  it("opts in only for enabled, nonempty, fully validated managed secure DNS", () => {
    expect(predictor).toMatch(/if \(!config\.enabled\(\) \|\| !config\.secure_dns_enabled\(\) \|\|\s*config\.secure_dns_templates\(\)\.empty\(\)\)\s*\{\s*return false;/);
    expect(predictor).toContain("net::DnsOverHttpsConfig::FromString(templates)");
    expect(predictor).toContain("doh_config.has_value() && !doh_config->servers().empty()");
    expect(predictor).not.toContain("FromStringLax");
    expect(predictor).toContain("return IsPreconnectAllowed(profile_);");
  });

  it("leaves proxy socket preconnects unchanged and admits only opted-in DNS-only jobs", () => {
    expect(consumer).toMatch(/const bool multicast_name =\s*host\.ends_with\("\.local"\) \|\| host\.ends_with\("\.local\."\);/);
    expect(consumer).toMatch(/const bool allow_proxy_dns =\s*has_proxy && job->num_sockets == 0 && !multicast_name && delegate_ &&\s*delegate_->ShouldPreresolveThroughProxy\(\);/);
    expect(consumer).toMatch(/if \(has_proxy && !allow_proxy_dns\)\s*\{\s*FinishPreresolveJob\(job_id, has_proxy\);\s*\} else\s*\{\s*job->resolve_host_client = PreresolveUrl\(/);
    // The unchanged callback tail lies outside the unified hunk's context.
    // Fail if the patch changes those existing restriction/lifetime bindings.
    const changedLines = sections.get("content/browser/preloading/preconnect/preconnect_manager_impl.cc")!
      .split("\n").filter((line) => /^[+-]/.test(line) && !/^(?:---|\+\+\+)/.test(line)).join("\n");
    expect(changedLines).not.toMatch(/network_restrictions_id|GetWeakPtr|OnPreresolveFinished/);
  });

  it("adds no preloading override, plain-DNS fallback, domain exception, or warning suppression", () => {
    const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1)).join("\n");
    expect(additions).not.toMatch(/ping0|SecureDnsPolicy::kDisable|HostResolverSource::SYSTEM|LOAD_BYPASS_PROXY|disable-infobars|test-type|network_prediction_options/);
    expect([...sections.keys()]).toHaveLength(5);
    expect([...sections.keys()].join("\n")).not.toMatch(/bad_flags|infobar|keychain|dns_http_attempt|host_resolver_manager/);
  });

  it("includes native positive, default-deny, disabled-preloading, failure, and socket cases", () => {
    for (const test of [
      "TestProxyDnsOnlyRequiresEmbedderOptIn", "TestProxyDnsOnlyUsesAllowedSecureRoute",
      "TestProxyDnsOptInStillSkipsMulticastNames", "TestProxyDnsSecureRouteLookupFailure", "TestProxyDnsOptInRespectsDisabledPreloading",
      "TestProxyPreconnectStillSkipsDnsWithOptIn",
    ]) expect(nativeTests).toContain(test);
    expect(nativeTests).toContain("net::ERR_NAME_NOT_RESOLVED");
    expect(nativeTests).toContain("IsPreconnectEnabled()).WillOnce(Return(false))");
    expect(nativeTests).toContain("GetIndirectProxyInfo()");
  });

  it("commits the exact patch and every changed target in the native manifests", () => {
    const digest = createHash("sha256").update(patch).digest("hex");
    expect(fs.readFileSync(path.join(root, "PATCHSET.sha256"), "utf8")).toContain(`${digest}  ${name}`);
    const finalSources = fs.readFileSync(path.join(root, "PATCHED_SOURCE.sha256"), "utf8");
    for (const relative of sections.keys()) expect(finalSources).toContain(`  ${relative}\n`);
  });
});
