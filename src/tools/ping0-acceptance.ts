export interface Ping0FindingsAssessment {
  scope: "site-findings-only";
  status: "PASS" | "FAIL" | "INCONCLUSIVE";
  resolverCount: number | null;
  failedFindingIds: string[];
  pendingRowIds: string[];
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCollectionTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * Assess a collected Ping0 page, not the collector's exit code or site score.
 * Raw rows must carry explicit boolean pending flags; resolver_count.value is
 * a number, and cross-check rows expose boolean fail flags. Unknown shapes
 * remain inconclusive. This does not authenticate a report or verify browser
 * identity, NetLog, DNS routing, or any successful DNS transaction.
 */
export function assessPing0Findings(input: unknown): Ping0FindingsAssessment {
  const reasons: string[] = [];
  const failedFindingIds = new Set<string>();
  const pendingRowIds = new Set<string>();
  let resolverCount: number | null = null;
  let inconclusive = false;
  const unknown = (reason: string) => { inconclusive = true; reasons.push(reason); };
  const result = (): Ping0FindingsAssessment => ({
    scope: "site-findings-only",
    status: inconclusive ? "INCONCLUSIVE" : reasons.length > 0 ? "FAIL" : "PASS",
    resolverCount,
    failedFindingIds: [...failedFindingIds].sort(),
    pendingRowIds: [...pendingRowIds].sort(),
    reasons,
  });

  if (!isRecord(input)) {
    unknown("invalid-collection");
    return result();
  }
  if (input.outcome !== "completed") unknown("collection-not-completed");
  if (input.reason !== null) unknown("collection-reason-not-clear");
  if (!isRecord(input.state)) {
    unknown("missing-or-invalid-state");
    return result();
  }
  const state = input.state;
  if (state.finished !== true) unknown("state-not-finished");
  if (!hasText(state.reportId)) unknown("missing-or-invalid-report-id");
  if (!isCollectionTimestamp(state.settledAt)) unknown("missing-or-invalid-settled-at");
  if (!isCollectionTimestamp(state.finishedAt)) unknown("missing-or-invalid-finished-at");
  if (isCollectionTimestamp(state.finishedAt) && isCollectionTimestamp(state.settledAt) &&
      state.settledAt < state.finishedAt) unknown("settled-before-finished");

  const rows = new Map<string, Record<string, unknown>>();
  if (!isRecord(state.rows)) {
    unknown("invalid-rows");
  } else {
    if (Object.keys(state.rows).length === 0) unknown("empty-rows");
    for (const [id, row] of Object.entries(state.rows)) {
      if (!hasText(id) || !isRecord(row)) {
        unknown("invalid-row:" + id);
        continue;
      }
      rows.set(id, row);
      if ((row.id !== undefined && row.id !== id) || typeof row.pending !== "boolean" ||
          (row.fail !== undefined && typeof row.fail !== "boolean")) unknown("invalid-row:" + id);
      if (row.pending === true) {
        pendingRowIds.add(id);
        unknown("pending-row:" + id);
      }
      if (row.fail === true) {
        failedFindingIds.add(id);
        reasons.push("row-failed:" + id);
      }
    }
  }

  const countRow = rows.get("dns.resolver_count");
  if (!countRow) {
    unknown("missing-required-row:dns.resolver_count");
  } else if (typeof countRow.value !== "number" || !Number.isSafeInteger(countRow.value) || countRow.value < 0) {
    unknown("invalid-resolver-count");
  } else {
    resolverCount = countRow.value;
    if (resolverCount === 0) reasons.push("resolver-count-zero");
  }
  const checkBlackholeCount = (value: unknown, source: string) => {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "resolver_count")) return;
    const count = value.resolver_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      unknown("invalid-blackhole-resolver-count:" + source);
    } else if (count !== resolverCount) {
      unknown("blackhole-resolver-count-conflict:" + source);
    }
  };
  const blackholeRow = rows.get("xc.dns_blackhole");
  if (!blackholeRow) unknown("missing-required-row:xc.dns_blackhole");
  else {
    if (typeof blackholeRow.fail !== "boolean") unknown("invalid-blackhole-fail-flag");
    checkBlackholeCount(blackholeRow.value, "row");
  }

  if (!Array.isArray(state.findings)) {
    unknown("invalid-findings");
  } else {
    const seen = new Set<string>();
    for (const finding of state.findings) {
      if (!isRecord(finding) || !hasText(finding.id) || typeof finding.fail !== "boolean") {
        unknown("invalid-finding");
        continue;
      }
      const id = finding.id;
      if (id === "xc.dns_blackhole") {
        checkBlackholeCount(finding.value, "finding-value");
        checkBlackholeCount(finding, "finding");
      }
      if (seen.has(id)) unknown("duplicate-finding:" + id);
      seen.add(id);
      if (finding.fail) {
        failedFindingIds.add(id);
        reasons.push("finding-failed:" + id);
      }
      const row = rows.get(id);
      if (!row) unknown("missing-finding-row:" + id);
      else if (typeof row.fail !== "boolean") unknown("invalid-finding-row-fail-flag:" + id);
      else if (row.fail !== finding.fail) unknown("row-finding-conflict:" + id);
    }
  }
  return result();
}
