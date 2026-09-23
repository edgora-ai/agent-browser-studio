// M2 unit tests: run recorder finalize metadata, config-first cleanup
// (eviction / delete / clear), and startup reconcile against the result store.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// pid-suffixed: concurrent vitest processes would otherwise share one db and
// one agent-results tree, and each would reconcile the other's runs.
const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-m2-reconcile-test-${process.pid}`);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { agentRunRecorder, reconcileRunResults } from "../../src/main/services/agent-run-trace.js";
import { getConfig, reloadConfig } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import { runResultStore } from "../../src/main/services/run-result-store.js";
import { agentDbExec, closeAgentDb, countNewsRowsForRun, ensureNewsRunResultSchema, NEWS_RUN_TABLE } from "../../src/main/services/agent-db.js";
import type { AgentRunArtifactRef, AgentRunVerification } from "../../src/main/types.js";

const PASSED: AgentRunVerification = {
  status: "passed",
  verifierId: "news-collect.dataset",
  verifierVersion: 1,
  checkedAt: 1700000000000,
  counts: { expected: 1, observed: 1, inspected: 1, accepted: 1, rejected: 0, missing: 0, extra: 0 },
  issues: [],
  issuesTruncated: false,
};

const ARTIFACT: AgentRunArtifactRef = {
  id: "dataset",
  kind: "dataset",
  name: "dataset.json",
  mediaType: "application/json",
  createdAt: 1700000000000,
  bytes: 100,
  sha256: "a".repeat(64),
  completeness: "complete",
  truncated: false,
  exportPolicy: "csv",
  rowCount: 1,
};

function runDir(runId: string): string {
  return path.join(TEST_USER_DATA, "agent-results", runId);
}

function insertRow(runId: string, url: string): void {
  agentDbExec(
    `INSERT INTO ${NEWS_RUN_TABLE} (run_id, title, url, source, published_at) VALUES (?, ?, ?, ?, ?)`,
    [runId, `t-${url}`, url, "s", "2026-09-19"],
  );
}

function commitResultFor(run: { id: string; startedAt: number }, terminal: { status: "done" | "error"; endReason: string; finishedAt: number }): void {
  const res = runResultStore.commitRunResult({
    runId: run.id,
    runStartedAt: run.startedAt,
    templateId: "news-collect",
    templateVersion: 1,
    verification: PASSED,
    terminal,
    dataset: {
      columns: ["title", "url", "source", "published_at"],
      rows: [{ title: "t", url: "https://example.com/x", source: "s", published_at: "2026-09-19" }],
      sourceRowCount: 1,
      rejectedRowCount: 0,
      truncated: false,
    },
  });
  if (!res.ok) throw new Error(`commitRunResult failed: ${res.reasonCode} ${res.detail}`);
}

beforeEach(() => {
  closeAgentDb();
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  reloadConfig();
  ensureNewsRunResultSchema();
});

afterEach(() => {
  closeAgentDb();
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  reloadConfig();
});

describe("finishRun metadata", () => {
  it("persists verification + artifact refs in the same commit", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "m2 meta" });
    agentRunRecorder.finishRun(run.id, "done", undefined, { endReason: "completed", verification: PASSED, artifacts: [ARTIFACT] });
    const persisted = (getConfig() as any).agentRuns.find((r: any) => r.id === run.id);
    expect(persisted.status).toBe("done");
    expect(persisted.endReason).toBe("completed");
    expect(persisted.verification).toEqual(PASSED);
    expect(persisted.artifacts).toEqual([ARTIFACT]);
  });
});

describe("config-first cleanup", () => {
  it("eviction by the 200-run retention removes result dir and template rows", () => {
    const first = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "evicted" });
    insertRow(first.id, "https://example.com/evicted");
    commitResultFor(first, { status: "done", endReason: "completed", finishedAt: Date.now() });
    agentRunRecorder.finishRun(first.id, "done", undefined, { endReason: "completed", verification: PASSED, artifacts: [ARTIFACT] });
    expect(fs.existsSync(runDir(first.id))).toBe(true);
    expect(countNewsRowsForRun(first.id)).toBe(1);

    for (let i = 0; i < 200; i++) {
      agentRunRecorder.startRun({ source: { type: "chat" }, name: `filler ${i}` });
    }
    expect((getConfig() as any).agentRuns.find((r: any) => r.id === first.id)).toBeUndefined();
    expect(fs.existsSync(runDir(first.id))).toBe(false);
    expect(countNewsRowsForRun(first.id)).toBe(0);
  }, 60000);

  it("deleteRun removes the result dir and rows after the config commit", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "delete me" });
    insertRow(run.id, "https://example.com/deleteme");
    commitResultFor(run, { status: "done", endReason: "completed", finishedAt: Date.now() });
    expect(agentRunRecorder.deleteRun(run.id)).toBe(true);
    expect(fs.existsSync(runDir(run.id))).toBe(false);
    expect(countNewsRowsForRun(run.id)).toBe(0);
  });

  it("clearRuns removes every result dir and row", () => {
    const a = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "a" });
    const b = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "b" });
    insertRow(a.id, "https://example.com/a");
    insertRow(b.id, "https://example.com/b");
    commitResultFor(a, { status: "done", endReason: "completed", finishedAt: Date.now() });
    commitResultFor(b, { status: "done", endReason: "completed", finishedAt: Date.now() });
    expect(agentRunRecorder.clearRuns()).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(runDir(a.id))).toBe(false);
    expect(fs.existsSync(runDir(b.id))).toBe(false);
    expect(countNewsRowsForRun(a.id)).toBe(0);
    expect(countNewsRowsForRun(b.id)).toBe(0);
  });
});

describe("reconcileRunResults", () => {
  it("backfills artifacts + verification from a valid manifest", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "backfill" });
    agentRunRecorder.finishRun(run.id, "done", undefined, { endReason: "completed" });
    commitResultFor(run, { status: "done", endReason: "completed", finishedAt: Date.now() });
    // Strip refs from config to simulate an M1-era run that predates the store.
    transact((draft: any) => {
      const r = (draft.agentRuns || []).find((x: any) => x.id === run.id);
      delete r.artifacts;
      r.verification = { status: "unverified" };
    });
    const report = reconcileRunResults();
    expect(report.refsBackfilled).toBe(1);
    const persisted = (getConfig() as any).agentRuns.find((r: any) => r.id === run.id);
    expect(persisted.artifacts?.length).toBe(1);
    expect(persisted.verification.status).toBe("passed");
  });

  it("replays the manifest terminal state for a run recovered as interrupted", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "replay" });
    // Manifest commits; the process "crashes" before finishRun lands.
    commitResultFor(run, { status: "done", endReason: "completed", finishedAt: 1700000001000 });
    agentRunRecorder.releaseRun(run.id);
    // Simulate the restart: load-time recovery marks the run interrupted.
    reloadConfig();
    const recovered = (getConfig() as any).agentRuns.find((r: any) => r.id === run.id);
    expect(recovered.status).toBe("error");
    expect(recovered.endReason).toBe("interrupted");

    const report = reconcileRunResults();
    expect(report.terminalReplayed).toBe(1);
    const healed = (getConfig() as any).agentRuns.find((r: any) => r.id === run.id);
    expect(healed.status).toBe("done");
    expect(healed.endReason).toBe("completed");
    expect(healed.verification.status).toBe("passed");
    expect(healed.artifacts?.length).toBe(1);
  });

  it("does NOT replay when runStartedAt mismatches (foreign manifest)", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "mismatch" });
    const res = runResultStore.commitRunResult({
      runId: run.id,
      runStartedAt: run.startedAt + 99999,
      templateId: "news-collect",
      templateVersion: 1,
      verification: PASSED,
      terminal: { status: "done", endReason: "completed", finishedAt: Date.now() },
    });
    expect(res.ok).toBe(true);
    agentRunRecorder.releaseRun(run.id);
    reloadConfig();
    const report = reconcileRunResults();
    expect(report.terminalReplayed).toBe(0);
    const persisted = (getConfig() as any).agentRuns.find((r: any) => r.id === run.id);
    expect(persisted.endReason).toBe("interrupted");
  });

  it("drops config refs whose manifest is missing and downgrades to manual_review", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", templateId: "news-collect", templateVersion: 1 }, name: "dangling" });
    agentRunRecorder.finishRun(run.id, "done", undefined, { endReason: "completed", verification: PASSED, artifacts: [ARTIFACT] });
    // No result dir exists for this run.
    expect(fs.existsSync(runDir(run.id))).toBe(false);
    const report = reconcileRunResults();
    expect(report.refsDropped).toBe(1);
    const persisted = (getConfig() as any).agentRuns.find((r: any) => r.id === run.id);
    expect(persisted.artifacts).toBeUndefined();
    expect(persisted.verification).toMatchObject({ status: "manual_review", reasonCode: "integrity_error" });
  });

  it("removes orphan store directories (no config run)", () => {
    const ghost = { id: "run_ghost_orphan", startedAt: 1700000000000 };
    commitResultFor(ghost, { status: "done", endReason: "completed", finishedAt: Date.now() });
    insertRow(ghost.id, "https://example.com/ghost");
    expect(fs.existsSync(runDir(ghost.id))).toBe(true);
    const report = reconcileRunResults();
    expect(report.orphanDirsRemoved).toBe(1);
    expect(fs.existsSync(runDir(ghost.id))).toBe(false);
    expect(countNewsRowsForRun(ghost.id)).toBe(0);
  });
});
