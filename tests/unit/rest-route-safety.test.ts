import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, startFixture, rawRequest, request as socketRequest } from "./rest-mcp-socket-helper.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

let f: Awaited<ReturnType<typeof startFixture>>;
const dirId = "ab_task48_fixture", extId = "a".repeat(32);
const unhandled: unknown[] = [];
const observeUnhandled = (error: unknown) => unhandled.push(error);
beforeAll(async () => { process.on("unhandledRejection", observeUnhandled); f = await startFixture("both"); });
afterAll(async () => {
  try { await f?.close(); } finally { process.off("unhandledRejection", observeUnhandled); }
  expect(unhandled).toEqual([]);
});
beforeEach(() => {
  f.store.transact((draft: any) => { delete draft.team; draft.proxies = {}; draft.browserProfiles[dirId] = { name: "Synthetic profile", engine: "chromium", proxyMode: "none" }; });
  h.extensions.addOrUpdateChromeStoreExtension.mockClear();
});

describe("REST route safety on actual sockets", () => {
  it("typechecks the two production server entrypoints with no emit (owned scope only)", () => {
    const root = path.resolve(__dirname, "../..");
    const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
    expect(configFile.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
    const owned = ["rest-api-server.ts", "mcp-server.ts"].map(name => path.join(root, "src/main/services", name));
    const program = ts.createProgram(owned, { ...parsed.options, noEmit: true, incremental: false });
    // Ask for owned-file diagnostics directly rather than typechecking every
    // transitive service and filtering afterwards. This keeps the normal 5s
    // test deadline while preserving the real project compiler options.
    const diagnostics = [...program.getOptionsDiagnostics(), ...owned.flatMap(file => {
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`Missing typecheck input: ${file}`);
      return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
    })];
    expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });
  it("invalid request targets are contained rather than rejecting the async HTTP listener", async () => {
    const response = await rawRequest(f.restPort, `GET //// HTTP/1.1\r\nHost: 127.0.0.1:${f.restPort}\r\nAuthorization: Bearer ${f.rest!.getRestApiToken()}\r\nConnection: close\r\n\r\n`);
    try { expect(response).toMatch(/^HTTP\/1\.1 400 /); } finally { expect((await f.api("/api/profiles")).status).toBe(200); }
  });
  it("a scalar/array/null JSON body cannot authorize default conversation writes", async () => {
    f.agent.createConversation("Synthetic input-validation baseline");
    for (const body of [null, [], 7, true, "not-options"]) {
      const before = f.agent.listConversations().length;
      const response = await f.api("/api/agent/conversations", { body });
      const observed = f.agent.listConversations().length;
      expect({ status: response.status, count: observed }).toEqual({ status: 400, count: before });
    }
  });
  it("denies viewer per-profile extension mutations before download or config writes", async () => {
    h.extensions.addOrUpdateChromeStoreExtension.mockResolvedValue({ id: extId });
    f.role("viewer"); const before = f.bytes();
    for (const options of [
      { route: `/api/profiles/${dirId}/extensions/${extId}/install`, method: "POST" },
      { route: `/api/profiles/${dirId}/extensions/${extId}`, method: "DELETE" },
    ]) {
      const denied = await f.api(options.route, { method: options.method });
      expect(denied.status).toBe(403); expect(denied.body.error).toMatch(/member role/);
      expect(f.bytes()).toEqual(before);
    }
    expect(h.extensions.addOrUpdateChromeStoreExtension).not.toHaveBeenCalled();
  });
  it.each([null, []].map(config => [config]))("rejects malformed proxy patch config %j without a nominal success or write", async config => {
    f.config.addProxy("synthetic-proxy", { type: "http", host: "proxy.synthetic.invalid", port: 8080 });
    const before = f.bytes();
    const invalid = await f.api("/api/proxies/synthetic-proxy", { method: "PATCH", body: { config } });
    expect(invalid.status).toBe(400); expect(f.bytes()).toEqual(before);
  });
  it("reports missing profile extensions as not found, not an empty installed catalog", async () => {
    const response = await f.api("/api/profiles/ab_missing_fixture/extensions");
    expect(response.status).toBe(404);
    expect(h.extensions.addOrUpdateChromeStoreExtension).not.toHaveBeenCalled();
  });
});

describe("import completion facts retain real per-item reports", () => {
  it("proxy import exposes partial, not full success, for imported + duplicate + malformed rows", async () => {
    const response = await f.api("/api/proxies/import", { body: { text: [
      "name,type,host,port", "batch-good,http,proxy.synthetic.invalid,8080", "batch-duplicate,http,proxy.synthetic.invalid,8080", "batch-bad,http,bad.synthetic.invalid,bad-port",
    ].join("\n") } });
    expect(response.status).toBe(200);
    expect(response.body.report).toMatchObject({ imported: ["batch-good"], skipped: [{ name: "batch-duplicate" }], failed: [{ line: "batch-bad,http,bad.synthetic.invalid,bad-port", error: "invalid host/port" }] });
    expect(f.disk().proxies["batch-good"].host).toBe("proxy.synthetic.invalid"); f.config.reloadConfig();
    expect((await f.api("/api/proxies/batch-good")).status).toBe(200);
    expect(response.body).toMatchObject({ success: false, outcome: "partial" });
  });
  it("preserves the full-success shape and distinguishes pure skipped and failed proxy batches", async () => {
    const body = { text: "proxy.synthetic.invalid:8080" };
    const completed = await f.api("/api/proxies/import", { body });
    expect(completed.body).toEqual({ success: true, report: { imported: ["proxy.synthetic.invalid-8080"], skipped: [], failed: [] } });
    const before = f.bytes(); const skipped = await f.api("/api/proxies/import", { body });
    expect(skipped.body.report.imported).toEqual([]); expect(skipped.body.report.skipped).toHaveLength(1); expect(f.bytes()).toEqual(before);
    expect(skipped.body).toMatchObject({ success: false, outcome: "skipped" });
    const failed = await f.api("/api/proxies/import", { body: { text: "not a proxy" } });
    expect(failed.body.report.failed).toHaveLength(1); expect(failed.body).toMatchObject({ success: false, outcome: "failed" }); expect(f.bytes()).toEqual(before);
  });
  it("account bulk's actual validation failure retains its successful committed row and partial report", async () => {
    f.agent.saveAccounts([]);
    const response = await f.api("/api/accounts/bulk", { body: { text: "url,username,password,tags\nhttps://synthetic.invalid/good,batch-good,synthetic-bulk-secret,fixture\nhttps://synthetic.invalid/bad,batch-bad,never-written,badtag" } });
    expect(response.status).toBe(200); expect(response.body.report).toMatchObject({ added: 1, skipped: 1, errors: [{ line: 2, error: expect.stringContaining("Invalid tags") }] });
    expect(f.disk().accounts.map((a: any) => a.platformUserName)).toEqual(["batch-good"]); expect(JSON.stringify(f.disk().accounts)).not.toContain("synthetic-bulk-secret");
    f.config.reloadConfig(); expect((await f.api("/api/accounts")).body.accounts.map((a: any) => a.username)).toEqual(["batch-good"]);
    expect(response.body).toMatchObject({ success: false, outcome: "partial" });
  });
  it("account-only all-failed imports are failed without writes", async () => {
    f.agent.saveAccounts([]); const before = f.bytes();
    const response = await f.api("/api/accounts/bulk", { body: { text: "https://synthetic.invalid/bad,batch-bad,,badtag" } });
    expect(response.body.report).toMatchObject({ added: 0, skipped: 1, errors: [{ line: 1 }] }); expect(f.bytes()).toEqual(before);
    expect(response.body).toMatchObject({ success: false, outcome: "failed" });
  });
  it("bulk profile creation preserves committed profile/account pairs and partial failure details", async () => {
    f.agent.saveAccounts([]);
    h.browser.listBrowserProfiles.mockReturnValueOnce([]);
    h.browser.createBrowserProfile.mockImplementationOnce((options: any) => {
      f.store.transact((draft: any) => { draft.browserProfiles.ab_batch_created = { name: options.name, engine: "chromium", proxyMode: "none" }; });
      return { dirId: "ab_batch_created" };
    }).mockImplementationOnce(() => { throw new Error("Synthetic second profile refusal"); });
    const response = await f.api("/api/accounts/bulk", { body: { createProfiles: true, text: "https://synthetic.invalid/first,first-fixture\nhttps://synthetic.invalid/second,second-fixture" } });
    expect(response.body.report).toMatchObject({ added: 1, created: 1, skipped: 1, errors: [{ line: 2, error: "Synthetic second profile refusal" }] });
    expect(f.disk().accounts[0].profileIds).toEqual(["ab_batch_created"]); f.config.reloadConfig();
    expect((await f.api("/api/profiles/ab_batch_created")).status).toBe(200);
    expect(response.body).toMatchObject({ success: false, outcome: "partial" });
  });
});

function unserializable(kind: string): any {
  if (kind === "bigint") return 1n;
  const value: any = {}; value.self = value; return value;
}
async function legitimateProbe(mode: string) {
  if (mode === "rest") expect((await f.api("/health")).status).toBe(200);
  else expect((await f.rpc("initialize")).body.result.serverInfo.name).toBe("agent-browser-studio");
}

describe("serialization failures are contained before response headers", () => {
  it.each(["bigint", "circular"])("REST %s response faults produce 500 and leave the next request usable", async kind => {
    h.browser.listBrowserProfiles.mockReturnValueOnce([{ dirId, name: unserializable(kind), proxyMode: "none" }]);
    try {
      const response = await f.api("/api/profiles").catch(error => ({ status: 0, body: { error: String(error) } }));
      expect(response.status).toBe(500); expect(response.body.error).toEqual(expect.any(String));
    } finally { await legitimateProbe("rest"); }
  });
  it.each(["bigint", "circular"])("MCP %s advertised-schema faults produce 500 and leave the next request usable", async kind => {
    const schema: any = f.agent.AGENT_TOOLS.find(t => t.function.name === "db_query")!.function.parameters;
    const previous = Object.getOwnPropertyDescriptor(schema, "__task48SerializationFault");
    schema.__task48SerializationFault = unserializable(kind);
    try {
      const response = await f.rpc("tools/list").catch(error => ({ status: 0, body: { error: String(error) } }));
      expect(response.status).toBe(500); expect(response.body.error.code).toBe(-32603);
    } finally {
      if (previous) Object.defineProperty(schema, "__task48SerializationFault", previous); else delete schema.__task48SerializationFault;
      await legitimateProbe("mcp");
    }
  });
  it.each([["rest", "regular"], ["mcp", "regular"], ["rest", "early origin"], ["mcp", "early origin"]])("%s %s does not send a second header after an end failure on an already-started response", async (mode, stage) => {
    const original = http.ServerResponse.prototype.end; let injected = false;
    const headers = vi.spyOn(http.ServerResponse.prototype, "writeHead");
    const end = vi.spyOn(http.ServerResponse.prototype, "end").mockImplementation(function(this: http.ServerResponse, ...args: any[]) {
      if (!injected) { injected = true; this.flushHeaders(); throw new Error("Synthetic response failure after headers"); }
      return (original as any).apply(this, args);
    });
    try {
      const pending = stage === "early origin"
        ? socketRequest(mode === "rest" ? f.restPort : f.mcpPort, "/health", { headers: { Origin: "https://outside.invalid" } })
        : mode === "rest" ? f.api("/health") : f.rpc("initialize");
      const response = await pending.then(() => ({ failed: false }), error => ({ failed: true, error: String(error) }));
      expect(response.failed).toBe(true); expect(injected).toBe(true); expect(headers).toHaveBeenCalledTimes(1);
    } finally { end.mockRestore(); headers.mockRestore(); await legitimateProbe(mode); }
  });
  it("MCP malformed URL targets are client errors, not 500 internal errors", async () => {
    const response = await rawRequest(f.mcpPort, `GET //// HTTP/1.1\r\nHost: 127.0.0.1:${f.mcpPort}\r\nAuthorization: Bearer ${f.mcp!.getMcpToken()}\r\nConnection: close\r\n\r\n`);
    try { expect(response).toMatch(/^HTTP\/1\.1 400 /); } finally { await legitimateProbe("mcp"); }
  });
});

function queuedJson(route: string, body: unknown, method = "POST") {
  const raw = JSON.stringify(body); let finish!: () => void, destroy!: () => void;
  const pending = new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: f.restPort, path: route, method, agent: false,
      headers: { Authorization: `Bearer ${f.rest!.getRestApiToken()}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) },
    }, res => { let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) })); res.on("error", reject); });
    req.on("error", reject); req.setTimeout(1500, () => req.destroy(new Error("Queued role-change fixture deadline")));
    req.write(raw.slice(0, 1)); finish = () => req.end(raw.slice(1)); destroy = () => req.destroy();
  });
  return { pending, finish, destroy };
}

function commitExtensionFixture(mode: string) {
  const payload = `Synthetic ${mode} extension repository commit`, unpackedPath = path.join(f.dir, "extension-repository", extId, "current");
  fs.mkdirSync(unpackedPath, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(unpackedPath, `${mode}-committed-extension.txt`), payload, { mode: 0o600 });
  const entry = { id: extId, name: "Synthetic committed extension", version: "1.0", description: "Fixture only", source: "chrome-web-store", unpackedPath,
    updateUrl: `https://clients2.google.com/service/update2/crx?x=id%3D${extId}`,
    packageHash: createHash("sha512").update(payload).digest("hex"), manifestHash: createHash("sha512").update(payload).digest("hex"), shared: false, tags: [], addedAt: Date.now(), updatedAt: Date.now() };
  f.store.transact((draft: any) => { draft.extensionRepository = { ...(draft.extensionRepository || {}), [extId]: entry }; });
  return { ...entry, repositoryCommit: { committed: true, cleanupWarnings: [] } };
}

describe("existing settings permissions remain current at the actual mutation boundary", () => {
  it.each(["conversation", "conversation-rename", "db", "chat"])("REST %s queued-body demotion yields 403 with zero business writes", async kind => {
    const conv = f.agent.createConversation("Synthetic queued-body baseline");
    const conversationFile = path.join(f.dir, "agent-conversations.json");
    f.agent.saveLlmConfig({ provider: "openai", apiKey: "synthetic-never-sent", model: "synthetic" });
    expect(f.db.agentDbExecScript("CREATE TABLE IF NOT EXISTS task48_queued_revoke (value TEXT)").ok).toBe(true);
    h.chat.mockResolvedValueOnce({ messages: [{ role: "assistant", content: "Synthetic response that must never execute" }], endReason: "completed" });
    const route = kind === "conversation" ? "/api/agent/conversations" : kind === "conversation-rename" ? `/api/agent/conversations/${conv.id}` : kind === "db" ? "/api/agent/db/exec" : "/api/agent/chat";
    const body = kind.startsWith("conversation") ? { title: "Never written after demotion" } : kind === "db" ? { sql: "INSERT INTO task48_queued_revoke VALUES ('never-written-after-demotion')" } : { conversationId: conv.id, message: "Never sent after demotion" };
    f.role("member"); let observed!: () => void; const ready = new Promise<void>(resolve => { observed = resolve; });
    const actual = f.team.requireSettingsMutation;
    const gate = vi.spyOn(f.team, "requireSettingsMutation").mockImplementation(() => { const result = actual(); observed(); return result; });
    const queued = queuedJson(route, body, kind === "conversation-rename" ? "PATCH" : "POST");
    try {
      await Promise.race([ready, queued.pending.then(() => { throw new Error("Request finished before queued-body gate observation"); })]);
      f.role("viewer"); const before = f.bytes(), conversationsBefore = fs.readFileSync(conversationFile);
      const db = new DatabaseSync(path.join(f.dir, "agent-store.sqlite"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT value FROM task48_queued_revoke").all(); queued.finish(); const response = await queued.pending;
        // Inspect the real disk/SQLite effects before asserting the response.
        expect({ status: response.status, rows: db.prepare("SELECT value FROM task48_queued_revoke").all() }).toEqual({ status: 403, rows });
        expect(f.bytes()).toEqual(before); expect(fs.readFileSync(conversationFile)).toEqual(conversationsBefore); expect(h.chat).not.toHaveBeenCalled(); expect(gate).toHaveBeenCalledTimes(2);
      } finally { db.close(); }
    } finally { queued.destroy(); gate.mockRestore(); h.chat.mockReset(); }
  });
  it.each(["rest", "mcp"])("%s extension demotion after a committed repository update reports partial without enabling or claiming rollback", async mode => {
    f.role("member"); let reached!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const payload = `Synthetic ${mode} extension repository commit`, repositoryPath = path.join(f.dir, "extension-repository", extId, "current");
    const target = path.join(repositoryPath, `${mode}-committed-extension.txt`);
    const receipt = { committed: true, cleanupWarnings: [] };
    h.extensions.addOrUpdateChromeStoreExtension.mockImplementationOnce(async () => {
      reached(); await resume; return commitExtensionFixture(mode);
    });
    const pending = mode === "rest" ? f.api(`/api/profiles/${dirId}/extensions/${extId}/install`, { method: "POST" }) : f.call("agent_browser_install_extension", { dirId, extId });
    try {
      await Promise.race([ready, pending.then(() => { throw new Error("Installer did not enter the controlled await boundary"); })]);
      f.role("viewer"); release(); const response = await pending;
      const result = mode === "rest" ? response.body : (response as any).payload;
      expect(fs.readFileSync(target, "utf8")).toBe(payload);
      expect(f.disk().extensionRepository?.[extId], JSON.stringify(result)).toBeDefined();
      expect(f.disk().extensionRepository[extId].packageHash).toBe(createHash("sha512").update(payload).digest("hex"));
      expect(f.disk().browserProfiles[dirId].extensions?.[extId]).toBeUndefined(); f.config.reloadConfig();
      expect(f.config.getConfig().extensionRepository?.[extId]).toBeDefined(); expect(f.config.getProfileMeta(dirId)?.extensions?.[extId]).toBeUndefined();
      expect(result).toMatchObject({ success: false, outcome: "partial", code: "TEAM_ROLE_DENIED", repositoryCommit: receipt, profileEnable: "not-applied" });
      expect(result.extension.repositoryCommit).toEqual(receipt);
      expect(response.status).toBe(mode === "rest" ? 403 : 200); if (mode === "mcp") expect(response.body.result.isError).toBe(true);
    } finally { release(); await pending; }
  });
  it.each(["rest", "mcp"])("%s enable-save failure retains the committed repository and marks profile state unknown", async mode => {
    f.role("member"); let save: ReturnType<typeof vi.spyOn> | undefined;
    h.extensions.addOrUpdateChromeStoreExtension.mockImplementationOnce(async () => {
      const entry = commitExtensionFixture(`${mode}-save-failure`);
      save = vi.spyOn(f.config, "saveConfig").mockImplementationOnce(() => { throw new Error("Synthetic profile enable save failed"); });
      return entry;
    });
    try {
      const response = mode === "rest" ? await f.api(`/api/profiles/${dirId}/extensions/${extId}/install`, { method: "POST" }) : await f.call("agent_browser_install_extension", { dirId, extId });
      const result = mode === "rest" ? response.body : (response as any).payload;
      expect(f.disk().extensionRepository[extId]).toBeDefined(); expect(f.disk().browserProfiles[dirId].extensions?.[extId]).toBeUndefined();
      expect(result).toMatchObject({ success: false, outcome: "partial", repositoryCommit: { committed: true }, profileEnable: "unknown" });
      expect(result.error).toContain("Synthetic profile enable save failed"); expect(save).toHaveBeenCalledTimes(1);
      if (mode === "mcp") expect(response.body.result.isError).toBe(true);
      f.config.reloadConfig(); expect(f.config.getConfig().extensionRepository?.[extId]).toBeDefined();
    } finally { save?.mockRestore(); }
  });
  it.each(["rest", "mcp"])("%s post-await denial with no repository receipt remains unknown, not a fabricated commit or rollback", async mode => {
    f.role("member"); let before!: Buffer;
    h.extensions.addOrUpdateChromeStoreExtension.mockImplementationOnce(async () => { f.role("viewer"); before = f.bytes(); return { id: extId }; });
    const response = mode === "rest" ? await f.api(`/api/profiles/${dirId}/extensions/${extId}/install`, { method: "POST" }) : await f.call("agent_browser_install_extension", { dirId, extId });
    const result = mode === "rest" ? response.body : (response as any).payload;
    expect(result).toMatchObject({ success: false, outcome: "unknown", code: "TEAM_ROLE_DENIED", repositoryCommit: null, profileEnable: "not-applied" });
    expect(f.bytes()).toEqual(before); if (mode === "mcp") expect(response.body.result.isError).toBe(true);
  });
});
