import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatRunRegistry,
  type ChatRunContext,
  type ChatTerminal,
} from "../../src/main/services/agent/chat-runs.js";
import type { AgentRunEndReason } from "../../src/main/types.js";

let nextOwnerId = 0;

class MockWebContents extends EventEmitter {
  readonly id = ++nextOwnerId;
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(): void {}

  hide(): void {
    this.emit("hide");
  }

  destroyOwner(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }

  crashOwner(): void {
    this.emit("render-process-gone", {}, { reason: "crashed" });
  }
}

function reserve(
  registry: ChatRunRegistry,
  owner: MockWebContents,
  input: { conversationId: string; streamId: string; fingerprint: string; profileDirId?: string },
): { context: ChatRunContext; fresh: boolean } {
  const result = registry.reserve(owner as any, input);
  expect(result).toHaveProperty("context");
  if (!("context" in result)) throw new Error(`Reservation failed: ${result.code}`);
  return result;
}

function terminal(context: ChatRunContext, endReason: AgentRunEndReason = "completed"): ChatTerminal {
  return {
    conversationId: context.conversationId,
    streamId: context.streamId,
    runId: context.runId,
    reply: context.reply,
    toolCalls: context.toolCalls.map((call) => ({ ...call })),
    status: endReason === "completed" ? "done" : "error",
    endReason,
    verification: { status: "unverified" },
    persisted: true,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatRunRegistry lifecycle", () => {
  it("replays the same owner/request identity and rejects conflicting reuse", async () => {
    const registry = new ChatRunRegistry();
    const owner = new MockWebContents();
    const input = { conversationId: "conv_replay", streamId: "request_1", fingerprint: "same-input" };

    const first = reserve(registry, owner, input);
    const replay = reserve(registry, owner, input);
    expect(first.fresh).toBe(true);
    expect(replay.fresh).toBe(false);
    expect(replay.context).toBe(first.context);
    expect(owner.listenerCount("destroyed")).toBe(1);
    expect(owner.listenerCount("render-process-gone")).toBe(1);

    expect(registry.reserve(owner as any, { ...input, fingerprint: "changed-input" })).toMatchObject({
      code: "REQUEST_CONFLICT",
    });

    const result = terminal(first.context);
    registry.finish(first.context, result);
    await expect(first.context.completion).resolves.toEqual(result);
    const finishedReplay = reserve(registry, owner, input);
    expect(finishedReplay).toEqual({ context: first.context, fresh: false });
    expect(registry.reserve(owner as any, { ...input, fingerprint: "changed-again" })).toMatchObject({
      code: "REQUEST_CONFLICT",
    });
  });

  it("locks a conversation globally while snapshots and cancellation remain owner-scoped", () => {
    const registry = new ChatRunRegistry();
    const owner = new MockWebContents();
    const foreign = new MockWebContents();
    const { context } = reserve(registry, owner, {
      conversationId: "conv_owned",
      streamId: "owned_stream",
      fingerprint: "owned",
    });
    context.runId = "run_owned";

    expect(registry.reserve(foreign as any, {
      conversationId: context.conversationId,
      streamId: "foreign_stream",
      fingerprint: "foreign",
    })).toMatchObject({ code: "BUSY" });
    expect(registry.snapshot(owner as any, context.conversationId)).toMatchObject({
      conversationId: context.conversationId,
      streamId: context.streamId,
      runId: context.runId,
    });
    expect(registry.snapshot(foreign as any, context.conversationId)).toBeNull();
    expect(registry.cancel(foreign as any, {
      conversationId: context.conversationId,
      runId: context.runId,
      streamId: context.streamId,
    })).toEqual({ accepted: false, state: "not_found" });
    expect(context.controller.signal.aborted).toBe(false);

    expect(registry.cancel(owner as any, {
      conversationId: context.conversationId,
      runId: context.runId,
      streamId: context.streamId,
    })).toMatchObject({ accepted: true, state: "cancelling", endReason: "user_cancelled" });
    registry.finish(context, terminal(context, "user_cancelled"));
  });

  it("requires every supplied run and stream identity to match exactly", () => {
    const registry = new ChatRunRegistry();
    const owner = new MockWebContents();
    const { context } = reserve(registry, owner, {
      conversationId: "conv_exact",
      streamId: "stream_exact",
      fingerprint: "exact",
    });
    context.runId = "run_exact";

    expect(registry.cancel(owner as any, {
      conversationId: context.conversationId,
      runId: "run_wrong",
      streamId: context.streamId,
    })).toEqual({ accepted: false, state: "not_found" });
    expect(registry.cancel(owner as any, {
      conversationId: context.conversationId,
      runId: context.runId,
      streamId: "stream_wrong",
    })).toEqual({ accepted: false, state: "not_found" });
    expect(context.controller.signal.aborted).toBe(false);

    expect(registry.cancel(owner as any, {
      conversationId: context.conversationId,
      runId: context.runId,
      streamId: context.streamId,
    })).toMatchObject({
      accepted: true,
      state: "cancelling",
      runId: context.runId,
      streamId: context.streamId,
    });
    expect(context.controller.signal.aborted).toBe(true);
    registry.finish(context, terminal(context, "user_cancelled"));
  });

  it("handles duplicate and late cancellation without targeting a newer run", () => {
    const registry = new ChatRunRegistry();
    const owner = new MockWebContents();
    const old = reserve(registry, owner, {
      conversationId: "conv_reused",
      streamId: "stream_old",
      fingerprint: "old",
    }).context;
    old.runId = "run_old";
    const oldIdentity = { conversationId: old.conversationId, runId: old.runId, streamId: old.streamId };

    expect(registry.cancel(owner as any, oldIdentity)).toMatchObject({ accepted: true, state: "cancelling" });
    expect(registry.cancel(owner as any, oldIdentity)).toMatchObject({ accepted: true, state: "cancelling" });
    expect(old.abortReason).toBe("user_cancelled");
    registry.finish(old, terminal(old, "user_cancelled"));
    expect(registry.cancel(owner as any, oldIdentity)).toMatchObject({
      accepted: false,
      state: "finished",
      endReason: "user_cancelled",
    });

    const current = reserve(registry, owner, {
      conversationId: old.conversationId,
      streamId: "stream_current",
      fingerprint: "current",
    }).context;
    current.runId = "run_current";

    expect(registry.cancel(owner as any, oldIdentity)).toMatchObject({
      accepted: false,
      state: "finished",
      runId: old.runId,
      streamId: old.streamId,
    });
    expect(registry.cancel(owner as any, {
      conversationId: current.conversationId,
      runId: old.runId,
      streamId: current.streamId,
    })).toEqual({ accepted: false, state: "not_found" });
    expect(current.controller.signal.aborted).toBe(false);
    expect(registry.snapshot(owner as any, current.conversationId)?.runId).toBe(current.runId);
    registry.finish(current, terminal(current));
  });

  it("interrupts destroyed and crashed owners but ignores window hiding", () => {
    const registry = new ChatRunRegistry();
    const hiddenOwner = new MockWebContents();
    const destroyedOwner = new MockWebContents();
    const crashedOwner = new MockWebContents();
    const hidden = reserve(registry, hiddenOwner, {
      conversationId: "conv_hidden",
      streamId: "stream_hidden",
      fingerprint: "hidden",
    }).context;
    const destroyed = reserve(registry, destroyedOwner, {
      conversationId: "conv_destroyed",
      streamId: "stream_destroyed",
      fingerprint: "destroyed",
    }).context;
    const crashed = reserve(registry, crashedOwner, {
      conversationId: "conv_crashed",
      streamId: "stream_crashed",
      fingerprint: "crashed",
    }).context;

    hiddenOwner.hide();
    expect(hidden.controller.signal.aborted).toBe(false);
    expect(registry.hasActive(hidden.conversationId)).toBe(true);
    expect(registry.snapshot(hiddenOwner as any, hidden.conversationId)).not.toBeNull();

    destroyedOwner.destroyOwner();
    crashedOwner.crashOwner();
    for (const context of [destroyed, crashed]) {
      expect(context.controller.signal.aborted).toBe(true);
      expect(context.abortReason).toBe("interrupted");
      expect(context.state).toBe("cancelling");
    }
    expect(hidden.controller.signal.aborted).toBe(false);

    registry.finish(hidden, terminal(hidden));
    registry.finish(destroyed, terminal(destroyed, "interrupted"));
    registry.finish(crashed, terminal(crashed, "interrupted"));
  });

  it("keeps concurrent conversations and owners independent", () => {
    const registry = new ChatRunRegistry();
    const firstOwner = new MockWebContents();
    const secondOwner = new MockWebContents();
    const first = reserve(registry, firstOwner, {
      conversationId: "conv_parallel_a",
      streamId: "shared_stream",
      fingerprint: "parallel-a",
    }).context;
    const sibling = reserve(registry, firstOwner, {
      conversationId: "conv_parallel_b",
      streamId: "sibling_stream",
      fingerprint: "parallel-b",
    }).context;
    const foreign = reserve(registry, secondOwner, {
      conversationId: "conv_parallel_c",
      streamId: "shared_stream",
      fingerprint: "parallel-c",
    }).context;

    expect(firstOwner.listenerCount("destroyed")).toBe(1);
    expect(registry.hasActive(first.conversationId)).toBe(true);
    expect(registry.hasActive(sibling.conversationId)).toBe(true);
    expect(registry.hasActive(foreign.conversationId)).toBe(true);

    registry.abort(first, "user_cancelled");
    expect(first.controller.signal.aborted).toBe(true);
    expect(sibling.controller.signal.aborted).toBe(false);
    expect(foreign.controller.signal.aborted).toBe(false);
    expect(registry.snapshot(firstOwner as any, sibling.conversationId)?.streamId).toBe(sibling.streamId);
    expect(registry.snapshot(secondOwner as any, foreign.conversationId)?.streamId).toBe(foreign.streamId);

    registry.finish(first, terminal(first, "user_cancelled"));
    registry.finish(sibling, terminal(sibling));
    registry.finish(foreign, terminal(foreign));
  });

  it("removes owner lifecycle listeners only after the owner's final run finishes", () => {
    const registry = new ChatRunRegistry();
    const owner = new MockWebContents();
    const first = reserve(registry, owner, {
      conversationId: "conv_listener_a",
      streamId: "listener_a",
      fingerprint: "listener-a",
    }).context;
    const second = reserve(registry, owner, {
      conversationId: "conv_listener_b",
      streamId: "listener_b",
      fingerprint: "listener-b",
    }).context;

    expect(owner.listenerCount("destroyed")).toBe(1);
    expect(owner.listenerCount("render-process-gone")).toBe(1);
    registry.finish(first, terminal(first));
    expect(owner.listenerCount("destroyed")).toBe(1);
    expect(owner.listenerCount("render-process-gone")).toBe(1);

    registry.finish(second, terminal(second));
    expect(owner.listenerCount("destroyed")).toBe(0);
    expect(owner.listenerCount("render-process-gone")).toBe(0);
    expect(registry.hasActive(first.conversationId)).toBe(false);
    expect(registry.hasActive(second.conversationId)).toBe(false);
  });

  it("bounds shutdown, aborts immediately, reports unfinished runs, and rejects new work", async () => {
    vi.useFakeTimers();
    const registry = new ChatRunRegistry();
    const owner = new MockWebContents();
    const first = reserve(registry, owner, {
      conversationId: "conv_shutdown_a",
      streamId: "shutdown_a",
      fingerprint: "shutdown-a",
    }).context;
    const unfinished = reserve(registry, owner, {
      conversationId: "conv_shutdown_b",
      streamId: "shutdown_b",
      fingerprint: "shutdown-b",
    }).context;

    const shutdown = registry.shutdown(50);
    for (const context of [first, unfinished]) {
      expect(context.controller.signal.aborted).toBe(true);
      expect(context.abortReason).toBe("interrupted");
      expect(context.state).toBe("cancelling");
    }
    expect(registry.reserve(new MockWebContents() as any, {
      conversationId: "conv_after_shutdown",
      streamId: "after_shutdown",
      fingerprint: "after-shutdown",
    })).toMatchObject({ code: "INTERRUPTED" });

    registry.finish(first, terminal(first, "interrupted"));
    let settled = false;
    void shutdown.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(shutdown).resolves.toEqual({ unfinished: 1 });
    expect(registry.hasActive(first.conversationId)).toBe(false);
    expect(registry.hasActive(unfinished.conversationId)).toBe(true);

    registry.finish(unfinished, terminal(unfinished, "interrupted"));
    expect(registry.reserve(new MockWebContents() as any, {
      conversationId: "conv_still_closed",
      streamId: "still_closed",
      fingerprint: "still-closed",
    })).toMatchObject({ code: "INTERRUPTED" });
  });
});
