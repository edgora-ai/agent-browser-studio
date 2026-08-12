// J34: Credential vault (Slice 2). Local/ad-hoc macOS builds use the
// authenticated file vault, so this proves real at-rest encryption:
//   (1) a saved LLM key is stored encrypted ("v2:…") in config.json — the
//       plaintext never lands on disk;
//   (2) the key still decrypts at use — a chat sends Authorization: Bearer
//       <plaintext> to the (mock) LLM;
//   (3) the save is recorded in the audit log.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j34");
const SECRET = "test-llm-key-j34-sentinel-not-real";

describe("J34 — credential vault: encrypt at rest, decrypt at use, audited", () => {
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

  it("saves the LLM key and it is encrypted at rest in config.json", async () => {
    await h.page.evaluate((args: any) => (window as any).agentBrowser.api.agent.saveLlmConfig(args), {
      provider: "openai", apiKey: SECRET, model: "e2e-mock", apiUrl: mock.url,
    });
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    const stored = cfg.llm?.apiKey;
    expect(stored, "llm.apiKey must be present").toBeTruthy();
    expect(stored.startsWith("v2:"), `must be encrypted, got: ${stored.slice(0, 10)}…`).toBe(true);
    expect(stored).not.toContain(SECRET);
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
  });

  it("decrypts the key at use — the chat sends the plaintext key to the LLM", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
    await h.page.waitForTimeout(150);
    await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
    await h.page.waitForTimeout(150);
    await h.page.locator('[data-cmd="agentNewConv"]').click({ timeout: 5000 });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.agentActiveConvId, { timeout: 5000 });

    await h.page.evaluate(() => {
      (window as any).__done = false;
      (window as any).__err = null;
      const api = (window as any).agentBrowser.api;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      api.on("agent:stream-error", (e: any) => { (window as any).__err = e; });
    });
    await h.page.locator("#agent-chat-input").fill("ping");
    await h.page.locator("#agent-chat-input").press("Enter");
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const st = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
      if (st.d || st.e) break;
      await h.page.waitForTimeout(200);
    }
    const done = await h.page.evaluate(() => ({ d: (window as any).__done, e: (window as any).__err }));
    expect(done.e, `chat failed: ${done.e}`).toBeNull();
    expect(done.d).toBe(true);
    // The mock captured the Authorization header — it must carry the DECRYPTED key.
    const auth = mock.requests[0]?.headers?.authorization || mock.requests[0]?.headers?.Authorization;
    expect(auth, "no Authorization header captured").toBeTruthy();
    expect(auth).toContain(SECRET);
  }, 40000);

  it("the save was recorded in the audit log", async () => {
    const entries = await h.page.evaluate(() => (window as any).agentBrowser.api.audit.list({ category: "llm" }));
    const mine = entries.find((e: any) => e.action === "save");
    expect(mine, "audit must record the llm save").toBeTruthy();
    expect(mine.category).toBe("llm");
    expect(mine.detail).toContain("openai");
  });

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
