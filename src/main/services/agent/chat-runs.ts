import type { WebContents } from "electron";
import type { AgentRunEndReason, AgentRunVerification } from "../../types.js";

export interface ChatRunSnapshot {
  conversationId: string;
  streamId: string;
  runId?: string;
  profileDirId?: string;
  profileName?: string;
  state: "preparing" | "running" | "cancelling";
  startedAt: number;
  reply: string;
  toolCalls: Array<{ name: string; redacted: true }>;
  steps: Array<{ id: string; tool: string; ok: boolean; error?: string; durationMs: number; timestamp: number }>;
  currentTool?: string;
}

export interface ChatTerminal {
  conversationId: string;
  streamId: string;
  runId?: string;
  reply: string;
  toolCalls: ChatRunSnapshot["toolCalls"];
  status: "done" | "error";
  endReason: AgentRunEndReason;
  verification: AgentRunVerification;
  persisted: boolean;
  error?: string;
  code?: string;
}

export interface ChatRunContext extends ChatRunSnapshot {
  owner: WebContents;
  controller: AbortController;
  abortReason?: AgentRunEndReason;
  terminal?: ChatTerminal;
  fingerprint: string;
  completion: Promise<ChatTerminal>;
  resolve: (result: ChatTerminal) => void;
}

export interface ChatCancelRequest {
  conversationId: string;
  runId?: string;
  streamId?: string;
}

export interface ChatCancelResult {
  accepted: boolean;
  state: "cancelling" | "finished" | "not_found";
  runId?: string;
  streamId?: string;
  endReason?: AgentRunEndReason;
}

/** Execution ownership is independent of the retained run/conversation files. */
export class ChatRunRegistry {
  private active = new Map<string, ChatRunContext>();
  // Finished request replays must not keep an idle, later-destroyed window alive.
  private requests = new WeakMap<WebContents, Map<string, ChatRunContext>>();
  private watchers = new Map<WebContents, () => void>();
  private shuttingDown = false;

  reserve(owner: WebContents, input: { conversationId: string; streamId: string; fingerprint: string; profileDirId?: string }):
    | { context: ChatRunContext; fresh: boolean }
    | { code: string; error: string } {
    if (this.shuttingDown || owner.isDestroyed()) return { code: "INTERRUPTED", error: "Desktop chat is shutting down." };
    const existing = this.requests.get(owner)?.get(input.streamId);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) return { code: "REQUEST_CONFLICT", error: "This request ID was already used for different input." };
      return { context: existing, fresh: false };
    }
    if (this.active.has(input.conversationId)) return { code: "BUSY", error: "This conversation already has an active task." };
    let resolve!: ChatRunContext["resolve"];
    const completion = new Promise<ChatTerminal>((done) => { resolve = done; });
    const context: ChatRunContext = {
      ...input,
      owner,
      controller: new AbortController(),
      completion,
      resolve,
      state: "preparing",
      startedAt: Date.now(),
      reply: "",
      toolCalls: [],
      steps: [],
    };
    this.active.set(input.conversationId, context);
    let requests = this.requests.get(owner);
    if (!requests) this.requests.set(owner, requests = new Map());
    requests.set(input.streamId, context);
    if (!this.watchers.has(owner)) {
      const interrupt = () => this.interruptOwner(owner);
      this.watchers.set(owner, interrupt);
      owner.on("destroyed", interrupt);
      owner.on("render-process-gone", interrupt);
    }
    return { context, fresh: true };
  }

  hasActive(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  snapshot(owner: WebContents, conversationId: string): ChatRunSnapshot | null {
    const context = this.active.get(conversationId);
    if (!context || context.owner !== owner || context.terminal) return null;
    const { streamId, runId, profileDirId, profileName, state, startedAt, reply, toolCalls, steps, currentTool } = context;
    return { conversationId, streamId, runId, profileDirId, profileName, state, startedAt, reply,
      toolCalls: toolCalls.map((call) => ({ ...call })), steps: steps.map((step) => ({ ...step })), currentTool };
  }

  cancel(owner: WebContents, input: ChatCancelRequest): ChatCancelResult {
    const matches = (context: ChatRunContext) => context.owner === owner
      && context.conversationId === input.conversationId
      && (!input.runId || context.runId === input.runId)
      && (!input.streamId || context.streamId === input.streamId);
    const live = this.active.get(input.conversationId);
    if (live && matches(live) && !live.terminal) {
      this.abort(live, "user_cancelled");
      return { accepted: true, state: "cancelling", runId: live.runId, streamId: live.streamId, endReason: live.abortReason };
    }
    // A late cancel is only resolved by exact identity. It must never select a
    // newer task merely because the same conversation has since been reused.
    if (input.runId || input.streamId) {
      const finished = [...(this.requests.get(owner)?.values() || [])].find((context) => context.terminal && matches(context));
      if (finished) return { accepted: false, state: "finished", runId: finished.runId, streamId: finished.streamId, endReason: finished.terminal!.endReason };
    }
    return { accepted: false, state: "not_found" };
  }

  abort(context: ChatRunContext, reason: AgentRunEndReason): void {
    if (context.terminal || context.controller.signal.aborted) return;
    context.abortReason = reason;
    context.state = "cancelling";
    context.controller.abort(new Error(`Agent chat ${reason}`));
  }

  interruptOwner(owner: WebContents): void {
    for (const context of this.active.values()) {
      if (context.owner === owner) this.abort(context, "interrupted");
    }
  }

  finish(context: ChatRunContext, result: ChatTerminal): void {
    context.terminal = result;
    if (this.active.get(context.conversationId) === context) this.active.delete(context.conversationId);
    context.resolve(result);
    if (![...this.active.values()].some((run) => run.owner === context.owner)) {
      const listener = this.watchers.get(context.owner);
      if (listener) {
        context.owner.removeListener("destroyed", listener);
        context.owner.removeListener("render-process-gone", listener);
        this.watchers.delete(context.owner);
      }
    }
    const requests = this.requests.get(context.owner);
    if (context.owner.isDestroyed()) {
      for (const [id, run] of requests || []) if (run.terminal) requests!.delete(id);
      if (!requests?.size) this.requests.delete(context.owner);
    } else if (requests) {
      // Older request identities are also checked in persisted conversation
      // messages before executing. The in-memory replay cache stays bounded.
      for (const [id, run] of requests) {
        if (requests.size <= 200) break;
        if (run.terminal) requests.delete(id);
      }
    }
  }

  async shutdown(timeoutMs = 17_000): Promise<{ unfinished: number }> {
    this.shuttingDown = true;
    const runs = [...this.active.values()];
    for (const run of runs) this.abort(run, "interrupted");
    if (!runs.length) return { unfinished: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(runs.map((run) => run.completion)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { unfinished: runs.filter((run) => !run.terminal).length };
  }
}

export const desktopChatRuns = new ChatRunRegistry();
