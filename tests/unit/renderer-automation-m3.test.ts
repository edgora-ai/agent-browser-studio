// M3 renderer regressions for the Automation surface: the rule card renders
// the SCHEDULER's phase (never a frontend date comparison against trigger.at),
// missed-once grows the two real escape hatches, the completion-alert settings
// card round-trips, and the three new event listeners are actually subscribed.
//
// No jsdom in this repo, so this loads src/renderer/js/app/automation.js into a
// `vm` context backed by a hand-rolled element stub — the pattern
// tests/unit/renderer-runs-m2.test.ts established. The REAL i18n runtime is
// loaded rather than a stub, because a stub that echoes its own fallback cannot
// distinguish "translated" from "key missing", which is the exact failure the
// phase-label assertions exist to catch.
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(__dirname, "../..");
const AUTOMATION = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/automation.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const PRELOAD = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf8");
const I18N_RENDERER = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");

function loadI18n(lang: string) {
  const dom: any = {
    documentElement: { lang: "" },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  const ctx: any = {
    window: { agentBrowserAPI: { app: { setLanguage: () => Promise.resolve() } } },
    document: dom,
    navigator: { language: "en-US" },
    CustomEvent: class { constructor(_t: string, _o: any) {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout,
    console,
  };
  ctx.window.document = dom;
  ctx.window.navigator = ctx.navigator;
  ctx.window.localStorage = ctx.localStorage;
  vm.createContext(ctx);
  vm.runInContext(I18N_RENDERER, ctx);
  ctx.window.i18n.set(lang);
  return ctx.window.i18n as { t: (key: string, fallback?: string) => string; get: () => string };
}

const EN = loadI18n("en-US");
const ZH = loadI18n("zh-CN");

function selectorsOf(selector: string): string[] {
  return selector
    .split(",")
    .map((s) => s.trim())
    .map((s) => (s.startsWith("[data-") ? s.slice(6, -1) : s))
    .filter(Boolean)
    .map((attr) => attr.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
}

class FakeElement {
  id: string;
  value = "";
  disabled = false;
  open = false;
  checked = false;
  textContent = "";
  innerHTML = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  listeners: Record<string, Array<(event: any) => void>> = {};
  classList = { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false), toggle: vi.fn() };

  constructor(id: string) { this.id = id; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  addEventListener(type: string, fn: (event: any) => void) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type: string, fn: (event: any) => void) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  fire(type: string, event: any) {
    for (const fn of this.listeners[type] || []) fn(event);
    // automation.js assigns the card handler as `el.onclick = fn` rather than
    // through addEventListener, so a fire() that only walked `listeners` would
    // silently never dispatch — the test would assert on a click that never
    // happened.
    const inline = (this as any)["on" + type];
    if (typeof inline === "function") inline(event);
  }
  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) this.dataset[selectorsOf(`[${name}]`)[0]] = String(value);
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  appendChild(child: FakeElement) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: FakeElement) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; }
  contains(node: any) { return node === this || this.children.includes(node); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest(selector: string) {
    const wanted = selectorsOf(selector);
    let node: FakeElement | null = this;
    while (node) {
      if (wanted.some((attr) => Object.prototype.hasOwnProperty.call(node!.dataset, attr))) return node;
      node = node.parentNode;
    }
    return null;
  }
}

const IDS = [
  "automation-list", "automation-jobs", "automation-log", "automation-job-status",
  "dlg-auto-reschedule", "auto-reschedule-id", "auto-reschedule-at",
  "auto-notify-system", "auto-notify-sound", "auto-notify-status",
];

async function flush(times = 16) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A datetime-local value for an instant, in LOCAL wall-clock.
 *  Not toISOString(): that emits UTC, and `new Date(utcLookingString)` reads
 *  it back as local — on a UTC+ host the "future" time lands in the past and
 *  the dialog's own future-check fires instead of the code under test. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function makeHarness(opts: { lang?: "en" | "zh"; rules?: any[]; states?: any[] } = {}) {
  const lang = opts.lang ?? "en";
  const i18n = lang === "zh" ? ZH : EN;
  const elements: Record<string, FakeElement> = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  const channelListeners = new Map<string, Set<(payload: any) => void>>();
  const toasts: Array<{ msg: string; type: string; opts: any }> = [];

  const rules = opts.rules ?? [];
  const states = opts.states ?? [];

  const api: any = {
    automation: {
      list: vi.fn(async () => rules),
      scheduleState: vi.fn(async () => ({ success: true, states })),
      jobs: vi.fn(async () => []),
      logs: vi.fn(async () => []),
      rescheduleOnce: vi.fn(async () => ({ success: true })),
    },
    settings: {
      automationNotify: vi.fn(async () => ({ system: false, sound: false })),
      setAutomationNotify: vi.fn(async (p: any) => ({ success: true, automationNotify: p })),
    },
    on(channel: string, cb: (payload: any) => void) {
      if (!channelListeners.has(channel)) channelListeners.set(channel, new Set());
      channelListeners.get(channel)!.add(cb);
    },
    removeListener(channel: string, cb: (payload: any) => void) { channelListeners.get(channel)?.delete(cb); },
  };

  const helpers: any = {
    toast: vi.fn((msg: string, type: string, o: any) => { toasts.push({ msg, type, opts: o }); }),
    esc: (value: unknown) => (value ? String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : ""),
    escAttr: (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    icon: (name: string) => `<svg data-icon="${name}"></svg>`,
    relTime: (ts: number) => `rel:${ts}`,
  };

  const agentBrowser: any = {
    api,
    state: { currentTab: "automation" },
    helpers,
    ipc: { call: (_key: string, fn: () => Promise<any>) => fn() },
    confirm: vi.fn((_message: string, onOk: () => void) => onOk()),
    runsOpen: vi.fn(),
    automationRefreshLogs: vi.fn(),
    automationRefreshJobs: vi.fn(),
  };

  const document: any = {
    readyState: "complete",
    hidden: false,
    documentElement: { lang },
    getElementById: (id: string) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new FakeElement("div"),
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  const window: any = { agentBrowser, i18n };
  window.window = window;
  window.document = document;

  const context: any = {
    window, document, console, Promise, Date, Math, JSON, Error, String, Number,
    Object, Array, Map, Set, WeakMap, RegExp, Symbol, Boolean, isNaN, parseInt, parseFloat,
    setTimeout, clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.createContext(context);
  vm.runInContext(AUTOMATION, context);
  return { window, document, elements, api, agentBrowser, channelListeners, toasts, rules, states };
}

/** Drive the delegated card handler: a button inside a card with data-rule-id. */
function clickCard(h: ReturnType<typeof makeHarness>, ruleId: string, action: string) {
  const list = h.elements["automation-list"];
  const card = new FakeElement("card");
  card.dataset.ruleId = ruleId;
  const btn: any = {
    dataset: { ruleAction: action },
    closest(selector: string) {
      const wanted = selectorsOf(selector);
      if (wanted.includes("ruleAction")) return this;
      if (wanted.includes("ruleId")) return card;
      return null;
    },
  };
  list.appendChild(btn);
  list.fire("click", { target: btn });
}

function rule(over: Record<string, any> = {}) {
  return {
    id: "rule_1", name: "Nightly sweep", enabled: true,
    trigger: { type: "cron", cron: "0 3 * * *" },
    action: { type: "launch-profile", profileDirId: "prof_a" },
    ...over,
  };
}

function state(over: Record<string, any> = {}) {
  return {
    ruleId: "rule_1", phase: "scheduled-cron", nextRunAt: null, nextRunSource: null,
    timezone: "Asia/Shanghai", timezoneOffsetMinutes: 480, onceAt: null, missedAt: null,
    cooldownUntil: null, lastOutcome: null, activeJob: null, lastAttempt: null, degraded: false,
    ...over,
  };
}

describe("M3 renderer: the card renders the scheduler's phase", () => {
  it("renders nextRunAt from the state, not trigger.at", async () => {
    // The load-bearing case. trigger.at and nextRunAt deliberately DISAGREE:
    // a frontend that computed "next run" from the trigger would render the
    // trigger value and this assertion would catch it.
    const AT = 1_700_000_000_000;
    const NEXT = AT + 86_400_000;
    const h = makeHarness({
      rules: [rule({ trigger: { type: "once", at: AT } })],
      states: [state({ phase: "scheduled-once", onceAt: AT, nextRunAt: NEXT, nextRunSource: "armed-timer" })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    const html = h.elements["automation-list"].innerHTML;
    expect(html).toContain(`rel:${NEXT}`);
    // trigger.at is not a next-run source for a scheduled once.
    expect(html).not.toContain(`rel:${AT}`);
  });

  it("labels every phase from the dictionary, never with a raw key", async () => {
    const phases = [
      "event-driven", "running", "retry-waiting", "queued", "cooldown",
      "scheduled-once", "missed-once", "scheduled-cron", "invalid-cron",
      "disabled-after-success", "user-disabled",
    ];
    for (const phase of phases) {
      const h = makeHarness({
        lang: "zh",
        rules: [rule()],
        states: [state({ phase, nextRunAt: null })],
      });
      h.agentBrowser.loadAutomationTab();
      await flush();
      const html = h.elements["automation-list"].innerHTML;
      expect(html, `phase ${phase} leaked its key`).not.toContain(`auto.phase.${phase}`);
      // The zh label must differ from the key, i.e. it was translated.
      const zhLabel = ZH.t(`auto.phase.${phase}`, "MISSING");
      expect(zhLabel, `phase ${phase} has no zh translation`).not.toBe("MISSING");
      expect(html).toContain(zhLabel);
    }
  });

  it("uses a status class the stylesheet actually defines", async () => {
    // An invented class renders an unstyled badge — visually broken but not an
    // error anywhere. Check the class against the stylesheet text.
    const css = fs.readFileSync(path.join(ROOT, "src/renderer/css/style.css"), "utf8");
    const phases = [
      "event-driven", "running", "retry-waiting", "queued", "cooldown",
      "scheduled-once", "missed-once", "scheduled-cron", "invalid-cron",
      "disabled-after-success", "user-disabled",
    ];
    for (const phase of phases) {
      const h = makeHarness({ rules: [rule()], states: [state({ phase, nextRunAt: null })] });
      h.agentBrowser.loadAutomationTab();
      await flush();
      const m = /class="status-badge ([a-z-]+)"/.exec(h.elements["automation-list"].innerHTML);
      expect(m, `no badge for ${phase}`).toBeTruthy();
      expect(css, `${m![1]} is not defined in style.css`).toContain(`.${m![1]} {`);
    }
  });

  it("never renders a missed once as merely 'Enabled'", async () => {
    // The bug M3 removes: config says enabled, reality says dead. The badge
    // must state the reality.
    const h = makeHarness({
      lang: "zh",
      rules: [rule({ enabled: true, trigger: { type: "once", at: 1_600_000_000_000 } })],
      states: [state({ phase: "missed-once", onceAt: 1_600_000_000_000, missedAt: 1_650_000_000_000 })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    const html = h.elements["automation-list"].innerHTML;
    expect(html).toContain(ZH.t("auto.phase.missed-once"));
    expect(html).not.toContain(ZH.t("auto.phase.scheduled-once"));
    // The hint explains that no catch-up will happen.
    expect(html).toContain(ZH.t("auto.missed.hint"));
  });

  it("shows 'no next run' for a dead phase rather than inventing one", async () => {
    const h = makeHarness({
      lang: "zh",
      rules: [rule()],
      states: [state({ phase: "user-disabled", nextRunAt: null })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    expect(h.elements["automation-list"].innerHTML).toContain(ZH.t("auto.row.next.none"));
  });

  it("marks a plan with no results as degraded", async () => {
    const h = makeHarness({
      lang: "zh",
      rules: [rule()],
      states: [state({ phase: "scheduled-cron", nextRunAt: Date.now() + 1000, degraded: true })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    expect(h.elements["automation-list"].innerHTML).toContain(ZH.t("auto.row.plan-none"));
  });

  it("still renders the rules when the state call fails", async () => {
    // A state failure must degrade to "no badge", never hide the rules — the
    // user still needs to edit or delete them.
    const h = makeHarness({ rules: [rule({ name: "Still here" })] });
    h.api.automation.scheduleState = vi.fn(async () => { throw new Error("boom"); });
    h.agentBrowser.loadAutomationTab();
    await flush();
    const html = h.elements["automation-list"].innerHTML;
    expect(html).toContain("Still here");
    expect(html).toContain(EN.t("auto.loading", "Loading..."));
  });
});

describe("M3 renderer: missed-once escape hatches", () => {
  it("offers reschedule + disable, and both are wired to real functions", async () => {
    const h = makeHarness({
      rules: [rule({ trigger: { type: "once", at: 1_600_000_000_000 } })],
      states: [state({ phase: "missed-once", onceAt: 1_600_000_000_000 })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    const html = h.elements["automation-list"].innerHTML;
    expect(html).toContain('data-rule-action="reschedule"');
    expect(html).toContain('data-rule-action="toggle"');
    // The dispatch branch must exist, or the button is dead markup.
    expect(typeof h.agentBrowser.automationReschedule).toBe("function");
  });

  it("does not offer reschedule for a healthy phase", async () => {
    const h = makeHarness({
      rules: [rule()],
      states: [state({ phase: "scheduled-cron", nextRunAt: Date.now() + 1000 })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    expect(h.elements["automation-list"].innerHTML).not.toContain('data-rule-action="reschedule"');
  });

  it("clicking reschedule opens the dialog with a future prefill", async () => {
    const MISSED_AT = Date.now() - 86_400_000 * 3;
    const h = makeHarness({
      rules: [rule({ trigger: { type: "once", at: MISSED_AT } })],
      states: [state({ phase: "missed-once", onceAt: MISSED_AT })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    clickCard(h, "rule_1", "reschedule");
    await flush();
    expect(h.elements["dlg-auto-reschedule"].open).toBe(true);
    expect(h.elements["auto-reschedule-id"].value).toBe("rule_1");
    // The prefill must be in the FUTURE even though the rule was missed days
    // ago — a prefill the backend rejects is a broken dialog.
    const at = new Date(h.elements["auto-reschedule-at"].value).getTime();
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThan(Date.now());
  });

  it("refuses a past time before calling the backend", async () => {
    const h = makeHarness({
      rules: [rule({ trigger: { type: "once", at: 1_600_000_000_000 } })],
      states: [state({ phase: "missed-once", onceAt: 1_600_000_000_000 })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    h.elements["auto-reschedule-id"].value = "rule_1";
    h.elements["auto-reschedule-at"].value = "2020-01-01T00:00:00";
    h.agentBrowser.saveAutomationReschedule();
    await flush();
    expect(h.api.automation.rescheduleOnce).not.toHaveBeenCalled();
    expect(h.toasts.some((x) => x.msg.includes(EN.t("auto.error.reschedule-future")))).toBe(true);
  });

  it("sends the chosen instant and reloads on success", async () => {
    const h = makeHarness({
      rules: [rule({ trigger: { type: "once", at: 1_600_000_000_000 } })],
      states: [state({ phase: "missed-once", onceAt: 1_600_000_000_000 })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    const value = localInput(Date.now() + 3_600_000);
    h.elements["auto-reschedule-id"].value = "rule_1";
    h.elements["auto-reschedule-at"].value = value;
    const callsBefore = h.api.automation.scheduleState.mock.calls.length;
    h.agentBrowser.saveAutomationReschedule();
    await flush();
    expect(h.api.automation.rescheduleOnce).toHaveBeenCalledTimes(1);
    const sent = h.api.automation.rescheduleOnce.mock.calls[0][0];
    expect(sent.ruleId).toBe("rule_1");
    expect(sent.at).toBe(new Date(value).getTime());
    expect(h.elements["dlg-auto-reschedule"].open).toBe(false);
    // The list must be re-read so the card shows the new plan.
    expect(h.api.automation.scheduleState.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("surfaces a backend refusal instead of silently closing", async () => {
    const h = makeHarness({
      rules: [rule({ trigger: { type: "once", at: 1_600_000_000_000 } })],
      states: [state({ phase: "missed-once", onceAt: 1_600_000_000_000 })],
    });
    h.agentBrowser.loadAutomationTab();
    await flush();
    h.api.automation.rescheduleOnce = vi.fn(async () => ({ success: false, error: "rule not found" }));
    // Opened first, so "stayed open on refusal" is distinguishable from
    // "was never open".
    h.agentBrowser.automationReschedule("rule_1");
    await flush();
    expect(h.elements["dlg-auto-reschedule"].open).toBe(true);
    h.elements["auto-reschedule-at"].value = localInput(Date.now() + 3_600_000);
    h.agentBrowser.saveAutomationReschedule();
    await flush();
    // The dialog STAYS open. Closing it on a refusal would discard the time
    // the user just picked while the rule is still missed — the same
    // close-then-lose-the-input bug R15 fixed for the rule editor.
    expect(h.elements["dlg-auto-reschedule"].open).toBe(true);
    expect(h.toasts.some((x) => x.msg.includes("rule not found"))).toBe(true);
  });
});

describe("M3 renderer: terminal alerts", () => {
  it("subscribes to all three automation channels", async () => {
    // A channel missing from preload's allowlist is dropped silently, so an
    // unsubscribed listener is a feature that simply never fires. Assert both
    // halves: the renderer subscribes, and preload allows it through.
    const h = makeHarness();
    for (const ch of ["automation:run-finished", "automation:open-run", "automation:schedule-changed"]) {
      expect(h.channelListeners.get(ch)?.size, `${ch} has no renderer listener`).toBeGreaterThan(0);
      expect(PRELOAD, `${ch} is not on preload's allowlist`).toContain(`"${ch}"`);
    }
  });

  it("toasts the run name and offers a jump to the run", async () => {
    const h = makeHarness();
    const [cb] = [...h.channelListeners.get("automation:run-finished")!];
    cb({ kind: "done", ruleName: "Nightly sweep", runId: "run_42", jobId: "job_1", planId: "plan_a", ruleId: "rule_1" });
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].msg).toContain("Nightly sweep");
    expect(h.toasts[0].type).toBe("success");
    // The action must open THIS run.
    h.toasts[0].opts.action.onClick();
    expect(h.agentBrowser.runsOpen).toHaveBeenCalledWith("run_42");
  });

  it("makes a failure sticky", async () => {
    const h = makeHarness();
    const [cb] = [...h.channelListeners.get("automation:run-finished")!];
    cb({ kind: "failed", ruleName: "Nightly sweep", runId: "run_42" });
    expect(h.toasts[0].type).toBe("error");
    // ttlMs 0 = no auto-dismiss: the one outcome the user must not miss.
    expect(h.toasts[0].opts.ttlMs).toBe(0);
  });

  it("does not offer a run link for a missed-once alert", async () => {
    const h = makeHarness();
    const [cb] = [...h.channelListeners.get("automation:run-finished")!];
    cb({ kind: "missed", ruleName: "Warm-up batch", runId: null });
    expect(h.toasts[0].msg).toContain("Warm-up batch");
    expect(h.toasts[0].opts.action).toBeUndefined();
  });

  it("ignores an unknown kind rather than rendering a bare label", async () => {
    const h = makeHarness();
    const [cb] = [...h.channelListeners.get("automation:run-finished")!];
    cb({ kind: "something-new", ruleName: "X" });
    expect(h.toasts).toHaveLength(0);
  });

  it("opens the run a system notification points at", async () => {
    const h = makeHarness();
    const [cb] = [...h.channelListeners.get("automation:open-run")!];
    cb({ runId: "run_99" });
    expect(h.agentBrowser.runsOpen).toHaveBeenCalledWith("run_99");
    cb({});
    expect(h.agentBrowser.runsOpen).toHaveBeenCalledTimes(1);
  });

  it("labels the toasts from the dictionary in both locales", async () => {
    for (const [lang, dict] of [["en", EN], ["zh", ZH]] as const) {
      const h = makeHarness({ lang });
      const [cb] = [...h.channelListeners.get("automation:run-finished")!];
      cb({ kind: "failed", ruleName: "R", runId: "run_1" });
      const label = dict.t("auto.notify.toast.failed", "MISSING");
      expect(label, `${lang} has no failure label`).not.toBe("MISSING");
      expect(h.toasts[0].msg).toContain(label);
    }
  });
});

describe("M3 renderer: completion-alert settings", () => {
  it("reflects the stored prefs on load", async () => {
    const h = makeHarness();
    h.api.settings.automationNotify = vi.fn(async () => ({ system: true, sound: false }));
    h.agentBrowser.loadAutomationTab();
    await flush();
    expect(h.elements["auto-notify-system"].checked).toBe(true);
    expect(h.elements["auto-notify-sound"].checked).toBe(false);
  });

  it("defaults to OFF when the read fails", async () => {
    const h = makeHarness();
    h.api.settings.automationNotify = vi.fn(async () => { throw new Error("boom"); });
    h.agentBrowser.loadAutomationTab();
    await flush();
    expect(h.elements["auto-notify-system"].checked).toBe(false);
    expect(h.elements["auto-notify-sound"].checked).toBe(false);
  });

  it("saves on change with no save button", async () => {
    const h = makeHarness();
    h.agentBrowser.loadAutomationTab();
    await flush();
    const box = h.elements["auto-notify-system"];
    box.checked = true;
    box.onchange!({} as any);
    await flush();
    expect(h.api.settings.setAutomationNotify).toHaveBeenCalledWith({ system: true, sound: false });
  });

  it("reports a save failure instead of pretending it worked", async () => {
    const h = makeHarness();
    h.agentBrowser.loadAutomationTab();
    await flush();
    h.api.settings.setAutomationNotify = vi.fn(async () => ({ success: false, error: "nope" }));
    const box = h.elements["auto-notify-sound"];
    box.checked = true;
    box.onchange!({} as any);
    await flush();
    expect(h.elements["auto-notify-status"].innerHTML).toContain("nope");
  });
});

describe("M3 renderer: markup contracts", () => {
  it("has every label the settings card renders in the dictionary", () => {
    // data-i18n on a key that does not exist renders the English fallback in
    // the zh UI — invisible to a key-parity check that only compares tables.
    for (const key of [
      "auto.notify.settings.title", "auto.notify.settings.system",
      "auto.notify.settings.system-hint", "auto.notify.settings.sound",
      "auto.notify.settings.sound-hint",
    ]) {
      expect(INDEX_HTML, `${key} is not used in the markup`)
        .toMatch(new RegExp(`data-i18n(-title|-aria-label)?="${key}"`));
      expect(ZH.t(key, "MISSING"), `${key} missing from zh`).not.toBe("MISSING");
      expect(EN.t(key, "MISSING"), `${key} missing from en`).not.toBe("MISSING");
      expect(ZH.t(key), `${key} is identical in zh and en`).not.toBe(EN.t(key));
    }
    // auto.notify.saved is written by JS into #auto-notify-status, so it has
    // no data-i18n carrier — it is asserted against the source instead.
    expect(AUTOMATION).toContain(`t('auto.notify.saved'`);
    for (const key of ["auto.notify.saved"]) {
      expect(ZH.t(key, "MISSING"), `${key} missing from zh`).not.toBe("MISSING");
      expect(EN.t(key, "MISSING"), `${key} missing from en`).not.toBe("MISSING");
      expect(ZH.t(key), `${key} is identical in zh and en`).not.toBe(EN.t(key));
    }
  });

  it("wires the reschedule form to a real command", () => {
    expect(INDEX_HTML).toContain('data-submit-cmd="saveAutomationReschedule"');
    const h = makeHarness();
    expect(typeof h.agentBrowser.saveAutomationReschedule).toBe("function");
    expect(typeof h.agentBrowser.automationReschedule).toBe("function");
  });

  it("keeps the reschedule dialog's own labels translated", () => {
    for (const key of [
      "auto.dlg.reschedule.title", "auto.dlg.reschedule.label",
      "auto.dlg.reschedule.hint", "auto.dlg.reschedule.submit",
    ]) {
      expect(INDEX_HTML, `${key} is not used in the markup`)
        .toMatch(new RegExp(`data-i18n(-title|-aria-label)?="${key}"`));
      expect(ZH.t(key, "MISSING")).not.toBe("MISSING");
      expect(EN.t(key, "MISSING")).not.toBe("MISSING");
    }
  });
});
