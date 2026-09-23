import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ runs: [] as any[] }));

vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => ({}),
}));
vi.mock("../../src/main/services/agent-run-trace.js", () => ({
  agentRunRecorder: { listRuns: () => h.runs },
}));
vi.mock("../../src/main/services/job-store.js", () => ({
  listJobs: () => [],
}));
vi.mock("../../src/main/services/agent-db.js", () => ({
  agentDbTables: () => [],
}));
vi.mock("../../src/main/services/observability.js", () => ({
  redactSensitive: (value: unknown) => value,
}));

import { exportData, isExportScope, EXPORT_SCOPES } from "../../src/main/services/data-export.js";

describe("M1 persistence metadata export", () => {
  it("exports only the safe run scope and terminal metadata", () => {
    h.runs = [{
      id: "run_export_1",
      dirId: "profile_a",
      name: "Exported run",
      summary: "summary",
      source: { type: "chat", conversationId: "conv_1" },
      status: "error",
      endReason: "timeout",
      verification: { status: "unverified", injected: "drop-me" },
      startedAt: 100,
      finishedAt: 200,
      steps: [],
      variables: {},
      privateField: "drop-me",
    }];

    const exported = exportData("runs").data.runs[0];
    expect(exported).toMatchObject({
      id: "run_export_1",
      dirId: "profile_a",
      status: "error",
      endReason: "timeout",
      verification: { status: "unverified" },
    });
    expect(exported.verification).toEqual({ status: "unverified" });
    expect(exported.privateField).toBeUndefined();
  });

  // ── M2 ──

  it("projects a real verification into the export with bounded fields only", () => {
    h.runs = [{
      id: "run_export_2",
      name: "Graded run",
      source: { type: "automation", ruleId: "rule_x", templateId: "news-collect", templateVersion: 1 },
      status: "done",
      endReason: "completed",
      verification: {
        status: "partial",
        verifierId: "news-collect.dataset",
        verifierVersion: 1,
        checkedAt: 1700000000000,
        counts: { expected: 3, observed: 3, inspected: 3, accepted: 2, rejected: 1, missing: 0, extra: 0 },
        // Issue detail is scraped-content prose — the export keeps codes only.
        issues: [
          { code: "invalid_timestamp", item: "https://x/?token=SECRET", field: "published_at", detail: "SECRET-DETAIL" },
          { code: "invalid_timestamp", item: "b", detail: "dup code" },
        ],
        issuesTruncated: false,
        injected: "drop-me",
      },
      artifacts: [{
        id: "dataset",
        kind: "dataset",
        name: "dataset.json",
        mediaType: "application/json",
        createdAt: 1,
        bytes: 100,
        sha256: "a".repeat(64),
        completeness: "partial",
        truncated: true,
        rowCount: 2,
        columns: ["title", "url"],
        exportPolicy: "csv",
        injected: "drop-me",
      }],
      startedAt: 100,
      finishedAt: 200,
      steps: [],
      variables: {},
    }];

    const exported = exportData("runs").data.runs[0];
    expect(exported.verification.status).toBe("partial");
    expect(exported.verification.counts).toEqual({ expected: 3, observed: 3, inspected: 3, accepted: 2, rejected: 1, missing: 0, extra: 0 });
    expect(exported.verification.issueCodes).toEqual(["invalid_timestamp"]);
    expect(exported.verification.injected).toBeUndefined();
    // Artifact metadata, never payload bytes or a filesystem path.
    expect(exported.artifacts).toHaveLength(1);
    expect(exported.artifacts[0]).toMatchObject({ id: "dataset", rowCount: 2, truncated: true, completeness: "partial" });
    expect(exported.artifacts[0].injected).toBeUndefined();
    expect(JSON.stringify(exported)).not.toContain("SECRET");
    expect(JSON.stringify(exported)).not.toContain("drop-me");
  });

  it("degrades a malformed verification to unverified instead of exporting it", () => {
    h.runs = [{
      id: "run_export_3",
      name: "Bad run",
      source: { type: "chat" },
      status: "done",
      // "passed" with no counts at all — the shape the normalizer would never
      // persist, but a foreign config could still carry.
      verification: { status: "passed", injected: "drop-me" },
      startedAt: 100,
      finishedAt: 200,
      steps: [],
      variables: {},
    }];
    const exported = exportData("runs").data.runs[0];
    expect(exported.verification).toEqual({ status: "unverified" });
  });

  it("recognizes only the documented export scopes", () => {
    expect(isExportScope("runs")).toBe(true);
    expect(isExportScope("all")).toBe(true);
    expect(isExportScope("everything")).toBe(false);
    expect(isExportScope("")).toBe(false);
    expect(isExportScope(undefined)).toBe(false);
    expect(isExportScope(42)).toBe(false);
    expect([...EXPORT_SCOPES]).toContain("risk");
  });
});
