import { assertProtocolDispatchAllowed, captureProtocolDispatchGuard } from "./agent/dispatch-guard.js";
import { NavigationBudget } from "./agent/cdp-navigation-budget.js";
import { BrowserLoadTimeoutError, BrowserNavigationError, navigationConnectionClosed } from "./agent/cdp-navigation-errors.js";
import { beginSyncBidiMutation, type BidiMutationSettlement } from "./sync/bidi-mutation-settlement.js";

// ── WebDriver BiDi runtime client (Slice 79) ──
// The runtime bridge that gives Firefox profiles the managed capabilities
// Chromium gets natively from its patched build + CDP:
//   - `script.addPreloadScript` → managed fingerprint injection on every page;
//   - `script.evaluate`        → fingerprint capture / probes / diagnostics;
//   - `storage.getCookies / setCookie / deleteCookies` → runtime cookie ops;
//   - `browsingContext.*`      → context discovery + navigation.
//
// This mirrors how Roxy drives its real RoxyFirefox engine (Marionette/BiDi +
// user.js); the difference from Slice 78 is that we now speak the protocol
// instead of only parsing the announced endpoint.
//
// Honest scope note: this is a minimal BiDi surface, not a full WebDriver
// client. It covers exactly the commands the product needs and no more.

let _wsModulePromise: Promise<any> | null = null;
function getWsModule(): Promise<any> {
  if (!_wsModulePromise) {
    _wsModulePromise = import("ws").then((m: any) => m.default || m).catch((e: any) => {
      console.error("[bidi] ws module unavailable:", e.message);
      return null;
    });
  }
  return _wsModulePromise;
}

// ── Per-port long-lived session registry ──
// Firefox allows exactly ONE BiDi session per remote-debugging port (a second
// `session.new` fails with "session already started"). The launched profile's
// preload-carrying connection must therefore be shared: fingerprint capture,
// drift checks, cookie ops and agent tooling all route through it after
// launch, and fall back to a short-lived session only when none is registered.
const liveSessionsByPort = new Map<number, BidiConnection>();

/** Register the long-lived session bound to a profile's debug port. */
export function registerFirefoxSession(port: number, conn: BidiConnection): void {
  if (!Number.isInteger(port) || port < 1 || !conn) return;
  liveSessionsByPort.set(port, conn);
}

/** Drop the registered session for a port (profile stopping / launch failed). */
export function dropFirefoxSession(port: number): void {
  liveSessionsByPort.delete(port);
}

/**
 * The registered live session for a port, or null when absent/stale. A stale
 * entry (connection closed) is evicted so callers fall back to a fresh one.
 */
export function getRegisteredFirefoxSession(port: number): BidiConnection | null {
  const conn = liveSessionsByPort.get(port);
  if (!conn) return null;
  if (conn.closed) {
    liveSessionsByPort.delete(port);
    return null;
  }
  return conn;
}

export interface BidiEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export type BidiEventListener = (event: BidiEvent) => void | Promise<void>;

export interface BidiConnection {
  wsUrl: string;
  /** Send one BiDi command; resolves with `result`, rejects on protocol error. */
  send(method: string, params?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal): Promise<any>;
  /** Observe received events only; does not send session.subscribe or retain history. */
  onEvent?(listener: BidiEventListener): () => void;
  close(): void;
  /** True after the socket closed or errored (all in-flight commands rejected). */
  closed: boolean;
}

export interface BidiConnectOpts {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Validate that a BiDi WebSocket URL is a local loopback target. */
export function normalizeBidiWebSocketUrl(value: string, port?: number): string {
  const url = new URL(value);
  const hostOk = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "ws:" || !hostOk) {
    throw new Error("BiDi websocket target is not on a local loopback ws:// endpoint");
  }
  if (typeof port === "number" && Number(url.port) !== port) {
    throw new Error("BiDi websocket target is not on the expected loopback port");
  }
  url.hostname = "127.0.0.1";
  // Firefox announces `ws://127.0.0.1:PORT` (no path) and serves BiDi under
  // `/session` only; normalise so the parsed announcement connects for real.
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/session";
  return url.toString();
}

function bidiEndpointPort(normalizedWsUrl: string): number {
  const parsed = new URL(normalizedWsUrl);
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("BiDi websocket target has an invalid port");
  }
  return port;
}

/**
 * Connect to a Firefox WebDriver BiDi endpoint and create a session
 * (`session.new`). The connection is short-lived by default; callers that need
 * persistence (preload injection at launch) keep it and close it when the
 * profile stops.
 */
export async function connectBidi(wsUrl: string, opts: BidiConnectOpts = {}): Promise<BidiConnection> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const normalized = normalizeBidiWebSocketUrl(wsUrl);
  const endpointPort = bidiEndpointPort(normalized);
  if (opts.signal?.aborted) throw opts.signal.reason;
  assertProtocolDispatchAllowed(endpointPort);
  const Ws = await getWsModule();
  if (opts.signal?.aborted) throw opts.signal.reason;
  assertProtocolDispatchAllowed(endpointPort);
  if (!Ws) throw new Error("BiDi client unavailable (ws module missing)");

  let settled = false;
  let socket: any = null;
  let nextId = 1;
  let initReject: (e: Error) => void = () => {};
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error, terminalReply?: boolean) => void }>();
  // Sync mutations retain a terminal-reply witness even after the caller's
  // ordinary pending Promise has rejected. A socket failure cannot drain it.
  const mutations = new Map<number, BidiMutationSettlement>();
  let connection: BidiConnection | undefined;
  const eventListeners = new Set<BidiEventListener>();
  let closedFlag = false;
  const rejectAll = (error: Error) => {
    closedFlag = true;
    eventListeners.clear();
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  const abortInit = () => failInit(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("BiDi connection cancelled"));
  const failInit = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(initTimer);
    opts.signal?.removeEventListener("abort", abortInit);
    try { socket?.close(); } catch { /* ignore */ }
    rejectAll(error);
    initReject(error);
  };

  const finishInit = () => {
    if (settled) return;
    settled = true;
    clearTimeout(initTimer);
    opts.signal?.removeEventListener("abort", abortInit);
  };

  const initTimer = setTimeout(() => failInit(new Error("BiDi connection timed out")), timeoutMs);

  return new Promise<BidiConnection>((resolveInit, reject) => {
    initReject = reject;
    opts.signal?.addEventListener("abort", abortInit, { once: true });
    if (opts.signal?.aborted) { abortInit(); return; }
    try {
      assertProtocolDispatchAllowed(endpointPort);
      socket = new Ws(normalized);
    } catch (e: any) {
      failInit(e);
      return;
    }

    socket.on("error", (err: Error) => {
      const error = new Error("BiDi websocket error: " + err.message);
      if (!settled) failInit(error);
      else rejectAll(error);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      const details = ` (code=${code ?? "unknown"}, reason=${reason?.toString() ?? ""})`;
      if (!settled) {
        failInit(new Error("BiDi connection closed before session start" + details));
      } else {
        rejectAll(new Error("BiDi connection closed" + details));
      }
    });

    const send = (method: string, params?: Record<string, any>, commandTimeoutMs = 15000, signal?: AbortSignal): Promise<any> => {
      if (closedFlag && method !== "session.new") return Promise.reject(new Error("BiDi connection is closed"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      assertProtocolDispatchAllowed(endpointPort);
      const guard = captureProtocolDispatchGuard();
      const mutation = method === "storage.setCookie" ? beginSyncBidiMutation(endpointPort, connection) : undefined;
      return new Promise((resolve, reject) => {
        const id = nextId++;
        if (mutation) {
          mutations.set(id, mutation);
          void mutation.done.then(() => { mutations.delete(id); });
        }
        let settled = false;
        let guardTimer: ReturnType<typeof setInterval> | undefined;
        const finish = (ok: boolean, value: any, terminalReply = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (guardTimer) clearInterval(guardTimer);
          pending.delete(id);
          signal?.removeEventListener("abort", aborted);
          if (ok) {
            try { guard?.(endpointPort); if (signal?.aborted) throw signal.reason; resolve(value); }
            catch (error) { mutation?.interrupt(error); reject(error); }
          } else { if (!terminalReply) mutation?.interrupt(value); reject(value); }
        };
        const aborted = () => finish(false, signal!.reason);
        const timer = setTimeout(() => finish(false, new Error(`BiDi command ${method} timed out`)), commandTimeoutMs);
        pending.set(id, { resolve: (value) => finish(true, value), reject: (error, terminalReply) => finish(false, error, terminalReply) });
        signal?.addEventListener("abort", aborted, { once: true });
        if (guard) guardTimer = setInterval(() => {
          try { guard(endpointPort); } catch (error) { finish(false, error); }
        }, 25);
        let dispatchAttempted = false;
        try {
          assertProtocolDispatchAllowed(endpointPort);
          if (signal?.aborted) throw signal.reason;
          const frame = JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) });
          dispatchAttempted = true;
          socket.send(frame);
        } catch (error) {
          if (!dispatchAttempted) mutation?.confirm(); // No command reached the transport.
          finish(false, error);
        }
      });
    };

    socket.on("message", (data: any) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      if (typeof msg.id !== "number") {
        if (!closedFlag && msg.id === undefined && typeof msg.method === "string" &&
            msg.params !== null && typeof msg.params === "object" && !Array.isArray(msg.params)) {
          const event: BidiEvent = { method: msg.method, params: msg.params };
          const listenerFailed = (error: unknown) => {
            console.warn("[bidi] event listener failed:", error instanceof Error ? error.message : String(error));
          };
          for (const listener of eventListeners) {
            if (closedFlag) break;
            try { Promise.resolve(listener(event)).catch(listenerFailed); }
            catch (error) { listenerFailed(error); }
          }
        }
        return;
      }
      const mutation = mutations.get(msg.id);
      if (mutation) {
        const terminal = (msg.type === "success" && Object.hasOwn(msg, "result") &&
          isBidiSetCookieResult(msg.result) && !Object.hasOwn(msg, "error")) ||
          (msg.type === "error" && typeof msg.error === "string" && msg.error.length > 0 &&
            typeof msg.message === "string" && !Object.hasOwn(msg, "result"));
        if (!terminal) {
          pending.get(msg.id)?.reject(new Error("Invalid BiDi mutation response envelope"));
          return;
        }
        // Observe the old wire reply even if abort/guard/deadline already rejected
        // its caller. It proves request completion, not business success/rollback.
        mutation.confirm();
      }
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (Object.hasOwn(msg, "error") || msg.type === "error") {
        const details = [typeof msg.error === "string" ? msg.error : msg.error?.error, msg.message, msg.error?.message]
          .filter((value): value is string => typeof value === "string" && value.length > 0);
        waiter.reject(new Error("BiDi request failed" + (details.length ? ": " + [...new Set(details)].join(": ") : "")), true);
      } else if ((msg.type !== undefined && msg.type !== "success") || !Object.hasOwn(msg, "result") ||
                 !msg.result || typeof msg.result !== "object" || Array.isArray(msg.result)) {
        waiter.reject(new Error("Invalid BiDi response envelope"));
      } else {
        waiter.resolve(msg.result);
      }
    });

    socket.on("open", async () => {
      try {
        const result = await send("session.new", {
          capabilities: {
            alwaysMatch: {
              acceptInsecureCerts: false,
              unhandledPromptBehavior: { default: "dismiss" },
            },
          },
        }, timeoutMs, opts.signal);
        // Re-check after the handshake await and before handing off a cached,
        // long-lived connection to the caller.
        assertProtocolDispatchAllowed(endpointPort);
        finishInit();
        connection = {
          wsUrl: normalized,
          send,
          onEvent: (listener) => {
            if (!closedFlag) eventListeners.add(listener);
            return () => { eventListeners.delete(listener); };
          },
          close: () => {
            rejectAll(new Error("BiDi connection closed"));
            try { socket.close(); } catch { /* ignore */ }
          },
          get closed() { return closedFlag; },
        };
        resolveInit(connection);
      } catch (e: any) {
        failInit(e);
      }
    });
  });
}

/** Return the first (top-level) browsing context id from the context tree. */
export async function bidiGetTopContext(conn: BidiConnection, timeoutMs = 8000, signal?: AbortSignal): Promise<string> {
  const result = await conn.send("browsingContext.getTree", {}, timeoutMs, signal);
  const contexts: any[] = result?.contexts || [];
  if (!contexts.length) throw new Error("Firefox has no browsing contexts yet");
  return contexts[0].context;
}

/** Interactive acceptance by default; callers may explicitly require complete readiness. */
export async function bidiNavigate(conn: BidiConnection, url: string, contextId: string | null = null, timeoutMs = 15000, wait: "interactive" | "complete" = "interactive"): Promise<void> {
  const port = bidiEndpointPort(normalizeBidiWebSocketUrl(conn.wsUrl));
  const budget = new NavigationBudget(timeoutMs, port,
    () => wait === "complete" ? new BrowserLoadTimeoutError() : new BrowserNavigationError("BROWSER_NAVIGATION_TIMEOUT", "Firefox navigation timed out"),
    () => { if (conn.closed) throw navigationConnectionClosed(); });
  try {
    const context = contextId ?? await budget.run(() => bidiGetTopContext(conn, budget.remaining(), budget.signal));
    budget.check();
    await budget.run(() => conn.send("browsingContext.navigate", { context, url, wait }, budget.remaining(), budget.signal));
    budget.check();
  } finally { budget.close(); }
}

/** Open a fresh tab (about:blank). The fingerprint preload applies to it. */
export async function bidiCreateContext(conn: BidiConnection, timeoutMs = 15000): Promise<string> {
  const result = await conn.send("browsingContext.create", { type: "tab" }, timeoutMs);
  const context: string = result?.context;
  if (!context) throw new Error("BiDi browsingContext.create returned no context id");
  return context;
}

/** Close a tab we opened (probe isolation — the user's page stays untouched). */
export async function bidiCloseContext(conn: BidiConnection, contextId: string, timeoutMs = 8000): Promise<void> {
  try {
    await conn.send("browsingContext.close", { context: contextId }, timeoutMs);
  } catch { /* the context may already be gone */ }
}

/** Bring a tab to the foreground so its page renders as an active tab (Firefox 127+). */
export async function bidiActivateContext(conn: BidiConnection, contextId: string, timeoutMs = 8000): Promise<void> {
  await conn.send("browsingContext.activate", { context: contextId }, timeoutMs);
}

/** Capture a PNG screenshot of the context viewport (result.data is base64). */
export async function bidiCaptureScreenshot(conn: BidiConnection, contextId: string | null = null, timeoutMs = 15000): Promise<string | null> {
  const context = contextId ?? await bidiGetTopContext(conn, timeoutMs);
  const result = await conn.send("browsingContext.captureScreenshot", { context, origin: "viewport" }, timeoutMs);
  return typeof result?.data === "string" ? result.data : null;
}

/** Drive the input pipeline (pointer/key actions) inside a context. */
export async function bidiPerformActions(conn: BidiConnection, contextId: string, actions: any[], timeoutMs = 15000): Promise<void> {
  await conn.send("input.performActions", { context: contextId, actions }, timeoutMs);
}

/** Type text into the focused element (input.insertText, no synthesis). */
export async function bidiInsertText(conn: BidiConnection, contextId: string, text: string, timeoutMs = 15000): Promise<boolean> {
  const result = await conn.send("input.insertText", { context: contextId, text }, timeoutMs);
  return result?.success !== false;
}

/**
 * Resolve a DOM element to its BiDi sharedId (resultOwnership: "root") whose
 * element handle `input.setFiles` can reference.
 */
export async function bidiEvaluateSharedId(conn: BidiConnection, expression: string, contextId: string, timeoutMs = 15000): Promise<string | null> {
  const result = await conn.send("script.evaluate", {
    expression,
    target: { context: contextId },
    awaitPromise: false,
    resultOwnership: "root",
  }, timeoutMs);
  return typeof result?.result?.sharedId === "string" ? result.result.sharedId : null;
}

/** Attach local files to a file input via its sharedId element reference. */
export async function bidiSetFiles(conn: BidiConnection, contextId: string, elementSharedId: string, files: string[], timeoutMs = 15000): Promise<boolean> {
  const result = await conn.send("input.setFiles", {
    context: contextId,
    element: { sharedId: elementSharedId },
    files,
  }, timeoutMs);
  return result?.success !== false;
}

/**
 * Evaluate a JS expression in the top-level context, awaiting promises.
 * Throws when the page throws (exceptionDetails), so callers see real failures.
 */
export async function bidiEvaluateInContext(conn: BidiConnection, expression: string, contextId: string | null = null, timeoutMs = 15000, signal?: AbortSignal): Promise<any> {
  const context = contextId ?? await bidiGetTopContext(conn, timeoutMs, signal);
  const result = await conn.send("script.evaluate", {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  }, timeoutMs, signal);
  const value = result?.result;
  if (!value) throw new Error("BiDi evaluate returned no result");
  if (value.type === "exception" || value.subtype === "error") {
    const message = value.exceptionDetails?.text || value.exception?.text || "page script threw";
    throw new Error("BiDi evaluate failed in page: " + message);
  }
  return unwrapBidiValue(value);
}

function unwrapBidiValue(value: any): any {
  if (value === null || value === undefined) return value;
  switch (value.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "boolean": case "number": case "bigint": case "string": return value.value;
    case "array":
      return Array.isArray(value.value) ? value.value.map(unwrapBidiValue) : [];
    case "object":
      return unwrapRemoteRecord(value.value, false);
    case "map":
      // Real BiDi serializer: object/map → array of [key, RemoteValue] pairs.
      return unwrapRemoteRecord(value.value, true);
    case "set":
      return Array.isArray(value.value) ? value.value.map(unwrapBidiValue) : [];
    case "regexp":
      return { pattern: value.value?.pattern, flags: value.value?.flags };
    case "date":
      return value.value ?? (value.internalId ? "date?:" + value.internalId : undefined);
    default:
      // Nested raw values (non-remote) arrive as plain JS: pass primitives
      // through, recurse into raw objects/arrays, else fall back to the
      // wrapped value.
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
      if (Array.isArray(value)) return value.map(unwrapBidiValue);
      if (value !== null && typeof value === "object" && !value.type) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrapBidiValue(v)]));
      }
      return value.value !== undefined ? value.value : null;
  }
}

/**
 * Decode the serialized representation of a BiDi object value. Real Firefox
 * emits records as arrays of [key, RemoteValue] pairs (e.g. the storage domain
 * of the spec); treat both that and plain records as the same thing.
 */
function unwrapRemoteRecord(value: unknown, asPairs: boolean): any {
  if (value === null || value === undefined) return value ?? null;
  const v = value as any;
  if (Array.isArray(v)) {
    const looksLikePairs = v.length === 0 || v.every((e) => Array.isArray(e) && e.length === 2);
    if (looksLikePairs) {
      const out: Record<string, any> = {};
      for (const [k, val] of v) out[String(k)] = unwrapBidiValue(val);
      return out;
    }
    return v.map(unwrapBidiValue);
  }
  if (typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, unwrapBidiValue(val)]));
  }
  return asPairs ? {} : v;
}

/**
 * Register a persistent preload script executed before every page load
 * (Firefox's BiDi equivalent of the patched Chromium `--fingerprint-*` hooks).
 * The raw statements are wrapped in a function by the protocol itself; we must
 * hand it a plain expression, and BiDi wraps it as `() => { expression }` when
 * the caller passes `functionDeclaration`. We build an IIFE-safe expression
 * here (the injection body is a statement list, so we use functionDeclaration).
 */
export async function bidiAddPreloadScript(conn: BidiConnection, body: string, timeoutMs = 15000): Promise<string | null> {
  const result = await conn.send("script.addPreloadScript", {
    functionDeclaration: `() => { ${body} }`,
  }, timeoutMs);
  return typeof result?.script === "string" ? result.script : null;
}

export type BidiCookie = {
  name: string;
  value: { type: "string"; value: string };
  domain: string;
  path: string;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none";
  expiry?: number;
};

/** Read all cookies Firefox knows about (BiDi `storage.getCookies`). */
export async function bidiGetCookies(conn: BidiConnection, timeoutMs = 10000): Promise<BidiCookie[]> {
  const result = await conn.send("storage.getCookies", {}, timeoutMs);
  const cookies: BidiCookie[] = result?.cookies || [];
  if (!Array.isArray(cookies)) return [];
  return cookies;
}

function isBidiSetCookieResult(result: any): boolean {
  const key = result?.partitionKey;
  return !!result && typeof result === "object" && !Array.isArray(result) &&
    Object.hasOwn(result, "partitionKey") && !Object.hasOwn(result, "error") && result.success !== false &&
    !!key && typeof key === "object" && !Array.isArray(key) &&
    (key.userContext === undefined || typeof key.userContext === "string") &&
    (key.sourceOrigin === undefined || typeof key.sourceOrigin === "string");
}

/** BiDi confirms a stored cookie with a partition key, not CDP's success flag. */
export async function bidiSetCookie(conn: BidiConnection, cookie: BidiCookie, timeoutMs = 10000, signal?: AbortSignal): Promise<boolean> {
  const result = await conn.send("storage.setCookie", { cookie }, timeoutMs, signal);
  return isBidiSetCookieResult(result);
}

/**
 * Delete matching cookies (domain / name filters) via `storage.deleteCookies`.
 * The protocol returns the affected partition keys (not a count), so we report
 * 1 when any partition reported deletions and 0 when nothing matched.
 */
export async function bidiDeleteCookies(conn: BidiConnection, filter: { domain?: string; name?: string }, timeoutMs = 10000): Promise<number> {
  const result = await conn.send("storage.deleteCookies", { filter }, timeoutMs);
  const partitionKeys: unknown[] = result?.partitionKey || [];
  return Array.isArray(partitionKeys) && partitionKeys.length > 0 ? 1 : 0;
}