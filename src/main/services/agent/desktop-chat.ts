import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldToIpc } from "node:timers/promises";
import type { WebContents } from "electron";
import type { AgentRunEndReason } from "../../types.js";
import {
  addMessage, buildAgentSystemPrompt, executeToolCall, getAllowedAgentTools,
  getConversation, getLlmConfig, getOrDetectLlmConfig, llmChat, llmStreamChat,
  repairMessageSequence, type LlmMessage,
} from "../local-agent.js";
import { listBrowserProfiles } from "../browser-manager.js";
import { agentRunRecorder } from "../agent-run-trace.js";
import { captureChatBrowserScope, filterChatTools } from "./run-scope.js";
import { desktopChatRuns, type ChatRunContext, type ChatTerminal } from "./chat-runs.js";

export interface DesktopChatRequest {
  conversationId: string;
  message: string;
  streamId?: string;
  requestId?: string;
  profileDirId?: string;
}

const MAX_TOOL_ROUNDS = 25;
const CHAT_TIMEOUT_MS = 120_000;
const ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,160}$/;

class PersistenceError extends Error {
  constructor(operation: string, cause?: unknown) {
    super(`${operation}. The task's history may be only partially saved${cause ? `: ${errorText(cause)}` : "."}`, { cause });
    this.name = "PersistenceError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persist<T>(operation: string, write: () => T): NonNullable<T> {
  try {
    const result = write();
    if (result === null || result === undefined) throw new Error("The conversation or run record no longer exists.");
    return result as NonNullable<T>;
  } catch (error) {
    throw new PersistenceError(operation, error);
  }
}

function abortCheck(context: ChatRunContext): void {
  if (context.owner.isDestroyed()) desktopChatRuns.abort(context, "interrupted");
  if (context.controller.signal.aborted) throw context.controller.signal.reason;
}

function send(context: ChatRunContext, channel: string, data: Record<string, unknown>): void {
  if (context.owner.isDestroyed()) return;
  try {
    context.owner.send(channel, { ...data, conversationId: context.conversationId, streamId: context.streamId, runId: context.runId });
  } catch (error) {
    desktopChatRuns.abort(context, "interrupted");
    console.warn("[agent-chat] could not deliver lifecycle event:", errorText(error));
  }
}

function failure(conversationId: string, streamId: string, code: string, error: string): ChatTerminal {
  return { conversationId, streamId, reply: "", toolCalls: [], status: "error", endReason: "execution_error",
    verification: { status: "unverified" }, persisted: false, code, error };
}

function reasonMessage(reason: AgentRunEndReason): string {
  switch (reason) {
    case "user_cancelled": return "Task stopped by the user. Already-issued actions may have taken effect; no later actions were dispatched.";
    case "timeout": return "Task reached its time limit. Already-issued actions may have taken effect.";
    case "round_limit": return "Task reached the tool-round limit without a final response.";
    case "interrupted": return "Task was interrupted. Already-issued actions may have taken effect.";
    case "execution_error": return "Task failed during execution.";
    case "completed": return "";
  }
}

function toolError(result: any): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  if (result.error) return typeof result.error === "string" ? result.error : "Tool returned an error.";
  if (result.skipped === true) return typeof result.reason === "string" ? result.reason : "Tool operation was skipped.";
  if (result.ok === false || result.success === false) return typeof result.message === "string" ? result.message : "Tool reported an unsuccessful operation.";
  return undefined;
}

/** Both desktop tool-chat IPC methods use this lifecycle; service/REST callers do not. */
export function runDesktopChat(owner: WebContents, raw: DesktopChatRequest, streaming: boolean): Promise<ChatTerminal> {
  const conversationId = typeof raw?.conversationId === "string" ? raw.conversationId : "";
  const streamId = typeof raw?.streamId === "string" && raw.streamId ? raw.streamId
    : typeof raw?.requestId === "string" && raw.requestId ? raw.requestId : randomUUID();
  if (!ID_PATTERN.test(conversationId) || !ID_PATTERN.test(streamId)
    || (raw?.streamId !== undefined && (typeof raw.streamId !== "string" || !ID_PATTERN.test(raw.streamId)))
    || typeof raw?.message !== "string" || !raw.message.trim() || Buffer.byteLength(raw.message, "utf8") > 64 * 1024
    || (raw.profileDirId !== undefined && (typeof raw.profileDirId !== "string" || !ID_PATTERN.test(raw.profileDirId)))) {
    return Promise.resolve(failure(conversationId, streamId, "INVALID_REQUEST", "Invalid conversation, request ID, environment, or message (maximum 64 KiB of text)."));
  }
  if (raw.requestId !== undefined && (typeof raw.requestId !== "string" || !ID_PATTERN.test(raw.requestId)
    || (raw.streamId && raw.streamId !== raw.requestId))) {
    return Promise.resolve(failure(conversationId, streamId, "REQUEST_CONFLICT", "streamId and requestId must identify the same request."));
  }
  const params = { conversationId, streamId, message: raw.message, profileDirId: raw.profileDirId };
  const fingerprint = createHash("sha256").update(JSON.stringify({ ...params, streaming })).digest("hex");
  const reserved = desktopChatRuns.reserve(owner, { conversationId, streamId, profileDirId: params.profileDirId, fingerprint });
  if ("error" in reserved) return Promise.resolve(failure(conversationId, streamId, reserved.code, reserved.error));
  if (!reserved.fresh) return reserved.context.completion;
  const context = reserved.context;
  void execute(context, params.message, streaming).then((result) => {
    context.terminal = result;
    // Replaying an identity that has aged out of the memory cache must not
    // repeat an old lifecycle notification or, more importantly, its actions.
    if (result.code !== "REQUEST_ALREADY_RECORDED" && result.code !== "REQUEST_CONFLICT") {
      send(context, result.status === "done" ? "agent:stream-done" : "agent:stream-error", { ...result });
    }
    desktopChatRuns.finish(context, result);
  }, (error) => {
    // The execution body handles expected model/tool/storage errors. Still
    // release ownership if an unexpected finalization error escapes it.
    const result = { ...failure(conversationId, streamId, "FINALIZATION_ERROR", errorText(error)), runId: context.runId, reply: context.reply, toolCalls: context.toolCalls };
    if (context.runId) agentRunRecorder.releaseRun(context.runId);
    context.terminal = result;
    send(context, "agent:stream-error", { ...result });
    desktopChatRuns.finish(context, result);
  });
  return context.completion;
}

async function execute(context: ChatRunContext, message: string, streaming: boolean): Promise<ChatTerminal> {
  let userSaved = false;
  let storageError: PersistenceError | undefined;
  let endReason: AgentRunEndReason = "completed";
  let error: string | undefined;
  const timer = setTimeout(() => desktopChatRuns.abort(context, "timeout"), CHAT_TIMEOUT_MS);
  timer.unref();
  try {
    // Let a stop submitted while the request is preparing win before writes or
    // model dispatch. Subsequent async boundaries are checked independently.
    await yieldToIpc();
    abortCheck(context);
    const scope = captureChatBrowserScope(context.profileDirId);
    const config = getLlmConfig() || getOrDetectLlmConfig();
    if (!config) throw new Error("No LLM config. Configure an API key in Agent → API Config.");
    const conversation = getConversation(context.conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    const previous = conversation.messages.find((entry) => entry.role === "user" && entry.requestId === context.streamId);
    if (previous) {
      const conflict = previous.content !== message;
      return { ...failure(context.conversationId, context.streamId, conflict ? "REQUEST_CONFLICT" : "REQUEST_ALREADY_RECORDED",
        conflict ? "This request ID was already used for different input." : "This request was already recorded. Open its saved run instead of executing it again."), runId: previous.runId };
    }
    if (scope) {
      const selected = listBrowserProfiles().find((profile) => profile.dirId === scope.dirId);
      context.profileName = selected?.name || scope.dirId;
    }
    const run = persist("Could not save the running task", () => agentRunRecorder.startRun({
      source: { type: "chat", conversationId: context.conversationId },
      name: message.slice(0, 120), dirId: scope?.dirId, webContents: context.owner,
    }));
    context.runId = run.id;
    context.startedAt = run.startedAt;
    persist("Could not link the user message to its task", () => addMessage(context.conversationId, "user", message, undefined, {
      runId: run.id, requestId: context.streamId,
    }));
    userSaved = true;
    context.state = "running";
    send(context, "agent:stream-start", { profileDirId: scope?.dirId, profileName: context.profileName, startedAt: context.startedAt });

    const history: LlmMessage[] = conversation.messages
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .slice(-40).map((entry) => ({ role: entry.role, content: entry.content }));
    history.push({ role: "user", content: message });
    const messages = repairMessageSequence(history);
    const profiles = scope ? [{ name: context.profileName!, dirId: scope.dirId, cdpPort: scope.port }] : [];
    const boundary = scope
      ? `This desktop task is bound only to environment ${scope.dirId}, port ${scope.port}. Do not select, launch, or operate another environment.`
      : "No browser environment was selected. Do not select, launch, or operate any browser environment. Independent HTTP, file and database tools keep their own existing restrictions.";
    messages.unshift({ role: "system", content: buildAgentSystemPrompt(profiles) + "\n\n" + boundary
      + " Arbitrary page scripts and creating or deleting automation rules are unavailable in desktop chat." });
    const tools = filterChatTools(getAllowedAgentTools(), scope);
    const allowedNames = new Set(tools.map((tool: any) => tool.function.name));
    let finalAnswer = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      await yieldToIpc();
      abortCheck(context);
      const replyLength = context.reply.length;
      const result = streaming
        ? await llmStreamChat(config, messages, tools, {
          signal: context.controller.signal,
          onText: (text) => {
            if (context.controller.signal.aborted || context.terminal) return;
            context.reply += text;
            send(context, "agent:stream-chunk", { text });
          },
        })
        : await llmChat(config, messages, tools, context.controller.signal);
      abortCheck(context);
      if (result.content && context.reply.length === replyLength) {
        context.reply += result.content;
        if (streaming) send(context, "agent:stream-chunk", { text: result.content });
      }
      if (!result.tool_calls?.length) {
        if (!result.content?.trim()) throw new Error("Agent did not return a final response.");
        finalAnswer = true;
        break;
      }
      messages.push({ role: "assistant", content: result.content || "", tool_calls: result.tool_calls });
      for (const call of result.tool_calls) {
        await yieldToIpc();
        abortCheck(context);
        const name = call.function?.name;
        if (typeof name !== "string" || !name) throw new Error("Model returned an invalid tool call.");
        context.currentTool = name;
        context.toolCalls.push({ name, redacted: true });
        send(context, "agent:stream-tool-call", { id: call.id, name, arguments: "{}", redacted: true });
        const startedAt = Date.now();
        let args: Record<string, unknown> = {};
        let result: any;
        let stepError: string | undefined;
        try {
          args = JSON.parse(call.function.arguments || "{}");
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
          result = await executeToolCall(name, args, allowedNames, {
            runId: run.id, webContents: context.owner, signal: context.controller.signal, browserScope: scope,
          });
          stepError = toolError(result);
        } catch (cause) {
          stepError = errorText(cause);
          result = { error: stepError };
        }
        // An already-issued operation can finish after cancellation. Preserve
        // its actual outcome, then check cancellation before any further action.
        const step = persist("Could not save the tool result", () => agentRunRecorder.recordStep(run.id, {
          tool: name, args, result, ok: !stepError, error: stepError, durationMs: Date.now() - startedAt,
        }));
        context.steps.push({ id: step.id, tool: step.tool, ok: step.ok, error: step.error, durationMs: step.durationMs, timestamp: step.timestamp });
        context.currentTool = undefined;
        abortCheck(context);
        // A denied/failed tool is returned to the model for explanation or a
        // permitted recovery. Natural loop completion is not business success;
        // the failed step and unverified outcome remain visible.
        messages.push({ role: "tool", tool_call_id: call.id, call_id: call.id, name,
          content: typeof result === "string" ? result : JSON.stringify(result ?? null) } as LlmMessage);
      }
    }
    if (!finalAnswer) {
      endReason = "round_limit";
      error = reasonMessage(endReason);
    }
  } catch (cause) {
    endReason = context.abortReason || "execution_error";
    error = context.abortReason ? reasonMessage(endReason) : errorText(cause);
    if (cause instanceof PersistenceError) storageError = cause;
  } finally {
    clearTimeout(timer);
  }

  const verification = { status: "unverified" } as const;
  let assistantSaved = false;
  let runSaved = false;
  if (userSaved) {
    const content = error ? (context.reply ? `${context.reply}\n\n${error}` : error) : context.reply;
    try {
      persist("Could not save the final assistant message", () => addMessage(context.conversationId, "assistant", content, context.toolCalls, {
        // The run is the sole persisted authority for its terminal reason.
        // Copying it here before the separate trace commit could leave a
        // permanent 'completed' message beside a failed/interrupted run.
        runId: context.runId, requestId: context.streamId, verification,
      }));
      assistantSaved = true;
    } catch (cause) {
      storageError = cause as PersistenceError;
      endReason = context.abortReason || "execution_error";
      error = errorText(cause);
    }
  }
  if (context.runId) {
    try {
      persist("Could not save the task's final state", () => agentRunRecorder.finishRun(context.runId!, endReason === "completed" ? "done" : "error", error, { endReason, verification }));
      runSaved = true;
    } catch (cause) {
      storageError = cause as PersistenceError;
    } finally {
      agentRunRecorder.releaseRun(context.runId);
    }
  }
  if (storageError) {
    error = storageError.message;
    endReason = context.abortReason || "execution_error";
  }
  return {
    conversationId: context.conversationId, streamId: context.streamId, runId: context.runId,
    reply: context.reply, toolCalls: context.toolCalls,
    status: endReason === "completed" && !storageError ? "done" : "error", endReason, verification,
    persisted: userSaved && assistantSaved && runSaved && !storageError,
    error, ...(storageError ? { code: "PERSISTENCE_ERROR" } : {}),
  };
}
