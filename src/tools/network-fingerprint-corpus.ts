import { createHash } from "node:crypto";

export type WireValue = number | "GREASE";

export interface TlsClientHelloIdentity {
  recordVersion: number;
  handshakeVersion: number;
  cipherSuites: WireValue[];
  compressionMethods: number[];
  extensionMultiset: WireValue[];
  supportedGroups: WireValue[];
  ecPointFormats: number[];
  signatureAlgorithms: number[];
  alpn: string[];
  compressCertificate: number[] | null;
  recordSizeLimit: number[];
  supportedVersions: WireValue[];
  pskKeyExchangeModes: number[];
  keyShare: WireValue[];
  applicationSettings: unknown;
}

export interface TlsCorpusIdentity {
  navigationProtocol: string;
  httpVersion: string;
  negotiatedVersion: string;
  recordVersion: string;
  ja4: string;
  ja4Raw: string;
  clientHello: TlsClientHelloIdentity;
}

export interface Http2CorpusIdentity {
  navigationProtocol: string;
  httpVersion: string;
  akamaiFingerprint: string;
  settings: string[];
  windowUpdate: number | null;
  frameTypes: string[];
  headerOrder: string[];
  headerFlags: string[];
  priority: {
    weight: number;
    dependsOn: number;
    exclusive: number;
  } | null;
}

export interface Http3CorpusIdentity {
  navigationProtocol: string;
  topFingerprintId: string;
  clientInitialFingerprintId: string;
  normalizedClientHelloId: string;
  transportFingerprintId: string;
  packetCount: number;
  versions: number[][];
  destinationConnectionIdLengths: number[];
  packetNumberByteLengths: number[];
  clientHello: TlsClientHelloIdentity;
  transportParameters: Record<string, unknown>;
}

export interface NetworkFingerprintIdentity {
  tls: TlsCorpusIdentity;
  http2: Http2CorpusIdentity;
  http3: Http3CorpusIdentity;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numbers(value: unknown): number[] {
  return array(value).filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
}

function strings(value: unknown): string[] {
  return array(value).filter((entry): entry is string => typeof entry === "string");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** RFC 8701 GREASE values have matching nibbles and end in 0x0a. */
export function isTlsGrease(value: number): boolean {
  return (value & 0x0f0f) === 0x0a0a;
}

export function normalizeTlsGrease(values: number[]): WireValue[] {
  return values.map((value) => isTlsGrease(value) ? "GREASE" : value);
}

function sortWireValues(values: WireValue[]): WireValue[] {
  return [...values].sort((left, right) => {
    if (left === right) return 0;
    if (left === "GREASE") return -1;
    if (right === "GREASE") return 1;
    return left - right;
  });
}

export function canonicalizeClientHello(value: unknown): TlsClientHelloIdentity {
  const hello = record(value, "TLS ClientHello");
  return {
    recordVersion: finiteNumber(hello.tls_record_version) || 0,
    handshakeVersion: finiteNumber(hello.tls_handshake_version) || 0,
    cipherSuites: normalizeTlsGrease(numbers(hello.cipher_suites)),
    compressionMethods: numbers(hello.compression_methods),
    // Chrome intentionally permutes extensions. Preserve the multiset while
    // removing only order and the process-selected GREASE code point.
    extensionMultiset: sortWireValues(normalizeTlsGrease(numbers(hello.extensions))),
    supportedGroups: normalizeTlsGrease(numbers(hello.supported_groups)),
    ecPointFormats: numbers(hello.ec_point_formats),
    signatureAlgorithms: numbers(hello.signature_algorithms),
    alpn: strings(hello.alpn),
    compressCertificate: hello.compress_certificate === null
      ? null
      : numbers(hello.compress_certificate),
    recordSizeLimit: numbers(hello.record_size_limit),
    supportedVersions: normalizeTlsGrease(numbers(hello.supported_versions)),
    pskKeyExchangeModes: numbers(hello.psk_key_exchange_modes),
    keyShare: normalizeTlsGrease(numbers(hello.key_share)),
    applicationSettings: hello.application_settings ?? null,
  };
}

function headerName(line: string): string {
  if (line.startsWith(":")) {
    const separator = line.indexOf(":", 1);
    return separator < 0 ? line : line.slice(0, separator);
  }
  const separator = line.indexOf(":");
  return separator < 0 ? line : line.slice(0, separator);
}

export function canonicalizeTlsAndHttp2(
  peetValue: unknown,
  fingerprintValue: unknown,
  peetNavigationProtocol: string,
): { tls: TlsCorpusIdentity; http2: Http2CorpusIdentity } {
  const peet = record(peetValue, "peet.ws response");
  const peetTls = record(peet.tls, "peet.ws TLS response");
  const http2 = record(peet.http2, "peet.ws HTTP/2 response");
  const frames = array(http2.sent_frames).map((frame, index) =>
    record(frame, `HTTP/2 frame ${index}`));
  const settingsFrame = frames.find((frame) => frame.frame_type === "SETTINGS");
  const windowUpdateFrame = frames.find((frame) => frame.frame_type === "WINDOW_UPDATE");
  const headersFrame = frames.find((frame) => frame.frame_type === "HEADERS");
  const headerLines = strings(headersFrame?.headers);
  const priorityValue = headersFrame?.priority;
  const priorityRecord = priorityValue && typeof priorityValue === "object" && !Array.isArray(priorityValue)
    ? priorityValue as JsonRecord
    : null;

  return {
    tls: {
      navigationProtocol: peetNavigationProtocol,
      httpVersion: text(peet.http_version),
      negotiatedVersion: text(peetTls.tls_version_negotiated),
      recordVersion: text(peetTls.tls_version_record),
      ja4: text(peetTls.ja4),
      ja4Raw: text(peetTls.ja4_r),
      clientHello: canonicalizeClientHello(fingerprintValue),
    },
    http2: {
      navigationProtocol: peetNavigationProtocol,
      httpVersion: text(peet.http_version),
      akamaiFingerprint: text(http2.akamai_fingerprint),
      settings: strings(settingsFrame?.settings),
      windowUpdate: finiteNumber(windowUpdateFrame?.increment),
      frameTypes: frames.map((frame) => text(frame.frame_type)),
      headerOrder: headerLines.map(headerName),
      headerFlags: strings(headersFrame?.flags),
      priority: priorityRecord ? {
        weight: finiteNumber(priorityRecord.weight) || 0,
        dependsOn: finiteNumber(priorityRecord.depends_on) || 0,
        exclusive: finiteNumber(priorityRecord.exclusive) || 0,
      } : null,
    },
  };
}

export function canonicalizeHttp3(value: unknown, navigationProtocol: string): Http3CorpusIdentity {
  const response = record(value, "QUIC fingerprint response");
  const initials = record(response.ClientInitials, "QUIC ClientInitials");
  const packets = array(initials.packets).map((packet, index) =>
    record(packet, `QUIC initial packet ${index}`));
  const clientHello = record(initials.client_hello, "QUIC ClientHello");
  const transport = record(initials.transport_parameters, "QUIC transport parameters");
  const transportParameters = Object.fromEntries(Object.entries(transport)
    .filter(([key]) => key !== "hex_id" && key !== "num_id")
    .sort(([left], [right]) => left.localeCompare(right)));

  return {
    navigationProtocol,
    topFingerprintId: text(response.hex_id),
    clientInitialFingerprintId: text(initials.hex_id),
    normalizedClientHelloId: text(clientHello.norm_hex_id),
    transportFingerprintId: text(transport.hex_id),
    packetCount: packets.length,
    versions: packets.map((packet) => numbers(record(packet.header, "QUIC packet header").version)),
    destinationConnectionIdLengths: packets.map((packet) =>
      finiteNumber(record(packet.header, "QUIC packet header").dest_conn_id_len) || 0),
    packetNumberByteLengths: packets.map((packet) =>
      numbers(record(packet.header, "QUIC packet header").packet_number).length),
    clientHello: canonicalizeClientHello(clientHello),
    transportParameters,
  };
}

export function networkFingerprintHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function diffNetworkFingerprint(
  expected: unknown,
  actual: unknown,
  prefix = "",
): string[] {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  if (
    expected === null || actual === null ||
    typeof expected !== "object" || typeof actual !== "object" ||
    Array.isArray(expected) || Array.isArray(actual)
  ) {
    return [prefix || "value"];
  }
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => diffNetworkFingerprint(
    left[key],
    right[key],
    prefix ? `${prefix}.${key}` : key,
  ));
}
