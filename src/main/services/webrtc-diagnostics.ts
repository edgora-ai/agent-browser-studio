// ── In-browser WebRTC diagnostics (RoxyBrowser 3.9.2 "WebRTC logs /
// performance diagnostics" parity) ──
// Runs a real RTCPeerConnection probe inside the profile's own managed
// browser via CDP (Chromium) or WebDriver BiDi (Firefox), and reports what ICE
// candidates expose (mDNS hostnames vs raw host IPs), connection state and
// RTT. This verifies the engine's WebRTC hiding from the actual browser
// surface, not from a curl proxy test.

import { statusBrowser, launchBrowser } from "./browser-manager.js";
import { getWebRtcDiagnostics, setWebRtcDiagnostics } from "./config-manager.js";
import { clearWebRtcDiagnostics as clearStoredWebRtcDiagnostics } from "./config-manager.js";
import { recordAudit } from "./audit-log.js";
import { tMain } from "./main-i18n.js";
import { evaluateInPage, navigateInPage, getProfileEngineByDirId } from "./page-eval.js";
import type { WebRtcDiagnosticsEntry } from "../types.js";

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
      try { if (pc) { pc.close(); } } catch (e) {}
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
    try { pc.createDataChannel("probe"); } catch (e) {}
    pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); })
      .catch(function (e) { finish({ error: "offer failed: " + e.message }); });
    setTimeout(function () {
      if (!pc) { return; }
      pc.getStats().then(function (stats) {
        stats.forEach(function (s) {
          if (s.type === "candidate-pair" && s.state === "succeeded" && typeof s.currentRoundTripTime === "number") {
            out.rttMs = Math.round(s.currentRoundTripTime * 1000);
          }
        });
      }).catch(function () {});
    }, 2500);
  });
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// R146: this summary is rendered verbatim in the WebRTC diagnostics panel, so
// hardcoded Chinese showed up in the English UI. It goes through tMain now,
// like the proxy suggestions. The ⚠️/✅ prefixes are dropped: the panel already
// paints a RISK/PASS badge and tints the leak row red, so the glyphs restated
// the same verdict and the emoji set was retired from this UI in R127.
function summarizeRaw(res: any): string {
  if (!res) return tMain("webrtc.sum.no-result", "No result from the probe");
  if (res.rtcAvailable === false) {
    return tMain("webrtc.sum.unavailable", "WebRTC unavailable (disabled or removed by fingerprint policy)");
  }
  if (res.error) {
    return tMain("webrtc.sum.error", "Probe error: ") + String(res.error);
  }
  const hostIps: string[] = Array.isArray(res.hostIps) ? res.hostIps : [];
  const mdns: string[] = Array.isArray(res.mdnsHosts) ? res.mdnsHosts : [];
  if (hostIps.length) return tMain("webrtc.sum.host-ip", "Local IP exposed: ") + hostIps.join(", ");
  if (mdns.length) return tMain("webrtc.sum.mdns-only", "Only mDNS hostnames exposed — no local IP leak");
  return tMain("webrtc.sum.clean", "No local IP leak detected");
}

export interface WebRtcDiagRunResult {
  ok: boolean;
  error?: string;
  /** Machine-readable failure reason; "PROFILE_NOT_RUNNING" asks the UI to confirm a launch. */
  code?: string;
  result?: WebRtcDiagnosticsEntry;
}

/**
 * Run a real in-browser WebRTC probe for a profile and persist one history
 * entry. Mirrors open-risk-check's launch/CDP flow.
 *
 * Review item PL-03: launching a stopped profile used to be implicit. It now
 * requires `allowLaunch`, which the UI only passes after the user confirms.
 */
export async function runWebRtcDiagnostics(dirId: string, opts?: { allowLaunch?: boolean }): Promise<WebRtcDiagRunResult> {
  try {
    let status = statusBrowser(dirId);
    let cdpPort = status.cdpPort || 0;
    if (!status.running) {
      if (!opts?.allowLaunch) {
        return { ok: false, code: "PROFILE_NOT_RUNNING", error: "The profile is not running. This diagnostic needs a running browser." };
      }
      const launched = await launchBrowser(dirId);
      cdpPort = launched.cdpPort || 0;
      status = statusBrowser(dirId);
    }
    if (!cdpPort || !status.running) {
      return { ok: false, error: "Profile is not running and the debug port could not be obtained" };
    }
    const engine = getProfileEngineByDirId(dirId);
    try {
      let res: any = await evaluateInPage(cdpPort, engine, PROBE_JS, { timeoutMs: 15000 });
      // Privileged chrome:// (or otherwise locked) pages can hide WebRTC;
      // retry once on a plain page.
      if (res && res.rtcAvailable === false) {
        await navigateInPage(cdpPort, engine, "about:blank");
        await sleep(600);
        res = await evaluateInPage(cdpPort, engine, PROBE_JS, { timeoutMs: 15000 });
      }
      const entry: WebRtcDiagnosticsEntry = {
        at: Date.now(),
        success: Boolean(res),
        rtcAvailable: Boolean(res && res.rtcAvailable),
        candidates: Array.isArray(res?.candidates) ? res.candidates : [],
        mdnsHosts: Array.isArray(res?.mdnsHosts) ? res.mdnsHosts : [],
        hostIps: Array.isArray(res?.hostIps) ? res.hostIps : [],
        srflxIps: Array.isArray(res?.srflxIps) ? res.srflxIps : [],
        connectionState: String(res?.connectionState || "unknown"),
        rttMs: typeof res?.rttMs === "number" ? res.rttMs : null,
        error: res?.error ? String(res.error) : null,
        summary: summarizeRaw(res),
      };
      const history = getWebRtcDiagnostics(dirId);
      setWebRtcDiagnostics(dirId, [...history, entry]);
      recordAudit({ category: "profile", action: "webrtc-diagnostic", target: dirId, actor: "user", detail: entry.summary });
      return { ok: true, result: entry };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function listWebRtcDiagnostics(dirId: string): WebRtcDiagnosticsEntry[] {
  return getWebRtcDiagnostics(dirId);
}

export function clearWebRtcDiagnostics(dirId: string): void {
  clearStoredWebRtcDiagnostics(dirId);
}
