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
export type JobStatus = "queued" | "running" | "done" | "failed" | "skipped" | "cancelled";

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
  conn.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_jobs_rule ON jobs(rule_id);");
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
  };
}

export function enqueueJob(p: { ruleId: string; ruleName: string; source: JobSource; runId?: string | null }): Job {
  const id = newId();
  const now = Date.now();
  const runId = p.runId || null;
  getDb().prepare(
    "INSERT INTO jobs (id, rule_id, rule_name, source, status, attempt, run_id, created_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)",
  ).run(id, p.ruleId, p.ruleName, p.source, runId, now);
  return { id, ruleId: p.ruleId, ruleName: p.ruleName, source: p.source, status: "queued", attempt: 0, result: null, error: null, runId, createdAt: now, startedAt: null, finishedAt: null };
}

export function markRunning(id: string, attempt: number): void {
  getDb().prepare("UPDATE jobs SET status='running', attempt=?, started_at=? WHERE id=?").run(attempt, Date.now(), id);
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
