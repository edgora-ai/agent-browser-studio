// Run result export (M2) — turns a committed run result into a file the user
// can keep. Two phases, deliberately:
//
//   1. planExport()  — pure, read-only. Tells the renderer exactly what WOULD
//      be written (format, columns, row count, warnings, default name, current
//      hash) so the confirmation dialog can be honest about partial/truncated
//      artifacts before anything touches the disk.
//   2. writeExport() — serializes and writes atomically. The caller supplies
//      the destination: the IPC layer either got it from the native save
//      dialog (the user already saw and chose the location) or from a
//      test/REST client that went through the same path guard.
//
// There is no export token: the native save dialog IS the "show the user where
// this lands" step, and a token would add lifecycle state without adding a
// boundary. The boundary is the path guard plus the manifest hash re-check.
//
// Two hard rules:
//   - CSV cells that a spreadsheet would execute (= + - @, or a leading
//     TAB/CR after optional whitespace) get a ' prefix BEFORE RFC 4180
//     quoting, so the formula never survives parsing.
//   - The summary JSON carries metadata only: no variable values, no step
//     args/results, no prompt, no row bodies.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { agentRunRecorder } from "./agent-run-trace.js";
import { runResultStore, type DatasetEnvelope } from "./run-result-store.js";
import type { AgentRun, AgentRunArtifactRef } from "../types.js";

export type ExportKind = "summary-json" | "dataset-csv" | "file";

export interface ExportPlanArgs {
  runId: string;
  artifactId?: string;
  kind: ExportKind;
}

export interface ExportPlan {
  ok: true;
  kind: ExportKind;
  format: "json" | "csv" | "original";
  suggestedName: string;
  extension: string;
  mediaType: string;
  /** Dataset exports: the exact column order that will be written. */
  columns?: string[];
  rowCount?: number;
  sourceRowCount?: number;
  rejectedRowCount?: number;
  /** Human-facing warnings the confirmation dialog must display verbatim. */
  warnings: string[];
  /** Hash of the payload as it will be written (dataset/summary), or of the
   *  source file (original). Lets the caller show a stable identity. */
  sha256?: string;
  bytes?: number;
  verification?: AgentRun["verification"];
  truncated?: boolean;
}

export type ExportFailure = { ok: false; reasonCode: string; detail: string };

const MAX_EXPORT_ROWS = 100_000;
/** Leading whitespace is skipped when hunting for a formula trigger: a cell
 *  like "  =1+1" is still evaluated by Excel/Sheets/LibreOffice. */
const FORMULA_RE = /^[\s]*[=+\-@]/;
const FORMULA_PREFIX_RE = /^[\t\r]/;

// ── CSV ──

/** RFC 4180 quoting, applied AFTER the formula guard so the added quote
 *  character is itself part of the quoted cell. */
function csvCell(value: string): string {
  const guarded = needsFormulaGuard(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function needsFormulaGuard(value: string): boolean {
  return FORMULA_RE.test(value) || FORMULA_PREFIX_RE.test(value);
}

/** Serialize a dataset envelope as CSV: fixed column order, CRLF line ends,
 *  no id/run_id columns (the envelope's rows are already the business columns). */
export function datasetToCsv(envelope: DatasetEnvelope): { csv: string; rowsWritten: number; truncated: boolean } {
  const lines: string[] = [envelope.columns.map((c) => csvCell(c)).join(",")];
  const rows = envelope.rows.slice(0, MAX_EXPORT_ROWS);
  for (const row of rows) {
    lines.push(row.map((cell) => csvCell(typeof cell === "string" ? cell : String(cell ?? ""))).join(","));
  }
  return {
    csv: lines.join("\r\n") + "\r\n",
    rowsWritten: rows.length,
    truncated: rows.length < envelope.rows.length,
  };
}

// ── Summary JSON ──

/** Metadata-only projection. Everything that could carry user content or
 *  secrets (variables, step args/results, prompts, error text) is excluded or
 *  reduced to counts. */
export function buildSummary(run: AgentRun, artifacts: AgentRunArtifactRef[], exportedAt: number) {
  return {
    schemaVersion: 1,
    kind: "agent-run-summary",
    exportedAt,
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      endReason: run.endReason ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      durationMs: run.finishedAt ? Math.max(0, run.finishedAt - run.startedAt) : null,
      source: {
        type: run.source?.type ?? "unknown",
        ...(run.source?.ruleId ? { ruleId: run.source.ruleId } : {}),
        ...(run.source?.ruleName ? { ruleName: run.source.ruleName } : {}),
        ...(run.source?.jobId ? { jobId: run.source.jobId } : {}),
        ...(run.source?.templateId ? { templateId: run.source.templateId } : {}),
        ...(run.source?.templateVersion !== undefined ? { templateVersion: run.source.templateVersion } : {}),
        ...(run.source?.retryOf ? { retryOf: run.source.retryOf } : {}),
      },
      profileDirId: run.dirId ?? null,
      stepCount: Array.isArray(run.steps) ? run.steps.length : 0,
      failedStepCount: Array.isArray(run.steps) ? run.steps.filter((s) => !s.ok).length : 0,
      variableKeys: Object.keys(run.variables || {}).sort(),
      // Presence only — the error text itself is free-form tool/agent output.
      hasError: Boolean(run.error),
    },
    verification: run.verification ?? { status: "unverified" },
    artifacts: artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      mediaType: a.mediaType,
      bytes: a.bytes,
      sha256: a.sha256,
      completeness: a.completeness,
      truncated: a.truncated,
      ...(a.truncationReason ? { truncationReason: a.truncationReason } : {}),
      ...(a.rowCount !== undefined ? { rowCount: a.rowCount } : {}),
      ...(a.sourceRowCount !== undefined ? { sourceRowCount: a.sourceRowCount } : {}),
      ...(a.rejectedRowCount !== undefined ? { rejectedRowCount: a.rejectedRowCount } : {}),
      ...(a.columns ? { columns: a.columns } : {}),
      ...(a.redactedColumns?.length ? { redactedColumns: a.redactedColumns } : {}),
    })),
  };
}

// ── Planning ──

function sanitizeFileStem(s: string): string {
  return (s || "run").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
}

function manualReviewWarning(v: AgentRun["verification"]): string[] {
  if (!v || v.status !== "manual_review") return [];
  return [`verification is manual_review (${v.reasonCode}): the result was not machine-verified`];
}

function datasetWarnings(ref: AgentRunArtifactRef, env?: DatasetEnvelope): string[] {
  const out: string[] = [];
  if (ref.truncated) {
    out.push(`artifact is truncated (${ref.truncationReason || "quota"}): the file holds only part of the collected rows`);
  }
  if (env && env.rejectedRowCount > 0) {
    out.push(`${env.rejectedRowCount} row(s) failed verification and are NOT included`);
  }
  if (env && env.rows.length > MAX_EXPORT_ROWS) {
    out.push(`export is capped at ${MAX_EXPORT_ROWS} rows; the artifact holds ${env.rows.length}`);
  }
  return out;
}

/** Resolve the artifact an export targets, defaulting to the dataset. */
function resolveArtifact(runId: string, artifactId: string | undefined): { ok: true; ref: AgentRunArtifactRef; env?: DatasetEnvelope } | ExportFailure {
  const run = agentRunRecorder.getRun(runId);
  if (!run) return { ok: false, reasonCode: "not_found", detail: "run not found" };
  const refs = run.artifacts || [];
  if (refs.length === 0) return { ok: false, reasonCode: "not_found", detail: "run has no stored artifacts" };
  const ref = artifactId ? refs.find((a) => a.id === artifactId) : refs.find((a) => a.kind === "dataset") || refs[0];
  if (!ref) return { ok: false, reasonCode: "not_found", detail: `no artifact ${artifactId}` };
  if (ref.kind !== "dataset") return { ok: true, ref };
  const env = runResultStore.readDataset(runId, ref.id);
  if (!env.ok) return { ok: false, reasonCode: env.reasonCode, detail: env.detail };
  return { ok: true, ref, env: env.value };
}

export function planExport(args: ExportPlanArgs): ExportPlan | ExportFailure {
  const run = agentRunRecorder.getRun(args.runId);
  if (!run) return { ok: false, reasonCode: "not_found", detail: "run not found" };
  if (args.kind === "summary-json") {
    const summary = buildSummary(run, run.artifacts || [], Date.now());
    const payload = Buffer.from(JSON.stringify(summary, null, 2), "utf8");
    return {
      ok: true,
      kind: "summary-json",
      format: "json",
      suggestedName: `${sanitizeFileStem(run.name)}-${run.id}.summary.json`,
      extension: "json",
      mediaType: "application/json",
      bytes: payload.length,
      warnings: manualReviewWarning(run.verification),
      verification: run.verification ?? { status: "unverified" },
    };
  }

  const resolved = resolveArtifact(args.runId, args.artifactId);
  if (!resolved.ok) return resolved;
  const { ref, env } = resolved;

  if (args.kind === "dataset-csv") {
    if (ref.kind !== "dataset") return { ok: false, reasonCode: "artifact_invalid", detail: `${ref.id} is not a dataset` };
    if (ref.exportPolicy === "none") return { ok: false, reasonCode: "export_denied", detail: `${ref.id} is not exportable` };
    if (!env) return { ok: false, reasonCode: "not_found", detail: "dataset payload unavailable" };
    const { csv } = datasetToCsv(env);
    const payload = Buffer.from(csv, "utf8");
    return {
      ok: true,
      kind: "dataset-csv",
      format: "csv",
      suggestedName: `${sanitizeFileStem(run.name)}-${run.id}.csv`,
      extension: "csv",
      mediaType: "text/csv",
      columns: env.columns,
      rowCount: Math.min(env.rows.length, MAX_EXPORT_ROWS),
      sourceRowCount: env.sourceRowCount,
      rejectedRowCount: env.rejectedRowCount,
      truncated: ref.truncated,
      bytes: payload.length,
      warnings: [...manualReviewWarning(run.verification), ...datasetWarnings(ref, env)],
      verification: run.verification ?? { status: "unverified" },
    };
  }

  // kind === "file": only artifacts the manifest explicitly marks exportable.
  if (ref.kind !== "file" || ref.exportPolicy !== "original") {
    return { ok: false, reasonCode: "export_denied", detail: "only manifest-declared original files can be exported" };
  }
  return {
    ok: true,
    kind: "file",
    format: "original",
    suggestedName: sanitizeFileStem(path.basename(ref.name)),
    extension: path.extname(ref.name).replace(/^\./, ""),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    sha256: ref.sha256,
    truncated: ref.truncated,
    warnings: [...manualReviewWarning(run.verification), ...datasetWarnings(ref)],
    verification: run.verification ?? { status: "unverified" },
  };
}

// ── Writing ──

export interface WriteExportArgs extends ExportPlanArgs {
  destPath: string;
}

export interface WriteExportResult {
  ok: true;
  filePath: string;
  bytes: number;
  sha256: string;
  rows?: number;
  kind: ExportKind;
}

function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Atomic write: unique O_EXCL tmp in the SAME directory, 0600, fsync, rename,
 *  directory fsync. An interrupted export leaves either the old file or the
 *  new one, never a half-written one. */
function atomicWriteFile(destPath: string, data: Buffer): void {
  const dir = path.dirname(destPath);
  const tmp = path.join(dir, `.agent-run-export-${process.pid}-${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, destPath);
    let dfd: number | null = null;
    try {
      dfd = fs.openSync(dir, fs.constants.O_RDONLY);
      fs.fsyncSync(dfd);
    } finally {
      if (dfd !== null) try { fs.closeSync(dfd); } catch { /* best effort */ }
    }
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

export function writeExport(args: WriteExportArgs): WriteExportResult | ExportFailure {
  // Plan first: the plan is what the user approved, so writing must re-derive
  // it from current state rather than trust anything the renderer echoed back.
  const plan = planExport(args);
  if (!plan.ok) return plan;
  if (!args.destPath || typeof args.destPath !== "string") {
    return { ok: false, reasonCode: "invalid_path", detail: "destination path is required" };
  }

  const run = agentRunRecorder.getRun(args.runId)!;
  let payload: Buffer;
  let rows: number | undefined;

  if (plan.kind === "summary-json") {
    payload = Buffer.from(JSON.stringify(buildSummary(run, run.artifacts || [], Date.now()), null, 2), "utf8");
  } else if (plan.kind === "dataset-csv") {
    const resolved = resolveArtifact(args.runId, args.artifactId);
    if (!resolved.ok) return resolved;
    if (!resolved.env) return { ok: false, reasonCode: "not_found", detail: "dataset payload unavailable" };
    // Re-read via the store: the hash was re-checked on the way in, so a
    // tampered payload fails here instead of being exported.
    const csv = datasetToCsv(resolved.env);
    payload = Buffer.from(csv.csv, "utf8");
    rows = csv.rowsWritten;
  } else {
    const resolved = resolveArtifact(args.runId, args.artifactId);
    if (!resolved.ok) return resolved;
    const ref = resolved.ref;
    const source = runResultStore.readArtifactFile(args.runId, ref.id);
    if (!source.ok) return { ok: false, reasonCode: source.reasonCode, detail: source.detail };
    payload = source.value;
  }

  try {
    atomicWriteFile(args.destPath, payload);
  } catch (e: any) {
    return {
      ok: false,
      reasonCode: e?.code === "ENOSPC" ? "no_space" : "write_failed",
      detail: String(e?.message || e).slice(0, 300),
    };
  }
  return { ok: true, filePath: args.destPath, bytes: payload.length, sha256: sha256Of(payload), rows, kind: plan.kind };
}
