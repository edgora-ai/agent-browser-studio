// Stage 3 AUTHOR-ONLY feature preparation. Intended modules may not exist yet.
// UNRUN: missing imports are not an existing-product RED. Only the coordinator's
// later source-stable unit window may execute this file. No real HTTP/WS/DNS,
// children, app, browser, user config, storage or credentials are used here.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkObservationPayload } from "../../src/main/services/network-diagnostics-contract.js";

// The fixture deliberately supports both ordinary node:http discovery and fetch
// discovery, but neither can leave memory. Both accept the exact same bounded
// JSON wire; there are no alternate DTOs or schema fallbacks.
const wire = vi.hoisted(() => {
  const { EventEmitter } = require("node:events");
  const PRIVATE = "__NETWORK_PRIVATE_SENTINEL__";
  const PORT = 47161; // Inert test authority, never listened on or contacted.
  const TARGET = "selected-target-not-a-frame", ROOT = "actual-selected-root-frame", LOADER = "selected-root-loader";
  const ORIGIN = "https://site-a.fixture.test";
  type Command = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string; socket: Socket };
  const forbidden = vi.fn(() => { throw new Error("UNDECLARED_OBSERVER_CAPABILITY"); });
  const state = {
    active: false,
    sockets: [] as Socket[], commands: [] as Command[], http: [] as { url: string; method: string; destroyed: boolean }[],
    held: new Set<string>(), autoOpen: true, closeAck: true, terminateAck: true,
    holdDiscovery: false, discoveryStatus: 200, discoveryBody: "[]", discoveryChunks: null as string[] | null,
    pendingDiscovery: [] as (() => void)[],
    frame: {} as Record<string, unknown>,
    beforeAutoReply: undefined as undefined | ((command: Command) => void),
  };
  class Socket extends EventEmitter {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = Socket.CONNECTING;
    closeCalls = 0; terminateCalls = 0;
    constructor(readonly url: string, readonly options?: unknown) {
      super();
      if (!state.active) forbidden();
      state.sockets.push(this);
      if (state.autoOpen) queueMicrotask(() => this.open());
    }
    open() {
      if (this.readyState !== Socket.CONNECTING) return;
      this.readyState = Socket.OPEN; this.emit("open");
    }
    send(raw: string | Buffer, callback?: (error?: Error) => void) {
      if (this.readyState !== Socket.OPEN) throw new Error("FIXTURE_SOCKET_NOT_OPEN");
      const parsed = JSON.parse(String(raw));
      const command: Command = { ...parsed, socket: this };
      state.commands.push(command);
      callback?.();
      if (state.held.has(command.method)) return;
      queueMicrotask(() => {
        if (this.readyState !== Socket.OPEN) return;
        state.beforeAutoReply?.(command);
        this.reply(command, command.method === "Page.getFrameTree" ? { frameTree: { frame: state.frame, childFrames: [{ frame: { id: "child-frame", parentId: ROOT, url: `https://child.fixture.test/${PRIVATE}` } }] } } : {});
      });
    }
    reply(command: Command, result: unknown = {}) { this.deliver({ id: command.id, result }); }
    reject(command: Command, message = PRIVATE) { this.deliver({ id: command.id, error: { code: -32601, message, data: { raw: PRIVATE } } }); }
    deliver(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
    raw(value: string | Buffer) { this.emit("message", Buffer.isBuffer(value) ? value : Buffer.from(value), false); }
    event(method: string, params: unknown, sessionId?: string) { this.deliver({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }); }
    close() {
      this.closeCalls++; if (this.readyState === Socket.CLOSED) return;
      this.readyState = Socket.CLOSING;
      if (state.closeAck) queueMicrotask(() => this.serverClose());
    }
    terminate() {
      this.terminateCalls++;
      if (state.terminateAck) queueMicrotask(() => this.serverClose());
    }
    serverClose() {
      if (this.readyState === Socket.CLOSED) return;
      this.readyState = Socket.CLOSED; this.emit("close", 1000, Buffer.from(PRIVATE));
    }
  }
  function discoveryCall(input: unknown, options?: Record<string, unknown>) {
    if (!state.active) forbidden();
    let url: URL;
    if (typeof input === "string" || input instanceof URL) url = new URL(String(input));
    else {
      const value = input as Record<string, unknown>;
      url = new URL(`${String(value.protocol ?? "http:")}//${String(value.hostname ?? value.host)}:${String(value.port)}${String(value.path ?? "/")}`);
    }
    const method = String(options?.method ?? (input && typeof input === "object" ? (input as Record<string, unknown>).method ?? "GET" : "GET"));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== String(PORT) || !["/json", "/json/list"].includes(url.pathname) || url.search || url.hash || url.username || url.password || method !== "GET" || options?.body) forbidden();
    const call = { url: url.href, method, destroyed: false }; state.http.push(call); return call;
  }
  function scheduleDiscovery(deliver: () => void) {
    if (state.holdDiscovery) state.pendingDiscovery.push(deliver); else queueMicrotask(deliver);
  }
  function request(input: unknown, optionsOrCallback?: unknown, callback?: (response: unknown) => void) {
    const options = typeof optionsOrCallback === "object" && optionsOrCallback !== null ? optionsOrCallback as Record<string, unknown> : undefined;
    const onResponse = typeof optionsOrCallback === "function" ? optionsOrCallback as (response: unknown) => void : callback;
    const call = discoveryCall(input, options);
    const req = new EventEmitter(); let ended = false; let timer: ReturnType<typeof setTimeout> | undefined;
    req.setTimeout = (ms: number, handler?: () => void) => { timer = setTimeout(() => { req.emit("timeout"); handler?.(); }, ms); return req; };
    req.destroy = () => { call.destroyed = true; if (timer) clearTimeout(timer); req.emit("close"); return req; };
    req.abort = req.destroy;
    req.write = forbidden;
    req.end = () => {
      if (ended) return; ended = true;
      scheduleDiscovery(() => {
        if (timer) clearTimeout(timer);
        const response = new EventEmitter();
        response.statusCode = state.discoveryStatus;
        response.headers = { "content-type": "application/json", "x-private": PRIVATE, location: `https://outside.fixture.test/${PRIVATE}` };
        response.setEncoding = () => response;
        response.destroy = () => { call.destroyed = true; response.emit("close"); return response; };
        response.resume = () => response;
        onResponse?.(response); req.emit("response", response);
        queueMicrotask(() => {
          for (const chunk of state.discoveryChunks ?? [state.discoveryBody]) response.emit("data", Buffer.from(chunk));
          response.emit("end"); response.emit("close");
        });
      });
      return req;
    };
    return req;
  }
  function get(input: unknown, optionsOrCallback?: unknown, callback?: (response: unknown) => void) {
    const req = request(input, optionsOrCallback, callback); req.end(); return req;
  }
  function fetchDiscovery(input: unknown, options?: Record<string, unknown>) {
    const call = discoveryCall(input, options);
    // Deliberately do not honor abort for the underlying delivery: the observer
    // must reject a late successful await itself, not trust cancellation magic.
    return new Promise<Response>((resolve, reject) => scheduleDiscovery(() => {
      try {
        // Native fetch follows redirects before returning its Response. A fake
        // 302 must not accidentally bless the unsafe default-follow behavior.
        if (state.discoveryStatus >= 300 && state.discoveryStatus < 400 && options?.redirect !== "manual" && options?.redirect !== "error") forbidden();
        const body = state.discoveryChunks ? state.discoveryChunks.join("") : state.discoveryBody;
        const response = new Response(body, { status: state.discoveryStatus, headers: { "content-type": "application/json", "x-private": PRIVATE, location: `https://outside.fixture.test/${PRIVATE}` } });
        options?.signal && (options.signal as AbortSignal).addEventListener("abort", () => { call.destroyed = true; }, { once: true });
        resolve(response);
      } catch (error) { reject(error); }
    }));
  }
  // Install before importing the intended module, not just in beforeEach: even
  // an accidental import-time call must be unable to use native fetch/WS.
  vi.stubGlobal("fetch", fetchDiscovery);
  vi.stubGlobal("WebSocket", forbidden);
  return { PRIVATE, PORT, TARGET, ROOT, LOADER, ORIGIN, state, Socket, forbidden, request, get, fetchDiscovery };
});

vi.mock("ws", () => ({ default: wire.Socket, WebSocket: wire.Socket }));
vi.mock("node:http", () => { const api = { get: wire.get, request: wire.request, createServer: wire.forbidden }; return { ...api, default: api }; });
vi.mock("node:https", () => { const api = { get: wire.forbidden, request: wire.forbidden, createServer: wire.forbidden }; return { ...api, default: api }; });
vi.mock("node:net", async original => {
  const actual = await original<typeof import("node:net")>();
  const api = { isIP: actual.isIP, isIPv4: actual.isIPv4, isIPv6: actual.isIPv6, connect: wire.forbidden, createConnection: wire.forbidden, createServer: wire.forbidden, Socket: wire.forbidden, Server: wire.forbidden };
  return { ...api, default: api };
});
vi.mock("node:dns", () => ({ lookup: wire.forbidden, resolve: wire.forbidden, resolve4: wire.forbidden, resolve6: wire.forbidden }));
vi.mock("node:dns/promises", () => ({ lookup: wire.forbidden, resolve: wire.forbidden, resolve4: wire.forbidden, resolve6: wire.forbidden }));
vi.mock("node:child_process", () => ({ spawn: wire.forbidden, spawnSync: wire.forbidden, exec: wire.forbidden, execSync: wire.forbidden, execFile: wire.forbidden, execFileSync: wire.forbidden, fork: wire.forbidden }));
vi.mock("node:fs", () => ({ readFileSync: wire.forbidden, writeFileSync: wire.forbidden, mkdirSync: wire.forbidden, mkdtempSync: wire.forbidden, statSync: wire.forbidden, promises: { readFile: wire.forbidden, writeFile: wire.forbidden, mkdir: wire.forbidden } }));
vi.mock("node:fs/promises", () => ({ readFile: wire.forbidden, writeFile: wire.forbidden, mkdir: wire.forbidden, mkdtemp: wire.forbidden }));
vi.mock("electron", () => ({ app: { getPath: wire.forbidden }, ipcMain: { handle: wire.forbidden } }));
vi.mock("../../src/main/services/config-manager.js", () => { throw new Error("OBSERVER_CONFIG_IMPORT_FORBIDDEN"); });
vi.mock("../../src/main/services/browser/runtime-table.js", () => { throw new Error("OBSERVER_RUNTIME_IMPORT_FORBIDDEN"); });
vi.mock("../../src/main/services/browser-manager.js", () => { throw new Error("OBSERVER_BROWSER_MANAGER_IMPORT_FORBIDDEN"); });
vi.mock("../../src/main/services/local-agent.js", () => { throw new Error("OBSERVER_LOCAL_AGENT_IMPORT_FORBIDDEN"); });
vi.mock("../../src/main/services/agent/cdp-transport.js", () => ({ cdpConnect: wire.forbidden, getOrConnectCdp: wire.forbidden, cdpDisconnect: wire.forbidden, cdpSendRaw: wire.forbidden }));

import { listNetworkPageTargets, createNetworkPageObserver } from "../../src/main/services/browser/cdp-network-observer.js";
import { NETWORK_OBSERVATION_LIMITS as LIMITS, normalizeNetworkObservationSummary } from "../../src/main/services/network-diagnostics-contract.js";

const { PRIVATE, PORT, TARGET, ROOT, LOADER, ORIGIN } = wire;
const AT = 1_792_387_200_000;
const THIRD_PARTY = "https://third-party.fixture.test:8443";
const NATIVE = `${PRIVATE}-native-request-chain`;
const COUNT_KEYS = ["requests", "hops", "responses", "finished", "failed", "blocked", "requestCancelled", "redirects", "http4xx", "http5xx", "pending", "cache", "serviceWorker", "unattributed", "cspIssues"];
const SUMMARY_KEYS = ["version", "completion", "stopReason", "armedAt", "endedAt", "durationMs", "counts", "coverage"];
const HOP_KEYS = ["id", "chainId", "redirectedFrom", "origin", "method", "resourceType", "status", "networkStatus", "terminal", "errorCode", "blockedReason", "corsReason", "fromDiskCache", "fromServiceWorker", "fromPrefetchCache", "servedFromCache"];
const EVIDENCE_KEYS = ["id", "chainId", "hopId", "status", "source", "association"];
const PASSIVE_COMMANDS = ["Page.enable", "Network.enable", "Page.getFrameTree", "Audits.enable"];
const target = () => ({ id: TARGET, origin: ORIGIN, webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/${TARGET}` });
const keys = (value: object) => Reflect.ownKeys(value).map(String).sort();

type Handle = ReturnType<typeof createNetworkPageObserver>;
function watch<T>(promise: Promise<T>) {
  const result = { state: "pending" as "pending" | "fulfilled" | "rejected", value: undefined as T | undefined, error: undefined as unknown };
  void promise.then(value => { result.state = "fulfilled"; result.value = value; }, error => { result.state = "rejected"; result.error = error; });
  return result;
}
const runs: { handle: Handle; controller: AbortController }[] = [];
async function flush() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }
function start(selected = target(), controller = new AbortController(), assertCurrent: () => void = vi.fn(() => undefined), deadline = Date.now() + LIMITS.setupMs, port = PORT) {
  const onArmed = vi.fn((_notice: { armedAt: number; observeForMs: 10000 }) => undefined);
  // Synchronous internal handle is intentional: the owner needs `closed` even
  // while HTTP/WS/setup is pending. This is NOT a renderer start/poll job API.
  const handle = createNetworkPageObserver(port, selected, { signal: controller.signal, assertCurrent, onArmed, deadline });
  expect(handle.result).toBeInstanceOf(Promise); expect(handle.closed).toBeInstanceOf(Promise);
  expect(typeof handle.cleanupVerified).toBe("boolean");
  const result = watch(handle.result), closed = watch(handle.closed);
  runs.push({ handle, controller });
  return { handle, result, closed, controller, assertCurrent, onArmed };
}
type Run = ReturnType<typeof start>;
async function arm() {
  const run = start(); await flush();
  expect(run.onArmed).toHaveBeenCalledExactlyOnceWith({ armedAt: AT, observeForMs: 10000 }); expect(run.result.state).toBe("pending");
  expect(run.handle.cleanupVerified).toBe(false);
  expect(wire.state.sockets).toHaveLength(1);
  return run;
}
function socket() { expect(wire.state.sockets).toHaveLength(1); return wire.state.sockets[0]; }
function command(method: string) {
  const found = wire.state.commands.find(value => value.method === method);
  expect(found).toBeDefined(); return found!;
}
function assertSafe(payload: NetworkObservationPayload) {
  expect(keys(payload).sort()).toEqual(["httpStatusEvidence", "hops", "observation"].sort());
  expect(keys(payload.observation)).toEqual([...SUMMARY_KEYS].sort());
  expect(keys(payload.observation.counts)).toEqual([...COUNT_KEYS].sort());
  expect(payload.observation.coverage).toMatchObject({ worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" });
  expect(normalizeNetworkObservationSummary(payload.observation)).toEqual(payload.observation);
  const serialized = JSON.stringify(payload);
  for (const discarded of [PRIVATE, TARGET, ROOT, LOADER]) expect(serialized).not.toContain(discarded);
  expect(Buffer.byteLength(JSON.stringify({ hops: payload.hops, httpStatusEvidence: payload.httpStatusEvidence }))).toBeLessThanOrEqual(LIMITS.maxDetailBytes);
  expect(payload.hops.length).toBeLessThanOrEqual(LIMITS.maxHops);
  expect(payload.hops.length + payload.httpStatusEvidence.length).toBeLessThanOrEqual(LIMITS.maxProjections);
  const inventory = new Map(payload.hops.map(hop => [hop.id, hop]));
  expect(inventory.size).toBe(payload.hops.length);
  const c = payload.observation.counts;
  expect(c.requests).toBe(payload.hops.length); expect(c.hops).toBe(payload.hops.length);
  expect(c.finished + c.failed + c.blocked + c.requestCancelled + c.redirects + c.pending).toBe(c.hops);
  for (const [count, terminal] of [["finished", "finished"], ["failed", "failed"], ["blocked", "blocked"], ["requestCancelled", "cancelled"], ["redirects", "redirected"], ["pending", "pending"]] as const) expect(c[count]).toBe(payload.hops.filter(hop => hop.terminal === terminal).length);
  expect(c.responses).toBe(payload.hops.filter(hop => hop.status !== null || hop.networkStatus !== null).length);
  expect(c.http4xx).toBe(payload.hops.filter(hop => [hop.status, hop.networkStatus].some(status => status !== null && status >= 400 && status < 500)).length);
  expect(c.http5xx).toBe(payload.hops.filter(hop => [hop.status, hop.networkStatus].some(status => status !== null && status >= 500 && status < 600)).length);
  expect(c.cache).toBe(payload.hops.filter(hop => hop.servedFromCache || hop.fromDiskCache === true || hop.fromPrefetchCache === true).length);
  expect(c.serviceWorker).toBe(payload.hops.filter(hop => hop.fromServiceWorker === true).length);
  for (const hop of payload.hops) {
    expect(keys(hop)).toEqual([...HOP_KEYS].sort());
    expect(typeof hop.id).toBe("string"); expect(hop.id.length).toBeGreaterThan(0);
    expect(typeof hop.chainId).toBe("string"); expect(hop.chainId.length).toBeGreaterThan(0);
    if (hop.redirectedFrom !== null) { expect(inventory.has(hop.redirectedFrom)).toBe(true); expect(inventory.get(hop.redirectedFrom)!.chainId).toBe(hop.chainId); }
    const origin = new URL(hop.origin);
    expect(["http:", "https:"]).toContain(origin.protocol);
    expect(hop.origin).toBe(origin.origin); expect(origin.username).toBe(""); expect(origin.password).toBe("");
    expect(origin.pathname).toBe("/"); expect(origin.search).toBe(""); expect(origin.hash).toBe("");
    expect(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "OTHER"]).toContain(hop.method);
    expect(["Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket", "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "FedCM", "Other"]).toContain(hop.resourceType);
    for (const status of [hop.status, hop.networkStatus]) if (status !== null) { expect(Number.isInteger(status)).toBe(true); expect(status).toBeGreaterThanOrEqual(100); expect(status).toBeLessThanOrEqual(599); }
    for (const flag of [hop.fromDiskCache, hop.fromServiceWorker, hop.fromPrefetchCache]) expect([true, false, null]).toContain(flag);
    expect(typeof hop.servedFromCache).toBe("boolean");
  }
  expect(new Set(payload.httpStatusEvidence.map(evidence => evidence.id)).size).toBe(payload.httpStatusEvidence.length);
  for (const evidence of payload.httpStatusEvidence) {
    expect(keys(evidence)).toEqual([...EVIDENCE_KEYS].sort());
    expect(evidence.source).toBe("extra-info"); expect(["unique", "unknown"]).toContain(evidence.association);
    expect(typeof evidence.id).toBe("string"); expect(evidence.id.length).toBeGreaterThan(0);
    if (evidence.chainId !== null) { expect(typeof evidence.chainId).toBe("string"); expect(evidence.chainId.length).toBeGreaterThan(0); }
    expect(Number.isInteger(evidence.status)).toBe(true); expect(evidence.status).toBeGreaterThanOrEqual(100); expect(evidence.status).toBeLessThanOrEqual(599);
    if (evidence.association === "unique") {
      expect(evidence.hopId).not.toBeNull(); expect(inventory.has(evidence.hopId!)).toBe(true);
      expect(evidence.chainId).toBe(inventory.get(evidence.hopId!)!.chainId);
      expect(inventory.get(evidence.hopId!)!.networkStatus).toBe(evidence.status);
    } else expect(evidence.hopId).toBeNull();
  }
  expect(c.unattributed).toBeGreaterThanOrEqual(payload.httpStatusEvidence.filter(evidence => evidence.association === "unknown").length);
  for (const call of wire.state.commands) { expect(PASSIVE_COMMANDS).toContain(call.method); expect(call.sessionId).toBeUndefined(); }
}
async function payload(run: Run, advance = 0) {
  if (advance) await vi.advanceTimersByTimeAsync(advance);
  await flush();
  // Assert settlement first, never leave a failing test awaiting an unbounded
  // promise. A rejection is not an alternate successful DTO.
  expect(run.result.state).toBe("fulfilled");
  const value = run.result.value!; assertSafe(value); return value;
}
async function windowEnd(run: Run) { return payload(run, LIMITS.observeMs + LIMITS.cleanupMs); }
function request(id = NATIVE, overrides: Record<string, unknown> = {}, sessionId?: string) {
  socket().event("Network.requestWillBeSent", {
    requestId: id, loaderId: LOADER, documentURL: `${ORIGIN}/${PRIVATE}`, timestamp: 1, wallTime: 1,
    frameId: ROOT, type: "Fetch", redirectHasExtraInfo: false,
    request: { url: `${ORIGIN}/private/${PRIVATE}?token=${PRIVATE}#${PRIVATE}`, method: "GET", headers: { Authorization: PRIVATE, Cookie: PRIVATE }, postData: PRIVATE, postDataEntries: [{ bytes: PRIVATE }], hasPostData: true },
    initiator: { type: "script", url: `${ORIGIN}/${PRIVATE}`, stack: { callFrames: [{ functionName: PRIVATE, url: `${ORIGIN}/${PRIVATE}`, lineNumber: 1, columnNumber: 1 }] } },
    ...overrides,
  }, sessionId);
}
function response(id = NATIVE, status = 200, overrides: Record<string, unknown> = {}, sessionId?: string) {
  socket().event("Network.responseReceived", { requestId: id, loaderId: LOADER, frameId: ROOT, timestamp: 2, type: "Fetch", hasExtraInfo: false, response: rawResponse(status), ...overrides }, sessionId);
}
function rawResponse(status: number, flags: Record<string, unknown> = {}) {
  return { url: `${ORIGIN}/private/${PRIVATE}?token=${PRIVATE}`, status, statusText: PRIVATE, headers: { "Set-Cookie": PRIVATE, "X-Private": PRIVATE }, headersText: PRIVATE, requestHeaders: { Authorization: PRIVATE }, requestHeadersText: PRIVATE, mimeType: PRIVATE, charset: PRIVATE, connectionReused: false, connectionId: 837, encodedDataLength: 0, securityState: "neutral", remoteIPAddress: PRIVATE, cacheStorageCacheName: PRIVATE, securityDetails: { subjectName: PRIVATE }, ...flags };
}
function finish(id = NATIVE, sessionId?: string) { socket().event("Network.loadingFinished", { requestId: id, timestamp: 3, encodedDataLength: 1 }, sessionId); }
function fail(id = NATIVE, overrides: Record<string, unknown> = {}, sessionId?: string) {
  socket().event("Network.loadingFailed", { requestId: id, timestamp: 3, type: "Fetch", errorText: "net::ERR_FAILED", canceled: false, ...overrides }, sessionId);
}
function extra(id = NATIVE, status = 200, sessionId?: string) {
  // No invented frameId, loaderId, timestamp or redirect-hop identity. Installed
  // CDP declarations provide none of those association proofs for extra-info.
  socket().event("Network.responseReceivedExtraInfo", { requestId: id, statusCode: status, headers: { "Set-Cookie": PRIVATE }, headersText: PRIVATE, blockedCookies: [{ cookieLine: PRIVATE, cookie: { name: PRIVATE, value: PRIVATE }, blockedReasons: [PRIVATE] }], exemptedCookies: [{ cookie: { name: PRIVATE, value: PRIVATE }, exemptionReason: PRIVATE }], cookiePartitionKey: { topLevelSite: `${ORIGIN}/${PRIVATE}` }, resourceIPAddressSpace: "Public" }, sessionId);
}
function csp(index = 0, sessionId?: string) {
  socket().event("Audits.issueAdded", { issue: { code: "ContentSecurityPolicyIssue", issueId: `${PRIVATE}-${index}`, details: { contentSecurityPolicyIssueDetails: { blockedURL: `${ORIGIN}/${PRIVATE}`, violatedDirective: `script-src '${PRIVATE}'`, isReportOnly: false, contentSecurityPolicyViolationType: "kURLViolation", sourceCodeLocation: { url: `${ORIGIN}/${PRIVATE}`, lineNumber: 1, columnNumber: 1 }, violatingNodeId: 19 } } } }, sessionId);
}
function discovery(rows: unknown[]) { wire.state.discoveryBody = JSON.stringify(rows); }
function discoveryRow(id = TARGET, origin = ORIGIN, overrides: Record<string, unknown> = {}) {
  return { type: "page", id, url: `${origin}/private/${PRIVATE}?token=${PRIVATE}#${PRIVATE}`, title: PRIVATE, description: PRIVATE, faviconUrl: `${origin}/${PRIVATE}`, devtoolsFrontendUrl: `/${PRIVATE}`, webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/${id}`, ...overrides };
}
function assertSafeError(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  const value = error as Error & { code?: unknown; cause?: unknown };
  expect(`${value.message}\n${value.stack}\n${JSON.stringify(value)}`).not.toContain(PRIVATE);
  expect(value.cause).toBeUndefined();
}

beforeEach(() => {
  expect(wire.forbidden).not.toHaveBeenCalled();
  vi.useFakeTimers(); vi.setSystemTime(AT);
  wire.state.active = true; wire.state.sockets.length = 0; wire.state.commands.length = 0; wire.state.http.length = 0;
  wire.state.held.clear(); wire.state.autoOpen = true; wire.state.closeAck = true; wire.state.terminateAck = true;
  wire.state.holdDiscovery = false; wire.state.pendingDiscovery.length = 0; wire.state.discoveryStatus = 200; wire.state.discoveryChunks = null;
  wire.state.beforeAutoReply = undefined;
  wire.state.frame = { id: ROOT, loaderId: LOADER, url: `${ORIGIN}/private/${PRIVATE}?token=${PRIVATE}`, securityOrigin: ORIGIN, name: PRIVATE, mimeType: PRIVATE };
  discovery([discoveryRow()]);
  vi.stubGlobal("fetch", wire.fetchDiscovery); vi.stubGlobal("WebSocket", wire.forbidden);
  vi.spyOn(process, "kill").mockImplementation(wire.forbidden);
});
afterEach(async () => {
  // Test-owned in-memory teardown only; force-close here cannot satisfy any of
  // the assertions made in a test about production cleanup before this point.
  for (const run of runs) run.controller.abort();
  for (const socket of wire.state.sockets) socket.serverClose();
  for (const release of wire.state.pendingDiscovery.splice(0)) release();
  await flush(); await vi.advanceTimersByTimeAsync(LIMITS.cleanupMs + LIMITS.livenessMs);
  for (const run of runs.splice(0)) {
    const closed = watch(run.handle.closed); await flush(); expect(closed.state).toBe("fulfilled");
  }
  expect(wire.forbidden).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  wire.state.active = false; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
afterAll(() => vi.unstubAllGlobals());

describe("selected-page discovery and dedicated setup — prepared, unrun", () => {
  it("projects HTTP(S) page targets immediately; workers, title, full URL and first-page authority are not returned", async () => {
    discovery([discoveryRow("first-unselected-page", "https://site-b.fixture.test"), discoveryRow(), discoveryRow("worker", ORIGIN, { type: "service_worker" }), discoveryRow("blank", ORIGIN, { url: "about:blank" })]);
    const controller = new AbortController(); const guard = vi.fn(() => undefined);
    const result = await listNetworkPageTargets(PORT, { signal: controller.signal, assertCurrent: guard, deadline: AT + LIMITS.setupMs });
    expect(result).toEqual([
      { id: "first-unselected-page", origin: "https://site-b.fixture.test", webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/first-unselected-page` },
      target(),
    ]);
    for (const item of result) expect(keys(item)).toEqual(["id", "origin", "webSocketDebuggerUrl"]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE); expect(guard).toHaveBeenCalled();
    const run = start(result[1]); await flush();
    expect(socket().url).toBe(target().webSocketDebuggerUrl); expect(run.onArmed).toHaveBeenCalledTimes(1);
    const observed = await windowEnd(run); expect(observed.hops).toEqual([]);
  });

  it.each([0, -1, 65_536, 1.5, NaN, Infinity, "47161", null, undefined])("rejects invalid trusted port %# before HTTP, WS or command allocation", async port => {
    const pending = watch(listNetworkPageTargets(port as number, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(pending.state).toBe("rejected"); assertSafeError(pending.error);
    expect(wire.state.http).toEqual([]); expect(wire.state.sockets).toEqual([]);
  });

  it.each([
    `ws://outside.fixture.test:${PORT}/devtools/page/${TARGET}`,
    `ws://192.0.2.1:${PORT}/devtools/page/${TARGET}`,
    `ws://127.0.0.1:${PORT + 1}/devtools/page/${TARGET}`,
    `wss://127.0.0.1:${PORT}/devtools/page/${TARGET}`,
    `ws://${PRIVATE}@127.0.0.1:${PORT}/devtools/page/${TARGET}`,
    `ws://127.0.0.1:${PORT}/devtools/browser/${TARGET}`,
    `ws://127.0.0.1:${PORT}/devtools/page/other-target`,
    `ws://127.0.0.1:${PORT}/devtools/page/${TARGET}/extra`,
    `ws://127.0.0.1:${PORT}/devtools/page/${TARGET}?token=${PRIVATE}`,
    `ws://127.0.0.1:${PORT}/devtools/page/${TARGET}#${PRIVATE}`,
    `ws://127.0.0.1:${PORT}/devtools/page/%2e%2e%2f${TARGET}`,
    `ws://127.0.0.1:${PORT}/devtools/page/x/../${TARGET}`,
  ])("rejects a mismatched or decorated selected socket endpoint %# without connecting", async webSocketDebuggerUrl => {
    const run = start({ ...target(), webSocketDebuggerUrl });
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "unavailable", stopReason: "setup-rejected", armedAt: null });
    expect(wire.state.sockets).toEqual([]); expect(run.onArmed).not.toHaveBeenCalled();
    expect(run.closed.state).toBe("fulfilled"); expect(run.handle.cleanupVerified).toBe(true);
  });

  it.each(["", "../bad", "bad/id", "bad?x", "bad#x", PRIVATE.repeat(100)])("rejects an invalid selected target id %# before a socket", async id => {
    const run = start({ ...target(), id });
    expect((await payload(run, LIMITS.cleanupMs)).observation.completion).toBe("unavailable");
    expect(wire.state.sockets).toEqual([]);
  });

  it.each(["about:blank", "file:///private/file", `${ORIGIN}/path`, `${ORIGIN}?token=${PRIVATE}`, `https://${PRIVATE}@site-a.fixture.test`, "null", ""]) ("requires an already projected safe selected origin %#", async origin => {
    const run = start({ ...target(), origin });
    expect((await payload(run, LIMITS.cleanupMs)).observation.completion).toBe("unavailable");
    expect(run.onArmed).not.toHaveBeenCalled(); expect(wire.state.sockets).toEqual([]);
  });

  it.each(["Page.enable", "Network.enable", "Page.getFrameTree"])("does not ARMED before the required %s acknowledgment", async method => {
    wire.state.held.add(method); const run = start(); await flush();
    expect(run.onArmed).not.toHaveBeenCalled(); expect(run.result.state).toBe("pending");
    if (wire.state.commands.some(value => value.method === "Network.enable")) { request(); response(); finish(); }
    const held = command(method);
    held.socket.reply(held, method === "Page.getFrameTree" ? { frameTree: { frame: wire.state.frame } } : {});
    await flush(); expect(run.onArmed).toHaveBeenCalledTimes(1);
    const value = await windowEnd(run); expect(value.hops).toEqual([]); // setup traffic is not replayed
    expect(value.observation.durationMs).toBe(10_000);
  });

  it.each(["Page.enable", "Network.enable", "Page.getFrameTree"])("makes a rejected %s unavailable, with only a static reason", async method => {
    wire.state.held.add(method); const run = start(); await flush();
    socket().reject(command(method));
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "unavailable", stopReason: "setup-rejected", armedAt: null, durationMs: 0 });
    expect(value.hops).toEqual([]); expect(run.onArmed).not.toHaveBeenCalled(); expect(run.handle.cleanupVerified).toBe(true);
  });

  it.each(["socket-open", "Page.enable", "Network.enable", "Page.getFrameTree"])("bounds the entire setup and ignores a late successful %s", async stage => {
    if (stage === "socket-open") wire.state.autoOpen = false; else wire.state.held.add(stage);
    const run = start(); await flush();
    await vi.advanceTimersByTimeAsync(LIMITS.setupMs - 1); expect(run.onArmed).not.toHaveBeenCalled();
    const value = await payload(run, 1 + LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "unavailable", stopReason: "setup-timeout", armedAt: null });
    if (stage === "socket-open") socket().open();
    else socket().reply(command(stage), stage === "Page.getFrameTree" ? { frameTree: { frame: wire.state.frame } } : {});
    await flush(); expect(run.onArmed).not.toHaveBeenCalled(); expect(run.result.value).toEqual(value);
  });

  it("does not reset five seconds for each successful setup command", async () => {
    wire.state.held.add("Page.enable"); wire.state.held.add("Network.enable");
    const run = start(); await flush();
    await vi.advanceTimersByTimeAsync(3_000); socket().reply(command("Page.enable")); await flush();
    await vi.advanceTimersByTimeAsync(1_999); expect(run.onArmed).not.toHaveBeenCalled();
    const value = await payload(run, 1 + LIMITS.cleanupMs);
    expect(value.observation.stopReason).toBe("setup-timeout");
    socket().reply(command("Network.enable")); await flush(); expect(run.onArmed).not.toHaveBeenCalled();
  });

  it.each(["Page.enable", "Network.enable", "Page.getFrameTree"])("checks absolute time after awaited %s before accepting success, even before its timer runs", async method => {
    wire.state.held.add(method); const run = start(); await flush();
    vi.setSystemTime(AT + LIMITS.setupMs + 1);
    socket().reply(command(method), method === "Page.getFrameTree" ? { frameTree: { frame: wire.state.frame } } : {});
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation.stopReason).toBe("setup-timeout"); expect(run.onArmed).not.toHaveBeenCalled();
  });

  it.each([
    {}, { frameTree: null }, { frameTree: {} }, { frameTree: { frame: {} } },
    { frameTree: { frame: { id: ROOT, parentId: "not-root", url: ORIGIN } } },
    { frameTree: { frame: { id: ROOT, loaderId: LOADER, url: "about:blank" } } },
    { frameTree: { frame: { id: ROOT, loaderId: LOADER, url: "https://site-b.fixture.test/private" } } },
  ])("never ARMED on a malformed, child or wrong-origin selected frame tree %#", async result => {
    wire.state.held.add("Page.getFrameTree"); const run = start(); await flush(); socket().reply(command("Page.getFrameTree"), result);
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation.completion).toBe("unavailable"); expect(value.observation.armedAt).toBeNull(); expect(run.onArmed).not.toHaveBeenCalled();
  });

  it("does not accept a command ack from a foreign session or an unrelated command id", async () => {
    wire.state.held.add("Network.enable"); const run = start(); await flush(); const held = command("Network.enable");
    socket().deliver({ id: held.id, result: {}, sessionId: "foreign-session" });
    socket().deliver({ id: held.id + 1000, result: {} }); await flush();
    expect(run.onArmed).not.toHaveBeenCalled();
    socket().reply(held); await flush(); expect(run.onArmed).toHaveBeenCalledTimes(1); await windowEnd(run);
  });

  it("does not claim CSP coverage when optional Audits enable is unavailable", async () => {
    wire.state.held.add("Audits.enable"); const run = start(); await flush(); csp(); socket().reject(command("Audits.enable")); await flush();
    expect(run.onArmed).toHaveBeenCalledTimes(1); csp(); request(); response(); finish();
    const value = await windowEnd(run);
    expect(value.observation.coverage.csp).toBe("unavailable"); expect(value.observation.counts.cspIssues).toBe(0);
    expect(value.observation.coverage.console).toBe("not-observed"); expect(value.observation.coverage.storage).toBe("not-observed");
  });

  // CSP counting is unavailable in this passive agent: installed CDP provides
  // no violated-frame identity, and the permitted commands cannot resolve a
  // BackendNodeId. There is no honest positive root-attribution control to fake.
  it("CSP counting unavailable in this passive agent — Audits ACK does not prove the violated main frame", async () => {
    const run = await arm(); csp(); csp(1, "foreign-session");
    socket().event("Audits.issueAdded", { issue: { code: "CookieIssue", details: { raw: PRIVATE } } });
    const value = await windowEnd(run);
    expect(value.observation.coverage.csp).toBe("unavailable"); expect(value.observation.counts.cspIssues).toBe(0);
  });
});

describe("selected main-frame scope and truthful hop accounting", () => {
  it("uses the actual selected root frame, not targetId, same-origin filtering or a first page", async () => {
    const run = await arm();
    request(`${NATIVE}-target-as-frame`, { frameId: TARGET });
    response(`${NATIVE}-target-as-frame`, 500, { frameId: TARGET }); finish(`${NATIVE}-target-as-frame`);
    request(NATIVE, { request: { url: `${THIRD_PARTY}/secret/${PRIVATE}?token=${PRIVATE}`, method: "POST", headers: { Authorization: PRIVATE }, postData: PRIVATE } });
    response(); finish();
    const value = await windowEnd(run);
    expect(value.hops).toHaveLength(1); expect(value.hops[0]).toMatchObject({ origin: THIRD_PARTY, method: "POST", status: 200, terminal: "finished" });
    expect(value.observation.counts).toMatchObject({ requests: 1, responses: 1, http5xx: 0, unattributed: 0 });
  });

  it("never receives B-target traffic through a borrowed/default-first-page connection", async () => {
    const run = await arm(); const owned = socket(); request(); response(); finish();
    const borrowed = new wire.Socket(`ws://127.0.0.1:${PORT}/devtools/page/other-target`); await flush();
    borrowed.event("Network.requestWillBeSent", { requestId: `${NATIVE}-B`, frameId: ROOT, loaderId: LOADER, type: "Fetch", request: { url: "https://site-b.fixture.test/private", method: "GET" } });
    borrowed.event("Network.responseReceived", { requestId: `${NATIVE}-B`, frameId: ROOT, response: { status: 500 } });
    const value = await windowEnd(run);
    expect(value.observation.counts.hops).toBe(1); expect(value.observation.counts.http5xx).toBe(0);
    expect(owned.closeCalls + owned.terminateCalls).toBeGreaterThan(0);
    expect(borrowed.closeCalls).toBe(0); expect(borrowed.terminateCalls).toBe(0); expect(borrowed.readyState).toBe(wire.Socket.OPEN);
  });

  it("ignores child-frame, OOPIF/session, worker and unqualified starts, including their extra-info", async () => {
    const run = await arm();
    request(`${NATIVE}-child`, { frameId: "child-frame" }); extra(`${NATIVE}-child`, 403); response(`${NATIVE}-child`, 403, { frameId: "child-frame" }); finish(`${NATIVE}-child`);
    request(`${NATIVE}-worker`, { frameId: undefined, loaderId: "" }); extra(`${NATIVE}-worker`, 429); finish(`${NATIVE}-worker`);
    request(`${NATIVE}-no-frame`, { frameId: undefined }); extra(`${NATIVE}-no-frame`, 500);
    request(`${NATIVE}-session`, {}, "oopif-session"); extra(`${NATIVE}-session`, 502, "oopif-session"); response(`${NATIVE}-session`, 502, {}, "oopif-session"); finish(`${NATIVE}-session`, "oopif-session");
    request(); response(); finish();
    const value = await windowEnd(run);
    expect(value.hops).toHaveLength(1); expect(value.httpStatusEvidence).toEqual([]);
    expect(value.observation.counts).toMatchObject({ requests: 1, responses: 1, finished: 1, http4xx: 0, http5xx: 0, unattributed: 0 });
  });

  it("does not let foreign-frame/session replies poison a known root chain", async () => {
    const run = await arm(); request();
    response(NATIVE, 403, { frameId: "child-frame" }); response(NATIVE, 500, {}, "foreign-session");
    extra(NATIVE, 503, "foreign-session"); fail(NATIVE, { errorText: "net::ERR_PROXY_CONNECTION_FAILED" }, "foreign-session");
    response(); finish(NATIVE, "foreign-session"); finish();
    const value = await windowEnd(run);
    expect(value.hops[0]).toMatchObject({ status: 200, networkStatus: null, terminal: "finished", errorCode: null });
    expect(value.observation.counts).toMatchObject({ http4xx: 0, http5xx: 0, failed: 0 });
  });

  it("does not create an invented hop from response/terminal events whose start was not observed", async () => {
    const run = await arm(); response(`${NATIVE}-boundary`, 403); finish(`${NATIVE}-boundary`);
    const value = await windowEnd(run);
    expect(value.hops).toEqual([]); expect(value.observation.counts.requests).toBe(0);
    expect(value.observation.counts.responses).toBe(0); expect(value.observation.counts.http4xx).toBe(0);
    expect(value.observation.counts.unattributed).toBeGreaterThan(0);
    expect(value.observation.completion).toBe("partial");
  });

  it("stops on a root origin change while retaining only previously observed safe evidence", async () => {
    const run = await arm(); request(); response(NATIVE, 403); finish();
    socket().event("Page.frameNavigated", { frame: { id: "child-frame", parentId: ROOT, url: `https://child.fixture.test/${PRIVATE}` } });
    await flush(); expect(run.result.state).toBe("pending");
    socket().event("Page.frameNavigated", { frame: { id: ROOT, loaderId: `${PRIVATE}-new-loader`, url: `https://site-b.fixture.test/${PRIVATE}` } });
    const value = await payload(run, LIMITS.livenessMs + LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "target-changed" });
    expect(value.hops[0]).toMatchObject({ status: 403, terminal: "finished" });
  });

  it("does not erase an observed HTTP response, source flags or failure code when loading later fails", async () => {
    const run = await arm(); request();
    response(NATIVE, 403, { response: rawResponse(403, { fromDiskCache: false, fromServiceWorker: true, fromPrefetchCache: false }) });
    fail(NATIVE, { errorText: "net::ERR_CONNECTION_RESET" });
    const value = await windowEnd(run);
    expect(value.hops[0]).toMatchObject({ status: 403, networkStatus: null, terminal: "failed", errorCode: "ERR_CONNECTION_RESET", fromDiskCache: false, fromServiceWorker: true, fromPrefetchCache: false });
    expect(value.observation.counts).toMatchObject({ requests: 1, responses: 1, failed: 1, http4xx: 1, serviceWorker: 1 });
  });

  it("keeps HTTP403/429 separate from native proxy errors without guessing a proxy hop or cause", async () => {
    const run = await arm();
    request(`${NATIVE}-403`); response(`${NATIVE}-403`, 403); finish(`${NATIVE}-403`);
    request(`${NATIVE}-429`); response(`${NATIVE}-429`, 429); finish(`${NATIVE}-429`);
    request(`${NATIVE}-proxy`); fail(`${NATIVE}-proxy`, { errorText: "net::ERR_PROXY_CONNECTION_FAILED" });
    request(`${NATIVE}-tunnel`); fail(`${NATIVE}-tunnel`, { errorText: "net::ERR_TUNNEL_CONNECTION_FAILED" });
    const value = await windowEnd(run);
    expect(value.observation.counts).toMatchObject({ requests: 4, responses: 2, finished: 2, failed: 2, http4xx: 2, http5xx: 0 });
    expect(value.hops.map(hop => hop.errorCode)).toEqual([null, null, "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED"]);
    expect(value.hops.map(hop => hop.status)).toEqual([403, 429, null, null]);
    expect(value.observation.coverage.bridgeHop).toBe("unknown"); expect(value.observation.coverage.upstreamHop).toBe("unknown");
  });

  it("distinguishes browser request cancellation from cancelling the observation", async () => {
    const run = await arm(); request(); fail(NATIVE, { canceled: true, errorText: "net::ERR_ABORTED" });
    const value = await windowEnd(run);
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended", durationMs: 10_000 });
    expect(value.hops[0]).toMatchObject({ terminal: "cancelled", errorCode: "ERR_ABORTED" });
    expect(value.observation.counts).toMatchObject({ requestCancelled: 1, failed: 0, pending: 0 });
  });

  it("does not label pending requests browser-cancelled merely because the user cancelled observation", async () => {
    const run = await arm(); request(); await vi.advanceTimersByTimeAsync(230); run.controller.abort(PRIVATE);
    const value = await payload(run, LIMITS.livenessMs + LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "cancelled", stopReason: "cancelled" });
    expect(value.hops[0].terminal).toBe("pending"); expect(value.observation.counts.requestCancelled).toBe(0);
    expect(value.observation.counts.pending).toBe(1); expect(value.observation.durationMs).toBeLessThan(10_000);
  });

  it("observes a full quiet ten-second window, with no traffic proof and no health/PASS field", async () => {
    const run = await arm(); await vi.advanceTimersByTimeAsync(9_999);
    expect(run.result.state).toBe("pending"); expect(socket().closeCalls).toBe(0);
    const value = await payload(run, 1 + LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended", armedAt: AT, endedAt: AT + 10_000, durationMs: 10_000 });
    expect(Object.values(value.observation.counts)).toEqual(COUNT_KEYS.map(() => 0));
    expect(value.hops).toEqual([]); expect(value.httpStatusEvidence).toEqual([]);
    expect(run.handle.cleanupVerified).toBe(true); expect(run.closed.state).toBe("fulfilled");
  });

  it("preserves pending work as incomplete evidence at window end, never as finished/failed or healthy", async () => {
    const run = await arm(); request();
    const value = await windowEnd(run);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "evidence-incomplete", durationMs: 10_000 });
    expect(value.observation.coverage.network).toBe("partial");
    expect(value.hops[0]).toMatchObject({ status: null, networkStatus: null, terminal: "pending", fromDiskCache: null, fromServiceWorker: null, fromPrefetchCache: null, servedFromCache: false });
    expect(value.observation.counts).toMatchObject({ requests: 1, pending: 1, responses: 0, finished: 0, failed: 0 });
  });

  it("keeps cache, prefetch and ServiceWorker facts per hop without inventing absent booleans", async () => {
    const run = await arm();
    request(`${NATIVE}-disk`); socket().event("Network.requestServedFromCache", { requestId: `${NATIVE}-disk` });
    response(`${NATIVE}-disk`, 200, { response: rawResponse(200, { fromDiskCache: true, fromServiceWorker: false }) }); finish(`${NATIVE}-disk`);
    request(`${NATIVE}-prefetch`); response(`${NATIVE}-prefetch`, 200, { response: rawResponse(200, { fromPrefetchCache: true }) }); finish(`${NATIVE}-prefetch`);
    request(`${NATIVE}-sw`); response(`${NATIVE}-sw`, 200, { response: rawResponse(200, { fromServiceWorker: true }) }); finish(`${NATIVE}-sw`);
    const value = await windowEnd(run);
    expect(value.observation.counts).toMatchObject({ cache: 2, serviceWorker: 1 });
    expect(value.hops[0]).toMatchObject({ servedFromCache: true, fromDiskCache: true, fromServiceWorker: false, fromPrefetchCache: null });
    expect(value.hops[1]).toMatchObject({ fromDiskCache: null, fromPrefetchCache: true });
    expect(value.hops[2]).toMatchObject({ fromDiskCache: null, fromServiceWorker: true, fromPrefetchCache: null });
  });

  it("treats RequestId as a redirect chain, counting all admitted request-HOP starts", async () => {
    const run = await arm();
    request(NATIVE, { request: { url: `${ORIGIN}/one?${PRIVATE}`, method: "POST" } });
    request(NATIVE, { redirectResponse: rawResponse(303), redirectHasExtraInfo: false, request: { url: `${THIRD_PARTY}/two?${PRIVATE}`, method: "GET" } });
    request(NATIVE, { redirectResponse: rawResponse(302), redirectHasExtraInfo: false, request: { url: `${ORIGIN}/three?${PRIVATE}`, method: "GET" } });
    response(); finish();
    const value = await windowEnd(run); const [one, two, three] = value.hops;
    expect(value.observation.counts).toMatchObject({ requests: 3, hops: 3, responses: 3, redirects: 2, finished: 1, pending: 0 });
    expect(value.hops.map(hop => hop.status)).toEqual([303, 302, 200]);
    expect(value.hops.map(hop => hop.terminal)).toEqual(["redirected", "redirected", "finished"]);
    expect(one).toMatchObject({ redirectedFrom: null, origin: ORIGIN, method: "POST" });
    expect(two).toMatchObject({ redirectedFrom: one.id, origin: THIRD_PARTY, method: "GET", chainId: one.chainId });
    expect(three).toMatchObject({ redirectedFrom: two.id, origin: ORIGIN, chainId: one.chainId });
    expect(new Set(value.hops.map(hop => hop.id)).size).toBe(3); expect(one.chainId).not.toBe(NATIVE);
  });

  it("does not synthesize a pre-window redirect hop from redirectResponse alone", async () => {
    const run = await arm();
    request(NATIVE, { redirectResponse: rawResponse(302), redirectHasExtraInfo: true });
    extra(NATIVE, 302); response(); finish();
    const value = await windowEnd(run);
    expect(value.hops).toHaveLength(1); expect(value.hops[0].redirectedFrom).toBeNull();
    expect(value.hops[0]).toMatchObject({ status: 200, networkStatus: null, terminal: "finished" });
    expect(value.observation.counts).toMatchObject({ requests: 1, redirects: 0, responses: 1 });
    expect(value.httpStatusEvidence[0]).toMatchObject({ status: 302, association: "unknown", hopId: null });
    expect(value.observation.completion).toBe("partial");
  });

  it("deduplicates known-hop HTTP/terminal counts instead of counting browser + wire response twice", async () => {
    const run = await arm(); request(); response(NATIVE, 403, { hasExtraInfo: true }); extra(NATIVE, 403); finish(); finish();
    const value = await windowEnd(run);
    expect(value.observation.counts).toMatchObject({ requests: 1, responses: 1, finished: 1, http4xx: 1 });
    expect(value.hops[0]).toMatchObject({ status: 403, networkStatus: 403 }); expect(value.httpStatusEvidence).toHaveLength(1);
  });
});

describe("extra-info status evidence is not FIFO/adjacency attribution", () => {
  it.each(["before", "after"] as const)("preserves browser200 versus wire304 when extra-info arrives %s the browser response", async order => {
    const run = await arm(); request();
    if (order === "before") extra(NATIVE, 304);
    response(NATIVE, 200, { hasExtraInfo: true, response: rawResponse(200, { fromDiskCache: true }) });
    if (order === "after") extra(NATIVE, 304);
    finish();
    const value = await windowEnd(run); const hop = value.hops[0];
    expect(hop).toMatchObject({ status: 200, networkStatus: 304, terminal: "finished", fromDiskCache: true });
    expect(value.httpStatusEvidence).toEqual([{ id: expect.any(String), chainId: hop.chainId, hopId: hop.id, status: 304, source: "extra-info", association: "unique" }]);
    expect(value.observation.counts).toMatchObject({ responses: 1, cache: 1, http4xx: 0, http5xx: 0 });
  });

  it.each(["before-failure", "after-failure"] as const)("retains a uniquely observed CORS-only wire403 %s without inventing browser responseReceived", async order => {
    const run = await arm(); request();
    if (order === "before-failure") extra(NATIVE, 403);
    fail(NATIVE, { corsErrorStatus: { corsError: "DisallowedByMode", failedParameter: PRIVATE } });
    if (order === "after-failure") extra(NATIVE, 403);
    const value = await windowEnd(run); const hop = value.hops[0];
    expect(hop).toMatchObject({ status: null, networkStatus: 403, terminal: "failed", errorCode: "ERR_FAILED", corsReason: "DisallowedByMode" });
    expect(value.httpStatusEvidence[0]).toMatchObject({ status: 403, hopId: hop.id, chainId: hop.chainId, association: "unique" });
    expect(value.observation.counts).toMatchObject({ requests: 1, responses: 1, failed: 1, http4xx: 1, unattributed: 0 });
  });

  it.each([{ statuses: [302, 429] }, { statuses: [429, 302] }])("does not FIFO-match ambiguous redirect statuses in wire order $statuses", async ({ statuses }) => {
    const run = await arm(); request();
    request(NATIVE, { redirectResponse: rawResponse(302), redirectHasExtraInfo: true });
    response(NATIVE, 200, { hasExtraInfo: true });
    for (const status of statuses) extra(NATIVE, status);
    finish();
    const value = await windowEnd(run);
    expect(value.hops.map(hop => hop.status)).toEqual([302, 200]);
    expect(value.hops.map(hop => hop.networkStatus)).toEqual([null, null]);
    expect(value.httpStatusEvidence.map(evidence => evidence.status).sort()).toEqual([302, 429]);
    for (const evidence of value.httpStatusEvidence) expect(evidence).toMatchObject({ chainId: value.hops[0].chainId, hopId: null, association: "unknown" });
    expect(value.observation.counts).toMatchObject({ requests: 2, responses: 2, redirects: 1, http4xx: 0, unattributed: 2 });
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "evidence-incomplete" });
  });

  it("revokes a provisional single-hop association if a later redirect makes its hop identity ambiguous", async () => {
    const run = await arm(); request(); extra(NATIVE, 403);
    request(NATIVE, { redirectResponse: rawResponse(302), redirectHasExtraInfo: true });
    response(NATIVE, 200, { hasExtraInfo: true }); extra(NATIVE, 429); finish();
    const value = await windowEnd(run);
    expect(value.hops.map(hop => hop.networkStatus)).toEqual([null, null]);
    expect(value.httpStatusEvidence.map(evidence => evidence.status)).toEqual([403, 429]);
    expect(value.httpStatusEvidence.every(evidence => evidence.hopId === null && evidence.association === "unknown")).toBe(true);
    expect(value.observation.counts.http4xx).toBe(0); expect(value.observation.counts.unattributed).toBe(2);
  });

  it("keeps pre-start/window-boundary extra-info unknown even when a same-RequestId hop appears later", async () => {
    const run = await arm(); extra(NATIVE, 403); request(); response(); finish();
    const value = await windowEnd(run);
    expect(value.hops[0]).toMatchObject({ status: 200, networkStatus: null });
    expect(value.httpStatusEvidence[0]).toMatchObject({ status: 403, hopId: null, association: "unknown" });
    expect(value.observation.counts).toMatchObject({ requests: 1, responses: 1, http4xx: 0, unattributed: 1 });
    expect(value.observation.completion).toBe("partial");
  });

  it("never assigns redirectHasExtraInfo for the OLD hop to the newly started hop", async () => {
    const run = await arm(); request();
    request(NATIVE, { redirectResponse: rawResponse(302), redirectHasExtraInfo: true });
    response(NATIVE, 200, { hasExtraInfo: false }); extra(NATIVE, 403); finish();
    const value = await windowEnd(run);
    expect(value.hops.map(hop => hop.status)).toEqual([302, 200]);
    expect(value.hops[1].networkStatus).toBeNull();
    expect(value.httpStatusEvidence).toHaveLength(1);
    expect(value.httpStatusEvidence[0].status).toBe(403);
    expect(value.httpStatusEvidence[0].hopId).not.toBe(value.hops[1].id);
  });

  it("keeps a missing/ambiguous redirect extra-info unknown instead of assigning the lone status to the first/last hop", async () => {
    const run = await arm(); request();
    request(NATIVE, { redirectResponse: rawResponse(302), redirectHasExtraInfo: true });
    response(NATIVE, 200, { hasExtraInfo: true }); extra(NATIVE, 403); finish();
    const value = await windowEnd(run);
    expect(value.hops.map(hop => hop.networkStatus)).toEqual([null, null]);
    expect(value.httpStatusEvidence[0]).toMatchObject({ status: 403, hopId: null, association: "unknown" });
    expect(value.observation.counts).toMatchObject({ requests: 2, responses: 2, http4xx: 0, unattributed: 1 });
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "evidence-incomplete" });
  });

  it("does not infer a missing promised extra-info status or treat partial association as complete", async () => {
    const run = await arm(); request(); response(NATIVE, 200, { hasExtraInfo: true }); finish();
    const value = await windowEnd(run);
    expect(value.hops[0]).toMatchObject({ status: 200, networkStatus: null, terminal: "finished" }); expect(value.httpStatusEvidence).toEqual([]);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "evidence-incomplete" });
    expect(value.observation.counts.responses).toBe(1);
  });

  it("does not discard an orphan wire status, or promote it to known-hop 4xx/response counts", async () => {
    const run = await arm(); extra(`${NATIVE}-unseen`, 403);
    const value = await windowEnd(run);
    expect(value.hops).toEqual([]);
    expect(value.httpStatusEvidence).toHaveLength(1);
    expect(value.httpStatusEvidence[0]).toMatchObject({ id: expect.any(String), hopId: null, status: 403, source: "extra-info", association: "unknown" });
    expect(value.observation.counts).toMatchObject({ requests: 0, responses: 0, http4xx: 0, unattributed: 1 });
    expect(value.observation.completion).toBe("partial");
  });

  it("does not force a hop association from contradictory hasExtraInfo=false", async () => {
    const run = await arm(); request(); response(NATIVE, 200, { hasExtraInfo: false }); extra(NATIVE, 503); finish();
    const value = await windowEnd(run);
    expect(value.hops[0]).toMatchObject({ status: 200, networkStatus: null });
    expect(value.httpStatusEvidence[0]).toMatchObject({ status: 503, association: "unknown", hopId: null });
    expect(value.observation.counts).toMatchObject({ responses: 1, http5xx: 0, unattributed: 1 });
    expect(value.observation.completion).toBe("partial");
  });
});

describe("privacy, malformed protocol and hard bounds", () => {
  it("projects every discarded raw field, including command/discovery data, before returning any safe output", async () => {
    const run = await arm();
    request(NATIVE, { request: { url: `https://${PRIVATE}:${PRIVATE}@site-a.fixture.test/private/${PRIVATE}?token=${PRIVATE}#${PRIVATE}`, method: "POST", headers: { Authorization: PRIVATE, Cookie: PRIVATE }, postData: PRIVATE, postDataEntries: [{ bytes: PRIVATE }], mixedContentType: PRIVATE, referrerPolicy: PRIVATE }, raw: { title: PRIVATE, console: PRIVATE, stderr: PRIVATE, stack: PRIVATE } });
    socket().event("Network.requestWillBeSentExtraInfo", { requestId: NATIVE, headers: { Authorization: PRIVATE }, associatedCookies: [{ cookie: { name: PRIVATE, value: PRIVATE }, blockedReasons: [PRIVATE] }], clientSecurityState: { private: PRIVATE } });
    socket().event("Network.responseReceivedEarlyHints", { requestId: NATIVE, headers: { "X-Private": PRIVATE } });
    socket().event("Runtime.consoleAPICalled", { args: [{ value: PRIVATE }], stackTrace: { description: PRIVATE } });
    socket().event("Runtime.exceptionThrown", { exceptionDetails: { text: PRIVATE, exception: { description: PRIVATE } } });
    socket().event("DOMStorage.domStorageItemAdded", { storageId: { securityOrigin: ORIGIN }, key: PRIVATE, newValue: PRIVATE });
    response(NATIVE, 200, { hasExtraInfo: true }); extra(NATIVE, 200); finish(); csp();
    const value = await windowEnd(run);
    expect(value.hops[0]).toMatchObject({ origin: ORIGIN, method: "POST", status: 200, networkStatus: 200 });
    expect(value.observation.counts.cspIssues).toBe(0); // raw CSP samples cannot prove main-frame identity
    expect(value.observation.coverage.csp).toBe("unavailable");
    expect(JSON.stringify(value)).not.toContain(PRIVATE);
  });

  it("uses STATIC error/method/reason allowlists, not secret-shaped ERR_* or inherited property matches", async () => {
    const run = await arm();
    request(NATIVE, { type: PRIVATE, request: { url: `${ORIGIN}/${PRIVATE}`, method: "__proto__" } });
    fail(NATIVE, { errorText: `net::ERR_${PRIVATE}`, corsErrorStatus: { corsError: PRIVATE, failedParameter: PRIVATE } });
    const value = await windowEnd(run);
    expect(value.hops[0]).toMatchObject({ method: "OTHER", resourceType: "Other", errorCode: "OTHER", corsReason: "OTHER", terminal: "failed" });
    expect(value.observation.counts.failed).toBe(1);
  });

  it("keeps policy block reasons distinct from native failures and browser cancellation", async () => {
    const run = await arm(); request(); fail(NATIVE, { errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "csp" });
    const value = await windowEnd(run);
    expect(value.hops[0]).toMatchObject({ terminal: "blocked", blockedReason: "csp", errorCode: "ERR_BLOCKED_BY_CLIENT" });
    expect(value.observation.counts).toMatchObject({ blocked: 1, failed: 0, requestCancelled: 0 });
  });

  it.each([PRIVATE, "__proto__", "constructor"])("projects unknown blocked reason %# to a known OTHER enum", async blockedReason => {
    const run = await arm(); request(); fail(NATIVE, { blockedReason });
    const value = await windowEnd(run); expect(value.hops[0].blockedReason).toBe("OTHER");
  });

  it.each([`{ "private": "${PRIVATE}",`, PRIVATE, "null", "[]", "true", "42", '{"method":42,"params":{}}', '{"method":"Network.requestWillBeSent","params":null}'])("ends malformed protocol input %# with a static partial reason, never raw parser text", async raw => {
    const run = await arm(); socket().raw(raw);
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "protocol-invalid" });
    expect(value.observation.durationMs).toBeLessThan(10_000);
  });

  it.each([0, -1, 600, 403.5, "403", null, {}, []].map(status => ({ status })))("rejects invalid browser HTTP status %# rather than coercing it or returning success", async ({ status }) => {
    const run = await arm(); request(); response(NATIVE, 200, { response: { ...rawResponse(200), status } });
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "protocol-invalid" });
    expect(value.hops[0].status).toBeNull(); expect(value.observation.counts.responses).toBe(0);
  });

  it.each(["fromDiskCache", "fromServiceWorker", "fromPrefetchCache"] as const)("does not coerce wrong-type %s flags into cache/source evidence", async flag => {
    const run = await arm(); request(); response(NATIVE, 200, { response: rawResponse(200, { [flag]: PRIVATE }) });
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "protocol-invalid" });
    expect(value.hops[0][flag]).toBeNull(); expect(value.observation.counts.cache).toBe(0); expect(value.observation.counts.serviceWorker).toBe(0);
  });

  it.each([0, -1, 600, 429.5, "429", null, {}, []].map(statusCode => ({ statusCode })))("rejects invalid extra-info HTTP status %# without retaining raw evidence", async ({ statusCode }) => {
    const run = await arm(); request(); socket().event("Network.responseReceivedExtraInfo", { requestId: NATIVE, statusCode, headers: { raw: PRIVATE } });
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation.stopReason).toBe("protocol-invalid"); expect(value.httpStatusEvidence).toEqual([]);
    expect(value.hops[0].networkStatus).toBeNull();
  });

  it.each([
    { requestId: null }, { requestId: 47 }, { request: null }, { request: {} },
    { request: { url: `${ORIGIN}/${PRIVATE}`, method: 47 } },
    { request: { url: null, method: "GET" } }, { request: { url: `${PRIVATE} not a URL`, method: "GET" } },
  ])("does not infer missing/wrong-type request identity or request fields %#", async overrides => {
    const run = await arm(); request(NATIVE, overrides);
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "protocol-invalid" }); expect(value.hops).toEqual([]);
  });

  it("bounds raw WS bytes before JSON parsing, even when all oversize data would otherwise be discarded", async () => {
    const run = await arm();
    socket().raw(JSON.stringify({ method: "Runtime.consoleAPICalled", params: { raw: PRIVATE.repeat(Math.ceil(LIMITS.maxRawMessageBytes / PRIVATE.length) + 1) } }));
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "limit-exceeded" }); expect(value.hops).toEqual([]);
  });

  it("measures raw WS ingress in UTF-8 bytes, not JavaScript code units", async () => {
    const run = await arm();
    const raw = JSON.stringify({ method: "Runtime.consoleAPICalled", params: { raw: "界".repeat(Math.floor(LIMITS.maxRawMessageBytes / 2)) } });
    expect(raw.length).toBeLessThan(LIMITS.maxRawMessageBytes); expect(Buffer.byteLength(raw)).toBeGreaterThan(LIMITS.maxRawMessageBytes);
    socket().raw(raw);
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "limit-exceeded" });
  });

  it("does not count discarded body/header length against retained-detail budget below the raw ingress ceiling", async () => {
    const run = await arm(); const discarded = PRIVATE.repeat(1500);
    request(NATIVE, { request: { url: `${ORIGIN}/${PRIVATE}`, method: "POST", postData: discarded, headers: { Authorization: discarded } } });
    response(); finish();
    const value = await windowEnd(run);
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended" }); expect(value.hops).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(4_096);
  });

  it("touching hop128 stops early partial; it does not silently drop hop129 and wait out a successful window", async () => {
    const run = await arm();
    for (let index = 0; index < LIMITS.maxHops - 1; index++) request(`${NATIVE}-${index}`);
    await flush(); expect(run.result.state).toBe("pending");
    request(`${NATIVE}-boundary`);
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "limit-exceeded" });
    expect(value.hops).toHaveLength(128); expect(value.observation.counts.requests).toBe(128);
    expect(value.observation.durationMs).toBeLessThan(10_000);
  });

  it("touching safe projection256 stops early and preserves unknown-hop evidence rather than guessing/dropping it", async () => {
    const run = await arm();
    for (let index = 0; index < LIMITS.maxProjections - 1; index++) extra(`${NATIVE}-orphan-${index}`, 403);
    await flush(); expect(run.result.state).toBe("pending");
    extra(`${NATIVE}-orphan-boundary`, 429);
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "limit-exceeded" });
    expect(value.httpStatusEvidence).toHaveLength(256); expect(value.observation.counts.unattributed).toBe(256);
    expect(value.observation.counts.responses).toBe(0); expect(value.observation.counts.http4xx).toBe(0);
  });

  it("enforces the retained-detail byte ceiling without truncating origins or silently returning completed", async () => {
    const run = await arm();
    // WHATWG-syntactic HTTP authorities only, not DNS fixtures or a hostname
    // reachability claim. Each raw event is below the independent ingress cap.
    const hugeOrigin = `https://${"a".repeat(170_000)}.fixture.test`;
    request(`${NATIVE}-large-one`, { request: { url: `${hugeOrigin}/first?${PRIVATE}`, method: "GET" } });
    request(`${NATIVE}-large-two`, { request: { url: `${hugeOrigin}/second?${PRIVATE}`, method: "GET" } });
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "limit-exceeded" });
    expect(value.hops).toHaveLength(1); expect(value.hops[0].origin).toBe(hugeOrigin);
  });

  it("disconnect yields partial and retains the observed status; close reason/error text is never exported", async () => {
    const run = await arm(); request(); response(NATIVE, 500); socket().serverClose();
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "connection-closed" });
    expect(value.hops[0]).toMatchObject({ status: 500, terminal: "pending" }); expect(value.observation.counts.http5xx).toBe(1);
    expect(run.handle.cleanupVerified).toBe(true); expect(run.closed.state).toBe("fulfilled");
  });

  it("turns an owned socket error into a static partial result, not an exception sample", async () => {
    const run = await arm(); socket().emit("error", new Error(PRIVATE));
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "connection-closed" });
  });
});

describe("absolute setup budget, guards, abort and liveness", () => {
  it.each([AT - 1, NaN, Infinity, "5000", null, undefined])("rejects invalid/expired discovery deadline %# without HTTP", async deadline => {
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: deadline as number }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error); expect(wire.state.http).toEqual([]);
  });

  it("bounds HTTP discovery by the remaining absolute setup budget, including late successful delivery", async () => {
    wire.state.holdDiscovery = true; const controller = new AbortController();
    const observed = watch(listNetworkPageTargets(PORT, { signal: controller.signal, assertCurrent: () => undefined, deadline: AT + 600 }));
    await flush(); await vi.advanceTimersByTimeAsync(599); expect(observed.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1); await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
    for (const release of wire.state.pendingDiscovery.splice(0)) release(); await flush();
    expect(observed.state).toBe("rejected"); expect(wire.state.sockets).toEqual([]);
  });

  it("checks a late discovery await against its deadline even if the deadline timer has not run", async () => {
    wire.state.holdDiscovery = true;
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + 600 }));
    await flush(); vi.setSystemTime(AT + 601);
    for (const release of wire.state.pendingDiscovery.splice(0)) release(); await flush();
    expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
  });

  it("uses the SAME pre-discovery setup deadline for WS/enables/frame-tree, not five additional seconds", async () => {
    const deadline = AT + 5_000; const controller = new AbortController(); const guard = vi.fn(() => undefined);
    wire.state.holdDiscovery = true;
    const selected = watch(listNetworkPageTargets(PORT, { signal: controller.signal, assertCurrent: guard, deadline }));
    await flush(); await vi.advanceTimersByTimeAsync(4_000);
    for (const release of wire.state.pendingDiscovery.splice(0)) release(); await flush(); expect(selected.state).toBe("fulfilled");
    wire.state.held.add("Network.enable"); const run = start(selected.value![0], controller, guard, deadline); await flush();
    await vi.advanceTimersByTimeAsync(999); expect(run.result.state).toBe("pending");
    const value = await payload(run, 1 + LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "unavailable", stopReason: "setup-timeout", armedAt: null });
    socket().reply(command("Network.enable")); await flush(); expect(run.onArmed).not.toHaveBeenCalled();
  });

  it.each(["guard", "abort"] as const)("checks %s independently after discovery success instead of accepting a stale target list", async invalidation => {
    wire.state.holdDiscovery = true; const controller = new AbortController(); let current = true;
    const observed = watch(listNetworkPageTargets(PORT, { signal: controller.signal, assertCurrent: () => { if (!current) throw new Error(PRIVATE); }, deadline: AT + LIMITS.setupMs }));
    await flush(); if (invalidation === "guard") current = false; else controller.abort(PRIVATE);
    for (const release of wire.state.pendingDiscovery.splice(0)) release(); await flush();
    await vi.advanceTimersByTimeAsync(LIMITS.livenessMs);
    expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
  });

  it("never dispatches even the first setup command after the guard changes before socket-open", async () => {
    wire.state.autoOpen = false; let current = true;
    const guard = vi.fn(() => { if (!current) throw new Error(PRIVATE); });
    const run = start(target(), new AbortController(), guard); await flush(); current = false; socket().open();
    const value = await payload(run, LIMITS.livenessMs + LIMITS.cleanupMs);
    expect(wire.state.commands).toEqual([]); expect(run.onArmed).not.toHaveBeenCalled();
    expect(value.observation.stopReason).toBe("target-changed");
  });

  it.each(["Page.enable", "Network.enable", "Page.getFrameTree"].flatMap(method => ["guard", "abort"].map(invalidation => ({ method, invalidation }))))("checks $invalidation independently after awaited $method and before another wire/ARMED action", async ({ method, invalidation }) => {
    let current = true; let sentAtInvalidation = -1; const controller = new AbortController();
    wire.state.beforeAutoReply = call => {
      if (call.method === method) {
        sentAtInvalidation = wire.state.commands.length;
        if (invalidation === "guard") current = false; else controller.abort(PRIVATE);
      }
    };
    const run = start(target(), controller, vi.fn(() => { if (!current) throw new Error(PRIVATE); }));
    const value = await payload(run, LIMITS.cleanupMs + LIMITS.livenessMs);
    expect(run.onArmed).not.toHaveBeenCalled(); expect(value.observation.armedAt).toBeNull();
    expect(sentAtInvalidation).toBeGreaterThan(0); expect(wire.state.commands.length).toBe(sentAtInvalidation);
  });

  it("rechecks a silent armed observation's guard within25ms without relying on any network event", async () => {
    let current = true; const run = start(target(), new AbortController(), vi.fn(() => { if (!current) throw new Error(PRIVATE); }));
    await flush(); expect(run.onArmed).toHaveBeenCalledTimes(1); current = false;
    await vi.advanceTimersByTimeAsync(25); const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "target-changed" });
    expect(value.observation.durationMs).toBeLessThanOrEqual(25);
  });

  it("does not grant an extended observation window when late events beat its scheduled timer", async () => {
    const run = await arm(); vi.setSystemTime(AT + LIMITS.observeMs + 1);
    request(); response(NATIVE, 403); finish();
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.hops).toEqual([]); expect(value.observation.durationMs).toBe(10_000);
    expect(value.observation.counts.http4xx).toBe(0);
  });

  it("pre-aborted observation creates no connection and still returns an already-closeable internal handle", async () => {
    const controller = new AbortController(); controller.abort(PRIVATE); const run = start(target(), controller);
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "cancelled", stopReason: "cancelled", armedAt: null, durationMs: 0 });
    expect(wire.state.sockets).toEqual([]); expect(run.closed.state).toBe("fulfilled"); expect(run.handle.cleanupVerified).toBe(true);
  });

  it("pre-aborted discovery cannot issue HTTP", async () => {
    const controller = new AbortController(); controller.abort(PRIVATE);
    const observed = watch(listNetworkPageTargets(PORT, { signal: controller.signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error); expect(wire.state.http).toEqual([]);
  });
});

describe("discovery projection failures and owned cleanup acknowledgment", () => {
  it.each([PRIVATE, "null", "{}", "true", "42", `[{"private":"${PRIVATE}",`])("does not turn malformed discovery %# into an empty successful page list", async body => {
    wire.state.discoveryBody = body;
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
  });

  it.each(["id", "url", "webSocketDebuggerUrl"])("rejects an explicitly page-shaped discovery row missing %s", async key => {
    const row: Record<string, unknown> = discoveryRow(); delete row[key]; discovery([row]);
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
  });

  it("does not trust a decorated endpoint returned by discovery", async () => {
    discovery([discoveryRow(TARGET, ORIGIN, { webSocketDebuggerUrl: `${target().webSocketDebuggerUrl}?secret=${PRIVATE}` })]);
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error); expect(wire.state.sockets).toEqual([]);
  });

  it("bounds discovery HTTP JSON bytes including raw title/header data that would be discarded", async () => {
    discovery([discoveryRow(TARGET, ORIGIN, { title: PRIVATE.repeat(Math.ceil(LIMITS.maxDiscoveryBytes / PRIVATE.length) + 1) })]);
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
  });

  it("measures discovery JSON ingress in UTF-8 bytes, not JavaScript code units", async () => {
    discovery([discoveryRow(TARGET, ORIGIN, { title: "界".repeat(Math.floor(LIMITS.maxDiscoveryBytes / 2)) })]);
    expect(wire.state.discoveryBody.length).toBeLessThan(LIMITS.maxDiscoveryBytes);
    expect(Buffer.byteLength(wire.state.discoveryBody)).toBeGreaterThan(LIMITS.maxDiscoveryBytes);
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
  });

  it("applies the same byte bound across chunk boundaries rather than trusting a small first chunk", async () => {
    wire.state.discoveryChunks = ["[", JSON.stringify(discoveryRow()), ",", JSON.stringify(discoveryRow("second", ORIGIN, { title: PRIVATE.repeat(Math.ceil(LIMITS.maxDiscoveryBytes / PRIVATE.length)) })), "]"];
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
  });

  it.each([302, 401, 404, 500])("rejects discovery HTTP%s without following Location or borrowing another page", async status => {
    wire.state.discoveryStatus = status;
    const observed = watch(listNetworkPageTargets(PORT, { signal: new AbortController().signal, assertCurrent: () => undefined, deadline: AT + LIMITS.setupMs }));
    await flush(); expect(observed.state).toBe("rejected"); assertSafeError(observed.error);
    expect(wire.state.http).toHaveLength(1); expect(wire.state.sockets).toEqual([]);
  });

  it("closes only its diagnostic connection, never sends browser/target close, navigation, body or security commands", async () => {
    const run = await arm(); request(); response(); finish(); const owned = socket();
    await windowEnd(run);
    expect(owned.closeCalls + owned.terminateCalls).toBeGreaterThan(0);
    expect(wire.state.commands.map(call => call.method).sort()).toEqual([...PASSIVE_COMMANDS].sort());
    expect(wire.forbidden).not.toHaveBeenCalled();
    expect(run.closed.state).toBe("fulfilled"); expect(run.handle.cleanupVerified).toBe(true);
  });

  it("does not resolve closed merely because close()/terminate() were called; keeps a cleanup-unverified lease fact", async () => {
    wire.state.closeAck = false; wire.state.terminateAck = false;
    const run = await arm(); request(); response(); finish();
    await vi.advanceTimersByTimeAsync(LIMITS.observeMs); await flush();
    expect(run.closed.state).toBe("pending"); expect(run.handle.cleanupVerified).toBe(false);
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "cleanup-unverified" });
    expect(run.closed.state).toBe("pending"); expect(run.handle.cleanupVerified).toBe(false);
    expect(socket().closeCalls + socket().terminateCalls).toBeGreaterThan(0);
    expect(Date.now() - AT).toBeLessThan(20_000);
    socket().serverClose(); await flush();
    expect(run.closed.state).toBe("fulfilled"); expect(run.handle.cleanupVerified).toBe(true);
    expect(run.result.value).toEqual(value); expect(value.observation.stopReason).toBe("cleanup-unverified");
  });

  it("can verify closure by terminating this owned socket within the cleanup budget", async () => {
    wire.state.closeAck = false; wire.state.terminateAck = true;
    const run = await arm(); request(); response(); finish();
    const value = await windowEnd(run);
    expect(socket().terminateCalls).toBeGreaterThan(0); expect(run.closed.state).toBe("fulfilled"); expect(run.handle.cleanupVerified).toBe(true);
    expect(value.observation.stopReason).toBe("window-ended"); expect(value.observation.completion).toBe("completed");
  });

  it("does not mutate returned facts or announce ARMED again when late messages arrive after owned closure", async () => {
    const run = await arm(); request(); response(); finish(); const selected = socket();
    const value = await windowEnd(run); const before = JSON.stringify(value);
    selected.event("Network.loadingFailed", { requestId: NATIVE, errorText: PRIVATE });
    selected.event("Network.responseReceivedExtraInfo", { requestId: NATIVE, statusCode: 503, headers: { raw: PRIVATE } });
    selected.reply(command("Page.getFrameTree"), { frameTree: { frame: { id: PRIVATE, url: PRIVATE } } });
    await vi.advanceTimersByTimeAsync(25); await flush();
    expect(JSON.stringify(value)).toBe(before); expect(run.onArmed).toHaveBeenCalledTimes(1); expect(run.handle.cleanupVerified).toBe(true);
  });
});

// Four static-review counterexamples. These cases must be observed failing on
// the unfixed modules in a retained serialized RED before production changes.
describe("reviewed protocol regressions", () => {
  it("review F1 — excludes and retracts child-frame-only request evidence instead of contaminating a quiet main frame", async () => {
    wire.state.held.add("Audits.enable");
    const run = start(); await flush();
    const prearmedChild = `${NATIVE}-prearmed-child`, laterScopedChild = `${NATIVE}-later-scoped-child`;
    request(prearmedChild, { frameId: "child-frame" });
    socket().reply(command("Audits.enable")); await flush();
    expect(run.onArmed).toHaveBeenCalledTimes(1);
    // A response identifies the initiating frame even though its destination
    // has the SAME origin as the selected page. Future frame-less events must
    // inherit that out-of-scope identity, not become unknown main-frame facts.
    response(prearmedChild, 403, { frameId: "child-frame" }); extra(prearmedChild, 403); finish(prearmedChild);
    // Extra-info has no frame field and can precede the event proving scope.
    // Once the child response arrives, earlier unscoped status/terminal facts
    // must be retracted rather than leaving a sticky partial/unattributed count.
    extra(laterScopedChild, 429); finish(laterScopedChild);
    response(laterScopedChild, 429, { frameId: "child-frame" });
    const value = await windowEnd(run);
    expect(value.httpStatusEvidence).toEqual([]); expect(value.hops).toEqual([]);
    expect(value.observation.counts).toEqual(Object.fromEntries(COUNT_KEYS.map(key => [key, 0])));
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended", durationMs: 10_000 });
    expect(value.observation.coverage.network).toBe("observed");
  });

  it("review F2 — unattributable CSP issues do not claim main-frame coverage or consume its projection budget", async () => {
    const run = await arm();
    for (let index = 0; index < LIMITS.maxProjections; index++) {
      // These are documented fields, not an invented affected-frame property.
      // Even ROOT as frameAncestor describes an ancestor, not the violated
      // document; neither source URL nor BackendNodeId proves main-frame scope.
      const ancestor = index % 3 === 0 ? {} : { frameAncestor: { frameId: index % 3 === 1 ? "child-frame" : ROOT } };
      socket().event("Audits.issueAdded", { issue: {
        code: "ContentSecurityPolicyIssue", issueId: `${PRIVATE}-unscoped-csp-${index}`,
        details: { contentSecurityPolicyIssueDetails: {
          blockedURL: `${ORIGIN}/${PRIVATE}`, violatedDirective: "script-src", isReportOnly: false,
          contentSecurityPolicyViolationType: "kURLViolation", sourceCodeLocation: { url: `${ORIGIN}/${PRIVATE}`, lineNumber: 1, columnNumber: 1 },
          violatingNodeId: 19, ...ancestor,
        } },
      } });
    }
    request(); response(); finish();
    const value = await windowEnd(run);
    expect(value.observation.counts.cspIssues).toBe(0);
    expect(value.observation.coverage.csp).toBe("unavailable");
    expect(value.observation.counts).toMatchObject({ requests: 1, responses: 1, finished: 1, unattributed: 0 });
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended", durationMs: 10_000 });

    // The opposite assertion also holds after REAL network projections exhaust
    // the budget. Interleaved unqualified CSP issues cannot spend that budget,
    // become hidden counts, or acquire a coverage claim at the stopping edge.
    const capped = start(); await flush(); expect(capped.onArmed).toHaveBeenCalledTimes(1);
    const owned = wire.state.sockets.at(-1)!;
    const unattributableIssue = { issue: { code: "ContentSecurityPolicyIssue", details: { contentSecurityPolicyIssueDetails: {
      violatedDirective: "script-src", isReportOnly: false, contentSecurityPolicyViolationType: "kURLViolation",
      frameAncestor: { frameId: ROOT }, sourceCodeLocation: { url: `${ORIGIN}/${PRIVATE}`, lineNumber: 1, columnNumber: 1 }, violatingNodeId: 19,
    } } } };
    for (let index = 0; index < LIMITS.maxProjections; index++) {
      owned.event("Audits.issueAdded", unattributableIssue);
      owned.event("Network.responseReceivedExtraInfo", { requestId: `${NATIVE}-budget-${index}`, statusCode: 200,
        headers: { "X-Private": PRIVATE }, headersText: PRIVATE, blockedCookies: [], resourceIPAddressSpace: "Public" });
    }
    owned.event("Audits.issueAdded", unattributableIssue);
    const limited = await payload(capped, LIMITS.cleanupMs);
    expect(limited.observation).toMatchObject({ completion: "partial", stopReason: "limit-exceeded" });
    expect(limited.httpStatusEvidence).toHaveLength(LIMITS.maxProjections);
    expect(limited.observation.counts).toMatchObject({ cspIssues: 0, unattributed: LIMITS.maxProjections });
    expect(limited.observation.coverage.csp).toBe("unavailable");
    owned.event("Audits.issueAdded", unattributableIssue); await flush();
    expect(limited.observation.counts.cspIssues).toBe(0); expect(limited.observation.coverage.csp).toBe("unavailable");
  });

  it("review F3 — a redirect rejected by the detail cap cannot uniquely assign wire status to the lone retained redirected hop", async () => {
    const run = await arm();
    const largeOrigin = `https://${"a".repeat(170_000)}.fixture.test`;
    request(NATIVE, { request: { url: `${largeOrigin}/first?${PRIVATE}`, method: "GET" } });
    extra(NATIVE, 429);
    request(NATIVE, {
      redirectResponse: rawResponse(302, { url: `${largeOrigin}/first?${PRIVATE}` }), redirectHasExtraInfo: true,
      request: { url: `${largeOrigin}/second?${PRIVATE}`, method: "GET" },
    });
    const value = await payload(run, LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "limit-exceeded" });
    expect(value.hops).toHaveLength(1);
    expect(value.hops[0]).toMatchObject({ status: 302, terminal: "redirected", networkStatus: null });
    expect(value.httpStatusEvidence).toHaveLength(1);
    expect(value.httpStatusEvidence[0]).toMatchObject({ status: 429, hopId: null, association: "unknown", chainId: value.hops[0].chainId });
    expect(value.observation.counts).toMatchObject({ requests: 1, redirects: 1, responses: 1, http4xx: 0, unattributed: 1 });
  });

  it("review F4 — accepts effective WebSocket port80 canonical forms without weakening endpoint authority checks", async () => {
    for (const endpoint of [`ws://127.0.0.1:80/devtools/page/${TARGET}`, `ws://127.0.0.1/devtools/page/${TARGET}`]) {
      const run = start({ ...target(), webSocketDebuggerUrl: endpoint }, new AbortController(), () => undefined, Date.now() + LIMITS.setupMs, 80);
      await flush(); expect(run.onArmed).toHaveBeenCalledTimes(1);
      expect(wire.state.sockets.at(-1)!.url).toBe(endpoint);
      const value = await windowEnd(run);
      expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended" });
    }
    const ownedSockets = wire.state.sockets.length;
    for (const endpoint of [
      `ws://127.0.0.1:81/devtools/page/${TARGET}`, `ws://${PRIVATE}@127.0.0.1:80/devtools/page/${TARGET}`,
      `ws://127.0.0.1:80/devtools/page/${TARGET}?${PRIVATE}`, `ws://127.0.0.1:80/devtools/page/${TARGET}#${PRIVATE}`,
      `ws://127.0.0.1:80/devtools/page/x/../${TARGET}`, `ws://127.0.0.1:80/devtools/browser/${TARGET}`,
    ]) {
      const run = start({ ...target(), webSocketDebuggerUrl: endpoint }, new AbortController(), () => undefined, Date.now() + LIMITS.setupMs, 80);
      const value = await payload(run, LIMITS.cleanupMs);
      expect(value.observation).toMatchObject({ completion: "unavailable", stopReason: "setup-rejected", armedAt: null });
      expect(run.onArmed).not.toHaveBeenCalled(); expect(wire.state.sockets).toHaveLength(ownedSockets);
    }
  });
});

// Acceptance discriminator, authored without changing production or executing
// these cases. A quiet time gap is NOT itself association ambiguity. The only
// ambiguity introduced below is the explicitly unobserved request-start boundary.
describe("single cross-origin CORS hop — delayed extra-info versus actual boundary ambiguity", () => {
  const orders = (["Fetch", "XHR"] as const).flatMap(resourceType => (["before", "after"] as const).map(order => ({ resourceType, order })));
  function crossOriginStart(resourceType: "Fetch" | "XHR") {
    request(NATIVE, { type: resourceType, request: {
      url: `${THIRD_PARTY}/single-cors-control?${PRIVATE}`, method: "GET", headers: { Accept: "application/json" },
    } });
  }
  function browserCorsSuccess(resourceType: "Fetch" | "XHR") {
    response(NATIVE, 200, { type: resourceType, hasExtraInfo: true, response: rawResponse(200, {
      url: `${THIRD_PARTY}/single-cors-control?${PRIVATE}`, headers: { "Access-Control-Allow-Origin": ORIGIN },
    }) });
  }
  function browserCorsFailure(resourceType: "Fetch" | "XHR") {
    fail(NATIVE, { type: resourceType, corsErrorStatus: { corsError: "MissingAllowOriginHeader", failedParameter: PRIVATE } });
  }
  async function exactWindowEnd(run: Run) {
    const remaining = AT + LIMITS.observeMs - Date.now();
    expect(remaining).toBeGreaterThan(0);
    const value = await payload(run, remaining + LIMITS.cleanupMs);
    expect(value.observation).toMatchObject({ armedAt: AT, endedAt: AT + 10_000, durationMs: 10_000 });
    expect(value.hops).toHaveLength(1);
    expect(value.observation.counts.hops).toBe(value.hops.length);
    expect(value.observation.counts.requests).toBe(1);
    expect(run.handle.cleanupVerified).toBe(true); expect(run.closed.state).toBe("fulfilled");
    return value;
  }

  it.each(orders)("one A→B $resourceType success with extra-info delayed $order responseReceived remains a completed single-hop window", async ({ resourceType, order }) => {
    const run = await arm(); crossOriginStart(resourceType);
    await vi.advanceTimersByTimeAsync(600);
    if (order === "before") extra(NATIVE, 200); else browserCorsSuccess(resourceType);
    await vi.advanceTimersByTimeAsync(900);
    if (order === "before") browserCorsSuccess(resourceType); else finish();
    await vi.advanceTimersByTimeAsync(500);
    if (order === "before") finish(); else extra(NATIVE, 200);
    // No intervening request or response exists: only the one selected-main
    // request to B, with quiet elapsed time separating response and extra-info.
    const value = await exactWindowEnd(run); const hop = value.hops[0];
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended" });
    expect(value.observation.coverage.network).toBe("observed");
    expect(value.observation.counts).toMatchObject({ hops: 1, responses: 1, finished: 1, failed: 0, pending: 0, http4xx: 0, http5xx: 0, unattributed: 0 });
    expect(hop).toMatchObject({ origin: THIRD_PARTY, method: "GET", resourceType, status: 200, networkStatus: 200, terminal: "finished" });
    expect(value.httpStatusEvidence).toEqual([{ id: expect.any(String), chainId: hop.chainId, hopId: hop.id, status: 200, source: "extra-info", association: "unique" }]);
  });

  it.each(["Fetch", "XHR"] as const)("one A→B %s with extra-info before its observed start is partial, but keeps browser200 and a reconciled one-hop inventory", async resourceType => {
    const run = await arm();
    await vi.advanceTimersByTimeAsync(300); extra(NATIVE, 200);
    await vi.advanceTimersByTimeAsync(700); crossOriginStart(resourceType);
    await vi.advanceTimersByTimeAsync(300); browserCorsSuccess(resourceType);
    await vi.advanceTimersByTimeAsync(500); finish();
    const value = await exactWindowEnd(run);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "evidence-incomplete" });
    expect(value.observation.coverage.network).toBe("partial");
    expect(value.observation.counts).toMatchObject({ hops: 1, responses: 1, finished: 1, failed: 0, pending: 0, http4xx: 0, http5xx: 0, unattributed: 1 });
    expect(value.hops[0]).toMatchObject({ origin: THIRD_PARTY, resourceType, status: 200, networkStatus: null, terminal: "finished" });
    expect(value.httpStatusEvidence).toHaveLength(1);
    expect(value.httpStatusEvidence[0]).toMatchObject({ status: 200, hopId: null, source: "extra-info", association: "unknown" });
  });

  it.each(orders)("one A→B $resourceType CORS failure with wire403 delayed $order loadingFailed and no responseReceived still completes its single-hop window", async ({ resourceType, order }) => {
    const run = await arm(); crossOriginStart(resourceType);
    await vi.advanceTimersByTimeAsync(600);
    if (order === "before") extra(NATIVE, 403); else browserCorsFailure(resourceType);
    await vi.advanceTimersByTimeAsync(1_400);
    if (order === "before") browserCorsFailure(resourceType); else extra(NATIVE, 403);
    // Deliberately no Network.responseReceived: wire403 must not be invented as
    // a browser status, nor confused with a proxy-native error or window cancel.
    const value = await exactWindowEnd(run); const hop = value.hops[0];
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended" });
    expect(value.observation.coverage.network).toBe("observed");
    expect(value.observation.counts).toMatchObject({ hops: 1, responses: 1, finished: 0, failed: 1, blocked: 0, requestCancelled: 0, pending: 0, http4xx: 1, http5xx: 0, unattributed: 0 });
    expect(hop).toMatchObject({ origin: THIRD_PARTY, resourceType, status: null, networkStatus: 403, terminal: "failed", errorCode: "ERR_FAILED", corsReason: "MissingAllowOriginHeader" });
    expect(value.httpStatusEvidence).toEqual([{ id: expect.any(String), chainId: hop.chainId, hopId: hop.id, status: 403, source: "extra-info", association: "unique" }]);
  });

  it.each(["Fetch", "XHR"] as const)("one A→B %s CORS failure with pre-start wire403 remains partial/unknown-hop evidence without a browser status or count mismatch", async resourceType => {
    const run = await arm();
    await vi.advanceTimersByTimeAsync(300); extra(NATIVE, 403);
    await vi.advanceTimersByTimeAsync(700); crossOriginStart(resourceType);
    await vi.advanceTimersByTimeAsync(1_000); browserCorsFailure(resourceType);
    const value = await exactWindowEnd(run);
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "evidence-incomplete" });
    expect(value.observation.coverage.network).toBe("partial");
    expect(value.observation.counts).toMatchObject({ hops: 1, responses: 0, finished: 0, failed: 1, blocked: 0, requestCancelled: 0, pending: 0, http4xx: 0, http5xx: 0, unattributed: 1 });
    expect(value.hops[0]).toMatchObject({ origin: THIRD_PARTY, resourceType, status: null, networkStatus: null, terminal: "failed", errorCode: "ERR_FAILED", corsReason: "MissingAllowOriginHeader" });
    expect(value.httpStatusEvidence).toHaveLength(1);
    expect(value.httpStatusEvidence[0]).toMatchObject({ status: 403, hopId: null, source: "extra-info", association: "unknown" });
  });

  it.each((["Fetch", "XHR"] as const).flatMap(resourceType => (["child-frame", "worker", "missing-frame"] as const).map(scope => ({ resourceType, scope }))))("one A→B $resourceType remains completed when late $scope proof retracts another request's extra-info", async ({ resourceType, scope }) => {
    const run = await arm(); crossOriginStart(resourceType);
    const filtered = `${NATIVE}-later-filtered-${scope}`;
    await vi.advanceTimersByTimeAsync(200); extra(filtered, 403);
    await vi.advanceTimersByTimeAsync(300);
    const frameId = scope === "child-frame" ? "child-frame" : scope === "missing-frame" ? undefined : ROOT;
    const loaderId = scope === "worker" ? "" : LOADER;
    request(filtered, { frameId, loaderId, type: resourceType, request: {
      url: `${ORIGIN}/scope-only-foreign-request?${PRIVATE}`, method: "GET", headers: { Accept: "application/json" },
    } });
    // The foreign destination matches A. Only the initiating frame/worker scope
    // excludes it; its earlier status plus all later frame-less events must go.
    await vi.advanceTimersByTimeAsync(200);
    response(filtered, 403, { frameId, loaderId, type: resourceType }); finish(filtered); extra(filtered, 403);
    await vi.advanceTimersByTimeAsync(300); browserCorsSuccess(resourceType);
    await vi.advanceTimersByTimeAsync(400); finish();
    await vi.advanceTimersByTimeAsync(600); extra(NATIVE, 200);
    const value = await exactWindowEnd(run); const hop = value.hops[0];
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended" });
    expect(value.observation.coverage.network).toBe("observed");
    expect(value.observation.counts).toMatchObject({ hops: 1, responses: 1, finished: 1, failed: 0, pending: 0, http4xx: 0, http5xx: 0, unattributed: 0 });
    expect(hop).toMatchObject({ origin: THIRD_PARTY, resourceType, status: 200, networkStatus: 200, terminal: "finished" });
    expect(value.httpStatusEvidence).toEqual([{ id: expect.any(String), chainId: hop.chainId, hopId: hop.id, status: 200, source: "extra-info", association: "unique" }]);
  });

  it.each(["Fetch", "XHR"] as const)("one fully observed A→B %s browser200 hop plus a truly unscoped extra-info item is partial despite its own extra-info being present", async resourceType => {
    const run = await arm(); crossOriginStart(resourceType);
    await vi.advanceTimersByTimeAsync(300); extra(`${NATIVE}-never-scoped`, 200);
    await vi.advanceTimersByTimeAsync(700); browserCorsSuccess(resourceType);
    await vi.advanceTimersByTimeAsync(500); finish();
    await vi.advanceTimersByTimeAsync(500); extra(NATIVE, 200);
    // No start/frame proof EVER arrives for the other status. Unlike a later
    // positively filtered request, it must remain explicit unknown-hop evidence.
    // The selected hop itself is fully terminated and has its promised status.
    const value = await exactWindowEnd(run); const hop = value.hops[0];
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "evidence-incomplete" });
    expect(value.observation.coverage.network).toBe("partial");
    expect(value.observation.counts).toMatchObject({ hops: 1, responses: 1, finished: 1, failed: 0, pending: 0, http4xx: 0, http5xx: 0, unattributed: 1 });
    expect(hop).toMatchObject({ origin: THIRD_PARTY, resourceType, status: 200, networkStatus: 200, terminal: "finished" });
    expect(value.httpStatusEvidence).toHaveLength(2);
    const unique = value.httpStatusEvidence.filter(item => item.association === "unique");
    const unknown = value.httpStatusEvidence.filter(item => item.association === "unknown");
    expect(unique).toHaveLength(1); expect(unknown).toHaveLength(1);
    expect(unique[0]).toMatchObject({ chainId: hop.chainId, hopId: hop.id, status: 200, source: "extra-info", association: "unique" });
    expect(unknown[0]).toMatchObject({ chainId: null, hopId: null, status: 200, source: "extra-info", association: "unknown" });
  });

  it.each(orders)("native03 missing-terminal control — A→B $resourceType browser200 and extra-info $order response stay pending/partial without loadingFinished", async ({ resourceType, order }) => {
    const run = await arm(); crossOriginStart(resourceType);
    await vi.advanceTimersByTimeAsync(600);
    if (order === "before") extra(NATIVE, 200); else browserCorsSuccess(resourceType);
    await vi.advanceTimersByTimeAsync(900);
    if (order === "before") browserCorsSuccess(resourceType); else extra(NATIVE, 200);
    // Do NOT deliver loadingFinished or loadingFailed before the window ends.
    // A Response/status resolving at headers is not a network terminal proof.
    const value = await exactWindowEnd(run); const hop = value.hops[0];
    expect(value.observation).toMatchObject({ completion: "partial", stopReason: "evidence-incomplete" });
    expect(value.observation.coverage.network).toBe("partial");
    expect(value.observation.counts).toEqual({
      requests: 1, hops: 1, responses: 1, finished: 0, failed: 0, blocked: 0, requestCancelled: 0,
      redirects: 0, http4xx: 0, http5xx: 0, pending: 1, cache: 0, serviceWorker: 0, unattributed: 1, cspIssues: 0,
    });
    expect(hop).toMatchObject({ origin: THIRD_PARTY, resourceType, status: 200, networkStatus: null, terminal: "pending", errorCode: null, blockedReason: null, corsReason: null });
    expect(value.httpStatusEvidence).toEqual([{ id: expect.any(String), chainId: hop.chainId, hopId: null, status: 200, source: "extra-info", association: "unknown" }]);
    const stoppedFacts = JSON.stringify(value);
    finish(); await flush(); // a terminal delivered AFTER close is outside this observation
    expect(JSON.stringify(value)).toBe(stoppedFacts);
  });

  it.each(["Fetch", "XHR"] as const)("native03 matched-finish control — later foreign/worker/missing-frame events cannot poison an admitted A→B %s ID", async resourceType => {
    const run = await arm(); crossOriginStart(resourceType);
    await vi.advanceTimersByTimeAsync(600); browserCorsSuccess(resourceType);
    await vi.advanceTimersByTimeAsync(900); extra(NATIVE, 200);
    // Adversarial same-ID packets exercise every proposed late ignored-set
    // poisoning route. They must not replace or remove the admitted root chain.
    request(NATIVE, { frameId: "child-frame" });
    request(NATIVE, { frameId: ROOT, loaderId: "" });
    request(NATIVE, { frameId: undefined });
    response(NATIVE, 403, { frameId: "child-frame" });
    const untilLastAcceptedMillisecond = AT + LIMITS.observeMs - 1 - Date.now();
    expect(untilLastAcceptedMillisecond).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(untilLastAcceptedMillisecond); finish();
    const value = await exactWindowEnd(run); const hop = value.hops[0];
    expect(value.observation).toMatchObject({ completion: "completed", stopReason: "window-ended" });
    expect(value.observation.coverage.network).toBe("observed");
    expect(value.observation.counts).toMatchObject({ requests: 1, hops: 1, responses: 1, finished: 1, failed: 0, pending: 0, http4xx: 0, unattributed: 0 });
    expect(hop).toMatchObject({ origin: THIRD_PARTY, resourceType, status: 200, networkStatus: 200, terminal: "finished" });
    expect(value.httpStatusEvidence).toEqual([{ id: expect.any(String), chainId: hop.chainId, hopId: hop.id, status: 200, source: "extra-info", association: "unique" }]);
  });
});
