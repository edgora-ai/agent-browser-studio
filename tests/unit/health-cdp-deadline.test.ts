import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdpEvaluate } from "../../src/main/services/local-agent.js";
import type { CdpClient } from "../../src/main/services/agent/cdp-transport.js";

// The original evaluator and transport run; only the owned wire is a boundary
// fixture. These tests do not claim that a rejected command stopped page JS.
function client(): CdpClient {
  return { ws: { send: vi.fn() }, port: 42001, targetId: "owned-health-page", msgId: 0,
    callbacks: new Map(), pendingMessages: [], interactionSeed: 1, interactionCounter: 0,
    pointerX: null, pointerY: null };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("health explicit CDP deadline uses the original transport", () => {
  it("uses the explicit deadline and removes only its own pending callback", async () => {
    const c = client();
    const evaluation = cdpEvaluate(c, "owned pending expression", 2500);
    const rejected = expect(evaluation).rejects.toThrow("CDP Runtime.evaluate timeout");
    expect(c.callbacks.size).toBe(1);
    expect(JSON.parse(c.ws.send.mock.calls[0][0])).toEqual({ id: 1, method: "Runtime.evaluate", params: {
      expression: "owned pending expression", returnByValue: true, awaitPromise: true,
    } });
    await vi.advanceTimersByTimeAsync(2499); expect(c.callbacks.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1); const pendingAtDeadline = c.callbacks.size;
    // Consume the old command too before asserting, so even the RED has no
    // leaked timer/rejection. The old implementation is still pending at 2500.
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(pendingAtDeadline).toBe(0);
  });
  it("retains the ordinary 15-second default when no deadline was supplied", async () => {
    const c = client(), evaluation = cdpEvaluate(c, "ordinary expression");
    const rejected = expect(evaluation).rejects.toThrow("CDP Runtime.evaluate timeout");
    await vi.advanceTimersByTimeAsync(14_999); expect(c.callbacks.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(c.callbacks.size).toBe(0);
  });
  it("preserves values and page exceptions under an explicit command deadline", async () => {
    const c = client();
    const reply = (id: number, result: unknown) => {
      const callback = c.callbacks.get(id)!;
      clearTimeout(callback.timer); c.callbacks.delete(id); callback.resolve(result);
    };
    const success = cdpEvaluate(c, "native value", 2500);
    reply(1, { result: { value: { actual: "wire value" } } });
    expect(await success).toEqual({ actual: "wire value" });
    const failure = cdpEvaluate(c, "throw new Error('owned page failure')", 2500);
    const rejected = expect(failure).rejects.toThrow("owned page failure");
    reply(2, { exceptionDetails: { exception: { description: "owned page failure" } } });
    await rejected; expect(c.callbacks.size).toBe(0);
  });
  it.each([0, -1, NaN, Infinity, 1.5, 120_001])("rejects invalid deadline %s before dispatch or waiter allocation", async timeoutMs => {
    const c = client();
    await expect(cdpEvaluate(c, "must not dispatch", timeoutMs)).rejects.toThrow("Invalid CDP command timeout");
    expect(c.msgId).toBe(0); expect(c.callbacks.size).toBe(0); expect(c.ws.send).not.toHaveBeenCalled();
  });
});
