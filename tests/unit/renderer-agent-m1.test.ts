import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const AGENT_CHAT = fs.readFileSync(
  path.resolve(__dirname, "../../src/renderer/js/app/agent-chat.js"),
  "utf8",
);
const APPROVAL = fs.readFileSync(
  path.resolve(__dirname, "../../src/renderer/js/app/approval.js"),
  "utf8",
);
const DELEGATION = fs.readFileSync(
  path.resolve(__dirname, "../../src/renderer/js/app/delegation.js"),
  "utf8",
);

class FakeElement {
  id: string;
  value = "";
  disabled = false;
  textContent = "";
  innerHTML = "";
  open = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  scrollHeight = 200;
  scrollTop = 200;
  clientHeight = 100;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  classList = {
    add: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn(() => false),
    toggle: vi.fn(),
  };

  constructor(id: string) { this.id = id; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  appendChild(child: FakeElement) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: FakeElement) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
}

function flush(times = 8): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => undefined);
  return p;
}

function makeHarness() {
  const ids = [
    "agent-view-chat", "agent-conv-list", "agent-conv-search", "agent-chat-title",
    "agent-chat-messages", "agent-chat-status", "agent-chat-input", "agent-chat-send",
    "agent-chat-stop", "agent-run-strip", "agent-run-state", "agent-run-action",
    "agent-run-elapsed", "agent-env-select", "agent-env-status", "agent-env-start",
    "agent-scroll-bottom", "agent-scroll-badge", "dlg-approval", "approval-desc",
    "approval-detail", "approval-stop-run",
  ];
  const elements: Record<string, FakeElement> = Object.fromEntries(
    ids.map((id) => [id, new FakeElement(id)]),
  );
  elements["agent-env-select"].value = "";

  const listeners = new Map<string, Set<(payload: any) => void>>();
  const api: any = {
    browser: {
      list: vi.fn(async () => [
        { dirId: "profile-a", name: "Profile A", running: true, pid: 42, cdpPort: 9222 },
      ]),
      status: vi.fn(async () => ({ running: true, pid: 42, cdpPort: 9222 })),
    },
    agent: {
      conversations: {
        list: vi.fn(async () => [
          { id: "conv-a", title: "A", messages: [], messageCount: 0 },
          { id: "conv-b", title: "B", messages: [], messageCount: 1 },
        ]),
        get: vi.fn(async (id: string) => ({
          id,
          title: id,
          messages: id === "conv-b" ? [{ role: "user", content: "B history" }] : [],
        })),
        create: vi.fn(async () => ({ id: "created", title: "New Chat", messages: [] })),
        delete: vi.fn(async () => ({ success: true })),
      },
      chatStream: vi.fn(() => new Promise(() => {})),
      activeRun: vi.fn(async () => null),
      cancelRun: vi.fn(async () => ({ accepted: true, state: "cancelling" })),
    },
    agentRuns: {
      get: vi.fn(async () => null),
    },
    approval: {
      list: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ success: true })),
    },
    on(channel: string, callback: (payload: any) => void) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, set = new Set());
      set.add(callback);
    },
    removeListener(channel: string, callback: (payload: any) => void) {
      listeners.get(channel)?.delete(callback);
    },
    emit(channel: string, payload: any) {
      for (const callback of Array.from(listeners.get(channel) || [])) callback(payload);
    },
  };

  const state: any = {
    agentActiveConvId: "conv-a",
    agentMessages: [],
    agentConvList: [],
  };
  const helpers: any = {
    toast: vi.fn(),
    esc: (value: unknown) => String(value ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;").replace(/'/g, "&#39;"),
    escAttr: (value: unknown) => String(value ?? "").replace(/\"/g, "&quot;"),
    icon: (name: string) => `<svg data-icon="${name}"></svg>`,
    renderChatMarkdown: (value: unknown) => String(value ?? ""),
    renderInlineMarkdown: (value: unknown) => String(value ?? ""),
    fmtDuration: (ms: number) => `${ms}ms`,
    relTime: () => "now",
  };
  for (const name of [
    "shortPath", "fmt", "hardwareSummary", "shortenGpu", "fingerprintCompleteness",
    "platformIcon", "parseTagInput", "parseListInput", "closeDialogIfOpen",
    "clearSkillEditor", "refreshSkillViews", "skillSourceLabel", "renderSkillTags",
    "renderSkillCard", "bindSkillCardActions", "readHardwareFields", "writeHardwareFields",
    "renderProxyOptions", "proxySelectionValue", "profileProxySelectionValue",
    "proxyDisplayLabel", "parseProxySelection", "extractChromeExtensionId", "getSyncStatus",
    "markProfileRuntime", "clearProfileRuntime", "scheduleProfilesRefresh", "getBrowserDisplay",
    "chromeOsFromPlatform", "uaPlatformFromPlatform", "platformFromOsName",
    "normalizeBrowserPlatform", "updateBrowserStatus", "renderBrowserBinaryCard",
  ]) helpers[name] = vi.fn();

  const agentBrowser: any = {
    api,
    R: api,
    state,
    helpers,
    ipc: { call: (_key: string, fn: () => Promise<any>) => fn() },
    confirm: (_message: string, onOk: () => void) => onOk(),
  };

  let uuid = 0;
  const document: any = {
    readyState: "complete",
    hidden: false,
    activeElement: null,
    documentElement: { lang: "en" },
    body: new FakeElement("body"),
    getElementById: (id: string) => elements[id] || null,
    querySelector: (selector: string) => {
      if (selector === "#agent-view-chat .btn-primary") return elements["agent-chat-send"];
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  const window: any = {
    agentBrowser,
    agentBrowserAPI: api,
    i18n: { t: (_key: string, fallback: string) => fallback },
    icons: { svg: (name: string) => `<svg data-icon="${name}"></svg>` },
    crypto: { randomUUID: () => `stream-${++uuid}` },
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
  };
  window.window = window;
  window.document = document;

  const context: any = {
    window,
    document,
    console,
    crypto: window.crypto,
    Promise,
    Date,
    Math,
    JSON,
    Error,
    String,
    Number,
    Object,
    Array,
    Map,
    Set,
    WeakMap,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.createContext(context);
  return { context, window, document, elements, api, state, agentBrowser };
}

function load(source: string, harness: ReturnType<typeof makeHarness>) {
  vm.runInContext(source, harness.context);
}

describe("renderer Agent M1 regressions", () => {
  it("keeps an in-flight reply bound to its conversation after switching chats", async () => {
    const h = makeHarness();
    load(AGENT_CHAT, h);

    h.agentBrowser._doAgentSend("from A");
    await flush();
    const call = h.api.agent.chatStream.mock.calls[0];
    expect(call).toBeTruthy();
    const streamId = call[2];
    expect(call[3]?.requestId).toBe(streamId);
    h.api.emit("agent:stream-start", {
      conversationId: "conv-a", streamId, runId: "run-a", startedAt: Date.now(),
    });

    h.agentBrowser.agentSelectConv("conv-b");
    await flush();
    expect(h.state.agentActiveConvId).toBe("conv-b");
    expect(h.state.agentMessages[0]?.content).toBe("B history");

    expect(() => h.api.emit("agent:stream-chunk", {
      conversationId: "conv-a", streamId, runId: "run-a", text: "A partial",
    })).not.toThrow();
    expect(h.state.agentActiveConvId).toBe("conv-b");
    expect(h.state.agentMessages.map((m: any) => m.content)).toEqual(["B history"]);

    h.agentBrowser.agentSelectConv("conv-a");
    await flush();
    expect(h.state.agentMessages.map((m: any) => m.content)).toEqual(["from A", "A partial"]);
  });

  it("ignores lifecycle events that arrive after their request terminalized", async () => {
    const h = makeHarness();
    load(AGENT_CHAT, h);

    h.agentBrowser._doAgentSend("first request");
    await flush();
    const firstStream = h.api.agent.chatStream.mock.calls[0][2];
    h.api.emit("agent:stream-start", {
      conversationId: "conv-a", streamId: firstStream, runId: "run-first", startedAt: 10,
    });
    h.api.emit("agent:stream-done", {
      conversationId: "conv-a", streamId: firstStream, runId: "run-first",
      reply: "first done", toolCalls: [], status: "done", endReason: "completed",
      verification: { status: "unverified" }, persisted: false,
    });
    expect(h.agentBrowser.agentChatController.getSession("conv-a").run).toBeNull();

    h.api.emit("agent:stream-start", {
      conversationId: "conv-a", streamId: firstStream, runId: "run-first", startedAt: 10,
    });
    expect(h.agentBrowser.agentChatController.getSession("conv-a").run).toBeNull();

    h.agentBrowser._doAgentSend("second request");
    await flush();
    const secondStream = h.api.agent.chatStream.mock.calls[1][2];
    h.api.emit("agent:stream-start", {
      conversationId: "conv-a", streamId: secondStream, runId: "run-second", startedAt: Date.now(),
    });
    h.api.emit("agent:stream-done", {
      conversationId: "conv-a", streamId: secondStream, runId: "run-second",
      reply: "second done", toolCalls: [], status: "done", endReason: "completed",
      verification: { status: "unverified" }, persisted: false,
    });

    h.api.emit("agent:stream-error", {
      conversationId: "conv-a", streamId: firstStream, runId: "run-first",
      reply: "stale", toolCalls: [], status: "error", endReason: "execution_error",
      verification: { status: "unverified" }, persisted: false, error: "stale terminal",
    });
    const session = h.agentBrowser.agentChatController.getSession("conv-a");
    expect(session.run).toBeNull();
    expect(session.lastRun).toMatchObject({ streamId: secondStream, runId: "run-second" });
    expect(h.state.agentMessages.at(-1)?.content).toBe("second done");
  });

  it("renders a tool result from agent:run-step instead of guessing success at stream end", async () => {
    const h = makeHarness();
    load(AGENT_CHAT, h);

    h.agentBrowser._doAgentSend("run a tool");
    await flush();
    const streamId = h.api.agent.chatStream.mock.calls[0][2];
    h.api.emit("agent:stream-start", {
      conversationId: "conv-a", streamId, runId: "run-a", startedAt: Date.now(),
    });
    h.api.emit("agent:stream-tool-call", {
      conversationId: "conv-a", streamId, runId: "run-a",
      name: "browser_click", arguments: "{}",
    });
    h.api.emit("agent:run-step", {
      runId: "run-a",
      step: {
        id: "step-a", tool: "browser_click", ok: false, error: "blocked",
        durationMs: 12, timestamp: Date.now(),
      },
    });
    h.api.emit("agent:stream-done", {
      conversationId: "conv-a", streamId, runId: "run-a", reply: "Handled",
      toolCalls: [{ name: "browser_click", redacted: true }], status: "done",
      endReason: "completed", verification: { status: "unverified" }, persisted: true,
    });

    const assistant = h.state.agentMessages.find((m: any) => m.role === "assistant");
    expect(assistant.steps).toHaveLength(1);
    expect(assistant.steps[0]).toMatchObject({
      id: "step-a", tool: "browser_click", ok: false, error: "blocked",
    });
    expect(h.elements["agent-chat-messages"].innerHTML).toContain("chat-tool-failed");
    expect(h.elements["agent-chat-messages"].innerHTML).not.toContain("chat-tool-pending");
  });

  it("preserves exact terminal run-step truth across a conversation refresh", async () => {
    const h = makeHarness();
    let savedA: any = { id: "conv-a", title: "A", messages: [] };
    const savedB = {
      id: "conv-b", title: "B", messages: [
        { role: "user", content: "from B", requestId: "stream-b", runId: "run-b" },
        {
          role: "assistant", content: "B done", requestId: "stream-b", runId: "run-b",
          toolCalls: [{ name: "db_query", redacted: true }],
          endReason: "completed", verification: { status: "unverified" },
        },
      ],
    };
    h.api.agent.conversations.get.mockImplementation(async (id: string) => id === "conv-a" ? savedA : savedB);
    load(AGENT_CHAT, h);

    h.agentBrowser._doAgentSend("deny this operation");
    await flush();
    const streamId = h.api.agent.chatStream.mock.calls[0][2];
    h.api.emit("agent:stream-start", {
      conversationId: "conv-a", streamId, runId: "run-a", startedAt: Date.now(),
    });
    h.api.emit("agent:stream-tool-call", {
      conversationId: "conv-a", streamId, runId: "run-a", name: "db_exec", arguments: "{}",
    });
    h.api.emit("agent:run-step", {
      runId: "run-a",
      step: {
        id: "step-a", tool: "db_exec", ok: false, error: "denied",
        durationMs: 8, timestamp: Date.now(),
      },
    });
    savedA = {
      id: "conv-a", title: "A", messages: [
        { role: "user", content: "deny this operation", requestId: streamId, runId: "run-a" },
        {
          role: "assistant", content: "A handled the denial", requestId: streamId, runId: "run-a",
          toolCalls: [{ name: "db_exec", redacted: true }],
          endReason: "completed", verification: { status: "unverified" },
          // Conversation persistence deliberately omits detailed run steps.
        },
      ],
    };
    h.api.emit("agent:stream-done", {
      conversationId: "conv-a", streamId, runId: "run-a", reply: "A handled the denial",
      toolCalls: [{ name: "db_exec", redacted: true }], status: "done",
      endReason: "completed", verification: { status: "unverified" }, persisted: true,
    });
    await flush();

    let assistant = h.state.agentMessages.find((message: any) => message.role === "assistant");
    expect(assistant.steps).toEqual([
      expect.objectContaining({ id: "step-a", tool: "db_exec", ok: false, error: "denied" }),
    ]);
    expect(h.elements["agent-chat-messages"].innerHTML).toContain('data-step-status="failed"');

    await h.agentBrowser.agentSelectConv("conv-b");
    await flush();
    expect(h.elements["agent-chat-messages"].innerHTML).not.toContain('data-step-status="failed"');
    assistant = h.state.agentMessages.find((message: any) => message.role === "assistant");
    expect(assistant.runId).toBe("run-b");
    expect(assistant.steps).toBeUndefined();

    await h.agentBrowser.agentSelectConv("conv-a");
    await flush();
    assistant = h.state.agentMessages.find((message: any) => message.role === "assistant");
    expect(assistant.runId).toBe("run-a");
    expect(assistant.steps[0]).toMatchObject({ tool: "db_exec", ok: false, error: "denied" });
    expect(h.elements["agent-chat-messages"].innerHTML).toContain('data-step-status="failed"');
  });

  it("cancels during runtime validation without ever submitting the chat request", async () => {
    const h = makeHarness();
    let releaseStatus!: (value: any) => void;
    h.api.browser.status.mockImplementationOnce(() => new Promise((resolve) => { releaseStatus = resolve; }));
    load(AGENT_CHAT, h);
    h.elements["agent-env-select"].value = "profile-a";

    const pending = h.agentBrowser._doAgentSend("must never be submitted");
    await flush();
    expect(h.api.browser.status).toHaveBeenCalledWith("profile-a");
    await h.agentBrowser.agentStopRun();
    releaseStatus({ running: true, pid: 42, cdpPort: 9222 });
    await pending;
    await flush();

    expect(h.api.agent.chatStream).not.toHaveBeenCalled();
    expect(h.agentBrowser.agentChatController.getSession("conv-a").run).toBeNull();
  });

  it("does not let A's failed scope validation replace B's environment selection", async () => {
    const h = makeHarness();
    let rejectStatus!: (error: Error) => void;
    h.api.browser.status.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStatus = reject; }));
    load(AGENT_CHAT, h);
    h.elements["agent-env-select"].value = "profile-a";

    const pendingA = h.agentBrowser._doAgentSend("validate A");
    await flush();
    expect(h.api.browser.status).toHaveBeenCalledWith("profile-a");

    await h.agentBrowser.agentSelectConv("conv-b");
    await flush();
    expect(h.state.agentActiveConvId).toBe("conv-b");
    expect(h.elements["agent-env-select"].value).toBe("");

    rejectStatus(new Error("A status failed"));
    await pendingA;
    await flush();

    expect(h.state.agentActiveConvId).toBe("conv-b");
    expect(h.elements["agent-env-select"].value).toBe("");
    expect(h.agentBrowser.agentChatController.getSession("conv-a").run).toBeNull();
  });

  it("restores an authoritative active snapshot without resending", async () => {
    const h = makeHarness();
    h.api.agent.conversations.get.mockResolvedValueOnce({
      id: "conv-a", title: "A", messages: [
        { role: "user", content: "already sent", requestId: "stream-restored", runId: "run-restored" },
      ],
    });
    h.api.agent.activeRun.mockResolvedValueOnce({
      conversationId: "conv-a", streamId: "stream-restored", runId: "run-restored",
      state: "running", startedAt: Date.now(), reply: "partial restored",
      toolCalls: [], steps: [], currentTool: "",
    });
    load(AGENT_CHAT, h);

    await h.agentBrowser.agentSelectConv("conv-a");
    await flush();
    expect(h.api.agent.chatStream).not.toHaveBeenCalled();
    expect(h.state.agentMessages.map((message: any) => message.content)).toEqual([
      "already sent", "partial restored",
    ]);

    h.api.emit("agent:stream-chunk", {
      conversationId: "conv-a", streamId: "stream-restored", runId: "run-restored", text: " + live",
    });
    expect(h.state.agentMessages[1].content).toBe("partial restored + live");
  });

  it("queues approvals and stopping A reveals B without resolving B", async () => {
    const h = makeHarness();
    const stop = vi.fn(async () => ({ accepted: true, state: "cancelling" }));
    h.agentBrowser.agentChatController = {
      findByRunId: (runId: string) => runId === "run-a"
        ? { conversationId: "conv-a", runId: "run-a", streamId: "stream-a" }
        : null,
      resolveOwnedRun: async (req: any) => req.runId === "run-a"
        ? { conversationId: "conv-a", runId: "run-a", streamId: "stream-a" }
        : null,
      stop,
    };
    load(APPROVAL, h);

    h.api.emit("agent:approval-request", {
      id: "approval-a", runId: "run-a", tool: "db_exec", category: "db-destroy",
      description: "Request A", createdAt: 1,
    });
    h.api.emit("agent:approval-request", {
      id: "approval-b", runId: "run-b", tool: "db_exec", category: "db-destroy",
      description: "Request B", createdAt: 2,
    });
    await flush();

    expect(h.elements["approval-desc"].textContent).toBe("Request A");
    h.agentBrowser.approvalStopRun();
    await flush();

    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-a" }));
    expect(h.api.approval.resolve).not.toHaveBeenCalled();
    expect(h.elements["approval-desc"].textContent).toBe("Request B");
    expect(h.elements["dlg-approval"].open).toBe(true);
  });

  it("does not report a late failed approval resolution as success", async () => {
    const h = makeHarness();
    h.api.approval.resolve.mockResolvedValueOnce({ success: false, error: "request already ended" });
    load(APPROVAL, h);
    h.api.emit("agent:approval-request", {
      id: "approval-late", tool: "db_exec", category: "db-destroy",
      description: "Late request", createdAt: 1,
    });
    await flush();

    await h.agentBrowser.approvalAllow("once");
    expect(h.agentBrowser.helpers.toast).toHaveBeenCalledWith("request already ended", "error");
    expect(h.agentBrowser.helpers.toast).not.toHaveBeenCalledWith("Allowed", "success");
  });

  it("logs normalized genuine errors and keeps user cancellation quiet", async () => {
    const h = makeHarness();
    const consoleError = vi.fn();
    h.context.console = { error: consoleError, warn: vi.fn(), log: vi.fn() };
    load(AGENT_CHAT, h);

    h.agentBrowser._doAgentSend("fail visibly");
    await flush();
    const failedStream = h.api.agent.chatStream.mock.calls[0][2];
    h.api.emit("agent:stream-start", {
      conversationId: "conv-a", streamId: failedStream, runId: "run-failed", startedAt: Date.now(),
    });
    const terminalPayload = {
      conversationId: "conv-a", streamId: failedStream, runId: "run-failed",
      reply: "a reply that must not be logged", toolCalls: [], status: "error",
      endReason: "execution_error", verification: { status: "unverified" },
      persisted: true, error: { message: "boom-500-sentinel" },
    };
    h.api.emit("agent:stream-error", terminalPayload);

    expect(consoleError).toHaveBeenCalledWith("[agent] task ended:", "boom-500-sentinel");
    expect(consoleError).not.toHaveBeenCalledWith("[agent] task ended:", terminalPayload);

    h.agentBrowser._doAgentSend("stop quietly");
    await flush();
    const cancelledStream = h.api.agent.chatStream.mock.calls[1][2];
    h.api.emit("agent:stream-start", {
      conversationId: "conv-a", streamId: cancelledStream, runId: "run-cancelled", startedAt: Date.now(),
    });
    h.api.emit("agent:stream-error", {
      conversationId: "conv-a", streamId: cancelledStream, runId: "run-cancelled",
      reply: "", toolCalls: [], status: "error", endReason: "user_cancelled",
      verification: { status: "unverified" }, persisted: true,
      error: "Task stopped by the user",
    });

    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("binds composer delegation when the module loads after DOMContentLoaded", () => {
    const handlers = new Map<string, Array<(event: any) => void>>();
    const agentSend = vi.fn();
    const document = {
      readyState: "complete",
      activeElement: null,
      addEventListener(type: string, handler: (event: any) => void) {
        const current = handlers.get(type) || [];
        current.push(handler);
        handlers.set(type, current);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({}),
    };
    function FakeDialog() {}
    (FakeDialog as any).prototype.showModal = function() {};
    function FakeElement() {}
    const agentBrowser = {
      api: {}, R: {}, state: {},
      helpers: {},
      agentSend,
    };
    const window: any = { agentBrowser, document };
    window.window = window;
    const context = vm.createContext({
      window,
      document,
      HTMLDialogElement: FakeDialog,
      HTMLElement: FakeElement,
      Array,
      Promise,
      setTimeout,
      console,
    });

    vm.runInContext(DELEGATION, context);
    const input = {
      closest(selector: string) {
        return selector === '[data-role="keydown"]' ? this : null;
      },
    };
    const preventDefault = vi.fn();
    for (const handler of handlers.get("keydown") || []) {
      handler({ target: input, key: "Enter", shiftKey: false, preventDefault });
    }

    expect(agentSend).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);

    const documentTargetPreventDefault = vi.fn();
    expect(() => {
      for (const handler of handlers.get("keydown") || []) {
        handler({ target: document, key: "Enter", shiftKey: false, preventDefault: documentTargetPreventDefault });
      }
    }).not.toThrow();
    expect(agentSend).toHaveBeenCalledTimes(1);
    expect(documentTargetPreventDefault).not.toHaveBeenCalled();
    expect(handlers.has("DOMContentLoaded")).toBe(false);
  });
});
