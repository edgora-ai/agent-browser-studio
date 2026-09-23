// M2 unit tests: AgentRunVerification / artifact / templateInputs normalization.
// The normalizer is the trust boundary — a persisted "passed" must never
// survive unless the whole structure is complete and internally consistent.
import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

// pid-suffixed: concurrent vitest processes must not share one config store.
const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-m2-normalize-test-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
}));

import { mergeConfigForStore } from "../../src/main/services/config-manager.js";
import type { AgentRunVerification } from "../../src/main/types.js";

function baseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run_norm1",
    name: "normalize probe",
    source: { type: "automation", ruleId: "rule_abc" },
    status: "done",
    startedAt: 100,
    finishedAt: 200,
    steps: [],
    variables: {},
    ...overrides,
  };
}

function normalizeRuns(rawRuns: unknown): any[] {
  const merged = mergeConfigForStore({ agentRuns: rawRuns }, "save");
  return (merged as any).agentRuns || [];
}

function normalizeOne(run: Record<string, unknown>): any {
  const runs = normalizeRuns([run]);
  expect(runs).toHaveLength(1);
  return runs[0];
}

const CLEAN_COUNTS = { expected: 20, observed: 20, inspected: 20, accepted: 20, rejected: 0, missing: 0, extra: 0 };
const PARTIAL_COUNTS = { expected: 20, observed: 20, inspected: 20, accepted: 18, rejected: 2, missing: 0, extra: 0 };
const FAILED_COUNTS = { expected: 20, observed: 2, inspected: 2, accepted: 0, rejected: 2, missing: 18, extra: 0 };

function autoVerification(status: "passed" | "partial" | "failed", counts: Record<string, number>): Record<string, unknown> {
  return {
    status,
    verifierId: "news-collect.dataset",
    verifierVersion: 1,
    checkedAt: 1700000000000,
    counts,
    issues: [],
    issuesTruncated: false,
  };
}

describe("normalizeAgentRunVerification", () => {
  it("keeps unverified and degrades missing/unknown/future statuses", () => {
    expect(normalizeOne(baseRun()).verification).toEqual({ status: "unverified" });
    expect(normalizeOne(baseRun({ verification: { status: "unverified" } })).verification)
      .toEqual({ status: "unverified" });
    expect(normalizeOne(baseRun({ verification: { status: "verified" } })).verification)
      .toEqual({ status: "unverified" });
    expect(normalizeOne(baseRun({ verification: "passed" })).verification)
      .toEqual({ status: "unverified" });
    expect(normalizeOne(baseRun({ verification: null })).verification)
      .toEqual({ status: "unverified" });
  });

  it("round-trips a complete passed verification", () => {
    const v = autoVerification("passed", CLEAN_COUNTS);
    const run = normalizeOne(baseRun({ verification: v }));
    expect(run.verification).toEqual({
      status: "passed",
      verifierId: "news-collect.dataset",
      verifierVersion: 1,
      checkedAt: 1700000000000,
      counts: CLEAN_COUNTS,
      issues: [],
      issuesTruncated: false,
    });
  });

  it("round-trips partial and failed with consistent counts", () => {
    expect(normalizeOne(baseRun({ verification: autoVerification("partial", PARTIAL_COUNTS) })).verification.status)
      .toBe("partial");
    expect(normalizeOne(baseRun({ verification: autoVerification("failed", FAILED_COUNTS) })).verification.status)
      .toBe("failed");
  });

  it("degrades when count invariants are violated", () => {
    const cases: Array<[string, Record<string, number>]> = [
      ["inspected !== observed", { ...CLEAN_COUNTS, inspected: 19 }],
      ["accepted+rejected !== inspected", { ...CLEAN_COUNTS, accepted: 19 }],
      ["missing !== expected-observed", { ...FAILED_COUNTS, missing: 5 }],
      ["extra !== observed-expected", { ...CLEAN_COUNTS, extra: 1 }],
      ["negative value", { ...CLEAN_COUNTS, rejected: -1 }],
      ["non-integer value", { ...CLEAN_COUNTS, accepted: 19.5 }],
    ];
    for (const [label, counts] of cases) {
      const status = label.startsWith("missing") ? "failed" : "passed";
      expect(normalizeOne(baseRun({ verification: autoVerification(status as any, counts) })).verification, label)
        .toEqual({ status: "unverified" });
    }
  });

  it("degrades when status disagrees with counts", () => {
    // passed with rejections / shortfalls
    expect(normalizeOne(baseRun({ verification: autoVerification("passed", PARTIAL_COUNTS) })).verification)
      .toEqual({ status: "unverified" });
    // failed but something was accepted
    expect(normalizeOne(baseRun({ verification: autoVerification("failed", PARTIAL_COUNTS) })).verification)
      .toEqual({ status: "unverified" });
    // failed with nothing expected (vacuous)
    expect(normalizeOne(baseRun({
      verification: autoVerification("failed", { expected: 0, observed: 0, inspected: 0, accepted: 0, rejected: 0, missing: 0, extra: 0 }),
    })).verification).toEqual({ status: "unverified" });
    // partial with zero accepted
    expect(normalizeOne(baseRun({ verification: autoVerification("partial", FAILED_COUNTS) })).verification)
      .toEqual({ status: "unverified" });
    // partial that is actually a clean sweep (must be reported as passed)
    expect(normalizeOne(baseRun({ verification: autoVerification("partial", CLEAN_COUNTS) })).verification)
      .toEqual({ status: "unverified" });
  });

  it("degrades on malformed auto-state fields", () => {
    const good = autoVerification("passed", CLEAN_COUNTS);
    const mutations: Array<[string, Record<string, unknown>]> = [
      ["verifierId too long", { verifierId: "x".repeat(81) }],
      ["verifierId illegal chars", { verifierId: "bad id!" }],
      ["verifierVersion zero", { verifierVersion: 0 }],
      ["verifierVersion fractional", { verifierVersion: 1.5 }],
      ["checkedAt NaN", { checkedAt: Number.NaN }],
      ["checkedAt negative", { checkedAt: -1 }],
      ["issues not an array", { issues: "nope" }],
      ["issue without code", { issues: [{ detail: "d" }] }],
      ["issue detail not a string", { issues: [{ code: "c", detail: 42 }] }],
    ];
    for (const [label, patch] of mutations) {
      expect(normalizeOne(baseRun({ verification: { ...good, ...patch } })).verification, label)
        .toEqual({ status: "unverified" });
    }
  });

  it("caps issues at 100 and marks truncation", () => {
    const issues = Array.from({ length: 150 }, (_, i) => ({ code: "invalid_url", item: `u${i}` }));
    const run = normalizeOne(baseRun({
      verification: { ...autoVerification("partial", PARTIAL_COUNTS), issues },
    }));
    expect(run.verification.status).toBe("partial");
    expect(run.verification.issues).toHaveLength(100);
    expect(run.verification.issuesTruncated).toBe(true);
  });

  it("round-trips manual_review with reasonCode and optional verifier identity", () => {
    const v: AgentRunVerification = {
      status: "manual_review",
      checkedAt: 1700000000000,
      reasonCode: "input_unavailable",
      verifierId: "news-collect.dataset",
      verifierVersion: 1,
      issues: [{ code: "missing_input", field: "sourceUrl" }],
    };
    expect(normalizeOne(baseRun({ verification: v })).verification).toEqual({
      ...v,
      issuesTruncated: false,
    });
  });

  it("degrades manual_review without a valid reasonCode or checkedAt", () => {
    expect(normalizeOne(baseRun({ verification: { status: "manual_review", checkedAt: 1 } })).verification)
      .toEqual({ status: "unverified" });
    expect(normalizeOne(baseRun({
      verification: { status: "manual_review", checkedAt: 1, reasonCode: "has space" },
    })).verification).toEqual({ status: "unverified" });
    expect(normalizeOne(baseRun({
      verification: { status: "manual_review", reasonCode: "input_unavailable" },
    })).verification).toEqual({ status: "unverified" });
  });
});

describe("normalizeAgentRunArtifacts", () => {
  const sha = "a".repeat(64);
  const validRef = {
    id: "art_dataset",
    kind: "dataset",
    name: "news dataset",
    mediaType: "application/json",
    createdAt: 1700000000000,
    bytes: 1234,
    sha256: sha,
    completeness: "complete",
    truncated: false,
    exportPolicy: "csv",
    rowCount: 18,
    sourceRowCount: 20,
    rejectedRowCount: 2,
    columns: ["title", "url", "source", "published_at"],
  };

  it("round-trips a valid artifact reference", () => {
    const run = normalizeOne(baseRun({ artifacts: [validRef] }));
    expect(run.artifacts).toEqual([validRef]);
  });

  it("keeps runs without artifacts free of the key", () => {
    const run = normalizeOne(baseRun());
    expect("artifacts" in run).toBe(false);
  });

  it("drops malformed entries but keeps valid siblings", () => {
    const run = normalizeOne(baseRun({
      artifacts: [
        { ...validRef, id: "bad id!" },
        { ...validRef, sha256: "not-a-hash" },
        validRef,
        { ...validRef, kind: "blob" },
        { ...validRef, exportPolicy: "everything" },
        { ...validRef, bytes: -1 },
        { ...validRef, rowCount: -2 },
      ],
    }));
    expect(run.artifacts).toEqual([validRef]);
  });

  it("caps artifact references at 16", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...validRef, id: `art_${i}` }));
    const run = normalizeOne(baseRun({ artifacts: many }));
    expect(run.artifacts).toHaveLength(16);
  });

  it("drops a non-array artifacts container", () => {
    const run = normalizeOne(baseRun({ artifacts: "bogus" }));
    expect("artifacts" in run).toBe(false);
  });
});

describe("normalizeAgentRunSource template identity", () => {
  it("round-trips templateId/templateVersion and drops malformed versions", () => {
    const run = normalizeOne(baseRun({
      source: { type: "automation", ruleId: "rule_abc", templateId: "news-collect", templateVersion: 1 },
    }));
    expect(run.source.templateId).toBe("news-collect");
    expect(run.source.templateVersion).toBe(1);

    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      const r = normalizeOne(baseRun({
        source: { type: "automation", templateId: "news-collect", templateVersion: bad },
      }));
      expect(r.source.templateVersion).toBeUndefined();
      expect(r.source.templateId).toBe("news-collect");
    }
  });
});

describe("normalizeTemplateInputs (automation rules)", () => {
  function ruleWithInputs(templateInputs: unknown): Record<string, unknown> {
    return {
      id: "rule_inputs1",
      name: "inputs probe",
      enabled: true,
      trigger: { type: "once", at: 1700000000000 },
      action: { type: "agent-task", profileDirId: "p1", templateId: "news-collect", agentPrompt: "p", templateInputs },
      createdAt: 1,
    };
  }

  function normalizeRule(rule: unknown): any {
    const merged = mergeConfigForStore({ automation: [rule] }, "save");
    return (merged as any).automation?.[0];
  }

  it("round-trips a valid input set", () => {
    const rule = normalizeRule(ruleWithInputs({ sourceUrl: "https://example.com/feed", limit: "10" }));
    expect(rule.action.templateInputs).toEqual({ sourceUrl: "https://example.com/feed", limit: "10" });
  });

  it("drops the whole set when any bound is violated", () => {
    const cases: Array<[string, unknown]> = [
      ["too many keys", Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))],
      ["oversized value", { sourceUrl: "x".repeat(2049) }],
      ["oversized key", { ["k".repeat(65)]: "v" }],
      ["non-string value", { sourceUrl: 42 }],
      ["key with surrounding whitespace", { " sourceUrl": "v" }],
      ["total over 8 KiB", Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, "x".repeat(2000)]))],
    ];
    for (const [label, inputs] of cases) {
      const rule = normalizeRule(ruleWithInputs(inputs));
      expect(rule.action.templateInputs, label).toBeUndefined();
    }
  });

  it("treats empty/absent/non-object inputs as absent", () => {
    for (const inputs of [{}, undefined, "nope", [1]]) {
      const rule = normalizeRule(ruleWithInputs(inputs));
      expect(rule.action.templateInputs).toBeUndefined();
    }
  });
});
