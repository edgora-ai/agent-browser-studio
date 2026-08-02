import * as net from "node:net";
import { SocksClient } from "socks";
import type { ProxyConfig } from "../types.js";

const MAX_HANDSHAKE_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface AuthenticatedSocksBridgeStats {
  accepted: number;
  connected: number;
  failed: number;
  lastTarget: { host: string; port: number } | null;
}

export interface AuthenticatedSocksBridge {
  host: "127.0.0.1";
  port: number;
  stats: () => AuthenticatedSocksBridgeStats;
  close: () => Promise<void>;
}

function parseAddress(
  buffer: Buffer,
  offset: number,
  addressType: number,
): { host: string; nextOffset: number } | null {
  if (addressType === 1) {
    if (buffer.length < offset + 4) return null;
    return {
      host: [...buffer.subarray(offset, offset + 4)].join("."),
      nextOffset: offset + 4,
    };
  }
  if (addressType === 3) {
    if (buffer.length < offset + 1) return null;
    const length = buffer[offset];
    if (length < 1 || buffer.length < offset + 1 + length) return null;
    const encoded = buffer.subarray(offset + 1, offset + 1 + length);
    const host = encoded.toString("utf8");
    if (!host || Buffer.byteLength(host, "utf8") !== length || /[\x00-\x20\x7f]/.test(host)) {
      throw new Error("invalid SOCKS target hostname");
    }
    return { host, nextOffset: offset + 1 + length };
  }
  if (addressType === 4) {
    if (buffer.length < offset + 16) return null;
    const groups: string[] = [];
    for (let index = offset; index < offset + 16; index += 2) {
      groups.push(buffer.readUInt16BE(index).toString(16));
    }
    return { host: groups.join(":"), nextOffset: offset + 16 };
  }
  throw new Error("unsupported SOCKS target address type");
}

function validateUpstream(proxy: ProxyConfig): asserts proxy is ProxyConfig & { username: string } {
  if (proxy.type !== "socks5" && proxy.type !== "socks5h") {
    throw new Error("Authenticated SOCKS bridge requires a SOCKS5 proxy");
  }
  if (!proxy.username) throw new Error("Authenticated SOCKS bridge requires a username");
  if (Buffer.byteLength(proxy.username, "utf8") > 255 || Buffer.byteLength(proxy.password || "", "utf8") > 255) {
    throw new Error("SOCKS5 username and password must be at most 255 bytes");
  }
}

export async function startAuthenticatedSocksBridge(proxy: ProxyConfig): Promise<AuthenticatedSocksBridge> {
  validateUpstream(proxy);
  const inboundSockets = new Set<net.Socket>();
  const upstreamSockets = new Set<net.Socket>();
  const state: AuthenticatedSocksBridgeStats = {
    accepted: 0,
    connected: 0,
    failed: 0,
    lastTarget: null,
  };
  let closing = false;

  const server = net.createServer((client) => {
    state.accepted++;
    inboundSockets.add(client);
    client.setNoDelay(true);
    client.setTimeout(HANDSHAKE_TIMEOUT_MS, () => client.destroy());
    client.on("error", () => client.destroy());
    client.once("close", () => inboundSockets.delete(client));

    let phase: "greeting" | "request" | "connecting" | "piping" = "greeting";
    let buffered = Buffer.alloc(0);

    const fail = (replyCode: number): void => {
      state.failed++;
      if (!client.destroyed) {
        client.end(Buffer.from([5, replyCode, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    };

    const consume = (length: number): Buffer => {
      const value = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return value;
    };

    const processBuffered = (): void => {
      try {
        while (!closing) {
          if (phase === "greeting") {
            if (buffered.length < 2) return;
            const methodCount = buffered[1];
            if (buffered.length < 2 + methodCount) return;
            const greeting = consume(2 + methodCount);
            if (greeting[0] !== 5 || !greeting.subarray(2).includes(0)) {
              client.end(Buffer.from([5, 255]));
              return;
            }
            client.write(Buffer.from([5, 0]));
            phase = "request";
            continue;
          }

          if (phase === "request") {
            if (buffered.length < 4) return;
            if (buffered[0] !== 5 || buffered[2] !== 0) {
              fail(1);
              return;
            }
            if (buffered[1] !== 1) {
              fail(7);
              return;
            }
            const address = parseAddress(buffered, 4, buffered[3]);
            if (!address || buffered.length < address.nextOffset + 2) return;
            const request = consume(address.nextOffset + 2);
            const target = {
              host: address.host,
              port: request.readUInt16BE(address.nextOffset),
            };
            if (target.port < 1) {
              fail(1);
              return;
            }
            state.lastTarget = target;
            phase = "connecting";
            void SocksClient.createConnection({
              command: "connect",
              proxy: {
                type: 5,
                host: proxy.host,
                port: proxy.port,
                userId: proxy.username,
                password: proxy.password || "",
              },
              destination: target,
              timeout: HANDSHAKE_TIMEOUT_MS,
              set_tcp_nodelay: true,
            }).then(({ socket: upstream }) => {
              if (closing || client.destroyed) {
                upstream.destroy();
                return;
              }
              upstreamSockets.add(upstream);
              upstream.on("error", () => upstream.destroy());
              upstream.once("close", () => upstreamSockets.delete(upstream));
              state.connected++;
              client.setTimeout(0);
              client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
              phase = "piping";
              client.removeListener("data", onData);
              if (buffered.length) upstream.write(buffered);
              buffered = Buffer.alloc(0);
              client.pipe(upstream);
              upstream.pipe(client);
            }).catch(() => fail(1));
            return;
          }
          return;
        }
      } catch {
        fail(1);
      }
    };

    const onData = (chunk: Buffer): void => {
      if (phase === "piping") return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HANDSHAKE_BYTES) {
        fail(1);
        return;
      }
      processBuffered();
    };
    client.on("data", onData);
  });
  server.on("error", () => {
    if (!closing) {
      for (const socket of inboundSockets) socket.destroy();
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Authenticated SOCKS bridge did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    host: "127.0.0.1",
    port,
    stats: () => ({ ...state, lastTarget: state.lastTarget ? { ...state.lastTarget } : null }),
    close: async () => {
      if (closing) return;
      closing = true;
      for (const socket of inboundSockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
