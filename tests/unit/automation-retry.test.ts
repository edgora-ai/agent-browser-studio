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

import { resolveRetryTarget } from "../../src/main/services/automation-retry.js";
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
});
