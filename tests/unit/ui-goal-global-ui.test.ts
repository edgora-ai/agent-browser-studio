import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import * as os from "node:os";
const disk = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../src/main/services/config-manager.js", () => ({ getAppDataDir: () => disk.dir }));
import * as store from "../../src/main/services/agent/conversation-store.js";

const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const source = (name: string) => fs.readFileSync(path.join(ROOT, "src/renderer/js", name), "utf8");
type Handler = (event: any) => void;

// Controlled in-memory DOM/API fixture. No Electron, browser, real config,
// keychain or persisted user data is involved in these renderer regressions.
class Element {
  nodeType = 1;
  children: Element[] = [];
  parentNode: Element | null = null;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  handlers: Record<string, Handler[]> = {};
  value = "";
  disabled = false;
  checked = false;
  open = false;
  private text = "";
  private markup: string | null = null;
  constructor(public tagName = "div") {}
  get id() { return this.attributes.id || ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className() { return this.attributes.class || ""; }
  set className(value: string) { this.setAttribute("class", value); }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (name: string) => { if (!this.classList.contains(name)) this.className += " " + name; },
    remove: (name: string) => { this.className = this.className.split(/\s+/).filter(n => n !== name).join(" "); },
    toggle: (name: string, force?: boolean) => { (force ?? !this.classList.contains(name)) ? this.classList.add(name) : this.classList.remove(name); },
  };
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(""); }
  set textContent(value: string) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this.text = String(value); this.markup = null; }
  get innerHTML(): string { return this.markup ?? this.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + this.children.map(c => c.innerHTML).join(""); }
  set innerHTML(value: string) { this.textContent = ""; this.markup = value; }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0]; }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = String(value);
    if (name === "style") for (const part of value.split(";")) { const [k, v] = part.split(":"); if (k && v) this.style[k.trim()] = v.trim(); }
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  appendChild(child: Element) { child.parentNode?.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: Element) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; }
  addEventListener(name: string, handler: Handler) { (this.handlers[name] ||= []).push(handler); }
  dispatchEvent(event: { type: string }) { this.handlers[event.type]?.forEach(fn => fn(event)); return true; }
  remove() { this.parentNode?.removeChild(this); }
  focus() {}
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(c => [...(matches(c, selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
}
function matches(el: Element, selector: string) {
  if (selector.startsWith("#")) return el.id === selector.slice(1);
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector);
  return attr ? el.getAttribute(attr[1]) !== null && (attr[2] === undefined || el.getAttribute(attr[1]) === attr[2]) : el.tagName === selector;
}
function parseHtml() {
  const root = new Element("root");
  const stack = [root];
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g)) {
    const s = token[0];
    if (s.startsWith("<!--")) continue;
    if (s.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
    if (!s.startsWith("<")) { const text = new Element("text"); text.nodeType = 3; text.textContent = s; stack[stack.length - 1].appendChild(text); continue; }
    const tag = /^<([\w-]+)/.exec(s)?.[1];
    if (!tag) continue;
    const el = new Element(tag);
    for (const attr of s.matchAll(/\s([\w-]+)(?:="([^"]*)"|'([^']*)')?/g)) el.setAttribute(attr[1], attr[2] ?? attr[3] ?? "");
    stack[stack.length - 1].appendChild(el);
    if (!/^(meta|link|input|img|br|hr)$/.test(tag) && !s.endsWith("/>")) stack.push(el);
  }
  return root;
}
function harness(options: { init?: boolean; binary?: () => Promise<any>; version?: () => Promise<any>; integratedChat?: boolean } = {}) {
  const dom = parseHtml();
  const document = Object.assign(dom, {
    readyState: "loading",
    documentElement: dom.querySelector("html")!,
    body: dom.querySelector("body")!,
    getElementById: (id: string) => dom.querySelector("#" + id),
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => { const el = new Element("text"); el.nodeType = 3; el.textContent = text; return el; },
  });
  const storage = new Map<string, string>();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const api: any = {
    browser: { binary: vi.fn(options.binary || (async () => ({ installed: false }))), list: vi.fn(async () => []) },
    app: { version: vi.fn(options.version || (async () => "9.8.7-controlled")), setLanguage: vi.fn(async () => undefined) },
    agent: {
      conversations: {
        list: vi.fn(async (): Promise<any[]> => []), get: vi.fn(async (_id: string): Promise<any> => null),
        create: vi.fn(async (): Promise<any> => ({ id: "created-controlled", title: "New Chat", titleKind: "default", messages: [] })),
      },
      activeRun: vi.fn(async (_id: string): Promise<any> => null),
      llmConfig: vi.fn(async (): Promise<any> => ({ provider: "openai" })),
      detectLlmConfig: vi.fn(async (): Promise<any> => null),
      saveLlmConfig: vi.fn(async (_cfg: any) => ({ success: true })),
    },
    settings: { agentFsGet: vi.fn(async () => ({ mode: "sandbox", allowlist: [] })) },
    on: vi.fn(),
  };
  const window: any = { agentBrowserAPI: api, icons: { svg: (name: string) => `<svg data-test-icon="${name}"></svg>` } };
  const context = vm.createContext({
    window, document, navigator: { language: "en-US" }, console,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    CustomEvent: class { constructor(public type: string, public detail?: any) {} },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
  });
  const run = (name: string) => vm.runInContext(source(name), context, { filename: name });
  run("i18n.js"); run("app/core.js"); run("app/tabs.js"); run("app/agent-chat.js"); run("app/agent-chat-content.js"); run("app/agent-config.js");
  const app: any = window.agentBrowser;
  for (const method of ["loadProfiles", "loadSyncConfig", "maybeShowWizard", "agentLoadSkills", "agentLoadAccounts", "agentLoadAdapters", ...(options.integratedChat ? [] : ["agentLoadConversations", "agentRefreshEnvironments", "agentRenderConvs", "agentRenderMessages"])]) app[method] = vi.fn();
  if (options.init) run("app/init.js");
  const el = (id: string) => document.getElementById(id)!;
  return { window, api, app, document, el, storage, timers, run };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

describe("global UI whole-module controlled fixtures", () => {
  it("keeps default error and explicit zero TTL until dismissed, while success expires", () => {
    const h = harness();
    const error = h.app.helpers.toast("controlled error", "error");
    const zero = h.app.helpers.toast("controlled zero", "info", { ttlMs: 0 });
    const success = h.app.helpers.toast("controlled success");
    h.timers.forEach(timer => timer.fn());
    expect(error.parentNode).not.toBeNull(); expect(zero.parentNode).not.toBeNull(); expect(success.parentNode).toBeNull();
    expect(error.getAttribute("role")).toBe("alert");
    error.querySelector(".toast-close")!.dispatchEvent({ type: "click" });
    expect(error.parentNode).toBeNull();
  });
  it("honors explicit nonzero error TTL and unknown-level fallback", () => {
    const h = harness(); const error = h.app.helpers.toast("controlled", "error", { ttlMs: 50 }); const other = h.app.helpers.toast("controlled", "other");
    expect(h.timers.map(t => t.ms)).toEqual([50, 3000]); h.timers.forEach(t => t.fn()); expect(error.parentNode).toBeNull(); expect(other.parentNode).toBeNull();
  });
  it("preserves sticky errors when trimming ordinary messages; actions dismiss", () => {
    const h = harness(); const sticky = h.app.helpers.toast("controlled", "error"); const old = h.app.helpers.toast("old"); const go = vi.fn();
    h.app.helpers.toast("next"); const action = h.app.helpers.toast("action", "info", { action: { label: "Go", onClick: go } });
    expect(sticky.parentNode).not.toBeNull(); expect(old.parentNode).toBeNull(); action.querySelector(".toast-action")!.dispatchEvent({ type: "click" }); expect(go).toHaveBeenCalledOnce(); expect(action.parentNode).toBeNull();
  });
  it("keeps light/dark labels and announced state through locale apply and startup", async () => {
    const h = harness({ init: true }); h.storage.set("agent-browser-studio-theme", "light"); h.document.dispatchEvent({ type: "DOMContentLoaded" }); await flush();
    expect(h.el("theme-label").textContent).toBe("Light"); h.window.i18n.set("zh-CN");
    expect(h.el("theme-label").textContent).toBe("浅色"); expect(h.el("theme-toggle").getAttribute("aria-checked")).toBe("false");
    h.app.toggleTheme(); h.window.i18n.apply(); expect(h.el("theme-label").textContent).toBe("深色"); expect(h.el("theme-toggle").getAttribute("aria-checked")).toBe("true");
    h.window.i18n.set("en-US"); expect(h.el("theme-label").textContent).toBe("Dark");
  });
  it("refreshes a non-Agent tab once per locale toggle; invalid locale does nothing", () => {
    const h = harness(); h.app.toggleLanguage(); expect(h.app.loadProfiles).toHaveBeenCalledOnce();
    h.window.i18n.set("invalid-controlled"); expect(h.app.loadProfiles).toHaveBeenCalledOnce();
  });
  it.each(["config", "skills", "accounts", "adapters", "chat"])("retains Agent %s view and unsaved input on locale change", async (view) => {
    const h = harness(); h.app.state.currentTab = "agent"; h.app.switchAgentSub(view); await flush();
    const visible = h.el("agent-view-" + view); h.el("agent-llm-model").value = "unsaved-controlled-model";
    h.api.agent.llmConfig.mockClear(); h.api.settings.agentFsGet.mockClear();
    for (const name of ["agentLoadSkills", "agentLoadAccounts", "agentLoadAdapters", "agentLoadConversations", "agentRefreshEnvironments"]) h.app[name].mockClear();
    h.app.toggleLanguage(); await flush();
    expect(visible.style.display).not.toBe("none"); expect(h.el("agent-llm-model").value).toBe("unsaved-controlled-model");
    const loaders: Record<string, string> = { skills: "agentLoadSkills", accounts: "agentLoadAccounts", adapters: "agentLoadAdapters" };
    if (loaders[view]) expect(h.app[loaders[view]]).toHaveBeenCalledOnce();
    expect(h.app.agentLoadConversations).not.toHaveBeenCalled(); expect(h.api.agent.llmConfig).not.toHaveBeenCalled(); expect(h.api.settings.agentFsGet).not.toHaveBeenCalled();
  });
  it("renders localized missing/unknown binary states, icons and escaped installed version", async () => {
    const h = harness(); h.window.i18n.set("zh-CN"); h.app.helpers.updateBrowserStatus(); await flush();
    expect(h.el("sidebar-chrome-status").innerHTML).toContain("未安装托管 Chromium"); expect(h.el("sidebar-chrome-status").innerHTML).toContain("<svg");
    h.api.browser.binary.mockRejectedValueOnce(new Error("controlled binary failure")); h.app.helpers.updateBrowserStatus(); await flush(); expect(h.el("sidebar-chrome-status").innerHTML).toContain("Chromium 状态未知");
    h.api.browser.binary.mockResolvedValueOnce({ installed: true, version: "<controlled>" }); h.app.helpers.updateBrowserStatus(); await flush(); expect(h.el("sidebar-chrome-status").innerHTML).toContain("&lt;controlled&gt;");
    expect(h.el("sidebar-chrome-status").className).toBe("sidebar-version chrome-status-ok");
  });
  it("refreshes sidebar locale without losing icon hosts", async () => {
    const h = harness(); h.app.helpers.updateBrowserStatus(); await flush();
    const host = h.el("nav-profiles"); const svg = new Element("svg"); host.appendChild(svg);
    h.app.toggleLanguage(); await flush(); expect(h.el("sidebar-chrome-status").innerHTML).toContain("未安装托管 Chromium"); expect(svg.parentNode).toBe(host);
  });
  it.each(["resolve", "reject"])("ignores older binary requests that %s after the current result", async (settle) => {
    const first = deferred<any>(); const second = deferred<any>(); const h = harness({ binary: () => first.promise });
    h.app.helpers.updateBrowserStatus(); h.api.browser.binary.mockImplementationOnce(() => second.promise); h.app.helpers.updateBrowserStatus();
    expect(h.api.browser.binary).toHaveBeenCalledTimes(2);
    second.resolve({ installed: true, version: "new-controlled" }); await flush();
    if (settle === "reject") first.reject(new Error("stale-controlled")); else first.resolve({ installed: false });
    await flush(); expect(h.el("sidebar-chrome-status").innerHTML).toContain("new-controlled"); expect(h.el("sidebar-chrome-status").className).toBe("sidebar-version chrome-status-ok");
  });
  it("uses current locale when a binary request responds after a locale change", async () => {
    const response = deferred<any>(); const h = harness({ binary: () => response.promise }); h.app.helpers.updateBrowserStatus(); h.window.i18n.set("zh-CN");
    response.resolve({ installed: false }); await flush(); expect(h.el("sidebar-chrome-status").innerHTML).toContain("未安装托管 Chromium");
  });
  it("binds sidebar app version to runtime IPC only, including late response", async () => {
    const response = deferred<string>(); const h = harness({ init: true, version: () => response.promise });
    h.document.dispatchEvent({ type: "DOMContentLoaded" }); expect(h.api.app.version).toHaveBeenCalledOnce(); expect(h.el("sidebar-app-version").textContent).not.toContain("1.0.");
    response.resolve("9.8.7-controlled"); await flush(); expect(h.el("sidebar-app-version").textContent).toBe("v9.8.7-controlled");
  });
  it("does not invent a version on IPC rejection or empty response", async () => {
    for (const version of [async () => { throw new Error("controlled version failure"); }, async () => ""]) {
      const h = harness({ init: true, version }); h.document.dispatchEvent({ type: "DOMContentLoaded" }); await flush(); expect(h.el("sidebar-app-version").textContent).toBe("—");
    }
  });
  it("both dictionary mirrors resolve active global keys identically after all merges", () => {
    const h = harness(); const other = vm.createContext({ window: {}, document: h.document, localStorage: { getItem: () => null }, navigator: { language: "en-US" }, CustomEvent: class {}, console });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8"), other);
    for (const locale of ["zh-CN", "en-US"]) {
      h.window.i18n.set(locale); (other as any).window.i18n.set(locale);
      for (const key of ["theme.light", "theme.dark", "browser.status.missing-sidebar", "browser.status.unknown-sidebar"]) {
        expect(h.window.i18n.t(key)).not.toBe(key); expect((other as any).window.i18n.t(key)).toBe(h.window.i18n.t(key));
      }
    }
    expect(fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8")).toBe(source("i18n.js"));
  });
});

describe("integration defects — real locale/chat/config callbacks", () => {
  const conv = (id = "custom-controlled", title = "My custom fixture title") => ({ id, title, messages: [], messageCount: 0 });
  function chat(h: ReturnType<typeof harness>) { h.app.state.currentTab = "agent"; h.app.switchAgentSub("chat"); }
  function edit(h: ReturnType<typeof harness>, id: string, value: string, type = "input") {
    h.el(id).value = value; h.el(id).dispatchEvent({ type });
  }
  it("does not create on locale repaint while the first real list request is unresolved", async () => {
    const h = harness({ integratedChat: true }); const list = deferred<any[]>();
    h.api.agent.conversations.list.mockImplementation(() => list.promise);
    h.api.agent.conversations.get.mockResolvedValue(conv());
    chat(h); await flush(); h.window.i18n.set("zh-CN"); await flush();
    expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
    expect(h.api.agent.conversations.list).toHaveBeenCalledOnce();
    list.resolve([conv()]); await flush();
    expect(h.app.state.agentActiveConvId).toBe("custom-controlled");
    expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
  });
  it("restores a selected custom header after static i18n apply without resetting draft/scroll", async () => {
    const h = harness({ integratedChat: true }); h.api.agent.conversations.list.mockResolvedValue([conv()]);
    h.api.agent.conversations.get.mockResolvedValue(conv()); chat(h); await flush();
    await h.app.agentSelectConv("custom-controlled");
    h.el("agent-chat-input").value = "  newly typed\n  ";
    (h.el("agent-chat-messages") as any).scrollTop = 13;
    h.api.agent.conversations.create.mockClear(); h.api.agent.conversations.list.mockClear(); h.api.agent.conversations.get.mockClear();
    for (const locale of ["zh-CN", "en-US"]) {
      h.window.i18n.set(locale); await flush();
      expect(h.el("agent-chat-title").textContent).toBe("My custom fixture title");
      expect(h.app.state.agentActiveConvId).toBe("custom-controlled");
      expect(h.app.agentChatSessions["custom-controlled"].title).toBe("My custom fixture title");
      expect(h.el("agent-chat-input").value).toBe("  newly typed\n  ");
      expect((h.el("agent-chat-messages") as any).scrollTop).toBe(13);
    }
    expect(h.api.agent.conversations.create).not.toHaveBeenCalled(); expect(h.api.agent.conversations.list).not.toHaveBeenCalled();
    expect(h.api.agent.conversations.get).not.toHaveBeenCalled();
  });
  it("locale integration preserves actual synthetic store IDs/count/title and fresh reload/search", async () => {
    disk.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-integration-locale-store-"));
    try {
      const custom = store.createConversation("Custom persistent fixture"); store.createConversation("Other persistent fixture");
      const before = fs.readFileSync(store.conversationsPath(), "utf8"); const list = deferred<any[]>();
      const h = harness({ integratedChat: true });
      h.api.agent.conversations.list.mockImplementation(async () => store.listConversations()).mockReturnValueOnce(list.promise);
      h.api.agent.conversations.get.mockImplementation(async (id: string) => store.getConversation(id));
      h.api.agent.conversations.create.mockImplementation(async () => store.createConversation());
      chat(h); await flush(); h.window.i18n.set("zh-CN"); await flush();
      expect(fs.readFileSync(store.conversationsPath(), "utf8")).toBe(before); expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
      list.resolve(store.listConversations()); await flush(); await h.app.agentSelectConv(custom.id);
      h.el("agent-chat-input").value = "custom unsaved draft";
      for (const locale of ["en-US", "zh-CN"]) {
        h.window.i18n.set(locale); await flush();
        expect(h.el("agent-chat-title").textContent).toBe(custom.title); expect(h.app.state.agentActiveConvId).toBe(custom.id);
        expect(h.el("agent-chat-input").value).toBe("custom unsaved draft");
        expect(fs.readFileSync(store.conversationsPath(), "utf8")).toBe(before);
        expect(store.loadConversations()).toEqual(JSON.parse(before)); expect(store.getConversation(custom.id)?.title).toBe(custom.title);
      }
      const fresh = harness({ integratedChat: true });
      fresh.api.agent.conversations.list.mockImplementation(async () => store.listConversations());
      fresh.api.agent.conversations.get.mockImplementation(async (id: string) => store.getConversation(id));
      await fresh.app.agentLoadConversations(); await flush(); fresh.el("agent-conv-search").value = "Custom persistent"; fresh.app.agentFilterConvs();
      expect(fresh.el("agent-conv-list").innerHTML).toContain(custom.id); expect(store.listConversations()).toHaveLength(2);
      expect(fresh.api.agent.conversations.create).not.toHaveBeenCalled();
    } finally { fs.rmSync(disk.dir, { recursive: true, force: true }); }
  });
  it.each(["resolve", "reject"])("ignores an older list %s after the newest real list success", async settle => {
    const h = harness({ integratedChat: true }); const old = deferred<any[]>(); const latest = deferred<any[]>();
    h.api.agent.conversations.list.mockResolvedValue([conv()]).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    h.api.agent.conversations.get.mockResolvedValue(conv());
    const first = h.app.agentLoadConversations(); const second = h.app.agentLoadConversations();
    latest.resolve([conv()]); await second; await flush();
    if (settle === "resolve") old.resolve([]); else old.reject(new Error("old list refusal"));
    await first; await flush();
    expect(h.app.state.agentConvList.map((c: any) => c.id)).toEqual(["custom-controlled"]);
    expect(h.el("agent-conv-list").innerHTML).toContain("My custom fixture title");
    expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
  });
  it("failure is not empty, and locale/filter repaints cannot create after failure", async () => {
    const h = harness({ integratedChat: true }); h.api.agent.conversations.list.mockRejectedValue(new Error("controlled list denial"));
    chat(h); await flush(); h.window.i18n.set("zh-CN"); h.app.agentFilterConvs(); await flush();
    expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
    expect(h.el("agent-conv-list").innerHTML).toContain('data-cmd="agentLoadConversations"');
  });
  it("navigation during an empty list read does not select/create a chat from the late callback", async () => {
    const h = harness({ integratedChat: true }); const list = deferred<any[]>();
    h.api.agent.conversations.list.mockImplementation(() => list.promise); chat(h); await flush();
    h.app.switchAgentSub("config"); list.resolve([]); await flush();
    expect(h.el("agent-view-config").style.display).toBe("block");
    expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
  });
  it("leaving the Agent tab during a pending empty read cannot auto-create a chat", async () => {
    const h = harness({ integratedChat: true }); const list = deferred<any[]>();
    h.api.agent.conversations.list.mockReturnValueOnce(list.promise); chat(h); await flush();
    h.app.state.currentTab = "profiles"; list.resolve([]); await flush();
    expect(h.api.agent.conversations.create).not.toHaveBeenCalled(); expect(h.app.state.agentActiveConvId).toBeNull();
  });
  it("preserves fields edited during a pending config read while hydrating untouched server fields", async () => {
    const h = harness({ integratedChat: true }); const read = deferred<any>();
    h.api.agent.llmConfig.mockReturnValueOnce(read.promise); h.app.state.currentTab = "agent"; h.app.switchAgentSub("config");
    edit(h, "agent-llm-model", "  typed-before-read\n"); edit(h, "agent-llm-apikey", "synthetic-unsaved-key");
    h.window.i18n.set("zh-CN");
    read.resolve({ provider: "claude", model: "late-server-model", apiUrl: "https://fixture.invalid/messages", hasApiKey: true }); await flush();
    expect(h.el("agent-llm-model").value).toBe("  typed-before-read\n"); expect(h.el("agent-llm-apikey").value).toBe("synthetic-unsaved-key");
    expect(h.el("agent-llm-provider").value).toBe("claude"); expect(h.el("agent-llm-url").value).toBe("https://fixture.invalid/messages");
    expect((h.el("agent-llm-apikey") as any).placeholder).toMatch(/^saved/);
    h.api.agent.llmConfig.mockResolvedValue({ provider: "claude", model: "second-server-model", apiUrl: "https://fixture.invalid/new", hasApiKey: true });
    h.app.agentLoadConfig(); await flush();
    expect(h.el("agent-llm-model").value).toBe("  typed-before-read\n"); expect(h.el("agent-llm-apikey").value).toBe("synthetic-unsaved-key");
    expect(h.el("agent-llm-url").value).toBe("https://fixture.invalid/new");
    h.app.agentSaveConfig(); await flush();
    expect(h.api.agent.saveLlmConfig).toHaveBeenCalledWith({ provider: "claude", apiKey: "synthetic-unsaved-key", model: "typed-before-read", apiUrl: "https://fixture.invalid/new" });
  });
  it("retains intentional clears and provider edits but applies untouched model on a later read", async () => {
    const h = harness(); h.api.agent.llmConfig.mockResolvedValueOnce({ provider: "openai", model: "initial", apiUrl: "https://fixture.invalid/initial", hasApiKey: true });
    h.app.agentLoadConfig(); await flush(); edit(h, "agent-llm-provider", "claude", "change"); edit(h, "agent-llm-url", "");
    h.api.agent.llmConfig.mockResolvedValueOnce({ provider: "openai", model: "new-server-model", apiUrl: "https://fixture.invalid/late", hasApiKey: true });
    h.app.agentLoadConfig(); await flush();
    expect(h.el("agent-llm-provider").value).toBe("claude"); expect(h.el("agent-llm-url").value).toBe("");
    expect(h.el("agent-llm-model").value).toBe("new-server-model");
    h.app.agentSaveConfig(); await flush(); expect(h.api.agent.saveLlmConfig).toHaveBeenCalledWith({ provider: "claude", apiKey: "", model: "new-server-model", apiUrl: undefined });
  });
  it.each(["resolve", "reject"])("does not apply/fallback from an older config %s after a newer request", async settle => {
    const h = harness(); const old = deferred<any>(); const latest = deferred<any>();
    h.api.agent.llmConfig.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    h.app.agentLoadConfig(); h.app.agentLoadConfig(); latest.resolve({ provider: "claude", model: "latest", hasApiKey: true }); await flush();
    if (settle === "resolve") old.resolve({ provider: "openai", model: "old" }); else old.reject(new Error("old config denial"));
    await flush(); expect(h.el("agent-llm-model").value).toBe("latest"); expect(h.el("agent-llm-provider").value).toBe("claude");
    expect(h.api.agent.detectLlmConfig).not.toHaveBeenCalled();
  });
  it.each(["empty", "reject"])("preserves drafts through %s config → auto-detect fallback and navigation", async outcome => {
    const h = harness(); const read = deferred<any>(); const detect = deferred<any>();
    h.api.agent.llmConfig.mockReturnValueOnce(read.promise); h.api.agent.detectLlmConfig.mockReturnValueOnce(detect.promise);
    h.app.state.currentTab = "agent"; h.app.switchAgentSub("config");
    edit(h, "agent-llm-model", "local model"); h.app.switchAgentSub("skills");
    if (outcome === "empty") read.resolve(null); else read.reject(new Error("current read denial")); await flush();
    expect(h.api.agent.detectLlmConfig).toHaveBeenCalledOnce();
    edit(h, "agent-llm-url", "https://fixture.invalid/local");
    detect.resolve({ provider: "claude", model: "detected model", apiUrl: "https://fixture.invalid/detected", hasApiKey: true }); await flush();
    expect(h.el("agent-view-skills").style.display).toBe("block"); expect(h.el("agent-llm-model").value).toBe("local model");
    expect(h.el("agent-llm-url").value).toBe("https://fixture.invalid/local"); expect(h.el("agent-llm-provider").value).toBe("claude");
  });
  it.each(["resolve", "reject"])("a stale detect %s after a newer config read neither overwrites fields nor toasts", async outcome => {
    const h = harness(); const detect = deferred<any>(); h.api.agent.detectLlmConfig.mockReturnValueOnce(detect.promise);
    h.app.agentDetectConfig(); h.api.agent.llmConfig.mockResolvedValueOnce({ provider: "claude", model: "latest server", hasApiKey: true }); h.app.agentLoadConfig(); await flush();
    edit(h, "agent-llm-model", "new local edit"); const beforeToasts = h.document.querySelectorAll(".toast").length;
    if (outcome === "resolve") detect.resolve({ provider: "openai", model: "obsolete detection" }); else detect.reject(new Error("obsolete detect failure"));
    await flush(); expect(h.el("agent-llm-provider").value).toBe("claude"); expect(h.el("agent-llm-model").value).toBe("new local edit");
    expect(h.document.querySelectorAll(".toast").length).toBe(beforeToasts);
  });
  it.each(["refused", "reject"])("a %s save does not acknowledge unsaved edits on the next read", async outcome => {
    const h = harness(); h.api.agent.llmConfig.mockResolvedValue({ provider: "openai", model: "server model", hasApiKey: true }); h.app.agentLoadConfig(); await flush();
    edit(h, "agent-llm-model", "local unsaved model");
    if (outcome === "refused") h.api.agent.saveLlmConfig.mockResolvedValueOnce({ success: false }); else h.api.agent.saveLlmConfig.mockRejectedValueOnce(new Error("save denied"));
    h.app.agentSaveConfig(); await flush(); h.app.agentLoadConfig(); await flush();
    expect(h.el("agent-llm-model").value).toBe("local unsaved model");
    expect(h.api.agent.saveLlmConfig).toHaveBeenCalledWith({ provider: "openai", apiKey: "", model: "local unsaved model", apiUrl: undefined });
  });
  it("save invalidates pending config reads without changing payload, and only acknowledges unchanged saved fields", async () => {
    const h = harness(); const read = deferred<any>(); const save = deferred<any>();
    h.api.agent.llmConfig.mockReturnValueOnce(read.promise); h.api.agent.saveLlmConfig.mockReturnValueOnce(save.promise);
    h.app.agentLoadConfig(); edit(h, "agent-llm-provider", "claude", "change"); edit(h, "agent-llm-model", "saved model"); edit(h, "agent-llm-apikey", "synthetic-key");
    h.app.agentSaveConfig(); edit(h, "agent-llm-model", "new unsaved model"); save.resolve({ success: true }); await flush();
    read.resolve({ provider: "openai", model: "obsolete before-save" }); await flush();
    expect(h.el("agent-llm-model").value).toBe("new unsaved model");
    expect(h.api.agent.saveLlmConfig).toHaveBeenCalledWith({ provider: "claude", apiKey: "synthetic-key", model: "saved model", apiUrl: undefined });
    h.api.agent.llmConfig.mockResolvedValue({ provider: "claude", model: "saved model", hasApiKey: true }); h.app.agentLoadConfig(); await flush();
    expect(h.el("agent-llm-model").value).toBe("new unsaved model");
  });
});

describe("exact HTML dialog-name contracts (not native accessibility proof)", () => {
  it.each(["dlg-proxy-import", "dlg-proxy-bind", "dlg-webrtc-diag", "dlg-profile-logs", "dlg-skill-market", "dlg-skill-editor", "dlg-automation", "dlg-wizard"])("%s references one real nonempty heading/heading label without removing handler IDs", (id) => {
    const dom = parseHtml(); const dialog = dom.querySelector("#" + id)!; const targetId = dialog.getAttribute("aria-labelledby")!;
    const targets = dom.querySelectorAll("[id]").filter(el => el.id === targetId); expect(targets).toHaveLength(1);
    const target = targets[0]; expect(target.textContent.trim()).not.toBe(""); expect(dialog.querySelector("#" + targetId)).toBe(target);
    expect(target.tagName === "h3" || target.parentNode?.tagName === "h3").toBe(true);
    if (id === "dlg-skill-editor") expect(dialog.querySelector("#skill-editor-title")).not.toBeNull();
    if (id === "dlg-automation") expect(dialog.querySelector("#auto-dlg-title")).not.toBeNull();
  });
});
