// Whole renderer modules in a fresh, exclusively owned synthetic DOM/VM per case.
// No Electron process, real cloud, credentials, user data, network or disk writes.
// This models DOM state/events, not CSS layout, native focus or native dialogs.
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(__dirname, "../..");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const SOURCES = Object.fromEntries(["core", "profiles", "accounts"].map(name => [name,
  fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${name}.js`), "utf8"),
]));
const SCOPE = "portable-profile+preferences";
const PROFILE = {
  dirId: "r3_synthetic_a", name: "Saved synthetic profile", engine: "chromium", fingerprintMode: "managed",
  fingerprintSeed: 12345, platform: "macos", timezone: "UTC", locale: "en-US", tags: ["synthetic"],
  syncStatus: "synced", syncScope: SCOPE, syncReason: "baseline-match", syncedAt: 1000,
  lastModified: 2000, running: false, pid: null, proxyMode: "none", proxyName: null,
};
const ACCOUNT = {
  platformUrl: "https://r3.synthetic.invalid", platformUserName: "Synthetic account", hasPassword: true,
  tags: [], profileIds: [PROFILE.dirId], ref: { index: 0, revision: "r3-synthetic-revision" },
};
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
  insertBefore(child: Element, before: Element | null) {
    this.appendChild(child);
    if (before) { this.children.pop(); this.children.splice(this.children.indexOf(before), 0, child); }
    return child;
  }
  removeChild(child: Element) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(key: string, value: string) { this.attributes[key] = String(value); }
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
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; this.dispatchEvent({ type: "toggle", newState: "open" }); }
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
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function harness(kind: "profiles" | "accounts" = "profiles") {
  const document: any = {};
  const root = new Element(document, "#DOCUMENT"); parseInto(HTML, root);
  Object.assign(document, {
    getElementById: (id: string) => root.querySelector("#" + id),
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    createElement: (tag: string) => new Element(document, tag.toUpperCase()),
    createDocumentFragment: () => new Element(document, "#FRAGMENT"),
  });
  document.body = document.querySelector("body"); document.documentElement = document.querySelector("html"); document.activeElement = document.body;
  const api = {
    browser: {
      list: vi.fn(async (): Promise<any[]> => [structuredClone(PROFILE)]),
      binary: vi.fn(async (): Promise<any> => ({ installed: true, version: "synthetic-engine", installedVersions: [] })),
      engineStatus: vi.fn(async (): Promise<any> => ({ firefox: { installed: true } })),
    },
    proxy: { list: vi.fn(async (): Promise<any[]> => []) },
    team: { status: vi.fn(async (): Promise<any> => ({ local: { role: "owner" } })) },
    agent: { accounts: {
      list: vi.fn(async (): Promise<any[]> => [structuredClone(ACCOUNT)]),
      get: vi.fn(async (): Promise<any> => structuredClone(ACCOUNT)),
      add: vi.fn(async () => ACCOUNT), update: vi.fn(async () => ACCOUNT),
    } },
  };
  const window: any = { agentBrowserAPI: api };
  const memory = new Map<string, string>();
  const context = vm.createContext({ window, document, console,
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) },
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
    Option: function(text: string, value: string) { const option = document.createElement("option"); option.textContent = text; option.value = value; return option; },
  });
  vm.runInContext(SOURCES.core, context, { filename: "core.js" });
  const app: any = window.agentBrowser;
  app.helpers.toast = vi.fn(); app.state.currentTab = kind;
  app.ipc = { call: vi.fn((_key: string, fn: () => unknown) => Promise.resolve().then(fn)) };
  app.renderViewState = vi.fn((el: Element, options: any) => { el.textContent = options.error || options.empty || ""; });
  vm.runInContext(SOURCES[kind], context, { filename: kind + ".js" });
  const el = (id: string): Element => { const found = document.getElementById(id); if (!found) throw new Error("Missing HTML fixture element " + id); return found; };
  const cards = () => el("profile-list").querySelectorAll(":scope > .profile-card");
  const badge = () => cards()[0]?.querySelector(".badge-governance")!;
  const invalidate = () => {
    const hook = app[kind === "profiles" ? "invalidateProfilesForSync" : "invalidateAccountsForSync"];
    expect(hook, "synchronous sync invalidation hook").toBeTypeOf("function");
    expect(hook()).toBeUndefined();
  };
  return { app, api, el, document, cards, badge, invalidate, toast: app.helpers.toast };
}

// Assertions exercise rendered nodes from the complete modules, not text searches
// or a duplicate renderer. Deferred replies are individually controlled per VM.
describe("R3 profile proof scope and honest sync presentation", () => {
  it.each([[1000, 500], [1000, 2000], [0, 0]])("legacy helper timestamps %j/%j never prove synced or dirty", (syncedAt, modified) => {
    const h = harness(); expect(h.app.helpers.getSyncStatus(syncedAt, modified)).toBe("unknown");
  });
  it("keeps an explicit unknown status distinct from never", async () => {
    const h = harness(); h.api.browser.list.mockResolvedValue([{ ...PROFILE, syncStatus: "unknown", syncReason: "legacy-marker" }]);
    h.app.loadProfiles(); await flush();
    expect(h.cards()).toHaveLength(1); expect(h.badge().textContent).toContain("Unknown");
    expect(h.badge().classList.contains("sync-never")).toBe(false);
    expect(h.badge().getAttribute("title")).toMatch(/legacy/i);
  });
  it.each(["synced", undefined, "future-status"])("does not guess %j legacy state green from a directory mtime", async syncStatus => {
    const h = harness(); h.api.browser.list.mockResolvedValue([{ ...PROFILE, syncStatus, syncScope: undefined, syncReason: undefined, lastModified: 500 }]);
    h.app.loadProfiles(); await flush();
    expect(h.badge().textContent).toContain("Unknown"); expect(h.badge().classList.contains("sync-synced")).toBe(false);
  });
  it("describes dirty as saved locally, not an unsaved form", async () => {
    const h = harness(); h.api.browser.list.mockResolvedValue([{ ...PROFILE, syncStatus: "dirty", syncReason: "content-changed" }]);
    h.app.loadProfiles(); await flush();
    expect(h.badge().textContent).toBe(" Local changes");
    expect(h.badge().getAttribute("title")).toMatch(/saved locally/i);
    expect(h.badge().getAttribute("title")).not.toMatch(/unsaved/i);
  });
  it.each([
    ["legacy-marker", /legacy/i], ["invalid-baseline", /unusable/i], ["target-mismatch", /target changed/i],
    ["target-unavailable", /target unavailable/i], ["preferences-unavailable", /Preferences.*read/i],
    ["content-unavailable", /metadata.*read/i],
  ])("states the narrow proof scope and exact %s uncertainty", async (syncReason, reason) => {
    const h = harness(); h.api.browser.list.mockResolvedValue([{ ...PROFILE, syncStatus: "unknown", syncReason }]);
    h.app.loadProfiles(); await flush();
    const title = h.badge().getAttribute("title") || "";
    expect(title).toMatch(reason); expect(title).toMatch(/portable profile metadata and Preferences only/i);
    expect(title).toMatch(/cookies.*not verified/i);
  });
  it("keeps timestamp zero and valid proof independent of newer directory mtime", async () => {
    const h = harness(); h.api.browser.list.mockResolvedValue([{ ...PROFILE, syncedAt: 0 }]);
    h.app.loadProfiles(); await flush();
    expect(h.badge().classList.contains("sync-synced")).toBe(true);
    expect(h.badge().getAttribute("title")).toContain(new Date(0).toLocaleString());
    expect(h.badge().getAttribute("title")).toMatch(/portable profile metadata and Preferences only/i);
  });
  it("keeps confirmed no-baseline profiles as never, with scope rather than a whole-profile claim", async () => {
    const h = harness(); h.api.browser.list.mockResolvedValue([{ ...PROFILE, syncedAt: null, syncStatus: "never", syncReason: "no-baseline" }]);
    h.app.loadProfiles(); await flush();
    expect(h.badge().textContent).toContain("Never"); expect(h.badge().getAttribute("title")).toMatch(/no sync baseline/i);
    expect(h.badge().getAttribute("title")).toMatch(/portable profile metadata and Preferences only/i);
  });
});

describe("R3 profile reload generations and draft preservation", () => {
  it("a newer ordinary reload already rejects the older list response", async () => {
    const h = harness(), old = deferred<any[]>(); h.api.browser.list.mockReturnValueOnce(old.promise);
    h.app.loadProfiles(); await flush(); h.api.browser.list.mockResolvedValue([{ ...PROFILE, name: "Newest list" }]);
    h.app.loadProfiles(true); await flush(); old.resolve([{ ...PROFILE, name: "Stale list" }]); await flush();
    expect(h.cards()[0].textContent).toContain("Newest list"); expect(h.cards()[0].textContent).not.toContain("Stale list");
  });
  it.each(["success", "failure"])("sync invalidation prevents pending list %s from publishing even before another load", async result => {
    const h = harness(); h.app.loadProfiles(); await flush(); const before = h.el("profile-list").innerHTML;
    const old = deferred<any[]>(); h.api.browser.list.mockReturnValueOnce(old.promise); h.app.loadProfiles(true); await flush();
    const calls = h.api.browser.list.mock.calls.length; h.invalidate();
    if (result === "success") old.resolve([{ ...PROFILE, name: "Invalidated profile" }]); else old.reject(new Error("Invalidated error"));
    await flush(); expect(h.el("profile-list").innerHTML).toBe(before); expect(h.api.browser.list).toHaveBeenCalledTimes(calls);
  });
  it("invalidates pending engine replies as well as metadata", async () => {
    const h = harness(); h.app.loadProfiles(); await flush(); const binary = deferred<any>();
    h.api.browser.binary.mockReturnValueOnce(binary.promise); h.app.loadProfiles(true); await flush();
    const before = h.el("engine-banner").innerHTML; h.invalidate(); binary.resolve({ installed: false }); await flush();
    expect(h.el("engine-banner").innerHTML).toBe(before);
  });
  it("refresh retains active tag search, selection, exact edit inputs, focus and scroll", async () => {
    const h = harness(); h.el("profile-tag-filter").value = "synthetic"; h.app.onProfileFilterChange(); await flush();
    h.el("profile-select-all").checked = true; h.app.onProfileSelectAllChange();
    h.app.editProfile(PROFILE.dirId); await flush();
    h.el("agent-browser-meta-name").value = "  Exact unsaved draft\n";
    h.el("agent-browser-meta-timezone").value = "Asia/Tokyo"; h.el("agent-browser-meta-name").focus(); h.el("content").scrollTop = 71;
    h.invalidate(); h.api.browser.list.mockResolvedValue([{ ...PROFILE, name: "New saved metadata", syncedAt: 2000 }]);
    h.app.loadProfiles(true); await flush();
    expect(h.el("profile-tag-filter").value).toBe("synthetic"); expect(h.el("profile-selected-count").textContent).toBe("1");
    expect(h.cards()[0].querySelector(".profile-select-checkbox")?.checked).toBe(true);
    expect(h.el("dlg-agent-browser-seed").open).toBe(true); expect(h.el("agent-browser-meta-name").value).toBe("  Exact unsaved draft\n");
    expect(h.el("agent-browser-meta-timezone").value).toBe("Asia/Tokyo"); expect(h.document.activeElement).toBe(h.el("agent-browser-meta-name"));
    expect(h.el("content").scrollTop).toBe(71);
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/changed.*editor.*open/i), "info", expect.objectContaining({ ttlMs: 0 }));
  });
  it("unchanged saved content/runtime-only changes do not falsely warn an open editor", async () => {
    const h = harness(); h.app.loadProfiles(); await flush(); h.app.editProfile(PROFILE.dirId); await flush(); h.toast.mockClear();
    h.api.browser.list.mockResolvedValue([{ ...PROFILE, lastModified: 9000, running: true, pid: 444, version: "new-runtime" }]);
    h.app.loadProfiles(true); await flush(); expect(h.toast).not.toHaveBeenCalled();
  });
  it("older edit-profile reads cannot overwrite the newer dialog", async () => {
    const h = harness(), old = deferred<any[]>(); h.api.browser.list.mockReturnValueOnce(old.promise);
    h.app.editProfile(PROFILE.dirId); h.api.browser.list.mockResolvedValue([{ ...PROFILE, dirId: "r3_synthetic_b", name: "Newest edit" }]);
    h.app.editProfile("r3_synthetic_b"); await flush(); h.el("agent-browser-meta-name").value = "Newest edit draft";
    old.resolve([PROFILE]); await flush();
    expect(h.el("agent-browser-meta-dir-id").value).toBe("r3_synthetic_b"); expect(h.el("agent-browser-meta-name").value).toBe("Newest edit draft");
  });
  it("sync invalidates a pending edit read without opening or populating a stale form", async () => {
    const h = harness(), old = deferred<any[]>(); h.api.browser.list.mockReturnValueOnce(old.promise); h.app.editProfile(PROFILE.dirId);
    h.el("agent-browser-meta-name").value = "Existing untouched input"; h.invalidate(); old.resolve([PROFILE]); await flush();
    expect(h.el("dlg-agent-browser-seed").open).toBe(false); expect(h.el("agent-browser-meta-name").value).toBe("Existing untouched input");
  });
  it("a late version read from a previous editor cannot overwrite a newer version draft", async () => {
    const h = harness(), old = deferred<any>(); h.api.browser.binary.mockReturnValueOnce(old.promise);
    h.api.browser.list.mockResolvedValueOnce([{ ...PROFILE, browserVersion: "old-pin" }]);
    h.app.editProfile(PROFILE.dirId); await flush();
    h.api.browser.list.mockResolvedValueOnce([{ ...PROFILE, dirId: "r3_synthetic_b", browserVersion: "new-pin" }]);
    h.app.editProfile("r3_synthetic_b"); await flush();
    expect(h.el("agent-browser-meta-browser-version").value).toBe("new-pin");
    h.el("agent-browser-meta-browser-version").value = "";
    old.resolve({ installed: true, installedVersions: [{ version: "old-pin" }] }); await flush();
    expect(h.el("agent-browser-meta-browser-version").value).toBe("");
  });
  it("sync invalidation blocks a pending version reply without changing an open editor's inputs", async () => {
    const h = harness(), old = deferred<any>(); h.api.browser.binary.mockReturnValueOnce(old.promise);
    h.app.editProfile(PROFILE.dirId); await flush(); const before = h.el("agent-browser-meta-browser-version").innerHTML;
    h.invalidate(); old.resolve({ installed: true, installedVersions: [{ version: "late-version" }] }); await flush();
    expect(h.el("agent-browser-meta-browser-version").innerHTML).toBe(before);
  });
  it("a late version reply keeps a user's current version choice within the same editor", async () => {
    const h = harness(), old = deferred<any>(); h.api.browser.binary.mockReturnValueOnce(old.promise);
    h.api.browser.list.mockResolvedValueOnce([{ ...PROFILE, browserVersion: "original-pin" }]); h.app.editProfile(PROFILE.dirId); await flush();
    h.el("agent-browser-meta-browser-version").value = "";
    old.resolve({ installed: true, installedVersions: [{ version: "original-pin" }] }); await flush();
    expect(h.el("agent-browser-meta-browser-version").value).toBe("");
  });
  it("a late editor proxy read cannot restore a stale selection or overwrite an edited choice", async () => {
    const h = harness(), old = deferred<any[]>(); h.api.proxy.list.mockReturnValueOnce(old.promise); h.app.editProfile(PROFILE.dirId); await flush();
    const select = h.el("agent-browser-meta-proxy"); select.value = "default"; select.dispatchEvent({ type: "change" });
    old.resolve([{ name: "late-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 8901 } }]); await flush();
    expect(select.value).toBe("default");
  });
});

describe("R3 Accounts invalidation and fail-closed role generations", () => {
  it("ordinary out-of-order list reloads cannot replay old rows", async () => {
    const h = harness("accounts"), old = deferred<any[]>(); h.api.agent.accounts.list.mockReturnValueOnce(old.promise);
    h.app.loadAccountsTab(); await flush(); h.api.agent.accounts.list.mockResolvedValue([{ ...ACCOUNT, platformUserName: "Newest account" }]);
    h.app.loadAccountsTab(); await flush(); old.resolve([{ ...ACCOUNT, platformUserName: "Stale account" }]); await flush();
    expect(h.el("accounts-tab-list").textContent).toContain("Newest account"); expect(h.el("accounts-tab-list").textContent).not.toContain("Stale account");
  });
  it.each(["success", "failure"])("sync invalidates pending %s on both account list surfaces", async result => {
    const h = harness("accounts"); h.app.agentLoadAccounts(); await flush();
    const oldA = deferred<any[]>(), oldB = deferred<any[]>();
    h.api.agent.accounts.list.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(oldB.promise); h.app.agentLoadAccounts(); await flush();
    h.invalidate(); const snapshots = [h.el("agent-accounts-list").innerHTML, h.el("accounts-tab-list").innerHTML];
    for (const old of [oldA, oldB]) if (result === "success") old.resolve([{ ...ACCOUNT, platformUserName: "Invalidated account" }]); else old.reject(new Error("Invalidated account error"));
    await flush(); expect([h.el("agent-accounts-list").innerHTML, h.el("accounts-tab-list").innerHTML]).toEqual(snapshots);
  });
  it.each(["owner", "admin", "member"])("an invalidated pending %s role cannot reauthorize a later viewer generation", async role => {
    const h = harness("accounts"), old = deferred<any>(); h.api.team.status.mockReturnValueOnce(old.promise);
    h.app.loadAccountsTab(); await flush(); h.invalidate(); h.api.team.status.mockResolvedValue({ local: { role: "viewer" } });
    h.app.agentLoadAccounts(); await flush(); old.resolve({ local: { role } }); await flush();
    expect(h.api.team.status).toHaveBeenCalledTimes(2);
    for (const id of ["accounts-tab-list", "agent-accounts-list"]) expect(h.el(id).querySelector('[data-cmd="agentEditAccount"]')).toBeNull();
    for (const button of h.document.querySelectorAll('[data-cmd="agentAddAccount"]')) expect(button.style.display).toBe("none");
    h.app.agentAddAccount(); await flush(); expect(h.el("dlg-account").open).toBe(false); expect(h.api.agent.accounts.add).not.toHaveBeenCalled();
  });
  it("invalidation between a cached role read and its action continuation fails closed", async () => {
    const h = harness("accounts"); h.app.loadAccountsTab(); await flush();
    h.app.agentAddAccount(); h.invalidate(); h.api.team.status.mockResolvedValue({ local: { role: "viewer" } }); await flush();
    expect(h.el("dlg-account").open).toBe(false); expect(h.api.agent.accounts.add).not.toHaveBeenCalled();
  });
  it("a stale rejected role request cannot overwrite a newer owner cache or toolbar", async () => {
    const h = harness("accounts"), old = deferred<any>(); h.api.team.status.mockReturnValueOnce(old.promise);
    h.app.loadAccountsTab(); await flush(); h.invalidate(); h.app.agentLoadAccounts(); await flush();
    old.reject(new Error("Old synthetic role failure")); await flush(); h.app.agentAddAccount(); await flush();
    expect(h.api.team.status).toHaveBeenCalledTimes(2); expect(h.el("dlg-account").open).toBe(true);
    for (const button of h.document.querySelectorAll('[data-cmd="agentAddAccount"]')) expect(button.style.display).toBe("");
    expect(h.toast.mock.calls.some((call: any[]) => /role unavailable/i.test(call[0]))).toBe(false);
  });
  it("cached owner invalidation immediately revokes the toolbar without wiping an open draft", async () => {
    const h = harness("accounts"); h.app.loadAccountsTab(); await flush(); h.app.agentAddAccount(); await flush();
    h.el("acct-username").value = "Exact unsaved account draft"; h.el("acct-password").value = "Synthetic draft only";
    const reads = h.api.team.status.mock.calls.length; h.invalidate();
    expect(h.el("dlg-account").open).toBe(true); expect(h.el("acct-username").value).toBe("Exact unsaved account draft");
    expect(h.el("acct-password").value).toBe("Synthetic draft only"); expect(h.api.team.status).toHaveBeenCalledTimes(reads);
    for (const button of h.document.querySelectorAll('[data-cmd="agentAddAccount"]')) expect(button.style.display).toBe("none");
    h.api.team.status.mockRejectedValueOnce(new Error("Synthetic role denial")); h.app.saveAccount(); await flush();
    expect(h.api.agent.accounts.add).not.toHaveBeenCalled(); expect(h.el("acct-username").value).toBe("Exact unsaved account draft");
  });
  it.each([null, {}, { local: {} }, { local: { role: "future-role" } }])("malformed role response %j cannot grant owner controls", async status => {
    const h = harness("accounts"); h.api.team.status.mockResolvedValue(status); h.app.loadAccountsTab(); await flush();
    expect(h.el("accounts-tab-list").querySelector('[data-cmd="agentEditAccount"]')).toBeNull();
    h.app.agentAddAccount(); await flush(); expect(h.el("dlg-account").open).toBe(false);
  });
});
