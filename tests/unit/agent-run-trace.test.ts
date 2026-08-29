// RunRecorder unit tests
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-recorder-test");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { getConfig, reloadConfig } from "../../src/main/services/config-manager.js";

describe("RunRecorder", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });
  afterEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });

  it("startRun persists a running run", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "t1" });
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("running");
    expect(getConfig().agentRuns!.length).toBe(1);
  });

  it("recordStep appends a step", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "t2" });
    const step = agentRunRecorder.recordStep(run.id, {
      tool: "http_request", args: { url: "https://x" }, result: { ok: true }, ok: true, durationMs: 5,
    });
    expect(step?.tool).toBe("http_request");
    const back = agentRunRecorder.getRun(run.id)!;
    expect(back.steps.length).toBe(1);
    expect(back.steps[0].ok).toBe(true);
  });

  it("redacts secret keys in args", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "t3" });
    const step = agentRunRecorder.recordStep(run.id, {
      tool: "http_request",
      args: { headers: { Authorization: "Bearer X", token: "t" } },
      ok: true, durationMs: 1,
    })!;
    const headers = (step.args as any).headers;
    expect(headers.Authorization).toBe("[REDACTED]");
    expect(headers.token).toBe("[REDACTED]");
  });

  it("setVar/getVar retrieve raw values but public run views redact variables", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "t4" });
    agentRunRecorder.setVar(run.id, "order_id", "ORD-123");
    const got = agentRunRecorder.getVar(run.id, "order_id");
    expect(got.value).toBe("ORD-123");
    const back = agentRunRecorder.getRun(run.id)!;
    expect(back.variables.order_id).toBe("[REDACTED:7B]");
    expect(agentRunRecorder.listRuns()[0].variables.order_id).toBe("[REDACTED:7B]");
    expect(JSON.stringify(getConfig().agentRuns)).not.toContain("ORD-123");
  });

  it("setVar rejects invalid and prototype-reserved keys", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "t5" });
    expect(agentRunRecorder.setVar(run.id, "1bad", "v").value).toBe("[invalid key]");
    expect(agentRunRecorder.setVar(run.id, "__proto__", "v").value).toBe("[invalid key]");
    expect(agentRunRecorder.getVar(run.id, "__proto__").value).toBeNull();
  });

  it("finishRun sets status + finishedAt", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", ruleName: "r" }, name: "t6" });
    const finished = agentRunRecorder.finishRun(run.id, "done");
    expect(finished?.status).toBe("done");
    expect(finished?.finishedAt).toBeGreaterThan(0);
  });

  it("persists automation jobId in run source", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", ruleId: "rule_1", ruleName: "r", jobId: "job_1" }, name: "t6b" });
    expect(agentRunRecorder.getRun(run.id)?.source.jobId).toBe("job_1");
  });

  it("listRuns is newest first", () => {
    const a = agentRunRecorder.startRun({ source: { type: "chat" }, name: "a" });
    const b = agentRunRecorder.startRun({ source: { type: "chat" }, name: "b" });
    const list = agentRunRecorder.listRuns();
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it("deleteRun + clearRuns mutate config", () => {
    const a = agentRunRecorder.startRun({ source: { type: "chat" }, name: "a" });
    agentRunRecorder.startRun({ source: { type: "chat" }, name: "b" });
    expect(agentRunRecorder.deleteRun(a.id)).toBe(true);
    expect(agentRunRecorder.listRuns().length).toBe(1);
    const n = agentRunRecorder.clearRuns();
    expect(n).toBe(1);
    expect(agentRunRecorder.listRuns().length).toBe(0);
  });

  // 210 synchronous config writes through the save path; under full-suite load
  // this crosses the 5s default timeout on slower runners.
  it("caps runs to 200", { timeout: 20000 }, () => {
    for (let i = 0; i < 210; i++) {
      agentRunRecorder.startRun({ source: { type: "chat" }, name: "r" + i });
    }
    expect(getConfig().agentRuns!.length).toBe(200);
  });

  it("startRun records dirId and listRuns filters by profile", () => {
    const a = agentRunRecorder.startRun({ source: { type: "automation", ruleName: "r" }, name: "a", dirId: "p1" });
    const b = agentRunRecorder.startRun({ source: { type: "automation", ruleName: "r" }, name: "b", dirId: "p2" });
    expect(a.dirId).toBe("p1");
    expect(b.dirId).toBe("p2");
    const p1 = agentRunRecorder.listRuns({ dirId: "p1" });
    expect(p1.length).toBe(1);
    expect(p1[0].id).toBe(a.id);
    expect(p1[0].dirId).toBe("p1");
    expect(agentRunRecorder.listRuns({ dirId: "missing" }).length).toBe(0);
    expect(agentRunRecorder.listRuns().length).toBe(2);
  });
});
