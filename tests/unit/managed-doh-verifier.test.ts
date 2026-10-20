import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ launch: vi.fn(), versionProbe: vi.fn(() => { throw new Error("Native commands are forbidden in these tests"); }) }));
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: native.launch } }));
vi.mock("node:child_process", () => ({ execFileSync: native.versionProbe }));

import {
  computeVerdict, filePermissionCoverage, isMainModule, parseExecutableVersion, parseNetLog, parseOptions, runSample,
  scanNetLog, selectPlatform, validateDohTemplate, validateTestCertSpki, writePrivateReport,
  type ConnectRecord, type EvidenceContext, type Options,
} from "../../src/tools/verify-managed-doh.js";
import { MANAGED_SECURE_DNS_TEMPLATES } from "../../src/main/services/browser-fingerprint-config.js";
import { buildRemoteDnsRule, normalizeManagedSecureDnsUrl } from "../../src/main/services/browser-dns-policy.js";

// Schema-only, synthetic fixtures grounded in Chromium 152 source, NOT runtime DNS verification:
// DOH_URL_REQUEST uses a DNS_OVER_HTTPS source shared with URL_REQUEST_START_JOB;
// EndEventWithNetErrorCode omits net_error on success; DNS_TRANSACTION_RESPONSE proves parsed DNS.
const eventNames = [
  "DNS_TRANSACTION", "DNS_TRANSACTION_QUERY", "DOH_URL_REQUEST", "DNS_TRANSACTION_HTTPS_ATTEMPT",
  "DNS_TRANSACTION_RESPONSE", "URL_REQUEST_START_JOB", "HTTP_STREAM_REQUEST_BOUND_TO_JOB",
  "SOCKET_POOL_BOUND_TO_SOCKET", "TCP_CONNECT", "TCP_CONNECT_ATTEMPT", "HOST_RESOLVER_MANAGER_JOB",
  "HOST_RESOLVER_SYSTEM_TASK", "DNS_TRANSACTION_ATTEMPT", "DNS_TRANSACTION_TCP_ATTEMPT",
  "DNS_TRANSACTION_PLATFORM_ATTEMPT", "UDP_CONNECT", "UDP_BYTES_SENT", "QUIC_SESSION", "SOCKS5_CONNECT",
  "SOCKS5_HANDSHAKE_WRITE", "SOCKS5_HANDSHAKE_READ", "DNS_OVER_HTTPS_URL_REQUEST",
];
const eventTypes = Object.fromEntries(eventNames.map((name, index) => [name, index + 1]));
const sourceTypes = { DNS_TRANSACTION: 1, DNS_OVER_HTTPS: 2, URL_REQUEST: 3, HTTP_STREAM_JOB: 4, SOCKET: 5, HOST_RESOLVER_IMPL_JOB: 6 };
interface Event {
  type: number;
  phase: number;
  source: { id: number; type: number };
  params?: Record<string, unknown>;
}
const sources = {
  dns: { id: 10, type: sourceTypes.DNS_TRANSACTION }, doh: { id: 20, type: sourceTypes.DNS_OVER_HTTPS },
  origin: { id: 30, type: sourceTypes.URL_REQUEST }, dohJob: { id: 40, type: sourceTypes.HTTP_STREAM_JOB },
  originJob: { id: 41, type: sourceTypes.HTTP_STREAM_JOB }, dohSocket: { id: 50, type: sourceTypes.SOCKET },
  originSocket: { id: 51, type: sourceTypes.SOCKET }, resolver: { id: 60, type: sourceTypes.HOST_RESOLVER_IMPL_JOB },
};
const target = "https://origin.example/check?synthetic=not-a-real-secret";
const endpoint = "127.0.0.1:40123";
const testCertSpki = Buffer.alloc(32, 7).toString("base64"); // A structural test hash, never real certificate/private-key evidence.
const forwards: ConnectRecord[] = ["origin.example:443", "dns.google:443"].map((target) => ({ target, ok: true, bytesSent: 100, bytesReceived: 200 }));
const context: EvidenceContext = { mode: "http", proxyHost: "127.0.0.1", proxyPort: 40123, target, templates: MANAGED_SECURE_DNS_TEMPLATES, forwards };
function event(name: string, source: Event["source"], phase: number, params?: Record<string, unknown>): Event {
  return { type: eventTypes[name], source, phase, ...(params === undefined ? {} : { params }) };
}
function serialize(events: Event[]): string {
  return JSON.stringify({ constants: { logEventTypes: eventTypes, logSourceType: sourceTypes, logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2, PHASE_NONE: 0 } }, events });
}
function requestEvents(request: Event["source"], job: Event["source"], socket: Event["source"], url: string, address = endpoint): Event[] {
  return [
    event("URL_REQUEST_START_JOB", request, 1, { url }),
    event("HTTP_STREAM_REQUEST_BOUND_TO_JOB", request, 0, { source_dependency: job }),
    event("SOCKET_POOL_BOUND_TO_SOCKET", job, 0, { source_dependency: socket }),
    event("TCP_CONNECT", socket, 1, { address_list: [address] }),
    event("TCP_CONNECT_ATTEMPT", socket, 1, { address }),
    event("TCP_CONNECT_ATTEMPT", socket, 2),
    event("TCP_CONNECT", socket, 2, { local_address: "127.0.0.1:50001", remote_address: address }),
    event("URL_REQUEST_START_JOB", request, 2),
  ];
}
function originEvents(): Event[] {
  return requestEvents(sources.origin, sources.originJob, sources.originSocket, target);
}
function validEvents(): Event[] {
  return [
    ...originEvents(),
    event("DNS_TRANSACTION", sources.dns, 1, { hostname: "origin.example", query_type: 65 }),
    event("DNS_TRANSACTION_QUERY", sources.dns, 1, { qname: "origin.example" }),
    event("DOH_URL_REQUEST", sources.doh, 1, { hostname: "origin.example", query_type: 65 }),
    event("DNS_TRANSACTION_HTTPS_ATTEMPT", sources.dns, 0, { source_dependency: sources.doh }),
    event("DNS_TRANSACTION_HTTPS_ATTEMPT", sources.doh, 0, { source_dependency: sources.dns }),
    ...requestEvents(sources.doh, sources.dohJob, sources.dohSocket, "https://dns.google/dns-query?dns=synthetic"),
    event("DOH_URL_REQUEST", sources.doh, 2),
    event("DNS_TRANSACTION_RESPONSE", sources.dns, 0, { rcode: 0, answer_count: 1, source_dependency: sources.doh }),
    event("DNS_TRANSACTION_QUERY", sources.dns, 2),
    event("DNS_TRANSACTION", sources.dns, 2),
  ];
}
function without(events: Event[], name: string, phase?: number): Event[] {
  return events.filter((item) => item.type !== eventTypes[name] || (phase !== undefined && item.phase !== phase));
}
function verdict(events: Event[], evidenceContext = context, dnsRoute: Options["dnsRoute"] = "doh") {
  return computeVerdict(parseNetLog(serialize(events), evidenceContext), "loaded", undefined, dnsRoute);
}
let workDir: string;
beforeAll(() => {
  // The coordinator supplies MANAGED_DOH_TEST_WORK_DIR/TMPDIR; future runs own a fresh temp child too.
  workDir = fs.mkdtempSync(path.join(process.env.MANAGED_DOH_TEST_WORK_DIR || process.env.TMPDIR || os.tmpdir(), "managed-doh-unit-"));
});
afterEach(() => { vi.restoreAllMocks(); native.launch.mockReset(); native.versionProbe.mockClear(); });

describe("managed DoH verifier evidence falsification (offline, not runtime DNS proof)", () => {
  it("does not launch a native browser/version probe when safely imported", () => {
    expect(native.launch).not.toHaveBeenCalled();
    expect(native.versionProbe).not.toHaveBeenCalled();
    const file = path.join(workDir, "entry.ts");
    expect(isMainModule(pathToFileURL(file).href, file)).toBe(true);
    expect(isMainModule(pathToFileURL(file).href, undefined)).toBe(false);
    expect(isMainModule(pathToFileURL(file).href, path.join(workDir, "other.ts"))).toBe(false);
  });

  it.each(["missing", "deleted", "corrupt"])("never passes a %s netlog even with successful forwarding and page", (kind) => {
    const file = path.join(workDir, `${kind}.json`);
    if (kind === "deleted") { fs.writeFileSync(file, serialize(validEvents()), { mode: 0o600 }); fs.rmSync(file); }
    if (kind === "corrupt") fs.writeFileSync(file, "{\"events\":[", { mode: 0o600 });
    const evidence = scanNetLog(file, context);
    expect(evidence.status).toBe(kind === "corrupt" ? "invalid" : "missing");
    expect(computeVerdict(evidence, "loaded", undefined, "proxy").outcome).toBe("inconclusive");
  });

  it.each(["{}", "[]", "null", "{\"events\":[]}", "not-json"])("never passes invalid/empty log schema %s", (text) => {
    expect(computeVerdict(parseNetLog(text, context), "loaded").outcome).toBe("inconclusive");
  });

  it("rejects oversized logs and symlinks without following preserved evidence", () => {
    expect(parseNetLog(" ".repeat(8 * 1024 * 1024 + 1), context).reason).toBe("log-size-limit");
    const file = path.join(workDir, "preserved-fixture.json");
    const link = path.join(workDir, "fixture-link.json");
    fs.writeFileSync(file, serialize(validEvents()), { mode: 0o600 });
    fs.symlinkSync(file, link);
    expect(scanNetLog(link, context).status).toBe("invalid");
    expect(fs.readFileSync(file, "utf8")).toBe(serialize(validEvents()));
  });

  it("recognizes actual completed, parsed, correlated Chromium 152 DoH events", () => {
    const evidence = parseNetLog(serialize(validEvents()), context);
    expect(evidence).toMatchObject({ status: "valid", dnsTransactions: 1, dohTransactions: 1, successfulDohViaProxy: 1, originRequestsViaProxy: 1, unfinishedTransactions: 0, issues: [] });
    expect(computeVerdict(evidence, "loaded")).toEqual({ outcome: "pass", verdict: "doh-via-proxy" });
    const explicitZero = validEvents().map((item) => item.phase === 2 ? { ...item, params: { ...item.params, net_error: 0 } } : item);
    expect(verdict(explicitZero).outcome).toBe("pass");
  });

  it("URL counts and a successful HTTP request do not prove a successful DNS transaction", () => {
    const events = [...originEvents(), ...requestEvents(sources.doh, sources.dohJob, sources.dohSocket, "https://dns.google/dns-query?dns=synthetic")];
    expect(parseNetLog(serialize(events), context).dohUrlRequests).toBe(1);
    expect(verdict(events)).toEqual({ outcome: "inconclusive", verdict: "doh-transaction-unproven" });
    expect(verdict(events, context, "proxy").outcome).not.toBe("pass");
  });

  it("does not accept old URL-event aliases as completed DoH", () => {
    const events = [...originEvents(), event("DNS_OVER_HTTPS_URL_REQUEST", sources.doh, 0, { url: "https://dns.google/dns-query" })];
    expect(verdict(events, context, "proxy").outcome).toBe("inconclusive");
  });

  it.each(["DOH_URL_REQUEST", "DNS_TRANSACTION", "DNS_TRANSACTION_QUERY"])("unfinished %s cannot pass", (name) => {
    expect(verdict(without(validEvents(), name, 2)).outcome).toBe("inconclusive");
  });

  it.each(["DOH_URL_REQUEST", "DNS_TRANSACTION", "DNS_TRANSACTION_QUERY"])("explicit failed %s cannot pass", (name) => {
    const events = validEvents().map((item) => item.type === eventTypes[name] && item.phase === 2 ? { ...item, params: { net_error: -105 } } : item);
    expect(verdict(events)).toEqual({ outcome: "fail", verdict: "dns-or-proxy-transaction-failed" });
  });

  it("DoH HTTP SUCCESS before response parsing still fails when parent DNS parsing fails", () => {
    const events = validEvents().map((item) => item.type === eventTypes.DNS_TRANSACTION && item.phase === 2 ? { ...item, params: { net_error: -800 } } : item);
    expect(verdict(events).outcome).toBe("fail");
  });

  it.each(["missing-response", "bad-rcode", "wrong-query", "wrong-provider", "wrong-attempt", "wrong-source-type"])("does not pass %s correlation", (change) => {
    let events = validEvents();
    if (change === "missing-response") events = without(events, "DNS_TRANSACTION_RESPONSE");
    else events = events.map((item) => {
      if (change === "bad-rcode" && item.type === eventTypes.DNS_TRANSACTION_RESPONSE) return { ...item, params: { ...item.params, rcode: 3 } };
      if (change === "wrong-query" && item.type === eventTypes.DOH_URL_REQUEST && item.phase === 1) return { ...item, params: { ...item.params, hostname: "unrelated.example" } };
      if (change === "wrong-provider" && item.type === eventTypes.URL_REQUEST_START_JOB && item.source.id === sources.doh.id && item.phase === 1) return { ...item, params: { url: "https://unrelated.example/dns-query" } };
      if (change === "wrong-attempt" && item.type === eventTypes.DNS_TRANSACTION_RESPONSE) return { ...item, params: { ...item.params, source_dependency: { ...sources.doh, id: 21 } } };
      if (change === "wrong-source-type" && item.source.id === sources.doh.id) return { ...item, source: { ...item.source, type: sourceTypes.URL_REQUEST } };
      return item;
    });
    expect(verdict(events).outcome).toBe("inconclusive");
  });

  it("requires actual route correlation, not an unrelated proxy TCP success", () => {
    const events = validEvents().map((item) => item.source.id === sources.dohJob.id && item.type === eventTypes.SOCKET_POOL_BOUND_TO_SOCKET
      ? { ...item, params: { source_dependency: { ...sources.dohSocket, id: 999 } } } : item);
    expect(verdict(events).outcome).toBe("inconclusive");
  });

  it("requires successful forwarding with bidirectional payload, not just a CONNECT attempt or 200", () => {
    expect(verdict(validEvents(), { ...context, forwards: [] }).outcome).toBe("inconclusive");
    expect(verdict(validEvents(), { ...context, forwards: forwards.map((record) => ({ ...record, bytesReceived: 0 })) }).outcome).toBe("inconclusive");
    expect(verdict(validEvents(), { ...context, forwards: forwards.map((record) => ({ ...record, ok: false })) }).outcome).toBe("fail");
    expect(verdict(validEvents(), { ...context, observerOverflow: true }).outcome).toBe("inconclusive");
  });

  it.each(["error", "timeout"] as const)("page %s fails even if DoH evidence is otherwise complete", (pageState) => {
    expect(computeVerdict(parseNetLog(serialize(validEvents()), context), pageState)).toEqual({ outcome: "fail", verdict: "page-failed" });
  });

  it("zero DoH needs successful proxy origin evidence and is not a DoH diagnostic pass", () => {
    expect(verdict(originEvents(), context, "proxy")).toEqual({ outcome: "pass", verdict: "proxy-resolves-all" });
    expect(verdict(originEvents()).outcome).toBe("inconclusive");
    expect(verdict(originEvents(), { ...context, forwards: [] }, "proxy").outcome).toBe("inconclusive");
    expect(verdict(originEvents().filter((item) => item.source.id !== sources.originSocket.id), context, "proxy").outcome).toBe("inconclusive");
    expect(verdict(validEvents(), context, "proxy").outcome).toBe("fail");
  });

  it.each(["HOST_RESOLVER_SYSTEM_TASK", "DNS_TRANSACTION_ATTEMPT", "DNS_TRANSACTION_TCP_ATTEMPT", "DNS_TRANSACTION_PLATFORM_ATTEMPT"])("strictly rejects insecure/system fallback %s", (name) => {
    expect(verdict([...validEvents(), event(name, sources.resolver, name === "HOST_RESOLVER_SYSTEM_TASK" ? 1 : 0)]).outcome).toBe("fail");
  });

  it.each(["198.51.100.2:443", "127.0.0.1:40124", "[::1]:443"])("detects non-proxy TCP attempts including failed/loopback %s", (address) => {
    const events = [...validEvents(), event("TCP_CONNECT_ATTEMPT", { id: 100, type: sourceTypes.SOCKET }, 1, { address }), event("TCP_CONNECT_ATTEMPT", { id: 100, type: sourceTypes.SOCKET }, 2, { net_error: -102 })];
    expect(verdict(events)).toEqual({ outcome: "fail", verdict: "direct-connect-leak" });
  });

  it.each(["UDP_CONNECT", "UDP_BYTES_SENT", "QUIC_SESSION"])("does not claim UDP/QUIC coverage from TCP-only evidence (%s)", (name) => {
    expect(verdict([...validEvents(), event(name, { id: 101, type: sourceTypes.SOCKET }, 1, { address: "198.51.100.3:443" })]).outcome).toBe("inconclusive");
  });

  it("requires complete same-socket SOCKS5 CONNECT/write/read evidence, without raw packet capture", () => {
    const handshakes = [sources.originSocket, sources.dohSocket].flatMap((source) => [
      event("SOCKS5_CONNECT", source, 1), event("SOCKS5_HANDSHAKE_WRITE", source, 1), event("SOCKS5_HANDSHAKE_WRITE", source, 2),
      event("SOCKS5_HANDSHAKE_READ", source, 1), event("SOCKS5_HANDSHAKE_READ", source, 2), event("SOCKS5_CONNECT", source, 2),
    ]);
    const events = [...validEvents(), ...handshakes];
    const socksContext = { ...context, mode: "socks5" as const, forwards: undefined };
    expect(verdict(events, socksContext).outcome).toBe("pass");
    expect(verdict(without(events, "SOCKS5_HANDSHAKE_READ", 2), socksContext).outcome).toBe("inconclusive");
  });

  it("invalid dependencies and END-only events cannot create positive evidence", () => {
    const bad = validEvents().map((item) => item.type === eventTypes.SOCKET_POOL_BOUND_TO_SOCKET ? { ...item, params: { source_dependency: { id: 50 } } } : item);
    expect(parseNetLog(serialize(bad), context).status).toBe("invalid");
    expect(verdict([...originEvents(), event("DOH_URL_REQUEST", sources.doh, 2)], context, "proxy").outcome).toBe("inconclusive");
  });

  function signedCertShapeLog(events: Event[], id: unknown = -2147483644): string {
    const raw = JSON.parse(serialize(events));
    raw.constants.logEventTypes.CERT_VERIFY_PROC_CREATED = 483;
    raw.constants.logSourceType.CERT_VERIFY_PROC_CREATED = 25;
    // Exact metadata shape of owned Chromium 152 NetLog events 106/107, not a copied log or DNS proof.
    raw.events.push(...[1, 2].map((phase) => ({ type: 483, phase, source: { id, type: 25, start_time: "1921845565" } })));
    return JSON.stringify(raw);
  }
  it("accepts real signed CERT_VERIFY_PROC_CREATED source IDs without weakening successful DNS/route requirements", () => {
    const evidence = parseNetLog(signedCertShapeLog(validEvents()), context);
    expect(evidence.status).toBe("valid");
    expect(computeVerdict(evidence, "loaded")).toEqual({ outcome: "pass", verdict: "doh-via-proxy" });
    const metadataOnly = parseNetLog(signedCertShapeLog([]), context);
    expect(metadataOnly.status).toBe("valid");
    expect(computeVerdict(metadataOnly, "loaded", undefined, "proxy")).toEqual({ outcome: "inconclusive", verdict: "origin-route-unproven" });
  });
  it("canonicalizes signed uint32 IDs and unsigned dependencies only when they identify the same source", () => {
    const correlated = validEvents().map((item) => ({ ...item,
      source: item.source.id === sources.dohSocket.id ? { ...item.source, id: -2147483644 } : item.source,
      ...(item.params?.source_dependency && (item.params.source_dependency as Event["source"]).id === sources.dohSocket.id
        ? { params: { ...item.params, source_dependency: { ...sources.dohSocket, id: 2147483652 } } } : {}),
    }));
    expect(verdict(correlated).outcome).toBe("pass");
    const wrongSource = correlated.map((item) => item.params?.source_dependency && (item.params.source_dependency as Event["source"]).id === 2147483652
      ? { ...item, params: { ...item.params, source_dependency: { ...sources.dohSocket, id: 2147483653 } } } : item);
    expect(verdict(wrongSource).outcome).toBe("inconclusive");
  });
  it.each([-2147483649, 4294967296, -1.25, "-2147483644"])("still rejects out-of-range/noninteger source ID #%#", (id) => {
    const evidence = parseNetLog(signedCertShapeLog(validEvents(), id), context);
    expect(evidence.status).toBe("invalid");
    expect(computeVerdict(evidence, "loaded", undefined, "proxy").outcome).toBe("inconclusive");
  });

  function reachabilityShapeLog(control = "", includeOrigin = true): string {
    const raw = JSON.parse(serialize(includeOrigin ? originEvents() : []));
    // Keep the retained probe's actual source types/IDs; relocate unrelated synthetic fixture types.
    raw.constants.logSourceType = Object.fromEntries(Object.entries(raw.constants.logSourceType).map(([name, id]) => [name, Number(id) + 1000]));
    for (const entry of raw.events) {
      entry.source.type += 1000;
      if (entry.params?.source_dependency) entry.params.source_dependency.type += 1000;
    }
    Object.assign(raw.constants.logSourceType, { HTTP_PROXY_CONNECT_JOB: 3, UDP_SOCKET: 24, UDP_CLIENT_SOCKET: 48, QUIC_SESSION: 70 });
    for (const name of ["SOCKET_ALIVE", "SOCKET_OPEN", "SOCKET_CONNECT", "HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK", "UDP_BYTES_RECEIVED", "UDP_SEND_TO", "SOCKET_BYTES_SENT", "QUIC_SESSION_PACKET_SENT"]) {
      raw.constants.logEventTypes[name] ??= 500 + Object.keys(raw.constants.logEventTypes).length;
    }
    const udp = { id: 13, type: 24 }, client = { id: 12, type: 48 }, creator = { id: 11, type: 3 };
    const probeEvent = (name: string, source: Event["source"], phase: number, params?: Record<string, unknown>) => ({ type: raw.constants.logEventTypes[name], source, phase, ...(params ? { params } : {}) });
    const address = control === "ipv4" ? "8.8.8.8:443" : "[2001:4860:4860::8888]:443";
    const probe = [
      probeEvent("SOCKET_ALIVE", udp, 1, control === "missing-dependency" ? {} : { source_dependency: client }),
      probeEvent("SOCKET_ALIVE", client, 1, { source_dependency: creator }),
      probeEvent("SOCKET_OPEN", client, 0),
      probeEvent("UDP_CONNECT", udp, 1, { address }),
      ...(control === "unfinished" ? [] : [probeEvent("UDP_CONNECT", udp, 2, control === "successful" ? {} : { net_error: -109 })]),
      probeEvent("SOCKET_CONNECT", client, 0, { address, net_error: -109 }),
      probeEvent("SOCKET_ALIVE", client, 2),
      probeEvent("SOCKET_ALIVE", udp, 2),
      ...(control === "missing-marker" ? [] : [probeEvent("HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK", control === "unrelated" ? { id: 88, type: 3 } : creator, 0,
        { cached: control === "cached-marker", ipv6_available: control === "available-marker" })]),
    ];
    if (["UDP_BYTES_SENT", "UDP_BYTES_RECEIVED", "UDP_SEND_TO"].includes(control)) probe.push(probeEvent(control, udp, 0, { byte_count: 1, address }));
    if (control === "SOCKET_BYTES_SENT") probe.push(probeEvent(control, client, 0, { byte_count: 1 }));
    if (["QUIC_SESSION", "QUIC_SESSION_PACKET_SENT"].includes(control)) probe.push(probeEvent(control, { id: 90, type: 70 }, 0));
    if (control === "dns-attempt") probe.push(probeEvent("DNS_TRANSACTION_ATTEMPT", { id: 60, type: 1006 }, 0, { source_dependency: udp }));
    raw.events.push(...probe);
    return JSON.stringify(raw);
  }
  it("separately counts only the retained completed failed source-linked IPv6 probe shape", () => {
    const evidence = parseNetLog(reachabilityShapeLog(), context);
    expect(evidence).toMatchObject({ status: "valid", reachabilityProbes: 1, udpOrQuicEvents: 0, issues: [], originRequestsViaProxy: 1 });
    expect(computeVerdict(evidence, "loaded", undefined, "proxy")).toEqual({ outcome: "pass", verdict: "proxy-resolves-all" });
    const probeOnly = parseNetLog(reachabilityShapeLog("", false), context);
    expect(probeOnly.reachabilityProbes).toBe(1);
    expect(computeVerdict(probeOnly, "loaded", undefined, "proxy").outcome).toBe("inconclusive");
  });
  it.each(["successful", "unfinished", "unrelated", "missing-marker", "missing-dependency", "cached-marker", "available-marker", "ipv4", "UDP_BYTES_SENT", "UDP_BYTES_RECEIVED", "UDP_SEND_TO", "SOCKET_BYTES_SENT", "QUIC_SESSION", "QUIC_SESSION_PACKET_SENT", "dns-attempt"])("never exempts UDP/QUIC or unknown probe evidence (%s)", (control) => {
    const evidence = parseNetLog(reachabilityShapeLog(control), context);
    expect(evidence.status).toBe("valid");
    expect(evidence.reachabilityProbes).toBe(0);
    expect(evidence.udpOrQuicEvents).toBeGreaterThan(0);
    expect(computeVerdict(evidence, "loaded", undefined, "proxy").outcome).not.toBe("pass");
  });
});

describe("controlled-fixture certificate pin gate (offline, no trust store changes)", () => {
  const args = ["--browser=/owned/Chromium", "--work-dir=/owned/scratch", "--target=https://origin.owned.test/"];
  it.each(["127.0.0.1:1080", "127.0.0.2:1080", "[::1]:1080", "[0:0:0:0:0:0:0:1]:1080"])("accepts one canonical SPKI pin only with owned target and literal loopback %s", (upstream) => {
    expect(parseOptions([...args, `--upstream=${upstream}`, `--test-cert-spki=${testCertSpki}`], "darwin").testCertSpki).toBe(testCertSpki);
  });
  it.each([
    ["127.0.0.1", "https://public.example/"],
    ["192.0.2.1", "https://origin.owned.test/"],
    ["2001:db8::1", "https://origin.owned.test/"],
  ])("rejects test-cert-spki outside the controlled fixture gate (%s, %s)", (upstream, target) => {
    expect(() => validateTestCertSpki(testCertSpki, upstream, target)).toThrow(/literal-loopback/);
  });
  it.each(["", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), Buffer.alloc(32, 255).toString("base64url"), testCertSpki.slice(0, -1), testCertSpki + "\n", testCertSpki.slice(0, -2) + "x=", " " + testCertSpki])("rejects invalid, noncanonical or non-SHA256 SPKI hash #%#", (pin) => {
    expect(() => validateTestCertSpki(pin, "127.0.0.1", "https://origin.owned.test/")).toThrow(/canonical base64/);
  });
  it.each(["https://owned.test/", "https://origin.owned.test.evil.example/", "https://originowned.test/", "http://origin.owned.test/", "https://user:pass@origin.owned.test/"])("rejects target suffix/protocol/credential bypass %s", (target) => {
    expect(() => validateTestCertSpki(testCertSpki, "127.0.0.1", target)).toThrow();
  });
  it("rejects the flag at CLI parsing for public targets and nonloopback/name upstreams", () => {
    expect(() => parseOptions(["--browser=/owned/Chromium", "--work-dir=/owned/scratch", "--upstream=127.0.0.1:1080", "--target=https://public.example/", `--test-cert-spki=${testCertSpki}`], "darwin")).toThrow();
    expect(() => parseOptions([...args, "--upstream=192.0.2.1:1080", `--test-cert-spki=${testCertSpki}`], "darwin")).toThrow();
    expect(() => parseOptions([...args, "--upstream=localhost:1080", `--test-cert-spki=${testCertSpki}`], "darwin")).toThrow();
  });
  it("does not change normal TLS validation when the option is absent", () => {
    expect(validateTestCertSpki(undefined, "192.0.2.1", "https://public.example/")).toBeUndefined();
    expect(parseOptions(["--browser=/owned/Chromium", "--work-dir=/owned/scratch", "--upstream=192.0.2.1:1080"], "darwin").testCertSpki).toBeUndefined();
  });
});

describe("verifier version, platform and explicit production DNS defaults", () => {
  const args = ["--browser=/owned/Chromium", "--work-dir=/owned/scratch", "--upstream=192.0.2.1:1080"];
  it("defaults to host persona and production proxy-side DNS, not Windows/Chrome 150/Google DoH", () => {
    const opts = parseOptions(args, "darwin");
    expect(opts).toMatchObject({ platform: "macos", dnsRoute: "proxy", templates: [], mode: "http" });
    expect(parseOptions(args, "win32").platform).toBe("windows");
    expect(parseOptions([...args, "--platform=android"], "linux").platform).toBe("android");
    expect(() => parseOptions(args, "linux")).toThrow(/explicitly/);
    expect(() => selectPlatform("linux", "darwin")).toThrow();
  });
  it.each(["Chromium 152.0.7937.0", "Google Chrome for Testing 152.0.7937.0 (Official Build)", "HeadlessChrome/152.0.7937.0", "152.0.7937.0"])("validates executable/runtime version %s", (text) => {
    expect(parseExecutableVersion(text)).toBe("152.0.7937.0");
  });
  it.each(["", "Chromium 152", "Chromium 152.0.0", "Firefox 152.0.7937.0", "unrelated 152.0.7937.0", "Chromium 0.0.0.0", "Chromium 99999999999999999.0.0.0", "Chromium 152.0.0.1\nChromium 150.0.0.1"])("never guesses an invalid/ambiguous version %s", (text) => {
    expect(() => parseExecutableVersion(text)).toThrow();
  });
  it("supports explicit diagnostic DoH and reuses the production URL validator including POST", () => {
    expect(parseOptions([...args, "--dns-route=doh"], "darwin").templates).toEqual([...MANAGED_SECURE_DNS_TEMPLATES]);
    const template = "https://resolver.example/dns-query{?dns}";
    expect(parseOptions([...args, `--doh-template=${template}`], "darwin")).toMatchObject({ dnsRoute: "doh", templates: [template] });
    expect(validateDohTemplate("https://resolver.example/dns-query")).toBe(normalizeManagedSecureDnsUrl("https://resolver.example/dns-query"));
    expect(validateDohTemplate("https://resolver.example/dns-query?provider=synthetic")).toBe(normalizeManagedSecureDnsUrl("https://resolver.example/dns-query?provider=synthetic"));
    expect(validateDohTemplate("https://resolver.example/dns-query?provider=synthetic{&dns}")).toBe(normalizeManagedSecureDnsUrl("https://resolver.example/dns-query?provider=synthetic{&dns}"));
    expect(parseOptions([...args, "--doh-template=https://resolver.example/dns-query?provider=synthetic{&dns}"], "darwin").dnsRoute).toBe("doh");
  });
  it.each(["http://resolver.example/query", "https://user:pass@resolver.example/query", "https://resolver.example/query#fragment", "https://resolver.example/query{bad}", "https://resolver.example/query{&dns}", "https://resolver.example/query?provider=synthetic{?dns}", "https://resolver.example/white space", "https://resolver.example/" + "x".repeat(1000)])("rejects invalid DoH template %s", (template) => {
    expect(() => validateDohTemplate(template)).toThrow();
  });
  it("requires explicit IP upstream, bounded samples, known flags and consistent routes", () => {
    expect(() => parseOptions([args[0], args[1]], "darwin")).toThrow();
    expect(() => parseOptions([...args, "--samples=4"], "darwin")).toThrow();
    expect(() => parseOptions([...args, "--samples=1", "--samples=2"], "darwin")).toThrow();
    expect(() => parseOptions([...args, "--auth=user:pass"], "darwin")).toThrow();
    expect(() => parseOptions([...args, "--dns-route=proxy", "--doh-template=https://resolver.example/query"], "darwin")).toThrow();
    expect(() => parseOptions([args[0], args[1], "--upstream=proxy.example:1080"], "darwin")).toThrow(/literal IP/);
    expect(parseOptions([args[0], args[1], "--upstream=[::1]:1080"], "darwin")).toMatchObject({ upstreamHost: "::1", upstreamPort: 1080 });
    expect(() => parseOptions([...args, "--target=https://user:pass@origin.example"], "darwin")).toThrow();
  });
});

describe("owned persistent sample lifecycle and private bounded reporting (mock browser only)", () => {
  const version = "152.0.7937.0";
  function options(dnsRoute: Options["dnsRoute"] = "doh", keepNetLog = false): Options {
    return { browser: "/never-launch/Chromium", mode: "http", upstreamHost: "192.0.2.1", upstreamPort: 1080, target,
      dnsRoute, templates: dnsRoute === "doh" ? MANAGED_SECURE_DNS_TEMPLATES : [], platform: "macos", workDir, samples: 1, keepNetLog };
  }
  function stub(root: string, opts: Options, logState: "valid" | "deleted" | "corrupt" = "valid", runtimeVersion = version, status = 200, closeFails = false) {
    const proxy = { port: 40123, records: [] as ConnectRecord[], overflow: false, close: async () => undefined };
    let logPath = "";
    let profilePath = "";
    native.launch.mockImplementation(async (profile: string, launch: { args: string[]; ignoreHTTPSErrors?: boolean }) => {
      profilePath = profile;
      logPath = launch.args.find((arg) => arg.startsWith("--log-net-log="))!.slice("--log-net-log=".length);
      expect(profile.startsWith(root + path.sep)).toBe(true);
      expect(fs.statSync(profile).isDirectory()).toBe(true);
      const config = JSON.parse(Buffer.from(launch.args.find((arg) => arg.startsWith("--agent-browser-fingerprint-config="))!.split("=")[1], "base64url").toString("utf8"));
      expect(config.userAgent).toContain(`Chrome/${version}`);
      expect(config.platform).toBe("MacIntel");
      expect(config.secureDns).toEqual({ enabled: opts.dnsRoute === "doh", templates: [...opts.templates] });
      expect(launch.args).toContain("--net-log-capture-mode=Default");
      expect(launch.args).toContain("--net-log-max-size-mb=8");
      expect(launch.args).toContain("--disable-quic");
      const rules = launch.args.filter((arg) => arg.startsWith("--host-resolver-rules="));
      expect(rules).toEqual(opts.dnsRoute === "proxy" ? [`--host-resolver-rules=${buildRemoteDnsRule(opts.mode === "http" ? context.proxyHost : opts.upstreamHost, null)}`] : []);
      expect(launch.args).not.toContain("--net-log-capture-mode=Everything");
      expect(launch.args.filter((arg) => arg.startsWith("--ignore-certificate-errors-spki-list="))).toEqual(opts.testCertSpki ? [`--ignore-certificate-errors-spki-list=${opts.testCertSpki}`] : []);
      expect(launch.args).not.toContain("--ignore-certificate-errors");
      expect(launch.ignoreHTTPSErrors).toBeUndefined();
      return {
        browser: () => ({ version: () => runtimeVersion }),
        newPage: async () => ({ goto: async () => ({ status: () => status, url: () => opts.target, fromServiceWorker: () => false, finished: async () => null }) }),
        close: async () => {
          proxy.records.push(...forwards.map((record) => ({ ...record })));
          if (logState === "deleted") fs.rmSync(logPath);
          else fs.writeFileSync(logPath, logState === "corrupt" ? "{" : serialize(opts.dnsRoute === "doh" ? validEvents() : originEvents()));
          if (closeFails) throw new Error("synthetic close failure");
        },
      };
    });
    return { proxy, paths: () => ({ logPath, profilePath }) };
  }
  it("passes only the explicit pin switch for a controlled fixture, without blanket TLS errors or native trust changes", async () => {
    const root = fs.mkdtempSync(path.join(workDir, "sample-fixture-pin-"));
    const opts = { ...options("proxy"), upstreamHost: "127.0.0.1", target: "https://origin.owned.test/", testCertSpki };
    const fake = stub(root, opts);
    const result = await runSample(opts, fake.proxy, 0, root, version);
    expect(native.launch).toHaveBeenCalledOnce();
    expect(result.pageState).toBe("loaded");
    expect(result.outcome).toBe("inconclusive"); // This mock's unrelated NetLog is not controlled-fixture DNS proof.
    expect(native.versionProbe).not.toHaveBeenCalled();
  });
  it("checks the certificate fixture gate before files/native launch even when runSample bypasses CLI parsing", async () => {
    const root = fs.mkdtempSync(path.join(workDir, "sample-rejected-pin-"));
    const opts = { ...options("proxy"), testCertSpki };
    const fake = stub(root, opts);
    await expect(runSample(opts, fake.proxy, 0, root, version)).rejects.toThrow(/literal-loopback/);
    expect(native.launch).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("flushes and parses before cleanup using its explicit persistent profile, then removes only created temporary files", async () => {
    const root = fs.mkdtempSync(path.join(workDir, "sample-cleanup-"));
    const opts = options();
    const fake = stub(root, opts);
    const result = await runSample(opts, fake.proxy, 0, root, version);
    expect(result).toMatchObject({ pageState: "loaded", outcome: "pass", verdict: "doh-via-proxy", netLog: { status: "valid" } });
    expect(fs.existsSync(fake.paths().logPath)).toBe(false);
    expect(fs.existsSync(fake.paths().profilePath)).toBe(false);
    expect(native.versionProbe).not.toHaveBeenCalled();
  });
  it("preserves explicitly kept evidence with requested POSIX mode, never a real profile or raw Everything capture", async () => {
    const root = fs.mkdtempSync(path.join(workDir, "sample-preserved-"));
    const opts = options("doh", true);
    const fake = stub(root, opts);
    const result = await runSample(opts, fake.proxy, 0, root, version);
    expect(result.outcome).toBe("pass");
    expect(fs.existsSync(fake.paths().profilePath)).toBe(false);
    if (process.platform !== "win32") expect(fs.statSync(fake.paths().logPath).mode & 0o777).toBe(0o600);
    else expect(filePermissionCoverage()).toMatch(/unsupported on Windows.*ACL privacy is not verified/);
    expect(scanNetLog(fake.paths().logPath, context).successfulDohViaProxy).toBe(1);
  });
  it("proxy route disables DoH and requires forward/origin success, not mere loading", async () => {
    const root = fs.mkdtempSync(path.join(workDir, "sample-proxy-"));
    const opts = options("proxy");
    const fake = stub(root, opts);
    expect(await runSample(opts, fake.proxy, 0, root, version)).toMatchObject({ outcome: "pass", verdict: "proxy-resolves-all", netLog: { dohTransactions: 0, originRequestsViaProxy: 1 } });
  });
  it.each(["proxy", "doh"] as const)("SOCKS5 %s route uses the production prefetch rule only when appropriate", async (dnsRoute) => {
    const root = fs.mkdtempSync(path.join(workDir, `sample-socks-${dnsRoute}-`));
    const opts = { ...options(dnsRoute), mode: "socks5" as const, upstreamHost: context.proxyHost, upstreamPort: context.proxyPort };
    stub(root, opts);
    // No real socket or handshake is performed by this mock: args are checked, not runtime DNS.
    expect((await runSample(opts, null, 0, root, version)).outcome).toBe("inconclusive");
  });
  it.each(["deleted", "corrupt"] as const)("does not false-pass a %s log during otherwise successful sample", async (logState) => {
    const root = fs.mkdtempSync(path.join(workDir, `sample-${logState}-`));
    const opts = options("proxy");
    const fake = stub(root, opts, logState);
    expect((await runSample(opts, fake.proxy, 0, root, version)).outcome).toBe("inconclusive");
  });
  it("runtime/executable version mismatch cannot pass", async () => {
    const root = fs.mkdtempSync(path.join(workDir, "sample-version-"));
    const opts = options();
    const fake = stub(root, opts, "valid", "150.0.7871.114");
    expect(await runSample(opts, fake.proxy, 0, root, version)).toMatchObject({ outcome: "inconclusive", sessionIssue: "runtime-version-mismatch" });
  });
  it("HTTP error response or failed browser close cannot pass", async () => {
    const root = fs.mkdtempSync(path.join(workDir, "sample-page-failure-"));
    const opts = options();
    const fake = stub(root, opts, "valid", version, 500);
    expect(await runSample(opts, fake.proxy, 0, root, version)).toMatchObject({ outcome: "fail", verdict: "page-failed", httpStatus: 500 });
    const second = stub(root, opts, "valid", version, 200, true);
    expect(await runSample(opts, second.proxy, 1, root, version)).toMatchObject({ outcome: "inconclusive", sessionIssue: "browser-close-failed-log-may-be-unfinished" });
  });
  it("discloses unsupported Windows POSIX-mode proof without claiming private ACLs", () => {
    expect(filePermissionCoverage("win32")).toMatch(/unsupported on Windows.*ACL privacy is not verified/);
    for (const platform of ["darwin", "linux"]) {
      expect(filePermissionCoverage(platform)).toContain("POSIX file mode 0600");
      expect(filePermissionCoverage(platform)).not.toContain("unsupported");
    }
  });
  it("writes exclusive JSON reports with requested POSIX mode, verifies content and preserves earlier evidence", () => {
    const file = path.join(workDir, "private-report.json");
    const report = { schema: 2, outcome: "inconclusive", samples: [{ netLog: { status: "missing" } }] };
    writePrivateReport(file, report);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    else expect(filePermissionCoverage()).toMatch(/unsupported on Windows.*ACL privacy is not verified/);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(report);
    expect(() => writePrivateReport(file, { outcome: "pass" })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(report);
  });
});
