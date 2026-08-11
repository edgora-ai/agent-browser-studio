// J8: Agent 真实端到端 — deepseek-v4 驱动工具循环操作真实网页
// 直接走 IPC(不走 UI),证明"代替手工":真实 LLM 决策 → 真实 CDP 工具执行 → 返回正确结果。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j8-real");

describe.skipIf(!process.env.REAL_LLM)("J8 — Agent real LLM drives browser tools", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    const apiKey = process.env.REAL_LLM_API_KEY;
    if (!apiKey) throw new Error("REAL_LLM requires REAL_LLM_API_KEY");
    // Write the real LLM config from environment — never commit live credentials.
    await h.page.evaluate((cfg: any) => (window as any).agentBrowser.api.agent.saveLlmConfig(cfg), {
      provider: "openai",
      apiKey,
      apiUrl: process.env.REAL_LLM_API_URL || "https://api.openai.com/v1/chat/completions",
      model: process.env.REAL_LLM_MODEL || "gpt-4o-mini",
    });
  }, 90000);

  afterAll(async () => {
    if (h) await closeApp(h);
  });

  async function runAgentTask(prompt: string): Promise<{ tools: string[]; text: string; err: string | null }> {
    // launch a profile so the agent has a CDP port (auto-injected into system prompt)
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({ name: "J8 " + Date.now(), platform: "windows", fingerprintSeed: Math.floor(Math.random() * 90000) + 10000 }));
    await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), r.dirId);
    await h.page.waitForTimeout(2000);
    const conv = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.conversations.create());
    return h.page.evaluate(async (args: { convId: string; prompt: string }) => {
      const api = (window as any).agentBrowser.api;
      return new Promise((resolve) => {
        const tools: string[] = [];
        let text = "";
        let err: string | null = null;
        api.on("agent:stream-chunk", (c: any) => { text += (c && c.text) || c || ""; });
        api.on("agent:stream-tool-call", (tc: any) => tools.push(tc.name));
        api.on("agent:stream-error", (e: any) => { err = JSON.stringify(e); resolve({ tools, text, err }); });
        api.on("agent:stream-done", () => resolve({ tools, text, err }));
        api.agent.chatStream(args.convId, args.prompt).catch((e: any) => resolve({ tools, text, err: e.message }));
        setTimeout(() => resolve({ tools, text, err: "timeout" }), 90000);
      });
    }, { convId: conv.id, prompt });
  }

  it("task 1: get current URL (single tool call)", async () => {
    const r = await runAgentTask("Use browser_get_url to tell me the current URL of the running browser. Report the URL.");
    console.log("task1 tools:", r.tools, "err:", r.err);
    expect(r.err).toBeNull();
    expect(r.tools).toContain("browser_get_url");
  }, 120000);

  it("task 2: navigate example.com and report title (multi-step)", async () => {
    const r = await runAgentTask("Navigate the browser to https://example.com using browser_navigate, then use browser_get_title to get the page title, then tell me the title.");
    console.log("task2 tools:", r.tools, "err:", r.err, "text:", r.text.slice(0, 100));
    expect(r.err).toBeNull();
    expect(r.tools).toContain("browser_navigate");
    expect(r.tools).toContain("browser_get_title");
    // The LLM should mention "Example Domain" in its answer
    expect(r.text.toLowerCase()).toContain("example");
  }, 120000);

  it("task 3: extract text from page (snapshot)", async () => {
    const r = await runAgentTask("Navigate to https://example.com and use browser_snapshot to get the page content, then tell me the main heading text.");
    console.log("task3 tools:", r.tools, "err:", r.err);
    expect(r.err).toBeNull();
    expect(r.tools).toContain("browser_snapshot");
  }, 120000);
});
