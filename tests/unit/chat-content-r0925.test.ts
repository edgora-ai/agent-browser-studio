// R0925-06 regression: targeted assertions for the Phase 5 chat affordances
// and the SQL viewer shortcut, running the REAL renderer modules in a vm
// sandbox (same harness idiom as renderer-agent-m1.test.ts).
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const CHAT_CONTENT = fs.readFileSync(
  path.resolve(__dirname, "../../src/renderer/js/app/agent-chat-content.js"), "utf8");
const DB_MODULE = fs.readFileSync(
  path.resolve(__dirname, "../../src/renderer/js/app/db.js"), "utf8");

function flush(times = 8): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => undefined);
  return p;
}

// ── agent-chat-content.js harness ──

class FakeEl {
  id: string;
  value = "";
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  style: Record<string, string> = {};
  scrollHeight = 0;
  innerHTML = "";
  classList = { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) };
  attributes: Record<string, string> = {};
  constructor(id: string) { this.id = id; }
  addEventListener(type: string, fn: (...args: any[]) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  dispatch(type: string, event: any) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

function loadChatContent(opts: {
  messages: Array<{ role: string; content: string }>;
  clipboard?: { writeText: (text: string) => Promise<void> };
}) {
  const toast = vi.fn();
  const container = new FakeEl("agent-chat-messages");
  const input = new FakeEl("agent-chat-input");
  const elements: Record<string, FakeEl> = {
    "agent-chat-messages": container,
    "agent-chat-input": input,
  };
  const agentBrowser: any = {
    helpers: { toast, icon: (name: string) => `[icon:${name}]` },
    state: { agentMessages: opts.messages },
  };
  const sandbox: any = {
    window: { agentBrowser, i18n: { t: (_k: string, f: string) => f } },
    document: { getElementById: (id: string) => elements[id] || null },
    navigator: opts.clipboard ? { clipboard: opts.clipboard } : {},
    setTimeout: (fn: () => void) => { fn(); return 0; },
  };
  vm.createContext(sandbox);
  vm.runInContext(CHAT_CONTENT, sandbox);
  return { container, input, toast, agentBrowser };
}

function copyButton(index: number) {
  const btn = new FakeEl("btn");
  btn.setAttribute("data-msg-copy", String(index));
  return btn;
}

describe("agent-chat-content.js — message copy", () => {
  it("copies the message addressed by the button index, not the latest one", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { container, toast } = loadChatContent({
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "older answer" },
        { role: "assistant", content: "newest answer" },
      ],
      clipboard: { writeText },
    });
    const btn = copyButton(1);
    container.dispatch("click", { target: { closest: () => btn }, preventDefault: vi.fn() });
    await flush();
    expect(writeText).toHaveBeenCalledWith("older answer");
    expect(btn.classList.add).toHaveBeenCalledWith("is-copied");
    expect(toast).not.toHaveBeenCalled();
  });

  it("clipboard failure shows an error toast and never marks the button copied", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    const { container, toast } = loadChatContent({
      messages: [{ role: "assistant", content: "answer" }],
      clipboard: { writeText },
    });
    const btn = copyButton(0);
    container.dispatch("click", { target: { closest: () => btn }, preventDefault: vi.fn() });
    await flush();
    expect(toast).toHaveBeenCalledWith("Copy failed", "error");
    expect(btn.classList.add).not.toHaveBeenCalledWith("is-copied");
  });

  it("missing clipboard API shows an error toast instead of a fake success", async () => {
    const { container, toast } = loadChatContent({
      messages: [{ role: "assistant", content: "answer" }],
    });
    const btn = copyButton(0);
    container.dispatch("click", { target: { closest: () => btn }, preventDefault: vi.fn() });
    await flush();
    expect(toast).toHaveBeenCalledWith("Copy failed", "error");
    expect(btn.classList.add).not.toHaveBeenCalledWith("is-copied");
  });

  it("ignores clicks outside copy buttons and out-of-range indexes", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { container } = loadChatContent({
      messages: [{ role: "assistant", content: "answer" }],
      clipboard: { writeText },
    });
    container.dispatch("click", { target: { closest: () => null }, preventDefault: vi.fn() });
    container.dispatch("click", { target: { closest: () => copyButton(9) }, preventDefault: vi.fn() });
    await flush();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("agent-chat-content.js — composer auto-grow", () => {
  it("grows with scrollHeight and caps at 160px", () => {
    const { input } = loadChatContent({ messages: [] });
    input.scrollHeight = 80;
    input.dispatch("input", {});
    expect(input.style.height).toBe("80px");
    input.scrollHeight = 500;
    input.dispatch("input", {});
    expect(input.style.height).toBe("160px");
  });

  it("exposes chatComposerResize so send-clear and draft-restore re-fit the height", () => {
    const { input, agentBrowser } = loadChatContent({ messages: [] });
    expect(typeof agentBrowser.chatComposerResize).toBe("function");
    input.scrollHeight = 42;
    agentBrowser.chatComposerResize();
    expect(input.style.height).toBe("42px");
  });
});

// ── db.js harness ──

function loadDbModule(opts: { tables: Array<{ name: string; rowCount: number }> }) {
  const toast = vi.fn();
  const sql = new FakeEl("db-sql");
  const tablesEl = new FakeEl("db-tables");
  const elements: Record<string, FakeEl> = {
    "db-tables": tablesEl,
    "db-table-count": new FakeEl("db-table-count"),
    "db-sql": sql,
    "db-result": new FakeEl("db-result"),
  };
  const api = {
    agentDb: {
      tables: vi.fn(async () => opts.tables),
      query: vi.fn(async () => ({ ok: true, rows: [], count: 0 })),
      exec: vi.fn(async () => ({ ok: true })),
      tableData: vi.fn(async () => ({ rows: [], total: 0 })),
    },
  };
  const agentBrowser: any = {
    api,
    helpers: { toast, esc: (v: unknown) => String(v ?? ""), escAttr: (v: unknown) => String(v ?? ""), icon: () => "" },
    ipc: { call: (_key: string, fn: () => Promise<unknown>) => fn() },
  };
  const sandbox: any = {
    window: { agentBrowser, i18n: { t: (_k: string, f: string) => f }, icons: null },
    document: { getElementById: (id: string) => elements[id] || null },
  };
  vm.createContext(sandbox);
  vm.runInContext(DB_MODULE, sandbox);
  return { api, sql, tablesEl, agentBrowser };
}

describe("db.js — SQL shortcut stays on the read-only path (R0925-06)", () => {
  it("Ctrl/Cmd+Enter runs dbRunSql via agentDb.query and never agentDb.exec", async () => {
    const { api, sql, agentBrowser } = loadDbModule({ tables: [{ name: "t1", rowCount: 3 }] });
    await agentBrowser.loadDbTab();
    await flush();
    sql.value = "SELECT 1";
    sql.dispatch("keydown", { metaKey: true, key: "Enter", preventDefault: vi.fn() });
    await flush();
    expect(api.agentDb.query).toHaveBeenCalledWith("SELECT 1");
    expect(api.agentDb.exec).not.toHaveBeenCalled();
  });

  it("the shortcut is only bound after tables exist (empty library binds nothing)", async () => {
    const { api, sql, agentBrowser } = loadDbModule({ tables: [] });
    await agentBrowser.loadDbTab();
    await flush();
    sql.dispatch("keydown", { ctrlKey: true, key: "Enter", preventDefault: vi.fn() });
    await flush();
    expect(api.agentDb.query).not.toHaveBeenCalled();
    expect(api.agentDb.exec).not.toHaveBeenCalled();
  });

  it("revisiting the tab binds the shortcut once, not per visit", async () => {
    const { sql, agentBrowser } = loadDbModule({ tables: [{ name: "t1", rowCount: 1 }] });
    await agentBrowser.loadDbTab();
    await flush();
    await agentBrowser.loadDbTab();
    await flush();
    expect(sql.listeners.get("keydown") || []).toHaveLength(1);
  });

  it("dbRunSql('exec') is the only path that reaches agentDb.exec", async () => {
    const { api, sql, agentBrowser } = loadDbModule({ tables: [{ name: "t1", rowCount: 1 }] });
    sql.value = "CREATE TABLE x (v TEXT)";
    agentBrowser.dbRunSql("exec");
    await flush();
    expect(api.agentDb.exec).toHaveBeenCalledWith("CREATE TABLE x (v TEXT)");
    expect(api.agentDb.query).not.toHaveBeenCalled();
  });

  it("empty SQL shows an error toast without any backend call", async () => {
    const { api, agentBrowser } = loadDbModule({ tables: [{ name: "t1", rowCount: 1 }] });
    agentBrowser.dbRunSql();
    await flush();
    expect(api.agentDb.query).not.toHaveBeenCalled();
    expect(api.agentDb.exec).not.toHaveBeenCalled();
  });
});
