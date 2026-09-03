// Agent persistent SQLite store — a global, cross-run database the agent can
// query/mutate, and the UI can browse. Uses Node's built-in `node:sqlite`
// (zero native deps). File: <userData>/agent-store.sqlite.
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir } from "./config-manager.js";

let db: DatabaseSync | null = null;

function dbPath(): string {
  return path.join(getAppDataDir(), "agent-store.sqlite");
}

function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(getAppDataDir(), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(dbPath());
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return db;
}

/** Flush + close. Call on app quit so the WAL is checkpointed. */
export function closeAgentDb(): void {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
}

// For tests: swap the connection (e.g. to :memory:).
export function _setDbForTesting(testDb: DatabaseSync | null): void {
  db = testDb;
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
 * PRAGMA removed from the allowlist (R7 #41): PRAGMA journal_mode etc. have
 * write side effects — routing them through the read path bypasses the
 * destroy-approval gate. Use db_exec (approval-gated) for PRAGMA. */
export function agentDbQuery(sql: string, params?: unknown[]): QueryResult {
  if (!READONLY_RE.test(sql)) {
    throw new Error("db_query 只允许 SELECT/WITH/EXPLAIN;写操作请用 db_exec");
  }
  if (/^\s*PRAGMA\b/i.test(sql.replace(/^(--[^\n]*\n|\s|\(\*[\s\S]*?\*\/)*/, ""))) {
    throw new Error("db_query 不允许 PRAGMA（可能有写副作用）;请用 db_exec（需审批）");
  }
  const stmt = getDb().prepare(sql);
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
