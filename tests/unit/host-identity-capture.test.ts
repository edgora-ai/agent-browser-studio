import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  createServer: vi.fn(),
  launch: vi.fn(() => { throw new Error("Pure capture tests must not launch browsers"); }),
  launchPersistentContext: vi.fn(() => { throw new Error("Pure capture tests must not launch browsers"); }),
  execFileSync: vi.fn(() => { throw new Error("Pure capture tests must not execute native programs"); }),
}));
vi.mock("node:http", () => ({ createServer: startup.createServer }));
vi.mock("playwright", () => ({ chromium: startup }));
vi.mock("node:child_process", () => ({ execFileSync: startup.execFileSync }));

import {
  captureFullHostIdentity, captureHostIdentitySurface, captureHostIdentityWorkerInPage, cleanupHostIdentityInPage,
  HOST_IDENTITY_HINTS, IDENTITY_CAPTURE_WARNINGS, HostIdentityCaptureError, startHostIdentityFixture,
  type HostIdentityFixture, type IdentitySurfaceCapture, type IdentitySurfaceOptions, type IdentityWorkerOptions,
} from "../../src/tools/host-identity-capture.js";
import { captureVersionIdentity, VersionIdentityCaptureError } from "../../src/tools/verify-native-chromium.js";
import type { IdentityContext, IdentityRunBinding } from "../../src/tools/host-identity-validation.js";

const VERSION = "152.0.7977.72", ORIGIN = "http://127.0.0.1:42000", CROSS = "http://127.0.0.1:42001";
const binding: IdentityRunBinding = {
  runId: "mock-run", hostId: "mock-host", profileId: "mock-owned-profile", pid: 321,
  executablePath: "/owned/mock/executable", executableSha256: "a".repeat(64), mode: "headed", identityMode: "managed",
};
const navigatorIdentity = () => ({
  userAgent: `Mock/1 Chrome/${VERSION}`, platform: "MacIntel", uaPlatform: "macOS", mobile: false,
  brands: [{ brand: "Chromium", version: "152" }],
  highEntropy: { architecture: "x86", bitness: "64", platform: "macOS", platformVersion: "14.0.0",
    fullVersionList: [{ brand: "Chromium", version: VERSION }], uaFullVersion: VERSION,
    model: "", wow64: false, mobile: false, formFactors: ["Desktop"], brands: [{ brand: "Chromium", version: "152" }] },
});
const policyHeader = () => HOST_IDENTITY_HINTS.map(([, feature]) => `${feature}=(self "${ORIGIN}" "${CROSS}")`).join(", ");
function surfaceOptions(context: IdentityContext = "window"): IdentitySurfaceOptions {
  return { context, origin: context === "cross-origin-frame" ? CROSS : ORIGIN, topLevelOrigin: ORIGIN, crossOrigin: CROSS,
    prefix: "/mock-capture/", timeoutMs: 100, hints: HOST_IDENTITY_HINTS,
    parentObservation: { origin: ORIGIN, secureContext: true, api: "featurePolicy", allowedHints: HOST_IDENTITY_HINTS.map(([hint]) => hint), crossOriginAllowedHints: HOST_IDENTITY_HINTS.map(([hint]) => hint) } };
}
function mockSurface(options: IdentitySurfaceOptions): IdentitySurfaceCapture {
  return { context: options.context, observation: { origin: options.origin, secureContext: true, api: "featurePolicy",
    allowedHints: HOST_IDENTITY_HINTS.map(([hint]) => hint), crossOriginAllowedHints: HOST_IDENTITY_HINTS.map(([hint]) => hint) },
    navigator: { status: "captured", identity: navigatorIdentity() }, request: { status: "captured", responseStatus: 200,
      requestUrl: `${options.origin}${options.prefix}echo?context=${options.context}`, negotiation: {
        origin: options.origin, topLevelOrigin: options.topLevelOrigin, secureContext: true, optInResponseReceived: true,
        postOptInRequest: true, permissionsPolicyDelegated: true,
        acceptCH: HOST_IDENTITY_HINTS.map(([hint]) => hint), delegatedHints: HOST_IDENTITY_HINTS.map(([hint]) => hint),
      } } };
}

class MockServer extends EventEmitter {
  listening = false;
  readonly port: number;
  constructor(readonly handler: (request: IncomingMessage, response: ServerResponse) => void, index: number) { super(); this.port = 42000 + index; }
  listen = vi.fn((_port: number, _host: string, done: () => void) => {
    void Promise.resolve().then(() => {
      if (listenFailure && this.port === 42001) { this.emit("error", new Error("Mock second port failed")); return; }
      this.listening = true; this.emit("listening"); done();
    });
    return this;
  });
  close = vi.fn((done?: (error?: Error) => void) => { this.listening = false; done?.(); return this; });
  closeAllConnections = vi.fn();
  address = () => ({ address: "127.0.0.1", family: "IPv4", port: this.port });
}
let servers: MockServer[] = [], listenFailure = false;
function dispatch(server: MockServer, path: string, overrides: Record<string, string> = {}, raw?: string[]) {
  const headers = { host: `127.0.0.1:${server.port}`, "user-agent": navigatorIdentity().userAgent, ...overrides };
  const request = { method: "GET", url: path, headers, rawHeaders: raw || Object.entries(headers).flat() };
  const response = { status: 0, headers: {} as Record<string, string>, body: "",
    writeHead(status: number, values: Record<string, string> = {}) { this.status = status; this.headers = values; return this; },
    end(body = "") { this.body = body; return this; } };
  server.handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  return response;
}
function mockBrowserGlobals(options = surfaceOptions()) {
  const identity = navigatorIdentity();
  vi.stubGlobal("location", { origin: options.origin }); vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("document", { featurePolicy: { allowsFeature: vi.fn(() => true) } });
  vi.stubGlobal("navigator", { userAgent: identity.userAgent, platform: identity.platform, userAgentData: {
    platform: identity.uaPlatform, mobile: identity.mobile, brands: identity.brands,
    getHighEntropyValues: vi.fn(async () => identity.highEntropy),
  } });
}
function httpResponse(url: string, body: string | ReadableStream<Uint8Array>, status = 200, headers: Record<string, string> = {}) {
  const response = new Response(body, { status, headers }); Object.defineProperty(response, "url", { value: url }); return response;
}
async function flushMicrotasks(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); servers = []; listenFailure = false;
  startup.createServer.mockImplementation((_options: unknown, handler: (request: IncomingMessage, response: ServerResponse) => void) => {
    const server = new MockServer(handler, servers.length); servers.push(server); return server;
  });
});
afterEach(() => {
  expect(startup.launch).not.toHaveBeenCalled(); expect(startup.launchPersistentContext).not.toHaveBeenCalled(); expect(startup.execFileSync).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("import-safe, runner-owned loopback fixture (mock HTTP only)", () => {
  it("imports without starting any server and retains provenance/absence warnings", () => {
    expect(startup.createServer).not.toHaveBeenCalled();
    expect(IDENTITY_CAPTURE_WARNINGS).toHaveLength(2);
    expect(IDENTITY_CAPTURE_WARNINGS[0]).toMatch(/independently verify.*PID/);
    expect(IDENTITY_CAPTURE_WARNINGS[1]).toMatch(/absent worker hints are never filled/);
  });
  it("owns two dynamic loopback binds, delegates explicitly, and reuses origins with unique capture paths", async () => {
    const fixture = await startHostIdentityFixture();
    try {
      expect(fixture.origin).toBe(ORIGIN); expect(fixture.crossOrigin).toBe(CROSS);
      for (const server of servers) expect(server.listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
      const first = fixture.beginCapture(), prefix = first.prefix;
      const page = dispatch(servers[0], `${prefix}page`);
      expect(page.status).toBe(200); expect(page.headers["accept-ch"]).toContain("Sec-CH-UA-Full-Version-List");
      expect(page.headers["permissions-policy"]).toContain(`ch-ua-arch=(self "${ORIGIN}" "${CROSS}")`);
      for (const script of ["dedicated.js", "shared.js", "service.js"]) {
        const response = dispatch(servers[0], `${prefix}${script}`);
        expect(response.body).toContain("getHighEntropyValues"); expect(response.body).toContain("capture(o)");
        expect(response.body).not.toContain("postMessage({})");
      }
      expect(dispatch(servers[0], `${prefix}service.js`).headers["service-worker-allowed"]).toBe(`${prefix}service-scope/`);
      expect(dispatch(servers[1], `${prefix}cross-frame`).status).toBe(200);
      first.release();
      const second = fixture.beginCapture(); expect(second.prefix).not.toBe(prefix);
      expect(dispatch(servers[0], `${prefix}page`).status).toBe(404);
      expect(() => fixture.beginCapture()).toThrow(/busy/); second.release();
      for (const server of servers) expect(server.close).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
    for (const server of servers) { expect(server.close).toHaveBeenCalledOnce(); expect(server.closeAllConnections).toHaveBeenCalledOnce(); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([undefined, false, true])("allows GPU blob workers only when the owned fixture opts in (%s)", async (allowBlobWorkers) => {
    const fixture = await startHostIdentityFixture({ allowBlobWorkers });
    try {
      const run = fixture.beginCapture();
      for (const [index, route] of [[0, "page"], [0, "same-frame"], [1, "cross-frame"]] as const) {
        const response = dispatch(servers[index], `${run.prefix}${route}`);
        expect(response.status).toBe(200);
        expect(response.headers["content-security-policy"]).toBe(
          `default-src 'none'; script-src 'self'; worker-src 'self'${allowBlobWorkers ? " blob:" : ""}; connect-src 'self'; frame-src ${ORIGIN} ${CROSS}`,
        );
      }
      run.assertHealthy(); run.release();
    } finally { await fixture.close(); }
  });
  it("closes both owned servers when the second startup fails", async () => {
    listenFailure = true; await expect(startHostIdentityFixture()).rejects.toThrow(/second port failed/);
    expect(servers).toHaveLength(2); for (const server of servers) expect(server.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    ["bad Host", { host: "outside.invalid" }], ["cookies", { cookie: "" }], ["authorization", { authorization: "secret" }],
  ] as const)("rejects %s without retaining credentials", async (_label, headers) => {
    const fixture = await startHostIdentityFixture();
    try { const run = fixture.beginCapture(); expect(dispatch(servers[0], `${run.prefix}echo?context=window`, headers).status).toBe(400);
      expect(run.receipts()).toEqual([]); expect(() => run.assertHealthy()).toThrow(); run.release();
    } finally { await fixture.close(); }
  });
  it("serves only fixed owned paths and fails instead of silently truncating request history", async () => {
    const fixture = await startHostIdentityFixture();
    try { const run = fixture.beginCapture(); expect(dispatch(servers[0], "/outside").status).toBe(404);
      for (let index = 0; index < 64; index++) expect(dispatch(servers[0], `${run.prefix}not-owned`).status).toBe(404);
      expect(dispatch(servers[0], `${run.prefix}page`).status).toBe(429); expect(() => run.assertHealthy()).toThrow(/truncation/); run.release();
    } finally { await fixture.close(); }
  });
});

describe("same self-contained navigator + actual request protocol (mock fetch only)", () => {
  it("waits for opt-in, records raw responses, and observes rather than inventing delegation", async () => {
    const options = surfaceOptions(); mockBrowserGlobals(options);
    let release!: () => void;
    const warm = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error");
      if (url.includes("opt-in")) { await warm; return httpResponse(url, "opt-in", 200, { "accept-ch": HOST_IDENTITY_HINTS.map(([hint]) => hint).join(", "), "permissions-policy": policyHeader() }); }
      return httpResponse(url, JSON.stringify({ requestUrl: url, headers: { "user-agent": "wire-only" }, rawHeaders: ["User-Agent", "wire-only"] }));
    });
    vi.stubGlobal("fetch", fetch);
    const collecting = captureHostIdentitySurface(options);
    await flushMicrotasks(); expect(fetch).toHaveBeenCalledTimes(1);
    release(); const result = await collecting;
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.request.status).toBe("captured");
    expect(result.request.negotiation?.postOptInRequest).toBe(true); expect(result.request.negotiation?.permissionsPolicyDelegated).toBe(true);
    expect(result.observation.api).toBe("featurePolicy"); expect(result.optIn?.headers["permissions-policy"]).toBe(policyHeader());
    expect(result.echoed?.headers["user-agent"]).toBe("wire-only"); expect(result.navigator.identity?.highEntropy?.model).toBe("");
    expect(result.navigator.identity?.highEntropy?.wow64).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["missing-policy-api", "denied-parent-policy", "insecure-worker"])("does not fabricate prerequisites for %s", async (failure) => {
    const options = surfaceOptions(failure === "insecure-worker" ? "service" : "cross-origin-frame"); mockBrowserGlobals(options);
    if (failure === "missing-policy-api") vi.stubGlobal("document", {});
    if (failure === "denied-parent-policy") options.parentObservation!.crossOriginAllowedHints = [];
    if (failure === "insecure-worker") { vi.stubGlobal("isSecureContext", false); vi.stubGlobal("document", undefined); }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => httpResponse(url, url.includes("opt-in") ? "opt-in" : JSON.stringify({ requestUrl: url, headers: {}, rawHeaders: [] }), 200,
      { "accept-ch": HOST_IDENTITY_HINTS.map(([hint]) => hint).join(", "), "permissions-policy": policyHeader() })));
    const result = await captureHostIdentitySurface(options);
    if (failure === "insecure-worker") expect(result.request.negotiation?.secureContext).toBe(false);
    else expect(result.request.negotiation?.permissionsPolicyDelegated).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not classify failed HTTP or malformed echo as missing hints", async () => {
    mockBrowserGlobals();
    const fetch = vi.fn(async (url: string) => httpResponse(url, "failure", 503)); vi.stubGlobal("fetch", fetch);
    const failed = await captureHostIdentitySurface(surfaceOptions());
    expect(failed.request.status).toBe("error"); expect(failed.optIn?.status).toBe(503); expect(failed.echoed).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
    fetch.mockImplementation(async (url: string) => httpResponse(url, "{}", 200, { "accept-ch": "Sec-CH-UA-Arch" }));
    const malformed = await captureHostIdentitySurface(surfaceOptions()); expect(malformed.request.status).toBe("error"); expect(malformed.request.reason).toMatch(/wire receipt/);
  });
  it("fails on oversized streaming responses and aborts deadline-bound fetches", async () => {
    mockBrowserGlobals(); vi.stubGlobal("fetch", vi.fn(async (url: string) => httpResponse(url, new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); controller.close(); } }))));
    expect((await captureHostIdentitySurface(surfaceOptions())).request.reason).toMatch(/truncation/);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const pending = captureHostIdentitySurface(surfaceOptions()); await vi.advanceTimersByTimeAsync(101);
    expect((await pending).request.status).toBe("timeout"); expect(vi.getTimerCount()).toBe(0);
  });
});

class MockPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  peer?: MockPort;
  start = vi.fn(); close = vi.fn();
  postMessage = vi.fn((data: IdentitySurfaceOptions) => { protocol(this, data); });
}
let protocol: (port: MockPort, data: IdentitySurfaceOptions) => void;
function workerMocks(kind: "dedicated" | "shared" | "service") {
  const options: IdentityWorkerOptions = { kind, scriptUrl: `${ORIGIN}/mock-capture/${kind}.js`, scope: `${ORIGIN}/mock-capture/service-scope/`, resourceKey: `/mock-capture/${kind}`, surface: surfaceOptions(kind) };
  const dedicated: (MockPort & { terminate: ReturnType<typeof vi.fn> })[] = [], shared: { port: MockPort }[] = [], channels: { port1: MockPort; port2: MockPort }[] = [];
  protocol = (port, data) => { void Promise.resolve().then(() => port.onmessage?.({ data: { context: data.context, result: mockSurface(data) } })); };
  vi.stubGlobal("Worker", class extends MockPort { onerror = null; terminate = vi.fn(); constructor() { super(); dedicated.push(this); } });
  vi.stubGlobal("SharedWorker", class { onerror = null; port = new MockPort(); constructor() { shared.push(this); } });
  vi.stubGlobal("MessageChannel", class { port1 = new MockPort(); port2 = new MockPort(); constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; channels.push(this); } });
  const active = { scriptURL: options.scriptUrl, state: "activated", addEventListener: vi.fn(), removeEventListener: vi.fn(),
    postMessage: vi.fn((data: IdentitySurfaceOptions, ports: MockPort[]) => protocol(ports[0].peer!, data)) };
  const owned = { scope: options.scope, active, installing: null, waiting: null, unregister: vi.fn(async () => true) };
  const old = { unregister: vi.fn(() => { throw new Error("Must not unregister an old service worker"); }) };
  const serviceWorker = { register: vi.fn(async () => owned), getRegistrations: vi.fn(() => { throw new Error("Must not enumerate old registrations"); }),
    get ready(): never { throw new Error("Must not use unrelated serviceWorker.ready"); } };
  vi.stubGlobal("navigator", { serviceWorker });
  return { options, dedicated, shared, channels, owned, old, serviceWorker };
}

describe("worker/message/timer cleanup falsification (mock workers only)", () => {
  it.each(["dedicated", "shared", "service"] as const)("collects %s in its own protocol and cleans owned resources", async (kind) => {
    const mock = workerMocks(kind), result = await captureHostIdentityWorkerInPage(mock.options);
    expect(result.status).toBe("captured"); expect(result.surface?.context).toBe(kind); expect(result.cleanupErrors).toEqual([]);
    if (kind === "dedicated") expect(mock.dedicated[0].terminate).toHaveBeenCalledOnce();
    if (kind === "shared") expect(mock.shared[0].port.close).toHaveBeenCalledOnce();
    if (kind === "service") {
      expect(mock.owned.unregister).toHaveBeenCalledOnce(); expect(mock.owned.active.removeEventListener).toHaveBeenCalledOnce();
      expect(mock.channels[0].port1.close).toHaveBeenCalledOnce(); expect(mock.channels[0].port2.close).toHaveBeenCalledOnce();
    }
    expect(mock.old.unregister).not.toHaveBeenCalled(); expect(mock.serviceWorker.getRegistrations).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["dedicated", "shared", "service"] as const)("rejects empty %s messages rather than returning {} as success", async (kind) => {
    const mock = workerMocks(kind); protocol = (port) => { void Promise.resolve().then(() => port.onmessage?.({ data: {} })); };
    const result = await captureHostIdentityWorkerInPage(mock.options); expect(result.status).toBe("error"); expect(result.reason).toMatch(/genuine surface/);
    expect(result.surface).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it("terminates a dedicated worker on deadline and clears message handlers/timers", async () => {
    const mock = workerMocks("dedicated"); protocol = () => undefined;
    const pending = captureHostIdentityWorkerInPage(mock.options); await vi.advanceTimersByTimeAsync(101);
    expect((await pending).status).toBe("timeout"); expect(mock.dedicated[0].terminate).toHaveBeenCalledOnce();
    expect(mock.dedicated[0].onmessage).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("unregisters a late, uniquely scoped registration after the deadline, never an old registration", async () => {
    const mock = workerMocks("service"); let resolve!: (value: typeof mock.owned) => void;
    mock.serviceWorker.register.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = captureHostIdentityWorkerInPage(mock.options); await vi.advanceTimersByTimeAsync(2201);
    const result = await pending; expect(result.status).toBe("error"); expect(result.cleanupErrors.join(" ")).toMatch(/deadline/);
    resolve(mock.owned); await flushMicrotasks();
    expect(mock.owned.unregister).toHaveBeenCalledOnce(); expect(mock.old.unregister).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("continues closing the other port and unregistering if one port.close throws", async () => {
    const mock = workerMocks("service");
    const original = mock.owned.active.postMessage.getMockImplementation()!;
    mock.owned.active.postMessage.mockImplementation((data, ports) => { mock.channels[0].port1.close.mockImplementation(() => { throw new Error("Planted port close failure"); }); original(data, ports); });
    const result = await captureHostIdentityWorkerInPage(mock.options);
    expect(result.status).toBe("error"); expect(result.reason).toMatch(/Planted port close/);
    expect(mock.channels[0].port2.close).toHaveBeenCalledOnce(); expect(mock.owned.unregister).toHaveBeenCalledOnce();
  });
  it("refuses to unregister a registration whose returned scope is not the owned unique scope", async () => {
    const mock = workerMocks("service"); mock.owned.scope = `${ORIGIN}/old-scope/`;
    expect((await captureHostIdentityWorkerInPage(mock.options)).status).toBe("error"); expect(mock.owned.unregister).not.toHaveBeenCalled();
  });
});

function collectorPage(fixture: HostIdentityFixture, tamper?: (surface: IdentitySurfaceCapture) => void) {
  let prefix = "", currentUrl = "";
  const collect = (input: IdentitySurfaceOptions): IdentitySurfaceCapture => {
    const server = servers[input.context === "cross-origin-frame" ? 1 : 0];
    const optIn = dispatch(server, `${input.prefix}opt-in?context=${input.context}`), echo = dispatch(server, `${input.prefix}echo?context=${input.context}`);
    const surface = mockSurface(input); surface.optIn = { url: `${input.origin}${input.prefix}opt-in?context=${input.context}`, status: optIn.status, headers: optIn.headers };
    surface.echo = { url: surface.request.requestUrl!, status: echo.status, headers: echo.headers }; surface.echoed = JSON.parse(echo.body); tamper?.(surface); return surface;
  };
  const page = {
    goto: vi.fn(async (url: string) => { currentUrl = url; prefix = new URL(url).pathname.replace(/page$/, ""); return { ok: () => true }; }),
    url: () => currentUrl,
    evaluate: vi.fn(async (fn: (...args: any[]) => any, input: any) => {
      if (fn === captureHostIdentitySurface) return collect(input);
      if (fn === captureHostIdentityWorkerInPage) return { status: "captured", surface: collect(input.surface), cleanupErrors: [] };
      return undefined;
    }),
    frame: vi.fn(({ name }: { name: string }) => { const cross = name.endsWith("cross"); return { url: () => `${cross ? fixture.crossOrigin : fixture.origin}${prefix}${cross ? "cross" : "same"}-frame`, evaluate: vi.fn(async (_fn, input) => collect(input)) }; }),
  };
  return page;
}

describe("full collector binding, server receipts and caller-owned lifetime (mock Page only)", () => {
  it("rejects an unowned/external fixture before invoking Page navigation", async () => {
    const page = { goto: vi.fn() }, unowned = { origin: "https://outside.invalid", crossOrigin: CROSS } as HostIdentityFixture;
    await expect(captureFullHostIdentity(page as unknown as Page, { fixture: unowned, binding })).rejects.toThrow(/owned two-loopback-port fixture/);
    expect(page.goto).not.toHaveBeenCalled(); expect(startup.createServer).not.toHaveBeenCalled();
  });
  it("records all six surfaces, server-receipt omissions and warnings without inventing UA-CH", async () => {
    const fixture = await startHostIdentityFixture(), page = collectorPage(fixture);
    try {
      const result = await captureFullHostIdentity(page as unknown as Page, { fixture, binding });
      expect(result.binding).toEqual(binding); expect(result.binding).not.toBe(binding); expect(result.captureEvidence.warnings).toEqual(IDENTITY_CAPTURE_WARNINGS);
      expect(Object.keys(result.navigators!)).toHaveLength(6); expect(result.captureEvidence.wire).toHaveLength(12);
      expect(result.requestHeaders.service.userAgent).toBe(navigatorIdentity().userAgent); expect(result.requestHeaders.service.uaArchitecture).toBeNull();
      expect(result.worker.highEntropy?.architecture).toBe("x86"); expect(result.requestHeaders["cross-origin-frame"]?.uaBrands).toBeNull();
      for (const value of Object.values(result.requestEvidence!)) { expect(value?.status).toBe("captured"); expect(value?.responseStatus).toBe(200); }
      expect(page.frame).toHaveBeenCalledTimes(2); for (const server of servers) expect(server.close).not.toHaveBeenCalled();
      const again = await captureFullHostIdentity(page as unknown as Page, { fixture, binding: { ...binding, identityMode: "off", pid: 322, profileId: "other-mock-profile" } });
      expect(again.requestEvidence?.service?.negotiation).toEqual(result.requestEvidence?.service?.negotiation);
      expect(again.requestEvidence?.service?.requestUrl).not.toBe(result.requestEvidence?.service?.requestUrl);
    } finally { await fixture.close(); }
  });
  it("rejects fabricated browser echo and retains incomplete evidence, without closing runner servers", async () => {
    const fixture = await startHostIdentityFixture(), page = collectorPage(fixture, (surface) => { if (surface.context === "shared") surface.echoed!.headers["user-agent"] = "Planted fake wire UA"; });
    try {
      const error = await captureFullHostIdentity(page as unknown as Page, { fixture, binding }).then(() => undefined, (failure) => failure);
      expect(error).toBeInstanceOf(HostIdentityCaptureError); expect(error.evidence.requestEvidence.shared.status).toBe("error");
      expect(error.evidence.requestHeaders.shared).toBeUndefined(); expect(error.evidence.captureEvidence.wire).toHaveLength(12);
      expect(page.evaluate.mock.calls.some(([fn]) => fn === cleanupHostIdentityInPage)).toBe(true);
      for (const server of servers) expect(server.close).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });
  it("retains frame failures rather than relabeling missing Frames as captured", async () => {
    const fixture = await startHostIdentityFixture(), page = collectorPage(fixture); page.frame.mockReturnValue(null as never);
    try { const result = await captureFullHostIdentity(page as unknown as Page, { fixture, binding });
      expect(result.navigators?.["cross-origin-frame"]?.status).toBe("error"); expect(result.requestHeaders["cross-origin-frame"]).toBeUndefined();
    } finally { await fixture.close(); }
  });
  it("cleans/releases its own capture on navigation failure, leaving fixture ownership with the runner", async () => {
    const fixture = await startHostIdentityFixture(), page = collectorPage(fixture); page.goto.mockRejectedValue(new Error("Planted navigation failure"));
    try { await expect(captureFullHostIdentity(page as unknown as Page, { fixture, binding })).rejects.toThrow(/Planted navigation/);
      const next = fixture.beginCapture(); next.release(); for (const server of servers) expect(server.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { await fixture.close(); }
  });
  it("executes the compiled frame attachment function with a planted append failure and clears both timers", async () => {
    const fixture = await startHostIdentityFixture(), page = collectorPage(fixture);
    try {
      await captureFullHostIdentity(page as unknown as Page, { fixture, binding });
      const call = page.evaluate.mock.calls.find(([fn]) => fn !== captureHostIdentitySurface && fn !== captureHostIdentityWorkerInPage && fn !== cleanupHostIdentityInPage)!;
      const elements = new Map<string, any>(), created: any[] = [];
      const old = { tagName: "IFRAME", src: `${ORIGIN}/old`, remove: vi.fn() }; elements.set("old-unrelated", old);
      vi.stubGlobal("document", {
        getElementById: (id: string) => elements.get(id),
        createElement: () => { const frame = { id: "", name: "", src: "", allow: "", tagName: "IFRAME", onload: null as null | (() => void), onerror: null, remove: vi.fn() };
          frame.remove.mockImplementation(() => { elements.delete(frame.id); }); created.push(frame); return frame; },
        body: { appendChild: (frame: any) => {
          if (frame.id.endsWith("cross")) throw new Error("Planted frame append failure");
          elements.set(frame.id, frame); void Promise.resolve().then(() => frame.onload?.());
        } },
      });
      await expect(call[0](call[1])).rejects.toThrow(/Planted frame append failure/);
      expect(created).toHaveLength(2); expect(created[0].allow).toContain(`ch-ua-arch ${ORIGIN} ${CROSS}`);
      await cleanupHostIdentityInPage({ prefix: call[1].prefix, origin: fixture.origin, crossOrigin: fixture.crossOrigin });
      for (const frame of created) expect(frame.remove).toHaveBeenCalledOnce();
      expect(old.remove).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { await fixture.close(); }
  });
  it("removes only own exact-URL frames and attempts all own cleanups despite a planted failure", async () => {
    const prefix = "/own/", owned = { tagName: "IFRAME", src: `${ORIGIN}${prefix}same-frame`, remove: vi.fn() };
    const unrelated = { tagName: "IFRAME", src: `${ORIGIN}/old-frame`, remove: vi.fn() };
    vi.stubGlobal("document", { getElementById: (id: string) => id === `${prefix}same` ? owned : unrelated });
    const one = vi.fn(async () => { throw new Error("Planted cleanup failure"); }), two = vi.fn(async () => undefined);
    vi.stubGlobal(`${prefix}dedicated`, { cleanup: one }); vi.stubGlobal(`${prefix}shared`, { cleanup: two });
    await expect(cleanupHostIdentityInPage({ prefix, origin: ORIGIN, crossOrigin: CROSS })).rejects.toThrow(/Planted cleanup/);
    expect(one).toHaveBeenCalledOnce(); expect(two).toHaveBeenCalledOnce(); expect(owned.remove).toHaveBeenCalledOnce(); expect(unrelated.remove).not.toHaveBeenCalled();
  });
});

const VERSION_SPAN_SELECTOR = "#version > span#copy-content > span:first-child";
interface VersionDomOptions { nested?: string[]; elementCount?: number; childElementCount?: number; outerHTML?: string }
function versionMocks(direct: { nodeType: number; textContent: string }[] | null, product = `Chrome/${VERSION}`, options: VersionDomOptions = {}) {
  // A plausible matching body must not rescue a missing/wrong canonical element.
  const bodyRead = vi.fn(() => VERSION);
  const raw = direct && { childNodes: direct, textContent: direct.map((node) => node.textContent).join(""), outerHTML: options.outerHTML ?? "<td id=version>bounded mock raw element</td>" };
  const candidates = (options.nested ?? []).map((textContent) => ({ textContent, outerHTML: `<span>${textContent}</span>`, childElementCount: options.childElementCount ?? 0 }));
  vi.stubGlobal("document", {
    querySelector: vi.fn((selector: string) => { expect(selector).toBe("#version"); return raw; }),
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === "#version") return raw ? Array(options.elementCount ?? 1).fill(raw) : [];
      expect(selector).toBe(VERSION_SPAN_SELECTOR); return raw ? candidates : [];
    }),
    body: { get innerText() { return bodyRead(); } },
  });
  const versionPage = { goto: vi.fn(async () => undefined), evaluate: vi.fn(async (fn: () => unknown) => fn()), close: vi.fn(async () => undefined) };
  const session = { send: vi.fn(async () => ({ product, userAgent: "Another-observed-UA-not-a-version-oracle" })), detach: vi.fn(async () => undefined) };
  const context = { newPage: vi.fn(async () => versionPage), newCDPSession: vi.fn(async () => session) };
  return { context, versionPage, session, bodyRead };
}
function nestedVersionMock(options: VersionDomOptions = {}, product = `Chrome/${VERSION}`) {
  const nested = options.nested ?? [VERSION], text = nested[0] ?? "";
  // User-observed Chromium 152 DOM shape, replayed by fake Page only, not browser acceptance.
  const outerHTML = `<td id="version">\n  <span id="copy-content"><span>${text}</span>(<span>正式版本</span>)<span></span><span>(arm64)</span></span>\n  <button>复制</button>\n</td>`;
  return versionMocks([{ nodeType: 3, textContent: "\n  " }, { nodeType: 1, textContent: `${text}(正式版本)(arm64)` },
    { nodeType: 3, textContent: "\n  " }, { nodeType: 1, textContent: "复制" }, { nodeType: 3, textContent: "\n" }], product, { ...options, nested, outerHTML });
}

describe("compiled version collector exports (fake Page, never a browser)", () => {
  it("extracts legacy direct Text children and preserves the bounded raw element", async () => {
    const mock = versionMocks([{ nodeType: 3, textContent: ` ${VERSION} ` }, { nodeType: 1, textContent: "(Official Build) (arm64)" }]);
    const result = await captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page);
    expect(result.productVersion).toBe(VERSION); expect(result.versionElement).toBe(VERSION); expect(result.chromeVersionText).toBe(VERSION);
    expect(result.rawVersionElement.textContent).toContain("Official Build"); expect(result.rawVersionElement.directTextNodes).toEqual([` ${VERSION} `]);
    expect(result.rawVersionElement.versionTextSource).toBe("#version (direct Text nodes)");
    expect(result.versionElementSource).toBe("chrome://version#version"); expect(mock.bodyRead).not.toHaveBeenCalled();
    expect(mock.versionPage.close).toHaveBeenCalledOnce(); expect(mock.session.detach).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("captures the Chromium 152 nested version span with whitespace-only td Text nodes", async () => {
    const mock = nestedVersionMock();
    const result = await captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page);
    expect(result.product).toBe(`Chrome/${VERSION}`); expect(result.productVersion).toBe(VERSION);
    expect(result.versionElement).toBe(VERSION); expect(result.chromeVersionText).toBe(VERSION);
    expect(result.rawVersionElement).toMatchObject({ elementCount: 1, truncated: false,
      directTextNodes: ["\n  ", "\n  ", "\n"], versionTextSource: VERSION_SPAN_SELECTOR, versionTextSelector: VERSION_SPAN_SELECTOR,
      versionTextCandidateCount: 1, versionTextCandidates: [{ textContent: VERSION, outerHTML: `<span>${VERSION}</span>`, childElementCount: 0 }] });
    expect(result.rawVersionElement.outerHTML).toBe(`<td id="version">\n  <span id="copy-content"><span>${VERSION}</span>(<span>正式版本</span>)<span></span><span>(arm64)</span></span>\n  <button>复制</button>\n</td>`);
    expect(result.rawVersionElement.textContent).toBe(`\n  ${VERSION}(正式版本)(arm64)\n  复制\n`);
    expect(mock.versionPage.goto).toHaveBeenCalledWith("chrome://version/", { waitUntil: "domcontentloaded", timeout: 10_000 });
    expect(mock.session.send).toHaveBeenCalledWith("Browser.getVersion"); expect(mock.bodyRead).not.toHaveBeenCalled();
    expect(mock.versionPage.close).toHaveBeenCalledOnce(); expect(mock.session.detach).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { direct: null }, { direct: [{ nodeType: 3, textContent: "151.0.1.2" }] }, { direct: [{ nodeType: 3, textContent: " \n\t" }] },
    { direct: [{ nodeType: 1, textContent: VERSION }] }, { direct: [{ nodeType: 3, textContent: `${VERSION} trailing` }] },
  ])("rejects body-only/wrong/arbitrary-nested/noncanonical version evidence %#", async ({ direct }) => {
    const mock = versionMocks(direct);
    const failure = await captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page).then(() => undefined, (error) => error);
    expect(failure).toBeInstanceOf(VersionIdentityCaptureError); expect(failure.evidence.rawVersionElement).toBeDefined(); expect(mock.bodyRead).not.toHaveBeenCalled();
    expect(mock.versionPage.close).toHaveBeenCalledOnce(); expect(mock.session.detach).toHaveBeenCalledOnce();
  });
  it.each([
    ["no exact child", { nested: [] }], ["blank child", { nested: [" \n\t"] }],
    ["duplicate candidates", { nested: [VERSION, VERSION] }], ["suffix", { nested: [`${VERSION} trailing`] }],
    ["product token", { nested: [`Chrome/${VERSION}`] }], ["two tuples", { nested: [`${VERSION} 153.0.8000.1`] }],
    ["non-leaf child", { childElementCount: 1 }], ["duplicate root", { elementCount: 2 }],
    ["oversized child", { nested: ["x".repeat(1025)] }], ["candidate budget", { nested: [VERSION, VERSION, VERSION] }],
  ] as [string, VersionDomOptions][])("rejects %s without body/product recovery and cleans up", async (_label, options) => {
    const mock = nestedVersionMock(options);
    const failure = await captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page).then(() => undefined, (error) => error);
    expect(failure).toBeInstanceOf(VersionIdentityCaptureError); expect(failure.evidence.product).toBe(`Chrome/${VERSION}`);
    const raw = failure.evidence.rawVersionElement;
    expect(raw.versionTextSelector).toBe(VERSION_SPAN_SELECTOR); expect(raw.versionTextCandidates.length).toBeLessThanOrEqual(2);
    if (options.nested && options.nested.length > 2) { expect(raw.truncated).toBe(true); expect(raw.versionTextCandidateCount).toBe(3); }
    if ((options.nested?.[0]?.length ?? 0) > 1024) { expect(raw.truncated).toBe(true); expect(raw.versionTextCandidates[0].textContent).toHaveLength(1024); }
    expect(mock.bodyRead).not.toHaveBeenCalled(); expect(mock.versionPage.close).toHaveBeenCalledOnce(); expect(mock.session.detach).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects competing direct and exact nested version sources, even when they agree", async () => {
    const mock = versionMocks([{ nodeType: 3, textContent: VERSION }], `Chrome/${VERSION}`, { nested: [VERSION] });
    await expect(captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page)).rejects.toBeInstanceOf(VersionIdentityCaptureError);
  });
  it("rejects a different product version rather than overwriting the nested element", async () => {
    const mock = nestedVersionMock({}, "Chrome/153.0.8000.1");
    const failure = await captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page).then(() => undefined, (error) => error);
    expect(failure).toBeInstanceOf(VersionIdentityCaptureError); expect(failure.message).toContain("disagree");
    expect(failure.evidence.product).toBe("Chrome/153.0.8000.1"); expect(failure.evidence.rawVersionElement.versionTextCandidates[0].textContent).toBe(VERSION);
    expect(mock.versionPage.close).toHaveBeenCalledOnce(); expect(mock.session.detach).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([`Chrome/${VERSION}-suffix`, `Unknown/${VERSION}`, `Chrome/1${VERSION}`, `Chrome/${VERSION} extra`])("does not accept product substring or unknown-label %s", async (product) => {
    const mock = versionMocks([{ nodeType: 3, textContent: VERSION }], product);
    await expect(captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page)).rejects.toBeInstanceOf(VersionIdentityCaptureError);
  });
  it("rejects oversized raw element evidence rather than silently truncating", async () => {
    const mock = versionMocks([{ nodeType: 3, textContent: VERSION }, { nodeType: 1, textContent: "x".repeat(8193) }]);
    const failure = await captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page).then(() => undefined, (error) => error);
    expect(failure.evidence.rawVersionElement.truncated).toBe(true); expect(failure.evidence.rawVersionElement.textContent.length).toBe(8192);
  });
  it.each(["session", "page"] as const)("cleans a late version %s acquisition after its deadline", async (kind) => {
    const mock = versionMocks([{ nodeType: 3, textContent: VERSION }]);
    let release!: () => void;
    if (kind === "session") mock.context.newCDPSession.mockImplementation(() => new Promise((resolve) => { release = () => resolve(mock.session); }));
    else mock.context.newPage.mockImplementation(() => new Promise((resolve) => { release = () => resolve(mock.versionPage); }));
    const pending = captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page).then(() => undefined, (failure) => failure);
    await flushMicrotasks(); await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toBeInstanceOf(VersionIdentityCaptureError); release(); await flushMicrotasks();
    expect(mock.session.detach).toHaveBeenCalledOnce();
    if (kind === "page") expect(mock.versionPage.close).toHaveBeenCalledOnce();
    else expect(mock.context.newPage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["page", "session"] as const)("reports %s cleanup failures instead of swallowing them", async (kind) => {
    const mock = nestedVersionMock();
    (kind === "page" ? mock.versionPage.close : mock.session.detach).mockRejectedValue(new Error("Planted version cleanup failure"));
    const failure = await captureVersionIdentity(mock.context as unknown as BrowserContext, {} as Page).then(() => undefined, (error) => error);
    expect(failure.evidence.cleanupErrors.join(" ")).toMatch(/Planted version cleanup/);
    expect(mock.versionPage.close).toHaveBeenCalledOnce(); expect(mock.session.detach).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
