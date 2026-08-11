// J36: Durable job queue (Slice 4). A triggered rule produces a persisted job
// row (source/status/result), surfaced via automation:jobs. Proves the
// run→job wiring for both success and failure.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j36");
const FAR_CRON = "0 0 1 1 *";

describe("J36 — durable job queue", () => {
  let h: TestAppHandle;

  beforeAll(async () => { h = await setupTestApp({ userDataDir: USERDATA }); }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  async function createRule(partial: any): Promise<string> {
    const r = await h.page.evaluate((rule: any) => (window as any).agentBrowser.api.automation.create(rule), partial);
    return r.rule.id;
  }

  it("a successful test-run records a done job", async () => {
    const id = await createRule({
      name: "j36-ok",
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return 'job-ok-sentinel'" },
    });
    const res = await h.page.evaluate((rid: string) => (window as any).agentBrowser.api.automation.testRun(rid), id);
    expect(res.ok).toBe(true);
    const jobs = await h.page.evaluate((rid: string) => (window as any).agentBrowser.api.automation.jobs({ ruleId: rid }), id);
    const mine = jobs.find((j: any) => j.source === "test");
    expect(mine, "a test-source job must exist").toBeTruthy();
    expect(mine.status).toBe("done");
    expect(mine.runId).toBeNull();
    expect(mine.result).toContain("job-ok-sentinel");
    expect(mine.startedAt).toBeGreaterThan(0);
    expect(mine.finishedAt).toBeGreaterThanOrEqual(mine.startedAt);
  }, 30000);

  it("a failing test-run records a failed job with the error", async () => {
    const id = await createRule({
      name: "j36-fail",
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "throw new Error('job-fail-sentinel')" },
    });
    const res = await h.page.evaluate((rid: string) => (window as any).agentBrowser.api.automation.testRun(rid), id);
    expect(res.ok).toBe(false);
    const jobs = await h.page.evaluate((rid: string) => (window as any).agentBrowser.api.automation.jobs({ ruleId: rid, status: "failed" }), id);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].error).toContain("job-fail-sentinel");
  }, 30000);

  it("jobs persist across a config reload (durable, not just in-memory)", async () => {
    // The jobs live in jobs.sqlite; reloading config must not clear them.
    const before = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.jobs({ limit: 100 }));
    expect(before.length).toBeGreaterThanOrEqual(1);
    const id = before[0].id;
    const statusBefore = before[0].status;
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    const after = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.jobs({ limit: 100 }));
    const same = after.find((j: any) => j.id === id);
    expect(same, "the job must survive the reload").toBeTruthy();
    expect(same.status).toBe(statusBefore);
    // The far-future cron rules must NOT have rapid-fired during the test
    // (regression guard for the setTimeout-overflow cron bug).
    const cronFired = after.filter((j: any) => j.source === "cron");
    expect(cronFired.length, "far-future cron must not fire during the test").toBe(0);
  }, 30000);

  it("automation tab surfaces durable jobs with detail lookup", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("automation"));
    await h.page.waitForSelector("#automation-jobs .profile-card", { timeout: 5000 });
    const text = await h.page.locator("#automation-jobs").innerText();
    expect(text).toContain("j36-ok");
    expect(text).toContain("j36-fail");
    expect(text).toContain("job-ok-sentinel");
    expect(text).toContain("job-fail-sentinel");

    const failedJob = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const failed = (await api.automation.jobs({ status: "failed", limit: 10 })).find((j: any) => j.ruleName === "j36-fail");
      return failed ? await api.automation.jobGet(failed.id) : null;
    });
    expect(failedJob, "jobGet wrapper must return the failed job").toBeTruthy();
    expect(failedJob.error).toContain("job-fail-sentinel");

    await h.page.evaluate((jobId: string) => (window as any).agentBrowser.automationShowJob(jobId), failedJob.id);
    await h.page.waitForSelector("#dlg-auto-job[open]", { timeout: 5000 });
    const detail = await h.page.locator("#auto-job-detail").innerText();
    expect(detail).toContain(failedJob.id);
    expect(detail).toContain("job-fail-sentinel");
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|job-fail-sentinel/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
