// J61: batch agent-task concurrency + launch-safety gate toggles.
//
// Part 1 — a batch with concurrency=2 launches two profiles in parallel:
// the first two LLM requests arrive close together (sequential would space them
// by a full extra profile launch), and all three scoped runs complete (3 ok).
//
// Part 2 — the Launch Safety Gates card in the Browser tab persists
// blockOnConsistencyConflict / blockOnFingerprintDrift / blockOnEnvironmentRisk
// to config.json through settings:launch-gates:set.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { startMockLlm, MockLlmServer } from "./helpers/mock-llm.js";
import { shot } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j61");

describe("J61 — batch concurrency + launch safety gates", () => {
  let h: TestAppHandle;
  let mock: MockLlmServer;
  const dirIds: string[] = [];

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 50 });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
    try { if (mock) await mock.close(); } catch { /* ignore */ }
  }, 90000);

  it("creates three profiles and configures the mock LLM", async () => {
    for (let i = 0; i < 3; i++) {
      const p = await h.page.evaluate(async (n: number) => (window as any).agentBrowser.api.browser.create({ name: "J61 P" + n, platform: "windows", fingerprintSeed: 61000 + n }), i);
      dirIds.push(p.dirId);
    }
    expect(dirIds.length).toBe(3);
    expect(new Set(dirIds).size).toBe(3);
    await h.page.evaluate((murl: string) => {
      (window as any).agentBrowser.api.agent.saveLlmConfig({ provider: "openai", apiKey: "sk", model: "mock", apiUrl: murl });
    }, mock.url);
  }, 60000);

  it("a concurrency=2 batch completes 3 scoped runs with parallel launches", async () => {
    const r = await h.page.evaluate(async (ids: string[]) => {
      return (window as any).agentBrowser.api.automation.create({
        name: "J61 parallel",
        enabled: true,
        trigger: { type: "once", at: Date.now() + 60000 },
        action: { type: "agent-task", profileDirIds: ids, concurrency: 2, agentPrompt: "report" },
      });
    }, dirIds);
    expect(r.success).toBe(true);
    expect(r.rule.action.concurrency).toBe(2);

    const before = mock.requests.length;
    const res = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.automation.testRun(id), r.rule.id);
    expect(res.ok, `result: ${res.result}`).toBe(true);
    expect(res.result).toContain("3 ok");

    const reqs = mock.requests.slice(before);
    expect(reqs.length).toBe(3);
    // Parallel (concurrency=2): the first two launches overlap, so requests 0 and 1
    // arrive close together. Sequential would space them by a whole extra launch.
    const gap01 = reqs[1].receivedAt - reqs[0].receivedAt;
    expect(gap01, `req0→req1 gap ${gap01}ms should prove parallel launch`).toBeLessThan(800);

    // All three profiles ended up running and each has its own scoped run.
    for (const d of dirIds) {
      const st = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), d);
      expect(st.running).toBe(true);
    }
    const runs = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    const mine = runs.filter((x: any) => x.source && x.source.type === "automation" && x.source.ruleId === r.rule.id);
    expect(mine.length).toBe(3);
    expect(mine.map((x: any) => x.dirId).sort()).toEqual([...dirIds].sort());
    expect(mine.every((x: any) => x.status === "done")).toBe(true);
    await shot(h.page, "j61-01-batch-concurrency");
  }, 120000);

  it("launch safety gate toggles persist to config", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("browser"));
    await h.page.waitForSelector("#gate-consistency", { timeout: 10000 });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser.api.settings && !!(window as any).agentBrowser.api.settings.launchGates, { timeout: 5000 });
    await h.page.waitForTimeout(400);

    // Set: consistency ON, drift OFF, env-risk ON.
    const gates = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      await api.settings.setLaunchGates({ blockOnConsistencyConflict: true, blockOnFingerprintDrift: false, blockOnEnvironmentRisk: true });
      return api.settings.launchGates();
    });
    expect(gates.blockOnConsistencyConflict).toBe(true);
    expect(gates.blockOnFingerprintDrift).toBe(false);
    expect(gates.blockOnEnvironmentRisk).toBe(true);

    // UI reflects the saved values (loadLaunchGates on tab load).
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    await h.page.waitForTimeout(200);
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("browser"));
    await h.page.waitForSelector("#gate-consistency", { timeout: 10000 });
    await h.page.waitForTimeout(500);
    const ui = await h.page.evaluate(() => ({
      consistency: (document.getElementById("gate-consistency") as HTMLInputElement).checked,
      drift: (document.getElementById("gate-drift") as HTMLInputElement).checked,
      env: (document.getElementById("gate-env-risk") as HTMLInputElement).checked,
    }));
    expect(ui.consistency).toBe(true);
    expect(ui.drift).toBe(false);
    expect(ui.env).toBe(true);

    // Persisted in config.json.
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    expect(cfg.blockOnConsistencyConflict).toBe(true);
    expect(cfg.blockOnFingerprintDrift).toBe(false);
    expect(cfg.blockOnEnvironmentRisk).toBe(true);
    await shot(h.page, "j61-02-launch-gates");
  }, 60000);
});
