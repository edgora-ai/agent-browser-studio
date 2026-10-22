import { randomBytes } from "node:crypto";
import type { WebRtcPeerConnectivityEvidence, WebRtcSelectedPairEvidence } from "../types.js";

export interface WebRtcPeerProbeOptions {
  /** Main-owned probe destinations, never accepted from the diagnostics IPC. */
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  relayOnly?: boolean;
  timeoutMs?: number;
}

const TYPES = new Set(["host", "srflx", "prflx", "relay"]);
const CODES = new Set(["RTC_UNAVAILABLE", "RTC_PEER_TIMEOUT", "RTC_PEER_FAILED", "RTC_PEER_SETUP_FAILED", "RTC_PAYLOAD_MISMATCH", "RTC_SELECTED_PAIR_UNVERIFIED", "RTC_RELAY_REQUIRED", "RTC_STATS_FAILED", "RTC_CLEANUP_FAILED", "RTC_INVALID_PEER_RESULT"]);
const count = (value: unknown, max = 1024 * 1024): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;

export function unmeasuredWebRtcPeerConnectivity(): WebRtcPeerConnectivityEvidence {
  return { status: "not-tested", scope: "not-tested", relayOnly: false, sentBytes: 0, receivedBytes: 0,
    sentMessages: 0, receivedMessages: 0, selectedPairs: [], code: null };
}

/** Project only measured counts/types. Never retain SDP, addresses or TURN credentials. */
export function normalizeWebRtcPeerConnectivity(raw: unknown): WebRtcPeerConnectivityEvidence {
  const failure = (): WebRtcPeerConnectivityEvidence => ({ ...unmeasuredWebRtcPeerConnectivity(), status: "failed", scope: "two-peer-data-channel", code: "RTC_INVALID_PEER_RESULT" });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure();
  const r = raw as Record<string, unknown>;
  if (r.status === "not-tested") return unmeasuredWebRtcPeerConnectivity();
  if (!["connected", "failed", "unavailable"].includes(String(r.status)) || r.scope !== "two-peer-data-channel" || typeof r.relayOnly !== "boolean"
    || !count(r.sentBytes) || !count(r.receivedBytes) || !count(r.sentMessages, 2) || !count(r.receivedMessages, 2)
    || !Array.isArray(r.selectedPairs) || r.selectedPairs.length > 2 || r.code !== null && (typeof r.code !== "string" || !CODES.has(r.code))) return failure();
  const pairs: WebRtcSelectedPairEvidence[] = [];
  for (const pair of r.selectedPairs) {
    if (!pair || typeof pair !== "object" || Array.isArray(pair) || !["udp", "tcp"].includes(pair.protocol)
      || !TYPES.has(pair.localType) || !TYPES.has(pair.remoteType) || ![null, "udp", "tcp", "tls"].includes(pair.relayProtocol)
      || !count(pair.bytesSent, Number.MAX_SAFE_INTEGER) || !count(pair.bytesReceived, Number.MAX_SAFE_INTEGER)) return failure();
    pairs.push({ protocol: pair.protocol, localType: pair.localType, remoteType: pair.remoteType,
      relayProtocol: pair.relayProtocol, bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived });
  }
  if (r.status === "connected" && (r.code !== null || pairs.length !== 2 || r.sentMessages !== 2 || r.receivedMessages !== 2
    || r.sentBytes < 1 || r.sentBytes !== r.receivedBytes || pairs.some(p => p.bytesSent < 1 || p.bytesReceived < 1)
    || r.relayOnly && pairs.some(p => p.localType !== "relay" || p.remoteType !== "relay"))) return failure();
  return { status: r.status as WebRtcPeerConnectivityEvidence["status"], scope: "two-peer-data-channel", relayOnly: r.relayOnly,
    sentBytes: r.sentBytes, receivedBytes: r.receivedBytes, sentMessages: r.sentMessages, receivedMessages: r.receivedMessages,
    selectedPairs: pairs, code: r.code as string | null };
}

/** Two real peers exchange independent challenges. A selected relay is not, by
 * itself, evidence that the browser-to-TURN leg used an HTTP/SOCKS proxy. The
 * acceptance caller must corroborate that leg at its owned proxy and relay. */
export function buildWebRtcPeerProbe(options: WebRtcPeerProbeOptions): string {
  if (!options || !Array.isArray(options.iceServers) || options.iceServers.length > 8
    || options.relayOnly !== undefined && typeof options.relayOnly !== "boolean") throw new Error("RTC_INVALID_PROBE_OPTIONS");
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error("RTC_INVALID_PROBE_OPTIONS");
  let urlCount = 0;
  const servers = options.iceServers.map(server => {
    if (!server || !Array.isArray(server.urls) || !server.urls.length || server.urls.length > 4
      || server.urls.some(url => typeof url !== "string" || url.length > 1024 || !/^(?:stun|stuns|turn|turns):(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(url))
      || [server.username, server.credential].some(value => value !== undefined && (typeof value !== "string" || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)))) throw new Error("RTC_INVALID_PROBE_OPTIONS");
    urlCount += server.urls.length;
    return { urls: [...server.urls], ...(server.username === undefined ? {} : { username: server.username }), ...(server.credential === undefined ? {} : { credential: server.credential }) };
  });
  if (urlCount > 16 || options.relayOnly === true && !servers.some(s => s.urls.some(url => /^turns?:/i.test(url)))) throw new Error("RTC_INVALID_PROBE_OPTIONS");
  const input = { iceServers: servers, relayOnly: options.relayOnly === true, timeoutMs, challenge: randomBytes(24).toString("hex") };
  return `(async () => {
    var input = ${JSON.stringify(input)};
    var out = { status: "failed", scope: "two-peer-data-channel", relayOnly: input.relayOnly,
      sentBytes: 0, receivedBytes: 0, sentMessages: 0, receivedMessages: 0, selectedPairs: [], code: null };
    if (typeof RTCPeerConnection !== "function") { out.status = "unavailable"; out.code = "RTC_UNAVAILABLE"; return out; }
    return await new Promise(function(resolve) {
      var ended = false, collecting = false, a = null, b = null, channelA = null, channelB = null;
      var started = performance.now(), timer = null, gatherStops = [];
      var payloadA = "a:" + input.challenge, payloadB = "b:" + input.challenge;
      function current() { return !ended && performance.now() - started < input.timeoutMs; }
      function finish(code) {
        if (ended) return;
        ended = true;
        if (timer) clearTimeout(timer);
        gatherStops.slice().forEach(function(stop) { stop(); });
        out.code = code;
        out.status = code ? "failed" : "connected";
        var cleanupFailed = false;
        [channelA, channelB].forEach(function(dc) {
          if (!dc) return;
          dc.onopen = null; dc.onmessage = null; dc.onerror = null;
          try { dc.close(); } catch (error) { cleanupFailed = true; }
        });
        [a, b].forEach(function(pc) {
          if (!pc) return;
          pc.onconnectionstatechange = null; pc.ondatachannel = null; pc.onicegatheringstatechange = null;
          try { pc.close(); } catch (error) { cleanupFailed = true; }
        });
        if (cleanupFailed) { out.status = "failed"; out.code = "RTC_CLEANUP_FAILED"; }
        resolve(out);
      }
      function waitGather(pc) {
        if (!current()) return Promise.reject(new Error("RTC_PEER_TIMEOUT"));
        if (pc.iceGatheringState === "complete") return Promise.resolve();
        return new Promise(function(done, reject) {
          var settled = false;
          function complete(code) {
            if (settled) return;
            settled = true;
            pc.onicegatheringstatechange = null;
            pc.removeEventListener("connectionstatechange", closed);
            var index = gatherStops.indexOf(stop);
            if (index >= 0) gatherStops.splice(index, 1);
            if (code) reject(new Error(code)); else done();
          }
          function stop() { complete("RTC_PEER_TIMEOUT"); }
          function closed() { if (pc.connectionState === "closed") complete("RTC_PEER_FAILED"); }
          gatherStops.push(stop);
          pc.onicegatheringstatechange = function() {
            if (!current()) { complete("RTC_PEER_TIMEOUT"); return; }
            if (pc.iceGatheringState === "complete") complete(null);
          };
          pc.addEventListener("connectionstatechange", closed);
        });
      }
      function selectedPair(stats) {
        var ids = [], nominated = [];
        stats.forEach(function(row) {
          if (row.type === "transport" && row.selectedCandidatePairId) ids.push(row.selectedCandidatePairId);
          if (row.type === "candidate-pair" && row.state === "succeeded" && row.nominated) nominated.push(row);
        });
        var pair = ids.length === 1 ? stats.get(ids[0]) : ids.length === 0 && nominated.length === 1 ? nominated[0] : null;
        if (!pair || pair.state !== "succeeded") return null;
        var local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
        var types = ["host", "srflx", "prflx", "relay"];
        if (!local || !remote || ["udp", "tcp"].indexOf(local.protocol) < 0 || types.indexOf(local.candidateType) < 0
          || types.indexOf(remote.candidateType) < 0 || !Number.isSafeInteger(pair.bytesSent) || pair.bytesSent < 1
          || !Number.isSafeInteger(pair.bytesReceived) || pair.bytesReceived < 1) return null;
        return { protocol: local.protocol, localType: local.candidateType, remoteType: remote.candidateType,
          relayProtocol: ["udp", "tcp", "tls"].indexOf(local.relayProtocol) >= 0 ? local.relayProtocol : null,
          bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived };
      }
      function collect() {
        if (!current() || collecting || out.receivedMessages !== 2) return;
        collecting = true;
        Promise.all([a.getStats(), b.getStats()]).then(function(values) {
          if (!current()) { finish("RTC_PEER_TIMEOUT"); return; }
          var pairA = selectedPair(values[0]), pairB = selectedPair(values[1]);
          if (!pairA || !pairB) { finish("RTC_SELECTED_PAIR_UNVERIFIED"); return; }
          out.selectedPairs = [pairA, pairB];
          if (input.relayOnly && out.selectedPairs.some(function(p) { return p.localType !== "relay" || p.remoteType !== "relay"; })) {
            finish("RTC_RELAY_REQUIRED"); return;
          }
          finish(null);
        }, function() { finish("RTC_STATS_FAILED"); });
      }
      function wire(dc, sending, expected) {
        var sent = false, received = false;
        dc.binaryType = "arraybuffer";
        dc.onopen = function() {
          if (!current() || sent) return;
          sent = true;
          try { dc.send(sending); out.sentMessages++; out.sentBytes += sending.length; }
          catch (error) { finish("RTC_PEER_FAILED"); }
        };
        dc.onmessage = function(event) {
          if (!current()) return;
          if (received || event.data !== expected || out.receivedMessages >= 2) { finish("RTC_PAYLOAD_MISMATCH"); return; }
          received = true;
          out.receivedMessages++; out.receivedBytes += event.data.length; collect();
        };
        dc.onerror = function() { finish("RTC_PEER_FAILED"); };
        if (dc.readyState === "open") dc.onopen();
      }
      timer = setTimeout(function() { finish("RTC_PEER_TIMEOUT"); }, input.timeoutMs);
      try {
        var configuration = { iceServers: input.iceServers, iceTransportPolicy: input.relayOnly ? "relay" : "all" };
        a = new RTCPeerConnection(configuration); b = new RTCPeerConnection(configuration);
        a.onconnectionstatechange = b.onconnectionstatechange = function() {
          if (!ended && (a.connectionState === "failed" || b.connectionState === "failed")) finish("RTC_PEER_FAILED");
        };
        b.ondatachannel = function(event) { channelB = event.channel; wire(channelB, payloadB, payloadA); };
        channelA = a.createDataChannel("owned-connectivity-probe"); wire(channelA, payloadA, payloadB);
        (async function() {
          var offer = await a.createOffer(); if (!current()) return;
          await a.setLocalDescription(offer); if (!current()) return;
          await waitGather(a); if (!current()) return;
          await b.setRemoteDescription(a.localDescription); if (!current()) return;
          var answer = await b.createAnswer(); if (!current()) return;
          await b.setLocalDescription(answer); if (!current()) return;
          await waitGather(b); if (!current()) return;
          await a.setRemoteDescription(b.localDescription);
        })().catch(function() { finish("RTC_PEER_SETUP_FAILED"); });
      } catch (error) { finish("RTC_PEER_SETUP_FAILED"); }
    });
  })()`;
}
