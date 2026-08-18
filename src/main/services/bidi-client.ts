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

export interface BidiConnection {
  wsUrl: string;
  /** Send one BiDi command; resolves with `result`, rejects on protocol error. */
  send(method: string, params?: Record<string, any>, timeoutMs?: number): Promise<any>;
  close(): void;
  /** True after the socket closed or errored (all in-flight commands rejected). */
  closed: boolean;
}

export interface BidiConnectOpts {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
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

/**
 * Connect to a Firefox WebDriver BiDi endpoint and create a session
 * (`session.new`). The connection is short-lived by default; callers that need
 * persistence (preload injection at launch) keep it and close it when the
 * profile stops.
 */
export async function connectBidi(wsUrl: string, opts: BidiConnectOpts = {}): Promise<BidiConnection> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const normalized = normalizeBidiWebSocketUrl(wsUrl);
  const Ws = await getWsModule();
  if (!Ws) throw new Error("BiDi client unavailable (ws module missing)");

  let settled = false;
  let socket: any = null;
  let nextId = 1;
  let initReject: (e: Error) => void = () => {};
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let closedFlag = false;
  const rejectAll = (error: Error) => {
    closedFlag = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  const failInit = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(initTimer);
    try { socket?.close(); } catch { /* ignore */ }
    rejectAll(error);
    initReject(error);
  };

  const finishInit = () => {
    if (settled) return;
    settled = true;
    clearTimeout(initTimer);
  };

  const initTimer = setTimeout(() => failInit(new Error("BiDi connection timed out")), timeoutMs);

  return new Promise<BidiConnection>((resolveInit, reject) => {
    initReject = reject;
    try {
      socket = new Ws(normalized);
    } catch (e: any) {
      failInit(e);
      return;
    }

    socket.on("error", (err: Error) => {
      failInit(new Error("BiDi websocket error: " + err.message));
    });
    socket.on("close", () => {
      if (!settled) {
        failInit(new Error("BiDi connection closed before session start"));
      } else {
        rejectAll(new Error("BiDi connection closed"));
      }
    });

    const send = (method: string, params?: Record<string, any>, commandTimeoutMs = 15000): Promise<any> => {
      if (closedFlag && method !== "session.new") {
        return Promise.reject(new Error("BiDi connection is closed"));
      }
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`BiDi command ${method} timed out`));
        }, commandTimeoutMs);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        socket.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
      });
    };

    socket.on("message", (data: any) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg.id !== "number") return;
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message || "BiDi request failed"));
      } else {
        waiter.resolve(msg.result ?? {});
      }
    });

    socket.on("open", async () => {
      try {
        const result = await send("session.new", {
          capabilities: {
            alwaysMatch: {
              acceptInsecureCerts: true,
              unhandledPromptBehavior: { default: "dismiss" },
            },
          },
        }, timeoutMs);
        finishInit();
        resolveInit({
          wsUrl: normalized,
          send,
          close: () => {
            rejectAll(new Error("BiDi connection closed"));
            try { socket.close(); } catch { /* ignore */ }
          },
          get closed() { return closedFlag; },
        });
      } catch (e: any) {
        failInit(e);
      }
    });
  });
}

/** Return the first (top-level) browsing context id from the context tree. */
export async function bidiGetTopContext(conn: BidiConnection, timeoutMs = 8000): Promise<string> {
  const result = await conn.send("browsingContext.getTree", {}, timeoutMs);
  const contexts: any[] = result?.contexts || [];
  if (!contexts.length) throw new Error("Firefox has no browsing contexts yet");
  return contexts[0].context;
}

/** Navigate the top-level context to a URL, waiting for "interactive". */
export async function bidiNavigate(conn: BidiConnection, url: string, contextId: string | null = null, timeoutMs = 15000): Promise<void> {
  const context = contextId ?? await bidiGetTopContext(conn, timeoutMs);
  await conn.send("browsingContext.navigate", { context, url, wait: "interactive" }, timeoutMs);
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
export async function bidiEvaluateInContext(conn: BidiConnection, expression: string, contextId: string | null = null, timeoutMs = 15000): Promise<any> {
  const context = contextId ?? await bidiGetTopContext(conn, timeoutMs);
  const result = await conn.send("script.evaluate", {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  }, timeoutMs);
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

/** Write one cookie via `storage.setCookie`; returns true when stored. */
export async function bidiSetCookie(conn: BidiConnection, cookie: BidiCookie, timeoutMs = 10000): Promise<boolean> {
  const result = await conn.send("storage.setCookie", { cookie }, timeoutMs);
  return result?.success === true;
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