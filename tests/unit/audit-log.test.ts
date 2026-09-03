import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordAudit, listAudit, clearAudit, _setAuditPathForTesting } from "../../src/main/services/audit-log.js";

let tmp: string;
function freshLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  const p = path.join(dir, "audit.log.jsonl");
  _setAuditPathForTesting(p);
  return p;
}

describe("audit-log", () => {
  beforeEach(() => { tmp = freshLog(); });
  afterEach(() => { try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch {} _setAuditPathForTesting(null); });

  it("appends entries and lists them newest-first", () => {
    recordAudit({ category: "profile", action: "launch", target: "p1", at: 1000 });
    recordAudit({ category: "profile", action: "stop", target: "p1", at: 2000 });
    const list = listAudit(10);
    expect(list.length).toBe(2);
    expect(list[0].action).toBe("stop");   // newest first
    expect(list[1].action).toBe("launch");
    expect(list[0].id).toBeTruthy();
    expect(list[0].at).toBe(2000);
  });

  it("filters by category and target", () => {
    recordAudit({ category: "profile", action: "launch", target: "p1", at: 1000 });
    recordAudit({ category: "llm", action: "save", at: 2000 });
    recordAudit({ category: "profile", action: "stop", target: "p2", at: 3000 });
    expect(listAudit(10, { category: "profile" }).length).toBe(2);
    expect(listAudit(10, { category: "llm" }).length).toBe(1);
    expect(listAudit(10, { target: "p1" }).length).toBe(1);
  });

  it("clears the log", () => {
    recordAudit({ category: "x", action: "y", at: 1 });
    expect(listAudit(10).length).toBe(1);
    clearAudit();
    expect(listAudit(10).length).toBe(0);
  });

  it("returns [] when the log file does not exist", () => {
    fs.rmSync(tmp, { force: true });
    expect(listAudit(10)).toEqual([]);
  });

  it("survives a malformed line (skips it)", () => {
    fs.appendFileSync(tmp, "not-json\n");
    recordAudit({ category: "ok", action: "good", at: 5 });
    const list = listAudit(10);
    expect(list.length).toBe(1);
    expect(list[0].action).toBe("good");
  });

  it("never throws on a non-writable path", () => {
    // Use a path whose parent is a file, not a directory — mkdirSync will fail
    // on every platform. On Windows with admin, /no/such/dir is writable.
    const file = freshLog();
    fs.writeFileSync(file, "x");
    const impossibleChild = file + "/audit.log.jsonl";
    _setAuditPathForTesting(impossibleChild);
    expect(() => recordAudit({ category: "x", action: "y", at: 1 })).not.toThrow();
    expect(listAudit(10)).toEqual([]);
  });

  it("seals the log owner-only (0600) on first append", () => {
    recordAudit({ category: "x", action: "y", at: 1 });
    if (process.platform !== "win32") {
      expect(fs.statSync(tmp).mode & 0o777).toBe(0o600);
    }
  });

  it("persists across re-reads (append-only file)", () => {
    recordAudit({ category: "a", action: "1", at: 1 });
    recordAudit({ category: "a", action: "2", at: 2 });
    recordAudit({ category: "a", action: "3", at: 3 });
    expect(listAudit(10).length).toBe(3);
  });
});
