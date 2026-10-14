/// <reference lib="dom" />

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext } from "playwright";
import type { BrowserPlatform } from "../main/types.js";
import { buildRemoteDnsRule, normalizeManagedSecureDnsUrl, resolveChromiumDnsPolicy } from "../main/services/browser-dns-policy.js";
import {
  AGENT_BROWSER_FINGERPRINT_SWITCH,
  MANAGED_SECURE_DNS_TEMPLATES,
  buildBrowserFingerprintArg,
} from "../main/services/browser-fingerprint-config.js";

const LOOPBACK = "127.0.0.1"; // An owned, loopback-only CONNECT observer, not a default upstream.
const MAX_NETLOG_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_RECORDS = 200;

export interface Options {
  browser: string;
  mode: "http" | "socks5";
  upstreamHost: string;
  upstreamPort: number;
  target: string;
  dnsRoute: "proxy" | "doh";
  templates: readonly string[];
  platform: BrowserPlatform;
  workDir: string;
  report?: string;
  samples: number;
  keepNetLog: boolean;
  testCertSpki?: string;
}

export interface ConnectRecord {
  target: string;
  ok: boolean;
  bytesSent: number;
  bytesReceived: number;
}

export interface EvidenceContext {
  mode: Options["mode"];
  proxyHost: string;
  proxyPort: number;
  target: string;
  templates: readonly string[];
  forwards?: readonly ConnectRecord[];
  observerOverflow?: boolean;
}

export interface NetLogEvidence {
  status: "valid" | "missing" | "invalid";
  reason?: string;
  eventCount: number;
  resolverJobs: number;
  dnsTransactions: number;
  dohTransactions: number;
  dohUrlRequests: number;
  insecureDnsAttempts: number;
  failedTransactions: number;
  unfinishedTransactions: number;
  successfulDohViaProxy: number;
  originRequestsViaProxy: number;
  directTcpAttempts: number;
  udpOrQuicEvents: number;
  reachabilityProbes: number;
  systemResolverTasks: number;
  failedProxyConnects: number;
  issues: string[];
}

export interface Verdict {
  outcome: "pass" | "fail" | "inconclusive";
  verdict: string;
}

export interface SampleResult extends Verdict {
  index: number;
  pageState: "loaded" | "error" | "timeout";
  httpStatus: number | null;
  sessionIssue?: string;
  netLog: NetLogEvidence;
}

export function selectPlatform(selector = "host", hostPlatform: string = process.platform): BrowserPlatform {
  if (selector === "windows" || selector === "macos" || selector === "android") return selector;
  if (selector !== "host") throw new Error("--platform must be host, windows, macos, or android");
  if (hostPlatform === "darwin") return "macos";
  if (hostPlatform === "win32") return "windows";
  throw new Error(`No production fingerprint platform for ${hostPlatform}; select --platform explicitly`);
}

export function parseExecutableVersion(output: string): string {
  const versions = [...output.matchAll(/^(?:(?:Chromium|Google Chrome(?: for Testing)?|Chrome|HeadlessChrome)[ /])?(\d+\.\d+\.\d+\.\d+)(?:[ \t].*)?\r?$/gm)]
    .map((match) => match[1]);
  const unique = [...new Set(versions)];
  if (output.length > 8192 || unique.length !== 1 || !unique[0].split(".").every((part) => Number.isSafeInteger(Number(part))) || Number(unique[0].split(".")[0]) < 1) {
    throw new Error("Executable did not report one valid, unambiguous Chromium version; no guessed version is used");
  }
  return unique[0];
}

function parseEndpoint(value: string): { host: string; port: number } | null {
  const match = value.match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/);
  if (!match) return null;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: (match[1] || match[2]).toLowerCase(), port };
}

function authority(url: URL): string {
  return `${url.hostname}:${url.port || "443"}`;
}

export function validateDohTemplate(template: string): string {
  const normalized = normalizeManagedSecureDnsUrl(template);
  if (!normalized) throw new Error("Invalid --doh-template: a bounded HTTPS template without credentials, whitespace or fragments is required");
  return normalized;
}

export function validateTestCertSpki(value: string | undefined, upstreamHost: string, target: string): string | undefined {
  if (value === undefined) return undefined;
  const bytes = value.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, "base64") : null;
  if (!bytes || bytes.length !== 32 || bytes.toString("base64") !== value) {
    throw new Error("--test-cert-spki must be a canonical base64 SHA-256 SPKI hash (32 bytes)");
  }
  const loopback = (net.isIP(upstreamHost) === 4 && upstreamHost.startsWith("127.")) ||
    (net.isIP(upstreamHost) === 6 && new URL(`http://[${upstreamHost}]/`).hostname === "[::1]");
  const url = new URL(target);
  if (!loopback || url.protocol !== "https:" || url.username || url.password || !url.hostname.endsWith(".owned.test")) {
    throw new Error("--test-cert-spki is restricted to a literal-loopback upstream and an HTTPS .owned.test target");
  }
  return value;
}

export function parseOptions(argv: string[], hostPlatform: string = process.platform): Options {
  const values = new Map<string, string>();
  let keepNetLog = false;
  for (const arg of argv) {
    if (arg === "--keep-net-log") { keepNetLog = true; continue; }
    const match = arg.match(/^--(browser|mode|upstream|target|platform|work-dir|report|samples|dns-route|doh-template|test-cert-spki)=(.+)$/);
    if (!match || values.has(match[1])) throw new Error("Unknown, empty, or duplicate verifier option");
    values.set(match[1], match[2]);
  }
  const browser = values.get("browser");
  const workDir = values.get("work-dir");
  const upstream = parseEndpoint(values.get("upstream") || "");
  if (!browser || !workDir || !upstream) {
    throw new Error("usage: verify-managed-doh --browser=/path/to/Chromium[.app] --work-dir=/owned/scratch --upstream=IP:port [--mode=http|socks5] [--dns-route=proxy|doh] [--doh-template=https://resolver/dns-query{?dns}] [--target=https://host/] [--platform=host|windows|macos|android] [--samples=1..3] [--report=/owned/report.json] [--keep-net-log] [--test-cert-spki=base64SHA256 (loopback/.owned.test only)]");
  }
  // A literal upstream makes attribution possible without a separate, unobserved proxy-host DNS lookup.
  if (!net.isIP(upstream.host)) throw new Error("--upstream must use a literal IP address (IPv6 in brackets); proxy-host DNS is outside this verifier's coverage");
  const mode = values.get("mode") || "http";
  if (mode !== "http" && mode !== "socks5") throw new Error("--mode must be http or socks5");
  const requestedRoute = values.get("dns-route") || (values.has("doh-template") ? "doh" : "proxy");
  if (requestedRoute !== "proxy" && requestedRoute !== "doh") throw new Error("--dns-route must be proxy or doh");
  if (requestedRoute === "proxy" && values.has("doh-template")) throw new Error("--doh-template cannot be used with --dns-route=proxy");
  // Reuse production policy without reading live settings/userData. Google is only an explicit diagnostic choice.
  const policy = resolveChromiumDnsPolicy({ type: mode, host: upstream.host, port: upstream.port },
    requestedRoute === "doh" ? validateDohTemplate(values.get("doh-template") || MANAGED_SECURE_DNS_TEMPLATES[0]) : undefined);
  if (policy.route === "stock") throw new Error("A configured upstream proxy is required");
  const dnsRoute = policy.route;
  const templates = policy.secureDns?.templates || [];
  const target = new URL(values.get("target") || "https://www.google.com/");
  if (target.protocol !== "https:" || target.username || target.password || net.isIP(target.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("--target must be an HTTPS hostname URL without credentials, not an IP literal");
  }
  const samples = Number(values.get("samples") || "1");
  if (!Number.isInteger(samples) || samples < 1 || samples > 3) throw new Error("--samples must be an integer from 1 to 3");
  return {
    browser: path.resolve(browser), mode, upstreamHost: upstream.host, upstreamPort: upstream.port,
    target: target.href, dnsRoute, templates, platform: selectPlatform(values.get("platform"), hostPlatform),
    workDir: path.resolve(workDir), report: values.has("report") ? path.resolve(values.get("report")!) : undefined,
    samples, keepNetLog, testCertSpki: validateTestCertSpki(values.get("test-cert-spki"), upstream.host, target.href),
  };
}

function resolveExecutable(input: string): string {
  if (fs.statSync(input).isFile()) return input;
  if (process.platform === "darwin" && input.endsWith(".app")) {
    for (const name of [path.basename(input, ".app"), "Chromium", "Google Chrome", "Google Chrome for Testing"]) {
      const candidate = path.join(input, "Contents", "MacOS", name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  throw new Error("Browser executable not found");
}

interface LoggingProxy {
  port: number;
  records: ConnectRecord[];
  overflow: boolean;
  close: () => Promise<void>;
}

function startLoggingProxy(upstreamHost: string, upstreamPort: number): Promise<LoggingProxy> {
  const records: ConnectRecord[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_request, response) => { response.writeHead(502); response.end(); });
  const proxy: LoggingProxy = {
    port: 0, records, overflow: false,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, clientSocket, head) => {
    const target = request.url || "";
    if (!parseEndpoint(target) || records.length >= MAX_PROXY_RECORDS) {
      proxy.overflow = records.length >= MAX_PROXY_RECORDS;
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const record: ConnectRecord = { target, ok: false, bytesSent: 0, bytesReceived: 0 };
    records.push(record);
    const upstream = net.createConnection({ host: upstreamHost, port: upstreamPort });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    let settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } else clientSocket.destroy();
      upstream.destroy();
    };
    upstream.setTimeout(20_000, fail);
    upstream.on("error", fail);
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("connect", () => upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let responseBuffer = Buffer.alloc(0);
    const readHeaders = (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) { if (responseBuffer.length > 16_384) fail(); return; }
      upstream.removeListener("data", readHeaders);
      if (headerEnd > 16_384 || settled || !/^HTTP\/1\.[01] 200\b/.test(responseBuffer.toString("latin1", 0, headerEnd).split("\r\n")[0])) {
        fail(); return;
      }
      settled = true;
      record.ok = true;
      upstream.setTimeout(0);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = responseBuffer.subarray(headerEnd + 4);
      record.bytesSent += head.length;
      record.bytesReceived += rest.length;
      if (head.length) upstream.write(head);
      if (rest.length) clientSocket.write(rest);
      responseBuffer = Buffer.alloc(0);
      upstream.on("data", (data: Buffer) => { record.bytesReceived += data.length; });
      clientSocket.on("data", (data: Buffer) => { record.bytesSent += data.length; });
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    };
    upstream.on("data", readHeaders);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      proxy.port = (server.address() as net.AddressInfo).port;
      resolve(proxy);
    });
  });
}

interface LogEvent {
  name: string;
  source: string;
  sourceType: string;
  ordinal: number;
  phase: number;
  params: Record<string, unknown>;
  dependency?: string;
}

interface Transaction {
  source: string;
  begin: LogEvent;
  end?: LogEvent;
}

function dictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceKey(value: unknown): string | undefined {
  if (!dictionary(value) || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.type) || Number(value.id) < -0x80000000 || Number(value.id) > 0xffffffff || Number(value.type) < 0) return undefined;
  // Chromium serializes uint32 source IDs through a signed JSON integer (e.g. CERT_VERIFY_PROC_CREATED).
  // Canonicalize both signed and unsigned forms without accepting out-of-range or fractional IDs.
  return `${value.type}:${Number(value.id) >>> 0}`;
}

function emptyEvidence(status: NetLogEvidence["status"], reason?: string): NetLogEvidence {
  return {
    status, reason, eventCount: 0, resolverJobs: 0, dnsTransactions: 0, dohTransactions: 0, dohUrlRequests: 0, insecureDnsAttempts: 0,
    failedTransactions: 0, unfinishedTransactions: 0, successfulDohViaProxy: 0, originRequestsViaProxy: 0,
    directTcpAttempts: 0, udpOrQuicEvents: 0, reachabilityProbes: 0, systemResolverTasks: 0, failedProxyConnects: 0, issues: [],
  };
}

function hostname(value: unknown): string {
  if (typeof value !== "string") return "";
  if (/^https?:\/\//.test(value)) {
    try { return new URL(value).hostname.toLowerCase().replace(/\.$/, ""); }
    catch { return ""; } // Malformed/redacted names cannot establish correlation.
  }
  return value.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Pure, conservative NetLog interpretation. Counters alone never establish a successful DNS route. */
export function parseNetLog(text: string, context: EvidenceContext): NetLogEvidence {
  if (Buffer.byteLength(text, "utf8") > MAX_NETLOG_BYTES) return emptyEvidence("invalid", "log-size-limit");
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return emptyEvidence("invalid", "unparseable-log"); }
  if (!dictionary(raw) || !dictionary(raw.constants) || !dictionary(raw.constants.logEventTypes) || !dictionary(raw.constants.logSourceType) || !dictionary(raw.constants.logEventPhase) || !Array.isArray(raw.events) || raw.events.length === 0) {
    return emptyEvidence("invalid", "missing-log-schema-or-events");
  }
  const phases = raw.constants.logEventPhase;
  const begin = phases.PHASE_BEGIN;
  const end = phases.PHASE_END;
  const none = phases.PHASE_NONE;
  if (![begin, end, none].every(Number.isSafeInteger) || new Set([begin, end, none]).size !== 3) return emptyEvidence("invalid", "invalid-phases");
  const names = new Map<number, string>();
  for (const [name, id] of Object.entries(raw.constants.logEventTypes)) {
    if (!Number.isSafeInteger(id) || names.has(Number(id))) return emptyEvidence("invalid", "invalid-event-types");
    names.set(Number(id), name);
  }
  const sourceTypes = new Map<number, string>();
  for (const [name, id] of Object.entries(raw.constants.logSourceType)) {
    if (!Number.isSafeInteger(id) || sourceTypes.has(Number(id))) return emptyEvidence("invalid", "invalid-source-types");
    sourceTypes.set(Number(id), name);
  }
  const events: LogEvent[] = [];
  const links = new Map<string, Set<string>>();
  for (const item of raw.events) {
    if (!dictionary(item)) return emptyEvidence("invalid", "invalid-event");
    const name = typeof item.type === "number" ? names.get(item.type) : undefined;
    const source = sourceKey(item.source);
    const sourceType = dictionary(item.source) ? sourceTypes.get(Number(item.source.type)) : undefined;
    if (!name || !source || !sourceType || ![begin, end, none].includes(item.phase) || (item.params !== undefined && !dictionary(item.params))) {
      return emptyEvidence("invalid", "invalid-event");
    }
    const params = (item.params || {}) as Record<string, unknown>;
    const dependency = sourceKey(params.source_dependency);
    if (params.source_dependency !== undefined && (!dependency || !dictionary(params.source_dependency) || !sourceTypes.has(Number(params.source_dependency.type)))) return emptyEvidence("invalid", "invalid-source-dependency");
    events.push({ name, source, sourceType, ordinal: events.length, phase: Number(item.phase), params, dependency });
    if (dependency) {
      if (!links.has(source)) links.set(source, new Set());
      if (!links.has(dependency)) links.set(dependency, new Set());
      links.get(source)!.add(dependency);
      links.get(dependency)!.add(source);
    }
  }
  const result = emptyEvidence("valid");
  result.eventCount = events.length;
  if (events.some((event) => event.name.startsWith("DNS_OVER_HTTPS"))) result.issues.push("unsupported-doh-event-schema");
  const transactions = (wanted: string[]): Transaction[] => {
    const pending = new Map<string, Transaction>();
    const found: Transaction[] = [];
    for (const event of events.filter((event) => wanted.includes(event.name))) {
      const key = `${event.source}/${event.name}`;
      if (event.phase === begin) {
        if (pending.has(key)) result.issues.push("overlapping-transaction");
        const transaction = { source: event.source, begin: event };
        found.push(transaction);
        pending.set(key, transaction);
      } else if (event.phase === end) {
        const transaction = pending.get(key);
        if (!transaction) result.issues.push("unmatched-transaction-end");
        else { transaction.end = event; pending.delete(key); }
      }
    }
    return found;
  };
  // Chromium 152 EndEventWithNetErrorCode omits net_error for success. A missing END is NOT success.
  const successful = (transaction: Transaction) => transaction.end !== undefined &&
    (transaction.end.params.net_error === undefined || transaction.end.params.net_error === 0) && transaction.end.params.os_error === undefined;
  const dns = transactions(["DNS_TRANSACTION"]);
  const doh = transactions(["DOH_URL_REQUEST"]);
  const queries = transactions(["DNS_TRANSACTION_QUERY"]);
  const requests = transactions(["URL_REQUEST_START_JOB"]);
  const tcp = transactions(["TCP_CONNECT", "TCP_CONNECT_ATTEMPT"]);
  const socks = transactions(["SOCKS5_CONNECT"]);
  const socksHandshake = transactions(["SOCKS5_HANDSHAKE_WRITE", "SOCKS5_HANDSHAKE_READ"]);
  const resolvers = transactions(["HOST_RESOLVER_MANAGER_JOB", "HOST_RESOLVER_IMPL_JOB"]);
  result.dnsTransactions = dns.length;
  result.dohTransactions = doh.length;
  const dnsWork = [...dns, ...doh, ...queries, ...resolvers];
  result.failedTransactions = dnsWork.filter((transaction) => transaction.end && typeof transaction.end.params.net_error === "number" && transaction.end.params.net_error !== 0).length;
  result.unfinishedTransactions = dnsWork.filter((transaction) => !transaction.end ||
    (transaction.end.params.net_error !== undefined && typeof transaction.end.params.net_error !== "number")).length;
  if (dns.some((transaction) => transaction.begin.sourceType !== "DNS_TRANSACTION") || doh.some((transaction) => transaction.begin.sourceType !== "DNS_OVER_HTTPS")) result.issues.push("dns-source-type-mismatch");
  const target = new URL(context.target);
  const targetHost = hostname(target.hostname);
  const requestSources = new Set(requests.map((request) => request.source));
  const dnsSources = new Set([...dns, ...doh].map((transaction) => transaction.source));
  const reachable = (root: string, blocked: Set<string>): Set<string> => {
    const reached = new Set([root]);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      if (queue.length > 512) { result.issues.push("source-chain-size-limit"); break; }
      for (const next of links.get(queue[i]) || []) {
        if (!blocked.has(next) && !reached.has(next)) { reached.add(next); queue.push(next); }
      }
    }
    return reached;
  };
  const expectedEndpoint = (address: unknown) => {
    const endpoint = typeof address === "string" ? parseEndpoint(address) : null;
    return endpoint?.host === context.proxyHost.toLowerCase().replace(/^\[|\]$/g, "") && endpoint.port === context.proxyPort;
  };
  const addresses = (transaction: Transaction): unknown[] => transaction.begin.name === "TCP_CONNECT"
    ? (Array.isArray(transaction.begin.params.address_list) ? transaction.begin.params.address_list : [])
    : (transaction.begin.params.address === undefined ? [] : [transaction.begin.params.address]);
  for (const connection of tcp) {
    const endpoints = addresses(connection);
    if (!endpoints.length || endpoints.some((address) => typeof address !== "string" || !parseEndpoint(address))) result.issues.push("tcp-address-unavailable");
    result.directTcpAttempts += endpoints.filter((address) => typeof address === "string" && parseEndpoint(address) && !expectedEndpoint(address)).length;
  }
  const routeProven = (request: Transaction, destination: string): boolean => {
    if (!successful(request)) return false;
    const blocked = new Set([...requestSources, ...dnsSources]);
    blocked.delete(request.source);
    const chain = reachable(request.source, blocked);
    const proxyTcp = tcp.some((connection) => chain.has(connection.source) && successful(connection) && addresses(connection).length > 0 && addresses(connection).every(expectedEndpoint));
    if (!proxyTcp) return false;
    if (context.mode === "http") {
      return (context.forwards || []).some((record) => record.target.toLowerCase() === destination.toLowerCase() && record.ok && record.bytesSent > 0 && record.bytesReceived > 0);
    }
    // Default capture does not log SOCKS handshake bytes/hostname. Require the complete CONNECT and
    // both handshake phases on the SAME proxy-connected socket, correlated to this hostname request.
    return socks.some((connection) => chain.has(connection.source) && successful(connection) &&
      tcp.some((transport) => transport.source === connection.source && successful(transport) && addresses(transport).length > 0 && addresses(transport).every(expectedEndpoint)) &&
      ["SOCKS5_HANDSHAKE_WRITE", "SOCKS5_HANDSHAKE_READ"].every((name) => socksHandshake.some((handshake) =>
        handshake.source === connection.source && handshake.begin.name === name && successful(handshake))));
  };
  const requestUrl = (request: Transaction): URL | null => {
    try { return typeof request.begin.params.url === "string" ? new URL(request.begin.params.url) : null; }
    catch { return null; } // Redaction or unsupported schemas yield no positive evidence.
  };
  const templates = context.templates.map((template) => new URL(template.split("{")[0]));
  const isDohUrl = (url: URL | null) => url !== null && templates.some((template) => url.origin === template.origin && url.pathname === template.pathname);
  result.dohUrlRequests = requests.filter((request) => isDohUrl(requestUrl(request))).length;
  const provenDns = new Set<string>();
  for (const attempt of doh.filter(successful)) {
    // DOH_URL_REQUEST END precedes DNS response parsing in DnsHTTPAttempt::CompleteResponse.
    // Therefore URL/HTTP success is insufficient: require the matching parsed DNS response and
    // successful parent DNS_TRANSACTION, linked by DNS_TRANSACTION_HTTPS_ATTEMPT.
    const parent = dns.find((transaction) => successful(transaction) &&
      hostname(transaction.begin.params.hostname) === targetHost && hostname(attempt.begin.params.hostname) === targetHost &&
      Number.isInteger(transaction.begin.params.query_type) && transaction.begin.params.query_type === attempt.begin.params.query_type &&
      transaction.begin.ordinal < attempt.begin.ordinal && transaction.end!.ordinal > attempt.end!.ordinal &&
      events.some((event) => event.name === "DNS_TRANSACTION_HTTPS_ATTEMPT" &&
        ((event.source === transaction.source && event.dependency === attempt.source) || (event.source === attempt.source && event.dependency === transaction.source))) &&
      events.some((event) => event.name === "DNS_TRANSACTION_RESPONSE" && event.source === transaction.source && event.dependency === attempt.source &&
        event.params.rcode === 0 && Number.isInteger(event.params.answer_count) && Number(event.params.answer_count) >= 0 &&
        event.ordinal > attempt.end!.ordinal && event.ordinal < transaction.end!.ordinal));
    if (!parent) continue;
    // Chromium passes the DoH NetLog source into URLRequest::CreateRequest; these are the SAME source.
    if (requests.some((request) => {
      const url = requestUrl(request);
      return request.source === attempt.source && request.begin.ordinal > attempt.begin.ordinal &&
        request.end !== undefined && request.end.ordinal < attempt.end!.ordinal && isDohUrl(url) && url && routeProven(request, authority(url));
    })) { result.successfulDohViaProxy++; provenDns.add(parent.source); }
  }
  if (doh.length > 0 && dns.some((transaction) => successful(transaction) && !provenDns.has(transaction.source))) result.issues.push("uncorrelated-dns-transaction");
  result.originRequestsViaProxy = requests.filter((request) => requestUrl(request)?.origin === target.origin && routeProven(request, authority(target))).length;
  result.resolverJobs = resolvers.filter((transaction) => hostname(transaction.begin.params.host || transaction.begin.params.hostname) !== hostname(context.proxyHost)).length;
  result.insecureDnsAttempts = events.filter((event) => ["DNS_TRANSACTION_ATTEMPT", "DNS_TRANSACTION_TCP_ATTEMPT", "DNS_TRANSACTION_PLATFORM_ATTEMPT"].includes(event.name)).length;
  result.systemResolverTasks = events.filter((event) => event.phase === begin && ["HOST_RESOLVER_SYSTEM_TASK", "HOST_RESOLVER_MANAGER_SYSTEM_TASK"].includes(event.name)).length;
  const isQuicTraffic = (event: LogEvent) => /^QUIC_SESSION(?:$|_(?!POOL(?:_|$)))/.test(event.name);
  const udpConnects = transactions(["UDP_CONNECT"]);
  const socketLifetime = (source: string) => {
    const starts = events.filter((event) => event.source === source && event.name === "SOCKET_ALIVE" && event.phase === begin);
    const ends = events.filter((event) => event.source === source && event.name === "SOCKET_ALIVE" && event.phase === end);
    return starts.length === 1 && ends.length === 1 && starts[0].ordinal < ends[0].ordinal ? { begin: starts[0], end: ends[0] } : undefined;
  };
  const probeEvents = new Set<number>();
  for (const connection of udpConnects) {
    const endpoint = typeof connection.begin.params.address === "string" ? parseEndpoint(connection.begin.params.address) : null;
    const failure = connection.end?.params.net_error;
    if (!connection.end || !Number.isInteger(failure) || Number(failure) >= 0 || !endpoint || net.isIP(endpoint.host) !== 6 || events.some(isQuicTraffic)) continue;
    const socket = socketLifetime(connection.source);
    const client = socket?.begin.dependency ? socketLifetime(socket.begin.dependency) : undefined;
    if (!socket || !client || socket.begin.sourceType !== "UDP_SOCKET" || client.begin.sourceType !== "UDP_CLIENT_SOCKET" || !client.begin.dependency) continue;
    if (socket.begin.ordinal >= connection.begin.ordinal || client.begin.ordinal >= connection.begin.ordinal || socket.end.ordinal <= connection.end.ordinal || client.end.ordinal <= connection.end.ordinal) continue;
    const creator = client.begin.dependency;
    const chain = new Set([connection.source, client.begin.source, creator]);
    // Only the native connect-only reachability path: both owned socket lifetimes close before
    // their creator's next event explicitly records a fresh failed IPv6 reachability check.
    const marker = events.find((event) => event.source === creator && event.ordinal > Math.max(socket.end.ordinal, client.end.ordinal));
    if (marker?.name !== "HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK" || marker.phase !== none || marker.params.cached !== false || marker.params.ipv6_available !== false) continue;
    if (udpConnects.some((other) => other !== connection && chain.has(other.source))) continue;
    if (events.some((event) => (chain.has(event.source) || (event.dependency !== undefined && chain.has(event.dependency))) &&
      (event.name.startsWith("DNS_TRANSACTION") || event.name === "DOH_URL_REQUEST" ||
        (event.name.startsWith("UDP_") && event.name !== "UDP_CONNECT") ||
        (["UDP_SOCKET", "UDP_CLIENT_SOCKET"].includes(event.sourceType) && /BYTE|SEND|RECV|RECEIVE|READ|WRITE/.test(event.name))))) continue;
    probeEvents.add(connection.begin.ordinal);
    probeEvents.add(connection.end.ordinal);
    result.reachabilityProbes++;
  }
  // Probe classification is not packet capture. Every other UDP event and real QUIC session
  // (including failed/unfinished/unknown connects) still blocks a TCP-only success claim.
  result.udpOrQuicEvents = events.filter((event) => (event.name.startsWith("UDP_") || isQuicTraffic(event)) && !probeEvents.has(event.ordinal)).length;
  result.failedProxyConnects = (context.forwards || []).filter((record) => !record.ok && [authority(target), ...templates.map(authority)].includes(record.target)).length;
  if (context.observerOverflow) result.issues.push("proxy-observer-overflow");
  result.issues = [...new Set(result.issues)];
  return result;
}

export function scanNetLog(file: string, context: EvidenceContext): NetLogEvidence {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_NETLOG_BYTES) return emptyEvidence("invalid", "unsafe-or-oversized-log");
    return parseNetLog(fs.readFileSync(file, "utf8"), context);
  } catch (error) {
    return emptyEvidence((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid", "log-unavailable");
  }
}

export function computeVerdict(evidence: NetLogEvidence, pageState: SampleResult["pageState"], sessionIssue?: string, dnsRoute: Options["dnsRoute"] = "doh"): Verdict {
  if (evidence.directTcpAttempts > 0) return { outcome: "fail", verdict: "direct-connect-leak" };
  if (pageState !== "loaded") return { outcome: "fail", verdict: "page-failed" };
  if (sessionIssue) return { outcome: "inconclusive", verdict: sessionIssue };
  if (evidence.status !== "valid") return { outcome: "inconclusive", verdict: `netlog-${evidence.status}` };
  if (evidence.systemResolverTasks > 0 || evidence.insecureDnsAttempts > 0) return { outcome: "fail", verdict: "insecure-resolver-fallback" };
  if (evidence.failedTransactions > 0 || evidence.failedProxyConnects > 0) return { outcome: "fail", verdict: "dns-or-proxy-transaction-failed" };
  if (evidence.unfinishedTransactions > 0 || evidence.issues.length > 0) return { outcome: "inconclusive", verdict: "incomplete-or-unsupported-evidence" };
  if (evidence.udpOrQuicEvents > 0) return { outcome: "inconclusive", verdict: "outside-tcp-only-coverage" };
  if (evidence.originRequestsViaProxy === 0) return { outcome: "inconclusive", verdict: "origin-route-unproven" };
  if (evidence.dohTransactions > 0) {
    if (dnsRoute === "proxy") return { outcome: "fail", verdict: "unexpected-doh-in-proxy-route" };
    return evidence.successfulDohViaProxy === evidence.dohTransactions
      ? { outcome: "pass", verdict: "doh-via-proxy" }
      : { outcome: "inconclusive", verdict: "doh-success-or-route-unproven" };
  }
  if (evidence.dohUrlRequests > 0) return { outcome: "inconclusive", verdict: "doh-transaction-unproven" };
  if (evidence.dnsTransactions > 0 || evidence.resolverJobs > 0) return { outcome: "fail", verdict: "local-resolve-no-doh" };
  return dnsRoute === "proxy" ? { outcome: "pass", verdict: "proxy-resolves-all" }
    : { outcome: "inconclusive", verdict: "proxy-resolves-all-doh-not-exercised" };
}

export async function runSample(opts: Options, proxy: LoggingProxy | null, index: number, runtimeRoot: string, version: string): Promise<SampleResult> {
  const testCertSpki = validateTestCertSpki(opts.testCertSpki, opts.upstreamHost, opts.target);
  const profile = fs.mkdtempSync(path.join(runtimeRoot, `profile-${index}-`));
  const netLogPath = path.join(runtimeRoot, `netlog-${index}.json`);
  fs.writeFileSync(netLogPath, "", { flag: "wx", mode: 0o600 });
  const fingerprintArg = buildBrowserFingerprintArg(
    { fingerprintSeed: 40000 + index, platform: opts.platform }, version,
    AGENT_BROWSER_FINGERPRINT_SWITCH, { enabled: opts.dnsRoute === "doh", templates: [...opts.templates] },
  );
  const start = proxy?.records.length ?? 0;
  let context: BrowserContext | null = null;
  let pageState: SampleResult["pageState"] = "error";
  let httpStatus: number | null = null;
  let sessionIssue: string | undefined;
  let netLog: NetLogEvidence;
  try {
    const { chromium } = await import("playwright");
    context = await chromium.launchPersistentContext(profile, {
      executablePath: opts.browser, headless: true, timeout: 20_000, serviceWorkers: "block",
      args: [
        `--proxy-server=${opts.mode === "http" && proxy ? `http://${LOOPBACK}:${proxy.port}` : `socks5://${net.isIP(opts.upstreamHost) === 6 ? `[${opts.upstreamHost}]` : opts.upstreamHost}:${opts.upstreamPort}`}`,
        ...(opts.dnsRoute === "proxy" ? [`--host-resolver-rules=${buildRemoteDnsRule(proxy ? LOOPBACK : opts.upstreamHost, null)}`] : []),
        ...(testCertSpki ? [`--ignore-certificate-errors-spki-list=${testCertSpki}`] : []),
        "--disable-quic", fingerprintArg, "--use-mock-keychain", "--no-first-run", "--no-default-browser-check",
        `--log-net-log=${netLogPath}`, "--net-log-capture-mode=Default", "--net-log-max-size-mb=8",
      ],
    });
    const actualVersion = context.browser()?.version();
    if (!actualVersion || parseExecutableVersion(actualVersion) !== version) sessionIssue = "runtime-version-mismatch";
    const page = await context.newPage();
    const response = await page.goto(opts.target, { waitUntil: "domcontentloaded", timeout: 20_000 });
    httpStatus = response?.status() ?? null;
    if (response && httpStatus !== null && httpStatus >= 200 && httpStatus < 400 && new URL(response.url()).origin === new URL(opts.target).origin && !response.fromServiceWorker() && await response.finished() === null) {
      pageState = "loaded";
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    pageState = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error";
  } finally {
    if (context) {
      try { await context.close(); }
      catch { sessionIssue = "browser-close-failed-log-may-be-unfinished"; }
    }
    // Closing flushes the log. Interpret it BEFORE removing any created runtime files.
    netLog = scanNetLog(netLogPath, {
      mode: opts.mode, proxyHost: proxy ? LOOPBACK : opts.upstreamHost,
      proxyPort: proxy?.port ?? opts.upstreamPort, target: opts.target, templates: opts.templates,
      forwards: proxy?.records.slice(start), observerOverflow: proxy?.overflow,
    });
    if (opts.keepNetLog && fs.existsSync(netLogPath)) fs.chmodSync(netLogPath, 0o600);
    fs.rmSync(profile, { recursive: true, force: true }); // Exactly the fresh profile this sample created.
    if (!opts.keepNetLog) fs.rmSync(netLogPath, { force: true });
  }
  return { index, pageState, httpStatus, sessionIssue, netLog, ...computeVerdict(netLog, pageState, sessionIssue, opts.dnsRoute) };
}

export function filePermissionCoverage(platform: string = process.platform): string {
  return platform === "win32"
    ? "POSIX-mode proof is unsupported on Windows; owner-only ACL privacy is not verified. Exclusive file creation is preserved."
    : "POSIX file mode 0600 and runtime directory mode 0700 requested; ACL and OS-wide privacy are not verified.";
}

export function writePrivateReport(file: string, report: unknown): void {
  // Mode 0600 requests POSIX permissions, not verified Windows owner-only ACLs.
  // Exclusive creation prevents overwriting an earlier report or following an existing symlink.
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  opts.browser = resolveExecutable(opts.browser);
  const parent = fs.lstatSync(opts.workDir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid())) throw new Error("--work-dir must be an existing, owned scratch directory, not a symlink or real browser userData");
  const runtimeRoot = fs.mkdtempSync(path.join(opts.workDir, "managed-doh-"));
  fs.chmodSync(runtimeRoot, 0o700);
  const versionProfile = fs.mkdtempSync(path.join(runtimeRoot, "version-profile-"));
  let version: string;
  try {
    version = parseExecutableVersion(execFileSync(opts.browser, ["--version", `--user-data-dir=${versionProfile}`, "--no-first-run"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 8192,
    }).trim());
  } finally { fs.rmSync(versionProfile, { recursive: true, force: true }); }
  const proxy = opts.mode === "http" ? await startLoggingProxy(opts.upstreamHost, opts.upstreamPort) : null;
  const samples: SampleResult[] = [];
  try {
    for (let index = 0; index < opts.samples; index++) samples.push(await runSample(opts, proxy, index, runtimeRoot, version));
  } finally { await proxy?.close(); }
  const outcome = samples.some((sample) => sample.outcome === "fail") ? "fail" : samples.some((sample) => sample.outcome === "inconclusive") ? "inconclusive" : "pass";
  const result = {
    schema: 2, generatedAt: new Date().toISOString(), browserVersion: version, platform: opts.platform,
    mode: opts.mode, dnsRoute: opts.dnsRoute, targetOrigin: new URL(opts.target).origin, dohOrigins: opts.templates.map((template) => new URL(template.split("{")[0]).origin),
    outcome, verdict: new Set(samples.map((sample) => sample.verdict)).size === 1 ? samples[0].verdict : "mixed-sample-results",
    dnsVerification: outcome === "pass" && samples.every((sample) => sample.verdict === "doh-via-proxy") ? "completed-correlated-doh-for-sampled-host" : outcome === "pass" ? "hostname-delegated-to-proxy-doh-not-exercised" : "not-verified",
    coverage: {
      filePermissions: filePermissionCoverage(),
      tcp: "Selected HTTPS target and managed DoH endpoint only; fresh persistent profile; successful correlated proxy transport required.",
      proxyResolution: "proxy-resolves-all means the sampled hostname tunnel and origin succeeded without observed local DNS; the upstream resolver's implementation is not observed.",
      udpQuic: "Disabled, not verified. Completed failed IPv6 reachability probes with explicit creator/source evidence and no UDP traffic are counted separately, not as packet or OS-wide verification. Raw SOCKS5 TCP does not exercise the production MASQUE/UDP bridge. Every other UDP event or real QUIC session remains inconclusive, never a TCP pass.",
      authentication: "Unauthenticated upstream only. HTTP 407, SOCKS authentication, native auth files and authenticated bridges are not covered.",
      testCertificateException: opts.testCertSpki ? "Controlled .owned.test fixture invocation with literal-loopback upstream and one explicit SHA-256 SPKI pin; no blanket TLS bypass or OS trust changes." : "None; normal certificate validation.",
      limits: "NetLog is not packet capture or an OS-wide DNS leak audit. Unsupported/redacted/incomplete events are inconclusive. Unit fixtures are not runtime DNS evidence.",
    },
    samples,
  };
  const report = opts.report || path.join(runtimeRoot, "report.json");
  writePrivateReport(report, result);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  const privacyLabel = process.platform === "win32" ? "" : "private ";
  process.stderr.write(`[verify-managed-doh] ${privacyLabel}report: ${report}\n`);
  if (process.platform === "win32") process.stderr.write(`[verify-managed-doh] ${filePermissionCoverage()}\n`);
  if (opts.keepNetLog) process.stderr.write(`[verify-managed-doh] ${privacyLabel}Default-capture logs retained under ${runtimeRoot}; they may contain DNS names. No profile is retained.\n`);
  process.exitCode = outcome === "pass" ? 0 : outcome === "inconclusive" ? 2 : 1;
}

export function isMainModule(moduleUrl: string, entry: string | undefined): boolean {
  return entry !== undefined && moduleUrl === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch(() => {
    // Native/Playwright errors can include URLs, credentials and argv. Do not dump them into a report or console.
    process.stderr.write("[verify-managed-doh] verifier failed before a complete report; no DNS success is established. Check explicit options, owned paths and executable version.\n");
    process.exitCode = 1;
  });
}
