// RunRecorder unit tests
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-recorder-test");

const h = vi.hoisted(() => ({
  /** Fake windows that emit() broadcasts to; empty by default. */
  windows: [] as any[],
  /** When set, the commit point of the config write (rename) fails. */
  renameFault: null as null | { code: string },
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => h.windows },
}));

// Fault injection at the atomic write's commit point only; everything else
// passes through so config-manager behaves normally.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: any, to: any) => {
      if (h.renameFault) {
        const err: any = new Error(`${h.renameFault.code}: failed to rename into ${String(to)}`);
        err.code = h.renameFault.code;
        throw err;
      }
      return (actual.renameSync as any)(from, to);
    },
  };
});

import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { getConfig, getConfigPath, reloadConfig } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import { CONFIG_MAX_BYTES, ConfigTooLargeError } from "../../src/main/services/config/limits.js";

describe("RunRecorder", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });
  afterEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });

  it("startRun persists a running unverified run", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "t1" });
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("running");
    expect(run.endReason).toBeUndefined();
    expect(run.verification).toEqual({ status: "unverified" });
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

  it("finishRun sets status + finishedAt for existing three-argument callers", () => {
    const run = agentRunRecorder.startRun({ source: { type: "automation", ruleName: "r" }, name: "t6" });
    const finished = agentRunRecorder.finishRun(run.id, "done");
    expect(finished?.status).toBe("done");
    expect(finished?.finishedAt).toBeGreaterThan(0);
    expect(finished?.verification).toEqual({ status: "unverified" });
  });

  it("persists finish metadata to disk and returns it after reload", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat", conversationId: "conv_1" }, name: "metadata" });
    const finished = agentRunRecorder.finishRun(run.id, "error", "rounds exhausted", {
      endReason: "round_limit",
      verification: { status: "unverified" },
    });

    expect(finished).toMatchObject({
      id: run.id,
      status: "error",
      endReason: "round_limit",
      verification: { status: "unverified" },
    });
    const onDisk = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    expect(onDisk.agentRuns.find((entry: any) => entry.id === run.id)).toMatchObject({
      endReason: "round_limit",
      verification: { status: "unverified" },
    });

    reloadConfig();
    expect(agentRunRecorder.getRun(run.id)).toMatchObject({
      status: "error",
      endReason: "round_limit",
      verification: { status: "unverified" },
    });
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

describe("RunRecorder write atomicity", () => {
  /** Fake window that records the trace events broadcast to it. */
  function fakeWindow(id: number) {
    const sent: Array<{ channel: string; payload: any }> = [];
    const wc: any = {
      id,
      isDestroyed: () => false,
      send: (channel: string, payload: any) => sent.push({ channel, payload }),
    };
    return { win: { webContents: wc }, wc, sent };
  }

  beforeEach(() => {
    h.renameFault = null;
    h.windows = [];
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
    // Settle device identity before any fault is armed: getConfig() assigns a
    // missing deviceId via its own saveConfig, which would otherwise fire
    // inside a fault window and throw for the wrong reason.
    getConfig();
  });
  afterEach(() => {
    h.renameFault = null;
    h.windows = [];
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });

  it("a failed startRun does not publish the run or a success event", () => {
    const { win, sent } = fakeWindow(1);
    h.windows = [win];

    const diskBefore = fs.readFileSync(getConfigPath());
    const bindingsBefore = (agentRunRecorder as any).runWebContents.size;
    const variablesBefore = (agentRunRecorder as any).runVariables.size;
    h.renameFault = { code: "EIO" };
    const cachedBefore = JSON.stringify(getConfig().agentRuns || []);
    expect(() => agentRunRecorder.startRun({ source: { type: "chat" }, name: "doomed" })).toThrow(/EIO/);

    h.renameFault = null;
    expect(fs.readFileSync(getConfigPath())).toEqual(diskBefore);
    expect((agentRunRecorder as any).runWebContents.size).toBe(bindingsBefore);
    expect((agentRunRecorder as any).runVariables.size).toBe(variablesBefore);
    expect(JSON.stringify(getConfig().agentRuns || [])).toBe(cachedBefore);
    expect(agentRunRecorder.listRuns().length).toBe(0);
    expect(sent.filter((e) => e.channel === "agent:run-start")).toEqual([]);
  });

  it("a failed recordStep leaves the persisted run without the step", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "s1" });
    const { win, sent } = fakeWindow(2);
    h.windows = [win];

    h.renameFault = { code: "EIO" };
    expect(() => agentRunRecorder.recordStep(run.id, {
      tool: "http_request", args: { url: "https://x" }, ok: true, durationMs: 3,
    })).toThrow(/EIO/);

    h.renameFault = null;
    expect(agentRunRecorder.getRun(run.id)!.steps.length).toBe(0);
    expect(getConfig().agentRuns!.find((r) => r.id === run.id)!.steps.length).toBe(0);
    expect(sent.filter((e) => e.channel === "agent:run-step")).toEqual([]);
  });

  it.each([null, "previous-value"])("a failed setVar preserves its prior raw value (%s)", (previous) => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "v1" });
    if (previous !== null) agentRunRecorder.setVar(run.id, "api_token", previous);
    const traceBefore = JSON.stringify(getConfig().agentRuns);
    const diskBefore = fs.readFileSync(getConfigPath());
    const { win, sent } = fakeWindow(5);
    h.windows = [win];
    h.renameFault = { code: "EIO" };

    expect(() => agentRunRecorder.setVar(run.id, "api_token", "SENTINEL-VALUE")).toThrow(/EIO/);

    h.renameFault = null;
    // The in-memory variable map must not have accepted the uncommitted write.
    expect(agentRunRecorder.getVar(run.id, "api_token").value).toBe(previous);
    expect(fs.readFileSync(getConfigPath())).toEqual(diskBefore);
    expect(sent).toEqual([]);
    const persisted = JSON.stringify(getConfig().agentRuns);
    expect(persisted).not.toContain("SENTINEL-VALUE");
    expect(persisted).toBe(traceBefore);
    // The run itself still commits normally afterwards.
    agentRunRecorder.setVar(run.id, "api_token", "SENTINEL-VALUE");
    expect(agentRunRecorder.getVar(run.id, "api_token").value).toBe("SENTINEL-VALUE");
  });

  it("a failed finishRun leaves bytes, cache, live maps and events unchanged", () => {
    const { win, wc, sent } = fakeWindow(3);
    h.windows = [win];
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "f1", webContents: wc });
    agentRunRecorder.setVar(run.id, "kept", "raw-value");
    sent.length = 0;

    const diskBefore = fs.readFileSync(getConfigPath());
    const cacheBefore = structuredClone(getConfig().agentRuns);
    const webContentsBefore = (agentRunRecorder as any).runWebContents.get(run.id);
    const variablesBefore = structuredClone((agentRunRecorder as any).runVariables.get(run.id));

    h.renameFault = { code: "EIO" };
    expect(() => agentRunRecorder.finishRun(run.id, "error", "cancelled", {
      endReason: "user_cancelled",
      verification: { status: "unverified" },
    })).toThrow(/EIO/);

    h.renameFault = null;
    expect(fs.readFileSync(getConfigPath())).toEqual(diskBefore);
    expect(getConfig().agentRuns).toEqual(cacheBefore);
    expect((agentRunRecorder as any).runWebContents.get(run.id)).toBe(webContentsBefore);
    expect((agentRunRecorder as any).runVariables.get(run.id)).toEqual(variablesBefore);
    expect(agentRunRecorder.isActive(run.id)).toBe(true);
    expect(agentRunRecorder.getRun(run.id)).toMatchObject({
      status: "running",
      verification: { status: "unverified" },
    });
    expect(agentRunRecorder.getRun(run.id)!.endReason).toBeUndefined();
    expect(sent).toEqual([]);

    const finished = agentRunRecorder.finishRun(run.id, "error", "cancelled", {
      endReason: "user_cancelled",
      verification: { status: "unverified" },
    });
    expect(finished).toMatchObject({ status: "error", endReason: "user_cancelled" });
    expect(agentRunRecorder.isActive(run.id)).toBe(false);
  });

  it("releaseRun drops only runtime bindings after a failed finish", () => {
    const { win, wc, sent } = fakeWindow(10);
    h.windows = [win];
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "release-only", webContents: wc });
    agentRunRecorder.setVar(run.id, "kept", "raw-value");
    sent.length = 0;

    const diskBefore = fs.readFileSync(getConfigPath());
    const cacheBefore = structuredClone(getConfig().agentRuns);
    h.renameFault = { code: "EIO" };
    expect(() => agentRunRecorder.finishRun(run.id, "error", "persistence failed", {
      endReason: "execution_error",
      verification: { status: "unverified" },
    })).toThrow(/EIO/);
    h.renameFault = null;

    expect(agentRunRecorder.isActive(run.id)).toBe(true);
    expect(agentRunRecorder.getVar(run.id, "kept").value).toBe("raw-value");
    agentRunRecorder.releaseRun(run.id);

    expect(agentRunRecorder.isActive(run.id)).toBe(false);
    expect(agentRunRecorder.getVar(run.id, "kept").value).toBeNull();
    expect(fs.readFileSync(getConfigPath())).toEqual(diskBefore);
    expect(getConfig().agentRuns).toEqual(cacheBefore);
    expect(agentRunRecorder.getRun(run.id)).toMatchObject({ status: "running" });
    expect(agentRunRecorder.getRun(run.id)!.finishedAt).toBeUndefined();
    expect(agentRunRecorder.getRun(run.id)!.endReason).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("a failed deleteRun / clearRuns keeps history and the webContents mapping", () => {
    const { wc } = fakeWindow(4);
    const a = agentRunRecorder.startRun({ source: { type: "chat" }, name: "d1", webContents: wc });

    h.renameFault = { code: "EIO" };
    expect(() => agentRunRecorder.deleteRun(a.id)).toThrow(/EIO/);
    h.renameFault = null;
    expect(agentRunRecorder.getRun(a.id)).not.toBeNull();
    expect((agentRunRecorder as any).runWebContents.get(a.id)).toBe(wc);

    h.renameFault = { code: "EIO" };
    expect(() => agentRunRecorder.clearRuns()).toThrow(/EIO/);
    h.renameFault = null;
    expect(agentRunRecorder.listRuns().length).toBe(1);
    expect((agentRunRecorder as any).runWebContents.get(a.id)).toBe(wc);

    // A later legal clear still works and releases the mapping.
    expect(agentRunRecorder.clearRuns()).toBe(1);
    expect(agentRunRecorder.listRuns().length).toBe(0);
    expect((agentRunRecorder as any).runWebContents.has(a.id)).toBe(false);
  });

  it("rejects a trace over the real byte budget without changing disk, maps or events", { timeout: 20_000 }, () => {
    const { win, wc, sent } = fakeWindow(8);
    h.windows = [win];
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "budget", webContents: wc });
    agentRunRecorder.setVar(run.id, "existing", "keep-me");
    // Leave less than one MiB free, using a field the normalizer preserves.
    transact((draft: any) => {
      draft.proxies.budget = { type: "http", host: "10.0.0.1", port: 8080, username: "x".repeat(CONFIG_MAX_BYTES - 512 * 1024) };
    });
    const diskBefore = fs.readFileSync(getConfigPath());
    expect(diskBefore.length).toBeLessThan(CONFIG_MAX_BYTES);
    const traceBefore = JSON.stringify(getConfig().agentRuns);
    const filesBefore = fs.readdirSync(TEST_USER_DATA).sort();
    sent.length = 0;

    expect(() => agentRunRecorder.recordStep(run.id, {
      tool: "budget-probe", args: {}, result: Array(100).fill("r".repeat(16 * 1024)), ok: true, durationMs: 1,
    })).toThrow(ConfigTooLargeError);
    expect(fs.readFileSync(getConfigPath()).equals(diskBefore)).toBe(true);
    expect(fs.readdirSync(TEST_USER_DATA).sort()).toEqual(filesBefore);
    expect(JSON.stringify(getConfig().agentRuns)).toBe(traceBefore);
    expect(agentRunRecorder.getVar(run.id, "existing").value).toBe("keep-me");
    expect((agentRunRecorder as any).runWebContents.get(run.id)).toBe(wc);
    expect(sent).toEqual([]);

    // Explicitly remove only the test's size carrier; normal writes still work.
    transact((draft: any) => { delete draft.proxies.budget; });
    const step = agentRunRecorder.recordStep(run.id, {
      tool: "after-reject", args: {}, result: "persisted", ok: true, durationMs: 1,
    })!;
    agentRunRecorder.finishRun(run.id, "done");
    const onDisk = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    expect(onDisk.agentRuns.find((r: any) => r.id === run.id).steps).toEqual([step]);
    reloadConfig();
    expect(agentRunRecorder.getRun(run.id)?.steps).toEqual([step]);
  });

  it("reports a step the normalizer dropped as null, not as an unsaved success", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "empty-tool" });
    const { win, sent } = fakeWindow(9);
    h.windows = [win];

    // normalizeAgentRunStep discards a step with an empty tool: the recorder
    // must not return it or emit a success event for it.
    const step = agentRunRecorder.recordStep(run.id, {
      tool: "", args: { url: "https://x" }, ok: true, durationMs: 1,
    });

    expect(step).toBeNull();
    expect(sent.filter((e) => e.channel === "agent:run-step")).toEqual([]);
    expect(agentRunRecorder.getRun(run.id)!.steps).toEqual([]);
    expect(getConfig().agentRuns!.find((r) => r.id === run.id)!.steps).toEqual([]);
  });

  it("ignores an unknown runId before touching the payload", () => {
    // A payload that cannot be serialized: if the recorder serialized it before
    // checking the run, an unknown runId would throw instead of being a no-op.
    const circular: any = { url: "https://x" };
    circular.self = circular;

    expect(agentRunRecorder.recordStep("run_missing", {
      tool: "http_request", args: circular, ok: true, durationMs: 1,
    })).toBeNull();
    expect(agentRunRecorder.setVar("run_missing", "k", circular).value).toBe("[no active run]");
    expect(agentRunRecorder.finishRun("run_missing", "done")).toBeNull();
    expect(agentRunRecorder.listRuns()).toEqual([]);
  });

  it("committed writes are reflected in the returned value and on disk", () => {
    const run = agentRunRecorder.startRun({ source: { type: "chat" }, name: "c1" });
    const step = agentRunRecorder.recordStep(run.id, {
      tool: "http_request", args: { url: "https://ok" }, ok: true, durationMs: 1,
    })!;
    expect(step.tool).toBe("http_request");

    reloadConfig();
    const back = getConfig().agentRuns!.find((r) => r.id === run.id)!;
    expect(back.steps.length).toBe(1);
    expect(back.steps[0].tool).toBe("http_request");
    expect(fs.existsSync(getConfigPath())).toBe(true);
  });
});
