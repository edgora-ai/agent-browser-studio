// Whole production chat/content/i18n modules in HTML-derived controlled DOM.
// Synthetic JSON storage only; not IPC/REST/MCP, native, IME or provider proof.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
const disk = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../src/main/services/config-manager.js", () => ({ getAppDataDir: () => disk.dir }));
import * as store from "../../src/main/services/agent/conversation-store.js";
const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
type Handler = (event: any) => void;
class Element {
  nodeType = 1;
  children: Element[] = [];
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  handlers: Record<string, Handler[]> = {};
  value = "";
  disabled = false;
  innerHTML = "";
  private text = "";
  scrollHeight = 200;
  clientHeight = 60;
  scrollTop = 13;
  classList = { contains: () => false, add() {}, remove() {} };
  constructor(public tagName = "div") {}
  get id() { return this.attributes.id || ""; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(""); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(key: string, fn: Handler) { (this.handlers[key] ||= []).push(fn); }
  dispatchEvent(event: any) { this.handlers[event.type]?.forEach(fn => fn(event)); }
  appendChild(child: Element) { this.children.push(child); return child; }
  get childNodes() { return this.children; }
  focus() {}
  querySelectorAll(selector: string): Element[] {
    const matches = (e: Element) => selector.startsWith("#") ? e.id === selector.slice(1)
      : selector.startsWith("[") ? e.getAttribute(selector.slice(1, -1)) !== null : e.tagName === selector;
    return this.children.flatMap(c => [...(matches(c) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
}
function parsedDocument() {
  const root = new Element("root"), stack = [root];
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
    if (!token.startsWith("<")) {
      const el = new Element("text"); el.nodeType = 3; el.textContent = token; stack[stack.length - 1].appendChild(el); continue;
    }
    const tag = /^<([\w-]+)/.exec(token)![1], el = new Element(tag);
    for (const attr of token.matchAll(/\s([\w-]+)(?:="([^"]*)"|'([^']*)')?/g)) el.setAttribute(attr[1], attr[2] ?? attr[3] ?? "");
    stack[stack.length - 1].appendChild(el);
    if (!/^(meta|link|input|img|br|hr)$/.test(tag) && !token.endsWith("/>")) stack.push(el);
  }
  return Object.assign(root, {
    hidden: false, documentElement: root.querySelector("html")!,
    getElementById: (id: string) => root.querySelector("#" + id),
    createTextNode: (text: string) => { const el = new Element("text"); el.nodeType = 3; el.textContent = text; return el; },
  });
}
function harness(locale = "en-US", raw = false) {
  const document = parsedDocument(), events: Record<string, Handler> = {};
  const read = (id: string) => raw ? store.loadConversations().find(c => c.id === id) || null : store.getConversation(id);
  const api = {
    on: (key: string, fn: Handler) => { events[key] = fn; },
    browser: { list: vi.fn(async () => []), status: vi.fn(async () => ({ running: false })) },
    agent: { conversations: {
      list: vi.fn(async () => raw ? store.loadConversations() : store.listConversations()),
      get: vi.fn(async (id: string) => read(id)),
      create: vi.fn(async (title?: string) => store.createConversation(title)),
      rename: vi.fn(async (id: string, title: string) => store.renameConversation(id, title)),
      delete: vi.fn(async (id: string) => store.deleteConversation(id)),
    }, activeRun: vi.fn(async (_id: string): Promise<any> => null),
      chatStream: vi.fn(async () => { throw new Error("Unexpected fixture submission"); }),
      cancelRun: vi.fn(async () => ({ accepted: false })),
    },
  };
  const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const app: any = { api, R: api, state: { currentTab: "agent", agentMessages: [], agentConvList: [], agentActiveConvId: null },
    helpers: { esc, escAttr: esc, icon: () => "", renderChatMarkdown: esc, toast: vi.fn() },
    confirm: vi.fn(), ipc: { call: (_key: string, fn: () => unknown) => Promise.resolve().then(fn) },
  };
  const storage = new Map<string, string>([["agent-browser-studio-language", locale]]);
  const window: any = { document, agentBrowser: app, crypto: { randomUUID: () => "unused-title-stream" } };
  const context = vm.createContext({ window, document, navigator: { language: locale }, console,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    CustomEvent: class { constructor(public type: string, public detail?: any) {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
  });
  // Order is asserted against the real HTML rather than assumed by this fixture.
  const modules = ["js/i18n.js", "js/app/agent-chat.js", "js/app/agent-chat-content.js"];
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), m => m[1]);
  expect(modules.map(m => scripts.indexOf(m))).toEqual([...modules.map(m => scripts.indexOf(m))].sort((a, b) => a - b));
  for (const name of modules) vm.runInContext(fs.readFileSync(path.join(ROOT, "src/renderer", name), "utf8"), context, { filename: name });
  const el = (id: string) => document.getElementById(id)!;
  const search = (query: string) => { el("agent-conv-search").value = query; app.agentFilterConvs(); return el("agent-conv-list").innerHTML; };
  return { app, api, el, window, events, search };
}
const cases: Array<{ id: string; title: string; marker?: unknown; zh: string }> = [
  { id: "default", title: "New Chat", marker: "default", zh: "新对话" },
  { id: "literal", title: "New Chat", marker: "literal", zh: "New Chat" },
  { id: "legacy", title: "New Chat", zh: "New Chat" },
  { id: "null", title: "New Chat", marker: null, zh: "New Chat" },
  { id: "future", title: "New Chat", marker: "future-kind", zh: "New Chat" },
  { id: "object", title: "New Chat", marker: { privateFixture: "opaque" }, zh: "New Chat" },
  { id: "invalid", title: "New Chat", marker: true, zh: "New Chat" },
  { id: "inconsistent", title: "Historical title", marker: "default", zh: "Historical title" },
  { id: "empty-literal", title: "", marker: "literal", zh: "" },
  { id: "empty-legacy", title: "", zh: "" },
  { id: "blank", title: " \n ", marker: "literal", zh: " \n " },
  { id: "ordinary", title: "User <title>", marker: "literal", zh: "User <title>" },
  { id: "authored-zh", title: "新对话", marker: "literal", zh: "新对话" },
  { id: "duplicate-a", title: "Duplicate valid title", marker: "literal", zh: "Duplicate valid title" },
  { id: "duplicate-b", title: "Duplicate valid title", marker: "literal", zh: "Duplicate valid title" },
];
function records() {
  return cases.map(c => ({ id: c.id, title: c.title, ...(Object.hasOwn(c, "marker") ? { titleKind: c.marker } : {}),
    messages: [{ role: "user", content: `Synthetic history ${c.id}`, timestamp: 1 }], createdAt: 1, updatedAt: 1 })) as store.Conversation[];
}
const bytes = () => fs.readFileSync(store.conversationsPath(), "utf8");
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
beforeEach(() => { disk.dir = fs.mkdtempSync(path.join(os.tmpdir(), "title-renderer-store-")); store.saveConversations(records()); });
afterEach(() => { fs.rmSync(disk.dir, { recursive: true, force: true }); });
function clearConversationCalls(h: ReturnType<typeof harness>) {
  for (const fn of Object.values(h.api.agent.conversations)) fn.mockClear();
  h.api.agent.activeRun.mockClear(); h.api.agent.chatStream.mockClear();
}
function assertNoConversationCalls(h: ReturnType<typeof harness>) {
  for (const fn of Object.values(h.api.agent.conversations)) expect(fn).not.toHaveBeenCalled();
  expect(h.api.agent.activeRun).not.toHaveBeenCalled(); expect(h.api.agent.chatStream).not.toHaveBeenCalled();
}
for (const locale of ["en-US", "zh-CN"]) describe(`F18 raw title renderer — ${locale}`, () => {
  it.each(cases)("preserves exact $id title/marker in cache and all three display surfaces", async c => {
    const h = harness(locale, true), before = bytes(); await h.app.agentSelectConv(c.id); await flush();
    const expected = locale === "zh-CN" ? c.zh : c.title;
    expect(h.el("agent-chat-title").textContent).toBe(expected);
    expect(h.app.agentChatSessions[c.id].title).toBe(c.title);
    expect(h.app.agentChatSessions[c.id].titleKind).toEqual(c.marker);
    const shown = h.search(expected.trim()); expect(shown).toContain(`data-cmd-arg="${c.id}"`);
    expect(shown).toContain(h.app.helpers.esc(expected)); expect(bytes()).toBe(before);
    expect(store.loadConversations()).toEqual(JSON.parse(before)); expect(store.getConversation(c.id)?.title).toBe(c.title);
    expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
  });
});
describe("F18 locale, selection identity and committed rename", () => {
  it.each(["default", "literal", "ordinary", "empty-literal", "legacy", "inconsistent"])("EN→ZH→EN repaints %s and active filter without any API operation", async id => {
    const h = harness(), before = bytes();
    for (const c of cases) await h.app.agentSelectConv(c.id); // also establish inactive caches
    await h.app.agentSelectConv(id); await flush();
    h.el("agent-chat-input").value = "  exact unsent draft\n "; h.el("agent-chat-messages").scrollTop = 7;
    h.search("New Chat"); const cache = JSON.stringify(h.app.agentChatSessions), list = JSON.stringify(h.app.state.agentConvList);
    const messages = h.el("agent-chat-messages").innerHTML; clearConversationCalls(h);
    for (const locale of ["zh-CN", "en-US"]) {
      h.window.i18n.set(locale); await flush();
      const c = cases.find(c => c.id === id)!;
      expect(h.el("agent-chat-title").textContent).toBe(locale === "zh-CN" ? c.zh : c.title);
      const sidebar = h.el("agent-conv-list").innerHTML;
      expect(sidebar).toContain('data-cmd-arg="literal"'); expect(sidebar).toContain('data-cmd-arg="legacy"');
      expect(sidebar.includes('data-cmd-arg="default"')).toBe(locale === "en-US");
      expect(h.el("agent-chat-input").value).toBe("  exact unsent draft\n "); expect(h.el("agent-chat-messages").scrollTop).toBe(7);
      expect(h.el("agent-chat-messages").innerHTML).toBe(messages); expect(JSON.stringify(h.app.agentChatSessions)).toBe(cache);
      expect(JSON.stringify(h.app.state.agentConvList)).toBe(list); expect(bytes()).toBe(before); assertNoConversationCalls(h);
      expect(h.el("agent-conv-search").value).toBe("New Chat");
      for (const inactive of cases) expect(h.app.chatTitleDisplay(h.app.agentChatSessions[inactive.id])).toBe(locale === "zh-CN" ? inactive.zh : inactive.title);
    }
  });
  it("translated search finds only consistent default or authored Chinese, while English literal/legacy remain searchable", async () => {
    const h = harness("zh-CN"); await h.app.agentSelectConv("literal");
    const en = h.search("New Chat"), zh = h.search("新对话");
    for (const id of ["literal", "legacy", "null", "future", "object", "invalid"]) {
      expect(en).toContain(`data-cmd-arg="${id}"`); expect(zh).not.toContain(`data-cmd-arg="${id}"`);
    }
    expect(en).not.toContain('data-cmd-arg="default"'); expect(zh).toContain('data-cmd-arg="default"'); expect(zh).toContain('data-cmd-arg="authored-zh"');
    h.search("Duplicate valid title"); expect(h.el("agent-conv-list").innerHTML).toContain('data-cmd-arg="duplicate-a"'); expect(h.el("agent-conv-list").innerHTML).toContain('data-cmd-arg="duplicate-b"');
    await h.app.agentSelectConv("duplicate-b"); expect(h.app.state.agentActiveConvId).toBe("duplicate-b"); expect(h.app.state.agentMessages[0].content).toBe("Synthetic history duplicate-b");
  });
  it("a newly created omitted-title conversation caches raw default and repaints without re-creation", async () => {
    const h = harness("zh-CN"); await h.app.agentNewConv(); await flush(); const id = h.app.state.agentActiveConvId;
    const committed = JSON.parse(bytes()).find((c: store.Conversation) => c.id === id);
    expect(committed.titleKind).toBe("default"); expect(committed.title).toBe("New Chat"); expect(h.app.agentChatSessions[id].title).toBe("New Chat");
    expect(h.el("agent-chat-title").textContent).toBe("新对话"); clearConversationCalls(h); const before = bytes();
    h.window.i18n.set("en-US"); expect(h.el("agent-chat-title").textContent).toBe("New Chat"); expect(bytes()).toBe(before); assertNoConversationCalls(h);
  });
  it("no selection/unloaded chrome is distinct from existing empty titles, without reads on repaint", async () => {
    const h = harness(); clearConversationCalls(h); h.window.i18n.set("zh-CN"); expect(h.el("agent-chat-title").textContent).toBe("新对话"); assertNoConversationCalls(h);
    const read = new Promise<store.Conversation | null>(() => {}); h.api.agent.conversations.get.mockReturnValueOnce(read);
    void h.app.agentSelectConv("empty-literal"); await flush(); clearConversationCalls(h);
    h.window.i18n.set("en-US"); expect(h.el("agent-chat-title").textContent).toBe("New Chat"); assertNoConversationCalls(h);
    // Deliberate selection, not locale refresh, resolves the actual record.
    await h.app.agentSelectConv("empty-literal"); h.window.i18n.set("zh-CN"); expect(h.el("agent-chat-title").textContent).toBe("");
  });
  it("clearing selection after a failed cached history read restores chrome, not the old empty title", async () => {
    const h = harness("zh-CN"); await h.app.agentSelectConv("empty-literal"); expect(h.el("agent-chat-title").textContent).toBe("");
    h.api.agent.conversations.get.mockRejectedValueOnce(new Error("Synthetic history denial")); await h.app.agentSelectConv("empty-literal");
    expect(h.app.state.agentActiveConvId).toBeNull(); expect(h.el("agent-chat-title").textContent).toBe("新对话");
    clearConversationCalls(h); h.window.i18n.set("en-US"); expect(h.el("agent-chat-title").textContent).toBe("New Chat"); assertNoConversationCalls(h);
  });
  it("explicit production creation of the identical title remains literal beside an omitted default", async () => {
    const automatic = store.createConversation(), authored = store.createConversation("New Chat");
    const saved = JSON.parse(bytes()) as store.Conversation[], before = bytes();
    expect(saved.find(c => c.id === automatic.id)).toMatchObject({ title: "New Chat", titleKind: "default" });
    expect(saved.find(c => c.id === authored.id)).toMatchObject({ title: "New Chat", titleKind: "literal" });
    const h = harness("zh-CN"); await h.app.agentSelectConv(authored.id); expect(h.el("agent-chat-title").textContent).toBe("New Chat");
    expect(h.search("New Chat")).toContain(authored.id); expect(h.search("New Chat")).not.toContain(automatic.id);
    await h.app.agentSelectConv(automatic.id); expect(h.el("agent-chat-title").textContent).toBe("新对话"); expect(h.search("新对话")).toContain(automatic.id);
    expect(bytes()).toBe(before); expect(store.loadConversations()).toEqual(saved); expect(store.getConversation(authored.id)?.titleKind).toBe("literal");
  });
  it("an active translated filter updates on locale change without touching inactive raw caches", async () => {
    const h = harness("zh-CN"); await h.app.agentSelectConv("default"); await h.app.agentSelectConv("ordinary");
    h.search("新对话"); const before = bytes(), cache = JSON.stringify(h.app.agentChatSessions); clearConversationCalls(h);
    h.window.i18n.set("en-US"); expect(h.el("agent-conv-list").innerHTML).not.toContain('data-cmd-arg="default"');
    expect(h.el("agent-conv-list").innerHTML).toContain('data-cmd-arg="authored-zh"'); expect(h.el("agent-chat-title").textContent).toBe("User <title>");
    h.window.i18n.set("zh-CN"); expect(h.el("agent-conv-list").innerHTML).toContain('data-cmd-arg="default"');
    expect(JSON.stringify(h.app.agentChatSessions)).toBe(cache); expect(h.app.agentChatSessions.default.title).toBe("New Chat"); expect(bytes()).toBe(before); assertNoConversationCalls(h);
  });
  it.each([true, false])("same-text committed rename updates only its list/cache identity (active=%s)", async active => {
    const h = harness("zh-CN"); await h.app.agentSelectConv("default");
    if (!active) await h.app.agentSelectConv("ordinary");
    const other = JSON.stringify(h.app.agentChatSessions.ordinary || null), before = JSON.parse(bytes());
    const otherList = JSON.stringify(h.app.state.agentConvList.filter((c: any) => c.id !== "default"));
    clearConversationCalls(h); const committed = await h.app.agentRenameConv("default", "New Chat");
    expect(committed).toMatchObject({ id: "default", title: "New Chat", titleKind: "literal" });
    const saved = JSON.parse(bytes()); expect(saved.find((c: store.Conversation) => c.id === "default").titleKind).toBe("literal");
    expect(saved.filter((c: store.Conversation) => c.id !== "default")).toEqual(before.filter((c: store.Conversation) => c.id !== "default"));
    expect(h.app.agentChatSessions.default.titleKind).toBe("literal"); expect(h.app.state.agentConvList.find((c: any) => c.id === "default").titleKind).toBe("literal");
    expect(JSON.stringify(h.app.agentChatSessions.ordinary || null)).toBe(other);
    expect(JSON.stringify(h.app.state.agentConvList.filter((c: any) => c.id !== "default"))).toBe(otherList);
    expect(h.el("agent-chat-title").textContent).toBe(active ? "New Chat" : "User <title>"); expect(h.search("New Chat")).toContain('data-cmd-arg="default"');
    expect(h.api.agent.conversations.rename).toHaveBeenCalledOnce(); expect(h.api.agent.conversations.get).not.toHaveBeenCalled(); expect(h.api.agent.conversations.list).not.toHaveBeenCalled();
    expect(store.loadConversations()).toEqual(saved); expect(store.getConversation("default")?.titleKind).toBe("literal");
  });
  it.each(["cached selection", "unloaded selection", "terminal refresh"])("an older %s read cannot undo a committed same-text rename, while history still loads", async source => {
    const h = harness("zh-CN"), old = store.getConversation("default")!;
    if (source !== "unloaded selection") await h.app.agentSelectConv("default");
    let resolve!: (value: store.Conversation) => void;
    const pending = new Promise<store.Conversation>(yes => { resolve = yes; }); h.api.agent.conversations.get.mockReturnValueOnce(pending);
    let selecting: Promise<unknown> | undefined;
    if (source === "terminal refresh") h.events["agent:stream-done"]({ conversationId: "default", streamId: "title-terminal", runId: "title-run", status: "done", endReason: "completed", reply: "Title terminal reply", persisted: true });
    else selecting = h.app.agentSelectConv("default");
    await flush(); h.el("agent-chat-input").value = "exact pending rename draft\n ";
    await h.app.agentRenameConv("default", "New Chat"); expect(h.el("agent-chat-title").textContent).toBe("New Chat");
    resolve(old); if (selecting) await selecting; await flush();
    expect(h.el("agent-chat-title").textContent).toBe("New Chat"); expect(h.app.agentChatSessions.default.titleKind).toBe("literal");
    expect(h.app.state.agentMessages.some((m: any) => m.content === "Synthetic history default")).toBe(true);
    expect(h.el("agent-chat-input").value).toBe("exact pending rename draft\n ");
  });
  it("a list captured before the committed rename cannot restore an obsolete default marker", async () => {
    const h = harness("zh-CN"); await h.app.agentSelectConv("default"); const old = store.listConversations();
    let resolve!: (value: store.Conversation[]) => void;
    const pending = new Promise<store.Conversation[]>(yes => { resolve = yes; }); h.api.agent.conversations.list.mockReturnValueOnce(pending);
    const reading = h.app.agentLoadConversations(); await h.app.agentRenameConv("default", "New Chat"); resolve(old); await reading;
    expect(h.app.state.agentConvList.find((c: any) => c.id === "default").titleKind).toBe("literal");
    expect(h.search("New Chat")).toContain('data-cmd-arg="default"'); expect(h.search("新对话")).not.toContain('data-cmd-arg="default"');
    expect(h.el("agent-chat-title").textContent).toBe("New Chat");
  });
  it("a genuinely fresh history/list read after rename can adopt a later authoritative title", async () => {
    const h = harness("zh-CN"); await h.app.agentSelectConv("default"); await h.app.agentRenameConv("default", "New Chat");
    store.renameConversation("default", "Later committed title"); const before = bytes();
    await h.app.agentSelectConv("default"); await h.app.agentLoadConversations();
    expect(h.el("agent-chat-title").textContent).toBe("Later committed title");
    expect(h.app.agentChatSessions.default.title).toBe("Later committed title"); expect(h.app.state.agentConvList.find((c: any) => c.id === "default").title).toBe("Later committed title");
    expect(h.search("Later committed title")).toContain('data-cmd-arg="default"'); expect(bytes()).toBe(before);
  });
  it("a missing/refused/mismatched rename response cannot manufacture literal metadata", async () => {
    const h = harness("zh-CN"); await h.app.agentSelectConv("default"); const before = JSON.stringify(h.app.agentChatSessions);
    h.api.agent.conversations.rename.mockResolvedValueOnce(null); await h.app.agentRenameConv("default", "New Chat"); expect(JSON.stringify(h.app.agentChatSessions)).toBe(before);
    h.api.agent.conversations.rename.mockResolvedValueOnce({ ...store.getConversation("literal")! }); await h.app.agentRenameConv("default", "New Chat"); expect(JSON.stringify(h.app.agentChatSessions)).toBe(before);
    h.api.agent.conversations.rename.mockRejectedValueOnce(new Error("Synthetic rename denial")); await expect(h.app.agentRenameConv("default", "New Chat")).rejects.toThrow("Synthetic rename denial");
    expect(JSON.stringify(h.app.agentChatSessions)).toBe(before); expect(h.el("agent-chat-title").textContent).toBe("新对话");
  });
  it.each([undefined, null, "default"] as const)("rename display/cache consumes actual returned marker %s rather than guessing from requested text", async marker => {
    const h = harness("zh-CN"); await h.app.agentSelectConv("default");
    const response = { ...store.getConversation("default")! };
    if (marker === undefined) delete response.titleKind; else response.titleKind = marker;
    h.api.agent.conversations.rename.mockResolvedValueOnce(response);
    await h.app.agentRenameConv("default", "Requested different text");
    expect(h.app.agentChatSessions.default.title).toBe("New Chat"); expect(h.app.agentChatSessions.default.titleKind).toBe(marker);
    const listed = h.app.state.agentConvList.find((c: any) => c.id === "default");
    expect(listed.title).toBe("New Chat"); expect(listed.titleKind).toBe(marker); expect(Object.hasOwn(listed, "titleKind")).toBe(marker !== undefined);
    expect(h.el("agent-chat-title").textContent).toBe(marker === "default" ? "新对话" : "New Chat");
  });
  it("fresh-process JSON reload → get/list → actual renderer search preserves all IDs/raw bytes", async () => {
    const retained = process.env.TITLE_RENDERER_RELOAD_DIR;
    if (retained) fs.copyFileSync(path.join(retained, "agent-conversations.json"), store.conversationsPath());
    const before = bytes(), saved = JSON.parse(before) as store.Conversation[];
    expect(store.loadConversations()).toEqual(saved); expect(store.listConversations().map(c => c.id).sort()).toEqual(saved.map(c => c.id).sort());
    for (const record of saved) expect(store.getConversation(record.id)).toMatchObject({ id: record.id, title: record.title, messages: record.messages });
    for (const locale of ["en-US", "zh-CN"]) {
      const h = harness(locale); await h.app.agentSelectConv("literal"); expect(h.el("agent-chat-title").textContent).toBe("New Chat");
      expect(h.search("New Chat")).toContain('data-cmd-arg="literal"'); expect(h.search("新对话").includes('data-cmd-arg="default"')).toBe(locale === "zh-CN");
      await h.app.agentSelectConv("empty-legacy"); expect(h.el("agent-chat-title").textContent).toBe(""); expect(h.search("")).toContain('data-cmd-arg="empty-legacy"');
      expect(store.getConversation("literal")?.messages).toEqual(saved.find(c => c.id === "literal")?.messages);
      expect(bytes()).toBe(before); expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
    }
    const evidence = process.env.TITLE_RENDERER_EVIDENCE;
    if (evidence) {
      const out = path.join(evidence, retained ? "fresh-reload" : "retained-production-store"); fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(store.conversationsPath(), path.join(out, "agent-conversations.json"));
      fs.writeFileSync(path.join(out, "proof.json"), JSON.stringify({ ids: saved.map(c => c.id), bytesUnchanged: bytes() === before, locales: ["en-US", "zh-CN"], searchedIds: ["literal", "default", "empty-legacy"], freshProcess: !!retained }, null, 2));
    }
  });
});
