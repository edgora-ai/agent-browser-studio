// M2 unit tests: news-collect verifier + controlled table + write-path input validation.
// The verifier is the trust boundary: it only counts rows that actually exist
// in news_run_results_v1 with the run's own run_id.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// pid-suffixed: this file PLANTS a wrong-shape table at the db path to exercise
// schema_incompatible. With a fixed path, two vitest processes running
// concurrently share it and each sees the other's planted table, so an
// unrelated suite reports schema_incompatible and the run goes red.
const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-m2-verifier-test-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
}));

import {
  agentDbExec,
  closeAgentDb,
  ensureNewsRunResultSchema,
  readNewsRowsForRun,
  countNewsRowsForRun,
  NEWS_RUN_TABLE,
} from "../../src/main/services/agent-db.js";
import {
  getRunVerifier,
  validateTemplateInputsForAction,
  DATASET_CAPS,
} from "../../src/main/services/run-verifiers.js";
import { normalizeTemplateInputs } from "../../src/main/services/config-manager.js";

const RUN_A = "run_verifier_a";
const RUN_B = "run_verifier_b";

function insertRow(runId: string, url: string, overrides: Record<string, unknown> = {}): void {
  agentDbExec(
    `INSERT INTO ${NEWS_RUN_TABLE} (run_id, title, url, source, published_at) VALUES (?, ?, ?, ?, ?)`,
    [
      runId,
      overrides.title ?? `Title for ${url}`,
      url,
      overrides.source ?? "example.com",
      overrides.published_at ?? "2026-09-19T08:30:00Z",
    ],
  );
}

function insertValidRows(runId: string, count: number, urlPrefix = "https://example.com/news/"): void {
  for (let i = 0; i < count; i++) insertRow(runId, `${urlPrefix}${runId}-${i}`);
}

const verifier = getRunVerifier("news-collect", 1)!;

beforeEach(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  closeAgentDb();
  const schema = ensureNewsRunResultSchema();
  expect(schema.ok).toBe(true);
});

afterEach(() => {
  closeAgentDb();
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
});

describe("ensureNewsRunResultSchema", () => {
  it("creates the controlled table with the pinned shape", () => {
    const rows = readNewsRowsForRun(RUN_A, 10);
    expect(rows).toEqual([]);
    // CREATE IF NOT EXISTS is idempotent.
    expect(ensureNewsRunResultSchema().ok).toBe(true);
  });

  it("reports schema_incompatible for a pre-existing wrong-shape table", () => {
    closeAgentDb();
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    // Simulate a legacy/foreign table occupying the name BEFORE the main
    // process gets to create it: open a fresh db via agentDbExec DDL.
    agentDbExec(`CREATE TABLE ${NEWS_RUN_TABLE} (id INTEGER PRIMARY KEY, note TEXT)`);
    const res = ensureNewsRunResultSchema();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasonCode).toBe("schema_incompatible");
    // And the verifier degrades to manual_review instead of throwing.
    const outcome = verifier.verify({ runId: RUN_A, inputs: { sourceUrl: "https://example.com", limit: "10" } });
    expect(outcome.kind).toBe("manual");
    if (outcome.kind === "manual") expect(outcome.verification.reasonCode).toBe("schema_incompatible");
  });
});

describe("news-collect verifier", () => {
  const inputs = { sourceUrl: "https://example.com/search?q=market", limit: "20" };

  it("passes a run with exactly limit valid rows", () => {
    insertValidRows(RUN_A, 20);
    const outcome = verifier.verify({ runId: RUN_A, inputs });
    expect(outcome.kind).toBe("auto");
    if (outcome.kind !== "auto") return;
    expect(outcome.verification.status).toBe("passed");
    expect(outcome.verification.counts).toEqual({
      expected: 20, observed: 20, inspected: 20, accepted: 20, rejected: 0, missing: 0, extra: 0,
    });
    expect(outcome.dataset.rows).toHaveLength(20);
    expect(outcome.dataset.sourceRowCount).toBe(20);
    expect(outcome.dataset.rejectedRowCount).toBe(0);
    expect(outcome.verification.verifierId).toBe("news-collect.dataset");
  });

  it("grades 18 valid + 2 invalid as partial with issue codes", () => {
    insertValidRows(RUN_A, 18);
    insertRow(RUN_A, "not-a-url");
    agentDbExec(
      `INSERT INTO ${NEWS_RUN_TABLE} (run_id, title, url, source, published_at) VALUES (?, ?, ?, ?, ?)`,
      [RUN_A, "   ", "https://example.com/blank-title", "example.com", "2026-09-19"],
    );
    const outcome = verifier.verify({ runId: RUN_A, inputs });
    expect(outcome.kind).toBe("auto");
    if (outcome.kind !== "auto") return;
    expect(outcome.verification.status).toBe("partial");
    expect(outcome.verification.counts).toEqual({
      expected: 20, observed: 20, inspected: 20, accepted: 18, rejected: 2, missing: 0, extra: 0,
    });
    const codes = outcome.verification.issues.map((i) => i.code).sort();
    expect(codes).toEqual(["invalid_url", "required_empty"]);
    expect(outcome.dataset.rows).toHaveLength(18);
    expect(outcome.dataset.rejectedRowCount).toBe(2);
  });

  it("grades zero rows as failed (expected > 0, accepted = 0)", () => {
    const outcome = verifier.verify({ runId: RUN_A, inputs });
    expect(outcome.kind).toBe("auto");
    if (outcome.kind !== "auto") return;
    expect(outcome.verification.status).toBe("failed");
    expect(outcome.verification.counts).toEqual({
      expected: 20, observed: 0, inspected: 0, accepted: 0, rejected: 0, missing: 20, extra: 0,
    });
  });

  it("keeps two runs with identical URLs fully isolated", () => {
    insertValidRows(RUN_A, 20, "https://example.com/shared/");
    insertValidRows(RUN_B, 20, "https://example.com/shared/");
    const a = verifier.verify({ runId: RUN_A, inputs });
    const b = verifier.verify({ runId: RUN_B, inputs });
    expect(a.kind).toBe("auto");
    expect(b.kind).toBe("auto");
    if (a.kind === "auto" && b.kind === "auto") {
      expect(a.verification.status).toBe("passed");
      expect(b.verification.status).toBe("passed");
    }
    // Rows attributed to a third, unknown run are invisible to both.
    insertValidRows("run_attacker", 5, "https://evil.example/");
    expect(countNewsRowsForRun(RUN_A)).toBe(20);
    const a2 = verifier.verify({ runId: RUN_A, inputs });
    if (a2.kind === "auto") expect(a2.verification.counts.observed).toBe(20);
  });

  it("enforces UNIQUE(run_id, url) at the database layer", () => {
    insertRow(RUN_A, "https://example.com/dup");
    expect(() => insertRow(RUN_A, "https://example.com/dup")).toThrow();
    // The same URL is still fine for another run.
    expect(() => insertRow(RUN_B, "https://example.com/dup")).not.toThrow();
  });

  it("rejects bad timestamps and oversized fields row-wise", () => {
    insertRow(RUN_A, "https://example.com/bad-ts", { published_at: "yesterday" });
    insertRow(RUN_A, "https://example.com/long-title", { title: "x".repeat(501) });
    insertValidRows(RUN_A, 8);
    const outcome = verifier.verify({ runId: RUN_A, inputs: { sourceUrl: "https://example.com", limit: "10" } });
    expect(outcome.kind).toBe("auto");
    if (outcome.kind !== "auto") return;
    expect(outcome.verification.status).toBe("partial");
    expect(outcome.verification.counts.accepted).toBe(8);
    expect(outcome.verification.counts.rejected).toBe(2);
    const codes = outcome.verification.issues.map((i) => i.code).sort();
    expect(codes).toEqual(["invalid_timestamp", "value_too_large"]);
  });

  it("counts over-collection as extra (not a clean pass)", () => {
    insertValidRows(RUN_A, 3);
    const outcome = verifier.verify({ runId: RUN_A, inputs: { sourceUrl: "https://example.com", limit: "2" } });
    expect(outcome.kind).toBe("auto");
    if (outcome.kind !== "auto") return;
    expect(outcome.verification.status).toBe("partial");
    expect(outcome.verification.counts).toEqual({
      expected: 2, observed: 3, inspected: 3, accepted: 3, rejected: 0, missing: 0, extra: 1,
    });
  });

  it("sanitizes secret-bearing query values in the persisted snapshot", () => {
    insertRow(RUN_A, "https://example.com/story?id=1&token=supersecret&lang=en");
    const outcome = verifier.verify({ runId: RUN_A, inputs: { sourceUrl: "https://example.com", limit: "1" } });
    expect(outcome.kind).toBe("auto");
    if (outcome.kind !== "auto") return;
    expect(outcome.verification.status).toBe("passed");
    expect(outcome.dataset.rows[0].url).toContain("token=%5BREDACTED%5D");
    expect(outcome.dataset.rows[0].url).not.toContain("supersecret");
  });

  it("rejects URLs with embedded credentials", () => {
    insertRow(RUN_A, "https://user:pass@example.com/story");
    const outcome = verifier.verify({ runId: RUN_A, inputs: { sourceUrl: "https://example.com", limit: "1" } });
    expect(outcome.kind).toBe("auto");
    if (outcome.kind !== "auto") return;
    expect(outcome.verification.status).toBe("failed");
    expect(outcome.verification.issues[0].code).toBe("invalid_url");
  });

  it("defers to manual_review when rows exceed the inspection cap", () => {
    const over = DATASET_CAPS.maxRows + 1;
    const stmt = `INSERT INTO ${NEWS_RUN_TABLE} (run_id, title, url, source, published_at) VALUES (?, ?, ?, ?, ?)`;
    for (let i = 0; i < over; i++) {
      agentDbExec(stmt, [RUN_A, `t${i}`, `https://example.com/mass/${i}`, "s", "2026-09-19"]);
    }
    expect(countNewsRowsForRun(RUN_A)).toBe(over);
    const outcome = verifier.verify({ runId: RUN_A, inputs: { sourceUrl: "https://example.com", limit: "10" } });
    expect(outcome.kind).toBe("manual");
    if (outcome.kind === "manual") expect(outcome.verification.reasonCode).toBe("row_cap_exceeded");
  }, 30000);

  it("cleanupRun deletes only that run's rows", () => {
    insertValidRows(RUN_A, 5);
    insertValidRows(RUN_B, 5);
    verifier.cleanupRun(RUN_A);
    expect(countNewsRowsForRun(RUN_A)).toBe(0);
    expect(countNewsRowsForRun(RUN_B)).toBe(5);
  });
});

describe("news-collect input validation", () => {
  it("accepts a valid sourceUrl and defaults limit", () => {
    const res = verifier.validateInputs({ sourceUrl: "https://example.com/feed" });
    expect(res).toEqual({ ok: true, inputs: { sourceUrl: "https://example.com/feed", limit: "10" } });
  });

  it("rejects missing/invalid/secret-bearing sourceUrl and bad limits", () => {
    const bad: Array<Record<string, string>> = [
      {},
      { sourceUrl: "ftp://example.com" },
      { sourceUrl: "not a url" },
      { sourceUrl: "https://user:pw@example.com" },
      { sourceUrl: "https://example.com/?api_key=abc" },
      { sourceUrl: "https://example.com", limit: "0" },
      { sourceUrl: "https://example.com", limit: "101" },
      { sourceUrl: "https://example.com", limit: "ten" },
    ];
    for (const inputs of bad) {
      const res = verifier.validateInputs(inputs);
      expect(res.ok, JSON.stringify(inputs)).toBe(false);
    }
  });

  it("builds an execution contract carrying the real runId and inputs", () => {
    const contract = verifier.buildExecutionContract({ runId: RUN_A, inputs: { sourceUrl: "https://example.com", limit: "7" } });
    expect(contract).toContain(RUN_A);
    expect(contract).toContain(NEWS_RUN_TABLE);
    expect(contract).toContain("https://example.com");
    expect(contract).toContain("limit = 7");
    expect(contract).toContain("UNIQUE(run_id,url)");
  });
});

describe("validateTemplateInputsForAction (write path)", () => {
  const structural = normalizeTemplateInputs;

  it("passes actions without a machine-checkable template", () => {
    expect(validateTemplateInputsForAction({}, structural).ok).toBe(true);
    expect(validateTemplateInputsForAction({ templateId: "price-scrape", templateInputs: { a: "b" } }, structural).ok).toBe(true);
    expect(validateTemplateInputsForAction({ templateId: "no-such-template", templateInputs: { a: "b" } }, structural).ok).toBe(true);
  });

  it("allows a machine template without inputs (legacy → manual_review at runtime)", () => {
    expect(validateTemplateInputsForAction({ templateId: "news-collect" }, structural).ok).toBe(true);
  });

  it("rejects structurally over-cap inputs", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
    const res = validateTemplateInputsForAction({ templateId: "news-collect", templateInputs: tooMany }, structural);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("structural");
  });

  it("rejects semantically invalid inputs", () => {
    const res = validateTemplateInputsForAction(
      { templateId: "news-collect", templateInputs: { sourceUrl: "ftp://x" } },
      structural,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("http");
  });
});
