// R13 P3-2: detectors honor the caller's AbortSignal so a withTimeout
// actually stops the work instead of relying on inner curl timers.
import { describe, it, expect } from "vitest";
import { proxyDetector } from "../../src/main/services/proxy-detector.js";
import { webrtcDetector } from "../../src/main/services/webrtc-detector.js";

const PROXY = { type: "http", host: "127.0.0.1", port: 19_877 } as any;

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
    const r = await proxyDetector.ping(PROXY, { signal: controller.signal });
    expect(r.success).toBe(false);
    expect(String(r.error || "")).toMatch(/abort/i);
  });
});
