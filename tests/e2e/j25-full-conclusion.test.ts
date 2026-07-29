// J25: Full real-browser task that finishes "done" WITH a conclusion — the
// user's complaint was "执行完了没有结论". This drives the complete chain
// (create → navigate → type → click → evaluate → set_var → get_var → insert
// → final summary) through the real chat-stream loop and asserts the run
// status is "done", the assistant emitted a non-empty conclusion, and the
// variable round-trips through the run.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j25");

const NEWS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>搜索</title></head><body>
<input id="kw" type="text"><button id="su">搜索</button>
<div id="content"></div>
<script>
document.getElementById('su').addEventListener('click', function(){
  var kw=document.getElementById('kw').value; var c=document.getElementById('content'); c.innerHTML='';
  for(var i=1;i<=5;i++){
    var w=document.createElement('div'); w.className='result';
    w.innerHTML='<h3 class="t">'+kw+'第'+i+'条</h3><a class="lk" href="https://n.example.com/'+i+'">link'+i+'</a>';
    c.appendChild(w);
  }
});
</script></body></html>`;

let server: http.Server;
let port2 = 0;
const url = () => `http://127.0.0.1:${port2}/`;

describe("J25 — full task finishes done with a conclusion", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let dirId = "";
  let cdpPort = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(NEWS_HTML); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port2 = (server.address() as any).port;
    mock = await startMockLlm({ delayMs: 20 });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    // Close the app FIRST (SIGKILLs the browser) so the keep-alive connections
    // it holds to the fixture + mock servers drop; otherwise server.close()
    // waits forever for them to drain and the hook times out.
    if (h) await closeApp(h);
    try { if (mock) await mock.close(); } catch {}
    try {
      if (server) await Promise.race([
        new Promise<void>((r) => server.close(() => r)),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch {}
  }, 90000);

  it("launches a profile + configures the mock", async () => {
    const r = await h.page.evaluate(async () => (window as any).cloak.api.cloak.create({ name: "J25", platform: "windows", fingerprintSeed: 25025 }));
    dirId = r.dirId;
    await h.page.evaluate((id: string) => (window as any).cloak.api.cloak.launch(id), dirId);
    cdpPort = (await h.page.evaluate((id: string) => (window as any).cloak.api.cloak.status(id), dirId)).cdpPort;

    // Configure mock LLM.
    await h.page.evaluate((murl: string) => {
      (window as any).cloak.api.agent.saveLlmConfig({ provider: "openai", apiKey: "sk", model: "mock", apiUrl: murl });
    }, mock.url);
    await h.page.evaluate(() => (window as any).cloak.switchTab("agent"));
    await h.page.waitForTimeout(150);
    await h.page.evaluate(() => (window as any).cloak.switchAgentSub("chat"));
    await h.page.waitForTimeout(150);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForFunction(() => !!(window as any).cloak.state.agentActiveConvId, { timeout: 5000 });
  }, 60000);

  it("runs the full chain and ends with a conclusion", async () => {
    // Build the scripted tool sequence now that cdpPort is known.
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "1", name: "db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY, title TEXT, url TEXT)" } }] },
      { chunks: [], toolCalls: [{ id: "2", name: "browser_navigate", arguments: { port: cdpPort, url: url() } }] },
      { chunks: [], toolCalls: [{ id: "3", name: "browser_type", arguments: { port: cdpPort, selector: "#kw", text: "最新新闻" } }] },
      { chunks: [], toolCalls: [{ id: "4", name: "browser_click", arguments: { port: cdpPort, selector: "#su" } }] },
      { chunks: [], toolCalls: [{ id: "5", name: "browser_evaluate", arguments: { port: cdpPort, expression: "[...document.querySelectorAll('.result')].map(e=>({title:e.querySelector('.t').textContent,url:e.querySelector('.lk').href}))" } }] },
      { chunks: [], toolCalls: [{ id: "6", name: "set_var", arguments: { key: "last_query", value: "最新新闻" } }] },
      { chunks: [], toolCalls: [{ id: "7", name: "get_var", arguments: { key: "last_query" } }] },
      { chunks: [], toolCalls: [{ id: "8", name: "db_exec", arguments: { sql: "INSERT INTO news (title, url) VALUES (?, ?)", params: ["最新新闻第1条", "https://n.example.com/1"] } }] },
      { chunks: ["已", "搜索", "并存入", "最新新闻", "。"] },
    ]);

    await h.page.evaluate(() => {
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).cloak.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
    });
    await h.page.locator("#agent-chat-input").fill("搜新闻存库");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 45000) {
      const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
      if (st.d || st.e) break;
      await h.page.waitForTimeout(200);
    }
    const done = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
    expect(done.e, `stream error: ${done.e}`).toBeNull();
    expect(done.d).toBe(true);
  }, 90000);

  it("the run is done, has a conclusion, the variable round-tripped, and news was stored", async () => {
    const run = await h.page.evaluate(async () => {
      const api = (window as any).cloak.api;
      const list = await api.agentRuns.list();
      return api.agentRuns.get(list[0].id);
    });
    expect(run.status, "run must finish done, not error").toBe("done");
    const tools = run.steps.map((s: any) => s.tool);
    expect(tools).toContain("browser_evaluate");
    expect(tools).toContain("set_var");
    expect(tools).toContain("get_var");
    // The raw value round-tripped internally, while public run traces retain
    // only byte-length markers so variables cannot leak through IPC/history.
    expect(run.variables.last_query).toBe("[REDACTED:12B]");
    const gv = run.steps.find((s: any) => s.tool === "get_var");
    expect(JSON.stringify(gv.result)).toContain("[REDACTED_VALUE:12B]");
    expect(JSON.stringify(gv.result)).not.toContain("最新新闻");
    // News row landed.
    const stored = await h.page.evaluate(async () => {
      const r = await (window as any).cloak.api.agentDb.query("SELECT title FROM news");
      return r.rows;
    });
    expect(JSON.stringify(stored)).toContain("最新新闻第1条");
    // The assistant bubble shows a conclusion (not an error / not empty).
    const bubble = await h.page.evaluate(() => {
      const nodes = document.querySelectorAll(".chat-bubble-agent");
      return nodes.length ? nodes[nodes.length - 1].textContent : "";
    });
    expect(bubble.length).toBeGreaterThan(0);
    expect(bubble).not.toContain("[object Object]");
    expect(bubble.startsWith("❌")).toBe(false);
  });

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
