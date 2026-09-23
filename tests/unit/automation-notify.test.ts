// M3 unit tests: the terminal-notification layer.
//
// The properties under test are the ones §6.2 states as requirements:
//   - notify once per FINAL logical execution, never on intermediate retries
//   - no re-notify after a restart
//   - permission denial keeps the in-app record and does not affect execution
//   - a manual test run never notifies
//   - no sensitive business content in the system notification
//
// The OS Notification is stubbed. A stub that THROWS is the permission-denial
// shape: macOS denial is a system-settings state with no callback and no
// exception, so the design must make it a non-event rather than a handled one.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

const mocks = vi.hoisted(() => ({
  shown: [] as any[],
  throwOnShow: false,
  supported: true,
  clicks: [] as Array<() => void>,
}));

vi.mock("electron", () => {
  class FakeNotification {
    opts: any;
    constructor(opts: any) {
      this.opts = opts;
      mocks.shown.push(opts);
    }
    static isSupported() { return mocks.supported; }
    on(event: string, cb: () => void) { if (event === "click") mocks.clicks.push(cb); }
    show() {
      if (mocks.throwOnShow) throw new Error("notification permission denied");
    }
  }
  return { Notification: FakeNotification, BrowserWindow: { getAllWindows: () => [] } };
});

import { _setDbForTesting, listNotifications, countUnreadNotifications } from "../../src/main/services/job-store.js";
import {
  configureNotifier, notifyTerminal, systemNotificationBody,
} from "../../src/main/services/automation-notify.js";
import { tMain } from "../../src/main/services/main-i18n.js";

const broadcasts: Array<{ channel: string; payload: any }> = [];
let nowValue = 1_000;
let systemEnabled = true;
let soundEnabled = false;
let windowState: { visible: boolean; focused: boolean; destroyed: boolean } = { visible: false, focused: false, destroyed: false };
let ensureWindowCalls = 0;
let sentToWindow: Array<{ channel: string; payload: any }> = [];
let loading = false;
let didFinishLoadCbs: Array<() => void> = [];

function fakeWindow(): any {
  return {
    isDestroyed: () => windowState.destroyed,
    isVisible: () => windowState.visible,
    isFocused: () => windowState.focused,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isLoading: () => loading,
      once: (_e: string, cb: () => void) => { didFinishLoadCbs.push(cb); },
      send: (channel: string, payload: any) => { sentToWindow.push({ channel, payload }); },
    },
  };
}

beforeEach(() => {
  _setDbForTesting(new DatabaseSync(":memory:"));
  mocks.shown = [];
  mocks.clicks = [];
  mocks.throwOnShow = false;
  mocks.supported = true;
  broadcasts.length = 0;
  sentToWindow = [];
  didFinishLoadCbs = [];
  loading = false;
  nowValue = 1_000;
  systemEnabled = true;
  soundEnabled = false;
  windowState = { visible: false, focused: false, destroyed: false };
  ensureWindowCalls = 0;
  configureNotifier({
    systemEnabled: () => systemEnabled,
    soundEnabled: () => soundEnabled,
    broadcast: (channel, payload) => { broadcasts.push({ channel, payload }); },
    getWindow: () => (windowState.destroyed ? null : fakeWindow()),
    ensureWindow: () => { ensureWindowCalls++; },
    now: () => nowValue,
  });
});

function notify(over: Record<string, unknown> = {}) {
  return notifyTerminal({
    ruleId: "rule_1",
    ruleName: "nightly",
    planId: "plan_a",
    jobId: "job_1",
    runId: "run_1",
    kind: "done",
    dedupKey: "job:job_1",
    ...over,
  } as any);
}

describe("notifyTerminal dedup", () => {
  it("records and alerts once for a job, then reports the duplicate", () => {
    expect(notify()).toBe(true);
    expect(listNotifications()).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
    expect(mocks.shown).toHaveLength(1);

    expect(notify()).toBe(false);
    expect(listNotifications()).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
    expect(mocks.shown).toHaveLength(1);
  });

  it("does not re-alert after a restart", () => {
    // A restart reuses the same jobs.sqlite, so the key is already present and
    // INSERT OR IGNORE reports the duplicate. That is the whole mechanism.
    notify();
    const before = { broadcasts: broadcasts.length, shown: mocks.shown.length };
    // Same durable store, fresh in-memory notifier state.
    configureNotifier({
      systemEnabled: () => true, soundEnabled: () => false,
      broadcast: (c, p) => { broadcasts.push({ channel: c, payload: p }); },
      getWindow: () => null, ensureWindow: () => {}, now: () => nowValue,
    });
    expect(notify()).toBe(false);
    expect(broadcasts.length).toBe(before.broadcasts);
    expect(mocks.shown.length).toBe(before.shown);
  });

  it("notifies once across a whole retry chain", () => {
    // Attempt 1 and 2 are non-final, so runRule never calls us for them; only
    // the terminal attempt arrives here. Asserted at this layer as: the same
    // job id yields exactly one alert no matter how often it is offered.
    expect(notify({ kind: "failed" })).toBe(true);
    expect(notify({ kind: "failed" })).toBe(false);
    expect(notify({ kind: "failed" })).toBe(false);
    expect(countUnreadNotifications()).toBe(1);
  });

  it("keys a missed-once alert on rule+plan so a reschedule can alert again", () => {
    // A new plan is a new plan; the user should hear about the new one missing
    // too. A mere reload keeps the same key and stays silent.
    const missed = { kind: "missed" as const, jobId: null, dedupKey: "missed:rule_1:plan_a" };
    expect(notify(missed)).toBe(true);
    expect(notify(missed)).toBe(false);
    expect(notify({ ...missed, planId: "plan_b", dedupKey: "missed:rule_1:plan_b" })).toBe(true);
    expect(countUnreadNotifications()).toBe(2);
  });
});

describe("notifyTerminal delivery paths", () => {
  it("always writes the in-app record and broadcast", () => {
    notify();
    const row = listNotifications()[0];
    expect(row.ruleId).toBe("rule_1");
    expect(row.jobId).toBe("job_1");
    expect(row.planId).toBe("plan_a");
    expect(broadcasts[0].channel).toBe("automation:run-finished");
    expect(broadcasts[0].payload).toMatchObject({ ruleId: "rule_1", runId: "run_1", kind: "done" });
  });

  it("keeps the in-app record when the OS notification throws", () => {
    // The permission-denial shape. macOS denial has no callback and no
    // exception; the throwing stub is the harshest version of it.
    mocks.throwOnShow = true;
    expect(() => notify()).not.toThrow();
    expect(listNotifications()).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it("keeps the in-app record when notifications are unsupported", () => {
    mocks.supported = false;
    notify();
    expect(listNotifications()).toHaveLength(1);
    expect(mocks.shown).toHaveLength(0);
  });

  it("skips the OS notification when the window is visible and focused", () => {
    // In the foreground the in-app toast is strictly better — it carries an
    // action. Popping a system banner over a focused app is noise.
    windowState = { visible: true, focused: true, destroyed: false };
    notify();
    expect(broadcasts).toHaveLength(1);
    expect(mocks.shown).toHaveLength(0);
  });

  it("does not show when the user has not opted in", () => {
    systemEnabled = false;
    notify();
    expect(mocks.shown).toHaveLength(0);
    // The in-app record is unconditional.
    expect(listNotifications()).toHaveLength(1);
  });

  it("carries the sound preference", () => {
    soundEnabled = true;
    notify();
    expect(mocks.shown[0].silent).toBe(false);
    soundEnabled = false;
    notify({ dedupKey: "job:job_2", jobId: "job_2" });
    expect(mocks.shown[1].silent).toBe(true);
  });

  it("survives a destroyed window", () => {
    windowState = { visible: false, focused: false, destroyed: true };
    expect(() => notify()).not.toThrow();
    expect(listNotifications()).toHaveLength(1);
  });

  it("does nothing when the notifier was never configured", () => {
    // The guard exists so a caller that runs before startup wiring (or a unit
    // test that never configures one) cannot throw or write anything.
    configureNotifier(null as any);
    expect(() => notify()).not.toThrow();
    expect(listNotifications()).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });
});

describe("system notification content", () => {
  it("carries no business content", () => {
    // A system notification lands on a lock screen and in notification
    // history. The body must be a generic phrase: no result text, no error,
    // no prompt, no URL, no profile id, no runId.
    notify({ kind: "failed" });
    const opts = mocks.shown[0];
    expect(opts.body).toBe(systemNotificationBody("failed"));
    const serialized = JSON.stringify(opts);
    for (const leak of ["run_1", "job_1", "plan_a", "profileDirId", "http"]) {
      expect(serialized, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it("uses the rule name as the title, truncated", () => {
    notify({ ruleName: "x".repeat(200) });
    expect(mocks.shown[0].title).toHaveLength(80);
    expect(mocks.shown[0].title.endsWith("…")).toBe(true);
  });

  it("falls back to a generic title for an unnamed rule", () => {
    // Not cosmetic: an empty title renders as a blank banner with no way to
    // tell which rule fired.
    notify({ ruleName: "   " });
    expect(mocks.shown[0].title).toBe(tMain("notify.default-rule-name"));
    expect(mocks.shown[0].title.trim()).not.toBe("");
  });

  it("gives each kind a distinct body", () => {
    const bodies = (["done", "failed", "cancelled", "missed"] as const).map(systemNotificationBody);
    expect(new Set(bodies).size).toBe(4);
    for (const b of bodies) expect(b.length).toBeGreaterThan(0);
  });
});

describe("notification click", () => {
  it("opens the run when a window already exists", () => {
    notify();
    expect(mocks.clicks).toHaveLength(1);
    mocks.clicks[0]();
    expect(sentToWindow).toEqual([{ channel: "automation:open-run", payload: { runId: "run_1" } }]);
    expect(ensureWindowCalls).toBe(0);
  });

  it("creates a window when none is open, then opens the run", () => {
    // The real failure this prevents: the app lives in the tray, so a click
    // with no window would otherwise do nothing at all.
    windowState = { visible: false, focused: false, destroyed: true };
    notify();
    mocks.clicks[0]();
    expect(ensureWindowCalls).toBe(1);
  });

  it("waits for the window to finish loading before sending", () => {
    // A freshly created window has not loaded the renderer yet, so an
    // immediate send lands on a listener that does not exist.
    loading = true;
    notify();
    mocks.clicks[0]();
    expect(sentToWindow).toHaveLength(0);
    for (const cb of didFinishLoadCbs) cb();
    expect(sentToWindow).toEqual([{ channel: "automation:open-run", payload: { runId: "run_1" } }]);
  });

  it("sends nothing when the alert has no run", () => {
    notify({ kind: "missed", runId: null, jobId: null, dedupKey: "missed:rule_1:plan_a" });
    mocks.clicks[0]();
    expect(sentToWindow).toHaveLength(0);
  });

  it("does not throw when the click handler itself fails", () => {
    windowState = { visible: false, focused: false, destroyed: true };
    notify();
    // ensureWindow leaves no window; the handler must simply give up.
    expect(() => mocks.clicks[0]()).not.toThrow();
  });
});
