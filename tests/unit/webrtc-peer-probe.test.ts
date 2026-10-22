import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { buildWebRtcPeerProbe, normalizeWebRtcPeerConnectivity, unmeasuredWebRtcPeerConnectivity } from "../../src/main/services/webrtc-peer-probe.js";

const pair = () => ({ protocol: "udp", localType: "relay", remoteType: "relay", relayProtocol: "tcp", bytesSent: 300, bytesReceived: 300 });
const connected = () => ({ status: "connected", scope: "two-peer-data-channel", relayOnly: true,
  sentBytes: 100, receivedBytes: 100, sentMessages: 2, receivedMessages: 2, selectedPairs: [pair(), pair()], code: null });
const relay = () => ({ iceServers: [{ urls: ["turn:127.0.0.1:12345?transport=tcp"], username: "synthetic-probe", credential: "synthetic-password" }], relayOnly: true });
afterEach(() => vi.useRealTimers());

describe("two-peer measurement is distinct from ICE/IP presentation", () => {
  it("keeps an unperformed measurement explicitly untested", () => {
    expect(unmeasuredWebRtcPeerConnectivity()).toMatchObject({ status: "not-tested", selectedPairs: [], sentBytes: 0, receivedBytes: 0 });
    expect(normalizeWebRtcPeerConnectivity({ status: "not-tested", sentBytes: 123, selectedPairs: [pair()] })).toEqual(unmeasuredWebRtcPeerConnectivity());
  });
  it("preserves TURN/TCP separately from the UDP relay candidate protocol", () => {
    expect(normalizeWebRtcPeerConnectivity(connected())).toMatchObject({ status: "connected", selectedPairs: [{ protocol: "udp", relayProtocol: "tcp" }, { protocol: "udp", relayProtocol: "tcp" }] });
  });
  it.each([
    { selectedPairs: [] }, { sentBytes: 0, receivedBytes: 0 }, { sentMessages: 1 }, { receivedMessages: 1 },
    { receivedBytes: 99 }, { selectedPairs: [{ ...pair(), bytesReceived: 0 }, pair()] },
    { selectedPairs: [{ ...pair(), localType: "host" }, pair()] },
    { selectedPairs: [{ ...pair(), protocol: "quic" }, pair()] }, { code: "RTC_PEER_TIMEOUT" },
  ])("does not upgrade incomplete evidence into a connection: %j", change => {
    expect(normalizeWebRtcPeerConnectivity({ ...connected(), ...change })).toMatchObject({ status: "failed", code: "RTC_INVALID_PEER_RESULT" });
  });
  it("drops SDP, addresses, credentials and arbitrary page error text", () => {
    const raw = { ...connected(), sdp: "PRIVATE-SDP", password: "PRIVATE-PASSWORD", error: "PRIVATE-ERROR",
      selectedPairs: [{ ...pair(), address: "203.0.113.10", username: "PRIVATE-USERNAME" }, pair()] };
    const normalized = normalizeWebRtcPeerConnectivity(raw);
    expect(normalized.status).toBe("connected");
    expect(JSON.stringify(normalized)).not.toMatch(/PRIVATE|203\.0\.113\.10|address|password|sdp/);
    expect(normalizeWebRtcPeerConnectivity({ ...raw, code: "PRIVATE-ERROR" }).code).toBe("RTC_INVALID_PEER_RESULT");
  });
  it("does not manufacture network activity for an unavailable API", async () => {
    const timer = vi.fn();
    const result = await runInNewContext(buildWebRtcPeerProbe({ iceServers: [] }), { setTimeout: timer });
    expect(normalizeWebRtcPeerConnectivity(result)).toMatchObject({ status: "unavailable", code: "RTC_UNAVAILABLE", sentBytes: 0, receivedBytes: 0 });
    expect(timer).not.toHaveBeenCalled();
  });
  it("closes both peers on deadline without reporting an open channel as success", async () => {
    vi.useFakeTimers();
    const peers: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    class PendingPeer {
      close = vi.fn(); connectionState = "new";
      constructor() { peers.push(this); }
      createDataChannel() { return { readyState: "connecting", close: vi.fn() }; }
      createOffer() { return new Promise(() => undefined); }
    }
    const pending = runInNewContext(buildWebRtcPeerProbe({ iceServers: [], timeoutMs: 500 }), {
      RTCPeerConnection: PendingPeer, performance: { now: () => Date.now() }, setTimeout, clearTimeout,
    });
    await vi.advanceTimersByTimeAsync(501);
    expect(normalizeWebRtcPeerConnectivity(await pending)).toMatchObject({ status: "failed", code: "RTC_PEER_TIMEOUT", receivedMessages: 0 });
    expect(peers).toHaveLength(2);
    expect(peers.every(pc => pc.close.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { iceServers: [{ urls: ["https://not-an-ice-endpoint.invalid"] }] },
    { iceServers: [{ urls: ["turn:127.0.0.1:12345\r\nSECRET"] }] },
    { iceServers: [], relayOnly: true }, { iceServers: [], timeoutMs: 0 }, { iceServers: [], timeoutMs: 10001 },
    { iceServers: [{ urls: ["turn:127.0.0.1:12345"], credential: "secret\nvalue" }] },
  ])("rejects invalid main-owned probe input with a static error", options => {
    expect(() => buildWebRtcPeerProbe(options as any)).toThrow("RTC_INVALID_PROBE_OPTIONS");
  });
  it("generates fresh independent challenges without embedding addresses in the result schema", () => {
    const a = buildWebRtcPeerProbe(relay()), b = buildWebRtcPeerProbe(relay());
    expect(a).not.toBe(b);
    expect(a).toContain('a.getStats(), b.getStats()');
    expect(a).toContain('dc.send(sending)');
    expect(a).not.toContain('out.sdp');
    expect(a).not.toContain('out.address');
  });
});
