// J60: Batch agent task — one automation rule runs the same prompt across
// multiple profiles, one scoped run per profile (system-prompt isolation), with
// N ok / M failed summary and continue-on-error semantics.
//
// Flow:
//   1. Create two profiles, configure the mock LLM.
//   2. Create a batch agent-task rule (action.profileDirIds = [A, B]).
//   3. Test-run: the engine launches each profile and runs the prompt once per
//      profile; the summary is "2 ok / 0 failed".
//   4. Assert each profile's system prompt only advertises its own profile
//      (batch isolation — the model cannot pick the wrong browser).
//   5. A batch containing a bogus profile keeps going and reports "1 ok / 1 failed".
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { startMockLlm, MockLlmServer } from "./helpers/mock-llm.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j60");

function systemPrompt(req: any): string {
  return String((req?.body?.messages || []).find((m: any) => m.role === "system")?.content || "");
}

describe("J60 — batch agent task across multiple profiles", () => {
  let h: TestAppHandle;
  let mock: MockLlmServer;
  let dirId1 = "";
  let dirId2 = "";
  let ruleId = "";

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20 });
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
    try { if (mock) await mock.close(); } catch { /* ignore */ }
  }, 90000);

  it("creates two profiles and configures the mock LLM", async () => {
    const a = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J60 Alpha", platform: "windows", fingerprintSeed: 60101 }));
    const b = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J60 Beta", platform: "windows", fingerprintSeed: 60102 }));
    dirId1 = a.dirId;
    dirId2 = b.dirId;
    expect(dirId1).toBeTruthy();
    expect(dirId2).toBeTruthy();
    expect(dirId1).not.toBe(dirId2);

    await h.page.evaluate((murl: string) => {
      (window as any).agentBrowser.api.agent.saveLlmConfig({ provider: "openai", apiKey: "sk", model: "mock", apiUrl: murl });
    }, mock.url);
  }, 60000);

  it("creates a batch agent-task rule over both profiles", async () => {
    const r = await h.page.evaluate(async (ids: string[]) => {
      return (window as any).agentBrowser.api.automation.create({
        name: "J60 batch check",
        enabled: true,
        trigger: { type: "once", at: Date.now() + 60000 },
        action: { type: "agent-task", profileDirIds: ids, agentPrompt: "check the page and report" },
      });
    }, [dirId1, dirId2]);
    expect(r.success).toBe(true);
    ruleId = r.rule.id;
    expect(r.rule.action.profileDirIds).toEqual([dirId1, dirId2]);
  });

  it("test-run executes one scoped run per profile (2 ok)", async () => {
    const res = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.automation.testRun(id), ruleId);
    expect(res.ok, `result: ${res.result}`).toBe(true);
    expect(res.result).toContain("2 ok");

    // Both profiles were launched by the engine.
    const st1 = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId1);
    const st2 = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId2);
    expect(st1.running).toBe(true);
    expect(st2.running).toBe(true);

    // Two runs, one per profile, each carrying its dirId.
    const runs = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.list());
    const mine = runs.filter((x: any) => x.source && x.source.type === "automation" && x.source.ruleId === ruleId);
    expect(mine.length).toBe(2);
    expect(mine.map((x: any) => x.dirId).sort()).toEqual([dirId1, dirId2].sort());
    expect(mine.every((x: any) => x.status === "done")).toBe(true);
  }, 90000);

  it("each profile's system prompt is scoped to only that profile", async () => {
    expect(mock.requests.length).toBe(2);
    const sysA = systemPrompt(mock.requests[0]);
    const sysB = systemPrompt(mock.requests[1]);
    // First run: only A is running, sees A but not B.
    expect(sysA).toContain(dirId1);
    expect(sysA).not.toContain(dirId2);
    // Second run: BOTH are running by now, but scoping hides A from B's prompt.
    expect(sysB).toContain(dirId2);
    expect(sysB).not.toContain(dirId1);
  });

  it("a batch with a bad profile continues and reports N ok / M failed", async () => {
    const r = await h.page.evaluate(async (ids: string[]) => {
      return (window as any).agentBrowser.api.automation.create({
        name: "J60 partial",
        enabled: true,
        trigger: { type: "once", at: Date.now() + 60000 },
        action: { type: "agent-task", profileDirIds: ids, agentPrompt: "check" },
      });
    }, [dirId1, "profile_does_not_exist_xyz"]);
    expect(r.success).toBe(true);
    const res = await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.automation.testRun(id), r.rule.id);
    // Continue-on-error: the job completes with a summary instead of aborting the batch.
    expect(res.ok, `result: ${res.result}`).toBe(true);
    expect(res.result).toContain("1 ok / 1 failed");
    expect(res.result).toContain("launch failed");
  }, 90000);
});
