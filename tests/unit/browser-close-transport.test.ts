import * as http from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestChromiumClose } from "../../src/main/services/browser/graceful-close.js";

const LIMIT = 16 * 1024;
const DEADLINE_MS = 800;
const fixtures: WireFixture[] = [];
const allowedPorts = new Set<number>();
const blockedConnections: Array<{ host: unknown; port: unknown }> = [];
const realConnect = Socket.prototype.connect;

type HttpHandler = (request: http.IncomingMessage, response: http.ServerResponse, fixture: WireFixture) => void;
type UpgradeHandler = (request: http.IncomingMessage, socket: Socket, head: Buffer, fixture: WireFixture) => void;
type CommandHandler = (socket: WebSocket, message: unknown, fixture: WireFixture) => void;
interface WireFixture {
  port: number;
  browserUrl: string;
  server: http.Server;
  wss: WebSocketServer;
  sockets: Set<Socket>;
  requests: Array<{ method: string | undefined; url: string | undefined; host: string | undefined; connection: string | undefined }>;
  upgrades: string[];
  commands: unknown[];
  errors: string[];
  timers: Set<ReturnType<typeof setTimeout>>;
  version: (response: http.ServerResponse, body?: string) => void;
  upgrade: (request: http.IncomingMessage, socket: Socket, head: Buffer) => void;
  later: (ms: number, action: () => void) => void;
  close: () => Promise<void>;
}

async function wire(options: { http?: HttpHandler; upgrade?: UpgradeHandler; command?: CommandHandler } = {}): Promise<WireFixture> {
  const sockets = new Set<Socket>();
  const errors: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMIT });
  let fixture!: WireFixture;
  const server = http.createServer((request, response) => {
    fixture.requests.push({
      method: request.method, url: request.url,
      host: request.headers.host, connection: request.headers.connection,
    });
    if (options.http) options.http(request, response, fixture);
    else if (request.method === "GET" && request.url === "/json/version") fixture.version(response);
    else response.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => errors.push(error.message));
  });
  server.on("upgrade", (request, socket, head) => {
    fixture.upgrades.push(request.url || "");
    if (options.upgrade) options.upgrade(request, socket as Socket, head, fixture);
    else fixture.upgrade(request, socket as Socket, head);
  });
  wss.on("error", (error) => errors.push(error.message));
  wss.on("connection", (socket) => {
    socket.on("error", (error) => errors.push(error.message));
    socket.on("message", (data) => {
      let message: unknown;
      try { message = JSON.parse(data.toString()); }
      catch { message = { invalidClientMessage: data.toString() }; }
      fixture.commands.push(message);
      if (options.command) options.command(socket, message, fixture);
      else socket.send(JSON.stringify({ id: 1, result: {} }));
    });
  });
  fixture = {
    port: 0, browserUrl: "", server, wss, sockets,
    requests: [], upgrades: [], commands: [], errors, timers,
    version(response, body) {
      const text = body ?? JSON.stringify({ Browser: "Chrome/140.0.0.0", webSocketDebuggerUrl: fixture.browserUrl });
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      response.end(text);
    },
    upgrade(request, socket, head) {
      wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    },
    later(ms, action) {
      const timer = setTimeout(() => { timers.delete(timer); action(); }, ms);
      timers.add(timer);
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // Assert peer teardown BEFORE this cleanup; forced cleanup merely prevents
      // a failed test from leaving its exclusively owned listener/socket alive.
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      ]);
      allowedPorts.delete(fixture.port);
    },
  };
  fixtures.push(fixture);
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
  });
  fixture.port = (server.address() as AddressInfo).port;
  fixture.browserUrl = `ws://127.0.0.1:${fixture.port}/devtools/browser/owned-native-1`;
  allowedPorts.add(fixture.port);
  return fixture;
}

async function expectPeerTeardown(...owned: WireFixture[]): Promise<void> {
  await expect.poll(
    () => owned.map((fixture) => ({ sockets: fixture.sockets.size, ws: fixture.wss.clients.size })),
    { timeout: 600, interval: 10 },
  ).toEqual(owned.map(() => ({ sockets: 0, ws: 0 })));
}

beforeEach(() => {
  blockedConnections.length = 0;
  // Real HTTP/ws wire is used. This capability fence only prevents a broken RED
  // validator from actually contacting an external host, another service, or a
  // Unix socket. Such an attempt is ALSO asserted as a failure, never accepted
  // as evidence that the helper itself validated the destination correctly.
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: unknown[]) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    const options = first && typeof first === "object" ? first as Record<string, unknown> : null;
    const host = options ? options.host ?? options.hostname : args[1];
    const port = options ? options.port : first;
    if (host !== "127.0.0.1" || !allowedPorts.has(Number(port)) || options?.path) {
      blockedConnections.push({ host, port });
      throw new Error("Undeclared outbound connection in browser-close transport fixture");
    }
    return Reflect.apply(realConnect, this, args);
  } as typeof Socket.prototype.connect);
});

afterEach(async () => {
  try {
    for (const fixture of fixtures.splice(0)) await fixture.close();
    expect(blockedConnections).toEqual([]);
  } finally {
    allowedPorts.clear();
    vi.restoreAllMocks();
  }
});

describe("real loopback browser-level close transport; no native browser/durability claim", () => {
  it.each(["ordinary ACK", "16KiB ACK"] as const)("uses the exact version endpoint and Browser.close wire: %s", async (kind) => {
    const f = await wire({ command(socket) {
      const ack = JSON.stringify({ id: 1, result: {} });
      socket.send(kind === "16KiB ACK" ? ack.padEnd(LIMIT, " ") : ack);
    } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("acknowledged");
    expect(f.requests).toEqual([{
      method: "GET", url: "/json/version", host: `127.0.0.1:${f.port}`, connection: "close",
    }]);
    expect(f.upgrades).toEqual(["/devtools/browser/owned-native-1"]);
    expect(f.commands).toEqual([{ id: 1, method: "Browser.close" }]);
    await expectPeerTeardown(f);
  });

  it("accepts a complete version JSON response of exactly 16KiB", async () => {
    const f = await wire({ http(_request, response, owned) {
      owned.version(response, JSON.stringify({ webSocketDebuggerUrl: owned.browserUrl }).padEnd(LIMIT, " "));
    } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("acknowledged");
    expect(f.commands).toEqual([{ id: 1, method: "Browser.close" }]);
    await expectPeerTeardown(f);
  });

  it("reports HTTP 404 unavailable without falling back to /json or opening a page socket", async () => {
    const f = await wire({ http(_request, response) { response.writeHead(404).end(); } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("unavailable");
    expect(f.requests.map(({ url }) => url)).toEqual(["/json/version"]);
    expect(f.upgrades).toEqual([]);
    expect(f.commands).toEqual([]);
    await expectPeerTeardown(f);
  });

  it("does not follow an HTTP redirect even to a second owned loopback listener", async () => {
    const destination = await wire();
    const f = await wire({ http(_request, response) {
      response.writeHead(302, { Location: `http://127.0.0.1:${destination.port}/json/version` }).end();
    } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("unavailable");
    expect(destination.requests).toEqual([]);
    expect(destination.upgrades).toEqual([]);
    expect(f.upgrades).toEqual([]);
    await expectPeerTeardown(f, destination);
  });

  const forbiddenUrls: Array<[string, (port: number, anotherPort: number) => string]> = [
    ["page target", (port) => `ws://127.0.0.1:${port}/devtools/page/owned-native-1`],
    ["external host", (port) => `ws://198.51.100.17:${port}/devtools/browser/owned-native-1`],
    ["localhost alias", (port) => `ws://localhost:${port}/devtools/browser/owned-native-1`],
    ["different port", (_port, anotherPort) => `ws://127.0.0.1:${anotherPort}/devtools/browser/owned-native-1`],
    ["username", (port) => `ws://fixture-user@127.0.0.1:${port}/devtools/browser/owned-native-1`],
    ["password", (port) => `ws://fixture-user:fixture-password@127.0.0.1:${port}/devtools/browser/owned-native-1`],
    ["query", (port) => `ws://127.0.0.1:${port}/devtools/browser/owned-native-1?fixture=1`],
    ["fragment", (port) => `ws://127.0.0.1:${port}/devtools/browser/owned-native-1#fixture`],
    ["missing browser id", (port) => `ws://127.0.0.1:${port}/devtools/browser/`],
    ["underscore in browser id", (port) => `ws://127.0.0.1:${port}/devtools/browser/owned_native`],
    ["extra path segment", (port) => `ws://127.0.0.1:${port}/devtools/browser/owned/native`],
    ["HTTP instead of WS", (port) => `http://127.0.0.1:${port}/devtools/browser/owned-native-1`],
  ];
  it.each(forbiddenUrls)("rejects %s before any websocket dispatch", async (_label, makeUrl) => {
    const other = await wire();
    const f = await wire({ http(_request, response, owned) {
      owned.version(response, JSON.stringify({ webSocketDebuggerUrl: makeUrl(owned.port, other.port) }));
    } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("failed");
    expect(f.upgrades).toEqual([]);
    expect(f.commands).toEqual([]);
    expect(other.requests).toEqual([]);
    expect(other.upgrades).toEqual([]);
    expect(blockedConnections).toEqual([]);
    await expectPeerTeardown(f, other);
  });

  it("reports malformed version JSON as failed and never opens websocket", async () => {
    const f = await wire({ http(_request, response, owned) { owned.version(response, '{"webSocketDebuggerUrl":'); } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("failed");
    expect(f.upgrades).toEqual([]);
    await expectPeerTeardown(f);
  });

  it("bounds the HTTP response by UTF-8 bytes rather than JavaScript character count", async () => {
    const f = await wire({ http(_request, response, owned) {
      const body = JSON.stringify({ webSocketDebuggerUrl: owned.browserUrl, padding: "é".repeat(LIMIT / 2) });
      expect(body.length).toBeLessThan(LIMIT);
      expect(Buffer.byteLength(body)).toBeGreaterThan(LIMIT);
      owned.version(response, body);
    } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("failed");
    expect(f.upgrades).toEqual([]);
    await expectPeerTeardown(f);
  });

  it("aborts an oversized streaming HTTP body without waiting for its end", async () => {
    const f = await wire({ http(_request, response, owned) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(`{"webSocketDebuggerUrl":${JSON.stringify(owned.browserUrl)},"padding":"`);
      response.write("x".repeat(LIMIT));
      // Deliberately no end: the byte budget, not a finished JSON document,
      // must release this socket before the overall deadline expires.
    } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("failed");
    expect(f.upgrades).toEqual([]);
    await expectPeerTeardown(f);
  });

  it.each([
    ["bad JSON", "{"],
    ["protocol error", JSON.stringify({ id: 1, error: { code: -32000, message: "controlled Browser.close rejection" } })],
    ["missing result", JSON.stringify({ id: 1 })],
    ["null result", JSON.stringify({ id: 1, result: null })],
    ["oversized payload", "x".repeat(LIMIT + 1)],
  ])("reports websocket %s as failed and closes the connection", async (_label, reply) => {
    const f = await wire({ command(socket) { socket.send(reply); } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("failed");
    expect(f.commands).toEqual([{ id: 1, method: "Browser.close" }]);
    await expectPeerTeardown(f);
  });

  it("does not acknowledge a different response id when no matching reply follows", async () => {
    const f = await wire({ command(socket) { socket.send(JSON.stringify({ id: 2, result: {} })); } });
    const result = await requestChromiumClose(f.port, () => true, 300);
    expect(["failed", "timeout"]).toContain(result);
    expect(f.commands).toEqual([{ id: 1, method: "Browser.close" }]);
    await expectPeerTeardown(f);
  });

  it("waits past a wrong id and only acknowledges the matching real response", async () => {
    let matchingReplySent = false;
    const f = await wire({ command(socket, _message, owned) {
      socket.send(JSON.stringify({ id: 2, result: {} }));
      owned.later(40, () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        matchingReplySent = true;
        socket.send(JSON.stringify({ id: 1, result: {} }));
      });
    } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("acknowledged");
    expect(matchingReplySent).toBe(true);
    expect(f.commands).toEqual([{ id: 1, method: "Browser.close" }]);
    await expectPeerTeardown(f);
  });

  it("reports disconnect after the real close command without claiming an ACK or durable state", async () => {
    const f = await wire({ command(socket) { socket.close(1000, "controlled close without ACK"); } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("disconnected");
    expect(f.commands).toEqual([{ id: 1, method: "Browser.close" }]);
    await expectPeerTeardown(f);
  });

  it("does not follow a websocket handshake redirect", async () => {
    const destination = await wire();
    const f = await wire({ upgrade(_request, socket) {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${destination.browserUrl}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    } });
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("failed");
    expect(f.upgrades).toEqual(["/devtools/browser/owned-native-1"]);
    expect(f.commands).toEqual([]);
    expect(destination.requests).toEqual([]);
    expect(destination.upgrades).toEqual([]);
    await expectPeerTeardown(f, destination);
  });

  it.each(["HTTP body", "websocket handshake", "command"] as const)("ends a held %s at the overall deadline and tears down its socket", async (stage) => {
    let peerEOF = false;
    const f = await wire({
      ...(stage === "HTTP body" ? { http(_request: http.IncomingMessage, response: http.ServerResponse) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"webSocketDebuggerUrl":');
      } } : {}),
      ...(stage === "websocket handshake" ? { upgrade(_request: http.IncomingMessage, socket: Socket) {
        // Never answer the handshake. Consume the upgraded raw socket so a
        // peer FIN is observable, and only then return EOF on our half-open end.
        // No server timer/destroy may manufacture client-teardown evidence.
        socket.once("end", () => { peerEOF = true; socket.end(); });
        socket.resume();
      } } : {}),
      ...(stage === "command" ? { command() { /* Intentionally no protocol reply. */ } } : {}),
    });
    const start = performance.now();
    expect(await requestChromiumClose(f.port, () => true, 300)).toBe("timeout");
    expect(performance.now() - start).toBeLessThan(650);
    if (stage === "command") expect(f.commands).toEqual([{ id: 1, method: "Browser.close" }]);
    else expect(f.commands).toEqual([]);
    await expectPeerTeardown(f);
    if (stage === "websocket handshake") expect(peerEOF).toBe(true);
  });

  it("uses one deadline across HTTP, handshake and command instead of restarting a budget per stage", async () => {
    const f = await wire({
      http(_request, response, owned) { owned.later(250, () => owned.version(response)); },
      upgrade(request, socket, head, owned) { owned.later(250, () => owned.upgrade(request, socket, head)); },
      command() { /* The final command is intentionally held. */ },
    });
    const start = performance.now();
    expect(await requestChromiumClose(f.port, () => true, DEADLINE_MS)).toBe("timeout");
    // A reset-at-command timeout would take at least 250+250+800=1300ms.
    // The tolerance allows scheduling noise without permitting that reset.
    expect(performance.now() - start).toBeLessThan(1_100);
    expect(f.requests).toHaveLength(1);
    expect(f.upgrades).toHaveLength(1);
    expect(f.commands).toEqual([{ id: 1, method: "Browser.close" }]);
    await expectPeerTeardown(f);
  });

  it("rejects stale ownership before even making the HTTP request", async () => {
    const f = await wire();
    expect(await requestChromiumClose(f.port, () => false, DEADLINE_MS)).toBe("stale");
    expect(f.requests).toEqual([]);
    expect(f.upgrades).toEqual([]);
    expect(f.commands).toEqual([]);
    await expectPeerTeardown(f);
  });

  it("rechecks ownership after HTTP completes and makes zero websocket dispatches", async () => {
    let current = true;
    const f = await wire({ http(_request, response, owned) {
      current = false;
      owned.version(response);
    } });
    expect(await requestChromiumClose(f.port, () => current, DEADLINE_MS)).toBe("stale");
    expect(f.requests).toHaveLength(1);
    expect(f.upgrades).toEqual([]);
    expect(f.commands).toEqual([]);
    await expectPeerTeardown(f);
  });

  it("rechecks ownership when websocket opens and sends zero close commands after an upgrade-time replacement", async () => {
    let current = true;
    const f = await wire({ upgrade(request, socket, head, owned) {
      current = false;
      owned.upgrade(request, socket, head);
    } });
    expect(await requestChromiumClose(f.port, () => current, DEADLINE_MS)).toBe("stale");
    expect(f.requests).toHaveLength(1);
    expect(f.upgrades).toEqual(["/devtools/browser/owned-native-1"]);
    expect(f.commands).toEqual([]);
    await expectPeerTeardown(f);
  });
});
