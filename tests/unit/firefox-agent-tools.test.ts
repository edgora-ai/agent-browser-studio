// Unit tests for the Agent browser_* tool stack over WebDriver BiDi (Slice 79.3):
//   - firefox-agent-tools: navigate/evaluate/snapshot/click/type/keys/scroll/
//     select/upload/screenshot/cookies/wait tools over a real BiDi WS protocol;
//   - executeToolCall dispatch: a firefox port routes to the BiDi stack while
//     keeping the Chromium CDP path untouched.
// A local WebSocket server stands in for Firefox (same pattern as
// bidi-client.test.ts); engine/session resolvers are injected so the tool
// dispatch is testable without a running profile.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer } from "ws";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp/j99-agent-tools-userdata" },
}));

import { connectBidi, type BidiConnection } from "../../src/main/services/bidi-client.js";
import {
  firefoxNavigate,
  firefoxEvaluate,
  firefoxTextSnapshot,
  firefoxGetText,
  firefoxGetUrl,
  firefoxGetTitle,
  firefoxGetCookies,
  firefoxNewTab,
  firefoxScreenshot,
  firefoxWaitForSelector,
  firefoxWaitForLoad,
  firefoxClick,
  firefoxHover,
  firefoxType,
  firefoxPressKey,
  firefoxScroll,
  firefoxSelect,
  firefoxUploadFile,
} from "../../src/main/services/firefox-agent-tools.js";
import { executeToolCall } from "../../src/main/services/local-agent.js";

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let port = 0;
const calls: Array<{ method: string; params: any }> = [];

const behaviors: Record<string, (params: any) => any> = {
  "session.new": () => ({ sessionId: "agent-tools-session", capabilities: {} }),
  "browsingContext.getTree": () => ({ contexts: [{ context: "ctx-1", url: "about:blank", children: [], parent: null }] }),
  "browsingContext.create": () => ({ context: "ctx-tab-2" }),
  "browsingContext.navigate": () => ({}),
  "browsingContext.captureScreenshot": () => ({ data: "j99-shot-b64==" }),
  "input.performActions": () => ({}),
  "input.insertText": () => ({ success: true }),
  "input.setFiles": () => ({ success: true }),
  "storage.getCookies": () => ({ cookies: [
    { name: "sid", value: { type: "string", value: "abc" }, domain: "example.com", path: "/", size: 7, httpOnly: true, secure: true, sameSite: "lax", expiry: 1799999999 },
  ] }),
  "script.evaluate": (params: any) => {
    const expr: string = String((params && params.expression) || "");
    if (expr.includes("getBoundingClientRect")) return { result: { type: "object", value: { x: 12, y: 34 } } };
    if (expr.includes("'a, button, input")) return { result: { type: "string", value: "<button>Go -> https://example.com/" } };
    if (expr.includes("return e;")) return { result: { type: "object", value: null, sharedId: "shared-1" } };
    if (expr.includes("textContent")) return { result: { type: "string", value: "Hello world" } };
    if (expr.includes("isContentEditable")) return { result: { type: "boolean", value: true } };
    if (expr.includes("activeElement")) return { result: { type: "boolean", value: true } };
    if (expr.includes("dispatchEvent(new Event('change'")) return { result: { type: "string", value: "b" } };
    if (expr.includes("document.querySelector")) return { result: { type: "boolean", value: true } };
    if (expr.includes("document.readyState")) return { result: { type: "string", value: "complete" } };
    if (expr.includes("window.scrollBy")) return { result: { type: "boolean", value: true } };
    if (expr.includes("location.href")) return { result: { type: "string", value: "https://example.com/" } };
    if (expr.includes("document.title")) return { result: { type: "string", value: "Example" } };
    return { result: { type: "string", value: "42" } };
  },
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
      calls.push({ method: msg.method, params: msg.params });
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

let conn: BidiConnection | null = null;
beforeAll(async () => {
  conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 5000 });
});
afterAll(async () => { if (conn) { conn.close(); conn = null; } });

function lastCall(method: string): any {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].method === method) return calls[i].params;
  return null;
}

describe("firefox-agent-tools over the BiDi wire protocol", () => {
  it("navigates, reads URL/title/text/snapshot", async () => {
    await firefoxNavigate(conn!, "https://example.com/");
    expect(lastCall("browsingContext.navigate").url).toBe("https://example.com/");
    expect((await firefoxGetUrl(conn!)).url).toBe("https://example.com/");
    expect((await firefoxGetTitle(conn!)).title).toBe("Example");
    expect((await firefoxGetText(conn!, "#btn")).text).toBe("Hello world");
    expect(await firefoxTextSnapshot(conn!)).toContain("<button>Go");
  });

  it("screenshots through browsingContext.captureScreenshot", async () => {
    expect(await firefoxScreenshot(conn!)).toBe("j99-shot-b64==");
  });

  it("clicks via native pointer actions at the element center", async () => {
    const r = await firefoxClick(conn!, "#submit");
    expect(r.success).toBe(true);
    expect(r.x).toBe(12);
    expect(r.y).toBe(34);
    const params = lastCall("input.performActions");
    expect(params.actions[0].type).toBe("pointer");
    expect(params.actions[0].actions.map((a: any) => a.type)).toEqual(["pointerMove", "pointerDown", "pause", "pointerUp"]);
  });

  it("types into the focused element via input.insertText", async () => {
    const r = await firefoxType(conn!, "input[name=q]", "hello");
    expect(r.success).toBe(true);
    expect(lastCall("input.insertText").text).toBe("hello");
  });

  it("presses named and character keys as key actions", async () => {
    await firefoxPressKey(conn!, "Enter");
    let params = lastCall("input.performActions");
    expect(params.actions[0].type).toBe("key");
    expect(params.actions[0].actions.map((a: any) => a.value)).toEqual(["Enter", "Enter"]);
    await firefoxPressKey(conn!, "Tab", 120);
    params = lastCall("input.performActions");
    expect(params.actions[0].actions.map((a: any) => a.type)).toContain("pause");
  });

  it("scrolls, selects, uploads files, waits for selectors and load", async () => {
    await firefoxScroll(conn!, "down", 400);
    expect(lastCall("script.evaluate").expression).toContain("scrollBy(0, 400)");
    await firefoxScroll(conn!, "up", 300);
    expect(lastCall("script.evaluate").expression).toContain("scrollBy(0, -300)");
    await firefoxSelect(conn!, "select#kind", "b");
    expect(lastCall("script.evaluate").expression).toContain('e.value = "b"');
    const upload = await firefoxUploadFile(conn!, "input[type=file]", "/tmp/x.txt");
    expect(upload.success).toBe(true);
    expect(lastCall("input.setFiles").element).toEqual({ sharedId: "shared-1" });
    expect(lastCall("input.setFiles").files).toEqual(["/tmp/x.txt"]);
    expect((await firefoxWaitForSelector(conn!, "#ready", 5000)).found).toBe(true);
    expect((await firefoxWaitForLoad(conn!, 5000)).loaded).toBe(true);
    const tab = await firefoxNewTab(conn!, "https://example.com/");
    expect(tab.targetId).toBe("ctx-tab-2");
  });

  it("lists cookies mapped to {name, domain}", async () => {
    const r = await firefoxGetCookies(conn!);
    expect(r.cookies).toEqual([{ name: "sid", domain: "example.com" }]);
  });

  it("evaluates arbitrary expressions", async () => {
    expect(await firefoxEvaluate(conn!, "1 + 1")).toBe("42");
  });

  it("rejects keys the BiDi stack cannot express", async () => {
    await expect(firefoxPressKey(conn!, "Shift+F5")).rejects.toThrow(/Unsupported key/);
  });
});

describe("executeToolCall engine dispatch (firefox → BiDi, chromium → CDP)", () => {
  it("routes browser_navigate / evaluate / screenshot / get_cookies to BiDi for a firefox port", async () => {
    const ctx = {
      engineResolver: () => "firefox" as const,
      sessionResolver: () => conn,
    };
    const r1 = await executeToolCall("browser_navigate", { port, url: "https://example.com/" }, undefined, ctx);
    expect(r1.url).toBe("https://example.com/");
    const r2 = await executeToolCall("browser_evaluate", { port, expression: "2+2" }, undefined, ctx);
    expect(r2.value).toBe("42");
    const r3 = await executeToolCall("browser_screenshot", { port }, undefined, ctx);
    expect(r3.base64).toContain("j99-shot-b64");
    const r4 = await executeToolCall("browser_get_cookies", { port }, undefined, ctx);
    expect(r4.cookies).toEqual([{ name: "sid", domain: "example.com" }]);
  });

  it("routes interactions: click / type / press_key / select / scroll / upload", async () => {
    const ctx = { engineResolver: () => "firefox" as const, sessionResolver: () => conn };
    const uploadPath = path.join(os.tmpdir(), `j99-firefox-upload-${process.pid}.txt`);
    fs.writeFileSync(uploadPath, "agent upload fixture");
    const click = await executeToolCall("browser_click", { port, selector: "#submit" }, undefined, ctx);
    expect(click.success).toBe(true);
    await executeToolCall("browser_type", { port, selector: "input", text: "hi" }, undefined, ctx);
    await executeToolCall("browser_press_key", { port, key: "Enter" }, undefined, ctx);
    await executeToolCall("browser_select", { port, selector: "select", value: "b" }, undefined, ctx);
    await executeToolCall("browser_scroll", { port, direction: "down" }, undefined, ctx);
    await executeToolCall("browser_hover", { port, selector: "#a" }, undefined, ctx);
    await executeToolCall("browser_upload_file", { port, selector: "input[type=file]", filePath: uploadPath }, undefined, ctx);
    fs.unlinkSync(uploadPath);
    expect(lastCall("input.performActions")).not.toBeNull();
  });

  it("fails honestly when a firefox port has no live managed session", async () => {
    const ctx = { engineResolver: () => "firefox" as const, sessionResolver: () => null };
    await expect(executeToolCall("browser_get_url", { port }, undefined, ctx)).rejects.toThrow(/no live managed session/);
  });
});
