// J27: Scheduled agent automation — the "save it and run it automatically"
// category. The agent creates a recurring rule (every day 8am: extract 10 tech
// news from Baidu, store to DB). We then prove:
//   (1) the rule is created via the agent's create_automation_rule tool;
//   (2) it is PERSISTED (config.json + automation:list) with the right cron;
//   (3) it EXECUTES through the real automation engine (test-run) — launching
//       the profile, running the agent task, and storing the news to the DB;
//   (4) the execution is recorded as a run trace with source=automation.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j27");

// A "Baidu-like" results page that already lists 10 tech news items.
const TECH_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>科技新闻</title></head><body>
<div id="results">${Array.from({ length: 10 }, (_, i) =>
  `<div class="tech-item"><h3 class="t">科技新闻${i + 1}:AI芯片突破</h3><a class="a" href="https://tech.example.com/${i + 1}">源${i + 1}</a></div>`
).join("")}</div>
</body></html>`;

let server: http.Server;
let port2 = 0;
const url = () => `http://127.0.0.1:${port2}/`;

// 10 rows inserted via a single multi-VALUES statement.
const ITEMS = Array.from({ length: 10 }, (_, i) => ({ title: `科技新闻${i + 1}`, url: `https://tech.example.com/${i + 1}` }));
const INSERT_SQL = `INSERT INTO tech_news (title, url) VALUES ${ITEMS.map(() => "(?,?)").join(",")}`;
const INSERT_PARAMS = ITEMS.flatMap((it) => [it.title, it.url]);

const RULE_NAME = "每日8点科技新闻";
const PROMPT = "打开百度搜索科技新闻，提取前10条，存入tech_news表";

describe("J27 — scheduled agent automation: save + auto-execute", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let dirId = "";
  let cdpPort = 0;
  let ruleId = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(TECH_HTML); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port2 = (server.address() as any).port;
    mock = await startMockLlm({ delayMs: 20 });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    // App first so the browser's keep-alive connections drop.
    if (h) await closeApp(h);
    try { if (mock) await mock.close(); } catch {}
    try {
      if (server) await Promise.race([
        new Promise<void>((r) => server.close(() => r())),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch {}
  }, 90000);

  it("launches a profile + configures the mock LLM", async () => {
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J27", platform: "windows", fingerprintSeed: 27272 }));
    dirId = r.dirId;
    await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), dirId);
    cdpPort = (await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId)).cdpPort;

    await h.page.evaluate((murl: string) => {
      (window as any).agentBrowser.api.agent.saveLlmConfig({ provider: "openai", apiKey: "sk", model: "mock", apiUrl: murl });
    }, mock.url);
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
    await h.page.waitForTimeout(150);
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(150);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.agentActiveConvId, { timeout: 5000 });
  }, 60000);

  it("the agent creates the scheduled rule via create_automation_rule", async () => {
    mock.setResponses([
      {
        chunks: [],
        toolCalls: [{
          id: "r1",
          name: "create_automation_rule",
          arguments: {
            name: RULE_NAME,
            trigger: { type: "cron", cron: "0 8 * * *" },
            action: { type: "agent-task", profileDirId: dirId, agentPrompt: PROMPT },
            enabled: true,
          },
        }],
      },
      { chunks: ["已", "创建", "定时任务。"] },
    ]);
    await h.page.evaluate(() => {
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
    });
    await h.page.locator("#agent-chat-input").fill("帮我创建一个每天8点的科技新闻采集任务");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 25000) {
      const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
      if (st.d || st.e) break;
      await h.page.waitForTimeout(200);
    }
    const done = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
    expect(done.e, `error: ${done.e}`).toBeNull();
    expect(done.d).toBe(true);
    // The rule now exists.
    const rules = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.list());
    const rule = rules.find((x: any) => x.name === RULE_NAME);
    expect(rule, "rule must be created").toBeTruthy();
    ruleId = rule.id;
  }, 40000);

  it("the rule is persisted to config with the correct cron + agent-task action", async () => {
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    const rule = (cfg.automation || []).find((x: any) => x.name === RULE_NAME);
    expect(rule, "rule must be in config.json").toBeTruthy();
    expect(rule.trigger.type).toBe("cron");
    expect(rule.trigger.cron).toBe("0 8 * * *");   // every day 8am
    expect(rule.action.type).toBe("agent-task");
    expect(rule.action.profileDirId).toBe(dirId);
    expect(rule.action.agentPrompt).toContain("科技新闻");
    expect(rule.enabled).toBe(true);
  });

  it("test-running the rule executes the agent task and stores 10 news rows", async () => {
    // Script the execution's tool sequence now that cdpPort is known.
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "e1", name: "browser_navigate", arguments: { port: cdpPort, url: url() } }] },
      { chunks: [], toolCalls: [{ id: "e2", name: "browser_evaluate", arguments: { port: cdpPort, expression: "[...document.querySelectorAll('.tech-item')].map(e=>({title:e.querySelector('.t').textContent,url:e.querySelector('.a').href}))" } }] },
      { chunks: [], toolCalls: [{ id: "e3", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS tech_news (id INTEGER PRIMARY KEY, title TEXT, url TEXT)" } }] },
      { chunks: [], toolCalls: [{ id: "e4", name: "db_exec", arguments: { sql: INSERT_SQL, params: INSERT_PARAMS } }] },
      { chunks: ["已", "存入", "10条", "科技新闻。"] },
    ]);
    // Trigger the rule manually (don't wait for 8am).
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.automation.testRun(id), ruleId);
    expect(res.ok, `test-run failed: ${res.result}`).toBe(true);
    expect(res.result).toContain("run ");

    // The execution produced a run trace sourced from automation.
    const run = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const list = await api.agentRuns.list();
      const summary = list.find((r: any) => r.source?.type === "automation");
      return summary ? await api.agentRuns.get(summary.id) : null;
    });
    expect(run, "automation run must exist").toBeTruthy();
    expect(run.source.type).toBe("automation");
    expect(run.source.ruleId).toBe(ruleId);
    expect(run.source.ruleName).toBe(RULE_NAME);
    expect(run.source.jobId).toMatch(/^job_/);
    expect(run.status).toBe("done");

    const jobs = await h.page.evaluate((rid: string) => (window as any).agentBrowser.api.automation.jobs({ ruleId: rid, source: "test" }), ruleId);
    const job = jobs.find((j: any) => j.id === run.source.jobId);
    expect(job, "linked automation job must exist").toBeTruthy();
    expect(job.runId).toBe(run.id);

    const tools = run.steps.map((s: any) => s.tool);
    expect(tools).toContain("browser_navigate");
    expect(tools).toContain("browser_evaluate");
    expect(tools).toContain("db_exec");

    // All 10 news rows landed.
    const stored = await h.page.evaluate(async () => {
      const r = await (window as any).agentBrowser.api.agentDb.query("SELECT COUNT(*) AS c FROM tech_news");
      return r.rows[0].c;
    });
    expect(stored).toBe(10);
  }, 60000);

  it("the automation run log recorded the execution", async () => {
    const logs = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.logs());
    const mine = logs.find((l: any) => l.ruleId === ruleId);
    expect(mine, "run log must exist for the rule").toBeTruthy();
    expect(mine.ok).toBe(true);
  });

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
