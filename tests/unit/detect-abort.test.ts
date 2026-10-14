// R13 P3-2: detectors honor the caller's AbortSignal so a withTimeout
// actually stops the work instead of relying on inner curl timers.
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No real child, config file, app config, or network operation is allowed here.
const effects = vi.hoisted(() => ({
  files: new Map<string, string>(),
  spawn: vi.fn(),
  write: vi.fn(),
  unlink: vi.fn(),
  getConfig: vi.fn(() => { throw new Error("Unexpected app config access"); }),
}));
vi.mock("node:child_process", () => ({
  spawn: effects.spawn,
  execFileSync: () => { throw new Error("Unexpected subprocess execution"); },
}));
vi.mock("node:fs", () => ({ writeFileSync: effects.write, unlinkSync: effects.unlink }));
vi.mock("node:os", () => ({ tmpdir: () => "/offline-proxy-fixture" }));
vi.mock("node:net", async (importOriginal) => {
  const { isIP } = await importOriginal<typeof import("node:net")>();
  return { isIP, connect: () => { throw new Error("Unexpected network access"); } };
});
vi.mock("../../src/main/services/config-manager.js", () => ({ getConfig: effects.getConfig }));
import { proxyDetector } from "../../src/main/services/proxy-detector.js";
import { webrtcDetector } from "../../src/main/services/webrtc-detector.js";

const PROXY = { type: "http", host: "127.0.0.1", port: 19_877 } as any;

function makeInertChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return Object.assign(child, {
    kill: vi.fn((_signal?: string) => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    }),
  });
}
let inertChild: ReturnType<typeof makeInertChild>;

beforeEach(() => {
  vi.clearAllMocks();
  effects.files.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  inertChild = makeInertChild();
  effects.spawn.mockImplementation(() => inertChild);
  effects.write.mockImplementation((file: string, contents: string) => {
    expect(file.startsWith("/offline-proxy-fixture/agent-browser-proxy-")).toBe(true);
    effects.files.set(file, contents);
  });
  effects.unlink.mockImplementation((file: string) => {
    expect(effects.files.has(file)).toBe(true);
    effects.files.delete(file);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("detector abort (R13 P3-2)", () => {
  it("proxyDetector.detect rejects promptly on a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await proxyDetector.detect(PROXY, { signal: controller.signal });
    expect(r.success).toBe(false);
    expect(String(r.error || "")).toMatch(/abort/i);
  });

  it("webrtcDetector.detect fails fast on a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await webrtcDetector.detect(PROXY, { signal: controller.signal });
    expect(r.success).toBe(false);
    expect(String(r.error || "")).toMatch(/abort/i);
  });

  it("proxyDetector.ping reports aborted instead of hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const r = await proxyDetector.ping(PROXY, { signal: controller.signal });
    expect(r.success).toBe(false);
    expect(String(r.error || "")).toMatch(/abort/i);
    expect(r).toEqual({ success: false, latencyMs: null, error: "aborted" });
    expect(effects.spawn).not.toHaveBeenCalled();
    expect(effects.write).not.toHaveBeenCalled();
    expect(effects.unlink).not.toHaveBeenCalled();
    expect(inertChild.kill).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();
    expect(effects.getConfig).not.toHaveBeenCalled();
    expect(effects.files.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("proxyDetector.ping retains successful child completion and cleanup", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const pending = proxyDetector.ping(PROXY, { signal: controller.signal });
    expect(effects.spawn).toHaveBeenCalledTimes(1);
    expect(effects.spawn.mock.calls[0][0]).toBe("curl");
    expect(effects.write).toHaveBeenCalledTimes(1);
    expect(effects.write.mock.calls[0][2]).toEqual({ encoding: "utf-8", mode: 0o600 });
    expect(effects.files.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    inertChild.stdout.emit("data", "200");
    inertChild.emit("close", 0);
    const r = await pending;
    expect(r.success).toBe(true);
    expect(r.error).toBeNull();
    expect(r.latencyMs).toEqual(expect.any(Number));
    expect(inertChild.kill).not.toHaveBeenCalled();
    expect(effects.unlink).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(effects.files.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(effects.getConfig).not.toHaveBeenCalled();
  });

  it("proxyDetector.ping kills an in-flight child and cleans up on abort", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const pending = proxyDetector.ping(PROXY, { signal: controller.signal });
    expect(effects.spawn).toHaveBeenCalledTimes(1);
    expect(effects.write).toHaveBeenCalledTimes(1);
    expect(effects.files.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    const r = await pending;
    expect(r).toEqual({ success: false, latencyMs: null, error: "aborted" });
    expect(inertChild.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(effects.unlink).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(effects.files.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(effects.getConfig).not.toHaveBeenCalled();
  });
});
