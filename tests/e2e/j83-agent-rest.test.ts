// J83: Agent module REST endpoints (Slice 60).
// Read+write REST surface for LLM config, conversations, one-shot chat, run
// traces, the agent SQLite store and pending approvals — backed by the same
// service layer as IPC, with team RBAC (viewer → 403 on writes) and OpenAPI
// registration. A real chat-stream (seeded through the preload API) verifies
// the run-trace endpoints against a live run.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { startMockLlm } from "./helpers/mock-llm.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j83");

function apiRequest(
  port: number, token: string, method: string, p: string, body?: any, auth = true,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = "Bearer " + token;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: p, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function setLocalRole(role: string): void {
  const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
  const deviceId = cfg.deviceId || "local";
  cfg.team = {
    name: "J83 Workspace",
    ownerDeviceId: deviceId,
    members: [{ deviceId, name: "Local", role, addedAt: Date.now() }],
    enabled: true,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
}

describe("J83 — Agent module REST endpoints", () => {
  let h: TestAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let port = 0;
  let token = "";

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20, chunks: ["J83 ", "mock ", "reply."] });
    h = await setupTestApp({
      userDataDir: USERDATA,
      env: { AGENT_BROWSER_API_PORT: "0" },
    });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      if (st && st.running && st.port > 0) { port = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(port, "REST API server must be running").toBeGreaterThan(0);
    const tok = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken());
    token = tok.token;
    expect(token, "REST API token must be available").toBeTruthy();
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await closeApp(h);
  }, 90000);

  it("registers the agent endpoints in OpenAPI", async () => {
    const spec = await apiRequest(port, token, "GET", "/openapi.json");
    expect(spec.status).toBe(200);
    const paths = spec.body.paths;
    expect(paths["/api/agent/llm-config"].get).toBeTruthy();
    expect(paths["/api/agent/llm-config"].put).toBeTruthy();
    expect(paths["/api/agent/conversations"].get).toBeTruthy();
    expect(paths["/api/agent/conversations"].post).toBeTruthy();
    expect(paths["/api/agent/conversations/{id}"].get).toBeTruthy();
    expect(paths["/api/agent/conversations/{id}"].patch).toBeTruthy();
    expect(paths["/api/agent/conversations/{id}"].delete).toBeTruthy();
    expect(paths["/api/agent/chat-simple"].post).toBeTruthy();
    expect(paths["/api/agent/chat"].post).toBeTruthy();
    expect(paths["/api/agent/runs"].get).toBeTruthy();
    expect(paths["/api/agent/runs"].delete).toBeTruthy();
    expect(paths["/api/agent/runs/{runId}"].get).toBeTruthy();
    expect(paths["/api/agent/runs/{runId}"].delete).toBeTruthy();
    expect(paths["/api/agent/db/tables"].get).toBeTruthy();
    expect(paths["/api/agent/db/{table}"].get).toBeTruthy();
    expect(paths["/api/agent/db/query"].post).toBeTruthy();
    expect(paths["/api/agent/db/exec"].post).toBeTruthy();
    expect(paths["/api/agent/approvals"].get).toBeTruthy();
    expect(paths["/api/agent/approvals/{id}/resolve"].post).toBeTruthy();
  }, 20000);

  it("reads, validates and saves the LLM config over REST", async () => {
    const initial = await apiRequest(port, token, "GET", "/api/agent/llm-config");
    expect(initial.status).toBe(200);
    expect(initial.body.config).toBeNull();

    const missingKey = await apiRequest(port, token, "PUT", "/api/agent/llm-config", {
      provider: "openai", model: "x",
    });
    expect(missingKey.status).toBe(400);

    const saved = await apiRequest(port, token, "PUT", "/api/agent/llm-config", {
      provider: "openai",
      apiKey: "sk-j83",
      model: "e2e-mock-model",
      apiUrl: mock.url,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.success).toBe(true);
    expect(saved.body.config.hasApiKey).toBe(true);
    expect(saved.body.config.apiKey).toBeUndefined();

    const reread = await apiRequest(port, token, "GET", "/api/agent/llm-config");
    expect(reread.body.config.provider).toBe("openai");
    expect(reread.body.config.model).toBe("e2e-mock-model");
    expect(reread.body.config.hasApiKey).toBe(true);
    expect(reread.body.config.apiKey).toBeUndefined();
  }, 20000);

  it("creates, lists, gets, renames, chats and deletes a conversation", async () => {
    const created = await apiRequest(port, token, "POST", "/api/agent/conversations", { title: "J83 chat" });
    expect(created.status).toBe(201);
    expect(created.body.conversation.title).toBe("J83 chat");
    expect(created.body.conversation.messageCount).toBe(0);
    const convId = created.body.conversation.id;
    expect(convId).toMatch(/^conv_/);

    const list = await apiRequest(port, token, "GET", "/api/agent/conversations");
    expect(list.status).toBe(200);
    expect(list.body.conversations.some((c: any) => c.id === convId)).toBe(true);

    const got = await apiRequest(port, token, "GET", "/api/agent/conversations/" + convId);
    expect(got.status).toBe(200);
    expect(Array.isArray(got.body.conversation.messages)).toBe(true);

    const renamed = await apiRequest(port, token, "PATCH", "/api/agent/conversations/" + convId, { title: "J83 renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.conversation.title).toBe("J83 renamed");

    const chat = await apiRequest(port, token, "POST", "/api/agent/chat-simple", {
      messages: [{ role: "user", content: "hello j83" }],
    });
    expect(chat.status).toBe(200);
    expect(chat.body.reply).toContain("J83 mock reply.");
    expect(mock.requests.length).toBeGreaterThan(0);

    const del = await apiRequest(port, token, "DELETE", "/api/agent/conversations/" + convId);
    expect(del.status).toBe(200);
    const again = await apiRequest(port, token, "DELETE", "/api/agent/conversations/" + convId);
    expect(again.status).toBe(404);
    const missing = await apiRequest(port, token, "GET", "/api/agent/conversations/" + convId);
    expect(missing.status).toBe(404);
  }, 30000);

  it("validates chat-simple payloads", async () => {
    const noMessages = await apiRequest(port, token, "POST", "/api/agent/chat-simple", {});
    expect(noMessages.status).toBe(400);
    const badRole = await apiRequest(port, token, "POST", "/api/agent/chat-simple", {
      messages: [{ role: "nope", content: "x" }],
    });
    expect(badRole.status).toBe(400);
  }, 20000);

  it("runs conversation-scoped tool-calling chat over REST", async () => {
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "r1", name: "set_var", arguments: { key: "rest_probe", value: "ok" } }] },
      { chunks: ["Final ", "rest ", "answer."] },
    ]);
    const conv = await apiRequest(port, token, "POST", "/api/agent/conversations", { title: "J83 tool chat" });
    const convId = conv.body.conversation.id;

    const badConv = await apiRequest(port, token, "POST", "/api/agent/chat", {
      conversationId: "conv_missing", message: "hi",
    });
    expect(badConv.status).toBe(404);
    const missingMsg = await apiRequest(port, token, "POST", "/api/agent/chat", { conversationId: convId });
    expect(missingMsg.status).toBe(400);

    const chat = await apiRequest(port, token, "POST", "/api/agent/chat", {
      conversationId: convId, message: "run a tool then answer",
    });
    expect(chat.status).toBe(200);
    expect(chat.body.reply).toContain("Final rest answer.");
    expect(chat.body.toolCalls.length).toBeGreaterThan(0);
    expect(chat.body.toolCalls[0].name).toBe("set_var");
    expect(chat.body.toolCalls[0].redacted).toBe(true);
    expect(chat.body.runId).toMatch(/^run_/);

    const conv2 = await apiRequest(port, token, "GET", "/api/agent/conversations/" + convId);
    expect(conv2.body.conversation.messages.some((m: any) =>
      m.role === "assistant" && m.content.includes("Final rest answer."))).toBe(true);

    const run = await apiRequest(port, token, "GET", "/api/agent/runs/" + chat.body.runId);
    expect(run.status).toBe(200);
    expect(run.body.run.status).toBe("done");
    expect(run.body.run.steps.some((s: any) => s.tool === "set_var")).toBe(true);

    const del = await apiRequest(port, token, "DELETE", "/api/agent/conversations/" + convId);
    expect(del.status).toBe(200);
    const delRun = await apiRequest(port, token, "DELETE", "/api/agent/runs/" + chat.body.runId);
    expect(delRun.status).toBe(200);
  }, 30000);
  it("browses and writes the agent SQLite store over REST", async () => {
    const tables0 = await apiRequest(port, token, "GET", "/api/agent/db/tables");
    expect(tables0.status).toBe(200);
    expect(Array.isArray(tables0.body.tables)).toBe(true);

    const created = await apiRequest(port, token, "POST", "/api/agent/db/exec", {
      sql: "CREATE TABLE IF NOT EXISTS j83_items (id INTEGER PRIMARY KEY, label TEXT)",
    });
    expect(created.status).toBe(200);

    const inserted = await apiRequest(port, token, "POST", "/api/agent/db/exec", {
      sql: "INSERT INTO j83_items (label) VALUES ('alpha'), ('beta')",
    });
    expect(inserted.status).toBe(200);

    const tables1 = await apiRequest(port, token, "GET", "/api/agent/db/tables");
    expect(tables1.body.tables.some((t: any) => t.name === "j83_items")).toBe(true);

    const data = await apiRequest(port, token, "GET", "/api/agent/db/j83_items");
    expect(data.status).toBe(200);
    expect(data.body.rows.length).toBe(2);
    expect(data.body.columns).toContain("label");

    const query = await apiRequest(port, token, "POST", "/api/agent/db/query", {
      sql: "SELECT label FROM j83_items ORDER BY id",
    });
    expect(query.status).toBe(200);
    expect(query.body.ok).toBe(true);
    expect(query.body.count).toBe(2);
    expect(query.body.rows[0].label).toBe("alpha");

    const writeQuery = await apiRequest(port, token, "POST", "/api/agent/db/query", {
      sql: "DELETE FROM j83_items",
    });
    expect(writeQuery.status).toBe(400);
    expect(writeQuery.body.ok).toBe(false);

    const badTable = await apiRequest(port, token, "GET", "/api/agent/db/j83-bad;DROP");
    expect(badTable.status).toBe(400);
  }, 30000);

  it("lists, reads and deletes run traces (seeded by a real chat-stream)", async () => {
    const empty = await apiRequest(port, token, "GET", "/api/agent/runs");
    expect(empty.status).toBe(200);

    const missingGet = await apiRequest(port, token, "GET", "/api/agent/runs/run_missing");
    expect(missingGet.status).toBe(404);
    const missingDel = await apiRequest(port, token, "DELETE", "/api/agent/runs/run_missing");
    expect(missingDel.status).toBe(404);

    const conv = await apiRequest(port, token, "POST", "/api/agent/conversations", { title: "J83 run" });
    const convId = conv.body.conversation.id;
    await h.page.evaluate(async (cid: string) => {
      const api = (window as any).agentBrowser.api;
      (window as any).__done = false;
      api.on("agent:stream-done", () => { (window as any).__done = true; });
      await api.agent.chatStream(cid, "seed a run trace", "j83-stream");
    }, convId);
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const done = await h.page.evaluate(() => (window as any).__done);
      if (done) break;
      await h.page.waitForTimeout(200);
    }

    const list = await apiRequest(port, token, "GET", "/api/agent/runs");
    expect(list.status).toBe(200);
    const seeded = list.body.runs.filter((r: any) => r.source?.type === "chat" && r.source?.conversationId === convId);
    expect(seeded.length).toBeGreaterThan(0);
    const runId = seeded[0].id;
    expect(runId).toMatch(/^run_/);
    expect(seeded[0].status).toBe("done");

    const detail = await apiRequest(port, token, "GET", "/api/agent/runs/" + runId);
    expect(detail.status).toBe(200);
    expect(detail.body.run.id).toBe(runId);
    expect(Array.isArray(detail.body.run.steps)).toBe(true);

    const deleted = await apiRequest(port, token, "DELETE", "/api/agent/runs/" + runId);
    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);
    const gone = await apiRequest(port, token, "GET", "/api/agent/runs/" + runId);
    expect(gone.status).toBe(404);

    const cleared = await apiRequest(port, token, "DELETE", "/api/agent/runs");
    expect(cleared.status).toBe(200);
    expect(typeof cleared.body.deleted).toBe("number");
    const afterClear = await apiRequest(port, token, "GET", "/api/agent/runs");
    expect(afterClear.body.runs.length).toBe(0);
  }, 40000);

  it("lists pending approvals and validates resolve payloads", async () => {
    const list = await apiRequest(port, token, "GET", "/api/agent/approvals");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.approvals)).toBe(true);

    const missing = await apiRequest(port, token, "POST", "/api/agent/approvals/appr_missing/resolve", { decision: "once" });
    expect(missing.status).toBe(404);
    const badDecision = await apiRequest(port, token, "POST", "/api/agent/approvals/appr_missing/resolve", { decision: "maybe" });
    expect(badDecision.status).toBe(400);
  }, 20000);

  it("denies viewer writes over REST with 403 but keeps reads open", async () => {
    setLocalRole("viewer");
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());

    const putCfg = await apiRequest(port, token, "PUT", "/api/agent/llm-config", {
      provider: "openai", apiKey: "sk-viewer", model: "x",
    });
    expect(putCfg.status).toBe(403);
    const createConv = await apiRequest(port, token, "POST", "/api/agent/conversations", { title: "nope" });
    expect(createConv.status).toBe(403);
    const chat = await apiRequest(port, token, "POST", "/api/agent/chat", {
      conversationId: "conv_missing", message: "nope",
    });
    expect(chat.status).toBe(403);
    const patchConv = await apiRequest(port, token, "PATCH", "/api/agent/conversations/conv_missing", { title: "nope" });
    expect(patchConv.status).toBe(403);
    const clearRuns = await apiRequest(port, token, "DELETE", "/api/agent/runs");
    expect(clearRuns.status).toBe(403);
    const dbExec = await apiRequest(port, token, "POST", "/api/agent/db/exec", { sql: "CREATE TABLE x (a)" });
    expect(dbExec.status).toBe(403);
    const resolve = await apiRequest(port, token, "POST", "/api/agent/approvals/appr_missing/resolve", { decision: "once" });
    expect(resolve.status).toBe(403);

    const getCfg = await apiRequest(port, token, "GET", "/api/agent/llm-config");
    expect(getCfg.status).toBe(200);
    const getConvs = await apiRequest(port, token, "GET", "/api/agent/conversations");
    expect(getConvs.status).toBe(200);
    const getRuns = await apiRequest(port, token, "GET", "/api/agent/runs");
    expect(getRuns.status).toBe(200);
    const getTables = await apiRequest(port, token, "GET", "/api/agent/db/tables");
    expect(getTables.status).toBe(200);
    const getApprovals = await apiRequest(port, token, "GET", "/api/agent/approvals");
    expect(getApprovals.status).toBe(200);
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
