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
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let closedFlag = false;
  const rejectAll = (error: Error) => {
    closedFlag = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  const finishInit = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(initTimer);
    if (error) {
      try { socket?.close(); } catch { /* ignore */ }
      rejectAll(error);
    }
  };

  const initTimer = setTimeout(() => finishInit(new Error("BiDi connection timed out")), timeoutMs);

  return new Promise<BidiConnection>((resolveInit, rejectInit) => {
    try {
      socket = new Ws(normalized);
    } catch (e: any) {
      finishInit(e);
      rejectInit(e);
      return;
    }

    socket.on("error", (err: Error) => {
      rejectAll(new Error("BiDi websocket error: " + err.message));
      finishInit();
    });
    socket.on("close", () => {
      rejectAll(new Error("BiDi connection closed"));
      finishInit();
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
        finishInit(e);
        rejectInit(e);
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
  switch (value.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "boolean": case "number": case "bigint": return value.value;
    case "string": return value.value;
    case "array":
      return Array.isArray(value.value) ? value.value.map(unwrapBidiValue) : [];
    case "object":
      return value.value === null ? null : Object.fromEntries(Object.entries(value.value).map(([k, v]) => [k, unwrapBidiValue(v)]));
    default:
      return value.value !== undefined ? value.value : null;
  }
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