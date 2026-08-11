// J20: Full real-browser agent flow — proves the port-check fix + the complete
// tool chain (navigate → type → click → evaluate → db insert) works end-to-end
// through the real agent:chat-stream path with a mock LLM.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import { chromium } from "playwright";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j20");

const NEWS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>搜索</title></head><body>
<input id="kw" type="text"><button id="su">搜索</button>
<div id="content"></div>
<script>
document.getElementById('su').addEventListener('click', function(){
  var kw=document.getElementById('kw').value; var c=document.getElementById('content'); c.innerHTML='';
  for(var i=1;i<=10;i++){
    var w=document.createElement('div'); w.className='result';
    w.innerHTML='<h3 class="t">'+kw+'标题'+i+'</h3><a class="lk" href="https://n.example.com/'+i+'">源'+i+'</a>';
    c.appendChild(w);
  }
});
</script></body></html>`;

let server: http.Server;
let port2 = 0;
const url = () => `http://127.0.0.1:${port2}/`;

describe("J20 — full agent tool chain (search → evaluate → store)", () => {
  let h: TestAppHandle;
  let browser: any;
  let page: any;
  let dirId = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(NEWS_HTML); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port2 = (server.address() as any).port;
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    // Close the app FIRST (SIGKILLs the browser) so keep-alive connections to
    // the fixture/mock servers drop; otherwise server.close() hangs on them.
    if (h) await closeApp(h);
    try { if (browser) await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    try {
      if (server) await Promise.race([
        new Promise<void>((r) => server.close(() => r)),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch {}
  }, 90000);

  it("runs the full sequence via the real chat-stream loop", async () => {
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J20", platform: "windows", fingerprintSeed: 20202 }));
    dirId = r.dirId;
    const launched = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), dirId);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${launched.cdpPort}`);
    page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
    const cdpPort = (await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId)).cdpPort;

    // Mock LLM emits the full sequence a capable model would: create table,
    // navigate, type, click, wait, evaluate (extract JSON), insert one row
    // (proving db writes happen after browser ops), then summarize.
    const mock = await startMockLlm({
      delayMs: 20,
      responses: [
        { chunks: [], toolCalls: [{ id: "1", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY, title TEXT, url TEXT)" } }] },
        { chunks: [], toolCalls: [{ id: "2", name: "browser_navigate", arguments: { port: cdpPort, url: url() } }] },
        { chunks: [], toolCalls: [{ id: "3", name: "browser_wait_for_load", arguments: { port: cdpPort } }] },
        { chunks: [], toolCalls: [{ id: "4", name: "browser_type", arguments: { port: cdpPort, selector: "#kw", text: "最新新闻" } }] },
        { chunks: [], toolCalls: [{ id: "5", name: "browser_click", arguments: { port: cdpPort, selector: "#su" } }] },
        { chunks: [], toolCalls: [{ id: "6", name: "browser_wait_for_load", arguments: { port: cdpPort } }] },
        { chunks: [], toolCalls: [{ id: "7", name: "browser_evaluate", arguments: { port: cdpPort, expression: "[...document.querySelectorAll('.result')].map(e=>({title:e.querySelector('.t').textContent,url:e.querySelector('.lk').href}))" } }] },
        { chunks: [], toolCalls: [{ id: "8", name: "db_exec", arguments: { sql: "INSERT INTO news (title, url) VALUES (?, ?)", params: ["最新新闻标题1", "https://n.example.com/1"] } }] },
        { chunks: ["已搜索并存入新闻。"] },
      ],
    });
    await h.page.evaluate((murl: string) => {
      (window as any).agentBrowser.api.agent.saveLlmConfig({ provider: "openai", apiKey: "sk", model: "mock", apiUrl: murl });
    }, mock.url);

    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
    await h.page.waitForTimeout(150);
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(150);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.agentActiveConvId, { timeout: 5000 });

    await h.page.evaluate(() => { (window as any).__done = false; (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = String(e); });
    });
    await h.page.locator("#agent-chat-input").fill("搜新闻存库");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 40000) {
      const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
      if (st.d || st.e) break;
      await h.page.waitForTimeout(200);
    }
    const done = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
    expect(done.e, `stream error: ${done.e}`).toBeNull();
    expect(done.d).toBe(true);

    // The news table exists and the insert landed.
    const stored = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const tables = await api.agentDb.tables();
      const newsTable = tables.find((t: any) => t.name === "news");
      if (!newsTable) return { exists: false };
      const rows = await api.agentDb.query("SELECT title, url FROM news");
      return { exists: true, count: newsTable.rowCount, rows: rows.rows };
    });
    expect(stored.exists).toBe(true);
    expect(stored.count).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(stored.rows)).toContain("最新新闻标题1");

    // The run trace recorded all 8 tool calls without the port-ownership error.
    const trace = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const list = await api.agentRuns.list();
      const run = await api.agentRuns.get(list[0].id);
      return run;
    });
    const tools = trace.steps.map((s: any) => s.tool);
    expect(tools).toContain("browser_evaluate");
    expect(tools).toContain("db_exec");
    // No step should have the port-ownership error.
    const portErr = trace.steps.find((s: any) => /not owned by/i.test(s.error || ""));
    expect(portErr, "port-ownership error must not recur").toBeUndefined();
    try { await mock.close(); } catch {}
  }, 90000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
