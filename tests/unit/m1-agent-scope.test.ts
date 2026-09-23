import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

const mocks = vi.hoisted(() => ({
  profiles: [] as Array<{ dirId: string; name: string; running: boolean; cdpPort: number; fingerprintSeed: number; engine: "chromium" | "firefox" }>,
  diskProfiles: [] as any[],
  accounts: [] as any[],
}));

vi.mock("electron", () => ({
  app: { getPath: () => process.env.M1_AGENT_TEST_DATA || `/tmp/m1-agent-scope-test-${process.pid}` },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => process.env.M1_AGENT_TEST_DATA || `/tmp/m1-agent-scope-test-${process.pid}`,
  getConfig: () => ({ accounts: mocks.accounts, agentFs: { mode: "sandbox", allowlist: [] }, automation: [], browserProfiles: {} }),
  saveConfig: vi.fn(),
  getProfileMeta: (dirId: string) => {
    const profile = mocks.profiles.find((candidate) => candidate.dirId === dirId);
    return profile ? { name: profile.name, engine: profile.engine } : null;
  },
}));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  launchBrowser: vi.fn(),
  listBrowserProfiles: () => mocks.profiles,
  touchProfileActivityByPort: vi.fn(),
  createBrowserProfile: vi.fn(),
  getEngineByPort: () => "chromium" as const,
  getFirefoxBidiSessionByPort: () => null,
}));
vi.mock("../../src/main/services/profile-manager.js", () => ({ listProfiles: vi.fn(async () => mocks.diskProfiles) }));
vi.mock("../../src/main/services/skill-repository.js", () => ({ BUILTIN_SKILLS: [], getEnabledSkillPrompts: () => [] }));
vi.mock("../../src/main/services/agent-run-trace.js", () => ({
  agentRunRecorder: { setVar: vi.fn(), getVar: vi.fn(), recordStep: vi.fn() },
}));
vi.mock("../../src/main/services/agent-db.js", () => ({
  agentDbQuery: vi.fn(() => ({ rows: [], count: 0, truncated: false })),
  agentDbExec: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
}));
vi.mock("../../src/main/services/approval-gate.js", () => ({
  requestApproval: vi.fn(),
  classifyDbSql: () => ({ category: "db-write", signature: "test" }),
}));
vi.mock("../../src/main/services/task-templates.js", () => ({ renderTemplateCatalog: () => "" }));
vi.mock("../../src/main/services/platform-adapters.js", () => ({ renderAdapterCatalog: () => "" }));

import {
  AGENT_TOOLS,
  addMessage,
  agentChat,
  buildAgentSystemPrompt,
  cdpGetRequests,
  createConversation,
  executeToolCall,
  getConversation,
} from "../../src/main/services/local-agent.js";
import { cdpSendRaw, cdpWaitForLoad, type CdpClient } from "../../src/main/services/agent/cdp-transport.js";
import {
  assertChatBrowserScopePort,
  captureChatBrowserScope,
  filterChatTools,
  type ChatBrowserScope,
} from "../../src/main/services/agent/run-scope.js";
import { runWithProtocolDispatchGuard } from "../../src/main/services/agent/dispatch-guard.js";
import { runningProcesses, type RunningEntry } from "../../src/main/services/browser/runtime-table.js";

const CONNECT_METHODS = new Set([
  "Page.enable",
  "Runtime.enable",
  "Network.enable",
  "DOM.enable",
  "Input.enable",
  "Emulation.enable",
]);

type WireCall = { method: string; params?: Record<string, any> };

type MockCdp = {
  port: number;
  calls: WireCall[];
  readonly connectionCount: number;
  metadataReady: Promise<void>;
  metadataClosed: Promise<void>;
  handshakeReady: Promise<void>;
  handshakeClosed: Promise<void>;
  connectReady: Promise<void>;
  beforeRespond: ((call: WireCall) => void) | null;
  releaseConnect(): void;
  close(): Promise<void>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

async function outcomeWithin<T>(promise: Promise<T>, timeoutMs = 400): Promise<
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "stuck" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "resolved" as const, value }),
        (error) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "stuck" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "stuck" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startMockCdp(options: {
  holdConnect?: boolean;
  holdMetadata?: boolean;
  holdMetadataBody?: boolean;
  holdHandshake?: boolean;
} = {}): Promise<MockCdp> {
  const port = await freePort();
  const calls: WireCall[] = [];
  const sockets = new Set<WebSocket>();
  const heldUpgradeSockets = new Set<{ destroy(): void }>();
  const heldMetadataResponses = new Set<http.ServerResponse>();
  const heldResponses: Array<() => void> = [];
  let connectCount = 0;
  let wsConnectionCount = 0;
  let resolveMetadataReady!: () => void;
  let resolveMetadataClosed!: () => void;
  let resolveHandshakeReady!: () => void;
  let resolveHandshakeClosed!: () => void;
  let resolveConnectReady!: () => void;
  const metadataReady = new Promise<void>((resolve) => { resolveMetadataReady = resolve; });
  const metadataClosed = new Promise<void>((resolve) => { resolveMetadataClosed = resolve; });
  const handshakeReady = new Promise<void>((resolve) => { resolveHandshakeReady = resolve; });
  const handshakeClosed = new Promise<void>((resolve) => { resolveHandshakeClosed = resolve; });
  const connectReady = new Promise<void>((resolve) => { resolveConnectReady = resolve; });

  const server = http.createServer((req, res) => {
    if (req.url === "/json") {
      const holdResponseOpen = () => {
        heldMetadataResponses.add(res);
        res.once("close", () => {
          heldMetadataResponses.delete(res);
          resolveMetadataClosed();
        });
      };
      if (options.holdMetadata) {
        holdResponseOpen();
        resolveMetadataReady();
        return;
      }
      if (options.holdMetadataBody) {
        holdResponseOpen();
        res.writeHead(200, { "content-type": "application/json" });
        res.write("[");
        res.flushHeaders();
        resolveMetadataReady();
        return;
      }
      resolveMetadataReady();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ type: "page", id: "page-1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1` }]));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/devtools/page/page-1") {
      socket.destroy();
      return;
    }
    resolveHandshakeReady();
    if (options.holdHandshake) {
      heldUpgradeSockets.add(socket);
      socket.once("end", resolveHandshakeClosed);
      socket.once("close", () => {
        heldUpgradeSockets.delete(socket);
        resolveHandshakeClosed();
      });
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
  const mock: MockCdp = {
    port,
    calls,
    get connectionCount() { return wsConnectionCount; },
    metadataReady,
    metadataClosed,
    handshakeReady,
    handshakeClosed,
    connectReady,
    beforeRespond: null,
    releaseConnect() {
      for (const respond of heldResponses.splice(0)) respond();
    },
    async close() {
      for (const response of heldMetadataResponses) response.destroy();
      for (const socket of heldUpgradeSockets) socket.destroy();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  wss.on("connection", (ws) => {
    wsConnectionCount += 1;
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, any> };
      const call = { method: message.method, params: message.params };
      calls.push(call);
      const respond = () => {
        mock.beforeRespond?.(call);
        if (ws.readyState !== ws.OPEN) return;
        const result = message.method === "Runtime.evaluate"
          ? { result: { value: message.params?.expression === "document.title" ? "Mock title" : 1 } }
          : {};
        ws.send(JSON.stringify({ id: message.id, result }));
      };
      if (CONNECT_METHODS.has(message.method)) {
        connectCount += 1;
        if (connectCount === CONNECT_METHODS.size) resolveConnectReady();
        if (options.holdConnect) heldResponses.push(respond);
        else respond();
        return;
      }
      respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return mock;
}

function entry(port: number, overrides: Partial<RunningEntry> = {}): RunningEntry {
  return { pid: process.pid, process: null, port, lastActivityAt: Date.now(), ...overrides };
}

function registerProfile(dirId: string, name: string, port: number): RunningEntry {
  const runtime = entry(port);
  runningProcesses.set(dirId, runtime);
  mocks.profiles.push({ dirId, name, running: true, cdpPort: port, fingerprintSeed: port, engine: "chromium" });
  mocks.diskProfiles.push({ dirId, name, running: true, proxy: null });
  return runtime;
}

function fakeCdpClient(port: number): { client: CdpClient; sent: WireCall[] } {
  const sent: WireCall[] = [];
  let client: CdpClient;
  const ws = Object.assign(new EventEmitter(), {
    send(raw: string) {
      const message = JSON.parse(raw) as { id: number; method: string; params?: Record<string, any> };
      sent.push({ method: message.method, params: message.params });
      queueMicrotask(() => {
        const callback = client.callbacks.get(message.id);
        if (!callback) return;
        client.callbacks.delete(message.id);
        clearTimeout(callback.timer);
        callback.resolve({});
      });
    },
  });
  client = {
    ws,
    port,
    targetId: "fake-target",
    msgId: 0,
    callbacks: new Map(),
    pendingMessages: [],
    interactionSeed: 1,
    interactionCounter: 0,
    pointerX: null,
    pointerY: null,
  };
  return { client, sent };
}

const servers: MockCdp[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  runningProcesses.clear();
  mocks.profiles = [];
  mocks.diskProfiles = [];
  mocks.accounts = [];
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("M1 local-agent message metadata wrapper", () => {
  it("writes metadata, verifies the file, and returns the committed readback", () => {
    const dataDir = process.env.M1_AGENT_TEST_DATA || `/tmp/m1-agent-scope-test-${process.pid}`;
    const historyPath = path.join(dataDir, "agent-conversations.json");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.rmSync(historyPath, { force: true });
    fs.rmSync(historyPath + ".tmp", { force: true });
    try {
      const conversation = createConversation("New Chat");
      const stored = addMessage(conversation.id, "user", "linked task", undefined, {
        runId: "run_scope_message",
        requestId: "request_scope_message",
        endReason: "completed",
        verification: { status: "unverified" },
      });
      expect(stored).not.toBeNull();
      expect(stored!.conv.messages.at(-1)).toMatchObject({
        role: "user",
        runId: "run_scope_message",
        requestId: "request_scope_message",
        endReason: "completed",
        verification: { status: "unverified" },
      });

      const onDisk = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      expect(onDisk[0].messages.some((message: any) => message.runId === "run_scope_message")).toBe(true);
      const readBack = getConversation(conversation.id);
      expect(readBack?.messages.find((message) => message.requestId === "request_scope_message"))
        .toEqual(stored!.conv.messages.at(-1));
    } finally {
      fs.rmSync(historyPath, { force: true });
      fs.rmSync(historyPath + ".tmp", { force: true });
    }
  });
});

describe("M1 chat browser scope predicates", () => {
  it("uses null only for an explicit no-browser selection and freezes captured identity", () => {
    expect(captureChatBrowserScope()).toBeNull();
    expect(captureChatBrowserScope("")).toBeNull();
    const runtime = registerProfile("profile-a", "A", 41001);
    const scope = captureChatBrowserScope("profile-a")!;
    expect(scope).toEqual({ dirId: "profile-a", port: 41001, pid: runtime.pid });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(() => { (scope as any).port = 41002; }).toThrow();
  });

  it("rejects missing, stopping, dead, invalid-port, and ambiguous runtime entries", () => {
    expect(() => captureChatBrowserScope("missing")).toThrow(/not running/);

    runningProcesses.set("stopping", entry(41002, { stopping: true }));
    expect(() => captureChatBrowserScope("stopping")).toThrow(/stopping/);

    runningProcesses.set("dead", entry(41003, { pid: 2_147_483_647 }));
    expect(() => captureChatBrowserScope("dead")).toThrow(/not live/);

    runningProcesses.set("invalid", entry(0));
    expect(() => captureChatBrowserScope("invalid")).toThrow(/debug port/);

    runningProcesses.set("duplicate-a", entry(41004));
    runningProcesses.set("duplicate-b", entry(41004));
    expect(() => captureChatBrowserScope("duplicate-a")).toThrow(/ambiguous/);
  });

  it("filters after skill additions with an explicit allowlist and fail-closes unknown tools", () => {
    registerProfile("profile-a", "A", 41005);
    const scope = captureChatBrowserScope("profile-a")!;
    const futureTool = { type: "function" as const, function: { name: "future_global_mutator", parameters: {} } };
    const tools = [...AGENT_TOOLS, futureTool];

    const selectedNames = filterChatTools(tools, scope).map((tool) => tool.function.name);
    expect(selectedNames).toContain("browser_navigate");
    expect(selectedNames).toContain("list_profiles");
    expect(selectedNames).toContain("list_accounts");
    expect(selectedNames).toContain("http_request");
    expect(selectedNames).toContain("list_automation_rules");
    expect(selectedNames).not.toContain("browser_evaluate");
    expect(selectedNames).not.toContain("launch_profile");
    expect(selectedNames).not.toContain("create_automation_rule");
    expect(selectedNames).not.toContain("delete_automation_rule");
    expect(selectedNames).not.toContain("future_global_mutator");

    const noBrowserNames = filterChatTools(tools, null).map((tool) => tool.function.name);
    expect(noBrowserNames.some((name) => name.startsWith("browser_"))).toBe(false);
    expect(noBrowserNames).toEqual(expect.arrayContaining(["list_profiles", "list_accounts", "http_request", "db_query"]));
    expect(filterChatTools(tools, undefined)).toBe(tools);
    expect(() => filterChatTools(tools, { dirId: "profile-a", port: 41005, pid: process.pid })).toThrow(/forged/);
  });

  it("invalidates a scope when its exact entry is stopping, replaced, or changed", () => {
    const runtime = registerProfile("profile-a", "A", 41006);
    const scope = captureChatBrowserScope("profile-a")!;
    assertChatBrowserScopePort(scope, 41006);
    expect(() => assertChatBrowserScopePort(scope, 51006)).toThrow(/outside/);

    runtime.stopping = true;
    expect(() => assertChatBrowserScopePort(scope, 41006)).toThrow(/stopping/);
    delete runtime.stopping;

    runningProcesses.set("profile-a", entry(41006));
    expect(() => assertChatBrowserScopePort(scope, 41006)).toThrow(/replaced/);
  });
});

describe("M1 scoped tool catalog and backend enforcement", () => {
  it("limits profile/account catalogs to the selected environment and returns empty for null", async () => {
    registerProfile("profile-a", "A", 42001);
    registerProfile("profile-b", "B", 42002);
    mocks.accounts = [
      { platformUrl: "https://shared.example", platformUserName: "shared" },
      { platformUrl: "https://a.example", platformUserName: "alice", profileIds: ["profile-a"] },
      { platformUrl: "https://b.example", platformUserName: "bob", profileIds: ["profile-b"] },
    ];
    const scope = captureChatBrowserScope("profile-a")!;

    const profiles = await executeToolCall("list_profiles", {}, undefined, { browserScope: scope });
    expect(profiles.profiles.map((profile: any) => profile.dirId)).toEqual(["profile-a"]);
    const accounts = await executeToolCall("list_accounts", {}, undefined, { browserScope: scope });
    expect(accounts.accounts.map((account: any) => account.username)).toEqual(["shared", "alice"]);
    expect(await executeToolCall("list_profiles", {}, undefined, { browserScope: null })).toEqual({ profiles: [] });
    expect(await executeToolCall("list_accounts", {}, undefined, { browserScope: null })).toEqual({ accounts: [] });
  });

  it("enforces disabled and unclassified tools even without allowedToolNames", async () => {
    registerProfile("profile-a", "A", 42003);
    const scope = captureChatBrowserScope("profile-a")!;
    for (const [name, args] of [
      ["browser_evaluate", { port: scope.port, expression: "1" }],
      ["launch_profile", { dirId: "profile-a" }],
      ["create_automation_rule", {}],
      ["delete_automation_rule", { ruleId: "x" }],
      ["future_global_mutator", {}],
    ] as const) {
      await expect(executeToolCall(name, args, undefined, { browserScope: scope })).rejects.toThrow(/unavailable|unclassified/);
    }
    await expect(executeToolCall("browser_get_title", { port: scope.port }, undefined, { browserScope: null })).rejects.toThrow(/selected browser/);
  });

  it("keeps Firefox session hooks testable without letting them redirect scope", async () => {
    const runtime = registerProfile("profile-a", "A", 42007);
    const selectedSession = {
      wsUrl: "ws://127.0.0.1:42007/session",
      closed: false,
      close: vi.fn(),
      send: vi.fn(async (method: string) => {
        if (method === "browsingContext.getTree") return { contexts: [{ context: "ctx-a" }] };
        if (method === "script.evaluate") return { result: { type: "string", value: "Selected title" } };
        return {};
      }),
    };
    runtime.bidiConn = selectedSession as any;
    const scope = captureChatBrowserScope("profile-a")!;
    const redirectedSession = { ...selectedSession, send: vi.fn(selectedSession.send) };

    await expect(executeToolCall("browser_get_title", { port: scope.port }, undefined, {
      browserScope: scope,
      engineResolver: () => "firefox" as const,
      sessionResolver: () => redirectedSession as any,
    })).rejects.toThrow(/does not belong/);
    expect(redirectedSession.send).not.toHaveBeenCalled();

    await expect(executeToolCall("browser_get_title", { port: scope.port }, undefined, {
      browserScope: scope,
      engineResolver: () => "firefox" as const,
      sessionResolver: () => selectedSession as any,
    })).resolves.toEqual({ title: "Selected title" });
  });

  it("advertises only the pinned profile and filtered tools to agentChat", async () => {
    registerProfile("profile-a", "A", 42004);
    registerProfile("profile-b", "B", 42005);
    const scope = captureChatBrowserScope("profile-a")!;
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await agentChat(
      { provider: "openai", apiKey: "test-key", apiUrl: "https://llm.invalid/v1", model: "test-model" },
      [{ role: "user", content: "hello" }],
      { browserScope: scope },
    );
    const selectedRequest = requests[0];
    const selectedTools = selectedRequest.tools.map((tool: any) => tool.function.name);
    expect(selectedTools).toContain("browser_navigate");
    expect(selectedTools).not.toContain("browser_evaluate");
    expect(selectedTools).not.toContain("launch_profile");
    expect(selectedRequest.messages[0].content).toContain(`port ${scope.port}`);
    expect(selectedRequest.messages[0].content).not.toContain(`port 42005`);
    expect(selectedRequest.messages[0].content).toContain("MANDATORY DESKTOP CHAT SCOPE");

    await agentChat(
      { provider: "openai", apiKey: "test-key", apiUrl: "https://llm.invalid/v1", model: "test-model" },
      [{ role: "user", content: "hello without browser" }],
      { browserScope: null },
    );
    const noBrowserRequest = requests[1];
    const noBrowserTools = noBrowserRequest.tools.map((tool: any) => tool.function.name);
    expect(noBrowserTools.some((name: string) => name.startsWith("browser_"))).toBe(false);
    expect(noBrowserTools).toEqual(expect.arrayContaining(["list_profiles", "list_accounts", "http_request", "db_query"]));
    expect(noBrowserRequest.messages[0].content).toContain("No browser environment is selected");
  });

  it("builds an explicit scope override after template and skill catalogs", () => {
    registerProfile("profile-a", "A", 42006);
    const scope = captureChatBrowserScope("profile-a")!;
    const prompt = buildAgentSystemPrompt([{ name: "A", dirId: "profile-a", cdpPort: scope.port }], scope);
    expect(prompt).toContain(`Every browser tool call must use port ${scope.port}`);
    expect(prompt).toContain("cannot grant another or nested executor");
  });
});

describe("M1 CDP dispatch boundary", () => {
  it("does not let a chat pinned to A execute against B or a live unowned high port", async () => {
    const a = await startMockCdp();
    const b = await startMockCdp();
    const unowned = await startMockCdp();
    servers.push(a, b, unowned);
    registerProfile("profile-a", "A", a.port);
    registerProfile("profile-b", "B", b.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const context = { browserScope: scope, engineResolver: () => "chromium" as const };

    await expect(executeToolCall(
      "browser_navigate",
      { port: b.port, url: "https://93.184.216.34/" },
      undefined,
      context,
    )).rejects.toThrow(/outside|scope/);
    await expect(executeToolCall("browser_get_title", { port: unowned.port }, undefined, context)).rejects.toThrow(/outside|scope/);
    expect(b.calls).toHaveLength(0);
    expect(unowned.calls).toHaveLength(0);

    await expect(executeToolCall("browser_get_title", { port: a.port }, undefined, context)).resolves.toEqual({ title: "Mock title" });
    expect(a.calls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "document.title")).toBe(true);
  });

  it("cancels a new connection while the real metadata response is held", async () => {
    const a = await startMockCdp({ holdMetadata: true });
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const controller = new AbortController();
    const pending = executeToolCall("browser_get_title", { port: a.port }, undefined, {
      browserScope: scope,
      signal: controller.signal,
      engineResolver: () => "chromium" as const,
    });

    await a.metadataReady;
    controller.abort();
    const outcome = await outcomeWithin(pending);
    if (outcome.status !== "rejected") {
      throw new Error(`metadata preparation did not cancel promptly: ${outcome.status}`);
    }
    expect(String(outcome.error)).toMatch(/abort|cancel/i);
    expect((await outcomeWithin(a.metadataClosed)).status).toBe("resolved");
    expect(a.connectionCount).toBe(0);
    expect(a.calls).toHaveLength(0);
  });

  it("cancels metadata JSON body consumption and closes the held response", async () => {
    const a = await startMockCdp({ holdMetadataBody: true });
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const controller = new AbortController();
    const pending = executeToolCall("browser_get_title", { port: a.port }, undefined, {
      browserScope: scope,
      signal: controller.signal,
      engineResolver: () => "chromium" as const,
    });

    await a.metadataReady;
    controller.abort();
    const outcome = await outcomeWithin(pending);
    if (outcome.status !== "rejected") {
      throw new Error(`metadata body consumption did not cancel promptly: ${outcome.status}`);
    }
    expect(String(outcome.error)).toMatch(/abort|cancel/i);
    expect((await outcomeWithin(a.metadataClosed)).status).toBe("resolved");
    expect(a.connectionCount).toBe(0);
    expect(a.calls).toHaveLength(0);
  });

  it("cancels and closes only a new socket whose websocket handshake is held", async () => {
    const a = await startMockCdp({ holdHandshake: true });
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const controller = new AbortController();
    const pending = executeToolCall("browser_get_title", { port: a.port }, undefined, {
      browserScope: scope,
      signal: controller.signal,
      engineResolver: () => "chromium" as const,
    });

    await a.handshakeReady;
    controller.abort();
    const outcome = await outcomeWithin(pending);
    if (outcome.status !== "rejected") {
      throw new Error(`websocket preparation did not cancel promptly: ${outcome.status}`);
    }
    expect(String(outcome.error)).toMatch(/abort|cancel/i);
    expect((await outcomeWithin(a.handshakeClosed)).status).toBe("resolved");
    expect(a.connectionCount).toBe(0);
    expect(a.calls).toHaveLength(0);
  });

  it("blocks the requested command after cancellation while connect setup is pending", async () => {
    const a = await startMockCdp({ holdConnect: true });
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const controller = new AbortController();
    const pending = executeToolCall("browser_get_title", { port: a.port }, undefined, {
      browserScope: scope,
      signal: controller.signal,
      engineResolver: () => "chromium" as const,
    });
    const rejection = expect(pending).rejects.toThrow(/abort|cancel/i);

    await a.connectReady;
    controller.abort();
    a.releaseConnect();

    await rejection;
    expect(a.calls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "document.title")).toBe(false);
  });

  it("blocks the requested command when the selected instance is replaced during connect", async () => {
    const a = await startMockCdp({ holdConnect: true });
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const pending = executeToolCall("browser_get_title", { port: a.port }, undefined, {
      browserScope: scope,
      engineResolver: () => "chromium" as const,
    });
    const rejection = expect(pending).rejects.toThrow(/replaced|instance/i);

    await a.connectReady;
    runningProcesses.set("profile-a", entry(a.port));
    a.releaseConnect();

    await rejection;
    expect(a.calls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "document.title")).toBe(false);
  });

  it("keeps each load-event wait bound to the guard that started it", async () => {
    const loadEvent = Buffer.from(JSON.stringify({ method: "Page.loadEventFired", params: {} }));

    const { client: healthyB } = fakeCdpClient(42010);
    const waitForHealthyB = runWithProtocolDispatchGuard(() => {}, () => cdpWaitForLoad(healthyB, 1000));
    runWithProtocolDispatchGuard(() => {
      throw new Error("run A aborted");
    }, () => healthyB.ws.emit("message", loadEvent));
    await expect(waitForHealthyB).resolves.toBeUndefined();

    const { client: abortedB } = fakeCdpClient(42011);
    let bAborted = false;
    const waitForAbortedB = runWithProtocolDispatchGuard(() => {
      if (bAborted) throw new Error("run B aborted");
    }, () => cdpWaitForLoad(abortedB, 1000));
    bAborted = true;
    runWithProtocolDispatchGuard(() => {}, () => abortedB.ws.emit("message", loadEvent));
    await expect(waitForAbortedB).rejects.toThrow(/run B aborted/);
  });

  it("interrupts a cancellable load-event wait without closing the shared client", async () => {
    const a = await startMockCdp();
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const baseContext = { browserScope: scope, engineResolver: () => "chromium" as const };
    await executeToolCall("browser_get_title", { port: a.port }, undefined, baseContext);
    expect(a.connectionCount).toBe(1);

    let sawProbe!: () => void;
    const probeSeen = new Promise<void>((resolve) => { sawProbe = resolve; });
    a.beforeRespond = (call) => {
      if (call.method === "Runtime.evaluate" && call.params?.expression === "1") sawProbe();
    };
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = executeToolCall("browser_wait_for_load", { port: a.port, timeout: 30000 }, undefined, {
      ...baseContext,
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toThrow(/abort|cancel/i);
    await probeSeen;
    // Let the probe response hand the cached client to cdpWaitForLoad; that
    // wait itself has no wire command we could otherwise synchronize on.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await rejection;
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(a.connectionCount).toBe(1);

    a.beforeRespond = null;
    await expect(executeToolCall("browser_get_title", { port: a.port }, undefined, baseContext)).resolves.toEqual({ title: "Mock title" });
    expect(a.connectionCount).toBe(1);
  });

  it("interrupts local interaction delays and dispatches no later key stages", async () => {
    const a = await startMockCdp();
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const controller = new AbortController();
    a.beforeRespond = (call) => {
      if (call.method === "Input.dispatchKeyEvent" && call.params?.type === "rawKeyDown") controller.abort();
    };
    const startedAt = Date.now();
    await expect(executeToolCall("browser_press_key", { port: a.port, key: "Enter", delayMs: 5000 }, undefined, {
      browserScope: scope,
      signal: controller.signal,
      engineResolver: () => "chromium" as const,
    })).rejects.toThrow(/abort|cancel/i);

    expect(Date.now() - startedAt).toBeLessThan(500);
    const keyStages = a.calls
      .filter((call) => call.method === "Input.dispatchKeyEvent")
      .map((call) => call.params?.type);
    expect(keyStages).toEqual(["rawKeyDown"]);
  });

  it("re-checks cancellation between a cached-client probe and the requested command", async () => {
    const a = await startMockCdp();
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const scope = captureChatBrowserScope("profile-a")!;
    const baseContext = { browserScope: scope, engineResolver: () => "chromium" as const };
    await executeToolCall("browser_get_title", { port: a.port }, undefined, baseContext);

    const controller = new AbortController();
    const callStart = a.calls.length;
    a.beforeRespond = (call) => {
      if (call.method === "Runtime.evaluate" && call.params?.expression === "1") controller.abort();
    };
    await expect(executeToolCall("browser_get_title", { port: a.port }, undefined, {
      ...baseContext,
      signal: controller.signal,
    })).rejects.toThrow(/abort|cancel/i);

    const laterCalls = a.calls.slice(callStart);
    expect(laterCalls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "1")).toBe(true);
    expect(laterCalls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "document.title")).toBe(false);

    a.beforeRespond = null;
    await expect(executeToolCall("browser_get_title", { port: a.port }, undefined, baseContext))
      .resolves.toEqual({ title: "Mock title" });
    expect(a.connectionCount).toBe(1);
  });

  it("does not hand a cached websocket to a restarted instance reusing the same port", async () => {
    const a = await startMockCdp();
    servers.push(a);
    registerProfile("profile-a", "A", a.port);
    const firstScope = captureChatBrowserScope("profile-a")!;
    await executeToolCall("browser_get_title", { port: a.port }, undefined, {
      browserScope: firstScope,
      engineResolver: () => "chromium" as const,
    });
    expect(a.connectionCount).toBe(1);

    runningProcesses.set("profile-a", entry(a.port));
    const restartedScope = captureChatBrowserScope("profile-a")!;
    const callStart = a.calls.length;
    await executeToolCall("browser_get_title", { port: a.port }, undefined, {
      browserScope: restartedScope,
      engineResolver: () => "chromium" as const,
    });

    expect(a.connectionCount).toBe(2);
    const laterCalls = a.calls.slice(callStart);
    expect(laterCalls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "1")).toBe(false);
    expect(laterCalls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "document.title")).toBe(true);
  });

  it("leaves no callback/timer state when the final leaf guard rejects", async () => {
    const { client, sent } = fakeCdpClient(43001);
    let checks = 0;
    const pending = runWithProtocolDispatchGuard(() => {
      checks += 1;
      if (checks === 2) throw new Error("dispatch cancelled");
    }, () => cdpSendRaw(client, "Page.navigate", { url: "https://example.com" }));

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(client.callbacks.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("removes collection listeners when a guarded local wait is cancelled", async () => {
    const { client } = fakeCdpClient(43004);
    let allowed = true;
    const pending = runWithProtocolDispatchGuard(() => {
      if (!allowed) throw new Error("collection cancelled");
    }, () => cdpGetRequests(client));

    expect(client.ws.listenerCount("message")).toBe(1);
    allowed = false;
    await expect(pending).rejects.toThrow(/collection cancelled/);
    expect(client.ws.listenerCount("message")).toBe(0);
    expect(client.callbacks.size).toBe(0);
  });

  it("keeps independent concurrent dispatch guards isolated", async () => {
    registerProfile("profile-a", "A", 43002);
    registerProfile("profile-b", "B", 43003);
    const scopeA = captureChatBrowserScope("profile-a")!;
    const scopeB = captureChatBrowserScope("profile-b")!;
    const { client: clientB, sent } = fakeCdpClient(43003);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const guardFor = (scope: ChatBrowserScope) => (port: number) => assertChatBrowserScopePort(scope, port);

    const wrong = runWithProtocolDispatchGuard(guardFor(scopeA), async () => {
      await gate;
      return cdpSendRaw(clientB, "Runtime.evaluate", { expression: "wrong" });
    });
    const right = runWithProtocolDispatchGuard(guardFor(scopeB), async () => {
      await gate;
      return cdpSendRaw(clientB, "Runtime.evaluate", { expression: "right" });
    });
    release();

    await expect(wrong).rejects.toThrow(/outside|scope/);
    await expect(right).resolves.toEqual({});
    expect(sent.map((call) => call.params?.expression)).toEqual(["right"]);
  });

  it("preserves unscoped legacy access to a reachable high loopback port", async () => {
    const legacy = await startMockCdp();
    servers.push(legacy);
    await expect(executeToolCall("browser_get_title", { port: legacy.port }, undefined, {
      engineResolver: () => "chromium" as const,
    })).resolves.toEqual({ title: "Mock title" });
    expect(legacy.calls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "document.title")).toBe(true);
  });
});
