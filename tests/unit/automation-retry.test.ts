// resolveRetryTarget unit tests: given a failed automation run scoped to one
// profile, resolve the rule + agent-task action to re-run, and reject invalid
// targets (chat runs, missing profile, deleted rule, non-agent actions).
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

// vi.hoisted runs before service imports and the Electron factory. Neither
// provider may reconstruct a shared tmp path or delete a root it did not acquire.
const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-retry-test-")));
  const identity = fs.lstatSync(root);
  const marker = path.join(root, ".fixture-owner");
  const owner = JSON.stringify({ role: "automation-retry", root, dev: identity.dev, ino: identity.ino });
  fs.writeFileSync(marker, owner, { flag: "wx", mode: 0o600 });
  const markerIdentity = fs.lstatSync(marker);
  function assertTree(p: string): void {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) {
      throw new Error("Refusing non-physical fixture cleanup: " + p);
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) assertTree(path.join(p, name));
  }
  function children(): string[] {
    const st = fs.lstatSync(root);
    const mark = fs.lstatSync(marker);
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino ||
        fs.realpathSync(root) !== root || !mark.isFile() || mark.isSymbolicLink() || mark.nlink !== 1 ||
        mark.dev !== markerIdentity.dev || mark.ino !== markerIdentity.ino || fs.readFileSync(marker, "utf8") !== owner) {
      throw new Error("Refusing unowned fixture cleanup: " + root);
    }
    const names = fs.readdirSync(root).filter((name) => name !== ".fixture-owner");
    for (const name of names) {
      if (name !== "config.json" && name !== "runs") throw new Error("Unexpected fixture role: " + name);
      assertTree(path.join(root, name));
    }
    return names;
  }
  function clear(): void {
    for (const name of children()) fs.rmSync(path.join(root, name), { recursive: true });
  }
  return { root, clear, dispose: () => { clear(); fs.unlinkSync(marker); fs.rmdirSync(root); } };
});

afterAll(() => fixture.dispose());

vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => fixture.root,
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
    fixture.clear();
    reloadConfig();
  });
  afterEach(() => {
    // Release process-local live-run bindings before removing their owned data.
    for (const run of getConfig().agentRuns || []) agentRunRecorder.releaseRun(run.id);
    reloadConfig();
    fixture.clear();
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
    agentRunRecorder.finishRun(run.id, "error", "boom");
    const r = resolveRetryTarget(run.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/automation/);
  });

  it("rejects a run that is still active (M2: terminal-only retry)", () => {
    addRule("rule_abc", { type: "agent-task", agentPrompt: "x", profileDirId: "profile_a" });
    const run = agentRunRecorder.startRun({
      source: { type: "automation", ruleId: "rule_abc", ruleName: "R" },
      name: "R",
      dirId: "profile_a",
    });
    const r = resolveRetryTarget(run.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/still active/);
  });

  it("resolves a COMPLETED automation run (M2: retry is not error-only)", () => {
    addRule("rule_abc", { type: "agent-task", agentPrompt: "check", profileDirId: "profile_a" });
    const run = agentRunRecorder.startRun({
      source: { type: "automation", ruleId: "rule_abc", ruleName: "R" },
      name: "R",
      dirId: "profile_a",
    });
    agentRunRecorder.finishRun(run.id, "done");
    const r = resolveRetryTarget(run.id);
    expect(r.ok).toBe(true);
  });

  it("rejects runs without a profile", () => {
    addRule("rule_abc", { type: "agent-task", agentPrompt: "x" });
    const run = agentRunRecorder.startRun({ source: { type: "automation", ruleId: "rule_abc" }, name: "R" });
    // Terminal-only retry: the run must be finished or it is rejected as live
    // before the profile check is ever reached.
    agentRunRecorder.finishRun(run.id, "error", "boom");
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
    agentRunRecorder.finishRun(run.id, "error", "boom");
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
    agentRunRecorder.finishRun(run.id, "error", "boom");
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
