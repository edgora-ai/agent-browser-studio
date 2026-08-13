// J63: Batch run results grouping + per-profile retry (Slice 28). The Runs tab
// groups all runs of one automation job (batch) into a single expandable card
// with a summary, and failed per-profile runs can be retried individually. The
// retried run is linked back via source.retryOf.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm, MockLlmServer } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j63");

describe("J63 — batch run grouping + per-profile retry", () => {
  let h: TestAppHandle;
  let mock: MockLlmServer;
  let dirId1 = "";
  let dirId2 = "";
  let ruleId = "";

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20 });
    h = await setupTestApp({ userDataDir: USERDATA });
    const a = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J63 Alpha", platform: "windows", fingerprintSeed: 63101 }));
    const b = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J63 Beta", platform: "windows", fingerprintSeed: 63102 }));
    dirId1 = a.dirId;
    dirId2 = b.dirId;
    expect(dirId1).toBeTruthy();
    expect(dirId2).toBeTruthy();
    expect(dirId1).not.toBe(dirId2);
    await h.page.evaluate((murl: string) => {
      (window as any).agentBrowser.api.agent.saveLlmConfig({ provider: "openai", apiKey: "sk", model: "mock", apiUrl: murl });
    }, mock.url);
    const r = await h.page.evaluate(async (ids: string[]) => {
      return (window as any).agentBrowser.api.automation.create({
        name: "J63 batch check",
        enabled: true,
        trigger: { type: "once", at: Date.now() + 60000 },
        action: { type: "agent-task", profileDirIds: ids, agentPrompt: "check the page" },
      });
    }, [dirId1, dirId2]);
    expect(r.success).toBe(true);
    ruleId = r.rule.id;
  }, 90000);

  afterAll(async () => {
    if (h) await closeApp(h);
    try { if (mock) await mock.close(); } catch { /* ignore */ }
  }, 90000);

  async function runFailingBatch(): Promise<{ failedRunId: string; okRunId: string }> {
    mock.setNextResponse({ statusCode: 500, body: JSON.stringify({ error: { message: "mock outage" } }) });
    const res = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.automation.testRun(id), ruleId);
    expect(res.ok, `result: ${res.result}`).toBe(true);
    expect(res.result).toContain("1 ok / 1 failed");
    const runs: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    const mine = runs.filter((x: any) => x.source && x.source.type === "automation" && x.source.ruleId === ruleId && !x.source.retryOf);
    const errRun = mine.filter((x: any) => x.status === "error" && x.dirId === dirId1).sort((a: any, b: any) => b.startedAt - a.startedAt)[0];
    const okRun = mine.find((x: any) => x.status === "done" && x.dirId === dirId2 && x.source.jobId === errRun.source.jobId);
    expect(errRun).toBeTruthy();
    expect(okRun).toBeTruthy();
    expect(errRun.source.jobId).toBe(okRun.source.jobId);
    return { failedRunId: errRun.id, okRunId: okRun.id };
  }

  it("a failing batch produces one error + one done run sharing a jobId", async () => {
    await runFailingBatch();
  }, 90000);

  it("Runs tab groups the batch into one card with a per-profile retry button", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("runs"));
    await h.page.evaluate(() => (window as any).agentBrowser.loadRunsTab());
    await h.page.waitForSelector(".run-group-card", { timeout: 5000 });
    expect(await h.page.locator(".run-group-card").count()).toBe(1);
    const summary = await h.page.locator(".run-group-card .card-header .status-badge").first().innerText();
    expect(summary).toMatch(/1 ok/i);
    expect(summary).toMatch(/1 failed/i);
    expect(await h.page.locator(".run-group-card .run-group-row").count()).toBe(2);
    // Only the failed profile row gets a retry button.
    expect(await h.page.locator('.run-group-card [data-run-action="retry"]').count()).toBe(1);
    // The group header gets a "retry all failed" button for the one failure.
    expect(await h.page.locator('.run-group-card [data-group-action="retry-failed"]').count()).toBe(1);
  }, 30000);

  it("retry API re-runs just that profile and creates a linked done run", async () => {
    const { failedRunId } = await runFailingBatch();
    const res = await h.page.evaluate(async (rid: string) => (window as any).agentBrowser.api.automation.retryRun(rid), failedRunId);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.runId).toBeTruthy();

    await h.page.waitForFunction((rid: string) => (async () => {
      const runs: any[] = await (window as any).agentBrowser.api.agentRuns.list();
      return runs.some((x: any) => x.source && x.source.retryOf === rid && x.status === "done");
    })(), failedRunId, { timeout: 30000 });

    const runs: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    const retried = runs.find((x: any) => x.source && x.source.retryOf === failedRunId);
    expect(retried).toBeTruthy();
    expect(retried.status).toBe("done");
    expect(retried.dirId).toBe(dirId1);
    expect(retried.name).toContain("重试");
  }, 90000);

  it("the Runs tab retry button re-runs a fresh failed profile", async () => {
    const { failedRunId } = await runFailingBatch();
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("runs"));
    await h.page.evaluate(() => (window as any).agentBrowser.loadRunsTab());
    await h.page.waitForSelector(`.run-group-row[data-run-id="${failedRunId}"] [data-run-action="retry"]`, { timeout: 5000 });

    h.page.once("dialog", async (dialog) => { await dialog.accept(); });
    await h.page.locator(`.run-group-row[data-run-id="${failedRunId}"] [data-run-action="retry"]`).click();

    await h.page.waitForFunction((rid: string) => (async () => {
      const runs: any[] = await (window as any).agentBrowser.api.agentRuns.list();
      return runs.some((x: any) => x.source && x.source.retryOf === rid && x.status === "done");
    })(), failedRunId, { timeout: 30000 });

    const runs: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    const retried = runs.find((x: any) => x.source && x.source.retryOf === failedRunId);
    expect(retried).toBeTruthy();
    expect(retried.status).toBe("done");
    expect(retried.dirId).toBe(dirId1);
  }, 90000);

  async function runAllFailedBatch(): Promise<string> {
    mock.setNextResponses([
      { statusCode: 500, body: JSON.stringify({ error: { message: "mock outage 1" } }) },
      { statusCode: 500, body: JSON.stringify({ error: { message: "mock outage 2" } }) },
    ]);
    const res = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.automation.testRun(id), ruleId);
    expect(res.ok, `result: ${res.result}`).toBe(true);
    expect(res.result).toContain("0 ok / 2 failed");
    const runs: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    const mine = runs.filter((x: any) => x.source && x.source.type === "automation" && x.source.ruleId === ruleId && !x.source.retryOf);
    const failed = mine.filter((x: any) => x.status === "error");
    const jobId = failed[0].source.jobId;
    const thisJob = failed.filter((x: any) => x.source.jobId === jobId);
    expect(thisJob.length).toBeGreaterThanOrEqual(2);
    return jobId;
  }

  it("retryJob API re-runs every failed profile of a batch job", async () => {
    const jobId = await runAllFailedBatch();
    const retry = await h.page.evaluate(async (jid: string) => (window as any).agentBrowser.api.automation.retryJob(jid), jobId);
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    expect(retry.attempted).toBe(2);
    expect(retry.succeeded).toBe(2);
    expect(retry.failed).toHaveLength(0);

    await h.page.waitForFunction((jid: string) => (async () => {
      const runs: any[] = await (window as any).agentBrowser.api.agentRuns.list();
      const originals = runs.filter((x: any) => x.source && x.source.type === "automation" && x.source.jobId === jid && !x.source.retryOf && x.status === "error");
      return originals.length >= 2 && originals.every((x: any) =>
        runs.some((y: any) => y.source && y.source.retryOf === x.id && y.status === "done"));
    })(), jobId, { timeout: 30000 });

    const runs: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    const retried = runs.filter((x: any) => x.source && x.source.type === "automation" && x.source.retryOf);
    expect(retried.length).toBeGreaterThanOrEqual(2);
    expect(retried.every((x: any) => x.status === "done")).toBe(true);
  }, 90000);

  it("group retry-all button re-runs all failed profiles from the Runs tab", async () => {
    const jobId = await runAllFailedBatch();
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("runs"));
    await h.page.evaluate(() => (window as any).agentBrowser.loadRunsTab());
    await h.page.waitForSelector('.run-group-card [data-group-action="retry-failed"]', { timeout: 5000 });

    h.page.once("dialog", async (dialog) => { await dialog.accept(); });
    await h.page.locator('.run-group-card [data-group-action="retry-failed"]').first().click();

    await h.page.waitForFunction((jid: string) => (async () => {
      const runs: any[] = await (window as any).agentBrowser.api.agentRuns.list();
      const originals = runs.filter((x: any) => x.source && x.source.type === "automation" && x.source.jobId === jid && !x.source.retryOf && x.status === "error");
      return originals.length >= 2 && originals.every((x: any) =>
        runs.some((y: any) => y.source && y.source.retryOf === x.id && y.status === "done"));
    })(), jobId, { timeout: 30000 });

    const runs: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    const retried = runs.filter((x: any) => x.source && x.source.type === "automation" && x.source.retryOf);
    expect(retried.length).toBeGreaterThanOrEqual(2);
    expect(retried.every((x: any) => x.status === "done")).toBe(true);
  }, 90000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
