// J37: Activity / audit UI tab (Slice 5). A saved LLM config is audited;
// switching to the 活动审计 tab renders the entry; the category filter works;
// clear empties the list.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j37");

describe("J37 — activity / audit tab", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20, chunks: ["ok"] });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  }, 90000);

  it("renders an audited action in the activity tab", async () => {
    // Saving an LLM config is audited (category=llm, action=save).
    await h.page.evaluate((args: any) => (window as any).agentBrowser.api.agent.saveLlmConfig(args), {
      provider: "openai", apiKey: "test-llm-key-j37-not-real", model: "j37-model", apiUrl: mock.url,
    });
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("activity"));
    await h.page.waitForTimeout(400);
    const html = await h.page.locator("#activity-list").innerHTML();
    expect(html).toContain("save");
    expect(html).toContain("openai");
  }, 30000);

  it("renders cross-object target links", async () => {
    const ids = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const profile = await api.browser.create({ name: "J37 linked profile", platform: "windows", fingerprintSeed: 37037 });
      const ruleRes = await api.automation.create({
        name: "j37-link-job",
        trigger: { type: "cron", cron: "0 0 1 1 *" },
        action: { type: "custom-js", jsCode: "return 'j37-link-job-result'" },
      });
      const runResult = await api.automation.testRun(ruleRes.rule.id);
      let job = null;
      for (let i = 0; i < 20 && !job; i++) {
        const jobs = await api.automation.jobs({ ruleId: ruleRes.rule.id, limit: 5 });
        job = (jobs || []).find((j: any) => j.source === "test") || null;
        if (!job) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!job) throw new Error("job fixture missing after testRun: " + JSON.stringify(runResult));
      return { profileId: profile.dirId, jobId: job.id };
    });
    const runId = "run_j37link";
    const cfgPath = path.join(USERDATA, "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.agentRuns = [
      ...(cfg.agentRuns || []),
      { id: runId, name: "J37 linked run", source: { type: "chat" }, status: "done", startedAt: Date.now(), finishedAt: Date.now(), steps: [], variables: {} },
    ];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    const auditPath = path.join(USERDATA, "audit.log.jsonl");
    fs.appendFileSync(auditPath, [
      JSON.stringify({ id: "a_j37_job", at: Date.now() + 1, category: "automation", action: "job-test", target: ids.jobId, actor: "user", detail: "job link fixture" }),
      JSON.stringify({ id: "a_j37_run", at: Date.now() + 2, category: "agent", action: "run-test", target: runId, actor: "user", detail: "run link fixture" }),
      JSON.stringify({ id: "a_j37_profile", at: Date.now() + 3, category: "profile", action: "profile-test", target: ids.profileId, actor: "user", detail: "profile link fixture" }),
      "",
    ].join("\n"));
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("activity"));
    await h.page.locator('[data-activity-action="open-job"]').first().waitFor({ timeout: 5000 });
    await h.page.locator('[data-activity-action="open-run"]').first().waitFor({ timeout: 5000 });
    await h.page.locator('[data-activity-action="open-profile"]').first().waitFor({ timeout: 5000 });

    await h.page.locator('[data-activity-action="open-job"]').first().click();
    await h.page.waitForSelector("#dlg-auto-job[open]", { timeout: 5000 });
    expect(await h.page.locator("#auto-job-detail").innerText()).toContain(ids.jobId);
    await h.page.locator('#dlg-auto-job [data-cmd="close-dialog"]').click();

    await h.page.locator('[data-activity-action="open-run"]').first().click();
    await h.page.waitForSelector("#dlg-agent-run[open]", { timeout: 5000 });
    expect(await h.page.locator("#agent-run-title").innerText()).toBeTruthy();
    await h.page.locator('#dlg-agent-run [data-cmd="close-dialog"]').click();

    await h.page.locator('[data-activity-action="open-profile"]').first().click();
    await h.page.waitForSelector('.profile-card[data-dir-id="' + ids.profileId + '"]', { timeout: 5000 });
    expect(await h.page.locator('.profile-card[data-dir-id="' + ids.profileId + '"]').isVisible()).toBe(true);
  }, 30000);

  it("the category filter narrows the list", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("activity"));
    await h.page.locator("#activity-filter").waitFor({ timeout: 5000 });
    // Filter to proxy → no llm/save entry should render.
    await h.page.locator("#activity-filter").selectOption("proxy");
    await h.page.waitForTimeout(300);
    const proxyHtml = await h.page.locator("#activity-list").innerHTML();
    expect(proxyHtml).not.toContain("openai");
    // Back to all → the entry is visible again.
    await h.page.locator("#activity-filter").selectOption("");
    await h.page.waitForTimeout(300);
    const allHtml = await h.page.locator("#activity-list").innerHTML();
    expect(allHtml).toContain("openai");
  }, 30000);

  it("clear empties the activity list", async () => {
    await h.page.evaluate(() => { (window as any).confirm = () => true; (window as any).agentBrowser.switchTab("activity"); });
    await h.page.locator('#tab-activity [data-cmd="activityClear"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    const html = await h.page.locator("#activity-list").innerHTML();
    expect(html).not.toContain("openai");
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
