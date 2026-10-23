// Opt-in diagnostic only. Never fixes/attests the native successful-write/close
// LocalStorage durability race, a real login page, or a sandbox escape.
// ABS_CHROMIUM_CSP_STORAGE_ACCEPTANCE=1 ABS_SYNC_ACCEPTANCE_DIST_READY=1 \
// ABS_CHROMIUM_CSP_STORAGE_BUDGET_ROOT=<existing owned aggregate artifact root> \
// ABS_CHROMIUM_CSP_STORAGE_ACCEPTANCE_ROOT=<fresh empty canonical child of that root> \
// AGENT_BROWSER_CHROMIUM_BINARY_PATH=<explicit existing managed executable> \
// node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/chromium-csp-storage-acceptance.test.ts --maxWorkers=1
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { launchHeadlessApp, type HeadlessAppHandle } from "./helpers/app.js";
import { readOwnedNativeArgv, NATIVE_ARGV_LIMITATIONS } from "./helpers/native-argv.js";
import { assertChromiumReuseEvidence, chromiumLaunchRequestHash } from "../../src/main/services/browser/launch-provenance.js";
import { readChromiumGpuContext } from "../../src/main/services/browser/chromium-gpu-context.js";
import type { BrowserProfileMeta } from "../../src/main/types.js";

const OPTED_IN = process.env.ABS_CHROMIUM_CSP_STORAGE_ACCEPTANCE === "1";
const REPO = path.resolve(__dirname, "..", "..");
const LOOPBACK = "127.0.0.1"; // Explicit owned HTTP/proxy fixture, always listen(0).
const GIB = 1024 ** 3, MIN_FREE = 6 * GIB, AGGREGATE_CAP = GIB;
const JSON_CAP = 2 * 1024 ** 2, EVENT_CAP = 256 * 1024, FILE_CAP = 16 * 1024 ** 2;
// Source-guided positive boundary: 8Mi ASCII code units account for 16MiB
// UTF-16 value bytes. The selected executable still has to demonstrate it.
const SMALL_UNITS = 64 * 1024, LARGE_CAP_UNITS = 8 * 1024 ** 2;
const CSP = "default-src 'none'; script-src 'self'; frame-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const INLINE_CONTROL = "window.__absCspInlinePositiveControlExecuted = true;";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
type Mode = "managed" | "off";
type Dict = Record<string, unknown>;
type Phase = "baseline" | "positive-inline-control" | "storage" | "sandbox-attribute-control";
interface ErrorFact { name: string; message: string }
interface KeyCount { present: boolean; keyCodeUnits: number; valueCodeUnits: number; utf16Bytes: number }
interface WriteFact {
  state: "success" | "error"; valueCodeUnits: number; valueUtf8Bytes: number; keyCodeUnits: number;
  attemptedUtf16Bytes: number; observed: KeyCount; readbackEqual: boolean;
  error: ErrorFact | null; priorValueUnchanged: boolean | null;
}
interface StorageFact {
  done: boolean; errors: ErrorFact[]; basic: WriteFact | null; attempts: WriteFact[];
  boundary: "quota-exceeded" | "finite-cap-not-reached" | "other-error" | "not-started";
  postBoundarySmall: WriteFact | null; largeRemovedBeforeRetry: boolean; largeAfterRemoval: KeyCount | null;
  cleanup: Array<{ key: "basic" | "large"; removed: boolean; observed: KeyCount; error: ErrorFact | null }>;
  estimates: Array<{ phase: string; scope: string; state: string; value?: unknown; error?: ErrorFact }>;
}
interface CspFact {
  phase: Phase; documentURI: string; blockedURI: string; effectiveDirective: string;
  violatedDirective: string; originalPolicy: string; disposition: string;
  sourceFile: string; lineNumber: number; columnNumber: number; statusCode: number; sample: string;
}
interface DocumentFact {
  schema: string; phase: Phase; externalBootstrap: boolean; externalMain: boolean; externalFrame: boolean;
  csp: CspFact[]; errors: ErrorFact[]; dropped: number; positive: { externalScriptRan: boolean; appended: boolean };
  storage: StorageFact | null;
}
interface EventFact { phase: Phase; kind: string; value: unknown }
interface NativeOwner {
  handle: HeadlessAppHandle; id: string; mode: Mode; pid: number; port: number;
  browser?: Browser; page?: Page; unsafeToStop: boolean;
}
interface RunFact {
  mode: Mode; profileId: string; proofs: unknown[]; events: EventFact[]; droppedEvents: number;
  blockedPageRequests: Array<{ phase: Phase; protocol: string }>;
  baseline?: DocumentFact[]; documents?: DocumentFact[]; partialDocuments?: unknown[]; storage?: StorageFact;
  failureObservationError?: ErrorFact;
  screenshot?: { path: string; bytes: number; sha256: string; visualReview: "pending" };
  sandbox?: { attribute: string | null; warningObserved: boolean; escapeAttempted: false };
  cdpVersion?: string; positiveInlineControl?: { blocked: boolean; violation: CspFact; source: string };
}

function object(value: unknown, label: string): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected object: ${label}`);
  return value as Dict;
}
function errorFact(error: unknown): ErrorFact {
  return error instanceof Error ? { name: error.name, message: error.message.slice(0, 4096) }
    : { name: "NonError", message: String(error).slice(0, 4096) };
}
function within(root: string, child: string): void {
  const relative = path.relative(root, child);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Expected a strict owned child path");
}
function canonicalDirectory(input: string | undefined): string {
  if (!input || !path.isAbsolute(input)) throw new Error("An explicit absolute owned directory is required");
  const stat = fs.lstatSync(input);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(input) !== path.resolve(input) || stat.uid !== process.getuid?.()) {
    throw new Error("Owned directory must be canonical, real, and owned by the current user");
  }
  return input;
}
function resourceSnapshot(root: string, reserve = 0) {
  const owner = fs.lstatSync(root);
  if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid?.()) throw new Error("Owned artifact root changed");
  let total = 0, count = 0, removedDuringScan = 0;
  const walk = (directory: string) => {
    let names: string[];
    try { names = fs.readdirSync(directory); }
    catch (error) { if (directory !== root && (error as NodeJS.ErrnoException).code === "ENOENT") { removedDuringScan++; return; } throw error; }
    for (const name of names) {
      if (++count > 50_000) throw new Error("Owned artifact inventory exceeds its finite entry budget");
      const file = path.join(directory, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { removedDuringScan++; continue; } throw error; }
      // Account for links themselves; never follow artifact/test symlinks.
      total += stat.size;
      if (total + reserve > AGGREGATE_CAP) throw new Error("Existing aggregate artifact root would exceed 1GiB");
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file);
    }
  };
  walk(root);
  const current = fs.lstatSync(root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino || current.uid !== owner.uid) throw new Error("Owned artifact root changed");
  const volume = fs.statfsSync(root, { bigint: true }), freeBytes = volume.bavail * volume.bsize;
  if (freeBytes < BigInt(MIN_FREE + reserve)) throw new Error("Development volume must retain at least 6GiB free");
  return { aggregateBytes: total, aggregateCapBytes: AGGREGATE_CAP, freeBytes: freeBytes.toString(), minimumFreeBytes: MIN_FREE, entries: count, removedDuringScan };
}
async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function ownedBytes(root: string, file: string, maximum = FILE_CAP): Buffer {
  within(root, file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw new Error("Expected bounded regular owned evidence");
  within(fs.realpathSync(root), fs.realpathSync(file));
  return fs.readFileSync(file);
}
async function until(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Owned diagnostic deadline: ${label}`);
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
async function request(port: number, token: string | null, method: string, route: string, value?: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const payload = value === undefined ? undefined : JSON.stringify(value);
    const req = http.request({ hostname: LOOPBACK, port, path: route, method,
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) } }, (res) => {
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > JSON_CAP) req.destroy(new Error("Owned REST response exceeds budget")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error("Owned REST deadline")));
    req.on("error", reject); req.end(payload);
  });
}
async function api(handle: HeadlessAppHandle, method: string, route: string, value?: unknown): Promise<Dict> {
  const reply = await request(handle.port, handle.token, method, route, value);
  expect(reply.status).toBeGreaterThanOrEqual(200); expect(reply.status).toBeLessThan(300);
  return object(reply.body, route);
}

// These are served as ordinary external scripts. No addInitScript, eval,
// unsafe-inline/unsafe-eval policy relaxation, SDK download, or app-code injection.
const BOOTSTRAP_JS = String.raw`(() => {
  const state = window.__absDiagnostic = {
    schema: 'owned-csp-storage-document/v1', phase: 'baseline', externalBootstrap: true,
    externalMain: false, externalFrame: false, csp: [], errors: [], dropped: 0,
    positive: { externalScriptRan: false, appended: false }, storage: null
  };
  window.__absCspInlinePositiveControlExecuted = false;
  const error = value => ({ name: String(value && value.name || 'Error'), message: String(value && value.message || value).slice(0, 4096) });
  document.addEventListener('securitypolicyviolation', event => {
    if (state.csp.length >= 32) { state.dropped++; return; }
    state.csp.push({ phase: state.phase, documentURI: event.documentURI, blockedURI: event.blockedURI,
      effectiveDirective: event.effectiveDirective, violatedDirective: event.violatedDirective,
      originalPolicy: event.originalPolicy, disposition: event.disposition, sourceFile: event.sourceFile,
      lineNumber: event.lineNumber, columnNumber: event.columnNumber, statusCode: event.statusCode, sample: event.sample });
  });
  window.addEventListener('error', event => { if (state.errors.length >= 32) state.dropped++; else state.errors.push(error(event.error || event.message)); });
  window.addEventListener('unhandledrejection', event => { if (state.errors.length >= 32) state.dropped++; else state.errors.push(error(event.reason)); });
})();`;
const FRAME_JS = "window.__absDiagnostic.externalFrame = true; document.getElementById('external-frame-ready').textContent = 'External frame script ran';";
const POSITIVE_JS = `window.__absDiagnostic.positive.externalScriptRan = true; const control = document.createElement('script'); control.id = 'known-blocked-inline-control'; control.textContent = ${JSON.stringify(INLINE_CONTROL)}; document.head.appendChild(control); window.__absDiagnostic.positive.appended = true;`;
const MAIN_JS = String.raw`(() => {
  const state = window.__absDiagnostic;
  const base = new URL('.', location.href).pathname;
  const keyBase = 'abs-owned-csp-storage:' + base + ':';
  const basicKey = keyBase + 'basic-json', largeKey = keyBase + 'single-large-value';
  const smallUnits = 65536, capUnits = 8388608;
  // Retain exact exception names, never storage values, even if an engine
  // includes its attempted value in an exception message.
  const fact = value => ({ name: String(value && value.name || 'Error'), message: 'Owned storage operation failed; values intentionally not retained' });
  const count = (key, value) => ({ present: value !== null, keyCodeUnits: value === null ? 0 : key.length,
    valueCodeUnits: value === null ? 0 : value.length, utf16Bytes: value === null ? 0 : 2 * (key.length + value.length) });
  const cacheValue = label => {
    const record = { diagnosticCacheVersion: 1, label, payload: '' };
    record.payload = 'x'.repeat(smallUnits - JSON.stringify(record).length);
    return JSON.stringify(record);
  };
  async function estimate(result, phase) {
    const scope = 'StorageManager.estimate; NOT a localStorage quota measurement';
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') { result.estimates.push({ phase, scope, state: 'unavailable' }); return; }
    try { result.estimates.push({ phase, scope, state: 'captured', value: await navigator.storage.estimate() }); }
    catch (error) { result.estimates.push({ phase, scope, state: 'error', error: fact(error) }); }
  }
  function write(storage, key, value) {
    const prior = storage.getItem(key);
    const result = { state: 'success', valueCodeUnits: value.length, valueUtf8Bytes: new TextEncoder().encode(value).length,
      keyCodeUnits: key.length, attemptedUtf16Bytes: 2 * (key.length + value.length),
      observed: count(key, prior), readbackEqual: false, error: null, priorValueUnchanged: null };
    try { storage.setItem(key, value); result.observed = count(key, storage.getItem(key)); result.readbackEqual = storage.getItem(key) === value; }
    catch (error) {
      result.state = 'error'; result.error = fact(error);
      const after = storage.getItem(key); result.observed = count(key, after); result.priorValueUnchanged = after === prior;
    }
    return result;
  }
  document.getElementById('positive-control').addEventListener('click', () => {
    state.phase = 'positive-inline-control';
    const external = document.createElement('script'); external.src = base + 'positive-control.js'; document.head.appendChild(external);
  }, { once: true });
  document.getElementById('sandbox-control').addEventListener('click', () => {
    state.phase = 'sandbox-attribute-control';
    const frame = document.createElement('iframe'); frame.id = 'sandbox-frame'; frame.title = 'Owned site-attribute warning control';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.src = base + 'frame'; document.getElementById('sandbox-host').appendChild(frame);
  }, { once: true });
  document.getElementById('storage-probe').addEventListener('click', async () => {
    state.phase = 'storage';
    const result = state.storage = { done: false, errors: [], basic: null, attempts: [], boundary: 'not-started',
      postBoundarySmall: null, largeRemovedBeforeRetry: false, largeAfterRemoval: null, cleanup: [], estimates: [] };
    const owned = new Map(); let storage;
    try {
      storage = window.localStorage;
      for (const [label, key] of [['basic', basicKey], ['large', largeKey]]) {
        if (storage.getItem(key) !== null) throw new Error('Owned probe key already exists; refusing to overwrite it');
        owned.set(label, key);
      }
      await estimate(result, 'before-owned-writes');
      const small = cacheValue('initial');
      if (small.length !== smallUnits || JSON.parse(small).diagnosticCacheVersion !== 1) throw new Error('Invalid finite cache fixture');
      result.basic = write(storage, basicKey, small);
      storage.removeItem(basicKey);
      if (storage.getItem(basicKey) !== null) throw new Error('Owned basic cache removal failed');
      result.boundary = 'finite-cap-not-reached';
      for (let units = smallUnits; units <= capUnits; units *= 2) {
        const attempt = write(storage, largeKey, 'x'.repeat(units)); result.attempts.push(attempt);
        if (attempt.state === 'error') { result.boundary = attempt.error.name === 'QuotaExceededError' ? 'quota-exceeded' : 'other-error'; break; }
        if (!attempt.readbackEqual) throw new Error('Successful owned-key write did not read back exactly');
      }
      await estimate(result, 'at-finite-boundary-before-removal');
      // Failed replacement must preserve the previous value. Remove only our
      // large key, then test a fresh cache write, not an existing business value.
      storage.removeItem(largeKey); const largeAfterRemoval = storage.getItem(largeKey);
      result.largeAfterRemoval = count(largeKey, largeAfterRemoval); result.largeRemovedBeforeRetry = largeAfterRemoval === null;
      if (!result.largeRemovedBeforeRetry || storage.getItem(basicKey) !== null) throw new Error('Owned retry keys were not absent');
      result.postBoundarySmall = write(storage, basicKey, cacheValue('after-owned-large-removal'));
    } catch (error) { result.errors.push(fact(error)); }
    finally {
      for (const [label, key] of owned) {
        try { storage.removeItem(key); const value = storage.getItem(key); result.cleanup.push({ key: label, removed: value === null, observed: count(key, value), error: null }); }
        catch (error) { result.cleanup.push({ key: label, removed: false, observed: { present: false, keyCodeUnits: 0, valueCodeUnits: 0, utf16Bytes: 0 }, error: fact(error) }); }
      }
      await estimate(result, 'after-owned-key-cleanup'); result.done = true;
      document.getElementById('storage-result').textContent = JSON.stringify({ boundary: result.boundary, smallWrite: result.basic && result.basic.state,
        sizes: result.attempts.map(item => ({ units: item.valueCodeUnits, state: item.state, error: item.error && item.error.name })),
        postBoundarySmall: result.postBoundarySmall && result.postBoundarySmall.state, cleanup: result.cleanup.map(item => ({ key: item.key, removed: item.removed })) }, null, 2);
    }
  }, { once: true });
  state.externalMain = true; document.getElementById('external-main-ready').textContent = 'External main script ran';
})();`;

type RejectedTransport = "CONNECT" | "UPGRADE";
type RejectedSocket = import("node:stream").Duplex;

/** Only sockets explicitly taken out of HTTP handling for deliberate denial.
 * Ordinary HTTP/REST errors and process-wide exception handling are untouched. */
function rejectedSocketAccounting() {
  const active = new Map<RejectedSocket, RejectedTransport>();
  const rejected = { CONNECT: 0, UPGRADE: 0 };
  const expectedErrors = { CONNECT: { ECONNRESET: 0, EPIPE: 0 }, UPGRADE: { ECONNRESET: 0, EPIPE: 0 } };
  const failures: Array<{ transport: RejectedTransport | "unregistered"; code: string }> = [];
  let failureCount = 0, peakActive = 0, overflowed = false;
  function fail(transport: RejectedTransport | "unregistered", code: string): void {
    failureCount = Math.min(failureCount + 1, 257);
    if (failures.length < 16) failures.push({ transport, code: code.slice(0, 64) });
    else overflowed = true;
  }
  function noteError(socket: RejectedSocket, error: NodeJS.ErrnoException): void {
    const transport = active.get(socket), code = typeof error.code === "string" ? error.code : "missing-error-code";
    if (transport && (code === "ECONNRESET" || code === "EPIPE")) {
      if (expectedErrors[transport][code] < 256) expectedErrors[transport][code]++;
      else { overflowed = true; fail(transport, "expected-reset-budget-exceeded"); }
    } else fail(transport || "unregistered", code);
  }
  function trackRejected(transport: RejectedTransport, socket: RejectedSocket): boolean {
    if (active.has(socket)) { fail(transport, "duplicate-rejected-socket"); socket.destroy(); return false; }
    active.set(socket, transport);
    // Attach before end/write: a peer may reset immediately after our 403.
    socket.on("error", (error: NodeJS.ErrnoException) => noteError(socket, error));
    socket.once("close", () => active.delete(socket));
    rejected[transport] = Math.min(rejected[transport] + 1, 257);
    peakActive = Math.max(peakActive, Math.min(active.size, 129));
    if (active.size > 128 || rejected.CONNECT + rejected.UPGRADE > 256) {
      overflowed = true; fail(transport, "rejected-socket-budget-exceeded"); socket.destroy(); return false;
    }
    return true;
  }
  function reject(transport: RejectedTransport, socket: RejectedSocket): void {
    if (trackRejected(transport, socket)) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }
  function snapshot() {
    return { rejected: { ...rejected }, active: active.size, peakActive,
      expectedErrors: { CONNECT: { ...expectedErrors.CONNECT }, UPGRADE: { ...expectedErrors.UPGRADE } },
      failureCount, failures: failures.map((failure) => ({ ...failure })), overflowed };
  }
  function assertHealthy(): void {
    if (failureCount || overflowed) throw Object.assign(new Error("Owned rejected-transport errors failed closed: " + JSON.stringify(snapshot())), { code: "OWNED_FIXTURE_TRANSPORT_ERROR" });
  }
  return { reject, snapshot, assertHealthy, trackRejected, noteError };
}

/** Native TCP reset, no browser and no upstream connection. Its server-side
 * ECONNRESET/EPIPE must actually reach the same scoped listener used in the run. */
async function rejectedSocketControls(port: number, accounting: ReturnType<typeof rejectedSocketAccounting>) {
  const positive: Array<{ transport: RejectedTransport; response: 403; clientReset: true; accountedErrors: number }> = [];
  for (const transport of ["CONNECT", "UPGRADE"] as const) {
    const before = accounting.snapshot().expectedErrors[transport];
    await new Promise<void>((resolve, reject) => {
      let denied = false, response = "";
      const client = net.createConnection({ host: LOOPBACK, port });
      const timer = setTimeout(() => client.destroy(new Error("Owned rejected-socket control deadline")), 5_000);
      client.once("connect", () => client.write(transport === "CONNECT"
        ? "CONNECT denied.synthetic.invalid:443 HTTP/1.1\r\nHost: denied.synthetic.invalid:443\r\n\r\n"
        : `GET /owned-upgrade-control HTTP/1.1\r\nHost: ${LOOPBACK}:${port}\r\nConnection: Upgrade\r\nUpgrade: owned-synthetic-control\r\n\r\n`));
      client.on("data", (data: Buffer) => {
        if (denied) return;
        response += data.toString("ascii");
        if (response.length > 4096) { client.destroy(new Error("Owned denial response exceeded budget")); return; }
        if (!response.includes("\r\n\r\n")) return;
        if (!response.startsWith("HTTP/1.1 403 ")) { client.destroy(new Error("Owned transport was not explicitly rejected")); return; }
        denied = true; client.resetAndDestroy();
      });
      client.on("error", reject);
      client.once("close", () => { clearTimeout(timer); if (denied) resolve(); else reject(new Error("Owned transport closed without its 403/reset control")); });
    });
    await until("denied " + transport + " native reset accounted", () => {
      const current = accounting.snapshot().expectedErrors[transport];
      return current.ECONNRESET + current.EPIPE > before.ECONNRESET + before.EPIPE;
    }, 5_000);
    const current = accounting.snapshot().expectedErrors[transport];
    positive.push({ transport, response: 403, clientReset: true, accountedErrors: current.ECONNRESET + current.EPIPE - before.ECONNRESET - before.EPIPE });
  }
  accounting.assertHealthy();
  const negative: Array<{ transport: RejectedTransport | "unregistered"; code: string; failedClosed: true }> = [];
  // Separate instances: intentional negative controls must not poison or waive
  // the real fixture's error latch. Exercise the actual scoped error listener.
  for (const transport of ["CONNECT", "UPGRADE", "unregistered"] as const) {
    const probe = rejectedSocketAccounting(), socket = new net.Socket();
    if (transport === "unregistered") probe.noteError(socket, Object.assign(new Error("Synthetic unregistered reset"), { code: "ECONNRESET" }));
    else {
      probe.trackRejected(transport, socket);
      socket.emit("error", Object.assign(new Error("Synthetic unexpected denied-socket error"), { code: "EIO" }));
    }
    let failedClosed = false;
    try { probe.assertHealthy(); }
    catch (error) { failedClosed = (error as NodeJS.ErrnoException).code === "OWNED_FIXTURE_TRANSPORT_ERROR"; }
    const state = probe.snapshot();
    socket.destroy();
    if (!failedClosed || state.failureCount !== 1 || Object.values(state.expectedErrors).some((counts) => counts.ECONNRESET || counts.EPIPE)) {
      throw new Error("Unexpected/unregistered socket error negative control did not fail closed");
    }
    negative.push({ transport, code: transport === "unregistered" ? "ECONNRESET" : "EIO", failedClosed: true });
  }
  return { positive, negative, scope: "owned native TCP resets plus isolated synthetic unexpected-error latches; no browser execution" };
}

async function localFixture() {
  const prefix = `/owned-${randomUUID()}/`;
  let origin = "", journalBytes = 0, dropped = 0;
  const journal: Array<{ method: string; target: string; disposition: string }> = [];
  const sockets = new Set<import("node:net").Socket>();
  const transport = rejectedSocketAccounting();
  let socketControls: { state: "not-started" | "running" | "passed" | "failed"; result?: Awaited<ReturnType<typeof rejectedSocketControls>>; error?: ErrorFact } = { state: "not-started" };
  const record = (method: string, target: string, disposition: string) => {
    const row = { method, target, disposition }, size = Buffer.byteLength(JSON.stringify(row));
    if (journal.length >= 256 || journalBytes + size > 64 * 1024) { dropped++; return; }
    journalBytes += size; journal.push(row);
  };
  const scripts: Record<string, string> = { "bootstrap.js": BOOTSTRAP_JS, "main.js": MAIN_JS, "frame.js": FRAME_JS, "positive-control.js": POSITIVE_JS };
  const server = http.createServer((req, res) => {
    let url: URL;
    try { url = new URL(req.url || "/", origin); }
    catch { record(req.method || "", "invalid-target", "rejected"); res.writeHead(400).end(); return; }
    // This is also the product's ordinary HTTP proxy. Never forward upstream,
    // including background traffic; no proxy bypass or DNS/security switch.
    if (url.origin !== origin || url.username || url.password) {
      record(req.method || "", "nonfixture-origin", "proxy-rejected"); res.writeHead(403).end(); return;
    }
    if (!["GET", "HEAD"].includes(req.method || "") || req.headers.cookie || req.headers.authorization || req.headers["proxy-authorization"] || req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0)) {
      record(req.method || "", "owned-disallowed-request", "rejected"); res.writeHead(400).end(); return;
    }
    const relative = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    let body: string, type: string;
    if (relative === "main") {
      type = "text/html; charset=utf-8";
      body = `<!doctype html><html><head><meta charset="utf-8"><title>Owned Chromium CSP / storage diagnostic</title><script src="${prefix}bootstrap.js"></script></head><body><h1>Owned Chromium CSP / storage diagnostic</h1><p id="external-main-ready">Waiting for external main script</p><iframe id="baseline-frame" title="External-script baseline" src="${prefix}frame"></iframe><p><button id="positive-control">Known blocked inline control</button> <button id="storage-probe">Finite owned-key storage probe</button> <button id="sandbox-control">Owned sandbox attribute control</button></p><pre id="storage-result"></pre><div id="sandbox-host"></div><script src="${prefix}main.js"></script></body></html>`;
    } else if (relative === "frame") {
      type = "text/html; charset=utf-8";
      body = `<!doctype html><html><head><meta charset="utf-8"><title>Owned external-script frame</title><script src="${prefix}bootstrap.js"></script></head><body><p id="external-frame-ready">Waiting for external frame script</p><script src="${prefix}frame.js"></script></body></html>`;
    } else if (Object.hasOwn(scripts, relative)) { type = "text/javascript; charset=utf-8"; body = scripts[relative]; }
    else if (url.pathname === "/favicon.ico") { record(req.method!, "/favicon.ico", "empty-favicon"); res.writeHead(204).end(); return; }
    else { record(req.method || "", "unknown-owned-path", "rejected"); res.writeHead(404).end(); return; }
    record(req.method!, url.pathname, "served");
    res.writeHead(200, { "content-type": type, "content-security-policy": CSP, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (_req, socket) => { record("CONNECT", "nonfixture-tunnel", "proxy-rejected"); transport.reject("CONNECT", socket); });
  server.on("upgrade", (_req, socket) => { record("UPGRADE", "unsupported-owned-transport", "rejected"); transport.reject("UPGRADE", socket); });
  server.requestTimeout = 5_000; server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, LOOPBACK, () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Owned fixture did not expose a dynamic port");
  const port = address.port; origin = `http://${LOOPBACK}:${port}`;
  return { origin, port, prefix, mainUrl: origin + prefix + "main", positiveUrl: origin + prefix + "positive-control.js", journal,
    dropped: () => dropped, scriptHashes: Object.fromEntries(Object.entries(scripts).map(([name, text]) => [name, sha(text)])),
    transportEvidence: () => ({ accounting: transport.snapshot(), controls: { ...socketControls } }),
    assertTransportHealthy: transport.assertHealthy,
    async verifyRejectedSocketControls() {
      if (socketControls.state !== "not-started") throw new Error("Rejected-socket controls must run exactly once");
      socketControls = { state: "running" };
      try { socketControls = { state: "passed", result: await rejectedSocketControls(port, transport) }; }
      catch (error) { socketControls = { state: "failed", error: errorFact(error) }; throw error; }
    },
    async close() {
      // HTTP server close alone does not await CONNECT/UPGRADE socket close.
      // Drain those owned sockets before taking the final error-latch receipt.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Owned fixture socket-close deadline")), 5_000);
        const closedSockets = [...sockets].map((socket) => new Promise<void>((done) => socket.once("close", () => done())));
        const closedServer = new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        Promise.all([closedServer, ...closedSockets]).then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
      });
      transport.assertHealthy();
      if (transport.snapshot().active !== 0 || sockets.size !== 0) throw new Error("Owned fixture sockets did not fully close");
    } };
}

async function documentFacts(page: Page): Promise<DocumentFact[]> {
  const result: DocumentFact[] = [];
  for (const frame of page.frames()) {
    result.push(await frame.evaluate(() => (window as unknown as { __absDiagnostic: DocumentFact }).__absDiagnostic));
  }
  expect(result.every((document) => document?.schema === "owned-csp-storage-document/v1")).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
  return result;
}
function validateStorage(storage: StorageFact): void {
  expect(storage.done).toBe(true); expect(storage.errors).toEqual([]);
  for (const small of [storage.basic, storage.postBoundarySmall]) {
    expect(small).toMatchObject({ state: "success", valueCodeUnits: SMALL_UNITS, valueUtf8Bytes: SMALL_UNITS, readbackEqual: true, error: null });
  }
  expect(storage.attempts).toHaveLength(8);
  expect(storage.attempts.at(-1)).toMatchObject({ valueCodeUnits: LARGE_CAP_UNITS, state: "error", error: { name: "QuotaExceededError" }, priorValueUnchanged: true });
  for (const [index, attempt] of storage.attempts.entries()) {
    expect(attempt.valueCodeUnits).toBe(SMALL_UNITS * 2 ** index);
    expect(attempt.valueCodeUnits).toBeLessThanOrEqual(LARGE_CAP_UNITS);
    expect(attempt.valueUtf8Bytes).toBe(attempt.valueCodeUnits);
    expect(attempt.attemptedUtf16Bytes).toBe(2 * (attempt.keyCodeUnits + attempt.valueCodeUnits));
    expect(attempt.observed.utf16Bytes).toBe(2 * (attempt.observed.keyCodeUnits + attempt.observed.valueCodeUnits));
    if (attempt.state === "success") expect(attempt.readbackEqual).toBe(true);
    else {
      expect(attempt.error?.name).toBe("QuotaExceededError"); expect(attempt.priorValueUnchanged).toBe(true);
      expect(index).toBe(storage.attempts.length - 1); expect(storage.boundary).toBe("quota-exceeded");
    }
  }
  expect(["quota-exceeded", "finite-cap-not-reached"]).toContain(storage.boundary);
  expect(storage.largeRemovedBeforeRetry).toBe(true);
  expect(storage.largeAfterRemoval).toEqual({ present: false, keyCodeUnits: 0, valueCodeUnits: 0, utf16Bytes: 0 });
  expect(storage.cleanup).toHaveLength(2);
  for (const cleanup of storage.cleanup) expect(cleanup).toMatchObject({ removed: true, error: null, observed: { present: false, keyCodeUnits: 0, valueCodeUnits: 0, utf16Bytes: 0 } });
  expect(storage.estimates.map((estimate) => estimate.phase)).toEqual(["before-owned-writes", "at-finite-boundary-before-removal", "after-owned-key-cleanup"]);
}

interface Receipt {
  schema: string; status: "running" | "passed" | "failed"; phase: string; startedAt: string; finishedAt?: string;
  executable: { path: string; sha256: string; frameworkSha256: string }; compiled: Record<string, string>;
  runs: RunFact[]; resources: unknown[]; cleanup: unknown[]; fixture?: unknown; comparison?: unknown; error?: ErrorFact; limitations: readonly string[];
}

describe.skipIf(!OPTED_IN)("owned headless Chromium CSP and finite localStorage diagnostic", () => {
  it("compares the same selected executable in off/managed mode without weakening CSP, sandbox, or storage policy", async () => {
    expect(process.platform).toBe("darwin"); // Exact native argv witness is macOS-only.
    expect(process.env.ABS_SYNC_ACCEPTANCE_DIST_READY).toBe("1");
    expect(process.env.AGENT_BROWSER_E2E_UNSANDBOXED).not.toBe("1");
    const aggregate = canonicalDirectory(process.env.ABS_CHROMIUM_CSP_STORAGE_BUDGET_ROOT);
    const root = canonicalDirectory(process.env.ABS_CHROMIUM_CSP_STORAGE_ACCEPTANCE_ROOT);
    within(aggregate, root);
    if (fs.readdirSync(root).length) throw new Error("Diagnostic root must be fresh and empty; never reset/reuse an existing profile");
    if (fs.lstatSync(root).dev !== fs.lstatSync(aggregate).dev) throw new Error("Owned root and aggregate must be on the same volume");
    if (aggregate.startsWith("/Volumes/")) execFileSync("python3", ["/Users/ahoo/.local/share/agent-storage/move_verified_storage.py", "check-mount"], { stdio: "pipe", timeout: 15_000 });
    const initialResources = resourceSnapshot(aggregate, 128 * 1024 ** 2);
    const binaryInput = process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH;
    if (!binaryInput || !path.isAbsolute(binaryInput)) throw new Error("An explicit existing managed executable is required; no discovery/download fallback");
    const binary = fs.realpathSync(binaryInput);
    if (!fs.statSync(binary).isFile()) throw new Error("Selected executable is not a regular file");
    const framework = path.resolve(path.dirname(binary), "../Frameworks/Chromium Framework.framework/Versions/Current/Chromium Framework");
    const binarySha = await fileHash(binary), frameworkSha = await fileHash(framework);
    const compiled = Object.fromEntries(["main/index.js", "main/services/browser-manager.js", "main/services/browser/launch-provenance.js"].map((relative) =>
      [relative, sha(ownedBytes(path.join(REPO, "dist"), path.join(REPO, "dist", relative)))]));
    const owned = fs.mkdtempSync(path.join(root, "csp-storage-")), ownedStat = fs.lstatSync(owned);
    const receipt: Receipt = { schema: "owned-headless-chromium-csp-storage/v1", status: "running", phase: "startup", startedAt: new Date().toISOString(),
      executable: { path: binary, sha256: binarySha, frameworkSha256: frameworkSha }, compiled, runs: [], resources: [initialResources], cleanup: [], limitations: [
        "Fresh synthetic local origin and finite same-session probes only; not a real Statsig SDK, user login page, full quota measurement, or successful-write/close persistence proof.",
        "Native LocalStorage immediate-shutdown durability remains BLOCKED and is not fixed or reverified by this lane.",
        "This receipt covers in-test assertions and owned cleanup only; acceptance also requires zero exits from Vitest and its outer runner, with no unhandled errors.",
        "CSP unsafe-eval and unsafe-inline are different capabilities; neither is enabled. The deliberate inline-script rejection is a separately identified positive control.",
        "The sandbox warning is an owned site-attribute control using allow-scripts plus allow-same-origin; no sandbox escape is attempted or attested.",
        "StorageManager.estimate is recorded separately and is not interpreted as localStorage capacity. No business storage values or process environment are retained.",
        "Source-guided expectation, not preclaimed binary behavior: the bounded 8Mi-code-unit attempt (16MiB accounted UTF-16 value bytes, 8MiB ASCII) must reach the normal renderer quota boundary. Atomic QuotaExceededError plus a successful fresh 64KiB retry is expected, not a product defect. The managed storageQuota setting is not changed or interpreted as localStorage capacity.",
        ...NATIVE_ARGV_LIMITATIONS,
      ] };
    let fixture: Awaited<ReturnType<typeof localFixture>> | undefined, controller: HeadlessAppHandle | undefined, native: NativeOwner | undefined;
    let controllerLaunchPending = false, nativeLaunchPending = false;
    let phase: Phase = "baseline";
    async function proof(target: NativeOwner, run: RunFact, label: string): Promise<void> {
      try {
        const profileDir = fs.realpathSync(path.join(target.handle.userDataDir, "profiles", target.id));
        const observed = readOwnedNativeArgv({ pid: target.pid, executablePath: binary, argv0: binary, profileDir, port: target.port });
        expect(observed.args).toContain("--headless=new");
        const prohibited = /^--(?:no-sandbox|disable-(?:gpu-sandbox|web-security|site-isolation-trials|features)|allow-running-insecure-content|unsafely-treat-insecure-origin-as-secure|ignore-certificate-errors|js-flags)(?:=|$)/;
        // Product-owned disable-features policy is bound by provenance, not
        // silently rewritten here. Reject only security-relaxing feature values.
        const bad = observed.args.filter((arg) => prohibited.test(arg) && (!arg.startsWith("--disable-features=") || /(?:CSP|ContentSecurity|Sandbox|IsolateOrigins|site-per-process)/i.test(arg)));
        expect(bad, "No CSP/sandbox/security workarounds are authorized").toEqual([]);
        const saved = object(JSON.parse(ownedBytes(target.handle.userDataDir, path.join(target.handle.userDataDir, "config.json")).toString()), "owned config");
        const profiles = object(saved.browserProfiles, "owned profiles"), meta = object(profiles[target.id], "owned profile") as unknown as BrowserProfileMeta;
        expect(meta).toMatchObject({ engine: "chromium", fingerprintMode: target.mode, fingerprintSeed: 730149, proxyMode: "named", proxyName: "csp-storage-local-only" });
        const requestHash = chromiumLaunchRequestHash(meta, saved as Parameters<typeof chromiumLaunchRequestHash>[1], { headless: true, binaryOverride: binary, gpuContext: readChromiumGpuContext(binary) });
        const provenance = assertChromiumReuseEvidence(observed, { profileDir, executablePath: binary, requestHash, mode: target.mode, pid: target.pid, port: target.port });
        let version: string | null = null;
        if (target.browser) {
          const session = await target.browser.newBrowserCDPSession();
          try {
            const browserProcesses = (await session.send("SystemInfo.getProcessInfo")).processInfo.filter((entry) => entry.type === "browser");
            if (browserProcesses.length !== 1 || browserProcesses[0].id !== target.pid) throw new Error("CDP browser PID contradicts the exact product-owned native process");
            version = (await session.send("Browser.getVersion")).product;
          } finally { await session.detach(); }
          expect(version).toMatch(/\d+\.\d+\.\d+\.\d+/);
          if (run.cdpVersion) expect(version).toBe(run.cdpVersion);
          run.cdpVersion = version!;
        }
        expect(await fileHash(binary)).toBe(binarySha); expect(await fileHash(framework)).toBe(frameworkSha);
        run.proofs.push({ label, pid: target.pid, port: target.port, profileDir, mode: target.mode, ownershipWitness: observed.ownershipWitness, provenance, cdpVersion: version });
      } catch (error) { target.unsafeToStop = true; throw error; }
    }
    async function screenshot(target: NativeOwner, run: RunFact): Promise<void> {
      if (run.screenshot || !target.page || target.unsafeToStop || !fixture || !target.page.url().startsWith(fixture.origin + fixture.prefix)) return;
      await proof(target, run, "before-owned-screenshot");
      const png = await target.page.screenshot({ fullPage: false, animations: "disabled" }); expect(png.length).toBeLessThan(JSON_CAP);
      receipt.resources.push(resourceSnapshot(aggregate, png.length + JSON_CAP));
      const file = path.join(owned, `${target.mode}-headless-csp-storage.png`); fs.writeFileSync(file, png, { flag: "wx", mode: 0o600 });
      expect(sha(ownedBytes(owned, file, JSON_CAP))).toBe(sha(png));
      run.screenshot = { path: file, bytes: png.length, sha256: sha(png), visualReview: "pending" };
    }
    async function stopNative(): Promise<void> {
      if (!native) return;
      const target = native, run = receipt.runs.find((item) => item.profileId === target.id)!;
      if (target.unsafeToStop) throw new Error("Native/CDP ownership is unverified; no product stop or implicit controller shutdown is authorized");
      await proof(target, run, "before-normal-product-stop");
      expect((await api(target.handle, "POST", `/api/profiles/${target.id}/stop`, {})).success).toBe(true);
      await until("native PID exited", () => gone(target.pid));
      if (target.browser) await until("owned CDP disconnected", () => !target.browser!.isConnected());
      await until("owned CDP endpoint closed", async () => {
        try { await request(target.port, null, "GET", "/json/version"); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") return true; throw error; }
      }, 5_000);
      expect((await api(target.handle, "GET", `/api/profiles/${target.id}/status`)).running).toBe(false);
      receipt.cleanup.push({ kind: "native-browser", mode: target.mode, pid: target.pid, normalProductStop: true, exited: true, endpointClosed: true }); native = undefined;
    }
    try {
      fixture = await localFixture();
      receipt.fixture = { origin: fixture.origin, prefix: fixture.prefix, csp: CSP, scriptHashes: fixture.scriptHashes, proxy: "reject nonfixture HTTP and all CONNECT; no upstream forwarding" };
      await fixture.verifyRejectedSocketControls();
      const userDataDir = path.join(owned, "controller-userdata");
      // launchHeadlessApp resets its path: only pass a never-existing owned child.
      if (fs.existsSync(userDataDir)) throw new Error("Controller userData already exists");
      controllerLaunchPending = true;
      controller = await launchHeadlessApp({ userDataDir, token: "synthetic-csp-storage-rest-token", env: {
        AGENT_BROWSER_CHROMIUM_BINARY_PATH: binary, AGENT_BROWSER_API_PORT: "0", AGENT_BROWSER_MCP_PORT: "0", AGENT_BROWSER_MCP_TOKEN: "synthetic-csp-storage-mcp-token",
      } });
      controllerLaunchPending = false;
      const isolation = await controller.app.evaluate(({ app, BrowserWindow }) => ({ headless: process.argv.includes("--headless"), windows: BrowserWindow.getAllWindows().length,
        platform: process.platform, architecture: process.arch, userData: app.getPath("userData"), home: process.getBuiltinModule("os").homedir(),
        noSandbox: app.commandLine.hasSwitch("no-sandbox"), hasProviderEnvironment: Object.keys(process.env).some((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)) }));
      expect(isolation).toMatchObject({ headless: true, windows: 0, platform: process.platform, architecture: process.arch, noSandbox: false, hasProviderEnvironment: false });
      expect(fs.realpathSync(isolation.userData)).toBe(fs.realpathSync(userDataDir));
      expect(fs.realpathSync(isolation.home)).toBe(fs.realpathSync(path.join(userDataDir, "test-home")));
      receipt.cleanup.push({ kind: "controller-isolation", ...isolation });
      expect((await request(controller.port, null, "GET", "/health")).status).toBe(200);
      await api(controller, "POST", "/api/proxies", { name: "csp-storage-local-only", config: { type: "http", host: LOOPBACK, port: fixture.port } });
      for (const mode of ["off", "managed"] as const) {
        receipt.phase = `${mode}: fresh product profile`; phase = "baseline";
        receipt.resources.push(resourceSnapshot(aggregate, 128 * 1024 ** 2));
        const created = await api(controller, "POST", "/api/profiles", { name: `Owned CSP/storage ${mode}`, engine: "chromium", fingerprintMode: mode,
          platform: "macos", fingerprintSeed: 730149, appUrl: null, proxyMode: "named", proxyName: "csp-storage-local-only" });
        const id = created.dirId; if (typeof id !== "string" || !/^ab_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Product did not allocate an owned profile ID");
        expect((await request(controller.port, null, "GET", `/api/profiles/${id}/status`)).status).toBe(401);
        expect((await request(controller.port, "synthetic-wrong-token", "GET", `/api/profiles/${id}/status`)).status).toBe(401);
        expect((await api(controller, "GET", `/api/profiles/${id}/status`)).running).toBe(false);
        const run: RunFact = { mode, profileId: id, proofs: [], events: [], droppedEvents: 0, blockedPageRequests: [] }; receipt.runs.push(run);
        nativeLaunchPending = true; // A failed HTTP response is not proof no process launched.
        const launched = await api(controller, "POST", `/api/profiles/${id}/launch`, { headless: true });
        if (typeof launched.pid !== "number" || !Number.isInteger(launched.pid) || launched.pid < 1 || typeof launched.cdpPort !== "number" || !Number.isInteger(launched.cdpPort) || launched.cdpPort < 1 || launched.cdpPort > 65535) throw new Error("Product launch lacks exact native PID/port; cleanup ownership is unverified");
        native = { handle: controller, id, mode, pid: launched.pid, port: launched.cdpPort, unsafeToStop: true };
        nativeLaunchPending = false;
        expect(launched.success).toBe(true);
        await proof(native, run, "native-before-CDP-attach");
        native.browser = await chromium.connectOverCDP(`http://${LOOPBACK}:${native.port}`, { timeout: 20_000 });
        await proof(native, run, "PID-CDP-before-page-actions");
        native.unsafeToStop = false; // Both independent witnesses now authorize actions.
        const browser = native.browser, context = browser.contexts()[0]; if (!context) throw new Error("Owned production browser has no context");
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.origin === fixture!.origin || ["chrome:", "about:", "data:", "blob:"].includes(url.protocol)) return route.continue();
          if (run.blockedPageRequests.length >= 64) run.droppedEvents++;
          else run.blockedPageRequests.push({ phase, protocol: url.protocol });
          return route.abort("blockedbyclient");
        });
        const page = context.pages().find((candidate) => !candidate.url().startsWith("chrome-extension:")) || await context.newPage(); native.page = page;
        let eventBytes = 0;
        const event = (kind: string, value: unknown) => {
          const row: EventFact = { phase, kind, value: JSON.parse(JSON.stringify(value)) }, size = Buffer.byteLength(JSON.stringify(row));
          if (run.events.length >= 256 || eventBytes + size > EVENT_CAP) { run.droppedEvents++; return; }
          eventBytes += size; run.events.push(row);
        };
        page.on("console", (message) => event("console", { type: message.type(), text: message.text(), location: message.location() }));
        page.on("pageerror", (error) => event("page-error", errorFact(error)));
        const logs = await context.newCDPSession(page);
        logs.on("Log.entryAdded", ({ entry }) => event("cdp-log", entry));
        logs.on("Audits.issueAdded", ({ issue }) => { if (issue.code === "ContentSecurityPolicyIssue") event("csp-audit", issue); });
        await logs.send("Log.enable"); await logs.send("Audits.enable");
        receipt.phase = `${mode}: external-script baseline`;
        const response = await page.goto(fixture.mainUrl, { waitUntil: "load", timeout: 20_000 });
        expect(response?.status()).toBe(200); expect(response?.headers()["content-security-policy"]).toBe(CSP);
        await page.getByText("External main script ran", { exact: true }).waitFor();
        await page.frameLocator("#baseline-frame").getByText("External frame script ran", { exact: true }).waitFor();
        await page.waitForTimeout(250); // Drain asynchronous CSP/console observations, not a clock/policy override.
        run.baseline = await documentFacts(page); expect(run.baseline).toHaveLength(2);
        expect(run.baseline[0].externalMain).toBe(true); expect(run.baseline[1].externalFrame).toBe(true);
        for (const document of run.baseline) { expect(document.externalBootstrap).toBe(true); expect(document.csp).toEqual([]); expect(document.errors).toEqual([]); expect(document.dropped).toBe(0); }
        expect(run.events.filter((entry) => entry.kind === "csp-audit" || entry.kind === "page-error" || /(?:Content Security Policy|Content-Security-Policy|Refused to execute inline)/i.test(JSON.stringify(entry.value)))).toEqual([]);
        phase = "positive-inline-control"; receipt.phase = `${mode}: deliberate blocked inline control`;
        await page.locator("#positive-control").click();
        await page.waitForFunction(() => (window as unknown as { __absDiagnostic: DocumentFact }).__absDiagnostic.csp.length > 0);
        await page.waitForTimeout(250);
        const positive = (await documentFacts(page))[0];
        expect(positive.positive).toEqual({ externalScriptRan: true, appended: true });
        expect(await page.evaluate(() => (window as unknown as { __absCspInlinePositiveControlExecuted: boolean }).__absCspInlinePositiveControlExecuted)).toBe(false);
        expect(positive.csp).toHaveLength(1);
        expect(positive.csp[0]).toMatchObject({ phase: "positive-inline-control", blockedURI: "inline", sourceFile: fixture.positiveUrl, disposition: "enforce", originalPolicy: CSP });
        expect(positive.csp[0].effectiveDirective).toMatch(/^script-src(?:-elem)?$/);
        run.positiveInlineControl = { blocked: true, violation: positive.csp[0], source: INLINE_CONTROL };
        phase = "storage"; receipt.phase = `${mode}: finite same-session owned-key probe`;
        await proof(native, run, "before-storage-actions");
        await page.locator("#storage-probe").click();
        await page.waitForFunction(() => (window as unknown as { __absDiagnostic: DocumentFact }).__absDiagnostic.storage?.done === true, undefined, { timeout: 30_000 });
        const storage = (await documentFacts(page))[0].storage; if (!storage) throw new Error("External storage probe did not return evidence");
        run.storage = storage; validateStorage(storage);
        phase = "sandbox-attribute-control"; receipt.phase = `${mode}: harmless site sandbox attribute`;
        await page.locator("#sandbox-control").click();
        await page.frameLocator("#sandbox-frame").getByText("External frame script ran", { exact: true }).waitFor();
        await page.waitForTimeout(250);
        run.sandbox = { attribute: await page.locator("#sandbox-frame").getAttribute("sandbox"), escapeAttempted: false,
          warningObserved: run.events.some((entry) => entry.phase === "sandbox-attribute-control" && /allow-scripts.*allow-same-origin.*(?:sandbox|escape)/i.test(JSON.stringify(entry.value))) };
        expect(run.sandbox.attribute).toBe("allow-scripts allow-same-origin");
        run.documents = await documentFacts(page); expect(run.documents).toHaveLength(3);
        const allViolations = run.documents.flatMap((document) => document.csp);
        expect(allViolations).toEqual([run.positiveInlineControl.violation]);
        for (const document of run.documents) { expect(document.errors).toEqual([]); expect(document.dropped).toBe(0); }
        expect(run.events.filter((entry) => entry.kind === "page-error")).toEqual([]);
        // An inline CSP console/audit companion must belong to the one known
        // control. Never allow arbitrary positive-phase violations or eval errors.
        const cspLogs = run.events.filter((entry) => /(?:Content Security Policy|Content-Security-Policy|Refused to execute inline)/i.test(JSON.stringify(entry.value)) || entry.kind === "csp-audit");
        for (const entry of cspLogs) {
          expect(entry.phase).toBe("positive-inline-control");
          expect(JSON.stringify(entry.value)).toContain(fixture.positiveUrl);
          if (entry.kind === "console" || entry.kind === "cdp-log") expect(JSON.stringify(entry.value)).toMatch(/inline/i);
        }
        for (const kind of ["console", "cdp-log", "csp-audit"]) expect(cspLogs.filter((entry) => entry.kind === kind).length).toBeLessThanOrEqual(1);
        expect(run.droppedEvents).toBe(0); expect(run.blockedPageRequests).toEqual([]); expect(fixture.dropped()).toBe(0);
        fixture.assertTransportHealthy();
        await proof(native, run, "after-owned-page-actions");
        await screenshot(native, run);
        await logs.detach(); await stopNative();
      }
      receipt.phase = "same-binary finite comparison";
      const [off, managed] = receipt.runs; expect(off.mode).toBe("off"); expect(managed.mode).toBe("managed");
      expect(managed.cdpVersion).toBe(off.cdpVersion);
      const finiteSignature = (run: RunFact) => ({ basic: run.storage!.basic!.state,
        attempts: run.storage!.attempts.map((attempt) => ({ codeUnits: attempt.valueCodeUnits, state: attempt.state, errorName: attempt.error?.name || null, priorValueUnchanged: attempt.priorValueUnchanged })),
        boundary: run.storage!.boundary, smallAfterLargeRemoval: run.storage!.postBoundarySmall!.state });
      receipt.comparison = { scope: "same-session finite localStorage writes only; estimate is excluded", off: finiteSignature(off), managed: finiteSignature(managed),
        sameExecutable: true, sameVersion: true, nativeShutdownDurability: "blocked-not-tested" };
      expect(finiteSignature(managed), "Managed must not lose small writes or materially change this exact finite localStorage boundary").toEqual(finiteSignature(off));
      fixture.assertTransportHealthy();
      expect(fixture.transportEvidence().controls.state).toBe("passed");
      receipt.status = "passed"; receipt.phase = "complete";
    } catch (error) { receipt.status = "failed"; receipt.error = errorFact(error); throw error; }
    finally {
      // Retain a bounded failure screenshot/available document observations too;
      // do not turn a timed-out baseline into an evidence-free diagnostic.
      if (native?.page && !native.unsafeToStop && fixture && native.page.url().startsWith(fixture.origin + fixture.prefix)) {
        const run = receipt.runs.find((item) => item.profileId === native!.id)!;
        try {
          await proof(native, run, "before-final-observation");
          run.partialDocuments = [];
          for (const frame of native.page.frames()) run.partialDocuments.push(await frame.evaluate(() => (window as unknown as { __absDiagnostic?: DocumentFact }).__absDiagnostic || null));
          await screenshot(native, run);
        } catch (error) { run.failureObservationError = errorFact(error); receipt.status = "failed"; }
      }
      try { await stopNative(); }
      catch (error) { receipt.cleanup.push({ kind: "native-browser", state: "cleanup-unverified", error: errorFact(error) }); receipt.status = "failed"; }
      if (controller) {
        const child = controller.app.process(), pid = child.pid;
        if (native || nativeLaunchPending) {
          receipt.cleanup.push({ kind: "controller", pid: pid || null, state: "retained", reason: "Native launch/CDP cleanup is unverified; do not implicitly stop a possibly foreign endpoint" }); receipt.status = "failed";
        } else {
          try {
            await controller.app.close(); if (!pid) throw new Error("Owned controller PID was unavailable");
            await until("owned controller exited normally", () => gone(pid) && (child.exitCode !== null || child.signalCode !== null));
            expect(child.exitCode).toBe(0); expect(child.signalCode).toBe(null);
            receipt.cleanup.push({ kind: "controller", pid, state: "exited", normalClose: true, exitCode: child.exitCode, signal: child.signalCode });
          } catch (error) { receipt.cleanup.push({ kind: "controller", pid: pid || null, state: "cleanup-unverified", error: errorFact(error) }); receipt.status = "failed"; }
        }
      } else if (controllerLaunchPending) {
        receipt.cleanup.push({ kind: "controller", state: "startup-helper-returned-no-handle", cleanup: "unverified" }); receipt.status = "failed";
      }
      if (fixture) {
        try { await fixture.close(); receipt.cleanup.push({ kind: "local-http-proxy-fixture", state: "closed" }); }
        catch (error) { receipt.cleanup.push({ kind: "local-http-proxy-fixture", state: "cleanup-unverified", error: errorFact(error) }); receipt.status = "failed"; }
        // Snapshot after all owned sockets close, so late teardown errors cannot
        // leave a clean-looking pre-close transport receipt.
        receipt.fixture = { ...object(receipt.fixture, "fixture receipt"), journal: fixture.journal, dropped: fixture.dropped(), transport: fixture.transportEvidence() };
      }
      receipt.finishedAt = new Date().toISOString();
      const actualOwner = fs.lstatSync(owned);
      if (actualOwner.isSymbolicLink() || actualOwner.dev !== ownedStat.dev || actualOwner.ino !== ownedStat.ino) throw new Error("Evidence directory ownership changed");
      receipt.resources.push(resourceSnapshot(aggregate, JSON_CAP));
      const serialized = JSON.stringify(receipt, null, 2); expect(Buffer.byteLength(serialized)).toBeLessThan(JSON_CAP);
      const file = path.join(owned, "receipt.json"); fs.writeFileSync(file, serialized, { flag: "wx", mode: 0o600 });
      expect(JSON.parse(ownedBytes(owned, file, JSON_CAP).toString())).toEqual(JSON.parse(serialized));
      if (!receipt.error) expect(receipt.status, JSON.stringify(receipt.cleanup)).toBe("passed");
    }
  }, 240_000);
});
