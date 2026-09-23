// M1 cancellation performance: the renderer must acknowledge Stop visually on
// the next frame while the main process is synchronously committing a real
// trace step. The fixture is wholly local and never opens a browser profile.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { startMockLlm, type MockLlmServer } from "./helpers/mock-llm.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-m1-cancel-latency-"));
const CONFIG_FILE = path.join(USERDATA, "config.json");
const STORE_MODULE_URL = pathToFileURL(path.join(REPO, "dist", "main", "services", "config", "store.js")).href;
const CONFIG_MANAGER_MODULE_URL = pathToFileURL(path.join(REPO, "dist", "main", "services", "config-manager.js")).href;
const SAMPLE_COUNT = 20;
const MIB = 1024 * 1024;
const CONFIG_MAX_BYTES = 64 * MIB;
const LARGE_CONFIG_TARGET_BYTES = 50 * MIB;
const FILLER_RUN_COUNT = 150;
const FILLER_STEPS_PER_RUN = 100;
const TRACE_RESULT_LIMIT = 16 * 1024;
const UI_P95_LIMIT_MS = 200;
const MAIN_ACK_P95_LIMIT_MS = 1_000;

interface RendererSample {
  id: number;
  label: string;
  conversationId: string;
  triggered: boolean;
  toolEventAt?: number;
  toolEvents: Array<{ id: string; name: string; at: number }>;
  runStepAt?: number;
  runStepEvents: Array<{ id: string; tool: string; sql?: string; ok: boolean; error?: string; at: number }>;
  stopInvokedAt?: number;
  stopReturnedAt?: number;
  primaryAckAt?: number;
  primaryAckResult?: any;
  primaryAckError?: string;
  wrapperKey?: string;
  wrapperStartedAt?: number;
  wrapperAckAt?: number;
  wrapperResult?: any;
  wrapperError?: string;
  immediateFeedbackAt?: number;
  immediateLabel?: string;
  immediateVisible?: boolean;
  immediateDisabled?: boolean;
  frameFeedbackAt?: number;
  frameLabel?: string;
  frameVisible?: boolean;
  frameDisabled?: boolean;
  frameRunState?: string;
  frameRunStripVisible?: boolean;
  terminalEvent?: any;
  terminalEventAt?: number;
  chatSettledAt?: number;
  chatResult?: any;
  chatError?: string;
  instrumentationErrors: string[];
  requestDelta?: number;
}

interface MeasuredSample extends RendererSample {
  uiLatencyMs: number;
  mainAckLatencyMs: number;
  traceCommitEventMs: number;
}

function config(): any {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function p95(values: number[]): number {
  if (!values.length) throw new Error("cannot compute P95 of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function rounded(values: number[]): number[] {
  return values.map((value) => Number(value.toFixed(2)));
}

function printReport(label: string, configBytes: { before: number; after: number }, samples: MeasuredSample[]): void {
  const ui = samples.map((sample) => sample.uiLatencyMs);
  const main = samples.map((sample) => sample.mainAckLatencyMs);
  const trace = samples.map((sample) => sample.traceCommitEventMs);
  const timelines = samples.map((sample) => {
    const origin = sample.toolEventAt ?? 0;
    return {
      sample: sample.label,
      stopMs: Number(((sample.stopInvokedAt ?? Number.NaN) - origin).toFixed(2)),
      tools: sample.toolEvents.map((event) => ({ id: event.id, ms: Number((event.at - origin).toFixed(2)) })),
      steps: sample.runStepEvents.map((event) => ({ sql: event.sql, ok: event.ok, ms: Number((event.at - origin).toFixed(2)) })),
      ackMs: Number(((sample.primaryAckAt ?? Number.NaN) - origin).toFixed(2)),
      llmRequests: sample.requestDelta,
    };
  });
  console.log(
    `[m1-cancel-latency] ${label} configBytes=${configBytes.before}->${configBytes.after}\n`
      + `  UI next-frame raw(ms)=${JSON.stringify(rounded(ui))} p95=${p95(ui).toFixed(2)}\n`
      + `  main cancel-ack raw(ms)=${JSON.stringify(rounded(main))} p95=${p95(main).toFixed(2)}\n`
      + `  committed run-step event raw(ms)=${JSON.stringify(rounded(trace))} p95=${p95(trace).toFixed(2)}\n`
      + `  event timelines=${JSON.stringify(timelines)}`,
  );
}

async function createConversation(page: Page, title: string): Promise<string> {
  return page.evaluate(async (name) => {
    const app = (window as any).agentBrowser;
    const conversation = await app.api.agent.conversations.create(name);
    await app.agentSelectConv(conversation.id);
    await app.agentLoadConversations();
    return conversation.id;
  }, title);
}

async function waitForRunIdle(page: Page, conversationId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const session = (window as any).agentBrowser.agentChatController?.getSession(id);
      return !!session && session.run === null;
    },
    conversationId,
    { timeout: 120_000 },
  );
}

async function installRendererProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    const app = w.agentBrowser;
    if (!app?.agentChatController || typeof app.agentStopRun !== "function") {
      throw new Error("agent chat controller is not ready");
    }
    if (w.__m1CancelLatency) return;

    const probe: any = {
      sequence: 0,
      current: null,
      samples: Object.create(null),
    };
    w.__m1CancelLatency = probe;

    const feedback = () => {
      const button = document.getElementById("agent-chat-stop") as HTMLButtonElement | null;
      const label = document.getElementById("agent-chat-stop-label");
      const runState = document.getElementById("agent-run-state");
      const strip = document.getElementById("agent-run-strip");
      const stripStyle = strip ? getComputedStyle(strip) : null;
      const stripRect = strip?.getBoundingClientRect();
      const stripVisible = !!strip && stripStyle?.display !== "none" && stripStyle?.visibility !== "hidden"
        && !!stripRect && stripRect.width > 0 && stripRect.height > 0;
      if (!button) return { label: "", visible: false, disabled: false, runState: "", stripVisible };
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        label: String(label?.textContent || "").trim(),
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
        disabled: button.disabled,
        runState: String(runState?.textContent || "").trim(),
        stripVisible,
      };
    };

    // This is the promise returned by the real Stop controller. Measuring it
    // includes the primary cancel IPC and any renderer ipc.call wrapper that the
    // product path uses now or adopts later.
    const originalStop = app.agentStopRun;
    app.agentStopRun = function(...args: any[]) {
      const sample = probe.current;
      if (sample?.triggered && sample.stopInvokedAt === undefined) {
        sample.stopInvokedAt = performance.now();
      }
      let result: any;
      try {
        result = originalStop.apply(this, args);
      } catch (error) {
        if (sample) {
          sample.stopReturnedAt = performance.now();
          sample.primaryAckAt = sample.stopReturnedAt;
          sample.primaryAckError = String((error as any)?.message || error);
        }
        throw error;
      }
      if (sample) {
        sample.stopReturnedAt = performance.now();
        Promise.resolve(result).then((value) => {
          if (sample.primaryAckAt === undefined) {
            sample.primaryAckAt = performance.now();
            sample.primaryAckResult = value;
          }
        }, (error) => {
          if (sample.primaryAckAt === undefined) {
            sample.primaryAckAt = performance.now();
            sample.primaryAckError = String(error?.message || error);
          }
        });
      }
      return result;
    };

    // Keep evidence from the outer reliability wrapper as well. The current
    // controller invokes cancelRun directly, so wrapperKey may legitimately be
    // absent; the agentStopRun promise above remains the primary measurement.
    if (app.ipc && typeof app.ipc.call === "function") {
      const originalCall = app.ipc.call;
      app.ipc.call = function(key: string, fn: () => Promise<any>, options: any) {
        const sample = probe.current;
        const isCancel = !!sample && /(?:agent.*(?:cancel|stop)|(?:cancel|stop).*agent)/i.test(String(key));
        if (isCancel && sample.wrapperStartedAt === undefined) {
          sample.wrapperKey = String(key);
          sample.wrapperStartedAt = performance.now();
        }
        let result: any;
        try {
          result = originalCall.call(this, key, fn, options);
        } catch (error) {
          if (isCancel && sample.wrapperAckAt === undefined) {
            sample.wrapperAckAt = performance.now();
            sample.wrapperError = String((error as any)?.message || error);
          }
          throw error;
        }
        if (isCancel) {
          Promise.resolve(result).then((value) => {
            if (sample.wrapperAckAt === undefined) {
              sample.wrapperAckAt = performance.now();
              sample.wrapperResult = value;
            }
          }, (error) => {
            if (sample.wrapperAckAt === undefined) {
              sample.wrapperAckAt = performance.now();
              sample.wrapperError = String(error?.message || error);
            }
          });
        }
        return result;
      };
    }

    app.api.on("agent:stream-tool-call", (payload: any) => {
      const sample = probe.current;
      if (!sample || payload?.conversationId !== sample.conversationId) return;
      const eventAt = performance.now();
      sample.toolEvents.push({
        id: String(payload.id || ""),
        name: String(payload.name || ""),
        at: eventAt,
      });
      if (sample.triggered) return;

      // There is deliberately no timer here: Stop is clicked in the same event
      // turn in which the renderer receives the first real tool-call lifecycle
      // event. A second already-issued call is allowed until main confirms abort.
      sample.triggered = true;
      sample.toolEventAt = eventAt;
      sample.runId = payload.runId;
      sample.streamId = payload.streamId;
      const button = document.getElementById("agent-chat-stop") as HTMLButtonElement | null;
      if (!button) {
        sample.instrumentationErrors.push("Stop button not found");
        return;
      }
      const before = feedback();
      if (!before.visible) sample.instrumentationErrors.push("Stop button was not visible at tool dispatch");
      if (before.disabled) sample.instrumentationErrors.push("Stop button was disabled before the click");
      button.click();

      const immediate = feedback();
      sample.immediateFeedbackAt = performance.now();
      sample.immediateLabel = immediate.label;
      sample.immediateVisible = immediate.visible;
      sample.immediateDisabled = immediate.disabled;
      requestAnimationFrame(() => {
        const frame = feedback();
        sample.frameFeedbackAt = performance.now();
        sample.frameLabel = frame.label;
        sample.frameVisible = frame.visible;
        sample.frameDisabled = frame.disabled;
        sample.frameRunState = frame.runState;
        sample.frameRunStripVisible = frame.stripVisible;
      });
    });

    app.api.on("agent:run-step", (payload: any) => {
      const sample = probe.current;
      if (!sample || !sample.runId || payload?.runId !== sample.runId || !payload.step) return;
      const eventAt = performance.now();
      sample.runStepEvents.push({
        id: String(payload.step.id || ""),
        tool: String(payload.step.tool || ""),
        sql: typeof payload.step.args?.sql === "string" ? payload.step.args.sql : undefined,
        ok: payload.step.ok === true,
        error: typeof payload.step.error === "string" ? payload.step.error : undefined,
        at: eventAt,
      });
      if (sample.runStepAt === undefined) sample.runStepAt = eventAt;
    });

    const terminal = (payload: any) => {
      const sample = probe.current;
      if (!sample || payload?.conversationId !== sample.conversationId) return;
      if (sample.streamId && payload?.streamId !== sample.streamId) return;
      sample.terminalEventAt = performance.now();
      sample.terminalEvent = {
        conversationId: payload.conversationId,
        streamId: payload.streamId,
        runId: payload.runId,
        status: payload.status,
        endReason: payload.endReason,
        persisted: payload.persisted,
        code: payload.code,
        toolCalls: payload.toolCalls,
      };
    };
    app.api.on("agent:stream-done", terminal);
    app.api.on("agent:stream-error", terminal);
  });
}

describe.sequential("M1 — Stop latency under synchronous trace persistence", () => {
  let h: TestAppHandle;
  let mock: MockLlmServer;
  let smallRunIds: string[] = [];

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 1 });
    h = await setupTestApp({
      userDataDir: USERDATA,
      env: { AGENT_BROWSER_API_PORT: "0" },
    });
    const saved = await h.page.evaluate((url) => (window as any).agentBrowser.api.agent.saveLlmConfig({
      provider: "openai",
      apiKey: "m1-local-cancel-latency-key",
      model: "e2e-mock-model",
      apiUrl: url,
    }), mock.url);
    expect(saved).toMatchObject({ success: true });
    await h.page.evaluate(() => {
      (window as any).i18n.set("en-US");
      const app = (window as any).agentBrowser;
      app.switchTab("agent");
      app.switchAgentSub("chat");
    });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser?.agentChatController, undefined, { timeout: 20_000 });
    await installRendererProbe(h.page);
  }, 90_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (mock) await mock.close().catch(() => undefined);
    fs.rmSync(USERDATA, { recursive: true, force: true });
  }, 90_000);

  async function runSamples(label: string, conversationId: string): Promise<MeasuredSample[]> {
    const measured: MeasuredSample[] = [];
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      await waitForRunIdle(h.page, conversationId);
      // Both calls are queued in one model response. Main may honestly dispatch
      // either one or both before it handles the cancel IPC; the invariant begins
      // when that IPC is acknowledged. If a fast config reaches the next model
      // round first, hold that response until cancellation aborts the request.
      mock.setResponses([
        { chunks: [], delayMs: 1, toolCalls: [
          { id: "latency-query-1", name: "db_query", arguments: { sql: "SELECT 1" } },
          { id: "query-2-before-ack-only", name: "db_query", arguments: { sql: "SELECT 2" } },
        ] },
        { pause: true, chunks: ["Unexpected follow-up after cancellation."] },
      ]);
      const requestCountBefore = mock.requests.length;
      const sampleId = await h.page.evaluate(({ phase, conversation, ordinal }) => {
        const probe = (window as any).__m1CancelLatency;
        if (probe.current) throw new Error("previous latency sample was not disarmed");
        const id = ++probe.sequence;
        const sample = {
          id,
          label: `${phase}-${ordinal}`,
          conversationId: conversation,
          triggered: false,
          toolEvents: [],
          runStepEvents: [],
          instrumentationErrors: [],
        };
        probe.samples[id] = sample;
        probe.current = sample;
        return id;
      }, { phase: label, conversation: conversationId, ordinal: index + 1 });

      await h.page.evaluate(({ id, message }) => {
        const w = window as any;
        const probe = w.__m1CancelLatency;
        const sample = probe.samples[id];
        const task = w.agentBrowser._doAgentSend(message);
        Promise.resolve(task).then((result) => {
          sample.chatSettledAt = performance.now();
          sample.chatResult = result;
        }, (error) => {
          sample.chatSettledAt = performance.now();
          sample.chatError = String(error?.message || error);
        });
      }, { id: sampleId, message: `Cancellation latency sample ${label} ${index + 1}` });

      await h.page.waitForFunction((id) => {
        const sample = (window as any).__m1CancelLatency?.samples[id];
        return !!sample
          && sample.triggered
          && sample.frameFeedbackAt !== undefined
          && sample.primaryAckAt !== undefined
          && sample.runStepEvents.length > 0
          && sample.terminalEventAt !== undefined
          && sample.chatSettledAt !== undefined;
      }, sampleId, { timeout: 120_000 });
      await waitForRunIdle(h.page, conversationId);

      const sample = await h.page.evaluate((id) => {
        const probe = (window as any).__m1CancelLatency;
        const value = probe.samples[id];
        probe.current = null;
        return value;
      }, sampleId) as RendererSample;
      sample.requestDelta = mock.requests.length - requestCountBefore;

      const toolEventAt = sample.toolEventAt ?? Number.NaN;
      const stopInvokedAt = sample.stopInvokedAt ?? Number.NaN;
      measured.push({
        ...sample,
        uiLatencyMs: (sample.frameFeedbackAt ?? Number.NaN) - toolEventAt,
        mainAckLatencyMs: (sample.primaryAckAt ?? Number.NaN) - stopInvokedAt,
        traceCommitEventMs: (sample.runStepAt ?? Number.NaN) - toolEventAt,
      });
    }
    return measured;
  }

  function assertSamples(samples: MeasuredSample[], persisted: any): void {
    const queued = [
      { id: "latency-query-1", sql: "SELECT 1" },
      { id: "query-2-before-ack-only", sql: "SELECT 2" },
    ];
    expect(samples).toHaveLength(SAMPLE_COUNT);
    for (const sample of samples) {
      expect(sample.instrumentationErrors, sample.label).toEqual([]);
      expect(sample.chatError, sample.label).toBeUndefined();
      expect(sample.primaryAckError, sample.label).toBeUndefined();
      expect(sample.primaryAckResult, sample.label).toMatchObject({ accepted: true, state: "cancelling" });
      const ackAt = sample.primaryAckAt ?? Number.NaN;
      const beforeAck = sample.toolEvents.filter((event) => event.at <= ackAt);
      const afterAck = sample.toolEvents.filter((event) => event.at > ackAt);
      expect(afterAck, `${sample.label}: no tool may dispatch after main acknowledges cancellation`).toEqual([]);
      expect(beforeAck.length, sample.label).toBeGreaterThanOrEqual(1);
      expect(beforeAck.length, sample.label).toBeLessThanOrEqual(2);
      expect(beforeAck.map((event) => event.id), sample.label).toEqual(queued.slice(0, beforeAck.length).map((entry) => entry.id));
      expect(beforeAck.every((event) => event.name === "db_query"), sample.label).toBe(true);
      expect(sample.runStepEvents, `${sample.label}: every announced pre-ack query must be recorded`).toHaveLength(beforeAck.length);
      expect(sample.requestDelta, `${sample.label}: held fallback permits at most one extra LLM request`).toBeGreaterThanOrEqual(1);
      expect(sample.requestDelta, `${sample.label}: held fallback permits at most one extra LLM request`).toBeLessThanOrEqual(2);

      expect(sample.immediateLabel, sample.label).toContain("Stopping");
      expect(sample.immediateVisible, sample.label).toBe(true);
      expect(sample.immediateDisabled, sample.label).toBe(true);
      // A very fast small-config cancellation can reach its truthful terminal
      // state before the next frame. That is stronger feedback, not a failure to
      // render Stopping; either state must be visibly painted by that frame.
      const stoppingAtFrame = sample.frameVisible === true
        && sample.frameDisabled === true
        && String(sample.frameLabel || "").includes("Stopping");
      const terminalAtFrame = sample.frameRunStripVisible === true
        && String(sample.frameRunState || "").includes("Stopped by user");
      expect(stoppingAtFrame || terminalAtFrame, sample.label).toBe(true);
      if (sample.wrapperKey) {
        expect(sample.wrapperError, sample.label).toBeUndefined();
        expect(sample.wrapperAckAt, sample.label).toBeTypeOf("number");
        expect(sample.wrapperResult, sample.label).toMatchObject({ accepted: true, state: "cancelling" });
      }
      expect(sample.terminalEvent, sample.label).toMatchObject({
        runId: sample.chatResult?.runId,
        status: "error",
        endReason: "user_cancelled",
        persisted: true,
      });
      expect(sample.terminalEvent?.toolCalls, sample.label).toHaveLength(beforeAck.length);
      expect(sample.chatResult, sample.label).toMatchObject({
        status: "error",
        endReason: "user_cancelled",
        persisted: true,
      });
      expect(Number.isFinite(sample.uiLatencyMs), sample.label).toBe(true);
      expect(Number.isFinite(sample.mainAckLatencyMs), sample.label).toBe(true);
      expect(Number.isFinite(sample.traceCommitEventMs), sample.label).toBe(true);
      expect(sample.uiLatencyMs, sample.label).toBeGreaterThanOrEqual(0);
      expect(sample.mainAckLatencyMs, sample.label).toBeGreaterThanOrEqual(0);
      expect(sample.traceCommitEventMs, sample.label).toBeGreaterThanOrEqual(0);

      // The first tool event synchronously initiates Stop. At least one real
      // recordStep commit must then be observed while that cancellation remains
      // unacknowledged; the printed timeline retains all event timings.
      const firstStepEvent = sample.runStepEvents[0];
      expect(sample.stopInvokedAt, sample.label).toBeGreaterThanOrEqual(sample.toolEventAt!);
      expect(firstStepEvent.at, sample.label).toBeGreaterThanOrEqual(sample.stopInvokedAt!);
      expect(firstStepEvent.at, sample.label).toBeLessThanOrEqual(ackAt);
      // An already-dispatched query can finish and commit after the cancel ack.
      // It must still be truthfully recorded before the terminal event; only new
      // dispatch (checked above), not in-flight completion, is barred by the ack.
      const terminalAt = sample.terminalEventAt ?? Number.NaN;
      expect(Number.isFinite(terminalAt), sample.label).toBe(true);
      expect(sample.runStepEvents.every((event) => event.at <= terminalAt), `${sample.label}: all results precede the terminal event`).toBe(true);

      const run = persisted.agentRuns.find((entry: any) => entry.id === sample.chatResult?.runId);
      expect(run, `${sample.label}: run must be present in config.json`).toMatchObject({
        status: "error",
        endReason: "user_cancelled",
        verification: { status: "unverified" },
      });
      const expectedQueries = beforeAck.map((event) => queued.find((entry) => entry.id === event.id)!.sql);
      expect(run.steps, `${sample.label}: persisted steps must exactly match announced pre-ack queries`).toHaveLength(expectedQueries.length);
      expect(run.steps.map((step: any) => step.args?.sql), sample.label).toEqual(expectedQueries);
      expect(sample.runStepEvents.map((event) => event.sql), sample.label).toEqual(expectedQueries);
      for (let index = 0; index < expectedQueries.length; index++) {
        const diskStep = run.steps[index];
        const liveStep = sample.runStepEvents[index];
        expect(diskStep, sample.label).toMatchObject({ tool: "db_query", args: { sql: expectedQueries[index] } });
        expect(diskStep.ok, `${sample.label}: preserve success/failure truth for step ${index + 1}`).toBe(liveStep.ok);
        if (liveStep.error !== undefined) expect(diskStep.error, sample.label).toBe(liveStep.error);
      }
    }
  }

  it("keeps UI and main cancellation P95 within budget for a representative config", async () => {
    const conversationId = await createConversation(h.page, "M1 cancellation latency — representative config");
    const beforeBytes = fs.statSync(CONFIG_FILE).size;
    expect(beforeBytes).toBeGreaterThan(0);
    expect(beforeBytes).toBeLessThan(MIB);

    const samples = await runSamples("small", conversationId);
    const afterBytes = fs.statSync(CONFIG_FILE).size;
    // Emit diagnostics before any behavioral assertion so a contract failure
    // still leaves the complete raw latency and event-order evidence.
    printReport("representative", { before: beforeBytes, after: afterBytes }, samples);
    const persisted = config();
    assertSamples(samples, persisted);
    smallRunIds = samples.map((sample) => sample.chatResult.runId);

    expect(p95(samples.map((sample) => sample.uiLatencyMs))).toBeLessThanOrEqual(UI_P95_LIMIT_MS);
    expect(p95(samples.map((sample) => sample.mainAckLatencyMs))).toBeLessThanOrEqual(MAIN_ACK_P95_LIMIT_MS);
  }, 10 * 60_000);

  it("keeps the same budgets with an approximately 50 MiB legal config", async () => {
    const before = config();
    const originalRunIds = (before.agentRuns || []).map((run: any) => run.id);
    expect(originalRunIds).toEqual(expect.arrayContaining(smallRunIds));
    const preserved = {
      provider: before.llm?.provider,
      model: before.llm?.model,
      apiUrl: before.llm?.apiUrl,
      defaultProxy: before.defaultProxy,
      proxyNames: Object.keys(before.proxies || {}),
      runIds: originalRunIds,
    };

    // Execute inside Electron's main process and import the already-loaded store
    // and normalizer modules. The padding is derived from the normalized pretty-
    // JSON overhead with empty results, then applied across realistic retained
    // traces. transact() still performs the acceptance write through the actual
    // size guard, atomic rename and cache synchronization path.
    const mutation = await h.app.evaluate(async (_electron, input) => {
      // Vite rewrites lexical imports, while Playwright's evaluation context has
      // no dynamic-import callback. Use Node's main-context loader explicitly to
      // resolve the already-loaded modules and their shared singleton cache.
      const vm = process.getBuiltinModule("node:vm");
      const nativeImport = (url: string): Promise<any> => vm.runInThisContext(`import(${JSON.stringify(url)})`, {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      });
      const store = await nativeImport(input.storeModuleUrl);
      const manager = await nativeImport(input.configManagerModuleUrl);
      const snapshot = store.readSnapshot();
      const existingRuns = Array.isArray(snapshot.agentRuns) ? snapshot.agentRuns : [];
      if (existingRuns.length + input.fillerRunCount + input.futureRunCount > input.maxRunCount) {
        throw new Error("trace fixture would exceed retained-run capacity");
      }

      const baseTimestamp = 1_700_000_000_000;
      const fillerRuns = Array.from({ length: input.fillerRunCount }, (_unused, runIndex) => {
        const runPart = String(runIndex).padStart(3, "0");
        const startedAt = baseTimestamp + runIndex * 1_000;
        return {
          id: `run_m1cancel_perf_${runPart}`,
          name: `M1 cancellation pressure fixture ${runPart}`,
          source: { type: "chat", conversationId: "m1_cancel_pressure_fixture" },
          status: "done",
          startedAt,
          finishedAt: startedAt + input.stepsPerRun,
          steps: Array.from({ length: input.stepsPerRun }, (_step, stepIndex) => ({
            id: `step_m1cancel_perf_${runPart}_${String(stepIndex).padStart(3, "0")}`,
            tool: "db_query",
            args: { sql: "SELECT 1" },
            result: "",
            ok: true,
            durationMs: 1,
            timestamp: startedAt + stepIndex,
          })),
          variables: {},
          endReason: "completed",
          verification: { status: "unverified" },
        };
      });

      // Normalize an empty-result candidate once so all config and object-shape
      // overhead is represented. ASCII result padding then adds exactly one UTF-8
      // byte per character without JSON escaping.
      snapshot.agentRuns = [...existingRuns, ...fillerRuns];
      let normalizedBlank: any = manager.mergeConfigForStore(snapshot, "save");
      let blankText = JSON.stringify(normalizedBlank, null, 2);
      const baselineBytes = Buffer.byteLength(blankText, "utf8");
      normalizedBlank = null;
      blankText = "";
      const resultCount = input.fillerRunCount * input.stepsPerRun;
      const missingBytes = input.targetBytes - baselineBytes;
      if (missingBytes <= 0) throw new Error(`trace fixture overhead ${baselineBytes} already exceeds target ${input.targetBytes}`);
      const resultChars = Math.floor(missingBytes / resultCount);
      const extraResultCount = missingBytes % resultCount;
      const maxResultChars = resultChars + (extraResultCount ? 1 : 0);
      if (resultChars < 1 || maxResultChars >= input.resultLimit) {
        throw new Error(`computed result padding ${resultChars}-${maxResultChars} is outside the trace limit`);
      }
      const baseResult = "x".repeat(resultChars);
      const extendedResult = extraResultCount ? `${baseResult}x` : baseResult;
      let resultIndex = 0;
      for (const run of fillerRuns) {
        for (const step of run.steps) {
          step.result = resultIndex < extraResultCount ? extendedResult : baseResult;
          resultIndex++;
        }
      }
      const predictedBytes = baselineBytes + resultChars * resultCount + extraResultCount;

      const writeSummary = store.transact((draft: any) => {
        const priorRuns = Array.isArray(draft.agentRuns) ? draft.agentRuns : [];
        const priorRunIds = priorRuns.map((run: any) => run.id);
        draft.agentRuns = [...priorRuns, ...fillerRuns];
        return {
          priorRunIds,
          priorProxyNames: Object.keys(draft.proxies || {}),
          defaultProxy: draft.defaultProxy,
          llm: draft.llm ? { provider: draft.llm.provider, model: draft.llm.model, apiUrl: draft.llm.apiUrl } : null,
          finalRunCount: draft.agentRuns.length,
        };
      });
      return {
        ...writeSummary,
        fillerRunIds: fillerRuns.map((run) => run.id),
        baselineBytes,
        predictedBytes,
        resultCount,
        resultChars,
        maxResultChars,
        extraResultCount,
      };
    }, {
      storeModuleUrl: STORE_MODULE_URL,
      configManagerModuleUrl: CONFIG_MANAGER_MODULE_URL,
      fillerRunCount: FILLER_RUN_COUNT,
      stepsPerRun: FILLER_STEPS_PER_RUN,
      futureRunCount: SAMPLE_COUNT,
      maxRunCount: 200,
      targetBytes: LARGE_CONFIG_TARGET_BYTES,
      resultLimit: TRACE_RESULT_LIMIT,
    });

    const largeBeforeBytes = fs.statSync(CONFIG_FILE).size;
    console.log(
      `[m1-cancel-latency] trace fixture runs=${FILLER_RUN_COUNT} steps=${mutation.resultCount}`
        + ` resultChars=${mutation.resultChars}-${mutation.maxResultChars}`
        + ` baselineBytes=${mutation.baselineBytes} predictedBytes=${mutation.predictedBytes}`
        + ` actualBytes=${largeBeforeBytes} delta=${largeBeforeBytes - LARGE_CONFIG_TARGET_BYTES}`,
    );
    expect(mutation.priorProxyNames).toEqual(preserved.proxyNames);
    expect(mutation.priorRunIds).toEqual(preserved.runIds);
    expect(mutation.defaultProxy).toBe(preserved.defaultProxy);
    expect(mutation.llm).toMatchObject({
      provider: preserved.provider,
      model: preserved.model,
      apiUrl: preserved.apiUrl,
    });
    expect(mutation.fillerRunIds).toHaveLength(FILLER_RUN_COUNT);
    expect(mutation.resultCount).toBe(FILLER_RUN_COUNT * FILLER_STEPS_PER_RUN);
    expect(mutation.maxResultChars).toBeLessThan(TRACE_RESULT_LIMIT);
    expect(mutation.predictedBytes).toBe(LARGE_CONFIG_TARGET_BYTES);
    expect(mutation.finalRunCount).toBe(preserved.runIds.length + FILLER_RUN_COUNT);
    expect(mutation.finalRunCount + SAMPLE_COUNT).toBeLessThanOrEqual(200);

    const assertFillerRuns = (persistedConfig: any): void => {
      const fillerIds = new Set(mutation.fillerRunIds);
      const fillerRuns = persistedConfig.agentRuns.filter((run: any) => fillerIds.has(run.id));
      expect(fillerRuns).toHaveLength(FILLER_RUN_COUNT);
      const steps = fillerRuns.flatMap((run: any) => {
        expect(run).toMatchObject({
          status: "done",
          endReason: "completed",
          verification: { status: "unverified" },
        });
        expect(run.steps).toHaveLength(FILLER_STEPS_PER_RUN);
        return run.steps;
      });
      expect(steps).toHaveLength(FILLER_RUN_COUNT * FILLER_STEPS_PER_RUN);
      expect(steps.every((step: any) => /^step_[a-zA-Z0-9_-]{1,80}$/.test(step.id))).toBe(true);
      expect(steps.every((step: any) => step.tool === "db_query" && step.args?.sql === "SELECT 1" && step.ok === true)).toBe(true);
      expect(steps.every((step: any) => typeof step.result === "string" && step.result.length < TRACE_RESULT_LIMIT)).toBe(true);
      const lengths = steps.map((step: any) => step.result.length);
      expect(Math.min(...lengths)).toBe(mutation.resultChars);
      expect(Math.max(...lengths)).toBe(mutation.maxResultChars);
    };

    expect(Math.abs(largeBeforeBytes - LARGE_CONFIG_TARGET_BYTES)).toBeLessThanOrEqual(64 * 1024);
    expect(largeBeforeBytes).toBeLessThan(CONFIG_MAX_BYTES);
    {
      const afterMutation = config();
      expect(afterMutation.agentRuns).toHaveLength(preserved.runIds.length + FILLER_RUN_COUNT);
      expect(afterMutation.defaultProxy).toBe(preserved.defaultProxy);
      expect(afterMutation.llm).toMatchObject({
        provider: preserved.provider,
        model: preserved.model,
        apiUrl: preserved.apiUrl,
      });
      for (const name of preserved.proxyNames) expect(afterMutation.proxies).toHaveProperty(name);
      for (const runId of preserved.runIds) {
        expect(afterMutation.agentRuns.some((run: any) => run.id === runId), `preserve original run ${runId}`).toBe(true);
      }
      assertFillerRuns(afterMutation);
    }

    const conversationId = await createConversation(h.page, "M1 cancellation latency — 50 MiB config");
    const samples = await runSamples("large", conversationId);
    const largeAfterBytes = fs.statSync(CONFIG_FILE).size;
    // Keep performance evidence even when a later lifecycle assertion fails.
    printReport("50MiB trace history", { before: largeBeforeBytes, after: largeAfterBytes }, samples);
    expect(largeAfterBytes).toBeGreaterThanOrEqual(49 * MIB);
    expect(largeAfterBytes).toBeLessThan(51 * MIB);
    expect(largeAfterBytes).toBeLessThan(CONFIG_MAX_BYTES);
    const persisted = config();
    assertSamples(samples, persisted);
    assertFillerRuns(persisted);
    expect(persisted.agentRuns).toHaveLength(preserved.runIds.length + FILLER_RUN_COUNT + SAMPLE_COUNT);
    expect(persisted.agentRuns.length).toBeLessThanOrEqual(200);
    for (const runId of preserved.runIds) {
      expect(persisted.agentRuns.some((run: any) => run.id === runId), `retain original run ${runId}`).toBe(true);
    }
    for (const runId of mutation.fillerRunIds) {
      expect(persisted.agentRuns.some((run: any) => run.id === runId), `retain filler run ${runId}`).toBe(true);
    }

    expect(p95(samples.map((sample) => sample.uiLatencyMs))).toBeLessThanOrEqual(UI_P95_LIMIT_MS);
    expect(p95(samples.map((sample) => sample.mainAckLatencyMs))).toBeLessThanOrEqual(MAIN_ACK_P95_LIMIT_MS);
  }, 20 * 60_000);
});
