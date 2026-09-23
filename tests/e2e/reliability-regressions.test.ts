// Real Electron + REST + disk readback. No external LLM or browser is needed.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setupTestApp, closeApp, type TestAppHandle } from "./helpers/app.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-reliability-e2e-"));

function diskQuery(file: string, sql: string, params: string[] = []): unknown[] {
  const db = new DatabaseSync(path.join(USERDATA, file), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
function storedConfig(): any {
  return JSON.parse(fs.readFileSync(path.join(USERDATA, "config.json"), "utf-8"));
}

describe("reliability — read-only SQL, once scheduling and persistence", () => {
  let h: TestAppHandle;
  let port: number;
  let token: string;
  let conversationId: string;
  let onceId: string;

  async function launch(resetUserData: boolean): Promise<void> {
    h = await setupTestApp({ userDataDir: USERDATA, resetUserData, env: { AGENT_BROWSER_API_PORT: "0" } });
    await vi.waitFor(async () => {
      const status = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      port = status.port;
      expect(status.running && port > 0).toBe(true);
    }, { timeout: 15_000, interval: 200 });
    token = (await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken())).token;
    expect(token).toBeTruthy();
  }

  async function request(method: string, route: string, body?: unknown, auth = true) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, body: await res.json() as any };
  }

  beforeAll(async () => { await launch(false); }, 60_000);
  afterAll(async () => { if (h) await closeApp(h); }, 90_000);

  it("serves public endpoints, authenticates protected ones and refuses WITH writes without data loss", async () => {
    expect((await request("GET", "/health", undefined, false)).status).toBe(200);
    expect((await request("GET", "/openapi.json", undefined, false)).status).toBe(200);
    expect((await request("POST", "/api/agent/db/query", { sql: "SELECT 1" }, false)).status).toBe(401);
    expect((await request("POST", "/api/agent/db/exec", { sql: "CREATE TABLE reliability_items (id INTEGER PRIMARY KEY, label TEXT)" })).status).toBe(200);
    expect((await request("POST", "/api/agent/db/exec", { sql: "INSERT INTO reliability_items (label) VALUES ('alpha'), ('beta')" })).status).toBe(200);

    const query = await request("POST", "/api/agent/db/query", { sql: "SELECT label FROM reliability_items ORDER BY id" });
    expect(query.status).toBe(200);
    expect(query.body.rows).toEqual([{ label: "alpha" }, { label: "beta" }]);
    expect(diskQuery("agent-store.sqlite", "SELECT label FROM reliability_items ORDER BY id")).toEqual(query.body.rows);

    for (const sql of [
      "WITH probe AS (SELECT 1) DELETE FROM reliability_items RETURNING id",
      "WITH probe AS (SELECT 1) UPDATE reliability_items SET label = 'lost' RETURNING id",
      "WITH probe AS (SELECT 1) INSERT INTO reliability_items (label) VALUES ('unexpected') RETURNING id",
    ]) {
      const refused = await request("POST", "/api/agent/db/query", { sql });
      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toMatch(/readonly|read-only/i);
    }
    expect(diskQuery("agent-store.sqlite", "SELECT label FROM reliability_items ORDER BY id")).toEqual(query.body.rows);
    const found = await request("POST", "/api/agent/db/query", {
      sql: "SELECT label FROM reliability_items WHERE label = 'beta'",
    });
    expect(found.status).toBe(200);
    expect(found.body.rows).toEqual([{ label: "beta" }]);
  });

  it("persists a conversation through REST and reads it through the renderer bridge", async () => {
    const created = await request("POST", "/api/agent/conversations", { title: "Reliability history" });
    expect(created.status).toBe(201);
    conversationId = created.body.conversation.id;
    const renamed = await request("PATCH", `/api/agent/conversations/${conversationId}`, { title: "Preserved history" });
    expect(renamed.status).toBe(200);
    const onDisk = JSON.parse(fs.readFileSync(path.join(USERDATA, "agent-conversations.json"), "utf-8"));
    expect(onDisk.find((c: any) => c.id === conversationId)).toMatchObject({ title: "Preserved history", messages: [] });
    const found = await request("GET", `/api/agent/conversations/${conversationId}`);
    expect(found.status).toBe(200);
    expect(found.body.conversation.title).toBe("Preserved history");
    const list = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.conversations.list());
    expect(list.some((c: any) => c.id === conversationId && c.title === "Preserved history")).toBe(true);
  });

  it("surfaces malformed history through REST without overwriting it", async () => {
    const file = path.join(USERDATA, "agent-conversations.json");
    const original = fs.readFileSync(file);
    const corrupt = '{"private-content-marker":';
    try {
      fs.writeFileSync(file, corrupt, "utf-8");
      const rejected = await request("POST", "/api/agent/conversations", { title: "Must not replace history" });
      expect(rejected.status).toBe(500);
      expect(rejected.body.error).toMatch(/not valid JSON/i);
      expect(rejected.body.error).not.toContain("private-content-marker");
      expect(fs.readFileSync(file, "utf-8")).toBe(corrupt);
      const copies = fs.readdirSync(USERDATA).filter((name) => name.startsWith("agent-conversations.json.") && name.endsWith(".corrupt"));
      expect(copies.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(USERDATA, copies[0]), "utf-8")).toBe(corrupt);
      expect((await request("GET", "/api/agent/conversations")).status).toBe(500);
      expect(fs.readFileSync(file, "utf-8")).toBe(corrupt);
    } finally {
      fs.writeFileSync(file, original);
    }
    const restored = await request("GET", `/api/agent/conversations/${conversationId}`);
    expect(restored.status).toBe(200);
    expect(restored.body.conversation.title).toBe("Preserved history");
  });

  it("waits for a real once timer, executes one action and durably consumes the rule", async () => {
    const created = await h.page.evaluate((at) => (window as any).agentBrowser.api.automation.create({
      name: "reliability-once",
      trigger: { type: "once", at },
      action: { type: "custom-js", jsCode: "return 'once-executed';" },
    }), Date.now() + 1_000);
    expect(created.success).toBe(true);
    onceId = created.rule.id;
    expect(storedConfig().automation.find((r: any) => r.id === onceId).enabled).toBe(true);
    await expect.poll(() => storedConfig().automation.find((r: any) => r.id === onceId)?.enabled, { timeout: 15_000 }).toBe(false);
    const jobs = diskQuery("jobs.sqlite", "SELECT source, status, attempt, result FROM jobs WHERE rule_id = ?", [onceId]);
    expect(jobs).toEqual([{ source: "once", status: "done", attempt: 0, result: 'js result: "once-executed"' }]);
    const logs = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.logs());
    expect(logs.filter((l: any) => l.ruleId === onceId)).toEqual([
      expect.objectContaining({ ruleId: onceId, ok: true, result: 'js result: "once-executed"' }),
    ]);
    expect(storedConfig().automation.find((r: any) => r.id === onceId).lastRunAt).toBeGreaterThan(0);
  });

  it("reopens persisted data after restart without replaying the consumed once rule", async () => {
    await closeApp(h);
    await launch(false);
    const read = await request("POST", "/api/agent/db/query", {
      sql: "WITH found AS (SELECT label FROM reliability_items WHERE label = 'beta') SELECT * FROM found",
    });
    expect(read.status).toBe(200);
    expect(read.body.rows).toEqual([{ label: "beta" }]);
    expect(diskQuery("agent-store.sqlite", "SELECT COUNT(*) AS count FROM reliability_items")).toEqual([{ count: 2 }]);
    const history = await request("GET", `/api/agent/conversations/${conversationId}`);
    expect(history.status).toBe(200);
    expect(history.body.conversation.title).toBe("Preserved history");
    const rules = await request("GET", "/api/automation/rules");
    expect(rules.status).toBe(200);
    expect(rules.body.rules.find((r: any) => r.id === onceId).enabled).toBe(false);
    await h.page.waitForTimeout(1_200);
    expect(diskQuery("jobs.sqlite", "SELECT status FROM jobs WHERE rule_id = ?", [onceId])).toEqual([{ status: "done" }]);
    const logs = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.logs());
    expect(logs.filter((l: any) => l.ruleId === onceId)).toEqual([]);
    expect(h.pageErrors).toEqual([]);
  }, 60_000);
});
