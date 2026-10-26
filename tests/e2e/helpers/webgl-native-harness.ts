// Dedicated, opt-in WebGL observation support. Never discover/adopt a host
// process, signal native children, read user profiles or relax native policy.
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { buildBaseChromiumArgs } from "../../../src/main/services/browser/chromium-args-factory.js";
import { resolveChromiumWebRtcRoutingPolicy, chromiumWebRtcRoutingArgs } from "../../../src/main/services/browser/webrtc-policy.js";
import { applyChromiumWebRtcPreferences } from "../../../src/main/services/browser/webrtc-preferences.js";

type Dict = Record<string, any>;
const MIB = 1024 ** 2, GIB = 1024 ** 3, ADMIN = 64 * 1024;
const AGGREGATE_CAP = 2 * GIB, PHASE_CAP = 256 * MIB, MIN_FREE = 10 * GIB;
export function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
export function safeFailure(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^OWNED_[A-Z0-9_]+$/.test(message) ? message : fallback;
}
export function inside(root: string, ...parts: string[]): string {
  const file = path.resolve(root, ...parts), relative = path.relative(root, file);
  ensure(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "OWNED_PATH_ESCAPE");
  return file;
}
function directory(input: string | undefined): string {
  ensure(input && path.isAbsolute(input), "OWNED_EXPLICIT_ROOT_REQUIRED");
  const stat = fs.lstatSync(input);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(input) === input && stat.uid === process.getuid?.(), "OWNED_ROOT_UNSAFE");
  return input;
}
function bytes(root: string, file: string, maximum = MIB): Buffer {
  inside(root, path.relative(root, file));
  let parent = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    const stat = fs.lstatSync(parent); ensure(stat.isDirectory() && !stat.isSymbolicLink(), "OWNED_FILE_PARENT_UNSAFE");
  }
  const before = fs.lstatSync(file);
  ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum, "OWNED_FILE_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd), result = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    ensure(same(before, opened) && same(before, after) && same(after, current) && result.length === before.size, "OWNED_FILE_CHANGED");
    return result;
  } finally { fs.closeSync(fd); }
}
function fact(root: string, name: string, value: unknown): void {
  const file = inside(root, name), text = JSON.stringify(value);
  ensure(Buffer.byteLength(text) <= ADMIN, "OWNED_FACT_BUDGET");
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ensure(bytes(root, file).equals(Buffer.from(text)), "OWNED_FACT_READBACK_FAILED");
}
function inventory(root: string): number {
  let logical = 0, allocated = 0, entries = 0;
  const visit = (at: string) => {
    for (const name of fs.readdirSync(at)) {
      ensure(++entries <= 50_000, "OWNED_ENTRY_BUDGET");
      const file = path.join(at, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      logical += stat.size; allocated += stat.blocks * 512; // Link bytes, never link targets.
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        try { visit(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  };
  visit(root); return Math.max(logical, allocated);
}
class Budget {
  private rootOwner: fs.Stats;
  private aggregateOwner: fs.Stats;
  private sample: { bytes: number; completedAt: number } | null = null;
  private phase: { bytes: number; at: number; mtime: number } | null = null;
  private positiveGrowth = 0;
  readonly observations: Dict = { globalScans: [], phaseScans: 0, identityChecks: 0, freeChecks: 0,
    globalScanCadenceMs: 10_000, phaseScanCadenceMs: 250, atomicQuota: false, outerAggregateSupervisionRequired: true };
  constructor(readonly root: string, readonly aggregate: string) {
    this.rootOwner = fs.lstatSync(root); this.aggregateOwner = fs.lstatSync(aggregate);
    ensure(this.rootOwner.dev === this.aggregateOwner.dev && fs.readdirSync(root).length === 0, "OWNED_ROOT_NOT_FRESH_OR_WRONG_VOLUME");
  }
  identity(): fs.Stats {
    const current = fs.lstatSync(this.root), aggregate = fs.lstatSync(this.aggregate);
    for (const [actual, expected] of [[current, this.rootOwner], [aggregate, this.aggregateOwner]]) {
      ensure(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid, "OWNED_BUDGET_ROOT_CHANGED");
    }
    this.observations.identityChecks++; return current;
  }
  measure(options: { forceGlobal?: boolean; forcePhase?: boolean; administrativeBytes?: number } = {}): Dict {
    const administrative = options.administrativeBytes !== undefined;
    ensure(!administrative || Number.isInteger(options.administrativeBytes) && options.administrativeBytes! >= 0 && options.administrativeBytes! <= ADMIN, "OWNED_ADMIN_BUDGET_INVALID");
    const current = this.identity(), now = Date.now();
    if (!administrative) ensure(!fs.lstatSync(inside(this.root, "outer-abort.json"), { throwIfNoEntry: false }), "OWNED_OUTER_ABORT_REQUESTED");
    if (!this.sample || options.forceGlobal || now - this.sample.completedAt >= 10_000) {
      const startedAt = Date.now(), before = inventory(this.root), total = inventory(this.aggregate), after = inventory(this.root), completedAt = Date.now();
      this.sample = { bytes: total, completedAt }; this.positiveGrowth = Math.max(0, after - before);
      this.phase = { bytes: after, at: completedAt, mtime: this.identity().mtimeMs };
      this.observations.phaseScans += 2; this.observations.globalScans.push({ startedAt, completedAt, aggregateBytes: total, phaseBefore: before, phaseAfter: after });
    } else if (!this.phase || options.forcePhase || administrative || now - this.phase.at >= 250 || current.mtimeMs !== this.phase.mtime) {
      const measured = inventory(this.root); this.positiveGrowth += Math.max(0, measured - (this.phase?.bytes ?? measured));
      this.phase = { bytes: measured, at: Date.now(), mtime: this.identity().mtimeMs }; this.observations.phaseScans++;
    }
    ensure(this.sample && this.phase, "OWNED_BUDGET_MEASUREMENT_MISSING");
    const space = fs.statfsSync(this.root, { bigint: true }), free = space.bavail * space.bsize;
    this.observations.freeChecks++; this.identity();
    const reserve = administrative ? options.administrativeBytes! + ADMIN : MIB, upper = this.sample.bytes + this.positiveGrowth;
    ensure(upper + reserve <= AGGREGATE_CAP && this.phase.bytes + reserve <= PHASE_CAP && free >= BigInt(MIN_FREE + reserve), "OWNED_STORAGE_BUDGET_EXCEEDED");
    return { aggregateBytes: this.sample.bytes, aggregateUpperBoundBytes: upper, aggregateObservedAt: this.sample.completedAt,
      phaseBytes: this.phase.bytes, phaseObservedAt: this.phase.at, freeBytes: free.toString(), freeObservedAt: Date.now(), reserveBytes: reserve,
      aggregateCap: AGGREGATE_CAP, phaseCap: PHASE_CAP, minimumFree: MIN_FREE, administrativeOnly: administrative,
      measurement: "max(logical, allocated), last global + observed cumulative positive phase growth; other writers need outer supervision" };
  }
}
export class OwnedCdp {
  private id = 0;
  private pending = new Map<number, { resolve: (result: Dict) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private events = new Set<(method: string, params: Dict) => void>();
  onEvent(listener: (method: string, params: Dict) => void): () => void {
    ensure(this.events.size < 8, "OWNED_CDP_OBSERVER_BOUND");
    this.events.add(listener); return () => { this.events.delete(listener); };
  }
  private constructor(private socket: WebSocket, private current: () => boolean) {
    socket.on("error", () => this.rejectAll()); socket.on("close", () => this.rejectAll());
    socket.on("message", data => {
      let response: Dict;
      try { response = JSON.parse(data.toString()); }
      catch { this.rejectAll(); return; }
      if (typeof response.method === "string" && response.params && typeof response.params === "object") {
        for (const listener of this.events) listener(response.method, response.params);
        return;
      }
      const request = this.pending.get(response.id); if (!request) return;
      clearTimeout(request.timer); this.pending.delete(response.id);
      if (response.error || !response.result || typeof response.result !== "object") request.reject(new Error("OWNED_CDP_COMMAND_FAILED"));
      else request.resolve(response.result);
    });
  }
  private rejectAll(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("OWNED_CDP_DISCONNECTED")); }
    this.pending.clear();
  }
  static async connect(raw: string, port: number, current: () => boolean): Promise<OwnedCdp> {
    const url = new URL(raw);
    ensure(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && Number(url.port) === port &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith("/devtools/") && current(), "OWNED_CDP_ENDPOINT_UNSAFE");
    const socket = new WebSocket(raw, { followRedirects: false, perMessageDeflate: false, maxPayload: MIB }), client = new OwnedCdp(socket, current);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("OWNED_CDP_CONNECT_TIMEOUT")), 10_000);
        socket.once("open", () => { clearTimeout(timer); resolve(); });
        socket.once("error", () => { clearTimeout(timer); reject(new Error("OWNED_CDP_CONNECT_FAILED")); });
        socket.once("close", () => { clearTimeout(timer); reject(new Error("OWNED_CDP_CONNECT_CLOSED")); });
      });
      return client;
    } catch (error) { client.disconnect(); throw error; }
  }
  send(method: string, params: Dict = {}, timeout = 10_000): Promise<Dict> {
    ensure(this.current() && this.socket.readyState === WebSocket.OPEN, "OWNED_CDP_OWNER_CHANGED");
    ensure(Number.isInteger(timeout) && timeout > 0 && timeout <= 60_000, "OWNED_CDP_COMMAND_DEADLINE_INVALID");
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("OWNED_CDP_COMMAND_TIMEOUT")); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("OWNED_CDP_SEND_FAILED")); }
    });
  }
  disconnect(): void { this.rejectAll(); this.socket.terminate(); } // Own WebSocket, never a native process.
}
export interface WebGlNativeOwner {
  label: "stock" | "managed"; child: ChildProcess; pid: number; port: number; profile: string; verified: boolean; closeRequested: boolean;
  browser?: OwnedCdp; page?: OwnedCdp; version?: string; software?: Dict;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited: { code: number | null; signal: NodeJS.Signals | null } | null;
  closeRpc: Dict; closePromise?: Promise<void>;
}
const alive = (owner: WebGlNativeOwner) => owner.child.pid === owner.pid && owner.child.exitCode === null && owner.child.signalCode === null && !owner.child.killed;
async function until(condition: () => Promise<boolean>, code: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  throw new Error(code);
}
async function nativeJson(port: number, route: "/json/version" | "/json/list"): Promise<Dict> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000), redirect: "error" });
  ensure(response.ok, "OWNED_NATIVE_DISCOVERY_FAILED");
  const text = await response.text(); ensure(Buffer.byteLength(text) <= MIB, "OWNED_NATIVE_DISCOVERY_BUDGET"); return JSON.parse(text);
}
export class WebGlNativeHarness {
  readonly root: string;
  readonly binary: string;
  readonly natives: WebGlNativeOwner[] = [];
  readonly initialBudget: Dict;
  readonly budget: Budget;
  private timer?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private failure: string | null = null;
  private servers: http.Server[] = [];
  private sockets = new Set<net.Socket>();
  private fixtureFailed = false;
  private fixtureRequests = 0;
  private deniedRequests = 0;
  private proxyPort = 0;
  private origin = "";
  private publicBytes = 0;
  private publicConnections = 0;
  private publicNetwork: Array<{ host: string; outcome: string; code?: string }> = [];
  constructor(readonly publicSites = false) {
    ensure(!publicSites || process.env.ABS_PUBLIC_FINGERPRINT_SITES === "1", "OWNED_PUBLIC_SITE_OPT_IN_REQUIRED");
    ensure(process.platform === "darwin", "OWNED_ACCEPTANCE_REQUIRES_MACOS");
    ensure(!process.env.AGENT_BROWSER_SECRET_BACKEND && process.env.AGENT_BROWSER_E2E_UNSANDBOXED !== "1", "OWNED_POLICY_OVERRIDE_PRESENT");
    const aggregate = directory(process.env.ABS_S3_COOKIE_LOGIN_BUDGET_ROOT);
    this.root = directory(process.env.ABS_S3_COOKIE_LOGIN_ROOT); inside(aggregate, path.relative(aggregate, this.root));
    this.budget = new Budget(this.root, aggregate); this.initialBudget = this.budget.measure({ forceGlobal: true });
    ensure(BigInt(this.initialBudget.freeBytes) >= BigInt(MIN_FREE + PHASE_CAP), "OWNED_PHASE_RESERVE_UNAVAILABLE");
    const input = process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH;
    ensure(input && path.isAbsolute(input), "OWNED_EXPLICIT_NATIVE_REQUIRED");
    this.binary = fs.realpathSync(input); ensure(fs.lstatSync(this.binary).isFile(), "OWNED_NATIVE_NOT_A_FILE"); fs.accessSync(this.binary, fs.constants.X_OK);
  }
  guard(forceGlobal = false): Dict {
    ensure(!this.failure, this.failure || "OWNED_STAGE_PREVIOUSLY_FAILED");
    return this.budget.measure({ forceGlobal });
  }
  private stopWork(code: string): void {
    this.failure ||= code;
    for (const native of this.natives) if (native.verified && native.browser && alive(native)) void this.requestClose(native);
  }
  async start(): Promise<void> {
    // Public mode has its own declared first-run budget for the existing Ping0
    // finished + 15s settle contract; the local observation budget is unchanged.
    this.deadline = setTimeout(() => this.stopWork("OWNED_STAGE_TIME_BUDGET_EXCEEDED"), this.publicSites ? 480_000 : 120_000);
    this.timer = setInterval(() => {
      if (this.failure) return;
      try { this.guard(); }
      catch (error) { this.stopWork(safeFailure(error, "OWNED_STORAGE_GUARD_FAILED")); }
    }, 1000);
    const listen = async (server: http.Server) => {
      this.servers.push(server);
      server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
      server.on("error", () => { this.fixtureFailed = true; this.stopWork("OWNED_FIXTURE_LISTENER_FAILED"); });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address(); ensure(address && typeof address !== "string", "OWNED_LISTENER_UNAVAILABLE"); return address.port;
    };
    const site = http.createServer((req, res) => {
      try {
        this.guard(); ensure(++this.fixtureRequests <= 256 && req.method === "GET" && req.url === "/", "OWNED_SITE_REQUEST_INVALID");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'" });
        res.end("<!doctype html><meta charset=utf-8><title>Owned WebGL observation</title>");
      } catch { this.fixtureFailed = true; res.writeHead(500); res.end("Owned fixture failed"); }
    });
    const sitePort = await listen(site); this.origin = `http://owned-webgl.invalid:${sitePort}/`;
    const proxy = http.createServer((req, res) => {
      let url: URL;
      try { url = new URL(req.url || ""); }
      catch { this.deniedRequests++; res.writeHead(403); res.end(); return; }
      if (this.publicSites && url.protocol === "http:" && (!url.port || url.port === "80") &&
          (url.hostname === "d.ping0.cc" || /^[a-z0-9-]{1,63}\.d\.ping0\.cc$/.test(url.hostname)) && req.method === "GET" && !url.username && !url.password) {
        try { this.guard(); ensure(++this.publicConnections <= 256, "OWNED_PUBLIC_CONNECTION_BOUND"); }
        catch (error) { this.stopWork(safeFailure(error, "OWNED_PUBLIC_NETWORK_BOUND")); res.writeHead(503); res.end(); return; }
        const observation: { host: string; outcome: string; code?: string } = { host: "*.d.ping0.cc", outcome: "http-requested" };
        this.publicNetwork.push(observation);
        const request = http.request(url, { method: "GET", headers: { host: url.host, accept: "*/*" } }, response => {
          observation.outcome = "http-response-" + String(response.statusCode);
          let count = 0;
          response.on("data", (chunk: Buffer) => {
            count += chunk.length; this.publicBytes += chunk.length;
            if (count > MIB || this.publicBytes > 32 * MIB) { this.stopWork("OWNED_PUBLIC_NETWORK_BYTE_BOUND"); request.destroy(); res.destroy(); }
          });
          res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
        });
        request.setTimeout(10_000, () => request.destroy(Object.assign(new Error("OWNED_PUBLIC_HTTP_TIMEOUT"), { code: "ETIMEDOUT" })));
        request.on("error", (error: NodeJS.ErrnoException) => {
          observation.outcome = "network-failed"; observation.code = /^[A-Z0-9_]{1,64}$/.test(error.code || "") ? error.code : "UNKNOWN";
          if (!res.headersSent) res.writeHead(502); res.end();
        });
        request.end(); return;
      }
      if (url.href !== this.origin || req.method !== "GET" || url.username || url.password) {
        this.deniedRequests++; res.writeHead(403); res.end(); return;
      }
      const upstream = http.request({ hostname: "127.0.0.1", port: sitePort, method: "GET", path: "/", headers: { host: url.host } }, response => {
        res.writeHead(response.statusCode || 502, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'" });
        response.pipe(res);
      });
      upstream.setTimeout(5000, () => upstream.destroy(new Error("OWNED_FIXTURE_UPSTREAM_TIMEOUT")));
      upstream.on("error", () => { this.fixtureFailed = true; if (!res.headersSent) res.writeHead(502); res.end(); }); upstream.end();
    });
    proxy.on("connect", (req, socket, initial) => {
      const match = /^([a-z0-9.-]+):443$/.exec(req.url || "");
      const host = match?.[1];
      const allowed = host && (["creepjs.org", "api.creepjs.org", "ping0.cc", "cdn.ping0.cc", "d.ping0.cc"].includes(host) || /^[a-z0-9-]{1,63}\.d\.ping0\.cc$/.test(host));
      if (!this.publicSites || !allowed) { this.deniedRequests++; socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      try { this.guard(); ensure(++this.publicConnections <= 256, "OWNED_PUBLIC_CONNECTION_BOUND"); }
      catch (error) { this.stopWork(safeFailure(error, "OWNED_PUBLIC_NETWORK_BOUND")); socket.destroy(); return; }
      // TLS remains browser-to-origin, without interception or a trust override.
      const upstream = net.connect({ host, port: 443 }); this.sockets.add(upstream);
      const observation: { host: string; outcome: string; code?: string } = { host: host.endsWith(".d.ping0.cc") ? "*.d.ping0.cc" : host, outcome: "connecting" };
      this.publicNetwork.push(observation);
      let connectionBytes = initial.length;
      const account = (chunk: Buffer) => {
        this.publicBytes += chunk.length; connectionBytes += chunk.length;
        if (this.publicBytes > 32 * MIB || connectionBytes > 8 * MIB) { this.stopWork("OWNED_PUBLIC_NETWORK_BYTE_BOUND"); upstream.destroy(); socket.destroy(); }
      };
      upstream.setTimeout(30_000, () => { observation.outcome = "idle-timeout"; upstream.destroy(); socket.destroy(); });
      upstream.once("connect", () => {
        observation.outcome = "tcp-connected";
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (initial.length) upstream.write(initial);
        socket.on("data", account); upstream.on("data", account); socket.pipe(upstream); upstream.pipe(socket);
      });
      upstream.on("error", (error: NodeJS.ErrnoException) => {
        observation.outcome = "network-failed"; observation.code = /^[A-Z0-9_]{1,64}$/.test(error.code || "") ? error.code : "UNKNOWN";
        socket.destroy();
      });
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => { this.sockets.delete(upstream); socket.destroy(); });
    });
    this.proxyPort = await listen(proxy);
  }
  async launch(label: WebGlNativeOwner["label"], fingerprintArg?: string): Promise<WebGlNativeOwner> {
    this.guard(); ensure(this.proxyPort > 0, "OWNED_FIXTURE_NOT_READY");
    const profile = inside(this.root, label + "-profile"), home = inside(this.root, label + "-home"), temp = inside(this.root, label + "-temp");
    for (const dir of [profile, home, temp]) fs.mkdirSync(dir, { mode: 0o700 });
    const activePort = inside(profile, "DevToolsActivePort"); ensure(!fs.existsSync(activePort), "OWNED_STALE_DEVTOOLS_FILE");
    const routing = this.publicSites ? resolveChromiumWebRtcRoutingPolicy({ requestedMode: "proxy-only", fingerprintMode: label === "managed" ? "managed" : "off", hasProxy: true }) : null;
    if (routing) {
      const persisted = applyChromiumWebRtcPreferences(profile, routing);
      ensure(persisted.readbackVerified && persisted.directorySynced && persisted.policy === "disable_non_proxied_udp", "OWNED_PUBLIC_WEBRTC_ROUTING_UNCONFIRMED");
      fact(this.root, label + "-routing.json", { policy: routing, persisted });
    }
    const args = [...buildBaseChromiumArgs({ profileDir: profile, seed: 730147, platform: "macos", cdpPort: 0,
      fingerprintMode: label === "managed" ? "managed" : "off", headless: true, nativeChromiumVersion: null,
      supportsFingerprintConfig: label === "managed", supportsGoogleApiKeyInfoBar: false }),
      ...(fingerprintArg ? [fingerprintArg] : []), ...(routing ? [...chromiumWebRtcRoutingArgs(routing), "--disable-quic"] : ["--profile-directory=Default"]), "--disable-background-networking", "--disable-component-update",
      "--disable-domain-reliability", `--proxy-server=http://127.0.0.1:${this.proxyPort}`, "--proxy-bypass-list=<-loopback>", "about:blank"];
    ensure((label === "managed") === Boolean(fingerprintArg) && args.includes("--use-mock-keychain") && args.includes("--password-store=basic") &&
      !args.some(arg => /^--(?:no-sandbox|disable-gpu|disable-gpu-sandbox|ignore-certificate-errors|disable-web-security|enable-unsafe-webgpu|ignore-gpu-blocklist)(?:=|$)/.test(arg)), "OWNED_NATIVE_POLICY_CHANGED");
    const child = spawn(this.binary, args, { cwd: this.root, stdio: "ignore", env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: home,
      TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, LANG: "en_US.UTF-8" } });
    let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const native: WebGlNativeOwner = { label, child, pid: child.pid || 0, port: 0, profile, verified: false, closeRequested: false,
      exit: new Promise(resolve => { resolveExit = resolve; }), exited: null, closeRpc: { outcome: "not-requested" } };
    this.natives.push(native);
    child.once("exit", (code, signal) => { native.exited = { code, signal }; resolveExit(native.exited); });
    child.once("error", () => { native.exited = { code: -1, signal: null }; resolveExit(native.exited); });
    ensure(native.pid > 0, "OWNED_NATIVE_SPAWN_FAILED");
    fact(this.root, label + "-native-owner.json", { pid: native.pid, profile, verifiedCdpBinding: false, cleanup: "normal Browser.close only; otherwise retain and fail" });
    let version: Dict | undefined;
    await until(async () => {
      this.guard(); ensure(alive(native), "OWNED_NATIVE_EXITED_BEFORE_READY");
      if (!fs.existsSync(activePort)) return false;
      const lines = bytes(this.root, activePort, 4096).toString("utf8").trimEnd().split("\n"); if (lines.length < 2) return false;
      ensure(/^[1-9][0-9]{0,4}$/.test(lines[0]) && Number(lines[0]) <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1]), "OWNED_DEVTOOLS_FILE_INVALID");
      native.port = Number(lines[0]);
      try { version = await nativeJson(native.port, "/json/version"); } catch { return false; }
      ensure(new URL(version.webSocketDebuggerUrl).pathname === lines[1], "OWNED_DEVTOOLS_BROWSER_PATH_MISMATCH"); return true;
    }, "OWNED_NATIVE_READY_TIMEOUT");
    native.browser = await OwnedCdp.connect(version!.webSocketDebuggerUrl, native.port, () => alive(native));
    const info = await native.browser.send("SystemInfo.getProcessInfo");
    ensure(Array.isArray(info.processInfo) && info.processInfo.filter((entry: Dict) => entry.type === "browser").length === 1 &&
      info.processInfo.find((entry: Dict) => entry.type === "browser")?.id === native.pid, "OWNED_NATIVE_CDP_PID_MISMATCH");
    native.verified = true;
    fact(this.root, label + "-native-bound.json", { pid: native.pid, port: native.port, ownedDevToolsActivePort: true,
      heldChildMatchesSystemInfo: true, productionDiscoveryLaunchStopAttested: false });
    const pages = await nativeJson(native.port, "/json/list") as unknown as Dict[];
    const page = pages.find(entry => entry.type === "page" && entry.webSocketDebuggerUrl); ensure(page, "OWNED_NATIVE_PAGE_MISSING");
    native.page = await OwnedCdp.connect(page.webSocketDebuggerUrl, native.port, () => alive(native) && native.verified);
    await native.page.send("Page.enable");
    ensure(typeof version!.Browser === "string" && version!.Browser.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._+()\/-]*$/.test(version!.Browser) &&
      typeof version!["Protocol-Version"] === "string" && /^[0-9]+(?:\.[0-9]+){1,3}$/.test(version!["Protocol-Version"]), "OWNED_NATIVE_SOFTWARE_METADATA_INVALID");
    const match = version!.Browser.match(/(?:Chrome|Chromium)\/(\d+\.\d+\.\d+\.\d+)/); ensure(match, "OWNED_NATIVE_VERSION_UNAVAILABLE");
    native.version = match[1]; native.software = { source: "owned-/json/version", Browser: version!.Browser,
      "Protocol-Version": version!["Protocol-Version"], nativeSourceBuildAttested: false };
    return native;
  }
  async observe(native: WebGlNativeOwner, expression: string): Promise<unknown> {
    this.guard(); ensure(native.verified && native.page && alive(native), "OWNED_NATIVE_NOT_VERIFIED");
    const navigation = await native.page.send("Page.navigate", { url: this.origin });
    ensure(!navigation.errorText, "OWNED_NAVIGATION_FAILED");
    await until(async () => {
      this.guard();
      const response = await native.page!.send("Runtime.evaluate", { expression: "({url:location.href,ready:document.readyState})", returnByValue: true });
      return response.result?.value?.url === this.origin && response.result?.value?.ready === "complete";
    }, "OWNED_NAVIGATION_TIMEOUT");
    const response = await native.page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    this.guard(); ensure(!response.exceptionDetails && response.result?.value, "OWNED_WEBGL_EVALUATION_FAILED"); return response.result.value;
  }
  private requestClose(native: WebGlNativeOwner): Promise<void> {
    if (native.closePromise) return native.closePromise;
    const rpc = native.closeRpc = { outcome: "pending", requestedAt: new Date().toISOString() } as Dict;
    native.closePromise = (async () => {
      try {
        ensure(native.verified && native.browser && alive(native), "OWNED_NATIVE_CLOSE_UNVERIFIED"); native.closeRequested = true;
        await native.browser.send("Browser.close"); rpc.outcome = "acknowledged";
      } catch (error) {
        rpc.code = safeFailure(error, "OWNED_NATIVE_CLOSE_RPC_FAILED");
        rpc.outcome = rpc.code === "OWNED_CDP_DISCONNECTED" ? "disconnected" : rpc.code === "OWNED_CDP_COMMAND_TIMEOUT" ? "timeout" : "failed";
      } finally { rpc.completedAt = new Date().toISOString(); }
    })();
    return native.closePromise;
  }
  async close(native: WebGlNativeOwner): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (alive(native)) await this.requestClose(native);
      const actual = await Promise.race([native.exit, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OWNED_NATIVE_EXIT_UNCONFIRMED")), 15_000);
      })]);
      ensure(native.closeRequested && actual.code === 0 && actual.signal === null, "OWNED_NATIVE_EXIT_NOT_NORMAL");
    } finally {
      if (timer) clearTimeout(timer); native.page?.disconnect(); native.browser?.disconnect();
      if (native.closePromise) await native.closePromise;
      if (alive(native)) native.child.unref(); // Preserve failed child/profile, never signal it.
    }
  }
  async finish(receipt: Dict): Promise<void> {
    if (this.deadline) clearTimeout(this.deadline);
    receipt.cleanup = [];
    for (const native of this.natives.slice().reverse()) {
      try { await this.close(native); receipt.cleanup.push({ pid: native.pid, label: native.label, normalActualExit: true, closeRpc: { ...native.closeRpc }, actualExit: native.exited }); }
      catch { receipt.status = "failed"; receipt.cleanup.push({ pid: native.pid, label: native.label, normalActualExit: false, retained: true, closeRpc: { ...native.closeRpc }, actualExit: native.exited }); }
    }
    if (this.timer) clearInterval(this.timer);
    try {
      for (const server of this.servers.slice().reverse()) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { for (const socket of this.sockets) socket.destroy(); reject(new Error("OWNED_FIXTURE_CLOSE_TIMEOUT")); }, 5000);
        server.close(error => { clearTimeout(timer); if (error) reject(new Error("OWNED_FIXTURE_CLOSE_FAILED")); else resolve(); }); server.closeIdleConnections();
      });
      receipt.fixtureClosed = true;
    } catch { receipt.status = "failed"; receipt.fixtureClosed = false; }
    receipt.fixture = { localPageRequests: this.fixtureRequests, deniedOtherRequests: this.deniedRequests, failuresObserved: this.fixtureFailed,
      publicSitesOptedIn: this.publicSites, publicBytes: this.publicBytes, publicConnections: this.publicConnections, publicNetwork: this.publicNetwork,
      publicNetworkScope: this.publicSites ? "exact named HTTPS hosts and naturally requested Ping0 challenge subdomains; strict proxy, no direct WebRTC UDP, no TLS interception" : "none" };
    receipt.native = this.natives.map(native => ({ label: native.label, pid: native.pid, port: native.port, heldChildMatchesCdp: native.verified,
      ownedDevToolsActivePort: native.verified, softwareObservation: native.software, productionDiscoveryLaunchStopAttested: false, normalMacLaunchSwitches: true }));
    receipt.finishedAt = new Date().toISOString(); receipt.guardFailure = this.failure;
    if (this.failure || this.fixtureFailed || this.natives.length !== 2 || receipt.cleanup.some((entry: Dict) => !entry.normalActualExit)) receipt.status = "failed";
    try {
      let failed = receipt.status !== "passed";
      if (!failed) {
        try { receipt.budget.final = this.guard(true); }
        catch (error) { failed = true; receipt.status = "failed"; receipt.error = safeFailure(error, "OWNED_FINAL_BUDGET_FAILED"); }
      }
      if (failed) receipt.budget.final = this.budget.measure({ forceGlobal: true, administrativeBytes: ADMIN });
      // Publication guards take more measurements. Pin this receipt's observed
      // counters instead of comparing a live, subsequently mutated reference.
      receipt.budget.observations = structuredClone(this.budget.observations);
      const text = JSON.stringify(receipt); ensure(Buffer.byteLength(text) <= ADMIN, "OWNED_RECEIPT_BUDGET");
      this.budget.identity(); ensure(!fs.lstatSync(inside(this.root, "receipt.json"), { throwIfNoEntry: false }), "OWNED_RECEIPT_ALREADY_EXISTS");
      fact(this.root, "receipt.pending.json", receipt);
      this.budget.measure(failed ? { forcePhase: true, administrativeBytes: 0 } : { forcePhase: true });
      this.budget.identity(); fs.renameSync(inside(this.root, "receipt.pending.json"), inside(this.root, "receipt.json"));
      ensure(bytes(this.root, inside(this.root, "receipt.json")).equals(Buffer.from(text)), "OWNED_RECEIPT_READBACK_FAILED");
    } catch { receipt.status = "failed"; }
    ensure(receipt.status === "passed", "OWNED_WEBGL_IDENTITY_ACCEPTANCE_FAILED");
  }
}
