import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { SocksClient } from "socks";
import { startAuthenticatedSocksBridge, type AuthenticatedSocksBridge } from "../../src/main/services/authenticated-socks-bridge.js";

interface UpstreamObservation {
  username: string | null;
  password: string | null;
  host: string | null;
  port: number | null;
}

const bridges: AuthenticatedSocksBridge[] = [];
const servers: Array<{ server: net.Server; sockets: Set<net.Socket> }> = [];

async function startAuthenticatedUpstream(): Promise<{ port: number; observation: UpstreamObservation }> {
  const observation: UpstreamObservation = { username: null, password: null, host: null, port: null };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    let phase: "greeting" | "auth" | "request" | "echo" = "greeting";
    let buffered = Buffer.alloc(0);

    const consume = (length: number): Buffer => {
      const value = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return value;
    };
    const processBuffered = (): void => {
      for (;;) {
        if (phase === "greeting") {
          if (buffered.length < 2) return;
          const count = buffered[1];
          if (buffered.length < 2 + count) return;
          const greeting = consume(2 + count);
          if (greeting[0] !== 5 || !greeting.subarray(2).includes(2)) {
            socket.end(Buffer.from([5, 255]));
            return;
          }
          socket.write(Buffer.from([5, 2]));
          phase = "auth";
          continue;
        }
        if (phase === "auth") {
          if (buffered.length < 2) return;
          const usernameLength = buffered[1];
          if (buffered.length < 2 + usernameLength + 1) return;
          const passwordLength = buffered[2 + usernameLength];
          const total = 3 + usernameLength + passwordLength;
          if (buffered.length < total) return;
          const auth = consume(total);
          observation.username = auth.subarray(2, 2 + usernameLength).toString("utf8");
          observation.password = auth.subarray(3 + usernameLength).toString("utf8");
          const accepted = observation.username === "upstream-user" && observation.password === "upstream-password";
          socket.write(Buffer.from([1, accepted ? 0 : 1]));
          if (!accepted) {
            socket.end();
            return;
          }
          phase = "request";
          continue;
        }
        if (phase === "request") {
          if (buffered.length < 5) return;
          const addressType = buffered[3];
          if (addressType !== 3) {
            socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const length = buffered[4];
          if (buffered.length < 5 + length + 2) return;
          const request = consume(5 + length + 2);
          observation.host = request.subarray(5, 5 + length).toString("utf8");
          observation.port = request.readUInt16BE(5 + length);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          phase = "echo";
          if (buffered.length) {
            socket.write(buffered);
            buffered = Buffer.alloc(0);
          }
          return;
        }
        return;
      }
    };
    socket.on("data", (chunk) => {
      if (phase === "echo") {
        socket.write(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      processBuffered();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({ server, sockets });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test SOCKS server did not bind");
  return { port: address.port, observation };
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const { server, sockets } of servers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("authenticated SOCKS5 loopback bridge", () => {
  it("keeps Chromium-facing SOCKS unauthenticated while forwarding credentials and the unresolved domain", async () => {
    const upstream = await startAuthenticatedUpstream();
    const bridge = await startAuthenticatedSocksBridge({
      type: "socks5h",
      host: "127.0.0.1",
      port: upstream.port,
      username: "upstream-user",
      password: "upstream-password",
    });
    bridges.push(bridge);
    const { socket } = await SocksClient.createConnection({
      command: "connect",
      proxy: { type: 5, host: bridge.host, port: bridge.port },
      destination: { host: "remote-only.test", port: 8443 },
      timeout: 5000,
    });
    socket.on("error", () => socket.destroy());
    const echoed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bridge echo timed out")), 5000);
      socket.once("data", (chunk) => {
        clearTimeout(timer);
        resolve(chunk.toString("utf8"));
      });
    });
    socket.write("bridge-ok");
    expect(await echoed).toBe("bridge-ok");
    socket.destroy();
    expect(upstream.observation).toEqual({
      username: "upstream-user",
      password: "upstream-password",
      host: "remote-only.test",
      port: 8443,
    });
    expect(bridge.stats()).toMatchObject({
      accepted: 1,
      connected: 1,
      failed: 0,
      lastTarget: { host: "remote-only.test", port: 8443 },
    });
  });

  it("fails closed when upstream credentials are rejected", async () => {
    const upstream = await startAuthenticatedUpstream();
    const bridge = await startAuthenticatedSocksBridge({
      type: "socks5",
      host: "127.0.0.1",
      port: upstream.port,
      username: "upstream-user",
      password: "wrong-password",
    });
    bridges.push(bridge);
    await expect(SocksClient.createConnection({
      command: "connect",
      proxy: { type: 5, host: bridge.host, port: bridge.port },
      destination: { host: "remote-only.test", port: 443 },
      timeout: 5000,
    })).rejects.toThrow();
    expect(bridge.stats().connected).toBe(0);
    expect(bridge.stats().failed).toBeGreaterThanOrEqual(1);
  });
});
