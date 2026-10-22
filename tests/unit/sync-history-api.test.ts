// Shipped REST/MCP routers over real loopback sockets and original config store.
// Sync data IO is a controlled response here; actual PUT/GET/SQLite is separate.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, request, startFixture } from "./rest-mcp-socket-helper.js";
let f: Awaited<ReturnType<typeof startFixture>>;
const ID = "ab_history_api";
const COMPLETE = { success: true, message: "Synthetic scoped operation", outcome: "complete", localCommit: "committed", remoteCommit: "committed", items: [], warnings: [], recovery: [] };
beforeAll(async () => { f = await startFixture("both"); });
afterAll(async () => { await f?.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  f.store.transact((draft: any) => { delete draft.team; draft.browserProfiles = { [ID]: { name: "Synthetic scope target", engine: "chromium", fingerprintSeed: 42 } };
    draft.sync = { enabled: false, endpoint: "", bucket: "", accessKey: "", secretKey: "" }; });
  h.sync.push.mockReset().mockResolvedValue(COMPLETE); h.sync.pull.mockReset().mockResolvedValue(COMPLETE);
  h.sync.historyState.mockReset().mockResolvedValue({ scope: "history-and-firefox-bookmarks", status: "unknown", coverage: "legacy", freshness: "not-covered", reason: "history-no-baseline", capturedAt: null });
});

const post = (route: string, body: unknown) => f.api(route, { method: "POST", body });
describe("full environment configure keeps explicit human scope, auth/RBAC and secret boundaries", () => {
  const phrase = "  synthetic migration phrase  ";
  const settings = { custodyConsent: true, fullProfileConsent: true, includeFullProfile: true, fullProfilePassphrase: phrase };
  it("preserves public health 200, protected no-auth 401 and authenticated storage/readback without echoing input secrets", async () => {
    const before = f.bytes();
    expect((await f.api("/health", { token: null })).status).toBe(200);
    expect((await f.api("/api/sync/config", { method: "POST", token: null, body: settings })).status).toBe(401); expect(f.bytes()).toEqual(before);
    expect((await request(f.mcpPort, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_browser_sync_configure", arguments: settings } } })).status).toBe(401); expect(f.bytes()).toEqual(before);
    const saved = await post("/api/sync/config", { ...settings, fullProfileConsentAt: 1, historyConsentAt: 1 }); expect(saved.status).toBe(200);
    const disk = f.disk().sync; expect(disk.includeFullProfile).toBe(true); expect(disk.includeHistory).toBe(true); expect(disk.fullProfileConsentAt).toBeGreaterThan(1); expect(disk.historyConsentAt).toBe(disk.fullProfileConsentAt);
    expect(disk.fullProfilePassphrase).toMatch(/^v2:/); expect(f.bytes().toString("utf8").includes(phrase)).toBe(false);
    const secrets = await import("../../src/main/services/secrets.js"); expect(secrets.decryptSecret(disk.fullProfilePassphrase) === phrase).toBe(true);
    f.config.reloadConfig(); expect(f.config.getSyncConfig()).toEqual(disk);
    expect(saved.text.includes(phrase)).toBe(false); expect(saved.text.includes(disk.fullProfilePassphrase)).toBe(false); expect(saved.body).not.toHaveProperty("fullProfilePassphrase");
  });
  it("rejects ordinary-consent upgrades and viewer attempts without any disk mutation", async () => {
    let before = f.bytes();
    for (const body of [{ custodyConsent: true, includeFullProfile: true, fullProfilePassphrase: phrase }, { ...settings, fullProfilePassphrase: "" }, { ...settings, fullProfileConsent: "true" }]) {
      expect((await post("/api/sync/config", body)).status).toBe(400); expect(f.bytes()).toEqual(before);
    }
    f.role("viewer"); before = f.bytes();
    expect((await post("/api/sync/config", settings)).status).toBe(403); expect(f.bytes()).toEqual(before);
    expect((await f.call("agent_browser_sync_configure", settings)).payload).toMatchObject({ success: false, code: "TEAM_ROLE_DENIED" }); expect(f.bytes()).toEqual(before);
  });
  it("MCP accepts only explicit full consent, retains the local passphrase on blank input and applies History revocation", async () => {
    const saved = await f.call("agent_browser_sync_configure", settings); expect(saved.payload.success).toBe(true);
    const encrypted = f.disk().sync.fullProfilePassphrase; expect(saved.text.includes(phrase)).toBe(false); expect(saved.text.includes(encrypted)).toBe(false);
    expect((await f.call("agent_browser_sync_configure", { fullProfilePassphrase: "", bucket: "synthetic-bucket" })).payload.success).toBe(true); expect(f.disk().sync.fullProfilePassphrase).toBe(encrypted);
    expect((await f.call("agent_browser_sync_configure", { historyConsent: false, includeFullProfile: true })).payload.success).toBe(true);
    expect(f.disk().sync.includeFullProfile).toBe(false); expect(f.disk().sync.includeHistory).toBe(false); expect(f.disk().sync.historyConsentAt).toBeNull();
  });
  it("advertises write-only full migration settings with explicit human intent and no caller consent timestamp", async () => {
    const tools = (await f.rpc("tools/list")).body.result.tools;
    const tool = tools.find((item: any) => item.name === "agent_browser_sync_configure");
    expect(tool.description).toMatch(/human.*explicit/); expect(tool.description).toMatch(/autonomously.*AI/);
    const properties = tool.inputSchema.properties;
    expect(properties.includeFullProfile.type).toBe("boolean"); expect(properties.fullProfileConsent.type).toBe("boolean");
    expect(properties.fullProfilePassphrase).toMatchObject({ type: "string", maxLength: 1024, writeOnly: true }); expect(properties.fullProfileConsentAt).toBeUndefined();
    const route = (await f.api("/openapi.json", { token: null })).body.paths["/api/sync/config"].post;
    expect(route.requestBody.content["application/json"].schema.properties.fullProfilePassphrase.writeOnly).toBe(true);
    expect(route.responses["401"]).toBeDefined(); expect(route.responses["403"]).toBeDefined(); expect(route.description).toMatch(/human.*explicit/);
  });
});

describe("history settings preserve public health and protected auth/RBAC boundaries", () => {
  it("keeps public health 200 and protected scope endpoints 401 without synthetic auth / 200 with auth", async () => {
    expect((await f.api("/health", { token: null })).status).toBe(200);
    for (const route of ["/api/sync/status", `/api/sync/history/${ID}`]) expect((await f.api(route, { token: null })).status).toBe(401);
    expect((await f.api("/api/sync/config", { method: "POST", token: null, body: { historyConsent: true, includeHistory: true } })).status).toBe(401);
    expect(f.disk().sync.historyConsentAt).toBeUndefined(); expect(h.sync.historyState).not.toHaveBeenCalled();
    expect((await f.api("/api/sync/status")).status).toBe(200);
    expect((await f.api(`/api/sync/history/${ID}`)).status).toBe(200); expect(h.sync.historyState).toHaveBeenCalledExactlyOnceWith(ID);
    const saved = await post("/api/sync/config", { historyConsent: true, includeHistory: true }); expect(saved.status).toBe(200);
    const stamp = f.disk().sync.historyConsentAt; expect(stamp).toBeGreaterThan(0); expect(f.disk().sync.includeHistory).toBe(true);
    f.config.reloadConfig(); expect(f.config.getSyncConfig().historyConsentAt).toBe(stamp); expect(f.config.getSyncConfig().includeHistory).toBe(true);
  });
  it("requires separate consent and refuses viewer mutation without storage effects", async () => {
    const before = f.bytes();
    expect((await post("/api/sync/config", { includeHistory: true, historyConsentAt: 1 })).status).toBe(400); expect(f.bytes()).toEqual(before);
    f.role("viewer"); const viewerBytes = f.bytes();
    expect((await post("/api/sync/config", { historyConsent: true, includeHistory: true })).status).toBe(403); expect(f.bytes()).toEqual(viewerBytes);
    const mcp = await f.call("agent_browser_sync_configure", { historyConsent: true, includeHistory: true }); expect(mcp.payload).toMatchObject({ success: false, code: "TEAM_ROLE_DENIED" }); expect(f.bytes()).toEqual(viewerBytes);
  });
  it("MCP auth is not bypassed by the new tools; configure stamps only from explicit flags", async () => {
    expect((await request(f.mcpPort, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_browser_sync_configure", arguments: { historyConsent: true, includeHistory: true } } } })).status).toBe(401);
    expect(f.disk().sync.includeHistory).toBeUndefined();
    const result = await f.call("agent_browser_sync_configure", { historyConsent: true, includeHistory: true, historyConsentAt: 1 }); expect(result.payload.success).toBe(true);
    expect(f.disk().sync.historyConsentAt).toBeGreaterThan(1); expect(f.disk().sync.includeHistory).toBe(true);
    const revoked = await f.call("agent_browser_sync_configure", { historyConsent: false }); expect(revoked.payload.success).toBe(true);
    expect(f.disk().sync.historyConsentAt).toBeNull(); expect(f.disk().sync.includeHistory).toBe(false);
  });
});

describe("history option / typed receipt boundaries", () => {
  it.each(["push", "pull"] as const)("REST %s passes explicit true/false and refuses coercion", async (kind) => {
    for (const history of [true, false]) {
      const response = await post(`/api/sync/${kind}`, { history, strategy: "remote" }); expect(response.status).toBe(200);
      if (kind === "push") expect(h.sync.push).toHaveBeenLastCalledWith(undefined, false, undefined, { history });
      else expect(h.sync.pull).toHaveBeenLastCalledWith(undefined, { strategy: "remote", resolutions: {}, comparisonToken: undefined, history });
    }
    const calls = h.sync[kind].mock.calls.length;
    for (const history of ["true", 1, null, {}, []]) expect((await post(`/api/sync/${kind}`, { history })).status).toBe(400);
    expect(h.sync[kind]).toHaveBeenCalledTimes(calls);
  });
  it.each(["push", "pull"] as const)("MCP %s retains scoped incomplete receipts and refuses coerced history", async (kind) => {
    const facts = { ...COMPLETE, success: false, outcome: "partial", items: [{ scope: "history", id: ID, state: "preserved", history: { state: "preserved", freshness: "preserved" } }] };
    h.sync[kind].mockResolvedValue(facts);
    const response = await f.call(`agent_browser_sync_${kind}`, { history: true, strategy: "remote" }); expect(response.payload).toEqual(facts);
    if (kind === "push") expect(h.sync.push).toHaveBeenCalledWith(undefined, false, undefined, { history: true });
    else expect(h.sync.pull).toHaveBeenCalledWith(undefined, { strategy: "remote", resolutions: {}, comparisonToken: undefined, history: true });
    const count = h.sync[kind].mock.calls.length;
    expect((await f.call(`agent_browser_sync_${kind}`, { history: "true" })).payload).toMatchObject({ success: false, code: "INVALID_HISTORY_SCOPE" }); expect(h.sync[kind]).toHaveBeenCalledTimes(count);
  });
  it("advertises history as a boolean with no true default, and keeps OpenAPI scoped", async () => {
    const tools = (await f.rpc("tools/list")).body.result.tools;
    for (const name of ["agent_browser_sync_push", "agent_browser_sync_pull"]) {
      const tool = tools.find((tool: any) => tool.name === name); expect(tool.inputSchema.properties.history).toEqual({ type: "boolean" }); expect(tool.description).toMatch(/consent/);
    }
    const spec = (await f.api("/openapi.json", { token: null })).body;
    expect(spec.paths["/api/sync/config"]).toBeDefined(); expect(spec.paths["/api/sync/history/{dirId}"]).toBeDefined();
    for (const name of ["push", "pull"]) expect(spec.paths[`/api/sync/${name}`].post.requestBody.content["application/json"].schema.properties.history.type).toBe("boolean");
  });
});
