// R0925-03 regression: truncation-aware verdicts and restart reconcile.
//
//  1. The result store is the single source of truth: a truncated snapshot is
//     committed as manual_review, so manifest and config can never diverge.
//  2. A run whose finalize already committed (verification != unverified) is
//     NEVER overwritten by terminal replay — the old code resurrected the
//     pre-truncation "passed" over manual_review on every boot.
//  3. A genuine crash window (manifest committed, finishRun never ran) still
//     recovers via replay.
//  4. A legacy manifest claiming passed over truncated evidence is read back
//     as manual_review.
//
// Runs the REAL store, recorder, config and reconcile on a temp userData
// root; small caps keep the fixtures tiny.
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(
  os.tmpdir(),
  `agent-browser-r0925-trunc-${process.pid}-${Date.now()}`,
);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { getAppDataDir, reloadConfig } from "../../src/main/services/config-manager.js";
import { agentRunRecorder, reconcileRunResults } from "../../src/main/services/agent-run-trace.js";
import { RunResultStore, runResultStore } from "../../src/main/services/run-result-store.js";
import type { AgentRunVerification } from "../../src/main/types.js";
import type { DatasetSnapshot } from "../../src/main/services/run-verifiers.js";

// 4 KiB per-run budget: a handful of fat rows forces truncation quickly.
const smallStore = () => new RunResultStore({
  rootProvider: () => getAppDataDir(),
  caps: { maxRunBytes: 4 * 1024, maxGlobalBytes: 256 * 1024 },
});

const PASSED: AgentRunVerification = {
  status: "passed",
  verifierId: "fixture-verifier",
  verifierVersion: 1,
  checkedAt: Date.now(),
  // Shape must satisfy the config normalizer's invariants or a persisted
  // verdict legitimately degrades to unverified on load.
  counts: { expected: 10, observed: 10, inspected: 10, accepted: 10, rejected: 0, missing: 0, extra: 0 },
  issues: [],
  issuesTruncated: false,
};

function fatDataset(rows: number): DatasetSnapshot {
  const cell = "x".repeat(512);
  return {
    columns: ["title", "url"],
    rows: Array.from({ length: rows }, (_, i) => ({ title: `${cell}-${i}`, url: `https://example.com/${i}` })),
    sourceRowCount: rows,
    rejectedRowCount: 0,
    truncated: false,
  };
}

function startRun(name: string) {
  return agentRunRecorder.startRun({
    source: { type: "automation", ruleId: "rule_fixture", templateId: "fixture-template", templateVersion: 1 },
    name,
  });
}

const terminal = (status: "done" | "error" = "done") => ({
  status,
  endReason: "completed" as const,
  finishedAt: Date.now(),
});

function commit(runId: string, dataset?: DatasetSnapshot) {
  const res = smallStore().commitRunResult({
    runId,
    runStartedAt: agentRunRecorder.getRun(runId)!.startedAt,
    templateId: "fixture-template",
    templateVersion: 1,
    verification: PASSED,
    terminal: terminal(),
    ...(dataset ? { dataset } : {}),
  });
  if (!res.ok) throw new Error(`commit failed: ${res.reasonCode}: ${res.detail}`);
  return res;
}

const manifestOnDisk = (runId: string) => JSON.parse(
  fs.readFileSync(path.join(getAppDataDir(), "agent-results", runId, "manifest.json"), "utf8"),
);

describe("truncation-aware verdicts (R0925-03)", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });
  afterAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("control: an untruncated commit keeps the verifier's passed verdict", () => {
    const run = startRun("control");
    const res = commit(run.id, fatDataset(2));
    expect(res.artifacts[0].truncated).toBe(false);
    expect(res.verification.status).toBe("passed");
    expect(manifestOnDisk(run.id).verification.status).toBe("passed");
  });

  it("single source: a truncated commit persists manual_review in result AND manifest", () => {
    const run = startRun("truncated");
    const res = commit(run.id, fatDataset(50));
    expect(res.artifacts[0].truncated).toBe(true);
    expect(res.verification.status).toBe("manual_review");
    if (res.verification.status === "manual_review") {
      expect(res.verification.reasonCode).toBe("artifact_limit");
      expect(res.verification.verifierId).toBe("fixture-verifier");
    }
    const manifest = manifestOnDisk(run.id);
    expect(manifest.verification.status).toBe("manual_review");
    // The read path accepts the manifest and serves the truncated preview.
    expect(runResultStore.readManifest(run.id).ok).toBe(true);
    const preview = runResultStore.readDatasetPreview(run.id, "dataset", 0, 100);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.value.truncated).toBe(true);
  });

  it("reconcile never replays over a committed finalize: interrupted + manual_review survives reboot", () => {
    const run = startRun("interrupted-finalized");
    const res = commit(run.id, fatDataset(50));
    agentRunRecorder.finishRun(run.id, "error", "automation scheduler stopping", {
      endReason: "interrupted",
      verification: res.verification,
      artifacts: res.artifacts,
    });
    reloadConfig();
    const report = reconcileRunResults();
    expect(report.terminalReplayed).toBe(0);
    const after = agentRunRecorder.getRun(run.id)!;
    expect(after.status).toBe("error");
    expect(after.endReason).toBe("interrupted");
    expect(after.verification.status).toBe("manual_review");
    // And a second reconcile pass stays converged.
    expect(reconcileRunResults().terminalReplayed).toBe(0);
  });

  it("genuine crash window (manifest committed, finishRun never ran) still recovers via replay", () => {
    const run = startRun("crash-window");
    const res = commit(run.id, fatDataset(2));
    agentRunRecorder.releaseRun(run.id); // simulated process death pre-finishRun
    reloadConfig();
    expect(agentRunRecorder.getRun(run.id)!.endReason).toBe("interrupted");
    const report = reconcileRunResults();
    expect(report.terminalReplayed).toBe(1);
    const after = agentRunRecorder.getRun(run.id)!;
    expect(after.status).toBe("done");
    expect(after.verification.status).toBe("passed");
    // Replay is convergent: the next boot does not replay again.
    expect(reconcileRunResults().terminalReplayed).toBe(0);
  });

  it("legacy manifest claiming passed over truncated evidence reconciles to manual_review", () => {
    const run = startRun("legacy-lying-manifest");
    commit(run.id, fatDataset(2));
    // Forge the pre-fix state: flip the artifact ref to truncated while the
    // manifest still claims passed (payload hashes stay valid).
    const manifestPath = path.join(getAppDataDir(), "agent-results", run.id, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.artifacts[0].truncated = true;
    manifest.artifacts[0].completeness = "partial";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(runResultStore.readManifest(run.id).ok).toBe(true);

    agentRunRecorder.releaseRun(run.id);
    reloadConfig();
    const report = reconcileRunResults();
    expect(report.terminalReplayed).toBe(1);
    const after = agentRunRecorder.getRun(run.id)!;
    expect(after.status).toBe("done");
    expect(after.verification.status).toBe("manual_review");
    if (after.verification.status === "manual_review") {
      expect(after.verification.reasonCode).toBe("artifact_limit");
    }
  });
});
