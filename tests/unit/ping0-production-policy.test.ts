import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, Request } from "playwright";
import type { BrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";
import { AGENT_BROWSER_FINGERPRINT_SWITCH } from "../../src/main/services/browser-fingerprint-config.js";
import { buildRemoteDnsRule } from "../../src/main/services/browser-dns-policy.js";

// Source imports and synthetic collection must never start an app, touch a
// profile, bind a port, or contact a site. Keep Firefox/app dependencies inert.
const blocked = vi.hoisted(() => ({
  io: vi.fn(() => { throw new Error("External I/O is forbidden in this unit test"); }),
  exitCode: process.exitCode,
}));
vi.mock("node:child_process", () => ({ execFile: blocked.io, execFileSync: blocked.io, spawn: blocked.io }));
vi.mock("node:http", () => ({ get: blocked.io }));
vi.mock("node:net", async (importOriginal) => ({
  isIP: (await importOriginal<typeof import("node:net")>()).isIP, createServer: blocked.io,
}));
vi.mock("node:fs", () => ({
  existsSync: blocked.io, statSync: blocked.io, mkdtempSync: blocked.io,
  mkdirSync: blocked.io, writeFileSync: blocked.io, rmSync: blocked.io,
}));
vi.mock("playwright", () => ({ chromium: { connectOverCDP: blocked.io } }));
vi.mock("../../src/main/services/browser-engine.js", () => ({
  buildFirefoxLaunchArgs: blocked.io, writeFirefoxUserJs: blocked.io,
  findFirefoxBinary: blocked.io, detectFirefoxVersion: blocked.io,
}));
vi.mock("../../src/main/services/firefox-fingerprint.js", () => ({ buildFirefoxManagedIdentity: blocked.io }));
vi.mock("../../src/main/services/bidi-client.js", () => ({
  connectBidi: blocked.io, bidiAddPreloadScript: blocked.io, bidiCreateContext: blocked.io,
  bidiCloseContext: blocked.io, bidiGetTopContext: blocked.io, bidiEvaluateInContext: blocked.io,
  bidiNavigate: blocked.io, bidiActivateContext: blocked.io,
}));

import {
  assessPing0Run,
  buildPing0ChromiumPolicy,
  categorizeFindings,
  collectPing0OnPage,
  type Ping0CollectionOptions,
} from "../../src/tools/verify-ping0.js";

const proxy = { upstreamHost: "proxy.example", upstreamPort: 8080, proxyType: "http" as const };
const fingerprint = { fingerprintSeed: 70001, platform: "windows" as const, locale: "en-US" };
const runtimeVersion = "150.0.7871.42";

function decodeFingerprint(args: string[]): BrowserFingerprintConfig {
  const arg = args.find((value) => value.startsWith(AGENT_BROWSER_FINGERPRINT_SWITCH));
  if (!arg) throw new Error("Missing managed fingerprint argument");
  return JSON.parse(Buffer.from(arg.slice(AGENT_BROWSER_FINGERPRINT_SWITCH.length), "base64url").toString("utf8"));
}

function syntheticPage(initial: Record<string, unknown> = {}, initialUrl = "https://ping0.cc/env") {
  const data: Record<string, unknown> = {
    finished: true, score: 100, level: "synthetic", reportId: "synthetic-report",
    finalFindings: [], rows: {}, quickProbes: null, status: "done", raf: null, ...initial,
  };
  vi.stubGlobal("document", {
    querySelector: () => ({ __vue__: { $data: data } }),
    visibilityState: "visible", hasFocus: () => true,
    body: { innerText: "private-document-body" },
  });
  const events = new EventEmitter();
  let currentUrl = initialUrl;
  const owned = {
    goto: vi.fn(async (url: string, _options?: unknown) => { currentUrl = url; return null; }),
    url: vi.fn(() => currentUrl),
    evaluate: vi.fn(async (callback: () => unknown): Promise<unknown> => callback()),
    bringToFront: vi.fn(async () => undefined),
    on: vi.fn(events.on.bind(events)), off: vi.fn(events.off.bind(events)),
    close: vi.fn(async () => undefined), context: vi.fn(),
  };
  return { ...owned, page: owned as unknown as Page, data, events, setUrl: (url: string) => { currentUrl = url; } };
}

function syntheticRequest(url: string, errorText?: string) {
  const request = {
    url: () => url, failure: () => errorText ? { errorText } : null,
    headers: vi.fn(() => ({ authorization: "private-header" })),
    allHeaders: vi.fn(async () => ({ authorization: "private-header" })),
    postData: vi.fn(() => "private-request-body"),
  };
  return { request: request as unknown as Request, ...request };
}

const collectionOptions: Ping0CollectionOptions = {
  siteAccessAuthorized: true, navigate: false,
  navigationTimeoutMs: 10, waitTimeoutMs: 10, settleMs: 0,
};

afterEach(() => {
  expect(blocked.io).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(blocked.exitCode);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ping0 standalone production DNS policy", () => {
  it("can be imported without invoking the standalone main", () => {
    expect(blocked.io).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(blocked.exitCode);
  });

  it.each(["http", "socks5"] as const)("defaults %s to shared proxy-side DNS over TCP", (proxyType) => {
    const policy = buildPing0ChromiumPolicy({ ...proxy, proxyType }, fingerprint, runtimeVersion);
    expect(policy.args).toContain(`--proxy-server=${proxyType}://proxy.example:8080`);
    expect(policy.args).toContain("--host-resolver-rules=" + buildRemoteDnsRule(proxy.upstreamHost, null));
    expect(policy.args).toContain("--disable-quic");
    expect(policy.args).not.toContain("--enable-quic");
    expect(decodeFingerprint(policy.args).secureDns).toEqual({ enabled: false, templates: [] });
    expect(policy.dns).toEqual({ route: "proxy", evidence: "configured", transactionsVerified: false });
  });

  it.each(["http", "socks5"] as const)("uses the restricted %s DNS entry only with explicit native support", (proxyType) => {
    const policy = buildPing0ChromiumPolicy({ ...proxy, proxyType, nativeLocalDnsPolicy: true }, fingerprint, runtimeVersion);
    expect(policy.args).toContain("--agent-browser-local-dns-policy=proxy-local-dns-deny");
    expect(policy.args).toContain("--agent-browser-proxy-bootstrap-host=proxy.example");
    expect(policy.args.some((arg) => arg.startsWith("--host-resolver-rules="))).toBe(false);
    expect(policy.dns).toEqual({ route: "proxy", evidence: "configured", transactionsVerified: false });
  });

  it("does not install the local-DNS deny policy on explicit strict DoH", () => {
    const policy = buildPing0ChromiumPolicy({ ...proxy, nativeLocalDnsPolicy: true, dohUrl: "https://resolver.example/dns-query{?dns}" }, fingerprint, runtimeVersion);
    expect(policy.args.some((arg) => /--(?:host-resolver-rules|agent-browser-local-dns-policy|agent-browser-proxy-bootstrap-host)=/.test(arg))).toBe(false);
    expect(decodeFingerprint(policy.args).secureDns.enabled).toBe(true);
  });

  it.each(["http", "socks5"] as const)("validates explicit %s DoH without claiming transaction success or UDP", (proxyType) => {
    const dohUrl = "https://resolver.example/dns-query?key=private-query-token{&dns}";
    const policy = buildPing0ChromiumPolicy({ ...proxy, proxyType, dohUrl }, fingerprint, runtimeVersion);
    expect(decodeFingerprint(policy.args).secureDns).toEqual({ enabled: true, templates: [dohUrl] });
    expect(policy.args.some((arg) => arg.startsWith("--host-resolver-rules="))).toBe(false);
    expect(policy.args).toContain("--disable-quic");
    expect(policy.args).not.toContain("--enable-quic");
    expect(policy.dns).toEqual({ route: "doh", evidence: "configured", transactionsVerified: false });
    expect(JSON.stringify(policy.dns)).not.toMatch(/resolver\.example|private-query-token/);
  });

  it.each([
    "http://resolver.example/dns-query", "https://user:password@resolver.example/dns-query",
    "https://resolver.example/dns-query#private-fragment", "https://resolver.example/{unknown}",
    "https://resolver.example/dns-query?key=private-query-token{?dns}", "not-a-url",
  ])("rejects an invalid explicit provider without echoing it (%#)", (dohUrl) => {
    let failure: unknown;
    try { buildPing0ChromiumPolicy({ ...proxy, dohUrl }, fingerprint, runtimeVersion); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/Invalid managed secure DNS URL/);
    expect(String(failure)).not.toContain(dohUrl);
  });

  it("builds managed UA/appVersion from the actual supplied runtime version", () => {
    const config = decodeFingerprint(buildPing0ChromiumPolicy(proxy, fingerprint, runtimeVersion).args);
    expect(config.userAgent).toContain(`Chrome/${runtimeVersion}`);
    expect(config.appVersion).toContain(`Chrome/${runtimeVersion}`);
  });

  it.each(["", "unknown", "150", "150.0.7871"])("refuses a legacy/default version fallback (%#)", (version) => {
    expect(() => buildPing0ChromiumPolicy(proxy, fingerprint, version)).toThrow(/runtime version is required/);
  });

  it("does not dismiss unattributed DNS findings as already-solved boundary noise", () => {
    const dns = [{ id: "xc.dns_ip_country", fail: true }, { id: "xc.dns_blackhole", fail: true }];
    const boundary = { id: "stealth.raf_timing", fail: true };
    expect(categorizeFindings([...dns, boundary, { id: "other", fail: false }])).toEqual({
      identityFails: dns, boundaryFails: [boundary],
    });
  });
});

describe("caller-owned Page collector (synthetic only)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
  });

  it("defers all Page access, including listeners, until authorization is established", async () => {
    const page = new Proxy({}, { get() { throw new Error("Page accessed without authorization"); } }) as Page;
    const result = await collectPing0OnPage(page, { siteAccessAuthorized: false, observeDns: true });
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "site-access-not-authorized", state: null, dnsObservations: [] });
  });

  it.each([
    { waitTimeoutMs: 0 }, { waitTimeoutMs: 600001 }, { waitTimeoutMs: Number.NaN },
    { navigationTimeoutMs: 60001 }, { settleMs: -1 }, { settleMs: 300001 },
    { maxDnsObservations: -1 }, { maxDnsObservations: 101 }, { maxDnsObservations: 1.5 },
  ])("rejects unbounded/invalid options before accessing the Page (%#)", async (invalid) => {
    const page = new Proxy({}, { get() { throw new Error("Page accessed with invalid options"); } }) as Page;
    const result = await collectPing0OnPage(page, { ...collectionOptions, ...invalid });
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "invalid-options", state: null });
  });

  it("reuses an already-navigated Page without launching, attaching, closing, or copying it", async () => {
    const owned = syntheticPage();
    const result = await collectPing0OnPage(owned.page, collectionOptions);
    expect(result).toMatchObject({ outcome: "completed", reason: null, dnsTransactionsVerified: false });
    expect(result.state).toMatchObject({ finished: true, score: 100, reportId: "synthetic-report", bodyText: "" });
    expect(result.state?.finishedAt).not.toBe("");
    expect(result.state?.settledAt).not.toBe("");
    expect(owned.goto).not.toHaveBeenCalled();
    expect(owned.close).not.toHaveBeenCalled();
    expect(owned.context).not.toHaveBeenCalled();
    expect(owned.on).not.toHaveBeenCalled();
  });

  it.each(["missing-findings", "invalid-final-findings", "non-string-report-id"])("does not manufacture assessment-ready Page evidence for %s", async (invalid) => {
    const owned = syntheticPage({ rows: {
      "dns.resolver_count": { value: 2, pending: false },
      "xc.dns_blackhole": { fail: false, pending: false },
    } });
    if (invalid === "missing-findings") delete owned.data.finalFindings;
    else if (invalid === "invalid-final-findings") {
      owned.data.finalFindings = null;
      owned.data.findings = [];
    } else owned.data.reportId = 123;
    const { state, ...collection } = await collectPing0OnPage(owned.page, collectionOptions);
    if (invalid === "missing-findings") expect(state?.findings).toBeUndefined();
    else if (invalid === "invalid-final-findings") expect(state?.findings).toBeNull();
    else expect(state?.reportId).toBe(123);
    expect(assessPing0Run({ state, collection })).toMatchObject({
      exitCode: 2, assessment: { scope: "site-findings-only", status: "INCONCLUSIVE" },
    });
  });

  it("navigates only to the fixed env URL when requested", async () => {
    const owned = syntheticPage({}, "about:blank");
    const result = await collectPing0OnPage(owned.page, { ...collectionOptions, navigate: true });
    expect(owned.goto).toHaveBeenCalledWith("https://ping0.cc/env", { waitUntil: "domcontentloaded", timeout: 10 });
    expect(result.outcome).toBe("completed");
    expect(owned.close).not.toHaveBeenCalled();
  });

  it("waits for the bounded settle period after observing finished === true", async () => {
    const owned = syntheticPage();
    const done = vi.fn();
    const pending = collectPing0OnPage(owned.page, { ...collectionOptions, settleMs: 50 }).then(done);
    await vi.advanceTimersByTimeAsync(49);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done.mock.calls[0][0].outcome).toBe("completed");
    const state = done.mock.calls[0][0].state;
    expect(Date.parse(state.settledAt) - Date.parse(state.finishedAt)).toBe(50);
  });

  it.each([false, "true", 1, null])("does not treat pending/truthy values as finished (%#)", async (finished) => {
    const owned = syntheticPage({ finished });
    const startedAt = Date.now();
    const pending = collectPing0OnPage(owned.page, { ...collectionOptions, settleMs: 500 });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "wait-timeout" });
    expect(result.state).toMatchObject({ finished: false, finishedAt: "", settledAt: "", status: "timeout" });
    expect(Date.now() - startedAt).toBe(10);
  });

  it("preserves a timeout even if the partial capture sees a late finished flag", async () => {
    const owned = syntheticPage({ finished: false });
    owned.evaluate.mockImplementationOnce(async (callback) => {
      const value = callback();
      owned.data.finished = true;
      return value;
    });
    const pending = collectPing0OnPage(owned.page, collectionOptions);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "wait-timeout" });
    expect(result.state).toMatchObject({ finished: true, finishedAt: "", settledAt: "", status: "timeout" });
  });

  it("does not claim completion if the app resets before capture", async () => {
    const owned = syntheticPage();
    owned.evaluate.mockImplementationOnce(async (callback) => {
      const value = callback();
      owned.data.finished = false;
      return value;
    });
    const result = await collectPing0OnPage(owned.page, collectionOptions);
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "state-not-finished" });
    expect(result.state).toMatchObject({ finishedAt: "", settledAt: "" });
  });

  it("rejects an unrelated/redirected page without evaluating it", async () => {
    const owned = syntheticPage({}, "https://other.example/env?token=private-query-token");
    const result = await collectPing0OnPage(owned.page, collectionOptions);
    expect(result).toMatchObject({ outcome: "failed", reason: "unexpected-page", state: null });
    expect(owned.evaluate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-query-token");
  });

  it.each(["navigation", "wait", "capture"] as const)("reports %s errors as failed, not finished or timeout", async (phase) => {
    const owned = syntheticPage();
    const error = new Error("private-error https://user:password@other.example/?token=private-query-token");
    if (phase === "navigation") owned.goto.mockRejectedValueOnce(error);
    else {
      if (phase === "capture") owned.evaluate.mockImplementationOnce(async (callback) => callback());
      owned.evaluate.mockRejectedValueOnce(error);
    }
    const result = await collectPing0OnPage(owned.page, { ...collectionOptions, navigate: phase === "navigation", observeDns: true });
    expect(result).toMatchObject({ outcome: "failed", reason: `${phase}-failed`, state: null });
    expect(JSON.stringify(result)).not.toMatch(/private-error|private-query-token|password/);
    expect(owned.events.listenerCount("request")).toBe(0);
    expect(owned.events.listenerCount("requestfailed")).toBe(0);
    expect(owned.close).not.toHaveBeenCalled();
  });

  it.each(["navigation", "wait", "capture"] as const)("bounds a hung %s operation", async (phase) => {
    const owned = syntheticPage();
    if (phase === "navigation") owned.goto.mockImplementationOnce(() => new Promise<null>(() => undefined));
    else {
      if (phase === "capture") owned.evaluate.mockImplementationOnce(async (callback) => callback());
      owned.evaluate.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
    }
    const pending = collectPing0OnPage(owned.page, { ...collectionOptions, navigate: phase === "navigation" });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "inconclusive", reason: `${phase}-timeout` });
    expect(result.state?.finishedAt ?? "").toBe("");
    expect(vi.getTimerCount()).toBe(0);
    expect(owned.close).not.toHaveBeenCalled();
  });

  it("bounds and redacts optional observations without interpreting a counter as DNS proof", async () => {
    const owned = syntheticPage({}, "about:blank");
    const existingListener = vi.fn();
    owned.events.on("request", existingListener);
    const doh = syntheticRequest("https://user:password@dns.example/dns-query?token=private-query-token#private-fragment");
    const dnsError = syntheticRequest("https://other.example/private-path", "net::ERR_NAME_NOT_RESOLVED private-error private-query-token");
    const otherError = syntheticRequest("https://dns.example/private-path", "private-error Authorization: private-header");
    owned.goto.mockImplementationOnce(async (url) => {
      owned.setUrl(url);
      owned.events.emit("request", doh.request);
      owned.events.emit("requestfailed", dnsError.request);
      owned.events.emit("requestfailed", otherError.request);
      owned.events.emit("request", doh.request);
      return null;
    });
    const result = await collectPing0OnPage(owned.page, { ...collectionOptions, navigate: true, observeDns: true, maxDnsObservations: 3 });
    expect(result.outcome).toBe("completed");
    expect(result.dnsObservations).toEqual([
      { event: "request", target: "doh-url" },
      { event: "requestfailed", target: "dns-error", errorCode: "ERR_NAME_NOT_RESOLVED" },
      { event: "requestfailed", target: "dns-related-url", errorCode: "other" },
    ]);
    expect(result.dnsTransactionsVerified).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private-|password|Authorization|dns\.example|other\.example/);
    for (const request of [doh, dnsError, otherError]) {
      expect(request.headers).not.toHaveBeenCalled();
      expect(request.allHeaders).not.toHaveBeenCalled();
      expect(request.postData).not.toHaveBeenCalled();
    }
    expect(owned.events.listenerCount("request")).toBe(1);
    expect(owned.events.listenerCount("requestfailed")).toBe(0);
    owned.events.emit("request", doh.request);
    expect(existingListener).toHaveBeenCalledTimes(3);
    expect(result.dnsObservations).toHaveLength(3);
  });

  it("does not install observers when the explicit observation limit is zero", async () => {
    const owned = syntheticPage();
    const result = await collectPing0OnPage(owned.page, { ...collectionOptions, observeDns: true, maxDnsObservations: 0 });
    expect(result.dnsObservations).toEqual([]);
    expect(owned.on).not.toHaveBeenCalled();
  });
});
