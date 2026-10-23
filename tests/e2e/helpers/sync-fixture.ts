// Bounded local S3/business fixture shared by real-app acceptance lanes.
import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";

export interface SyncAcceptanceFixtureOptions {
  bucket: string;
  configKey: string;
  businessPage: string;
  cookieName: string;
  cookieValue: string;
  maxObjectBytes: number;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function waitForOwnedCondition(label: string, condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  throw new Error(`Owned condition deadline: ${label}`);
}

export async function startSyncAcceptanceFixture(options: SyncAcceptanceFixtureOptions) {
  const { bucket: BUCKET, configKey: CONFIG_KEY, businessPage: BUSINESS_PAGE,
    cookieName: COOKIE_NAME, cookieValue: COOKIE_VALUE, maxObjectBytes: MAX_OBJECT_BYTES } = options;
  if (!/^[a-z0-9-]{1,63}$/.test(BUCKET) || !/^[A-Za-z0-9_.-]+$/.test(CONFIG_KEY) ||
      !Number.isSafeInteger(MAX_OBJECT_BYTES) || MAX_OBJECT_BYTES < 1 || MAX_OBJECT_BYTES > 16 * 1024 * 1024) {
    throw new Error("Invalid bounded sync fixture options");
  }
  const objects = new Map<string, Buffer>();
  const journal: Array<{ method: string; key: string; bytes: number; sha256: string }> = [];
  const failures: string[] = [];
  type BusinessCookieRequest = { host: string | null; path: string; syntheticCookieMatches: boolean };
  // Constant-space receiver-only evidence; never retain a Cookie header/value.
  const businessCookieRequests = { observing: false, count: 0, first: null as BusinessCookieRequest | null, last: null as BusinessCookieRequest | null };
  const blockedTunnels = new Set<Duplex>();
  const rejectedTunnelErrors = { ECONNRESET: 0, EPIPE: 0 };
  let origin = "";
  let gate: {
    reached: Promise<void>;
    markReached: () => void;
    pending?: { response: http.ServerResponse; key: string; bytes: Buffer };
  } | null = null;
  function publish(res: http.ServerResponse, key: string, bytes: Buffer): void {
    const total = [...objects.entries()].reduce((n, [otherKey, data]) => n + (otherKey === key ? 0 : data.length), bytes.length);
    if (total > MAX_OBJECT_BYTES) throw new Error("S3 fixture aggregate byte budget exceeded");
    objects.set(key, Buffer.from(bytes));
    journal.push({ method: "PUT", key, bytes: bytes.length, sha256: sha256(bytes) });
    res.writeHead(200, { etag: `"${sha256(bytes)}"`, "content-length": "0" });
    res.end();
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", origin);
      // Absolute proxy requests may only address this exact fixture origin.
      if (url.origin !== origin) { res.writeHead(403); res.end("External requests are disabled"); return; }
      if (url.pathname === "/" || url.pathname === "/business") {
        if (url.pathname === "/business" && businessCookieRequests.observing) {
          const observed = { host: req.headers.host ?? null, path: url.pathname,
            syntheticCookieMatches: typeof req.headers.cookie === "string" && req.headers.cookie.split(";").some((entry) => entry.trim() === `${COOKIE_NAME}=${COOKIE_VALUE}`) };
          businessCookieRequests.count++;
          businessCookieRequests.first ??= observed;
          businessCookieRequests.last = observed;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(BUSINESS_PAGE);
        return;
      }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const prefix = `/${BUCKET}/`;
      const key = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : "";
      if (!/^[A-Za-z0-9_.-]+$/.test(key)) { res.writeHead(404); res.end("No such fixture route"); return; }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        let count = 0;
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          count += bytes.length;
          if (count > MAX_OBJECT_BYTES) throw new Error("S3 fixture object exceeded byte budget");
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (key === CONFIG_KEY && gate && !gate.pending) {
          gate.pending = { response: res, key, bytes };
          gate.markReached();
        } else publish(res, key, bytes);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const bytes = objects.get(key);
        if (!bytes) { res.writeHead(404); res.end("NoSuchKey"); return; }
        journal.push({ method: req.method, key, bytes: bytes.length, sha256: sha256(bytes) });
        if (journal.length > 180) throw new Error("S3 fixture request budget exceeded");
        res.writeHead(200, { "content-length": String(bytes.length), etag: `"${sha256(bytes)}"` });
        res.end(req.method === "HEAD" ? undefined : bytes);
        return;
      }
      res.writeHead(405); res.end();
    })().catch((error) => {
      failures.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end("Owned fixture failed");
    });
  });
  server.on("connect", (_req, socket) => {
    // CONNECT sockets leave the HTTP server's normal request error handling.
    // A browser can reset one after our deliberate denial; scope accounting to
    // these denied sockets only, never suppress S3/REST or global process errors.
    blockedTunnels.add(socket);
    socket.once("close", () => blockedTunnels.delete(socket));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET" || error.code === "EPIPE") rejectedTunnelErrors[error.code]++;
      else failures.push("Denied CONNECT socket failed: " + String(error.code || error.message));
    });
    if (blockedTunnels.size > 128) { failures.push("Denied CONNECT socket budget exceeded"); socket.destroy(); return; }
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind a dynamic port");
  origin = `http://127.0.0.1:${address.port}`;
  async function closeFixture(): Promise<void> {
    if (gate?.pending) { gate.pending.response.writeHead(503); gate.pending.response.end("Fixture teardown"); }
    gate = null;
    server.closeAllConnections();
    for (const socket of blockedTunnels) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  try {
    // Deliberately reproduce the former unhandled ECONNRESET using a native,
    // fixture-owned client; a missing scoped handler must still fail the run.
    await new Promise<void>((resolve, reject) => {
      let denied = false;
      const client = net.createConnection({ host: "127.0.0.1", port: address.port });
      const timer = setTimeout(() => client.destroy(new Error("Owned denied-tunnel probe deadline")), 5_000);
      client.once("connect", () => client.write("CONNECT blocked.synthetic.invalid:443 HTTP/1.1\r\nHost: blocked.synthetic.invalid:443\r\n\r\n"));
      client.once("data", (data) => {
        if (!data.toString("ascii").startsWith("HTTP/1.1 403")) { client.destroy(new Error("Owned tunnel was not rejected")); return; }
        denied = true; client.resetAndDestroy();
      });
      client.on("error", reject);
      client.once("close", () => { clearTimeout(timer); if (denied) resolve(); else reject(new Error("Owned tunnel probe closed without rejection")); });
    });
    await waitForOwnedCondition("Declined CONNECT reset accounted", () => rejectedTunnelErrors.ECONNRESET + rejectedTunnelErrors.EPIPE > 0, 5_000);
  } catch (error) { await closeFixture(); throw error; }
  return {
    origin, port: address.port, objects, journal, failures, rejectedTunnelErrors,
    beginBusinessCookieObservation() { businessCookieRequests.observing = true; return businessCookieRequests; },
    endBusinessCookieObservation() { businessCookieRequests.observing = false; },
    holdConfigPut() {
      if (gate) throw new Error("A fixture PUT gate is already owned");
      let markReached!: () => void;
      const reached = new Promise<void>((resolve) => { markReached = resolve; });
      gate = { reached, markReached };
      return reached;
    },
    releaseConfigPut() {
      const pending = gate?.pending;
      if (!pending) throw new Error("No real S3 PUT is waiting");
      gate = null;
      publish(pending.response, pending.key, pending.bytes);
    },
    config() {
      const bytes = objects.get(CONFIG_KEY);
      if (!bytes) throw new Error("No actual publisher snapshot exists");
      return JSON.parse(bytes.toString("utf8"));
    },
    close: closeFixture,
  };
}
