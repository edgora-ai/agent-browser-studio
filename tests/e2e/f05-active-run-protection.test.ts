// F05: isolated real Electron IPC + authenticated REST. Runs and result data
// are synthetic service-owned fixtures; no model, browser or external endpoint.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setupTestApp, closeApp, type TestAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "../..");
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-f05-active-e2e-"));
const moduleUrl = (name: string) => pathToFileURL(path.join(REPO, "dist/main/services", name + ".js")).href;
const URLS = {
  recorder: moduleUrl("agent-run-trace"), db: moduleUrl("agent-db"),
  results: moduleUrl("run-result-store"), store: pathToFileURL(path.join(REPO, "dist/main/services/config/store.js")).href,
  config: moduleUrl("config-manager"),
};
const configPath = () => path.join(USERDATA, "config.json");
const config = (): any => JSON.parse(fs.readFileSync(configPath(), "utf8"));
const manifestPath = (id: string) => path.join(USERDATA, "agent-results", id, "manifest.json");

function rows(id: string): Array<{ run_id: string; title: string }> {
  const db = new DatabaseSync(path.join(USERDATA, "agent-store.sqlite"), { readOnly: true });
  try {
    return db.prepare('SELECT run_id, title FROM "news_run_results_v1" WHERE run_id = ?').all(id) as Array<{ run_id: string; title: string }>;
  } finally { db.close(); }
}

function request(port: number, token: string, method: string, route: string, authenticated = true): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers = authenticated ? { authorization: `Bearer ${token}` } : {};
    const req = http.request({ hostname: "127.0.0.1", port, method, path: route, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (piece) => parts.push(piece));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        try { resolve({ status: res.statusCode || 0, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode || 0, body: text }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("F05 — running runs survive delete, clear and retention", () => {
  let h: TestAppHandle;
  let port = 0;
  let token = "";

  async function main(op: string, input: any = {}): Promise<any> {
    return h.app.evaluate(async (_electron, args: { op: string; input: any; urls: typeof URLS }) => {
      const vm = process.getBuiltinModule("node:vm");
      // Playwright's evaluation context has no lexical import callback; use the
      // main-context loader to get the SAME module singleton as the live app.
      const load = (url: string): Promise<any> => vm.runInThisContext(`import(${JSON.stringify(url)})`, {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      });
      const [recorder, db, results, storage, configService] = await Promise.all([
        load(args.urls.recorder), load(args.urls.db), load(args.urls.results), load(args.urls.store), load(args.urls.config),
      ]);
      const trace = recorder.agentRunRecorder;
      const insert = (name: string) => {
        const run = trace.startRun({ source: { type: "chat" }, name });
        const sql = `INSERT INTO news_run_results_v1 (run_id, title, url, source, published_at) VALUES ('${run.id}', '${name}', 'https://fixture.invalid/${run.id}', 'fixture.invalid', '2026-09-30T00:00:00Z')`;
        const write = db.agentDbExecScript(sql);
        if (!write.ok) throw new Error(write.error || "synthetic SQLite insert failed");
        return run;
      };
      if (args.op === "seed") {
        const schema = db.ensureNewsRunResultSchema();
        if (!schema.ok) throw new Error(schema.detail || "synthetic schema failure");
        const active = insert("active");
        const terminal = insert("terminal");
        trace.finishRun(terminal.id, "done");
        const other = insert("other");
        trace.finishRun(other.id, "done");
        const step = trace.recordStep(active.id, { tool: "before-denial", args: {}, ok: true, durationMs: 1 });
        const commit = results.runResultStore.commitRunResult({
          runId: active.id, runStartedAt: active.startedAt, templateId: "synthetic-f05", templateVersion: 1,
          verification: { status: "unverified" },
          terminal: { status: "done", endReason: "completed", finishedAt: Date.now() },
          dataset: { columns: ["item"], rows: [{ item: "protected" }], sourceRowCount: 1, rejectedRowCount: 0, truncated: false },
        });
        if (!commit.ok) throw new Error(commit.detail || "synthetic result commit failed");
        return { active: active.id, terminal: terminal.id, other: other.id, step: step?.id };
      }
      if (args.op === "extra-terminal") {
        const run = insert("extra");
        trace.finishRun(run.id, "done");
        return run.id;
      }
      if (args.op === "reload") {
        configService.reloadConfig();
        return trace.getRun(args.input.id);
      }
      if (args.op === "retention-seed") {
        const schema = db.ensureNewsRunResultSchema();
        if (!schema.ok) throw new Error(schema.detail || "synthetic schema failure");
        const ids = Array.from({ length: 202 }, (_, i) =>
          trace.startRun({ source: { type: "chat" }, name: `retention-${i}` }).id);
        const oldest = trace.getRun(ids[0]);
        const result = results.runResultStore.commitRunResult({
          runId: oldest.id, runStartedAt: oldest.startedAt, templateId: "synthetic-f05", templateVersion: 1,
          verification: { status: "unverified" },
          terminal: { status: "done", endReason: "completed", finishedAt: Date.now() },
          dataset: { columns: ["item"], rows: [{ item: "evicted" }], sourceRowCount: 1, rejectedRowCount: 0, truncated: false },
        });
        if (!result.ok) throw new Error(result.detail);
        const sql = `INSERT INTO news_run_results_v1 (run_id, title, url, source, published_at) VALUES ('${ids[0]}', 'evicted', 'https://fixture.invalid/${ids[0]}', 'fixture.invalid', '2026-09-30T00:00:00Z')`;
        const write = db.agentDbExecScript(sql);
        if (!write.ok) throw new Error(write.error || "synthetic SQLite insert failed");
        if (!trace.finishRun(ids[0], "done")) throw new Error("oldest run was not committed");
        return { evicted: ids[0], kept: ids[1] };
      }
      if (args.op === "settings-save") {
        storage.transact((draft: any) => { draft.deviceName = "F05 unrelated settings save"; });
        return trace.listRuns().length;
      }
      if (args.op === "role") {
        storage.transact((draft: any) => {
          const deviceId = draft.deviceId;
          draft.team = {
            name: "F05 synthetic team", ownerDeviceId: deviceId, enabled: true, updatedAt: Date.now(),
            members: [{ deviceId, name: "Local fixture", role: args.input.role, addedAt: Date.now() }],
          };
        });
        return args.input.role;
      }
      if (args.op === "finish") {
        const id = args.input.id;
        const recorded = trace.recordStep(id, { tool: "after-denial", args: {}, ok: true, durationMs: 1 });
        const manifest = results.runResultStore.readManifest(id);
        if (!manifest.ok) throw new Error(manifest.detail);
        const finished = trace.finishRun(id, "done", undefined, { artifacts: manifest.value.artifacts });
        return { recorded: recorded?.id, finished };
      }
      throw new Error(`unknown F05 fixture action: ${args.op}`);
    }, { op, input, urls: URLS });
  }

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, env: { AGENT_BROWSER_API_PORT: "0" } });
    const isolated = await h.app.evaluate(({ app }) => ({
      home: process.getBuiltinModule("node:os").homedir(), envHome: process.env.HOME,
      userData: app.getPath("userData"),
      providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(isolated.home)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(fs.realpathSync(isolated.envHome!)).toBe(fs.realpathSync(isolated.home));
    expect(fs.realpathSync(isolated.userData)).toBe(fs.realpathSync(USERDATA));
    expect(isolated.providerKeys).toEqual([]);
    const llm = await h.page.evaluate(async () => ({
      configured: await (window as any).agentBrowserAPI.agent.llmConfig(),
      detected: await (window as any).agentBrowserAPI.agent.detectLlmConfig(),
    }));
    expect(llm.configured?.hasApiKey ?? false).toBe(false);
    expect(llm.detected?.hasApiKey ?? false).toBe(false);
    const status = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
    port = status.port;
    expect(port).toBeGreaterThan(0);
    token = (await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken())).token;
    expect(token).toBeTruthy();
  }, 90_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    fs.rmSync(USERDATA, { recursive: true, force: true });
  }, 90_000);

  it("guards REST and IPC, keeps result files/SQLite, then allows terminal deletion", async () => {
    expect((await request(port, token, "GET", "/health", false)).status).toBe(200);
    expect((await request(port, token, "GET", "/api/agent/runs", false)).status).toBe(401);
    expect((await request(port, token, "GET", "/api/agent/runs")).status).toBe(200);
    const fixture = await main("seed");
    const active = fixture.active;
    // Sync Pull reloads config during a live process. The same reload path must
    // not turn a process-owned run into an interrupted error on the Runs page.
    expect(await main("reload", { id: active })).toMatchObject({ id: active, status: "running" });
    expect(config().agentRuns.find((run: any) => run.id === active).status).toBe("running");
    expect((await request(port, token, "GET", `/api/agent/runs/${active}`)).body.run.status).toBe("running");
    expect(await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.get(id), active)).toMatchObject({ status: "running" });
    await h.page.evaluate(async () => {
      (window as any).agentBrowser.switchTab("runs");
      await (window as any).agentBrowser.loadRunsTab();
    });
    const activeCard = h.page.locator(`[data-run-id="${active}"]`).first();
    await activeCard.waitFor();
    expect(await activeCard.innerHTML()).not.toContain('data-run-action="delete"');
    const resultBytes = fs.readFileSync(manifestPath(active));
    const diskBefore = fs.readFileSync(configPath());
    expect(rows(active)).toEqual([{ run_id: active, title: "active" }]);
    const ipcDelete = await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.delete(id), active);
    expect(ipcDelete).toMatchObject({ success: false, reasonCode: "active" });
    expect((await request(port, token, "DELETE", `/api/agent/runs/${active}`)).status).toBe(409);
    expect((await request(port, token, "DELETE", "/api/agent/runs/run_missing")).status).toBe(404);
    expect(fs.readFileSync(configPath())).toEqual(diskBefore);
    expect(fs.readFileSync(manifestPath(active))).toEqual(resultBytes);

    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("runs"));
    await h.page.waitForFunction((id) => !!document.querySelector(`[data-run-id="${id}"]`), active);
    const html = await h.page.locator(`[data-run-id="${active}"]`).first().innerHTML();
    expect(html).not.toContain('data-run-action="delete"');

    expect((await request(port, token, "DELETE", `/api/agent/runs/${fixture.terminal}`)).status).toBe(200);
    expect((await request(port, token, "GET", `/api/agent/runs/${fixture.terminal}`)).status).toBe(404);
    expect(rows(fixture.terminal)).toEqual([]);
    const clearRest = await request(port, token, "DELETE", "/api/agent/runs");
    expect(clearRest).toMatchObject({ status: 200, body: { deleted: 1, skipped: 1 } });
    expect(rows(fixture.other)).toEqual([]);
    const extra = await main("extra-terminal");
    const clearIpc = await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.clear());
    expect(clearIpc).toMatchObject({ success: true, deleted: 1, skipped: 1 });
    expect(rows(extra)).toEqual([]);
    expect(config().agentRuns.map((run: any) => run.id)).toEqual([active]);
    expect(rows(active)).toEqual([{ run_id: active, title: "active" }]);
    expect(fs.readFileSync(manifestPath(active))).toEqual(resultBytes);

    await main("role", { role: "viewer" });
    expect((await request(port, token, "GET", `/api/agent/runs/${active}`)).status).toBe(200);
    expect((await request(port, token, "DELETE", `/api/agent/runs/${active}`)).status).toBe(403);
    expect((await request(port, token, "DELETE", "/api/agent/runs")).status).toBe(403);
    expect(await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.delete(id), active)).toMatchObject({ success: false });
    expect(await h.page.evaluate(() => (window as any).agentBrowser.api.agentRuns.clear())).toMatchObject({ success: false, deleted: 0 });
    await main("role", { role: "owner" });

    const done = await main("finish", { id: active });
    expect(done.recorded).toBeTruthy();
    expect(done.finished).toMatchObject({ id: active, status: "done" });
    const direct = config().agentRuns.find((run: any) => run.id === active);
    expect(direct.steps.map((step: any) => step.tool)).toEqual(["before-denial", "after-denial"]);
    expect(direct.artifacts).toHaveLength(1);
    expect(rows(active)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(USERDATA, "agent-results", active, "artifacts", "dataset.json"), "utf8")).rows).toEqual([["protected"]]);
    expect((await request(port, token, "GET", `/api/agent/runs/${active}`)).body.run.steps).toHaveLength(2);
    expect(await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.get(id), active)).toMatchObject({ id: active, status: "done" });
    const ipcTerminal = await main("extra-terminal");
    expect(await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.delete(id), ipcTerminal)).toMatchObject({ success: true });
    expect(rows(ipcTerminal)).toEqual([]);
    expect((await request(port, token, "GET", `/api/agent/runs/${ipcTerminal}`)).status).toBe(404);
    expect((await request(port, token, "DELETE", `/api/agent/runs/${active}`)).status).toBe(200);
    expect((await request(port, token, "GET", `/api/agent/runs/${active}`)).status).toBe(404);
    expect(rows(active)).toEqual([]);
    expect(fs.existsSync(manifestPath(active))).toBe(false);
    expect(config().agentRuns).toHaveLength(0);
  }, 120_000);

  it("cleans results and controlled SQLite rows after a non-recorder settings transaction evicts a terminal run", async () => {
    const { evicted, kept } = await main("retention-seed");
    expect(config().agentRuns).toHaveLength(202);
    expect(rows(evicted)).toHaveLength(1);
    expect(fs.existsSync(manifestPath(evicted))).toBe(true);
    expect(await main("settings-save")).toBe(201);
    const disk = config();
    expect(disk.agentRuns).toHaveLength(201);
    expect(disk.agentRuns.some((run: any) => run.id === evicted)).toBe(false);
    expect(disk.agentRuns.find((run: any) => run.id === kept).status).toBe("running");
    expect(fs.existsSync(manifestPath(evicted))).toBe(false);
    expect(rows(evicted)).toEqual([]);
    expect((await request(port, token, "GET", `/api/agent/runs/${evicted}`)).status).toBe(404);
    expect(await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.get(id), evicted)).toBeNull();
    expect((await request(port, token, "GET", `/api/agent/runs/${kept}`)).body.run.status).toBe("running");
  }, 120_000);
});
