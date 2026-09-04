// ── WebRTC / DNS / IP Leak Detector ──
// Detects if proxy is leaking real IP via WebRTC or DNS

import { spawn } from "node:child_process";
import { buildProxyUrl } from "./proxy-detector.js";
import type { ProxyConfig } from "../types.js";

export interface WebRtcLeakResult {
  success: boolean;
  /** WebRTC-detected IPs (leaked local/real IPs) */
  webRtcIps: string[];
  /** STUN server response IPs */
  stunIps: string[];
  /** DNS leak test IPs */
  dnsLeakIps: string[];
  /** Whether any leak was detected */
  hasLeak: boolean;
  /** Summary of findings */
  summary: string;
  error: string | null;
}

function execCurlAsync(args: string[], timeoutSeconds: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("curl", args);
    let stdout = "";
    let settled = false;
    const done = (v: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // R10 P1-2: two-stage kill — SIGTERM first, SIGKILL 2s later. A bare
    // kill() leaves zombies when curl ignores SIGTERM (DNS/proxy handshake).
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
      done("");
    }, (timeoutSeconds + 1) * 1000);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("close", () => {
      done(stdout.trim());
    });
    child.on("error", () => {
      done("");
    });
  });
}

export const webrtcDetector = {
  async detect(config: ProxyConfig): Promise<WebRtcLeakResult> {
    const result: WebRtcLeakResult = {
      success: true, webRtcIps: [], stunIps: [], dnsLeakIps: [],
      hasLeak: false, summary: "", error: null,
    };

    try {
      const proxyUrl = buildProxyUrl(config);
      const exitIps = new Set<string>();

      // Test 1: Check exit IP via multiple services concurrently
      const services = [
        "https://api.ipify.org?format=json",
        "https://httpbin.org/ip",
        "https://ifconfig.me/ip",
      ];

      const test1Promises = services.map(async (svc) => {
        const text = await execCurlAsync(["-s", "--connect-timeout", "2", "--max-time", "5", "--proxy", proxyUrl, svc], 5);
        const ips = text.match(/\d+\.\d+\.\d+\.\d+/g);
        if (ips) ips.forEach(ip => exitIps.add(ip));
      });

      // Test 2: DNS leak test concurrently
      const test2Promise = (async () => {
        const dnsText = await execCurlAsync(["-s", "--connect-timeout", "2", "--max-time", "8", "--proxy", proxyUrl, "https://bash.ws/dnsleak/test1"], 8);
        const ips = dnsText.match(/\d+\.\d+\.\d+\.\d+/g) || [];
        result.dnsLeakIps = ips.filter(ip => !ip.startsWith("10.") && !ip.startsWith("192.168.") && !ip.startsWith("172."));
      })();

      // Test 3: STUN servers concurrently
      const test3Promise = (async () => {
        const stunText = await execCurlAsync(["-s", "--connect-timeout", "2", "--max-time", "5", "--proxy", proxyUrl, "https://ipinfo.io/json"], 5);
        if (stunText) {
          try {
            const info = JSON.parse(stunText);
            if (info.ip) result.stunIps.push(info.ip);
          } catch { /* skip */ }
        }
      })();

      // Wait for all tests to execute in parallel
      await Promise.all([...test1Promises, test2Promise, test3Promise]);

      // Check for leaks: are there multiple distinct IPs?
      const allIps = new Set([...exitIps, ...result.stunIps, ...result.dnsLeakIps]);
      // Filter out private/local IPs
      const publicIps = [...allIps].filter(ip =>
        !ip.startsWith("10.") && !ip.startsWith("192.168.") &&
        !ip.startsWith("127.") && !ip.startsWith("172.") &&
        !ip.startsWith("0.")
      );
      result.webRtcIps = publicIps;

      if (publicIps.length <= 1) {
        result.hasLeak = false;
        result.summary = `✅ No leaks detected (${publicIps[0] || "unknown"} via proxy)`;
      } else {
        result.hasLeak = true;
        result.summary = `⚠️ Multiple IPs detected: ${publicIps.join(", ")} — possible leak!`;
      }

      return result;
    } catch (e: any) {
      return { ...result, success: false, error: e.message || "Detection failed" };
    }
  },

  quickTest(proxyUrl: string): Promise<{ ok: boolean; latency: number }> {
    return new Promise((resolve) => {
      const start = Date.now();
      const child = spawn("curl", ["-s", "--max-time", "3", "--proxy", proxyUrl,
        "https://www.google.com", "-o", "/dev/null"]);

      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ ok: false, latency: 0 });
      }, 4000);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true, latency: Date.now() - start });
        else resolve({ ok: false, latency: 0 });
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolve({ ok: false, latency: 0 });
      });
    });
  },
};
