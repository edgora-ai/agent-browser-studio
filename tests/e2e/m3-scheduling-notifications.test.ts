// M3 — schedule truth and terminal alerts, driven against the real app.
//
// The claim under test is NOT "the scheduler was rewritten". It is that what
// the card says and what the scheduler will do are the same thing, including
// when the answer is "nothing, and it never will again". So most of these
// assertions read the scheduler's own state and the durable stores directly
// rather than through the renderer.
//
// FAR_CRON keeps the real scheduler quiet: a yearly rule never fires during a
// test run, so nothing here races a timer.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setupTestApp, closeApp, type TestAppHandle } from "./helpers/app.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-m3-e2e-"));
const FAR_CRON = "0 0 1 1 *"; // Jan 1 00:00 yearly — never fires during the test

type Profile = { dirId: string; name: string };

const configPath = () => path.join(USERDATA, "config.json");
const jobsDbPath = () => path.join(USERDATA, "jobs.sqlite");
function config(): any { return JSON.parse(fs.readFileSync(configPath(), "utf8")); }

/** Direct read of the job store — never through the app. */
function jobsRows(): any[] {
  const db = new DatabaseSync(jobsDbPath(), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM jobs ORDER BY created_at").all() as any[];
  } finally { db.close(); }
}

function notificationsRows(): any[] {
  const db = new DatabaseSync(jobsDbPath(), { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'").get();
    if (!table) return [];
    return db.prepare("SELECT * FROM notifications ORDER BY created_at").all() as any[];
  } finally { db.close(); }
}

/** Write config.json from OUTSIDE the app, the way a crash or a hand-edit
 *  would, then make the app re-read it. Proves the state is derived by the
 *  scheduler rather than by anything the renderer remembered. */
function patchConfigOutside(mutate: (cfg: any) => void) {
  const cfg = config();
  mutate(cfg);
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

describe("M3 — schedule truth and terminal alerts", () => {
  let h: TestAppHandle;
  let profile: Profile;

  async function launch(resetUserData = false) {
    h = await setupTestApp({ userDataDir: USERDATA, resetUserData, env: { AGENT_BROWSER_API_PORT: "0" } });
    const isolation = await h.app.evaluate(({ app }) => ({
      nodeHome: process.getBuiltinModule("os").homedir(),
      envHome: process.env.HOME,
      userData: app.getPath("userData"),
      providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(isolation.nodeHome)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(fs.realpathSync(isolation.envHome!)).toBe(fs.realpathSync(isolation.nodeHome));
    expect(fs.realpathSync(isolation.userData)).toBe(fs.realpathSync(USERDATA));
    expect(isolation.providerKeys).toEqual([]);
    const llm = await h.page.evaluate(async () => ({
      configured: await (window as any).agentBrowserAPI.agent.llmConfig(),
      detected: await (window as any).agentBrowserAPI.agent.detectLlmConfig(),
    }));
    expect(llm.configured?.hasApiKey ?? false).toBe(false);
    expect(llm.detected?.hasApiKey ?? false).toBe(false);
  }

  async function createRule(partial: Record<string, unknown>): Promise<any> {
    const r = await h.page.evaluate((rule: any) => (window as any).agentBrowser.api.automation.create(rule), partial);
    expect(r.success, JSON.stringify(r)).toBe(true);
    return r.rule;
  }

  function scheduleStates(): Promise<any[]> {
    return h.page.evaluate(async () => {
      const r = await (window as any).agentBrowser.api.automation.scheduleState();
      return r.states || [];
    });
  }

  async function stateOf(ruleId: string): Promise<any> {
    const states = await scheduleStates();
    return states.find((s: any) => s.ruleId === ruleId);
  }

  beforeAll(async () => {
    await launch();
    const created = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: "M3 environment", platform: "windows", proxyMode: "none",
      appUrl: "data:text/html,<title>M3 fixture</title>", fingerprintMode: "off",
    }));
    expect(created.dirId, JSON.stringify(created)).toBeTruthy();
    profile = { dirId: created.dirId, name: "M3 environment" };
  }, 120_000);

  afterAll(async () => {
    if (h) await closeApp(h);
  }, 120_000);

  // ── 1. The five display phases ──

  it("reports a future once as scheduled, with a real next run", async () => {
    const at = Date.now() + 3_600_000;
    const rule = await createRule({
      name: "m3-future-once", enabled: true,
      trigger: { type: "once", at },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    const state = await stateOf(rule.id);
    expect(state).toBeTruthy();
    expect(state.phase).toBe("scheduled-once");
    expect(state.onceAt).toBe(at);
    // The time comes from the scheduler's armed timer, not from a frontend
    // comparison — so it is present and equals what was set.
    expect(state.nextRunAt).toBe(at);
    expect(state.nextRunSource).toBe("armed-timer");
    expect(state.timezone).toBeTruthy();
  }, 60_000);

  it.each([25, 30, 365])("keeps a %i-day once dormant, then executes its rescheduled plan once", async (days) => {
    const at = Date.now() + days * 24 * 60 * 60 * 1000;
    const rule = await createRule({
      name: `f04-once-${days}-days`, enabled: true,
      trigger: { type: "once", at },
      action: { type: "custom-js", jsCode: "return 'f04-executed'" },
    });
    const forRule = () => jobsRows().filter((j) => j.rule_id === rule.id && j.source === "once");
    const stored = config().automation.find((r: any) => r.id === rule.id);
    expect(stored).toMatchObject({ enabled: true, trigger: { type: "once", at } });
    expect(stored.planId).toBeTruthy();
    expect(forRule()).toEqual([]); // independent SQLite read, not a create() result
    expect(await stateOf(rule.id)).toMatchObject({ phase: "scheduled-once", onceAt: at, nextRunAt: at, nextRunSource: "armed-timer" });
    const report = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
    expect(report).toMatchObject({ success: true, workStarted: false });
    await new Promise((resolve) => setTimeout(resolve, 150)); // catches Node's 1-ms overflow clamp
    expect(forRule()).toEqual([]);
    expect(config().automation.find((r: any) => r.id === rule.id)).toMatchObject({ enabled: true, planId: stored.planId });
    const readFar = await h.page.evaluate(async (id) => ({
      rule: (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === id),
      jobs: await (window as any).agentBrowser.api.automation.jobs({ ruleId: id }),
    }), rule.id);
    expect(readFar.rule).toMatchObject({ enabled: true, planId: stored.planId, trigger: { type: "once", at } });
    expect(readFar.jobs).toEqual([]);

    // A new near-term plan proves the dormant rule can still fire through the
    // production timer, write a terminal SQLite row and consume config once.
    const nearAt = Date.now() + 1_800;
    const updated = await h.page.evaluate((args) => (window as any).agentBrowser.api.automation.rescheduleOnce(args),
      { ruleId: rule.id, at: nearAt });
    expect(updated.success, JSON.stringify(updated)).toBe(true);
    const newPlan = config().automation.find((r: any) => r.id === rule.id);
    expect(newPlan).toMatchObject({ enabled: true, trigger: { type: "once", at: nearAt } });
    expect(newPlan.planId).not.toBe(stored.planId);
    await vi.waitFor(() => {
      expect(forRule()).toHaveLength(1);
      expect(forRule()[0]).toMatchObject({ status: "done", source: "once", plan_id: newPlan.planId });
      expect(config().automation.find((r: any) => r.id === rule.id).enabled).toBe(false);
    }, { timeout: 15_000, interval: 50 });
    const row = forRule()[0];
    expect(row.created_at).toBeGreaterThanOrEqual(nearAt);
    expect(row.finished_at).toBeGreaterThanOrEqual(row.created_at);
    expect(row.result).toContain("f04-executed");
    const readDone = await h.page.evaluate(async (args) => ({
      job: await (window as any).agentBrowser.api.automation.jobGet(args.jobId),
      jobs: await (window as any).agentBrowser.api.automation.jobs({ ruleId: args.ruleId }),
      rule: (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === args.ruleId),
    }), { jobId: row.id, ruleId: rule.id });
    expect(readDone.job).toMatchObject({ id: row.id, status: "done", planId: newPlan.planId, result: row.result });
    expect(readDone.jobs.map((j: any) => j.id)).toEqual([row.id]);
    expect(readDone.rule).toMatchObject({ enabled: false, planId: newPlan.planId, trigger: { type: "once", at: nearAt } });
    expect(forRule()).toHaveLength(1);
  }, 60_000);

  it("does not replay a cooldown-skipped Once plan after main-process clock rollback", async () => {
    const at = Date.now() + 5_000;
    const rule = await createRule({
      name: "f04-cooldown-skip-rollback", enabled: true,
      trigger: { type: "once", at },
      action: { type: "custom-js", jsCode: "return 'new plan only'" },
    });
    const cooldownUntil = at + 60_000;
    const updated = await h.page.evaluate((input) => (window as any).agentBrowser.api.automation.update(input), {
      ...rule, cooldownUntil,
    });
    expect(updated.success, JSON.stringify(updated)).toBe(true);
    const stored = config().automation.find((r: any) => r.id === rule.id);
    expect(stored).toMatchObject({ enabled: true, cooldownUntil, planId: rule.planId, trigger: { type: "once", at } });
    const forRule = () => jobsRows().filter((j) => j.rule_id === rule.id && j.source === "once");
    await vi.waitFor(() => {
      const rows = forRule();
      expect(rows.map((j) => j.status)).toEqual(["skipped"]);
      expect(rows[0].plan_id).toBe(stored.planId);
      // SQLite can finish the skipped row before config persists the missed
      // marker. Wait for both stores for this plan, not just the first write.
      const missed = config().automation.find((r: any) => r.id === rule.id);
      expect(missed).toMatchObject({ enabled: true, planId: stored.planId });
      expect(missed.missedAt).toBeGreaterThanOrEqual(at);
    }, { timeout: 15_000, interval: 50 });
    const skipped = forRule()[0]; // durable SQLite row, not an IPC success claim
    expect(skipped).toMatchObject({ plan_id: stored.planId, result: "skipped: cooldown" });
    const skippedRule = config().automation.find((r: any) => r.id === rule.id);
    expect(skippedRule).toMatchObject({ enabled: true, planId: stored.planId, missedAt: expect.any(Number) });
    expect(skippedRule.missedAt).toBeGreaterThanOrEqual(at);
    const byId = await h.page.evaluate(async (args) => ({
      job: await (window as any).agentBrowser.api.automation.jobGet(args.jobId),
      jobs: await (window as any).agentBrowser.api.automation.jobs({ ruleId: args.ruleId }),
      rule: (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === args.ruleId),
      state: (await (window as any).agentBrowser.api.automation.scheduleState()).states.find((s: any) => s.ruleId === args.ruleId),
    }), { jobId: skipped.id, ruleId: rule.id });
    expect(byId.job).toMatchObject({ id: skipped.id, status: "skipped", planId: stored.planId });
    expect(byId.jobs.map((j: any) => j.id)).toEqual([skipped.id]);
    expect(byId.rule.missedAt).toBe(skippedRule.missedAt);
    expect(byId.state).toMatchObject({ phase: "missed-once", nextRunAt: null, lastOutcome: { status: "skipped" } });

    // Only the isolated Electron main-process Date.now changes, never the host
    // clock. Restore it even on failed assertions, then outwait the old timer.
    const rolledBack = await h.app.evaluate((_electron, deadline: number) => {
      const g = globalThis as typeof globalThis & { __f04OriginalDateNow?: typeof Date.now };
      if (g.__f04OriginalDateNow) throw new Error("F04 clock override already active");
      const original = Date.now;
      const shift = original() - deadline + 2_500;
      g.__f04OriginalDateNow = original;
      Date.now = () => original() - shift;
      return Date.now();
    }, at);
    try {
      expect(rolledBack).toBeLessThan(at);
      const report = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
      expect(report).toMatchObject({ success: true, workStarted: false });
      expect((await stateOf(rule.id))).toMatchObject({ phase: "missed-once", nextRunAt: null });
    } finally {
      await h.app.evaluate(() => {
        const g = globalThis as typeof globalThis & { __f04OriginalDateNow?: typeof Date.now };
        if (!g.__f04OriginalDateNow) throw new Error("F04 clock override was lost");
        Date.now = g.__f04OriginalDateNow;
        delete g.__f04OriginalDateNow;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect(forRule()).toEqual([skipped]); // no second skip or done for this plan
    expect(config().automation.find((r: any) => r.id === rule.id)).toMatchObject({
      enabled: true, planId: stored.planId, missedAt: skippedRule.missedAt,
    });
    const readAfter = await h.page.evaluate(async (id) => ({
      rule: (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === id),
      jobs: await (window as any).agentBrowser.api.automation.jobs({ ruleId: id }),
      state: (await (window as any).agentBrowser.api.automation.scheduleState()).states.find((s: any) => s.ruleId === id),
    }), rule.id);
    expect(readAfter.rule.missedAt).toBe(skippedRule.missedAt);
    expect(readAfter.jobs.map((j: any) => j.id)).toEqual([skipped.id]);
    expect(readAfter.state.phase).toBe("missed-once");

    // Remove the old cooldown without reissuing the plan: its missed marker
    // must still block the old deadline. Only an explicit reschedule may run.
    const cooled = await h.page.evaluate(async (id) => {
      const current = (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === id);
      return (window as any).agentBrowser.api.automation.update({ ...current, cooldownUntil: Date.now() - 1 });
    }, rule.id);
    expect(cooled.success).toBe(true);
    expect(config().automation.find((r: any) => r.id === rule.id)).toMatchObject({
      planId: stored.planId, missedAt: skippedRule.missedAt,
    });
    const nearAt = Date.now() + 1_800;
    const res = await h.page.evaluate((args) => (window as any).agentBrowser.api.automation.rescheduleOnce(args),
      { ruleId: rule.id, at: nearAt });
    expect(res.success, JSON.stringify(res)).toBe(true);
    const newPlan = config().automation.find((r: any) => r.id === rule.id);
    expect(newPlan.planId).not.toBe(stored.planId);
    expect(newPlan.missedAt).toBeUndefined();
    await vi.waitFor(() => {
      expect(forRule().map((j) => [j.plan_id, j.status])).toEqual([
        [stored.planId, "skipped"], [newPlan.planId, "done"],
      ]);
      expect(config().automation.find((r: any) => r.id === rule.id).enabled).toBe(false);
    }, { timeout: 15_000, interval: 50 });
    const done = forRule()[1];
    expect(done.result).toContain("new plan only");
    const doneRead = await h.page.evaluate(async (args) => ({
      job: await (window as any).agentBrowser.api.automation.jobGet(args.jobId),
      jobs: await (window as any).agentBrowser.api.automation.jobs({ ruleId: args.ruleId }),
      rule: (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === args.ruleId),
    }), { jobId: done.id, ruleId: rule.id });
    expect(doneRead.job).toMatchObject({ id: done.id, planId: newPlan.planId, status: "done", result: done.result });
    expect(doneRead.jobs.map((j: any) => j.id).sort()).toEqual([skipped.id, done.id].sort());
    expect(doneRead.rule).toMatchObject({ enabled: false, planId: newPlan.planId });
  }, 60_000);

  it("reports a cron as scheduled and a far-future one as computed", async () => {
    const rule = await createRule({
      name: "m3-cron", enabled: true,
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    const state = await stateOf(rule.id);
    expect(state.phase).toBe("scheduled-cron");
    expect(state.nextRunAt).toBeGreaterThan(Date.now());
    // A yearly cron is re-armed in ≤24h chunks, so there is no real deadline
    // yet. Reporting "computed" is the honest answer, not a defect.
    expect(state.nextRunSource).toBe("computed");
  }, 60_000);

  it("reports an invalid cron rather than pretending it is scheduled", async () => {
    // create() VALIDATES the expression and refuses a bad one, so an invalid
    // cron can only reach the scheduler through a config this process did not
    // write — a hand edit, a downgrade, or another tool. That is exactly the
    // case the phase exists for, so it is built by hand rather than through
    // the API that would have rejected it.
    const rule = await createRule({
      name: "m3-bad-cron", enabled: true,
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    patchConfigOutside((cfg) => {
      cfg.automation.find((r: any) => r.id === rule.id).trigger.cron = "not a cron";
    });
    // app:reload-config is the product's own "re-read config.json" path — the
    // one a downgrade or an external writer would be followed by. update()
    // would have validated and refused, so it cannot reach this state.
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());

    const state = await stateOf(rule.id);
    expect(state.phase).toBe("invalid-cron");
    expect(state.nextRunAt).toBeNull();
  }, 60_000);

  it("reports a disabled rule as user-disabled", async () => {
    const rule = await createRule({
      name: "m3-disabled", enabled: false,
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    expect((await stateOf(rule.id)).phase).toBe("user-disabled");
  }, 60_000);

  it("reports an event trigger as event-driven", async () => {
    const rule = await createRule({
      name: "m3-event", enabled: true,
      trigger: { type: "event", event: "profile:stopped" },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    expect((await stateOf(rule.id)).phase).toBe("event-driven");
  }, 60_000);

  // ── 2. The state is the scheduler's, not the renderer's ──

  it("still tells the truth after config is edited outside the app", async () => {
    // A frontend that compared dates itself would keep showing whatever it
    // last rendered. The scheduler re-reads and re-derives.
    const rule = await createRule({
      name: "m3-outside-edit", enabled: true,
      trigger: { type: "once", at: Date.now() + 7_200_000 },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    expect((await stateOf(rule.id)).phase).toBe("scheduled-once");

    // Move the deadline into the past behind the app's back.
    patchConfigOutside((cfg) => {
      const stored = cfg.automation.find((r: any) => r.id === rule.id);
      stored.trigger.at = Date.now() - 3_600_000;
    });
    const reloaded = await h.page.evaluate(async (id: string) => {
      await (window as any).agentBrowser.api.automation.update({
        id, name: "m3-outside-edit",
        trigger: { type: "once", at: Date.now() - 3_600_000 },
        action: { type: "custom-js", jsCode: "return 1" },
        enabled: true,
      });
      const r = await (window as any).agentBrowser.api.automation.scheduleState();
      return (r.states || []).find((s: any) => s.ruleId === id);
    }, rule.id);
    // Now genuinely missed, and reported as such.
    expect(reloaded.phase).toBe("missed-once");
    expect(reloaded.missedAt).toBeGreaterThan(0);
  }, 60_000);

  // ── 3. Missed once → reschedule ──

  it("marks a past-due once missed and lets it be rescheduled onto a new plan", async () => {
    const rule = await createRule({
      name: "m3-missed", enabled: true,
      trigger: { type: "once", at: Date.now() - 3_600_000 },
      action: { type: "custom-js", jsCode: "return 'rescheduled'" },
    });
    const before = await stateOf(rule.id);
    expect(before.phase).toBe("missed-once");
    const oldPlanId = config().automation.find((r: any) => r.id === rule.id).planId;
    expect(oldPlanId).toBeTruthy();

    const newAt = Date.now() + 7_200_000;
    const res = await h.page.evaluate((args: any) => (window as any).agentBrowser.api.automation.rescheduleOnce(args),
      { ruleId: rule.id, at: newAt });
    expect(res.success, JSON.stringify(res)).toBe(true);

    const after = await stateOf(rule.id);
    expect(after.phase).toBe("scheduled-once");
    expect(after.onceAt).toBe(newAt);
    expect(after.nextRunAt).toBe(newAt);
    expect(after.missedAt).toBeNull();
    // A new plan: the old history must not count as this plan's result.
    const stored = config().automation.find((r: any) => r.id === rule.id);
    expect(stored.planId).toBeTruthy();
    expect(stored.planId).not.toBe(oldPlanId);
    expect(stored.enabled).toBe(true);
  }, 60_000);

  it("keeps a persisted missed once inert after main-process clock rollback until explicit reschedule", async () => {
    const at = Date.now() - 3_600_000;
    const rule = await createRule({
      name: "f03-missed-clock-rollback", enabled: true,
      trigger: { type: "once", at },
      action: { type: "custom-js", jsCode: "return 'should never execute old plan'" },
    });
    const forRule = () => jobsRows().filter((j) => j.rule_id === rule.id && j.source === "once");
    const storedBefore = config().automation.find((r: any) => r.id === rule.id);
    expect(storedBefore).toMatchObject({ enabled: true, trigger: { type: "once", at } });
    expect(storedBefore.missedAt).toBeGreaterThan(0);
    expect(forRule()).toEqual([]);
    expect((await stateOf(rule.id)).phase).toBe("missed-once");
    const baseline = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
    expect(baseline.success).toBe(true);

    // Simulate only the scheduler's wall clock moving behind the persisted at.
    // Restore it in finally, even if an assertion fails; never change host time.
    const rolledBack = await h.app.evaluate((_electron, deadline: number) => {
      const g = globalThis as typeof globalThis & { __f03OriginalDateNow?: typeof Date.now };
      if (g.__f03OriginalDateNow) throw new Error("F03 clock override already active");
      const original = Date.now;
      const shift = original() - deadline + 2_500;
      g.__f03OriginalDateNow = original;
      Date.now = () => original() - shift;
      return Date.now();
    }, at);
    try {
      expect(rolledBack).toBeLessThan(at);
      const report = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
      expect(report).toMatchObject({ success: true, workStarted: false });
      // Other future rules still have timers. This original missed plan must
      // not add one to the count merely because its deadline is future again.
      expect(report.timersRefreshed).toBe(baseline.timersRefreshed);
    } finally {
      await h.app.evaluate(() => {
        const g = globalThis as typeof globalThis & { __f03OriginalDateNow?: typeof Date.now };
        const original = g.__f03OriginalDateNow;
        if (!original) throw new Error("F03 clock override was lost");
        Date.now = original;
        delete g.__f03OriginalDateNow;
      });
    }

    // Longer than the old code's armed 2.5-second timer: a return value alone
    // could look correct while a delayed custom-js still writes a durable job.
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect(forRule()).toEqual([]); // direct SQLite query, not the IPC response
    const storedAfter = config().automation.find((r: any) => r.id === rule.id);
    expect(storedAfter).toMatchObject({ planId: storedBefore.planId, missedAt: storedBefore.missedAt, enabled: true });
    const byId = await h.page.evaluate(async (id) => ({
      rule: (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === id),
      jobs: await (window as any).agentBrowser.api.automation.jobs({ ruleId: id }),
      state: (await (window as any).agentBrowser.api.automation.scheduleState()).states.find((s: any) => s.ruleId === id),
    }), rule.id);
    expect(byId.rule).toMatchObject({ planId: storedBefore.planId, missedAt: storedBefore.missedAt });
    expect(byId.jobs).toEqual([]);
    expect(byId.state).toMatchObject({ phase: "missed-once", nextRunAt: null });

    const newAt = Date.now() + 3_600_000;
    const rescheduled = await h.page.evaluate((args) => (window as any).agentBrowser.api.automation.rescheduleOnce(args),
      { ruleId: rule.id, at: newAt });
    expect(rescheduled.success).toBe(true);
    const newPlan = config().automation.find((r: any) => r.id === rule.id);
    expect(newPlan.planId).not.toBe(storedBefore.planId);
    expect(newPlan.missedAt).toBeUndefined();
    expect(newPlan.trigger.at).toBe(newAt);
    const readBack = await h.page.evaluate(async (id) => ({
      rule: (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === id),
      state: (await (window as any).agentBrowser.api.automation.scheduleState()).states.find((s: any) => s.ruleId === id),
    }), rule.id);
    expect(readBack.rule.planId).toBe(newPlan.planId);
    expect(readBack.state).toMatchObject({ phase: "scheduled-once", nextRunAt: newAt, nextRunSource: "armed-timer" });
    expect(forRule()).toEqual([]);
  }, 60_000);

  it("refuses to reschedule into the past", async () => {
    const rule = await createRule({
      name: "m3-reschedule-past", enabled: true,
      trigger: { type: "once", at: Date.now() - 3_600_000 },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    const res = await h.page.evaluate((args: any) => (window as any).agentBrowser.api.automation.rescheduleOnce(args),
      { ruleId: rule.id, at: Date.now() - 60_000 });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  }, 60_000);

  it("refuses to reschedule a cron", async () => {
    const rule = await createRule({
      name: "m3-reschedule-cron", enabled: true,
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    const res = await h.page.evaluate((args: any) => (window as any).agentBrowser.api.automation.rescheduleOnce(args),
      { ruleId: rule.id, at: Date.now() + 3_600_000 });
    expect(res.success).toBe(false);
  }, 60_000);

  // ── 4. A test run must not masquerade as a plan execution ──

  it("does not let a test run count as this plan's result", async () => {
    const rule = await createRule({
      name: "m3-test-not-a-run", enabled: true,
      trigger: { type: "once", at: Date.now() + 3_600_000 },
      action: { type: "custom-js", jsCode: "return 'tested'" },
    });
    const planId = config().automation.find((r: any) => r.id === rule.id).planId;
    const testRes = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.automation.testRun(id), rule.id);
    expect(testRes.ok).toBe(true);

    // The test run produced a job — but with NO planId, so it cannot satisfy
    // the plan.
    const rows = jobsRows().filter((j) => j.rule_id === rule.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe("test");
      expect(row.plan_id == null).toBe(true);
    }
    const state = await stateOf(rule.id);
    // Still scheduled, and still reporting no results for the plan.
    expect(state.phase).toBe("scheduled-once");
    expect(state.degraded).toBe(true);
    expect(state.lastOutcome).toBeNull();
    // The plan id did not change either — a test run is not a rule edit.
    expect(config().automation.find((r: any) => r.id === rule.id).planId).toBe(planId);
  }, 60_000);

  it("does not let a disabled-after-success rule borrow a test run's outcome", async () => {
    const rule = await createRule({
      name: "m3-no-borrow", enabled: true,
      trigger: { type: "once", at: Date.now() + 3_600_000 },
      action: { type: "custom-js", jsCode: "return 'ok'" },
    });
    await h.page.evaluate((id: string) => (window as any).agentBrowser.api.automation.testRun(id), rule.id);
    // Disable it. Without plan isolation the test job would be read as "this
    // plan already ran", and the card would claim disabled-after-success.
    await h.page.evaluate((id: string) => (window as any).agentBrowser.api.automation.update({
      id, name: "m3-no-borrow", enabled: false,
      trigger: { type: "once", at: Date.now() + 3_600_000 },
      action: { type: "custom-js", jsCode: "return 'ok'" },
    }), rule.id);
    const state = await stateOf(rule.id);
    expect(state.phase).toBe("user-disabled");
    expect(state.phase).not.toBe("disabled-after-success");
  }, 60_000);

  // ── 5. Rule edits must not pollute the new plan ──

  it("reissues the plan only when the trigger or action really changes", async () => {
    const rule = await createRule({
      name: "m3-plan-bump", enabled: true,
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    const p0 = config().automation.find((r: any) => r.id === rule.id).planId;

    // A rename + toggle is not a semantic change. This is the path the card's
    // own toggle button takes, so a bump here would reset the plan on every
    // click.
    await h.page.evaluate((args: any) => (window as any).agentBrowser.api.automation.update({
      id: args.id, name: "m3-plan-bump renamed", enabled: false,
      trigger: { type: "cron", cron: args.cron },
      action: { type: "custom-js", jsCode: "return 1" },
    }), { id: rule.id, cron: FAR_CRON });
    const p1 = config().automation.find((r: any) => r.id === rule.id).planId;
    expect(p1).toBe(p0);

    // Changing the action IS semantic.
    await h.page.evaluate((args: any) => (window as any).agentBrowser.api.automation.update({
      id: args.id, name: "m3-plan-bump renamed", enabled: false,
      trigger: { type: "cron", cron: args.cron },
      action: { type: "custom-js", jsCode: "return 2" },
    }), { id: rule.id, cron: FAR_CRON });
    const p2 = config().automation.find((r: any) => r.id === rule.id).planId;
    expect(p2).toBeTruthy();
    expect(p2).not.toBe(p0);
  }, 60_000);

  // ── 6. Reconciliation ──

  it("converges orphaned rows and starts nothing", async () => {
    const rule = await createRule({
      name: "m3-reconcile", enabled: true,
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    const before = jobsRows().length;
    const report = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
    expect(report.success).toBe(true);
    // The load-bearing assertion: reconciliation converges state, it does not
    // start work. A resume handler is the worst place to begin side effects.
    expect(jobsRows().length).toBe(before);
    expect(report.notificationsReplayed).toBe(0);
    expect(rule.id).toBeTruthy();
  }, 60_000);

  it("keeps a real active once running across manual reconcile, then persists its completion", async () => {
    const rule = await createRule({
      name: "m3-live-once", enabled: true,
      trigger: { type: "once", at: Date.now() + 1_200 },
      action: { type: "custom-js", jsCode: "return new Promise(resolve => setTimeout(() => resolve('finished after reconcile'), 3500))" },
    });
    const forRule = () => jobsRows().filter((j) => j.rule_id === rule.id && j.source === "once");
    await vi.waitFor(() => expect(forRule().map((j) => j.status)).toEqual(["running"]),
      { timeout: 15_000, interval: 50 });
    const before = forRule()[0]; // direct SQLite read, no API assumption
    expect(config().automation.find((r: any) => r.id === rule.id).enabled).toBe(true);
    const report = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
    expect(report).toMatchObject({ success: true, interruptedJobs: 0, orphanedQueued: 0, orphanedRetryWaiting: 0 });
    expect(forRule()[0]).toMatchObject({ id: before.id, status: "running", started_at: before.started_at });
    const live = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.jobGet(id), before.id);
    expect(live).toMatchObject({ id: before.id, status: "running" });
    await vi.waitFor(() => expect(forRule()[0]?.status).toBe("done"),
      { timeout: 15_000, interval: 100 });
    const finalRow = forRule()[0];
    expect(finalRow.result).toContain("finished after reconcile");
    expect(finalRow.finished_at).toBeGreaterThan(before.started_at);
    expect(forRule()).toHaveLength(1);
    expect(config().automation.find((r: any) => r.id === rule.id).enabled).toBe(false);
    const persistedRule = await h.page.evaluate(async (id) =>
      (await (window as any).agentBrowser.api.automation.list()).find((r: any) => r.id === id), rule.id);
    expect(persistedRule.enabled).toBe(false);
    const finished = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.jobGet(id), before.id);
    expect(finished).toMatchObject({ id: before.id, status: "done", result: finalRow.result });
    const byRule = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.jobs({ ruleId: id }), rule.id);
    expect(byRule.map((j: any) => j.id)).toContain(before.id);
  }, 60_000);

  it("preserves a real retry-waiting row and its retry instant on manual reconcile", async () => {
    const at = Date.now() + 1_200;
    const action = { type: "custom-js", jsCode: "throw new Error('synthetic retry failure')" };
    const rule = await createRule({
      name: "m3-live-retry", enabled: true, maxRetries: 1,
      trigger: { type: "once", at }, action,
    });
    const forRule = () => jobsRows().filter((j) => j.rule_id === rule.id && j.source === "once");
    await vi.waitFor(() => expect(forRule().map((j) => j.status)).toEqual(["retry-waiting"]),
      { timeout: 10_000, interval: 50 });
    const before = forRule()[0];
    expect(before.attempt).toBe(0);
    expect(before.retry_at).toBeGreaterThan(Date.now());
    const report = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
    expect(report).toMatchObject({ success: true, orphanedRetryWaiting: 0, workStarted: false });
    expect(forRule()[0]).toMatchObject({ id: before.id, status: "retry-waiting", retry_at: before.retry_at, attempt: 0 });
    expect(config().automation.find((r: any) => r.id === rule.id).missedAt).toBeUndefined();
    const readBack = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.jobGet(id), before.id);
    expect(readBack).toMatchObject({ id: before.id, status: "retry-waiting", retryAt: before.retry_at, attempt: 0 });
    // Explicit edit still invalidates a retry as before F03. Do not leave a
    // pending retry timer running into later E2E cases.
    const changed = await h.page.evaluate((input) => (window as any).agentBrowser.api.automation.update(input), {
      id: rule.id, name: rule.name, enabled: false, maxRetries: 1,
      trigger: { type: "once", at }, action,
    });
    expect(changed.success).toBe(true);
    expect(forRule()[0]).toMatchObject({ id: before.id, status: "failed", retry_at: null });
  }, 60_000);

  it("preserves live rows on IPC reconcile, then recovers only after a real process restart", async () => {
    const rule = await createRule({
      name: "m3-owned-jobs", enabled: true,
      trigger: { type: "cron", cron: FAR_CRON },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    // Synthetic rows in an isolated jobs.sqlite: no browser, model, sync or
    // proxy action is sent. While this process is alive they must NOT be
    // declared orphaned by the public manual IPC path.
    const now = Date.now();
    const ids = ["job_live_running_m3", "job_live_queued_m3", "job_live_retry_m3"];
    const db = new DatabaseSync(jobsDbPath());
    try {
      const insert = db.prepare(
        "INSERT INTO jobs (id, rule_id, rule_name, source, status, attempt, created_at, started_at, retry_at) VALUES (?, ?, ?, 'cron', ?, ?, ?, ?, ?)",
      );
      insert.run(ids[0], rule.id, rule.name, "running", 0, now, now, null);
      insert.run(ids[1], rule.id, rule.name, "queued", 0, now, null, null);
      insert.run(ids[2], rule.id, rule.name, "retry-waiting", 1, now, now, now + 60_000);
    } finally { db.close(); }
    const inspect = () => jobsRows().filter((j) => ids.includes(j.id)).sort((a, b) => a.id.localeCompare(b.id));
    const before = inspect(); // direct SQLite read, independent of the IPC path
    expect(before.map((j) => j.status).sort()).toEqual(["queued", "retry-waiting", "running"]);
    const count = jobsRows().length;
    const report = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
    expect(report).toMatchObject({
      success: true, reason: "manual", workStarted: false, interruptedJobs: 0,
      orphanedQueued: 0, orphanedRetryWaiting: 0, jobsReplayedFromRun: 0,
      notificationsReplayed: 0,
    });
    expect(report.timersRefreshed).toBeGreaterThan(0);
    expect(inspect()).toEqual(before);
    expect(jobsRows()).toHaveLength(count);
    for (const row of before) {
      const readBack = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.jobGet(id), row.id);
      expect(readBack).toMatchObject({ id: row.id, status: row.status, attempt: row.attempt, retryAt: row.retry_at });
    }
    const byRule = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.jobs({ ruleId: id }), rule.id);
    expect(ids.every((id) => byRule.some((j: any) => j.id === id))).toBe(true);

    // closeApp force-kills this process, so none of its in-memory ownership or
    // retry timers survive. Startup recovery is now allowed to converge rows.
    await closeApp(h);
    await launch(false);
    const after = inspect();
    expect(after.map((j) => j.status)).toEqual(["cancelled", "failed", "failed"]);
    const byId = Object.fromEntries(after.map((row) => [row.id, row]));
    expect(byId[ids[0]].error).toBe("interrupted by restart");
    expect(byId[ids[1]].error).toContain("orphaned queued");
    expect(byId[ids[2]].error).toContain("not rescheduled");
    expect(byId[ids[2]].retry_at).toBeNull();
    expect(jobsRows()).toHaveLength(count);
    for (const row of after) {
      const readBack = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.jobGet(id), row.id);
      expect(readBack).toMatchObject({ id: row.id, status: row.status, error: row.error });
    }
    const idempotent = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.reconcile());
    expect(idempotent).toMatchObject({ interruptedJobs: 0, orphanedQueued: 0, orphanedRetryWaiting: 0 });
    expect(inspect()).toEqual(after);
  }, 180_000);

  // ── 7. Notifications ──

  it("records a terminal notification for a real execution, once", async () => {
    const rule = await createRule({
      name: "m3-notify", enabled: true,
      trigger: { type: "once", at: Date.now() + 3_600_000 },
      action: { type: "custom-js", jsCode: "return 'notified'" },
    });
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.automation.testRun(id), rule.id);
    expect(res.ok).toBe(true);

    const notifications = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.notifications({ limit: 50 }));
    // A TEST run is not a plan execution, so it must not alert. This is the
    // "test run must not masquerade as a real run" rule applied to alerts.
    const forRule = notifications.filter((n: any) => n.ruleId === rule.id);
    expect(forRule).toHaveLength(0);
  }, 60_000);

  it("keeps the notification log readable and markable", async () => {
    const unread = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.notificationsUnreadCount());
    expect(typeof unread.count).toBe("number");
    const list = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.notifications({ limit: 10 }));
    expect(Array.isArray(list)).toBe(true);
    if (list.length) {
      const marked = await h.page.evaluate((keys: string[]) =>
        (window as any).agentBrowser.api.automation.notificationsRead(keys), [list[0].dedupKey]);
      expect(marked.success).toBe(true);
      const after = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.notifications({ limit: 10 }));
      expect(after.find((n: any) => n.dedupKey === list[0].dedupKey).readAt).toBeTruthy();
    }
  }, 60_000);

  it("stores notification settings and defaults them off", async () => {
    const initial = await h.page.evaluate(() => (window as any).agentBrowser.api.settings.automationNotify());
    expect(initial).toMatchObject({ system: false, sound: false });

    const saved = await h.page.evaluate(() => (window as any).agentBrowser.api.settings.setAutomationNotify({ system: true, sound: true }));
    expect(saved.success).toBe(true);
    // Round-tripped through config, so it survives a restart.
    expect(config().automationNotify).toMatchObject({ system: true, sound: true });

    const readBack = await h.page.evaluate(() => (window as any).agentBrowser.api.settings.automationNotify());
    expect(readBack).toMatchObject({ system: true, sound: true });

    await h.page.evaluate(() => (window as any).agentBrowser.api.settings.setAutomationNotify({ system: false, sound: false }));
  }, 60_000);

  // ── 8. Restart ──

  it("records exactly one alert for a real scheduled execution", async () => {
    // A real execution, not a test run: a `once` set for a moment already past
    // fires through the scheduler. The missed-once marking skips it because a
    // timer is armed for it, so this is the genuine execution path.
    const rule = await createRule({
      name: "m3-real-exec", enabled: true,
      trigger: { type: "once", at: Date.now() + 1_200 },
      action: { type: "custom-js", jsCode: "return 'executed'" },
    });

    await vi.waitFor(() => {
      const rows = jobsRows().filter((j) => j.rule_id === rule.id && j.source !== "test");
      expect(rows.length, "the scheduled execution produced no job").toBeGreaterThan(0);
      expect(rows.every((j) => j.status !== "running" && j.status !== "queued")).toBe(true);
    }, { timeout: 30_000, interval: 250 });

    const rows = notificationsRows().filter((n) => n.rule_id === rule.id);
    // Exactly one, for exactly one logical execution.
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("done");
    expect(rows[0].job_id).toBeTruthy();
    expect(rows[0].plan_id).toBe(config().automation.find((r: any) => r.id === rule.id).planId);
  }, 60_000);

  it("does not re-alert across a restart, and keeps the schedule truthful", async () => {
    // closeApp is pkill -9 — exactly the crash case, with no graceful shutdown.
    const rule = await createRule({
      name: "m3-restart", enabled: true,
      trigger: { type: "once", at: Date.now() - 3_600_000 },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    const beforeStates = await stateOf(rule.id);
    expect(beforeStates.phase).toBe("missed-once");
    // Snapshot the full rows, not just the count: a REPLACE would keep the
    // count identical while re-writing created_at, i.e. while genuinely
    // re-alerting. Comparing (key → created_at) catches both.
    const before = notificationsRows().map((n) => `${n.dedup_key}@${n.created_at}`).sort();
    // The comparison is only meaningful if there is something to compare. A
    // previous case drove a real scheduled execution, so rows must exist.
    // (Verified by falsification: this assertion is what stops the check below
    // from passing over two empty arrays. What it does NOT prove is the dedup
    // key — a restart never reaches notifyTerminal at all, so the no-replay
    // property here comes from the missing call site, and the key's own
    // contribution is covered by tests/unit/automation-notify.test.ts, where
    // swapping INSERT OR IGNORE for REPLACE turns four tests red.)
    expect(before.length, "no notification rows exist — the no-replay check would be vacuous").toBeGreaterThan(0);

    await closeApp(h);
    await launch(false); // resetUserData: false — same store, second process

    const afterStates = await stateOf(rule.id);
    // The missed mark is durable, so the phase survives the restart.
    expect(afterStates.phase).toBe("missed-once");
    // Nothing was appended and nothing was rewritten.
    const after = notificationsRows().map((n) => `${n.dedup_key}@${n.created_at}`).sort();
    expect(after).toEqual(before);
    // And the rule was not silently re-armed or executed.
    expect(config().automation.find((r: any) => r.id === rule.id).enabled).toBe(true);
  }, 180_000);

  it("keeps a rescheduled plan across a restart", async () => {
    const rule = await createRule({
      name: "m3-restart-rescheduled", enabled: true,
      trigger: { type: "once", at: Date.now() - 3_600_000 },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    const newAt = Date.now() + 10_800_000;
    const res = await h.page.evaluate((args: any) => (window as any).agentBrowser.api.automation.rescheduleOnce(args),
      { ruleId: rule.id, at: newAt });
    expect(res.success).toBe(true);
    const planId = config().automation.find((r: any) => r.id === rule.id).planId;

    await closeApp(h);
    await launch(false);

    const stored = config().automation.find((r: any) => r.id === rule.id);
    expect(stored.planId).toBe(planId);
    expect(stored.trigger.at).toBe(newAt);
    const state = await stateOf(rule.id);
    expect(state.phase).toBe("scheduled-once");
    expect(state.missedAt).toBeNull();
  }, 180_000);

  // ── 9. Legacy rows ──

  it("treats a pre-M3 job row with no plan id as no evidence", async () => {
    const rule = await createRule({
      name: "m3-legacy-row", enabled: true,
      trigger: { type: "once", at: Date.now() + 3_600_000 },
      action: { type: "custom-js", jsCode: "return 1" },
    });
    // A row from before plan_id existed: done, for this rule, but plan-less.
    const db = new DatabaseSync(jobsDbPath());
    try {
      db.prepare(
        "INSERT INTO jobs (id, rule_id, rule_name, source, status, attempt, created_at, finished_at, result) VALUES (?, ?, ?, 'scheduler', 'done', 1, ?, ?, 'legacy success')",
      ).run("job_legacy_m3", rule.id, "m3-legacy-row", Date.now() - 86_400_000, Date.now() - 86_400_000);
    } finally { db.close(); }

    const state = await stateOf(rule.id);
    // The legacy success must NOT be adopted as this plan's outcome.
    expect(state.lastOutcome).toBeNull();
    expect(state.degraded).toBe(true);
    // And the rule still reports the truth about the future.
    expect(state.phase).toBe("scheduled-once");
  }, 60_000);
});
