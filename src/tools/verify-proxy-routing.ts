/// <reference lib="dom" />

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { WebSocketServer } from "ws";
import { PROXY_CORPUS_CERT, PROXY_CORPUS_KEY } from "./proxy-corpus-tls.js";

type RouteMode = "direct" | "http" | "socks5";

interface RequestRecord {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  httpVersion: string;
}

interface TimingRecord {
  name: string;
  nextHopProtocol: string;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
}

interface ContextProbe {
  headers: Record<string, string | string[] | undefined>;
  httpVersion: string;
}

interface BrowserProbe {
  navigation: TimingRecord;
  window: ContextProbe;
  worker: ContextProbe;
  frame: ContextProbe;
  serviceWorker: ContextProbe | null;
  webSocketMessage: string | null;
  cache: {
    responseCounts: string[];
    timings: TimingRecord[];
  };
  revalidate: {
    responseCounts: string[];
    timings: TimingRecord[];
  };
}

interface HttpProxyRecord {
  method: string;
  target: string;
  headers: Record<string, string | string[] | undefined>;
  authenticated: boolean;
}

interface SocksRecord {
  offeredMethods: number[];
  selectedMethod: number;
  authenticated: boolean | null;
  command: number | null;
  addressType: number | null;
  host: string | null;
  port: number | null;
}

interface RouteResult {
  mode: RouteMode;
  ok: boolean;
  error: string | null;
  probe: BrowserProbe | null;
  secureProbe: BrowserProbe | null;
  originRequestCount: number;
  cacheOriginRequests: number;
  revalidateOriginRequests: number;
  revalidateConditionalRequests: number;
  leakedProxyHeaders: string[];
  secureOriginRequestCount: number;
  secureCacheOriginRequests: number;
  secureRevalidateOriginRequests: number;
  secureRevalidateConditionalRequests: number;
  secureLeakedProxyHeaders: string[];
  httpProxyRequests: HttpProxyRecord[];
  socksConnections: SocksRecord[];
}

interface BinaryResult {
  label: string;
  executablePath: string;
  version: string;
  routes: RouteResult[];
  nativeHttpAuth: NativeHttpAuthResult;
  comparisons: {
    headerParity: boolean;
    cacheParity: boolean;
    secureContexts: boolean;
    timingShape: boolean;
    remoteDns: boolean;
    nativeHttpAuth: boolean | null;
    failures: string[];
  };
}

interface NativeHttpAuthResult {
  supported: boolean;
  ok: boolean | null;
  error: string | null;
  credentialFileDeletedBeforeNavigation: boolean | null;
  challengedRequests: number;
  authenticatedRequests: number;
  originRequestCount: number;
}

interface BinaryInput {
  label: string;
  executablePath: string;
  bootstrapFile: string | null;
}

const END_TO_END_HEADERS = [
  "accept-encoding",
  "accept-language",
  "dnt",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "user-agent",
] as const;

const PROXY_SIGNAL_HEADERS = [
  "forwarded",
  "proxy-authorization",
  "proxy-connection",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
] as const;

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: net.Server | http.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function trackSockets(server: net.Server | http.Server): Set<net.Socket> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function queryRecord(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

async function startOrigin(secure = false): Promise<{
  port: number;
  requests: RequestRecord[];
  close: () => Promise<void>;
}> {
  const requests: RequestRecord[] = [];
  const cacheCounts = new Map<string, number>();
  const requestHandler: http.RequestListener = (request, response) => {
    const url = new URL(request.url || "/", `${secure ? "https" : "http"}://${request.headers.host || "probe.test"}`);
    const record: RequestRecord = {
      path: url.pathname,
      query: queryRecord(url),
      headers: { ...request.headers },
      httpVersion: request.httpVersion,
    };
    requests.push(record);
    response.setHeader("timing-allow-origin", "*");

    if (url.pathname === "/echo") {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ headers: record.headers, httpVersion: record.httpVersion }));
      return;
    }

    if (url.pathname === "/cache" || url.pathname === "/revalidate") {
      const key = `${url.pathname}?${url.searchParams.toString()}`;
      const count = (cacheCounts.get(key) || 0) + 1;
      cacheCounts.set(key, count);
      response.setHeader("content-type", "text/plain");
      response.setHeader("etag", `"${createHash("sha256").update(key).digest("hex").slice(0, 16)}"`);
      response.setHeader("x-origin-count", String(count));
      response.setHeader("cache-control", url.pathname === "/cache" ? "public, max-age=3600" : "no-cache");
      if (request.headers["if-none-match"]) {
        response.statusCode = 304;
        response.end();
        return;
      }
      response.end(`controlled-cache-payload:${key}`);
      return;
    }

    if (url.pathname === "/frame") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end("<!doctype html><meta charset=utf-8><title>frame</title>");
      return;
    }

    if (url.pathname === "/sw.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(`self.onmessage=function(event){var port=event.ports[0];event.waitUntil(fetch('/echo?run='+encodeURIComponent(event.data)+'&kind=service-worker',{cache:'no-store'}).then(function(response){return response.json()}).then(function(value){port.postMessage(value)}).catch(function(error){port.postMessage({error:String(error)})}))}`);
      return;
    }

    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end("<!doctype html><meta charset=utf-8><title>proxy corpus</title>");
  };
  const server = secure
    ? https.createServer({ key: PROXY_CORPUS_KEY, cert: PROXY_CORPUS_CERT }, requestHandler)
    : http.createServer(requestHandler);
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(request.url || "/", `${secure ? "https" : "http"}://${request.headers.host || "probe.test"}`);
    requests.push({
      path: url.pathname,
      query: queryRecord(url),
      headers: { ...request.headers },
      httpVersion: request.httpVersion,
    });
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.send("ws-ok", () => webSocket.close());
    });
  });
  const sockets = trackSockets(server);
  const port = await listen(server);
  return {
    port,
    requests,
    close: async () => {
      for (const webSocket of webSockets.clients) webSocket.terminate();
      await closeServer(server, sockets);
      webSockets.close();
    },
  };
}

async function startHttpProxy(
  originPort: number,
  credentials?: { username: string; password: string },
  secureOriginPort?: number,
): Promise<{
  port: number;
  requests: HttpProxyRecord[];
  close: () => Promise<void>;
}> {
  const requests: HttpProxyRecord[] = [];
  const expectedAuth = credentials
    ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`
    : null;
  const server = http.createServer((clientRequest, clientResponse) => {
    let target: URL;
    try {
      target = new URL(clientRequest.url || "", `http://${clientRequest.headers.host || "probe.test"}`);
    } catch {
      clientResponse.writeHead(400).end();
      return;
    }
    const authenticated = !expectedAuth || clientRequest.headers["proxy-authorization"] === expectedAuth;
    requests.push({
      method: clientRequest.method || "GET",
      target: target.href,
      headers: { ...clientRequest.headers },
      authenticated,
    });
    if (!authenticated) {
      clientResponse.writeHead(407, {
        "proxy-authenticate": "Basic realm=\"Agent Browser proxy corpus\"",
        "cache-control": "no-store",
      });
      clientResponse.end("proxy authentication required");
      return;
    }
    if (target.hostname !== "probe.test") {
      clientResponse.writeHead(502, { "cache-control": "no-store" });
      clientResponse.end("proxy corpus blocks non-probe targets");
      return;
    }

    const headers = { ...clientRequest.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request({
      host: "127.0.0.1",
      port: originPort,
      method: clientRequest.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(clientResponse);
    });
    upstream.on("error", (error) => {
      if (!clientResponse.headersSent) clientResponse.writeHead(502);
      clientResponse.end(error.message);
    });
    clientRequest.pipe(upstream);
  });
  const upstreamSockets = new Set<net.Socket>();
  server.on("connect", (request, clientSocket, head) => {
    clientSocket.on("error", () => clientSocket.destroy());
    const authenticated = !expectedAuth || request.headers["proxy-authorization"] === expectedAuth;
    requests.push({
      method: "CONNECT",
      target: `https://${request.url || "invalid"}/`,
      headers: { ...request.headers },
      authenticated,
    });
    if (!authenticated) {
      clientSocket.end([
        "HTTP/1.1 407 Proxy Authentication Required",
        "Proxy-Authenticate: Basic realm=\"Agent Browser proxy corpus\"",
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      return;
    }
    let target: URL;
    try {
      target = new URL(`http://${request.url || ""}`);
    } catch {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (target.hostname !== "probe.test" || !secureOriginPort || Number(target.port) !== secureOriginPort) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.createConnection({ host: "127.0.0.1", port: secureOriginPort });
    upstreamSockets.add(upstream);
    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      upstream.destroy();
    });
    upstream.once("close", () => upstreamSockets.delete(upstream));
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
  });
  const sockets = trackSockets(server);
  const port = await listen(server);
  return {
    port,
    requests,
    close: async () => {
      for (const socket of upstreamSockets) socket.destroy();
      await closeServer(server, sockets);
    },
  };
}

function readSocksAddress(buffer: Buffer, offset: number, addressType: number): { host: string; nextOffset: number } | null {
  if (addressType === 1) {
    if (buffer.length < offset + 4) return null;
    return { host: [...buffer.subarray(offset, offset + 4)].join("."), nextOffset: offset + 4 };
  }
  if (addressType === 3) {
    if (buffer.length < offset + 1) return null;
    const length = buffer[offset];
    if (buffer.length < offset + 1 + length) return null;
    return { host: buffer.subarray(offset + 1, offset + 1 + length).toString("utf8"), nextOffset: offset + 1 + length };
  }
  if (addressType === 4) {
    if (buffer.length < offset + 16) return null;
    const groups: string[] = [];
    for (let index = offset; index < offset + 16; index += 2) groups.push(buffer.readUInt16BE(index).toString(16));
    return { host: groups.join(":"), nextOffset: offset + 16 };
  }
  return null;
}

async function startSocksProxy(
  originPort: number,
  credentials?: { username: string; password: string },
  secureOriginPort?: number,
): Promise<{
  port: number;
  connections: SocksRecord[];
  close: () => Promise<void>;
}> {
  const connections: SocksRecord[] = [];
  const upstreamSockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    client.on("error", () => client.destroy());
    let state: "greeting" | "auth" | "request" | "connecting" | "piping" = "greeting";
    let buffered = Buffer.alloc(0);
    let observation: SocksRecord | null = null;

    const consume = (length: number): Buffer => {
      const value = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return value;
    };

    const processBuffered = (): void => {
      while (true) {
        if (state === "greeting") {
          if (buffered.length < 2) return;
          const methodCount = buffered[1];
          if (buffered.length < 2 + methodCount) return;
          const greeting = consume(2 + methodCount);
          if (greeting[0] !== 5) {
            client.destroy();
            return;
          }
          const methods = [...greeting.subarray(2)];
          const selectedMethod = credentials ? (methods.includes(2) ? 2 : 255) : (methods.includes(0) ? 0 : 255);
          observation = {
            offeredMethods: methods,
            selectedMethod,
            authenticated: credentials ? null : true,
            command: null,
            addressType: null,
            host: null,
            port: null,
          };
          connections.push(observation);
          client.write(Buffer.from([5, selectedMethod]));
          if (selectedMethod === 255) {
            client.end();
            return;
          }
          state = selectedMethod === 2 ? "auth" : "request";
          continue;
        }

        if (state === "auth") {
          if (buffered.length < 2) return;
          const usernameLength = buffered[1];
          if (buffered.length < 2 + usernameLength + 1) return;
          const passwordLength = buffered[2 + usernameLength];
          const totalLength = 3 + usernameLength + passwordLength;
          if (buffered.length < totalLength) return;
          const auth = consume(totalLength);
          const username = auth.subarray(2, 2 + usernameLength).toString("utf8");
          const password = auth.subarray(3 + usernameLength).toString("utf8");
          const accepted = auth[0] === 1 && username === credentials?.username && password === credentials?.password;
          if (observation) observation.authenticated = accepted;
          client.write(Buffer.from([1, accepted ? 0 : 1]));
          if (!accepted) {
            client.end();
            return;
          }
          state = "request";
          continue;
        }

        if (state === "request") {
          if (buffered.length < 4) return;
          const addressType = buffered[3];
          const address = readSocksAddress(buffered, 4, addressType);
          if (!address || buffered.length < address.nextOffset + 2) return;
          const request = consume(address.nextOffset + 2);
          const command = request[1];
          const targetPort = request.readUInt16BE(address.nextOffset);
          if (observation) {
            observation.command = command;
            observation.addressType = addressType;
            observation.host = address.host;
            observation.port = targetPort;
          }
          if (request[0] !== 5 || command !== 1) {
            client.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.end();
            return;
          }
          if (address.host !== "probe.test") {
            client.write(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.end();
            return;
          }
          const upstreamPort = targetPort === originPort || targetPort === secureOriginPort
            ? targetPort
            : null;
          if (!upstreamPort) {
            client.write(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.end();
            return;
          }

          state = "connecting";
          const upstream = net.createConnection({ host: "127.0.0.1", port: upstreamPort });
          upstreamSockets.add(upstream);
          upstream.once("close", () => upstreamSockets.delete(upstream));
          upstream.on("error", () => {
            if (state === "connecting" && !client.destroyed) {
              client.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
            }
            client.destroy();
          });
          upstream.once("connect", () => {
            if (client.destroyed) {
              upstream.destroy();
              return;
            }
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, upstreamPort >> 8, upstreamPort & 255]));
            state = "piping";
            client.removeListener("data", onData);
            if (buffered.length) upstream.write(buffered);
            buffered = Buffer.alloc(0);
            client.pipe(upstream);
            upstream.pipe(client);
          });
          return;
        }

        return;
      }
    };

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      processBuffered();
    };
    client.on("data", onData);
  });
  const sockets = trackSockets(server);
  const port = await listen(server);
  return {
    port,
    connections,
    close: async () => {
      for (const socket of upstreamSockets) socket.destroy();
      await closeServer(server, sockets);
    },
  };
}

async function captureBrowserProbe(page: Page, runId: string, includeSecureContexts = false): Promise<BrowserProbe> {
  return page.evaluate(async ({ id, secureContexts }) => {
    const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    if (!navigationEntry) throw new Error("navigation timing is unavailable");
    const navigation = {
      name: navigationEntry.name,
      nextHopProtocol: navigationEntry.nextHopProtocol,
      domainLookupStart: navigationEntry.domainLookupStart,
      domainLookupEnd: navigationEntry.domainLookupEnd,
      connectStart: navigationEntry.connectStart,
      secureConnectionStart: navigationEntry.secureConnectionStart,
      connectEnd: navigationEntry.connectEnd,
      requestStart: navigationEntry.requestStart,
      responseStart: navigationEntry.responseStart,
      responseEnd: navigationEntry.responseEnd,
      transferSize: navigationEntry.transferSize,
      encodedBodySize: navigationEntry.encodedBodySize,
      decodedBodySize: navigationEntry.decodedBodySize,
    };
    const fetchEcho = async (kind: string): Promise<ContextProbe> => {
      const response = await fetch(`/echo?run=${encodeURIComponent(id)}&kind=${kind}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`${kind} echo failed: ${response.status}`);
      return response.json();
    };
    const windowProbe = await fetchEcho("window");
    const workerProbe = await new Promise<ContextProbe>((resolve, reject) => {
      const source = `onmessage=async function(e){try{var r=await fetch(e.data.origin+'/echo?run='+encodeURIComponent(e.data.id)+'&kind=worker',{cache:'no-store'});postMessage(await r.json())}catch(error){postMessage({error:String(error)})}}`;
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("worker echo timed out"));
      }, 5000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        worker.terminate();
        if (event.data?.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.postMessage({ id, origin: location.origin });
    });
    const frame = document.createElement("iframe");
    const frameReady = new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error("frame failed to load"));
    });
    frame.src = `/frame?run=${encodeURIComponent(id)}`;
    document.body.appendChild(frame);
    await frameReady;
    const frameResponse = await frame.contentWindow!.fetch(`/echo?run=${encodeURIComponent(id)}&kind=frame`, { cache: "no-store" });
    const frameProbe = await frameResponse.json() as ContextProbe;
    frame.remove();

    let serviceWorkerProbe: ContextProbe | null = null;
    let webSocketMessage: string | null = null;
    if (secureContexts) {
      const registration = await navigator.serviceWorker.register(`/sw.js?run=${encodeURIComponent(id)}`, { scope: "/" });
      const ready = await navigator.serviceWorker.ready;
      serviceWorkerProbe = await new Promise<ContextProbe>((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error("service worker echo timed out")), 5000);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          if (event.data?.error) reject(new Error(event.data.error));
          else resolve(event.data);
        };
        ready.active!.postMessage(id, [channel.port2]);
      });
      await registration.unregister();
      webSocketMessage = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace(/^https:/, "wss:")}/ws?run=${encodeURIComponent(id)}`);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("secure WebSocket timed out"));
        }, 5000);
        socket.onmessage = (event) => {
          clearTimeout(timer);
          resolve(String(event.data));
          socket.close();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("secure WebSocket failed"));
        };
      });
    }

    const sampleCache = async (pathname: string): Promise<{ responseCounts: string[]; names: string[] }> => {
      const resource = `${location.origin}${pathname}?run=${encodeURIComponent(id)}`;
      const responseCounts: string[] = [];
      for (let index = 0; index < 2; index++) {
        const response = await fetch(resource);
        await response.text();
        responseCounts.push(response.headers.get("x-origin-count") || "missing");
      }
      return { responseCounts, names: [resource] };
    };
    performance.clearResourceTimings();
    const cache = await sampleCache("/cache");
    const cacheTimings = cache.names.flatMap((name) => performance.getEntriesByName(name).map((entry) => {
      const timing = entry as PerformanceResourceTiming;
      return {
        name: timing.name,
        nextHopProtocol: timing.nextHopProtocol,
        domainLookupStart: timing.domainLookupStart,
        domainLookupEnd: timing.domainLookupEnd,
        connectStart: timing.connectStart,
        secureConnectionStart: timing.secureConnectionStart,
        connectEnd: timing.connectEnd,
        requestStart: timing.requestStart,
        responseStart: timing.responseStart,
        responseEnd: timing.responseEnd,
        transferSize: timing.transferSize,
        encodedBodySize: timing.encodedBodySize,
        decodedBodySize: timing.decodedBodySize,
      };
    }));
    performance.clearResourceTimings();
    const revalidate = await sampleCache("/revalidate");
    const revalidateTimings = revalidate.names.flatMap((name) => performance.getEntriesByName(name).map((entry) => {
      const timing = entry as PerformanceResourceTiming;
      return {
        name: timing.name,
        nextHopProtocol: timing.nextHopProtocol,
        domainLookupStart: timing.domainLookupStart,
        domainLookupEnd: timing.domainLookupEnd,
        connectStart: timing.connectStart,
        secureConnectionStart: timing.secureConnectionStart,
        connectEnd: timing.connectEnd,
        requestStart: timing.requestStart,
        responseStart: timing.responseStart,
        responseEnd: timing.responseEnd,
        transferSize: timing.transferSize,
        encodedBodySize: timing.encodedBodySize,
        decodedBodySize: timing.decodedBodySize,
      };
    }));
    return {
      navigation,
      window: windowProbe,
      worker: workerProbe,
      frame: frameProbe,
      serviceWorker: serviceWorkerProbe,
      webSocketMessage,
      cache: { responseCounts: cache.responseCounts, timings: cacheTimings },
      revalidate: { responseCounts: revalidate.responseCounts, timings: revalidateTimings },
    };
  }, { id: runId, secureContexts: includeSecureContexts });
}

function selectedHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | null> {
  return Object.fromEntries(END_TO_END_HEADERS.map((name) => {
    const value = headers[name];
    return [name, Array.isArray(value) ? value.join(", ") : value || null];
  }));
}

function detectProxySignalHeaders(requests: RequestRecord[]): string[] {
  return [...new Set(requests.flatMap((request) =>
    PROXY_SIGNAL_HEADERS.filter((header) => request.headers[header] !== undefined)))].sort();
}

function timingShape(probe: BrowserProbe): object {
  const shape = (timing: TimingRecord) => {
    const cached = timing.transferSize === 0;
    return {
      // Chromium may either retain or omit nextHopProtocol and connection
      // timestamps on an otherwise identical memory/disk-cache hit. Normalize
      // those cache-only fields while preserving the observable route shape.
      protocol: cached ? "cached" : timing.nextHopProtocol,
      dns: cached ? false : timing.domainLookupEnd > timing.domainLookupStart,
      connect: cached ? false : timing.connectEnd > timing.connectStart,
      tls: cached ? timing.name.startsWith("https:") : timing.secureConnectionStart > 0,
      transfer: cached ? "cached" : "network",
      body: timing.decodedBodySize > 0,
    };
  };
  return {
    navigation: shape(probe.navigation),
    cache: probe.cache.timings.map(shape),
    revalidate: probe.revalidate.timings.map(shape),
  };
}

function routeArgs(mode: RouteMode, httpProxyPort: number, socksProxyPort: number): string[] {
  const common = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--ignore-certificate-errors-spki-list=BVj+BNtsNlxWajvLW80wH2ME6X5Rox4Fk1lidFPPunE=",
    "--password-store=basic",
    "--use-mock-keychain",
  ];
  if (mode === "direct") {
    return [...common, "--host-resolver-rules=MAP probe.test 127.0.0.1"];
  }
  const proxy = mode === "http"
    ? `http://127.0.0.1:${httpProxyPort}`
    : `socks5://127.0.0.1:${socksProxyPort}`;
  return [...common, `--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>"];
}

async function runRoute(
  executablePath: string,
  bootstrapFile: string | null,
  originPort: number,
  secureOriginPort: number,
  httpProxy: { port: number; requests: HttpProxyRecord[] },
  socksProxy: { port: number; connections: SocksRecord[] },
  originRequests: RequestRecord[],
  secureOriginRequests: RequestRecord[],
  mode: RouteMode,
): Promise<RouteResult> {
  const runId = `${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const originStart = originRequests.length;
  const secureOriginStart = secureOriginRequests.length;
  const httpStart = httpProxy.requests.length;
  const socksStart = socksProxy.connections.length;
  let browser: Browser | null = null;
  let persistentContext: BrowserContext | null = null;
  let temporaryProfile: string | null = null;
  let probe: BrowserProbe | null = null;
  let secureProbe: BrowserProbe | null = null;
  let error: string | null = null;
  try {
    let page: Page;
    if (bootstrapFile) {
      temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-proxy-corpus-"));
      fs.copyFileSync(bootstrapFile, path.join(temporaryProfile, path.basename(bootstrapFile)));
      persistentContext = await chromium.launchPersistentContext(temporaryProfile, {
        executablePath,
        headless: true,
        ignoreHTTPSErrors: true,
        args: routeArgs(mode, httpProxy.port, socksProxy.port),
        timeout: 20_000,
      });
      page = persistentContext.pages()[0] || await persistentContext.newPage();
    } else {
      browser = await chromium.launch({
        executablePath,
        headless: true,
        args: routeArgs(mode, httpProxy.port, socksProxy.port),
        timeout: 20_000,
      });
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
    }
    await page.goto(`http://probe.test:${originPort}/?run=${encodeURIComponent(runId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    probe = await captureBrowserProbe(page, runId);
    await page.goto(`https://probe.test:${secureOriginPort}/?run=${encodeURIComponent(runId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    secureProbe = await captureBrowserProbe(page, runId, true);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await persistentContext?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (temporaryProfile && temporaryProfile.startsWith(path.join(os.tmpdir(), "agent-browser-proxy-corpus-"))) {
      fs.rmSync(temporaryProfile, { recursive: true, force: true });
    }
  }

  const routeOriginRequests = originRequests.slice(originStart).filter((request) => request.query.run === runId);
  const cacheRequests = routeOriginRequests.filter((request) => request.path === "/cache");
  const revalidateRequests = routeOriginRequests.filter((request) => request.path === "/revalidate");
  const routeSecureOriginRequests = secureOriginRequests.slice(secureOriginStart)
    .filter((request) => request.query.run === runId);
  const secureCacheRequests = routeSecureOriginRequests.filter((request) => request.path === "/cache");
  const secureRevalidateRequests = routeSecureOriginRequests.filter((request) => request.path === "/revalidate");
  return {
    mode,
    ok: !error && Boolean(probe) && Boolean(secureProbe),
    error,
    probe,
    secureProbe,
    originRequestCount: routeOriginRequests.length,
    cacheOriginRequests: cacheRequests.length,
    revalidateOriginRequests: revalidateRequests.length,
    revalidateConditionalRequests: revalidateRequests.filter((request) => Boolean(request.headers["if-none-match"])).length,
    leakedProxyHeaders: detectProxySignalHeaders(routeOriginRequests),
    secureOriginRequestCount: routeSecureOriginRequests.length,
    secureCacheOriginRequests: secureCacheRequests.length,
    secureRevalidateOriginRequests: secureRevalidateRequests.length,
    secureRevalidateConditionalRequests: secureRevalidateRequests
      .filter((request) => Boolean(request.headers["if-none-match"])).length,
    secureLeakedProxyHeaders: detectProxySignalHeaders(routeSecureOriginRequests),
    httpProxyRequests: httpProxy.requests.slice(httpStart).filter((request) => {
      try {
        return new URL(request.target).searchParams.get("run") === runId;
      } catch {
        return false;
      }
    }),
    socksConnections: socksProxy.connections.slice(socksStart),
  };
}

function compareRoutes(routes: RouteResult[]): BinaryResult["comparisons"] {
  const failures: string[] = [];
  const successful = routes.filter((route) => route.ok && route.probe);
  if (successful.length !== 3) {
    failures.push(`expected 3 successful routes, got ${successful.length}`);
  }
  const direct = successful.find((route) => route.mode === "direct");
  const headerParity = Boolean(direct?.probe && direct.secureProbe) && successful.every((route) =>
    JSON.stringify(selectedHeaders(route.probe!.window.headers)) === JSON.stringify(selectedHeaders(direct!.probe!.window.headers)) &&
    JSON.stringify(selectedHeaders(route.probe!.worker.headers)) === JSON.stringify(selectedHeaders(direct!.probe!.worker.headers)) &&
    JSON.stringify(selectedHeaders(route.probe!.frame.headers)) === JSON.stringify(selectedHeaders(direct!.probe!.frame.headers)) &&
    JSON.stringify(selectedHeaders(route.secureProbe!.window.headers)) === JSON.stringify(selectedHeaders(direct!.secureProbe!.window.headers)) &&
    JSON.stringify(selectedHeaders(route.secureProbe!.worker.headers)) === JSON.stringify(selectedHeaders(direct!.secureProbe!.worker.headers)) &&
    JSON.stringify(selectedHeaders(route.secureProbe!.frame.headers)) === JSON.stringify(selectedHeaders(direct!.secureProbe!.frame.headers)) &&
    JSON.stringify(selectedHeaders(route.secureProbe!.serviceWorker!.headers)) === JSON.stringify(selectedHeaders(direct!.secureProbe!.serviceWorker!.headers)));
  if (!headerParity) failures.push("end-to-end request headers differ between direct, HTTP and SOCKS routes");

  const cacheParity = successful.length === 3 && successful.every((route) =>
    route.cacheOriginRequests === 1 &&
    route.revalidateOriginRequests === 2 &&
    route.revalidateConditionalRequests === 1 &&
    route.leakedProxyHeaders.length === 0 &&
    route.secureCacheOriginRequests === 1 &&
    route.secureRevalidateOriginRequests === 2 &&
    route.secureRevalidateConditionalRequests === 1 &&
    route.secureLeakedProxyHeaders.length === 0);
  if (!cacheParity) failures.push("cache/revalidation counts or proxy-header isolation differ between routes");

  const secureContexts = successful.length === 3 && successful.every((route) =>
    Boolean(route.secureProbe?.serviceWorker) &&
    route.secureProbe?.webSocketMessage === "ws-ok" &&
    route.secureOriginRequestCount >= 10);
  if (!secureContexts) failures.push("HTTPS, secure WebSocket or Service Worker proxy corpus failed");

  const timingShapeParity = Boolean(direct?.probe && direct.secureProbe) && successful.every((route) =>
    JSON.stringify(timingShape(route.probe!)) === JSON.stringify(timingShape(direct!.probe!)) &&
    JSON.stringify(timingShape(route.secureProbe!)) === JSON.stringify(timingShape(direct!.secureProbe!)));
  if (!timingShapeParity) failures.push("Resource/Navigation Timing structure differs between routes");

  const socks = routes.find((route) => route.mode === "socks5");
  const remoteDns = Boolean(socks?.socksConnections.some((connection) =>
    connection.command === 1 && connection.addressType === 3 && connection.host === "probe.test"));
  if (!remoteDns) failures.push("SOCKS5 route did not send probe.test as a domain to the proxy");
  return {
    headerParity,
    cacheParity,
    secureContexts,
    timingShape: timingShapeParity,
    remoteDns,
    nativeHttpAuth: null,
    failures,
  };
}

async function runNativeHttpAuth(
  executablePath: string,
  credentialSwitch: string | null,
  originPort: number,
  authProxy: { port: number; requests: HttpProxyRecord[] },
  originRequests: RequestRecord[],
): Promise<NativeHttpAuthResult> {
  if (!credentialSwitch) {
    return {
      supported: false,
      ok: null,
      error: null,
      credentialFileDeletedBeforeNavigation: null,
      challengedRequests: 0,
      authenticatedRequests: 0,
      originRequestCount: 0,
    };
  }

  const runId = `native-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const proxyStart = authProxy.requests.length;
  const originStart = originRequests.length;
  const credentialDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-native-auth-"));
  fs.chmodSync(credentialDirectory, 0o700);
  const credentialFile = path.join(credentialDirectory, "credentials.json");
  fs.writeFileSync(credentialFile, JSON.stringify({
    version: 1,
    host: "127.0.0.1",
    port: authProxy.port,
    username: "corpus-user",
    password: "corpus-password",
  }), { encoding: "utf8", mode: 0o600, flag: "wx" });

  let browser: Browser | null = null;
  let error: string | null = null;
  let credentialFileDeletedBeforeNavigation = false;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        ...routeArgs("http", authProxy.port, 0),
        `${credentialSwitch}=${credentialFile}`,
      ],
      timeout: 20_000,
    });
    credentialFileDeletedBeforeNavigation = !fs.existsSync(credentialFile);
    const page = await browser.newPage();
    await page.goto(`http://probe.test:${originPort}/?run=${encodeURIComponent(runId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await captureBrowserProbe(page, runId);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await browser?.close().catch(() => undefined);
    if (credentialDirectory.startsWith(path.join(os.tmpdir(), "agent-browser-native-auth-"))) {
      fs.rmSync(credentialDirectory, { recursive: true, force: true });
    }
  }

  const proxyRequests = authProxy.requests.slice(proxyStart);
  const challengedRequests = proxyRequests.filter((request) => !request.authenticated).length;
  const authenticatedRequests = proxyRequests.filter((request) => request.authenticated).length;
  const originRequestCount = originRequests.slice(originStart)
    .filter((request) => request.query.run === runId).length;
  const ok = !error && credentialFileDeletedBeforeNavigation &&
    challengedRequests >= 1 && authenticatedRequests >= 1 && originRequestCount >= 1;
  return {
    supported: true,
    ok,
    error: error || (ok ? null : "native proxy authentication acceptance conditions were not met"),
    credentialFileDeletedBeforeNavigation,
    challengedRequests,
    authenticatedRequests,
    originRequestCount,
  };
}

function resolveExecutable(input: string): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (process.platform === "darwin" && resolved.endsWith(".app")) {
    const name = path.basename(resolved, ".app");
    const candidate = path.join(resolved, "Contents", "MacOS", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`browser executable not found: ${input}`);
}

function parseBinaryArg(value: string, index: number): BinaryInput {
  const separator = value.indexOf("=");
  const label = separator > 0 ? value.slice(0, separator) : `browser-${index + 1}`;
  const spec = separator > 0 ? value.slice(separator + 1) : value;
  const bootstrapSeparator = spec.indexOf("::");
  const input = bootstrapSeparator >= 0 ? spec.slice(0, bootstrapSeparator) : spec;
  const bootstrapInput = bootstrapSeparator >= 0 ? spec.slice(bootstrapSeparator + 2) : "";
  const bootstrapFile = bootstrapInput ? path.resolve(bootstrapInput) : null;
  if (bootstrapFile && (!fs.existsSync(bootstrapFile) || !fs.statSync(bootstrapFile).isFile())) {
    throw new Error(`bootstrap file not found: ${bootstrapInput}`);
  }
  return { label, executablePath: resolveExecutable(input), bootstrapFile };
}

function detectBinaryInfo(executablePath: string): { version: string; capabilities: string[] } {
  let version = path.basename(executablePath);
  const capabilities = new Set<string>();
  try {
    const output = execFileSync(executablePath, ["--version", "--agent-browser-capabilities"], {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
    version = output.match(/\d+\.\d+\.\d+\.\d+/)?.[0] || version;
    for (const value of output.split(/\s+/)) {
      if (value.startsWith("agent-browser-")) capabilities.add(value);
    }
  } catch { /* query the compatibility protocol below */ }
  if (capabilities.size === 0) {
    try {
      const legacyOutput = execFileSync(executablePath, ["--version", "--roxy-capabilities"], {
        encoding: "utf8",
        timeout: 15_000,
      }).trim();
      version = legacyOutput.match(/\d+\.\d+\.\d+\.\d+/)?.[0] || version;
      for (const value of legacyOutput.split(/\s+/)) {
        if (value.startsWith("roxy-")) capabilities.add(value);
      }
    } catch { /* stock Chromium has no managed capability protocol */ }
  }
  if (version === path.basename(executablePath)) {
    try {
      version = execFileSync(executablePath, ["--version"], {
        encoding: "utf8",
        timeout: 15_000,
      }).match(/\d+\.\d+\.\d+\.\d+/)?.[0] || version;
    } catch { /* retain the executable name */ }
  }
  return { version, capabilities: [...capabilities].sort() };
}

async function main(): Promise<void> {
  const binaryArgs = process.argv.slice(2);
  if (!binaryArgs.length) {
    throw new Error("usage: npm run verify:proxy -- 'label=/path/to/Chromium[.app][::/optional/bootstrap-file]' [...]");
  }
  const binaries = binaryArgs.map(parseBinaryArg);
  const origin = await startOrigin();
  const secureOrigin = await startOrigin(true);
  const httpProxy = await startHttpProxy(origin.port, undefined, secureOrigin.port);
  const socksProxy = await startSocksProxy(origin.port, undefined, secureOrigin.port);
  const authProxy = await startHttpProxy(origin.port, {
    username: "corpus-user",
    password: "corpus-password",
  });
  const results: BinaryResult[] = [];
  try {
    for (const binary of binaries) {
      process.stderr.write(`[verify:proxy] ${binary.label}: direct / HTTP / SOCKS5\n`);
      const routes: RouteResult[] = [];
      for (const mode of ["direct", "http", "socks5"] as const) {
        routes.push(await runRoute(
          binary.executablePath,
          binary.bootstrapFile,
          origin.port,
          secureOrigin.port,
          httpProxy,
          socksProxy,
          origin.requests,
          secureOrigin.requests,
          mode,
        ));
      }
      const binaryInfo = detectBinaryInfo(binary.executablePath);
      const nativeProxyAuthSwitch = binaryInfo.capabilities.includes("agent-browser-proxy-auth-file-v1")
        ? "--agent-browser-proxy-auth-file"
        : binaryInfo.capabilities.includes("roxy-proxy-auth-file-v1")
          ? "--roxy-proxy-auth-file"
          : null;
      const nativeHttpAuth = await runNativeHttpAuth(
        binary.executablePath,
        nativeProxyAuthSwitch,
        origin.port,
        authProxy,
        origin.requests,
      );
      const comparisons = compareRoutes(routes);
      comparisons.nativeHttpAuth = nativeHttpAuth.ok;
      if (nativeHttpAuth.supported && !nativeHttpAuth.ok) {
        comparisons.failures.push("native HTTP proxy authentication failed");
      }
      results.push({
        label: binary.label,
        executablePath: binary.executablePath,
        version: binaryInfo.version,
        routes,
        nativeHttpAuth,
        comparisons,
      });
    }
  } finally {
    await Promise.all([
      origin.close(),
      secureOrigin.close(),
      httpProxy.close(),
      socksProxy.close(),
      authProxy.close(),
    ]);
  }
  process.stdout.write(`${JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  const failures = results.flatMap((result) => result.comparisons.failures.map((failure) => `${result.label}: ${failure}`));
  if (failures.length) throw new Error(`proxy corpus failed:\n${failures.join("\n")}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
