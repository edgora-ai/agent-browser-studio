// Explicit opt-in only. Existing native Chromium, one owned synthetic profile,
// dynamic loopback proxies/relay and real byte exchange; no external service.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { chromium, type BrowserContext } from "playwright";
import { startProxyTransportFixture, type ProxyTransportFixture } from "./helpers/proxy-transport-fixture.js";
import { probeProxyTransport } from "../../src/main/services/proxy-transport-probe.js";
import { buildWebRtcPeerProbe, normalizeWebRtcPeerConnectivity } from "../../src/main/services/webrtc-peer-probe.js";
import { startAuthenticatedSocksBridge, type AuthenticatedSocksBridge } from "../../src/main/services/authenticated-socks-bridge.js";
import { chromiumWebRtcRoutingArgs, assertChromiumWebRtcRoutingArgs, resolveChromiumWebRtcRoutingPolicy } from "../../src/main/services/browser/webrtc-policy.js";
import { buildBrowserFingerprintArg } from "../../src/main/services/browser-fingerprint-config.js";
import { readOwnedNativeArgv } from "./helpers/native-argv.js";
import { applyChromiumWebRtcPreferences } from "../../src/main/services/browser/webrtc-preferences.js";

const optedIn = process.env.ABS_PROXY_TRANSPORT_ACCEPTANCE === "1";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function fileSha(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function directory(input: string | undefined): string {
  if (!input || !path.isAbsolute(input)) throw new Error("OWNED_CANONICAL_DIRECTORY_REQUIRED");
  for (let at = input; ; at = path.dirname(at)) {
    const stat = fs.lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("OWNED_CANONICAL_DIRECTORY_REQUIRED");
    if (path.dirname(at) === at) break;
  }
  if (fs.realpathSync(input) !== input || fs.lstatSync(input).uid !== process.getuid?.()) throw new Error("OWNED_CANONICAL_DIRECTORY_REQUIRED");
  return input;
}
function save(file: string, value: unknown): void {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  expect(fs.readFileSync(file, "utf8")).toBe(bytes);
}
function profile(evidenceRoot: string): string {
  const target = path.join(evidenceRoot, "owned-chromium-profile"), marker = path.join(evidenceRoot, "owned-chromium-profile.json");
  if (!fs.existsSync(marker)) {
    if (fs.existsSync(target)) throw new Error("UNKNOWN_EXISTING_PROFILE_REFUSED");
    fs.mkdirSync(target, { mode: 0o700 });
    const stat = fs.lstatSync(target);
    save(marker, { kind: "synthetic-proxy-transport-only", path: target, device: stat.dev, inode: stat.ino, uid: stat.uid });
  }
  const markerStat = fs.lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 1024 || markerStat.uid !== process.getuid?.()) throw new Error("OWNED_PROFILE_MARKER_REQUIRED");
  const pin = JSON.parse(fs.readFileSync(marker, "utf8")), stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || pin.kind !== "synthetic-proxy-transport-only" || pin.path !== target || pin.device !== stat.dev || pin.inode !== stat.ino || pin.uid !== stat.uid || stat.uid !== process.getuid?.()) throw new Error("OWNED_PROFILE_IDENTITY_CHANGED");
  // Reuse only this task's stopped synthetic profile, never erase or follow locks.
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.lstatSync(path.join(target, name)); throw new Error("EXISTING_PROFILE_LOCK_REFUSED"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}
function primeAlternateProfile(userData: string): void {
  const alternate = path.join(userData, "Profile 1"), prefs = path.join(alternate, "Preferences");
  const marker = path.join(path.dirname(userData), "owned-alternate-chromium-profile.json");
  const expected = JSON.stringify({ webrtc: { ip_handling_policy: "default", ip_handling_url: [] } }, null, 2) + "\n";
  if (!fs.existsSync(marker)) {
    if (fs.existsSync(alternate)) throw new Error("UNKNOWN_ALTERNATE_PROFILE_REFUSED");
    fs.mkdirSync(alternate, { mode: 0o700 });
    save(prefs, { webrtc: { ip_handling_policy: "default", ip_handling_url: [] } });
    const stat = fs.lstatSync(alternate);
    save(marker, { path: alternate, device: stat.dev, inode: stat.ino, uid: stat.uid });
  }
  const markerStat = fs.lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 1024 || markerStat.uid !== process.getuid?.()) throw new Error("OWNED_ALTERNATE_PROFILE_MARKER_REQUIRED");
  const pin = JSON.parse(fs.readFileSync(marker, "utf8")), stat = fs.lstatSync(alternate), prefsStat = fs.lstatSync(prefs);
  if (!stat.isDirectory() || stat.isSymbolicLink() || pin.path !== alternate || pin.device !== stat.dev || pin.inode !== stat.ino || pin.uid !== stat.uid || stat.uid !== process.getuid?.()
    || !prefsStat.isFile() || prefsStat.isSymbolicLink() || prefsStat.nlink !== 1 || prefsStat.size !== Buffer.byteLength(expected) || fs.readFileSync(prefs, "utf8") !== expected) throw new Error("OWNED_ALTERNATE_PROFILE_CHANGED");
  const file = path.join(userData, "Local State");
  let original: fs.Stats | null = null;
  try { original = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (original && (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || original.size > 2 * 1024 * 1024 || original.uid !== process.getuid?.())) throw new Error("OWNED_LOCAL_STATE_REQUIRED");
  const state = original ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (!state || typeof state !== "object" || Array.isArray(state) || state.profile && (typeof state.profile !== "object" || Array.isArray(state.profile))) throw new Error("OWNED_LOCAL_STATE_INVALID");
  state.profile = { ...state.profile, last_used: "Profile 1", last_active_profiles: ["Profile 1"],
    info_cache: { ...state.profile?.info_cache, "Profile 1": { name: "Owned alternate control", is_using_default_name: false, is_ephemeral: false } } };
  const temporary = path.join(userData, `.owned-local-state-${randomBytes(12).toString("hex")}.tmp`);
  save(temporary, state);
  let current: fs.Stats | null = null;
  try { current = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (original ? !current || current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size || current.mtimeMs !== original.mtimeMs : current !== null) throw new Error("OWNED_LOCAL_STATE_CHANGED");
  fs.renameSync(temporary, file);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).profile.last_used).toBe("Profile 1");
}

async function directTurnIsDenied(fixture: ProxyTransportFixture): Promise<void> {
  const request = Buffer.alloc(28);
  request.writeUInt16BE(3, 0); request.writeUInt16BE(8, 2); request.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(request, 8);
  request.writeUInt16BE(0x19, 20); request.writeUInt16BE(4, 22); request[24] = 17;
  const socket = new net.Socket();
  try {
    const response = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let bytes = 0;
      socket.setTimeout(2000, () => socket.destroy(new Error("OWNED_DIRECT_TURN_CONTROL_TIMEOUT")));
      socket.on("error", reject);
      socket.on("data", chunk => { bytes += chunk.length; if (bytes > 2048) socket.destroy(new Error("OWNED_DIRECT_TURN_CONTROL_LIMIT")); else chunks.push(chunk); });
      socket.on("end", () => resolve(Buffer.concat(chunks)));
      socket.connect(fixture.turn.port, fixture.host, () => socket.write(request));
    });
    expect(response.readUInt16BE(0)).toBe(0x113);
    expect(response.subarray(8, 20).equals(request.subarray(8, 20))).toBe(true);
    expect(fixture.stats().turn.directDenied).toBe(1);
    expect(fixture.stats().counts.turnAllocate).toBe(0);
  } finally { socket.destroy(); }
}

async function browserCase(input: {
  fixture: ProxyTransportFixture; binary: string; version: string; profile: string;
  kind: "http" | "socks"; fingerprintMode: "managed" | "off"; report: Record<string, any>;
}): Promise<void> {
  const { fixture: f, kind, fingerprintMode, report } = input;
  let context: BrowserContext | undefined, bridge: AuthenticatedSocksBridge | undefined;
  // Only short-lived socket/lock state goes on the system temp volume. Profile,
  // caches and the sole retained test evidence remain in the bounded SSD root.
  const runtime = fs.mkdtempSync("/private/tmp/abs-proxy-rtc-");
  const runtimePin = fs.lstatSync(runtime);
  const before = f.stats();
  try {
    f.setRejected("http", false); f.setRejected("socks", false);
    if (kind === "socks") {
      if (!f.socksCredentials) throw new Error("SYNTHETIC_SOCKS_CREDENTIALS_REQUIRED");
      bridge = await startAuthenticatedSocksBridge({ type: "socks5", host: f.host, port: f.socksPort, ...f.socksCredentials });
    }
    const proxyUrl = kind === "http" ? `http://${f.host}:${f.httpPort}` : `socks5://${bridge!.host}:${bridge!.port}`;
    const policy = resolveChromiumWebRtcRoutingPolicy({ requestedMode: "auto", fingerprintMode, hasProxy: true });
    expect(policy).toMatchObject({ effectiveMode: "proxy-only", nativeMode: "real", nativeIp: null, restrictNonProxiedUdp: true });
    const debugPort = await new Promise<number>((resolve, reject) => {
      const reservation = net.createServer(); reservation.on("error", reject);
      reservation.listen(0, "127.0.0.1", () => {
        const port = (reservation.address() as net.AddressInfo).port;
        reservation.close(error => error ? reject(error) : resolve(port));
      });
    });
    const args = [
      `--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1",
      `--proxy-server=${proxyUrl}`, "--proxy-bypass-list=<-loopback>", ...chromiumWebRtcRoutingArgs(policy),
      "--disable-quic", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--disk-cache-size=1048576", "--media-cache-size=1048576",
      ...(fingerprintMode === "managed" ? [buildBrowserFingerprintArg({ fingerprintMode: "managed", platform: "macos", fingerprintSeed: 24680,
        timezone: "UTC", locale: "en-US", webrtcMode: policy.nativeMode, webrtcIp: policy.nativeIp }, input.version)] : []),
    ];
    assertChromiumWebRtcRoutingArgs(args, policy);
    primeAlternateProfile(input.profile);
    report.lastUsedUnrestrictedAlternatePrimed = true;
    report.routingPreferences = applyChromiumWebRtcPreferences(input.profile, policy);
    context = await chromium.launchPersistentContext(input.profile, {
      executablePath: input.binary, headless: true, chromiumSandbox: true, args,
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", TMPDIR: runtime, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }, timeout: 20000, acceptDownloads: false,
    });
    report.nativeBrowserStarted = true;
    const browser = context.browser();
    if (!browser) throw new Error("OWNED_NATIVE_BROWSER_REQUIRED");
    const browserCdp = await browser.newBrowserCDPSession();
    const processes = await browserCdp.send("SystemInfo.getProcessInfo");
    const leaders = processes.processInfo.filter((row: any) => row.type === "browser");
    if (leaders.length !== 1 || !Number.isSafeInteger(leaders[0].id)) throw new Error("OWNED_CDP_BROWSER_PID_REQUIRED");
    const observed = readOwnedNativeArgv({ pid: leaders[0].id, executablePath: input.binary, argv0: input.binary, profileDir: input.profile, port: debugPort });
    const actualArgs = observed.args;
    report.ownershipWitness = observed.ownershipWitness;
    expect(actualArgs).not.toContain("--no-sandbox");
    assertChromiumWebRtcRoutingArgs(actualArgs, policy);
    report.actualArgsSha256 = sha(JSON.stringify(actualArgs));
    report.routing = { effectiveMode: policy.effectiveMode, nativeMode: policy.nativeMode, restrictiveFlagCount: actualArgs.filter(arg => arg.startsWith("--force-webrtc-ip-handling-policy")).length };
    report.browserVersion = (await browserCdp.send("Browser.getVersion")).product;
    const page = context.pages()[0] || await context.newPage();
    await page.goto("chrome://version", { waitUntil: "load", timeout: 10000 });
    expect((await page.textContent("#profile_path"))?.trim()).toBe(path.join(input.profile, "Default"));
    report.selectedDefaultProfileVerified = true;
    await page.goto(f.origin, { waitUntil: "load", timeout: 10000 });
    expect(await page.textContent("#fixture-nonce")).toBe(f.nonce);
    const challenge = `owned-${kind}-${fingerprintMode}-${randomBytes(12).toString("hex")}`;
    const echo = await page.evaluate(async value => {
      const response = await fetch("/echo", { method: "POST", body: value, cache: "no-store" });
      return { status: response.status, body: await response.text() };
    }, challenge);
    expect(echo).toEqual({ status: 200, body: challenge });
    const exposed = await page.evaluate(`(async () => {
      const pc = new RTCPeerConnection({iceServers:[{urls:${JSON.stringify(f.stun.url)}}]});
      let timer;
      try {
        return await new Promise(async (resolve, reject) => {
          let count = 0;
          timer = setTimeout(() => resolve({complete:false,count}), 3500);
          pc.onicecandidate = event => { if (event.candidate) count++; else resolve({complete:true,count}); };
          try { pc.createDataChannel('owned-exposure'); await pc.setLocalDescription(await pc.createOffer()); }
          catch (error) { reject(new Error('OWNED_EXPOSURE_SETUP_FAILED')); }
        });
      } finally { clearTimeout(timer); pc.close(); }
    })()`);
    report.exposure = exposed;
    expect((exposed as any).complete).toBe(true);
    // The same live STUN server was positively verified through SOCKS beforehand.
    expect(f.stats().counts.stunBinding).toBe(before.counts.stunBinding);
    const peer = normalizeWebRtcPeerConnectivity(await page.evaluate(buildWebRtcPeerProbe({
      iceServers: [{ urls: [f.turn.urls], username: f.turn.username, credential: f.turn.credential }], relayOnly: true, timeoutMs: 10000,
    })));
    report.peer = peer;
    report.fixtureAfterPeer = f.stats();
    expect(peer.status, JSON.stringify({ peer, turn: f.stats().turn, counts: f.stats().counts, denied: f.stats().denied, errors: f.stats().errorCodes })).toBe("connected");
    expect(peer.sentMessages).toBe(2); expect(peer.receivedMessages).toBe(2);
    expect(peer.sentBytes).toBeGreaterThan(0); expect(peer.receivedBytes).toBe(peer.sentBytes);
    expect(peer.selectedPairs).toHaveLength(2);
    expect(peer.selectedPairs.every(pair => pair.localType === "relay" && pair.remoteType === "relay" && pair.relayProtocol === "tcp")).toBe(true);
    const routed = f.stats().turn;
    expect(routed.directDenied).toBe(before.turn.directDenied);
    expect(routed.proxyBoundAllocations - before.turn.proxyBoundAllocations).toBe(2);
    const bindings = routed.proxyBindings.slice(before.turn.proxyBindings.length);
    expect(bindings).toHaveLength(2);
    expect(bindings.every(binding => binding.via === kind && binding.controlBytes.received > 0 && binding.controlBytes.sent > 0 && binding.peerBytes.received > 0 && binding.peerBytes.sent > 0)).toBe(true);
    report.proxyAndRelayBindingVerified = true;
    const priorFailure = f.stats();
    f.setRejected(kind, true); f.disconnect(kind);
    const failedPeer = normalizeWebRtcPeerConnectivity(await page.evaluate(buildWebRtcPeerProbe({
      iceServers: [{ urls: [f.turn.urls], username: f.turn.username, credential: f.turn.credential }], relayOnly: true, timeoutMs: 3000,
    })));
    report.proxyRejectedPeer = failedPeer;
    expect(failedPeer.status).not.toBe("connected");
    expect(f.stats().turn.directDenied).toBe(priorFailure.turn.directDenied);
    expect(f.stats().turn.proxyBoundAllocations).toBe(priorFailure.turn.proxyBoundAllocations);
    const directOriginBefore = f.stats().traffic.origin.received;
    const rejectedFetch = await page.evaluate(async expected => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch("/nonce?no-cache=" + Math.random(), { cache: "no-store", signal: controller.signal });
        const body = await response.text();
        return { succeeded: response.ok && body === expected, status: response.status };
      } catch { return { succeeded: false, status: null }; }
      finally { clearTimeout(timer); }
    }, f.nonce);
    report.proxyRejectedHttp = rejectedFetch;
    expect(rejectedFetch.succeeded).toBe(false);
    expect(f.stats().traffic.origin.received).toBe(directOriginBefore);
    report.noObservedDirectFallback = true;
    report.status = "passed";
  } finally {
    try {
      if (context) {
        await context.close(); report.browserClosedNormally = true;
        expect(JSON.parse(fs.readFileSync(path.join(input.profile, "Profile 1", "Preferences"), "utf8")).webrtc.ip_handling_policy).toBe("default");
        report.unusedAlternatePreferencesPreserved = true;
      }
    } finally {
      if (bridge) { const stats = bridge.stats(); await bridge.close(); report.socksBridge = { accepted: stats.accepted, connected: stats.connected, failed: stats.failed, closed: true }; }
      const current = fs.lstatSync(runtime);
      if (current.dev !== runtimePin.dev || current.ino !== runtimePin.ino || current.uid !== runtimePin.uid || !current.isDirectory() || current.isSymbolicLink()) throw new Error("OWNED_RUNTIME_IDENTITY_CHANGED");
      if (report.browserClosedNormally && fs.readdirSync(runtime).length === 0) { fs.rmdirSync(runtime); report.emptyRuntimeRemoved = true; }
      else report.smallRuntimeRetained = true;
      report.finalFixture = f.stats();
    }
  }
}

describe.skipIf(!optedIn)("real native TCP / SOCKS UDP / WebRTC relay acceptance", () => {
  it("corroborates payloads, selected pairs and the exact proxy-to-TURN sockets; rejects bypass", async () => {
    const runRoot = directory(process.env.ABS_PROXY_TRANSPORT_RUN_ROOT), evidenceRoot = directory(path.dirname(runRoot));
    const selectionPath = process.env.ABS_PROXY_TRANSPORT_BINARY_MANIFEST;
    if (!selectionPath || path.dirname(selectionPath) !== evidenceRoot || !fs.lstatSync(selectionPath).isFile()) throw new Error("EXPLICIT_NATIVE_SELECTION_REQUIRED");
    const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
    const binary = selection.executable.path, framework = selection.framework.path;
    if (process.platform !== "darwin" || process.arch !== "arm64" || !path.isAbsolute(binary) || !path.isAbsolute(framework)
      || !fs.lstatSync(binary).isFile() || !fs.lstatSync(framework).isFile() || fs.realpathSync(binary) !== binary || fs.realpathSync(framework) !== framework) throw new Error("EXPLICIT_EXISTING_NATIVE_ARM64_SELECTION_REQUIRED");
    expect(await fileSha(binary)).toBe(selection.executable.sha256); expect(await fileSha(framework)).toBe(selection.framework.sha256);
    const receipt: Record<string, any> = { schema: "studio-owned-proxy-transport-acceptance/v1", status: "failed", nativeSelectionSha256: sha(fs.readFileSync(selectionPath)),
      scope: "controlled loopback relay and two peers; not external-site, physical cross-machine, GUI or all-packet attestation", cases: [],
      actualNativeBrowser: false, nativeRebuilt: false, realUserDataRead: false, tlsVerificationChanged: false, sandboxDisabled: false,
      limitations: ["IPv4 loopback only", "TURN/TCP, not TURN/TLS or UDP-based TURN", "SOCKS UDP capability is not proof of browser WebRTC UDP or QUIC routing", "Public diagnostic UI remains an ICE exposure check, not this controlled peer test"] };
    let fixture: ProxyTransportFixture | undefined;
    try {
      fixture = await startProxyTransportFixture({ socksAuth: true, requireProxyForTurn: true });
      const targets = { tcpTarget: { host: fixture.host, port: fixture.echo.tcpPort }, udpTarget: fixture.stun, timeoutMs: 3000 };
      receipt.httpProbe = await probeProxyTransport({ type: "http", host: fixture.host, port: fixture.httpPort }, targets);
      expect(receipt.httpProbe.tcp.status).toBe("verified"); expect(receipt.httpProbe.udp.status).toBe("unsupported");
      receipt.socksProbe = await probeProxyTransport({ type: "socks5", host: fixture.host, port: fixture.socksPort, ...fixture.socksCredentials }, targets);
      expect(receipt.socksProbe.tcp.status).toBe("verified"); expect(receipt.socksProbe.udp.status).toBe("verified");
      expect(fixture.stats().counts.stunBinding).toBeGreaterThan(0);
      await directTurnIsDenied(fixture);
      receipt.directTurnControlDenied = true;
      const userData = profile(evidenceRoot);
      for (const item of [{ kind: "http", fingerprintMode: "managed" }, { kind: "socks", fingerprintMode: "managed" }, { kind: "http", fingerprintMode: "off" }] as const) {
        const report: Record<string, any> = { ...item, status: "failed" }; receipt.cases.push(report);
        await browserCase({ fixture, binary, version: selection.version, profile: userData, ...item, report });
      }
      receipt.status = "passed";
    } finally {
      if (fixture) { await fixture.close(); receipt.fixtureClosed = fixture.stats(); expect(Object.values(fixture.stats().active).every(value => value === 0)).toBe(true); }
      receipt.actualNativeBrowser = receipt.cases.some((row: any) => row.nativeBrowserStarted === true);
      receipt.binaryUnchanged = await fileSha(binary) === selection.executable.sha256;
      receipt.frameworkUnchanged = await fileSha(framework) === selection.framework.sha256;
      if (!receipt.binaryUnchanged || !receipt.frameworkUnchanged) receipt.status = "failed";
      save(path.join(runRoot, "native-transport-result.json"), receipt);
      console.log("TRANSPORT_RESULT " + JSON.stringify({ status: receipt.status, cases: receipt.cases.map((row: any) => ({ kind: row.kind, fingerprintMode: row.fingerprintMode, status: row.status, peer: row.peer?.status })), binaryUnchanged: receipt.binaryUnchanged, frameworkUnchanged: receipt.frameworkUnchanged }));
      expect(receipt.binaryUnchanged).toBe(true); expect(receipt.frameworkUnchanged).toBe(true);
    }
  }, 150000);
});
