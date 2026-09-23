// Agent persistent SQLite store — a global, cross-run database the agent can
// query/mutate, and the UI can browse. Uses Node's built-in `node:sqlite`
// (zero native deps). File: <userData>/agent-store.sqlite.
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir } from "./config-manager.js";

let db: DatabaseSync | null = null;
let reader: DatabaseSync | null = null;

function dbPath(): string {
  return path.join(getAppDataDir(), "agent-store.sqlite");
}

/** The single writable connection. Creating it also creates the database file,
 *  so it must run before the read-only handle is opened (opening read-only
 *  against a missing file fails with SQLITE_CANTOPEN). */
function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(getAppDataDir(), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(dbPath());
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return db;
}

/** Read-only connection used by agentDbQuery. Opens the writer first: on a
 *  fresh install there is no file yet and a read-only handle cannot create one.
 *  Enforcement lives here — the engine rejects the writes a `SELECT|WITH|
 *  EXPLAIN` prefix check cannot see. */
function getReader(): DatabaseSync {
  getDb(); // writer first: creates the file and the WAL
  if (!reader) {
    reader = new DatabaseSync(dbPath(), { readOnly: true });
  }
  return reader;
}

/** Flush + close. Call on app quit so the WAL is checkpointed. */
export function closeAgentDb(): void {
  // Reader first: a lingering read handle can hold the WAL and defeat the
  // checkpoint this function exists to perform.
  try { reader?.close(); } catch (e) { console.error("[agent-db] reader close failed:", e); }
  reader = null;
  try { db?.close(); } catch (e) { console.error("[agent-db] writer close failed:", e); }
  db = null;
}

const READONLY_RE = /^\s*(SELECT|WITH|EXPLAIN)\b/i;
const ROW_CAP = 1000;
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface QueryResult {
  rows: unknown[];
  count: number;
  truncated: boolean;
}

/** Read-only query (SELECT/WITH/EXPLAIN). Caps rows at 1000.
 *
 *  The prefix check only produces the error message; the read-only handle is
 *  what enforces the guarantee, so never fall back to the writer here.
 *
 *  PRAGMA stays refused (R7 #41): the write-bearing ones (journal_mode etc.)
 *  would bypass the destroy-approval gate on db_exec. */
export function agentDbQuery(sql: string, params?: unknown[]): QueryResult {
  if (!READONLY_RE.test(sql)) {
    throw new Error("db_query 只允许 SELECT/WITH/EXPLAIN;写操作请用 db_exec");
  }
  if (/^\s*PRAGMA\b/i.test(sql.replace(/^(--[^\n]*\n|\s|\(\*[\s\S]*?\*\/)*/, ""))) {
    throw new Error("db_query 不允许 PRAGMA（可能有写副作用）;请用 db_exec（需审批）");
  }
  const stmt = getReader().prepare(sql);
  const all = params && params.length ? stmt.all(...(params as any[])) : stmt.all();
  const truncated = all.length > ROW_CAP;
  return { rows: truncated ? all.slice(0, ROW_CAP) : all, count: all.length, truncated };
}

/** Write / DDL (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP). Rejects SELECT. */
export function agentDbExec(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
  if (READONLY_RE.test(sql)) {
    throw new Error("db_exec 不允许 SELECT;读取请用 db_query");
  }
  const stmt = getDb().prepare(sql);
  const r = params && params.length ? stmt.run(...(params as any[])) : stmt.run();
  return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
}

export interface TableInfo {
  name: string;
  sql: string;
  rowCount: number;
}

/** List user tables (sqlite_master), with row counts. For the UI viewer. */
export function agentDbTables(): TableInfo[] {
  const rows = getDb()
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; sql: string }>;
  return rows.map((row) => {
    let rowCount = 0;
    if (IDENT_RE.test(row.name)) {
      try {
        rowCount = (getDb().prepare(`SELECT COUNT(*) AS c FROM "${row.name}"`).get() as { c: number }).c;
      } catch { /* ignore */ }
    }
    return { name: row.name, sql: row.sql || "", rowCount };
  });
}

/** Paged read of a table's rows. Validates table name against identifier regex. */
export function agentDbTableData(table: string, limit = 100, offset = 0): { rows: unknown[]; total: number; columns: string[] } {
  if (!IDENT_RE.test(table)) throw new Error(`invalid table name: ${table}`);
  const total = (getDb().prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
  const rows = getDb()
    .prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`)
    .all(Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0)) as Record<string, unknown>[];
  // Derive column order from the first row (or pragma).
  let columns: string[] = [];
  try {
    columns = (getDb().prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
  } catch { /* ignore */ }
  if (columns.length === 0 && rows.length > 0) columns = Object.keys(rows[0]);
  return { rows, total, columns };
}

/** Run arbitrary SQL (possibly multiple statements) for the UI SQL box. */
export function agentDbExecScript(sql: string): { ok: boolean; error?: string } {
  try {
    getDb().exec(sql);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ── Controlled template tables (M2) ──
// These tables are created and shape-validated by the MAIN process only.
// The agent may INSERT rows scoped to its own run_id; it must never
// CREATE/DROP/ALTER them (the execution contract says so, and the schema
// check below turns any pre-existing incompatible table into a
// manual_review verdict instead of a silent migration — never DROP).

export const NEWS_RUN_TABLE = "news_run_results_v1";
/** Physical column order, pinned; id first, run_id second. */
const NEWS_RUN_COLUMNS = ["id", "run_id", "title", "url", "source", "published_at"] as const;

export interface NewsRunRow {
  id: number;
  run_id: string;
  title: string;
  url: string;
  source: string;
  published_at: string;
}

export type EnsureNewsSchemaResult =
  | { ok: true }
  | { ok: false; reasonCode: "schema_incompatible"; detail: string };

/** Create (if absent) and shape-validate the controlled news table. Column
 *  shape is checked BEFORE creating the index: a pre-existing incompatible
 *  table must surface as schema_incompatible, not as a DDL error. */
export function ensureNewsRunResultSchema(): EnsureNewsSchemaResult {
  const d = getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS "${NEWS_RUN_TABLE}" (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    source TEXT NOT NULL,
    published_at TEXT NOT NULL,
    UNIQUE(run_id, url)
  )`);
  const cols = (d.prepare(`PRAGMA table_info("${NEWS_RUN_TABLE}")`).all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.length !== NEWS_RUN_COLUMNS.length || !NEWS_RUN_COLUMNS.every((c, i) => cols[i] === c)) {
    return { ok: false, reasonCode: "schema_incompatible", detail: `${NEWS_RUN_TABLE} columns: ${cols.join(",")}` };
  }
  d.exec(`CREATE INDEX IF NOT EXISTS idx_news_run_results_v1_run ON "${NEWS_RUN_TABLE}"(run_id)`);
  const indexes = d.prepare(`PRAGMA index_list("${NEWS_RUN_TABLE}")`).all() as Array<{ name: string; unique: number | boolean }>;
  const hasUniqueRunUrl = indexes.some((ix) => {
    if (!ix.unique) return false;
    if (!IDENT_RE.test(ix.name)) return false;
    const ixCols = (d.prepare(`PRAGMA index_info("${ix.name}")`).all() as Array<{ name: string }>).map((c) => c.name);
    return ixCols.length === 2 && ixCols[0] === "run_id" && ixCols[1] === "url";
  });
  if (!hasUniqueRunUrl) {
    return { ok: false, reasonCode: "schema_incompatible", detail: `${NEWS_RUN_TABLE} missing UNIQUE(run_id, url)` };
  }
  return { ok: true };
}

/** Exact row count for a run (read-only handle). Table name is a compile-time
 *  constant; run_id is always a bound parameter. */
export function countNewsRowsForRun(runId: string): number {
  const row = getReader()
    .prepare(`SELECT COUNT(*) AS c FROM "${NEWS_RUN_TABLE}" WHERE run_id = ?`)
    .get(runId) as { c: number };
  return Number(row.c);
}

/** Read up to `limit` rows for a run in insertion order (read-only handle). */
export function readNewsRowsForRun(runId: string, limit: number): NewsRunRow[] {
  const cap = Math.min(Math.max(Math.trunc(limit), 1), 10000);
  return getReader()
    .prepare(`SELECT id, run_id, title, url, source, published_at FROM "${NEWS_RUN_TABLE}" WHERE run_id = ? ORDER BY id LIMIT ?`)
    .all(runId, cap) as unknown as NewsRunRow[];
}

/** Delete every row belonging to a run (run cleanup / retention). */
export function deleteNewsRowsForRun(runId: string): number {
  const r = getDb().prepare(`DELETE FROM "${NEWS_RUN_TABLE}" WHERE run_id = ?`).run(runId);
  return Number(r.changes);
}
