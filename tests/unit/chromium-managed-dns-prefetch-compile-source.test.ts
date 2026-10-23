import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Offline patch contracts only; real Clang compilation remains a separate gate.
const root = path.resolve(__dirname, "../../patches/chromium");
const name = "patches/0053-fix-managed-dns-prefetch-gurl-api.patch";
const patch = fs.readFileSync(path.join(root, name), "utf8");
const additions = patch.split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1)).join("\n");
const removals = patch.split("\n")
  .filter((line) => line.startsWith("-") && !line.startsWith("---"))
  .map((line) => line.slice(1)).join("\n");
const targets = [...patch.matchAll(/^diff --git a\/(\S+) b\/\1$/gm)]
  .map((match) => match[1]);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("Chromium 0053 real-compile prefetch corrections", () => {
  it("uses the pinned GURL string-view accessor instead of the removed API", () => {
    expect(removals).toContain("const auto host = job->url.host_piece();");
    expect(additions).toContain("const auto host = job->url.host();");
    expect(additions).not.toContain("host_piece");
    expect(patch).toContain('host.ends_with(".local") || host.ends_with(".local.")');
  });

  it("keeps the default deny decision out of the public inline virtual body", () => {
    expect(additions).toContain("class CONTENT_EXPORT Delegate {");
    expect(additions).toContain("virtual bool ShouldPreresolveThroughProxy();");
    expect(additions).toContain("bool PreconnectManager::Delegate::ShouldPreresolveThroughProxy() {\n  return false;\n}");
    expect(additions).not.toMatch(/virtual bool ShouldPreresolveThroughProxy\(\)\s*\{/);
    expect(additions).not.toContain("return true;");
  });

  it("does not weaken proxy, multicast, preloading, TLS, or warning policy", () => {
    expect(targets).toEqual([
      "content/browser/preloading/preconnect/preconnect_manager_impl.cc",
      "content/public/browser/preconnect_manager.h",
    ]);
    expect(additions).not.toMatch(/has_proxy|num_sockets|multicast_name|secure_dns|IsPreconnectEnabled|disable-infobars|test-type|SYSTEM|ping0|ignore-certificate/);
  });

  it("preserves the earlier source patches byte for byte", () => {
    expect(digest(fs.readFileSync(path.join(root, "patches/0051-agent-browser-local-dns-policy.patch"))))
      .toBe("2ee8b807e9135a763b08f8de07b4145cb3fd84faef39e88b3e8304b6ec405535");
    expect(digest(fs.readFileSync(path.join(root, "patches/0052-agent-browser-managed-proxy-dns-prefetch.patch"))))
      .toBe("7f242fd728140aefdd14f0af5ea99764069a7633346c8385d301ac50e1566a73");
  });

  it("commits the correction and both final source identities", () => {
    expect(fs.readFileSync(path.join(root, "PATCHSET.sha256"), "utf8"))
      .toContain(`${digest(patch)}  ${name}\n`);
    const finalSources = fs.readFileSync(path.join(root, "PATCHED_SOURCE.sha256"), "utf8");
    expect(finalSources).toContain("ebc2ad7d833abd0ee932ecdca401a2af59609994ecf7fa5b32d70159e0ae1449  content/browser/preloading/preconnect/preconnect_manager_impl.cc\n");
    expect(finalSources).toContain("12e55b9b54413fc93af5d50e5f9b2812aec51e92ad0f51037b7b44023a1d7607  content/public/browser/preconnect_manager.h\n");
  });
});
