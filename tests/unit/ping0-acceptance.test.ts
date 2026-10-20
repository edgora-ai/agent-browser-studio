import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ping0CollectionResult, Ping0State } from "../../src/tools/verify-ping0.js";
import { assessPing0Findings } from "../../src/tools/ping0-acceptance.js";

const blocked = vi.hoisted(() => ({
  io: vi.fn(() => { throw new Error("External I/O is forbidden in this unit test"); }),
  exitCode: process.exitCode,
}));
vi.mock("node:child_process", () => ({ execFile: blocked.io, execFileSync: blocked.io, spawn: blocked.io }));
vi.mock("node:http", () => ({ get: blocked.io }));
vi.mock("node:net", () => ({ createServer: blocked.io }));
vi.mock("node:fs", () => ({
  existsSync: blocked.io, statSync: blocked.io, mkdtempSync: blocked.io,
  mkdirSync: blocked.io, writeFileSync: blocked.io, rmSync: blocked.io,
}));
vi.mock("playwright", () => ({ chromium: { connectOverCDP: blocked.io } }));
vi.mock("../../src/main/services/bidi-client.js", () => ({
  connectBidi: blocked.io, bidiAddPreloadScript: blocked.io, bidiCreateContext: blocked.io,
  bidiCloseContext: blocked.io, bidiGetTopContext: blocked.io, bidiEvaluateInContext: blocked.io,
  bidiNavigate: blocked.io, bidiActivateContext: blocked.io,
}));

import { assessPing0ChromiumRun, assessPing0FirefoxRun, assessPing0Run } from "../../src/tools/verify-ping0.js";

afterEach(() => {
  expect(blocked.io).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(blocked.exitCode);
  vi.clearAllMocks();
});

type SiteState = Pick<Ping0State, "finished" | "finishedAt" | "settledAt" | "reportId" | "rows" | "findings">;

// Synthetic page data only: no collector runtime, app, proxy, or site access.
function syntheticReport(state: Partial<SiteState> = {}) {
  return {
    outcome: "completed",
    reason: null,
    state: {
      finished: true,
      finishedAt: "2026-10-15T00:00:00.000Z",
      settledAt: "2026-10-15T00:00:00.050Z",
      reportId: "synthetic-report",
      rows: {
        "dns.resolver_count": { value: 2, pending: false },
        "xc.dns_blackhole": { fail: false, pending: false },
        "xc.ua_webgl": { fail: false, pending: false },
        "stealth.raf_timing": { fail: false, pending: false },
      },
      findings: [],
      ...state,
    },
    dnsObservations: [],
    dnsTransactionsVerified: false,
  } satisfies Omit<Ping0CollectionResult, "state"> & { state: SiteState };
}

function withRow(id: string, row: unknown) {
  const report = syntheticReport();
  return syntheticReport({ rows: { ...report.state.rows, [id]: row } });
}

function freezeTree(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
}

describe("Ping0 site-findings-only acceptance (synthetic only)", () => {
  it("passes a completed, settled page with reasonable raw rows and no failing findings", () => {
    expect(assessPing0Findings(syntheticReport())).toEqual({
      scope: "site-findings-only", status: "PASS", resolverCount: 2,
      failedFindingIds: [], pendingRowIds: [], reasons: [],
    });
  });

  it("accepts consistent non-failing findings backed by raw rows", () => {
    expect(assessPing0Findings(syntheticReport({ findings: [
      { id: "xc.dns_blackhole", fail: false }, { id: "xc.ua_webgl", fail: false },
    ] })).status).toBe("PASS");
  });

  it.each([0, 70, 100, null])("does not use raw score %s, level, or exitCode as an acceptance threshold", (score) => {
    const report = syntheticReport();
    expect(assessPing0Findings({ ...report, exitCode: 0, state: { ...report.state, score, level: "red" } }).status).toBe("PASS");
    expect(assessPing0Findings({
      ...report, exitCode: 0,
      state: { ...report.state, score, rows: { ...report.state.rows, "dns.resolver_count": { value: 0, pending: false } } },
    }).status).toBe("FAIL");
  });

  it("fails the completed zero-resolver / critical-blackhole / UA-WebGL / info-RAF baseline", () => {
    const report = syntheticReport();
    const ids = ["xc.dns_blackhole", "xc.ua_webgl", "stealth.raf_timing"];
    const result = assessPing0Findings(syntheticReport({
      rows: {
        ...report.state.rows,
        "dns.resolver_count": { value: 0, pending: false },
        ...Object.fromEntries(ids.map((id) => [id, { fail: true, pending: false }])),
      },
      findings: ids.map((id) => ({ id, fail: true, severity: id.startsWith("xc.") ? "critical" : "info" })),
    }));
    expect(result).toMatchObject({ status: "FAIL", scope: "site-findings-only", resolverCount: 0, pendingRowIds: [] });
    expect(result.failedFindingIds).toEqual([...ids].sort());
    expect(result.reasons).toContain("resolver-count-zero");
  });

  it.each(["xc.dns_blackhole", "xc.dns_ip_country", "xc.ua_webgl", "stealth.raf_timing"])("never exempts a failed %s finding", (id) => {
    const report = withRow(id, { fail: true, pending: false });
    const result = assessPing0Findings({ ...report, state: {
      ...report.state, findings: [{ id, fail: true, severity: "info" }],
    } });
    expect(result.status).toBe("FAIL");
    expect(result.failedFindingIds).toEqual([id]);
  });

  it("does not let empty findings hide a failing raw row", () => {
    const result = assessPing0Findings(withRow("xc.dns_blackhole", { fail: true, pending: false }));
    expect(result.status).toBe("FAIL");
    expect(result.failedFindingIds).toEqual(["xc.dns_blackhole"]);
  });

  it.each([-1, 1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "2", true, null, undefined])(
    "rejects invalid resolver count %s without coercion", (value) => {
      const result = assessPing0Findings(withRow("dns.resolver_count", { value, pending: false }));
      expect(result).toMatchObject({ status: "INCONCLUSIVE", resolverCount: null });
      expect(result.reasons).toContain("invalid-resolver-count");
    },
  );

  it("rejects count=1 with a zero-count blackhole value even when fail=false", () => {
    const report = withRow("dns.resolver_count", { value: 1, pending: false });
    report.state.rows["xc.dns_blackhole"] = { fail: false, pending: false, value: { resolver_count: 0 } };
    const result = assessPing0Findings(report);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.reasons).toContain("blackhole-resolver-count-conflict:row");
  });

  it("accepts matching optional blackhole counts without requiring those fields", () => {
    const report = withRow("xc.dns_blackhole", { fail: false, pending: false, value: { resolver_count: 2 } });
    report.state.findings = [{ id: "xc.dns_blackhole", fail: false, value: { resolver_count: 2 } }];
    expect(assessPing0Findings(report).status).toBe("PASS");
    report.state.rows["xc.dns_blackhole"] = { fail: false, pending: false, value: {} };
    report.state.findings = [{ id: "xc.dns_blackhole", fail: false, value: {} }];
    expect(assessPing0Findings(report).status).toBe("PASS");
  });

  it.each(["value", "direct"])("rejects contradictory blackhole finding counts (%s)", (location) => {
    const report = withRow("xc.dns_blackhole", { fail: false, pending: false, value: { resolver_count: 2 } });
    report.state.findings = [{
      id: "xc.dns_blackhole", fail: false,
      ...(location === "value" ? { value: { resolver_count: 0 } } : { resolver_count: 0 }),
    }];
    expect(assessPing0Findings(report).status).toBe("INCONCLUSIVE");
  });

  it.each([null, "2", -1, 1.5, Number.NaN, Infinity, undefined])("rejects illegal optional blackhole resolver_count %s in rows and findings", (resolver_count) => {
    const rowReport = withRow("xc.dns_blackhole", { fail: false, pending: false, value: { resolver_count } });
    expect(assessPing0Findings(rowReport).status).toBe("INCONCLUSIVE");
    const findingReport = syntheticReport({ findings: [{ id: "xc.dns_blackhole", fail: false, value: { resolver_count } }] });
    expect(assessPing0Findings(findingReport).status).toBe("INCONCLUSIVE");
  });

  it.each([0, 1, "false", "true", null, undefined])("does not coerce non-boolean fail %s when comparing rows and findings", (fail) => {
    const report = withRow("xc.dns_blackhole", { fail, pending: false });
    report.state.findings = [{ id: "xc.dns_blackhole", fail: false }];
    expect(assessPing0Findings(report).status).toBe("INCONCLUSIVE");
    report.state.rows["xc.dns_blackhole"] = { fail: false, pending: false };
    report.state.findings = [{ id: "xc.dns_blackhole", fail }];
    expect(assessPing0Findings(report).status).toBe("INCONCLUSIVE");
  });

  it.each(["dns.resolver_count", "xc.dns_blackhole"])("requires the %s raw row", (id) => {
    const report = syntheticReport();
    delete report.state.rows[id];
    const result = assessPing0Findings(report);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.reasons).toContain("missing-required-row:" + id);
  });

  it.each([undefined, null, "false", 0])("requires an explicit boolean blackhole fail flag (%s)", (fail) => {
    expect(assessPing0Findings(withRow("xc.dns_blackhole", { fail, pending: false })).status).toBe("INCONCLUSIVE");
  });

  it.each(["dns.resolver_count", "xc.dns_blackhole", "unrelated.probe"])("blocks pending row %s regardless of completed=true", (id) => {
    const report = syntheticReport();
    const previous = report.state.rows[id];
    const result = assessPing0Findings(withRow(id, { ...(previous as object), pending: true }));
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.pendingRowIds).toEqual([id]);
    expect(result.reasons).toContain("pending-row:" + id);
  });

  it("keeps pending evidence inconclusive even when another raw row fails", () => {
    const report = withRow("xc.dns_blackhole", { fail: true, pending: false });
    report.state.rows["late.probe"] = { pending: true };
    expect(assessPing0Findings(report)).toMatchObject({
      status: "INCONCLUSIVE", failedFindingIds: ["xc.dns_blackhole"], pendingRowIds: ["late.probe"],
    });
  });

  it.each(["inconclusive", "failed", undefined, true])("does not equate outcome %s with completed", (outcome) => {
    expect(assessPing0Findings({ ...syntheticReport(), outcome }).status).toBe("INCONCLUSIVE");
  });

  it.each(["wait-timeout", "navigation-timeout", "capture-timeout", "state-not-finished"])("preserves collector reason %s even with a late finished flag", (reason) => {
    expect(assessPing0Findings({ ...syntheticReport(), reason }).status).toBe("INCONCLUSIVE");
  });

  it("rejects a reset/timeout snapshot instead of trusting the stale completion envelope", () => {
    expect(assessPing0Findings(syntheticReport({ finished: false, finishedAt: "", settledAt: "" })).status).toBe("INCONCLUSIVE");
  });

  it.each([false, "true", 1, null, undefined])("requires finished === true (%s)", (finished) => {
    const report = syntheticReport();
    expect(assessPing0Findings({ ...report, state: { ...report.state, finished } }).status).toBe("INCONCLUSIVE");
  });

  it.each(["", "  ", null, undefined, 123])("rejects missing/invalid reportId %s", (reportId) => {
    const report = syntheticReport();
    expect(assessPing0Findings({ ...report, state: { ...report.state, reportId } }).status).toBe("INCONCLUSIVE");
  });

  it.each(["", "  ", "not-a-date", "1", "2026-02-30T00:00:00.000Z", null, undefined, 1, true])(
    "requires a real collector-format settled timestamp (%s)", (settledAt) => {
      const report = syntheticReport();
      expect(assessPing0Findings({ ...report, state: { ...report.state, settledAt } }).status).toBe("INCONCLUSIVE");
    },
  );

  it("requires an observed finish timestamp no later than settling", () => {
    expect(assessPing0Findings(syntheticReport({ finishedAt: "" })).status).toBe("INCONCLUSIVE");
    expect(assessPing0Findings(syntheticReport({ settledAt: "2026-10-14T00:00:00.000Z" })).reasons).toContain("settled-before-finished");
  });

  it.each([null, undefined, false, 100, "completed", [], {}])("rejects empty/forged collection %s", (input) => {
    expect(assessPing0Findings(input).status).toBe("INCONCLUSIVE");
  });

  it.each([null, undefined, false, [], "done"])("requires a state object (%s)", (state) => {
    expect(assessPing0Findings({ ...syntheticReport(), state }).status).toBe("INCONCLUSIVE");
  });

  it.each([null, undefined, [], 1, "rows", {}])("does not green empty/invalid rows with empty findings (%s)", (rows) => {
    const report = syntheticReport();
    expect(assessPing0Findings({ ...report, state: { ...report.state, rows } }).status).toBe("INCONCLUSIVE");
  });

  it.each([null, [], "pass", { pending: "false" }, { pending: false, fail: "false" }, { pending: false, id: "other" }])(
    "rejects malformed raw rows (%s)", (row) => {
      expect(assessPing0Findings(withRow("extra.probe", row)).status).toBe("INCONCLUSIVE");
    },
  );

  it.each([null, undefined, {}, "findings", [null], ["pass"], [{}], [{ id: "", fail: false }], [{ id: "xc.ua_webgl", fail: "false" }], new Array(1)])(
    "rejects malformed findings (%s)", (findings) => {
      const report = syntheticReport();
      expect(assessPing0Findings({ ...report, state: { ...report.state, findings } }).status).toBe("INCONCLUSIVE");
    },
  );

  it("rejects duplicate findings", () => {
    const finding = { id: "xc.ua_webgl", fail: false };
    expect(assessPing0Findings(syntheticReport({ findings: [finding, finding] })).reasons).toContain("duplicate-finding:xc.ua_webgl");
  });

  it.each([true, false])("never passes contradictory rows/findings (finding.fail=%s)", (fail) => {
    const report = withRow("xc.ua_webgl", { fail: !fail, pending: false });
    const result = assessPing0Findings({ ...report, state: { ...report.state, findings: [{ id: "xc.ua_webgl", fail }] } });
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.failedFindingIds).toEqual(["xc.ua_webgl"]);
    expect(result.reasons).toContain("row-finding-conflict:xc.ua_webgl");
  });

  it.each([true, false])("requires a raw row behind every finding (fail=%s)", (fail) => {
    expect(assessPing0Findings(syntheticReport({ findings: [{ id: "missing.probe", fail }] })).status).toBe("INCONCLUSIVE");
  });

  it("requires comparable fail flags, not just raw row presence", () => {
    const report = withRow("xc.ua_webgl", { pending: false });
    expect(assessPing0Findings({ ...report, state: { ...report.state, findings: [{ id: "xc.ua_webgl", fail: false }] } }).status).toBe("INCONCLUSIVE");
  });

  it("does not accept inherited collection or row evidence", () => {
    const report = syntheticReport();
    expect(assessPing0Findings(Object.create(report)).status).toBe("INCONCLUSIVE");
    expect(assessPing0Findings(syntheticReport({ rows: Object.create(report.state.rows) })).status).toBe("INCONCLUSIVE");
  });

  it("does not modify any input rows, findings, metadata, or collector fields", () => {
    const report = withRow("xc.dns_blackhole", { fail: true, pending: false, value: { resolver_count: 2 }, details: { values: [0, 1] } });
    report.state.findings = [{ id: "xc.dns_blackhole", fail: true, severity: "critical" }];
    const before = structuredClone(report);
    freezeTree(report);
    const first = assessPing0Findings(report);
    expect(first.status).toBe("FAIL");
    expect(assessPing0Findings(report)).toEqual(first);
    first.failedFindingIds.push("not-input");
    first.reasons.push("not-input");
    expect(report).toEqual(before);
    expect(assessPing0Findings(report).failedFindingIds).toEqual(["xc.dns_blackhole"]);
  });
});

describe.each([
  ["Chromium compatibility", assessPing0ChromiumRun],
  ["engine-neutral", assessPing0Run],
  ["Firefox", assessPing0FirefoxRun],
] as const)("%s split-report assessment and CLI exit-code mapping", (_entry, assessRun) => {
  it("imports the verifier without starting main or changing process exitCode", () => {
    expect(typeof assessRun).toBe("function");
  });

  it("maps a complete legal split report to exit 0 with a scope-only assessment", () => {
    const { state, ...collection } = syntheticReport();
    expect(assessRun({ collection, state })).toEqual({
      assessment: assessPing0Findings({ ...collection, state }), exitCode: 0,
    });
  });

  it.each(["xc.dns_blackhole", "xc.dns_ip_country", "stealth.raf_timing"])("maps completed + score 100 + failed %s to exit 1 without exemptions", (id) => {
    const { state, ...collection } = withRow(id, { fail: true, pending: false });
    const result = assessRun({ collection, state: {
      ...state, score: 100, findings: [{ id, fail: true }],
    } });
    expect(result).toMatchObject({
      exitCode: 1, assessment: { scope: "site-findings-only", status: "FAIL", failedFindingIds: [id] },
    });
  });

  it("maps completed + score 100 + zero DNS resolvers to exit 1", () => {
    const { state, ...collection } = withRow("dns.resolver_count", { value: 0, pending: false });
    expect(assessRun({ collection, state: { ...state, score: 100 } })).toMatchObject({
      exitCode: 1, assessment: { status: "FAIL", resolverCount: 0 },
    });
  });

  it("maps missing state or collection to exit 2", () => {
    const { state, ...collection } = syntheticReport();
    expect(assessRun({ collection })).toMatchObject({ exitCode: 2, assessment: { status: "INCONCLUSIVE" } });
    expect(assessRun({ state }).exitCode).toBe(2);
  });

  it.each(["dns.resolver_count", "xc.dns_blackhole"])("maps missing %s raw evidence to exit 2", (id) => {
    const { state, ...collection } = syntheticReport();
    delete state.rows[id];
    expect(assessRun({ collection, state })).toMatchObject({ exitCode: 2, assessment: { status: "INCONCLUSIVE" } });
  });

  it.each(["finished", "finishedAt", "settledAt", "findings"])("maps missing %s evidence to exit 2, not a default PASS", (field) => {
    const { state, ...collection } = syntheticReport();
    const missing: Record<string, unknown> = { ...state };
    delete missing[field];
    expect(assessRun({ collection, state: missing })).toMatchObject({
      exitCode: 2, assessment: { scope: "site-findings-only", status: "INCONCLUSIVE" },
    });
  });

  it("maps a pending raw row to exit 2 despite finished=true and score=100", () => {
    const { state, ...collection } = withRow("late.probe", { pending: true });
    expect(assessRun({ collection, state: { ...state, score: 100 } })).toMatchObject({
      exitCode: 2, assessment: { status: "INCONCLUSIVE", pendingRowIds: ["late.probe"] },
    });
  });

  it("retains failed-collection exit 1 ahead of an inconclusive/absent site assessment", () => {
    expect(assessRun({
      collection: { outcome: "failed", reason: "navigation-failed" }, state: null,
    })).toMatchObject({ exitCode: 1, assessment: { status: "INCONCLUSIVE" } });
  });

  it("maps an inconclusive collection to exit 2 despite a late complete state", () => {
    expect(assessRun({
      collection: { outcome: "inconclusive", reason: "wait-timeout" }, state: syntheticReport().state,
    })).toMatchObject({ exitCode: 2, assessment: { status: "INCONCLUSIVE" } });
  });

  it("uses the report's separated state, not a stale nested collection.state", () => {
    const { state, ...collection } = syntheticReport();
    const staleCollection = { ...collection, state };
    expect(assessRun({ collection: staleCollection, state: null }).exitCode).toBe(2);
  });

  it("keeps split report data and raw rows unchanged", () => {
    const { state, ...collection } = syntheticReport();
    const report = { collection, state };
    const before = structuredClone(report);
    freezeTree(report);
    expect(assessRun(report).exitCode).toBe(0);
    expect(report).toEqual(before);
  });
});
