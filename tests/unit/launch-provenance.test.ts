import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { BrowserProfileMeta, ProxyConfig } from "../../src/main/types.js";

// Pure fixtures only: neither import-time config/userData nor OS/CDP access.
vi.mock("../../src/main/services/page-eval.js", () => ({ evaluateInPage: vi.fn(() => { throw new Error("No page/network access"); }) }));
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => { throw new Error("No process enumeration"); }),
  exec: vi.fn(() => { throw new Error("No process enumeration"); }),
}));

import { buildBrowserFingerprintArg, buildBrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";
import { LaunchBlockedError } from "../../src/main/services/browser/launch-guards.js";
import {
  assertChromiumLaunchProvenance, assertChromiumReuseDnsCompatible, assertChromiumReuseEvidence, assertChromiumReuseWebRtcCompatible,
  chromiumLaunchPayloadHash, chromiumLaunchRequestHash, chromiumLaunchStampArg, parseChromiumLaunchStamp,
  stampChromiumLaunch, CHROMIUM_LAUNCH_STAMP_SWITCH,
} from "../../src/main/services/browser/launch-provenance.js";
import { CHROMIUM_WEBRTC_PROFILE_ARG, CHROMIUM_WEBRTC_IP_HANDLING_SWITCH, CHROMIUM_WEBRTC_PROXY_ONLY_ARG } from "../../src/main/services/browser/webrtc-policy.js";
import {
  inspectBrowserLaunchLines, normalizeBrowserProcessPath, parseBrowserLaunchProcessLine, parseBrowserProcessLine, browserLaunchProcessFromArgv,
  type BrowserLaunchProcess,
} from "../../src/main/services/process-discovery.js";

const profileDir = "/virtual/profiles/Managed Profile";
const executablePath = "/virtual/Managed Chromium/Chromium";
const meta: BrowserProfileMeta = {
  name: "Portable", engine: "chromium", fingerprintMode: "managed", platform: "macos",
  fingerprintSeed: 12345, locale: "en-US", timezone: "UTC", proxyMode: "none",
};
const cfg = { chromiumBin: executablePath, proxies: {} as Record<string, ProxyConfig> };

function fixture(profile: BrowserProfileMeta = meta): {
  requestHash: string;
  args: string[];
  stamped: string[];
  stamp: ReturnType<typeof stampChromiumLaunch>;
  evidence: BrowserLaunchProcess;
  mode: "managed" | "off";
} {
  const mode = profile.fingerprintMode === "off" ? "off" : "managed";
  const requestHash = chromiumLaunchRequestHash(profile, cfg);
  const native = buildBrowserFingerprintConfig(profile, "150.0.7800.1");
  const args = [
    `--user-data-dir=${profileDir}`, CHROMIUM_WEBRTC_PROFILE_ARG, "--remote-debugging-port=9222",
    ...(mode === "managed" ? [
      `--fingerprint=${profile.fingerprintSeed}`, `--fingerprint-platform=${profile.platform}`,
      buildBrowserFingerprintArg(profile, "150.0.7800.1"), `--user-agent=${native.userAgent}`, "--lang=en-US",
    ] : []),
  ];
  const stamp = stampChromiumLaunch(args, requestHash, mode);
  const stamped = [...args, chromiumLaunchStampArg(stamp)];
  const evidence = parseBrowserLaunchProcessLine(`4101 ${executablePath} ${stamped.join(" ")}`)!;
  return { requestHash, args, stamped, stamp, evidence, mode };
}

function expectRestart(action: () => unknown) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(LaunchBlockedError);
  expect(error).toMatchObject({ code: "restart-required" });
  expect((error as Error).message).toContain("Explicitly stop");
}

describe("versioned Chromium startup request", () => {
  it("normalizes relevant defaults, locale, timezone, numbers and paths", () => {
    const a = chromiumLaunchRequestHash(meta, cfg);
    expect(chromiumLaunchRequestHash({
      ...meta, locale: "EN-us", timezone: "Etc/UTC", renderScaleMode: "native", browserVersion: null,
      hardwareConcurrency: null, geolocationMode: "real", webrtcMode: "auto",
    }, { ...cfg, chromiumBin: "/virtual/Managed Chromium/./Chromium" })).toBe(a);
    expect(chromiumLaunchRequestHash({ ...meta, fingerprintSeed: "12345" as any }, cfg)).toBe(a);
  });

  it.each([
    { fingerprintSeed: 12346 }, { platform: "windows" }, { fingerprintMode: "off" }, { engine: "firefox" },
    { browserVersion: "150.0.7800.2" }, { locale: "de-DE" }, { timezone: "Europe/Berlin" },
    { webrtcMode: "disable" }, { hardwareConcurrency: 12 }, { deviceMemory: 16 },
    { screenWidth: 1728 }, { storageQuota: 9000 }, { fontsDir: "/virtual/fonts/custom" },
    { renderScaleMode: "strict" }, { geolocationMode: "custom", geolocationLatitude: 1, geolocationLongitude: 2 },
  ] as Array<Partial<BrowserProfileMeta>>)("changes the hash for active startup input %j", (change) => {
    expect(chromiumLaunchRequestHash({ ...meta, ...change }, cfg)).not.toBe(chromiumLaunchRequestHash(meta, cfg));
  });

  it("excludes display metadata, credentials, health timestamps and unrelated flags", () => {
    const proxy: ProxyConfig = { type: "http", host: "proxy.example.test", port: 8080, username: "a", password: "secret-a" };
    const named = { ...meta, proxyMode: "named" as const, proxyName: "primary" };
    const first = { ...cfg, proxies: { primary: proxy }, managedSecureDnsUrl: " https://dns.example.test/query{?dns} " };
    const next = { ...first, proxies: { primary: { ...proxy, username: "b", password: "secret-b" } }, blockOnFingerprintDrift: false, proxyHealth: { primary: { updatedAt: 999 } } };
    expect(chromiumLaunchRequestHash({ ...named, name: "Renamed", note: "Note", tags: ["tag"], updatedAt: 999, windowTitlePrefix: "Changed" }, next))
      .toBe(chromiumLaunchRequestHash(named, first));
    expect(chromiumLaunchRequestHash(named, { ...first, managedSecureDnsUrl: "https://dns2.example.test/query{?dns}" }))
      .not.toBe(chromiumLaunchRequestHash(named, first));
    expect(chromiumLaunchRequestHash(named, { ...first, proxies: { primary: { ...proxy, host: "other.example.test" } } }))
      .not.toBe(chromiumLaunchRequestHash(named, first));
    expect(chromiumLaunchRequestHash(meta, cfg, { headless: true })).not.toBe(chromiumLaunchRequestHash(meta, cfg));
  });

  it("ignores inactive OS/seed/identity fields in fingerprint-off mode, but not a mode switch", () => {
    const off = { ...meta, fingerprintMode: "off" as const };
    expect(chromiumLaunchRequestHash({ ...off, platform: "android", fingerprintSeed: 99999, locale: "invalid_ignored", timezone: "invalid_ignored", gpuRenderer: "ignored" }, cfg))
      .toBe(chromiumLaunchRequestHash(off, cfg));
    expect(chromiumLaunchRequestHash(off, cfg)).not.toBe(chromiumLaunchRequestHash(meta, cfg));
  });

  it("keeps the existing off+proxy DoH refusal in the reuse path without decrypting credentials", () => {
    const proxy = { type: "http", host: "proxy.example.test", port: 8080 } as ProxyConfig;
    const off = { ...meta, fingerprintMode: "off" as const, proxyMode: "named" as const, proxyName: "primary" };
    expect(() => assertChromiumReuseDnsCompatible(off, { proxies: { primary: proxy }, managedSecureDnsUrl: "https://dns.example.test/query{?dns}" })).toThrow("Explicit proxy DoH");
    expect(() => assertChromiumReuseDnsCompatible(off, { proxies: { primary: proxy } })).not.toThrow();
    expect(() => assertChromiumReuseDnsCompatible({ ...off, proxyMode: "none" }, { managedSecureDnsUrl: "https://dns.example.test/query{?dns}" })).not.toThrow();
  });
});

describe("WebRTC policy request and reuse binding", () => {
  const proxyCfg = { ...cfg, proxies: { primary: { type: "http", host: "proxy.example.test", port: 8080 } as ProxyConfig } };
  const named = { ...meta, proxyMode: "named" as const, proxyName: "primary", webrtcMode: "auto" as const };
  const proxyArg = "--proxy-server=http://proxy.example.test:8080";

  it("binds explicit real consent even in off mode and ignores unused Auto rewrite IPs", () => {
    const off = { ...named, fingerprintMode: "off" as const };
    expect(chromiumLaunchRequestHash({ ...off, webrtcMode: "real" }, proxyCfg)).not.toBe(chromiumLaunchRequestHash(off, proxyCfg));
    expect(chromiumLaunchRequestHash({ ...off, webrtcMode: "proxy-only" }, proxyCfg)).not.toBe(chromiumLaunchRequestHash(off, proxyCfg));
    expect(chromiumLaunchRequestHash({ ...named, webrtcIp: "203.0.113.19" }, proxyCfg)).toBe(chromiumLaunchRequestHash(named, proxyCfg));
    expect(chromiumLaunchRequestHash({ ...named, webrtcMode: "altered", webrtcIp: "203.0.113.19" }, proxyCfg))
      .not.toBe(chromiumLaunchRequestHash({ ...named, webrtcMode: "altered", webrtcIp: "203.0.113.20" }, proxyCfg));
  });

  it.each(["managed", "off"] as const)("requires the actual proxy-only flag on %s Auto reuse, even on newly self-consistent stamps", fingerprintMode => {
    const profile = { ...named, fingerprintMode };
    const f = fixture({ ...meta, fingerprintMode });
    const requestHash = chromiumLaunchRequestHash(profile, proxyCfg);
    const args = [...f.args, proxyArg, CHROMIUM_WEBRTC_PROXY_ONLY_ARG];
    const stamp = stampChromiumLaunch(args, requestHash, fingerprintMode);
    const stamped = [...args, chromiumLaunchStampArg(stamp)];
    expect(() => assertChromiumLaunchProvenance(stamped, requestHash, fingerprintMode)).not.toThrow();
    expect(() => assertChromiumReuseWebRtcCompatible(stamped, profile, proxyCfg)).not.toThrow();
    const oldPolicyArgs = args.filter(arg => arg !== CHROMIUM_WEBRTC_PROXY_ONLY_ARG);
    const restamped = [...oldPolicyArgs, chromiumLaunchStampArg(stampChromiumLaunch(oldPolicyArgs, requestHash, fingerprintMode))];
    expectRestart(() => assertChromiumReuseWebRtcCompatible(restamped, profile, proxyCfg));
    expect(() => assertChromiumReuseWebRtcCompatible([...f.args, proxyArg], { ...profile, webrtcMode: "real" }, proxyCfg)).not.toThrow();
  });

  it.each(["managed", "off"] as const)("binds the exact selected Default Chrome profile in %s mode", fingerprintMode => {
    const f = fixture({ ...meta, fingerprintMode });
    for (const selected of [[], ["--profile-directory=Profile 1"], ["--profile-directory", "Default"], [CHROMIUM_WEBRTC_PROFILE_ARG, CHROMIUM_WEBRTC_PROFILE_ARG], ["/profile-directory=Default"]]) {
      const args = [...f.args.filter(arg => arg !== CHROMIUM_WEBRTC_PROFILE_ARG), ...selected];
      expectRestart(() => stampChromiumLaunch(args, f.requestHash, f.mode));
      expectRestart(() => assertChromiumLaunchProvenance([...args, chromiumLaunchStampArg(f.stamp)], f.requestHash, f.mode));
    }
  });

  it("retains an already stamped detected altered IP without Geo lookup but rejects a conflicting custom IP", () => {
    const altered = { ...named, webrtcMode: "altered" as const, webrtcIp: null };
    const f = fixture({ ...altered, webrtcIp: "203.0.113.19" });
    const args = [...f.args, proxyArg, CHROMIUM_WEBRTC_PROXY_ONLY_ARG];
    expect(() => assertChromiumReuseWebRtcCompatible(args, altered, proxyCfg)).not.toThrow();
    expectRestart(() => assertChromiumReuseWebRtcCompatible(args, { ...altered, webrtcIp: "203.0.113.20" }, proxyCfg));
  });

  it.each([
    [CHROMIUM_WEBRTC_IP_HANDLING_SWITCH, "default"],
    [CHROMIUM_WEBRTC_IP_HANDLING_SWITCH, "disable_non_proxied_udp"],
    [`${CHROMIUM_WEBRTC_IP_HANDLING_SWITCH}=default`],
    [CHROMIUM_WEBRTC_PROXY_ONLY_ARG, CHROMIUM_WEBRTC_PROXY_ONLY_ARG],
    [CHROMIUM_WEBRTC_PROXY_ONLY_ARG, "-force-webrtc-ip-handling-policy=default"],
    [CHROMIUM_WEBRTC_PROXY_ONLY_ARG, "/force-webrtc-ip-handling-policy=default"],
  ])("cannot stamp split, duplicate, or downgraded routing tokens %j", (...tokens) => {
    const f = fixture();
    expectRestart(() => stampChromiumLaunch([...f.args, ...tokens], f.requestHash, f.mode));
  });
});

describe("managed Apple GPU generation request binding", () => {
  const gpuContext = { hostPlatform: "darwin", hostArchitecture: "arm64", kernelArchitecture: "arm64" };

  it("changes a legacy request even when no explicit GPU metadata changed", () => {
    const legacy = chromiumLaunchRequestHash(meta, cfg);
    const current = chromiumLaunchRequestHash(meta, cfg, { gpuContext } as any);
    expect(current).not.toBe(legacy);
    expect(chromiumLaunchRequestHash({ ...meta, name: "Renamed" }, cfg, { gpuContext } as any)).toBe(current);
  });

  it.each([false, true])("rejects the old self-consistent payload on %s cached reuse", (cached) => {
    const f = fixture();
    const current = chromiumLaunchRequestHash(meta, cfg, { gpuContext } as any);
    expectRestart(() => assertChromiumReuseEvidence(f.evidence, {
      profileDir, executablePath, requestHash: current, mode: "managed",
      ...(cached ? { pid: 4101, port: 9222, provenance: f.stamp } : {}),
    }));
  });

  it.each([
    { ...gpuContext, hostPlatform: "linux" },
    { ...gpuContext, hostArchitecture: "x64" },
    { ...gpuContext, kernelArchitecture: "x64" },
    { ...gpuContext, kernelArchitecture: null },
  ])("preserves the native rule hash for unsupported context %j", (context) => {
    expect(chromiumLaunchRequestHash(meta, cfg, { gpuContext: context } as any)).toBe(chromiumLaunchRequestHash(meta, cfg));
  });

  it.each([
    { ...meta, fingerprintMode: "off" as const, gpuRenderer: "inactive" },
    { ...meta, platform: "windows" as const },
    { ...meta, platform: "android" as const },
    { ...meta, engine: "firefox" as const },
  ])("leaves off and unrelated engine/platform hashes unchanged", (profile) => {
    expect(chromiumLaunchRequestHash(profile, cfg, { gpuContext } as any)).toBe(chromiumLaunchRequestHash(profile, cfg));
  });
});

describe("opaque startup payload and reuse proof", () => {
  it("survives an app restart with no registry and an unchanged, exact process", () => {
    const f = fixture();
    expect(f.stamp).toEqual({ version: 2, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(parseChromiumLaunchStamp(chromiumLaunchStampArg(f.stamp).slice(CHROMIUM_LAUNCH_STAMP_SWITCH.length))).toEqual(f.stamp);
    expect(assertChromiumReuseEvidence(f.evidence, { profileDir, executablePath, requestHash: f.requestHash, mode: "managed" })).toEqual(f.stamp);
    expect(assertChromiumReuseEvidence(f.evidence, { profileDir, executablePath, requestHash: f.requestHash, mode: "managed", pid: 4101, port: 9222, provenance: f.stamp })).toEqual(f.stamp);
  });

  it("requires only one explicit restart for legacy Chromium, not a permanent discovery ban", () => {
    const f = fixture();
    expectRestart(() => assertChromiumLaunchProvenance(f.args, f.requestHash, f.mode));
    expect(assertChromiumLaunchProvenance(f.stamped, f.requestHash, f.mode)).toEqual(f.stamp);
  });

  it.each(["v0", "v3", "unknown", "v2.short.short", "v2." + "a".repeat(64) + "." + "G".repeat(64)])("rejects malformed/unknown stamp %s", (value) => {
    const f = fixture();
    expectRestart(() => assertChromiumLaunchProvenance([...f.args, CHROMIUM_LAUNCH_STAMP_SWITCH + value], f.requestHash, f.mode));
  });

  it.each(["managed", "off"] as const)("refuses a self-consistent v1 %s stamp even with an otherwise matching request", (mode) => {
    const f = fixture({ ...meta, fingerprintMode: mode });
    const legacyPayloadHash = createHash("sha256").update(JSON.stringify({ version: 1, mode, args: [...f.args].sort() })).digest("hex");
    const legacy = `${CHROMIUM_LAUNCH_STAMP_SWITCH}v1.${f.requestHash}.${legacyPayloadHash}`;
    expect(legacyPayloadHash).not.toBe(f.stamp.payloadHash);
    expect(parseChromiumLaunchStamp(legacy.slice(CHROMIUM_LAUNCH_STAMP_SWITCH.length))).toBeNull();
    expectRestart(() => assertChromiumLaunchProvenance([...f.args, legacy], f.requestHash, mode));
    expectRestart(() => assertChromiumReuseEvidence({ ...f.evidence, args: [...f.args, legacy] }, {
      profileDir, executablePath, requestHash: f.requestHash, mode,
      provenance: { version: 1, requestHash: f.requestHash, payloadHash: legacyPayloadHash } as any,
    }));
  });

  it("rejects duplicate, bare and changed-request stamps", () => {
    const f = fixture();
    expectRestart(() => assertChromiumLaunchProvenance([...f.stamped, chromiumLaunchStampArg(f.stamp)], f.requestHash, f.mode));
    expectRestart(() => assertChromiumLaunchProvenance([...f.args, CHROMIUM_LAUNCH_STAMP_SWITCH.slice(0, -1)], f.requestHash, f.mode));
    expectRestart(() => assertChromiumLaunchProvenance(f.stamped, "b".repeat(64), f.mode));
  });

  it("binds the actual native payload and UA, rejecting tampering and duplicate legacy aliases", () => {
    const f = fixture();
    const native = f.args.find((arg) => arg.startsWith("--agent-browser-fingerprint-config="))!;
    expectRestart(() => assertChromiumLaunchProvenance(f.stamped.map((arg) => arg.startsWith("--user-agent=") ? "--user-agent=Other" : arg), f.requestHash, f.mode));
    expectRestart(() => assertChromiumLaunchProvenance([...f.stamped, native.replace("--agent-browser-", "--roxy-")], f.requestHash, f.mode));
    expectRestart(() => assertChromiumLaunchProvenance([...f.stamped, "--fingerprint=99999"], f.requestHash, f.mode));
    expectRestart(() => chromiumLaunchPayloadHash(f.args.map((arg) => arg === native ? "--agent-browser-fingerprint-config=malformed" : arg), f.mode));
    const altered = f.args.map((arg) => arg === "--fingerprint=12345" ? "--fingerprint=54321" : arg);
    expectRestart(() => assertChromiumLaunchProvenance([...altered, chromiumLaunchStampArg(f.stamp)], f.requestHash, f.mode));
  });

  it.each([
    "--proxy-server=socks5://proxy.example.test:1080", "--proxy-bypass-list=example.test;*.other.test",
    "--no-proxy-server", "--proxy-auto-detect", "--proxy-pac-url=https://pac.example.test/proxy.pac", "--proxy-pac-mandatory",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE proxy.example.test",
    "--disable-quic", "--enable-quic", "--ignore-certificate-errors-spki-list=public-spki-hash",
    "--origin-to-force-quic-on=bridge.example.test:443", CHROMIUM_WEBRTC_PROXY_ONLY_ARG,
  ])("binds actual non-credential DNS/transport argv: %s cannot be changed or removed", (transportArg) => {
    const f = fixture();
    const args = [...f.args, transportArg];
    const stamp = stampChromiumLaunch(args, f.requestHash, f.mode);
    const stamped = [...args, chromiumLaunchStampArg(stamp)];
    expect(assertChromiumLaunchProvenance(stamped, f.requestHash, f.mode)).toEqual(stamp);
    const altered = transportArg.includes("=") ? transportArg + "-changed" : transportArg === "--disable-quic" ? "--enable-quic" : "--disable-quic";
    expectRestart(() => assertChromiumLaunchProvenance(stamped.map((arg) => arg === transportArg ? altered : arg), f.requestHash, f.mode));
    expectRestart(() => assertChromiumLaunchProvenance(stamped.filter((arg) => arg !== transportArg), f.requestHash, f.mode));
  });

  it.each(["--no-proxy-server", "--proxy-auto-detect", "--proxy-pac-url=https://pac.example.test/proxy.pac", "--proxy-pac-mandatory"])("rejects appending a proxy override to already-stamped argv: %s", (override) => {
    const f = fixture();
    expectRestart(() => assertChromiumLaunchProvenance([...f.stamped, override], f.requestHash, f.mode));
  });

  it.each(["--proxy-server", "--proxy-pac-url", "-proxy-server", "/proxy-server", "--Proxy-Pac-Url"])("never includes inline credentials from %s in the hashed payload", (key) => {
    const f = fixture();
    expectRestart(() => stampChromiumLaunch([...f.args, `${key}=http://user:private-password@proxy.example.test:8080`], f.requestHash, f.mode));
  });

  it("supports stamped off-mode reuse only when managed native payload/UA remain absent", () => {
    const f = fixture({ ...meta, fingerprintMode: "off" });
    expect(assertChromiumLaunchProvenance(f.stamped, f.requestHash, f.mode)).toEqual(f.stamp);
    expectRestart(() => assertChromiumLaunchProvenance([...f.stamped, "--user-agent=unexpected"], f.requestHash, f.mode));
    expectRestart(() => assertChromiumLaunchProvenance(fixture().stamped, f.requestHash, f.mode));
  });

  it.each([
    { executablePath: "/virtual/other/Chromium" }, { engine: "firefox" }, { profileDirs: [profileDir + "-other"] },
    { profileDirs: [profileDir, profileDir] }, { cdpPorts: [9222, 9222] }, { cdpPorts: [0] }, { malformed: true },
    { pid: 9999 }, { cdpPorts: [9333] },
  ] as Array<Partial<BrowserLaunchProcess>>)("rejects wrong/ambiguous process evidence %j", (change) => {
    const f = fixture();
    expectRestart(() => assertChromiumReuseEvidence({ ...f.evidence, ...change }, {
      profileDir, executablePath, requestHash: f.requestHash, mode: f.mode, pid: 4101, port: 9222,
    }));
  });

  it("rejects helper processes and cached provenance that does not belong to the live PID", () => {
    const f = fixture();
    expectRestart(() => assertChromiumReuseEvidence({ ...f.evidence, args: [...f.evidence.args, "--type=renderer"] }, { profileDir, executablePath, requestHash: f.requestHash, mode: f.mode }));
    expectRestart(() => assertChromiumReuseEvidence(f.evidence, { profileDir, executablePath, requestHash: f.requestHash, mode: f.mode, provenance: { ...f.stamp, payloadHash: "c".repeat(64) } }));
  });
});

describe("launch-only process parser fixtures", () => {
  it("preserves unquoted ps and quoted WMIC paths/UAs without weakening exact paths", () => {
    const f = fixture();
    const quoted = parseBrowserLaunchProcessLine(`4101 "${executablePath}" ${f.stamped.map((arg) => `"${arg}"`).join(" ")}`)!;
    expect(quoted).toEqual(f.evidence);
    expect(quoted.args.find((arg) => arg.startsWith("--user-agent="))).toBe(f.args.find((arg) => arg.startsWith("--user-agent=")));
    expect(inspectBrowserLaunchLines([`4101 ${executablePath} ${f.stamped.join(" ")}`], profileDir + "-other").candidates).toEqual([]);
  });

  it.each(["whole-argument", "quoted-value", "escaped-inner-quotes"])("keeps fake switches inside a CIM %s display argument", (format) => {
    const f = fixture();
    const displayArg = format === "escaped-inner-quotes"
      ? '--agent-browser-window-title-prefix=QA "--lang=fr"'
      : "--agent-browser-window-title-prefix=QA --lang=fr";
    const encodedDisplay = format === "quoted-value"
      ? '--agent-browser-window-title-prefix="QA --lang=fr"'
      : JSON.stringify(displayArg);
    const line = `4101 ${JSON.stringify(executablePath)} ${f.stamped.map((arg) => JSON.stringify(arg)).join(" ")} ${encodedDisplay}`;
    const evidence = parseBrowserLaunchProcessLine(line)!;
    expect(evidence.malformed).toBe(false);
    expect(evidence.args.filter((arg) => arg.startsWith("--lang="))).toEqual(["--lang=en-US"]);
    expect(evidence.args.filter((arg) => arg.startsWith("--agent-browser-window-title-prefix="))).toEqual([displayArg]);
    expect(assertChromiumReuseEvidence(evidence, { profileDir, executablePath, requestHash: f.requestHash, mode: f.mode })).toEqual(f.stamp);
  });

  it.each(["--lang=fr", "--type=renderer", "--no-proxy-server", "--unknown-display-only=1"])("does not pretend flat ps display text containing %s has exact argv boundaries", (pseudoFlag) => {
    const f = fixture();
    const displayArg = `--agent-browser-window-title-prefix=QA ${pseudoFlag}`;
    const raw = parseBrowserLaunchProcessLine(`4101 ${executablePath} ${[...f.stamped, displayArg].join(" ")}`)!;
    expect(raw.malformed).toBe(true);
    // In particular, a fake display --type must not disappear as an ignored
    // helper and allow an automatic second launch after the app restarts.
    expect(inspectBrowserLaunchLines([`4101 ${executablePath} ${[...f.stamped, displayArg].join(" ")}`], profileDir).candidates).toHaveLength(1);
    expectRestart(() => assertChromiumReuseEvidence(raw, { profileDir, executablePath, requestHash: f.requestHash, mode: f.mode }));
    const owned = browserLaunchProcessFromArgv(4101, executablePath, [...f.stamped, displayArg]);
    expect(owned.args.filter((arg) => arg.startsWith("--agent-browser-window-title-prefix="))).toEqual([displayArg]);
    expect(assertChromiumReuseEvidence(owned, { profileDir, executablePath, requestHash: f.requestHash, mode: f.mode })).toEqual(f.stamp);
  });

  it("handles Windows exact executable/profile paths independent of the test host", () => {
    const line = '5201 "C:\\Program Files\\Managed Chromium\\chrome.exe" --user-data-dir="C:\\Profiles\\Managed Profile" --remote-debugging-port=9222';
    const evidence = parseBrowserLaunchProcessLine(line)!;
    expect(evidence.executablePath).toBe("C:\\Program Files\\Managed Chromium\\chrome.exe");
    expect(inspectBrowserLaunchLines([line], "c:\\profiles\\managed profile").candidates).toHaveLength(1);
    expect(normalizeBrowserProcessPath("/case/Profile")).not.toBe(normalizeBrowserProcessPath("/case/profile"));
  });

  it("retains Firefox and ordinary discovery contracts, with no stamp requirement there", () => {
    const line = '6201 /virtual/firefox -profile "/virtual/fx" --remote-debugging-port 9333 -no-remote';
    expect(parseBrowserProcessLine(line, "/virtual/fx")).toEqual({ pid: 6201, cdpPort: 9333 });
    expect(parseBrowserLaunchProcessLine(line)).toMatchObject({ engine: "firefox", profileDirs: ["/virtual/fx"], cdpPorts: [9333] });
    expect(parseBrowserProcessLine("6202 /virtual/chrome --user-data-dir=/virtual/ch --remote-debugging-port=9222", "/virtual/ch")).toEqual({ pid: 6202, cdpPort: 9222 });
  });

  it("selects one stamped browser owner among five real-shaped inherited-CDP renderer helpers", () => {
    const f = fixture();
    const main = `4101 ${executablePath} ${f.stamped.join(" ")}`;
    const helpers = Array.from({ length: 5 }, (_, index) => `${4102 + index} /virtual/Chromium Helper (Renderer) --type=renderer --user-data-dir=${profileDir} --remote-debugging-port=9222`);
    const snapshot = inspectBrowserLaunchLines([...helpers, main], profileDir, 4104);
    expect(snapshot.candidates.map((entry) => entry.pid)).toEqual([4101]);
    expect(snapshot.tracked?.pid).toBe(4104);
    expect(snapshot.tracked?.args).toContain("--type=renderer");
    expectRestart(() => assertChromiumReuseEvidence(snapshot.tracked!, { profileDir, executablePath, requestHash: f.requestHash, mode: f.mode }));
    // Ignoring child processes must not hide another actual browser owner.
    expect(inspectBrowserLaunchLines([...helpers, main, main.replace(/^4101/, "4200")], profileDir).candidates.map((entry) => entry.pid)).toEqual([4101, 4200]);
  });

  it("exposes duplicate owners, reused PIDs, malformed ports and unavailable argv instead of assuming safe reuse", () => {
    const f = fixture();
    const line = `4101 ${executablePath} ${f.stamped.join(" ")}`;
    expect(inspectBrowserLaunchLines([line, line.replace(/^4101/, "4102")], profileDir, 4101).candidates).toHaveLength(2);
    const helper = `4102 /virtual/Chromium Helper --type=renderer --user-data-dir=${profileDir}`;
    expect(inspectBrowserLaunchLines([line, helper], profileDir, 4101).candidates).toHaveLength(1);
    // Actual filtered receipt: five Renderer children inherited this exact
    // profile/CDP port without owning the browser endpoint or carrying a stamp.
    const inheritedPort = inspectBrowserLaunchLines([line, helper + " --remote-debugging-port=9222"], profileDir, 4102);
    expect(inheritedPort.candidates.map((entry) => entry.pid)).toEqual([4101]);
    expect(inheritedPort.tracked).toMatchObject({ pid: 4102, cdpPorts: [9222] });
    const snapshot = inspectBrowserLaunchLines(["4101 /virtual/other --user-data-dir=/virtual/other --remote-debugging-port=9333"], profileDir, 4101);
    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.tracked?.pid).toBe(4101);
    expect(parseBrowserLaunchProcessLine(line.replace("--remote-debugging-port=9222", "--remote-debugging-port=9222junk"))?.malformed).toBe(true);
    expect(inspectBrowserLaunchLines([], profileDir).available).toBe(false);
    expect(inspectBrowserLaunchLines(['4101 "chrome.exe","4101","window title --user-data-dir=/virtual/profile"'], profileDir).available).toBe(false);
  });
});

describe("Firefox launch argument discovery", () => {
  const firefox = String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`;
  const profile = String.raw`C:\Profiles\Managed Profile`;
  const appUrl = "https://example.test/app";
  const line = (portArgs: string) => `6201 "${firefox}" -profile "${profile}" ${portArgs} -no-remote`;

  it.each([
    "--remote-debugging-port 9333 -headless",
    `--remote-debugging-port 9333 ${appUrl}`,
    `--remote-debugging-port=9333 ${appUrl}`,
    `--remote-debugging-port 9333 -headless ${appUrl}`,
    `--remote-debugging-port 9333 -headless --agent-browser-native-required ${appUrl}`,
    '--remote-debugging-port 9333 "data:text/html,hello world"',
    "--remote-debugging-port 9333 data:text/html,hello",
  ])("preserves exact Windows paths and port before Firefox arguments: %s", (portArgs) => {
    const snapshot = inspectBrowserLaunchLines([line(portArgs)], profile, 6201);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]).toMatchObject({
      pid: 6201, executablePath: firefox, engine: "firefox", profileDirs: [profile], cdpPorts: [9333], malformed: false,
    });
    expect(snapshot.tracked).toBe(snapshot.candidates[0]);
    expect(inspectBrowserLaunchLines([line(portArgs)], profile + "-other").candidates).toEqual([]);
  });

  it.each(["Managed Firefox", "Managed -headless Firefox"])("does not tokenize unquoted executable or profile paths containing %s", (directory) => {
    const executablePath = `/virtual/${directory}/firefox`;
    const profileDir = `/virtual/${directory}/Owned Profile`;
    const evidence = parseBrowserLaunchProcessLine(`6201 ${executablePath} -profile ${profileDir} --remote-debugging-port 9333 ${appUrl} -no-remote`);
    expect(evidence).toMatchObject({ executablePath, profileDirs: [profileDir], cdpPorts: [9333], malformed: false });
  });

  it("does not split a Chromium port value to admit a positional URL", () => {
    const evidence = parseBrowserLaunchProcessLine(`6201 "${firefox}" --user-data-dir="${profile}" --remote-debugging-port 9333 ${appUrl}`);
    expect(evidence).toMatchObject({ engine: "chromium", cdpPorts: [0], malformed: true });
  });

  it("does not treat a quoted path's flag-looking text as a headless argument", () => {
    const profileDir = String.raw`C:\Profiles\Owned -headless Profile`;
    const evidence = parseBrowserLaunchProcessLine(`6201 "${firefox}" -profile "${profileDir}" --remote-debugging-port 9333 -headless -no-remote`);
    expect(evidence).toMatchObject({ executablePath: firefox, profileDirs: [profileDir], cdpPorts: [9333], malformed: false });
  });

  it.each([
    "--remote-debugging-port 0",
    "--remote-debugging-port 65536",
    "--remote-debugging-port -1",
    "--remote-debugging-port +9333",
    "--remote-debugging-port 9e3",
    `--remote-debugging-port 9333junk ${appUrl}`,
    `--remote-debugging-port=9333junk ${appUrl}`,
    `--remote-debugging-port 9333 9444 ${appUrl}`,
    `--remote-debugging-port 9333 -headless=unexpected ${appUrl}`,
    `--remote-debugging-port 9333 -headless trailing-text`,
    `--remote-debugging-port 9333 ${appUrl} trailing-text`,
    `--remote-debugging-port "9333 ${appUrl}"`,
    `"--remote-debugging-port=9333 ${appUrl}"`,
    `--remote-debugging-port 9333 "${appUrl}" "https://other.example.test/"`,
    "--remote-debugging-port 9333 https://",
    "--remote-debugging-port 9333 about:blank",
    `--remote-debugging-port 9333 ${appUrl} --remote-debugging-port 9333`,
    `--remote-debugging-port 9333 ${appUrl} --remote-debugging-port=9444`,
    `--remote-debugging-port 9333 ${appUrl} --remote-debugging-port`,
  ])("retains malformed or duplicate port evidence for refusal: %s", (portArgs) => {
    const snapshot = inspectBrowserLaunchLines([line(portArgs)], profile, 6201);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0].malformed).toBe(true);
  });
});
