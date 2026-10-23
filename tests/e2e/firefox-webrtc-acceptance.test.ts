// Explicit opt-in. Real local Firefox, owned profile, owned loopback origins.
// No product launcher, real user data, network dependency or fake BiDi.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { buildFirefoxLaunchArgs } from "../../src/main/services/browser-engine.js";
import { buildFirefoxManagedIdentity } from "../../src/main/services/firefox-fingerprint.js";
import { writeFirefoxUserJs } from "../../src/main/services/firefox-prefs.js";
import { connectBidi, bidiEvaluateInContext, bidiNavigate, type BidiConnection } from "../../src/main/services/bidi-client.js";
import { buildWebRtcPeerProbe, normalizeWebRtcPeerConnectivity } from "../../src/main/services/webrtc-peer-probe.js";
import { startProxyTransportFixture, type ProxyTransportFixture } from "./helpers/proxy-transport-fixture.js";

const optedIn = process.env.ABS_FIREFOX_WEBRTC_ACCEPTANCE === "1";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fileSha(file: string): string { return sha(fs.readFileSync(file)); }
function ownedDirectory(input: string | undefined): string {
  if (!input || !path.isAbsolute(input)) throw new Error("OWNED_EVIDENCE_DIRECTORY_REQUIRED");
  const stat = fs.lstatSync(input);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("OWNED_EVIDENCE_DIRECTORY_REQUIRED");
  for (let at = input; ; at = path.dirname(at)) {
    const ancestor = fs.lstatSync(at);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw new Error("OWNED_EVIDENCE_ANCESTOR_REQUIRED");
    if (path.dirname(at) === at) break;
  }
  if (fs.realpathSync(input) !== input) throw new Error("OWNED_EVIDENCE_DIRECTORY_REQUIRED");
  return input;
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
async function waitBidi(port: number, deadlineMs = 60_000): Promise<BidiConnection> {
  const deadline = Date.now() + deadlineMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { return await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 3000 }); }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 400)); }
  }
  throw new Error(`OWNED_FIREFOX_BIDI_TIMEOUT: ${String(last)}`);
}

interface CaseSpec { name: string; proxy: boolean; mode: "auto" | "real" | "disable"; }
const CASES: readonly CaseSpec[] = [
  { name: "proxy-auto", proxy: true, mode: "auto" },
  { name: "direct-real", proxy: false, mode: "real" },
  { name: "proxy-real-socks", proxy: true, mode: "real" },
  { name: "proxy-disable", proxy: true, mode: "disable" },
];

describe.skipIf(!optedIn)("real local Firefox WebRTC routing acceptance", () => {
  it("observes the configured proxy_only / real / disabled behavior and corroborates proxy traffic", async () => {
    const root = ownedDirectory(process.env.ABS_FIREFOX_WEBRTC_RUN_ROOT);
    const binary = process.env.ABS_FIREFOX_BINARY;
    if (!binary || !path.isAbsolute(binary) || !fs.lstatSync(binary).isFile()) throw new Error("EXPLICIT_EXISTING_FIREFOX_REQUIRED");
    const receipt: Record<string, any> = { schema: "studio-firefox-webrtc-acceptance/v1", status: "failed", browser: binary,
      binaryBefore: fileSha(binary), cases: [], scope: "local loopback only; Firefox engine prefs and candidate behavior; not public proxy/TURN, GUI or Firefox RTP media",
      limitations: ["No SOCKS UDP ASSOCIATE from Firefox WebRTC (its proxy path is TCP)", "No public STUN/TURN or external site", "No audio/video media", "No visible GUI or installed-App acceptance", "No OS-wide packet capture"] };
    let fixture: ProxyTransportFixture | undefined;
    const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean; once: (event: string, callback: () => void) => unknown; pid?: number; stderr?: { on: (event: string, cb: (chunk: Buffer) => void) => void } }> = [];
    let connections: BidiConnection[] = [];
    try {
      // Firefox's own SOCKS path does not consume network.proxy.username/password
      // as pre-filled auth, so use the no-auth SOCKS fixture for this engine.
      fixture = await startProxyTransportFixture({ socksAuth: false, requireProxyForTurn: true });
      const fixtureHost = fixture.host;
      for (const spec of CASES) {
        // One owned profile at a time: a fresh Firefox cache/startup profile is
        // ~47 MiB, so sequential cleanup is required by the 64 MiB child cap.
        const profile = path.join(root, `owned-firefox-${spec.name}`);
        if (fs.existsSync(profile)) throw new Error("OWNED_FIREFOX_PROFILE_EXISTS");
        fs.mkdirSync(profile, { mode: 0o700 });
        const useSocks = spec.name === "proxy-real-socks";
        const proxyConfig = spec.proxy ? { type: useSocks ? "socks5h" as const : "http" as const, host: fixtureHost, port: useSocks ? fixture.socksPort : fixture.httpPort,
          ...(useSocks && fixture.socksCredentials ? fixture.socksCredentials : {}) } : null;
        const meta = { fingerprintSeed: 48151623, platform: "macos" as const, locale: "en-US", timezone: "UTC", fingerprintMode: "managed" as const,
          webrtcMode: spec.mode, fingerprintBaseline: undefined };
        const identity = buildFirefoxManagedIdentity(meta, "154.0");
        const policy = spec.mode === "disable"
          ? { forceProxy: false, obfuscateHostAddresses: false, disablePeerConnectionApi: true }
          : spec.mode === "real"
            ? { forceProxy: false, obfuscateHostAddresses: true, disablePeerConnectionApi: false }
            : { forceProxy: true, obfuscateHostAddresses: true, disablePeerConnectionApi: false };
        // TEST-ONLY reachability/isolation prefs are merged through the managed
        // writer (never appended behind its back), so its ownership state stays
        // coherent for the next write.
        writeFirefoxUserJs(profile, {
          proxy: proxyConfig, dohUrl: null, locale: "en-US", useGpu: true, sandboxPermission: true, colorScheme: "system",
          extraPrefs: identity.prefs, webrtcRouting: policy, proxyRouting: proxyConfig !== null,
          testOnlyPrefs: {
            // The fixture origin/proxy live on 127.0.0.1; Firefox normally bypasses
            // proxies and ICE for localhost, and the managed prefs also list loopback
            // in no_proxies_on. Clear both for this controlled test only.
            "network.proxy.allow_hijacking_localhost": true, "network.proxy.no_proxies_on": "",
            "media.peerconnection.ice.loopback": true,
            // Keep the bounded 64 MiB evidence child viable; unrelated to routing.
            "places.history.enabled": false, "browser.newtabpage.enabled": false,
            "toolkit.telemetry.enabled": false, "datareporting.healthreport.uploadEnabled": false,
            "browser.safebrowsing.enabled": false,
          },
        });
        const prefsText = fs.readFileSync(path.join(profile, "user.js"), "utf8");
        const prefValue = (key: string) => new RegExp(`user_pref\\("${key.replace(/\./g, "\\.")}", ([^)]*)\\);`).exec(prefsText)?.[1] ?? null;
        const fixtureBefore = fixture.stats();
        const report: Record<string, any> = { name: spec.name, mode: spec.mode, proxy: proxyConfig ? proxyConfig.type : null, status: "failed" };
        receipt.cases.push(report);
        // Applied values, not the request: Real with a proxy deliberately has no
        // ICE routing keys; Real without one pins them false; Disable flips the
        // API pref; Proxy-only keeps the exact requested boolean.
        const expectedProxyOnly = policy.disablePeerConnectionApi ? null
          : policy.forceProxy ? "true"
            : proxyConfig ? null : "false";
        expect(prefValue("media.peerconnection.ice.proxy_only")).toBe(expectedProxyOnly);
        expect(prefValue("media.peerconnection.enabled")).toBe(policy.disablePeerConnectionApi ? "false" : null);
        expect(prefValue("media.peerconnection.ice.obfuscate_host_addresses")).toBe(
          policy.disablePeerConnectionApi ? null : policy.forceProxy ? "true" : proxyConfig ? null : "false");
        const port = await freePort();
        const { spawn } = await import("node:child_process");
        const child = spawn(binary, buildFirefoxLaunchArgs({ profileDir: profile, remotePort: port, headless: true, platform: "macos" }), {
          stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH || "", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
            LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
        });
        children.push(child as any);
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
        let connection: BidiConnection | undefined;
        try {
          connection = await waitBidi(port);
          connections.push(connection);
          await bidiNavigate(connection, fixture.origin, null, 15000, "complete");
          const title = await bidiEvaluateInContext(connection, "document.body && document.body.innerText.slice(0,2000)", null, 5000);
          expect(String(title)).toContain(fixture.nonce);
          report.originReachedThroughBrowser = true;
          const originCounts = fixture.stats().counts;
          const delta = (key: keyof typeof originCounts) => originCounts[key] - fixtureBefore.counts[key];
          report.proxyRouteObserved = spec.proxy ? {
            httpForward: delta("httpForward"), httpConnect: delta("httpConnect"), socksConnect: delta("socksConnect"),
          } : null;
          if (spec.proxy) {
            // The origin is 127.0.0.1, so this also proves the test-only loopback
            // proxy override actually forced the request through the proxy.
            expect(useSocks ? delta("socksConnect") : delta("httpForward")).toBeGreaterThan(0);
          }
          if (policy.disablePeerConnectionApi) {
            const api = await bidiEvaluateInContext(connection, "typeof window.RTCPeerConnection", null, 5000);
            report.peerConnectionApi = api;
            expect(api).toBe("undefined");
            report.status = "passed";
            continue;
          }
          const exposed = await bidiEvaluateInContext(connection, `(async () => {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(fixture.stun.url)} }] });
            const out = { candidates: [], complete: false, error: null };
            try {
              await new Promise(resolve => {
                const timer = setTimeout(resolve, 5000);
                pc.onicecandidate = event => { if (event.candidate) out.candidates.push(event.candidate.candidate); else { out.complete = true; clearTimeout(timer); resolve(); } };
                pc.createDataChannel("owned-exposure");
                pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(error => { out.error = String(error && error.message || error); clearTimeout(timer); resolve(); });
              });
            } finally { pc.close(); }
            return out;
          })()`, null, 12000);
          report.exposure = { complete: !!exposed.complete, count: exposed.candidates.length, types: exposed.candidates.map(c => (c.split(" ").find((_, i, all) => all[i - 1] === "typ") || "unknown")) };
          report.stunDirectBindingsAdded = fixture.stats().counts.stunBinding - fixtureBefore.counts.stunBinding;
          if (policy.forceProxy) {
            // proxy_only is about ICE routing, not a promise of zero candidates:
            // assert no direct STUN binding and no raw host address exposure.
            expect(report.stunDirectBindingsAdded).toBe(0);
            expect((exposed.candidates as string[]).some(c => /(^|\s)(?:\d{1,3}\.){3}\d{1,3}(\s|$)/.test(c.split(" ")[4] || ""))).toBe(false);
          } else {
            expect((exposed.candidates as string[]).length).toBeGreaterThan(0);
          }
          report.peer = normalizeWebRtcPeerConnectivity(await bidiEvaluateInContext(connection, buildWebRtcPeerProbe({
            iceServers: [{ urls: [fixture.turn.urls], username: fixture.turn.username, credential: fixture.turn.credential }], relayOnly: true, timeoutMs: 8000,
          }), null, 15000));
          report.fixture = fixture.stats();
          // Firefox's proxy path is TCP/TLS only and ICE-over-TCP is a weak
          // fallback: do not require media/TURN connectivity here. The product
          // claim under test is routing policy + no direct STUN, not Firefox
          // RTP success. Record the actual peer result honestly.
          if (policy.forceProxy) expect(report.stunDirectBindingsAdded).toBe(0);
          report.status = "passed";
        } catch (error) {
          report.error = String((error as Error)?.message || error);
          report.stderrTail = stderr.slice(-1200);
          throw error;
        } finally {
          if (connection) { try { await connection.close(); } catch { /* owned session */ } }
          connections = connections.filter(c => c !== connection);
          child.kill("SIGTERM");
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, 12000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
        }
        // Remove only this case's freshly created owned profile tree. The
        // receipt carries the observations; no raw profile is retained.
        const profileStat = fs.lstatSync(profile);
        if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || profileStat.uid !== process.getuid?.()) throw new Error("OWNED_FIREFOX_PROFILE_CHANGED");
        fs.rmSync(profile, { recursive: true, force: true });
      }
      receipt.status = "passed";
    } catch (error) {
      // Preserve the real failing stage; the final cleanup assertions must not
      // replace it with a generic status mismatch.
      receipt.error = String((error as Error)?.stack || error).slice(0, 4000);
      throw error;
    } finally {
      for (const connection of connections) { try { await connection.close(); } catch { /* owned */ } }
      for (const child of children) { try { child.kill("SIGKILL"); } catch { /* may already be exited */ } }
      if (fixture) { await fixture.close(); receipt.fixtureActive = fixture.stats().active; }
      receipt.binaryAfter = fileSha(binary);
      receipt.binaryUnchanged = receipt.binaryAfter === receipt.binaryBefore;
      if (!receipt.binaryUnchanged) receipt.status = "failed";
      fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      console.log("FIREFOX_RESULT " + JSON.stringify({ status: receipt.status, cases: receipt.cases.map((c: any) => ({ name: c.name, status: c.status, api: c.peerConnectionApi,
        candidates: c.exposure?.count, added: c.stunDirectBindingsAdded, peer: c.peer?.status })), active: receipt.fixtureActive, binaryUnchanged: receipt.binaryUnchanged }));
      expect(receipt.binaryUnchanged).toBe(true);
      expect(receipt.status).toBe("passed");
    }
  }, 150000);
});
