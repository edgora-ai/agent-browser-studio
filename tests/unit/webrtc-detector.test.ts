import { describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ spawn: vi.fn(() => { throw new Error("Legacy WebRTC endpoint must not issue HTTP probes"); }) }));
vi.mock("node:child_process", () => ({ spawn: h.spawn }));
vi.mock("../../src/main/services/main-i18n.js", () => ({ tMain: (_key: string, fallback: string) => fallback }));
import { webrtcDetector } from "../../src/main/services/webrtc-detector.js";

const proxy = { type: "http" as const, host: "proxy.invalid", port: 1234, username: "PRIVATE-USERNAME", password: "PRIVATE-PASSWORD" };

describe("legacy proxy-only WebRTC request cannot claim a browser or UDP measurement", () => {
  it("requires a real browser profile instead of treating HTTP IP lookups as STUN", async () => {
    const result = await webrtcDetector.detect(proxy);
    expect(result).toMatchObject({ success: false, outcome: "unavailable", code: "BROWSER_PROFILE_REQUIRED", hasLeak: null,
      webRtcIps: [], stunIps: [], dnsLeakIps: [] });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|proxy\.invalid|No leaks detected/);
  });
  it("keeps cancellation explicit without dispatching or guessing no leak", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await webrtcDetector.detect(proxy, { signal: controller.signal })).toMatchObject({ success: false, outcome: "cancelled", code: "HEALTH_CANCELLED", error: "aborted", hasLeak: null });
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
