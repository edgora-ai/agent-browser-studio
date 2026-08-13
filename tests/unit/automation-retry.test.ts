// resolveRetryTarget unit tests: given a failed automation run scoped to one
// profile, resolve the rule + agent-task action to re-run, and reject invalid
// targets (chat runs, missing profile, deleted rule, non-agent actions).
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-retry-test");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { resolveRetryTarget, listJobRetryCandidates } from "../../src/main/services/automation-retry.js";
import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { getConfig, saveConfig, reloadConfig } from "../../src/main/services/config-manager.js";

function addRule(id: string, action: any): void {
  const cfg = getConfig() as any;
  cfg.automation = cfg.automation || [];
  cfg.automation.push({ id, name: "Rule " + id, enabled: true, trigger: { type: "once", at: Date.now() + 60000 }, action, createdAt: Date.now() });
  saveConfig(cfg);
}

describe("resolveRetryTarget", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });
  afterEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });

  it("resolves a failed automation run to its rule + agent-task action + profile", () => {
    addRule("rule_abc", { type: "agent-task", agentPrompt: "check the store", profileDirIds: ["profile_a", "profile_b"] });
    const run = agentRunRecorder.startRun({
      source: { type: "automation", ruleId: "rule_abc", ruleName: "Rule rule_abc", jobId: "job_1" },
      name: "Rule rule_abc",
      dirId: "profile_a",
    });
    agentRunRecorder.finishRun(run.id, "error", "boom");
    const r = resolveRetryTarget(run.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.dirId).toBe("profile_a");
    expect(r.target.rule.id).toBe("rule_abc");
    expect(r.target.action.type).toBe("agent-task");
    expect(r.target.action.agentPrompt).toBe("check the store");
    expect(r.target.sourceRun.id).toBe(run.id);
  });

  it("rejects unknown runs", () => {
    const r = resolveRetryTarget("run_missing");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("not found");
  });

  it("rejects chat runs", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "chat", dirId: "profile_a" });
    const r = resolveRetryTarget(run.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/automation/);
  });

  it("rejects runs without a profile", () => {
    addRule("rule_abc", { type: "agent-task", agentPrompt: "x" });
    const run = agentRunRecorder.startRun({ source: { type: "automation", ruleId: "rule_abc" }, name: "R" });
    const r = resolveRetryTarget(run.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("profile");
  });

  it("rejects runs whose rule was deleted", () => {
    addRule("rule_abc", { type: "agent-task", agentPrompt: "x" });
    const run = agentRunRecorder.startRun({
      source: { type: "automation", ruleId: "rule_abc", ruleName: "R" },
      name: "R",
      dirId: "profile_a",
    });
    const cfg = getConfig() as any;
    cfg.automation = [];
    saveConfig(cfg);
    const r = resolveRetryTarget(run.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/rule/);
  });

  it("rejects runs whose rule action is not an agent task", () => {
    addRule("rule_abc", { type: "launch-profile", profileDirId: "profile_a" });
    const run = agentRunRecorder.startRun({
      source: { type: "automation", ruleId: "rule_abc", ruleName: "R" },
      name: "R",
      dirId: "profile_a",
    });
    const r = resolveRetryTarget(run.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/agent task/);
  });

  it("lists only failed automation runs of a job as batch-retry candidates", () => {
    addRule("rule_abc", { type: "agent-task", agentPrompt: "check the store", profileDirIds: ["a", "b", "c"] });
    const mk = (jobId: string, dirId: string | undefined, status: "done" | "error" | "running") => {
      const run = agentRunRecorder.startRun({
        source: { type: "automation", ruleId: "rule_abc", ruleName: "R", jobId },
        name: "R",
        dirId,
      });
      if (status !== "running") agentRunRecorder.finishRun(run.id, status, status === "error" ? "boom" : undefined);
      return run.id;
    };
    // job_1: two retryable failures + one done + one running + one dir-less failure.
    mk("job_1", "a", "error");
    mk("job_1", "b", "error");
    mk("job_1", "c", "done");
    mk("job_1", "d", "running");
    mk("job_1", undefined, "error");
    // other jobs / non-automation must be excluded.
    mk("job_2", "e", "error");
    const chat = agentRunRecorder.startRun({ source: { type: "chat" }, name: "chat", dirId: "f" });
    agentRunRecorder.finishRun(chat.id, "error", "chat boom");

    const candidates = listJobRetryCandidates("job_1");
    expect(candidates).toHaveLength(2);
    expect(candidates.every((r) => r.status === "error" && r.dirId && r.source?.type === "automation" && r.source.jobId === "job_1")).toBe(true);
    expect(listJobRetryCandidates("job_2")).toHaveLength(1);
    expect(listJobRetryCandidates("")).toHaveLength(0);
  });
});
