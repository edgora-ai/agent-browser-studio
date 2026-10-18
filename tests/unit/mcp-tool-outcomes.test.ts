import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, startFixture } from "./rest-mcp-socket-helper.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

let f: Awaited<ReturnType<typeof startFixture>>;
const dirId = "ab_task48_fixture", extId = "a".repeat(32);
beforeAll(async () => { f = await startFixture("mcp"); });
afterAll(async () => { await f?.close(); });
beforeEach(() => {
  h.tool.mockReset(); h.extensions.addOrUpdateChromeStoreExtension.mockClear();
  f.store.transact((draft: any) => { delete draft.team; draft.browserProfiles[dirId] = { name: "Synthetic profile", engine: "chromium", proxyMode: "none" }; });
});

describe("MCP advertised tools match standalone execution context", () => {
  it("does not advertise or execute run-local variables without a legitimate agent run", async () => {
    const listed = await f.rpc("tools/list");
    const names = listed.body.result.tools.map((t: any) => t.name);
    expect(names).toContain("agent_browser_db_query");
    expect(names).not.toContain("agent_browser_set_var"); expect(names).not.toContain("agent_browser_get_var");
    for (const name of ["agent_browser_set_var", "agent_browser_get_var", "cloak_set_var", "cloak_get_var"]) {
      const denied = await f.call(name, { key: "private", value: "never-global" });
      expect(denied.body.result.isError).toBe(true);
      expect(denied.payload.error).toMatch(/unknown tool|active agent run/i);
    }
    expect(h.tool).not.toHaveBeenCalled();
  });
  it("leaves real agent run-scoped set/get variables intact and isolated", async () => {
    const first = f.runs.startRun({ name: "Synthetic local run", source: { type: "chat", conversationId: "synthetic" } });
    const second = f.runs.startRun({ name: "Synthetic second run", source: { type: "chat", conversationId: "synthetic" } });
    await f.agent.executeToolCall("set_var", { key: "owned", value: "run-specific" }, undefined, { runId: first.id });
    expect(await f.agent.executeToolCall("get_var", { key: "owned" }, undefined, { runId: first.id })).toEqual(expect.objectContaining({ value: "run-specific" }));
    expect(await f.agent.executeToolCall("get_var", { key: "owned" }, undefined, { runId: second.id })).not.toEqual(expect.objectContaining({ value: "run-specific" }));
    f.runs.finishRun(first.id, "done"); f.runs.finishRun(second.id, "done");
  });
  it("sets isError for nonthrow tool failure envelopes, but not nested business data", async () => {
    for (const payload of [{ ok: false }, { success: false }, { skipped: true, reason: "denied" }, { decision: "deny" }, { cancelled: true }]) {
      h.tool.mockResolvedValueOnce(payload);
      const response = await f.call("decision" in payload ? "agent_browser_db_exec" : "agent_browser_db_query", { sql: "SELECT 1" });
      expect(response.status).toBe(200); expect(response.payload).toEqual(payload); expect(response.body.result.isError).toBe(true);
    }
    const data = { rows: [{ error: "business field", ok: false }], body: { success: false }, value: { skipped: true } };
    h.tool.mockResolvedValueOnce(data);
    const good = await f.call("agent_browser_db_query", { sql: "SELECT 1" });
    expect(good.payload).toEqual(data); expect(good.body.result.isError).toBeUndefined();
  });
  it.each([
    ["agent_browser_navigate", { errorText: "synthetic navigation failed" }],
    ["agent_browser_wait_for_load", { loaded: false }],
  ])("classifies native negative receipt from %s without dropping its payload", async (name, payload) => {
    h.tool.mockResolvedValueOnce(payload);
    const response = await f.call(name as string, { port: 12345 });
    expect(response.payload).toEqual(payload); expect(response.body.result.isError).toBe(true);
  });
  it("real destructive SQLite approval denial is isError and leaves the stored row untouched", async () => {
    expect(f.db.agentDbExecScript("CREATE TABLE task48_mcp_approval (value TEXT); INSERT INTO task48_mcp_approval VALUES ('synthetic-protected-row');").ok).toBe(true);
    const pending = f.call("agent_browser_db_exec", { sql: "DELETE FROM task48_mcp_approval" });
    await vi.waitFor(() => expect(f.approvals.listPendingApprovals()).toHaveLength(1));
    expect(f.approvals.resolveApproval(f.approvals.listPendingApprovals()[0].id, "deny")).toBe(true);
    const response = await pending;
    expect(response.payload).toMatchObject({ skipped: true, decision: "deny" }); expect(response.body.result.isError).toBe(true);
    const db = new DatabaseSync(path.join(f.dir, "agent-store.sqlite"), { readOnly: true });
    try { expect(db.prepare("SELECT value FROM task48_mcp_approval").all()).toEqual([{ value: "synthetic-protected-row" }]); } finally { db.close(); }
    f.db.closeAgentDb(); expect(f.db.agentDbQuery("SELECT value FROM task48_mcp_approval").rows).toEqual([{ value: "synthetic-protected-row" }]);
  });
  it("classifies a real stopped-profile false result as a tool error", async () => {
    const response = await f.call("agent_browser_stop_profile", { dirId });
    expect(response.payload).toEqual({ success: false }); expect(response.body.result.isError).toBe(true);
  });
});

describe("MCP reuses the existing settings-role gate before installer effects", () => {
  it("viewer db_exec cannot write the real SQLite store; read-only tools remain available", async () => {
    expect(f.db.agentDbExecScript("CREATE TABLE task48_mcp_denied (value TEXT); INSERT INTO task48_mcp_denied VALUES ('synthetic-before');").ok).toBe(true);
    function directRows() {
      const db = new DatabaseSync(path.join(f.dir, "agent-store.sqlite"), { readOnly: true });
      try { return db.prepare("SELECT value FROM task48_mcp_denied ORDER BY value").all(); } finally { db.close(); }
    }
    f.role("viewer"); const before = f.bytes(), previous = directRows();
    const response = await f.call("agent_browser_db_exec", { sql: "INSERT INTO task48_mcp_denied VALUES ('synthetic-denied-write')" });
    // Capture the actual database before asserting the HTTP/tool verdict: RED
    // must demonstrate the unauthorized physical write, not just a status typo.
    const observed = directRows();
    expect({ isError: Boolean(response.body.result.isError), rows: observed }).toEqual({ isError: true, rows: previous });
    expect(response.payload.error).toMatch(/member role/); expect(f.bytes()).toEqual(before);
    f.db.closeAgentDb();
    const queried = await f.call("agent_browser_db_query", { sql: "SELECT value FROM task48_mcp_denied ORDER BY value" });
    expect(queried.payload.rows).toEqual(previous); expect(queried.body.result.isError).toBeUndefined();
  });
  it("viewer conversation_create cannot add a persisted conversation; list remains readable", async () => {
    f.agent.createConversation("Synthetic baseline inventory");
    const file = path.join(f.dir, "agent-conversations.json"), before = fs.readFileSync(file);
    const inventory = JSON.parse(before.toString()); f.role("viewer");
    const response = await f.call("agent_browser_conversation_create", { title: "Synthetic denied conversation" });
    const observed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect({ isError: Boolean(response.body.result.isError), count: observed.length }).toEqual({ isError: true, count: inventory.length });
    expect(fs.readFileSync(file)).toEqual(before); expect(response.payload.error).toMatch(/member role/);
    expect((await f.call("agent_browser_conversations_list")).payload.conversations).toHaveLength(inventory.length);
  });
  it("viewer extension install/delete are denied before download and config writes", async () => {
    h.extensions.addOrUpdateChromeStoreExtension.mockResolvedValue({ id: extId });
    f.role("viewer"); const before = f.bytes();
    for (const name of ["agent_browser_install_extension", "agent_browser_delete_extension"]) {
      const denied = await f.call(name, { dirId, extId });
      expect(denied.body.result.isError).toBe(true); expect(denied.payload.error).toMatch(/member role/);
      expect(f.bytes()).toEqual(before);
    }
    expect(h.extensions.addOrUpdateChromeStoreExtension).not.toHaveBeenCalled();
  });
  it("viewer skill_install cannot enable a disabled real skill", async () => {
    f.skills.setSkillMeta("browser-automation", { enabled: false });
    f.role("viewer"); const before = f.bytes();
    const denied = await f.call("agent_browser_skill_install", { skillId: "browser-automation" });
    expect(denied.body.result.isError).toBe(true); expect(denied.payload.error).toMatch(/member role/);
    expect(f.bytes()).toEqual(before); f.config.reloadConfig();
    expect(f.skills.getSkill("browser-automation")?.enabled).toBe(false);
  });
});
