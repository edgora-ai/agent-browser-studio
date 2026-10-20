import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { h, startFixture } from "./rest-mcp-socket-helper.js";

let f: Awaited<ReturnType<typeof startFixture>>;
const dirId = "ab_task48_mcp", extId = "c".repeat(32);
beforeAll(async () => { f = await startFixture("mcp"); });
afterAll(async () => { await f?.close(); });
beforeEach(() => {
  vi.clearAllMocks(); h.tool.mockReset(); h.detectConfig = null;
  f.store.transact((draft: any) => { delete draft.team; delete draft.llm; draft.proxies = {}; draft.browserProfiles = { [dirId]: { name: "Synthetic MCP environment", engine: "chromium", proxyMode: "none" } }; });
});
async function tool(name: string, args: any = {}) {
  const r = await f.call(name, args); expect(r.status, r.text).toBe(200); expect(r.body.error, r.text).toBeUndefined(); return r;
}
function savedLlm() { f.agent.saveLlmConfig({ provider: "openai", apiKey: "synthetic-api-key-never-sent", model: "synthetic-model" }); }

describe("MCP built-in tools on real HTTP dispatch with persistent business services", () => {
  it("lists profile sync facts, redacts proxy/account secrets and uses one runtime snapshot", async () => {
    h.browser.listBrowserProfiles.mockReturnValueOnce([{ dirId, name: "Synthetic MCP environment", running: false, proxyMode: "none", syncStatus: "unknown", syncScope: "portable-profile+preferences", syncReason: "legacy-marker" }]);
    const profiles = await tool("agent_browser_list_profiles");
    expect(profiles.payload.profiles[0]).toMatchObject({ dirId, proxy: "(no proxy)", syncStatus: "unknown", syncReason: "legacy-marker" }); expect(profiles.body.result.isError).toBeUndefined();
    expect(h.browser.listBrowserProfiles).toHaveBeenCalledWith(h.browser.getProfileRuntimeSnapshot.mock.results[0].value);
    f.config.addProxy("synthetic-proxy", { type: "http", host: "proxy.synthetic.invalid", port: 8080, username: "private-user", password: "private-proxy-password" });
    f.config.setProfileProxy(dirId, "synthetic-proxy", "named");
    const proxies = await tool("agent_browser_list_proxies"); expect(proxies.payload.proxies[0].hasAuth).toBe(true); expect(proxies.text).not.toContain("private-user"); expect(proxies.text).not.toContain("private-proxy-password");
    f.agent.saveAccounts([{ platformUrl: "https://synthetic.invalid", platformUserName: "account-fixture", platformPassword: "private-account-password", tags: ["fixture"] }]);
    const accounts = await tool("agent_browser_list_accounts"); expect(accounts.payload.accounts[0]).toMatchObject({ username: "account-fixture", hasPassword: true }); expect(accounts.text).not.toContain("private-account-password");
    const profile = await tool("agent_browser_profile_info", { dirId }); expect(profile.payload.proxy.hasAuth).toBe(true); expect(profile.text).not.toContain("private-proxy-password");
    const stat = await tool("agent_browser_status", { dirId }); expect(stat.payload.running).toBe(false);
  });
  it("preserves launch errors and reports real stop outcomes, with legacy aliases still accepted", async () => {
    h.browser.launchBrowser.mockResolvedValueOnce({ pid: 12, cdpPort: 12345 });
    expect((await tool("cloak_launch_profile", { dirId })).payload).toMatchObject({ success: true, dirId, pid: 12 });
    h.browser.launchBrowser.mockRejectedValueOnce(Object.assign(new Error("Restart first"), { code: "restart-required" }));
    const failed = await tool("agent_browser_launch_profile", { dirId }); expect(failed.payload.code).toBe("restart-required"); expect(failed.body.result.isError).toBe(true);
    h.browser.launchBrowser.mockRejectedValueOnce(new Error("synthetic native refusal")); expect((await tool("agent_browser_launch_profile", { dirId })).payload.code).toBeUndefined();
    h.browser.stopBrowser.mockReturnValueOnce(true); expect((await tool("agent_browser_stop_profile", { dirId })).payload.success).toBe(true);
  });
  it("allowed extension changes write real config, survive reload, and missing/invalid downloads never run", async () => {
    await tool("agent_browser_list_extensions", { dirId });
    h.extensions.addOrUpdateChromeStoreExtension.mockResolvedValueOnce({ id: extId, name: "Synthetic extension" });
    const installed = await tool("agent_browser_install_extension", { dirId, extId }); expect(installed.payload.success).toBe(true);
    expect(f.disk().browserProfiles[dirId].extensions[extId]).toBe(true); f.config.reloadConfig(); expect(f.config.getProfileMeta(dirId)?.extensions?.[extId]).toBe(true);
    await tool("agent_browser_delete_extension", { dirId, extId }); expect(f.disk().browserProfiles[dirId].extensions[extId]).toBe(false);
    h.extensions.addOrUpdateChromeStoreExtension.mockRejectedValueOnce(new Error("synthetic package unavailable"));
    expect((await tool("agent_browser_install_extension", { dirId, extId })).body.result.isError).toBe(true);
    const count = h.extensions.addOrUpdateChromeStoreExtension.mock.calls.length;
    const missing = await tool("agent_browser_install_extension", { dirId: "ab_missing", extId }); expect(missing.body.result.isError).toBe(true); expect(h.extensions.addOrUpdateChromeStoreExtension).toHaveBeenCalledTimes(count);
  });
  it("passthrough names/legacy browser aliases use real schemas and return failures truthfully", async () => {
    const list = await f.rpc("tools/list"); const defs = list.body.result.tools;
    const original = f.agent.AGENT_TOOLS.find((t: any) => t.function.name === "db_query");
    expect(defs.find((t: any) => t.name === "agent_browser_db_query").inputSchema).toEqual(original!.function.parameters);
    h.tool.mockResolvedValueOnce({ skipped: true, reason: "synthetic navigation refusal" });
    expect((await tool("cloak_browser_navigate", { port: 12345, url: "https://synthetic.invalid" })).body.result.isError).toBe(true);
    expect(h.tool).toHaveBeenLastCalledWith("browser_navigate", { port: 12345, url: "https://synthetic.invalid" });
    h.tool.mockRejectedValueOnce(new Error("synthetic transport refused")); expect((await tool("agent_browser_navigate", { port: 12345, url: "https://synthetic.invalid" })).body.result.isError).toBe(true);
    expect((await tool("unknown_fixture_tool")).payload.error).toContain("Unknown tool");
  });
  it("uses the real SQLite tool branch: write -> independent file query -> reopen -> MCP query/search", async () => {
    const created = await tool("agent_browser_db_exec", { sql: "CREATE TABLE task48_mcp_rows (id INTEGER PRIMARY KEY, value TEXT)" }); expect(created.body.result.isError).toBeUndefined();
    await tool("agent_browser_db_exec", { sql: "INSERT INTO task48_mcp_rows(value) VALUES (?)", params: ["synthetic-persisted-value"] });
    const direct = new DatabaseSync(path.join(f.dir, "agent-store.sqlite"), { readOnly: true });
    try { expect(direct.prepare("SELECT value FROM task48_mcp_rows WHERE value = ?").get("synthetic-persisted-value")).toMatchObject({ value: "synthetic-persisted-value" }); } finally { direct.close(); }
    f.db.closeAgentDb();
    const queried = await tool("agent_browser_db_query", { sql: "SELECT value FROM task48_mcp_rows WHERE value = ?", params: ["synthetic-persisted-value"] });
    expect(queried.payload.rows).toEqual([{ value: "synthetic-persisted-value" }]); expect(queried.payload.count).toBe(1);
    expect((await tool("agent_browser_db_tables")).payload.tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "task48_mcp_rows", rowCount: 1 })]));
    const readonly = await tool("agent_browser_db_query", { sql: "DELETE FROM task48_mcp_rows" }); expect(readonly.body.result.isError).toBe(true);
    expect(f.db.agentDbQuery("SELECT COUNT(*) AS c FROM task48_mcp_rows").rows).toEqual([{ c: 1 }]);
  });
  it("persists real conversation create/get/list and returns missing conversation/run facts", async () => {
    const created = await tool("agent_browser_conversation_create", { title: "  Synthetic persisted conversation  " }); const id = created.payload.conversation.id;
    const disk = JSON.parse(fs.readFileSync(path.join(f.dir, "agent-conversations.json"), "utf8")); expect(disk.some((c: any) => c.id === id && c.title === "Synthetic persisted conversation")).toBe(true);
    expect((await tool("agent_browser_conversation_get", { conversationId: id })).payload.conversation.id).toBe(id);
    expect((await tool("agent_browser_conversations_list")).payload.conversations).toEqual(expect.arrayContaining([expect.objectContaining({ id, messageCount: 0 })]));
    expect((await tool("agent_browser_conversation_get", { conversationId: "synthetic-absent" })).body.result.isError).toBe(true);
    expect((await tool("agent_browser_agent_run_get", { runId: "synthetic-absent" })).body.result.isError).toBe(true);
    const run = f.runs.startRun({ name: "Synthetic persisted MCP run", dirId, source: { type: "chat", conversationId: id } }); f.runs.finishRun(run.id, "done");
    expect((await tool("agent_browser_agent_run_get", { runId: run.id })).payload.run.status).toBe("done");
    expect((await tool("agent_browser_runs_list", { dirId, limit: 1 })).payload.runs).toHaveLength(1);
    await tool("agent_browser_jobs_list", { limit: 2 }); await tool("agent_browser_automation_list");
  });
  it("skill install persists a real repository entry without downloading anything", async () => {
    f.skills.addOrUpdateSkill({ id: "mcp-synthetic-skill", prompt: "Synthetic fixture only", enabled: false });
    const installed = await tool("agent_browser_skill_install", { skillId: "mcp-synthetic-skill" }); expect(installed.payload.skill.enabled).toBe(true);
    expect(f.disk().skillRepository["mcp-synthetic-skill"].enabled).toBe(true); f.config.reloadConfig();
    expect((await tool("agent_browser_skill_get", { skillId: "mcp-synthetic-skill" })).payload.skill.enabled).toBe(true);
    expect((await tool("agent_browser_skills_list", { filter: "mcp-synthetic" })).payload.skills.some((s: any) => s.id === "mcp-synthetic-skill")).toBe(true);
    expect((await tool("agent_browser_skill_get", { skillId: "missing-fixture-skill" })).body.result.isError).toBe(true);
    expect((await tool("agent_browser_skill_install", { skillId: "missing-fixture-skill" })).body.result.isError).toBe(true);
  });
  it("platform catalog, engine status and approvals are read-only; allow-decisions cannot self-approve", async () => {
    expect((await tool("agent_browser_platform_adapters_list", { filter: "generic" })).payload.adapters.length).toBeGreaterThan(0);
    await tool("agent_browser_platform_adapter_get", { adapterId: "generic-web" });
    await tool("agent_browser_platform_adapter_get", { adapterId: "ignored", url: "https://synthetic.invalid" });
    expect((await tool("agent_browser_platform_adapter_get", { adapterId: "missing-fixture-adapter" })).body.result.isError).toBe(true);
    expect((await tool("agent_browser_platform_adapter_detect", { url: "https://synthetic.invalid" })).payload.adapter.id).toBe("generic-web");
    expect((await tool("agent_browser_platform_adapter_detect")).body.result.isError).toBe(true);
    await tool("agent_browser_engine_status"); await tool("agent_browser_approvals_list");
    for (const args of [{}, { approvalId: "missing", decision: "invalid" }, { approvalId: "missing", decision: "once" }, { approvalId: "missing", decision: "always" }, { approvalId: "missing", decision: "deny" }]) {
      expect((await tool("agent_browser_approval_resolve", args)).body.result.isError).toBe(true);
    }
    const pending = f.approvals.requestApproval({ category: "db-destroy", tool: "db_exec", description: "Synthetic deny only", detail: "DELETE task48_synthetic" });
    const id = f.approvals.listPendingApprovals()[0].id;
    expect((await tool("agent_browser_approval_resolve", { approvalId: id, decision: "deny" })).payload.success).toBe(true);
    expect(await pending).toEqual({ allowed: false, decision: "deny" });
  });
});

describe("MCP chat transport with only the model boundary stubbed", () => {
  it("validates inputs/config without invoking any model and redacts real saved config", async () => {
    expect((await tool("agent_browser_agent_chat_simple")).body.result.isError).toBe(true);
    expect((await tool("agent_browser_agent_chat_simple", { messages: [{ role: "user", content: "fixture" }] })).payload.error).toMatch(/No LLM config/);
    savedLlm();
    expect((await tool("agent_browser_llm_config")).payload.config).toMatchObject({ model: "synthetic-model", hasApiKey: true });
    expect((await tool("agent_browser_llm_config")).text).not.toContain("synthetic-api-key-never-sent");
    expect((await tool("agent_browser_agent_chat_simple", { messages: [{ role: "tool", content: "bad role" }] })).body.result.isError).toBe(true);
    h.simpleChat.mockResolvedValueOnce({ role: "assistant", content: "Synthetic simple response" });
    expect((await tool("agent_browser_agent_chat_simple", { messages: [{ role: "user", content: "Synthetic request" }] })).payload.reply).toBe("Synthetic simple response");
    h.simpleChat.mockRejectedValueOnce(new Error("Synthetic provider refusal")); expect((await tool("agent_browser_agent_chat_simple", { messages: [{ role: "user", content: "Synthetic request" }] })).body.result.isError).toBe(true);
  });
  it("denies viewer chat before storage/model work and rejects bad/missing conversations", async () => {
    f.role("viewer"); const before = f.bytes(); const denied = await tool("agent_browser_agent_chat", { conversationId: "missing", message: "fixture" });
    expect(denied.body.result.isError).toBe(true); expect(f.bytes()).toEqual(before); expect(h.chat).not.toHaveBeenCalled();
    f.role("member"); expect((await tool("agent_browser_agent_chat")).body.result.isError).toBe(true);
    expect((await tool("agent_browser_agent_chat", { conversationId: "missing", message: "fixture" })).payload.error).toMatch(/No LLM config/);
    savedLlm(); expect((await tool("agent_browser_agent_chat", { conversationId: "missing", message: "fixture" })).payload.error).toMatch(/not found/);
  });
  it.each(["success", "returned-error", "empty", "throw"])("records real run terminal state and redacted messages for %s", async outcome => {
    savedLlm(); const c = f.agent.createConversation("Synthetic " + outcome);
    if (outcome === "success") h.chat.mockResolvedValueOnce({ messages: [{ role: "assistant", content: "Synthetic final", tool_calls: [{ function: { name: "db_query", arguments: "private-arguments" } }] }], endReason: "completed" });
    if (outcome === "returned-error") h.chat.mockResolvedValueOnce({ messages: [], error: "Synthetic round limit", endReason: "round_limit" });
    if (outcome === "empty") h.chat.mockResolvedValueOnce({ messages: [{ role: "assistant", content: "" }] });
    if (outcome === "throw") h.chat.mockRejectedValueOnce(new Error("Synthetic provider failure"));
    const response = await tool("agent_browser_agent_chat", { conversationId: c.id, message: "Synthetic request" });
    expect(Boolean(response.body.result.isError)).toBe(outcome !== "success");
    const run = f.runs.getRun(response.payload.runId)!; expect(run.status).toBe(outcome === "success" ? "done" : "error");
    expect(f.disk().agentRuns.find((r: any) => r.id === run.id).status).toBe(run.status);
    f.config.reloadConfig(); expect(f.runs.getRun(run.id)?.status).toBe(run.status);
    if (outcome === "success") { expect(response.text).not.toContain("private-arguments"); expect(response.payload.toolCalls).toEqual([{ name: "db_query", redacted: true }]); }
    const disk = JSON.parse(fs.readFileSync(path.join(f.dir, "agent-conversations.json"), "utf8")); expect(disk.find((row: any) => row.id === c.id).messages.at(-1).role).toBe("assistant");
  });
});

it("uses an actual SSE connection and correlates its JSON-RPC response, then tears down the socket", async () => {
  let res!: http.IncomingMessage, req!: http.ClientRequest, text = "";
  let endpoint!: (value: string) => void, event!: (value: any) => void;
  const announced = new Promise<string>(resolve => { endpoint = resolve; }); const message = new Promise<any>(resolve => { event = resolve; });
  req = http.get({ host: "127.0.0.1", port: f.mcpPort, path: "/sse", agent: false, headers: { Authorization: `Bearer ${f.mcp!.getMcpToken()}` } }, response => {
    res = response; response.setEncoding("utf8"); response.on("data", chunk => {
      text += chunk;
      for (const line of text.split("\n")) if (line.startsWith("data: ")) {
        const value = JSON.parse(line.slice(6)); if (value.method === "endpoint") endpoint(value.params.endpoint); if (value.result?.serverInfo) event(value);
      }
    });
  });
  req.on("error", () => { /* deliberate client teardown is not a server error */ });
  req.setTimeout(1500, () => req.destroy(new Error("SSE fixture deadline")));
  try {
    const route = await announced; const accepted = await f.rpc("initialize", undefined, route);
    expect(accepted.status).toBe(202); expect((await message).result.serverInfo.name).toBe("agent-browser-studio");
    expect((await f.rpc("notifications/initialized", undefined, route)).status).toBe(202);
  } finally { res?.destroy(); req.destroy(); }
});
