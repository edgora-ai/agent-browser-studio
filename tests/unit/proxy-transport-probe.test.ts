import { afterEach, describe, expect, it } from "vitest";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { createSocket, type Socket as DatagramSocket } from "node:dgram";
import { performance } from "node:perf_hooks";
import type { ProxyConfig } from "../../src/main/types.js";
import {
  probeProxyTransport,
  type ProxyTransportProbeResult,
  type ProxyTransportProbeTarget,
} from "../../src/main/services/proxy-transport-probe.js";

// All listeners and all fixture forwarding use these loopback sockets and ephemeral
// ports. No app config, files, secrets, browser, subprocess, or external service.
const LOOPBACK = "127.0.0.1";
const COOKIE = 0x2112a442;
const TEST_AUTH = { username: "probe-test-user", password: "probe-test-password-not-a-real-secret" };
const ERROR_SENTINEL = "private-proxy-diagnostic-must-not-escape";

type StunMode =
  | "xor-v4" | "xor-v6" | "mapped-v4" | "mapped-v6" | "both"
  | "drop" | "bad-txid" | "bad-cookie" | "bad-length" | "bad-type" | "binding-error"
  | "missing-mapped" | "bad-mapped-length" | "bad-mapped-family" | "bad-mapped-reserved"
  | "zero-mapped-port" | "zero-mapped-address" | "duplicate-mapped" | "conflicting-mapped"
  | "truncated-attribute" | "trailing-data" | "oversized";
type FrameMode = "normal" | "fragment" | "reserved" | "wrong-address" | "wrong-port" | "bad-atyp" | "truncated" | "wrong-relay-source";

interface FixtureOptions {
  type?: ProxyConfig["type"];
  credentials?: typeof TEST_AUTH;
  rejectAuth?: boolean;
  downgradeAuth?: boolean;
  tcpMode?: "echo" | "wrong-echo" | "partial-echo" | "extra-echo" | "drop" | "delayed-echo";
  httpMode?: "ok" | "407" | "oversized-header" | "oversized-response" | "malformed" | "rejected" | "stall";
  socksMode?: "ok" | "bad-version" | "bad-reserved" | "short-reply" | "stall-greeting";
  rejectUdp?: boolean;
  relayAddress?: "normal" | "wildcard" | "target";
  closeControl?: "after-associate" | "after-udp";
  stunMode?: StunMode;
  frameMode?: FrameMode;
  /** The proxy maps these names to its owned loopback services, never to DNS. */
  tcpTargetHost?: string;
  udpTargetHost?: string;
  udpResponseHost?: string;
  onEcho?: () => void;
  onStunRequest?: () => void;
}

interface FixtureAddress {
  host: string;
  port: number;
  end: number;
}

function ipv4Address(host: string, port: number): Buffer {
  const result = Buffer.from([1, ...host.split(".").map(Number), 0, 0]);
  result.writeUInt16BE(port, 5);
  return result;
}

function framedAddress(host: string, port: number): Buffer {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return ipv4Address(host, port);
  const name = Buffer.from(host, "ascii");
  const encoded = Buffer.concat([Buffer.from([3, name.length]), name, Buffer.alloc(2)]);
  encoded.writeUInt16BE(port, encoded.length - 2);
  return encoded;
}

function parseFixtureAddress(data: Buffer, offset: number): FixtureAddress | undefined {
  if (data.length <= offset) return undefined;
  const type = data[offset++];
  if (type === 1) {
    if (data.length < offset + 6) return undefined;
    return { host: [...data.subarray(offset, offset + 4)].join("."), port: data.readUInt16BE(offset + 4), end: offset + 6 };
  }
  if (type === 3) {
    if (data.length <= offset) return undefined;
    const length = data[offset++];
    if (data.length < offset + length + 2) return undefined;
    return { host: data.toString("ascii", offset, offset + length), port: data.readUInt16BE(offset + length), end: offset + length + 2 };
  }
  throw new Error("Fixture received an unsupported address type");
}

function mappedAttribute(request: Buffer, port: number, xor: boolean, ipv6: boolean, zeroAddress = false): Buffer {
  const address = ipv6
    ? Buffer.from("20010db8000000000000000000001234", "hex")
    : Buffer.from([127, 0, 0, 1]);
  if (zeroAddress) address.fill(0);
  const value = Buffer.alloc(4 + address.length);
  value[1] = ipv6 ? 2 : 1;
  value.writeUInt16BE(port ^ (xor ? COOKIE >>> 16 : 0), 2);
  address.copy(value, 4);
  if (xor) {
    const mask = Buffer.concat([request.subarray(4, 8), request.subarray(8, 20)]);
    for (let index = 0; index < address.length; index++) value[index + 4] ^= mask[index];
  }
  const header = Buffer.alloc(4);
  header.writeUInt16BE(xor ? 0x0020 : 0x0001, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, value]);
}

function stunResponse(request: Buffer, sourcePort: number, mode: StunMode): Buffer {
  const xor = mode !== "mapped-v4" && mode !== "mapped-v6";
  const ipv6 = mode === "xor-v6" || mode === "mapped-v6";
  let attribute = mappedAttribute(request, mode === "zero-mapped-port" ? 0 : sourcePort, xor, ipv6, mode === "zero-mapped-address");
  if (mode === "bad-mapped-length") attribute.writeUInt16BE(7, 2);
  if (mode === "bad-mapped-family") attribute[5] = 3;
  if (mode === "bad-mapped-reserved") attribute[4] = 1;
  if (mode === "truncated-attribute") attribute.writeUInt16BE(1024, 2);
  if (mode === "missing-mapped") attribute = Buffer.from([0x80, 0x22, 0, 4, 116, 101, 115, 116]);
  if (mode === "duplicate-mapped") attribute = Buffer.concat([attribute, attribute]);
  if (mode === "both" || mode === "conflicting-mapped") {
    const otherPort = mode === "both" ? sourcePort : sourcePort === 65535 ? 65534 : sourcePort + 1;
    attribute = Buffer.concat([attribute, mappedAttribute(request, otherPort, false, false)]);
  }
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0101, 0);
  header.writeUInt16BE(attribute.length, 2);
  header.writeUInt32BE(COOKIE, 4);
  request.copy(header, 8, 8, 20);
  let response = Buffer.concat([header, attribute]);
  if (mode === "bad-txid") response[8] ^= 0x80;
  if (mode === "bad-cookie") response[4] ^= 1;
  if (mode === "bad-length") response.writeUInt16BE(attribute.length + 1, 2);
  if (mode === "bad-type") response.writeUInt16BE(0x0001, 0);
  if (mode === "binding-error") response.writeUInt16BE(0x0111, 0);
  if (mode === "trailing-data") response = Buffer.concat([response, Buffer.from([0])]);
  if (mode === "oversized") response = Buffer.concat([response, Buffer.alloc(2048)]);
  return response;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true });
  });
}

function bind(socket: DatagramSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { socket.removeListener("listening", onListening); reject(error); };
    const onListening = () => {
      socket.removeListener("error", onError);
      resolve(socket.address().port);
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind({ address: LOOPBACK, port: 0, exclusive: true });
  });
}

class LoopbackFixture {
  readonly echoServer: Server;
  readonly proxyServer: Server;
  readonly stun = createSocket("udp4");
  readonly relay = createSocket("udp4");
  readonly rogue = createSocket("udp4");
  readonly echoPayloads: Buffer[] = [];
  readonly stunRequests: Buffer[] = [];
  readonly stunPeerPorts: number[] = [];
  readonly relayRequests: Buffer[] = [];
  readonly httpAuthorizations: Array<string | undefined> = [];
  readonly commandCodes: number[] = [];
  readonly associateClientPorts: number[] = [];
  readonly proxyClients = new Set<Socket>();
  readonly protocolFailures: string[] = [];
  readonly ioErrors: string[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly bound = new Set<DatagramSocket>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pendingRelays: Array<{ host: string; port: number }> = [];
  private udpControl: Socket | undefined;
  echoPort = 0;
  stunPort = 0;
  relayPort = 0;
  proxyPort = 0;

  constructor(readonly options: FixtureOptions) {
    this.echoServer = createServer(socket => this.acceptEcho(socket));
    this.proxyServer = createServer(socket => {
      this.track(socket);
      this.proxyClients.add(socket);
      if (options.type === "http") this.acceptHttp(socket);
      else this.acceptSocks(socket);
    });
    for (const socket of [this.stun, this.relay, this.rogue]) {
      socket.on("error", error => this.ioErrors.push(error.name));
    }
    this.stun.on("message", (packet, source) => {
      this.stunRequests.push(Buffer.from(packet));
      this.stunPeerPorts.push(source.port);
      if (source.address !== LOOPBACK || source.port !== this.relayPort) {
        this.protocolFailures.push("STUN reached without the proxy relay");
        return;
      }
      if (packet.length !== 20 || packet.readUInt16BE(0) !== 1 || packet.readUInt16BE(2) !== 0
          || packet.readUInt32BE(4) !== COOKIE) {
        this.protocolFailures.push("Invalid client STUN request");
        return;
      }
      options.onStunRequest?.();
      if (options.stunMode === "drop") return;
      this.send(this.stun, stunResponse(packet, source.port, options.stunMode ?? "xor-v4"), source.port, source.address);
    });
    this.relay.on("message", (packet, source) => {
      if (source.address === LOOPBACK && source.port === this.stunPort) {
        const client = this.pendingRelays.shift();
        if (!client) { this.protocolFailures.push("Unsolicited STUN response"); return; }
        this.relayResponse(packet, client);
        return;
      }
      this.relayRequests.push(Buffer.from(packet));
      if (this.options.closeControl === "after-associate") return;
      if (!this.udpControl || this.udpControl.destroyed || !this.associateClientPorts.includes(source.port)) {
        this.protocolFailures.push("UDP without a live association");
        return;
      }
      if (this.options.closeControl === "after-udp") { this.udpControl.destroy(); return; }
      if (packet.length < 10 || packet[0] !== 0 || packet[1] !== 0 || packet[2] !== 0) {
        this.protocolFailures.push("Invalid outbound SOCKS UDP frame");
        return;
      }
      const target = parseFixtureAddress(packet, 3);
      if (!target || target.host !== this.udpTarget.host || target.port !== this.stunPort) {
        this.protocolFailures.push("Proxy attempted a non-owned UDP destination");
        return;
      }
      this.pendingRelays.push({ host: source.address, port: source.port });
      this.send(this.relay, packet.subarray(target.end), this.stunPort, LOOPBACK);
    });
  }

  private send(socket: DatagramSocket, packet: Buffer, port: number, host: string): void {
    socket.send(packet, port, host, error => { if (error) this.ioErrors.push(error.name); });
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("error", error => { this.ioErrors.push(error.name); socket.destroy(); });
  }

  async start(): Promise<void> {
    this.echoPort = await listen(this.echoServer);
    this.stunPort = await bind(this.stun);
    this.bound.add(this.stun);
    this.relayPort = await bind(this.relay);
    this.bound.add(this.relay);
    await bind(this.rogue);
    this.bound.add(this.rogue);
    this.proxyPort = await listen(this.proxyServer);
  }

  get tcpTarget(): ProxyTransportProbeTarget { return { host: this.options.tcpTargetHost ?? LOOPBACK, port: this.echoPort }; }
  get udpTarget(): ProxyTransportProbeTarget { return { host: this.options.udpTargetHost ?? LOOPBACK, port: this.stunPort }; }

  proxyConfig(includeCredentials = true): ProxyConfig {
    return {
      type: this.options.type ?? "socks5",
      host: LOOPBACK,
      port: this.proxyPort,
      ...(includeCredentials ? this.options.credentials : undefined),
      // These must never be followed by the probe.
      fallbacks: ["not-a-real-fallback"],
      bypassList: [LOOPBACK],
    };
  }

  private acceptEcho(socket: Socket): void {
    this.track(socket);
    const index = this.echoPayloads.push(Buffer.alloc(0)) - 1;
    socket.on("data", (data: Buffer) => {
      this.echoPayloads[index] = Buffer.concat([this.echoPayloads[index], data]);
      this.options.onEcho?.();
      if (this.options.tcpMode === "drop") return;
      let echo: Buffer = Buffer.from(data);
      if (this.options.tcpMode === "wrong-echo") echo[0] ^= 0x80;
      if (this.options.tcpMode === "partial-echo") {
        if (this.echoPayloads[index].length < 32) return;
        echo = this.echoPayloads[index].subarray(0, 31);
      }
      if (this.options.tcpMode === "extra-echo") echo = Buffer.concat([echo, Buffer.from([1])]);
      if (this.options.tcpMode === "delayed-echo") {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          if (!socket.destroyed) socket.write(echo);
        }, 250);
        this.timers.add(timer);
      } else if (!socket.destroyed) socket.write(echo);
    });
  }

  private tunnel(client: Socket, head: Buffer, reply: Buffer): void {
    // Deliberately never use a requested host/port in a fixture network call.
    const upstream = connect({ host: LOOPBACK, port: this.echoPort });
    this.track(upstream);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    upstream.once("connect", () => {
      if (client.destroyed) { upstream.destroy(); return; }
      client.write(reply);
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  }

  private acceptHttp(socket: Socket): void {
    let buffered: Buffer = Buffer.alloc(0);
    const onData = (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeListener("data", onData);
      const header = buffered.toString("ascii", 0, end);
      const authorization = /^Proxy-Authorization: (.+)$/mi.exec(header)?.[1];
      this.httpAuthorizations.push(authorization);
      const mode = this.options.httpMode;
      const expected = this.options.credentials
        ? `Basic ${Buffer.from(`${this.options.credentials.username}:${this.options.credentials.password}`).toString("base64")}`
        : undefined;
      if (mode === "407" || this.options.credentials && authorization !== expected) {
        socket.write(`HTTP/1.1 407 ${ERROR_SENTINEL}\r\nProxy-Authenticate: Basic realm="fixture"\r\n\r\n`);
        return;
      }
      if (mode === "stall") return;
      if (mode === "oversized-header") { socket.write(`HTTP/1.1 200 OK\r\nX-Fixture: ${"x".repeat(9000)}\r\n\r\n`); return; }
      if (mode === "oversized-response") { socket.write(Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), Buffer.alloc(10000)])); return; }
      if (mode === "malformed") { socket.write("HTTP/1.1 200 OK\r\nBad Header: invalid\r\n\r\n"); return; }
      if (mode === "rejected") { socket.write(`HTTP/1.1 502 ${ERROR_SENTINEL}\r\n\r\n`); return; }
      const authority = `${this.tcpTarget.host}:${this.echoPort}`;
      if (!header.startsWith(`CONNECT ${authority} HTTP/1.1\r\n`)) {
        this.protocolFailures.push("Proxy attempted a non-owned TCP destination");
        socket.destroy();
        return;
      }
      socket.pause();
      this.tunnel(socket, buffered.subarray(end + 4), Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
    };
    socket.on("data", onData);
  }

  private acceptSocks(socket: Socket): void {
    let state: "greeting" | "auth" | "command" | "done" = "greeting";
    let buffered: Buffer = Buffer.alloc(0);
    const onData = (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      while (state !== "done") {
        if (state === "greeting") {
          if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
          const offered = buffered.subarray(2, 2 + buffered[1]);
          const method = this.options.credentials ? 2 : 0;
          const valid = buffered[0] === 5 && offered.includes(method);
          buffered = buffered.subarray(2 + buffered[1]);
          if (this.options.socksMode === "stall-greeting") { state = "done"; return; }
          if (this.options.socksMode === "bad-version") { socket.write(Buffer.from([4, method])); state = "done"; return; }
          if (this.options.downgradeAuth) { socket.write(Buffer.from([5, 0])); state = "done"; return; }
          socket.write(Buffer.from([5, valid ? method : 0xff]));
          if (!valid) { state = "done"; return; }
          state = method === 2 ? "auth" : "command";
        } else if (state === "auth") {
          if (buffered.length < 2) return;
          const userEnd = 2 + buffered[1];
          if (buffered.length < userEnd + 1) return;
          const end = userEnd + 1 + buffered[userEnd];
          if (buffered.length < end) return;
          const valid = buffered[0] === 1 && buffered.toString("utf8", 2, userEnd) === this.options.credentials?.username
            && buffered.toString("utf8", userEnd + 1, end) === this.options.credentials?.password && !this.options.rejectAuth;
          socket.write(Buffer.from([1, valid ? 0 : 1]));
          buffered = buffered.subarray(end);
          if (!valid) { state = "done"; return; }
          state = "command";
        } else {
          if (buffered.length < 4) return;
          const address = parseFixtureAddress(buffered, 3);
          if (!address) return;
          const command = buffered[1];
          this.commandCodes.push(command);
          state = "done";
          socket.removeListener("data", onData);
          const head = buffered.subarray(address.end);
          if (buffered[0] !== 5 || buffered[2] !== 0) {
            this.protocolFailures.push("Invalid SOCKS command header");
            socket.destroy();
            return;
          }
          if (this.options.socksMode === "bad-reserved") {
            socket.write(Buffer.concat([Buffer.from([5, 0, 1]), ipv4Address(LOOPBACK, this.relayPort)]));
            return;
          }
          if (this.options.socksMode === "short-reply") { socket.write(Buffer.from([5, 0, 0, 1, 127])); return; }
          if (command === 1) {
            if (address.host !== this.tcpTarget.host || address.port !== this.echoPort) {
              this.protocolFailures.push("Proxy attempted a non-owned TCP destination");
              socket.destroy();
              return;
            }
            socket.pause();
            this.tunnel(socket, head, Buffer.concat([Buffer.from([5, 0, 0]), ipv4Address(LOOPBACK, this.echoPort)]));
          } else if (command === 3) {
            this.associateClientPorts.push(address.port);
            if (this.options.rejectUdp) {
              socket.write(Buffer.concat([Buffer.from([5, 7, 0]), ipv4Address(LOOPBACK, this.relayPort)]));
              return;
            }
            this.udpControl = socket;
            const relayHost = this.options.relayAddress === "wildcard" ? "0.0.0.0" : LOOPBACK;
            const relayPort = this.options.relayAddress === "target" ? this.stunPort : this.relayPort;
            const reply = Buffer.concat([Buffer.from([5, 0, 0]), ipv4Address(relayHost, relayPort)]);
            if (this.options.closeControl === "after-associate") socket.end(reply);
            else socket.write(reply);
          } else {
            this.protocolFailures.push("Unexpected SOCKS command");
            socket.destroy();
          }
        }
      }
    };
    socket.on("data", onData);
  }

  private relayResponse(packet: Buffer, client: { host: string; port: number }): void {
    const mode = this.options.frameMode;
    const host = mode === "wrong-address" ? "127.0.0.2" : this.options.udpResponseHost ?? this.udpTarget.host;
    const port = mode === "wrong-port" ? (this.stunPort === 65535 ? 65534 : this.stunPort + 1) : this.stunPort;
    let frame = Buffer.concat([Buffer.from([0, 0, 0]), framedAddress(host, port), packet]);
    if (mode === "fragment") frame[2] = 1;
    if (mode === "reserved") frame[0] = 1;
    if (mode === "bad-atyp") frame[3] = 0x7f;
    if (mode === "truncated") frame = frame.subarray(0, 8);
    this.send(mode === "wrong-relay-source" ? this.rogue : this.relay, frame, client.port, client.host);
  }

  async expectClientsClosed(): Promise<void> {
    await Promise.all([...this.proxyClients].map(socket => {
      if (socket.destroyed) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.removeListener("close", onClose); reject(new Error("Probe leaked a proxy client")); }, 1000);
        const onClose = () => { clearTimeout(timer); resolve(); };
        socket.once("close", onClose);
      });
    }));
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([
      ...[this.echoServer, this.proxyServer].filter(server => server.listening).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      })),
      ...[...this.bound].map(socket => new Promise<void>(resolve => socket.close(resolve))),
    ]);
  }
}

const fixtures: LoopbackFixture[] = [];
async function fixture(options: FixtureOptions = {}): Promise<LoopbackFixture> {
  const value = new LoopbackFixture(options);
  fixtures.push(value);
  await value.start();
  return value;
}

afterEach(async () => {
  for (const value of fixtures.splice(0).reverse()) await value.close();
});

function expectPrivateResult(result: ProxyTransportProbeResult): void {
  expect(Object.keys(result).sort()).toEqual(["tcp", "udp", "webrtc"]);
  for (const item of [result.tcp, result.udp, result.webrtc]) {
    expect(Object.keys(item).sort()).toEqual(["bytesReceived", "bytesSent", "reason", "rttMs", "status"]);
    expect(Number.isInteger(item.bytesSent)).toBe(true);
    expect(Number.isInteger(item.bytesReceived)).toBe(true);
    expect(item.bytesSent).toBeGreaterThanOrEqual(0);
    expect(item.bytesReceived).toBeGreaterThanOrEqual(0);
    if (item.status === "verified") {
      expect(Number.isFinite(item.rttMs)).toBe(true);
      expect(item.rttMs).toBeGreaterThanOrEqual(0);
    } else expect(item.rttMs).toBeNull();
  }
  expect(result.webrtc).toEqual({ status: "not-tested", reason: "browser-not-probed", bytesSent: 0, bytesReceived: 0, rttMs: null });
  const serialized = JSON.stringify(result);
  for (const privateValue of [LOOPBACK, TEST_AUTH.username, TEST_AUTH.password, ERROR_SENTINEL, "owned-transport.invalid"]) {
    expect(serialized).not.toContain(privateValue);
  }
}

async function probeBoth(value: LoopbackFixture, timeoutMs = 1500): Promise<ProxyTransportProbeResult> {
  const result = await probeProxyTransport(value.proxyConfig(), { tcpTarget: value.tcpTarget, udpTarget: value.udpTarget, timeoutMs });
  expectPrivateResult(result);
  expect(value.protocolFailures).toEqual([]);
  await value.expectClientsClosed();
  return result;
}

describe("probeProxyTransport — real loopback transport evidence", () => {
  it("HTTP CONNECT sends a bounded random challenge to the owned TCP echo target and measures payload bytes", async () => {
    const value = await fixture({ type: "http", credentials: TEST_AUTH });
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({ status: "verified", reason: "echo-verified", bytesSent: 32, bytesReceived: 32 });
    expect(value.echoPayloads).toHaveLength(1);
    expect(value.echoPayloads[0]).toHaveLength(32);
    expect(value.httpAuthorizations).toEqual([`Basic ${Buffer.from(`${TEST_AUTH.username}:${TEST_AUTH.password}`).toString("base64")}`]);
    expect(result.udp).toEqual({ status: "unsupported", reason: "http-udp-unsupported", bytesSent: 0, bytesReceived: 0, rttMs: null });
    expect(value.stunRequests).toHaveLength(0);
    expect(value.relayRequests).toHaveLength(0);
    expect(value.proxyClients.size).toBe(1);
  });

  it.each(["socks5", "socks5h"] as const)("%s CONNECT and UDP ASSOCIATE require actual TCP and relayed STUN round trips", async type => {
    const value = await fixture({ type, credentials: TEST_AUTH });
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({ status: "verified", reason: "echo-verified", bytesSent: 32, bytesReceived: 32 });
    expect(result.udp).toMatchObject({ status: "verified", reason: "stun-binding-verified", bytesSent: 20, bytesReceived: 32 });
    expect(value.echoPayloads[0]).toHaveLength(32);
    expect(value.commandCodes.sort()).toEqual([1, 3]);
    expect(value.stunRequests).toHaveLength(1);
    expect(value.relayRequests).toHaveLength(1);
    expect(value.stunPeerPorts).toEqual([value.relayPort]);
    expect(value.associateClientPorts[0]).not.toBe(0);
    expect(value.associateClientPorts[0]).not.toBe(value.relayPort);
    expect(value.proxyClients.size).toBe(2);
  });

  it("uses independent unpredictable TCP challenges and 12-byte STUN transaction IDs for each invocation", async () => {
    const value = await fixture();
    await probeBoth(value);
    await probeBoth(value);
    expect(value.echoPayloads).toHaveLength(2);
    expect(value.echoPayloads[0]).not.toEqual(value.echoPayloads[1]);
    expect(value.stunRequests).toHaveLength(2);
    expect(value.stunRequests[0].subarray(8, 20)).toHaveLength(12);
    expect(value.stunRequests[0].subarray(8, 20)).not.toEqual(value.stunRequests[1].subarray(8, 20));
  });

  it.each(["http", "socks5", "socks5h"] as const)("%s with no UDP target is not-tested and emits no UDP", async type => {
    const value = await fixture({ type });
    const result = await probeProxyTransport(value.proxyConfig(), { tcpTarget: value.tcpTarget, timeoutMs: 1500 });
    expectPrivateResult(result);
    expect(result.tcp.status).toBe("verified");
    expect(result.udp).toEqual({ status: "not-tested", reason: "udp-target-not-provided", bytesSent: 0, bytesReceived: 0, rttMs: null });
    expect(value.commandCodes).not.toContain(3);
    expect(value.stunRequests).toHaveLength(0);
    expect(value.relayRequests).toHaveLength(0);
    await value.expectClientsClosed();
  });

  it.each([false, true])("HTTP 407 is sanitized and sends no challenge (credentials supplied: %s)", async includeCredentials => {
    const value = await fixture({ type: "http", credentials: TEST_AUTH, httpMode: "407" });
    const result = await probeProxyTransport(value.proxyConfig(includeCredentials), { tcpTarget: value.tcpTarget, udpTarget: value.udpTarget });
    expectPrivateResult(result);
    expect(result.tcp).toEqual({ status: "failed", reason: includeCredentials ? "proxy-auth-failed" : "proxy-auth-required", bytesSent: 0, bytesReceived: 0, rttMs: null });
    expect(result.udp.status).toBe("unsupported");
    expect(value.echoPayloads).toHaveLength(0);
    expect(value.stunRequests).toHaveLength(0);
    await value.expectClientsClosed();
  });

  it.each(["oversized-header", "oversized-response", "malformed", "rejected"] as const)("bounds/rejects HTTP %s without opening a direct target socket", async httpMode => {
    const value = await fixture({ type: "http", httpMode });
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({
      status: "failed", bytesSent: 0, bytesReceived: 0,
      reason: httpMode.startsWith("oversized") ? "response-too-large" : httpMode === "malformed" ? "http-response-invalid" : "http-connect-rejected",
    });
    expect(value.echoPayloads).toHaveLength(0);
    expect(value.stunRequests).toHaveLength(0);
  });

  it.each(["http", "socks5"] as const)("%s rejects an incorrect echo despite a successful tunnel handshake", async type => {
    const value = await fixture({ type, tcpMode: "wrong-echo" });
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "tcp-echo-mismatch", bytesSent: 32, bytesReceived: 32, rttMs: null });
    expect(value.echoPayloads[0]).toHaveLength(32);
  });

  it("does not treat an echoed prefix plus extra data as verified", async () => {
    const value = await fixture({ type: "http", tcpMode: "extra-echo" });
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "tcp-echo-mismatch", bytesSent: 32 });
  });

  it("accounts for partial echo bytes but cannot verify a truncated round trip", async () => {
    const value = await fixture({ type: "http", tcpMode: "partial-echo" });
    const result = await probeBoth(value, 200);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "timeout", bytesSent: 32, bytesReceived: 31, rttMs: null });
  });

  it("rejects SOCKS username/password authentication for both transports without falling back", async () => {
    const value = await fixture({ credentials: TEST_AUTH, rejectAuth: true });
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "proxy-auth-failed", bytesSent: 0 });
    expect(result.udp).toMatchObject({ status: "failed", reason: "proxy-auth-failed", bytesSent: 0 });
    expect(value.commandCodes).toEqual([]);
    expect(value.echoPayloads).toEqual([]);
    expect(value.relayRequests).toEqual([]);
    expect(value.stunRequests).toEqual([]);
  });

  it("does not downgrade configured SOCKS authentication to anonymous", async () => {
    const value = await fixture({ credentials: TEST_AUTH, downgradeAuth: true });
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "proxy-auth-failed" });
    expect(result.udp).toMatchObject({ status: "failed", reason: "proxy-auth-failed" });
    expect(value.commandCodes).toEqual([]);
  });

  it.each(["bad-version", "bad-reserved"] as const)("validates SOCKS %s on both connections", async socksMode => {
    const value = await fixture({ socksMode });
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "socks-response-invalid" });
    expect(result.udp).toMatchObject({ status: "failed", reason: "socks-response-invalid" });
    expect(value.stunRequests).toHaveLength(0);
  });

  it("strict fixed-length SOCKS reads time out rather than accepting a short reply", async () => {
    const value = await fixture({ socksMode: "short-reply" });
    const result = await probeBoth(value, 200);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "timeout", bytesSent: 0 });
    expect(result.udp).toMatchObject({ status: "failed", reason: "timeout", bytesSent: 0 });
    expect(value.stunRequests).toHaveLength(0);
  });

  it("keeps verified TCP independent of an explicit UDP ASSOCIATE refusal", async () => {
    const value = await fixture({ rejectUdp: true });
    const result = await probeBoth(value);
    expect(result.tcp.status).toBe("verified");
    expect(result.udp).toEqual({ status: "failed", reason: "socks-udp-rejected", bytesSent: 0, bytesReceived: 0, rttMs: null });
    expect(value.relayRequests).toHaveLength(0);
    expect(value.stunRequests).toHaveLength(0);
  });

  it("does not infer UDP support from ASSOCIATE when relayed STUN packets are dropped", async () => {
    const value = await fixture({ stunMode: "drop" });
    const result = await probeBoth(value, 200);
    expect(value.commandCodes).toContain(3);
    expect(value.stunRequests).toHaveLength(1);
    expect(result.udp).toMatchObject({ status: "failed", reason: "timeout", bytesSent: 20, bytesReceived: 0, rttMs: null });
    expect(result.tcp.status).not.toBe("verified"); // No verified result may escape the whole-call deadline.
  });

  it("replaces a wildcard relay address only with the connected SOCKS peer", async () => {
    const value = await fixture({ relayAddress: "wildcard" });
    const result = await probeBoth(value);
    expect(result.udp.status).toBe("verified");
    expect(value.stunPeerPorts).toEqual([value.relayPort]);
  });

  it("rejects a relay endpoint equal to the owned UDP target without a direct datagram", async () => {
    const value = await fixture({ relayAddress: "target" });
    const result = await probeBoth(value);
    expect(result.udp).toMatchObject({ status: "failed", reason: "socks-relay-invalid", bytesSent: 0 });
    expect(value.stunRequests).toHaveLength(0);
    expect(value.relayRequests).toHaveLength(0);
  });

  it.each(["xor-v4", "xor-v6", "mapped-v4", "mapped-v6", "both"] as const)("validates %s STUN mapped address structures without returning the mapped address", async stunMode => {
    const value = await fixture({ stunMode });
    const result = await probeBoth(value);
    expect(result.udp).toMatchObject({ status: "verified", reason: "stun-binding-verified", bytesSent: 20 });
    expect(result.udp.bytesReceived).toBe(stunMode === "both" ? 44 : stunMode.endsWith("v6") ? 44 : 32);
    expect(JSON.stringify(result)).not.toContain("2001");
  });

  it.each([
    ["bad-txid", "stun-transaction-mismatch"],
    ["bad-cookie", "stun-response-invalid"],
    ["bad-length", "stun-response-invalid"],
    ["bad-type", "stun-response-invalid"],
    ["binding-error", "stun-binding-rejected"],
    ["missing-mapped", "stun-mapped-address-invalid"],
    ["bad-mapped-length", "stun-mapped-address-invalid"],
    ["bad-mapped-family", "stun-mapped-address-invalid"],
    ["bad-mapped-reserved", "stun-mapped-address-invalid"],
    ["zero-mapped-port", "stun-mapped-address-invalid"],
    ["zero-mapped-address", "stun-mapped-address-invalid"],
    ["duplicate-mapped", "stun-mapped-address-invalid"],
    ["conflicting-mapped", "stun-mapped-address-invalid"],
    ["truncated-attribute", "stun-response-invalid"],
    ["trailing-data", "stun-response-invalid"],
    ["oversized", "response-too-large"],
  ] as const)("does not verify a real relayed %s STUN response", async (stunMode, reason) => {
    const value = await fixture({ stunMode });
    const result = await probeBoth(value);
    expect(result.udp).toMatchObject({ status: "failed", reason, bytesSent: 20, rttMs: null });
    expect(value.stunRequests).toHaveLength(1);
    expect(value.relayRequests).toHaveLength(1);
  });

  it.each([
    ["fragment", "udp-fragmented"],
    ["reserved", "udp-frame-invalid"],
    ["wrong-address", "udp-target-mismatch"],
    ["wrong-port", "udp-target-mismatch"],
    ["bad-atyp", "udp-frame-invalid"],
    ["truncated", "udp-frame-invalid"],
  ] as const)("rejects a SOCKS UDP %s frame even when its STUN payload is valid", async (frameMode, reason) => {
    const value = await fixture({ frameMode });
    const result = await probeBoth(value);
    expect(result.udp).toMatchObject({ status: "failed", reason, bytesSent: 20, rttMs: null });
    expect(value.stunRequests).toHaveLength(1);
  });

  it("cannot verify a valid response sent from a different real UDP source port", async () => {
    const value = await fixture({ frameMode: "wrong-relay-source" });
    const result = await probeBoth(value, 200);
    expect(result.udp).toMatchObject({ status: "failed", reason: "timeout", bytesSent: 20, bytesReceived: 0 });
    expect(value.stunRequests).toHaveLength(1);
  });

  it.each(["after-associate", "after-udp"] as const)("requires the SOCKS control socket to remain live (%s closure)", async closeControl => {
    const value = await fixture({ closeControl });
    const result = await probeBoth(value);
    expect(result.udp).toMatchObject({ status: "failed", reason: "socks-control-closed", rttMs: null });
    expect(value.stunRequests).toHaveLength(0);
  });

  it.each(["socks5", "socks5h"] as const)("%s sends owned hostnames through the proxy without resolving target names locally", async type => {
    const value = await fixture({ type, tcpTargetHost: "owned-transport.invalid", udpTargetHost: "owned-transport.invalid" });
    const result = await probeBoth(value);
    expect(result.tcp.status).toBe("verified");
    expect(result.udp.status).toBe("verified");
    expect(value.stunRequests).toHaveLength(1);
  });

  it("fails closed when a domain UDP target returns an unverifiable numeric framed source", async () => {
    const value = await fixture({ type: "socks5h", udpTargetHost: "owned-transport.invalid", udpResponseHost: LOOPBACK });
    const result = await probeBoth(value);
    expect(result.udp).toMatchObject({ status: "failed", reason: "udp-target-mismatch" });
    expect(value.stunRequests).toHaveLength(1);
  });

  it("an already aborted signal opens neither proxy nor direct target sockets", async () => {
    const value = await fixture();
    const controller = new AbortController();
    controller.abort(new Error(ERROR_SENTINEL));
    const result = await probeProxyTransport(value.proxyConfig(), {
      tcpTarget: value.tcpTarget, udpTarget: value.udpTarget, signal: controller.signal,
    });
    expectPrivateResult(result);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "aborted", bytesSent: 0 });
    expect(result.udp).toMatchObject({ status: "failed", reason: "aborted", bytesSent: 0 });
    expect(value.proxyClients.size).toBe(0);
    expect(value.echoPayloads).toHaveLength(0);
    expect(value.stunRequests).toHaveLength(0);
  });

  it("aborting before a real echo arrives cannot produce a late TCP success", async () => {
    const controller = new AbortController();
    const value = await fixture({ type: "http", onEcho: () => controller.abort(new Error(ERROR_SENTINEL)) });
    const result = await probeProxyTransport(value.proxyConfig(), {
      tcpTarget: value.tcpTarget, udpTarget: value.udpTarget, signal: controller.signal, timeoutMs: 1500,
    });
    expectPrivateResult(result);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "aborted", rttMs: null });
    expect(result.udp.status).toBe("unsupported");
    expect(value.echoPayloads[0]).toHaveLength(32);
    await value.expectClientsClosed();
  });

  it("aborting with a valid STUN reply in flight cannot produce a late UDP or whole-call success", async () => {
    const controller = new AbortController();
    const value = await fixture({ onStunRequest: () => controller.abort(new Error(ERROR_SENTINEL)) });
    const result = await probeProxyTransport(value.proxyConfig(), {
      tcpTarget: value.tcpTarget, udpTarget: value.udpTarget, signal: controller.signal, timeoutMs: 1500,
    });
    expectPrivateResult(result);
    expect(result.udp).toMatchObject({ status: "failed", reason: "aborted", rttMs: null });
    expect(result.tcp.status).not.toBe("verified");
    expect(value.stunRequests).toHaveLength(1);
    await value.expectClientsClosed();
  });

  it.each(["http", "socks5"] as const)("the whole-call deadline includes the %s handshake, not just echo/UDP receive", async type => {
    const value = await fixture({ type, httpMode: "stall", socksMode: "stall-greeting" });
    const startedAt = performance.now();
    const result = await probeBoth(value, 200);
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "timeout", bytesSent: 0 });
    expect(result.udp.status).toBe(type === "http" ? "unsupported" : "failed");
    expect(value.echoPayloads).toHaveLength(0);
    expect(value.stunRequests).toHaveLength(0);
  });

  it("a delayed valid echo cannot escape the absolute deadline", async () => {
    const value = await fixture({ type: "http", tcpMode: "delayed-echo" });
    const result = await probeBoth(value, 100);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "timeout", bytesSent: 32, rttMs: null });
    expect(value.echoPayloads[0]).toHaveLength(32);
  });

  it("closed proxy ports yield only sanitized failures and never a direct/fallback packet", async () => {
    const value = await fixture();
    await new Promise<void>((resolve, reject) => value.proxyServer.close(error => error ? reject(error) : resolve()));
    const result = await probeBoth(value);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "connection-failed", bytesSent: 0 });
    expect(result.udp).toMatchObject({ status: "failed", reason: "connection-failed", bytesSent: 0 });
    expect(value.echoPayloads).toHaveLength(0);
    expect(value.stunRequests).toHaveLength(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60001])("rejects an unbounded/invalid timeout %s without sockets", async timeoutMs => {
    const value = await fixture();
    const result = await probeProxyTransport(value.proxyConfig(), { tcpTarget: value.tcpTarget, udpTarget: value.udpTarget, timeoutMs });
    expectPrivateResult(result);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "invalid-options" });
    expect(result.udp).toMatchObject({ status: "failed", reason: "invalid-options" });
    expect(value.proxyClients.size).toBe(0);
  });

  it("rejects HTTP authority injection before connecting and does not try UDP", async () => {
    const value = await fixture({ type: "http" });
    const result = await probeProxyTransport(value.proxyConfig(), {
      tcpTarget: { host: `owned.invalid\r\nX-Secret: ${ERROR_SENTINEL}`, port: value.echoPort }, udpTarget: value.udpTarget,
    });
    expectPrivateResult(result);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "invalid-target" });
    expect(result.udp.status).toBe("unsupported");
    expect(value.proxyClients.size).toBe(0);
    expect(value.stunRequests).toHaveLength(0);
  });

  it("validates SOCKS credential byte lengths before any network operation", async () => {
    const value = await fixture();
    const result = await probeProxyTransport({ ...value.proxyConfig(), username: "测".repeat(100), password: "test" }, {
      tcpTarget: value.tcpTarget, udpTarget: value.udpTarget,
    });
    expectPrivateResult(result);
    expect(result.tcp).toMatchObject({ status: "failed", reason: "invalid-proxy" });
    expect(result.udp).toMatchObject({ status: "failed", reason: "invalid-proxy" });
    expect(value.proxyClients.size).toBe(0);
  });
});
