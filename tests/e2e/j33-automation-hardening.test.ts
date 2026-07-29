// J33: Automation execution hardening (Slice 1 / quick-win #1). Proves the
// Manual test runs are bounded by JobGuard timeouts/re-entry protection but do
// not poison the production scheduler's failure/cooldown counters.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j33");

const FAR_CRON = "0 0 1 1 *"; // Jan 1 00:00 yearly — never fires during the test

describe("J33 — automation hardening (timeout / failure / cooldown)", () => {
  let h: TestAppHandle;

  beforeAll(async () => { h = await setupTestApp({ userDataDir: USERDATA }); }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  async function createRule(partial: any): Promise<string> {
    const r = await h.page.evaluate((rule: any) => (window as any).cloak.api.automation.create(rule), partial);
    return r.rule.id;
  }
  async function testRun(id: string) {
    return h.page.evaluate((rid: string) => (window as any).cloak.api.automation.testRun(rid), id);
  }
  async function getRule(id: string) {
    const list = await h.page.evaluate(() => (window as any).cloak.api.automation.list());
    return list.find((r: any) => r.id === id);
  }

  it("a failing manual action reports its error without poisoning scheduler state", async () => {
    const id = await createRule({
      name: "j33-fail",
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "throw new Error('fail-j33-sentinel')" },
    });
    const res = await testRun(id);
    expect(res.ok).toBe(false);
    expect(res.result).toContain("fail-j33-sentinel");
    const rule = await getRule(id);
    expect(rule.failureCount ?? 0).toBe(0);
    expect(rule.lastError).toBeUndefined();
  }, 30000);

  it("repeated manual failures do not put scheduled execution into cooldown", async () => {
    const id = await createRule({
      name: "j33-cooldown",
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "throw new Error('cd-fail')" },
    });
    // Production scheduler failures enter cooldown after three attempts, but
    // explicit diagnostics must remain repeatable.
    for (let i = 0; i < 3; i++) await testRun(id);
    const rule = await getRule(id);
    expect(rule.failureCount ?? 0).toBe(0);
    expect(rule.cooldownUntil).toBeUndefined();
  }, 40000);

  it("a slow action is killed by runTimeoutMs with a timeout error", async () => {
    const id = await createRule({
      name: "j33-timeout",
      runTimeoutMs: 200,
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return new Promise(function(r){ setTimeout(r, 30000); })" },
    });
    const start = Date.now();
    const res = await testRun(id);
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    // Killed near the 200ms timeout, not after 30s.
    expect(elapsed, `took ${elapsed}ms, should have timed out near 200ms`).toBeLessThan(10000);
    expect(res.result.toLowerCase()).toMatch(/timed out|timeout/);
    const rule = await getRule(id);
    expect(rule.failureCount ?? 0).toBe(0);
  }, 30000);

  it("a successful manual action also leaves scheduler state untouched", async () => {
    const id = await createRule({
      name: "j33-recover",
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "throw new Error('temp')" },
    });
    await testRun(id); // fail once
    let rule = await getRule(id);
    expect(rule.failureCount ?? 0).toBe(0);
    // Flip the action to succeed.
    await h.page.evaluate(({ rid, cron }) => (window as any).cloak.api.automation.update({
      id: rid, name: "j33-recover", enabled: true,
      trigger: { type: "cron", cron },
      action: { type: "custom-js", jsCode: "return 'ok'" },
    }), { rid: id, cron: FAR_CRON });
    const success = await testRun(id); // succeed
    expect(success.ok).toBe(true);
    expect(success.result).toContain("ok");
    rule = await getRule(id);
    expect(rule.failureCount ?? 0).toBe(0);
    expect(rule.lastResult).toBeUndefined();
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|fail-j33-sentinel|cd-fail|timed out|timeout|temp/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
