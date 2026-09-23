// Durable job store — persists automation runs to SQLite so they survive app
// restarts and can be inspected/retried. Mirrors agent-db's node:sqlite
// singleton pattern. File: <userData>/jobs.sqlite.
//
// Lifecycle per job: queued → running → done | failed | skipped | cancelled.
// On startup, any "running" job left by a crash is marked failed(interrupted)
// — we do NOT auto-resume, because actions can be side-effecting (launch,
// agent-task, sync, custom-js) and resuming could double-execute. The user
// can retry explicitly.
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir } from "./config-manager.js";

export type JobSource = "cron" | "once" | "event" | "test";
/**
 * M3 adds "retry-waiting". One job row now covers one LOGICAL execution: a
 * retry re-marks the same row running(attempt+1) instead of inserting a new
 * one, so the waiting period between attempts is representable at all. Before
 * this, a rule waiting on its backoff had no row and no state — it showed as
 * nothing while the UI claimed the rule was simply enabled.
 */
export type JobStatus = "queued" | "running" | "retry-waiting" | "done" | "failed" | "skipped" | "cancelled";

export interface Job {
  id: string;
  ruleId: string;
  ruleName: string;
  source: JobSource;
  status: JobStatus;
  attempt: number;
  result: string | null;
  error: string | null;
  runId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Plan this job was created under. NULL for rows written before M3. */
  planId: string | null;
  /** When the pending retry will fire (status === "retry-waiting"). */
  retryAt: number | null;
}

let db: DatabaseSync | null = null;

function dbPath(): string {
  return path.join(getAppDataDir(), "jobs.sqlite");
}

function ensureSchema(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
  `);
  const columns = (conn.prepare("PRAGMA table_info(jobs)").all() as any[]).map((r) => String(r.name));
  if (!columns.includes("run_id")) {
    conn.exec("ALTER TABLE jobs ADD COLUMN run_id TEXT;");
  }
  // M3 columns, same additive ALTER pattern as run_id above: an existing
  // jobs.sqlite keeps its rows and reads the new columns back as NULL.
  if (!columns.includes("plan_id")) {
    conn.exec("ALTER TABLE jobs ADD COLUMN plan_id TEXT;");
  }
  if (!columns.includes("retry_at")) {
    conn.exec("ALTER TABLE jobs ADD COLUMN retry_at INTEGER;");
  }
  conn.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_jobs_rule ON jobs(rule_id);");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_jobs_plan ON jobs(rule_id, plan_id);");
  ensureNotificationSchema(conn);
}

/**
 * Terminal-execution notification log (M3). Lives in the same DB as jobs so
 * there is one singleton, one shutdown path, and one place to reconcile.
 *
 * `dedup_key` is the whole mechanism: INSERT OR IGNORE plus "changes === 0
 * means already recorded" delivers three requirements at once — notify once
 * per final logical execution, do not re-alert on intermediate retries, and do
 * not re-notify after a restart. A job id is unique and stable across
 * restarts; a missed-once key is derived from rule + plan.
 */
function ensureNotificationSchema(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      dedup_key    TEXT PRIMARY KEY,
      job_id       TEXT,
      rule_id      TEXT NOT NULL,
      plan_id      TEXT,
      kind         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      delivered_at INTEGER,
      read_at      INTEGER
    );
  `);
  conn.exec("CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);");
}

function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(getAppDataDir(), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(dbPath());
    db.exec("PRAGMA journal_mode = WAL;");
    ensureSchema(db);
  }
  return db;
}

export function closeJobDb(): void {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
}

/** Tests: swap the connection (e.g. to :memory:). */
export function _setDbForTesting(testDb: DatabaseSync | null): void {
  db = testDb;
  if (testDb) ensureSchema(testDb);
}

let _seq = 0;
function newId(): string {
  _seq = (_seq + 1) % 1_000_000;
  return `job_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

function rowToJob(r: any): Job {
  return {
    id: r.id, ruleId: r.rule_id, ruleName: r.rule_name, source: r.source, status: r.status,
    attempt: Number(r.attempt), result: r.result, error: r.error, runId: r.run_id ?? null,
    createdAt: Number(r.created_at), startedAt: r.started_at == null ? null : Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    planId: r.plan_id ?? null,
    retryAt: r.retry_at == null ? null : Number(r.retry_at),
  };
}

export function enqueueJob(p: { ruleId: string; ruleName: string; source: JobSource; runId?: string | null; planId?: string | null }): Job {
  const id = newId();
  const now = Date.now();
  const runId = p.runId || null;
  const planId = p.planId || null;
  getDb().prepare(
    "INSERT INTO jobs (id, rule_id, rule_name, source, status, attempt, run_id, plan_id, created_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)",
  ).run(id, p.ruleId, p.ruleName, p.source, runId, planId, now);
  return { id, ruleId: p.ruleId, ruleName: p.ruleName, source: p.source, status: "queued", attempt: 0, result: null, error: null, runId, createdAt: now, startedAt: null, finishedAt: null, planId, retryAt: null };
}

export function markRunning(id: string, attempt: number): void {
  getDb().prepare("UPDATE jobs SET status='running', attempt=?, started_at=?, retry_at=NULL WHERE id=?").run(attempt, Date.now(), id);
}

/**
 * Re-mark an EXISTING row as running for the next attempt of the same logical
 * execution. Unlike markRunning this preserves started_at — the execution
 * began at the first attempt, and the Jobs list should not report a retry as a
 * fresh run. No status guard: the row is legitimately retry-waiting here.
 */
export function markRunningAttempt(id: string, attempt: number): void {
  getDb().prepare(
    "UPDATE jobs SET status='running', attempt=?, started_at=COALESCE(started_at, ?), retry_at=NULL WHERE id=?",
  ).run(attempt, Date.now(), id);
}

/**
 * Park the row between retry attempts. Guarded on status='running' so a
 * cancelled or already-terminal row can never be reopened by a late callback.
 */
export function markRetryWaiting(id: string, retryAt: number): boolean {
  const r = getDb().prepare(
    "UPDATE jobs SET status='retry-waiting', retry_at=? WHERE id=? AND status='running'",
  ).run(retryAt, id);
  return Number(r.changes) > 0;
}

/**
 * M3: end an execution that was parked between retries, because the retry will
 * not happen (the guard now refuses it, or the rule was disabled/re-armed).
 *
 * A separate function from markFailed on purpose: that one is guarded on
 * status='running', so it cannot reach a retry-waiting row. Without this the
 * row would sit in retry-waiting forever and the card would keep promising a
 * retry that nothing is going to deliver.
 */
export function markRetryAbandoned(id: string, reason: string): boolean {
  const r = getDb().prepare(
    "UPDATE jobs SET status='failed', error=?, retry_at=NULL, finished_at=? WHERE id=? AND status='retry-waiting'",
  ).run(String(reason).slice(0, 2000), Date.now(), id);
  return Number(r.changes) > 0;
}

export function markDone(id: string, result: string): void {
  getDb().prepare("UPDATE jobs SET status='done', result=?, finished_at=? WHERE id=? AND status='running'").run(result.slice(0, 2000), Date.now(), id);
}

export function markFailed(id: string, error: string): void {
  getDb().prepare("UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=? AND status='running'").run(String(error).slice(0, 2000), Date.now(), id);
}

export function markSkipped(id: string, reason: string): void {
  getDb().prepare("UPDATE jobs SET status='skipped', result=?, finished_at=? WHERE id=?").run(String(reason).slice(0, 500), Date.now(), id);
  pruneSkippedJobs();
}

/**
 * Bound the jobs table: skipped rows are observability noise (a cron in
 * cooldown writes one per tick forever), so cap them at KEEP_SKIPPED newest.
 * Terminal done/failed/cancelled rows are capped at KEEP_TERMINAL newest.
 * Runs against the same connection; best-effort, never throws.
 */
const KEEP_SKIPPED = 200;
const KEEP_TERMINAL = 2000;

export function pruneSkippedJobs(): number {
  return pruneJobsByStatus("skipped", KEEP_SKIPPED);
}

export function pruneJobs(): number {
  let total = 0;
  total += pruneJobsByStatus("skipped", KEEP_SKIPPED);
  for (const status of ["done", "failed", "cancelled"] as const) {
    total += pruneJobsByStatus(status, KEEP_TERMINAL);
  }
  return total;
}

function pruneJobsByStatus(status: JobStatus, keep: number): number {
  try {
    const r = getDb().prepare(
      "DELETE FROM jobs WHERE status=? AND id NOT IN (SELECT id FROM jobs WHERE status=? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    ).run(status, status, keep);
    return Number(r.changes) || 0;
  } catch {
    return 0;
  }
}

export function markJobRunId(id: string, runId: string): void {
  getDb().prepare("UPDATE jobs SET run_id=? WHERE id=?").run(String(runId).slice(0, 120), id);
}

export function markCancelled(id: string): boolean {
  const r = getDb().prepare("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('queued','running')").run(Date.now(), id);
  return Number(r.changes) > 0;
}

export function getJob(id: string): Job | null {
  const r = getDb().prepare("SELECT * FROM jobs WHERE id=?").get(id) as any;
  return r ? rowToJob(r) : null;
}

export function listJobs(opts: { status?: JobStatus; ruleId?: string; limit?: number } = {}): Job[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  let sql = "SELECT * FROM jobs";
  const where: string[] = [];
  const params: any[] = [];
  if (opts.status) { where.push("status=?"); params.push(opts.status); }
  if (opts.ruleId) { where.push("rule_id=?"); params.push(opts.ruleId); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  // created_at desc, then rowid desc (insertion order) to break same-ms ties.
  sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?";
  params.push(limit);
  return (getDb().prepare(sql).all(...params) as any[]).map(rowToJob);
}

/**
 * Startup recovery: any job still "running" after a restart was interrupted by
 * a crash/quit. Mark it failed(interrupted) — never auto-resume side-effecting
 * actions. Returns how many were recovered.
 */
export function recoverInterruptedJobs(): number {
  const r = getDb().prepare("UPDATE jobs SET status='failed', error='interrupted by restart', finished_at=? WHERE status='running'").run(Date.now());
  return Number(r.changes);
}

/**
 * M3: a `queued` row cannot legitimately outlive the process. The only two
 * producers are the pre-run-slot window and the guard-refuse path, and both
 * resolve within the same process. A row still queued at startup therefore
 * belongs to a dead process — and `recoverInterruptedJobs` only looks at
 * `running`, so before this it stayed queued forever and the UI kept claiming
 * the rule was queued.
 *
 * `cancelled`, not `failed`: the work never started and no side effect
 * occurred, so there is nothing to report as a failure.
 */
export function recoverOrphanedQueuedJobs(): number {
  const r = getDb().prepare(
    "UPDATE jobs SET status='cancelled', error='orphaned queued row converged at startup', finished_at=? WHERE status='queued'",
  ).run(Date.now());
  return Number(r.changes);
}

/**
 * M3: a retry timer does not survive a restart, and by design we do not
 * re-arm it (re-running a side-effecting action unprompted is exactly what
 * this store refuses to do). The truthful terminal state is `failed` with the
 * reason recorded; for a `once` the rule then reports missed-once with this
 * evidence attached, which is what prompts the user to reschedule.
 */
export function recoverOrphanedRetryWaitingJobs(): number {
  const r = getDb().prepare(
    "UPDATE jobs SET status='failed', error='retry was not rescheduled after restart', retry_at=NULL, finished_at=? WHERE status='retry-waiting'",
  ).run(Date.now());
  return Number(r.changes);
}

/**
 * M3: converge a job against the run it points at.
 *
 * A job left `running` at quit becomes failed/"interrupted by restart", while
 * M2's reconcileRunResults() may separately replay the linked run to a
 * truthful done + verification because its on-disk manifest proves it
 * committed. Without this the job permanently contradicts its own run.
 *
 * The WHERE clause is the safety property, not a convenience: it can only
 * rewrite rows this exact reconciliation path produced. A user-cancelled row
 * and a genuinely-failed row are untouchable — the same reasoning as the
 * `WHERE status='running'` guard on markDone/markFailed.
 */
export function replayJobTerminalFromRun(
  jobId: string,
  status: "done" | "failed",
  message: string,
  finishedAt: number,
): boolean {
  const sql = status === "done"
    ? "UPDATE jobs SET status='done', result=?, error=NULL, finished_at=? WHERE id=? AND status='failed' AND error='interrupted by restart'"
    : "UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=? AND status='failed' AND error='interrupted by restart'";
  const r = getDb().prepare(sql).run(String(message).slice(0, 2000), finishedAt, jobId);
  return Number(r.changes) > 0;
}

/** Jobs eligible for run-based convergence, newest first. */
export function listJobsInterruptedWithRun(limit = 500): Job[] {
  const rows = getDb().prepare(
    "SELECT * FROM jobs WHERE status='failed' AND error='interrupted by restart' AND run_id IS NOT NULL ORDER BY created_at DESC LIMIT ?",
  ).all(Math.max(1, Math.min(limit, 2000))) as any[];
  return rows.map(rowToJob);
}

// ── Terminal-execution notifications (M3) ──

export type NotificationKind = "done" | "failed" | "cancelled" | "missed";

export interface StoredNotification {
  dedupKey: string;
  jobId: string | null;
  ruleId: string;
  planId: string | null;
  kind: NotificationKind;
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
}

const KEEP_NOTIFICATIONS = 500;

function rowToNotification(r: any): StoredNotification {
  return {
    dedupKey: r.dedup_key, jobId: r.job_id ?? null, ruleId: r.rule_id,
    planId: r.plan_id ?? null, kind: r.kind,
    createdAt: Number(r.created_at),
    deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
    readAt: r.read_at == null ? null : Number(r.read_at),
  };
}

/**
 * Record a notification exactly once per dedup key.
 *
 * Returns the stored row plus `created: false` when the key was already
 * present. Callers use `created` to decide whether to actually alert, which is
 * what makes "one alert per final logical execution" hold across intermediate
 * retries and across restarts without any separate bookkeeping.
 */
export function recordNotification(p: {
  dedupKey: string;
  jobId?: string | null;
  ruleId: string;
  planId?: string | null;
  kind: NotificationKind;
  now: number;
  delivered: boolean;
}): { created: boolean; notification: StoredNotification } {
  const db = getDb();
  const res = db.prepare(
    "INSERT OR IGNORE INTO notifications (dedup_key, job_id, rule_id, plan_id, kind, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(p.dedupKey, p.jobId ?? null, p.ruleId, p.planId ?? null, p.kind, p.now, p.delivered ? p.now : null);
  const created = Number(res.changes) > 0;
  if (created) pruneNotifications();
  const row = db.prepare("SELECT * FROM notifications WHERE dedup_key=?").get(p.dedupKey) as any;
  return { created, notification: rowToNotification(row) };
}

function pruneNotifications(): void {
  try {
    getDb().prepare(
      "DELETE FROM notifications WHERE dedup_key NOT IN (SELECT dedup_key FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    ).run(KEEP_NOTIFICATIONS);
  } catch {
    /* best effort, mirrors pruneJobsByStatus */
  }
}

export function listNotifications(opts: { limit?: number; unreadOnly?: boolean } = {}): StoredNotification[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const sql = opts.unreadOnly
    ? "SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?"
    : "SELECT * FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?";
  return (getDb().prepare(sql).all(limit) as any[]).map(rowToNotification);
}

export function countUnreadNotifications(): number {
  try {
    const r = getDb().prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").get() as any;
    return Number(r?.n) || 0;
  } catch {
    return 0;
  }
}

export function markNotificationsRead(keys: string[], now = Date.now()): number {
  if (!Array.isArray(keys) || keys.length === 0) return 0;
  const stmt = getDb().prepare("UPDATE notifications SET read_at=? WHERE dedup_key=? AND read_at IS NULL");
  let changed = 0;
  for (const key of keys.slice(0, 500)) {
    if (typeof key !== "string" || !key) continue;
    changed += Number(stmt.run(now, key).changes) || 0;
  }
  return changed;
}
