// Template run verifiers (M2) — the ONLY component allowed to promote a
// run's verification beyond "unverified". A verifier never trusts the
// model's prose ("done"); it reads the actual rows the run left behind via
// fixed prepared statements against main-controlled tables, applies row
// rules, and produces counts that must satisfy the AgentRunVerification
// invariants. The prompt contract is guidance; this file is the boundary.
import {
  NEWS_RUN_TABLE,
  ensureNewsRunResultSchema,
  countNewsRowsForRun,
  readNewsRowsForRun,
  deleteNewsRowsForRun,
} from "./agent-db.js";
import { getTemplate } from "./task-templates.js";
import type {
  AgentRunVerification,
  AgentRunVerificationIssue,
} from "../types.js";

// ── Shared shapes ──

export type AutoVerification = Extract<AgentRunVerification, { status: "passed" | "partial" | "failed" }>;
export type ManualVerification = Extract<AgentRunVerification, { status: "manual_review" }>;

/** Sanitized, canonical rows destined for the run-result store. */
export interface DatasetSnapshot {
  columns: string[];
  /** Accepted rows only, sanitized (URLs stripped of credentials/secret query values). */
  rows: Array<Record<string, string>>;
  /** Rows the run actually wrote (before validation). */
  sourceRowCount: number;
  rejectedRowCount: number;
  truncated: boolean;
  truncationReason?: string;
}

export type VerifyOutcome =
  | { kind: "auto"; verification: AutoVerification; dataset: DatasetSnapshot }
  | { kind: "manual"; verification: ManualVerification };

export type TemplateInputValidation =
  | { ok: true; inputs: Record<string, string> }
  | { ok: false; reasonCode: string; detail: string };

export interface TemplateVerifier {
  templateId: string;
  verifierId: string;
  version: number;
  tableName: string;
  businessColumns: string[];
  /** Semantic input rules (structural bounds are enforced separately by
   *  normalizeTemplateInputs in config-manager). */
  validateInputs(raw: Record<string, string>): TemplateInputValidation;
  /** The execution contract appended to the system prompt for this run. */
  buildExecutionContract(args: { runId: string; inputs: Record<string, string> }): string;
  /** Pre-run storage preparation (create + shape-check the controlled table). */
  prepareStorage(): { ok: true } | { ok: false; reasonCode: string; detail: string };
  /** Grade the run's actual rows. Pure reads + memory; no writes. */
  verify(args: { runId: string; inputs: Record<string, string> }): VerifyOutcome;
  /** Remove all rows belonging to a run (run deletion / retention). */
  cleanupRun(runId: string): void;
}

// ── Dataset shape caps (shared with the result store) ──
export const DATASET_CAPS = {
  maxRows: 1000,
  maxColumns: 64,
  maxCellBytes: 64 * 1024,
  maxIssues: 100,
} as const;

const MAX_URL_BYTES = 2048;
const MAX_TITLE_BYTES = 500;
const MAX_SOURCE_BYTES = 200;
const MAX_PUBLISHED_AT_BYTES = 64;
const SENSITIVE_QUERY_KEY_RE = /token|api[-_]?key|secret|password|passwd|credential|signature|session|auth/i;
/** Strict ISO-8601-ish timestamp: date, optional time, optional zone. */
const STRICT_TS_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Validate + normalize a row URL. Returns the normalized form (for dedup)
 *  or null when invalid. */
function normalizeRowUrl(raw: unknown): { normalized: string; sanitized: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || byteLength(trimmed) > MAX_URL_BYTES) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return { normalized: u.toString(), sanitized: sanitizeUrlForSnapshot(u) };
}

/** Strip secret-looking query values for the persisted snapshot. */
function sanitizeUrlForSnapshot(u: URL): string {
  const copy = new URL(u.toString());
  for (const key of Array.from(copy.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY_RE.test(key)) copy.searchParams.set(key, "[REDACTED]");
  }
  return copy.toString();
}

function isValidTimestamp(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed || byteLength(trimmed) > MAX_PUBLISHED_AT_BYTES) return false;
  if (!STRICT_TS_RE.test(trimmed)) return false;
  return !Number.isNaN(Date.parse(trimmed));
}

// ── news-collect dataset verifier (v1) ──

const NEWS_INPUT_DEFAULTS = { limit: "10" } as const;
const NEWS_LIMIT_MIN = 1;
const NEWS_LIMIT_MAX = 100;

function validateNewsInputs(raw: Record<string, string>): TemplateInputValidation {
  const sourceUrl = typeof raw.sourceUrl === "string" ? raw.sourceUrl.trim() : "";
  if (!sourceUrl) {
    return { ok: false, reasonCode: "input_invalid", detail: "sourceUrl is required" };
  }
  if (byteLength(sourceUrl) > MAX_URL_BYTES) {
    return { ok: false, reasonCode: "input_invalid", detail: "sourceUrl exceeds 2048 bytes" };
  }
  let u: URL;
  try {
    u = new URL(sourceUrl);
  } catch {
    return { ok: false, reasonCode: "input_invalid", detail: "sourceUrl is not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reasonCode: "input_invalid", detail: "sourceUrl must be http(s)" };
  }
  if (u.username || u.password) {
    return { ok: false, reasonCode: "input_invalid", detail: "sourceUrl must not embed credentials" };
  }
  for (const key of u.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY_RE.test(key)) {
      return { ok: false, reasonCode: "input_invalid", detail: `sourceUrl query parameter "${key}" looks secret-bearing` };
    }
  }
  const inputs: Record<string, string> = { sourceUrl };
  const limitRaw = typeof raw.limit === "string" && raw.limit.trim() ? raw.limit.trim() : NEWS_INPUT_DEFAULTS.limit;
  if (!/^\d{1,3}$/.test(limitRaw)) {
    return { ok: false, reasonCode: "input_invalid", detail: "limit must be an integer" };
  }
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < NEWS_LIMIT_MIN || limit > NEWS_LIMIT_MAX) {
    return { ok: false, reasonCode: "input_invalid", detail: `limit must be ${NEWS_LIMIT_MIN}..${NEWS_LIMIT_MAX}` };
  }
  inputs.limit = String(limit);
  return { ok: true, inputs };
}

function buildNewsContract(args: { runId: string; inputs: Record<string, string> }): string {
  const { runId, inputs } = args;
  return [
    `## 执行合同 (template: news-collect v1)`,
    `本次运行的真实 run_id: ${runId} —— 验收只按它统计,正文声称完成不构成验收。`,
    `- 目标表已由系统预建: ${NEWS_RUN_TABLE}(run_id, title, url, source, published_at)。禁止对该表 CREATE/DROP/ALTER。`,
    `- 每采集到一条新闻立即参数化写入:`,
    `  db_exec: INSERT INTO ${NEWS_RUN_TABLE} (run_id, title, url, source, published_at) VALUES (?, ?, ?, ?, ?)`,
    `  第一个参数必须恰为上述 run_id;不得写入、修改或删除其他 run_id 的行。`,
    `- 输入: sourceUrl = ${inputs.sourceUrl}; limit = ${inputs.limit}(期望有效条数)。`,
    `- 同一 run 内重复 URL 会被 UNIQUE(run_id,url) 拒绝:跳过该条,继续下一条,不要重试同一条。`,
    `- published_at 用 ISO-8601(如 2026-09-19T08:30:00Z);无法确定时用页面给出的日期部分(YYYY-MM-DD)。`,
    `- 完成后用一句话汇报实际写入条数。`,
  ].join("\n");
}

function verifyNewsRun(args: { runId: string; inputs: Record<string, string> }): VerifyOutcome {
  const checkedAt = Date.now();
  const verifierId = newsCollectVerifier.verifierId;
  const verifierVersion = newsCollectVerifier.version;

  const manual = (reasonCode: string, issues?: AgentRunVerificationIssue[]): VerifyOutcome => ({
    kind: "manual",
    verification: {
      status: "manual_review",
      checkedAt,
      reasonCode,
      verifierId,
      verifierVersion,
      ...(issues && issues.length ? { issues, issuesTruncated: false } : {}),
    },
  });

  const schema = ensureNewsRunResultSchema();
  if (!schema.ok) {
    return manual(schema.reasonCode, [{ code: "schema_incompatible", detail: schema.detail.slice(0, 200) }]);
  }

  const expected = Number.parseInt(args.inputs.limit || NEWS_INPUT_DEFAULTS.limit, 10);
  if (!Number.isInteger(expected) || expected < NEWS_LIMIT_MIN || expected > NEWS_LIMIT_MAX) {
    return manual("input_unavailable", [{ code: "missing_input", field: "limit" }]);
  }

  let observed = 0;
  try {
    observed = countNewsRowsForRun(args.runId);
  } catch (e: any) {
    return manual("integrity_error", [{ code: "read_failed", detail: String(e?.message || e).slice(0, 200) }]);
  }

  if (observed > DATASET_CAPS.maxRows) {
    return manual("row_cap_exceeded", [{
      code: "too_many_rows",
      detail: `${observed} rows exceed the inspection cap of ${DATASET_CAPS.maxRows}`,
    }]);
  }

  let rows: ReturnType<typeof readNewsRowsForRun>;
  try {
    rows = readNewsRowsForRun(args.runId, DATASET_CAPS.maxRows);
  } catch (e: any) {
    return manual("integrity_error", [{ code: "read_failed", detail: String(e?.message || e).slice(0, 200) }]);
  }

  const issues: AgentRunVerificationIssue[] = [];
  let issuesDropped = false;
  const recordIssue = (issue: AgentRunVerificationIssue) => {
    if (issues.length < DATASET_CAPS.maxIssues) issues.push(issue);
    else issuesDropped = true;
  };
  const accepted: Array<Record<string, string>> = [];
  const seenUrls = new Set<string>();
  let rejected = 0;

  for (const row of rows) {
    const item = typeof row.url === "string" ? row.url.slice(0, 200) : String(row.id);
    const reject = (code: string, field?: string, detail?: string) => {
      rejected++;
      recordIssue({ code, item, ...(field ? { field } : {}), ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    };

    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (typeof row.title !== "string") { reject("invalid_value_type", "title"); continue; }
    if (!title) { reject("required_empty", "title"); continue; }
    if (byteLength(title) > MAX_TITLE_BYTES) { reject("value_too_large", "title"); continue; }

    if (typeof row.url !== "string") { reject("invalid_value_type", "url"); continue; }
    const url = normalizeRowUrl(row.url);
    if (!url) { reject("invalid_url", "url"); continue; }
    if (seenUrls.has(url.normalized)) { reject("duplicate_url", "url"); continue; }

    const source = typeof row.source === "string" ? row.source.trim() : "";
    if (typeof row.source !== "string") { reject("invalid_value_type", "source"); continue; }
    if (!source) { reject("required_empty", "source"); continue; }
    if (byteLength(source) > MAX_SOURCE_BYTES) { reject("value_too_large", "source"); continue; }

    if (!isValidTimestamp(row.published_at)) {
      reject(typeof row.published_at === "string" ? "invalid_timestamp" : "invalid_value_type", "published_at");
      continue;
    }

    seenUrls.add(url.normalized);
    accepted.push({
      title,
      url: url.sanitized,
      source,
      published_at: (row.published_at as string).trim(),
    });
  }

  const counts = {
    expected,
    observed,
    inspected: observed,
    accepted: accepted.length,
    rejected,
    missing: Math.max(expected - observed, 0),
    extra: Math.max(observed - expected, 0),
  };
  const status =
    counts.accepted === expected && rejected === 0 && counts.missing === 0 && counts.extra === 0
      ? "passed"
      : accepted.length === 0
        ? "failed"
        : "partial";

  const verification: AutoVerification = {
    status,
    verifierId,
    verifierVersion,
    checkedAt,
    counts,
    issues,
    issuesTruncated: issuesDropped,
  };
  const dataset: DatasetSnapshot = {
    columns: ["title", "url", "source", "published_at"],
    rows: accepted,
    sourceRowCount: observed,
    rejectedRowCount: rejected,
    truncated: false,
  };
  return { kind: "auto", verification, dataset };
}

const newsCollectVerifier: TemplateVerifier = {
  templateId: "news-collect",
  verifierId: "news-collect.dataset",
  version: 1,
  tableName: NEWS_RUN_TABLE,
  businessColumns: ["title", "url", "source", "published_at"],
  validateInputs: validateNewsInputs,
  buildExecutionContract: buildNewsContract,
  prepareStorage: () => ensureNewsRunResultSchema(),
  verify: verifyNewsRun,
  cleanupRun: (runId) => {
    deleteNewsRowsForRun(runId);
  },
};

// ── Registry ──

const VERIFIERS: TemplateVerifier[] = [newsCollectVerifier];

export function getRunVerifier(templateId: string | undefined, version?: number): TemplateVerifier | undefined {
  if (!templateId) return undefined;
  return VERIFIERS.find((v) => v.templateId === templateId && (version === undefined || v.version === version));
}

/** Remove every controlled-table row belonging to a run, across all
 *  registered verifiers. Scoped DELETEs only (WHERE run_id = ?). */
export function cleanupTemplateRowsForRun(runId: string): void {
  for (const v of VERIFIERS) {
    try {
      v.cleanupRun(runId);
    } catch (e) {
      console.warn(`[run-verifiers] cleanup failed for ${runId} in ${v.tableName}:`, e);
    }
  }
}

/**
 * Write-path validation for automation rules (automation-rules.ts +
 * automation-data.ts call this before persisting). Rules:
 *  - no templateId / template without a machine contract → nothing to check;
 *  - templateInputs absent → allowed (legacy rule; its runs land in
 *    manual_review/input_unavailable instead of being machine-graded);
 *  - templateInputs present → must satisfy BOTH the structural bounds
 *    (normalizeTemplateInputs) and the template's semantic rules.
 */
export function validateTemplateInputsForAction(
  action: { templateId?: string; templateInputs?: Record<string, string> },
  normalizeStructural: (raw: unknown) => Record<string, string> | undefined,
): { ok: true } | { ok: false; error: string } {
  const templateId = action.templateId;
  if (!templateId) return { ok: true };
  const template = getTemplate(templateId);
  const verifier = template?.machine ? getRunVerifier(templateId, template.machine.version) : undefined;
  if (!verifier) return { ok: true };
  if (action.templateInputs === undefined) return { ok: true };
  const structural = normalizeStructural(action.templateInputs);
  if (!structural) {
    return { ok: false, error: "templateInputs exceed structural bounds (≤16 keys, key ≤64B, value ≤2048B, total ≤8KiB)" };
  }
  const semantic = verifier.validateInputs(structural);
  if (!semantic.ok) return { ok: false, error: `templateInputs: ${semantic.detail}` };
  return { ok: true };
}
