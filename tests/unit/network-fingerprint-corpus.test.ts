import { describe, expect, it } from "vitest";
import {
  canonicalizeClientHello,
  canonicalizeHttp3,
  canonicalizeTlsAndHttp2,
  diffNetworkFingerprint,
  isTlsGrease,
  networkFingerprintHash,
} from "../../src/tools/network-fingerprint-corpus.js";

function clientHello(grease: number, extensions: number[]) {
  return {
    tls_record_version: 769,
    tls_handshake_version: 771,
    cipher_suites: [grease, 4865, 4866],
    compression_methods: [0],
    extensions,
    supported_groups: [grease, 4588, 29],
    ec_point_formats: [0],
    signature_algorithms: [2308, 1027, 2052],
    alpn: ["h2", "http/1.1"],
    compress_certificate: [2],
    record_size_limit: [],
    supported_versions: [grease, 772, 771],
    psk_key_exchange_modes: [1],
    key_share: [grease, 4588, 29],
    application_settings: null,
  };
}

const PEET = {
  http_version: "h2",
  tls: {
    tls_version_negotiated: "772",
    tls_version_record: "771",
    ja4: "t13d1516h2_example",
    ja4_r: "t13d1516h2_raw",
  },
  http2: {
    akamai_fingerprint: "1:65536;2:0|15663105|0|m,a,s,p",
    sent_frames: [
      { frame_type: "SETTINGS", settings: ["HEADER_TABLE_SIZE = 65536", "ENABLE_PUSH = 0"] },
      { frame_type: "WINDOW_UPDATE", increment: 15663105 },
      {
        frame_type: "HEADERS",
        headers: [":method: GET", ":authority: example.test", ":scheme: https", ":path: /", "user-agent: A"],
        flags: ["EndStream (0x1)", "EndHeaders (0x4)"],
        priority: { weight: 256, depends_on: 0, exclusive: 1 },
      },
    ],
  },
};

describe("network fingerprint corpus", () => {
  it("recognizes and normalizes every RFC 8701 GREASE code point", () => {
    for (const value of [0x0a0a, 0x1a1a, 0x7a7a, 0xfafa]) expect(isTlsGrease(value)).toBe(true);
    for (const value of [0, 29, 4588, 65037, 65281]) expect(isTlsGrease(value)).toBe(false);
  });

  it("removes Chrome extension permutation and GREASE choice without dropping multiplicity", () => {
    const first = canonicalizeClientHello(clientHello(0x0a0a, [0x0a0a, 13, 0, 43, 0x0a0a]));
    const second = canonicalizeClientHello(clientHello(0x7a7a, [0x7a7a, 43, 13, 0, 0x7a7a]));
    expect(second).toEqual(first);
    expect(first.extensionMultiset.filter((value) => value === "GREASE")).toHaveLength(2);
  });

  it("keeps TLS and HTTP/2 capability/order identity stable across dynamic values", () => {
    const first = canonicalizeTlsAndHttp2(
      PEET,
      clientHello(0x0a0a, [0x0a0a, 13, 0, 43, 0x0a0a]),
      "h2",
    );
    const second = canonicalizeTlsAndHttp2(
      PEET,
      clientHello(0x9a9a, [0x9a9a, 43, 0, 13, 0x9a9a]),
      "h2",
    );
    expect(second).toEqual(first);
    expect(first.http2.headerOrder).toEqual([":method", ":authority", ":scheme", ":path", "user-agent"]);
    expect(networkFingerprintHash(second)).toBe(networkFingerprintHash(first));
  });

  it("uses normalized QUIC IDs and transport parameters instead of randomized frame order", () => {
    const response = (frames: number[], extensions: number[]) => ({
      hex_id: "top-id",
      ClientInitials: {
        hex_id: "initial-id",
        packets: [{
          header: { version: [0, 0, 0, 1], dest_conn_id_len: 8, packet_number: [1] },
          frames,
        }],
        client_hello: {
          ...clientHello(0x0a0a, extensions),
          norm_hex_id: "hello-id",
        },
        transport_parameters: {
          hex_id: "transport-id",
          num_id: 123,
          tpids: [1, 3, 4, 27],
          initial_max_data: [0, 240, 0, 0],
        },
      },
    });
    const first = canonicalizeHttp3(response([0, 6, 1], [0x0a0a, 13, 0, 43, 0x0a0a]), "h3");
    const second = canonicalizeHttp3(response([6, 6, 0, 1], [0x0a0a, 43, 13, 0, 0x0a0a]), "h3");
    expect(second).toEqual(first);
    expect(first.transportParameters).not.toHaveProperty("num_id");
    expect(first.transportParameters).not.toHaveProperty("hex_id");
  });

  it("reports exact nested drift paths", () => {
    expect(diffNetworkFingerprint(
      { tls: { ja4: "a" }, http3: { transport: "x" } },
      { tls: { ja4: "b" }, http3: { transport: "x" } },
    )).toEqual(["tls.ja4"]);
  });
});
