import { describe, expect, it } from "vitest";
import {
  cdpClick,
  cdpPressKey,
  cdpScroll,
  cdpType,
  type CdpClient,
} from "../../src/main/services/local-agent.js";

interface CdpCall {
  method: string;
  params?: Record<string, any>;
}

function fakeClient(seed = 424242): { client: CdpClient; calls: CdpCall[] } {
  const calls: CdpCall[] = [];
  let typedValue = "old";
  let scrollY = 0;
  let client: CdpClient;
  const ws = {
    send(raw: string) {
      const message = JSON.parse(raw) as { id: number; method: string; params?: Record<string, any> };
      calls.push({ method: message.method, params: message.params });
      queueMicrotask(() => {
        const callback = client.callbacks.get(message.id);
        if (!callback) return;
        client.callbacks.delete(message.id);
        clearTimeout(callback.timer);

        if (message.method === "Input.dispatchKeyEvent") {
          if (message.params?.commands?.includes("SelectAll")) typedValue = "";
          if (message.params?.type === "char" && message.params?.text) typedValue += String(message.params.text);
          callback.resolve({});
          return;
        }
        if (message.method === "Input.insertText") {
          typedValue += String(message.params?.text || "");
          callback.resolve({});
          return;
        }
        if (message.method === "Input.dispatchMouseEvent" && message.params?.type === "mouseWheel") {
          scrollY += Number(message.params.deltaY || 0);
          callback.resolve({});
          return;
        }
        if (message.method === "Page.getLayoutMetrics") {
          callback.resolve({
            cssLayoutViewport: { pageY: scrollY, clientHeight: 800 },
            cssContentSize: { height: 3000 },
          });
          return;
        }
        if (message.method === "Runtime.evaluate") {
          const expression = String(message.params?.expression || "");
          if (expression.includes("resolveSelector")) {
            callback.resolve({ result: { value: { x: 400, y: 260, width: 80, height: 32 } } });
          } else if (expression.includes("__NOT_FOUND__")) {
            callback.resolve({ result: { value: "INPUT" } });
          } else if (expression.includes("var v=")) {
            callback.resolve({ result: { value: typedValue } });
          } else {
            callback.resolve({ result: { value: true } });
          }
          return;
        }
        callback.resolve({});
      });
    },
  };
  client = {
    ws,
    port: 9222,
    msgId: 0,
    callbacks: new Map(),
    pendingMessages: [],
    interactionSeed: seed,
    interactionCounter: 0,
    pointerX: null,
    pointerY: null,
  };
  return { client, calls };
}

describe("local agent native humanized input", () => {
  it("moves over a bounded curve before a delayed native click", async () => {
    const { client, calls } = fakeClient();
    const result = await cdpClick(client, "#buy");
    const mouse = calls.filter((call) => call.method === "Input.dispatchMouseEvent");
    const moves = mouse.filter((call) => call.params?.type === "mouseMoved");
    expect(moves.length).toBeGreaterThanOrEqual(8);
    expect(mouse.at(-2)?.params?.type).toBe("mousePressed");
    expect(mouse.at(-1)?.params?.type).toBe("mouseReleased");
    expect(mouse.at(-2)?.params?.x).toBe(result.x);
    expect(mouse.at(-2)?.params?.y).toBe(result.y);
    expect(new Set(moves.map((call) => `${call.params?.x},${call.params?.y}`)).size).toBeGreaterThan(5);
  });

  it("clears and types through trusted native Input operations", async () => {
    const { client, calls } = fakeClient();
    const result = await cdpType(client, "#name", "hello");
    expect(result).toMatchObject({ success: true, length: 5 });
    expect(calls.some((call) => call.method === "Input.dispatchKeyEvent" && call.params?.commands?.includes("SelectAll"))).toBe(true);
    expect(calls.filter((call) => call.method === "Input.dispatchKeyEvent" && call.params?.type === "char").map((call) => call.params?.text).join("")).toBe("hello");
    expect(calls.filter((call) => call.method === "Input.dispatchKeyEvent" && call.params?.type === "rawKeyDown").length).toBeGreaterThanOrEqual(6);
    expect(calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression).includes("dispatchEvent(new Event('change'"))).toBe(false);
  });

  it("scrolls with a multi-step native wheel gesture whose deltas sum exactly", async () => {
    const { client, calls } = fakeClient();
    const result = await cdpScroll(client, "down", 731);
    const wheel = calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mouseWheel");
    expect(result.native).toBe(true);
    expect(wheel.length).toBeGreaterThanOrEqual(5);
    expect(wheel.reduce((sum, call) => sum + Number(call.params?.deltaY), 0)).toBe(731);
    expect(result.settled).toBe(true);
    expect(calls.some((call) => call.method === "Runtime.evaluate")).toBe(false);
  });

  it("does not append an untrusted DOM keyboard event after native key success", async () => {
    const { client, calls } = fakeClient();
    const result = await cdpPressKey(client, "Enter");
    expect(result.native).toBe(true);
    expect(calls.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => call.params?.type))
      .toEqual(["rawKeyDown", "char", "keyUp"]);
    expect(calls.some((call) => call.method === "Runtime.evaluate")).toBe(false);
  });
});
