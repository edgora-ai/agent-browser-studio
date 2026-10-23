/// <reference lib="dom" />

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import type { Frame, Page } from "playwright";
import type {
  FullHostIdentityCorpus, FullHostIdentityRequestHeaders, FullHostNavigatorIdentity, IdentityContext,
  IdentityNavigatorCapture, IdentityNegotiation, IdentityRequestEvidence, IdentityRunBinding,
} from "./host-identity-validation.js";

export const IDENTITY_CAPTURE_WARNINGS = [
  "The caller must independently verify the production-launched Page's PID, executable/hash and owned profile before capture; supplied binding is not process verification.",
  "Collection is not identity acceptance. Validate all six contexts, negotiation and same-run native-control evidence; absent worker hints are never filled from navigator.",
] as const;
export const HOST_IDENTITY_HINTS = [
  ["Sec-CH-UA", "ch-ua"], ["Sec-CH-UA-Mobile", "ch-ua-mobile"], ["Sec-CH-UA-Platform", "ch-ua-platform"],
  ["Sec-CH-UA-Arch", "ch-ua-arch"], ["Sec-CH-UA-Bitness", "ch-ua-bitness"], ["Sec-CH-UA-Platform-Version", "ch-ua-platform-version"],
  ["Sec-CH-UA-Full-Version-List", "ch-ua-full-version-list"], ["Sec-CH-UA-Full-Version", "ch-ua-full-version"],
  ["Sec-CH-UA-Model", "ch-ua-model"], ["Sec-CH-UA-WoW64", "ch-ua-wow64"], ["Sec-CH-UA-Form-Factors", "ch-ua-form-factors"],
] as const;
const CONTEXTS: readonly IdentityContext[] = ["window", "dedicated", "shared", "service", "same-origin-frame", "cross-origin-frame"];
type WorkerContext = "dedicated" | "shared" | "service";
export interface IdentityPolicyObservation {
  origin: string; secureContext: boolean; api: string; allowedHints: string[]; crossOriginAllowedHints: string[];
}
export interface IdentityHttpObservation { url: string; status: number; headers: Record<string, string> }
export interface IdentityWireReceipt {
  context: IdentityContext; phase: "opt-in" | "echo"; sequence: number; requestUrl: string;
  headers: Record<string, string>; rawHeaders: string[]; responseStatus: number; responseHeaders: Record<string, string>;
}
export interface IdentitySurfaceOptions {
  context: IdentityContext; origin: string; topLevelOrigin: string; crossOrigin: string; prefix: string; timeoutMs: number;
  hints: readonly (readonly [string, string])[]; parentObservation?: IdentityPolicyObservation;
}
export interface IdentitySurfaceCapture {
  context: IdentityContext; observation: IdentityPolicyObservation; navigator: IdentityNavigatorCapture;
  request: IdentityRequestEvidence; optIn?: IdentityHttpObservation; echo?: IdentityHttpObservation;
  echoed?: { requestUrl: string; headers: Record<string, string>; rawHeaders: string[] };
}
export interface HostIdentityFixtureCapture {
  readonly prefix: string;
  receipts(): readonly IdentityWireReceipt[]; assertHealthy(): void; release(): void;
}
export interface HostIdentityFixture {
  readonly origin: string; readonly crossOrigin: string;
  /** Serial, bounded captures share origins but never a worker scope, path, name or receipt history. */
  beginCapture(): HostIdentityFixtureCapture;
  /** Only the fixture creator/runner closes its servers, in its own outer finally. */
  close(): Promise<void>;
}
export interface FullHostIdentityCapture extends FullHostIdentityCorpus {
  captureEvidence: {
    warnings: typeof IDENTITY_CAPTURE_WARNINGS; timeoutMs: number;
    contexts: Partial<Record<IdentityContext, IdentitySurfaceCapture>>; wire: readonly IdentityWireReceipt[]; cleanupErrors: string[];
  };
}
export type PartialHostIdentityCapture = Pick<FullHostIdentityCapture, "captureEvidence"> & {
  binding: IdentityRunBinding; navigators: Partial<Record<IdentityContext, IdentityNavigatorCapture>>;
  requestEvidence: Partial<Record<IdentityContext, IdentityRequestEvidence>>;
  requestHeaders: Partial<Record<IdentityContext, FullHostIdentityRequestHeaders>>;
};
export class HostIdentityCaptureError extends Error {
  constructor(message: string, readonly evidence: PartialHostIdentityCapture) { super(message); this.name = "HostIdentityCaptureError"; }
}

/** Self-contained: exactly this function executes in real Window, Frame and worker globals. */
export async function captureHostIdentitySurface(options: IdentitySurfaceOptions): Promise<IdentitySurfaceCapture> {
  const deadline = Date.now() + options.timeoutMs, controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), options.timeoutMs);
  const text = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 512);
  const status = (): "timeout" | "error" => Date.now() >= deadline || controller.signal.aborted ? "timeout" : "error";
  async function limit<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Surface capture deadline exceeded")), Math.max(0, deadline - Date.now())); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const documentPolicy = (globalThis as unknown as { document?: { permissionsPolicy?: { allowsFeature(feature: string, origin?: string): boolean }; featurePolicy?: { allowsFeature(feature: string, origin?: string): boolean } } }).document;
  const policy = documentPolicy?.permissionsPolicy || documentPolicy?.featurePolicy;
  const observation: IdentityPolicyObservation = {
    origin: location.origin, secureContext: globalThis.isSecureContext === true,
    api: documentPolicy?.permissionsPolicy ? "permissionsPolicy" : documentPolicy?.featurePolicy ? "featurePolicy" : "unavailable",
    allowedHints: [], crossOriginAllowedHints: [],
  };
  const result: IdentitySurfaceCapture = {
    context: options.context, observation, navigator: { status: "notrun", reason: "Navigator capture not started" },
    request: { status: "notrun", reason: "Request capture not started" },
  };
  async function get(path: "opt-in" | "echo"): Promise<{ response: IdentityHttpObservation; body: string }> {
    const url = `${options.origin}${options.prefix}${path}?context=${encodeURIComponent(options.context)}`;
    const response = await limit(fetch(url, { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal }));
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    if (JSON.stringify(headers).length > 16384 || response.url !== url) throw new Error("Oversized headers or unexpected response URL");
    const observed = { url: response.url, status: response.status, headers };
    if (path === "opt-in") result.optIn = observed; else result.echo = observed;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Fixture response has no readable body");
    const decoder = new TextDecoder(); let body = "", bytes = 0;
    try {
      for (;;) {
        const chunk = await limit(reader.read());
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65536) { controller.abort(); throw new Error("Fixture response exceeded 65536 bytes; truncation is a failure"); }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
    if (!response.ok) throw new Error(`Fixture ${path} returned HTTP ${response.status}`);
    return { response: observed, body };
  }
  try {
    for (const [hint, feature] of options.hints) {
      if (policy?.allowsFeature(feature)) observation.allowedHints.push(hint);
      if (policy?.allowsFeature(feature, options.crossOrigin)) observation.crossOriginAllowedHints.push(hint);
    }
    if (observation.origin !== options.origin) throw new Error("Surface is not at its owned fixture origin");
    try {
      const source = navigator as Navigator & { userAgentData?: {
        platform: string; mobile: boolean; brands: { brand: string; version: string }[];
        getHighEntropyValues(hints: string[]): Promise<NonNullable<FullHostNavigatorIdentity["highEntropy"]>>;
      } };
      const data = source.userAgentData;
      const identity: FullHostNavigatorIdentity = {
        userAgent: source.userAgent, platform: source.platform, uaPlatform: data?.platform ?? null,
        mobile: data?.mobile ?? null, brands: data ? data.brands : null,
        highEntropy: data ? await limit(data.getHighEntropyValues(["architecture", "bitness", "platform", "platformVersion", "fullVersionList", "uaFullVersion", "model", "wow64", "mobile", "formFactors"])) : null,
      };
      if (JSON.stringify(identity).length > 16384) throw new Error("Navigator evidence exceeded bound; truncation is a failure");
      result.navigator = { status: "captured", identity };
    } catch (error) { result.navigator = { status: status(), reason: text(error) }; }
    try {
      const warm = await get("opt-in"); // Await actual opt-in response before issuing the subsequent request.
      const acceptCH = (warm.response.headers["accept-ch"] || "").split(",").map((hint) => hint.trim()).filter(Boolean);
      if (acceptCH.some((hint) => !/^[a-z0-9-]+$/i.test(hint))) throw new Error("Malformed Accept-CH response");
      const responsePolicy = warm.response.headers["permissions-policy"] || "";
      const inherited = options.parentObservation;
      const workerContext = options.context === "dedicated" || options.context === "shared" || options.context === "service";
      const docAllowed = policy ? observation.allowedHints : workerContext ? inherited?.allowedHints || [] : [];
      const delegatedHints = options.hints.filter(([hint, feature]) => {
        const clause = responsePolicy.split(",").map((value) => value.trim()).find((value) => value.startsWith(`${feature}=`));
        const declared = clause && /^[-a-z0-9]+=\((?:self|"http:\/\/127\.0\.0\.1:\d+")(?: (?:self|"http:\/\/127\.0\.0\.1:\d+"))*\)$/.test(clause) && clause.split(" ").some((value) => value.replace(/[()]/g, "") === JSON.stringify(options.origin));
        return declared && docAllowed.includes(hint) && (options.context !== "cross-origin-frame" || inherited?.crossOriginAllowedHints.includes(hint));
      }).map(([hint]) => hint);
      const echo = await get("echo");
      const echoed: unknown = JSON.parse(echo.body);
      if (!echoed || typeof echoed !== "object" || !("requestUrl" in echoed) || !("headers" in echoed) || !("rawHeaders" in echoed)) throw new Error("Echo did not return a wire receipt");
      result.echoed = echoed as NonNullable<IdentitySurfaceCapture["echoed"]>;
      const negotiation: IdentityNegotiation = {
        origin: observation.origin, topLevelOrigin: options.topLevelOrigin,
        secureContext: observation.secureContext && (options.context === "window" || inherited?.secureContext === true),
        optInResponseReceived: acceptCH.length > 0, postOptInRequest: warm.response.status >= 200 && warm.response.status < 300 && echo.response.status >= 200 && echo.response.status < 300,
        permissionsPolicyDelegated: options.hints.length > 0 && delegatedHints.length === options.hints.length, acceptCH, delegatedHints,
      };
      result.request = { status: "captured", responseStatus: echo.response.status, requestUrl: echo.response.url, negotiation };
    } catch (error) { result.request = { status: status(), reason: text(error), ...(result.echo ? { responseStatus: result.echo.status, requestUrl: result.echo.url } : {}) }; }
  } catch (error) {
    result.navigator = { status: status(), reason: text(error) }; result.request = { status: status(), reason: text(error) };
  } finally { clearTimeout(abortTimer); controller.abort(); }
  return result;
}

export interface IdentityWorkerOptions { kind: WorkerContext; scriptUrl: string; scope: string; resourceKey: string; surface: IdentitySurfaceOptions }
export interface IdentityWorkerCapture { surface?: IdentitySurfaceCapture; status: "captured" | "error" | "timeout"; reason?: string; cleanupErrors: string[] }
/** No blobs or synthetic identities: the fixture script invokes the same surface function in a real worker. */
export async function captureHostIdentityWorkerInPage(options: IdentityWorkerOptions): Promise<IdentityWorkerCapture> {
  const deadline = Date.now() + options.surface.timeoutMs, cleanupErrors: string[] = [];
  const globals = globalThis as unknown as Record<string, { cleanup(): Promise<void> }>;
  if (globals[options.resourceKey]) throw new Error("Worker resource key is already owned");
  let dedicated: Worker | undefined, shared: SharedWorker | undefined, channel: MessageChannel | undefined;
  let registration: ServiceWorkerRegistration | undefined, registering: Promise<ServiceWorkerRegistration> | undefined;
  let cancelled = false, cleaning: Promise<void> | undefined, removeStateListener: (() => void) | undefined;
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 512);
  async function limit<T>(promise: Promise<T>, ms = Math.max(0, deadline - Date.now())): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Worker capture deadline exceeded")), ms); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function unregister(owned: ServiceWorkerRegistration): Promise<void> {
    if (owned.scope !== options.scope) throw new Error("Refusing to unregister a service worker outside the unique owned scope");
    if (!await limit(owned.unregister(), 2000)) throw new Error("Owned service worker registration was not unregistered");
  }
  function cleanup(): Promise<void> {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      cancelled = true;
      const failures: string[] = [];
      const attempt = (action: () => void): void => { try { action(); } catch (error) { failures.push(errorText(error)); } };
      attempt(() => removeStateListener?.());
      if (dedicated) attempt(() => { dedicated!.onmessage = null; dedicated!.onmessageerror = null; dedicated!.onerror = null; dedicated!.terminate(); });
      if (shared) attempt(() => { shared!.onerror = null; shared!.port.onmessage = null; shared!.port.onmessageerror = null; shared!.port.close(); });
      if (channel) {
        attempt(() => { channel!.port1.onmessage = null; channel!.port1.onmessageerror = null; channel!.port1.close(); });
        attempt(() => channel!.port2.close());
      }
      try {
        if (registration) await unregister(registration);
        else if (registering) await limit(registering.then(() => undefined), 2000);
      } catch (error) { failures.push(errorText(error)); }
      if (failures.length) throw new Error(failures.join("; "));
    })().finally(() => { delete globals[options.resourceKey]; });
    return cleaning;
  }
  globals[options.resourceKey] = { cleanup };
  let output: IdentityWorkerCapture;
  try {
    let port: Worker | MessagePort, target: Worker | MessagePort | ServiceWorker;
    if (options.kind === "dedicated") { dedicated = new Worker(options.scriptUrl, { name: options.resourceKey }); port = target = dedicated; }
    else if (options.kind === "shared") { shared = new SharedWorker(options.scriptUrl, { name: options.resourceKey }); port = target = shared.port; shared.port.start(); }
    else {
      registering = navigator.serviceWorker.register(options.scriptUrl, { scope: options.scope, updateViaCache: "none" }).then(async (owned) => {
        registration = owned;
        if (cancelled) await unregister(owned);
        return owned;
      });
      const owned = await limit(registering);
      if (owned.scope !== options.scope) throw new Error("Service worker registration did not use the unique fixture scope");
      const active = owned.installing || owned.waiting || owned.active;
      if (!active || active.scriptURL !== options.scriptUrl) throw new Error("Owned service worker script was not installed");
      await limit(new Promise<void>((resolve, reject) => {
        const changed = (): void => { if (active.state === "activated") resolve(); else if (active.state === "redundant") reject(new Error("Owned service worker became redundant")); };
        active.addEventListener("statechange", changed); removeStateListener = () => active.removeEventListener("statechange", changed); changed();
      }));
      channel = new MessageChannel(); port = channel.port1; target = active; channel.port1.start();
    }
    const surface = await limit(new Promise<IdentitySurfaceCapture>((resolve, reject) => {
      port.onmessage = (event: MessageEvent) => {
        try {
          const value = event.data, serialized = JSON.stringify(value);
          if (typeof serialized !== "string" || serialized.length > 98304) throw new Error("Worker evidence missing or exceeded bound");
          if (value?.error) reject(new Error(String(value.error).slice(0, 512)));
          else if (value?.context === options.kind && value.result?.context === options.kind) resolve(value.result);
          else reject(new Error("Worker returned no genuine surface receipt"));
        } catch (error) { reject(error); }
      };
      port.onmessageerror = () => reject(new Error("Worker message could not be decoded"));
      if (dedicated) dedicated.onerror = () => reject(new Error("Dedicated worker script failed"));
      if (shared) shared.onerror = () => reject(new Error("Shared worker script failed"));
      const message = { ...options.surface, timeoutMs: Math.max(1, deadline - Date.now() - 100) };
      if (channel) (target as ServiceWorker).postMessage(message, [channel.port2]); else (target as Worker | MessagePort).postMessage(message);
    }));
    output = { status: "captured", surface, cleanupErrors };
  } catch (error) { output = { status: Date.now() >= deadline ? "timeout" : "error", reason: errorText(error), cleanupErrors }; }
  finally {
    try { await cleanup(); } catch (error) { cleanupErrors.push(errorText(error)); }
  }
  if (cleanupErrors.length) return { ...output, status: "error", reason: `Worker cleanup failed: ${cleanupErrors.join("; ")}` };
  return output;
}

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), Math.max(0, ms)); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

const ownedFixtures = new WeakSet<HostIdentityFixture>();
/** Import-safe. Only this explicit call binds the two distinct loopback ports. No upstream requests or logging. */
export async function startHostIdentityFixture(options: { allowBlobWorkers?: boolean } = {}): Promise<HostIdentityFixture> {
  // GPU corpus collectors use blob Workers; opt in only on this owned fixture,
  // without changing the browser's CSP enforcement or the default CPU fixture.
  const workerSources = options.allowBlobWorkers === true ? "'self' blob:" : "'self'";
  const base = `/__host_identity_${randomUUID()}/`, servers: http.Server[] = [], origins: string[] = [];
  type Run = { prefix: string; count: number; bytes: number; receipts: IdentityWireReceipt[]; failure?: string };
  let active: Run | undefined, fatal: string | undefined, captures = 0, closing: Promise<void> | undefined;
  const fail = (reason: string): void => { if (active) active.failure ??= reason.slice(0, 512); else fatal ??= reason.slice(0, 512); };
  const source = `const capture=(${captureHostIdentitySurface.toString()});`;
  const reply = `async function run(o,p){try{p.postMessage({context:o.context,result:await capture(o)})}catch(e){p.postMessage({error:String(e).slice(0,512)})}}`;
  const scripts = {
    "dedicated.js": `${source}${reply}self.onmessage=e=>run(e.data,self);`,
    "shared.js": `${source}${reply}self.onconnect=e=>{const p=e.ports[0];p.onmessage=async m=>{try{await run(m.data,p)}finally{p.close();self.close()}};p.start()};`,
    "service.js": `${source}${reply}self.oninstall=e=>e.waitUntil(self.skipWaiting());self.onmessage=e=>e.waitUntil(run(e.data,e.ports[0]));`,
  };
  const close = (): Promise<void> => closing ??= (async () => {
    const results = await Promise.allSettled(servers.map((server) => bounded(new Promise<void>((resolve, reject) => {
      server.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
      server.closeAllConnections();
    }), 3000, "Fixture server close")));
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  })();
  try {
    for (let index = 0; index < 2; index++) {
      const server = http.createServer({ maxHeaderSize: 16384 }, (request, response) => {
        const run = active, origin = origins[index];
        const reject = (status: number, reason: string): void => { fail(reason); response.writeHead(status, { "Connection": "close" }); response.end("Fixture request rejected"); };
        if (!origin || request.method !== "GET" || request.headers.host !== new URL(origin).host || !request.url?.startsWith("/") || request.url.startsWith("//")) { reject(400, "Unexpected method, Host or request target"); return; }
        if (["cookie", "authorization", "proxy-authorization", "transfer-encoding"].some((key) => key in request.headers) || Number(request.headers["content-length"] || "0") !== 0) { reject(400, "Credentials and request bodies are forbidden"); return; }
        if (request.rawHeaders.length > 128 || Buffer.byteLength(JSON.stringify(request.rawHeaders)) > 32768) { reject(431, "Raw request headers exceeded bound"); return; }
        if (!run || !request.url.startsWith(run.prefix)) { response.writeHead(404); response.end("Not found"); return; }
        if (++run.count > 64) { reject(429, "Fixture exceeded 64 requests per capture; truncation is a failure"); return; }
        const url = new URL(request.url, origin), relative = url.pathname.slice(run.prefix.length);
        const paths = index === 0 ? ["page", "same-frame", "opt-in", "echo", ...Object.keys(scripts)] : ["cross-frame", "opt-in", "echo"];
        if (!url.pathname.startsWith(run.prefix) || !paths.includes(relative)) { response.writeHead(404); response.end("Not found"); return; }
        const responseHeaders: Record<string, string> = {
          "accept-ch": HOST_IDENTITY_HINTS.map(([hint]) => hint).join(", "),
          "permissions-policy": HOST_IDENTITY_HINTS.map(([, feature]) => `${feature}=(self ${origins.map((value) => JSON.stringify(value)).join(" ")})`).join(", "),
          "cache-control": "no-store", "x-content-type-options": "nosniff",
          "content-security-policy": `default-src 'none'; script-src 'self'; worker-src ${workerSources}; connect-src 'self'; frame-src ${origins.join(" ")}`,
        };
        let body: string;
        if (relative === "opt-in" || relative === "echo") {
          const context = url.searchParams.get("context") as IdentityContext;
          if (!CONTEXTS.includes(context) || url.search !== `?context=${encodeURIComponent(context)}` || (index === 1) !== (context === "cross-origin-frame")) { reject(400, "Unexpected fixture context or query"); return; }
          if (run.receipts.some((receipt) => receipt.context === context && receipt.phase === relative)) { reject(409, "Duplicate fixture context/phase receipt"); return; }
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
          responseHeaders["content-type"] = "application/json; charset=utf-8";
          const receipt: IdentityWireReceipt = { context, phase: relative, sequence: run.receipts.length, requestUrl: url.href, headers, rawHeaders: [...request.rawHeaders], responseStatus: 200, responseHeaders: { ...responseHeaders } };
          const size = Buffer.byteLength(JSON.stringify(receipt));
          if (run.bytes + size > 262144) { reject(413, "Fixture wire evidence exceeded bound; truncation is a failure"); return; }
          run.bytes += size; run.receipts.push(receipt);
          body = relative === "echo" ? JSON.stringify({ requestUrl: url.href, headers, rawHeaders: receipt.rawHeaders }) : "{\"optIn\":\"response-only\"}";
        } else {
          if (url.search) { reject(400, "Unexpected fixture document/script query"); return; }
          if (relative in scripts) {
            responseHeaders["content-type"] = "text/javascript; charset=utf-8";
            if (relative === "service.js") responseHeaders["service-worker-allowed"] = `${run.prefix}service-scope/`;
            body = scripts[relative as keyof typeof scripts];
          } else {
            responseHeaders["content-type"] = "text/html; charset=utf-8";
            body = "<!doctype html><meta charset=utf-8><link rel=icon href='data:,'><title>Owned host identity fixture</title><body></body>";
          }
        }
        if (Buffer.byteLength(body) > 65536) { reject(413, "Fixture response exceeded bound; truncation is a failure"); return; }
        response.writeHead(200, responseHeaders); response.end(body);
      });
      servers.push(server); server.maxConnections = 12; server.maxHeadersCount = 0;
      server.requestTimeout = 5000; server.headersTimeout = 3000; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 32;
      server.on("clientError", (error, socket) => { fail(`HTTP parser rejected a request: ${error.message}`); socket.destroy(); });
      server.on("error", (error) => fail(`Fixture server error: ${error.message}`));
      server.on("listening", () => { if (closing) { server.close((error) => { if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") fail(error.message); }); server.closeAllConnections(); } });
      await bounded(new Promise<void>((resolve, reject) => {
        const errored = (error: Error): void => reject(error);
        server.once("error", errored); server.listen(0, "127.0.0.1", () => { server.removeListener("error", errored); resolve(); });
      }), 3000, "Fixture listen");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture did not bind a dynamic loopback port");
      origins.push(`http://127.0.0.1:${address.port}`);
    }
    if (origins[0] === origins[1]) throw new Error("Fixture ports are not cross-origin");
    const fixture: HostIdentityFixture = Object.freeze({
      origin: origins[0], crossOrigin: origins[1], close,
      beginCapture: () => {
        if (closing || active || fatal || ++captures > 32) throw new Error(fatal || "Fixture is closed, busy, or exceeded 32 serial captures");
        const run: Run = { prefix: `${base}${randomUUID()}/`, count: 0, bytes: 0, receipts: [] }; active = run;
        return {
          prefix: run.prefix, receipts: () => structuredClone(run.receipts),
          assertHealthy: () => { if (fatal || run.failure) throw new Error(fatal || run.failure); },
          release: () => { if (active === run) active = undefined; run.receipts.length = 0; },
        };
      },
    });
    ownedFixtures.add(fixture); return fixture;
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Fixture startup and cleanup failed"); }
    throw error;
  }
}

/** Removes only this fixture's resources, never pre-existing frames or registrations. */
export async function cleanupHostIdentityInPage(options: { prefix: string; origin: string; crossOrigin: string }): Promise<void> {
  const globals = globalThis as unknown as Record<string, { cleanup(): Promise<void> }>;
  for (const [kind, origin] of [["same", options.origin], ["cross", options.crossOrigin]]) {
    const element = document.getElementById(`${options.prefix}${kind}`);
    if (element && element.tagName === "IFRAME" && (element as HTMLIFrameElement).src === `${origin}${options.prefix}${kind}-frame`) element.remove();
  }
  const results = await Promise.allSettled(["dedicated", "shared", "service"].map(async (kind) => globals[`${options.prefix}${kind}`]?.cleanup()));
  const errors = results.filter((value): value is PromiseRejectedResult => value.status === "rejected").map((value) => String(value.reason).slice(0, 512));
  if (errors.length) throw new Error(`Owned resource cleanup failed: ${errors.join("; ")}`);
}

function selected(headers: Record<string, string>): FullHostIdentityRequestHeaders {
  const get = (name: string): string | null => headers[name] ?? null;
  return {
    userAgent: get("user-agent"), acceptLanguage: get("accept-language"), doNotTrack: get("dnt"),
    uaBrands: get("sec-ch-ua"), uaMobile: get("sec-ch-ua-mobile"), uaPlatform: get("sec-ch-ua-platform"),
    uaArchitecture: get("sec-ch-ua-arch"), uaBitness: get("sec-ch-ua-bitness"), uaPlatformVersion: get("sec-ch-ua-platform-version"),
    uaFullVersionList: get("sec-ch-ua-full-version-list"), uaFullVersion: get("sec-ch-ua-full-version"),
    uaModel: get("sec-ch-ua-model"), uaWow64: get("sec-ch-ua-wow64"), uaFormFactors: get("sec-ch-ua-form-factors"),
  };
}
/** Navigates the caller's Page; cleans only its capture resources. Runner owns fixture.close() in an outer finally. */
export async function captureFullHostIdentity(page: Page, options: { fixture: HostIdentityFixture; binding: IdentityRunBinding; timeoutMs?: number }): Promise<FullHostIdentityCapture> {
  const { fixture } = options, timeoutMs = options.timeoutMs ?? 90000, deadline = Date.now() + timeoutMs;
  let run: HostIdentityFixtureCapture | undefined, prefix = "";
  const evidence: PartialHostIdentityCapture = {
    binding: { ...options.binding }, navigators: {}, requestEvidence: {}, requestHeaders: {},
    captureEvidence: { warnings: IDENTITY_CAPTURE_WARNINGS, timeoutMs, contexts: {}, wire: [], cleanupErrors: [] },
  };
  for (const context of CONTEXTS) { evidence.navigators[context] = { status: "notrun", reason: "Capture not started" }; evidence.requestEvidence[context] = { status: "notrun", reason: "Capture not started" }; }
  const errors: string[] = [];
  const budget = (maximum: number): number => { const value = Math.min(maximum, deadline - Date.now()); if (value <= 0) throw new Error("Full identity capture deadline exceeded"); return value; };
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1024);
  const surfaceOptions = (context: IdentityContext): IdentitySurfaceOptions => ({
    context, origin: context === "cross-origin-frame" ? fixture.crossOrigin : fixture.origin, topLevelOrigin: fixture.origin,
    crossOrigin: fixture.crossOrigin, prefix: prefix, timeoutMs: budget(8000), hints: HOST_IDENTITY_HINTS,
    parentObservation: evidence.captureEvidence.contexts.window?.observation,
  });
  const capture = async (context: IdentityContext, frame: Frame | Page = page): Promise<void> => {
    try {
      const input = surfaceOptions(context);
      let surface: IdentitySurfaceCapture;
      if (context === "dedicated" || context === "shared" || context === "service") {
        const result = await bounded(page.evaluate(captureHostIdentityWorkerInPage, {
          kind: context, scriptUrl: `${fixture.origin}${prefix}${context === "dedicated" ? "dedicated" : context}.js`,
          scope: `${fixture.origin}${prefix}service-scope/`, resourceKey: `${prefix}${context}`, surface: input,
        }), input.timeoutMs + 2500, `${context} worker`);
        if (result.cleanupErrors.length) evidence.captureEvidence.cleanupErrors.push(...result.cleanupErrors);
        if (result.status !== "captured" || !result.surface) throw new Error(result.reason || `${context} worker did not capture`);
        surface = result.surface;
      } else surface = await bounded(frame.evaluate(captureHostIdentitySurface, input), input.timeoutMs + 250, `${context} surface`);
      if (surface.context !== context || JSON.stringify(surface).length > 98304) throw new Error("Invalid or oversized surface receipt");
      evidence.captureEvidence.contexts[context] = surface;
      evidence.navigators[context] = surface.navigator; evidence.requestEvidence[context] = surface.request;
    } catch (error) {
      const failure = { status: Date.now() >= deadline || /deadline|timed out/i.test(describe(error)) ? "timeout" as const : "error" as const, reason: describe(error) };
      evidence.navigators[context] = failure; evidence.requestEvidence[context] = { ...failure };
    }
  };
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error("Capture timeout must be 100..120000ms");
    if (!ownedFixtures.has(fixture)) throw new Error("Capture requires the owned two-loopback-port fixture from startHostIdentityFixture");
    if (!Number.isSafeInteger(options.binding.pid) || options.binding.pid <= 0 || !/^[a-f0-9]{64}$/.test(options.binding.executableSha256) ||
      [options.binding.runId, options.binding.hostId, options.binding.profileId, options.binding.executablePath].some((value) => typeof value !== "string" || !value || value.length > 4096) ||
      !["headed", "headless"].includes(options.binding.mode) || !["managed", "off"].includes(options.binding.identityMode)) throw new Error("Invalid caller-supplied run binding");
    run = fixture.beginCapture(); prefix = run.prefix;
    const navigationBudget = budget(10000);
    const navigation = await bounded(page.goto(`${fixture.origin}${prefix}page`, { waitUntil: "load", timeout: navigationBudget }), navigationBudget + 250, "Fixture navigation");
    if (!navigation?.ok() || page.url() !== `${fixture.origin}${prefix}page`) throw new Error("Owned top-level fixture navigation failed");
    await capture("window");
    for (const kind of ["dedicated", "shared", "service"] as const) await capture(kind);
    const frameBudget = budget(5000);
    await bounded(page.evaluate(async ({ prefix, origin, crossOrigin, hints, ms }) => {
      const outcomes = await Promise.allSettled((["same", "cross"] as const).map((kind) => new Promise<void>((resolve, reject) => {
        const name = `${prefix}${kind}`, frame = document.createElement("iframe");
        if (document.getElementById(name)) { reject(new Error("Unique fixture frame already exists")); return; }
        frame.id = frame.name = name; frame.src = `${kind === "same" ? origin : crossOrigin}${prefix}${kind}-frame`;
        frame.allow = hints.map(([, feature]) => `${feature} ${origin} ${crossOrigin}`).join("; ");
        const finish = (error?: Error): void => { clearTimeout(timer); frame.onload = frame.onerror = null; if (error) { frame.remove(); reject(error); } else resolve(); };
        const timer = setTimeout(() => finish(new Error("Fixture frame load deadline exceeded")), ms);
        frame.onload = () => finish(); frame.onerror = () => finish(new Error("Fixture frame load failed"));
        try { document.body.appendChild(frame); } catch (error) { finish(new Error(String(error).slice(0, 512))); }
      })));
      const failed = outcomes.find((value) => value.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }, { prefix, origin: fixture.origin, crossOrigin: fixture.crossOrigin, hints: HOST_IDENTITY_HINTS, ms: frameBudget }), frameBudget + 250, "Fixture frames");
    for (const [context, kind, origin] of [["same-origin-frame", "same", fixture.origin], ["cross-origin-frame", "cross", fixture.crossOrigin]] as const) {
      const frame = page.frame({ name: `${prefix}${kind}` });
      if (!frame || frame.url() !== `${origin}${prefix}${kind}-frame`) {
        evidence.navigators[context] = { status: "error", reason: "Owned real Frame was not attached at the expected URL" }; evidence.requestEvidence[context] = { ...evidence.navigators[context] }; continue;
      }
      await capture(context, frame);
    }
    run.assertHealthy(); evidence.captureEvidence.wire = run.receipts();
    for (const context of CONTEXTS) {
      const surface = evidence.captureEvidence.contexts[context], request = evidence.requestEvidence[context];
      if (request?.status !== "captured" || !surface) continue;
      const warm = evidence.captureEvidence.wire.find((value) => value.context === context && value.phase === "opt-in");
      const echo = evidence.captureEvidence.wire.find((value) => value.context === context && value.phase === "echo");
      if (!warm || !echo || warm.sequence >= echo.sequence || echo.responseStatus < 200 || echo.responseStatus >= 300 ||
        surface.optIn?.status !== warm.responseStatus || surface.echo?.status !== echo.responseStatus ||
        surface.optIn?.headers["accept-ch"] !== warm.responseHeaders["accept-ch"] || surface.optIn?.headers["permissions-policy"] !== warm.responseHeaders["permissions-policy"] ||
        JSON.stringify(surface.echoed) !== JSON.stringify({ requestUrl: echo.requestUrl, headers: echo.headers, rawHeaders: echo.rawHeaders })) {
        evidence.requestEvidence[context] = { status: "error", reason: "Browser response did not match the owned server's successful post-opt-in wire receipt" }; continue;
      }
      evidence.requestHeaders[context] = selected(echo.headers);
      request.negotiation!.postOptInRequest = warm.sequence < echo.sequence;
    }
  } catch (error) { errors.push(describe(error)); }
  finally {
    if (run) {
      try { await bounded(page.evaluate(cleanupHostIdentityInPage, { prefix, origin: fixture.origin, crossOrigin: fixture.crossOrigin }), 5000, "Owned page resource cleanup"); }
      catch (error) { evidence.captureEvidence.cleanupErrors.push(describe(error)); }
      try { evidence.captureEvidence.wire = run.receipts(); run.assertHealthy(); }
      catch (error) { errors.push(describe(error)); }
      try { run.release(); } catch (error) { evidence.captureEvidence.cleanupErrors.push(describe(error)); }
    }
  }
  const window = evidence.navigators.window?.identity, worker = evidence.navigators.dedicated?.identity;
  const { window: windowHeaders, dedicated, shared, service } = evidence.requestHeaders;
  if (errors.length || evidence.captureEvidence.cleanupErrors.length || !window || !worker || !windowHeaders || !dedicated || !shared || !service) {
    throw new HostIdentityCaptureError([...errors, ...evidence.captureEvidence.cleanupErrors, ...CONTEXTS.filter((context) => evidence.navigators[context]?.status !== "captured" || evidence.requestEvidence[context]?.status !== "captured").map((context) => `${context}: navigator=${evidence.navigators[context]?.status}, request=${evidence.requestEvidence[context]?.status}`)].join("; ") || "Incomplete identity capture", evidence);
  }
  return { ...evidence, window, worker, requestHeaders: { ...evidence.requestHeaders, window: windowHeaders, dedicated, shared, service } };
}
