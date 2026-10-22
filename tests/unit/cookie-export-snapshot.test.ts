// Native HTTP/WebSocket transport fixtures only: actual CDP/BiDi services,
// actual BiDi framing/client, actual engine dispatch and real private queue files.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import type { CookieInfo } from "../../src/main/types.js";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abs-cookie-export-snapshot-"));
  return {
    root, appData: path.join(root, "user-data"), port: 0,
    running: true, cdpPort: null as number | null, bidiPort: null as number | null,
    discovery: "pages" as "pages" | "empty" | "malformed" | "error" | "hang" | "json-hang" | "http-error" | "foreign" | "no-endpoint",
    moduleUnavailable: false, statusError: false, discoveryError: false,
    socketMode: "open" as "open" | "error" | "close" | "hold" | "throw",
    cdpResult: { cookies: [] } as unknown, bidiResult: { cookies: [] } as unknown,
    responses: new Map<string, { error?: unknown; result?: unknown; omitResult?: boolean; raw?: string }>(),
    holds: new Set<string>(), sendsThrow: new Set<string>(), setResults: [] as boolean[],
    calls: [] as Array<{ url: string; method: string; params: any }>,
    fetchCalls: [] as Array<{ url: string; signal?: AbortSignal }>,
    sockets: [] as any[], abortOnConstruct: null as null | (() => void),
    findCalls: [] as Array<[string, string]>,
  };
});
const CANARY = "synthetic-cookie-value--must-not-enter-reason";
vi.mock("electron", () => ({ app: { getPath: () => fixture.appData }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  statusBrowser: () => {
    if (fixture.statusError) throw new Error("synthetic-cookie-value--must-not-enter-reason");
    return { running: fixture.running, cdpPort: fixture.bidiPort };
  },
}));
vi.mock("../../src/main/services/process-discovery.js", () => ({
  findCdpPortSync: (id: string, profileDir: string) => {
    fixture.findCalls.push([id, profileDir]);
    if (fixture.discoveryError) throw new Error("synthetic-cookie-value--must-not-enter-reason");
    return fixture.cdpPort;
  },
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class NativeTransport extends EventEmitter {
    closed = false;
    constructor(readonly url: string) {
      super();
      if (fixture.socketMode === "throw") throw new Error("synthetic-cookie-value--must-not-enter-reason");
      fixture.sockets.push(this);
      fixture.abortOnConstruct?.();
      queueMicrotask(() => {
        if (this.closed) return;
        if (fixture.socketMode === "error") this.emit("error", new Error("synthetic-cookie-value--must-not-enter-reason"));
        else if (fixture.socketMode === "close") this.close();
        else if (fixture.socketMode !== "hold") this.emit("open");
      });
    }
    send(text: string): void {
      if (this.closed) throw new Error("fixture transport is closed");
      const request = JSON.parse(text);
      fixture.calls.push({ url: this.url, method: request.method, params: request.params });
      if (fixture.sendsThrow.has(request.method)) throw new Error("synthetic-cookie-value--must-not-enter-reason");
      if (fixture.holds.has(request.method)) return;
      const override = fixture.responses.get(request.method);
      let response: Record<string, unknown>;
      if (override?.error !== undefined) response = { id: request.id, error: override.error, message: "synthetic-cookie-value--must-not-enter-reason" };
      else if (override?.omitResult) response = { id: request.id };
      else if (override) response = { id: request.id, result: override.result };
      else if (request.method === "Network.getAllCookies") response = { id: request.id, result: fixture.cdpResult };
      else if (request.method === "storage.getCookies") response = { id: request.id, result: fixture.bidiResult };
      else if (request.method === "Network.setCookie") response = { id: request.id, result: { success: fixture.setResults.shift() ?? true } };
      else if (request.method === "storage.setCookie") response = { id: request.id, result: (fixture.setResults.shift() ?? true) ? { partitionKey: { userContext: "default" } } : {} };
      else response = { id: request.id, result: {} };
      queueMicrotask(() => { if (!this.closed) this.emit("message", Buffer.from(override?.raw ?? JSON.stringify(response))); });
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.emit("close", 1000, Buffer.from("owned transport fixture"));
    }
  }
  return {
    get default() {
      if (fixture.moduleUnavailable) throw new Error("synthetic-cookie-value--must-not-enter-reason");
      return NativeTransport;
    },
  };
});

const CHROMIUM = "ab_cookie_chromium", FIREFOX = "ab_cookie_firefox";
const EXPECTED: CookieInfo = { domain: ".example.test", name: "sid", value: CANARY, path: "/", expires: 1799999999, secure: true, httpOnly: true, sameSite: 1 };
const CDP_COOKIE = { ...EXPECTED, sameSite: "Lax", expires: 1799999999.75, size: 64, session: false };
const BIDI_COOKIE = { name: "sid", value: { type: "string", value: CANARY }, domain: ".example.test", path: "/", size: 64, secure: true, httpOnly: true, sameSite: "lax", expiry: 1799999999.75 };
let cdp: typeof import("../../src/main/services/cdp-cookie-service.js");
let bidi: typeof import("../../src/main/services/bidi-cookie-service.js");
let nativeBidi: typeof import("../../src/main/services/bidi-client.js");
const realSetTimeout = globalThis.setTimeout.bind(globalThis), realClearTimeout = globalThis.clearTimeout.bind(globalThis);
type Snapshot = { state: "available"; cookies: CookieInfo[] } | { state: "unavailable" | "cancelled"; reason: string };

// Direct new entry points: no legacy [] fallback can manufacture availability.
async function snapshot(engine: "chromium" | "firefox", signal?: AbortSignal, facade = false): Promise<Snapshot> {
  const id = engine === "firefox" ? FIREFOX : CHROMIUM;
  const service = facade ? bidi.runtimeCookieOps : engine === "firefox" ? bidi.firefoxCookieService : cdp.cdpCookieService;
  return service.exportCookiesSnapshot(id, signal);
}
function unavailable(result: Snapshot, state = "unavailable"): void {
  expect(result.state).toBe(state);
  expect(result).not.toHaveProperty("cookies");
  if (result.state === "available") throw new Error("availability was falsely asserted");
  expect(result.reason).toMatch(/^[a-z][a-z0-9_:-]*$/);
  expect(result.reason).not.toContain(CANARY);
}
function cookieMethod(engine: string): string { return engine === "firefox" ? "storage.getCookies" : "Network.getAllCookies"; }
async function turn(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await turn(); }
  throw new Error("owned native transport did not reach the expected stage");
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error("cookie snapshot did not settle after deadline/cancellation")), 100);
    })]);
  } finally { if (timer) realClearTimeout(timer); }
}

beforeAll(async () => {
  // Obtain an OS-assigned fixture port; native transports are mocked and never
  // connect to any actual browser or user-owned endpoint.
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  fixture.port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
});
beforeEach(async () => {
  vi.resetModules();
  fixture.running = true; fixture.cdpPort = fixture.port; fixture.bidiPort = fixture.port;
  fixture.discovery = "pages"; fixture.moduleUnavailable = false; fixture.statusError = false; fixture.discoveryError = false;
  fixture.socketMode = "open"; fixture.cdpResult = { cookies: [] }; fixture.bidiResult = { cookies: [] };
  fixture.responses.clear(); fixture.holds.clear(); fixture.sendsThrow.clear(); fixture.setResults = [];
  fixture.calls = []; fixture.fetchCalls = []; fixture.sockets = []; fixture.abortOnConstruct = null; fixture.findCalls = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    fixture.fetchCalls.push({ url: String(url), signal: init?.signal });
    if (fixture.discovery === "error") throw new Error(CANARY);
    if (fixture.discovery === "hang") {
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error(CANARY)), { once: true }));
    }
    return {
      ok: fixture.discovery !== "http-error", status: fixture.discovery === "http-error" ? 503 : 200,
      json: () => fixture.discovery === "json-hang" ? new Promise(() => undefined) : Promise.resolve(
        fixture.discovery === "empty" ? [] : fixture.discovery === "malformed" ? { pages: [] } : [{
          type: "page", webSocketDebuggerUrl: fixture.discovery === "no-endpoint" ? undefined : fixture.discovery === "foreign" ? "ws://example.test/devtools/page/fixture" : `ws://127.0.0.1:${fixture.port}/devtools/page/fixture`,
        }]),
    };
  }));
  fs.rmSync(fixture.appData, { recursive: true, force: true });
  cdp = await import("../../src/main/services/cdp-cookie-service.js");
  bidi = await import("../../src/main/services/bidi-cookie-service.js");
  nativeBidi = await import("../../src/main/services/bidi-client.js");
  const config = await import("../../src/main/services/config-manager.js");
  config.reloadConfig(); config.getConfig();
  const { transact } = await import("../../src/main/services/config/store.js");
  transact((draft) => {
    draft.browserProfiles[CHROMIUM] = { name: "Owned Chromium fixture", engine: "chromium", platform: "windows", fingerprintSeed: 12345 };
    draft.browserProfiles[FIREFOX] = { name: "Owned Firefox fixture", engine: "firefox", platform: "windows", fingerprintSeed: 12345 };
  });
  const stored = JSON.parse(fs.readFileSync(config.getConfigPath(), "utf8"));
  expect(stored.browserProfiles[FIREFOX].engine).toBe("firefox");
  config.reloadConfig();
  expect(config.getProfileMeta(CHROMIUM)?.engine).toBe("chromium");
  expect(config.getProfileMeta(FIREFOX)?.engine).toBe("firefox");
});
afterEach(async () => {
  fixture.abortOnConstruct = null;
  for (const socket of fixture.sockets) socket.close();
  await turn(); await turn();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const [id, directory] of fixture.findCalls) expect(directory).toBe(path.join(fixture.appData, "profiles", id));
});
afterAll(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

describe("cookie export snapshot availability", () => {
  it("exposes the richer method on both native services and the engine facade", () => {
    expect((cdp.cdpCookieService as any).exportCookiesSnapshot).toBeTypeOf("function");
    expect((bidi.firefoxCookieService as any).exportCookiesSnapshot).toBeTypeOf("function");
    expect((bidi.runtimeCookieOps as any).exportCookiesSnapshot).toBeTypeOf("function");
  });

  it.each(["chromium", "firefox"] as const)("demonstrates the retained legacy [] ambiguity through real %s service entry points", async (engine) => {
    const id = engine === "firefox" ? FIREFOX : CHROMIUM;
    const service = engine === "firefox" ? bidi.firefoxCookieService : cdp.cdpCookieService;
    const empty = await service.exportCookies(id);
    expect(fixture.calls.some((c) => c.method === cookieMethod(engine))).toBe(true);
    fixture.running = false; fixture.cdpPort = null;
    expect(await service.exportCookies(id)).toEqual(empty);
    expect(empty).toEqual([]);
  });

  it.each(["chromium", "firefox"] as const)("reports native successful empty %s cookies as available, not unavailable", async (engine) => {
    expect(await snapshot(engine)).toEqual({ state: "available", cookies: [] });
    expect(fixture.calls.some((c) => c.method === cookieMethod(engine))).toBe(true);
    expect(fixture.sockets.every((s) => s.closed)).toBe(true);
  });

  it.each(["chromium", "firefox"] as const)("retains validated native %s values and mappings without coercion", async (engine) => {
    fixture.cdpResult = { cookies: [CDP_COOKIE] }; fixture.bidiResult = { cookies: [BIDI_COOKIE] };
    expect(await snapshot(engine)).toEqual({ state: "available", cookies: [EXPECTED] });
    const service = engine === "firefox" ? bidi.firefoxCookieService : cdp.cdpCookieService;
    expect(await service.exportCookies(engine === "firefox" ? FIREFOX : CHROMIUM)).toEqual([EXPECTED]);
  });

  it.each(["chromium", "firefox"] as const)("does not turn a stopped %s profile into an authoritative empty snapshot", async (engine) => {
    fixture.running = false; fixture.cdpPort = null;
    unavailable(await snapshot(engine));
    expect(fixture.sockets).toHaveLength(0);
  });

  it.each(["chromium", "firefox"] as const)("reports missing %s endpoint as unavailable", async (engine) => {
    fixture.cdpPort = null; fixture.bidiPort = null;
    unavailable(await snapshot(engine));
    expect(fixture.sockets).toHaveLength(0);
  });

  it.each([0, -1, 65536, Number.NaN])("rejects invalid native endpoint port %s without network access", async (port) => {
    fixture.cdpPort = port; fixture.bidiPort = port;
    unavailable(await snapshot("chromium")); unavailable(await snapshot("firefox"));
    expect(fixture.fetchCalls).toHaveLength(0); expect(fixture.sockets).toHaveLength(0);
  });

  it.each(["chromium", "firefox"] as const)("contains %s discovery/status failures without leaking their error values", async (engine) => {
    fixture.discoveryError = true; fixture.statusError = true;
    unavailable(await snapshot(engine));
    expect(fixture.sockets).toHaveLength(0);
  });

  it.each(["empty", "malformed", "error", "http-error", "foreign", "no-endpoint"] as const)("rejects %s CDP page-context discovery without claiming empty success", async (discovery) => {
    fixture.discovery = discovery;
    unavailable(await snapshot("chromium"));
    expect(fixture.sockets).toHaveLength(0);
  });

  it.each(["chromium", "firefox"] as const)("reports missing native WebSocket module as %s unavailability", async (engine) => {
    fixture.moduleUnavailable = true;
    unavailable(await snapshot(engine));
    expect(fixture.sockets).toHaveLength(0);
  });

  it.each(["chromium", "firefox"] as const)("keeps %s protocol failures distinct from successful empty cookies", async (engine) => {
    fixture.responses.set(cookieMethod(engine), { error: { message: CANARY, error: "no such context" } });
    unavailable(await snapshot(engine));
    expect(fixture.sockets.every((s) => s.closed)).toBe(true);
  });

  it.each(["chromium", "firefox"] as const)("rejects %s replies with no native result object", async (engine) => {
    fixture.responses.set(cookieMethod(engine), { omitResult: true });
    unavailable(await snapshot(engine));
  });

  it.each([undefined, null, [], false, 7, {}, { cookies: null }, { cookies: {} }, { cookies: "[]" }, { cookies: [null] }].map((result) => ({ result })))(
    "rejects malformed native cookie response $result on both protocols", async ({ result }) => {
      fixture.cdpResult = result; fixture.bidiResult = result;
      unavailable(await snapshot("chromium"));
      unavailable(await snapshot("firefox"));
    },
  );

  it.each(["domain", "name", "value", "path", "secure", "httpOnly"])("rejects a malformed native cookie %s field instead of silently dropping/coercing a row", async (field) => {
    const c: any = { ...CDP_COOKIE }, b: any = { ...BIDI_COOKIE };
    c[field] = field === "secure" || field === "httpOnly" ? "true" : 17;
    b[field] = field === "secure" || field === "httpOnly" ? "true" : 17;
    fixture.cdpResult = { cookies: [CDP_COOKIE, c] }; fixture.bidiResult = { cookies: [BIDI_COOKIE, b] };
    unavailable(await snapshot("chromium")); unavailable(await snapshot("firefox"));
  });

  it.each([{ session: "true" }, { size: -1 }, { size: 0.5 }, { size: "64" }])("rejects malformed native CDP metadata %j", async (metadata) => {
    fixture.cdpResult = { cookies: [{ ...CDP_COOKIE, ...metadata }] };
    unavailable(await snapshot("chromium"));
  });

  it("rejects invalid expiry/SameSite and unsupported BiDi byte values", async () => {
    fixture.cdpResult = { cookies: [{ ...CDP_COOKIE, expires: "tomorrow" }] };
    unavailable(await snapshot("chromium"));
    fixture.cdpResult = { cookies: [{ ...CDP_COOKIE, sameSite: "unknown" }] };
    unavailable(await snapshot("chromium"));
    for (const cookie of [{ ...BIDI_COOKIE, expiry: "tomorrow" }, { ...BIDI_COOKIE, sameSite: "unknown" }, { ...BIDI_COOKIE, value: { type: "base64", value: "eA==" } }]) {
      fixture.bidiResult = { cookies: [cookie] }; unavailable(await snapshot("firefox"));
    }
  });

  it.each(["chromium", "firefox"] as const)("keeps valid nameless/session %s cookies rather than dropping them", async (engine) => {
    fixture.cdpResult = { cookies: [{ ...CDP_COOKIE, name: "", value: "", expires: -1, sameSite: undefined }] };
    fixture.bidiResult = { cookies: [{ ...BIDI_COOKIE, name: "", value: { type: "string", value: "" }, expiry: undefined }] };
    const result = await snapshot(engine);
    expect(result).toEqual({ state: "available", cookies: [{ ...EXPECTED, name: "", value: "", expires: null, sameSite: engine === "firefox" ? 1 : -1 }] });
  });

  it.each(["error", "close", "throw"] as const)("contains native socket %s on both protocols", async (mode) => {
    fixture.socketMode = mode;
    unavailable(await snapshot("chromium")); unavailable(await snapshot("firefox"));
  });

  it.each(["chromium", "firefox"] as const)("contains synchronous %s command send failure", async (engine) => {
    fixture.sendsThrow.add(cookieMethod(engine));
    unavailable(await snapshot(engine));
  });

  it.each(["Network.enable", "session.new"])("reports native %s handshake protocol failure as unavailable", async (method) => {
    fixture.responses.set(method, { error: { message: CANARY, error: "session not created" } });
    const engine = method === "session.new" ? "firefox" : "chromium";
    unavailable(await snapshot(engine));
    expect(fixture.calls.map((call) => call.method)).toEqual([method]);
    expect(fixture.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it.each(["chromium", "firefox"] as const)("never accepts unrelated/malformed %s wire replies as an empty snapshot", async (engine) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fixture.responses.set(cookieMethod(engine), { raw: JSON.stringify({ id: -99, result: { cookies: [] } }) });
    const pending = snapshot(engine);
    await until(() => fixture.calls.some((call) => call.method === cookieMethod(engine)));
    await vi.advanceTimersByTimeAsync(60_000);
    unavailable(await bounded(pending));
    expect(fixture.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it.each(["chromium", "firefox"] as const)("returns unavailable when %s native reply times out and closes the owned connection", async (engine) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fixture.holds.add(cookieMethod(engine));
    const pending = snapshot(engine);
    await until(() => fixture.calls.some((c) => c.method === cookieMethod(engine)));
    await vi.advanceTimersByTimeAsync(60_000);
    unavailable(await bounded(pending));
    expect(fixture.sockets.every((s) => s.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["hang", "json-hang"] as const)("bounds CDP %s discovery, not only WebSocket requests", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fixture.discovery = mode;
    const pending = snapshot("chromium");
    await until(() => fixture.fetchCalls.length > 0);
    await vi.advanceTimersByTimeAsync(60_000);
    unavailable(await bounded(pending));
    expect(fixture.fetchCalls[0].signal?.aborted).toBe(true);
    expect(fixture.sockets).toHaveLength(0);
  });

  it.each(["chromium", "firefox"] as const)("bounds a %s connection that never opens", async (engine) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fixture.socketMode = "hold";
    const pending = snapshot(engine);
    await until(() => fixture.sockets.length > 0);
    await vi.advanceTimersByTimeAsync(60_000);
    unavailable(await bounded(pending));
    expect(fixture.sockets.every((s) => s.closed)).toBe(true);
  });

  it.each(["chromium", "firefox"] as const)("returns a safe cancelled %s snapshot before any discovery or protocol dispatch", async (engine) => {
    const controller = new AbortController(); controller.abort(new Error(CANARY));
    unavailable(await snapshot(engine, controller.signal), "cancelled");
    expect(fixture.calls).toHaveLength(0); expect(fixture.fetchCalls).toHaveLength(0); expect(fixture.sockets).toHaveLength(0);
  });

  it.each(["chromium", "firefox"] as const)("returns cancelled during an in-flight %s cookie request, never available []", async (engine) => {
    fixture.holds.add(cookieMethod(engine));
    const controller = new AbortController(), pending = snapshot(engine, controller.signal);
    await until(() => fixture.calls.some((c) => c.method === cookieMethod(engine)));
    controller.abort(CANARY);
    unavailable(await bounded(pending), "cancelled");
    expect(fixture.sockets.every((s) => s.closed)).toBe(true);
  });

  it("cancels CDP discovery with its owned HTTP signal", async () => {
    fixture.discovery = "hang";
    const controller = new AbortController(), pending = snapshot("chromium", controller.signal);
    await until(() => fixture.fetchCalls.length > 0);
    controller.abort(CANARY);
    unavailable(await bounded(pending), "cancelled");
    expect(fixture.fetchCalls[0].signal?.aborted).toBe(true);
  });

  it.each(["chromium", "firefox"] as const)("contains cancellation during %s socket construction and suppresses later cookie commands", async (engine) => {
    const controller = new AbortController(); fixture.abortOnConstruct = () => controller.abort(CANARY);
    const pending = snapshot(engine, controller.signal);
    unavailable(await bounded(pending), "cancelled");
    await turn(); await turn();
    expect(fixture.calls.some((c) => c.method === cookieMethod(engine))).toBe(false);
    expect(fixture.sockets.every((s) => s.closed)).toBe(true);
  });

  it("routes snapshots through actual persisted profile engine lookup", async () => {
    fixture.cdpResult = { cookies: [CDP_COOKIE] }; fixture.bidiResult = { cookies: [] };
    expect(await snapshot("chromium", undefined, true)).toEqual({ state: "available", cookies: [EXPECTED] });
    expect(fixture.calls.map((c) => c.method)).toEqual(["Network.enable", "Network.getAllCookies"]);
    fixture.calls = [];
    expect(await snapshot("firefox", undefined, true)).toEqual({ state: "available", cookies: [] });
    expect(fixture.calls.map((c) => c.method)).toEqual(["session.new", "storage.getCookies"]);
  });

  it.each(["chromium", "firefox"] as const)("retains the legacy %s array interface and rejects cancellation with static text", async (engine) => {
    const controller = new AbortController(); controller.abort(CANARY);
    const service = engine === "firefox" ? bidi.firefoxCookieService : cdp.cdpCookieService;
    const exportUnbound = service.exportCookies;
    const id = engine === "firefox" ? FIREFOX : CHROMIUM;
    await expect(exportUnbound(id, controller.signal)).rejects.toThrow(/cancelled/i);
    fixture.responses.set(cookieMethod(engine), { error: { message: CANARY } });
    expect(await exportUnbound(id)).toEqual([]);
    expect(fixture.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("closes an owned Firefox connection completing after cancellation without sending cookie reads", async () => {
    fixture.socketMode = "hold";
    const controller = new AbortController(), pending = snapshot("firefox", controller.signal);
    await until(() => fixture.sockets.length > 0);
    controller.abort(CANARY);
    unavailable(await bounded(pending), "cancelled");
    fixture.sockets[0].emit("open");
    await until(() => fixture.sockets[0].closed);
    expect(fixture.calls.map((call) => call.method)).toEqual(["session.new"]);
  });

  it.each(["cancelled", "timeout"] as const)("does not close a borrowed Firefox session after %s", async (outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const conn = await nativeBidi.connectBidi(`ws://127.0.0.1:${fixture.port}/session`);
    nativeBidi.registerFirefoxSession(fixture.port, conn);
    fixture.holds.add("storage.getCookies");
    const controller = new AbortController(), pending = snapshot("firefox", controller.signal);
    try {
      await until(() => fixture.calls.some((call) => call.method === "storage.getCookies"));
      if (outcome === "cancelled") controller.abort(CANARY);
      else await vi.advanceTimersByTimeAsync(60_000);
      unavailable(await bounded(pending), outcome === "cancelled" ? "cancelled" : "unavailable");
      expect(conn.closed).toBe(false); expect(fixture.sockets).toHaveLength(1);
    } finally { nativeBidi.dropFirefoxSession(fixture.port); conn.close(); }
    await turn(); expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a registered Firefox connection without opening or closing somebody else's session", async () => {
    const conn = await nativeBidi.connectBidi(`ws://127.0.0.1:${fixture.port}/session`);
    nativeBidi.registerFirefoxSession(fixture.port, conn);
    fixture.calls = [];
    try {
      expect(await snapshot("firefox")).toEqual({ state: "available", cookies: [] });
      expect(fixture.calls.map((c) => c.method)).toEqual(["storage.getCookies"]);
      expect(fixture.sockets).toHaveLength(1); expect(conn.closed).toBe(false);
    } finally { nativeBidi.dropFirefoxSession(fixture.port); conn.close(); }
  });
});

describe("snapshot addition leaves coordinator cookie queue semantics intact", () => {
  it("round-trips normalized queue bytes through direct disk read, module reload and profile-ID lookup", async () => {
    const pending = [EXPECTED, { ...EXPECTED, name: "theme", value: "synthetic-theme" }];
    cdp.writeQueuedCookieImports(CHROMIUM, pending);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${CHROMIUM}.json`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(pending);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(cdp.readQueuedCookieImports(CHROMIUM)).toEqual(pending);
    vi.resetModules();
    const fresh = await import("../../src/main/services/cdp-cookie-service.js");
    expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual(pending);
    expect(fresh.readQueuedCookieImports(FIREFOX)).toEqual([]);
    expect(fs.readdirSync(path.dirname(file))).toEqual([`${CHROMIUM}.json`]);
  });

  it.each(["chromium", "firefox"] as const)("does not consume or rewrite the %s pending queue during any snapshot read", async (engine) => {
    const id = engine === "firefox" ? FIREFOX : CHROMIUM;
    cdp.writeQueuedCookieImports(id, [EXPECTED]);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${id}.json`), before = fs.readFileSync(file);
    expect(await snapshot(engine)).toEqual({ state: "available", cookies: [] });
    fixture.running = false; fixture.cdpPort = null;
    unavailable(await snapshot(engine));
    expect(fs.readFileSync(file)).toEqual(before); expect(cdp.readQueuedCookieImports(id)).toEqual([EXPECTED]);
    expect(fixture.calls.some((c) => /setCookie|deleteCookies/.test(c.method))).toBe(false);
  });

  it("waits within one queued-import call for a page appearing after two empty discoveries, then writes exactly once and clears the queue", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    cdp.writeQueuedCookieImports(CHROMIUM, [EXPECTED]);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${CHROMIUM}.json`);
    const before = fs.readFileSync(file);
    expect(JSON.parse(before.toString("utf8"))).toEqual([EXPECTED]);
    expect(cdp.readQueuedCookieImports(CHROMIUM)).toEqual([EXPECTED]);
    const discoveries: unknown[][] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      fixture.fetchCalls.push({ url: String(url), signal: init?.signal ?? undefined });
      // The page is NOT made visible before applyQueuedImports is called. Its
      // first two real service discovery attempts receive HTTP 200 + [].
      const pages = discoveries.length < 2 ? [] : [{
        type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${fixture.port}/devtools/page/fixture`,
      }];
      discoveries.push(pages);
      return { ok: true, status: 200, json: async () => pages } as Response;
    });
    fixture.setResults = [true];
    const pending = cdp.cdpCookieService.applyQueuedImports(CHROMIUM);
    await until(() => fixture.fetchCalls.length > 0);
    expect(discoveries[0]).toEqual([]);
    expect(fixture.calls).toEqual([]);
    expect(fs.readFileSync(file)).toEqual(before);
    // Advance only the existing 30s import budget, never a new call or a
    // pre-import readiness wait. Unchanged code settles to 0 after its first [].
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await bounded(pending)).toBe(1);
    expect(discoveries.map((pages) => pages.length)).toEqual([0, 0, 1]);
    expect(fixture.fetchCalls.every(({ url }) => url === `http://127.0.0.1:${fixture.port}/json`)).toBe(true);
    expect(fixture.calls.map(({ method }) => method)).toEqual(["Network.enable", "Network.setCookie"]);
    expect(fixture.calls[1].params).toMatchObject({
      domain: EXPECTED.domain, name: EXPECTED.name, value: EXPECTED.value, path: EXPECTED.path,
    });
    expect(fixture.sockets).toHaveLength(1);
    expect(fixture.sockets[0].closed).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.resetModules();
    const fresh = await import("../../src/main/services/cdp-cookie-service.js");
    expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual([]);
    expect(fs.readdirSync(path.dirname(file))).not.toContain(`${CHROMIUM}.json`);
  });

  it.each(["headers", "body"] as const)("includes held discovery %s in the original queued-import deadline, with zero writes and unchanged queue bytes", async (stage) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const queued = [EXPECTED, { ...EXPECTED, name: "theme", value: "synthetic-deadline-theme" }];
    cdp.writeQueuedCookieImports(CHROMIUM, queued);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${CHROMIUM}.json`);
    const before = fs.readFileSync(file);
    expect(JSON.parse(before.toString("utf8"))).toEqual(queued);
    expect(cdp.readQueuedCookieImports(CHROMIUM)).toEqual(queued);
    let releaseDiscovery: (() => void) | undefined;
    let bodyEntered = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      fixture.fetchCalls.push({ url: String(url), signal: init?.signal ?? undefined });
      if (stage === "headers") {
        return new Promise<Response>((resolve, reject) => {
          releaseDiscovery = () => resolve({ ok: true, status: 200, json: async () => [] } as Response);
          init?.signal?.addEventListener("abort", () => reject(new Error(CANARY)), { once: true });
        });
      }
      // Spend half the original budget before headers arrive. A fresh body or
      // WebSocket-only 30s timeout must not extend the operation to 45s+.
      await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
      return {
        ok: true, status: 200,
        json: () => {
          bodyEntered = true;
          return new Promise<unknown[]>((resolve) => { releaseDiscovery = () => resolve([]); });
        },
      } as Response;
    });
    let resolved: number | undefined;
    const pending = cdp.cdpCookieService.applyQueuedImports(CHROMIUM);
    void pending.then((count) => { resolved = count; }, () => undefined);
    try {
      await until(() => fixture.fetchCalls.length > 0);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(resolved).toBeUndefined();
      expect(bodyEntered).toBe(stage === "body");
      expect(fixture.calls).toEqual([]);
      expect(fixture.sockets).toHaveLength(0);
      expect(fs.readFileSync(file)).toEqual(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(await bounded(pending)).toBe(0);
      expect(fixture.fetchCalls[0].signal?.aborted).toBe(true);
      expect(fixture.calls).toEqual([]);
      expect(fixture.sockets).toHaveLength(0);
      expect(fs.readFileSync(file)).toEqual(before);
      expect(cdp.readQueuedCookieImports(CHROMIUM)).toEqual(queued);
      expect(vi.getTimerCount()).toBe(0);
      vi.resetModules();
      const fresh = await import("../../src/main/services/cdp-cookie-service.js");
      expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual(queued);
      expect(fs.readdirSync(path.dirname(file))).toContain(`${CHROMIUM}.json`);
    } finally {
      // Release only AFTER the deadline assertions. Even unchanged RED code
      // must retire its owned pending operation before the next test starts.
      releaseDiscovery?.();
      await bounded(pending.catch(() => 0));
    }
  });

  it.each(["chromium", "firefox"] as const)("preserves partial %s queued imports and clears only after all native writes succeed", async (engine) => {
    const id = engine === "firefox" ? FIREFOX : CHROMIUM;
    const pending = [EXPECTED, { ...EXPECTED, name: "theme" }];
    cdp.writeQueuedCookieImports(id, pending);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${id}.json`), before = fs.readFileSync(file);
    const service = engine === "firefox" ? bidi.firefoxCookieService : cdp.cdpCookieService;
    const { runningProcesses } = await import("../../src/main/services/browser/runtime-table.js");
    const conn = engine === "firefox" ? await nativeBidi.connectBidi(`ws://127.0.0.1:${fixture.port}/session`) : null;
    if (conn) {
      nativeBidi.registerFirefoxSession(fixture.port, conn);
      runningProcesses.set(id, { pid: 720001, process: { pid: 720001, exitCode: null, signalCode: null, killed: false },
        port: fixture.port, lastActivityAt: 0, engine: "firefox", bidiConn: conn });
    }
    try {
      fixture.setResults = [true, false];
      if (engine === "firefox") await expect(service.applyQueuedImports(id)).rejects.toThrow(/1\/2/);
      else expect(await service.applyQueuedImports(id)).toBe(1);
      expect(fs.readFileSync(file)).toEqual(before); expect(cdp.readQueuedCookieImports(id)).toEqual(pending);
      fixture.setResults = [true, true];
      expect(await service.applyQueuedImports(id)).toBe(2);
      expect(fs.existsSync(file)).toBe(false); expect(cdp.readQueuedCookieImports(id)).toEqual([]);
      if (conn) expect(conn.closed).toBe(false);
    } finally {
      if (conn) { nativeBidi.dropFirefoxSession(fixture.port); conn.close(); runningProcesses.delete(id); }
    }
  });

  it("retains exported normalizeCookieForQueue and does not relax its validation", () => {
    expect(cdp.normalizeCookieForQueue(EXPECTED)).toEqual(EXPECTED);
    expect(cdp.normalizeCookieForQueue({ ...EXPECTED, value: 17 })).toBeNull();
    expect(cdp.normalizeCookieForQueue({ ...EXPECTED, domain: "../unsafe" })).toBeNull();
    expect(cdp.normalizeCookieForQueue({ ...EXPECTED, name: "bad;name" })).toBeNull();
  });
});

describe("queued imports pinned to the captured runtime and strict queue reads", () => {
  function holdPageDiscovery(): () => void {
    let release: (() => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      fixture.fetchCalls.push({ url: String(url), signal: init?.signal ?? undefined });
      return new Promise<Response>((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => [{
          type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${fixture.port}/devtools/page/fixture`,
        }] } as Response);
      });
    });
    return () => release?.();
  }

  it.each(["null", "throws"] as const)("uses the pinned port for one native write even when process discovery %s", async (cache) => {
    cdp.writeQueuedCookieImports(CHROMIUM, [EXPECTED]);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${CHROMIUM}.json`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([EXPECTED]);
    fixture.cdpPort = null;
    fixture.discoveryError = cache === "throws";
    const count = await cdp.cdpCookieService.applyQueuedImports(CHROMIUM, {
      port: fixture.port, isCurrent: () => true,
    });
    expect(count).toBe(1);
    expect(fixture.findCalls).toEqual([]);
    expect(fixture.fetchCalls.map(({ url }) => url)).toEqual([`http://127.0.0.1:${fixture.port}/json`]);
    expect(fixture.calls.map(({ method }) => method)).toEqual(["Network.enable", "Network.setCookie"]);
    expect(fixture.calls[1].params).toMatchObject({ domain: EXPECTED.domain, name: EXPECTED.name, value: EXPECTED.value });
    expect(fixture.sockets).toHaveLength(1);
    expect(fixture.sockets[0].closed).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    vi.resetModules();
    const fresh = await import("../../src/main/services/cdp-cookie-service.js");
    expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual([]);
    expect(fs.readdirSync(path.dirname(file))).not.toContain(`${CHROMIUM}.json`);
  });

  it("suppresses native writes when the pinned owner becomes stale during discovery and preserves the entire queue", async () => {
    const queued = [EXPECTED, { ...EXPECTED, name: "theme", value: "synthetic-stale-theme" }];
    cdp.writeQueuedCookieImports(CHROMIUM, queued);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${CHROMIUM}.json`), before = fs.readFileSync(file);
    expect(JSON.parse(before.toString("utf8"))).toEqual(queued);
    const release = holdPageDiscovery();
    let current = true;
    const pending = cdp.cdpCookieService.applyQueuedImports(CHROMIUM, {
      port: fixture.port, isCurrent: () => current,
    });
    try {
      await until(() => fixture.fetchCalls.length > 0);
      current = false;
      release();
      expect(await bounded(pending)).toBe(0);
      expect(fixture.calls.filter(({ method }) => /setCookie|deleteCookies/.test(method))).toEqual([]);
      expect(fixture.sockets.every((socket) => socket.closed)).toBe(true);
      expect(fs.readFileSync(file)).toEqual(before);
      expect(cdp.readQueuedCookieImports(CHROMIUM)).toEqual(queued);
      vi.resetModules();
      const fresh = await import("../../src/main/services/cdp-cookie-service.js");
      expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual(queued);
      expect(fs.readdirSync(path.dirname(file))).toContain(`${CHROMIUM}.json`);
    } finally { release(); await bounded(pending.catch(() => 0)); }
  });

  it("does not let a completed old import clear a replacement queue written while discovery was pending", async () => {
    cdp.writeQueuedCookieImports(CHROMIUM, [EXPECTED]);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${CHROMIUM}.json`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([EXPECTED]);
    const release = holdPageDiscovery();
    const pending = cdp.cdpCookieService.applyQueuedImports(CHROMIUM, {
      port: fixture.port, isCurrent: () => true,
    });
    try {
      await until(() => fixture.fetchCalls.length > 0);
      const replacement = [{ ...EXPECTED, name: "replacement", value: "synthetic-new-queued-cookie" }];
      cdp.writeQueuedCookieImports(CHROMIUM, replacement);
      const replacementBytes = fs.readFileSync(file);
      expect(JSON.parse(replacementBytes.toString("utf8"))).toEqual(replacement);
      expect(cdp.readQueuedCookieImports(CHROMIUM)).toEqual(replacement);
      release();
      expect(await bounded(pending)).toBe(1);
      const writes = fixture.calls.filter(({ method }) => method === "Network.setCookie");
      expect(writes).toHaveLength(1);
      expect(writes[0].params).toMatchObject({ name: EXPECTED.name, value: EXPECTED.value });
      expect(fixture.sockets.every((socket) => socket.closed)).toBe(true);
      expect(fs.readFileSync(file)).toEqual(replacementBytes);
      vi.resetModules();
      const fresh = await import("../../src/main/services/cdp-cookie-service.js");
      expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual(replacement);
      expect(fs.readdirSync(path.dirname(file))).toContain(`${CHROMIUM}.json`);
    } finally { release(); await bounded(pending.catch(() => 0)); }
  });

  it("strictly rejects malformed JSON, shape, Cookie and path with a static non-leaking error while retaining one-argument compatibility", async () => {
    cdp.writeQueuedCookieImports(CHROMIUM, [EXPECTED]);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${CHROMIUM}.json`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([EXPECTED]);
    const corruptions = [
      { text: `{${CANARY}`, legacy: [] },
      { text: JSON.stringify({ cookies: [EXPECTED], extra: CANARY }), legacy: [] },
      { text: JSON.stringify([EXPECTED, { ...EXPECTED, value: 17 }]), legacy: [EXPECTED] },
    ];
    for (const { text, legacy } of corruptions) {
      fs.writeFileSync(file, text, "utf8");
      expect(fs.readFileSync(file, "utf8")).toBe(text);
      vi.resetModules();
      const fresh = await import("../../src/main/services/cdp-cookie-service.js");
      // Exact static text also proves the error contains no cookie Canary,
      // provider error, raw queue JSON, or filesystem path.
      expect(() => fresh.readQueuedCookieImports(CHROMIUM, { strict: true })).toThrow(/^COOKIE_QUEUE_UNREADABLE$/);
      expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual(legacy);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
      expect(fs.readdirSync(path.dirname(file))).toContain(`${CHROMIUM}.json`);
    }
    // An owned directory at the file path tests path rejection without any
    // symlink or reading outside this fixture's already-isolated storage root.
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(fs.lstatSync(file).isDirectory()).toBe(true);
    vi.resetModules();
    const fresh = await import("../../src/main/services/cdp-cookie-service.js");
    expect(() => fresh.readQueuedCookieImports(CHROMIUM, { strict: true })).toThrow(/^COOKIE_QUEUE_UNREADABLE$/);
    expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual([]);
    expect(fs.lstatSync(file).isDirectory()).toBe(true);
    expect(fixture.calls).toEqual([]);
    expect(fixture.fetchCalls).toEqual([]);
  });

  it("rejects a guarded import whose queue becomes partially unreadable during discovery instead of filtering it equal and clearing evidence", async () => {
    cdp.writeQueuedCookieImports(CHROMIUM, [EXPECTED]);
    const file = path.join(fixture.appData, "pending-cookie-imports", `${CHROMIUM}.json`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([EXPECTED]);
    expect(cdp.readQueuedCookieImports(CHROMIUM, { strict: true })).toEqual([EXPECTED]);
    const release = holdPageDiscovery();
    const pending = cdp.cdpCookieService.applyQueuedImports(CHROMIUM, {
      port: fixture.port, isCurrent: () => true,
    });
    try {
      await until(() => fixture.fetchCalls.length > 0);
      const corrupted = Buffer.from(JSON.stringify([EXPECTED, null]), "utf8");
      // Corrupt only this owned raw queue AFTER the original [EXPECTED] was
      // captured. The legacy reader still filters null to [EXPECTED], which
      // must never establish guarded clear-before-completion equality.
      fs.writeFileSync(file, corrupted);
      expect(fs.readFileSync(file)).toEqual(corrupted);
      expect(cdp.readQueuedCookieImports(CHROMIUM)).toEqual([EXPECTED]);
      release();
      await expect(bounded(pending)).rejects.toThrow(/^COOKIE_QUEUE_UNREADABLE$/);
      const writes = fixture.calls.filter(({ method }) => method === "Network.setCookie");
      expect(writes.length).toBeLessThanOrEqual(1);
      if (writes.length) expect(writes[0].params).toMatchObject({ name: EXPECTED.name, value: EXPECTED.value });
      expect(fixture.sockets.every((socket) => socket.closed)).toBe(true);
      expect(fs.readFileSync(file)).toEqual(corrupted);
      vi.resetModules();
      const fresh = await import("../../src/main/services/cdp-cookie-service.js");
      expect(() => fresh.readQueuedCookieImports(CHROMIUM, { strict: true })).toThrow(/^COOKIE_QUEUE_UNREADABLE$/);
      expect(fresh.readQueuedCookieImports(CHROMIUM)).toEqual([EXPECTED]);
      expect(fs.readFileSync(file)).toEqual(corrupted);
      expect(fs.readdirSync(path.dirname(file))).toContain(`${CHROMIUM}.json`);
    } finally { release(); await bounded(pending.catch(() => 0)); }
  });
});
