// Stage 3 selected-page network unit/DOM fixture. The coordinator retained the
// original feature RED before the explicit renderer production handoff. Further
// execution requires the coordinator's serialized source-stable test window.
//
// Unit boundary: whole production icons/core/ipc/fingerprint-drift/profiles/i18n modules as-is in an
// owned in-memory DOM/VM. API replies and armed notifications are explicit mocks.
// No Electron, browser, sockets, fetch, user-data, persistent writes or new deps.
// Like renderer-health-flows.test.ts, this fixture models DOM state, not layout,
// native modal/focus behavior, real IPC, backend ownership or target isolation.
// The existing generic data-cmd/data-change-cmd dispatcher is a declared seam:
// helpers invoke the production global named by the actual control's attributes.
// They do not implement observation, selection, cancellation or cache decisions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");
const SOURCES = Object.fromEntries(["icons", "core", "ipc", "fingerprint-drift", "profiles"].map(name => [name,
  fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${name}.js`), "utf8"),
]));
const HEALTH_KEY = "agent-browser-health-history-v1";
const SUMMARY_CODE = "NETWORK_OBSERVATION_V1";
const AT = 1_792_387_200_000;
const SECRET = "__RENDERER_NETWORK_PRIVATE_SENTINEL__";
const PRIVATE_URL = `https://private.fixture.test/private-path/${SECRET}?token=${SECRET}#${SECRET}`;
const ORIGIN_A = "https://selected.fixture.test";
const ORIGIN_B = "https://different.fixture.test";
const OTHER_ORIGIN = "https://assets.other.fixture.test";
const HANDLE_A = "opaque-page-selection-a";
const HANDLE_B = "opaque-page-selection-b";
const OLD_KINDS = ["env", "webrtc", "drift", "consistency"] as const;
const PROFILE_A = {
  dirId: "network_fixture_a", name: "Network fixture A", engine: "chromium", fingerprintMode: "managed",
  fingerprintSeed: 12345, platform: "macos", timezone: "UTC", locale: "en-US", tags: ["synthetic"],
  syncStatus: "synced", syncScope: "portable-profile+preferences", syncReason: "baseline-match", syncedAt: 1000,
  lastModified: 2000, running: true, pid: null, proxyMode: "none", proxyName: null,
};
const PROFILE_B = { ...PROFILE_A, dirId: "network_fixture_b", name: "Network fixture B" };
const PROFILE_C = { ...PROFILE_A, dirId: "network_fixture_c", name: "Network fixture C" };
const COUNT_KEYS = ["requests", "hops", "responses", "finished", "failed", "blocked", "requestCancelled", "redirects", "http4xx", "http5xx", "pending", "cache", "serviceWorker", "unattributed", "cspIssues"] as const;
const COVERAGE_KEYS = ["network", "csp", "worker", "oopif", "console", "storage", "frames", "bridgeHop", "upstreamHop"] as const;
const STOP_REASONS = ["window-ended", "cancelled", "deadline", "connection-closed", "target-changed", "setup-rejected", "setup-timeout", "protocol-invalid", "limit-exceeded", "evidence-incomplete", "cleanup-unverified"] as const;
const NETWORK_FAILURE_CASES = [
  ["PROFILE_NOT_FOUND", "network.failure.profile-not-found"], ["HEALTH_INVALID_REQUEST", "network.failure.invalid-request"],
  ["HEALTH_BUSY", "network.failure.busy"], ["HEALTH_CANCELLED", "network.failure.cancelled"], ["HEALTH_TIMEOUT", "network.failure.timeout"],
  ["HEALTH_PROFILE_CHANGED", "network.failure.profile-changed"], ["HEALTH_HISTORY_WRITE_FAILED", "network.failure.history-write-failed"],
  ["NETWORK_RUNTIME_UNAVAILABLE", "network.failure.runtime-unavailable"], ["NETWORK_ENGINE_UNSUPPORTED", "network.failure.engine-unsupported"],
  ["NETWORK_SELECTION_STALE", "network.selection-expired"], ["NETWORK_SELECTION_LIMIT", "network.failure.selection-limit"],
  ["NETWORK_SETUP_TIMEOUT", "network.failure.setup-timeout"], ["NETWORK_PROTOCOL_INVALID", "network.failure.protocol-invalid"],
  ["NETWORK_OBSERVATION_FAILED", "network.failure.observation-failed"],
] as const;
type Counts = Record<(typeof COUNT_KEYS)[number], number>;
type Coverage = {
  network: "observed" | "partial" | "unavailable"; csp: "observed" | "unavailable";
  worker: "not-observed"; oopif: "not-observed"; console: "not-observed"; storage: "not-observed";
  frames: "selected-target-main-frame"; bridgeHop: "unknown"; upstreamHop: "unknown";
};
interface Summary {
  version: 1; completion: "completed" | "partial" | "cancelled" | "unavailable";
  stopReason: (typeof STOP_REASONS)[number]; armedAt: number | null; endedAt: number; durationMs: number;
  counts: Counts; coverage: Coverage;
}
interface Hop {
  id: string; chainId: string; redirectedFrom: string | null; origin: string;
  method: string; resourceType: string; status: number | null; networkStatus: number | null;
  terminal: "finished" | "failed" | "blocked" | "cancelled" | "redirected" | "pending";
  errorCode: string | null; blockedReason: string | null; corsReason: string | null;
  fromDiskCache: boolean | null; fromServiceWorker: boolean | null;
  fromPrefetchCache: boolean | null; servedFromCache: boolean | null;
}
interface Armed { dirId: string; requestId: string; armedAt: number; observeForMs: 10000 }
interface StatusEvidence {
  id: string; chainId: string; hopId: string | null; status: number;
  source: "extra-info"; association: "unique" | "unknown";
}
function counts(patch: Partial<Counts> = {}): Counts {
  return { requests: 1, hops: 1, responses: 1, finished: 1, failed: 0, blocked: 0, requestCancelled: 0, redirects: 0, http4xx: 0, http5xx: 0, pending: 0, cache: 0, serviceWorker: 0, unattributed: 0, cspIssues: 0, ...patch };
}
function zeroCounts(): Counts { return Object.fromEntries(COUNT_KEYS.map(key => [key, 0])) as Counts; }
function coverage(patch: Partial<Coverage> = {}): Coverage {
  return { network: "observed", csp: "unavailable", worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown", ...patch };
}
function summary(patch: Partial<Summary> = {}): Summary {
  return { version: 1, completion: "completed", stopReason: "window-ended", armedAt: AT, endedAt: AT + 10_000, durationMs: 10_000, counts: counts(), coverage: coverage(), ...patch };
}
function partial(patch: Partial<Summary> = {}): Summary {
  return summary({ completion: "partial", stopReason: "connection-closed", endedAt: AT + 5000, durationMs: 5000, coverage: coverage({ network: "partial" }), ...patch });
}
function unavailable(): Summary {
  return summary({ completion: "unavailable", stopReason: "setup-rejected", armedAt: null, endedAt: AT, durationMs: 0, counts: zeroCounts(), coverage: coverage({ network: "unavailable" }) });
}
function hop(patch: Partial<Hop> = {}): Hop {
  return { id: "hop-1", chainId: "chain-1", redirectedFrom: null, origin: OTHER_ORIGIN,
    method: "GET", resourceType: "Fetch", status: 200, networkStatus: null, terminal: "finished",
    errorCode: null, blockedReason: null, corsReason: null, fromDiskCache: false, fromServiceWorker: false,
    fromPrefetchCache: false, servedFromCache: false, ...patch };
}
function reply(requestId: string, observation = summary(), hops: any[] = [hop()], extra: Record<string, any> = {}) {
  return { ok: true, outcome: "inconclusive", requestId, observation, hops, httpStatusEvidence: [] as StatusEvidence[], ...extra };
}
function canonical(observation = summary(), requestId = "canonical-network-run", outcome = "inconclusive") {
  return { kind: "network", at: observation.endedAt, outcome, summary: SUMMARY_CODE, requestId, source: "runtime", networkSummary: observation };
}
const envReply = () => ({ ok: true, outcome: "pass", result: {
  at: AT, ok: true, hostPlatform: "synthetic", hostLocale: "en-US", resolvers: [], cnFonts: [], findings: [], summary: "legacy environment fixture",
} });
const rtcReply = () => ({ ok: true, outcome: "pass", result: {
  at: AT, success: true, rtcAvailable: true, gatheringState: "complete", hostIps: [], srflxIps: ["203.0.113.7"], mdnsHosts: [],
  candidates: ["candidate:synthetic 1 udp 1 203.0.113.7 50000 typ srflx"], connectionState: "completed", rttMs: null, error: null, summary: "legacy RTC fixture",
} });

// Small independent adaptation of the read-only renderer-health-flows fixture.
// Dynamic HTML keeps script/hostile attributes as inert nodes so privacy/XSS
// assertions cannot pass merely because the parser silently removed them.
type Handler = (event: any) => void;
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#(?:39|x27);/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
class FixtureElement {
  attributes: Record<string, string> = {};
  children: FixtureElement[] = [];
  parentNode: FixtureElement | null = null;
  style: Record<string, string> = {};
  listeners: Record<string, Handler[]> = {};
  dataset: Record<string, string>;
  private text = "";
  private input: string | undefined;
  scrollTop = 0;
  checked = false;
  constructor(public ownerDocument: any, public tagName = "DIV") {
    this.dataset = new Proxy({}, {
      get: (_target, key: string | symbol) => typeof key === "string" ? this.getAttribute("data-" + key.replace(/[A-Z]/g, c => "-" + c.toLowerCase())) ?? undefined : undefined,
      set: (_target, key: string, value) => { this.setAttribute("data-" + key.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), String(value)); return true; },
    });
  }
  get id() { return this.attributes.id || ""; }
  set id(value: string) { this.attributes.id = value; }
  get className() { return this.attributes.class || ""; }
  set className(value: string) { this.attributes.class = value; }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
    toggle: (name: string, force?: boolean) => { const add = force ?? !this.classList.contains(name); if (add) this.classList.add(name); else this.classList.remove(name); return add; },
  };
  get parentElement() { return this.parentNode; }
  get nextSibling(): FixtureElement | null { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get childNodes() { return this.children; }
  get nodeType() { return this.tagName === "#TEXT" ? 3 : 1; }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children.find(c => c.tagName !== "#TEXT") || null; }
  get options() { return this.querySelectorAll("option"); }
  get selectedIndex() { return this.options.findIndex(o => o.value === this.value); }
  set selectedIndex(value: number) { this.value = this.options[value]?.value || ""; }
  get value(): string { return this.input ?? (this.tagName === "SELECT" ? this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value ?? "" : ""); }
  set value(value: string | number) { this.input = String(value); }
  get disabled() { return this.attributes.disabled !== undefined; }
  set disabled(value: boolean) { if (value) this.attributes.disabled = ""; else delete this.attributes.disabled; }
  get open() { return this.attributes.open !== undefined; }
  set open(value: boolean) { if (value) this.attributes.open = ""; else delete this.attributes.open; }
  get hidden() { return this.attributes.hidden !== undefined; }
  set hidden(value: boolean) { if (value) this.attributes.hidden = ""; else delete this.attributes.hidden; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(""); }
  set textContent(value: string) { this.text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  get innerHTML(): string { return escape(this.text) + this.children.map(c => c.tagName === "#TEXT" ? escape(c.textContent)
    : "<" + c.tagName.toLowerCase() + Object.entries(c.attributes).map(([k, v]) => ` ${k}="${escape(v)}"`).join("") + ">" + c.innerHTML + "</" + c.tagName.toLowerCase() + ">").join(""); }
  set innerHTML(value: string) { this.textContent = ""; if (this.tagName === "SELECT") this.input = undefined; parseInto(String(value), this); }
  appendChild(child: FixtureElement) {
    if (child.tagName === "#FRAGMENT") { for (const c of [...child.children]) this.appendChild(c); return child; }
    child.parentNode?.removeChild(child); child.parentNode = this; this.children.push(child); return child;
  }
  insertBefore(child: FixtureElement, before: FixtureElement | null) { this.appendChild(child); if (before) { this.children.pop(); this.children.splice(this.children.indexOf(before), 0, child); } return child; }
  removeChild(child: FixtureElement) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; }
  replaceChildren(...children: FixtureElement[]) { this.textContent = ""; for (const child of children) this.appendChild(child); }
  remove() { this.parentNode?.removeChild(this); }
  insertAdjacentHTML(position: string, html: string) {
    const fragment = new FixtureElement(this.ownerDocument, "#FRAGMENT"); parseInto(html, fragment);
    if (position === "afterbegin") for (const child of [...fragment.children].reverse()) this.insertBefore(child, this.firstChild);
    else if (position === "beforeend") this.appendChild(fragment);
    else throw new Error("Unmodeled DOM insertion " + position);
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = String(value);
    if (key === "style") for (const rule of String(value).split(";")) {
      const colon = rule.indexOf(":");
      if (colon >= 0) this.style[rule.slice(0, colon).trim().replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = rule.slice(colon + 1).trim();
    }
  }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  removeAttribute(key: string) { delete this.attributes[key]; }
  contains(child: FixtureElement): boolean { return child === this || this.children.some(c => c.contains(child)); }
  matches(selector: string) { return matches(this, selector, this); }
  closest(selector: string): FixtureElement | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector: string): FixtureElement[] {
    const all = (node: FixtureElement): FixtureElement[] => node.children.flatMap(c => [c, ...all(c)]);
    return all(this).filter(c => c.tagName !== "#TEXT" && matches(c, selector, this));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(key: string, fn: Handler) { (this.listeners[key] ||= []).push(fn); }
  removeEventListener(key: string, fn: Handler) { this.listeners[key] = (this.listeners[key] || []).filter(f => f !== fn); }
  dispatchEvent(event: any) {
    event.target ||= this; event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => { event.cancelBubble = true; }; event.currentTarget = this;
    for (const fn of [...this.listeners[event.type] || []]) fn(event);
    (this as any)["on" + event.type]?.(event);
    if (event.bubbles && !event.cancelBubble) this.parentNode?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true }); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent({ type: "close" }); }
}
function matches(el: FixtureElement, selector: string, scope: FixtureElement): boolean {
  return selector.split(",").some(arm => {
    const parts = arm.trim().match(/(?:\[[^\]]*\]|:not\([^)]*\)|[^ >])+|>/g) || [];
    const simple = (node: FixtureElement, part: string): boolean => {
      let ok = true;
      part = part.replace(/:not\(([^)]*)\)/g, (_all, inner) => { ok &&= !matches(node, inner, scope); return ""; });
      part = part.replace(/:scope|:checked|:disabled/g, pseudo => { ok &&= pseudo === ":scope" ? node === scope : pseudo === ":disabled" ? node.disabled : node.checked; return ""; });
      part = part.replace(/^[\w*-]+/, tag => { ok &&= tag === "*" || node.tagName === tag.toUpperCase(); return ""; });
      part = part.replace(/([.#])([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g, (_all, prefix, name, attr, value) => {
        ok &&= prefix === "." ? node.classList.contains(name) : prefix === "#" ? node.id === name
          : value === undefined ? node.getAttribute(attr) !== null : node.getAttribute(attr) === value;
        return "";
      });
      if (part) throw new Error("Unsupported fixture selector " + selector);
      return ok;
    };
    const visit = (node: FixtureElement | null, index: number): boolean => {
      if (!node || !simple(node, parts[index])) return false;
      if (!index) return true;
      if (parts[index - 1] === ">") return visit(node.parentNode, index - 2);
      for (let parent = node.parentNode; parent; parent = parent.parentNode) if (visit(parent, index - 1)) return true;
      return false;
    };
    return !!parts.length && visit(el, parts.length - 1);
  });
}
function parseInto(html: string, root: FixtureElement) {
  const stack = [root];
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<\/?[a-zA-Z][^>]*>|[^<]+/g)) {
    const token = m[0];
    if (token.startsWith("</")) {
      const tag = /^<\/([\w-]+)/.exec(token)![1].toUpperCase();
      const index = stack.map(node => node.tagName).lastIndexOf(tag); if (index > 0) stack.splice(index);
    } else if (token.startsWith("<")) {
      const tag = /^<([\w-]+)/.exec(token)![1].toUpperCase(), el = new FixtureElement(root.ownerDocument, tag);
      for (const a of token.matchAll(/\s([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
      el.checked = el.attributes.checked !== undefined;
      if (el.attributes.value !== undefined) el.value = el.attributes.value;
      stack[stack.length - 1].appendChild(el);
      if (!/^(INPUT|META|LINK|BR|HR|IMG|AREA|BASE|COL|EMBED|PARAM|SOURCE|TRACK|WBR)$/.test(tag) && !token.endsWith("/>")) stack.push(el);
    } else {
      const text = new FixtureElement(root.ownerDocument, "#TEXT"); text.textContent = decode(token); stack[stack.length - 1].appendChild(text);
    }
  }
}
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function failOnUnknown<T extends object>(obj: T, prefix: string): T {
  return new Proxy(obj, { get(target, key, receiver) {
    if (typeof key === "symbol" || key === "then") return Reflect.get(target, key, receiver);
    if (!(key in target)) throw new Error("Unmodeled API capability " + prefix + "." + key);
    return Reflect.get(target, key, receiver);
  } });
}
function inspectSurface(value: unknown): string {
  return JSON.stringify(value, (_key, item) => Object.prototype.toString.call(item) === "[object Error]" ? { message: item.message, stack: item.stack, code: item.code } : item);
}
function harness(language = "en-US") {
  const document: any = {}, root = new FixtureElement(document, "#DOCUMENT"), events: Record<string, Handler[]> = {};
  // Static script/style resources are deliberately not executed by the fixture.
  parseInto(HTML.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ""), root);
  Object.assign(document, {
    readyState: "loading", getElementById: (id: string) => root.querySelector("#" + id),
    querySelector: (selector: string) => root.querySelector(selector), querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    createElement: (tag: string) => new FixtureElement(document, tag.toUpperCase()), createDocumentFragment: () => new FixtureElement(document, "#FRAGMENT"),
    createTextNode: (text: string) => { const el = new FixtureElement(document, "#TEXT"); el.textContent = text; return el; },
    addEventListener: (name: string, fn: Handler) => (events[name] ||= []).push(fn),
    removeEventListener: (name: string, fn: Handler) => { events[name] = (events[name] || []).filter(f => f !== fn); },
    dispatchEvent: (event: any) => (events[event.type] || []).forEach(fn => fn(event)),
  });
  document.body = document.querySelector("body"); document.documentElement = document.querySelector("html"); document.activeElement = document.body;
  const memory = new Map<string, string>(), writes: Array<{ key: string; value: string }> = [], downloads: Blob[] = [];
  const consoleSpy = { debug: vi.fn(), log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const forbidden = vi.fn((..._args: any[]): never => { throw new Error("NETWORK_FIXTURE_FORBIDS_ACTIVE_SIDE_EFFECT"); });
  const order: string[] = [], armedListeners = new Set<(event: Armed) => void>();
  const subscriptions: Array<{ callback: (event: Armed) => void; unsubscribe: ReturnType<typeof vi.fn> }> = [];
  const api = failOnUnknown({
    observability: failOnUnknown({ timing: vi.fn(async () => undefined), counter: vi.fn(async () => undefined), log: vi.fn(async () => undefined) }, "observability"),
    browser: failOnUnknown({
      list: vi.fn(async (): Promise<any[]> => structuredClone([PROFILE_A, PROFILE_B, PROFILE_C])),
      binary: vi.fn(async (): Promise<any> => ({ installed: true, version: "synthetic-engine", installedVersions: [] })),
      engineStatus: vi.fn(async (): Promise<any> => ({ firefox: { installed: true } })), status: vi.fn(async () => ({ running: true })),
      networkPages: vi.fn(async (dirId: string): Promise<any> => ({ ok: true, pages: [{ handle: dirId === PROFILE_B.dirId ? HANDLE_B : HANDLE_A, origin: dirId === PROFILE_B.dirId ? ORIGIN_B : ORIGIN_A, ordinal: 1 }] })),
      networkObserve: vi.fn(async (_dirId: string, opts: any): Promise<any> => { order.push("invoke"); return reply(opts.requestId); }),
      onNetworkArmed: vi.fn((callback: (event: Armed) => void) => {
        order.push("subscribe"); armedListeners.add(callback);
        const unsubscribe = vi.fn(() => { armedListeners.delete(callback); }); subscriptions.push({ callback, unsubscribe }); return unsubscribe;
      }),
      healthHistory: vi.fn(async (_dirId: string): Promise<any> => ({ entries: [] })),
      healthCancel: vi.fn(async (_dirId: string, _opts?: any): Promise<any> => ({ success: true, cancelled: true })),
      healthClear: vi.fn(async (_dirId: string, _kind?: string): Promise<any> => ({ ok: true })),
      envRisk: vi.fn(async (_dirId: string, _opts?: any): Promise<any> => envReply()),
      envRiskHistory: vi.fn(async (_dirId: string): Promise<any> => ({ ok: true, entries: [] })),
      envRiskClear: vi.fn(async (_dirId: string): Promise<any> => ({ ok: true })),
      checkDrift: vi.fn(async (_dirId: string, _opts?: any): Promise<any> => ({ ok: true, hasBaseline: true, risky: false, drift: [], outcome: "pass" })),
      driftReport: vi.fn(async (_dirId: string): Promise<any> => ({ ok: true, report: null, currentConfigMatches: false, canUpdateBaseline: false })),
      captureBaseline: vi.fn(async (_dirId: string, _opts?: any): Promise<any> => ({ ok: true, risky: false, fields: 9, outcome: "baseline-established" })),
      consistencyCheck: vi.fn(async (_dirId: string, _opts?: any): Promise<any> => ({ ok: true, warnings: [], blockers: [], outcome: "inconclusive" })),
      launch: forbidden, stop: forbidden, navigate: forbidden, openRiskCheck: forbidden, openApp: forbidden,
      setMeta: forbidden, setProxy: forbidden, clearStorage: forbidden, exportProfileArchive: forbidden,
    }, "browser"),
    webrtc: failOnUnknown({ diag: vi.fn(async (_dirId: string, _opts?: any): Promise<any> => rtcReply()),
      diagHistory: vi.fn(async (_dirId: string): Promise<any> => ({ entries: [] })), diagClear: vi.fn(async (_dirId: string): Promise<any> => ({ success: true })),
    }, "webrtc"),
    proxy: failOnUnknown({ list: vi.fn(async (): Promise<any[]> => []) }, "proxy"),
    app: failOnUnknown({ setLanguage: vi.fn(async () => ({ success: true })), version: vi.fn(async () => "synthetic-version") }, "app"),
  }, "api");
  class FixtureURL extends URL {
    static createObjectURL = vi.fn((blob: Blob) => { downloads.push(blob); return "blob:owned-network-fixture"; });
    static revokeObjectURL = vi.fn();
  }
  const window: any = { agentBrowserAPI: api, fetch: forbidden, WebSocket: forbidden, XMLHttpRequest: forbidden, URL: FixtureURL };
  const context = vm.createContext({ window, document, console: consoleSpy, navigator: { language }, Blob, URL: FixtureURL,
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { writes.push({ key, value: String(value) }); memory.set(key, String(value)); }, removeItem: (key: string) => memory.delete(key) },
    fetch: forbidden, WebSocket: forbidden, XMLHttpRequest: forbidden, setTimeout, clearTimeout, Date, Math,
    CustomEvent: function(type: string, options: any) { return { type, ...options }; },
    Option: function(text: string, value: string) { const option = document.createElement("option"); option.textContent = text; option.value = value; return option; },
  });
  vm.runInContext(I18N, context, { filename: "src/renderer/js/i18n.js" });
  for (const name of ["icons", "core", "ipc"]) vm.runInContext(SOURCES[name], context, { filename: `src/renderer/js/app/${name}.js` });
  const app: any = window.agentBrowser;
  app.helpers.toast = vi.fn(); app.state.currentTab = "profiles";
  app.confirm = vi.fn(); app.confirmHtml = vi.fn(); app.refresh = vi.fn();
  app.renderViewState = vi.fn((el: FixtureElement, options: any) => { el.textContent = options.error || options.empty || options.loading || ""; });
  for (const name of ["fingerprint-drift", "profiles"]) vm.runInContext(SOURCES[name], context, { filename: `src/renderer/js/app/${name}.js` });
  const el = (id: string): FixtureElement => { const found = document.getElementById(id); if (!found) throw new Error("Missing feature-contract production HTML element " + id); return found; };
  const call = (name: string, ...args: any[]) => { expect(typeof app[name], "Production renderer global " + name).toBe("function"); return app[name](...args); };
  const command = (id: string) => { const control = el(id); expect(control.disabled, id + " must be enabled for this action").toBe(false); expect(control.dataset.role).toBe("cmd"); return call(control.dataset.cmd); };
  const card = (id = PROFILE_A.dirId) => el("profile-list").querySelector(`[data-dir-id="${id}"]`)!;
  const badge = (id = PROFILE_A.dirId) => card(id)?.querySelector(".health-verdict")!;
  const menu = (value: string, id = PROFILE_A.dirId) => {
    const control = card(id).querySelector('[data-action="health"]')!; control.value = value;
    (el("profile-list") as any).onchange({ target: control });
  };
  const render = async () => { app.loadProfiles(true); await flush(); expect(card(), el("profile-list").textContent).toBeTruthy(); };
  const open = async (id = PROFILE_A.dirId) => { call("openNetworkDiagnostics", id); await flush(); };
  const dialog = () => el("dlg-network-observation");
  const body = () => el("network-observation-body");
  const phase = () => el("network-observation-status").getAttribute("data-network-phase");
  const choose = (handle = HANDLE_A) => {
    const select = el("network-page-select"); expect(select.querySelectorAll("option").some(option => option.value === handle), "Only an actual returned selection handle may be chosen").toBe(true);
    select.value = handle; expect(select.getAttribute("data-role")).toBe("change"); expect(select.getAttribute("data-change-cmd")).toBe("networkPageChanged"); call("networkPageChanged");
  };
  const emit = (event: any) => { for (const listener of [...armedListeners]) listener(event); };
  const arm = (requestId: string, dirId = PROFILE_A.dirId) => emit({ dirId, requestId, armedAt: AT, observeForMs: 10_000 });
  const begin = async (id = PROFILE_A.dirId, armed = false) => {
    const pending = deferred(); api.browser.networkObserve.mockReturnValueOnce(pending.promise);
    await open(id); choose(id === PROFILE_B.dirId ? HANDLE_B : HANDLE_A);
    const before = api.browser.networkObserve.mock.calls.length; command("network-observation-start"); await flush();
    expect(api.browser.networkObserve).toHaveBeenCalledTimes(before + 1);
    const [dirId, opts] = api.browser.networkObserve.mock.calls.at(-1)!;
    if (armed) arm(opts.requestId, dirId);
    return { pending, dirId, requestId: opts.requestId as string, subscription: subscriptions.at(-1)! };
  };
  const authority = (entries: any[], dirId = PROFILE_A.dirId) => api.browser.healthHistory.mockImplementation(async (id: string) => ({ entries: structuredClone(id === dirId ? entries : []) }));
  const historyView = async (id = PROFILE_A.dirId) => {
    const before = app.confirmHtml.mock.calls.length; menu("history", id); await flush(); expect(app.confirmHtml).toHaveBeenCalledTimes(before + 1);
    const fragment = new FixtureElement(document); fragment.innerHTML = app.confirmHtml.mock.calls.at(-1)[2].detailHtml; return fragment;
  };
  const clear = async () => {
    const before = app.confirm.mock.calls.length; command("network-observation-clear"); expect(app.confirm).toHaveBeenCalledTimes(before + 1);
    app.confirm.mock.calls.at(-1)[1](); await flush();
  };
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
  const cache = () => JSON.parse(memory.get(HEALTH_KEY) || "{}");
  const cacheWrites = () => writes.filter(write => write.key === HEALTH_KEY);
  const t = (key: string) => { const value = window.i18n.t(key, "__MISSING_NETWORK_COPY__"); expect(value, key).not.toBe("__MISSING_NETWORK_COPY__"); return value as string; };
  const captured = () => inspectSurface({ console: Object.values(consoleSpy).flatMap(spy => spy.mock.calls), observability: api.observability.log.mock.calls, toasts: app.helpers.toast.mock.calls, confirmations: [...app.confirm.mock.calls, ...app.confirmHtml.mock.calls] });
  return { app, api, window, document, memory, writes, downloads, consoleSpy, forbidden, order, subscriptions, armedListeners,
    el, call, command, card, badge, menu, render, open, dialog, body, phase, choose, emit, arm, begin, authority, historyView, clear, tick, cache, cacheWrites, t, captured, toast: app.helpers.toast };
}
type Harness = ReturnType<typeof harness>;
function noGreen(root: FixtureElement) {
  expect(root.querySelector('[data-health-outcome="pass"]')).toBeNull();
  expect(root.querySelector(".health-good, .health-text-good, .status-pass, .status-done")).toBeNull();
  for (const node of [root, ...root.querySelectorAll("*")]) expect(node.style.color || "").not.toMatch(/var\(--success(?:-text)?\)|#(?:0[0-9a-f]0|008000)\b/i);
  expect(root.textContent).not.toMatch(/\bPASS\b|\bPass\b|网站健康检查通过|代理健康检查通过/);
}
function noTransientDetails(h: Harness) {
  expect(h.dialog().innerHTML).not.toContain(ORIGIN_A); expect(h.dialog().innerHTML).not.toContain(OTHER_ORIGIN);
  expect(h.dialog().innerHTML).not.toContain(HANDLE_A); expect(h.dialog().innerHTML).not.toContain("hop-1");
}
function safeCacheWrites(h: Harness) {
  for (const write of h.cacheWrites()) {
    const all = JSON.parse(write.value);
    for (const entries of Object.values(all) as any[]) {
      expect(Array.isArray(entries)).toBe(true);
      for (const entry of entries) { expect(OLD_KINDS).toContain(entry.kind); expect(entry).not.toHaveProperty("networkSummary"); }
    }
    expect(write.value).not.toContain(SECRET); expect(write.value).not.toContain(SUMMARY_CODE);
    expect(write.value).not.toContain(ORIGIN_A); expect(write.value).not.toContain(OTHER_ORIGIN);
  }
}
function poisonedCache() {
  return {
    [PROFILE_A.dirId]: [
      { ...canonical(), at: AT + 100_000, outcome: "pass", detail: SECRET, origin: ORIGIN_A, hops: [hop()] },
      { kind: "future-health-kind", at: AT + 200_000, detail: SECRET, outcome: "pass" },
      { kind: "env", at: AT - 1000, outcome: "warn", detail: "keep legacy environment row" },
      { kind: "drift", at: AT - 2000, verdict: "risk", detail: "keep legacy drift row" },
    ],
    [PROFILE_B.dirId]: [
      { ...canonical(), detail: SECRET, origin: OTHER_ORIGIN },
      { kind: "webrtc", at: AT - 3000, verdict: "unavailable", detail: "keep B legacy RTC row" },
    ],
    [PROFILE_C.dirId]: [{ kind: "consistency", at: AT - 4000, detail: "keep C legacy alignment row" }],
  };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AT); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("selected-page network UI feature contract (whole production modules)", () => {
  it("adds one network entry to the existing health menu without removing the old actions", async () => {
    const h = harness(); await h.render();
    const control = h.card().querySelector('[data-action="health"]')!;
    const values = control.querySelectorAll("option").map(option => option.value);
    expect(values.filter(value => value === "network")).toHaveLength(1);
    expect(values.filter(value => value !== "network")).toEqual(["", "drift", "drift-details", "lock", "consistency", "env", "webrtc", "risk", "history", "reset"]);
    expect(control.getAttribute("aria-label")).toBeTruthy();
    h.menu("network"); await flush();
    expect(h.dialog().open).toBe(true); expect(control.value).toBe("");
    expect(h.api.browser.networkPages).toHaveBeenCalledWith(PROFILE_A.dirId);
    expect(h.api.browser.networkObserve).not.toHaveBeenCalled();
  });

  it("opens/refreshes/selects without observing, launching, navigating, fetching or subscribing", async () => {
    const h = harness(); await h.render(); expect(h.api.browser.networkPages).not.toHaveBeenCalled();
    await h.open(); expect(h.el("network-page-select").value).toBe(""); expect(h.el("network-observation-start").disabled).toBe(true);
    h.choose(); expect(h.el("network-observation-start").disabled).toBe(false);
    h.command("network-page-refresh"); await flush(); expect(h.el("network-page-select").value).toBe("");
    expect(h.el("network-observation-start").disabled).toBe(true); await h.tick(31_001);
    expect(h.api.browser.networkPages).toHaveBeenCalledTimes(2); expect(h.api.browser.networkObserve).not.toHaveBeenCalled();
    expect(h.api.browser.onNetworkArmed).not.toHaveBeenCalled(); expect(h.api.browser.healthCancel).not.toHaveBeenCalled();
    expect(h.app.confirm).not.toHaveBeenCalled(); expect(h.app.confirmHtml).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("requires an explicit choice even when the only returned page is otherwise usable", async () => {
    const h = harness(); await h.open(); h.call("startNetworkObservation"); await flush();
    expect(h.api.browser.networkObserve).not.toHaveBeenCalled();
    h.choose(); const run = deferred(); h.api.browser.networkObserve.mockReturnValue(run.promise);
    h.command("network-observation-start"); await flush();
    const [dirId, opts] = h.api.browser.networkObserve.mock.calls[0];
    expect(dirId).toBe(PROFILE_A.dirId); expect(Object.keys(opts).sort()).toEqual(["requestId", "selection"]);
    expect(opts.selection).toBe(HANDLE_A); expect(opts.requestId).toMatch(/^health-network-/);
    expect(inspectSurface(opts)).not.toContain(ORIGIN_A); expect(h.forbidden).not.toHaveBeenCalled();
    run.resolve(reply(opts.requestId, unavailable(), [], { ok: false, outcome: "unavailable" })); await flush();
  });

  it("empty page inventory leaves Start disabled, does not record a health sample or offer auto-launch", async () => {
    const h = harness(); h.api.browser.networkPages.mockResolvedValue({ ok: true, pages: [] }); await h.open();
    h.call("startNetworkObservation"); await flush(); expect(h.el("network-observation-start").disabled).toBe(true);
    expect(h.dialog().textContent).toContain(h.t("network.pages.empty")); noGreen(h.dialog());
    expect(h.api.browser.networkObserve).not.toHaveBeenCalled(); expect(h.cacheWrites()).toEqual([]);
    expect(h.forbidden).not.toHaveBeenCalled(); expect(h.app.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["firefox", true, "NETWORK_ENGINE_UNSUPPORTED"], ["unknown", true, "NETWORK_ENGINE_UNSUPPORTED"],
    ["chromium", false, "NETWORK_RUNTIME_UNAVAILABLE"], ["chromium", true, "NETWORK_RUNTIME_UNAVAILABLE"],
  ])("keeps %s running=%s / %s unsupported or unavailable without attempting recovery", async (engine, running, code) => {
    const h = harness(); h.api.browser.list.mockResolvedValue([{ ...PROFILE_A, engine, running }]);
    h.api.browser.networkPages.mockResolvedValue({ ok: false, outcome: "unavailable", code, pages: [], error: PRIVATE_URL });
    await h.render(); await h.open(); h.call("startNetworkObservation"); await flush();
    expect(h.el("network-observation-start").disabled).toBe(true); noGreen(h.dialog());
    expect(h.dialog().textContent).toContain(h.t("network.unavailable")); expect(h.dialog().innerHTML).not.toContain(SECRET);
    expect(h.api.browser.networkObserve).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled();
    expect(h.app.confirm).not.toHaveBeenCalled(); expect(h.captured()).not.toContain(SECRET);
  });

  it.each(NETWORK_FAILURE_CASES)("maps finalized code %s to specific localized guidance without raw prose", async (code, key) => {
    const h = harness(); h.api.browser.networkPages.mockResolvedValue({ ok: false, outcome: "unavailable", code, pages: [], error: PRIVATE_URL }); await h.open();
    expect(h.dialog().textContent).toContain(h.t(key)); expect(h.dialog().innerHTML).not.toContain(SECRET); expect(h.dialog().textContent).not.toContain(code);
    expect(h.captured()).not.toContain(SECRET); expect(h.api.browser.networkObserve).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled(); noGreen(h.dialog());
  });

  it("unknown backend codes remain generic unavailable rather than exposing their raw value", async () => {
    const h = harness(); h.api.browser.networkPages.mockResolvedValue({ ok: false, outcome: "unavailable", code: `NETWORK_${SECRET}`, pages: [], error: PRIVATE_URL }); await h.open();
    expect(h.dialog().textContent).toContain(h.t("network.unavailable")); expect(h.dialog().innerHTML).not.toContain(SECRET); expect(h.captured()).not.toContain(SECRET); noGreen(h.dialog());
  });

  it("distinguishes same-origin pages by ordinal and opaque handle, not origin as target identity", async () => {
    const h = harness(), pending = deferred();
    h.api.browser.networkPages.mockResolvedValue({ ok: true, pages: [
      { handle: HANDLE_A, origin: ORIGIN_A, ordinal: 1 }, { handle: "same-origin-second-page", origin: ORIGIN_A, ordinal: 2 },
    ] });
    await h.open(); const options = h.el("network-page-select").querySelectorAll("option").filter(option => option.value);
    expect(options).toHaveLength(2); expect(options[0].textContent).toContain("1"); expect(options[1].textContent).toContain("2");
    h.choose("same-origin-second-page"); h.api.browser.networkObserve.mockReturnValue(pending.promise); h.command("network-observation-start"); await flush();
    const opts = h.api.browser.networkObserve.mock.calls[0][1]; expect(opts).toEqual({ selection: "same-origin-second-page", requestId: expect.any(String) });
    pending.resolve(reply(opts.requestId)); await flush();
  });

  it("a successful run consumes its selection without auto-refresh or reusing that handle", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true); run.pending.resolve(reply(run.requestId)); await flush();
    const beforePages = h.api.browser.networkPages.mock.calls.length; h.call("startNetworkObservation"); await flush(); await h.tick(31_001);
    expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1); expect(h.api.browser.networkPages).toHaveBeenCalledTimes(beforePages);
    expect(h.el("network-observation-start").disabled).toBe(true);
    h.api.browser.networkPages.mockResolvedValue({ ok: true, pages: [{ handle: "fresh-after-completion", origin: ORIGIN_A, ordinal: 1 }] });
    h.command("network-page-refresh"); await flush(); expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1);
    h.choose("fresh-after-completion"); h.command("network-observation-start"); await flush();
    expect(h.api.browser.networkObserve.mock.calls[1][1].selection).toBe("fresh-after-completion"); expect(h.api.browser.networkObserve.mock.calls[1][1].requestId).not.toBe(run.requestId);
  });

  it("an expired/consumed handle requires explicit refresh and reselect, not an automatic retry", async () => {
    const h = harness(); h.api.browser.networkObserve.mockImplementation(async (_id, opts) => reply(opts.requestId, unavailable(), [], { ok: false, outcome: "unavailable", code: "NETWORK_SELECTION_STALE" }));
    // A backend expiry can race an otherwise fresh-looking selector. The UI
    // must not retry it; the backend suite owns proof of the exact 30s TTL.
    await h.open(); h.choose(); h.command("network-observation-start"); await flush(); await h.tick(30_001);
    expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1); expect(h.api.browser.networkPages).toHaveBeenCalledTimes(1);
    expect(h.el("network-page-select").value).toBe(""); expect(h.el("network-observation-start").disabled).toBe(true);
    expect(h.dialog().textContent).toContain(h.t("network.selection-expired")); h.call("startNetworkObservation"); await flush();
    expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1);
    h.api.browser.networkPages.mockResolvedValue({ ok: true, pages: [{ handle: "fresh-explicit-handle", origin: ORIGIN_A, ordinal: 1 }] });
    h.command("network-page-refresh"); await flush(); expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1);
    h.choose("fresh-explicit-handle"); h.command("network-observation-start"); await flush();
    expect(h.api.browser.networkObserve.mock.calls[1][1].selection).toBe("fresh-explicit-handle");
    expect(h.api.browser.networkObserve.mock.calls[1][1].requestId).not.toBe(h.api.browser.networkObserve.mock.calls[0][1].requestId);
  });
});

describe("network armed correlation, epochs, cancellation and shared health slots", () => {
  it("subscribes before invoke and displays setup, never observing10s, until the exact armed event", async () => {
    const h = harness(), pending = deferred();
    h.api.browser.networkObserve.mockImplementation((_id, _opts) => { h.order.push("invoke"); expect(h.armedListeners.size).toBe(1); return pending.promise; });
    await h.open(); h.choose(); h.command("network-observation-start"); await flush();
    const requestId = h.api.browser.networkObserve.mock.calls[0][1].requestId;
    expect(h.order).toEqual(["subscribe", "invoke"]); expect(h.phase()).toBe("setup");
    expect(h.el("network-observation-status").textContent).toContain(h.t("network.setup"));
    for (const event of [
      { dirId: PROFILE_B.dirId, requestId, armedAt: AT, observeForMs: 10_000 },
      { dirId: PROFILE_A.dirId, requestId: "wrong-run", armedAt: AT, observeForMs: 10_000 },
      { dirId: PROFILE_A.dirId, armedAt: AT, observeForMs: 10_000 },
      { dirId: PROFILE_A.dirId, requestId, armedAt: AT, observeForMs: 9999 },
      { dirId: PROFILE_A.dirId, requestId, armedAt: NaN, observeForMs: 10_000 },
    ]) { h.emit(event); expect(h.phase()).toBe("setup"); }
    await h.tick(6000); expect(h.phase()).toBe("setup");
    h.arm(requestId); expect(h.phase()).toBe("observing10s");
    expect(h.el("network-observation-status").textContent).toContain(h.t("network.observing10s"));
    const before = h.dialog().innerHTML; h.arm(requestId); expect(h.dialog().innerHTML).toBe(before);
    pending.resolve(reply(requestId)); await flush(); expect(h.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.armedListeners.size).toBe(0); expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "cancel"])("%s before the invoke microtask cannot start late work or cancel another request", async action => {
    const h = harness(); await h.open(); h.choose(); h.command("network-observation-start");
    if (action === "close") h.dialog().close(); else h.call("cancelNetworkObservation");
    h.app.checkDrift(PROFILE_A.dirId); expect(h.api.browser.checkDrift).not.toHaveBeenCalled(); await flush();
    expect(h.api.browser.networkObserve).not.toHaveBeenCalled(); expect(h.api.browser.healthCancel).not.toHaveBeenCalled();
    expect(h.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1); noTransientDetails(h);
    h.app.checkDrift(PROFILE_A.dirId); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledTimes(1);
  });

  it("does not invoke an observation if the armed subscriber cannot be attached, and releases only that unstarted UI request", async () => {
    const h = harness(); h.api.browser.onNetworkArmed.mockImplementation(() => { throw new Error(PRIVATE_URL); });
    await h.open(); h.choose(); h.command("network-observation-start"); await flush();
    expect(h.api.browser.networkObserve).not.toHaveBeenCalled(); expect(h.phase()).not.toBe("observing10s"); noGreen(h.dialog());
    expect(h.dialog().innerHTML).not.toContain(SECRET); expect(h.captured()).not.toContain(SECRET); expect(h.cacheWrites()).toEqual([]);
    h.app.checkDrift(PROFILE_A.dirId); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledTimes(1);
  });

  it("unconfirmed cancellation is not a stop or an early slot release, even when the cancel reply contains raw text", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    h.api.browser.healthCancel.mockResolvedValue({ success: false, cancelled: false, error: PRIVATE_URL }); h.toast.mockClear();
    h.command("network-observation-cancel"); await flush(); noTransientDetails(h); h.app.checkDrift(PROFILE_A.dirId); await flush();
    expect(h.api.browser.checkDrift).not.toHaveBeenCalled(); expect(h.toast.mock.calls.some((args: any[]) => args[1] === "success")).toBe(false);
    expect(h.toast.mock.calls.some((args: any[]) => args[0].includes(h.t("health.cancel-not-confirmed")))).toBe(true);
    expect(h.captured()).not.toContain(SECRET); run.pending.resolve(reply(run.requestId)); await flush();
    h.app.checkDrift(PROFILE_A.dirId); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledTimes(1);
  });

  it("does not lose an armed notification delivered synchronously inside the awaited invoke", async () => {
    const h = harness(), pending = deferred();
    h.api.browser.networkObserve.mockImplementation((dirId, opts) => { h.arm(opts.requestId, dirId); return pending.promise; });
    await h.open(); h.choose(); h.command("network-observation-start"); await flush(); expect(h.phase()).toBe("observing10s");
    pending.resolve(reply(h.api.browser.networkObserve.mock.calls[0][1].requestId)); await flush();
  });

  it.each([undefined, "different-result-request"])("rejects a final reply with missing/mismatched requestId %s", async receivedId => {
    const h = harness(); await h.render(); const run = await h.begin(PROFILE_A.dirId, true);
    run.pending.resolve(reply(receivedId as any, summary(), [hop({ origin: "https://rejected-response.fixture.test" })])); await flush();
    expect(h.dialog().innerHTML).not.toContain("rejected-response.fixture.test"); expect(h.dialog().textContent).not.toContain(h.t("network.no-errors"));
    expect(h.badge().getAttribute("data-health-outcome")).not.toBe("pass"); expect(h.cacheWrites()).toEqual([]);
    expect(run.subscription.unsubscribe).toHaveBeenCalledTimes(1); h.app.checkDrift(PROFILE_A.dirId); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledTimes(1);
  });

  it("shares the one-per-profile lock with env/RTC/drift but the chooser alone does not consume a slot", async () => {
    const h = harness(), env = deferred(); await h.open(); h.api.browser.envRisk.mockReturnValue(env.promise); h.app.openEnvRisk(PROFILE_A.dirId); await flush();
    expect(h.api.browser.envRisk).toHaveBeenCalledTimes(1); h.choose(); h.call("startNetworkObservation"); await flush(); expect(h.api.browser.networkObserve).not.toHaveBeenCalled();
    env.resolve(envReply()); await flush(); const run = deferred(); h.api.browser.networkObserve.mockReturnValue(run.promise);
    h.call("startNetworkObservation"); await flush(); expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1);
    h.call("startNetworkObservation"); h.app.openEnvRisk(PROFILE_A.dirId); h.app.openWebRtcDiag(PROFILE_A.dirId); h.app.checkDrift(PROFILE_A.dirId); await flush();
    expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1); expect(h.api.browser.envRisk).toHaveBeenCalledTimes(1);
    expect(h.api.webrtc.diag).not.toHaveBeenCalled(); expect(h.api.browser.checkDrift).not.toHaveBeenCalled();
    run.resolve(reply(h.api.browser.networkObserve.mock.calls[0][1].requestId)); await flush();
  });

  it("retains both global UI slots after close/cancel acknowledgement and ordinary IPC timeout", async () => {
    const h = harness(), rtc = deferred(), cancel = deferred(); const run = await h.begin();
    h.api.webrtc.diag.mockReturnValue(rtc.promise); h.app.openWebRtcDiag(PROFILE_B.dirId); await flush(); h.api.browser.healthCancel.mockReturnValue(cancel.promise);
    h.dialog().close(); await flush(); expect(h.api.browser.healthCancel).toHaveBeenCalledWith(PROFILE_A.dirId, { kind: "network", requestId: run.requestId });
    cancel.resolve({ success: true, cancelled: true }); await flush(); await h.tick(21_000);
    h.app.openEnvRisk(PROFILE_C.dirId); h.app.checkDrift(PROFILE_A.dirId); await flush();
    expect(h.api.browser.envRisk).not.toHaveBeenCalled(); expect(h.api.browser.checkDrift).not.toHaveBeenCalled();
    // This awaited result is the backend's work-plus-cleanup settlement, not the
    // cancel acknowledgement or a renderer timeout freeing an imaginary job.
    run.pending.resolve(reply(run.requestId, partial({ completion: "cancelled", stopReason: "cancelled" }), [], { ok: false, outcome: "cancelled" })); await flush();
    h.app.openEnvRisk(PROFILE_C.dirId); await flush(); expect(h.api.browser.envRisk).toHaveBeenCalledTimes(1);
    rtc.resolve(rtcReply()); await flush(); expect(h.forbidden).not.toHaveBeenCalled();
  });

  it.each([false, true])("cancel during armed=%s clears details, unsubscribes, fences late delivery and cancels only the owned request", async armed => {
    const h = harness(); await h.render(); const run = await h.begin(PROFILE_A.dirId, armed);
    h.command("network-observation-cancel"); await flush(); h.call("cancelNetworkObservation"); await flush();
    expect(h.api.browser.healthCancel).toHaveBeenCalledTimes(1); expect(h.api.browser.healthCancel).toHaveBeenCalledWith(PROFILE_A.dirId, { kind: "network", requestId: run.requestId });
    expect(h.el("network-observation-cancel").disabled).toBe(true); expect(run.subscription.unsubscribe).toHaveBeenCalledTimes(1); noTransientDetails(h);
    const before = h.dialog().innerHTML; run.subscription.callback({ dirId: PROFILE_A.dirId, requestId: run.requestId, armedAt: AT, observeForMs: 10_000 });
    run.pending.resolve(reply(run.requestId)); await flush(); expect(h.dialog().innerHTML).toBe(before); expect(h.phase()).not.toBe("observing10s");
    expect(h.cacheWrites()).toEqual([]); expect(h.armedListeners.size).toBe(0); expect(run.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    h.app.checkDrift(PROFILE_A.dirId); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledTimes(1); expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("close/Escape cancels once, clears selector/detail memory and cannot rehydrate on reopen from a stale subscription", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    h.dialog().dispatchEvent({ type: "cancel" }); h.dialog().close(); await flush(); noTransientDetails(h);
    expect(h.api.browser.healthCancel).toHaveBeenCalledTimes(1); expect(run.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    const before = h.dialog().innerHTML; run.pending.resolve(reply(run.requestId)); await flush(); expect(h.dialog().innerHTML).toBe(before);
    await h.open(); expect(h.el("network-page-select").value).toBe("");
    run.subscription.callback({ dirId: PROFILE_A.dirId, requestId: run.requestId, armedAt: AT, observeForMs: 10_000 });
    expect(h.phase()).not.toBe("observing10s"); expect(h.body().innerHTML).not.toContain(OTHER_ORIGIN);
    h.dialog().close(); await flush(); expect(h.api.browser.healthCancel).toHaveBeenCalledTimes(1);
  });

  it("a chooser without an owned observation never issues a broad or cross-profile cancel", async () => {
    const h = harness(); await h.open(); h.call("cancelNetworkObservation"); h.dialog().close(); await flush();
    expect(h.api.browser.healthCancel).not.toHaveBeenCalled(); expect(h.api.browser.networkObserve).not.toHaveBeenCalled(); noTransientDetails(h);
  });

  it("profile replacement fences A's armed/result while accepting B's own identity and releasing only A's old slot", async () => {
    const h = harness(); const a = await h.begin(PROFILE_A.dirId, true); const b = await h.begin(PROFILE_B.dirId);
    expect(a.requestId).not.toBe(b.requestId); expect(h.api.browser.healthCancel).toHaveBeenCalledTimes(1);
    expect(h.api.browser.healthCancel).toHaveBeenCalledWith(PROFILE_A.dirId, { kind: "network", requestId: a.requestId });
    a.subscription.callback({ dirId: PROFILE_A.dirId, requestId: a.requestId, armedAt: AT, observeForMs: 10_000 }); expect(h.phase()).toBe("setup");
    h.emit({ dirId: PROFILE_A.dirId, requestId: b.requestId, armedAt: AT, observeForMs: 10_000 }); expect(h.phase()).toBe("setup");
    h.arm(b.requestId, PROFILE_B.dirId); expect(h.phase()).toBe("observing10s"); const before = h.dialog().innerHTML;
    a.pending.resolve(reply(a.requestId, summary(), [hop({ origin: "https://late-a.fixture.test" })])); await flush(); expect(h.dialog().innerHTML).toBe(before);
    h.app.openEnvRisk(PROFILE_B.dirId); await flush(); expect(h.api.browser.envRisk).not.toHaveBeenCalled();
    b.pending.resolve(reply(b.requestId, summary(), [hop({ origin: "https://current-b.fixture.test" })])); await flush();
    expect(h.body().textContent).toContain("https://current-b.fixture.test"); expect(h.body().innerHTML).not.toContain("late-a.fixture.test");
    expect(a.subscription.unsubscribe).toHaveBeenCalledTimes(1); expect(b.subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("late selector results cannot replace a newer refresh, another profile or a closed view", async () => {
    const h = harness(), old = deferred(), newer = deferred();
    h.api.browser.networkPages.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    await h.open(); h.call("refreshNetworkPages"); await flush();
    newer.resolve({ ok: true, pages: [{ handle: "refreshed-handle", origin: ORIGIN_A, ordinal: 2 }] }); await flush();
    old.resolve({ ok: true, pages: [{ handle: "stale-handle", origin: "https://stale-selector.fixture.test", ordinal: 1 }] }); await flush();
    expect(h.el("network-page-select").innerHTML).toContain("refreshed-handle"); expect(h.dialog().innerHTML).not.toContain("stale-selector.fixture.test");
    const late = deferred(); h.api.browser.networkPages.mockReturnValueOnce(late.promise); await h.open(); await h.open(PROFILE_B.dirId);
    late.resolve({ ok: true, pages: [{ handle: HANDLE_A, origin: "https://late-profile-a.fixture.test", ordinal: 1 }] }); await flush();
    expect(h.dialog().innerHTML).not.toContain("late-profile-a.fixture.test"); expect(h.el("network-page-select").textContent).toContain(ORIGIN_B);
    const afterClose = deferred(); h.api.browser.networkPages.mockReturnValueOnce(afterClose.promise); h.command("network-page-refresh"); await flush(); h.dialog().close();
    const closed = h.dialog().innerHTML; afterClose.resolve({ ok: true, pages: [{ handle: HANDLE_A, origin: ORIGIN_A, ordinal: 3 }] }); await flush(); expect(h.dialog().innerHTML).toBe(closed);
  });

  it("sync-generation invalidation fences and discards transient observation data without erasing unsaved form state", async () => {
    const h = harness(); await h.render(); const run = await h.begin(PROFILE_A.dirId, true); h.el("agent-browser-meta-name").value = "unsaved network fixture draft";
    h.app.invalidateProfilesForSync(); await flush(); noTransientDetails(h); const before = h.dialog().innerHTML;
    run.subscription.callback({ dirId: PROFILE_A.dirId, requestId: run.requestId, armedAt: AT, observeForMs: 10_000 }); run.pending.resolve(reply(run.requestId)); await flush();
    expect(h.dialog().innerHTML).toBe(before); expect(h.el("agent-browser-meta-name").value).toBe("unsaved network fixture draft"); expect(h.cacheWrites()).toEqual([]);
  });
});

describe("network completion, bounded scope and preserved static HTTP/error facts", () => {
  it.each([
    ["quiet", summary({ counts: zeroCounts() }), "inconclusive"],
    ["pending", partial({ counts: counts({ responses: 0, finished: 0, pending: 1 }), stopReason: "evidence-incomplete" }), "inconclusive"],
    ["partial", partial(), "inconclusive"],
    ["limit", partial({ stopReason: "limit-exceeded" }), "inconclusive"],
    ["cleanup", partial({ stopReason: "cleanup-unverified" }), "inconclusive"],
    ["cancelled", partial({ completion: "cancelled", stopReason: "cancelled" }), "cancelled"],
    ["setup unavailable", unavailable(), "unavailable"],
  ] as const)("%s cannot become green or a clean-traffic conclusion", async (_label, observation, outcome) => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, observation.armedAt !== null);
    run.pending.resolve(reply(run.requestId, observation, [], { ok: outcome !== "unavailable" && outcome !== "cancelled", outcome })); await flush();
    noGreen(h.dialog()); expect(h.body().textContent).not.toContain(h.t("network.no-errors"));
    expect(h.body().textContent).toContain(h.t("network.completion." + observation.completion));
    if (!observation.counts.requests && observation.armedAt !== null) expect(h.body().textContent).toContain(h.t("network.no-traffic"));
    expect(h.cacheWrites()).toEqual([]);
  });

  it("completed clean traffic says only 'No errors observed in this finite window', never site/route/proxy PASS", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true); run.pending.resolve(reply(run.requestId)); await flush();
    noGreen(h.dialog()); expect(h.body().textContent).toContain("No errors observed in this finite window");
    expect(h.body().textContent).not.toMatch(/(?:website|site|route|proxy) (?:is )?healthy|fingerprint accepted|all routes verified/i);
    expect(h.body().textContent).toContain(h.t("network.scope")); expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1);
  });

  it("displays safe typed counts and every exact scalar coverage dimension separately from failures", async () => {
    const h = harness(), observation = summary({ counts: counts({ requests: 5, hops: 5, responses: 4, finished: 1, failed: 1, blocked: 1, requestCancelled: 1, redirects: 1, http4xx: 1, http5xx: 1, cache: 1, serviceWorker: 1, unattributed: 1, cspIssues: 2 }), coverage: coverage({ csp: "observed" }) });
    const hops = [hop({ id: "redirect-count-hop", status: 302, terminal: "redirected" }),
      hop({ id: "finished-count-hop", redirectedFrom: "redirect-count-hop", fromDiskCache: true, servedFromCache: true }),
      hop({ id: "failed-count-hop", chainId: "chain-2", status: 403, terminal: "failed", errorCode: "ERR_FAILED" }),
      hop({ id: "blocked-count-hop", chainId: "chain-3", status: 503, terminal: "blocked", blockedReason: "csp", fromServiceWorker: true }),
      hop({ id: "cancelled-count-hop", chainId: "chain-4", status: null, terminal: "cancelled", errorCode: "ERR_ABORTED" })];
    const run = await h.begin(PROFILE_A.dirId, true); run.pending.resolve(reply(run.requestId, observation, hops, { outcome: "error" })); await flush();
    expect(h.body().textContent).toContain(h.t("network.completion.completed")); noGreen(h.dialog());
    for (const key of COUNT_KEYS) {
      const node = h.body().querySelector(`[data-network-count="${key}"]`); expect(node, key).not.toBeNull();
      expect(node!.textContent).toContain(h.t("network.count." + key)); expect(node!.textContent).toMatch(new RegExp("(?:^|[^0-9])" + observation.counts[key] + "(?:[^0-9]|$)"));
    }
    for (const key of COVERAGE_KEYS) {
      const node = h.body().querySelector(`[data-network-coverage="${key}"]`); expect(node, key).not.toBeNull();
      expect(node!.textContent).toContain(h.t("network.coverage." + key)); expect(node!.textContent).toContain(h.t("network.coverage." + observation.coverage[key]));
    }
    expect(h.body().textContent).not.toContain(h.t("network.no-errors"));
  });

  it.each([
    { network: { status: "observed", secret: SECRET } }, { csp: { observed: true } }, { worker: "observed" },
    { frames: "same-origin" }, { bridgeHop: "failed" }, { upstreamHop: "authenticated" },
    { console: "observed", storage: "observed" },
  ])("rejects nested/unsupported coverage claims rather than keyword-inferencing observed %#", async patch => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    const invalid = summary({ coverage: { ...coverage(), ...patch } as any });
    run.pending.resolve(reply(run.requestId, invalid, [], { outcome: "pass", description: `observed completed healthy ${SECRET}` })); await flush();
    noGreen(h.dialog()); expect(h.body().innerHTML).not.toContain(SECRET); expect(h.body().textContent).not.toContain("[object Object]");
    expect(h.body().textContent).not.toContain(h.t("network.no-errors"));
    expect(h.body().querySelector('[data-network-coverage="network"]')?.textContent || "").not.toContain(h.t("network.coverage.observed"));
    expect(h.cacheWrites()).toEqual([]);
  });

  it("does not infer coverage from serialized words or promote a network outcome=pass", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    run.pending.resolve({ ok: true, outcome: "pass", requestId: run.requestId, observation: JSON.stringify(summary()), summary: "network observed PASS", hops: [] }); await flush();
    noGreen(h.dialog()); expect(h.body().textContent).not.toContain(h.t("network.no-errors")); expect(h.body().textContent).not.toContain("network observed PASS");
  });

  it("renders other destination origins and redirect hops without selected-origin filtering or collapsing request-hop counts", async () => {
    const h = harness(), observation = summary({ counts: counts({ requests: 3, hops: 3, responses: 3, finished: 2, redirects: 1 }) });
    const run = await h.begin(PROFILE_A.dirId, true);
    const hops = [hop({ id: "redirect-hop", origin: ORIGIN_A, status: 302, terminal: "redirected" }),
      hop({ id: "redirect-destination", origin: OTHER_ORIGIN, redirectedFrom: "redirect-hop" }), hop({ id: "another-chain", chainId: "chain-2", origin: "https://api.third.fixture.test" })];
    run.pending.resolve(reply(run.requestId, observation, hops)); await flush();
    for (const item of hops) { const row = h.body().querySelector(`[data-network-hop="${item.id}"]`); expect(row).not.toBeNull(); expect(row!.textContent).toContain(item.origin); }
    expect(h.body().querySelector('[data-network-count="requests"]')?.textContent).toMatch(/\b3\b/);
    expect(h.api.browser.networkObserve.mock.calls[0][1]).toEqual({ selection: HANDLE_A, requestId: run.requestId });
  });

  it.each([403, 429])("preserves HTTP %s plus loading failure, without claiming fingerprint detection or a known proxy hop", async status => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    const observation = summary({ counts: counts({ requests: 2, hops: 2, responses: 1, finished: 0, failed: 2, http4xx: 1 }) });
    run.pending.resolve(reply(run.requestId, observation, [hop({ status, networkStatus: status, terminal: "failed", errorCode: "ERR_FAILED", corsReason: "MissingAllowOriginHeader" }),
      hop({ id: "proxy-error-hop", chainId: "chain-2", status: null, networkStatus: null, terminal: "failed", errorCode: "ERR_PROXY_CONNECTION_FAILED" })], { outcome: "error" })); await flush();
    const row = h.body().querySelector('[data-network-hop="hop-1"]')!; expect(row.textContent).toContain(String(status));
    expect(row.textContent).toContain("ERR_FAILED"); expect(row.textContent).toContain(h.t("network.cors.MissingAllowOriginHeader"));
    expect(h.body().querySelector('[data-network-hop="proxy-error-hop"]')!.textContent).toContain("ERR_PROXY_CONNECTION_FAILED");
    for (const key of ["bridgeHop", "upstreamHop"]) expect(h.body().querySelector(`[data-network-coverage="${key}"]`)!.textContent).toContain(h.t("network.coverage.unknown"));
    expect(h.body().textContent).not.toMatch(/fingerprint (?:detected|rejected)|(?:bridge|upstream|authentication|DNS) (?:was |is )?(?:failed|broken)|HTTP\/3 (?:failed|hop)/i);
    noGreen(h.dialog());
  });

  it("keeps browser 200 / wire 304 / failed terminal and cache provenance as separate coexisting facts", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    const evidence: StatusEvidence = { id: "evidence-304", chainId: "chain-1", hopId: "hop-1", status: 304, source: "extra-info", association: "unique" };
    run.pending.resolve(reply(run.requestId, summary({ counts: counts({ finished: 0, failed: 1, cache: 1 }) }), [hop({ status: 200, networkStatus: 304, terminal: "failed", errorCode: "ERR_FAILED", fromDiskCache: true, servedFromCache: true })], { outcome: "error", httpStatusEvidence: [evidence] })); await flush();
    const row = h.body().querySelector('[data-network-hop="hop-1"]')!;
    expect(row.textContent).toContain("200"); expect(row.textContent).toContain("304"); expect(row.textContent).toContain("ERR_FAILED");
    expect(row.textContent).toContain(h.t("network.status.browser")); expect(row.textContent).toContain(h.t("network.status.wire"));
    expect(h.body().querySelector('[data-network-count="cache"]')?.textContent).toMatch(/\b1\b/); noGreen(h.dialog());
  });

  it("keeps ambiguous extra-info 403 as unassociated evidence, not a guessed redirect-hop status", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    const evidence: StatusEvidence = { id: "evidence-unknown", chainId: "chain-1", hopId: null, status: 403, source: "extra-info", association: "unknown" };
    const observation = partial({ stopReason: "evidence-incomplete", counts: counts({ requests: 2, hops: 2, responses: 1, finished: 0, failed: 1, redirects: 1, unattributed: 1 }) });
    run.pending.resolve(reply(run.requestId, observation, [hop({ id: "redirect-hop", status: 302, terminal: "redirected" }), hop({ id: "destination-hop", redirectedFrom: "redirect-hop", status: null, networkStatus: null, terminal: "failed", errorCode: "ERR_FAILED" })], { outcome: "error", httpStatusEvidence: [evidence] })); await flush();
    for (const id of ["redirect-hop", "destination-hop"]) expect(h.body().querySelector(`[data-network-hop="${id}"]`)!.textContent).not.toContain("403");
    const row = h.body().querySelector('[data-network-http-evidence="evidence-unknown"]')!;
    expect(row.textContent).toContain("403"); expect(row.textContent).toContain(h.t("network.status.extra-info")); expect(row.textContent).toContain(h.t("network.status.association.unknown"));
    expect(h.body().querySelector('[data-network-count="http4xx"]')?.textContent).toMatch(/\b0\b/); noGreen(h.dialog());
  });

  it("separates CSP policy blocking and browser request cancellation from window cancellation, console or storage claims", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    const observation = summary({ counts: counts({ requests: 2, hops: 2, responses: 0, finished: 0, blocked: 1, requestCancelled: 1, cspIssues: 1 }), coverage: coverage({ csp: "observed" }) });
    run.pending.resolve(reply(run.requestId, observation, [hop({ id: "policy-hop", status: null, terminal: "blocked", blockedReason: "csp" }), hop({ id: "cancelled-hop", chainId: "chain-2", status: null, terminal: "cancelled", errorCode: "ERR_ABORTED" })], { outcome: "warn" })); await flush();
    expect(h.body().textContent).toContain(h.t("network.completion.completed")); expect(h.body().textContent).toContain(h.t("network.blocked.csp"));
    expect(h.body().textContent).toContain("ERR_ABORTED");
    for (const key of ["console", "storage", "worker", "oopif"]) expect(h.body().querySelector(`[data-network-coverage="${key}"]`)!.textContent).toContain(h.t("network.coverage.not-observed"));
    expect(h.body().textContent).not.toMatch(/Statsig|anonymous script|VM214|quota (?:caused|attributed)|clear (?:site )?storage/i); noGreen(h.dialog());
  });
});

describe("network privacy, canonical summaries and legacy cache exclusion", () => {
  it("renders hostile origins inertly and ignores page title/path/debugger fields", async () => {
    const h = harness(), hostile = 'https://origin.fixture.test"><img data-network-injected="yes" src=x onerror="' + SECRET + '">';
    h.api.browser.networkPages.mockResolvedValue({ ok: true, pages: [{ handle: HANDLE_A, origin: hostile, ordinal: 1, title: SECRET, url: PRIVATE_URL, targetId: SECRET, webSocketDebuggerUrl: PRIVATE_URL }] });
    await h.open();
    expect(h.dialog().querySelector("img, script, iframe, [onerror], [data-network-injected]")).toBeNull(); expect(h.dialog().querySelector("a")).toBeNull();
    expect(h.dialog().innerHTML).not.toContain(PRIVATE_URL); expect(h.captured()).not.toContain(SECRET);
    // An invalid origin may be rejected altogether; if shown it must be text,
    // never an injected tag or link. This does not claim browser XSS execution.
    if (h.el("network-page-select").textContent.includes(hostile)) expect(h.el("network-page-select").innerHTML).toContain("&lt;img");
    expect(h.api.browser.networkObserve).not.toHaveBeenCalled();
  });

  it("retains a long valid origin as text with an explicit wrapping/ellipsis declaration, not a navigable URL", async () => {
    const h = harness(), origin = `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.fixture.test`;
    h.api.browser.networkPages.mockResolvedValue({ ok: true, pages: [{ handle: HANDLE_A, origin, ordinal: 17 }] }); await h.open(); h.choose();
    const display = h.el("network-page-origin"); expect(display.textContent).toContain(origin);
    expect(display.style.overflowWrap === "anywhere" || /break-(?:word|all)/.test(display.style.wordBreak || "") || display.style.textOverflow === "ellipsis").toBe(true);
    expect(h.el("network-page-select").textContent).toContain("17"); expect(h.dialog().querySelector("a")).toBeNull();
  });

  it("projects hop enums/statuses only; raw headers, bodies, paths, messages and stacks never reach markup, logs or downloads", async () => {
    const h = harness(); const run = await h.begin(PROFILE_A.dirId, true);
    const raw = { url: PRIVATE_URL, title: SECRET, targetId: SECRET, debuggerUrl: PRIVATE_URL, headers: { Authorization: SECRET, Cookie: SECRET }, body: SECRET, console: SECRET, message: PRIVATE_URL, stack: SECRET, stderr: SECRET };
    run.pending.resolve(reply(run.requestId, summary({ counts: counts({ requests: 2, hops: 2, responses: 0, finished: 0, failed: 2 }) }), [
      { ...hop({ status: null, terminal: "failed", errorCode: "ERR_PROXY_CONNECTION_FAILED" }), ...raw },
      { ...hop({ id: "unknown-enum-hop", status: null, terminal: "failed" }), errorCode: `ERR_FAILED ${SECRET}`, blockedReason: SECRET, corsReason: PRIVATE_URL, method: SECRET, resourceType: SECRET },
    ], { outcome: "error", ...raw })); await flush();
    expect(h.body().textContent).toContain("ERR_PROXY_CONNECTION_FAILED"); expect(h.dialog().innerHTML).not.toContain(SECRET); expect(h.captured()).not.toContain(SECRET);
    expect(h.dialog().querySelector("[onerror], script, iframe")).toBeNull(); expect(h.downloads).toEqual([]); safeCacheWrites(h);
  });

  it.each(["pages", "observe"])("a rejected %s transport uses safe localized copy instead of raw error text or logging it", async endpoint => {
    const h = harness();
    if (endpoint === "pages") { h.api.browser.networkPages.mockRejectedValue(new Error(PRIVATE_URL)); await h.open(); }
    else { h.api.browser.networkObserve.mockRejectedValue(new Error(PRIVATE_URL)); await h.open(); h.choose(); h.command("network-observation-start"); await flush(); }
    expect(h.dialog().innerHTML).not.toContain(SECRET); expect(h.captured()).not.toContain(SECRET); noGreen(h.dialog()); expect(h.downloads).toEqual([]);
    for (const subscription of h.subscriptions) expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects injected network/unknown kinds at cache READ while retaining legitimate legacy rows and bytes", async () => {
    const h = harness(), original = JSON.stringify(poisonedCache()); h.memory.set(HEALTH_KEY, original);
    h.api.browser.healthHistory.mockResolvedValue({ entries: [] }); await h.render();
    expect(h.card().innerHTML).not.toContain(SECRET); expect(h.badge().getAttribute("title") || "").not.toContain(SUMMARY_CODE);
    expect(h.badge().getAttribute("title")).toContain("keep legacy environment row"); noGreen(h.badge());
    const history = await h.historyView();
    expect(history.textContent).toContain("keep legacy environment row"); expect(history.textContent).toContain("keep legacy drift row");
    expect(history.innerHTML).not.toContain(SECRET); expect(history.innerHTML).not.toContain(SUMMARY_CODE);
    expect(history.innerHTML).not.toContain(ORIGIN_A); expect(history.innerHTML).not.toContain(OTHER_ORIGIN);
    expect(history.textContent).not.toContain("future-health-kind"); expect(history.textContent).not.toContain(h.t("profile.health.kind.network")); noGreen(history);
    expect(h.memory.get(HEALTH_KEY)).toBe(original); expect(h.cacheWrites()).toEqual([]);
  });

  it("a rejected canonical read stays unavailable, excludes injected cache entries and preserves the original legacy bytes", async () => {
    const h = harness(), original = JSON.stringify(poisonedCache()), unavailable = "synthetic canonical history unavailable";
    h.memory.set(HEALTH_KEY, original); h.api.browser.healthHistory.mockRejectedValue(new Error(unavailable)); await h.render();
    expect(h.card().innerHTML).not.toContain(SECRET); expect(h.badge().getAttribute("title") || "").not.toContain(SUMMARY_CODE);
    expect(h.badge().getAttribute("title")).toBe(unavailable); expect(h.badge().getAttribute("data-health-outcome")).toBe("inconclusive"); noGreen(h.badge());
    h.toast.mockClear(); h.menu("history"); await flush(); expect(h.app.confirmHtml).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.some((args: any[]) => args[1] === "error")).toBe(true);
    expect(h.memory.get(HEALTH_KEY)).toBe(original); expect(h.cacheWrites()).toEqual([]);
  });

  it.each(OLD_KINDS)("recordHealthResult from OTHER kind %s filters every profile before the legacy cache WRITE", async kind => {
    const h = harness(); await h.render(); h.memory.set(HEALTH_KEY, JSON.stringify(poisonedCache()));
    if (kind === "env") h.app.openEnvRisk(PROFILE_A.dirId);
    else if (kind === "webrtc") h.app.openWebRtcDiag(PROFILE_A.dirId);
    else if (kind === "drift") h.app.checkDrift(PROFILE_A.dirId);
    else h.app.runConsistencyCheck(PROFILE_A.dirId);
    await flush(); expect(h.cacheWrites().length).toBeGreaterThan(0); safeCacheWrites(h);
    expect(h.cache()[PROFILE_B.dirId]).toEqual([{ kind: "webrtc", at: AT - 3000, verdict: "unavailable", detail: "keep B legacy RTC row" }]);
    expect(h.cache()[PROFILE_C.dirId]).toEqual([{ kind: "consistency", at: AT - 4000, detail: "keep C legacy alignment row" }]);
    expect(h.cache()[PROFILE_A.dirId].some((entry: any) => entry.kind === kind)).toBe(true);
  });

  it.each(["env", "webrtc"])("removeCachedHealthKind from OTHER kind %s also filters all profiles at its separate WRITE", async kind => {
    const h = harness(); await h.render();
    if (kind === "env") h.app.openEnvRisk(PROFILE_A.dirId); else h.app.openWebRtcDiag(PROFILE_A.dirId);
    await flush(); const seeded = poisonedCache();
    if (kind === "webrtc") seeded[PROFILE_A.dirId].push({ kind: "webrtc", at: AT - 500, outcome: "unavailable", detail: "clear this legacy RTC row" } as any);
    h.memory.set(HEALTH_KEY, JSON.stringify(seeded)); h.writes.length = 0;
    if (kind === "env") h.app.envRiskClear(); else h.app.webRtcDiagClear();
    h.app.confirm.mock.calls.at(-1)[1](); await flush();
    expect(h.cacheWrites().length).toBeGreaterThan(0); safeCacheWrites(h);
    expect(h.cache()[PROFILE_A.dirId].some((entry: any) => entry.kind === kind)).toBe(false);
    expect(h.cache()[PROFILE_B.dirId][0].detail).toBe("keep B legacy RTC row");
  });

  it("run, canonical refresh, card/history render and network clear never serialize network or transient origins", async () => {
    const h = harness(); await h.render(); const legacy = { kind: "drift", at: AT - 1000, outcome: "warn", detail: "preserve old kind" };
    h.memory.set(HEALTH_KEY, JSON.stringify({ [PROFILE_A.dirId]: [legacy] }));
    const run = await h.begin(PROFILE_A.dirId, true), observation = summary(); h.authority([canonical(observation, run.requestId), { ...legacy, source: "runtime", summary: legacy.detail }]);
    run.pending.resolve(reply(run.requestId, observation)); await flush(); await h.tick(130);
    const view = await h.historyView(); expect(view.textContent).toContain(h.t("profile.health.kind.network"));
    expect(view.textContent).toContain(h.t("network.count.requests")); expect(view.textContent).toContain(h.t("network.coverage.frames"));
    expect(view.innerHTML).not.toContain(ORIGIN_A); expect(view.innerHTML).not.toContain(OTHER_ORIGIN); expect(view.innerHTML).not.toContain("hop-1"); expect(view.innerHTML).not.toContain(SUMMARY_CODE);
    expect(h.badge().getAttribute("title") || "").not.toContain(SUMMARY_CODE); noGreen(h.badge());
    expect(h.memory.get(HEALTH_KEY)).not.toContain(run.requestId); safeCacheWrites(h);
    h.authority([{ ...legacy, source: "runtime", summary: legacy.detail }]); await h.clear();
    expect(h.api.browser.healthClear).toHaveBeenCalledWith(PROFILE_A.dirId, "network"); noTransientDetails(h); safeCacheWrites(h);
    expect(h.cache()[PROFILE_A.dirId]).toEqual([legacy]); expect(h.downloads).toEqual([]); expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("a completed observation with a failed history commit stays distinct from a saved health result", async () => {
    const h = harness(); h.authority([{ kind: "env", at: AT - 1, outcome: "warn", summary: "retained canonical environment summary", source: "host" }]); await h.render();
    const run = await h.begin(PROFILE_A.dirId, true); h.toast.mockClear();
    run.pending.resolve(reply(run.requestId, summary(), [hop()], { ok: false, outcome: "error", code: "HEALTH_HISTORY_WRITE_FAILED", error: PRIVATE_URL })); await flush();
    expect(h.dialog().textContent).toContain(h.t("network.failure.history-write-failed")); expect(h.body().textContent).toContain(h.t("network.completion.completed"));
    expect(h.body().querySelector('[data-network-count="requests"]')?.textContent.trim().endsWith(": 1")).toBe(true); expect(h.body().textContent).not.toContain(h.t("network.no-errors"));
    expect(h.toast.mock.calls.some((args: any[]) => args[1] === "success")).toBe(false); expect(h.cacheWrites()).toEqual([]); expect(h.captured()).not.toContain(SECRET);
    const history = await h.historyView(); expect(history.textContent).toContain("retained canonical environment summary"); expect(history.textContent).not.toContain(h.t("profile.health.kind.network"));
  });

  it("canonical network rows use the typed summary, not arbitrary summary/detail/hop fields, and stay memory-only", async () => {
    const h = harness(); h.authority([{ ...canonical(), summary: SUMMARY_CODE, detail: PRIVATE_URL, origin: ORIGIN_A, hops: [{ ...hop(), url: PRIVATE_URL }], headers: { Cookie: SECRET } }]);
    await h.render(); const view = await h.historyView(); expect(view.textContent).toContain(h.t("network.completion.completed"));
    expect(view.innerHTML).not.toContain(SUMMARY_CODE); expect(view.innerHTML).not.toContain(SECRET); expect(view.innerHTML).not.toContain(OTHER_ORIGIN);
    expect(h.badge().getAttribute("title") || "").not.toContain(SUMMARY_CODE); expect(h.cacheWrites()).toEqual([]); noGreen(view);
  });

  it.each([
    { outcome: "pass" }, { source: "cached" }, { source: "legacy" },
    { networkSummary: { ...summary(), coverage: { ...coverage(), network: { observed: true } } } },
    { networkSummary: JSON.stringify(summary()) }, { networkSummary: null },
  ])("malformed/positive canonical network entry cannot upgrade coverage or become PASS %#", async patch => {
    const h = harness(); h.authority([{ ...canonical(), ...patch }]); await h.render(); noGreen(h.badge()); expect(h.cacheWrites()).toEqual([]);
    h.menu("history"); await flush();
    for (const call of h.app.confirmHtml.mock.calls) { const view = new FixtureElement(h.document); view.innerHTML = call[2].detailHtml; noGreen(view); expect(view.textContent).not.toContain(SUMMARY_CODE); }
  });

  it("network has no report export control and does not contaminate unchanged env/RTC report downloads", async () => {
    const h = harness(); await h.render(); const run = await h.begin(PROFILE_A.dirId, true);
    h.authority([canonical(summary(), run.requestId)]); run.pending.resolve(reply(run.requestId)); await flush();
    for (const button of h.dialog().querySelectorAll("button")) expect(button.getAttribute("data-cmd") || "").not.toMatch(/export|download/i);
    expect(typeof h.app.networkObservationExport).not.toBe("function"); expect(h.downloads).toEqual([]);
    const env = { ...envReply().result, outcome: "pass", requestId: "old-env-run" }, rtc = { ...rtcReply().result, outcome: "pass", requestId: "old-rtc-run" };
    h.api.browser.envRiskHistory.mockResolvedValue({ ok: true, entries: [env] }); h.api.webrtc.diagHistory.mockResolvedValue({ entries: [rtc] });
    h.app.openEnvRisk(PROFILE_A.dirId); await flush(); h.app.envRiskExport(); await flush();
    h.app.openWebRtcDiag(PROFILE_A.dirId); await flush(); h.app.webRtcDiagExport(); await flush();
    expect(h.downloads).toHaveLength(2);
    for (const [index, raw] of [env, rtc].entries()) {
      const text = await h.downloads[index].text(), report = JSON.parse(text); expect(report.history).toEqual([raw]); expect(report.latest).toEqual(raw);
      expect(text).not.toContain(SUMMARY_CODE); expect(text).not.toContain(ORIGIN_A); expect(text).not.toContain(OTHER_ORIGIN); expect(text).not.toContain("networkSummary");
    }
    expect(h.api.browser.envRisk).toHaveBeenCalledTimes(1); expect(h.api.webrtc.diag).toHaveBeenCalledTimes(1); expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(1); safeCacheWrites(h);
  });
});

describe("network clear readback and late-work fencing", () => {
  it.each([false, true])("clear during armed=%s cancels only its owned request and fences pending result/history/armed deliveries", async armed => {
    const h = harness(), oldRead = deferred(); let cleared = false;
    const preserved = { kind: "drift", at: AT - 1000, outcome: "warn", summary: "preserve canonical drift", source: "runtime" };
    h.api.browser.healthHistory.mockImplementation(async (id: string) => id === PROFILE_A.dirId ? cleared ? { entries: [preserved] } : oldRead.promise : { entries: [] });
    await h.render(); const run = await h.begin(PROFILE_A.dirId, armed); cleared = true; await h.clear();
    expect(h.api.browser.healthClear.mock.calls[0]).toEqual([PROFILE_A.dirId, "network"]);
    expect(h.api.browser.healthCancel.mock.calls).toEqual([[PROFILE_A.dirId, { kind: "network", requestId: run.requestId }]]);
    expect(run.subscription.unsubscribe).toHaveBeenCalledTimes(1); noTransientDetails(h);
    const before = h.dialog().innerHTML; run.subscription.callback({ dirId: PROFILE_A.dirId, requestId: run.requestId, armedAt: AT, observeForMs: 10_000 });
    run.pending.resolve(reply(run.requestId)); oldRead.resolve({ entries: [canonical(summary({ counts: counts({ requests: 91, hops: 91, responses: 91, finished: 91 }) }), run.requestId)] }); await flush();
    expect(h.dialog().innerHTML).toBe(before); expect(h.badge().getAttribute("title")).toBe("preserve canonical drift"); safeCacheWrites(h);
    const history = await h.historyView(); expect(history.textContent).toContain("preserve canonical drift"); expect(history.textContent).not.toContain(SUMMARY_CODE);
  });

  it("failed clear removes transient details but retains authoritative summaries, reports failure and never claims success", async () => {
    const h = harness(); await h.render(); const run = await h.begin(PROFILE_A.dirId, true);
    h.authority([canonical(summary(), run.requestId)]); run.pending.resolve(reply(run.requestId)); await flush();
    h.api.browser.healthClear.mockResolvedValue({ ok: false, code: "HEALTH_HISTORY_WRITE_FAILED", error: PRIVATE_URL }); h.toast.mockClear(); await h.clear();
    noTransientDetails(h); expect(h.toast.mock.calls.some((args: any[]) => args[1] === "success")).toBe(false);
    expect(h.toast.mock.calls.some((args: any[]) => args[1] === "error" || args[1] === "warning")).toBe(true);
    expect(h.captured()).not.toContain(SECRET); const view = await h.historyView(); expect(view.textContent).toContain(h.t("profile.health.kind.network")); safeCacheWrites(h);
  });

  it("clear followed by canonical readback failure is unverified, not a successful empty history", async () => {
    const h = harness(); await h.render(); const run = await h.begin(PROFILE_A.dirId, true);
    h.authority([canonical(summary(), run.requestId)]); run.pending.resolve(reply(run.requestId)); await flush();
    h.api.browser.healthHistory.mockRejectedValue(new Error("synthetic network clear readback unavailable")); h.toast.mockClear(); await h.clear();
    noTransientDetails(h); expect(h.toast.mock.calls.some((args: any[]) => args[1] === "success")).toBe(false); noGreen(h.badge());
    expect(h.toast.mock.calls.some((args: any[]) => /unverified|not.*read|unavailable/i.test(args[0]))).toBe(true); safeCacheWrites(h);
  });
});

const COPY_KEYS = [
  "profile.health.network", "profile.health.kind.network", "network.title", "network.pages.label", "network.pages.placeholder", "network.pages.refresh", "network.pages.empty",
  "network.start", "network.setup", "network.observing10s", "network.clear", "network.clear-confirm", "network.clear-title", "network.cleared",
  "network.unavailable", "network.selection-expired", "network.no-traffic", "network.no-errors", "network.scope", "network.privacy", "network.limits", "network.close-boundary",
  ...["completed", "partial", "cancelled", "unavailable"].map(value => "network.completion." + value),
  ...COVERAGE_KEYS.map(key => "network.coverage." + key),
  ...["observed", "partial", "unavailable", "not-observed", "selected-target-main-frame", "unknown"].map(value => "network.coverage." + value),
  ...COUNT_KEYS.map(key => "network.count." + key), ...STOP_REASONS.map(reason => "network.stop." + reason),
  "network.status.browser", "network.status.wire", "network.status.extra-info", "network.status.association.unique", "network.status.association.unknown",
  "network.cors.MissingAllowOriginHeader", "network.blocked.csp", ...NETWORK_FAILURE_CASES.map(([, key]) => key),
];
describe("network mirrored copy, icon-safe localization and accessible DOM contract", () => {
  it("keeps dictionary bytes identical and every network key unique per locale across merged dictionaries", () => {
    expect(fs.readFileSync(path.join(ROOT, "i18n.js")).equals(Buffer.from(I18N))).toBe(true);
    const source = ts.createSourceFile("i18n.js", I18N, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), perLocale: Record<string, Map<string, number>> = { "zh-CN": new Map(), "en-US": new Map() };
    function visit(node: ts.Node, locale?: string) {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
        if (node.name.text in perLocale && ts.isObjectLiteralExpression(node.initializer)) { ts.forEachChild(node.initializer, child => visit(child, node.name.getText(source).slice(1, -1))); return; }
        if (locale && (node.name.text.startsWith("network.") || ["profile.health.network", "profile.health.kind.network"].includes(node.name.text))) {
          const count = perLocale[locale]; count.set(node.name.text, (count.get(node.name.text) || 0) + 1);
        }
      }
      ts.forEachChild(node, child => visit(child, locale));
    }
    visit(source); const zh = harness("zh-CN"), en = harness("en-US");
    const allKeys = new Set([...COPY_KEYS, ...perLocale["zh-CN"].keys(), ...perLocale["en-US"].keys()]);
    for (const key of allKeys) {
      expect(perLocale["zh-CN"].get(key), key + " zh-CN shadowing/missing").toBe(1); expect(perLocale["en-US"].get(key), key + " en-US shadowing/missing").toBe(1);
      const a = zh.t(key), b = en.t(key); expect(a + b, key).not.toMatch(/\p{Extended_Pictographic}/u);
      expect([...a.matchAll(/\{[^}]+\}/g)].map(m => m[0]).sort(), key).toEqual([...b.matchAll(/\{[^}]+\}/g)].map(m => m[0]).sort());
      if (COPY_KEYS.includes(key)) expect(a, key).toMatch(/[㐀-鿿]/);
    }
  });

  it("declares a labelled selector/dialog, polite status, explicit commands and separate icon-safe text spans", async () => {
    const h = harness(); await h.open(); const dialog = h.dialog(), select = h.el("network-page-select"), body = h.body();
    expect(dialog.getAttribute("aria-labelledby")).toBe("dlg-network-observation-title"); expect(h.el("dlg-network-observation-title").textContent.trim()).toBeTruthy();
    expect(dialog.querySelector('label[for="network-page-select"]')?.textContent.trim() || select.getAttribute("aria-label")).toBeTruthy();
    expect(body.getAttribute("data-i18n")).toBeNull(); expect(h.el("network-observation-status").getAttribute("role")).toBe("status"); expect(h.el("network-observation-status").getAttribute("aria-live")).toBe("polite");
    for (const [id, cmd] of [["network-page-refresh", "refreshNetworkPages"], ["network-observation-start", "startNetworkObservation"], ["network-observation-cancel", "cancelNetworkObservation"], ["network-observation-clear", "networkObservationClear"]]) {
      const button = h.el(id); expect(button.tagName).toBe("BUTTON"); expect(button.getAttribute("type")).toBe("button"); expect(button.dataset.role).toBe("cmd"); expect(button.dataset.cmd).toBe(cmd);
      expect(button.getAttribute("data-icon")).toBeTruthy(); expect(button.getAttribute("data-i18n")).toBeNull(); expect(button.querySelector("span[data-i18n]")).not.toBeNull(); expect(typeof h.app[cmd]).toBe("function");
    }
    expect(dialog.querySelector('[data-cmd="close-dialog"]')).not.toBeNull(); h.window.icons.apply(dialog);
    for (const host of dialog.querySelectorAll("[data-icon]")) { expect(host.querySelector("svg")).not.toBeNull(); expect(host.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true"); expect(host.querySelector("svg")!.getAttribute("focusable")).toBe("false"); }
    for (const node of [dialog, ...dialog.querySelectorAll("*")]) expect(node.style.color || "").not.toMatch(/var\(--(?:primary|success|warning|danger|accent-firefox)\)/);
  });

  it("switches live results, selected origin and canonical history to zh/en without clobbering SVG or invoking new work", async () => {
    const h = harness(); await h.render(); const run = await h.begin(PROFILE_A.dirId, true);
    h.authority([canonical(summary(), run.requestId)]); run.pending.resolve(reply(run.requestId)); await flush(); h.window.icons.apply(h.dialog());
    const beforeCalls = h.api.browser.networkObserve.mock.calls.length, beforePages = h.api.browser.networkPages.mock.calls.length;
    h.window.i18n.set("zh-CN"); await flush(); expect(h.body().textContent).toContain(h.t("network.no-errors")); expect(h.el("network-page-origin").textContent).toContain(ORIGIN_A);
    expect(h.dialog().querySelector("svg")).not.toBeNull(); expect(h.body().textContent).not.toBe(h.t("common.loading"));
    const view = await h.historyView(); expect(view.textContent).toContain(h.t("profile.health.kind.network")); expect(view.textContent).toContain(h.t("network.count.requests"));
    h.window.i18n.set("en-US"); await flush(); expect(h.body().textContent).toContain("No errors observed in this finite window"); expect(h.dialog().querySelector("svg")).not.toBeNull();
    expect(h.api.browser.networkObserve).toHaveBeenCalledTimes(beforeCalls); expect(h.api.browser.networkPages).toHaveBeenCalledTimes(beforePages); safeCacheWrites(h);
  });
});
