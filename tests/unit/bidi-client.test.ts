// Unit tests for the WebDriver BiDi runtime bridge (Slice 79):
//   - bidi-client: session.new handshake, command/response correlation,
//     result unwrapping, preload registration, storage cookie ops;
//   - page-eval: engine routing (firefox → BiDi, chromium → CDP error path).
// A real local WebSocket server stands in for Firefox so the wire protocol
// (JSON-RPC-ish {id, method, params} + {id, result}) is exercised for real.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { WebSocketServer } from "ws";

import {
  connectBidi,
  bidiAddPreloadScript,
  bidiGetCookies,
  bidiSetCookie,
  bidiDeleteCookies,
  bidiGetTopContext,
  bidiEvaluateInContext,
  normalizeBidiWebSocketUrl,
} from "../../src/main/services/bidi-client.js";
import { evaluateInPage } from "../../src/main/services/page-eval.js";
import { bidiCookieToCookieInfo, cookieInfoToBidiCookie } from "../../src/main/services/bidi-cookie-service.js";

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let port = 0;

/** Fake BiDi responder table; tests may mutate `behaviors` before a call. */
const behaviors: Record<string, (params: any) => any> = {
  "session.new": () => ({ sessionId: "fake-session-1", capabilities: { webSocketUrl: "ws://127.0.0.1:0/session" } }),
  "browsingContext.getTree": () => ({ contexts: [{ context: "ctx-1", url: "about:blank", children: [], parent: null }] }),
  "script.addPreloadScript": () => ({ script: "preload-1" }),
  "script.evaluate": () => ({ result: { type: "string", value: `{"ping":"pong"}` } }),
  "storage.getCookies": () => ({ cookies: [
    { name: "sid", value: { type: "string", value: "abc" }, domain: "example.com", path: "/", size: 7, httpOnly: true, secure: true, sameSite: "lax", expiry: 1799999999 },
  ] }),
  "storage.setCookie": () => ({ success: true }),
  "storage.deleteCookies": () => ({ partitionKey: ["fake-key"] }),
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

beforeAll(async () => {
  port = await freePort();
  server = http.createServer();
  await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
  wss = new WebSocketServer({ server, path: "/session" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg.id !== "number") return;
      try {
        const handler = behaviors[msg.method];
        if (!handler) {
          ws.send(JSON.stringify({ id: msg.id, error: { error: "unknown command", message: `Unsupported BiDi method: ${msg.method}` } }));
          return;
        }
        ws.send(JSON.stringify({ id: msg.id, result: handler(msg.params) }));
      } catch (e: any) {
        ws.send(JSON.stringify({ id: msg.id, error: { error: "unknown error", message: e?.message || String(e) } }));
      }
    });
  });
}, 15000);

afterAll(async () => {
  if (wss) { wss.close(); wss = null; }
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe("bidi-client wire protocol", () => {
  it("connects, opens a session and correlates command responses", async () => {
    const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 5000 });
    expect(conn.closed).toBe(false);
    const top = await bidiGetTopContext(conn, 5000);
    expect(top).toBe("ctx-1");
    conn.close();
    expect(conn.closed).toBe(true);
  }, 15000);

  it("registers a preload script and returns its id", async () => {
    const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 5000 });
    const scriptId = await bidiAddPreloadScript(conn, "window.__managed = true;", 5000);
    expect(scriptId).toBe("preload-1");
    conn.close();
  }, 15000);

  it("evaluates an expression and unwraps a string result", async () => {
    const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 5000 });
    const value = await bidiEvaluateInContext(conn, "(async()=>JSON.stringify({a:1}))()", "ctx-1", 5000);
    expect(value).toBe(`{"ping":"pong"}`);
    conn.close();
  }, 15000);

  it("unwraps nested objects WITHOUT losing primitives (Slice 79.3 regression)", async () => {
    // The BiDi serializer wraps only the top-level answer; nested values are
    // raw JS. A previous unwrap squash led to {x:null,y:null} for {x:12,y:34},
    // which silently broke agent click/type coordinates on Firefox.
    const original = behaviors["script.evaluate"];
    behaviors["script.evaluate"] = () => ({ result: {
      type: "object",
      value: { x: 12, y: 34, label: "ok", enabled: true, nested: { list: [1, 2, 3] } },
    } });
    try {
      const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 5000 });
      const value = await bidiEvaluateInContext(conn, "(function(){ return { x: 12, y: 34, label: 'ok', enabled: true, nested: { list: [1,2,3] } }; })()", "ctx-1", 5000);
      expect(value).toEqual({ x: 12, y: 34, label: "ok", enabled: true, nested: { list: [1, 2, 3] } });
      conn.close();
    } finally {
      behaviors["script.evaluate"] = original;
    }
  }, 15000);

  it("storage cookie operations map through the protocol", async () => {
    const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 5000 });
    const cookies = await bidiGetCookies(conn, 5000);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe("sid");
    const info = bidiCookieToCookieInfo(cookies[0]);
    expect(info.domain).toBe("example.com");
    expect(info.value).toBe("abc");
    expect(info.httpOnly).toBe(true);
    expect(info.sameSite).toBe(1); // lax
    expect(info.expires).toBe(1799999999);

    expect(await bidiSetCookie(conn, cookieInfoToBidiCookie({ domain: "example.com", name: "k", value: "v", path: "/", secure: false, httpOnly: false, sameSite: 1 }), 5000)).toBe(true);
    expect(await bidiDeleteCookies(conn, { name: "k" }, 5000)).toBe(1);
    conn.close();
  }, 15000);

  it("rejects with a clear protocol error for unknown commands", async () => {
    const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 5000 });
    await expect(conn.send("bogus.command", {}, 5000)).rejects.toThrow(/Unsupported BiDi method/);
    conn.close();
  }, 15000);

  it("normalizeBidiWebSocketUrl rejects non-loopback targets", () => {
    expect(() => normalizeBidiWebSocketUrl("ws://evil.example.com/session")).toThrow(/loopback/);
    expect(() => normalizeBidiWebSocketUrl("https://127.0.0.1:1/session")).toThrow(/loopback/);
    const ok = normalizeBidiWebSocketUrl("ws://localhost:1234/session", 1234);
    expect(ok).toBe("ws://127.0.0.1:1234/session");
  });
});

describe("page-eval engine routing", () => {
  it("routes firefox evaluation over BiDi", async () => {
    const result = await evaluateInPage(port, "firefox", "(async()=>'x')()", { timeoutMs: 8000 });
    expect(result).toBe(`{"ping":"pong"}`);
  }, 15000);

  it("rejects chromium evaluation when no CDP endpoint exists (honest failure)", async () => {
    const free = await freePort();
    await expect(evaluateInPage(free, "chromium", "1")).rejects.toThrow();
  }, 15000);

  it("rejects invalid debug ports for both engines", async () => {
    await expect(evaluateInPage(0, "firefox", "1")).rejects.toThrow(/port/);
    await expect(evaluateInPage(70000, "firefox", "1")).rejects.toThrow(/port/);
  });
});

describe("cookie mapping (CookieInfo ↔ BiDi)", () => {
  it("maps strict/none and session cookies", () => {
    const strict = cookieInfoToBidiCookie({ domain: ".example.com", name: "a", value: "b", path: "/", secure: true, httpOnly: true, sameSite: 2 });
    expect(strict.sameSite).toBe("strict");
    expect(strict.domain).toBe("example.com"); // leading dot stripped
    expect(strict.value).toEqual({ type: "string", value: "b" });

    const session = cookieInfoToBidiCookie({ domain: "example.com", name: "c", value: "d", path: "/", secure: false, httpOnly: false, sameSite: -1, expires: null });
    expect(session.expiry).toBeUndefined();
    expect(session.sameSite).toBe("none");
  });
});