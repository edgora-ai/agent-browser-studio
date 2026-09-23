// M2 renderer regressions for the Runs surface: five-state verification,
// untrusted-text rendering, the six filters, preview pagination + the
// stale-response guard, the two-phase export, and the run-detail id space.
//
// There is no jsdom/happy-dom in this repo (grep: no matches), so this loads
// src/renderer/js/app/runs.js into a `vm` context backed by a hand-rolled
// element stub, the same pattern tests/unit/renderer-agent-m1.test.ts uses.
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(__dirname, "../..");
const RUNS = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/runs.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const I18N_RENDERER = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");

/** Load the real i18n runtime rather than stubbing t(). A stub that returns
 *  its own fallback cannot tell "translated" from "key missing" — the failure
 *  mode this whole check exists to catch. Same DOM shim as
 *  tests/unit/i18n.test.ts. */
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

const I18N = loadI18n("en-US");
/** Real rendered label for a key — lets a test assert on the copy the user
 *  actually sees while keeping the key as the thing under test. */
const label = (key: string, fallback?: string) => I18N.t(key, fallback);

/** selectors the delegated detail handler passes to closest(); the stub
 *  matches a selector when the element carries any of the listed data-*. */
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
  fire(type: string, event: any) { for (const fn of this.listeners[type] || []) fn(event); }
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

/** A stand-in for a button that only exists as parsed innerHTML, so the
 *  delegated handler can be driven without an HTML parser. It is appended to
 *  the dialog because the handler guards on `dlg.contains(target)`, and it
 *  answers `closest("[data-artifact-id]")` with a synthetic card, because in
 *  the real DOM the button nests inside `<div class="run-artifact"
 *  data-artifact-id="…">` and that ancestor is where the id comes from. */
function clickDialog(
  h: ReturnType<typeof makeHarness>,
  dataset: Record<string, string>,
  opts: { artifactId?: string } = {},
) {
  const card = { dataset: { artifactId: opts.artifactId ?? "" } };
  const btn: any = {
    dataset,
    closest(selector: string) {
      const wanted = selectorsOf(selector);
      if (wanted.includes("artifactId")) return "artifactId" in card.dataset && card.dataset.artifactId ? card : null;
      return wanted.some((attr) => attr in dataset) ? this : null;
    },
  };
  h.elements["dlg-agent-run"].appendChild(btn);
  h.elements["dlg-agent-run"].fire("click", { target: btn });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const IDS = [
  "agent-run-list", "agent-run-verification-block", "agent-run-verification-counts",
  "agent-run-verification-issues", "agent-run-artifacts", "agent-run-preview",
  "agent-run-detail-actions", "agent-run-title", "agent-run-title-sep", "agent-run-meta",
  "agent-run-vars", "agent-run-steps", "dlg-agent-run",
  "run-filter-name", "run-filter-range", "run-filter-source", "run-filter-profile",
  "run-filter-endReason", "run-filter-verification", "run-filter-summary",
];

function makeRun(over: Record<string, any> = {}) {
  return {
    id: "run-1",
    name: "Nightly sweep",
    status: "done",
    endReason: "completed",
    dirId: "profile_a",
    startedAt: Date.now() - 5000,
    finishedAt: Date.now() - 1000,
    stepCount: 3,
    steps: [],
    variables: {},
    source: { type: "automation", ruleId: "rule-1", ruleName: "Nightly sweep" },
    verification: { status: "passed" },
    artifacts: [],
    ...over,
  };
}

function makeHarness() {
  const elements: Record<string, FakeElement> = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id)]));
  const filterRow = new FakeElement("run-filters");
  const channelListeners = new Map<string, Set<(payload: any) => void>>();

  const previewCalls: Array<{ args: any; d: ReturnType<typeof deferred<any>> }> = [];
  const exportWriteCalls: any[] = [];

  const api: any = {
    agentRuns: {
      list: vi.fn(async () => [] as any[]),
      get: vi.fn(async () => null as any),
      resultsPreview: vi.fn((args: any) => {
        const d = deferred<any>();
        previewCalls.push({ args, d });
        return d.promise;
      }),
      exportPlan: vi.fn(async () => ({
        ok: true,
        plan: { kind: "dataset-csv", columns: ["title", "url"], rowCount: 18, bytes: 2048, suggestedName: "run-1.csv", warnings: [] },
      })),
      exportWrite: vi.fn(async (args: any) => { exportWriteCalls.push(args); return { ok: true, bytes: 2048, path: "/tmp/out.csv" }; }),
      delete: vi.fn(async () => ({ success: true })),
      clear: vi.fn(async () => ({ success: true, deleted: 0 })),
    },
    automation: { retryRun: vi.fn(async () => ({ ok: true, runId: "run-new" })), retryJob: vi.fn(async () => ({ attempted: 0, failed: [], succeeded: 0 })) },
    on(channel: string, cb: (payload: any) => void) {
      if (!channelListeners.has(channel)) channelListeners.set(channel, new Set());
      channelListeners.get(channel)!.add(cb);
    },
    removeListener(channel: string, cb: (payload: any) => void) { channelListeners.get(channel)?.delete(cb); },
  };

  const helpers: any = {
    toast: vi.fn(),
    // Mirrors core.js esc(): a text node's innerHTML escapes & < > and nbsp.
    esc: (value: unknown) => (value ? String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : ""),
    escAttr: (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    icon: (name: string) => `<svg data-icon="${name}"></svg>`,
    fmtDuration: (ms: number) => `${ms}ms`,
    relTime: (ts: number) => `rel:${ts}`,
  };

  const agentBrowser: any = {
    api,
    state: { currentTab: "runs" },
    helpers,
    ipc: { call: (_key: string, fn: () => Promise<any>) => fn() },
    confirm: vi.fn((_message: string, onOk: () => void) => onOk()),
  };

  const document: any = {
    readyState: "complete",
    hidden: false,
    documentElement: { lang: "en" },
    getElementById: (id: string) => elements[id] || null,
    querySelector: (selector: string) => (selector === ".run-filters" ? filterRow : null),
    querySelectorAll: () => [],
    createElement: () => new FakeElement("div"),
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  const window: any = { agentBrowser, i18n: I18N };
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
  vm.runInContext(RUNS, context);
  return { window, document, elements, api, agentBrowser, filterRow, previewCalls, exportWriteCalls, channelListeners };
}

describe("M2 renderer: verification five-state rendering", () => {
  it("maps each known status and degrades anything else to unverified", () => {
    const h = makeHarness();
    const view = h.agentBrowser.verificationView;
    for (const status of ["unverified", "passed", "partial", "failed", "manual_review"]) {
      expect(view.status({ verification: { status } })).toBe(status);
    }
    // A legacy record, a foreign config, or a half-written value must never
    // render as a pass. The only honest answer is unverified.
    for (const bogus of ["ok", "PASSED", "", null, undefined, "manual-review", "unverified-ish"]) {
      expect(view.status({ verification: { status: bogus } })).toBe("unverified");
    }
    expect(view.status({})).toBe("unverified");
    expect(view.status(null)).toBe("unverified");
    expect(view.status({ verification: null })).toBe("unverified");
    // Prototype keys are not statuses.
    expect(view.status({ verification: { status: "constructor" } })).toBe("unverified");
    expect(view.status({ verification: { status: "hasOwnProperty" } })).toBe("unverified");
  });

  it("gives partial and manual_review a distinct non-success class", () => {
    const h = makeHarness();
    const meta = h.agentBrowser.verificationView.meta;
    expect(meta.passed.cls).toBe("status-done");
    expect(meta.partial.cls).not.toBe(meta.passed.cls);
    expect(meta.failed.cls).toBe("status-failed");
    expect(meta.manual_review.cls).not.toBe(meta.passed.cls);
    expect(new Set(Object.values(meta).map((m: any) => m.cls)).size).toBeGreaterThanOrEqual(4);
  });

  it("stamps the resolved status on the badge for styling and queries", () => {
    const h = makeHarness();
    const html = h.agentBrowser.verificationView.badgeHtml({ verification: { status: "partial" } });
    expect(html).toContain('data-verification="partial"');
    expect(html).toContain("run-verification");
    const fallback = h.agentBrowser.verificationView.badgeHtml({ verification: { status: "weird" } });
    expect(fallback).toContain('data-verification="unverified"');
  });
});

describe("M2 renderer: untrusted run content is text only", () => {
  it("renders a hostile run name and rule name as text, not markup", async () => {
    const h = makeHarness();
    const payload = `<img src=x onerror="alert(1)">`;
    h.api.agentRuns.list.mockResolvedValue([
      makeRun({ name: payload, source: { type: "automation", ruleId: "rule-1", ruleName: `"><script>alert(2)</script>` } }),
    ]);
    await h.agentBrowser.loadRunsTab();
    await flush();

    const html = h.elements["agent-run-list"].innerHTML;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps hostile artifact names, columns and cells out of the DOM tree", async () => {
    const h = makeHarness();
    const hostile = `<img src=x onerror="alert(1)">`;
    const run = makeRun({
      artifacts: [{
        id: "art-1", kind: "dataset", name: hostile, mediaType: "application/json",
        createdAt: Date.now(), bytes: 512, sha256: "a".repeat(64), completeness: "complete",
        truncated: false, rowCount: 2, columns: [hostile], redactedColumns: [],
        exportPolicy: "csv",
      }],
    });
    h.api.agentRuns.get.mockResolvedValue(run);
    await h.agentBrowser.runsOpen("run-1");
    await flush();

    expect(h.elements["agent-run-artifacts"].innerHTML).not.toContain("<img");
    expect(h.elements["agent-run-artifacts"].innerHTML).toContain("&lt;img");

    // Fire the preview through the delegated dialog handler.
    clickDialog(h, { artifactAction: "preview" }, { artifactId: "art-1" });
    await flush();
    const pending = h.previewCalls.at(-1)!;
    pending.d.resolve({
      ok: true, total: 1, columns: [hostile], rows: [[hostile]], truncated: false, rejectedRowCount: 0,
    });
    await flush();

    const preview = h.elements["agent-run-preview"].innerHTML;
    expect(preview).not.toContain("<img");
    expect(preview).toContain("&lt;img");
  });

  it("shows an integrity failure as an error and renders no rows at all", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      artifacts: [{ id: "art-1", kind: "dataset", name: "news", mediaType: "application/json", createdAt: 1, bytes: 10, sha256: "b".repeat(64), completeness: "complete", truncated: false, rowCount: 2, columns: ["url"], redactedColumns: [], exportPolicy: "csv" }],
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    clickDialog(h, { artifactAction: "preview" }, { artifactId: "art-1" });
    await flush();
    h.previewCalls.at(-1)!.d.resolve({ ok: false, error: "artifact integrity check failed" });
    await flush();

    const preview = h.elements["agent-run-preview"].innerHTML;
    expect(preview).toContain("artifact integrity check failed");
    expect(preview).not.toContain("<table");
    expect(preview).not.toContain("&lt;tr");
  });
});

describe("M2 renderer: preview pagination and stale responses", () => {
  it("drops a preview that resolves after the user moved to another run", async () => {
    const h = makeHarness();
    const art = (id: string) => ({
      id, kind: "dataset", name: id, mediaType: "application/json", createdAt: 1, bytes: 10,
      sha256: "c".repeat(64), completeness: "complete", truncated: false, rowCount: 1,
      columns: ["url"], redactedColumns: [], exportPolicy: "csv",
    });
    h.api.agentRuns.get.mockImplementation(async (id: string) => makeRun({
      id, name: id, artifacts: [art(`${id}-art`)],
    }));

    // Open run A and ask for its preview; the main process is slow.
    await h.agentBrowser.runsOpen("run-a");
    await flush();
    clickDialog(h, { artifactAction: "preview" }, { artifactId: "run-a-art" });
    await flush();
    const slow = h.previewCalls.at(-1)!;
    expect(slow.args.runId).toBe("run-a");

    // The user opens run B and its preview answers first.
    await h.agentBrowser.runsOpen("run-b");
    await flush();
    clickDialog(h, { artifactAction: "preview" }, { artifactId: "run-b-art" });
    await flush();
    const fast = h.previewCalls.at(-1)!;
    expect(fast.args.runId).toBe("run-b");
    fast.d.resolve({ ok: true, total: 1, columns: ["url"], rows: [["https://b.example"]], truncated: false, rejectedRowCount: 0 });
    await flush();
    expect(h.elements["agent-run-preview"].innerHTML).toContain("https://b.example");

    // Now the stale response lands. It must be discarded, not painted.
    slow.d.resolve({ ok: true, total: 1, columns: ["url"], rows: [["https://a.example"]], truncated: false, rejectedRowCount: 0 });
    await flush();
    const preview = h.elements["agent-run-preview"].innerHTML;
    expect(preview).toContain("https://b.example");
    expect(preview).not.toContain("https://a.example");
  });

  it("pages with the artifact the user opened, not the last one rendered", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      artifacts: [{ id: "art-1", kind: "dataset", name: "news", mediaType: "application/json", createdAt: 1, bytes: 10, sha256: "d".repeat(64), completeness: "complete", truncated: false, rowCount: 250, columns: ["url"], redactedColumns: [], exportPolicy: "csv" }],
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    clickDialog(h, { artifactAction: "preview" }, { artifactId: "art-1" });
    await flush();
    expect(h.previewCalls.at(-1)!.args).toMatchObject({ runId: "run-1", artifactId: "art-1", offset: 0, limit: 100 });
    h.previewCalls.at(-1)!.d.resolve({ ok: true, total: 250, columns: ["url"], rows: [["x"]], truncated: false, rejectedRowCount: 0 });
    await flush();

    // The pager must carry the same artifactId forward.
    clickDialog(h, { previewPage: "next" });
    await flush();
    const call = h.previewCalls.at(-1)!.args;
    expect(call.artifactId).toBe("art-1");
    expect(call.offset).toBe(100);
  });

  it("never asks for more than the main process will accept", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      artifacts: [{ id: "art-1", kind: "dataset", name: "news", mediaType: "application/json", createdAt: 1, bytes: 10, sha256: "e".repeat(64), completeness: "complete", truncated: false, rowCount: 5000, columns: ["url"], redactedColumns: [], exportPolicy: "csv" }],
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    clickDialog(h, { artifactAction: "preview" }, { artifactId: "art-1" });
    await flush();
    expect(h.previewCalls.at(-1)!.args.limit).toBeLessThanOrEqual(100);
    expect(h.previewCalls.at(-1)!.args.limit).toBeGreaterThan(0);
  });
});

describe("M2 renderer: two-phase export", () => {
  it("shows the plan before writing, and only writes after confirmation", async () => {
    const h = makeHarness();
    // Hold the confirmation open: the write must not happen while the user is
    // still deciding.
    let releaseConfirm: (() => void) | null = null;
    h.agentBrowser.confirm.mockImplementation((_message: string, onOk: () => void) => { releaseConfirm = onOk; });
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      artifacts: [{ id: "art-1", kind: "dataset", name: "news", mediaType: "application/json", createdAt: 1, bytes: 2048, sha256: "f".repeat(64), completeness: "partial", truncated: true, rowCount: 18, columns: ["title", "url"], redactedColumns: [], exportPolicy: "csv" }],
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    clickDialog(h, { artifactAction: "export" }, { artifactId: "art-1" });
    await flush();

    expect(h.api.agentRuns.exportPlan).toHaveBeenCalledWith({ runId: "run-1", artifactId: "art-1", kind: "dataset-csv" });
    // Untouched while the dialog is open — this is the whole point of the
    // two-phase design.
    expect(h.api.agentRuns.exportWrite).toHaveBeenCalledTimes(0);

    // The confirmation must name the file and the shape of the data.
    const msg = h.agentBrowser.confirm.mock.calls.at(-1)![0] as string;
    expect(msg).toContain("run-1.csv");
    expect(msg).toContain("18");

    releaseConfirm!();
    await flush();
    expect(h.api.agentRuns.exportWrite).toHaveBeenCalledTimes(1);
    expect(h.exportWriteCalls.at(-1)).toMatchObject({ runId: "run-1", artifactId: "art-1", kind: "dataset-csv" });
  });

  it("does not write when the user dismisses the confirmation", async () => {
    const h = makeHarness();
    h.agentBrowser.confirm.mockImplementation(() => { /* not confirmed */ });
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      artifacts: [{ id: "art-1", kind: "dataset", name: "news", mediaType: "application/json", createdAt: 1, bytes: 2048, sha256: "0".repeat(64), completeness: "complete", truncated: false, rowCount: 3, columns: ["url"], redactedColumns: [], exportPolicy: "csv" }],
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    clickDialog(h, { artifactAction: "export" }, { artifactId: "art-1" });
    await flush();
    expect(h.api.agentRuns.exportPlan).toHaveBeenCalledTimes(1);
    expect(h.api.agentRuns.exportWrite).toHaveBeenCalledTimes(0);
  });

  it("treats a cancelled save dialog as a no-op, not a failure", async () => {
    const h = makeHarness();
    h.api.agentRuns.exportWrite.mockResolvedValue({ ok: false, reasonCode: "cancelled" });
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      artifacts: [{ id: "art-1", kind: "dataset", name: "news", mediaType: "application/json", createdAt: 1, bytes: 2048, sha256: "1".repeat(64), completeness: "complete", truncated: false, rowCount: 3, columns: ["url"], redactedColumns: [], exportPolicy: "csv" }],
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    clickDialog(h, { artifactAction: "export" }, { artifactId: "art-1" });
    await flush();
    await flush();
    const errors = h.agentBrowser.helpers.toast.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errors).toEqual([]);
  });

  it("surfaces a plan failure instead of pretending the export ran", async () => {
    const h = makeHarness();
    h.api.agentRuns.exportPlan.mockResolvedValue({ ok: false, error: "artifact integrity check failed" });
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      artifacts: [{ id: "art-1", kind: "dataset", name: "news", mediaType: "application/json", createdAt: 1, bytes: 2048, sha256: "2".repeat(64), completeness: "complete", truncated: false, rowCount: 3, columns: ["url"], redactedColumns: [], exportPolicy: "csv" }],
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    clickDialog(h, { artifactAction: "export" }, { artifactId: "art-1" });
    await flush();
    await flush();
    expect(h.api.agentRuns.exportWrite).toHaveBeenCalledTimes(0);
    const errors = h.agentBrowser.helpers.toast.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errors.length).toBe(1);
    expect(String(errors[0][0])).toContain("artifact integrity check failed");
  });

  it("offers the summary export only when the run actually kept artifacts", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({ artifacts: [] }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    expect(h.elements["agent-run-detail-actions"].innerHTML).not.toContain("export-summary");

    h.api.agentRuns.get.mockResolvedValue(makeRun({
      artifacts: [{ id: "art-1", kind: "dataset", name: "news", mediaType: "application/json", createdAt: 1, bytes: 8, sha256: "3".repeat(64), completeness: "complete", truncated: false, rowCount: 1, columns: ["url"], redactedColumns: [], exportPolicy: "csv" }],
    }));
    await h.agentBrowser.runsOpen("run-2");
    await flush();
    expect(h.elements["agent-run-detail-actions"].innerHTML).toContain("export-summary");
  });
});

describe("M2 renderer: re-run availability", () => {
  const terminalAutomation = () => makeRun({ id: "run-t", status: "done" });
  const runningAutomation = () => makeRun({ id: "run-r", status: "running", finishedAt: undefined });
  const chatRun = () => makeRun({ id: "run-c", status: "done", source: { type: "chat" } });

  it("offers re-run for a terminal automation run and withholds it otherwise", async () => {
    const h = makeHarness();
    for (const [run, expected] of [[terminalAutomation(), true], [runningAutomation(), false], [chatRun(), false]] as const) {
      h.api.agentRuns.get.mockResolvedValue(run);
      await h.agentBrowser.runsOpen(run.id);
      await flush();
      const html = h.elements["agent-run-detail-actions"].innerHTML;
      expect(html.includes("data-detail-action=\"retry\""), `${run.id} retry=${expected}`).toBe(expected);
    }
  });

  it("shows the re-run badge on a run that itself replaced an earlier one", async () => {
    const h = makeHarness();
    h.api.agentRuns.list.mockResolvedValue([
      makeRun({ id: "run-2", source: { type: "automation", ruleId: "r", ruleName: "N", retryOf: "run-1" } }),
    ]);
    await h.agentBrowser.loadRunsTab();
    await flush();
    const html = h.elements["agent-run-list"].innerHTML;
    expect(html).toContain('data-run-id="run-2"');
    // The badge is rendered from source.retryOf, not from a name suffix.
    expect(html).toContain(label("runs.retry-tag", "Retry"));
    expect(html).not.toContain("（重试）");
  });
});

describe("M2 renderer: six filters", () => {
  const LIST = [
    makeRun({ id: "r-pass", name: "News daily", dirId: "profile_a", status: "done", verification: { status: "passed" }, source: { type: "automation", ruleId: "rule-1", ruleName: "News daily" } }),
    makeRun({ id: "r-part", name: "News hourly", dirId: "profile_b", status: "done", verification: { status: "partial" }, source: { type: "automation", ruleId: "rule-2", ruleName: "News hourly" } }),
    makeRun({ id: "r-fail", name: "Prices", dirId: "profile_a", status: "error", endReason: undefined, verification: { status: "failed" }, source: { type: "automation", ruleId: "rule-3", ruleName: "Prices" } }),
    makeRun({ id: "r-chat", name: "Chat about prices", dirId: "profile_a", status: "done", verification: undefined, source: { type: "chat" } }),
    makeRun({ id: "r-old", name: "Ancient", dirId: "profile_a", status: "done", startedAt: Date.now() - 40 * 86400e3, verification: { status: "manual_review" }, source: { type: "automation", ruleId: "rule-4", ruleName: "Ancient" } }),
  ];

  async function renderWith(h: ReturnType<typeof makeHarness>, set: Record<string, string>) {
    h.api.agentRuns.list.mockResolvedValue(LIST);
    for (const [id, value] of Object.entries(set)) h.elements[id].value = value;
    await h.agentBrowser.loadRunsTab();
    await flush();
    return h.elements["agent-run-list"].innerHTML;
  }

  function idsIn(html: string): string[] {
    return [...html.matchAll(/data-run-id="([^"]+)"/g)].map((m) => m[1]).sort();
  }

  it("filters by each verification state, including the unverified default", async () => {
    const h = makeHarness();
    expect(idsIn(await renderWith(h, { "run-filter-verification": "passed" }))).toEqual(["r-pass"]);
    expect(idsIn(await renderWith(h, { "run-filter-verification": "partial" }))).toEqual(["r-part"]);
    expect(idsIn(await renderWith(h, { "run-filter-verification": "failed" }))).toEqual(["r-fail"]);
    expect(idsIn(await renderWith(h, { "run-filter-verification": "manual_review" }))).toEqual(["r-old"]);
    // A run with no verification at all is unverified, not "no match".
    expect(idsIn(await renderWith(h, { "run-filter-verification": "unverified" }))).toEqual(["r-chat"]);
    expect(h.elements["run-filter-verification"].value).toBe("unverified");
  });

  it("filters by source and by end reason, keeping 'none' distinct", async () => {
    const h = makeHarness();
    expect(idsIn(await renderWith(h, { "run-filter-verification": "all", "run-filter-source": "chat" }))).toEqual(["r-chat"]);
    expect(idsIn(await renderWith(h, { "run-filter-source": "automation" }))).toEqual(["r-fail", "r-old", "r-part", "r-pass"]);
    // r-fail carries no endReason at all; "none" must isolate it.
    expect(idsIn(await renderWith(h, { "run-filter-source": "all", "run-filter-endReason": "none" }))).toEqual(["r-fail"]);
    expect(idsIn(await renderWith(h, { "run-filter-endReason": "completed" }))).toEqual(["r-chat", "r-old", "r-part", "r-pass"]);
  });

  it("filters by profile and by name substring across name and rule name", async () => {
    const h = makeHarness();
    expect(idsIn(await renderWith(h, { "run-filter-endReason": "all", "run-filter-profile": "profile_b" }))).toEqual(["r-part"]);
    // "Chat about prices" matches by run name, "Prices" by its own name; both
    // contain the needle, and the rule name is searched too.
    const prices = idsIn(await renderWith(h, { "run-filter-profile": "all", "run-filter-name": "prices" }));
    expect(prices).toEqual(["r-chat", "r-fail"]);
  });

  it("applies the time range against startedAt", async () => {
    const h = makeHarness();
    expect(idsIn(await renderWith(h, { "run-filter-range": "7d" }))).not.toContain("r-old");
    expect(idsIn(await renderWith(h, { "run-filter-range": "30d" }))).not.toContain("r-old");
    expect(idsIn(await renderWith(h, { "run-filter-range": "all" }))).toContain("r-old");
  });

  it("combines filters conjunctively and reports the counts", async () => {
    const h = makeHarness();
    const html = await renderWith(h, {
      "run-filter-range": "all", "run-filter-verification": "all", "run-filter-name": "news",
      "run-filter-source": "automation", "run-filter-profile": "profile_a",
    });
    expect(idsIn(html)).toEqual(["r-pass"]);
    expect(h.elements["run-filter-summary"].textContent).toContain("1");
    expect(h.elements["run-filter-summary"].textContent).toContain("5");
  });

  it("says a filter matched nothing rather than claiming an empty history", async () => {
    const h = makeHarness();
    const html = await renderWith(h, { "run-filter-name": "no-such-run" });
    expect(idsIn(html)).toEqual([]);
    expect(html).toContain(label("runs.filter.no-match", "No runs match the current filters."));
    expect(html).not.toContain(label("runs.empty-state", "No runs yet."));
  });

  it("offers the live profile options and keeps an existing selection", async () => {
    const h = makeHarness();
    await renderWith(h, { "run-filter-name": "" });
    const sel = h.elements["run-filter-profile"];
    expect(sel.innerHTML).toContain("profile_a");
    expect(sel.innerHTML).toContain("profile_b");
    expect(sel.innerHTML).not.toContain("profile_zzz");
    sel.innerHTML = "";
    await renderWith(h, { "run-filter-profile": "profile_b" });
    expect(sel.value).toBe("profile_b");
  });

  it("keeps the filter state across a live refresh", async () => {
    const h = makeHarness();
    await renderWith(h, { "run-filter-verification": "passed" });
    expect(idsIn(h.elements["agent-run-list"].innerHTML)).toEqual(["r-pass"]);
    // A live run:run-finish event re-runs the loader; the select still reads
    // "passed", so the filtered view must survive.
    const listeners = h.channelListeners.get("agent:run-finish") || new Set();
    expect(listeners.size).toBeGreaterThan(0);
    for (const cb of listeners) cb({ runId: "r-pass" });
    await flush();
    expect(idsIn(h.elements["agent-run-list"].innerHTML)).toEqual(["r-pass"]);
    expect(h.elements["run-filter-verification"].value).toBe("passed");
  });
});

describe("M2 renderer: conclusion layer", () => {
  it("labels the execution verdict and the business verdict separately", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      status: "done",
      endReason: "round_limit",
      verification: {
        status: "partial", verifierId: "news-collect.dataset", verifierVersion: 1, checkedAt: Date.now(),
        counts: { expected: 20, observed: 20, inspected: 20, accepted: 18, rejected: 2, missing: 0, extra: 0 },
        issues: [{ code: "invalid_url", field: "url", detail: "not http(s)" }],
        issuesTruncated: false,
      },
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();

    const block = h.elements["agent-run-verification-block"].innerHTML;
    expect(block).toContain(label("runs.conclusion.exec-status", "Execution"));
    expect(block).toContain(label("runs.conclusion.business-status", "Acceptance"));
    expect(block).toContain('data-verification="partial"');
    expect(block).toContain("news-collect.dataset");
    // A round-limited run still reports a business verdict — the two layers
    // do not overwrite each other.
    const meta = h.elements["agent-run-meta"].innerHTML;
    expect(meta).toContain(label("agent.end.round-limit", "Round limit reached"));

    const counts = h.elements["agent-run-verification-counts"].innerHTML;
    for (const value of ["20", "18", "2", "0"]) expect(counts).toContain(value);

    const issues = h.elements["agent-run-verification-issues"].innerHTML;
    expect(issues).toContain("invalid_url");
    expect(issues).toContain(label("runs.issues.title", "Issues").slice(0, 6));
  });

  it("renders no counts for unverified and never invents them", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({ verification: { status: "unverified" } }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    expect(h.elements["agent-run-verification-counts"].innerHTML).toBe("");
    expect(h.elements["agent-run-verification-issues"].innerHTML).toBe("");
    expect(h.elements["agent-run-verification-block"].innerHTML).toContain('data-verification="unverified"');
  });

  it("renders no counts for a legacy verdict that claims a pass without them", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({ verification: { status: "passed" } }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    expect(h.elements["agent-run-verification-counts"].innerHTML).toBe("");
  });

  it("shows the manual-review reason code through its own label", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      verification: { status: "manual_review", reasonCode: "input_unavailable" },
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    const block = h.elements["agent-run-verification-block"].innerHTML;
    expect(block).toContain(label("runs.manual.input_unavailable", "input_unavailable"));
    expect(block).toContain('data-verification="manual_review"');
  });

  it("escapes a hostile artifact warning and issue detail", async () => {
    const h = makeHarness();
    h.api.agentRuns.get.mockResolvedValue(makeRun({
      verification: {
        status: "failed", verifierId: `<img src=x onerror=alert(1)>`, verifierVersion: 1, checkedAt: Date.now(),
        counts: { expected: 3, observed: 0, inspected: 0, accepted: 0, rejected: 0, missing: 3, extra: 0 },
        issues: [{ code: "missing_row", detail: `<script>alert(2)</script>` }], issuesTruncated: false,
      },
    }));
    await h.agentBrowser.runsOpen("run-1");
    await flush();
    const all = h.elements["agent-run-verification-block"].innerHTML + h.elements["agent-run-verification-issues"].innerHTML;
    expect(all).not.toContain("<img");
    expect(all).not.toContain("<script>");
  });
});

describe("M2 renderer: id space", () => {
  it("keeps every element id unique in index.html", () => {
    const seen = new Map<string, number[]>();
    for (const m of INDEX_HTML.matchAll(/\sid="([^"]+)"/g)) {
      const line = INDEX_HTML.slice(0, m.index).split("\n").length;
      seen.set(m[1], [...(seen.get(m[1]) || []), line]);
    }
    const dupes = [...seen.entries()].filter(([, lines]) => lines.length > 1);
    expect(dupes.map(([id, lines]) => `${id} @ ${lines.join(",")}`)).toEqual([]);
  });

  it("does not read the live agent strip's element from the run detail", () => {
    // Regression: the M2 dialog block reused `agent-run-verification`, the id
    // of the strip <span> that agent-chat.js writes textContent into. Both
    // writers resolved to the same first-in-tree node, so opening a run
    // detail replaced the live strip's text with the conclusion rows.
    expect(INDEX_HTML).toContain('id="agent-run-verification"');
    expect(INDEX_HTML).toContain('id="agent-run-verification-block"');
    expect(RUNS).not.toContain('getElementById("agent-run-verification")');
    expect(RUNS).toContain('getElementById("agent-run-verification-block")');
    // Every id runs.js touches for the detail must actually exist.
    for (const id of [
      "agent-run-verification-block", "agent-run-verification-counts", "agent-run-verification-issues",
      "agent-run-artifacts", "agent-run-preview", "agent-run-detail-actions", "agent-run-title",
      "agent-run-vars", "agent-run-steps", "dlg-agent-run",
      "run-filter-name", "run-filter-range", "run-filter-source", "run-filter-profile",
      "run-filter-endReason", "run-filter-verification", "run-filter-summary",
    ]) {
      expect(INDEX_HTML, `missing #${id}`).toContain(`id="${id}"`);
    }
  });
});

describe("M2 renderer: i18n wiring", () => {
  const M2_KEY = /^(runs\.|agent\.run\.(passed|partial|failed|manual-review|unverified)$|agent\.end\.|common\.(prev|next)$)/;

  /** Keys that appear more than once across dict/extraDict/auditFixDict. */
  function duplicates(source: string): Map<string, string[]> {
    const blocks: string[] = [];
    for (const m of source.matchAll(/^\s*var (dict|extraDict|auditFixDict) = \{/gm)) {
      let i = source.indexOf("{", m.index);
      let depth = 0;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") { depth--; if (depth === 0) break; }
      }
      blocks.push(source.slice(source.indexOf("{", m.index), i));
    }
    const dupes = new Map<string, string[]>();
    for (const locale of ["zh-CN", "en-US"]) {
      const counts = new Map<string, number>();
      for (const block of blocks) {
        const at = block.indexOf(`"${locale}": {`);
        if (at === -1) continue;
        let start = block.indexOf("{", at);
        let depth = 0;
        let end = -1;
        for (let i = start; i < block.length; i++) {
          if (block[i] === "{") depth++;
          else if (block[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        const body = block.slice(start, end);
        for (const km of body.matchAll(/^\s*"([A-Za-z0-9_.\-]+)"\s*:\s*"/gm)) {
          counts.set(km[1], (counts.get(km[1]) || 0) + 1);
        }
      }
      for (const [key, n] of counts) {
        if (n > 1) dupes.set(key, [...(dupes.get(key) || []), `${locale}x${n}`]);
      }
    }
    return dupes;
  }

  it("defines every M2 key in both locales, exactly once", () => {
    const dupes = duplicates(I18N_RENDERER);
    const shadowed = [...dupes.keys()].filter((key) => M2_KEY.test(key));
    expect(shadowed, `M2 keys shadowed by a later dict block: ${shadowed.join(", ")}`).toEqual([]);
  });

  it("defines each M2 key in zh-CN and en-US", () => {
    for (const key of [
      "runs.layer.conclusion", "runs.layer.results", "runs.layer.diagnostics",
      "runs.conclusion.exec-status", "runs.conclusion.business-status", "runs.conclusion.verifier",
      "runs.counts.expected", "runs.counts.accepted", "runs.counts.rejected",
      "runs.artifact.export-summary", "runs.artifact.export", "runs.artifact.preview",
      "runs.preview.error", "runs.preview.truncated", "runs.preview.rejected",
      "runs.export.confirm", "runs.export.done", "runs.export.failed",
      "runs.filter.name", "runs.filter.no-match", "runs.filter.all-shown", "runs.filter.filtered",
      "runs.btn.rerun", "runs.issues.title", "runs.manual.input_unavailable",
      "agent.run.passed", "agent.run.partial", "agent.run.failed", "agent.run.manual-review",
      "common.prev", "common.next",
    ]) {
      expect(I18N_RENDERER, `missing ${key}`).toContain(`"${key}":`);
    }
  });

  it("keeps the root i18n copy byte-identical to the renderer copy", () => {
    // The build stages the root file; a drifting copy is how a translation
    // silently reverts in the packaged app.
    const root = fs.readFileSync(path.join(ROOT, "i18n.js"));
    expect(root.equals(Buffer.from(I18N_RENDERER))).toBe(true);
  });
});
