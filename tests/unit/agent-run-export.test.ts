// M2-7 unit tests: run-result export.
//
// Covers the parts where a mistake is a real defect, not a formatting nit:
//   - CSV formula injection: every shape a spreadsheet would execute must come
//     out prefixed, and the prefix must survive RFC 4180 quoting.
//   - Summary JSON: metadata only. No variable VALUES, no step args/results,
//     no prompts, no error text.
//   - The plan is honest: partial/truncated artifacts and manual_review
//     verdicts are surfaced as warnings before anything is written.
//   - Integrity: a tampered payload fails export rather than being written.
//   - Path guard: extension allowlist, symlink and escape rejection.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// pid-suffixed: this file writes real export destinations and a real
// agent-results tree, so concurrent vitest processes must not share the path.
const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-m2-export-test-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { runResultStore } from "../../src/main/services/run-result-store.js";
import { buildSummary, datasetToCsv, needsFormulaGuard, planExport, writeExport } from "../../src/main/services/agent-run-export.js";
import { assertSafeRunExportPath } from "../../src/main/services/local-export-path-guard.js";
import { assertSafeArchiveExportPath } from "../../src/main/services/archive-path-guard.js";
import { reloadConfig } from "../../src/main/services/config-manager.js";
import type { AgentRunVerification } from "../../src/main/types.js";
import type { DatasetEnvelope } from "../../src/main/services/run-result-store.js";

const PASSED: AgentRunVerification = {
  status: "passed",
  verifierId: "news-collect.dataset",
  verifierVersion: 1,
  checkedAt: 1700000000000,
  counts: { expected: 2, observed: 2, inspected: 2, accepted: 2, rejected: 0, missing: 0, extra: 0 },
  issues: [],
  issuesTruncated: false,
};

function envelope(rows: string[][], over: Partial<DatasetEnvelope> = {}): DatasetEnvelope {
  return {
    schemaVersion: 1,
    kind: "dataset",
    runId: "run_x",
    artifactId: "dataset",
    name: "dataset",
    columns: ["title", "url", "source", "published_at"],
    rows,
    sourceRowCount: rows.length,
    rejectedRowCount: 0,
    truncated: false,
    ...over,
  };
}

/** Commit a real run + dataset so plan/write exercise the real store. */
function commitRun(opts: {
  name?: string;
  rows?: string[][];
  verification?: AgentRunVerification;
  truncated?: boolean;
} = {}): { runId: string } {
  const run = agentRunRecorder.startRun({
    source: { type: "automation", ruleId: "rule_x", ruleName: "News", templateId: "news-collect", templateVersion: 1 },
    name: opts.name ?? "News",
    dirId: "profile_a",
  });
  const rows = opts.rows ?? [["A", "https://example.com/a", "S", "2026-09-19"], ["B", "https://example.com/b", "S", "2026-09-19"]];
  const res = runResultStore.commitRunResult({
    runId: run.id,
    runStartedAt: run.startedAt,
    templateId: "news-collect",
    templateVersion: 1,
    verification: opts.verification ?? PASSED,
    terminal: { status: "done", endReason: "completed", finishedAt: Date.now() },
    dataset: {
      columns: ["title", "url", "source", "published_at"],
      rows: rows.map((r) => ({ title: r[0], url: r[1], source: r[2], published_at: r[3] })),
      sourceRowCount: rows.length,
      rejectedRowCount: 0,
      truncated: opts.truncated === true,
      ...(opts.truncated ? { truncationReason: "run_quota" } : {}),
    },
  });
  if (!res.ok) throw new Error(`commit failed: ${res.reasonCode} ${res.detail}`);
  agentRunRecorder.finishRun(run.id, "done", undefined, {
    endReason: "completed",
    verification: opts.verification ?? PASSED,
    artifacts: res.artifacts,
  });
  return { runId: run.id };
}

beforeEach(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  reloadConfig();
});
afterEach(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  reloadConfig();
});

describe("CSV formula injection", () => {
  it("flags every spreadsheet-executable lead character", () => {
    for (const cell of ["=1+1", "+1", "-1", "@SUM(A1)", "=cmd|'/c calc'!A0"]) {
      expect(needsFormulaGuard(cell), cell).toBe(true);
    }
    // Leading whitespace does not disarm the formula.
    for (const cell of [" =1+1", "\t=1+1", "\r=1+1", "   @x"]) {
      expect(needsFormulaGuard(cell), JSON.stringify(cell)).toBe(true);
    }
    expect(needsFormulaGuard("\tplain")).toBe(true);
    expect(needsFormulaGuard("\rplain")).toBe(true);
    // Ordinary text, and a hyphen that is not in the lead position.
    expect(needsFormulaGuard("plain")).toBe(false);
    expect(needsFormulaGuard("2026-09-19")).toBe(false);
    expect(needsFormulaGuard("a-b")).toBe(false);
    expect(needsFormulaGuard("")).toBe(false);
  });

  it("prefixes executable cells BEFORE quoting so the guard survives parsing", () => {
    const { csv } = datasetToCsv(envelope([["=1+1", "https://e.com/a", "S", "2026-09-19"]]));
    const lines = csv.split("\r\n");
    expect(lines[1].startsWith("'=1+1,")).toBe(true);
    // A formula containing a comma must be quoted AND prefixed. RFC 4180
    // doubles only double-quotes, so the single quotes stay as written.
    const { csv: csv2 } = datasetToCsv(envelope([[`=cmd|',calc'!A0`, "https://e.com/b", "S", "2026-09-19"]]));
    expect(csv2.split("\r\n")[1].startsWith(`"'=cmd|',calc'!A0"`)).toBe(true);
  });

  it("writes RFC 4180: CRLF line ends, doubled quotes, header row", () => {
    const { csv, rowsWritten } = datasetToCsv(envelope([
      ['He said "hi", twice', "https://e.com/a", "S", "2026-09-19"],
      ["B", "https://e.com/b", "S", "2026-09-19"],
    ]));
    expect(rowsWritten).toBe(2);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")[0]).toBe("title,url,source,published_at");
    expect(csv).toContain('"He said ""hi"", twice"');
    // No bare \n anywhere.
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("summary JSON", () => {
  it("carries metadata but no variable values, step args, or error text", () => {
    const run = agentRunRecorder.startRun({
      source: { type: "automation", ruleId: "rule_x", ruleName: "News", templateId: "news-collect", templateVersion: 1, retryOf: "run_prev" },
      name: "News",
      dirId: "profile_a",
    });
    agentRunRecorder.setVar(run.id, "apiToken", "SUPER-SECRET-VALUE");
    agentRunRecorder.recordStep(run.id, {
      tool: "browser_navigate",
      args: { url: "https://user:pw@example.com/x?token=SECRET", body: "SECRET-BODY" },
      result: { value: "SECRET-RESULT" },
      ok: false,
      error: "failed with SECRET-ERROR",
      durationMs: 12,
    });
    agentRunRecorder.finishRun(run.id, "error", "SECRET-RUN-ERROR", { endReason: "execution_error", verification: PASSED });

    const summary = JSON.stringify(buildSummary(agentRunRecorder.getRun(run.id)!, [], Date.now()));
    for (const secret of ["SUPER-SECRET-VALUE", "SECRET-BODY", "SECRET-RESULT", "SECRET-ERROR", "SECRET-RUN-ERROR", "token=SECRET"]) {
      expect(summary, secret).not.toContain(secret);
    }
    // Presence is still reported — just not the content.
    expect(summary).toContain('"variableKeys":["apiToken"]');
    expect(summary).toContain('"hasError":true');
    expect(summary).toContain('"failedStepCount":1');
    expect(summary).toContain('"retryOf":"run_prev"');
    expect(summary).toContain('"status":"passed"');
  });

  it("rebuilds the verification rather than spreading it", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "chat" });
    agentRunRecorder.finishRun(run.id, "done");
    const summary: any = buildSummary(agentRunRecorder.getRun(run.id)!, [], Date.now());
    expect(summary.verification).toEqual({ status: "unverified" });
  });
});

describe("plan", () => {
  it("reports the exact columns, row count and default name for a dataset", () => {
    const { runId } = commitRun();
    const plan = planExport({ runId, kind: "dataset-csv" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.format).toBe("csv");
    expect(plan.columns).toEqual(["title", "url", "source", "published_at"]);
    expect(plan.rowCount).toBe(2);
    expect(plan.suggestedName.endsWith(".csv")).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it("warns about truncation, rejected rows and manual_review before writing", () => {
    const { runId } = commitRun({
      truncated: true,
      verification: { status: "manual_review", checkedAt: Date.now(), reasonCode: "artifact_limit", verifierId: "news-collect.dataset", verifierVersion: 1 },
    });
    const plan = planExport({ runId, kind: "dataset-csv" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warnings.join("\n")).toMatch(/truncated/);
    expect(plan.warnings.join("\n")).toMatch(/manual_review/);
  });

  it("fails for a run with no stored artifacts instead of writing an empty file", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "chat" });
    agentRunRecorder.finishRun(run.id, "done");
    const plan = planExport({ runId: run.id, kind: "dataset-csv" });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasonCode).toBe("not_found");
  });

  it("refuses a file export for an artifact the manifest did not mark exportable", () => {
    const { runId } = commitRun();
    const plan = planExport({ runId, artifactId: "dataset", kind: "file" });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasonCode).toBe("export_denied");
  });
});

describe("write", () => {
  it("writes the CSV atomically and reports the byte count", () => {
    const { runId } = commitRun({ rows: [["=cmd", "https://e.com/a", "S", "2026-09-19"]] });
    const dest = path.join(TEST_USER_DATA, "out.csv");
    const res = writeExport({ runId, kind: "dataset-csv", destPath: dest });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toBe(1);
    expect(res.bytes).toBe(fs.statSync(dest).size);
    const text = fs.readFileSync(dest, "utf8");
    expect(text).toContain("'=cmd");
    // No tmp file left behind.
    expect(fs.readdirSync(TEST_USER_DATA).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("refuses to export a tampered payload", () => {
    const { runId } = commitRun();
    const payload = path.join(TEST_USER_DATA, "agent-results", runId, "artifacts", "dataset.json");
    const original = fs.readFileSync(payload, "utf8");
    fs.writeFileSync(payload, original.replace("https://example.com/a", "https://evil.example/a"));
    const dest = path.join(TEST_USER_DATA, "tampered.csv");
    const res = writeExport({ runId, kind: "dataset-csv", destPath: dest });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reasonCode).toBe("integrity_error");
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("overwrites an existing destination atomically rather than appending", () => {
    const { runId } = commitRun({ rows: [["A", "https://e.com/a", "S", "2026-09-19"]] });
    const dest = path.join(TEST_USER_DATA, "existing.csv");
    fs.writeFileSync(dest, "OLD CONTENT THAT MUST NOT SURVIVE");
    const res = writeExport({ runId, kind: "dataset-csv", destPath: dest });
    expect(res.ok).toBe(true);
    const text = fs.readFileSync(dest, "utf8");
    expect(text).not.toContain("OLD CONTENT");
    expect(text.startsWith("title,url")).toBe(true);
  });
});

describe("export path guard", () => {
  it("accepts a matching extension inside an allowed root", () => {
    const p = path.join(TEST_USER_DATA, "ok.csv");
    expect(assertSafeRunExportPath(p, "csv")).toBe(path.resolve(p));
    expect(assertSafeRunExportPath(path.join(TEST_USER_DATA, "ok.json"), "json")).toBe(path.resolve(TEST_USER_DATA, "ok.json"));
  });

  it("rejects a mismatched or missing extension", () => {
    const extError = /must be a \.csv file|must end in/;
    expect(() => assertSafeRunExportPath(path.join(TEST_USER_DATA, "x.zip"), "csv")).toThrow(extError);
    expect(() => assertSafeRunExportPath(path.join(TEST_USER_DATA, "x"), "csv")).toThrow(extError);
    expect(() => assertSafeRunExportPath(path.join(TEST_USER_DATA, "x.json"), "csv")).toThrow(extError);
    expect(() => assertSafeRunExportPath(path.join(TEST_USER_DATA, "x"), "original")).toThrow(/extension/);
  });

  it("rejects a destination outside every allowed root", () => {
    expect(() => assertSafeRunExportPath(path.join(os.homedir(), ".ssh", "id_rsa.csv"), "csv")).toThrow();
    expect(() => assertSafeRunExportPath("/etc/passwd.csv", "csv")).toThrow();
  });

  it("rejects NUL bytes and a symlinked destination", () => {
    expect(() => assertSafeRunExportPath(path.join(TEST_USER_DATA, "a\0b.csv"), "csv")).toThrow(/NUL/);
    const real = path.join(TEST_USER_DATA, "real.csv");
    fs.writeFileSync(real, "x");
    const link = path.join(TEST_USER_DATA, "link.csv");
    fs.symlinkSync(real, link);
    expect(() => assertSafeRunExportPath(link, "csv")).toThrow(/symlink/i);
  });

  it("rejects a symlinked ancestor that escapes the allowed roots", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "m2-outside-"));
    try {
      const link = path.join(TEST_USER_DATA, "escape");
      fs.mkdirSync(TEST_USER_DATA, { recursive: true });
      fs.symlinkSync(outside, link);
      expect(() => assertSafeRunExportPath(path.join(link, "x.csv"), "csv")).toThrow();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps the .zip-only archive guard intact after the refactor", () => {
    expect(assertSafeArchiveExportPath(path.join(TEST_USER_DATA, "b.zip"))).toBe(path.resolve(TEST_USER_DATA, "b.zip"));
    expect(() => assertSafeArchiveExportPath(path.join(TEST_USER_DATA, "b.csv"))).toThrow(/\.zip/);
  });
});
