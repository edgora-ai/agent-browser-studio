import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(__dirname, "../..");
const SOURCE = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/delegation.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "src/renderer/css/style.css"), "utf8");

// No browser/IPC/storage fixtures: each test owns a fresh in-memory DOM and VM.
// This is NOT a layout engine: pixel rects model controller arithmetic only.
// Native top-layer hit-testing, CSS cascade, zoom and clipping need Electron E2E.
class Target {
  parentNode: Target | null = null;
  listeners: Record<string, Array<{ fn: (event: any) => void; capture: boolean }>> = {};
  addEventListener(type: string, fn: (event: any) => void, options: any = false) {
    (this.listeners[type] ||= []).push({ fn, capture: options === true || !!options.capture });
  }
  removeEventListener(type: string, fn: (event: any) => void, options: any = false) {
    const capture = options === true || !!options.capture;
    this.listeners[type] = (this.listeners[type] || []).filter((l) => l.fn !== fn || l.capture !== capture);
  }
  dispatchEvent(event: any) {
    event.target = this;
    event.defaultPrevented = false;
    event.preventDefault = () => { if (event.cancelable !== false) event.defaultPrevented = true; };
    event.stopPropagation = () => { event.stopped = true; };
    const route: Target[] = [];
    for (let node: Target | null = this; node; node = node.parentNode) route.push(node);
    const deliver = (node: Target, capture: boolean) => {
      event.currentTarget = node;
      for (const l of [...node.listeners[event.type] || []]) if (l.capture === capture) l.fn(event);
      if (!capture) (node as any)[`on${event.type}`]?.(event);
    };
    for (const node of [...route].reverse()) { if (event.stopped) break; deliver(node, true); }
    for (const node of event.bubbles ? route : [this]) { if (event.stopped) break; deliver(node, false); }
    return !event.defaultPrevented;
  }
}

const rect = (left: number, top: number, width: number, height: number) => ({
  x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
});
const px = (value: string | undefined, fallback: number) => value && /^(?:-?\d+(?:\.\d+)?px|0)$/.test(value)
  ? Number.parseFloat(value) : fallback;

// Only simple tag/class/id/attribute/pseudo selectors, descendants and children
// used by this fixture are supported. Unknown selector syntax fails loudly.
function matches(el: Element, selector: string, scope = el): boolean {
  return selector.split(",").some((arm) => {
    const parts = arm.trim().match(/(?:\[[^\]]*\]|:not\([^)]*\)|[^ >])+|>/g) || [];
    const simple = (node: Element, part: string): boolean => {
      let ok = true;
      part = part.replace(/:not\(([^)]*)\)/g, (_all, inner) => { ok &&= !matches(node, inner, scope); return ""; });
      part = part.replace(/:popover-open|:scope|:disabled|:enabled/g, (pseudo) => {
        ok &&= pseudo === ":popover-open" ? node.popoverOpen : pseudo === ":scope" ? node === scope
          : pseudo === ":disabled" ? node.disabled : !node.disabled;
        return "";
      });
      part = part.replace(/^[\w*-]+/, (tag) => { ok &&= tag === "*" || node.tagName === tag.toUpperCase(); return ""; });
      part = part.replace(/([.#])([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/g,
        (_all, prefix, name, attr, value) => {
          ok &&= prefix === "." ? node.classList.contains(name) : prefix === "#" ? node.id === name
            : value === undefined ? node.hasAttribute(attr) : node.getAttribute(attr) === value;
          return "";
        });
      if (part) throw new Error(`Unsupported fixture selector: ${selector}`);
      return ok;
    };
    const visit = (node: Element | null, index: number): boolean => {
      if (!node || !simple(node, parts[index])) return false;
      if (!index) return true;
      if (parts[index - 1] === ">") return visit(node.parentElement, index - 2);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (visit(parent, index - 1)) return true;
      return false;
    };
    return !!parts.length && visit(el, parts.length - 1);
  });
}

class Element extends Target {
  attributes: Record<string, string> = {};
  children: Element[] = [];
  style: any = { setProperty(name: string, value: string) { this[name] = value; }, removeProperty(name: string) { delete this[name]; } };
  dataset: Record<string, string>;
  textContent = "";
  innerHTML = "";
  popoverOpen = false;
  box = rect(0, 0, 240, 180);
  heightAtWidth = (_width: number) => this.box.height;
  measurements: Array<ReturnType<typeof rect>> = [];
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter((n) => !names.includes(n)).join(" "); },
    toggle: (name: string, force = !this.classList.contains(name)) => { this.classList[force ? "add" : "remove"](name); return force; },
  };
  constructor(public ownerDocument: any, public tagName = "DIV") {
    super();
    this.dataset = new Proxy({}, {
      get: (_target, key: string) => this.getAttribute(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
      set: (_target, key: string, value) => { this.setAttribute(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value)); return true; },
    });
  }
  get id() { return this.getAttribute("id") || ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") || ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get parentElement(): Element | null { return this.parentNode instanceof Element ? this.parentNode : null; }
  get firstChild() { return this.children[0] || null; }
  get isConnected(): boolean { return this.parentNode === this.ownerDocument || !!this.parentElement?.isConnected; }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(value: boolean) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get disabled() { return this.hasAttribute("disabled"); }
  get popover() { return this.getAttribute("popover"); }
  set popover(value: string | null) { if (value === null) this.removeAttribute("popover"); else this.setAttribute("popover", value); }
  get open() { return this.hasAttribute("open"); }
  set open(value: boolean) {
    const wasOpen = this.open;
    if (value) this.attributes.open = ""; else delete this.attributes.open;
    if (this.tagName === "DETAILS" && wasOpen !== value) this.ownerDocument.queueToggle(this, wasOpen, value);
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return Object.hasOwn(this.attributes, name); }
  setAttribute(name: string, value: string) { if (name === "open") this.open = true; else this.attributes[name] = String(value); }
  removeAttribute(name: string) { if (name === "open") this.open = false; else delete this.attributes[name]; }
  contains(node: any): boolean { return this === node || this.children.some((child) => child.contains(node)); }
  appendChild(child: Element) { child.parentElement?.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child: Element, before: Element | null) {
    this.appendChild(child);
    if (before) { this.children.pop(); this.children.splice(this.children.indexOf(before), 0, child); }
    return child;
  }
  removeChild(child: Element) {
    this.children = this.children.filter((node) => node !== child); child.parentNode = null;
    if (child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  remove() { this.parentElement?.removeChild(this); }
  matches(selector: string) { return matches(this, selector); }
  closest(selector: string): Element | null { for (let node: Element | null = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [...(matches(child, selector, this) ? [child] : []), ...child.descendants(selector, this)]);
  }
  private descendants(selector: string, scope: Element): Element[] {
    return this.children.flatMap((child) => [...(matches(child, selector, scope) ? [child] : []), ...child.descendants(selector, scope)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() {
    for (let node: Element | null = this; node; node = node.parentElement) if (node.hidden || node.style.display === "none" || node.style.visibility === "hidden") return [];
    return this.isConnected ? [this.getBoundingClientRect()] : [];
  }
  getBoundingClientRect() {
    // Model the confirmed details/popover state divergence, not real clipping:
    // closed details can zero a panel's rect without clearing :popover-open.
    if (this.classList.contains("card-menu-list") && this.closest("details")?.open === false) return rect(0, 0, 0, 0);
    const width = Math.min(px(this.style.width, this.box.width), px(this.style.maxWidth, Infinity));
    const result = rect(px(this.style.left, this.box.left), px(this.style.top, this.box.top), width,
      Math.min(this.heightAtWidth(width), px(this.style.maxHeight, Infinity)));
    if (this.classList.contains("card-menu-list")) this.measurements.push(result);
    return result;
  }
  get offsetWidth() { return this.getBoundingClientRect().width; }
  get offsetHeight() { return this.getBoundingClientRect().height; }
  get clientHeight() { return this.offsetHeight; }
  get scrollHeight() { return this.heightAtWidth(this.offsetWidth); }
  focus = vi.fn(() => { if (this.isConnected && this.getClientRects().length && !this.disabled) this.ownerDocument.activeElement = this; });
  click() {
    if (this.disabled) return;
    this.focus();
    if (this.dispatchEvent({ type: "click", bubbles: true }) && this.tagName === "SUMMARY" && this.parentElement?.tagName === "DETAILS") {
      this.parentElement.open = !this.parentElement.open; // Emulate native click default, not controller logic.
    }
  }
  showPopover = vi.fn(() => {
    if (!this.hasAttribute("popover")) throw new Error("showPopover requires the popover attribute");
    if (this.popoverOpen || !this.dispatchEvent({ type: "beforetoggle", oldState: "closed", newState: "open", bubbles: false })) return;
    this.popoverOpen = true; this.ownerDocument.queueToggle(this, false, true);
  });
  hidePopover = vi.fn(() => {
    if (!this.popoverOpen) return;
    this.dispatchEvent({ type: "beforetoggle", oldState: "open", newState: "closed", bubbles: false, cancelable: false });
    this.popoverOpen = false; this.ownerDocument.queueToggle(this, true, false);
  });
}

function harness(width = 800, height = 600) {
  const toggles = new Map<Element, { oldState: string; newState: string }>();
  const jobs = new Map<number, () => void>();
  let nextJob = 0;
  const document: any = Object.assign(new Target(), { readyState: "loading", nodeType: 9 });
  const window: any = Object.assign(new Target(), { innerWidth: width, innerHeight: height });
  document.parentNode = window;
  document.queueToggle = (node: Element, wasOpen: boolean, open: boolean) => toggles.set(node, {
    oldState: toggles.get(node)?.oldState || (wasOpen ? "open" : "closed"), newState: open ? "open" : "closed",
  });
  const make = (tag = "div", className = "", parent?: Element) => {
    const node = new Element(document, tag.toUpperCase()); node.className = className; parent?.appendChild(node); return node;
  };
  document.documentElement = make("html"); document.documentElement.parentNode = document;
  Object.defineProperties(document.documentElement, { clientWidth: { value: width }, clientHeight: { value: height } });
  document.body = make("body", "", document.documentElement); document.activeElement = document.body;
  document.createElement = (tag: string) => make(tag);
  document.querySelectorAll = (selector: string) => [document.documentElement, ...document.documentElement.querySelectorAll("*")].filter((node) => node.matches(selector));
  document.querySelector = (selector: string) => document.querySelectorAll(selector)[0] || null;
  document.getElementById = (id: string) => document.querySelector(`#${id}`);
  const content = make("main", "", document.body); content.id = "content";
  const list = make("div", "", content); list.id = "profile-list";
  const menu = (id: string, kind = "profile") => {
    const owner = make("div", kind === "more" ? "header-btns" : "profile-card", list);
    if (kind === "proxy") owner.dataset.proxyName = id; else if (kind === "profile") owner.dataset.dirId = id;
    const details = make("details", "card-menu", owner);
    if (kind === "more") details.id = "profiles-more-menu";
    const summary = make("summary", "", details); summary.box = rect(240, 80, 32, 24);
    summary.setAttribute("aria-label", "More actions");
    const panel = make("div", "card-menu-list", details);
    const action = make("button", "danger", panel); action.dataset.action = "delete";
    return { owner, details, summary, panel, action };
  };
  const a = menu("unit-menu-a"), b = menu("unit-menu-b");
  const outside = make("button", "", content);
  const visualViewport: any = Object.assign(new Target(), { width, height, offsetLeft: 0, offsetTop: 0, scale: 1 });
  const observers: MutationObserver[] = [];
  class MutationObserver {
    observed: Array<{ target: any; options: any }> = [];
    constructor(public callback: (records: any[], observer: MutationObserver) => void) { observers.push(this); }
    observe(target: any, options: any) { this.observed.push({ target, options }); }
    disconnect = vi.fn(() => { this.observed = []; });
  }
  const mutate = (target: Element, type = "attributes", attributeName = "hidden") => {
    for (const observer of observers) if (observer.observed.some(({ target: root, options }) =>
      (root === target || options.subtree && (root === document || root.contains(target))) && options[type] &&
      (type !== "attributes" || !options.attributeFilter || options.attributeFilter.includes(attributeName)))) {
      observer.callback([{ target, type, attributeName }], observer);
    }
  };
  // Fresh dialog prototype per VM: the real module patches showModal once.
  const modalEntry = vi.fn();
  class Dialog extends Element {
    _returnFocus: Element | null = null;
    showModal() { modalEntry(); this.open = true; this.querySelector("button")?.focus(); }
    close() { this.open = false; this.dispatchEvent({ type: "close", bubbles: false }); }
  }
  const dialog = new Dialog(document, "DIALOG"); document.body.appendChild(dialog);
  const submit = make("button", "", dialog); submit.setAttribute("type", "submit");
  const agentBrowser: any = { api: {}, R: {}, state: {}, helpers: { toast: vi.fn(), esc: String, escAttr: String }, fixtureCommand: vi.fn() };
  const schedule = (fn: () => void) => { jobs.set(++nextJob, fn); return nextJob; };
  const interval = vi.fn(() => 1);
  const getComputedStyle = (node: Element) => ({ display: node.hidden ? "none" : node.style.display || "block", visibility: node.style.visibility || "visible", ...node.style });
  Object.assign(window, { window, document, agentBrowser, visualViewport, getComputedStyle,
    requestAnimationFrame: schedule, cancelAnimationFrame: (id: number) => jobs.delete(id),
    setTimeout: schedule, clearTimeout: (id: number) => jobs.delete(id), MutationObserver, HTMLElement: Element, HTMLDialogElement: Dialog });
  const context = vm.createContext({ window, document, console, navigator: {}, MutationObserver,
    HTMLElement: Element, HTMLDetailsElement: Element, HTMLDialogElement: Dialog, getComputedStyle,
    setTimeout: schedule, clearTimeout: window.clearTimeout, setInterval: interval, clearInterval: vi.fn(),
    requestAnimationFrame: schedule, cancelAnimationFrame: window.cancelAnimationFrame });
  vm.runInContext(SOURCE, context, { filename: "delegation.js" }); // Whole module; no source extraction.
  document.readyState = "interactive";
  document.dispatchEvent({ type: "DOMContentLoaded", bubbles: false });
  const flush = () => {
    for (let turn = 0; toggles.size || jobs.size; turn++) {
      if (turn > 50) throw new Error("Menu controller did not settle queued toggle/timer events");
      const batch = [...toggles]; toggles.clear();
      for (const [node, states] of batch) node.dispatchEvent({ type: "toggle", bubbles: false, ...states });
      const tasks = [...jobs.values()]; jobs.clear(); for (const fn of tasks) fn();
    }
  };
  const open = (item = a) => { item.summary.click(); flush(); };
  const close = (scope?: any, restoreFocus?: boolean) => {
    expect(agentBrowser.closeCardMenus, "delegation must export the approved shared closeCardMenus helper").toBeTypeOf("function");
    agentBrowser.closeCardMenus(scope, restoreFocus);
  };
  return { document, window, content, list, menu, a, b, outside, visualViewport, dialog, submit,
    modalEntry, agentBrowser, observers, mutate, interval, open, close, flush };
}

type Menu = ReturnType<ReturnType<typeof harness>["menu"]>;
function expectOpen(item: Menu) {
  expect(item.details.open).toBe(true);
  expect(item.panel.getAttribute("popover"), "controller must promote the original panel to a manual popover").toBe("manual");
  expect(item.panel.matches(":popover-open")).toBe(true);
}
function expectClosed(item: Menu) {
  expect(item.details.open, "details.open must clear synchronously, before queued toggle").toBe(false);
  expect(item.panel.matches(":popover-open"), "native popover must hide synchronously").toBe(false);
}

describe("profile card menu lifecycle (whole delegation VM)", () => {
  it("actually binds delegated commands after DOMContentLoaded", () => {
    const h = harness();
    h.outside.setAttribute("data-role", "cmd"); h.outside.setAttribute("data-cmd", "fixtureCommand");
    h.outside.click();
    expect(h.agentBrowser.fixtureCommand).toHaveBeenCalledTimes(1);
  });

  it("exports the shared closer without requiring an already-open menu", () => {
    const h = harness(); h.outside.focus(); h.close();
    expectClosed(h.a); expectClosed(h.b);
    expect(h.document.activeElement).toBe(h.outside);
  });

  it("preserves the existing dialog focus hook for a non-menu trigger", () => {
    const h = harness(); h.outside.focus(); h.dialog.showModal(); h.flush();
    expect(h.dialog._returnFocus).toBe(h.outside);
    expect(h.document.activeElement).toBe(h.submit);
    h.dialog.close(); expect(h.document.activeElement).toBe(h.outside);
  });

  it.each(["profile", "proxy", "more"])("allows just one open menu, including %s ownership", (kind) => {
    const h = harness(), other = kind === "profile" ? h.b : h.menu("unit-other", kind);
    h.open(); expectOpen(h.a);
    h.open(other);
    expectClosed(h.a); expectOpen(other);
    expect(h.a.panel.hidePopover).toHaveBeenCalled();
  });

  it("closes synchronously with document/default focus semantics and ignores late toggle", () => {
    const h = harness(); h.open(); expectOpen(h.a);
    h.a.action.focus(); h.close(); // Do not flush: the open attribute change has a queued toggle.
    expectClosed(h.a);
    expect(h.document.activeElement).toBe(h.a.summary);
    h.flush(); expectClosed(h.a);
    h.open(); expectOpen(h.a);
    h.a.action.focus(); h.close(undefined, false);
    expectClosed(h.a);
    expect(h.document.activeElement).toBe(h.a.action);
    h.flush(); expectClosed(h.a);
  });

  it("hides a stale popover even when details is already closed and its rect is zero", () => {
    const h = harness(); h.open(); expectOpen(h.a);
    h.a.action.focus(); h.a.details.open = false; // Native close; toggle has not arrived.
    expect(h.a.panel.matches(":popover-open")).toBe(true);
    expect(h.a.panel.getBoundingClientRect().height).toBe(0);
    h.close(); // Must not rely solely on .card-menu[open] or nonzero geometry.
    expectClosed(h.a); expect(h.a.panel.hidePopover).toHaveBeenCalled();
    expect(h.document.activeElement).toBe(h.a.summary);
    h.flush(); expectClosed(h.a);
    h.open(); expectOpen(h.a); // Reopening is a fresh show, not a leaked old panel.
    expect(h.a.panel.showPopover).toHaveBeenCalledTimes(2);
  });

  it("scopes closure to the supplied DOM owner without stealing unrelated focus", () => {
    const h = harness(); h.open(h.b); expectOpen(h.b);
    h.b.action.focus(); h.close(h.a.owner);
    expectOpen(h.b); expect(h.document.activeElement).toBe(h.b.action);
    h.close(h.b.owner); expectClosed(h.b); expect(h.document.activeElement).toBe(h.b.summary);
    h.open(); h.outside.focus(); h.a.summary.focus.mockClear(); h.close();
    expectClosed(h.a); expect(h.document.activeElement).toBe(h.outside);
    expect(h.a.summary.focus).not.toHaveBeenCalled();
  });

  it("survives rapid repeat-toggle and a queued close followed by reopening", () => {
    const h = harness(); h.open(); expectOpen(h.a);
    h.a.summary.click(); h.flush(); expectClosed(h.a);
    h.a.summary.click(); h.flush(); expectOpen(h.a);
    h.close(); expectClosed(h.a);
    h.a.summary.click(); // Reopen before the previous close toggle task is delivered.
    h.flush(); expectOpen(h.a);
    h.a.summary.click(); h.flush(); expectClosed(h.a);
  });

  it("Escape restores a connected summary; outside click preserves outside focus", () => {
    const h = harness(); h.open(); expectOpen(h.a);
    h.a.action.focus();
    h.a.action.dispatchEvent({ type: "keydown", key: "Escape", bubbles: true });
    expectClosed(h.a); expect(h.document.activeElement).toBe(h.a.summary);
    h.flush(); h.open(); expectOpen(h.a);
    h.a.summary.focus.mockClear(); h.outside.click();
    expectClosed(h.a); expect(h.document.activeElement).toBe(h.outside);
    expect(h.a.summary.focus).not.toHaveBeenCalled();
    h.flush(); h.open(); h.a.action.focus(); h.a.summary.focus.mockClear();
    // Clicking non-focusable page space leaves focus inside the panel before
    // closure; an outside event must still opt out of explicit restoration.
    h.content.dispatchEvent({ type: "click", bubbles: true });
    expectClosed(h.a); expect(h.a.summary.focus).not.toHaveBeenCalled();
  });

  it("leaves native summary Enter/Space/Tab key defaults intact", () => {
    const h = harness();
    for (const key of ["Enter", " ", "Tab"]) {
      const event: any = { type: "keydown", key, bubbles: true };
      h.a.summary.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    // click() models native activation only; Electron must prove real key defaults.
    h.open(); expectOpen(h.a);
  });

  it("keeps internal non-bubbling scroll open, but closes on content and page scroll", () => {
    const h = harness(); h.open(); expectOpen(h.a);
    h.a.action.focus(); h.a.summary.focus.mockClear();
    h.a.action.dispatchEvent({ type: "scroll", bubbles: false }); expectOpen(h.a);
    h.a.panel.dispatchEvent({ type: "scroll", bubbles: false }); expectOpen(h.a);
    h.content.dispatchEvent({ type: "scroll", bubbles: false }); expectClosed(h.a);
    expect(h.a.summary.focus).not.toHaveBeenCalled();
    h.flush(); h.open(); expectOpen(h.a);
    h.window.dispatchEvent({ type: "scroll", bubbles: false }); expectClosed(h.a);
  });

  it.each(["window resize", "visualViewport resize", "visualViewport scroll"])("closes on %s without focus theft", (event) => {
    const h = harness(); h.open(); expectOpen(h.a);
    h.a.action.focus(); h.a.summary.focus.mockClear();
    h.visualViewport.scale = 1.5; // Event contract, not actual browser zoom evidence.
    const target = event.startsWith("window") ? h.window : h.visualViewport;
    target.dispatchEvent({ type: event.endsWith("scroll") ? "scroll" : "resize", bubbles: false });
    expectClosed(h.a); expect(h.document.activeElement).toBe(h.a.action);
    expect(h.a.summary.focus).not.toHaveBeenCalled();
  });

  it.each(["hidden", "detached"])("cleans up a %s owner and disconnects open-only observers", (state) => {
    const h = harness();
    expect(h.observers.filter((observer) => observer.observed.length)).toHaveLength(0);
    h.open(); expectOpen(h.a);
    const observing = h.observers.filter((observer) => observer.observed.length);
    expect(observing.length, "owner cleanup must be observed while a menu is open").toBeGreaterThan(0);
    h.a.action.focus(); h.a.summary.focus.mockClear();
    if (state === "hidden") { h.a.owner.hidden = true; h.mutate(h.a.owner); }
    else { h.a.owner.remove(); h.mutate(h.list, "childList"); }
    h.flush(); expectClosed(h.a);
    expect(h.a.summary.focus).not.toHaveBeenCalled();
    expect(h.observers.filter((observer) => observer.observed.length)).toHaveLength(0);
    for (const observer of observing) expect(observer.disconnect).toHaveBeenCalled();
    expect(h.interval).not.toHaveBeenCalled();
    h.open(h.b); expectOpen(h.b); // Cleanup must not permanently disable the controller.
    h.close(); expectClosed(h.b);
    expect(h.observers.filter((observer) => observer.observed.length)).toHaveLength(0);
  });

  it("rejects busy owners, also closing a panel when its owner becomes busy", () => {
    const h = harness();
    h.a.owner.classList.add("busy"); h.a.owner.setAttribute("aria-busy", "true");
    h.open(); expectClosed(h.a);
    expect(h.a.panel.showPopover).not.toHaveBeenCalled();
    h.a.owner.classList.remove("busy"); h.a.owner.setAttribute("aria-busy", "false");
    h.open(); expectOpen(h.a);
    h.a.owner.classList.add("busy"); h.a.owner.setAttribute("aria-busy", "true");
    h.mutate(h.a.owner, "attributes", "class"); h.flush(); expectClosed(h.a);
    h.open(); expectClosed(h.a);
  });

  it("preserves the original card, panel and ID for container event delegation", () => {
    const h = harness(), dispatched = vi.fn();
    h.list.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (action && h.list.contains(action)) dispatched(action.closest(".profile-card").dataset.dirId);
    });
    h.open(); expectOpen(h.a);
    expect(h.a.panel.parentElement).toBe(h.a.details);
    expect(h.a.action.closest(".profile-card")).toBe(h.a.owner);
    expect(h.list.contains(h.a.panel)).toBe(true);
    h.a.action.click();
    expect(dispatched).toHaveBeenCalledExactlyOnceWith("unit-menu-a");
    expect(h.b.owner.dataset.dirId).toBe("unit-menu-b");
    // Only proves DOM ownership/event routing, not real profile deletion or IPC.
  });

  it("synchronously closes shared data-cmd menus before the command runs", () => {
    const h = harness(), more = h.menu("more", "more");
    more.action.setAttribute("data-role", "cmd"); more.action.setAttribute("data-cmd", "fixtureCommand");
    h.agentBrowser.fixtureCommand.mockImplementation(() => { expectClosed(more); });
    h.open(more); expectOpen(more); more.action.click();
    expect(h.agentBrowser.fixtureCommand).toHaveBeenCalledTimes(1);
    h.flush(); expectClosed(more);
  });

  it("showModal closes the menu before native entry and captures summary, not hidden action", () => {
    const h = harness();
    // Stand-in for an existing card handler, not a mocked deletion success.
    h.list.addEventListener("click", (event) => { if (event.target === h.a.action) h.dialog.showModal(); });
    h.modalEntry.mockImplementation(() => { expectClosed(h.a); });
    h.open(); expectOpen(h.a); h.a.action.click();
    expect(h.modalEntry).toHaveBeenCalledTimes(1);
    expect(h.dialog._returnFocus).toBe(h.a.summary);
    h.flush(); expect(h.document.activeElement).toBe(h.submit);
    h.dialog.close();
    expect(h.document.activeElement).toBe(h.a.summary);
    expect(h.dialog._returnFocus).toBeNull(); expectClosed(h.a);
  });

  it("hides a closed manual popover and guards against legacy display:flex leakage", () => {
    const h = harness(); h.open(); expectOpen(h.a); h.close(); expectClosed(h.a); h.flush();
    // Narrow static CSS guard, paired with lifecycle behavior above. This does
    // not simulate computed style or claim that fake DOM proves real invisibility.
    const guards = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => selectors.split(",").some((selector) =>
      selector.includes("[popover]") && selector.includes(":not(:popover-open)") && h.a.panel.matches(selector.replace(/\/\*[\s\S]*?\*\//g, "").trim())));
    expect(guards.some(([, , declarations]) => /(?:^|;)\s*display\s*:\s*none\s*(?:!important\s*)?(?:;|$)/.test(declarations)),
      "closed-popover author rule must override the existing .card-menu-list display:flex").toBe(true);
  });
});

describe("menu placement arithmetic (synthetic CSS-pixel rects, not native layout)", () => {
  it.each(["below", "above"])("right-aligns %s when it fits", (placement) => {
    const h = harness();
    h.a.summary.box = placement === "below" ? rect(300, 40, 32, 24) : rect(740, 560, 32, 24);
    h.open(); expectOpen(h.a);
    const box = h.a.panel.getBoundingClientRect(), anchor = h.a.summary.box;
    expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0);
    expect(Math.abs(box.right - anchor.right)).toBeLessThanOrEqual(1);
    expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(800);
    expect(box.top).toBeGreaterThanOrEqual(0); expect(box.bottom).toBeLessThanOrEqual(600);
    if (placement === "below") expect(box.top).toBeGreaterThanOrEqual(anchor.bottom);
    else expect(box.bottom).toBeLessThanOrEqual(anchor.top);
  });

  it("clamps width before measuring wrapped height in a narrow viewport", () => {
    const h = harness(180, 300);
    h.a.summary.box = rect(150, 16, 24, 24); h.a.panel.box = rect(0, 0, 480, 180);
    h.a.panel.heightAtWidth = (width) => width <= 180 ? 420 : 180;
    h.open(); expectOpen(h.a);
    expect(h.a.panel.measurements[0]?.width, "height must be measured after constraining width").toBeLessThanOrEqual(180);
    const box = h.a.panel.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0); expect(box.width).toBeLessThanOrEqual(180);
    expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(180);
    expect(box.top).toBeGreaterThanOrEqual(h.a.summary.box.bottom); expect(box.bottom).toBeLessThanOrEqual(300);
    expect(px(h.a.panel.style.maxHeight, NaN)).toBeGreaterThan(0);
    expect(h.a.panel.scrollHeight).toBeGreaterThan(h.a.panel.clientHeight);
  });

  it("chooses the larger side when neither fits and caps height instead of overflowing", () => {
    const h = harness(400, 300);
    h.a.summary.box = rect(300, 100, 32, 24); h.a.panel.box = rect(0, 0, 240, 450);
    h.open(); expectOpen(h.a);
    const box = h.a.panel.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(h.a.summary.box.bottom); // Below has 176px; above has 100px.
    expect(box.bottom).toBeLessThanOrEqual(300);
    expect(px(h.a.panel.style.maxHeight, NaN)).toBeGreaterThan(0);
    expect(px(h.a.panel.style.maxHeight, NaN)).toBeLessThanOrEqual(176);
    expect(h.a.panel.scrollHeight).toBeGreaterThan(h.a.panel.clientHeight);
  });
});
