// Real server imports and loopback sockets; only native/external/LLM boundaries
// are controlled. Config/accounts/conversations/team/skills/SQLite remain real.
import { vi, expect } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const state = vi.hoisted(() => {
  const prohibited: string[] = [];
  const fail = (name: string) => vi.fn(() => {
    prohibited.push(name);
    throw new Error(`Forbidden fixture capability: ${name}`);
  });
  return {
    dir: "", prohibited, ports: new Set<number>(), network: fail("unapproved network access"),
    chat: fail("unconfigured agentChat"), simpleChat: fail("unconfigured llmChat"),
    tool: vi.fn(), detectConfig: null as any,
    browser: {
      listBrowserProfiles: vi.fn(() => [] as any[]),
      launchBrowser: fail("native browser launch"),
      stopBrowser: vi.fn(() => false), statusBrowser: vi.fn(() => ({ running: false } as any)),
      checkFingerprintDrift: fail("unconfigured fingerprint probe"),
      createBrowserProfile: fail("unconfigured profile creation"), deleteBrowserProfile: vi.fn(() => false),
      getEngineStatusAsync: vi.fn(async () => ({ chromium: { installed: false }, firefox: { installed: false } })),
      getRuntimeChromiumStatusAsync: vi.fn(async () => ({ path: null, version: null })),
      getProfileRuntimeSnapshot: vi.fn(() => ({ chromiumPath: null, chromiumVersion: null, pending: false })),
      touchProfileActivity: vi.fn(), listRunningProfileIdle: vi.fn(() => []), getIdlePolicyTimeoutMs: vi.fn(() => 0),
    },
    extensions: {
      listExtensionRepository: vi.fn(() => [] as any[]),
      addOrUpdateChromeStoreExtension: fail("extension download"),
      installLocalExtension: fail("unconfigured local extension installation"),
      updateRepositoryExtension: fail("extension update/download"),
      deleteRepositoryExtension: vi.fn(() => false),
      setRepositoryExtensionMeta: fail("unconfigured extension metadata"),
      getRepositoryExtension: vi.fn(() => null as any),
    },
    archive: {
      exportProfileArchive: fail("unconfigured archive export"), importProfileArchive: fail("unconfigured archive import"),
      exportProfileArchives: fail("unconfigured batch archive export"), importProfileArchives: fail("unconfigured batch archive import"),
    },
    paths: {
      assertSafeArchiveExportDir: vi.fn((v: string) => v), assertSafeArchiveExportPath: vi.fn((v: string) => v),
      assertSafeArchiveImportPath: vi.fn((v: string) => v),
    },
    sync: {
      getStatus: vi.fn(() => ({ configured: false } as any)), preview: vi.fn(() => ({ profiles: 0 } as any)),
      previewDiff: fail("unconfigured sync comparison"), push: fail("unconfigured sync push"), pull: fail("unconfigured sync pull"), historyState: fail("unconfigured history state"),
    },
    automation: {
      retryAgentRun: fail("unconfigured run retry"), retryJobRuns: fail("unconfigured job retry"),
      testRunRule: fail("unconfigured automation execution"), reloadSchedule: vi.fn(), cancelRunningJob: vi.fn(),
    },
    updates: {
      checkForUpdates: fail("update network"), installRelease: fail("update download"),
      activateVersion: fail("unconfigured update activation"), rollback: fail("unconfigured rollback"),
      getUpdateState: vi.fn(() => ({ releases: [] })), getCurrentVersion: vi.fn(() => "fixture-version"),
      assertSafeManifestUrl: fail("manifest URL network validation"),
    },
    drm: {
      getDrmStatus: vi.fn(() => ({ available: false })), setProfileDrm: fail("unconfigured DRM mutation"),
      ensureManagedCdm: fail("native DRM staging"),
    },
    environment: {
      summarizeEnvFindings: vi.fn((findings: any[]) => findings.map(f => f.message).join("; ")),
      checkEnvironmentRisk: vi.fn(() => ({ level: "unknown", items: [] } as any)),
      checkEnvironmentRiskRuntime: fail("unconfigured runtime environment probe"),
    },
    spawn: fail("subprocess/Keychain"), osSecrets: fail("OS credential store"),
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => state.dir, getVersion: () => "fixture-version", isPackaged: false },
  safeStorage: { isEncryptionAvailable: state.osSecrets, encryptString: state.osSecrets, decryptString: state.osSecrets },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: state.spawn }, dialog: { showOpenDialog: state.spawn },
}));
vi.mock("node:child_process", () => ({
  spawn: state.spawn, spawnSync: state.spawn, exec: state.spawn, execSync: state.spawn, execFile: state.spawn, execFileSync: state.spawn,
}));
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  const scoped = (fn: (...args: any[]) => any) => (...args: any[]) => {
    const target = typeof args[0] === "string" || args[0] instanceof URL ? new URL(args[0]) : args[0];
    const host = target?.hostname || target?.host;
    if (host !== "127.0.0.1" || !state.ports.has(Number(target?.port))) return state.network();
    return fn(...args);
  };
  return { ...actual, request: scoped(actual.request), get: scoped(actual.get) };
});
vi.mock("node:https", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:https")>(), request: state.network, get: state.network,
}));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:dns/promises")>(), lookup: state.network, resolve: state.network, resolve4: state.network, resolve6: state.network,
}));
vi.mock("../../src/main/services/browser-manager.js", () => state.browser);
vi.mock("../../src/main/services/extension-repository.js", () => state.extensions);
vi.mock("../../src/main/services/profile-archive.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/profile-archive.js")>(), ...state.archive,
}));
vi.mock("../../src/main/services/archive-path-guard.js", () => state.paths);
vi.mock("../../src/main/services/sync-service.js", () => ({ syncService: state.sync }));
vi.mock("../../src/main/services/automation.js", () => state.automation);
vi.mock("../../src/main/services/update-manager.js", () => state.updates);
vi.mock("../../src/main/services/drm.js", () => state.drm);
vi.mock("../../src/main/services/environment-risk.js", () => state.environment);
vi.mock("../../src/main/services/page-eval.js", () => ({ getProfileEngineByDirId: () => "chromium" }));
vi.mock("../../src/main/services/local-agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/services/local-agent.js")>();
  return {
    ...actual, agentChat: state.chat, llmChat: state.simpleChat,
    getOrDetectLlmConfig: () => state.detectConfig,
    executeToolCall: (...args: Parameters<typeof actual.executeToolCall>) =>
      state.tool.getMockImplementation() ? state.tool(...args) : actual.executeToolCall(...args),
  };
});

export const h = state;

export interface SocketReply { status: number; headers: http.IncomingHttpHeaders; body: any; text: string; }
export function request(port: number, route: string, options: {
  method?: string; body?: unknown; raw?: string; token?: string | null; headers?: Record<string, string>;
} = {}): Promise<SocketReply> {
  const raw = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: route, method: options.method || (raw === undefined ? "GET" : "POST"), agent: false,
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(raw === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }),
        ...options.headers,
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(Buffer.from(c)));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: any;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        resolve({ status: res.statusCode!, headers: res.headers, text, body });
      });
    });
    req.setTimeout(1500, () => req.destroy(new Error("Fixture HTTP response timed out")));
    req.on("error", reject);
    req.end(raw);
  });
}

// No request-listener extraction: incomplete/chunked messages travel through
// actual TCP. The bounded local deadline prevents an old handler's rejection
// from stalling a RED run until Vitest's ordinary timeout.
export async function rawRequest(port: number, bytes: string | Buffer, disconnect = false): Promise<string> {
  if (!state.ports.has(port)) return state.network();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => { if (!settled) { settled = true; socket.destroy(); resolve(Buffer.concat(chunks).toString("utf8")); } };
    socket.setTimeout(500, finish);
    socket.on("data", data => chunks.push(data));
    socket.on("error", error => { if (disconnect || (error as NodeJS.ErrnoException).code === "ECONNRESET") finish(); else reject(error); });
    socket.on("end", finish); socket.on("close", finish);
    socket.on("connect", () => { socket.write(bytes, () => { if (disconnect) socket.destroy(); }); });
  });
}

export async function startFixture(which: "rest" | "mcp" | "both" = "both") {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "rest-mcp-task48-"));
  vi.stubEnv("AGENT_BROWSER_API_PORT", "0"); vi.stubEnv("AGENT_BROWSER_MCP_PORT", "0");
  vi.stubEnv("AGENT_BROWSER_API_TOKEN", "task48-synthetic-rest-token");
  vi.stubEnv("AGENT_BROWSER_MCP_TOKEN", "task48-synthetic-mcp-token");
  vi.stubEnv("AGENT_BROWSER_SECRET_BACKEND", "file");
  const secrets = await import("../../src/main/services/secrets.js");
  secrets.initializeSecretStorage(secrets.planSecretStorage({ userDataDir: state.dir, environment: { AGENT_BROWSER_SECRET_BACKEND: "file" } }));
  const config = await import("../../src/main/services/config-manager.js");
  config.getConfig();
  const store = await import("../../src/main/services/config/store.js");
  const agent = await import("../../src/main/services/local-agent.js");
  const db = await import("../../src/main/services/agent-db.js");
  const jobs = await import("../../src/main/services/job-store.js");
  const team = await import("../../src/main/services/team.js");
  const approvals = await import("../../src/main/services/approval-gate.js");
  const runs = (await import("../../src/main/services/agent-run-trace.js")).agentRunRecorder;
  const skills = await import("../../src/main/services/skill-repository.js");
  const rest = which === "mcp" ? undefined : await import("../../src/main/services/rest-api-server.js");
  const mcp = which === "rest" ? undefined : await import("../../src/main/services/mcp-server.js");
  await rest?.startRestApiServer().ready; await mcp?.startMcpServer().ready;
  const restPort = rest?.getRestApiPort() || 0, mcpPort = mcp?.getMcpPort() || 0;
  if (rest) { expect(restPort).toBeGreaterThan(0); state.ports.add(restPort); }
  if (mcp) { expect(mcpPort).toBeGreaterThan(0); state.ports.add(mcpPort); }
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(state.network);
  const api = (route: string, options: Parameters<typeof request>[2] = {}) => request(restPort, route, { token: rest!.getRestApiToken(), ...options });
  let id = 0;
  const rpc = (method: string, params?: unknown, route = "/mcp") => request(mcpPort, route, {
    token: mcp!.getMcpToken(), body: { jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) },
  });
  const call = async (name: string, args: unknown = {}) => {
    const reply = await rpc("tools/call", { name, arguments: args });
    return { ...reply, payload: reply.body?.result?.content?.[0]?.text === undefined ? undefined : JSON.parse(reply.body.result.content[0].text) };
  };
  function role(value: "owner" | "admin" | "member" | "viewer", enabled = true) {
    store.transact((draft: any) => { draft.team = {
      workspaceId: "task48-synthetic-team", name: "Synthetic team", ownerDeviceId: value === "owner" ? draft.deviceId : "synthetic-owner",
      createdAt: 1, updatedAt: 1, enabled,
      members: [{ deviceId: draft.deviceId, name: "Synthetic device", role: value, addedAt: 1 }],
    }; });
  }
  return { dir: state.dir, config, store, agent, db, jobs, team, approvals, runs, skills, rest, mcp, restPort, mcpPort, api, rpc, call, role,
    disk: () => JSON.parse(fs.readFileSync(config.getConfigPath(), "utf8")),
    bytes: () => fs.readFileSync(config.getConfigPath()),
    async close() {
      approvals.clearApprovalMemory();
      await rest?.stopRestApiServer(); await mcp?.stopMcpServer();
      db.closeAgentDb(); jobs.closeJobDb(); secrets.resetSecretStorageForTests(); fetchSpy.mockRestore(); state.ports.clear(); vi.unstubAllEnvs();
      expect(state.prohibited).toEqual([]);
    },
  };
}
