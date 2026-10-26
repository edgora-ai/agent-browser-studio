// Finite Node-only transport proofs: original whole preload, registered sync IPC,
// event bus/operation event producer, and original REST/MCP HTTP callbacks.
// BrowserWindow/IPC and default HTTP listeners are modeled, NOT real Electron.
// One explicit REST fixture uses an owned ephemeral loopback socket to verify
// auth and Pull argument transport. SyncService remains a controlled boundary:
// these tests do not prove full-profile data restoration or website acceptance.
// Unselected application/native/storage/network operations fail closed.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import * as crypto from "node:crypto";
import * as nativeHttp from "node:http";
import { EventEmitter } from "node:events";
import ts from "typescript";
import type { SyncComparisonToken, SyncResult } from "../../src/main/types.js";

const MAIN = path.resolve(__dirname, "../../src/main");
const PRELOAD = fs.readFileSync(path.join(MAIN, "preload.cjs"), "utf8");
const MODULES = [
  "ipc/sync.ts", "services/rest-api-server.ts", "services/mcp-server.ts", "services/event-bus.ts", "services/team.ts", "services/server-mode.ts", "branding.ts",
  "services/sync/operation-state.ts", "services/sync/operation-result.ts", "services/http/auth.ts", "services/http/body.ts", "services/utils.ts", "services/agent/tool-outcome.ts",
];
const compileCounts = new Map<string, number>();
// Compile the REST main layer exactly once, then execute that unchanged code in
// fresh isolated realms. No source slices, AST rewrites, or test-only exports.
const COMPILED = new Map(MODULES.map(name => {
  compileCounts.set(name, (compileCounts.get(name) || 0) + 1);
  return [name, ts.transpileModule(fs.readFileSync(path.join(MAIN, name), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText];
}));
const TOKEN: SyncComparisonToken = Object.freeze({ targetId: "a".repeat(64), localHash: "b".repeat(64), remoteHash: "c".repeat(64) });
const SECRET = "SYNTHETIC-BODY-OR-SECRET-MUST-NOT-BE-AN-EVENT";
const AUTH = "synthetic-sync-transport-token-not-a-real-credential";
const prohibited: string[] = [];
function fail(name: string): (...args: any[]) => never {
  return () => { prohibited.push(name); throw new Error("Forbidden sync transport fixture operation: " + name); };
}
function unavailable(name: string, selected: Record<string, unknown> = {}): any {
  return new Proxy({ __esModule: true }, { get: (_target, key) => key === "__esModule" ? true : key === "then" ? undefined
    : typeof key === "symbol" ? undefined : Object.hasOwn(selected, key) ? selected[key] : fail(name + "." + key) });
}
const wireJson = (value: any) => JSON.parse(JSON.stringify(value));
const liveFixtures: Array<{ stop: () => Promise<void> }> = [];

function fixture(options: { sockets?: boolean; mcp?: boolean } = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const modules = new Map<string, any>();
  const windows: any[] = [];
  const invocations: Array<{ channel: string; args: any[] }> = [];
  const cfg = { deviceId: "synthetic-local-device", deviceName: "Synthetic device", team: {
    enabled: true, name: "Synthetic team", ownerDeviceId: "synthetic-remote-owner",
    members: [{ deviceId: "synthetic-local-device", name: "Synthetic member", role: "owner", addedAt: 1 }], updatedAt: 1,
  } };
  const setter = vi.fn((_config: any) => undefined);
  // Explicit profile-detail service boundary only. The original REST adapter
  // and real dirId validator remain under test; no disk/classification claim.
  // Unplanned calls still enter the existing forbidden-operation assertion.
  const profile = {
    meta: vi.fn((_dirId: string): any => fail("unplanned profile metadata read")()),
    syncState: vi.fn((_dirId: string, _meta: unknown): any => fail("unplanned profile sync projection read")()),
    runtime: vi.fn((_dirId: string): any => fail("unplanned profile runtime read")()),
    proxy: vi.fn((_dirId: string): any => fail("unplanned profile proxy read")()),
    activity: vi.fn((_dirId: string): any => fail("unplanned profile activity update")()),
  };
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const nativeServers: nativeHttp.Server[] = [];
  let callback: ((req: any, res: any) => Promise<void>) | undefined;
  let state: any;
  const complete: SyncResult = { success: true, message: "Synthetic operation complete", outcome: "complete", localCommit: "committed", remoteCommit: "committed", operationId: "synthetic-operation", items: [], warnings: [], recovery: [] };
  const service = {
    push: vi.fn(async (_signal?: AbortSignal, _force?: boolean, _token?: SyncComparisonToken): Promise<SyncResult> => structuredClone(complete)),
    pull: vi.fn(async (_signal?: AbortSignal, _opts?: any): Promise<SyncResult> => structuredClone(complete)),
    // Controlled service response, not a replacement for sync:status or REST.
    // The actual operation-state producer supplies the detached nested values.
    getStatus: vi.fn(() => ({ enabled: true, configured: true, endpoint: "https://sync.synthetic.invalid", bucket: "synthetic-bucket",
      accessKeyMasked: "synthetic-***", custodyConsentAt: 1, operation: state.getSyncOperationState() })),
    preview: vi.fn(() => ({ profiles: 1 })),
    previewDiff: vi.fn(async () => ({ ok: true, comparisonToken: structuredClone(TOKEN), profiles: { changed: ["synthetic-profile"] } })),
  };
  const http = {
    createServer: vi.fn((handler: typeof callback) => {
      callback = handler;
      if (options.sockets) {
        const server = nativeHttp.createServer(handler);
        nativeServers.push(server);
        return server;
      }
      const server: any = new EventEmitter();
      server.listen = vi.fn((_port: number, _host: string, ready: () => void) => { ready(); }); // No socket is created.
      server.address = () => ({ port: 1 });
      server.close = (finish: () => void) => finish();
      return server;
    }),
  };
  const context = vm.createContext({ Buffer, URL, structuredClone, console: log,
    process: { platform: "darwin", argv: ["synthetic-node", "synthetic-entry"], uptime: () => 1, env: {
      AGENT_BROWSER_API_TOKEN: AUTH, AGENT_BROWSER_API_PORT: "0", AGENT_BROWSER_MCP_TOKEN: AUTH, AGENT_BROWSER_MCP_PORT: "0",
    } },
    setTimeout: fail("timer"), clearTimeout: fail("timer"), setInterval: fail("interval"), clearInterval: fail("interval"), fetch: fail("network"),
  });
  function load(name: string): any {
    if (modules.has(name)) return modules.get(name).exports;
    const code = COMPILED.get(name);
    if (!code) return fail("unselected module " + name)();
    const module = { exports: {} as any }; modules.set(name, module);
    const full = path.join(MAIN, name);
    function requireFixture(id: string): any {
      if (id === "electron") return {
        ipcMain: { handle: (channel: string, handler: any) => {
          if (handlers.has(channel)) throw new Error("Duplicate IPC handler " + channel);
          handlers.set(channel, handler);
        } },
        BrowserWindow: { getAllWindows: () => windows },
      };
      if (id === "node:http") return http;
      if (id === "node:crypto") return crypto;
      if (id === "node:path") return path;
      if (id.startsWith("node:")) return unavailable(id);
      const relative = path.relative(MAIN, path.resolve(path.dirname(full), id.replace(/\.js$/, ".ts"))).replace(/\\/g, "/");
      if (COMPILED.has(relative)) return load(relative);
      if (relative === "services/sync-service.ts") return { syncService: service };
      if (relative === "services/config-manager.ts") return { getConfig: () => cfg, setSyncConfig: setter, saveConfig: fail("config write"), getProfileMeta: profile.meta, resolveProfileProxy: profile.proxy };
      if (relative === "services/sync/profile-state.ts") return { readProfileSyncState: profile.syncState };
      if (relative === "services/browser-manager.ts") return { statusBrowser: profile.runtime, touchProfileActivity: profile.activity };
      // MCP advertises schemas at module load. No agent/LLM execution is allowed.
      if (relative === "services/local-agent.ts") return unavailable(relative, { AGENT_TOOLS: [] });
      return unavailable(relative);
    }
    vm.runInContext(`(function(require,module,exports,__filename,__dirname) { ${code}\n})`, context, { filename: full })
      (requireFixture, module, module.exports, full, path.dirname(full));
    return module.exports;
  }
  state = load("services/sync/operation-state.ts");
  const events = load("services/event-bus.ts");
  load("ipc/sync.ts").registerSyncHandlers();
  function renderer(opts: { destroyed?: boolean; contentsDestroyed?: boolean } = {}) {
    const incoming = new EventEmitter();
    let api: any;
    const invoke = vi.fn(async (channel: string, ...args: any[]) => {
      invocations.push({ channel, args: structuredClone(args) });
      const handler = handlers.get(channel);
      if (!handler) throw new Error("Unregistered IPC handler " + channel);
      try { return structuredClone(await handler({ sender: "synthetic-renderer" }, ...structuredClone(args))); }
      catch (error: any) {
        // Model Electron's message-only rejection. Never assume custom error
        // properties survive invoke; structured returned results are explicit.
        throw new Error("Error invoking remote method '" + channel + "': " + error.message);
      }
    });
    const ipcRenderer = { invoke,
      on: vi.fn((channel: string, fn: (...args: any[]) => void) => { incoming.on(channel, fn); }),
      removeListener: vi.fn((channel: string, fn: (...args: any[]) => void) => { incoming.removeListener(channel, fn); }),
    };
    const window = {
      isDestroyed: () => opts.destroyed === true,
      webContents: { isDestroyed: () => opts.contentsDestroyed === true,
        send: vi.fn((channel: string, payload: any) => incoming.emit(channel, { sender: "synthetic-main-event" }, structuredClone(payload))),
      },
    };
    windows.push(window);
    vm.runInNewContext(PRELOAD, { require: (name: string) => {
      if (name !== "electron") return fail("preload require " + name)();
      return { contextBridge: { exposeInMainWorld: (name: string, value: any) => {
        expect(name).toBe("agentBrowserAPI"); api = value;
      } }, ipcRenderer };
    } }, { filename: "original-preload.cjs" });
    return { api, ipcRenderer, incoming, window };
  }
  const first = renderer();
  const rest = load("services/rest-api-server.ts");
  const startup = rest.startRestApiServer();
  const restCallback = callback;
  expect(restCallback).toBeTypeOf("function");
  let mcp: any, mcpStartup: { ready: Promise<void> } | undefined, mcpCallback: typeof callback;
  if (options.mcp) {
    mcp = load("services/mcp-server.ts");
    mcpStartup = mcp.startMcpServer();
    mcpCallback = callback;
    expect(mcpCallback).toBeTypeOf("function");
  }
  async function invokeCallback(handler: NonNullable<typeof callback>, ready: Promise<void>, method: string, route: string, body?: any, authorized = true) {
    await ready;
    const req: any = new EventEmitter();
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    req.method = method; req.url = route;
    req.headers = { host: "127.0.0.1", ...(authorized ? { authorization: "Bearer " + AUTH } : {}), ...(encoded ? { "content-length": String(encoded.length) } : {}) };
    req.socket = { remoteAddress: "127.0.0.1" }; req.destroy = fail("request destroy");
    const response = { status: 0, headers: {} as Record<string, unknown>, body: undefined as any };
    const res = {
      setHeader: (key: string, value: unknown) => { response.headers[key.toLowerCase()] = value; },
      writeHead: (status: number, headers: Record<string, unknown> = {}) => { response.status = status; Object.assign(response.headers, headers); },
      end: (body?: string) => { response.body = body ? JSON.parse(body) : undefined; },
    };
    const pending = handler(req, res);
    if (encoded) req.emit("data", encoded);
    req.emit("end"); await pending;
    return response;
  }
  const request = (method: string, route: string, body?: any, authorized = true) =>
    invokeCallback(restCallback!, startup.ready, method, route, body, authorized);
  async function mcpCall(name: string, args?: any) {
    if (!mcpStartup || !mcpCallback) throw new Error("MCP transport was not selected for this fixture");
    return invokeCallback(mcpCallback, mcpStartup.ready, "POST", "/mcp", {
      jsonrpc: "2.0", id: "synthetic-sync-tool-request", method: "tools/call",
      params: { name, ...(args === undefined ? {} : { arguments: args }) },
    });
  }
  async function socketRequest(method: string, route: string, body?: any, token: string | null = AUTH) {
    if (!options.sockets) throw new Error("Native REST sockets were not selected for this fixture");
    await startup.ready;
    // Both listener and client are explicitly confined to this test's own
    // ephemeral loopback port; never discover or contact an installed app.
    const address = nativeServers[0]?.address();
    if (!address || typeof address === "string" || address.port < 1) throw new Error("Owned REST listener did not bind an ephemeral port");
    expect(rest.getRestApiPort()).toBe(address.port);
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = nativeHttp.request({ hostname: "127.0.0.1", port: address.port, method, path: route, agent: false,
        headers: { ...(token === null ? {} : { authorization: "Bearer " + token }),
          ...(encoded ? { "content-type": "application/json", "content-length": String(encoded.length) } : {}) },
      }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) { res.destroy(new Error("Owned REST response exceeded its fixture budget")); return; }
          chunks.push(Buffer.from(chunk));
        });
        res.on("error", reject);
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(3000, () => req.destroy(new Error("Owned REST request timed out")));
      req.on("error", reject);
      req.end(encoded);
    });
  }
  const f = { api: first.api, first, renderer, service, complete, setter, cfg, state, events, request, mcpCall, socketRequest, invocations, handlers, http, log, profile,
    role: (role: string) => { cfg.team.members[0].role = role; }, stop: async () => {
      for (const server of nativeServers) server.closeAllConnections();
      await Promise.all([rest.stopRestApiServer(), ...(mcp ? [mcp.stopMcpServer()] : [])]);
    } };
  liveFixtures.push(f);
  return f;
}

afterEach(async () => { for (const f of liveFixtures.splice(0)) await f.stop(); });
afterAll(() => {
  expect(prohibited).toEqual([]);
  expect(compileCounts.get("services/rest-api-server.ts")).toBe(1);
  expect(compileCounts.get("services/mcp-server.ts")).toBe(1);
});

const RESULTS: Array<{ name: string; status: number; result: SyncResult }> = [
  { name: "complete", status: 200, result: { success: true, message: "Completed synthetic operation", outcome: "complete", localCommit: "committed", remoteCommit: "committed" } },
  { name: "busy", status: 409, result: { success: false, code: "SYNC_BUSY", message: "Synthetic active owner", outcome: "failed", localCommit: "none", remoteCommit: "none" } },
  { name: "stale", status: 409, result: { success: false, code: "SYNC_PREVIEW_STALE", message: "Synthetic changed comparison", outcome: "failed", localCommit: "none", remoteCommit: "none" } },
  { name: "partial-local", status: 409, result: { success: false, code: "SYNC_FAILED", message: "Some local data was committed", outcome: "partial", localCommit: "partial", remoteCommit: "none" } },
  { name: "partial-remote", status: 409, result: { success: false, code: "SYNC_FAILED", message: "Some remote data was committed", outcome: "partial", localCommit: "none", remoteCommit: "partial" } },
  { name: "recovery", status: 409, result: { success: false, code: "EXTENSION_REPOSITORY_RECOVERY_REQUIRED", message: "Synthetic rescue copy retained", outcome: "recovery-required", localCommit: "unknown", remoteCommit: "none" } },
  { name: "viewer-denied", status: 403, result: { success: false, code: "TEAM_ROLE_DENIED", message: "Synthetic viewer refusal", outcome: "failed", localCommit: "none", remoteCommit: "none" } },
];
function detailed(result: SyncResult): SyncResult {
  return { ...result, operationId: "synthetic-receipt-operation", transferredBytes: 123,
    items: [{ side: "local", scope: "preferences", id: "synthetic-profile", state: result.success ? "applied" : "failed", code: result.code, message: "Synthetic item detail", bytes: 7 }],
    warnings: ["Synthetic warning retained"], recovery: [{ resource: "extensions", id: "synthetic-extension", receiptPath: "/synthetic/rescue/receipt.json", paths: ["/synthetic/rescue/package.zip"] }],
  };
}

describe("sync state event bus → BrowserWindow → original preload allowlist", () => {
  it.each(["push", "pull"] as const)("delivers actual %s lifecycle invalidations without result bodies/secrets", kind => {
    const f = fixture(), second = f.renderer(), destroyed = f.renderer({ destroyed: true }), deadContents = f.renderer({ contentsDestroyed: true });
    const received = vi.fn(), other = vi.fn(), raw = vi.fn();
    f.api.on("sync:state-changed", received); second.api.on("sync:state-changed", other);
    const unsubscribe = f.events.onEvent("sync:state-changed", raw);
    const lease = f.state.beginSyncOperation(kind);
    expect(lease.busy).toBeUndefined();
    lease.finish({ ...detailed(RESULTS[5].result), message: SECRET, warnings: [SECRET],
      recovery: [{ resource: "profiles", id: SECRET, paths: [SECRET], receiptPath: SECRET }],
      items: [{ scope: "config", state: "applied", message: SECRET }], body: { password: SECRET, cookies: [SECRET], preferences: SECRET },
    });
    expect(received).toHaveBeenCalledTimes(2); expect(other).toHaveBeenCalledTimes(2); expect(raw).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      const payload = received.mock.calls[i][0];
      expect(received.mock.calls[i]).toHaveLength(1); // Preload strips the IPC event object.
      expect(payload).toEqual(raw.mock.calls[i][0]); expect(payload).not.toBe(raw.mock.calls[i][0]);
      expect(other.mock.calls[i][0]).toEqual(payload); expect(other.mock.calls[i][0]).not.toBe(payload);
      expect(payload.kind).toBe(kind); expect(payload.phase).toBe(i ? "completed" : "started");
      expect(Object.keys(payload).sort()).toEqual(["generation", "kind", "operationId", "phase", ...(i ? ["result"] : []), "scopes"].sort());
      expect(JSON.stringify(payload)).not.toContain(SECRET);
      expect(payload).not.toHaveProperty("items"); expect(payload).not.toHaveProperty("body");
    }
    const terminal = received.mock.calls[1][0];
    expect(terminal.generation).toBeGreaterThan(received.mock.calls[0][0].generation);
    expect(terminal.operationId).toBe(received.mock.calls[0][0].operationId);
    expect(terminal.scopes).toContain("accounts");
    expect(terminal.result).toEqual({ success: false, outcome: "recovery-required", localCommit: "unknown", remoteCommit: "none", code: "EXTENSION_REPOSITORY_RECOVERY_REQUIRED" });
    expect(destroyed.window.webContents.send).not.toHaveBeenCalled(); expect(deadContents.window.webContents.send).not.toHaveBeenCalled();
    unsubscribe();
  });
  it("the new channel is allowlisted, unlisted channels stay blocked, and removeListener detaches the wrapper", () => {
    const f = fixture(), received = vi.fn(), rejected = vi.fn();
    f.api.on("sync:state-changed", received); f.api.on("sync:unlisted-body", rejected);
    expect(f.first.ipcRenderer.on).toHaveBeenCalledTimes(1);
    f.state.invalidateSyncSettings(); expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0][0]).toMatchObject({ kind: "configure", phase: "completed", scopes: ["profiles", "accounts", "sync", "team"] });
    f.api.removeListener("sync:state-changed", received); f.state.invalidateSyncSettings();
    expect(received).toHaveBeenCalledTimes(1); expect(rejected).not.toHaveBeenCalled();
    expect(f.first.incoming.listenerCount("sync:state-changed")).toBe(0);
  });
});

for (const transport of ["ipc", "rest"] as const) describe(`${transport}: original sync adapter option/status/result transport`, () => {
  for (const kind of ["push", "pull"] as const) {
    it(`${kind} forwards the preview comparisonToken unchanged through the original adapter`, async () => {
      const f = fixture();
      const preview = transport === "ipc" ? await f.api.sync.previewDiff() : (await f.request("GET", "/api/sync/preview-diff")).body;
      const token = preview.comparisonToken;
      expect(token).toEqual(TOKEN);
      const opts = kind === "push" ? { force: true, comparisonToken: token }
        : { strategy: "newest", resolutions: { "profiles:a": "remote", "accounts:b": "local", "proxies:c": "newest", invalid: "discard" }, comparisonToken: token };
      const before = structuredClone(opts);
      if (transport === "ipc") await f.api.sync[kind](opts); else expect((await f.request("POST", "/api/sync/" + kind, opts)).status).toBe(200);
      expect(f.service[kind]).toHaveBeenCalledTimes(1);
      if (kind === "push") expect(f.service.push).toHaveBeenCalledWith(undefined, true, TOKEN);
      else expect(f.service.pull).toHaveBeenCalledWith(undefined, { strategy: "newest", resolutions: { "profiles:a": "remote", "accounts:b": "local", "proxies:c": "newest" }, comparisonToken: TOKEN });
      expect(opts).toEqual(before);
      const seen = kind === "push" ? f.service.push.mock.calls[0][2] : f.service.pull.mock.calls[0][1].comparisonToken;
      expect(seen).toEqual(token); expect(seen).not.toBe(token);
      if (transport === "ipc") expect(f.invocations.at(-1)).toEqual({ channel: "sync:" + kind, args: [before] });
    });
  }
  it("passes explicit history scope unchanged and refuses truthy coercion before calling the service", async () => {
    const f = fixture();
    for (const history of [true, false]) {
      if (transport === "ipc") { await f.api.sync.push({ history }); await f.api.sync.pull({ history }); }
      else { await f.request("POST", "/api/sync/push", { history }); await f.request("POST", "/api/sync/pull", { history }); }
      expect(f.service.push).toHaveBeenLastCalledWith(undefined, false, undefined, { history });
      expect(f.service.pull).toHaveBeenLastCalledWith(undefined, { strategy: undefined, resolutions: {}, comparisonToken: undefined, history });
    }
    const count = f.service.push.mock.calls.length;
    if (transport === "ipc") expect(await f.api.sync.push({ history: "true" })).toMatchObject({ success: false, code: "INVALID_HISTORY_SCOPE" });
    else expect((await f.request("POST", "/api/sync/push", { history: "true" })).status).toBe(400);
    expect(f.service.push).toHaveBeenCalledTimes(count);
  });
  it("keeps optional tokens absent and strategy/force defaults intact", async () => {
    const f = fixture();
    if (transport === "ipc") { await f.api.sync.push(); await f.api.sync.pull({ strategy: "invalid" }); }
    else { await f.request("POST", "/api/sync/push"); await f.request("POST", "/api/sync/pull", { strategy: "invalid" }); }
    expect(f.service.push).toHaveBeenCalledWith(undefined, false, undefined);
    expect(f.service.pull).toHaveBeenCalledWith(undefined, { strategy: "local", resolutions: {}, comparisonToken: undefined });
  });
  it("passes detached active/last status facts without stripping nested receipts", async () => {
    const f = fixture(), previous = f.state.beginSyncOperation("push");
    previous.finish(detailed(RESULTS[5].result));
    const active = f.state.beginSyncOperation("pull"); active.stage("applying");
    const before = f.state.getSyncOperationState();
    const read = async () => transport === "ipc" ? f.api.sync.status() : (await f.request("GET", "/api/sync/status")).body;
    const status = await read();
    expect(status.operation).toEqual(before); expect(status.operation.active.kind).toBe("pull");
    expect(status.operation.last).toEqual(detailed(RESULTS[5].result));
    status.operation.active.stage = "poison"; status.operation.last.items[0].message = "poison";
    status.operation.last.warnings.push("poison"); status.operation.last.recovery[0].paths.length = 0;
    expect(f.state.getSyncOperationState()).toEqual(before); expect((await read()).operation).toEqual(before);
    active.finish(active.operation.complete("Synthetic active operation finished"));
  });
  for (const kind of ["push", "pull"] as const) for (const entry of RESULTS) {
    it(`${kind} preserves the complete ${entry.name} result${transport === "rest" ? " and HTTP " + entry.status : " through preload/IPC"}`, async () => {
      const f = fixture(), result = detailed(entry.result); f.service[kind].mockResolvedValueOnce(result);
      if (transport === "ipc") {
        const body = await f.api.sync[kind]({ strategy: "remote" });
        expect(body).toEqual(result); expect(body).not.toBe(result);
        body.items[0].message = "renderer changed"; body.recovery[0].paths.length = 0;
        expect(result.items![0].message).toBe("Synthetic item detail"); expect(result.recovery![0].paths).toHaveLength(1);
      } else {
        const response = await f.request("POST", "/api/sync/" + kind, { strategy: "remote" });
        expect(response.status).toBe(entry.status);
        expect(response.body).toEqual(wireJson(kind === "pull" ? { ...result, strategy: "remote" } : result));
      }
    });
  }
});

for (const transport of ["ipc", "rest", "mcp"] as const) describe(`${transport}: Pull strategy ownership stays in SyncService`, () => {
  async function pull(f: ReturnType<typeof fixture>, opts?: any) {
    if (transport === "ipc") return f.api.sync.pull(opts);
    if (transport === "rest") {
      const response = await f.request("POST", "/api/sync/pull", opts);
      expect(response.status).toBe(200);
      return response.body;
    }
    // Enter the public JSON-RPC HTTP route, not a private executeMcpTool export.
    const response = await f.mcpCall("agent_browser_sync_pull", opts);
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("error");
    expect(response.body.result.isError).not.toBe(true);
    return JSON.parse(response.body.result.content[0].text);
  }
  it.each([
    { label: "omitted options", opts: undefined },
    { label: "empty options", opts: {} },
    { label: "undefined strategy", opts: { strategy: undefined } },
  ])("defers an unspecified Pull strategy to the service ($label)", async ({ opts }) => {
    const f = fixture({ mcp: transport === "mcp" }), before = structuredClone(opts);
    const result = await pull(f, opts);
    expect(f.service.pull).toHaveBeenCalledExactlyOnceWith(undefined, { strategy: undefined, resolutions: {}, comparisonToken: undefined });
    expect(f.service.pull.mock.calls[0][1].strategy).toBeUndefined();
    expect(f.service.push).not.toHaveBeenCalled();
    expect(opts).toEqual(before);
    expect(result).toMatchObject(f.complete);
    if (transport === "rest") expect(result).not.toHaveProperty("strategy");
  });
  it.each(["local", "remote", "newest"] as const)("preserves explicit %s Pull strategy, decisions, token and history without scope inference", async strategy => {
    const f = fixture({ mcp: transport === "mcp" });
    const opts = { strategy, comparisonToken: TOKEN, history: true,
      resolutions: { "profiles:synthetic-profile": "remote", "proxies:synthetic-proxy": "local", "accounts:synthetic-account": "newest", invalid: "discard" } };
    const before = structuredClone(opts);
    const result = await pull(f, opts);
    expect(f.service.pull).toHaveBeenCalledExactlyOnceWith(undefined, { strategy, comparisonToken: TOKEN, history: true,
      resolutions: { "profiles:synthetic-profile": "remote", "proxies:synthetic-proxy": "local", "accounts:synthetic-account": "newest" } });
    expect(f.service.pull.mock.calls[0][1].comparisonToken).not.toBe(TOKEN);
    expect(f.service.push).not.toHaveBeenCalled();
    expect(opts).toEqual(before);
    expect(result).toMatchObject(f.complete);
    if (transport === "rest") expect(result.strategy).toBe(strategy);
  });
});

describe("MCP public sync tool argument transport", () => {
  it("keeps push force, comparison token and history intact while leaving omitted push options absent", async () => {
    const f = fixture({ mcp: true }), opts = { force: true, comparisonToken: TOKEN, history: false }, before = structuredClone(opts);
    const response = await f.mcpCall("agent_browser_sync_push", opts);
    expect(response.status).toBe(200); expect(response.body).not.toHaveProperty("error");
    expect(JSON.parse(response.body.result.content[0].text)).toEqual(f.complete);
    expect(f.service.push).toHaveBeenCalledExactlyOnceWith(undefined, true, TOKEN, { history: false });
    expect(f.service.push.mock.calls[0][2]).not.toBe(TOKEN); expect(opts).toEqual(before);
    const omitted = await f.mcpCall("agent_browser_sync_push");
    expect(omitted.status).toBe(200); expect(omitted.body).not.toHaveProperty("error");
    expect(f.service.push).toHaveBeenCalledTimes(2);
    expect(f.service.push).toHaveBeenLastCalledWith(undefined, false, undefined);
    expect(f.service.pull).not.toHaveBeenCalled();
  });
});

describe("REST Pull strategy through an owned real loopback socket", () => {
  it("keeps health public, rejects missing/wrong auth, accepts valid auth and preserves omitted versus explicit local Pull strategy", async () => {
    const f = fixture({ sockets: true });
    const health = await f.socketRequest("GET", "/health", undefined, null);
    expect(health.status).toBe(200); expect(health.body.status).toBe("ok");
    expect(f.service.pull).not.toHaveBeenCalled();
    const missing = await f.socketRequest("POST", "/api/sync/pull", {}, null);
    expect(missing).toEqual({ status: 401, body: { error: "Unauthorized" } });
    expect(f.service.pull).not.toHaveBeenCalled();
    const wrong = await f.socketRequest("POST", "/api/sync/pull", {}, AUTH + "-wrong");
    expect(wrong).toEqual({ status: 401, body: { error: "Unauthorized" } });
    expect(f.service.pull).not.toHaveBeenCalled();
    const status = await f.socketRequest("GET", "/api/sync/status");
    expect(status.status).toBe(200); expect(status.body).toMatchObject({ enabled: true, configured: true });
    const defaultOpts = { comparisonToken: TOKEN, history: true, resolutions: { "profiles:synthetic-profile": "remote" } };
    const localOpts = { ...defaultOpts, strategy: "local" };
    const defaultReply = await f.socketRequest("POST", "/api/sync/pull", defaultOpts);
    const localReply = await f.socketRequest("POST", "/api/sync/pull", localOpts);
    expect(defaultReply.status).toBe(200); expect(localReply.status).toBe(200);
    expect(f.service.pull).toHaveBeenCalledTimes(2);
    expect(f.service.pull).toHaveBeenLastCalledWith(undefined, localOpts);
    expect(localReply.body).toEqual(wireJson({ ...f.complete, strategy: "local" }));
    expect(f.service.push).not.toHaveBeenCalled();
    expect(f.http.createServer).toHaveBeenCalledTimes(1);
    expect(f.service.pull.mock.calls[0]).toEqual([undefined, { ...defaultOpts, strategy: undefined }]);
    expect(f.service.pull.mock.calls[0][1].strategy).toBeUndefined();
    expect(f.service.pull.mock.calls[0][1].comparisonToken).not.toBe(TOKEN);
    expect(defaultReply.body).toEqual(wireJson(f.complete));
  });
});

describe("REST scope-sensitive sync schema", () => {
  it("leaves the optional Pull strategy unset in the public schema and documents both saved scope defaults", async () => {
    const f = fixture();
    const response = await f.request("GET", "/openapi.json", undefined, false);
    expect(response.status).toBe(200);
    const strategy = response.body.paths["/api/sync/pull"].post.requestBody.content["application/json"].schema.properties.strategy;
    expect(strategy.type).toBe("string");
    expect(strategy.enum).toEqual(["local", "remote", "newest"]);
    expect(strategy).not.toHaveProperty("default");
    expect(strategy.description).toMatch(/local.*limited/i);
    expect(strategy.description).toMatch(/remote.*(full|complete)/i);
    expect(f.service.pull).not.toHaveBeenCalled();
    expect(f.service.push).not.toHaveBeenCalled();
  });
});

describe("REST structured error receipts (original HTTP callback, no socket)", () => {
  for (const kind of ["push", "pull"] as const) for (const name of ["partial-local", "recovery"]) {
    it(`${kind} preserves a thrown ${name} syncResult body with 409`, async () => {
      const f = fixture(), result = detailed(RESULTS.find(entry => entry.name === name)!.result);
      f.service[kind].mockRejectedValueOnce(Object.assign(new Error("Synthetic service failure with receipt"), { syncResult: result }));
      const response = await f.request("POST", "/api/sync/" + kind, { strategy: "remote" });
      expect(response.status).toBe(409); expect(response.body).toEqual(wireJson(result));
    });
  }
});

describe("REST profile detail shared projection (controlled helper boundary, not disk/classification proof)", () => {
  const states = [
    { syncStatus: "synced", syncReason: "baseline-match", syncedAt: 0 },
    { syncStatus: "dirty", syncReason: "content-changed", syncedAt: 1000 },
    { syncStatus: "never", syncReason: "no-baseline", syncedAt: null },
    { syncStatus: "unknown", syncReason: "legacy-marker", syncedAt: 900 },
    { syncStatus: "unknown", syncReason: "invalid-baseline", syncedAt: null },
    { syncStatus: "unknown", syncReason: "target-mismatch", syncedAt: 800 },
    { syncStatus: "unknown", syncReason: "target-unavailable", syncedAt: 700 },
    { syncStatus: "unknown", syncReason: "preferences-unavailable", syncedAt: 600 },
    { syncStatus: "unknown", syncReason: "content-unavailable", syncedAt: null },
  ] as const;
  it.each(states)("GET detail retains $syncStatus / $syncReason and the helper timestamp", async state => {
    const f = fixture(), dirId = "synthetic_detail_profile";
    const meta = { name: "Synthetic detail metadata", note: "Keep saved metadata", tags: ["synthetic"],
      // Deliberately poisoned legacy/meta fields must never override the
      // shared projection. The real classifier is covered elsewhere.
      syncStatus: "forged-status", syncScope: "all-browser-data", syncReason: "forged-reason", syncedAt: 9999,
    };
    const before = structuredClone(meta);
    const projection = Object.freeze({ ...state, syncScope: "portable-profile+preferences" });
    f.profile.meta.mockReturnValueOnce(meta);
    f.profile.syncState.mockReturnValueOnce(projection);
    f.profile.runtime.mockReturnValueOnce({ running: true, pid: 246, cdpPort: 44001 });
    f.profile.proxy.mockReturnValueOnce({ mode: "none", name: null, config: null });
    f.profile.activity.mockImplementationOnce(() => undefined);
    const response = await f.request("GET", "/api/profiles/" + dirId);
    expect(response.status).toBe(200);
    expect(f.profile.meta).toHaveBeenCalledExactlyOnceWith(dirId);
    expect(f.profile.syncState).toHaveBeenCalledExactlyOnceWith(dirId, meta);
    expect(f.profile.syncState.mock.calls[0][1]).toBe(meta);
    expect(f.profile.runtime).toHaveBeenCalledExactlyOnceWith(dirId);
    expect(f.profile.proxy).toHaveBeenCalledExactlyOnceWith(dirId);
    expect(f.profile.activity).toHaveBeenCalledExactlyOnceWith(dirId);
    expect(response.body).toEqual({ ...meta, ...projection, dirId, running: true, pid: 246, cdpPort: 44001,
      proxyMode: "none", proxyName: null, proxy: null });
    expect(response.body.syncedAt).toBe(state.syncedAt); // In particular, zero is not null.
    expect(meta).toEqual(before);
  });
  it("GET missing detail returns 404 without invoking the shared projection or runtime/proxy reads", async () => {
    const f = fixture(), dirId = "synthetic_missing_detail";
    f.profile.meta.mockReturnValueOnce(null);
    f.profile.activity.mockImplementationOnce(() => undefined);
    const response = await f.request("GET", "/api/profiles/" + dirId);
    expect(response.status).toBe(404); expect(response.body).toEqual({ error: "Profile not found" });
    expect(f.profile.meta).toHaveBeenCalledExactlyOnceWith(dirId);
    expect(f.profile.syncState).not.toHaveBeenCalled(); expect(f.profile.runtime).not.toHaveBeenCalled(); expect(f.profile.proxy).not.toHaveBeenCalled();
  });
});

describe("configure permission and result translation via original preload/registered IPC", () => {
  const settings = { enabled: true, endpoint: "https://configured.synthetic.invalid", bucket: "synthetic-bucket", accessKey: "synthetic-access-only", secretKey: "synthetic-secret-only", custodyConsent: true,
    includeFullProfile: true, fullProfileConsent: true, fullProfilePassphrase: "synthetic migration phrase" };
  it("a real synthetic viewer role is refused before calling the config setter", async () => {
    const f = fixture(); f.role("viewer");
    const result = await f.api.sync.configure(settings);
    expect(result).toEqual({ success: false, code: "TEAM_ROLE_DENIED", error: "requires member role (current: viewer)" });
    expect(f.setter).not.toHaveBeenCalled();
  });
  it("a permitted configure forwards the complete options and returns success", async () => {
    const f = fixture(); f.role("member");
    expect(await f.api.sync.configure(settings)).toEqual({ success: true });
    expect(f.setter).toHaveBeenCalledExactlyOnceWith(settings); expect(f.setter.mock.calls[0][0]).not.toBe(settings);
    expect(f.invocations.at(-1)).toEqual({ channel: "sync:configure", args: [settings] });
  });
  it("preserves full-migration failure codes through original IPC instead of relying on invoke exceptions", async () => {
    const f = fixture(); f.setter.mockImplementationOnce(() => { throw Object.assign(new Error("Synthetic full-scope consent refusal"), { code: "FULL_PROFILE_CONSENT_REQUIRED" }); });
    expect(await f.api.sync.configure(settings)).toEqual({ success: false, code: "FULL_PROFILE_CONSENT_REQUIRED", error: "Synthetic full-scope consent refusal" });
  });
  it("keeps public health, REST auth and viewer settings gates ahead of full-migration configure", async () => {
    const f = fixture();
    expect((await f.request("GET", "/health", undefined, false)).status).toBe(200);
    expect((await f.request("POST", "/api/sync/config", settings, false)).status).toBe(401); expect(f.setter).not.toHaveBeenCalled();
    f.role("viewer"); expect((await f.request("POST", "/api/sync/config", settings)).status).toBe(403); expect(f.setter).not.toHaveBeenCalled();
    f.role("member"); const saved = await f.request("POST", "/api/sync/config", settings);
    expect(saved.status).toBe(200); expect(f.setter).toHaveBeenCalledExactlyOnceWith(settings);
    expect(saved.body).not.toHaveProperty("fullProfilePassphrase");
  });
  it("setter failure returns a structured failure instead of a false success or rejected invoke", async () => {
    const f = fixture(); f.setter.mockImplementationOnce(() => { throw new Error("Synthetic configuration validation failure"); });
    await expect(f.api.sync.configure(settings)).resolves.toEqual({ success: false, error: "Synthetic configuration validation failure" });
    expect(f.setter).toHaveBeenCalledExactlyOnceWith(settings);
  });
});
