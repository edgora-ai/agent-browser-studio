// AUTHOR-ONLY preparation. Run ONLY through the coordinator's owned runner after
// a fresh controller/source receipt, never through npm pretest or a build here.
// ABS_NETWORK_ACCEPTANCE=1 ABS_NETWORK_ACCEPTANCE_DIST_READY=1
// ABS_NETWORK_ACCEPTANCE_ROOT=<fresh empty owned child>
// ABS_NETWORK_ACCEPTANCE_BUDGET_ROOT=<existing approved aggregate, <=1GiB>
// AGENT_BROWSER_CHROMIUM_BINARY_PATH=<explicit existing native executable>
//
// This is a hidden PRELOAD-CONTRACT + native headless Chromium lane. Unchanged
// dist/renderer/index.html and dist/main/preload.cjs are used, but frontend script
// subresources are DENIED in the exclusively owned UI session. In particular,
// init.js must not discover/execute system Firefox or start unrelated UI flows.
// No renderer API/IPC handler is replaced. Menu/dialog/visible Studio acceptance,
// external sites, cloud/export, fingerprint equivalence and storage durability
// are NOT attested. No top-level disk, socket, child, or browser operations.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { NetworkHeadlessAppHandle as HeadlessAppHandle } from "./helpers/network-headless-app.js";
import { readOwnedNativeArgv, NATIVE_ARGV_LIMITATIONS, type NativeArgvGenerationWitness } from "./helpers/native-argv.js";

const OPTED_IN = process.env.ABS_NETWORK_ACCEPTANCE === "1";
const REPO = path.resolve(__dirname, "../..");
const LOOPBACK = "127.0.0.1"; // Literal, exclusively owned listen(0) fixtures, not deployment configuration.
const GIB = 1024 ** 3, JSON_CAP = 256 * 1024, CONFIG_CAP = 2 * 1024 ** 2;
const CONTROL_DIAGNOSTIC_CAP = 64 * 1024;
const AGGREGATE_CAP = GIB, MIN_FREE = 6 * GIB;
const COUNTER_KEYS = ["requests", "hops", "responses", "finished", "failed", "blocked", "requestCancelled", "redirects", "http4xx", "http5xx", "pending", "cache", "serviceWorker", "unattributed", "cspIssues"] as const;
const CSP = "default-src 'none'; script-src 'self' 'report-sample'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
type Dict = Record<string, unknown>;
type Counts = Record<(typeof COUNTER_KEYS)[number], number>;
type Completion = "completed" | "partial" | "cancelled" | "unavailable";
const COVERAGE_SCHEMA = {
  network: ["observed", "partial", "unavailable"], csp: ["observed", "unavailable"],
  worker: ["not-observed"], oopif: ["not-observed"], console: ["not-observed"], storage: ["not-observed"],
  frames: ["selected-target-main-frame"], bridgeHop: ["unknown"], upstreamHop: ["unknown"],
} as const;
type Coverage = { [K in keyof typeof COVERAGE_SCHEMA]: (typeof COVERAGE_SCHEMA)[K][number] };
const NETWORK_HISTORY_SUMMARY_CODE = "NETWORK_OBSERVATION_V1";
const STOP_REASONS = ["window-ended", "cancelled", "deadline", "connection-closed", "target-changed", "setup-rejected", "setup-timeout", "protocol-invalid", "limit-exceeded", "evidence-incomplete", "cleanup-unverified"] as const;
interface Observation {
  version: 1; completion: Completion; stopReason: (typeof STOP_REASONS)[number]; armedAt: number | null; endedAt: number;
  counts: Counts; coverage: Coverage; durationMs: number;
}
// Canonical per-observation local IDs ONLY. requests counts admitted hop starts,
// including redirects: requests === hops === inventory.length. chainId and
// redirectedFrom preserve relationship; each exclusive terminal has ONE bucket.
interface Hop extends Dict {
  id: string; chainId: string; redirectedFrom: string | null; origin: string; method: string; resourceType: string;
  status: number | null; networkStatus: number | null;
  terminal: "pending" | "finished" | "failed" | "blocked" | "cancelled" | "redirected";
  errorCode: string | null; blockedReason: string | null; corsReason: string | null;
  fromDiskCache: boolean | null; fromServiceWorker: boolean | null; fromPrefetchCache: boolean | null; servedFromCache: boolean;
}
interface StatusEvidence extends Dict { id: string; chainId: string | null; hopId: string | null; status: number; source: "extra-info"; association: "unique" | "unknown" }
interface Reply extends Dict { ok: boolean; outcome: string; requestId?: string; observation?: Observation; hops?: Hop[]; httpStatusEvidence?: StatusEvidence[]; code?: string }
interface ControlFailureDiagnostic {
  control: "selected-a-a-initiates-to-b";
  observation: Pick<Observation, "completion" | "stopReason" | "counts" | "coverage">;
  hops: Array<Pick<Hop, "origin" | "status" | "networkStatus" | "terminal" | "errorCode" | "blockedReason" | "corsReason" | "fromDiskCache" | "fromServiceWorker" | "fromPrefetchCache" | "servedFromCache">>;
  httpStatusEvidence: Array<Pick<StatusEvidence, "status" | "association">>;
}
interface Selection { handle: string; origin: string; ordinal: number }
interface Armed { dirId: string; requestId: string; armedAt: number; observeForMs: 10000 }
interface Hidden { page: Page; windowId: number; webContentsId: number; label: string }
interface NativeOwner {
  id: string; pid: number; port: number; profileDir: string; witnessKey: string;
  browser?: Browser; control?: CDPSession; pages?: [Page, Page]; witness?: NativeArgvGenerationWitness;
  unsafe: boolean; closeAttempted?: boolean; mainCaptured?: boolean; cdpVersion?: string;
}
interface Receipt {
  schema: string; status: "running" | "assertions-complete-awaiting-outer-runner" | "failed" | "cleanup-unverified";
  phase: string; startedAt: string; finishedAt?: string; compiled: Record<string, string>; harness: Record<string, string>;
  executable: { path: string; sha256: string; frameworkSha256: string };
  cases: Dict[]; ownership: Dict[]; resources: unknown[]; cleanup: Dict[]; failures: Dict[];
  fixture?: Dict; limitations: readonly string[]; outerRunner: "exit-and-unhandled-error-result-required";
  productStopVerification: "not-exercised"; retiredPortAvailability: "not-probed-unverified";
}

function requireFact(condition: unknown, code: string): asserts condition {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function object(value: unknown, code: string): Dict {
  requireFact(value !== null && typeof value === "object" && !Array.isArray(value), code); return value as Dict;
}
const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
function safeFailure(error: unknown): Dict {
  // Never retain exception text/stack: protocol errors can contain a whole URL,
  // CSP sample, request body, header, or title even in this synthetic fixture.
  const value = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; networkCompletion?: unknown; networkStopReason?: unknown; networkPageSelectionCounts?: unknown } : {};
  const token = (candidate: unknown) => typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(candidate) ? candidate : "unavailable";
  // Only validated static enums and bounded fixture page counts may accompany
  // these failures. Never copy an observation, raw message, handles, URLs or prose.
  const completion = typeof value.networkCompletion === "string" && ["completed", "partial", "cancelled", "unavailable"].includes(value.networkCompletion) ? value.networkCompletion : undefined;
  const stopReason = typeof value.networkStopReason === "string" && (STOP_REASONS as readonly string[]).includes(value.networkStopReason) ? value.networkStopReason : undefined;
  const rawPageCounts = value.networkPageSelectionCounts;
  let pageCounts: { totalPages: number; fixtureA: number; fixtureB: number } | undefined;
  if (value.code === "TWO_DISTINCT_NATIVE_PAGE_SELECTIONS_REQUIRED" && rawPageCounts && typeof rawPageCounts === "object" && !Array.isArray(rawPageCounts)) {
    const counts = rawPageCounts as Record<string, unknown>;
    if (JSON.stringify(Object.keys(counts).sort()) === JSON.stringify(["fixtureA", "fixtureB", "totalPages"]) && ["totalPages", "fixtureA", "fixtureB"].every(key => Number.isInteger(counts[key]) && Number(counts[key]) >= 0 && Number(counts[key]) <= 32) && Number(counts.fixtureA) + Number(counts.fixtureB) === counts.totalPages) {
      pageCounts = { totalPages: Number(counts.totalPages), fixtureA: Number(counts.fixtureA), fixtureB: Number(counts.fixtureB) };
    }
  }
  return { name: token(value.name), code: token(value.code), rawMessage: "intentionally-not-retained",
    ...(completion === undefined ? {} : { networkCompletion: completion }), ...(stopReason === undefined ? {} : { networkStopReason: stopReason }),
    ...(pageCounts === undefined ? {} : { networkPageSelectionCounts: pageCounts }) };
}
function strictChild(root: string, child: string): void {
  const relative = path.relative(root, child);
  requireFact(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "OWNED_CHILD_REQUIRED");
}
function canonicalDirectory(input: string | undefined): string {
  requireFact(input && path.isAbsolute(input), "EXPLICIT_OWNED_DIRECTORY_REQUIRED");
  const stat = fs.lstatSync(input);
  requireFact(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && fs.realpathSync(input) === path.resolve(input), "CANONICAL_OWNED_DIRECTORY_REQUIRED");
  return input;
}
function boundedBytes(root: string, file: string, maximum = CONFIG_CAP): Buffer {
  strictChild(root, file);
  const stat = fs.lstatSync(file);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() && stat.size <= maximum, "BOUNDED_OWNED_FILE_REQUIRED");
  strictChild(fs.realpathSync(root), fs.realpathSync(file));
  return fs.readFileSync(file);
}
function resourceSnapshot(root: string, reserve = 0) {
  const owner = fs.lstatSync(root);
  requireFact(owner.isDirectory() && !owner.isSymbolicLink() && owner.uid === process.getuid?.() && fs.realpathSync(root) === root, "AGGREGATE_ROOT_OWNERSHIP_CHANGED");
  let total = 0, entries = 0, childEnoent = 0;
  const walk = (directory: string) => {
    let names: string[];
    try { names = fs.readdirSync(directory); }
    catch (error) {
      if (directory !== root && (error as NodeJS.ErrnoException).code === "ENOENT") { childEnoent++; return; }
      throw error; // Root ENOENT, permission, ownership and low-space errors never pass.
    }
    for (const name of names) {
      requireFact(++entries <= 50_000, "AGGREGATE_ENTRY_BUDGET");
      const file = path.join(directory, name); let stat: fs.Stats;
      try { stat = fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { childEnoent++; continue; } throw error; }
      requireFact(stat.uid === owner.uid, "AGGREGATE_CHILD_OWNERSHIP_CHANGED");
      total += stat.size; // Account for symlinks themselves; NEVER follow test/artifact links.
      requireFact(total + reserve <= AGGREGATE_CAP, "AGGREGATE_EXCEEDS_ONE_GIB");
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file);
    }
  };
  walk(root);
  const after = fs.lstatSync(root);
  requireFact(after.isDirectory() && !after.isSymbolicLink() && after.uid === owner.uid && after.dev === owner.dev && after.ino === owner.ino && fs.realpathSync(root) === root, "AGGREGATE_ROOT_CHANGED_DURING_SCAN");
  const volume = fs.statfsSync(root, { bigint: true }), freeBytes = volume.bavail * volume.bsize;
  requireFact(freeBytes >= BigInt(MIN_FREE + reserve), "DEVELOPMENT_RESERVE_BELOW_SIX_GIB");
  return { aggregateBytes: total, aggregateCapBytes: AGGREGATE_CAP, entries, childEnoent, freeBytes: freeBytes.toString(), minimumFreeBytes: MIN_FREE };
}
interface AwaitRoot {
  workEnd: number; cleanupEnd: number; timedOut: Set<string>;
  pending: Map<symbol, { label: string; end: number }>;
  cancelOwnedIo: Set<() => void>;
}
interface AwaitScope { root: AwaitRoot; end: number; cleaning: boolean }
// Memory-only context construction is inert; the root is created only inside it().
const awaitScopes = new AsyncLocalStorage<AwaitScope>();
function scopeNow(): AwaitScope {
  const scope = awaitScopes.getStore(); requireFact(scope && Date.now() < scope.end, "ABSOLUTE_OPERATION_DEADLINE");
  requireFact(scope.cleaning || scope.root.timedOut.size === 0, "EARLIER_TIMEOUT_CANNOT_RETRY_TO_GREEN"); return scope;
}
function remainingMs(maximum = Number.POSITIVE_INFINITY): number { return Math.max(1, Math.min(maximum, scopeNow().end - Date.now())); }
async function checked<T>(factory: () => T | PromiseLike<T>, label = "OWNED_ASYNC_DEADLINE"): Promise<T> {
  const scope = scopeNow(), end = scope.end, key = Symbol(label); let timer: ReturnType<typeof setTimeout> | undefined;
  scope.root.pending.set(key, { label, end });
  const expire = () => {
    scope.root.timedOut.add(label);
    // Only registered OWN HTTP requests/file streams/listener sockets are
    // cancelled here. NEVER a controller/native process or shared CDP client.
    for (const cancel of [...scope.root.cancelOwnedIo]) { try { cancel(); } catch { scope.root.timedOut.add("OWNED_IO_CANCEL_UNVERIFIED"); } }
    return Object.assign(new Error(label), { code: label });
  };
  const operation = Promise.resolve().then(() => { requireFact(Date.now() < end, label); return factory(); });
  operation.then(() => scope.root.pending.delete(key), () => scope.root.pending.delete(key));
  try {
    const value = await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(expire()), Math.max(1, end - Date.now())); })]);
    if (Date.now() >= end) throw expire(); // A delayed timer may NEVER permit late true/success.
    return value;
  } catch (error) { if (Date.now() >= end) scope.root.timedOut.add(label); throw error; }
  finally { if (timer) clearTimeout(timer); }
}
function deadline<T>(label: string, factory: () => T | PromiseLike<T>, milliseconds: number): Promise<T> {
  const parent = scopeNow();
  return awaitScopes.run({ ...parent, end: Math.min(parent.end, Date.now() + milliseconds) }, () => checked(factory, label));
}
async function until(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  return deadline(label, async () => {
    for (;;) {
      const value = await checked(condition, label); scopeNow(); if (value) return;
      await checked(() => new Promise<void>(resolve => setTimeout(resolve, remainingMs(75))), label);
    }
  }, timeoutMs);
}
async function fileHash(file: string): Promise<string> {
  const scope = scopeNow(), stream = fs.createReadStream(file), iterator = stream[Symbol.asyncIterator](), hash = createHash("sha256");
  const cancel = () => stream.destroy(Object.assign(new Error("OWNED_HASH_CANCELLED"), { code: "OWNED_HASH_CANCELLED" })); scope.root.cancelOwnedIo.add(cancel);
  try {
    for (;;) { const chunk = await checked(() => iterator.next(), "OWNED_HASH_READ_DEADLINE"); if (chunk.done) break; hash.update(chunk.value); }
    scopeNow(); return hash.digest("hex");
  } finally { scope.root.cancelOwnedIo.delete(cancel); stream.destroy(); }
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
async function request(port: number, token: string | null, method: string, route: string, body?: unknown) {
  const scope = scopeNow(), end = Math.min(scope.end, Date.now() + 15_000);
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: LOOPBACK, port, method, path: route, headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) }),
    } }, res => {
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > CONFIG_CAP) req.destroy(Object.assign(new Error("REST_REPLY_BUDGET"), { code: "REST_REPLY_BUDGET" })); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => { try { requireFact(Date.now() < end, "REST_LATE_RESPONSE_REJECTED"); resolve({ status: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); } });
    });
    const cancel = () => req.destroy(Object.assign(new Error("OWNED_REST_CANCELLED"), { code: "OWNED_REST_CANCELLED" }));
    scope.root.cancelOwnedIo.add(cancel);
    const timer = setTimeout(() => { scope.root.timedOut.add("REST_ABSOLUTE_DEADLINE"); cancel(); }, Math.max(1, end - Date.now()));
    req.once("close", () => { clearTimeout(timer); scope.root.cancelOwnedIo.delete(cancel); });
    req.setTimeout(Math.max(1, end - Date.now()), cancel);
    req.on("error", reject); req.end(data);
  });
}

/** Real HTTP proxy. It has NO forwarding, DNS lookup, fetch, CONNECT tunnelling,
 * route.abort, host mapping, or upstream transport. Only the two exact reserved
 * .invalid origins below can obtain a local response. Raw HTTP fields/bodies are
 * compared in memory then discarded; the journal contains finite counters only. */
async function startFixture(origins: [string, string], sentinels: Record<string, string>) {
  type Socket = import("node:stream").Duplex;
  type Scope = "HTTP" | "CONNECT" | "UPGRADE" | "shutdown";
  // Fixture policy ONLY: strict self script/CSP controls are unchanged. connect
  // explicitly permits these TWO owned origins so destination filtering cannot
  // masquerade as initiating-target isolation. This is not a production UI CSP change.
  const fixturePolicy = CSP.replace("connect-src 'self'", `connect-src 'self' ${origins.join(" ")}`);
  const sockets = new Set<Socket>(), denied = new Map<Socket, Scope>();
  const holds = new Set<http.ServerResponse>(), timers = new Set<ReturnType<typeof setTimeout>>();
  const stats = { requests: 0, a: 0, b: 0, success: 0, redirects: 0, final: 0, forbidden: 0, limited: 0, unavailable: 0, posts: 0,
    bodyMatched: 0, requestHeaderMatched: 0, cookieMatched: 0, responseSentinelsServed: 0, secondary: 0, crossToA: 0, crossToB: 0, held: 0,
    deniedHttp: 0, deniedConnect: 0, deniedUpgrade: 0, scopedResets: 0, unexpectedSocketErrors: 0, overBudget: false };
  let closed = false, closing = false, receivedBytes = 0;
  const scripts = `(() => {
    const mark = (id, text) => { document.getElementById(id).textContent = String(text); };
    let csp = 0, mixed = 0, success = 0, secondary = 0, cross = 0, held = 0, failures = 0;
    // FIXTURE-only browser-side event counter, NOT the passive observer's cspIssues.
    // Actual site violations do not establish selected-root-frame Audits attribution.
    document.addEventListener('securitypolicyviolation', () => { mark('csp-count', ++csp); });
    const url = kind => '/' + ${JSON.stringify(sentinels.path)} + '/' + kind + '?probe=' + ${JSON.stringify(sentinels.query)};
    // Fixture driver completion means the synthetic body was consumed, not
    // merely that response headers arrived. Never retain or expose the body.
    const fetchStatus = async (kind, options) => { const response = await fetch(url(kind), options); await response.text(); return response.status; };
    document.getElementById('mixed').addEventListener('click', async () => {
      try {
        const statuses = [];
        for (const kind of ['success', 'redirect', 'forbidden', 'limited', 'unavailable']) statuses.push(await fetchStatus(kind));
        statuses.push(await fetchStatus('post', {method:'POST', headers:{'Content-Type':'text/plain','X-Abs-Synthetic':${JSON.stringify(sentinels.requestHeader)}}, body:${JSON.stringify(sentinels.requestBody)}}));
        const inline = document.createElement('script'); inline.textContent = '/*' + ${JSON.stringify(sentinels.errorSample)} + '*/window.__absInlineRan = true;'; document.head.appendChild(inline);
        const image = new Image(); image.src = url('csp-image'); document.body.appendChild(image);
        mark('statuses', statuses.join(',')); mark('mixed-done', ++mixed);
      } catch (_) { mark('driver-error', 'mixed'); }
    });
    document.getElementById('success').addEventListener('click', async () => { try { mark('success-status', await fetchStatus('success')); mark('success-done', ++success); } catch (_) { mark('driver-error', 'success'); } });
    document.getElementById('secondary').addEventListener('click', async () => { try { mark('secondary-status', await fetchStatus('secondary')); mark('secondary-done', ++secondary); } catch (_) { mark('driver-error', 'secondary'); } });
    const otherOrigin = location.origin === ${JSON.stringify(origins[0])} ? ${JSON.stringify(origins[1])} : ${JSON.stringify(origins[0])};
    document.getElementById('cross').addEventListener('click', async () => { try { const response = await fetch(otherOrigin + url('cross'), {mode:'cors'}); await response.text(); mark('cross-status', response.status); mark('cross-done', ++cross); } catch (_) { mark('driver-error', 'cross'); } });
    document.getElementById('held').addEventListener('click', async () => { try { mark('held-status', await fetchStatus('hold')); mark('held-done', ++held); } catch (_) { mark('held-done', ++held); } });
    document.getElementById('failure').addEventListener('click', async () => { try { mark('failure-status', await fetchStatus('proxy-failure')); } catch (_) { mark('failure-done', ++failures); } });
    document.documentElement.dataset.fixtureReady = 'true';
  })();`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${sentinels.title}</title></head><body><h1>Owned network fixture</h1>
    <button id="mixed">Mixed</button><button id="success">Success</button><button id="secondary">Secondary</button><button id="cross">Other owned origin</button><button id="held">Held</button><button id="failure">Proxy failure</button>
    <output id="mixed-done">0</output><output id="success-done">0</output><output id="secondary-done">0</output><output id="cross-done">0</output><output id="cross-status"></output><output id="held-done">0</output><output id="failure-done">0</output>
    <output id="statuses"></output><output id="success-status"></output><output id="secondary-status"></output><output id="held-status"></output><output id="failure-status"></output><output id="driver-error"></output><output id="csp-count">0</output>
    <script src="/${sentinels.path}/fixture.js"></script></body></html>`;
  const noteError = (socket: Socket, error: NodeJS.ErrnoException) => {
    if (denied.has(socket) && ["ECONNRESET", "EPIPE"].includes(error.code || "")) stats.scopedResets++;
    else stats.unexpectedSocketErrors++;
    if (stats.scopedResets > 256 || stats.unexpectedSocketErrors > 16) stats.overBudget = true;
  };
  const rejectSocket = (socket: Socket, scope: Scope) => {
    denied.set(socket, scope);
    if (sockets.size > 128 || stats.deniedConnect + stats.deniedUpgrade > 256) { stats.overBudget = true; socket.destroy(); return; }
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  };
  const server = http.createServer((req, res) => {
    if (++stats.requests > 256) { stats.overBudget = true; denied.set(req.socket, "HTTP"); req.socket.destroy(); return; }
    let url: URL;
    try { url = new URL(req.url || ""); }
    catch { stats.deniedHttp++; denied.set(req.socket, "HTTP"); res.writeHead(400, { connection: "close" }).end(); return; }
    if (!origins.includes(url.origin) || url.username || url.password || req.headers.host !== url.host || !/^http:\/\//.test(req.url || "")) {
      stats.deniedHttp++; denied.set(req.socket, "HTTP"); res.writeHead(403, { connection: "close" }).end(); return;
    }
    if (url.origin === origins[0]) stats.a++; else stats.b++;
    const kind = url.pathname.startsWith(`/${sentinels.path}/`) ? url.pathname.slice(sentinels.path.length + 2) : "";
    if (req.headers.authorization || req.headers["proxy-authorization"] || req.headers["transfer-encoding"] || !["GET", "POST"].includes(req.method || "") || (req.method === "POST") !== (kind === "post")) {
      stats.deniedHttp++; denied.set(req.socket, "HTTP"); res.writeHead(400, { connection: "close" }).end(); return;
    }
    if (kind !== "post" && Number(req.headers["content-length"] || 0) !== 0) { stats.deniedHttp++; res.writeHead(400, { connection: "close" }).end(); return; }
    if ((req.headers.cookie || "").includes(`${sentinels.cookieName}=${sentinels.cookieValue}`)) stats.cookieMatched++;
    const send = (status: number, body = sentinels.responseBody, extra: Record<string, string> = {}) => {
      stats.responseSentinelsServed++;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body),
        "content-security-policy": fixturePolicy, "x-content-type-options": "nosniff", "x-abs-synthetic": sentinels.responseHeader, ...extra }); res.end(body);
    };
    if (kind === "page") send(200, html, { "content-type": "text/html; charset=utf-8", "set-cookie": `${sentinels.cookieName}=${sentinels.cookieValue}; Path=/; SameSite=Lax` });
    else if (kind === "fixture.js") send(200, scripts, { "content-type": "text/javascript; charset=utf-8" });
    else if (kind === "success") { stats.success++; send(200); }
    else if (kind === "redirect") { stats.redirects++; send(302, "", { location: `/${sentinels.path}/final?probe=${sentinels.query}` }); }
    else if (kind === "final") { stats.final++; send(200); }
    else if (kind === "forbidden") { stats.forbidden++; send(403); }
    else if (kind === "limited") { stats.limited++; send(429); }
    else if (kind === "unavailable") { stats.unavailable++; send(503); }
    else if (kind === "secondary" && url.origin === origins[1]) { stats.secondary++; send(200); }
    else if (kind === "cross") {
      const initiator = req.headers.origin;
      if (typeof initiator !== "string" || !origins.includes(initiator) || initiator === url.origin) { stats.deniedHttp++; send(403); return; }
      if (url.origin === origins[0]) stats.crossToA++; else stats.crossToB++;
      send(200, sentinels.responseBody, { "access-control-allow-origin": initiator, vary: "Origin" }); // Exact owned origin ONLY, no wildcard/credential relaxation.
    }
    else if (kind === "post") {
      const chunks: Buffer[] = []; let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length; receivedBytes += chunk.length;
        if (size > 4096 || receivedBytes > 64 * 1024) { stats.overBudget = true; denied.set(req.socket, "HTTP"); req.destroy(); }
        else chunks.push(chunk);
      });
      req.on("end", () => {
        stats.posts++;
        if (Buffer.concat(chunks).toString("utf8") === sentinels.requestBody) stats.bodyMatched++;
        if (req.headers["x-abs-synthetic"] === sentinels.requestHeader) stats.requestHeaderMatched++;
        send(200);
      });
      req.on("error", (error: NodeJS.ErrnoException) => noteError(req.socket, error));
    } else if (kind === "hold") {
      stats.held++; if (holds.size >= 4) { stats.overBudget = true; send(503); return; }
      holds.add(res);
      const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) send(200); }, 12_000); timers.add(timer);
      res.once("close", () => { clearTimeout(timer); timers.delete(timer); holds.delete(res); });
    } else if (url.pathname === "/favicon.ico") { res.writeHead(204, { "cache-control": "no-store" }).end(); }
    else { stats.deniedHttp++; send(404); }
  });
  server.on("connection", socket => {
    sockets.add(socket); socket.on("error", (error: NodeJS.ErrnoException) => noteError(socket, error));
    socket.once("close", () => { sockets.delete(socket); denied.delete(socket); });
    if (sockets.size > 128) { stats.overBudget = true; denied.set(socket, "HTTP"); socket.destroy(); }
  });
  server.on("connect", (_req, socket) => { stats.deniedConnect++; rejectSocket(socket, "CONNECT"); });
  server.on("upgrade", (_req, socket) => { stats.deniedUpgrade++; rejectSocket(socket, "UPGRADE"); });
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => { noteError(socket, error); socket.destroy(); });
  server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  const fixtureScope = scopeNow();
  const cancelFixtureIo = () => {
    for (const socket of sockets) { denied.set(socket, "shutdown"); socket.destroy(); }
    if (!closing && !closed && server.listening) { closing = true; server.close(error => { if (error) stats.unexpectedSocketErrors++; else closed = true; }); }
  };
  fixtureScope.root.cancelOwnedIo.add(cancelFixtureIo);
  server.once("listening", () => { if (Date.now() >= fixtureScope.end || fixtureScope.root.timedOut.size) cancelFixtureIo(); });
  server.once("close", () => fixtureScope.root.cancelOwnedIo.delete(cancelFixtureIo));
  await checked(async () => (new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, LOOPBACK, () => { server.off("error", reject); resolve(); }); })));
  const address = server.address(); requireFact(address && typeof address !== "string", "FIXTURE_DYNAMIC_PORT_REQUIRED");
  server.on("error", () => { stats.unexpectedSocketErrors++; });
  const snapshot = () => ({ ...stats, activeSockets: sockets.size, activeHolds: holds.size, receivedBytes, closed });
  const assertHealthy = () => requireFact(!stats.overBudget && stats.unexpectedSocketErrors === 0, "FIXTURE_TRANSPORT_OR_RESOURCE_FAILURE");
  return { port: address.port, snapshot, assertHealthy,
    pageUrl: (index: 0 | 1) => `${origins[index]}/${sentinels.path}/page?probe=${sentinels.query}#${sentinels.fragment}`,
    failureUrl: `${origins[0]}/${sentinels.path}/proxy-failure?probe=${sentinels.query}`,
    releaseHolds() { for (const res of holds) { if (!res.destroyed) res.writeHead(200, { "content-length": "0" }).end(); } },
    async close() {
      if (closed) { assertHealthy(); return; }
      requireFact(!closing, "FIXTURE_CLOSE_ALREADY_PENDING"); closing = true;
      for (const timer of timers) clearTimeout(timer); timers.clear();
      await checked(async () => (deadline("FIXTURE_CLOSE_DEADLINE", () => (new Promise<void>((resolve, reject) => {
        const pendingSockets = [...sockets].map(socket => new Promise<void>(done => socket.once("close", () => done())));
        const listener = new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
        // This is the actual proxy-failure action too: only our listener and
        // owned accepted sockets close. The native browser/page stays running.
        for (const socket of sockets) { denied.set(socket, "shutdown"); socket.destroy(); }
        Promise.all([listener, ...pendingSockets]).then(() => resolve(), reject);
      })), 6_000)));
      closed = true; requireFact(sockets.size === 0 && holds.size === 0, "FIXTURE_SOCKETS_NOT_DRAINED"); assertHealthy();
    }, scriptSha256: sha(scripts), policy: fixturePolicy };
}

describe.skipIf(!OPTED_IN)("owned actual-app hidden preload / native selected-page network acceptance", () => {
  it("observes finite local traffic honestly, fences ownership/clear/restart, and retains only typed health summaries", async () => {
    const started = Date.now();
    const awaitRoot: AwaitRoot = { workEnd: started + 500_000, cleanupEnd: started + 585_000, timedOut: new Set(), pending: new Map(), cancelOwnedIo: new Set() };
    awaitScopes.enterWith({ root: awaitRoot, end: awaitRoot.workEnd, cleaning: false });
    // Collection is inert. All environment, source, mount, disk and binary checks
    // live INSIDE the explicitly selected test, before their corresponding effects.
    requireFact(process.platform === "darwin", "NATIVE_ARGV_MACOS_LANE_REQUIRED");
    requireFact(process.env.ABS_NETWORK_ACCEPTANCE_DIST_READY === "1", "FRESH_DIST_RECEIPT_REQUIRED");
    requireFact(process.env.AGENT_BROWSER_E2E_UNSANDBOXED !== "1", "UNSANDBOXED_LANE_FORBIDDEN");
    requireFact(process.env.AGENT_BROWSER_E2E_TRACE !== "1" && process.env.CLOAK_E2E_TRACE !== "1", "RAW_CONTROLLER_TRACE_FORBIDDEN");
    const aggregate = canonicalDirectory(process.env.ABS_NETWORK_ACCEPTANCE_BUDGET_ROOT);
    const root = canonicalDirectory(process.env.ABS_NETWORK_ACCEPTANCE_ROOT); strictChild(aggregate, root);
    const rootOwner = fs.lstatSync(root), aggregateOwner = fs.lstatSync(aggregate);
    function assertRootIdentities(): void {
      for (const [directory, expected] of [[root, rootOwner], [aggregate, aggregateOwner]] as const) {
        const current = fs.lstatSync(directory);
        requireFact(current.isDirectory() && !current.isSymbolicLink() && current.uid === expected.uid && current.dev === expected.dev && current.ino === expected.ino && fs.realpathSync(directory) === directory, "LIFETIME_ROOT_OWNERSHIP_CHANGED");
      }
    }
    requireFact(fs.readdirSync(root).length === 0 && rootOwner.dev === aggregateOwner.dev, "FRESH_EMPTY_SAME_VOLUME_ROOT_REQUIRED");
    if (aggregate.startsWith("/Volumes/")) {
      // Private local metadata is read without printing/copying its contents.
      for (const name of ["RULES.md", "INDEX.md"]) requireFact(fs.readFileSync(path.join("/Users/ahoo/.local/share/agent-storage", name)).length > 0, "STORAGE_METADATA_REQUIRED");
      execFileSync("python3", ["/Users/ahoo/.local/share/agent-storage/move_verified_storage.py", "check-mount"], { stdio: "pipe", timeout: 15_000, maxBuffer: 16 * 1024 });
    }
    const initialResources = resourceSnapshot(aggregate, 128 * 1024 ** 2);
    const binaryInput = process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH;
    requireFact(binaryInput && path.isAbsolute(binaryInput), "EXPLICIT_EXISTING_CHROMIUM_REQUIRED_NO_DISCOVERY");
    const binary = fs.realpathSync(binaryInput); requireFact(fs.statSync(binary).isFile(), "CHROMIUM_REGULAR_EXECUTABLE_REQUIRED");
    fs.accessSync(binary, fs.constants.X_OK);
    const framework = fs.realpathSync(path.resolve(path.dirname(binary), "../Frameworks/Chromium Framework.framework/Versions/Current/Chromium Framework"));
    const binarySha = await checked(async () => (fileHash(binary))), frameworkSha = await checked(async () => (fileHash(framework)));
    const frozenPaths = ["main/index.js", "main/preload.cjs", "main/ipc/browser.js", "main/services/config-manager.js", "main/services/profile-health.js", "main/services/browser-manager.js", "main/services/browser-engine.js", "main/services/browser/runtime-table.js", "main/services/renderer-storage.js", "main/services/automation.js", "main/services/rest-api-server.js", "main/services/mcp-server.js", "main/services/secrets.js", "renderer/index.html"];
    const compiledIdentity = () => Object.fromEntries(frozenPaths.map(relative => [relative, sha(boundedBytes(path.join(REPO, "dist"), path.join(REPO, "dist", relative), 16 * 1024 ** 2))]));
    const compiled = compiledIdentity();
    // The coordinator wrapper also hashes helpers/**/*.ts. Bind the one new
    // helper and its existing inert environment/native-witness dependencies here.
    const harnessPaths = ["tests/e2e/network-diagnostics-acceptance.test.ts", "tests/e2e/helpers/network-headless-app.ts", "tests/e2e/helpers/launch-env.ts", "tests/e2e/helpers/native-argv.ts"];
    const harnessIdentity = () => Object.fromEntries(harnessPaths.map(relative => [relative, sha(boundedBytes(REPO, path.join(REPO, relative)))]));
    const harness = harnessIdentity();
    for (const relative of ["main/preload.cjs", "renderer/index.html"]) requireFact(compiled[relative] === sha(boundedBytes(path.join(REPO, "src"), path.join(REPO, "src", relative))), "STALE_COPIED_PRELOAD_OR_RENDERER");
    const rendererHtml = boundedBytes(path.join(REPO, "dist"), path.join(REPO, "dist/renderer/index.html")).toString("utf8");
    const cspMeta = rendererHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
    requireFact(typeof cspMeta === "string" && cspMeta.split(";").some(directive => directive.trim() === "script-src 'self'"), "ORIGINAL_STRICT_SCRIPT_CSP_REQUIRED");
    requireFact(!/\b(?:nonce-|sha256-|unsafe-eval|unsafe-inline)\b/.test(cspMeta.split(";").find(directive => directive.trim().startsWith("script-src")) || ""), "INLINE_BOOTSTRAP_CSP_CAPABILITY_FORBIDDEN");
    for (const script of rendererHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) requireFact(/\bsrc\s*=/.test(script[1]) && script[2].trim() === "", "INLINE_RENDERER_BOOTSTRAP_FORBIDDEN");
    const { assertChromiumReuseEvidence, chromiumLaunchRequestHash } = await checked(async () => (import("../../src/main/services/browser/launch-provenance.js")));
    const { readChromiumGpuContext } = await checked(async () => (import("../../src/main/services/browser/chromium-gpu-context.js")));
    const owned = fs.mkdtempSync(path.join(root, "network-")), ownedStat = fs.lstatSync(owned);
    const runTag = randomUUID().replaceAll("-", "");
    const origins: [string, string] = [`http://network-a-${runTag}.invalid`, `http://network-b-${runTag}.invalid`];
    const sentinels = Object.fromEntries(["path", "query", "fragment", "title", "requestHeader", "responseHeader", "requestBody", "responseBody", "cookieName", "cookieValue", "errorSample"].map(key => [key, `abs_${key}_${runTag}`]));
    sentinels.errorSample = `abs_err_${runTag.slice(0, 12)}`; // Complete sentinel fits at the START of a native 40-character CSP sample.
    const receipt: Receipt = { schema: "owned-hidden-preload-native-network/v1", status: "running", phase: "startup", startedAt: new Date().toISOString(), compiled, harness,
      executable: { path: binary, sha256: binarySha, frameworkSha256: frameworkSha }, cases: [], ownership: [], resources: [initialResources], cleanup: [], failures: [],
      outerRunner: "exit-and-unhandled-error-result-required", productStopVerification: "not-exercised", retiredPortAvailability: "not-probed-unverified", limitations: [
        "Production normal-stop discovery/adoption is an unresolved separate boundary, NOT exercised or repaired here. Native cleanup is a test-driver Browser.close CDP command on the existing connection, gated by the exact main RunningEntry/ChildProcess/fresh-launch/unique-port/native argv/browser-PID witnesses. The observer itself must never stop a browser.",
        "No retired CDP port is reconnected or queried after owned PID exit. Only actual owned process exit, existing CDP disconnection, held ChildProcess exit and cached runtime release are checked; retired-port availability is not-probed/unverified.",
        "One absolute clock reserves work through 500s, cleanup through 585s, and a 600s Vitest ceiling. Await/predicate/remote-main/HTTP guards check before and after awaits; timed-out work and pending losers are latched failures, not retried into success. Only owned client transports/HTTP/file/listener resources are disposed; unknown native ownership is retained cleanup-unverified.",
        "Canonical inventory semantics: local id/chainId/redirectedFrom only; requests and hops each equal admitted request-hop inventory length including redirects. Exclusive finished/failed/blocked/cancelled/redirected/pending buckets partition hops; blocked/cancelled are NOT failed. Responses/status/source counters reconcile with canonical safe hop fields and separately typed httpStatusEvidence; ambiguous wire evidence is never assigned to a hop or fabricated HTTP-failure cause. Without positive selected-root-frame attribution, CSP coverage is unavailable and cspIssues must stay zero. The passive observer does not resolve backend DOM nodes to manufacture attribution; the fixture page's independent securitypolicyviolation counter does not provide observer attribution.",
        "Hidden PRELOAD-CONTRACT only: unchanged index/preload, ALL frontend script subresources blocked in the exclusively owned persist:app UI session. Renderer menu/dialog/bootstrap flows and visible/unlocked Studio GUI are not tested.",
        "Actual native headless Chromium and an HTTP proxy that never forwards or resolves upstream; two reserved .invalid origins. Independent fixture scripts consume their synthetic response bodies before reporting done but never retain/expose their contents. These driver actions are not observer-side evaluation, interception, cache disabling, navigation or response-body reads.",
        "Only a finite selected-page window is measured. Quiet, incomplete, cancelled, unsupported and clean finite traffic never establish website/proxy health PASS. Worker/OOPIF, console, storage and unknown fault-hop/auth/fingerprint attribution stay outside this claim.",
        "Product origin/detail/opaque page handles remain memory-only and never enter app config/history or renderer localStorage. Explicit test-evidence exception: ONLY a failed selected-A/A-to-B control may retain a <=64KiB validated typed projection in this owned test receipt, including exact synthetic fixture origins at diagnostic hop.origin. No raw events, full URLs, headers, cookies, bodies, titles, exception samples or stderr are retained. Native browser's own fixture browsing data is not application diagnostic history.",
        "General data export/cloud are deliberately not exercised; no exclusion acceptance for those outputs is claimed. No screenshot is taken; no visual acceptance is implied.",
        "Observed active-run HEALTH_BUSY plus awaited cancellation/result/cleanup is not an atomic internal lease-release timing oracle. Internal lease/global-slot/renderer-slot edge matrices require the Stage3 unit/DOM gates too.",
        "Source-guided startup review found engine-status discovery in request handlers/explicit Firefox launch, not fresh headless index/scheduler/listener startup. This is NOT transitive startup runtime proof. Fresh empty profiles/rules/config and the existing normal mock-keychain switch are required before hidden windows; absent evidence blocks execution, never triggers an override or handler stub.",
        "No source/App/browser copies, downloads, installed-App/profile access, license mutation, keychain interaction, native rebuild, global TMPDIR mutation, old-data deletion, or retry-to-green is authorized.",
        "This receipt can only become assertions-complete-awaiting-outer-runner, never an overall acceptance PASS; outer runner exit and unhandled-error results remain authoritative.",
        ...NATIVE_ARGV_LIMITATIONS,
      ] };
    let fixture: Awaited<ReturnType<typeof startFixture>> | undefined, controller: HeadlessAppHandle | undefined, native: NativeOwner | undefined;
    let controllerLaunchPending = false, nativeLaunchPending = false, budgetFailure: unknown, cleaning = false;
    let controlFailureDiagnostic: ControlFailureDiagnostic | undefined, controlFailureDiagnosticUnavailable: Dict | undefined;
    let budgetTimer: ReturnType<typeof setInterval> | undefined, stderrBytes = 0, stderrTail = "", controllerUnhandled = 0, rendererErrors = 0, runnerUnhandled = 0;
    const hidden: Hidden[] = [], activeRuns = new Map<number, { dirId: string; requestId: string }>();
    const workDeadline = awaitRoot.workEnd;
    const ownedDriverSessions = new Map<CDPSession, { detachStarted: boolean }>();
    const pendingDriverConnects = new Set<Promise<Browser>>();
    const ownedDriverClients = new Set<Browser>();
    function mainUnhandledLogCount(): number {
      if (!controller) return 0;
      const directory = path.join(controller.userDataDir, "logs"), stat = fs.lstatSync(directory);
      requireFact(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.(), "OWNED_MAIN_LOG_DIRECTORY_REQUIRED");
      strictChild(fs.realpathSync(controller.userDataDir), fs.realpathSync(directory));
      const names = fs.readdirSync(directory).filter(name => /^agent-browser-\d{8}(?:-\d+)?\.log$/.test(name));
      requireFact(names.length >= 1 && names.length <= 8, "BOUNDED_MAIN_STRUCTURED_LOG_REQUIRED");
      let bytes = 0, errors = 0;
      for (const name of names) {
        const content = boundedBytes(controller.userDataDir, path.join(directory, name), 1024 * 1024); bytes += content.length;
        requireFact(bytes <= 2 * 1024 * 1024, "MAIN_STRUCTURED_LOG_READ_BUDGET");
        for (const line of content.toString("utf8").split("\n").filter(Boolean)) {
          const entry = object(JSON.parse(line), "STRUCTURED_MAIN_LOG_ENTRY_REQUIRED");
          if (/^app\.(?:unhandled-rejection|uncaught-exception)$/.test(String(entry.event))) errors++;
        }
      }
      return errors; // Read original owned log only; never retain/print messages, fields or stacks.
    }
    function checkpoint(reserve = JSON_CAP): void {
      if (budgetFailure) throw budgetFailure;
      controllerUnhandled = Math.max(controllerUnhandled, mainUnhandledLogCount());
      requireFact(cleaning || Date.now() < workDeadline, "WORK_DEADLINE_CLEANUP_RESERVE");
      requireFact(!controllerUnhandled && !rendererErrors && !runnerUnhandled, "UNHANDLED_RUNTIME_ERROR");
      assertRootIdentities(); resourceSnapshot(aggregate, reserve); fixture?.assertHealthy();
    }
    const onRunnerUnhandled = () => { runnerUnhandled++; };
    const onStderr = (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 512 * 1024) budgetFailure = Object.assign(new Error("CONTROLLER_STDERR_BUDGET"), { code: "CONTROLLER_STDERR_BUDGET" });
      const current = stderrTail + data.toString("utf8");
      if (/UnhandledPromiseRejection|unhandled[ -]rejection|uncaught[ -]exception|unhandled[ -]error/i.test(current)) controllerUnhandled++;
      stderrTail = current.slice(-512); // Bounded volatile matching only; never a log/receipt.
    };
    function privateSurface(value: unknown, surface: string, allowCurrentOrigin = false): void {
      const text = JSON.stringify(value);
      requireFact(typeof text === "string" && Buffer.byteLength(text) <= JSON_CAP, `PAYLOAD_BUDGET_${surface}`);
      requireFact(!Object.values(sentinels).some(marker => text.includes(marker)), `PRIVACY_SENTINEL_${surface}`);
      if (!allowCurrentOrigin) requireFact(!origins.some(origin => text.includes(origin)) && !text.includes(runTag), `PERSISTED_ORIGIN_OR_HANDLE_${surface}`);
    }
    function token(value: unknown, code: string): asserts value is string { requireFact(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), code); }
    function counts(value: unknown): Counts {
      const result = object(value, "TYPED_NETWORK_COUNTS_REQUIRED");
      requireFact(JSON.stringify(Object.keys(result).sort()) === JSON.stringify([...COUNTER_KEYS].sort()), "NETWORK_COUNTER_WHITELIST");
      for (const key of COUNTER_KEYS) requireFact(Number.isSafeInteger(result[key]) && Number(result[key]) >= 0 && Number(result[key]) <= 256, "BOUNDED_NETWORK_COUNTER_REQUIRED");
      return result as Counts;
    }
    function coverage(value: unknown): Coverage {
      const result = object(value, "STRICT_SCALAR_NETWORK_COVERAGE_REQUIRED");
      requireFact(JSON.stringify(Object.keys(result).sort()) === JSON.stringify(Object.keys(COVERAGE_SCHEMA).sort()), "COVERAGE_EXACT_FIELD_WHITELIST");
      for (const [key, choices] of Object.entries(COVERAGE_SCHEMA)) requireFact(typeof result[key] === "string" && (choices as readonly string[]).includes(result[key] as string), "COVERAGE_SCALAR_ENUM_REQUIRED_NO_NESTED_CLAIMS");
      privateSurface(result, "coverage"); return result as Coverage;
    }
    function noPass(value: Dict): void {
      requireFact(typeof value.outcome === "string" && ["warn", "risk", "error", "unavailable", "inconclusive", "cancelled"].includes(value.outcome), "FINITE_OBSERVATION_MUST_NOT_CLAIM_PASS");
      for (const key of Object.keys(value)) requireFact(!/(?:website|proxy).*(?:healthy|health|pass)|^(?:pass|passed)$/i.test(key), "FABRICATED_WEBSITE_PROXY_VERDICT");
    }
    function observation(value: unknown): Observation {
      const result = object(value, "OBSERVATION_REQUIRED"); privateSurface(result, "observation", true);
      requireFact(result.version === 1 && ["completed", "partial", "cancelled", "unavailable"].includes(String(result.completion)), "OBSERVATION_VERSION_COMPLETION");
      requireFact(JSON.stringify(Object.keys(result).sort()) === JSON.stringify(["version", "completion", "stopReason", "armedAt", "endedAt", "durationMs", "counts", "coverage"].sort()), "EXACT_CANONICAL_OBSERVATION_FIELDS_REQUIRED");
      requireFact(STOP_REASONS.includes(result.stopReason as any), "CANONICAL_STOP_REASON_ENUM_REQUIRED");
      requireFact(Number.isSafeInteger(result.endedAt) && Number(result.endedAt) >= 0 && typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0 && result.durationMs <= 20_000, "OBSERVATION_TIMING_BUDGET");
      if (result.armedAt === null) requireFact(result.completion === "unavailable" && result.durationMs === 0, "UNARMED_OBSERVATION_CANNOT_HAVE_MEASURED_DURATION");
      else requireFact(Number.isSafeInteger(result.armedAt) && Number(result.armedAt) >= 0 && Number(result.endedAt) >= Number(result.armedAt) && result.durationMs === Number(result.endedAt) - Number(result.armedAt), "MAIN_DERIVED_OBSERVATION_TIMING_MUST_RECONCILE");
      counts(result.counts); coverage(result.coverage);
      return result as unknown as Observation;
    }
    function rejectRawFields(value: unknown): void {
      let nodes = 0;
      const walk = (item: unknown, depth: number) => {
        requireFact(++nodes <= 8_192 && depth <= 12, "CURRENT_IPC_STRUCTURE_BUDGET");
        if (!item || typeof item !== "object") return;
        if (Array.isArray(item)) { for (const child of item) walk(child, depth + 1); return; }
        for (const [key, child] of Object.entries(item)) {
          if (key === "coverage") { coverage(child); continue; } // Typed coverage may explicitly say console/storage are unobserved.
          requireFact(!/^(?:url(?:path|query|fragment)?|fullUrl|request(?:Headers?|Body|Url)|response(?:Headers?|Body)|headers?|cookies?|postData|body|pageTitle|title|errorText|exception|stack|sample|console|stderr|raw.*|events)$/i.test(key), "RAW_NETWORK_IPC_FIELD_FORBIDDEN");
          walk(child, depth + 1);
        }
      };
      walk(value, 0);
    }
    function retainedObservation(value: Observation): Dict {
      // Never copy optional producer fields into a receipt, even on failure.
      return { version: value.version, completion: value.completion, stopReason: value.stopReason, armedAt: value.armedAt, endedAt: value.endedAt,
        counts: counts(value.counts), coverage: coverage(value.coverage), durationMs: value.durationMs };
    }
    function reconcileInventory(observed: Observation, hops: Hop[], evidence: StatusEvidence[]): void {
      const hopKeys = ["id", "chainId", "redirectedFrom", "origin", "method", "resourceType", "status", "networkStatus", "terminal", "errorCode", "blockedReason", "corsReason", "fromDiskCache", "fromServiceWorker", "fromPrefetchCache", "servedFromCache"].sort();
      const total = Object.fromEntries(COUNTER_KEYS.map(key => [key, 0])) as Counts;
      const inventory = new Map<string, Hop>();
      for (const hop of hops) {
        requireFact(JSON.stringify(Object.keys(hop).sort()) === JSON.stringify(hopKeys), "CANONICAL_HOP_FIELDS_ONLY_NO_NATIVE_REQUEST_ID_OR_ALIASES");
        token(hop.chainId, "OPAQUE_LOCAL_CHAIN_ID_REQUIRED");
        requireFact(["pending", "finished", "failed", "blocked", "cancelled", "redirected"].includes(hop.terminal), "EXCLUSIVE_CANONICAL_HOP_TERMINAL_REQUIRED");
        requireFact(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "OTHER"].includes(hop.method), "CANONICAL_HTTP_METHOD_ENUM_REQUIRED");
        requireFact(["Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket", "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "FedCM", "Other"].includes(hop.resourceType), "CANONICAL_RESOURCE_TYPE_ENUM_REQUIRED");
        for (const status of [hop.status, hop.networkStatus]) requireFact(status === null || Number.isInteger(status) && status >= 100 && status <= 599, "BROWSER_OR_UNIQUELY_ASSOCIATED_WIRE_STATUS_REQUIRED");
        for (const key of ["fromDiskCache", "fromServiceWorker", "fromPrefetchCache"] as const) requireFact(hop[key] === null || typeof hop[key] === "boolean", "CANONICAL_NULLABLE_CACHE_FLAG_REQUIRED");
        requireFact(typeof hop.servedFromCache === "boolean", "SERVED_FROM_CACHE_BOOLEAN_REQUIRED");
        for (const key of ["errorCode", "blockedReason", "corsReason"] as const) if (hop[key] !== null) token(hop[key], "SAFE_NATIVE_ERROR_OR_REASON_CODE_REQUIRED");
        if (hop.redirectedFrom !== null) { token(hop.redirectedFrom, "LOCAL_REDIRECT_PARENT_REQUIRED"); const previous = inventory.get(hop.redirectedFrom); requireFact(previous?.chainId === hop.chainId && previous.terminal === "redirected", "REDIRECT_RELATION_MUST_POINT_TO_SAME_CHAIN_PRIOR_HOP"); }
        inventory.set(hop.id, hop); total.hops++; total.requests++;
        const statuses = [hop.status, hop.networkStatus];
        if (statuses.some(status => status !== null)) total.responses++;
        if (statuses.some(status => status !== null && status >= 400 && status < 500)) total.http4xx++;
        if (statuses.some(status => status !== null && status >= 500 && status < 600)) total.http5xx++;
        if (hop.terminal === "finished") total.finished++;
        if (hop.terminal === "failed") total.failed++;
        if (hop.terminal === "blocked") total.blocked++;
        if (hop.terminal === "cancelled") total.requestCancelled++;
        if (hop.terminal === "redirected") total.redirects++;
        if (hop.terminal === "pending") total.pending++;
        if (hop.servedFromCache || hop.fromDiskCache === true || hop.fromPrefetchCache === true) total.cache++;
        if (hop.fromServiceWorker === true) total.serviceWorker++;
      }
      requireFact(evidence.length <= 256 && evidence.length + hops.length <= 256, "SAFE_PROJECTION_COUNT_BUDGET");
      const evidenceIds = new Set<string>(); let unknownEvidence = 0;
      for (const item of evidence) {
        requireFact(JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["id", "chainId", "hopId", "status", "source", "association"].sort()), "CANONICAL_STATUS_EVIDENCE_FIELDS_REQUIRED");
        token(item.id, "OPAQUE_LOCAL_EVIDENCE_ID_REQUIRED"); requireFact(!evidenceIds.has(item.id), "DUPLICATE_LOCAL_EVIDENCE_ID"); evidenceIds.add(item.id);
        requireFact(item.source === "extra-info" && ["unique", "unknown"].includes(item.association) && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599, "TYPED_EXTRA_INFO_STATUS_EVIDENCE_REQUIRED");
        if (item.chainId !== null) token(item.chainId, "LOCAL_EVIDENCE_CHAIN_ID_REQUIRED");
        if (item.association === "unique") { requireFact(item.hopId !== null, "UNIQUE_EVIDENCE_HOP_ID_REQUIRED"); const hop = inventory.get(item.hopId); requireFact(hop && hop.chainId === item.chainId && hop.networkStatus === item.status, "UNIQUE_WIRE_STATUS_MUST_MATCH_EXACT_HOP"); }
        else { requireFact(item.hopId === null, "AMBIGUOUS_STATUS_MUST_NOT_INVENT_HOP"); unknownEvidence++; }
      }
      for (const hop of hops) if (hop.networkStatus !== null) requireFact(evidence.some(item => item.association === "unique" && item.hopId === hop.id && item.chainId === hop.chainId && item.status === hop.networkStatus), "WIRE_STATUS_REQUIRES_ITS_UNIQUE_SAFE_EXTRA_INFO_EVIDENCE");
      for (const key of COUNTER_KEYS) if (key !== "cspIssues" && key !== "unattributed") requireFact(total[key] === observed.counts[key], `SELECTED_HOP_INVENTORY_COUNTER_MISMATCH_${key}`);
      requireFact(total.finished + total.failed + total.blocked + total.requestCancelled + total.redirects + total.pending === total.hops, "EXCLUSIVE_TERMINAL_BUCKETS_MUST_PARTITION_HOPS");
      // Unattributed events need not produce a hop. Ambiguous status remains its
      // own safe evidence, never a fake hop boolean or assigned 4xx/5xx failure.
      requireFact(observed.counts.unattributed >= unknownEvidence, "UNATTRIBUTED_EVIDENCE_CANNOT_BE_SILENTLY_DROPPED");
      if (unknownEvidence) requireFact(observed.completion !== "completed", "AMBIGUOUS_WIRE_EVIDENCE_CANNOT_CLAIM_COMPLETE");
      if (observed.coverage.csp === "unavailable") requireFact(observed.counts.cspIssues === 0, "UNAVAILABLE_CSP_MUST_NOT_FABRICATE_ISSUES");
    }
    function currentReply(value: unknown, requestId: string, completed = false): Reply {
      const reply = object(value, "NETWORK_REPLY_REQUIRED"); privateSurface(reply, "ipc_current", true); rejectRawFields(reply); noPass(reply);
      requireFact(typeof reply.ok === "boolean" && reply.requestId === requestId, "NETWORK_REPLY_IDENTITY");
      const observed = observation(reply.observation);
      requireFact(Array.isArray(reply.hops) && reply.hops.length <= 128, "BOUNDED_HOPS_REQUIRED");
      const ids = new Set<string>();
      for (const raw of reply.hops) {
        const hop = object(raw, "HOP_REQUIRED"); token(hop.id, "OPAQUE_HOP_ID_REQUIRED"); requireFact(!ids.has(hop.id), "DUPLICATE_HOP_ID"); ids.add(hop.id);
        requireFact(origins.includes(String(hop.origin)), "HOP_DESTINATION_MUST_BE_AN_EXACT_OWNED_ORIGIN"); // Initiating selected target, NOT destination origin, is the authority.
        requireFact(hop.status === null || Number.isInteger(hop.status) && Number(hop.status) >= 100 && Number(hop.status) <= 599, "EXPLICIT_NULL_OR_NATIVE_HTTP_STATUS_REQUIRED");
        if (hop.errorCode !== undefined && hop.errorCode !== null) token(hop.errorCode, "NATIVE_ERROR_CODE_ONLY");
        requireFact(!Object.keys(hop).some(key => /^(?:url|.*headers?|cookies?|body|postData|title|message|stack|sample|console|stderr|raw.*|error)$/i.test(key)), "RAW_HOP_DETAIL_FORBIDDEN");
      }
      requireFact(!Object.keys(observed).some(key => /^(?:url|headers?|cookies?|body|title|message|stack|sample|console|stderr|raw.*)$/i.test(key)), "RAW_OBSERVATION_DETAIL_FORBIDDEN");
      requireFact(Array.isArray(reply.httpStatusEvidence), "CANONICAL_SEPARATE_HTTP_STATUS_EVIDENCE_REQUIRED");
      reconcileInventory(observed, reply.hops as Hop[], reply.httpStatusEvidence as StatusEvidence[]);
      if (completed) {
        const completedFact = (condition: unknown, code: "NETWORK_REPLY_NOT_OK" | "WINDOW_NOT_COMPLETED" | "WINDOW_DURATION_SHORT" | "HOP_COUNT_MISMATCH") => {
          if (!condition) throw Object.assign(new Error(code), { code, networkCompletion: observed.completion, networkStopReason: observed.stopReason });
        };
        // Same four requirements and short-circuit order as the former compound
        // assertion; diagnostics only, never relaxation of a partial window.
        completedFact(reply.ok, "NETWORK_REPLY_NOT_OK");
        completedFact(observed.completion === "completed", "WINDOW_NOT_COMPLETED");
        completedFact(observed.durationMs >= 9_900, "WINDOW_DURATION_SHORT");
        completedFact(observed.counts.hops === reply.hops.length, "HOP_COUNT_MISMATCH");
      }
      if (observed.completion !== "completed" || observed.counts.pending > 0 || observed.counts.requests === 0) requireFact(reply.outcome !== "pass", "INCOMPLETE_OR_QUIET_IS_NOT_PASS");
      return reply as unknown as Reply;
    }
    const disk = (): Dict => object(JSON.parse(boundedBytes(controller!.userDataDir, path.join(controller!.userDataDir, "config.json")).toString("utf8")), "ACTUAL_CONFIG_REQUIRED");
    const diskHistory = (id: string): Dict[] => {
      const map = object(disk().profileHealthHistory || {}, "HEALTH_HISTORY_MAP_REQUIRED"), entries = map[id] || [];
      requireFact(Array.isArray(entries) && entries.length <= 20, "ACTUAL_HEALTH_HISTORY_TWENTY_CAP"); return entries as Dict[];
    };
    async function api(method: string, route: string, value?: unknown): Promise<Dict> {
      const reply = await checked(async () => (request(controller!.port, controller!.token, method, route, value)));
      requireFact(reply.status >= 200 && reply.status < 300, "REAL_REST_REQUEST_REJECTED"); return object(reply.body, "REAL_REST_OBJECT_REQUIRED");
    }
    async function invoke(target: Hidden, method: string, ...args: unknown[]): Promise<any> {
      return deadline("PRELOAD_CALL_DEADLINE", () => target.page.evaluate(async input => {
        const bridge = (window as any).agentBrowserAPI?.browser;
        if (typeof bridge?.[input.method] !== "function") throw new Error("MISSING_PRELOAD_CONTRACT");
        return bridge[input.method](...input.args);
      }, { method, args }), cleaning ? 4_000 : 25_000);
    }
    async function clearNetwork(target: Hidden, id: string): Promise<void> {
      const reply = object(await checked(async () => (invoke(target, "healthClear", id, "network"))), "NARROW_NETWORK_CLEAR_REQUIRED");
      privateSurface(reply, "clear_ipc"); requireFact(reply.ok === true, "NARROW_NETWORK_CLEAR_REJECTED");
    }
    async function localStorage(target: Hidden) {
      const value = await checked(async () => (target.page.evaluate(() => Object.fromEntries(Object.keys(window.localStorage).map(key => [key, window.localStorage.getItem(key)])))));
      privateSurface(value, "renderer_localStorage"); return value;
    }
    function typedHistorySummary(entry: Dict): Dict {
      const fields = ["kind", "at", "outcome", "summary", "source", "requestId", "networkSummary"];
      const typed = ["version", "completion", "stopReason", "armedAt", "endedAt", "counts", "coverage", "durationMs"];
      requireFact(JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(fields.sort()), "CANONICAL_NETWORK_HISTORY_FIELD_WHITELIST");
      const result = object(entry.networkSummary, "CANONICAL_ENTRY_NETWORK_SUMMARY_REQUIRED");
      requireFact(JSON.stringify(Object.keys(result).sort()) === JSON.stringify(typed.sort()), "NETWORK_SUMMARY_TYPED_FIELDS_ONLY");
      observation(result); // SAME strict scalar coverage/count/timing/completion schema as current IPC.
      requireFact(entry.summary === NETWORK_HISTORY_SUMMARY_CODE && Number.isSafeInteger(entry.at) && entry.at === result.endedAt, "FIXED_SAFE_CODE_AND_CANONICAL_ENDED_AT_HISTORY_TIME_REQUIRED");
      token(entry.requestId, "NETWORK_HISTORY_REQUEST_ID_REQUIRED"); noPass(entry); return result;
    }
    async function verifyHistory(target: Hidden, id: string): Promise<Dict[]> {
      const actual = diskHistory(id); privateSurface(disk(), "actual_config");
      for (const entry of actual.filter(row => row.kind === "network")) { typedHistorySummary(entry); requireFact(entry.source === "runtime", "NETWORK_HISTORY_RUNTIME_SOURCE_REQUIRED"); }
      const response = object(await checked(async () => (invoke(target, "healthHistory", id))), "PRELOAD_HISTORY_REQUIRED"); privateSurface(response, "history_ipc");
      requireFact(response.error === undefined && JSON.stringify(response.entries) === JSON.stringify(actual), "ACTUAL_DISK_PRELOAD_HISTORY_DISAGREE");
      return actual;
    }
    async function reloadAndSearch(target: Hidden, id: string, expected: Dict[], requestId?: string): Promise<void> {
      requireFact(activeRuns.size === 0, "RELOAD_REQUIRES_OBSERVER_CLEANUP_SETTLED");
      const managerUrl = pathToFileURL(path.join(REPO, "dist/main/services/config-manager.js")).href;
      const readback = await checked(async () => (deadline("OWNED_CONFIG_RELOAD_DEADLINE", () => (controller!.app.evaluate(async ({ app }, input) => {
        async function remoteWait<T>(factory: () => T | PromiseLike<T>): Promise<T> {
          const end = input.end; if (!Number.isFinite(end) || Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const value = await Promise.race([Promise.resolve().then(() => { if (Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE"); return factory(); }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("REMOTE_ABSOLUTE_DEADLINE")), Math.max(1, end - Date.now())); })]);
            if (Date.now() >= end) throw new Error("REMOTE_LATE_RESULT_REJECTED"); return value;
          } finally { if (timer) clearTimeout(timer); }
        }

        const p = process.getBuiltinModule("node:path"), u = process.getBuiltinModule("node:url"), vm = process.getBuiltinModule("node:vm");
        const url = u.pathToFileURL(p.join(app.getAppPath(), "dist/main/services/config-manager.js")).href;
        if (url !== input.url || new URL(url).search || new URL(url).hash) throw new Error("EXACT_LOADED_DIST_URL_REQUIRED");
        // Default main-context ESM loader, EXACT startup URL, no source import,
        // query suffix, copied module, require shim, or new SourceTextModule cache.
        const manager = await remoteWait(async () => (vm.runInThisContext(`import(${JSON.stringify(url)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })));
        if (manager.getConfigPath() !== input.configPath || JSON.stringify(manager.getProfileHealthHistory(input.id)) !== JSON.stringify(input.expected)) throw new Error("ALREADY_LOADED_MAIN_STORE_IDENTITY_MISMATCH");
        manager.reloadConfig();
        return { moduleUrl: url, entries: manager.getProfileHealthHistory(input.id), profilePresent: Object.hasOwn(manager.getConfig().browserProfiles, input.id) };
      }, { url: managerUrl, id, configPath: path.join(controller!.userDataDir, "config.json"), expected , end: scopeNow().end})), 8_000)));
      requireFact(readback.moduleUrl === managerUrl && readback.profilePresent, "MAIN_RELOAD_IDENTITY_REQUIRED"); privateSurface(readback.entries, "main_reload");
      expect(readback.entries).toEqual(expected); expect(await checked(async () => (verifyHistory(target, id)))).toEqual(expected);
      if (requestId) requireFact((await checked(async () => (verifyHistory(target, id)))).filter(entry => entry.kind === "network" && entry.requestId === requestId).length === 1, "RELOADED_REQUEST_ID_KIND_NOT_RETRIEVABLE");
    }
    async function selections(target: Hidden, id: string): Promise<Selection[]> {
      const value = object(await checked(async () => (invoke(target, "networkPages", id))), "NETWORK_PAGES_REQUIRED"); privateSurface(value, "page_selection", true);
      requireFact(value.ok === true && Array.isArray(value.pages) && value.pages.length <= 32, "NETWORK_PAGE_LIST_UNAVAILABLE");
      const ordinals = new Set<number>(), handles = new Set<string>();
      for (const raw of value.pages) {
        const page = object(raw, "SELECTION_REQUIRED");
        requireFact(Object.keys(page).every(key => ["handle", "origin", "ordinal"].includes(key)), "PAGE_SELECTION_PRIVACY_WHITELIST");
        requireFact(typeof page.handle === "string" && page.handle.length > 0 && page.handle.length <= 512 && !page.handle.includes("://"), "OPAQUE_SELECTION_REQUIRED");
        requireFact(Number.isInteger(page.ordinal) && Number(page.ordinal) >= 0 && Number(page.ordinal) <= 32 && !ordinals.has(Number(page.ordinal)) && !handles.has(page.handle), "UNIQUE_SELECTION_IDENTITY_REQUIRED");
        requireFact(origins.includes(String(page.origin)), "PAGE_LIST_LEAKED_NONFIXTURE_ORIGIN"); handles.add(page.handle); ordinals.add(Number(page.ordinal));
      }
      try {
        requireFact(value.pages.length === 2 && origins.every(origin => (value.pages as Dict[]).filter(page => page.origin === origin).length === 1), "TWO_DISTINCT_NATIVE_PAGE_SELECTIONS_REQUIRED");
      } catch (error) {
        // The existing <=32/typed-origin checks above bound these counts. Store
        // numeric fixture labels ONLY: never handles, ordinals, titles or URLs.
        Object.assign(error as Error, { networkPageSelectionCounts: { totalPages: value.pages.length,
          fixtureA: (value.pages as Dict[]).filter(page => page.origin === origins[0]).length,
          fixtureB: (value.pages as Dict[]).filter(page => page.origin === origins[1]).length } });
        throw error;
      }
      return value.pages as Selection[];
    }
    const selectA = async (target: Hidden, id: string) => (await checked(async () => (selections(target, id)))).find(page => page.origin === origins[0])!;
    async function begin(target: Hidden, id: string, selection: string, requestId: string): Promise<void> {
      checkpoint(); requireFact(!activeRuns.has(target.windowId), "ONE_BOUNDED_CURRENT_RENDERER_RUN"); activeRuns.set(target.windowId, { dirId: id, requestId });
      await checked(async () => (deadline("PRELOAD_START_DEADLINE", () => (target.page.evaluate(input => {
        const w = window as any, browser = w.agentBrowserAPI?.browser;
        if (w.__absNetworkCurrent || typeof browser?.networkObserve !== "function" || typeof browser?.onNetworkArmed !== "function") throw new Error("NETWORK_PRELOAD_CONTRACT_MISSING_OR_BUSY");
        const state: any = { dirId: input.id, requestId: input.requestId, armed: null, armedCount: 0, badEvent: false, settled: false, rejected: false, result: null };
        const unsubscribe = browser.onNetworkArmed((event: any) => {
          state.armedCount++;
          if (state.armedCount !== 1 || !event || Object.keys(event).some(key => !["dirId", "requestId", "armedAt", "observeForMs"].includes(key)) || event.dirId !== input.id || event.requestId !== input.requestId || JSON.stringify(event).length > 4096) { state.badEvent = true; return; }
          state.armed = event;
        });
        if (typeof unsubscribe !== "function") throw new Error("ARMED_UNSUBSCRIBE_CONTRACT_REQUIRED");
        w.__absNetworkCurrent = { state, unsubscribe };
        Promise.resolve().then(() => browser.networkObserve(input.id, { selection: input.selection, requestId: input.requestId })).then(result => { state.result = result; state.settled = true; }, () => { state.rejected = true; state.settled = true; });
      }, { id, selection, requestId })), 4_000)));
    }
    const currentState = (target: Hidden) => target.page.evaluate(() => {
      const state = (window as any).__absNetworkCurrent?.state;
      return state ? { settled: state.settled, rejected: state.rejected, armed: state.armed, armedCount: state.armedCount, badEvent: state.badEvent } : null;
    });
    async function armed(target: Hidden): Promise<Armed> {
      await checked(async () => (until("MATCHING_ARMED_NOTIFICATION_REQUIRED", async () => {
        checkpoint(); const state = await checked(async () => (currentState(target))); requireFact(state && !state.rejected && !state.badEvent && !(state.settled && !state.armed), "OBSERVATION_SETUP_UNAVAILABLE_NOT_ARMED"); return !!state.armed;
      }, 7_000)));
      const state = (await checked(async () => (currentState(target))))!; privateSurface(state.armed, "armed_event");
      const active = activeRuns.get(target.windowId)!;
      requireFact(state.armed.dirId === active.dirId && state.armed.requestId === active.requestId && state.armedCount === 1 && state.armed.observeForMs === 10_000 && Number.isSafeInteger(state.armed.armedAt) && Math.abs(Date.now() - state.armed.armedAt) < 7_000, "ARMED_MAIN_DERIVED_TIMING_IDENTITY");
      return state.armed as Armed;
    }
    async function finish(target: Hidden): Promise<unknown> {
      await checked(async () => (until("OBSERVATION_AWAITED_RESULT_AND_CLEANUP_DEADLINE", async () => !!(await checked(async () => (currentState(target))))?.settled, cleaning ? 8_000 : 23_000)));
      const value = await checked(async () => (target.page.evaluate(() => {
        const w = window as any, current = w.__absNetworkCurrent;
        if (!current || !current.state.settled || current.state.rejected || current.state.badEvent || current.state.armedCount > 1) throw new Error("NETWORK_RESULT_OR_ARMED_CONTRACT_FAILURE");
        try { current.unsubscribe(); return current.state.result; }
        finally { delete w.__absNetworkCurrent; }
      })));
      activeRuns.delete(target.windowId); return value;
    }
    function deniedReply(value: unknown, label: string): Dict {
      const result = object(value, "DENIAL_REPLY_REQUIRED"); privateSurface(result, label, true);
      requireFact(result.ok === false && result.outcome !== "pass", "DENIAL_MUST_NOT_BECOME_SUCCESS"); token(result.code, "STABLE_DENIAL_CODE_REQUIRED"); return result;
    }
    async function cachedRuntime(id: string, target?: NativeOwner, mode: "snapshot" | "capture" | "assert" | "released" = "snapshot", argvHash?: string, requestHash?: string): Promise<Dict> {
      return deadline("CACHED_OWNED_RUNTIME_READ_DEADLINE", () => controller!.app.evaluate(async ({ app }, input) => {
        async function remoteWait<T>(factory: () => T | PromiseLike<T>): Promise<T> {
          const end = input.end; if (!Number.isFinite(end) || Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const value = await Promise.race([Promise.resolve().then(() => { if (Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE"); return factory(); }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("REMOTE_ABSOLUTE_DEADLINE")), Math.max(1, end - Date.now())); })]);
            if (Date.now() >= end) throw new Error("REMOTE_LATE_RESULT_REJECTED"); return value;
          } finally { if (timer) clearTimeout(timer); }
        }

        const p = process.getBuiltinModule("node:path"), u = process.getBuiltinModule("node:url"), vm = process.getBuiltinModule("node:vm");
        if (process.pid !== input.mainPid || app.getAppPath() !== input.repo || app.getPath("userData") !== input.userData) throw new Error("OWNED_MAIN_IDENTITY_CHANGED");
        const url = u.pathToFileURL(p.join(app.getAppPath(), "dist/main/services/browser/runtime-table.js")).href;
        if (url !== input.url) throw new Error("EXACT_LOADED_RUNTIME_TABLE_URL_REQUIRED");
        const runtime = await remoteWait(async () => (vm.runInThisContext(`import(${JSON.stringify(url)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })));
        if (Date.now() >= input.end) throw new Error("CACHED_RUNTIME_LATE_READ_REJECTED");
        const entry = runtime.getEntry(input.id), all = runtime.runningProcesses;
        if (input.mode === "snapshot") return { present: !!entry, entryCount: all.size };
        const w = globalThis as any;
        const witnesses: Map<string, any> = w.__absNetworkAcceptanceOwnedNative || (w.__absNetworkAcceptanceOwnedNative = new Map());
        const held = witnesses.get(input.key);
        if (input.mode === "released") {
          if (!held || held.pid !== input.pid || held.port !== input.port || held.child.pid !== input.pid) throw new Error("HELD_CHILD_IDENTITY_REQUIRED_AFTER_EXIT");
          return { present: !!entry, entryCount: all.size, heldChildExited: held.child.exitCode !== null || held.child.signalCode !== null,
            childExitCode: held.child.exitCode, childSignal: held.child.signalCode,
            retiredTupleAbsent: ![...all.values()].some((value: any) => value.pid === input.pid || value.port === input.port) };
        }
        const ChildProcess = process.getBuiltinModule("node:child_process").ChildProcess;
        const child = entry?.process;
        if (!entry || entry.pid !== input.pid || entry.port !== input.port || entry.engine !== "chromium" || !(child instanceof ChildProcess) || child.pid !== input.pid || child.killed || child.exitCode !== null || child.signalCode !== null || entry.stopping || entry.killTimer || entry.proxyBridge || entry.bidiConn || entry.launchProxy?.source !== "fresh-launch" || entry.launchProxy.mode !== "named" || entry.launchProxy.type !== "http" || entry.launchProvenance?.requestHash !== input.requestHash || child.spawnfile !== input.binary || !Array.isArray(child.spawnargs)) throw new Error("FRESH_OWNED_RUNNING_ENTRY_AND_CHILD_REQUIRED");
        const argvHash = process.getBuiltinModule("node:crypto").createHash("sha256").update(JSON.stringify(child.spawnargs)).digest("hex");
        if (argvHash !== input.argvHash || [...all.values()].filter((value: any) => value.port === input.port).length !== 1 || [...all.values()].filter((value: any) => value.process === child || value.pid === input.pid).length !== 1) throw new Error("EXACT_CHILD_ARGV_AND_UNIQUE_RUNTIME_PORT_REQUIRED");
        if (input.mode === "capture") {
          if (held) throw new Error("NATIVE_WITNESS_KEY_ALREADY_CAPTURED");
          witnesses.set(input.key, { entry, child, pid: input.pid, port: input.port });
        } else if (!held || held.entry !== entry || held.child !== child || held.pid !== input.pid || held.port !== input.port) throw new Error("RUNNING_ENTRY_OR_CHILD_REFERENCE_REPLACED");
        return { present: true, entryCount: all.size, freshLaunch: true, exactChild: true, uniquePort: true, referenceStable: true };
      }, { id, mode, url: pathToFileURL(path.join(REPO, "dist/main/services/browser/runtime-table.js")).href, repo: REPO, mainPid: controller!.app.process().pid, userData: controller!.userDataDir,
        key: target?.witnessKey, pid: target?.pid, port: target?.port, binary, argvHash, requestHash, end: scopeNow().end }), 5_000);
    }
    async function proof(target: NativeOwner, label: string, requireCdp = true): Promise<void> {
      return deadline("NATIVE_BRACKETED_PROOF_DEADLINE", async () => { try {
        const observed = readOwnedNativeArgv({ pid: target.pid, executablePath: binary, argv0: binary, profileDir: target.profileDir, port: target.port });
        requireFact(observed.args.includes("--headless=new") && observed.args.includes("--password-store=basic") && observed.args.includes("--use-mock-keychain"), "NATIVE_HEADLESS_NO_HOST_KEYCHAIN_POLICY_REQUIRED");
        requireFact(observed.args.filter(arg => arg.startsWith("--proxy-server=")).length === 1 && observed.args.includes(`--proxy-server=http://${LOOPBACK}:${fixture!.port}`), "ACTUAL_NAMED_FIXTURE_PROXY_REQUIRED");
        requireFact(!observed.args.some(arg => /^--(?:no-sandbox|disable-gpu-sandbox|disable-web-security|disable-site-isolation-trials|allow-running-insecure-content|unsafely-treat-insecure-origin-as-secure|ignore-certificate-errors|js-flags)(?:=|$)/.test(arg) || arg.startsWith("--disable-features=") && /CSP|ContentSecurity|Sandbox|IsolateOrigins|site-per-process/i.test(arg)), "NATIVE_SECURITY_WORKAROUND_FORBIDDEN");
        requireFact(!observed.args.some(arg => origins.some(origin => arg.includes(new URL(origin).hostname))), "TEST_DNS_HOST_MAPPING_OR_FIXTURE_URL_IN_NATIVE_ARGV_FORBIDDEN");
        const saved = disk(), meta = object(object(saved.browserProfiles, "ACTUAL_PROFILES_REQUIRED")[target.id], "ACTUAL_PROFILE_REQUIRED");
        requireFact(meta.engine === "chromium" && meta.fingerprintMode === "managed" && meta.proxyMode === "named" && meta.proxyName === "network-local-only" && meta.locale === "en-US" && meta.timezone === "UTC" && meta.webrtcMode === "disable" && meta.geolocationMode === "disable", "FIXED_NORMAL_PROFILE_POLICY_REQUIRED");
        const requestHash = chromiumLaunchRequestHash(meta as Parameters<typeof chromiumLaunchRequestHash>[0], saved as Parameters<typeof chromiumLaunchRequestHash>[1], { headless: true, binaryOverride: binary, gpuContext: readChromiumGpuContext(binary) });
        assertChromiumReuseEvidence(observed, { profileDir: target.profileDir, executablePath: binary, requestHash, mode: "managed", pid: target.pid, port: target.port });
        scopeNow(); // The synchronous public argv reader is bounded, but a late read is still rejected.
        const cached = await checked(async () => (cachedRuntime(target.id, target, target.mainCaptured ? "assert" : "capture", sha(JSON.stringify([binary, ...observed.args])), requestHash)));
        requireFact(cached.freshLaunch && cached.exactChild && cached.uniquePort && cached.referenceStable, "FRESH_CACHED_RUNTIME_WITNESS_REQUIRED"); target.mainCaptured = true;
        const witness = observed.ownershipWitness.before;
        requireFact(witness.ppid === controller!.app.process().pid, "NATIVE_PROCESS_MUST_BE_THIS_CONTROLLERS_OWN_CHILD");
        if (target.witness) requireFact(JSON.stringify(target.witness) === JSON.stringify(witness), "NATIVE_GENERATION_WITNESS_CHANGED"); else target.witness = witness;
        let browserPid: number | null = null;
        if (requireCdp) {
          requireFact(target.browser?.isConnected(), "OWNED_CDP_REQUIRED");
          if (!target.control) {
            const sessionEnd = Math.min(scopeNow().end, Date.now() + 3_000);
            const created = target.browser.newBrowserCDPSession().then(session => {
              target.control = session; const state = { detachStarted: false }; ownedDriverSessions.set(session, state);
              if (cleaning || Date.now() >= sessionEnd) {
                awaitRoot.timedOut.add("LATE_OWN_DRIVER_SESSION_CREATED"); state.detachStarted = true;
                return awaitScopes.run({ root: awaitRoot, end: awaitRoot.cleanupEnd, cleaning: true }, () => deadline("LATE_OWN_DRIVER_SESSION_DETACH_DEADLINE", () => session.detach(), 2_000)).then(() => {
                  ownedDriverSessions.delete(session); throw Object.assign(new Error("LATE_OWN_DRIVER_SESSION_REJECTED"), { code: "LATE_OWN_DRIVER_SESSION_REJECTED" });
                });
              }
              return session;
            });
            target.control = await checked(async () => (deadline("OWN_DRIVER_CDP_SESSION_DEADLINE", () => created, 3_000)));
          }
          const session = target.control;
          const processes = (await checked(async () => (deadline("CDP_BROWSER_PID_QUERY_DEADLINE", () => session.send("SystemInfo.getProcessInfo"), 3_000)))).processInfo.filter(entry => entry.type === "browser");
          requireFact(processes.length === 1 && processes[0].id === target.pid, "CDP_BROWSER_PID_CONTRADICTS_NATIVE"); browserPid = processes[0].id;
          const version = (await checked(async () => (deadline("CDP_BROWSER_VERSION_QUERY_DEADLINE", () => session.send("Browser.getVersion"), 3_000)))).product;
          requireFact(typeof version === "string" && /\d+\.\d+\.\d+\.\d+/.test(version) && (!target.cdpVersion || target.cdpVersion === version), "STABLE_OWNED_CDP_BROWSER_VERSION_REQUIRED"); target.cdpVersion = version;
        }
        receipt.ownership.push({ label, profileId: target.id, pid: target.pid, port: target.port, browserPid, witness, argvSha256: sha(JSON.stringify(observed.args)), exactNamedProxy: true,
          freshMainRunningEntry: true, exactChildProcessReference: true, uniqueCachedPort: true });
      } catch (error) { target.unsafe = true; throw error; } }, 12_000);
    }
    async function nativeAction<T>(label: string, action: () => Promise<T>): Promise<T> {
      requireFact(native && !native.unsafe, "NATIVE_ACTION_OWNERSHIP_UNVERIFIED"); await checked(async () => (proof(native, `before-${label}`)));
      try { return await checked(async () => (action())); } finally { await checked(async () => (proof(native, `after-${label}`))); }
    }
    async function gracefulNativeFixtureCleanup(): Promise<void> {
      if (!native) return; const target = native;
      requireFact(activeRuns.size === 0 && !target.unsafe && !target.closeAttempted, "NO_NATIVE_CLOSE_WITH_ACTIVE_OBSERVER_UNVERIFIED_OWNER_OR_PRIOR_CLOSE");
      await checked(async () => (proof(target, "before-test-driver-graceful-native-cleanup")));
      requireFact(target.browser?.isConnected() && target.control && target.mainCaptured, "EXISTING_WITNESSED_CDP_CONTROL_AND_MAIN_CHILD_REQUIRED");
      target.closeAttempted = true;
      // This is TEST-DRIVER fixture cleanup, NOT a production observer action or
      // product-stop test. No lifecycle stop/status/discovery function is called.
      // connectOverCDP Browser.close() below is a CDP COMMAND; browser.close()
      // would only detach the Playwright client and is NOT native cleanup proof.
      const acknowledgement = await checked(async () => (deadline("OWNED_DRIVER_BROWSER_CLOSE_COMMAND_DEADLINE", () => target.control!.send("Browser.close").then(
        () => "acknowledged" as const,
        error => {
          const message = error instanceof Error ? error.message : "";
          if (!target.browser!.isConnected() && /(?:Target|Session|Browser|Connection).*closed|closed.*(?:Target|Session|Browser|Connection)/i.test(message)) return "existing-client-disconnected-before-ack" as const;
          throw error; // No timeout/protocol/ownership error is laundered as close success.
        }), 4_000)));
      await checked(async () => (until("EXACT_OWNED_NATIVE_PID_AND_EXISTING_CDP_EXIT_REQUIRED", () => gone(target.pid) && !target.browser!.isConnected(), 15_000)));
      let released: Dict | undefined;
      await checked(async () => (until("HELD_CHILD_EXIT_AND_CACHED_RUNTIME_RELEASE_REQUIRED", async () => {
        released = await checked(async () => (cachedRuntime(target.id, target, "released")));
        return released.heldChildExited === true && released.present === false && released.entryCount === 0 && released.retiredTupleAbsent === true;
      }, 6_000)));
      requireFact(released!.childExitCode === 0 && released!.childSignal === null, "NATIVE_GRACEFUL_DRIVER_CLEANUP_MUST_NOT_HIDE_CRASH_OR_SIGNAL_EXIT");
      if (target.control) ownedDriverSessions.delete(target.control); // Already disconnected; send nothing to a retired endpoint.
      ownedDriverClients.delete(target.browser);
      receipt.cleanup.push({ kind: "native", pid: target.pid, productStopVerification: "not-exercised", gracefulNativeCleanup: "test-driver-owned-existing-CDP-Browser.close",
        acknowledgement, pidGone: true, existingCdpDisconnected: true, heldChildExitObserved: true, cachedRuntimeReleased: true,
        childExitCode: released!.childExitCode, childSignal: released!.childSignal, retiredPortAvailability: "not-probed-unverified" });
      native = undefined;
    }
    async function launchNative(id: string, retired?: { pid: number; port: number }): Promise<void> {
      checkpoint(128 * 1024 ** 2);
      const before = await checked(async () => (cachedRuntime(id))); requireFact(!before.present && before.entryCount === 0, "NO_CACHED_NATIVE_RUNTIME_BEFORE_FRESH_LAUNCH");
      nativeLaunchPending = true;
      const value = await checked(async () => (api("POST", `/api/profiles/${id}/launch`, { headless: true })));
      requireFact(Number.isInteger(value.pid) && Number(value.pid) > 0 && Number.isInteger(value.cdpPort) && Number(value.cdpPort) > 0 && Number(value.cdpPort) <= 65535, "NATIVE_LAUNCH_IDENTITY_UNAVAILABLE");
      const profilePath = path.join(controller!.userDataDir, "profiles", id), profileStat = fs.lstatSync(profilePath);
      requireFact(profileStat.isDirectory() && !profileStat.isSymbolicLink() && profileStat.uid === process.getuid?.(), "NATIVE_PROFILE_MUST_BE_OWNED_REAL_DIRECTORY");
      const profileDir = fs.realpathSync(profilePath); strictChild(fs.realpathSync(controller!.userDataDir), profileDir);
      native = { id, pid: Number(value.pid), port: Number(value.cdpPort), profileDir, witnessKey: randomUUID(), unsafe: true }; nativeLaunchPending = false;
      requireFact(value.success === true, "NORMAL_NATIVE_LAUNCH_FAILED");
      if (retired) requireFact(native.pid !== retired.pid && native.port !== retired.port && gone(retired.pid), "RETIRED_PID_PORT_NOT_RECONNECTED_OR_ADOPTED");
      await checked(async () => (proof(native, "exact-native-before-CDP", false)));
      const launchedOwner = native;
      const connectEnd = Math.min(scopeNow().end, Date.now() + 20_000);
      const connecting = chromium.connectOverCDP(`http://${LOOPBACK}:${native.port}`, { timeout: Math.max(1, connectEnd - Date.now()) }).then(browser => {
        launchedOwner.browser = browser; ownedDriverClients.add(browser);
        if (cleaning || Date.now() >= connectEnd) {
          awaitRoot.timedOut.add("LATE_OWN_DRIVER_CONNECTION_CREATED");
          // This closes ONLY our connectOverCDP CLIENT, never sends Browser.close
          // and never constitutes native cleanup proof for an unverified endpoint.
          return awaitScopes.run({ root: awaitRoot, end: awaitRoot.cleanupEnd, cleaning: true }, () => deadline("LATE_OWN_DRIVER_CLIENT_DETACH_DEADLINE", () => browser.close(), 2_000)).then(() => {
            ownedDriverClients.delete(browser); throw Object.assign(new Error("LATE_OWN_DRIVER_CONNECTION_REJECTED"), { code: "LATE_OWN_DRIVER_CONNECTION_REJECTED" });
          });
        }
        return browser;
      });
      pendingDriverConnects.add(connecting); connecting.then(() => pendingDriverConnects.delete(connecting), () => pendingDriverConnects.delete(connecting));
      native.browser = await checked(async () => (deadline("FRESH_OWNED_DRIVER_CDP_CONNECT_DEADLINE", () => connecting, 20_000)));
      await checked(async () => (proof(native, "independent-CDP-browser-PID-before-actions"))); native.unsafe = false;
      const context = native.browser.contexts()[0]; requireFact(context, "NORMAL_BROWSER_CONTEXT_REQUIRED");
      // NO route/interception, addInitScript, permission grants, cache overrides,
      // security switches, extra observer domains, or private bridge discovery.
      await checked(async () => (nativeAction("two-owned-fixture-pages", async () => {
        const ownedBrowser = native!.browser!;
        requireFact(context.browser() === ownedBrowser && ownedBrowser.contexts().includes(context), "EXACT_OWNED_DRIVER_CONTEXT_REQUIRED_FOR_PAGE_RESET");
        // Same-profile relaunch may restore old fixture tabs. Close ALL pages
        // only in this witnessed context/connection before creating the two
        // controlled pages; do not reset userData or touch another browser.
        await checked(() => deadline("OWNED_PREEXISTING_PAGES_CLOSE_DEADLINE", async () => {
          let closedPages = 0;
          for (;;) {
            const existing = context.pages(); if (existing.length === 0) break;
            requireFact(closedPages + existing.length <= 32, "OWNED_PREEXISTING_PAGE_COUNT_CAP");
            for (const page of existing) {
              requireFact(context.browser() === ownedBrowser && page.context() === context && ownedBrowser.isConnected(), "PREEXISTING_PAGE_MUST_BELONG_TO_EXACT_OWNED_CONNECTION");
              await checked(() => deadline("OWNED_PREEXISTING_PAGE_CLOSE_DEADLINE", () => page.close({ runBeforeUnload: false }), 3_000));
              closedPages++;
            }
          }
        }, 10_000));
        requireFact(context.pages().length === 0 && ownedBrowser.isConnected(), "OWNED_CONTEXT_MUST_BE_EMPTY_BEFORE_TWO_PAGE_CREATION");
        const first = await checked(async () => (context.newPage()));
        const second = await checked(async () => (context.newPage())); native!.pages = [first, second];
        for (const [index, page] of native!.pages.entries()) {
          const response = await checked(async () => (page.goto(fixture!.pageUrl(index as 0 | 1), { waitUntil: "load", timeout: 15_000 })));
          requireFact(response?.status() === 200 && response.headers()["content-security-policy"] === fixture!.policy, "REAL_PROXY_FIXTURE_CSP_RESPONSE_REQUIRED");
          await checked(async () => (page.locator('html[data-fixture-ready="true"]').waitFor({ timeout: 5_000 })));
          requireFact(await checked(async () => (page.title())) === sentinels.title, "NATIVE_SYNTHETIC_TITLE_CONTROL_REQUIRED");
        }
      })));
      await checked(async () => (new Promise<void>(resolve => setTimeout(resolve, 500)))); // Drain only fixture startup/favicon, no observer activity.
    }
    async function createHidden(label: string): Promise<Hidden> {
      const pagePending = controller!.app.waitForEvent("window", { timeout: 10_000 }).then(page => ({ page, failed: false }), () => ({ page: undefined, failed: true }));
      const value = await checked(async () => (deadline("HIDDEN_PRELOAD_WINDOW_DEADLINE", () => (controller!.app.evaluate(async ({ BrowserWindow }, input) => {
        async function remoteWait<T>(factory: () => T | PromiseLike<T>): Promise<T> {
          const end = input.end; if (!Number.isFinite(end) || Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const value = await Promise.race([Promise.resolve().then(() => { if (Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE"); return factory(); }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("REMOTE_ABSOLUTE_DEADLINE")), Math.max(1, end - Date.now())); })]);
            if (Date.now() >= end) throw new Error("REMOTE_LATE_RESULT_REJECTED"); return value;
          } finally { if (timer) clearTimeout(timer); }
        }

        const state = (globalThis as any).__absNetworkAcceptanceMain;
        if (!state || state.tag !== input.tag) throw new Error("OWNED_UI_SESSION_REQUIRED");
        const win = new BrowserWindow({ show: false, focusable: false, width: 1000, height: 700, webPreferences: {
          preload: input.preload, session: state.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
        } });
        state.windows.set(win.id, win);
        win.on("show", () => { state.unexpectedVisible++; });
        win.webContents.on("will-navigate", (event, url) => { if (url !== input.rendererUrl) { event.preventDefault(); state.deniedNavigation++; } });
        win.webContents.on("will-redirect", (event, url) => { if (url !== input.rendererUrl) { event.preventDefault(); state.deniedNavigation++; } });
        win.webContents.on("will-attach-webview", event => { event.preventDefault(); state.deniedWebview++; });
        win.webContents.setWindowOpenHandler(() => { state.deniedPopup++; return { action: "deny" }; }); // NEVER shell.openExternal.
        await remoteWait(async () => (win.loadFile(input.rendererFile)));
        if (win.isVisible() || win.isDestroyed()) throw new Error("HIDDEN_ONLY_WINDOW_REQUIRED");
        return { windowId: win.id, webContentsId: win.webContents.id };
      }, { label, tag: runTag, preload: path.join(REPO, "dist/main/preload.cjs"), rendererFile: path.join(REPO, "dist/renderer/index.html"), rendererUrl: pathToFileURL(path.join(REPO, "dist/renderer/index.html")).href , end: scopeNow().end})), 12_000)));
      const pending = await checked(async () => (pagePending)); requireFact(pending.page && !pending.failed, "OWNED_HIDDEN_WINDOW_EVENT_REQUIRED");
      const page = pending.page; page.on("pageerror", () => { rendererErrors++; });
      const result = { ...value, page, label }; hidden.push(result);
      // Explicit millisecond polling, NEVER Playwright's default rAF polling in
      // a show:false renderer. No clock/rAF/backgroundThrottling policy changes.
      await checked(async () => (page.waitForFunction(() => typeof (window as any).agentBrowserAPI?.browser?.networkPages === "function" && typeof (window as any).agentBrowserAPI?.browser?.networkObserve === "function" && typeof (window as any).agentBrowserAPI?.browser?.onNetworkArmed === "function" && typeof (window as any).agentBrowserAPI?.browser?.healthClear === "function", undefined, { timeout: 5_000, polling: 100 })));
      const contract = await checked(async () => (page.evaluate(() => ({ frozen: Object.isFrozen((window as any).agentBrowserAPI), nodeRequire: typeof (window as any).require, nodeProcess: typeof (window as any).process,
        frontendBootstrap: typeof (window as any).agentBrowser, i18nBootstrap: typeof (window as any).i18n,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") }))));
      requireFact(contract.frozen && contract.nodeRequire === "undefined" && contract.nodeProcess === "undefined" && contract.frontendBootstrap === "undefined" && contract.i18nBootstrap === "undefined" && contract.csp === cspMeta, "UNCHANGED_PRELOAD_NO_FRONTEND_BOOTSTRAP_OR_NODE_REQUIRED");
      return result;
    }
    async function assertHiddenIsolation(): Promise<void> {
      const facts = await checked(async () => (controller!.app.evaluate(({ BrowserWindow }, input) => {
        const state = (globalThis as any).__absNetworkAcceptanceMain;
        if (!state || state.tag !== input.tag) throw new Error("OWNED_UI_STATE_MISSING");
        const windows = BrowserWindow.getAllWindows();
        return { windowIds: windows.map(win => win.id), visible: windows.some(win => win.isVisible()), unexpectedVisible: state.unexpectedVisible,
          scriptSubresourcesDenied: state.scriptSubresourcesDenied, deniedExternal: state.deniedExternal, deniedDownload: state.deniedDownload, deniedPopup: state.deniedPopup, deniedWebview: state.deniedWebview, deniedNavigation: state.deniedNavigation };
      }, { tag: runTag })));
      requireFact(!facts.visible && facts.unexpectedVisible === 0 && facts.scriptSubresourcesDenied > 0 && facts.deniedExternal === 0 && facts.deniedDownload === 0 && facts.deniedPopup === 0 && facts.deniedWebview === 0 && facts.deniedNavigation === 0, "HIDDEN_UI_EFFECT_OR_BOOTSTRAP_FENCE_FAILURE");
      expect(facts.windowIds.sort()).toEqual(hidden.map(item => item.windowId).sort());
    }
    function validateControlDiagnostic(value: unknown): ControlFailureDiagnostic {
      const diagnostic = object(value, "CONTROL_DIAGNOSTIC_OBJECT_REQUIRED");
      const exact = (value: Dict, keys: string[], code: string) => requireFact(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), code);
      exact(diagnostic, ["control", "observation", "hops", "httpStatusEvidence"], "CONTROL_DIAGNOSTIC_FIELD_WHITELIST");
      requireFact(diagnostic.control === "selected-a-a-initiates-to-b", "ONLY_A_TO_B_FAILED_CONTROL_DIAGNOSTIC_ALLOWED");
      const observed = object(diagnostic.observation, "CONTROL_DIAGNOSTIC_OBSERVATION_REQUIRED");
      exact(observed, ["completion", "stopReason", "counts", "coverage"], "CONTROL_DIAGNOSTIC_OBSERVATION_FIELDS_ONLY");
      requireFact(typeof observed.completion === "string" && ["completed", "partial", "cancelled", "unavailable"].includes(observed.completion) && typeof observed.stopReason === "string" && (STOP_REASONS as readonly string[]).includes(observed.stopReason), "CONTROL_DIAGNOSTIC_OBSERVATION_ENUMS_ONLY");
      counts(observed.counts); coverage(observed.coverage);
      requireFact(Array.isArray(diagnostic.hops) && diagnostic.hops.length <= 128 && Array.isArray(diagnostic.httpStatusEvidence) && diagnostic.httpStatusEvidence.length + diagnostic.hops.length <= 256, "CONTROL_DIAGNOSTIC_FINITE_PROJECTION_BUDGET");
      const hopFields = ["origin", "status", "networkStatus", "terminal", "errorCode", "blockedReason", "corsReason", "fromDiskCache", "fromServiceWorker", "fromPrefetchCache", "servedFromCache"];
      for (const raw of diagnostic.hops) {
        const hop = object(raw, "CONTROL_DIAGNOSTIC_HOP_REQUIRED"); exact(hop, hopFields, "CONTROL_DIAGNOSTIC_HOP_FIELDS_ONLY");
        requireFact(origins.includes(String(hop.origin)), "CONTROL_DIAGNOSTIC_SYNTHETIC_ORIGIN_ONLY");
        for (const key of ["status", "networkStatus"]) requireFact(hop[key] === null || Number.isInteger(hop[key]) && Number(hop[key]) >= 100 && Number(hop[key]) <= 599, "CONTROL_DIAGNOSTIC_TYPED_HTTP_STATUS_ONLY");
        requireFact(typeof hop.terminal === "string" && ["pending", "finished", "failed", "blocked", "cancelled", "redirected"].includes(hop.terminal), "CONTROL_DIAGNOSTIC_TERMINAL_ENUM_ONLY");
        for (const key of ["errorCode", "blockedReason", "corsReason"]) if (hop[key] !== null) token(hop[key], "CONTROL_DIAGNOSTIC_SAFE_NATIVE_CODE_ONLY");
        for (const key of ["fromDiskCache", "fromServiceWorker", "fromPrefetchCache"]) requireFact(hop[key] === null || typeof hop[key] === "boolean", "CONTROL_DIAGNOSTIC_NULLABLE_CACHE_FLAGS_ONLY");
        requireFact(typeof hop.servedFromCache === "boolean", "CONTROL_DIAGNOSTIC_CACHE_BOOLEAN_ONLY");
      }
      for (const raw of diagnostic.httpStatusEvidence) {
        const evidence = object(raw, "CONTROL_DIAGNOSTIC_STATUS_EVIDENCE_REQUIRED"); exact(evidence, ["status", "association"], "CONTROL_DIAGNOSTIC_STATUS_EVIDENCE_FIELDS_ONLY");
        requireFact(Number.isInteger(evidence.status) && Number(evidence.status) >= 100 && Number(evidence.status) <= 599 && typeof evidence.association === "string" && ["unique", "unknown"].includes(evidence.association), "CONTROL_DIAGNOSTIC_STATUS_ASSOCIATION_ENUM_ONLY");
      }
      privateSurface(diagnostic, "control_diagnostic", true);
      requireFact(Buffer.byteLength(JSON.stringify(diagnostic)) <= CONTROL_DIAGNOSTIC_CAP, "CONTROL_DIAGNOSTIC_64_KIB_CAP");
      return diagnostic as unknown as ControlFailureDiagnostic;
    }
    function projectControlDiagnostic(reply: Reply): ControlFailureDiagnostic {
      const observed = reply.observation!;
      return validateControlDiagnostic({ control: "selected-a-a-initiates-to-b",
        observation: { completion: observed.completion, stopReason: observed.stopReason, counts: { ...observed.counts }, coverage: { ...observed.coverage } },
        hops: reply.hops!.map(hop => ({ origin: hop.origin, status: hop.status, networkStatus: hop.networkStatus, terminal: hop.terminal,
          errorCode: hop.errorCode, blockedReason: hop.blockedReason, corsReason: hop.corsReason, fromDiskCache: hop.fromDiskCache,
          fromServiceWorker: hop.fromServiceWorker, fromPrefetchCache: hop.fromPrefetchCache, servedFromCache: hop.servedFromCache })),
        httpStatusEvidence: reply.httpStatusEvidence!.map(evidence => ({ status: evidence.status, association: evidence.association })),
      });
    }
    function retainedReceiptPrivacyView(): Receipt {
      const view = structuredClone(receipt); let diagnostics = 0;
      for (const failure of view.failures) {
        if (!Object.hasOwn(failure, "networkControlDiagnostic")) continue;
        requireFact(++diagnostics === 1 && (view.status === "failed" || view.status === "cleanup-unverified") && ["NETWORK_REPLY_NOT_OK", "WINDOW_NOT_COMPLETED", "WINDOW_DURATION_SHORT", "HOP_COUNT_MISMATCH"].includes(String(failure.code)), "NARROW_FAILED_CONTROL_RECEIPT_EXCEPTION_ONLY");
        const diagnostic = validateControlDiagnostic(failure.networkControlDiagnostic);
        // Explicit coordinator-approved TEST-receipt exception ONLY. Mask these
        // exact origin slots in a detached privacy-check view, not in the stored
        // diagnostic. Every other receipt/config/localStorage field still has
        // the original no-origin/no-sentinel guard; no global bypass is enabled.
        for (const hop of diagnostic.hops) hop.origin = hop.origin === origins[0] ? "owned-fixture-a" : "owned-fixture-b";
      }
      return view;
    }
    async function completedWindow(owner: Hidden, id: string, label: string, action?: () => Promise<void>, originIndex: 0 | 1 = 0, allowEvidencePartial = false): Promise<Reply> {
      const selected = (await checked(async () => (selections(owner, id)))).find(page => page.origin === origins[originIndex])!, requestId = `network-${label}-${randomUUID()}`;
      await checked(async () => (begin(owner, id, selected.handle, requestId))); const event = await checked(async () => (armed(owner)));
      if (action) await checked(async () => (nativeAction(label, action)));
      const value = await checked(async () => (finish(owner))); let reply: Reply;
      try { reply = currentReply(value, requestId, !allowEvidencePartial); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (label === "selected-a-a-initiates-to-b" && typeof code === "string" && ["NETWORK_REPLY_NOT_OK", "WINDOW_NOT_COMPLETED", "WINDOW_DURATION_SHORT", "HOP_COUNT_MISMATCH"].includes(code)) {
          try {
            // Recheck the canonical safe DTO WITHOUT granting completion. This
            // is diagnostic projection after a failure, not an alternate pass:
            // the ORIGINAL failed assertion is unconditionally rethrown below.
            controlFailureDiagnostic = projectControlDiagnostic(currentReply(value, requestId, false));
          } catch (diagnosticError) { controlFailureDiagnosticUnavailable = safeFailure(diagnosticError); }
        }
        throw error;
      }
      requireFact(reply.observation!.armedAt === event.armedAt && reply.observation!.durationMs >= 9_900 && (reply.observation!.completion === "completed" || allowEvidencePartial && reply.observation!.completion === "partial" && reply.observation!.stopReason === "evidence-incomplete"), "ARMED_FINITE_WINDOW_COMPLETED_OR_EXPLICITLY_EVIDENCE_INCOMPLETE_REQUIRED");
      requireFact(Date.now() >= event.armedAt + event.observeForMs - 100, "INDEPENDENT_TEN_SECOND_WINDOW_ELAPSED_REQUIRED"); checkpoint();
      receipt.cases.push({ name: label, requestId, outcome: reply.outcome, observation: retainedObservation(reply.observation!), hopCount: reply.hops!.length }); return reply;
    }

    process.on("unhandledRejection", onRunnerUnhandled); process.on("uncaughtExceptionMonitor", onRunnerUnhandled);
    try {
      budgetTimer = setInterval(() => { try { assertRootIdentities(); resourceSnapshot(aggregate, JSON_CAP); } catch (error) { budgetFailure = error; } }, 2_000);
      fixture = await checked(async () => (startFixture(origins, sentinels)));
      receipt.fixture = { transport: "exact-two-invalid-origins-via-named-http-proxy-no-forwarding", dynamicPort: fixture.port, scriptSha256: fixture.scriptSha256, cspPolicySha256: sha(fixture.policy), cspScope: "strict-self-script-and-explicit-two-owned-connect-origins" };
      const userDataDir = path.join(owned, "controller-userdata");
      let userDataAbsent = false;
      try { fs.lstatSync(userDataDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") userDataAbsent = true; else throw error; }
      requireFact(userDataAbsent, "FRESH_LAUNCHER_MUST_ONLY_RECEIVE_NEVER_EXISTING_CHILD"); // Also rejects dangling symlinks.
      // Do NOT load app.ts -> diag.ts: that graph creates a repository screenshot
      // directory. The one small E2E-only helper reuses inert launch-env.ts and
      // an actual Playwright Electron launch, refuses reset/rm, and binds its
      // listen(0) REST port to that exact owned main and service identity.
      const { launchNetworkHeadlessApp } = await checked(async () => (import("./helpers/network-headless-app.js")));
      controllerLaunchPending = true;
      try {
        controller = await checked(async () => (launchNetworkHeadlessApp({ repoDir: REPO, ownedRoot: owned, userDataDir, chromiumBinary: binary,
          token: "synthetic-network-rest-token", mcpToken: "synthetic-network-mcp-token", timeoutMs: 30_000, absoluteDeadlineAt: scopeNow().end })));
      } catch (error) {
        const pid = error && typeof error === "object" && "ownedPid" in error ? error.ownedPid : null;
        receipt.cleanup.push({ kind: "controller-startup", ownedPid: Number.isInteger(pid) ? pid : null, state: "startup-identity-or-cleanup-unverified-no-implicit-close" }); throw error;
      }
      controllerLaunchPending = false;
      controller.app.process().stderr?.on("data", onStderr);
      const isolation = await checked(async () => (controller.app.evaluate(({ app, BrowserWindow }) => ({ headless: process.argv.includes("--headless"), windows: BrowserWindow.getAllWindows().length,
        appPath: app.getAppPath(), home: process.getBuiltinModule("node:os").homedir(), userData: app.getPath("userData"), noSandbox: app.commandLine.hasSwitch("no-sandbox"), mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
        hasProviderEnvironment: Object.keys(process.env).some(key => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)) }))));
      requireFact(isolation.headless && isolation.windows === 0 && !isolation.noSandbox && isolation.mockKeychain && !isolation.hasProviderEnvironment && fs.realpathSync(isolation.appPath) === fs.realpathSync(REPO) && fs.realpathSync(isolation.home) === fs.realpathSync(path.join(userDataDir, "test-home")) && fs.realpathSync(isolation.userData) === fs.realpathSync(userDataDir), "ACTUAL_HEADLESS_CONTROLLER_ISOLATION_AND_NORMAL_MOCK_KEYCHAIN_REQUIRED");
      const fresh = disk();
      requireFact(Object.keys(object(fresh.browserProfiles, "FRESH_PROFILE_MAP_REQUIRED")).length === 0 && Object.keys(object(fresh.proxies, "FRESH_PROXY_MAP_REQUIRED")).length === 0 && Object.keys(object(fresh.profileHealthHistory || {}, "FRESH_HEALTH_HISTORY_REQUIRED")).length === 0 && Array.isArray(fresh.automation) && fresh.automation.length === 0 && (!fresh.sync || object(fresh.sync, "FRESH_SYNC_CONFIG_REQUIRED").enabled !== true), "GENUINELY_FRESH_NO_PROFILES_PROXIES_HISTORY_RULES_OR_ENABLED_SYNC_REQUIRED");
      privateSurface(fresh, "fresh_actual_config");
      receipt.cases.push({ name: "source-guided-headless-startup-boundary", emptyProfiles: true, emptyAutomation: true, noEnabledSync: true, existingNormalMockKeychain: true, systemEngineDiscoveryRuntimeProof: "not-claimed" });
      await checked(async () => (controller.app.evaluate(async ({ app, BrowserWindow, session }, input) => {
        async function remoteWait<T>(factory: () => T | PromiseLike<T>): Promise<T> {
          const end = input.end; if (!Number.isFinite(end) || Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const value = await Promise.race([Promise.resolve().then(() => { if (Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE"); return factory(); }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("REMOTE_ABSOLUTE_DEADLINE")), Math.max(1, end - Date.now())); })]);
            if (Date.now() >= end) throw new Error("REMOTE_LATE_RESULT_REJECTED"); return value;
          } finally { if (timer) clearTimeout(timer); }
        }

        if (BrowserWindow.getAllWindows().length || (globalThis as any).__absNetworkAcceptanceMain) throw new Error("EXCLUSIVELY_OWNED_HEADLESS_UI_REQUIRED");
        const p = process.getBuiltinModule("node:path"), u = process.getBuiltinModule("node:url"), vm = process.getBuiltinModule("node:vm");
        const url = u.pathToFileURL(p.join(app.getAppPath(), "dist/main/services/renderer-storage.js")).href;
        if (url !== input.storageUrl) throw new Error("EXACT_LOADED_RENDERER_STORAGE_URL_REQUIRED");
        const storage = await remoteWait(async () => (vm.runInThisContext(`import(${JSON.stringify(url)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })));
        if (storage.UI_STORAGE_PARTITION !== "persist:app") throw new Error("PRODUCTION_UI_PARTITION_CHANGED");
        const ui = session.fromPartition(storage.UI_STORAGE_PARTITION);
        const state = (globalThis as any).__absNetworkAcceptanceMain = { tag: input.tag, session: ui, windows: new Map(), unexpectedVisible: 0,
          scriptSubresourcesDenied: 0, deniedExternal: 0, deniedDownload: 0, deniedPopup: 0, deniedWebview: 0, deniedNavigation: 0 };
        ui.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); ui.setPermissionCheckHandler(() => false);
        ui.on("will-download", event => { event.preventDefault(); state.deniedDownload++; });
        ui.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
          if (details.resourceType === "script") { state.scriptSubresourcesDenied++; callback({ cancel: true }); return; }
          let allowed = false;
          try {
            const target = new URL(details.url);
            if (target.protocol === "file:") {
              const relative = p.relative(input.rendererRoot, u.fileURLToPath(target));
              allowed = relative !== ".." && !relative.startsWith(".." + p.sep) && !p.isAbsolute(relative);
            } else allowed = target.protocol === "data:" && details.resourceType === "image" || target.href === "about:blank";
          } catch { allowed = false; }
          if (!allowed) state.deniedExternal++;
          callback({ cancel: !allowed });
        });
      }, { tag: runTag, storageUrl: pathToFileURL(path.join(REPO, "dist/main/services/renderer-storage.js")).href, rendererRoot: path.join(REPO, "dist/renderer") , end: scopeNow().end})));
      const owner = await checked(async () => (createHidden("owner"))), intruder = await checked(async () => (createHidden("other-renderer")));
      await checked(async () => (assertHiddenIsolation()));
      const storageBefore = await checked(async () => (localStorage(owner))); expect(await checked(async () => (localStorage(intruder)))).toEqual(storageBefore);
      requireFact((await checked(async () => (request(controller.port, null, "GET", "/health")))).status === 200, "PUBLIC_REAL_HEALTH_200_REQUIRED");
      await checked(async () => (api("POST", "/api/proxies", { name: "network-local-only", config: { type: "http", host: LOOPBACK, port: fixture.port } })));
      const created = await checked(async () => (api("POST", "/api/profiles", { name: "Owned finite network acceptance", engine: "chromium", fingerprintMode: "managed", platform: "macos", fingerprintSeed: 730150,
        locale: "en-US", timezone: "UTC", webrtcMode: "disable", geolocationMode: "disable", appUrl: null, proxyMode: "named", proxyName: "network-local-only" })));
      requireFact(typeof created.dirId === "string" && /^ab_[A-Za-z0-9_-]+$/.test(created.dirId), "FRESH_SYNTHETIC_PROFILE_ID_REQUIRED"); const id = created.dirId;
      const auth = [];
      for (const credential of [null, "synthetic-network-wrong-token", controller.token]) auth.push((await checked(async () => (request(controller.port, credential, "GET", "/api/proxies/health")))).status);
      expect(auth).toEqual([401, 401, 200]); receipt.cases.push({ name: "actual-public-and-protected-REST-sockets", publicHealth: 200, protectedRoute: "/api/proxies/health", statuses: auth });
      // TEST FIXTURE ONLY: seed one unrelated typed row through the existing
      // production config-manager transaction, NOT checkDrift/beginHealthRun:
      // those older paths can call statusBrowser and adopt discovered processes.
      const emptyRuntime = await checked(async () => (cachedRuntime(id))); requireFact(!emptyRuntime.present && emptyRuntime.entryCount === 0, "EMPTY_CACHED_RUNTIME_REQUIRED_FOR_HISTORY_FIXTURE");
      await checked(async () => (controller.app.evaluate(async ({ app }, input) => {
        async function remoteWait<T>(factory: () => T | PromiseLike<T>): Promise<T> {
          const end = input.end; if (!Number.isFinite(end) || Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const value = await Promise.race([Promise.resolve().then(() => { if (Date.now() >= end) throw new Error("REMOTE_ABSOLUTE_DEADLINE"); return factory(); }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("REMOTE_ABSOLUTE_DEADLINE")), Math.max(1, end - Date.now())); })]);
            if (Date.now() >= end) throw new Error("REMOTE_LATE_RESULT_REJECTED"); return value;
          } finally { if (timer) clearTimeout(timer); }
        }

        const p = process.getBuiltinModule("node:path"), u = process.getBuiltinModule("node:url"), vm = process.getBuiltinModule("node:vm");
        const url = u.pathToFileURL(p.join(app.getAppPath(), "dist/main/services/config-manager.js")).href;
        if (url !== input.url) throw new Error("EXACT_LOADED_CONFIG_FIXTURE_URL_REQUIRED");
        const manager = await remoteWait(async () => (vm.runInThisContext(`import(${JSON.stringify(url)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })));
        if (Date.now() >= input.end || manager.getProfileHealthHistory(input.id).length) throw new Error("FRESH_UNRELATED_HISTORY_FIXTURE_REQUIRED");
        manager.appendProfileHealthResult(input.id, { kind: "consistency", source: "cached", outcome: "inconclusive", at: Date.now(), summary: "synthetic-unrelated-health-control", requestId: input.requestId });
      }, { id, requestId: `network-unrelated-fixture-${randomUUID()}`, url: pathToFileURL(path.join(REPO, "dist/main/services/config-manager.js")).href, end: scopeNow().end })));
      const unrelatedBefore = (await checked(async () => (verifyHistory(owner, id)))).filter(entry => entry.kind !== "network"); requireFact(unrelatedBefore.length === 1, "UNRELATED_HISTORY_CONTROL_REQUIRED");
      await checked(async () => (launchNative(id)));

      receipt.phase = "initiator-versus-destination controls on selected A before deliberate A CSP traffic";
      const beforeBToA = fixture.snapshot();
      const bToA = await checked(() => completedWindow(owner, id, "selected-a-b-initiates-to-a", async () => {
        const b = native!.pages![1];
        await checked(() => b.locator("#cross").click({ timeout: remainingMs(3_000) }));
        await checked(() => until("B_TO_A_REAL_CROSS_ORIGIN_REQUEST_COMPLETED", async () => await checked(() => b.locator("#cross-done").innerText({ timeout: remainingMs(1_000) })) === "1", 5_000));
        requireFact(await checked(() => b.locator("#cross-status").innerText({ timeout: remainingMs(1_000) })) === "200", "B_TO_A_CORS_RESPONSE_MUST_BE_REAL_200");
      }));
      requireFact(fixture.snapshot().a === beforeBToA.a + 1 && fixture.snapshot().b === beforeBToA.b && fixture.snapshot().crossToA === beforeBToA.crossToA + 1, "B_INITIATES_REQUEST_TO_A_PROXY_WITNESS_REQUIRED");
      requireFact(COUNTER_KEYS.every(key => bToA.observation!.counts[key] === 0) && bToA.hops!.length === 0 && bToA.httpStatusEvidence!.length === 0, "DESTINATION_A_MUST_NOT_ADMIT_OTHER_INITIATING_TARGET_B");
      const beforeAToB = fixture.snapshot();
      const aToB = await checked(() => completedWindow(owner, id, "selected-a-a-initiates-to-b", async () => {
        const a = native!.pages![0];
        // Trigger BOTH selected-A requests in this SAME armed window before
        // waiting for either body. The existing capped failure projection maps
        // every safe hop, so both origins/terminal facts survive a failed window.
        await checked(() => a.locator("#cross").click({ timeout: remainingMs(3_000) }));
        await checked(() => a.locator("#success").click({ timeout: remainingMs(3_000) }));
        await checked(() => until("PAIRED_CROSS_AND_SAME_ORIGIN_BODIES_COMPLETED", async () => {
          const crossDone = await checked(() => a.locator("#cross-done").innerText({ timeout: remainingMs(1_000) }));
          const sameDone = await checked(() => a.locator("#success-done").innerText({ timeout: remainingMs(1_000) }));
          return crossDone === "1" && sameDone === "1";
        }, 5_000));
        requireFact(await checked(() => a.locator("#cross-status").innerText({ timeout: remainingMs(1_000) })) === "200", "A_TO_B_CORS_BODY_RESPONSE_MUST_BE_REAL_200");
        requireFact(await checked(() => a.locator("#success-status").innerText({ timeout: remainingMs(1_000) })) === "200", "PAIRED_SAME_ORIGIN_BODY_RESPONSE_MUST_BE_REAL_200");
      }));
      requireFact(fixture.snapshot().b === beforeAToB.b + 1 && fixture.snapshot().a === beforeAToB.a + 1 && fixture.snapshot().crossToB === beforeAToB.crossToB + 1 && fixture.snapshot().success === beforeAToB.success + 1, "PAIRED_CROSS_AND_SAME_ORIGIN_PROXY_WITNESSES_REQUIRED");
      requireFact(aToB.hops!.length === 2 && origins.every(origin => aToB.hops!.filter(hop => hop.origin === origin && hop.status === 200 && hop.terminal === "finished").length === 1), "SELECTED_A_MUST_FINISH_BOTH_CROSS_AND_SAME_ORIGIN_HOPS");
      requireFact(COUNTER_KEYS.every(key => aToB.observation!.counts[key] === (["requests", "hops", "responses", "finished"].includes(key) ? 2 : 0)), "PAIRED_SELECTED_A_COUNTERS_MUST_MATCH_BOTH_FINISHED_HOPS");
      receipt.cases.push({ name: "initiator-not-destination-authority", selectedTarget: "A", discardedOtherInitiatorBToDestinationA: true, includedOwnInitiatorAToDestinationB: true, sameOriginPairedControl: true, fixtureBodiesConsumedWithoutRetention: true, beforeDeliberateCsp: true });
      receipt.phase = "selected A mixed traffic, CSP, privacy and real history data flow";
      const mixed = await checked(async () => (completedWindow(owner, id, "mixed", async () => {
        const a = native!.pages![0];
        await checked(async () => (a.locator("#mixed").click())); await checked(async () => (until("MIXED_FIXTURE_ACTIONS_REQUIRED", async () => await checked(async () => (a.locator("#mixed-done").innerText())) === "1", 6_000)));
        requireFact(await checked(async () => (a.locator("#statuses").innerText())) === "200,200,403,429,503,200" && await checked(async () => (a.locator("#driver-error").innerText())) === "", "REAL_MIXED_RESPONSE_CONTROLS_REQUIRED");
        // Independent fixture-driver proof that the site produced CSP violations.
        // It is correct for this counter to be positive while observer cspIssues
        // is zero/unavailable: issueAdded lacks positive violated-root-frame
        // identity, and the passive observer must not resolve DOM nodes to infer it.
        await checked(async () => (until("STRICT_CSP_CONTROLS_REQUIRED", async () => Number(await checked(async () => (a.locator("#csp-count").innerText()))) >= 2, 3_000)));
        requireFact(await checked(async () => (a.evaluate(() => (window as any).__absInlineRan !== true))), "INLINE_CSP_CONTROL_MUST_REMAIN_BLOCKED");
      }, 0, true)));
      const mixedObservation = mixed.observation!, mixedCounts = mixedObservation.counts;
      requireFact(mixedCounts.requests === 8 && mixedCounts.hops === 8 && mixedCounts.responses === 7 && mixedCounts.redirects === 1 && mixedCounts.http4xx === 2 && mixedCounts.http5xx === 1 && mixedCounts.finished === 6 && mixedCounts.failed === 0 && mixedCounts.blocked === 1 && mixedCounts.requestCancelled === 0 && mixedCounts.pending === 0 && mixedCounts.cache === 0 && mixedCounts.serviceWorker === 0, "EXACT_MIXED_SELECTED_A_CHAIN_HOP_FACTS_REQUIRED");
      for (const status of [200, 302, 403, 429, 503]) requireFact(mixed.hops!.some(hop => hop.status === status), "RESPONSE_REDIRECT_STATUS_LOST");
      requireFact(mixed.hops!.some(hop => hop.status === 302 && hop.terminal === "redirected"), "REDIRECT_HOP_TERMINAL_FACT_REQUIRED");
      // This implication guards a claimed capability; it does NOT require the
      // current passive agent to claim observed coverage or nonzero cspIssues.
      // Unavailable/zero is honest despite the separate positive fixture counter.
      if (mixedObservation.coverage.csp === "observed") requireFact(mixedCounts.cspIssues > 0, "DECLARED_CSP_OBSERVED_WITHOUT_ACTUAL_POSITIVE_CONTROL_ISSUES");
      else requireFact(mixedObservation.coverage.csp === "unavailable" && mixedCounts.cspIssues === 0, "CSP_MUST_BE_EXPLICITLY_UNAVAILABLE_WITHOUT_AUDITS");
      const fixtureStats = fixture.snapshot();
      requireFact(fixtureStats.crossToA === 1 && fixtureStats.crossToB === 1 && fixtureStats.posts === 1 && fixtureStats.bodyMatched === 1 && fixtureStats.requestHeaderMatched === 1 && fixtureStats.cookieMatched > 0 && fixtureStats.responseSentinelsServed >= 10, "REAL_SENTINELS_OR_OTHER_PAGE_CONTROL_NOT_EXERCISED");
      const historyAfterMixed = await checked(async () => (verifyHistory(owner, id))), entry = historyAfterMixed.find(row => row.kind === "network" && row.requestId === mixed.requestId);
      requireFact(entry, "ACTUAL_DISK_NETWORK_RESULT_NOT_FOUND_BY_REQUEST_ID"); const stored = typedHistorySummary(entry);
      expect(stored.counts).toEqual(mixedCounts); expect(stored.coverage).toEqual(mixedObservation.coverage);
      await checked(async () => (reloadAndSearch(owner, id, historyAfterMixed, mixed.requestId)));
      expect(await checked(async () => (localStorage(owner)))).toEqual(storageBefore); expect(await checked(async () => (localStorage(intruder)))).toEqual(storageBefore);

      receipt.phase = "quiet and finite no-error windows cannot produce website/proxy PASS";
      const quiet = await checked(async () => (completedWindow(owner, id, "quiet")));
      requireFact(quiet.observation!.counts.requests === 0 && quiet.observation!.counts.hops === 0 && quiet.hops!.length === 0, "QUIET_CONTROL_WAS_NOT_QUIET");
      const clean = await checked(async () => (completedWindow(owner, id, "finite-clean", async () => {
        await checked(async () => (native!.pages![0].locator("#success").click())); await checked(async () => (until("CLEAN_SUCCESS_DRIVER_REQUIRED", async () => await checked(async () => (native!.pages![0].locator("#success-done").innerText())) === "2", 4_000)));
      })));
      requireFact(clean.observation!.counts.responses >= 1 && clean.observation!.counts.finished >= 1 && clean.observation!.counts.failed === 0 && clean.observation!.counts.pending === 0, "CLEAN_FINITE_TRAFFIC_CONTROL_REQUIRED");
      await checked(async () => (verifyHistory(owner, id)));

      receipt.phase = "cross-renderer handle/cancel refusal, active lease and owner cancellation";
      const selection = await checked(async () => (selectA(owner, id))), cancelledId = `network-owner-cancel-${randomUUID()}`;
      const stolen = deniedReply(await checked(async () => (invoke(intruder, "networkObserve", id, { selection: selection.handle, requestId: `network-stolen-${randomUUID()}` }))), "cross_renderer_selection");
      await checked(async () => (intruder.page.evaluate(() => {
        const w = window as any; if (w.__absNetworkForeignSpy) throw new Error("SPY_ALREADY_EXISTS");
        const spy: any = { count: 0 }; spy.unsubscribe = w.agentBrowserAPI.browser.onNetworkArmed(() => { spy.count++; }); w.__absNetworkForeignSpy = spy;
      })));
      const beforeCancelHistory = await checked(async () => (verifyHistory(owner, id)));
      await checked(async () => (begin(owner, id, selection.handle, cancelledId))); await checked(async () => (armed(owner)));
      const heldBeforeCancel = fixture.snapshot().held;
      await checked(async () => (nativeAction("held-before-owner-cancel", () => native!.pages![0].locator("#held").click())));
      await checked(async () => (until("REAL_PENDING_REQUEST_BEFORE_CANCEL", () => fixture!.snapshot().held === heldBeforeCancel + 1 && fixture!.snapshot().activeHolds === 1, 4_000)));
      const otherSelection = await checked(async () => (selectA(intruder, id)));
      const busy = deniedReply(await checked(async () => (invoke(intruder, "networkObserve", id, { selection: otherSelection.handle, requestId: `network-busy-${randomUUID()}` }))), "active_profile_lease");
      requireFact(busy.code === "HEALTH_BUSY", "EXISTING_PROFILE_HEALTH_LEASE_MUST_BE_REUSED");
      const refusal = object(await checked(async () => (invoke(intruder, "healthCancel", id, { kind: "network", requestId: cancelledId }))), "FOREIGN_CANCEL_REQUIRED"); privateSurface(refusal, "foreign_cancel");
      requireFact(refusal.success === false && refusal.cancelled === false && refusal.code === "HEALTH_INVALID_REQUEST" && !(await checked(async () => (currentState(owner))))!.settled, "CROSS_RENDERER_CANCEL_MUST_NOT_CANCEL_OWNER");
      const cancel = object(await checked(async () => (invoke(owner, "healthCancel", id, { kind: "network", requestId: cancelledId }))), "OWNER_CANCEL_REQUIRED"); privateSurface(cancel, "owner_cancel");
      requireFact(cancel.success === true && cancel.cancelled === true, "OWNER_CANCEL_NOT_ACCEPTED");
      const cancelled = currentReply(await checked(async () => (finish(owner))), cancelledId); requireFact(cancelled.observation!.completion === "cancelled" && cancelled.outcome === "cancelled", "OWNER_CANCEL_CANNOT_COMPLETE_OR_PASS");
      fixture.releaseHolds();
      await checked(async () => (until("CANCELLED_DRIVER_REQUEST_CLEANUP", () => fixture!.snapshot().activeHolds === 0, 4_000)));
      expect(await checked(async () => (verifyHistory(owner, id)))).toEqual(beforeCancelHistory);
      const foreignArmed = await checked(async () => (intruder.page.evaluate(() => { const w = window as any, spy = w.__absNetworkForeignSpy; try { spy.unsubscribe(); return spy.count; } finally { delete w.__absNetworkForeignSpy; } })));
      requireFact(foreignArmed === 0, "ARMED_EVENT_MUST_NOT_BROADCAST_TO_ANOTHER_RENDERER");
      receipt.cases.push({ name: "sender-bound-selection-cancel-and-lease", stolenCode: stolen.code, busyCode: busy.code, crossRendererCancelCode: refusal.code, ownerCompletion: cancelled.observation!.completion, historyUnchanged: true, foreignArmedEvents: foreignArmed });

      receipt.phase = "active narrow clear, late-result fencing and reload/search absence";
      const clearSelection = await checked(async () => (selectA(owner, id))), clearedId = `network-active-clear-${randomUUID()}`;
      await checked(async () => (begin(owner, id, clearSelection.handle, clearedId))); const clearArmed = await checked(async () => (armed(owner)));
      const heldBeforeClear = fixture.snapshot().held;
      await checked(async () => (nativeAction("held-before-clear", () => native!.pages![0].locator("#held").click())));
      await checked(async () => (until("REAL_PENDING_REQUEST_BEFORE_CLEAR", () => fixture!.snapshot().held === heldBeforeClear + 1 && fixture!.snapshot().activeHolds === 1, 4_000)));
      await checked(async () => (clearNetwork(owner, id)));
      requireFact(diskHistory(id).every(row => row.kind !== "network"), "CLEAR_DID_NOT_REMOVE_ACTUAL_DISK_SUMMARIES");
      expect(diskHistory(id)).toEqual(unrelatedBefore);
      const cleared = currentReply(await checked(async () => (finish(owner))), clearedId); requireFact(cleared.observation!.completion === "cancelled" && cleared.outcome !== "pass", "CLEARED_ACTIVE_RESULT_MUST_BE_FENCED");
      fixture.releaseHolds();
      await checked(async () => (until("CLEAR_DRIVER_REQUEST_CLEANUP", () => fixture!.snapshot().activeHolds === 0, 4_000)));
      await checked(async () => (until("ORIGINAL_ARMED_WINDOW_AND_LATE_TIMER_FENCE", () => Date.now() >= clearArmed.armedAt + clearArmed.observeForMs + 500, 12_000)));
      expect(await checked(async () => (verifyHistory(owner, id)))).toEqual(unrelatedBefore);
      await checked(async () => (reloadAndSearch(owner, id, unrelatedBefore)));
      requireFact(!(await checked(async () => (verifyHistory(owner, id)))).some(row => row.kind === "network" && row.requestId === clearedId), "CLEARED_REQUEST_REAPPEARED_AFTER_RELOAD");
      expect(await checked(async () => (localStorage(owner)))).toEqual(storageBefore);
      receipt.cases.push({ name: "active-clear-late-result-and-reload", requestId: clearedId, completion: cleared.observation!.completion, originalWindowElapsed: true, unrelatedHistoryRetained: true, diskAndPreloadEmptyForNetwork: true });

      receipt.phase = "stale handle after owned test-driver graceful native cleanup and fresh same-profile restart (product stop not exercised)";
      const staleAt = Date.now(), staleSelection = await checked(async () => (selectA(owner, id))), retired = { pid: native!.pid, port: native!.port };
      await checked(async () => (gracefulNativeFixtureCleanup())); await checked(async () => (launchNative(id, retired)));
      requireFact(Date.now() - staleAt < 30_000, "HANDLE_EXPIRED_BEFORE_RESTART_FENCE_COULD_BE_PROVEN");
      const stale = deniedReply(await checked(async () => (invoke(owner, "networkObserve", id, { selection: staleSelection.handle, requestId: `network-stale-${randomUUID()}` }))), "retired_runtime_selection");
      requireFact(!/EXPIRED|TIMEOUT/i.test(String(stale.code)), "EXPIRATION_IS_NOT_RESTART_INVALIDATION_PROOF");
      expect(await checked(async () => (verifyHistory(owner, id)))).toEqual(unrelatedBefore);
      receipt.cases.push({ name: "retired-runtime-selection", code: stale.code, productStopVerification: "not-exercised", ownedDriverGracefulNativeCleanup: true, freshReturnedPidAndPortOnly: true, withinSelectionTtl: true, retiredPortAvailability: "not-probed-unverified" });

      receipt.phase = "armed real proxy listener/socket failure with native document left loaded";
      const failureSelection = await checked(async () => (selectA(owner, id))), failureId = `network-real-proxy-failure-${randomUUID()}`;
      const page = native!.pages![0]; let nativeFailureCode: string | null = null, independentFailures = 0;
      const onRequestFailure = (failed: import("playwright").Request) => {
        if (failed.url() !== fixture!.failureUrl) return;
        independentFailures++;
        const code = failed.failure()?.errorText.match(/(?:net::)?(ERR_[A-Z0-9_]+)/)?.[1];
        nativeFailureCode = code || null; // Native message/URL remains volatile and is NOT retained.
      };
      page.on("requestfailed", onRequestFailure);
      try {
        await checked(async () => (begin(owner, id, failureSelection.handle, failureId))); const failureArmed = await checked(async () => (armed(owner)));
        await checked(async () => (nativeAction("close-only-owned-proxy", async () => { await checked(async () => (fixture!.close())); })));
        requireFact(fixture.snapshot().closed && fixture.snapshot().activeSockets === 0, "REAL_PROXY_NOT_CLOSED");
        await checked(async () => (nativeAction("actual-request-after-proxy-close", async () => {
          await checked(async () => (page.locator("#failure").click()));
          await checked(async () => (until("REAL_NATIVE_BACKGROUND_REQUEST_MUST_FAIL", async () => independentFailures >= 1 && await checked(async () => (page.locator("#failure-done").innerText())) === "1", 6_000)));
          requireFact(page.url() === fixture!.pageUrl(0) && await checked(async () => (page.title())) === sentinels.title, "DOCUMENT_SHOULD_REMAIN_LOADED_DURING_BACKGROUND_FAILURE");
        })));
        const failure = currentReply(await checked(async () => (finish(owner))), failureId, true);
        requireFact(Date.now() >= failureArmed.armedAt + failureArmed.observeForMs - 100, "INDEPENDENT_PROXY_FAILURE_WINDOW_ELAPSED_REQUIRED");
        requireFact(failure.observation!.counts.failed >= 1 && failure.observation!.counts.pending === 0, "OBSERVER_DID_NOT_REPORT_REAL_NATIVE_FAILURE");
        const observedCodes = failure.hops!.flatMap(hop => typeof hop.errorCode === "string" ? [hop.errorCode.replace(/^net::/, "")] : []);
        requireFact(observedCodes.length > 0, "OBSERVED_NATIVE_ERROR_CODE_REQUIRED");
        if (nativeFailureCode) requireFact(observedCodes.includes(nativeFailureCode), "INDEPENDENT_NATIVE_AND_OBSERVER_FAILURE_CODE_DISAGREE");
        const history = await checked(async () => (verifyHistory(owner, id))); await checked(async () => (reloadAndSearch(owner, id, history, failureId)));
        receipt.cases.push({ name: "actual-proxy-listener-failure", requestId: failureId, observation: retainedObservation(failure.observation!), observerNativeCodes: [...new Set(observedCodes)],
          independentNativeCode: nativeFailureCode, comparison: nativeFailureCode ? "matched-native-code" : "unavailable-driver-did-not-expose-stable-native-code",
          nativeFailures: independentFailures, documentStillLoaded: true, causeAttribution: "not-inferred-no-hop-auth-or-fingerprint-claim" });
      } finally { page.off("requestfailed", onRequestFailure); }
      await checked(async () => (clearNetwork(owner, id)));
      expect(await checked(async () => (verifyHistory(owner, id)))).toEqual(unrelatedBefore); await checked(async () => (reloadAndSearch(owner, id, unrelatedBefore)));
      expect(await checked(async () => (localStorage(owner)))).toEqual(storageBefore); expect(await checked(async () => (localStorage(intruder)))).toEqual(storageBefore);
      await checked(async () => (assertHiddenIsolation())); checkpoint();
      requireFact(await checked(async () => (fileHash(binary))) === binarySha && await checked(async () => (fileHash(framework))) === frameworkSha, "SELECTED_NATIVE_ARTIFACT_CHANGED");
      expect(compiledIdentity()).toEqual(compiled); expect(harnessIdentity()).toEqual(harness);
      receipt.phase = "assertions completed; owned cleanup and outer runner still required";
    } catch (error) {
      receipt.status = "failed"; receipt.failures.push({ phase: receipt.phase, ...safeFailure(error),
        ...(controlFailureDiagnostic ? { networkControlDiagnostic: controlFailureDiagnostic } : {}),
        ...(controlFailureDiagnosticUnavailable ? { networkControlDiagnosticUnavailable: controlFailureDiagnosticUnavailable } : {}),
      });
    }
    finally {
      cleaning = true;
      awaitScopes.enterWith({ root: awaitRoot, end: awaitRoot.cleanupEnd, cleaning: true });
      // Cancellation targets only our exact request IDs / own hidden senders.
      // Never release a lease ourselves or close the controller before the
      // awaited result's cleanup and exact native process shutdown are known.
      for (const target of hidden) {
        const pending = activeRuns.get(target.windowId);
        if (pending) {
          try {
            await checked(async () => (invoke(target, "healthCancel", pending.dirId, { kind: "network", requestId: pending.requestId })));
            const result = await checked(async () => (finish(target))); privateSurface(result, "cleanup_result", true);
            receipt.cleanup.push({ kind: "observer", requestId: pending.requestId, awaitedResultSettled: true });
          } catch (error) { receipt.cleanup.push({ kind: "observer", state: "cleanup-unverified", ...safeFailure(error) }); receipt.status = "cleanup-unverified"; }
        }
        try { await checked(async () => (target.page.evaluate(() => { const w = window as any, spy = w.__absNetworkForeignSpy; if (spy) { try { spy.unsubscribe(); } finally { delete w.__absNetworkForeignSpy; } } }))); }
        catch (error) { receipt.cleanup.push({ kind: "armed-subscription", state: "cleanup-unverified", ...safeFailure(error) }); receipt.status = "cleanup-unverified"; }
      }
      try { await checked(async () => (gracefulNativeFixtureCleanup())); }
      catch (error) { receipt.cleanup.push({ kind: "native", state: "cleanup-unverified-no-foreign-stop-or-kill", ...safeFailure(error) }); receipt.status = "cleanup-unverified"; }
      // Dispose only this driver's sessions/connections, never the product's
      // observer transport. Client detach is NOT proof of native process stop.
      for (const [session, state] of ownedDriverSessions) {
        if (state.detachStarted) continue;
        state.detachStarted = true;
        try { await checked(async () => (deadline("OWN_DRIVER_SESSION_DETACH_DEADLINE", () => session.detach(), 2_000))); ownedDriverSessions.delete(session); }
        catch (error) { receipt.cleanup.push({ kind: "driver-session-only", state: "cleanup-unverified", ...safeFailure(error) }); receipt.status = "cleanup-unverified"; }
      }
      for (const browser of ownedDriverClients) {
        try {
          if (browser.isConnected()) await checked(async () => (deadline("OWN_DRIVER_CLIENT_DETACH_DEADLINE", () => browser.close(), 2_000))); // connectOverCDP client disconnect ONLY.
          ownedDriverClients.delete(browser); receipt.cleanup.push({ kind: "driver-client-only", nativeStopProven: false });
        } catch (error) { receipt.cleanup.push({ kind: "driver-client-only", state: "cleanup-unverified", ...safeFailure(error) }); receipt.status = "cleanup-unverified"; }
      }
      if (controller) {
        const child = controller.app.process(), pid = child.pid;
        if (native || nativeLaunchPending || activeRuns.size || pendingDriverConnects.size || ownedDriverSessions.size || ownedDriverClients.size || awaitRoot.pending.size || controller.awaitState().pending || controller.awaitState().timedOut) {
          receipt.cleanup.push({ kind: "controller-and-hidden-renderers", pid: pid || null, state: "retained-cleanup-unverified", reason: "No implicit shutdown or stop/kill while native or observation ownership is unverified" }); receipt.status = "cleanup-unverified";
        } else {
          try {
            await checked(async () => (assertHiddenIsolation()));
            for (const target of [...hidden].reverse()) {
              await checked(async () => (controller.app.evaluate(({ BrowserWindow }, input) => {
                const state = (globalThis as any).__absNetworkAcceptanceMain, win = BrowserWindow.fromId(input.windowId);
                if (!state || state.tag !== input.tag || !win || state.windows.get(win.id) !== win || win.webContents.id !== input.webContentsId || win.isVisible()) throw new Error("HIDDEN_WINDOW_OWNERSHIP_CHANGED");
                win.close(); state.windows.delete(input.windowId);
              }, { tag: runTag, windowId: target.windowId, webContentsId: target.webContentsId })));
              await checked(async () => (until("OWN_HIDDEN_RENDERER_CLOSE_REQUIRED", () => target.page.isClosed(), 4_000)));
            }
            await checked(async () => (deadline("NORMAL_CONTROLLER_CLOSE_DEADLINE", () => (controller.close(scopeNow().end)), 16_000)));
            requireFact(pid, "OWNED_CONTROLLER_PID_REQUIRED");
            await checked(async () => (until("OWNED_CONTROLLER_NORMAL_EXIT_REQUIRED", () => gone(pid) && (child.exitCode !== null || child.signalCode !== null), 8_000)));
            requireFact(child.exitCode === 0 && child.signalCode === null, "CONTROLLER_NONZERO_OR_SIGNAL_EXIT");
            receipt.cleanup.push({ kind: "hidden-renderers-and-controller", pid, normalClose: true, exitCode: child.exitCode, signal: child.signalCode });
          } catch (error) { receipt.cleanup.push({ kind: "controller", pid: pid || null, state: "cleanup-unverified", ...safeFailure(error) }); receipt.status = "cleanup-unverified"; }
        }
        child.stderr?.off("data", onStderr);
      } else if (controllerLaunchPending) { receipt.cleanup.push({ kind: "controller", state: "startup-returned-no-handle-cleanup-unverified" }); receipt.status = "cleanup-unverified"; }
      if (fixture) {
        try { await checked(async () => (fixture.close())); receipt.cleanup.push({ kind: "owned-http-proxy-fixture", listenerClosed: true, socketsDrained: true }); }
        catch (error) { receipt.cleanup.push({ kind: "owned-http-proxy-fixture", state: "cleanup-unverified", ...safeFailure(error) }); receipt.status = "cleanup-unverified"; }
        receipt.fixture = { ...receipt.fixture, counters: fixture.snapshot() };
      }
      if (budgetTimer) clearInterval(budgetTimer);
      try { controllerUnhandled = Math.max(controllerUnhandled, mainUnhandledLogCount()); }
      catch (error) { receipt.failures.push({ phase: "final-main-error-log-gate", ...safeFailure(error) }); if (receipt.status !== "cleanup-unverified") receipt.status = "failed"; }
      if (budgetFailure || controllerUnhandled || rendererErrors || runnerUnhandled || awaitRoot.timedOut.size || awaitRoot.pending.size || pendingDriverConnects.size) {
        receipt.failures.push({ phase: "final-runtime-gates", budgetFailure: budgetFailure ? safeFailure(budgetFailure) : null, controllerUnhandled, rendererErrors, runnerUnhandled,
          absoluteDeadlineFailures: [...awaitRoot.timedOut], unsettledAwaitLosers: awaitRoot.pending.size, pendingOwnedDriverConnects: pendingDriverConnects.size });
        if (receipt.status !== "cleanup-unverified") receipt.status = "failed";
      }
      process.off("unhandledRejection", onRunnerUnhandled); process.off("uncaughtExceptionMonitor", onRunnerUnhandled);
      stderrTail = "";
      if (receipt.status === "running") receipt.status = "assertions-complete-awaiting-outer-runner";
      receipt.finishedAt = new Date().toISOString();
      const actualOwner = fs.lstatSync(owned);
      requireFact(actualOwner.isDirectory() && !actualOwner.isSymbolicLink() && actualOwner.uid === ownedStat.uid && actualOwner.dev === ownedStat.dev && actualOwner.ino === ownedStat.ino, "RECEIPT_DIRECTORY_OWNERSHIP_CHANGED");
      // Normal failures retain this receipt. If root identity, ownership or the
      // final space/cap guard prevents ANY safe write, fail closed instead; the
      // outer owned runner must retain that failure. Never write a fallback root
      // or erase old evidence to manufacture space for a clean-looking receipt.
      assertRootIdentities(); receipt.resources.push(resourceSnapshot(aggregate, JSON_CAP));
      privateSurface(retainedReceiptPrivacyView(), "retained_receipt");
      const serialized = JSON.stringify(receipt, null, 2); requireFact(Buffer.byteLength(serialized) < JSON_CAP, "RECEIPT_SIZE_BUDGET");
      const receiptFile = path.join(owned, "receipt.json"); fs.writeFileSync(receiptFile, serialized, { flag: "wx", mode: 0o600 });
      requireFact(sha(boundedBytes(owned, receiptFile, JSON_CAP)) === sha(serialized), "RECEIPT_DIRECT_READBACK_MISMATCH");
      // Never call force-kill/sweep helpers, pkill, killOrphanChromium, a
      // native/CDP close on unknown ownership, or remove retained failed data.
      requireFact(receipt.status === "assertions-complete-awaiting-outer-runner", "NETWORK_ACCEPTANCE_FAILED_OR_CLEANUP_UNVERIFIED_SEE_OWNED_RECEIPT");
    }
  }, 600_000);
});
