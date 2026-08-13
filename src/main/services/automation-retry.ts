// Retry support for agent runs (Slice 28). Given a failed automation run that
// is scoped to a single profile, resolve the target rule + agent-task action so
// the caller can re-run just that profile. Kept in its own module so the
// validation logic stays unit-testable without pulling in the scheduler.
import { getConfig } from "./config-manager.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import type { AutomationRule, AutomationAction, AgentRun } from "../types.js";

export interface RetryTarget {
  rule: AutomationRule;
  action: AutomationAction;
  dirId: string;
  sourceRun: AgentRun;
}

export function resolveRetryTarget(runId: string): { ok: true; target: RetryTarget } | { ok: false; error: string } {
  const cfg = getConfig() as any;
  const run = agentRunRecorder.getRun(runId);
  if (!run) return { ok: false, error: "run not found" };
  if (!run.dirId) return { ok: false, error: "run has no profile" };
  if (run.source?.type !== "automation" || !run.source.ruleId) {
    return { ok: false, error: "only automation agent runs can be retried" };
  }
  const rule = (cfg.automation || []).find((r: AutomationRule) => r.id === run.source.ruleId);
  if (!rule) return { ok: false, error: "automation rule no longer exists" };
  const action = rule.action;
  if (action?.type !== "agent-task" || !action.agentPrompt) {
    return { ok: false, error: "rule action is not an agent task" };
  }
  return { ok: true, target: { rule, action, dirId: run.dirId, sourceRun: run } };
}
