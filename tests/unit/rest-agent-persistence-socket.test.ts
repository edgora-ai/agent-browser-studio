import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { h, startFixture } from "./rest-mcp-socket-helper.js";

let f: Awaited<ReturnType<typeof startFixture>>;
beforeAll(async () => { f = await startFixture("rest"); });
afterAll(async () => { await f?.close(); });
beforeEach(() => { vi.clearAllMocks(); h.detectConfig = null; f.store.transact((draft: any) => { delete draft.team; delete draft.llm; }); });
async function status(route: string, expected: number, options: Parameters<typeof f.api>[1] = {}) { const r = await f.api(route, options); expect(r.status, r.text).toBe(expected); return r; }
const llm = () => f.agent.saveLlmConfig({ provider: "openai", apiKey: "synthetic-rest-llm-secret", model: "synthetic-model" });

describe("REST actual conversation/config stores and only synthetic model boundary", () => {
  it("persists normalized/redacted LLM config and denies viewer changes without disk effects", async () => {
    expect((await status("/api/agent/llm-config", 200)).body.config).toBeNull();
    await status("/api/agent/llm-config", 400, { method: "PUT", body: null });
    await status("/api/agent/llm-config", 400, { method: "PUT", body: { model: "missing-key" } });
    const saved = await status("/api/agent/llm-config", 200, { method: "PUT", body: { provider: "custom", apiKey: "synthetic-rest-llm-secret", apiUrl: " https://provider.synthetic.invalid/v1/chat/completions ", model: " synthetic-model " } });
    expect(saved.body.config).toMatchObject({ provider: "custom", model: "synthetic-model", hasApiKey: true }); expect(saved.text).not.toContain("synthetic-rest-llm-secret");
    expect(JSON.stringify(f.disk().llm)).not.toContain("synthetic-rest-llm-secret"); f.config.reloadConfig();
    expect((await status("/api/agent/llm-config", 200)).body.config.model).toBe("synthetic-model");
    f.role("viewer"); const before = f.bytes(); await status("/api/agent/llm-config", 403, { method: "PUT", body: { apiKey: "denied-key" } }); expect(f.bytes()).toEqual(before);
  });
  it("conversation create -> disk -> fresh read/list -> rename/delete uses real storage", async () => {
    const made = await status("/api/agent/conversations", 201, { body: { title: "  Synthetic REST conversation  " } }); const id = made.body.conversation.id;
    expect(made.body.conversation.titleKind).toBe("literal");
    const file = path.join(f.dir, "agent-conversations.json"); const disk = () => JSON.parse(fs.readFileSync(file, "utf8"));
    expect(disk().find((c: any) => c.id === id).title).toBe("Synthetic REST conversation");
    expect((await status(`/api/agent/conversations/${id}`, 200)).body.conversation.id).toBe(id);
    expect((await status("/api/agent/conversations", 200)).body.conversations.some((c: any) => c.id === id)).toBe(true);
    await status(`/api/agent/conversations/${id}`, 400, { method: "PATCH", body: { title: " " } });
    await status(`/api/agent/conversations/${id}`, 200, { method: "PATCH", body: { title: "Renamed synthetic REST conversation" } });
    expect(disk().find((c: any) => c.id === id).title).toBe("Renamed synthetic REST conversation");
    await status("/api/agent/conversations/absent-fixture", 404); await status("/api/agent/conversations/absent-fixture", 404, { method: "PATCH", body: { title: "Unused" } });
    await status("/api/agent/conversations/absent-fixture", 404, { method: "DELETE" });
    await status(`/api/agent/conversations/${id}`, 200, { method: "DELETE" }); expect(disk().some((c: any) => c.id === id)).toBe(false);
    await status(`/api/agent/conversations/${id}`, 404);
  });
  it("viewer conversation mutations and chat are refused before store/model effects", async () => {
    const c = f.agent.createConversation("Synthetic protected conversation"), file = path.join(f.dir, "agent-conversations.json");
    f.role("viewer"); const before = fs.readFileSync(file);
    for (const [route, method, body] of [
      ["/api/agent/conversations", "POST", { title: "Denied" }], [`/api/agent/conversations/${c.id}`, "PATCH", { title: "Denied" }],
      [`/api/agent/conversations/${c.id}`, "DELETE", undefined], ["/api/agent/chat", "POST", { conversationId: c.id, message: "Denied" }],
    ] as const) await status(route, 403, { method, body });
    expect(fs.readFileSync(file)).toEqual(before); expect(h.chat).not.toHaveBeenCalled();
  });
  it("simple-chat input/config errors cannot invoke a model, successful/refused synthetic replies are explicit", async () => {
    await status("/api/agent/chat-simple", 400, { body: {} });
    await status("/api/agent/chat-simple", 400, { body: { messages: [{ role: "user", content: "Fixture" }] } }); expect(h.simpleChat).not.toHaveBeenCalled();
    llm(); await status("/api/agent/chat-simple", 400, { body: { messages: [{ role: "tool", content: "invalid" }] } });
    h.simpleChat.mockResolvedValueOnce({ role: "assistant", content: "Synthetic response" }); expect((await status("/api/agent/chat-simple", 200, { body: { messages: [{ role: "user", content: "Fixture" }] } })).body.reply).toBe("Synthetic response");
    h.simpleChat.mockRejectedValueOnce(new Error("synthetic provider failure")); await status("/api/agent/chat-simple", 400, { body: { messages: [{ role: "user", content: "Fixture" }] } });
  });
  it("validates chat config and conversation before starting any run", async () => {
    await status("/api/agent/chat", 400, { body: {} });
    await status("/api/agent/chat", 400, { body: { conversationId: "absent", message: "Fixture" } });
    llm(); await status("/api/agent/chat", 404, { body: { conversationId: "absent", message: "Fixture" } }); expect(h.chat).not.toHaveBeenCalled();
  });
  it.each(["success", "returned-error", "empty", "throw"])("persists a single truthful terminal result for %s", async outcome => {
    llm(); const conv = f.agent.createConversation("Synthetic REST " + outcome);
    if (outcome === "success") h.chat.mockResolvedValueOnce({ messages: [{ role: "assistant", content: "Synthetic final", tool_calls: [{ function: { name: "db_query", arguments: "synthetic-secret-arguments" } }] }], endReason: "completed" });
    if (outcome === "returned-error") h.chat.mockResolvedValueOnce({ messages: [], error: "Synthetic round limit", endReason: "round_limit" });
    if (outcome === "empty") h.chat.mockResolvedValueOnce({ messages: [{ role: "assistant", content: "" }] });
    if (outcome === "throw") h.chat.mockRejectedValueOnce(new Error("Synthetic provider failed"));
    const result = await status("/api/agent/chat", outcome === "success" ? 200 : 400, { body: { conversationId: conv.id, message: "Synthetic fixture request" } });
    const runId = result.body.runId, expected = outcome === "success" ? "done" : "error";
    expect(f.disk().agentRuns.find((r: any) => r.id === runId).status).toBe(expected); f.config.reloadConfig();
    expect((await status(`/api/agent/runs/${runId}`, 200)).body.run.status).toBe(expected);
    expect((await status("/api/agent/runs?limit=200", 200)).body.runs.some((r: any) => r.id === runId)).toBe(true);
    const disk = JSON.parse(fs.readFileSync(path.join(f.dir, "agent-conversations.json"), "utf8")); expect(disk.find((c: any) => c.id === conv.id).messages.at(-1).role).toBe("assistant");
    expect(result.text).not.toContain("synthetic-secret-arguments");
  });
});

describe("REST real SQLite writes, read-only enforcement, durable queue controls", () => {
  it("SQL exec -> independent SQLite read -> close/reopen -> query/search, with refusal causing no writes", async () => {
    await status("/api/agent/db/exec", 400, { body: {} });
    await status("/api/agent/db/exec", 200, { body: { sql: "CREATE TABLE task48_rest_rows (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO task48_rest_rows(value) VALUES ('synthetic-sql-value');" } });
    const dbPath = path.join(f.dir, "agent-store.sqlite");
    function directCount() { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare("SELECT value FROM task48_rest_rows").all(); } finally { db.close(); } }
    expect(directCount()).toEqual([{ value: "synthetic-sql-value" }]); f.db.closeAgentDb();
    const query = await status("/api/agent/db/query", 200, { body: { sql: "SELECT value FROM task48_rest_rows WHERE value = 'synthetic-sql-value'" } }); expect(query.body.rows).toEqual([{ value: "synthetic-sql-value" }]);
    expect((await status("/api/agent/db/tables", 200)).body.tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "task48_rest_rows", rowCount: 1 })]));
    expect((await status("/api/agent/db/task48_rest_rows?limit=1&offset=0", 200)).body.total).toBe(1);
    await status("/api/agent/db/query", 400, { body: {} });
    const refused = await status("/api/agent/db/query", 400, { body: { sql: "DELETE FROM task48_rest_rows" } }); expect(refused.body.ok).toBe(false); expect(directCount()).toHaveLength(1);
    await status("/api/agent/db/invalid-table", 400); await status("/api/agent/db/exec", 400, { body: { sql: "not sql" } }); expect(directCount()).toHaveLength(1);
    f.role("viewer"); await status("/api/agent/db/exec", 403, { body: { sql: "DELETE FROM task48_rest_rows" } }); expect(directCount()).toHaveLength(1);
  });
  it("cancels a real persisted job and verifies disk/reopen/list while missing job stays 404", async () => {
    const job = f.jobs.enqueueJob({ ruleId: "synthetic-job-rule", ruleName: "Synthetic job", source: "test" });
    await status(`/api/jobs/${job.id}/cancel`, 200, { method: "POST" }); expect(h.automation.cancelRunningJob).toHaveBeenCalledWith(job.id);
    const db = new DatabaseSync(path.join(f.dir, "jobs.sqlite"), { readOnly: true });
    try { expect(db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id)).toMatchObject({ status: "cancelled" }); } finally { db.close(); }
    f.jobs.closeJobDb(); expect((await status("/api/jobs?status=cancelled&limit=200", 200)).body.jobs.some((j: any) => j.id === job.id)).toBe(true);
    await status("/api/jobs/missing-synthetic-job/cancel", 404, { method: "POST" });
    h.automation.retryAgentRun.mockResolvedValueOnce({ ok: true, runId: "synthetic-retry" }); await status("/api/runs/synthetic/retry", 200, { method: "POST" });
    h.automation.retryJobRuns.mockResolvedValueOnce({ ok: false, error: "synthetic not retryable" }); await status("/api/jobs/synthetic/retry", 400, { method: "POST" });
    await status("/api/runs?limit=invalid", 200);
    f.role("viewer"); await status(`/api/jobs/${job.id}/cancel`, 403, { method: "POST" });
  });
  it("run deletion refuses active/missing, respects role and clears only terminal traces", async () => {
    expect(f.db.ensureNewsRunResultSchema()).toEqual({ ok: true });
    const active = f.runs.startRun({ source: { type: "chat", conversationId: "synthetic" }, name: "Synthetic active run" });
    await status(`/api/agent/runs/${active.id}`, 409, { method: "DELETE" }); await status("/api/agent/runs/missing-synthetic", 404, { method: "DELETE" }); await status("/api/agent/runs/missing-synthetic", 404);
    f.role("viewer"); await status(`/api/agent/runs/${active.id}`, 403, { method: "DELETE" }); await status("/api/agent/runs", 403, { method: "DELETE" });
    f.role("member"); f.runs.finishRun(active.id, "error", "Synthetic end"); await status(`/api/agent/runs/${active.id}`, 200, { method: "DELETE" });
    const second = f.runs.startRun({ source: { type: "chat", conversationId: "synthetic" }, name: "Synthetic terminal run" }); f.runs.finishRun(second.id, "done");
    await status("/api/agent/runs", 200, { method: "DELETE" }); expect(f.runs.getRun(second.id)).toBeNull();
  });
});

describe("REST human approval policy, teams and bounded external status branches", () => {
  it("cannot self-approve risky actions, but deny resolves a real pending approval", async () => {
    await status("/api/agent/approvals", 200);
    await status("/api/agent/approvals/missing/resolve", 400, { body: { decision: "invalid" } });
    await status("/api/agent/approvals/missing/resolve", 403, { body: { decision: "always" } });
    await status("/api/agent/approvals/missing/resolve", 404, { body: { decision: "deny" } });
    const pending = f.approvals.requestApproval({ category: "db-destroy", tool: "db_exec", description: "Synthetic pending operation" });
    const id = f.approvals.listPendingApprovals()[0].id;
    await status(`/api/agent/approvals/${id}/resolve`, 200, { body: { decision: "deny" } }); expect(await pending).toEqual({ allowed: false, decision: "deny" });
    f.role("viewer"); await status("/api/agent/approvals/missing/resolve", 403, { body: { decision: "deny" } });
  });
  it("real team bootstrap/member/role/rename/removal persist and viewers cannot mutate a roster", async () => {
    await status("/api/team", 200);
    const init = await status("/api/team/init", 200, { body: { name: "Synthetic workspace" } }); expect(init.body.team.name).toBe("Synthetic workspace");
    await status("/api/team/members", 200, { body: { deviceId: "synthetic-other-device", name: "Other fixture", role: "viewer" } });
    expect(f.disk().team.members.some((m: any) => m.deviceId === "synthetic-other-device")).toBe(true); f.config.reloadConfig();
    await status("/api/team/members/synthetic-other-device/role", 200, { method: "PUT", body: { role: "member" } });
    await status("/api/team/rename", 200, { body: { name: "Renamed synthetic workspace" } }); expect(f.disk().team.name).toBe("Renamed synthetic workspace");
    await status("/api/team/members/synthetic-other-device", 200, { method: "DELETE" });
    f.role("viewer"); const before = f.bytes();
    await status("/api/team/members", 403, { body: { deviceId: "denied-device", name: "Denied", role: "member" } });
    await status("/api/team/members/synthetic-other-device", 403, { method: "DELETE" });
    await status("/api/team/members/synthetic-other-device/role", 403, { method: "PUT", body: { role: "member" } });
    await status("/api/team/rename", 403, { body: { name: "Denied rename" } });
    await status("/api/team/init", 400, { body: { name: "Cannot steal ownership" } }); expect(f.bytes()).toEqual(before);
  });
  it("update/DRM status and controlled successes/failures never invoke actual installers or the network", async () => {
    await status("/api/updates/status", 200);
    h.updates.checkForUpdates.mockResolvedValueOnce({ available: false }); await status("/api/updates/check", 200, { body: {} });
    h.updates.assertSafeManifestUrl.mockRejectedValueOnce(new Error("synthetic unsafe URL")); await status("/api/updates/check", 400, { body: { manifestUrl: "https://synthetic.invalid/manifest" } });
    h.updates.installRelease.mockResolvedValueOnce({ installed: "synthetic-version" }); await status("/api/updates/install", 200, { body: { version: "synthetic-version" } });
    h.updates.installRelease.mockRejectedValueOnce(new Error("synthetic install refused")); await status("/api/updates/install", 400, { body: {} });
    h.updates.activateVersion.mockReturnValueOnce({ active: "synthetic-version" }); await status("/api/updates/activate", 200, { body: { version: "synthetic-version" } });
    h.updates.activateVersion.mockImplementationOnce(() => { throw new Error("synthetic activation refused"); }); await status("/api/updates/activate", 400, { body: {} });
    h.updates.rollback.mockReturnValueOnce({ active: "synthetic-previous" }); await status("/api/updates/rollback", 200, { method: "POST" });
    h.updates.rollback.mockImplementationOnce(() => { throw new Error("synthetic rollback refused"); }); await status("/api/updates/rollback", 400, { method: "POST" });
    await status("/api/drm/status", 200); h.drm.ensureManagedCdm.mockReturnValueOnce(null);
    expect((await status("/api/drm/ensure", 200, { method: "POST" })).body.staged).toBe(false);
    const id = "ab_task48_drm"; f.store.transact((draft: any) => { draft.browserProfiles[id] = { name: "Synthetic DRM target", proxyMode: "none" }; });
    h.drm.setProfileDrm.mockReturnValueOnce(undefined); await status(`/api/profiles/${id}/drm`, 200, { body: { enabled: false } });
    h.drm.setProfileDrm.mockImplementationOnce(() => { throw new Error("synthetic DRM refusal"); }); await status(`/api/profiles/${id}/drm`, 400, { body: {} });
    f.role("viewer"); const before = f.bytes();
    // /drm/cdm-path is owned by its existing config service; don't touch native paths here.
    expect((await status("/api/audit?category=team&limit=1", 200)).body.audit).toEqual(expect.any(Array)); expect(f.bytes()).toEqual(before);
    await status("/api/audit", 200, { method: "DELETE" });
  });
});
