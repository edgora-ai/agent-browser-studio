import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BidiConnection } from "../../src/main/services/bidi-client.js";

const blocked = vi.hoisted(() => ({
  io: vi.fn(() => { throw new Error("External I/O is forbidden in this unit test"); }),
  exitCode: process.exitCode,
}));
vi.mock("node:child_process", () => ({ execFile: blocked.io, execFileSync: blocked.io, spawn: blocked.io }));
vi.mock("node:http", () => ({ get: blocked.io }));
vi.mock("node:net", () => ({ createServer: blocked.io }));
vi.mock("node:fs", async (importOriginal) => ({
  readFileSync: (await importOriginal<typeof import("node:fs")>()).readFileSync,
  existsSync: blocked.io, statSync: blocked.io, mkdtempSync: blocked.io,
  mkdirSync: blocked.io, writeFileSync: blocked.io, rmSync: blocked.io,
}));
vi.mock("playwright", () => ({ chromium: { connectOverCDP: blocked.io } }));
vi.mock("../../src/main/services/browser-engine.js", () => ({
  buildFirefoxLaunchArgs: blocked.io, writeFirefoxUserJs: blocked.io,
  findFirefoxBinary: blocked.io, detectFirefoxVersion: blocked.io,
}));
vi.mock("../../src/main/services/firefox-fingerprint.js", () => ({ buildFirefoxManagedIdentity: blocked.io }));
vi.mock("../../src/main/services/bidi-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/services/bidi-client.js")>()),
  connectBidi: blocked.io, bidiAddPreloadScript: blocked.io, bidiCreateContext: blocked.io,
  bidiCloseContext: blocked.io, bidiGetTopContext: blocked.io, bidiNavigate: blocked.io,
  bidiActivateContext: blocked.io,
}));

import {
  assessPing0FirefoxRun,
  collectPing0OnBidi,
  type Ping0BidiCollectionOptions,
  type Ping0CollectionResult,
} from "../../src/tools/verify-ping0.js";

const contextId = "existing-production-tab";
const options: Ping0BidiCollectionOptions = { siteAccessAuthorized: true, waitTimeoutMs: 10, settleMs: 0 };

function remoteValue(value: unknown): unknown {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", value: value.map(remoteValue) };
  if (typeof value === "object") {
    return { type: "object", value: Object.entries(value).map(([key, item]) => [key, remoteValue(item)]) };
  }
  return { type: typeof value, value };
}

function syntheticConnection(initial: Record<string, unknown> = {}, initialUrl = "https://ping0.cc/env") {
  const data: Record<string, any> = {
    finished: true, score: 100, level: "synthetic", reportId: "synthetic-firefox-report",
    rows: {
      "dns.resolver_count": { value: 2, pending: false },
      "xc.dns_blackhole": { fail: false, pending: false },
      "stealth.raf_timing": { fail: false, pending: false },
    },
    finalFindings: [], status: "done", ...initial,
  };
  let url = initialUrl;
  const document = {
    querySelector: () => ({ __vue__: { $data: data } }),
    visibilityState: "visible", hasFocus: () => true,
    get body(): never { throw new Error("Collector must not read arbitrary document text"); },
  };
  const evaluate = vi.fn(async (expression: string): Promise<any> => runInNewContext(expression, { document }));
  const send = vi.fn(async (method: string, params?: Record<string, any>, _timeoutMs?: number): Promise<any> => {
    if (method === "browsingContext.getTree") {
      expect(params).toEqual({ root: contextId, maxDepth: 0 });
      return { contexts: [{ context: contextId, url }] };
    }
    if (method === "script.evaluate") {
      expect(params?.target).toEqual({ context: contextId });
      expect(params?.resultOwnership).toBe("none");
      return { type: "success", result: remoteValue(await evaluate(params!.expression)) };
    }
    throw new Error("Unexpected mutating or unscoped BiDi command: " + method);
  });
  const close = vi.fn();
  const conn: BidiConnection = { wsUrl: "ws://existing.invalid/session", send, close, closed: false };
  return { conn, data, send, evaluate, close, setUrl: (value: string) => { url = value; } };
}

function assessment(result: Ping0CollectionResult) {
  const { state, ...collection } = result;
  return assessPing0FirefoxRun({ state, collection });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T00:00:00.000Z"));
});
afterEach(() => {
  expect(blocked.io).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(blocked.exitCode);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("caller-owned Firefox BiDi Ping0 collector (synthetic only)", () => {
  it("is import-safe and leaves CLI assessment enabled for every engine", () => {
    expect(typeof collectPing0OnBidi).toBe("function");
    const source = readFileSync(new URL("../../src/tools/verify-ping0.ts", import.meta.url), "utf8");
    expect(source).toContain("report.assessment = assessPing0Run(report).assessment;");
    expect(source).not.toMatch(/if \(opts\.engine === "chromium"\) report\.assessment/);
    expect(source).not.toMatch(/reports\.filter\(\(r\) => r\.launch\.engine === "chromium"\)/);
    expect(source).toMatch(/reports\.map\(\(r\) => assessPing0Run\(r\)\.exitCode\)/);
  });

  it("does not even access the existing connection until site authorization is explicit", async () => {
    const conn = new Proxy({}, { get() { throw new Error("Unauthorized connection access"); } }) as BidiConnection;
    expect(await collectPing0OnBidi(conn, contextId, { siteAccessAuthorized: false })).toMatchObject({
      outcome: "inconclusive", reason: "site-access-not-authorized", state: null,
    });
  });

  it.each([
    { waitTimeoutMs: 0 }, { waitTimeoutMs: 600001 }, { waitTimeoutMs: Number.NaN },
    { settleMs: -1 }, { settleMs: 300001 }, { settleMs: 0.5 },
  ])("rejects invalid bounds without connection access (%#)", async (invalid) => {
    const conn = new Proxy({}, { get() { throw new Error("Invalid-options connection access"); } }) as BidiConnection;
    expect(await collectPing0OnBidi(conn, contextId, { ...options, ...invalid })).toMatchObject({
      outcome: "inconclusive", reason: "invalid-options", state: null,
    });
  });

  it.each(["", "  ", null, undefined])("requires an explicit context rather than discovering another tab (%s)", async (id) => {
    const owned = syntheticConnection();
    expect(await collectPing0OnBidi(owned.conn, id as string, options)).toMatchObject({ reason: "invalid-options" });
    expect(owned.send).not.toHaveBeenCalled();
  });

  it("passes actual finished/settled/raw-row evidence without opening or owning the session", async () => {
    const owned = syntheticConnection();
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(result).toMatchObject({ outcome: "completed", reason: null, dnsObservations: [], dnsTransactionsVerified: false });
    expect(result.state).toMatchObject({
      finished: true, reportId: "synthetic-firefox-report", bodyText: "",
      finishedAt: "2026-10-17T00:00:00.000Z", settledAt: "2026-10-17T00:00:00.000Z",
      findings: [], rows: owned.data.rows,
    });
    expect(assessment(result)).toMatchObject({ exitCode: 0, assessment: { scope: "site-findings-only", status: "PASS", resolverCount: 2 } });
    expect(new Set(owned.send.mock.calls.map(([method]) => method))).toEqual(new Set(["browsingContext.getTree", "script.evaluate"]));
    expect(owned.close).not.toHaveBeenCalled();
  });

  it("only timestamps settling after the observed finish and the full settle delay", async () => {
    const owned = syntheticConnection();
    const done = vi.fn();
    const pending = collectPing0OnBidi(owned.conn, contextId, { ...options, settleMs: 50 }).then(done);
    await vi.advanceTimersByTimeAsync(49);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    const result: Ping0CollectionResult = done.mock.calls[0][0];
    expect(Date.parse(result.state!.settledAt) - Date.parse(result.state!.finishedAt)).toBe(50);
    expect(assessment(result).exitCode).toBe(0);
  });

  it.each([false, "true", 1, null, undefined])("never treats finished=%s as observed completion", async (finished) => {
    const owned = syntheticConnection({ finished });
    const pending = collectPing0OnBidi(owned.conn, contextId, { ...options, settleMs: 500 });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "wait-timeout" });
    expect(result.state).toMatchObject({ finishedAt: "", settledAt: "", status: "timeout" });
    expect(result.state?.finished).toBe(finished);
    expect(Date.now()).toBe(Date.parse("2026-10-17T00:00:00.010Z"));
    expect(assessment(result).exitCode).toBe(2);
  });

  it("preserves the deadline when a late capture sees finished=true", async () => {
    const owned = syntheticConnection({ finished: false });
    owned.evaluate.mockImplementationOnce(async (expression) => {
      const value = runInNewContext(expression, { document: { querySelector: () => ({ __vue__: { $data: owned.data } }) } });
      owned.data.finished = true;
      return value;
    });
    const pending = collectPing0OnBidi(owned.conn, contextId, options);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "wait-timeout", state: { finished: true, finishedAt: "", settledAt: "" } });
    expect(assessment(result).exitCode).toBe(2);
  });

  it("invalidates finish/settle evidence if the site resets before the final capture", async () => {
    const owned = syntheticConnection();
    const pending = collectPing0OnBidi(owned.conn, contextId, { ...options, settleMs: 50 });
    await vi.advanceTimersByTimeAsync(25);
    owned.data.finished = false;
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "state-not-finished", state: { finished: false, finishedAt: "", settledAt: "" } });
    expect(assessment(result).exitCode).toBe(2);
  });

  it.each(["stealth.raf_timing", "xc.dns_blackhole", "xc.dns_ip_country", "xc.ua_webgl"])("does not exempt failed %s even at score=100", async (id) => {
    const owned = syntheticConnection({ finalFindings: [{ id, fail: true, severity: "info" }] });
    owned.data.rows[id] = { fail: true, pending: false };
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(assessment(result)).toMatchObject({ exitCode: 1, assessment: { status: "FAIL", failedFindingIds: [id] } });
  });

  it("fails DNS0 despite finished=true, empty findings and a clear blackhole flag", async () => {
    const owned = syntheticConnection();
    owned.data.rows["dns.resolver_count"].value = 0;
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(assessment(result)).toMatchObject({ exitCode: 1, assessment: { status: "FAIL", resolverCount: 0 } });
  });

  it.each(["reportId", "rows", "finalFindings"])("does not turn missing %s into valid default evidence", async (field) => {
    const owned = syntheticConnection();
    delete owned.data[field];
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    if (field === "finalFindings") expect(result.state?.findings).toBeUndefined();
    else expect(result.state?.[field as "rows" | "reportId"]).toBeUndefined();
    expect(assessment(result)).toMatchObject({ exitCode: 2, assessment: { status: "INCONCLUSIVE" } });
  });

  it("retains invalid finalFindings rather than falling back to empty/older findings", async () => {
    const owned = syntheticConnection({ finalFindings: null, findings: [] });
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(result.state?.findings).toBeNull();
    expect(assessment(result).exitCode).toBe(2);
  });

  it("reads the legacy findings field only when finalFindings is absent", async () => {
    const owned = syntheticConnection({ findings: [{ id: "stealth.raf_timing", fail: true }] });
    delete owned.data.finalFindings;
    owned.data.rows["stealth.raf_timing"].fail = true;
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(assessment(result)).toMatchObject({ exitCode: 1, assessment: { status: "FAIL" } });
  });

  it("requires no pending rows and a real resolver_count row", async () => {
    const owned = syntheticConnection();
    owned.data.rows["late.probe"] = { pending: true };
    let result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(assessment(result)).toMatchObject({ exitCode: 2, assessment: { pendingRowIds: ["late.probe"] } });
    delete owned.data.rows["late.probe"];
    delete owned.data.rows["dns.resolver_count"];
    result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(assessment(result)).toMatchObject({ exitCode: 2, assessment: { status: "INCONCLUSIVE" } });
  });

  it.each(["https://other.example/env?token=private", "http://ping0.cc/env", "https://ping0.cc/other", "https://user:password@ping0.cc/env"])("does not evaluate a non-Ping0 context (%#)", async (url) => {
    const owned = syntheticConnection({}, url);
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(result).toMatchObject({ outcome: "failed", reason: "unexpected-page", state: null });
    expect(owned.evaluate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private|password|other\.example/);
    expect(assessment(result).exitCode).toBe(1);
  });

  it("checks the selected context again after settling rather than trusting a stale URL", async () => {
    const owned = syntheticConnection();
    const pending = collectPing0OnBidi(owned.conn, contextId, { ...options, settleMs: 50 });
    await vi.advanceTimersByTimeAsync(25);
    owned.setUrl("https://other.example/env");
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ outcome: "failed", reason: "unexpected-page", state: null });
    expect(owned.evaluate).toHaveBeenCalledTimes(1);
  });

  it.each(["wait", "capture"] as const)("reports %s evaluation failure, not a fabricated timeout", async (phase) => {
    const owned = syntheticConnection();
    if (phase === "capture") owned.evaluate.mockResolvedValueOnce({ finished: true });
    owned.evaluate.mockRejectedValueOnce(new Error("private page error"));
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(result).toMatchObject({ outcome: "failed", reason: `${phase}-failed`, state: null });
    expect(assessment(result).exitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private page error");
    expect(owned.close).not.toHaveBeenCalled();
  });

  it.each(["wait", "capture"] as const)("bounds a hung %s without closing the borrowed connection", async (phase) => {
    const owned = syntheticConnection();
    if (phase === "capture") owned.evaluate.mockResolvedValueOnce({ finished: true });
    owned.evaluate.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = collectPing0OnBidi(owned.conn, contextId, options);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "inconclusive", reason: `${phase}-timeout` });
    expect(assessment(result).exitCode).toBe(2);
    expect(owned.close).not.toHaveBeenCalled();
  });

  it("does not dispatch another wait probe when a timed-out getTree resolves late", async () => {
    const owned = syntheticConnection();
    let releaseTree!: (value: unknown) => void;
    owned.send.mockImplementationOnce(() => new Promise((resolve) => { releaseTree = resolve; }));
    const pending = collectPing0OnBidi(owned.conn, contextId, options);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ outcome: "inconclusive", reason: "wait-timeout" });
    const count = owned.send.mock.calls.length;
    releaseTree({ contexts: [{ context: contextId, url: "https://ping0.cc/env" }] });
    await vi.runAllTimersAsync();
    expect(owned.send).toHaveBeenCalledTimes(count);
    expect(owned.close).not.toHaveBeenCalled();
  });

  it("does not dispatch another context check after a timed-out capture resolves late", async () => {
    const owned = syntheticConnection();
    let releaseCapture!: (value: unknown) => void;
    owned.evaluate.mockResolvedValueOnce({ finished: true });
    owned.evaluate.mockImplementationOnce(() => new Promise((resolve) => { releaseCapture = resolve; }));
    const pending = collectPing0OnBidi(owned.conn, contextId, options);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ outcome: "inconclusive", reason: "capture-timeout", state: null });
    const count = owned.send.mock.calls.length;
    releaseCapture({ finished: true, rows: owned.data.rows, findings: [] });
    await vi.runAllTimersAsync();
    expect(owned.send).toHaveBeenCalledTimes(count);
    expect(owned.close).not.toHaveBeenCalled();
  });

  it.each([[], [{ context: "another-tab", url: "https://ping0.cc/env" }], [{ context: contextId }], null])(
    "does not fall back to another tab when scoped context evidence is absent or inconsistent (%#)", async (contexts) => {
      const owned = syntheticConnection();
      owned.send.mockResolvedValueOnce({ contexts });
      expect(await collectPing0OnBidi(owned.conn, contextId, options)).toMatchObject({ outcome: "failed", reason: "unexpected-page", state: null });
      expect(owned.evaluate).not.toHaveBeenCalled();
    },
  );

  it.each(["wait", "capture"] as const)("classifies a real BiDi %s command deadline as inconclusive", async (phase) => {
    const owned = syntheticConnection();
    if (phase === "capture") owned.evaluate.mockResolvedValueOnce({ finished: true });
    owned.evaluate.mockRejectedValueOnce(new Error("BiDi command script.evaluate timed out"));
    expect(await collectPing0OnBidi(owned.conn, contextId, options)).toMatchObject({ outcome: "inconclusive", reason: `${phase}-timeout` });
  });

  it("does not let legacy font diagnostics replace a page prototype method", () => {
    const source = readFileSync(new URL("../../src/tools/verify-ping0.ts", import.meta.url), "utf8");
    expect(source).not.toContain("ffs.check =");
  });

  it("does not change site rows, findings, completion flags, getters, or session ownership", async () => {
    const owned = syntheticConnection();
    const before = structuredClone(owned.data);
    const rejectWrite = new Proxy(owned.data, {
      set() { throw new Error("Collector changed site data"); },
      defineProperty() { throw new Error("Collector changed a site getter"); },
      deleteProperty() { throw new Error("Collector deleted site data"); },
    });
    owned.evaluate.mockImplementation(async (expression) => runInNewContext(expression, {
      document: { querySelector: () => ({ __vue__: { $data: rejectWrite } }), visibilityState: "visible", hasFocus: () => true },
    }));
    const result = await collectPing0OnBidi(owned.conn, contextId, options);
    expect(assessment(result).exitCode).toBe(0);
    expect(owned.data).toEqual(before);
    expect(owned.close).not.toHaveBeenCalled();
  });
});
