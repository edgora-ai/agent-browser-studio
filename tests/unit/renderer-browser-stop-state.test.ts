// Boundary: unchanged, complete production renderer scripts run in a synthetic
// DOM/VM. Only the preload/main API and toast presentation are replaced. Runtime
// helpers, IPC wrapper, launch/stop handlers, profile renderer and batch summaries remain
// production code. No Electron, browser, OS process, network or real user data.
// This suite does not prove native exit, modal/layout behavior or durable storage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(__dirname, "../..");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");
const MODULES = ["icons", "core", "ipc", "fingerprint-drift", "tabs", "profiles", "batch-ui"] as const;
const SOURCES = Object.fromEntries(MODULES.map((name) => [name,
  fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${name}.js`), "utf8"),
]));
const ID = "stop-state-synthetic-a";
const OTHER = "stop-state-synthetic-b";
const PID = 51_701;
const PROFILE = {
  dirId: ID, name: "Stop state synthetic A", engine: "chromium", fingerprintMode: "managed",
  fingerprintSeed: 12345, platform: "macos", timezone: "UTC", locale: "en-US", tags: ["synthetic"],
  syncStatus: "never", syncedAt: null, running: true, pid: PID, proxyMode: "none", proxyName: null,
};
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
type Handler = (event: any) => void;

// Same bounded DOM surface as the health renderer suite: real HTML is parsed,
// not a replacement implementation of the stop handler or runtime overlay.
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
      get: (_target, key: string | symbol) => typeof key === "string" ? this.getAttribute("data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())) ?? undefined : undefined,
      set: (_target, key: string, value) => { this.setAttribute("data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), String(value)); return true; },
    });
  }
  get id() { return this.attributes.id || ""; }
  set id(value: string) { this.attributes.id = value; }
  get className() { return this.attributes.class || ""; }
  set className(value: string) { this.attributes.class = value; }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
  };
  get parentElement() { return this.parentNode; }
  get nextSibling(): Element | null { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get childNodes() { return this.children; }
  get nodeType() { return this.tagName === "#TEXT" ? 3 : 1; }
  get firstElementChild() { return this.children.find((c) => c.tagName !== "#TEXT") || null; }
  get value(): string { return this.tagName === "SELECT" && !this.input ? this.querySelector("option[selected]")?.value || this.querySelector("option")?.value || "" : this.input; }
  set value(value: string | number) { this.input = String(value); }
  get open() { return this.attributes.open !== undefined; }
  set open(value: boolean) { if (value) this.attributes.open = ""; else delete this.attributes.open; }
  get hidden() { return this.attributes.hidden !== undefined; }
  set hidden(value: boolean) { if (value) this.attributes.hidden = ""; else delete this.attributes.hidden; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(value: string) { this.text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  get innerHTML(): string { return escape(this.text) + this.children.map((c) => c.tagName === "#TEXT" ? escape(c.textContent)
    : "<" + c.tagName.toLowerCase() + Object.entries(c.attributes).map(([k, v]) => ` ${k}="${escape(v)}"`).join("") + ">" + c.innerHTML + "</" + c.tagName.toLowerCase() + ">").join(""); }
  set innerHTML(value: string) { this.textContent = ""; if (this.tagName === "SELECT") this.input = ""; parseInto(value, this); }
  appendChild(child: Element) {
    if (child.tagName === "#FRAGMENT") { for (const c of [...child.children]) this.appendChild(c); return child; }
    child.parentNode?.removeChild(child); child.parentNode = this; this.children.push(child); return child;
  }
  insertBefore(child: Element, before: Element | null) { this.appendChild(child); if (before) { this.children.pop(); this.children.splice(this.children.indexOf(before), 0, child); } return child; }
  removeChild(child: Element) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; return child; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(key: string, value: string) {
    this.attributes[key] = String(value);
    if (key === "disabled") this.disabled = true;
    if (key === "style") for (const rule of String(value).split(";")) {
      const colon = rule.indexOf(":");
      if (colon >= 0) this.style[rule.slice(0, colon).trim().replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = rule.slice(colon + 1).trim();
    }
  }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  removeAttribute(key: string) { delete this.attributes[key]; if (key === "disabled") this.disabled = false; }
  contains(child: Element): boolean { return child === this || this.children.some((c) => c.contains(child)); }
  matches(selector: string) { return matches(this, selector, this); }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector: string): Element[] {
    const all = (node: Element): Element[] => node.children.flatMap((c) => [c, ...all(c)]);
    return all(this).filter((c) => c.tagName !== "#TEXT" && matches(c, selector, this));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(key: string, fn: Handler) { (this.listeners[key] ||= []).push(fn); }
  dispatchEvent(event: any) { event.target ||= this; for (const fn of this.listeners[event.type] || []) fn(event); (this as any)["on" + event.type]?.(event); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent({ type: "close" }); }
}
function matches(el: Element, selector: string, scope: Element): boolean {
  return selector.split(",").some((arm) => {
    const parts = arm.trim().match(/(?:\[[^\]]*\]|:not\([^)]*\)|[^ >])+|>/g) || [];
    const simple = (node: Element, part: string): boolean => {
      let ok = true;
      part = part.replace(/:not\(([^)]*)\)/g, (_all, inner) => { ok &&= !matches(node, inner, scope); return ""; });
      part = part.replace(/:scope|:checked/g, (pseudo) => { ok &&= pseudo === ":scope" ? node === scope : node.checked; return ""; });
      part = part.replace(/^[\w*-]+/, (tag) => { ok &&= tag === "*" || node.tagName === tag.toUpperCase(); return ""; });
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
      const index = stack.map((node) => node.tagName).lastIndexOf(tag); if (index > 0) stack.splice(index);
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
function failOnUnknown<T extends object>(obj: T, prefix: string): T {
  return new Proxy(obj, { get(target, key, receiver) {
    if (typeof key === "symbol" || key === "then") return Reflect.get(target, key, receiver);
    if (!(key in target)) throw new Error("Unmodeled API capability: " + prefix + "." + key);
    return Reflect.get(target, key, receiver);
  } });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function batchReceipt() {
  // These are accepted stop requests, not observed OS-process exits.
  return { total: 2, succeeded: 2, failed: 0, cancelled: false, durationMs: 4, concurrency: 4,
    results: [ID, OTHER].map((item) => ({ item, ok: true, value: { dirId: item } })) };
}
function harness(language: "en-US" | "zh-CN" = "en-US") {
  const document: any = {}, root = new Element(document, "#DOCUMENT"), events: Record<string, Handler[]> = {};
  parseInto(HTML, root);
  Object.assign(document, {
    readyState: "loading", // Native init/wizard/hydration is deliberately not dispatched.
    getElementById: (id: string) => root.querySelector("#" + id),
    querySelector: (selector: string) => root.querySelector(selector), querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    createElement: (tag: string) => new Element(document, tag.toUpperCase()), createDocumentFragment: () => new Element(document, "#FRAGMENT"),
    createTextNode: (text: string) => { const el = new Element(document, "#TEXT"); el.textContent = text; return el; },
    addEventListener: (name: string, fn: Handler) => (events[name] ||= []).push(fn),
    dispatchEvent: (event: any) => (events[event.type] || []).forEach((fn) => fn(event)),
  });
  document.body = document.querySelector("body"); document.documentElement = document.querySelector("html"); document.activeElement = document.body;
  let profiles = [structuredClone(PROFILE), { ...structuredClone(PROFILE), dirId: OTHER, name: "Stop state synthetic B", pid: PID + 1 }];
  const api = failOnUnknown({
    observability: null, // Explicit unavailable optional boundary; no real metrics writes.
    on: vi.fn((_channel: string, _handler: Handler) => undefined),
    browser: failOnUnknown({
      list: vi.fn(async () => structuredClone(profiles)),
      launch: vi.fn(async (_id: string, _opts?: any): Promise<any> => {
        throw new Error("Synthetic launch receipt must be explicitly declared by the test");
      }),
      stop: vi.fn(async (_id: string): Promise<any> => ({ success: true })),
      binary: vi.fn(async () => ({ installed: true, version: "synthetic-engine", installedVersions: [] })),
      engineStatus: vi.fn(async () => ({ firefox: { installed: true } })),
      healthHistory: null, // No health evidence is requested or manufactured by this suite.
      status: vi.fn(async (id: string): Promise<any> => ({ running: profiles.find(p => p.dirId === id)?.running === true })),
      driftReport: vi.fn(async (_id: string): Promise<any> => ({ ok: true, report: null, currentConfigMatches: false, canUpdateBaseline: false })),
      batchMaxConcurrency: vi.fn(async () => ({ max: 4 })),
      batchStop: vi.fn(async (_ids: string[], _concurrency: number, _jobId: string) => batchReceipt()),
    }, "browser"),
    proxy: failOnUnknown({ list: vi.fn(async () => []) }, "proxy"),
    app: failOnUnknown({ setLanguage: vi.fn(async () => undefined) }, "app"),
  }, "api");
  const window: any = { agentBrowserAPI: api }, memory = new Map<string, string>();
  const context = vm.createContext({ window, document, console, navigator: { language },
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) },
    setTimeout, clearTimeout, Date, Math,
    CustomEvent: function(type: string, options: any) { return { type, ...options }; },
    Option: function(text: string, value: string) { const option = document.createElement("option"); option.textContent = text; option.value = value; return option; },
  });
  vm.runInContext(I18N, context, { filename: "src/renderer/js/i18n.js" });
  window.i18n.apply(); // The real DOMContentLoaded performs this static translation step.
  for (const name of ["icons", "core", "ipc"] as const) vm.runInContext(SOURCES[name], context, { filename: `src/renderer/js/app/${name}.js` });
  const app: any = window.agentBrowser;
  app.helpers.toast = vi.fn(); // Observe rendered copy without native live-region timers.
  for (const name of ["fingerprint-drift", "tabs", "profiles", "batch-ui"] as const) vm.runInContext(SOURCES[name], context, { filename: `src/renderer/js/app/${name}.js` });
  const el = (id: string): Element => { const found = document.getElementById(id); if (!found) throw new Error("Missing production HTML element " + id); return found; };
  const card = (id = ID): Element => { const found = el("profile-list").querySelector(`.profile-card[data-dir-id="${id}"]`); if (!found) throw new Error("Production card missing: " + el("profile-list").textContent); return found; };
  const render = async () => { app.loadProfiles(true); await flush(); card(); };
  const tick = async (ms = 130) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
  const clickStop = () => {
    const button = card().querySelector('[data-action="stop"]');
    if (!button) throw new Error("Running profile has no production Stop action");
    (el("profile-list") as any).onclick({ target: button });
  };
  const clickLaunch = () => {
    const button = card().querySelector('[data-action="launch"]');
    if (!button) throw new Error("Stopped profile has no production Launch action");
    (el("profile-list") as any).onclick({ target: button });
  };
  const exitedList = () => { profiles = profiles.map((p) => p.dirId === ID ? { ...p, running: false, pid: null as any } : p); };
  const runningList = () => { profiles = profiles.map((p) => p.dirId === ID ? { ...p, running: true, pid: PID } : p); };
  return { api, app, window, el, card, render, tick, clickStop, clickLaunch, exitedList, runningList, toast: app.helpers.toast,
    messages: () => app.helpers.toast.mock.calls.map((call: any[]) => String(call[0])).join("\n") };
}
function expectRunning(h: ReturnType<typeof harness>, id = ID) {
  expect(h.card(id).classList.contains("running")).toBe(true);
  expect(h.card(id).querySelector(".badge-lifecycle")?.textContent).toMatch(/Running|运行中/);
  expect(!!h.card(id).querySelector('[data-action="launch"]')).toBe(false);
  expect(!!h.card(id).querySelector('[data-action="stop"]')).toBe(true);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

for (const language of ["en-US", "zh-CN"] as const) {
  describe(`stop acceptance is not exit (${language}, complete production modules)`, () => {
    it("keeps a still-running authoritative list running after accepted stop, with no false overlay", async () => {
      const h = harness(language); await h.render();
      const before = h.api.browser.list.mock.calls.length;
      h.clickStop(); await flush();
      expect(h.api.browser.stop).toHaveBeenCalledExactlyOnceWith(ID);
      expect(h.window._profileRuntimeOverrides?.[ID]?.running).not.toBe(false);
      await h.tick();
      expect(h.api.browser.list.mock.calls.length).toBeGreaterThan(before);
      expectRunning(h);
      expect(h.card().getAttribute("aria-busy")).toBe("false");
    });

    it("announces a stop request and waiting for exit, never Browser stopped on the accepted boolean receipt", async () => {
      const h = harness(language); await h.render(); h.clickStop(); await flush();
      expect(h.api.browser.stop).toHaveBeenCalledOnce();
      expect(h.messages()).not.toMatch(/Browser stopped|浏览器已停止/);
      expect(h.messages()).toMatch(language === "en-US" ? /stop request|requested.*stop/i : /停止请求|已请求停止/);
      expect(h.messages()).toMatch(language === "en-US" ? /wait.*(?:exit|close|stop)/i : /等待.*(?:退出|关闭|停止)/);
    });

    it("clears an old optimistic runtime overlay on acceptance rather than installing a stopped overlay", async () => {
      const h = harness(language); await h.render();
      h.app.helpers.markProfileRuntime(ID, true, PID - 1);
      expect(h.window._profileRuntimeOverrides[ID].pid).toBe(PID - 1);
      h.clickStop(); await flush();
      expect(h.window._profileRuntimeOverrides?.[ID]).toBeUndefined();
      await h.tick(); expectRunning(h);
    });

    it("never turns the card into stopped at a graceful or force-kill budget while main still reports it live", async () => {
      const h = harness(language); await h.render(); h.clickStop(); await flush();
      // Only test time advances: the fixture reports running throughout. No
      // sleep, PID simulation or assumed automatic exit is used as evidence.
      for (const ms of [130, 2_370, 3_000]) {
        await h.tick(ms); await h.render(); expectRunning(h);
      }
    });

    it("preserves running state and reports an error when the stop request is refused", async () => {
      const h = harness(language); await h.render();
      h.api.browser.stop.mockResolvedValue({ success: false, error: "Synthetic stop refusal" });
      h.clickStop(); await flush(); await h.tick();
      expectRunning(h);
      expect(h.window._profileRuntimeOverrides?.[ID]?.running).not.toBe(false);
      expect(h.toast).toHaveBeenCalledWith("Synthetic stop refusal", "error");
      expect(h.messages()).not.toMatch(/Browser stopped|浏览器已停止|Stop requested|停止请求已/);
      expect(h.card().getAttribute("aria-busy")).toBe("false");
    });

    it("preserves running state and releases card busy state on a rejected IPC promise", async () => {
      const h = harness(language); await h.render();
      h.api.browser.stop.mockRejectedValue(new Error("Synthetic stop transport failure"));
      h.clickStop(); await flush();
      expectRunning(h);
      expect(h.window._profileRuntimeOverrides?.[ID]?.running).not.toBe(false);
      expect(h.toast).toHaveBeenCalledWith("Synthetic stop transport failure", "error");
      expect(h.card().getAttribute("aria-busy")).toBe("false");
    });

    it("does not optimistically stop while the IPC receipt is pending", async () => {
      const h = harness(language); await h.render(); const pending = deferred<any>();
      h.api.browser.stop.mockReturnValue(pending.promise);
      h.clickStop(); await flush();
      expectRunning(h); expect(h.card().getAttribute("aria-busy")).toBe("true");
      expect(h.toast).not.toHaveBeenCalled();
      pending.resolve({ success: false, error: "Synthetic pending request refused" }); await flush();
      expectRunning(h); expect(h.card().getAttribute("aria-busy")).toBe("false");
    });

    it("shows stopped when an authoritative list actually changes to exited, without a five-second sleep", async () => {
      const h = harness(language); await h.render(); h.clickStop(); await flush();
      h.exitedList(); h.app.helpers.scheduleProfilesRefresh(); await h.tick();
      expect(h.card().classList.contains("running")).toBe(false);
      expect(h.card().querySelector(".badge-lifecycle")?.textContent).toMatch(/Stopped|已停止/);
      expect(!!h.card().querySelector('[data-action="launch"]')).toBe(true);
      expect(!!h.card().querySelector('[data-action="stop"]')).toBe(false);
      expect(h.window._profileRuntimeOverrides?.[ID]).toBeUndefined();
    });

    it("keeps unconfirmed/stopping runtimes out of Stopped and replaces Launch with read-only status retry", async () => {
      const h = harness(language);
      let runtime: any = { running: false, pid: null, unknown: true };
      h.api.browser.list.mockImplementation(async () => [{ ...structuredClone(PROFILE), ...runtime }, { ...structuredClone(PROFILE), dirId: OTHER, name: "Confirmed stopped control", running: false, pid: null }]);
      h.app.helpers.markProfileRuntime(ID, true, PID); await h.render();
      expect(h.card().querySelector(".badge-lifecycle")?.textContent).toBe(h.window.i18n.t("profile.status.unconfirmed"));
      expect(h.card().querySelector('[data-action="launch"]')).toBeNull(); expect(h.card().querySelector('[data-action="stop"]')).toBeNull();
      expect(h.window._profileRuntimeOverrides?.[ID]).toBeUndefined();
      const retry = h.card().querySelector('[data-action="refresh-runtime"]')!;
      expect(retry.textContent).toContain(h.window.i18n.t("profile.action.retry-status"));
      expect(retry.getAttribute("title")).toBe(h.window.i18n.t("profile.runtime.unconfirmed-help"));
      const reads = h.api.browser.list.mock.calls.length;
      (h.el("profile-list") as any).onclick({ target: retry }); await flush(); expect(h.api.browser.list.mock.calls.length).toBeGreaterThan(reads);
      h.app.launch(ID); await flush(); expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.stop).not.toHaveBeenCalled();
      h.el("profile-status-filter").value = "stopped"; h.app.onProfileFilterChange(); await flush();
      expect(h.el("profile-list").querySelector(`[data-dir-id="${ID}"]`)).toBeNull(); expect(h.card(OTHER)).toBeTruthy();
      runtime = { running: true, pid: PID, stopping: true }; h.app.clearProfileFilters(); await flush();
      expect(h.card().querySelector(".badge-lifecycle")?.textContent).toBe(h.window.i18n.t("profile.status.stopping"));
      expect(h.card().classList.contains("running")).toBe(true); // A stop in progress is not an observed exit.
      expect(h.card().querySelector('[data-action="launch"]')).toBeNull(); expect(h.card().querySelector('[data-action="refresh-runtime"]')).not.toBeNull();
      h.app.launch(ID); await flush(); expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.stop).not.toHaveBeenCalled();
      runtime = { running: false, pid: null }; h.app.loadProfiles(true); await flush();
      expect(h.card().querySelector(".badge-lifecycle")?.textContent).toBe(h.window.i18n.t("profile.status.stopped"));
      expect(h.card().querySelector('[data-action="launch"]')).not.toBeNull();
      expect(h.api.browser.launch).not.toHaveBeenCalled(); expect(h.api.browser.stop).not.toHaveBeenCalled();
    });

    it("keeps selection, search and unsaved profile fields during stop-acceptance list refresh", async () => {
      const h = harness(language); await h.render();
      const checkbox = h.card().querySelector(".profile-select-checkbox")!;
      checkbox.checked = true; (h.el("profile-list") as any).onchange({ target: checkbox });
      h.el("agent-browser-meta-name").value = "Unsaved synthetic profile name";
      h.el("dlg-agent-browser-seed").showModal(); h.el("cookie-search").value = "Unsaved unrelated search";
      h.clickStop(); await flush(); await h.tick();
      expect(h.card().querySelector(".profile-select-checkbox")?.checked).toBe(true);
      expect(h.el("agent-browser-meta-name").value).toBe("Unsaved synthetic profile name");
      expect(h.el("cookie-search").value).toBe("Unsaved unrelated search");
      expectRunning(h);
    });

    it("reports batch successes as accepted stop requests, not observed exits, in the real result dialog", async () => {
      const h = harness(language); await h.render();
      const result = await h.app.batch.run({ kind: "stop", dirIds: [ID, OTHER] }); await flush();
      expect(h.api.browser.batchStop).toHaveBeenCalledExactlyOnceWith([ID, OTHER], 4, expect.any(String));
      expect(result).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
      expect(h.el("dlg-batch-result").open).toBe(true);
      const summary = h.el("batch-result-summary").textContent;
      expect(summary).toContain("2");
      expect(summary).toMatch(language === "en-US" ? /request.*(?:accepted|submitted)|(?:accepted|submitted).*request/i : /请求.*(?:受理|提交)|(?:受理|提交).*请求/);
      expect(summary).not.toMatch(/\bstopped\b|已停止/i);
      await h.render(); expectRunning(h); expectRunning(h, OTHER);
    });
  });
}

it("production clearProfileRuntime without seq clears the current overlay, while a stale explicit seq cannot", () => {
  const h = harness();
  const old = h.app.helpers.markProfileRuntime(ID, false, null);
  const current = h.app.helpers.markProfileRuntime(ID, true, PID);
  h.app.helpers.clearProfileRuntime(ID, old);
  expect(h.window._profileRuntimeOverrides[ID]).toMatchObject({ running: true, pid: PID, seq: current });
  h.app.helpers.clearProfileRuntime(ID);
  expect(h.window._profileRuntimeOverrides[ID]).toBeUndefined();
});

function comparisonReport(changes: any[], patch: any = {}) {
  return { schemaVersion: 1, policyVersion: 2, id: "synthetic-launch-report", dirId: ID, observedAt: 1700000000000, source: "launch", hasBaseline: true,
    fields: 7, availableFields: 7, baselineFields: 7, comparedFields: 12,
    counts: { risk: changes.filter(row => row.severity === "risk").length, review: changes.filter(row => row.severity === "review").length,
      info: changes.filter(row => row.severity === "info").length, unavailable: changes.filter(row => row.severity === "unavailable").length },
    changes, risky: changes.some(row => row.severity === "risk"), partial: changes.some(row => row.severity === "unavailable"), ...patch };
}

for (const language of ["en-US", "zh-CN"] as const) {
  describe(`fingerprint launch receipts (${language}, original card Launch onclick)`, () => {
    it("shows actual blocked launch values and original observation time without a running overlay", async () => {
      const h = harness(language), at = Date.parse("2024-04-05T06:07:08Z");
      const before = "synthetic-before-" + "A".repeat(280), current = '<img src=x onerror="synthetic">';
      h.exitedList(); await h.render();
      h.api.browser.launch.mockResolvedValue({ success: false, code: "fingerprint-drift", error: "Fingerprint drift blocked (userAgent).",
        driftCheck: { checked: true, risky: true, observedAt: at, drift: [
          { field: "userAgent", baseline: before, current },
          { field: "uaHighEntropy", baseline: { architecture: "arm" }, current: { architecture: "x86" } },
        ] } });
      h.clickLaunch(); await flush();
      expect(h.api.browser.launch).toHaveBeenCalledExactlyOnceWith(ID, undefined);
      expect(h.el("dlg-fingerprint-drift").open).toBe(true);
      expect(h.el("dlg-confirm").open).toBe(false);
      const detail = h.el("fingerprint-drift-body"), text = detail.textContent;
      expect(text).toContain(new Date(at).toLocaleString()); expect(text).toContain("userAgent");
      expect(text).toContain(before); expect(text).toContain(current);
      expect(text).toContain("uaHighEntropy.architecture");
      expect(text).toContain("arm"); expect(text).toContain("x86");
      expect(text).toContain(h.window.i18n.t("fingerprint.field.architecture"));
      expect(text).not.toContain('{"architecture":'); // Nested values are readable leaves, not opaque JSON blobs.
      expect(detail.querySelector("[data-fingerprint-expand]")).not.toBeNull();
      expect(detail.querySelector("img")).toBeNull(); expect(detail.querySelector("[onerror]")).toBeNull();
      expect(text).toContain(h.window.i18n.t("health.drift.block-boundary"));
      expect(h.el("fingerprint-drift-scope").textContent).toContain(h.window.i18n.t("fingerprint.scope").split(".")[0]);
      expect(h.el("fingerprint-drift-advanced").textContent).toContain(h.window.i18n.t("profile.health.reset"));
      expect(h.el("fingerprint-drift-recheck").hidden).toBe(true);
      expect(h.el("fingerprint-drift-update").hidden).toBe(true);
      expect(h.el("fingerprint-drift-launch").hidden).toBe(false);
      expect(text).toContain(h.window.i18n.t("fingerprint.next.fresh-launch"));
      expect(h.toast.mock.calls.some((call: any[]) => call[1] === "success")).toBe(false);
      expect(h.window._profileRuntimeOverrides?.[ID]).toBeUndefined();
      expect(h.card().getAttribute("aria-busy")).toBe("false");
      expect(h.card().classList.contains("running")).toBe(false);
      h.el("dlg-fingerprint-drift").close(); await flush(); // Reading/closing does not start or stop anything.
      expect(h.api.browser.launch).toHaveBeenCalledTimes(1); expect(h.api.browser.stop).not.toHaveBeenCalled();
      await h.tick(); expect(h.window._profileRuntimeOverrides?.[ID]).toBeUndefined();
      expect(h.card().classList.contains("running")).toBe(false);
      expect(h.card().getAttribute("aria-busy")).toBe("false");
    });

    it("reports failed fingerprint capture as unavailable, never a launch success or proven drift", async () => {
      const h = harness(language); h.exitedList(); await h.render();
      h.api.browser.launch.mockResolvedValue({ success: false, code: "fingerprint-check-unavailable", error: "Fingerprint check unavailable: synthetic capture refusal.",
        driftCheck: { checked: false, error: "synthetic capture failure" } });
      h.clickLaunch(); await flush(); await h.tick();
      expect(h.toast).toHaveBeenCalledWith(h.window.i18n.t("err.drift.unavailable"), "error", { detail: "synthetic capture failure" });
      expect(h.toast.mock.calls.some((call: any[]) => call[1] === "success")).toBe(false);
      expect(h.messages()).not.toContain(h.window.i18n.t("err.drift.blocked"));
      expect(h.el("dlg-confirm").open).toBe(false);
      expect(h.window._profileRuntimeOverrides?.[ID]).toBeUndefined();
      expect(h.card().classList.contains("running")).toBe(false);
      expect(h.card().getAttribute("aria-busy")).toBe("false");
      expect(h.api.browser.stop).not.toHaveBeenCalled();
    });

    it.each([
      { label: "unavailable capture with the gate off", key: "launch.drift-unavailable-warning", warning: true, driftCheck: { checked: false, error: "synthetic capture failure" } },
      { label: "legacy risky drift with the gate off", key: "launch.drift-risk-warning", warning: true, driftCheck: { checked: true, risky: true, observedAt: 1700000000000,
        drift: [{ field: "platform", baseline: "MacIntel", current: "Win32" }] } },
      { label: "unclassified legacy viewport difference", key: "launch.drift-legacy-warning", warning: true, driftCheck: { checked: true, risky: false, observedAt: 1700000000000,
        drift: [{ field: "innerWidth", baseline: 1000, current: 1200 }] } },
      { label: "normal resize/sidebar/theme INFO only", key: "launch.drift-info", warning: false, driftCheck: { checked: true, report: comparisonReport([
        { field: "innerWidth", baseline: 1000, current: 1200, severity: "info", category: "window", reason: "window-geometry" },
        { field: "screen.availWidth", baseline: 1440, current: 1360, severity: "info", category: "environment", reason: "display-environment" },
        { field: "colorScheme", baseline: "light", current: "dark", severity: "info", category: "environment", reason: "runtime-environment" },
      ]) } },
      { label: "intentional verified engine update", key: "launch.drift-review-warning", warning: true, driftCheck: { checked: true, report: comparisonReport([
        { field: "uaHighEntropy.uaFullVersion", baseline: "150.0", current: "151.0", severity: "review", category: "identity", reason: "browser-version" },
      ]) } },
      { label: "optional probe unavailable", key: "launch.drift-partial-warning", warning: true, driftCheck: { checked: true, report: comparisonReport([
        { field: "voices", baseline: ["synthetic"], current: null, severity: "unavailable", category: "availability", reason: "probe-unavailable" },
      ]) } },
    ])("reports $label independently of process-start success", async ({ key, warning, driftCheck }) => {
      const h = harness(language); h.exitedList(); await h.render();
      h.api.browser.launch.mockImplementation(async () => {
        h.runningList(); return { success: true, pid: PID, cdpPort: 41_701, driftCheck };
      });
      h.clickLaunch(); await flush(); await h.tick(); expectRunning(h);
      const startup = h.toast.mock.calls.find((call: any[]) => String(call[0]).startsWith(h.window.i18n.t("toast.profile.started")));
      expect(startup?.[1]).toBe(warning ? "warning" : "success");
      expect(startup?.[2]?.detail).toContain(h.window.i18n.t(key));
      if (!warning) expect(h.toast.mock.calls.some((call: any[]) => call[1] === "warning")).toBe(false);
      else expect(h.toast.mock.calls.some((call: any[]) => call[1] === "success")).toBe(false);
      if ("error" in driftCheck) expect(startup?.[2]?.detail).toContain(driftCheck.error);
      expect(startup?.[2]?.action.label).toBe(h.window.i18n.t("launch.drift-review"));
      startup?.[2]?.action.onClick(); await flush();
      const body = h.el("fingerprint-drift-body");
      expect(h.el("dlg-fingerprint-drift").open).toBe(true); expect(h.el("dlg-confirm").open).toBe(false);
      const field = "report" in driftCheck ? driftCheck.report.changes[0].field : "drift" in driftCheck ? driftCheck.drift[0].field : "";
      if (field) expect(body.textContent).toContain(field);
      expect(body.textContent).toContain(h.window.i18n.t("fingerprint.historical"));
      expect(body.textContent).not.toContain(h.window.i18n.t("health.drift.block-boundary"));
      expect(h.el("fingerprint-drift-recheck").hidden).toBe(false);
      expect(h.card().getAttribute("aria-busy")).toBe("false");
      expect(h.api.browser.launch).toHaveBeenCalledTimes(1); expect(h.api.browser.stop).not.toHaveBeenCalled();
    });
  });
}

// Cookie persistence/application is NOT simulated here. These explicit preload
// receipts exercise only how the unchanged renderer reports a started browser
// with incomplete Cookie application; a separate service/native probe owns proof
// that any real Cookie reached Chromium or survived sync/restart.
type CookieLaunchCheck = { checked: boolean; applied: number; pending: number; error?: string };
const COOKIE_PENDING_DETAIL = {
  "en-US": "Browser started, but queued cookies were not confirmed applied. Review the import result before using this session.",
  "zh-CN": "浏览器已启动，但排队 Cookie 尚未确认应用。使用此会话前请检查导入结果。",
};
async function launchCookieFixture(language: "en-US" | "zh-CN", cookieCheck?: CookieLaunchCheck) {
  const h = harness(language);
  h.exitedList(); await h.render();
  expect(h.card().classList.contains("running")).toBe(false);
  h.api.browser.launch.mockImplementation(async () => {
    // Main reports the browser genuinely running, independently of the Cookie
    // receipt. Do not make the renderer's optimistic overlay our runtime oracle.
    h.runningList();
    return { success: true, pid: PID, cdpPort: 41_701, ...(cookieCheck === undefined ? {} : { cookieCheck }) };
  });
  h.clickLaunch(); await flush(); await h.tick();
  expect(h.api.browser.launch).toHaveBeenCalledExactlyOnceWith(ID, undefined);
  expectRunning(h);
  expect(h.card().getAttribute("aria-busy")).toBe("false");
  expect(h.window._profileRuntimeOverrides?.[ID]).toBeUndefined();
  const prefix = h.window.i18n.t("toast.profile.started");
  const startupCalls = h.toast.mock.calls.filter((call: any[]) => String(call[0]).startsWith(prefix));
  expect(startupCalls).toHaveLength(1);
  return { h, startup: startupCalls[0] as any[] };
}

for (const language of ["en-US", "zh-CN"] as const) {
  describe(`Cookie launch receipt reporting (${language}, original card Launch onclick)`, () => {
    it("warns when the browser started but its queued Cookie was not confirmed applied, without pretending the browser is stopped", async () => {
      const { h, startup } = await launchCookieFixture(language, {
        checked: true, applied: 0, pending: 1, error: "COOKIE_IMPORT_INCOMPLETE",
      });
      expect({ tone: startup[1], detail: startup[2]?.detail }).toMatchObject({
        tone: "warning", detail: expect.stringContaining(COOKIE_PENDING_DETAIL[language]),
      });
      expect(h.toast.mock.calls.some((call: any[]) => String(call[0]).startsWith(h.window.i18n.t("toast.profile.started")) && call[1] === "success")).toBe(false);
      expect(h.window.i18n.t("toast.profile.cookies-pending", "__missing-cookie-pending-key__")).toBe(COOKIE_PENDING_DETAIL[language]);
    });

    it.each([
      { label: "a fully applied queue", cookieCheck: { checked: true, applied: 1, pending: 0 } },
      { label: "an explicitly empty queue", cookieCheck: { checked: true, applied: 0, pending: 0 } },
      { label: "no queued-Cookie receipt", cookieCheck: undefined },
    ])("preserves the original success/health-next guidance for $label", async ({ cookieCheck }) => {
      const { h, startup } = await launchCookieFixture(language, cookieCheck);
      expect(startup[1]).toBe("success");
      expect(startup[2]?.detail).toBe(h.window.i18n.t("toast.profile.started-next"));
      expect(startup[2]?.action?.label).toBe(h.window.i18n.t("toast.profile.check-now"));
      expect(typeof startup[2]?.action?.onClick).toBe("function");
      expect(h.toast.mock.calls.some((call: any[]) => call[1] === "warning")).toBe(false);
      expect(String(startup[2]?.detail)).not.toContain(COOKIE_PENDING_DETAIL[language]);
    });
  });
}
