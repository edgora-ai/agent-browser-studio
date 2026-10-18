// ── In-browser WebRTC diagnostics (RoxyBrowser 3.9.2 "WebRTC logs /
// performance diagnostics" parity) ──
// Runs a real RTCPeerConnection probe inside the profile's own managed
// browser via CDP (Chromium) or WebDriver BiDi (Firefox), and reports what ICE
// candidates expose (mDNS hostnames vs raw host IPs), connection state and
// RTT. This verifies the engine's WebRTC hiding from the actual browser
// surface, not from a curl proxy test.

import { isIP } from "node:net";
import { statusBrowser } from "./browser-manager.js";
import { getWebRtcDiagnostics, setWebRtcDiagnostics } from "./config-manager.js";
import { recordAudit } from "./audit-log.js";
import { tMain } from "./main-i18n.js";
import { evaluateInPage, getProfileEngineByDirId } from "./page-eval.js";
import { beginProfileHealthRun, clearProfileHealthHistory, ProfileHealthError, profileHealthFailure } from "./profile-health.js";
import type { ProfileHealthOptions, ProfileHealthRun } from "./profile-health.js";
import type { ProfileHealthOutcome, WebRtcDiagnosticsEntry } from "../types.js";

/** Probe injected via CDP Runtime.evaluate (awaitPromise). Plain ES5-ish. */
const PROBE_JS = `(async () => {
  var out = {
    rtcAvailable: typeof window.RTCPeerConnection === "function",
    candidates: [],
    mdnsHosts: [],
    hostIps: [],
    srflxIps: [],
    connectionState: "new",
    gatheringState: "new",
    rttMs: null,
    error: null
  };
  if (!out.rtcAvailable) { return out; }
  return await new Promise(function (resolve) {
    var settled = false;
    var pc = null;
    var timer = null;
    var statsTimer = null;
    function merge(base, extra) {
      var m = {};
      for (var k in base) { m[k] = base[k]; }
      if (extra) { for (var k2 in extra) { m[k2] = extra[k2]; } }
      return m;
    }
    function finish(extra) {
      if (settled) { return; }
      settled = true;
      if (timer) { clearTimeout(timer); }
      if (statsTimer) { clearTimeout(statsTimer); }
      try { if (pc) { pc.close(); } } catch (e) { out.error = "close failed: " + e.message; }
      resolve(merge(out, extra));
    }
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] });
    } catch (e) {
      resolve(merge(out, { error: "create failed: " + e.message }));
      return;
    }
    timer = setTimeout(function () { finish({ error: "timeout" }); }, 9000);
    pc.onicecandidate = function (ev) {
      if (!ev.candidate) { finish({ gatheringState: "complete" }); return; }
      var cand = ev.candidate.candidate || "";
      if (!cand) { return; } // Empty generation markers are not candidate evidence.
      out.candidates.push(cand);
      var t = cand.split(" ");
      var typIdx = t.indexOf("typ");
      var type = (typIdx >= 0 && t[typIdx + 1]) ? t[typIdx + 1] : "";
      var addr = t[4] || "";
      if (type === "host") {
        if (addr.indexOf(".local") !== -1) { if (out.mdnsHosts.indexOf(addr) === -1) out.mdnsHosts.push(addr); }
        else if (out.hostIps.indexOf(addr) === -1) out.hostIps.push(addr);
      } else if (type === "srflx") {
        if (out.srflxIps.indexOf(addr) === -1) out.srflxIps.push(addr);
      }
    };
    pc.onconnectionstatechange = function () { out.connectionState = pc.connectionState; };
    try { pc.createDataChannel("probe"); } catch (e) { finish({ error: "data channel failed: " + e.message }); return; }
    pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); })
      .catch(function (e) { finish({ error: "offer failed: " + e.message }); });
    statsTimer = setTimeout(function () {
      if (!pc) { return; }
      pc.getStats().then(function (stats) {
        stats.forEach(function (s) {
          if (s.type === "candidate-pair" && s.state === "succeeded" && typeof s.currentRoundTripTime === "number") {
            out.rttMs = Math.round(s.currentRoundTripTime * 1000);
          }
        });
      }).catch(function () { out.rttMs = null; });
    }, 2500);
  });
})()`;

// R146: this summary is rendered verbatim in the WebRTC diagnostics panel, so
// hardcoded Chinese showed up in the English UI. It goes through tMain now,
// like the proxy suggestions. The ⚠️/✅ prefixes are dropped: the panel already
// paints a RISK/PASS badge and tints the leak row red, so the glyphs restated
// the same verdict and the emoji set was retired from this UI in R127.
function summarizeRaw(res: any): string {
  if (!res) return tMain("webrtc.sum.no-result", "No result from the probe");
  if (res.error) {
    return tMain("webrtc.sum.error", "Probe error: ") + String(res.error);
  }
  if (res.rtcAvailable === false) {
    return tMain("webrtc.sum.unavailable", "WebRTC unavailable (disabled or removed by fingerprint policy)");
  }
  const outcome = webRtcHealthOutcome(res);
  if (outcome === "error") return tMain("webrtc.sum.error", "Probe error: ") + "Invalid or missing WebRTC probe result";
  if (outcome === "inconclusive") {
    return tMain("webrtc.sum.inconclusive", "The probe did not complete with usable ICE evidence");
  }
  const hostIps: string[] = Array.isArray(res.hostIps) ? res.hostIps : [];
  const mdns: string[] = Array.isArray(res.mdnsHosts) ? res.mdnsHosts : [];
  if (hostIps.length) return tMain("webrtc.sum.host-ip", "Local IP exposed: ") + hostIps.join(", ");
  if (mdns.length) return tMain("webrtc.sum.mdns-only", "Only mDNS hostnames exposed — no local IP leak");
  return tMain("webrtc.sum.clean", "No local IP leak detected");
}

export interface WebRtcDiagRunResult {
  ok: boolean;
  outcome: ProfileHealthOutcome;
  requestId?: string;
  error?: string;
  warnings?: string[];
  /** Machine-readable failure reason; "PROFILE_NOT_RUNNING" asks the UI to confirm a launch. */
  code?: string;
  result?: WebRtcDiagnosticsEntry;
}

function stringList(value: unknown, limit = 64): string[] {
  return Array.isArray(value) ? value.slice(0, limit).filter((entry) => typeof entry === "string").map((entry) => entry.slice(0, 2048)) : [];
}

function isMdnsHost(address: string): boolean {
  return address.length <= 253 && /\.local\.?$/i.test(address)
    && address.replace(/\.$/, "").split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function candidateEvidence(raw: any): { hostIps: string[]; mdnsHosts: string[]; srflxIps: string[]; usable: boolean } | null {
  for (const key of ["candidates", "mdnsHosts", "hostIps", "srflxIps"]) {
    if (!Array.isArray(raw[key]) || raw[key].length > 64 || raw[key].some((value: unknown) => typeof value !== "string" || value.length > 2048 || /[\r\n\x00]/.test(value))) return null;
  }
  if (raw.hostIps.some((address: string) => !isIP(address)) || raw.srflxIps.some((address: string) => !isIP(address))
    || raw.mdnsHosts.some((address: string) => !isMdnsHost(address))) return null;
  const specified = (address: string) => address !== "0.0.0.0" && address !== "::";
  const hostIps = new Set<string>(raw.hostIps.filter(specified));
  const mdnsHosts = new Set<string>(raw.mdnsHosts);
  const srflxIps = new Set<string>(raw.srflxIps.filter(specified));
  let usable = false;
  for (const candidate of raw.candidates as string[]) {
    const fields = candidate.trim().split(/\s+/);
    const [foundation, component, protocol, priority, address, port, marker, type] = fields;
    const uint = (value: string | undefined, maximum: number, minimum = 1) => value !== undefined && /^\d+$/.test(value)
      && Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
    if (!/^candidate:[a-z0-9+/]{1,32}$/i.test(foundation) || !uint(component, 256) || !/^(?:udp|tcp)$/i.test(protocol)
      || !uint(priority, 0xffffffff) || !(isIP(address || "") || isMdnsHost(address || "")) || !uint(port, 65535)
      || marker !== "typ" || !["host", "srflx", "prflx", "relay"].includes(type) || fields.length % 2 !== 0) return null;
    if (type !== "host" && !isIP(address)) return null;
    for (let i = 8; i < fields.length; i += 2) {
      if (fields[i] === "raddr") {
        const related = fields[i + 1];
        if (!(isIP(related) || isMdnsHost(related))) return null;
        if (related !== "0.0.0.0" && related !== "::") {
          if (isMdnsHost(related)) mdnsHosts.add(related);
          else hostIps.add(related);
        }
      }
      if (fields[i] === "rport" && !uint(fields[i + 1], 65535, 0)) return null;
      if (fields[i] === "tcptype" && (!/^tcp$/i.test(protocol) || !["active", "passive", "so"].includes(fields[i + 1]))) return null;
    }
    if (/^tcp$/i.test(protocol) && !fields.slice(8).some((field, i) => i % 2 === 0 && field === "tcptype")) return null;
    if (address === "0.0.0.0" || address === "::") continue;
    usable = true;
    if (type === "host") {
      if (isMdnsHost(address)) mdnsHosts.add(address);
      else hostIps.add(address);
    } else if (type === "srflx") srflxIps.add(address);
  }
  return { hostIps: [...hostIps], mdnsHosts: [...mdnsHosts], srflxIps: [...srflxIps], usable };
}

export function webRtcHealthOutcome(raw: any): ProfileHealthOutcome {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.rtcAvailable !== "boolean") return "error";
  if (raw.error) return "error";
  if (raw.rtcAvailable === false) return "unavailable";
  const evidence = candidateEvidence(raw);
  if (!evidence) return "error";
  if (evidence.hostIps.length) return "risk";
  if (raw.gatheringState !== "complete" || !evidence.usable) return "inconclusive";
  return "pass";
}

function webRtcEntry(raw: any, requestId: string): WebRtcDiagnosticsEntry {
  const outcome = webRtcHealthOutcome(raw);
  const evidence = raw?.rtcAvailable === true ? candidateEvidence(raw) : null;
  const normalized = evidence ? { ...raw, ...evidence } : raw;
  return {
    at: Date.now(), requestId, outcome,
    success: outcome === "pass" || outcome === "risk",
    rtcAvailable: raw?.rtcAvailable === true,
    candidates: stringList(raw?.candidates), mdnsHosts: stringList(normalized?.mdnsHosts),
    hostIps: stringList(normalized?.hostIps), srflxIps: stringList(normalized?.srflxIps),
    gatheringState: typeof raw?.gatheringState === "string" ? raw.gatheringState.slice(0, 40) : "unknown",
    connectionState: typeof raw?.connectionState === "string" ? raw.connectionState.slice(0, 40) : "unknown",
    rttMs: typeof raw?.rttMs === "number" && Number.isFinite(raw.rttMs) && raw.rttMs >= 0 ? raw.rttMs : null,
    error: raw?.error ? String(raw.error).slice(0, 1024) : outcome === "error" ? "Invalid or missing WebRTC probe result" : null,
    summary: summarizeRaw(normalized).slice(0, 2048),
  };
}

function persistWebRtcEntry(dirId: string, entry: WebRtcDiagnosticsEntry): void {
  setWebRtcDiagnostics(dirId, [...getWebRtcDiagnostics(dirId), entry], {
    kind: "webrtc", at: entry.at, outcome: entry.outcome!, summary: entry.summary,
    requestId: entry.requestId, source: "runtime",
  });
}

/**
 * Run a real in-browser WebRTC probe for a profile and persist one history
 * entry. Mirrors open-risk-check's launch/CDP flow.
 *
 * Review item PL-03: launching a stopped profile used to be implicit. It now
 * requires `allowLaunch`, which the UI only passes after the user confirms.
 */
export async function runWebRtcDiagnostics(dirId: string, opts: ProfileHealthOptions & { allowLaunch?: boolean } = {}): Promise<WebRtcDiagRunResult> {
  let run: ProfileHealthRun | undefined;
  try {
    run = beginProfileHealthRun(dirId, "webrtc", opts);
    run.assertCurrent();
    const status = statusBrowser(dirId);
    if (!status.running || !status.cdpPort) {
      // Launch is admitted by the public entry point's normal permission and
      // license gates. A diagnostics helper must never bypass them itself.
      throw new ProfileHealthError("PROFILE_NOT_RUNNING", "The profile is not running. This diagnostic needs a running browser.", "unavailable");
    }
    const engine = getProfileEngineByDirId(dirId);
    let raw: any;
    try {
      raw = await evaluateInPage(status.cdpPort, engine, PROBE_JS, { timeoutMs: 15000, signal: run.signal });
    } catch (error) {
      run.assertCurrent();
      raw = { rtcAvailable: false, error: error instanceof Error ? error.message : String(error) };
    }
    run.assertCurrent();
    // Unavailable is an observation, not permission to navigate away from the
    // user's current page or to call an empty candidate list a clean result.
    const entry = webRtcEntry(raw, run.requestId);
    persistWebRtcEntry(dirId, entry);
    const warnings: string[] = [];
    try {
      recordAudit({ category: "profile", action: "webrtc-diagnostic", target: dirId, actor: "user", detail: entry.summary });
    } catch (error) {
      warnings.push("The diagnostic was saved, but its audit entry could not be written");
      console.error("[webrtc-diagnostic] post-commit audit failed:", error);
    }
    const outcome = entry.outcome!;
    return { ok: entry.success, outcome, requestId: run.requestId, result: entry,
      ...(entry.error ? { code: "WEBRTC_PROBE_FAILED", error: entry.error } : {}),
      ...(warnings.length ? { warnings } : {}) };
  } catch (error) {
    let failure = error;
    if (run) {
      try { run.assertCurrent(); } catch (current) { failure = current; }
    }
    return profileHealthFailure(failure, run?.requestId ?? opts?.requestId);
  } finally {
    run?.finish();
  }
}

export function listWebRtcDiagnostics(dirId: string): WebRtcDiagnosticsEntry[] {
  return getWebRtcDiagnostics(dirId);
}

export function clearWebRtcDiagnostics(dirId: string): void {
  clearProfileHealthHistory(dirId, "webrtc");
}
