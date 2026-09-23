// M2 — verifiable results and export, driven against the real app.
//
// The point of this suite is that nothing is predicted. The execution
// contract appended to the system prompt carries the REAL run id, and the
// mock model reads that id out of the request it was actually handed before
// building its INSERTs. A fixture that guessed the id would prove only that
// the guess matched.
//
// Every acceptance claim is checked against the stores the product actually
// owns: the controlled SQLite table (queried directly, read-only) and the
// on-disk run-result manifest/dataset.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setupTestApp, closeApp, type TestAppHandle } from "./helpers/app.js";
import { startMockLlm, type MockLlmServer, type MockLlmResponse } from "./helpers/mock-llm.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-m2-results-e2e-"));
const SOURCE_URL = "https://news.example.test/search?q=markets";
const NEWS_TABLE = "news_run_results_v1";
const DATASET_ID = "dataset";

type Profile = { dirId: string; name: string };

const configPath = () => path.join(USERDATA, "config.json");
const resultsRoot = () => path.join(USERDATA, "agent-results");
const sqlitePath = () => path.join(USERDATA, "agent-store.sqlite");

function config(): any { return JSON.parse(fs.readFileSync(configPath(), "utf8")); }
function runRecord(runId: string): any {
  return (config().agentRuns || []).find((entry: any) => entry.id === runId);
}
/** Direct read of the controlled table — never through the app. */
function tableRows(runId?: string): any[] {
  const database = new DatabaseSync(sqlitePath(), { readOnly: true });
  try {
    return runId
      ? database.prepare(`SELECT run_id, title, url, source, published_at FROM "${NEWS_TABLE}" WHERE run_id = ? ORDER BY id`).all(runId)
      : database.prepare(`SELECT run_id, title, url, source, published_at FROM "${NEWS_TABLE}" ORDER BY id`).all();
  } finally { database.close(); }
}
function manifestPath(runId: string): string { return path.join(resultsRoot(), runId, "manifest.json"); }
function datasetPath(runId: string): string { return path.join(resultsRoot(), runId, "artifacts", "dataset.json"); }
function readManifest(runId: string): any { return JSON.parse(fs.readFileSync(manifestPath(runId), "utf8")); }
function readDataset(runId: string): any { return JSON.parse(fs.readFileSync(datasetPath(runId), "utf8")); }
function sha256(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

/** The real run id, read out of the contract the product actually sent.
 *  Throws rather than guessing — a silent fallback would make every
 *  downstream assertion vacuous. */
function runIdFromContract(systemPrompt: string): string {
  const match = systemPrompt.match(/真实 run_id:\s*(\S+)/);
  if (!match) throw new Error("execution contract with a run id was not found in the system prompt");
  return match[1];
}

describe("M2 — verifiable results, run isolation and export", () => {
  let h: TestAppHandle;
  let mock: MockLlmServer;
  let profile: Profile;

  /** News the fixture "scraped", in order. */
  let fixtureNews: Array<{ title: string; url: string }> = [];
  /** How many rows the responder writes for the run it is answering. */
  let writeCount = 0;
  /** Per-row mutation, for fault cases. */
  let rowOverride: (index: number, row: Record<string, string>) => Record<string, string> = (_i, row) => row;
  /** Claim success in prose while writing nothing. */
  let claimWithoutWriting = false;

  function newsItems(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      title: `Market wire ${i + 1}`,
      url: `https://news.example.test/article/${i + 1}`,
    }));
  }

  async function launch(resetUserData = false) {
    h = await setupTestApp({ userDataDir: USERDATA, resetUserData, env: { AGENT_BROWSER_API_PORT: "0" } });
    await h.page.evaluate((url) => (window as any).agentBrowser.api.agent.saveLlmConfig({
      provider: "openai", apiKey: "m2-local-fixture-key", model: "e2e-mock-model", apiUrl: url,
    }), mock.url);
  }

  /** Per-request responder: derives the id from the live request, then
   *  answers round N of the scripted insert walk.
   *
   *  Inserts are BATCHED per round, not one per round: the agent loop caps at
   *  25 tool-calling rounds, so a 100-row fixture asked for one row at a time
   *  never finishes and reports round_limit instead of the case under test. */
  const INSERTS_PER_ROUND = 10;
  const counts = new Map<string, number>();
  function responder() {
    return (body: any, ctx: { index: number; systemPrompt: string }): MockLlmResponse | null => {
      if (!/template: news-collect/.test(ctx.systemPrompt)) return null;
      const runId = runIdFromContract(ctx.systemPrompt);
      const start = counts.get(runId) ?? 0;
      counts.set(runId, start + INSERTS_PER_ROUND);
      if (claimWithoutWriting) return { chunks: ["All done — collected everything successfully."] };
      if (start >= writeCount) return { chunks: [`Wrote ${writeCount} items. Done.`] };
      const end = Math.min(start + INSERTS_PER_ROUND, writeCount);
      const toolCalls = [];
      for (let i = start; i < end; i++) {
        const base = {
          title: fixtureNews[i]?.title ?? `Row ${i}`,
          url: fixtureNews[i]?.url ?? `https://news.example.test/article/${i}`,
          source: "news.example.test",
          published_at: "2026-09-19T08:30:00Z",
        };
        const row = rowOverride(i, base);
        toolCalls.push({
          id: `insert-${i}`,
          name: "db_exec",
          arguments: {
            sql: `INSERT INTO ${NEWS_TABLE} (run_id, title, url, source, published_at) VALUES (?, ?, ?, ?, ?)`,
            params: [runId, row.title, row.url, row.source, row.published_at],
          },
        });
      }
      return { chunks: [], toolCalls };
    };
  }

  async function addRule(action: Record<string, unknown>, name: string): Promise<string> {
    const created = await h.page.evaluate((args) => (window as any).agentBrowser.api.automation.create({
      name: args.name,
      enabled: false,
      trigger: { type: "once", at: Date.now() + 3_600_000 },
      action: { type: "agent-task", profileDirId: args.dirId, ...args.action },
    }), { name, dirId: profile.dirId, action });
    expect(created.success, JSON.stringify(created)).toBe(true);
    return created.rule.id as string;
  }

  function newsRule(inputs?: Record<string, string>, name = "M2 news sweep") {
    return addRule({
      agentPrompt: "Collect the top news from the source page into the controlled table.",
      templateId: "news-collect",
      ...(inputs ? { templateInputs: inputs } : {}),
    }, name);
  }

  /** Test-run a rule and return the run it produced. The run id is read back
   *  from the product's own listing rather than parsed out of a string. */
  async function testRun(ruleId: string): Promise<{ ok: boolean; result: string; runId: string }> {
    const knownBefore = new Set<string>((config().agentRuns || []).map((r: any) => r.id));
    const out = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.testRun(id), ruleId);
    const runId = (config().agentRuns || []).map((r: any) => r.id).find((id: string) => !knownBefore.has(id)) || "";
    return { ok: out.ok, result: out.result, runId };
  }

  /** Wait until the run reaches a terminal state on disk. */
  async function settle(runId: string) {
    await vi.waitFor(() => {
      const run = runRecord(runId);
      expect(run && run.status !== "running", `run ${runId} still running`).toBe(true);
    }, { timeout: 60_000, interval: 250 });
    return runRecord(runId);
  }

  async function runNews(ruleId: string, expectOk = true) {
    const out = await testRun(ruleId);
    if (expectOk) expect(out.ok, `test-run failed: ${out.result}`).toBe(true);
    expect(out.runId).toBeTruthy();
    return settle(out.runId);
  }

  function preview(runId: string, offset = 0, limit = 100) {
    return h.page.evaluate((args) => (window as any).agentBrowser.api.agentRuns.resultsPreview(args),
      { runId, artifactId: "dataset", offset, limit });
  }

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 2, responder: responder() });
    await launch();
    const created = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: "M2 environment", platform: "windows", proxyMode: "none",
      appUrl: "data:text/html,<title>M2 fixture</title>", fingerprintMode: "off",
    }));
    expect(created.dirId, JSON.stringify(created)).toBeTruthy();
    profile = { dirId: created.dirId, name: "M2 environment" };
  }, 120_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (mock) await mock.close();
  }, 120_000);

  it("passes a complete run and proves it against the table, the manifest and the disk", async () => {
    fixtureNews = newsItems(20);
    writeCount = 20;
    claimWithoutWriting = false;
    rowOverride = (_i, row) => row;

    const ruleId = await newsRule({ sourceUrl: SOURCE_URL, limit: "20" });
    const run = await runNews(ruleId);

    // ── Layer 1: execution ──
    expect(run.status).toBe("done");
    expect(run.endReason).toBe("completed");
    expect(run.source).toMatchObject({ type: "automation", ruleId, templateId: "news-collect" });

    // ── Layer 2: business acceptance ──
    expect(run.verification).toMatchObject({
      status: "passed",
      verifierId: "news-collect.dataset",
      verifierVersion: 1,
      counts: { expected: 20, observed: 20, inspected: 20, accepted: 20, rejected: 0, missing: 0, extra: 0 },
    });
    expect(run.artifacts).toHaveLength(1);
    expect(run.artifacts[0]).toMatchObject({ kind: "dataset", completeness: "complete", truncated: false, rowCount: 20, exportPolicy: "csv" });
    // config.json carries a bounded reference to the stored result: no
    // physical path, no payload, no row bodies. (The run's own step trace does
    // hold the db_exec params the model sent — that is M1's bounded, redacted
    // trace, and it is not what M2 stores.)
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain(resultsRoot());
    // The artifact reference carries the payload's BASENAME (a fixed constant)
    // but never a directory or an absolute path.
    expect(run.artifacts[0].name).toBe("dataset.json");
    expect(run.artifacts[0].name).not.toContain("/");
    for (const key of ["path", "filePath", "dir", "payload", "rows", "body"]) {
      expect(run.artifacts[0]).not.toHaveProperty(key);
    }
    // The stored dataset is the only place the accepted rows live.
    expect(JSON.stringify(readDataset(run.id))).toContain("Market wire 1");

    // ── The controlled table, read directly ──
    const rows = tableRows(run.id);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.run_id === run.id)).toBe(true);
    expect(rows.map((r) => r.url)).toContain("https://news.example.test/article/1");

    // ── The disk ──
    const artifact = run.artifacts[0];
    expect(sha256(datasetPath(run.id))).toBe(artifact.sha256);
    expect(fs.statSync(datasetPath(run.id)).size).toBe(artifact.bytes);
    const dataset = readDataset(run.id);
    expect(dataset.rows).toHaveLength(20);
    expect(dataset.runId).toBe(run.id);
    expect(dataset.columns).toEqual(["title", "url", "source", "published_at"]);
    const manifest = readManifest(run.id);
    expect(manifest.runId).toBe(run.id);
    expect(manifest.verification.status).toBe("passed");
    expect(manifest.artifacts[0].sha256).toBe(artifact.sha256);

    // ── The service reads back what it wrote ──
    const page = await preview(run.id);
    expect(page.ok, JSON.stringify(page)).toBe(true);
    expect(page.total).toBe(20);
    expect(page.rows).toHaveLength(20);
    expect(page.columns).toEqual(["title", "url", "source", "published_at"]);
    expect(page.rows.flat()).toContain("Market wire 20");

    // ── Searchable by runId ──
    const listed = await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.list().then((list: any[]) => list.filter((r) => r.id === id)), run.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].verification.status).toBe("passed");
  }, 150_000);

  it("grades a partial harvest as partial without failing the execution", async () => {
    fixtureNews = newsItems(20);
    writeCount = 20;
    claimWithoutWriting = false;
    rowOverride = (i, row) => {
      if (i === 5) return { ...row, url: "not-a-url" };
      if (i === 9) return { ...row, published_at: "sometime last week" };
      return row;
    };

    const ruleId = await newsRule({ sourceUrl: SOURCE_URL, limit: "20" }, "M2 partial sweep");
    const run = await runNews(ruleId);

    // Execution still succeeded: a partial harvest is a business verdict, and
    // treating it as a job failure would trigger a bogus automatic retry.
    expect(run.status).toBe("done");
    expect(run.endReason).toBe("completed");
    expect(run.verification).toMatchObject({
      status: "partial",
      counts: { expected: 20, observed: 20, inspected: 20, accepted: 18, rejected: 2, missing: 0, extra: 0 },
    });
    const codes = run.verification.issues.map((issue: any) => issue.code).sort();
    expect(codes).toEqual(["invalid_timestamp", "invalid_url"]);

    // The rejected rows are still physically in the table — it holds the
    // model's output, not the accepted subset.
    expect(tableRows(run.id)).toHaveLength(20);
    // The dataset holds accepted rows only.
    expect(readDataset(run.id).rows).toHaveLength(18);
    expect(run.artifacts[0]).toMatchObject({ rowCount: 18, rejectedRowCount: 2 });

    const page = await preview(run.id);
    expect(page.total).toBe(18);
    expect(page.rejectedRowCount).toBe(2);
    expect(JSON.stringify(page.rows)).not.toContain("not-a-url");
  }, 150_000);

  it("fails a run whose model claims success but writes nothing", async () => {
    fixtureNews = newsItems(20);
    claimWithoutWriting = true;

    const ruleId = await newsRule({ sourceUrl: SOURCE_URL, limit: "20" }, "M2 empty sweep");
    const run = await runNews(ruleId);

    // The prose said "collected everything successfully". The table says zero.
    expect(run.status).toBe("done");
    expect(run.verification).toMatchObject({
      status: "failed",
      counts: { expected: 20, observed: 0, inspected: 0, accepted: 0, rejected: 0, missing: 20, extra: 0 },
    });
    expect(tableRows(run.id)).toHaveLength(0);
    // The empty snapshot is still recorded: "the model wrote nothing" is
    // evidence, and the artifact honestly reports zero rows.
    expect(run.artifacts).toHaveLength(1);
    expect(run.artifacts[0]).toMatchObject({ kind: "dataset", rowCount: 0, sourceRowCount: 0, rejectedRowCount: 0 });
    expect(readDataset(run.id).rows).toHaveLength(0);
    claimWithoutWriting = false;
  }, 150_000);

  it("keeps two runs writing the same URLs fully isolated", async () => {
    fixtureNews = newsItems(5);
    writeCount = 5;
    claimWithoutWriting = false;
    rowOverride = (_i, row) => row;

    const first = await runNews(await newsRule({ sourceUrl: SOURCE_URL, limit: "5" }, "M2 isolation A"));
    const second = await runNews(await newsRule({ sourceUrl: SOURCE_URL, limit: "5" }, "M2 isolation B"));
    expect(first.id).not.toBe(second.id);
    // Identical URLs, so UNIQUE(run_id,url) is what keeps them apart.
    expect(tableRows(first.id).map((r) => r.url)).toEqual(tableRows(second.id).map((r) => r.url));

    const a = await preview(first.id);
    const b = await preview(second.id);
    expect(a.total).toBe(5);
    expect(b.total).toBe(5);
    // Neither preview can contain the other run's rows: the rows are the same
    // text, so prove it via the run-scoped count in the table instead.
    expect(tableRows().filter((r) => r.run_id === first.id)).toHaveLength(5);
    expect(tableRows().filter((r) => r.run_id === second.id)).toHaveLength(5);
    // The datasets are physically distinct files.
    expect(datasetPath(first.id)).not.toBe(datasetPath(second.id));
    expect(readDataset(first.id).runId).toBe(first.id);
    expect(readDataset(second.id).runId).toBe(second.id);
  }, 150_000);

  it("keeps a non-template automation run and a desktop chat run unverified", async () => {
    const plainRuleId = await addRule({ agentPrompt: "Summarize the page." }, "M2 plain sweep");
    const plain = await runNews(plainRuleId);
    // No verifier exists for this run, so no verdict is invented.
    expect(plain.verification).toEqual({ status: "unverified" });
    expect(plain.artifacts ?? []).toHaveLength(0);

    // Desktop chat: the chat surface never selects a template for the user, so
    // it cannot be machine-graded either.
    const conversation = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.conversations.create("M2 chat"));
    const chat = await h.page.evaluate((id) => (window as any).agentBrowser.api.agent.chat(id, "Summarize this page, no template."), conversation.id);
    expect(chat.verification).toEqual({ status: "unverified" });
    const chatRun = runRecord(chat.runId);
    expect(chatRun.verification).toEqual({ status: "unverified" });
    expect(chatRun.source.type).toBe("chat");
  }, 150_000);

  it("sends a legacy rule to manual review instead of guessing its inputs", async () => {
    // A rule persisted before structured inputs existed. It still executes, but
    // the missing contract cannot be reconstructed from the prompt text.
    const legacyRuleId = await addRule({
      agentPrompt: "Collect news.", templateId: "news-collect",
    }, "M2 legacy rule");
    const run = await runNews(legacyRuleId);
    expect(run.verification).toMatchObject({ status: "manual_review", reasonCode: "input_unavailable" });
    expect(run.artifacts ?? []).toHaveLength(0);
    // Nothing was fabricated for it.
    expect(tableRows(run.id)).toHaveLength(0);
  }, 150_000);

  it("refuses an invalid structured input at the write path and never reaches the model", async () => {
    const before = mock.requests.length;
    const created = await h.page.evaluate((dirId) => (window as any).agentBrowser.api.automation.create({
      name: "M2 bad input", enabled: false, trigger: { type: "once", at: Date.now() + 3_600_000 },
      action: {
        type: "agent-task", profileDirId: dirId, agentPrompt: "Collect news.",
        templateId: "news-collect",
        templateInputs: { sourceUrl: "ftp://not-http.example.test/x", limit: "5" },
      },
    }), profile.dirId);
    expect(created.success).toBe(false);
    expect(created.error).toMatch(/sourceUrl must be http\(s\)/);
    // Nothing was persisted and nothing was asked of the model.
    const rules = await h.page.evaluate(() => (window as any).agentBrowser.api.automation.list());
    expect(rules.some((r: any) => r.name === "M2 bad input")).toBe(false);
    expect(mock.requests.length).toBe(before);
  }, 90_000);

  it("re-runs a terminal run as a new id, leaving the original rows and artifacts intact", async () => {
    fixtureNews = newsItems(5);
    writeCount = 5;
    claimWithoutWriting = false;
    rowOverride = (_i, row) => row;

    const ruleId = await newsRule({ sourceUrl: SOURCE_URL, limit: "5" }, "M2 rerun source");
    const first = await runNews(ruleId);
    const firstRows = tableRows(first.id);
    const firstDataset = readDataset(first.id);
    const firstHash = first.artifacts[0].sha256;

    const retried = await h.page.evaluate((id) => (window as any).agentBrowser.api.automation.retryRun(id), first.id);
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(retried.runId).not.toBe(first.id);
    const second = await settle(retried.runId);

    expect(second.source).toMatchObject({ retryOf: first.id, type: "automation" });
    // Retry lineage lives in the data, not baked into the persisted name.
    expect(second.name).toBe(first.name);
    expect(second.name).not.toContain("重试");

    // The original is byte-for-byte unchanged and its rows are still its own.
    expect(tableRows(first.id)).toEqual(firstRows);
    expect(tableRows(first.id)).toHaveLength(5);
    expect(tableRows(second.id)).toHaveLength(5);
    expect(readDataset(first.id)).toEqual(firstDataset);
    expect(readManifest(first.id).artifacts[0].sha256).toBe(firstHash);
    expect(sha256(datasetPath(first.id))).toBe(firstHash);
  }, 150_000);

  it("restores a missing config reference from the manifest on restart", async () => {
    fixtureNews = newsItems(4);
    writeCount = 4;
    claimWithoutWriting = false;
    rowOverride = (_i, row) => row;

    const ruleId = await newsRule({ sourceUrl: SOURCE_URL, limit: "4" }, "M2 restart sweep");
    const run = await runNews(ruleId);
    expect(readManifest(run.id).verification.status).toBe("passed");
    const goodRefs = JSON.stringify(runRecord(run.id).artifacts);

    // Simulate a crash between the manifest commit and the config write: the
    // artifact reference is gone from config.json while the manifest survives.
    await closeApp(h);
    const cfg = config();
    const entry = cfg.agentRuns.find((r: any) => r.id === run.id);
    delete entry.artifacts;
    entry.verification = { status: "unverified" };
    entry.status = "running";
    delete entry.finishedAt;
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
    expect(config().agentRuns.find((r: any) => r.id === run.id).artifacts).toBeUndefined();

    await launch(false);
    const restored = await vi.waitFor(() => {
      const record = runRecord(run.id);
      expect(record?.artifacts?.length, "reconcile did not restore the artifact reference").toBe(1);
      return record;
    }, { timeout: 45_000, interval: 250 });

    expect(JSON.stringify(restored.artifacts)).toBe(goodRefs);
    expect(restored.verification.status).toBe("passed");
    expect(restored.status).not.toBe("running");
    // Reconciled from disk, not re-derived: the table still holds the rows.
    expect(tableRows(run.id)).toHaveLength(4);
  }, 180_000);

  it("refuses preview and export once the stored payload is tampered with", async () => {
    const run = (config().agentRuns as any[]).find((r) => r.verification?.status === "passed" && r.artifacts?.length);
    expect(run, "a passed run with artifacts is required").toBeTruthy();
    const file = datasetPath(run.id);
    const original = fs.readFileSync(file);

    // Byte-level tamper that keeps the JSON parseable: the hash must catch it.
    const parsed = JSON.parse(original.toString("utf8"));
    parsed.rows[0][0] = "TAMPERED";
    fs.writeFileSync(file, JSON.stringify(parsed));
    expect(sha256(file)).not.toBe(readManifest(run.id).artifacts[0].sha256);

    const page = await preview(run.id);
    expect(page.ok, JSON.stringify(page)).toBe(false);
    expect(page.error).toBeTruthy();
    expect(JSON.stringify(page)).not.toContain("TAMPERED");

    const plan = await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.exportPlan({ runId: id, artifactId: "dataset", kind: "dataset-csv" }), run.id);
    expect(plan.ok, JSON.stringify(plan)).toBe(false);
    expect(JSON.stringify(plan)).not.toContain("TAMPERED");

    fs.writeFileSync(file, original);
    const recovered = await preview(run.id);
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
  }, 120_000);

  it("exports CSV with formula guards and a truthful plan, and writes atomically", async () => {
    fixtureNews = newsItems(3);
    fixtureNews[0] = { title: '=cmd|\' /C calc\'!A0', url: "https://news.example.test/article/1" };
    fixtureNews[1] = { title: '+1+1"><img src=x onerror=alert(1)>', url: "https://news.example.test/article/2" };
    fixtureNews[2] = { title: "Ordinary headline, with comma", url: "https://news.example.test/article/3" };
    writeCount = 3;
    claimWithoutWriting = false;
    rowOverride = (_i, row) => row;

    const ruleId = await newsRule({ sourceUrl: SOURCE_URL, limit: "3" }, "M2 export sweep");
    const run = await runNews(ruleId);
    expect(tableRows(run.id)).toHaveLength(3);

    const plan = await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.exportPlan({ runId: id, artifactId: "dataset", kind: "dataset-csv" }), run.id);
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(plan.plan.rowCount).toBe(3);
    expect(plan.plan.columns).toEqual(["title", "url", "source", "published_at"]);
    expect(plan.plan.suggestedName).toMatch(/\.csv$/);

    const dest = path.join(USERDATA, "export-out.csv");
    fs.rmSync(dest, { force: true });
    const written = await h.page.evaluate((args) => (window as any).agentBrowser.api.agentRuns.exportWrite(args), { runId: run.id, artifactId: "dataset", kind: "dataset-csv", destPath: dest });
    expect(written.ok, JSON.stringify(written)).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
    expect(written.bytes).toBe(fs.statSync(dest).size);

    const csv = fs.readFileSync(dest, "utf8");
    expect(csv).toContain("\r\n");
    // No cell may begin with a formula trigger once parsed.
    for (const line of csv.split("\r\n").filter(Boolean)) {
      const first = line.startsWith('"') ? line.slice(1) : line;
      expect(first.startsWith("=") || first.startsWith("+"), `unguarded cell: ${line.slice(0, 40)}`).toBe(false);
    }
    // Both formula-leading cells carry the guard prefix. (The verifier trims
    // title/source before storing, so the leading-whitespace variant is
    // exercised by the unit test, not here.)
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+1+1");
    // A comma inside a value is quoted, not treated as a delimiter.
    expect(csv).toContain('"Ordinary headline, with comma"');

    // An extension outside the whitelist is refused, even with an explicit path.
    const zip = path.join(USERDATA, "export-out.zip");
    const bad = await h.page.evaluate((args) => (window as any).agentBrowser.api.agentRuns.exportWrite(args), { runId: run.id, artifactId: "dataset", kind: "dataset-csv", destPath: zip });
    expect(bad.ok).toBe(false);
    expect(fs.existsSync(zip)).toBe(false);
  }, 150_000);

  it("exports a summary that carries the verdict but no payload", async () => {
    const run = (config().agentRuns as any[]).find((r) => r.name === "M2 export sweep");
    expect(run).toBeTruthy();
    const dest = path.join(USERDATA, "export-summary.json");
    fs.rmSync(dest, { force: true });
    const plan = await h.page.evaluate((id) => (window as any).agentBrowser.api.agentRuns.exportPlan({ runId: id, kind: "summary-json" }), run.id);
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(plan.plan.suggestedName).toMatch(/\.json$/);

    const written = await h.page.evaluate((args) => (window as any).agentBrowser.api.agentRuns.exportWrite(args), { runId: run.id, kind: "summary-json", destPath: dest });
    expect(written.ok, JSON.stringify(written)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(dest, "utf8"));
    expect(summary.run.id).toBe(run.id);
    expect(summary.verification.status).toBeTruthy();
    expect(summary.artifacts.length).toBeGreaterThan(0);
    const text = JSON.stringify(summary);
    // Metadata only: no scraped bodies, no paths, no variable values.
    expect(text).not.toContain("Ordinary headline");
    expect(text).not.toContain("Market wire");
    expect(text).not.toContain(resultsRoot());
  }, 90_000);

  it("reports manual_review when the controlled table has an incompatible shape", async () => {
    // The reachable manual-review path from the plan: the controlled table
    // already exists with the wrong shape. The verifier must refuse to grade
    // against it and must NOT drop or migrate the existing table.
    //
    // (The over-budget/artifact_limit branch is NOT reachable end-to-end at
    // production caps: the widest accepted row is ~2.8 KiB and the row cap is
    // 1000, so a news snapshot tops out near 2.8 MiB against an 8 MiB budget.
    // That branch is covered by the unit test that lowers the budget directly.)
    await h.page.evaluate(() => (window as any).agentBrowser.api.agentDb.exec(
      'DROP TABLE IF EXISTS news_run_results_v1; CREATE TABLE news_run_results_v1 (run_id TEXT, wrong_column TEXT)',
    ));

    fixtureNews = newsItems(3);
    writeCount = 3;
    claimWithoutWriting = false;
    rowOverride = (_i, row) => row;

    const ruleId = await newsRule({ sourceUrl: SOURCE_URL, limit: "3" }, "M2 bad schema");
    // The precondition fails, so the JOB is an execution error — that is the
    // execution layer. The verification layer independently records
    // manual_review. The two are deliberately not conflated.
    const run = await runNews(ruleId, false);
    expect(run.status).toBe("error");
    expect(run.endReason).toBe("execution_error");
    expect(run.verification).toMatchObject({ status: "manual_review", reasonCode: "schema_incompatible" });
    expect(run.artifacts ?? []).toHaveLength(0);

    // The incompatible table was left exactly as it was — never dropped,
    // never migrated, and never written to.
    const database = new DatabaseSync(sqlitePath(), { readOnly: true });
    try {
      const cols = (database.prepare('PRAGMA table_info("news_run_results_v1")').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toEqual(["run_id", "wrong_column"]);
      expect((database.prepare('SELECT COUNT(*) AS c FROM "news_run_results_v1"').get() as any).c).toBe(0);
    } finally { database.close(); }
  }, 150_000);

  it("renders hostile titles without executing them and keeps the run detail free of injected nodes", async () => {
    const run = (config().agentRuns as any[]).find((r) => r.name === "M2 export sweep");
    const page = await preview(run.id);
    expect(page.ok, JSON.stringify(page)).toBe(true);
    // The payload arrives as data, so a browser cannot have parsed it into nodes.
    expect(JSON.stringify(page.rows)).toContain("onerror");

    await h.page.evaluate((id) => (window as any).agentBrowser.runsOpen(id), run.id);
    await vi.waitFor(async () => {
      const open = await h.page.evaluate(() => (document.getElementById("dlg-agent-run") as any)?.open === true);
      expect(open).toBe(true);
    }, { timeout: 10_000 });

    const dialog = await h.page.evaluate(() => {
      const el = document.getElementById("dlg-agent-run") as any;
      return {
        scripts: el.querySelectorAll("script").length,
        images: el.querySelectorAll("img").length,
        text: el.textContent || "",
      };
    });
    expect(dialog.scripts).toBe(0);
    expect(dialog.images).toBe(0);
    // The hostile title is present as text, which is the correct treatment.
    expect(dialog.text).toContain("onerror");
    await h.page.evaluate(() => (document.getElementById("dlg-agent-run") as any)?.close());
  }, 120_000);

  it("never touches a legacy self-created news table", async () => {
    const database = new DatabaseSync(sqlitePath(), { readOnly: true });
    try {
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(tables).toContain(NEWS_TABLE);
      // The model in these fixtures never created a bare `news` table; assert
      // the verifier did not create or migrate one either.
      expect(tables).not.toContain("news");
    } finally { database.close(); }
  }, 60_000);
});
