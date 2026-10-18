import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: { browserProfiles: { ab_health_page: { engine: "firefox" } } },
  connect: vi.fn(), evaluate: vi.fn(), close: vi.fn(),
  registered: vi.fn(), context: vi.fn(), bidiEvaluate: vi.fn(), navigate: vi.fn(),
}));
vi.mock("../../src/main/services/config-manager.js", () => ({ getConfig: () => h.config }));
vi.mock("../../src/main/services/local-agent.js", () => ({ cdpConnect: h.connect, cdpEvaluate: h.evaluate }));
vi.mock("../../src/main/services/bidi-client.js", () => ({
  connectBidi: vi.fn(() => { throw new Error("Unexpected independent BiDi session"); }),
  getRegisteredFirefoxSession: h.registered, bidiGetTopContext: h.context,
  bidiEvaluateInContext: h.bidiEvaluate, bidiNavigate: h.navigate,
}));
import { evaluateInPage, getProfileEngineByDirId } from "../../src/main/services/page-eval.js";
import { clearEntry, setEntry } from "../../src/main/services/browser/runtime-table.js";

const ID = "ab_health_page";
beforeEach(() => {
  clearEntry(ID); vi.resetAllMocks();
  h.config.browserProfiles[ID].engine = "firefox";
  h.connect.mockResolvedValue({ ws: { close: h.close } });
  h.evaluate.mockResolvedValue("native-boundary-result");
});
afterEach(() => { clearEntry(ID); });

describe("health uses the actual running engine, not edited launch intent", () => {
  it("retains Chromium dispatch when saved intent was changed to Firefox without restart", () => {
    setEntry(ID, { pid: 123, process: null, port: 42001, lastActivityAt: 1, engine: "chromium" });
    expect(getProfileEngineByDirId(ID)).toBe("chromium");
  });
  it("retains Firefox dispatch when saved intent was changed to Chromium without restart", () => {
    h.config.browserProfiles[ID].engine = "chromium";
    setEntry(ID, { pid: 123, process: null, port: 42001, lastActivityAt: 1, engine: "firefox" });
    expect(getProfileEngineByDirId(ID)).toBe("firefox");
  });
  it("recognizes a legacy adopted Chromium entry without inventing a Firefox session", () => {
    setEntry(ID, { pid: 123, process: null, port: 42001, lastActivityAt: 1 });
    expect(getProfileEngineByDirId(ID)).toBe("chromium");
  });
  it("uses declared intent only when there is no running entry", () => {
    expect(getProfileEngineByDirId(ID)).toBe("firefox");
  });
});

describe("real page evaluator cancellation and connection ownership", () => {
  it("forwards the caller's explicit Chromium command deadline rather than discarding it", async () => {
    expect(await evaluateInPage(42001, "chromium", "owned expression", { timeoutMs: 2500 })).toBe("native-boundary-result");
    expect(h.evaluate).toHaveBeenCalledWith(expect.anything(), "owned expression", 2500);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it("waits for underlying Chromium evaluation to settle before cleanup and cancellation", async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    h.evaluate.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const operation = evaluateInPage(42001, "chromium", "owned expression", { signal: controller.signal });
    const rejected = expect(operation).rejects.toThrow(/abort|cancel/i);
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(h.close).not.toHaveBeenCalled();
    finish("late native-boundary result"); await rejected;
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it("does not connect after cancellation was already requested", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(evaluateInPage(42001, "chromium", "owned expression", { signal: controller.signal })).rejects.toThrow(/abort|cancel/i);
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("surfaces owned Chromium connection cleanup failure rather than claiming success", async () => {
    h.close.mockImplementation(() => { throw new Error("owned cleanup failure"); });
    await expect(evaluateInPage(42001, "chromium", "owned expression")).rejects.toThrow("In-page connection cleanup failed");
  });
  it("reuses and never closes the real registered Firefox session boundary", async () => {
    const live = { close: vi.fn() }; h.registered.mockReturnValue(live);
    h.context.mockResolvedValue("owned-context"); h.bidiEvaluate.mockResolvedValue("owned Firefox value");
    expect(await evaluateInPage(42002, "firefox", "owned expression", { timeoutMs: 1500 })).toBe("owned Firefox value");
    expect(h.bidiEvaluate).toHaveBeenCalledWith(live, "owned expression", "owned-context", 1500);
    expect(live.close).not.toHaveBeenCalled(); expect(h.navigate).not.toHaveBeenCalled();
  });
});
