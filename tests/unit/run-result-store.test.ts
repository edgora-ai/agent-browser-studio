// M2 unit tests: RunResultStore — atomic commit, quotas, idempotency,
// tamper/symlink rejection, fault injection at write/fsync/rename points.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as realFs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// pid-suffixed: this file writes and deletes a real agent-results tree, so
// concurrent vitest processes must not share the root.
const TEST_ROOT = path.join(os.tmpdir(), `agent-browser-m2-result-store-test-${process.pid}`);

const h = vi.hoisted(() => ({
  /** Armed fs fault: which syscall fails and with which errno code. */
  fault: null as null | { syscall: "renameSync" | "writeSync" | "fsyncSync"; code: string },
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_ROOT : "/tmp"),
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const maybeFail = (syscall: "renameSync" | "writeSync" | "fsyncSync") => {
    if (h.fault && h.fault.syscall === syscall) {
      const err: any = new Error(`${h.fault.code}: injected ${syscall} failure`);
      err.code = h.fault.code;
      throw err;
    }
  };
  return {
    ...actual,
    renameSync: (from: any, to: any) => { maybeFail("renameSync"); return (actual.renameSync as any)(from, to); },
    writeSync: (fd: any, data: any, ...rest: any[]) => { maybeFail("writeSync"); return (actual.writeSync as any)(fd, data, ...rest); },
    fsyncSync: (fd: any) => { maybeFail("fsyncSync"); return actual.fsyncSync(fd); },
  };
});

import { RunResultStore } from "../../src/main/services/run-result-store.js";
import type { DatasetSnapshot } from "../../src/main/services/run-verifiers.js";
import type { AgentRunVerification } from "../../src/main/types.js";

const RUN = "run_store_test1";
const VERIFICATION: AgentRunVerification = {
  status: "passed",
  verifierId: "news-collect.dataset",
  verifierVersion: 1,
  checkedAt: 1700000000000,
  counts: { expected: 2, observed: 2, inspected: 2, accepted: 2, rejected: 0, missing: 0, extra: 0 },
  issues: [],
  issuesTruncated: false,
};

function makeDataset(rows: string[][]): DatasetSnapshot {
  return {
    columns: ["title", "url", "source", "published_at"],
    rows,
    sourceRowCount: rows.length,
    rejectedRowCount: 0,
    truncated: false,
  };
}

function makeArgs(rows: string[][], overrides: Record<string, unknown> = {}): any {
  return {
    runId: RUN,
    runStartedAt: 1700000000000,
    templateId: "news-collect",
    templateVersion: 1,
    verification: VERIFICATION,
    terminal: { status: "done", endReason: "completed", finishedAt: 1700000001000 },
    dataset: makeDataset(rows),
    ...overrides,
  };
}

const ROWS = [
  { title: "Title A", url: "https://example.com/a", source: "example.com", published_at: "2026-09-19T08:00:00Z" },
  { title: "Title B", url: "https://example.com/b", source: "example.com", published_at: "2026-09-19T09:00:00Z" },
];
const ROWS_MAJOR = ROWS.map((r) => [r.title, r.url, r.source, r.published_at]);

let store: RunResultStore;

beforeEach(() => {
  h.fault = null;
  realFs.rmSync(TEST_ROOT, { recursive: true, force: true });
  store = new RunResultStore({ rootProvider: () => TEST_ROOT, now: () => 1700000000000 });
});

afterEach(() => {
  h.fault = null;
  realFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("commit + read back", () => {
  it("writes dataset + manifest atomically and reads them back verified", () => {
    const res = store.commitRunResult(makeArgs(ROWS));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reused).toBe(false);
    expect(res.artifacts).toHaveLength(1);
    const ref = res.artifacts[0];
    expect(ref).toMatchObject({
      id: "dataset",
      kind: "dataset",
      completeness: "complete",
      truncated: false,
      rowCount: 2,
      sourceRowCount: 2,
      exportPolicy: "csv",
    });
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);

    // Direct disk check (no store API): both files exist, manifest is last-write truth.
    const runDir = path.join(TEST_ROOT, "agent-results", RUN);
    const manifestRaw = JSON.parse(realFs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
    expect(manifestRaw.runId).toBe(RUN);
    expect(manifestRaw.artifacts[0].sha256).toBe(ref.sha256);
    expect(manifestRaw.verification.status).toBe("passed");
    const datasetRaw = JSON.parse(realFs.readFileSync(path.join(runDir, "artifacts", "dataset.json"), "utf8"));
    expect(datasetRaw.rows).toEqual(ROWS_MAJOR);

    // Store read path verifies hashes before returning content.
    const preview = store.readDatasetPreview(RUN, "dataset", 0, 100);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.value.rows).toEqual(ROWS_MAJOR);
      expect(preview.value.total).toBe(2);
      expect(preview.value.columns).toEqual(["title", "url", "source", "published_at"]);
    }
  });

  it("reuses a matching manifest idempotently (no rewrite)", () => {
    const first = store.commitRunResult(makeArgs(ROWS));
    expect(first.ok).toBe(true);
    const manifestPath = path.join(TEST_ROOT, "agent-results", RUN, "manifest.json");
    const before = realFs.readFileSync(manifestPath, "utf8");
    const second = store.commitRunResult(makeArgs(ROWS));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reused).toBe(true);
    expect(realFs.readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("refuses to overwrite a conflicting manifest", () => {
    expect(store.commitRunResult(makeArgs(ROWS)).ok).toBe(true);
    const conflict = store.commitRunResult(makeArgs([{ title: "Other", url: "https://example.com/c", source: "s", published_at: "2026-09-19" }]));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reasonCode).toBe("integrity_conflict");
    // Original content untouched.
    const preview = store.readDatasetPreview(RUN, "dataset", 0, 100);
    expect(preview.ok && preview.value.rows).toEqual(ROWS_MAJOR);
  });
});

describe("quotas", () => {
  it("truncates at a row boundary when the per-run budget is tight", () => {
    const tiny = new RunResultStore({
      rootProvider: () => TEST_ROOT,
      caps: { maxRunBytes: 500 },
      now: () => 1700000000000,
    });
    const rows = Array.from({ length: 50 }, (_, i) => ({ title: `Title ${i}`, url: `https://example.com/${i}`, source: "s", published_at: "2026-09-19" }));
    const res = tiny.commitRunResult(makeArgs(rows));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ref = res.artifacts[0];
    expect(ref.truncated).toBe(true);
    expect(ref.completeness).toBe("partial");
    expect(ref.truncationReason).toBe("run_quota");
    expect(ref.rowCount!).toBeGreaterThanOrEqual(0);
    expect(ref.rowCount!).toBeLessThan(50);
    expect(ref.sourceRowCount).toBe(50);
    const preview = tiny.readDatasetPreview(RUN, "dataset", 0, 100);
    expect(preview.ok && preview.value.rows.length).toBe(ref.rowCount);
  });

  it("fails with artifact_limit when even an empty dataset exceeds the budget", () => {
    const impossible = new RunResultStore({
      rootProvider: () => TEST_ROOT,
      caps: { maxRunBytes: 10 },
      now: () => 1700000000000,
    });
    const res = impossible.commitRunResult(makeArgs(ROWS));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasonCode).toBe("artifact_limit");
    // Nothing was persisted.
    expect(realFs.existsSync(path.join(TEST_ROOT, "agent-results", RUN, "manifest.json"))).toBe(false);
  });

  it("fails when the global budget is exhausted and never deletes old results", () => {
    expect(store.commitRunResult(makeArgs(ROWS)).ok).toBe(true);
    const capped = new RunResultStore({
      rootProvider: () => TEST_ROOT,
      caps: { maxGlobalBytes: 1 },
      now: () => 1700000001000,
    });
    const res = capped.commitRunResult(makeArgs(ROWS, { runId: "run_store_test2" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasonCode).toBe("artifact_limit");
    // The first run's data is intact.
    const preview = store.readDatasetPreview(RUN, "dataset", 0, 100);
    expect(preview.ok && preview.value.rows).toEqual(ROWS_MAJOR);
  });
});

describe("fault injection", () => {
  it("rename failure surfaces as write_failed and leaves no tmp files", () => {
    h.fault = { syscall: "renameSync", code: "EIO" };
    const res = store.commitRunResult(makeArgs(ROWS));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasonCode).toBe("write_failed");
    const runDir = path.join(TEST_ROOT, "agent-results", RUN);
    const leftovers = realFs.existsSync(runDir)
      ? realFs.readdirSync(runDir, { recursive: true }).map(String).filter((n) => path.basename(n).startsWith(".tmp-"))
      : [];
    expect(leftovers).toEqual([]);
    expect(store.hasManifest(RUN)).toBe(false);
  });

  it("ENOSPC at write maps to artifact_limit and preserves old data", () => {
    expect(store.commitRunResult(makeArgs(ROWS)).ok).toBe(true);
    h.fault = { syscall: "writeSync", code: "ENOSPC" };
    const res = store.commitRunResult(makeArgs(ROWS, { runId: "run_store_test3" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasonCode).toBe("artifact_limit");
    expect(store.readDatasetPreview(RUN, "dataset", 0, 100).ok).toBe(true);
  });

  it("fsync failure surfaces as write_failed", () => {
    h.fault = { syscall: "fsyncSync", code: "EIO" };
    const res = store.commitRunResult(makeArgs(ROWS));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasonCode).toBe("write_failed");
  });
});

describe("integrity + path safety", () => {
  it("rejects reads after the payload is tampered with", () => {
    expect(store.commitRunResult(makeArgs(ROWS)).ok).toBe(true);
    const datasetPath = path.join(TEST_ROOT, "agent-results", RUN, "artifacts", "dataset.json");
    realFs.writeFileSync(datasetPath, JSON.stringify({ schemaVersion: 1, kind: "dataset", runId: RUN, rows: [] }));
    const res = store.readDatasetPreview(RUN, "dataset", 0, 100);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasonCode).toBe("integrity_error");
  });

  it("rejects a symlinked payload path", () => {
    expect(store.commitRunResult(makeArgs(ROWS)).ok).toBe(true);
    const datasetPath = path.join(TEST_ROOT, "agent-results", RUN, "artifacts", "dataset.json");
    realFs.rmSync(datasetPath);
    realFs.symlinkSync("/etc/passwd", datasetPath);
    const res = store.readDatasetPreview(RUN, "dataset", 0, 100);
    expect(res.ok).toBe(false);
  });

  it("rejects invalid run ids and unknown artifacts", () => {
    expect(store.commitRunResult(makeArgs(ROWS, { runId: "../escape" })).ok).toBe(false);
    expect(store.readDatasetPreview(RUN, "../escape", 0, 100).ok).toBe(false);
    expect(store.readDatasetPreview(RUN, "nope", 0, 100).ok).toBe(false);
  });

  it("rejects oversized cells and non-object rows", () => {
    const bigCell = store.commitRunResult(makeArgs([{ title: "x".repeat(64 * 1024 + 1), url: "u", source: "s", published_at: "t" }]));
    expect(bigCell.ok).toBe(false);
    if (!bigCell.ok) expect(bigCell.reasonCode).toBe("artifact_invalid");
    const nonObject = store.commitRunResult(makeArgs(["only-one" as any]));
    expect(nonObject.ok).toBe(false);
    if (!nonObject.ok) expect(nonObject.reasonCode).toBe("artifact_invalid");
  });
});

describe("deletion + reconcile support", () => {
  it("deleteRunResults removes the directory; sweepTempFiles removes stray tmp", () => {
    expect(store.commitRunResult(makeArgs(ROWS)).ok).toBe(true);
    const runDir = path.join(TEST_ROOT, "agent-results", RUN);
    realFs.writeFileSync(path.join(runDir, ".tmp-stray"), "junk");
    expect(store.listStoredRunIds()).toEqual([RUN]);
    expect(store.sweepTempFiles()).toBe(1);
    expect(realFs.existsSync(path.join(runDir, ".tmp-stray"))).toBe(false);
    expect(store.deleteRunResults(RUN)).toEqual({ ok: true });
    expect(realFs.existsSync(runDir)).toBe(false);
    expect(store.listStoredRunIds()).toEqual([]);
  });

  it("caps preview pages at 100 rows and paginates", () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ title: `t${i}`, url: `https://example.com/${i}`, source: "s", published_at: "2026-09-19" }));
    expect(store.commitRunResult(makeArgs(rows)).ok).toBe(true);
    const page1 = store.readDatasetPreview(RUN, "dataset", 0, 500);
    expect(page1.ok && page1.value.rows.length).toBe(100);
    const page2 = store.readDatasetPreview(RUN, "dataset", 100, 100);
    expect(page2.ok && page2.value.rows.length).toBe(50);
    expect(page2.ok && page2.value.total).toBe(150);
  });
});
