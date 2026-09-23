import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setupTestApp, closeApp, type TestAppHandle } from "./helpers/app.js";
import { connectBrowserCdp, connectPageCdp, listTargets, waitForCdpPort, waitForPortClosed, waitForPageUrl } from "./helpers/cdp.js";
import { startMockLlm, type MockLlmServer, type MockLlmResponse } from "./helpers/mock-llm.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-m1-control-e2e-"));
const configFile = path.join(USERDATA, "config.json");
const historyFile = path.join(USERDATA, "agent-conversations.json");
const FIXTURE_URL = "data:text/html," + encodeURIComponent('<title>M1 fixture</title><body><input id="m1-target" value="untouched"><button id="m1-click">Count</button><script>window.__m1Clicks=0;document.getElementById("m1-click").onclick=()=>window.__m1Clicks++;</script></body>');
type Profile = { dirId: string; port: number; pid: number; name: string; targetId: string };

function config() { return JSON.parse(fs.readFileSync(configFile, "utf8")); }
function history() { return JSON.parse(fs.readFileSync(historyFile, "utf8")) as any[]; }
function databaseRows(sql: string): any[] {
  const database = new DatabaseSync(path.join(USERDATA, "agent-store.sqlite"), { readOnly: true });
  try { return database.prepare(sql).all(); } finally { database.close(); }
}

// These pages and databases are created exclusively for this authorized local
// fixture. No personal browser data or external model endpoint is used.
describe("M1 — real desktop execution boundaries and persistence", () => {
  let h: TestAppHandle;
  let mock: MockLlmServer;
  let a: Profile;
  let b: Profile;
  let preservedConversation = "";
  let preservedRun = "";
  let interruptedConversation = "";
  let interruptedRun = "";
  let requestSequence = 0;

  async function launch(resetUserData = false) {
    h = await setupTestApp({ userDataDir: USERDATA, resetUserData, env: { AGENT_BROWSER_API_PORT: "0" } });
    await h.page.evaluate((url) => (window as any).agentBrowser.api.agent.saveLlmConfig({
      provider: "openai", apiKey: "m1-local-fixture-key", model: "e2e-mock-model", apiUrl: url,
    }), mock.url);
    await h.page.evaluate(() => {
      const w = window as any;
      w.__m1Tasks = {};
      w.__m1Events = [];
      for (const channel of ["agent:stream-start", "agent:stream-chunk", "agent:stream-tool-call", "agent:stream-done", "agent:stream-error"]) {
        w.agentBrowser.api.on(channel, (payload: any) => w.__m1Events.push({ channel, ...payload }));
      }
    });
  }

  async function createProfile(name: string): Promise<Profile> {
    const created = await h.page.evaluate(({ name, url }) => (window as any).agentBrowser.api.browser.create({
      name, platform: "windows", proxyMode: "none", appUrl: url, fingerprintMode: "off",
    }), { name, url: FIXTURE_URL });
    expect(created.dirId, JSON.stringify(created)).toBeTruthy();
    const profile = { dirId: created.dirId, port: 0, pid: 0, name, targetId: "" };
    await launchProfile(profile);
    return profile;
  }

  async function launchProfile(profile: Profile) {
    const launched = await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.launch(id), profile.dirId);
    expect(launched.success, JSON.stringify(launched)).toBe(true);
    profile.port = launched.cdpPort;
    profile.pid = launched.pid;
    h.cdpPids.push(launched.pid);
    await waitForCdpPort(profile.port);
    await waitForPageUrl(profile.port, "data:text/html", 15_000);
    const targets = await listTargets(profile.port);
    const fixture = targets.find((target) => target.type === "page" && target.url?.startsWith("data:text/html"));
    expect(fixture, JSON.stringify(targets)).toBeDefined();
    profile.targetId = fixture!.id;
    // App-mode startup can also expose a blank page. Keep this isolated browser
    // single-page so the product's first-page tools and our probes see the same
    // fixture, rather than reselection changing targets between assertions.
    const secondary = targets.filter((target) => target.type === "page" && target.id !== profile.targetId);
    if (secondary.length) {
      const browser = await connectBrowserCdp(profile.port);
      try {
        for (const target of secondary) await browser.send("Target.closeTarget", { targetId: target.id });
      } finally { browser.close(); }
      console.log(`[m1] ${profile.name}: closed ${secondary.length} secondary fixture page(s)`);
    }
    // /json may publish the destination before the old about:blank document is
    // replaced; readyState alone can therefore report the wrong document ready.
    await vi.waitFor(async () => expect(await fixtureEvaluate(profile,
      "document.readyState === 'complete' && document.title === 'M1 fixture' && !!document.getElementById('m1-target')")).toBe(true), { timeout: 10_000 });
    await seed(profile);
  }

  async function fixtureEvaluate<T = unknown>(profile: Profile, expression: string): Promise<T> {
    const client = await connectPageCdp(profile.port, (target) => target.id === profile.targetId);
    try {
      await client.send("Runtime.enable");
      const response = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(`${profile.name}: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`);
      return response.result?.value as T;
    } finally { client.close(); }
  }

  async function seed(profile: Profile) {
    const seeded = await fixtureEvaluate(profile, `(() => {
      document.body.innerHTML = '<input id="m1-target" value="untouched"><button id="m1-click">Count</button>';
      window.__m1Clicks = 0;
      document.getElementById('m1-click').addEventListener('click', () => window.__m1Clicks++);
      return document.getElementById('m1-target').value;
    })()`);
    expect(seeded, `fixture DOM missing in ${profile.name}`).toBe("untouched");
  }

  async function pageState(profile: Profile) {
    return fixtureEvaluate<{ value: string; clicks: number }>(profile,
      "({ value: document.getElementById('m1-target').value, clicks: window.__m1Clicks })");
  }

  async function conversation(title: string) {
    return (await h.page.evaluate((title) => (window as any).agentBrowser.api.agent.conversations.create(title), title)).id as string;
  }

  async function start(conversationId: string, options: { profile?: Profile; streaming?: boolean; message?: string; requestId?: string } = {}) {
    const requestId = options.requestId || `m1_request_${++requestSequence}`;
    await h.page.evaluate((params) => {
      const w = window as any;
      w.__m1Tasks[params.requestId] = { done: false };
      const api = w.agentBrowser.api.agent;
      const task = params.streaming
        ? api.chatStream(params.conversationId, params.message, params.requestId, { profileDirId: params.profileDirId })
        : api.chat(params.conversationId, params.message, { requestId: params.requestId, profileDirId: params.profileDirId });
      task.then((result: any) => { w.__m1Tasks[params.requestId] = { done: true, result }; }, (error: any) => {
        w.__m1Tasks[params.requestId] = { done: true, rpcError: String(error) };
      });
    }, { conversationId, requestId, streaming: options.streaming !== false, message: options.message || "Run the authorized M1 fixture", profileDirId: options.profile?.dirId });
    return requestId;
  }

  async function result(requestId: string) {
    await expect.poll(() => h.page.evaluate((id) => (window as any).__m1Tasks[id]?.done, requestId), { timeout: 30_000 }).toBe(true);
    const task = await h.page.evaluate((id) => (window as any).__m1Tasks[id], requestId);
    expect(task.rpcError).toBeUndefined();
    return task.result as any;
  }

  async function active(conversationId: string) {
    return h.page.evaluate((id) => (window as any).agentBrowser.api.agent.activeRun(id), conversationId);
  }

  function scriptTool(name: string, args: Record<string, unknown>): MockLlmResponse[] {
    return [{ chunks: [], toolCalls: [{ id: "fixture-call", name, arguments: args }] }, { chunks: ["Execution finished; business outcome not verified."] }];
  }

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 5 });
    await launch();
    a = await createProfile("M1 environment A");
    b = await createProfile("M1 environment B");
    expect(a.port).not.toBe(b.port);
  }, 90_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (mock) await mock.close();
  }, 90_000);

  it.each([true, false])("pins real environment A and refuses B through both chat modes (stream=%s)", async (streaming) => {
    await seed(a);
    await seed(b);
    const id = await conversation("Scope A vs B");
    const before = mock.requests.length;
    mock.setResponses(scriptTool("browser_type", { port: b.port, selector: "#m1-target", text: "must-not-write-B" }));
    const finished = await result(await start(id, { profile: a, streaming }));
    expect(finished.persisted).toBe(true);
    const run = config().agentRuns.find((entry: any) => entry.id === finished.runId);
    expect(run).toMatchObject({ dirId: a.dirId, source: { conversationId: id }, verification: { status: "unverified" } });
    expect(run.steps[0]).toMatchObject({ tool: "browser_type", ok: false });
    expect(run.steps[0].error).toMatch(/scope|selected|bound|port/i);
    expect(await pageState(b)).toEqual({ value: "untouched", clicks: 0 });
    expect(await pageState(a)).toEqual({ value: "untouched", clicks: 0 });
    const body = mock.requests[before].body;
    const system = body.messages.find((message: any) => message.role === "system").content;
    expect(system).toContain(a.dirId);
    expect(system).not.toContain(b.dirId);
    const tools = body.tools.map((tool: any) => tool.function.name);
    expect(tools).toContain("browser_type");
    for (const blocked of ["browser_evaluate", "launch_profile", "create_automation_rule", "delete_automation_rule"]) expect(tools).not.toContain(blocked);
  });

  it("allows the chosen real instance while keeping B unchanged and redacting streamed tool arguments", async () => {
    await seed(a);
    const id = await conversation("Allowed A");
    mock.setResponses(scriptTool("browser_type", { port: a.port, selector: "#m1-target", text: "authorized-A-text" }));
    const requestId = await start(id, { profile: a });
    const finished = await result(requestId);
    expect(finished).toMatchObject({ status: "done", endReason: "completed", persisted: true });
    expect((await pageState(a)).value).toBe("authorized-A-text");
    expect((await pageState(b)).value).toBe("untouched");
    const events = await h.page.evaluate((id) => (window as any).__m1Events.filter((event: any) => event.streamId === id), requestId);
    expect(events.filter((event: any) => /agent:stream-(done|error)/.test(event.channel))).toHaveLength(1);
    expect(events.find((event: any) => event.channel === "agent:stream-tool-call")).toMatchObject({ arguments: "{}", redacted: true, runId: finished.runId, conversationId: id });
  });

  it("does not fall back to unmanaged high ports or implicitly choose a browser", async () => {
    for (const profile of [a, undefined]) {
      const id = await conversation(profile ? "Forged port" : "No browser selected");
      const before = mock.requests.length;
      mock.setResponses(scriptTool("browser_click", { port: profile ? mock.port : b.port, selector: "#m1-click" }));
      const finished = await result(await start(id, { profile }));
      const run = config().agentRuns.find((entry: any) => entry.id === finished.runId);
      expect(run.steps[0].ok).toBe(false);
      if (!profile) {
        expect(run.dirId).toBeUndefined();
        expect(mock.requests[before].body.tools.some((tool: any) => tool.function.name.startsWith("browser_"))).toBe(false);
      }
      expect((await pageState(b)).clicks).toBe(0);
    }
  });

  it("refuses a stopped/restarted instance instead of rebinding the pinned selection", async () => {
    const id = await conversation("Pinned instance replacement");
    const before = mock.requests.length;
    const oldPort = a.port;
    const oldPid = a.pid;
    mock.setResponses([{ ...scriptTool("browser_type", { port: oldPort, selector: "#m1-target", text: "old-scope" })[0], pause: true }, { chunks: ["Refused replaced instance."] }]);
    const requestId = await start(id, { profile: a });
    await expect.poll(() => mock.requests.length).toBe(before + 1);
    await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.stop(id), a.dirId);
    await waitForPortClosed(oldPort);
    // Closing CDP is earlier than process exit. Wait for the runtime to release
    // the old instance instead of racing Chromium's profile singleton lock.
    await expect.poll(async () => (await h.page.evaluate((dirId) => (window as any).agentBrowser.api.browser.status(dirId), a.dirId)).running, { timeout: 10_000 }).toBe(false);
    await launchProfile(a);
    expect(a.pid).not.toBe(oldPid);
    expect(mock.releaseRequest(before)).toBe(true);
    const finished = await result(requestId);
    const run = config().agentRuns.find((entry: any) => entry.id === finished.runId);
    expect(run.steps[0].ok).toBe(false);
    expect(run.steps[0].error).toMatch(/instance|stopped|running|changed|scope|replaced/i);
    expect(await pageState(a)).toEqual({ value: "untouched", clicks: 0 });
    expect(await pageState(b)).toEqual({ value: "untouched", clicks: 0 });
    console.log(`[m1] pinned instance: old=${oldPid}:${oldPort} new=${a.pid}:${a.port}; replacement rejected`);
  });

  it("cancels a real browser load wait without dispatching the following action or closing the browser", async () => {
    await seed(a);
    const id = await conversation("Cancel browser wait");
    mock.setResponses([{ chunks: [], toolCalls: [
      { id: "wait", name: "browser_wait_for_load", arguments: { port: a.port, timeoutMs: 20_000 } },
      { id: "after-wait", name: "browser_type", arguments: { port: a.port, selector: "#m1-target", text: "must-not-dispatch" } },
    ] }]);
    const requestId = await start(id, { profile: a });
    await expect.poll(async () => (await active(id))?.currentTool, { timeout: 10_000 }).toBe("browser_wait_for_load");
    // This Chromium helper waits for the next load event (not readyState).
    // Keep the fixture stable and verify the wait is still in flight before Stop.
    await h.page.waitForTimeout(150);
    const snapshot = await active(id);
    expect(snapshot.currentTool).toBe("browser_wait_for_load");
    const since = Date.now();
    const stopped = await h.page.evaluate((identity) => (window as any).agentBrowser.api.agent.cancelRun(identity), { conversationId: id, runId: snapshot.runId, streamId: requestId });
    expect(stopped).toMatchObject({ accepted: true, state: "cancelling" });
    const finished = await result(requestId);
    expect(Date.now() - since).toBeLessThan(3_000);
    expect(finished).toMatchObject({ endReason: "user_cancelled", persisted: true });
    expect(config().agentRuns.find((run: any) => run.id === finished.runId).steps).toHaveLength(1);
    expect((await pageState(a)).value).toBe("untouched");
    expect((await pageState(b)).value).toBe("untouched");
    expect((await h.page.evaluate((id) => (window as any).agentBrowser.api.browser.status(id), a.dirId)).running).toBe(true);
  });

  it.each([true, false])("deduplicates, disconnects a paused model and prevents later actions (stream=%s)", async (streaming) => {
    const id = await conversation("Model cancellation");
    const before = mock.requests.length;
    mock.setResponses([{ ...scriptTool("browser_click", { port: a.port, selector: "#m1-click" })[0], pause: true }]);
    const requestId = await start(id, { profile: a, streaming });
    await expect.poll(() => mock.requests.length).toBe(before + 1);
    const snapshot = await active(id);
    expect(snapshot).toMatchObject({ conversationId: id, streamId: requestId, profileDirId: a.dirId });
    const duplicate = h.page.evaluate((params) => {
      const api = (window as any).agentBrowser.api.agent;
      return params.streaming ? api.chatStream(params.id, "Run the authorized M1 fixture", params.requestId, { profileDirId: params.profileDirId })
        : api.chat(params.id, "Run the authorized M1 fixture", { requestId: params.requestId, profileDirId: params.profileDirId });
    }, { id, requestId, profileDirId: a.dirId, streaming });
    const busy = await h.page.evaluate((id) => (window as any).agentBrowser.api.agent.chatStream(id, "overlap", "different-id"), id);
    expect(busy.code).toBe("BUSY");
    expect(history().find((entry) => entry.id === id).messages).toHaveLength(1);
    await h.page.evaluate((identity) => (window as any).agentBrowser.api.agent.cancelRun(identity), { conversationId: id, runId: snapshot.runId, streamId: requestId });
    const finished = await result(requestId);
    expect(await duplicate).toEqual(finished);
    expect(finished).toMatchObject({ endReason: "user_cancelled", persisted: true });
    await expect.poll(() => mock.requests[before].closedBeforeEnd).toBe(true);
    expect(mock.requests).toHaveLength(before + 1);
    expect(mock.releaseRequest(before)).toBe(false);
    expect((await pageState(a)).clicks).toBe(0);
    expect(config().agentRuns.find((run: any) => run.id === finished.runId).steps).toEqual([]);
    expect(await active(id)).toBeNull();
  });

  it("persists run/message associations and independent guarded SQLite work with no browser selected", async () => {
    preservedConversation = await conversation("M1 durable database result");
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "create", name: "db_exec", arguments: { sql: "CREATE TABLE m1_results (label TEXT)" } }] },
      { chunks: [], toolCalls: [{ id: "write", name: "db_exec", arguments: { sql: "INSERT INTO m1_results VALUES ('m1-searchable')" } }] },
      { chunks: [], toolCalls: [{ id: "read", name: "db_query", arguments: { sql: "SELECT label FROM m1_results WHERE label = 'm1-searchable'" } }] },
      { chunks: ["Stored local M1 fixture."] },
    ]);
    const requestId = await start(preservedConversation);
    const finished = await result(requestId);
    preservedRun = finished.runId;
    expect(finished).toMatchObject({ endReason: "completed", persisted: true, verification: { status: "unverified" } });
    const stored = history().find((entry) => entry.id === preservedConversation);
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages.map((entry: any) => ({ runId: entry.runId, requestId: entry.requestId })))
      .toEqual([{ runId: preservedRun, requestId }, { runId: preservedRun, requestId }]);
    expect(databaseRows("SELECT label FROM m1_results")).toEqual([{ label: "m1-searchable" }]);
    expect(databaseRows("SELECT label FROM m1_results WHERE label = 'm1-searchable'")).toEqual([{ label: "m1-searchable" }]);
    const read = await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.get(id), preservedRun);
    expect(read).toMatchObject({ status: "done", endReason: "completed", source: { conversationId: preservedConversation } });
    expect(read.steps.every((step: any) => step.ok)).toBe(true);
    const summaries = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    expect(summaries.find((run: any) => run.id === preservedRun)?.source.conversationId).toBe(preservedConversation);
  });

  it("recovers a force-stopped process as interrupted using the user message already on disk", async () => {
    interruptedConversation = await conversation("M1 forced process interruption");
    const before = mock.requests.length;
    mock.setResponses([{ chunks: ["Never completed"], pause: true }]);
    await start(interruptedConversation);
    await expect.poll(() => mock.requests.length).toBe(before + 1);
    interruptedRun = (await active(interruptedConversation)).runId;
    expect(history().find((entry) => entry.id === interruptedConversation).messages).toEqual([
      expect.objectContaining({ role: "user", runId: interruptedRun }),
    ]);
    expect(config().agentRuns.find((run: any) => run.id === interruptedRun).status).toBe("running");
    await closeApp(h); // helper force-stops this isolated process, not a graceful quit
    await expect.poll(() => mock.requests[before].closedBeforeEnd).toBe(true);
    await launch(false);
    const recovered = await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.get(id), interruptedRun);
    expect(recovered).toMatchObject({ status: "error", endReason: "interrupted", verification: { status: "unverified" } });
    expect(await active(interruptedConversation)).toBeNull();
    const stored = await h.page.evaluate((id) => (window as any).agentBrowser.api.agent.conversations.get(id), interruptedConversation);
    expect(stored.messages[0].runId).toBe(interruptedRun);
    expect(mock.requests).toHaveLength(before + 1);
    expect(config().agentRuns.find((run: any) => run.id === interruptedRun)).toMatchObject({ status: "error", endReason: "interrupted" });
  }, 60_000);

  it("reads, finds and clears the exact completed run after reopening without deleting its messages or SQLite result", async () => {
    const read = await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.get(id), preservedRun);
    expect(read).toMatchObject({ endReason: "completed", verification: { status: "unverified" } });
    const stored = await h.page.evaluate((id) => (window as any).agentBrowser.api.agent.conversations.get(id), preservedConversation);
    expect(stored.messages.every((message: any) => message.runId === preservedRun)).toBe(true);
    expect(databaseRows("SELECT label FROM m1_results WHERE label = 'm1-searchable'")).toEqual([{ label: "m1-searchable" }]);
    expect((await h.page.evaluate(() => (window as any).agentBrowser.api.agentDb.query("SELECT label FROM m1_results"))).rows).toEqual([{ label: "m1-searchable" }]);
    expect(await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.delete(id), preservedRun)).toMatchObject({ success: true });
    expect(await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.get(id), preservedRun)).toBeNull();
    expect(history().find((entry) => entry.id === preservedConversation).messages.map((entry: any) => entry.runId)).toEqual([preservedRun, preservedRun]);
    expect(config().agentRuns.some((run: any) => run.id === preservedRun)).toBe(false);
    expect(h.pageErrors).toEqual([]);
    console.log(`[m1] direct disk/reopen/search verified: ${preservedConversation}, interrupted=${interruptedRun}, SQLite=m1-searchable`);
  });

  it("requires explicit UI startup and freezes the selected environment for the submitted task", async () => {
    const id = await conversation("M1 explicit environment startup");
    const before = mock.requests.length;
    expect((await h.page.evaluate((dirId) => (window as any).agentBrowser.api.browser.status(dirId), a.dirId)).running).toBe(false);
    await h.page.evaluate(async (conversationId) => {
      const app = (window as any).agentBrowser;
      (window as any).i18n.set("en-US");
      app.switchTab("agent");
      app.switchAgentSub("chat");
      await app.agentSelectConv(conversationId);
      await app.agentRefreshEnvironments();
    }, id);
    await h.page.locator("#agent-env-select").selectOption(a.dirId);
    expect(await h.page.locator("#agent-env-status").innerText()).toContain("stopped");
    const refused = await h.page.evaluate(() => (window as any).agentBrowser._doAgentSend("Do not silently start the browser"));
    expect(refused).toBeNull();
    expect(history().find((entry) => entry.id === id).messages).toEqual([]);
    expect(mock.requests).toHaveLength(before);
    expect((await h.page.evaluate((dirId) => (window as any).agentBrowser.api.browser.status(dirId), a.dirId)).running).toBe(false);

    await h.page.locator("#agent-env-start").click();
    await expect.poll(async () => (await h.page.evaluate((dirId) => (window as any).agentBrowser.api.browser.status(dirId), a.dirId)).running, { timeout: 30_000 }).toBe(true);
    await h.page.waitForFunction(() => document.getElementById("agent-env-status")?.classList.contains("is-ready"), undefined, { timeout: 10_000 });
    mock.setResponses([{ chunks: ["Selected environment is pinned."], pause: true }]);
    await h.page.locator("#agent-chat-input").fill("Use only my explicitly started environment");
    await h.page.locator("#agent-chat-input").press("Enter");
    await expect.poll(() => mock.requests.length).toBe(before + 1);
    const snapshot = await active(id);
    expect(snapshot.profileDirId).toBe(a.dirId);
    expect(await h.page.locator("#agent-env-select").isDisabled()).toBe(true);
    expect(await h.page.locator("#agent-env-status").innerText()).toContain(a.name);
    expect(config().agentRuns.find((run: any) => run.id === snapshot.runId).dirId).toBe(a.dirId);
    await h.page.locator("#agent-chat-stop").click();
    await expect.poll(() => active(id)).toBeNull();
    expect(config().agentRuns.find((run: any) => run.id === snapshot.runId).endReason).toBe("user_cancelled");
    await expect.poll(() => mock.requests[before].closedBeforeEnd).toBe(true);
  }, 60_000);

  it("keeps a hidden window running but gracefully interrupts on real repeated app.quit", async () => {
    const id = await conversation("M1 graceful process exit");
    const before = mock.requests.length;
    mock.setResponses([{ chunks: ["Never completed"], pause: true }]);
    await start(id);
    await expect.poll(() => mock.requests.length).toBe(before + 1);
    const runId = (await active(id)).runId;
    const window = await h.app.browserWindow(h.page);
    await window.evaluate((browserWindow) => browserWindow.hide());
    expect(await window.evaluate((browserWindow) => browserWindow.isVisible())).toBe(false);
    expect(await active(id)).toMatchObject({ runId, state: "running" });
    expect(mock.requests[before].closedBeforeEnd).not.toBe(true);
    await window.evaluate((browserWindow) => browserWindow.show());

    // UI startup may replace the original fixture PID. Query actual runtimes
    // immediately before quit rather than asserting against stale a.pid/b.pid.
    const managed = await h.page.evaluate(async (ids) => {
      const browser = (window as any).agentBrowser.api.browser;
      const states = await Promise.all(ids.map(async (dirId) => ({ dirId, ...await browser.status(dirId) })));
      return states.filter((state) => state.running && Number.isInteger(state.pid));
    }, [a.dirId, b.dirId]);
    expect(managed.some((target) => target.dirId === a.dirId)).toBe(true);
    for (const target of managed) expect(process.kill(target.pid, 0)).toBe(true);

    const child = h.app.process();
    const exitOutput: string[] = [];
    const captureExit = (chunk: Buffer) => { exitOutput.push(String(chunk)); };
    child.stdout?.on("data", captureExit);
    child.stderr?.on("data", captureExit);
    const closed = h.app.waitForEvent("close", { timeout: 25_000 });
    try {
      await h.app.evaluate(({ app }) => { app.quit(); app.quit(); });
      await closed;
    } catch (error) {
      console.log(`[m1] graceful quit diagnostics: ${exitOutput.join("").slice(-12_000)}`);
      console.log(`[m1] quit process state: ${JSON.stringify({ exitCode: child.exitCode, signalCode: child.signalCode, stdoutEnded: child.stdout?.readableEnded, stderrEnded: child.stderr?.readableEnded, pageClosed: h.page.isClosed() })}`);
      console.log(`[m1] quit disk state: ${JSON.stringify(config().agentRuns.find((run: any) => run.id === runId))}; modelDisconnected=${mock.requests[before].closedBeforeEnd}`);
      throw error;
    } finally {
      child.stdout?.removeListener("data", captureExit);
      child.stderr?.removeListener("data", captureExit);
    }
    await expect.poll(() => child.exitCode).toBe(0);
    // Main must wait for actual managed-child exit, not abandon its three-second
    // SIGKILL escalation timer by exiting immediately after sending SIGTERM.
    for (const target of managed) {
      expect(() => process.kill(target.pid, 0), `managed browser ${target.dirId}:${target.pid} survived quit`).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    }
    await expect.poll(() => mock.requests[before].closedBeforeEnd).toBe(true);
    // Inspect before restarting: this must be graceful finalization, not merely
    // the startup normalizer repairing a stale running record.
    expect(config().agentRuns.find((run: any) => run.id === runId)).toMatchObject({
      status: "error", endReason: "interrupted", verification: { status: "unverified" },
    });
    const stored = history().find((entry) => entry.id === id);
    expect(stored.messages.map((message: any) => ({ role: message.role, runId: message.runId }))).toEqual([
      { role: "user", runId }, { role: "assistant", runId },
    ]);
    await launch(false);
    expect(await h.page.evaluate((runId) => (window as any).agentBrowser.api.agentRuns.get(runId), runId)).toMatchObject({ endReason: "interrupted" });
    expect(mock.requests).toHaveLength(before + 1);
    for (const target of managed) {
      expect(await h.page.evaluate((dirId) => (window as any).agentBrowser.api.browser.status(dirId), target.dirId)).toMatchObject({ running: false, pid: null });
    }
    console.log(`[m1] graceful repeated app.quit: exit=0; ${runId} interrupted before restart; managed PIDs exited=${managed.map((target) => target.pid).join(",")}; hide did not cancel`);
  }, 60_000);
});
