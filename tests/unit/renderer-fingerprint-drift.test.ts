// Owned synthetic DOM/VM: production i18n/core/IPC/comparison/profiles run intact.
// Only preload receipts and toast presentation are replaced. No Electron, real
// browser, process, network, user data or durable backend storage is exercised.
// Native modal focus/trapping, layout and service classification are NOT proved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "src/renderer/css/style.css"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");
const MODULES = ["icons", "core", "ipc", "fingerprint-drift", "profiles"];
const SOURCES = Object.fromEntries(MODULES.map(name => [name, fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${name}.js`), "utf8")]));
const ID = "fingerprint-synthetic-a", OTHER = "fingerprint-synthetic-b", AT = Date.parse("2024-01-02T03:04:05Z");
const HEALTH_KEY = "agent-browser-health-history-v1";
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
type Handler = (event: any) => void;

// Bounded surface, matching the existing health renderer boundary. Unsupported
// selectors or API calls fail rather than manufacturing positive evidence.
class Element {
  attributes: Record<string, string> = {};
  children: Element[] = [];
  parentNode: Element | null = null;
  style: Record<string, string> = {};
  listeners: Record<string, Handler[]> = {};
  dataset: Record<string, string>;
  private text = "";
  private input = "";
  checked = false;
  disabled = false;
  scrollTop = 0;
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
  get innerHTML(): string { return escape(this.text) + this.children.map(c => c.tagName === "#TEXT" ? escape(c.textContent) : "<" + c.tagName.toLowerCase() + Object.entries(c.attributes).map(([k, v]) => ` ${k}="${escape(v)}"`).join("") + ">" + c.innerHTML + "</" + c.tagName.toLowerCase() + ">").join(""); }
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
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", preventDefault() {} }); }
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
        ok &&= prefix === "." ? node.classList.contains(name) : prefix === "#" ? node.id === name : value === undefined ? node.getAttribute(attr) !== null : node.getAttribute(attr) === value;
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
      const tag = /^<\/([\w-]+)/.exec(token)![1].toUpperCase(), index = stack.map(node => node.tagName).lastIndexOf(tag);
      if (index > 0) stack.splice(index);
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
function strict<T extends object>(obj: T, prefix: string): T {
  return new Proxy(obj, { get(target, key, receiver) {
    if (typeof key === "symbol" || key === "then") return Reflect.get(target, key, receiver);
    if (!(key in target)) throw new Error("Unmodeled API capability: " + prefix + "." + key);
    return Reflect.get(target, key, receiver);
  } });
}
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 90; i++) await Promise.resolve(); }
function comparison(changes: any[] = [], patch: any = {}) {
  // The fixture supplies main's classification; this test does not classify data.
  return { schemaVersion: 1, policyVersion: 2, id: "synthetic-report-a", dirId: ID, observedAt: AT, source: "manual", hasBaseline: true,
    fields: 9, baselineFields: 10, availableFields: 8, comparedFields: 17, saved: true,
    counts: { risk: changes.filter(row => row.severity === "risk").length, review: changes.filter(row => row.severity === "review").length,
      info: changes.filter(row => row.severity === "info").length, unavailable: changes.filter(row => row.severity === "unavailable").length },
    changes, risky: changes.some(row => row.severity === "risk"), partial: changes.some(row => row.severity === "unavailable"), ...patch };
}
function harness(language = "en-US", running = true) {
  const document: any = {}, root = new Element(document, "#DOCUMENT"), events: Record<string, Handler[]> = {};
  parseInto(HTML, root);
  Object.assign(document, {
    readyState: "loading", getElementById: (id: string) => root.querySelector("#" + id),
    querySelector: (selector: string) => root.querySelector(selector), querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    createElement: (tag: string) => new Element(document, tag.toUpperCase()), createDocumentFragment: () => new Element(document, "#FRAGMENT"),
    createTextNode: (text: string) => { const el = new Element(document, "#TEXT"); el.textContent = text; return el; },
    addEventListener: (name: string, fn: Handler) => (events[name] ||= []).push(fn),
    dispatchEvent: (event: any) => (events[event.type] || []).forEach(fn => fn(event)),
  });
  document.body = document.querySelector("body"); document.documentElement = document.querySelector("html"); document.activeElement = document.body;
  const profile = { dirId: ID, name: "Synthetic fingerprint", engine: "chromium", platform: "macos", fingerprintMode: "managed", fingerprintSeed: 12345, timezone: "UTC", locale: "en-US", proxyMode: "none", tags: [], syncStatus: "never", running };
  const api = strict({ observability: null,
    browser: strict({
      status: vi.fn(async (_id: string): Promise<any> => ({ running })),
      driftReport: vi.fn(async (_id: string): Promise<any> => ({ ok: true, report: null, currentConfigMatches: false, canUpdateBaseline: false })),
      checkDrift: vi.fn(async (_id: string): Promise<any> => ({ ok: true, outcome: "pass", report: comparison() })),
      captureBaseline: vi.fn(async (_id: string, _options?: any): Promise<any> => { throw new Error("Baseline receipt must be declared explicitly"); }),
      resetBaseline: vi.fn(async (_id: string, _options?: any): Promise<any> => { throw new Error("No automatic reset is permitted"); }),
      launch: vi.fn(async (_id: string, _options?: any): Promise<any> => { throw new Error("Launch receipt must be declared explicitly"); }),
      stop: vi.fn(async (_id: string): Promise<any> => { throw new Error("No automatic stop is permitted"); }),
      list: vi.fn(async (): Promise<any> => [{ ...profile, running }]),
      healthHistory: vi.fn(async (_id: string): Promise<any> => ({ entries: [] })),
      binary: vi.fn(async (): Promise<any> => ({ installed: true, version: "synthetic", installedVersions: [] })),
      engineStatus: vi.fn(async (): Promise<any> => ({ firefox: { installed: true } })),
    }, "browser"),
    proxy: strict({ list: vi.fn(async () => []) }, "proxy"),
    app: strict({ setLanguage: vi.fn(async () => undefined) }, "app"),
  }, "api");
  const memory = new Map<string, string>(), window: any = { agentBrowserAPI: api };
  const context = vm.createContext({ window, document, console, navigator: { language }, setTimeout, clearTimeout, Date, Math,
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) },
    CustomEvent: function(type: string, options: any) { return { type, ...options }; },
    Option: function(text: string, value: string) { const el = document.createElement("option"); el.textContent = text; el.value = value; return el; },
  });
  vm.runInContext(I18N, context); window.i18n.apply();
  for (const name of ["icons", "core", "ipc"]) vm.runInContext(SOURCES[name], context, { filename: name + ".js" });
  const app: any = window.agentBrowser;
  app.helpers.toast = vi.fn(); app.refresh = vi.fn(); app.state.currentTab = "profiles";
  app.renderViewState = vi.fn((el: Element, options: any) => { el.textContent = options.error || options.empty || options.loading || ""; });
  for (const name of ["fingerprint-drift", "profiles"]) vm.runInContext(SOURCES[name], context, { filename: name + ".js" });
  const el = (id: string): Element => { const found = document.getElementById(id); if (!found) throw new Error("Missing production element " + id); return found; };
  const candidate = async (report = comparison([{ field: "uaHighEntropy.architecture", baseline: "arm", current: "x86", category: "identity", severity: "risk", reason: "identity-changed" }], { source: "launch", baselineCandidate: true })) => {
    running = false;
    api.browser.driftReport.mockResolvedValue({ ok: true, report, currentConfigMatches: true, canUpdateBaseline: true });
    app.showFingerprintComparison(ID, { checked: true, risky: true, report }, { source: "launch", historical: true, blocked: true }); await flush();
    expect(el("fingerprint-drift-update").hidden).toBe(false);
    return report;
  };
  return { app, api, window, document, memory, el, candidate, body: () => el("fingerprint-drift-body"), toast: app.helpers.toast,
    history: () => JSON.parse(memory.get(HEALTH_KEY) || "{}")[ID] || [], setRunning: (value: boolean) => { running = value; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2031-03-02T04:05:06Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

for (const language of ["en-US", "zh-CN"]) {
  describe(`fingerprint user journey (${language}, production renderer)`, () => {
    it("shows first-baseline details, then captures only on the separate explicit live action", async () => {
      const h = harness(language), report = comparison([], { hasBaseline: false, baselineFields: 0, comparedFields: 0 });
      h.api.browser.checkDrift.mockResolvedValue({ ok: true, outcome: "inconclusive", report });
      h.app.checkDrift(ID); await flush();
      expect(h.el("dlg-fingerprint-drift").open).toBe(true); expect(h.el("dlg-confirm").open).toBe(false);
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.summary.no-baseline"));
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.no-baseline"));
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.coverage.count").replace("{compared}", "0").replace("{available}", "8"));
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.source.manual"));
      expect(h.body().textContent).not.toContain(h.window.i18n.t("fingerprint.historical"));
      expect(h.api.browser.captureBaseline).not.toHaveBeenCalled(); expect(h.api.browser.launch).not.toHaveBeenCalled();
      expect(h.el("fingerprint-drift-capture").hidden).toBe(false);
      h.api.browser.captureBaseline.mockResolvedValue({ ok: true, fields: 9, baselineCommitted: true, outcome: "baseline-established" });
      h.el("fingerprint-drift-capture").click(); await flush();
      expect(h.api.browser.captureBaseline).toHaveBeenCalledExactlyOnceWith(ID, undefined);
      expect(h.history()[0].outcome).toBe("baseline-established");
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.saved"));
      expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.stop).not.toHaveBeenCalled();
    });

    it("shows ordinary resize/sidebar/theme as INFO without warning or changing the reference", async () => {
      const h = harness(language), report = comparison([
        { field: "innerWidth", baseline: 1000, current: 1200, category: "window", severity: "info", reason: "window-geometry" },
        { field: "screen.availWidth", baseline: 1440, current: 1360, category: "environment", severity: "info", reason: "display-environment" },
        { field: "colorScheme", baseline: "light", current: "dark", category: "environment", severity: "info", reason: "runtime-environment" },
      ]), original = JSON.stringify(report);
      h.api.browser.checkDrift.mockResolvedValue({ ok: true, outcome: "inconclusive", report });
      h.app.checkDrift(ID); await flush();
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.summary.info"));
      expect(h.body().querySelectorAll('article[data-fingerprint-severity="info"]')).toHaveLength(3);
      expect(h.body().querySelectorAll('article[data-fingerprint-severity="risk"]')).toHaveLength(0);
      expect(h.toast.mock.calls.some((call: any[]) => call[1] === "warning" || call[1] === "error")).toBe(false);
      expect(h.history()[0].outcome).not.toBe("pass");
      expect(JSON.stringify(report)).toBe(original); expect(h.api.browser.captureBaseline).not.toHaveBeenCalled();
      h.el("fingerprint-drift-recheck").click(); await flush(); expect(h.api.browser.checkDrift).toHaveBeenCalledTimes(2);
    });

    it("keeps pinned display/DPR and seeded outputs strict, with readable architecture and worker leaves", async () => {
      const h = harness(language), fields = ["uaHighEntropy.architecture", "workerIdentity.platform", "screen.width", "devicePixelRatio", "canvasHash", "audioHash", "fontHash", "webglRenderer"];
      const report = comparison(fields.map(field => ({ field, baseline: "synthetic-before", current: "synthetic-after", severity: "risk", category: "identity", reason: "identity-changed" })));
      h.api.browser.checkDrift.mockResolvedValue({ ok: true, outcome: "risk", report }); h.app.checkDrift(ID); await flush();
      expect(h.body().querySelectorAll('article[data-fingerprint-severity="risk"]')).toHaveLength(fields.length);
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.field.architecture"));
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.field.workerIdentity"));
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.field.devicePixelRatio"));
      for (const field of fields) expect(h.body().textContent).toContain(field);
      expect(h.body().textContent).not.toContain(h.window.i18n.t("fingerprint.summary.info"));
    });

    it("shows engine-version REVIEW and unavailable probes separately from identity risk", async () => {
      const h = harness(language), report = comparison([
        { field: "uaHighEntropy.uaFullVersion", baseline: "150.0", current: "151.0", severity: "review", category: "identity", reason: "browser-version" },
        { field: "voices", baseline: ["synthetic"], current: null, severity: "unavailable", category: "availability", reason: "probe-unavailable" },
      ]);
      h.api.browser.checkDrift.mockResolvedValue({ ok: true, outcome: "inconclusive", report }); h.app.checkDrift(ID); await flush();
      expect(h.body().querySelectorAll('article[data-fingerprint-severity="review"]')).toHaveLength(1);
      expect(h.body().querySelectorAll('article[data-fingerprint-severity="unavailable"]')).toHaveLength(1);
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.reason.browser-version"));
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.partial"));
      expect(h.history()[0].outcome).not.toBe("pass");
      expect(h.body().querySelectorAll('article[data-fingerprint-severity="risk"]')).toHaveLength(0);
    });

    it("uses a neutral, acknowledged live-reference confirmation for review-only version changes", async () => {
      const h = harness(language), report = comparison([{ field: "uaHighEntropy.uaFullVersion", baseline: "150.0", current: "151.0", severity: "review", category: "identity", reason: "browser-version" }], { source: "baseline" });
      h.app.showFingerprintComparison(ID, { ok: true, report }, { source: "manual" }); await flush();
      h.api.browser.captureBaseline.mockResolvedValueOnce({ ok: false, outcome: "warn", risky: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-review-only-token", report })
        .mockResolvedValueOnce({ ok: true, baselineCommitted: true, outcome: "baseline-established", risky: false, report: { ...report, acceptedAt: Date.now() } });
      h.el("fingerprint-drift-capture").click(); await flush();
      expect(h.history()[0].outcome).toBe("warn"); expect(h.el("dlg-confirm").open).toBe(true);
      expect(h.el("dlg-confirm-title").textContent).toBe(h.window.i18n.t("health.baseline.risk-title"));
      expect(h.el("dlg-confirm-msg").textContent).toBe(h.window.i18n.t("health.baseline.confirm"));
      expect(h.el("dlg-confirm-detail").textContent).toContain("uaHighEntropy.uaFullVersion"); expect(h.el("dlg-confirm-detail").textContent).toContain("150.0"); expect(h.el("dlg-confirm-detail").textContent).toContain("151.0");
      expect(h.el("dlg-confirm-detail").textContent).not.toMatch(/Risk found|发现风险/);
      expect(h.body().querySelectorAll('article[data-fingerprint-severity="review"]')).toHaveLength(1);
      h.app.doConfirm(); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1);
      h.el("dlg-confirm-ack").checked = true; h.app.doConfirm(); await flush();
      expect(h.api.browser.captureBaseline.mock.calls[1]).toEqual([ID, { confirmationToken: "synthetic-review-only-token" }]);
      expect(h.history()[0].outcome).toBe("baseline-established"); expect(h.api.browser.launch).not.toHaveBeenCalled();
    });

    it("refuses a required-sample baseline capture as unavailable, not identity risk or a new reference", async () => {
      const h = harness(language), report = comparison([{ field: "platform", baseline: "MacIntel", severity: "unavailable", category: "availability", reason: "probe-unavailable" }], { source: "baseline", partial: true });
      h.app.showFingerprintComparison(ID, { ok: true, report: comparison() }, { source: "manual" }); await flush();
      h.api.browser.captureBaseline.mockResolvedValue({ ok: false, outcome: "unavailable", code: "BASELINE_CAPTURE_UNAVAILABLE", error: "synthetic required capture missing", report });
      h.el("fingerprint-drift-capture").click(); await flush();
      expect(h.el("dlg-confirm").open).toBe(false); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1); expect(h.history()[0].outcome).toBe("unavailable");
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.update.capture-unavailable"));
      expect(h.body().querySelectorAll('article[data-fingerprint-severity="unavailable"]')).toHaveLength(1);
      expect(h.body().textContent).not.toContain(h.window.i18n.t("fingerprint.saved")); expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.resetBaseline).not.toHaveBeenCalled();
    });

    it.each(["unchanged", "unavailable", "error"])("always opens manual %s details, not a toast-only conclusion", async kind => {
      const h = harness(language);
      const result = kind === "unchanged" ? { ok: true, outcome: "pass", report: comparison() }
        : kind === "unavailable" ? { ok: false, outcome: "unavailable", checked: false, error: "synthetic required sample missing", report: comparison([{ field: "platform", severity: "unavailable", category: "availability", reason: "probe-unavailable" }], { partial: true }) }
          : null;
      if (result) h.api.browser.checkDrift.mockResolvedValue(result); else h.api.browser.checkDrift.mockRejectedValue(new Error("synthetic probe transport failure"));
      h.app.checkDrift(ID); await flush();
      expect(h.el("dlg-fingerprint-drift").open).toBe(true); expect(h.el("dlg-confirm").open).toBe(false);
      expect(h.body().getAttribute("aria-busy")).toBe("false");
      expect(h.body().textContent).toContain(h.window.i18n.t(kind === "unchanged" ? "fingerprint.summary.unchanged" : "fingerprint.summary.unavailable"));
      if (kind === "error") expect(h.body().textContent).toContain("synthetic probe transport failure");
      expect(h.api.browser.captureBaseline).not.toHaveBeenCalled(); expect(h.api.browser.launch).not.toHaveBeenCalled();
    });

    it("reopens saved manual evidence as historical at its original time without a fresh check or history write", async () => {
      const h = harness(language, false), report = comparison([], { acceptedAt: AT + 60_000 });
      const cache = JSON.stringify({ [ID]: [{ kind: "drift", at: AT, outcome: "risk", detail: "retained original cache" }] }); h.memory.set(HEALTH_KEY, cache);
      h.api.browser.driftReport.mockResolvedValue({ ok: true, report, currentConfigMatches: true, canUpdateBaseline: false });
      await h.app.openFingerprintDetails(ID); await flush();
      const text = h.body().textContent;
      expect(text).toContain(new Date(AT).toLocaleString()); expect(text).not.toContain(new Date(Date.now()).toLocaleString());
      expect(text).toContain(new Date(AT + 60_000).toLocaleString());
      expect(text).toContain(h.window.i18n.t("fingerprint.accepted-at"));
      expect(text).toContain(h.window.i18n.t("fingerprint.historical"));
      expect(h.el("fingerprint-drift-scope").textContent).toBe(h.window.i18n.t("fingerprint.scope"));
      expect(h.el("fingerprint-drift-recheck").hidden).toBe(true); expect(h.el("fingerprint-drift-update").hidden).toBe(true);
      expect(h.el("fingerprint-drift-launch").hidden).toBe(false);
      h.el("fingerprint-drift-close").click(); await h.app.openFingerprintDetails(ID); await flush();
      expect(h.memory.get(HEALTH_KEY)).toBe(cache); expect(h.api.browser.healthHistory).not.toHaveBeenCalled();
      expect(h.api.browser.checkDrift).not.toHaveBeenCalled(); expect(h.api.browser.captureBaseline).not.toHaveBeenCalled();
      expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.stop).not.toHaveBeenCalled();
    });

    it("opens a stopped lastComparison at its original time without recording another check", async () => {
      const h = harness(language, false), report = comparison([{ field: "platform", baseline: "MacIntel", current: "Win32", severity: "risk", category: "identity", reason: "identity-changed" }], { source: "launch" });
      const cache = JSON.stringify({ [ID]: [{ kind: "drift", at: AT, outcome: "risk", detail: "original stopped evidence" }] }); h.memory.set(HEALTH_KEY, cache);
      h.api.browser.checkDrift.mockResolvedValue({ ok: false, code: "PROFILE_NOT_RUNNING", outcome: "unavailable", lastComparison: report });
      h.api.browser.driftReport.mockResolvedValue({ ok: true, report, currentConfigMatches: true, canUpdateBaseline: false });
      h.app.checkDrift(ID); await flush();
      expect(h.body().textContent).toContain("MacIntel"); expect(h.body().textContent).toContain("Win32");
      expect(h.body().textContent).toContain(new Date(AT).toLocaleString()); expect(h.body().textContent).not.toContain(new Date(Date.now()).toLocaleString());
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.historical"));
      expect(h.memory.get(HEALTH_KEY)).toBe(cache); expect(h.api.browser.healthHistory).not.toHaveBeenCalled();
      expect(h.el("fingerprint-drift-recheck").hidden).toBe(true); expect(h.el("fingerprint-drift-update").hidden).toBe(true);
      expect(h.api.browser.captureBaseline).not.toHaveBeenCalled(); expect(h.api.browser.launch).not.toHaveBeenCalled();
    });

    it("shows unavailable/empty persisted details honestly and never invents old values or counts", async () => {
      const h = harness(language, false);
      await h.app.openFingerprintDetails(ID); await flush();
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.summary.empty"));
      expect(h.body().textContent).toContain(h.window.i18n.t("health.drift.time-unavailable"));
      expect(h.body().textContent).not.toContain(h.window.i18n.t("fingerprint.config-changed"));
      h.api.browser.driftReport.mockRejectedValue(new Error("synthetic saved report unreadable"));
      await h.app.openFingerprintDetails(ID); await flush();
      expect(h.body().textContent).toContain("synthetic saved report unreadable"); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.summary.unavailable"));
      expect(h.api.browser.checkDrift).not.toHaveBeenCalled(); expect(h.api.browser.captureBaseline).not.toHaveBeenCalled();
    });

    it("requires a server token, actual human confirm and checked acknowledgement before updating a stopped reference", async () => {
      const h = harness(language, false), report = await h.candidate();
      h.api.browser.captureBaseline.mockResolvedValueOnce({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-human-bound-token", report })
        .mockResolvedValueOnce({ ok: true, baselineCommitted: true, outcome: "risk", report: { ...report, acceptedAt: Date.now() }, warning: "synthetic separate summary warning" });
      h.el("fingerprint-drift-update").click(); await flush();
      expect(h.api.browser.captureBaseline.mock.calls).toEqual([[ID, { reportId: report.id }]]);
      expect(h.el("dlg-confirm").open).toBe(true); expect(h.el("dlg-fingerprint-drift").open).toBe(true);
      expect(h.el("dlg-confirm-ack").checked).toBe(false); expect(h.el("dlg-confirm-ack-label").textContent).toBe(h.window.i18n.t("fingerprint.update.ack"));
      expect(h.el("dlg-confirm-detail").textContent).toContain(h.window.i18n.t("fingerprint.update.scope"));
      expect(h.el("dlg-confirm-detail").textContent).not.toContain("synthetic-human-bound-token");
      h.app.doConfirm(); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1); expect(h.el("dlg-confirm").open).toBe(true);
      h.el("dlg-confirm-ack").checked = true; h.app.doConfirm(); await flush();
      expect(h.api.browser.captureBaseline.mock.calls[1]).toEqual([ID, { reportId: report.id, confirmationToken: "synthetic-human-bound-token" }]);
      expect(h.el("dlg-confirm").open).toBe(false); expect(h.el("dlg-fingerprint-drift").open).toBe(true);
      expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.saved")); expect(h.body().textContent).toContain("synthetic separate summary warning");
      expect(h.body().textContent).toContain(h.window.i18n.t("health.drift.block-boundary"));
      expect(h.body().textContent).not.toMatch(/The stored baseline is unchanged|已保存的基线保持不变/);
      expect(h.window.i18n.t("health.drift.block-boundary")).toMatch(language === "zh-CN" ? /历史记录不证明/ : /historical record does not confirm/);
      expect(h.el("fingerprint-drift-launch-label").textContent).toBe(h.window.i18n.t("fingerprint.start-verify"));
      expect(h.history()[0].outcome).toBe("risk"); expect(h.memory.get(HEALTH_KEY)).not.toContain("synthetic-human-bound-token");
      expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.resetBaseline).not.toHaveBeenCalled(); expect(h.api.browser.stop).not.toHaveBeenCalled();
      h.app.doConfirm(); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(2);
      h.api.browser.launch.mockResolvedValue({ success: false, code: "host-platform-mismatch", error: "synthetic host guard refused" });
      h.el("fingerprint-drift-launch").click(); await flush();
      expect(h.api.browser.list).toHaveBeenCalled(); // Original normal engine gate, not a direct or forced launch.
      expect(h.api.browser.launch).toHaveBeenCalledExactlyOnceWith(ID, undefined);
      expect(h.body().textContent).toContain("synthetic host guard refused");
      expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(2); expect(h.api.browser.stop).not.toHaveBeenCalled();
    });

    it("returns from Cancel/Escape to the read-only comparison without submitting the server token", async () => {
      const h = harness(language, false), report = await h.candidate();
      h.api.browser.captureBaseline.mockResolvedValue({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-cancel-token", report });
      h.el("fingerprint-drift-update").click(); await flush(); h.el("dlg-confirm").close(); await flush();
      expect(h.el("dlg-fingerprint-drift").open).toBe(true); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.update.cancelled"));
      expect(h.api.browser.captureBaseline.mock.calls).toEqual([[ID, { reportId: report.id }]]); expect(h.history()).toEqual([]);
      expect(h.el("fingerprint-drift-update").disabled).toBe(false);
      h.app.doConfirm(); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1);
    });

    it.each([
      { code: "BASELINE_CONFIRMATION_STALE", key: "fingerprint.update.stale" },
      { code: "BASELINE_SNAPSHOT_EXPIRED", key: "fingerprint.update.expired" },
      { code: "BASELINE_IDENTITY_CONFLICT", key: "fingerprint.next.identity-conflict" },
    ])("refuses $code without retry, reset or launch", async ({ code, key }) => {
      const h = harness(language, false); await h.candidate();
      h.api.browser.captureBaseline.mockResolvedValue({ ok: false, code }); h.el("fingerprint-drift-update").click(); await flush();
      expect(h.body().textContent).toContain(h.window.i18n.t(key)); expect(h.el("fingerprint-drift-update").hidden).toBe(true);
      expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1); expect(h.el("dlg-confirm").open).toBe(false);
      expect(h.api.browser.resetBaseline).not.toHaveBeenCalled(); expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.history()).toEqual([]);
    });

    it("never offers a persona conflict as a reference even if a stale eligibility flag says yes", async () => {
      const h = harness(language, false), report = comparison([{ field: "persona.platform", baseline: "macos", current: "windows", severity: "risk", category: "identity", reason: "persona-identity-conflict" }], { source: "launch" });
      h.api.browser.driftReport.mockResolvedValue({ ok: true, report, currentConfigMatches: true, canUpdateBaseline: true });
      await h.app.openFingerprintDetails(ID); await flush();
      expect(h.el("fingerprint-drift-update").hidden).toBe(true); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.next.identity-conflict"));
      expect(h.api.browser.captureBaseline).not.toHaveBeenCalled(); expect(h.api.browser.resetBaseline).not.toHaveBeenCalled();
    });
  });
}

describe("fingerprint view ownership, forward compatibility and accessibility", () => {
  it("distinguishes a bare unchecked launch receipt from failed or unavailable capture", () => {
    for (const language of ["en-US", "zh-CN"]) {
      const h = harness(language);
      expect(h.app.fingerprintLaunchNotice({ checked: false })).toEqual({ warning: false, detail: h.window.i18n.t("launch.drift-not-run"), hasDetails: false });
      const failed = h.app.fingerprintLaunchNotice({ checked: false, error: "synthetic capture error" });
      expect(failed.warning).toBe(true); expect(failed.hasDetails).toBe(true); expect(failed.detail).toContain("synthetic capture error");
      const unavailable = h.app.fingerprintLaunchNotice({ checked: false, report: comparison([{ field: "platform", baseline: "MacIntel", severity: "unavailable", category: "availability", reason: "probe-unavailable" }], { source: "launch", partial: true }) });
      expect(unavailable).toEqual({ warning: true, detail: h.window.i18n.t("launch.drift-unavailable-warning"), hasDetails: true });
      expect(h.app.fingerprintLaunchNotice({ checked: true, risky: true, drift: [{ field: "platform", baseline: "MacIntel", current: "Win32" }] })).toEqual({ warning: true, detail: h.window.i18n.t("launch.drift-risk-warning"), hasDetails: true });
      expect(h.api.browser.checkDrift).not.toHaveBeenCalled(); expect(h.api.browser.captureBaseline).not.toHaveBeenCalled(); expect(h.api.browser.launch).not.toHaveBeenCalled();
    }
  });

  it.each(["risk", "unavailable"])("preserves authoritative %s even when legacy transport inference would call it an error", async outcome => {
    const h = harness();
    h.api.browser.checkDrift.mockResolvedValue({ ok: false, outcome, hasBaseline: false, risky: false, drift: [], error: "synthetic authoritative business conclusion" });
    h.app.checkDrift(ID); await flush();
    expect(h.history()[0].outcome).toBe(outcome);
    expect(h.body().textContent).toContain(h.window.i18n.t(outcome === "risk" ? "fingerprint.summary.risk" : "fingerprint.summary.unavailable"));
    expect(h.toast.mock.calls.some((call: any[]) => call[1] === "success")).toBe(false);
    expect(h.api.browser.captureBaseline).not.toHaveBeenCalled(); expect(h.api.browser.launch).not.toHaveBeenCalled();
  });

  it.each([{ unknown: true, running: false }, { stopping: true, running: true }])("does not offer live actions or launch for unconfirmed/stopping status $running", async status => {
    const h = harness(); h.api.browser.status.mockResolvedValue(status);
    await h.app.openFingerprintDetails(ID); await flush();
    expect(h.el("fingerprint-drift-recheck").hidden).toBe(true); expect(h.el("fingerprint-drift-capture").hidden).toBe(true);
    expect(h.el("fingerprint-drift-launch").hidden).toBe(true); expect(h.el("fingerprint-drift-update").hidden).toBe(true);
    expect(h.body().textContent).toContain(h.window.i18n.t("stopping" in status ? "profile.runtime.stopping-help" : "profile.runtime.unconfirmed-help"));
    expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.stop).not.toHaveBeenCalled();
  });

  it("closing an in-flight manual check fences late results and does not claim cancellation", async () => {
    const h = harness(), pending = deferred(); h.api.browser.checkDrift.mockReturnValue(pending.promise);
    h.app.checkDrift(ID); await flush(); const before = h.body().innerHTML;
    expect(h.body().getAttribute("aria-busy")).toBe("true"); h.el("fingerprint-drift-close").click();
    pending.resolve({ ok: true, outcome: "risk", report: comparison([{ field: "platform", baseline: "a", current: "b", severity: "risk", category: "identity", reason: "identity-changed" }]) }); await flush();
    expect(h.el("dlg-fingerprint-drift").open).toBe(false); expect(h.body().innerHTML).toBe(before);
    expect(h.history()).toEqual([]); expect(h.api.browser.healthHistory).not.toHaveBeenCalled(); expect(h.api.browser.driftReport).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.some((call: any[]) => /cancelled|取消成功/.test(call[0]))).toBe(false);
  });

  it("late profile-A report/status cannot overwrite a later profile-B view or reopen after closure", async () => {
    const h = harness(), a = deferred(), statusA = deferred();
    h.api.browser.driftReport.mockReturnValueOnce(a.promise).mockResolvedValue({ ok: true, report: comparison([], { id: "B", dirId: OTHER, observedAt: AT + 1000 }), currentConfigMatches: true, canUpdateBaseline: false });
    h.api.browser.status.mockReturnValueOnce(statusA.promise).mockResolvedValue({ running: false });
    h.app.openFingerprintDetails(ID); await flush(); h.app.openFingerprintDetails(OTHER); await flush(); const before = h.body().innerHTML;
    a.resolve({ ok: true, report: comparison([{ field: "userAgent", baseline: "late A", current: "late A", severity: "info", category: "window", reason: "window-geometry" }]), currentConfigMatches: true, canUpdateBaseline: true });
    statusA.resolve({ running: true }); await flush();
    expect(h.body().innerHTML).toBe(before); expect(h.el("fingerprint-drift-profile").textContent).toBe(OTHER); expect(h.el("fingerprint-drift-recheck").hidden).toBe(true);
    h.el("dlg-fingerprint-drift").close(); await flush(); expect(h.el("dlg-fingerprint-drift").open).toBe(false);
    expect(h.api.browser.checkDrift).not.toHaveBeenCalled(); expect(h.api.browser.captureBaseline).not.toHaveBeenCalled();
  });

  it("fences earlier status/eligibility reads within the same open epoch after a launch receipt", async () => {
    const h = harness(), oldStatus = deferred(), oldReport = deferred();
    h.api.browser.status.mockReturnValueOnce(oldStatus.promise).mockResolvedValue({ running: true });
    h.api.browser.driftReport.mockReturnValueOnce(oldReport.promise).mockResolvedValue({ ok: true, report: comparison([], { id: "new-receipt" }), currentConfigMatches: true, canUpdateBaseline: false });
    const epoch = h.app.beginFingerprintComparison(ID, { source: "manual" });
    h.app.showFingerprintComparison(ID, { ok: true, report: comparison() }, { epoch, source: "manual" }); await flush();
    h.app.finishFingerprintLaunchView(ID, { success: true, driftCheck: { checked: true, report: comparison([], { id: "new-receipt" }) } }, epoch); await flush();
    const before = h.body().innerHTML; expect(h.el("fingerprint-drift-recheck").hidden).toBe(false);
    oldStatus.resolve({ running: false }); oldReport.resolve({ ok: true, report: comparison(), currentConfigMatches: false, canUpdateBaseline: true }); await flush();
    expect(h.body().innerHTML).toBe(before); expect(h.el("fingerprint-drift-recheck").hidden).toBe(false); expect(h.el("fingerprint-drift-update").hidden).toBe(true);
  });

  it("missing optional coverage counts stay unknown rather than being inferred from sampled surfaces", async () => {
    const h = harness(), report = comparison([], { comparedFields: undefined, availableFields: undefined, baselineFields: undefined });
    h.app.showFingerprintComparison(ID, { ok: true, report }, { source: "manual" }); await flush();
    expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.coverage.count").replace("{compared}", h.window.i18n.t("common.unknown")).replace("{available}", h.window.i18n.t("common.unknown")));
    expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.surfaces.count").replace("{sampled}", "9").replace("{baseline}", h.window.i18n.t("common.unknown")));
    expect(h.api.browser.captureBaseline).not.toHaveBeenCalled();
  });

  it("config-changed and restore-invalidated snapshots stay historical, with no candidate acceptance or browser stop", async () => {
    const h = harness("en-US", false), report = comparison([], { source: "launch", baselineCandidate: true });
    h.api.browser.driftReport.mockResolvedValue({ ok: true, report, currentConfigMatches: false, canUpdateBaseline: true });
    await h.app.openFingerprintDetails(ID); await flush();
    expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.config-changed")); expect(h.el("fingerprint-drift-update").hidden).toBe(true);
    const oldRead = deferred(); h.api.browser.driftReport.mockReturnValue(oldRead.promise); h.app.openFingerprintDetails(ID); await flush();
    h.app.invalidateProfilesForSync(); const before = h.body().innerHTML;
    oldRead.resolve({ ok: true, report, currentConfigMatches: true, canUpdateBaseline: true }); await flush();
    expect(h.body().innerHTML).toBe(before); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.restored-boundary"));
    expect(h.el("fingerprint-drift-update").hidden).toBe(true); expect(h.api.browser.stop).not.toHaveBeenCalled(); expect(h.api.browser.launch).not.toHaveBeenCalled();
  });

  it.each(["close", "newer-check"])("a %s while confirmation is open makes its human callback stale", async action => {
    const h = harness("en-US", false), report = await h.candidate();
    h.api.browser.captureBaseline.mockResolvedValue({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-stale-review", report });
    h.el("fingerprint-drift-update").click(); await flush();
    if (action === "close") h.el("dlg-fingerprint-drift").close(); else { h.app.checkDrift(ID); await flush(); }
    h.el("dlg-confirm-ack").checked = true; h.app.doConfirm(); await flush();
    expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1); expect(h.api.browser.launch).not.toHaveBeenCalled();
    if (action === "close") expect(h.el("dlg-fingerprint-drift").open).toBe(false);
  });

  it("a server-stale commit is single-use and cannot report a saved reference", async () => {
    const h = harness("en-US", false), report = await h.candidate();
    h.api.browser.captureBaseline.mockResolvedValueOnce({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-server-stale", report })
      .mockResolvedValueOnce({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    h.el("fingerprint-drift-update").click(); await flush(); h.el("dlg-confirm-ack").checked = true; h.app.doConfirm(); await flush();
    expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(2); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.update.stale"));
    expect(h.body().textContent).not.toContain(h.window.i18n.t("fingerprint.saved")); expect(h.history()).toEqual([]);
    h.app.doConfirm(); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(2);
  });

  it("accepts identical reviewed content despite backend-like delivery/authority flag differences", async () => {
    const h = harness("en-US", false), report = await h.candidate();
    const trusted = { ...structuredClone(report), baselineCandidate: false, saved: false, warning: "synthetic transient delivery warning", acceptedAt: AT + 1000 };
    h.api.browser.captureBaseline.mockResolvedValue({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-reviewed-content-token", report: trusted });
    h.el("fingerprint-drift-update").click(); await flush();
    expect(h.el("dlg-confirm").open).toBe(true); expect(h.el("dlg-confirm-ack").checked).toBe(false);
    expect(h.body().textContent).not.toContain(h.window.i18n.t("fingerprint.update.stale"));
    expect(h.api.browser.captureBaseline.mock.calls).toEqual([[ID, { reportId: report.id }]]);
    h.el("dlg-confirm").close(); await flush();
    expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1); expect(h.api.browser.launch).not.toHaveBeenCalled();
  });

  it("refuses unseen trusted-preview values even when the report ID and profile ID are unchanged", async () => {
    const h = harness("en-US", false), report = await h.candidate();
    const changed = structuredClone(report); changed.changes[0].current = "synthetic-unseen-architecture";
    h.api.browser.captureBaseline.mockResolvedValue({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-unseen-token", report: changed });
    h.el("fingerprint-drift-update").click(); await flush();
    expect(h.el("dlg-confirm").open).toBe(false); expect(h.el("dlg-fingerprint-drift").open).toBe(true);
    expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.update.stale")); expect(h.body().textContent).not.toContain("synthetic-unseen-architecture");
    expect(h.el("fingerprint-drift-update").hidden).toBe(true);
    expect(h.api.browser.captureBaseline.mock.calls).toEqual([[ID, { reportId: report.id }]]);
    h.app.doConfirm(); await flush(); expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1);
    expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.resetBaseline).not.toHaveBeenCalled(); expect(h.history()).toEqual([]);
  });

  it("does not invent a confirmation token or leave a false confirmation-pending state", async () => {
    const h = harness("en-US", false); await h.candidate();
    h.api.browser.captureBaseline.mockResolvedValue({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED" });
    h.el("fingerprint-drift-update").click(); await flush();
    expect(h.api.browser.captureBaseline).toHaveBeenCalledTimes(1); expect(h.el("dlg-confirm").open).toBe(false);
    expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.update.failed")); expect(h.el("fingerprint-drift-update").hidden).toBe(true);
    expect(h.api.browser.resetBaseline).not.toHaveBeenCalled(); expect(h.api.browser.launch).not.toHaveBeenCalled();
  });

  it("closing a user-requested retry launch also fences its late blocked fingerprint receipt", async () => {
    const h = harness("en-US", false), launch = deferred();
    await h.app.openFingerprintDetails(ID); await flush(); h.api.browser.launch.mockReturnValue(launch.promise);
    h.el("fingerprint-drift-launch").click(); await flush();
    expect(h.api.browser.launch).toHaveBeenCalledExactlyOnceWith(ID, undefined);
    h.el("dlg-fingerprint-drift").close();
    launch.resolve({ success: false, code: "fingerprint-drift", driftCheck: { checked: true, report: comparison([], { source: "launch" }) } }); await flush();
    expect(h.el("dlg-fingerprint-drift").open).toBe(false); expect(h.api.browser.launch).toHaveBeenCalledTimes(1); expect(h.api.browser.stop).not.toHaveBeenCalled();
  });

  it("closing after human confirmation does not reopen on a late commit or claim rollback", async () => {
    const h = harness("en-US", false), report = await h.candidate(), commit = deferred();
    h.api.browser.captureBaseline.mockResolvedValueOnce({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", confirmationToken: "synthetic-pending-commit", report }).mockReturnValueOnce(commit.promise);
    h.el("fingerprint-drift-update").click(); await flush(); h.el("dlg-confirm-ack").checked = true; h.app.doConfirm(); await flush();
    h.el("dlg-fingerprint-drift").close(); const before = h.body().innerHTML;
    commit.resolve({ ok: true, baselineCommitted: true, outcome: "risk", report }); await flush();
    expect(h.el("dlg-fingerprint-drift").open).toBe(false); expect(h.body().innerHTML).toBe(before);
    expect(h.toast.mock.calls.some((call: any[]) => /rollback|rolled back|cancelled/.test(call[0]))).toBe(false); expect(h.api.browser.launch).not.toHaveBeenCalled();
  });

  it("escapes fields/reasons/full values, uses neutral unknown fallback and preserves expansions across language changes", async () => {
    const h = harness(), long = '<img src=x onerror="synthetic">' + "long-".repeat(100);
    const report = comparison([
      { field: "uaHighEntropy.architecture", baseline: "arm", current: "x86", severity: "risk", category: "identity", reason: "identity-changed" },
      { field: '<script onload="synthetic">', baseline: long, current: "", severity: "future-severity", category: "future", reason: '<svg onload="synthetic">' },
      { field: "workerIdentity.platform", current: null, severity: "unavailable", category: "availability", reason: "probe-unavailable" },
    ]);
    h.app.showFingerprintComparison(ID, { ok: true, report }, { source: "manual" }); await flush();
    expect(h.body().querySelector("img")).toBeNull(); expect(h.body().querySelector("script")).toBeNull(); expect(h.body().querySelector("[onload]")).toBeNull();
    expect(h.body().textContent).toContain(long); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.reason.unknown-field"));
    expect(h.body().querySelectorAll('article[data-fingerprint-severity="unknown"]')).toHaveLength(1);
    expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.value.missing")); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.value.empty")); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.value.null"));
    const expanded = h.body().querySelector("[data-fingerprint-expand]")!; expanded.open = true;
    const expandId = expanded.dataset.fingerprintExpand; h.window.i18n.set("zh-CN"); await flush();
    expect(h.body().querySelector(`[data-fingerprint-expand="${expandId}"]`)?.open).toBe(true);
    expect(h.body().textContent).toContain("处理器架构"); expect(h.body().textContent).toContain("uaHighEntropy.architecture"); expect(h.body().textContent).toContain(long);
    expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.value.expand").replace("{n}", String(long.length)));
    expect(h.api.browser.checkDrift).not.toHaveBeenCalled(); expect(h.api.browser.captureBaseline).not.toHaveBeenCalled();
    h.window.i18n.set("en-US"); await flush(); expect(h.body().textContent).toContain("CPU architecture");
  });

  it("keeps legacy missing old values/counts unknown instead of rebuilding evidence", async () => {
    const h = harness(); h.app.showFingerprintComparison(ID, { checked: true, drift: [{ field: "uaHighEntropy", current: { architecture: "x86" } }] }, { source: "launch", historical: true }); await flush();
    expect(h.body().textContent).toContain("uaHighEntropy.architecture"); expect(h.body().textContent).toContain(h.window.i18n.t("fingerprint.value.missing"));
    expect(h.body().textContent).toContain(h.window.i18n.t("health.drift.time-unavailable")); expect(h.body().querySelectorAll(".fingerprint-drift-counts")).toHaveLength(0);
    expect(h.body().querySelectorAll('article[data-fingerprint-severity="unknown"]')).toHaveLength(1);
    expect(h.el("fingerprint-drift-update").hidden).toBe(true); expect(h.api.browser.captureBaseline).not.toHaveBeenCalled();
  });

  it("has a dedicated named dialog, safe initial focus, small live status and advanced-only reset", async () => {
    const h = harness(); h.app.checkDrift(ID); await flush();
    const dlg = h.el("dlg-fingerprint-drift");
    expect(dlg.getAttribute("aria-labelledby")).toBe("dlg-fingerprint-drift-title"); expect(dlg.getAttribute("aria-describedby")).toBe("fingerprint-drift-scope");
    expect(h.document.activeElement).toBe(h.el("fingerprint-drift-close")); expect(h.body().getAttribute("data-i18n")).toBeNull();
    expect(h.el("fingerprint-drift-status").getAttribute("aria-live")).toBe("polite"); expect(h.el("fingerprint-drift-status").getAttribute("role")).toBe("status");
    expect(h.el("fingerprint-drift-reset").closest("details")?.id).toBe("fingerprint-drift-advanced"); expect(h.el("fingerprint-drift-advanced").open).toBe(false);
    expect(dlg.querySelector("form")).toBeNull(); expect(dlg.querySelector("[onclick]")).toBeNull();
    expect(HTML.indexOf('src="js/app/fingerprint-drift.js"')).toBeLessThan(HTML.indexOf('src="js/app/profiles.js"'));
    expect(CSS).toContain("#dlg-fingerprint-drift .fingerprint-drift-values"); expect(CSS).toContain("@media (max-width: 600px)");
    const scoped = CSS.slice(CSS.indexOf("/* Snapshot ledger:"), CSS.indexOf("/* R68:", CSS.indexOf("/* Snapshot ledger:")));
    expect(scoped).not.toMatch(/color:\s*var\(--(?:primary|warning|danger|success)\)/);
    expect(h.el("dlg-confirm").open).toBe(false);
  });

  it("has exact locale/mirror coverage, no duplicate focused keys and identical placeholders", () => {
    expect(fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8")).toBe(I18N);
    const counts = new Map<string, number>(), source = ts.createSourceFile("i18n.js", I18N, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && (/^fingerprint\./.test(node.name.text) || /^launch\.drift-/.test(node.name.text) || /^sync\.result\.(runtime\.|backup-incomplete$|backup-not-published$)/.test(node.name.text) || ["profile.health.drift-details", "profile.status.unconfirmed", "profile.status.stopping", "profile.action.retry-status", "profile.runtime.unconfirmed-help", "profile.runtime.stopping-help", "profile.runtime.launch-unavailable", "sync.preview.profiles.running", "sync.preview.profiles.no-skip", "sync.preview.running-title", "sync.preview.skip-badge", "sync.confirm.pull-running"].includes(node.name.text))) counts.set(node.name.text, (counts.get(node.name.text) || 0) + 1);
      ts.forEachChild(node, visit);
    }
    visit(source); const en = harness(), zh = harness("zh-CN"); expect(counts.size).toBeGreaterThan(100);
    for (const [key, count] of counts) {
      expect(count, key).toBe(2);
      const a = en.window.i18n.t(key, "__missing__"), b = zh.window.i18n.t(key, "__missing__");
      expect(a, key).not.toBe("__missing__");
      if (key === "fingerprint.field.path") expect(b).toBe("{root} · {leaf}"); // Structural separator; both labels themselves are localized.
      else expect(b, key).toMatch(/[㐀-鿿]/);
      expect([...a.matchAll(/\{[^}]+\}/g)].map(m => m[0]).sort(), key).toEqual([...b.matchAll(/\{[^}]+\}/g)].map(m => m[0]).sort());
      expect(a + b, key).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
