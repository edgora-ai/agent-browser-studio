// Agent DB (node:sqlite) unit tests
//
// Everything here runs against a REAL on-disk database in a per-run temp
// userData directory. There is deliberately no in-memory/injected connection
// seam: the read path's whole contract is that it holds a SQLite read-only
// handle, and that handle can only be exercised against a real file.
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(
  os.tmpdir(),
  `agent-browser-agent-db-test-${process.pid}-${Date.now()}`,
);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  agentDbQuery, agentDbExec, agentDbTables, agentDbTableData,
  agentDbExecScript, closeAgentDb,
} from "../../src/main/services/agent-db.js";

const dbFile = (): string => path.join(TEST_USER_DATA, "agent-store.sqlite");

describe("Agent DB (node:sqlite)", () => {
  beforeEach(() => {
    closeAgentDb();
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });
  afterEach(() => {
    closeAgentDb();
  });
  afterAll(() => {
    closeAgentDb();
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("first query on a fresh install opens both handles lazily", () => {
    expect(fs.existsSync(dbFile())).toBe(false);
    const r = agentDbQuery("SELECT 1 AS ok, 'x' AS v");
    expect(r.rows).toEqual([{ ok: 1, v: "x" }]);
    // The writer (which owns schema init) must have created the real file.
    expect(fs.existsSync(dbFile())).toBe(true);
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

  it("db_query refuses WITH-prefixed writes and leaves every row intact", () => {
    // Regression: the allowlist anchors on the first keyword and accepts WITH
    // for legitimate CTEs, but SQLite also lets WITH prefix DELETE/INSERT/
    // UPDATE. A keyword regex cannot separate those, so the read path must be
    // enforced by the engine (read-only handle) rather than by SQL text.
    agentDbExec("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT)");
    agentDbExec("INSERT INTO orders (customer) VALUES (?), (?), (?)", ["a", "b", "c"]);
    expect((agentDbQuery("SELECT COUNT(*) AS c FROM orders").rows[0] as any).c).toBe(3);

    const writes = [
      "WITH x AS (SELECT 1) DELETE FROM orders",
      "WITH x AS (SELECT 1) INSERT INTO orders (customer) VALUES ('d')",
      "WITH x AS (SELECT 1) UPDATE orders SET customer = 'z'",
      "WITH x AS (SELECT 1) INSERT INTO orders (customer) VALUES ('e') RETURNING id",
      "WITH x AS (SELECT 1) DELETE FROM orders RETURNING id",
      "WITH x AS (SELECT 1) UPDATE orders SET customer = 'z' RETURNING id",
    ];
    for (const sql of writes) {
      // Assert the engine-level refusal specifically (errcode 8 SQLITE_READONLY)
      // rather than a message match, so this cannot pass on a parsing error.
      let err: any = null;
      try { agentDbQuery(sql); } catch (e) { err = e; }
      expect(err, `read path must refuse: ${sql}`).not.toBeNull();
      expect(err.errcode, `refusal must come from the read-only handle: ${sql}`).toBe(8);
    }

    expect((agentDbQuery("SELECT COUNT(*) AS c FROM orders").rows[0] as any).c).toBe(3);
    expect((agentDbQuery("SELECT customer FROM orders ORDER BY id").rows as any[]).map((r) => r.customer))
      .toEqual(["a", "b", "c"]);
  });

  it("still allows the read-only statements the allowlist admits", () => {
    // The reader must not be so strict that legitimate reads break: plain
    // SELECT, a read-only CTE, EXPLAIN, and parameterized reads all still run.
    agentDbExec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    agentDbExec("INSERT INTO t (id, v) VALUES (?, ?)", [1, "one"]);

    expect(agentDbQuery("SELECT v FROM t").rows).toEqual([{ v: "one" }]);
    expect(agentDbQuery("WITH x AS (SELECT v FROM t) SELECT v FROM x").rows).toEqual([{ v: "one" }]);
    expect(agentDbQuery("EXPLAIN SELECT v FROM t").count).toBeGreaterThan(0);
    expect(agentDbQuery("SELECT v FROM t WHERE id = ?", [1]).rows).toEqual([{ v: "one" }]);
  });

  it("a refused write leaves the file untouched across close and reopen", () => {
    agentDbExec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    agentDbExec("INSERT INTO t (v) VALUES ('keep')");
    expect(() => agentDbQuery("WITH x AS (SELECT 1) DELETE FROM t")).toThrow(/readonly|read-only/i);

    closeAgentDb();
    // Read the file directly, bypassing the service entirely.
    const direct = new DatabaseSync(dbFile(), { readOnly: true });
    try {
      expect(direct.prepare("SELECT v FROM t").all()).toEqual([{ v: "keep" }]);
    } finally {
      direct.close();
    }
    // And the service finds it again once the handles are re-opened.
    const found = agentDbQuery("SELECT v FROM t WHERE v = ?", ["keep"]);
    expect(found.count).toBe(1);
    expect((found.rows[0] as any).v).toBe("keep");
  });

  it("the open read handle sees writes committed afterwards", () => {
    agentDbExec("CREATE TABLE t (v TEXT)");
    // Force the read-only handle open while the table is still empty.
    expect(agentDbQuery("SELECT * FROM t").count).toBe(0);
    agentDbExec("INSERT INTO t (v) VALUES ('later')");
    expect(agentDbQuery("SELECT v FROM t").rows).toEqual([{ v: "later" }]);
  });

  it("a refused write does not spoil the already-open reader", () => {
    // The two cases above are each tested in isolation; this one pins their
    // interaction on a single handle: the reader that just refused a write must
    // still be usable, and still see legitimate writes committed after it.
    agentDbExec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    agentDbExec("INSERT INTO t (v) VALUES ('a')");
    expect(agentDbQuery("SELECT v FROM t").rows).toEqual([{ v: "a" }]); // reader now open

    let err: any = null;
    try { agentDbQuery("WITH x AS (SELECT 1) DELETE FROM t"); } catch (e) { err = e; }
    expect(err?.errcode).toBe(8);

    // No close/reopen in between: this is the same handle that refused the write.
    agentDbExec("INSERT INTO t (v) VALUES ('b')");
    expect(agentDbQuery("SELECT v FROM t ORDER BY id").rows).toEqual([{ v: "a" }, { v: "b" }]);
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

  it("query caps rows at 1000, truncating past the boundary", () => {
    agentDbExec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const insertN = (n: number, offset = 0): void => {
      agentDbExec(
        "INSERT INTO t (id) VALUES " +
          Array.from({ length: n }, (_, i) => "(" + (i + offset) + ")").join(","),
      );
    };

    // Exactly at the cap: nothing dropped.
    insertN(1000);
    const atCap = agentDbQuery("SELECT * FROM t ORDER BY id");
    expect(atCap.count).toBe(1000);
    expect(atCap.rows.length).toBe(1000);
    expect(atCap.truncated).toBe(false);

    // One row past it: count reports the real total, rows stop at the cap.
    insertN(1, 1000);
    const over = agentDbQuery("SELECT * FROM t ORDER BY id");
    expect(over.count).toBe(1001);
    expect(over.rows.length).toBe(1000);
    expect(over.truncated).toBe(true);
    expect((over.rows[0] as any).id).toBe(0);
    expect((over.rows[999] as any).id).toBe(999);
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
