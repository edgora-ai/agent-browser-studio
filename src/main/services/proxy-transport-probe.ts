import { randomBytes, timingSafeEqual } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket as DatagramSocket } from "node:dgram";
import { isIP, Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { domainToASCII } from "node:url";
import type { ProxyConfig } from "../types.js";

export interface ProxyTransportProbeTarget {
  host: string;
  port: number;
}

export interface ProxyTransportProbeOptions {
  /** Main-owned, bounded, byte-for-byte TCP echo service, not an arbitrary website. */
  tcpTarget: ProxyTransportProbeTarget;
  /** Main-owned RFC 5389 STUN Binding service. Omission sends no UDP. */
  udpTarget?: ProxyTransportProbeTarget;
  /** One deadline for the entire call, including both proxy handshakes. 1–60000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ProxyTransportProbeFailureReason =
  | "invalid-options"
  | "invalid-proxy"
  | "invalid-target"
  | "aborted"
  | "timeout"
  | "connection-failed"
  | "connection-closed"
  | "io-error"
  | "response-too-large"
  | "proxy-auth-required"
  | "proxy-auth-failed"
  | "http-response-invalid"
  | "http-connect-rejected"
  | "socks-response-invalid"
  | "socks-connect-rejected"
  | "socks-udp-rejected"
  | "socks-relay-invalid"
  | "socks-control-closed"
  | "socks-control-unexpected-data"
  | "tcp-echo-mismatch"
  | "udp-relay-source-mismatch"
  | "udp-frame-invalid"
  | "udp-fragmented"
  | "udp-target-mismatch"
  | "stun-response-invalid"
  | "stun-transaction-mismatch"
  | "stun-binding-rejected"
  | "stun-mapped-address-invalid"
  | "cleanup-failed";

interface PayloadMeasurement {
  /** Application payload only: TCP challenge/echo or STUN, excluding proxy framing/auth. */
  bytesSent: number;
  bytesReceived: number;
}

interface Verified<Reason extends string> extends PayloadMeasurement {
  status: "verified";
  reason: Reason;
  /** Challenge-to-validated-response time; proxy connection/authentication is excluded. */
  rttMs: number;
}

export interface ProxyTransportProbeFailure extends PayloadMeasurement {
  status: "failed";
  reason: ProxyTransportProbeFailureReason;
  rttMs: null;
}

type Unmeasured<Status extends "unsupported" | "not-tested", Reason extends string> = {
  status: Status;
  reason: Reason;
  bytesSent: 0;
  bytesReceived: 0;
  rttMs: null;
};

export type ProxyTcpTransportProbeResult = Verified<"echo-verified"> | ProxyTransportProbeFailure;
export type ProxyUdpTransportProbeResult =
  | Verified<"stun-binding-verified">
  | ProxyTransportProbeFailure
  | Unmeasured<"unsupported", "http-udp-unsupported">
  | Unmeasured<"not-tested", "udp-target-not-provided">;
export type ProxyWebRtcTransportProbeResult = Unmeasured<"not-tested", "browser-not-probed">;

/** Deliberately contains no endpoints, mapped addresses, credentials, or raw errors. */
export interface ProxyTransportProbeResult {
  tcp: ProxyTcpTransportProbeResult;
  udp: ProxyUdpTransportProbeResult;
  webrtc: ProxyWebRtcTransportProbeResult;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 60000;
const CHALLENGE_BYTES = 32;
const MAX_HTTP_HEADER_BYTES = 8192;
const MAX_UDP_BYTES = 2048;
const STUN_COOKIE = 0x2112a442;
const HTTP_HEADER_END = Buffer.from("\r\n\r\n");

class ProbeError extends Error {
  constructor(readonly reason: ProxyTransportProbeFailureReason) {
    // Never put a socket error, endpoint, or authentication material into an error.
    super(reason);
  }
}

class Deadline {
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly stopped: Promise<ProbeError>;
  private stop!: (error: ProbeError) => void;
  private failure: ProbeError | undefined;
  private readonly onAbort = () => this.stopWith("aborted");

  constructor(timeoutMs: number, startedAt: number, private readonly signal?: AbortSignal) {
    this.expiresAt = startedAt + timeoutMs;
    this.stopped = new Promise(resolve => { this.stop = resolve; });
    this.timer = setTimeout(() => this.stopWith("timeout"), Math.max(0, this.expiresAt - performance.now()));
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  private stopWith(reason: "aborted" | "timeout"): void {
    if (!this.failure) {
      this.failure = new ProbeError(reason);
      this.stop(this.failure);
    }
  }

  currentFailure(): ProbeError | undefined {
    if (this.signal?.aborted) this.stopWith("aborted");
    if (performance.now() >= this.expiresAt) this.stopWith("timeout");
    return this.failure;
  }

  check(): void {
    const error = this.currentFailure();
    if (error) throw error;
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    // Poll without throwing first, then always consume the race. Even an already
    // aborted call must observe a late rejection from the supplied I/O promise.
    this.currentFailure();
    const value = await Promise.race([
      operation,
      this.stopped.then(error => { throw error; }),
    ]);
    this.check();
    return value;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}

interface Address extends ProxyTransportProbeTarget {
  family: 0 | 4 | 6;
}

interface NormalizedProxy extends Address {
  type: ProxyConfig["type"];
  username?: string;
  password?: string;
}

function ipBytes(host: string): Buffer {
  if (isIP(host) === 4) return Buffer.from(host.split(".").map(Number));
  // isIP has already validated the literal; expand IPv4 tails before :: expansion.
  let expanded = host;
  const lastColon = expanded.lastIndexOf(":");
  if (expanded.includes(".")) {
    const tail = ipBytes(expanded.slice(lastColon + 1));
    expanded = `${expanded.slice(0, lastColon)}:${tail.readUInt16BE(0).toString(16)}:${tail.readUInt16BE(2).toString(16)}`;
  }
  const halves = expanded.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  const result = Buffer.alloc(16);
  words.forEach((word, index) => result.writeUInt16BE(parseInt(word, 16), index * 2));
  return result;
}

function comparableIp(bytes: Buffer): Buffer {
  if (bytes.length === 16 && bytes.subarray(0, 10).every(byte => byte === 0)
      && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.subarray(12);
  return bytes;
}

function sameIp(a: string, b: string): boolean {
  return isIP(a) !== 0 && isIP(b) !== 0 && comparableIp(ipBytes(a)).equals(comparableIp(ipBytes(b)));
}

function unusableIp(bytes: Buffer): boolean {
  const value = comparableIp(bytes);
  return value.every(byte => byte === 0)
    || (value.length === 4 && (value[0] === 0 || value[0] >= 224))
    || (value.length === 16 && value[0] === 0xff);
}

function normalizeAddress(target: ProxyTransportProbeTarget, reason: "invalid-proxy" | "invalid-target"): Address {
  if (!target || typeof target.host !== "string" || target.host.length > 255
      || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new ProbeError(reason);
  let host = target.host;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host || /[\s\x00-\x1f\x7f%\/@\\?#]/u.test(host)) throw new ProbeError(reason);
  const family = isIP(host) as 0 | 4 | 6;
  if (family) {
    if (unusableIp(ipBytes(host))) throw new ProbeError(reason);
    return { host, port: target.port, family };
  }
  host = domainToASCII(host).toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || !host.split(".").every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new ProbeError(reason);
  return { host, port: target.port, family: 0 };
}

function normalizeProxy(config: ProxyConfig): NormalizedProxy {
  if (!config || !["http", "socks5", "socks5h"].includes(config.type)) throw new ProbeError("invalid-proxy");
  const address = normalizeAddress(config, "invalid-proxy");
  const hasAuth = config.username !== undefined || config.password !== undefined;
  if (hasAuth && (typeof config.username !== "string" || typeof config.password !== "string")) {
    throw new ProbeError("invalid-proxy");
  }
  if (hasAuth) {
    if (config.username!.length > 2048 || config.password!.length > 2048) throw new ProbeError("invalid-proxy");
    const userBytes = Buffer.byteLength(config.username!);
    const passBytes = Buffer.byteLength(config.password!);
    if (config.type === "http") {
      if (userBytes + passBytes > 2048 || config.username!.includes(":")) throw new ProbeError("invalid-proxy");
    } else if (userBytes < 1 || userBytes > 255 || passBytes < 1 || passBytes > 255) {
      throw new ProbeError("invalid-proxy");
    }
  }
  return { ...address, type: config.type, username: config.username, password: config.password };
}

function encodeAddress(address: Address): Buffer {
  const host = address.family ? ipBytes(address.host) : Buffer.from(address.host, "ascii");
  const port = Buffer.alloc(2);
  port.writeUInt16BE(address.port);
  return Buffer.concat([
    Buffer.from(address.family === 4 ? [1] : address.family === 6 ? [4] : [3, host.length]),
    host,
    port,
  ]);
}

interface PendingRead {
  inspect: (buffer: Buffer) => number | undefined;
  resolve: (value: Buffer) => void;
  reject: (error: ProbeError) => void;
}

/** One bounded reader for the lifetime of a stream; no data-listener gaps or short reads. */
class ProxyStream {
  readonly socket = new Socket();
  private buffer: Buffer = Buffer.alloc(0);
  private received = 0;
  private pending: PendingRead | undefined;
  private failure: ProbeError | undefined;
  private readonly failed: Promise<ProbeError>;
  private failSignal!: (error: ProbeError) => void;
  private connected = false;
  private quiet = false;

  constructor(private readonly limit: number, private readonly control = false) {
    this.failed = new Promise(resolve => { this.failSignal = resolve; });
    this.socket.on("data", (data: Buffer) => {
      if (this.failure) return;
      if (this.quiet) return this.fail("socks-control-unexpected-data");
      if (data.length > this.limit - this.received) return this.fail("response-too-large");
      this.received += data.length;
      this.buffer = Buffer.concat([this.buffer, data]);
      this.pump();
    });
    this.socket.on("error", () => this.fail(this.connected ? "io-error" : "connection-failed"));
    this.socket.on("end", () => this.fail(this.control ? "socks-control-closed" : "connection-closed"));
    this.socket.on("close", () => this.fail(this.control ? "socks-control-closed" : "connection-closed"));
  }

  private fail(reason: ProxyTransportProbeFailureReason): void {
    if (this.failure) return;
    this.failure = new ProbeError(reason);
    this.failSignal(this.failure);
    this.pending?.reject(this.failure);
    this.pending = undefined;
    this.socket.destroy();
  }

  assertAlive(): void {
    if (this.failure) throw this.failure;
    if (this.socket.destroyed || !this.socket.writable) {
      throw new ProbeError(this.control ? "socks-control-closed" : "connection-closed");
    }
  }

  async guard<T>(operation: Promise<T>, deadline: Deadline): Promise<T> {
    const value = await deadline.wait(Promise.race([
      operation,
      this.failed.then(error => { throw error; }),
    ]));
    deadline.check();
    return value;
  }

  async connect(proxy: Address, deadline: Deadline): Promise<void> {
    deadline.check();
    await this.guard(new Promise<void>(resolve => {
      this.socket.connect({ host: proxy.host, port: proxy.port }, () => {
        this.connected = true;
        resolve();
      });
    }), deadline);
    deadline.check();
    this.assertAlive();
  }

  async write(data: Buffer, deadline: Deadline): Promise<void> {
    deadline.check();
    this.assertAlive();
    await this.guard(new Promise<void>((resolve, reject) => {
      this.socket.write(data, error => error ? reject(new ProbeError("io-error")) : resolve());
    }), deadline);
    deadline.check();
  }

  private pump(): void {
    if (!this.pending) return;
    const pending = this.pending;
    let count: number | undefined;
    try {
      count = pending.inspect(this.buffer);
    } catch (error) {
      this.fail(error instanceof ProbeError ? error.reason : "io-error");
      return;
    }
    if (count === undefined) return;
    this.pending = undefined;
    const result = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    pending.resolve(result);
  }

  private async read(inspect: PendingRead["inspect"], deadline: Deadline): Promise<Buffer> {
    deadline.check();
    if (this.failure) throw this.failure;
    if (this.pending) throw new ProbeError("io-error");
    const operation = new Promise<Buffer>((resolve, reject) => {
      this.pending = { inspect, resolve, reject };
      this.pump();
    });
    const value = await this.guard(operation, deadline);
    deadline.check();
    return value;
  }

  async exact(count: number, deadline: Deadline): Promise<Buffer> {
    const value = await this.read(buffer => buffer.length >= count ? count : undefined, deadline);
    deadline.check();
    return value;
  }

  async httpHeader(deadline: Deadline): Promise<Buffer> {
    const value = await this.read(buffer => {
      const end = buffer.indexOf(HTTP_HEADER_END);
      if (end >= 0 && end + HTTP_HEADER_END.length <= MAX_HTTP_HEADER_BYTES) return end + HTTP_HEADER_END.length;
      if (end >= 0 || buffer.length >= MAX_HTTP_HEADER_BYTES) throw new ProbeError("response-too-large");
      return undefined;
    }, deadline);
    deadline.check();
    return value;
  }

  get bytesReceived(): number { return this.received; }
  get bufferedBytes(): number { return this.buffer.length; }

  requireQuiet(): void {
    this.quiet = true;
    if (this.buffer.length) this.fail("socks-control-unexpected-data");
    this.assertAlive();
  }

  close(): void {
    this.fail(this.control ? "socks-control-closed" : "connection-closed");
  }
}

async function httpConnect(stream: ProxyStream, proxy: NormalizedProxy, target: Address, deadline: Deadline): Promise<void> {
  const authority = `${target.family === 6 ? `[${target.host}]` : target.host}:${target.port}`;
  const authorization = proxy.username === undefined ? ""
    : `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`, "utf8").toString("base64")}\r\n`;
  await stream.write(Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`, "ascii"), deadline);
  deadline.check();
  const header = await stream.httpHeader(deadline);
  deadline.check();
  const lines = header.toString("latin1").slice(0, -4).split("\r\n");
  const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: [\t\x20-\x7e\x80-\xff]*)?$/.exec(lines[0]);
  if (!status || lines.length > 128 || lines.slice(1).some(line =>
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e\x80-\xff]*$/.test(line))) {
    throw new ProbeError("http-response-invalid");
  }
  const code = Number(status[1]);
  if (code === 407) throw new ProbeError(proxy.username === undefined ? "proxy-auth-required" : "proxy-auth-failed");
  if (code < 200 || code >= 300) throw new ProbeError("http-connect-rejected");
  if (stream.bufferedBytes) throw new ProbeError("http-response-invalid");
  stream.assertAlive();
}

async function socksAuthenticate(stream: ProxyStream, proxy: NormalizedProxy, deadline: Deadline): Promise<void> {
  const method = proxy.username === undefined ? 0 : 2;
  await stream.write(Buffer.from([5, 1, method]), deadline);
  deadline.check();
  const selection = await stream.exact(2, deadline);
  deadline.check();
  if (selection[0] !== 5) throw new ProbeError("socks-response-invalid");
  if (selection[1] === 0xff || selection[1] === 2 && method === 0) {
    throw new ProbeError(method === 0 ? "proxy-auth-required" : "proxy-auth-failed");
  }
  if (selection[1] !== method) throw new ProbeError(method === 2 ? "proxy-auth-failed" : "socks-response-invalid");
  if (method === 2) {
    const user = Buffer.from(proxy.username!, "utf8");
    const password = Buffer.from(proxy.password!, "utf8");
    await stream.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]), deadline);
    deadline.check();
    const authentication = await stream.exact(2, deadline);
    deadline.check();
    if (authentication[0] !== 1) throw new ProbeError("socks-response-invalid");
    if (authentication[1] !== 0) throw new ProbeError("proxy-auth-failed");
  }
  stream.assertAlive();
}

function decodeAddress(buffer: Buffer, offset: number, reason: ProxyTransportProbeFailureReason): { address: Address; end: number } {
  if (offset >= buffer.length) throw new ProbeError(reason);
  const atyp = buffer[offset++];
  let host: string;
  let family: Address["family"];
  if (atyp === 1 || atyp === 4) {
    const size = atyp === 1 ? 4 : 16;
    if (offset + size + 2 > buffer.length) throw new ProbeError(reason);
    const bytes = buffer.subarray(offset, offset + size);
    host = atyp === 1 ? [...bytes].join(".")
      : Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(":");
    family = atyp === 1 ? 4 : 6;
    offset += size;
  } else if (atyp === 3) {
    if (offset >= buffer.length) throw new ProbeError(reason);
    const length = buffer[offset++];
    if (!length || offset + length + 2 > buffer.length) throw new ProbeError(reason);
    const bytes = buffer.subarray(offset, offset + length);
    if (bytes.some(byte => byte > 127)) throw new ProbeError(reason);
    try {
      const normalized = normalizeAddress({ host: bytes.toString("ascii"), port: 1 }, "invalid-target");
      host = normalized.host;
      family = normalized.family;
    } catch (error) {
      throw new ProbeError(error instanceof ProbeError ? reason : "io-error");
    }
    offset += length;
  } else {
    throw new ProbeError(reason);
  }
  return { address: { host, family, port: buffer.readUInt16BE(offset) }, end: offset + 2 };
}

async function socksCommand(stream: ProxyStream, command: 1 | 3, target: Address, deadline: Deadline): Promise<Address> {
  await stream.write(Buffer.concat([Buffer.from([5, command, 0]), encodeAddress(target)]), deadline);
  deadline.check();
  const head = await stream.exact(4, deadline);
  deadline.check();
  if (head[0] !== 5 || head[2] !== 0) throw new ProbeError("socks-response-invalid");
  if (head[1] !== 0) throw new ProbeError(command === 3 ? "socks-udp-rejected" : "socks-connect-rejected");
  let tail: Buffer;
  if (head[3] === 1 || head[3] === 4) {
    tail = await stream.exact(head[3] === 1 ? 6 : 18, deadline);
    deadline.check();
  } else if (head[3] === 3) {
    const length = await stream.exact(1, deadline);
    deadline.check();
    if (!length[0]) throw new ProbeError("socks-response-invalid");
    const rest = await stream.exact(length[0] + 2, deadline);
    deadline.check();
    tail = Buffer.concat([length, rest]);
  } else {
    throw new ProbeError("socks-response-invalid");
  }
  stream.assertAlive();
  return decodeAddress(Buffer.concat([head.subarray(3), tail]), 0, "socks-response-invalid").address;
}

function failed(reason: ProxyTransportProbeFailureReason, bytes: PayloadMeasurement = { bytesSent: 0, bytesReceived: 0 }): ProxyTransportProbeFailure {
  return { status: "failed", reason, bytesSent: bytes.bytesSent, bytesReceived: bytes.bytesReceived, rttMs: null };
}

function failureReason(error: unknown, deadline: Deadline): ProxyTransportProbeFailureReason {
  return deadline.currentFailure()?.reason ?? (error instanceof ProbeError ? error.reason : "io-error");
}

async function probeTcp(proxy: NormalizedProxy, input: ProxyTransportProbeTarget, deadline: Deadline): Promise<ProxyTcpTransportProbeResult> {
  let stream: ProxyStream | undefined;
  const bytes: PayloadMeasurement = { bytesSent: 0, bytesReceived: 0 };
  let receivedBeforeChallenge: number | undefined;
  try {
    deadline.check();
    const target = normalizeAddress(input, "invalid-target");
    stream = new ProxyStream(proxy.type === "http" ? MAX_HTTP_HEADER_BYTES + CHALLENGE_BYTES : 1024);
    await stream.connect(proxy, deadline);
    deadline.check();
    if (proxy.type === "http") {
      await httpConnect(stream, proxy, target, deadline);
      deadline.check();
    } else {
      await socksAuthenticate(stream, proxy, deadline);
      deadline.check();
      await socksCommand(stream, 1, target, deadline);
      deadline.check();
      if (stream.bufferedBytes) throw new ProbeError("socks-response-invalid");
    }
    const challenge = randomBytes(CHALLENGE_BYTES);
    receivedBeforeChallenge = stream.bytesReceived;
    const startedAt = performance.now();
    await stream.write(challenge, deadline);
    deadline.check();
    bytes.bytesSent = challenge.length;
    const echo = await stream.exact(challenge.length, deadline);
    deadline.check();
    bytes.bytesReceived = Math.min(CHALLENGE_BYTES, stream.bytesReceived - receivedBeforeChallenge);
    if (!timingSafeEqual(challenge, echo) || stream.bufferedBytes) throw new ProbeError("tcp-echo-mismatch");
    deadline.check();
    return { status: "verified", reason: "echo-verified", ...bytes, rttMs: performance.now() - startedAt };
  } catch (error) {
    if (stream && receivedBeforeChallenge !== undefined) {
      bytes.bytesReceived = Math.min(CHALLENGE_BYTES, stream.bytesReceived - receivedBeforeChallenge);
    }
    return failed(failureReason(error, deadline), bytes);
  } finally {
    stream?.close();
  }
}

interface Datagram {
  data: Buffer;
  source: RemoteInfo;
}

class RelayDatagram {
  readonly socket: DatagramSocket;
  private state: "new" | "binding" | "open" | "closed" = "new";
  private readonly failed: Promise<ProbeError>;
  private failSignal!: (error: ProbeError) => void;
  private failure: ProbeError | undefined;
  private readonly message: Promise<Datagram>;
  private receive!: (packet: Datagram) => void;
  private received = false;

  constructor(family: 4 | 6) {
    this.socket = createSocket(family === 4 ? "udp4" : "udp6");
    this.failed = new Promise(resolve => { this.failSignal = resolve; });
    this.message = new Promise(resolve => { this.receive = resolve; });
    this.socket.on("error", () => this.fail("io-error"));
    this.socket.on("close", () => { this.state = "closed"; this.fail("connection-closed"); });
    this.socket.on("message", (data, source) => {
      if (this.failure) return;
      if (data.length > MAX_UDP_BYTES || this.received) return this.fail("response-too-large");
      this.received = true;
      this.receive({ data, source });
    });
  }

  private fail(reason: ProxyTransportProbeFailureReason): void {
    if (!this.failure) {
      this.failure = new ProbeError(reason);
      this.failSignal(this.failure);
    }
  }

  private async guard<T>(operation: Promise<T>, control: ProxyStream, deadline: Deadline): Promise<T> {
    const value = await control.guard(Promise.race([
      operation,
      this.failed.then(error => { throw error; }),
    ]), deadline);
    deadline.check();
    control.assertAlive();
    if (this.failure) throw this.failure;
    return value;
  }

  async bind(host: string, control: ProxyStream, deadline: Deadline): Promise<number> {
    deadline.check();
    this.state = "binding";
    await this.guard(new Promise<void>(resolve => {
      this.socket.bind({ address: host, port: 0, exclusive: true }, () => { this.state = "open"; resolve(); });
    }), control, deadline);
    deadline.check();
    return this.socket.address().port;
  }

  async connect(relay: Address, control: ProxyStream, deadline: Deadline): Promise<{ address: string; port: number }> {
    deadline.check();
    await this.guard(new Promise<void>(resolve => { this.socket.connect(relay.port, relay.host, resolve); }), control, deadline);
    deadline.check();
    const remote = this.socket.remoteAddress();
    if (!isIP(remote.address) || unusableIp(ipBytes(remote.address))) throw new ProbeError("socks-relay-invalid");
    return { address: remote.address, port: remote.port };
  }

  async send(data: Buffer, control: ProxyStream, deadline: Deadline): Promise<void> {
    deadline.check();
    control.assertAlive();
    await this.guard(new Promise<void>((resolve, reject) => {
      this.socket.send(data, error => error ? reject(new ProbeError("io-error")) : resolve());
    }), control, deadline);
    deadline.check();
  }

  async response(control: ProxyStream, deadline: Deadline): Promise<Datagram> {
    const packet = await this.guard(this.message, control, deadline);
    deadline.check();
    return packet;
  }

  close(): void {
    if (this.state === "closed") return;
    try {
      // Also release an unbound handle. Closing while binding queues closure in
      // node:dgram, rather than leaking a late bind.
      this.socket.close();
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SOCKET_DGRAM_NOT_RUNNING") {
        this.state = "closed";
        this.fail("connection-closed");
      } else {
        throw new ProbeError("cleanup-failed");
      }
    }
  }
}

function sameTarget(a: Address, b: Address): boolean {
  if (a.port !== b.port) return false;
  if (a.family && b.family) return sameIp(a.host, b.host);
  return a.family === b.family && a.host === b.host;
}

function stunRequest(): { packet: Buffer; txid: Buffer } {
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(0x0001, 0);
  packet.writeUInt32BE(STUN_COOKIE, 4);
  const txid = randomBytes(12);
  txid.copy(packet, 8);
  return { packet, txid };
}

function validateStun(packet: Buffer, txid: Buffer): void {
  if (packet.length < 20 || packet.length > MAX_UDP_BYTES || packet.readUInt32BE(4) !== STUN_COOKIE
      || packet.readUInt16BE(2) % 4 !== 0 || packet.readUInt16BE(2) + 20 !== packet.length) {
    throw new ProbeError("stun-response-invalid");
  }
  if (!timingSafeEqual(packet.subarray(8, 20), txid)) throw new ProbeError("stun-transaction-mismatch");
  const type = packet.readUInt16BE(0);
  if (type === 0x0111) throw new ProbeError("stun-binding-rejected");
  if (type !== 0x0101) throw new ProbeError("stun-response-invalid");
  let mapped: { address: Buffer; port: number } | undefined;
  const seen = new Set<number>();
  for (let offset = 20; offset < packet.length;) {
    if (offset + 4 > packet.length) throw new ProbeError("stun-response-invalid");
    const attribute = packet.readUInt16BE(offset);
    const length = packet.readUInt16BE(offset + 2);
    const end = offset + 4 + length;
    const paddedEnd = offset + 4 + Math.ceil(length / 4) * 4;
    if (end > packet.length || paddedEnd > packet.length) throw new ProbeError("stun-response-invalid");
    if (attribute === 0x0020 || attribute === 0x0001) {
      if (seen.has(attribute)) throw new ProbeError("stun-mapped-address-invalid");
      seen.add(attribute);
      const value = packet.subarray(offset + 4, end);
      if (value.length < 4 || value[0] !== 0 || (value[1] !== 1 && value[1] !== 2)
          || value.length !== (value[1] === 1 ? 8 : 20)) throw new ProbeError("stun-mapped-address-invalid");
      const xor = attribute === 0x0020;
      const port = value.readUInt16BE(2) ^ (xor ? STUN_COOKIE >>> 16 : 0);
      const address = Buffer.from(value.subarray(4));
      if (xor) {
        const mask = Buffer.concat([packet.subarray(4, 8), txid]);
        for (let index = 0; index < address.length; index++) address[index] ^= mask[index];
      }
      const comparable = comparableIp(address);
      if (!port || unusableIp(address) || mapped && (port !== mapped.port || !comparable.equals(mapped.address))) {
        throw new ProbeError("stun-mapped-address-invalid");
      }
      mapped = { address: comparable, port };
    }
    offset = paddedEnd;
  }
  if (!mapped) throw new ProbeError("stun-mapped-address-invalid");
}

async function probeUdp(proxy: NormalizedProxy, input: ProxyTransportProbeTarget, deadline: Deadline): Promise<ProxyUdpTransportProbeResult> {
  let control: ProxyStream | undefined;
  let udp: RelayDatagram | undefined;
  const bytes: PayloadMeasurement = { bytesSent: 0, bytesReceived: 0 };
  try {
    deadline.check();
    const target = normalizeAddress(input, "invalid-target");
    control = new ProxyStream(1024, true);
    await control.connect(proxy, deadline);
    deadline.check();
    await socksAuthenticate(control, proxy, deadline);
    deadline.check();
    const localHost = control.socket.localAddress;
    const peer = control.socket.remoteAddress;
    const family = peer && isIP(peer);
    if (!localHost || !peer || (family !== 4 && family !== 6)) throw new ProbeError("socks-relay-invalid");
    udp = new RelayDatagram(family);
    const localPort = await udp.bind(localHost, control, deadline);
    deadline.check();
    const relay = await socksCommand(control, 3, { host: localHost, family, port: localPort }, deadline);
    deadline.check();
    control.requireQuiet();
    if (!relay.port) throw new ProbeError("socks-relay-invalid");
    // RFC 1928 servers commonly return a wildcard BND.ADDR. Only the connected
    // proxy peer may replace it; never substitute the target or a direct route.
    if (relay.family && ipBytes(relay.host).every(byte => byte === 0)) {
      relay.host = peer;
      relay.family = family;
    }
    if (relay.family && unusableIp(ipBytes(relay.host)) || sameTarget(relay, target)) throw new ProbeError("socks-relay-invalid");
    const relayPeer = await udp.connect(relay, control, deadline);
    deadline.check();
    control.assertAlive();
    if (target.family && relayPeer.port === target.port && sameIp(relayPeer.address, target.host)) {
      throw new ProbeError("socks-relay-invalid");
    }
    const request = stunRequest();
    const frame = Buffer.concat([Buffer.from([0, 0, 0]), encodeAddress(target), request.packet]);
    const startedAt = performance.now();
    await udp.send(frame, control, deadline);
    deadline.check();
    bytes.bytesSent = request.packet.length;
    const response = await udp.response(control, deadline);
    deadline.check();
    control.assertAlive();
    if (response.source.port !== relayPeer.port || !sameIp(response.source.address, relayPeer.address)) {
      throw new ProbeError("udp-relay-source-mismatch");
    }
    if (response.data.length < 4 || response.data[0] !== 0 || response.data[1] !== 0) throw new ProbeError("udp-frame-invalid");
    if (response.data[2] !== 0) throw new ProbeError("udp-fragmented");
    const source = decodeAddress(response.data, 3, "udp-frame-invalid");
    // No target DNS lookup (also for socks5h). A domain target needs the same
    // framed domain; an unverifiable domain -> numeric source is failed closed.
    if (!sameTarget(source.address, target)) throw new ProbeError("udp-target-mismatch");
    const payload = response.data.subarray(source.end);
    bytes.bytesReceived = payload.length;
    validateStun(payload, request.txid);
    deadline.check();
    control.assertAlive();
    return { status: "verified", reason: "stun-binding-verified", ...bytes, rttMs: performance.now() - startedAt };
  } catch (error) {
    return failed(failureReason(error, deadline), bytes);
  } finally {
    // Destroy the control even if datagram cleanup reports an unexpected failure.
    try {
      udp?.close();
    } finally {
      control?.close();
    }
  }
}

/**
 * Main-internal capability evidence for explicitly owned echo/STUN services.
 * No config/secrets/Electron access, persistence, logging, direct-target sockets,
 * retries, proxy fallbacks, browser claims, or inference from ASSOCIATE alone.
 * Both SOCKS variants send target hostnames to the proxy, avoiding target DNS leaks.
 */
export async function probeProxyTransport(config: ProxyConfig, options: ProxyTransportProbeOptions): Promise<ProxyTransportProbeResult> {
  const startedAt = performance.now();
  const webrtc: ProxyWebRtcTransportProbeResult = {
    status: "not-tested", reason: "browser-not-probed", bytesSent: 0, bytesReceived: 0, rttMs: null,
  };
  const unmeasuredUdp: ProxyUdpTransportProbeResult | undefined = !options?.udpTarget
    ? { status: "not-tested", reason: "udp-target-not-provided", bytesSent: 0, bytesReceived: 0, rttMs: null }
    : config?.type === "http"
      ? { status: "unsupported", reason: "http-udp-unsupported", bytesSent: 0, bytesReceived: 0, rttMs: null }
      : undefined;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!options || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    return { tcp: failed("invalid-options"), udp: unmeasuredUdp ?? failed("invalid-options"), webrtc };
  }
  const deadline = new Deadline(timeoutMs, startedAt, options.signal);
  try {
    deadline.check();
    const proxy = normalizeProxy(config);
    // Even an unexpected cleanup rejection must not abandon its sibling or
    // dispose the shared deadline while the sibling still owns a socket.
    const [tcpOutcome, udpOutcome] = await Promise.allSettled([
      probeTcp(proxy, options.tcpTarget, deadline),
      unmeasuredUdp ?? probeUdp(proxy, options.udpTarget!, deadline),
    ]);
    const stopped = deadline.currentFailure();
    const tcp = tcpOutcome.status === "fulfilled" ? tcpOutcome.value : failed(failureReason(tcpOutcome.reason, deadline));
    const udp = udpOutcome.status === "fulfilled" ? udpOutcome.value : failed(failureReason(udpOutcome.reason, deadline));
    // A final gate also covers cancellation/deadline between a branch resolving
    // and allSettled resuming. Never return a late verified observation.
    return {
      tcp: stopped && tcp.status === "verified" ? failed(stopped.reason, tcp) : tcp,
      udp: stopped && udp.status === "verified" ? failed(stopped.reason, udp) : udp,
      webrtc,
    };
  } catch (error) {
    const reason = failureReason(error, deadline);
    return { tcp: failed(reason), udp: unmeasuredUdp ?? failed(reason), webrtc };
  } finally {
    deadline.dispose();
  }
}
