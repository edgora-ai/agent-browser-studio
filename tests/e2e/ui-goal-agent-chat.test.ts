// SERIAL coordinator acceptance only. NOT run by the chat worker.
// Native Electron renders production markup/modules with an inert synthetic bridge.
// No app startup, profile launch, provider, clipboard, keychain, license or real data.
// Dispatched composition events are NOT proof of a trusted native IME commit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repo = path.resolve(__dirname, "../..");
let scratch: string;
let app: ElectronApplication | undefined;
let page: Page;

describe.runIf(process.env.AGENT_BROWSER_CHAT_GOAL_NATIVE === "1")("UI goal agent chat — synthetic native renderer acceptance (SERIAL)", () => {
  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ui-goal-chat-native-"));
    for (const dir of ["home", "tmp", "config", "data", "cache", "user-data"]) fs.mkdirSync(path.join(scratch, dir));
    const main = path.join(scratch, "fixture.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(scratch, "user-data"))});
app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL('data:text/html,<html><body></body></html>');});
app.on('window-all-closed',()=>app.quit());`);
    const executablePath = createRequire(import.meta.url)("electron") as string;
    app = await _electron.launch({ executablePath, args: [main], env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", HOME: path.join(scratch, "home"),
      TMPDIR: path.join(scratch, "tmp"), XDG_CONFIG_HOME: path.join(scratch, "config"),
      XDG_DATA_HOME: path.join(scratch, "data"), XDG_CACHE_HOME: path.join(scratch, "cache"),
    } });
    page = await app.firstWindow();
  }, 30000);
  afterAll(async () => {
    try { if (app) await app.close(); }
    finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  async function reset() {
    // A fresh document also removes prior fixture timers/listeners. Strip CSP
    // only here to inject the inert fixture; this is not a production CSP test.
    await page.goto("data:text/html,<html><body></body></html>");
    const html = fs.readFileSync(path.join(repo, "src/renderer/index.html"), "utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, "")
      .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, "");
    await page.setContent(html);
    await page.addStyleTag({ path: path.join(repo, "src/renderer/css/style.css") });
    await page.evaluate(() => {
      const w = window as any;
      const conversations = [
        { id: "fixture-a", title: "Project A", messages: [{ role: "user", content: "A synthetic history" }] },
        { id: "fixture-b", title: "Project B", messages: [{ role: "user", content: "B synthetic history" }] },
      ];
      const events: Record<string, (payload: unknown) => void> = {};
      const fixture: any = { sends: [], errors: [], confirmations: [], statusMode: "ready", events };
      const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const api = {
        on: (name: string, fn: (payload: unknown) => void) => { events[name] = fn; },
        browser: {
          list: async () => [{ dirId: "profile-a", name: "Environment A", running: true }, { dirId: "profile-b", name: "Environment B", running: true }],
          status: async () => fixture.statusMode === "deferred"
            ? new Promise(resolve => { fixture.statusResolve = resolve; }) : { running: true },
        },
        agent: {
          conversations: {
            list: async () => structuredClone(conversations),
            get: async (id: string) => fixture.historyMode === "deferred" && id === "fixture-b"
              ? new Promise((resolve, reject) => { fixture.historyResolve = () => resolve(structuredClone(conversations.find(c => c.id === id) || null)); fixture.historyReject = reject; })
              : structuredClone(conversations.find(c => c.id === id) || null),
            create: async () => { throw new Error("Fixture does not create persisted conversations"); },
            delete: async () => { throw new Error("Synthetic active task deletion refusal"); },
          },
          activeRun: async () => null,
          chatStream: (...args: unknown[]) => { fixture.sends.push(args); return new Promise(() => {}); },
          cancelRun: async () => ({ accepted: true, state: "cancelling" }),
        },
      };
      fixture.history = conversations;
      w.chatGoalFixture = fixture;
      w.agentBrowser = {
        api, R: api, state: { agentMessages: [], agentConvList: [], agentActiveConvId: null },
        helpers: { esc, escAttr: esc, icon: () => "", renderChatMarkdown: esc, toast: (message: string, level: string) => fixture.errors.push({ message, level }) },
        confirm: (_message: string, fn: () => void) => fixture.confirmations.push(fn),
        ipc: { call: (_key: string, fn: () => unknown) => Promise.resolve().then(fn) },
      };
      w.i18n = { t: (_key: string, fallback: string) => fallback };
      document.getElementById("tab-agent")!.classList.add("active");
      document.getElementById("tab-agent")!.style.display = "block";
      document.getElementById("agent-view-chat")!.style.display = "flex";
    });
    for (const file of ["agent-chat.js", "agent-chat-content.js", "delegation.js"]) {
      await page.addScriptTag({ path: path.join(repo, "src/renderer/js/app", file) });
    }
    await page.evaluate(async () => {
      const w = window as any;
      await w.agentBrowser.agentRefreshEnvironments();
      await w.agentBrowser.agentSelectConv("fixture-a");
    });
  }

  it("composition/229 and Shift+Enter do not submit; ordinary Enter submits once", async () => {
    await reset();
    await page.locator("#agent-chat-input").fill("中文输入");
    for (const properties of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
      const result = await page.evaluate(p => {
        const input = document.getElementById("agent-chat-input")!;
        const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...p });
        input.dispatchEvent(event);
        return { prevented: event.defaultPrevented, sends: (window as any).chatGoalFixture.sends.length };
      }, properties);
      expect(result).toEqual({ prevented: false, sends: 0 });
    }
    await page.locator("#agent-chat-input").press("Enter");
    await page.waitForFunction(() => (window as any).chatGoalFixture.sends.length === 1);
    expect(await page.locator("#agent-chat-input").inputValue()).toBe("");
  });

  it("A/B drafts/scopes survive failed async preparation without B leaking into A", async () => {
    await reset();
    await page.locator("#agent-env-select").selectOption("profile-a");
    await page.locator("#agent-chat-input").fill("  A retry\n  ");
    await page.evaluate(() => {
      const w = window as any; w.chatGoalFixture.statusMode = "deferred"; void w.agentBrowser.agentSend();
    });
    await page.waitForFunction(() => !!(window as any).chatGoalFixture.statusResolve);
    await page.evaluate(async () => { await (window as any).agentBrowser.agentSelectConv("fixture-b"); });
    await page.locator("#agent-env-select").selectOption("profile-b");
    await page.locator("#agent-chat-input").fill("B private draft");
    await page.evaluate(async () => { await (window as any).agentBrowser.agentSelectConv("fixture-a"); });
    expect(await page.locator("#agent-chat-input").inputValue()).toBe("  A retry\n  ");
    await page.evaluate(() => (window as any).chatGoalFixture.statusResolve({ running: false }));
    await page.waitForFunction(() => !(document.getElementById("agent-chat-input") as HTMLTextAreaElement).disabled);
    expect(await page.locator("#agent-chat-input").inputValue()).toBe("  A retry\n  ");
    expect(await page.locator("#agent-env-select").inputValue()).toBe("profile-a");
    expect(await page.evaluate(() => (window as any).chatGoalFixture.sends.length)).toBe(0);
    await page.evaluate(async () => { await (window as any).agentBrowser.agentSelectConv("fixture-b"); });
    expect(await page.locator("#agent-chat-input").inputValue()).toBe("B private draft");
    expect(await page.locator("#agent-env-select").inputValue()).toBe("profile-b");
  });

  it("keeps newly typed B text while its real history callback is deferred", async () => {
    await reset(); await page.locator("#agent-chat-input").fill("A retained");
    await page.evaluate(() => {
      const w = window as any; w.chatGoalFixture.historyMode = "deferred";
      w.chatGoalFixture.selectingB = w.agentBrowser.agentSelectConv("fixture-b");
    });
    await page.waitForFunction(() => !!(window as any).chatGoalFixture.historyResolve);
    await page.locator("#agent-chat-input").fill("  B typed while pending\n  ");
    await page.evaluate(async () => {
      const w = window as any; w.chatGoalFixture.historyResolve(); await w.chatGoalFixture.selectingB;
      w.chatGoalFixture.historyMode = "ready";
    });
    expect(await page.locator("#agent-chat-input").inputValue()).toBe("  B typed while pending\n  ");
    expect(await page.locator("#agent-chat-title").textContent()).toBe("Project B");
    await page.evaluate(async () => (window as any).agentBrowser.agentSelectConv("fixture-a"));
    expect(await page.locator("#agent-chat-input").inputValue()).toBe("A retained");
    await page.evaluate(async () => (window as any).agentBrowser.agentSelectConv("fixture-b"));
    expect(await page.locator("#agent-chat-input").inputValue()).toBe("  B typed while pending\n  ");
    expect(await page.evaluate(() => (window as any).chatGoalFixture.sends.length)).toBe(0);
  });

  it("refreshes empty recommendations in both scope directions without creating/submitting", async () => {
    await reset();
    await page.evaluate(async () => {
      const w = window as any; w.chatGoalFixture.history[0].messages = [];
      await w.agentBrowser.agentSelectConv("fixture-a");
    });
    const suggestions = page.locator(".chat-suggestions");
    expect(await suggestions.innerText()).toContain("Explain which actions need a browser environment");
    await page.locator("#agent-chat-input").fill("unsent exact draft");
    await page.locator("#agent-env-select").selectOption("profile-a");
    expect(await suggestions.innerText()).toContain("Open a website in the selected running environment");
    expect(await suggestions.innerText()).not.toContain("Explain which actions");
    await page.locator("#agent-env-select").selectOption("");
    expect(await suggestions.innerText()).toContain("Explain which actions");
    expect(await suggestions.innerText()).not.toContain("Open a website");
    expect(await suggestions.innerText()).toContain("list recent automation");
    expect(await suggestions.innerText()).not.toContain("List browser environments");
    expect(await page.locator("#agent-chat-input").inputValue()).toBe("unsent exact draft");
    expect(await page.evaluate(() => (window as any).chatGoalFixture.history.map((c: any) => c.id))).toEqual(["fixture-a", "fixture-b"]);
    expect(await page.evaluate(() => (window as any).chatGoalFixture.sends.length)).toBe(0);
  });

  it("both confirmed delete entrypoints retain synthetic history/view and show rejection", async () => {
    for (const handler of ["agentDeleteConv", "agentDeleteConvItem"]) {
      await reset();
      await page.locator("#agent-chat-input").fill("retain my draft");
      await page.evaluate(name => {
        const w = window as any; w.agentBrowser[name]("fixture-a"); w.chatGoalFixture.confirmations[0]();
      }, handler);
      await page.waitForFunction(() => (window as any).chatGoalFixture.errors.length > 0);
      const result = await page.evaluate(() => {
        const w = window as any;
        return { active: w.agentBrowser.state.agentActiveConvId, errors: w.chatGoalFixture.errors, ids: w.chatGoalFixture.history.map((c: any) => c.id) };
      });
      expect(result.active).toBe("fixture-a"); expect(result.ids).toEqual(["fixture-a", "fixture-b"]);
      expect(result.errors[0]).toMatchObject({ level: "error", message: expect.stringContaining("deletion refusal") });
      expect(await page.locator("#agent-chat-input").inputValue()).toBe("retain my draft");
      expect(await page.locator("#agent-chat-messages").innerText()).toContain("A synthetic history");
    }
  });

  // Task196 additions. Prepared for the SERIAL coordinator only; the offline
  // worker must not launch Electron. Actual handlers and renders stay installed.
  async function resetFourGaps(locale: "en-US" | "zh-CN", empty = false) {
    await page.goto("data:text/html,<html><body></body></html>");
    const html = fs.readFileSync(path.join(repo, "src/renderer/index.html"), "utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, "")
      .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, "");
    await page.setContent(html); await page.addStyleTag({ path: path.join(repo, "src/renderer/css/style.css") });
    await page.evaluate(({ empty }) => {
      const w = window as any;
      const records: any[] = empty ? [] : [
        { id: "fixture-a", title: "Project A", messages: [{ role: "user", content: "A retained history" }] },
        { id: "fixture-b", title: "Project B", messages: [{ role: "user", content: "B retained history" }] },
      ];
      const f: any = { records, events: {}, reads: { list: [], history: [], recovery: [] }, pending: {}, creates: 0, sends: [], confirmations: [], errors: [] };
      f.defer = (kind: string) => {
        const item: any = {}; item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
        f.reads[kind].push(item); f.pending[kind] = item; return item;
      };
      const read = (kind: string, value: unknown) => f.reads[kind].length ? f.reads[kind].shift().promise : Promise.resolve(structuredClone(value));
      const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const api = { on: (name: string, fn: unknown) => { f.events[name] = fn; },
        browser: { list: async () => [], status: async () => ({ running: false }) },
        agent: { conversations: {
          list: () => read("list", records), get: (id: string) => read("history", records.find(c => c.id === id) || null),
          create: async () => { f.creates++; const c = { id: "created-fixture", title: "New Chat", messages: [] }; records.push(c); return structuredClone(c); },
          delete: async (id: string) => { const index = records.findIndex(c => c.id === id); if (index >= 0) records.splice(index, 1); return true; },
        }, activeRun: () => read("recovery", null),
          chatStream: (...args: unknown[]) => { f.sends.push(args); return new Promise(() => {}); },
          cancelRun: async () => ({ accepted: true, state: "cancelling" }),
        },
      };
      w.chatFourFixture = f;
      w.agentBrowser = { api, R: api, state: { agentMessages: [], agentConvList: [], agentActiveConvId: null, currentTab: "agent" },
        helpers: { esc, escAttr: esc, icon: () => "", renderChatMarkdown: esc, toast: (message: string, level: string) => f.errors.push({ message, level }) },
        confirm: (_message: string, fn: () => void) => f.confirmations.push(fn),
        ipc: { call: (_key: string, fn: () => unknown) => Promise.resolve().then(fn) },
      };
      document.getElementById("tab-agent")!.style.display = "block";
      document.getElementById("agent-view-chat")!.style.display = "flex";
    }, { empty });
    await page.addScriptTag({ path: path.join(repo, "src/renderer/js/i18n.js") });
    await page.evaluate(locale => (window as any).i18n.set(locale), locale);
    for (const file of ["agent-chat.js", "agent-chat-content.js", "delegation.js"]) {
      await page.addScriptTag({ path: path.join(repo, "src/renderer/js/app", file) });
    }
  }
  async function settleFourGaps() {
    await page.evaluate(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
  }
  for (const locale of ["en-US", "zh-CN"] as const) {
    for (const empty of [false, true]) it(`Task196 ${locale}: first ${empty ? "empty" : "existing"} list retains enabled typing`, async () => {
      await resetFourGaps(locale, empty);
      await page.evaluate(() => { const w = window as any; w.chatFourFixture.defer("list"); w.chatFourFixture.loading = w.agentBrowser.agentLoadConversations(); });
      const draft = "  before first list 中文\n  "; await page.locator("#agent-chat-input").fill(draft);
      await page.evaluate(async () => { const w = window as any; w.chatFourFixture.pending.list.resolve(structuredClone(w.chatFourFixture.records)); await w.chatFourFixture.loading; });
      await settleFourGaps(); expect(await page.locator("#agent-chat-input").inputValue()).toBe(draft);
      expect(await page.evaluate(() => { const f = (window as any).chatFourFixture; return { creates: f.creates, sends: f.sends.length }; })).toEqual({ creates: empty ? 1 : 0, sends: 0 });
    });
    for (const error of [false, true]) it(`Task196 ${locale}: non-null recovery and ${error ? "error" : "done"} restores typed draft`, async () => {
      await resetFourGaps(locale);
      await page.evaluate(() => { const w = window as any; w.chatFourFixture.defer("recovery"); w.chatFourFixture.selecting = w.agentBrowser.agentSelectConv("fixture-a"); });
      const draft = "  draft during recovery 中文\n "; await page.locator("#agent-chat-input").fill(draft);
      await page.evaluate(async () => {
        const w = window as any; w.chatFourFixture.pending.recovery.resolve({ conversationId: "fixture-a", streamId: "recovered-stream", runId: "recovered-run", state: "running", reply: "partial", startedAt: 1 });
        await w.chatFourFixture.selecting;
      });
      expect(await page.locator("#agent-chat-input").isDisabled()).toBe(true);
      await page.evaluate(error => { const f = (window as any).chatFourFixture; f.events[error ? "agent:stream-error" : "agent:stream-done"]({ conversationId: "fixture-a", streamId: "recovered-stream", runId: "recovered-run", status: error ? "error" : "done", endReason: error ? "execution_error" : "completed", error: error ? "controlled terminal denial" : "", reply: "final", persisted: true }); }, error);
      await settleFourGaps(); expect(await page.locator("#agent-chat-input").inputValue()).toBe(draft);
      expect(await page.locator("#agent-chat-input").isDisabled()).toBe(false);
      await page.evaluate(async () => { const a = (window as any).agentBrowser; await a.agentSelectConv("fixture-b"); await a.agentSelectConv("fixture-a"); });
      expect(await page.locator("#agent-chat-input").inputValue()).toBe(draft);
      expect(await page.evaluate(() => (window as any).chatFourFixture.sends.length)).toBe(0);
    });
    for (const kind of ["chunk", "tool", "step", "start"] as const) it(`Task196 ${locale}: actual ${kind} fences an older snapshot`, async () => {
      await resetFourGaps(locale);
      await page.evaluate(async () => {
        const w = window as any; const f = w.chatFourFixture; const d = f.defer("recovery");
        d.resolve({ conversationId: "fixture-a", streamId: "recovered-stream", runId: "recovered-run", state: "running", reply: "old", startedAt: 1 });
        await w.agentBrowser.agentSelectConv("fixture-a"); f.defer("recovery"); w.agentBrowser.switchAgentSub("chat");
      });
      await settleFourGaps();
      const prior = await page.evaluate(kind => {
        const w = window as any, f = w.chatFourFixture; const identity = { conversationId: "fixture-a", streamId: "recovered-stream", runId: "recovered-run" };
        if (kind === "chunk") f.events["agent:stream-chunk"]({ ...identity, text: " + actual delta" });
        if (kind === "tool") f.events["agent:stream-tool-call"]({ ...identity, name: "actual_tool" });
        if (kind === "step") f.events["agent:run-step"]({ runId: "recovered-run", step: { id: "actual-step", tool: "actual_tool", ok: false, error: "actual denial", durationMs: 9 } });
        if (kind === "start") f.events["agent:stream-start"]({ ...identity, startedAt: 777 });
        const before = JSON.stringify(w.agentBrowser.agentChatSessions["fixture-a"].run);
        f.pending.recovery.resolve({ ...identity, state: "running", reply: "old", steps: [], toolCalls: [], startedAt: 1 }); return before;
      }, kind);
      await settleFourGaps(); expect(await page.evaluate(() => JSON.stringify((window as any).agentBrowser.agentChatSessions["fixture-a"].run))).toBe(prior);
      if (kind === "chunk") await page.waitForFunction(() => document.getElementById("agent-chat-messages")!.textContent!.includes("actual delta"));
      expect(await page.evaluate(() => (window as any).chatFourFixture.sends.length)).toBe(0);
    });
    for (const outcome of ["resolve", "reject", "delete"] as const) it(`Task196 ${locale}: terminal history ${outcome} obeys selection/membership fences`, async () => {
      await resetFourGaps(locale); await page.evaluate(async () => { await (window as any).agentBrowser.agentSelectConv("fixture-a"); });
      await page.evaluate(outcome => {
        const w = window as any, f = w.chatFourFixture;
        if (outcome === "delete") f.records[0].title = "persisted deleted-session title";
        f.oldRecord = structuredClone(f.records[0]); f.defer("history");
        f.events["agent:stream-error"]({ conversationId: "fixture-a", streamId: "terminal-stream", runId: "terminal-run", status: "error", endReason: "execution_error", reply: "terminal", persisted: true });
        if (outcome === "delete") { f.removedSession = w.agentBrowser.agentChatSessions["fixture-a"]; f.removedBefore = JSON.stringify(f.removedSession); w.agentBrowser.agentDeleteConvItem("fixture-a"); f.confirmations[0](); }
        else { f.records[0].title = "new authoritative title"; f.records[0].messages.push({ role: "user", content: "new authoritative history" }); }
      }, outcome);
      await settleFourGaps(); await page.evaluate(async outcome => { await (window as any).agentBrowser.agentSelectConv(outcome === "delete" ? "fixture-b" : "fixture-a"); }, outcome);
      await page.locator("#agent-chat-input").fill("current draft retained");
      await page.evaluate(outcome => { const f = (window as any).chatFourFixture; if (outcome === "reject") f.pending.history.reject(new Error("controlled obsolete read")); else f.pending.history.resolve(f.oldRecord); }, outcome);
      await settleFourGaps(); expect(await page.locator("#agent-chat-input").inputValue()).toBe("current draft retained");
      expect(await page.locator("#agent-chat-title").textContent()).toBe(outcome === "delete" ? "Project B" : "new authoritative title");
      if (outcome === "delete") {
        expect(await page.evaluate(() => (window as any).agentBrowser.agentChatSessions["fixture-a"] === undefined)).toBe(true);
        expect(await page.evaluate(() => { const f = (window as any).chatFourFixture; return JSON.stringify(f.removedSession) === f.removedBefore; })).toBe(true);
      } else expect(await page.locator("#agent-chat-messages").innerText()).toContain("new authoritative history");
      expect(await page.evaluate(() => (window as any).chatFourFixture.sends.length)).toBe(0);
    });
    it(`Task196 ${locale}: fresh and new-stream snapshots remain accepted`, async () => {
      await resetFourGaps(locale); await page.evaluate(async () => { const w = window as any, f = w.chatFourFixture; const read = f.defer("recovery"); read.resolve({ conversationId: "fixture-a", streamId: "old-stream", runId: "old-run", state: "running", reply: "fresh recovery", startedAt: 1 }); await w.agentBrowser.agentSelectConv("fixture-a"); });
      expect(await page.locator("#agent-chat-messages").innerText()).toContain("fresh recovery");
      await page.evaluate(() => { const w = window as any, f = w.chatFourFixture; f.defer("recovery"); w.agentBrowser.switchAgentSub("chat"); }); await settleFourGaps();
      await page.evaluate(() => { const w = window as any, f = w.chatFourFixture; f.events["agent:stream-done"]({ conversationId: "fixture-a", streamId: "old-stream", runId: "old-run", status: "done", endReason: "completed", reply: "old terminal", persisted: false }); f.pending.recovery.resolve({ conversationId: "fixture-a", streamId: "new-stream", runId: "new-run", state: "running", reply: "new-stream snapshot", startedAt: Date.now() + 100 }); });
      await settleFourGaps(); expect(await page.locator("#agent-chat-messages").innerText()).toContain("new-stream snapshot");
      expect(await page.evaluate(() => (window as any).chatFourFixture.sends.length)).toBe(0);
    });
  }
});

// Task271 additions: SERIAL coordinator only. This is a synthetic native DOM
// check, not packaged-app/transport acceptance. Unlike the older source fixture,
// it requires externally built renderer artifacts bound to all current hashes
// BEFORE launching Electron. No root build or artifact generation happens here.
describe.runIf(process.env.AGENT_BROWSER_TITLE_GOAL_NATIVE === "1")("F18 bound-build native title renderer (SERIAL)", () => {
  let titleApp: ElectronApplication | undefined, titlePage: Page, titleScratch: string, build: string;
  const files = ["index.html", "js/i18n.js", "js/app/agent-chat.js", "js/app/agent-chat-content.js", "css/style.css"];
  beforeAll(async () => {
    const root = process.env.AGENT_BROWSER_TITLE_RENDERER_BUILD_ROOT;
    const manifestPath = process.env.AGENT_BROWSER_TITLE_RENDERER_BUILD_MANIFEST;
    if (!root || !manifestPath) throw new Error("F18 requires a bound fresh renderer build and manifest before native launch");
    build = fs.realpathSync(root);
    if (build === fs.realpathSync(path.join(repo, "src/renderer"))) throw new Error("F18 requires build artifacts, not the source renderer directory");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { files: Record<string, string> };
    for (const file of files) {
      const artifact = fs.realpathSync(path.join(build, file));
      if (!artifact.startsWith(build + path.sep)) throw new Error("F18 build artifact escapes the bound root");
      const hash = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      const built = hash(artifact), current = hash(path.join(repo, "src/renderer", file));
      if (manifest.files?.[file] !== built || built !== current) throw new Error(`F18 stale or unbound renderer artifact: ${file}`);
    }
    titleScratch = fs.mkdtempSync(path.join(os.tmpdir(), "title-bound-build-native-"));
    for (const dir of ["home", "tmp", "config", "data", "cache", "user-data"]) fs.mkdirSync(path.join(titleScratch, dir));
    const main = path.join(titleScratch, "fixture.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(titleScratch, "user-data"))});
app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL('data:text/html,<html><body></body></html>');});
app.on('window-all-closed',()=>app.quit());`);
    titleApp = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron") as string, args: [main], env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", HOME: path.join(titleScratch, "home"), TMPDIR: path.join(titleScratch, "tmp"),
      XDG_CONFIG_HOME: path.join(titleScratch, "config"), XDG_DATA_HOME: path.join(titleScratch, "data"), XDG_CACHE_HOME: path.join(titleScratch, "cache"),
    } });
    titlePage = await titleApp.firstWindow();
  }, 30000);
  afterAll(async () => {
    try { if (titleApp) await titleApp.close(); }
    finally { if (titleScratch) fs.rmSync(titleScratch, { recursive: true, force: true }); }
  });
  async function resetBoundTitles() {
    // Recheck the binding per case. A later source/build change is not accepted.
    const manifest = JSON.parse(fs.readFileSync(process.env.AGENT_BROWSER_TITLE_RENDERER_BUILD_MANIFEST!, "utf8"));
    for (const file of files) {
      const artifact = createHash("sha256").update(fs.readFileSync(path.join(build, file))).digest("hex");
      expect(artifact).toBe(manifest.files[file]);
      expect(artifact).toBe(createHash("sha256").update(fs.readFileSync(path.join(repo, "src/renderer", file))).digest("hex"));
    }
    await titlePage.goto("data:text/html,<html><body></body></html>");
    const markup = fs.readFileSync(path.join(build, "index.html"), "utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, "")
      .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, "");
    await titlePage.setContent(markup); await titlePage.addStyleTag({ path: path.join(build, "css/style.css") });
    await titlePage.evaluate(() => {
      const w = window as any;
      const records: any[] = [
        { id: "default", title: "New Chat", titleKind: "default" },
        { id: "literal", title: "New Chat", titleKind: "literal" },
        { id: "legacy", title: "New Chat" },
        { id: "null", title: "New Chat", titleKind: null },
        { id: "object", title: "New Chat", titleKind: { opaque: "synthetic" } },
        { id: "inconsistent", title: "Historical title", titleKind: "default" },
        { id: "empty", title: "", titleKind: "literal" },
        { id: "duplicate-a", title: "Duplicate title", titleKind: "literal" },
        { id: "duplicate-b", title: "Duplicate title", titleKind: "literal" },
      ].map(c => ({ ...c, messages: [{ role: "user", content: `History ${c.id}` }], createdAt: 1, updatedAt: 1 }));
      const f: any = { records, calls: { list: 0, get: 0, create: 0, rename: 0, delete: 0, recovery: 0, send: 0 } };
      const api = { on: () => {}, browser: { list: async () => [] }, agent: { conversations: {
        list: async () => { f.calls.list++; return structuredClone(records); },
        get: async (id: string) => { f.calls.get++; return structuredClone(records.find(c => c.id === id) || null); },
        create: async () => { f.calls.create++; throw new Error("Unexpected title repaint creation"); },
        rename: async (id: string, title: string) => { f.calls.rename++; const c = records.find(c => c.id === id); if (!c) return null; c.title = title; c.titleKind = "literal"; return structuredClone(c); },
        delete: async () => { f.calls.delete++; throw new Error("Unexpected title deletion"); },
      }, activeRun: async () => { f.calls.recovery++; return null; },
        chatStream: async () => { f.calls.send++; throw new Error("Unexpected title submission"); },
      } };
      const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      w.titleGoalFixture = f;
      w.agentBrowser = { api, R: api, state: { currentTab: "agent", agentActiveConvId: null, agentMessages: [], agentConvList: [] },
        helpers: { esc, escAttr: esc, icon: () => "", renderChatMarkdown: esc, toast: () => {} },
        ipc: { call: (_key: string, fn: () => unknown) => Promise.resolve().then(fn) },
      };
      document.getElementById("tab-agent")!.style.display = "block";
      document.getElementById("agent-view-chat")!.style.display = "flex";
    });
    for (const file of ["js/i18n.js", "js/app/agent-chat.js", "js/app/agent-chat-content.js"]) await titlePage.addScriptTag({ path: path.join(build, file) });
    await titlePage.evaluate(async () => { const w = window as any; w.i18n.set("en-US"); for (const c of w.titleGoalFixture.records) await w.agentBrowser.agentSelectConv(c.id); });
  }
  for (const id of ["default", "literal", "legacy", "inconsistent", "empty"]) it(`F18 ${id}: locale/header/filter/inactive caches stay API-read-only`, async () => {
    await resetBoundTitles();
    await titlePage.evaluate(async id => {
      const w = window as any; await w.agentBrowser.agentSelectConv(id);
      (document.getElementById("agent-conv-search") as HTMLInputElement).value = "New Chat"; w.agentBrowser.agentFilterConvs();
    }, id);
    await titlePage.locator("#agent-chat-input").fill("  unsent title draft\n ");
    const before = await titlePage.evaluate(() => { const w = window as any; return { calls: JSON.stringify(w.titleGoalFixture.calls), records: JSON.stringify(w.titleGoalFixture.records), caches: JSON.stringify(w.agentBrowser.agentChatSessions) }; });
    for (const locale of ["zh-CN", "en-US"]) {
      await titlePage.evaluate(locale => (window as any).i18n.set(locale), locale);
      expect(await titlePage.locator("#agent-chat-title").textContent()).toBe(id === "empty" ? "" : id === "inconsistent" ? "Historical title" : id === "default" && locale === "zh-CN" ? "新对话" : "New Chat");
      const sidebar = titlePage.locator("#agent-conv-list");
      expect(await sidebar.locator('[data-cmd="agentSelectConv"][data-cmd-arg="literal"]').count()).toBe(1);
      expect(await sidebar.locator('[data-cmd="agentSelectConv"][data-cmd-arg="legacy"]').count()).toBe(1);
      expect(await sidebar.locator('[data-cmd="agentSelectConv"][data-cmd-arg="default"]').count()).toBe(locale === "zh-CN" ? 0 : 1);
      expect(await titlePage.locator("#agent-chat-input").inputValue()).toBe("  unsent title draft\n ");
      expect(await titlePage.evaluate(() => { const w = window as any; return { calls: JSON.stringify(w.titleGoalFixture.calls), records: JSON.stringify(w.titleGoalFixture.records), caches: JSON.stringify(w.agentBrowser.agentChatSessions) }; })).toEqual(before);
    }
  });
  it("F18 same-text rename commits literal for exactly one identity; duplicate titles remain separate", async () => {
    await resetBoundTitles();
    await titlePage.evaluate(async () => { const w = window as any; await w.agentBrowser.agentSelectConv("default"); w.i18n.set("zh-CN"); await w.agentBrowser.agentRenameConv("default", "New Chat"); });
    expect(await titlePage.locator("#agent-chat-title").textContent()).toBe("New Chat");
    expect(await titlePage.evaluate(() => { const w = window as any; return { cache: w.agentBrowser.agentChatSessions.default.titleKind, list: w.agentBrowser.state.agentConvList.find((c: any) => c.id === "default").titleKind, committed: w.titleGoalFixture.records.find((c: any) => c.id === "default").titleKind }; })).toEqual({ cache: "literal", list: "literal", committed: "literal" });
    await titlePage.locator("#agent-conv-search").fill("Duplicate title"); await titlePage.evaluate(() => (window as any).agentBrowser.agentFilterConvs());
    expect(await titlePage.locator('#agent-conv-list [data-cmd="agentSelectConv"]').count()).toBe(2);
    await titlePage.evaluate(async () => (window as any).agentBrowser.agentSelectConv("duplicate-b"));
    expect(await titlePage.locator("#agent-chat-messages").innerText()).toContain("History duplicate-b");
  });
});
