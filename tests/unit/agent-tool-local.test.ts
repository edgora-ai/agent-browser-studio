import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tool-local-"));
  return {
    root, rootOwner: fs.lstatSync(root), dataDir: path.join(root, "data"),
    profiles: [] as any[],
    ports: new Set<number>(),
    wire: [] as any[],
    dns: new Map<string, Array<{ address: string; family: number }>>(),
    forbidden: vi.fn((capability: string): never => { throw new Error(`Undeclared capability: ${capability}`); }),
  };
});
vi.mock("electron", () => ({
  app: { getPath: () => fixture.dataDir, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => fixture.forbidden("Keychain"), encryptString: () => fixture.forbidden("Keychain"), decryptString: () => fixture.forbidden("Keychain") },
}));
vi.mock("node:child_process", () => Object.fromEntries(["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"].map((name) => [name, () => fixture.forbidden(name)])));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  listBrowserProfiles: () => fixture.profiles,
  launchBrowser: () => fixture.forbidden("browser launch"), createBrowserProfile: () => fixture.forbidden("profile creation"),
  touchProfileActivityByPort: () => undefined, getEngineByPort: () => "chromium", getFirefoxBidiSessionByPort: () => null,
}));
vi.mock("../../src/main/services/profile-manager.js", () => ({ listProfiles: async () => fixture.profiles }));
vi.mock("node:http", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:http")>();
  return { ...real, request(options: any, callback: any) {
    if (options.hostname !== "198.51.100.49" || !fixture.ports.has(options.port)) return fixture.forbidden("unregistered HTTP endpoint");
    fixture.wire.push(structuredClone({ hostname: options.hostname, port: options.port, path: options.path, headers: options.headers, method: options.method }));
    // Explicit test transport mapping only: the real URL validator and pinned
    // request options still run; only this registered fixture socket is local.
    return real.request({ ...options, hostname: "127.0.0.1", lookup: undefined }, callback);
  } };
});
vi.mock("node:https", () => ({ request: () => fixture.forbidden("HTTPS") }));
vi.mock("node:dns/promises", () => ({ lookup: async (host: string) => {
  if (!fixture.dns.has(host)) return fixture.forbidden(`DNS ${host}`);
  return fixture.dns.get(host)!;
} }));

import * as agent from "../../src/main/services/local-agent.js";
import { getConfig, getConfigPath, getAppDataDir, reloadConfig } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import { closeAgentDb } from "../../src/main/services/agent-db.js";
import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { clearApprovalMemory, listPendingApprovals, resolveApproval } from "../../src/main/services/approval-gate.js";
import { RunResultStore } from "../../src/main/services/run-result-store.js";
import { runBatch } from "../../src/main/services/batch-queue.js";

const servers: http.Server[] = [];
const diskConfig = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const run = (name: string) => agentRunRecorder.startRun({ source: { type: "chat", conversationId: "task49-local" }, name });
const approvedOwner = (decision: "deny" | "once" | "always", requests: any[] = []) => ({
  id: 49, isDestroyed: () => false, send(channel: string, request: any) {
    if (channel === "agent:approval-request") {
      requests.push(request);
      queueMicrotask(() => resolveApproval(request.id, decision));
    }
  },
});
async function httpFixture(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  fixture.ports.add(port);
  fixture.dns.set("api.task49.test", [{ address: "198.51.100.49", family: 4 }]);
  return `http://api.task49.test:${port}`;
}

function assertFixtureOwner(): void {
  const current = fs.lstatSync(fixture.root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== fixture.rootOwner.dev || current.ino !== fixture.rootOwner.ino) throw new Error("Local tool fixture owner changed");
}
beforeEach(() => {
  assertFixtureOwner();
  closeAgentDb();
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
  fixture.profiles.length = 0; fixture.wire.length = 0; fixture.dns.clear(); fixture.forbidden.mockClear();
  reloadConfig(); getConfig();
  vi.stubGlobal("fetch", () => fixture.forbidden("unconfigured model/fetch"));
});
afterEach(async () => {
  clearApprovalMemory(); closeAgentDb();
  for (const item of agentRunRecorder.listRuns()) agentRunRecorder.releaseRun(item.id);
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  fixture.ports.clear();
  vi.unstubAllGlobals();
  expect(fixture.forbidden).not.toHaveBeenCalled();
});
afterAll(() => { assertFixtureOwner(); fs.rmSync(fixture.root, { recursive: true }); });

describe("real local file and SQL tools", () => {
  it("writes real bytes, directly verifies disk, reloads configuration and searches readback", async () => {
    const target = path.join(getAppDataDir(), "agent-files/reports/task49.json");
    const content = { error: "business field", count: 49 }, write = vi.spyOn(fsMutable, "writeFileSync");
    syncBuiltinESMExports();
    try {
      const result = await agent.executeToolCall("write_file", { path: "reports/task49.json", content });
      expect(write.mock.calls.filter(([file]) => file === target)).toEqual([[target, JSON.stringify(content), { encoding: "utf8", mode: 0o600 }]]);
      const stat = fs.lstatSync(target);
      expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1);
      expect(result.bytesWritten).toBe(stat.size);
      expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(content);
      // Observe the requested mode everywhere, but do not infer Windows ACL privacy from stat bits.
      if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
    } finally { write.mockRestore(); syncBuiltinESMExports(); }
    reloadConfig();
    const readback = await agent.executeToolCall("read_file", { path: "reports/task49.json" });
    expect(JSON.parse(readback.content).count).toBe(49);
    expect(readback.content.includes("business field")).toBe(true);
    expect(readback.truncated).toBe(false);
  });

  it("honors file size caps, missing files and directories without silently reporting success", async () => {
    const root = path.join(getAppDataDir(), "agent-files");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "large.txt"), "a".repeat(512 * 1024 + 1));
    const readback = await agent.executeToolCall("read_file", { path: "large.txt" });
    expect(readback).toMatchObject({ bytes: 512 * 1024 + 1, truncated: true });
    expect(readback.content.length).toBe(512 * 1024);
    await expect(agent.executeToolCall("write_file", { path: "no.txt", content: "中".repeat(200000) })).rejects.toThrow("too large");
    expect(fs.existsSync(path.join(root, "no.txt"))).toBe(false);
    await expect(agent.executeToolCall("read_file", { path: "missing.txt" })).rejects.toThrow("not found");
    await expect(agent.executeToolCall("read_file", { path: "." })).rejects.toThrow("Not a file");
    for (const invalid of ["../escape", "..\\escape", path.join(fixture.dataDir, "outside"), "", 49, "a".repeat(1001)]) {
      await expect(agent.executeToolCall("read_file", { path: invalid })).rejects.toThrow();
    }
  });

  it("uses only declared synthetic allowlist/open paths and rejects sibling-prefix paths", async () => {
    const trusted = path.join(fixture.dataDir, "trusted");
    transact((draft) => { draft.agentFs = { mode: "allowlist", allowlist: [trusted] }; });
    expect(diskConfig().agentFs.mode).toBe("allowlist"); reloadConfig();
    const target = path.join(trusted, "nested/out.txt");
    await agent.executeToolCall("write_file", { path: target, content: "task49 allowlist" });
    expect(fs.readFileSync(target, "utf8")).toBe("task49 allowlist");
    reloadConfig(); expect((await agent.executeToolCall("read_file", { path: target })).content).toContain("allowlist");
    await expect(agent.executeToolCall("write_file", { path: `${trusted}-sibling/leak.txt`, content: "no" })).rejects.toThrow("outside");
    await expect(agent.executeToolCall("read_file", { path: "relative.txt" })).rejects.toThrow("absolute");
    transact((draft) => { draft.agentFs = { mode: "allowlist", allowlist: [] }; });
    expect(diskConfig().agentFs.allowlist).toEqual([]); reloadConfig();
    expect(() => agent.resolveAgentFilePath(target)).toThrow("no directories");
    transact((draft) => { draft.agentFs = { mode: "open", allowlist: [] }; });
    expect(diskConfig().agentFs.mode).toBe("open"); reloadConfig();
    expect(agent.resolveAgentFilePath("~/task49-only.txt").abs).toBe(path.join(process.env.HOME!, "task49-only.txt"));
    expect(agent.assertSafeUploadPath(target)).toBe(target);
    expect(() => agent.assertSafeUploadPath(`${trusted}/../nested`)).toThrow("traversal");
    expect(() => agent.assertSafeUploadPath(path.join(trusted, "missing"))).toThrow("does not exist");
  });

  it("creates, binds, queries an independent SQLite reader, closes/reopens, and searches exact rows", async () => {
    await agent.executeToolCall("db_exec", { sql: "CREATE TABLE task49_orders (id INTEGER PRIMARY KEY, label TEXT NOT NULL, error TEXT)" });
    await agent.executeToolCall("db_exec", { sql: "INSERT INTO task49_orders (label,error) VALUES (?,?)", params: ["needle-49", "business-column"] });
    const db = new DatabaseSync(path.join(getAppDataDir(), "agent-store.sqlite"), { readOnly: true });
    try { expect({ ...db.prepare("SELECT * FROM task49_orders WHERE label=?").get("needle-49") }).toEqual({ id: 1, label: "needle-49", error: "business-column" }); }
    finally { db.close(); }
    closeAgentDb(); reloadConfig();
    const found = await agent.executeToolCall("db_query", { sql: "SELECT label,error FROM task49_orders WHERE label=?", params: ["needle-49"] });
    expect(found.rows.map((row: any) => ({ ...row }))).toEqual([{ label: "needle-49", error: "business-column" }]);
    expect(found).toMatchObject({ count: 1, truncated: false });
    await expect(agent.executeToolCall("db_query", { sql: "DELETE FROM task49_orders" })).rejects.toThrow("db_query");
    await expect(agent.executeToolCall("db_exec", { sql: "SELECT * FROM task49_orders" })).rejects.toThrow("db_exec");
    await expect(agent.executeToolCall("db_query", { sql: 49 })).rejects.toThrow("Invalid sql");
  });

  it("refuses destructive SQL then approves it with real on-disk negative readback", async () => {
    await agent.executeToolCall("db_exec", { sql: "CREATE TABLE task49_delete (id INTEGER)" });
    await agent.executeToolCall("db_exec", { sql: "INSERT INTO task49_delete VALUES (49)" });
    const sql = "/* harmless-looking comment */ DELETE FROM task49_delete";
    const denied = await agent.executeToolCall("db_exec", { sql }, undefined, { webContents: approvedOwner("deny") });
    expect(denied).toMatchObject({ skipped: true, decision: "deny" });
    const independent = new DatabaseSync(path.join(getAppDataDir(), "agent-store.sqlite"), { readOnly: true });
    expect(independent.prepare("SELECT COUNT(*) AS n FROM task49_delete").get()).toMatchObject({ n: 1 }); independent.close();
    closeAgentDb(); expect((await agent.executeToolCall("db_query", { sql: "SELECT * FROM task49_delete" })).count).toBe(1);
    const controller = new AbortController();
    const cancelled = await agent.executeToolCall("db_exec", { sql }, undefined, { signal: controller.signal, webContents: { id: 4949, isDestroyed: () => false, send(channel: string) { if (channel === "agent:approval-request") queueMicrotask(() => controller.abort("task49 DB cancel")); } } });
    expect(cancelled).toMatchObject({ skipped: true, cancelled: true, reason: "数据库操作已取消" });
    const afterCancel = new DatabaseSync(path.join(getAppDataDir(), "agent-store.sqlite"), { readOnly: true });
    expect(afterCancel.prepare("SELECT COUNT(*) AS n FROM task49_delete WHERE id=49").get()).toMatchObject({ n: 1 }); afterCancel.close();
    closeAgentDb(); reloadConfig(); expect((await agent.executeToolCall("db_query", { sql: "SELECT * FROM task49_delete WHERE id=49" })).count).toBe(1);
    expect(await agent.executeToolCall("db_exec", { sql }, undefined, { webContents: approvedOwner("once") })).toMatchObject({ changes: 1 });
    closeAgentDb(); reloadConfig();
    expect((await agent.executeToolCall("db_query", { sql: "SELECT * FROM task49_delete WHERE id=49" })).rows).toEqual([]);
  });
});

describe("real HTTP tools with registered local transport fixture", () => {
  it("preserves pinned destination/Host/method/headers, redacts cookies and never follows redirects", async () => {
    const seen: any[] = [];
    const base = await httpFixture(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
      seen.push({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
      res.writeHead(req.url === "/redirect" ? 302 : 201, { "Content-Type": "application/json", "Set-Cookie": ["synthetic=sensitive"], ...(req.url === "/redirect" ? { Location: "https://unregistered.invalid/never" } : {}) });
      res.end('{"error":"business payload"}');
    });
    const approvals: any[] = [];
    const response = await agent.executeToolCall("http_request", { url: `${base}/write?token=synthetic-query`, method: "post", body: { token: "synthetic-body" }, headers: { Authorization: "Bearer synthetic-header", "X-Task": 49, Ignored: { object: true } } }, undefined, { webContents: approvedOwner("once", approvals) });
    expect(response).toMatchObject({ status: 201, body: '{"error":"business payload"}', truncated: false });
    expect(response.headers["set-cookie"]).toBe("[REDACTED]");
    expect(seen[0]).toMatchObject({ method: "POST", body: '{"token":"synthetic-body"}', headers: { "x-task": "49", host: new URL(base).host } });
    expect(fixture.wire[0].hostname).toBe("198.51.100.49");
    expect(JSON.stringify(approvals)).not.toContain("synthetic-query");
    expect(JSON.stringify(approvals)).not.toContain("synthetic-body");
    expect(JSON.stringify(approvals)).not.toContain("synthetic-header");
    expect(approvals[0].detail).toContain("Authorization=[REDACTED]");
    const redirect = await agent.executeToolCall("http_request", { url: `${base}/redirect` });
    expect(redirect.status).toBe(302); expect(seen).toHaveLength(2);
  });

  it("enforces request/response caps and blocks non-HTTP redirects without following them", async () => {
    const base = await httpFixture((req, res) => {
      if (req.url === "/scheme") { res.writeHead(302, { Location: "file:///never-read" }); res.end(); return; }
      res.end("x".repeat(1024 * 1024 + 200));
    });
    const result = await agent.executeToolCall("http_request", { url: `${base}/large` });
    expect(result).toMatchObject({ status: 200, truncated: true }); expect(Buffer.byteLength(result.body)).toBe(1024 * 1024);
    expect((await agent.executeToolCall("http_request", { url: `${base}/scheme` })).body).toBe("blocked: redirect to non-http scheme");
    await expect(agent.agentHttpRequest({ url: base, body: "x".repeat(1024 * 1024 + 1) })).rejects.toThrow("too large");
    await expect(agent.agentHttpRequest({ url: base, timeoutMs: 999 })).rejects.toThrow("Invalid timeout");
  });

  it("cancels in-flight requests and pending approvals without dispatching a later write", async () => {
    let arrived!: () => void; const arrival = new Promise<void>((resolve) => { arrived = resolve; });
    const base = await httpFixture(() => arrived());
    const controller = new AbortController();
    const pending = agent.executeToolCall("http_request", { url: `${base}/held` }, undefined, { signal: controller.signal });
    await arrival; controller.abort(new Error("task49 cancellation"));
    await expect(pending).rejects.toThrow("timed out");
    const before = fixture.wire.length;
    const approvalController = new AbortController();
    const write = agent.executeToolCall("http_request", { method: "DELETE", url: base }, undefined, { signal: approvalController.signal });
    expect(listPendingApprovals()).toHaveLength(1); approvalController.abort("user stopped");
    expect(await write).toMatchObject({ skipped: true, decision: "deny" });
    expect(listPendingApprovals()).toEqual([]); expect(fixture.wire).toHaveLength(before);
  });

  it.each(["http://localhost/", "http://x.localhost/", "http://127.0.0.1/", "http://10.0.0.1/", "http://100.64.0.1/", "http://169.254.1.1/", "http://172.16.1.1/", "http://192.168.1.1/", "http://224.0.0.1/", "http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:7f00:1]/", "file:///never-read", "not a URL"])("rejects unsafe target %s before any socket", async (url) => {
    await expect(agent.executeToolCall("http_request", { url })).rejects.toThrow(); expect(fixture.wire).toEqual([]);
  });

  it("rejects mixed DNS and empty DNS, with no re-resolution or socket dispatch", async () => {
    fixture.dns.set("mixed.task49.test", [{ address: "198.51.100.49", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    fixture.dns.set("empty.task49.test", []);
    await expect(agent.assertSafeNavigationUrl("https://mixed.task49.test")).rejects.toThrow("private");
    await expect(agent.agentHttpRequest({ url: "https://empty.task49.test" })).rejects.toThrow("did not resolve");
    expect(fixture.wire).toEqual([]);
  });
});

describe("account references and redacted tool projections", () => {
  it("uses committed references, rejects stale selection, persists updates and filters global/profile accounts", async () => {
    const first = agent.addAccount({ platformUrl: "https://account.task49.test", platformUserName: "needle-49", platformPassword: "synthetic-password", profileIds: ["ab_49"] });
    expect(first).not.toHaveProperty("platformPassword"); expect(first.hasPassword).toBe(true);
    expect(diskConfig().accounts[0].platformUserName).toBe("needle-49"); reloadConfig();
    let selected = agent.getRedactedAccounts().find((entry) => entry.platformUserName === "needle-49")!;
    expect(agent.getAccountPassword(selected.ref.index, selected.ref)).toBe("synthetic-password");
    const oldRef = selected.ref;
    agent.updateAccount(0, { tags: ["task49"], platformPassword: "" }, selected.ref);
    expect(diskConfig().accounts[0]).toMatchObject({ tags: ["task49"], platformPassword: "synthetic-password" }); reloadConfig();
    expect(() => agent.getAccount(0, oldRef)).toThrow("CONFLICT");
    selected = agent.getRedactedAccounts()[0];
    expect(agent.getRedactedAccount(0, selected.ref)).toMatchObject({ platformUserName: "needle-49", tags: ["task49"] });
    agent.setAccountProfileIds(0, ["ab_49", "ab_49", "../../bad"], selected.ref);
    expect(diskConfig().accounts[0].profileIds).toEqual(["ab_49"]); reloadConfig();
    agent.addAccount({ platformUrl: "https://global.task49.test", platformUserName: "global-49", platformPassword: "" });
    expect(diskConfig().accounts).toHaveLength(2); reloadConfig();
    expect(agent.getProfileAccounts("ab_49").map((entry) => entry.platformUserName)).toEqual(["needle-49", "global-49"]);
    expect(agent.getProfileAccounts("ab_other").map((entry) => entry.platformUserName)).toEqual(["global-49"]);
    const listed = await agent.executeToolCall("list_accounts", {}, undefined, { browserScope: undefined });
    expect(JSON.stringify(listed)).not.toContain("synthetic-password"); expect(listed.accounts[0].ref.index).toBe(0);
    expect(await agent.executeToolCall("list_accounts", {}, undefined, { browserScope: null })).toEqual({ accounts: [] });
    selected = agent.getRedactedAccounts()[0]; agent.setAccountProfileIds(0, [], selected.ref);
    expect(diskConfig().accounts[0]).not.toHaveProperty("profileIds"); reloadConfig();
    expect(agent.getProfileAccounts("ab_other")).toHaveLength(2);
    selected = agent.getRedactedAccounts()[0]; agent.deleteAccount(0, selected.ref);
    expect(diskConfig().accounts.map((entry: any) => entry.platformUserName)).toEqual(["global-49"]); reloadConfig();
    expect(agent.getAccounts().find((entry) => entry.platformUserName === "needle-49")).toBeUndefined();
    expect(agent.getAccountPassword(0, agent.getAccounts()[0].ref)).toBeNull();
  });

  it.each([null, [], { platformUrl: "", platformUserName: "x" }, { platformUrl: "https://x.test", platformUserName: "badname" }, { platformUrl: "x", platformUserName: "u", tags: [49] }, { platformUrl: "x", platformUserName: "u", profileIds: ["../bad"] }, { platformUrl: "x", platformUserName: "u", createdAt: "yesterday" }, { platformUrl: "x", platformUserName: "u", platformPassword: 49 }, { platformUrl: "x", platformUserName: "u", admin: true }])("rejects invalid account %j atomically", (account) => {
    const before = fs.readFileSync(getConfigPath());
    expect(() => agent.addAccount(account as any)).toThrow("ACCOUNT_VALIDATION_FAILED");
    expect(fs.readFileSync(getConfigPath())).toEqual(before); reloadConfig(); expect(agent.getAccounts()).toEqual([]);
  });

  it("bulk-parses aliases/tags, skips invalid rows and verifies searchable committed records", () => {
    expect(agent.parseAccountsBulkText(" \n")).toEqual([]);
    const parsed = agent.parseAccountsBulkText("website,user,pwd,tag,ignored\n https://bulk.task49.test, user49, synthetic, a|a;b , x\n,missing\nhttps://other.task49.test,other,,");
    expect(parsed).toEqual([{ url: "https://bulk.task49.test", username: "user49", password: "synthetic", tags: ["a", "b"] }, { url: "https://other.task49.test", username: "other" }]);
    expect(agent.parseAccountsBulkText("https://pos.task49.test,pos,synthetic-password,synthetic-tag")).toHaveLength(1);
    expect(agent.bulkAddAccounts([...parsed, { url: "", username: "invalid" }, null as any])).toMatchObject({ added: 2, skipped: 2, errors: [{ line: 3 }, { line: 4 }] });
    expect(diskConfig().accounts).toHaveLength(2); reloadConfig();
    expect(agent.getAccounts().find((entry) => entry.platformUserName === "user49")?.tags).toEqual(["a", "b"]);
    const replacements = agent.getAccounts().map(({ ref: _ref, ...account }) => account);
    agent.saveAccounts(replacements); expect(diskConfig().accounts).toHaveLength(2); reloadConfig();
    expect(agent.getRedactedAccounts().filter((entry) => entry.platformUrl.includes("bulk"))).toHaveLength(1);
    expect(agent.bulkAddAccounts([])).toEqual({ added: 0, skipped: 0, errors: [] });
    expect(agent.bulkCreateProfilesWithAccounts([{ url: "", username: "invalid" }])).toMatchObject({ added: 0, created: 0, skipped: 1 });
    expect(agent.deriveProfileName("https://www.bulk.task49.test", "user49", new Set(["bulk.task49.test · user49"]))).toBe("bulk.task49.test · user49 #2");
    expect(agent.deriveProfileName("bare-host/path", "name", new Set())).toBe("bare-host · name");
  });
});

describe("real run variables and bounded tool batches", () => {
  it("isolates concurrent run variables, redacts disk and clears raw values at terminal/reload", async () => {
    const a = run("A"); const b = run("B");
    await Promise.all([agent.executeToolCall("set_var", { key: "order", value: "synthetic-a" }, undefined, { runId: a.id }), agent.executeToolCall("set_var", { key: "order", value: { id: "synthetic-b" } }, undefined, { runId: b.id })]);
    const disk = diskConfig(); expect(JSON.stringify(disk.agentRuns)).not.toContain("synthetic-");
    expect(disk.agentRuns.find((entry: any) => entry.id === a.id).variables.order).toMatch(/^\[REDACTED:/);
    reloadConfig();
    expect((await agent.executeToolCall("get_var", { key: "order" }, undefined, { runId: a.id })).value).toBe("synthetic-a");
    expect((await agent.executeToolCall("get_var", { key: "order" }, undefined, { runId: b.id })).value).toBe('{"id":"synthetic-b"}');
    agentRunRecorder.finishRun(a.id, "done");
    expect(diskConfig().agentRuns.find((entry: any) => entry.id === a.id).status).toBe("done"); reloadConfig();
    expect((await agent.executeToolCall("get_var", { key: "order" }, undefined, { runId: a.id })).value).toBeNull();
    expect((await agent.executeToolCall("get_var", { key: "order" }, undefined, { runId: b.id })).value).toContain("synthetic-b");
    for (const tool of ["get_var", "set_var"]) await expect(agent.executeToolCall(tool, { key: "order", value: "x" })).rejects.toThrow("active agent run");
    expect(await agent.executeToolCall("set_var", { key: "__proto__", value: "bad" }, undefined, { runId: b.id })).toEqual({ key: "__proto__", value: "[invalid key]" });
  });

  it("runs a mixed real-file tool batch with precise failure tally and cooperative cancellation", async () => {
    const signal = { cancelled: false };
    const batch = await runBatch({ items: ["one.txt", "../invalid", "two.txt", "never.txt"], concurrency: 1, signal,
      worker: async (item) => agent.executeToolCall("write_file", { path: item, content: `task49-${item}` }),
      onProgress(done) { if (done === 3) signal.cancelled = true; },
    });
    expect(batch).toMatchObject({ total: 4, succeeded: 2, failed: 2, cancelled: true });
    expect(batch.results.map((entry) => entry.ok)).toEqual([true, false, true, false]);
    for (const name of ["one.txt", "two.txt"]) expect(fs.readFileSync(path.join(getAppDataDir(), "agent-files", name), "utf8")).toBe(`task49-${name}`);
    reloadConfig(); expect((await agent.executeToolCall("read_file", { path: "two.txt" })).content).toBe("task49-two.txt");
    expect(fs.existsSync(path.join(getAppDataDir(), "agent-files/never.txt"))).toBe(false);
  });

  it("commits actual tool query results as run artifacts and verifies independent disk/reopened preview", async () => {
    const r = run("Artifact source");
    const queried = await agent.executeToolCall("db_query", { sql: "SELECT 'needle-49' AS title, 'https://article.task49.test' AS url" });
    const store = new RunResultStore({ rootProvider: () => fixture.dataDir });
    const result = store.commitRunResult({ runId: r.id, runStartedAt: r.startedAt, templateId: "task49", templateVersion: 1,
      verification: { status: "unverified" }, terminal: { status: "done", endReason: "completed", finishedAt: Date.now() },
      dataset: { columns: ["title", "url"], rows: queried.rows, sourceRowCount: 1, rejectedRowCount: 0, truncated: false } as any,
    });
    expect(result.ok).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(store.rootDir(), r.id, "manifest.json"), "utf8"));
    expect(manifest.artifacts.length).toBeGreaterThan(0);
    reloadConfig();
    const reopened = new RunResultStore({ rootProvider: () => fixture.dataDir });
    const artifact = manifest.artifacts.find((entry: any) => entry.kind === "dataset");
    expect(reopened.readDatasetPreview(r.id, artifact.id, 0, 10)).toMatchObject({ ok: true, value: { rows: [["needle-49", "https://article.task49.test"]], total: 1 } });
  });
});
