import { describe, expect, it } from "vitest";
import type { BrowserProfileMeta } from "../../src/main/types.js";
import { firefoxLaunchRequestHash, type FirefoxRequestOptions } from "../../src/main/services/browser/firefox-launch-provenance.js";

const options: FirefoxRequestOptions = {
  managedRoot: "/fixture/managed-firefox", binaryOverride: "/fixture/firefox", nativeRequested: false,
};
const profile = (): BrowserProfileMeta => ({
  name: "Owned fixture", engine: "firefox", fingerprintMode: "managed", platform: "macos",
  fingerprintSeed: 25516, locale: "en-US", timezone: "America/Los_Angeles", proxyMode: "none",
});

describe("Firefox session-owned startup intent", () => {
  it("is stable in one owner process and ignores display-only changes", () => {
    const before = profile(), after = { ...before, name: "Renamed", note: "Display note", tags: ["test"] };
    expect(firefoxLaunchRequestHash(after, {}, options)).toBe(firefoxLaunchRequestHash(before, {}, options));
    expect(firefoxLaunchRequestHash(before, {}, options)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["fingerprintSeed", 25517], ["fingerprintMode", "off"], ["locale", "fr-FR"],
    ["timezone", "Europe/Paris"], ["gpuRenderer", "Apple M2"], ["hardwareConcurrency", 12],
    ["browserVersion", "154.1"], ["appUrl", "https://example.test/"], ["allowThirdPartyCookies", true],
  ])("binds active %s", (key, value) => {
    const before = profile(), after = { ...before, [key]: value };
    expect(firefoxLaunchRequestHash(after, {}, options)).not.toBe(firefoxLaunchRequestHash(before, {}, options));
  });

  it("does not bind inactive managed identity in off mode", () => {
    const before = { ...profile(), fingerprintMode: "off" as const };
    const after = { ...before, fingerprintSeed: 77, locale: "fr-FR", timezone: "Europe/Paris", gpuRenderer: "inactive", hardwareConcurrency: 64 };
    expect(firefoxLaunchRequestHash(after, {}, { ...options, nativeRequested: true }))
      .toBe(firefoxLaunchRequestHash(before, {}, options));
  });

  it.each([
    { ...options, headless: true }, { ...options, binaryOverride: "/fixture/other-firefox" },
    { ...options, managedRoot: "/fixture/other-cache" }, { ...options, nativeRequested: true },
  ])("binds binary, mode and launch selection %j", (changed) => {
    expect(firefoxLaunchRequestHash(profile(), {}, changed)).not.toBe(firefoxLaunchRequestHash(profile(), {}, options));
  });

  it("binds selected proxy and credential changes without exposing a credential digest", () => {
    const meta = { ...profile(), proxyMode: "default" as const };
    const cfg = { defaultProxy: "fixture", proxies: { fixture: { type: "http" as const, host: "proxy.example.test", port: 8080, username: "test", password: "synthetic-only-A" } } };
    const original = firefoxLaunchRequestHash(meta, cfg, options);
    const changed = structuredClone(cfg); changed.proxies.fixture.password = "synthetic-only-B";
    expect(firefoxLaunchRequestHash(meta, changed, options)).not.toBe(original);
    expect(original).not.toContain("synthetic-only");
    changed.proxies.fixture.password = cfg.proxies.fixture.password; changed.proxies.fixture.port++;
    expect(firefoxLaunchRequestHash(meta, changed, options)).not.toBe(original);
  });

  it("binds DNS and verification policy even in off mode", () => {
    const meta = { ...profile(), fingerprintMode: "off" as const };
    const original = firefoxLaunchRequestHash(meta, {}, options);
    expect(firefoxLaunchRequestHash(meta, { managedSecureDnsUrl: "https://dns.example.test/query" }, options)).not.toBe(original);
    expect(firefoxLaunchRequestHash(meta, { blockOnEnvironmentRisk: true }, options)).not.toBe(original);
  });
});
