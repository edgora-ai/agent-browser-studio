import { EventEmitter } from "node:events";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../../src/main/types.js";

// Real detector orchestration and cache, but no process, app data or network.
const effects = vi.hoisted(() => ({
  spawn: vi.fn(), files: new Map<string, string>(), write: vi.fn(), unlink: vi.fn(),
  tmp: process.env.TMPDIR + "/inert-proxy-observation",
}));
vi.mock("node:child_process", () => ({
  spawn: effects.spawn,
  execFileSync: () => { throw new Error("Unexpected subprocess execution"); },
}));
vi.mock("node:fs", () => ({ writeFileSync: effects.write, unlinkSync: effects.unlink }));
vi.mock("node:os", () => ({ tmpdir: () => effects.tmp, hostname: () => "inert-proxy-fixture", homedir: () => effects.tmp }));
vi.mock("node:dns", () => ({ lookup: () => { throw new Error("Unexpected DNS access"); } }));
vi.mock("node:dns/promises", () => ({ lookup: () => { throw new Error("Unexpected DNS access"); }, resolve: () => { throw new Error("Unexpected DNS access"); } }));
vi.mock("node:net", async (original) => {
  const { isIP } = await original<typeof import("node:net")>();
  return { isIP, connect: () => { throw new Error("Unexpected network access"); } };
});
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => { throw new Error("Unexpected app configuration access"); },
}));
import {
  cachedProxyDetectionForTests, proxyDetectionObservedAt, proxyDetector,
  resetProxyDetectionCacheForTests,
} from "../../src/main/services/proxy-detector.js";

const PROXY: ProxyConfig = { type: "http", host: "fixture-proxy.invalid", port: 21987, username: "synthetic-route", password: "synthetic-password" };
const START = Date.parse("2026-10-19T00:00:00Z");
type Child = ReturnType<typeof child>;
const children: Array<{ child: Child; args: string[] }> = [];
function child() {
  const value = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  return Object.assign(value, { kill: vi.fn(() => value.emit("close", -1)) });
}
function probe(policy: "prefer-cache" | "refresh" = "prefer-cache", signal?: AbortSignal) {
  const offset = children.length;
  const pending = proxyDetector.detect(PROXY, { cachePolicy: policy, ...(signal ? { signal } : {}) } as any);
  return { pending, children: children.slice(offset) };
}
function reply(batch: ReturnType<typeof probe>, ip: string | null) {
  for (const { child: current, args } of batch.children) {
    if (!ip) {
      current.stderr.emit("data", "synthetic connection refused");
      current.emit("close", 7);
      continue;
    }
    const url = args.at(-1)!;
    const data = url.startsWith("https://ipwho.is/")
      ? { success: true, ip, country: "United States", country_code: "US", timezone: { id: "America/New_York" } }
      : url.startsWith("https://ipapi.co/")
        ? { ip, country_name: "United States", country_code: "US", timezone: "America/New_York" }
        : { status: "success", query: ip, country: "United States", countryCode: "US", timezone: "America/New_York" };
    current.stdout.emit("data", JSON.stringify(data));
    current.emit("close", 0);
  }
}
async function warm() {
  const request = probe();
  expect(request.children).toHaveLength(3);
  reply(request, "192.0.2.10");
  return request.pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  children.length = 0;
  effects.files.clear();
  resetProxyDetectionCacheForTests();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(START);
  effects.spawn.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe("curl");
    for (const arg of args) {
      expect(arg).not.toContain(PROXY.username);
      expect(arg).not.toContain(PROXY.password);
    }
    const current = child();
    children.push({ child: current, args });
    return current;
  });
  effects.write.mockImplementation((file: string, text: string, options: unknown) => {
    expect(path.dirname(file)).toBe(path.normalize(effects.tmp));
    expect(options).toEqual({ encoding: "utf-8", mode: 0o600 });
    effects.files.set(file, text);
  });
  effects.unlink.mockImplementation((file: string) => { effects.files.delete(file); });
});
afterEach(() => {
  try {
    expect(effects.files.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    resetProxyDetectionCacheForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("proxy observation freshness and cache publication", () => {
  it("preserves default warm-cache reuse without renewing measurement time", async () => {
    const first = await warm();
    const measuredAt = proxyDetectionObservedAt(first);
    vi.setSystemTime(START + 9 * 60_000);
    const cached = await probe().pending;
    expect(children).toHaveLength(3);
    expect(cached.exitIp).toBe("192.0.2.10");
    expect(proxyDetectionObservedAt(cached)).toBe(measuredAt);
  });

  it("returns detached cache copies with serializable original observation metadata", async () => {
    const first = await warm();
    vi.setSystemTime(START + 60_000);
    const cached: any = await probe().pending;
    expect(cached).not.toBe(first);
    expect(first).toMatchObject({ observedAt: START, source: "network", observationId: expect.any(String) });
    expect(cached).toMatchObject({ observedAt: START, source: "cache", observationId: (first as any).observationId });
    const transported = structuredClone(cached);
    expect(proxyDetectionObservedAt(transported)).toBe(START);
    cached.exitIp = "198.51.100.250";
    first.timezone = "Europe/Berlin";
    expect(await probe().pending).toMatchObject({ exitIp: "192.0.2.10", timezone: "America/New_York", source: "cache" });
  });

  it("refresh bypasses an existing successful cache entry", async () => {
    await warm();
    vi.setSystemTime(START + 60_000);
    const fresh = probe("refresh");
    reply(fresh, "198.51.100.20");
    const result: any = await fresh.pending;
    expect(fresh.children).toHaveLength(3);
    expect(result).toMatchObject({ success: true, exitIp: "198.51.100.20", observedAt: START + 60_000, source: "network" });
    expect(await probe().pending).toMatchObject({ exitIp: "198.51.100.20", observedAt: START + 60_000, source: "cache" });
  });

  it("a failed refresh cannot fall back to the old successful cache", async () => {
    await warm();
    vi.setSystemTime(START + 60_000);
    const fresh = probe("refresh");
    reply(fresh, null);
    const result: any = await fresh.pending;
    expect(fresh.children).toHaveLength(3);
    expect(result).toMatchObject({ success: false, exitIp: null, source: "network", observedAt: START + 60_000, observationId: expect.any(String) });
    expect(cachedProxyDetectionForTests(PROXY)).toBeNull();
  });

  it("an older in-flight success cannot refill cache after a newer failed refresh", async () => {
    const old = probe();
    vi.setSystemTime(START + 100);
    const newer = probe("refresh");
    reply(newer, null);
    expect((await newer.pending).success).toBe(false);
    vi.setSystemTime(START + 200);
    reply(old, "192.0.2.10");
    expect((await old.pending).success).toBe(true);
    expect(cachedProxyDetectionForTests(PROXY)).toBeNull();
  });

  it("an older in-flight success cannot overwrite a newer successful refresh", async () => {
    const old = probe();
    vi.setSystemTime(START + 100);
    const newer = probe("refresh");
    reply(newer, "198.51.100.20");
    expect((await newer.pending).exitIp).toBe("198.51.100.20");
    vi.setSystemTime(START + 200);
    reply(old, "192.0.2.10");
    await old.pending;
    expect(cachedProxyDetectionForTests(PROXY)?.exitIp).toBe("198.51.100.20");
  });

  it("pre-aborted refresh performs no measurement and does not invalidate reusable cache", async () => {
    await warm();
    const controller = new AbortController();
    controller.abort();
    const stopped: any = await probe("refresh", controller.signal).pending;
    expect(stopped.success).toBe(false);
    expect(stopped.error).toMatch(/abort/i);
    expect(children).toHaveLength(3);
    expect(proxyDetectionObservedAt(stopped)).toBeNull();
    expect(stopped).toMatchObject({ observedAt: null, source: "unknown", observationId: null });
    expect(cachedProxyDetectionForTests(PROXY)?.exitIp).toBe("192.0.2.10");
  });

  it("aborting in-flight work cannot publish a late success or trusted measurement", async () => {
    const controller = new AbortController();
    const request = probe("refresh", controller.signal);
    controller.abort();
    reply(request, "192.0.2.10");
    const stopped: any = await request.pending;
    expect(stopped.success).toBe(false);
    expect(proxyDetectionObservedAt(stopped)).toBeNull();
    expect(stopped).toMatchObject({ observedAt: null, source: "unknown", observationId: null });
    expect(cachedProxyDetectionForTests(PROXY)).toBeNull();
  });

  it.each(["config-write", "spawn-throw", "spawn-error"] as const)("never stamps not-dispatched %s as a network observation", async fault => {
    if (fault === "config-write") effects.write.mockImplementation(() => { throw new Error("synthetic temp-config write failure"); });
    if (fault === "spawn-throw") effects.spawn.mockImplementation(() => { throw new Error("synthetic spawn failure"); });
    const request = probe("refresh");
    if (fault === "spawn-error") for (const { child: current } of request.children) current.emit("error", Object.assign(new Error("synthetic missing curl"), { code: "ENOENT" }));
    expect(await request.pending).toMatchObject({ success: false, observedAt: null, source: "unknown", observationId: null });
    expect(cachedProxyDetectionForTests(PROXY)).toBeNull();
    if (fault !== "spawn-error") expect(request.children).toHaveLength(0);
  });

  it("captures failed real completion time, not request-start or later cache-read time", async () => {
    const request = probe("refresh");
    vi.setSystemTime(START + 1200); reply(request, null);
    const result = await request.pending;
    expect(result).toMatchObject({ success: false, observedAt: START + 1200, source: "network", observationId: expect.any(String) });
    vi.setSystemTime(START + 60000);
    expect(proxyDetectionObservedAt(structuredClone(result))).toBe(START + 1200);
  });

  it("includes a case-preserving bypass multiset in cache identity", async () => {
    await warm();
    const offset = children.length;
    const pending = proxyDetector.detect({ ...PROXY, bypassList: ["Synthetic.invalid"] });
    const request = { pending, children: children.slice(offset) };
    expect(request.children).toHaveLength(3); reply(request, "198.51.100.20"); await pending;
    expect(cachedProxyDetectionForTests({ ...PROXY, bypassList: ["synthetic.invalid"] })).toBeNull();
    expect(cachedProxyDetectionForTests({ ...PROXY, bypassList: ["Synthetic.invalid", "Synthetic.invalid"] })).toBeNull();
    expect(cachedProxyDetectionForTests({ ...PROXY, bypassList: [" Synthetic.invalid "] })).toMatchObject({ exitIp: "198.51.100.20", source: "cache" });
  });
});
