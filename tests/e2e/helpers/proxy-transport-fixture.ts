// Owned IPv4 loopback only; no DNS, disk, browser launch, or product mocks.
// Transport bytes/hashes are NOT evidence of selected ICE or RTC message delivery.
// Replies return only to an observed loopback requester / pinned SOCKS control peer.
// HTTP is bounded Content-Length HTTP/1.x, not chunked, Upgrade, or a TLS origin.
// TURN requires an owned proxy upstream by default; direct baselines must opt out.
import * as net from "node:net";
import * as dgram from "node:dgram";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const HOST = "127.0.0.1", COOKIE = 0x2112a442, MAX_DATA = 60 * 1024;
const LANES = ["origin", "tcp-echo", "udp-echo", "http-forward", "http-connect", "socks-connect", "socks-udp", "stun", "turn-control", "turn-peer"] as const;
const COUNTERS = ["httpForward", "httpConnect", "socksNoAuth", "socksPasswordAuth", "socksConnect", "socksUdpAssociate", "socksUdpRevoked", "stunBinding", "turnChallenge", "turnAuth", "turnAllocate", "turnRefresh", "turnPermission", "turnChannelBind", "turnSend", "turnData", "turnChannelSend", "turnChannelData"] as const;
const REASONS = ["address", "port", "protocol", "auth", "source", "fragment", "disabled", "limit", "expired", "io"] as const;
type Lane = typeof LANES[number];
type Reason = typeof REASONS[number];
export type ProxyTcpEndpoint = "origin" | "tcp-echo" | "http" | "socks" | "turn";
export type ProxyFixtureEndpoint = ProxyTcpEndpoint | "udp-echo" | "stun";
export interface ProxyTransportEvidence {
  lane: Lane; direction: "received" | "sent"; peerPort: number;
  bytes: number; sha256: string; nonceMatched: boolean;
}
export interface ProxyTurnBinding {
  allocationId: number; routeId: number; via: "http" | "socks";
  // Byte observations while this allocation exists, never SDP or peer identities.
  controlBytes: { received: number; sent: number };
  peerBytes: { received: number; sent: number };
}
export interface ProxyTransportStats {
  counts: Record<typeof COUNTERS[number], number>;
  traffic: Record<Lane, { receivedBytes: number; sentBytes: number; received: number; sent: number }>;
  denied: Record<Reason, number>;
  turn: {
    requireProxyForTurn: boolean; directDenied: number; proxyBoundAllocations: number;
    proxyBoundBytes: { received: number; sent: number }; proxyBoundPeerBytes: { received: number; sent: number };
    proxyRoutes: { http: number; socks: number; active: number };
    proxyBindings: ProxyTurnBinding[]; bindingsDropped: number;
  };
  active: { tcp: number; udpSockets: number; tcpListeners: number; udpAssociations: number; turnAllocations: number };
  evidence: ProxyTransportEvidence[]; evidenceDropped: number; ioErrors: number; errorCodes: string[];
}
export interface ProxyTransportFixture {
  host: string; nonce: string; origin: string; originPort: number; httpPort: number; socksPort: number;
  socksCredentials?: { username: string; password: string };
  echo: { tcpPort: number; udpPort: number };
  stun: { host: string; port: number; url: string };
  turn: { host: string; port: number; urls: string; username: string; credential: string };
  stats(): ProxyTransportStats;
  /** Reject new requests/datagrams; use disconnect to break existing tunnels. */
  setRejected(endpoint: ProxyFixtureEndpoint, rejected: boolean): void;
  /** Close current TCP controls/tunnels, including their UDP associations/allocations. */
  disconnect(endpoint: ProxyTcpEndpoint): void;
  close(): Promise<void>;
}
class Fault extends Error {
  constructor(readonly reason: Reason | "closed") { super(reason); }
}
const zeros = <T extends string>(keys: readonly T[]): Record<T, number> => Object.fromEntries(keys.map(k => [k, 0])) as Record<T, number>;
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
async function take(s: net.Socket, n: number): Promise<Buffer> {
  if (!n) return Buffer.alloc(0);
  for (;;) {
    if (s.destroyed || s.readableEnded) throw new Fault("closed");
    const b = s.read(n) as Buffer | null;
    if (b) { if (b.length !== n) throw new Fault("protocol"); return b; }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { clean(); resolve(); };
      const ended = () => { clean(); reject(new Fault("closed")); };
      const failed = (e: Error) => { clean(); reject(e); };
      const clean = () => { s.off("readable", ready); s.off("end", ended); s.off("close", ended); s.off("error", failed); };
      s.once("readable", ready); s.once("end", ended); s.once("close", ended); s.once("error", failed);
    });
  }
}
async function httpHead(s: net.Socket) {
  const bytes: number[] = [];
  while (bytes.length < 16 * 1024) {
    bytes.push((await take(s, 1))[0]);
    const n = bytes.length;
    if (n >= 4 && bytes[n - 4] === 13 && bytes[n - 3] === 10 && bytes[n - 2] === 13 && bytes[n - 1] === 10) break;
  }
  const raw = Buffer.from(bytes), lines = raw.toString("latin1").split("\r\n");
  if (!raw.subarray(-4).equals(Buffer.from("\r\n\r\n"))) throw new Fault("limit");
  const match = /^([A-Z]+) ([\x21-\x7e]+) HTTP\/1\.[01]$/.exec(lines.shift() || "");
  if (!match) throw new Fault("protocol");
  const headers = Object.create(null) as Record<string, string>;
  for (const line of lines.filter(Boolean)) {
    const h = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([\t\x20-\x7e]*)$/.exec(line);
    if (!h || headers[h[1].toLowerCase()] !== undefined) throw new Fault("protocol");
    headers[h[1].toLowerCase()] = h[2].trim();
  }
  if (headers["transfer-encoding"] !== undefined || headers.expect !== undefined || (headers["content-length"] !== undefined && !/^\d{1,6}$/.test(headers["content-length"]))) throw new Fault("protocol");
  const length = Number(headers["content-length"] || 0);
  if (length > MAX_DATA) throw new Fault("limit");
  return { method: match[1], target: match[2], headers, length, raw };
}
function httpReply(s: net.Socket, status: number, body: Buffer = Buffer.alloc(0), type = "text/plain", headOnly = false, written?: () => void): void {
  s.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${status} Owned fixture\r\nContent-Length: ${body.length}\r\nContent-Type: ${type}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`), headOnly ? Buffer.alloc(0) : body]), written);
}
function socksAddress(b: Buffer, at = 0): { host: string; port: number; size: number } | undefined {
  const type = b[at];
  if (type === 1 && b.length >= at + 7) return { host: [...b.subarray(at + 1, at + 5)].join("."), port: b.readUInt16BE(at + 5), size: 7 };
  if (type === 3 && b[at + 1] > 0 && b.length >= at + 4 + b[at + 1]) {
    const n = b[at + 1];
    // Exact bytes, not lossy ASCII decoding (which could alias high-bit names).
    if (!b.subarray(at + 2, at + 2 + n).equals(Buffer.from(HOST))) return;
    return { host: HOST, port: b.readUInt16BE(at + 2 + n), size: n + 4 };
  }
}
async function readSocksAddress(s: net.Socket) {
  const type = await take(s, 1);
  if (type[0] === 1) return socksAddress(Buffer.concat([type, await take(s, 6)]));
  if (type[0] === 3) {
    const n = await take(s, 1);
    return socksAddress(Buffer.concat([type, n, await take(s, n[0] + 2)]));
  }
  if (type[0] === 4) await take(s, 18); // Consume only the fixed IPv6 address/port; never connect it.
  return undefined;
}
function socksBound(port: number): Buffer {
  const b = Buffer.from([1, 127, 0, 0, 1, 0, 0]); b.writeUInt16BE(port, 5); return b;
}
const socksReply = (code: number, port = 0): Buffer => Buffer.concat([Buffer.from([5, code, 0]), socksBound(port)]);
type Attribute = { type: number; value: Buffer; at: number };
function attribute(type: number, value: Buffer): Buffer {
  const b = Buffer.alloc(4 + ((value.length + 3) & ~3));
  b.writeUInt16BE(type); b.writeUInt16BE(value.length, 2); value.copy(b, 4); return b;
}
function crc32(b: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of b) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function stunPacket(type: number, tx: Buffer, attrs: Buffer[], key?: Buffer): Buffer {
  const h = Buffer.alloc(20); h.writeUInt16BE(type); h.writeUInt32BE(COOKIE, 4); tx.copy(h, 8);
  let body = Buffer.concat(attrs);
  if (key) {
    h.writeUInt16BE(body.length + 24, 2);
    body = Buffer.concat([body, attribute(8, createHmac("sha1", key).update(h).update(body).digest())]);
  }
  h.writeUInt16BE(body.length + 8, 2);
  const prefix = Buffer.concat([h, body]);
  return Buffer.concat([prefix, attribute(0x8028, u32(crc32(prefix) ^ 0x5354554e))]);
}
function parseStun(b: Buffer): { type: number; tx: Buffer; attrs: Attribute[] } {
  if (b.length < 20 || (b[0] & 0xc0) || b.readUInt32BE(4) !== COOKIE || b.readUInt16BE(2) + 20 !== b.length || b.length % 4) throw new Fault("protocol");
  const attrs: Attribute[] = []; let integrity = false, fingerprint = false;
  for (let at = 20; at < b.length;) {
    if (at + 4 > b.length) throw new Fault("protocol");
    const type = b.readUInt16BE(at), n = b.readUInt16BE(at + 2), end = at + 4 + ((n + 3) & ~3);
    if (end > b.length || fingerprint || (integrity && type !== 0x8028)) throw new Fault("protocol");
    if (type === 8) { if (n !== 20) throw new Fault("protocol"); integrity = true; }
    if (type === 0x8028) {
      if (n !== 4 || end !== b.length || b.readUInt32BE(at + 4) !== ((crc32(b.subarray(0, at)) ^ 0x5354554e) >>> 0)) throw new Fault("protocol");
      fingerprint = true;
    }
    attrs.push({ type, value: b.subarray(at + 4, at + 4 + n), at }); at = end;
  }
  return { type: b.readUInt16BE(0), tx: b.subarray(8, 20), attrs };
}
function xorAddress(port: number): Buffer {
  const b = Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]);
  b.writeUInt16BE(port ^ (COOKIE >>> 16), 2); b.writeUInt32BE((0x7f000001 ^ COOKIE) >>> 0, 4); return b;
}
function xorPeer(b: Buffer): number | undefined {
  if (b.length !== 8 || b[0] !== 0 || b[1] !== 1 || ((b.readUInt32BE(4) ^ COOKIE) >>> 0) !== 0x7f000001) return;
  const port = b.readUInt16BE(2) ^ (COOKIE >>> 16); return port || undefined;
}

export async function startProxyTransportFixture(options: { socksAuth?: boolean; requireProxyForTurn?: boolean } = {}): Promise<ProxyTransportFixture> {
  const nonce = randomBytes(18).toString("hex"), nonceBytes = Buffer.from(nonce);
  const socksCredentials = options.socksAuth ? { username: `owned-${randomBytes(6).toString("hex")}`, password: randomBytes(18).toString("hex") } : undefined;
  const realm = "owned-loopback", authNonce = randomBytes(24).toString("hex");
  const username = `turn-${randomBytes(6).toString("hex")}`, credential = randomBytes(24).toString("hex");
  const key = createHash("md5").update(`${username}:${realm}:${credential}`).digest();
  const counts = zeros(COUNTERS), denied = zeros(REASONS);
  const traffic = Object.fromEntries(LANES.map(k => [k, { receivedBytes: 0, sentBytes: 0, received: 0, sent: 0 }])) as ProxyTransportStats["traffic"];
  const evidence: ProxyTransportEvidence[] = [], errorCodes: string[] = [];
  const tcp = new Map<net.Socket, ProxyTcpEndpoint | "upstream">(), servers: net.Server[] = [];
  const datagrams = new Set<dgram.Socket>(), associations = new Set<dgram.Socket>();
  const jobs = new Set<Promise<void>>(), udpCloses = new Set<Promise<void>>();
  const blocked = new Set<ProxyFixtureEndpoint>(), allowedTcp = new Set<number>();
  type ProxyRoute = { id: number; via: "http" | "socks"; localPort: number; client: net.Socket; upstream: net.Socket };
  type Allocation = { udp: dgram.Socket; port: number; expires: number; control: net.Socket; route?: ProxyRoute; binding?: ProxyTurnBinding; permissions: Map<number, number>; channels: Map<number, { port: number; expires: number }> };
  const allocations = new Map<number, Allocation>(), proxyRoutes = new Map<number, ProxyRoute>();
  const bindingsByControl = new Map<net.Socket, ProxyTurnBinding>();
  const turnStats: ProxyTransportStats["turn"] = {
    requireProxyForTurn: options.requireProxyForTurn !== false, directDenied: 0, proxyBoundAllocations: 0,
    proxyBoundBytes: { received: 0, sent: 0 }, proxyBoundPeerBytes: { received: 0, sent: 0 },
    proxyRoutes: { http: 0, socks: 0, active: 0 }, proxyBindings: [], bindingsDropped: 0,
  };
  let routeSequence = 0;
  let closing = false, closePromise: Promise<void> | undefined, byteBudget = 0, evidenceDropped = 0, ioErrors = 0;
  let cleanupFailed = false, pendingRelays = 0, pendingAssociations = 0;
  let originPort = 0, tcpEchoPort = 0, udpEchoPort = 0, stunPort = 0, turnPort = 0;
  const reject = (why: Reason): void => { denied[why]++; };
  const io = (e: unknown): void => {
    ioErrors++; const code = String((e as NodeJS.ErrnoException)?.code || "SOCKET_ERROR");
    if (errorCodes.length < 16) errorCodes.push(/^[A-Z0-9_]{1,64}$/.test(code) ? code : "SOCKET_ERROR");
  };
  function note(lane: Lane, direction: "received" | "sent", peerPort: number, b: Buffer): boolean {
    byteBudget += b.length;
    if (byteBudget > 16 * 1024 * 1024) { reject("limit"); return false; }
    traffic[lane][direction]++; traffic[lane][direction === "received" ? "receivedBytes" : "sentBytes"] += b.length;
    if (evidence.length < 512) evidence.push({ lane, direction, peerPort, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex"), nonceMatched: b.includes(nonceBytes) });
    else evidenceDropped++;
    return true;
  }
  function turnRoute(s: net.Socket): ProxyRoute | undefined {
    const route = proxyRoutes.get(s.remotePort || 0), upstream = route?.upstream;
    if (!route || !upstream || s.localPort !== turnPort || s.remoteAddress !== HOST || route.localPort !== s.remotePort ||
        upstream.destroyed || route.client.destroyed || tcp.get(route.client) !== route.via || tcp.get(upstream) !== "upstream" ||
        upstream.localPort !== s.remotePort || upstream.remotePort !== turnPort || upstream.localAddress !== HOST || upstream.remoteAddress !== HOST) return;
    return route;
  }
  function turnNote(s: net.Socket, direction: "received" | "sent", b: Buffer): boolean {
    if (!note("turn-control", direction, turnPort, b)) return false;
    const route = turnRoute(s), binding = bindingsByControl.get(s);
    if (route) {
      turnStats.proxyBoundBytes[direction] += b.length;
      if (binding?.routeId === route.id) binding.controlBytes[direction] += b.length;
    }
    return true;
  }
  function track(s: net.Socket, endpoint: ProxyTcpEndpoint | "upstream"): net.Socket {
    tcp.set(s, endpoint); s.on("error", io); s.once("close", () => tcp.delete(s));
    s.setTimeout(60_000, () => { reject("expired"); s.destroy(); });
    if (closing || tcp.size > 96) { reject("limit"); s.destroy(); }
    else if (s.remoteAddress && s.remoteAddress !== HOST) { reject("source"); s.destroy(); }
    return s;
  }
  async function listen(endpoint: ProxyTcpEndpoint, handler: (s: net.Socket) => Promise<void> | void): Promise<number> {
    const server = net.createServer(s => {
      track(s, endpoint); if (s.destroyed) return;
      const job = Promise.resolve().then(() => handler(s)).catch(e => {
        if (!closing && !(e instanceof Fault && e.reason === "closed")) {
          if (e instanceof Fault) reject(e.reason as Reason);
          else io(e);
        }
        s.destroy();
      });
      jobs.add(job); void job.then(() => jobs.delete(job));
    });
    servers.push(server); server.maxConnections = 64;
    await new Promise<void>((resolve, fail) => {
      server.once("error", fail); server.listen(0, HOST, () => { server.off("error", fail); resolve(); });
    });
    server.on("error", io); return (server.address() as net.AddressInfo).port;
  }
  async function udp(): Promise<dgram.Socket> {
    const u = dgram.createSocket("udp4"); u.on("error", io);
    try {
      await new Promise<void>((resolve, fail) => { u.once("error", fail); u.bind(0, HOST, () => { u.off("error", fail); resolve(); }); });
    } catch (e) {
      await new Promise<void>(resolve => {
        u.once("close", resolve);
        try { u.close(); } catch (closeError) {
          // A failed bind may already have no handle; anything else must fail cleanup.
          if ((closeError as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") { cleanupFailed = true; io(closeError); }
          u.off("close", resolve); resolve();
        }
      });
      throw e;
    }
    datagrams.add(u); return u;
  }
  function stopUdp(u: dgram.Socket): void {
    if (!datagrams.delete(u)) return;
    const done = new Promise<void>(resolve => {
      u.once("close", resolve);
      try { u.close(); } catch (e) { cleanupFailed = true; io(e); u.off("close", resolve); resolve(); }
    });    udpCloses.add(done); void done.then(() => udpCloses.delete(done));
  }
  function sendUdp(u: dgram.Socket, port: number, b: Buffer, lane: Lane, peerPort = port, binding?: ProxyTurnBinding): void {
    if (closing || !datagrams.has(u)) return;
    u.send(b, port, HOST, e => {
      if (e) io(e);
      else if (note(lane, "sent", peerPort, b) && binding) { binding.peerBytes.sent += b.length; turnStats.proxyBoundPeerBytes.sent += b.length; }
    });
  }
  const liveRelay = (port: number): boolean => (allocations.get(port)?.expires || 0) > Date.now();
  const allowedUdp = (port: number): boolean => port > 0 && (port === udpEchoPort || port === stunPort || liveRelay(port));
  const allowedPeer = (port: number): boolean => port > 0 && (port === udpEchoPort || liveRelay(port));
  async function connect(port: number, via: "http" | "socks", client: net.Socket): Promise<net.Socket> {
    if (closing || !allowedTcp.has(port)) throw new Fault("port");
    if (client.destroyed || tcp.get(client) !== via) throw new Fault("source");
    const s = track(net.createConnection({ host: HOST, port }), "upstream");
    await new Promise<void>((resolve, fail) => {
      const done = () => { clean(); resolve(); }, error = (e: Error) => { clean(); fail(e); }, closed = () => { clean(); fail(new Fault("closed")); };
      const clean = () => { s.off("connect", done); s.off("error", error); s.off("close", closed); };
      s.once("connect", done); s.once("error", error); s.once("close", closed);
      if (s.destroyed) closed();
    });
    if (closing || s.destroyed || client.destroyed) { s.destroy(); throw new Fault("closed"); }
    if (port === turnPort) {
      const localPort = s.localPort;
      if (!localPort || proxyRoutes.has(localPort)) { s.destroy(); throw new Fault("source"); }
      const route: ProxyRoute = { id: ++routeSequence, via, localPort, client, upstream: s };
      proxyRoutes.set(localPort, route); turnStats.proxyRoutes[via]++;
      const forget = () => {
        if (proxyRoutes.get(localPort) !== route) return;
        proxyRoutes.delete(localPort);
        for (const a of allocations.values()) if (a.route === route) removeAllocation(a);
      };
      s.once("end", forget); s.once("close", forget); client.once("end", forget); client.once("close", forget);
    }
    return s;
  }
  function bridge(s: net.Socket, upstream: net.Socket, lane: Lane, port: number): void {
    s.once("close", () => upstream.destroy());
    upstream.once("close", () => { if (!upstream.readableEnded) s.destroy(); });
    s.on("data", b => { if (!note(lane, "received", port, b)) s.destroy(); });
    upstream.on("data", b => { if (!note(lane, "sent", port, b)) s.destroy(); });
    upstream.pipe(s); s.pipe(upstream);
  }
  async function proxy(s: net.Socket): Promise<void> {
    const h = await httpHead(s);
    if (blocked.has("http")) { reject("disabled"); httpReply(s, 403); return; }
    const tunnel = h.method === "CONNECT";
    const match = (tunnel ? /^127\.0\.0\.1:([1-9]\d{0,4})$/ : /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(\/[^# ]*)?$/).exec(h.target);
    if (!match) { reject("address"); httpReply(s, 403); return; }
    const port = Number(match[1]);
    if (!(tunnel ? allowedTcp.has(port) && !h.length : port === originPort) || h.headers.host !== `${HOST}:${port}`) { reject("port"); httpReply(s, 403); return; }
    let upstream: net.Socket;
    try { upstream = await connect(port, "http", s); } catch { reject("io"); httpReply(s, 502); return; }
    if (s.destroyed || closing) { upstream.destroy(); return; }
    if (tunnel) { counts.httpConnect++; s.write("HTTP/1.1 200 Connection Established\r\n\r\n"); }
    else {
      counts.httpForward++;
      const omit = new Set(["host", "connection", "proxy-connection", "proxy-authorization", "keep-alive", "upgrade", "te", "trailer"]);
      const headers = Object.entries(h.headers).filter(([k]) => !omit.has(k)).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      upstream.write(`${h.method} ${match[2] || "/"} HTTP/1.1\r\nHost: ${HOST}:${port}\r\n${headers}Connection: close\r\n\r\n`);
      if (!note("http-forward", "received", port, h.raw)) { upstream.destroy(); s.destroy(); return; }
    }
    bridge(s, upstream, tunnel ? "http-connect" : "http-forward", port);
  }
  async function socks(s: net.Socket): Promise<void> {
    const greeting = await take(s, 2), methods = await take(s, greeting[1]);
    if (greeting[0] !== 5 || !methods.length) throw new Fault("protocol");
    const method = socksCredentials ? 2 : 0;
    if (blocked.has("socks") || !methods.includes(method)) { reject(blocked.has("socks") ? "disabled" : "auth"); s.end(Buffer.from([5, 255])); return; }
    s.write(Buffer.from([5, method]));
    if (socksCredentials) {
      const a = await take(s, 2), user = await take(s, a[1]), n = await take(s, 1), password = await take(s, n[0]);
      if (a[0] !== 1 || !user.equals(Buffer.from(socksCredentials.username)) || !password.equals(Buffer.from(socksCredentials.password))) { reject("auth"); s.end(Buffer.from([1, 1])); return; }
      counts.socksPasswordAuth++; s.write(Buffer.from([1, 0]));
    } else counts.socksNoAuth++;
    const req = await take(s, 3), target = await readSocksAddress(s);
    if (req[0] !== 5 || req[2] !== 0) throw new Fault("protocol");
    if (!target || target.host !== HOST && !(req[1] === 3 && target.host === "0.0.0.0")) { reject("address"); s.end(socksReply(8)); return; }
    if (req[1] === 1) {
      if (!allowedTcp.has(target.port)) { reject("port"); s.end(socksReply(2)); return; }
      let upstream: net.Socket;
      try { upstream = await connect(target.port, "socks", s); } catch { reject("io"); s.end(socksReply(5)); return; }
      if (s.destroyed || closing) { upstream.destroy(); return; }
      counts.socksConnect++; s.write(socksReply(0, upstream.localPort || 0)); bridge(s, upstream, "socks-connect", target.port); return;
    }
    if (req[1] !== 3) { reject("protocol"); s.end(socksReply(7)); return; }
    if (associations.size + pendingAssociations >= 16 || allowedUdp(target.port)) { reject("limit"); s.end(socksReply(2)); return; }
    let u: dgram.Socket; pendingAssociations++;
    try { u = await udp(); } finally { pendingAssociations--; }
    if (s.destroyed || s.readableEnded || closing) { stopUdp(u); return; }
    associations.add(u); counts.socksUdpAssociate++;
    let clientPort = target.port, revoked = false;
    const peers = new Map<number, number>();
    const revoke = () => { if (revoked) return; revoked = true; associations.delete(u); peers.clear(); counts.socksUdpRevoked++; stopUdp(u); };
    s.once("end", revoke); s.once("close", revoke);
    s.on("data", () => { reject("protocol"); revoke(); s.destroy(); }); s.resume();
    u.on("message", (b, remote) => {
      if (s.destroyed || s.readableEnded) { revoke(); return; }
      if (revoked || blocked.has("socks")) { reject("disabled"); return; }
      if (remote.address !== HOST || !remote.port || b.length > MAX_DATA) { reject("source"); return; }
      if ((peers.get(remote.port) || 0) > Date.now() && allowedUdp(remote.port)) {
        if (!clientPort || !note("socks-udp", "received", remote.port, b)) return;
        sendUdp(u, clientPort, Buffer.concat([Buffer.alloc(3), socksBound(remote.port), b]), "socks-udp", remote.port); return;
      }
      if (allowedUdp(remote.port) || clientPort && remote.port !== clientPort) { reject("source"); return; }
      if (b.length < 4 || b[0] || b[1]) { reject("protocol"); return; }
      if (b[2]) { reject("fragment"); return; }
      const dest = socksAddress(b, 3);
      if (!dest || dest.host !== HOST) { reject("address"); return; }
      if (!allowedUdp(dest.port)) { reject("port"); return; }
      for (const [port, expiry] of peers) if (expiry <= Date.now() || !allowedUdp(port)) peers.delete(port);
      if (peers.size >= 32 && !peers.has(dest.port)) { reject("limit"); return; }
      const payload = b.subarray(3 + dest.size);
      if (!note("socks-udp", "received", dest.port, payload)) return;
      clientPort ||= remote.port; peers.set(dest.port, Date.now() + 30_000);
      sendUdp(u, dest.port, payload, "socks-udp");
    });
    s.write(socksReply(0, u.address().port));
  }
  function removeAllocation(a: Allocation): void {
    if (allocations.get(a.port) !== a) return; // A recycled port must not revoke a newer allocation.
    allocations.delete(a.port); a.permissions.clear(); a.channels.clear(); stopUdp(a.udp);
    if (a.binding && bindingsByControl.get(a.control) === a.binding) bindingsByControl.delete(a.control);
    for (const other of allocations.values()) {
      other.permissions.delete(a.port);
      for (const [id, channel] of other.channels) if (channel.port === a.port) other.channels.delete(id);
    }
  }
  function turnWrite(s: net.Socket, b: Buffer): void {
    if (s.destroyed || closing) return;
    if (s.writableLength > 1024 * 1024) { reject("limit"); s.destroy(); return; }
    s.write(b, e => { if (e) io(e); else if (!turnNote(s, "sent", b)) s.destroy(); });
  }
  async function turn(s: net.Socket): Promise<void> {
    let allocation: Allocation | undefined;
    const release = () => { if (allocation) removeAllocation(allocation); allocation = undefined; };
    s.once("end", release); s.once("close", release);
    for (;;) {
      const first = await take(s, 4), type = first.readUInt16BE(0), n = first.readUInt16BE(2);
      if (blocked.has("turn")) { reject("disabled"); s.destroy(); return; }
      if (allocation && (allocations.get(allocation.port) !== allocation || allocation.expires <= Date.now() || allocation.route && turnRoute(s) !== allocation.route)) release();
      if ((type & 0xc000) === 0x4000) {
        if (n > MAX_DATA) throw new Fault("limit");
        const padded = await take(s, (n + 3) & ~3), a = allocation, channel = a?.channels.get(type);
        if (!a || !channel || channel.expires <= Date.now() || (a.permissions.get(channel.port) || 0) <= Date.now() || !allowedPeer(channel.port)) { reject("port"); continue; }
        const data = padded.subarray(0, n);
        if (!turnNote(s, "received", Buffer.concat([first, padded]))) continue;
        counts.turnChannelSend++; sendUdp(a.udp, channel.port, data, "turn-peer", channel.port, a.binding); continue;
      }
      if (type & 0xc000 || n % 4 || n > MAX_DATA + 256) throw new Fault("protocol");
      const b = Buffer.concat([first, await take(s, 16 + n)]), request = parseStun(b);
      if (!turnNote(s, "received", b)) throw new Fault("limit");
      const all = (t: number) => request.attrs.filter(a => a.type === t);
      const one = (t: number) => { const values = all(t); if (values.length > 1) throw new Fault("protocol"); return values[0]?.value; };
      const respond = (attrs: Buffer[], signed = true) => turnWrite(s, stunPacket(type | 0x100, request.tx, attrs, signed ? key : undefined));
      const error = (code: number, signed = false, extra: Buffer[] = []) => {
        const value = Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), Buffer.from(`Owned ${code}`)]);
        const attrs = [attribute(9, value), ...extra];
        if (code === 401 || code === 438) { counts.turnChallenge++; attrs.push(attribute(0x14, Buffer.from(realm)), attribute(0x15, Buffer.from(authNonce))); }
        turnWrite(s, stunPacket(type | 0x110, request.tx, attrs, signed ? key : undefined));
      };
      // Check on Allocate DATA, not the server connection event: upstream connect may fire later.
      if (type === 3 && turnStats.requireProxyForTurn && !turnRoute(s)) {
        turnStats.directDenied++; reject("source"); error(403); s.end(() => s.destroy()); return;
      }
      if (type === 1) { counts.stunBinding++; respond([attribute(0x20, xorAddress(s.remotePort || 0))], false); continue; }
      if (type === 0x16) {
        const peer = one(0x12), data = one(0x13), port = peer && xorPeer(peer), a = allocation;
        if (!a || !port || !data || data.length > MAX_DATA || !allowedPeer(port) || (a.permissions.get(port) || 0) <= Date.now()) { reject("port"); continue; }
        counts.turnSend++; sendUdp(a.udp, port, data, "turn-peer", port, a.binding); continue;
      }
      if (![3, 4, 8, 9].includes(type)) { reject("protocol"); if (!(type & 0x110)) error(400); continue; }
      const mi = request.attrs.find(a => a.type === 8), user = one(6), r = one(0x14), challenge = one(0x15);
      if (!mi || !user?.equals(Buffer.from(username)) || !r?.equals(Buffer.from(realm))) { reject("auth"); error(401); continue; }
      if (!challenge?.equals(Buffer.from(authNonce))) { reject("auth"); error(438); continue; }
      const prefix = Buffer.from(b.subarray(0, mi.at)); prefix.writeUInt16BE(mi.at + 4, 2);
      if (!timingSafeEqual(mi.value, createHmac("sha1", key).update(prefix).digest())) { reject("auth"); error(401); continue; }
      counts.turnAuth++;
      const known = [6, 8, 0x0c, 0x0d, 0x12, 0x13, 0x14, 0x15, 0x17, 0x19];
      const unknown = [...new Set(request.attrs.filter(a => a.type < 0x8000 && !known.includes(a.type)).map(a => a.type))];
      if (unknown.length) {
        const list = Buffer.alloc(unknown.length * 2); unknown.forEach((t, i) => list.writeUInt16BE(t, i * 2));
        reject("protocol"); error(420, true, [attribute(0x0a, list)]); continue;
      }
      if (type === 3) {
        const route = turnRoute(s);
        const transport = one(0x19), family = one(0x17), requestedLifetime = one(0x0d);
        if (!transport || transport.length !== 4 || transport.subarray(1).some(v => v !== 0)) { error(400, true); continue; }
        if (transport[0] !== 17) { error(442, true); continue; }
        if (family && (family.length !== 4 || family.subarray(1).some(v => v !== 0))) { error(400, true); continue; }
        if (family && family[0] !== 1) { error(440, true); continue; }
        if (requestedLifetime && (requestedLifetime.length !== 4 || !requestedLifetime.readUInt32BE(0))) { error(400, true); continue; }
        const lifetime = requestedLifetime ? Math.min(requestedLifetime.readUInt32BE(0), 600) : 600;
        if (allocation) { error(437, true); continue; }
        if (allocations.size + pendingRelays >= 16) { reject("limit"); error(486, true); continue; }
        let relay: dgram.Socket; pendingRelays++;
        try { relay = await udp(); } finally { pendingRelays--; }
        if (closing || s.destroyed || s.readableEnded || route && turnRoute(s) !== route || turnStats.requireProxyForTurn && !route) { stopUdp(relay); s.destroy(); return; }
        const a: Allocation = { udp: relay, port: relay.address().port, expires: Date.now() + lifetime * 1000, control: s, route, permissions: new Map(), channels: new Map() };
        allocation = a; allocations.set(a.port, a); counts.turnAllocate++;
        if (route) {
          const binding: ProxyTurnBinding = { allocationId: counts.turnAllocate, routeId: route.id, via: route.via, controlBytes: { received: b.length, sent: 0 }, peerBytes: { received: 0, sent: 0 } };
          a.binding = binding; bindingsByControl.set(s, binding); turnStats.proxyBoundAllocations++;
          if (turnStats.proxyBindings.length < 64) turnStats.proxyBindings.push(binding); else turnStats.bindingsDropped++;
        }
        relay.on("message", (data, remote) => {
          if (s.destroyed || allocations.get(a.port) !== a || a.route && turnRoute(s) !== a.route || a.expires <= Date.now() || blocked.has("turn") || remote.address !== HOST || !allowedPeer(remote.port) || (a.permissions.get(remote.port) || 0) <= Date.now()) { reject("source"); return; }
          if (data.length > MAX_DATA || !note("turn-peer", "received", remote.port, data)) return;
          if (a.binding) { a.binding.peerBytes.received += data.length; turnStats.proxyBoundPeerBytes.received += data.length; }
          const bound = [...a.channels].find(([, c]) => c.port === remote.port && c.expires > Date.now());
          if (bound) {
            const frame = Buffer.alloc(4 + ((data.length + 3) & ~3)); frame.writeUInt16BE(bound[0]); frame.writeUInt16BE(data.length, 2); data.copy(frame, 4);
            counts.turnChannelData++; turnWrite(s, frame);
          } else { counts.turnData++; turnWrite(s, stunPacket(0x17, randomBytes(12), [attribute(0x12, xorAddress(remote.port)), attribute(0x13, data)])); }
        });
        respond([attribute(0x16, xorAddress(a.port)), attribute(0x20, xorAddress(s.remotePort || 0)), attribute(0x0d, u32(lifetime))]); continue;
      }
      const a = allocation;
      if (!a || allocations.get(a.port) !== a) { release(); error(437, true); continue; }
      if (type === 4) {
        const value = one(0x0d);
        if (value && value.length !== 4) { error(400, true); continue; }
        const lifetime = value ? Math.min(value.readUInt32BE(0), 600) : 600;
        counts.turnRefresh++; if (!lifetime) release(); else a.expires = Date.now() + lifetime * 1000;
        respond([attribute(0x0d, u32(lifetime))]); continue;
      }
      const peers = all(0x12).map(p => xorPeer(p.value));
      if (!peers.length || peers.length > 16 || peers.some(p => !p || p === a.port || !allowedPeer(p))) { reject("port"); error(403, true); continue; }
      for (const [port, expiry] of a.permissions) if (expiry <= Date.now() || !allowedPeer(port)) a.permissions.delete(port);
      if (new Set([...a.permissions.keys(), ...peers]).size > 32) { reject("limit"); error(508, true); continue; }
      if (type === 9) {
        const value = one(0x0c);
        if (!value || value.length !== 4 || value.readUInt16BE(2) || peers.length !== 1) { error(400, true); continue; }
        const number = value.readUInt16BE(0), port = peers[0]!;
        for (const [id, channel] of a.channels) if (channel.expires <= Date.now()) a.channels.delete(id);
        if (number < 0x4000 || number > 0x7fff || a.channels.size >= 32 && !a.channels.has(number) || [...a.channels].some(([id, c]) => id === number ? c.port !== port : c.port === port)) { error(400, true); continue; }
        a.channels.set(number, { port, expires: Date.now() + 600_000 }); counts.turnChannelBind++;
      } else counts.turnPermission++;
      for (const port of peers) a.permissions.set(port!, Date.now() + 300_000);
      respond([]);
    }
  }
  const sweep = setInterval(() => { for (const a of allocations.values()) if (a.expires <= Date.now()) removeAllocation(a); }, 1000);
  sweep.unref();
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true; clearInterval(sweep); allowedTcp.clear();
    closePromise = (async () => {
      const listeners = Promise.allSettled(servers.filter(s => s.listening).map(s => new Promise<void>((resolve, fail) => s.close(e => e ? fail(e) : resolve()))));
      const connections = [...tcp.keys()].map(s => new Promise<void>(resolve => { s.once("close", () => resolve()); s.destroy(); }));
      await Promise.all([...jobs, ...connections]);
      for (const a of allocations.values()) removeAllocation(a);
      for (const u of datagrams) stopUdp(u);
      await Promise.all([...udpCloses]);
      if ((await listeners).some(r => r.status === "rejected") || cleanupFailed) throw new Error("Owned transport fixture cleanup failed");
    })();
    return closePromise;
  }
  try {
    originPort = await listen("origin", async s => {
      const h = await httpHead(s);
      if (blocked.has("origin")) { reject("disabled"); httpReply(s, 503); return; }
      if (h.headers.host !== `${HOST}:${originPort}` || !/^\/[^#]*$/.test(h.target) || h.target.startsWith("//")) { reject("address"); httpReply(s, 403); return; }
      const body = await take(s, h.length);
      if (!note("origin", "received", originPort, h.raw) || !note("origin", "received", originPort, body)) { s.destroy(); return; }
      const route = h.target.split("?")[0];
      const reply = route === "/echo" ? body : route === "/nonce" ? nonceBytes : Buffer.from(`<!doctype html><meta charset="utf-8"><title>Owned proxy transport</title><p id="fixture-nonce">${nonce}</p>`);
      const status = ["/", "/echo", "/nonce"].includes(route) ? 200 : 404;
      const output = status === 200 ? reply : Buffer.alloc(0);
      httpReply(s, status, output, route === "/" ? "text/html; charset=utf-8" : "application/octet-stream", h.method === "HEAD",
        () => { note("origin", "sent", originPort, h.method === "HEAD" ? Buffer.alloc(0) : output); });
    });
    allowedTcp.add(originPort);
    tcpEchoPort = await listen("tcp-echo", s => {
      if (blocked.has("tcp-echo")) { reject("disabled"); s.destroy(); return; }
      s.on("data", b => {
        if (blocked.has("tcp-echo") || !note("tcp-echo", "received", tcpEchoPort, b)) { s.destroy(); return; }
        if (!s.write(b, e => { if (e) io(e); else if (!note("tcp-echo", "sent", tcpEchoPort, b)) s.destroy(); })) s.pause();
      });
      s.on("drain", () => s.resume()); s.on("end", () => s.end()); s.resume();
    });
    allowedTcp.add(tcpEchoPort);
    const echo = await udp(); udpEchoPort = echo.address().port;
    echo.on("message", (b, remote) => {
      if (blocked.has("udp-echo")) { reject("disabled"); return; }
      if (remote.address !== HOST || b.length > MAX_DATA) { reject("source"); return; }
      if (note("udp-echo", "received", udpEchoPort, b)) sendUdp(echo, remote.port, b, "udp-echo", udpEchoPort);
    });
    const stun = await udp(); stunPort = stun.address().port;
    stun.on("message", (b, remote) => {
      if (blocked.has("stun")) { reject("disabled"); return; }
      if (remote.address !== HOST || b.length > MAX_DATA) { reject("source"); return; }
      try {
        const req = parseStun(b);
        if (req.type !== 1) throw new Fault("protocol");
        if (!note("stun", "received", stunPort, b)) return;
        counts.stunBinding++; sendUdp(stun, remote.port, stunPacket(0x101, req.tx, [attribute(0x20, xorAddress(remote.port))]), "stun", stunPort);
      } catch (e) { reject(e instanceof Fault ? e.reason as Reason : "protocol"); }
    });
    turnPort = await listen("turn", turn); allowedTcp.add(turnPort);
    const httpPort = await listen("http", proxy), socksPort = await listen("socks", socks);
    return {
      host: HOST, nonce, origin: `http://${HOST}:${originPort}`, originPort, httpPort, socksPort, socksCredentials,
      echo: { tcpPort: tcpEchoPort, udpPort: udpEchoPort }, stun: { host: HOST, port: stunPort, url: `stun:${HOST}:${stunPort}` },
      turn: { host: HOST, port: turnPort, urls: `turn:${HOST}:${turnPort}?transport=tcp`, username, credential },
      setRejected(endpoint, rejected) { if (rejected) blocked.add(endpoint); else blocked.delete(endpoint); },
      disconnect(endpoint) { for (const [s, owner] of tcp) if (owner === endpoint) s.destroy(); },
      stats() {
        return { counts: { ...counts }, denied: { ...denied }, traffic: Object.fromEntries(LANES.map(k => [k, { ...traffic[k] }])) as ProxyTransportStats["traffic"],
          turn: { ...turnStats, proxyBoundBytes: { ...turnStats.proxyBoundBytes }, proxyBoundPeerBytes: { ...turnStats.proxyBoundPeerBytes },
            proxyRoutes: { ...turnStats.proxyRoutes, active: proxyRoutes.size }, proxyBindings: turnStats.proxyBindings.map(b => ({ ...b, controlBytes: { ...b.controlBytes }, peerBytes: { ...b.peerBytes } })) },
          active: { tcp: tcp.size, udpSockets: datagrams.size, tcpListeners: servers.filter(s => s.listening).length, udpAssociations: associations.size, turnAllocations: allocations.size }, evidence: evidence.map(e => ({ ...e })), evidenceDropped, ioErrors, errorCodes: [...errorCodes] };
      }, close,
    };
  } catch (e) { await close(); throw e; }
}
