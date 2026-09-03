// Agent DB (node:sqlite) unit tests
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-agent-db-test");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  agentDbQuery, agentDbExec, agentDbTables, agentDbTableData,
  agentDbExecScript, _setDbForTesting,
} from "../../src/main/services/agent-db.js";

describe("Agent DB (node:sqlite)", () => {
  let mem: DatabaseSync;

  beforeEach(() => {
    mem = new DatabaseSync(":memory:");
    _setDbForTesting(mem);
  });
  afterEach(() => {
    try { mem.close(); } catch {}
    _setDbForTesting(null);
  });

  it("creates a table and reads it back via query", () => {
    agentDbExec("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, amount REAL)");
    agentDbExec("INSERT INTO orders (customer, amount) VALUES (?, ?)", ["Alice", 99.5]);
    const r = agentDbQuery("SELECT * FROM orders");
    expect(r.count).toBe(1);
    expect((r.rows[0] as any).customer).toBe("Alice");
    expect((r.rows[0] as any).amount).toBe(99.5);
  });

  it("db_query rejects non-SELECT statements", () => {
    expect(() => agentDbQuery("INSERT INTO t VALUES (1)")).toThrow();
    expect(() => agentDbQuery("DROP TABLE t")).toThrow();
  });

  it("db_query rejects PRAGMA (write side effects; use approval-gated db_exec) (R7 #41)", () => {
    // Either the allowlist error or the explicit PRAGMA error is acceptable —
    // both refuse the statement; the point is no PRAGMA executes via query.
    expect(() => agentDbQuery("PRAGMA journal_mode=WAL")).toThrow(/PRAGMA|只允许 SELECT/i);
    expect(() => agentDbQuery("/* x */ PRAGMA journal_mode=WAL")).toThrow(/PRAGMA|只允许 SELECT/i);
  });

  it("db_exec rejects SELECT", () => {
    agentDbExec("CREATE TABLE t (v INTEGER)");
    expect(() => agentDbExec("SELECT * FROM t")).toThrow();
  });

  it("exec returns changes + lastInsertRowid", () => {
    agentDbExec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const r1 = agentDbExec("INSERT INTO t (v) VALUES (?)", ["a"]);
    expect(r1.changes).toBe(1);
    expect(Number(r1.lastInsertRowid)).toBe(1);
    agentDbExec("INSERT INTO t (v) VALUES (?)", ["b"]);
    agentDbExec("UPDATE t SET v = ? WHERE id = ?", ["A", 1]);
    const r2 = agentDbQuery("SELECT v FROM t WHERE id = 1");
    expect((r2.rows[0] as any).v).toBe("A");
  });

  it("parameterized queries prevent injection", () => {
    agentDbExec("CREATE TABLE t (v TEXT)");
    const evil = "'); DROP TABLE t;--";
    agentDbExec("INSERT INTO t (v) VALUES (?)", [evil]);
    const r = agentDbQuery("SELECT v FROM t");
    expect((r.rows[0] as any).v).toBe(evil);
    // Table still exists (no DROP executed)
    expect(agentDbTables().find((t) => t.name === "t")).toBeTruthy();
  });

  it("tables() lists user tables with row counts", () => {
    agentDbExec("CREATE TABLE a (x INTEGER)");
    agentDbExec("CREATE TABLE b (y INTEGER)");
    agentDbExec("INSERT INTO a (x) VALUES (1),(2),(3)");
    const tables = agentDbTables();
    const names = tables.map((t) => t.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(tables.find((t) => t.name === "a")?.rowCount).toBe(3);
    expect(tables.find((t) => t.name === "b")?.rowCount).toBe(0);
  });

  it("tableData paginates and returns columns", () => {
    agentDbExec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    for (let i = 0; i < 25; i++) agentDbExec("INSERT INTO t (name) VALUES (?)", ["n" + i]);
    const page = agentDbTableData("t", 10, 5);
    expect(page.total).toBe(25);
    expect(page.rows.length).toBe(10);
    expect(page.columns).toEqual(["id", "name"]);
    expect((page.rows[0] as any).id).toBe(6);
  });

  it("tableData rejects invalid table names", () => {
    agentDbExec("CREATE TABLE legit (x INTEGER)");
    expect(() => agentDbTableData("bad name!")).toThrow();
    expect(() => agentDbTableData("t; DROP TABLE legit")).toThrow();
    // legit still there
    expect(agentDbTables().find((t) => t.name === "legit")).toBeTruthy();
  });

  it("query caps rows at 1000", () => {
    agentDbExec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    agentDbExec("INSERT INTO t (id) VALUES " + Array.from({ length: 50 }, (_, i) => "(" + i + ")").join(","));
    const r = agentDbQuery("SELECT * FROM t");
    expect(r.count).toBe(50);
    expect(r.truncated).toBe(false);
  });

  it("execScript runs multiple statements for the UI", () => {
    const r = agentDbExecScript("CREATE TABLE m (v TEXT); INSERT INTO m (v) VALUES ('hi');");
    expect(r.ok).toBe(true);
    expect(agentDbQuery("SELECT v FROM m").rows[0]).toMatchObject({ v: "hi" });
  });

  it("execScript reports errors", () => {
    const r = agentDbExecScript("THIS IS NOT SQL");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
