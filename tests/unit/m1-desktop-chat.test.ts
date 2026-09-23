import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  conversations: new Map<string, any>(),
  runs: new Map<string, any>(),
  order: [] as string[],
  model: vi.fn(),
  tool: vi.fn(),
  finishFault: false,
  messageFault: "",
  config: { provider: "openai", apiKey: "test", model: "fixture" } as any,
  nextRun: 0,
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: any) => h.handlers.set(name, handler) },
  clipboard: { writeText: vi.fn() },
  BrowserWindow: { fromWebContents: (sender: any) => sender.trusted ? { isDestroyed: () => false } : null },
}));
vi.mock("../../src/main/services/local-agent.js", () => ({
  getLlmConfig: () => h.config,
  getOrDetectLlmConfig: () => h.config,
  getConversation: (id: string) => structuredClone(h.conversations.get(id) || null),
  addMessage: (id: string, role: string, content: string, toolResults?: any[], meta?: any) => {
    if (h.messageFault === role) throw new Error("ENOSPC: history write failed");
    const conv = h.conversations.get(id);
    if (!conv) return null;
    conv.messages.push({ role, content, toolResults, ...meta });
    h.order.push(role + ".persisted");
    return structuredClone(conv);
  },
  getAllowedAgentTools: () => [{ type: "function", function: { name: "read_file" } }],
  buildAgentSystemPrompt: () => "fixture system prompt",
  repairMessageSequence: (messages: any[]) => messages,
  llmStreamChat: (...args: any[]) => h.model(...args),
  llmChat: (config: any, messages: any[], tools: any[], signal: AbortSignal) => h.model(config, messages, tools, { signal }),
  agentChat: async () => ({ messages: [{ role: "assistant", content: "legacy answer" }] }),
  executeToolCall: (...args: any[]) => h.tool(...args),
}));
vi.mock("../../src/main/services/agent/run-scope.js", () => ({
  captureChatBrowserScope: (id?: string) => {
    if (id) throw new Error("Selected browser environment is not running");
    return null;
  },
  filterChatTools: (tools: any[]) => tools,
}));
vi.mock("../../src/main/services/agent-run-trace.js", () => ({
  agentRunRecorder: {
    startRun: (opts: any) => {
      const run = { id: "fixture_run_" + ++h.nextRun, ...opts, status: "running", startedAt: Date.now(), steps: [], verification: { status: "unverified" } };
      h.runs.set(run.id, run);
      h.order.push("trace.started");
      return run;
    },
    recordStep: (id: string, data: any) => {
      const run = h.runs.get(id);
      if (!run) return null;
      const step = { id: "step_" + run.steps.length, timestamp: Date.now(), ...data };
      run.steps.push(step);
      h.order.push("step.persisted");
      return step;
    },
    finishRun: (id: string, status: string, error?: string, meta?: any) => {
      if (h.finishFault) throw new Error("EIO: trace write failed");
      const run = h.runs.get(id);
      if (!run) return null;
      Object.assign(run, { status, error, ...meta });
      h.order.push("trace.finished");
      return run;
    },
    getRun: (id: string) => h.runs.get(id) || null,
    releaseRun: vi.fn(),
  },
}));
vi.mock("../../src/main/services/browser-manager.js", () => ({ listBrowserProfiles: () => [] }));
vi.mock("../../src/main/services/agent-db.js", () => ({}));
vi.mock("../../src/main/services/approval-gate.js", () => ({}));
vi.mock("../../src/main/services/skill-repository.js", () => ({}));
vi.mock("../../src/main/services/audit-log.js", () => ({}));
vi.mock("../../src/main/services/task-templates.js", () => ({}));
vi.mock("../../src/main/services/team.js", () => ({}));
vi.mock("../../src/main/services/platform-adapters.js", () => ({}));

import { registerAgentHandlers } from "../../src/main/ipc/agent.js";

let nextOwner = 0;
class Owner extends EventEmitter {
  id = ++nextOwner;
  trusted = true;
  destroyed = false;
  sent: Array<{ channel: string; payload: any }> = [];
  isDestroyed() { return this.destroyed; }
  send(channel: string, payload: any) {
    h.order.push(channel);
    this.sent.push({ channel, payload });
  }
}
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function invoke(owner: Owner, channel: string, params: any) {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error("Missing IPC handler: " + channel);
  return handler({ sender: owner }, params);
}
function terminal(owner: Owner) {
  return owner.sent.filter((e) => e.channel === "agent:stream-done" || e.channel === "agent:stream-error");
}
const owners: Owner[] = [];
function owner() {
  const result = new Owner();
  owners.push(result);
  return result;
}
let cid = "";
function toolReply() {
  return { role: "assistant", content: "", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "read_file", arguments: '{"path":"fixture.txt"}' } }] };
}

beforeEach(() => {
  h.order = [];
  h.conversations.clear();
  h.runs.clear();
  h.finishFault = false;
  h.messageFault = "";
  h.config = { provider: "openai", apiKey: "test", model: "fixture" };
  h.model.mockReset().mockImplementation(async (_c, _m, _t, cb) => {
    cb.onText?.("answer");
    cb.onDone?.();
    return { role: "assistant", content: "answer" };
  });
  h.tool.mockReset().mockResolvedValue({ text: "fixture" });
  registerAgentHandlers();
  cid = "conv_" + (nextOwner + 1);
  h.conversations.set(cid, { id: cid, title: cid, messages: [] });
});
afterEach(() => {
  for (const wc of owners.splice(0)) {
    wc.destroyed = true;
    wc.emit("destroyed");
  }
  vi.useRealTimers();
});

describe("owned desktop chat lifecycle", () => {
  it("can stop a preparing request before any history or model work", async () => {
    const wc = owner();
    const task = invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "prepare" });
    expect(await invoke(wc, "agent:chat-active", cid)).toMatchObject({ state: "preparing", streamId: "prepare" });
    expect((await invoke(wc, "agent:chat-cancel", { conversationId: cid, streamId: "prepare" })).accepted).toBe(true);
    expect(await task).toMatchObject({ endReason: "user_cancelled", persisted: false });
    expect(h.model).not.toHaveBeenCalled();
    expect(h.conversations.get(cid).messages).toEqual([]);
    expect(h.runs.size).toBe(0);
  });

  it("aborts the model signal, preserves partial text and ignores late callbacks", async () => {
    const wc = owner();
    const entered = deferred();
    let callbacks: any;
    h.model.mockImplementation((_c, _m, _t, cb) => {
      callbacks = cb;
      cb.onText("partial");
      entered.resolve(undefined);
      return new Promise((_resolve, reject) => cb.signal.addEventListener("abort", () => reject(cb.signal.reason), { once: true }));
    });
    const task = invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "model-stop" });
    await entered.promise;
    await invoke(wc, "agent:chat-cancel", { conversationId: cid, streamId: "model-stop" });
    const result = await task;
    expect(callbacks.signal.aborted).toBe(true);
    expect(result).toMatchObject({ endReason: "user_cancelled", reply: "partial", persisted: true });
    const eventCount = wc.sent.length;
    callbacks.onText("late callback must be ignored");
    expect(wc.sent).toHaveLength(eventCount);
    expect(h.conversations.get(cid).messages[1].content).toContain("partial");
    expect(h.conversations.get(cid).messages[1].content).not.toContain("late callback");
    expect(terminal(wc)).toHaveLength(1);
  });

  it("distinguishes the whole-task timeout from user cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const wc = owner();
    const entered = deferred();
    h.model.mockImplementation((_c, _m, _t, cb) => {
      entered.resolve(undefined);
      return new Promise((_resolve, reject) => cb.signal.addEventListener("abort", () => reject(cb.signal.reason), { once: true }));
    });
    const task = invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "timeout" });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await task).toMatchObject({ endReason: "timeout", status: "error", persisted: true });
    expect(terminal(wc)).toHaveLength(1);
  });

  it("persists renderer crashes as interrupted instead of timeout", async () => {
    const wc = owner();
    const entered = deferred();
    h.model.mockImplementation((_c, _m, _t, cb) => {
      entered.resolve(undefined);
      return new Promise((_resolve, reject) => cb.signal.addEventListener("abort", () => reject(cb.signal.reason), { once: true }));
    });
    const task = invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "crash" });
    await entered.promise;
    wc.emit("render-process-gone", {}, { reason: "crashed" });
    const result = await task;
    expect(result).toMatchObject({ endReason: "interrupted", persisted: true });
    expect(h.runs.get(result.runId)).toMatchObject({ status: "error", endReason: "interrupted" });
  });

  it("starts no model action when the user/run association cannot be saved", async () => {
    const wc = owner();
    h.messageFault = "user";
    const result = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "user-save" });
    expect(result).toMatchObject({ endReason: "execution_error", persisted: false, code: "PERSISTENCE_ERROR" });
    expect(h.model).not.toHaveBeenCalled();
    expect(h.tool).not.toHaveBeenCalled();
    expect(wc.sent.some((event) => event.channel === "agent:stream-start")).toBe(false);
    expect(h.conversations.get(cid).messages).toEqual([]);
    expect(h.runs.get(result.runId).status).toBe("error");
  });

  it("releases the execution lock but reports partial persistence when the trace finish fails", async () => {
    const wc = owner();
    h.finishFault = true;
    const result = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "trace-save" });
    expect(result).toMatchObject({ status: "error", persisted: false, code: "PERSISTENCE_ERROR" });
    expect(h.runs.get(result.runId).status).toBe("running");
    expect(h.conversations.get(cid).messages[1].endReason).toBeUndefined();
    expect((await invoke(wc, "agent:conversations:get", cid)).messages[1].endReason).toBeUndefined();
    // Model restart recovery without rewriting conversation history: its view
    // must follow the interrupted run rather than a copied completed field.
    Object.assign(h.runs.get(result.runId), { status: "error", endReason: "interrupted" });
    expect((await invoke(wc, "agent:conversations:get", cid)).messages[1].endReason).toBe("interrupted");
    expect(await invoke(wc, "agent:chat-active", cid)).toBeNull();
    expect(terminal(wc).map((event) => event.channel)).toEqual(["agent:stream-error"]);
    h.finishFault = false;
    expect((await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "retry", streamId: "trace-retry" })).endReason).toBe("completed");
  });

  it("keeps the in-memory lock even if the retained trace disappears", async () => {
    const wc = owner();
    const gate = deferred();
    const entered = deferred();
    h.model.mockResolvedValue(toolReply());
    h.tool.mockImplementation(() => { entered.resolve(undefined); return gate.promise; });
    const task = invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "removed" });
    await entered.promise;
    const active = await invoke(wc, "agent:chat-active", cid);
    h.runs.delete(active.runId);
    expect((await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "other", streamId: "removed-other" })).code).toBe("BUSY");
    gate.resolve({ text: "finished" });
    expect(await task).toMatchObject({ persisted: false, code: "PERSISTENCE_ERROR" });
    expect(h.tool).toHaveBeenCalledTimes(1);
    expect(await invoke(wc, "agent:chat-active", cid)).toBeNull();
  });

  it("refuses conflicting IDs and invalid environments before model or persistence work", async () => {
    const wc = owner();
    const conflict = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "one", requestId: "two" });
    expect(conflict.code).toBe("REQUEST_CONFLICT");
    const badId = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: 42 });
    expect(badId.code).toBe("INVALID_REQUEST");
    const stopped = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "stopped", profileDirId: "not-running" });
    expect(stopped.error).toMatch(/not running/);
    expect(h.model).not.toHaveBeenCalled();
    expect(h.conversations.get(cid).messages).toEqual([]);
    expect(h.runs.size).toBe(0);
  });

  it("never re-executes a request already present in persisted history", async () => {
    const wc = owner();
    h.conversations.get(cid).messages.push({ role: "user", content: "test", requestId: "previous-process", runId: "persisted-run" });
    const result = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "previous-process" });
    expect(result).toMatchObject({ code: "REQUEST_ALREADY_RECORDED", runId: "persisted-run" });
    expect(h.model).not.toHaveBeenCalled();
    expect(h.conversations.get(cid).messages).toHaveLength(1);
    expect(wc.sent).toHaveLength(0);
  });

  it("notifies completion only after the assistant and trace have persisted", async () => {
    const wc = owner();
    const result = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "ordering" });
    expect(h.order.indexOf("agent:stream-done")).toBeGreaterThan(h.order.indexOf("assistant.persisted"));
    expect(h.order.indexOf("agent:stream-done")).toBeGreaterThan(h.order.indexOf("trace.finished"));
    expect(result).toMatchObject({ endReason: "completed", verification: { status: "unverified" }, persisted: true });
    expect(terminal(wc)).toHaveLength(1);
  });

  it("links the user to its run before the first model request", async () => {
    const wc = owner();
    let firstMessage: any;
    h.model.mockImplementation(async () => {
      firstMessage = structuredClone(h.conversations.get(cid).messages[0]);
      return { role: "assistant", content: "answer" };
    });
    const result = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "link" });
    expect(firstMessage).toMatchObject({ role: "user", runId: result.runId, requestId: "link" });
    expect(typeof firstMessage.runId).toBe("string");
    expect(h.conversations.get(cid).messages[1]).toMatchObject({ runId: result.runId, requestId: "link" });
    expect(h.conversations.get(cid).messages[1].endReason).toBeUndefined();
    expect((await invoke(wc, "agent:conversations:get", cid)).messages[1]).toMatchObject({ endReason: "completed" });
  });

  it("does not announce success on round 25 before its last tool or label exhaustion completed", async () => {
    const wc = owner();
    h.model.mockImplementation(async (_c, _m, _t, cb) => {
      cb.onDone?.();
      return toolReply();
    });
    let lastToolSawDone = false;
    h.tool.mockImplementation(async () => {
      if (h.tool.mock.calls.length === 25) lastToolSawDone = terminal(wc).length > 0;
      return { text: "fixture" };
    });
    const result = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "rounds" });
    expect(lastToolSawDone).toBe(false);
    expect(h.tool).toHaveBeenCalledTimes(25);
    expect(result).toMatchObject({ status: "error", endReason: "round_limit", persisted: true });
    expect(terminal(wc).map((e) => e.channel)).toEqual(["agent:stream-error"]);
  });

  it("gives non-streaming tool chat the same tracked lifecycle", async () => {
    const wc = owner();
    const result = await invoke(wc, "agent:chat", { conversationId: cid, message: "test", requestId: "plain" });
    expect(typeof result.runId).toBe("string");
    expect(result).toMatchObject({ streamId: "plain", endReason: "completed", persisted: true });
    expect(h.conversations.get(cid).messages.map((m: any) => m.runId)).toEqual([result.runId, result.runId]);
  });

  it("records returned tool errors as failed steps instead of successful checks", async () => {
    const wc = owner();
    h.model.mockResolvedValueOnce(toolReply()).mockResolvedValue({ role: "assistant", content: "explanation" });
    h.tool.mockResolvedValue({ error: "File access denied" });
    const result = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "tool-error" });
    expect(h.runs.get(result.runId).steps[0]).toMatchObject({ ok: false, error: "File access denied" });
    expect(result).toMatchObject({ endReason: "completed", verification: { status: "unverified" } });
  });

  it.each(["agent:chat-stream", "agent:chat"])("records approval-skipped operations as not successful through %s", async (channel) => {
    const wc = owner();
    h.model.mockResolvedValueOnce(toolReply()).mockResolvedValue({ role: "assistant", content: "The operation was denied." });
    h.tool.mockResolvedValue({ skipped: true, reason: "The user denied this operation", decision: "deny" });
    const result = await invoke(wc, channel, { conversationId: cid, message: "test denial", streamId: "tool-denied" });
    expect(h.runs.get(result.runId).steps[0]).toMatchObject({ ok: false, error: "The user denied this operation" });
    expect(result).toMatchObject({ endReason: "completed", verification: { status: "unverified" }, persisted: true });
  });

  it("does not claim a saved success when assistant persistence fails", async () => {
    const wc = owner();
    h.messageFault = "assistant";
    const result = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "save-fails" });
    expect(result).toMatchObject({ persisted: false, status: "error", code: "PERSISTENCE_ERROR" });
    expect(terminal(wc)).toHaveLength(1);
    expect(terminal(wc)[0].channel).toBe("agent:stream-error");
    h.messageFault = "";
    const retry = await invoke(wc, "agent:chat-stream", { conversationId: cid, message: "retry", streamId: "after-save-fails" });
    expect(retry.endReason).toBe("completed");
  });

  it("cancels only the owner's request, keeps an in-flight tool honest, and dispatches nothing afterwards", async () => {
    const wc = owner();
    const foreign = owner();
    const gate = deferred();
    const entered = deferred();
    h.model.mockResolvedValue({ ...toolReply(), tool_calls: [...toolReply().tool_calls, { ...toolReply().tool_calls[0], id: "second" }] });
    h.tool.mockImplementation(() => { entered.resolve(undefined); return gate.promise; });
    const task = invoke(wc, "agent:chat-stream", { conversationId: cid, message: "test", streamId: "stop-tool" });
    await entered.promise;
    const active = await invoke(wc, "agent:chat-active", cid);
    expect(await invoke(foreign, "agent:chat-active", cid)).toBeNull();
    expect((await invoke(foreign, "agent:chat-cancel", { conversationId: cid, runId: active.runId })).accepted).toBe(false);
    expect((await invoke(wc, "agent:chat-cancel", { conversationId: cid, runId: active.runId })).state).toBe("cancelling");
    expect(terminal(wc)).toHaveLength(0);
    gate.resolve({ text: "already issued operation finished" });
    const result = await task;
    expect(h.tool).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ endReason: "user_cancelled", persisted: true });
    expect(h.runs.get(result.runId).steps[0].ok).toBe(true);
    expect(await invoke(wc, "agent:chat-active", cid)).toBeNull();
    expect((await invoke(wc, "agent:chat-cancel", { conversationId: cid, runId: result.runId })).endReason).toBe("user_cancelled");
  });

  it("deduplicates an identical request and rejects different overlapping or reused IDs", async () => {
    const wc = owner();
    const gate = deferred();
    h.model.mockImplementation(async () => gate.promise);
    const params = { conversationId: cid, message: "test", streamId: "same" };
    const first = invoke(wc, "agent:chat-stream", params);
    const duplicate = invoke(wc, "agent:chat-stream", params);
    const busy = await invoke(wc, "agent:chat-stream", { ...params, streamId: "another" });
    expect(busy.code).toBe("BUSY");
    await vi.waitFor(() => expect(h.model).toHaveBeenCalledTimes(1));
    expect(h.conversations.get(cid).messages).toHaveLength(1);
    gate.resolve({ role: "assistant", content: "done" });
    const result = await first;
    expect(await duplicate).toEqual(result);
    expect(await invoke(wc, "agent:chat-stream", params)).toEqual(result);
    expect((await invoke(wc, "agent:chat-stream", { ...params, message: "changed" })).code).toBe("REQUEST_CONFLICT");
    expect(h.model).toHaveBeenCalledTimes(1);
    expect(terminal(wc).filter((e) => e.payload.streamId === "same")).toHaveLength(1);
  });
});
