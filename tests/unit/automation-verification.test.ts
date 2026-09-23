// M2-6 unit tests: the automation lifecycle around template verifiers.
//
// What is asserted here (and not covered by any other suite):
//   1. The execution contract reaches agentChat ONLY for a fully resolved
//      template run (valid inputs + prepared storage).
//   2. The single finalize path grades the rows the run ACTUALLY wrote:
//      passed / partial / failed, plus manual_review degradations.
//   3. Verification never changes the execution verdict — a partial harvest is
//      still a job success, so no retry is scheduled off a business verdict.
//   4. endReason fidelity: round_limit / timeout / user_cancelled / interrupted
//      all reach the persisted run trace through the real abort plumbing.
//   5. A hard precondition failure skips the model call entirely.
//   6. Retry lineage: a new run id with source.retryOf, and no hardcoded name.
//
// Real config manager, real RunRecorder, real SQLite store, real result store
// against a tmpdir userData; only the LLM, browser manager and job store are
// stubbed (the job store is a separate SQLite file with no bearing on this
// suite, stubbed so its failures can never be mistaken for failures here).
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// pid-suffixed: shares the agent db + results tree with the other M2 store
// tests, so concurrent vitest processes must not collide on one directory.
const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-m2-automation-verify-test-${process.pid}`);

const mocks = vi.hoisted(() => ({
  agentChat: vi.fn(),
  launchBrowser: vi.fn(),
  enqueueJob: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../../src/main/services/local-agent.js", () => ({
  agentChat: mocks.agentChat,
  getOrDetectLlmConfig: () => ({ provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "mock" }),
}));

vi.mock("../../src/main/services/browser-manager.js", () => ({
  launchBrowser: mocks.launchBrowser,
  stopBrowser: vi.fn(() => true),
  statusBrowser: () => ({ running: true }),
  touchProfileActivity: () => {},
}));

vi.mock("../../src/main/services/job-store.js", () => ({
  enqueueJob: mocks.enqueueJob,
  markRunning: vi.fn(),
  markDone: vi.fn(),
  markFailed: vi.fn(),
  markSkipped: vi.fn(),
  markCancelled: vi.fn(),
  markJobRunId: vi.fn(),
  recoverInterruptedJobs: () => 0,
  pruneJobs: () => 0,
  getJob: () => null,
}));

import {
  cancelRunningJob, retryAgentRun, startScheduler, stopScheduler, testRunRule, jobGuard,
} from "../../src/main/services/automation.js";
import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { getConfig, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { agentDbExec, closeAgentDb, ensureNewsRunResultSchema, NEWS_RUN_TABLE } from "../../src/main/services/agent-db.js";
import { runResultStore, type RunResultManifest } from "../../src/main/services/run-result-store.js";
import type { AutomationAction, AutomationRule, AgentRun } from "../../src/main/types.js";

const SOURCE_URL = "https://example.com/search?q=market";
const NEWS_ACTION: AutomationAction = {
  type: "agent-task",
  agentPrompt: "collect news",
  profileDirId: "profile_a",
  templateId: "news-collect",
  templateInputs: { sourceUrl: SOURCE_URL, limit: "3" },
};

let seq = 0;
function insertRow(runId: string, over: Record<string, string> = {}): void {
  seq++;
  agentDbExec(
    `INSERT INTO ${NEWS_RUN_TABLE} (run_id, title, url, source, published_at) VALUES (?, ?, ?, ?, ?)`,
    [
      runId,
      over.title ?? `title-${seq}`,
      over.url ?? `https://example.com/a/${seq}`,
      over.source ?? "Example",
      over.published_at ?? "2026-09-19T08:30:00Z",
    ],
  );
}

/** Insert N valid rows scoped to the run the agentChat stub was handed. */
function rowsFor(runId: string, n: number): void {
  for (let i = 0; i < n; i++) insertRow(runId, { url: `https://example.com/n/${seq + 1}` });
}

function addRule(action: AutomationAction, over: Partial<AutomationRule> = {}): AutomationRule {
  seq++;
  const id = `rule_${seq}`;
  const rule: AutomationRule = {
    id,
    name: id,
    enabled: true,
    createdAt: Date.now(),
    trigger: { type: "once", at: Date.now() + 60000 },
    action,
    ...over,
  };
  const cfg = getConfig() as any;
  cfg.automation = cfg.automation || [];
  cfg.automation.push(rule);
  // Persist through the public path so the rule is normalized exactly as the
  // UI would store it (structure bounds applied to templateInputs etc.).
  saveConfig(cfg);
  return rule;
}

/** Test-run a rule through the real executeAction path (no scheduler timing). */
async function runRule(rule: AutomationRule): Promise<{ ok: boolean; result: string }> {
  const out = await testRunRule(rule.id);
  jobGuard.clear(rule.id);
  return out;
}

function latestRunFor(ruleId: string): AgentRun {
  const runs = agentRunRecorder.listRuns().filter((r) => r.source?.ruleId === ruleId);
  expect(runs.length).toBeGreaterThan(0);
  return runs[0];
}

function manifestFor(runId: string): RunResultManifest {
  const res = runResultStore.readManifest(runId);
  if (!res.ok) throw new Error(`manifest unreadable: ${res.reasonCode} ${res.detail}`);
  return res.value;
}

/** A promise plus its resolver, so a test can wait for the mock to be entered. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

/** agentChat stub that writes `n` rows, signals `entered`, then hangs until
 *  aborted — resolving with the typed abort reason like a real long action. */
function hangAfterRows(entered: () => void, n: number) {
  return async (_c: any, _m: any, opts: any) => {
    rowsFor(opts.runId, n);
    entered();
    return await new Promise((_resolve, reject) => {
      if (opts.signal.aborted) return reject(opts.signal.reason);
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
    });
  };
}

beforeEach(() => {
  closeAgentDb();
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  reloadConfig();
  ensureNewsRunResultSchema();
  mocks.agentChat.mockReset();
  mocks.launchBrowser.mockReset().mockResolvedValue({ pid: 10, cdpPort: 20 });
  mocks.enqueueJob.mockReset().mockImplementation(() => ({ id: `job_${++seq}` }));
  jobGuard.reset();
});

afterEach(() => {
  closeAgentDb();
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  reloadConfig();
  jobGuard.reset();
});

describe("execution contract injection", () => {
  it("injects the contract carrying the real run id for a fully resolved template run", async () => {
    mocks.agentChat.mockImplementation(async (_c: any, _m: any, opts: any) => {
      rowsFor(opts.runId, 3);
      return { messages: [], endReason: "completed" };
    });
    const rule = addRule(NEWS_ACTION);
    await runRule(rule);

    expect(mocks.agentChat).toHaveBeenCalledTimes(1);
    const opts = mocks.agentChat.mock.calls[0][2];
    const run = latestRunFor(rule.id);
    expect(opts.templateExecution).toContain(run.id);
    expect(opts.templateExecution).toContain(NEWS_RUN_TABLE);
    expect(opts.templateExecution).toContain("禁止对该表 CREATE/DROP/ALTER");
    // The contract is built by the verifier only — it must not smuggle the raw
    // prompt through a second channel.
    expect(opts.templateExecution).not.toContain("collect news");
  });

  it("does NOT inject a contract for a legacy rule with no structured inputs", async () => {
    mocks.agentChat.mockResolvedValue({ messages: [], endReason: "completed" });
    const rule = addRule({ type: "agent-task", agentPrompt: "collect news", profileDirId: "profile_a", templateId: "news-collect" });
    await runRule(rule);

    expect(mocks.agentChat.mock.calls[0][2].templateExecution).toBeUndefined();
    expect(latestRunFor(rule.id).verification).toMatchObject({ status: "manual_review", reasonCode: "input_unavailable" });
  });

  it("does NOT inject a contract for a template with no machine verifier", async () => {
    mocks.agentChat.mockResolvedValue({ messages: [], endReason: "completed" });
    const rule = addRule({ type: "agent-task", agentPrompt: "prices", profileDirId: "profile_a", templateId: "price-scrape" });
    await runRule(rule);

    expect(mocks.agentChat.mock.calls[0][2].templateExecution).toBeUndefined();
    const run = latestRunFor(rule.id);
    expect(run.verification).toEqual({ status: "unverified" });
    expect(run.source.templateId).toBeUndefined();
  });
});

describe("verification hook", () => {
  it("grades a clean sweep as passed, with counts, artifact and matching manifest", async () => {
    mocks.agentChat.mockImplementation(async (_c: any, _m: any, opts: any) => {
      rowsFor(opts.runId, 3);
      return { messages: [], endReason: "completed" };
    });
    const rule = addRule(NEWS_ACTION);
    const out = await runRule(rule);
    expect(out.ok).toBe(true);

    const run = latestRunFor(rule.id);
    expect(run.status).toBe("done");
    expect(run.endReason).toBe("completed");
    expect(run.source.templateId).toBe("news-collect");
    expect(run.source.templateVersion).toBe(1);
    expect(run.verification).toMatchObject({
      status: "passed",
      verifierId: "news-collect.dataset",
      verifierVersion: 1,
      counts: { expected: 3, observed: 3, inspected: 3, accepted: 3, rejected: 0, missing: 0, extra: 0 },
    });

    // The persisted artifact ref agrees with the run rows in SQLite and with
    // the manifest on disk.
    expect(run.artifacts?.length).toBe(1);
    const manifest = manifestFor(run.id);
    expect(manifest.runId).toBe(run.id);
    expect(manifest.templateId).toBe("news-collect");
    expect(manifest.verification).toEqual(run.verification);
    expect(manifest.artifacts[0].rowCount).toBe(3);
    expect(manifest.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("grades a partial harvest as partial WITHOUT failing the job", async () => {
    // 2 valid rows + 1 row with an unparseable timestamp; the model claims success.
    mocks.agentChat.mockImplementation(async (_c: any, _m: any, opts: any) => {
      insertRow(opts.runId, { url: "https://example.com/ok/1" });
      insertRow(opts.runId, { url: "https://example.com/ok/2" });
      insertRow(opts.runId, { url: "https://example.com/bad", published_at: "not-a-date" });
      return { messages: [], endReason: "completed" };
    });
    const rule = addRule(NEWS_ACTION);
    const out = await runRule(rule);

    // Layer separation: execution succeeded, the business verdict did not pass.
    // A partial must not become a job failure (that would schedule a retry on a
    // business verdict).
    expect(out.ok).toBe(true);
    const run = latestRunFor(rule.id);
    expect(run.status).toBe("done");
    expect(run.verification).toMatchObject({
      status: "partial",
      counts: { expected: 3, observed: 3, inspected: 3, accepted: 2, rejected: 1, missing: 0, extra: 0 },
    });
    const v = run.verification as any;
    expect(v.issues.map((i: any) => i.code)).toContain("invalid_timestamp");
    expect(manifestFor(run.id).artifacts[0].rowCount).toBe(2);
  });

  it("grades 'the model reported done but wrote nothing' as failed", async () => {
    mocks.agentChat.mockResolvedValue({ messages: [], endReason: "completed" });
    const rule = addRule(NEWS_ACTION);
    await runRule(rule);

    const run = latestRunFor(rule.id);
    expect(run.status).toBe("done");
    expect(run.verification).toMatchObject({
      status: "failed",
      counts: { expected: 3, observed: 0, inspected: 0, accepted: 0, rejected: 0, missing: 3, extra: 0 },
    });
  });

  it("counts only this run's rows when a foreign run wrote to the same table", async () => {
    insertRow("run_someone_else", { url: "https://example.com/foreign" });
    insertRow("run_someone_else", { url: "https://example.com/foreign2" });
    mocks.agentChat.mockImplementation(async (_c: any, _m: any, opts: any) => {
      rowsFor(opts.runId, 3);
      return { messages: [], endReason: "completed" };
    });
    const rule = addRule(NEWS_ACTION);
    await runRule(rule);

    const run = latestRunFor(rule.id);
    expect(run.verification).toMatchObject({ status: "passed", counts: { observed: 3 } });
    expect(manifestFor(run.id).artifacts[0].rowCount).toBe(3);
  });

  it("skips the model call on a hard precondition failure and records manual_review", async () => {
    const rule = addRule({ ...NEWS_ACTION, templateInputs: { sourceUrl: "not a url", limit: "3" } });
    const out = await runRule(rule);

    expect(out.ok).toBe(false);
    expect(mocks.agentChat).not.toHaveBeenCalled();
    const run = latestRunFor(rule.id);
    expect(run.status).toBe("error");
    expect(run.verification).toMatchObject({ status: "manual_review", reasonCode: "input_invalid" });
  });

  it("downgrades to manual_review/artifact_limit when the snapshot must be truncated", async () => {
    // 100 rows of ~470 B ≈ 47 KiB of payload against a temporarily lowered
    // per-run budget: every row is VALID (so the verdict is a clean sweep at
    // verify time) but the snapshot cannot be stored whole. The store truncates
    // at a row boundary, and the verdict must degrade to manual_review rather
    // than pass over evidence the user cannot actually see.
    const before = runResultStore.caps.maxRunBytes;
    runResultStore.caps.maxRunBytes = 16 * 1024;
    try {
      const big = "x".repeat(400);
      mocks.agentChat.mockImplementation(async (_c: any, _m: any, opts: any) => {
        for (let i = 0; i < 100; i++) insertRow(opts.runId, { url: `https://example.com/big/${i}`, title: big });
        return { messages: [], endReason: "completed" };
      });
      const rule = addRule({ ...NEWS_ACTION, templateInputs: { sourceUrl: SOURCE_URL, limit: "100" } });
      await runRule(rule);

      const run = latestRunFor(rule.id);
      expect(run.verification).toMatchObject({ status: "manual_review", reasonCode: "artifact_limit" });
      // The truncated snapshot is still persisted, and honestly marked partial.
      expect(run.artifacts?.[0]).toMatchObject({ truncated: true, completeness: "partial" });
      expect(run.artifacts?.[0].rowCount).toBeLessThan(100);
      expect(run.artifacts?.[0].sourceRowCount).toBe(100);
    } finally {
      runResultStore.caps.maxRunBytes = before;
    }
  });
});

describe("endReason fidelity", () => {
  it("records round_limit when the agent loop hits its tool-call ceiling", async () => {
    mocks.agentChat.mockImplementation(async (_c: any, _m: any, opts: any) => {
      rowsFor(opts.runId, 3);
      return { messages: [], error: "Max tool-calling rounds reached", endReason: "round_limit" };
    });
    const rule = addRule(NEWS_ACTION);
    await runRule(rule);

    const run = latestRunFor(rule.id);
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("round_limit");
    // The rows written before the loop gave up are still real evidence.
    expect(run.verification).toMatchObject({ status: "passed" });
  });

  it("records timeout when the wall-clock guard aborts the run", async () => {
    // runTimeoutMs is a RULE field, not an action field: passing it inside the
    // action would leave the rule on the 5-minute default and this test would
    // hang instead of timing out.
    const rule = addRule(NEWS_ACTION, { runTimeoutMs: 1000 });
    expect(rule.runTimeoutMs).toBe(1000);
    const entered = gate();
    mocks.agentChat.mockImplementation(hangAfterRows(entered.open, 1));

    const pending = testRunRule(rule.id);
    await entered.promise;
    const out = await pending; // the guard's 1s timer fires during this await
    jobGuard.clear(rule.id);

    expect(out.ok).toBe(false);
    const run = latestRunFor(rule.id);
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("timeout");
    // Rows written before the timeout are still graded — missing, not ignored.
    expect(run.verification).toMatchObject({
      status: "partial",
      counts: { expected: 3, observed: 1, accepted: 1, rejected: 0, missing: 2 },
    });
  }, 15000);

  it("records user_cancelled when the job is cancelled from the UI", async () => {
    mocks.enqueueJob.mockReturnValue({ id: "job_cancel_1" });
    const rule = addRule(NEWS_ACTION);
    const entered = gate();
    mocks.agentChat.mockImplementation(hangAfterRows(entered.open, 1));

    const pending = testRunRule(rule.id);
    await entered.promise;
    cancelRunningJob("job_cancel_1");
    const out = await pending;
    jobGuard.clear(rule.id);

    expect(out.ok).toBe(false);
    const run = latestRunFor(rule.id);
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("user_cancelled");
  });

  // Kept last in the file: stopScheduler() flips module-level `stopping`, which
  // every later run in this process would observe. The test restores it by
  // clearing the rules and restarting the (now empty) scheduler.
  it("records interrupted when the scheduler stops mid-run", async () => {
    const rule = addRule(NEWS_ACTION);
    const entered = gate();
    mocks.agentChat.mockImplementation(hangAfterRows(entered.open, 1));

    const pending = testRunRule(rule.id);
    await entered.promise;
    stopScheduler();
    const out = await pending;
    jobGuard.clear(rule.id);

    expect(out.ok).toBe(false);
    const run = latestRunFor(rule.id);
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("interrupted");

    // Restore scheduler module state for the rest of the process.
    const cfg = getConfig() as any;
    cfg.automation = [];
    saveConfig(cfg);
    startScheduler();
  });
});

describe("retry lineage", () => {
  it("re-runs a terminal failed run under a new id carrying source.retryOf", async () => {
    mocks.agentChat.mockResolvedValue({ messages: [], error: "boom", endReason: "execution_error" });
    const rule = addRule(NEWS_ACTION);
    await runRule(rule);
    const first = latestRunFor(rule.id);
    expect(first.status).toBe("error");
    expect(first.verification).toMatchObject({ status: "failed" });

    mocks.agentChat.mockImplementation(async (_c: any, _m: any, opts: any) => {
      rowsFor(opts.runId, 3);
      return { messages: [], endReason: "completed" };
    });
    const retry = await retryAgentRun(first.id);
    jobGuard.clear(rule.id);
    expect(retry.ok).toBe(true);

    const second = agentRunRecorder.getRun(retry.runId!)!;
    expect(second.id).not.toBe(first.id);
    expect(second.source.retryOf).toBe(first.id);
    expect(second.verification).toMatchObject({ status: "passed" });
    // Lineage is rendered from source.retryOf; the persisted name must not bake
    // in a hardcoded "（重试）" suffix.
    expect(second.name).toBe(rule.name);
    expect(second.name).not.toContain("重试");

    // The original run and its result directory are untouched.
    const original = agentRunRecorder.getRun(first.id)!;
    expect(original.status).toBe("error");
    expect(original.verification).toMatchObject({ status: "failed" });
    expect(original.artifacts?.[0].sha256).toBe(first.artifacts?.[0].sha256);
    expect(manifestFor(first.id).artifacts[0].sha256).toBe(first.artifacts?.[0].sha256);
  });
});
