import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../../src/main/types.js";

// Actual IPC handlers + detector/cache + config store. Only Electron and curl
// effects are fixtures; config writes/readback/reload use an owned real directory.
const fixture = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-detection-transaction-"));
  return { root, userData: path.join(root, "app"), tmp: path.join(root, "curl"), owner: fs.lstatSync(root),
    handlers: new Map<string, (...args: any[]) => Promise<any>>(), spawn: vi.fn(), failRename: false, failWrite: false, failNonce: false, failPostCommit: false, renameCalls: 0,
    realSetTimeout: globalThis.setTimeout, realClearTimeout: globalThis.clearTimeout };
});
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<any>) => fixture.handlers.set(name, handler) },
  app: { getPath: () => fixture.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text, "utf8"),
    decryptString: (bytes: Buffer) => bytes.toString("utf8"),
  },
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    writeFileSync: (file: any, ...args: any[]) => {
      if (fixture.failWrite && typeof file === "number") throw new Error("synthetic config write failure");
      return (actual.writeFileSync as any)(file, ...args);
    },
    fsyncSync: (fd: number) => {
      if (fixture.failPostCommit && actual.fstatSync(fd).isDirectory()) throw new Error("synthetic post-rename directory fsync failure");
      return actual.fsyncSync(fd);
    },
    chmodSync: (file: fs.PathLike, mode: fs.Mode) => {
      if (fixture.failPostCommit && String(file).endsWith("/config.json")) throw new Error("synthetic post-rename chmod failure");
      return actual.chmodSync(file, mode);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    fixture.renameCalls++;
    if (fixture.failRename) throw Object.assign(new Error("synthetic atomic commit failure"), { code: "EIO" });
    return actual.renameSync(from, to);
  } };
});
vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => { if (fixture.failNonce) throw new Error("synthetic candidate nonce failure"); return actual.randomUUID(); } };
});
vi.mock("node:child_process", () => ({
  spawn: fixture.spawn,
  execFileSync: () => { throw new Error("Unexpected subprocess execution"); },
}));
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(), tmpdir: () => fixture.tmp,
  hostname: () => "synthetic-proxy-fixture", homedir: () => fixture.root,
}));
vi.mock("node:net", async (original) => {
  const { isIP } = await original<typeof import("node:net")>();
  return { isIP, connect: () => { throw new Error("Unexpected network access"); } };
});
vi.mock("node:dns", () => ({ lookup: () => { throw new Error("Unexpected DNS access"); } }));
vi.mock("node:dns/promises", () => ({ lookup: () => { throw new Error("Unexpected DNS access"); }, resolve: () => { throw new Error("Unexpected DNS access"); } }));
vi.mock("../../src/main/services/webrtc-detector.js", () => ({
  webrtcDetector: { detect: () => { throw new Error("Unexpected WebRTC detector dispatch"); } },
}));
import { registerDetectHandlers } from "../../src/main/ipc/detect.js";
import {
  addProxy, deleteProxy, getConfig, getConfigPath, getProxyDetection, getProxyHealthEntry, reloadConfig,
  renameProxy, updateProxy,
} from "../../src/main/services/config-manager.js";
import { clearProxyHealth, listProxyHealth, proxyHealthSummary, recordProxyDetection } from "../../src/main/services/proxy-health.js";
import { proxyDetector, resetProxyDetectionCacheForTests } from "../../src/main/services/proxy-detector.js";
import { captureProxyDetectionTarget, commitProxyDetectionIfCurrent, detectProxyTarget } from "../../src/main/services/proxy-detection.js";
import { initializeSecretStorage, encryptSecret, resetSecretStorageForTests } from "../../src/main/services/secrets.js";
import { transact, proxyTargetDetails } from "../../src/main/services/config/store.js";
import { importProxies } from "../../src/main/services/proxy-import.js";

const PROXY: ProxyConfig = { type: "http", host: "synthetic-proxy.invalid", port: 23187 };
const START = Date.parse("2026-10-19T00:00:00Z");
const children: Array<{ value: ReturnType<typeof child>; args: string[]; closed: boolean }> = [];
const pending = new Set<Promise<unknown>>();
function child() {
  const value = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  return Object.assign(value, { kill: vi.fn(() => value.emit("close", -1)) });
}
function begin(name = "p1", raw?: ProxyConfig) {
  const offset = children.length;
  const handler = fixture.handlers.get(raw ? "detect:proxy" : "detect:proxy-by-name");
  if (!handler) throw new Error("Actual detector handler was not registered");
  const owner = Object.assign(new EventEmitter(), { id: 401, isDestroyed: () => false });
  const promise = handler({ sender: owner }, raw ?? name);
  pending.add(promise);
  promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return { promise, children: children.slice(offset) };
}
function reply(request: ReturnType<typeof begin>, ip: string | null) {
  for (const current of request.children) {
    if (current.closed) continue;
    if (!ip) {
      current.value.stderr.emit("data", "synthetic connection refused");
      current.value.emit("close", 7);
      continue;
    }
    const url = current.args.at(-1)!;
    const data = url.startsWith("https://ipwho.is/")
      ? { success: true, ip, country: "United States", country_code: "US", timezone: { id: "America/New_York" } }
      : url.startsWith("https://ipapi.co/")
        ? { ip, country_name: "United States", country_code: "US", timezone: "America/New_York" }
        : { status: "success", query: ip, country: "United States", countryCode: "US", timezone: "America/New_York" };
    current.value.stdout.emit("data", JSON.stringify(data));
    current.value.emit("close", 0);
  }
}
function physical(config: ProxyConfig = PROXY, signal?: AbortSignal) {
  const offset = children.length;
  const promise = proxyDetector.detect(config, { cachePolicy: "refresh", ...(signal ? { signal } : {}) });
  pending.add(promise);
  promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return { promise, children: children.slice(offset) };
}
function syntheticOsSecrets() {
  let nonce = 0;
  const decrypt = vi.fn((bytes: Buffer) => JSON.parse(bytes.toString("utf8"))[1] as string);
  initializeSecretStorage({ backend: "os", reason: "explicit synthetic adapter, never host storage", userDataDir: fixture.userData, keyPath: path.join(fixture.userData, "unused-synthetic-vault") }, {
    osStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(JSON.stringify([++nonce, text])), decryptString: decrypt },
  });
  return { decrypt };
}
function assertOwnedRoot() {
  const value = fs.lstatSync(fixture.root);
  expect(value.isDirectory() && !value.isSymbolicLink()).toBe(true);
  expect([value.dev, value.ino, value.uid]).toEqual([fixture.owner.dev, fixture.owner.ino, fixture.owner.uid]);
}
function stored() { return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")); }
beforeEach(() => {
  assertOwnedRoot();
  fixture.failRename = fixture.failWrite = fixture.failNonce = fixture.failPostCommit = false;
  resetSecretStorageForTests();
  fs.rmSync(fixture.userData, { recursive: true, force: true });
  fs.mkdirSync(fixture.tmp, { recursive: true });
  reloadConfig(); getConfig(); addProxy("p1", PROXY); addProxy("p2", { ...PROXY, port: PROXY.port + 1 });
  resetProxyDetectionCacheForTests();
  children.length = 0; fixture.handlers.clear(); pending.clear();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(START);
  fixture.spawn.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe("curl");
    const value = child();
    const record = { value, args, closed: false };
    value.on("close", () => { record.closed = true; });
    children.push(record);
    return value;
  });
  registerDetectHandlers();
  fixture.renameCalls = 0;
});
afterEach(async () => {
  fixture.failRename = fixture.failWrite = fixture.failNonce = fixture.failPostCommit = false;
  const activeChildren = children.filter((current) => !current.closed), leakedPending = pending.size;
  let escape: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const current of activeChildren) current.value.emit("close", -1);
    // A real owned deadline still works when a broken timeout-only handler is
    // waiting on frozen fake timers. Cleanup escape is failure, never success.
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((_, reject) => { escape = fixture.realSetTimeout(() => reject(new Error("Pending detector fixture did not settle during bounded cleanup")), 1500); }),
    ]);
    expect(activeChildren, "every inert provider must settle in the case, not fixture cleanup").toEqual([]);
    expect(leakedPending, "the case must await its handler, not cleanup").toBe(0);
    expect(pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fs.readdirSync(fixture.tmp)).toEqual([]);
  } finally {
    if (escape) fixture.realClearTimeout(escape);
    resetProxyDetectionCacheForTests();
    resetSecretStorageForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
afterAll(() => { assertOwnedRoot(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

describe("named fresh detection and atomic health publication", () => {
  it("commits both projections once, then directly reads, reloads and searches them", async () => {
    const request = begin(); reply(request, "192.0.2.10");
    const result = await request.promise;
    expect(result).toMatchObject({ success: true, source: "network", observedAt: START });
    expect(fixture.renameCalls).toBe(1);
    const disk = stored();
    expect(disk.proxyDetections.p1).toMatchObject({ exitIp: "192.0.2.10", detectedAt: START, source: "network" });
    expect(disk.proxyHealth.p1).toMatchObject({ checks: 1, successes: 1, lastCheckedAt: START, lastSuccessAt: START });
    expect(disk.proxyHealth.p1.history[0]).toMatchObject({ at: START, source: "network" });
    reloadConfig();
    expect(getProxyDetection("p1")).toEqual(disk.proxyDetections.p1);
    expect(getProxyHealthEntry("p1")).toEqual(disk.proxyHealth.p1);
  });

  it("deduplicates one physical fresh probe into one committed health sample", async () => {
    const first = begin(), second = begin();
    reply(first, "192.0.2.10"); reply(second, "192.0.2.10");
    const replies = await Promise.all([first.promise, second.promise]);
    expect(replies.every((value) => value.success)).toBe(true);
    expect(children).toHaveLength(3);
    expect(fixture.renameCalls).toBe(1);
    expect(stored().proxyHealth.p1.checks).toBe(1);
  });

  it("both explicit IPC entry points refresh rather than returning the previous successful measurement", async () => {
    const first = begin(); reply(first, "192.0.2.10"); await first.promise;
    vi.setSystemTime(START + 60_000);
    const byName = begin(); reply(byName, "198.51.100.20");
    const namedResult = await byName.promise;
    vi.setSystemTime(START + 120_000);
    const raw = begin("", PROXY); reply(raw, "203.0.113.30");
    const rawResult = await raw.promise;
    expect(byName.children).toHaveLength(3); expect(raw.children).toHaveLength(3);
    expect(namedResult).toMatchObject({ success: true, exitIp: "198.51.100.20", source: "network", observedAt: START + 60_000 });
    expect(rawResult).toMatchObject({ success: true, exitIp: "203.0.113.30", source: "network", observedAt: START + 120_000 });
    expect(stored().proxyHealth.p1.checks).toBe(2);
    expect(stored().proxyDetections.p1.exitIp).toBe("198.51.100.20");
  });

  it("a failed fresh measurement stays failed even when the previous measurement succeeded", async () => {
    const first = begin(); reply(first, "192.0.2.10"); await first.promise;
    vi.setSystemTime(START + 60_000);
    const next = begin(); reply(next, null);
    expect(await next.promise).toMatchObject({ success: false, source: "network", observedAt: START + 60_000 });
    expect(next.children).toHaveLength(3);
    expect(stored().proxyDetections.p1).toMatchObject({ success: false, detectedAt: START + 60_000 });
    expect(stored().proxyHealth.p1).toMatchObject({ checks: 2, successes: 1, consecutiveFailures: 1, lastSuccessAt: START });
  });

  it("a save failure is not a successful IPC result or a partial in-memory commit", async () => {
    const beforeBytes = fs.readFileSync(getConfigPath()), beforeMemory = structuredClone(getConfig());
    const request = begin();
    fixture.failRename = true;
    reply(request, "192.0.2.10");
    const result = await request.promise;
    fixture.failRename = false;
    expect(result).toMatchObject({ success: false, code: "PROXY_DETECTION_SAVE_FAILED" });
    expect(fixture.renameCalls).toBe(1);
    expect(fs.readFileSync(getConfigPath())).toEqual(beforeBytes);
    expect(getConfig()).toEqual(beforeMemory);
    reloadConfig();
    expect(stored()).toEqual(JSON.parse(beforeBytes.toString("utf8")));
    expect(getProxyDetection("p1")).toBeNull(); expect(getProxyHealthEntry("p1")).toBeNull();
  });

  const barriers: Array<[string, () => void]> = [
    ["same-name endpoint edit", () => { updateProxy("p1", { ...PROXY, port: PROXY.port + 2 }); }],
    ["same-name bypass edit", () => { updateProxy("p1", { ...PROXY, bypassList: ["synthetic.invalid"] }); }],
    ["equal upsert/reset", () => { addProxy("p1", PROXY); }],
    ["delete and equal-content recreation", () => { deleteProxy("p1"); addProxy("p1", PROXY); }],
    ["rename away and back", () => { renameProxy("p1", "moved", PROXY); renameProxy("moved", "p1", PROXY); }],
    ["successful equal-content reload", () => { reloadConfig(); }],
    ["empty named health clear", () => { clearProxyHealth("p1"); }],
    ["empty global health clear", () => { clearProxyHealth(); }],
  ];
  it.each(barriers)("does not resurrect projections after %s", async (_label, barrier) => {
    const request = begin();
    barrier();
    const beforeReply = fs.readFileSync(getConfigPath());
    const beforeMemory = structuredClone(getConfig());
    reply(request, "192.0.2.10");
    expect(await request.promise).toMatchObject({ success: false, code: "PROXY_DETECTION_TARGET_CHANGED" });
    expect(fs.readFileSync(getConfigPath())).toEqual(beforeReply);
    expect(getConfig()).toEqual(beforeMemory);
    expect(getProxyDetection("p1")).toBeNull(); expect(getProxyHealthEntry("p1")).toBeNull();
  });

  it("a same-name edit starts a different probe rather than joining the old in-flight request", async () => {
    const first = begin();
    updateProxy("p1", { ...PROXY, port: PROXY.port + 2 });
    const next = begin();
    reply(next, "198.51.100.20");
    // A defective name-only deduper dispatches nothing here; do not deadlock
    // its fixture, but retain the unconditional dispatch/result assertions.
    if (next.children.length) await next.promise;
    reply(first, "192.0.2.10");
    const [oldResult, currentResult] = await Promise.all([first.promise, next.promise]);
    expect(next.children).toHaveLength(3); expect(children).toHaveLength(6);
    expect(oldResult).toMatchObject({ success: false, code: "PROXY_DETECTION_TARGET_CHANGED" });
    expect(currentResult).toMatchObject({ success: true, exitIp: "198.51.100.20" });
    expect(stored().proxyDetections.p1.exitIp).toBe("198.51.100.20");
    expect(stored().proxyHealth.p1).toMatchObject({ checks: 1, successes: 1 });
  });

  it("preserves unrelated committed changes while accepting a still-current observation", async () => {
    const request = begin();
    transact((draft: any) => { draft.deviceName = "unrelated committed edit"; });
    clearProxyHealth("p2");
    reply(request, "192.0.2.10");
    expect((await request.promise).success).toBe(true);
    expect(stored().deviceName).toBe("unrelated committed edit");
    expect(stored().proxyDetections.p1.exitIp).toBe("192.0.2.10");
    expect(stored().proxyHealth.p1.checks).toBe(1);
  });
});

describe("cache-first publication and encrypted empty credentials", () => {
  it.each([false, true])("promotes one cache-only observation to exactly one original network sample (prior failure=%s)", async failFirst => {
    const target = captureProxyDetectionTarget("p1")!;
    const request = physical(); reply(request, "192.0.2.10");
    const original = await request.promise;
    if (failFirst) {
      const before = fs.readFileSync(getConfigPath());
      fixture.failRename = true;
      try { expect(() => commitProxyDetectionIfCurrent(target, original)).toThrow("synthetic atomic commit failure"); }
      finally { fixture.failRename = false; }
      expect(fs.readFileSync(getConfigPath())).toEqual(before);
      expect(getProxyDetection("p1")).toBeNull(); expect(getProxyHealthEntry("p1")).toBeNull();
    }
    vi.setSystemTime(START + 60_000);
    const cached = await proxyDetector.detect(PROXY);
    expect(cached).toMatchObject({ source: "cache", observedAt: START, observationId: original.observationId });
    expect(commitProxyDetectionIfCurrent(target, cached)).toBe("committed");
    expect(getProxyHealthEntry("p1")).toBeNull();
    expect(commitProxyDetectionIfCurrent(target, original)).toBe("committed");
    const disk = stored(), bytes = fs.readFileSync(getConfigPath()), writes = fixture.renameCalls;
    expect(disk.proxyHealth.p1).toMatchObject({ checks: 1, successes: 1, lastCheckedAt: START, lastSuccessAt: START });
    expect(disk.proxyDetections.p1).toMatchObject({ source: "network", detectedAt: START, observationId: original.observationId });
    expect(commitProxyDetectionIfCurrent(target, original)).toBe("duplicate");
    expect(commitProxyDetectionIfCurrent(target, cached)).toBe("duplicate");
    expect(fixture.renameCalls).toBe(writes); expect(fs.readFileSync(getConfigPath())).toEqual(bytes);
    reloadConfig();
    expect(getProxyHealthEntry("p1")).toEqual(disk.proxyHealth.p1);
    expect(getProxyDetection("p1")).toEqual(disk.proxyDetections.p1);
  });

  it("accepts a genuinely encrypted empty password and keeps equivalent re-encryption in the same lifecycle", async () => {
    const { decrypt } = syntheticOsSecrets();
    const firstEnvelope = encryptSecret(""), secondEnvelope = encryptSecret("");
    expect(firstEnvelope).not.toBe(secondEnvelope);
    addProxy("p1", { ...PROXY, username: "synthetic-empty-route", password: firstEnvelope });
    const target = captureProxyDetectionTarget("p1")!;
    const originalGeneration = proxyTargetDetails(target).generation;
    const offset = children.length, promise = detectProxyTarget(target, "refresh");
    const request = { promise, children: children.slice(offset) };
    reply(request, "192.0.2.10");
    const observed = await promise;
    expect(decrypt).toHaveBeenCalled();
    expect(() => commitProxyDetectionIfCurrent(target, observed)).not.toThrow();
    updateProxy("p1", { ...PROXY, username: "synthetic-empty-route", password: secondEnvelope });
    expect(proxyTargetDetails(captureProxyDetectionTarget("p1")!).generation).toBe(originalGeneration);
    expect(commitProxyDetectionIfCurrent(target, observed)).toBe("duplicate");
    const disk = stored();
    expect(disk.proxies.p1.password).toBe(secondEnvelope);
    expect(disk.proxyHealth.p1).toMatchObject({ checks: 1, successes: 1 });
    reloadConfig();
    expect(getProxyHealthEntry("p1")).toEqual(disk.proxyHealth.p1);
  });

  it("does not consume equal-order network promotion when its rename fails", async () => {
    const target = captureProxyDetectionTarget("p1")!;
    const request = physical(); reply(request, "192.0.2.10");
    const original = await request.promise, cached = await proxyDetector.detect(PROXY);
    commitProxyDetectionIfCurrent(target, cached);
    const before = fs.readFileSync(getConfigPath()), memory = structuredClone(getConfig());
    fixture.failRename = true;
    try { expect(() => commitProxyDetectionIfCurrent(target, original)).toThrow("synthetic atomic commit failure"); }
    finally { fixture.failRename = false; }
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(getConfig()).toEqual(memory);
    expect(commitProxyDetectionIfCurrent(target, original)).toBe("committed");
    const disk = stored(), count = fixture.renameCalls;
    expect(disk.proxyHealth.p1).toMatchObject({ checks: 1, successes: 1, lastSuccessAt: START });
    expect(commitProxyDetectionIfCurrent(target, original)).toBe("duplicate");
    expect(fixture.renameCalls).toBe(count);
    reloadConfig(); expect(getProxyHealthEntry("p1")).toEqual(disk.proxyHealth.p1);
  });
});

describe("authenticated order, lifecycle rollback and detached current reads", () => {
  function rejectedWithoutWrite(run: () => unknown, code: string) {
    const disk = fs.readFileSync(getConfigPath()), memory = structuredClone(getConfig()), writes = fixture.renameCalls;
    expect(run).toThrow(code);
    expect(fixture.renameCalls).toBe(writes); expect(fs.readFileSync(getConfigPath())).toEqual(disk); expect(getConfig()).toEqual(memory);
  }
  it("rejects serialized/mutated stamps and forged targets before any write", async () => {
    const target = captureProxyDetectionTarget("p1")!;
    const request = physical(); reply(request, "192.0.2.10"); const observed = await request.promise;
    rejectedWithoutWrite(() => commitProxyDetectionIfCurrent(target, structuredClone(observed)), "PROXY_DETECTION_UNOBSERVED");
    rejectedWithoutWrite(() => commitProxyDetectionIfCurrent(Object.freeze({}), observed), "PROXY_DETECTION_TARGET_CHANGED");
    const at = observed.observedAt;
    observed.observedAt = START + 999;
    rejectedWithoutWrite(() => commitProxyDetectionIfCurrent(target, observed), "PROXY_DETECTION_UNOBSERVED");
    observed.observedAt = at;
    expect(commitProxyDetectionIfCurrent(target, observed)).toBe("committed");
  });

  it("dispatch order rejects a late older success even when its completion timestamp is later", async () => {
    const target = captureProxyDetectionTarget("p1")!, old = physical();
    vi.setSystemTime(START + 100);
    const newer = physical(); reply(newer, null); const newResult = await newer.promise;
    expect(commitProxyDetectionIfCurrent(target, newResult)).toBe("committed");
    vi.setSystemTime(START + 200); reply(old, "192.0.2.10"); const oldResult = await old.promise;
    expect(oldResult.observedAt!).toBeGreaterThan(newResult.observedAt!);
    rejectedWithoutWrite(() => commitProxyDetectionIfCurrent(target, oldResult), "PROXY_DETECTION_STALE");
    const disk = stored();
    expect(disk.proxyDetections.p1).toMatchObject({ success: false, detectedAt: START + 100 });
    expect(disk.proxyHealth.p1).toMatchObject({ checks: 1, successes: 0, consecutiveFailures: 1 });
    reloadConfig(); expect(getProxyDetection("p1")).toEqual(disk.proxyDetections.p1);
  });

  it("distinguishes cache policy in same-target in-flight dedupe", async () => {
    const target = captureProxyDetectionTarget("p1")!;
    let offset = children.length;
    const preferred = { promise: detectProxyTarget(target, "prefer-cache"), children: [] as typeof children };
    preferred.children = children.slice(offset); offset = children.length;
    const fresh = { promise: detectProxyTarget(target, "refresh"), children: [] as typeof children };
    fresh.children = children.slice(offset);
    expect(preferred.children).toHaveLength(3); expect(fresh.children).toHaveLength(3);
    reply(fresh, "198.51.100.20"); const freshResult = await fresh.promise;
    commitProxyDetectionIfCurrent(target, freshResult);
    reply(preferred, "192.0.2.10"); const oldResult = await preferred.promise;
    rejectedWithoutWrite(() => commitProxyDetectionIfCurrent(target, oldResult), "PROXY_DETECTION_STALE");
    expect(stored().proxyHealth.p1.checks).toBe(1);
  });

  it.each(["pre-aborted", "aborted while joining"])("a %s consumer cannot inherit an in-flight authenticated success", async timing => {
    const target = captureProxyDetectionTarget("p1")!, offset = children.length;
    const original = detectProxyTarget(target, "refresh");
    const request = { promise: original, children: children.slice(offset) };
    const controller = new AbortController();
    if (timing === "pre-aborted") controller.abort();
    const canceled = detectProxyTarget(target, "refresh", controller.signal);
    if (timing !== "pre-aborted") controller.abort();
    reply(request, "192.0.2.10"); const observed = await original;
    expect(await canceled).toMatchObject({ success: false, source: "unknown", observedAt: null, observationId: null });
    expect(children).toHaveLength(3);
    expect(commitProxyDetectionIfCurrent(target, observed)).toBe("committed");
    expect(stored().proxyHealth.p1.checks).toBe(1);
  });

  it("an outer handler timeout cannot persist a late result from an uncooperative detector", async () => {
    let complete!: (value: any) => void, signal: AbortSignal | undefined;
    const spy = vi.spyOn(proxyDetector, "detect").mockImplementationOnce((_config, options) => {
      signal = options?.signal;
      return new Promise(resolve => { complete = resolve; });
    });
    try {
      const bytes = fs.readFileSync(getConfigPath()), memory = structuredClone(getConfig());
      const request = begin();
      const outcome = request.promise.then(value => ({ value, error: null }), error => ({ value: null, error }));
      await vi.advanceTimersByTimeAsync(25_001);
      expect((await outcome).error?.message).toMatch(/timed out/); expect(signal?.aborted).toBe(true);
      spy.mockRestore();
      const late = physical(); reply(late, "192.0.2.10"); complete(await late.promise);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(fs.readFileSync(getConfigPath())).toEqual(bytes); expect(getConfig()).toEqual(memory);
      expect(getProxyDetection("p1")).toBeNull(); expect(getProxyHealthEntry("p1")).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it.each(["rename", "write", "nonce"] as const)("keeps a captured lifecycle valid after failed %s preparation/publication", async fault => {
    const target = captureProxyDetectionTarget("p1")!, before = fs.readFileSync(getConfigPath()), memory = structuredClone(getConfig());
    const generation = proxyTargetDetails(target).generation;
    fixture.failRename = fault === "rename"; fixture.failWrite = fault === "write"; fixture.failNonce = fault === "nonce";
    try { expect(() => addProxy("p1", PROXY)).toThrow(/synthetic/); }
    finally { fixture.failRename = fixture.failWrite = fixture.failNonce = false; }
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(getConfig()).toEqual(memory);
    expect(proxyTargetDetails(captureProxyDetectionTarget("p1")!).generation).toBe(generation);
    const request = physical(); reply(request, "192.0.2.10");
    expect(commitProxyDetectionIfCurrent(target, await request.promise)).toBe("committed");
    const disk = stored(); reloadConfig(); expect(getProxyHealthEntry("p1")).toEqual(disk.proxyHealth.p1);
  });

  it("a failed newer observation write does not consume order or block an older still-uncommitted sample", async () => {
    const target = captureProxyDetectionTarget("p1")!, old = physical(), next = physical();
    reply(next, "198.51.100.20"); const newer = await next.promise;
    fixture.failRename = true;
    try { expect(() => commitProxyDetectionIfCurrent(target, newer)).toThrow("synthetic atomic commit failure"); }
    finally { fixture.failRename = false; }
    reply(old, "192.0.2.10"); const older = await old.promise;
    expect(commitProxyDetectionIfCurrent(target, older)).toBe("committed");
    expect(commitProxyDetectionIfCurrent(target, newer)).toBe("committed");
    expect(stored().proxyHealth.p1).toMatchObject({ checks: 2, successes: 2 });
  });

  it("post-rename fsync/chmod failure does not undo published observations or their duplicate fence", async () => {
    const target = captureProxyDetectionTarget("p1")!, request = physical(); reply(request, "192.0.2.10");
    const observed = await request.promise;
    fixture.failPostCommit = true;
    try { expect(commitProxyDetectionIfCurrent(target, observed)).toBe("committed"); }
    finally { fixture.failPostCommit = false; }
    const disk = stored(), bytes = fs.readFileSync(getConfigPath()), writes = fixture.renameCalls;
    expect(getProxyHealthEntry("p1")).toEqual(disk.proxyHealth.p1);
    expect(commitProxyDetectionIfCurrent(target, observed)).toBe("duplicate");
    expect(fs.readFileSync(getConfigPath())).toEqual(bytes); expect(fixture.renameCalls).toBe(writes);
    reloadConfig(); expect(getProxyDetection("p1")).toEqual(disk.proxyDetections.p1);
  });

  it("cached information cannot add a check, renew success or clear a current failure cooldown", async () => {
    const target = captureProxyDetectionTarget("p1")!, request = physical(); reply(request, "192.0.2.10"); await request.promise;
    for (let i = 1; i <= 3; i++) recordProxyDetection("p1", { success: false, error: "synthetic measured failure", source: "network", observedAt: START + i });
    const before = structuredClone(getProxyHealthEntry("p1"));
    vi.setSystemTime(START + 60_000);
    const cached = await proxyDetector.detect(PROXY);
    expect(commitProxyDetectionIfCurrent(target, cached)).toBe("committed");
    expect(getProxyHealthEntry("p1")).toEqual(before);
    expect(stored().proxyHealth.p1).toMatchObject({ checks: 3, successes: 0, lastSuccessAt: null, consecutiveFailures: 3 });
    const writes = fixture.renameCalls;
    expect(commitProxyDetectionIfCurrent(target, cached)).toBe("duplicate"); expect(fixture.renameCalls).toBe(writes);
  });

  it("ages a formerly perfect result out of Good in current summary without changing stored facts or bytes", async () => {
    const request = begin(); reply(request, "192.0.2.10"); await request.promise;
    const original = structuredClone(getProxyHealthEntry("p1")), bytes = fs.readFileSync(getConfigPath());
    expect(listProxyHealth()[0]).toMatchObject({ score: 100, risk: "good", freshness: "fresh", observationAgeMs: 0 });
    vi.setSystemTime(START + 10 * 60_000 + 1);
    const current = listProxyHealth()[0], summary = proxyHealthSummary();
    expect(current).toMatchObject({ score: 79, risk: "watch", freshness: "stale", observationAgeMs: 10 * 60_000 + 1, checks: 1, lastSuccessAt: START });
    expect(String(current.suggestion || "")).not.toMatch(/Healthy|状态良好/);
    expect(summary).toMatchObject({ good: 0, watch: 1, stale: 1 });
    current.history[0].at = START + 999; current.checks = 999;
    expect(fs.readFileSync(getConfigPath())).toEqual(bytes); expect(getProxyHealthEntry("p1")).toEqual(original);
    reloadConfig(); expect(getProxyHealthEntry("p1")).toEqual(original);
  });

  it("keeps legacy missing-source/invalid-time facts unknown, never a new timestamp or Good", async () => {
    const request = begin(); reply(request, "192.0.2.10"); await request.promise;
    transact((draft: any) => {
      delete draft.proxyHealth.p1.history[0].source;
      draft.proxyHealth.p1.history[0].at = undefined;
      draft.proxyHealth.p1.lastCheckedAt = undefined;
      draft.proxyDetections.p1.detectedAt = undefined;
      delete draft.proxyDetections.p1.source;
    });
    const bytes = fs.readFileSync(getConfigPath()), disk = stored();
    expect(disk.proxyDetections.p1).toMatchObject({ detectedAt: null, source: "unknown" });
    expect(disk.proxyHealth.p1.history[0]).toMatchObject({ at: null, source: "unknown" });
    expect(listProxyHealth()[0]).toMatchObject({ freshness: "unknown", risk: "poor", observationAgeMs: null, checks: 1 });
    expect(proxyHealthSummary()).toMatchObject({ good: 0, unknown: 1, lastCheckedAt: null });
    expect(fs.readFileSync(getConfigPath())).toEqual(bytes);
    reloadConfig(); expect(getProxyDetection("p1")).toEqual(disk.proxyDetections.p1);
    expect(getProxyHealthEntry("p1")).toEqual(disk.proxyHealth.p1);
  });
});

describe("credential/bypass semantic identity and explicit replacement", () => {
  const auth = { ...PROXY, username: "synthetic-auth-route", password: "synthetic-auth-password" };
  it.each([
    ["password", { ...auth, password: "synthetic-new-password", bypassList: ["synthetic.invalid"] }],
    ["username", { ...auth, username: "synthetic-new-route", bypassList: ["synthetic.invalid"] }],
    ["bypass case", { ...auth, bypassList: ["Synthetic.invalid"] }],
    ["bypass multiplicity", { ...auth, bypassList: ["synthetic.invalid", "synthetic.invalid"] }],
  ] as Array<[string, ProxyConfig]>)("does not join or accept the old target after a same-name %s change", async (_label, next) => {
    addProxy("p1", { ...auth, bypassList: ["synthetic.invalid"] });
    const old = begin(); updateProxy("p1", next); const current = begin();
    expect(current.children).toHaveLength(3);
    reply(current, "198.51.100.20"); expect((await current.promise).success).toBe(true);
    const bytes = fs.readFileSync(getConfigPath());
    reply(old, "192.0.2.10"); expect(await old.promise).toMatchObject({ success: false, code: "PROXY_DETECTION_TARGET_CHANGED" });
    expect(fs.readFileSync(getConfigPath())).toEqual(bytes);
    const disk = stored(); expect(disk.proxyHealth.p1.checks).toBe(1);
    reloadConfig(); expect(getProxyDetection("p1")).toEqual(disk.proxyDetections.p1);
  });

  it("equivalent trimmed bypass multiset and fallback/updatedAt-only edits preserve a pending target", async () => {
    const initial = { ...auth, bypassList: ["one.synthetic.invalid", "two.synthetic.invalid", "one.synthetic.invalid"] };
    addProxy("p1", initial);
    const target = captureProxyDetectionTarget("p1")!, request = begin();
    updateProxy("p1", { ...auth, bypassList: [" two.synthetic.invalid ", "one.synthetic.invalid", "one.synthetic.invalid"], fallbacks: ["p2"] });
    transact((draft: any) => { draft.proxies.p1.updatedAt = START + 999; draft.deviceName = "unrelated synthetic metadata"; });
    expect(proxyTargetDetails(captureProxyDetectionTarget("p1")!).generation).toBe(proxyTargetDetails(target).generation);
    reply(request, "192.0.2.10"); expect((await request.promise).success).toBe(true);
    const disk = stored(); expect(disk.proxies.p1.fallbacks).toEqual(["p2"]); expect(disk.deviceName).toBe("unrelated synthetic metadata");
    reloadConfig(); expect(getProxyHealthEntry("p1")).toEqual(disk.proxyHealth.p1);
  });

  it("equal generic normalization and duplicate-endpoint import skips do not replace the lifecycle", async () => {
    const target = captureProxyDetectionTarget("p1")!, request = begin();
    transact((draft: any) => { draft.proxies = structuredClone(draft.proxies); });
    const writes = fixture.renameCalls;
    const report = importProxies([{ name: "p1", config: PROXY }], { replace: true });
    expect(report.imported).toEqual([]); expect(report.skipped).toHaveLength(1); expect(fixture.renameCalls).toBe(writes);
    expect(proxyTargetDetails(captureProxyDetectionTarget("p1")!).generation).toBe(proxyTargetDetails(target).generation);
    reply(request, "192.0.2.10"); expect((await request.promise).success).toBe(true);
  });

  it("does not decrypt unchanged stored envelopes on unrelated transactions, but compares re-encryption once", async () => {
    const { decrypt } = syntheticOsSecrets();
    addProxy("p1", auth);
    const target = captureProxyDetectionTarget("p1")!, generation = proxyTargetDetails(target).generation;
    decrypt.mockClear();
    transact((draft: any) => { draft.deviceName = "unrelated synthetic edit"; });
    expect(decrypt).not.toHaveBeenCalled();
    const envelope = encryptSecret(auth.password);
    updateProxy("p1", { ...auth, password: envelope });
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(proxyTargetDetails(captureProxyDetectionTarget("p1")!).generation).toBe(generation);
    decrypt.mockClear();
    transact((draft: any) => { draft.proxies.p1.fallbacks = ["p2"]; });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("failing credential decryption remains fail-closed before any child or forged observation", async () => {
    const { decrypt } = syntheticOsSecrets();
    addProxy("p1", auth);
    decrypt.mockImplementation(() => { throw new Error("synthetic decrypt failure"); });
    const target = captureProxyDetectionTarget("p1")!, bytes = fs.readFileSync(getConfigPath()), memory = structuredClone(getConfig());
    const childrenBefore = children.length;
    await expect(detectProxyTarget(target, "refresh")).rejects.toThrow(/credential.*corrupt|decryption failed/i);
    expect(children).toHaveLength(childrenBefore);
    expect(fs.readFileSync(getConfigPath())).toEqual(bytes); expect(getConfig()).toEqual(memory);
    expect(getProxyHealthEntry("p1")).toBeNull(); expect(getProxyDetection("p1")).toBeNull();
    transact((draft: any) => { draft.proxies.p1.password = "os1:unreadable-synthetic-envelope"; });
    expect(proxyTargetDetails(captureProxyDetectionTarget("p1")!).generation).not.toBe(proxyTargetDetails(target).generation);
    const current = captureProxyDetectionTarget("p1")!;
    await expect(detectProxyTarget(current, "refresh")).rejects.toThrow(/credential.*corrupt|decryption failed/i);
    expect(children).toHaveLength(childrenBefore);
  });
});
