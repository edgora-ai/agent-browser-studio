// Unit boundary: complete production core/ipc/profiles/proxies/i18n modules run unchanged
// in an owned synthetic DOM/VM. No Electron, browser, network, Keychain, model,
// credentials, host diagnostics or user-data filesystem is used. DOM events/state
// are modeled; layout, native focus/modal behavior and real IPC are NOT verified.
// Unlisted API capabilities throw on access, rather than silently returning success.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const SOURCES = Object.fromEntries(["icons", "core", "ipc", "profiles", "proxies"].map(name => [name,
  fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${name}.js`), "utf8"),
]));
const I18N = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");
const HEALTH_KEY = "agent-browser-health-history-v1";
const PROFILE = {
  dirId: "health_synthetic_a", name: "Health synthetic A", engine: "chromium", fingerprintMode: "managed",
  fingerprintSeed: 12345, platform: "macos", timezone: "UTC", locale: "en-US", tags: ["synthetic"],
  syncStatus: "synced", syncScope: "portable-profile+preferences", syncReason: "baseline-match", syncedAt: 1000,
  lastModified: 2000, running: true, pid: null, proxyMode: "none", proxyName: null,
};
const PROFILE_B = { ...PROFILE, dirId: "health_synthetic_b", name: "Health synthetic B" };
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
type Handler = (event: any) => void;
class Element {
  attributes: Record<string, string> = {};
  children: Element[] = [];
  parentNode: Element | null = null;
  style: Record<string, string> = {};
  listeners: Record<string, Handler[]> = {};
  dataset: Record<string, string>;
  private text = "";
  private input = "";
  scrollTop = 0;
  checked = false;
  disabled = false;
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
  };
  get parentElement() { return this.parentNode; }
  get nextSibling(): Element | null { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get childNodes() { return this.children; }
  get nodeType() { return this.tagName === "#TEXT" ? 3 : 1; }
  get firstElementChild() { return this.children.find(c => c.tagName !== "#TEXT") || null; }
  get value(): string { return this.tagName === "SELECT" && !this.input ? this.querySelector("option[selected]")?.value || this.querySelector("option")?.value || "" : this.input; }
  set value(value: string | number) { this.input = String(value); }
  get open() { return this.attributes.open !== undefined; }
  set open(value: boolean) { if (value) this.attributes.open = ""; else delete this.attributes.open; }
  get hidden() { return this.attributes.hidden !== undefined; }
  set hidden(value: boolean) { if (value) this.attributes.hidden = ""; else delete this.attributes.hidden; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(""); }
  set textContent(value: string) { this.text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  get innerHTML(): string { return escape(this.text) + this.children.map(c => c.tagName === "#TEXT" ? escape(c.textContent)
    : "<" + c.tagName.toLowerCase() + Object.entries(c.attributes).map(([k, v]) => ` ${k}="${escape(v)}"`).join("") + ">" + c.innerHTML + "</" + c.tagName.toLowerCase() + ">").join(""); }
  set innerHTML(value: string) { this.textContent = ""; if (this.tagName === "SELECT") this.input = ""; parseInto(value, this); }
  appendChild(child: Element) {
    if (child.tagName === "#FRAGMENT") { for (const c of [...child.children]) this.appendChild(c); return child; }
    child.parentNode?.removeChild(child); child.parentNode = this; this.children.push(child); return child;
  }
  insertBefore(child: Element, before: Element | null) { this.appendChild(child); if (before) { this.children.pop(); this.children.splice(this.children.indexOf(before), 0, child); } return child; }
  removeChild(child: Element) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(key: string, value: string) {
    this.attributes[key] = String(value);
    if (key === "style") for (const rule of String(value).split(";")) {
      const colon = rule.indexOf(":");
      if (colon >= 0) this.style[rule.slice(0, colon).trim().replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = rule.slice(colon + 1).trim();
    }
  }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  removeAttribute(key: string) { delete this.attributes[key]; }
  contains(child: Element): boolean { return child === this || this.children.some(c => c.contains(child)); }
  matches(selector: string) { return matches(this, selector, this); }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector: string): Element[] {
    const all = (node: Element): Element[] => node.children.flatMap(c => [c, ...all(c)]);
    return all(this).filter(c => c.tagName !== "#TEXT" && matches(c, selector, this));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(key: string, fn: Handler) { (this.listeners[key] ||= []).push(fn); }
  dispatchEvent(event: any) { event.target ||= this; for (const fn of this.listeners[event.type] || []) fn(event); (this as any)["on" + event.type]?.(event); }
  click() { this.dispatchEvent({ type: "click", preventDefault() {} }); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent({ type: "close" }); }
}
function matches(el: Element, selector: string, scope: Element): boolean {
  return selector.split(",").some(arm => {
    const parts = arm.trim().match(/(?:\[[^\]]*\]|:not\([^)]*\)|[^ >])+|>/g) || [];
    const simple = (node: Element, part: string): boolean => {
      let ok = true;
      part = part.replace(/:not\(([^)]*)\)/g, (_all, inner) => { ok &&= !matches(node, inner, scope); return ""; });
      part = part.replace(/:scope|:checked/g, pseudo => { ok &&= pseudo === ":scope" ? node === scope : node.checked; return ""; });
      part = part.replace(/^[\w*-]+/, tag => { ok &&= tag === "*" || node.tagName === tag.toUpperCase(); return ""; });
      part = part.replace(/([.#])([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g, (_all, prefix, name, attr, value) => {
        ok &&= prefix === "." ? node.classList.contains(name) : prefix === "#" ? node.id === name
          : value === undefined ? node.getAttribute(attr) !== null : node.getAttribute(attr) === value;
        return "";
      });
      if (part) throw new Error("Unsupported synthetic selector: " + selector);
      return ok;
    };
    const visit = (node: Element | null, index: number): boolean => {
      if (!node || !simple(node, parts[index])) return false;
      if (!index) return true;
      if (parts[index - 1] === ">") return visit(node.parentNode, index - 2);
      for (let parent = node.parentNode; parent; parent = parent.parentNode) if (visit(parent, index - 1)) return true;
      return false;
    };
    return !!parts.length && visit(el, parts.length - 1);
  });
}
function parseInto(html: string, root: Element) {
  const stack = [root];
  for (const m of html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").matchAll(/<\/?[a-zA-Z][^>]*>|[^<]+/g)) {
    const token = m[0];
    if (token.startsWith("</")) {
      const tag = /^<\/([\w-]+)/.exec(token)![1].toUpperCase();
      const index = stack.map(node => node.tagName).lastIndexOf(tag); if (index > 0) stack.splice(index);
    } else if (token.startsWith("<")) {
      const tag = /^<([\w-]+)/.exec(token)![1].toUpperCase(), el = new Element(root.ownerDocument, tag);
      for (const a of token.matchAll(/\s([\w-]+)(?:="([^"]*)"|'([^']*)')?/g)) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? ""));
      el.checked = el.attributes.checked !== undefined; el.disabled = el.attributes.disabled !== undefined;
      if (el.attributes.value !== undefined) el.value = el.attributes.value;
      stack[stack.length - 1].appendChild(el);
      if (!/^(INPUT|META|LINK|BR|HR|IMG)$/.test(tag) && !token.endsWith("/>")) stack.push(el);
    } else {
      const text = new Element(root.ownerDocument, "#TEXT"); text.textContent = decode(token); stack[stack.length - 1].appendChild(text);
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
    if (!(key in target)) throw new Error("Unmodeled API capability: " + prefix + "." + key);
    return Reflect.get(target, key, receiver);
  } });
}
const rtc = (patch: any = {}, outcome = "pass") => ({ ok: true, outcome, result: {
  at: 1000, success: true, rtcAvailable: true, gatheringState: "complete", hostIps: [], srflxIps: ["203.0.113.7"], mdnsHosts: [],
  candidates: ["candidate:synthetic 1 udp 1 203.0.113.7 50000 typ srflx"], connectionState: "completed", rttMs: null, error: null, summary: "synthetic RTC evidence", ...patch,
} });
const env = (patch: any = {}, outcome = "pass") => ({ ok: true, outcome, result: {
  at: 1000, ok: true, hostPlatform: "synthetic", hostLocale: "en-US", resolvers: [], cnFonts: [],
  findings: [], summary: "synthetic host evidence", ...patch,
} });
function harness(language = "en-US") {
  const document: any = {}, root = new Element(document, "#DOCUMENT"), events: Record<string, Handler[]> = {};
  parseInto(HTML, root);
  Object.assign(document, {
    readyState: "loading", // Modules define their production helpers before DOMContentLoaded hydration.
    getElementById: (id: string) => root.querySelector("#" + id),
    querySelector: (selector: string) => root.querySelector(selector), querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    createElement: (tag: string) => new Element(document, tag.toUpperCase()), createDocumentFragment: () => new Element(document, "#FRAGMENT"),
    createTextNode: (text: string) => { const el = new Element(document, "#TEXT"); el.textContent = text; return el; },
    addEventListener: (name: string, fn: Handler) => (events[name] ||= []).push(fn),
    dispatchEvent: (event: any) => (events[event.type] || []).forEach(fn => fn(event)),
  });
  document.body = document.querySelector("body"); document.documentElement = document.querySelector("html"); document.activeElement = document.body;
  const api = failOnUnknown({
    observability: null, // Explicitly unavailable at this unit boundary (production IPC permits it).
    browser: failOnUnknown({
      list: vi.fn(async (): Promise<any[]> => [structuredClone(PROFILE), structuredClone(PROFILE_B)]),
      binary: vi.fn(async (): Promise<any> => ({ installed: true, version: "synthetic-engine", installedVersions: [] })),
      engineStatus: vi.fn(async (): Promise<any> => ({ firefox: { installed: true } })), status: vi.fn(async () => ({ running: true })),
      envRisk: vi.fn(async (_id: string, _opts?: any): Promise<any> => env()),
      envRiskHistory: vi.fn(async (_id: string): Promise<any> => ({ ok: true, entries: [] })),
      envRiskClear: vi.fn(async (_id: string): Promise<any> => ({ ok: true })),
      healthHistory: vi.fn(async (_id: string): Promise<any> => ({ entries: [] })),
      healthCancel: vi.fn(async (_id: string, _opts?: any): Promise<any> => ({ success: true, cancelled: true })),
      checkDrift: vi.fn(async (_id: string, _opts?: any): Promise<any> => ({ ok: true, hasBaseline: true, risky: false, drift: [], outcome: "pass" })),
      captureBaseline: vi.fn(async (_id: string, _opts?: any): Promise<any> => ({ ok: true, risky: false, fields: 9, outcome: "baseline-established" })),
      consistencyCheck: vi.fn(async (_id: string, _opts?: any): Promise<any> => ({ ok: true, warnings: [], blockers: [], outcome: "inconclusive" })),
      openRiskCheck: vi.fn(async (_id: string, _opts?: any): Promise<any> => ({ success: true })),
    }, "browser"),
    webrtc: failOnUnknown({ diag: vi.fn(async (_id: string, _opts?: any): Promise<any> => rtc()),
      diagHistory: vi.fn(async (_id: string): Promise<any> => ({ entries: [] })),
      diagClear: vi.fn(async (_id: string): Promise<any> => ({ success: true })),
    }, "webrtc"),
    proxy: failOnUnknown({ list: vi.fn(async (): Promise<any[]> => []),
      get: vi.fn(async (_name: string): Promise<any> => ({ type: "http", host: "proxy.synthetic.invalid", port: 1080 })),
      healthGet: vi.fn(async (): Promise<any> => ({ entries: [], summary: null })),
      healthClear: vi.fn(async (): Promise<any> => ({ success: true })), rotationInfo: vi.fn(async (): Promise<any> => ({ success: true, info: { active: false } })),
    }, "proxy"),
    detect: failOnUnknown({ proxyByName: vi.fn(async (): Promise<any> => ({ success: true, exitIp: "203.0.113.7" })) }, "detect"),
    app: failOnUnknown({ setLanguage: vi.fn(async () => ({ success: true })), version: vi.fn(async () => "synthetic-version") }, "app"),
  }, "api");
  const window: any = { agentBrowserAPI: api };
  const memory = new Map<string, string>(), downloadIntents: Blob[] = [];
  const context = vm.createContext({ window, document, console, navigator: { language },
    Blob, URL: failOnUnknown({ createObjectURL: vi.fn((blob: Blob) => { downloadIntents.push(blob); return "blob:synthetic-owned-download"; }), revokeObjectURL: vi.fn() }, "download.URL"),
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) },
    setTimeout, clearTimeout, Date, Math,
    CustomEvent: function(type: string, options: any) { return { type, ...options }; },
    Option: function(text: string, value: string) { const option = document.createElement("option"); option.textContent = text; option.value = value; return option; },
  });
  vm.runInContext(I18N, context, { filename: "src/renderer/js/i18n.js" });
  for (const name of ["icons", "core", "ipc"]) vm.runInContext(SOURCES[name], context, { filename: `src/renderer/js/app/${name}.js` });
  const app: any = window.agentBrowser;
  app.helpers.toast = vi.fn(); app.state.currentTab = "profiles";
  app.confirm = vi.fn(); app.confirmHtml = vi.fn(); app.refresh = vi.fn();
  app.renderViewState = vi.fn((el: Element, options: any) => { el.textContent = options.error || options.empty || options.loading || ""; });
  for (const name of ["profiles", "proxies"]) vm.runInContext(SOURCES[name], context, { filename: `src/renderer/js/app/${name}.js` });
  const el = (id: string): Element => { const found = document.getElementById(id); if (!found) throw new Error("Missing production HTML element " + id); return found; };
  const card = (id = PROFILE.dirId) => el("profile-list").querySelector(`[data-dir-id="${id}"]`)!;
  const badge = (id = PROFILE.dirId) => card(id)?.querySelector(".health-verdict")!;
  const history = () => JSON.parse(memory.get(HEALTH_KEY) || "{}")[PROFILE.dirId] || [];
  const confirm = () => { const call = app.confirm.mock.calls.at(-1) || app.confirmHtml.mock.calls.at(-1); if (!call) throw new Error("No explicit confirmation requested"); call[1](); };
  const menu = (value: string, id = PROFILE.dirId) => { const control = card(id).querySelector('[data-action="health"]')!; control.value = value; (el("profile-list") as any).onchange({ target: control }); };
  const render = async () => { app.loadProfiles(true); await flush(); expect(card(), el("profile-list").textContent).toBeTruthy(); };
  const tick = async (ms = 130) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
  // Explicit main-history boundary fixture, not a renderer-side reconstruction
  // of persistence or outcome rules. The backend is verified by another suite.
  const authority = (kind: string, outcome: string, summary = "synthetic authoritative summary", dirId = PROFILE.dirId) => {
    api.browser.healthHistory.mockImplementation(async (id: string) => ({ entries: id === dirId
      ? [{ kind, outcome, summary, at: Date.now(), source: kind === "env" ? "host" : "runtime" }] : [] }));
  };
  return { app, api, window, document, context, memory, downloadIntents, el, card, badge, history, confirm, menu, render, tick, authority, toast: app.helpers.toast };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("health renderer business conclusions (whole production modules)", () => {
  it("never paints a probe error as PASS merely because hostIps is empty", async () => {
    const h = harness(); await h.render(); h.api.webrtc.diag.mockResolvedValue(rtc({ error: "synthetic probe failure" }, "error"));
    h.app.openWebRtcDiag(PROFILE.dirId); await flush();
    expect(h.el("webrtc-diag-body").textContent).not.toMatch(/\bPASS\b|\bPass\b/);
    expect(h.history()[0]?.outcome || h.history()[0]?.verdict).toBe("error");
  });
  it("keeps unavailable RTC consistent between modal, cached summary and card", async () => {
    const h = harness(); await h.render(); h.authority("webrtc", "unavailable");
    h.api.webrtc.diag.mockResolvedValue(rtc({ rtcAvailable: false, candidates: [], srflxIps: [] }, "unavailable"));
    h.app.openWebRtcDiag(PROFILE.dirId); await flush(); await h.tick();
    expect(h.history()[0]?.outcome || h.history()[0]?.verdict).toBe("unavailable");
    expect(h.badge().textContent).toMatch(/Unavailable|不可用/);
  });
  it("missing diagnostic evidence cannot manufacture a green pass", async () => {
    const h = harness(); await h.render(); h.api.webrtc.diag.mockResolvedValue({ ok: true, result: {} });
    h.app.openWebRtcDiag(PROFILE.dirId); await flush();
    expect(h.history()[0]?.outcome || h.history()[0]?.verdict).toBe("inconclusive");
  });
  it("legacy local summaries without evidence or a verdict are not Pass", async () => {
    const h = harness(); h.memory.set(HEALTH_KEY, JSON.stringify({ [PROFILE.dirId]: [{ kind: "env", at: Date.now(), detail: "legacy synthetic row" }] }));
    await h.render(); expect(h.badge().textContent).not.toMatch(/\bPass\b|通过/);
  });
  it("history rows use the outcome, not an empty host-IP list, and replay probe failure", async () => {
    const h = harness(); h.api.webrtc.diagHistory.mockResolvedValue({ entries: [rtc({ error: "historical synthetic failure" }, "error").result] });
    h.app.openWebRtcDiag(PROFILE.dirId); await flush();
    const row = h.el("webrtc-diag-history").querySelector("[data-webrtc-hist]")!;
    expect(!!row.querySelector('path[d="M5 12.5 10 17.5 19 7"]')).toBe(false); row.click();
    expect(h.el("webrtc-diag-history").textContent).toContain("historical synthetic failure");
  });
  it.each(["env", "webrtc"])("refreshes %s card summary without losing selection, search or draft", async kind => {
    const h = harness(); await h.render(); h.authority(kind, "pass");
    const checkbox = h.card().querySelector(".profile-select-checkbox")!; checkbox.checked = true;
    (h.el("profile-list") as any).onchange({ target: checkbox });
    h.el("agent-browser-meta-name").value = "unsaved synthetic draft"; h.el("dlg-agent-browser-seed").showModal();
    const search = h.el("cookie-search"); // Existing unrelated search input must also survive a health-only card refresh.
    search.value = "Health synthetic";
    h.menu(kind); await flush(); await h.tick();
    expect(h.badge().textContent).toMatch(/Pass|通过/);
    expect(h.card().querySelector(".profile-select-checkbox")?.checked).toBe(true);
    expect(h.el("agent-browser-meta-name").value).toBe("unsaved synthetic draft");
    if (search) expect(search.value).toBe("Health synthetic");
  });
  it("baseline capture is baseline-established, not a stability pass", async () => {
    const h = harness(); await h.render(); h.menu("lock"); await flush(); await h.tick();
    expect(h.history()[0]?.outcome || h.history()[0]?.verdict).toBe("baseline-established");
    expect(h.badge().textContent).not.toMatch(/\bPass\b|通过/);
  });
  it("risky baseline capture does not become PASS", async () => {
    const h = harness(); await h.render(); h.api.browser.captureBaseline.mockResolvedValue({ ok: true, fields: 8, risky: true });
    h.menu("lock"); await flush(); expect(h.history()[0]?.outcome || h.history()[0]?.verdict).not.toBe("pass");
  });
  it("cached four-field alignment remains inconclusive when no conflicts were found", async () => {
    const h = harness(); await h.render(); h.menu("consistency"); await flush(); await h.tick();
    expect(h.badge().textContent).not.toMatch(/\bPass\b|通过/);
  });
});

describe("health renderer request ownership and truthful clears", () => {
  it("closing the dialog isolates a late response and does not claim cancellation", async () => {
    const h = harness(), pending = deferred(); h.api.browser.envRisk.mockReturnValue(pending.promise);
    h.app.openEnvRisk(PROFILE.dirId); await flush(); h.el("dlg-env-risk").close();
    const before = h.el("env-risk-body").innerHTML; pending.resolve(env()); await flush();
    expect(h.el("env-risk-body").innerHTML).toBe(before); expect(h.history()).toEqual([]);
  });
  it("switching profile isolates stale diagnostic and history replies", async () => {
    const h = harness(), first = deferred(), second = deferred(); h.api.browser.envRisk.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.app.openEnvRisk(PROFILE.dirId); await flush(); h.app.openEnvRisk(PROFILE_B.dirId); await flush();
    second.resolve(env({ summary: "B-result", findings: [{ severity: "medium", code: "B", message: "B-result", fix: "synthetic" }] }, "warn")); await flush();
    const before = h.el("env-risk-body").innerHTML; first.resolve(env({ summary: "A-result" })); await flush();
    expect(h.el("env-risk-body").innerHTML).toBe(before);
  });
  it("a failed environment clear retains history and does not report success", async () => {
    const h = harness(); h.app.openEnvRisk(PROFILE.dirId); await flush(); h.api.browser.envRiskClear.mockResolvedValue({ ok: false, error: "synthetic clear refusal" });
    h.toast.mockClear(); h.app.envRiskClear(); h.confirm(); await flush();
    expect(h.toast.mock.calls.some((c: any[]) => c[1] === "success")).toBe(false);
    expect(h.toast.mock.calls.some((c: any[]) => c[0].includes("synthetic clear refusal"))).toBe(true);
  });
  it("a failed RTC clear must not paint an empty authoritative history", async () => {
    const h = harness(); h.api.webrtc.diagHistory.mockResolvedValue({ entries: [rtc({ summary: "preserve this diagnostic" }).result] });
    h.app.openWebRtcDiag(PROFILE.dirId); await flush(); const before = h.el("webrtc-diag-history").innerHTML;
    h.api.webrtc.diagClear.mockResolvedValue({ success: false, error: "synthetic clear refusal" }); h.app.webRtcDiagClear(); h.confirm(); await flush();
    expect(h.el("webrtc-diag-history").innerHTML).toBe(before);
  });
  it("a successful clear refreshes card and only removes the cleared kind of cache", async () => {
    const h = harness(); await h.render(); h.menu("env"); await flush(); await h.tick();
    h.app.envRiskClear(); h.confirm(); await flush(); await h.tick();
    expect(h.history().some((e: any) => e.kind === "env")).toBe(false);
    expect(h.badge().textContent).not.toMatch(/\bPass\b|通过/);
  });
  it("health waiting does not release a profile slot at the generic detect timeout", async () => {
    const h = harness(), pending = deferred(); h.api.browser.envRisk.mockReturnValue(pending.promise);
    h.app.openEnvRisk(PROFILE.dirId); await flush(); await h.tick(21000);
    h.app.checkDrift(PROFILE.dirId); await flush(); expect(h.api.browser.checkDrift).not.toHaveBeenCalled();
    pending.resolve(env()); await flush(); h.app.checkDrift(PROFILE.dirId); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledTimes(1);
  });
  it("Ping0 consent only navigates and does not record an external scoring pass", async () => {
    const h = harness(); await h.render(); h.menu("risk"); expect(h.api.browser.openRiskCheck).not.toHaveBeenCalled();
    const consent = h.app.confirmHtml.mock.calls.at(-1); expect(consent).toBeTruthy(); consent[1](); await flush();
    expect(h.api.browser.openRiskCheck).toHaveBeenCalledTimes(1); expect(h.history()).toEqual([]);
  });
});

describe("health authoritative history, cancellation and baseline review contract", () => {
  it("retains the legacy health entries and routes beside the explicit network action", async () => {
    const h = harness(); await h.render();
    const options = h.card().querySelector('[data-action="health"]')!.querySelectorAll("option").map(o => o.value);
    expect(options).toEqual(["", "drift", "lock", "consistency", "env", "webrtc", "network", "risk", "history"]);
    h.authority("drift", "pass"); h.menu("drift"); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledWith(PROFILE.dirId);
    h.menu("lock"); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1);
    h.menu("consistency"); await flush(); expect(h.api.browser.consistencyCheck).toHaveBeenCalledWith(PROFILE.dirId);
    h.menu("env"); await flush(); expect(h.api.browser.envRisk).toHaveBeenCalledTimes(1);
    h.menu("webrtc"); await flush(); expect(h.api.webrtc.diag).toHaveBeenCalledTimes(1);
    h.menu("history"); await flush(); expect(h.app.confirmHtml).toHaveBeenCalled();
    h.menu("risk"); expect(h.api.browser.openRiskCheck).not.toHaveBeenCalled();
    h.app.confirmHtml.mock.calls.at(-1)[1](); await flush(); expect(h.api.browser.openRiskCheck).toHaveBeenCalledTimes(1);
  });
  it.each(["pass", "warn", "risk", "error", "unavailable", "inconclusive", "cancelled", "baseline-established"])("uses authoritative %s on card and history without flattening it to Pass", async outcome => {
    const h = harness(); h.authority("drift", outcome); await h.render();
    expect(h.badge().getAttribute("data-health-outcome")).toBe(outcome);
    h.menu("history"); await flush();
    expect(h.app.confirmHtml.mock.calls.at(-1)[2].detailHtml).toContain(`data-health-outcome="${outcome}"`);
  });
  it("main history overrides a fabricated positive renderer cache and is retrieved by History", async () => {
    const h = harness(); h.memory.set(HEALTH_KEY, JSON.stringify({ [PROFILE.dirId]: [{ kind: "webrtc", at: Date.now(), verdict: "pass", detail: "fabricated renderer cache" }] }));
    h.authority("webrtc", "error", "main synthetic error"); await h.render();
    expect(h.badge().getAttribute("data-health-outcome")).toBe("error");
    h.menu("history"); await flush();
    const detail = h.app.confirmHtml.mock.calls.at(-1)[2].detailHtml;
    expect(detail).toContain("main synthetic error"); expect(detail).not.toContain("fabricated renderer cache");
    expect(JSON.parse(h.memory.get(HEALTH_KEY)!)[PROFILE.dirId][0].detail).toBe("fabricated renderer cache");
  });
  it("a failed history read preserves cached original bytes and shows unverified, not no-history success", async () => {
    const h = harness(), original = JSON.stringify({ [PROFILE.dirId]: [{ kind: "env", at: Date.now(), verdict: "pass", detail: "retained legacy original" }] });
    h.memory.set(HEALTH_KEY, original); h.api.browser.healthHistory.mockRejectedValue(new Error("synthetic history unavailable"));
    await h.render(); expect(h.memory.get(HEALTH_KEY)).toBe(original); expect(h.badge().getAttribute("data-health-outcome")).toBe("inconclusive");
    h.toast.mockClear(); h.menu("history"); await flush();
    expect(h.app.confirmHtml).not.toHaveBeenCalled(); expect(h.toast.mock.calls.some((c: any[]) => c[1] === "error")).toBe(true);
  });
  it("passes unique caller requestId, and accepted cancellation holds the slot until actual settlement", async () => {
    const h = harness(), pending = deferred(); h.api.browser.envRisk.mockReturnValue(pending.promise);
    h.app.openEnvRisk(PROFILE.dirId); await flush(); const opts = h.api.browser.envRisk.mock.calls[0][1];
    expect(opts.requestId).toMatch(/^health-env-/); h.app.cancelEnvRisk(); await flush();
    expect(h.api.browser.healthCancel).toHaveBeenCalledWith(PROFILE.dirId, { kind: "env", requestId: opts.requestId });
    expect(h.el("env-risk-cancel").disabled).toBe(true);
    h.app.checkDrift(PROFILE.dirId); await flush(); expect(h.api.browser.checkDrift).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.some((c: any[]) => /Cancellation requested/.test(c[0]) && /not stopped/.test(c[0]))).toBe(true);
    pending.resolve({ ok: false, outcome: "cancelled", requestId: opts.requestId, code: "HEALTH_CANCELLED", error: "synthetic settled cancellation" }); await flush();
    expect(h.history()[0].outcome).toBe("cancelled");
    h.app.checkDrift(PROFILE.dirId); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledTimes(1);
  });
  it("a cancellation transport timeout says unconfirmed and cannot release the running slot", async () => {
    const h = harness(), run = deferred(), cancel = deferred();
    h.api.browser.envRisk.mockReturnValue(run.promise); h.api.browser.healthCancel.mockReturnValue(cancel.promise);
    h.app.openEnvRisk(PROFILE.dirId); await flush(); h.app.cancelEnvRisk(); await flush(); await h.tick(5100);
    h.app.checkDrift(PROFILE.dirId); await flush(); expect(h.api.browser.checkDrift).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.some((c: any[]) => /not confirmed/.test(c[0]))).toBe(true);
    expect(h.toast.mock.calls.some((c: any[]) => c[1] === "success")).toBe(false);
    cancel.resolve({ success: true, cancelled: true }); run.resolve(env()); await flush();
  });
  it("ignores a mismatched result requestId and assigns the next run a new identity", async () => {
    const h = harness(); h.api.webrtc.diag.mockResolvedValue({ ...rtc(), requestId: "some-other-run" });
    h.app.openWebRtcDiag(PROFILE.dirId); await flush(); const first = h.api.webrtc.diag.mock.calls[0][1].requestId;
    expect(h.history()).toEqual([]); expect(h.el("webrtc-diag-body").textContent).not.toMatch(/Pass|通过/);
    h.app.openWebRtcDiag(PROFILE.dirId); await flush(); expect(h.api.webrtc.diag.mock.calls[1][1].requestId).not.toBe(first);
  });
  it("global cap remains two live checks, and closing does not free either slot", async () => {
    const h = harness(), a = deferred(), b = deferred(); h.api.browser.envRisk.mockReturnValue(a.promise); h.api.webrtc.diag.mockReturnValue(b.promise);
    h.app.openEnvRisk(PROFILE.dirId); h.app.openWebRtcDiag(PROFILE_B.dirId); await flush();
    h.el("dlg-env-risk").close(); h.app.openEnvRisk("health_synthetic_c"); await flush(); expect(h.api.browser.envRisk).toHaveBeenCalledTimes(1);
    a.resolve(env()); await flush(); h.api.browser.envRisk.mockResolvedValue(env()); h.app.openEnvRisk("health_synthetic_c"); await flush(); expect(h.api.browser.envRisk).toHaveBeenCalledTimes(2);
    b.resolve(rtc()); await flush();
  });
  it("clear fences an in-flight diagnostic and earlier history reads, without deleting another kind of cache", async () => {
    const h = harness(), run = deferred(), oldRead = deferred(); await h.render();
    const preserved = { kind: "drift", at: 2000, outcome: "warn", detail: "keep unrelated cached original" };
    h.memory.set(HEALTH_KEY, JSON.stringify({ [PROFILE.dirId]: [preserved] }));
    h.api.browser.envRisk.mockReturnValue(run.promise); h.app.openEnvRisk(PROFILE.dirId); await flush();
    h.api.browser.envRiskHistory.mockReturnValueOnce(oldRead.promise);
    h.app.envRiskClear(); h.confirm(); await flush();
    // Clear has succeeded, but is still verifying its raw-history readback.
    run.resolve(env({ summary: "late must not return" })); await flush(); expect(h.history()).toEqual([preserved]);
    oldRead.resolve({ ok: true, entries: [] }); await flush();
    expect(h.el("env-risk-body").textContent).toBe("Not checked yet"); expect(h.history()).toEqual([preserved]);
    expect(h.history().some((e: any) => e.kind === "env")).toBe(false);
  });
  it("clear followed by readback failure keeps cached bytes and previous rows, with no success toast", async () => {
    const h = harness(); h.api.webrtc.diagHistory.mockResolvedValue({ entries: [rtc({ summary: "keep raw RTC original" }).result] });
    h.app.openWebRtcDiag(PROFILE.dirId); await flush(); const cache = h.memory.get(HEALTH_KEY), before = h.el("webrtc-diag-history").innerHTML;
    h.api.webrtc.diagHistory.mockRejectedValue(new Error("synthetic raw readback failure")); h.toast.mockClear();
    h.app.webRtcDiagClear(); h.confirm(); await flush();
    expect(h.memory.get(HEALTH_KEY)).toBe(cache); expect(h.el("webrtc-diag-history").innerHTML).toContain("keep raw RTC original");
    expect(h.el("webrtc-diag-history").innerHTML.length).toBeGreaterThan(before.length);
    expect(h.toast.mock.calls.some((c: any[]) => c[1] === "success")).toBe(false);
  });
  it("late profile A raw history cannot overwrite profile B after switching", async () => {
    const h = harness(), a = deferred(); h.api.browser.envRiskHistory.mockReturnValueOnce(a.promise).mockResolvedValue({ ok: true, entries: [{ ...env().result, outcome: "warn", summary: "B-history" }] });
    h.app.openEnvRisk(PROFILE.dirId); await flush(); h.app.openEnvRisk(PROFILE_B.dirId); await flush(); const before = h.el("env-risk-history").innerHTML;
    a.resolve({ ok: true, entries: [{ ...env().result, outcome: "risk", summary: "late A-history" }] }); await flush();
    expect(h.el("env-risk-history").innerHTML).toBe(before); expect(before).toContain("B-history");
  });
  it("requires an explicit risky-baseline confirmation, sends only its token once, and preserves risk", async () => {
    const h = harness(); await h.render(); h.api.browser.captureBaseline.mockResolvedValueOnce({ ok: false, outcome: "risk", code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-bound-token", risky: true, drift: [{ field: "platform", baseline: "synthetic-before", current: "synthetic-after" }], baseline: { platform: "synthetic" } })
      .mockResolvedValueOnce({ ok: true, outcome: "risk", risky: true, baselineCommitted: true, fields: 8 });
    h.menu("lock"); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1);
    expect(h.history()[0].outcome).toBe("risk"); const reviewed = h.app.confirm.mock.calls.at(-1)[2].detailHtml;
    expect(reviewed).toContain("platform"); expect(reviewed).toContain("synthetic-before"); expect(reviewed).toContain("synthetic-after");
    expect(reviewed).not.toContain("synthetic-bound-token");
    const accept = h.app.confirm.mock.calls.at(-1)[1]; accept(); await flush();
    expect(h.api.browser.captureBaseline.mock.calls[1]).toEqual([PROFILE.dirId, { confirmationToken: "synthetic-bound-token" }]);
    expect(h.history()[0].outcome).toBe("risk"); accept(); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(2);
  });
  it("stale baseline token is not retried and cannot report a new baseline", async () => {
    const h = harness(); await h.render(); h.api.browser.captureBaseline.mockResolvedValueOnce({ ok: false, outcome: "risk", code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-stale-token", risky: true, drift: [] })
      .mockResolvedValueOnce({ ok: false, outcome: "inconclusive", code: "BASELINE_CONFIRMATION_STALE" });
    h.menu("lock"); await flush(); h.confirm(); await flush();
    expect(h.history()[0].outcome).toBe("inconclusive"); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(2);
    expect(h.toast.mock.calls.some((c: any[]) => /Nothing was replaced/.test(c[0]))).toBe(true);
  });
  it("a committed baseline with a failed separate history write stays established and displays its warning, not rollback", async () => {
    const h = harness(); await h.render(); h.api.browser.captureBaseline.mockResolvedValue({
      ok: true, outcome: "baseline-established", baselineCommitted: true, fields: 8,
      code: "HEALTH_HISTORY_WRITE_FAILED", warning: "synthetic baseline saved; separate health summary write failed",
    });
    h.menu("lock"); await flush();
    expect(h.history()[0].outcome).toBe("baseline-established");
    expect(h.badge().getAttribute("data-health-outcome")).toBe("baseline-established");
    expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1);
    expect(h.toast.mock.calls.some((c: any[]) => c[1] === "warning" && /Baseline recorded/.test(c[0]) && /separate health summary write failed/.test(c[0]))).toBe(true);
    expect(h.toast.mock.calls.some((c: any[]) => /rolled back|rollback|Nothing was replaced|Failed to lock/.test(c[0]))).toBe(false);
  });
  it("a cancelled baseline capture cannot claim a committed or passing baseline", async () => {
    const h = harness(); await h.render(); h.api.browser.captureBaseline.mockResolvedValue({
      ok: false, outcome: "cancelled", code: "HEALTH_CANCELLED", error: "synthetic capture settled after cancellation",
    });
    h.menu("lock"); await flush();
    expect(h.history()[0].outcome).toBe("cancelled"); expect(h.badge().getAttribute("data-health-outcome")).toBe("cancelled");
    expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1);
    expect(h.toast.mock.calls.some((c: any[]) => /Baseline recorded|Baseline replaced/.test(c[0]) || c[1] === "success")).toBe(false);
  });
  it("a newer drift request invalidates a pending baseline-confirmation callback", async () => {
    const h = harness(); await h.render(); h.api.browser.captureBaseline.mockResolvedValue({ ok: false, outcome: "risk", code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "old-review", risky: true, drift: [] });
    h.menu("lock"); await flush(); const accept = h.app.confirm.mock.calls.at(-1)[1]; h.menu("drift"); await flush(); accept(); await flush();
    expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1);
  });
  it("report export does not rerun host diagnostics and an unreadable raw original cannot become a successful empty report", async () => {
    const h = harness(); h.app.openEnvRisk(PROFILE.dirId); await flush(); h.api.browser.envRiskHistory.mockRejectedValue(new Error("synthetic original unreadable")); h.toast.mockClear();
    h.app.envRiskExport(); await flush(); expect(h.api.browser.envRisk).toHaveBeenCalledTimes(1);
    expect(h.toast.mock.calls.some((c: any[]) => c[1] === "success")).toBe(false); expect(h.toast.mock.calls.some((c: any[]) => /synthetic original unreadable/.test(c[0]))).toBe(true);
  });
  it("exports the exact retained raw evidence as a download intent without running a new diagnostic", async () => {
    const h = harness(), raw = { ...env({ summary: "retained synthetic raw entry", cnFonts: ["synthetic-font"] }).result, outcome: "inconclusive", requestId: "stored-synthetic-run" };
    h.api.browser.envRiskHistory.mockResolvedValue({ ok: true, entries: [raw] }); h.app.openEnvRisk(PROFILE.dirId); await flush();
    h.app.envRiskExport(); await flush(); expect(h.downloadIntents).toHaveLength(1);
    const payload = JSON.parse(await h.downloadIntents[0].text());
    expect(payload.history).toEqual([raw]); expect(payload.latest).toEqual(raw); expect(payload.profile.dirId).toBe(PROFILE.dirId);
    expect(h.api.browser.envRisk).toHaveBeenCalledTimes(1); // No browser download or real file write is modeled here.
  });
  it.each(["error", "unavailable", "inconclusive"])("retains raw RTC evidence when transport ok=false and business outcome=%s", async outcome => {
    const h = harness(); await h.render(); h.authority("webrtc", outcome);
    h.api.webrtc.diag.mockResolvedValue({ ...rtc({ rtcAvailable: outcome !== "unavailable", error: "synthetic negative probe evidence", rttMs: null }, outcome), ok: false });
    h.app.openWebRtcDiag(PROFILE.dirId); await flush();
    expect(h.el("webrtc-diag-body").querySelector(".status-badge")?.getAttribute("data-health-outcome")).toBe(outcome);
    expect(h.el("webrtc-diag-body").textContent).toContain("synthetic negative probe evidence");
    expect(h.el("webrtc-diag-body").textContent).toContain("ICE candidates"); expect(h.history()[0].outcome).toBe(outcome);
    expect(h.badge().getAttribute("data-health-outcome")).toBe(outcome);
  });
  it("labels ICE-only scope and null RTT as unmeasured rather than claiming routing/latency acceptance", async () => {
    const h = harness(); h.api.webrtc.diag.mockResolvedValue(rtc({ rttMs: null })); h.app.openWebRtcDiag(PROFILE.dirId); await flush();
    const body = h.el("webrtc-diag-body").textContent;
    expect(body).toContain("ICE candidate exposure on the current page only"); expect(body).toContain("does not establish a remote peer connection");
    expect(body).toContain("RTT: Not measured (requires a connected peer)"); expect(body).not.toContain("RTT: 0ms");
  });
  it("malformed positive canonical history cannot turn missing source evidence into Pass", async () => {
    const h = harness(); h.api.browser.healthHistory.mockResolvedValue({ entries: [{ kind: "env", at: Date.now(), outcome: "pass", summary: "no authority source" }] });
    await h.render(); expect(h.badge().getAttribute("data-health-outcome")).toBe("inconclusive"); expect(h.badge().textContent).not.toMatch(/Pass|通过/);
  });
  it("sync generation invalidation also fences health replies and leaves the unsaved form intact", async () => {
    const h = harness(), pending = deferred(); await h.render(); h.api.browser.envRisk.mockReturnValue(pending.promise);
    h.el("agent-browser-meta-name").value = "synthetic unsaved sync draft"; h.app.openEnvRisk(PROFILE.dirId); await flush();
    h.app.invalidateProfilesForSync(); const before = h.el("env-risk-body").innerHTML;
    pending.resolve(env()); await flush(); expect(h.el("env-risk-body").innerHTML).toBe(before);
    expect(h.el("agent-browser-meta-name").value).toBe("synthetic unsaved sync draft"); expect(h.history()).toEqual([]);
  });
  it("ordinary IPC budgets are unchanged, while the health slow notice explicitly does not claim a stop", async () => {
    const h = harness(), pending = deferred();
    expect({ ...h.app.ipc.TIMEOUTS }).toEqual({ launch: 30000, stop: 10000, detect: 20000, list: 5000, write: 15000, default: 15000 });
    h.api.browser.envRisk.mockReturnValue(pending.promise); h.app.openEnvRisk(PROFILE.dirId); await flush(); await h.tick(21000);
    expect(h.toast.mock.calls.some((c: any[]) => /Work may continue in the background/.test(c[0]) && /does not stop/.test(c[0]))).toBe(true);
    pending.resolve(env()); await flush();
  });
});

describe("health localization and mirror contract", () => {
  it.each(["env", "webrtc"])("localizes the %s loading child without marking the dynamic result body for i18n replacement", async kind => {
    const h = harness(), body = h.el(kind === "env" ? "env-risk-body" : "webrtc-diag-body");
    expect(body.getAttribute("data-i18n")).toBeNull();
    expect(body.querySelector('[data-i18n="common.loading"]') !== null).toBe(true);
    h.window.i18n.set("zh-CN");
    expect(body.textContent.trim()).toBe(h.window.i18n.t("common.loading"));
    if (kind === "env") h.app.openEnvRisk(PROFILE.dirId); else h.app.openWebRtcDiag(PROFILE.dirId);
    await flush();
    expect(body.querySelector('[data-i18n="common.loading"]') !== null).toBe(false);
    h.window.i18n.set("en-US"); await flush();
    expect(body.querySelector(".status-badge")?.getAttribute("data-health-outcome")).toBe("pass");
    expect(body.textContent).toContain("synthetic");
    expect(body.textContent.trim()).not.toBe(h.window.i18n.t("common.loading"));
  });
  it("has byte-identical dictionaries, exact new-key coverage, no shadowed new keys or mismatched placeholders", () => {
    expect(fs.readFileSync(path.join(ROOT, "i18n.js")).equals(Buffer.from(I18N))).toBe(true);
    const source = ts.createSourceFile("i18n.js", I18N, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), counts = new Map<string, number>();
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && (node.name.text.startsWith("health.") || node.name.text === "webrtc.sum.inconclusive")) counts.set(node.name.text, (counts.get(node.name.text) || 0) + 1);
      ts.forEachChild(node, visit);
    }
    visit(source); const zh = harness("zh-CN"), en = harness("en-US");
    expect(counts.size).toBeGreaterThan(35);
    for (const [key, count] of counts) {
      expect(count, key + " should occur once per locale and nowhere else").toBe(2);
      const a = zh.window.i18n.t(key, "__MISSING__"), b = en.window.i18n.t(key, "__MISSING__");
      expect(a, key).not.toBe("__MISSING__"); expect(b, key).not.toBe("__MISSING__"); expect(a, key).toMatch(/[㐀-鿿]/);
      expect([...a.matchAll(/\{[^}]+\}/g)].map(m => m[0]).sort(), key).toEqual([...b.matchAll(/\{[^}]+\}/g)].map(m => m[0]).sort());
      expect(a + b, key).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
  it("switches modal/card/history outcome labels to Chinese without clobbering results or SVG", async () => {
    const h = harness(); await h.render(); h.authority("webrtc", "unavailable"); h.api.webrtc.diag.mockResolvedValue(rtc({ rtcAvailable: false }, "unavailable"));
    h.api.webrtc.diagHistory.mockResolvedValue({ entries: [{ ...rtc({ rtcAvailable: false }, "unavailable").result, outcome: "unavailable" }] });
    h.app.openWebRtcDiag(PROFILE.dirId); await flush(); h.window.i18n.set("zh-CN"); await flush();
    expect(h.el("webrtc-diag-body").querySelector(".status-badge")?.textContent.trim()).toBe("不可用");
    expect(h.badge().textContent).toContain("不可用"); expect(h.el("webrtc-diag-history").textContent).toContain("不可用");
    expect(!!h.el("webrtc-diag-body").querySelector("svg")).toBe(true); expect(h.el("webrtc-diag-body").textContent).not.toBe("加载中…");
  });
});

describe("proxy health re-read boundary", () => {
  it("failed re-read after detect is visible instead of an empty catch", async () => {
    const h = harness(); h.api.proxy.list.mockResolvedValue([{ name: "synthetic-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 1080 }, isDefault: false }]);
    await h.app.loadProxies(); await flush();
    const card = h.el("proxy-list").querySelector(".profile-card")!;
    h.api.proxy.healthGet.mockRejectedValue(new Error("synthetic health read failure"));
    h.app.detectProxyIntoCard("synthetic-proxy", card); await flush();
    expect(card.textContent + h.toast.mock.calls.map((c: any[]) => c[0]).join(" ")).toMatch(/health.*(unavailable|failed)|synthetic health read failure/i);
  });
  it("retains previous proxy health data but cannot paint a fresh Good when its authoritative read fails", async () => {
    const h = harness(), stored = { entries: [{ proxyName: "synthetic-proxy", risk: "good", score: 99, history: [{ at: 1000, success: true, exitIp: "203.0.113.9" }] }], summary: { total: 1, good: 1, watch: 0, poor: 0 } };
    h.api.proxy.list.mockResolvedValue([{ name: "synthetic-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 1080 } }]);
    h.api.proxy.healthGet.mockResolvedValueOnce(stored); await h.app.loadProxies(); await flush(); expect(h.el("proxy-list").textContent).toContain("Good");
    h.api.proxy.healthGet.mockRejectedValue(new Error("synthetic reload failure")); await h.app.loadProxies(); await flush();
    expect(h.window.__proxyHealth).toEqual(stored); expect(h.el("proxy-list").textContent).toContain("Proxy health unavailable");
    expect(h.el("proxy-list").textContent).not.toContain("Good");
  });
  it("proxy clear followed by failed re-read cannot report success or erase retained health evidence", async () => {
    const h = harness(), stored = { entries: [{ proxyName: "synthetic-proxy", risk: "watch", score: 60, history: [{ at: 1000, success: true, exitIp: "203.0.113.9" }] }], summary: null };
    h.api.proxy.list.mockResolvedValue([{ name: "synthetic-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 1080 } }]);
    h.api.proxy.healthGet.mockResolvedValueOnce(stored); await h.app.loadProxies(); await flush();
    h.api.proxy.healthGet.mockRejectedValue(new Error("synthetic proxy clear readback failure")); h.toast.mockClear(); h.app.clearHealth("synthetic-proxy"); await flush();
    expect(h.window.__proxyHealth).toEqual(stored); expect(h.toast.mock.calls.some((c: any[]) => c[1] === "success")).toBe(false);
    expect(h.el("proxy-list").textContent).toContain("Proxy health unavailable");
  });
  it("an older proxy detection response cannot repaint after clear", async () => {
    const h = harness(), old = deferred(); h.api.proxy.list.mockResolvedValue([{ name: "synthetic-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 1080 } }]);
    await h.app.loadProxies(); await flush(); const card = h.el("proxy-list").querySelector(".profile-card")!;
    h.api.detect.proxyByName.mockReturnValue(old.promise); h.app.detectProxyIntoCard("synthetic-proxy", card); await flush();
    h.app.clearHealth("synthetic-proxy"); await flush(); const before = card.innerHTML;
    old.resolve({ success: true, exitIp: "203.0.113.55" }); await flush(); expect(card.innerHTML).toBe(before);
  });

  it.each(["en-US", "zh-CN"])("shows original source/time and a non-green stale card/history/summary in %s", async language => {
    const h = harness(language), at = Date.parse("2026-10-19T00:00:00Z"); vi.setSystemTime(at);
    const history = [{ at, source: "network", observationId: "synthetic-network-sample", success: true, exitIp: "192.0.2.10" }];
    const entry = { proxyName: "synthetic-proxy", risk: "good", score: 100, freshness: "fresh", checks: 1, successes: 1, lastCheckedAt: at, lastSuccessAt: at, history };
    const detection = { detectedAt: at, source: "cache", observationId: "synthetic-network-sample", success: true, exitIp: "192.0.2.10" };
    h.api.proxy.list.mockResolvedValue([{ name: "synthetic-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 1080 }, detection }]);
    h.api.proxy.healthGet.mockResolvedValue({ entries: [entry], summary: { total: 1, good: 1, watch: 0, poor: 0, stale: 0, unknown: 0 } });
    await h.app.loadProxies(); await flush();
    expect(h.el("proxy-list").querySelector(".proxy-health-row .health-good")).not.toBeNull();
    expect(h.el("proxy-list").textContent).toContain(h.window.i18n.t("proxy.observation.cache"));
    expect(h.el("proxy-list").textContent).toContain(new Date(at).toISOString());
    const original = JSON.stringify(entry);
    vi.setSystemTime(at + 10 * 60_000 + 1);
    // Exact current-read DTO from the separately real-store-tested main reducer,
    // not a renderer-side measurement or a fabricated new observation.
    h.api.proxy.healthGet.mockResolvedValue({ entries: [{ ...entry, risk: "watch", score: 79, freshness: "stale", observationAgeMs: 600001 }],
      summary: { total: 1, good: 0, watch: 1, poor: 0, stale: 1, unknown: 0 } });
    await h.app.loadProxies(); await flush();
    const card = h.el("proxy-list").querySelector(".profile-card")!;
    expect(card.querySelector(".proxy-health-row .health-good")).toBeNull();
    expect(card.querySelector(".proxy-health-row")?.textContent).toContain(h.window.i18n.t("proxy.health.stale"));
    expect(h.el("proxy-list").querySelector(".proxy-health-summary-host")?.textContent).toContain(h.window.i18n.t("proxy.health.stale"));
    (h.el("proxy-list") as any).onclick({ target: card.querySelector('[data-action="toggle-history"]') });
    const timeline = card.querySelector(".proxy-history-text")!;
    expect(timeline.textContent).toContain(h.window.i18n.t("proxy.observation.network"));
    expect(timeline.textContent).toContain(new Date(at).toISOString());
    expect(timeline.textContent).not.toContain(new Date(Date.now()).toISOString());
    expect(JSON.stringify(entry)).toBe(original); expect(h.api.detect.proxyByName).not.toHaveBeenCalled(); expect(h.memory.has("proxy-health")).toBe(false);
  });

  it("legacy null timestamps and missing source stay explicit unknown, never epoch or current time", async () => {
    const h = harness();
    h.api.proxy.list.mockResolvedValue([{ name: "synthetic-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 1080 } }]);
    h.api.proxy.healthGet.mockResolvedValue({ entries: [{ proxyName: "synthetic-proxy", risk: "poor", score: 54, freshness: "unknown", checks: 1,
      history: [{ at: null, success: true, exitIp: "192.0.2.10" }] }], summary: { total: 1, good: 0, watch: 0, poor: 1, unknown: 1 } });
    await h.app.loadProxies(); await flush();
    const card = h.el("proxy-list").querySelector(".profile-card")!;
    (h.el("proxy-list") as any).onclick({ target: card.querySelector('[data-action="toggle-history"]') });
    expect(card.textContent).toContain("Unknown source"); expect(card.textContent).toContain("Measurement time unknown"); expect(card.textContent).toContain("Unverified");
    expect(card.textContent).not.toContain("1970-"); expect(card.querySelector(".proxy-health-row .health-good")).toBeNull();
  });

  it.each(["PROXY_DETECTION_TARGET_CHANGED", "PROXY_DETECTION_STALE", "PROXY_DETECTION_SAVE_FAILED"])("a %s reply renders a failure distinct from its original network measurement", async code => {
    const h = harness(), at = Date.parse("2026-10-19T00:00:00Z");
    h.api.proxy.list.mockResolvedValue([{ name: "synthetic-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 1080 } }]);
    h.api.detect.proxyByName.mockResolvedValue({ success: false, code, observedAt: at, source: "network", observationId: "synthetic-unsaved-measurement", exitIp: "192.0.2.10" });
    await h.app.loadProxies(); await flush(); const card = h.el("proxy-list").querySelector(".profile-card")!;
    await h.app.detectProxyIntoCard("synthetic-proxy", card); await flush();
    const text = card.querySelector(".proxy-detect-result")?.textContent || "";
    expect(text).toMatch(/not (?:be )?saved/); expect(text).toContain("Network measurement"); expect(text).toContain(new Date(at).toISOString());
    expect(text).not.toContain("OK"); expect(card.querySelector(".health-good")).toBeNull();
  });

  it("new source/age/error keys have exact mirror and locale parity without shadowing", () => {
    const keys = ["proxy.health.stale", "proxy.health.unknown", "proxy.row.observation", "proxy.observation.network", "proxy.observation.cache",
      "proxy.observation.unknown-source", "proxy.observation.unknown-time", "proxy.observation.measured-at", "proxy.detect.target-changed", "proxy.detect.stale", "proxy.detect.save-failed", "proxy.detect.unobserved"];
    expect(fs.readFileSync(path.join(ROOT, "i18n.js")).toString()).toBe(I18N);
    const source = ts.createSourceFile("i18n.js", I18N, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), counts = new Map<string, number>();
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && keys.includes(node.name.text)) counts.set(node.name.text, (counts.get(node.name.text) || 0) + 1);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const zh = harness("zh-CN"), en = harness("en-US");
    for (const key of keys) {
      expect(counts.get(key), key).toBe(2);
      const a = zh.window.i18n.t(key, "__MISSING__"), b = en.window.i18n.t(key, "__MISSING__");
      expect(a, key).toMatch(/[㐀-鿿]/); expect(b, key).not.toBe("__MISSING__");
      expect([...a.matchAll(/\{[^}]+\}/g)].map(m => m[0]), key).toEqual([...b.matchAll(/\{[^}]+\}/g)].map(m => m[0]));
    }
  });
});
