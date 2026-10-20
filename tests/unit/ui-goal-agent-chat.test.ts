// Controlled whole-module renderer fixtures, NOT native IME or real-provider proof.
// Durable conversation operations use production store bytes in an owned temp dir.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { filterChatTools, assertChatToolAllowed } from "../../src/main/services/agent/run-scope.js";
import { runningProcesses } from "../../src/main/services/browser/runtime-table.js";
const disk = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../src/main/services/config-manager.js", () => ({ getAppDataDir: () => disk.dir }));
import * as store from "../../src/main/services/agent/conversation-store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
class Element {
  value = "";
  disabled = false;
  innerHTML = "";
  textContent = "";
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = "";
  scrollHeight = 50;
  scrollTop = 50;
  clientHeight = 50;
  tagName = "TEXTAREA";
  listeners = new Map<string, Array<(event: any) => void>>();
  classList = { contains: () => false, add: vi.fn(), remove: vi.fn() };
  focus = vi.fn();
  constructor(public id: string) {}
  addEventListener(type: string, fn: (event: any) => void) {
    const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list);
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  closest(selector: string) { return selector === '[data-role="keydown"]' && this.id === "agent-chat-input" ? this : null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  dispatch(type: string, event: any) { for (const fn of this.listeners.get(type) || []) fn(event); }
}
function harness(options: { translations?: Record<string, string>; delegation?: boolean } = {}) {
  const elements: Record<string, Element> = Object.fromEntries([
    "agent-view-chat", "agent-conv-list", "agent-conv-search", "agent-chat-title", "agent-chat-messages",
    "agent-chat-status", "agent-chat-input", "agent-chat-send", "agent-chat-stop", "agent-chat-stop-label",
    "agent-run-strip", "agent-run-state", "agent-run-action", "agent-run-elapsed", "agent-run-verification",
    "agent-env-select", "agent-env-status", "agent-env-start", "agent-scroll-bottom", "agent-scroll-badge",
  ].map(id => [id, new Element(id)]));
  const events = new Map<string, (payload: any) => void>();
  const confirmations: Array<() => unknown> = [];
  const api = {
    browser: {
      list: vi.fn(async () => [{ dirId: "profile-a", name: "Environment A", running: true }, { dirId: "profile-b", name: "Environment B", running: true }]),
      status: vi.fn(async (_id: string) => ({ running: true })),
    },
    agent: {
      conversations: {
        list: vi.fn(async () => store.listConversations()),
        get: vi.fn(async (id: string) => store.getConversation(id)),
        create: vi.fn(async (title?: string) => store.createConversation(title)),
        delete: vi.fn(async (id: string) => store.deleteConversation(id)),
      },
      activeRun: vi.fn(async (_id: string): Promise<any> => null),
      chatStream: vi.fn((_id: string, _message: string, _stream: string, _options: unknown) => new Promise<any>(() => {})),
      cancelRun: vi.fn(async () => ({ accepted: true, state: "cancelling" })),
    },
    on: (name: string, fn: (payload: any) => void) => events.set(name, fn),
  };
  const state: any = { agentMessages: [], agentConvList: [], agentActiveConvId: null };
  const esc = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const toast = vi.fn();
  const agentBrowser: any = {
    api, R: api, state,
    helpers: { toast, esc, escAttr: esc, icon: () => "", renderChatMarkdown: esc },
    confirm: (_message: string, fn: () => unknown) => confirmations.push(fn),
    ipc: { call: (_key: string, fn: () => unknown) => Promise.resolve().then(fn) },
  };
  const docListeners = new Map<string, Array<(event: any) => void>>();
  const document: any = {
    readyState: "complete", hidden: false, activeElement: null,
    documentElement: { lang: "en" },
    getElementById: (id: string) => elements[id] || null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (name: string, fn: (event: any) => void) => {
      const list = docListeners.get(name) || []; list.push(fn); docListeners.set(name, list);
    },
  };
  class Dialog { showModal() {} }
  let uuid = 0;
  const window = {
    agentBrowser, document,
    i18n: { t: (key: string, fallback: string) => options.translations?.[key] ?? fallback },
    crypto: { randomUUID: () => `fixture-stream-${++uuid}` },
    requestAnimationFrame: (fn: () => void) => fn(), addEventListener: () => {},
  };
  const context = vm.createContext({ window, document, navigator: {}, HTMLDialogElement: Dialog, HTMLElement: Element,
    console: { warn: vi.fn(), error: vi.fn() }, setInterval: () => 1, setTimeout: () => 1, clearTimeout: () => {} });
  for (const name of ["agent-chat.js", "agent-chat-content.js", ...(options.delegation ? ["delegation.js"] : [])]) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../src/renderer/js/app", name), "utf8"), context, { filename: name });
  }
  const input = elements["agent-chat-input"];
  const env = elements["agent-env-select"];
  return { agentBrowser, api, state, elements, input, env, toast, confirmations,
    emit: (name: string, payload: unknown) => events.get(name)?.(payload),
    key: (event: Record<string, unknown>) => {
      const e = { target: input, key: "Enter", shiftKey: false, preventDefault: vi.fn(), ...event };
      for (const fn of docListeners.get("keydown") || []) fn(e);
      return e;
    },
  };
}
let a: store.Conversation;
let b: store.Conversation;
beforeEach(() => {
  disk.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-goal-chat-store-"));
  a = store.createConversation("Project A"); b = store.createConversation("Project B");
  store.addMessage(a.id, { role: "user", content: "synthetic A history" });
  store.addMessage(b.id, { role: "user", content: "synthetic B history" });
});
afterEach(() => { fs.rmSync(disk.dir, { recursive: true, force: true }); runningProcesses.clear(); });
function bytes() { return fs.readFileSync(store.conversationsPath(), "utf8"); }
async function select(h: ReturnType<typeof harness>, id: string, profile = "") {
  await h.agentBrowser.agentSelectConv(id); h.env.value = profile; h.agentBrowser.agentEnvironmentChanged();
}

describe("UI goal chat — F12 per-conversation draft and frozen scope", () => {
  it("restores exact drafts and environment selections on A/B/A/B", async () => {
    const h = harness(); const before = bytes();
    await select(h, a.id, "profile-a"); h.input.value = "  A draft\nsecond line  ";
    await select(h, b.id, "profile-b"); h.input.value = "B draft";
    await h.agentBrowser.agentSelectConv(a.id);
    expect(h.input.value).toBe("  A draft\nsecond line  "); expect(h.env.value).toBe("profile-a");
    await h.agentBrowser.agentSelectConv(b.id);
    expect(h.input.value).toBe("B draft"); expect(h.env.value).toBe("profile-b");
    expect(bytes()).toBe(before); expect(h.api.agent.chatStream).not.toHaveBeenCalled();
  });
  it("ignores a late A read after B is selected", async () => {
    const h = harness(); const read = deferred<store.Conversation | null>();
    h.api.agent.conversations.get.mockImplementationOnce(() => read.promise);
    const pending = h.agentBrowser.agentSelectConv(a.id);
    await select(h, b.id, "profile-b"); h.input.value = "keep B";
    read.resolve(store.getConversation(a.id)); await pending;
    expect(h.state.agentActiveConvId).toBe(b.id); expect(h.input.value).toBe("keep B"); expect(h.env.value).toBe("profile-b");
  });
  it("restores A text after failed preparation while B was viewed", async () => {
    const h = harness(); await select(h, a.id, "profile-a"); h.input.value = "  A retry text\n  ";
    const status = deferred<{ running: boolean }>(); h.api.browser.status.mockReturnValueOnce(status.promise);
    const send = h.agentBrowser.agentSend(); await flush();
    await select(h, b.id, "profile-b"); h.input.value = "B unrelated text";
    await h.agentBrowser.agentSelectConv(a.id);
    status.reject(new Error("synthetic status denial")); await send;
    expect(h.input.value).toBe("  A retry text\n  "); expect(h.input.disabled).toBe(false);
    expect(h.env.value).toBe("profile-a"); expect(h.api.agent.chatStream).not.toHaveBeenCalled();
    await h.agentBrowser.agentSelectConv(b.id); expect(h.input.value).toBe("B unrelated text");
  });
  it("keeps whitespace/newlines in a failed unsent draft instead of trimming them", async () => {
    const h = harness(); await select(h, a.id, "profile-a"); h.input.value = "  retry\ntext  ";
    h.api.browser.status.mockResolvedValueOnce({ running: false }); await h.agentBrowser.agentSend();
    await h.agentBrowser.agentSelectConv(b.id); await h.agentBrowser.agentSelectConv(a.id);
    expect(h.input.value).toBe("  retry\ntext  "); expect(h.api.agent.chatStream).not.toHaveBeenCalled();
  });
  it("stop before validation completes preserves A and prevents late submission", async () => {
    const h = harness(); await select(h, a.id, "profile-a"); h.input.value = "A cancelled draft";
    const status = deferred<{ running: boolean }>(); h.api.browser.status.mockReturnValueOnce(status.promise);
    const send = h.agentBrowser.agentSend(); await flush();
    await select(h, b.id); h.input.value = "B draft";
    await h.agentBrowser.agentSelectConv(a.id); await h.agentBrowser.agentStopRun();
    status.resolve({ running: true }); await send;
    expect(h.input.value).toBe("A cancelled draft"); expect(h.api.agent.chatStream).not.toHaveBeenCalled();
    expect(h.api.agent.cancelRun).not.toHaveBeenCalled();
  });
  it("clears A's submitted input when returning from B, without changing frozen scope", async () => {
    const h = harness(); await select(h, a.id, "profile-a"); h.input.value = "send A";
    void h.agentBrowser.agentSend(); await flush();
    expect(h.api.agent.chatStream.mock.calls[0]?.[3]).toMatchObject({ profileDirId: "profile-a" });
    await select(h, b.id, "profile-b"); h.input.value = "private B draft";
    await h.agentBrowser.agentSelectConv(a.id);
    expect(h.input.value).toBe(""); expect(h.input.disabled).toBe(true); expect(h.env.value).toBe("profile-a");
    expect(h.env.disabled).toBe(true);
    h.env.value = "profile-b"; h.agentBrowser.agentEnvironmentChanged();
    expect(h.agentBrowser.agentChatSessions[a.id].selectedProfileDirId).toBe("profile-a");
    await h.agentBrowser.agentSelectConv(b.id); expect(h.input.value).toBe("private B draft");
  });
  it("keeps B untouched by a late A preparation failure", async () => {
    const h = harness(); await select(h, a.id, "profile-a"); h.input.value = "A retry";
    const status = deferred<{ running: boolean }>(); h.api.browser.status.mockReturnValueOnce(status.promise);
    const send = h.agentBrowser.agentSend(); await flush();
    await select(h, b.id, "profile-b"); h.input.value = "B live draft"; const before = bytes();
    status.reject(new Error("A failure")); await send;
    expect(h.input.value).toBe("B live draft"); expect(h.env.value).toBe("profile-b"); expect(h.toast).not.toHaveBeenCalled();
    await h.agentBrowser.agentSelectConv(a.id); expect(h.input.value).toBe("A retry"); expect(bytes()).toBe(before);
  });
  it("stopped/missing environments block submission; empty input is a no-op", async () => {
    const h = harness(); await select(h, a.id, "missing"); h.input.value = "retry";
    await h.agentBrowser.agentSend(); expect(h.input.value).toBe("retry");
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("unavailable"), "error");
    h.input.value = " \n "; await h.agentBrowser.agentSend(); expect(h.api.agent.chatStream).not.toHaveBeenCalled();
  });
});

describe("UI goal chat — deferred selection and conversation creation", () => {
  it("does not adopt A's composer/history as B's draft while B's first read is pending", async () => {
    const h = harness(); await select(h, a.id); h.input.value = "A owned draft";
    const read = deferred<store.Conversation | null>();
    h.api.agent.conversations.get.mockImplementationOnce(() => read.promise);
    const selectingB = h.agentBrowser.agentSelectConv(b.id);
    expect(h.input.value).toBe(""); expect(h.state.agentMessages).toEqual([]);
    await h.agentBrowser.agentSelectConv(a.id); expect(h.input.value).toBe("A owned draft");
    read.resolve(store.getConversation(b.id)); await selectingB;
    await h.agentBrowser.agentSelectConv(b.id); expect(h.input.value).toBe("");
    expect(h.state.agentMessages[0].content).toBe("synthetic B history");
  });
  it("a failed initial create keeps unsent input enabled and reports the error", async () => {
    const h = harness(); h.input.value = "  initial unsent draft  ";
    h.api.agent.conversations.create.mockRejectedValueOnce(new Error("Synthetic create refusal"));
    const before = bytes(); await h.agentBrowser.agentSend();
    expect(h.input.value).toBe("  initial unsent draft  "); expect(h.input.disabled).toBe(false);
    expect(h.toast).toHaveBeenCalledWith("Synthetic create refusal", "error"); expect(bytes()).toBe(before);
    expect(h.api.agent.chatStream).not.toHaveBeenCalled();
  });
  it("late new-conversation creation does not submit or overwrite a newer selected chat", async () => {
    const h = harness(); h.input.value = "pending new message";
    const created = deferred<store.Conversation>(); h.api.agent.conversations.create.mockReturnValueOnce(created.promise);
    const sending = h.agentBrowser.agentSend();
    await select(h, b.id); h.input.value = "B current draft";
    const newConv = store.createConversation("pending new message"); created.resolve(newConv); await sending;
    expect(h.state.agentActiveConvId).toBe(b.id); expect(h.input.value).toBe("B current draft");
    expect(h.api.agent.chatStream).not.toHaveBeenCalled();
    const saved = JSON.parse(bytes()) as store.Conversation[];
    expect(saved.map(c => c.id)).toContain(newConv.id); expect(store.getConversation(newConv.id)?.messages).toEqual([]);
    expect(store.loadConversations()).toEqual(saved);
  });
});

describe("UI goal chat — delete feedback and real synthetic history bytes", () => {
  it.each(["agentDeleteConv", "agentDeleteConvItem"])("%s retains the view/history and surfaces a rejection", async (handler) => {
    const h = harness(); await select(h, a.id, "profile-a"); h.input.value = "draft survives";
    const before = bytes(); const html = h.elements["agent-chat-messages"].innerHTML;
    // Observe the downstream rejection to avoid an intentional RED becoming an
    // unhandled rejection outside this test; renderer still must handle/toast it.
    h.api.agent.conversations.delete.mockImplementationOnce(() => {
      const p = Promise.reject(new Error("Stop this conversation's active task before deleting it."));
      const then = p.then.bind(p);
      p.then = ((...args: Parameters<typeof p.then>) => {
        const next = then(...args); void next.then(undefined, () => undefined); return next;
      }) as typeof p.then;
      return p;
    });
    h.agentBrowser[handler](a.id); h.confirmations[0](); await flush();
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("active task"), "error");
    expect(h.state.agentActiveConvId).toBe(a.id); expect(h.elements["agent-chat-messages"].innerHTML).toBe(html);
    expect(h.input.value).toBe("draft survives"); expect(bytes()).toBe(before);
    expect(store.loadConversations().map(c => c.id)).toContain(a.id);
    const fresh = harness(); await select(fresh, a.id); expect(fresh.state.agentMessages[0].content).toBe("synthetic A history");
    fresh.elements["agent-conv-search"].value = "Project A"; fresh.agentBrowser.agentFilterConvs();
    expect(fresh.elements["agent-conv-list"].innerHTML).toContain(a.id);
  });
  it.each(["agentDeleteConv", "agentDeleteConvItem"])("%s persists confirmed deletion and keeps the other chat searchable", async handler => {
    const h = harness(); await select(h, a.id); h.agentBrowser[handler](a.id);
    expect(store.getConversation(a.id)).not.toBeNull(); // before confirmation: no writes
    h.confirmations[0](); await flush();
    const saved = JSON.parse(bytes()) as store.Conversation[];
    expect(saved.map(c => c.id)).not.toContain(a.id); expect(saved.map(c => c.id)).toContain(b.id);
    expect(store.getConversation(a.id)).toBeNull(); expect(store.loadConversations()).toEqual(saved);
    const fresh = harness(); await fresh.agentBrowser.agentLoadConversations(); await flush();
    fresh.elements["agent-conv-search"].value = "Project B"; fresh.agentBrowser.agentFilterConvs();
    expect(fresh.elements["agent-conv-list"].innerHTML).toContain(b.id); expect(fresh.elements["agent-conv-list"].innerHTML).not.toContain(a.id);
  });
  it("local active task blocks delete before confirmation/RPC", async () => {
    const h = harness(); await select(h, a.id); h.input.value = "running"; void h.agentBrowser.agentSend(); await flush();
    h.agentBrowser.agentDeleteConv(); h.agentBrowser.agentDeleteConvItem(a.id);
    expect(h.confirmations).toHaveLength(0); expect(h.api.agent.conversations.delete).not.toHaveBeenCalled();
  });
  it("late confirmed A deletion does not clear B's view or draft", async () => {
    const h = harness(); await select(h, a.id); h.agentBrowser.agentDeleteConv();
    await select(h, b.id, "profile-b"); h.input.value = "B retained";
    h.confirmations[0](); await flush(); expect(h.state.agentActiveConvId).toBe(b.id); expect(h.input.value).toBe("B retained");
    expect(store.getConversation(a.id)).toBeNull(); expect(store.getConversation(b.id)).not.toBeNull();
  });
});

describe("UI goal chat — controlled IME event contract", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }, { isComposing: true, keyCode: 229 }, { shiftKey: true }])("does not send or prevent default on %j", async event => {
    const h = harness({ delegation: true }); await select(h, a.id); h.input.value = "中文输入";
    const e = h.key(event); await flush(); expect(h.api.agent.chatStream).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled(); expect(h.input.value).toBe("中文输入");
  });
  it("ordinary Enter submits exactly once and non-Enter does not submit", async () => {
    const h = harness({ delegation: true }); await select(h, a.id); h.input.value = "committed text";
    h.key({ key: "Escape" }); await flush(); expect(h.api.agent.chatStream).not.toHaveBeenCalled();
    const e = h.key({ isComposing: false, keyCode: 13 }); await flush();
    expect(h.api.agent.chatStream).toHaveBeenCalledTimes(1); expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe("UI goal chat — F11 supported recommendation contract", () => {
  it("policy blocks launch/automation mutation/proxy probes but permits selected navigation and automation reads", () => {
    const names = ["launch_profile", "check_proxies", "create_automation_rule", "delete_automation_rule", "browser_navigate", "list_profiles", "list_automation_rules", "get_automation_logs"];
    const tools = names.map(name => ({ function: { name } }));
    expect(filterChatTools(tools, null).map(t => t.function.name)).toEqual(["list_profiles", "list_automation_rules", "get_automation_logs"]);
    for (const name of ["launch_profile", "check_proxies", "create_automation_rule", "delete_automation_rule", "browser_navigate"]) expect(() => assertChatToolAllowed(name, null)).toThrow();
  });
  it("welcome offers supported tasks even when old translations still advertise unsupported actions", async () => {
    const h = harness({ translations: { "agent.suggest.1": "Launch a profile and open a site", "agent.suggest.2": "Check which proxies are alive", "agent.welcome.sub": "Run an automation" } });
    await select(h, a.id); h.state.agentMessages = []; h.agentBrowser.agentRenderMessages();
    const html = h.elements["agent-chat-messages"].innerHTML;
    expect(html).not.toContain("Launch a profile"); expect(html).not.toContain("which proxies are alive"); expect(html).not.toContain("Run an automation");
    // Allowed catalog tool names do not imply visibility: the executor returns
    // an empty list with null scope and only the selected profile otherwise.
    expect(html).not.toContain("List browser environments available for selection");
    expect(html).toContain("list recent automation"); expect(html).toContain("running environment");
  });
});

describe("integration defects — real chat state and history callbacks", () => {
  it.each(["selected-to-cleared", "cleared-to-selected"])("refreshes genuinely empty recommendations on %s without writes", async direction => {
    const empty = store.createConversation("Empty custom fixture"); const h = harness(); const before = bytes();
    await select(h, empty.id, direction === "selected-to-cleared" ? "profile-a" : "");
    await h.agentBrowser.agentSelectConv(empty.id);
    // No artificial state.agentMessages replacement: this is the real empty store record.
    expect(h.state.agentMessages).toEqual([]);
    const messages = h.elements["agent-chat-messages"];
    expect(messages.innerHTML).toContain(direction === "selected-to-cleared" ? "Open a website" : "Explain which actions");
    h.input.value = "keep exact draft\n "; messages.scrollTop = 7;
    h.env.value = direction === "selected-to-cleared" ? "" : "profile-a"; h.agentBrowser.agentEnvironmentChanged();
    expect(messages.innerHTML).toContain(direction === "selected-to-cleared" ? "Explain which actions" : "Open a website");
    expect(messages.innerHTML).not.toContain(direction === "selected-to-cleared" ? "Open a website" : "Explain which actions");
    expect(messages.innerHTML).toContain("list recent automation"); expect(messages.innerHTML).not.toContain("List browser environments");
    expect(h.input.value).toBe("keep exact draft\n "); expect(messages.scrollTop).toBe(7);
    expect(h.elements["agent-chat-title"].textContent).toBe("Empty custom fixture");
    expect(h.state.agentActiveConvId).toBe(empty.id); expect(bytes()).toBe(before);
    expect(store.loadConversations()).toEqual(JSON.parse(before)); expect(store.getConversation(empty.id)?.messages).toEqual([]);
    h.elements["agent-conv-search"].value = "Empty custom"; h.agentBrowser.agentFilterConvs();
    expect(h.elements["agent-conv-list"].innerHTML).toContain(empty.id); expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
  });
  it.each(["history-first", "recovery-first"])("keeps a newly typed B draft through deferred %s completions", async order => {
    const h = harness(); await select(h, a.id); h.input.value = "A private";
    const history = deferred<store.Conversation | null>(); const recovery = deferred<any>(); const before = bytes();
    h.api.agent.conversations.get.mockReturnValueOnce(history.promise); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise);
    const pending = h.agentBrowser.agentSelectConv(b.id);
    h.input.value = "  B typed during load\n  "; h.input.dispatch("input", { target: h.input });
    const settleHistory = () => history.resolve(store.getConversation(b.id)); const settleRecovery = () => recovery.resolve(null);
    if (order === "history-first") settleHistory(); else settleRecovery(); await flush();
    expect(h.input.value).toBe("  B typed during load\n  ");
    if (order === "history-first") settleRecovery(); else settleHistory(); await pending;
    expect(h.input.value).toBe("  B typed during load\n  "); expect(h.elements["agent-chat-title"].textContent).toBe("Project B");
    await h.agentBrowser.agentSelectConv(a.id); expect(h.input.value).toBe("A private");
    await h.agentBrowser.agentSelectConv(b.id); expect(h.input.value).toBe("  B typed during load\n  "); expect(bytes()).toBe(before);
  });
  it("keeps programmatic draft changes through active recovery even without an input event", async () => {
    const h = harness(); const read = deferred<store.Conversation | null>(); const recover = deferred<any>();
    h.api.agent.conversations.get.mockReturnValueOnce(read.promise); h.api.agent.activeRun.mockReturnValueOnce(recover.promise);
    const pending = h.agentBrowser.agentSelectConv(b.id); h.input.value = "draft without event";
    recover.resolve(null); await flush(); expect(h.input.value).toBe("draft without event");
    read.resolve(store.getConversation(b.id)); await pending; expect(h.input.value).toBe("draft without event");
  });
  it("history failure retains the B-owned draft for retry and does not overwrite A", async () => {
    const h = harness(); await select(h, a.id); h.input.value = "A own text";
    const read = deferred<store.Conversation | null>(); h.api.agent.conversations.get.mockReturnValueOnce(read.promise);
    const pending = h.agentBrowser.agentSelectConv(b.id); await flush();
    h.input.value = "B unsaved after load started"; h.input.dispatch("input", { target: h.input });
    read.reject(new Error("B history denied")); await pending;
    await h.agentBrowser.agentSelectConv(a.id); expect(h.input.value).toBe("A own text");
    await h.agentBrowser.agentSelectConv(b.id); expect(h.input.value).toBe("B unsaved after load started");
  });
  it.each(["resolve", "reject"])("older same-session history %s cannot supersede a later request", async outcome => {
    const h = harness(); const read = deferred<store.Conversation | null>();
    h.api.agent.conversations.get.mockReturnValueOnce(read.promise);
    const old = h.agentBrowser.agentSelectConv(b.id); await flush();
    h.api.agent.conversations.get.mockResolvedValueOnce({ ...store.getConversation(b.id)!, title: "Newest custom title" });
    await h.agentBrowser.agentSelectConv(b.id); h.input.value = "newest B text"; h.input.dispatch("input", { target: h.input });
    if (outcome === "resolve") read.resolve({ ...store.getConversation(b.id)!, title: "Obsolete title" }); else read.reject(new Error("obsolete history denial"));
    await old;
    expect(h.agentBrowser.agentChatSessions[b.id].title).toBe("Newest custom title");
    expect(h.elements["agent-chat-title"].textContent).toBe("Newest custom title"); expect(h.input.value).toBe("newest B text");
  });
  it("a closed/deleted session cannot be restored by its deferred recovery callback", async () => {
    const h = harness(); const recover = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(recover.promise);
    const pending = h.agentBrowser.agentSelectConv(a.id); await flush();
    h.agentBrowser.agentDeleteConv(); h.confirmations[0](); await flush();
    await h.agentBrowser.agentSelectConv(b.id); h.input.value = "B survives close";
    recover.resolve(null); await pending;
    expect(h.state.agentActiveConvId).toBe(b.id); expect(h.input.value).toBe("B survives close");
    expect(h.agentBrowser.agentChatSessions[a.id]).toBeUndefined(); expect(store.getConversation(a.id)).toBeNull();
  });
  it("deferred recovery cannot register a deleted session's stale run", async () => {
    const h = harness(); const recover = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(recover.promise);
    const pending = h.agentBrowser.agentSelectConv(a.id); await flush();
    h.agentBrowser.agentDeleteConv(); h.confirmations[0](); await flush();
    recover.resolve({ conversationId: a.id, streamId: "closed-stream", runId: "closed-run", state: "running", reply: "stale reply", startedAt: 1 }); await pending;
    expect(h.agentBrowser.agentChatSessions[a.id]).toBeUndefined();
    expect(h.agentBrowser.agentChatController.findByRunId("closed-run")).toBeNull();
    expect(h.state.agentActiveConvId).toBe(b.id); expect(store.getConversation(a.id)).toBeNull();
  });
  it("a recovery failure and navigation keep the pending session's edited draft", async () => {
    const h = harness(); const history = deferred<store.Conversation | null>(); const recovery = deferred<any>();
    h.api.agent.conversations.get.mockReturnValueOnce(history.promise); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise);
    const pending = h.agentBrowser.agentSelectConv(b.id); h.input.value = "B exact text\n "; h.input.dispatch("input", { target: h.input });
    recovery.reject(new Error("recovery refused")); await flush();
    expect(h.input.value).toBe("B exact text\n ");
    await h.agentBrowser.agentSelectConv(a.id); h.input.value = "A while B loads";
    history.resolve(store.getConversation(b.id)); await pending;
    expect(h.state.agentActiveConvId).toBe(a.id); expect(h.input.value).toBe("A while B loads");
    await h.agentBrowser.agentSelectConv(b.id); expect(h.input.value).toBe("B exact text\n ");
  });
  it("a confirmed loaded empty store creates exactly one chat, with real bytes/reload/lookup/search", async () => {
    store.saveConversations([]); const h = harness();
    h.agentBrowser.agentRenderConvs(); await flush(); expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
    await h.agentBrowser.agentLoadConversations(); await flush();
    expect(h.api.agent.conversations.create).toHaveBeenCalledOnce();
    const saved = JSON.parse(bytes()) as store.Conversation[]; expect(saved).toHaveLength(1);
    expect(store.loadConversations()).toEqual(saved); expect(store.getConversation(saved[0].id)).toEqual(saved[0]);
    h.agentBrowser.agentRenderConvs(); h.agentBrowser.agentRenderConvs(); await flush();
    expect(h.api.agent.conversations.create).toHaveBeenCalledOnce();
    const fresh = harness(); await fresh.agentBrowser.agentLoadConversations(); await flush();
    fresh.elements["agent-conv-search"].value = "New Chat"; fresh.agentBrowser.agentFilterConvs();
    expect(fresh.elements["agent-conv-list"].innerHTML).toContain(saved[0].id); expect(fresh.api.agent.conversations.create).not.toHaveBeenCalled();
    expect(bytes()).toBe(JSON.stringify(saved, null, 2));
  });
});

describe("UI goal chat — F18 provenance boundary", () => {
  it("store cannot distinguish default title from explicitly supplied identical title; do not guess in renderer", () => {
    const system = store.createConversation(); const user = store.createConversation("New Chat");
    expect(system.title).toBe(user.title); expect(Object.keys(system).sort()).toEqual(Object.keys(user).sort());
    expect(store.getConversation(user.id)?.title).toBe("New Chat");
    expect(JSON.parse(bytes()).filter((c: store.Conversation) => c.title === "New Chat").map((c: store.Conversation) => c.id)).toEqual(expect.arrayContaining([system.id, user.id]));
  });
});

// Task196: full production modules and real callbacks; Node fixtures are not
// native IME, accessibility, Electron or provider acceptance.
function fourGapHarness(locale: "en-US" | "zh-CN") {
  const window: any = {};
  const context = vm.createContext({ window, navigator: { language: locale },
    localStorage: { getItem: () => locale }, document: { addEventListener: () => {} } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../src/renderer/js/i18n.js"), "utf8"), context);
  const translations = new Proxy<Record<string, string>>({}, { get: (_target, key) => {
    const translated = window.i18n.t(String(key), "__missing_fixture_key__");
    return translated === "__missing_fixture_key__" ? undefined : translated;
  } });
  return harness({ translations });
}
function existingSnapshot(id: string, extra: Record<string, unknown> = {}) {
  return { conversationId: id, streamId: "recovery-stream", runId: "recovery-run", state: "running",
    reply: "old reply", startedAt: 1, toolCalls: [], steps: [], currentTool: "", ...extra };
}
function realTerminal(h: ReturnType<typeof harness>, id: string, error = false, persisted = false) {
  h.emit(error ? "agent:stream-error" : "agent:stream-done", {
    conversationId: id, streamId: "recovery-stream", runId: "recovery-run",
    status: error ? "error" : "done", endReason: error ? "execution_error" : "completed",
    error: error ? "controlled terminal failure" : "", reply: "terminal reply", persisted,
  });
}
function assertReadOnly(h: ReturnType<typeof harness>, before: string) {
  expect(bytes()).toBe(before);
  expect(h.api.agent.chatStream).not.toHaveBeenCalled();
  expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
}
for (const locale of ["en-US", "zh-CN"] as const) describe(`Task196 four chat gaps — ${locale}`, () => {
  it.each(["existing/event", "existing/programmatic", "empty/event", "empty/programmatic"])("first list preserves unassigned composition: %s", async variant => {
    if (variant.startsWith("empty")) store.saveConversations([]);
    const h = fourGapHarness(locale), list = deferred<store.Conversation[]>();
    h.api.agent.conversations.list.mockReturnValueOnce(list.promise);
    const pending = h.agentBrowser.agentLoadConversations();
    expect(h.input.disabled).toBe(false);
    const draft = "  before initial list 中文\n  "; h.input.value = draft;
    if (variant.endsWith("event")) h.input.dispatch("input", { target: h.input });
    const before = bytes(); h.agentBrowser.agentRenderConvs(); h.agentBrowser.agentFilterConvs();
    expect(bytes()).toBe(before); expect(h.api.agent.conversations.create).not.toHaveBeenCalled();
    list.resolve(store.listConversations()); await pending; await flush();
    expect(h.input.value).toBe(draft); expect(h.input.disabled).toBe(false);
    const id = h.state.agentActiveConvId;
    expect(h.agentBrowser.agentChatSessions[id].draft).toBe(draft);
    expect(h.api.agent.chatStream).not.toHaveBeenCalled();
    expect(h.api.agent.conversations.create).toHaveBeenCalledTimes(variant.startsWith("empty") ? 1 : 0);
    const saved = bytes(); await h.agentBrowser.agentSelectConv(id); expect(h.input.value).toBe(draft);
    h.agentBrowser.agentRenderMessages(); h.agentBrowser.agentRenderConvs(); expect(bytes()).toBe(saved);
  });
  it("typing while initial empty-store creation is pending belongs to the created session", async () => {
    store.saveConversations([]); const h = fourGapHarness(locale), created = deferred<store.Conversation>();
    h.api.agent.conversations.create.mockReturnValueOnce(created.promise);
    await h.agentBrowser.agentLoadConversations(); await flush();
    h.input.value = "  during create\n "; h.input.dispatch("input", { target: h.input });
    created.resolve(store.createConversation()); await flush();
    expect(h.input.value).toBe("  during create\n ");
    expect(h.api.agent.chatStream).not.toHaveBeenCalled(); expect(h.api.agent.conversations.create).toHaveBeenCalledOnce();
  });
  it("failed initial list and reversed older reply retain unassigned typing until a deliberate retry", async () => {
    const h = fourGapHarness(locale), old = deferred<store.Conversation[]>(), latest = deferred<store.Conversation[]>();
    h.api.agent.conversations.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const first = h.agentBrowser.agentLoadConversations(), second = h.agentBrowser.agentLoadConversations();
    h.input.value = "unassigned retry text"; const before = bytes(); latest.reject(new Error("controlled list failure")); await second;
    old.resolve([]); await first; h.agentBrowser.agentFilterConvs(); h.agentBrowser.agentRenderConvs();
    expect(h.input.value).toBe("unassigned retry text"); assertReadOnly(h, before);
    await h.agentBrowser.agentLoadConversations(); await flush();
    expect(h.input.value).toBe("unassigned retry text"); assertReadOnly(h, before);
  });
  it.each(["history-first/done", "history-first/error", "recovery-first/done", "recovery-first/error"])("typed draft survives non-null recovery, real terminal and navigation: %s", async variant => {
    const h = fourGapHarness(locale), history = deferred<store.Conversation | null>(), recovery = deferred<any>();
    h.api.agent.conversations.get.mockReturnValueOnce(history.promise); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise);
    const pending = h.agentBrowser.agentSelectConv(a.id); await flush();
    const draft = "  unsent during recovery 中文\n "; h.input.value = draft; // also covers no input event
    const before = bytes();
    if (variant.startsWith("history")) { history.resolve(store.getConversation(a.id)); await flush(); recovery.resolve(existingSnapshot(a.id)); }
    else { recovery.resolve(existingSnapshot(a.id)); await flush(); history.resolve(store.getConversation(a.id)); }
    await pending; expect(h.input.disabled).toBe(true); expect(h.agentBrowser.agentChatSessions[a.id].draft).toBe(draft);
    realTerminal(h, a.id, variant.endsWith("error"), true); await flush();
    expect(h.input.disabled).toBe(false); expect(h.input.value).toBe(draft);
    await select(h, b.id); h.input.value = "B owned text"; await select(h, a.id); expect(h.input.value).toBe(draft);
    await select(h, b.id); expect(h.input.value).toBe("B owned text"); assertReadOnly(h, before);
  });
  it.each([false, true])("background recovered terminal preserves both owners (error=%s)", async error => {
    const h = fourGapHarness(locale), recovery = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise);
    const pending = h.agentBrowser.agentSelectConv(a.id); await flush(); h.input.value = "A recovery draft";
    recovery.resolve(existingSnapshot(a.id)); await pending; await select(h, b.id); h.input.value = "B current draft";
    const before = bytes(); realTerminal(h, a.id, error); await flush();
    expect(h.input.value).toBe("B current draft"); await select(h, a.id); expect(h.input.value).toBe("A recovery draft"); assertReadOnly(h, before);
  });
  it("ordinary local submission still clears the submitted composer at terminal", async () => {
    const h = fourGapHarness(locale); await select(h, a.id); h.input.value = "submitted text";
    void h.agentBrowser.agentSend(); await flush(); const streamId = h.api.agent.chatStream.mock.calls[0][2];
    h.emit("agent:stream-done", { conversationId: a.id, streamId, status: "done", endReason: "completed", reply: "local done", persisted: false });
    await flush(); expect(h.input.value).toBe(""); expect(h.input.disabled).toBe(false);
    await select(h, b.id); await select(h, a.id); expect(h.input.value).toBe(""); expect(h.api.agent.chatStream).toHaveBeenCalledOnce();
  });
  it.each(["chunk", "tool", "step", "start", "cancel"])("actual intervening %s prevents same-stream recovery rewind", async kind => {
    const h = fourGapHarness(locale); h.api.agent.activeRun.mockResolvedValueOnce(existingSnapshot(a.id)); await select(h, a.id);
    const recovery = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise);
    h.agentBrowser.switchAgentSub("chat"); await flush();
    if (kind === "chunk") h.emit("agent:stream-chunk", { conversationId: a.id, streamId: "recovery-stream", text: " + newer tokens" });
    if (kind === "tool") h.emit("agent:stream-tool-call", { conversationId: a.id, streamId: "recovery-stream", name: "fresh_tool" });
    if (kind === "step") h.emit("agent:run-step", { runId: "recovery-run", step: { id: "fresh-step", tool: "fresh_tool", ok: false, error: "fresh denial", durationMs: 9 } });
    if (kind === "start") h.emit("agent:stream-start", { conversationId: a.id, streamId: "recovery-stream", runId: "recovery-run", startedAt: 777 });
    if (kind === "cancel") await h.agentBrowser.agentStopRun();
    const beforeRun = JSON.stringify(h.agentBrowser.agentChatSessions[a.id].run), before = bytes();
    recovery.resolve(existingSnapshot(a.id)); await flush();
    expect(JSON.stringify(h.agentBrowser.agentChatSessions[a.id].run)).toBe(beforeRun); assertReadOnly(h, before);
    const html = h.elements["agent-chat-messages"].innerHTML;
    if (kind === "chunk") expect(html).toContain("newer tokens");
    if (kind === "tool") expect(html).toContain("fresh_tool");
    if (kind === "step") expect(html).toContain("fresh denial");
    if (kind === "cancel") expect(h.agentBrowser.agentChatSessions[a.id].run.state).toBe("cancelling");
  });
  it("start/chunk during the first recovery read cannot be replaced by its obsolete snapshot", async () => {
    const h = fourGapHarness(locale), recovery = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise);
    const pending = h.agentBrowser.agentSelectConv(a.id); await flush(); h.input.value = "unsubmitted at start";
    h.emit("agent:stream-start", existingSnapshot(a.id));
    h.emit("agent:stream-chunk", { conversationId: a.id, streamId: "recovery-stream", text: "actual delta" });
    recovery.resolve(existingSnapshot(a.id)); await pending;
    expect(h.agentBrowser.agentChatSessions[a.id].run.reply).toBe("actual delta");
    realTerminal(h, a.id); await flush(); expect(h.input.value).toBe("unsubmitted at start");
  });
  it("a fresh same-stream snapshot is authoritative without intervening events", async () => {
    const h = fourGapHarness(locale); h.api.agent.activeRun.mockResolvedValueOnce(existingSnapshot(a.id)); await select(h, a.id);
    h.api.agent.activeRun.mockResolvedValueOnce(existingSnapshot(a.id, { reply: "fresh authoritative reply", currentTool: "snapshot_tool" }));
    h.agentBrowser.switchAgentSub("chat"); await flush();
    expect(h.agentBrowser.agentChatSessions[a.id].run.reply).toBe("fresh authoritative reply");
    expect(h.elements["agent-chat-messages"].innerHTML).toContain("snapshot_tool");
  });
  it("an intervening old-stream terminal does not discard a legitimate new-stream snapshot", async () => {
    const h = fourGapHarness(locale); h.api.agent.activeRun.mockResolvedValueOnce(existingSnapshot(a.id)); await select(h, a.id);
    const recovery = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise); h.agentBrowser.switchAgentSub("chat"); await flush();
    realTerminal(h, a.id); recovery.resolve(existingSnapshot(a.id, { streamId: "new-stream", runId: "new-run", reply: "new stream reply", startedAt: Date.now() + 100 })); await flush();
    expect(h.agentBrowser.agentChatSessions[a.id].run.streamId).toBe("new-stream");
    expect(h.agentBrowser.agentChatController.findByRunId("new-run").conversationId).toBe(a.id);
    expect(h.elements["agent-chat-messages"].innerHTML).toContain("new stream reply");
  });
  it.each(["resolve", "reject"])("reversed recovery %s cannot override a newer non-null recovery", async outcome => {
    const h = fourGapHarness(locale), old = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(old.promise);
    const first = h.agentBrowser.agentSelectConv(a.id); await flush();
    h.api.agent.activeRun.mockResolvedValueOnce(existingSnapshot(a.id, { reply: "newest reply" })); await select(h, a.id);
    if (outcome === "resolve") old.resolve(existingSnapshot(a.id, { reply: "obsolete" })); else old.reject(new Error("obsolete recovery error"));
    await first; expect(h.agentBrowser.agentChatSessions[a.id].run.reply).toBe("newest reply");
  });
  it.each(["resolve/done", "reject/done", "resolve/error", "reject/error"])("terminal refresh shares selection ordering: %s", async variant => {
    const h = fourGapHarness(locale); await select(h, a.id); const oldRecord = store.getConversation(a.id)!;
    const terminalRead = deferred<store.Conversation | null>(); h.api.agent.conversations.get.mockReturnValueOnce(terminalRead.promise);
    realTerminal(h, a.id, variant.endsWith("error"), true); await flush();
    store.renameConversation(a.id, "new authoritative custom title"); store.addMessage(a.id, { role: "user", content: "new authoritative message" });
    await select(h, a.id); h.input.value = "latest owned draft"; const before = bytes();
    if (variant.startsWith("resolve")) terminalRead.resolve(oldRecord); else terminalRead.reject(new Error("obsolete terminal read failure")); await flush();
    expect(h.elements["agent-chat-title"].textContent).toBe("new authoritative custom title");
    expect(h.state.agentMessages.some((m: any) => m.content === "new authoritative message")).toBe(true);
    expect(h.input.value).toBe("latest owned draft"); assertReadOnly(h, before);
  });
  it("a later terminal history request supersedes an older pending selection read", async () => {
    const h = fourGapHarness(locale), read = deferred<store.Conversation | null>(); const oldRecord = store.getConversation(a.id)!;
    h.api.agent.conversations.get.mockReturnValueOnce(read.promise); const selecting = h.agentBrowser.agentSelectConv(a.id); await flush();
    store.renameConversation(a.id, "terminal-authoritative title"); store.addMessage(a.id, { role: "user", content: "terminal-authoritative history" });
    realTerminal(h, a.id, false, true); await flush(); read.resolve(oldRecord); await selecting;
    expect(h.elements["agent-chat-title"].textContent).toBe("terminal-authoritative title");
    expect(h.state.agentMessages.some((m: any) => m.content === "terminal-authoritative history")).toBe(true);
  });
  it.each(["resolve", "reject", "null"])("terminal refresh %s cannot resurrect a deleted session or clobber B", async outcome => {
    const h = fourGapHarness(locale); await select(h, a.id);
    store.renameConversation(a.id, "persisted deleted-session title"); const oldRecord = store.getConversation(a.id)!;
    const read = deferred<store.Conversation | null>(); h.api.agent.conversations.get.mockReturnValueOnce(read.promise);
    realTerminal(h, a.id, true, true); await flush(); const removedSession = h.agentBrowser.agentChatSessions[a.id];
    h.agentBrowser.agentDeleteConvItem(a.id); h.confirmations[0](); await flush(); const removedBefore = JSON.stringify(removedSession);
    await select(h, b.id); h.input.value = "B survives deleted A"; const before = bytes();
    if (outcome === "reject") read.reject(new Error("deleted terminal read")); else read.resolve(outcome === "null" ? null : oldRecord); await flush();
    expect(h.agentBrowser.agentChatSessions[a.id]).toBeUndefined(); expect(h.state.agentActiveConvId).toBe(b.id);
    expect(JSON.stringify(removedSession)).toBe(removedBefore);
    expect(h.input.value).toBe("B survives deleted A"); expect(store.getConversation(a.id)).toBeNull();
    expect(h.agentBrowser.agentChatController.findByRunId("recovery-run")).toBeNull(); assertReadOnly(h, before);
  });
  it.each(["success", "null", "reject"])("current terminal history positive/error control: %s", async outcome => {
    const h = fourGapHarness(locale); await select(h, a.id); h.input.value = "typed before terminal";
    if (outcome === "success") { store.renameConversation(a.id, "saved terminal title"); store.addMessage(a.id, { role: "user", content: "saved terminal history" }); }
    else if (outcome === "null") h.api.agent.conversations.get.mockResolvedValueOnce(null);
    else h.api.agent.conversations.get.mockRejectedValueOnce(new Error("current terminal read denial"));
    const before = bytes(); realTerminal(h, a.id, true, true); await flush();
    expect(h.input.value).toBe("typed before terminal"); expect(h.input.disabled).toBe(false); assertReadOnly(h, before);
    if (outcome === "success") { expect(h.elements["agent-chat-title"].textContent).toBe("saved terminal title"); expect(h.elements["agent-chat-messages"].innerHTML).toContain("saved terminal history"); }
    expect(h.agentBrowser.agentChatSessions[a.id].lastRun.endReason).toBe("execution_error");
  });
});

for (const locale of ["en-US", "zh-CN"] as const) describe(`Task196 additional recovery paths — ${locale}`, () => {
  it("approval recovery uses the same stream-event fence", async () => {
    const h = fourGapHarness(locale); await select(h, a.id); const recovery = deferred<any>();
    (h.api as any).agentRuns = { get: vi.fn(async () => ({ source: { type: "chat", conversationId: a.id } })) };
    h.api.agent.activeRun.mockReturnValueOnce(recovery.promise);
    const resolving = h.agentBrowser.agentChatController.resolveOwnedRun({ runId: "recovery-run" }); await flush();
    h.emit("agent:stream-start", existingSnapshot(a.id));
    h.emit("agent:stream-chunk", { conversationId: a.id, streamId: "recovery-stream", text: "fresh approval delta" });
    recovery.resolve(existingSnapshot(a.id)); await resolving; await flush();
    expect(h.agentBrowser.agentChatSessions[a.id].run.reply).toBe("fresh approval delta");
    expect(h.elements["agent-chat-messages"].innerHTML).toContain("fresh approval delta");
  });
  it("approval recovery still accepts a fresh owned snapshot but rejects a wrong-run snapshot", async () => {
    const h = fourGapHarness(locale); await select(h, a.id);
    (h.api as any).agentRuns = { get: vi.fn(async () => ({ source: { type: "chat", conversationId: a.id } })) };
    h.api.agent.activeRun.mockResolvedValueOnce(existingSnapshot(a.id, { runId: "wrong-run" }));
    expect(await h.agentBrowser.agentChatController.resolveOwnedRun({ runId: "recovery-run" })).toBeNull();
    expect(h.agentBrowser.agentChatSessions[a.id].run).toBeNull();
    h.api.agent.activeRun.mockResolvedValueOnce(existingSnapshot(a.id));
    expect((await h.agentBrowser.agentChatController.resolveOwnedRun({ runId: "recovery-run" })).conversationId).toBe(a.id);
    expect(h.agentBrowser.agentChatSessions[a.id].run.reply).toBe("old reply");
  });
  it("deleted membership also fences a pending approval snapshot", async () => {
    const h = fourGapHarness(locale); await select(h, a.id); const recovery = deferred<any>();
    (h.api as any).agentRuns = { get: vi.fn(async () => ({ source: { type: "chat", conversationId: a.id } })) };
    h.api.agent.activeRun.mockReturnValueOnce(recovery.promise);
    const resolving = h.agentBrowser.agentChatController.resolveOwnedRun({ runId: "recovery-run" }); await flush();
    h.agentBrowser.agentDeleteConvItem(a.id); h.confirmations[0](); await flush();
    recovery.resolve(existingSnapshot(a.id)); expect(await resolving).toBeNull();
    expect(h.agentBrowser.agentChatSessions[a.id]).toBeUndefined();
    expect(h.agentBrowser.agentChatController.findByRunId("recovery-run")).toBeNull();
  });
  it("a foreign event does not invalidate legitimate fresh recovery", async () => {
    const h = fourGapHarness(locale); h.api.agent.activeRun.mockResolvedValueOnce(existingSnapshot(a.id)); await select(h, a.id);
    const recovery = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise); h.agentBrowser.switchAgentSub("chat"); await flush();
    h.emit("agent:stream-chunk", { conversationId: b.id, streamId: "foreign-stream", text: "foreign" });
    recovery.resolve(existingSnapshot(a.id, { reply: "fresh valid reply" })); await flush();
    expect(h.agentBrowser.agentChatSessions[a.id].run.reply).toBe("fresh valid reply");
    expect(h.elements["agent-chat-messages"].innerHTML).not.toContain("foreign");
  });
  it("restoring a draft after renderer recovery still renders message footers without writes", async () => {
    const h = fourGapHarness(locale); await select(h, a.id); const before = bytes();
    const html = h.elements["agent-chat-messages"].innerHTML;
    expect(html).toContain('class="chat-msg-foot is-user"'); expect(html).toContain('data-msg-copy="0"');
    expect(html).toContain("synthetic A history"); h.agentBrowser.agentRenderMessages(); assertReadOnly(h, before);
  });
});

it("Task196 retains production JSON bytes for independent fresh-process reload/ID/list/search", async () => {
  const before = bytes();
  for (const locale of ["en-US", "zh-CN"] as const) {
    const h = fourGapHarness(locale); await select(h, a.id); h.input.value = "retained exact draft\n ";
    const recovery = deferred<any>(); h.api.agent.activeRun.mockReturnValueOnce(recovery.promise); h.agentBrowser.switchAgentSub("chat"); await flush();
    recovery.resolve(existingSnapshot(a.id)); await flush(); realTerminal(h, a.id, true, true); await flush();
    expect(h.input.value).toBe("retained exact draft\n "); h.agentBrowser.agentRenderConvs(); h.agentBrowser.agentRenderMessages();
    h.elements["agent-conv-search"].value = "Project A"; h.agentBrowser.agentFilterConvs();
    expect(h.elements["agent-conv-list"].innerHTML).toContain(a.id); expect(h.elements["agent-conv-list"].innerHTML).not.toContain(b.id);
    assertReadOnly(h, before);
  }
  const saved = JSON.parse(before) as store.Conversation[];
  expect(store.loadConversations()).toEqual(saved); expect(store.getConversation(a.id)).toEqual(saved.find(c => c.id === a.id));
  const evidenceRoot = process.env.CHAT_FOUR_GAPS_EVIDENCE;
  if (evidenceRoot) {
    const retained = path.join(evidenceRoot, "retained-production-store"); fs.mkdirSync(retained, { recursive: true });
    fs.copyFileSync(store.conversationsPath(), path.join(retained, "agent-conversations.json"));
    fs.writeFileSync(path.join(evidenceRoot, "storage-renderer-proof.json"), JSON.stringify({
      sourcePath: store.conversationsPath(), retainedPath: path.join(retained, "agent-conversations.json"),
      ids: saved.map(c => c.id), searchedId: a.id, query: "Project A", bytesUnchanged: bytes() === before,
      createCalls: 0, messageWrites: 0, locales: ["en-US", "zh-CN"],
    }, null, 2));
  }
});
