// J26: Agent file-access modes (sandbox / allowlist / open). Proves
// resolveAgentFilePath actually gates write_file through the real IPC path,
// driven by the agent loop. sandbox blocks absolute + traversal paths;
// allowlist permits paths inside a trusted dir and blocks the rest; open
// permits an arbitrary absolute path.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j26");
const TRUSTED = fs.mkdtempSync(path.join(os.tmpdir(), "j26-trusted-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "j26-outside-"));

async function configureMock(h: TestAppHandle, mock: { url: string }) {
  await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
  await h.page.waitForTimeout(200);
  await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("config"));
  await h.page.waitForTimeout(200);
  await h.page.locator("#agent-llm-provider").selectOption("openai");
  await h.page.locator("#agent-llm-apikey").fill("sk-mock");
  await h.page.locator("#agent-llm-model").fill("e2e-mock-model");
  await h.page.locator("#agent-llm-url").fill(mock.url);
  await h.page.locator('[data-cmd="agentSaveConfig"]').click({ timeout: 5000 });
  await h.page.waitForSelector("#agent-config-saved", { state: "visible", timeout: 5000 });
}
async function newConversation(h: TestAppHandle) {
  await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
  await h.page.waitForTimeout(200);
  await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
  await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.agentActiveConvId, { timeout: 5000 });
}
async function runSequence(h: TestAppHandle, message: string) {
  await h.page.evaluate(() => {
    (window as any).__done = false;
    (window as any).__err = null;
    const api = (window as any).agentBrowser.api;
    api.on("agent:stream-done", () => { (window as any).__done = true; });
    api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
  });
  await h.page.locator("#agent-chat-input").fill(message);
  await h.page.locator("#agent-chat-input").press("Enter");
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
    if (st.d || st.e) break;
    await h.page.waitForTimeout(200);
  }
}
async function runSteps(h: TestAppHandle) {
  return h.page.evaluate(async () => {
    const api = (window as any).agentBrowser.api;
    const list = await api.agentRuns.list();
    const run = await api.agentRuns.get(list[0].id);
    return run.steps
      .filter((s: any) => s.tool === "write_file")
      .map((s: any) => ({ ok: s.ok, error: s.error || "" }));
  });
}

describe("J26 — file-access modes gate write_file", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20 });
    h = await setupTestApp({ userDataDir: USERDATA });
    await configureMock(h, mock);
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
    try { fs.rmSync(TRUSTED, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch {}
  });

  it("sandbox: relative path allowed, absolute + traversal blocked", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.api.settings.agentFsSet("sandbox", []));
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "s1", name: "write_file", arguments: { path: "sub/ok.txt", content: "hi" } }] },
      { chunks: [], toolCalls: [{ id: "s2", name: "write_file", arguments: { path: "/tmp/j26-sandbox-escape.txt", content: "x" } }] },
      { chunks: [], toolCalls: [{ id: "s3", name: "write_file", arguments: { path: "../escape.txt", content: "x" } }] },
      { chunks: ["done"] },
    ]);
    await newConversation(h);
    await runSequence(h, "写文件");
    const steps = await runSteps(h);
    expect(steps[0].ok, `relative write failed: ${steps[0].error}`).toBe(true);
    expect(steps[1].ok, "absolute path must be blocked in sandbox").toBe(false);
    expect(steps[2].ok, "traversal must be blocked in sandbox").toBe(false);
  }, 40000);

  it("allowlist: inside trusted dir allowed, outside blocked", async () => {
    await h.page.evaluate((dir: string) => (window as any).agentBrowser.api.settings.agentFsSet("allowlist", [dir]), TRUSTED);
    const inside = path.join(TRUSTED, "in.txt");
    const outside = path.join(OUTSIDE, "out.txt");
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "a1", name: "write_file", arguments: { path: inside, content: "hi" } }] },
      { chunks: [], toolCalls: [{ id: "a2", name: "write_file", arguments: { path: outside, content: "x" } }] },
      { chunks: ["done"] },
    ]);
    await newConversation(h);
    await runSequence(h, "写文件");
    const steps = await runSteps(h);
    expect(steps[0].ok, `inside-trusted write failed: ${steps[0].error}`).toBe(true);
    expect(fs.existsSync(inside), "file must exist inside trusted dir").toBe(true);
    expect(steps[1].ok, "outside-trusted path must be blocked").toBe(false);
    expect(fs.existsSync(outside), "no file must be created outside").toBe(false);
  }, 40000);

  it("open: arbitrary absolute path allowed", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.api.settings.agentFsSet("open", []));
    const target = path.join(TRUSTED, "open-mode.txt");
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "o1", name: "write_file", arguments: { path: target, content: "open" } }] },
      { chunks: ["done"] },
    ]);
    await newConversation(h);
    await runSequence(h, "写文件");
    const steps = await runSteps(h);
    expect(steps[0].ok, `open-mode write failed: ${steps[0].error}`).toBe(true);
    expect(fs.existsSync(target), "file must be created in open mode").toBe(true);
    // Restore sandbox for safety.
    await h.page.evaluate(() => (window as any).agentBrowser.api.settings.agentFsSet("sandbox", []));
  }, 40000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|Sandbox mode|Allowlist mode|outside/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
